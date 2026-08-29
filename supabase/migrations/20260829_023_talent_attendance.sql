-- Manual Talent Portal Start Day / Check Out workflow.
-- Browser callers never choose the applicant, placement, date, organization,
-- or timestamps. The server verifies the signed-in account and calls these
-- service-role-only functions with the authenticated user id.

create table if not exists public.talent_attendance_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  applicant_id uuid not null references public.applicants(id) on delete restrict,
  placement_id uuid not null references public.placements(id) on delete restrict,
  work_date date not null,
  work_timezone text not null,
  started_at timestamptz not null,
  checked_out_at timestamptz,
  started_by_user_id uuid references public.platform_users(id) on delete set null,
  checked_out_by_user_id uuid references public.platform_users(id) on delete set null,
  start_request_id uuid not null unique,
  checkout_request_id uuid unique,
  corrected_at timestamptz,
  corrected_by_user_id uuid references public.platform_users(id) on delete set null,
  correction_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint talent_attendance_checkout_after_start
    check (checked_out_at is null or checked_out_at >= started_at),
  constraint talent_attendance_correction_complete
    check (
      (corrected_at is null and corrected_by_user_id is null and correction_note is null)
      or (
        corrected_at is not null
        and corrected_by_user_id is not null
        and nullif(btrim(correction_note), '') is not null
      )
    ),
  unique (applicant_id, work_date)
);

create unique index if not exists talent_attendance_one_open_session_idx
  on public.talent_attendance_sessions (applicant_id)
  where checked_out_at is null;

create index if not exists talent_attendance_org_date_idx
  on public.talent_attendance_sessions (organization_id, work_date desc);

create index if not exists talent_attendance_placement_date_idx
  on public.talent_attendance_sessions (placement_id, work_date desc);

drop trigger if exists talent_attendance_sessions_updated_at on public.talent_attendance_sessions;
create trigger talent_attendance_sessions_updated_at
before update on public.talent_attendance_sessions
for each row execute function public.set_updated_at();

alter table public.talent_attendance_sessions enable row level security;

revoke all on table public.talent_attendance_sessions from anon, authenticated;
grant select (
  applicant_id,
  placement_id,
  work_date,
  work_timezone,
  started_at,
  checked_out_at
) on table public.talent_attendance_sessions to authenticated;
grant select, insert, update on table public.talent_attendance_sessions to service_role;

create or replace function private.enforce_talent_attendance_scope()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
begin
  if tg_op = 'UPDATE' and (
    new.organization_id is distinct from old.organization_id
    or new.applicant_id is distinct from old.applicant_id
    or new.placement_id is distinct from old.placement_id
    or new.work_date is distinct from old.work_date
    or new.work_timezone is distinct from old.work_timezone
    or new.started_at is distinct from old.started_at
    or new.started_by_user_id is distinct from old.started_by_user_id
    or new.start_request_id is distinct from old.start_request_id
  ) then
    raise exception using errcode = '42501', message = 'Attendance record ownership cannot be changed.';
  end if;

  if not exists (
    select 1
    from public.placements as placement
    join public.applicants as applicant
      on applicant.id = placement.applicant_id
     and applicant.organization_id = new.organization_id
    join public.clients as client
      on client.id = placement.client_id
     and client.organization_id = new.organization_id
    where placement.id = new.placement_id
      and placement.applicant_id = new.applicant_id
      and (tg_op = 'UPDATE' or client.archived_at is null)
  ) then
    raise exception using errcode = '23514', message = 'Attendance must match one Talent, placement, and organization.';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_talent_attendance_scope() from public, anon, authenticated;

drop trigger if exists talent_attendance_scope_guard on public.talent_attendance_sessions;
create trigger talent_attendance_scope_guard
before insert or update on public.talent_attendance_sessions
for each row execute function private.enforce_talent_attendance_scope();

drop policy if exists "authorized staff can read organization Talent attendance" on public.talent_attendance_sessions;
create policy "authorized staff can read organization Talent attendance"
on public.talent_attendance_sessions for select to authenticated
using (
  organization_id = private.current_soro_organization_id()
  and private.current_soro_role() in (
    'admin'::public.platform_role,
    'talent_management'::public.platform_role
  )
);

