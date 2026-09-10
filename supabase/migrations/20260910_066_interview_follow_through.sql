-- One current interview; immutable previous rounds and outcome-driven tasks.
begin;
alter table public.talent_interviews add column round_number integer not null default 1 check(round_number>0),
  add column follow_through_generation uuid,
  add column follow_through_actor_id uuid,
  add column calendar_request_id uuid;

create table private.talent_interview_history (
  interview_id uuid not null references public.talent_interviews(id) on delete restrict,
  round_number integer not null,
  organization_id uuid not null references public.organizations(id),
  applicant_id uuid not null references public.applicants(id),
  snapshot jsonb not null,
  archived_at timestamptz not null default clock_timestamp(),
  primary key(interview_id,round_number)
);
create table private.talent_interview_result_tasks (
  interview_id uuid not null references public.talent_interviews(id) on delete restrict,
  generation uuid not null,
  task_id uuid not null unique references public.tasks(id) on delete restrict,
  primary key(interview_id,generation)
);
revoke all on private.talent_interview_history,private.talent_interview_result_tasks from public,anon,authenticated,service_role;
alter table private.talent_interview_history enable row level security;
alter table private.talent_interview_result_tasks enable row level security;

create function private.interview_history_json(p_interview public.talent_interviews) returns jsonb
language sql stable security definer set search_path=pg_catalog,public,private as $$
 select jsonb_build_object('interviewId',p_interview.id,'roundNumber',p_interview.round_number,
  'status',p_interview.status,'startsAt',p_interview.starts_at,'endsAt',p_interview.ends_at,'timezone',p_interview.timezone,
  'interviewer',jsonb_build_object('id',p_interview.interviewer_user_id,'name',p_interview.interviewer_name_snapshot),
  'additionalAttendees',private.talent_interview_attendee_names(p_interview.additional_attendees),
  'outcome',p_interview.outcome,'scorecard',p_interview.scorecard,'notes',p_interview.private_notes,
  'calendar',jsonb_build_object('status','not_applicable','joinUrl',null),'updatedAt',p_interview.updated_at)
$$;

-- Lifecycle closure happens in the same transaction as the actual interview edit.
create function private.close_interview_result_tasks() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,private as $$
begin
 if new.status <> 'scheduled' or old.follow_through_generation is distinct from new.follow_through_generation then
  with closed as (
   update public.tasks t set status='completed',completed_at=clock_timestamp()
   from private.talent_interview_result_tasks s where s.interview_id=new.id and s.task_id=t.id and t.status='open' returning t.id,t.organization_id
  ) insert into public.audit_events(organization_id,actor_user_id,entity_type,entity_id,event_type,after_value,note)
    select organization_id,null,'task',id,'interview_result_task_closed',jsonb_build_object('status','completed'),'Automatically closed after the interview outcome or schedule changed.' from closed;
  update public.task_notifications n set read_at=coalesce(n.read_at,clock_timestamp())
  from private.talent_interview_result_tasks s where s.interview_id=new.id and s.task_id=n.task_id;
 end if;
 return new;
end $$;
create trigger close_interview_result_tasks after update on public.talent_interviews
 for each row execute function private.close_interview_result_tasks();

