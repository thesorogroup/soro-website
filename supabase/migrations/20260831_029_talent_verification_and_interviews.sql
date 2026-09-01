-- Soro Operations: internal Talent interviews, employment-reference checks,
-- and optional Microsoft 365 calendar synchronization.
--
-- Soro remains the system of record. Microsoft receives only the interview
-- title, times, and attendee identities required to create a calendar-backed
-- Teams meeting; private review and reference notes never leave Soro.

create table if not exists public.talent_interviews (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  applicant_id uuid not null references public.applicants(id) on delete cascade,
  interviewer_user_id uuid references public.platform_users(id) on delete set null,
  interviewer_name_snapshot text not null check (char_length(interviewer_name_snapshot) between 1 and 180),
  interviewer_email_snapshot text not null check (char_length(interviewer_email_snapshot) between 3 and 254),
  status text not null default 'scheduled' check (status in ('scheduled', 'completed', 'cancelled', 'no_show', 'waived')),
  starts_at timestamptz,
  ends_at timestamptz,
  timezone text,
  outcome text check (outcome is null or outcome in ('recommended', 'follow_up', 'not_recommended')),
  scorecard jsonb,
  private_notes text,
  calendar_sync_status text not null default 'pending'
    check (calendar_sync_status in ('connection_required', 'pending', 'synced', 'sync_failed', 'not_applicable')),
  calendar_sync_action text check (calendar_sync_action is null or calendar_sync_action in ('create', 'update', 'cancel')),
  calendar_transaction_id uuid,
  microsoft_event_id text,
  microsoft_join_url text,
  microsoft_last_error_code text,
  microsoft_organizer_snapshot text check (microsoft_organizer_snapshot is null or char_length(microsoft_organizer_snapshot) <= 1024),
  calendar_sync_started_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, applicant_id),
  check (starts_at is not null and ends_at is not null and ends_at > starts_at and timezone is not null),
  check (
    (status = 'completed' and outcome is not null)
    or (status <> 'completed' and outcome is null)
  ),
  check (scorecard is null or jsonb_typeof(scorecard) = 'object'),
  check (private_notes is null or char_length(private_notes) <= 4000),
  check (microsoft_event_id is null or char_length(microsoft_event_id) <= 1024),
  check (microsoft_join_url is null or char_length(microsoft_join_url) <= 2048),
  check (microsoft_last_error_code is null or char_length(microsoft_last_error_code) <= 100)
);

create index if not exists talent_interviews_schedule_idx
  on public.talent_interviews (organization_id, starts_at)
  where status = 'scheduled';

create table if not exists public.talent_reference_checks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  applicant_id uuid not null references public.applicants(id) on delete cascade,
  reference_name text not null check (char_length(btrim(reference_name)) between 1 and 180),
  company text check (company is null or char_length(company) <= 180),
  relationship text check (relationship is null or char_length(relationship) <= 180),
  phone text check (phone is null or char_length(phone) <= 60),
  email text check (email is null or char_length(email) <= 254),
  outcome text not null default 'pending'
    check (outcome in ('pending', 'verified', 'discrepancy', 'unable_to_reach', 'not_provided')),
  outcome_note text check (outcome_note is null or char_length(outcome_note) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists talent_reference_checks_applicant_idx
  on public.talent_reference_checks (organization_id, applicant_id, created_at, id);

create table if not exists public.talent_reference_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  reference_check_id uuid not null references public.talent_reference_checks(id) on delete cascade,
  attempted_by_user_id uuid references public.platform_users(id) on delete set null,
  contact_method text not null check (contact_method in ('phone', 'email', 'other')),
  result text not null check (result in ('reached', 'no_answer', 'voicemail', 'wrong_number', 'bounced', 'other')),
  attempted_at timestamptz not null,
  private_note text check (private_note is null or char_length(private_note) <= 1000),
  created_at timestamptz not null default now()
);

create index if not exists talent_reference_attempts_check_idx
  on public.talent_reference_attempts (reference_check_id, attempted_at, id);

create table if not exists public.talent_verification_operations (
  operation_request_id uuid not null,
  phase text not null default 'mutation' check (phase in ('mutation', 'calendar_sync')),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  actor_user_id uuid not null references public.platform_users(id) on delete restrict,
  applicant_id uuid not null references public.applicants(id) on delete cascade,
  action text not null check (action in (
    'schedule_interview', 'reschedule_interview', 'cancel_interview', 'record_interview_outcome',
    'retry_calendar_sync', 'save_reference', 'record_reference_attempt',
    'set_reference_outcome', 'remove_reference', 'calendar_sync_result'
  )),
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key (operation_request_id, phase)
);

create index if not exists talent_verification_operations_applicant_idx
  on public.talent_verification_operations (applicant_id, created_at desc);

alter table public.talent_interviews enable row level security;
alter table public.talent_reference_checks enable row level security;
alter table public.talent_reference_attempts enable row level security;
alter table public.talent_verification_operations enable row level security;

revoke all on table public.talent_interviews from public, anon, authenticated;
revoke all on table public.talent_reference_checks from public, anon, authenticated;
revoke all on table public.talent_reference_attempts from public, anon, authenticated;
revoke all on table public.talent_verification_operations from public, anon, authenticated;
grant select, insert, update, delete on table public.talent_interviews to service_role;
grant select, insert, update, delete on table public.talent_reference_checks to service_role;
grant select, insert, update, delete on table public.talent_reference_attempts to service_role;
grant select, insert on table public.talent_verification_operations to service_role;

