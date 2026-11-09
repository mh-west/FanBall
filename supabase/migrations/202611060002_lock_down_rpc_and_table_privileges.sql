-- Supabase grants new public objects to anon/authenticated through default privileges on many projects.
-- `revoke ... from public` does not remove those direct grants, so revoke them by role here.
-- Round opening and resolving must stay limited to trusted server code.

revoke all on function public.open_tactical_round(uuid,integer,jsonb,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.resolve_tactical_round(uuid) from public,anon,authenticated;
grant execute on function public.open_tactical_round(uuid,integer,jsonb,text,text,jsonb) to service_role;
grant execute on function public.resolve_tactical_round(uuid) to service_role;

revoke all on function public.sync_my_profile(text,text) from public,anon;
revoke all on function public.join_fanball_game(uuid) from public,anon;
revoke all on function public.submit_tactical_vote(uuid,uuid) from public,anon;
grant execute on function public.sync_my_profile(text,text) to authenticated;
grant execute on function public.join_fanball_game(uuid) to authenticated;
grant execute on function public.submit_tactical_vote(uuid,uuid) to authenticated;

-- The earlier migration revoked only insert/update/delete. Remove truncate, references, trigger and maintain too.
revoke all on public.profiles,public.kbo_games,public.fanball_games,public.fanball_game_memberships,
  public.tactical_rounds,public.tactical_choices,public.tactical_votes,public.tactical_resolutions,
  public.plate_appearances from anon,authenticated;
grant select on public.kbo_games,public.fanball_games,public.tactical_rounds,public.tactical_choices,
  public.tactical_resolutions,public.plate_appearances to anon,authenticated;
grant select on public.profiles,public.fanball_game_memberships,public.tactical_votes to authenticated;
