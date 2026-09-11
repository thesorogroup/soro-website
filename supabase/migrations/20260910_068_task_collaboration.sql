-- Additive task collaboration. All authorization stays server-side.
begin;
-- Task history contains private instructions. Browser access must use the
-- authorized task/history RPCs, never a broad organization audit-table policy.
create policy "Task audit reads use authorized projections" on public.audit_events as restrictive for select to authenticated using(entity_type<>'task');
create policy "Task audit inserts use trusted writers" on public.audit_events as restrictive for insert to authenticated with check(entity_type<>'task');
create policy "Task audit cannot be edited" on public.audit_events as restrictive for update to authenticated using(entity_type<>'task') with check(entity_type<>'task');
create policy "Task audit cannot be deleted" on public.audit_events as restrictive for delete to authenticated using(entity_type<>'task');
alter table public.tasks add column details text not null default '' check(char_length(details)<=4000);
alter table public.tasks add column progress text not null default 'not_started' check(progress in('not_started','in_progress','blocked','completed'));
alter table public.tasks add column version integer not null default 1;
update public.tasks set progress='completed' where status='completed';
create table private.task_additional_assignees(
 task_id uuid not null,organization_id uuid not null,assigned_to_user_id uuid not null,
 primary key(task_id,assigned_to_user_id),
 foreign key(task_id,organization_id) references public.tasks(id,organization_id) on delete cascade,
 foreign key(assigned_to_user_id,organization_id) references public.platform_users(id,organization_id) on delete restrict
);
create table private.task_views(task_id uuid not null references public.tasks(id) on delete cascade,user_id uuid not null references public.platform_users(id) on delete cascade,viewed_at timestamptz not null default now(),primary key(task_id,user_id));
create table private.task_changes(request_id uuid primary key,actor_id uuid not null references public.platform_users(id),task_id uuid not null references public.tasks(id),fingerprint jsonb not null);
create table private.task_history(id uuid primary key default gen_random_uuid(),task_id uuid not null references public.tasks(id),actor_id uuid not null references public.platform_users(id),created_at timestamptz not null default clock_timestamp(),summary text not null,note text,changes jsonb not null default '{}');
alter table private.task_additional_assignees enable row level security;
alter table private.task_views enable row level security;
alter table private.task_changes enable row level security;
alter table private.task_history enable row level security;
revoke all on private.task_additional_assignees,private.task_views,private.task_changes,private.task_history from public,anon,authenticated;

create function private.task_version() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if new.status='completed' then new.progress:='completed';
 elsif old.status='completed' and new.status='open' and new.progress='completed' then new.progress:='not_started';end if;
 new.version:=old.version+1;return new;
end $$;
create trigger tasks_version before update on public.tasks for each row execute function private.task_version();

create function private.task_member(t public.tasks,u uuid) returns boolean language sql stable security definer set search_path=pg_catalog,public,private as $$
 select t.assigned_to_user_id=u or exists(select 1 from private.task_additional_assignees m where m.task_id=t.id and m.assigned_to_user_id=u and m.organization_id=t.organization_id)
$$;
create function private.task_readable(a public.platform_users,t public.tasks) returns boolean language sql stable security definer set search_path=pg_catalog,public,private as $$
 select a.active and not a.must_change_password and a.organization_id=t.organization_id and a.role in('admin','talent_management','sales','sales_management','billing') and(a.role='admin' or t.created_by_user_id=a.id or private.task_member(t,a.id))
$$;
create function private.task_json(a public.platform_users,t public.tasks) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare people jsonb;managed record;payload jsonb;
begin
 if not private.task_readable(a,t) then raise exception using errcode='42501',message='Task unavailable.';end if;
 select coalesce(jsonb_agg(jsonb_build_object('userId',u.id,'name',coalesce(nullif(u.display_name,''),'Soro employee')) order by u.id=t.assigned_to_user_id desc,u.display_name),'[]') into people from public.platform_users u where u.organization_id=t.organization_id and private.task_member(t,u.id);
 select m.task_id,m.interview_id,i.applicant_id into managed from private.talent_interview_result_tasks m join public.talent_interviews i on i.id=m.interview_id and i.organization_id=t.organization_id where m.task_id=t.id;
 payload:=jsonb_build_object('taskId',t.id,'title',t.title,'details',t.details,'kind','staff_task','relatedLabel',t.related_label,'dueDate',t.due_date,'priority',t.priority,'status',t.status,'progress',t.progress,'version',t.version,'assignees',people,'assignedTo',people->0,'createdBy',(select jsonb_build_object('userId',u.id,'name',coalesce(nullif(u.display_name,''),'Soro employee')) from public.platform_users u where u.id=t.created_by_user_id),'createdAt',t.created_at,'updatedAt',t.updated_at,'completedAt',t.completed_at,'isNew',not exists(select 1 from private.task_views v where v.task_id=t.id and v.user_id=a.id),'canEditDetails',managed.task_id is null and(a.role='admin' or t.created_by_user_id=a.id),'canUpdateProgress',managed.task_id is null);
 if managed.task_id is not null then payload:=payload||jsonb_build_object('source',jsonb_build_object('kind','interview_result','applicantId',managed.applicant_id,'interviewId',managed.interview_id));end if;
 return payload||jsonb_build_object('canAssign',a.role='admin' and managed.task_id is null);
