// Slow engine simulations, split from pitch-engine.test.mjs so they run in parallel (skipped by npm run quick).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { E, browser, roster, pair, sameArms, pairSameArms, playGame, bullpenRoster } from './engine-helpers.mjs';

test('runner on third, fewer than two outs: outs split into sacrifice flies and ground out RBIs at measured rates', () => {
  const r = pair('doosan', 'tigers'), g = E.createGame({ awayId: 'doosan', homeId: 'tigers', seed: 1, roster: r }), prof = g.profiles.away[r.doosan.order[3]];
  const at = (outs, tactics = {}) => E.inPlayShares('0-0', prof, tactics, { runnerOnFirst: false, runnerOnThird: true, outs });
  const s = at(1), outs = s.OUT + s.SAC_FLY + s.GO_RBI;
  assert.ok(Math.abs(s.SAC_FLY / outs - (1564 / 3272) * (1294 / 1564) - (533 / 3272) * (4 / 533)) < 0.001, 'sacrifice fly share');
  assert.ok(Math.abs(s.GO_RBI / outs - (1175 / 3272) * (763 / 1175)) < 0.001, 'ground out RBI share');
  const two = at(2);
  assert.equal(two.SAC_FLY, 0); assert.equal(two.GO_RBI, 0);
  assert.ok(at(1, { alignment: 'infield_in' }).GO_RBI < s.GO_RBI * 0.4, 'infield in cuts ground-out runs');
  // In play the run really scores and is recorded as SF / GO_RBI.
  let seen = { SF: 0, GO_RBI: 0 };
  for (let seed = 0; seed < 40; seed++) {
    let st = E.createGame({ awayId: 'doosan', homeId: 'tigers', seed: 900 + seed, roster: r, trials: 500 });
    while (st.status === 'running') { const v = E.pendingVote(st, r); if (v) { st = E.applyVote(st, r, v.phase, {}); continue } const step = E.stepPitch(st, r); if (step.play && (step.play.kind === 'SF' || step.play.kind === 'GO_RBI')) { seen[step.play.kind]++; assert.equal(step.play.runs >= 1, true); assert.ok(step.play.basesBefore[2]); } st = step.game; }
  }
  assert.ok(seen.SF > 0 && seen.GO_RBI > 0, JSON.stringify(seen));
});

test('outs in play move runners (2.15, 2.20): ground outs advance the runner from 1st or force him at 2nd, fly outs let the runner on 2nd tag up, GO_RBI moves the others up', () => {
  const mk = i => { const x = [`a${i}`, 'IF', 0.27, 0.34, 0.42]; x[12] = 'R'; x[13] = 3; return x; };
  const players = Array.from({ length: 9 }, (_, i) => mk(i)), sp = ['SP', 0.25, 0.08, 0.2]; sp[6] = 'R';
  const team = { players, pitcher: sp, bullpen: [], order: [0, 1, 2, 3, 4, 5, 6, 7, 8] }, roster = { a: team, b: team };
  const seen = { groundFirst: 0, groundFirstMoved: 0, groundFirstForced: 0, flySecond: 0, flyTag: 0, goRbiSecond: 0, goRbiSecondTo3rd: 0 };
  for (let seed = 1; seed <= 150; seed++) {
    let g = E.createGame({ awayId: 'a', homeId: 'b', seed, roster, trials: 50 });
    for (let i = 0; i < 600 && g.status === 'running'; i++) {
      const before = [...g.base], outs = g.outs, v = E.pendingVote(g, roster);
      const r = v ? { game: E.applyVote(g, roster, v.phase, {}) } : E.stepPitch(g, roster);
      const p = r.play;
      if (p && p.outsAfter < 3) {
        const last = p.pitches[p.pitches.length - 1];
        if (p.kind === 'OUT' && before[0] && !before[1] && !before[2] && outs < 2 && E.outType(g.seed, p.paNo, last) === 'ground') {
          seen.groundFirst++;
          if (r.game.base[1] === before[0] && !r.game.base[0]) seen.groundFirstMoved++; // batter out at 1st, runner to 2nd
          else if (r.game.base[0] === p.batter && !r.game.base[1] && /2루 포스아웃/.test(p.detail)) seen.groundFirstForced++; // 2.20: runner forced at 2nd
          assert.ok(/땅볼/.test(p.detail), p.detail);
        }
        if (p.kind === 'OUT' && before[1] && !before[0] && !before[2] && E.outType(g.seed, p.paNo, last) === 'fly') {
          seen.flySecond++; if (r.game.base[2] === before[1]) seen.flyTag++;
        }
        if (p.kind === 'GO_RBI' && before[1]) { seen.goRbiSecond++; if (r.game.base[2] === before[1]) seen.goRbiSecondTo3rd++; }
      }
      g = r.game;
    }
  }
  assert.ok(seen.groundFirst > 0 && seen.groundFirstMoved + seen.groundFirstForced === seen.groundFirst, JSON.stringify(seen));
  assert.ok(seen.groundFirstMoved > 0 && seen.groundFirstForced > 0, `both happen: ${JSON.stringify(seen)}`);
  assert.ok(seen.flySecond > 0 && seen.flyTag > 0 && seen.flyTag < seen.flySecond, JSON.stringify(seen));
  assert.ok(seen.goRbiSecond === 0 || seen.goRbiSecondTo3rd === seen.goRbiSecond, JSON.stringify(seen));
});
