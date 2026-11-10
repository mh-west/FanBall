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
    // A little past the due time so the database clock agrees it is due.
    await sleep(Math.max(0, next - now() + 50));
  }
  await lease(now());
  return steps;
}

export async function advanceGame(rpc, gameId, { now = () => Date.now() } = {}) {
  let g = await rpc('get_orchestrator_game', { p_game_id: gameId });
  if (!g || g.status !== 'running' || !g.next_action) return { gameId, skipped: 'not running' };
  if (Date.parse(g.next_action_at) > now()) return { gameId, skipped: 'not due', nextAt: Date.parse(g.next_action_at) };
  if (g.model_version && g.model_version !== engine.ENGINE_VERSION) return { gameId, skipped: `engine ${g.model_version}` };

  const roster = g.lineup_snapshot?.teams;
  if (!roster?.[g.away_team_id] || !roster?.[g.home_team_id]) throw new Error('lineup snapshot is missing a team');
  const state = g.engine_state && Object.keys(g.engine_state).length
    ? g.engine_state
    : engine.createGame({ awayId: g.away_team_id, homeId: g.home_team_id, seed: Number(g.seed), roster });

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
  // A vote may be due even if the stored step says pitch (for example right after the game starts).
  if (action === 'pitch' && engine.pendingVote(state, roster)) action = 'open_round';

  switch (action) {
    case 'pitch': {
      const { game, pitch, play } = engine.stepPitch(state, roster);
      const pa = play ? null : game.pa, paNo = play ? play.paNo : pa.no, at = now();
      const next = planNext(game, roster);
      // Clients show each pitch for PITCH_INTERVAL_MS, and a finished plate appearance a little longer.
      const nextAt = at + engine.PITCH_INTERVAL_MS + (play ? engine.RESULT_DISPLAY_MS : 0);
      const tactics = play ? { offense: play.choice, alignment: play.defenseChoice, approach: play.approach } : { offense: pa.offense, alignment: pa.alignment, approach: pa.approach };
      const last = play ? play.pitches[play.pitches.length - 1] : pa.pitches[pa.pitches.length - 1];
      return commit({
        state: game, next, nextAt,
        pitch: {
          pitch_no: game.pitchNo, pa_no: paNo, count_before: last.count, call: pitch.call, result: pitch.result,
          payload: {
            ...pitch, batter: play ? play.batter : pa.batter, inning: play ? play.inn : pa.inning, side: play ? play.side : pa.side,
            tactics, voted: play ? (play.votes || []).length > 0 : Boolean(pa.tactical),
            countAfter: play ? null : `${pa.balls}-${pa.strikes}`, paResult: play ? play.kind : null,
            outs: game.outs, base: game.base, score: score(game),
          },
        },
        pa: play ? {
          pa_no: play.paNo, outcome: play.kind, runs: play.runs, round_id: state.pa?.roundIds?.pre_pa ?? null,
          reveal_at: iso(at), payload: { ...play, pitches: play.pitches.map(({ distribution, ...rest }) => rest) },
        } : null,
        detail: { pitchNo: game.pitchNo, call: pitch.call, paResult: play?.kind ?? null, next },
      });
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
    case 'resolve_round': {
      await rpc('resolve_tactical_round', { p_round_id: g.current_round_id });
      // Read the decided choice keys (the resolve result only has choice ids).
      g = await rpc('get_orchestrator_game', { p_game_id: gameId });
      const phase = g.round?.phase || 'pre_pa';
      const decided = engine.applyVote(state, roster, phase, { offense: g.resolution?.offense, defense: g.resolution?.defense });
      decided.pa.roundIds = { ...(decided.pa.roundIds || {}), [phase]: g.current_round_id };
      const next = planNext(decided, roster);
      return commit({
        state: decided, next, nextAt: now(), roundId: g.current_round_id,
        detail: { phase, offense: g.resolution?.offense, defense: g.resolution?.defense, fallbackRoles: g.resolution?.fallback_roles || [] },
      });
    }
    case 'finish':
      return commit({ finish: true });
    default:
      throw new Error(`unknown next action ${action}`);
  }
}
