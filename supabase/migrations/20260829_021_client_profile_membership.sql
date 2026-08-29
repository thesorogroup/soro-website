-- Soro Operations: scoped Client portal membership and safe self-service profile updates.
-- Client roles remain unable to read or update the base clients/client_contacts
-- tables directly. The service-only RPC below is called by the authenticated
-- client-profile Netlify function after it verifies the same access boundary.

alter table public.clients
  add column if not exists address_line_1 text,
  add column if not exists address_line_2 text,
  add column if not exists city text,
  add column if not exists state_region text,
  add column if not exists postal_code text,
  add column if not exists country text,
  add column if not exists company_phone text,
  add column if not exists website text;

alter table public.client_contacts
  add column if not exists active boolean not null default true,
  add column if not exists updated_at timestamptz not null default now();

drop trigger if exists client_contacts_updated_at on public.client_contacts;
create trigger client_contacts_updated_at
before update on public.client_contacts
for each row execute function public.set_updated_at();

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'clients_profile_address_line_1_length'
      and conrelid = 'public.clients'::regclass
  ) then
    alter table public.clients add constraint clients_profile_address_line_1_length
      check (address_line_1 is null or char_length(btrim(address_line_1)) between 2 and 160);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'clients_profile_address_line_2_length'
      and conrelid = 'public.clients'::regclass
  ) then
    alter table public.clients add constraint clients_profile_address_line_2_length
      check (address_line_2 is null or char_length(btrim(address_line_2)) between 1 and 160);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'clients_profile_city_length'
      and conrelid = 'public.clients'::regclass
  ) then
    alter table public.clients add constraint clients_profile_city_length
      check (city is null or char_length(btrim(city)) between 1 and 100);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'clients_profile_state_region_length'
      and conrelid = 'public.clients'::regclass
  ) then
    alter table public.clients add constraint clients_profile_state_region_length
      check (state_region is null or char_length(btrim(state_region)) between 1 and 100);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'clients_profile_postal_code_length'
      and conrelid = 'public.clients'::regclass
  ) then
    alter table public.clients add constraint clients_profile_postal_code_length
      check (postal_code is null or char_length(btrim(postal_code)) between 1 and 24);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'clients_profile_country_length'
      and conrelid = 'public.clients'::regclass
  ) then
    alter table public.clients add constraint clients_profile_country_length
      check (country is null or char_length(btrim(country)) between 2 and 100);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'clients_profile_company_phone_length'
      and conrelid = 'public.clients'::regclass
  ) then
    alter table public.clients add constraint clients_profile_company_phone_length
      check (company_phone is null or char_length(btrim(company_phone)) between 7 and 40);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'clients_profile_website_length'
      and conrelid = 'public.clients'::regclass
  ) then
    alter table public.clients add constraint clients_profile_website_length
      check (website is null or char_length(btrim(website)) between 8 and 2048);
  end if;
end
$$;

-- Composite uniqueness allows the membership foreign keys to prove that the
-- user, Client, contact, and organization all belong to the same boundary.
create unique index if not exists platform_users_id_organization_unique
  on public.platform_users (id, organization_id);
create unique index if not exists clients_id_organization_unique
  on public.clients (id, organization_id);
create unique index if not exists client_contacts_id_client_unique
  on public.client_contacts (id, client_id);

create table if not exists public.client_portal_memberships (
  user_id uuid primary key,
  organization_id uuid not null,
  client_id uuid not null,
  client_contact_id uuid not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_portal_memberships_user_organization_fkey
    foreign key (user_id, organization_id)
    references public.platform_users (id, organization_id) on delete cascade,
  constraint client_portal_memberships_client_organization_fkey
    foreign key (client_id, organization_id)
    references public.clients (id, organization_id) on delete restrict,
  constraint client_portal_memberships_contact_client_fkey
    foreign key (client_contact_id, client_id)
    references public.client_contacts (id, client_id) on delete restrict
);

create index if not exists client_portal_memberships_client_idx
  on public.client_portal_memberships (client_id, active);

