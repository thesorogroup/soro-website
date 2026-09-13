-- Internal, source-labeled observations. No ratings, applicant edits, or live seeds.
begin;
create table private.placement_checkin_plans(
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 placement_id uuid not null, side text not null check(side in('client','talent')),owner_id uuid not null,
 cadence_days integer not null check(cadence_days in(0,7,14,30,90)),next_due date not null,enabled boolean not null default true,
 version integer not null default 1,cycle integer not null default 1,created_by uuid not null references public.platform_users(id),
 created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),
 unique(placement_id,side),foreign key(placement_id,organization_id) references public.placements(id,organization_id),
 foreign key(owner_id,organization_id) references public.platform_users(id,organization_id)
);
create table private.talent_performance_entries(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id),placement_id uuid not null,
 applicant_id uuid not null references public.applicants(id),side text not null check(side in('client','talent')),
 created_by uuid not null references public.platform_users(id),created_at timestamptz not null default clock_timestamp(),version integer not null default 1,
 plan_id uuid references private.placement_checkin_plans(id),cycle integer,
 foreign key(placement_id,organization_id) references public.placements(id,organization_id)
);
create unique index performance_checkin_once on private.talent_performance_entries(plan_id,cycle) where plan_id is not null;
create index performance_applicant_history on private.talent_performance_entries(organization_id,applicant_id,created_at desc,id);
create table private.talent_performance_revisions(
 entry_id uuid not null references private.talent_performance_entries(id),version integer not null,
 observed_on date not null,kind text not null check(kind in('positive','coaching','observation')),
 source text not null check(source in('staff','client','talent')),summary text not null check(length(btrim(summary)) between 1 and 160),
 details text not null check(length(btrim(details)) between 1 and 4000),outcome text not null check(outcome in('going_well','follow_up','urgent')),
 next_action text not null default '' check(length(next_action)<=500),follow_up_on date,correction_reason text check(length(correction_reason)<=500),
 author_id uuid not null references public.platform_users(id),recorded_at timestamptz not null default clock_timestamp(),primary key(entry_id,version)
);
create table private.placement_checkin_tasks(
 plan_id uuid not null references private.placement_checkin_plans(id),cycle integer not null,
 task_id uuid not null unique references public.tasks(id),state text not null default 'open' check(state in('open','completed','cancelled')),
 primary key(plan_id,cycle)
);
create table private.placement_checkin_operations(actor_id uuid not null references public.platform_users(id),request_id uuid not null,
 fingerprint jsonb not null,created_at timestamptz not null default clock_timestamp(),primary key(actor_id,request_id));
alter table private.placement_checkin_plans enable row level security;
alter table private.talent_performance_entries enable row level security;
alter table private.talent_performance_revisions enable row level security;
alter table private.placement_checkin_tasks enable row level security;
alter table private.placement_checkin_operations enable row level security;
revoke all on private.placement_checkin_plans,private.talent_performance_entries,private.talent_performance_revisions,private.placement_checkin_tasks,private.placement_checkin_operations from public,anon,authenticated;
-- Existing task history already renders an absent actor as The Soro Group System.
alter table private.task_history alter column actor_id drop not null;

create function private.checkin_can_read(a public.platform_users,p public.placements,s text) returns boolean
language sql stable security definer set search_path=pg_catalog,public,private as $$
 select a.active and not a.must_change_password and a.organization_id=p.organization_id and s in('client','talent') and
 (a.role in('admin','talent_management') or(a.role='sales' and s='client' and exists(select 1 from public.clients c where c.id=p.client_id and c.organization_id=a.organization_id and c.sales_owner_id=a.id and c.archived_at is null)))
$$;
create function private.checkin_can_write(a public.platform_users,p public.placements,s text) returns boolean
language sql stable security definer set search_path=pg_catalog,public,private as $$
 select private.checkin_can_read(a,p,s) and(a.role='admin' or(a.role='talent_management' and s='talent') or(a.role='sales' and s='client'))