drop policy if exists "active Talent can read own attendance" on public.talent_attendance_sessions;
create policy "active Talent can read own attendance"
on public.talent_attendance_sessions for select to authenticated
using (
  organization_id = private.current_soro_organization_id()
  and private.current_soro_role() = 'virtual_assistant'::public.platform_role
  and exists (
    select 1
    from public.applicants as applicant
    where applicant.id = talent_attendance_sessions.applicant_id
      and applicant.organization_id = talent_attendance_sessions.organization_id
      and applicant.auth_user_id = auth.uid()
      and applicant.portal_access_status = 'active'
      and applicant.archived_at is null
  )
);

create or replace function private.talent_attendance_identity(p_actor_user_id uuid)
returns table (
  applicant_id uuid,
  organization_id uuid,
  work_timezone text,
  work_date date
)
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_applicant_id uuid;
  v_organization_id uuid;
  v_timezone text;
begin
  if p_actor_user_id is null then
    raise exception using errcode = '22023', message = 'A signed-in Talent account is required.';
  end if;

  if not exists (
    select 1
    from public.platform_users as access
    where access.id = p_actor_user_id
      and access.active = true
      and access.must_change_password = false
      and access.role = 'virtual_assistant'::public.platform_role
  ) then
    raise exception using errcode = '42501', message = 'Active Talent Portal access is required.';
  end if;

  begin
    select
      applicant.id,
      applicant.organization_id,
      case
        when exists (
          select 1
          from pg_catalog.pg_timezone_names as zone
          where zone.name = nullif(btrim(applicant.timezone), '')
        ) then btrim(applicant.timezone)
        else 'Asia/Manila'
      end
    into strict v_applicant_id, v_organization_id, v_timezone
    from public.applicants as applicant
    join public.platform_users as access
      on access.id = p_actor_user_id
     and access.organization_id = applicant.organization_id
    where applicant.auth_user_id = p_actor_user_id
      and applicant.portal_access_status = 'active'
      and applicant.archived_at is null;
  exception
    when no_data_found then
      raise exception using errcode = '42501', message = 'This Talent account is not linked to an active profile.';
    when too_many_rows then
      raise exception using errcode = '21000', message = 'This Talent account is linked to more than one active profile.';
  end;

  applicant_id := v_applicant_id;
  organization_id := v_organization_id;
  work_timezone := v_timezone;
  work_date := (pg_catalog.clock_timestamp() at time zone v_timezone)::date;
  return next;
end;
$$;

revoke all on function private.talent_attendance_identity(uuid) from public, anon, authenticated;
grant execute on function private.talent_attendance_identity(uuid) to service_role;

