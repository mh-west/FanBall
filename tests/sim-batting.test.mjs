// Slow engine simulations, split from pitch-engine.test.mjs so they run in parallel (skipped by npm run quick).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { E, browser, roster, pair, sameArms, pairSameArms, playGame, bullpenRoster } from './engine-helpers.mjs';

test('simulated batting lines match the calibrated targets', () => {
  const totals = {};
  // 150 games: real players are more extreme than the old samples, so 60 games left too much noise.
  for (let seed = 0; seed < 150; seed++) {
    const { game } = playGame('doosan', 'tigers', 1000 + seed, { trials: 400, sameArms: true });
    for (const play of game.plays) {
      const t = totals[play.side] || (totals[play.side] = { PA: 0, AB: 0, H: 0, TB: 0, BB: 0, K: 0, by: {} });
      t.PA++; t.by[play.batter] = (t.by[play.batter] || 0) + 1;
      if (!['BB', 'IBB', 'HBP', 'SAC', 'SF'].includes(play.kind)) t.AB++;
      if (['1B', '2B', '3B', 'HR', 'BUNT_HIT'].includes(play.kind)) { t.H++; t.TB += { '1B': 1, BUNT_HIT: 1, '2B': 2, '3B': 3, HR: 4 }[play.kind]; }
      if (play.kind === 'BB') t.BB++;
      if (play.kind === 'K') t.K++;
    }
  }
  const g = E.createGame({ awayId: 'doosan', homeId: 'tigers', seed: 1, roster: pair('doosan', 'tigers') });
  for (const side of ['away', 'home']) {
    // Targets weighted by how often each batter came up (the top of the order bats more).
    const team = pair('doosan', 'tigers')[side === 'away' ? 'doosan' : 'tigers'], t = totals[side];
    const ps = team.order.map(i => ({ p: g.profiles[side][i], w: t.by[team.players[i][0]] || 0 }));
    const mean = k => ps.reduce((a, x) => a + x.p.target[k] * x.w, 0) / ps.reduce((a, x) => a + x.w, 0);
    const avg = t.H / t.AB, iso = (t.TB - t.H) / t.AB, bb = t.BB / t.PA, k = t.K / t.PA;
    console.log(`${side}: ${t.PA} PA  AVG ${avg.toFixed(3)} (target ${mean('avg').toFixed(3)})  ISO ${iso.toFixed(3)} (${mean('iso').toFixed(3)})  BB ${bb.toFixed(3)} (${mean('bb').toFixed(3)})  K ${k.toFixed(3)} (${mean('k').toFixed(3)})`);
    assert.ok(Math.abs(avg - mean('avg')) < 0.02, `${side} AVG ${avg}`);
    assert.ok(Math.abs(iso - mean('iso')) < 0.025, `${side} ISO ${iso}`);
    assert.ok(Math.abs(bb - mean('bb')) < 0.015, `${side} BB ${bb}`);
    assert.ok(Math.abs(k - mean('k')) < 0.02, `${side} K ${k}`);
  }
});
