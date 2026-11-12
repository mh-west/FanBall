// Shared setup for the engine tests (pitch-engine.test.mjs and the slow sim-*.test.mjs files, which are split
// out so node --test runs them in parallel).
import * as E from '../supabase/functions/_shared/pitch-engine.js';
import { loadBrowserEngine, sampleRoster } from '../tools/browser-sandbox.mjs';
export { E };

export const browser = loadBrowserEngine();
export const roster = sampleRoster(browser, ['doosan', 'tigers', 'lg', 'kt']);
export const pair = (a, h) => ({ [a]: roster[a], [h]: roster[h] });
// For checking batters against their calibrated targets: every reliever pitches like the starter, so the
// targets (computed against the starter) still hold after pitching changes.
export const sameArms = t => ({ ...t, bullpen: (t.bullpen || []).map(p => { const q = [...t.pitcher]; q[0] = p[0]; return q; }) });
export const pairSameArms = (a, h) => ({ [a]: sameArms(roster[a]), [h]: sameArms(roster[h]) });

// Plays a whole game. pick(vote) returns the tactics for each vote; default keeps everything.
export function playGame(awayId, homeId, seed, { pick = () => ({}), trials, sameArms = false } = {}) {
  const r = sameArms ? pairSameArms(awayId, homeId) : pair(awayId, homeId);
  let g = E.createGame({ awayId, homeId, seed, roster: r, trials });
  const pitches = [], votes = [];
  for (let guard = 0; guard < 3000 && g.status === 'running'; guard++) {
    const vote = E.pendingVote(g, r);
    if (vote) { const t = pick(vote); votes.push({ phase: vote.phase, ...t }); g = E.applyVote(g, r, vote.phase, t); continue; }
    const step = E.stepPitch(g, r);
    pitches.push(step.pitch); g = step.game;
  }
  return { game: g, pitches, votes };
}


export function bullpenRoster() {
  const players = Array.from({ length: 9 }, (_, i) => { const p = [`a${i}`, 'IF', 0.27, 0.34, 0.42]; p[12] = i % 3 === 0 ? 'L' : 'R'; return p; });
  const sp = ['SP', 0.25, 0.08, 0.21]; sp[6] = 'R';
  const pen = [['RP1', 0.22, 0.08, 0.28, null, null, 'R'], ['RP2', 0.24, 0.09, 0.24, null, null, 'L'], ['RP3', 0.26, 0.1, 0.2, null, null, 'R', 'side'],
    ['RP4', 0.27, 0.1, 0.18, null, null, 'R'], ['RP5', 0.25, 0.09, 0.22, null, null, 'L']];
  const team = { players, pitcher: sp, bullpen: pen, order: [0, 1, 2, 3, 4, 5, 6, 7, 8] };
  return { a: team, b: { ...team, players: players.map(p => Object.assign(['b' + p[0].slice(1), ...p.slice(1)], { 12: p[12] })) } };
}
