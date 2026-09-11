-- Applicant-facing requests are isolated from internal task details and review notes.
begin;
create table private.applicant_information_tasks(
 task_id uuid primary key references public.tasks(id),organization_id uuid not null references public.organizations(id),applicant_id uuid not null references public.applicants(id),
 request_id uuid not null unique,request_fingerprint jsonb not null,response text not null default '' check(length(response)<=4000),submitted_at timestamptz,closed_at timestamptz
);
create table private.applicant_request_emails(
 id uuid primary key default gen_random_uuid(),task_id uuid not null unique references private.applicant_information_tasks(task_id),recipient_email text not null,payload jsonb not null,
 state text not null default 'pending' check(state in('pending','sending','sent','cancelled','review')),attempts integer not null default 0,first_attempt_at timestamptz,next_attempt_at timestamptz,lease_token uuid,lease_until timestamptz,request_body text,provider_message_id text,error_code text,created_at timestamptz not null default clock_timestamp()
);
alter table private.applicant_information_tasks enable row level security;alter table private.applicant_request_emails enable row level security;
revoke all on private.applicant_information_tasks,private.applicant_request_emails from public,anon,authenticated,service_role;

alter function private.task_readable(public.platform_users,public.tasks) rename to staff_task_readable;
create function private.task_readable(a public.platform_users,t public.tasks) returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,private as $$declare r private.applicant_information_tasks;begin
 select * into r from private.applicant_information_tasks where task_id=t.id;
 if not found then return private.staff_task_readable(a,t);end if;
 if a.id is null or a.active is distinct from true or a.must_change_password is distinct from false or a.organization_id is distinct from r.organization_id or a.organization_id is distinct from t.organization_id then return false;end if;
 if a.role in('admin','talent_management') then return true;end if;
 return a.role='virtual_assistant' and exists(select 1 from public.applicants p where p.id=r.applicant_id and p.organization_id=a.organization_id and p.auth_user_id=a.id and p.portal_access_status='active' and p.archived_at is null and(select count(*) from public.applicants x where x.organization_id=a.organization_id and x.auth_user_id=a.id and x.portal_access_status='active' and x.archived_at is null)=1);
end $$;
alter function private.task_json(public.platform_users,public.tasks) rename to staff_task_json;
create function private.task_json(a public.platform_users,t public.tasks) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,private as $$declare r private.applicant_information_tasks;person jsonb;staff boolean;begin
 select * into r from private.applicant_information_tasks where task_id=t.id;
 if not found then return private.staff_task_json(a,t);end if;
 if not private.task_readable(a,t) then raise exception using errcode='42501',message='Task unavailable.';end if;
 staff:=a.role in('admin','talent_management');
 select jsonb_build_object('userId',coalesce(p.auth_user_id,p.id),'name',p.full_name) into person from public.applicants p where p.id=r.applicant_id;
 return jsonb_build_object('taskId',t.id,'kind','applicant_request','title',t.title,'details',t.details,'response',r.response,'relatedLabel',case when staff then person->>'name' else 'Your Application' end,'priority',t.priority,'dueDate',t.due_date,'status',t.status,'progress',case when r.closed_at is not null then 'closed' when r.submitted_at is not null then 'submitted' else 'not_started' end,'version',t.version,'assignedTo',person,'assignees',jsonb_build_array(person),'createdBy',jsonb_build_object('userId',t.created_by_user_id,'name','The Soro Group Talent Team'),'createdAt',t.created_at,'updatedAt',t.updated_at,'completedAt',t.completed_at,'isNew',not exists(select 1 from private.task_views v where v.task_id=t.id and v.user_id=a.id),'canEditDetails',false,'canUpdateProgress',r.closed_at is null,'canRespond',not staff and r.closed_at is null,'canCloseRequest',staff and r.closed_at is null);
end $$;

