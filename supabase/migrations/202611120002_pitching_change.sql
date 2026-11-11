-- Fans' pitching changes in live games (2026-11-12, user request).
-- Fans of the fielding side press "투수 교체 요청" for the pitcher now on the mound. When at least 80% of
-- that side's participants have asked, the orchestrator opens a 'pitcher_change' round in which that
-- side votes for the reliever; he takes over from the next plate appearance (engine 2.8).
-- A request is for one pitcher: it lapses by itself when that pitcher leaves the game.

alter table public.tactical_rounds drop constraint if exists tactical_rounds_phase_check;
alter table public.tactical_rounds add constraint tactical_rounds_phase_check
  check (phase in ('pre_pa', 'two_strikes', 'three_balls', 'pitcher_change'));

create table if not exists public.pitching_change_requests (
  game_id uuid not null references public.fanball_games(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  side_key text not null,
  pitcher text not null,
  created_at timestamptz not null default now(),
  primary key (game_id, user_id)
);
alter table public.pitching_change_requests enable row level security;
revoke all on public.pitching_change_requests from public, anon, authenticated;
grant all on public.pitching_change_requests to service_role;

-- Ask for (or take back) a change of the given pitcher, on the side the fan joined.
create or replace function public.request_pitching_change(p_game_id uuid, p_pitcher text, p_on boolean default true)
returns jsonb language plpgsql security definer set search_path=public as $$
declare m public.fanball_game_memberships;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if not exists (select 1 from public.fanball_games where id = p_game_id and status = 'running') then raise exception 'game is not running'; end if;
  select * into m from public.fanball_game_memberships where game_id = p_game_id and user_id = auth.uid();
  if not found or m.team_id is null then raise exception 'join this game before asking'; end if;
  if p_on then
    if coalesce(btrim(p_pitcher), '') = '' then raise exception 'which pitcher'; end if;
    insert into public.pitching_change_requests(game_id, user_id, side_key, pitcher) values (p_game_id, auth.uid(), m.team_id, left(p_pitcher, 40))
    on conflict (game_id, user_id) do update set side_key = excluded.side_key, pitcher = excluded.pitcher, created_at = now();
  else
    delete from public.pitching_change_requests where game_id = p_game_id and user_id = auth.uid();
  end if;
  return public.pitching_change_status(p_game_id);
end $$;

-- Counts only (no user ids): per side, participants and requests for each pitcher; and whether I asked.
create or replace function public.pitching_change_status(p_game_id uuid)
returns jsonb language sql security definer set search_path=public stable as $$
  select jsonb_build_object(
    'sides', coalesce((select jsonb_object_agg(team_id, n) from (select team_id, count(*) n from public.fanball_game_memberships where game_id = p_game_id and team_id is not null group by team_id) x), '{}'::jsonb),
    'requests', coalesce((select jsonb_agg(jsonb_build_object('side', side_key, 'pitcher', pitcher, 'n', n)) from (select side_key, pitcher, count(*) n from public.pitching_change_requests where game_id = p_game_id group by side_key, pitcher) y), '[]'::jsonb),
    'mine', (select pitcher from public.pitching_change_requests where game_id = p_game_id and user_id = auth.uid()),
    'threshold', 0.8);
$$;

-- The orchestrator clears a side's requests once the vote for a reliever has opened.
create or replace function public.clear_pitching_change_requests(p_game_id uuid, p_side_key text)
returns void language sql security definer set search_path=public as $$
  delete from public.pitching_change_requests where game_id = p_game_id and side_key = p_side_key;
$$;

revoke all on function public.request_pitching_change(uuid, text, boolean) from public, anon;
grant execute on function public.request_pitching_change(uuid, text, boolean) to authenticated;
revoke all on function public.pitching_change_status(uuid) from public;
grant execute on function public.pitching_change_status(uuid) to anon, authenticated, service_role;
revoke all on function public.clear_pitching_change_requests(uuid, text) from public, anon, authenticated;
grant execute on function public.clear_pitching_change_requests(uuid, text) to service_role;
