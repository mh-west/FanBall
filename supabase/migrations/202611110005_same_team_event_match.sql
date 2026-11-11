-- Event matches (2026-11-11, user request): an admin may book a team against itself (e.g. KIA vs KIA).
-- Both sides then use the same lineup (one snapshot entry, one fan lineup vote for that team).
-- Only admin test games (provider 'demo') may do this; KBO schedule rows still need two teams.
-- Tactical rounds of such a game have the same offense and defense team: the team's fans vote on the
-- offense side, and the defense keeps its default choice (no one is on the other side).

alter table public.kbo_games drop constraint if exists kbo_games_check;
alter table public.kbo_games add constraint kbo_games_teams_check check (away_team_id <> home_team_id or provider = 'demo');
alter table public.tactical_rounds drop constraint if exists tactical_rounds_check;

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
    p_away_team_id, p_lineup_snapshot->'teams'->p_away_team_id,
    p_home_team_id, p_lineup_snapshot->'teams'->p_home_team_id)))
  returning id into new_id;
  return new_id;
end $$;