$$;
create function private.checkin_current(p public.placements) returns boolean language sql stable security definer set search_path=pg_catalog,public,private as $$
 select lower(replace(p.status,' ','_')) in('active','live','working','placed') and private.work_log_current(p)
$$;
create function private.checkin_owner_valid(uid uuid,p public.placements,s text) returns boolean language sql stable security definer set search_path=pg_catalog,public,private as $$
 select exists(select 1 from public.platform_users u where u.id=uid and private.checkin_can_write(u,p,s))
$$;
-- One ordinary task points to each occurrence. Private note text never enters tasks.
create function private.checkin_lock_owners(pid uuid,additional_owner uuid default null) returns uuid language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare prior_owner uuid;begin
 select owner_id into prior_owner from private.placement_checkin_plans where id=pid;
 perform 1 from public.platform_users u where u.id=prior_owner or u.id=additional_owner or u.id in(
  select t.assigned_to_user_id from private.placement_checkin_tasks m join public.tasks t on t.id=m.task_id where m.plan_id=pid and m.state='open'
 ) order by u.id for share;
 return prior_owner;
end $$;
create function private.sync_checkin_task(pid uuid,changed_by uuid default null) returns void language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare q private.placement_checkin_plans;p public.placements;m private.placement_checkin_tasks;t public.tasks;tid uuid;label text;renew boolean:=false;prior_owner uuid;
begin
 prior_owner:=private.checkin_lock_owners(pid);
 select * into q from private.placement_checkin_plans where id=pid for update;if not found then return;end if;
 if q.owner_id is distinct from prior_owner then raise exception using errcode='40001';end if;
 select * into p from public.placements where id=q.placement_id;
 select * into m from private.placement_checkin_tasks where plan_id=q.id and cycle=q.cycle;
 if not q.enabled or not private.checkin_current(p) or not private.checkin_owner_valid(q.owner_id,p,q.side) then
  update private.placement_checkin_plans set enabled=false,version=version+1,updated_at=clock_timestamp() where id=q.id and enabled;
  if m.state='open' then
   update public.tasks set status='completed',completed_at=clock_timestamp() where id=m.task_id;
   update private.placement_checkin_tasks set state='cancelled' where task_id=m.task_id;
   update public.task_notifications set read_at=coalesce(read_at,clock_timestamp()) where task_id=m.task_id;
   insert into private.task_history(task_id,actor_id,summary) values(m.task_id,changed_by,'Check-in reminder closed because its schedule, owner, or placement is no longer active. No performance outcome was recorded.');
  end if;return;
 end if;
 if m.state='completed' then return;end if;
 select left(coalesce(a.full_name,'Talent')||' · '||coalesce(c.company_name,'Client'),200) into label from public.applicants a join public.clients c on c.id=p.client_id where a.id=p.applicant_id;
 if m.task_id is null then
  insert into public.tasks(organization_id,title,details,related_label,due_date,priority,created_by_user_id,assigned_to_user_id)
   values(q.organization_id,case q.side when 'client' then 'Complete Client check-in' else 'Complete Talent check-in' end,'Open Check-ins and record the work-related contact outcome. Private notes stay in Performance History.',label,q.next_due,'normal',q.created_by,q.owner_id) returning id into tid;
  insert into private.placement_checkin_tasks(plan_id,cycle,task_id) values(q.id,q.cycle,tid);
  insert into private.task_history(task_id,actor_id,summary) values(tid,changed_by,'Check-in reminder created.');renew:=true;
 else
  tid:=m.task_id;select * into t from public.tasks where id=tid;
  if t.assigned_to_user_id<>q.owner_id or t.due_date is distinct from q.next_due or m.state='cancelled' then
   renew:=t.assigned_to_user_id is distinct from q.owner_id or m.state='cancelled';
   update public.tasks set assigned_to_user_id=q.owner_id,due_date=q.next_due,status='open',completed_at=null where id=tid;
   update private.placement_checkin_tasks set state='open' where task_id=tid;
   update public.task_notifications set read_at=coalesce(read_at,clock_timestamp()) where task_id=tid and recipient_user_id<>q.owner_id;
   insert into private.task_history(task_id,actor_id,summary) values(tid,changed_by,'Check-in schedule or owner updated.');
  end if;
 end if;
 if renew then
  delete from private.task_views where task_id=tid and user_id=q.owner_id;
  insert into public.task_notifications(organization_id,recipient_user_id,task_id) values(q.organization_id,q.owner_id,tid)
  on conflict(task_id,recipient_user_id,notification_type) do update set read_at=null,created_at=clock_timestamp();
 end if;
