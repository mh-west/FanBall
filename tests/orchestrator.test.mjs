// Plays official games end to end with the real tick code (pitch engine) against PGlite with all
// migrations. Time is fast-forwarded by moving each due time into the past before every tick.
// Run: cd tests && npm install && node --test orchestrator.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSupabaseLikeDb } from './db-setup.mjs';
import { runTick, advanceGame, runLoop } from '../supabase/functions/_shared/orchestrator.js';
import * as engine from '../supabase/functions/_shared/pitch-engine.js';
import { loadBrowserEngine, sampleRoster } from '../tools/browser-sandbox.mjs';

let db;
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const all = async (sql, params) => (await db.query(sql, params)).rows;
const FAN_AWAY = '00000000-0000-0000-0000-0000000000a1', FAN_HOME = '00000000-0000-0000-0000-0000000000b1';
const SETOF = new Set(['start_due_fanball_games', 'due_fanball_games']);

// Same contract as supabase-js rpc(): named arguments in, the function result out, errors thrown.
const openCalls = [];
async function rpc(name, args = {}) {
  if (name === 'open_tactical_round') openCalls.push({ p_phase: args.p_phase, p_seconds: args.p_seconds });
  const keys = Object.keys(args);
  const values = keys.map(k => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]));
  const rows = (await db.query(`select * from public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`, values)).rows;
  if (SETOF.has(name)) return rows.map(r => Object.values(r)[0]);
  const row = rows[0];
  return row && Object.keys(row).length === 1 && name in row ? row[name] : row;
}

async function fastForward() {
  await db.exec(`
    update public.fanball_game_private set next_action_at = now() - interval '1 second' where next_action is not null;
    update public.tactical_rounds set opens_at = now() - interval '20 seconds', closes_at = now() - interval '1 second' where status = 'open';
  `);
}

async function asUser(user, sql, params) {
  await db.exec(`set role authenticated`);
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [user]);
  try { return await db.query(sql, params); } finally { await db.exec('reset role'); }
}

async function insertGame(kboId, awayId, homeId, roster) {
  await db.query(`insert into public.kbo_games(id, game_date, scheduled_at, away_team_id, home_team_id, provider) values ($1, current_date, now() - interval '1 second', $2, $3, 'demo')`, [kboId, awayId, homeId]);
  return (await one(`insert into public.fanball_games(kbo_game_id, lineup_snapshot) values ($1, $2) returning id`, [kboId, JSON.stringify({ teams: roster })])).id;
}

// Each fan votes for the last listed (non-default) choice of their role, when it is their turn.
async function voteOnOpenRounds(gameId) {
  const rounds = await all(`select id from public.tactical_rounds where game_id = $1 and status = 'open'`, [gameId]);
  for (const r of rounds) {
    for (const [user, role] of [[FAN_AWAY, 'offense'], [FAN_HOME, 'defense']]) {
      const choice = await one(`select c.id from public.tactical_choices c join public.tactical_rounds t on t.id = c.round_id
        join public.fanball_game_memberships m on m.game_id = t.game_id and m.user_id = $2
        where c.round_id = $1 and c.role = $3 and not c.is_default and m.team_id = case when $3 = 'offense' then t.offense_team_id else t.defense_team_id end
        order by c.choice_key desc limit 1`, [r.id, user, role]);
      if (choice) await asUser(user, `select public.submit_tactical_vote($1, $2)`, [r.id, choice.id]);
    }
  }
}

let roster;
before(async () => {
  db = await createSupabaseLikeDb();
  roster = sampleRoster(loadBrowserEngine(), ['doosan', 'tigers', 'lg', 'kt']);
  await db.exec(`insert into auth.users values ('${FAN_AWAY}'), ('${FAN_HOME}');
    insert into public.profiles(user_id, favorite_team_id) values ('${FAN_AWAY}', 'doosan'), ('${FAN_HOME}', 'tigers');`);
});

