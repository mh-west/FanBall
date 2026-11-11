-- Admins can stop a running test game (2026-11-11, user request): the game is marked cancelled, the
-- orchestrator stops (no next action; the version bump makes any in-flight step fail), and open votes
-- are cancelled. Only admin test games (provider 'demo'); official KBO-schedule games cannot be stopped.
-- A stopped game can then be deleted from the admin page.
-- The forward-only guard gains one exit: running -> cancelled, for test games only.
create or replace function public.guard_fanball_game_status()
returns trigger language plpgsql set search_path=public as $$
begin
  if new.status is distinct from old.status and not (
    (old.status = 'scheduled' and new.status in ('running','cancelled')) or
    (old.status = 'running' and new.status = 'final') or
    (old.status = 'running' and new.status = 'cancelled'
      and exists (select 1 from public.kbo_games k where k.id = new.kbo_game_id and k.provider = 'demo'))
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

create or replace function public.admin_stop_fanball_game(p_game_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare g record;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  select f.status, k.provider into g from public.fanball_games f join public.kbo_games k on k.id = f.kbo_game_id where f.id = p_game_id for update of f;
  if not found then raise exception 'game not found'; end if;
  if g.provider <> 'demo' then raise exception 'official games cannot be stopped'; end if;
  if g.status <> 'running' then raise exception 'only a running game can be stopped'; end if;
  update public.fanball_games set status = 'cancelled', ended_at = now() where id = p_game_id;
  update public.fanball_game_private set next_action = null, next_action_at = null, state_version = state_version + 1, updated_at = now() where game_id = p_game_id;
  update public.tactical_rounds set status = 'cancelled' where game_id = p_game_id and status in ('open', 'closing');
end $$;
revoke all on function public.admin_stop_fanball_game(uuid) from public, anon;
grant execute on function public.admin_stop_fanball_game(uuid) to authenticated, service_role;
