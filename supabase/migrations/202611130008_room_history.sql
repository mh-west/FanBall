-- Past friend-room games (2026-11-13, user request: finished games pile up, so list them apart).
-- my_friend_rooms keeps rooms that are waiting or running, and games that ended in the last 30 minutes;
-- my_room_history lists every finished room game I played in or watched, newest first, a page at a time.

create or replace function public.my_friend_rooms()
returns jsonb language sql stable security definer set search_path=public as $$
  select coalesce(jsonb_agg(public.friend_room_view(r) order by r.created_at desc), '[]'::jsonb)
  from public.room_members m join public.friend_rooms r on r.code = m.code left join public.fanball_games f on f.id = r.game_id
  where m.user_id = auth.uid() and not m.hidden and not (r.host_hidden and r.game_id is null)
    and ((r.game_id is null and r.expires_at > now()) or f.status = 'running' or (f.status = 'final' and f.ended_at > now() - interval '30 minutes'));
$$;

create or replace function public.my_room_history(p_limit int default 10, p_offset int default 0)
returns jsonb language sql stable security definer set search_path=public as $$
  with mine as (
    select r.code, r.kbo_game_id, f.ended_at, f.score, k.away_team_id, k.home_team_id, k.game_date, m.side,
           (f.ended_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date as today
    from public.room_members m join public.friend_rooms r on r.code = m.code
      join public.fanball_games f on f.id = r.game_id join public.kbo_games k on k.id = r.kbo_game_id
    where m.user_id = auth.uid() and f.status = 'final'
  )
  select jsonb_build_object(
    'total', (select count(*) from mine),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'code', code, 'kbo_game_id', kbo_game_id, 'ended_at', ended_at, 'today', today,
        'away_team_id', away_team_id, 'home_team_id', home_team_id,
        'away', coalesce((score->>'away')::int, 0), 'home', coalesce((score->>'home')::int, 0),
        'my_side', side,
        'result', case when side not in ('away', 'home') then null
                       when coalesce((score->>'away')::int, 0) = coalesce((score->>'home')::int, 0) then 'draw'
                       when (side = 'away') = (coalesce((score->>'away')::int, 0) > coalesce((score->>'home')::int, 0)) then 'win'
                       else 'loss' end) order by ended_at desc)
      from (select * from mine order by ended_at desc limit greatest(1, least(coalesce(p_limit, 10), 50)) offset greatest(0, coalesce(p_offset, 0))) page), '[]'::jsonb));
$$;
revoke all on function public.my_room_history(int, int) from public, anon;
grant execute on function public.my_room_history(int, int) to authenticated;