test('a full pitch-by-pitch game runs to the end and replays exactly from the revealed seed', async () => {
  const teams = { doosan: roster.doosan, tigers: roster.tigers };
  const gameId = await insertGame('demo-full', 'doosan', 'tigers', teams);
  for (const user of [FAN_AWAY, FAN_HOME]) await asUser(user, `select public.join_fanball_game($1)`, [gameId]);
  const first = await runTick(rpc);
  assert.deepEqual(first.started, [gameId]);
  const seedHash = (await one(`select seed_hash from public.fanball_games where id = $1`, [gameId])).seed_hash;

  let ticks = 0;
  for (; ticks < 3000; ticks++) {
    if ((await one(`select status from public.fanball_games where id = $1`, [gameId])).status === 'final') break;
    await voteOnOpenRounds(gameId);
    await fastForward();
    const { results } = await runTick(rpc);
    for (const r of results) assert.ok(!r.error, `tick error: ${r.error}`);
  }
  const game = await one(`select * from public.fanball_games where id = $1`, [gameId]);
  assert.equal(game.status, 'final');
  assert.equal(game.model_version, engine.ENGINE_VERSION);
  assert.equal(createHash('sha256').update(String(game.revealed_seed)).digest('hex'), seedHash);

  const pitches = await all(`select pitch_no, pa_no, count_before, call, result from public.pitches where game_id = $1 order by pitch_no`, [gameId]);
  const pas = await all(`select pa_no, outcome, runs from public.plate_appearances where game_id = $1 order by pa_no`, [gameId]);
  const rounds = await all(`select r.pa_no, r.phase, r.status, (select c.choice_key from public.tactical_choices c where c.id = s.offense_choice_id) offense,
      (select c.choice_key from public.tactical_choices c where c.id = s.defense_choice_id) defense, s.fallback_roles
    from public.tactical_rounds r join public.tactical_resolutions s on s.round_id = r.id where r.game_id = $1`, [gameId]);
  assert.equal((await one(`select count(*)::int n from public.tactical_rounds where game_id = $1 and status <> 'resolved'`, [gameId])).n, 0);
  assert.equal((await one(`select count(*)::int n from public.tactical_rounds where game_id = $1 and coalesce(state_snapshot->>'batter','') = ''`, [gameId])).n, 0, 'every vote names the batter');
  assert.equal(pitches.map(p => p.pitch_no).join(), pitches.map((_, i) => i + 1).join(), 'pitch numbers have no gaps');

  // Replay: the revealed seed + the recorded vote results must give the same pitches and score.
  const decided = new Map(rounds.map(r => [`${r.pa_no}:${r.phase}`, { offense: r.offense, defense: r.defense }]));
  // Sides with fans manage their own pitchers (engine 2.12); the stored state records which.
  const privateState = await one(`select engine_state from public.fanball_game_private where game_id = $1`, [gameId]);
  let s = engine.createGame({ awayId: 'doosan', homeId: 'tigers', seed: Number(game.revealed_seed), roster: teams, manual: privateState.engine_state?.manual });
  let i = 0, votesReplayed = 0;
  while (s.status === 'running') {
    const v = engine.pendingVote(s, teams);
    if (v) {
      const d = decided.get(`${s.pa?.no ?? s.plays.length + 1}:${v.phase}`);
      assert.ok(d, `round ${v.phase} recorded`);
      s = engine.applyVote(s, teams, v.phase, d); votesReplayed++; continue;
    }
    const step = engine.stepPitch(s, teams);
    assert.equal(step.pitch.result, pitches[i].result, `pitch ${i + 1}`);
    i++; s = step.game;
  }
  assert.equal(i, pitches.length);
  assert.equal(votesReplayed, rounds.length);
  assert.deepEqual(game.score, { away: s.away, home: s.home });
  assert.deepEqual(pas.map(p => p.outcome), s.plays.map(p => p.kind));

  assert.ok(openCalls.length > 0 && openCalls.every(c => c.p_seconds === (c.p_phase === 'pre_pa' ? 10 : 8)), 'pre-PA votes 10 s, later votes in the at-bat 8 s');
  const phases = rounds.reduce((m, r) => ({ ...m, [r.phase]: (m[r.phase] || 0) + 1 }), {});
  const nonDefault = rounds.filter(r => !r.fallback_roles.length).length;
  assert.ok(phases.pre_pa > 0 && phases.two_strikes > 0, 'pre-PA and key-count votes happened');
  assert.ok(nonDefault > 0, 'fan votes were applied');
  console.log(`full game ${s.away}:${s.home}: ${pitches.length} pitches, ${pas.length} PAs, rounds ${JSON.stringify(phases)}, ${nonDefault} decided by votes, ${ticks} ticks`);

  // Nothing is left to do, and nothing re-runs.
  assert.deepEqual((await runTick(rpc)).results, []);
});

