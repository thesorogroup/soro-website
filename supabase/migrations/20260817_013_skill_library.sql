-- Admin-managed library of skills used for Talent matching and directory filters.
create table if not exists public.skill_library (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 100),
  description text,
  is_active boolean not null default true,
  retired_at timestamptz,
  created_by uuid references public.platform_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists skill_library_normalized_name_key
  on public.skill_library ((lower(trim(name))));

alter table public.skill_library enable row level security;

drop policy if exists "internal users can read skill library" on public.skill_library;
create policy "internal users can read skill library"
  on public.skill_library for select
  using (private.is_internal_soro_user());

drop policy if exists "soro admins can manage skill library" on public.skill_library;
create policy "soro admins can manage skill library"
  on public.skill_library for all
  using (private.is_soro_admin())
  with check (private.is_soro_admin());

drop trigger if exists skill_library_set_updated_at on public.skill_library;
create trigger skill_library_set_updated_at
  before update on public.skill_library
  for each row execute function public.set_updated_at();

grant select, insert, update, delete on table public.skill_library to authenticated;
