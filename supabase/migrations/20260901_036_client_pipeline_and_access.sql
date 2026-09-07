-- Soro Operations: Client intake pipeline and secure Client portal access.
--
-- Browser callers may read the four legacy tables through organization-scoped
-- RLS, but all writes now pass through service-only RPCs.  The RPCs derive the
-- actor's organization and Sales ownership, apply optimistic locking, record a
-- value-free audit event, and make retried requests idempotent.

-- ---------------------------------------------------------------------------
-- Organization consistency and canonical lifecycle data
-- ---------------------------------------------------------------------------

alter table public.client_contacts
  add column if not exists organization_id uuid,
  add column if not exists is_primary boolean not null default false,
  add column if not exists portal_login_email text,
  add column if not exists portal_access_status text not null default 'not_invited',
  add column if not exists portal_invite_sent_at timestamptz,
  add column if not exists portal_access_activated_at timestamptz,
  add column if not exists portal_last_password_reset_sent_at timestamptz,
  add column if not exists portal_email_changed_at timestamptz,
  add column if not exists portal_access_updated_by uuid,
  add column if not exists portal_access_updated_at timestamptz;

alter table public.clients
  add column if not exists legacy_lifecycle_stage text;

alter table public.hiring_requests
  add column if not exists organization_id uuid,
  add column if not exists legacy_status text;

alter table public.placements
  add column if not exists organization_id uuid;

update public.client_contacts as contact
set organization_id = client.organization_id
from public.clients as client
where contact.client_id = client.id
  and contact.organization_id is null;

-- Keep the primary-contact identity separate from the person's display title.
-- Legacy rows used either "Primary" or "Primary contact" in contact_role; pick
-- only one deterministic active match per Client before enforcing uniqueness.
with primary_contact_candidates as (
  select
    contact.id,
    row_number() over (
      partition by contact.client_id
      order by contact.created_at, contact.id
    ) as candidate_rank
  from public.client_contacts as contact
  where contact.active = true
    and lower(btrim(coalesce(contact.contact_role, ''))) in ('primary', 'primary contact')
    and not exists (
      select 1
      from public.client_contacts as marked
      where marked.client_id = contact.client_id
        and marked.is_primary = true
    )
)
update public.client_contacts as contact
set is_primary = true
from primary_contact_candidates as candidate
where candidate.id = contact.id
  and candidate.candidate_rank = 1;

update public.hiring_requests as request
set organization_id = client.organization_id
from public.clients as client
where request.client_id = client.id
  and request.organization_id is null;

update public.placements as placement
set organization_id = client.organization_id
from public.clients as client
where placement.client_id = client.id
  and placement.organization_id is null;

alter table public.client_contacts alter column organization_id set not null;
alter table public.hiring_requests alter column organization_id set not null;
alter table public.placements alter column organization_id set not null;

-- Preserve any historical free-form value before normalizing it.  Production
-- currently has no Client pipeline rows, but this keeps the migration safe for
-- restored or preview databases too.
update public.clients
set legacy_lifecycle_stage = lifecycle_stage,
    lifecycle_stage = case
      when archived_at is not null then 'archived'
      when regexp_replace(lower(btrim(lifecycle_stage)), '[[:space:]-]+', '_', 'g') in (
        'new_inquiry', 'discovery', 'qualified', 'matching', 'active', 'paused', 'lost', 'archived'
      ) then regexp_replace(lower(btrim(lifecycle_stage)), '[[:space:]-]+', '_', 'g')
      else 'new_inquiry'
    end
where lifecycle_stage is null
   or regexp_replace(lower(btrim(lifecycle_stage)), '[[:space:]-]+', '_', 'g') not in (
     'new_inquiry', 'discovery', 'qualified', 'matching', 'active', 'paused', 'lost', 'archived'
   )
   or lifecycle_stage is distinct from regexp_replace(lower(btrim(lifecycle_stage)), '[[:space:]-]+', '_', 'g')
   or archived_at is not null;

update public.hiring_requests
set legacy_status = status,
    status = case regexp_replace(lower(btrim(status)), '[[:space:]-]+', '_', 'g')
      when 'qualified' then 'open'
      when 'active' then 'open'
      when 'matching' then 'sourcing'
      when 'shortlisted' then 'shortlisting'
      when 'canceled' then 'cancelled'
      when 'closed' then 'filled'
      when 'draft' then 'draft'
      when 'discovery' then 'discovery'
      when 'open' then 'open'
      when 'sourcing' then 'sourcing'
      when 'shortlisting' then 'shortlisting'
      when 'client_review' then 'client_review'
      when 'interviewing' then 'interviewing'
      when 'selection_pending' then 'selection_pending'
      when 'placement_pending' then 'placement_pending'
      when 'partially_filled' then 'partially_filled'
      when 'filled' then 'filled'
      when 'on_hold' then 'on_hold'
      when 'cancelled' then 'cancelled'
      else 'discovery'
    end
where status is null
   or status is distinct from case regexp_replace(lower(btrim(status)), '[[:space:]-]+', '_', 'g')
      when 'qualified' then 'open'
      when 'active' then 'open'
      when 'matching' then 'sourcing'
      when 'shortlisted' then 'shortlisting'
      when 'canceled' then 'cancelled'
      when 'closed' then 'filled'
      when 'draft' then 'draft'
      when 'discovery' then 'discovery'
      when 'open' then 'open'
      when 'sourcing' then 'sourcing'
      when 'shortlisting' then 'shortlisting'
      when 'client_review' then 'client_review'
      when 'interviewing' then 'interviewing'
      when 'selection_pending' then 'selection_pending'
      when 'placement_pending' then 'placement_pending'
      when 'partially_filled' then 'partially_filled'
      when 'filled' then 'filled'
      when 'on_hold' then 'on_hold'
      when 'cancelled' then 'cancelled'
      else 'discovery'
    end;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'clients_lifecycle_stage_canonical'
      and conrelid = 'public.clients'::regclass
  ) then
    alter table public.clients add constraint clients_lifecycle_stage_canonical
      check (lifecycle_stage in (
        'new_inquiry', 'discovery', 'qualified', 'matching', 'active', 'paused', 'lost', 'archived'
      ));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'hiring_requests_status_canonical'
      and conrelid = 'public.hiring_requests'::regclass
  ) then
    alter table public.hiring_requests add constraint hiring_requests_status_canonical
      check (status in (
        'draft', 'discovery', 'open', 'sourcing', 'shortlisting', 'client_review',
        'interviewing', 'selection_pending', 'placement_pending', 'partially_filled',
        'filled', 'on_hold', 'cancelled'
      ));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'client_contacts_portal_access_status_check'
      and conrelid = 'public.client_contacts'::regclass
  ) then
    alter table public.client_contacts add constraint client_contacts_portal_access_status_check
      check (portal_access_status in (
        'not_invited', 'invite_pending', 'active', 'suspended', 'delivery_failed', 'needs_reconciliation'
      ));
  end if;
end
$$;

create unique index if not exists client_contacts_id_organization_unique
  on public.client_contacts (id, organization_id);
create unique index if not exists hiring_requests_id_organization_unique
  on public.hiring_requests (id, organization_id);
create unique index if not exists hiring_requests_id_client_organization_unique
  on public.hiring_requests (id, client_id, organization_id);
create unique index if not exists placements_id_organization_unique
  on public.placements (id, organization_id);
create index if not exists client_contacts_org_client_active_idx
  on public.client_contacts (organization_id, client_id, active, created_at);
create unique index if not exists client_contacts_one_primary_per_client
  on public.client_contacts (client_id)
  where is_primary = true;
create index if not exists hiring_requests_org_client_status_idx
  on public.hiring_requests (organization_id, client_id, status, updated_at desc);
create unique index if not exists client_contacts_portal_login_email_unique
  on public.client_contacts (lower(portal_login_email))
  where portal_login_email is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'client_contacts_client_organization_fkey'
      and conrelid = 'public.client_contacts'::regclass
  ) then
    alter table public.client_contacts add constraint client_contacts_client_organization_fkey
      foreign key (client_id, organization_id)
      references public.clients (id, organization_id) on delete cascade;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'hiring_requests_client_organization_fkey'
      and conrelid = 'public.hiring_requests'::regclass
  ) then
    alter table public.hiring_requests add constraint hiring_requests_client_organization_fkey
      foreign key (client_id, organization_id)
      references public.clients (id, organization_id) on delete cascade;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'placements_client_organization_fkey'
      and conrelid = 'public.placements'::regclass
  ) then
    alter table public.placements add constraint placements_client_organization_fkey
      foreign key (client_id, organization_id)
      references public.clients (id, organization_id) on delete restrict not valid;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'placements_applicant_organization_fkey'
      and conrelid = 'public.placements'::regclass
  ) then
    alter table public.placements add constraint placements_applicant_organization_fkey
      foreign key (applicant_id, organization_id)
      references public.applicants (id, organization_id) on delete restrict not valid;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'placements_request_client_organization_fkey'
      and conrelid = 'public.placements'::regclass
  ) then
    alter table public.placements add constraint placements_request_client_organization_fkey
      foreign key (hiring_request_id, client_id, organization_id)
      references public.hiring_requests (id, client_id, organization_id)
      on delete set null (hiring_request_id) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'client_contacts_portal_updater_organization_fkey'
      and conrelid = 'public.client_contacts'::regclass
  ) then
    alter table public.client_contacts add constraint client_contacts_portal_updater_organization_fkey
      foreign key (portal_access_updated_by, organization_id)
      references public.platform_users (id, organization_id) on delete set null (portal_access_updated_by) not valid;
  end if;
end
$$;

-- Validate legacy placement relations only when the existing records are
-- already consistent.  NOT VALID still protects every new or changed record.
do $$
begin
  if not exists (
    select 1 from public.placements as placement
    left join public.clients as client
      on client.id = placement.client_id
     and client.organization_id = placement.organization_id
    where client.id is null
  ) then
    alter table public.placements validate constraint placements_client_organization_fkey;
  end if;
  if not exists (
    select 1 from public.placements as placement
    left join public.applicants as applicant
      on applicant.id = placement.applicant_id
     and applicant.organization_id = placement.organization_id
    where applicant.id is null
  ) then
    alter table public.placements validate constraint placements_applicant_organization_fkey;
  end if;
  if not exists (
    select 1 from public.placements as placement
    left join public.hiring_requests as request
      on request.id = placement.hiring_request_id
     and request.client_id = placement.client_id
     and request.organization_id = placement.organization_id
    where placement.hiring_request_id is not null and request.id is null
  ) then
    alter table public.placements validate constraint placements_request_client_organization_fkey;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Remove legacy direct writes and replace broad reads with organization scope.