end $$;

create or replace function private.task_workspace_json(p_organization_id uuid,p_actor_user_id uuid,p_actor_role public.platform_role) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users;items jsonb;notices jsonb;people jsonb;counts jsonb;
begin
 select * into a from public.platform_users where id=p_actor_user_id and organization_id=p_organization_id;
 perform private.task_actor(a.id);
 -- My Tasks includes created work, but does not dump every organization task on an Admin.
 select jsonb_build_object('open',count(*) filter(where t.status='open'),'overdue',count(*) filter(where t.status='open' and t.due_date<(clock_timestamp() at time zone 'America/Chicago')::date)) into counts from public.tasks t where private.task_readable(a,t) and(t.created_by_user_id=a.id or private.task_member(t,a.id));
 select coalesce(jsonb_agg(x.payload order by x.status='open' desc,x.due_date nulls last,x.created_at desc),'[]') into items from(select private.task_json(a,t) payload,t.status,t.due_date,t.created_at from public.tasks t where private.task_readable(a,t) and(t.created_by_user_id=a.id or private.task_member(t,a.id)) order by t.status='open' desc,t.due_date nulls last,t.created_at desc limit 1000)x;
 select coalesce(jsonb_agg(x.payload order by x.created_at desc),'[]') into notices from(select n.created_at,jsonb_build_object('notificationId',n.id,'type','task_assigned','taskId',t.id,'title','Task assigned','message',t.title,'relatedLabel',t.related_label,'priority',t.priority,'view','tasks','createdAt',n.created_at,'readAt',n.read_at) payload from public.task_notifications n join public.tasks t on t.id=n.task_id where n.recipient_user_id=a.id and private.task_readable(a,t) order by n.created_at desc limit 1000)x;
 counts:=counts||jsonb_build_object('urgentUnread',(select count(*) from public.task_notifications n join public.tasks t on t.id=n.task_id where n.recipient_user_id=a.id and n.read_at is null and private.task_readable(a,t)));
 select coalesce(jsonb_agg(jsonb_build_object('userId',u.id,'name',coalesce(nullif(u.display_name,''),'Soro employee'),'role',u.role) order by u.display_name),'[]') into people from public.platform_users u where u.organization_id=a.organization_id and u.active and not u.must_change_password and u.role in('admin','talent_management','sales','sales_management','billing') and(a.role='admin' or u.id=a.id);
 return jsonb_build_object('tasks',items,'notifications',notices,'assignees',people,'summary',counts);
end $$;

