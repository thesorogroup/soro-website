-- Manual end-placement workflow. No live seeds, insurer calls, payroll, or account deletion.
begin;
create table public.placement_offboarding(
 placement_id uuid primary key references public.placements(id) on delete restrict,
 organization_id uuid not null references public.organizations(id) on delete restrict,
 status text not null default 'planned' check(status in('planned','completed','cancelled')),
 last_date date not null, reason text not null check(reason in('assignment_complete','client_request','talent_request','role_change','other')),
 note text not null default '' check(char_length(note)<=2000),
 talent_next_step text not null check(talent_next_step in('review','bench')), replacement boolean not null default false,
 checklist jsonb not null default '{"handover":false,"access":false,"time":false}',
 replacement_request_id uuid unique references public.hiring_requests(id) on delete restrict,
 version integer not null default 1 check(version>0),
 created_by uuid not null references public.platform_users(id),updated_by uuid not null references public.platform_users(id),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),completed_at timestamptz,
 check((status='completed')=(completed_at is not null)),check(replacement_request_id is null or(status='completed' and replacement))
);
create table public.placement_offboarding_operations(
 actor_user_id uuid not null references public.platform_users(id),request_id uuid not null,
 placement_id uuid not null references public.placements(id),fingerprint jsonb not null,created_at timestamptz not null default now(),primary key(actor_user_id,request_id)
);
alter table public.placement_offboarding enable row level security;
alter table public.placement_offboarding_operations enable row level security;
revoke all on public.placement_offboarding,public.placement_offboarding_operations from public,anon,authenticated,service_role;
create index placement_offboarding_pending on public.placement_offboarding(organization_id,last_date) where status='planned';

create function private.offboarding_actor(p_user uuid) returns public.platform_users
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users;
begin
 a:=private.active_support_actor(p_user);
 if a.role not in('admin','talent_management') then raise exception using errcode='42501',message='Placement administration unavailable.';end if;
 return a;
end $$;