-- ---------------------------------------------------------------------------

revoke insert, update, delete on table public.clients from public, anon, authenticated;
revoke insert, update, delete on table public.client_contacts from public, anon, authenticated;
revoke insert, update, delete on table public.hiring_requests from public, anon, authenticated;
revoke insert, update, delete on table public.placements from public, anon, authenticated;

grant select on table public.clients to authenticated, service_role;
grant select on table public.client_contacts to authenticated, service_role;
grant select on table public.hiring_requests to authenticated, service_role;
grant select on table public.placements to authenticated, service_role;
grant insert, update, delete on table public.clients to service_role;
grant insert, update, delete on table public.client_contacts to service_role;
grant insert, update, delete on table public.hiring_requests to service_role;
grant insert, update, delete on table public.placements to service_role;

drop policy if exists "internal users can read clients" on public.clients;
drop policy if exists "sales can manage clients" on public.clients;
drop policy if exists "internal users can read client contacts" on public.client_contacts;
drop policy if exists "sales can manage client contacts" on public.client_contacts;
drop policy if exists "internal users can read hiring requests" on public.hiring_requests;
drop policy if exists "sales can manage hiring requests" on public.hiring_requests;
drop policy if exists "internal users can read placements" on public.placements;
drop policy if exists "admin and talent management can manage placements" on public.placements;
drop policy if exists "organization internal users can read clients" on public.clients;
drop policy if exists "organization internal users can read client contacts" on public.client_contacts;
drop policy if exists "organization internal users can read hiring requests" on public.hiring_requests;
drop policy if exists "organization internal users can read placements" on public.placements;

create policy "organization internal users can read clients"
on public.clients for select to authenticated
using (
  private.is_internal_soro_user()
  and organization_id = private.current_soro_organization_id()
  and (
    private.current_soro_role() <> 'sales'::public.platform_role
    or sales_owner_id = auth.uid()
  )
);

create policy "organization internal users can read client contacts"
on public.client_contacts for select to authenticated
using (
  private.is_internal_soro_user()
  and organization_id = private.current_soro_organization_id()
  and (
    private.current_soro_role() <> 'sales'::public.platform_role
    or exists (
      select 1 from public.clients as scoped_client
      where scoped_client.id = client_contacts.client_id
        and scoped_client.organization_id = client_contacts.organization_id
        and scoped_client.sales_owner_id = auth.uid()
    )
  )
);

create policy "organization internal users can read hiring requests"
on public.hiring_requests for select to authenticated
using (
  private.is_internal_soro_user()
  and organization_id = private.current_soro_organization_id()
  and (
    private.current_soro_role() <> 'sales'::public.platform_role
    or exists (
      select 1 from public.clients as scoped_client
      where scoped_client.id = hiring_requests.client_id
        and scoped_client.organization_id = hiring_requests.organization_id
        and scoped_client.sales_owner_id = auth.uid()
    )
  )
);

create policy "organization internal users can read placements"
on public.placements for select to authenticated
using (
  private.is_internal_soro_user()
  and organization_id = private.current_soro_organization_id()
  and (
    private.current_soro_role() <> 'sales'::public.platform_role
    or exists (
      select 1 from public.clients as scoped_client
      where scoped_client.id = placements.client_id
        and scoped_client.organization_id = placements.organization_id
        and scoped_client.sales_owner_id = auth.uid()
    )
  )
);

-- ---------------------------------------------------------------------------
-- Idempotency ledgers.  They are service-only and intentionally have no RLS
-- policies; even internal browser sessions cannot enumerate request history.
-- ---------------------------------------------------------------------------

create table if not exists public.client_pipeline_operations (
  operation_request_id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  actor_user_id uuid not null,
  action text not null,
  client_id uuid,
  contact_id uuid,
  hiring_request_id uuid,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  result jsonb not null,
  created_at timestamptz not null default now(),
  constraint client_pipeline_operations_actor_organization_fkey
    foreign key (actor_user_id, organization_id)
    references public.platform_users (id, organization_id) on delete restrict
);

create index if not exists client_pipeline_operations_actor_idx
  on public.client_pipeline_operations (organization_id, actor_user_id, created_at desc);

