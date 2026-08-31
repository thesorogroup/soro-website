-- Soro Operations: organization-scoped Talent Management application review.
--
-- The existing applicants.status enum remains the single workflow source of
-- truth. This migration adds only a service-side idempotency ledger and
-- service-role RPCs; browser clients never choose an organization or role.

create table if not exists public.talent_review_operations (
  operation_request_id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  actor_user_id uuid not null references public.platform_users(id) on delete restrict,
  applicant_id uuid not null references public.applicants(id) on delete cascade,
  action text not null check (action in (
    'begin_review',
    'request_more_info',
    'mark_bench_ready',
    'return_to_review',
    'decline',
    'archive',
    'restore',
    'reopen'
  )),
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

create index if not exists talent_review_operations_applicant_idx
  on public.talent_review_operations (applicant_id, created_at desc);

alter table public.talent_review_operations enable row level security;
revoke all on table public.talent_review_operations from public, anon, authenticated;
grant select, insert on table public.talent_review_operations to service_role;

create or replace function private.talent_review_actor(p_actor_user_id uuid)
returns table (
  user_id uuid,
  organization_id uuid,
  role public.platform_role,
  display_name text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
begin
  if p_actor_user_id is null then
    raise exception using errcode = '22023', message = 'A signed-in account is required.';
  end if;

  return query
  select
    access.id,
    access.organization_id,
    access.role,
    coalesce(nullif(btrim(access.display_name), ''), 'Soro team member')
  from public.platform_users as access
  where access.id = p_actor_user_id
    and access.organization_id is not null
    and access.active = true
    and access.must_change_password = false
    and access.role in (
      'admin'::public.platform_role,
      'talent_management'::public.platform_role
    )
  limit 1;

  if not found then
    raise exception using errcode = '42501', message = 'Admin or Talent Management access is required.';
  end if;
end;
$$;

revoke all on function private.talent_review_actor(uuid) from public, anon, authenticated;

create or replace function private.talent_review_checklist_json(
  p_applicant_id uuid,
  p_organization_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  with source as (
    select
      applicant.id,
      (
        nullif(btrim(applicant.full_name), '') is not null
        and nullif(btrim(applicant.email), '') is not null
        and nullif(btrim(applicant.phone), '') is not null
        and nullif(btrim(applicant.timezone), '') is not null
        and (
          nullif(btrim(applicant.location), '') is not null
          or (
            nullif(btrim(applicant.country), '') is not null
            and nullif(btrim(applicant.city), '') is not null
          )
        )
      ) as core_profile_complete,
      (
        cardinality(applicant.self_reported_experience_areas) > 0
        or cardinality(applicant.self_reported_skills) > 0
      ) as skills_complete,
      (
        nullif(btrim(applicant.resume_url), '') is not null
        or exists (
          select 1 from public.documents as document
          where document.organization_id = applicant.organization_id
            and document.applicant_id = applicant.id
            and document.document_type = 'resume'
            and document.status <> 'rejected'::public.document_status
        )
      ) as resume_complete,
      exists (
        select 1 from public.documents as document
        where document.organization_id = applicant.organization_id
          and document.applicant_id = applicant.id
          and document.document_type = 'english_proof'
          and document.status <> 'rejected'::public.document_status
      ) as english_complete,
      exists (
        select 1 from public.documents as document
        where document.organization_id = applicant.organization_id
          and document.applicant_id = applicant.id
          and document.document_type = 'disc_assessment'
          and document.status <> 'rejected'::public.document_status
      ) as disc_complete,
      exists (
        select 1 from public.documents as document
        where document.organization_id = applicant.organization_id
          and document.applicant_id = applicant.id
          and document.document_type = 'enneagram_assessment'
          and document.status <> 'rejected'::public.document_status
      ) as enneagram_complete,
      exists (
        select 1 from public.documents as document
        where document.organization_id = applicant.organization_id
          and document.applicant_id = applicant.id
          and document.document_type = 'mbti_assessment'
          and document.status <> 'rejected'::public.document_status
      ) as mbti_complete,
      exists (
        select 1 from public.documents as document
        where document.organization_id = applicant.organization_id
          and document.applicant_id = applicant.id
          and document.document_type = 'internet_proof'
          and document.status <> 'rejected'::public.document_status
      ) as internet_complete,
      exists (
        select 1 from public.documents as document
        where document.organization_id = applicant.organization_id
          and document.applicant_id = applicant.id
          and document.document_type = 'equipment_proof'
          and document.status <> 'rejected'::public.document_status
      ) as equipment_complete
    from public.applicants as applicant
    where applicant.id = p_applicant_id
      and applicant.organization_id = p_organization_id
  )
  select coalesce(
    jsonb_build_array(
      jsonb_build_object('key', 'core_profile', 'label', 'Core profile', 'state', case when core_profile_complete then 'complete' else 'missing' end),
      jsonb_build_object('key', 'resume', 'label', 'Resume', 'state', case when resume_complete then 'complete' else 'missing' end),
      jsonb_build_object('key', 'english', 'label', 'English assessment', 'state', case when english_complete then 'complete' else 'missing' end),
      jsonb_build_object('key', 'disc', 'label', 'DISC assessment', 'state', case when disc_complete then 'complete' else 'missing' end),
      jsonb_build_object('key', 'enneagram', 'label', 'Enneagram assessment', 'state', case when enneagram_complete then 'complete' else 'missing' end),
      jsonb_build_object('key', 'mbti', 'label', 'Four-letter personality assessment', 'state', case when mbti_complete then 'complete' else 'missing' end),
      jsonb_build_object('key', 'internet', 'label', 'Internet speed proof', 'state', case when internet_complete then 'complete' else 'missing' end),
      jsonb_build_object('key', 'equipment', 'label', 'Computer specifications', 'state', case when equipment_complete then 'complete' else 'missing' end),
      jsonb_build_object('key', 'skills', 'label', 'Applicant-reported skills', 'state', case when skills_complete then 'complete' else 'missing' end)
    ),
    '[]'::jsonb
  )
  from source;
$$;

revoke all on function private.talent_review_checklist_json(uuid, uuid) from public, anon, authenticated;

create or replace function private.talent_review_queue_json(
  p_organization_id uuid,
  p_viewer_role public.platform_role
)
returns jsonb
language sql
security definer
set search_path = pg_catalog, public, private
as $$
  with scoped as (
    select
      applicant.*,
      owner.id as owner_id,
      coalesce(nullif(btrim(owner.display_name), ''), 'Unassigned') as owner_name,
      coalesce(resume_source.available, false) as resume_available,
      case
        when applicant.status = 'not_selected'::public.applicant_status then 'declined'
        else applicant.status::text
      end as stage,
      case
        when applicant.archived_at is not null then jsonb_build_array('restore')
        when applicant.status = 'submitted'::public.applicant_status then
          jsonb_build_array('begin_review', 'request_more_info', 'decline', 'archive')
        when applicant.status = 'in_review'::public.applicant_status then
          jsonb_build_array('request_more_info', 'mark_bench_ready', 'decline', 'archive')
        when applicant.status = 'needs_more_info'::public.applicant_status then
          jsonb_build_array('return_to_review', 'decline', 'archive')
        when applicant.status = 'bench_ready'::public.applicant_status then
          jsonb_build_array('return_to_review', 'decline', 'archive')
        when applicant.status = 'not_selected'::public.applicant_status then
          jsonb_build_array('reopen', 'archive')
        else '[]'::jsonb
      end as allowed_actions,
      case
        when applicant.archived_at is not null or applicant.status = 'not_selected'::public.applicant_status then 5
        when applicant.status = 'needs_more_info'::public.applicant_status then 1
        when applicant.status = 'submitted'::public.applicant_status then 2
        when applicant.status = 'in_review'::public.applicant_status then 3
        when applicant.status = 'bench_ready'::public.applicant_status then 4
        else 6
      end as stage_rank
    from public.applicants as applicant
    left join public.platform_users as owner
      on owner.id = applicant.talent_review_owner_id
     and owner.organization_id = applicant.organization_id
    left join lateral (
      select true as available
      from public.documents as document
      where document.organization_id = applicant.organization_id
        and document.applicant_id = applicant.id
        and document.document_type = 'resume'
        and document.storage_path is not null
        and document.status <> 'rejected'::public.document_status
      order by document.created_at desc, document.id desc
      limit 1
    ) as resume_source on true
    where applicant.organization_id = p_organization_id
      and (
        applicant.status in (
          'submitted'::public.applicant_status,
          'in_review'::public.applicant_status,
          'needs_more_info'::public.applicant_status,
          'bench_ready'::public.applicant_status,
          'not_selected'::public.applicant_status
        )
      )
  ), summary as (
    select
      count(*)::integer as all_count,
      count(*) filter (where archived_at is null and status = 'submitted'::public.applicant_status)::integer as submitted_count,
      count(*) filter (where archived_at is null and status = 'in_review'::public.applicant_status)::integer as in_review_count,
      count(*) filter (where archived_at is null and status = 'needs_more_info'::public.applicant_status)::integer as needs_more_info_count,
      count(*) filter (where archived_at is null and status = 'bench_ready'::public.applicant_status)::integer as bench_ready_count,
      count(*) filter (where archived_at is not null or status = 'not_selected'::public.applicant_status)::integer as closed_count
    from scoped
  ), rows as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'applicantId', applicant.id,
          'fullName', applicant.full_name,
          'preferredName', nullif(btrim(applicant.preferred_name), ''),
          'email', applicant.email,
          'applicationReceivedAt', coalesce(applicant.application_received_at, applicant.submitted_at, applicant.created_at),
          'updatedAt', applicant.updated_at,
          'stage', applicant.stage,
          'archived', applicant.archived_at is not null,
          'owner', jsonb_build_object('id', applicant.owner_id, 'name', applicant.owner_name),
          'resume', jsonb_build_object(
            'available', applicant.resume_available,
            'label', case
              when applicant.resume_available then 'Résumé available'
              else 'Résumé not attached'
            end
          ),
          'checklist', private.talent_review_checklist_json(applicant.id, applicant.organization_id),
          'allowedActions', applicant.allowed_actions
        ) order by
          applicant.stage_rank,
          coalesce(applicant.application_received_at, applicant.submitted_at, applicant.created_at) desc,
          applicant.id
      ),
      '[]'::jsonb
    ) as applicants
    from scoped as applicant
  )
  select jsonb_build_object(
    'generatedAt', pg_catalog.clock_timestamp(),
    'viewerRole', p_viewer_role::text,
    'summary', jsonb_build_object(
      'all', coalesce(summary.all_count, 0),
      'submitted', coalesce(summary.submitted_count, 0),
      'in_review', coalesce(summary.in_review_count, 0),
      'needs_more_info', coalesce(summary.needs_more_info_count, 0),
      'bench_ready', coalesce(summary.bench_ready_count, 0),
      'closed', coalesce(summary.closed_count, 0)
    ),
    'applicants', rows.applicants
  )
  from summary
  cross join rows;
