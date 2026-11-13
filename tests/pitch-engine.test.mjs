// Checks the pitch-by-pitch engine (fanball-engine-2): count rules, player calibration, tactic directions,
// determinism and speed. The slow simulations are in sim-*.test.mjs. Run: cd tests && node --test pitch-engine.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { E, browser, roster, pair, sameArms, pairSameArms, playGame, bullpenRoster } from './engine-helpers.mjs';

test('calibration hits every sample matchup target', () => {
  for (const [a, h] of [['doosan', 'tigers'], ['lg', 'kt']]) {
    const g = E.createGame({ awayId: a, homeId: h, seed: 1, roster: pair(a, h) });
    for (const side of ['away', 'home']) for (const p of g.profiles[side].filter(Boolean)) {
      for (const k of ['avg', 'iso', 'bb', 'k']) assert.ok(Math.abs(p.fitted[k] - p.target[k]) < 0.001, `${side} ${k}: ${p.fitted[k]} vs ${p.target[k]}`);
    }
  }
});

test('fielder’s choice retires the lead runner and preserves or advances every other runner legally', () => {
  const R = ['1B', '2B', '3B'];
  const expected = [
    ['B', null, null], // empty
    ['B', null, null], // first: force out at second
    ['B', null, null], // second: lead runner tagged at third
    ['B', '1B', null], // first and second: force out at third, first advances
    ['B', null, null], // third: lead runner retired at home
    ['B', null, '3B'], // first and third: force out at second, third holds (user report 2026-11-13)
    ['B', '2B', null], // second and third: third retired at home, second holds
    ['B', '1B', '2B'], // loaded: force out at home, first and second advance
  ];
  for (let mask = 0; mask < 8; mask++) {
    const before = R.map((_, i) => mask & (1 << i) ? R[i] : null);
    assert.deepEqual(E.fieldersChoiceBases(before, 'B'), expected[mask], `bases ${mask.toString(2).padStart(3, '0')}`);
  }
});

test('tactics move the odds in the intended direction', () => {
  const g = E.createGame({ awayId: 'doosan', homeId: 'tigers', seed: 1, roster: pair('doosan', 'tigers') });
  const profile = g.profiles.away[roster.doosan.order[2]];
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

test('the browser copy of the engine (dist/engine) is identical to the server engine', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['pitch-engine.js', 'count-tables.js']) {
    assert.equal(readFileSync(new URL(`../dist/engine/${f}`, import.meta.url), 'utf8'), readFileSync(new URL(`../supabase/functions/_shared/${f}`, import.meta.url), 'utf8'), `${f}: run cp supabase/functions/_shared/${f} dist/engine/`);
  }
});

test('swinging strikes can come on pitches out of the zone; called strikes are always in it', () => {
  const roster = { a: { players: Array.from({ length: 9 }, (_, i) => [`a${i}`, 'IF', 0.27, 0.34, 0.42]), pitcher: ['P', 0.26, 0.09, 0.2], order: [0, 1, 2, 3, 4, 5, 6, 7, 8] } };
  roster.b = { ...roster.a };
  let g = E.createGame({ awayId: 'a', homeId: 'b', seed: 3, roster, trials: 100 });
  const out = { swinging_strike: 0, called_strike: 0, swings: 0 }, inZone = p => p.x >= 25 && p.x <= 75 && p.y >= 25 && p.y <= 75;
  for (let i = 0; i < 4000 && g.status === 'running'; i++) {
    const r = E.stepPitch(g, roster); g = r.game; const p = r.pitch;
    if (p.result === 'swinging_strike') { out.swings++; if (!inZone(p)) out.swinging_strike++; }
    if (p.result === 'called_strike' && !inZone(p)) out.called_strike++;
  }
  assert.ok(out.swinging_strike > out.swings * 0.25 && out.swinging_strike < out.swings * 0.65, `${out.swinging_strike} of ${out.swings} whiffs outside`);
  assert.equal(out.called_strike, 0);
});

