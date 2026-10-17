-- Liesenberg Elektroplaner – Datenbank für Supabase (Postgres)
-- Einmal im Supabase-Dashboard unter „SQL Editor“ ausführen.
-- Rollen pro Haus: owner (legt an, lädt ein), family, electrician. Wer nicht Mitglied ist, sieht nichts.

create extension if not exists pgcrypto;

-- ------------------------------------------------------------------ Tabellen
create table if not exists public.houses (
  id          uuid primary key default gen_random_uuid(),
  name        text not null default 'Neues Haus' check (char_length(name) <= 80),
  data        jsonb not null default '{}'::jsonb,          -- der Plan: Etagen, Räume, Geräte, Einstellungen
  created_by  uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid()
);

create table if not exists public.members (
  house_id   uuid not null references public.houses(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null check (role in ('owner','family','electrician')),
  email      text,
  added_at   timestamptz not null default now(),
  primary key (house_id, user_id)
);

create table if not exists public.invites (
  id         uuid primary key default gen_random_uuid(),
  house_id   uuid not null references public.houses(id) on delete cascade,
  email      text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role       text not null check (role in ('family','electrician')),
  invited_by uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (house_id, email)
);

create table if not exists public.maintenance_log (
  id         uuid primary key default gen_random_uuid(),
  house_id   uuid not null references public.houses(id) on delete cascade,
  author     uuid default auth.uid() references auth.users(id) on delete set null,
  author_email text,
  role       text,
  date       date not null default current_date,
  type       text not null check (char_length(type) <= 60),
  area       text check (char_length(area) <= 120),
  text       text not null check (char_length(text) between 1 and 4000),
  next_date  date,
  created_at timestamptz not null default now()
);
create index if not exists maintenance_log_house on public.maintenance_log(house_id, date desc);
create index if not exists members_user on public.members(user_id);
create index if not exists invites_email on public.invites(lower(email));

-- ------------------------------------------------------------------ Hilfsfunktionen (umgehen RLS-Rekursion)
create or replace function public.house_role(h uuid) returns text
language sql stable security definer set search_path = public as $$
  select role from public.members where house_id = h and user_id = auth.uid()
$$;

create or replace function public.is_member(h uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.members where house_id = h and user_id = auth.uid())
$$;

-- Wer ein Haus anlegt, wird Besitzer
create or replace function public.add_owner() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.members(house_id, user_id, role, email)
  values (new.id, new.created_by, 'owner', (select email from auth.users where id = new.created_by));
  return new;
end $$;
drop trigger if exists houses_add_owner on public.houses;
create trigger houses_add_owner after insert on public.houses for each row execute function public.add_owner();

create or replace function public.touch_house() returns trigger
language plpgsql as $$
begin
  new.updated_at = now(); new.updated_by = auth.uid();
  new.created_by = old.created_by;  -- Besitzer lässt sich nicht über ein Update ändern
  return new;
end $$;
drop trigger if exists houses_touch on public.houses;
create trigger houses_touch before update on public.houses for each row execute function public.touch_house();

-- Nach der Anmeldung: offene Einladungen für die eigene E-Mail-Adresse annehmen
create or replace function public.accept_invites() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer := 0; em text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if auth.uid() is null or em = '' then return 0; end if;
  insert into public.members(house_id, user_id, role, email)
    select house_id, auth.uid(), role, em from public.invites where lower(email) = em
    on conflict (house_id, user_id) do nothing;
  get diagnostics n = row_count;
  delete from public.invites where lower(email) = em;
  return n;
end $$;

-- ------------------------------------------------------------------ Zugriffsregeln
alter table public.houses enable row level security;
alter table public.members enable row level security;
alter table public.invites enable row level security;
alter table public.maintenance_log enable row level security;

drop policy if exists houses_select on public.houses;
create policy houses_select on public.houses for select using (public.is_member(id));
drop policy if exists houses_insert on public.houses;
create policy houses_insert on public.houses for insert with check (auth.uid() is not null and created_by = auth.uid());
drop policy if exists houses_update on public.houses;
create policy houses_update on public.houses for update using (public.is_member(id)) with check (public.is_member(id));
drop policy if exists houses_delete on public.houses;
create policy houses_delete on public.houses for delete using (public.house_role(id) = 'owner');

drop policy if exists members_select on public.members;
create policy members_select on public.members for select using (public.is_member(house_id));
drop policy if exists members_update on public.members;
create policy members_update on public.members for update
  using (public.house_role(house_id) = 'owner' and user_id <> auth.uid())
  with check (role in ('family','electrician'));
drop policy if exists members_delete on public.members;
create policy members_delete on public.members for delete
  using ((public.house_role(house_id) = 'owner' and user_id <> auth.uid()) or (user_id = auth.uid() and role <> 'owner'));

drop policy if exists invites_select on public.invites;
create policy invites_select on public.invites for select using (public.house_role(house_id) = 'owner');
drop policy if exists invites_insert on public.invites;
create policy invites_insert on public.invites for insert with check (public.house_role(house_id) = 'owner' and invited_by = auth.uid());
drop policy if exists invites_delete on public.invites;
create policy invites_delete on public.invites for delete using (public.house_role(house_id) = 'owner');

drop policy if exists log_select on public.maintenance_log;
create policy log_select on public.maintenance_log for select using (public.is_member(house_id));
drop policy if exists log_insert on public.maintenance_log;
create policy log_insert on public.maintenance_log for insert with check (public.is_member(house_id) and author = auth.uid());
drop policy if exists log_update on public.maintenance_log;
create policy log_update on public.maintenance_log for update using (author = auth.uid()) with check (author = auth.uid());
drop policy if exists log_delete on public.maintenance_log;
create policy log_delete on public.maintenance_log for delete using (author = auth.uid() or public.house_role(house_id) = 'owner');

grant execute on function public.accept_invites() to authenticated;
grant execute on function public.is_member(uuid), public.house_role(uuid) to authenticated;

-- Live-Aktualisierung, wenn jemand anderes gleichzeitig plant oder ins Wartungsbuch schreibt
do $$ begin
  begin alter publication supabase_realtime add table public.houses; exception when others then null; end;
  begin alter publication supabase_realtime add table public.maintenance_log; exception when others then null; end;
end $$;
