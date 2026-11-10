-- Pitch-by-pitch engine support (docs/PITCH_ENGINE_DESIGN.md, stage 2).
-- Every pitch is saved and shown as soon as it is thrown, a plate appearance can have votes
-- before it starts and at two strikes / three balls, and votes last 12 seconds.

-- Several vote rounds per plate appearance, one per phase.
alter table public.tactical_rounds add column if not exists phase text not null default 'pre_pa';
alter table public.tactical_rounds drop constraint if exists tactical_rounds_phase_check;
alter table public.tactical_rounds add constraint tactical_rounds_phase_check check (phase in ('pre_pa','two_strikes','three_balls'));
alter table public.tactical_rounds drop constraint if exists tactical_rounds_game_id_pa_no_key;
alter table public.tactical_rounds drop constraint if exists tactical_rounds_game_id_pa_no_phase_key;
alter table public.tactical_rounds add constraint tactical_rounds_game_id_pa_no_phase_key unique (game_id, pa_no, phase);

-- Open a round for one phase of a plate appearance. Same arguments as before plus the phase and
-- the window length (12 seconds by default), so existing callers keep working.
drop function if exists public.open_tactical_round(uuid,integer,jsonb,text,text,jsonb);
create or replace function public.open_tactical_round(
  p_game_id uuid, p_pa_no integer, p_state_snapshot jsonb, p_offense_team_id text, p_defense_team_id text, p_choices jsonb,
  p_phase text default 'pre_pa', p_seconds integer default 12
) returns public.tactical_rounds language plpgsql security definer set search_path=public as $$
declare r public.tactical_rounds; item jsonb; opened timestamptz:=clock_timestamp();
begin
  if p_seconds not between 5 and 60 then raise exception 'vote window must be 5 to 60 seconds'; end if;
  if not exists(select 1 from public.fanball_games where id=p_game_id and status='running') then raise exception 'game is not running'; end if;
  insert into public.tactical_rounds(game_id,pa_no,phase,state_snapshot,offense_team_id,defense_team_id,opens_at,closes_at)
  values(p_game_id,p_pa_no,coalesce(p_phase,'pre_pa'),coalesce(p_state_snapshot,'{}'::jsonb),p_offense_team_id,p_defense_team_id,opened,opened+make_interval(secs=>p_seconds))
  on conflict(game_id,pa_no,phase) do nothing;
  select * into r from public.tactical_rounds where game_id=p_game_id and pa_no=p_pa_no and phase=coalesce(p_phase,'pre_pa') for update;
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
revoke all on function public.open_tactical_round(uuid,integer,jsonb,text,text,jsonb,text,integer) from public, anon, authenticated;
grant execute on function public.open_tactical_round(uuid,integer,jsonb,text,text,jsonb,text,integer) to service_role;

-- The orchestrator's next step can now be a single pitch.
alter table public.fanball_game_private drop constraint if exists fanball_game_private_next_action_check;
alter table public.fanball_game_private add constraint fanball_game_private_next_action_check
  check (next_action in ('pitch','play_pa','open_round','resolve_round','finish'));

-- Every pitch, public as soon as it is thrown (the next pitch does not exist yet).
create table if not exists public.pitches (
  game_id uuid not null references public.fanball_games(id) on delete cascade,
  pitch_no integer not null check (pitch_no > 0),
  pa_no integer not null check (pa_no > 0),
  count_before text not null check (count_before ~ '^[0-3]-[0-2]$'),
  call text not null check (call in ('ball','strike','foul','inplay','hbp','ibb')),
  result text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (game_id, pitch_no)
);
create index if not exists pitches_game_pa_idx on public.pitches(game_id, pa_no);
alter table public.pitches enable row level security;
revoke all on public.pitches from public, anon, authenticated;
grant select on public.pitches to anon, authenticated;
grant all on public.pitches to service_role;
drop policy if exists "pitches_public_read" on public.pitches;
create policy "pitches_public_read" on public.pitches for select to anon, authenticated using (true);
drop trigger if exists pitches_append_only on public.pitches;
create trigger pitches_append_only before update or delete on public.pitches
  for each row execute function public.forbid_record_change();

