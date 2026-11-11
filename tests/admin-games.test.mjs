// Admin game management: schedule, reschedule and delete games from the site (PGlite).
// Run: cd tests && node --test admin-games.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseLikeDb } from './db-setup.mjs';

let db;
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const ADMIN = '00000000-0000-0000-0000-000000000009', FAN = '00000000-0000-0000-0000-000000000001';
async function as(role, user, sql, params) {
  await db.exec(`set role ${role}`);
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [user || '']);
  try { return await db.query(sql, params); } finally { await db.exec('reset role'); }
}
const team = p => ({ players: Array.from({ length: 10 }, (_, i) => [p + i, 'IF', 0.26, 0.33, 0.4, 0.1]), order: [0, 1, 2, 3, 4, 5, 6, 7, 8], pitcher: [p + '투수', 0.25, 0.08, 0.2] });
const snap = JSON.stringify({ teams: { lg: team('L'), tigers: team('T'), extra: team('X') } });
const inMinutes = m => new Date(Date.now() + m * 60000).toISOString();
const schedule = (user, away, home, at, s = snap) =>
  as('authenticated', user, `select public.admin_schedule_fanball_game($1, $2, $3, $4) id`, [away, home, at, s]).then(r => r.rows[0].id);

before(async () => {
  db = await createSupabaseLikeDb();
  await db.exec(`insert into auth.users values ('${ADMIN}'), ('${FAN}'); insert into public.app_admins(user_id) values ('${ADMIN}');`);
});

test('only admins can schedule, and the inputs are checked', async () => {
  await assert.rejects(schedule(FAN, 'lg', 'tigers', inMinutes(30)), /admin only/);
  await assert.rejects(as('anon', null, `select public.admin_schedule_fanball_game('lg', 'tigers', now(), '{}')`), /permission denied/);
  await assert.rejects(schedule(ADMIN, 'lg', 'tigers', inMinutes(-5)), /future/);
  await assert.rejects(schedule(ADMIN, 'lg', 'doosan', inMinutes(30)), /missing team doosan/);

  const id = await schedule(ADMIN, 'lg', 'tigers', inMinutes(30));
  const row = await one(`select f.status, f.lineup_snapshot s, k.provider, k.away_team_id, k.home_team_id, k.game_date, k.scheduled_at
    from public.fanball_games f join public.kbo_games k on k.id = f.kbo_game_id where f.id = $1`, [id]);
  assert.equal(row.status, 'scheduled');
  assert.equal(row.provider, 'demo');
  assert.deepEqual(Object.keys(row.s.teams).sort(), ['lg', 'tigers'], 'only the two teams are kept');
  assert.equal(row.s.source, 'admin-sample-rosters');
});

test('rescheduling moves a game that has not started, and only then', async () => {
  const id = await schedule(ADMIN, 'lg', 'tigers', inMinutes(30));
  const later = inMinutes(24 * 60 + 10);
  await assert.rejects(as('authenticated', FAN, `select public.admin_reschedule_fanball_game($1, $2)`, [id, later]), /admin only/);
  await as('authenticated', ADMIN, `select public.admin_reschedule_fanball_game($1, $2)`, [id, later]);
  const k = await one(`select k.scheduled_at, k.game_date::text d from public.kbo_games k join public.fanball_games f on f.kbo_game_id = k.id where f.id = $1`, [id]);
  assert.equal(new Date(k.scheduled_at).toISOString(), later);
  const kstDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date(later));
  assert.equal(k.d, kstDate, 'game date follows the new start time in Korea time');
  await db.exec(`update public.fanball_games set status = 'running' where id = '${id}'`);
  await assert.rejects(as('authenticated', ADMIN, `select public.admin_reschedule_fanball_game($1, $2)`, [id, later]), /not started/);
});

test('deleting: scheduled and finished demo games go with their rows; running games and official records stay', async () => {
  const scheduled = await schedule(ADMIN, 'lg', 'tigers', inMinutes(30));
  const kboId = (await one(`select kbo_game_id k from public.fanball_games where id = $1`, [scheduled])).k;
  await db.exec(`insert into public.lineup_submissions(game_id, user_id, team_id, slots) values ('${scheduled}', '${FAN}', 'lg', '[]')`);
  await assert.rejects(as('authenticated', FAN, `select public.admin_delete_fanball_game($1)`, [scheduled]), /admin only/);
  await as('authenticated', ADMIN, `select public.admin_delete_fanball_game($1)`, [scheduled]);
  assert.equal((await one(`select count(*)::int n from public.fanball_games where id = $1`, [scheduled])).n, 0);
  assert.equal((await one(`select count(*)::int n from public.kbo_games where id = $1`, [kboId])).n, 0);
  assert.equal((await one(`select count(*)::int n from public.lineup_submissions where game_id = $1`, [scheduled])).n, 0);

  const running = await schedule(ADMIN, 'lg', 'tigers', inMinutes(30));
  await db.exec(`update public.fanball_games set status = 'running' where id = '${running}'`);
  await assert.rejects(as('authenticated', ADMIN, `select public.admin_delete_fanball_game($1)`, [running]), /running game/);

  // A finished demo game can be cleaned up, with its rounds, plate appearances and pitches.
  const finished = await schedule(ADMIN, 'lg', 'tigers', inMinutes(30));
  await db.exec(`update public.fanball_games set status = 'running' where id = '${finished}'; update public.fanball_games set status = 'final' where id = '${finished}'`);
  await as('authenticated', ADMIN, `select public.admin_delete_fanball_game($1)`, [finished]);
  assert.equal((await one(`select count(*)::int n from public.fanball_games where id = $1`, [finished])).n, 0);

  // A finished game from a real schedule provider is an official record.
  await db.exec(`insert into public.kbo_games(id, game_date, scheduled_at, away_team_id, home_team_id, provider) values ('kbo-1', current_date, now(), 'lg', 'tigers', 'kbo');`);
  const official = (await one(`insert into public.fanball_games(kbo_game_id, status) values ('kbo-1', 'running') returning id`)).id;
  await db.exec(`update public.fanball_games set status = 'final' where id = '${official}'`);
  await assert.rejects(as('authenticated', ADMIN, `select public.admin_delete_fanball_game($1)`, [official]), /official game records/);
});

test('event match: a team can be booked against itself, each side with its own lineup entry', async () => {
  const id = await schedule(ADMIN, 'lg', 'lg', inMinutes(45));
  const row = await one(`select f.lineup_snapshot s, k.away_team_id, k.home_team_id, k.provider from public.fanball_games f join public.kbo_games k on k.id = f.kbo_game_id where f.id = $1`, [id]);
  assert.equal(row.away_team_id, 'lg'); assert.equal(row.home_team_id, 'lg'); assert.equal(row.provider, 'demo');
  assert.deepEqual(Object.keys(row.s.teams).sort(), ['lg', 'lg@away'], 'the away side has its own key');
  // KBO schedule rows still need two different teams.
  await assert.rejects(db.query(`insert into public.kbo_games(id, game_date, scheduled_at, away_team_id, home_team_id, status, provider) values ('x', current_date, now(), 'lg', 'lg', 'scheduled', 'kbo')`), /kbo_games_teams_check/);
});
