-- Admins, fan lineup submissions and the representative lineup (2026-11-11).

-- 1) RLS performance (Supabase advisor auth_rls_initplan): evaluate auth.uid() once per query.
drop policy if exists "profiles_read_self" on public.profiles;
create policy "profiles_read_self" on public.profiles for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self" on public.profiles for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "memberships_read_self" on public.fanball_game_memberships;
create policy "memberships_read_self" on public.fanball_game_memberships for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "votes_read_self" on public.tactical_votes;
create policy "votes_read_self" on public.tactical_votes for select to authenticated using (user_id = (select auth.uid()));

-- 2) Admins. Rows are added by the project owner in the SQL editor; browsers can only ask "am I an admin?".
create table if not exists public.app_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  note text,
  created_at timestamptz not null default now()
);
alter table public.app_admins enable row level security;
revoke all on public.app_admins from public, anon, authenticated;
grant all on public.app_admins to service_role;

create or replace function public.is_admin()
returns boolean language sql security definer set search_path=public stable as $$
  select exists(select 1 from public.app_admins where user_id = (select auth.uid()));
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated, service_role;

-- 3) Fan lineups. One submission per fan and game, for the fan's own team, until the game starts.
-- slots: 9 items in batting order, {"player": "<name in the lineup snapshot>", "pos": "C|1B|2B|3B|SS|LF|CF|RF|DH"}.
create table if not exists public.lineup_submissions (
  game_id uuid not null references public.fanball_games(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  team_id text not null,
  slots jsonb not null,
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (game_id, user_id)
);
create index if not exists lineup_submissions_team_idx on public.lineup_submissions(game_id, team_id);
alter table public.lineup_submissions enable row level security;
revoke all on public.lineup_submissions from public, anon, authenticated;
grant select on public.lineup_submissions to authenticated;
grant all on public.lineup_submissions to service_role;
drop policy if exists "lineups_read_self" on public.lineup_submissions;
create policy "lineups_read_self" on public.lineup_submissions for select to authenticated using (user_id = (select auth.uid()));

create or replace function public.submit_fanball_lineup(p_game_id uuid, p_slots jsonb)
returns public.lineup_submissions language plpgsql security definer set search_path=public, auth as $$
declare g record; fan_team text; names text[]; positions text[]; item jsonb; result public.lineup_submissions;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  select f.id, f.status, f.lineup_snapshot, k.away_team_id, k.home_team_id into g
    from public.fanball_games f join public.kbo_games k on k.id = f.kbo_game_id where f.id = p_game_id;
  if not found then raise exception 'game not found'; end if;
  if g.status <> 'scheduled' then raise exception 'lineup voting is closed'; end if;
  select coalesce((select team_id from public.fanball_game_memberships where game_id = p_game_id and user_id = auth.uid()),
                  (select favorite_team_id from public.profiles where user_id = auth.uid())) into fan_team;
  if fan_team is null or fan_team not in (g.away_team_id, g.home_team_id) then raise exception 'your team is not playing in this game'; end if;
  if jsonb_typeof(p_slots) <> 'array' or jsonb_array_length(p_slots) <> 9 then raise exception 'a lineup needs 9 batters'; end if;
  for item in select * from jsonb_array_elements(p_slots) loop
    if not exists (select 1 from jsonb_array_elements(g.lineup_snapshot->'teams'->fan_team->'players') p where p->>0 = item->>'player') then
      raise exception 'player % is not in the squad', item->>'player';
    end if;
    names := names || (item->>'player'); positions := positions || (item->>'pos');
  end loop;
  if (select count(distinct x) from unnest(names) x) <> 9 then raise exception 'each batter can bat only once'; end if;
  if (select array_agg(x order by x) from unnest(positions) x) <> array['1B','2B','3B','C','CF','DH','LF','RF','SS'] then
    raise exception 'positions must be C, 1B, 2B, 3B, SS, LF, CF, RF and DH once each';
  end if;
  insert into public.lineup_submissions(game_id, user_id, team_id, slots)
  values (p_game_id, auth.uid(), fan_team, p_slots)
  on conflict (game_id, user_id) do update set slots = excluded.slots, team_id = excluded.team_id, updated_at = now()
  returning * into result;
  return result;
end $$;
revoke all on function public.submit_fanball_lineup(uuid, jsonb) from public, anon;
grant execute on function public.submit_fanball_lineup(uuid, jsonb) to authenticated;

-- Representative lineup for one team: for slot 1..9 take the player named most often in that slot
-- (not already chosen; ties go to the earliest submission), then give each chosen player the
-- position most voted for them that is still free. Null when nobody submitted.
create or replace function public.representative_lineup(p_game_id uuid, p_team_id text)
returns jsonb language plpgsql security definer set search_path=public stable as $$
declare chosen text[] := '{}'; pick text; slot int; positions jsonb := '{}'; taken text[] := '{}'; name text; pos text; n int;
begin
  select count(*) into n from public.lineup_submissions where game_id = p_game_id and team_id = p_team_id;
  if n = 0 then return null; end if;
  for slot in 0..8 loop
    select s.slots->slot->>'player' into pick
      from public.lineup_submissions s
      where s.game_id = p_game_id and s.team_id = p_team_id and not (s.slots->slot->>'player' = any(chosen))
      group by s.slots->slot->>'player'
      order by count(*) desc, min(s.updated_at) asc limit 1;
    if pick is null then return null; end if;
    chosen := chosen || pick;
  end loop;
  -- Positions: strongest (player, position) pairs first.
  for name, pos in
    select x->>'player', x->>'pos' from public.lineup_submissions s, jsonb_array_elements(s.slots) x
    where s.game_id = p_game_id and s.team_id = p_team_id and x->>'player' = any(chosen)
    group by 1, 2 order by count(*) desc, min(s.updated_at) asc
  loop
    if positions ? name or pos = any(taken) then continue; end if;
    positions := positions || jsonb_build_object(name, pos); taken := taken || pos;
  end loop;
  foreach name in array chosen loop
    if not positions ? name then
      select x into pos from unnest(array['C','1B','2B','3B','SS','LF','CF','RF','DH']) x where not (x = any(taken)) limit 1;
      positions := positions || jsonb_build_object(name, pos); taken := taken || pos;
    end if;
  end loop;
  return jsonb_build_object('players', to_jsonb(chosen), 'positions', positions, 'submissions', n);
end $$;
revoke all on function public.representative_lineup(uuid, text) from public, anon, authenticated;
grant execute on function public.representative_lineup(uuid, text) to service_role;

-- Start due games as before, but first fix each team's batting order to the fans' representative
-- lineup when there are submissions (the snapshot can still change while the game is scheduled).
create or replace function public.start_due_fanball_games()
returns setof uuid language plpgsql security definer set search_path=public as $$
declare g record; new_seed bigint; side text; team_id text; rep jsonb; snap jsonb; order_idx jsonb; nm text;
begin
  for g in
    select f.id, f.lineup_snapshot, k.away_team_id, k.home_team_id from public.fanball_games f join public.kbo_games k on k.id = f.kbo_game_id
    where f.status = 'scheduled' and k.scheduled_at <= now() and k.status not in ('postponed','cancelled')
      and f.lineup_snapshot is not null
    order by k.scheduled_at
    for update of f skip locked
  loop
    snap := g.lineup_snapshot;
    foreach team_id in array array[g.away_team_id, g.home_team_id] loop
      rep := public.representative_lineup(g.id, team_id);
      if rep is null then continue; end if;
      order_idx := '[]'::jsonb;
      for nm in select jsonb_array_elements_text(rep->'players') loop
        order_idx := order_idx || to_jsonb((select (ord - 1)::int from jsonb_array_elements(snap->'teams'->team_id->'players') with ordinality t(p, ord) where p->>0 = nm limit 1));
      end loop;
      snap := jsonb_set(snap, array['teams', team_id, 'order'], order_idx);
      snap := jsonb_set(snap, array['teams', team_id, 'positions'], rep->'positions');
      snap := jsonb_set(snap, array['teams', team_id, 'lineupSource'], to_jsonb(format('fan_vote:%s', rep->>'submissions')));
    end loop;
    new_seed := ('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint;
    insert into public.fanball_game_private(game_id, seed, next_action, next_action_at)
    values (g.id, new_seed, 'play_pa', now());
    update public.fanball_games
      set lineup_snapshot = snap, status = 'running', started_at = now(),
          seed_hash = encode(sha256(convert_to(new_seed::text, 'UTF8')), 'hex')
      where id = g.id;
    return next g.id;
  end loop;
end $$;
revoke all on function public.start_due_fanball_games() from public, anon, authenticated;
grant execute on function public.start_due_fanball_games() to service_role;
