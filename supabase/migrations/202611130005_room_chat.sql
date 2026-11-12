-- Chat in friend rooms (2026-11-13, user request): the two people in a room can send short messages while they
-- wait and during the game. Only they can read or write them; 1-200 characters, at most 10 messages in 10
-- seconds per person. Messages go with the room.

create table if not exists public.room_messages (
  id bigserial primary key,
  code text not null references public.friend_rooms(code) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 200),
  created_at timestamptz not null default now()
);
create index if not exists room_messages_code_id on public.room_messages(code, id);
alter table public.room_messages enable row level security;
revoke all on public.room_messages from public, anon, authenticated;
grant all on public.room_messages to service_role;

create or replace function public.send_room_message(p_code text, p_body text)
returns bigint language plpgsql security definer set search_path=public as $$
declare r public.friend_rooms := public.room_for_member(p_code); body text := btrim(coalesce(p_body, '')); new_id bigint;
begin
  if body = '' then raise exception 'empty message'; end if;
  if char_length(body) > 200 then raise exception 'message too long'; end if;
  if (select count(*) from public.room_messages where user_id = auth.uid() and created_at > now() - interval '10 seconds') >= 10 then
    raise exception 'too many messages';
  end if;
  insert into public.room_messages(code, user_id, body) values (r.code, auth.uid(), body) returning id into new_id;
  return new_id;
end $$;

-- Messages after p_after (the newest 100), oldest first, each marked mine or not, with the sender's nickname.
create or replace function public.room_messages_after(p_code text, p_after bigint default 0)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.friend_rooms := public.room_for_member(p_code);
begin
  return coalesce((select jsonb_agg(x order by (x->>'id')::bigint) from (
    select jsonb_build_object('id', m.id, 'mine', m.user_id = auth.uid(), 'who', case when m.user_id = r.host then 'host' else 'guest' end,
      'nickname', coalesce(nullif(p.nickname, ''), case when m.user_id = auth.uid() then '나' else '친구' end), 'body', m.body, 'at', m.created_at) x
    from public.room_messages m left join public.profiles p on p.user_id = m.user_id
    where m.code = r.code and m.id > coalesce(p_after, 0) order by m.id desc limit 100) t), '[]'::jsonb);
end $$;

revoke all on function public.send_room_message(text, text) from public, anon;
grant execute on function public.send_room_message(text, text) to authenticated;
revoke all on function public.room_messages_after(text, bigint) from public, anon;
grant execute on function public.room_messages_after(text, bigint) to authenticated;
