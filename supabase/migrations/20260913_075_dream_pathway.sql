-- Private Dream planning. No funding awards, payroll, or live sample records.
begin;
create table private.dream_plans(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id),
 applicant_id uuid not null unique references public.applicants(id),title text not null check(length(btrim(title)) between 1 and 160),
 description text not null check(length(description)<=4000),owner_id uuid not null,anchor_date date not null,review_cycle integer not null default 0 check(review_cycle>=0),
 status text not null default 'active' check(status in('active','paused')),version integer not null default 1,
 created_by uuid not null references public.platform_users(id),updated_at timestamptz not null default clock_timestamp(),
 unique(id,organization_id),foreign key(owner_id,organization_id) references public.platform_users(id,organization_id)
);
create table private.dream_milestones(
 id uuid primary key default gen_random_uuid(),plan_id uuid not null references private.dream_plans(id),
 title text not null check(length(btrim(title)) between 1 and 160),description text not null check(length(description)<=3000),
 position integer not null check(position between 1 and 100),target_date date,status text not null check(status in('planned','in_progress','completed','paused')),
 progress_note text not null default '' check(length(progress_note)<=3000),updated_at timestamptz not null default clock_timestamp(),unique(id,plan_id)
);
create table private.dream_tasks(
 task_id uuid primary key references public.tasks(id),plan_id uuid not null references private.dream_plans(id),milestone_id uuid,
 review_cycle integer,foreign key(milestone_id,plan_id) references private.dream_milestones(id,plan_id)
);
create unique index dream_review_task_once on private.dream_tasks(plan_id,review_cycle) where review_cycle is not null;
create table private.dream_meetings(
 id uuid primary key default gen_random_uuid(),plan_id uuid not null references private.dream_plans(id),kind text not null check(kind in('quarterly','follow_up')),
 review_cycle integer,status text not null default 'scheduled' check(status in('scheduled','completed','cancelled')),
 starts_at timestamptz not null,duration_minutes integer not null check(duration_minutes in(30,45,60)),timezone text not null,
 attendees jsonb not null check(jsonb_typeof(attendees)='array'),summary text not null default '' check(length(summary)<=4000),
 calendar_status text not null default 'pending' check(calendar_status in('pending','synced','sync_failed','connection_required')),
 calendar_action text not null default 'create' check(calendar_action in('create','cancel','read')),
 calendar_request_id uuid,calendar_started_at timestamptz,calendar_attempted boolean not null default false,calendar_prior_attempted boolean not null default false,
 event_id text,join_url text,organizer_id text,created_by uuid not null references public.platform_users(id),created_at timestamptz not null default clock_timestamp()
);
create unique index dream_quarter_meeting_once on private.dream_meetings(plan_id,review_cycle) where kind='quarterly' and not(status='cancelled' and calendar_status='synced');
create table private.dream_history(id bigint generated always as identity primary key,plan_id uuid not null references private.dream_plans(id),actor_id uuid not null references public.platform_users(id),summary text not null,details jsonb not null default '{}',created_at timestamptz not null default clock_timestamp());
create table private.dream_operations(actor_id uuid not null references public.platform_users(id),request_id uuid not null,fingerprint jsonb not null,meeting_id uuid references private.dream_meetings(id),primary key(actor_id,request_id));
alter table private.dream_plans enable row level security;
alter table private.dream_milestones enable row level security;
alter table private.dream_tasks enable row level security;
alter table private.dream_meetings enable row level security;
alter table private.dream_history enable row level security;
alter table private.dream_operations enable row level security;
revoke all on private.dream_plans,private.dream_milestones,private.dream_tasks,private.dream_meetings,private.dream_history,private.dream_operations from public,anon,authenticated;

create function private.dream_applicant(uid uuid,aid uuid,writing boolean default false) returns public.applicants
language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users;p public.applicants;
begin
 a:=private.dc_actor(uid);select * into p from public.applicants where id=aid and organization_id=a.organization_id and archived_at is null;
 if not found then raise exception using errcode='42501';end if;
 if a.role in('admin','talent_management') then return p;end if;
 if not writing and a.role='virtual_assistant' and p.auth_user_id=a.id and p.portal_access_status='active' and (select count(*) from public.applicants where auth_user_id=a.id and organization_id=a.organization_id and portal_access_status='active' and archived_at is null)=1 then return p;end if;
 raise exception using errcode='42501';
