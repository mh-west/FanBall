-- Let fans request a relief pitcher for the start of their next defensive half-inning.
-- Requests are tied to an exact inning/half and only open the reliever vote before that half's
-- first plate appearance. A missed target expires; it cannot carry over to another batter.

alter table public.pitching_change_requests alter column pitcher drop not null;
alter table public.pitching_change_requests add column if not exists target_inning integer;
alter table public.pitching_change_requests add column if not exists target_half text;
alter table public.pitching_change_requests drop constraint if exists pitching_change_requests_target_check;
alter table public.pitching_change_requests add constraint pitching_change_requests_target_check check (
  (target_inning is null and target_half is null) or
  (target_inning is not null and target_half is not null and target_inning > 0 and target_half in ('away','home') and pitcher is null)
);

drop function if exists public.request_pitching_change(uuid,text,boolean);
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
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  select * into f from public.fanball_games where id=p_game_id and status='running';
  if not found then raise exception 'game is not running'; end if;
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
    required_side := public.fanball_side_key(f.away_team_id,f.home_team_id,current_half);
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
    required_side := public.fanball_side_key(f.away_team_id,f.home_team_id,case current_half when 'away' then 'home' else 'away' end);
    if m.team_id <> required_side then raise exception 'only the fielding side can request a current pitcher change'; end if;
    insert into public.pitching_change_requests(game_id,user_id,side_key,pitcher,target_inning,target_half)
    values(p_game_id,auth.uid(),m.team_id,left(p_pitcher,40),null,null)
    on conflict(game_id,user_id) do update set side_key=excluded.side_key,pitcher=excluded.pitcher,
      target_inning=null,target_half=null,created_at=now();
  end if;
  return public.pitching_change_status(p_game_id);
end $$;

create or replace function public.pitching_change_status(p_game_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare current_key integer; result jsonb;
begin
  select nullif(p.engine_state->>'inning','')::integer*2 + case p.engine_state->>'half' when 'home' then 1 else 0 end
    into current_key from public.fanball_game_private p where p.game_id=p_game_id;
  if current_key is not null then
    delete from public.pitching_change_requests r
    using public.fanball_game_private p
    where r.game_id=p_game_id and p.game_id=p_game_id and r.target_inning is not null
      and (r.target_inning*2 + case r.target_half when 'home' then 1 else 0 end < current_key
        or (r.target_inning*2 + case r.target_half when 'home' then 1 else 0 end = current_key
          and coalesce((p.engine_state->>'halfPA')::integer,0)>0));
  end if;
  select jsonb_build_object(
    'sides',coalesce((select jsonb_object_agg(team_id,n) from (
      select team_id,count(*) n from public.fanball_game_memberships
      where game_id=p_game_id and team_id is not null group by team_id
    ) x),'{}'::jsonb),
    'requests',coalesce((select jsonb_agg(jsonb_build_object(
      'side',side_key,'pitcher',pitcher,'target_inning',target_inning,'target_half',target_half,'n',n
    )) from (
      select side_key,pitcher,target_inning,target_half,count(*) n
      from public.pitching_change_requests where game_id=p_game_id
      group by side_key,pitcher,target_inning,target_half
    ) y),'[]'::jsonb),
    'mine',(select jsonb_build_object('pitcher',pitcher,'target_inning',target_inning,'target_half',target_half)
      from public.pitching_change_requests where game_id=p_game_id and user_id=auth.uid()),
    'threshold',0.8
  ) into result;
  return result;
end $$;

revoke all on function public.request_pitching_change(uuid,text,boolean,boolean) from public,anon;
grant execute on function public.request_pitching_change(uuid,text,boolean,boolean) to authenticated;
revoke all on function public.pitching_change_status(uuid) from public;
grant execute on function public.pitching_change_status(uuid) to anon,authenticated,service_role;