test('two ticks racing on the same pitch record one pitch', async () => {
  const gameId = await insertGame('demo-race', 'lg', 'kt', { lg: roster.lg, kt: roster.kt });
  await runTick(rpc);
  // Move to a plain pitch step (skip a vote if the game opened with one).
  for (let k = 0; k < 10; k++) {
    const p = await one(`select next_action from public.fanball_game_private where game_id = $1`, [gameId]);
    if (p.next_action === 'pitch') break;
    await fastForward(); await runTick(rpc);
  }
  await fastForward();
  const count = async () => (await one(`select count(*)::int n from public.pitches where game_id = $1`, [gameId])).n;
  const before = await count();
  const [a, b] = await Promise.all([advanceGame(rpc, gameId), advanceGame(rpc, gameId)]);
  assert.deepEqual([a.committed, b.committed].sort(), [false, true]);
  assert.equal(await count(), before + 1);
});

test('a step that is not due yet does nothing', async () => {
  const gameId = (await one(`select id from public.fanball_games where kbo_game_id = 'demo-race'`)).id;
  await db.query(`update public.fanball_game_private set next_action_at = now() + interval '1 minute' where game_id = $1`, [gameId]);
  assert.equal((await advanceGame(rpc, gameId)).skipped, 'not due');
});

test('browser roles cannot read orchestrator state or trigger dispatch', async () => {
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`);
    try {
      await assert.rejects(db.query(`select public.get_orchestrator_game(gen_random_uuid())`), /permission denied/);
      await assert.rejects(db.query(`select public.orchestrator_dispatch()`), /permission denied/);
    } finally { await db.exec('reset role'); }
  }
});

test('one call keeps pitching on time for its budget, holding and then releasing a lease', async () => {
  const gameId = await insertGame('demo-loop', 'doosan', 'tigers', { doosan: roster.doosan, tigers: roster.tigers });
  // Fake clock: each sleep moves time forward and makes every waiting step due in the database too.
  let t = Date.now(), leases = [];
  const sleep = async ms => {
    t += ms;
    leases.push((await one(`select dispatched_at from public.fanball_game_private where game_id = $1`, [gameId])).dispatched_at);
    await fastForward();
  };
  const steps = await runLoop(rpc, { budgetMs: 60000, now: () => t, sleep });
  const pitches = steps.filter(s => s.action === 'pitch' && s.committed).length;
  const votes = steps.filter(s => s.action === 'open_round' && s.committed).length;
  assert.ok(steps.every(s => !s.error), 'no errors');
  assert.ok(pitches >= 10, `pitched ${pitches} times in one call`);
  // While sleeping, the lease was ahead of the clock; at the end it is released.
  assert.ok(leases.length > 0 && leases.every(l => new Date(l).getTime() > t - 60000 - 1000));
  const end = (await one(`select dispatched_at, next_action from public.fanball_game_private where game_id = $1`, [gameId]));
  assert.ok(new Date(end.dispatched_at).getTime() <= t + 1, 'lease released');
  console.log(`one call: ${pitches} pitches, ${votes} votes opened, ${steps.length} steps, then next step ${end.next_action}`);
});

test('the dispatcher skips a leased game and would dispatch a free one', async () => {
  const gameId = (await one(`select id from public.fanball_games where kbo_game_id = 'demo-loop'`)).id;
  await db.exec(`update public.fanball_games set status = 'final' where kbo_game_id <> 'demo-loop' and status = 'running'`);
  await db.query(`update public.fanball_game_private set next_action_at = now() - interval '1 second', dispatched_at = now() + interval '10 seconds' where game_id = $1`, [gameId]);
  assert.equal((await one(`select public.orchestrator_dispatch() as d`)).d, false, 'leased game is skipped');
  await db.query(`update public.fanball_game_private set dispatched_at = now() - interval '6 seconds' where game_id = $1`, [gameId]);
  // A free due game goes on to read the Vault (not present in the local test database).
  await assert.rejects(db.query(`select public.orchestrator_dispatch()`), /vault/);
});

test('event match: away and home fans of the same team vote their own lineups and tactics', async () => {
  const A = '00000000-0000-0000-0000-0000000000c1', B = '00000000-0000-0000-0000-0000000000c2', C = '00000000-0000-0000-0000-0000000000c3';
  await db.exec(`insert into auth.users values ('${A}'), ('${B}'), ('${C}');
    insert into public.profiles(user_id, favorite_team_id) values ('${A}', 'lg'), ('${B}', 'lg'), ('${C}', 'lg');`);
  await db.query(`insert into public.kbo_games(id, game_date, scheduled_at, away_team_id, home_team_id, provider) values ('demo-event', current_date, now() + interval '1 hour', 'lg', 'lg', 'demo')`);
  const gameId = (await one(`insert into public.fanball_games(kbo_game_id, lineup_snapshot) values ('demo-event', $1) returning id`, [JSON.stringify({ teams: { lg: roster.lg, 'lg@away': roster.lg } })])).id;

  // Before picking a side a fan of the team has no team in this game and cannot submit a lineup.
  assert.equal((await asUser(A, `select (public.join_fanball_game($1)).team_id t`, [gameId])).rows[0].t, null);
  const names = roster.lg.order.map(i => roster.lg.players[i][0]), POS = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH'];
  const slots = list => JSON.stringify(list.map((player, k) => ({ player, pos: POS[k] })));
  await assert.rejects(asUser(A, `select public.submit_fanball_lineup($1, $2)`, [gameId, slots(names)]), /pick a side first/);
  // A picks away, B home; C picks away, then switches to home, and the lineup moves along.
  for (const [u, side] of [[A, 'away'], [B, 'home'], [C, 'away']]) await asUser(u, `select public.choose_fanball_side($1, $2)`, [gameId, side]);
  const reversed = [...names].reverse();
  await asUser(A, `select public.submit_fanball_lineup($1, $2)`, [gameId, slots(reversed)]);
  await asUser(B, `select public.submit_fanball_lineup($1, $2)`, [gameId, slots(names)]);
  await asUser(C, `select public.submit_fanball_lineup($1, $2)`, [gameId, slots(names)]);
  await asUser(C, `select public.choose_fanball_side($1, 'home')`, [gameId]);
  assert.deepEqual((await all(`select team_id, count(*)::int n from public.lineup_submissions where game_id = $1 group by 1 order by 1`, [gameId])).map(r => [r.team_id, r.n]), [['lg', 2], ['lg@away', 1]]);

  await db.query(`update public.kbo_games set scheduled_at = now() - interval '1 second' where id = 'demo-event'`);
  await runTick(rpc);
  const snapRow = await one(`select lineup_snapshot s from public.fanball_games where id = $1`, [gameId]);
  const orderNames = key => snapRow.s.teams[key].order.map(i => snapRow.s.teams[key].players[i][0]);
  assert.deepEqual(orderNames('lg@away'), reversed, 'away lineup from the away fans');
  assert.deepEqual(orderNames('lg'), names, 'home lineup from the home fans');
  await assert.rejects(asUser(C, `select public.choose_fanball_side($1, 'away')`, [gameId]), /fixed once the game starts/);

  const votes = { offense: 0, defense: 0 };
  for (let ticks = 0; ticks < 3000; ticks++) {
    if ((await one(`select status from public.fanball_games where id = $1`, [gameId])).status === 'final') break;
    for (const r of await all(`select id, offense_team_id o, defense_team_id d from public.tactical_rounds where game_id = $1 and status = 'open'`, [gameId])) {
      assert.deepEqual([r.o, r.d].sort(), ['lg', 'lg@away']);
      for (const [u, key] of [[A, 'lg@away'], [B, 'lg']]) {
        const role = key === r.o ? 'offense' : 'defense';
        const c = await one(`select id from public.tactical_choices where round_id = $1 and role = $2 and not is_default order by choice_key desc limit 1`, [r.id, role]);
        if (c) { await asUser(u, `select public.submit_tactical_vote($1, $2)`, [r.id, c.id]); votes[role]++; }
      }
    }
    await fastForward();
    const { results } = await runTick(rpc);
    for (const x of results) assert.ok(!x.error, `tick error: ${x.error}`);
  }
  assert.equal((await one(`select status from public.fanball_games where id = $1`, [gameId])).status, 'final');
  assert.ok(votes.offense > 0 && votes.defense > 0, `both sides voted ${JSON.stringify(votes)}`);
});

test('engine 2.8 on the server: relievers come in, every pitch names its pitcher, and the game finishes', async () => {
  const pen = [['RP1', 0.22, 0.08, 0.28, null, null, 'R'], ['RP2', 0.24, 0.09, 0.24, null, null, 'L'], ['RP3', 0.26, 0.1, 0.2, null, null, 'R', 'side'],
    ['RP4', 0.27, 0.1, 0.18, null, null, 'R'], ['RP5', 0.25, 0.09, 0.22, null, null, 'L']];
  const teams = { kt: { ...roster.kt, bullpen: pen }, lg: { ...roster.lg, bullpen: pen.map(p => ['L' + p[0], ...p.slice(1)]) } };
  const gameId = await insertGame('demo-bullpen', 'kt', 'lg', teams);
  await runTick(rpc);
  for (let ticks = 0; ticks < 4000; ticks++) {
    if ((await one(`select status from public.fanball_games where id = $1`, [gameId])).status === 'final') break;
    await fastForward();
    const { results } = await runTick(rpc);
    for (const x of results) assert.ok(!x.error, `tick error: ${x.error}`);
  }
  assert.equal((await one(`select status from public.fanball_games where id = $1`, [gameId])).status, 'final');
  const names = (await all(`select distinct payload->>'pitcher' p from public.pitches where game_id = $1`, [gameId])).map(r => r.p);
  assert.ok(!names.includes(null), 'every pitch names its pitcher');
  assert.ok(names.length >= 4, `pitchers used: ${names.join(', ')}`);
});

test('fans change the pitcher: 80% of the fielding side asks, they vote for a reliever, he pitches the next plate appearance', async () => {
  const F1 = '00000000-0000-0000-0000-0000000000e1', F2 = '00000000-0000-0000-0000-0000000000e2', OTHER = '00000000-0000-0000-0000-0000000000e3';
  await db.exec(`insert into auth.users values ('${F1}'), ('${F2}'), ('${OTHER}');
    insert into public.profiles(user_id, favorite_team_id) values ('${F1}', 'kt'), ('${F2}', 'kt'), ('${OTHER}', 'doosan');`);
  const pen = [['RP1', 0.22, 0.08, 0.28, null, null, 'R'], ['RP2', 0.24, 0.09, 0.24, null, null, 'L'], ['RP3', 0.26, 0.1, 0.2, null, null, 'R', 'side']];
  const teams = { doosan: { ...roster.doosan, bullpen: pen.map(p => ['D' + p[0], ...p.slice(1)]) }, kt: { ...roster.kt, bullpen: pen } };
  const gameId = await insertGame('demo-change', 'doosan', 'kt', teams); // kt is home: it fields in the top half
  for (const u of [F1, F2, OTHER]) await asUser(u, `select public.join_fanball_game($1)`, [gameId]);
  await runTick(rpc);
  // Let a few pitches go by, then one kt fan asks: 1 of 2 is not enough.
  for (let i = 0; i < 6; i++) { await fastForward(); await runTick(rpc); }
  const starter = teams.kt.pitcher[0];
  await asUser(F1, `select public.request_pitching_change($1, $2)`, [gameId, starter]);
  await assert.rejects(asUser(OTHER, `select public.request_pitching_change($1, $2)`, [gameId, starter]).then(async () => {
    const s = (await asUser(OTHER, `select public.pitching_change_status($1) s`, [gameId])).rows[0].s;
    assert.equal(s.requests.filter(r => r.side === 'kt').reduce((n, r) => n + Number(r.n), 0), 1, 'a doosan fan counts for doosan, not kt');
    throw new Error('checked');
  }), /checked/);
  let round = null;
  for (let i = 0; i < 60 && !round; i++) {
    if (i === 3) await asUser(F2, `select public.request_pitching_change($1, $2)`, [gameId, starter]); // now 2 of 2
    await fastForward(); await runTick(rpc);
    round = await one(`select id, defense_team_id from public.tactical_rounds where game_id = $1 and phase = 'pitcher_change'`, [gameId]);
  }
  assert.ok(round, 'a reliever vote opened');
  assert.equal(round.defense_team_id, 'kt');
  assert.equal((await one(`select count(*)::int n from public.pitching_change_requests where game_id = $1 and side_key = 'kt'`, [gameId])).n, 0, 'requests cleared');
  const rp2 = await one(`select id from public.tactical_choices where round_id = $1 and choice_key = 'rp:1'`, [round.id]);
  for (const u of [F1, F2]) await asUser(u, `select public.submit_tactical_vote($1, $2)`, [round.id, rp2.id]);
  for (let i = 0; i < 40; i++) {
    await fastForward(); await runTick(rpc);
    const used = await one(`select payload->>'pitcher' p from public.pitches where game_id = $1 and payload->>'side' = 'away' order by pitch_no desc limit 1`, [gameId]);
    if (used?.p === 'RP2') break;
  }
  const last = await one(`select payload->>'pitcher' p from public.pitches where game_id = $1 and payload->>'side' = 'away' order by pitch_no desc limit 1`, [gameId]);
  assert.equal(last.p, 'RP2', 'the voted reliever pitches to the visitors');
});