end $$;

create function public.get_placement_checkins(p_actor_user_id uuid,p_filters jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users;pid uuid;aid uuid;f date;z date;off integer;typ text;result jsonb;placements jsonb;plans jsonb;notes jsonb;cnt integer;today date;talent_name text;
begin
 a:=private.active_support_actor(p_actor_user_id);pid:=(p_filters->>'placementId')::uuid;aid:=(p_filters->>'applicantId')::uuid;
 if a.role not in('admin','talent_management','sales') or(pid is null)=(aid is null) or(aid is not null and a.role='sales') then raise exception using errcode='42501',message='Private staff access required.';end if;
 if jsonb_typeof(p_filters)<>'object' or exists(select 1 from jsonb_object_keys(p_filters) k where k not in('placementId','applicantId','kind','from','to','offset')) then raise exception using errcode='22023';end if;
 f:=nullif(p_filters->>'from','')::date;z:=nullif(p_filters->>'to','')::date;off:=coalesce((p_filters->>'offset')::integer,0);typ:=nullif(p_filters->>'kind','');
 if off<0 or off>1000000 or f>z or(typ is not null and typ not in('positive','coaching','observation')) then raise exception using errcode='22023';end if;
 if pid is not null then
  select p.applicant_id,private.work_log_today(p) into aid,today from public.placements p where p.id=pid and(private.checkin_can_read(a,p,'talent') or private.checkin_can_read(a,p,'client'));
  if not found then raise exception using errcode='42501';end if;
 end if;
 select t.full_name into talent_name from public.applicants t where t.id=aid and t.organization_id=a.organization_id;
 if not found then raise exception using errcode='42501';end if;
 today:=coalesce(today,(statement_timestamp() at time zone 'Asia/Manila')::date);
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'clientName',c.company_name,'canRecord',private.checkin_can_write(a,p,'client') or private.checkin_can_write(a,p,'talent'),
  'canSchedule',private.checkin_current(p) and(private.checkin_can_write(a,p,'client') or private.checkin_can_write(a,p,'talent')),
  'sides',(select jsonb_agg(s) from unnest(array['talent','client']) s where private.checkin_can_write(a,p,s)),
  'owners',(select coalesce(jsonb_agg(jsonb_build_object('id',u.id,'name',coalesce(nullif(u.display_name,''),'Soro Staff'),'sides',(select jsonb_agg(s) from unnest(array['talent','client']) s where private.checkin_owner_valid(u.id,p,s))) order by u.display_name),'[]') from public.platform_users u where u.organization_id=a.organization_id and(private.checkin_owner_valid(u.id,p,'talent') or private.checkin_owner_valid(u.id,p,'client')))) order by p.start_date desc,p.id),'[]') into placements
 from public.placements p join public.clients c on c.id=p.client_id and c.organization_id=p.organization_id where p.organization_id=a.organization_id and p.applicant_id=aid and(pid is null or p.id=pid) and(private.checkin_can_read(a,p,'client') or private.checkin_can_read(a,p,'talent'));
 select coalesce(jsonb_agg(jsonb_build_object('id',q.id,'placementId',q.placement_id,'clientName',c.company_name,'side',q.side,'ownerId',q.owner_id,'ownerName',u.display_name,'nextDue',q.next_due,'cadenceDays',q.cadence_days,'enabled',q.enabled and private.checkin_current(p),'version',q.version,'canManage',private.checkin_can_write(a,p,q.side) and private.checkin_current(p)) order by q.next_due,q.id),'[]') into plans
 from private.placement_checkin_plans q join public.placements p on p.id=q.placement_id join public.clients c on c.id=p.client_id join public.platform_users u on u.id=q.owner_id
 where p.applicant_id=aid and(pid is null or p.id=pid) and private.checkin_can_read(a,p,q.side);
 select count(*) into cnt from private.talent_performance_entries e join private.talent_performance_revisions r on r.entry_id=e.id and r.version=e.version join public.placements p on p.id=e.placement_id
 where e.applicant_id=aid and(pid is null or p.id=pid) and private.checkin_can_read(a,p,e.side) and(typ is null or r.kind=typ) and(f is null or r.observed_on>=f) and(z is null or r.observed_on<=z);
 select coalesce(jsonb_agg(x.payload order by x.observed_on desc,x.created_at desc,x.id),'[]') into notes from(
 select r.observed_on,e.created_at,e.id,jsonb_build_object('id',e.id,'placementId',p.id,'clientName',c.company_name,'side',e.side,'observedOn',r.observed_on,'kind',r.kind,'source',r.source,'summary',r.summary,'details',r.details,'outcome',r.outcome,'nextAction',r.next_action,'followUpOn',r.follow_up_on,'version',r.version,'recordedAt',r.recorded_at,'authorName',u.display_name,'correctionReason',r.correction_reason,
 'canCorrect',private.checkin_can_write(a,p,e.side) and(a.role='admin' or e.created_by=a.id),
 'revisions',(select coalesce(jsonb_agg(jsonb_build_object('summary',old.summary,'details',old.details,'kind',old.kind,'source',old.source,'outcome',old.outcome,'observedOn',old.observed_on,'nextAction',old.next_action,'followUpOn',old.follow_up_on,'correctionReason',old.correction_reason,'authorName',author.display_name,'recordedAt',old.recorded_at,'version',old.version) order by old.version desc),'[]') from private.talent_performance_revisions old join public.platform_users author on author.id=old.author_id where old.entry_id=e.id and old.version<e.version)) payload
 from private.talent_performance_entries e join private.talent_performance_revisions r on r.entry_id=e.id and r.version=e.version join public.placements p on p.id=e.placement_id join public.clients c on c.id=p.client_id join public.platform_users u on u.id=r.author_id
 where e.applicant_id=aid and(pid is null or p.id=pid) and private.checkin_can_read(a,p,e.side) and(typ is null or r.kind=typ) and(f is null or r.observed_on>=f) and(z is null or r.observed_on<=z)
 order by r.observed_on desc,e.created_at desc,e.id limit 30 offset off)x;
 return jsonb_build_object('viewerRole',a.role,'subject',case when pid is null then 'talent' else 'placement' end,'talentName',talent_name,'today',today,'placements',placements,'plans',plans,'notes',notes,'total',cnt);
