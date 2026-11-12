-- Friend rooms (2026-11-12, user request): a signed-in fan opens a private 1-on-1 game and gets an 8-digit
-- code; a friend enters the code to join the other side. The game is an ordinary server game (kbo_games
-- provider 'room' + fanball_games), run by the same orchestrator, so lineups, tactic votes and pitching
-- changes work as in live games, each side with one fan. Only the two people in the room may join, submit
-- a lineup, vote or ask for a pitching change (triggers below). The code is the only key (user decision):
-- 10^8 codes, at most 10 tries a minute per account, and a room expires 24 hours after it was opened
-- unless the game has started. The game starts when both have pressed ready.

-- A team may play itself in a room, as in admin event matches.
alter table public.kbo_games drop constraint if exists kbo_games_teams_check;
alter table public.kbo_games add constraint kbo_games_teams_check check (away_team_id <> home_team_id or provider in ('demo', 'room'));

create table if not exists public.friend_rooms (
  code text primary key check (code ~ '^[0-9]{8}$'),
  game_id uuid not null unique references public.fanball_games(id) on delete cascade,
  kbo_game_id text not null,
  host uuid not null references auth.users(id) on delete cascade,
  guest uuid references auth.users(id) on delete set null,
  host_side text not null check (host_side in ('away', 'home')),
  host_ready boolean not null default false,
  guest_ready boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',
  check (guest is null or guest <> host)
);
alter table public.friend_rooms enable row level security;
revoke all on public.friend_rooms from public, anon, authenticated;
grant all on public.friend_rooms to service_role;

create table if not exists public.room_join_attempts (
  user_id uuid not null references auth.users(id) on delete cascade,
  at timestamptz not null default now()
);
create index if not exists room_join_attempts_user_at on public.room_join_attempts(user_id, at);
alter table public.room_join_attempts enable row level security;
revoke all on public.room_join_attempts from public, anon, authenticated;
grant all on public.room_join_attempts to service_role;