end $$;

create function public.get_dream_pathway(p_actor_user_id uuid,p_applicant_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users;p public.applicants;q private.dream_plans;staff boolean;milestones jsonb;meetings jsonb;tasks jsonb;hist jsonb;team jsonb;
begin
 p:=private.dream_applicant(p_actor_user_id,p_applicant_id);a:=private.dc_actor(p_actor_user_id);staff:=a.role in('admin','talent_management');
 select * into q from private.dream_plans where applicant_id=p.id and organization_id=p.organization_id;
 select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'title',m.title,'description',m.description,'position',m.position,'targetDate',m.target_date,'status',m.status,'progressNote',m.progress_note) order by m.position,m.id),'[]') into milestones from private.dream_milestones m where m.plan_id=q.id;
 select coalesce(jsonb_agg(item order by starts_at desc,id),'[]') into meetings from (select m.id,m.starts_at,jsonb_build_object('id',m.id,'kind',m.kind,'status',m.status,'startsAt',m.starts_at,'durationMinutes',m.duration_minutes,'timezone',m.timezone,'summary',m.summary,'calendarStatus',m.calendar_status,'joinUrl',case when m.status='scheduled' then m.join_url end,'attendeeNames',(select coalesce(jsonb_agg(x->>'name'),'[]') from jsonb_array_elements(m.attendees) x)) item from private.dream_meetings m where m.plan_id=q.id order by m.starts_at desc,m.id limit 100) x;
 if staff then
  select coalesce(jsonb_agg(x||jsonb_build_object('ready',not u.must_change_password)),'[]') into team from jsonb_array_elements(private.talent_interview_staff(a.organization_id)) x join public.platform_users u on u.id=(x->>'id')::uuid;
  select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'title',t.title,'status',t.status,'dueDate',t.due_date,'canOpen',private.task_readable(a,t),'milestoneId',l.milestone_id,'milestoneTitle',(select title from private.dream_milestones where id=l.milestone_id),'reviewCycle',l.review_cycle) order by t.due_date,t.id),'[]') into tasks from private.dream_tasks l join public.tasks t on t.id=l.task_id where l.plan_id=q.id;
  select coalesce(jsonb_agg(jsonb_build_object('summary',h.summary,'at',h.created_at,'actorName',u.display_name) order by h.id desc),'[]') into hist from (select * from private.dream_history where plan_id=q.id order by id desc limit 100) h join public.platform_users u on u.id=h.actor_id;
 end if;
 return jsonb_build_object('applicantId',p.id,'canManage',staff,'dream',p.greatest_dream,'plan',case when q.id is null then null else jsonb_build_object('id',q.id,'title',q.title,'description',q.description,'ownerId',q.owner_id,'ownerName',(select display_name from public.platform_users where id=q.owner_id),'anchorDate',q.anchor_date,'nextReviewOn',(q.anchor_date+make_interval(months=>q.review_cycle*3))::date,'status',q.status,'version',q.version) end,'milestones',milestones,'tasks',coalesce(tasks,'[]'),'meetings',meetings,'history',coalesce(hist,'[]'),'staff',coalesce(team,'[]'));
end $$;