create table if not exists public.client_portal_access_operations (
  operation_request_id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  actor_user_id uuid not null,
  client_contact_id uuid not null,
  audit_event_id uuid not null unique references public.audit_events(id) on delete restrict,
  action text not null,
  requested_email text,
  requested_portal_role public.platform_role,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  result jsonb,
  failure_code text,
  delivery_payload jsonb,
  delivery_payload_created_at timestamptz,
  delivery_first_attempt_at timestamptz,
  lease_token uuid not null default gen_random_uuid(),
  lease_holder_user_id uuid not null,
  last_takeover_at timestamptz,
  lease_expires_at timestamptz not null default now(),
  attempt_count integer not null default 1 check (attempt_count >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_portal_access_operations_actor_organization_fkey
    foreign key (actor_user_id, organization_id)
    references public.platform_users (id, organization_id) on delete restrict,
  constraint client_portal_access_operations_lease_holder_organization_fkey
    foreign key (lease_holder_user_id, organization_id)
    references public.platform_users (id, organization_id) on delete restrict,
  constraint client_portal_access_operations_contact_organization_fkey
    foreign key (client_contact_id, organization_id)
    references public.client_contacts (id, organization_id) on delete restrict,
  constraint client_portal_access_operations_terminal_result_check check (
    (status = 'pending' and result is null and failure_code is null)
    or (status = 'completed' and result is not null and failure_code is null)
    or (status = 'failed' and result is null and failure_code is not null)
  ),
  constraint client_portal_access_operations_delivery_checkpoint_check check (
    (delivery_payload is null and delivery_payload_created_at is null and delivery_first_attempt_at is null)
    or (delivery_payload is not null and delivery_payload_created_at is not null)
  ),
  constraint client_portal_access_operations_request_context_check check (
    (
      action = 'activate'
      and requested_email is not null
      and requested_portal_role in (
        'client_admin'::public.platform_role,
        'client_reviewer'::public.platform_role,
        'client_billing'::public.platform_role
      )
    )
    or (
      action = 'change_email'
      and requested_email is not null
      and requested_portal_role is null
    )
    or (
      action in ('resend_invitation', 'send_password_reset', 'suspend_access', 'reactivate_access')
      and requested_email is null
      and requested_portal_role is null
    )
  )
);

create table if not exists public.client_portal_access_request_aliases (
  submitted_request_id uuid primary key,
  effective_operation_request_id uuid not null
    references public.client_portal_access_operations(operation_request_id) on delete restrict,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  submitted_by_user_id uuid not null,
  client_contact_id uuid not null,
  action text not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  constraint client_portal_access_request_aliases_actor_organization_fkey
    foreign key (submitted_by_user_id, organization_id)
    references public.platform_users (id, organization_id) on delete restrict,
  constraint client_portal_access_request_aliases_contact_organization_fkey
    foreign key (client_contact_id, organization_id)
    references public.client_contacts (id, organization_id) on delete restrict
);

drop trigger if exists client_portal_access_operations_updated_at
on public.client_portal_access_operations;
create trigger client_portal_access_operations_updated_at
before update on public.client_portal_access_operations
for each row execute function public.set_updated_at();

create unique index if not exists client_portal_access_one_pending_per_contact
  on public.client_portal_access_operations (client_contact_id)
  where status = 'pending';

-- Once the invited contact replaces the one-use bootstrap credential, reflect
-- the active state on the contact record without relying on a browser callback.
create or replace function private.sync_client_contact_portal_status()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.role in (
      'client_admin'::public.platform_role,
      'client_reviewer'::public.platform_role,
      'client_billing'::public.platform_role
    ) then
    update public.client_contacts as contact
    set portal_access_status = case
          when contact.portal_access_status = 'needs_reconciliation' then 'needs_reconciliation'
          when new.active is false then 'suspended'
          when new.must_change_password is false then 'active'
          when contact.portal_access_status = 'delivery_failed' then 'delivery_failed'
          else 'invite_pending'
        end,
        portal_access_activated_at = case
          when new.active and new.must_change_password is false
            then coalesce(contact.portal_access_activated_at, new.password_changed_at, now())
          else contact.portal_access_activated_at
        end,
        portal_access_updated_at = now()
    where exists (
      select 1
      from public.client_portal_memberships as membership
      where membership.user_id = new.id
        and membership.organization_id = new.organization_id
        and membership.client_contact_id = contact.id
    );
  end if;
  return new;
end;
$$;

drop trigger if exists sync_client_contact_portal_status on public.platform_users;
create trigger sync_client_contact_portal_status
after update of active, must_change_password, password_changed_at on public.platform_users
for each row execute function private.sync_client_contact_portal_status();

revoke all on function private.sync_client_contact_portal_status()
  from public, anon, authenticated;

alter table public.client_pipeline_operations enable row level security;
alter table public.client_portal_access_operations enable row level security;
alter table public.client_portal_access_request_aliases enable row level security;
revoke all on table public.client_pipeline_operations from public, anon, authenticated;
revoke all on table public.client_portal_access_operations from public, anon, authenticated;
revoke all on table public.client_portal_access_request_aliases from public, anon, authenticated;
grant select, insert on table public.client_pipeline_operations to service_role;
revoke all on table public.client_portal_access_operations from service_role;
revoke all on table public.client_portal_access_request_aliases from service_role;

-- ---------------------------------------------------------------------------
-- Shared actor, state, and projection helpers.
-- ---------------------------------------------------------------------------

create or replace function private.client_pipeline_actor(p_actor_user_id uuid)
returns table (
  user_id uuid,
  organization_id uuid,
  role public.platform_role
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  return query
  select access.id, access.organization_id, access.role
  from public.platform_users as access
  where access.id = p_actor_user_id
    and access.organization_id is not null
    and access.active = true
    and access.must_change_password = false
    and access.role in (
      'admin'::public.platform_role,
      'sales_management'::public.platform_role,
      'sales'::public.platform_role,
      'talent_management'::public.platform_role
    );
  if not found then
    raise exception using errcode = '42501', message = 'Active Client pipeline access is required.';
  end if;
end;
$$;

revoke all on function private.client_pipeline_actor(uuid) from public, anon, authenticated;

create or replace function private.client_stage_transition_allowed(p_from text, p_to text)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog
as $$
  select p_from = p_to or case p_from
    when 'new_inquiry' then p_to in ('discovery', 'lost', 'archived')
    when 'discovery' then p_to in ('qualified', 'paused', 'lost', 'archived')
    when 'qualified' then p_to in ('matching', 'paused', 'lost', 'archived')
    when 'matching' then p_to in ('active', 'paused', 'lost', 'archived')
    when 'active' then p_to in ('paused', 'lost', 'archived')
    when 'paused' then p_to in ('discovery', 'qualified', 'matching', 'active', 'lost', 'archived')
    when 'lost' then p_to = 'archived'
    else false
  end;
$$;

create or replace function private.client_request_transition_allowed(p_from text, p_to text)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog
as $$
  select p_from = p_to or case p_from
    when 'draft' then p_to in ('discovery', 'cancelled')
    when 'discovery' then p_to in ('open', 'on_hold', 'cancelled')
    when 'open' then p_to in ('sourcing', 'on_hold', 'cancelled')
    when 'sourcing' then p_to in ('shortlisting', 'on_hold', 'cancelled')
    when 'shortlisting' then p_to in ('client_review', 'on_hold', 'cancelled')
    when 'client_review' then p_to in ('interviewing', 'selection_pending', 'on_hold', 'cancelled')
    when 'interviewing' then p_to in ('client_review', 'selection_pending', 'on_hold', 'cancelled')
    when 'selection_pending' then p_to in ('placement_pending', 'interviewing', 'on_hold', 'cancelled')
    when 'placement_pending' then p_to in ('partially_filled', 'filled', 'selection_pending', 'on_hold', 'cancelled')
    when 'partially_filled' then p_to in (
      'sourcing', 'shortlisting', 'client_review', 'interviewing', 'selection_pending',
      'placement_pending', 'filled', 'on_hold', 'cancelled'
    )
    when 'on_hold' then p_to in (
      'discovery', 'open', 'sourcing', 'shortlisting', 'client_review', 'interviewing',
      'selection_pending', 'placement_pending', 'cancelled'
    )
    else false
  end;
$$;

revoke all on function private.client_stage_transition_allowed(text, text)
  from public, anon, authenticated;
revoke all on function private.client_request_transition_allowed(text, text)
  from public, anon, authenticated;

create or replace function private.client_pipeline_workspace_json(
  p_organization_id uuid,
  p_viewer_role public.platform_role,
  p_actor_user_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'generatedAt', statement_timestamp(),
    'viewerRole', p_viewer_role::text,
    'clients', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'clientId', client.id,
          'companyName', client.company_name,
          'industry', client.industry,
          'lifecycleStage', client.lifecycle_stage,
          'salesOwnerId', client.sales_owner_id,
          'addressLine1', client.address_line_1,
          'addressLine2', client.address_line_2,
          'city', client.city,
          'stateRegion', client.state_region,
          'postalCode', client.postal_code,
          'country', client.country,
          'companyPhone', client.company_phone,
          'website', client.website,
          'archivedAt', client.archived_at,
          'createdAt', client.created_at,
          'updatedAt', client.updated_at,
          'canEdit', p_viewer_role in (
            'admin'::public.platform_role,
            'sales_management'::public.platform_role,
            'sales'::public.platform_role
          ),
          'activity', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'eventType', activity.event_type,
                'label', case activity.event_type
                  when 'client_created' then 'Client created'
                  when 'client_pipeline_update_client' then 'Client details updated'
                  when 'client_pipeline_set_client_stage' then 'Client stage updated'
                  when 'client_pipeline_archive_client' then 'Client archived'
                  when 'client_pipeline_assign_owner' then 'Sales owner updated'
                  when 'client_pipeline_create_contact' then 'Client contact added'
                  when 'client_pipeline_update_contact' then 'Client contact updated'
                  when 'client_pipeline_deactivate_contact' then 'Client contact deactivated'
                  when 'client_pipeline_reactivate_contact' then 'Client contact reactivated'
                  when 'client_pipeline_create_request' then 'Hiring request added'
                  when 'client_pipeline_update_request' then 'Hiring request updated'
                  when 'client_pipeline_set_request_status' then 'Hiring request status updated'
                  when 'client_portal_access_activate' then case activity.outcome
                    when 'completed' then 'Client portal invitation created'
                    when 'pending' then 'Client portal invitation pending'
                    when 'failed' then 'Client portal invitation failed'
                    else 'Client portal invitation status unavailable'
                  end
                  when 'client_portal_access_resend_invitation' then case activity.outcome
                    when 'completed' then 'Client portal invitation resent'
                    when 'pending' then 'Client portal invitation resend pending'
                    when 'failed' then 'Client portal invitation resend failed'
                    else 'Client portal invitation resend status unavailable'
                  end
                  when 'client_portal_access_change_email' then case activity.outcome
                    when 'completed' then 'Client portal login email changed'
                    when 'pending' then 'Client portal login email change pending'
                    when 'failed' then 'Client portal login email change failed'
                    else 'Client portal login email change status unavailable'
                  end
                  when 'client_portal_access_send_password_reset' then case activity.outcome
                    when 'completed' then 'Client portal password reset sent'
                    when 'pending' then 'Client portal password reset pending'
                    when 'failed' then 'Client portal password reset failed'
                    else 'Client portal password reset status unavailable'
                  end
                  when 'client_portal_access_suspend_access' then case activity.outcome
                    when 'completed' then 'Client portal access suspended'
                    when 'pending' then 'Client portal access suspension pending'
                    when 'failed' then 'Client portal access suspension failed'
                    else 'Client portal access suspension status unavailable'
                  end
                  when 'client_portal_access_reactivate_access' then case activity.outcome
                    when 'completed' then 'Client portal access reactivated'
                    when 'pending' then 'Client portal access reactivation pending'
                    when 'failed' then 'Client portal access reactivation failed'
                    else 'Client portal access reactivation status unavailable'
                  end
                  when 'client_portal_setup_completed' then case activity.outcome
                    when 'completed' then 'Client portal account setup completed'
                    when 'pending' then 'Client portal account setup pending'
                    when 'failed' then 'Client portal account setup failed'
                    else 'Client portal account setup status unavailable'
                  end
                  when 'client_portal_password_recovery_completed' then case activity.outcome
                    when 'completed' then 'Client portal password recovery completed'
                    when 'pending' then 'Client portal password recovery pending'
                    when 'failed' then 'Client portal password recovery failed'
                    else 'Client portal password recovery status unavailable'
                  end
                  else 'Client activity'
                end,
                'createdAt', activity.created_at
              ) order by activity.created_at desc, activity.id desc
            )
            from (
              select event.id, event.event_type,
                -- Normalize one non-sensitive state token for the label. Raw
                -- audit values and notes never enter the Client projection.
                case lower(coalesce(event.after_value ->> 'outcome', ''))
                  when 'completed' then 'completed'
                  when 'pending' then 'pending'
                  when 'failed' then 'failed'
                  else null
                end as outcome,
                event.created_at
              from public.audit_events as event
              where event.organization_id = client.organization_id
                and (
                  (event.entity_type = 'client' and event.entity_id = client.id)
                  or (
                    event.entity_type in ('client_contact', 'client_portal_access')
                    and exists (
                      select 1 from public.client_contacts as activity_contact
                      where activity_contact.id = event.entity_id
                        and activity_contact.organization_id = client.organization_id
                        and activity_contact.client_id = client.id
                    )
                  )
                  or (
                    event.entity_type = 'hiring_request'
                    and exists (
                      select 1 from public.hiring_requests as activity_request
                      where activity_request.id = event.entity_id
                        and activity_request.organization_id = client.organization_id
                        and activity_request.client_id = client.id
                    )
                  )
                )
              order by event.created_at desc, event.id desc
              limit 100
            ) as activity
          ), '[]'::jsonb),
          'contacts', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'contactId', contact.id,
                'fullName', contact.full_name,
                'email', contact.email,
                'phone', contact.phone,
                'contactRole', contact.contact_role,
                'isPrimary', contact.is_primary,
                'active', contact.active,
                'portalLoginEmail', contact.portal_login_email,
                'portalAccessStatus', contact.portal_access_status,
                'portalInviteSentAt', contact.portal_invite_sent_at,
                'portalAccessActivatedAt', contact.portal_access_activated_at,
                'pendingPortalAccess', case
                  when p_viewer_role in (
                      'admin'::public.platform_role,
                      'sales_management'::public.platform_role,
                      'sales'::public.platform_role
                    )
                  then (
                    select jsonb_build_object(
                      'action', pending_access.action,
                      'email', pending_access.requested_email,
                      'portalRole', pending_access.requested_portal_role
                    )
                    from public.client_portal_access_operations as pending_access
                    where pending_access.organization_id = contact.organization_id
                      and pending_access.client_contact_id = contact.id
                      and pending_access.status = 'pending'
                      and (
                        p_viewer_role in (
                          'admin'::public.platform_role,
                          'sales_management'::public.platform_role
                        )
                        or pending_access.actor_user_id = p_actor_user_id
                      )
                    order by pending_access.created_at, pending_access.operation_request_id
                    limit 1
                  )
                  else null
                end,
                'createdAt', contact.created_at,
                'updatedAt', contact.updated_at
              ) order by contact.active desc, contact.is_primary desc, contact.created_at, contact.id
            )
            from public.client_contacts as contact
            where contact.organization_id = client.organization_id
              and contact.client_id = client.id
          ), '[]'::jsonb),
          'hiringRequests', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'hiringRequestId', request.id,
                'title', request.title,
                'status', request.status,
                'startDate', request.start_date,
                'numberOfTalent', request.number_of_virtual_assistants,
                'budgetStatus', request.budget_status,
                'requiredFields', request.required_fields,
                'createdAt', request.created_at,
                'updatedAt', request.updated_at
              ) order by request.created_at desc, request.id
            )
            from public.hiring_requests as request
            where request.organization_id = client.organization_id
              and request.client_id = client.id
          ), '[]'::jsonb)
        ) order by client.archived_at nulls first, client.updated_at desc, client.id
      )
      from public.clients as client
      where client.organization_id = p_organization_id
        and (p_viewer_role <> 'sales'::public.platform_role or client.sales_owner_id = p_actor_user_id)
    ), '[]'::jsonb),
    'salesOwners', case
      when p_viewer_role in ('admin'::public.platform_role, 'sales_management'::public.platform_role)
      then coalesce((
        select jsonb_agg(
          jsonb_build_object('userId', owner.id, 'displayName', owner.display_name)
          order by lower(coalesce(owner.display_name, '')), owner.id
        )
        from public.platform_users as owner
        where owner.organization_id = p_organization_id
          and owner.active = true
          and owner.must_change_password = false
          and owner.role = 'sales'::public.platform_role
      ), '[]'::jsonb)
      else '[]'::jsonb
    end
  );
