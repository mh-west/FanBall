-- FanBall synchronized offense/defense tactical voting foundation.
-- Apply to a dedicated Supabase project after reviewing access policies.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  nickname text not null default '',
  favorite_team_id text not null default 'doosan',
  updated_at timestamptz not null default now()
);

create table if not exists public.kbo_games (
  id text primary key,
  game_date date not null,
  scheduled_at timestamptz not null,
  away_team_id text not null,
  home_team_id text not null,
  status text not null default 'scheduled' check(status in ('scheduled','live','final','postponed','cancelled')),
  provider text not null default 'demo',
  updated_at timestamptz not null default now(),
  check(away_team_id <> home_team_id)
);

create table if not exists public.fanball_games (
  id uuid primary key default gen_random_uuid(),
  kbo_game_id text not null unique references public.kbo_games(id),
  status text not null default 'scheduled' check(status in ('scheduled','running','final','cancelled')),
  inning_state jsonb not null default '{}'::jsonb,
  score jsonb not null default '{"away":0,"home":0}'::jsonb,
  seed bigint,
  model_version text,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.fanball_game_memberships (
  game_id uuid not null references public.fanball_games(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  team_id text not null,
  joined_at timestamptz not null default now(),
  primary key(game_id,user_id)
);

create table if not exists public.tactical_rounds (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.fanball_games(id) on delete cascade,
  pa_no integer not null check(pa_no > 0),
  state_snapshot jsonb not null default '{}'::jsonb,
  offense_team_id text not null,
  defense_team_id text not null,
  opens_at timestamptz not null default now(),
  closes_at timestamptz not null,
  status text not null default 'open' check(status in ('open','closing','resolved','cancelled')),
  created_at timestamptz not null default now(),
  unique(game_id,pa_no),
  check(offense_team_id <> defense_team_id),
  check(closes_at > opens_at)
);

create table if not exists public.tactical_choices (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.tactical_rounds(id) on delete cascade,
  role text not null check(role in ('offense','defense')),
  choice_key text not null,
  label text not null,
  is_default boolean not null default false,
  unique(round_id,role,choice_key),
  unique(round_id,role,id)
);

create unique index if not exists tactical_one_default_per_role
  on public.tactical_choices(round_id,role) where is_default;

create table if not exists public.tactical_votes (
  round_id uuid not null references public.tactical_rounds(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check(role in ('offense','defense')),
  team_id text not null,
  choice_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(round_id,user_id),
  foreign key(round_id,role,choice_id) references public.tactical_choices(round_id,role,id)
);

create table if not exists public.tactical_resolutions (
  round_id uuid primary key references public.tactical_rounds(id) on delete cascade,
  offense_choice_id uuid not null references public.tactical_choices(id),
  defense_choice_id uuid not null references public.tactical_choices(id),
  vote_counts jsonb not null default '{}'::jsonb,
  fallback_roles text[] not null default '{}',
  resolved_at timestamptz not null default now()
);

create table if not exists public.plate_appearances (
  game_id uuid not null references public.fanball_games(id) on delete cascade,
  pa_no integer not null check(pa_no > 0),
  round_id uuid unique references public.tactical_rounds(id),
  outcome text not null,
  runs integer not null default 0 check(runs >= 0),
  result_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key(game_id,pa_no)
);

create index if not exists tactical_rounds_open_idx on public.tactical_rounds(status,closes_at);
create index if not exists tactical_votes_round_idx on public.tactical_votes(round_id,role,choice_id);

alter table public.profiles enable row level security;
alter table public.kbo_games enable row level security;
alter table public.fanball_games enable row level security;
alter table public.fanball_game_memberships enable row level security;
alter table public.tactical_rounds enable row level security;
alter table public.tactical_choices enable row level security;
alter table public.tactical_votes enable row level security;
alter table public.tactical_resolutions enable row level security;
alter table public.plate_appearances enable row level security;

create policy "profiles_read_self" on public.profiles for select to authenticated using(user_id=auth.uid());
create policy "profiles_update_self" on public.profiles for update to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
create policy "kbo_games_public_read" on public.kbo_games for select to anon,authenticated using(true);
create policy "fanball_games_public_read" on public.fanball_games for select to anon,authenticated using(true);
create policy "memberships_read_self" on public.fanball_game_memberships for select to authenticated using(user_id=auth.uid());
create policy "rounds_public_read" on public.tactical_rounds for select to anon,authenticated using(true);
create policy "choices_public_read" on public.tactical_choices for select to anon,authenticated using(true);
create policy "votes_read_self" on public.tactical_votes for select to authenticated using(user_id=auth.uid());
create policy "resolutions_public_read" on public.tactical_resolutions for select to anon,authenticated using(true);
create policy "plate_appearances_public_read" on public.plate_appearances for select to anon,authenticated using(true);

revoke insert,update,delete on public.profiles from anon,authenticated;
revoke insert,update,delete on public.kbo_games,public.fanball_games,public.fanball_game_memberships,
  public.tactical_rounds,public.tactical_choices,public.tactical_votes,public.tactical_resolutions,
  public.plate_appearances from anon,authenticated;
grant select on public.kbo_games,public.fanball_games,public.tactical_rounds,public.tactical_choices,
  public.tactical_resolutions,public.plate_appearances to anon,authenticated;
grant select on public.profiles,public.fanball_game_memberships,public.tactical_votes to authenticated;

create or replace function public.sync_my_profile(p_nickname text,p_favorite_team_id text)
returns void language plpgsql security definer set search_path=public,auth as $$
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if p_favorite_team_id not in ('lg','kt','ssg','nc','doosan','tigers','lotte','samsung','hanwha','kiwoom') then
    raise exception 'invalid favorite team';
  end if;
  insert into public.profiles(user_id,nickname,favorite_team_id,updated_at)
  values(auth.uid(),left(trim(coalesce(p_nickname,'')),24),p_favorite_team_id,now())
  on conflict(user_id) do update set nickname=excluded.nickname,favorite_team_id=excluded.favorite_team_id,updated_at=now();
end $$;

create or replace function public.join_fanball_game(p_game_id uuid)
returns public.fanball_game_memberships language plpgsql security definer set search_path=public,auth as $$
declare v public.fanball_game_memberships;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  insert into public.fanball_game_memberships(game_id,user_id,team_id)
    select p_game_id,auth.uid(),favorite_team_id from public.profiles where user_id=auth.uid()
  on conflict(game_id,user_id) do nothing;
  select * into v from public.fanball_game_memberships where game_id=p_game_id and user_id=auth.uid();
  if not found then raise exception 'profile or game not found'; end if;
  return v;
end $$;

create or replace function public.submit_tactical_vote(p_round_id uuid,p_choice_id uuid)
returns public.tactical_votes language plpgsql security definer set search_path=public,auth as $$
declare r public.tactical_rounds; m public.fanball_game_memberships; c public.tactical_choices; old_vote public.tactical_votes; role_value text;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  select * into r from public.tactical_rounds where id=p_round_id for update;
  if not found or r.status <> 'open' or clock_timestamp() >= r.closes_at then raise exception 'voting is closed'; end if;
  select * into m from public.fanball_game_memberships where game_id=r.game_id and user_id=auth.uid();
  if not found then raise exception 'join this game before voting'; end if;
  role_value := case when m.team_id=r.offense_team_id then 'offense' when m.team_id=r.defense_team_id then 'defense' else null end;
  if role_value is null then raise exception 'spectators cannot vote'; end if;
  select * into c from public.tactical_choices where id=p_choice_id and round_id=r.id and role=role_value;
  if not found then raise exception 'choice does not match your team role'; end if;
  select * into old_vote from public.tactical_votes where round_id=r.id and user_id=auth.uid();
  if found and (old_vote.role<>role_value or old_vote.team_id<>m.team_id) then raise exception 'vote role is already fixed for this round'; end if;
  insert into public.tactical_votes(round_id,user_id,role,team_id,choice_id)
  values(r.id,auth.uid(),role_value,m.team_id,c.id)
  on conflict(round_id,user_id) do update set choice_id=excluded.choice_id,updated_at=now()
  returning * into old_vote;
  return old_vote;
end $$;

-- Only trusted server code can open and resolve a round. Never expose these RPCs to browser roles.
create or replace function public.open_tactical_round(
  p_game_id uuid,p_pa_no integer,p_state_snapshot jsonb,p_offense_team_id text,p_defense_team_id text,p_choices jsonb
) returns public.tactical_rounds language plpgsql security definer set search_path=public as $$
declare r public.tactical_rounds; item jsonb; opened timestamptz:=clock_timestamp();
begin
  if not exists(select 1 from public.fanball_games where id=p_game_id and status='running') then raise exception 'game is not running'; end if;
  insert into public.tactical_rounds(game_id,pa_no,state_snapshot,offense_team_id,defense_team_id,opens_at,closes_at)
  values(p_game_id,p_pa_no,coalesce(p_state_snapshot,'{}'::jsonb),p_offense_team_id,p_defense_team_id,opened,opened+interval '15 seconds')
  on conflict(game_id,pa_no) do nothing;
  select * into r from public.tactical_rounds where game_id=p_game_id and pa_no=p_pa_no for update;
  if r.status <> 'open' then return r; end if;
  if not exists(select 1 from public.tactical_choices where round_id=r.id) then
    for item in select * from jsonb_array_elements(coalesce(p_choices,'[]'::jsonb)) loop
      insert into public.tactical_choices(round_id,role,choice_key,label,is_default)
      values(r.id,item->>'role',item->>'key',item->>'label',coalesce((item->>'default')::boolean,false));
    end loop;
  end if;
  if not exists(select 1 from public.tactical_choices where round_id=r.id and role='offense' and is_default)
    or not exists(select 1 from public.tactical_choices where round_id=r.id and role='defense' and is_default) then
    raise exception 'each role needs a default choice';
  end if;
  return r;
end $$;

create or replace function public.resolve_tactical_round(p_round_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.tactical_rounds; off_id uuid; def_id uuid; counts jsonb; fallbacks text[]:='{}';
  off_top bigint; def_top bigint; off_ties integer; def_ties integer;
begin
  select * into r from public.tactical_rounds where id=p_round_id for update;
  if not found then raise exception 'round not found'; end if;
  if r.status='resolved' then
    return (select jsonb_build_object('round_id',round_id,'offense_choice_id',offense_choice_id,'defense_choice_id',defense_choice_id,'vote_counts',vote_counts,'fallback_roles',fallback_roles) from public.tactical_resolutions where round_id=r.id);
  end if;
  if r.status<>'open' or clock_timestamp()<r.closes_at then raise exception 'round is not ready to resolve'; end if;
  update public.tactical_rounds set status='closing' where id=r.id;
  select coalesce(jsonb_object_agg(role||':'||choice_id::text,n), '{}'::jsonb) into counts from (
    select role,choice_id,count(*) n from public.tactical_votes where round_id=r.id group by role,choice_id
  ) tally;
  select max(n),count(*) filter(where n=(select max(n) from (select count(*) n from public.tactical_votes where round_id=r.id and role='offense' group by choice_id) q))
    into off_top,off_ties from (select count(*) n from public.tactical_votes where round_id=r.id and role='offense' group by choice_id) tally;
  select max(n),count(*) filter(where n=(select max(n) from (select count(*) n from public.tactical_votes where round_id=r.id and role='defense' group by choice_id) q))
    into def_top,def_ties from (select count(*) n from public.tactical_votes where round_id=r.id and role='defense' group by choice_id) tally;
  if off_top is null or off_ties<>1 then
    select id into off_id from public.tactical_choices where round_id=r.id and role='offense' and is_default;
    fallbacks:=array_append(fallbacks,'offense');
  else
    select choice_id into off_id from public.tactical_votes where round_id=r.id and role='offense' group by choice_id order by count(*) desc limit 1;
  end if;
  if def_top is null or def_ties<>1 then
    select id into def_id from public.tactical_choices where round_id=r.id and role='defense' and is_default;
    fallbacks:=array_append(fallbacks,'defense');
  else
    select choice_id into def_id from public.tactical_votes where round_id=r.id and role='defense' group by choice_id order by count(*) desc limit 1;
  end if;
  if off_id is null or def_id is null then raise exception 'both roles need a default choice'; end if;
  insert into public.tactical_resolutions(round_id,offense_choice_id,defense_choice_id,vote_counts,fallback_roles)
  values(r.id,off_id,def_id,counts,fallbacks) on conflict(round_id) do nothing;
  update public.tactical_rounds set status='resolved' where id=r.id;
  return (select jsonb_build_object('round_id',round_id,'offense_choice_id',offense_choice_id,'defense_choice_id',defense_choice_id,'vote_counts',vote_counts,'fallback_roles',fallback_roles) from public.tactical_resolutions where round_id=r.id);
end $$;

revoke all on function public.sync_my_profile(text,text) from public;
revoke all on function public.join_fanball_game(uuid) from public;
revoke all on function public.submit_tactical_vote(uuid,uuid) from public;
revoke all on function public.open_tactical_round(uuid,integer,jsonb,text,text,jsonb) from public;
revoke all on function public.resolve_tactical_round(uuid) from public;
grant execute on function public.sync_my_profile(text,text) to authenticated;
grant execute on function public.join_fanball_game(uuid) to authenticated;
grant execute on function public.submit_tactical_vote(uuid,uuid) to authenticated;
grant execute on function public.open_tactical_round(uuid,integer,jsonb,text,text,jsonb) to service_role;
grant execute on function public.resolve_tactical_round(uuid) to service_role;

-- Enable realtime updates where the Supabase publication is available.
do $$
declare table_name text;
begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    foreach table_name in array array['tactical_rounds','tactical_resolutions'] loop
      if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=table_name) then
        execute format('alter publication supabase_realtime add table public.%I',table_name);
      end if;
    end loop;
  end if;
end $$;