end $$;

create function public.change_placement_checkin(p_actor_user_id uuid,p_action text,p_body jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users;p public.placements;q private.placement_checkin_plans;e private.talent_performance_entries;
 rid uuid;sid text;expected integer;old jsonb;tid uuid;note_id uuid;observed date;due date;owner uuid;cadence integer;keys text[];locked_org uuid;
begin
 a:=private.active_support_actor(p_actor_user_id);rid:=(p_body->>'requestId')::uuid;sid:=p_body->>'side';expected:=(p_body->>'version')::integer;
 if p_action not in('schedule','record','correct') or p_action is distinct from p_body->>'action' or jsonb_typeof(p_body)<>'object' or rid is null or expected is null or expected<0 then raise exception using errcode='22023';end if;
 keys:=case when p_action='schedule' then array['action','requestId','placementId','side','version','ownerId','nextDue','cadenceDays','enabled'] else array['action','requestId','placementId','side','version','noteId','planId','planVersion','observedOn','kind','source','summary','details','outcome','nextAction','followUpOn','correctionReason'] end;
 if (select count(*) from jsonb_object_keys(p_body))<>array_length(keys,1) or exists(select 1 from jsonb_object_keys(p_body) k where not(k=any(keys))) then raise exception using errcode='22023';end if;
 locked_org:=a.organization_id;perform pg_advisory_xact_lock(hashtextextended('staff-ownership:'||locked_org::text,0));
 select * into a from public.platform_users where id=p_actor_user_id for share;
 perform private.active_support_actor(p_actor_user_id);
 if a.organization_id is distinct from locked_org then raise exception using errcode='42501';end if;
 select * into p from public.placements where id=(p_body->>'placementId')::uuid for update;
 if not found or not private.checkin_can_write(a,p,sid) then raise exception using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(a.id::text||rid::text,0));
 select fingerprint into old from private.placement_checkin_operations where actor_id=a.id and request_id=rid;
 if found then if old is distinct from p_body then raise exception using errcode='23505';end if;return jsonb_build_object('saved',true);end if;
 if p_action='schedule' then
  owner:=(p_body->>'ownerId')::uuid;due:=(p_body->>'nextDue')::date;cadence:=(p_body->>'cadenceDays')::integer;
  perform private.checkin_lock_owners((select id from private.placement_checkin_plans where placement_id=p.id and side=sid),owner);
  if not private.checkin_current(p) or not private.checkin_owner_valid(owner,p,sid) or due is null or cadence is null or cadence not in(0,7,14,30,90) or jsonb_typeof(p_body->'enabled')<>'boolean' then raise exception using errcode='22023';end if;
  select * into q from private.placement_checkin_plans where placement_id=p.id and side=sid for update;
  if coalesce(q.version,0)<>expected then raise exception using errcode='40001';end if;
  if q.id is null then
   insert into private.placement_checkin_plans(organization_id,placement_id,side,owner_id,cadence_days,next_due,enabled,created_by) values(a.organization_id,p.id,sid,owner,cadence,due,(p_body->>'enabled')::boolean,a.id) returning * into q;
  else
   update private.placement_checkin_plans set owner_id=owner,cadence_days=cadence,next_due=due,enabled=(p_body->>'enabled')::boolean,version=version+1,updated_at=clock_timestamp() where id=q.id returning * into q;
  end if;perform private.sync_checkin_task(q.id,a.id);
 else
  observed:=(p_body->>'observedOn')::date;
  if observed is null or observed>private.work_log_today(p) or observed<p.start_date or(p.end_date is not null and observed>p.end_date) or coalesce(length(btrim(p_body->>'summary')),0) not between 1 and 160 or coalesce(length(btrim(p_body->>'details')),0) not between 1 and 4000 or length(p_body->>'nextAction')>500 or p_body->>'kind' not in('positive','coaching','observation') or p_body->>'source' not in('staff','client','talent') or p_body->>'outcome' not in('going_well','follow_up','urgent') then raise exception using errcode='22023';end if;
  if p_action='correct' then
   if p_body->>'planId' is not null or coalesce((p_body->>'planVersion')::integer,-1)<>0 or coalesce(length(btrim(p_body->>'correctionReason')),0) not between 1 and 500 then raise exception using errcode='22023';end if;
   select * into e from private.talent_performance_entries where id=(p_body->>'noteId')::uuid and placement_id=p.id and side=sid for update;
   if not found or(a.role<>'admin' and e.created_by<>a.id) then raise exception using errcode='42501';end if;
   if e.version<>expected then raise exception using errcode='40001';end if;
   update private.talent_performance_entries set version=version+1 where id=e.id returning * into e;
  else
   if expected<>0 or p_body->>'noteId' is not null or p_body->>'correctionReason' is not null then raise exception using errcode='22023';end if;
   if p_body->>'planId' is not null then
    perform private.checkin_lock_owners((p_body->>'planId')::uuid);
    select * into q from private.placement_checkin_plans where id=(p_body->>'planId')::uuid and placement_id=p.id and side=sid for update;
    if not found or not q.enabled or not private.checkin_current(p) then raise exception using errcode='22023';end if;
    if q.version is distinct from (p_body->>'planVersion')::integer then raise exception using errcode='40001';end if;
   elsif coalesce((p_body->>'planVersion')::integer,-1)<>0 then raise exception using errcode='22023';end if;
   insert into private.talent_performance_entries(organization_id,placement_id,applicant_id,side,created_by,plan_id,cycle) values(a.organization_id,p.id,p.applicant_id,sid,a.id,q.id,q.cycle) returning * into e;
  end if;
  insert into private.talent_performance_revisions(entry_id,version,observed_on,kind,source,summary,details,outcome,next_action,follow_up_on,correction_reason,author_id)
   values(e.id,e.version,observed,p_body->>'kind',p_body->>'source',btrim(p_body->>'summary'),btrim(p_body->>'details'),p_body->>'outcome',coalesce(p_body->>'nextAction',''),(p_body->>'followUpOn')::date,p_body->>'correctionReason',a.id);
  if q.id is not null then
   select task_id into tid from private.placement_checkin_tasks where plan_id=q.id and cycle=q.cycle;
   if tid is not null then
    update public.tasks set status='completed',completed_at=clock_timestamp() where id=tid;
    update private.placement_checkin_tasks set state='completed' where task_id=tid;
    update public.task_notifications set read_at=coalesce(read_at,clock_timestamp()) where task_id=tid;
    insert into private.task_history(task_id,actor_id,summary) values(tid,a.id,'Check-in recorded. The private observation is retained in Performance History.');
   end if;
   update private.placement_checkin_plans set next_due=private.work_log_today(p)+cadence_days,enabled=cadence_days>0,cycle=cycle+1,version=version+1,updated_at=clock_timestamp() where id=q.id;
   perform private.sync_checkin_task(q.id,a.id);
  end if;
 end if;
 insert into private.placement_checkin_operations(actor_id,request_id,fingerprint) values(a.id,rid,p_body);
 return jsonb_build_object('saved',true);
