-- Explicit, audited review deferrals. Evidence stays honest; a task is only a reminder.
-- Requires review metadata 072 and task collaboration 068. No applicant backfill.
begin;

create table private.talent_review_deferrals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  applicant_id uuid not null references public.applicants(id) on delete cascade,
  item_key text not null check (item_key in (
    'core_profile','resume','english','disc','enneagram','mbti','internet','equipment','skills','interview','references'
  )),
  reason text not null check (char_length(btrim(reason)) between 1 and 500),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  due_date date,
  task_id uuid,
  active boolean not null default true,
  closed_at timestamptz,
  closed_by uuid references public.platform_users(id) on delete restrict,
  closed_reason text check (closed_reason in ('restored','completed')),
  constraint talent_review_deferral_creator_org foreign key(created_by,organization_id)
    references public.platform_users(id,organization_id) on delete restrict,
  constraint talent_review_deferral_applicant_org foreign key(applicant_id,organization_id)
    references public.applicants(id,organization_id) on delete cascade,
  constraint talent_review_deferral_task_org foreign key(task_id,organization_id)
    references public.tasks(id,organization_id) on delete restrict,
  constraint talent_review_deferral_task_date check ((task_id is null) = (due_date is null)),
  constraint talent_review_deferral_closed check (
    (active and closed_at is null and closed_by is null and closed_reason is null)
    or (not active and closed_at is not null and closed_reason is not null)
  )
);
create unique index talent_review_deferrals_active on private.talent_review_deferrals(organization_id,applicant_id,item_key) where active;
create index talent_review_deferrals_history on private.talent_review_deferrals(applicant_id,created_at desc);
create unique index talent_review_deferrals_task on private.talent_review_deferrals(task_id) where task_id is not null;

-- Keep this privacy classification even if an applicant is permanently deleted.
-- The surviving task may still contain its private review reason.
create table private.talent_review_followup_tasks (
  task_id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  foreign key(task_id,organization_id) references public.tasks(id,organization_id) on delete cascade
);