-- Quarterly preparation is a workflow-owned ordinary My Tasks item.
create function private.dream_review_task(pid uuid,actor_id uuid) returns void language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare q private.dream_plans;tid uuid;due date;prior uuid;was_closed boolean:=false;renew boolean:=false;
begin
 select * into q from private.dream_plans where id=pid;due:=(q.anchor_date+make_interval(months=>q.review_cycle*3))::date;
 select task_id into tid from private.dream_tasks where plan_id=q.id and review_cycle=q.review_cycle;
 if q.status='paused' then
  if tid is not null then update public.tasks set status='completed',progress='completed',completed_at=clock_timestamp() where id=tid;update public.task_notifications set read_at=coalesce(read_at,clock_timestamp()) where task_id=tid;end if;return;
 end if;
 perform 1 from public.platform_users where id=q.owner_id and organization_id=q.organization_id and active and not must_change_password and role in('admin','talent_management') for share;
 if not found then raise exception using errcode='22023',message='Choose an active Admin or Talent Management pathway guide first.';end if;
 if tid is null then
  insert into public.tasks(organization_id,title,details,related_label,due_date,priority,created_by_user_id,assigned_to_user_id)
  values(q.organization_id,'Complete Dream Check-In','Open the Talent profile, then Benefits → Dream Pathway. Schedule the review and record the agreed summary there. Keep private Dream details in the pathway.',(select left(full_name,200) from public.applicants where id=q.applicant_id),due,'normal',q.created_by,q.owner_id) returning id into tid;
  insert into private.dream_tasks(task_id,plan_id,review_cycle) values(tid,q.id,q.review_cycle);
  insert into private.task_history(task_id,actor_id,summary) values(tid,actor_id,'Quarterly Dream check-in task created.');
 else
  select assigned_to_user_id,status='completed' into prior,was_closed from public.tasks where id=tid;
  renew:=prior is distinct from q.owner_id or was_closed;
  update public.tasks set assigned_to_user_id=q.owner_id,due_date=due,status='open',progress='not_started',completed_at=null where id=tid;
  if prior is distinct from q.owner_id then update public.task_notifications set read_at=coalesce(read_at,clock_timestamp()) where task_id=tid and recipient_user_id<>q.owner_id;end if;
 end if;
 insert into public.task_notifications(organization_id,recipient_user_id,task_id) values(q.organization_id,q.owner_id,tid) on conflict(task_id,recipient_user_id,notification_type) do nothing;
 if renew then
  update public.task_notifications set read_at=null,created_at=clock_timestamp() where task_id=tid and recipient_user_id=q.owner_id;
  delete from private.task_views where task_id=tid and user_id=q.owner_id;
  insert into private.task_history(task_id,actor_id,summary) values(tid,actor_id,'Quarterly reminder reassigned or reactivated from Dream Pathway.');
 end if;
end $$;