create or replace function private.talent_verification_gate_json(
  p_applicant_id uuid,
  p_organization_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  with interview_gate as (
    select coalesce(bool_or(
      (interview.status = 'completed' and interview.outcome is not null)
      or (interview.status in ('no_show', 'waived') and nullif(btrim(interview.private_notes), '') is not null)
    ), false) as addressed
    from public.talent_interviews as interview
    where interview.organization_id = p_organization_id
      and interview.applicant_id = p_applicant_id
  ), reference_gate as (
    select
      count(*) > 0
      and bool_and(reference.outcome in ('verified', 'discrepancy', 'unable_to_reach', 'not_provided'))
      as addressed
    from public.talent_reference_checks as reference
    where reference.organization_id = p_organization_id
      and reference.applicant_id = p_applicant_id
  ), gate as (
    select interview_gate.addressed as interview_addressed,
           reference_gate.addressed as references_addressed
    from interview_gate cross join reference_gate
  )
  select jsonb_build_object(
    'interviewAddressed', gate.interview_addressed,
    'referencesAddressed', gate.references_addressed,
    'benchReadyEligible', gate.interview_addressed and gate.references_addressed,
    'blockers', (
      case when gate.interview_addressed then '[]'::jsonb else jsonb_build_array('Interview must be addressed') end
      || case when gate.references_addressed then '[]'::jsonb else jsonb_build_array('Employment references must be addressed') end
    )
  )
  from gate;
$$;

revoke all on function private.talent_verification_gate_json(uuid, uuid) from public, anon, authenticated;

create or replace function private.talent_reference_attempts_audit_json(
  p_organization_id uuid,
  p_reference_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'attemptId', attempt.id,
      'method', attempt.contact_method,
      'result', attempt.result,
      'attemptedAt', attempt.attempted_at,
      'attemptedByUserId', attempt.attempted_by_user_id,
      'note', attempt.private_note
    ) order by attempt.attempted_at, attempt.id
  ), '[]'::jsonb)
  from public.talent_reference_attempts as attempt
  where attempt.organization_id = p_organization_id
    and attempt.reference_check_id = p_reference_id;
$$;

revoke all on function private.talent_reference_attempts_audit_json(uuid, uuid)
  from public, anon, authenticated;

create or replace function private.talent_verification_state_json(
  p_organization_id uuid,
  p_viewer_role public.platform_role,
  p_applicant_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_applicant public.applicants%rowtype;
  v_interview jsonb;
  v_references jsonb;
  v_interviewers jsonb;
begin
  select applicant.* into v_applicant
  from public.applicants as applicant
  where applicant.id = p_applicant_id
    and applicant.organization_id = p_organization_id;

  if v_applicant.id is null then
    raise exception using errcode = '42501', message = 'This Talent application is not available to your account.';
  end if;

  select jsonb_build_object(
    'interviewId', interview.id,
    'status', interview.status,
    'startsAt', interview.starts_at,
    'endsAt', interview.ends_at,
    'timezone', interview.timezone,
    'interviewer', jsonb_build_object(
      'id', interview.interviewer_user_id,
      'name', coalesce(
        nullif(btrim(interview.interviewer_name_snapshot), ''),
        nullif(btrim(interviewer.display_name), ''),
        nullif(btrim(profile.full_name), ''),
        'Unassigned'
      )
    ),
    'outcome', interview.outcome,
    'scorecard', interview.scorecard,
    'notes', interview.private_notes,
    'calendar', jsonb_build_object(
      'status', interview.calendar_sync_status,
      'joinUrl', case when interview.calendar_sync_status = 'synced' then interview.microsoft_join_url else null end
    ),
    'updatedAt', interview.updated_at
  ) into v_interview
  from public.talent_interviews as interview
  left join public.platform_users as interviewer
    on interviewer.id = interview.interviewer_user_id
   and interviewer.organization_id = interview.organization_id
  left join public.employee_profiles as profile
    on profile.user_id = interview.interviewer_user_id
   and profile.organization_id = interview.organization_id
  where interview.organization_id = p_organization_id
    and interview.applicant_id = p_applicant_id;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'referenceId', reference.id,
      'name', reference.reference_name,
      'company', reference.company,
      'relationship', reference.relationship,
      'phone', reference.phone,
      'email', reference.email,
      'outcome', reference.outcome,
      'outcomeNote', reference.outcome_note,
      'attempts', coalesce(attempts.items, '[]'::jsonb),
      'updatedAt', reference.updated_at
    ) order by reference.created_at, reference.id
  ), '[]'::jsonb) into v_references
  from public.talent_reference_checks as reference
  left join lateral (
    select jsonb_agg(
      jsonb_build_object(
        'attemptId', attempt.id,
        'method', attempt.contact_method,
        'result', attempt.result,
        'attemptedAt', attempt.attempted_at,
        'note', attempt.private_note
      ) order by attempt.attempted_at, attempt.id
    ) as items
    from public.talent_reference_attempts as attempt
    where attempt.organization_id = p_organization_id
      and attempt.reference_check_id = reference.id
  ) as attempts on true
  where reference.organization_id = p_organization_id
    and reference.applicant_id = p_applicant_id;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', access.id,
      'name', coalesce(nullif(btrim(access.display_name), ''), profile.full_name)
    ) order by coalesce(nullif(btrim(access.display_name), ''), profile.full_name), access.id
  ), '[]'::jsonb) into v_interviewers
  from public.platform_users as access
  join public.employee_profiles as profile
    on profile.user_id = access.id
   and profile.organization_id = access.organization_id
   and nullif(btrim(profile.email), '') is not null
  where access.organization_id = p_organization_id
    and access.active = true
    and access.must_change_password = false
    and access.role in ('admin'::public.platform_role, 'talent_management'::public.platform_role);

  return jsonb_build_object(
    'generatedAt', pg_catalog.transaction_timestamp(),
    'viewerRole', p_viewer_role::text,
    'applicant', jsonb_build_object(
      'applicantId', v_applicant.id,
      'fullName', v_applicant.full_name,
      'email', v_applicant.email,
      'stage', v_applicant.status::text,
      'updatedAt', v_applicant.updated_at
    ),
    'gate', private.talent_verification_gate_json(v_applicant.id, v_applicant.organization_id),
    'interview', v_interview,
    'interviewers', v_interviewers,
    'references', v_references
  );