create function public.get_applicant_task_workspace(p_actor_user_id uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,private as $$declare a public.platform_users;identity record;items jsonb;counts jsonb;begin
 select * into a from public.platform_users where id=p_actor_user_id;
 select * into identity from private.talent_attendance_identity(a.id);
 select coalesce(jsonb_agg(x.payload order by x.created_at desc),'[]') into items from(select private.task_json(a,t) payload,t.created_at from public.tasks t join private.applicant_information_tasks r on r.task_id=t.id where r.applicant_id=identity.applicant_id and r.organization_id=identity.organization_id and private.task_readable(a,t) order by t.created_at desc limit 1000)x;
 select jsonb_build_object('open',count(*) filter(where t.status='open'),'overdue',count(*) filter(where t.status='open' and t.due_date<(clock_timestamp() at time zone 'Asia/Manila')::date),'urgentUnread',0) into counts from public.tasks t join private.applicant_information_tasks r on r.task_id=t.id where r.applicant_id=identity.applicant_id and r.organization_id=identity.organization_id;
 return jsonb_build_object('tasks',items,'assignees','[]'::jsonb,'notifications','[]'::jsonb,'summary',counts);
end $$;

create function public.request_talent_information(p_actor_user_id uuid,p_request_id uuid,p_applicant_id uuid,p_expected_updated_at timestamptz,p_note text,p_request_details text) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a record;p public.applicants;r private.applicant_information_tasks;t public.tasks;result jsonb;fingerprint jsonb;
begin
 select * into a from private.talent_review_actor(p_actor_user_id);
 if p_request_id is null or nullif(btrim(p_request_details),'') is null or length(p_request_details)>4000 then raise exception using errcode='22023',message='Add the message to send the applicant.';end if;
 perform pg_advisory_xact_lock(hashtextextended('applicant-info:'||p_request_id,0));
 perform 1 from public.platform_users where id=p_actor_user_id for share;
 select * into a from private.talent_review_actor(p_actor_user_id);
 fingerprint:=jsonb_build_object('actor',a.user_id,'applicant',p_applicant_id,'expected',p_expected_updated_at,'note',p_note,'details',p_request_details);
 select * into r from private.applicant_information_tasks where request_id=p_request_id;
 if not found and exists(select 1 from public.talent_review_operations where operation_request_id=p_request_id) then raise exception using errcode='23505',message='This older review request cannot send a new email.';end if;
 if found and r.request_fingerprint<>fingerprint then raise exception using errcode='23505',message='Request changed.';end if;
 result:=public.change_talent_review_stage(p_actor_user_id,p_request_id,p_applicant_id,p_expected_updated_at,'request_more_info',coalesce(nullif(btrim(p_note),''),'Applicant-facing information request sent.'));
 if r.task_id is not null then return result;end if;
 select * into p from public.applicants where id=p_applicant_id and organization_id=a.organization_id;
 if coalesce(p.email,'') !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception using errcode='22023',message='The applicant needs a valid email address.';end if;
 insert into public.tasks(organization_id,title,details,related_label,created_by_user_id,assigned_to_user_id) values(a.organization_id,'Additional Application Information',btrim(p_request_details),'Applicant follow-up',a.user_id,a.user_id) returning * into t;
 insert into private.applicant_information_tasks(task_id,organization_id,applicant_id,request_id,request_fingerprint) values(t.id,a.organization_id,p.id,p_request_id,fingerprint);
 insert into private.task_views(task_id,user_id) values(t.id,a.user_id);
 insert into private.task_history(task_id,actor_id,summary) values(t.id,a.user_id,'Information requested by the Talent Team');
 insert into private.applicant_request_emails(task_id,recipient_email,payload) values(t.id,lower(btrim(p.email)),jsonb_build_object('taskId',t.id,'personName',p.full_name,'details',t.details,'portalActive',p.auth_user_id is not null and p.portal_access_status='active'));
 return result;
end $$;

alter function public.task_detail(uuid,uuid,text,integer,uuid,jsonb) rename to staff_task_detail;
-- The old RPC is now private to the dispatcher, not a service bypass for applicant tasks.
revoke all on function public.staff_task_detail(uuid,uuid,text,integer,uuid,jsonb) from public,anon,authenticated,service_role;
create function public.task_detail(p_actor_user_id uuid,p_task_id uuid,p_action text,p_expected_version integer default null,p_request_id uuid default null,p_patch jsonb default '{}') returns jsonb language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users;t public.tasks;r private.applicant_information_tasks;replay private.task_changes;fingerprint jsonb;hist jsonb;v_response text;summary text;
begin
 select * into a from public.platform_users where id=p_actor_user_id;
 select * into r from private.applicant_information_tasks where task_id=p_task_id;
 if not found then return public.staff_task_detail(p_actor_user_id,p_task_id,p_action,p_expected_version,p_request_id,p_patch);end if;
 if p_action not in('get','view','save') then raise exception using errcode='22023',message='Unsupported task action.';end if;
 if p_action='save' then
  if p_request_id is null then raise exception using errcode='22023',message='Request id required.';end if;
  perform pg_advisory_xact_lock(hashtextextended('task-edit:'||p_request_id,0));
 end if;
 select * into a from public.platform_users where id=p_actor_user_id for share;
 perform 1 from public.applicants where id=r.applicant_id for share;
 select * into t from public.tasks where id=p_task_id for update;
 select * into r from private.applicant_information_tasks where task_id=p_task_id for update;
 if not private.task_readable(a,t) then raise exception using errcode='42501',message='Task unavailable.';end if;
 if p_action='view' then insert into private.task_views(task_id,user_id) values(t.id,a.id) on conflict do nothing;
 elsif p_action='save' then
  fingerprint:=jsonb_build_object('action',p_action,'taskId',p_task_id,'version',p_expected_version,'patch',p_patch);
  select * into replay from private.task_changes where request_id=p_request_id;
  if found then
   if replay.actor_id<>a.id or replay.fingerprint<>fingerprint then raise exception using errcode='23505',message='Request changed.';end if;
   return public.task_detail(a.id,t.id,'get');
  end if;
  if t.version is distinct from p_expected_version or r.closed_at is not null then raise exception using errcode='40001',message='Request changed.';end if;
  if a.role='virtual_assistant' then
   if (p_patch-'response')<>'{}' or nullif(btrim(p_patch->>'response'),'') is null or length(p_patch->>'response')>4000 then raise exception using errcode='22023',message='Enter your response.';end if;
   v_response:=btrim(p_patch->>'response');summary:='Response submitted';
   update private.applicant_information_tasks set response=v_response,submitted_at=clock_timestamp() where task_id=t.id;
  else
   if p_patch<>jsonb_build_object('closeRequest',true) then raise exception using errcode='22023',message='Use Close Request after reviewing the response.';end if;
   summary:='Request closed by the Talent Team';update private.applicant_information_tasks set closed_at=clock_timestamp() where task_id=t.id;
  end if;
  update public.tasks set status=case when a.role='virtual_assistant' then 'open' else 'completed' end,completed_at=case when a.role='virtual_assistant' then null else clock_timestamp() end where id=t.id returning * into t;
  insert into private.task_history(task_id,actor_id,summary,note) values(t.id,a.id,summary,v_response);
  insert into private.task_changes values(p_request_id,a.id,t.id,fingerprint);
  insert into public.audit_events(organization_id,actor_user_id,entity_type,entity_id,event_type,note) values(t.organization_id,a.id,'task',t.id,'applicant_task_updated',summary);
  if a.role='virtual_assistant' then
   insert into public.task_notifications(organization_id,recipient_user_id,task_id) values(t.organization_id,t.created_by_user_id,t.id) on conflict(task_id,recipient_user_id,notification_type) do update set read_at=null,created_at=clock_timestamp();
  end if;
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('actor',case when u.role='virtual_assistant' then coalesce(nullif(u.display_name,''),'Applicant') else 'The Soro Group Talent Team' end,'at',h.created_at,'summary',h.summary,'note',h.note) order by h.created_at desc,h.id),'[]') into hist from(select * from private.task_history where task_id=t.id order by created_at desc,id limit 200)h join public.platform_users u on u.id=h.actor_id;
 return jsonb_build_object('task',private.task_json(a,t),'assignees','[]'::jsonb,'history',hist);
