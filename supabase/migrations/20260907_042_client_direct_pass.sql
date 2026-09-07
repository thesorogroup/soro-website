-- Forward-only direct pass: retain migration 037's transaction, locks,
-- idempotency, calendar guards, audit and one-active-process restriction.
begin;
create or replace function public.change_client_placement_workflow(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_hiring_request_id uuid,
  p_action text,
  p_expected_updated_at timestamptz,
  p_entity_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $$
declare
  v_actor record;
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_fingerprint text;
  v_existing public.client_placement_operations%rowtype;
  v_request public.hiring_requests%rowtype;
  v_client public.clients%rowtype;
  v_shortlist public.client_shortlists%rowtype;
  v_item public.client_shortlist_items%rowtype;
  v_applicant public.applicants%rowtype;
  v_interview public.client_candidate_interviews%rowtype;
  v_decision public.client_candidate_decisions%rowtype;
  v_handoff public.client_placement_handoffs%rowtype;
  v_placement public.placements%rowtype;
  v_onboarding public.placement_onboarding_items%rowtype;
  v_contact public.client_contacts%rowtype;
  v_owner public.platform_users%rowtype;
  v_owner_profile public.employee_profiles%rowtype;
  v_calendar_action text;
  v_calendar_command jsonb;
  v_round integer;
  v_status text;
  v_outcome text;
  v_decision_value text;
  v_duration integer;
  v_starts_at timestamptz;
  v_ends_at timestamptz;
  v_timezone text;
  v_note text;
  v_organizer text;
  v_contact_email text;
  v_filled integer;
  v_current_count integer;
  v_release record;
  v_before jsonb;
  v_after jsonb;
  v_state jsonb;
begin
  if p_request_id is null or p_hiring_request_id is null or p_entity_id is null then
    raise exception using errcode = '22023', message = 'A request, hiring request, and workflow record are required.';
  end if;
  if p_expected_updated_at is null then
    raise exception using errcode = '22023', message = 'The current record update time is required.';
  end if;
  if jsonb_typeof(v_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'Workflow details must be a JSON object.';
  end if;
  if v_action not in (
    'schedule_interview', 'reschedule_interview', 'cancel_interview',
    'record_interview_outcome', 'retry_calendar_sync', 'final_decision',
    'prepare_handoff', 'confirm_placement', 'update_onboarding', 'activate_placement'
  ) then
    raise exception using errcode = '22023', message = 'Choose a supported Client placement action.';
  end if;

  select * into v_actor from private.client_placement_actor(p_actor_user_id);
  v_fingerprint := encode(
    digest(
      convert_to(concat_ws(
        '|', v_action, p_hiring_request_id::text, p_entity_id::text,
        p_expected_updated_at::text, v_payload::text
      ), 'utf8'),
      'sha256'
    ),
    'hex'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('client-placement-operation:' || p_request_id::text, 0)
  );
  select operation.* into v_existing
  from public.client_placement_operations as operation
  where operation.operation_request_id = p_request_id
    and operation.phase = 'mutation';
  if v_existing.operation_request_id is not null then
    if v_existing.organization_id is distinct from v_actor.organization_id
      or v_existing.actor_user_id is distinct from v_actor.user_id
      or v_existing.action is distinct from v_action
      or v_existing.hiring_request_id is distinct from p_hiring_request_id
      or v_existing.request_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = '23505', message = 'This request id has already been used for another placement action.';
    end if;
    v_state := private.client_placement_workspace_json(
      v_actor.organization_id, v_actor.role, v_actor.user_id,
      v_actor.client_id, p_hiring_request_id
    );
    if v_state is null then
      raise exception using errcode = '42501', message = 'This hiring request is not available to your account.';
    end if;
    if v_existing.interview_id is not null then
      select * into v_interview
      from public.client_candidate_interviews
      where id = v_existing.interview_id
        and organization_id = v_actor.organization_id;
      if v_interview.id is not null
        and v_interview.calendar_sync_status = 'pending'
        and v_interview.calendar_sync_action is not null then
        v_calendar_command := private.client_interview_calendar_command_json(
          v_actor.organization_id, v_interview.id, p_request_id,
          v_interview.calendar_sync_action
        );
      end if;
    end if;
    return jsonb_build_object('state', v_state, 'calendarCommand', v_calendar_command);
  end if;

  -- Reuse the shortlist lock namespace so shortlist responses, final decisions,
  -- and placement confirmation cannot race one another.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('client-shortlist-request:' || p_hiring_request_id::text, 0)
  );
  select request.* into v_request
  from public.hiring_requests as request
  where request.id = p_hiring_request_id
    and request.organization_id = v_actor.organization_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'This hiring request is not available to your account.';
  end if;
  select client.* into v_client
  from public.clients as client
  where client.id = v_request.client_id
    and client.organization_id = v_actor.organization_id
    and client.archived_at is null
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'This Client is not available to your account.';
  end if;
  if v_actor.role = 'sales'::public.platform_role and v_client.sales_owner_id is distinct from v_actor.user_id then
    raise exception using errcode = '42501', message = 'Sales may only manage their assigned Clients.';
  end if;
  if v_actor.role in ('client_admin'::public.platform_role, 'client_reviewer'::public.platform_role)
    and v_client.id is distinct from v_actor.client_id then
    raise exception using errcode = '42501', message = 'This hiring request does not belong to your Client account.';
  end if;

  if v_action = 'schedule_interview' then
    if v_actor.role not in (
      'admin'::public.platform_role,
      'sales_management'::public.platform_role,
      'sales'::public.platform_role
    ) then
      raise exception using errcode = '42501', message = 'Only assigned Sales or an Administrator may schedule a Client interview.';
    end if;
    if v_request.status not in ('client_review', 'interviewing', 'partially_filled') then
      raise exception using errcode = 'P0001', message = 'This hiring request is not accepting Client interviews.';
    end if;
    if exists (select 1 from jsonb_object_keys(v_payload) as key where key not in (
      'startsAt', 'durationMinutes', 'timezone', 'calendarOrganizer'
    )) or not (v_payload ? 'startsAt' and v_payload ? 'durationMinutes' and v_payload ? 'timezone') then
      raise exception using errcode = '22023', message = 'Client interview scheduling details are invalid.';
    end if;
    v_starts_at := nullif(v_payload ->> 'startsAt', '')::timestamptz;
    v_duration := nullif(v_payload ->> 'durationMinutes', '')::integer;
    v_timezone := nullif(btrim(coalesce(v_payload ->> 'timezone', '')), '');
    v_organizer := nullif(btrim(coalesce(v_payload ->> 'calendarOrganizer', '')), '');
    if v_starts_at is null or v_starts_at <= pg_catalog.clock_timestamp() + interval '1 minute'
      or v_duration is null or v_duration < 15 or v_duration > 240 or mod(v_duration, 5) <> 0
      or v_timezone is null or char_length(v_timezone) > 100
      or (v_organizer is not null and char_length(v_organizer) > 1024) then
      raise exception using errcode = '22023', message = 'Choose a valid future interview time, duration, and time zone.';
    end if;
    v_ends_at := v_starts_at + make_interval(mins => v_duration);

    select item.* into v_item
    from public.client_shortlist_items as item
    join public.client_shortlists as shortlist
      on shortlist.id = item.shortlist_id
     and shortlist.organization_id = item.organization_id
    where item.id = p_entity_id
      and item.organization_id = v_actor.organization_id
      and item.removed_at is null
      and item.workflow_state = 'active'
      and item.client_response = 'request_interview'
      and shortlist.hiring_request_id = v_request.id
      and shortlist.client_id = v_client.id
      and shortlist.status = 'sent'
    for update of item;
    if not found then
      raise exception using errcode = 'P0001', message = 'This candidate is not awaiting a Client interview.';
    end if;
    if v_item.updated_at is distinct from p_expected_updated_at then
      raise exception using errcode = 'P0001', message = 'This shortlisted candidate changed after it was opened.';
    end if;
    select shortlist.* into v_shortlist
    from public.client_shortlists as shortlist
    where shortlist.id = v_item.shortlist_id
      and shortlist.organization_id = v_actor.organization_id;
    if exists (
      select 1 from public.client_candidate_decisions as decision
      where decision.shortlist_item_id = v_item.id
        and decision.organization_id = v_actor.organization_id
    ) then
      raise exception using errcode = 'P0001', message = 'A final decision has already been recorded for this candidate.';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('client-shortlist-applicant:' || v_item.applicant_id::text, 0)
    );
    select applicant.* into v_applicant
    from public.applicants as applicant
    where applicant.id = v_item.applicant_id
      and applicant.organization_id = v_actor.organization_id
      and applicant.archived_at is null
      and applicant.sales_owner_id = v_client.sales_owner_id
      and applicant.status in ('interviewing'::public.applicant_status, 'client_review'::public.applicant_status)
    for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'This candidate is no longer available for a Client interview.';
    end if;

    select owner.* into v_owner
    from public.platform_users as owner
    where owner.id = v_client.sales_owner_id
      and owner.organization_id = v_actor.organization_id
      and owner.active = true
      and owner.must_change_password = false
      and owner.role = 'sales'::public.platform_role;
    if not found then
      raise exception using errcode = 'P0001', message = 'The Client needs an active Sales owner before scheduling.';
    end if;
    select profile.* into v_owner_profile
    from public.employee_profiles as profile
    where profile.user_id = v_owner.id
      and profile.organization_id = v_actor.organization_id;
    if not found then
      raise exception using errcode = 'P0001', message = 'The Sales owner needs a complete employee profile before scheduling.';
    end if;

    select contact.* into v_contact
    from public.client_contacts as contact
    join public.client_portal_memberships as membership
      on membership.client_contact_id = contact.id
     and membership.client_id = contact.client_id
     and membership.organization_id = contact.organization_id
     and membership.active = true
    join public.platform_users as client_access
      on client_access.id = membership.user_id
     and client_access.organization_id = membership.organization_id
     and client_access.active = true
     and client_access.must_change_password = false
     and client_access.role in ('client_admin'::public.platform_role, 'client_reviewer'::public.platform_role)
    where contact.organization_id = v_actor.organization_id
      and contact.client_id = v_client.id
      and contact.active = true
      and contact.portal_access_status = 'active'
      and nullif(btrim(contact.portal_login_email), '') is not null
    order by (client_access.role = 'client_admin'::public.platform_role) desc,
      contact.created_at, contact.id
    limit 1;
    if not found then
      raise exception using errcode = 'P0001', message = 'The Client needs an active Client Administrator or Reviewer portal account before scheduling.';
    end if;
    v_contact_email := nullif(btrim(v_contact.portal_login_email), '');
    if lower(btrim(v_applicant.email)) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      or lower(btrim(v_contact_email)) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      or lower(btrim(v_owner_profile.email)) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
      raise exception using errcode = 'P0001', message = 'Talent, Client, and Sales owner email addresses must be valid before scheduling.';
    end if;

    select coalesce(max(interview.round_number), 0) + 1 into v_round
    from public.client_candidate_interviews as interview
    where interview.organization_id = v_actor.organization_id
      and interview.hiring_request_id = v_request.id
      and interview.applicant_id = v_applicant.id;

    insert into public.client_candidate_interviews (
      organization_id, client_id, hiring_request_id, shortlist_id,
      shortlist_item_id, applicant_id, sales_owner_id, client_contact_id,
      round_number, starts_at, ends_at, timezone,
      applicant_name_snapshot, applicant_email_snapshot,
      client_contact_name_snapshot, client_contact_email_snapshot,
      sales_owner_name_snapshot, sales_owner_email_snapshot,
      calendar_sync_status, calendar_sync_action, calendar_transaction_id,
      microsoft_organizer_snapshot, calendar_sync_started_at, created_by_user_id
    ) values (
      v_actor.organization_id, v_client.id, v_request.id, v_shortlist.id,
      v_item.id, v_applicant.id, v_owner.id, v_contact.id,
      v_round, v_starts_at, v_ends_at, v_timezone,
      v_applicant.full_name, lower(btrim(v_applicant.email)),
      v_contact.full_name, lower(btrim(v_contact_email)),
      coalesce(nullif(btrim(v_owner.display_name), ''), v_owner_profile.full_name), lower(btrim(v_owner_profile.email)),
      'pending', 'create', p_request_id, v_organizer,
      pg_catalog.clock_timestamp(), v_actor.user_id
    ) returning * into v_interview;
    if v_request.status in ('client_review', 'selection_pending') then
      update public.hiring_requests set status = 'interviewing' where id = v_request.id;
    end if;
    v_calendar_action := 'create';
    v_before := null;
    v_after := jsonb_build_object('interviewId', v_interview.id, 'roundNumber', v_interview.round_number, 'status', v_interview.status);

  elsif v_action in (
    'reschedule_interview', 'cancel_interview',
    'record_interview_outcome', 'retry_calendar_sync'
  ) then
    if v_actor.role not in (
      'admin'::public.platform_role,
      'sales_management'::public.platform_role,
      'sales'::public.platform_role
    ) then
      raise exception using errcode = '42501', message = 'Only assigned Sales or an Administrator may manage Client interviews.';
    end if;
    if v_request.status in ('draft', 'discovery', 'open', 'sourcing', 'shortlisting', 'on_hold', 'cancelled', 'filled') then
      raise exception using errcode = 'P0001', message = 'This hiring request is not accepting interview changes.';
    end if;
    select interview.* into v_interview
    from public.client_candidate_interviews as interview
    where interview.id = p_entity_id
      and interview.organization_id = v_actor.organization_id
      and interview.hiring_request_id = v_request.id
      and interview.client_id = v_client.id
    for update;
    if not found then
      raise exception using errcode = '42501', message = 'This Client interview is not available to your account.';
    end if;
    if v_interview.updated_at is distinct from p_expected_updated_at then
      raise exception using errcode = 'P0001', message = 'This Client interview changed after it was opened.';
    end if;
    if v_action in ('reschedule_interview', 'cancel_interview')
      and v_interview.microsoft_event_id is null
      and v_interview.calendar_sync_action = 'create'
      and v_interview.calendar_sync_status in ('pending', 'sync_failed', 'connection_required') then
      raise exception using
        errcode = 'P0001',
        message = 'Retry the original calendar creation before rescheduling or cancelling this interview.';
    end if;
    if v_interview.calendar_sync_status = 'pending'
      and v_interview.calendar_sync_started_at is not null
      and v_interview.calendar_sync_started_at > pg_catalog.clock_timestamp() - interval '90 seconds'
      and v_action <> 'retry_calendar_sync' then
      raise exception using errcode = 'P0001', message = 'Calendar synchronization is still in progress.';
    end if;
    v_before := jsonb_build_object(
      'interviewId', v_interview.id, 'status', v_interview.status,
      'startsAt', v_interview.starts_at, 'outcome', v_interview.outcome
    );

    if v_action = 'reschedule_interview' then
      if v_interview.status <> 'scheduled'
        or exists (select 1 from jsonb_object_keys(v_payload) as key where key not in (
          'startsAt', 'durationMinutes', 'timezone', 'calendarOrganizer'
        )) or not (v_payload ? 'startsAt' and v_payload ? 'durationMinutes' and v_payload ? 'timezone') then
        raise exception using errcode = '22023', message = 'This interview cannot be rescheduled with those details.';
      end if;
      v_starts_at := nullif(v_payload ->> 'startsAt', '')::timestamptz;
      v_duration := nullif(v_payload ->> 'durationMinutes', '')::integer;
      v_timezone := nullif(btrim(coalesce(v_payload ->> 'timezone', '')), '');
      v_organizer := nullif(btrim(coalesce(v_payload ->> 'calendarOrganizer', '')), '');
      if v_starts_at is null or v_starts_at <= pg_catalog.clock_timestamp() + interval '1 minute'
        or v_duration is null or v_duration < 15 or v_duration > 240 or mod(v_duration, 5) <> 0
        or v_timezone is null or char_length(v_timezone) > 100
        or (v_organizer is not null and char_length(v_organizer) > 1024) then
        raise exception using errcode = '22023', message = 'Choose a valid future interview time, duration, and time zone.';
      end if;
      update public.client_candidate_interviews set
        starts_at = v_starts_at,
        ends_at = v_starts_at + make_interval(mins => v_duration),
        timezone = v_timezone,
        calendar_sync_status = 'pending',
        calendar_sync_action = case when microsoft_event_id is null then 'create' else 'update' end,
        calendar_transaction_id = case when microsoft_event_id is null then p_request_id else calendar_transaction_id end,
        microsoft_organizer_snapshot = coalesce(v_organizer, microsoft_organizer_snapshot),
        microsoft_last_error_code = null,
        calendar_sync_started_at = pg_catalog.clock_timestamp()
      where id = v_interview.id
      returning * into v_interview;
      v_calendar_action := v_interview.calendar_sync_action;

    elsif v_action = 'cancel_interview' then
      if v_interview.status <> 'scheduled'
        or exists (select 1 from jsonb_object_keys(v_payload) as key where key <> 'note')
        or not (v_payload ? 'note') then
        raise exception using errcode = '22023', message = 'This interview cannot be cancelled with those details.';
      end if;
      v_note := nullif(btrim(coalesce(v_payload ->> 'note', '')), '');
      if v_note is null or char_length(v_note) > 1000 then
        raise exception using errcode = '22023', message = 'A cancellation note is required.';
      end if;
      update public.client_candidate_interviews set
        status = 'cancelled', outcome = null, private_notes = v_note,
        calendar_sync_status = case when microsoft_event_id is null then 'not_applicable' else 'pending' end,
        calendar_sync_action = case when microsoft_event_id is null then null else 'cancel' end,
        calendar_transaction_id = case when microsoft_event_id is null then calendar_transaction_id else p_request_id end,
        microsoft_last_error_code = null,
        calendar_sync_started_at = case when microsoft_event_id is null then null else pg_catalog.clock_timestamp() end
      where id = v_interview.id
      returning * into v_interview;
      v_calendar_action := v_interview.calendar_sync_action;

    elsif v_action = 'record_interview_outcome' then
      if v_interview.status <> 'scheduled'
        or exists (select 1 from jsonb_object_keys(v_payload) as key where key not in ('status', 'outcome', 'note'))
        or not (v_payload ? 'status' and v_payload ? 'outcome' and v_payload ? 'note') then
        raise exception using errcode = '22023', message = 'This interview outcome is invalid.';
      end if;
      v_status := lower(btrim(coalesce(v_payload ->> 'status', '')));
      v_outcome := nullif(lower(btrim(coalesce(v_payload ->> 'outcome', ''))), '');
      v_note := nullif(btrim(coalesce(v_payload ->> 'note', '')), '');
      if v_status not in ('completed', 'no_show')
        or (v_status = 'completed' and v_outcome not in ('advance', 'follow_up', 'not_selected'))
        or (v_status = 'no_show' and v_outcome is not null)
        or v_note is null or char_length(v_note) > 4000
        or pg_catalog.clock_timestamp() < v_interview.starts_at then
        raise exception using errcode = '22023', message = 'Choose a valid completed or no-show interview outcome.';
      end if;
      update public.client_candidate_interviews set
        status = v_status, outcome = v_outcome, private_notes = v_note,
        calendar_sync_action = null, calendar_sync_started_at = null
      where id = v_interview.id
      returning * into v_interview;

    else
      if v_payload <> '{}'::jsonb
        or not (
          v_interview.calendar_sync_status in ('connection_required', 'sync_failed')
          or (
            v_interview.calendar_sync_status = 'pending'
            and v_interview.microsoft_event_id is null
            and v_interview.calendar_sync_action = 'create'
          )
        )
        or v_interview.calendar_sync_action is null then
        raise exception using errcode = 'P0001', message = 'This Client interview is not awaiting a calendar retry.';
      end if;
      update public.client_candidate_interviews set
        calendar_sync_status = 'pending',
        calendar_transaction_id = case
          when calendar_sync_action = 'create' then coalesce(calendar_transaction_id, p_request_id)
          else calendar_transaction_id
        end,
        microsoft_last_error_code = null,
        calendar_sync_started_at = pg_catalog.clock_timestamp()
      where id = v_interview.id
      returning * into v_interview;
      v_calendar_action := v_interview.calendar_sync_action;
    end if;
    v_after := jsonb_build_object(
      'interviewId', v_interview.id, 'status', v_interview.status,
      'startsAt', v_interview.starts_at, 'outcome', v_interview.outcome
    );

  elsif v_action = 'final_decision' then
    if v_actor.role <> 'client_admin'::public.platform_role then
      raise exception using errcode = '42501', message = 'Only a Client Administrator may make the final candidate selection.';
    end if;
    if v_request.status not in ('client_review', 'interviewing', 'selection_pending', 'partially_filled') then
      raise exception using errcode = 'P0001', message = 'This hiring request is not accepting final Client decisions.';
    end if;
    if exists (select 1 from jsonb_object_keys(v_payload) as key where key <> 'decision')
      or not (v_payload ? 'decision') then
      raise exception using errcode = '22023', message = 'Choose one final Client decision.';
    end if;
    v_decision_value := lower(btrim(coalesce(v_payload ->> 'decision', '')));
    if v_decision_value not in ('selected', 'passed') then
      raise exception using errcode = '22023', message = 'Choose Selected or Passed.';
    end if;
    select item.* into v_item
    from public.client_shortlist_items as item
    join public.client_shortlists as shortlist
      on shortlist.id = item.shortlist_id
     and shortlist.organization_id = item.organization_id
    where item.id = p_entity_id
      and item.organization_id = v_actor.organization_id
      and item.removed_at is null
      and item.workflow_state = 'active'
      and (item.client_response is null or item.client_response in ('request_interview', 'interested'))
      and shortlist.hiring_request_id = v_request.id
      and shortlist.client_id = v_client.id
      and shortlist.status = 'sent'
    for update of item;
    if not found then
      raise exception using errcode = 'P0001', message = 'This candidate is not awaiting a final Client decision.';
    end if;
    if v_item.updated_at is distinct from p_expected_updated_at then
      raise exception using errcode = 'P0001', message = 'This shortlisted candidate changed after it was opened.';
    end if;
    if v_item.client_response is null and v_decision_value <> 'passed' then
      raise exception using errcode = 'P0001', message = 'Choose Interested or Request interview before selecting this candidate.';
    end if;
    select shortlist.* into v_shortlist
    from public.client_shortlists as shortlist
    where shortlist.id = v_item.shortlist_id
      and shortlist.organization_id = v_actor.organization_id;
    if exists (
      select 1 from public.client_candidate_decisions as decision
      where decision.shortlist_item_id = v_item.id
    ) then
      raise exception using errcode = 'P0001', message = 'A final decision has already been recorded for this candidate.';
    end if;
    if exists (
      select 1
      from public.client_candidate_interviews as interview
      where interview.organization_id = v_actor.organization_id
        and interview.shortlist_item_id = v_item.id
        and (
          interview.status = 'scheduled'
          or (
            interview.status = 'cancelled'
            and interview.calendar_sync_action = 'cancel'
            and interview.calendar_sync_status in ('pending', 'sync_failed', 'connection_required')
          )
        )
    ) then
      raise exception using
        errcode = 'P0001',
        message = 'Complete the interview or finish cancelling its calendar event before recording a final decision.';
    end if;
    if v_decision_value = 'selected' and v_item.client_response = 'request_interview' and not exists (
      select 1 from public.client_candidate_interviews as interview
      where interview.organization_id = v_actor.organization_id
        and interview.shortlist_item_id = v_item.id
        and interview.status = 'completed'
        and interview.outcome in ('advance', 'follow_up')
    ) then
      raise exception using errcode = 'P0001', message = 'Complete a Client interview before selecting this candidate.';
    end if;
    if v_decision_value = 'selected' and (
      select count(*)
      from public.client_candidate_decisions as selected_decision
      where selected_decision.organization_id = v_actor.organization_id
        and selected_decision.hiring_request_id = v_request.id
        and selected_decision.decision = 'selected'
    ) >= v_request.number_of_virtual_assistants then
      raise exception using errcode = 'P0001', message = 'Every approved seat for this hiring request already has a final selection.';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('client-shortlist-applicant:' || v_item.applicant_id::text, 0)
    );
    select applicant.* into v_applicant
    from public.applicants as applicant
    where applicant.id = v_item.applicant_id
      and applicant.organization_id = v_actor.organization_id
      and applicant.archived_at is null
      and applicant.sales_owner_id = v_client.sales_owner_id
      and applicant.status in (
        'interviewing'::public.applicant_status,
        'client_review'::public.applicant_status
      )
    for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'This candidate is no longer available.';
    end if;

    insert into public.client_candidate_decisions (
      organization_id, client_id, hiring_request_id, shortlist_id,
      shortlist_item_id, applicant_id, decided_by_user_id, decision
    ) values (
      v_actor.organization_id, v_client.id, v_request.id, v_shortlist.id,
      v_item.id, v_applicant.id, v_actor.user_id, v_decision_value
    ) returning * into v_decision;
    update public.client_shortlist_items
    set workflow_state = case when v_decision_value = 'selected' then 'selected' else 'passed' end,
        removed_by_user_id = case when v_decision_value = 'passed' then v_actor.user_id end,
        removed_at = case when v_decision_value = 'passed' then pg_catalog.clock_timestamp() end
    where id = v_item.id;
    if v_decision_value = 'passed' then
      update public.applicants
      set status = 'bench_ready'::public.applicant_status
      where id = v_applicant.id
        and status in (
          'shortlisted'::public.applicant_status,
          'client_review'::public.applicant_status,
          'interviewing'::public.applicant_status
        );
    else
      update public.hiring_requests
      set status = 'selection_pending'
      where id = v_request.id
        and status in ('client_review', 'interviewing', 'partially_filled');
    end if;
    v_before := null;
    v_after := jsonb_build_object('decisionId', v_decision.id, 'decision', v_decision.decision);

  elsif v_action = 'prepare_handoff' then
    if v_actor.role not in (
      'admin'::public.platform_role,
      'sales_management'::public.platform_role,
      'sales'::public.platform_role
    ) then
      raise exception using errcode = '42501', message = 'Only assigned Sales or an Administrator may prepare a placement handoff.';
    end if;
    if v_request.status not in ('selection_pending', 'partially_filled') then
      raise exception using errcode = 'P0001', message = 'This hiring request is not ready for a placement handoff.';
    end if;
    if exists (select 1 from jsonb_object_keys(v_payload) as key where key not in (
      'startDate', 'scheduleSummary', 'rateType', 'clientRate', 'talentRate'
    )) or not (
      v_payload ? 'startDate' and v_payload ? 'scheduleSummary'
      and v_payload ? 'rateType' and v_payload ? 'clientRate' and v_payload ? 'talentRate'
    ) then
      raise exception using errcode = '22023', message = 'Placement handoff details are invalid.';
    end if;
    select decision.* into v_decision
    from public.client_candidate_decisions as decision
    where decision.id = p_entity_id
      and decision.organization_id = v_actor.organization_id
      and decision.hiring_request_id = v_request.id
      and decision.client_id = v_client.id
      and decision.decision = 'selected'
    for share;
    if not found then
      raise exception using errcode = 'P0001', message = 'A selected Client decision is required for handoff.';
    end if;
    if v_decision.created_at is distinct from p_expected_updated_at then
      raise exception using errcode = 'P0001', message = 'This Client decision changed after it was opened.';
    end if;
    if exists (
      select 1 from public.client_placement_handoffs as handoff
      where handoff.decision_id = v_decision.id
    ) then
      raise exception using errcode = 'P0001', message = 'A placement handoff already exists for this selection.';
    end if;
    if nullif(v_payload ->> 'startDate', '')::date < current_date
      or char_length(btrim(coalesce(v_payload ->> 'scheduleSummary', ''))) not between 2 and 1000
      or char_length(btrim(coalesce(v_payload ->> 'rateType', ''))) not between 1 and 60
      or nullif(v_payload ->> 'clientRate', '')::numeric <= 0
      or nullif(v_payload ->> 'talentRate', '')::numeric <= 0 then
      raise exception using errcode = '22023', message = 'Choose a current or future start date, schedule, rate type, and positive rates.';
    end if;
    insert into public.client_placement_handoffs (
      organization_id, client_id, hiring_request_id, shortlist_item_id,
      applicant_id, decision_id, prepared_by_user_id, start_date,
      schedule_summary, rate_type, client_rate, talent_rate
    ) values (
      v_actor.organization_id, v_client.id, v_request.id, v_decision.shortlist_item_id,
      v_decision.applicant_id, v_decision.id, v_actor.user_id,
      (v_payload ->> 'startDate')::date,
      btrim(v_payload ->> 'scheduleSummary'), btrim(v_payload ->> 'rateType'),
      (v_payload ->> 'clientRate')::numeric, (v_payload ->> 'talentRate')::numeric
    ) returning * into v_handoff;
    update public.hiring_requests
    set status = 'placement_pending'
    where id = v_request.id
      and status in ('selection_pending', 'partially_filled');
    update public.clients
    set lifecycle_stage = 'matching'
    where id = v_client.id
      and lifecycle_stage in ('qualified', 'matching');
    v_before := null;
    v_after := jsonb_build_object(
      'handoffId', v_handoff.id, 'decisionId', v_decision.id,
      'status', v_handoff.status, 'startDate', v_handoff.start_date
    );

  elsif v_action = 'confirm_placement' then
    if v_actor.role not in ('admin'::public.platform_role, 'talent_management'::public.platform_role) then
      raise exception using errcode = '42501', message = 'Only Admin or Talent Management may confirm a placement.';
    end if;
    if v_request.status not in ('placement_pending', 'partially_filled') then
      raise exception using errcode = 'P0001', message = 'This hiring request is not ready for placement confirmation.';
    end if;
    if v_payload <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'Placement confirmation does not accept editable identifiers.';
    end if;
    select handoff.* into v_handoff
    from public.client_placement_handoffs as handoff
    join public.client_candidate_decisions as decision
      on decision.id = handoff.decision_id
     and decision.organization_id = handoff.organization_id
     and decision.shortlist_item_id = handoff.shortlist_item_id
     and decision.applicant_id = handoff.applicant_id
     and decision.decision = 'selected'
    where handoff.id = p_entity_id
      and handoff.organization_id = v_actor.organization_id
      and handoff.hiring_request_id = v_request.id
      and handoff.client_id = v_client.id
      and handoff.status = 'prepared'
    for update of handoff;
    if not found then
      raise exception using errcode = 'P0001', message = 'This placement handoff is no longer awaiting confirmation.';
    end if;
    if v_handoff.updated_at is distinct from p_expected_updated_at then
      raise exception using errcode = 'P0001', message = 'This placement handoff changed after it was opened.';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('client-shortlist-applicant:' || v_handoff.applicant_id::text, 0)
    );
    select applicant.* into v_applicant
    from public.applicants as applicant
    where applicant.id = v_handoff.applicant_id
      and applicant.organization_id = v_actor.organization_id
      and applicant.archived_at is null
      and applicant.sales_owner_id = v_client.sales_owner_id
      and applicant.status in (
        'interviewing'::public.applicant_status,
        'client_review'::public.applicant_status
      )
    for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'This selected candidate is no longer available.';
    end if;
    select count(*)::integer into v_current_count
    from public.placements as current_placement
    where current_placement.organization_id = v_actor.organization_id
      and current_placement.applicant_id = v_applicant.id
      and current_placement.status in ('placement_confirmed', 'onboarding', 'active')
      and current_placement.end_date is null;
    if v_current_count > 0 then
      raise exception using errcode = 'P0001', message = 'This Talent profile already has a current placement.';
    end if;
    select count(*)::integer into v_filled
    from public.placements as occupied
    where occupied.organization_id = v_actor.organization_id
      and occupied.hiring_request_id = v_request.id
      and occupied.client_id = v_client.id
      and occupied.status in ('placement_confirmed', 'onboarding', 'active')
      and occupied.end_date is null;
    if v_filled >= v_request.number_of_virtual_assistants then
      raise exception using errcode = 'P0001', message = 'Every approved seat for this hiring request is already filled.';
    end if;
    if v_filled + 1 >= v_request.number_of_virtual_assistants and exists (
      select 1
      from public.client_candidate_interviews as remaining_interview
      where remaining_interview.organization_id = v_actor.organization_id
        and remaining_interview.hiring_request_id = v_request.id
        and (
          remaining_interview.status = 'scheduled'
          or (
            remaining_interview.status = 'cancelled'
            and remaining_interview.calendar_sync_action = 'cancel'
            and remaining_interview.calendar_sync_status in ('pending', 'sync_failed', 'connection_required')
          )
        )
    ) then
      raise exception using errcode = 'P0001', message = 'Complete or cancel every remaining Client interview before filling the final seat.';
    end if;

    insert into public.placements (
      organization_id, client_id, applicant_id, hiring_request_id,
      status, start_date, schedule_summary, rate_type, client_rate, virtual_assistant_rate
    ) values (
      v_actor.organization_id, v_client.id, v_applicant.id, v_request.id,
      'onboarding', v_handoff.start_date, v_handoff.schedule_summary,
      v_handoff.rate_type, v_handoff.client_rate, v_handoff.talent_rate
    ) returning * into v_placement;
    update public.client_placement_handoffs set
      status = 'confirmed', confirmed_by_user_id = v_actor.user_id,
      confirmed_at = pg_catalog.clock_timestamp(), placement_id = v_placement.id
    where id = v_handoff.id
    returning * into v_handoff;
    update public.client_shortlist_items
    set workflow_state = 'placed'
    where id = v_handoff.shortlist_item_id
      and organization_id = v_actor.organization_id;
    update public.applicants
    set status = 'onboarding'::public.applicant_status
    where id = v_applicant.id;

    insert into public.placement_onboarding_items (
      organization_id, placement_id, item_key, title, required
    ) values
      (v_actor.organization_id, v_placement.id, 'talent_start_details', 'Talent start details confirmed', true),
      (v_actor.organization_id, v_placement.id, 'client_launch_details', 'Client launch details confirmed', true),
      (v_actor.organization_id, v_placement.id, 'required_documents', 'Required placement documents confirmed', true)
    on conflict (placement_id, item_key) do nothing;

    v_filled := v_filled + 1;
    update public.hiring_requests
    set status = case
      when v_filled >= number_of_virtual_assistants then 'filled'
      else 'partially_filled'
    end
    where id = v_request.id;
    if v_filled >= v_request.number_of_virtual_assistants then
      for v_release in
        select item.id as shortlist_item_id, item.applicant_id
        from public.client_shortlists as shortlist
        join public.client_shortlist_items as item
          on item.shortlist_id = shortlist.id
         and item.organization_id = shortlist.organization_id
        where shortlist.organization_id = v_actor.organization_id
          and shortlist.hiring_request_id = v_request.id
          and shortlist.status = 'sent'
          and item.removed_at is null
          and item.workflow_state = 'active'
          and not exists (
            select 1 from public.client_candidate_decisions as decision
            where decision.shortlist_item_id = item.id
              and decision.decision = 'selected'
          )
        order by item.applicant_id, item.id
      loop
        perform pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended('client-shortlist-applicant:' || v_release.applicant_id::text, 0)
        );
        update public.client_shortlist_items
        set workflow_state = 'released',
            removed_by_user_id = v_actor.user_id,
            removed_at = pg_catalog.clock_timestamp()
        where id = v_release.shortlist_item_id
          and workflow_state = 'active';
        update public.applicants
        set status = 'bench_ready'::public.applicant_status
        where id = v_release.applicant_id
          and organization_id = v_actor.organization_id
          and status in (
            'shortlisted'::public.applicant_status,
            'client_review'::public.applicant_status,
            'interviewing'::public.applicant_status
          );
      end loop;
    end if;
    v_before := jsonb_build_object('handoffId', v_handoff.id, 'status', 'prepared');
    v_after := jsonb_build_object(
      'handoffId', v_handoff.id, 'status', v_handoff.status,
      'placementId', v_placement.id, 'placementStatus', v_placement.status
    );

  elsif v_action = 'update_onboarding' then
    if v_actor.role not in ('admin'::public.platform_role, 'talent_management'::public.platform_role) then
      raise exception using errcode = '42501', message = 'Only Admin or Talent Management may update onboarding.';
    end if;
    if exists (select 1 from jsonb_object_keys(v_payload) as key where key <> 'status')
      or not (v_payload ? 'status') then
      raise exception using errcode = '22023', message = 'Choose one onboarding status.';
    end if;
    v_status := lower(btrim(coalesce(v_payload ->> 'status', '')));
    if v_status not in ('pending', 'completed') then
      raise exception using errcode = '22023', message = 'Choose Pending or Completed.';
    end if;
    select item.* into v_onboarding
    from public.placement_onboarding_items as item
    join public.placements as placement
      on placement.id = item.placement_id
     and placement.organization_id = item.organization_id
    where item.id = p_entity_id
      and item.organization_id = v_actor.organization_id
      and placement.hiring_request_id = v_request.id
      and placement.client_id = v_client.id
      and placement.status = 'onboarding'
    for update of item;
    if not found then
      raise exception using errcode = 'P0001', message = 'This onboarding item is no longer editable.';
    end if;
    if v_onboarding.updated_at is distinct from p_expected_updated_at then
      raise exception using errcode = 'P0001', message = 'This onboarding item changed after it was opened.';
    end if;
    v_before := jsonb_build_object('onboardingItemId', v_onboarding.id, 'status', v_onboarding.status);
    update public.placement_onboarding_items set
      status = v_status,
      completed_by_user_id = case when v_status = 'completed' then v_actor.user_id end,
      completed_at = case when v_status = 'completed' then pg_catalog.clock_timestamp() end
    where id = v_onboarding.id
    returning * into v_onboarding;
    v_placement.id := v_onboarding.placement_id;
    v_after := jsonb_build_object('onboardingItemId', v_onboarding.id, 'status', v_onboarding.status);

  else
    if v_actor.role not in ('admin'::public.platform_role, 'talent_management'::public.platform_role) then
      raise exception using errcode = '42501', message = 'Only Admin or Talent Management may activate a placement.';
    end if;
    if v_client.lifecycle_stage not in ('qualified', 'matching', 'active') then
      raise exception using errcode = 'P0001', message = 'Return the Client to an active matching stage before activating this placement.';
    end if;
    if v_payload <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'Placement activation does not accept editable identifiers.';
    end if;
    select placement.* into v_placement
    from public.placements as placement
    where placement.id = p_entity_id
      and placement.organization_id = v_actor.organization_id
      and placement.hiring_request_id = v_request.id
      and placement.client_id = v_client.id
      and placement.status = 'onboarding'
      and placement.end_date is null
    for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'This placement is not awaiting activation.';
    end if;
    if v_placement.updated_at is distinct from p_expected_updated_at then
      raise exception using errcode = 'P0001', message = 'This placement changed after it was opened.';
    end if;
    if v_placement.start_date is null or v_placement.start_date > current_date then
      raise exception using errcode = 'P0001', message = 'A placement cannot activate before its start date.';
    end if;
    if exists (
      select 1 from public.placement_onboarding_items as item
      where item.organization_id = v_actor.organization_id
        and item.placement_id = v_placement.id
        and item.required = true
        and item.status <> 'completed'
    ) then
      raise exception using errcode = 'P0001', message = 'Complete every required onboarding item before activation.';
    end if;
    v_before := jsonb_build_object('placementId', v_placement.id, 'status', v_placement.status);
    update public.placements set status = 'active'
    where id = v_placement.id
    returning * into v_placement;
    update public.applicants
    set status = 'active'::public.applicant_status
    where id = v_placement.applicant_id
      and organization_id = v_actor.organization_id;
    update public.clients
    set lifecycle_stage = 'active'
    where id = v_client.id
      and lifecycle_stage in ('qualified', 'matching', 'active');
    v_after := jsonb_build_object('placementId', v_placement.id, 'status', v_placement.status);
  end if;

  insert into public.client_placement_operations (
    operation_request_id, phase, organization_id, actor_user_id, action,
    hiring_request_id, interview_id, decision_id, handoff_id, placement_id,
    request_fingerprint
  ) values (
    p_request_id, 'mutation', v_actor.organization_id, v_actor.user_id, v_action,
    v_request.id, v_interview.id, v_decision.id, v_handoff.id, v_placement.id,
    v_fingerprint
  );

  insert into public.audit_events (
    organization_id, actor_user_id, entity_type, entity_id,
    event_type, before_value, after_value, note
  ) values (
    v_actor.organization_id,
    v_actor.user_id,
    case
      when v_interview.id is not null then 'client_candidate_interview'
      when v_decision.id is not null then 'client_candidate_decision'
      when v_handoff.id is not null then 'client_placement_handoff'
      when v_onboarding.id is not null then 'placement_onboarding_item'
      else 'placement'
    end,
    coalesce(v_interview.id, v_decision.id, v_handoff.id, v_onboarding.id, v_placement.id),
    'client_placement_' || v_action,
    v_before,
    v_after,
    'Protected notes, attendee addresses, and rates are not copied into the audit event.'
  );

  v_state := private.client_placement_workspace_json(
    v_actor.organization_id, v_actor.role, v_actor.user_id,
    v_actor.client_id, v_request.id
  );
  if v_calendar_action is not null then
    v_calendar_command := private.client_interview_calendar_command_json(
      v_actor.organization_id, v_interview.id, p_request_id, v_calendar_action
    );
  end if;
  return jsonb_build_object('state', v_state, 'calendarCommand', v_calendar_command);
end;
$$;
revoke all on function public.change_client_placement_workflow(uuid, uuid, uuid, text, timestamptz, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.change_client_placement_workflow(uuid, uuid, uuid, text, timestamptz, uuid, jsonb) to service_role;
commit;