create function public.change_dream_pathway(p_actor_user_id uuid,p_body jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users;p public.applicants;q private.dream_plans;m private.dream_milestones;meeting private.dream_meetings;old private.dream_operations;
 aid uuid:=(p_body->>'applicantId')::uuid;rid uuid:=(p_body->>'requestId')::uuid;act text:=p_body->>'action';mid uuid;tid uuid;ids uuid[];attendees jsonb;uid uuid;expected integer:=(p_body->>'version')::integer;label text;org uuid;pos integer;milestone_count integer;
begin
 a:=private.dc_actor(p_actor_user_id);org:=a.organization_id;
 perform pg_advisory_xact_lock(hashtextextended('staff-ownership:'||org,0));
 perform pg_advisory_xact_lock(hashtextextended('dream-request:'||p_actor_user_id||':'||rid,0));
 perform pg_advisory_xact_lock(hashtextextended('dream-applicant:'||aid,0));
 perform 1 from public.platform_users where id=p_actor_user_id for share;
 a:=private.dc_actor(p_actor_user_id);if a.organization_id is distinct from org then raise exception using errcode='40001';end if;
 perform 1 from public.applicants where id=aid and organization_id=org for share;
 p:=private.dream_applicant(a.id,aid,true);
 if rid is null or expected is null or expected<0 then raise exception using errcode='22023';end if;
 select * into old from private.dream_operations where actor_id=a.id and request_id=rid;
 if found then if old.fingerprint<>p_body then raise exception using errcode='23505';end if;return jsonb_build_object('meetingId',old.meeting_id);end if;
 select * into q from private.dream_plans where applicant_id=p.id for update;
 if coalesce(q.version,0)<>expected then raise exception using errcode='40001';end if;
 if act='plan' then
  uid:=(p_body->>'ownerId')::uuid;
  perform 1 from public.platform_users where id=uid and organization_id=p.organization_id and active and not must_change_password and role in('admin','talent_management') for share;
  if not found then raise exception using errcode='42501';end if;
  if coalesce(length(btrim(p_body->>'title')),0) not between 1 and 160 or coalesce(length(btrim(p_body->>'description')),0) not between 1 and 4000 or p_body->>'status' not in('active','paused') or p_body->>'anchorDate' is null then raise exception using errcode='22023';end if;
  if q.id is null then insert into private.dream_plans(organization_id,applicant_id,title,description,owner_id,anchor_date,status,created_by) values(p.organization_id,p.id,btrim(p_body->>'title'),btrim(p_body->>'description'),uid,(p_body->>'anchorDate')::date,p_body->>'status',a.id) returning * into q;
  else
   if q.anchor_date is distinct from (p_body->>'anchorDate')::date then raise exception using errcode='22023',message='The original review anchor is retained to preserve quarterly periods.';end if;
   update private.dream_plans set title=btrim(p_body->>'title'),description=btrim(p_body->>'description'),owner_id=uid,status=p_body->>'status',version=version+1,updated_at=clock_timestamp() where id=q.id returning * into q;
  end if;perform private.dream_review_task(q.id,a.id);label:='Pathway plan updated.';
 else
  if q.id is null then raise exception using errcode='22023';end if;
  if act='milestone' then
   if coalesce(length(btrim(p_body->>'title')),0) not between 1 and 160 or coalesce(length(btrim(p_body->>'description')),0) not between 1 and 3000 or length(p_body->>'progressNote')>3000 or p_body->>'status' not in('planned','in_progress','completed','paused') then raise exception using errcode='22023';end if;
   mid:=(p_body->>'milestoneId')::uuid;
   pos:=(p_body->>'position')::integer;if pos is null or pos not between 1 and 100 then raise exception using errcode='22023';end if;
   select count(*) into milestone_count from private.dream_milestones where plan_id=q.id;
   if mid is null then
    if milestone_count>=100 then raise exception using errcode='22023';end if;pos:=least(pos,milestone_count+1);
    update private.dream_milestones set position=position+1 where plan_id=q.id and position>=pos;
    insert into private.dream_milestones(plan_id,title,description,position,target_date,status,progress_note) values(q.id,btrim(p_body->>'title'),btrim(p_body->>'description'),pos,(p_body->>'targetDate')::date,p_body->>'status',coalesce(p_body->>'progressNote',''));
   else
    select * into m from private.dream_milestones where id=mid and plan_id=q.id;if not found then raise exception using errcode='42501';end if;pos:=least(pos,milestone_count);
    update private.dream_milestones set position=position+case when pos<m.position then 1 else -1 end where plan_id=q.id and id<>mid and ((pos<m.position and position>=pos and position<m.position) or(pos>m.position and position>m.position and position<=pos));
    update private.dream_milestones set title=btrim(p_body->>'title'),description=btrim(p_body->>'description'),position=pos,target_date=(p_body->>'targetDate')::date,status=p_body->>'status',progress_note=coalesce(p_body->>'progressNote',''),updated_at=clock_timestamp() where id=mid and plan_id=q.id;
    if not found then raise exception using errcode='42501';end if;
   end if;label:='Milestone updated.';
  elsif act='task' then
   select array_agg(value::uuid order by ord) into ids from jsonb_array_elements_text(p_body->'assigneeIds') with ordinality x(value,ord);
   if coalesce(cardinality(ids),0) not between 1 and 30 or cardinality(ids)<>(select count(distinct v) from unnest(ids) v) then raise exception using errcode='22023';end if;
   perform 1 from public.platform_users where id=any(ids) order by id for share;
   if exists(select 1 from unnest(ids) x where not exists(select 1 from public.platform_users u where u.id=x and u.organization_id=a.organization_id and u.active and not u.must_change_password and u.role in('admin','talent_management'))) then raise exception using errcode='42501';end if;
   mid:=(p_body->>'milestoneId')::uuid;if mid is not null and not exists(select 1 from private.dream_milestones where id=mid and plan_id=q.id) then raise exception using errcode='42501';end if;
   insert into public.tasks(organization_id,title,details,related_label,due_date,priority,created_by_user_id,assigned_to_user_id) values(a.organization_id,btrim(p_body->>'title'),p_body->>'details',left(p.full_name,200),(p_body->>'dueDate')::date,'normal',a.id,ids[1]) returning id into tid;
   insert into private.dream_tasks(task_id,plan_id,milestone_id) values(tid,q.id,mid);
   insert into private.task_additional_assignees(task_id,organization_id,assigned_to_user_id) select tid,a.organization_id,x from unnest(ids) x where x<>ids[1];
   insert into private.task_history(task_id,actor_id,summary) values(tid,a.id,'Dream Pathway follow-up created.');
   insert into public.task_notifications(organization_id,recipient_user_id,task_id) select a.organization_id,x,tid from unnest(ids) x;label:='Staff follow-up task created.';
  elsif act='meeting' then
   if exists(select 1 from private.dream_meetings where plan_id=q.id and status='cancelled' and calendar_status<>'synced') then raise exception using errcode='40001',message='Finish the pending calendar cancellation before scheduling another meeting.';end if;
   if q.status<>'active' or p_body->>'kind' not in('quarterly','follow_up') or (p_body->>'startsAt')::timestamptz<clock_timestamp() or (p_body->>'startsAt')::timestamptz>clock_timestamp()+interval '2 years' or not exists(select 1 from pg_timezone_names where name=p_body->>'timezone') then raise exception using errcode='22023';end if;
   if btrim(p.email) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or p.email is null then raise exception using errcode='22023';end if;
   attendees:=private.resolve_talent_interview_attendees(a.organization_id,'00000000-0000-0000-0000-000000000000',p_body->'attendeeIds');
   if jsonb_array_length(attendees)=0 then raise exception using errcode='22023';end if;
   attendees:=jsonb_build_array(jsonb_build_object('id',p.auth_user_id,'name',p.full_name,'email',lower(btrim(p.email))))||attendees;
   insert into private.dream_meetings(plan_id,kind,review_cycle,starts_at,duration_minutes,timezone,attendees,created_by) values(q.id,p_body->>'kind',case when p_body->>'kind'='quarterly' then q.review_cycle end,(p_body->>'startsAt')::timestamptz,(p_body->>'durationMinutes')::integer,p_body->>'timezone',attendees,a.id) returning * into meeting;label:='Dream meeting scheduled.';
  elsif act in('complete','cancel','retry_meeting') then
   select * into meeting from private.dream_meetings where id=(p_body->>'meetingId')::uuid and plan_id=q.id for update;if not found then raise exception using errcode='42501';end if;
   if act='complete' then
    if meeting.status<>'scheduled' or meeting.calendar_status<>'synced' or meeting.starts_at>clock_timestamp() or coalesce(length(btrim(p_body->>'summary')),0) not between 1 and 4000 then raise exception using errcode='22023';end if;
    update private.dream_meetings set status='completed',summary=p_body->>'summary' where id=meeting.id;
    if meeting.kind='quarterly' then
     if meeting.review_cycle<>q.review_cycle then raise exception using errcode='40001';end if;
     select task_id into tid from private.dream_tasks where plan_id=q.id and review_cycle=q.review_cycle;
     update public.tasks set status='completed',progress='completed',completed_at=clock_timestamp() where id=tid;
     update public.task_notifications set read_at=coalesce(read_at,clock_timestamp()) where task_id=tid;
     if tid is not null then insert into private.task_history(task_id,actor_id,summary) values(tid,a.id,'Quarterly Dream check-in recorded in Benefits.');end if;
     update private.dream_plans set review_cycle=review_cycle+1 where id=q.id;perform private.dream_review_task(q.id,a.id);
    end if;label:='Dream check-in recorded.';meeting.id:=null;
   elsif act='cancel' then
    if meeting.status<>'scheduled' or (meeting.calendar_attempted and meeting.event_id is null) or (meeting.calendar_started_at>clock_timestamp()-interval '90 seconds' and meeting.calendar_status='pending') then raise exception using errcode='40001';end if;
    update private.dream_meetings set status='cancelled',calendar_action='cancel',calendar_request_id=null,calendar_started_at=null,calendar_status=case when event_id is null then 'synced' else 'pending' end where id=meeting.id;label:='Dream meeting cancelled.';
   else
    if meeting.calendar_status='synced' then raise exception using errcode='22023';end if;label:='Calendar retry requested.';
   end if;
  else raise exception using errcode='22023';end if;
  update private.dream_plans set version=version+1,updated_at=clock_timestamp() where id=q.id;
 end if;
 insert into private.dream_history(plan_id,actor_id,summary,details) values(q.id,a.id,label,p_body-'requestId');
 insert into private.dream_operations(actor_id,request_id,fingerprint,meeting_id) values(a.id,rid,p_body,meeting.id);
 return jsonb_build_object('meetingId',meeting.id);
end $$;

-- Calendar leases make uncertain creates retry with the same Graph transaction ID.
create function public.claim_dream_calendar(p_actor_user_id uuid,p_meeting_id uuid,p_enabled boolean,p_organizer text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare m private.dream_meetings;q private.dream_plans;lease uuid:=gen_random_uuid();
begin
 select * into m from private.dream_meetings where id=p_meeting_id for update;select * into q from private.dream_plans where id=m.plan_id;
 perform private.dream_applicant(p_actor_user_id,q.applicant_id,true);
 if m.status='completed' then return null;end if;
 if m.calendar_status='synced' or(m.calendar_status='pending' and m.calendar_started_at>clock_timestamp()-interval '90 seconds') then return null;end if;
 if not p_enabled then update private.dream_meetings set calendar_status='connection_required' where id=m.id;return null;end if;
 if nullif(btrim(p_organizer),'') is null or length(p_organizer)>1024 then raise exception using errcode='22023';end if;
 update private.dream_meetings set calendar_request_id=lease,calendar_status='pending',calendar_started_at=clock_timestamp(),calendar_prior_attempted=calendar_attempted,calendar_attempted=true,organizer_id=coalesce(organizer_id,p_organizer) where id=m.id returning * into m;
 return jsonb_build_object('meetingId',m.id,'leaseId',lease,'action',case when m.calendar_action='create' and m.event_id is not null then 'read' else m.calendar_action end,'eventId',m.event_id,'organizerId',m.organizer_id,'transactionId',m.id,'startsAt',m.starts_at,'durationMinutes',m.duration_minutes,'timezone',m.timezone,'kind',m.kind,'attendees',m.attendees);
end $$;
create function public.finish_dream_calendar(p_meeting_id uuid,p_lease_id uuid,p_result jsonb) returns boolean
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare m private.dream_meetings;
begin
 select * into m from private.dream_meetings where id=p_meeting_id and calendar_request_id=p_lease_id and calendar_status='pending' for update;if not found then return false;end if;
 if p_result->>'status' not in('synced','sync_failed') then raise exception using errcode='22023';end if;
 if p_result->>'status'='synced' and m.status<>'cancelled' and (nullif(p_result->>'eventId','') is null or coalesce(p_result->>'joinUrl','') !~ '^https://([a-zA-Z0-9-]+\.)*teams\.(microsoft\.com|live\.com|cloud\.microsoft)/') then raise exception using errcode='22023';end if;
 if m.status='cancelled' and m.calendar_action<>'cancel' then raise exception using errcode='22023';end if;
 update private.dream_meetings set calendar_status=p_result->>'status',calendar_request_id=null,calendar_started_at=null,calendar_attempted=case when p_result->>'notCreated'='true' and not calendar_prior_attempted and event_id is null and calendar_action='create' then false else calendar_attempted end,event_id=coalesce(p_result->>'eventId',event_id),join_url=case when status='cancelled' then null else coalesce(p_result->>'joinUrl',join_url) end
 where id=p_meeting_id and calendar_request_id=p_lease_id and calendar_status='pending';return found;
end $$;

-- Ordinary task editing stays in My Tasks; Dream-linked access stays staff-only.
alter function private.task_readable(public.platform_users,public.tasks) rename to task_readable_before_dream;
create function private.task_readable(a public.platform_users,t public.tasks) returns boolean language sql stable security definer set search_path=pg_catalog,public,private as $$
 select private.task_readable_before_dream(a,t) and(not exists(select 1 from private.dream_tasks where task_id=t.id) or(a.role in('admin','talent_management') and exists(select 1 from private.dream_tasks d join private.dream_plans p on p.id=d.plan_id join public.applicants x on x.id=p.applicant_id where d.task_id=t.id and p.organization_id=a.organization_id and x.archived_at is null)))
$$;
alter function private.task_json(public.platform_users,public.tasks) rename to task_json_before_dream;
create function private.task_json(a public.platform_users,t public.tasks) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare d private.dream_tasks;v jsonb;
begin
 v:=private.task_json_before_dream(a,t);select * into d from private.dream_tasks where task_id=t.id;
 if found then
  v:=v||jsonb_build_object('source',jsonb_build_object('kind','dream_pathway','applicantId',(select applicant_id from private.dream_plans where id=d.plan_id),'planId',d.plan_id,'milestoneId',d.milestone_id,'reviewCycle',d.review_cycle));
  if d.review_cycle is not null then v:=v||jsonb_build_object('canEditDetails',false,'canUpdateProgress',false,'canAssign',false);end if;
 end if;return v;
end $$;
create function private.dream_retirement_guard() returns trigger language plpgsql security definer set search_path=pg_catalog,public,private as $$
begin
 if old.retired_at is null and new.retired_at is not null and exists(select 1 from private.dream_plans p join public.applicants x on x.id=p.applicant_id where p.owner_id=old.id and x.archived_at is null) then raise exception using errcode='22023',message='Reassign Dream Pathway guides before retiring this employee.';end if;return new;
end $$;
create trigger dream_retirement_guard before update of retired_at on public.platform_users for each row execute function private.dream_retirement_guard();
revoke all on function private.task_json_before_dream(public.platform_users,public.tasks),private.task_json(public.platform_users,public.tasks),private.dream_retirement_guard() from public,anon,authenticated,service_role;
alter function public.task_detail(uuid,uuid,text,integer,uuid,jsonb) rename to task_detail_before_dream;
create function public.task_detail(p_actor_user_id uuid,p_task_id uuid,p_action text,p_expected_version integer default null,p_request_id uuid default null,p_patch jsonb default '{}') returns jsonb language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users;d private.dream_tasks;v jsonb;
begin
 select * into d from private.dream_tasks where task_id=p_task_id;
 if d.task_id is not null then
  a:=private.dc_actor(p_actor_user_id);perform private.dream_applicant(a.id,(select applicant_id from private.dream_plans where id=d.plan_id),true);
  perform pg_advisory_xact_lock(hashtextextended('staff-ownership:'||a.organization_id,0));
  if p_action='save' and p_patch?'assigneeIds' then perform 1 from public.platform_users where id in(select value::uuid from jsonb_array_elements_text(p_patch->'assigneeIds')) order by id for share;end if;
  if p_action='save' and d.review_cycle is not null then raise exception using errcode='42501',message='Record the quarterly check-in from Dream Pathway in Benefits.';end if;
  if p_action='save' and p_patch?'assigneeIds' and exists(select 1 from jsonb_array_elements_text(p_patch->'assigneeIds') x where not exists(select 1 from public.platform_users u where u.id=x::uuid and u.organization_id=a.organization_id and u.active and not u.must_change_password and u.role in('admin','talent_management'))) then raise exception using errcode='42501';end if;
 end if;
 v:=public.task_detail_before_dream(p_actor_user_id,p_task_id,p_action,p_expected_version,p_request_id,p_patch);
 if d.task_id is not null then
  v:=jsonb_set(v,'{assignees}',coalesce((select jsonb_agg(x) from jsonb_array_elements(v->'assignees') x where x->>'role' in('admin','talent_management')),'[]'));
  if d.review_cycle is not null then v:=jsonb_set(v,'{task}',(v->'task')||jsonb_build_object('canEditDetails',false,'canUpdateProgress',false,'canAssign',false));end if;
 end if;return v;
end $$;
revoke all on function private.dream_applicant(uuid,uuid,boolean),private.dream_review_task(uuid,uuid),private.task_readable_before_dream(public.platform_users,public.tasks),private.task_readable(public.platform_users,public.tasks),public.task_detail_before_dream(uuid,uuid,text,integer,uuid,jsonb),public.task_detail(uuid,uuid,text,integer,uuid,jsonb),public.get_dream_pathway(uuid,uuid),public.change_dream_pathway(uuid,jsonb),public.claim_dream_calendar(uuid,uuid,boolean,text),public.finish_dream_calendar(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.task_detail(uuid,uuid,text,integer,uuid,jsonb),public.get_dream_pathway(uuid,uuid),public.change_dream_pathway(uuid,jsonb),public.claim_dream_calendar(uuid,uuid,boolean,text),public.finish_dream_calendar(uuid,uuid,jsonb) to service_role;
commit;
