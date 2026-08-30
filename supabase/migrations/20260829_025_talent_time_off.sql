-- Full-day Talent Request Time Off workflow.
--
-- This records scheduling availability only. Approval has no automatic effect
-- on attendance, payroll, benefits, client billing, or any other subsystem.
-- Browser users cannot read or write these tables directly; all access runs
-- through service-role-only functions that derive organization, Talent,
-- placement, date, and time-zone scope from the authenticated account.

create extension if not exists btree_gist with schema extensions;

create table if not exists public.talent_time_off_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  applicant_id uuid not null references public.applicants(id) on delete restrict,
  placement_id uuid not null references public.placements(id) on delete restrict,
  start_date date not null,
  end_date date not null,
  work_timezone text not null,
  status text not null default 'pending',
  talent_note text,
  submitted_by_user_id uuid not null references public.platform_users(id) on delete restrict,
  submitted_at timestamptz not null default now(),
  decided_by_user_id uuid references public.platform_users(id) on delete set null,
  decided_at timestamptz,
  decision_note text,
  cancelled_by_user_id uuid references public.platform_users(id) on delete set null,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint talent_time_off_date_order check (end_date >= start_date),
  constraint talent_time_off_status_valid
    check (status in ('pending', 'approved', 'declined', 'cancelled')),
  constraint talent_time_off_note_valid check (
    talent_note is null
    or (
      talent_note = btrim(talent_note)
      and char_length(talent_note) between 1 and 500
    )
  ),
  constraint talent_time_off_decision_note_valid check (
    decision_note is null
    or (
      decision_note = btrim(decision_note)
      and char_length(decision_note) between 1 and 500
    )
  ),
  constraint talent_time_off_decision_complete check (
    (
      decided_by_user_id is null
      and decided_at is null
      and decision_note is null
      and status in ('pending', 'cancelled')
    )
    or (
      decided_by_user_id is not null
      and decided_at is not null
      and status in ('approved', 'declined', 'cancelled')
    )
  ),
  constraint talent_time_off_decline_note_required
    check (status <> 'declined' or nullif(btrim(decision_note), '') is not null),
  constraint talent_time_off_cancellation_complete check (
    (
      cancelled_by_user_id is null
      and cancelled_at is null
      and status <> 'cancelled'
    )
    or (
      cancelled_by_user_id is not null
      and cancelled_at is not null
      and status = 'cancelled'
    )
  )
);

alter table public.talent_time_off_requests
  drop constraint if exists talent_time_off_no_active_overlap;

alter table public.talent_time_off_requests
  add constraint talent_time_off_no_active_overlap
  exclude using gist (
    applicant_id with =,
    daterange(start_date, end_date, '[]') with &&
  )
  where (status in ('pending', 'approved'));

create index if not exists talent_time_off_org_status_start_idx
  on public.talent_time_off_requests (organization_id, status, start_date, submitted_at desc);

create index if not exists talent_time_off_applicant_submitted_idx
  on public.talent_time_off_requests (applicant_id, submitted_at desc);