-- Save one step. p_pitch (new, optional): {pitch_no, pa_no, count_before, call, result, payload}.
drop function if exists public.commit_orchestrator_step(uuid,integer,jsonb,text,timestamptz,uuid,jsonb,jsonb,boolean,text);
create or replace function public.commit_orchestrator_step(
  p_game_id uuid, p_expected_version integer, p_engine_state jsonb,
  p_next_action text, p_next_action_at timestamptz, p_current_round_id uuid,
  p_score jsonb, p_pa jsonb, p_finish boolean, p_model_version text, p_pitch jsonb default null
) returns boolean language plpgsql security definer set search_path=public as $$
declare priv public.fanball_game_private;
begin
  select * into priv from public.fanball_game_private where game_id = p_game_id for update;
  if not found then raise exception 'game has not started'; end if;
  if priv.state_version <> p_expected_version then return false; end if;
  if not exists(select 1 from public.fanball_games where id = p_game_id and status = 'running') then
    raise exception 'game is not running';
  end if;
  if p_pitch is not null then
    insert into public.pitches(game_id, pitch_no, pa_no, count_before, call, result, payload)
    values (p_game_id, (p_pitch->>'pitch_no')::integer, (p_pitch->>'pa_no')::integer, p_pitch->>'count_before',
            p_pitch->>'call', p_pitch->>'result', coalesce(p_pitch->'payload', '{}'::jsonb));
  end if;
  if p_pa is not null then
    insert into public.plate_appearances(game_id, pa_no, round_id, outcome, runs, result_payload, reveal_at)
    values (p_game_id, (p_pa->>'pa_no')::integer, nullif(p_pa->>'round_id','')::uuid, p_pa->>'outcome',
            coalesce((p_pa->>'runs')::integer, 0), coalesce(p_pa->'payload', '{}'::jsonb),
            coalesce((p_pa->>'reveal_at')::timestamptz, now()));
  end if;
  update public.fanball_game_private
    set engine_state = coalesce(p_engine_state, engine_state),
        next_action = case when p_finish then null else p_next_action end,
        next_action_at = case when p_finish then null else p_next_action_at end,
        current_round_id = p_current_round_id,
        state_version = state_version + 1, updated_at = now()
    where game_id = p_game_id;
  update public.fanball_games
    set score = coalesce(p_score, score),
        model_version = coalesce(model_version, p_model_version),
        status = case when p_finish then 'final' else status end,
        ended_at = case when p_finish then now() else ended_at end,
        revealed_seed = case when p_finish then priv.seed else revealed_seed end
    where id = p_game_id;
  return true;
end $$;
revoke all on function public.commit_orchestrator_step(uuid,integer,jsonb,text,timestamptz,uuid,jsonb,jsonb,boolean,text,jsonb) from public, anon, authenticated;
grant execute on function public.commit_orchestrator_step(uuid,integer,jsonb,text,timestamptz,uuid,jsonb,jsonb,boolean,text,jsonb) to service_role;

-- The tick also needs the current round's phase.
create or replace function public.get_orchestrator_game(p_game_id uuid)
returns jsonb language sql security definer set search_path=public stable as $$
  select jsonb_build_object(
    'game_id', f.id, 'status', f.status, 'away_team_id', k.away_team_id, 'home_team_id', k.home_team_id,
    'lineup_snapshot', f.lineup_snapshot, 'seed', p.seed, 'engine_state', p.engine_state, 'model_version', f.model_version,
    'next_action', p.next_action, 'next_action_at', p.next_action_at,
    'current_round_id', p.current_round_id, 'state_version', p.state_version,
    'round', (select jsonb_build_object('status', r.status, 'closes_at', r.closes_at, 'phase', r.phase, 'pa_no', r.pa_no) from public.tactical_rounds r where r.id = p.current_round_id),
    'resolution', (select jsonb_build_object(
        'offense', (select c.choice_key from public.tactical_choices c where c.id = res.offense_choice_id),
        'defense', (select c.choice_key from public.tactical_choices c where c.id = res.defense_choice_id),
        'fallback_roles', res.fallback_roles)
      from public.tactical_resolutions res where res.round_id = p.current_round_id))
  from public.fanball_games f
  join public.kbo_games k on k.id = f.kbo_game_id
  join public.fanball_game_private p on p.game_id = f.id
  where f.id = p_game_id;
$$;
revoke all on function public.get_orchestrator_game(uuid) from public, anon, authenticated;
grant execute on function public.get_orchestrator_game(uuid) to service_role;

-- Live screens subscribe to pitches, plate appearances and the game row.
do $$
declare t text;
begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    foreach t in array array['pitches','plate_appearances','fanball_games'] loop
      if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;
