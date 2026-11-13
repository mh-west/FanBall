-- Tactic score (2026-11-13, user decisions; rules score-1, docs/TACTIC_SCORE_DESIGN.md).
-- For every key tactical vote (before the at-bat, two strikes, three balls) the orchestrator stores, per choice,
-- its expected run value (ev) and the average of the choices offered to that role (ev_avg), and for the choices that
-- lost the vote the run value of the same plate appearance replayed with them (value). When the real plate appearance
-- ends, the applied choices get the real value and every voter's points are fixed:
--   outcome  = 10 x max(0, value)          (offense) / 10 x max(0, -value)          (defense)
--   decision = 40 x max(0, ev - ev_avg)    (offense) / 40 x max(0, ev_avg - ev)     (defense)
-- Points only add. The ranking counts games opened by the admin only (not friend rooms; AI matches never reach the
-- server). Replays never touch the game's own records.

create table if not exists public.tactic_round_outcomes (
  round_id uuid not null references public.tactical_rounds(id) on delete cascade,
  game_id uuid not null references public.fanball_games(id) on delete cascade,
  role text not null check (role in ('offense', 'defense')),
  choice_key text not null,
  applied boolean not null default false,
  ev numeric not null,
  ev_avg numeric not null,
  value numeric,
  result_kind text,
  result_detail text,
  runs integer,
  primary key (round_id, role, choice_key)
);
alter table public.tactic_round_outcomes enable row level security;
revoke all on public.tactic_round_outcomes from public, anon, authenticated;
grant all on public.tactic_round_outcomes to service_role;

create table if not exists public.tactic_scores (
  round_id uuid not null references public.tactical_rounds(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  game_id uuid not null references public.fanball_games(id) on delete cascade,
  pa_no integer,
  phase text,
  role text not null,
  choice_key text not null,
  choice_label text,
  applied boolean not null,
  outcome_points numeric(8, 2) not null,
  decision_points numeric(8, 2) not null,
  points numeric(8, 2) not null,
  result_kind text,
  result_detail text,
  ranked boolean not null,
  rules text not null default 'score-1',
  created_at timestamptz not null default now(),
  primary key (round_id, user_id)
);
create index if not exists tactic_scores_user on public.tactic_scores(user_id, ranked);
create index if not exists tactic_scores_game on public.tactic_scores(game_id, user_id);
alter table public.tactic_scores enable row level security;
revoke all on public.tactic_scores from public, anon, authenticated;
grant all on public.tactic_scores to service_role;

-- The orchestrator stores a vote's choices (p_rows: [{role, choice_key, applied, ev, ev_avg, value, result_kind,
-- result_detail, runs}], value null for the applied choices).
create or replace function public.record_round_outcomes(p_round_id uuid, p_rows jsonb)
returns void language plpgsql security definer set search_path=public as $$
begin
  insert into public.tactic_round_outcomes(round_id, game_id, role, choice_key, applied, ev, ev_avg, value, result_kind, result_detail, runs)
  select p_round_id, r.game_id, x->>'role', x->>'choice_key', coalesce((x->>'applied')::boolean, false),
         (x->>'ev')::numeric, (x->>'ev_avg')::numeric, nullif(x->>'value', '')::numeric, x->>'result_kind', x->>'result_detail', nullif(x->>'runs', '')::integer
  from public.tactical_rounds r, jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x
  where r.id = p_round_id
  on conflict (round_id, role, choice_key) do update set applied = excluded.applied, ev = excluded.ev, ev_avg = excluded.ev_avg,
    value = coalesce(public.tactic_round_outcomes.value, excluded.value), result_kind = coalesce(public.tactic_round_outcomes.result_kind, excluded.result_kind),
    result_detail = coalesce(public.tactic_round_outcomes.result_detail, excluded.result_detail), runs = coalesce(public.tactic_round_outcomes.runs, excluded.runs);
end $$;