$$;

revoke all on function private.client_pipeline_workspace_json(uuid, public.platform_role, uuid)
  from public, anon, authenticated;

create or replace function public.get_client_pipeline_workspace(p_actor_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_actor record;
begin
  select * into v_actor from private.client_pipeline_actor(p_actor_user_id);
  return private.client_pipeline_workspace_json(v_actor.organization_id, v_actor.role, v_actor.user_id);
end;
$$;

revoke all on function public.get_client_pipeline_workspace(uuid) from public, anon, authenticated;
grant execute on function public.get_client_pipeline_workspace(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Atomic Client/contact/request mutation RPC.
-- ---------------------------------------------------------------------------

create or replace function public.change_client_pipeline(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_action text,
  p_expected_updated_at timestamptz,
  p_entity_id uuid,
  p_parent_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_actor record;
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_fingerprint text;
  v_existing public.client_pipeline_operations%rowtype;
  v_client public.clients%rowtype;
  v_contact public.client_contacts%rowtype;
  v_request public.hiring_requests%rowtype;
  v_client_id uuid;
  v_contact_id uuid;
  v_hiring_request_id uuid;
  v_owner_id uuid;
  v_next text;
  v_before jsonb;
  v_after jsonb;
  v_result jsonb;
begin
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'A request id is required.';
  end if;
  if jsonb_typeof(v_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'Client pipeline payload must be an object.';
  end if;
  if v_action not in (
    'create_client', 'update_client', 'set_client_stage', 'archive_client', 'assign_owner',
    'create_contact', 'update_contact', 'deactivate_contact', 'reactivate_contact',
    'create_request', 'update_request', 'set_request_status'
  ) then
    raise exception using errcode = '22023', message = 'Choose a supported Client pipeline action.';
  end if;

  select * into v_actor from private.client_pipeline_actor(p_actor_user_id);
  if v_actor.role = 'talent_management'::public.platform_role then
    raise exception using errcode = '42501', message = 'Talent Management has read-only Client access.';
  end if;

  v_fingerprint := encode(
    digest(
      convert_to(concat_ws(
        '|', v_action, coalesce(p_entity_id::text, ''), coalesce(p_parent_id::text, ''),
        coalesce(p_expected_updated_at::text, ''), v_payload::text
      ), 'utf8'),
      'sha256'
    ),
    'hex'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('client-pipeline-operation:' || p_request_id::text, 0)
  );
  select operation.* into v_existing
  from public.client_pipeline_operations as operation
  where operation.operation_request_id = p_request_id;
  if v_existing.operation_request_id is not null then
    if v_existing.organization_id is distinct from v_actor.organization_id
      or v_existing.actor_user_id is distinct from v_actor.user_id
      or v_existing.action is distinct from v_action
      or v_existing.request_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = '23505', message = 'This request id has already been used for another Client action.';
    end if;
    return v_existing.result;
  end if;

  if v_action = 'create_client' then
    if p_entity_id is not null or p_parent_id is not null or p_expected_updated_at is not null
      or not (v_payload ? 'client' and v_payload ? 'primaryContact' and v_payload ? 'firstRequest')
      or jsonb_typeof(v_payload -> 'client') <> 'object'
      or jsonb_typeof(v_payload -> 'primaryContact') <> 'object'
      or jsonb_typeof(v_payload -> 'firstRequest') <> 'object'
      or exists (select 1 from jsonb_object_keys(v_payload) as key where key not in ('client', 'primaryContact', 'firstRequest'))
      or exists (select 1 from jsonb_object_keys(v_payload -> 'client') as key where key not in (
        'companyName', 'industry', 'addressLine1', 'addressLine2', 'city', 'stateRegion',
        'postalCode', 'country', 'companyPhone', 'website', 'salesOwnerId'
      ))
      or exists (select 1 from jsonb_object_keys(v_payload -> 'primaryContact') as key where key not in (
        'fullName', 'email', 'phone', 'contactRole'
      ))
      or exists (select 1 from jsonb_object_keys(v_payload -> 'firstRequest') as key where key not in (
        'title', 'status', 'startDate', 'numberOfTalent', 'budgetStatus', 'requiredFields'
      )) then
      raise exception using errcode = '22023', message = 'Create Client requires one Client, primary contact, and first hiring request.';
    end if;

    if char_length(btrim(coalesce(v_payload #>> '{client,companyName}', ''))) not between 2 and 160
      or char_length(btrim(coalesce(v_payload #>> '{primaryContact,fullName}', ''))) not between 2 and 120
      or char_length(btrim(coalesce(v_payload #>> '{firstRequest,title}', ''))) not between 2 and 160 then
      raise exception using errcode = '22023', message = 'Client, contact, and hiring request names are required.';
    end if;

    v_owner_id := case
      when v_actor.role = 'sales'::public.platform_role then v_actor.user_id
      else nullif(v_payload #>> '{client,salesOwnerId}', '')::uuid
    end;
    if v_owner_id is not null and not exists (
      select 1 from public.platform_users as owner
      where owner.id = v_owner_id
        and owner.organization_id = v_actor.organization_id
        and owner.active = true
        and owner.must_change_password = false
        and owner.role = 'sales'::public.platform_role
    ) then
      raise exception using errcode = '22023', message = 'Choose an active Sales owner in this organization.';
    end if;

    v_next := lower(btrim(coalesce(v_payload #>> '{firstRequest,status}', 'discovery')));
    if v_next not in ('draft', 'discovery') then
      raise exception using errcode = '22023', message = 'A new hiring request must begin in Draft or Discovery.';
    end if;

    insert into public.clients (
      organization_id, company_name, industry, lifecycle_stage, sales_owner_id,
      address_line_1, address_line_2, city, state_region, postal_code, country, company_phone, website
    ) values (
      v_actor.organization_id,
      btrim(v_payload #>> '{client,companyName}'),
      nullif(btrim(coalesce(v_payload #>> '{client,industry}', '')), ''),
      'new_inquiry',
      v_owner_id,
      nullif(btrim(coalesce(v_payload #>> '{client,addressLine1}', '')), ''),
      nullif(btrim(coalesce(v_payload #>> '{client,addressLine2}', '')), ''),
      nullif(btrim(coalesce(v_payload #>> '{client,city}', '')), ''),
      nullif(btrim(coalesce(v_payload #>> '{client,stateRegion}', '')), ''),
      nullif(btrim(coalesce(v_payload #>> '{client,postalCode}', '')), ''),
      nullif(btrim(coalesce(v_payload #>> '{client,country}', '')), ''),
      nullif(btrim(coalesce(v_payload #>> '{client,companyPhone}', '')), ''),
      nullif(btrim(coalesce(v_payload #>> '{client,website}', '')), '')
    ) returning * into v_client;

    insert into public.client_contacts (
      organization_id, client_id, full_name, email, phone, contact_role, active, is_primary
    ) values (
      v_actor.organization_id,
      v_client.id,
      btrim(v_payload #>> '{primaryContact,fullName}'),
      nullif(lower(btrim(coalesce(v_payload #>> '{primaryContact,email}', ''))), ''),
      nullif(btrim(coalesce(v_payload #>> '{primaryContact,phone}', '')), ''),
      coalesce(nullif(btrim(coalesce(v_payload #>> '{primaryContact,contactRole}', '')), ''), 'Primary contact'),
      true,
      true
    ) returning * into v_contact;

    insert into public.hiring_requests (
      organization_id, client_id, title, status, start_date,
      number_of_virtual_assistants, budget_status, required_fields
    ) values (
      v_actor.organization_id,
      v_client.id,
      btrim(v_payload #>> '{firstRequest,title}'),
      v_next,
      nullif(v_payload #>> '{firstRequest,startDate}', '')::date,
      greatest(1, least(100, coalesce((v_payload #>> '{firstRequest,numberOfTalent}')::integer, 1))),
      coalesce(nullif(btrim(coalesce(v_payload #>> '{firstRequest,budgetStatus}', '')), ''), 'pending'),
      case when jsonb_typeof(v_payload #> '{firstRequest,requiredFields}') = 'object'
        then v_payload #> '{firstRequest,requiredFields}' else '{}'::jsonb end
    ) returning * into v_request;

    v_client_id := v_client.id;
    v_contact_id := v_contact.id;
    v_hiring_request_id := v_request.id;
    v_result := jsonb_build_object(
      'action', v_action,
      'clientId', v_client_id,
      'contactId', v_contact_id,
      'hiringRequestId', v_hiring_request_id,
      'clientUpdatedAt', v_client.updated_at,
      'contactUpdatedAt', v_contact.updated_at,
      'hiringRequestUpdatedAt', v_request.updated_at
    );
    insert into public.audit_events (
      organization_id, actor_user_id, entity_type, entity_id, event_type, after_value
    ) values (
      v_actor.organization_id, v_actor.user_id, 'client', v_client_id, 'client_created',
      jsonb_build_object('changed_fields', jsonb_build_array('client', 'primaryContact', 'firstRequest'))
    );
  else
    if p_expected_updated_at is null
      or (v_action not in ('create_contact', 'create_request') and p_entity_id is null) then
      raise exception using errcode = '22023', message = 'Reload the Client record and try this action again.';
    end if;

    if v_action in ('update_client', 'set_client_stage', 'archive_client', 'assign_owner') then
      if p_parent_id is not null then
        raise exception using errcode = '22023', message = 'This Client action does not accept a parent id.';
      end if;
      select * into v_client from public.clients as client
      where client.id = p_entity_id and client.organization_id = v_actor.organization_id
      for update;
      if not found or (v_actor.role = 'sales'::public.platform_role and v_client.sales_owner_id is distinct from v_actor.user_id) then
        raise exception using errcode = '42501', message = 'This Client is outside your Sales scope.';
      end if;
      if v_client.updated_at is distinct from p_expected_updated_at then
        raise exception using errcode = 'P0001', message = 'The Client changed. Reload it and try again.';
      end if;
      if v_client.archived_at is not null then
        raise exception using errcode = 'P0001', message = 'Archived Clients cannot be changed.';
      end if;
      v_client_id := v_client.id;
      v_before := jsonb_build_object('lifecycleStage', v_client.lifecycle_stage, 'salesOwnerId', v_client.sales_owner_id);

      if v_action = 'update_client' then
        if p_payload = '{}'::jsonb or exists (select 1 from jsonb_object_keys(v_payload) as key where key not in (
          'companyName', 'industry', 'addressLine1', 'addressLine2', 'city', 'stateRegion',
          'postalCode', 'country', 'companyPhone', 'website'
        )) then
          raise exception using errcode = '22023', message = 'Choose supported Client profile fields.';
        end if;
        update public.clients set
          company_name = case when v_payload ? 'companyName' then btrim(v_payload ->> 'companyName') else company_name end,
          industry = case when v_payload ? 'industry' then nullif(btrim(coalesce(v_payload ->> 'industry', '')), '') else industry end,
          address_line_1 = case when v_payload ? 'addressLine1' then nullif(btrim(coalesce(v_payload ->> 'addressLine1', '')), '') else address_line_1 end,
          address_line_2 = case when v_payload ? 'addressLine2' then nullif(btrim(coalesce(v_payload ->> 'addressLine2', '')), '') else address_line_2 end,
          city = case when v_payload ? 'city' then nullif(btrim(coalesce(v_payload ->> 'city', '')), '') else city end,
          state_region = case when v_payload ? 'stateRegion' then nullif(btrim(coalesce(v_payload ->> 'stateRegion', '')), '') else state_region end,
          postal_code = case when v_payload ? 'postalCode' then nullif(btrim(coalesce(v_payload ->> 'postalCode', '')), '') else postal_code end,
          country = case when v_payload ? 'country' then nullif(btrim(coalesce(v_payload ->> 'country', '')), '') else country end,
          company_phone = case when v_payload ? 'companyPhone' then nullif(btrim(coalesce(v_payload ->> 'companyPhone', '')), '') else company_phone end,
          website = case when v_payload ? 'website' then nullif(btrim(coalesce(v_payload ->> 'website', '')), '') else website end
        where id = v_client.id returning * into v_client;
      elsif v_action = 'set_client_stage' then
        if not (v_payload ? 'stage')
          or exists (select 1 from jsonb_object_keys(v_payload) as key where key <> 'stage') then
          raise exception using errcode = '22023', message = 'Choose one Client lifecycle stage.';
        end if;
        v_next := lower(btrim(v_payload ->> 'stage'));
        if v_next in ('active', 'archived') then
          raise exception using errcode = '42501', message = 'Active and archived Client stages are controlled by their dedicated workflows.';
        end if;
        if not private.client_stage_transition_allowed(v_client.lifecycle_stage, v_next) then
          raise exception using errcode = 'P0001', message = 'That Client lifecycle transition is not allowed.';
        end if;
        update public.clients set lifecycle_stage = v_next
        where id = v_client.id returning * into v_client;
      elsif v_action = 'assign_owner' then
        if v_actor.role not in ('admin'::public.platform_role, 'sales_management'::public.platform_role)
          or not (v_payload ? 'salesOwnerId')
          or exists (select 1 from jsonb_object_keys(v_payload) as key where key <> 'salesOwnerId') then
          raise exception using errcode = '42501', message = 'Only Admin or Sales Management can reassign Client ownership.';
        end if;
        v_owner_id := nullif(v_payload ->> 'salesOwnerId', '')::uuid;
        if v_owner_id is not null and not exists (
          select 1 from public.platform_users as owner
          where owner.id = v_owner_id and owner.organization_id = v_actor.organization_id
            and owner.active = true and owner.must_change_password = false
            and owner.role = 'sales'::public.platform_role
        ) then
          raise exception using errcode = '22023', message = 'Choose an active Sales owner in this organization.';
        end if;
        update public.clients set sales_owner_id = v_owner_id
        where id = v_client.id returning * into v_client;
      else
        if v_payload <> '{}'::jsonb then
          raise exception using errcode = '22023', message = 'Archive Client does not accept editable fields.';
        end if;
        update public.clients set lifecycle_stage = 'archived', archived_at = now()
        where id = v_client.id returning * into v_client;
        update public.client_contacts set active = false,
          portal_access_status = case when portal_login_email is null then 'not_invited' else 'suspended' end,
          portal_access_updated_by = v_actor.user_id, portal_access_updated_at = now()
        where client_id = v_client.id and organization_id = v_actor.organization_id;
        update public.client_portal_memberships set active = false
        where client_id = v_client.id and organization_id = v_actor.organization_id;
        update public.platform_users as access set active = false
        where access.organization_id = v_actor.organization_id
          and exists (
            select 1 from public.client_portal_memberships as membership
            where membership.user_id = access.id and membership.client_id = v_client.id
          );
      end if;
      v_after := jsonb_build_object('lifecycleStage', v_client.lifecycle_stage, 'salesOwnerId', v_client.sales_owner_id);
      v_result := jsonb_build_object('action', v_action, 'clientId', v_client.id, 'updatedAt', v_client.updated_at);
    elsif v_action in ('create_contact', 'update_contact', 'deactivate_contact', 'reactivate_contact') then
      if v_action = 'create_contact' then
        if p_parent_id is null or p_entity_id is not null then
          raise exception using errcode = '22023', message = 'Choose one Client for the new contact.';
        end if;
        select * into v_client from public.clients as client
        where client.id = p_parent_id and client.organization_id = v_actor.organization_id
        for update;
        if not found or v_client.archived_at is not null
          or (v_actor.role = 'sales'::public.platform_role and v_client.sales_owner_id is distinct from v_actor.user_id) then
          raise exception using errcode = '42501', message = 'This Client is outside your Sales scope.';
        end if;
        if v_client.updated_at is distinct from p_expected_updated_at then
          raise exception using errcode = 'P0001', message = 'The Client changed. Reload it and try again.';
        end if;
        if not (v_payload ? 'fullName') or exists (select 1 from jsonb_object_keys(v_payload) as key where key not in (
          'fullName', 'email', 'phone', 'contactRole'
        )) then
          raise exception using errcode = '22023', message = 'A new Client contact requires a name.';
        end if;
        insert into public.client_contacts (
          organization_id, client_id, full_name, email, phone, contact_role, active
        ) values (
          v_actor.organization_id, v_client.id, btrim(v_payload ->> 'fullName'),
          nullif(lower(btrim(coalesce(v_payload ->> 'email', ''))), ''),
          nullif(btrim(coalesce(v_payload ->> 'phone', '')), ''),
          coalesce(nullif(btrim(coalesce(v_payload ->> 'contactRole', '')), ''), 'Contact'), true
        ) returning * into v_contact;
        v_before := null;
      else
        if p_parent_id is not null then
          raise exception using errcode = '22023', message = 'This contact action does not accept a parent id.';
        end if;
        select contact.* into v_contact
        from public.client_contacts as contact
        join public.clients as client
          on client.id = contact.client_id and client.organization_id = contact.organization_id
        where contact.id = p_entity_id and contact.organization_id = v_actor.organization_id
          and client.archived_at is null
          and (v_actor.role <> 'sales'::public.platform_role or client.sales_owner_id = v_actor.user_id)
        for update of contact;
        if not found then
          raise exception using errcode = '42501', message = 'This contact is outside your Sales scope.';
        end if;
        if v_contact.updated_at is distinct from p_expected_updated_at then
          raise exception using errcode = 'P0001', message = 'The contact changed. Reload it and try again.';
        end if;
        v_before := jsonb_build_object('active', v_contact.active);
        if v_action = 'update_contact' then
          if v_payload = '{}'::jsonb or exists (select 1 from jsonb_object_keys(v_payload) as key where key not in (
            'fullName', 'email', 'phone', 'contactRole'
          )) then
            raise exception using errcode = '22023', message = 'Choose supported Client contact fields.';
          end if;
          update public.client_contacts set
            full_name = case when v_payload ? 'fullName' then btrim(v_payload ->> 'fullName') else full_name end,
            email = case when v_payload ? 'email' then nullif(lower(btrim(coalesce(v_payload ->> 'email', ''))), '') else email end,
            phone = case when v_payload ? 'phone' then nullif(btrim(coalesce(v_payload ->> 'phone', '')), '') else phone end,
            contact_role = case when v_payload ? 'contactRole' then btrim(v_payload ->> 'contactRole') else contact_role end
          where id = v_contact.id returning * into v_contact;
        elsif v_action = 'deactivate_contact' then
          if v_payload <> '{}'::jsonb then
            raise exception using errcode = '22023', message = 'Deactivate contact does not accept editable fields.';
          end if;
          update public.client_contacts set active = false,
            portal_access_status = case when portal_login_email is null then 'not_invited' else 'suspended' end,
            portal_access_updated_by = v_actor.user_id, portal_access_updated_at = now()
          where id = v_contact.id returning * into v_contact;
          update public.client_portal_memberships set active = false
          where client_contact_id = v_contact.id and organization_id = v_actor.organization_id;
          update public.platform_users as access set active = false
          where access.organization_id = v_actor.organization_id
            and exists (
              select 1 from public.client_portal_memberships as membership
              where membership.user_id = access.id and membership.client_contact_id = v_contact.id
            );
        else
          if v_payload <> '{}'::jsonb then
            raise exception using errcode = '22023', message = 'Reactivate contact does not accept editable fields.';
          end if;
          update public.client_contacts set active = true
          where id = v_contact.id returning * into v_contact;
        end if;
      end if;
      v_client_id := v_contact.client_id;
      v_contact_id := v_contact.id;
      v_after := jsonb_build_object('active', v_contact.active);
      v_result := jsonb_build_object('action', v_action, 'clientId', v_client_id, 'contactId', v_contact.id, 'updatedAt', v_contact.updated_at);
    else
      if v_action = 'create_request' then
        if p_parent_id is null or p_entity_id is not null then
          raise exception using errcode = '22023', message = 'Choose one Client for the new hiring request.';
        end if;
        select * into v_client from public.clients as client
        where client.id = p_parent_id and client.organization_id = v_actor.organization_id
        for update;
        if not found or v_client.archived_at is not null
          or (v_actor.role = 'sales'::public.platform_role and v_client.sales_owner_id is distinct from v_actor.user_id) then
          raise exception using errcode = '42501', message = 'This Client is outside your Sales scope.';
        end if;
        if v_client.updated_at is distinct from p_expected_updated_at then
          raise exception using errcode = 'P0001', message = 'The Client changed. Reload it and try again.';
        end if;
        if not (v_payload ? 'title') or exists (select 1 from jsonb_object_keys(v_payload) as key where key not in (
          'title', 'status', 'startDate', 'numberOfTalent', 'budgetStatus', 'requiredFields'
        )) then
          raise exception using errcode = '22023', message = 'A new hiring request requires a title.';
        end if;
        v_next := lower(btrim(coalesce(v_payload ->> 'status', 'draft')));
        if v_next not in ('draft', 'discovery') then
          raise exception using errcode = '22023', message = 'A new hiring request must begin in Draft or Discovery.';
        end if;
        insert into public.hiring_requests (
          organization_id, client_id, title, status, start_date,
          number_of_virtual_assistants, budget_status, required_fields
        ) values (
          v_actor.organization_id, v_client.id, btrim(v_payload ->> 'title'), v_next,
          nullif(v_payload ->> 'startDate', '')::date,
          greatest(1, least(100, coalesce((v_payload ->> 'numberOfTalent')::integer, 1))),
          coalesce(nullif(btrim(coalesce(v_payload ->> 'budgetStatus', '')), ''), 'pending'),
          case when jsonb_typeof(v_payload -> 'requiredFields') = 'object' then v_payload -> 'requiredFields' else '{}'::jsonb end
        ) returning * into v_request;
        v_before := null;
      else
        if p_parent_id is not null then
          raise exception using errcode = '22023', message = 'This hiring request action does not accept a parent id.';
        end if;
        select request.* into v_request
        from public.hiring_requests as request
        join public.clients as client
          on client.id = request.client_id and client.organization_id = request.organization_id
        where request.id = p_entity_id and request.organization_id = v_actor.organization_id
          and client.archived_at is null
          and (v_actor.role <> 'sales'::public.platform_role or client.sales_owner_id = v_actor.user_id)
        for update of request;
        if not found then
          raise exception using errcode = '42501', message = 'This hiring request is outside your Sales scope.';
        end if;
        if v_request.updated_at is distinct from p_expected_updated_at then
          raise exception using errcode = 'P0001', message = 'The hiring request changed. Reload it and try again.';
        end if;
        v_before := jsonb_build_object('status', v_request.status);
        if v_action = 'update_request' then
          if v_payload = '{}'::jsonb or exists (select 1 from jsonb_object_keys(v_payload) as key where key not in (
            'title', 'startDate', 'numberOfTalent', 'budgetStatus', 'requiredFields'
          )) then
            raise exception using errcode = '22023', message = 'Choose supported hiring request fields.';
          end if;
          update public.hiring_requests set
            title = case when v_payload ? 'title' then btrim(v_payload ->> 'title') else title end,
            start_date = case when v_payload ? 'startDate' then nullif(v_payload ->> 'startDate', '')::date else start_date end,
            number_of_virtual_assistants = case when v_payload ? 'numberOfTalent'
              then greatest(1, least(100, (v_payload ->> 'numberOfTalent')::integer)) else number_of_virtual_assistants end,
            budget_status = case when v_payload ? 'budgetStatus' then btrim(v_payload ->> 'budgetStatus') else budget_status end,
            required_fields = case when v_payload ? 'requiredFields' and jsonb_typeof(v_payload -> 'requiredFields') = 'object'
              then v_payload -> 'requiredFields' else required_fields end
          where id = v_request.id returning * into v_request;
        else
          if not (v_payload ? 'status')
            or exists (select 1 from jsonb_object_keys(v_payload) as key where key <> 'status') then
            raise exception using errcode = '22023', message = 'Choose one hiring request status.';
          end if;
          v_next := lower(btrim(v_payload ->> 'status'));
          if v_next is distinct from v_request.status
            and v_next not in ('discovery', 'open', 'sourcing', 'on_hold', 'cancelled') then
            raise exception using errcode = '42501', message = 'That hiring request state is controlled by the shortlist, interview, or placement workflow.';
          end if;
          if not private.client_request_transition_allowed(v_request.status, v_next) then
            raise exception using errcode = 'P0001', message = 'That hiring request transition is not allowed.';
          end if;
          update public.hiring_requests set status = v_next
          where id = v_request.id returning * into v_request;
        end if;
      end if;
      v_client_id := v_request.client_id;
      v_hiring_request_id := v_request.id;
      v_after := jsonb_build_object('status', v_request.status);
      v_result := jsonb_build_object('action', v_action, 'clientId', v_client_id, 'hiringRequestId', v_request.id, 'updatedAt', v_request.updated_at);
    end if;

    insert into public.audit_events (
      organization_id, actor_user_id, entity_type, entity_id, event_type, before_value, after_value
    ) values (
      v_actor.organization_id,
      v_actor.user_id,
      case when v_contact_id is not null then 'client_contact'
        when v_hiring_request_id is not null then 'hiring_request' else 'client' end,
      coalesce(v_contact_id, v_hiring_request_id, v_client_id),
      'client_pipeline_' || v_action,
      v_before,
      v_after
    );
  end if;

  insert into public.client_pipeline_operations (
    operation_request_id, organization_id, actor_user_id, action,
    client_id, contact_id, hiring_request_id, request_fingerprint, result
  ) values (
    p_request_id, v_actor.organization_id, v_actor.user_id, v_action,
    v_client_id, v_contact_id, v_hiring_request_id, v_fingerprint, v_result
  );
  return v_result;
end;
$$;

revoke all on function public.change_client_pipeline(
  uuid, uuid, text, timestamptz, uuid, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.change_client_pipeline(
  uuid, uuid, text, timestamptz, uuid, uuid, jsonb
) to service_role;

-- Recover the exact Auth user created by an access operation when the Auth API
-- accepted the request but its response was lost. The correlation lives only
-- in Auth metadata and this lookup is never exposed to browser roles.
create or replace function public.find_client_auth_user_for_request(
  p_request_id uuid,
  p_email text
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select account.id
  from auth.users account
  where lower(account.email) = lower(btrim(p_email))
    and account.raw_app_meta_data ->> 'soro_client_access_request_id' = p_request_id::text
  order by account.created_at desc
  limit 1
$$;

revoke all on function public.find_client_auth_user_for_request(uuid, text)
  from public, anon, authenticated;
grant execute on function public.find_client_auth_user_for_request(uuid, text)
  to service_role;

-- Claim one external access workflow per Client contact before any Auth,
-- membership, contact, or email side effect starts. Same-intent retries are
-- durably aliased to the original operation, while Admin/Sales Management may
-- safely take over an expired lease without changing the original audit actor.
drop function if exists public.reserve_client_portal_access_operation(uuid, uuid, uuid, text, text);
create or replace function public.reserve_client_portal_access_operation(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_client_contact_id uuid,
  p_action text,
  p_request_fingerprint text,
  p_requested_email text,
  p_requested_portal_role public.platform_role
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $$
declare
  v_actor record;
  v_contact public.client_contacts%rowtype;
  v_alias public.client_portal_access_request_aliases%rowtype;
  v_existing public.client_portal_access_operations%rowtype;
  v_blocking public.client_portal_access_operations%rowtype;
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_requested_email text := nullif(lower(btrim(coalesce(p_requested_email, ''))), '');
  v_lease_token uuid := gen_random_uuid();
  v_audit_event_id uuid;
  v_effective_request_id uuid;
  v_can_take_over boolean;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_request_id is null or p_client_contact_id is null
    or p_request_fingerprint !~ '^[0-9a-f]{64}$'
    or v_action not in (
      'activate', 'resend_invitation', 'change_email',
      'send_password_reset', 'suspend_access', 'reactivate_access'
    )
    or (
      v_action = 'activate'
      and (
        v_requested_email is null
        or length(v_requested_email) not between 3 and 254
        or v_requested_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
        or p_requested_portal_role is null
        or p_requested_portal_role not in (
          'client_admin'::public.platform_role,
          'client_reviewer'::public.platform_role,
          'client_billing'::public.platform_role
        )
      )
    )
    or (
      v_action = 'change_email'
      and (
        v_requested_email is null
        or length(v_requested_email) not between 3 and 254
        or v_requested_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
        or p_requested_portal_role is not null
      )
    )
    or (
      v_action in ('resend_invitation', 'send_password_reset', 'suspend_access', 'reactivate_access')
      and (v_requested_email is not null or p_requested_portal_role is not null)
    ) then
    raise exception using errcode = '22023', message = 'The Client access operation claim is invalid.';
  end if;

  select * into v_actor from private.client_pipeline_actor(p_actor_user_id);
  if v_actor.role = 'talent_management'::public.platform_role then
    raise exception using errcode = '42501', message = 'Client portal access management is required.';
  end if;
  v_can_take_over := v_actor.role in (
    'admin'::public.platform_role,
    'sales_management'::public.platform_role
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('client-portal-access-contact:' || p_client_contact_id::text, 0)
  );
  select contact.* into v_contact
  from public.client_contacts as contact
  join public.clients as client
    on client.id = contact.client_id
   and client.organization_id = contact.organization_id
  where contact.id = p_client_contact_id
    and contact.organization_id = v_actor.organization_id
    and (
      v_actor.role <> 'sales'::public.platform_role
      or client.sales_owner_id = v_actor.user_id
    )
  for update of contact;
  if not found then
    raise exception using errcode = '42501', message = 'This Client contact is outside your access scope.';
  end if;

  select request_alias.* into v_alias
  from public.client_portal_access_request_aliases as request_alias
  where request_alias.submitted_request_id = p_request_id
  for update;
  if v_alias.submitted_request_id is not null then
    if v_alias.organization_id is distinct from v_actor.organization_id
      or v_alias.client_contact_id is distinct from p_client_contact_id
      or v_alias.action is distinct from v_action
      or v_alias.request_fingerprint is distinct from p_request_fingerprint
      or (v_alias.submitted_by_user_id is distinct from v_actor.user_id and not v_can_take_over) then
      raise exception using errcode = '23505', message = 'This request id was already used for another Client access action.';
    end if;
    v_effective_request_id := v_alias.effective_operation_request_id;
    select operation.* into v_existing
    from public.client_portal_access_operations as operation
    where operation.operation_request_id = v_effective_request_id
    for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'This Client access request alias has no durable operation.';
    end if;
  else
    select operation.* into v_existing
    from public.client_portal_access_operations as operation
    where operation.operation_request_id = p_request_id
    for update;
    if found then
      v_effective_request_id := p_request_id;
    end if;
  end if;

  if v_existing.operation_request_id is not null then
    if v_existing.organization_id is distinct from v_actor.organization_id
      or v_existing.client_contact_id is distinct from p_client_contact_id
      or v_existing.action is distinct from v_action
      or v_existing.requested_email is distinct from v_requested_email
      or v_existing.requested_portal_role is distinct from p_requested_portal_role
      or v_existing.request_fingerprint is distinct from p_request_fingerprint
      or (v_existing.actor_user_id is distinct from v_actor.user_id and not v_can_take_over) then
      raise exception using errcode = '23505', message = 'This request id was already used for another Client access action.';
    end if;
    if v_alias.submitted_request_id is null then
      insert into public.client_portal_access_request_aliases (
        submitted_request_id, effective_operation_request_id, organization_id,
        submitted_by_user_id, client_contact_id, action, request_fingerprint
      ) values (
        p_request_id, v_effective_request_id, v_existing.organization_id,
        v_existing.actor_user_id, v_existing.client_contact_id, v_existing.action,
        v_existing.request_fingerprint
      );
    end if;
    if v_existing.status = 'completed' then
      if v_existing.result is null then
        raise exception using errcode = 'P0001', message = 'This completed Client access operation has no durable result.';
      end if;
      return jsonb_build_object(
        'state', 'completed', 'result', v_existing.result,
        'auditEventId', v_existing.audit_event_id
      );
    end if;
    if v_existing.status = 'failed' then
      return jsonb_build_object('state', 'failed', 'failureCode', v_existing.failure_code);
    end if;
    if v_existing.lease_expires_at > v_now then
      return jsonb_build_object(
        'state', 'busy',
        'retryAfterSeconds', greatest(1, ceil(extract(epoch from (v_existing.lease_expires_at - v_now)))::integer)
      );
    end if;

    update public.client_portal_access_operations
    set lease_token = v_lease_token,
        lease_holder_user_id = v_actor.user_id,
        last_takeover_at = case when actor_user_id is distinct from v_actor.user_id then v_now else last_takeover_at end,
        lease_expires_at = v_now + interval '2 minutes',
        attempt_count = least(attempt_count::bigint + 1, 2147483647)::integer,
        failure_code = null
    where operation_request_id = v_effective_request_id;
    return jsonb_build_object(
      'state', 'claimed',
      'effectiveRequestId', v_effective_request_id,
      'leaseToken', v_lease_token,
      'resumed', true,
      'auditEventId', v_existing.audit_event_id,
      'operationCreatedAt', v_existing.created_at,
      'deliveryPayload', v_existing.delivery_payload,
      'deliveryPayloadCreatedAt', v_existing.delivery_payload_created_at,
      'deliveryFirstAttemptAt', v_existing.delivery_first_attempt_at
    );
  end if;

  select operation.* into v_blocking
  from public.client_portal_access_operations as operation
  where operation.client_contact_id = p_client_contact_id
    and operation.status = 'pending'
  order by operation.created_at
  limit 1
  for update;
  if v_blocking.operation_request_id is not null then
    if v_blocking.organization_id = v_actor.organization_id
      and v_blocking.action = v_action
      and v_blocking.requested_email is not distinct from v_requested_email
      and v_blocking.requested_portal_role is not distinct from p_requested_portal_role
      and v_blocking.request_fingerprint = p_request_fingerprint
      and (v_blocking.actor_user_id = v_actor.user_id or v_can_take_over) then
      insert into public.client_portal_access_request_aliases (
        submitted_request_id, effective_operation_request_id, organization_id,
        submitted_by_user_id, client_contact_id, action, request_fingerprint
      ) values (
        p_request_id, v_blocking.operation_request_id, v_actor.organization_id,
        v_actor.user_id, p_client_contact_id, v_action, p_request_fingerprint
      );
      if v_blocking.lease_expires_at > v_now then
        return jsonb_build_object(
          'state', 'busy',
          'retryAfterSeconds', greatest(1, ceil(extract(epoch from (v_blocking.lease_expires_at - v_now)))::integer)
        );
      end if;
      update public.client_portal_access_operations
      set lease_token = v_lease_token,
          lease_holder_user_id = v_actor.user_id,
          last_takeover_at = case when actor_user_id is distinct from v_actor.user_id then v_now else last_takeover_at end,
          lease_expires_at = v_now + interval '2 minutes',
          attempt_count = least(attempt_count::bigint + 1, 2147483647)::integer,
          failure_code = null
      where operation_request_id = v_blocking.operation_request_id;
      return jsonb_build_object(
        'state', 'claimed',
        'effectiveRequestId', v_blocking.operation_request_id,
        'leaseToken', v_lease_token,
        'resumed', true,
        'auditEventId', v_blocking.audit_event_id,
        'operationCreatedAt', v_blocking.created_at,
        'deliveryPayload', v_blocking.delivery_payload,
        'deliveryPayloadCreatedAt', v_blocking.delivery_payload_created_at,
        'deliveryFirstAttemptAt', v_blocking.delivery_first_attempt_at
      );
    end if;
    return jsonb_build_object(
      'state', case when v_blocking.lease_expires_at > v_now then 'busy' else 'reconciliation_required' end,
      'retryAfterSeconds', case when v_blocking.lease_expires_at > v_now
        then greatest(1, ceil(extract(epoch from (v_blocking.lease_expires_at - v_now)))::integer)
        else null end
    );
  end if;

  insert into public.audit_events (
    organization_id, actor_user_id, entity_type, entity_id, event_type,
    after_value, note
  ) values (
    v_actor.organization_id, v_actor.user_id, 'client_portal_access', p_client_contact_id,
    'client_portal_access_' || v_action,
    jsonb_build_object('outcome', 'pending', 'request_id', p_request_id),
    'Soro authorized ' || replace(v_action, '_', ' ') || '; the final outcome is pending.'
  ) returning id into v_audit_event_id;

  insert into public.client_portal_access_operations (
    operation_request_id, organization_id, actor_user_id, client_contact_id, audit_event_id,
    action, requested_email, requested_portal_role, request_fingerprint,
    status, lease_token, lease_holder_user_id,
    lease_expires_at, attempt_count
  ) values (
    p_request_id, v_actor.organization_id, v_actor.user_id, p_client_contact_id, v_audit_event_id,
    v_action, v_requested_email, p_requested_portal_role, p_request_fingerprint,
    'pending', v_lease_token, v_actor.user_id,
    v_now + interval '2 minutes', 1
  );
  insert into public.client_portal_access_request_aliases (
    submitted_request_id, effective_operation_request_id, organization_id,
    submitted_by_user_id, client_contact_id, action, request_fingerprint
  ) values (
    p_request_id, p_request_id, v_actor.organization_id,
    v_actor.user_id, p_client_contact_id, v_action, p_request_fingerprint
  );
  return jsonb_build_object(
    'state', 'claimed',
    'effectiveRequestId', p_request_id,
    'leaseToken', v_lease_token,
    'resumed', false,
    'auditEventId', v_audit_event_id,
    'operationCreatedAt', v_now,
    'deliveryPayload', null,
    'deliveryPayloadCreatedAt', null,
    'deliveryFirstAttemptAt', null
  );
end;
$$;

create or replace function public.checkpoint_client_portal_access_delivery(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_client_contact_id uuid,
  p_action text,
  p_request_fingerprint text,
  p_lease_token uuid,
  p_delivery_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_actor record;
  v_existing public.client_portal_access_operations%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_request_id is null or p_client_contact_id is null or p_lease_token is null
    or p_request_fingerprint !~ '^[0-9a-f]{64}$'
    or p_delivery_payload is null or jsonb_typeof(p_delivery_payload) <> 'object'
    or octet_length(p_delivery_payload::text) > 50000 then
    raise exception using errcode = '22023', message = 'The Client access delivery checkpoint is invalid.';
  end if;
  select * into v_actor from private.client_pipeline_actor(p_actor_user_id);
  if v_actor.role = 'talent_management'::public.platform_role then
    raise exception using errcode = '42501', message = 'Client portal access management is required.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('client-portal-access-contact:' || p_client_contact_id::text, 0)
  );
  select operation.* into v_existing
  from public.client_portal_access_operations as operation
  where operation.operation_request_id = p_request_id
  for update;
  if not found
    or v_existing.organization_id is distinct from v_actor.organization_id
    or v_existing.lease_holder_user_id is distinct from v_actor.user_id
    or v_existing.client_contact_id is distinct from p_client_contact_id
    or v_existing.action is distinct from lower(btrim(coalesce(p_action, '')))
    or v_existing.request_fingerprint is distinct from p_request_fingerprint
    or v_existing.status <> 'pending'
    or v_existing.lease_token is distinct from p_lease_token
    or not exists (
      select 1
      from public.client_contacts as scoped_contact
      join public.clients as scoped_client
        on scoped_client.id = scoped_contact.client_id
       and scoped_client.organization_id = scoped_contact.organization_id
      where scoped_contact.id = v_existing.client_contact_id
        and scoped_contact.organization_id = v_actor.organization_id
        and (
          v_actor.role <> 'sales'::public.platform_role
          or scoped_client.sales_owner_id = v_actor.user_id
        )
    ) then
    raise exception using errcode = '42501', message = 'This Client access delivery lease is no longer current.';
  end if;
  if v_existing.delivery_payload is not null
    and v_existing.delivery_payload is distinct from p_delivery_payload then
    if v_existing.delivery_first_attempt_at is not null
      and v_existing.delivery_first_attempt_at > v_now - interval '24 hours 5 minutes' then
      raise exception using errcode = '23505', message = 'This Client access delivery is still inside the provider idempotency window.';
    end if;
    update public.client_portal_access_operations
    set delivery_payload = p_delivery_payload,
        delivery_payload_created_at = v_now,
        delivery_first_attempt_at = null
    where operation_request_id = p_request_id;
    return p_delivery_payload;
  end if;
  if v_existing.delivery_payload is null then
    update public.client_portal_access_operations
    set delivery_payload = p_delivery_payload,
        delivery_payload_created_at = v_now
    where operation_request_id = p_request_id;
  end if;
  return coalesce(v_existing.delivery_payload, p_delivery_payload);
end;
$$;

create or replace function public.mark_client_portal_access_delivery_attempt(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_client_contact_id uuid,
  p_action text,
  p_request_fingerprint text,
  p_lease_token uuid
)
returns timestamptz
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_actor record;
  v_existing public.client_portal_access_operations%rowtype;
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_first_attempt_at timestamptz;
begin
  if p_request_id is null or p_client_contact_id is null or p_lease_token is null
    or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'The Client access delivery attempt is invalid.';
  end if;
  select * into v_actor from private.client_pipeline_actor(p_actor_user_id);
  if v_actor.role = 'talent_management'::public.platform_role then
    raise exception using errcode = '42501', message = 'Client portal access management is required.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('client-portal-access-contact:' || p_client_contact_id::text, 0)
  );
  select operation.* into v_existing
  from public.client_portal_access_operations as operation
  where operation.operation_request_id = p_request_id
  for update;
  if not found
    or v_existing.organization_id is distinct from v_actor.organization_id
    or v_existing.lease_holder_user_id is distinct from v_actor.user_id
    or v_existing.client_contact_id is distinct from p_client_contact_id
    or v_existing.action is distinct from v_action
    or v_existing.request_fingerprint is distinct from p_request_fingerprint
    or v_existing.status <> 'pending'
    or v_existing.lease_token is distinct from p_lease_token
    or v_existing.delivery_payload is null
    or v_existing.delivery_payload_created_at is null
    or not exists (
      select 1
      from public.client_contacts as scoped_contact
      join public.clients as scoped_client
        on scoped_client.id = scoped_contact.client_id
       and scoped_client.organization_id = scoped_contact.organization_id
      where scoped_contact.id = v_existing.client_contact_id
        and scoped_contact.organization_id = v_actor.organization_id
        and (
          v_actor.role <> 'sales'::public.platform_role
          or scoped_client.sales_owner_id = v_actor.user_id
        )
    ) then
    raise exception using errcode = '42501', message = 'This Client access delivery lease is no longer current.';
  end if;
  if v_existing.delivery_first_attempt_at is null then
    update public.client_portal_access_operations
    set delivery_first_attempt_at = pg_catalog.clock_timestamp()
    where operation_request_id = p_request_id
    returning delivery_first_attempt_at into v_first_attempt_at;
  else
    v_first_attempt_at := v_existing.delivery_first_attempt_at;
  end if;
  return v_first_attempt_at;
end;
$$;

create or replace function public.finalize_client_portal_access_operation(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_client_contact_id uuid,
  p_action text,
  p_request_fingerprint text,
  p_lease_token uuid,
  p_outcome text,
  p_result jsonb,
  p_failure_code text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_actor record;
  v_existing public.client_portal_access_operations%rowtype;
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_outcome text := lower(btrim(coalesce(p_outcome, '')));
begin
  if p_request_id is null or p_client_contact_id is null or p_lease_token is null
    or p_request_fingerprint !~ '^[0-9a-f]{64}$'
    or v_outcome not in ('completed', 'failed')
    or (v_outcome = 'completed' and (p_result is null or jsonb_typeof(p_result) <> 'object'))
    or (p_failure_code is not null and char_length(p_failure_code) > 100) then
    raise exception using errcode = '22023', message = 'The Client access operation result is invalid.';
  end if;

  select * into v_actor from private.client_pipeline_actor(p_actor_user_id);
  if v_actor.role = 'talent_management'::public.platform_role then
    raise exception using errcode = '42501', message = 'Client portal access management is required.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('client-portal-access-contact:' || p_client_contact_id::text, 0)
  );
  select operation.* into v_existing
  from public.client_portal_access_operations as operation
  where operation.operation_request_id = p_request_id
  for update;
  if not found
    or v_existing.organization_id is distinct from v_actor.organization_id
    or v_existing.lease_holder_user_id is distinct from v_actor.user_id
    or v_existing.client_contact_id is distinct from p_client_contact_id
    or v_existing.action is distinct from v_action
    or v_existing.request_fingerprint is distinct from p_request_fingerprint
    or not exists (
      select 1
      from public.client_contacts as scoped_contact
      join public.clients as scoped_client
        on scoped_client.id = scoped_contact.client_id
       and scoped_client.organization_id = scoped_contact.organization_id
      where scoped_contact.id = v_existing.client_contact_id
        and scoped_contact.organization_id = v_actor.organization_id
        and (
          v_actor.role <> 'sales'::public.platform_role
          or scoped_client.sales_owner_id = v_actor.user_id
        )
    ) then
    raise exception using errcode = '42501', message = 'This Client access operation is not available to your account.';
  end if;
  if v_existing.status = 'completed' and v_existing.result is not null then
    return v_existing.result;
  end if;
  if v_existing.status <> 'pending' or v_existing.lease_token is distinct from p_lease_token then
    raise exception using errcode = 'P0001', message = 'This Client access operation lease is no longer current.';
  end if;

  update public.audit_events
  set after_value = coalesce(after_value, '{}'::jsonb) || jsonb_build_object('outcome', v_outcome)
        || case when v_outcome = 'completed' and p_result @> '{"emailDelivered": true}'::jsonb
          then jsonb_build_object('delivery_recorded', true)
          else '{}'::jsonb end,
      note = case when v_outcome = 'completed'
        then 'Soro recorded that ' || replace(v_action, '_', ' ') || ' completed.'
        else 'Soro recorded that ' || replace(v_action, '_', ' ') || ' did not complete and requires review.' end
  where id = v_existing.audit_event_id
    and organization_id = v_existing.organization_id
    and actor_user_id = v_existing.actor_user_id
    and entity_type = 'client_portal_access'
    and entity_id = v_existing.client_contact_id
    and event_type = 'client_portal_access_' || v_action;
  if not found then
    raise exception using errcode = 'P0001', message = 'The Client access audit event could not be finalized.';
  end if;

  update public.client_portal_access_operations
  set status = v_outcome,
      result = case when v_outcome = 'completed' then p_result end,
      failure_code = case when v_outcome = 'failed'
        then coalesce(nullif(btrim(p_failure_code), ''), 'access_action_failed') end,
      delivery_payload = null,
      delivery_payload_created_at = null,
      delivery_first_attempt_at = null,
      lease_expires_at = pg_catalog.clock_timestamp()
  where operation_request_id = p_request_id;
  return case when v_outcome = 'completed' then p_result else '{}'::jsonb end;
end;
$$;

revoke all on function public.reserve_client_portal_access_operation(uuid, uuid, uuid, text, text, text, public.platform_role)
  from public, anon, authenticated;
grant execute on function public.reserve_client_portal_access_operation(uuid, uuid, uuid, text, text, text, public.platform_role)
  to service_role;
revoke all on function public.checkpoint_client_portal_access_delivery(uuid, uuid, uuid, text, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.checkpoint_client_portal_access_delivery(uuid, uuid, uuid, text, text, uuid, jsonb)
  to service_role;
revoke all on function public.mark_client_portal_access_delivery_attempt(uuid, uuid, uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.mark_client_portal_access_delivery_attempt(uuid, uuid, uuid, text, text, uuid)
  to service_role;
revoke all on function public.finalize_client_portal_access_operation(uuid, uuid, uuid, text, text, uuid, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.finalize_client_portal_access_operation(uuid, uuid, uuid, text, text, uuid, text, jsonb, text)
  to service_role;

comment on table public.client_pipeline_operations is
  'Service-only idempotency ledger for audited Client, contact, and hiring-request mutations.';
comment on table public.client_portal_access_operations is
  'Service-only idempotency and recovery ledger for external Client portal account lifecycle actions; preserves the original audit actor and the current lease holder.';
comment on table public.client_portal_access_request_aliases is
  'Service-only durable mapping from every submitted Client access request id to its effective same-intent operation.';
comment on function public.get_client_pipeline_workspace(uuid) is
  'Service-only Client pipeline projection: Sales own scope, Admin/Sales Management organization scope, and Talent Management read-only.';
comment on function public.change_client_pipeline(uuid, uuid, text, timestamptz, uuid, uuid, jsonb) is
  'Service-only atomic and optimistic-locked Client intake and lifecycle mutation RPC.';
comment on function public.find_client_auth_user_for_request(uuid, text) is
  'Service-only reconciliation lookup for an ambiguously completed Client Auth provisioning request.';
comment on function public.reserve_client_portal_access_operation(uuid, uuid, uuid, text, text, text, public.platform_role) is
  'Service-only per-contact lease, durable normalized intent, request alias, and privileged stale-operation takeover for external Client access actions.';
comment on function public.checkpoint_client_portal_access_delivery(uuid, uuid, uuid, text, text, uuid, jsonb) is
  'Service-only exact email payload checkpoint so provider retries reuse the same one-use link and idempotency key.';
comment on function public.mark_client_portal_access_delivery_attempt(uuid, uuid, uuid, text, text, uuid) is
  'Service-only first provider-attempt timestamp used to fence idempotency-key refreshes.';
comment on function public.finalize_client_portal_access_operation(uuid, uuid, uuid, text, text, uuid, text, jsonb, text) is
  'Service-only lease-token compare-and-set finalization for external Client access actions.';
