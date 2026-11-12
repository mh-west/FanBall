-- Quick votes in friend rooms (2026-11-13, user request): once everyone who votes in a round has picked, the
-- round closes 2 seconds after the last pick instead of waiting for the full 10 seconds.
-- Who votes: the fielding side always; the batting side too, except in a reliever vote (pitcher_change),
-- where only the fielding side chooses. Live games with many fans keep the full time.
-- The orchestrator's loop wakes at least every second (orchestrator.js runLoop), so an earlier resolve time
-- is picked up.

create or replace function public.room_quick_close() returns trigger language plpgsql security definer set search_path=public as $$
declare r record; needed int; voted int; closes timestamptz;
begin
  select t.id, t.game_id, t.phase, t.status, t.offense_team_id, t.defense_team_id into r from public.tactical_rounds t where t.id = NEW.round_id;
  if not found or r.status <> 'open' then return NEW; end if;
  if not exists (select 1 from public.friend_rooms where game_id = r.game_id) then return NEW; end if;
  select count(*) into needed from public.fanball_game_memberships m
    where m.game_id = r.game_id and (m.team_id = r.defense_team_id or (r.phase <> 'pitcher_change' and m.team_id = r.offense_team_id));
  select count(distinct v.user_id) into voted from public.tactical_votes v
    join public.fanball_game_memberships m on m.game_id = r.game_id and m.user_id = v.user_id
    where v.round_id = r.id and (m.team_id = r.defense_team_id or (r.phase <> 'pitcher_change' and m.team_id = r.offense_team_id));
  if needed = 0 or voted < needed then return NEW; end if;
  update public.tactical_rounds set closes_at = greatest(opens_at + interval '1 millisecond', least(closes_at, clock_timestamp() + interval '2 seconds'))
    where id = r.id and status = 'open' returning closes_at into closes;
  update public.fanball_game_private set next_action_at = least(next_action_at, closes + interval '200 milliseconds')
    where game_id = r.game_id and next_action = 'resolve_round';
  return NEW;
end $$;
revoke all on function public.room_quick_close() from public, anon, authenticated;

drop trigger if exists room_quick_close on public.tactical_votes;
create trigger room_quick_close after insert or update on public.tactical_votes for each row execute function public.room_quick_close();