create or replace function public.get_talent_attendance_status(p_actor_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_identity record;
  v_session record;
  v_placements jsonb;
  v_pending_placements jsonb;
  v_placement jsonb;
  v_count integer;
begin
  select * into v_identity
  from private.talent_attendance_identity(p_actor_user_id);

  select
    session.id,
    session.placement_id,
    session.work_date,
    session.work_timezone,
    session.started_at,
    session.checked_out_at,
    client.company_name,
    placement.schedule_summary
  into v_session
  from public.talent_attendance_sessions as session
  join public.placements as placement
    on placement.id = session.placement_id
   and placement.applicant_id = session.applicant_id
  join public.clients as client
    on client.id = placement.client_id
   and client.organization_id = session.organization_id
  where session.applicant_id = v_identity.applicant_id
    and session.organization_id = v_identity.organization_id
    and session.checked_out_at is null
  order by session.started_at desc
  limit 1;

  if v_session.id is not null then
    return jsonb_build_object(
      'eligible', true,
      'state', 'started',
      'applicantId', v_identity.applicant_id,
      'placementId', v_session.placement_id,
      'sessionId', v_session.id,
      'clientName', v_session.company_name,
      'scheduleSummary', v_session.schedule_summary,
      'workDate', v_session.work_date,
      'workTimezone', v_session.work_timezone,
      'startedAt', v_session.started_at,
      'checkedOutAt', null
    );
  end if;

  select
    session.id,
    session.placement_id,
    session.work_date,
    session.work_timezone,
    session.started_at,
    session.checked_out_at,
    client.company_name,
    placement.schedule_summary
  into v_session
  from public.talent_attendance_sessions as session
  join public.placements as placement
    on placement.id = session.placement_id
   and placement.applicant_id = session.applicant_id
  join public.clients as client
    on client.id = placement.client_id
   and client.organization_id = session.organization_id
  where session.applicant_id = v_identity.applicant_id
    and session.organization_id = v_identity.organization_id
    and session.work_date = v_identity.work_date
    and session.checked_out_at is not null
  order by session.checked_out_at desc
  limit 1;

  if v_session.id is not null then
    return jsonb_build_object(
      'eligible', true,
      'state', 'completed',
      'applicantId', v_identity.applicant_id,
      'placementId', v_session.placement_id,
      'sessionId', v_session.id,
      'clientName', v_session.company_name,
      'scheduleSummary', v_session.schedule_summary,
      'workDate', v_session.work_date,
      'workTimezone', v_session.work_timezone,
      'startedAt', v_session.started_at,
      'checkedOutAt', v_session.checked_out_at
    );
  end if;

  select coalesce(jsonb_agg(to_jsonb(candidate)), '[]'::jsonb)
  into v_placements
  from (
    select
      placement.id as "placementId",
      client.company_name as "clientName",
      placement.schedule_summary as "scheduleSummary",
      placement.start_date as "startDate",
      placement.end_date as "endDate",
      regexp_replace(lower(btrim(placement.status)), '[[:space:]-]+', '_', 'g') as status
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
      )
    order by placement.start_date desc, placement.created_at desc
  ) as candidate;

  v_count := jsonb_array_length(v_placements);

  if v_count = 0 then
    select coalesce(jsonb_agg(to_jsonb(candidate)), '[]'::jsonb)
    into v_pending_placements
    from (
      select
        placement.id as "placementId",
        client.company_name as "clientName",
        placement.schedule_summary as "scheduleSummary",
        placement.start_date as "startDate"
      from public.placements as placement
      join public.clients as client
        on client.id = placement.client_id
       and client.organization_id = v_identity.organization_id
       and client.archived_at is null
      where placement.applicant_id = v_identity.applicant_id
        and (placement.end_date is null or placement.end_date >= v_identity.work_date)
        and (placement.start_date is null or placement.start_date > v_identity.work_date)
        and regexp_replace(lower(btrim(placement.status)), '[[:space:]-]+', '_', 'g') = any (
          array['placement_confirmed', 'matched', 'onboarding', 'active', 'live', 'working', 'placed']
        )
      order by placement.start_date asc nulls first, placement.created_at desc
    ) as candidate;

    if jsonb_array_length(v_pending_placements) > 0 then
      v_placement := v_pending_placements -> 0;
      if nullif(v_placement ->> 'startDate', '') is null then
        return jsonb_build_object(
          'eligible', false,
          'state', 'needs_review',
          'clientName', v_placement ->> 'clientName',
          'workDate', v_identity.work_date,
          'workTimezone', v_identity.work_timezone,
          'message', 'The client placement needs a confirmed start date before Start Day is available.'
        );
      end if;
      return jsonb_build_object(
        'eligible', false,
        'state', 'not_yet_available',
        'clientName', v_placement ->> 'clientName',
        'startDate', v_placement ->> 'startDate',
        'workDate', v_identity.work_date,
        'workTimezone', v_identity.work_timezone,
        'message', 'Your client placement has not started yet.'
      );
    end if;

    return jsonb_build_object(
      'eligible', false,
      'state', 'unmatched',
      'workDate', v_identity.work_date,
      'workTimezone', v_identity.work_timezone
    );
  end if;

  if v_count > 1 then
    return jsonb_build_object(
      'eligible', false,
      'state', 'needs_review',
      'workDate', v_identity.work_date,
      'workTimezone', v_identity.work_timezone,
      'message', 'More than one current client placement needs management review.'
    );
  end if;

  v_placement := v_placements -> 0;
  return jsonb_build_object(
    'eligible', true,
    'state', 'not_started',
    'applicantId', v_identity.applicant_id,
    'placementId', v_placement ->> 'placementId',
    'clientName', v_placement ->> 'clientName',
    'scheduleSummary', v_placement ->> 'scheduleSummary',
    'workDate', v_identity.work_date,
    'workTimezone', v_identity.work_timezone,
    'startedAt', null,
    'checkedOutAt', null
  );
end;
$$;

revoke all on function public.get_talent_attendance_status(uuid) from public, anon, authenticated;
grant execute on function public.get_talent_attendance_status(uuid) to service_role;