end;
$$;

revoke all on function private.talent_verification_state_json(uuid, public.platform_role, uuid)
  from public, anon, authenticated;

create or replace function public.get_talent_verification(
  p_actor_user_id uuid,
  p_applicant_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_actor record;
begin
  select * into v_actor from private.talent_review_actor(p_actor_user_id);
  return private.talent_verification_state_json(v_actor.organization_id, v_actor.role, p_applicant_id);
end;
$$;

revoke all on function public.get_talent_verification(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_talent_verification(uuid, uuid) to service_role;

create or replace function private.talent_calendar_command_json(
  p_organization_id uuid,
  p_applicant_id uuid,
  p_interview_id uuid,
  p_request_id uuid,
  p_action text
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  select jsonb_build_object(
    'action', p_action,
    'transactionId', coalesce(interview.calendar_transaction_id, p_request_id),
    'interviewId', interview.id,
    'expectedUpdatedAt', interview.updated_at,
    'applicantName', applicant.full_name,
    'applicantEmail', applicant.email,
    'interviewerName', coalesce(interview.interviewer_name_snapshot, nullif(btrim(access.display_name), ''), profile.full_name),
    'interviewerEmail', coalesce(interview.interviewer_email_snapshot, profile.email),
    'startsAt', interview.starts_at,
    'endsAt', interview.ends_at,
    'eventId', interview.microsoft_event_id,
    'joinUrl', interview.microsoft_join_url,
    'organizerId', interview.microsoft_organizer_snapshot
  )
  from public.talent_interviews as interview
  join public.applicants as applicant
    on applicant.id = interview.applicant_id
   and applicant.organization_id = interview.organization_id
  left join public.platform_users as access
    on access.id = interview.interviewer_user_id
   and access.organization_id = interview.organization_id
  left join public.employee_profiles as profile
    on profile.user_id = access.id
   and profile.organization_id = access.organization_id
  where interview.id = p_interview_id
    and interview.organization_id = p_organization_id
    and interview.applicant_id = p_applicant_id;
$$;

revoke all on function private.talent_calendar_command_json(uuid, uuid, uuid, uuid, text)
  from public, anon, authenticated;

create or replace function public.mutate_talent_verification(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_applicant_id uuid,
  p_action text,
  p_expected_updated_at timestamptz,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $$
declare
  v_actor record;
  v_applicant public.applicants%rowtype;
  v_action text := lower(btrim(p_action));
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_fingerprint text;
  v_operation public.talent_verification_operations%rowtype;
  v_interview public.talent_interviews%rowtype;
  v_reference public.talent_reference_checks%rowtype;
  v_attempt public.talent_reference_attempts%rowtype;
  v_calendar_action text;
  v_before jsonb;
  v_after jsonb;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_reference_count integer;
  v_interviewer_email text;
  v_interviewer_name text;
begin
  if p_request_id is null or p_applicant_id is null then
    raise exception using errcode = '22023', message = 'Request id and Talent application are required.';
  end if;
  if v_action not in (
    'schedule_interview', 'reschedule_interview', 'cancel_interview', 'record_interview_outcome',
    'retry_calendar_sync', 'save_reference', 'record_reference_attempt',
    'set_reference_outcome', 'remove_reference'
  ) then
    raise exception using errcode = '22023', message = 'Unsupported Talent verification action.';
  end if;
  if jsonb_typeof(v_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'Verification details must be an object.';
  end if;

  select * into v_actor from private.talent_review_actor(p_actor_user_id);
  select applicant.* into v_applicant
  from public.applicants as applicant
  where applicant.id = p_applicant_id
    and applicant.organization_id = v_actor.organization_id
  for update;
  if v_applicant.id is null then
    raise exception using errcode = '42501', message = 'This Talent application is not available to your account.';
  end if;

  v_fingerprint := encode(digest(concat_ws('|', v_action, p_applicant_id::text, coalesce(p_expected_updated_at::text, ''), v_payload::text), 'sha256'), 'hex');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('talent-verification:' || p_request_id::text, 0));
  select * into v_operation from public.talent_verification_operations
  where operation_request_id = p_request_id and phase = 'mutation';
  if v_operation.operation_request_id is not null then
    if v_operation.organization_id is distinct from v_actor.organization_id
      or v_operation.actor_user_id is distinct from p_actor_user_id
      or v_operation.applicant_id is distinct from p_applicant_id
      or v_operation.action <> v_action
      or v_operation.request_fingerprint <> v_fingerprint then
      raise exception using errcode = '22023', message = 'This request id has already been used for another verification action.';
    end if;
    select * into v_interview from public.talent_interviews
    where organization_id = v_actor.organization_id and applicant_id = p_applicant_id;
    return jsonb_build_object(
      'state', private.talent_verification_state_json(v_actor.organization_id, v_actor.role, p_applicant_id),
      'calendarCommand', case
        when v_action in ('schedule_interview', 'reschedule_interview', 'cancel_interview', 'record_interview_outcome', 'retry_calendar_sync')
          and v_interview.id is not null
          and v_interview.calendar_sync_status = 'pending'
          and v_interview.calendar_sync_action is not null
        then private.talent_calendar_command_json(
          v_actor.organization_id, p_applicant_id, v_interview.id, p_request_id, v_interview.calendar_sync_action
        )
        else null
      end
    );
  end if;

  if v_action = 'schedule_interview' then
    if p_expected_updated_at is not null or exists (
      select 1 from public.talent_interviews where organization_id = v_actor.organization_id and applicant_id = p_applicant_id
    ) then
      raise exception using errcode = 'P0001', message = 'An interview record already exists for this Talent application.';
    end if;
    if (v_payload->>'startsAt')::timestamptz is null
      or (v_payload->>'durationMinutes')::integer not between 15 and 240
      or nullif(btrim(v_payload->>'timezone'), '') is null
      or (v_payload->>'interviewerUserId')::uuid is null then
      raise exception using errcode = '22023', message = 'Complete the interview schedule.';
    end if;
    select profile.email, coalesce(nullif(btrim(access.display_name), ''), profile.full_name)
      into v_interviewer_email, v_interviewer_name
    from public.platform_users as access
    join public.employee_profiles as profile on profile.user_id = access.id and profile.organization_id = access.organization_id
    where access.id = (v_payload->>'interviewerUserId')::uuid
      and access.organization_id = v_actor.organization_id
      and access.active = true and access.must_change_password = false
      and access.role in ('admin'::public.platform_role, 'talent_management'::public.platform_role);
    if v_interviewer_email is null or v_interviewer_name is null then
      raise exception using errcode = '42501', message = 'The selected interviewer is not available.';
    end if;
    insert into public.talent_interviews (
      organization_id, applicant_id, interviewer_user_id, interviewer_name_snapshot, interviewer_email_snapshot,
      status, starts_at, ends_at, timezone,
      calendar_sync_status, calendar_sync_action, calendar_transaction_id,
      microsoft_organizer_snapshot, calendar_sync_started_at, updated_at
    ) values (
      v_actor.organization_id, p_applicant_id, (v_payload->>'interviewerUserId')::uuid,
      v_interviewer_name, v_interviewer_email, 'scheduled',
      (v_payload->>'startsAt')::timestamptz,
      (v_payload->>'startsAt')::timestamptz + make_interval(mins => (v_payload->>'durationMinutes')::integer),
      btrim(v_payload->>'timezone'), 'pending', 'create', p_request_id,
      nullif(btrim(v_payload->>'calendarOrganizer'), ''), v_now, v_now
    ) returning * into v_interview;
    v_calendar_action := 'create';
    v_before := null;
    v_after := jsonb_build_object('interviewId', v_interview.id, 'status', v_interview.status, 'startsAt', v_interview.starts_at, 'endsAt', v_interview.ends_at, 'interviewerId', v_interview.interviewer_user_id);

  elsif v_action in ('reschedule_interview', 'cancel_interview', 'record_interview_outcome', 'retry_calendar_sync') then
    select * into v_interview from public.talent_interviews
    where id = (v_payload->>'interviewId')::uuid
      and organization_id = v_actor.organization_id
      and applicant_id = p_applicant_id
    for update;
    if v_interview.id is null then
      raise exception using errcode = '42501', message = 'This interview is not available to your account.';
    end if;
    if p_expected_updated_at is null or v_interview.updated_at is distinct from p_expected_updated_at then
      raise exception using errcode = 'P0001', message = 'This verification changed after it was opened.';
    end if;
    if v_interview.calendar_sync_status = 'pending' and v_action <> 'retry_calendar_sync' then
      raise exception using errcode = 'P0001', message = 'Wait for the current calendar synchronization to finish.';
    end if;
    if v_action in ('reschedule_interview', 'cancel_interview', 'record_interview_outcome')
      and v_interview.calendar_sync_status = 'sync_failed'
      and v_interview.calendar_sync_action = 'create'
      and v_interview.microsoft_event_id is null then
      raise exception using errcode = 'P0001', message = 'Retry the calendar synchronization before changing this interview.';
    end if;
    v_before := jsonb_build_object('interviewId', v_interview.id, 'status', v_interview.status, 'startsAt', v_interview.starts_at, 'endsAt', v_interview.ends_at, 'outcome', v_interview.outcome, 'calendarStatus', v_interview.calendar_sync_status);

    if v_action = 'reschedule_interview' then
      if v_interview.status not in ('scheduled', 'cancelled') then
        raise exception using errcode = 'P0001', message = 'Only a scheduled or cancelled interview can be rescheduled.';
      end if;
      if v_interview.status = 'cancelled'
        and v_interview.microsoft_event_id is not null
        and v_interview.calendar_sync_status <> 'not_applicable' then
        raise exception using errcode = 'P0001', message = 'Finish cancelling the previous calendar event before rebooking.';
      end if;
      select profile.email, coalesce(nullif(btrim(access.display_name), ''), profile.full_name)
        into v_interviewer_email, v_interviewer_name
      from public.platform_users as access
      join public.employee_profiles as profile on profile.user_id = access.id and profile.organization_id = access.organization_id
      where access.id = (v_payload->>'interviewerUserId')::uuid
        and access.organization_id = v_actor.organization_id
        and access.active = true and access.must_change_password = false
        and access.role in ('admin'::public.platform_role, 'talent_management'::public.platform_role);
      if v_interviewer_email is null or v_interviewer_name is null then
        raise exception using errcode = '42501', message = 'The selected interviewer is not available.';
      end if;
      update public.talent_interviews set
        status = 'scheduled',
        interviewer_user_id = (v_payload->>'interviewerUserId')::uuid,
        interviewer_name_snapshot = v_interviewer_name,
        interviewer_email_snapshot = v_interviewer_email,
        starts_at = (v_payload->>'startsAt')::timestamptz,
        ends_at = (v_payload->>'startsAt')::timestamptz + make_interval(mins => (v_payload->>'durationMinutes')::integer),
        timezone = btrim(v_payload->>'timezone'),
        outcome = null,
        scorecard = null,
        private_notes = null,
        calendar_sync_status = 'pending',
        calendar_sync_action = case when v_interview.status = 'cancelled' or microsoft_event_id is null then 'create' else 'update' end,
        calendar_transaction_id = case when v_interview.status = 'cancelled' then p_request_id else calendar_transaction_id end,
        microsoft_event_id = case when v_interview.status = 'cancelled' then null else microsoft_event_id end,
        microsoft_join_url = case when v_interview.status = 'cancelled' then null else microsoft_join_url end,
        microsoft_organizer_snapshot = case
          when v_interview.status = 'cancelled' or microsoft_event_id is null
            then nullif(btrim(v_payload->>'calendarOrganizer'), '')
          else microsoft_organizer_snapshot
        end,
        microsoft_last_error_code = null,
        calendar_sync_started_at = v_now,
        updated_at = v_now
      where id = v_interview.id returning * into v_interview;
      v_calendar_action := v_interview.calendar_sync_action;

    elsif v_action = 'cancel_interview' then
      if v_interview.status <> 'scheduled' or nullif(btrim(v_payload->>'note'), '') is null then
        raise exception using errcode = 'P0001', message = 'Only a scheduled interview can be cancelled with a note.';
      end if;
      update public.talent_interviews set
        status = 'cancelled', private_notes = btrim(v_payload->>'note'),
        calendar_sync_status = case when microsoft_event_id is null then 'not_applicable' else 'pending' end,
        calendar_sync_action = case when microsoft_event_id is null then null else 'cancel' end,
        microsoft_last_error_code = null,
        calendar_sync_started_at = case when microsoft_event_id is null then null else v_now end,
        updated_at = v_now
      where id = v_interview.id returning * into v_interview;
      v_calendar_action := v_interview.calendar_sync_action;

    elsif v_action = 'record_interview_outcome' then
      if v_interview.status not in ('scheduled', 'completed', 'no_show', 'waived') then
        raise exception using errcode = 'P0001', message = 'This interview cannot record an outcome.';
      end if;
      if v_payload->>'status' not in ('completed', 'no_show', 'waived')
        or nullif(btrim(v_payload->>'note'), '') is null then
        raise exception using errcode = '22023', message = 'Choose an interview result and add a note.';
      end if;
      if v_payload->>'status' = 'completed' and v_payload->>'outcome' not in ('recommended', 'follow_up', 'not_recommended') then
        raise exception using errcode = '22023', message = 'A completed interview needs an outcome.';
      end if;
      update public.talent_interviews set
        status = v_payload->>'status',
        outcome = case when v_payload->>'status' = 'completed' then v_payload->>'outcome' else null end,
        scorecard = case when v_payload->>'status' = 'completed' then v_payload->'scorecard' else null end,
        private_notes = btrim(v_payload->>'note'),
        calendar_sync_status = case
          when v_payload->>'status' in ('no_show', 'waived') and microsoft_event_id is not null then 'pending'
          when v_payload->>'status' in ('no_show', 'waived') then 'not_applicable'
          else calendar_sync_status
        end,
        calendar_sync_action = case
          when v_payload->>'status' in ('no_show', 'waived') and microsoft_event_id is not null then 'cancel'
          when v_payload->>'status' in ('no_show', 'waived') then null
          else calendar_sync_action
        end,
        calendar_sync_started_at = case
          when v_payload->>'status' in ('no_show', 'waived') and microsoft_event_id is not null then v_now
          when v_payload->>'status' in ('no_show', 'waived') then null
          else calendar_sync_started_at
        end,
        updated_at = v_now
      where id = v_interview.id returning * into v_interview;
      v_calendar_action := case when v_payload->>'status' in ('no_show', 'waived') then v_interview.calendar_sync_action else null end;

    else
      if v_interview.calendar_sync_status = 'pending'
        and v_interview.calendar_sync_started_at is not null
        and v_interview.calendar_sync_started_at > v_now - interval '90 seconds' then
        raise exception using errcode = 'P0001', message = 'The calendar synchronization is still running. Try again shortly.';
      end if;
      if not (
        (
          v_interview.status = 'scheduled'
          and v_interview.calendar_sync_status in ('connection_required', 'pending', 'sync_failed')
        )
        or (
          v_interview.status in ('cancelled', 'no_show', 'waived')
          and v_interview.calendar_sync_action = 'cancel'
          and v_interview.calendar_sync_status in ('connection_required', 'pending', 'sync_failed')
        )
      ) then
        raise exception using errcode = 'P0001', message = 'This calendar event does not need to be retried.';
      end if;
      update public.talent_interviews set
        calendar_sync_status = 'pending',
        calendar_sync_action = case
          when calendar_sync_action = 'cancel' then 'cancel'
          when microsoft_event_id is null then 'create'
          else 'update'
        end,
        microsoft_last_error_code = null,
        microsoft_organizer_snapshot = coalesce(
          microsoft_organizer_snapshot,
          nullif(btrim(v_payload->>'calendarOrganizer'), '')
        ),
        calendar_sync_started_at = v_now,
        updated_at = v_now
      where id = v_interview.id returning * into v_interview;
      v_calendar_action := v_interview.calendar_sync_action;
    end if;
    v_after := jsonb_build_object('interviewId', v_interview.id, 'status', v_interview.status, 'startsAt', v_interview.starts_at, 'endsAt', v_interview.ends_at, 'outcome', v_interview.outcome, 'calendarStatus', v_interview.calendar_sync_status);

  elsif v_action = 'save_reference' then
    if v_payload->>'referenceId' is null then
      if v_applicant.status = 'bench_ready'::public.applicant_status then
        raise exception using errcode = 'P0001', message = 'Return this Talent to review before adding another employment reference.';
      end if;
      if p_expected_updated_at is not null then
        raise exception using errcode = '22023', message = 'A new reference cannot include an existing update time.';
      end if;
      select count(*) into v_reference_count from public.talent_reference_checks
      where organization_id = v_actor.organization_id and applicant_id = p_applicant_id;
      if v_reference_count >= 20 then
        raise exception using errcode = 'P0001', message = 'No more than 20 references can be recorded for one Talent application.';
      end if;
      insert into public.talent_reference_checks (
        organization_id, applicant_id, reference_name, company, relationship, phone, email, updated_at
      ) values (
        v_actor.organization_id, p_applicant_id, btrim(v_payload->>'name'), nullif(btrim(v_payload->>'company'), ''),
        nullif(btrim(v_payload->>'relationship'), ''), nullif(btrim(v_payload->>'phone'), ''),
        nullif(lower(btrim(v_payload->>'email')), ''), v_now
      ) returning * into v_reference;
      v_before := null;
      v_reference_count := 0;
    else
      select * into v_reference from public.talent_reference_checks
      where id = (v_payload->>'referenceId')::uuid
        and organization_id = v_actor.organization_id and applicant_id = p_applicant_id
      for update;
      if v_reference.id is null then
        raise exception using errcode = '42501', message = 'This reference is not available to your account.';
      end if;
      if p_expected_updated_at is null or v_reference.updated_at is distinct from p_expected_updated_at then
        raise exception using errcode = 'P0001', message = 'This verification changed after it was opened.';
      end if;
      select count(*) into v_reference_count from public.talent_reference_attempts
      where organization_id = v_actor.organization_id and reference_check_id = v_reference.id;
      v_before := jsonb_build_object(
        'referenceId', v_reference.id, 'name', v_reference.reference_name, 'company', v_reference.company,
        'relationship', v_reference.relationship, 'phone', v_reference.phone, 'email', v_reference.email,
        'outcome', v_reference.outcome, 'outcomeNote', v_reference.outcome_note, 'attemptCount', v_reference_count,
        'attempts', private.talent_reference_attempts_audit_json(v_actor.organization_id, v_reference.id)
      );
      if v_applicant.status = 'bench_ready'::public.applicant_status and (
        v_reference.reference_name is distinct from btrim(v_payload->>'name')
        or v_reference.company is distinct from nullif(btrim(v_payload->>'company'), '')
        or v_reference.relationship is distinct from nullif(btrim(v_payload->>'relationship'), '')
        or v_reference.phone is distinct from nullif(btrim(v_payload->>'phone'), '')
        or v_reference.email is distinct from nullif(lower(btrim(v_payload->>'email')), '')
      ) then
        raise exception using errcode = 'P0001', message = 'Return this Talent to review before changing a verified employment reference.';
      end if;
      if v_reference.reference_name is distinct from btrim(v_payload->>'name')
        or v_reference.company is distinct from nullif(btrim(v_payload->>'company'), '')
        or v_reference.relationship is distinct from nullif(btrim(v_payload->>'relationship'), '')
        or v_reference.phone is distinct from nullif(btrim(v_payload->>'phone'), '')
        or v_reference.email is distinct from nullif(lower(btrim(v_payload->>'email')), '') then
        delete from public.talent_reference_attempts where reference_check_id = v_reference.id;
      end if;
      update public.talent_reference_checks set
        reference_name = btrim(v_payload->>'name'), company = nullif(btrim(v_payload->>'company'), ''),
        relationship = nullif(btrim(v_payload->>'relationship'), ''), phone = nullif(btrim(v_payload->>'phone'), ''),
        email = nullif(lower(btrim(v_payload->>'email')), ''),
        outcome = case when
          reference_name is distinct from btrim(v_payload->>'name')
          or company is distinct from nullif(btrim(v_payload->>'company'), '')
          or relationship is distinct from nullif(btrim(v_payload->>'relationship'), '')
          or phone is distinct from nullif(btrim(v_payload->>'phone'), '')
          or email is distinct from nullif(lower(btrim(v_payload->>'email')), '')
          then 'pending' else outcome end,
        outcome_note = case when
          reference_name is distinct from btrim(v_payload->>'name')
          or company is distinct from nullif(btrim(v_payload->>'company'), '')
          or relationship is distinct from nullif(btrim(v_payload->>'relationship'), '')
          or phone is distinct from nullif(btrim(v_payload->>'phone'), '')
          or email is distinct from nullif(lower(btrim(v_payload->>'email')), '')
          then null else outcome_note end,
        updated_at = v_now
      where id = v_reference.id returning * into v_reference;
      select count(*) into v_reference_count from public.talent_reference_attempts
      where organization_id = v_actor.organization_id and reference_check_id = v_reference.id;
    end if;
    v_after := jsonb_build_object(
      'referenceId', v_reference.id, 'name', v_reference.reference_name, 'company', v_reference.company,
      'relationship', v_reference.relationship, 'phone', v_reference.phone, 'email', v_reference.email,
      'outcome', v_reference.outcome, 'outcomeNote', v_reference.outcome_note,
      'attemptCount', coalesce(v_reference_count, 0),
      'attempts', private.talent_reference_attempts_audit_json(v_actor.organization_id, v_reference.id)
    );

  else
    select * into v_reference from public.talent_reference_checks
    where id = (v_payload->>'referenceId')::uuid
      and organization_id = v_actor.organization_id and applicant_id = p_applicant_id
    for update;
    if v_reference.id is null then
      raise exception using errcode = '42501', message = 'This reference is not available to your account.';
    end if;
    if p_expected_updated_at is null or v_reference.updated_at is distinct from p_expected_updated_at then
      raise exception using errcode = 'P0001', message = 'This verification changed after it was opened.';
    end if;
    select count(*) into v_reference_count from public.talent_reference_attempts
    where organization_id = v_actor.organization_id and reference_check_id = v_reference.id;
    v_before := jsonb_build_object(
      'referenceId', v_reference.id, 'name', v_reference.reference_name, 'company', v_reference.company,
      'relationship', v_reference.relationship, 'phone', v_reference.phone, 'email', v_reference.email,
      'outcome', v_reference.outcome, 'outcomeNote', v_reference.outcome_note, 'attemptCount', v_reference_count,
      'attempts', private.talent_reference_attempts_audit_json(v_actor.organization_id, v_reference.id)
    );

    if v_action = 'record_reference_attempt' then
      select count(*) into v_reference_count from public.talent_reference_attempts
      where organization_id = v_actor.organization_id and reference_check_id = v_reference.id;
      if v_reference_count >= 50 then
        raise exception using errcode = 'P0001', message = 'No more than 50 attempts can be recorded for one reference.';
      end if;
      insert into public.talent_reference_attempts (
        organization_id, reference_check_id, attempted_by_user_id, contact_method, result, attempted_at, private_note
      ) values (
        v_actor.organization_id, v_reference.id, p_actor_user_id, v_payload->>'method', v_payload->>'result',
        (v_payload->>'attemptedAt')::timestamptz, nullif(btrim(v_payload->>'note'), '')
      ) returning * into v_attempt;
      update public.talent_reference_checks set updated_at = v_now where id = v_reference.id returning * into v_reference;
      v_after := jsonb_build_object(
        'referenceId', v_reference.id, 'name', v_reference.reference_name, 'company', v_reference.company,
        'relationship', v_reference.relationship, 'phone', v_reference.phone, 'email', v_reference.email,
        'outcome', v_reference.outcome, 'outcomeNote', v_reference.outcome_note,
        'attemptCount', v_reference_count + 1, 'attemptId', v_attempt.id,
        'attempts', private.talent_reference_attempts_audit_json(v_actor.organization_id, v_reference.id)
      );

    elsif v_action = 'set_reference_outcome' then
      if v_payload->>'outcome' not in ('verified', 'discrepancy', 'unable_to_reach', 'not_provided') then
        raise exception using errcode = '22023', message = 'Choose a final reference outcome.';
      end if;
      if v_payload->>'outcome' in ('discrepancy', 'unable_to_reach', 'not_provided')
        and nullif(btrim(v_payload->>'note'), '') is null then
        raise exception using errcode = '22023', message = 'This reference outcome requires a note.';
      end if;
      if v_payload->>'outcome' = 'unable_to_reach' then
        select count(*) into v_reference_count from public.talent_reference_attempts
        where organization_id = v_actor.organization_id and reference_check_id = v_reference.id;
        if v_reference_count < 2 then
          raise exception using errcode = 'P0001', message = 'Unable to reach requires at least two contact attempts and a note.';
        end if;
      end if;
      update public.talent_reference_checks set
        outcome = v_payload->>'outcome', outcome_note = nullif(btrim(v_payload->>'note'), ''), updated_at = v_now
      where id = v_reference.id returning * into v_reference;
      v_after := jsonb_build_object(
        'referenceId', v_reference.id, 'name', v_reference.reference_name, 'company', v_reference.company,
        'relationship', v_reference.relationship, 'phone', v_reference.phone, 'email', v_reference.email,
        'outcome', v_reference.outcome, 'outcomeNote', v_reference.outcome_note, 'attemptCount', v_reference_count,
        'attempts', private.talent_reference_attempts_audit_json(v_actor.organization_id, v_reference.id)
      );

    elsif v_action = 'remove_reference' then
      if v_applicant.status = 'bench_ready'::public.applicant_status then
        raise exception using errcode = 'P0001', message = 'Return this Talent to review before removing an employment reference.';
      end if;
      delete from public.talent_reference_checks where id = v_reference.id;
      v_after := null;
    end if;
  end if;

  insert into public.talent_verification_operations (
    operation_request_id, phase, organization_id, actor_user_id, applicant_id, action, request_fingerprint
  ) values (p_request_id, 'mutation', v_actor.organization_id, p_actor_user_id, p_applicant_id, v_action, v_fingerprint);

  insert into public.audit_events (
    organization_id, actor_user_id, entity_type, entity_id, event_type, before_value, after_value, note
  ) values (
    v_actor.organization_id, p_actor_user_id, 'talent_verification', p_applicant_id, v_action,
    v_before, v_after,
    case when v_action in ('cancel_interview', 'record_interview_outcome', 'set_reference_outcome') then nullif(btrim(v_payload->>'note'), '') else null end
  );

  return jsonb_build_object(
    'state', private.talent_verification_state_json(v_actor.organization_id, v_actor.role, p_applicant_id),
    'calendarCommand', case when v_calendar_action is null then null else
      private.talent_calendar_command_json(
        v_actor.organization_id, p_applicant_id, v_interview.id, p_request_id, v_calendar_action
      )
    end
  );
end;
$$;

revoke all on function public.mutate_talent_verification(uuid, uuid, uuid, text, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function public.mutate_talent_verification(uuid, uuid, uuid, text, timestamptz, jsonb)
  to service_role;

create or replace function public.record_talent_interview_calendar_sync(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_applicant_id uuid,
  p_interview_id uuid,
  p_expected_updated_at timestamptz,
  p_sync_status text,
  p_microsoft_event_id text,
  p_microsoft_join_url text,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $$
declare
  v_actor record;
  v_interview public.talent_interviews%rowtype;
  v_operation public.talent_verification_operations%rowtype;
  v_fingerprint text;
begin
  if p_request_id is null or p_applicant_id is null or p_interview_id is null or p_expected_updated_at is null
    or p_sync_status not in ('connection_required', 'synced', 'sync_failed', 'not_applicable') then
    raise exception using errcode = '22023', message = 'The calendar sync result is invalid.';
  end if;
  if p_sync_status = 'synced' and p_microsoft_event_id is null then
    raise exception using errcode = '22023', message = 'A synchronized calendar event requires an event id.';
  end if;
  select * into v_actor from private.talent_review_actor(p_actor_user_id);
  v_fingerprint := encode(digest(concat_ws('|', 'calendar_sync_result', p_applicant_id, p_interview_id, p_expected_updated_at, p_sync_status, coalesce(p_microsoft_event_id, ''), coalesce(p_microsoft_join_url, ''), coalesce(p_error_code, '')), 'sha256'), 'hex');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('talent-verification-sync:' || p_request_id::text, 0));
  select * into v_operation from public.talent_verification_operations
  where operation_request_id = p_request_id and phase = 'calendar_sync';
  if v_operation.operation_request_id is not null then
    if v_operation.organization_id is distinct from v_actor.organization_id
      or v_operation.actor_user_id is distinct from p_actor_user_id
      or v_operation.applicant_id is distinct from p_applicant_id
      or v_operation.request_fingerprint <> v_fingerprint then
      raise exception using errcode = '22023', message = 'This request id has already recorded another calendar result.';
    end if;
    return private.talent_verification_state_json(v_actor.organization_id, v_actor.role, p_applicant_id);
  end if;
  select * into v_interview from public.talent_interviews
  where id = p_interview_id and organization_id = v_actor.organization_id and applicant_id = p_applicant_id
  for update;
  if v_interview.id is null then
    raise exception using errcode = '42501', message = 'This interview is not available to your account.';
  end if;
  if v_interview.updated_at is distinct from p_expected_updated_at then
    raise exception using errcode = 'P0001', message = 'This verification changed after it was opened.';
  end if;
  update public.talent_interviews set
    calendar_sync_status = p_sync_status,
    calendar_sync_action = case when p_sync_status in ('synced', 'not_applicable') then null else calendar_sync_action end,
    microsoft_event_id = coalesce(p_microsoft_event_id, microsoft_event_id),
    microsoft_join_url = case when p_sync_status = 'not_applicable' then null else coalesce(p_microsoft_join_url, microsoft_join_url) end,
    microsoft_last_error_code = case when p_sync_status = 'sync_failed' then coalesce(p_error_code, 'graph_sync_failed') else null end,
    calendar_sync_started_at = null,
    updated_at = pg_catalog.clock_timestamp()
  where id = v_interview.id;
  insert into public.talent_verification_operations (
    operation_request_id, phase, organization_id, actor_user_id, applicant_id, action, request_fingerprint
  ) values (p_request_id, 'calendar_sync', v_actor.organization_id, p_actor_user_id, p_applicant_id, 'calendar_sync_result', v_fingerprint);
  insert into public.audit_events (
    organization_id, actor_user_id, entity_type, entity_id, event_type, before_value, after_value
  ) values (
    v_actor.organization_id, p_actor_user_id, 'talent_verification', p_applicant_id, 'calendar_sync_result',
    jsonb_build_object('status', v_interview.calendar_sync_status), jsonb_build_object('status', p_sync_status)
  );
  return private.talent_verification_state_json(v_actor.organization_id, v_actor.role, p_applicant_id);
end;
$$;

revoke all on function public.record_talent_interview_calendar_sync(uuid, uuid, uuid, uuid, timestamptz, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.record_talent_interview_calendar_sync(uuid, uuid, uuid, uuid, timestamptz, text, text, text, text)
  to service_role;

create or replace function private.enforce_talent_verification_bench_gate()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_gate jsonb;
  v_requires_gate boolean := false;
begin
  if new.status = 'bench_ready'::public.applicant_status then
    if tg_op = 'INSERT' then
      v_requires_gate := true;
    elsif old.status is distinct from 'bench_ready'::public.applicant_status
      or old.organization_id is distinct from new.organization_id then
      v_requires_gate := true;
    end if;
  end if;
  if v_requires_gate then
    v_gate := private.talent_verification_gate_json(new.id, new.organization_id);
    if coalesce((v_gate->>'benchReadyEligible')::boolean, false) is not true then
      raise exception using errcode = 'P0001', message = 'Interview and employment references must be addressed before Bench Ready.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_talent_verification_bench_gate on public.applicants;
create trigger enforce_talent_verification_bench_gate
before insert or update on public.applicants
for each row execute function private.enforce_talent_verification_bench_gate();

drop policy if exists "authorized internal users can read audit history" on public.audit_events;
create policy "authorized internal users can read audit history"
on public.audit_events for select to authenticated
using (
  private.is_internal_soro_user()
  and organization_id = private.current_soro_organization_id()
  and case
    when entity_type = 'employee_payroll' then private.current_soro_role() = 'admin'::public.platform_role
    when entity_type = 'employee' and event_type = 'employee_payment_route_update' then private.current_soro_role() = 'admin'::public.platform_role
    when entity_type in (
      'talent_payout', 'talent_portal_access', 'talent_attendance', 'talent_time_off',
      'talent_review_queue', 'talent_verification'
    ) then private.current_soro_role() in ('admin'::public.platform_role, 'talent_management'::public.platform_role)
    else true
  end
);

comment on table public.talent_interviews is
  'Soro-owned internal interview record with optional calendar synchronization metadata; private notes never sync to Microsoft.';
comment on table public.talent_reference_checks is
  'Private organization-scoped employment-reference verification records.';
comment on function public.get_talent_verification(uuid, uuid) is
  'Service-only Admin/Talent Management verification workspace scoped from the authenticated actor.';
comment on function public.mutate_talent_verification(uuid, uuid, uuid, text, timestamptz, jsonb) is
  'Service-only idempotent and audited Talent verification mutation with optimistic concurrency.';
