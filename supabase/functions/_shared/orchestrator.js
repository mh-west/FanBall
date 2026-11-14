// One orchestrator tick: start due games, then advance every game whose next step is due by
// exactly one step: one pitch, opening a vote, closing a vote, or finishing.
// All reads and writes go through server-only RPCs, so the same code runs in the Edge Function
// (supabase-js) and in local tests (PGlite). See docs/ORCHESTRATOR_DESIGN.md and
// docs/PITCH_ENGINE_DESIGN.md.
import * as engine from './pitch-engine.js';

// Wait a little past the round's close so the database clock has surely passed it.
const RESOLVE_MARGIN_MS = 200;

const iso = ms => new Date(ms).toISOString();
const score = state => ({ away: state.away, home: state.home });
const firstValue = row => (row !== null && typeof row === 'object' ? Object.values(row)[0] : row);

// The engine only needs how many plate appearances happened, not their pitch details (those are
// saved in the pitches and plate_appearances tables), so the stored state stays small.
const compact = state => ({ ...state, plays: state.plays.map(p => ({ paNo: p.paNo, kind: p.kind })) });

// What comes next after a state change: the end of the game, a vote, or another pitch.
function planNext(state, roster) {
  if (state.status === 'final') return 'finish';
  return engine.pendingVote(state, roster) ? 'open_round' : 'pitch';
}

// rpc(name, args) must return the function's result or throw.
export async function runTick(rpc, { now = () => Date.now() } = {}) {
  const started = ((await rpc('start_due_fanball_games')) || []).map(firstValue);
  const due = ((await rpc('due_fanball_games')) || []).map(firstValue);
  const results = [];
  for (const gameId of due) {
    try {
      results.push(await advanceGame(rpc, gameId, { now }));
    } catch (error) {
      // One failing game must not hold up the others; Cron retries it a few seconds later.
      console.error(`orchestrator: game ${gameId} failed`, error);
      results.push({ gameId, error: String(error?.message || error) });
    }
  }
  return { started, results };
}

