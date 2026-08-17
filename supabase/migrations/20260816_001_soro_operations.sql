-- Soro Operations: first-release protected data foundation.
-- Run through Supabase SQL Editor. This creates structure only; it does not
-- import applicant information or make any records public.

create extension if not exists pgcrypto;

create type public.platform_role as enum (
  'admin', 'sales_management', 'sales', 'talent_management', 'billing', 'client_admin', 'client_reviewer', 'client_billing', 'virtual_assistant'
);

create type public.applicant_status as enum (
  'draft', 'submitted', 'in_review', 'needs_more_info', 'pending_on_hold',
  'interviewing', 'training', 'bench_ready', 'shortlisted', 'client_review',
  'placement_confirmed', 'onboarding', 'active', 'withdrawn', 'not_selected',
  'inactive', 'not_eligible', 'archived'
);

create type public.document_status as enum ('requested', 'uploaded', 'under_review', 'assigned', 'signed', 'complete', 'rejected');

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.platform_users (
  id uuid primary key references auth.users(id) on delete cascade,
  organization_id uuid references public.organizations(id) on delete set null,
  role public.platform_role not null,
  display_name text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.organizations (name) values ('Soro Group');

create table public.applicants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  auth_user_id uuid unique references auth.users(id) on delete set null,
  full_name text not null,
  email text not null,
  phone text,
  location text,
  timezone text,
  status public.applicant_status not null default 'draft',
  status_reason text,
  submitted_at timestamptz,
  availability_note text,
  expected_hourly_rate numeric(12,2),
  education_level text,
  work_status text,
  greatest_dream text,
  referral_source text,
  dedicated_workspace boolean,
  equipment_summary text,
  internet_summary text,
  english_proficiency text,
  assessment_summary text,
  loom_video_url text,
  resume_url text,
  talent_review_owner_id uuid references public.platform_users(id) on delete set null,
  sales_owner_id uuid references public.platform_users(id) on delete set null,
  talent_support_owner_id uuid references public.platform_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (organization_id, email)
);

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_name text not null,
  industry text,
  lifecycle_stage text not null default 'new_inquiry',
  sales_owner_id uuid references public.platform_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create table public.client_contacts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  full_name text not null,
  email text,
  phone text,
  contact_role text not null,
  created_at timestamptz not null default now()
);

create table public.hiring_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  title text not null,
  status text not null default 'discovery',
  start_date date,
  number_of_virtual_assistants integer not null default 1 check (number_of_virtual_assistants > 0),
  budget_status text not null default 'pending',
  required_fields jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.placements (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  applicant_id uuid not null references public.applicants(id) on delete restrict,
  hiring_request_id uuid references public.hiring_requests(id) on delete set null,
  status text not null default 'onboarding',
  start_date date,
  end_date date,
  schedule_summary text,
  rate_type text,
  client_rate numeric(12,2),
  virtual_assistant_rate numeric(12,2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, applicant_id, start_date)
);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  applicant_id uuid references public.applicants(id) on delete cascade,
  client_id uuid references public.clients(id) on delete cascade,
  placement_id uuid references public.placements(id) on delete cascade,
  file_name text not null,
  storage_path text,
  external_url text,
  document_type text not null,
  status public.document_status not null default 'uploaded',
  assigned_to_user_id uuid references public.platform_users(id) on delete set null,
  due_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (storage_path is not null or external_url is not null)
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  actor_user_id uuid references public.platform_users(id) on delete set null,
  entity_type text not null,
  entity_id uuid not null,
  event_type text not null,
  before_value jsonb,
  after_value jsonb,
  note text,
  created_at timestamptz not null default now()
);

create index applicants_org_status_idx on public.applicants (organization_id, status);
create index applicants_search_idx on public.applicants using gin (to_tsvector('english', coalesce(full_name, '') || ' ' || coalesce(email, '')));
create index clients_org_stage_idx on public.clients (organization_id, lifecycle_stage);
create index audit_entity_idx on public.audit_events (entity_type, entity_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger organizations_updated_at before update on public.organizations for each row execute function public.set_updated_at();
create trigger platform_users_updated_at before update on public.platform_users for each row execute function public.set_updated_at();
create trigger applicants_updated_at before update on public.applicants for each row execute function public.set_updated_at();
create trigger clients_updated_at before update on public.clients for each row execute function public.set_updated_at();
create trigger hiring_requests_updated_at before update on public.hiring_requests for each row execute function public.set_updated_at();
create trigger placements_updated_at before update on public.placements for each row execute function public.set_updated_at();
create trigger documents_updated_at before update on public.documents for each row execute function public.set_updated_at();

-- Defense in depth: automatic RLS was enabled at project creation; enforce it
-- explicitly for these tables. Policies are added in the next migration after
-- the Soro roles and owner account are established.
alter table public.organizations enable row level security;
alter table public.platform_users enable row level security;
alter table public.applicants enable row level security;
alter table public.clients enable row level security;
alter table public.client_contacts enable row level security;
alter table public.hiring_requests enable row level security;
alter table public.placements enable row level security;
alter table public.documents enable row level security;
alter table public.audit_events enable row level security;
