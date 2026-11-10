// Checks the pitch-by-pitch engine (fanball-engine-2): count rules, player calibration,
// tactic directions, determinism and speed. Run: cd tests && node --test pitch-engine.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../supabase/functions/_shared/pitch-engine.js';
import { loadBrowserEngine, sampleRoster } from '../tools/browser-sandbox.mjs';

const browser = loadBrowserEngine();
const roster = sampleRoster(browser, ['doosan', 'tigers', 'lg', 'kt']);
const pair = (a, h) => ({ [a]: roster[a], [h]: roster[h] });

// Plays a whole game. pick(vote) returns the tactics for each vote; default keeps everything.
function playGame(awayId, homeId, seed, { pick = () => ({}), trials } = {}) {
  const r = pair(awayId, homeId);
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

test('calibration hits every sample matchup target', () => {
  for (const [a, h] of [['doosan', 'tigers'], ['lg', 'kt']]) {
    const g = E.createGame({ awayId: a, homeId: h, seed: 1, roster: pair(a, h) });
    for (const side of ['away', 'home']) for (const p of g.profiles[side]) {
      for (const k of ['avg', 'iso', 'bb', 'k']) assert.ok(Math.abs(p.fitted[k] - p.target[k]) < 0.001, `${side} ${k}: ${p.fitted[k]} vs ${p.target[k]}`);
    }
  }
});

test('strikeouts only at two strikes, walks only at three balls, foul with two strikes keeps the count', () => {
  for (let seed = 0; seed < 8; seed++) {
    const { game } = playGame('doosan', 'tigers', seed, { trials: 2000 });
    assert.equal(game.status, 'final');
    for (const play of game.plays) {
      const last = play.pitches[play.pitches.length - 1];
      if (play.kind === 'K') assert.match(last.count, /-2$/, `K at ${last.count}`);
      if (play.kind === 'BB') assert.match(last.count, /^3-/, `BB at ${last.count}`);
      // Replay the count from the pitch list.
      let b = 0, s = 0;
      for (const p of play.pitches) {
        assert.equal(p.count, `${b}-${s}`);
        if (p.call === 'ball') b++;
        else if (p.call === 'strike' || (p.call === 'foul' && (s < 2 || p.result === 'bunt_foul'))) s++;
      }
    }
  }
});

test('simulated batting lines match the calibrated targets', () => {
  const totals = {};
  for (let seed = 0; seed < 60; seed++) {
    const { game } = playGame('doosan', 'tigers', 1000 + seed, { trials: 1000 });
    for (const play of game.plays) {
      const t = totals[play.side] || (totals[play.side] = { PA: 0, AB: 0, H: 0, TB: 0, BB: 0, K: 0 });
      t.PA++;
      if (!['BB', 'IBB', 'HBP', 'SAC', 'SF'].includes(play.kind)) t.AB++;
      if (['1B', '2B', '3B', 'HR', 'BUNT_HIT'].includes(play.kind)) { t.H++; t.TB += { '1B': 1, BUNT_HIT: 1, '2B': 2, '3B': 3, HR: 4 }[play.kind]; }
      if (play.kind === 'BB') t.BB++;
      if (play.kind === 'K') t.K++;
    }
  }
  const g = E.createGame({ awayId: 'doosan', homeId: 'tigers', seed: 1, roster: pair('doosan', 'tigers') });
  for (const side of ['away', 'home']) {
    const t = totals[side], ps = g.profiles[side], mean = k => ps.reduce((a, p) => a + p.target[k], 0) / ps.length;
    const avg = t.H / t.AB, iso = (t.TB - t.H) / t.AB, bb = t.BB / t.PA, k = t.K / t.PA;
    console.log(`${side}: ${t.PA} PA  AVG ${avg.toFixed(3)} (target ${mean('avg').toFixed(3)})  ISO ${iso.toFixed(3)} (${mean('iso').toFixed(3)})  BB ${bb.toFixed(3)} (${mean('bb').toFixed(3)})  K ${k.toFixed(3)} (${mean('k').toFixed(3)})`);
    assert.ok(Math.abs(avg - mean('avg')) < 0.02, `${side} AVG ${avg}`);
    assert.ok(Math.abs(iso - mean('iso')) < 0.025, `${side} ISO ${iso}`);
    assert.ok(Math.abs(bb - mean('bb')) < 0.015, `${side} BB ${bb}`);
    assert.ok(Math.abs(k - mean('k')) < 0.02, `${side} K ${k}`);
  }
});

test('tactics move the odds in the intended direction', () => {
  const g = E.createGame({ awayId: 'doosan', homeId: 'tigers', seed: 1, roster: pair('doosan', 'tigers') });
  const profile = g.profiles.away[2];
  const odds = (t, from = '0-0', bunting = false) => E.plateAppearanceOdds(profile, { offense: 'normal', alignment: 'standard', approach: 'standard', ...t }, from, { bunting });
  const base = odds({});
  const sum = o => ({ k: o.K, bb: o.BB, hr: o.bip.HR, xbh: o.bip['2B'] + o.bip['3B'] + o.bip.HR, single: o.bip['1B'], dp: o.bip.DP });
  const b = sum(base);
  assert.ok(sum(odds({ offense: 'contact' })).k < b.k, 'contact lowers strikeouts');
  assert.ok(sum(odds({ offense: 'aggressive' })).hr > b.hr, 'aggressive raises home runs');
  assert.ok(sum(odds({ offense: 'wait' }, '3-1')).bb > sum(odds({}, '3-1')).bb, 'waiting at 3-1 raises walks');
  assert.ok(sum(odds({ approach: 'pitch_around' })).bb > b.bb, 'pitching around raises walks');
  assert.ok(sum(odds({ approach: 'attack' })).bb < b.bb, 'attacking lowers walks');
  assert.ok(sum(odds({ alignment: 'outfield_deep' })).xbh < b.xbh, 'deep outfield lowers extra-base hits');
  assert.ok(sum(odds({ alignment: 'double_play' })).dp > b.dp, 'double-play depth raises double plays');
  const bunt = odds({ offense: 'bunt' }, '0-0', true), buntIn = odds({ offense: 'bunt', alignment: 'corners_in' }, '0-0', true);
  assert.ok(bunt.bunt.sacrifice > 0.2, 'bunts mostly sacrifice');
  assert.ok(buntIn.bunt.sacrifice + buntIn.bunt.hit < bunt.bunt.sacrifice + bunt.bunt.hit, 'corners in lowers bunt success');
  assert.ok(sum(odds({}, '0-2')).k > b.k && sum(odds({}, '3-0')).bb > b.bb, 'the count changes the odds');
});

test('votes: pre-PA vote, key-count votes, intentional walk, and choices on both sides', () => {
  let sawTwo = false, sawThree = false, sawIbb = false;
  for (let seed = 0; seed < 10; seed++) {
    const { game, votes } = playGame('lg', 'kt', 500 + seed, {
      trials: 1000,
      pick: v => {
        assert.ok(v.ballot.offenseChoices.length >= 2 && v.ballot.defenseChoices.length >= 2, `${v.phase} has choices on both sides`);
        for (const c of [...v.ballot.offenseChoices, ...v.ballot.defenseChoices]) assert.ok(c.odds && Number.isFinite(c.odds.hit), 'each choice shows its odds');
        if (v.phase === 'two_strikes') sawTwo = true;
        if (v.phase === 'three_balls') sawThree = true;
        const ibb = v.ballot.defenseChoices.find(c => c.id === 'intentional_walk');
        if (ibb && seed === 0 && !sawIbb) { sawIbb = true; return { defense: 'intentional_walk' }; }
        return {};
      },
    });
    assert.equal(game.status, 'final');
    if (seed === 0) assert.ok(game.plays.some(p => p.kind === 'IBB'), 'intentional walk recorded');
    for (const v of votes) assert.ok(['pre_pa', 'two_strikes', 'three_balls'].includes(v.phase));
  }
  assert.ok(sawTwo && sawThree && sawIbb);
});

test('same seed and same votes give the same game; the input state is not changed', () => {
  const pick = v => ({ offense: v.ballot.offenseChoices.at(-1).id, defense: v.ballot.defenseChoices.at(-1).id });
  const a = playGame('doosan', 'tigers', 77, { pick, trials: 3000 }), b = playGame('doosan', 'tigers', 77, { pick, trials: 3000 });
  assert.deepEqual(a.game.plays.map(p => p.kind), b.game.plays.map(p => p.kind));
  assert.deepEqual([a.game.away, a.game.home], [b.game.away, b.game.home]);
  const r = pair('doosan', 'tigers'), g = E.createGame({ awayId: 'doosan', homeId: 'tigers', seed: 5, roster: r }), before = JSON.stringify(g);
  E.stepPitch(g, r);
  assert.equal(JSON.stringify(g), before);
});

test('a real 100,000-sample pitch stays well under the 2s Edge Function CPU limit', () => {
  const r = pair('doosan', 'tigers');
  let t = performance.now(), g = E.createGame({ awayId: 'doosan', homeId: 'tigers', seed: 9, roster: r });
  const create = performance.now() - t;
  let worst = 0;
  for (let i = 0; i < 40 && g.status === 'running'; i++) {
    const v = E.pendingVote(g, r);
    if (v) { g = E.applyVote(g, r, v.phase, {}); continue; }
    t = performance.now(); g = E.stepPitch(g, r).game; worst = Math.max(worst, performance.now() - t);
  }
  console.log(`createGame ${create.toFixed(1)} ms, slowest pitch ${worst.toFixed(1)} ms`);
  assert.ok(create < 1000 && worst < 300);
});

test('late close games open a vote only with a runner on base', () => {
  const g = E.createGame({ awayId: 'doosan', homeId: 'tigers', seed: 1, roster: pair('doosan', 'tigers') });
  const at = (inning, away, home, base, outs) => E.isTacticalSituation({ ...g, inning, away, home, base, outs });
  assert.equal(at(8, 1, 0, [null, null, null], 0), false, 'bases empty, close, late: no vote');
  assert.equal(at(8, 1, 0, ['a', null, null], 2), true, 'runner on first with two outs, close, late: vote');
  assert.equal(at(5, 1, 0, ['a', null, null], 2), false, 'same before the 7th: no vote');
  assert.equal(at(8, 5, 0, ['a', null, null], 2), false, 'not close: no vote');
  assert.equal(at(3, 0, 0, [null, 'b', null], 2), true, 'scoring position always votes');
});

test('no sacrifice bunt (or bunt defense) with one out and only a runner on first', () => {
  const r = pair('doosan', 'tigers'), g = E.createGame({ awayId: 'doosan', homeId: 'tigers', seed: 1, roster: r });
  const ids = (base, outs) => { const b = E.makeBallot({ ...g, base, outs }, r, 'pre_pa'); return [...b.offenseChoices, ...b.defenseChoices].map(c => c.id); };
  assert.ok(!ids(['a', null, null], 1).includes('bunt') && !ids(['a', null, null], 1).includes('corners_in'), '1사 1루: no bunt');
  assert.ok(ids(['a', null, null], 0).includes('bunt') && ids(['a', null, null], 0).includes('corners_in'), '무사 1루: bunt');
  assert.ok(ids([null, 'b', null], 1).includes('bunt'), '1사 2루: still offered');
  assert.ok(ids(['a', 'b', null], 1).includes('bunt'), '1사 1,2루: still offered');
  // A bunt chosen where it is not offered falls back to normal hitting.
  const s = E.applyVote({ ...g, base: ['a', null, null], outs: 1 }, r, 'pre_pa', { offense: 'bunt' });
  assert.equal(s.pa.offense, 'normal');
});

test('two-strike and three-ball votes only with a runner in scoring position', () => {
  const r = pair('doosan', 'tigers'), g = E.createGame({ awayId: 'doosan', homeId: 'tigers', seed: 1, roster: r });
  const at = (base, balls, strikes) => {
    const s = E.applyVote({ ...g, base, outs: 0 }, r, 'pre_pa', {});
    s.pa.balls = balls; s.pa.strikes = strikes;
    return E.pendingVote(s, r)?.phase ?? null;
  };
  assert.equal(at(['a', null, null], 0, 2), null, 'runner on first only: no two-strike vote');
  assert.equal(at(['a', null, null], 3, 0), null, 'runner on first only: no three-ball vote');
  assert.equal(at([null, 'b', null], 0, 2), 'two_strikes');
  assert.equal(at([null, null, 'c'], 3, 1), 'three_balls');
  assert.equal(at(['a', 'b', null], 3, 2), 'two_strikes');
});
