-- Read-only Sales dashboard projection. One scoped query aggregates the live
-- workflow; no candidate identities, interview notes, rates, or login data leave
-- this RPC. Existing mutation permissions and workflow transitions are unchanged.
begin;

create or replace function public.get_sales_lifecycle_tracker(p_actor_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_actor record;
  v_result jsonb;
begin
  select * into v_actor from private.client_pipeline_actor(p_actor_user_id);
  if v_actor.role not in (
    'admin'::public.platform_role,
    'sales_management'::public.platform_role,
    'sales'::public.platform_role
  ) then
    raise exception using errcode = '42501', message = 'Sales lifecycle access is required.';
  end if;

  with request_scope as materialized (
    select request.id, request.organization_id, request.client_id, request.title,
      request.status, request.start_date, request.number_of_virtual_assistants,
      request.updated_at, client.company_name, client.sales_owner_id,
      client.updated_at as client_updated_at, nullif(btrim(owner.display_name), '') as owner_name,
      coalesce(owner.active and not owner.must_change_password and owner.role = 'sales'::public.platform_role, false) as owner_active
    from public.hiring_requests as request
    join public.clients as client
      on client.id = request.client_id
     and client.organization_id = request.organization_id
     and client.archived_at is null
    left join public.platform_users as owner
      on owner.id = client.sales_owner_id
     and owner.organization_id = client.organization_id
    where request.organization_id = v_actor.organization_id
      and (v_actor.role <> 'sales'::public.platform_role or client.sales_owner_id = v_actor.user_id)
  ), client_scope as (
    select distinct client_id, organization_id from request_scope
  ), contact_stats as (
    select contact.client_id,
      count(*) filter (where contact.active)::integer as active_contacts,
      count(*) filter (where contact.active and membership.active and access.active and not access.must_change_password
        and access.role in ('client_admin'::public.platform_role, 'client_reviewer'::public.platform_role))::integer as portal_contacts,
      count(*) filter (where contact.active and membership.active and access.active and not access.must_change_password
        and access.role = 'client_admin'::public.platform_role)::integer as decision_contacts,
      count(*) filter (where contact.active and contact.portal_access_status in ('delivery_failed', 'needs_reconciliation')
        and (access.role in ('client_admin'::public.platform_role, 'client_reviewer'::public.platform_role)
          or (access.id is null and exists (
            select 1 from public.client_portal_access_operations as operation
            where operation.client_contact_id = contact.id and operation.organization_id = contact.organization_id
              and operation.requested_portal_role in ('client_admin'::public.platform_role, 'client_reviewer'::public.platform_role)
              and operation.status in ('pending', 'failed')
          ))))::integer as portal_issues,
      greatest(max(contact.updated_at), max(membership.updated_at)) as updated_at
    from public.client_contacts as contact
    join client_scope as scope
      on scope.client_id = contact.client_id and scope.organization_id = contact.organization_id
    left join public.client_portal_memberships as membership
      on membership.client_contact_id = contact.id and membership.client_id = contact.client_id
     and membership.organization_id = contact.organization_id
    left join public.platform_users as access
      on access.id = membership.user_id and access.organization_id = membership.organization_id
    group by contact.client_id
  ), shortlist_scope as materialized (
    select shortlist.*
    from public.client_shortlists as shortlist
    join request_scope as scope
      on scope.id = shortlist.hiring_request_id
     and scope.client_id = shortlist.client_id
     and scope.organization_id = shortlist.organization_id
  ), interview_scope as materialized (
    select interview.id, interview.organization_id, interview.hiring_request_id,
      interview.shortlist_item_id, interview.round_number, interview.status,
      interview.outcome, interview.starts_at, interview.ends_at,
      interview.calendar_sync_status, interview.calendar_sync_action, interview.updated_at
    from public.client_candidate_interviews as interview
    join request_scope as scope
      on scope.id = interview.hiring_request_id and scope.client_id = interview.client_id
     and scope.organization_id = interview.organization_id
  ), latest_interviews as materialized (
    select distinct on (interview.shortlist_item_id) interview.*
    from interview_scope as interview
    order by interview.shortlist_item_id, interview.round_number desc, interview.id
  ), shortlist_stats as (
    select shortlist.hiring_request_id,
      count(distinct item.applicant_id) filter (
        where item.removed_at is null and item.workflow_state in ('active', 'selected')
      )::integer as candidate_count,
      count(distinct item.applicant_id) filter (
        where shortlist.status = 'draft' and item.removed_at is null and item.workflow_state = 'active'
      )::integer as draft_count,
      count(distinct item.applicant_id) filter (
        where shortlist.status = 'sent' and item.removed_at is null and item.workflow_state = 'active'
      )::integer as sent_count,
      count(distinct item.applicant_id) filter (
        where item.removed_at is null and item.workflow_state = 'selected'
      )::integer as selected_count,
      count(distinct item.applicant_id) filter (
        where item.removed_at is null and item.workflow_state = 'active' and item.client_response = 'request_interview'
          and (last_interview.id is null or last_interview.status = 'cancelled')
      )::integer as interview_requested_count,
      greatest(max(shortlist.updated_at), max(item.updated_at)) as updated_at
    from shortlist_scope as shortlist
    left join public.client_shortlist_items as item
      on item.shortlist_id = shortlist.id and item.organization_id = shortlist.organization_id
    left join latest_interviews as last_interview
      on last_interview.shortlist_item_id = item.id and last_interview.organization_id = item.organization_id
    group by shortlist.hiring_request_id
  ), interview_stats as (
    select interview.hiring_request_id,
      count(*) filter (where interview.status = 'scheduled' and item.removed_at is null and item.workflow_state = 'active')::integer as scheduled_count,
      count(*) filter (where interview.status = 'completed' and item.removed_at is null and item.workflow_state = 'active')::integer as completed_count,
      count(*) filter (where (interview.status = 'no_show' or (interview.status = 'completed' and interview.outcome = 'follow_up'))
        and item.removed_at is null and item.workflow_state = 'active')::integer as follow_up_count,
      count(*) filter (where interview.status = 'scheduled' and interview.ends_at < statement_timestamp()
        and item.removed_at is null and item.workflow_state = 'active')::integer as outcome_due_count,
      min(interview.starts_at) filter (where interview.status = 'scheduled' and interview.starts_at >= statement_timestamp()
        and item.removed_at is null and item.workflow_state = 'active') as next_interview_at,
      max(interview.updated_at) as updated_at
    from latest_interviews as interview
    join public.client_shortlist_items as item
      on item.id = interview.shortlist_item_id and item.organization_id = interview.organization_id
    group by interview.hiring_request_id
  ), interview_activity as (
    select hiring_request_id, max(updated_at) as updated_at
    from interview_scope
    group by hiring_request_id
  ), calendar_stats as (
    -- A failed cancellation still blocks a final Client decision even when a
    -- later interview round exists. Count distinct candidates across history.
    select interview.hiring_request_id,
      count(distinct interview.shortlist_item_id) filter (
        where interview.calendar_sync_status in ('sync_failed', 'connection_required')
      )::integer as issue_count,
      count(distinct interview.shortlist_item_id) filter (
        where interview.status = 'cancelled' and interview.calendar_sync_status = 'pending'
      )::integer as pending_count
    from interview_scope as interview
    join public.client_shortlist_items as item
      on item.id = interview.shortlist_item_id and item.organization_id = interview.organization_id
     and item.removed_at is null and item.workflow_state = 'active'
    where interview.status = 'scheduled'
      or (interview.status = 'cancelled' and interview.calendar_sync_action = 'cancel')
    group by interview.hiring_request_id
  ), handoff_stats as (
    select handoff.hiring_request_id,
      count(*) filter (where handoff.status = 'prepared')::integer as prepared_count,
      max(handoff.updated_at) as updated_at
    from public.client_placement_handoffs as handoff
    join request_scope as scope
      on scope.id = handoff.hiring_request_id and scope.client_id = handoff.client_id
     and scope.organization_id = handoff.organization_id
    group by handoff.hiring_request_id
  ), placement_scope as materialized (
    select placement.*
    from public.placements as placement
    join request_scope as scope
      on scope.id = placement.hiring_request_id and scope.client_id = placement.client_id
     and scope.organization_id = placement.organization_id
  ), placement_stats as (
    select placement.hiring_request_id,
      count(*) filter (where placement.end_date is null and placement.status in ('placement_confirmed', 'onboarding', 'active'))::integer as placement_count,
      count(*) filter (where placement.end_date is null and placement.status = 'active')::integer as active_count,
      count(*) filter (where placement.end_date is null and placement.status = 'onboarding')::integer as onboarding_count,
      max(placement.updated_at) as updated_at
    from placement_scope as placement
    group by placement.hiring_request_id
  ), onboarding_activity as (
    select placement.hiring_request_id, max(item.updated_at) as updated_at
    from public.placement_onboarding_items as item
    join placement_scope as placement
      on placement.id = item.placement_id and placement.organization_id = item.organization_id
    group by placement.hiring_request_id
  ), decision_activity as (
    select decision.hiring_request_id, max(decision.created_at) as updated_at
    from public.client_candidate_decisions as decision
    join request_scope as scope
      on scope.id = decision.hiring_request_id and scope.client_id = decision.client_id
     and scope.organization_id = decision.organization_id
    group by decision.hiring_request_id
  )
  select jsonb_build_object(
    'generatedAt', statement_timestamp(), 'viewerRole', v_actor.role::text,
    'rows', coalesce(jsonb_agg(jsonb_build_object(
      'clientId', scope.client_id, 'clientName', scope.company_name,
      'requestId', scope.id, 'roleTitle', scope.title,
      'ownerId', scope.sales_owner_id, 'ownerName', scope.owner_name,
      'ownerActive', scope.owner_active, 'status', scope.status,
      'seatCount', scope.number_of_virtual_assistants,
      'targetStartDate', scope.start_date,
      -- Hiring-request dates have no timezone. Use Soro's Central business date
      -- so UTC midnight cannot flag a target early during the prior evening.
      'isTargetStartPast', coalesce(scope.start_date < timezone('America/Chicago', statement_timestamp())::date, false),
      'candidateCount', coalesce(shortlists.candidate_count, 0),
      'draftCandidateCount', coalesce(shortlists.draft_count, 0),
      'sentCandidateCount', coalesce(shortlists.sent_count, 0),
      'selectedCandidateCount', coalesce(shortlists.selected_count, 0),
      'interviewRequestedCount', coalesce(shortlists.interview_requested_count, 0),
      'interviewCount', coalesce(interviews.scheduled_count, 0),
      'completedInterviewCount', coalesce(interviews.completed_count, 0),
      'interviewFollowUpCount', coalesce(interviews.follow_up_count, 0),
      'outcomeDueCount', coalesce(interviews.outcome_due_count, 0),
      'calendarIssueCount', coalesce(calendar.issue_count, 0),
      'calendarPendingCount', coalesce(calendar.pending_count, 0),
      'nextInterviewAt', interviews.next_interview_at,
      'preparedHandoffCount', coalesce(handoffs.prepared_count, 0),
      'placementCount', coalesce(placements.placement_count, 0),
      'activePlacementCount', coalesce(placements.active_count, 0),
      'onboardingCount', coalesce(placements.onboarding_count, 0),
      'activeContactCount', coalesce(contacts.active_contacts, 0),
      'portalContactCount', coalesce(contacts.portal_contacts, 0),
      'portalDecisionContactCount', coalesce(contacts.decision_contacts, 0),
      'portalIssueCount', coalesce(contacts.portal_issues, 0),
      'lastActivityAt', greatest(scope.updated_at, scope.client_updated_at,
        contacts.updated_at, shortlists.updated_at, interview_history.updated_at,
        handoffs.updated_at, placements.updated_at, onboarding.updated_at, decisions.updated_at)
    ) order by scope.updated_at desc, scope.id), '[]'::jsonb)
  ) into v_result
  from request_scope as scope
  left join contact_stats as contacts on contacts.client_id = scope.client_id
  left join shortlist_stats as shortlists on shortlists.hiring_request_id = scope.id
  left join interview_stats as interviews on interviews.hiring_request_id = scope.id
  left join interview_activity as interview_history on interview_history.hiring_request_id = scope.id
  left join calendar_stats as calendar on calendar.hiring_request_id = scope.id
  left join handoff_stats as handoffs on handoffs.hiring_request_id = scope.id
  left join placement_stats as placements on placements.hiring_request_id = scope.id
  left join onboarding_activity as onboarding on onboarding.hiring_request_id = scope.id
  left join decision_activity as decisions on decisions.hiring_request_id = scope.id;
  return v_result;
end;
$$;

revoke all on function public.get_sales_lifecycle_tracker(uuid) from public, anon, authenticated;
grant execute on function public.get_sales_lifecycle_tracker(uuid) to service_role;
comment on function public.get_sales_lifecycle_tracker(uuid) is
  'Read-only Sales lifecycle aggregates. Sales sees owned Clients; Admin and Sales Management see organization-scoped requests. No rates, applicant identities, private notes, or account credentials are returned.';

commit;