create function public.reconcile_interview_result_tasks(p_limit integer default 100) returns integer
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare candidate record; i public.talent_interviews; a public.applicants; task_id uuid; creator uuid; n integer:=0;
begin
 for candidate in select x.id,x.applicant_id from public.talent_interviews x
  join public.applicants t on t.id=x.applicant_id and t.organization_id=x.organization_id
  where x.status='scheduled' and x.ends_at<=clock_timestamp() and t.archived_at is null
   and exists(select 1 from public.platform_users u where u.id=x.interviewer_user_id and u.organization_id=x.organization_id and u.active and not u.must_change_password and u.role in ('admin','talent_management'))
   and (x.follow_through_actor_id is not null or exists(select 1 from public.talent_verification_operations o where o.organization_id=x.organization_id and o.applicant_id=x.applicant_id and o.phase='mutation' and o.action in ('schedule_interview','reschedule_interview','schedule_follow_up_interview')))
   and not exists(select 1 from private.talent_interview_result_tasks s where s.interview_id=x.id and s.generation=coalesce(x.follow_through_generation,x.id))
  order by x.ends_at,x.id limit greatest(1,least(coalesce(p_limit,100),100))
 loop
  -- Consistent applicant -> interview -> task lock ordering with the mutation RPC.
  select * into a from public.applicants where id=candidate.applicant_id for update skip locked;
  if not found or a.archived_at is not null then continue; end if;
  select * into i from public.talent_interviews where id=candidate.id for update;
  if i.status<>'scheduled' or i.ends_at>clock_timestamp() or exists(select 1 from private.talent_interview_result_tasks s where s.interview_id=i.id and s.generation=coalesce(i.follow_through_generation,i.id)) then continue;end if;
  perform 1 from public.platform_users u where u.id=i.interviewer_user_id and u.organization_id=i.organization_id and u.active and not u.must_change_password and u.role in ('admin','talent_management') for share;
  if not found then continue;end if;
  select o.actor_user_id into creator from public.talent_verification_operations o
   where o.organization_id=i.organization_id and o.applicant_id=i.applicant_id and o.phase='mutation'
    and o.action in ('schedule_interview','reschedule_interview','schedule_follow_up_interview') order by o.created_at desc limit 1;
  creator:=coalesce(i.follow_through_actor_id,creator);
  if creator is null then continue;end if;
  insert into public.tasks(organization_id,title,related_label,due_date,priority,created_by_user_id,assigned_to_user_id)
  values(i.organization_id,'Record interview result',left(a.full_name,200),(i.ends_at at time zone 'America/Chicago')::date,'high',creator,i.interviewer_user_id) returning id into task_id;
  insert into private.talent_interview_result_tasks values(i.id,coalesce(i.follow_through_generation,i.id),task_id);
  insert into public.task_notifications(organization_id,recipient_user_id,task_id) values(i.organization_id,i.interviewer_user_id,task_id);
  insert into public.audit_events(organization_id,actor_user_id,entity_type,entity_id,event_type,after_value,note)
   values(i.organization_id,null,'task',task_id,'interview_result_task_created',jsonb_build_object('status','open','roundNumber',i.round_number),'Automatically created because the interview ended without a recorded result.');
  n:=n+1;
 end loop;
 return n;
end $$;