test('pitch locations follow the pitch type: fastballs ride higher, sliders go glove side, changeups arm side; balls stay out of the zone', () => {
  const rhp = ['R', 0.25, 0.08, 0.22, { '포심': [145, 150], '슬라이더': [130, 135], '체인지업': [128, 132] }, { '포심': 50, '슬라이더': 30, '체인지업': 20 }, 'R'];
  const lhp = [...rhp]; lhp[6] = 'L';
  const run = pitcher => {
    const roster = { a: { players: Array.from({ length: 9 }, (_, i) => [`a${i}`, 'IF', 0.27, 0.34, 0.42]), pitcher, order: [0, 1, 2, 3, 4, 5, 6, 7, 8] } };
    roster.b = roster.a;
    let g = E.createGame({ awayId: 'a', homeId: 'b', seed: 11, roster, trials: 100 });
    const by = {}, inZone = p => p.x >= 25 && p.x <= 75 && p.y >= 25 && p.y <= 75;
    let ballsIn = 0, balls = 0, n = 0;
    for (let i = 0; i < 6000 && g.status === 'running'; i++) {
      const r = E.stepPitch(g, roster); g = r.game; const p = r.pitch;
      if (p.call === 'hbp') continue;
      (by[p.type] ||= []).push(p); n++;
      if (p.call === 'ball') { balls++; if (inZone(p)) ballsIn++; }
      assert.ok(p.x >= 0 && p.x <= 100 && p.y >= 0 && p.y <= 100, `on the plot: ${p.x},${p.y}`);
    }
    const mean = (t, k) => by[t].reduce((s, p) => s + p[k], 0) / by[t].length;
    return { by, mean, ballsIn, balls, n };
  };
  const r = run(rhp);
  assert.equal(r.ballsIn, 0, 'balls are out of the zone');
  assert.ok(r.mean('포심', 'y') < r.mean('슬라이더', 'y') && r.mean('포심', 'y') < r.mean('체인지업', 'y'), 'fastballs higher on the plot (smaller y)');
  assert.ok(r.mean('슬라이더', 'x') > 50 && r.mean('체인지업', 'x') < 50, `RHP: slider to the catcher's right ${r.mean('슬라이더', 'x')}, changeup left ${r.mean('체인지업', 'x')}`);
  const share = t => r.by[t].length / r.n;
  assert.ok(Math.abs(share('포심') - 0.5) < 0.08 && Math.abs(share('슬라이더') - 0.3) < 0.08, `usage kept: ${share('포심')}, ${share('슬라이더')}`);
  const l = run(lhp);
  assert.ok(l.mean('슬라이더', 'x') < 50 && l.mean('체인지업', 'x') > 50, 'LHP mirrors it');
});

test('event match: the same team on both sides plays a full game', () => {
  const roster = { lg: { players: Array.from({ length: 9 }, (_, i) => [`l${i}`, 'IF', 0.27, 0.34, 0.42]), pitcher: ['P', 0.26, 0.09, 0.2], order: [0, 1, 2, 3, 4, 5, 6, 7, 8] } };
  let g = E.createGame({ awayId: 'lg', homeId: 'lg', seed: 5, roster, trials: 100 });
  for (let i = 0; i < 6000 && g.status === 'running'; i++) {
    const v = E.pendingVote(g, roster);
    if (v) { assert.equal(v.ballot.offenseTeamId, v.ballot.defenseTeamId); g = E.applyVote(g, roster, v.phase, {}); continue; }
    g = E.stepPitch(g, roster).game;
  }
  assert.equal(g.status, 'final');
  assert.ok(g.inning >= 9);
});

test('later votes never offer the approach already chosen, and can go back to 기본 투구', () => {
  const roster = { a: { players: Array.from({ length: 9 }, (_, i) => [`a${i}`, 'IF', 0.27, 0.34, 0.42]), pitcher: ['P', 0.26, 0.09, 0.2], order: [0, 1, 2, 3, 4, 5, 6, 7, 8] } };
  roster.b = roster.a;
  let g = E.createGame({ awayId: 'a', homeId: 'b', seed: 2, roster, trials: 100 }), seen = 0;
  for (let i = 0; i < 6000 && g.status === 'running'; i++) {
    const v = E.pendingVote(g, roster);
    if (!v) { g = E.stepPitch(g, roster).game; continue; }
    const ids = v.ballot.defenseChoices.map(c => c.id);
    if (v.phase !== 'pre_pa') {
      seen++;
      assert.ok(!ids.includes(g.pa.approach), `${g.pa.approach} offered again: ${ids}`);
      assert.equal(ids.includes('standard_approach'), g.pa.approach !== 'standard');
    }
    // Pick 유인구 승부 before the at-bat, then return to 기본 투구 at the next vote.
    const defense = v.phase === 'pre_pa' ? 'pitch_around' : ids.includes('standard_approach') ? 'standard_approach' : 'keep';
    const before = g.pa?.alignment;
    g = E.applyVote(g, roster, v.phase, { defense });
    if (defense === 'standard_approach') { assert.equal(g.pa.approach, 'standard'); assert.equal(g.pa.alignment, before, 'fielders stay where they were'); }
  }
  assert.ok(seen > 3, `key-count votes seen: ${seen}`);
});

