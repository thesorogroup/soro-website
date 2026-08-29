-- Soro Operations: Talent/VA portal access lifecycle and least-privilege guards.
-- Access is provisioned only by the server after it verifies an active Admin or
-- Talent Management account. Browser users cannot attach Auth users or change
-- portal-access state directly.

alter table public.applicants
  add column if not exists portal_login_email text,
  add column if not exists portal_access_status text not null default 'not_invited',
  add column if not exists portal_invite_sent_at timestamptz,
  add column if not exists portal_access_activated_at timestamptz,
  add column if not exists portal_last_password_reset_sent_at timestamptz,
  add column if not exists portal_email_changed_at timestamptz,
  add column if not exists portal_access_updated_by uuid references public.platform_users(id) on delete set null;

alter table public.applicants
  drop constraint if exists applicants_portal_login_email_normalized,
  drop constraint if exists applicants_portal_access_status_valid;

alter table public.applicants
  add constraint applicants_portal_login_email_normalized
    check (
      portal_login_email is null
      or (
        portal_login_email = lower(btrim(portal_login_email))
        and char_length(portal_login_email) between 3 and 254
        and portal_login_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      )
    ),
  add constraint applicants_portal_access_status_valid
    check (portal_access_status in ('not_invited', 'invite_pending', 'active', 'suspended', 'delivery_failed'));

create unique index if not exists applicants_portal_login_email_unique
  on public.applicants (lower(portal_login_email))
  where portal_login_email is not null;

create index if not exists applicants_portal_access_status_idx
  on public.applicants (organization_id, portal_access_status)
  where auth_user_id is not null or portal_access_status <> 'not_invited';

-- Preserve any account links created before this lifecycle was introduced.
update public.applicants as applicant
set
  portal_login_email = coalesce(applicant.portal_login_email, lower(btrim(auth_account.email))),
  portal_access_status = case
    when access.active and access.must_change_password = false then 'active'
    when access.active then 'invite_pending'
    else 'suspended'
  end,
  portal_access_activated_at = case
    when access.active and access.must_change_password = false
      then coalesce(applicant.portal_access_activated_at, access.password_changed_at, applicant.updated_at)
    else applicant.portal_access_activated_at
  end
from public.platform_users as access
join auth.users as auth_account on auth_account.id = access.id
where applicant.auth_user_id = access.id
  and applicant.portal_access_status = 'not_invited';

comment on column public.applicants.portal_login_email is
  'Private sign-in destination for the Talent portal. It is intentionally separate from the original application contact email.';
comment on column public.applicants.portal_access_status is
  'Server-managed Talent portal state; never a substitute for platform_users role and active/setup checks.';

-- Reassert the completed-setup role gate in this lifecycle migration. A
-- recovery link can create an authenticated session before the Talent has
-- chosen a password; that session must still receive no application role.
create or replace function private.current_soro_role()
returns public.platform_role
language sql
stable
security definer
set search_path = public
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
  limit 1;
$$;

revoke execute on function private.current_soro_role() from anon, public;
grant execute on function private.current_soro_role() to authenticated;

-- The service-only access function is the sole writer for the Auth link and
-- portal lifecycle fields. Admin and Talent Management retain their existing
-- ability to edit ordinary applicant fields in the browser.
create or replace function private.protect_applicant_portal_access_fields()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is not null then
    if tg_op = 'INSERT' then
      if new.auth_user_id is not null
        or new.portal_login_email is not null
        or new.portal_access_status <> 'not_invited'
        or new.portal_invite_sent_at is not null
        or new.portal_access_activated_at is not null
        or new.portal_last_password_reset_sent_at is not null
        or new.portal_email_changed_at is not null
        or new.portal_access_updated_by is not null then
        raise exception using errcode = '42501', message = 'Talent portal access can be changed only through the secure access service.';
      end if;
    elsif new.auth_user_id is distinct from old.auth_user_id
      or new.portal_login_email is distinct from old.portal_login_email
      or new.portal_access_status is distinct from old.portal_access_status
      or new.portal_invite_sent_at is distinct from old.portal_invite_sent_at
      or new.portal_access_activated_at is distinct from old.portal_access_activated_at
      or new.portal_last_password_reset_sent_at is distinct from old.portal_last_password_reset_sent_at
      or new.portal_email_changed_at is distinct from old.portal_email_changed_at
      or new.portal_access_updated_by is distinct from old.portal_access_updated_by then
      raise exception using errcode = '42501', message = 'Talent portal access can be changed only through the secure access service.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_applicant_portal_access_fields on public.applicants;
