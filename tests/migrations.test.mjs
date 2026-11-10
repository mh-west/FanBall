// Applies every Supabase migration to an in-memory Postgres (PGlite) that mimics Supabase's
// roles, auth schema and default grants, then checks voting and orchestrator rules.
// Run: cd tests && npm install && node --test migrations.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSupabaseLikeDb } from './db-setup.mjs';

let db;
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const all = async (sql, params) => (await db.query(sql, params)).rows;
const USER_A = '00000000-0000-0000-0000-00000000000a', USER_B = '00000000-0000-0000-0000-00000000000b';

// Run fn as a Supabase API role (anon, authenticated with a user id, or service_role).
async function as(role, userId, fn) {
  await db.exec(`set role ${role}`);
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId || '']);
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const rejects = (promise, pattern) => assert.rejects(promise, pattern);

before(async () => {
  db = await createSupabaseLikeDb();
  await db.exec(`
    insert into auth.users values ('${USER_A}'), ('${USER_B}');
    insert into public.profiles(user_id, favorite_team_id) values ('${USER_A}', 'tigers'), ('${USER_B}', 'doosan');
    insert into public.kbo_games(id, game_date, scheduled_at, away_team_id, home_team_id, status) values
      ('due', current_date, now() - interval '1 minute', 'doosan', 'tigers', 'scheduled'),
      ('no-lineup', current_date, now() - interval '1 minute', 'lg', 'kt', 'scheduled'),
      ('future', current_date, now() + interval '1 hour', 'ssg', 'nc', 'scheduled'),
      ('postponed', current_date, now() - interval '1 minute', 'lotte', 'samsung', 'postponed');
    insert into public.fanball_games(kbo_game_id, lineup_snapshot) values
      ('due', '{"teams":{}}'), ('no-lineup', null), ('future', '{"teams":{}}'), ('postponed', '{"teams":{}}');
  `);
});

const gameId = async kboId => (await one(`select id from public.fanball_games where kbo_game_id = $1`, [kboId])).id;
const priv = async id => one(`select * from public.fanball_game_private where game_id = $1`, [id]);
const commit = (id, version, overrides = {}) => {
  const a = { state: { inning: 1 }, next: 'play_pa', at: new Date().toISOString(), round: null, score: { away: 0, home: 0 }, pa: null, finish: false, ...overrides };
  return one(`select public.commit_orchestrator_step($1, $2, $3, $4, $5, $6, $7, $8, $9, 'fanball-engine-1') as ok`,
    [id, version, a.state, a.next, a.at, a.round, a.score, a.pa, a.finish]);
};

test('only due games with a lineup start, and only once', async () => {
  const started = await as('service_role', null, () => all(`select * from public.start_due_fanball_games() as id`));
  assert.deepEqual(started.map(r => r.id), [await gameId('due')]);
  const again = await as('service_role', null, () => all(`select * from public.start_due_fanball_games() as id`));
  assert.equal(again.length, 0);
  const statuses = await all(`select k.id, f.status from public.fanball_games f join public.kbo_games k on k.id = f.kbo_game_id order by k.id`);
  assert.deepEqual(Object.fromEntries(statuses.map(r => [r.id, r.status])), { due: 'running', future: 'scheduled', 'no-lineup': 'scheduled', postponed: 'scheduled' });
});

test('seed is private, in uint32 range, and its public hash matches', async () => {
  const id = await gameId('due'), p = await priv(id), g = await one(`select * from public.fanball_games where id = $1`, [id]);
  const seed = Number(p.seed);
  assert.ok(seed >= 0 && seed <= 4294967295);
  assert.equal(g.seed_hash, createHash('sha256').update(String(seed)).digest('hex'));
  assert.equal(g.revealed_seed, null);
  assert.equal('seed' in g, false, 'old public seed column is gone');
  assert.equal(p.next_action, 'play_pa');
  assert.equal(p.state_version, 1);
});

test('browser roles cannot read private state or call orchestrator functions', async () => {
  for (const [role, uid] of [['anon', null], ['authenticated', USER_A]]) {
    await as(role, uid, async () => {
      await rejects(db.query(`select * from public.fanball_game_private`), /permission denied/);
      await rejects(db.query(`select public.start_due_fanball_games()`), /permission denied/);
      await rejects(db.query(`select public.due_fanball_games()`), /permission denied/);
      await rejects(db.query(`select public.commit_orchestrator_step(null,1,null,null,null,null,null,null,false,null)`), /permission denied/);
      await rejects(db.query(`insert into public.plate_appearances(game_id, pa_no, outcome) values (gen_random_uuid(), 1, 'HR')`), /permission denied/);
      const visible = await all(`select status, seed_hash from public.fanball_games where kbo_game_id = 'due'`);
      assert.equal(visible[0].status, 'running');
    });
  }
});

