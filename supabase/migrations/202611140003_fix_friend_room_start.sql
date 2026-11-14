-- Room start can run for every side setup. Reset the reusable temp table without an unqualified DELETE,
-- which is rejected by the database's safe-delete guard ("DELETE requires a WHERE clause").
create or replace function public.room_side_setup(p_code text, p_side text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare t text; sp text; base jsonb; chosen text[] := '{}'; pick text; slot int; positions jsonb := '{}'; taken text[] := '{}';
  nm text; pos text; order_idx jsonb := '[]'; po text; pd text; n int;
begin
  select m.setup->>'team' into t from public.room_members m where m.code = p_code and m.side = p_side and m.setup is not null
    group by 1 order by count(*) desc, min(m.setup_at) asc limit 1;
  if t is null then return null; end if;
  create temp table if not exists _room_side(setup jsonb, at timestamptz) on commit drop;
  truncate table _room_side;
  insert into _room_side select m.setup, m.setup_at from public.room_members m where m.code = p_code and m.side = p_side and m.setup->>'team' = t;
  select count(*) into n from _room_side;
  select s.setup->'pitcher'->>0 into sp from _room_side s group by 1 order by count(*) desc, min(s.at) asc limit 1;
  select s.setup into base from _room_side s where s.setup->'pitcher'->>0 = sp order by s.at asc limit 1;
  for slot in 0..8 loop
    select s.setup->'players'->((s.setup->'order'->>slot)::int)->>0 into pick from _room_side s
      where not (s.setup->'players'->((s.setup->'order'->>slot)::int)->>0 = any(chosen))
      group by 1 order by count(*) desc, min(s.at) asc limit 1;
    if pick is null then
      select x->>0 into pick from jsonb_array_elements(base->'order') o, lateral (select base->'players'->((o::text)::int) x) y
        where not (x->>0 = any(chosen)) limit 1;
    end if;
    chosen := chosen || pick;
  end loop;
  for nm, pos in
    select e.key, e.value #>> '{}' from _room_side s, jsonb_each(s.setup->'positions') e
    where e.key = any(chosen) group by 1, 2 order by count(*) desc, min(s.at) asc
  loop
    if positions ? nm or pos = any(taken) then continue; end if;
    if pos = 'C' and coalesce((select p->>1 from jsonb_array_elements(base->'players') p where p->>0 = nm limit 1), '') <> 'C' then continue; end if;
    positions := positions || jsonb_build_object(nm, pos); taken := taken || pos;
  end loop;
  foreach nm in array chosen loop
    if not positions ? nm then
      select x into pos from unnest(array['DH','1B','LF','RF','3B','2B','CF','SS','C']) x where not (x = any(taken)) limit 1;
      positions := positions || jsonb_build_object(nm, pos); taken := taken || pos;
    end if;
    order_idx := order_idx || to_jsonb((select (ord - 1)::int from jsonb_array_elements(base->'players') with ordinality p(v, ord) where v->>0 = nm limit 1));
  end loop;
  select s.setup->'plan'->>'offense' into po from _room_side s where s.setup->'plan'->>'offense' is not null group by 1 order by count(*) desc, min(s.at) asc limit 1;
  select s.setup->'plan'->>'defense' into pd from _room_side s where s.setup->'plan'->>'defense' is not null group by 1 order by count(*) desc, min(s.at) asc limit 1;
  return (base - 'order' - 'positions' - 'plan') || jsonb_build_object('order', order_idx, 'positions', positions,
    'plan', jsonb_build_object('offense', coalesce(po, 'normal'), 'defense', coalesce(pd, 'normal')), 'votes', n);
end $$;
revoke all on function public.room_side_setup(text, text) from public, anon, authenticated;
