// Plays official games end to end with the real tick code against PGlite with all migrations.
// Time is fast-forwarded by moving each due time into the past before every tick.
// Run: cd tests && npm install && node --test orchestrator.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSupabaseLikeDb } from './db-setup.mjs';
import { runTick, advanceGame } from '../supabase/functions/_shared/orchestrator.js';
import * as engine from '../supabase/functions/_shared/fanball-engine.js';
import { loadBrowserEngine, sampleRoster } from '../tools/browser-sandbox.mjs';

let db;
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const all = async (sql, params) => (await db.query(sql, params)).rows;
const FAN_AWAY = '00000000-0000-0000-0000-0000000000a1', FAN_HOME = '00000000-0000-0000-0000-0000000000b1';
const SETOF = new Set(['start_due_fanball_games', 'due_fanball_games']);

// Same contract as supabase-js rpc(): named arguments in, the function result out, errors thrown.
async function rpc(name, args = {}) {
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

async function insertGame(kboId, awayId, homeId, roster) {
  await db.query(`insert into public.kbo_games(id, game_date, scheduled_at, away_team_id, home_team_id, provider) values ($1, current_date, now() - interval '1 second', $2, $3, 'demo')`, [kboId, awayId, homeId]);
  return (await one(`insert into public.fanball_games(kbo_game_id, lineup_snapshot) values ($1, $2) returning id`, [kboId, JSON.stringify({ teams: roster })])).id;
}

async function voteOnOpenRounds(gameId) {
  const rounds = await all(`select id from public.tactical_rounds where game_id = $1 and status = 'open'`, [gameId]);
  for (const r of rounds) {
    for (const [user, role] of [[FAN_AWAY, 'offense'], [FAN_HOME, 'defense']]) {
      // Each fan picks the last listed (non-default) choice for their role, if it is their turn.
      const choice = await one(`select c.id from public.tactical_choices c join public.tactical_rounds t on t.id = c.round_id
        join public.fanball_game_memberships m on m.game_id = t.game_id and m.user_id = $2
        where c.round_id = $1 and c.role = $3 and m.team_id = case when $3 = 'offense' then t.offense_team_id else t.defense_team_id end
        order by c.is_default, c.choice_key desc limit 1`, [r.id, user, role]);
      if (!choice) continue;
      await db.exec(`set role authenticated`);
      await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [user]);
      try { await db.query(`select public.submit_tactical_vote($1, $2)`, [r.id, choice.id]); } finally { await db.exec('reset role'); }
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

test('a full official game runs to the end, once, and can be re-verified from the revealed seed', async () => {
  const gameId = await insertGame('demo-full', 'doosan', 'tigers', { doosan: roster.doosan, tigers: roster.tigers });
  for (const user of [FAN_AWAY, FAN_HOME]) {
    await db.exec(`set role authenticated`);
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [user]);
    try { await db.query(`select public.join_fanball_game($1)`, [gameId]); } finally { await db.exec('reset role'); }
  }
  const first = await runTick(rpc);
  assert.deepEqual(first.started, [gameId]);
  const seedHash = (await one(`select seed_hash from public.fanball_games where id = $1`, [gameId])).seed_hash;

  let ticks = 0, votedRounds = 0;
  for (; ticks < 1000; ticks++) {
    const status = (await one(`select status from public.fanball_games where id = $1`, [gameId])).status;
    if (status === 'final') break;
    if (await one(`select 1 from public.tactical_rounds where game_id = $1 and status = 'open'`, [gameId])) { await voteOnOpenRounds(gameId); votedRounds++; }
    await fastForward();
    const { results } = await runTick(rpc);
    for (const r of results) assert.ok(!r.error, `tick error: ${r.error}`);
  }
  const game = await one(`select * from public.fanball_games where id = $1`, [gameId]);
  assert.equal(game.status, 'final');
  assert.ok(votedRounds > 0, 'some votes happened');

  // The revealed seed matches the hash published at the start.
  assert.equal(createHash('sha256').update(String(game.revealed_seed)).digest('hex'), seedHash);

  // Anyone can replay the game from the revealed seed and the recorded tactics.
  const pas = await all(`select pa_no, outcome, runs, round_id, result_payload p from public.plate_appearances where game_id = $1 order by pa_no`, [gameId]);
  let replay = engine.createGame({ awayId: 'doosan', homeId: 'tigers', seed: Number(game.revealed_seed) });
  for (const pa of pas) {
    const step = engine.stepPlateAppearance(replay, { doosan: roster.doosan, tigers: roster.tigers }, { offense: pa.p.choice, defense: pa.p.defenseChoice });
    assert.equal(step.play.kind, pa.outcome, `PA ${pa.pa_no}`);
    replay = step.game;
  }
  assert.equal(replay.status, 'final');
  assert.deepEqual(game.score, { away: replay.away, home: replay.home });

  // Votes reached the engine: some plate appearances used a non-default tactic from a round.
  const voted = pas.filter(pa => pa.round_id && (pa.p.choice !== 'normal' || pa.p.defenseChoice !== 'standard'));
  assert.ok(voted.length > 0, 'a voted tactic was applied');
  const rounds = (await one(`select count(*)::int n from public.tactical_rounds where game_id = $1`, [gameId])).n;
  assert.equal(rounds, (await one(`select count(*)::int n from public.plate_appearances where game_id = $1 and round_id is not null`, [gameId])).n, 'every round fed exactly one plate appearance');
  console.log(`full game: ${pas.length} PAs, ${rounds} vote rounds, ${ticks} ticks, final ${replay.away}:${replay.home}`);

  // Nothing is left to do, and nothing re-runs.
  assert.deepEqual((await runTick(rpc)).results, []);
  assert.equal((await one(`select count(*)::int n from public.plate_appearances where game_id = $1`, [gameId])).n, pas.length);
});

test('two ticks racing on the same step record one plate appearance', async () => {
  const gameId = await insertGame('demo-race', 'lg', 'kt', { lg: roster.lg, kt: roster.kt });
  await runTick(rpc); // starts the game and plays its first plate appearance
  await fastForward();
  const count = async () => (await one(`select count(*)::int n from public.plate_appearances where game_id = $1`, [gameId])).n;
  const before = await count();
  const [a, b] = await Promise.all([advanceGame(rpc, gameId), advanceGame(rpc, gameId)]);
  assert.equal(a.action, 'play_pa');
  assert.deepEqual([a.committed, b.committed].sort(), [false, true]);
  assert.equal(await count(), before + 1);
});

test('a step that is not due yet does nothing', async () => {
  const gameId = (await one(`select id from public.fanball_games where kbo_game_id = 'demo-race'`)).id;
  await db.query(`update public.fanball_game_private set next_action_at = now() + interval '1 minute' where game_id = $1`, [gameId]);
  const result = await advanceGame(rpc, gameId);
  assert.equal(result.skipped, 'not due');
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