test('due list, version check, and step commit', async () => {
  const id = await gameId('due');
  const due = await as('service_role', null, () => all(`select * from public.due_fanball_games() as id`));
  assert.deepEqual(due.map(r => r.id), [id]);
  const later = new Date(Date.now() + 60000).toISOString();
  const pa = { pa_no: 1, outcome: '1B', runs: 0, reveal_at: later, payload: { batter: 'x' } };
  assert.equal((await as('service_role', null, () => commit(id, 1, { pa, next: 'open_round', at: later }))).ok, true);
  assert.equal((await priv(id)).state_version, 2);
  // A second caller that read version 1 changes nothing.
  assert.equal((await as('service_role', null, () => commit(id, 1, { pa: { ...pa, pa_no: 2 } }))).ok, false);
  assert.equal((await one(`select count(*)::int n from public.plate_appearances where game_id = $1`, [id])).n, 1);
  const dueNow = await as('service_role', null, () => all(`select * from public.due_fanball_games() as id`));
  assert.equal(dueNow.length, 0, 'next step is in the future');
});

test('a duplicate plate appearance rolls back the whole step', async () => {
  const id = await gameId('due');
  await rejects(as('service_role', null, () => commit(id, 2, { pa: { pa_no: 1, outcome: 'HR', runs: 1 } })), /duplicate key/);
  assert.equal((await priv(id)).state_version, 2);
});

test('plate appearances stay hidden until reveal_at', async () => {
  const id = await gameId('due');
  const hidden = await as('anon', null, () => all(`select * from public.plate_appearances where game_id = $1`, [id]));
  assert.equal(hidden.length, 0);
  await as('service_role', null, () => commit(id, 2, { pa: { pa_no: 2, outcome: 'K', runs: 0, reveal_at: new Date(Date.now() - 1000).toISOString() } }));
  const shown = await as('anon', null, () => all(`select pa_no from public.plate_appearances where game_id = $1`, [id]));
  assert.deepEqual(shown.map(r => r.pa_no), [2]);
});

test('records cannot be changed, even by the database owner', async () => {
  const id = await gameId('due');
  await rejects(db.query(`update public.plate_appearances set outcome = 'HR' where game_id = $1`, [id]), /cannot be changed/);
  await rejects(db.query(`delete from public.plate_appearances where game_id = $1`, [id]), /cannot be changed/);
  await rejects(db.query(`update public.fanball_games set lineup_snapshot = '{}' where id = $1`, [id]), /fixed once a game starts/);
  await rejects(db.query(`update public.fanball_games set status = 'scheduled' where id = $1`, [id]), /cannot change from running to scheduled/);
});

test('voting still works and its result is append-only', async () => {
  const id = await gameId('due');
  const choices = [{ role: 'offense', key: 'normal', label: 'n', default: true }, { role: 'offense', key: 'bunt', label: 'b' },
    { role: 'defense', key: 'standard', label: 's', default: true }, { role: 'defense', key: 'double_play', label: 'd' }];
  const round = await as('service_role', null, () => one(`select * from public.open_tactical_round($1, 3, '{}', 'doosan', 'tigers', $2)`, [id, JSON.stringify(choices)]));
  const pick = async key => (await one(`select id from public.tactical_choices where round_id = $1 and choice_key = $2`, [round.id, key])).id;
  await as('authenticated', USER_A, () => db.query(`select public.join_fanball_game($1)`, [id]));
  await as('authenticated', USER_B, () => db.query(`select public.join_fanball_game($1)`, [id]));
  await as('authenticated', USER_A, async () => db.query(`select public.submit_tactical_vote($1, $2)`, [round.id, await pick('double_play')]));
  await as('authenticated', USER_B, async () => db.query(`select public.submit_tactical_vote($1, $2)`, [round.id, await pick('bunt')]));
  await db.query(`update public.tactical_rounds set opens_at = now() - interval '20 seconds', closes_at = now() - interval '1 second' where id = $1`, [round.id]);
  const result = await as('service_role', null, () => one(`select public.resolve_tactical_round($1) r`, [round.id]));
  assert.equal(result.r.offense_choice_id, await pick('bunt'));
  assert.equal(result.r.defense_choice_id, await pick('double_play'));
  await rejects(db.query(`update public.tactical_resolutions set fallback_roles = '{}' where round_id = $1`, [round.id]), /cannot be changed/);
});

