-- Team-wide game plans (2026-11-13, user request; engine 2.19). Each side has a batting plan and a pitching plan
-- (engine PLANS: offense normal/first_pitch/patient/power/contact, defense normal/aggressive/careful).
-- Fans of a side pick their preferred plans before or during the game; the side's plan is the most picked
-- one (ties: the one picked most recently). The orchestrator reads it before every pitch. In a friend room
-- with no pick yet, the plans saved with the room setup (setup.plan) count as that person's pick.

create table if not exists public.team_plan_votes (
  game_id uuid not null references public.fanball_games(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  side_key text not null,
  offense text not null default 'normal' check (offense in ('normal','first_pitch','patient','power','contact')),
  defense text not null default 'normal' check (defense in ('normal','aggressive','careful')),
  updated_at timestamptz not null default now(),
  primary key (game_id, user_id)
);
alter table public.team_plan_votes enable row level security;
revoke all on public.team_plan_votes from public, anon, authenticated;
grant all on public.team_plan_votes to service_role;

-- Each side's plans: {"sides": {"<side key>": {"offense": .., "defense": .., "fans": n}}, "mine": {..} | null}.
create or replace function public.team_plan_status(p_game_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare away_id text; home_id text; keys text[]; k text; o text; d text; n int; sides jsonb := '{}'::jsonb; mine jsonb;
begin
  select ka.away_team_id, ka.home_team_id into away_id, home_id
    from public.fanball_games f join public.kbo_games ka on ka.id = f.kbo_game_id where f.id = p_game_id;
  if away_id is null then return null; end if;
  keys := array[public.fanball_side_key(away_id, home_id, 'away'), public.fanball_side_key(away_id, home_id, 'home')];
  foreach k in array keys loop
    -- Picks: fans' votes, plus a room member's saved setup when that member has not voted.
    with picks as (
      select v.offense, v.defense, v.updated_at from public.team_plan_votes v where v.game_id = p_game_id and v.side_key = k
      union all
      select coalesce(s.setup->'plan'->>'offense', 'normal'), coalesce(s.setup->'plan'->>'defense', 'normal'), '-infinity'::timestamptz
      from public.friend_rooms r
      cross join lateral (values (r.host, case when r.host_side = 'home' then keys[2] else keys[1] end, r.host_setup),
                                 (r.guest, case when r.host_side = 'home' then keys[1] else keys[2] end, r.guest_setup)) s(uid, skey, setup)
      where r.game_id = p_game_id and s.uid is not null and s.skey = k and s.setup ? 'plan'
        and not exists (select 1 from public.team_plan_votes v where v.game_id = p_game_id and v.user_id = s.uid)
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

-- A fan's pick for their own side (the side they joined), before or during the game.
create or replace function public.set_team_plan(p_game_id uuid, p_offense text, p_defense text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare m public.fanball_game_memberships; st text;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  select status into st from public.fanball_games where id = p_game_id;
  if st is null or st not in ('scheduled', 'running') then raise exception 'game is not open'; end if;
  select * into m from public.fanball_game_memberships where game_id = p_game_id and user_id = auth.uid();
  if not found or m.team_id is null then raise exception 'join this game before choosing'; end if;
  if p_offense not in ('normal','first_pitch','patient','power','contact') or p_defense not in ('normal','aggressive','careful') then
    raise exception 'unknown plan';
  end if;
  insert into public.team_plan_votes(game_id, user_id, side_key, offense, defense) values (p_game_id, auth.uid(), m.team_id, p_offense, p_defense)
  on conflict (game_id, user_id) do update set side_key = excluded.side_key, offense = excluded.offense, defense = excluded.defense, updated_at = now();
  return public.team_plan_status(p_game_id);
end $$;

revoke all on function public.team_plan_status(uuid) from public;
grant execute on function public.team_plan_status(uuid) to anon, authenticated, service_role;
revoke all on function public.set_team_plan(uuid, text, text) from public, anon;
grant execute on function public.set_team_plan(uuid, text, text) to authenticated;
