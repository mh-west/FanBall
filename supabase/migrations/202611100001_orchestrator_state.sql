-- Official game orchestrator state (docs/ORCHESTRATOR_DESIGN.md, stage 2).
-- The server advances each running game one step at a time. Engine state, the seed and the
-- next step stay in a server-only table, so nobody can compute results or see them before
-- the clients show them. Recorded plate appearances and vote results cannot be changed.

-- Public game row: what everyone may see.
alter table public.fanball_games
  add column if not exists lineup_snapshot jsonb,
  add column if not exists seed_hash text,
  add column if not exists revealed_seed bigint;
-- The old public seed column was never used; a seed must not be readable while a game runs.
alter table public.fanball_games drop column if exists seed;

-- Server-only runtime row, one per started game.
create table if not exists public.fanball_game_private (
  game_id uuid primary key references public.fanball_games(id) on delete cascade,
  seed bigint not null check(seed between 0 and 4294967295),
  engine_state jsonb not null default '{}'::jsonb,
  next_action text check(next_action in ('play_pa','open_round','resolve_round','finish')),
  next_action_at timestamptz,
  current_round_id uuid references public.tactical_rounds(id),
  state_version integer not null default 1,
  updated_at timestamptz not null default now()
);
create index if not exists fanball_game_private_due_idx on public.fanball_game_private(next_action_at) where next_action is not null;
alter table public.fanball_game_private enable row level security;
revoke all on public.fanball_game_private from public, anon, authenticated;
grant all on public.fanball_game_private to service_role;

-- A plate appearance becomes readable only when clients finish showing its pitches.
alter table public.plate_appearances add column if not exists reveal_at timestamptz not null default now();
drop policy if exists "plate_appearances_public_read" on public.plate_appearances;
create policy "plate_appearances_public_read" on public.plate_appearances for select to anon,authenticated using(reveal_at <= now());

-- Records are append-only. Direct UPDATE/DELETE is refused; deleting a whole game still
-- cascades (that delete comes from the foreign key trigger, one level deeper).
create or replace function public.forbid_record_change()
returns trigger language plpgsql set search_path=public as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;
  raise exception '% records cannot be changed', tg_table_name;
end $$;
drop trigger if exists plate_appearances_append_only on public.plate_appearances;
create trigger plate_appearances_append_only before update or delete on public.plate_appearances
  for each row execute function public.forbid_record_change();
drop trigger if exists tactical_resolutions_append_only on public.tactical_resolutions;
create trigger tactical_resolutions_append_only before update or delete on public.tactical_resolutions
  for each row execute function public.forbid_record_change();

-- A game moves forward only: scheduled -> running -> final. No restart after it began.
create or replace function public.guard_fanball_game_status()
returns trigger language plpgsql set search_path=public as $$
begin
  if new.status is distinct from old.status and not (
    (old.status = 'scheduled' and new.status in ('running','cancelled')) or
    (old.status = 'running' and new.status = 'final')
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
drop trigger if exists fanball_games_forward_only on public.fanball_games;
create trigger fanball_games_forward_only before update on public.fanball_games
  for each row execute function public.guard_fanball_game_status();

-- Start every game whose time has come, exactly once. Returns the started game ids.
-- The seed comes from gen_random_uuid() (random v4 uuid); only its SHA-256 is public until the end.
create or replace function public.start_due_fanball_games()
returns setof uuid language plpgsql security definer set search_path=public as $$
declare g record; new_seed bigint;
begin
  for g in
    select f.id from public.fanball_games f join public.kbo_games k on k.id = f.kbo_game_id
    where f.status = 'scheduled' and k.scheduled_at <= now() and k.status not in ('postponed','cancelled')
      and f.lineup_snapshot is not null
    order by k.scheduled_at
    for update of f skip locked
  loop
    new_seed := ('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint;
    insert into public.fanball_game_private(game_id, seed, next_action, next_action_at)
    values (g.id, new_seed, 'play_pa', now());
    update public.fanball_games
      set status = 'running', started_at = now(),
          seed_hash = encode(sha256(convert_to(new_seed::text, 'UTF8')), 'hex')
      where id = g.id;
    return next g.id;
  end loop;
end $$;

-- Running games whose next step is due. The scheduler calls the tick function only for these.
create or replace function public.due_fanball_games()
returns setof uuid language sql security definer set search_path=public stable as $$
  select p.game_id from public.fanball_game_private p join public.fanball_games f on f.id = p.game_id
  where f.status = 'running' and p.next_action is not null and p.next_action_at <= now()
  order by p.next_action_at;
$$;

-- Save one orchestrator step atomically. Returns false (and changes nothing) when another
-- call already advanced the game. p_pa: {pa_no, outcome, runs, round_id?, reveal_at, payload}.
-- p_score is the score everyone may see now; p_finish ends the game and reveals the seed.
create or replace function public.commit_orchestrator_step(
  p_game_id uuid, p_expected_version integer, p_engine_state jsonb,
  p_next_action text, p_next_action_at timestamptz, p_current_round_id uuid,
  p_score jsonb, p_pa jsonb, p_finish boolean, p_model_version text
) returns boolean language plpgsql security definer set search_path=public as $$
declare priv public.fanball_game_private;
begin
  select * into priv from public.fanball_game_private where game_id = p_game_id for update;
  if not found then raise exception 'game has not started'; end if;
  if priv.state_version <> p_expected_version then return false; end if;
  if not exists(select 1 from public.fanball_games where id = p_game_id and status = 'running') then
    raise exception 'game is not running';
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

revoke all on function public.start_due_fanball_games() from public, anon, authenticated;
revoke all on function public.due_fanball_games() from public, anon, authenticated;
revoke all on function public.commit_orchestrator_step(uuid,integer,jsonb,text,timestamptz,uuid,jsonb,jsonb,boolean,text) from public, anon, authenticated;
revoke all on function public.forbid_record_change() from public, anon, authenticated;
revoke all on function public.guard_fanball_game_status() from public, anon, authenticated;
grant execute on function public.start_due_fanball_games() to service_role;
grant execute on function public.due_fanball_games() to service_role;
grant execute on function public.commit_orchestrator_step(uuid,integer,jsonb,text,timestamptz,uuid,jsonb,jsonb,boolean,text) to service_role;
