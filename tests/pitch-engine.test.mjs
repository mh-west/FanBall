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
    for (const side of ['away', 'home']) for (const p of g.profiles[side].filter(Boolean)) {
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
  // 150 games: real players are more extreme than the old samples, so 60 games left too much noise.
  for (let seed = 0; seed < 150; seed++) {
    const { game } = playGame('doosan', 'tigers', 1000 + seed, { trials: 400 });
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

function bullpenRoster() {
  const players = Array.from({ length: 9 }, (_, i) => { const p = [`a${i}`, 'IF', 0.27, 0.34, 0.42]; p[12] = i % 3 === 0 ? 'L' : 'R'; return p; });
  const sp = ['SP', 0.25, 0.08, 0.21]; sp[6] = 'R';
  const pen = [['RP1', 0.22, 0.08, 0.28, null, null, 'R'], ['RP2', 0.24, 0.09, 0.24, null, null, 'L'], ['RP3', 0.26, 0.1, 0.2, null, null, 'R', 'side'],
    ['RP4', 0.27, 0.1, 0.18, null, null, 'R'], ['RP5', 0.25, 0.09, 0.22, null, null, 'L']];
  const team = { players, pitcher: sp, bullpen: pen, order: [0, 1, 2, 3, 4, 5, 6, 7, 8] };
  return { a: team, b: { ...team, players: players.map(p => Object.assign(['b' + p[0].slice(1), ...p.slice(1)], { 12: p[12] })) } };
}

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
      for (const i of m.used) assert.ok(m.pc[i] <= 40, `reliever ${i} threw ${m.pc[i]}`);
    }
    total += g.changes.length; games++;
    for (const c of g.changes) assert.ok(c.from && c.to && c.from !== c.to);
  }
  assert.ok(total / games >= 2 && total / games <= 10, `changes per game ${total / games}`);
  const avg = starterPitches.reduce((a, b) => a + b, 0) / starterPitches.length;
  assert.ok(avg >= 70 && avg <= 108, `starters' average pitch count when relieved ${avg}`);
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