// Keep working for up to budgetMs: after each round of steps, sleep until the earliest next step
// and do it right on time, so pitches land every PITCH_INTERVAL_MS instead of waiting for the
// next Cron second. While waiting, hold a short lease on each game so Cron does not start a second
// call; release it at the end so Cron can continue at once. Returns every step done.
export async function runLoop(rpc, { budgetMs = 50000, leaseMs = 10000, now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const start = now(), known = new Map(), steps = [];
  const lease = async until => { for (const id of known.keys()) await rpc('set_orchestrator_lease', { p_game_id: id, p_until: iso(until) }); };
  for (;;) {
    const { results } = await runTick(rpc, { now });
    for (const r of results) {
      steps.push(r);
      // Keep following a game only while this call owns its next step.
      if (r.nextAt && (r.committed || r.skipped === 'not due')) known.set(r.gameId, r.nextAt); else known.delete(r.gameId);
    }
    if (!known.size) break;
    const next = Math.min(...known.values());
    if (next - start > budgetMs) break;
    await lease(next + leaseMs);
    // A little past the due time so the database clock agrees it is due. Wake at least every second: a
    // friend-room vote can move a resolve time earlier (202611130004_room_quick_votes.sql).
    await sleep(Math.min(1000, Math.max(0, next - now() + 50)));
  }
  await lease(now());
  return steps;
}

// The id a side is known by in lineups, votes and the engine.
export const sideKey = (awayId, homeId, side) => (side === 'away' ? (awayId === homeId ? `${awayId}@away` : awayId) : homeId);

// Did 80% of the fielding side's fans ask for a current change or a change scheduled for this exact
// half-inning? Scheduled requests are only honored before its first plate appearance.
export const CHANGE_THRESHOLD = 0.7;
async function changeAsked(rpc, gameId, state, roster) {
  if (state.status !== 'running') return null;
  const fieldSide = state.half === 'away' ? 'home' : 'away', sideKey = fieldSide === 'away' ? state.awayId : state.homeId;
  if (state.forcedChange?.[fieldSide] != null) return null;
  const relievers = engine.availableRelievers(state, roster, fieldSide);
  if (!relievers.length) return null;
  const status = await rpc('pitching_change_status', { p_game_id: gameId });
  const members = Number(status?.sides?.[sideKey] || 0), pitcher = engine.currentPitcher(state, roster, fieldSide)?.[0];
  // A side with fans is theirs to manage: no automatic changes, the pitcher tires until they ask (engine 2.12).
  // A side nobody joined keeps the automatic changes.
  state.manual = { ...(state.manual || {}), [fieldSide]: members > 0 };
  const requests=status?.requests||[];
  const currentAsked=requests.filter(r=>r.side===sideKey&&r.pitcher===pitcher&&r.target_inning==null).reduce((n,r)=>n+Number(r.n),0);
  const scheduledAsked=state.halfPA===0
    ? requests.filter(r=>r.side===sideKey&&Number(r.target_inning)===state.inning&&r.target_half===state.half).reduce((n,r)=>n+Number(r.n),0)
    : 0;
  const required=members?Math.ceil(members*CHANGE_THRESHOLD):Infinity;
  if(currentAsked<required&&scheduledAsked<required)return null;
  relievers.sort((a, b) => b.fit - a.fit || (b.k - b.bb) - (a.k - a.bb));
  return { fieldSide, sideKey, relievers, scheduled: scheduledAsked>=required };
}

// Team-wide plans (engine 2.19): each side's most picked batting and pitching plan, read before every pitch
// and vote so a change made during the game applies from the next pitch. A failed read keeps the last plans.
async function readPlans(rpc, gameId, state) {
  try {
    const st = await rpc('team_plan_status', { p_game_id: gameId }), pick = k => st?.sides?.[k] ? { offense: st.sides[k].offense, defense: st.sides[k].defense } : null;
    const away = pick(state.awayId), home = pick(state.homeId);
    if (away || home) state.plans = { ...(state.plans || {}), ...(away ? { away } : {}), ...(home ? { home } : {}) };
  } catch (e) { /* keep the plans already in the state */ }
}

// Tactic score (score-1, docs/TACTIC_SCORE_DESIGN.md). When a key vote closes: every choice's expected run value,
// and for the choices that lost, the run value of the same plate appearance replayed with them. Never stops a game:
// a failure only loses those points.
async function recordOutcomes(rpc, roundId, state, roster, phase, resolution) {
  try {
    const values = engine.ballotValues(state, roster, phase), at = { base: [...state.base], outs: state.outs };
    const applied = { offense: resolution?.offense, defense: resolution?.defense }, rows = [];
    for (const role of ['offense', 'defense']) {
      const avg = role === 'offense' ? values.offenseAvg : values.defenseAvg;
      for (const [key, ev] of Object.entries(values[role])) {
        const row = { role, choice_key: key, applied: key === applied[role], ev, ev_avg: avg, value: null };
        if (!row.applied && applied.offense && applied.defense) {
          const play = engine.counterfactualPA(state, roster, phase, { offense: role === 'offense' ? key : applied.offense, defense: role === 'defense' ? key : applied.defense });
          if (play) Object.assign(row, { value: engine.paValue(play, at), result_kind: play.kind, result_detail: play.detail || null, runs: play.runs });
        }
        rows.push(row);
      }
    }
    await rpc('record_round_outcomes', { p_round_id: roundId, p_rows: rows });
  } catch (e) { console.error('tactic score: outcomes not recorded', roundId, e?.message || e); }
}
// The real plate appearance ended: the applied choices of its votes get its value and the voters' points are fixed.
async function settleScores(rpc, marks, play) {
  for (const [roundId, at] of Object.entries(marks || {})) {
    try { await rpc('settle_round_scores', { p_round_id: roundId, p_value: engine.paValue(play, at), p_kind: play.kind, p_detail: play.detail || null, p_runs: play.runs || 0 }); }
    catch (e) { console.error('tactic score: not settled', roundId, e?.message || e); }
  }
}

export async function advanceGame(rpc, gameId, { now = () => Date.now() } = {}) {
  let g = await rpc('get_orchestrator_game', { p_game_id: gameId });
  if (!g || g.status !== 'running' || !g.next_action) return { gameId, skipped: 'not running' };
  if (Date.parse(g.next_action_at) > now()) return { gameId, skipped: 'not due', nextAt: Date.parse(g.next_action_at) };
  if (g.model_version && g.model_version !== engine.ENGINE_VERSION) return { gameId, skipped: `engine ${g.model_version}` };

  // In an event match (a team against itself) the away side has its own key, '<team>@away', so the two
  // sides keep separate lineups and votes (see migration 202611110006_event_match_sides.sql).
  const roster = g.lineup_snapshot?.teams, awayKey = sideKey(g.away_team_id, g.home_team_id, 'away');
  if (!roster?.[awayKey] || !roster?.[g.home_team_id]) throw new Error('lineup snapshot is missing a team');
  const state = g.engine_state && Object.keys(g.engine_state).length
    ? g.engine_state
    : engine.createGame({ awayId: awayKey, homeId: g.home_team_id, seed: Number(g.seed), roster });

  // Every commit is checked against the version we read; false means another call got there first.
  const commit = async ({ detail = {}, next, nextAt, ...args }) => {
    const ok = await rpc('commit_orchestrator_step', {
      p_game_id: gameId, p_expected_version: g.state_version, p_engine_state: compact(args.state || state),
      p_next_action: next ?? null, p_next_action_at: nextAt ? iso(nextAt) : null, p_current_round_id: args.roundId ?? null,
      p_score: score(args.state || state), p_pa: args.pa ?? null, p_finish: Boolean(args.finish),
      p_model_version: engine.ENGINE_VERSION, p_pitch: args.pitch ?? null,
    });
    return { gameId, action: g.next_action, committed: firstValue(ok) === true, nextAt: args.finish ? null : nextAt ?? null, ...detail };
  };

  // start_due_fanball_games() sets the first step to play_pa (the plate-appearance engine's name).
  let action = g.next_action === 'play_pa' ? 'pitch' : g.next_action;
  // Between plate appearances: if 80% of the fielding side's fans asked to change the pitcher, they vote
  // for the reliever first (engine 2.8). Then any tactical vote, as before.
  const change = (action === 'pitch' || action === 'open_round') && !state.pa ? await changeAsked(rpc, gameId, state, roster) : null;
  if (action === 'pitch' || action === 'open_round') await readPlans(rpc, gameId, state);
  if (change) action = 'open_change';
  // A vote may be due even if the stored step says pitch (for example right after the game starts).
  else if (action === 'pitch' && engine.pendingVote(state, roster)) action = 'open_round';

  switch (action) {
    case 'pitch': {
      const { game, pitch, play } = engine.stepPitch(state, roster);
      const pa = play ? null : game.pa, paNo = play ? play.paNo : pa.no, at = now();
      const next = planNext(game, roster);
      // Clients show each pitch for PITCH_INTERVAL_MS, and a finished plate appearance a little longer;
      // then the next batter is introduced (and the new half-inning announced) before anything else.
      let upNext = play ? engine.nextUp(state, game, roster) : null;
      if (upNext) upNext = { ...upNext, showAfterMs: engine.PITCH_INTERVAL_MS + engine.RESULT_DISPLAY_MS };
      const nextAt = at + engine.PITCH_INTERVAL_MS + (play ? engine.RESULT_DISPLAY_MS + (upNext?.gapMs || 0) : 0);
      const tactics = play ? { offense: play.choice, alignment: play.defenseChoice, approach: play.approach } : { offense: pa.offense, alignment: pa.alignment, approach: pa.approach };
      const last = play ? play.pitches[play.pitches.length - 1] : pa.pitches[pa.pitches.length - 1];
      const scoreMarks = play ? state.pa?.scoreAt : null;
      const done = await commit({
        state: game, next, nextAt,
        pitch: {
          pitch_no: game.pitchNo, pa_no: paNo, count_before: last.count, call: pitch.call, result: pitch.result,
          payload: {
            ...pitch, batter: play ? play.batter : pa.batter, inning: play ? play.inn : pa.inning, side: play ? play.side : pa.side,
            tactics, plans: game.plans || {}, voted: play ? (play.votes || []).length > 0 : Boolean(pa.tactical),
            countAfter: play ? null : `${pa.balls}-${pa.strikes}`, paResult: play ? play.kind : null,
            outs: game.outs, base: game.base, score: score(game), next: upNext,
          },
        },
        pa: play ? {
          pa_no: play.paNo, outcome: play.kind, runs: play.runs, round_id: state.pa?.roundIds?.pre_pa ?? null,
          reveal_at: iso(at), payload: { ...play, pitches: play.pitches.map(({ distribution, ...rest }) => rest) },
        } : null,
        detail: { pitchNo: game.pitchNo, call: pitch.call, paResult: play?.kind ?? null, next },
      });
      if (done.committed && scoreMarks) await settleScores(rpc, scoreMarks, play);
      return done;
    }
    case 'open_round': {
      const vote = engine.pendingVote(state, roster);
      if (!vote) return commit({ next: 'pitch', nextAt: now(), detail: { note: 'no vote needed' } });
      const { ballot, phase } = vote;
      const choices = [
        ...ballot.offenseChoices.map((c, i) => ({ role: 'offense', key: c.id, label: c.label, default: i === 0 })),
        ...ballot.defenseChoices.map((c, i) => ({ role: 'defense', key: c.id, label: c.label, default: i === 0 })),
      ];
      const paNo = state.pa?.no ?? state.plays.length + 1;
      const side = state.pa?.side ?? state.half;
      const snapshot = {
        phase, count: ballot.count, inning: state.pa?.inning ?? state.inning, half: side, outs: state.outs, base: state.base,
        score: score(state), batter: engine.upcomingBatter(state, roster), ballot,
      };
      const round = await rpc('open_tactical_round', {
        p_game_id: gameId, p_pa_no: paNo, p_state_snapshot: snapshot,
        p_offense_team_id: ballot.offenseTeamId, p_defense_team_id: ballot.defenseTeamId, p_choices: choices,
        p_phase: phase, p_seconds: (state.pa?.phasesDone?.length || 0) > 0 ? engine.FOLLOW_UP_VOTE_SECONDS : engine.VOTE_SECONDS,
      });
      return commit({
        next: 'resolve_round', nextAt: Date.parse(round.closes_at) + RESOLVE_MARGIN_MS, roundId: round.id,
        detail: { paNo, phase, roundId: round.id },
      });
    }
    case 'open_change': {
      const { fieldSide, sideKey, relievers } = change;
      const paNo = state.plays.length + 1, def = relievers[0];
      const choices = [
        { role: 'offense', key: 'keep', label: '상대 팀 투수 교체 투표 중', default: true },
        ...relievers.map(r => ({ role: 'defense', key: `rp:${r.index}`, label: `${r.name} · ${r.throws === 'L' ? '좌완' : '우완'}${r.slot === 'three' ? ' 스리쿼터' : r.slot === 'side' ? ' 사이드암' : r.slot === 'under' ? ' 언더핸드' : ''} · 다음 3타자 중 같은 손 ${r.fit}명`, default: r === def })),
      ];
      const snapshot = { phase: 'pitcher_change', scheduled: Boolean(change.scheduled), inning: state.inning, half: state.half, outs: state.outs, base: state.base, score: score(state),
        batter: engine.upcomingBatter(state, roster), pitcher: engine.currentPitcher(state, roster, fieldSide)?.[0], relievers };
      const offenseKey = fieldSide === 'away' ? state.homeId : state.awayId;
      const round = await rpc('open_tactical_round', {
        p_game_id: gameId, p_pa_no: paNo, p_state_snapshot: snapshot, p_offense_team_id: offenseKey, p_defense_team_id: sideKey,
        p_choices: choices, p_phase: 'pitcher_change', p_seconds: engine.VOTE_SECONDS,
      });
      await rpc('clear_pitching_change_requests', { p_game_id: gameId, p_side_key: sideKey });
      return commit({ next: 'resolve_round', nextAt: Date.parse(round.closes_at) + RESOLVE_MARGIN_MS, roundId: round.id, detail: { paNo, phase: 'pitcher_change', roundId: round.id } });
    }
    case 'resolve_round': {
      await rpc('resolve_tactical_round', { p_round_id: g.current_round_id });
      // Read the decided choice keys (the resolve result only has choice ids).
      g = await rpc('get_orchestrator_game', { p_game_id: gameId });
      const phase = g.round?.phase || 'pre_pa';
      let decided;
      if (phase === 'pitcher_change') {
        // The fans' reliever comes in before the next plate appearance.
        const index = Number(String(g.resolution?.defense || '').replace('rp:', '')), fieldSide = state.half === 'away' ? 'home' : 'away';
        decided = Number.isInteger(index) ? engine.requestPitcherChange(state, roster, fieldSide, index) : state;
      } else {
        decided = engine.applyVote(state, roster, phase, { offense: g.resolution?.offense, defense: g.resolution?.defense });
        decided.pa.roundIds = { ...(decided.pa.roundIds || {}), [phase]: g.current_round_id };
        // Tactic score: where the vote happened, to value the real plate appearance when it ends.
        decided.pa.scoreAt = { ...(decided.pa.scoreAt || {}), [g.current_round_id]: { base: [...state.base], outs: state.outs } };
      }
      const next = planNext(decided, roster);
      const done = await commit({
        // A short pause after the vote closes, so fans see the result before the next pitch.
        state: decided, next, nextAt: now() + engine.POST_VOTE_GAP_MS, roundId: g.current_round_id,
        detail: { phase, offense: g.resolution?.offense, defense: g.resolution?.defense, fallbackRoles: g.resolution?.fallback_roles || [] },
      });
      if (done.committed && phase !== 'pitcher_change') await recordOutcomes(rpc, g.current_round_id, state, roster, phase, g.resolution);
      return done;
    }
    case 'finish':
      return commit({ finish: true });
    default:
      throw new Error(`unknown next action ${action}`);
  }
}
