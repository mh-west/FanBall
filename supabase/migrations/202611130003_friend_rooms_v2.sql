-- Friend rooms, second version (2026-11-13, user decisions):
--   * Making a room only makes a code: no teams, starters or lineups yet.
--   * Each of the two picks their team, starter and lineup on the lineup screen; the other sees only whether
--     it is done, never what it is, until the game starts.
--   * The host starts the game.
-- So no game row exists until the start (kbo_games and fanball_games are readable by everyone, which would show
-- the teams early). start_friend_room builds the game from the two saved setups and starts it at once.
-- Rooms of the first version that have not started are cancelled.

alter table public.friend_rooms alter column game_id drop not null;
alter table public.friend_rooms alter column kbo_game_id drop not null;
alter table public.friend_rooms add column if not exists host_setup jsonb;
alter table public.friend_rooms add column if not exists guest_setup jsonb;

-- First-version rooms that never started: cancel them (their game rows showed the teams).
update public.fanball_games f set status = 'cancelled', ended_at = now()
  from public.friend_rooms r where r.game_id = f.id and f.status = 'scheduled';
update public.kbo_games k set status = 'cancelled'
  from public.friend_rooms r join public.fanball_games f on f.id = r.game_id where k.id = r.kbo_game_id and f.status = 'cancelled';
update public.friend_rooms r set host_hidden = true, guest_hidden = true, expires_at = least(expires_at, now())
  from public.fanball_games f where f.id = r.game_id and f.status = 'cancelled';

drop function if exists public.create_friend_room(text, text, text, jsonb);
drop function if exists public.set_friend_room_ready(uuid, boolean);

-- A setup must be a usable team: squad, starter, 9 batters in order, each of the 9 positions once.
create or replace function public.valid_room_setup(s jsonb) returns boolean language plpgsql immutable as $$
declare n int; names text[]; pos text[];
begin
  if s is null or coalesce(s->>'team', '') = '' then return false; end if;
  if jsonb_typeof(s->'players') <> 'array' or jsonb_array_length(s->'players') < 9 then return false; end if;
  if s->'pitcher' is null or jsonb_typeof(s->'order') <> 'array' or jsonb_array_length(s->'order') <> 9 then return false; end if;
  n := jsonb_array_length(s->'players');
  if exists (select 1 from jsonb_array_elements(s->'order') x where jsonb_typeof(x) <> 'number' or (x::text)::int < 0 or (x::text)::int >= n) then return false; end if;
  if (select count(distinct x::text) from jsonb_array_elements(s->'order') x) <> 9 then return false; end if;
  select array_agg(s->'players'->((x::text)::int)->>0) into names from jsonb_array_elements(s->'order') x;
  select array_agg(s->'positions'->>nm order by s->'positions'->>nm) into pos from unnest(names) nm;
  return pos = array['1B','2B','3B','C','CF','DH','LF','RF','SS'];
end $$;

-- What one of the two sees: their own setup, and of the other only whether it is done.
create or replace function public.friend_room_view(r public.friend_rooms)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare me text := case when auth.uid() = r.host then 'host' else 'guest' end; my_side text; mine jsonb; theirs jsonb;
  st text; away_id text; home_id text;
begin
  my_side := case when me = 'host' then r.host_side else (case r.host_side when 'away' then 'home' else 'away' end) end;
  mine := case when me = 'host' then r.host_setup else r.guest_setup end;
  theirs := case when me = 'host' then r.guest_setup else r.host_setup end;
  if r.game_id is not null then
    select g.status, k.away_team_id, k.home_team_id into st, away_id, home_id from public.fanball_games g join public.kbo_games k on k.id = g.kbo_game_id where g.id = r.game_id;
  end if;
  return jsonb_build_object('code', r.code, 'me', me, 'host_side', r.host_side, 'my_side', my_side,
    'has_guest', r.guest is not null, 'expires_at', r.expires_at,
    'my_setup', case when mine is null then null else jsonb_build_object('team', mine->>'team', 'pitcher', mine->'pitcher'->>0,
      'order', mine->'order', 'positions', mine->'positions') end,
    'my_ready', mine is not null, 'other_ready', theirs is not null,
    'status', coalesce(st, case when r.expires_at > now() then 'waiting' else 'expired' end),
    'game_id', r.game_id, 'kbo_game_id', r.kbo_game_id,
    'away_team_id', away_id, 'home_team_id', home_id,
    'my_key', case when away_id is null then null else public.fanball_side_key(away_id, home_id, my_side) end);