create trigger protect_applicant_portal_access_fields
before insert or update on public.applicants
for each row execute function private.protect_applicant_portal_access_fields();

-- An own-row identity update is valid only while the linked VA account has
-- completed setup and still has active Virtual Assistant access. Staff edits
-- remain governed by the existing Admin/Talent Management RLS policy.
create or replace function private.guard_own_identity_preference_updates()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, private
as $$
begin
  if old.auth_user_id = auth.uid()
    and (
      new.preferred_name is distinct from old.preferred_name
      or new.gender_identity is distinct from old.gender_identity
      or new.gender_identity_self_description is distinct from old.gender_identity_self_description
      or new.pronouns is distinct from old.pronouns
      or new.pronouns_self_description is distinct from old.pronouns_self_description
    )
    and private.current_soro_role() is distinct from 'virtual_assistant'::public.platform_role then
    raise exception using errcode = '42501', message = 'Active Talent portal access is required to update identity preferences.';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_own_identity_preference_updates on public.applicants;
create trigger guard_own_identity_preference_updates
before update of preferred_name, gender_identity, gender_identity_self_description, pronouns, pronouns_self_description
on public.applicants
for each row execute function private.guard_own_identity_preference_updates();

drop policy if exists "a virtual assistant can read their own profile" on public.applicants;
create policy "an active virtual assistant can read their own profile"
on public.applicants for select to authenticated
using (
  auth_user_id = auth.uid()
  and private.current_soro_role() = 'virtual_assistant'::public.platform_role
);

drop policy if exists "virtual assistants can read own documents" on public.documents;
create policy "active virtual assistants can read own documents"
on public.documents for select to authenticated
using (
  private.current_soro_role() = 'virtual_assistant'::public.platform_role
  and exists (
    select 1
    from public.applicants as applicant
    where applicant.id = documents.applicant_id
      and applicant.auth_user_id = auth.uid()
  )
);

drop policy if exists "Virtual assistants can read own private document objects" on storage.objects;
create policy "Virtual assistants can read own private document objects"
on storage.objects for select to authenticated
using (
  bucket_id = 'soro-private-documents'
  and private.current_soro_role() = 'virtual_assistant'::public.platform_role
  and exists (
    select 1
    from public.documents as document
    join public.applicants as applicant on applicant.id = document.applicant_id
    where document.storage_path = storage.objects.name
      and applicant.auth_user_id = auth.uid()
  )
);

-- Setup-required accounts must not obtain an organization id through the
-- support-ticket helper before the role gate is cleared.
create or replace function private.current_soro_organization_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select access.organization_id
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
  limit 1;
$$;

revoke execute on function private.current_soro_organization_id() from anon, public;
grant execute on function private.current_soro_organization_id() to authenticated;

drop policy if exists "users can read their own support tickets" on public.support_tickets;
create policy "active users can read their own support tickets"
on public.support_tickets for select to authenticated
using (
  requester_user_id = auth.uid()
  and private.current_soro_role() is not null
);

-- Talent portal security events can contain account-state context and should
-- not be visible to Sales or Billing users.
drop policy if exists "internal users can read audit history" on public.audit_events;
create policy "authorized internal users can read audit history"
on public.audit_events for select to authenticated
using (
  private.is_internal_soro_user()
  and (
    entity_type <> 'talent_portal_access'
    or private.current_soro_role() in (
      'admin'::public.platform_role,
      'talent_management'::public.platform_role
    )
  )
);

grant select, update on table public.applicants to service_role;
grant select, insert, update on table public.platform_users to service_role;
grant select, insert, update on table public.audit_events to service_role;
