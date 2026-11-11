-- "관리자 경기 즉시 시작" for a booked test game (2026-11-11, user request): move its start time to now,
-- so the orchestrator (pg_cron, every second) starts it right away with the fans' lineups so far.
-- Only admin test games (provider 'demo') that have not started.
create or replace function public.admin_start_fanball_game_now(p_game_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare g record;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  select f.status, f.kbo_game_id, k.provider into g from public.fanball_games f join public.kbo_games k on k.id = f.kbo_game_id where f.id = p_game_id for update of f;
  if not found then raise exception 'game not found'; end if;
  if g.provider <> 'demo' then raise exception 'official games start on schedule'; end if;
  if g.status <> 'scheduled' then raise exception 'only a game that has not started can be started now'; end if;
  update public.kbo_games set scheduled_at = now(), game_date = (now() at time zone 'Asia/Seoul')::date, updated_at = now() where id = g.kbo_game_id;
end $$;
revoke all on function public.admin_start_fanball_game_now(uuid) from public, anon;
grant execute on function public.admin_start_fanball_game_now(uuid) to authenticated, service_role;