end $$;

-- Existing detail/history behavior is retained; only managed check-in tasks differ.
alter function private.task_readable(public.platform_users,public.tasks) rename to task_readable_before_checkins;
create function private.task_readable(a public.platform_users,t public.tasks) returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare q private.placement_checkin_plans;p public.placements;
begin
 select plan.* into q from private.placement_checkin_tasks m join private.placement_checkin_plans plan on plan.id=m.plan_id where m.task_id=t.id;
 if not found then return private.task_readable_before_checkins(a,t);end if;
 select * into p from public.placements where id=q.placement_id;
 return private.checkin_can_read(a,p,q.side) and(a.role='admin' or t.assigned_to_user_id=a.id or t.created_by_user_id=a.id);
end $$;
alter function private.task_json(public.platform_users,public.tasks) rename to task_json_before_checkins;
create function private.task_json(a public.platform_users,t public.tasks) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare v jsonb;q private.placement_checkin_plans;p public.placements;m private.placement_checkin_tasks;
begin
 v:=private.task_json_before_checkins(a,t);select * into m from private.placement_checkin_tasks where task_id=t.id;
 if not found then return v;end if;select * into q from private.placement_checkin_plans where id=m.plan_id;select * into p from public.placements where id=q.placement_id;
 return v||jsonb_build_object('source',jsonb_build_object('kind','placement_checkin','placementId',p.id,'applicantId',p.applicant_id,'planId',q.id,'side',q.side,'state',m.state),'canEditDetails',false,'canUpdateProgress',false,'canAssign',false);