end $$;

create function private.applicant_request_email_valid(e private.applicant_request_emails) returns boolean language sql stable security definer set search_path=pg_catalog,public,private as $$
 select exists(select 1 from private.applicant_information_tasks r join public.applicants p on p.id=r.applicant_id and p.organization_id=r.organization_id join public.tasks t on t.id=r.task_id where r.task_id=e.task_id and r.closed_at is null and r.submitted_at is null and t.status='open' and p.status='needs_more_info' and p.archived_at is null and lower(btrim(p.email))=e.recipient_email)
$$;
-- Leaving this review stage closes the applicant follow-up, never approves a talent.
create function private.close_applicant_information_tasks() returns trigger language plpgsql security definer set search_path=pg_catalog,public,private as $$declare tid uuid;begin
 if new.status='needs_more_info' and new.archived_at is null then return new;end if;
 for tid in select task_id from private.applicant_information_tasks where applicant_id=new.id and closed_at is null loop
  update public.tasks set status='completed',completed_at=coalesce(completed_at,clock_timestamp()) where id=tid;
  update private.applicant_information_tasks set closed_at=clock_timestamp() where task_id=tid;
  update private.applicant_request_emails set state='cancelled',lease_token=null,lease_until=null where task_id=tid and state in('pending','sending');
  insert into private.task_history(task_id,actor_id,summary) select tid,created_by_user_id,'Request closed automatically because the application moved to another review stage' from public.tasks where id=tid;
 end loop;return new;