create table private.talent_review_deferral_operations (
  request_id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  actor_id uuid not null references public.platform_users(id) on delete restrict,
  applicant_id uuid not null references public.applicants(id) on delete cascade,
  fingerprint jsonb not null,
  deferral_id uuid not null references private.talent_review_deferrals(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp()
);
alter table private.talent_review_deferrals enable row level security;
alter table private.talent_review_deferral_operations enable row level security;
alter table private.talent_review_followup_tasks enable row level security;
revoke all on private.talent_review_deferrals,private.talent_review_deferral_operations,private.talent_review_followup_tasks from public,anon,authenticated,service_role;

-- Retain the current evidence calculation and add real staff-verified skills as
-- another valid skills source. This never copies skills into applicant reports.
alter function private.talent_review_checklist_json(uuid,uuid) rename to talent_review_checklist_before_deferrals;
alter function private.talent_verification_gate_json(uuid,uuid) rename to talent_verification_gate_before_deferrals;

create function private.talent_review_source_checklist_json(p_applicant_id uuid,p_organization_id uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog,public,private as $$
  select coalesce(jsonb_agg(case when item->>'key'='skills' then item||jsonb_build_object(
    'label','Skills','state',case when item->>'state'='complete' or exists(
      select 1 from public.applicants a cross join lateral unnest(coalesce(a.verified_skills,'{}'::text[])) skill
      where a.id=p_applicant_id and a.organization_id=p_organization_id
        and nullif(regexp_replace(skill,'^[[:space:]]+|[[:space:]]+$','','g'),'') is not null
    ) then 'complete' else 'missing' end) else item end order by ordinal),'[]'::jsonb)
  from jsonb_array_elements(private.talent_review_checklist_before_deferrals(p_applicant_id,p_organization_id)) with ordinality as source(item,ordinal);
$$;

create function private.talent_review_source_items_json(p_applicant_id uuid,p_organization_id uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog,public,private as $$
  select private.talent_review_source_checklist_json(p_applicant_id,p_organization_id)
    || jsonb_build_array(
      jsonb_build_object('key','interview','label','Internal interview','state',case when (gate->>'interviewAddressed')::boolean then 'complete' else 'missing' end),
      jsonb_build_object('key','references','label','Employment references','state',case when (gate->>'referencesAddressed')::boolean then 'complete' else 'missing' end)
    )
  from (select private.talent_verification_gate_before_deferrals(p_applicant_id,p_organization_id) gate) source;
$$;

create function private.talent_review_deferral_json(p_applicant_id uuid,p_organization_id uuid,p_item_key text)
returns jsonb language sql stable security definer set search_path=pg_catalog,public,private as $$
  select jsonb_build_object('id',d.id,'reason',d.reason,'createdAt',d.created_at,
    'createdByName',coalesce(nullif(btrim(u.display_name),''),'Soro team member'),'dueDate',d.due_date,'taskId',d.task_id)
  from private.talent_review_deferrals d join public.platform_users u on u.id=d.created_by
  where d.applicant_id=p_applicant_id and d.organization_id=p_organization_id and d.item_key=p_item_key and d.active;
$$;

create function private.talent_review_checklist_json(p_applicant_id uuid,p_organization_id uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog,public,private as $$
  select coalesce(jsonb_agg(item||case when item->>'state'<>'complete' and deferral is not null
    then jsonb_build_object('deferral',deferral) else '{}'::jsonb end order by ordinal),'[]'::jsonb)
  from jsonb_array_elements(private.talent_review_source_checklist_json(p_applicant_id,p_organization_id)) with ordinality source(item,ordinal)
  cross join lateral (select private.talent_review_deferral_json(p_applicant_id,p_organization_id,item->>'key') deferral) d;
$$;

create function private.talent_verification_gate_json(p_applicant_id uuid,p_organization_id uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog,public,private as $$
  with source as (select private.talent_verification_gate_before_deferrals(p_applicant_id,p_organization_id) gate),
  effective as (select gate,
    case when not (gate->>'interviewAddressed')::boolean then private.talent_review_deferral_json(p_applicant_id,p_organization_id,'interview') end interview,
    case when not (gate->>'referencesAddressed')::boolean then private.talent_review_deferral_json(p_applicant_id,p_organization_id,'references') end refs from source)
  select gate||jsonb_build_object(
    'benchReadyEligible',((gate->>'interviewAddressed')::boolean or interview is not null) and ((gate->>'referencesAddressed')::boolean or refs is not null),
    'deferrals',jsonb_build_object('interview',interview,'references',refs),
    'blockers',case when (gate->>'interviewAddressed')::boolean or interview is not null then '[]'::jsonb else jsonb_build_array('Interview must be addressed') end
      ||case when (gate->>'referencesAddressed')::boolean or refs is not null then '[]'::jsonb else jsonb_build_array('Employment references must be addressed') end
  ) from effective;
$$;

create function public.get_talent_review_deferrals(p_actor_user_id uuid,p_applicant_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare a record;p public.applicants;items jsonb;
begin
  select * into a from private.talent_review_actor(p_actor_user_id);
  select * into p from public.applicants where id=p_applicant_id and organization_id=a.organization_id;
  if not found then raise exception using errcode='42501',message='This Talent application is not available to your account.';end if;
  select jsonb_agg(jsonb_build_object('key',item->>'key','label',item->>'label',
    'status',case when item->>'state'='complete' then 'complete' when deferral is not null then 'deferred' else 'pending' end,
    'deferral',case when item->>'state'='complete' then null else deferral end) order by ordinal) into items
  from jsonb_array_elements(private.talent_review_source_items_json(p.id,p.organization_id)) with ordinality source(item,ordinal)
  cross join lateral (select private.talent_review_deferral_json(p.id,p.organization_id,item->>'key') deferral) d;
  return jsonb_build_object('applicantId',p.id,'updatedAt',p.updated_at,'items',items);
end $$;

-- Evidence completion retires the waiver permanently, without changing a score,
-- skill, interview outcome, reference result or optional reminder-task status.
create function private.close_completed_talent_review_deferrals(p_applicant_id uuid,p_organization_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare d private.talent_review_deferrals;actor uuid;changed boolean:=false;
begin
  if not exists(select 1 from private.talent_review_deferrals where applicant_id=p_applicant_id and organization_id=p_organization_id and active) then return;end if;
  perform 1 from public.applicants where id=p_applicant_id and organization_id=p_organization_id for update;
  if not found then return;end if;
  select u.id into actor from public.platform_users u where u.id=auth.uid() and u.organization_id=p_organization_id and u.active and not u.must_change_password and u.role in('admin','talent_management');
  for d in select deferral.* from private.talent_review_deferrals deferral
    where deferral.applicant_id=p_applicant_id and deferral.organization_id=p_organization_id and deferral.active
      and exists(select 1 from jsonb_array_elements(private.talent_review_source_items_json(p_applicant_id,p_organization_id)) item
        where item->>'key'=deferral.item_key and item->>'state'='complete') for update
  loop
    update private.talent_review_deferrals set active=false,closed_at=clock_timestamp(),closed_by=actor,closed_reason='completed' where id=d.id;
    insert into public.audit_events(organization_id,actor_user_id,entity_type,entity_id,event_type,before_value,after_value,note)
      values(p_organization_id,actor,'talent_review_queue',p_applicant_id,'review_deferral_completed',
        jsonb_build_object('deferralId',d.id,'itemKey',d.item_key,'active',true),jsonb_build_object('deferralId',d.id,'itemKey',d.item_key,'active',false),
        'The deferred requirement now has its required evidence. Its history is retained; no verification result was changed.');
    changed:=true;
  end loop;
  if changed then update public.applicants set updated_at=clock_timestamp() where id=p_applicant_id;end if;
end $$;

create function private.sync_completed_talent_review_deferrals()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare prior jsonb;current_record jsonb;prior_id uuid;current_id uuid;
begin
  if tg_op<>'INSERT' then prior:=to_jsonb(old);prior_id:=case when tg_table_name='applicants' then (prior->>'id')::uuid else (prior->>'applicant_id')::uuid end;end if;
  if tg_op<>'DELETE' then current_record:=to_jsonb(new);current_id:=case when tg_table_name='applicants' then (current_record->>'id')::uuid else (current_record->>'applicant_id')::uuid end;end if;
  if prior_id is not null and (prior_id is distinct from current_id or prior->>'organization_id' is distinct from current_record->>'organization_id') then
    perform private.close_completed_talent_review_deferrals(prior_id,(prior->>'organization_id')::uuid);
  end if;
  if current_id is not null then perform private.close_completed_talent_review_deferrals(current_id,(current_record->>'organization_id')::uuid);end if;
  if tg_op='DELETE' then return old;end if;return new;
end $$;
create trigger sync_completed_talent_review_deferrals after update on public.applicants for each row execute function private.sync_completed_talent_review_deferrals();
create trigger sync_completed_talent_review_deferrals after insert or update or delete on public.documents for each row execute function private.sync_completed_talent_review_deferrals();
create trigger sync_completed_talent_review_deferrals after insert or update or delete on public.talent_interviews for each row execute function private.sync_completed_talent_review_deferrals();
create trigger sync_completed_talent_review_deferrals after insert or update or delete on public.talent_reference_checks for each row execute function private.sync_completed_talent_review_deferrals();

create function public.manage_talent_review_deferral(
  p_actor_user_id uuid,p_request_id uuid,p_applicant_id uuid,p_expected_updated_at timestamptz,
  p_item_key text,p_action text,p_reason text,p_due_date date,p_create_task boolean
)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a record;p public.applicants;d private.talent_review_deferrals;replay private.talent_review_deferral_operations;
  fingerprint jsonb;item jsonb;reason text:=nullif(btrim(p_reason),'');tid uuid;prior_status public.applicant_status;org uuid;
begin
  if p_request_id is null or p_applicant_id is null or p_expected_updated_at is null or p_create_task is null
    or p_action is null or p_action not in('defer','restore')
    or p_item_key is null or p_item_key not in('core_profile','resume','english','disc','enneagram','mbti','internet','equipment','skills','interview','references') then
    raise exception using errcode='22023',message='Choose a valid review requirement and action.';
  end if;
  if reason is null or char_length(reason)>500 then raise exception using errcode='22023',message='Add a reason of 1 to 500 characters.';end if;
  if (p_create_task and p_due_date is null) or (not p_create_task and p_due_date is not null)
    or (p_action='restore' and (p_create_task or p_due_date is not null)) then
    raise exception using errcode='22023',message='A follow-up task requires a due date; restoring a requirement does not create a task.';
  end if;
  select * into a from private.talent_review_actor(p_actor_user_id);org:=a.organization_id;
  perform pg_advisory_xact_lock(hashtextextended('staff-ownership:'||org,0));
  perform pg_advisory_xact_lock(hashtextextended('talent-review-deferral:'||p_request_id,0));
  perform 1 from public.platform_users where id=p_actor_user_id for share;
  select * into a from private.talent_review_actor(p_actor_user_id);
  if a.organization_id is distinct from org then raise exception using errcode='P0001',message='Your workspace changed. Reload the queue.';end if;
  fingerprint:=jsonb_build_object('applicantId',p_applicant_id,'updatedAt',p_expected_updated_at,'itemKey',p_item_key,
    'action',p_action,'reason',reason,'dueDate',p_due_date,'createTask',p_create_task);
  select * into replay from private.talent_review_deferral_operations where request_id=p_request_id;
  if found then
    if replay.organization_id<>a.organization_id or replay.actor_id<>p_actor_user_id or replay.applicant_id<>p_applicant_id or replay.fingerprint<>fingerprint then
      raise exception using errcode='22023',message='This request id has already been used for another review action.';
    end if;
    return private.talent_review_queue_json(a.organization_id,a.role);
  end if;
  select * into p from public.applicants where id=p_applicant_id and organization_id=a.organization_id for update;
  if not found then raise exception using errcode='42501',message='This Talent application is not available to your account.';end if;
  if p.updated_at is distinct from p_expected_updated_at then raise exception using errcode='P0001',message='This Talent application changed after it was opened.';end if;
  if p.archived_at is not null or p.status not in('submitted','in_review','needs_more_info','bench_ready') then
    raise exception using errcode='P0001',message='Review requirements cannot be changed in this Talent profile stage.';
  end if;
  select value into item from jsonb_array_elements(private.talent_review_source_items_json(p.id,p.organization_id)) where value->>'key'=p_item_key;
  if item is null or item->>'state'='complete' then raise exception using errcode='P0001',message='This review requirement is already complete.';end if;
  select * into d from private.talent_review_deferrals where applicant_id=p.id and organization_id=p.organization_id and item_key=p_item_key and active for update;
  prior_status:=p.status;
  if p_action='defer' then
    if d.id is not null then raise exception using errcode='P0001',message='This review requirement is already deferred.';end if;
    if p_create_task then
      insert into public.tasks(organization_id,title,details,related_label,due_date,priority,created_by_user_id,assigned_to_user_id)
        values(p.organization_id,'Complete deferred review: '||(item->>'label'),
          'Open Talent Review for '||p.full_name||' and complete '||(item->>'label')||'. Reason for deferral: '||reason||E'\nCompleting this reminder does not verify the requirement.',
          left(p.full_name,200),p_due_date,'normal',p_actor_user_id,p_actor_user_id) returning id into tid;
      insert into private.talent_review_followup_tasks(task_id,organization_id) values(tid,p.organization_id);
      insert into private.task_history(task_id,actor_id,summary) values(tid,p_actor_user_id,'Follow-up task created for a deferred Talent review requirement.');
      insert into public.task_notifications(organization_id,recipient_user_id,task_id) values(p.organization_id,p_actor_user_id,tid);
      insert into public.audit_events(organization_id,actor_user_id,entity_type,entity_id,event_type,after_value,note)
        values(p.organization_id,p_actor_user_id,'task',tid,'task_created',jsonb_build_object('applicantId',p.id,'itemKey',p_item_key),'Follow up on a deferred Talent review requirement.');
    end if;
    insert into private.talent_review_deferrals(organization_id,applicant_id,item_key,reason,created_by,due_date,task_id)
      values(p.organization_id,p.id,p_item_key,reason,p_actor_user_id,p_due_date,tid) returning * into d;
  else
    if d.id is null then raise exception using errcode='P0001',message='This review requirement is not deferred.';end if;
    update private.talent_review_deferrals set active=false,closed_at=clock_timestamp(),closed_by=p_actor_user_id,closed_reason='restored' where id=d.id;
    if p.status='bench_ready' then p.status:='in_review';end if;
  end if;
  update public.applicants set status=p.status,
    status_reason=case when prior_status='bench_ready' and p.status='in_review' then 'Deferred review requirement restored: '||(item->>'label') else status_reason end,
    updated_at=clock_timestamp() where id=p.id;
  insert into private.talent_review_deferral_operations(request_id,organization_id,actor_id,applicant_id,fingerprint,deferral_id)
    values(p_request_id,p.organization_id,p_actor_user_id,p.id,fingerprint,d.id);
  insert into public.audit_events(organization_id,actor_user_id,entity_type,entity_id,event_type,before_value,after_value,note)
    values(p.organization_id,p_actor_user_id,'talent_review_queue',p.id,case p_action when 'defer' then 'review_requirement_deferred' else 'review_requirement_restored' end,
      jsonb_build_object('status',prior_status,'itemKey',p_item_key,'deferred',p_action='restore'),
      jsonb_build_object('status',p.status,'itemKey',p_item_key,'deferred',p_action='defer','deferralId',d.id,'taskId',d.task_id,'dueDate',d.due_date),reason);
  return private.talent_review_queue_json(a.organization_id,a.role);
end $$;

-- Keep the existing transition, audit and replay behavior, with one narrow
-- change: a specifically deferred item satisfies its readiness requirement.
create or replace function public.change_talent_review_stage(
  p_actor_user_id uuid,p_request_id uuid,p_applicant_id uuid,p_expected_updated_at timestamptz,p_action text,p_note text
)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,private,extensions as $$
declare v_actor record;v_action text:=lower(btrim(p_action));v_note text:=nullif(btrim(p_note),'');v_fingerprint text;
  v_operation public.talent_review_operations%rowtype;v_before public.applicants%rowtype;v_after public.applicants%rowtype;v_checklist jsonb;v_deferred jsonb;
begin
  if p_request_id is null or p_applicant_id is null or p_expected_updated_at is null then
    raise exception using errcode='22023',message='Request id, Talent application, and expected update time are required.';
  end if;
  if v_action is null or v_action not in('begin_review','request_more_info','mark_bench_ready','return_to_review','decline','archive','restore','reopen') then
    raise exception using errcode='22023',message='Unsupported Talent review action.';
  end if;
  if v_note is not null and char_length(v_note)>500 then raise exception using errcode='22023',message='The review note is too long.';end if;
  if v_action in('request_more_info','decline','archive') and v_note is null then raise exception using errcode='22023',message='A brief note is required for this review action.';end if;
  select * into v_actor from private.talent_review_actor(p_actor_user_id);
  v_fingerprint:=encode(digest(concat_ws('|',v_action,p_applicant_id::text,p_expected_updated_at::text,coalesce(v_note,'')),'sha256'),'hex');
  perform pg_advisory_xact_lock(hashtextextended('talent-review-operation:'||p_request_id::text,0));
  select * into v_operation from public.talent_review_operations where operation_request_id=p_request_id;
  if v_operation.operation_request_id is not null then
    if v_operation.organization_id is distinct from v_actor.organization_id or v_operation.actor_user_id is distinct from p_actor_user_id
      or v_operation.applicant_id is distinct from p_applicant_id or v_operation.action<>v_action or v_operation.request_fingerprint<>v_fingerprint then
      raise exception using errcode='22023',message='This request id has already been used for another review action.';
    end if;
    return private.talent_review_queue_json(v_actor.organization_id,v_actor.role);
  end if;
  select applicant.* into v_before from public.applicants applicant where applicant.id=p_applicant_id and applicant.organization_id=v_actor.organization_id for update;
  if v_before.id is null then raise exception using errcode='42501',message='This Talent application is not available to your account.';end if;
  if v_before.updated_at is distinct from p_expected_updated_at then raise exception using errcode='P0001',message='This Talent application changed after it was opened.';end if;
  if v_action='begin_review' then
    if v_before.archived_at is not null or v_before.status<>'submitted'::public.applicant_status then raise exception using errcode='P0001',message='Only a submitted application can begin review.';end if;
    update public.applicants set status='in_review',status_reason=null,talent_review_owner_id=coalesce(talent_review_owner_id,p_actor_user_id) where id=v_before.id returning * into v_after;
  elsif v_action='request_more_info' then
    if v_before.archived_at is not null or v_before.status not in('submitted'::public.applicant_status,'in_review'::public.applicant_status) then raise exception using errcode='P0001',message='More information can be requested only from a submitted or in-review application.';end if;
    update public.applicants set status='needs_more_info',status_reason=v_note,talent_review_owner_id=coalesce(talent_review_owner_id,p_actor_user_id) where id=v_before.id returning * into v_after;
  elsif v_action='mark_bench_ready' then
    if v_before.archived_at is not null or v_before.status<>'in_review'::public.applicant_status then raise exception using errcode='P0001',message='Only an in-review application can be marked Bench Ready.';end if;
    v_checklist:=private.talent_review_checklist_json(v_before.id,v_before.organization_id);
    if jsonb_array_length(v_checklist)<>9 or exists(select 1 from jsonb_array_elements(v_checklist) item where item->>'state'<>'complete' and not(item?'deferral')) then
      raise exception using errcode='P0001',message='Required review sources are still missing.';
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('itemKey',d.item_key,'deferralId',d.id) order by d.item_key),'[]'::jsonb) into v_deferred
      from private.talent_review_deferrals d where d.applicant_id=v_before.id and d.organization_id=v_before.organization_id and d.active
      and exists(select 1 from jsonb_array_elements(private.talent_review_source_items_json(v_before.id,v_before.organization_id)) item where item->>'key'=d.item_key and item->>'state'<>'complete');
    update public.applicants set status='bench_ready',status_reason=null,talent_review_owner_id=coalesce(talent_review_owner_id,p_actor_user_id) where id=v_before.id returning * into v_after;
  elsif v_action='return_to_review' then
    if v_before.archived_at is not null or v_before.status not in('needs_more_info'::public.applicant_status,'bench_ready'::public.applicant_status) then raise exception using errcode='P0001',message='Only Needs More Information or Bench Ready can return to review.';end if;
    update public.applicants set status='in_review',status_reason=null,talent_review_owner_id=coalesce(talent_review_owner_id,p_actor_user_id) where id=v_before.id returning * into v_after;
  elsif v_action='decline' then
    if v_before.archived_at is not null or v_before.status not in('submitted'::public.applicant_status,'in_review'::public.applicant_status,'needs_more_info'::public.applicant_status,'bench_ready'::public.applicant_status) then raise exception using errcode='P0001',message='This application cannot be declined from its current stage.';end if;
    update public.applicants set status='not_selected',status_reason=v_note,talent_review_owner_id=coalesce(talent_review_owner_id,p_actor_user_id) where id=v_before.id returning * into v_after;
  elsif v_action='archive' then
    if v_before.archived_at is not null then raise exception using errcode='P0001',message='This application is already archived.';end if;
    update public.applicants set archived_at=clock_timestamp() where id=v_before.id returning * into v_after;
  elsif v_action='restore' then
    if v_before.archived_at is null then raise exception using errcode='P0001',message='Only an archived application can be restored.';end if;
    update public.applicants set archived_at=null where id=v_before.id returning * into v_after;
  elsif v_action='reopen' then
    if v_before.archived_at is not null or v_before.status<>'not_selected'::public.applicant_status then raise exception using errcode='P0001',message='Only a declined application can be reopened.';end if;
    update public.applicants set status='in_review',status_reason=null,talent_review_owner_id=coalesce(talent_review_owner_id,p_actor_user_id) where id=v_before.id returning * into v_after;
  end if;
  insert into public.talent_review_operations(operation_request_id,organization_id,actor_user_id,applicant_id,action,request_fingerprint)
    values(p_request_id,v_actor.organization_id,p_actor_user_id,v_before.id,v_action,v_fingerprint);
  insert into public.audit_events(organization_id,actor_user_id,entity_type,entity_id,event_type,before_value,after_value,note)
    values(v_actor.organization_id,p_actor_user_id,'talent_review_queue',v_before.id,v_action,
      jsonb_build_object('status',v_before.status::text,'archived',v_before.archived_at is not null,'ownerId',v_before.talent_review_owner_id),
      jsonb_build_object('status',v_after.status::text,'archived',v_after.archived_at is not null,'ownerId',v_after.talent_review_owner_id)
        ||case when v_action='mark_bench_ready' then jsonb_build_object('deferredRequirements',coalesce(v_deferred,'[]'::jsonb)) else '{}'::jsonb end,v_note);
  return private.talent_review_queue_json(v_actor.organization_id,v_actor.role);
end $$;

-- Deferral reasons stay in the Admin/Talent Management audience even after a
-- reminder is restored/completed, reassigned, or its creator changes roles.
alter function private.task_readable(public.platform_users,public.tasks) rename to task_readable_before_review_deferrals;
create function private.task_readable(a public.platform_users,t public.tasks)
returns boolean language sql stable security definer set search_path=pg_catalog,public,private as $$
  select private.task_readable_before_review_deferrals(a,t)
    and (not exists(select 1 from private.talent_review_followup_tasks where task_id=t.id)
      or (a.role in('admin','talent_management') and exists(
        select 1 from private.talent_review_followup_tasks d where d.task_id=t.id and d.organization_id=a.organization_id
      )));
$$;
alter function public.task_detail(uuid,uuid,text,integer,uuid,jsonb) rename to task_detail_before_review_deferrals;
create function public.task_detail(p_actor_user_id uuid,p_task_id uuid,p_action text,p_expected_version integer default null,p_request_id uuid default null,p_patch jsonb default '{}')
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a record;d private.talent_review_followup_tasks;v jsonb;
begin
  select * into d from private.talent_review_followup_tasks where task_id=p_task_id;
  if d.task_id is not null then
    select * into a from private.talent_review_actor(p_actor_user_id);
    if a.organization_id is distinct from d.organization_id then raise exception using errcode='42501',message='Task unavailable.';end if;
    perform pg_advisory_xact_lock(hashtextextended('staff-ownership:'||a.organization_id,0));
    if p_action='save' and p_patch?'assigneeIds' then
      if jsonb_typeof(p_patch->'assigneeIds')<>'array' then raise exception using errcode='22023',message='Choose assignees.';end if;
      perform 1 from public.platform_users where id in(select value::uuid from jsonb_array_elements_text(p_patch->'assigneeIds')) order by id for share;
      if exists(select 1 from jsonb_array_elements_text(p_patch->'assigneeIds') x where not exists(
        select 1 from public.platform_users u where u.id=x::uuid and u.organization_id=a.organization_id and u.active and not u.must_change_password and u.role in('admin','talent_management')
      )) then raise exception using errcode='42501',message='Deferred review follow-up tasks can be assigned only to active Admin or Talent Management accounts.';end if;
    end if;
  end if;
  v:=public.task_detail_before_review_deferrals(p_actor_user_id,p_task_id,p_action,p_expected_version,p_request_id,p_patch);
  if d.task_id is not null then
    v:=jsonb_set(v,'{assignees}',coalesce((select jsonb_agg(x) from jsonb_array_elements(v->'assignees') x where x->>'role' in('admin','talent_management')),'[]'::jsonb));
  end if;
  return v;
end $$;

-- Existing Talent activity access already restricts talent_review_queue to
-- Admin and Talent Management. Add readable labels for the new retained events.
alter function private.activity_catalog(text,text) rename to activity_catalog_before_review_deferrals;
create function private.activity_catalog(t text,e text) returns jsonb language sql immutable set search_path=pg_catalog,private as $$
  select case when t='talent_review_queue' and e in('review_requirement_deferred','review_requirement_restored','review_deferral_completed') then
    jsonb_build_object('action',case e when 'review_requirement_deferred' then 'Review requirement deferred' when 'review_requirement_restored' then 'Deferred requirement restored' else 'Deferred requirement completed' end,'category','review','external',false)
    else private.activity_catalog_before_review_deferrals(t,e) end;
$$;

revoke all on function private.talent_review_source_checklist_json(uuid,uuid),private.talent_review_source_items_json(uuid,uuid),
  private.talent_review_deferral_json(uuid,uuid,text),private.talent_review_checklist_json(uuid,uuid),private.talent_verification_gate_json(uuid,uuid),
  private.close_completed_talent_review_deferrals(uuid,uuid),private.sync_completed_talent_review_deferrals(),private.activity_catalog(text,text)
  from public,anon,authenticated,service_role;
revoke all on function private.task_readable_before_review_deferrals(public.platform_users,public.tasks),private.task_readable(public.platform_users,public.tasks),
  public.task_detail_before_review_deferrals(uuid,uuid,text,integer,uuid,jsonb),public.task_detail(uuid,uuid,text,integer,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.task_detail(uuid,uuid,text,integer,uuid,jsonb) to service_role;
revoke all on function public.get_talent_review_deferrals(uuid,uuid),public.manage_talent_review_deferral(uuid,uuid,uuid,timestamptz,text,text,text,date,boolean)
  from public,anon,authenticated;
grant execute on function public.get_talent_review_deferrals(uuid,uuid),public.manage_talent_review_deferral(uuid,uuid,uuid,timestamptz,text,text,text,date,boolean) to service_role;
revoke all on function public.change_talent_review_stage(uuid,uuid,uuid,timestamptz,text,text) from public,anon,authenticated;
grant execute on function public.change_talent_review_stage(uuid,uuid,uuid,timestamptz,text,text) to service_role;
commit;
