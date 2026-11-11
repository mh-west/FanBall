-- Home "라인업 참여" card (2026-11-11): how many fan lineups were submitted for today's games (KST).
-- Only the total is exposed; who submitted what stays private (lineup_submissions is read-own only).
create or replace function public.fanball_lineup_participation_today()
returns integer language sql security definer set search_path=public stable as $$
  select count(*)::int
    from public.lineup_submissions s
    join public.fanball_games f on f.id = s.game_id
    join public.kbo_games k on k.id = f.kbo_game_id
   where (k.scheduled_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date;
$$;
revoke all on function public.fanball_lineup_participation_today() from public;
grant execute on function public.fanball_lineup_participation_today() to anon, authenticated, service_role;