test('nextUp names the next batter and marks a new half-inning, with the pause each needs', () => {
  const roster = { a: { players: Array.from({ length: 9 }, (_, i) => [`a${i}`, 'IF', 0.27, 0.34, 0.42]), pitcher: ['P', 0.26, 0.09, 0.2], order: [0, 1, 2, 3, 4, 5, 6, 7, 8] } };
  roster.b = { ...roster.a, players: roster.a.players.map(p => ['b' + p[0].slice(1), ...p.slice(1)]) };
  let g = E.createGame({ awayId: 'a', homeId: 'b', seed: 4, roster, trials: 100 }), halves = 0, same = 0;
  for (let i = 0; i < 6000 && g.status === 'running'; i++) {
    const v = E.pendingVote(g, roster);
    if (v) { g = E.applyVote(g, roster, v.phase, {}); continue; }
    const r = E.stepPitch(g, roster);
    if (r.play && r.game.status === 'running') {
      const n = E.nextUp(g, r.game, roster);
      assert.equal(n.batter, E.upcomingBatter(r.game, roster));
      assert.equal(n.newHalf, r.game.half !== r.play.side);
      assert.equal(n.gapMs, E.BATTER_INTRO_MS + (n.newHalf ? E.HALF_INNING_MS : 0));
      assert.ok(n.slot >= 1 && n.slot <= 9);
      n.newHalf ? halves++ : same++;
    }
    g = r.game;
  }
  assert.ok(halves >= 16 && same > 20);
});

test('platoon: same-hand matchups favour the pitcher, sidearm widens the gap, left-on-left the most', () => {
  const rb = ['R', 'IF', 0.28, 0.35, 0.44]; rb[12] = 'R';
  const lb = ['L', 'IF', 0.28, 0.35, 0.44]; lb[12] = 'L';
  const rhp = ['RP', 0.26, 0.09, 0.2], lhp = [...rhp]; rhp[6] = 'R'; lhp[6] = 'L';
  const side = [...rhp]; side[7] = 'side';
  const t = (b, p) => E.matchupTargets(b, p);
  assert.ok(t(rb, rhp).avg < t(rb, lhp).avg && t(rb, rhp).k > t(rb, lhp).k, 'RHB worse vs RHP');
  assert.ok(t(lb, lhp).avg < t(lb, rhp).avg && t(lb, lhp).iso < t(lb, rhp).iso, 'LHB worse vs LHP');
  assert.ok(t(lb, rhp).avg - t(lb, lhp).avg > t(rb, lhp).avg - t(rb, rhp).avg, 'left-on-left is the biggest gap');
  assert.ok(t(rb, side).avg < t(rb, rhp).avg, 'a right-handed sidearmer is tougher on right-handed batters');
  const unknown = ['U', 'IF', 0.28, 0.35, 0.44];
  assert.deepEqual(E.platoonFactors(unknown, rhp), null, 'no batting side, no platoon effect');
});


test('fatigue: a tired pitcher gives up more hits and walks', () => {
  const roster = bullpenRoster();
  const g = E.createGame({ awayId: 'a', homeId: 'b', seed: 3, roster, trials: 100 });
  const fresh = E.currentProfile(g, roster, 'away', 0);
  const tired = structuredClone(g); tired.mound.home.pc[-1] = 105;
  const t = E.currentProfile(tired, roster, 'away', 0);
  assert.ok(t.mHit > fresh.mHit * 1.07 && t.mBall > fresh.mBall * 1.07, `${fresh.mHit} -> ${t.mHit}`);
});

test('a game with relievers replays exactly from the same seed and votes', () => {
  const roster = bullpenRoster();
  const run = () => { let g = E.createGame({ awayId: 'a', homeId: 'b', seed: 99, roster, trials: 100 }), log = [];
    for (let i = 0; i < 8000 && g.status === 'running'; i++) { const v = E.pendingVote(g, roster); if (v) { g = E.applyVote(g, roster, v.phase, { defense: v.ballot.defenseChoices.at(-1).id }); continue; } const r = E.stepPitch(g, roster); log.push(r.pitch.result + r.pitch.pitcher); g = r.game; }
    return { log: log.join(','), score: [g.away, g.home], changes: g.changes.map(c => c.to).join() }; };
  assert.deepEqual(run(), run());
});

