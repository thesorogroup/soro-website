-- Admin and Talent Management operational roster for the Active Talent Today
-- dashboard metric. The caller supplies only the authenticated user id. The
-- organization, local work dates, placement scope, and attendance scope are
-- derived inside this service-role-only function.

create or replace function public.get_active_talent_today(p_actor_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_organization_id uuid;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_summary jsonb;
  v_rows jsonb;
begin
  if p_actor_user_id is null then
    raise exception using errcode = '22023', message = 'A signed-in management account is required.';
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

  with applicant_zones as (
    select
      applicant.id as applicant_id,
      applicant.full_name,
      applicant.preferred_name,
      applicant.auth_user_id,
      applicant.portal_access_status,
      applicant.archived_at,
      coalesce(valid_zone.name, 'Asia/Manila') as work_timezone,
      valid_zone.name is not null as timezone_valid,
      coalesce(
        nullif(btrim(support_owner.display_name), ''),
        nullif(btrim(review_owner.display_name), ''),
        'Unassigned'
      ) as owner_name,
      case
        when applicant.archived_at is not null then 'suspended'
        when applicant.auth_user_id is null
          or talent_access.id is null
          or talent_access.role <> 'virtual_assistant'::public.platform_role
          then 'unlinked'
        when applicant.portal_access_status = 'suspended'
          or talent_access.active is not true
          then 'suspended'
        when applicant.portal_access_status in (
          'not_invited',
          'invite_pending',
          'delivery_failed'
        ) then applicant.portal_access_status
        when talent_access.must_change_password = true then 'setup_required'
        when applicant.portal_access_status = 'active' then 'ready'
        else 'unlinked'
      end as access_state
    from public.applicants as applicant
    left join lateral (
      select zone.name
      from pg_catalog.pg_timezone_names as zone
      where zone.name = nullif(btrim(applicant.timezone), '')
      limit 1
    ) as valid_zone on true
    left join public.platform_users as support_owner
      on support_owner.id = applicant.talent_support_owner_id
     and support_owner.organization_id = applicant.organization_id
    left join public.platform_users as review_owner
      on review_owner.id = applicant.talent_review_owner_id
     and review_owner.organization_id = applicant.organization_id
    left join public.platform_users as talent_access
      on talent_access.id = applicant.auth_user_id
     and talent_access.organization_id = applicant.organization_id
    where applicant.organization_id = v_organization_id
  ),
  talent_days as (
    select
      applicant_zones.*,
      (v_now at time zone applicant_zones.work_timezone)::date as work_date
    from applicant_zones
  ),
  current_placement_candidates as (
    select
      talent.applicant_id,
      placement.id as placement_id,
      placement.client_id,
      client.company_name as client_name,
      placement.status as placement_status,
      placement.start_date,
      placement.end_date,
      placement.schedule_summary,
      placement.created_at
    from talent_days as talent
    join public.placements as placement
      on placement.applicant_id = talent.applicant_id
    join public.clients as client
      on client.id = placement.client_id
     and client.organization_id = v_organization_id
     and client.archived_at is null
    where talent.archived_at is null
      and placement.start_date is not null
      and placement.start_date <= talent.work_date
      and (placement.end_date is null or placement.end_date >= talent.work_date)
      and regexp_replace(lower(btrim(placement.status)), '[[:space:]-]+', '_', 'g') = any (
        array['placement_confirmed', 'matched', 'onboarding', 'active', 'live', 'working', 'placed']
      )
  ),
  current_placement_counts as (
    select applicant_id, count(*)::integer as placement_count
    from current_placement_candidates
    group by applicant_id
  ),
  current_primary_placements as (
    select ranked.*
    from (
      select
        candidate.*,
        row_number() over (
          partition by candidate.applicant_id
          order by candidate.start_date desc, candidate.created_at desc, candidate.placement_id
        ) as placement_rank
      from current_placement_candidates as candidate
    ) as ranked
    where ranked.placement_rank = 1
  ),
  roster_applicant_ids as (
    select candidate.applicant_id
    from current_placement_candidates as candidate
    union
    select session.applicant_id
    from public.talent_attendance_sessions as session
    where session.organization_id = v_organization_id
      and session.checked_out_at is null
  ),
  roster_people as (
    select talent.*
    from talent_days as talent
    join roster_applicant_ids as roster
      on roster.applicant_id = talent.applicant_id
  ),
  roster_with_session as (
    select
      talent.*,
      coalesce(placement_count.placement_count, 0) as placement_count,
      primary_placement.placement_id as current_placement_id,
      primary_placement.client_id as current_client_id,
      primary_placement.client_name as current_client_name,
      primary_placement.placement_status as current_placement_status,
      primary_placement.start_date as current_start_date,
      primary_placement.end_date as current_end_date,
      primary_placement.schedule_summary as current_schedule_summary,
      attendance.session_id,
      attendance.session_placement_id,
      attendance.session_client_id,
      attendance.session_client_name,
      attendance.session_placement_status,
      attendance.session_start_date,
      attendance.session_end_date,
      attendance.session_schedule_summary,
      attendance.session_work_date,
      attendance.started_at,
      attendance.checked_out_at,
      session_current.placement_id is not null as session_placement_is_current
    from roster_people as talent
    left join current_placement_counts as placement_count
      on placement_count.applicant_id = talent.applicant_id
    left join current_primary_placements as primary_placement
      on primary_placement.applicant_id = talent.applicant_id
    left join lateral (
      select
        session.id as session_id,
        session.placement_id as session_placement_id,
        placement.client_id as session_client_id,
        client.company_name as session_client_name,
        placement.status as session_placement_status,
        placement.start_date as session_start_date,
        placement.end_date as session_end_date,
        placement.schedule_summary as session_schedule_summary,
        session.work_date as session_work_date,
        session.started_at,
        session.checked_out_at
      from public.talent_attendance_sessions as session
      join public.placements as placement
        on placement.id = session.placement_id
       and placement.applicant_id = session.applicant_id
      join public.clients as client
        on client.id = placement.client_id
       and client.organization_id = session.organization_id
      where session.organization_id = v_organization_id
        and session.applicant_id = talent.applicant_id
        and (
          session.checked_out_at is null
          or session.work_date = talent.work_date
        )
      order by
        case when session.checked_out_at is null then 0 else 1 end,
        session.started_at desc
      limit 1
    ) as attendance on true
    left join current_placement_candidates as session_current
      on session_current.applicant_id = talent.applicant_id
     and session_current.placement_id = attendance.session_placement_id
  ),
  roster as (
    select
      source.applicant_id,
      source.full_name,
      source.preferred_name,
      source.owner_name,
      case
        when source.session_id is not null then source.session_placement_id
        when source.placement_count = 1 then source.current_placement_id
        else null
      end as placement_id,
      case
        when source.session_id is not null then source.session_client_id
        when source.placement_count = 1 then source.current_client_id
        else null
      end as client_id,
      case
        when source.session_id is not null then source.session_client_name
        when source.placement_count = 1 then source.current_client_name
        else null
      end as client_name,
      case
        when source.session_id is not null then source.session_placement_status
        when source.placement_count = 1 then source.current_placement_status
        else null
      end as placement_status,
      case
        when source.session_id is not null then source.session_start_date
        when source.placement_count = 1 then source.current_start_date
        else null
      end as placement_start_date,
      case
        when source.session_id is not null then source.session_end_date
        when source.placement_count = 1 then source.current_end_date
        else null
      end as placement_end_date,
      case
        when source.session_id is not null then source.session_schedule_summary
        when source.placement_count = 1 then source.current_schedule_summary
        else null
      end as schedule_summary,
      source.work_date,
      source.work_timezone,
      source.access_state,
      source.started_at,
      source.checked_out_at,
      case
        when source.session_id is not null and source.checked_out_at is null then 'started'
        when source.session_id is not null then 'completed'
        when source.placement_count > 1 then 'needs_review'
        else 'not_started'
      end as attendance_state,
      case
        when source.archived_at is not null then 'archived_profile_open_session'
        when source.placement_count > 1 then 'multiple_current_placements'
        when source.session_id is not null
          and source.checked_out_at is null
          and source.session_placement_is_current is false
          then 'stale_open_session'
        when source.session_id is not null
          and source.checked_out_at is null
          and source.session_work_date <> source.work_date
          then 'open_session_from_prior_date'
        when source.access_state <> 'ready' then 'portal_access_' || source.access_state
        when source.timezone_valid is false then 'timezone_fallback'
        else null
      end as issue_code,
      (
        source.archived_at is not null
        or source.placement_count > 1
        or (
          source.session_id is not null
          and source.checked_out_at is null
          and (
            source.session_placement_is_current is false
            or source.session_work_date <> source.work_date
          )
        )
        or source.access_state <> 'ready'
        or source.timezone_valid is false
      ) as needs_attention,
      source.placement_count > 0 as is_current_active,
      source.session_id is not null
        and source.session_work_date = source.work_date as checked_in_today,
      source.session_id is not null
        and source.checked_out_at is null as working_now,
      source.session_id is not null
        and source.checked_out_at is not null
        and source.session_work_date = source.work_date as completed_today
    from roster_with_session as source
  )
  select
    jsonb_build_object(
      'activeTalent', count(*) filter (where roster.is_current_active),
      'checkedInToday', count(*) filter (where roster.checked_in_today),
      'workingNow', count(*) filter (where roster.working_now),
      'completedToday', count(*) filter (where roster.completed_today),
      'notStarted', count(*) filter (where roster.attendance_state = 'not_started'),
      'needsReview', count(*) filter (where roster.needs_attention)
    ),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'applicantId', roster.applicant_id,
          'fullName', roster.full_name,
          'preferredName', roster.preferred_name,
          'ownerName', roster.owner_name,
          'placementId', roster.placement_id,
          'clientId', roster.client_id,
          'clientName', roster.client_name,
          'placementStatus', roster.placement_status,
          'placementStartDate', roster.placement_start_date,
          'placementEndDate', roster.placement_end_date,
          'scheduleSummary', roster.schedule_summary,
          'workDate', roster.work_date,
          'workTimezone', roster.work_timezone,
          'attendanceState', roster.attendance_state,
          'accessState', roster.access_state,
          'startedAt', roster.started_at,
          'checkedOutAt', roster.checked_out_at,
          'needsAttention', roster.needs_attention,
          'issueCode', roster.issue_code
        ) order by
          roster.needs_attention desc,
          case roster.attendance_state
            when 'needs_review' then 0
            when 'not_started' then 1
            when 'started' then 2
            when 'completed' then 3
            else 4
          end,
          lower(coalesce(nullif(btrim(roster.preferred_name), ''), roster.full_name)),
          roster.applicant_id
      ),
      '[]'::jsonb
    )
  into v_summary, v_rows
  from roster;

  return jsonb_build_object(
    'generatedAt', v_now,
    'summary', v_summary,
    'rows', v_rows
  );
end;
$$;

revoke all on function public.get_active_talent_today(uuid) from public, anon, authenticated;
grant execute on function public.get_active_talent_today(uuid) to service_role;

comment on function public.get_active_talent_today(uuid) is
  'Service-only Admin and Talent Management roster for current placements and manual attendance state.';
