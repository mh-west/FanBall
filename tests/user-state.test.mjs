// Account data (public.user_state): each user reads and writes only their own rows.
// Run: cd tests && node --test user-state.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseLikeDb } from './db-setup.mjs';

let db;
const A = '00000000-0000-0000-0000-0000000000d1', B = '00000000-0000-0000-0000-0000000000d2';
async function as(role, user, sql, params) {
  await db.exec(`set role ${role}`);
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [user || '']);
  try { return await db.query(sql, params); } finally { await db.exec('reset role'); }
}
before(async () => { db = await createSupabaseLikeDb(); await db.exec(`insert into auth.users values ('${A}'), ('${B}')`); });

test('a user saves and reads back their own data; nobody else can read or change it', async () => {
  await as('authenticated', A, `insert into public.user_state(key, value) values ('saved_lineups', '{"tigers":{"slots":[null,null,null]}}')
    on conflict (user_id, key) do update set value = excluded.value`);
  await as('authenticated', A, `insert into public.user_state(user_id, key, value) values ($1, 'ai_match', '{"savedAt":1}')`, [A]);
  const mine = (await as('authenticated', A, `select key from public.user_state order by key`)).rows.map(r => r.key);
  assert.deepEqual(mine, ['ai_match', 'saved_lineups']);
  assert.equal((await as('authenticated', B, `select count(*)::int n from public.user_state`)).rows[0].n, 0, 'B sees nothing of A');
  await as('authenticated', B, `update public.user_state set value = '{}' where user_id = $1`, [A]);
  assert.equal((await db.query(`select value->>'savedAt' v from public.user_state where user_id = $1 and key = 'ai_match'`, [A])).rows[0].v, '1', 'B could not change it');
  await assert.rejects(as('authenticated', B, `insert into public.user_state(user_id, key, value) values ($1, 'ai_history', '[]')`, [A]), /row-level security/);
  await assert.rejects(as('anon', null, `select * from public.user_state`), /permission denied/);
  await assert.rejects(as('authenticated', A, `insert into public.user_state(key, value) values ('something_else', '1')`), /check/);
});
