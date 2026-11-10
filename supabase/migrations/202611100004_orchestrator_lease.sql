-- Keep pitches on a steady 2-second beat (docs/PITCH_ENGINE_DESIGN.md).
-- One orchestrator-tick call now stays awake for up to about a minute and throws the next pitch
-- itself when it is due. While it does, it holds a short lease (dispatched_at in the future) so
-- Cron does not start a second call for the same game. If the call dies, the lease runs out and
-- Cron takes over again (orchestrator_dispatch retries 5 seconds after dispatched_at).
create or replace function public.set_orchestrator_lease(p_game_id uuid, p_until timestamptz)
returns void language sql security definer set search_path=public as $$
  update public.fanball_game_private set dispatched_at = p_until where game_id = p_game_id;
$$;
revoke all on function public.set_orchestrator_lease(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.set_orchestrator_lease(uuid, timestamptz) to service_role;

-- Dispatch only games nobody is working on. A game counts as taken while its lease
-- (dispatched_at) is in the future or was set less than 5 seconds ago and its step has not moved on.
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
    where f.id = p.game_id and f.status = 'running' and p.next_action is not null and p.next_action_at <= now()
      and (p.dispatched_at is null or p.dispatched_at < p.next_action_at or p.dispatched_at < now() - interval '5 seconds');
  perform net.http_post(
    url := fn_url,
    headers := jsonb_build_object('apikey', fn_key, 'content-type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000);
  return true;
end $$;
revoke all on function public.orchestrator_dispatch() from public, anon, authenticated;