create table if not exists public.talent_time_off_operations (
  operation_request_id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  actor_user_id uuid not null references public.platform_users(id) on delete restrict,
  action text not null check (action in ('submit', 'cancel', 'approve', 'decline')),
  time_off_request_id uuid not null references public.talent_time_off_requests(id) on delete restrict,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

create index if not exists talent_time_off_operations_request_idx
  on public.talent_time_off_operations (time_off_request_id, created_at);

drop trigger if exists talent_time_off_requests_updated_at on public.talent_time_off_requests;
create trigger talent_time_off_requests_updated_at
before update on public.talent_time_off_requests
for each row execute function public.set_updated_at();

alter table public.talent_time_off_requests enable row level security;
alter table public.talent_time_off_operations enable row level security;

revoke all on table public.talent_time_off_requests from public, anon, authenticated;
revoke all on table public.talent_time_off_operations from public, anon, authenticated;
revoke all on table public.talent_time_off_requests from anon, authenticated;
revoke all on table public.talent_time_off_operations from anon, authenticated;
grant select, insert, update on table public.talent_time_off_requests to service_role;
grant select, insert on table public.talent_time_off_operations to service_role;

create or replace function private.enforce_talent_time_off_scope()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
begin
  if tg_op = 'INSERT' and new.status <> 'pending' then
    raise exception using errcode = '42501', message = 'New time-off requests must begin in pending review.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_timezone_names as zone
    where zone.name = new.work_timezone
  ) then
    raise exception using errcode = '23514', message = 'Time off requires a valid work time zone.';
  end if;

  if tg_op = 'INSERT' and not exists (
    select 1
    from public.applicants as applicant
    join public.platform_users as access
      on access.id = new.submitted_by_user_id
     and access.id = applicant.auth_user_id
     and access.organization_id = applicant.organization_id
    where applicant.id = new.applicant_id
      and applicant.organization_id = new.organization_id
      and applicant.archived_at is null
      and applicant.portal_access_status = 'active'
      and access.active = true
      and access.must_change_password = false
      and access.role = 'virtual_assistant'::public.platform_role
  ) then
    raise exception using errcode = '42501', message = 'Only the linked active Talent account can submit this request.';
  end if;

  if tg_op = 'UPDATE' then
    if new.organization_id is distinct from old.organization_id
      or new.applicant_id is distinct from old.applicant_id
      or new.placement_id is distinct from old.placement_id
      or new.start_date is distinct from old.start_date
      or new.end_date is distinct from old.end_date
      or new.work_timezone is distinct from old.work_timezone
      or new.talent_note is distinct from old.talent_note
      or new.submitted_by_user_id is distinct from old.submitted_by_user_id
      or new.submitted_at is distinct from old.submitted_at
      or new.created_at is distinct from old.created_at then
      raise exception using errcode = '42501', message = 'Time-off request ownership and submitted details cannot be changed.';
    end if;

    if old.status = 'pending' and new.status not in ('approved', 'declined', 'cancelled') then
      raise exception using errcode = '42501', message = 'Unsupported time-off status transition.';
    elsif old.status = 'approved' and new.status <> 'cancelled' then
      raise exception using errcode = '42501', message = 'Unsupported time-off status transition.';
    elsif old.status in ('declined', 'cancelled') and new.status <> old.status then
      raise exception using errcode = '42501', message = 'A completed time-off decision cannot be changed.';
    end if;

    if new.status in ('approved', 'declined') and old.status = 'pending' and not exists (
      select 1
      from public.platform_users as decision_actor
      where decision_actor.id = new.decided_by_user_id
        and decision_actor.organization_id = new.organization_id
        and decision_actor.active = true
        and decision_actor.must_change_password = false
        and decision_actor.role in (
          'admin'::public.platform_role,
          'talent_management'::public.platform_role
        )
    ) then
      raise exception using errcode = '42501', message = 'Admin or Talent Management access is required for a decision.';
    end if;

    if new.status = 'cancelled' and old.status in ('pending', 'approved') and not exists (
      select 1
      from public.applicants as applicant
      join public.platform_users as cancellation_actor
        on cancellation_actor.id = new.cancelled_by_user_id
       and cancellation_actor.id = applicant.auth_user_id
       and cancellation_actor.organization_id = applicant.organization_id
      where applicant.id = new.applicant_id
        and applicant.organization_id = new.organization_id
        and applicant.archived_at is null
        and applicant.portal_access_status = 'active'
        and cancellation_actor.active = true
        and cancellation_actor.must_change_password = false
        and cancellation_actor.role = 'virtual_assistant'::public.platform_role
    ) then
      raise exception using errcode = '42501', message = 'Only the linked active Talent account can cancel this request.';
    end if;

    if old.decided_at is not null and (
      new.decided_at is distinct from old.decided_at
      or new.decided_by_user_id is distinct from old.decided_by_user_id
      or new.decision_note is distinct from old.decision_note
    ) then
      raise exception using errcode = '42501', message = 'A completed time-off decision cannot be changed.';
    end if;

    if old.cancelled_at is not null and (
      new.cancelled_at is distinct from old.cancelled_at
      or new.cancelled_by_user_id is distinct from old.cancelled_by_user_id
    ) then
      raise exception using errcode = '42501', message = 'A cancelled time-off request cannot be changed.';
    end if;
  end if;

  if not exists (
    select 1
    from public.applicants as applicant
    join public.placements as placement
      on placement.id = new.placement_id
     and placement.applicant_id = applicant.id
    join public.clients as client
      on client.id = placement.client_id
     and client.organization_id = applicant.organization_id
    where applicant.id = new.applicant_id
      and applicant.organization_id = new.organization_id
      and applicant.archived_at is null
      and (
        tg_op = 'UPDATE'
        or (
          client.archived_at is null
          and placement.start_date is not null
          and placement.start_date <= new.start_date
          and (placement.end_date is null or placement.end_date >= new.end_date)
          and regexp_replace(lower(btrim(placement.status)), '[[:space:]-]+', '_', 'g') = any (
            array['placement_confirmed', 'matched', 'onboarding', 'active', 'live', 'working', 'placed']
          )
        )
      )
  ) then
    raise exception using errcode = '23514', message = 'Time off must match one Talent, placement, and organization.';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_talent_time_off_scope() from public, anon, authenticated;