end $$;
alter function public.task_detail(uuid,uuid,text,integer,uuid,jsonb) rename to task_detail_before_checkins;
create function public.task_detail(p_actor_user_id uuid,p_task_id uuid,p_action text,p_expected_version integer default null,p_request_id uuid default null,p_patch jsonb default '{}') returns jsonb language plpgsql security definer set search_path=pg_catalog,public,private as $$
begin
 if p_action='save' and exists(select 1 from private.placement_checkin_tasks where task_id=p_task_id) then raise exception using errcode='42501',message='Record the check-in outcome to complete its task.';end if;
 return public.task_detail_before_checkins(p_actor_user_id,p_task_id,p_action,p_expected_version,p_request_id,p_patch);
end $$;
-- No backfill. Changes to an existing configured placement keep reminders current.
create function private.checkin_placement_changed() returns trigger language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare q record;begin
 for q in select id from private.placement_checkin_plans where placement_id=new.id loop
  perform private.sync_checkin_task(q.id);
 end loop;return new;
end $$;
create trigger checkin_placement_changed after update of status,start_date,end_date on public.placements for each row execute function private.checkin_placement_changed();
create function private.checkin_client_owner_changed() returns trigger language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare q record;begin
 perform 1 from public.platform_users u where u.id=new.sales_owner_id or u.id in(
  select plan.owner_id from private.placement_checkin_plans plan join public.placements p on p.id=plan.placement_id where p.client_id=new.id
  union select t.assigned_to_user_id from private.placement_checkin_tasks m join private.placement_checkin_plans plan on plan.id=m.plan_id join public.placements p on p.id=plan.placement_id join public.tasks t on t.id=m.task_id where p.client_id=new.id and m.state='open'
 ) order by u.id for share;
 for q in select plan.id from private.placement_checkin_plans plan join public.placements p on p.id=plan.placement_id join public.platform_users u on u.id=plan.owner_id where p.client_id=new.id and plan.side='client' and u.role='sales' loop
  if new.sales_owner_id is not null then update private.placement_checkin_plans set owner_id=new.sales_owner_id,version=version+1 where id=q.id;else update private.placement_checkin_plans set enabled=false,version=version+1 where id=q.id;end if;
  perform private.sync_checkin_task(q.id);
 end loop;return new;
