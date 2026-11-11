-- Suggestion box (2026-11-11): signed-in fans send suggestions; admins read them and set a status.
-- Fans see only their own suggestions (with the admin's status and reply). Writes go through the two
-- functions below, which check the caller, length and a per-user rate limit; there is no direct
-- insert or update from browsers.

create table if not exists public.feedback (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete set null,
  nickname text,
  category text not null check (category in ('feature', 'bug', 'data', 'other')),
  body text not null check (char_length(body) between 5 and 1000),
  page text,
  status text not null default 'new' check (status in ('new', 'read', 'planned', 'done', 'declined')),
  admin_note text check (admin_note is null or char_length(admin_note) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists feedback_user_idx on public.feedback(user_id, created_at desc);
create index if not exists feedback_created_idx on public.feedback(created_at desc);

alter table public.feedback enable row level security;
revoke all on public.feedback from public, anon, authenticated;
grant select on public.feedback to authenticated;
grant all on public.feedback to service_role;

drop policy if exists "feedback_read_own_or_admin" on public.feedback;
create policy "feedback_read_own_or_admin" on public.feedback for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

create or replace function public.submit_feedback(p_category text, p_body text, p_page text default null)
returns bigint language plpgsql security definer set search_path=public as $$
declare uid uuid := auth.uid(); body text := btrim(coalesce(p_body, '')); new_id bigint; nick text;
begin
  if uid is null then raise exception 'sign in first'; end if;
  if p_category not in ('feature', 'bug', 'data', 'other') then raise exception 'unknown category'; end if;
  if char_length(body) < 5 then raise exception 'too short'; end if;
  if char_length(body) > 1000 then raise exception 'too long'; end if;
  if (select count(*) from public.feedback where user_id = uid and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'too many suggestions';
  end if;
  select left(coalesce(u.raw_user_meta_data->>'fanball_nickname', ''), 40) into nick from auth.users u where u.id = uid;
  insert into public.feedback(user_id, nickname, category, body, page)
  values (uid, nullif(nick, ''), p_category, body, left(p_page, 40))
  returning id into new_id;
  return new_id;
end $$;

create or replace function public.admin_update_feedback(p_id bigint, p_status text, p_note text default null)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  if p_status not in ('new', 'read', 'planned', 'done', 'declined') then raise exception 'unknown status'; end if;
  update public.feedback
    set status = p_status, admin_note = nullif(left(btrim(coalesce(p_note, '')), 500), ''), updated_at = now()
    where id = p_id;
  if not found then raise exception 'not found'; end if;
end $$;

revoke all on function public.submit_feedback(text, text, text) from public, anon;
revoke all on function public.admin_update_feedback(bigint, text, text) from public, anon;
grant execute on function public.submit_feedback(text, text, text) to authenticated;
grant execute on function public.admin_update_feedback(bigint, text, text) to authenticated;