end $$;
create trigger close_applicant_information_tasks after update of status,archived_at on public.applicants for each row execute function private.close_applicant_information_tasks();
revoke all on function private.close_applicant_information_tasks() from public,anon,authenticated;
create function public.claim_applicant_request_emails(p_limit integer default 3) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,private as $$declare e private.applicant_request_emails;result jsonb:='[]';begin
 update private.applicant_request_emails set state='review',error_code='retry_window_elapsed',lease_token=null,lease_until=null where state in('pending','sending') and first_attempt_at<clock_timestamp()-interval '23 hours';
 for e in select * from private.applicant_request_emails where(state='pending' or(state='sending' and lease_until<clock_timestamp())) and coalesce(next_attempt_at,created_at)<=clock_timestamp() order by created_at,id limit greatest(1,least(coalesce(p_limit,3),3)) for update skip locked loop
  if not private.applicant_request_email_valid(e) then update private.applicant_request_emails set state='cancelled' where id=e.id;continue;end if;
  update private.applicant_request_emails set state='sending',lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '2 minutes',attempts=attempts+1,first_attempt_at=coalesce(first_attempt_at,clock_timestamp()) where id=e.id returning * into e;
  result:=result||jsonb_build_array(jsonb_build_object('outboxId',e.id,'leaseToken',e.lease_token,'to',e.recipient_email,'payload',e.payload,'requestBody',e.request_body));
 end loop;return result;
end $$;
create function public.prepare_applicant_request_email(p_outbox_id uuid,p_lease_token uuid,p_request_body text) returns text language plpgsql security definer set search_path=pg_catalog,public,private as $$declare e private.applicant_request_emails;b jsonb;begin
 select * into e from private.applicant_request_emails where id=p_outbox_id for update;
 if not found or e.state<>'sending' or e.lease_token is distinct from p_lease_token or e.lease_until<=clock_timestamp() or not private.applicant_request_email_valid(e) then return null;end if;
 if e.request_body is not null then return e.request_body;end if;b:=p_request_body::jsonb;
 if length(p_request_body)>100000 or b->>'from' is distinct from 'The Soro Group <talents@thesorogroup.com>' or b->>'reply_to' is distinct from 'talents@thesorogroup.com' or b->'to' is distinct from jsonb_build_array(e.recipient_email) or exists(select 1 from jsonb_object_keys(b) k where k not in('from','reply_to','to','subject','html','text')) or nullif(b->>'subject','') is null or nullif(b->>'html','') is null or nullif(b->>'text','') is null then raise exception using errcode='22023',message='Invalid email envelope.';end if;
 update private.applicant_request_emails set request_body=p_request_body where id=e.id;return p_request_body;
end $$;
create function public.complete_applicant_request_email(p_outbox_id uuid,p_lease_token uuid,p_outcome text,p_provider_message_id text default null,p_error_code text default null) returns boolean language plpgsql security definer set search_path=pg_catalog,public,private as $$begin
 if p_outcome is null or p_outcome not in('sent','retry','review') or(p_outcome='sent' and coalesce(p_provider_message_id,'')!~'^[a-zA-Z0-9_-]{1,200}$') then raise exception using errcode='22023',message='Invalid delivery result.';end if;
 update private.applicant_request_emails set state=case when p_outcome='retry' then 'pending' else p_outcome end,provider_message_id=case when p_outcome='sent' then p_provider_message_id else provider_message_id end,error_code=left(p_error_code,80),lease_token=null,lease_until=null,next_attempt_at=clock_timestamp()+interval '1 minute' where id=p_outbox_id and state='sending' and lease_token=p_lease_token and lease_until>clock_timestamp() and(p_outcome<>'sent' or request_body is not null);return found;
end $$;
revoke all on function private.task_readable(public.platform_users,public.tasks),private.task_json(public.platform_users,public.tasks),private.applicant_request_email_valid(private.applicant_request_emails),public.get_applicant_task_workspace(uuid),public.request_talent_information(uuid,uuid,uuid,timestamptz,text,text),public.task_detail(uuid,uuid,text,integer,uuid,jsonb),public.claim_applicant_request_emails(integer),public.prepare_applicant_request_email(uuid,uuid,text),public.complete_applicant_request_email(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.get_applicant_task_workspace(uuid),public.request_talent_information(uuid,uuid,uuid,timestamptz,text,text),public.task_detail(uuid,uuid,text,integer,uuid,jsonb),public.claim_applicant_request_emails(integer),public.prepare_applicant_request_email(uuid,uuid,text),public.complete_applicant_request_email(uuid,uuid,text,text,text) to service_role;
commit;