create or replace function public.record_talent_attendance(
  p_actor_user_id uuid,
  p_action text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_identity record;
  v_status jsonb;
  v_session public.talent_attendance_sessions%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_action text := lower(btrim(p_action));
begin
  if v_action is null or v_action not in ('start_day', 'check_out') then
    raise exception using errcode = '22023', message = 'Unsupported attendance action.';
  end if;
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'A request id is required.';
  end if;

  select * into v_identity
  from private.talent_attendance_identity(p_actor_user_id);

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('talent-attendance:' || v_identity.applicant_id::text, 0)
  );

  if v_action = 'start_day' then
    select * into v_session
    from public.talent_attendance_sessions
    where start_request_id = p_request_id
      and applicant_id = v_identity.applicant_id;

    if v_session.id is not null then
      return public.get_talent_attendance_status(p_actor_user_id);
    end if;

    v_status := public.get_talent_attendance_status(p_actor_user_id);
    if v_status ->> 'state' in ('started', 'completed') then
      return v_status;
    end if;
    if v_status ->> 'state' = 'needs_review' then
      raise exception using errcode = '21000', message = 'The current client placement needs management review.';
    end if;
    if coalesce((v_status ->> 'eligible')::boolean, false) is not true
      or v_status ->> 'state' <> 'not_started' then
      raise exception using errcode = 'P0001', message = 'A current client placement is required before starting the day.';
    end if;

    insert into public.talent_attendance_sessions (
      organization_id,
      applicant_id,
      placement_id,
      work_date,
      work_timezone,
      started_at,
      started_by_user_id,
      start_request_id
    ) values (
      v_identity.organization_id,
      v_identity.applicant_id,
      (v_status ->> 'placementId')::uuid,
      (v_status ->> 'workDate')::date,
      v_status ->> 'workTimezone',
      v_now,
      p_actor_user_id,
      p_request_id
    ) returning * into v_session;

    insert into public.audit_events (
      organization_id,
      actor_user_id,
      entity_type,
      entity_id,
      event_type,
      before_value,
      after_value,
      note
    ) values (
      v_identity.organization_id,
      p_actor_user_id,
      'talent_attendance',
      v_identity.applicant_id,
      'start_day',
      null,
      jsonb_build_object(
        'session_id', v_session.id,
        'placement_id', v_session.placement_id,
        'work_date', v_session.work_date,
        'started_at', v_session.started_at
      ),
      'Manual Start Day recorded in the Talent Portal.'
    );
  else
    select * into v_session
    from public.talent_attendance_sessions
    where checkout_request_id = p_request_id
      and applicant_id = v_identity.applicant_id;

    if v_session.id is not null then
      return public.get_talent_attendance_status(p_actor_user_id);
    end if;

    select * into v_session
    from public.talent_attendance_sessions
    where applicant_id = v_identity.applicant_id
      and organization_id = v_identity.organization_id
      and checked_out_at is null
    order by started_at desc
    limit 1
    for update;

    if v_session.id is null then
      return public.get_talent_attendance_status(p_actor_user_id);
    end if;

    update public.talent_attendance_sessions
    set
      checked_out_at = greatest(v_now, v_session.started_at),
      checked_out_by_user_id = p_actor_user_id,
      checkout_request_id = p_request_id
    where id = v_session.id
      and checked_out_at is null
    returning * into v_session;

    insert into public.audit_events (
      organization_id,
      actor_user_id,
      entity_type,
      entity_id,
      event_type,
      before_value,
      after_value,
      note
    ) values (
      v_identity.organization_id,
      p_actor_user_id,
      'talent_attendance',
      v_identity.applicant_id,
      'check_out',
      jsonb_build_object(
        'session_id', v_session.id,
        'placement_id', v_session.placement_id,
        'work_date', v_session.work_date,
        'started_at', v_session.started_at
      ),
      jsonb_build_object(
        'session_id', v_session.id,
        'placement_id', v_session.placement_id,
        'work_date', v_session.work_date,
        'started_at', v_session.started_at,
        'checked_out_at', v_session.checked_out_at
      ),
      'Manual Check Out recorded in the Talent Portal.'
    );
  end if;

  return public.get_talent_attendance_status(p_actor_user_id);
end;
$$;

revoke all on function public.record_talent_attendance(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.record_talent_attendance(uuid, text, uuid) to service_role;

-- Attendance audit records are operationally sensitive. Keep them available
-- only to Administrators and Talent Management, not Sales or Billing.
drop policy if exists "authorized internal users can read audit history" on public.audit_events;
create policy "authorized internal users can read audit history"
on public.audit_events for select to authenticated
using (
  private.is_internal_soro_user()
  and (
    entity_type not in ('talent_portal_access', 'talent_attendance')
    or private.current_soro_role() in (
      'admin'::public.platform_role,
      'talent_management'::public.platform_role
    )
  )
);

comment on table public.talent_attendance_sessions is
  'Manual presence records for active client placements. These are not productivity measurements or payroll timecards.';
