// AI match manager (dist/ai-manager.js): lineups and tactic choices on the real squads.
// Run: cd tests && node --test ai-manager.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../dist/engine/pitch-engine.js';
import { aiLineupFor, aiChoice, expectedRuns } from '../dist/ai-manager.js';
import { loadBrowserEngine } from '../tools/browser-sandbox.mjs';

const browser = loadBrowserEngine();
const ids = JSON.parse(browser.run('JSON.stringify(TEAMS.map(t=>t.id))'));
const teamOf = id => browser.run(`team(${JSON.stringify(id)})`);

test('every team gets a complete AI lineup: nine different players, each position once, a catcher catching', () => {
  for (const id of ids) {
    const t = teamOf(id), { order, pos } = aiLineupFor(t);
    assert.equal(order.length, 9, id);
    assert.equal(new Set(order).size, 9, `${id} distinct players`);
    assert.deepEqual(order.map(i => pos[i]).sort(), ['1B', '2B', '3B', 'C', 'CF', 'DH', 'LF', 'RF', 'SS'], `${id} positions`);
    const catcher = order.find(i => pos[i] === 'C');
    assert.equal(t.players[catcher].group, 'C', `${id} catcher is a catcher`);
  }
});

test('the AI lineup puts its best hitters at the top and in the middle', () => {
  const t = teamOf('tigers'), { order } = aiLineupFor(t), rating = p => p[3] * 1.8 + p[4];
  const top = [order[0], order[1], order[3]].map(i => rating(t.players[i])), bottom = order.slice(5).map(i => rating(t.players[i]));
  assert.ok(Math.min(...top) >= Math.max(...bottom), 'slots 1, 2 and 4 out-rate slots 6-9');
});

test('AI picks are valid ballot choices, and a whole game runs with the AI managing both sides', () => {
  const roster = {};
  for (const id of ['doosan', 'tigers']) { const t = teamOf(id), { order } = aiLineupFor(t); roster[id] = { players: t.players, pitcher: t.pitcher, order }; }
  let g = E.createGame({ awayId: 'doosan', homeId: 'tigers', seed: 7, roster, trials: 300 }), votes = 0;
  for (let i = 0; i < 5000 && g.status === 'running'; i++) {
    const v = E.pendingVote(g, roster);
    if (!v) { g = E.stepPitch(g, roster).game; continue; }
    const offense = aiChoice(g, roster, v.ballot, 'offense', v.phase), defense = aiChoice(g, roster, v.ballot, 'defense', v.phase);
    assert.ok(v.ballot.offenseChoices.some(c => c.id === offense), `offense pick ${offense}`);
    assert.ok(v.ballot.defenseChoices.some(c => c.id === defense), `defense pick ${defense}`);
    g = E.applyVote(g, roster, v.phase, { offense, defense }); votes++;
  }
  assert.equal(g.status, 'final');
  assert.ok(votes > 5, `votes ${votes}`);
});

test('expected runs: bases loaded beats bases empty, and an intentional walk with runners on 2nd and 3rd loads the bases', () => {
  const roster = {};
  for (const id of ['doosan', 'tigers']) { const t = teamOf(id), { order } = aiLineupFor(t); roster[id] = { players: t.players, pitcher: t.pitcher, order }; }
  const g = E.createGame({ awayId: 'doosan', homeId: 'tigers', seed: 1, roster, trials: 300 });
  const prof = g.profiles.away[roster.doosan.order[3]], t = { offense: 'normal', alignment: 'standard', approach: 'standard' };
  const empty = expectedRuns({ ...g, base: [null, null, null], outs: 0 }, prof, t, '0-0');
  const loaded = expectedRuns({ ...g, base: ['a', 'b', 'c'], outs: 0 }, prof, t, '0-0');
  assert.ok(loaded > empty + 1, `${loaded} vs ${empty}`);
  const ibb = expectedRuns({ ...g, base: [null, 'b', 'c'], outs: 1 }, prof, { ...t, ibb: true }, '0-0');
  assert.ok(ibb > 1, 'walking the batter loads the bases with one out: about 1.5 runs expected');
});
