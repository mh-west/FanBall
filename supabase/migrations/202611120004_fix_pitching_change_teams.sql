-- Fix (2026-11-12): request_pitching_change from 202611120003 read away_team_id/home_team_id from
-- fanball_games, which has no such columns (they are on kbo_games), so every request failed with
-- 'record "f" has no field "away_team_id"'. Same function, teams read from kbo_games.

create or replace function public.request_pitching_change(
  p_game_id uuid, p_pitcher text, p_on boolean default true, p_next_half boolean default false
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  m public.fanball_game_memberships;
  f public.fanball_games;
  eng_state jsonb;
  current_half text;
  current_inning integer;
  target_half text;
  target_inning integer;
  required_side text;
  away_id text;
  home_id text;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  select * into f from public.fanball_games where id=p_game_id and status='running';
  if not found then raise exception 'game is not running'; end if;
  -- The teams live on the KBO schedule row, not on fanball_games.
  select k.away_team_id, k.home_team_id into away_id, home_id from public.kbo_games k where k.id = f.kbo_game_id;
  select * into m from public.fanball_game_memberships where game_id=p_game_id and user_id=auth.uid();
  if not found or m.team_id is null then raise exception 'join this game before asking'; end if;
  if not p_on then
    delete from public.pitching_change_requests where game_id=p_game_id and user_id=auth.uid();
    return public.pitching_change_status(p_game_id);
  end if;

  select p.engine_state into eng_state from public.fanball_game_private p where p.game_id=p_game_id;
  current_half := eng_state->>'half';
  current_inning := nullif(eng_state->>'inning','')::integer;
  if current_half is null or current_half not in ('away','home') or current_inning is null then raise exception 'game state is not ready'; end if;

  if p_next_half then
    -- Fans request the pitcher for their own side, which is batting now and will field next.
    required_side := public.fanball_side_key(away_id,home_id,current_half);
    target_half := case current_half when 'away' then 'home' else 'away' end;
    target_inning := current_inning + case when current_half='home' then 1 else 0 end;
    if m.team_id <> required_side then raise exception 'join the batting side to reserve its next pitcher'; end if;
    if target_inning > 12 then raise exception 'game has no next half-inning'; end if;
    if current_half='home' and current_inning>=9 and (f.score->>'home')::integer>(f.score->>'away')::integer then
      raise exception 'game has no next half-inning';
    end if;
    insert into public.pitching_change_requests(game_id,user_id,side_key,pitcher,target_inning,target_half)
    values(p_game_id,auth.uid(),m.team_id,null,target_inning,target_half)
    on conflict(game_id,user_id) do update set side_key=excluded.side_key,pitcher=null,
      target_inning=excluded.target_inning,target_half=excluded.target_half,created_at=now();
  else
    if coalesce(btrim(p_pitcher),'')='' then raise exception 'which pitcher'; end if;
    required_side := public.fanball_side_key(away_id,home_id,case current_half when 'away' then 'home' else 'away' end);
    if m.team_id <> required_side then raise exception 'only the fielding side can request a current pitcher change'; end if;
    insert into public.pitching_change_requests(game_id,user_id,side_key,pitcher,target_inning,target_half)
    values(p_game_id,auth.uid(),m.team_id,left(p_pitcher,40),null,null)
    on conflict(game_id,user_id) do update set side_key=excluded.side_key,pitcher=excluded.pitcher,
      target_inning=null,target_half=null,created_at=now();
  end if;
  return public.pitching_change_status(p_game_id);
end $$;

revoke all on function public.request_pitching_change(uuid,text,boolean,boolean) from public,anon;
grant execute on function public.request_pitching_change(uuid,text,boolean,boolean) to authenticated;