-- True when the game is a friend room and the user is not one of its two people.
create or replace function public.room_outsider(p_game_id uuid, p_user uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists (select 1 from public.friend_rooms r where r.game_id = p_game_id and p_user is distinct from r.host and p_user is distinct from r.guest);
$$;
revoke all on function public.room_outsider(uuid, uuid) from public, anon, authenticated;

create or replace function public.room_guard() returns trigger language plpgsql security definer set search_path=public as $$
declare gid uuid;
begin
  if TG_TABLE_NAME = 'tactical_votes' then select game_id into gid from public.tactical_rounds where id = NEW.round_id;
  else gid := NEW.game_id; end if;
  if public.room_outsider(gid, NEW.user_id) then raise exception 'this is a private room'; end if;
  return NEW;
end $$;
revoke all on function public.room_guard() from public, anon, authenticated;

drop trigger if exists room_guard on public.fanball_game_memberships;
create trigger room_guard before insert or update on public.fanball_game_memberships for each row execute function public.room_guard();
drop trigger if exists room_guard on public.lineup_submissions;
create trigger room_guard before insert or update on public.lineup_submissions for each row execute function public.room_guard();
drop trigger if exists room_guard on public.tactical_votes;
create trigger room_guard before insert or update on public.tactical_votes for each row execute function public.room_guard();
drop trigger if exists room_guard on public.pitching_change_requests;
create trigger room_guard before insert or update on public.pitching_change_requests for each row execute function public.room_guard();

-- What a room looks like to one of its two people.
create or replace function public.friend_room_view(r public.friend_rooms)
returns jsonb language sql stable security definer set search_path=public as $$
  select jsonb_build_object('code', r.code, 'game_id', r.game_id, 'kbo_game_id', r.kbo_game_id,
    'me', case when auth.uid() = r.host then 'host' else 'guest' end,
    'host_side', r.host_side, 'my_side', case when auth.uid() = r.host then r.host_side else (case r.host_side when 'away' then 'home' else 'away' end) end,
    'has_guest', r.guest is not null, 'host_ready', r.host_ready, 'guest_ready', r.guest_ready,
    'away_team_id', k.away_team_id, 'home_team_id', k.home_team_id, 'scheduled_at', k.scheduled_at,
    'status', f.status, 'expires_at', r.expires_at,
    'my_key', public.fanball_side_key(k.away_team_id, k.home_team_id, case when auth.uid() = r.host then r.host_side else (case r.host_side when 'away' then 'home' else 'away' end) end))
  from public.fanball_games f join public.kbo_games k on k.id = f.kbo_game_id where f.id = r.game_id;
$$;
revoke all on function public.friend_room_view(public.friend_rooms) from public, anon, authenticated;

create or replace function public.create_friend_room(p_my_team text, p_their_team text, p_my_side text, p_lineup_snapshot jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare away_id text; home_id text; kbo_id text; new_game uuid; new_code text; tries int := 0; side text; r public.friend_rooms;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if p_my_side not in ('away', 'home') then raise exception 'side must be away or home'; end if;
  if p_my_team is null or p_their_team is null then raise exception 'pick two teams'; end if;
  if (select count(*) from public.friend_rooms fr join public.fanball_games fg on fg.id = fr.game_id
      where fr.host = auth.uid() and fg.status in ('scheduled', 'running') and (fg.status = 'running' or fr.expires_at > now())) >= 3 then
    raise exception 'you already have 3 open rooms';
  end if;
  away_id := case p_my_side when 'away' then p_my_team else p_their_team end;
  home_id := case p_my_side when 'home' then p_my_team else p_their_team end;
  foreach side in array array[away_id, home_id] loop
    if jsonb_typeof(p_lineup_snapshot->'teams'->side->'players') <> 'array'
       or jsonb_array_length(p_lineup_snapshot->'teams'->side->'players') < 9
       or jsonb_typeof(p_lineup_snapshot->'teams'->side->'order') <> 'array'
       or jsonb_array_length(p_lineup_snapshot->'teams'->side->'order') <> 9
       or p_lineup_snapshot->'teams'->side->'pitcher' is null then
      raise exception 'lineup snapshot is missing team %', side;
    end if;
  end loop;
  -- Not started until both are ready: the start time is set then (start_due_fanball_games picks it up).
  kbo_id := format('room-%s-%s-%s', away_id, home_id, substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  insert into public.kbo_games(id, game_date, scheduled_at, away_team_id, home_team_id, status, provider)
  values (kbo_id, (now() at time zone 'Asia/Seoul')::date, now() + interval '2 days', away_id, home_id, 'scheduled', 'room');
  insert into public.fanball_games(kbo_game_id, lineup_snapshot)
  values (kbo_id, jsonb_build_object('source', 'friend-room', 'teams', jsonb_build_object(
    public.fanball_side_key(away_id, home_id, 'away'), p_lineup_snapshot->'teams'->away_id,
    home_id, p_lineup_snapshot->'teams'->home_id)))
  returning id into new_game;
  loop
    tries := tries + 1;
    new_code := lpad(floor(random() * 100000000)::bigint::text, 8, '0');
    begin
      insert into public.friend_rooms(code, game_id, kbo_game_id, host, host_side) values (new_code, new_game, kbo_id, auth.uid(), p_my_side)
      returning * into r;
      exit;
    exception when unique_violation then
      if tries > 20 then raise exception 'could not make a room code'; end if;
    end;
  end loop;
  insert into public.fanball_game_memberships(game_id, user_id, team_id)
  values (new_game, auth.uid(), public.fanball_side_key(away_id, home_id, p_my_side))
  on conflict (game_id, user_id) do update set team_id = excluded.team_id;
  return public.friend_room_view(r);
end $$;

create or replace function public.join_friend_room(p_code text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.friend_rooms; f record; guest_side text;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if (select count(*) from public.room_join_attempts where user_id = auth.uid() and at > now() - interval '1 minute') >= 10 then
    raise exception 'too many tries';
  end if;
  insert into public.room_join_attempts(user_id) values (auth.uid());
  delete from public.room_join_attempts where at < now() - interval '1 day';
  -- A wrong, expired or full room is answered with {"error": ...}, not an exception, so the attempt above is
  -- kept (an exception would roll it back and the try limit would never count).
  select * into r from public.friend_rooms where code = btrim(coalesce(p_code, '')) for update;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  select g.status, k.away_team_id, k.home_team_id into f from public.fanball_games g join public.kbo_games k on k.id = g.kbo_game_id where g.id = r.game_id;
  if r.host = auth.uid() or r.guest = auth.uid() then return public.friend_room_view(r); end if;
  if f.status <> 'scheduled' or r.expires_at < now() then return jsonb_build_object('error', 'not_found'); end if;
  if r.guest is not null then return jsonb_build_object('error', 'full'); end if;
  guest_side := case r.host_side when 'away' then 'home' else 'away' end;
  update public.friend_rooms set guest = auth.uid() where code = r.code returning * into r;
  insert into public.fanball_game_memberships(game_id, user_id, team_id)
  values (r.game_id, auth.uid(), public.fanball_side_key(f.away_team_id, f.home_team_id, guest_side))
  on conflict (game_id, user_id) do update set team_id = excluded.team_id;
  return public.friend_room_view(r);
end $$;

-- My rooms that are still open or playing (newest first), and finished ones from the last day.
create or replace function public.my_friend_rooms()
returns jsonb language sql stable security definer set search_path=public as $$
  select coalesce(jsonb_agg(public.friend_room_view(r) order by r.created_at desc), '[]'::jsonb)
  from public.friend_rooms r join public.fanball_games f on f.id = r.game_id
  where auth.uid() in (r.host, r.guest)
    and (f.status = 'running' or (f.status = 'scheduled' and r.expires_at > now()) or (f.status = 'final' and f.ended_at > now() - interval '1 day'));
$$;

create or replace function public.set_friend_room_ready(p_game_id uuid, p_ready boolean default true)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.friend_rooms; st text;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  select * into r from public.friend_rooms where game_id = p_game_id for update;
  if not found or auth.uid() not in (r.host, coalesce(r.guest, r.host)) then raise exception 'room not found'; end if;
  select status into st from public.fanball_games where id = p_game_id;
  if st <> 'scheduled' then return public.friend_room_view(r); end if;
  if r.expires_at < now() then raise exception 'room expired'; end if;
  if auth.uid() = r.host then update public.friend_rooms set host_ready = p_ready where code = r.code returning * into r;
  else update public.friend_rooms set guest_ready = p_ready where code = r.code returning * into r; end if;
  -- Both ready: start now (the orchestrator's tick starts due games every second).
  if r.guest is not null and r.host_ready and r.guest_ready then
    update public.kbo_games set scheduled_at = now() where id = r.kbo_game_id;
  end if;
  return public.friend_room_view(r);
end $$;

-- The host closes a room that has not started; the guest leaves one.
create or replace function public.leave_friend_room(p_game_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare r public.friend_rooms; st text;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  select * into r from public.friend_rooms where game_id = p_game_id for update;
  if not found or auth.uid() not in (r.host, coalesce(r.guest, r.host)) then raise exception 'room not found'; end if;
  select status into st from public.fanball_games where id = p_game_id;
  if st <> 'scheduled' then raise exception 'the game has started'; end if;
  if auth.uid() = r.host then
    update public.fanball_games set status = 'cancelled' where id = p_game_id;
    update public.kbo_games set status = 'cancelled' where id = r.kbo_game_id;
    update public.friend_rooms set expires_at = now() where code = r.code;
  else
    delete from public.fanball_game_memberships where game_id = p_game_id and user_id = auth.uid();
    delete from public.lineup_submissions where game_id = p_game_id and user_id = auth.uid();
    update public.friend_rooms set guest = null, guest_ready = false, host_ready = false where code = r.code;
  end if;
end $$;

revoke all on function public.create_friend_room(text, text, text, jsonb) from public, anon;
grant execute on function public.create_friend_room(text, text, text, jsonb) to authenticated;
revoke all on function public.join_friend_room(text) from public, anon;
grant execute on function public.join_friend_room(text) to authenticated;
revoke all on function public.my_friend_rooms() from public, anon;
grant execute on function public.my_friend_rooms() to authenticated;
revoke all on function public.set_friend_room_ready(uuid, boolean) from public, anon;
grant execute on function public.set_friend_room_ready(uuid, boolean) to authenticated;
revoke all on function public.leave_friend_room(uuid) from public, anon;
grant execute on function public.leave_friend_room(uuid) to authenticated;