-- The real plate appearance of a vote has ended: the applied choices get its value, and every voter's points are
-- fixed (once).
create or replace function public.settle_round_scores(p_round_id uuid, p_value numeric, p_kind text, p_detail text, p_runs integer)
returns integer language plpgsql security definer set search_path=public as $$
declare n integer;
begin
  update public.tactic_round_outcomes set value = p_value, result_kind = p_kind, result_detail = p_detail, runs = p_runs
    where round_id = p_round_id and applied and value is null;
  insert into public.tactic_scores(round_id, user_id, game_id, pa_no, phase, role, choice_key, choice_label, applied,
    outcome_points, decision_points, points, result_kind, result_detail, ranked, rules)
  select r.id, v.user_id, r.game_id, r.pa_no, r.phase, c.role, c.choice_key, c.label, o.applied,
         s.outcome, s.decision, s.outcome + s.decision, o.result_kind, o.result_detail, k.provider <> 'room', 'score-1'
  from public.tactical_rounds r
  join public.tactical_votes v on v.round_id = r.id
  join public.tactical_choices c on c.id = v.choice_id
  join public.tactic_round_outcomes o on o.round_id = r.id and o.role = c.role and o.choice_key = c.choice_key
  join public.fanball_games f on f.id = r.game_id
  join public.kbo_games k on k.id = f.kbo_game_id
  cross join lateral (select
      round(10 * greatest(0, case when c.role = 'offense' then o.value else -o.value end), 2) as outcome,
      round(40 * greatest(0, case when c.role = 'offense' then o.ev - o.ev_avg else o.ev_avg - o.ev end), 2) as decision) s
  where r.id = p_round_id and o.value is not null
  on conflict (round_id, user_id) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.record_round_outcomes(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_round_outcomes(uuid, jsonb) to service_role;
revoke all on function public.settle_round_scores(uuid, numeric, text, text, integer) from public, anon, authenticated;
grant execute on function public.settle_round_scores(uuid, numeric, text, text, integer) to service_role;

-- My points in one game: total, votes, votes that scored, and each vote.
create or replace function public.my_tactic_scores(p_game_id uuid)
returns jsonb language sql stable security definer set search_path=public as $$
  select jsonb_build_object(
    'total', coalesce(sum(points), 0), 'votes', count(*), 'scored', count(*) filter (where points > 0),
    'ranked', coalesce(bool_or(ranked), false),
    'rows', coalesce(jsonb_agg(jsonb_build_object('round_id', round_id, 'pa_no', pa_no, 'phase', phase, 'role', role, 'choice', choice_label,
      'applied', applied, 'outcome', outcome_points, 'decision', decision_points, 'points', points, 'result_kind', result_kind,
      'result_detail', result_detail, 'at', created_at) order by pa_no, created_at), '[]'::jsonb))
  from public.tactic_scores where game_id = p_game_id and user_id = auth.uid();
$$;
revoke all on function public.my_tactic_scores(uuid) from public, anon;
grant execute on function public.my_tactic_scores(uuid) to authenticated;

-- In a friend room: everyone's points in this game (for the room's own standings; not part of the ranking).
create or replace function public.game_tactic_standings(p_game_id uuid)
returns jsonb language sql stable security definer set search_path=public as $$
  select coalesce(jsonb_agg(x order by (x->>'total')::numeric desc), '[]'::jsonb) from (
    select jsonb_build_object('nickname', coalesce(nullif(p.nickname, ''), '팬'), 'mine', s.user_id = auth.uid(),
      'total', sum(s.points), 'votes', count(*)) x
    from public.tactic_scores s left join public.profiles p on p.user_id = s.user_id
    where s.game_id = p_game_id
      and exists (select 1 from public.tactic_scores me where me.game_id = p_game_id and me.user_id = auth.uid()
                  union select 1 from public.friend_rooms fr join public.room_members m on m.code = fr.code where fr.game_id = p_game_id and m.user_id = auth.uid())
    group by s.user_id, p.nickname) t;
$$;
revoke all on function public.game_tactic_standings(uuid) from public, anon;
grant execute on function public.game_tactic_standings(uuid) to authenticated;

-- The tactic ranking: admin-opened games only. Average per vote is ranked only from 20 votes.
create or replace function public.tactic_ranking(p_limit integer default 20)
returns jsonb language sql stable security definer set search_path=public as $$
  with t as (
    select s.user_id, coalesce(nullif(p.nickname, ''), '팬') nickname, sum(s.points) total, count(*) votes,
           count(*) filter (where s.points > 0) scored, round(avg(s.points), 2) avg_points
    from public.tactic_scores s left join public.profiles p on p.user_id = s.user_id
    where s.ranked group by s.user_id, p.nickname
  ), ranked as (select *, rank() over (order by total desc) rnk from t)
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(jsonb_build_object('rank', rnk, 'nickname', nickname, 'total', total, 'votes', votes, 'scored', scored,
        'avg', avg_points, 'mine', user_id = auth.uid()) order by rnk) from (select * from ranked order by rnk limit greatest(1, least(coalesce(p_limit, 20), 100))) q), '[]'::jsonb),
    'me', (select jsonb_build_object('rank', rnk, 'total', total, 'votes', votes, 'scored', scored, 'avg', avg_points) from ranked where user_id = auth.uid()),
    'players', (select count(*) from t));
$$;
revoke all on function public.tactic_ranking(integer) from public;
grant execute on function public.tactic_ranking(integer) to anon, authenticated;
