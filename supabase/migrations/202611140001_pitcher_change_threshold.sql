-- Lower the pitcher-change vote threshold 80% -> 70% (user request 2026-11-14). Small groups already scale
-- sensibly through the ceiling in dist/server-game.js and supabase/functions/_shared/orchestrator.js
-- (Math.max(1, Math.ceil(members * threshold))), so only the threshold itself needs to change here; those two
-- files read it from this function's 'threshold' field (or fall back to a literal, also updated to match).
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
    'threshold',0.7
  ) into result;
  return result;
end $$;
