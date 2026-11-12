// Slow engine simulations, split from pitch-engine.test.mjs so they run in parallel (skipped by npm run quick).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { E, browser, roster, pair, sameArms, pairSameArms, playGame, bullpenRoster } from './engine-helpers.mjs';

test('an infield single moves runners up only when forced: nobody scores from 2nd', () => {
  const p = () => { const x = ['x', 'IF', 0.3, 0.36, 0.45]; x[12] = 'R'; x[13] = 5; return x; };
  const players = Array.from({ length: 9 }, (_, i) => Object.assign(p(), { 0: `a${i}` }));
  const sp = ['SP', 0.25, 0.08, 0.2]; sp[6] = 'R';
  const team = { players, pitcher: sp, bullpen: [], order: [0, 1, 2, 3, 4, 5, 6, 7, 8] }, roster = { a: team, b: team };
  let infield = 0, outfield = 0, tookThird = 0, stayed = 0;
  for (let seed = 1; seed <= 400; seed++) {
    let g = E.createGame({ awayId: 'a', homeId: 'b', seed, roster, trials: 50 });
    for (let i = 0; i < 400 && g.status === 'running'; i++) {
      const before = { base: [...g.base], no: g.pa?.no ?? g.plays.length + 1 };
      const v = E.pendingVote(g, roster);
      const r = v ? { game: E.applyVote(g, roster, v.phase, {}) } : E.stepPitch(g, roster);
      if (r.play?.kind === '1B' && before.base[1] && !before.base[2] && r.play.outsBefore < 2) {
        if (E.infieldSingle(g.seed, r.play.paNo)) { infield++; assert.equal(r.play.runs, 0, r.play.detail); assert.ok(/내야안타/.test(r.play.detail));
          if (!before.base[0]) { assert.equal(r.game.base[0], r.play.batter); if (r.game.base[2] === before.base[1]) tookThird++; else { assert.equal(r.game.base[1], before.base[1]); stayed++; } } }
        else outfield++;
      }
      g = r.game;
    }
  }
  assert.ok(infield > 0 && outfield > 0, `${infield} ${outfield}`);
  assert.ok(tookThird > 0 && stayed > 0, `runner on 2nd took 3rd ${tookThird}, stayed ${stayed}`);
});
