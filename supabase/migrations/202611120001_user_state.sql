-- Per-account saved data (2026-11-12, user request): saved lineups, the AI match in progress and past AI
-- matches follow the signed-in account (Google etc.) instead of staying in one browser.
-- One row per user and key; each user reads and writes only their own rows.
-- Keys used by the site: 'saved_lineups', 'ai_match', 'ai_history'.
create table if not exists public.user_state (
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  key text not null check (key in ('saved_lineups', 'ai_match', 'ai_history')),
  value jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, key),
  check (pg_column_size(value) <= 2000000)
);

alter table public.user_state enable row level security;
revoke all on public.user_state from public, anon, authenticated;
grant select, insert, update, delete on public.user_state to authenticated;
grant all on public.user_state to service_role;

drop policy if exists "user_state_own" on public.user_state;
create policy "user_state_own" on public.user_state for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
