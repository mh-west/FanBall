// In-memory Postgres (PGlite) that mimics Supabase's roles, auth schema and default grants,
// with every migration in supabase/migrations applied in order.
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const migrationsDir = new URL('../supabase/migrations/', import.meta.url);

export async function createSupabaseLikeDb() {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  `);
  for (const file of readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()) {
    // pgcrypto is preinstalled on Supabase but not bundled with PGlite; nothing here needs it.
    const sql = readFileSync(new URL(file, migrationsDir), 'utf8').replace(/^create extension if not exists pgcrypto;$/m, '');
    await db.exec(sql);
  }
  return db;
}
