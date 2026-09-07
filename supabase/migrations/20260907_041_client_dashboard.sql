-- Client home is a read-only projection of records already shared with that
-- Client. Internal discovery requests, private applicant fields, rates and
-- calendar diagnostics are deliberately not included.
begin;
create or replace function public.get_client_dashboard(p_actor_user_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, private
as $$
declare v_actor record; v_result jsonb;
begin
  select access.id as user_id, access.role, access.organization_id,
    client.id as client_id, client.company_name, contact.full_name as contact_name,
    client.sales_owner_id
  into v_actor
  from public.platform_users as access
  join public.client_portal_memberships as membership
    on membership.user_id = access.id and membership.organization_id = access.organization_id and membership.active
  join public.clients as client
    on client.id = membership.client_id and client.organization_id = access.organization_id and client.archived_at is null
  join public.client_contacts as contact
    on contact.id = membership.client_contact_id and contact.client_id = client.id
    and contact.organization_id = access.organization_id and contact.active
  where access.id = p_actor_user_id and access.active and not access.must_change_password
    and access.role in ('client_admin'::public.platform_role, 'client_reviewer'::public.platform_role, 'client_billing'::public.platform_role);
  if not found then
    raise exception using errcode = '42501', message = 'An active Client membership is required.';
  end if;
  v_result := jsonb_build_object('generatedAt', statement_timestamp(), 'viewerRole', v_actor.role,
    'companyName', v_actor.company_name, 'contactName', v_actor.contact_name,
    'requests', '[]'::jsonb, 'interviews', '[]'::jsonb, 'talent', '[]'::jsonb);
  if v_actor.role = 'client_billing'::public.platform_role then return v_result; end if;

  with placement_scope as materialized (
    select placement.*, applicant.full_name, applicant.preferred_name
    from public.placements as placement
    join public.applicants as applicant on applicant.id = placement.applicant_id
      and applicant.organization_id = placement.organization_id and applicant.archived_at is null
    where placement.organization_id = v_actor.organization_id and placement.client_id = v_actor.client_id
      and (placement.end_date is null or placement.end_date >= (statement_timestamp() at time zone 'UTC')::date)
      and placement.status in ('placement_confirmed', 'onboarding', 'active')
  ), request_scope as materialized (
    select request.* from public.hiring_requests as request
    where request.organization_id = v_actor.organization_id and request.client_id = v_actor.client_id
      and (exists (select 1 from public.client_shortlists as shortlist
        where shortlist.hiring_request_id = request.id and shortlist.client_id = request.client_id
          and shortlist.organization_id = request.organization_id and shortlist.status = 'sent')
        or exists (select 1 from placement_scope as placement where placement.hiring_request_id = request.id))
  ), sent_items as materialized (
    select item.*, shortlist.hiring_request_id, request.status as request_status,
      applicant.full_name, applicant.archived_at, applicant.status as applicant_status,
      applicant.sales_owner_id
    from public.client_shortlist_items as item
    join public.client_shortlists as shortlist on shortlist.id = item.shortlist_id
      and shortlist.organization_id = item.organization_id and shortlist.status = 'sent'
    join request_scope as request on request.id = shortlist.hiring_request_id
      and request.organization_id = shortlist.organization_id and request.client_id = shortlist.client_id
    join public.applicants as applicant on applicant.id = item.applicant_id and applicant.organization_id = item.organization_id
    where item.removed_at is null and item.workflow_state in ('active', 'selected')
  ), interview_scope as materialized (
    select interview.* from public.client_candidate_interviews as interview
    join sent_items as item on item.id = interview.shortlist_item_id
      and item.organization_id = interview.organization_id and item.hiring_request_id = interview.hiring_request_id
    where interview.client_id = v_actor.client_id and interview.organization_id = v_actor.organization_id
  ), candidate_stats as (
    select item.hiring_request_id, count(distinct item.applicant_id)::integer as candidates,
      count(*) filter (where item.workflow_state = 'active' and item.client_response is null
        and private.is_open_hiring_request_status(item.request_status)
        and item.archived_at is null and item.sales_owner_id = v_actor.sales_owner_id
        and item.applicant_status = 'client_review'::public.applicant_status
        and exists (select 1 from public.platform_users as owner where owner.id = v_actor.sales_owner_id
          and owner.organization_id = v_actor.organization_id and owner.active and not owner.must_change_password
          and owner.role = 'sales'::public.platform_role))::integer as reviews,
      count(*) filter (where v_actor.role = 'client_admin'::public.platform_role
        and item.workflow_state = 'active' and item.client_response in ('interested', 'request_interview')
        and item.request_status in ('client_review', 'interviewing', 'selection_pending', 'partially_filled')
        and item.archived_at is null and item.sales_owner_id = v_actor.sales_owner_id
        and item.applicant_status in ('client_review'::public.applicant_status, 'interviewing'::public.applicant_status)
        and not exists (select 1 from public.client_candidate_decisions as decision where decision.shortlist_item_id = item.id)
        and not exists (select 1 from interview_scope as interview where interview.shortlist_item_id = item.id
          and (interview.status = 'scheduled' or (interview.status = 'cancelled' and interview.calendar_sync_action = 'cancel'
            and interview.calendar_sync_status in ('pending', 'sync_failed', 'connection_required'))))
        and (item.client_response = 'interested' or exists (select 1 from interview_scope as interview
          where interview.shortlist_item_id = item.id and interview.status = 'completed')))::integer as decisions
    from sent_items as item group by item.hiring_request_id
  ), placement_stats as (
    select hiring_request_id, count(*)::integer as placements,
      count(*) filter (where status = 'active')::integer as active,
      count(*) filter (where status in ('placement_confirmed', 'onboarding'))::integer as onboarding
    from placement_scope group by hiring_request_id
  )
  select v_result || jsonb_build_object(
    'requests', coalesce((select jsonb_agg(jsonb_build_object(
      'requestId', request.id, 'roleTitle', request.title, 'status', request.status,
      'targetStartDate', request.start_date, 'seatCount', request.number_of_virtual_assistants,
      'candidateCount', coalesce(candidate.candidates, 0), 'pendingReviewCount', coalesce(candidate.reviews, 0),
      'pendingDecisionCount', coalesce(candidate.decisions, 0), 'placementCount', coalesce(placement.placements, 0),
      'activePlacementCount', coalesce(placement.active, 0), 'onboardingCount', coalesce(placement.onboarding, 0)
    ) order by request.created_at desc, request.id) from request_scope as request
      left join candidate_stats as candidate on candidate.hiring_request_id = request.id
      left join placement_stats as placement on placement.hiring_request_id = request.id), '[]'::jsonb),
    'interviews', coalesce((select jsonb_agg(jsonb_build_object(
      'interviewId', interview.id, 'requestId', interview.hiring_request_id, 'roleTitle', request.title,
      'candidateName', interview.applicant_name_snapshot, 'startsAt', interview.starts_at,
      'endsAt', interview.ends_at, 'timezone', interview.timezone,
      'joinUrl', case when interview.calendar_sync_status = 'synced' then interview.microsoft_join_url end
    ) order by interview.starts_at, interview.id) from interview_scope as interview
      join request_scope as request on request.id = interview.hiring_request_id
      where interview.status = 'scheduled' and interview.ends_at > statement_timestamp()), '[]'::jsonb),
    'talent', coalesce((select jsonb_agg(jsonb_build_object(
      'placementId', placement.id, 'applicantId', placement.applicant_id,
      'fullName', placement.full_name, 'preferredName', placement.preferred_name,
      'roleTitle', coalesce(request.title, 'Talent placement'), 'status', placement.status,
      'startDate', placement.start_date, 'scheduleSummary', placement.schedule_summary
    ) order by placement.start_date, placement.id) from placement_scope as placement
      left join request_scope as request on request.id = placement.hiring_request_id), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.get_client_dashboard(uuid) from public, anon, authenticated;
grant execute on function public.get_client_dashboard(uuid) to service_role;
commit;
