-- Deleting friend rooms (2026-11-13, user report: a room could not be removed to make a new one).
-- delete_friend_room works in every state:
--   before the game: the host deletes the room (the game is cancelled, the code stops working); the guest
--     leaves it (the seat opens again);
--   during the game: either of the two stops it (the game is cancelled) and the room goes away;
--   after the game: it is taken off that person's list.
-- Cancelled rooms and rooms someone took off their list no longer show in my_friend_rooms nor count toward
-- the 3 open rooms.

-- A running room game may be stopped (running -> cancelled), as admin test games can.
create or replace function public.guard_fanball_game_status()
returns trigger language plpgsql set search_path=public as $$
begin
  if new.status is distinct from old.status and not (
    (old.status = 'scheduled' and new.status in ('running','cancelled')) or
    (old.status = 'running' and new.status = 'final') or
    (old.status = 'running' and new.status = 'cancelled'
      and exists (select 1 from public.kbo_games k where k.id = new.kbo_game_id and k.provider in ('demo', 'room')))
  ) then
    raise exception 'fanball game status cannot change from % to %', old.status, new.status;
  end if;
  if old.status in ('running','final') and (new.lineup_snapshot is distinct from old.lineup_snapshot or new.seed_hash is distinct from old.seed_hash) then
    raise exception 'lineup and seed are fixed once a game starts';
  end if;
  if old.revealed_seed is not null and new.revealed_seed is distinct from old.revealed_seed then
    raise exception 'revealed seed cannot change';
  end if;
  return new;
end $$;

alter table public.friend_rooms add column if not exists host_hidden boolean not null default false;
alter table public.friend_rooms add column if not exists guest_hidden boolean not null default false;

create or replace function public.delete_friend_room(p_game_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare r public.friend_rooms; st text;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  select * into r from public.friend_rooms where game_id = p_game_id for update;
  if not found or auth.uid() not in (r.host, coalesce(r.guest, r.host)) then raise exception 'room not found'; end if;
  select status into st from public.fanball_games where id = p_game_id;
  if st = 'scheduled' and auth.uid() = r.guest then
    delete from public.fanball_game_memberships where game_id = p_game_id and user_id = auth.uid();
    delete from public.lineup_submissions where game_id = p_game_id and user_id = auth.uid();
    update public.friend_rooms set guest = null, guest_ready = false, host_ready = false where code = r.code;
    return;
  end if;
  if st in ('scheduled', 'running') then
    update public.fanball_games set status = 'cancelled', ended_at = now() where id = p_game_id;
    update public.fanball_game_private set next_action = null, next_action_at = null, state_version = state_version + 1, updated_at = now() where game_id = p_game_id;
    update public.tactical_rounds set status = 'cancelled' where game_id = p_game_id and status in ('open', 'closing');
    update public.kbo_games set status = 'cancelled' where id = r.kbo_game_id;
    update public.friend_rooms set expires_at = least(expires_at, now()) where code = r.code;
  end if;
  if auth.uid() = r.host then update public.friend_rooms set host_hidden = true where code = r.code;
  else update public.friend_rooms set guest_hidden = true where code = r.code; end if;
end $$;
revoke all on function public.delete_friend_room(uuid) from public, anon;
grant execute on function public.delete_friend_room(uuid) to authenticated;

create or replace function public.my_friend_rooms()
returns jsonb language sql stable security definer set search_path=public as $$
  select coalesce(jsonb_agg(public.friend_room_view(r) order by r.created_at desc), '[]'::jsonb)
  from public.friend_rooms r join public.fanball_games f on f.id = r.game_id
  where ((auth.uid() = r.host and not r.host_hidden) or (auth.uid() = r.guest and not r.guest_hidden))
    and (f.status = 'running' or (f.status = 'scheduled' and r.expires_at > now()) or (f.status = 'final' and f.ended_at > now() - interval '1 day'));
$$;

-- The old close/leave function now does the same as delete before the game.
create or replace function public.leave_friend_room(p_game_id uuid)
returns void language sql security definer set search_path=public as $$ select public.delete_friend_room(p_game_id); $$;
