// One orchestrator tick: start due games, then advance every game whose next step is due by
// exactly one step (a plate appearance, opening a vote, closing a vote, or finishing).
// All reads and writes go through server-only RPCs, so the same code runs in the Edge Function
// (supabase-js) and in local tests (PGlite). See docs/ORCHESTRATOR_DESIGN.md.
import * as engine from './fanball-engine.js';

// Wait a little past the round's close so the database clock has surely passed it.
const RESOLVE_MARGIN_MS = 200;

const iso = ms => new Date(ms).toISOString();
const score = state => ({ away: state.away, home: state.home });
const firstValue = row => (row !== null && typeof row === 'object' ? Object.values(row)[0] : row);

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

export async function advanceGame(rpc, gameId, { now = () => Date.now() } = {}) {
  const g = await rpc('get_orchestrator_game', { p_game_id: gameId });
  if (!g || g.status !== 'running' || !g.next_action) return { gameId, skipped: 'not running' };
  if (Date.parse(g.next_action_at) > now()) return { gameId, skipped: 'not due' };

  const roster = g.lineup_snapshot?.teams;
  if (!roster?.[g.away_team_id] || !roster?.[g.home_team_id]) throw new Error('lineup snapshot is missing a team');
  const state = g.engine_state && Object.keys(g.engine_state).length
    ? g.engine_state
    : engine.createGame({ awayId: g.away_team_id, homeId: g.home_team_id, seed: Number(g.seed) });

  // Every commit is checked against the version we read; false means another call got there first.
  const commit = async ({ detail = {}, ...args }) => {
    const ok = await rpc('commit_orchestrator_step', {
      p_game_id: gameId, p_expected_version: g.state_version, p_engine_state: state,
      p_next_action: null, p_next_action_at: null, p_current_round_id: null,
      p_score: score(state), p_pa: null, p_finish: false, p_model_version: engine.ENGINE_VERSION, ...args,
    });
    return { gameId, action: g.next_action, committed: firstValue(ok) === true, ...detail };
  };

  switch (g.next_action) {
    case 'play_pa': {
      const tactics = g.resolution ? { offense: g.resolution.offense, defense: g.resolution.defense } : {};
      const { game, play, needsVote } = engine.stepPlateAppearance(state, roster, tactics);
      if (!play) return commit({ p_engine_state: game, p_score: score(game), p_finish: true });
      const revealAt = now() + engine.presentationMs(play);
      const next = game.status === 'final' ? 'finish' : needsVote ? 'open_round' : 'play_pa';
      const nextAt = next === 'play_pa' ? revealAt + engine.NEXT_PA_DELAY_MS : revealAt;
      return commit({
        p_engine_state: game,
        p_next_action: next,
        p_next_action_at: iso(nextAt),
        // Public score stays at the last shown plate appearance until this one is revealed.
        p_score: score(state),
        p_pa: {
          pa_no: game.plays.length, outcome: play.kind, runs: play.runs,
          round_id: g.resolution ? g.current_round_id : null, reveal_at: iso(revealAt),
          payload: { ...play, fallbackRoles: g.resolution?.fallback_roles || [] },
        },
        detail: { paNo: game.plays.length, outcome: play.kind, next },
      });
    }
    case 'open_round': {
      const ballot = engine.makeStrategyBallot(state, roster);
      const choices = [
        ...ballot.offenseChoices.map(c => ({ role: 'offense', key: c.id, label: c.label, default: c.id === 'normal' })),
        ...ballot.defenseChoices.map(c => ({ role: 'defense', key: c.id, label: c.label, default: c.id === 'standard' })),
      ];
      const paNo = state.plays.length + 1;
      const snapshot = { inning: state.inning, half: state.half, outs: state.outs, base: state.base, score: score(state), ballot };
      const round = await rpc('open_tactical_round', {
        p_game_id: gameId, p_pa_no: paNo, p_state_snapshot: snapshot,
        p_offense_team_id: ballot.offenseTeamId, p_defense_team_id: ballot.defenseTeamId, p_choices: choices,
      });
      return commit({
        p_next_action: 'resolve_round',
        p_next_action_at: iso(Date.parse(round.closes_at) + RESOLVE_MARGIN_MS),
        p_current_round_id: round.id,
        detail: { paNo, roundId: round.id },
      });
    }
    case 'resolve_round': {
      const result = await rpc('resolve_tactical_round', { p_round_id: g.current_round_id });
      return commit({
        p_next_action: 'play_pa', p_next_action_at: iso(now()), p_current_round_id: g.current_round_id,
        detail: { fallbackRoles: result?.fallback_roles || [] },
      });
    }
    case 'finish':
      return commit({ p_finish: true });
    default:
      throw new Error(`unknown next action ${g.next_action}`);
  }
}