end $$;
revoke all on function public.friend_room_view(public.friend_rooms) from public, anon, authenticated;

create or replace function public.create_friend_room(p_my_side text default 'home')
returns jsonb language plpgsql security definer set search_path=public as $$
declare new_code text; tries int := 0; r public.friend_rooms;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if coalesce(p_my_side, 'home') not in ('away', 'home') then raise exception 'side must be away or home'; end if;
  if (select count(*) from public.friend_rooms fr left join public.fanball_games fg on fg.id = fr.game_id
      where fr.host = auth.uid() and not fr.host_hidden
        and ((fr.game_id is null and fr.expires_at > now()) or fg.status in ('scheduled', 'running'))) >= 3 then
    raise exception 'you already have 3 open rooms';
  end if;
  loop
    tries := tries + 1;
    new_code := lpad(floor(random() * 100000000)::bigint::text, 8, '0');
    begin
      insert into public.friend_rooms(code, host, host_side) values (new_code, auth.uid(), coalesce(p_my_side, 'home')) returning * into r;
      exit;
    exception when unique_violation then
      if tries > 20 then raise exception 'could not make a room code'; end if;
    end;
  end loop;
  return public.friend_room_view(r);
end $$;

-- Room by code for one of its two people (locked for update).
create or replace function public.room_for_member(p_code text) returns public.friend_rooms language plpgsql security definer set search_path=public as $$
declare r public.friend_rooms;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  select * into r from public.friend_rooms where code = btrim(coalesce(p_code, '')) for update;
  if not found or auth.uid() not in (r.host, coalesce(r.guest, r.host)) then raise exception 'room not found'; end if;
  return r;
end $$;
revoke all on function public.room_for_member(text) from public, anon, authenticated;