create function public.task_detail(p_actor_user_id uuid,p_task_id uuid,p_action text,p_expected_version integer default null,p_request_id uuid default null,p_patch jsonb default '{}') returns jsonb language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users;t public.tasks;before_task public.tasks;replay private.task_changes;fingerprint jsonb;ids uuid[];oldids uuid[];u uuid;people jsonb;hist jsonb;summary text;changes jsonb;locked_org uuid;
begin
 select * into a from public.platform_users where id=p_actor_user_id;perform private.task_actor(a.id);
 if p_action in('get','view') then select * into a from public.platform_users where id=p_actor_user_id for share;perform private.task_actor(a.id);end if;
 if p_action not in('get','view','create','save') then raise exception using errcode='22023',message='Unsupported task action.';end if;
 if p_action in('create','save') then
  if p_request_id is null or jsonb_typeof(p_patch)<>'object' then raise exception using errcode='22023',message='Task request required.';end if;
  locked_org:=a.organization_id;
  perform pg_advisory_xact_lock(hashtextextended('staff-ownership:'||locked_org,0));
  perform pg_advisory_xact_lock(hashtextextended('task-edit:'||p_request_id,0));
  select * into a from public.platform_users where id=p_actor_user_id for share;
  perform private.task_actor(a.id);
  if a.organization_id is distinct from locked_org then raise exception using errcode='40001',message='Your workspace changed. Refresh My Tasks.';end if;
  fingerprint:=jsonb_build_object('action',p_action,'taskId',p_task_id,'version',p_expected_version,'patch',p_patch);
  select * into replay from private.task_changes where request_id=p_request_id;
  if found then
   if replay.actor_id<>a.id or replay.fingerprint<>fingerprint then raise exception using errcode='23505',message='Request changed.';end if;
   return public.task_detail(a.id,replay.task_id,'get');
  end if;
 end if;
 if p_action<>'create' then
  select * into t from public.tasks where id=p_task_id for update;
  if not found or not private.task_readable(a,t) then raise exception using errcode='42501',message='Task unavailable.';end if;
 end if;
 if p_action='view' then insert into private.task_views(task_id,user_id) values(t.id,a.id) on conflict do nothing;
 elsif p_action in('save','create') then
  if p_action='save' then
   if exists(select 1 from private.talent_interview_result_tasks m where m.task_id=t.id) then raise exception using errcode='42501',message='Record the interview result to update this task.';end if;
   if p_expected_version is distinct from t.version then raise exception using errcode='40001',message='Task changed.';end if;
   before_task:=t;
   if not(a.role='admin' or t.created_by_user_id=a.id) and (p_patch-'progress'-'note')<>'{}' then raise exception using errcode='42501',message='Only the creator or Admin can edit task details.';end if;
  end if;
  if p_patch ? 'assigneeIds' then
   if jsonb_typeof(p_patch->'assigneeIds')<>'array' then raise exception using errcode='22023',message='Choose assignees.';end if;
   select array_agg(value::uuid order by value::uuid) into ids from jsonb_array_elements_text(p_patch->'assigneeIds');
   if coalesce(cardinality(ids),0) not between 1 and 30 or cardinality(ids)<>(select count(distinct v) from unnest(ids)v) then raise exception using errcode='22023',message='Choose 1 to 30 different assignees.';end if;
   if a.role<>'admin' and ((p_action='create' and ids<>array[a.id]) or(p_action='save' and ids is distinct from(select array_agg(x.id order by x.id) from public.platform_users x where private.task_member(t,x.id)))) then raise exception using errcode='42501',message='Only Admin can change assignments.';end if;
   foreach u in array ids loop
    perform 1 from public.platform_users x where x.id=u and x.organization_id=a.organization_id and x.active and not x.must_change_password and x.role in('admin','sales','sales_management','talent_management','billing') for share;
    if not found then raise exception using errcode='42501',message='Assignee unavailable.';end if;
   end loop;
  elsif p_action='create' then raise exception using errcode='22023',message='Choose assignees.';end if;
  if p_action='create' then
   insert into public.tasks(organization_id,title,details,related_label,due_date,priority,created_by_user_id,assigned_to_user_id) values(a.organization_id,btrim(p_patch->>'title'),coalesce(p_patch->>'details',''),nullif(btrim(p_patch->>'relatedLabel'),''),(p_patch->>'dueDate')::date,p_patch->>'priority',a.id,ids[1]) returning * into t;
   summary:='Task created';
   insert into private.task_views(task_id,user_id) values(t.id,a.id);
  else
   select array_agg(x.id order by x.id) into oldids from public.platform_users x where private.task_member(t,x.id);
   update public.tasks set title=case when p_patch?'title' then btrim(p_patch->>'title') else title end,details=coalesce(p_patch->>'details',details),related_label=case when p_patch?'relatedLabel' then nullif(btrim(p_patch->>'relatedLabel'),'') else related_label end,due_date=case when p_patch?'dueDate' then (p_patch->>'dueDate')::date else due_date end,priority=coalesce(p_patch->>'priority',priority),progress=coalesce(p_patch->>'progress',progress),status=case when p_patch?'progress' then case when p_patch->>'progress'='completed' then 'completed' else 'open' end else status end,completed_at=case when p_patch?'progress' then case when p_patch->>'progress'='completed' then coalesce(completed_at,clock_timestamp()) else null end else completed_at end,assigned_to_user_id=case when ids is null or assigned_to_user_id=any(ids) then assigned_to_user_id else ids[1] end where id=t.id returning * into t;
   summary:='Task updated';
   if t.title is distinct from before_task.title then summary:=summary||' · Title changed';end if;
   if t.details is distinct from before_task.details then summary:=summary||' · Instructions changed';end if;
   if t.related_label is distinct from before_task.related_label then summary:=summary||' · Related record changed';end if;
   if t.due_date is distinct from before_task.due_date then summary:=summary||' · Due date changed';end if;
   if t.priority is distinct from before_task.priority then summary:=summary||' · Priority changed';end if;
   if t.progress<>before_task.progress then summary:=summary||' · '||replace(before_task.progress,'_',' ')||' → '||replace(t.progress,'_',' ');end if;
   if ids is not null and ids is distinct from oldids then summary:=summary||' · Assignment changed';end if;
  end if;
  if ids is not null then
   delete from private.task_additional_assignees where task_id=t.id;
   insert into private.task_additional_assignees(task_id,organization_id,assigned_to_user_id) select t.id,t.organization_id,x from unnest(ids)x where x<>t.assigned_to_user_id;
   foreach u in array ids loop
    if oldids is null or not(u=any(oldids)) then
     insert into public.task_notifications(organization_id,recipient_user_id,task_id) values(t.organization_id,u,t.id) on conflict(task_id,recipient_user_id,notification_type) do update set read_at=null,created_at=clock_timestamp();
     if u<>a.id then delete from private.task_views where task_id=t.id and user_id=u;end if;
    end if;
   end loop;
  end if;
  changes:=jsonb_build_object('before',case when p_action='save' then to_jsonb(before_task) else null end,'after',to_jsonb(t),'previousAssignees',oldids,'assignees',ids);
  insert into private.task_history(task_id,actor_id,summary,note,changes) values(t.id,a.id,summary,nullif(btrim(p_patch->>'note'),''),changes);
  insert into public.audit_events(organization_id,actor_user_id,entity_type,entity_id,event_type,before_value,after_value,note) values(a.organization_id,a.id,'task',t.id,case when p_action='create' then 'task_created' else 'task_updated' end,changes->'before',changes->'after',summary);
  insert into private.task_changes values(p_request_id,a.id,t.id,fingerprint);
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('actor',coalesce(nullif(u.display_name,''),'The Soro Group System'),'at',h.created_at,'summary',h.summary,'note',h.note) order by h.created_at desc,h.id),'[]') into hist from(
  select th.id,th.actor_id,th.created_at,th.summary,th.note from private.task_history th where th.task_id=t.id
  union all select e.id,e.actor_user_id,e.created_at,case e.event_type when 'task_created' then 'Task created' when 'task_completed' then 'Task completed' when 'interview_result_task_created' then 'Interview result task created automatically' when 'interview_result_task_closed' then 'Interview result task closed automatically' else 'Task reopened' end,null from public.audit_events e
   where e.entity_type='task' and e.entity_id=t.id and e.organization_id=t.organization_id and e.event_type in('task_created','task_completed','task_reopened','interview_result_task_created','interview_result_task_closed')
   and not exists(select 1 from private.task_history h where h.task_id=t.id and h.summary='Task created')
   and e.created_at<coalesce((select min(h.created_at) from private.task_history h where h.task_id=t.id),'infinity'::timestamptz)
  order by created_at desc,id limit 200
 )h left join public.platform_users u on u.id=h.actor_id;
 people:=private.task_workspace_json(a.organization_id,a.id,a.role)->'assignees';
 return jsonb_build_object('task',private.task_json(a,t),'assignees',people,'history',hist);
