-- Orchestrator scheduling (docs/ORCHESTRATOR_DESIGN.md, stage 3).
-- Every second, Cron runs a cheap SQL check. Only when a game has a step due does it call the
-- orchestrator-tick Edge Function once (pg_net). The function URL and the Secret key it sends
-- are read from Supabase Vault, which the project owner fills in; they are never in this file.

alter table public.fanball_game_private add column if not exists dispatched_at timestamptz;

-- Everything the tick function needs for one game, in one read. Server only.
create or replace function public.get_orchestrator_game(p_game_id uuid)
returns jsonb language sql security definer set search_path=public stable as $$
  select jsonb_build_object(
    'game_id', f.id, 'status', f.status, 'away_team_id', k.away_team_id, 'home_team_id', k.home_team_id,
    'lineup_snapshot', f.lineup_snapshot, 'seed', p.seed, 'engine_state', p.engine_state,
    'next_action', p.next_action, 'next_action_at', p.next_action_at,
    'current_round_id', p.current_round_id, 'state_version', p.state_version,
    'round', (select jsonb_build_object('status', r.status, 'closes_at', r.closes_at) from public.tactical_rounds r where r.id = p.current_round_id),
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

-- Called by Cron every second. Returns true when it asked the tick function to run.
-- A game is dispatched again only after its step moved on, or after 5 seconds without progress
-- (so a failed call is retried, but one slow call does not get a second call on top of it).
create or replace function public.orchestrator_dispatch()
returns boolean language plpgsql security definer set search_path=public as $$
declare fn_url text; fn_key text; has_work boolean;
begin
  select
    exists(select 1 from public.fanball_games f join public.kbo_games k on k.id = f.kbo_game_id
           where f.status = 'scheduled' and k.scheduled_at <= now() and k.status not in ('postponed','cancelled') and f.lineup_snapshot is not null)
    or exists(select 1 from public.fanball_game_private p join public.fanball_games f on f.id = p.game_id
           where f.status = 'running' and p.next_action is not null and p.next_action_at <= now()
             and (p.dispatched_at is null or p.dispatched_at < p.next_action_at or p.dispatched_at < now() - interval '5 seconds'))
  into has_work;
  if not has_work then return false; end if;
  select decrypted_secret into fn_url from vault.decrypted_secrets where name = 'fanball_orchestrator_url';
  select decrypted_secret into fn_key from vault.decrypted_secrets where name = 'fanball_orchestrator_key';
  if fn_url is null or fn_key is null then return false; end if;
  update public.fanball_game_private p set dispatched_at = now()
    from public.fanball_games f
    where f.id = p.game_id and f.status = 'running' and p.next_action is not null and p.next_action_at <= now();
  perform net.http_post(
    url := fn_url,
    headers := jsonb_build_object('apikey', fn_key, 'content-type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000);
  return true;
end $$;

revoke all on function public.get_orchestrator_game(uuid) from public, anon, authenticated;
revoke all on function public.orchestrator_dispatch() from public, anon, authenticated;
grant execute on function public.get_orchestrator_game(uuid) to service_role;

-- Schedule the dispatcher where pg_cron and pg_net exist (Supabase). Local test databases skip this.
do $$
begin
  if exists(select 1 from pg_available_extensions where name = 'pg_cron')
     and exists(select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net with schema extensions;
    perform cron.schedule('fanball-orchestrator', '1 seconds', 'select public.orchestrator_dispatch()');
    -- A per-second job writes one history row per run; keep only the last day.
    perform cron.schedule('fanball-cron-history-cleanup', '17 * * * *',
      $job$delete from cron.job_run_details where end_time < now() - interval '1 day'$job$);
  end if;
end $$;