create function public.get_placement_endings(p_actor_user_id uuid,p_placement_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users;result jsonb;
begin
 a:=private.offboarding_actor(p_actor_user_id);
 if p_placement_id is not null and not exists(select 1 from placements p join applicants t on t.id=p.applicant_id and t.organization_id=p.organization_id join clients c on c.id=p.client_id and c.organization_id=p.organization_id where p.id=p_placement_id and p.organization_id=a.organization_id) then raise exception using errcode='42501',message='Placement unavailable.';end if;
 with allowed as materialized(select p.* from placements p join applicants t on t.id=p.applicant_id and t.organization_id=p.organization_id join clients c on c.id=p.client_id and c.organization_id=p.organization_id
  where p.organization_id=a.organization_id and (p_placement_id is null or p.id=p_placement_id)),
 page as(select p.* from allowed p left join placement_offboarding o on o.placement_id=p.id order by (o.status='planned') desc nulls last,p.created_at desc,p.id limit 200)
 select jsonb_build_object('viewerRole',a.role,'total',(select count(*) from allowed),'placements',coalesce((select jsonb_agg(jsonb_build_object(
  'id',p.id,'applicantId',p.applicant_id,'hiringRequestId',p.hiring_request_id,
  'talentName',coalesce(nullif(t.preferred_name,''),t.full_name),'clientName',c.company_name,'status',p.status,
  'startDate',p.start_date,'endDate',p.end_date,'schedule',coalesce(p.schedule_summary,''),'today',private.work_log_today(p),
  'timezone',coalesce((select name from pg_catalog.pg_timezone_names where name=nullif(btrim(t.timezone),'')),'Asia/Manila'),
  'canPlan',p.status in('active','live','working','placed') and p.end_date is null and p.start_date is not null and p.start_date<=private.work_log_today(p) and t.archived_at is null and c.archived_at is null,
  'openSessions',(select count(*) from talent_attendance_sessions s where s.placement_id=p.id and s.organization_id=p.organization_id and s.checked_out_at is null),
  'healthcareReady',exists(select 1 from talent_healthcare_actions h where h.placement_id=p.id and h.organization_id=p.organization_id and h.applicant_id=p.applicant_id and h.kind='cancellation' and h.status in('completed','not_applicable') and h.resolution in('carrier_confirmed','no_coverage','coverage_continues','reviewed_exception')),
  'ending',case when o.placement_id is null then null else jsonb_build_object('status',o.status,'lastDate',o.last_date,'reason',o.reason,'note',o.note,'talentNextStep',o.talent_next_step,'replacement',o.replacement,'checklist',o.checklist,'version',o.version,'replacementRequestId',o.replacement_request_id) end)
  order by(o.status='planned') desc nulls last,p.created_at desc,p.id) from page p join applicants t on t.id=p.applicant_id join clients c on c.id=p.client_id left join placement_offboarding o on o.placement_id=p.id),'[]'::jsonb)) into result;
 return result;
end $$;

create function public.change_placement_ending(p_actor_user_id uuid,p_action text,p_body jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users;p public.placements;target public.placements;t public.applicants;c public.clients;r public.hiring_requests;
 o public.placement_offboarding;prior public.placement_offboarding_operations;hc public.talent_healthcare_actions;
 rid uuid;ver integer;last_day date;next_request uuid;event_name text;keys text[];replacement_value boolean;check_value jsonb;
begin
 a:=private.offboarding_actor(p_actor_user_id);
 if p_action is null or p_action not in('plan','checklist','complete','cancel','reopen_healthcare') or p_body is null or jsonb_typeof(p_body)<>'object' or octet_length(p_body::text)>12000 then raise exception using errcode='22023',message='Invalid end-placement action.';end if;
 keys:=case p_action when 'plan' then array['requestId','placementId','version','lastDate','reason','note','talentNextStep','replacement'] when 'checklist' then array['requestId','placementId','version','checklist'] when 'complete' then array['requestId','placementId','version','confirm'] else array['requestId','placementId','version'] end;
 if (select array_agg(k order by k) from jsonb_object_keys(p_body) k) is distinct from(select array_agg(k order by k) from unnest(keys) k) then raise exception using errcode='22023',message='Unexpected end-placement fields.';end if;
 rid:=(p_body->>'requestId')::uuid;ver:=(p_body->>'version')::integer;
 if rid is null or ver is null or ver<0 or jsonb_typeof(p_body->'version')<>'number' then raise exception using errcode='22023',message='Invalid end-placement version.';end if;
 perform pg_advisory_xact_lock(hashtextextended('placement-ending-operation:'||a.id::text||':'||rid::text,0));
 select * into target from placements where id=(p_body->>'placementId')::uuid and organization_id=a.organization_id;
 if target.id is null then raise exception using errcode='42501',message='Placement unavailable.';end if;
 -- Same lock order as placement confirmation and Work Log; attendance has its own shared lock.
 if target.hiring_request_id is not null then
  perform pg_advisory_xact_lock(hashtextextended('client-shortlist-request:'||target.hiring_request_id::text,0));
  select * into r from hiring_requests where id=target.hiring_request_id and organization_id=a.organization_id and client_id=target.client_id for update;
  if r.id is null then raise exception using errcode='42501',message='Placement request unavailable.';end if;
 end if;
 select * into c from clients where id=target.client_id and organization_id=a.organization_id for update;
 perform pg_advisory_xact_lock(hashtextextended('client-shortlist-applicant:'||target.applicant_id::text,0));
 perform pg_advisory_xact_lock(hashtextextended('talent-attendance:'||target.applicant_id::text,0));
 select * into t from applicants where id=target.applicant_id and organization_id=a.organization_id for update;
 select * into p from placements where id=target.id for update;
 if p.client_id is distinct from target.client_id or p.applicant_id is distinct from target.applicant_id or p.hiring_request_id is distinct from target.hiring_request_id or p.organization_id is distinct from a.organization_id then raise exception using errcode='40001',message='Placement changed.';end if;
 perform 1 from platform_users where id=a.id for share;a:=private.offboarding_actor(p_actor_user_id);
 if c.id is null or t.id is null or c.archived_at is not null or t.archived_at is not null then raise exception using errcode='42501',message='Current Client and Talent records are required.';end if;
 select * into prior from placement_offboarding_operations where actor_user_id=a.id and request_id=rid;
 if found then
  if prior.placement_id<>p.id or prior.fingerprint<>jsonb_build_object('action',p_action,'body',p_body) then raise exception using errcode='23505',message='Request changed.';end if;
  return public.get_placement_endings(a.id,p.id);
 end if;
 select * into o from placement_offboarding where placement_id=p.id for update;
 if coalesce(o.version,0)<>ver then raise exception using errcode='40001',message='End plan changed.';end if;
 if p.status not in('active','live','working','placed') or p.end_date is not null or p.start_date is null or p.start_date>private.work_log_today(p) or o.status='completed' then raise exception using errcode='23514',message='A current active placement is required.';end if;
 select * into hc from talent_healthcare_actions where placement_id=p.id and organization_id=a.organization_id and applicant_id=t.id and kind='cancellation' for update;
 if p_action='plan' then
  if jsonb_typeof(p_body->'lastDate')<>'string' or p_body->>'lastDate'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or jsonb_typeof(p_body->'replacement')<>'boolean' or jsonb_typeof(p_body->'note')<>'string' or char_length(p_body->>'note')>2000 or p_body->>'note'~'[\x01-\x08\x0b\x0c\x0e-\x1f]' or coalesce(p_body->>'reason','') not in('assignment_complete','client_request','talent_request','role_change','other') or coalesce(p_body->>'talentNextStep','') not in('review','bench') then raise exception using errcode='22023',message='Invalid end plan.';end if;
  last_day:=(p_body->>'lastDate')::date;replacement_value:=(p_body->>'replacement')::boolean;
  if last_day is null or last_day<p.start_date or last_day>'9999-12-31'::date or(replacement_value and r.id is null) then raise exception using errcode='22023',message='Invalid final date or replacement request.';end if;
  if o.last_date is distinct from last_day and hc.status in('completed','not_applicable') and not(o.status='cancelled' and hc.resolution='reviewed_exception' and hc.reference='Offboarding plan cancelled; coverage unchanged.') then raise exception using errcode='P0001',message='Reopen the healthcare review before changing the last date.';end if;
  insert into placement_offboarding(placement_id,organization_id,last_date,reason,note,talent_next_step,replacement,created_by,updated_by)
  values(p.id,a.organization_id,last_day,p_body->>'reason',btrim(p_body->>'note'),p_body->>'talentNextStep',replacement_value,a.id,a.id)
  on conflict(placement_id) do update set status='planned',last_date=excluded.last_date,reason=excluded.reason,note=excluded.note,talent_next_step=excluded.talent_next_step,replacement=excluded.replacement,
   checklist=case when placement_offboarding.status='cancelled' or placement_offboarding.last_date is distinct from excluded.last_date then '{"handover":false,"access":false,"time":false}'::jsonb else placement_offboarding.checklist end,version=placement_offboarding.version+1,updated_by=a.id,updated_at=now();
  -- Proposed date is private until actual completion. No capacity or work eligibility changes here.
  if hc.id is null then
   insert into talent_healthcare_actions(organization_id,applicant_id,placement_id,kind,due_date)values(a.organization_id,t.id,p.id,'cancellation',last_day) returning * into hc;
   insert into talent_healthcare_events(organization_id,applicant_id,actor_user_id,action,work_id,details)values(a.organization_id,t.id,a.id,'workflow_created',hc.id,'{"kind":"cancellation"}');
  elsif o.status='cancelled' and hc.resolution='reviewed_exception' and hc.reference='Offboarding plan cancelled; coverage unchanged.' then
   update talent_healthcare_actions set status='pending',due_date=last_day,effective_date=null,reference='',resolution=null,completed_by=null,completed_at=null,version=version+1,updated_at=now() where id=hc.id;
  elsif hc.status in('pending','in_progress') then update talent_healthcare_actions set due_date=last_day,version=version+1,updated_at=now() where id=hc.id and due_date is distinct from last_day;
  end if;
  event_name:='placement_end_planned';
 elsif p_action='checklist' then
  check_value:=p_body->'checklist';
  if o.status is distinct from 'planned' or jsonb_typeof(check_value)<>'object' or check_value-array['handover','access','time']<>'{}' or not(check_value?&array['handover','access','time']) or exists(select 1 from jsonb_each(check_value) x where jsonb_typeof(x.value)<>'boolean') then raise exception using errcode='22023',message='Invalid closing checklist.';end if;
  update placement_offboarding set checklist=check_value,version=version+1,updated_by=a.id,updated_at=now() where placement_id=p.id;
  event_name:='placement_closing_checks_updated';
 elsif p_action='reopen_healthcare' then
  if o.status is distinct from 'planned' or hc.status is distinct from 'not_applicable' or hc.resolution not in('no_coverage','coverage_continues','reviewed_exception') then raise exception using errcode='P0001',message='Carrier-confirmed cancellation cannot be reopened here. Review coverage with the carrier first.';end if;
  insert into talent_healthcare_events(organization_id,applicant_id,actor_user_id,action,work_id,details)values(a.organization_id,t.id,a.id,'offboarding_review_reopened',hc.id,jsonb_build_object('previousStatus',hc.status,'previousResolution',hc.resolution,'previousReference',hc.reference,'previousEffectiveDate',hc.effective_date,'previousCompletedAt',hc.completed_at));
  update talent_healthcare_actions set status='pending',effective_date=null,reference='',resolution=null,completed_by=null,completed_at=null,version=version+1,updated_at=now() where id=hc.id;
  update placement_offboarding set version=version+1,updated_by=a.id,updated_at=now() where placement_id=p.id;
  event_name:='placement_closing_checks_updated';
 elsif p_action='cancel' then
  if o.status is distinct from 'planned' or hc.id is null or hc.status not in('pending','in_progress') then raise exception using errcode='P0001',message='Review resolved healthcare before cancelling this end plan.';end if;
  update placement_offboarding set status='cancelled',version=version+1,updated_by=a.id,updated_at=now() where placement_id=p.id;
  update talent_healthcare_actions set status='not_applicable',resolution='reviewed_exception',reference='Offboarding plan cancelled; coverage unchanged.',completed_by=a.id,completed_at=now(),version=version+1,updated_at=now() where id=hc.id;
  insert into talent_healthcare_events(organization_id,applicant_id,actor_user_id,action,work_id,details)values(a.organization_id,t.id,a.id,'offboarding_plan_cancelled',hc.id,'{}');
  event_name:='placement_end_plan_cancelled';
 else
  if p_body->'confirm' is distinct from 'true'::jsonb or o.status is distinct from 'planned' then raise exception using errcode='22023',message='Confirm completed offboarding.';end if;
  if o.last_date>private.work_log_today(p) then raise exception using errcode='P0001',message='The last working date has not arrived.';end if;
  if o.checklist is distinct from '{"handover":true,"access":true,"time":true}'::jsonb then raise exception using errcode='P0001',message='Complete all closing checks.';end if;
  if hc.id is null or hc.status not in('completed','not_applicable') or coalesce(hc.resolution,'') not in('carrier_confirmed','no_coverage','coverage_continues','reviewed_exception') then raise exception using errcode='P0001',message='Resolve the healthcare review first.';end if;
  if exists(select 1 from talent_attendance_sessions s where s.placement_id=p.id and s.organization_id=a.organization_id and(s.checked_out_at is null or s.work_date>o.last_date or(s.checked_out_at at time zone s.work_timezone)::date>o.last_date)) then raise exception using errcode='P0001',message='Review open sessions or work recorded after the last date.';end if;
  if exists(select 1 from placements x where x.applicant_id=t.id and x.organization_id=a.organization_id and x.id<>p.id and x.status in('placement_confirmed','matched','onboarding','active','live','working','placed')) or exists(select 1 from client_shortlist_items i where i.applicant_id=t.id and i.organization_id=a.organization_id and i.removed_at is null and i.workflow_state in('active','selected','placed') and not exists(select 1 from client_placement_handoffs h where h.shortlist_item_id=i.id and h.placement_id=p.id and h.organization_id=a.organization_id and h.status='confirmed')) then raise exception using errcode='P0001',message='Resolve the Talent’s other placement or candidate process first.';end if;
  update placements set status='ended',end_date=o.last_date,updated_at=now() where id=p.id;
  update client_shortlist_items i set workflow_state='released',removed_at=now(),removed_by_user_id=a.id,updated_at=now() where i.organization_id=a.organization_id and i.applicant_id=t.id and i.removed_at is null and exists(select 1 from client_placement_handoffs h where h.shortlist_item_id=i.id and h.placement_id=p.id and h.organization_id=a.organization_id and h.status='confirmed');
  update applicants set status=case when o.talent_next_step='bench' then 'bench_ready'::public.applicant_status else 'in_review'::public.applicant_status end,sales_owner_id=null,updated_at=now() where id=t.id;
  if o.replacement then
   if r.id is null or jsonb_typeof(r.required_fields)<>'object' or octet_length(r.required_fields::text)>8192 then raise exception using errcode='22023',message='Review the original hiring requirements before requesting a replacement.';end if;
   insert into hiring_requests(organization_id,client_id,title,status,start_date,number_of_virtual_assistants,budget_status,required_fields)
    values(a.organization_id,c.id,left(r.title,146)||' · Replacement','discovery',null,1,'pending',r.required_fields) returning id into next_request;
  end if;
  update placement_offboarding set status='completed',completed_at=now(),replacement_request_id=next_request,version=version+1,updated_by=a.id,updated_at=now() where placement_id=p.id;
  with cancelled as(update work_screenshot_requests set status='cancelled',updated_at=now() where placement_id=p.id and organization_id=a.organization_id and status='requested' returning id)
  insert into work_log_events(organization_id,placement_id,actor_user_id,action,source_id)select a.organization_id,p.id,a.id,'screenshot_request_cancelled',id from cancelled on conflict(action,source_id) do nothing;
  event_name:='placement_ended';
 end if;
 -- No reason, notes, healthcare details, or checklist values in shared audit rows.
 insert into audit_events(organization_id,actor_user_id,entity_type,entity_id,event_type,after_value)
 values(a.organization_id,a.id,'placement',p.id,event_name,jsonb_build_object('placementId',p.id,'status',case when p_action='complete' then 'ended' else p.status end));
 insert into placement_offboarding_operations(actor_user_id,request_id,placement_id,fingerprint)values(a.id,rid,p.id,jsonb_build_object('action',p_action,'body',p_body));
 return public.get_placement_endings(a.id,p.id);
end $$;

-- Retire completed dependencies without erasing append-only decisions and handoffs.
create function private.offboarding_handoff_closed(p_handoff uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
 select exists(select 1 from client_placement_handoffs h join placements p on p.id=h.placement_id and p.organization_id=h.organization_id join placement_offboarding o on o.placement_id=p.id and o.organization_id=p.organization_id where h.id=p_handoff and h.status='confirmed' and p.status='ended' and p.end_date is not null and o.status='completed');
$$;
do $patch$
declare f text;d text;needle text;
begin
 foreach f in array array['private.guard_hiring_request_workflow_dependencies()','private.guard_client_workflow_dependencies()'] loop
  d:=pg_get_functiondef(f::regprocedure);needle:='and decision.decision = ''selected''';
  if strpos(d,needle)=0 then raise exception 'Selected-decision guard target missing';end if;
  d:=replace(d,needle,needle||' and not exists(select 1 from public.client_placement_handoffs closing where closing.decision_id=decision.id and closing.organization_id=decision.organization_id and private.offboarding_handoff_closed(closing.id))');
  needle:='and handoff.status in (''prepared'', ''confirmed'')';
  if strpos(d,needle)=0 then raise exception 'Handoff guard target missing';end if;
  execute replace(d,needle,needle||' and not private.offboarding_handoff_closed(handoff.id)');
 end loop;
 -- Keep all existing catalog mappings and add only generic lifecycle labels.
 d:=pg_get_functiondef('private.activity_catalog(text,text)'::regprocedure);needle:='(''placement'',''client_placement_activate_placement'',''Placement activated'',''workflow'',true),';
 if strpos(d,needle)=0 then raise exception 'Activity catalog target missing';end if;
 execute replace(d,needle,needle||E'\n (''placement'',''placement_end_planned'',''End placement planned'',''workflow'',false),\n (''placement'',''placement_closing_checks_updated'',''Offboarding checks updated'',''workflow'',false),\n (''placement'',''placement_end_plan_cancelled'',''End placement plan cancelled'',''workflow'',false),\n (''placement'',''placement_ended'',''Placement ended'',''workflow'',true),');
 d:=pg_get_functiondef('private.client_placement_workspace_json(uuid,public.platform_role,uuid,uuid,uuid)'::regprocedure);
 needle:='''startDate'', placement.start_date,';
 if strpos(d,needle)=0 then raise exception 'Placement date projection target missing';end if;
 execute replace(d,needle,needle||' ''endDate'', placement.end_date,');
end $patch$;
revoke all on function private.offboarding_actor(uuid),private.offboarding_handoff_closed(uuid),public.get_placement_endings(uuid,uuid),public.change_placement_ending(uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.get_placement_endings(uuid,uuid),public.change_placement_ending(uuid,text,jsonb) to service_role;
commit;