end $$;
create trigger checkin_client_owner_changed after update of sales_owner_id on public.clients for each row when(old.sales_owner_id is distinct from new.sales_owner_id) execute function private.checkin_client_owner_changed();
create function private.checkin_eligibility_changed() returns trigger language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare q record;begin
 for q in select plan.id from private.placement_checkin_plans plan join public.placements p on p.id=plan.placement_id
 where (tg_table_name='platform_users' and plan.owner_id=new.id)
    or (tg_table_name='applicants' and p.applicant_id=new.id)
    or (tg_table_name='clients' and p.client_id=new.id) loop
  perform private.sync_checkin_task(q.id);
 end loop;return new;
end $$;
create trigger checkin_owner_eligibility after update of active,role,must_change_password,organization_id on public.platform_users for each row execute function private.checkin_eligibility_changed();
create trigger checkin_applicant_archival after update of archived_at on public.applicants for each row execute function private.checkin_eligibility_changed();
create trigger checkin_client_archival after update of archived_at on public.clients for each row execute function private.checkin_eligibility_changed();
revoke all on function private.checkin_lock_owners(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function private.checkin_can_read(public.platform_users,public.placements,text),private.checkin_can_write(public.platform_users,public.placements,text),private.checkin_current(public.placements),private.checkin_owner_valid(uuid,public.placements,text),private.sync_checkin_task(uuid,uuid),private.checkin_placement_changed(),private.checkin_client_owner_changed(),private.checkin_eligibility_changed(),private.task_readable_before_checkins(public.platform_users,public.tasks),private.task_json_before_checkins(public.platform_users,public.tasks),private.task_readable(public.platform_users,public.tasks),private.task_json(public.platform_users,public.tasks),public.task_detail_before_checkins(uuid,uuid,text,integer,uuid,jsonb),public.task_detail(uuid,uuid,text,integer,uuid,jsonb),public.get_placement_checkins(uuid,jsonb),public.change_placement_checkin(uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.get_placement_checkins(uuid,jsonb),public.change_placement_checkin(uuid,text,jsonb),public.task_detail(uuid,uuid,text,integer,uuid,jsonb) to service_role;
commit;