-- Preserve prior migrations' function bodies; abort if any expected anchor changed.
do $patch$
declare item record; definition text; matches integer;
begin
 for item in select * from (values
 ('private.talent_verification_state_json(uuid,public.platform_role,uuid)',
  $old$    'outcome', interview.outcome,$old$,
  $new$    'roundNumber', interview.round_number,
    'outcome', interview.outcome,$new$,1),
 ('private.talent_verification_state_json(uuid,public.platform_role,uuid)',
  $old$    'interviewers', v_interviewers,$old$,
  $new$    'interviewHistory', coalesce((select jsonb_agg(h.snapshot->'public' order by h.round_number) from private.talent_interview_history h where h.organization_id=p_organization_id and h.applicant_id=p_applicant_id),'[]'::jsonb),
    'interviewers', v_interviewers,$new$,1),
 ('public.mutate_talent_verification(uuid,uuid,uuid,text,timestamp with time zone,jsonb)',
  $old$'reschedule_interview', 'cancel_interview'$old$,
  $new$'reschedule_interview', 'schedule_follow_up_interview', 'cancel_interview'$new$,4),
 ('public.mutate_talent_verification(uuid,uuid,uuid,text,timestamp with time zone,jsonb)',
  $old$          and v_interview.calendar_sync_status = 'pending'$old$,
  $new$          and v_interview.calendar_request_id = p_request_id
          and v_interview.calendar_sync_status = 'pending'$new$,1),
 ('public.mutate_talent_verification(uuid,uuid,uuid,text,timestamp with time zone,jsonb)',
  $old$      additional_attendees, status, starts_at, ends_at, timezone,$old$,
  $new$      follow_through_generation, follow_through_actor_id, calendar_request_id,
      additional_attendees, status, starts_at, ends_at, timezone,$new$,1),
 ('public.mutate_talent_verification(uuid,uuid,uuid,text,timestamp with time zone,jsonb)',
  $old$      private.resolve_talent_interview_attendees(v_actor.organization_id,$old$,
  $new$      gen_random_uuid(), p_actor_user_id, p_request_id,
      private.resolve_talent_interview_attendees(v_actor.organization_id,$new$,1),
 ('public.mutate_talent_verification(uuid,uuid,uuid,text,timestamp with time zone,jsonb)',
  $old$    if v_action = 'reschedule_interview' then$old$,
  $new$    if v_action in ('reschedule_interview','schedule_follow_up_interview') then
      if v_action='schedule_follow_up_interview' then
        if not (v_payload ? 'additionalAttendeeUserIds') then
          raise exception using errcode='22023',message='Confirm the company attendees for this new interview round.';
        end if;
        if v_applicant.status<>'in_review' or v_applicant.archived_at is not null
          or not (v_interview.status='no_show' or (v_interview.status='completed' and v_interview.outcome='follow_up'))
          or v_interview.calendar_sync_status not in ('synced','not_applicable') then
          raise exception using errcode='22023',message='Finish the previous interview and calendar sync, and keep this application in review before scheduling a follow-up.';
        end if;
        insert into private.talent_interview_history(interview_id,round_number,organization_id,applicant_id,snapshot)
         values(v_interview.id,v_interview.round_number,v_actor.organization_id,p_applicant_id,
           jsonb_build_object('record',to_jsonb(v_interview),'public',private.interview_history_json(v_interview)));
        -- Local branch state only: a new round always creates a fresh calendar event.
        v_interview.status:='cancelled'; v_interview.microsoft_event_id:=null;
      end if;$new$,1),
 ('public.mutate_talent_verification(uuid,uuid,uuid,text,timestamp with time zone,jsonb)',
  $old$        status = 'scheduled',$old$,
  $new$        status = 'scheduled',
        round_number = round_number + case when v_action='schedule_follow_up_interview' then 1 else 0 end,
        follow_through_generation = gen_random_uuid(), follow_through_actor_id=p_actor_user_id,
        calendar_request_id=p_request_id,$new$,1),
 ('public.mutate_talent_verification(uuid,uuid,uuid,text,timestamp with time zone,jsonb)',
  $old$  insert into public.talent_verification_operations ($old$,
  $new$  if v_calendar_action is not null then
    update public.talent_interviews set calendar_request_id=p_request_id where id=v_interview.id;
  end if;
  insert into public.talent_verification_operations ($new$,1),
 ('private.task_workspace_json(uuid,uuid,public.platform_role)',
  $old$            'relatedLabel', task.related_label,$old$,
  $new$            'source', (select jsonb_build_object('kind','interview_result','applicantId',i.applicant_id,'interviewId',i.id)
               from private.talent_interview_result_tasks s join public.talent_interviews i on i.id=s.interview_id where s.task_id=task.id and i.organization_id=p_organization_id),
            'relatedLabel', task.related_label,$new$,2),
 ('private.activity_catalog(text,text)',
  $old$('talent_verification','schedule_interview','Talent interview scheduled','review',false),$old$,
  $new$('talent_verification','schedule_interview','Talent interview scheduled','review',false),
 ('talent_verification','schedule_follow_up_interview','Talent follow-up interview scheduled','review',false),$new$,1),
 ('private.activity_catalog(text,text)',
  $old$('task','task_created','Task created','tasks',false),$old$,
  $new$('task','task_created','Task created','tasks',false),
 ('task','interview_result_task_created','Interview result task created automatically','tasks',false),
 ('task','interview_result_task_closed','Interview result task closed automatically','tasks',false),$new$,1),
 ('public.update_my_task(uuid,uuid,text)',
  $old$  if v_task.status <> v_status then$old$,
  $new$  if exists(select 1 from private.talent_interview_result_tasks s where s.task_id=v_task.id) then
    raise exception using errcode='22023',message='Record the interview result to complete this automatic task.';
  end if;
  if v_task.status <> v_status then$new$,1)
 ) edits(signature,old_text,new_text,expected_matches)
 loop
  definition:=replace(pg_get_functiondef(item.signature::regprocedure),E'\r\n',E'\n');
  matches:=(length(definition)-length(replace(definition,item.old_text,'')))/length(item.old_text);
  if matches<>item.expected_matches then raise exception 'Follow-through patch expected % matches, found % in %',item.expected_matches,matches,item.signature;end if;
  execute replace(definition,item.old_text,item.new_text);
 end loop;
end $patch$;
alter table public.talent_verification_operations drop constraint talent_verification_operations_action_check;
alter table public.talent_verification_operations add constraint talent_verification_operations_action_check check(action in
 ('schedule_interview','reschedule_interview','schedule_follow_up_interview','cancel_interview','record_interview_outcome','retry_calendar_sync','save_reference','record_reference_attempt','set_reference_outcome','remove_reference','calendar_sync_result'));

revoke all on function private.interview_history_json(public.talent_interviews),private.close_interview_result_tasks(),public.reconcile_interview_result_tasks(integer) from public,anon,authenticated;
grant execute on function public.reconcile_interview_result_tasks(integer) to service_role;
commit;
