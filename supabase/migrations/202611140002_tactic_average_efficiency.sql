-- Rank tactical voters by average points per vote and report decision efficiency separately.
-- Efficiency is awarded decision points divided by the best attainable decision points for those votes.

create or replace function public.my_tactic_scores(p_game_id uuid)
returns jsonb language sql stable security definer set search_path=public as $$
  with mine as (
    select s.*, coalesce((select round(40 * max(greatest(0, case when s.role = 'offense' then o.ev - o.ev_avg else o.ev_avg - o.ev end)), 2)
      from public.tactic_round_outcomes o where o.round_id = s.round_id and o.role = s.role), 0) possible_decision
    from public.tactic_scores s where s.game_id = p_game_id and s.user_id = auth.uid()
  )
  select jsonb_build_object(
    'total', coalesce(sum(points), 0), 'votes', count(*), 'scored', count(*) filter (where points > 0),
    'avg', coalesce(round(avg(points), 2), 0),
    'efficiency', case when sum(possible_decision) > 0 then round(100 * sum(decision_points) / sum(possible_decision), 1) else null end,
    'ranked', coalesce(bool_or(ranked), false),
    'rows', coalesce(jsonb_agg(jsonb_build_object('round_id', round_id, 'pa_no', pa_no, 'phase', phase, 'role', role, 'choice', choice_label,
      'applied', applied, 'outcome', outcome_points, 'decision', decision_points, 'possible_decision', possible_decision, 'points', points, 'result_kind', result_kind,
      'result_detail', result_detail, 'at', created_at) order by pa_no, created_at), '[]'::jsonb))
  from mine;
$$;

create or replace function public.game_tactic_standings(p_game_id uuid)
returns jsonb language sql stable security definer set search_path=public as $$
  with scored as (
    select s.*, coalesce((select round(40 * max(greatest(0, case when s.role = 'offense' then o.ev - o.ev_avg else o.ev_avg - o.ev end)), 2)
      from public.tactic_round_outcomes o where o.round_id = s.round_id and o.role = s.role), 0) possible_decision
    from public.tactic_scores s where s.game_id = p_game_id
      and exists (select 1 from public.tactic_scores me where me.game_id = p_game_id and me.user_id = auth.uid()
                  union select 1 from public.friend_rooms fr join public.room_members m on m.code = fr.code where fr.game_id = p_game_id and m.user_id = auth.uid())
  ), people as (
    select s.user_id, coalesce(nullif(p.nickname, ''), '팬') nickname, sum(s.points) total, count(*) votes,
      round(avg(s.points), 2) avg, case when sum(s.possible_decision) > 0 then round(100 * sum(s.decision_points) / sum(s.possible_decision), 1) else null end efficiency,
      bool_or(s.user_id = auth.uid()) mine
    from scored s left join public.profiles p on p.user_id = s.user_id group by s.user_id, p.nickname
  )
  select coalesce(jsonb_agg(jsonb_build_object('nickname', nickname, 'mine', mine, 'total', total, 'votes', votes, 'avg', avg, 'efficiency', efficiency)
    order by avg desc, user_id), '[]'::jsonb) from people;
$$;

create or replace function public.tactic_ranking(p_limit integer default 20)
returns jsonb language sql stable security definer set search_path=public as $$
  with scored as (
    select s.*, coalesce((select round(40 * max(greatest(0, case when s.role = 'offense' then o.ev - o.ev_avg else o.ev_avg - o.ev end)), 2)
      from public.tactic_round_outcomes o where o.round_id = s.round_id and o.role = s.role), 0) possible_decision
    from public.tactic_scores s where s.ranked
  ), people as (
    select s.user_id, coalesce(nullif(p.nickname, ''), '팬') nickname, sum(s.points) total, count(*) votes,
      count(*) filter (where s.points > 0) scored, round(avg(s.points), 2) avg_points,
      case when sum(s.possible_decision) > 0 then round(100 * sum(s.decision_points) / sum(s.possible_decision), 1) else null end efficiency
    from scored s left join public.profiles p on p.user_id = s.user_id group by s.user_id, p.nickname
  ), ranked as (
    select *, rank() over (order by avg_points desc) rnk from people where votes >= 20
  )
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(jsonb_build_object('rank', rnk, 'nickname', nickname, 'total', total, 'votes', votes, 'scored', scored,
        'avg', avg_points, 'efficiency', efficiency, 'mine', user_id = auth.uid()) order by rnk) from (select * from ranked order by avg_points desc, efficiency desc nulls last limit greatest(1, least(coalesce(p_limit, 20), 100))) q), '[]'::jsonb),
    'me', (select jsonb_build_object('rank', rnk, 'total', total, 'votes', votes, 'scored', scored, 'avg', avg_points, 'efficiency', efficiency) from ranked where user_id = auth.uid()),
    'players', (select count(*) from ranked));
$$;

revoke all on function public.my_tactic_scores(uuid) from public, anon;
grant execute on function public.my_tactic_scores(uuid) to authenticated;
revoke all on function public.game_tactic_standings(uuid) from public, anon;
grant execute on function public.game_tactic_standings(uuid) to authenticated;
revoke all on function public.tactic_ranking(integer) from public;
grant execute on function public.tactic_ranking(integer) to anon, authenticated;