create or replace function public.join_friend_room(p_code text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.friend_rooms;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if (select count(*) from public.room_join_attempts where user_id = auth.uid() and at > now() - interval '1 minute') >= 10 then
    raise exception 'too many tries';
  end if;
  insert into public.room_join_attempts(user_id) values (auth.uid());
  delete from public.room_join_attempts where at < now() - interval '1 day';
  -- Wrong, expired, started or full rooms answer {"error"} instead of raising, so the try above is kept.
  select * into r from public.friend_rooms where code = btrim(coalesce(p_code, '')) for update;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  if r.host = auth.uid() or r.guest = auth.uid() then return public.friend_room_view(r); end if;
  if r.game_id is not null or r.expires_at < now() or r.host_hidden then return jsonb_build_object('error', 'not_found'); end if;
  if r.guest is not null then return jsonb_build_object('error', 'full'); end if;
  update public.friend_rooms set guest = auth.uid() where code = r.code returning * into r;
  return public.friend_room_view(r);
end $$;

create or replace function public.set_friend_room_side(p_code text, p_host_side text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.friend_rooms := public.room_for_member(p_code);
begin
  if auth.uid() <> r.host then raise exception 'only the host picks the sides'; end if;
  if r.game_id is not null then raise exception 'the game has started'; end if;
  if p_host_side not in ('away', 'home') then raise exception 'side must be away or home'; end if;
  update public.friend_rooms set host_side = p_host_side where code = r.code returning * into r;
  return public.friend_room_view(r);
end $$;

-- Save (or clear, with null) my team, starter and lineup for the room. Hidden from the other person.
create or replace function public.set_friend_room_setup(p_code text, p_setup jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.friend_rooms := public.room_for_member(p_code);
begin
  if r.game_id is not null then raise exception 'the game has started'; end if;
  if r.expires_at < now() then raise exception 'room expired'; end if;
  if p_setup is not null and not public.valid_room_setup(p_setup) then raise exception 'lineup needs 9 batters and each position once'; end if;
  if p_setup is not null and length(p_setup::text) > 200000 then raise exception 'setup too large'; end if;
  if auth.uid() = r.host then update public.friend_rooms set host_setup = p_setup where code = r.code returning * into r;
  else update public.friend_rooms set guest_setup = p_setup where code = r.code returning * into r; end if;
  return public.friend_room_view(r);
end $$;

-- The host starts: the game is built from both setups and starts on the next tick.
create or replace function public.start_friend_room(p_code text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.friend_rooms := public.room_for_member(p_code); away_s jsonb; home_s jsonb; away_id text; home_id text; kbo_id text; gid uuid;
  team_of jsonb;
begin
  if auth.uid() <> r.host then raise exception 'only the host starts the game'; end if;
  if r.game_id is not null then return public.friend_room_view(r); end if;
  if r.guest is null then raise exception 'your friend has not joined'; end if;
  if r.host_setup is null or r.guest_setup is null then raise exception 'both lineups are needed'; end if;
  if r.expires_at < now() then raise exception 'room expired'; end if;
  away_s := case r.host_side when 'away' then r.host_setup else r.guest_setup end;
  home_s := case r.host_side when 'home' then r.host_setup else r.guest_setup end;
  away_id := away_s->>'team'; home_id := home_s->>'team';
  kbo_id := format('room-%s-%s-%s', away_id, home_id, substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  insert into public.kbo_games(id, game_date, scheduled_at, away_team_id, home_team_id, status, provider)
  values (kbo_id, (now() at time zone 'Asia/Seoul')::date, now(), away_id, home_id, 'scheduled', 'room');
  insert into public.fanball_games(kbo_game_id, lineup_snapshot)
  values (kbo_id, jsonb_build_object('source', 'friend-room', 'teams', jsonb_build_object(
    public.fanball_side_key(away_id, home_id, 'away'), (away_s - 'team') || jsonb_build_object('lineupSource', 'friend_room'),
    home_id, (home_s - 'team') || jsonb_build_object('lineupSource', 'friend_room'))))
  returning id into gid;
  update public.friend_rooms set game_id = gid, kbo_game_id = kbo_id where code = r.code returning * into r;
  insert into public.fanball_game_memberships(game_id, user_id, team_id) values
    (gid, r.host, public.fanball_side_key(away_id, home_id, r.host_side)),
    (gid, r.guest, public.fanball_side_key(away_id, home_id, case r.host_side when 'away' then 'home' else 'away' end))
  on conflict (game_id, user_id) do update set team_id = excluded.team_id;
  return public.friend_room_view(r);
end $$;

-- Delete / leave by code, in any state (as delete_friend_room, plus rooms with no game yet).
create or replace function public.delete_friend_room_code(p_code text)
returns void language plpgsql security definer set search_path=public as $$
declare r public.friend_rooms := public.room_for_member(p_code);
begin
  if r.game_id is not null then perform public.delete_friend_room(r.game_id); return; end if;
  if auth.uid() = r.guest then
    update public.friend_rooms set guest = null, guest_setup = null where code = r.code;
  else
    update public.friend_rooms set host_hidden = true, guest_hidden = true, expires_at = least(expires_at, now()) where code = r.code;
  end if;
end $$;

create or replace function public.my_friend_rooms()
returns jsonb language sql stable security definer set search_path=public as $$
  select coalesce(jsonb_agg(public.friend_room_view(r) order by r.created_at desc), '[]'::jsonb)
  from public.friend_rooms r left join public.fanball_games f on f.id = r.game_id
  where ((auth.uid() = r.host and not r.host_hidden) or (auth.uid() = r.guest and not r.guest_hidden))
    and ((r.game_id is null and r.expires_at > now()) or f.status = 'running' or (f.status = 'final' and f.ended_at > now() - interval '1 day'));
$$;

revoke all on function public.valid_room_setup(jsonb) from public, anon, authenticated;
revoke all on function public.create_friend_room(text) from public, anon;
grant execute on function public.create_friend_room(text) to authenticated;
revoke all on function public.set_friend_room_side(text, text) from public, anon;
grant execute on function public.set_friend_room_side(text, text) to authenticated;
revoke all on function public.set_friend_room_setup(text, jsonb) from public, anon;
grant execute on function public.set_friend_room_setup(text, jsonb) to authenticated;
revoke all on function public.start_friend_room(text) from public, anon;
grant execute on function public.start_friend_room(text) to authenticated;
revoke all on function public.delete_friend_room_code(text) from public, anon;
grant execute on function public.delete_friend_room_code(text) to authenticated;