test('a requested pitching change takes effect before the next plate appearance, not during one', () => {
  const roster = bullpenRoster();
  let g = E.createGame({ awayId: 'a', homeId: 'b', seed: 5, roster, trials: 100 });
  g = E.stepPitch(g, roster).game; // a plate appearance is in progress
  const free = E.availableRelievers(g, roster, 'home');
  assert.equal(free.length, 5);
  const pick = free.find(r => r.throws === 'L');
  g = E.requestPitcherChange(g, roster, 'home', pick.index);
  assert.equal(E.currentPitcher(g, roster, 'home')[0], 'SP', 'the starter finishes this batter');
  while (g.pa) g = E.stepPitch(g, roster).game;
  if (g.half === 'away') {
    assert.equal(E.plannedChange(g, roster)?.to, pick.name);
    g = E.stepPitch(g, roster).game;
    assert.equal(E.currentPitcher(g, roster, 'home')[0], pick.name);
    assert.equal(g.changes.at(-1).requested, true);
    assert.ok(!E.availableRelievers(g, roster, 'home').some(r => r.index === pick.index), 'he cannot be brought in again');
  }
  assert.throws(() => E.requestPitcherChange(g, roster, 'home', 99), /cannot come in/);
});

test('runner speed: fast runners take more extra bases, fast batters hit into fewer double plays', () => {
  const p = sp => { const x = ['x', 'IF', 0.27, 0.34, 0.42]; x[12] = 'R'; x[13] = sp; return x; };
  const prof = E.calibrateMatchup(p(3), ['P', 0.26, 0.09, 0.2]);
  const dp = sp => E.inPlayShares('0-0', prof, {}, { runnerOnFirst: true, outs: 0, batterSpeed: sp }).DP;
  assert.ok(dp(5) < dp(3) && dp(3) < dp(1), `${dp(5)} ${dp(3)} ${dp(1)}`);
  const sf = sp => E.inPlayShares('0-0', prof, {}, { runnerOnThird: true, outs: 0, thirdSpeed: sp }).SAC_FLY;
  assert.ok(sf(5) > sf(1));
  assert.equal(E.speedGrade(undefined), 3); assert.equal(E.speedGrade(7), 3); assert.equal(E.speedGrade(4), 4);
});

test('aiming pitches never changes results: the same seed gives the same plays whatever the display', () => {
  const a = playGame('lg', 'kt', 4242, { trials: 80, pick: () => ({ approach: 'pitch_around' }) }).game;
  const b = playGame('lg', 'kt', 4242, { trials: 80, pick: () => ({ approach: 'pitch_around' }) }).game;
  assert.deepEqual(a.plays.map(p => p.kind), b.plays.map(p => p.kind));
});

test('bunts against a charging infield (2.18): more outs and some double plays, most for a slow batter', () => {
  const p = sp => { const x = ['x', 'IF', 0.25, 0.31, 0.33]; x[12] = 'R'; x[13] = sp; return x; };
  const prof = E.calibrateMatchup(p(3), ['P', 0.26, 0.09, 0.2]);
  const odds = (alignment, sp) => {
    const o = E.plateAppearanceOdds(prof, { offense: 'bunt', alignment, approach: 'standard' }, '0-0', { bunting: true });
    return o.bunt;
  };
  const std = odds('standard'), inn = odds('infield_in');
  assert.ok(inn.out > std.out && inn.doublePlay > std.doublePlay && inn.sacrifice < std.sacrifice, JSON.stringify({ std, inn }));
  assert.ok(std.doublePlay > 0, 'a bunt double play can happen');
});