drop trigger if exists client_portal_memberships_updated_at on public.client_portal_memberships;
create trigger client_portal_memberships_updated_at
before update on public.client_portal_memberships
for each row execute function public.set_updated_at();

create or replace function private.validate_client_portal_membership()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  access_role public.platform_role;
  client_archived_at timestamptz;
  contact_is_active boolean;
begin
  select role into access_role
  from public.platform_users
  where id = new.user_id
    and organization_id = new.organization_id;

  if (tg_op = 'INSERT' or new.active = true)
    and (access_role is null or access_role not in (
      'client_admin'::public.platform_role,
      'client_reviewer'::public.platform_role,
      'client_billing'::public.platform_role
    )) then
    raise exception using errcode = '23514', message = 'Client portal memberships require a Client portal role.';
  end if;

  select archived_at into client_archived_at
  from public.clients
  where id = new.client_id
    and organization_id = new.organization_id;
  if not found then
    raise exception using errcode = '23503', message = 'The Client does not belong to this organization.';
  end if;

  select active into contact_is_active
  from public.client_contacts
  where id = new.client_contact_id
    and client_id = new.client_id;
  if not found then
    raise exception using errcode = '23503', message = 'The Client contact does not belong to this Client.';
  end if;

  if new.active and (client_archived_at is not null or contact_is_active is not true) then
    raise exception using errcode = '23514', message = 'An active membership requires an active Client and contact.';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_client_portal_membership on public.client_portal_memberships;
create trigger validate_client_portal_membership
before insert or update on public.client_portal_memberships
for each row execute function private.validate_client_portal_membership();

-- Deliberately do not infer membership from contact/auth email. Existing
-- accounts stay fail-closed until an Administrator explicitly reconciles the
-- user, organization, Client, and contact relationship.

create or replace function private.deactivate_client_membership_on_access_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if old.role in (
      'client_admin'::public.platform_role,
      'client_reviewer'::public.platform_role,
      'client_billing'::public.platform_role
    )
    and (
      new.active = false
      or new.role not in (
        'client_admin'::public.platform_role,
        'client_reviewer'::public.platform_role,
        'client_billing'::public.platform_role
      )
    ) then
    update public.client_portal_memberships
    set active = false
    where user_id = new.id
      and active = true;
  end if;
  return new;
end;
$$;

drop trigger if exists deactivate_client_membership_on_access_change on public.platform_users;
create trigger deactivate_client_membership_on_access_change
after update of role, active on public.platform_users
for each row execute function private.deactivate_client_membership_on_access_change();

-- A Client role is not effective until it has a complete, active membership.
-- Preserve the equivalent Talent/VA gate introduced by migration 020.
create or replace function private.current_soro_role()
returns public.platform_role
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select access.role
  from public.platform_users as access
  where access.id = auth.uid()
    and access.active = true
    and access.must_change_password = false
    and (
      access.role <> 'virtual_assistant'::public.platform_role
      or exists (
        select 1
        from public.applicants as applicant
        where applicant.auth_user_id = access.id
          and applicant.organization_id = access.organization_id
          and applicant.archived_at is null
          and applicant.portal_access_status = 'active'
      )
    )
    and (
      access.role not in (
        'client_admin'::public.platform_role,
        'client_reviewer'::public.platform_role,
        'client_billing'::public.platform_role
      )
      or exists (
        select 1
        from public.client_portal_memberships as membership
        join public.clients as client
          on client.id = membership.client_id
         and client.organization_id = membership.organization_id
        join public.client_contacts as contact
          on contact.id = membership.client_contact_id
         and contact.client_id = membership.client_id
        where membership.user_id = access.id
          and membership.organization_id = access.organization_id
          and membership.active = true
          and client.archived_at is null
          and contact.active = true
      )
    )
  limit 1;
$$;

create or replace function private.current_soro_organization_id()
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  select access.organization_id
  from public.platform_users as access
  where access.id = auth.uid()
    and private.current_soro_role() is not null
  limit 1;
