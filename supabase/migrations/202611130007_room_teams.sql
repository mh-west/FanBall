-- Team rooms and spectators (2026-11-13, user decisions):
--   * Any number of people per side (away / home). Each player saves a team, starter, lineup and plans; at the
--     start each side plays what its players voted for: the most picked team, then among setups with that team
--     the most picked starter and, slot by slot, the most picked batter with his most picked free position
--     (the same rule as representative_lineup for public games; ties go to the earliest saved).
--   * Spectators join with the code ('watch'): they see the game and can chat, but never vote or see setups.
--   * The host starts the game once both sides have at least one saved setup. Players may also join a side
--     after the start (they vote from then on). Only the host can stop a started game; others leave.
-- friend_rooms.guest / guest_setup / guest_ready stay for old rows but are no longer used.

create table if not exists public.room_members (
  code text not null references public.friend_rooms(code) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  side text not null check (side in ('away', 'home', 'watch')),
  setup jsonb,
  setup_at timestamptz,
  hidden boolean not null default false,
  joined_at timestamptz not null default now(),
  primary key (code, user_id)
);
create index if not exists room_members_user on public.room_members(user_id);
alter table public.room_members enable row level security;
revoke all on public.room_members from public, anon, authenticated;
grant all on public.room_members to service_role;

-- Existing rooms: their host and guest become members.
insert into public.room_members(code, user_id, side, setup, setup_at, hidden, joined_at)
select code, host, host_side, host_setup, case when host_setup is null then null else created_at end, host_hidden, created_at from public.friend_rooms
on conflict do nothing;
insert into public.room_members(code, user_id, side, setup, setup_at, hidden, joined_at)
select code, guest, case host_side when 'away' then 'home' else 'away' end, guest_setup, case when guest_setup is null then null else created_at end, guest_hidden, created_at
from public.friend_rooms where guest is not null
on conflict do nothing;