$$;

revoke all on function private.talent_review_queue_json(uuid, public.platform_role) from public, anon, authenticated;

create or replace function public.get_talent_review_queue(p_actor_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_actor record;
begin
  select * into v_actor from private.talent_review_actor(p_actor_user_id);
  return private.talent_review_queue_json(v_actor.organization_id, v_actor.role);
end;
$$;

revoke all on function public.get_talent_review_queue(uuid) from public, anon, authenticated;
grant execute on function public.get_talent_review_queue(uuid) to service_role;

create or replace function public.change_talent_review_stage(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_applicant_id uuid,
  p_expected_updated_at timestamptz,
  p_action text,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $$
declare
  v_actor record;
  v_action text := lower(btrim(p_action));
  v_note text := nullif(btrim(p_note), '');
  v_fingerprint text;
  v_operation public.talent_review_operations%rowtype;
  v_before public.applicants%rowtype;
  v_after public.applicants%rowtype;
  v_checklist jsonb;
begin
  if p_request_id is null or p_applicant_id is null or p_expected_updated_at is null then
    raise exception using errcode = '22023', message = 'Request id, Talent application, and expected update time are required.';
  end if;
  if v_action is null or v_action not in (
    'begin_review', 'request_more_info', 'mark_bench_ready', 'return_to_review',
    'decline', 'archive', 'restore', 'reopen'
  ) then
    raise exception using errcode = '22023', message = 'Unsupported Talent review action.';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception using errcode = '22023', message = 'The review note is too long.';
  end if;
  if v_action in ('request_more_info', 'decline', 'archive') and v_note is null then
    raise exception using errcode = '22023', message = 'A brief note is required for this review action.';
  end if;

  select * into v_actor from private.talent_review_actor(p_actor_user_id);

  v_fingerprint := encode(
    digest(
      concat_ws(
        '|',
        v_action,
        p_applicant_id::text,
        p_expected_updated_at::text,
        coalesce(v_note, '')
      ),
      'sha256'
    ),
    'hex'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('talent-review-operation:' || p_request_id::text, 0)
  );

  select * into v_operation
  from public.talent_review_operations
  where operation_request_id = p_request_id;

  if v_operation.operation_request_id is not null then
    if v_operation.organization_id is distinct from v_actor.organization_id
      or v_operation.actor_user_id is distinct from p_actor_user_id
      or v_operation.applicant_id is distinct from p_applicant_id
      or v_operation.action <> v_action
      or v_operation.request_fingerprint <> v_fingerprint then
      raise exception using errcode = '22023', message = 'This request id has already been used for another review action.';
    end if;
    return private.talent_review_queue_json(v_actor.organization_id, v_actor.role);
  end if;

  select applicant.* into v_before
  from public.applicants as applicant
  where applicant.id = p_applicant_id
    and applicant.organization_id = v_actor.organization_id
  for update;

  if v_before.id is null then
    raise exception using errcode = '42501', message = 'This Talent application is not available to your account.';
  end if;
  if v_before.updated_at is distinct from p_expected_updated_at then
    raise exception using errcode = 'P0001', message = 'This Talent application changed after it was opened.';
  end if;

  if v_action = 'begin_review' then
    if v_before.archived_at is not null or v_before.status <> 'submitted'::public.applicant_status then
      raise exception using errcode = 'P0001', message = 'Only a submitted application can begin review.';
    end if;
    update public.applicants
    set status = 'in_review', status_reason = null,
        talent_review_owner_id = coalesce(talent_review_owner_id, p_actor_user_id)
    where id = v_before.id returning * into v_after;

  elsif v_action = 'request_more_info' then
    if v_before.archived_at is not null or v_before.status not in (
      'submitted'::public.applicant_status, 'in_review'::public.applicant_status
    ) then
      raise exception using errcode = 'P0001', message = 'More information can be requested only from a submitted or in-review application.';
    end if;
    update public.applicants
    set status = 'needs_more_info', status_reason = v_note,
        talent_review_owner_id = coalesce(talent_review_owner_id, p_actor_user_id)
    where id = v_before.id returning * into v_after;

  elsif v_action = 'mark_bench_ready' then
    if v_before.archived_at is not null or v_before.status <> 'in_review'::public.applicant_status then
      raise exception using errcode = 'P0001', message = 'Only an in-review application can be marked Bench Ready.';
    end if;
    v_checklist := private.talent_review_checklist_json(v_before.id, v_before.organization_id);
    if exists (
      select 1 from jsonb_array_elements(v_checklist) as item
      where item->>'state' <> 'complete'
    ) then
      raise exception using errcode = 'P0001', message = 'Required review sources are still missing.';
    end if;
    update public.applicants
    set status = 'bench_ready', status_reason = null,
        talent_review_owner_id = coalesce(talent_review_owner_id, p_actor_user_id)
    where id = v_before.id returning * into v_after;

  elsif v_action = 'return_to_review' then
    if v_before.archived_at is not null or v_before.status not in (
      'needs_more_info'::public.applicant_status, 'bench_ready'::public.applicant_status
    ) then
      raise exception using errcode = 'P0001', message = 'Only Needs More Information or Bench Ready can return to review.';
    end if;
    update public.applicants
    set status = 'in_review', status_reason = null,
        talent_review_owner_id = coalesce(talent_review_owner_id, p_actor_user_id)
    where id = v_before.id returning * into v_after;

  elsif v_action = 'decline' then
    if v_before.archived_at is not null or v_before.status not in (
      'submitted'::public.applicant_status, 'in_review'::public.applicant_status,
      'needs_more_info'::public.applicant_status, 'bench_ready'::public.applicant_status
    ) then
      raise exception using errcode = 'P0001', message = 'This application cannot be declined from its current stage.';
    end if;
    update public.applicants
    set status = 'not_selected', status_reason = v_note,
        talent_review_owner_id = coalesce(talent_review_owner_id, p_actor_user_id)
    where id = v_before.id returning * into v_after;

  elsif v_action = 'archive' then
    if v_before.archived_at is not null then
      raise exception using errcode = 'P0001', message = 'This application is already archived.';
    end if;
    update public.applicants
    set archived_at = pg_catalog.clock_timestamp()
    where id = v_before.id returning * into v_after;

  elsif v_action = 'restore' then
    if v_before.archived_at is null then
      raise exception using errcode = 'P0001', message = 'Only an archived application can be restored.';
    end if;
    update public.applicants
    set archived_at = null
    where id = v_before.id returning * into v_after;

  elsif v_action = 'reopen' then
    if v_before.archived_at is not null or v_before.status <> 'not_selected'::public.applicant_status then
      raise exception using errcode = 'P0001', message = 'Only a declined application can be reopened.';
    end if;
    update public.applicants
    set status = 'in_review', status_reason = null,
        talent_review_owner_id = coalesce(talent_review_owner_id, p_actor_user_id)
    where id = v_before.id returning * into v_after;
  end if;

  insert into public.talent_review_operations (
    operation_request_id,
    organization_id,
    actor_user_id,
    applicant_id,
    action,
    request_fingerprint
  ) values (
    p_request_id,
    v_actor.organization_id,
    p_actor_user_id,
    v_before.id,
    v_action,
    v_fingerprint
  );

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
    v_actor.organization_id,
    p_actor_user_id,
    'talent_review_queue',
    v_before.id,
    v_action,
    jsonb_build_object(
      'status', v_before.status::text,
      'archived', v_before.archived_at is not null,
      'ownerId', v_before.talent_review_owner_id
    ),
    jsonb_build_object(
      'status', v_after.status::text,
      'archived', v_after.archived_at is not null,
      'ownerId', v_after.talent_review_owner_id
    ),
    v_note
  );

  return private.talent_review_queue_json(v_actor.organization_id, v_actor.role);
end;
$$;

revoke all on function public.change_talent_review_stage(uuid, uuid, uuid, timestamptz, text, text)
  from public, anon, authenticated;
grant execute on function public.change_talent_review_stage(uuid, uuid, uuid, timestamptz, text, text)
  to service_role;

-- Queue reviewers may open private applicant documents only inside their own
-- organization. A short-lived signed link is created only after a reviewer
-- clicks a document action.
drop policy if exists "Soro Admin and Talent Management can read documents"
on public.documents;
create policy "Soro Admin and Talent Management can read documents"
on public.documents for select to authenticated
using (
  documents.organization_id = private.current_soro_organization_id()
  and private.current_soro_role() in (
    'admin'::public.platform_role,
    'talent_management'::public.platform_role
  )
);

drop policy if exists "Soro Admin and Talent Management can read private documents"
on storage.objects;
create policy "Soro Admin and Talent Management can read private documents"
on storage.objects for select to authenticated
using (
  bucket_id = 'soro-private-documents'
  and private.current_soro_role() in (
    'admin'::public.platform_role,
    'talent_management'::public.platform_role
  )
  and exists (
    select 1
    from public.documents as document
    where document.storage_path = storage.objects.name
      and document.organization_id = private.current_soro_organization_id()
      and document.status <> 'rejected'::public.document_status
  )
);

-- Admin and Talent Management retain their existing browser access to edit
-- ordinary profile fields. Lifecycle fields are changed only by the audited
-- service RPC above, so a direct browser update cannot bypass stage rules,
-- optimistic concurrency, required notes, or the audit event.
create or replace function private.protect_applicant_review_fields()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is not null
    and (
      new.status is distinct from old.status
      or new.status_reason is distinct from old.status_reason
      or new.archived_at is distinct from old.archived_at
      or new.talent_review_owner_id is distinct from old.talent_review_owner_id
    ) then
    raise exception using
      errcode = '42501',
      message = 'Talent review stages can be changed only through the secure review service.';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_applicant_review_fields on public.applicants;
create trigger protect_applicant_review_fields
before update of status, status_reason, archived_at, talent_review_owner_id
on public.applicants
for each row execute function private.protect_applicant_review_fields();

-- Review decisions and their notes are visible only to Admin and Talent
-- Management, matching the roles allowed to call the workflow RPCs.
drop policy if exists "authorized internal users can read audit history" on public.audit_events;
create policy "authorized internal users can read audit history"
on public.audit_events for select to authenticated
using (
  private.is_internal_soro_user()
  and case
    when entity_type = 'employee_payroll' then
      private.current_soro_role() = 'admin'::public.platform_role
    when entity_type = 'employee' and event_type = 'employee_payment_route_update' then
      private.current_soro_role() = 'admin'::public.platform_role
    when entity_type in (
      'talent_payout',
      'talent_portal_access',
      'talent_attendance',
      'talent_time_off',
      'talent_review_queue'
    ) then
      private.current_soro_role() in (
        'admin'::public.platform_role,
        'talent_management'::public.platform_role
      )
    else true
  end
);

comment on table public.talent_review_operations is
  'Service-only idempotency ledger for organization-scoped Talent application review actions.';
comment on function public.get_talent_review_queue(uuid) is
  'Service-only Admin and Talent Management application review queue derived from the signed-in actor organization.';
comment on function public.change_talent_review_stage(uuid, uuid, uuid, timestamptz, text, text) is
  'Service-only idempotent Talent review transition with optimistic concurrency and audit history.';