test('engine 2.19 team plans: each has a cost, a voted tactic replaces them, and a plan change is recorded', async () => {
  const E = await import('../dist/engine/pitch-engine.js');
  const prof = { mBall: 1, mWhiff: 1, mHit: 1, mPow: 1 }, base = { offense: 'normal', alignment: 'standard', approach: 'standard' };
  const odds = t => { const o = E.plateAppearanceOdds(prof, { ...base, ...t }), b = o.bip; return { bb: o.BB, k: o.K, hr: b.HR, woba: .69 * o.BB + .72 * o.HBP + .89 * b['1B'] + 1.27 * b['2B'] + 1.62 * b['3B'] + 2.1 * b.HR }; };
  const n = odds({});
  const patient = odds({ offensePlan: 'patient' }), first = odds({ offensePlan: 'first_pitch' }), power = odds({ offensePlan: 'power' }), contact = odds({ offensePlan: 'contact' });
  assert.ok(patient.bb > n.bb && patient.k > n.k, '공 길게 보기: more walks, more strikeouts');
  assert.ok(first.bb < n.bb && first.k < n.k, '초구 공략: fewer walks and strikeouts');
  assert.ok(power.hr > n.hr && power.k > n.k, '장타: more home runs and strikeouts');
  assert.ok(contact.k < n.k && contact.hr < n.hr, '맞히기: fewer strikeouts and home runs');
  const aggr = odds({ defensePlan: 'aggressive' }), careful = odds({ defensePlan: 'careful' });
  assert.ok(aggr.bb < n.bb && aggr.hr > n.hr && careful.bb > n.bb && careful.hr < n.hr);
  for (const o of [patient, first, power, contact, aggr, careful]) assert.ok(Math.abs(o.woba - n.woba) < 0.008, 'no plan is far better than 기본');
  // setPlan stores the plan; createGame takes initial plans.
  const g = E.setPlan({ plans: { home: { offense: 'power' } } }, 'home', 'defense', 'careful');
  assert.deepEqual(g.plans.home, { offense: 'power', defense: 'careful' });
  assert.throws(() => E.setPlan(g, 'home', 'offense', 'bunt'), /unknown plan/);
  assert.equal(E.planOf(g, 'away', 'offense'), 'normal');
});

test('engine 2.20/2.21: double plays with a runner on 1st come from who fields the ground ball; slower runners and batters are turned more often', async () => {
  const E = await import('../dist/engine/pitch-engine.js');
  const prof = { mBall: 1, mWhiff: 1, mHit: 1, mPow: 1 }, t = { offense: 'normal', alignment: 'standard', approach: 'standard' };
  const dp = (b, r) => E.inPlayShares('1-1', prof, t, { runnerOnFirst: true, outs: 1, batterSpeed: b, firstSpeed: r }).DP;
  assert.ok(dp(3, 1) > dp(3, 3) && dp(3, 3) > dp(3, 5), 'a slow runner on 1st is doubled up more often');
  assert.ok(dp(1, 3) > dp(5, 3), 'a slow batter too');
  assert.equal(E.inPlayShares('1-1', prof, t, { runnerOnFirst: true, outs: 2 }).DP, 0, 'no double play with two outs');
  const { turn, force } = E.SPEED.groundDp;
  assert.ok(turn.SS > turn['1B'] && turn['2B'] > turn['1B'] && turn.P >= turn.SS, 'middle infielders and the pitcher turn two more easily than the first baseman');
  assert.ok(force['2B'] > 0.5 && E.SPEED.forceAtSecond.runner[1] > E.SPEED.forceAtSecond.runner[5], 'otherwise the runner is usually forced at 2nd, a slow one more often');
  assert.ok(E.SPEED.infieldHit[1] < E.SPEED.infieldHit[5], 'infield hits need speed');
});

test('engine 2.21: batted balls follow the pitch location: an inside pitch is pulled, so a right-handed batter rarely lines it to the second baseman', async () => {
  const E = await import('../dist/engine/pitch-engine.js');
  const lines = (x, lefty) => { const c = {}; for (let pa = 1; pa < 20000; pa++) { const d = E.playDetail('OUT', { x, y: 50 }, 4242, pa, lefty); if (/직선타/.test(d)) { const f = d.split(' ')[0]; c[f] = (c[f] || 0) + 1; } } return c; };
  const rIn = lines(30, false), lIn = lines(70, true), rOut = lines(70, false);
  assert.ok(rIn['유격수'] > 3 * rIn['2루수'], `RHB inside: ${JSON.stringify(rIn)}`);
  assert.ok(lIn['2루수'] > 3 * lIn['유격수'], `LHB inside: ${JSON.stringify(lIn)}`);
  assert.ok(rOut['2루수'] > rIn['2루수'], 'an outside pitch goes the other way more often');
  assert.ok(E.SPEED.groundDp.turn.P > 0.3);
});