test('a plate appearance can have one round per phase, 12 seconds by default', async () => {
  const id = await gameId('due');
  const choices = JSON.stringify([{ role: 'offense', key: 'keep', label: 'k', default: true }, { role: 'defense', key: 'keep', label: 'k', default: true }]);
  const open = (phase, seconds) => as('service_role', null, () => one(
    seconds ? `select * from public.open_tactical_round($1, 20, '{}', 'doosan', 'tigers', $2, $3, $4)` : `select * from public.open_tactical_round($1, 20, '{}', 'doosan', 'tigers', $2, $3)`,
    seconds ? [id, choices, phase, seconds] : [id, choices, phase]));
  const pre = await open('pre_pa'), two = await open('two_strikes'), again = await open('two_strikes');
  assert.notEqual(pre.id, two.id);
  assert.equal(again.id, two.id, 'same phase reuses its round');
  assert.equal(Math.round((new Date(pre.closes_at) - new Date(pre.opens_at)) / 1000), 12);
  const three = await open('three_balls', 15);
  assert.equal(Math.round((new Date(three.closes_at) - new Date(three.opens_at)) / 1000), 15);
  await rejects(open('two_strike'), /tactical_rounds_phase_check/);
  await rejects(as('service_role', null, () => one(`select * from public.open_tactical_round($1, 21, '{}', 'doosan', 'tigers', $2, 'pre_pa', 3)`, [id, choices])), /5 to 60 seconds/);
});

test('pitches are saved with the step, public at once, and cannot be changed', async () => {
  const id = await gameId('due'), p = await priv(id);
  const pitch = { pitch_no: 1, pa_no: 3, count_before: '0-0', call: 'strike', result: 'called_strike', payload: { x: 50 } };
  const ok = await as('service_role', null, () => one(`select public.commit_orchestrator_step($1, $2, '{}', 'pitch', now(), null, null, null, false, 'fanball-engine-2', $3) as ok`, [id, p.state_version, JSON.stringify(pitch)]));
  assert.equal(ok.ok, true);
  const seen = await as('anon', null, () => all(`select pitch_no, count_before, call from public.pitches where game_id = $1`, [id]));
  assert.deepEqual(seen, [{ pitch_no: 1, count_before: '0-0', call: 'strike' }]);
  await as('anon', null, () => rejects(db.query(`insert into public.pitches(game_id, pitch_no, pa_no, count_before, call, result) values ($1, 2, 3, '0-1', 'ball', 'ball')`, [id]), /permission denied/));
  await rejects(db.query(`update public.pitches set call = 'ball' where game_id = $1`, [id]), /cannot be changed/);
  await rejects(db.query(`delete from public.pitches where game_id = $1`, [id]), /cannot be changed/);
  // A duplicate pitch number rolls the whole step back.
  await rejects(as('service_role', null, () => one(`select public.commit_orchestrator_step($1, $2, '{}', 'pitch', now(), null, null, null, false, null, $3)`, [id, p.state_version + 1, JSON.stringify(pitch)])), /duplicate key/);
  assert.equal((await priv(id)).state_version, p.state_version + 1);
  assert.equal((await priv(id)).next_action, 'pitch');
});

test('finishing reveals the seed and locks the game', async () => {
  const id = await gameId('due'), p = await priv(id);
  assert.equal((await as('service_role', null, () => commit(id, p.state_version, { finish: true, score: { away: 3, home: 2 } }))).ok, true);
  const g = await one(`select * from public.fanball_games where id = $1`, [id]);
  assert.equal(g.status, 'final');
  assert.equal(String(g.revealed_seed), String(p.seed));
  assert.deepEqual(g.score, { away: 3, home: 2 });
  assert.equal((await priv(id)).next_action, null);
  await rejects(as('service_role', null, () => commit(id, p.state_version + 1)), /not running/);
  await rejects(db.query(`update public.fanball_games set status = 'running' where id = $1`, [id]), /cannot change from final/);
  await rejects(db.query(`update public.fanball_games set revealed_seed = 1 where id = $1`, [id]), /cannot change/);
});

test('deleting a whole test game still cascades', async () => {
  const id = await gameId('due');
  await db.query(`delete from public.fanball_games where id = $1`, [id]);
  for (const table of ['plate_appearances', 'tactical_rounds', 'fanball_game_private', 'fanball_game_memberships', 'pitches'])
    assert.equal((await one(`select count(*)::int n from public.${table} where game_id = $1`, [id])).n, 0, table);
});
