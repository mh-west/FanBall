-- Friend room: the host can set the pitch-by-pitch pace (user request 2026-11-16). Vote windows
-- (VOTE_SECONDS etc.) are not affected — only how fast the server plays pitches, results and the
-- gaps between them. Official games always stay at the default (fans must all see the same pace).

alter table public.fanball_games add column if not exists speed_ms integer not null default 2000
  check (speed_ms in (2000, 1000, 400));

-- Re-expose speed_ms to the orchestrator tick (get_orchestrator_game, migration 202611100003).
create or replace function public.get_orchestrator_game(p_game_id uuid)
returns jsonb language sql security definer set search_path=public stable as $$
  select jsonb_build_object(
    'game_id', f.id, 'status', f.status, 'away_team_id', k.away_team_id, 'home_team_id', k.home_team_id,
    'lineup_snapshot', f.lineup_snapshot, 'seed', p.seed, 'engine_state', p.engine_state, 'model_version', f.model_version,
    'speed_ms', f.speed_ms,
    'next_action', p.next_action, 'next_action_at', p.next_action_at,
    'current_round_id', p.current_round_id, 'state_version', p.state_version,
    'round', (select jsonb_build_object('status', r.status, 'closes_at', r.closes_at, 'phase', r.phase, 'pa_no', r.pa_no) from public.tactical_rounds r where r.id = p.current_round_id),
    'resolution', (select jsonb_build_object(
        'offense', (select c.choice_key from public.tactical_choices c where c.id = res.offense_choice_id),
        'defense', (select c.choice_key from public.tactical_choices c where c.id = res.defense_choice_id),
        'fallback_roles', res.fallback_roles)
      from public.tactical_resolutions res where res.round_id = p.current_round_id))
  from public.fanball_games f
  join public.kbo_games k on k.id = f.kbo_game_id
  join public.fanball_game_private p on p.game_id = f.id
  where f.id = p_game_id;
$$;
revoke all on function public.get_orchestrator_game(uuid) from public, anon, authenticated;
grant execute on function public.get_orchestrator_game(uuid) to service_role;

-- Only the room's host may change the pace, and only for their own room's game.
create or replace function public.set_room_speed(p_game_id uuid, p_speed_ms integer)
returns void language plpgsql security definer set search_path=public as $$
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if p_speed_ms not in (2000, 1000, 400) then raise exception 'invalid speed'; end if;
  if not exists (select 1 from public.friend_rooms r where r.game_id = p_game_id and r.host = auth.uid()) then
    raise exception 'only the host can change speed';
  end if;
  update public.fanball_games set speed_ms = p_speed_ms where id = p_game_id;
end $$;
revoke all on function public.set_room_speed(uuid, integer) from public, anon;
grant execute on function public.set_room_speed(uuid, integer) to authenticated;