end $$;
revoke all on function public.task_detail(uuid,uuid,text,integer,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.task_detail(uuid,uuid,text,integer,uuid,jsonb) to service_role;
-- Old clients must refresh rather than silently overwrite an edited task.
create or replace function public.update_my_task(p_actor_user_id uuid,p_task_id uuid,p_status text) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$begin raise exception using errcode='40001',message='Refresh My Tasks to use versioned updates.';end $$;

-- Keep duplicate-staff retirement from silently leaving secondary ownership.
create function private.task_retirement_guard() returns trigger language plpgsql security definer set search_path=pg_catalog,public,private as $$begin
 if old.retired_at is null and new.retired_at is not null and exists(select 1 from private.task_additional_assignees m join public.tasks t on t.id=m.task_id where m.assigned_to_user_id=old.id and t.status='open') then raise exception using errcode='22023',message='Reassign open additional task memberships before retiring this employee.';end if;return new;
end $$;
create trigger task_retirement_guard before update of retired_at on public.platform_users for each row execute function private.task_retirement_guard();
-- Extend task history visibility without touching any other entity permissions.
alter function private.activity_record(public.platform_users,text,uuid) rename to activity_record_before_tasks;
create function private.activity_record(a public.platform_users,k text,s uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,private as $$declare t public.tasks;begin
 if k<>'task' then return private.activity_record_before_tasks(a,k,s);end if;
 select * into t from public.tasks where id=s;
 if found and private.task_readable(a,t) then return jsonb_build_object('kind','task','id',t.id,'label',t.title,'href','#tasks');end if;return null;
end $$;
revoke all on function private.task_version(),private.task_member(public.tasks,uuid),private.task_readable(public.platform_users,public.tasks),private.task_json(public.platform_users,public.tasks),private.task_retirement_guard(),private.activity_record(public.platform_users,text,uuid) from public,anon,authenticated;
alter function private.activity_catalog(text,text) rename to activity_catalog_before_task_edits;
create function private.activity_catalog(t text,e text) returns jsonb language sql immutable set search_path=pg_catalog,private as $$select case when t='task' and e in('task_updated','applicant_task_updated') then jsonb_build_object('action','Task updated','category','tasks','external',false) else private.activity_catalog_before_task_edits(t,e) end$$;
revoke all on function private.activity_catalog(text,text) from public,anon,authenticated;
commit;