-- Outsiders of a room game cannot join it, vote or ask for changes; only its players (not spectators) can.
create or replace function public.room_outsider(p_game_id uuid, p_user uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists (select 1 from public.friend_rooms r where r.game_id = p_game_id)
     and not exists (select 1 from public.friend_rooms r join public.room_members m on m.code = r.code
                     where r.game_id = p_game_id and m.user_id = p_user and m.side in ('away', 'home'));
$$;
revoke all on function public.room_outsider(uuid, uuid) from public, anon, authenticated;

-- One side's combined setup from its players' saved setups (null when nobody saved).
create or replace function public.room_side_setup(p_code text, p_side text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare t text; sp text; base jsonb; chosen text[] := '{}'; pick text; slot int; positions jsonb := '{}'; taken text[] := '{}';
  nm text; pos text; order_idx jsonb := '[]'; po text; pd text; n int;
begin
  select m.setup->>'team' into t from public.room_members m where m.code = p_code and m.side = p_side and m.setup is not null
    group by 1 order by count(*) desc, min(m.setup_at) asc limit 1;
  if t is null then return null; end if;
  create temp table if not exists _room_side(setup jsonb, at timestamptz) on commit drop;
  delete from _room_side;
  insert into _room_side select m.setup, m.setup_at from public.room_members m where m.code = p_code and m.side = p_side and m.setup->>'team' = t;
  select count(*) into n from _room_side;
  select s.setup->'pitcher'->>0 into sp from _room_side s group by 1 order by count(*) desc, min(s.at) asc limit 1;
  -- Squad, starter and bullpen from the earliest setup with that starter (the bullpen depends on the starter).
  select s.setup into base from _room_side s where s.setup->'pitcher'->>0 = sp order by s.at asc limit 1;
  -- Batting order: slot by slot the most picked batter not already chosen.
  for slot in 0..8 loop
    select s.setup->'players'->((s.setup->'order'->>slot)::int)->>0 into pick from _room_side s
      where not (s.setup->'players'->((s.setup->'order'->>slot)::int)->>0 = any(chosen))
      group by 1 order by count(*) desc, min(s.at) asc limit 1;
    if pick is null then
      -- Everyone's pick for this slot is already chosen: take the next batter from the base setup.
      select x->>0 into pick from jsonb_array_elements(base->'order') o, lateral (select base->'players'->((o::text)::int) x) y
        where not (x->>0 = any(chosen)) limit 1;
    end if;
    chosen := chosen || pick;
  end loop;
  -- Positions: strongest (player, position) pairs first; a catcher spot only for a catcher (squad group 'C').
  for nm, pos in
    select e.key, e.value #>> '{}' from _room_side s, jsonb_each(s.setup->'positions') e
    where e.key = any(chosen) group by 1, 2 order by count(*) desc, min(s.at) asc
  loop
    if positions ? nm or pos = any(taken) then continue; end if;
    if pos = 'C' and coalesce((select p->>1 from jsonb_array_elements(base->'players') p where p->>0 = nm limit 1), '') <> 'C' then continue; end if;
    positions := positions || jsonb_build_object(nm, pos); taken := taken || pos;
  end loop;
  foreach nm in array chosen loop
    if not positions ? nm then
      select x into pos from unnest(array['DH','1B','LF','RF','3B','2B','CF','SS','C']) x where not (x = any(taken)) limit 1;
      positions := positions || jsonb_build_object(nm, pos); taken := taken || pos;
    end if;
    order_idx := order_idx || to_jsonb((select (ord - 1)::int from jsonb_array_elements(base->'players') with ordinality p(v, ord) where v->>0 = nm limit 1));
  end loop;
  select s.setup->'plan'->>'offense' into po from _room_side s where s.setup->'plan'->>'offense' is not null group by 1 order by count(*) desc, min(s.at) asc limit 1;
  select s.setup->'plan'->>'defense' into pd from _room_side s where s.setup->'plan'->>'defense' is not null group by 1 order by count(*) desc, min(s.at) asc limit 1;
  return (base - 'order' - 'positions' - 'plan') || jsonb_build_object('order', order_idx, 'positions', positions,
    'plan', jsonb_build_object('offense', coalesce(po, 'normal'), 'defense', coalesce(pd, 'normal')), 'votes', n);
end $$;
revoke all on function public.room_side_setup(text, text) from public, anon, authenticated;

-- What a member sees: their own setup; of their own side how many saved and which teams they picked; of the
-- other side only how many joined and saved. Spectators see the counts only.
create or replace function public.friend_room_view(r public.friend_rooms)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare m public.room_members; st text; away_id text; home_id text; other text; sides jsonb; my_teams jsonb;
begin
  select * into m from public.room_members where code = r.code and user_id = auth.uid();
  if r.game_id is not null then
    select g.status, k.away_team_id, k.home_team_id into st, away_id, home_id from public.fanball_games g join public.kbo_games k on k.id = g.kbo_game_id where g.id = r.game_id;
  end if;
  other := case m.side when 'away' then 'home' when 'home' then 'away' else null end;
  select jsonb_object_agg(s, jsonb_build_object('players', coalesce(p, 0), 'ready', coalesce(rd, 0))) into sides from (
    select s, (select count(*) from public.room_members x where x.code = r.code and x.side = s) p,
              (select count(*) from public.room_members x where x.code = r.code and x.side = s and x.setup is not null) rd
    from unnest(array['away', 'home', 'watch']) s) q;
  if m.side in ('away', 'home') then
    select coalesce(jsonb_object_agg(t, n), '{}'::jsonb) into my_teams from (
      select x.setup->>'team' t, count(*) n from public.room_members x where x.code = r.code and x.side = m.side and x.setup is not null group by 1) q;
  end if;
  return jsonb_build_object('code', r.code,
    'me', case when auth.uid() = r.host then 'host' when m.side = 'watch' then 'watch' else 'player' end,
    'role', case when m.side = 'watch' then 'watch' else 'player' end,
    'host_side', r.host_side, 'my_side', case when m.side = 'watch' then null else m.side end,
    'sides', sides, 'watchers', (sides->'watch'->>'players')::int, 'my_side_teams', my_teams,
    'has_guest', coalesce((sides->coalesce(other, 'away')->>'players')::int, 0) > 0 or (m.side = 'watch'),
    'expires_at', r.expires_at,
    'my_setup', case when m.setup is null then null else jsonb_build_object('team', m.setup->>'team', 'pitcher', m.setup->'pitcher'->>0,
      'order', m.setup->'order', 'positions', m.setup->'positions', 'plan', m.setup->'plan') end,
    'my_ready', m.setup is not null,
    'other_ready', coalesce((sides->coalesce(other, 'away')->>'ready')::int, 0) > 0,
    'status', coalesce(st, case when r.expires_at > now() then 'waiting' else 'expired' end),
    'game_id', r.game_id, 'kbo_game_id', r.kbo_game_id,
    'away_team_id', away_id, 'home_team_id', home_id,
    'my_key', case when away_id is null or m.side not in ('away', 'home') then null else public.fanball_side_key(away_id, home_id, m.side) end);
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
  insert into public.room_members(code, user_id, side) values (r.code, auth.uid(), r.host_side);
  return public.friend_room_view(r);
end $$;

-- Room by code for one of its members, players or spectators (locked for update).
create or replace function public.room_for_member(p_code text) returns public.friend_rooms language plpgsql security definer set search_path=public as $$
declare r public.friend_rooms;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  select * into r from public.friend_rooms where code = btrim(coalesce(p_code, '')) for update;
  if not found or not exists (select 1 from public.room_members m where m.code = r.code and m.user_id = auth.uid()) then raise exception 'room not found'; end if;
  return r;
end $$;
revoke all on function public.room_for_member(text) from public, anon, authenticated;

-- Join by code as a player ('away', 'home', or null = the side with fewer players) or a spectator ('watch').
-- Already a member: the side changes (before the start; a player's saved setup is cleared when the side does).
drop function if exists public.join_friend_room(text);
create or replace function public.join_friend_room(p_code text, p_side text default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.friend_rooms; m public.room_members; v_side text; away_id text; home_id text; st text;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if p_side is not null and p_side not in ('away', 'home', 'watch') then raise exception 'side must be away, home or watch'; end if;
  select * into r from public.friend_rooms where code = btrim(coalesce(p_code, '')) for update;
  select * into m from public.room_members where code = r.code and user_id = auth.uid();
  if m.user_id is null then
    -- Rate limit only for codes that are not mine: wrong codes answer {"error"} so the try is kept.
    if (select count(*) from public.room_join_attempts where user_id = auth.uid() and at > now() - interval '1 minute') >= 10 then
      raise exception 'too many tries';
    end if;
    insert into public.room_join_attempts(user_id) values (auth.uid());
    delete from public.room_join_attempts where at < now() - interval '1 day';
  end if;
  if r.code is null then return jsonb_build_object('error', 'not_found'); end if;
  if r.game_id is not null then select status into st from public.fanball_games where id = r.game_id; end if;
  if r.host_hidden or (r.game_id is null and r.expires_at < now()) or st in ('cancelled') then return jsonb_build_object('error', 'not_found'); end if;
  v_side := coalesce(p_side, m.side, (select s from unnest(array[case r.host_side when 'away' then 'home' else 'away' end, r.host_side]) with ordinality u(s, o)
                                    order by (select count(*) from public.room_members x where x.code = r.code and x.side = u.s), o limit 1));
  if m.user_id is not null then
    if v_side = m.side then return public.friend_room_view(r); end if;
    if r.game_id is not null and m.side in ('away', 'home') then raise exception 'your side is fixed once the game starts'; end if;
    if auth.uid() = r.host and v_side = 'watch' then raise exception 'the host plays'; end if;
    update public.room_members set side = v_side, setup = null, setup_at = null, hidden = false where code = r.code and user_id = auth.uid();
    if auth.uid() = r.host then update public.friend_rooms set host_side = v_side where code = r.code; end if;
  else
    insert into public.room_members(code, user_id, side) values (r.code, auth.uid(), v_side);
  end if;
  -- A player joining a started game becomes one of that side's voters.
  if r.game_id is not null and v_side in ('away', 'home') and st in ('scheduled', 'running') then
    select away_team_id, home_team_id into away_id, home_id from public.kbo_games where id = r.kbo_game_id;
    insert into public.fanball_game_memberships(game_id, user_id, team_id) values (r.game_id, auth.uid(), public.fanball_side_key(away_id, home_id, v_side))
    on conflict (game_id, user_id) do update set team_id = excluded.team_id;
  end if;
  select * into r from public.friend_rooms where code = r.code;
  return public.friend_room_view(r);
end $$;

-- The host's own side (kept for the room card's 「나는 홈/원정」).
create or replace function public.set_friend_room_side(p_code text, p_host_side text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.friend_rooms := public.room_for_member(p_code);
begin
  if auth.uid() <> r.host then raise exception 'only the host picks the sides'; end if;
  return public.join_friend_room(p_code, p_host_side);
end $$;

-- Save (or clear, with null) my team, starter, lineup and plans for the room. Hidden from the other side.
create or replace function public.set_friend_room_setup(p_code text, p_setup jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.friend_rooms := public.room_for_member(p_code);
begin
  if r.game_id is not null then raise exception 'the game has started'; end if;
  if r.expires_at < now() then raise exception 'room expired'; end if;
  if (select side from public.room_members where code = r.code and user_id = auth.uid()) = 'watch' then raise exception 'spectators do not pick lineups'; end if;
  if p_setup is not null and not public.valid_room_setup(p_setup) then raise exception 'lineup needs 9 batters and each position once'; end if;
  if p_setup is not null and length(p_setup::text) > 200000 then raise exception 'setup too large'; end if;
  update public.room_members set setup = p_setup, setup_at = case when p_setup is null then null else now() end where code = r.code and user_id = auth.uid();
  return public.friend_room_view(r);
end $$;

-- The host starts: each side's combined setup becomes its team; every player becomes a voter of their side.
create or replace function public.start_friend_room(p_code text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.friend_rooms := public.room_for_member(p_code); away_s jsonb; home_s jsonb; away_id text; home_id text; kbo_id text; gid uuid;
begin
  if auth.uid() <> r.host then raise exception 'only the host starts the game'; end if;
  if r.game_id is not null then return public.friend_room_view(r); end if;
  if r.expires_at < now() then raise exception 'room expired'; end if;
  if not exists (select 1 from public.room_members where code = r.code and side = case r.host_side when 'away' then 'home' else 'away' end) then
    raise exception 'your friend has not joined';
  end if;
  away_s := public.room_side_setup(r.code, 'away'); home_s := public.room_side_setup(r.code, 'home');
  if away_s is null or home_s is null then raise exception 'both lineups are needed'; end if;
  away_id := away_s->>'team'; home_id := home_s->>'team';
  kbo_id := format('room-%s-%s-%s', away_id, home_id, substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  insert into public.kbo_games(id, game_date, scheduled_at, away_team_id, home_team_id, status, provider)
  values (kbo_id, (now() at time zone 'Asia/Seoul')::date, now(), away_id, home_id, 'scheduled', 'room');
  insert into public.fanball_games(kbo_game_id, lineup_snapshot)
  values (kbo_id, jsonb_build_object('source', 'friend-room', 'teams', jsonb_build_object(
    public.fanball_side_key(away_id, home_id, 'away'), (away_s - 'team' - 'plan' - 'votes') || jsonb_build_object('lineupSource', format('friend_room:%s', away_s->>'votes')),
    home_id, (home_s - 'team' - 'plan' - 'votes') || jsonb_build_object('lineupSource', format('friend_room:%s', home_s->>'votes')))))
  returning id into gid;
  update public.friend_rooms set game_id = gid, kbo_game_id = kbo_id where code = r.code returning * into r;
  insert into public.fanball_game_memberships(game_id, user_id, team_id)
  select gid, m.user_id, public.fanball_side_key(away_id, home_id, m.side) from public.room_members m where m.code = r.code and m.side in ('away', 'home')
  on conflict (game_id, user_id) do update set team_id = excluded.team_id;
  -- Each side starts with the plans its players picked most.
  insert into public.team_plan_votes(game_id, user_id, side_key, offense, defense)
  select gid, m.user_id, public.fanball_side_key(away_id, home_id, m.side), coalesce(m.setup->'plan'->>'offense', 'normal'), coalesce(m.setup->'plan'->>'defense', 'normal')
  from public.room_members m where m.code = r.code and m.side in ('away', 'home') and m.setup is not null
    and coalesce(m.setup->'plan'->>'offense', 'normal') in ('normal','first_pitch','patient','power','contact')
    and coalesce(m.setup->'plan'->>'defense', 'normal') in ('normal','aggressive','careful')
  on conflict (game_id, user_id) do nothing;
  return public.friend_room_view(r);
end $$;

-- Delete / leave by code. The host deletes the room (a started game is cancelled); anyone else leaves
-- (before the start their membership goes; after it the room just leaves their list).
create or replace function public.delete_friend_room_code(p_code text)
returns void language plpgsql security definer set search_path=public as $$
declare r public.friend_rooms := public.room_for_member(p_code); st text;
begin
  if r.game_id is not null then select status into st from public.fanball_games where id = r.game_id; end if;
  if auth.uid() = r.host then
    if st in ('scheduled', 'running') then
      update public.fanball_games set status = 'cancelled', ended_at = now() where id = r.game_id;
      update public.fanball_game_private set next_action = null, next_action_at = null, state_version = state_version + 1, updated_at = now() where game_id = r.game_id;
      update public.tactical_rounds set status = 'cancelled' where game_id = r.game_id and status in ('open', 'closing');
      update public.kbo_games set status = 'cancelled' where id = r.kbo_game_id;
    end if;
    update public.friend_rooms set host_hidden = true, expires_at = least(expires_at, now()) where code = r.code;
    update public.room_members set hidden = true where code = r.code and user_id = auth.uid();
  elsif r.game_id is null then
    delete from public.room_members where code = r.code and user_id = auth.uid();
  else
    update public.room_members set hidden = true where code = r.code and user_id = auth.uid();
  end if;
end $$;

-- The old delete-by-game function follows the same rule.
create or replace function public.delete_friend_room(p_game_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare c text;
begin
  select code into c from public.friend_rooms where game_id = p_game_id;
  if c is null then raise exception 'room not found'; end if;
  perform public.delete_friend_room_code(c);
end $$;

create or replace function public.my_friend_rooms()
returns jsonb language sql stable security definer set search_path=public as $$
  select coalesce(jsonb_agg(public.friend_room_view(r) order by r.created_at desc), '[]'::jsonb)
  from public.room_members m join public.friend_rooms r on r.code = m.code left join public.fanball_games f on f.id = r.game_id
  where m.user_id = auth.uid() and not m.hidden and not (r.host_hidden and r.game_id is null)
    and ((r.game_id is null and r.expires_at > now()) or f.status = 'running' or (f.status = 'final' and f.ended_at > now() - interval '1 day'));
$$;

-- Chat: members and spectators; each message says the sender's side.
create or replace function public.room_messages_after(p_code text, p_after bigint default 0)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.friend_rooms := public.room_for_member(p_code);
begin
  return coalesce((select jsonb_agg(x order by (x->>'id')::bigint) from (
    select jsonb_build_object('id', m.id, 'mine', m.user_id = auth.uid(), 'who', coalesce(rm.side, 'watch'), 'host', m.user_id = r.host,
      'nickname', coalesce(nullif(p.nickname, ''), case when m.user_id = auth.uid() then '나' else '팬' end), 'body', m.body, 'at', m.created_at) x
    from public.room_messages m left join public.profiles p on p.user_id = m.user_id
      left join public.room_members rm on rm.code = m.code and rm.user_id = m.user_id
    where m.code = r.code and m.id > coalesce(p_after, 0) order by m.id desc limit 100) t), '[]'::jsonb);
end $$;

-- Team plans: a room player who has not voted counts with the plans saved in their setup.
create or replace function public.team_plan_status(p_game_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare away_id text; home_id text; keys text[]; k text; o text; d text; n int; sides jsonb := '{}'::jsonb; mine jsonb;
begin
  select ka.away_team_id, ka.home_team_id into away_id, home_id
    from public.fanball_games f join public.kbo_games ka on ka.id = f.kbo_game_id where f.id = p_game_id;
  if away_id is null then return null; end if;
  keys := array[public.fanball_side_key(away_id, home_id, 'away'), public.fanball_side_key(away_id, home_id, 'home')];
  foreach k in array keys loop
    with picks as (
      select v.offense, v.defense, v.updated_at from public.team_plan_votes v where v.game_id = p_game_id and v.side_key = k
      union all
      select coalesce(m.setup->'plan'->>'offense', 'normal'), coalesce(m.setup->'plan'->>'defense', 'normal'), '-infinity'::timestamptz
      from public.friend_rooms r join public.room_members m on m.code = r.code
      where r.game_id = p_game_id and m.setup ? 'plan' and public.fanball_side_key(away_id, home_id, m.side) = k and m.side in ('away', 'home')
        and not exists (select 1 from public.team_plan_votes v where v.game_id = p_game_id and v.user_id = m.user_id)
    )
    select (select offense from picks where offense in ('normal','first_pitch','patient','power','contact') group by offense order by count(*) desc, max(updated_at) desc limit 1),
           (select defense from picks where defense in ('normal','aggressive','careful') group by defense order by count(*) desc, max(updated_at) desc limit 1),
           (select count(*) from picks)
      into o, d, n;
    sides := sides || jsonb_build_object(k, jsonb_build_object('offense', coalesce(o, 'normal'), 'defense', coalesce(d, 'normal'), 'fans', n));
  end loop;
  if auth.uid() is not null then
    select jsonb_build_object('side', side_key, 'offense', offense, 'defense', defense) into mine
      from public.team_plan_votes where game_id = p_game_id and user_id = auth.uid();
  end if;
  return jsonb_build_object('sides', sides, 'mine', mine);
end $$;

revoke all on function public.join_friend_room(text, text) from public, anon;
grant execute on function public.join_friend_room(text, text) to authenticated;
revoke all on function public.delete_friend_room(uuid) from public, anon;
grant execute on function public.delete_friend_room(uuid) to authenticated;

-- Joining a game: a spectator (or anyone outside) of a friend-room game gets a membership with no side instead
-- of an error, so the game screen still loads for them; otherwise as before (202611110006_event_match_sides.sql).
create or replace function public.join_fanball_game(p_game_id uuid)
returns public.fanball_game_memberships language plpgsql security definer set search_path=public,auth as $$
declare v public.fanball_game_memberships; k record; fav text;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if public.room_outsider(p_game_id, auth.uid()) then
    v.game_id := p_game_id; v.user_id := auth.uid(); v.team_id := null;
    return v;
  end if;
  select k2.away_team_id, k2.home_team_id into k from public.fanball_games f join public.kbo_games k2 on k2.id = f.kbo_game_id where f.id = p_game_id;
  select favorite_team_id into fav from public.profiles where user_id = auth.uid();
  if found and k.away_team_id = k.home_team_id and fav = k.home_team_id
     and not exists (select 1 from public.fanball_game_memberships where game_id = p_game_id and user_id = auth.uid()) then
    v.game_id := p_game_id; v.user_id := auth.uid(); v.team_id := null;
    return v;
  end if;
  insert into public.fanball_game_memberships(game_id,user_id,team_id)
    select p_game_id,auth.uid(),favorite_team_id from public.profiles where user_id=auth.uid()
  on conflict(game_id,user_id) do nothing;
  select * into v from public.fanball_game_memberships where game_id=p_game_id and user_id=auth.uid();
  if not found then raise exception 'profile or game not found'; end if;
  return v;
end $$;
