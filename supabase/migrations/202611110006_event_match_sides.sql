-- Event match sides (2026-11-11, user request): in a team-against-itself game the away and home sides
-- have separate lineup votes and tactic votes. The away side is known as '<team>@away' in the lineup
-- snapshot, lineup submissions, memberships, tactical rounds and the engine; the home side keeps the
-- team id. Fans of that team pick a side (choose_fanball_side) before voting; they may switch until the
-- game starts, and their submitted lineup moves with them.

create or replace function public.fanball_side_key(p_away text, p_home text, p_side text)
returns text language sql immutable set search_path=public as $$
  select case when p_side = 'away' then (case when p_away = p_home then p_away || '@away' else p_away end) else p_home end;
$$;
grant execute on function public.fanball_side_key(text, text, text) to anon, authenticated, service_role;

create or replace function public.admin_schedule_fanball_game(
  p_away_team_id text, p_home_team_id text, p_scheduled_at timestamptz, p_lineup_snapshot jsonb)
returns uuid language plpgsql security definer set search_path=public as $$
declare kbo_id text; new_id uuid; side text;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  if p_away_team_id is null or p_home_team_id is null then raise exception 'pick two teams'; end if;
  if p_scheduled_at is null or p_scheduled_at < now() then raise exception 'start time must be in the future'; end if;
  if p_scheduled_at > now() + interval '60 days' then raise exception 'start time must be within 60 days'; end if;
  foreach side in array array[p_away_team_id, p_home_team_id] loop
    if jsonb_typeof(p_lineup_snapshot->'teams'->side->'players') <> 'array'
       or jsonb_array_length(p_lineup_snapshot->'teams'->side->'players') < 9
       or jsonb_typeof(p_lineup_snapshot->'teams'->side->'order') <> 'array'
       or jsonb_array_length(p_lineup_snapshot->'teams'->side->'order') <> 9
       or p_lineup_snapshot->'teams'->side->'pitcher' is null then
      raise exception 'lineup snapshot is missing team %', side;
    end if;
  end loop;
  kbo_id := format('admin-%s-%s-%s-%s', to_char(p_scheduled_at at time zone 'Asia/Seoul', 'YYYYMMDD-HH24MI'),
                   p_away_team_id, p_home_team_id, substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
  insert into public.kbo_games(id, game_date, scheduled_at, away_team_id, home_team_id, status, provider)
  values (kbo_id, (p_scheduled_at at time zone 'Asia/Seoul')::date, p_scheduled_at, p_away_team_id, p_home_team_id, 'scheduled', 'demo');
  insert into public.fanball_games(kbo_game_id, lineup_snapshot)
  values (kbo_id, jsonb_build_object('source', 'admin-sample-rosters', 'teams', jsonb_build_object(
    public.fanball_side_key(p_away_team_id, p_home_team_id, 'away'), p_lineup_snapshot->'teams'->p_away_team_id,
    p_home_team_id, p_lineup_snapshot->'teams'->p_home_team_id)))
  returning id into new_id;
  return new_id;
end $$;

create or replace function public.submit_fanball_lineup(p_game_id uuid, p_slots jsonb)
returns public.lineup_submissions language plpgsql security definer set search_path=public, auth as $$
declare g record; fan_team text; away_key text; home_key text; joined text; names text[]; positions text[]; item jsonb; result public.lineup_submissions;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  select f.id, f.status, f.lineup_snapshot, k.away_team_id, k.home_team_id into g
    from public.fanball_games f join public.kbo_games k on k.id = f.kbo_game_id where f.id = p_game_id;
  if not found then raise exception 'game not found'; end if;
  if g.status <> 'scheduled' then raise exception 'lineup voting is closed'; end if;
  away_key := public.fanball_side_key(g.away_team_id, g.home_team_id, 'away'); home_key := g.home_team_id;
  select team_id into joined from public.fanball_game_memberships where game_id = p_game_id and user_id = auth.uid();
  fan_team := coalesce(joined, (select favorite_team_id from public.profiles where user_id = auth.uid()));
  -- Event match: the fan first picks the away or the home side (choose_fanball_side).
  if g.away_team_id = g.home_team_id and joined is null and fan_team = g.home_team_id then raise exception 'pick a side first'; end if;
  if fan_team is null or fan_team not in (away_key, home_key) then raise exception 'your team is not playing in this game'; end if;
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
    foreach team_id in array array[public.fanball_side_key(g.away_team_id, g.home_team_id, 'away'), g.home_team_id] loop
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

create or replace function public.join_fanball_game(p_game_id uuid)
returns public.fanball_game_memberships language plpgsql security definer set search_path=public,auth as $$
declare v public.fanball_game_memberships; k record; fav text;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  -- Event match: a fan of the team joins by picking a side (choose_fanball_side); until then they get a
  -- membership row with no team (not stored), so the site can ask which side.
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

create or replace function public.choose_fanball_side(p_game_id uuid, p_side text)
returns public.fanball_game_memberships language plpgsql security definer set search_path=public, auth as $$
declare g record; fav text; key text; m public.fanball_game_memberships;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if p_side not in ('away', 'home') then raise exception 'side must be away or home'; end if;
  select f.status, k.away_team_id, k.home_team_id into g from public.fanball_games f join public.kbo_games k on k.id = f.kbo_game_id where f.id = p_game_id;
  if not found then raise exception 'game not found'; end if;
  if g.away_team_id <> g.home_team_id then raise exception 'only event matches have sides to pick'; end if;
  select favorite_team_id into fav from public.profiles where user_id = auth.uid();
  if fav is distinct from g.home_team_id then raise exception 'your team is not playing in this game'; end if;
  key := public.fanball_side_key(g.away_team_id, g.home_team_id, p_side);
  select * into m from public.fanball_game_memberships where game_id = p_game_id and user_id = auth.uid();
  if found and m.team_id <> key and g.status <> 'scheduled' then raise exception 'your side is fixed once the game starts'; end if;
  insert into public.fanball_game_memberships(game_id, user_id, team_id) values (p_game_id, auth.uid(), key)
  on conflict (game_id, user_id) do update set team_id = excluded.team_id
  returning * into m;
  update public.lineup_submissions set team_id = key, updated_at = now() where game_id = p_game_id and user_id = auth.uid() and team_id <> key;
  return m;
end $$;
revoke all on function public.choose_fanball_side(uuid, text) from public, anon;
grant execute on function public.choose_fanball_side(uuid, text) to authenticated;