drop trigger if exists talent_time_off_scope_guard on public.talent_time_off_requests;
create trigger talent_time_off_scope_guard
before insert or update on public.talent_time_off_requests
for each row execute function private.enforce_talent_time_off_scope();

create or replace function private.talent_time_off_management_organization(p_actor_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_organization_id uuid;
begin
  if p_actor_user_id is null then
    raise exception using errcode = '22023', message = 'A signed-in account is required.';
  end if;

  select access.organization_id
  into v_organization_id
  from public.platform_users as access
  where access.id = p_actor_user_id
    and access.active = true
    and access.must_change_password = false
    and access.organization_id is not null
    and access.role in (
      'admin'::public.platform_role,
      'talent_management'::public.platform_role
    );

  if v_organization_id is null then
    raise exception using errcode = '42501', message = 'Admin or Talent Management access is required.';
  end if;

  return v_organization_id;
end;
$$;

revoke all on function private.talent_time_off_management_organization(uuid) from public, anon, authenticated;
grant execute on function private.talent_time_off_management_organization(uuid) to service_role;

create or replace function private.talent_time_off_eligibility(p_actor_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_identity record;
  v_placement record;
  v_count integer;
begin
  select * into v_identity
  from private.talent_attendance_identity(p_actor_user_id);

  select count(*)::integer
  into v_count
  from public.placements as placement
  join public.clients as client
    on client.id = placement.client_id
   and client.organization_id = v_identity.organization_id
   and client.archived_at is null
  where placement.applicant_id = v_identity.applicant_id
    and placement.start_date is not null
    and placement.start_date <= v_identity.work_date
    and (placement.end_date is null or placement.end_date >= v_identity.work_date)
    and regexp_replace(lower(btrim(placement.status)), '[[:space:]-]+', '_', 'g') = any (
      array['placement_confirmed', 'matched', 'onboarding', 'active', 'live', 'working', 'placed']
    );

  if v_count = 0 then
    return jsonb_build_object(
      'eligible', false,
      'state', 'unmatched',
      'placementId', null,
      'clientName', null,
      'workTimezone', v_identity.work_timezone,
      'minStartDate', v_identity.work_date
    );
  end if;

  if v_count > 1 then
    return jsonb_build_object(
      'eligible', false,
      'state', 'needs_review',
      'placementId', null,
      'clientName', null,
      'workTimezone', v_identity.work_timezone,
      'minStartDate', v_identity.work_date
    );
  end if;

  select placement.id, client.company_name
  into strict v_placement
  from public.placements as placement
  join public.clients as client
    on client.id = placement.client_id
   and client.organization_id = v_identity.organization_id
   and client.archived_at is null
  where placement.applicant_id = v_identity.applicant_id
    and placement.start_date is not null
    and placement.start_date <= v_identity.work_date
    and (placement.end_date is null or placement.end_date >= v_identity.work_date)
    and regexp_replace(lower(btrim(placement.status)), '[[:space:]-]+', '_', 'g') = any (
      array['placement_confirmed', 'matched', 'onboarding', 'active', 'live', 'working', 'placed']
    );

  return jsonb_build_object(
    'eligible', true,
    'state', 'eligible',
    'placementId', v_placement.id,
    'clientName', v_placement.company_name,
    'workTimezone', v_identity.work_timezone,
    'minStartDate', v_identity.work_date
  );
end;
$$;

revoke all on function private.talent_time_off_eligibility(uuid) from public, anon, authenticated;
grant execute on function private.talent_time_off_eligibility(uuid) to service_role;

create or replace function public.get_talent_time_off(p_actor_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_role public.platform_role;
  v_organization_id uuid;
  v_applicant_id uuid;
  v_viewer_role text;
  v_eligibility jsonb;
  v_rows jsonb;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_actor_user_id is null then
    raise exception using errcode = '22023', message = 'A signed-in account is required.';
  end if;

  select access.role, access.organization_id
  into v_role, v_organization_id
  from public.platform_users as access
  where access.id = p_actor_user_id
    and access.active = true
    and access.must_change_password = false
    and access.organization_id is not null;

  if v_role = 'virtual_assistant'::public.platform_role then
    select identity.applicant_id, identity.organization_id
    into v_applicant_id, v_organization_id
    from private.talent_attendance_identity(p_actor_user_id) as identity;
    v_viewer_role := v_role::text;
    v_eligibility := private.talent_time_off_eligibility(p_actor_user_id);
  elsif v_role in (
    'admin'::public.platform_role,
    'talent_management'::public.platform_role
  ) then
    v_organization_id := private.talent_time_off_management_organization(p_actor_user_id);
    v_viewer_role := v_role::text;
    v_eligibility := null;
  else
    raise exception using errcode = '42501', message = 'Talent, Admin, or Talent Management access is required.';
  end if;

  with request_scope as (
    select request.*
    from public.talent_time_off_requests as request
    where request.organization_id = v_organization_id
      and (
        v_role in ('admin'::public.platform_role, 'talent_management'::public.platform_role)
        or request.applicant_id = v_applicant_id
      )
    order by
      case when request.status = 'pending' then 0 else 1 end,
      case when request.status = 'pending' then request.start_date end asc nulls last,
      case when request.status <> 'pending'
        then coalesce(request.cancelled_at, request.decided_at, request.submitted_at)
      end desc nulls last,
      request.submitted_at desc,
      request.id
    limit 1000
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'timeOffRequestId', request.id,
        'applicantId', request.applicant_id,
        'applicantName', applicant.full_name,
        'placementId', request.placement_id,
        'clientName', client.company_name,
        'startDate', request.start_date,
        'endDate', request.end_date,
        'workTimezone', request.work_timezone,
        'status', request.status,
        'note', request.talent_note,
        'submittedAt', request.submitted_at,
        'decidedAt', request.decided_at,
        'decisionNote', request.decision_note,
        'canCancel', (
          v_role = 'virtual_assistant'::public.platform_role
          and request.status in ('pending', 'approved')
          and (v_now at time zone request.work_timezone)::date < request.start_date
        )
      ) order by
        case when request.status = 'pending' then 0 else 1 end,
        case when request.status = 'pending' then request.start_date end asc nulls last,
        case when request.status <> 'pending'
          then coalesce(request.cancelled_at, request.decided_at, request.submitted_at)
        end desc nulls last,
        request.submitted_at desc,
        request.id
    ),
    '[]'::jsonb
  )
  into v_rows
  from request_scope as request
  join public.applicants as applicant
    on applicant.id = request.applicant_id
   and applicant.organization_id = request.organization_id
  join public.placements as placement
    on placement.id = request.placement_id
   and placement.applicant_id = request.applicant_id
  join public.clients as client
    on client.id = placement.client_id
   and client.organization_id = request.organization_id
  where applicant.organization_id = v_organization_id;

  return jsonb_build_object(
    'generatedAt', v_now,
    'viewerRole', v_viewer_role,
    'eligibility', v_eligibility,
    'requests', v_rows
  );
end;
$$;

revoke all on function public.get_talent_time_off(uuid) from public, anon, authenticated;
grant execute on function public.get_talent_time_off(uuid) to service_role;

create or replace function public.submit_talent_time_off(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_start_date date,
  p_end_date date,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $$
declare
  v_identity record;
  v_applicant_id uuid;
  v_organization_id uuid;
  v_work_date date;
  v_placement record;
  v_current_count integer;
  v_note text := nullif(btrim(p_note), '');
  v_request public.talent_time_off_requests%rowtype;
  v_operation public.talent_time_off_operations%rowtype;
  v_fingerprint text;
begin
  if p_request_id is null or p_start_date is null or p_end_date is null then
    raise exception using errcode = '22023', message = 'Request id, start date, and end date are required.';
  end if;
  if not (p_end_date >= p_start_date) then
    raise exception using errcode = '22023', message = 'End date must be on or after start date.';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception using errcode = '22023', message = 'The scheduling note is too long.';
  end if;

  select * into v_identity
  from private.talent_attendance_identity(p_actor_user_id);

  v_applicant_id := v_identity.applicant_id;
  v_organization_id := v_identity.organization_id;
  v_work_date := v_identity.work_date;

  v_fingerprint := encode(
    digest(
      concat_ws('|', 'submit', p_start_date::text, p_end_date::text, coalesce(v_note, '')),
      'sha256'
    ),
    'hex'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('talent-time-off-operation:' || p_request_id::text, 0)
  );

  select * into v_operation
  from public.talent_time_off_operations
  where operation_request_id = p_request_id;

  if v_operation.operation_request_id is not null then
    if v_operation.actor_user_id is distinct from p_actor_user_id
      or v_operation.action <> 'submit'
      or v_operation.request_fingerprint <> v_fingerprint then
      raise exception using errcode = '22023', message = 'This request id has already been used for another operation.';
    end if;
    return public.get_talent_time_off(p_actor_user_id);
  end if;

  if p_start_date < v_identity.work_date then
    raise exception using errcode = '22023', message = 'Time off cannot start before today.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('talent-time-off-applicant:' || v_applicant_id::text, 0)
  );

  select count(*)::integer
  into v_current_count
  from public.placements as placement
  join public.clients as client
    on client.id = placement.client_id
   and client.organization_id = v_organization_id
   and client.archived_at is null
  where placement.applicant_id = v_applicant_id
    and placement.start_date is not null
    and placement.start_date <= v_work_date
    and (placement.end_date is null or placement.end_date >= v_work_date)
    and regexp_replace(lower(btrim(placement.status)), '[[:space:]-]+', '_', 'g') = any (
      array['placement_confirmed', 'matched', 'onboarding', 'active', 'live', 'working', 'placed']
    );

  if v_current_count = 0 then
    raise exception using errcode = 'P0001', message = 'A current client placement is required before requesting time off.';
  elsif v_current_count > 1 then
    raise exception using errcode = '21000', message = 'More than one current client placement needs management review.';
  end if;

  select placement.id, client.company_name
  into v_placement
  from public.placements as placement
  join public.clients as client
    on client.id = placement.client_id
   and client.organization_id = v_organization_id
   and client.archived_at is null
  where placement.applicant_id = v_applicant_id
    and placement.start_date is not null
    and placement.start_date <= v_work_date
    and placement.start_date <= p_start_date
    and (placement.end_date is null or placement.end_date >= p_end_date)
    and regexp_replace(lower(btrim(placement.status)), '[[:space:]-]+', '_', 'g') = any (
      array['placement_confirmed', 'matched', 'onboarding', 'active', 'live', 'working', 'placed']
    );

  if v_placement.id is null then
    raise exception using errcode = 'P0001', message = 'The current client placement does not cover the requested dates.';
  end if;

  if exists (
    select 1
    from public.talent_time_off_requests as existing
    where existing.applicant_id = v_applicant_id
      and existing.status in ('pending', 'approved')
      and daterange(existing.start_date, existing.end_date, '[]')
        && daterange(p_start_date, p_end_date, '[]')
  ) then
    raise exception using errcode = '23P01', message = 'This request overlaps an existing pending or approved request.';
  end if;

  begin
    insert into public.talent_time_off_requests (
      organization_id,
      applicant_id,
      placement_id,
      start_date,
      end_date,
      work_timezone,
      talent_note,
      submitted_by_user_id
    ) values (
      v_organization_id,
      v_applicant_id,
      v_placement.id,
      p_start_date,
      p_end_date,
      v_identity.work_timezone,
      v_note,
      p_actor_user_id
    ) returning * into v_request;
  exception when exclusion_violation then
    raise exception using errcode = '23P01', message = 'This request overlaps an existing pending or approved request.';
  end;

  insert into public.talent_time_off_operations (
    operation_request_id,
    organization_id,
    actor_user_id,
    action,
    time_off_request_id,
    request_fingerprint
  ) values (
    p_request_id,
    v_organization_id,
    p_actor_user_id,
    'submit',
    v_request.id,
    v_fingerprint
  );

  insert into public.audit_events (
    organization_id,
    actor_user_id,
    entity_type,
    entity_id,
    event_type,
    before_value,
    after_value
  ) values (
    v_organization_id,
    p_actor_user_id,
    'talent_time_off',
    v_request.id,
    'submit',
    null,
    jsonb_build_object(
      'changedFields', jsonb_build_array(
        'status', 'start_date', 'end_date', 'work_timezone', 'talent_note', 'submitted_at'
      )
    )
  );

  return public.get_talent_time_off(p_actor_user_id);
end;
$$;

revoke all on function public.submit_talent_time_off(uuid, uuid, date, date, text) from public, anon, authenticated;
grant execute on function public.submit_talent_time_off(uuid, uuid, date, date, text) to service_role;

create or replace function public.change_talent_time_off(
  p_actor_user_id uuid,
  p_action text,
  p_request_id uuid,
  p_time_off_request_id uuid,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $$
declare
  v_action text := lower(btrim(p_action));
  v_note text := nullif(btrim(p_note), '');
  v_role public.platform_role;
  v_organization_id uuid;
  v_applicant_id uuid;
  v_request public.talent_time_off_requests%rowtype;
  v_operation public.talent_time_off_operations%rowtype;
  v_fingerprint text;
  v_changed_fields jsonb;
begin
  if p_actor_user_id is null or p_request_id is null or p_time_off_request_id is null then
    raise exception using errcode = '22023', message = 'Actor, request id, and time-off request id are required.';
  end if;
  if v_action is null or v_action not in ('cancel', 'approve', 'decline') then
    raise exception using errcode = '22023', message = 'Unsupported time-off action.';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception using errcode = '22023', message = 'The note is too long.';
  end if;
  if v_action = 'decline' and v_note is null then
    raise exception using errcode = '22023', message = 'A brief note is required when a request is not approved.';
  end if;
  if v_action = 'cancel' and v_note is not null then
    raise exception using errcode = '22023', message = 'Cancellation does not accept a note.';
  end if;

  select access.role, access.organization_id
  into v_role, v_organization_id
  from public.platform_users as access
  where access.id = p_actor_user_id
    and access.active = true
    and access.must_change_password = false
    and access.organization_id is not null;

  if v_role = 'virtual_assistant'::public.platform_role then
    select identity.applicant_id, identity.organization_id
    into v_applicant_id, v_organization_id
    from private.talent_attendance_identity(p_actor_user_id) as identity;
    if v_action <> 'cancel' then
      raise exception using errcode = '42501', message = 'Talent accounts can cancel only their own eligible requests.';
    end if;
  elsif v_role in (
    'admin'::public.platform_role,
    'talent_management'::public.platform_role
  ) then
    v_organization_id := private.talent_time_off_management_organization(p_actor_user_id);
    if v_action = 'cancel' then
      raise exception using errcode = '42501', message = 'Only the Talent account can cancel this request.';
    end if;
  else
    raise exception using errcode = '42501', message = 'Talent, Admin, or Talent Management access is required.';
  end if;

  v_fingerprint := encode(
    digest(
      concat_ws('|', v_action, p_time_off_request_id::text, coalesce(v_note, '')),
      'sha256'
    ),
    'hex'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('talent-time-off-operation:' || p_request_id::text, 0)
  );

  select * into v_operation
  from public.talent_time_off_operations
  where operation_request_id = p_request_id;

  if v_operation.operation_request_id is not null then
    if v_operation.actor_user_id is distinct from p_actor_user_id
      or v_operation.action <> v_action
      or v_operation.time_off_request_id is distinct from p_time_off_request_id
      or v_operation.request_fingerprint <> v_fingerprint then
      raise exception using errcode = '22023', message = 'This request id has already been used for another operation.';
    end if;
    return public.get_talent_time_off(p_actor_user_id);
  end if;

  select request.*
  into v_request
  from public.talent_time_off_requests as request
  where request.id = p_time_off_request_id
    and request.organization_id = v_organization_id
    and (v_role <> 'virtual_assistant'::public.platform_role or request.applicant_id = v_applicant_id)
  for update;

  if v_request.id is null then
    raise exception using errcode = '42501', message = 'This time-off request is not available to your account.';
  end if;

  if v_action = 'cancel' then
    if v_request.status not in ('pending', 'approved') then
      raise exception using errcode = 'P0001', message = 'Only pending or approved requests can be cancelled.';
    end if;
    if (pg_catalog.clock_timestamp() at time zone v_request.work_timezone)::date >= v_request.start_date then
      raise exception using errcode = 'P0001', message = 'This request can no longer be cancelled because its start date has arrived.';
    end if;

    update public.talent_time_off_requests
    set
      status = 'cancelled',
      cancelled_by_user_id = p_actor_user_id,
      cancelled_at = pg_catalog.clock_timestamp()
    where id = v_request.id;

    v_changed_fields := jsonb_build_array('status', 'cancelled_at');
  else
    if v_request.status <> 'pending' then
      raise exception using errcode = 'P0001', message = 'Only pending requests can be approved or not approved.';
    end if;

    if v_action = 'approve' then
      update public.talent_time_off_requests
      set
        status = 'approved',
        decided_by_user_id = p_actor_user_id,
        decided_at = pg_catalog.clock_timestamp(),
        decision_note = v_note
      where id = v_request.id;
    else
      update public.talent_time_off_requests
      set
        status = 'declined',
        decided_by_user_id = p_actor_user_id,
        decided_at = pg_catalog.clock_timestamp(),
        decision_note = v_note
      where id = v_request.id;
    end if;

    v_changed_fields := jsonb_build_array('status', 'decided_at', 'decision_note');
  end if;

  insert into public.talent_time_off_operations (
    operation_request_id,
    organization_id,
    actor_user_id,
    action,
    time_off_request_id,
    request_fingerprint
  ) values (
    p_request_id,
    v_organization_id,
    p_actor_user_id,
    v_action,
    v_request.id,
    v_fingerprint
  );

  insert into public.audit_events (
    organization_id,
    actor_user_id,
    entity_type,
    entity_id,
    event_type,
    before_value,
    after_value
  ) values (
    v_organization_id,
    p_actor_user_id,
    'talent_time_off',
    v_request.id,
    v_action,
    null,
    jsonb_build_object('changedFields', v_changed_fields)
  );

  return public.get_talent_time_off(p_actor_user_id);
end;
$$;

revoke all on function public.change_talent_time_off(uuid, text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.change_talent_time_off(uuid, text, uuid, uuid, text) to service_role;

-- Time-off audit events and records are operationally sensitive. Sales,
-- Billing, and Client roles do not receive direct table or audit access.
drop policy if exists "authorized internal users can read audit history" on public.audit_events;
create policy "authorized internal users can read audit history"
on public.audit_events for select to authenticated
using (
  private.is_internal_soro_user()
  and (
    entity_type not in ('talent_portal_access', 'talent_attendance', 'talent_time_off')
    or private.current_soro_role() in (
      'admin'::public.platform_role,
      'talent_management'::public.platform_role
    )
  )
);

comment on table public.talent_time_off_requests is
  'Full-day scheduling-availability requests. Approval does not alter attendance, pay, benefits, or billing.';

comment on function public.get_talent_time_off(uuid) is
  'Service-only Talent own-history or same-organization management queue.';
