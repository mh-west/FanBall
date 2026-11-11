// AI match manager (dist/ai-manager.js): lineups and tactic choices on the real squads.
// Run: cd tests && node --test ai-manager.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../dist/engine/pitch-engine.js';
import { aiLineupFor, aiChoice, expectedRuns, canPlay } from '../dist/ai-manager.js';
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
    for (const i of order) assert.ok(canPlay(t.players[i], pos[i]), `${id}: ${t.players[i][0]} plays ${pos[i]} (${t.players[i].positions})`);
    // The plain default lineup (also the start of the fans' lineup page) follows the same rule.
    for (const i of t.defaultOrder) assert.ok(canPlay(t.players[i], t.defaultPos[i]), `${id} default: ${t.players[i][0]} at ${t.defaultPos[i]}`);
  }
});

test('regulars play their 2026 positions: real shortstops at short, first basemen not at short', () => {
  const at = (id, name) => { const t = teamOf(id), l = aiLineupFor(t), i = l.order.find(k => t.players[k][0] === name); return i === undefined ? null : l.pos[i]; };
  assert.equal(at('lg', '오지환'), 'SS');
  assert.equal(at('samsung', '이재현'), 'SS');
  assert.equal(at('hanwha', '심우준'), 'SS');
  assert.equal(at('tigers', '김도영'), '3B');
  assert.notEqual(at('lg', '오스틴'), 'SS');
  assert.notEqual(at('samsung', '디아즈'), 'SS');
  assert.notEqual(at('hanwha', '강백호'), 'C');
  // 2026 positions, not career ones: 나성범 played RF and DH in 2026, never CF; 강백호 was a DH.
  assert.notEqual(at('tigers', '나성범'), 'CF');
  assert.equal(at('hanwha', '강백호'), 'DH');
  assert.equal(at('tigers', '하주석'), 'SS');
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

test('no tactic is best everywhere: by expected runs each wins only in some base-out states', () => {
  const pitcher = ['P', 0.256, 0.09, 0.202];
  const hitters = { average: ['a', 'IF', 0.256, 0.338, 0.390], power: ['p', 'IF', 0.270, 0.360, 0.520], contact: ['c', 'IF', 0.290, 0.345, 0.360] };
  const wins = {};
  for (const [kind, b] of Object.entries(hitters)) {
    const prof = E.calibrateMatchup(b, pitcher);
    for (let outs = 0; outs < 3; outs++) for (let m = 0; m < 8; m++) {
      const s = { outs, base: [m & 1 ? 1 : null, m & 2 ? 1 : null, m & 4 ? 1 : null] };
      const ev = t => expectedRuns(s, prof, { offense: 'normal', alignment: 'standard', approach: 'standard', ...t }, '0-0');
      const off = [['normal', ev({})], ['contact', ev({ offense: 'contact' })], ['aggressive', ev({ offense: 'aggressive' })]].reduce((a, x) => (x[1] > a[1] + 0.005 ? x : a))[0];
      const def = [['standard', ev({})], ['attack', ev({ approach: 'attack' })], ['pitch_around', ev({ approach: 'pitch_around' })]].reduce((a, x) => (x[1] < a[1] - 0.005 ? x : a))[0];
      for (const k of [`${kind} ${off}`, `${kind} ${def}`]) wins[k] = (wins[k] || 0) + 1;
    }
  }
  assert.ok((wins['average normal'] || 0) >= 16, 'an average hitter mostly swings normally');
  assert.ok((wins['power aggressive'] || 0) >= 3 && (wins['power aggressive'] || 0) <= 16, `power hitters sometimes swing for power: ${wins['power aggressive']}`);
  assert.ok((wins['contact contact'] || 0) >= 3 && (wins['contact contact'] || 0) <= 20, `contact hitters sometimes just make contact: ${wins['contact contact']}`);
  for (const k of ['average', 'power', 'contact']) assert.ok((wins[`${k} attack`] || 0) < 20, `${k}: attacking the zone is not always best`);
  assert.ok((wins['power pitch_around'] || 0) >= 3, 'pitching around power hitters pays somewhere');
});

test('out-of-position fielders make the defense worse: more reach-on-error and hits for the other side', () => {
  const roster = {};
  for (const id of ['lg', 'tigers']) { const t = teamOf(id), { order, pos } = aiLineupFor(t); roster[id] = { players: t.players.map(p => [...p]), pitcher: t.pitcher, order, positions: Object.fromEntries(order.map(i => [t.players[i][0], pos[i]])) }; }
  assert.deepEqual(E.misplacedFielders(roster.lg), { infield: 0, outfield: 0 }, 'the AI lineup has nobody out of position');
  // Swap an outfielder and an infielder in LG's lineup.
  const t = roster.lg, of = t.order.find(i => ['LF', 'RF'].includes(t.positions[t.players[i][0]])), inf = t.order.find(i => ['2B', '3B'].includes(t.positions[t.players[i][0]]));
  const bad = { ...t, positions: { ...t.positions, [t.players[of][0]]: t.positions[t.players[inf][0]], [t.players[inf][0]]: t.positions[t.players[of][0]] } };
  assert.deepEqual(E.misplacedFielders(bad), { infield: 1, outfield: 1 });
  const odds = lg => { const g = E.createGame({ awayId: 'tigers', homeId: 'lg', seed: 1, roster: { tigers: roster.tigers, lg }, trials: 200 });
    return E.plateAppearanceOdds(g.profiles.away[roster.tigers.order[0]], { offense: 'normal', alignment: 'standard', approach: 'standard' }); };
  const good = odds(t), worse = odds(bad), hits = o => o.bip['1B'] + o.bip['2B'] + o.bip['3B'] + o.bip.HR;
  assert.ok(worse.bip.ROE_FC > good.bip.ROE_FC * 2, `errors ${good.bip.ROE_FC} -> ${worse.bip.ROE_FC}`);
  assert.ok(hits(worse) > hits(good), 'more hits');
});
