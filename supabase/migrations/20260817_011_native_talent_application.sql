-- Native public Talent application support. Public browser requests never get
-- direct database or storage access; the Netlify application endpoint uses
-- these private records with the server-side service role.

create table if not exists public.talent_application_drafts (
  id uuid primary key default gen_random_uuid(),
  resume_token_hash text not null unique,
  email text,
  form_data jsonb not null default '{}'::jsonb,
  uploaded_documents jsonb not null default '[]'::jsonb,
  completed_at timestamptz,
  applicant_id uuid references public.applicants(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.talent_applications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  applicant_id uuid not null references public.applicants(id) on delete cascade,
  source text not null default 'native_application',
  form_version text not null default '2026-08',
  status text not null default 'submitted',
  raw_submission jsonb not null default '{}'::jsonb,
  submitted_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists talent_applications_applicant_idx
  on public.talent_applications (applicant_id, submitted_at desc);

drop trigger if exists talent_application_drafts_updated_at on public.talent_application_drafts;

create trigger talent_application_drafts_updated_at
before update on public.talent_application_drafts
for each row execute function public.set_updated_at();

alter table public.talent_application_drafts enable row level security;
alter table public.talent_applications enable row level security;

drop policy if exists "Soro internal users can read application drafts"
on public.talent_application_drafts;
create policy "Soro internal users can read application drafts"
on public.talent_application_drafts for select to authenticated
using (private.is_internal_soro_user());

drop policy if exists "Soro admin and talent management can manage application drafts"
on public.talent_application_drafts;
create policy "Soro admin and talent management can manage application drafts"
on public.talent_application_drafts for all to authenticated
using (private.current_soro_role() in ('admin'::public.platform_role, 'talent_management'::public.platform_role))
with check (private.current_soro_role() in ('admin'::public.platform_role, 'talent_management'::public.platform_role));

drop policy if exists "Soro internal users can read submitted Talent applications"
on public.talent_applications;
create policy "Soro internal users can read submitted Talent applications"
on public.talent_applications for select to authenticated
using (private.is_internal_soro_user());

drop policy if exists "Soro admin and talent management can manage submitted Talent applications"
on public.talent_applications;
create policy "Soro admin and talent management can manage submitted Talent applications"
on public.talent_applications for all to authenticated
using (private.current_soro_role() in ('admin'::public.platform_role, 'talent_management'::public.platform_role))
with check (private.current_soro_role() in ('admin'::public.platform_role, 'talent_management'::public.platform_role));

grant select, insert, update on public.talent_application_drafts to authenticated;
grant select, insert, update on public.talent_applications to authenticated;
