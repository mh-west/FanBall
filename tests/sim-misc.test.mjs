// Slow engine simulations, split from pitch-engine.test.mjs so they run in parallel (skipped by npm run quick).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { E, browser, roster, pair, sameArms, pairSameArms, playGame, bullpenRoster } from './engine-helpers.mjs';

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

test('starters tire and get replaced; relievers come in one after another, each used once', () => {
  const roster = bullpenRoster();
  let total = 0, games = 0, starterPitches = [];
  for (let seed = 1; seed <= 12; seed++) {
    let g = E.createGame({ awayId: 'a', homeId: 'b', seed, roster, trials: 100 });
    for (let i = 0; i < 8000 && g.status === 'running'; i++) { const v = E.pendingVote(g, roster); g = v ? E.applyVote(g, roster, v.phase, {}) : E.stepPitch(g, roster).game; }
    assert.equal(g.status, 'final');
    for (const side of ['away', 'home']) {
      const m = g.mound[side];
      assert.equal(new Set(m.used).size, m.used.length, 'nobody comes in twice');
      if (m.used.length) starterPitches.push(m.pc[-1]);
      // The last reliever in has nobody behind him and finishes the game, however long it takes.
      for (const i of m.used.slice(0, -1)) assert.ok(m.pc[i] <= 40, `reliever ${i} threw ${m.pc[i]}`);
    }
    total += g.changes.length; games++;
    for (const c of g.changes) assert.ok(c.from && c.to && c.from !== c.to);
  }
  assert.ok(total / games >= 2 && total / games <= 10, `changes per game ${total / games}`);
  const avg = starterPitches.reduce((a, b) => a + b, 0) / starterPitches.length;
  assert.ok(avg >= 70 && avg <= 108, `starters' average pitch count when relieved ${avg}`);
});

test('pitch locations follow the approach (display only): 유인구 at the edges and off the plate, 정면 승부 over the plate, with misses', () => {
  const r = pair('doosan', 'tigers'), stats = {};
  for (const approach of ['pitch_around', 'standard', 'attack']) {
    let inZone = 0, center = 0, far = 0, balls = 0;
    for (let seed = 0; seed < 12; seed++) {
      let g = E.createGame({ awayId: 'doosan', homeId: 'tigers', seed: 700 + seed, roster: r, trials: 40 });
      for (let i = 0; i < 1500 && g.status === 'running'; i++) {
        const v = E.pendingVote(g, r);
        if (v) { g = E.applyVote(g, r, v.phase, {}); continue; }
        if (g.pa) g.pa.approach = approach;
        const step = E.stepPitch(g, r); g = step.game;
        const p = step.pitch, px = (p.x - 50) / 50, py = (p.y - 50) / 50;
        if (p.call === 'strike' || p.call === 'inplay' || p.call === 'foul') { if (Math.abs(px) < 0.5 && Math.abs(py) < 0.5) { inZone++; if (Math.abs(px) < 0.17 && Math.abs(py) < 0.17) center++; } }
        if (p.call === 'ball') { balls++; if (Math.abs(px) > 0.7 || Math.abs(py) > 0.7) far++; }
      }
    }
    stats[approach] = { centerShare: +(center / Math.max(1, inZone)).toFixed(3), farBalls: +(far / Math.max(1, balls)).toFixed(3) };
  }
  console.log(JSON.stringify(stats));
  assert.ok(stats.attack.centerShare > stats.standard.centerShare && stats.standard.centerShare > stats.pitch_around.centerShare, JSON.stringify(stats));
  assert.ok(stats.pitch_around.centerShare > 0, 'a 유인구 sometimes leaks over the middle');
  assert.ok(stats.pitch_around.farBalls < stats.standard.farBalls, '유인구 balls are mostly just off the plate: ' + JSON.stringify(stats));
});
