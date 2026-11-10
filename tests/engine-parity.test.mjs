// Checks that the shared server engine plays exactly the same games as the browser engine.
// Run: cd tests && node --test engine-parity.test.mjs
// The browser scripts (dist/app.js, dist/enhancements.js) run in a vm sandbox (tools/browser-sandbox.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../supabase/functions/_shared/fanball-engine.js';
import { loadBrowserEngine } from '../tools/browser-sandbox.mjs';

const browser = loadBrowserEngine();
const run = browser.run;

function chooser(seed) {
  const random = engine.rng(seed);
  return list => list[Math.floor(random() * list.length)].id;
}

function rosterFor(awayId, homeId) {
  return JSON.parse(run(`JSON.stringify(Object.fromEntries(${JSON.stringify([awayId, homeId])}.map(id=>{const t=team(id);return [id,{players:t.players,pitcher:t.pitcher,order:ln(id).order}]})))`));
}

// Plays a full browser game, choosing tactics at each vote with the given chooser.
function playBrowserGame(awayId, homeId, seed, pickSeed) {
  run(`MATCH.away=${JSON.stringify(awayId)};MATCH.home=${JSON.stringify(homeId)};MATCH.id='parity-'+MATCH.away+'-'+MATCH.home;db.lineups={};db.game=null;db.game=newGame();db.game.seed=${seed};`);
  browser.__pick = chooser(pickSeed);
  const plays = [], ballots = [];
  for (let guard = 0; guard < 400; guard++) {
    const step = JSON.parse(run(`(()=>{window.advanceMatch();const g=db.game,p=g.pendingPresentation;if(!p)return JSON.stringify({final:g.status==='final',play:null});g.pendingPresentation=null;let ballot=null;
      if(p.needsVote&&g.status!=='final'){const b=makeStrategyBallot(g);ballot={offenseTeamId:b.offenseTeamId,defenseTeamId:b.defenseTeamId,offenseChoices:b.offenseChoices,defenseChoices:b.defenseChoices};g.choice=__pick(b.offenseChoices);g.defenseChoice=__pick(b.defenseChoices)}
      return JSON.stringify({final:g.status==='final',play:p.play,ballot})})()`));
    if (step.play) plays.push(step.play);
    if (step.ballot) ballots.push(step.ballot);
    if (step.final) break;
  }
  const game = JSON.parse(run('JSON.stringify(db.game)'));
  return { game, plays, ballots };
}

function playServerGame(awayId, homeId, seed, pickSeed) {
  const roster = rosterFor(awayId, homeId), pick = chooser(pickSeed);
  let game = engine.createGame({ awayId, homeId, seed }), tactics = {};
  const plays = [], ballots = [];
  for (let guard = 0; guard < 400 && game.status === 'running'; guard++) {
    const result = engine.stepPlateAppearance(game, roster, tactics);
    game = result.game; tactics = {};
    if (result.play) plays.push(result.play);
    if (result.needsVote) {
      const ballot = engine.makeStrategyBallot(game, roster);
      ballots.push(ballot);
      tactics = { offense: pick(ballot.offenseChoices), defense: pick(ballot.defenseChoices) };
    }
  }
  return { game, plays, ballots };
}

const fields = p => ({ inn: p.inn, side: p.side, batter: p.batter, kind: p.kind, runs: p.runs, outs: p.outs, base: p.base, basesBefore: p.basesBefore, scoreAfter: p.scoreAfter, choice: p.choice, defenseChoice: p.defenseChoice, counts: p.distribution.counts, pitches: p.pitches });

const matchups = [['doosan', 'tigers'], ['tigers', 'doosan'], ['lg', 'kt'], ['doosan', 'samsung']];

test('server engine plays the same games as the browser engine', () => {
  let games = 0, pas = 0, votes = 0;
  for (const [awayId, homeId] of matchups) {
    for (let i = 0; i < 6; i++) {
      const seed = engine.hash(`${awayId}-${homeId}-${i}`), pickSeed = 1000 + i;
      const a = playBrowserGame(awayId, homeId, seed, pickSeed), b = playServerGame(awayId, homeId, seed, pickSeed);
      const label = `${awayId}@${homeId} seed ${seed}`;
      assert.equal(b.plays.length, a.plays.length, `${label}: plate appearance count`);
      a.plays.forEach((p, n) => assert.deepEqual(fields(b.plays[n]), fields(p), `${label}: PA ${n + 1}`));
      assert.deepEqual(b.ballots, a.ballots, `${label}: vote choices`);
      for (const key of ['status', 'away', 'home', 'innings', 'bat', 'tiebreak']) assert.deepEqual(b.game[key] ?? null, a.game[key] ?? null, `${label}: ${key}`);
      games++; pas += a.plays.length; votes += a.ballots.length;
    }
  }
  console.log(`parity: ${games} games, ${pas} plate appearances, ${votes} votes identical`);
});

test('stepPlateAppearance does not change its input state', () => {
  const roster = rosterFor('doosan', 'tigers'), game = engine.createGame({ awayId: 'doosan', homeId: 'tigers', seed: 7 });
  const before = JSON.stringify(game);
  engine.stepPlateAppearance(game, roster, {});
  assert.equal(JSON.stringify(game), before);
});

test('one plate appearance stays well under the 2s Edge Function CPU limit', () => {
  const roster = rosterFor('doosan', 'tigers');
  let game = engine.createGame({ awayId: 'doosan', homeId: 'tigers', seed: 11 }), worst = 0;
  for (let i = 0; i < 30 && game.status === 'running'; i++) {
    const t = performance.now(); game = engine.stepPlateAppearance(game, roster, {}).game; worst = Math.max(worst, performance.now() - t);
  }
  console.log(`slowest plate appearance: ${worst.toFixed(1)} ms`);
  assert.ok(worst < 500, `slowest PA took ${worst} ms`);
});
