-- Soro Operations: private employee profiles and first-sign-in password gate.
-- The existing platform roles remain authoritative. Employee PII is kept in a
-- separate one-to-one table so ordinary internal roles cannot browse it.

alter table public.platform_users
  add column if not exists must_change_password boolean not null default false,
  add column if not exists initial_password_issued_at timestamptz,
  add column if not exists password_changed_at timestamptz;

create table if not exists public.employee_profiles (
  user_id uuid primary key references public.platform_users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  full_name text not null check (char_length(btrim(full_name)) between 2 and 120),
  email text not null check (email = lower(btrim(email)) and char_length(email) <= 254),
  phone text not null check (char_length(btrim(phone)) between 7 and 40),
  hire_date date not null,
  address_line_1 text not null check (char_length(btrim(address_line_1)) between 2 and 160),
  address_line_2 text check (address_line_2 is null or char_length(btrim(address_line_2)) <= 160),
  city text not null check (char_length(btrim(city)) between 1 and 100),
  state_region text not null check (char_length(btrim(state_region)) between 1 and 100),
  postal_code text not null check (char_length(btrim(postal_code)) between 1 and 24),
  country text not null check (char_length(btrim(country)) between 2 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, email)
);

create index if not exists employee_profiles_organization_idx
  on public.employee_profiles (organization_id, full_name);

drop trigger if exists employee_profiles_updated_at on public.employee_profiles;
create trigger employee_profiles_updated_at
before update on public.employee_profiles
for each row execute function public.set_updated_at();

alter table public.employee_profiles enable row level security;
grant select, insert, update, delete on table public.employee_profiles to authenticated;

create policy "employees can read their own private profile"
on public.employee_profiles for select
using (
  user_id = auth.uid()
  and private.current_soro_role() is not null
);

create policy "soro admins can manage employee profiles"
on public.employee_profiles for all
using (private.is_soro_admin())
with check (private.is_soro_admin());

-- A temporary-password account has only enough access to read its own access
-- row and complete the required password change. All normal RLS helpers return
-- no role until the secure server flow clears this flag.
create or replace function private.current_soro_role()
returns public.platform_role
language sql
stable
security definer
set search_path = public
as $$
  select role
  from public.platform_users
  where id = auth.uid()
    and active = true
    and must_change_password = false
  limit 1;
$$;

revoke execute on function private.current_soro_role() from anon, public;
grant execute on function private.current_soro_role() to authenticated;

comment on table public.employee_profiles is 'Private Soro employee contact and employment details; Admin-managed and self-readable only.';
comment on column public.platform_users.must_change_password is 'Blocks normal Soro role access until the first secure password replacement succeeds.';
