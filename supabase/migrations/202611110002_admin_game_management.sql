-- Admin game management (2026-11-11): admins schedule, reschedule and delete FanBall games from the site.
-- Every function checks public.is_admin() on the server, so a browser flag alone cannot use them.
-- Games made here are test games (provider 'demo'), not KBO schedule data.
-- Official records stay untouchable: a running game cannot be deleted, and a finished game can be
-- deleted only when it is a demo game.

create or replace function public.admin_schedule_fanball_game(
  p_away_team_id text, p_home_team_id text, p_scheduled_at timestamptz, p_lineup_snapshot jsonb)
returns uuid language plpgsql security definer set search_path=public as $$
declare kbo_id text; new_id uuid; side text;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  if p_away_team_id is null or p_home_team_id is null or p_away_team_id = p_home_team_id then
    raise exception 'pick two different teams';
  end if;
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
    p_away_team_id, p_lineup_snapshot->'teams'->p_away_team_id,
    p_home_team_id, p_lineup_snapshot->'teams'->p_home_team_id)))
  returning id into new_id;
  return new_id;
end $$;

create or replace function public.admin_reschedule_fanball_game(p_game_id uuid, p_scheduled_at timestamptz)
returns void language plpgsql security definer set search_path=public as $$
declare g record;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  select f.status, f.kbo_game_id into g from public.fanball_games f where f.id = p_game_id for update;
  if not found then raise exception 'game not found'; end if;
  if g.status <> 'scheduled' then raise exception 'only a game that has not started can be rescheduled'; end if;
  if p_scheduled_at is null or p_scheduled_at < now() then raise exception 'start time must be in the future'; end if;
  if p_scheduled_at > now() + interval '60 days' then raise exception 'start time must be within 60 days'; end if;
  update public.kbo_games
    set scheduled_at = p_scheduled_at, game_date = (p_scheduled_at at time zone 'Asia/Seoul')::date, updated_at = now()
    where id = g.kbo_game_id;
end $$;

create or replace function public.admin_delete_fanball_game(p_game_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare g record;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  select f.status, f.kbo_game_id, k.provider into g
    from public.fanball_games f join public.kbo_games k on k.id = f.kbo_game_id where f.id = p_game_id for update of f;
  if not found then raise exception 'game not found'; end if;
  if g.status = 'running' then raise exception 'a running game cannot be deleted'; end if;
  if g.status = 'final' and g.provider <> 'demo' then raise exception 'official game records cannot be deleted'; end if;
  -- Rounds, votes, plate appearances, pitches, lineups and the private row go with the game (on delete cascade).
  delete from public.fanball_games where id = p_game_id;
  -- Demo schedule rows exist only for this game; real KBO schedule rows stay.
  if g.provider = 'demo' then delete from public.kbo_games where id = g.kbo_game_id; end if;
end $$;

revoke all on function public.admin_schedule_fanball_game(text, text, timestamptz, jsonb) from public, anon;
revoke all on function public.admin_reschedule_fanball_game(uuid, timestamptz) from public, anon;
revoke all on function public.admin_delete_fanball_game(uuid) from public, anon;
grant execute on function public.admin_schedule_fanball_game(text, text, timestamptz, jsonb) to authenticated, service_role;
grant execute on function public.admin_reschedule_fanball_game(uuid, timestamptz) to authenticated, service_role;
grant execute on function public.admin_delete_fanball_game(uuid) to authenticated, service_role;
