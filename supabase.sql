-- „Mūsų rutina“ – bendro plano saugykla.
-- Įklijuokite VISĄ šį tekstą į Supabase → SQL Editor → Run.
-- Lentelė tiesiogiai nepasiekiama; skaityti / rašyti galima tik per dvi funkcijas ir tik žinant plano kodą.

create table if not exists public.rutina_rooms (
  room       text primary key,
  data       jsonb not null default '{}'::jsonb,
  version    int  not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.rutina_rooms enable row level security;
revoke all on public.rutina_rooms from anon, authenticated;

create or replace function public.rutina_get(p_room text)
returns json language sql security definer set search_path = public as $$
  select json_build_object('data', data, 'version', version)
  from rutina_rooms where room = p_room and length(p_room) >= 18;
$$;

create or replace function public.rutina_put(p_room text, p_data jsonb, p_version int)
returns json language plpgsql security definer set search_path = public as $$
declare cur int;
begin
  if length(p_room) < 18 then raise exception 'bad room'; end if;
  if octet_length(p_data::text) > 1000000 then raise exception 'too big'; end if;
  select version into cur from rutina_rooms where room = p_room for update;
  if cur is null then
    insert into rutina_rooms(room, data, version) values (p_room, p_data, 1);
    return json_build_object('ok', true, 'version', 1);
  end if;
  if cur <> p_version then
    return json_build_object('ok', false, 'version', cur, 'data', (select data from rutina_rooms where room = p_room));
  end if;
  update rutina_rooms set data = p_data, version = cur + 1, updated_at = now() where room = p_room;
  return json_build_object('ok', true, 'version', cur + 1);
end $$;

revoke all on function public.rutina_get(text) from public;
revoke all on function public.rutina_put(text, jsonb, int) from public;
grant execute on function public.rutina_get(text) to anon;
grant execute on function public.rutina_put(text, jsonb, int) to anon;