$$;

revoke execute on function private.current_soro_role() from anon, public;
revoke execute on function private.current_soro_organization_id() from anon, public;
grant execute on function private.current_soro_role() to authenticated;
grant execute on function private.current_soro_organization_id() to authenticated;

alter table public.client_portal_memberships enable row level security;
revoke all on table public.client_portal_memberships from authenticated;
grant select on table public.client_portal_memberships to service_role;
grant select on table public.clients to service_role;
grant select on table public.client_contacts to service_role;

drop policy if exists "Client portal users can read their own active membership"
on public.client_portal_memberships;
create policy "Client portal users can read their own active membership"
on public.client_portal_memberships for select to authenticated
using (
  user_id = auth.uid()
  and active = true
  and private.current_soro_role() in (
    'client_admin'::public.platform_role,
    'client_reviewer'::public.platform_role,
    'client_billing'::public.platform_role
  )
);

create or replace function private.current_client_id()
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  select membership.client_id
  from public.client_portal_memberships as membership
  join public.platform_users as access
    on access.id = membership.user_id
   and access.organization_id = membership.organization_id
  join public.clients as client
    on client.id = membership.client_id
   and client.organization_id = membership.organization_id
  join public.client_contacts as contact
    on contact.id = membership.client_contact_id
   and contact.client_id = membership.client_id
  where membership.user_id = auth.uid()
    and membership.active = true
    and access.active = true
    and access.must_change_password = false
    and access.role in (
      'client_admin'::public.platform_role,
      'client_reviewer'::public.platform_role,
      'client_billing'::public.platform_role
    )
    and client.archived_at is null
    and contact.active = true
  limit 1;
$$;

create or replace function private.current_client_contact_id()
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  select membership.client_contact_id
  from public.client_portal_memberships as membership
  where membership.user_id = auth.uid()
    and membership.active = true
    and membership.client_id = private.current_client_id()
  limit 1;
$$;

revoke execute on function private.current_client_id() from anon, public;
revoke execute on function private.current_client_contact_id() from anon, public;
revoke execute on function private.current_client_id() from authenticated;
revoke execute on function private.current_client_contact_id() from authenticated;

-- This RPC is intentionally service-role only. It performs the contact and
-- company updates plus the value-free audit event in one database transaction.
create or replace function public.update_client_portal_profile(
  p_actor_user_id uuid,
  p_contact_updates jsonb default '{}'::jsonb,
  p_company_updates jsonb default '{}'::jsonb
)
returns text[]
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  access_organization_id uuid;
  access_role public.platform_role;
  membership public.client_portal_memberships%rowtype;
  client_record public.clients%rowtype;
  contact_record public.client_contacts%rowtype;
  changed_fields text[] := array[]::text[];
  contact_changed boolean := false;
  company_changed boolean := false;
  next_value text;
