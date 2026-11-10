// Admin flag, fan lineup submissions and the representative lineup at game start (PGlite).
// Run: cd tests && node --test lineups.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseLikeDb } from './db-setup.mjs';

let db;
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const U = n => `00000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`;
async function asUser(user, sql, params) {
  await db.exec('set role authenticated');
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [user || '']);
  try { return await db.query(sql, params); } finally { await db.exec('reset role'); }
}
const players = ['가', '나', '다', '라', '마', '바', '사', '아', '자', '차', '카'];
const POS = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH'];
const lineup = (names, pos = POS) => JSON.stringify(names.map((player, i) => ({ player, pos: pos[i] })));
let gameId;

before(async () => {
  db = await createSupabaseLikeDb();
  await db.exec(`insert into auth.users select ('00000000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid from generate_series(1, 9) i;
    insert into public.profiles(user_id, favorite_team_id) values ('${U(1)}','tigers'),('${U(2)}','tigers'),('${U(3)}','tigers'),('${U(4)}','lg'),('${U(5)}','doosan');
    insert into public.app_admins(user_id) values ('${U(9)}');
    insert into public.kbo_games(id, game_date, scheduled_at, away_team_id, home_team_id) values ('g', current_date, now() + interval '1 hour', 'lg', 'tigers');`);
  const snap = { teams: { tigers: { players: players.map(n => [n, 'IF', 0.26, 0.33, 0.4, 0.1]), order: [0, 1, 2, 3, 4, 5, 6, 7, 8], pitcher: ['투수', 0.25, 0.08, 0.2] },
    lg: { players: players.map(n => ['L' + n, 'IF', 0.26, 0.33, 0.4, 0.1]), order: [0, 1, 2, 3, 4, 5, 6, 7, 8], pitcher: ['투수', 0.25, 0.08, 0.2] } } };
  gameId = (await one(`insert into public.fanball_games(kbo_game_id, lineup_snapshot) values ('g', $1) returning id`, [JSON.stringify(snap)])).id;
});

test('is_admin is true only for listed admins; browsers cannot read the admin table', async () => {
  assert.equal((await asUser(U(9), `select public.is_admin() a`)).rows[0].a, true);
  assert.equal((await asUser(U(1), `select public.is_admin() a`)).rows[0].a, false);
  await assert.rejects(asUser(U(9), `select * from public.app_admins`), /permission denied/);
});

test('lineup submissions are checked: own team, squad players, 9 distinct batters, every position once', async () => {
  const submit = (u, slots) => asUser(u, `select (public.submit_fanball_lineup($1, $2)).team_id t`, [gameId, slots]);
  assert.equal((await submit(U(1), lineup(players.slice(0, 9)))).rows[0].t, 'tigers');
  await assert.rejects(submit(U(5), lineup(players.slice(0, 9))), /not playing/);
  await assert.rejects(submit(U(2), lineup([...players.slice(0, 8), '없음'])), /not in the squad/);
  await assert.rejects(submit(U(2), lineup([...players.slice(0, 8), '가'])), /only once/);
  await assert.rejects(submit(U(2), lineup(players.slice(0, 9), [...POS.slice(0, 8), 'C'])), /positions must be/);
  await assert.rejects(submit(U(2), JSON.stringify([])), /9 batters/);
  // Re-submitting replaces the fan's earlier lineup.
  await submit(U(1), lineup(players.slice(0, 9)));
  assert.equal((await one(`select count(*)::int n from public.lineup_submissions`)).n, 1);
  await assert.rejects(asUser(U(1), `insert into public.lineup_submissions(game_id, user_id, team_id, slots) values ($1, $2, 'tigers', '[]')`, [gameId, U(1)]), /permission denied/);
});

test('the representative lineup takes the most-voted player per batting slot, and the game starts with it', async () => {
  const submit = (u, slots) => asUser(u, `select public.submit_fanball_lineup($1, $2)`, [gameId, slots]);
  // Fan 1: 가..자. Fans 2 and 3: 카 leads off, then 나..자 with 가 dropped; 카 plays CF for both.
  const others = ['카', '나', '다', '라', '마', '바', '사', '아', '자'];
  const pos2 = ['CF', '1B', '2B', '3B', 'SS', 'LF', 'C', 'RF', 'DH'];
  await submit(U(2), lineup(others, pos2));
  await submit(U(3), lineup(others, pos2));
  const rep = (await one(`select public.representative_lineup($1, 'tigers') r`, [gameId])).r;
  assert.deepEqual(rep.players, others);
  assert.equal(rep.positions['카'], 'CF');
  assert.equal(new Set(Object.values(rep.positions)).size, 9, 'every position used once');
  assert.equal((await one(`select public.representative_lineup($1, 'lg') r`, [gameId])).r, null, 'no LG submissions');
  await db.exec(`update public.kbo_games set scheduled_at = now() - interval '1 second' where id = 'g'`);
  const started = (await db.query(`select * from public.start_due_fanball_games() id`)).rows;
  assert.equal(started.length, 1);
  const snap = (await one(`select lineup_snapshot s, status from public.fanball_games where id = $1`, [gameId]));
  assert.equal(snap.status, 'running');
  assert.deepEqual(snap.s.teams.tigers.order, [10, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(snap.s.teams.tigers.lineupSource, 'fan_vote:3');
  assert.deepEqual(snap.s.teams.lg.order, [0, 1, 2, 3, 4, 5, 6, 7, 8], 'LG keeps its default order');
  await assert.rejects(asUser(U(1), `select public.submit_fanball_lineup($1, $2)`, [gameId, lineup(players.slice(0, 9))]), /closed/);
});
