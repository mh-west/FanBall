-- Lineup vote tally (2026-11-11, user request): before a game starts, anyone can see the representative
-- lineup each side would get right now (same rule as at the start: most-named player per batting slot,
-- then the most-voted position), with the number of submissions. Only these totals are exposed; who
-- submitted what stays private. Event matches report the away side under '<team>@away'.
create or replace function public.fanball_lineup_tally(p_game_id uuid)
returns jsonb language plpgsql security definer set search_path=public stable as $$
declare g record; away_key text; out jsonb := '{}'::jsonb;
begin
  select f.status, k.away_team_id, k.home_team_id into g from public.fanball_games f join public.kbo_games k on k.id = f.kbo_game_id where f.id = p_game_id;
  if not found then raise exception 'game not found'; end if;
  away_key := public.fanball_side_key(g.away_team_id, g.home_team_id, 'away');
  out := jsonb_build_object(
    away_key, coalesce(public.representative_lineup(p_game_id, away_key), jsonb_build_object('submissions', 0)),
    g.home_team_id, coalesce(public.representative_lineup(p_game_id, g.home_team_id), jsonb_build_object('submissions', 0)),
    'status', g.status);
  return out;
end $$;
revoke all on function public.fanball_lineup_tally(uuid) from public;
grant execute on function public.fanball_lineup_tally(uuid) to anon, authenticated, service_role;