begin
  p_contact_updates := coalesce(p_contact_updates, '{}'::jsonb);
  p_company_updates := coalesce(p_company_updates, '{}'::jsonb);
  if jsonb_typeof(p_contact_updates) <> 'object' or jsonb_typeof(p_company_updates) <> 'object' then
    raise exception using errcode = '22023', message = 'Profile updates must be JSON objects.';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_contact_updates) as key
    where key not in ('full_name', 'phone')
  ) or exists (
    select 1 from jsonb_object_keys(p_company_updates) as key
    where key not in ('address_line_1', 'address_line_2', 'city', 'state_region', 'postal_code', 'country', 'company_phone', 'website')
  ) then
    raise exception using errcode = '22023', message = 'The profile update contains a protected field.';
  end if;

  select organization_id, role
  into access_organization_id, access_role
  from public.platform_users
  where id = p_actor_user_id
    and active = true
    and must_change_password = false
    and role in (
      'client_admin'::public.platform_role,
      'client_reviewer'::public.platform_role,
      'client_billing'::public.platform_role
    );
  if not found then
    raise exception using errcode = '42501', message = 'Active Client portal access is required.';
  end if;

  select * into membership
  from public.client_portal_memberships
  where user_id = p_actor_user_id
    and organization_id = access_organization_id
    and active = true
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'An active Client membership was not found.';
  end if;

  select * into client_record
  from public.clients
  where id = membership.client_id
    and organization_id = membership.organization_id
    and archived_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'The active Client profile was not found.';
  end if;

  select * into contact_record
  from public.client_contacts
  where id = membership.client_contact_id
    and client_id = membership.client_id
    and active = true
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'The active Client contact was not found.';
  end if;

  if p_company_updates <> '{}'::jsonb and access_role <> 'client_admin'::public.platform_role then
    raise exception using errcode = '42501', message = 'Only a Client Administrator can update company contact fields.';
  end if;

  if p_contact_updates ? 'full_name' then
    if jsonb_typeof(p_contact_updates -> 'full_name') <> 'string' then
      raise exception using errcode = '22023', message = 'Full name must be text.';
    end if;
    next_value := btrim(p_contact_updates ->> 'full_name');
    if char_length(next_value) not between 2 and 120 then
      raise exception using errcode = '22023', message = 'Full name must be between 2 and 120 characters.';
    end if;
    if next_value is distinct from contact_record.full_name then
      contact_record.full_name := next_value;
      changed_fields := array_append(changed_fields, 'contact.fullName');
      contact_changed := true;
    end if;
  end if;

  if p_contact_updates ? 'phone' then
    if jsonb_typeof(p_contact_updates -> 'phone') not in ('string', 'null') then
      raise exception using errcode = '22023', message = 'Phone must be text or null.';
    end if;
    next_value := nullif(btrim(coalesce(p_contact_updates ->> 'phone', '')), '');
    if next_value is not null and char_length(next_value) not between 7 and 40 then
      raise exception using errcode = '22023', message = 'Phone must be between 7 and 40 characters.';
    end if;
    if next_value is distinct from contact_record.phone then
      contact_record.phone := next_value;
      changed_fields := array_append(changed_fields, 'contact.phone');
      contact_changed := true;
    end if;
  end if;

  if p_company_updates ? 'address_line_1' then
    next_value := nullif(btrim(coalesce(p_company_updates ->> 'address_line_1', '')), '');
    if jsonb_typeof(p_company_updates -> 'address_line_1') not in ('string', 'null') or (next_value is not null and char_length(next_value) not between 2 and 160) then
      raise exception using errcode = '22023', message = 'Address line 1 must be valid text.';
    end if;
    if next_value is distinct from client_record.address_line_1 then client_record.address_line_1 := next_value; changed_fields := array_append(changed_fields, 'company.addressLine1'); company_changed := true; end if;
  end if;
  if p_company_updates ? 'address_line_2' then
    next_value := nullif(btrim(coalesce(p_company_updates ->> 'address_line_2', '')), '');
    if jsonb_typeof(p_company_updates -> 'address_line_2') not in ('string', 'null') or (next_value is not null and char_length(next_value) > 160) then
      raise exception using errcode = '22023', message = 'Address line 2 must be valid text.';
    end if;
    if next_value is distinct from client_record.address_line_2 then client_record.address_line_2 := next_value; changed_fields := array_append(changed_fields, 'company.addressLine2'); company_changed := true; end if;
  end if;
  if p_company_updates ? 'city' then
    next_value := nullif(btrim(coalesce(p_company_updates ->> 'city', '')), '');
    if jsonb_typeof(p_company_updates -> 'city') not in ('string', 'null') or (next_value is not null and char_length(next_value) > 100) then
      raise exception using errcode = '22023', message = 'City must be valid text.';
    end if;
    if next_value is distinct from client_record.city then client_record.city := next_value; changed_fields := array_append(changed_fields, 'company.city'); company_changed := true; end if;
  end if;
  if p_company_updates ? 'state_region' then
    next_value := nullif(btrim(coalesce(p_company_updates ->> 'state_region', '')), '');
    if jsonb_typeof(p_company_updates -> 'state_region') not in ('string', 'null') or (next_value is not null and char_length(next_value) > 100) then
      raise exception using errcode = '22023', message = 'State or region must be valid text.';
    end if;
    if next_value is distinct from client_record.state_region then client_record.state_region := next_value; changed_fields := array_append(changed_fields, 'company.stateRegion'); company_changed := true; end if;
  end if;
  if p_company_updates ? 'postal_code' then
    next_value := nullif(btrim(coalesce(p_company_updates ->> 'postal_code', '')), '');
    if jsonb_typeof(p_company_updates -> 'postal_code') not in ('string', 'null') or (next_value is not null and char_length(next_value) > 24) then
      raise exception using errcode = '22023', message = 'Postal code must be valid text.';
    end if;
    if next_value is distinct from client_record.postal_code then client_record.postal_code := next_value; changed_fields := array_append(changed_fields, 'company.postalCode'); company_changed := true; end if;
  end if;
  if p_company_updates ? 'country' then
    next_value := nullif(btrim(coalesce(p_company_updates ->> 'country', '')), '');
    if jsonb_typeof(p_company_updates -> 'country') not in ('string', 'null') or (next_value is not null and char_length(next_value) not between 2 and 100) then
      raise exception using errcode = '22023', message = 'Country must be valid text.';
    end if;
    if next_value is distinct from client_record.country then client_record.country := next_value; changed_fields := array_append(changed_fields, 'company.country'); company_changed := true; end if;
  end if;
  if p_company_updates ? 'company_phone' then
    next_value := nullif(btrim(coalesce(p_company_updates ->> 'company_phone', '')), '');
    if jsonb_typeof(p_company_updates -> 'company_phone') not in ('string', 'null') or (next_value is not null and char_length(next_value) not between 7 and 40) then
      raise exception using errcode = '22023', message = 'Company phone must be valid text.';
    end if;
    if next_value is distinct from client_record.company_phone then client_record.company_phone := next_value; changed_fields := array_append(changed_fields, 'company.phone'); company_changed := true; end if;
  end if;
  if p_company_updates ? 'website' then
    next_value := nullif(btrim(coalesce(p_company_updates ->> 'website', '')), '');
    if jsonb_typeof(p_company_updates -> 'website') not in ('string', 'null') or (next_value is not null and char_length(next_value) not between 8 and 2048) then
      raise exception using errcode = '22023', message = 'Website must be valid text.';
    end if;
    if next_value is distinct from client_record.website then client_record.website := next_value; changed_fields := array_append(changed_fields, 'company.website'); company_changed := true; end if;
  end if;

  if contact_changed then
    update public.client_contacts
    set full_name = contact_record.full_name,
        phone = contact_record.phone
    where id = contact_record.id;
  end if;

  if company_changed then
    update public.clients
    set address_line_1 = client_record.address_line_1,
        address_line_2 = client_record.address_line_2,
        city = client_record.city,
        state_region = client_record.state_region,
        postal_code = client_record.postal_code,
        country = client_record.country,
        company_phone = client_record.company_phone,
        website = client_record.website
    where id = client_record.id;
  end if;

  if coalesce(array_length(changed_fields, 1), 0) > 0 then
    insert into public.audit_events (
      organization_id,
      actor_user_id,
      entity_type,
      entity_id,
      event_type,
      after_value
    ) values (
      membership.organization_id,
      p_actor_user_id,
      'client_profile',
      membership.client_id,
      'client_profile_updated',
      jsonb_build_object('changed_fields', to_jsonb(changed_fields))
    );
  end if;

  return changed_fields;
end;
$$;

revoke all on function public.update_client_portal_profile(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.update_client_portal_profile(uuid, jsonb, jsonb) to service_role;

comment on table public.client_portal_memberships is
  'One active Client/contact boundary per Client portal user for the first release.';
comment on function public.update_client_portal_profile(uuid, jsonb, jsonb) is
  'Service-only, atomic Client self-profile mutation with a value-free audit event.';
