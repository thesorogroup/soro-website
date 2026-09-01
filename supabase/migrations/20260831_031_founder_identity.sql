-- Soro Operations: reserve one Founder identity without introducing a new
-- authorization role. The Founder continues to inherit the established Admin
-- access boundary; this marker is a protected identity/title only.

alter table public.platform_users
  add column if not exists is_founder boolean not null default false;

do $$
declare
  v_match_count integer;
  v_founder_user_id uuid;
  v_founder_role public.platform_role;
  v_founder_organization_id uuid;
  v_founder_active boolean;
begin
  select count(*)
    into v_match_count
  from public.platform_users as access
  join auth.users as account on account.id = access.id
  where lower(account.email) = 'matt@thesorogroup.com';

  if v_match_count <> 1 then
    raise exception using
      errcode = 'P0001',
      message = format(
        'Founder identity migration requires exactly one existing Matt platform account; found %s.',
        v_match_count
      );
  end if;

  select access.id, access.role, access.organization_id, access.active
    into strict v_founder_user_id, v_founder_role, v_founder_organization_id, v_founder_active
  from public.platform_users as access
  join auth.users as account on account.id = access.id
  where lower(account.email) = 'matt@thesorogroup.com';

  if v_founder_role <> 'admin'::public.platform_role
    or v_founder_organization_id is null
    or v_founder_active is not true then
    raise exception using
      errcode = 'P0001',
      message = 'The reserved Founder account must already be an active, organization-linked Administrator.';
  end if;

  if exists (
    select 1
    from public.platform_users as access
    where access.is_founder = true
      and access.id <> v_founder_user_id
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'A different Founder identity is already reserved.';
  end if;

  update public.platform_users
  set is_founder = true,
      updated_at = now()
  where id = v_founder_user_id
    and is_founder = false;

  if not found and not exists (
    select 1
    from public.platform_users as access
    where access.id = v_founder_user_id
      and access.is_founder = true
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'The existing Founder platform account could not be updated.';
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'platform_users_founder_requires_admin'
      and conrelid = 'public.platform_users'::regclass
  ) then
    alter table public.platform_users
      add constraint platform_users_founder_requires_admin
      check (
        is_founder = false
        or (
          role = 'admin'::public.platform_role
          and organization_id is not null
        )
      );
  end if;
end;
$$;

-- A partial unique index on the true marker makes Founder a global singleton,
-- matching the reserved System Owner identity already described by the UI.
create unique index if not exists platform_users_single_founder_uidx
  on public.platform_users (is_founder)
  where is_founder = true;

-- The Founder marker is set by this reviewed migration and is not an ordinary
-- employee-access field. RLS alone is insufficient because Administrators can
-- otherwise update or delete platform access rows directly. Keep the marker
-- immutable and keep the reserved Founder row from being deleted. A future,
-- deliberate identity transfer must first replace this database guard in a
-- reviewed migration.
create or replace function private.protect_founder_identity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
begin
  if tg_op = 'UPDATE' then
    if new.is_founder is distinct from old.is_founder
      or (
        old.is_founder = true
        and (
          new.id is distinct from old.id
          or new.role is distinct from old.role
          or new.organization_id is distinct from old.organization_id
          or new.active is distinct from old.active
          or new.must_change_password is distinct from old.must_change_password
        )
      ) then
      raise exception using
        errcode = '42501',
        message = 'The reserved Founder identity cannot be changed through employee access management.';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' and old.is_founder = true then
    raise exception using
      errcode = '42501',
      message = 'The reserved Founder identity cannot be deleted through employee access management.';
  end if;

  return old;
end;
$$;

revoke all on function private.protect_founder_identity() from public, anon, authenticated;

drop trigger if exists protect_founder_identity_update on public.platform_users;
create trigger protect_founder_identity_update
before update of id, is_founder, role, organization_id, active, must_change_password on public.platform_users
for each row execute function private.protect_founder_identity();

drop trigger if exists protect_founder_identity_delete on public.platform_users;
create trigger protect_founder_identity_delete
before delete on public.platform_users
for each row execute function private.protect_founder_identity();

create or replace function public.admin_employee_directory()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_organization_id uuid;
  v_directory jsonb;
begin
  if not private.is_soro_admin() then
    raise exception using
      errcode = '42501',
      message = 'Only an active Soro Administrator can view the employee directory.';
  end if;

  select access.organization_id
    into strict v_organization_id
  from public.platform_users as access
  where access.id = auth.uid()
    and access.active = true
    and access.must_change_password = false
    and access.role = 'admin'::public.platform_role;

  with directory_rows as (
    select
      profile.user_id,
      profile.full_name,
      profile.email,
      profile.phone,
      profile.hire_date,
      profile.address_line_1,
      profile.address_line_2,
      profile.city,
      profile.state_region,
      profile.postal_code,
      profile.country,
      profile.payment_route::text as payment_route,
      profile.payout_recipient_email,
      profile.created_at,
      true as profile_complete,
      jsonb_build_object(
        'role', access.role::text,
        'is_founder', access.is_founder,
        'active', access.active,
        'must_change_password', access.must_change_password,
        'initial_password_issued_at', access.initial_password_issued_at,
        'password_changed_at', access.password_changed_at
      ) as platform_users
    from public.employee_profiles as profile
    join public.platform_users as access
      on access.id = profile.user_id
     and access.organization_id = profile.organization_id
    where profile.organization_id = v_organization_id

    union all

    select
      access.id as user_id,
      coalesce(nullif(btrim(access.display_name), ''), split_part(account.email, '@', 1)) as full_name,
      lower(account.email) as email,
      null::text as phone,
      null::date as hire_date,
      null::text as address_line_1,
      null::text as address_line_2,
      null::text as city,
      null::text as state_region,
      null::text as postal_code,
      null::text as country,
      'needs_setup'::text as payment_route,
      null::text as payout_recipient_email,
      access.created_at,
      false as profile_complete,
      jsonb_build_object(
        'role', access.role::text,
        'is_founder', access.is_founder,
        'active', access.active,
        'must_change_password', access.must_change_password,
        'initial_password_issued_at', access.initial_password_issued_at,
        'password_changed_at', access.password_changed_at
      ) as platform_users
    from public.platform_users as access
    join auth.users as account on account.id = access.id
    where access.organization_id = v_organization_id
      and access.is_founder = true
      and not exists (
        select 1
        from public.employee_profiles as profile
        where profile.user_id = access.id
      )
  )
  select coalesce(
    jsonb_agg(to_jsonb(directory_rows) order by lower(directory_rows.full_name), directory_rows.user_id),
    '[]'::jsonb
  )
    into v_directory
  from directory_rows;

  return v_directory;
end;
$$;

revoke all on function public.admin_employee_directory() from public, anon;
grant execute on function public.admin_employee_directory() to authenticated;

comment on column public.platform_users.is_founder is
  'Protected singleton identity marker for the existing Soro Founder. Authorization remains role=admin.';

comment on function private.protect_founder_identity() is
  'Prevents direct reassignment or deletion of the reserved Founder marker. A reviewed migration is required to transfer the identity.';

comment on function public.admin_employee_directory() is
  'Admin-only employee directory, including the reserved Founder identity when its private employee profile is incomplete.';
