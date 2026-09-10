-- Private, generation-bound reminders. Existing interviews are not enrolled.
begin;
alter table public.talent_interviews add column follow_through_started_at timestamptz;
create table private.talent_interview_reminders (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id),
 interview_id uuid not null references public.talent_interviews(id),
 generation uuid not null,
 offset_minutes integer not null check(offset_minutes in (1440,60)),
 recipient_email text not null,
 recipient_user_id uuid,
 recipient_kind text not null check(recipient_kind in ('applicant','staff')),
 payload jsonb not null,
 due_at timestamptz not null,
 expires_at timestamptz not null,
 state text not null default 'pending' check(state in ('pending','sending','sent','cancelled','review')),
 attempts integer not null default 0,
 first_attempt_at timestamptz,
 next_attempt_at timestamptz,
 lease_token uuid,
 lease_until timestamptz,
 request_body text,
 provider_message_id text,
 error_code text,
 created_at timestamptz not null default clock_timestamp(),
 unique(interview_id,generation,offset_minutes,recipient_email)
);
alter table private.talent_interview_reminders enable row level security;
revoke all on private.talent_interview_reminders from public,anon,authenticated,service_role;
create index interview_reminders_due on private.talent_interview_reminders(state,due_at,next_attempt_at);

create function private.interview_generation_timestamp() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
 if tg_op='INSERT' or new.follow_through_generation is distinct from old.follow_through_generation then
  new.follow_through_started_at:=case when new.follow_through_generation is not null then clock_timestamp() end;
 end if;
 return new;
end $$;
create trigger interview_generation_timestamp before insert or update on public.talent_interviews
 for each row execute function private.interview_generation_timestamp();

create function private.enqueue_interview_reminders() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a public.applicants; person jsonb; recipients jsonb; offset_min integer; due timestamptz;
begin
 update private.talent_interview_reminders r set state='cancelled',lease_token=null,lease_until=null
 where r.interview_id=new.id and r.state in ('pending','sending') and
  (r.generation is distinct from new.follow_through_generation or new.status<>'scheduled'
   or new.calendar_sync_status<>'synced' or r.payload->>'joinUrl' is distinct from new.microsoft_join_url);
 if new.follow_through_generation is null or new.follow_through_started_at is null or new.status<>'scheduled' or new.calendar_sync_status<>'synced'
  or new.microsoft_join_url is null or new.starts_at<=clock_timestamp() then return new;end if;
 select * into a from public.applicants where id=new.applicant_id and organization_id=new.organization_id and archived_at is null;
 if not found then return new;end if;
 recipients:=jsonb_build_array(jsonb_build_object('kind','applicant','email',a.email,'name',a.full_name,'id',null),
  jsonb_build_object('kind','staff','email',new.interviewer_email_snapshot,'name',new.interviewer_name_snapshot,'id',new.interviewer_user_id));
 recipients:=recipients||coalesce((select jsonb_agg(p||jsonb_build_object('kind','staff')) from jsonb_array_elements(new.additional_attendees) p),'[]'::jsonb);
 foreach offset_min in array array[1440,60] loop
  due:=new.starts_at-make_interval(mins=>offset_min);
  -- Do not send missed thresholds for late bookings or historical records.
  if due<new.follow_through_started_at or due+interval '30 minutes'<=clock_timestamp() then continue;end if;
  for person in select value from jsonb_array_elements(recipients) loop
   if coalesce(person->>'email','') !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then continue;end if;
   insert into private.talent_interview_reminders(organization_id,interview_id,generation,offset_minutes,recipient_email,recipient_user_id,recipient_kind,payload,due_at,expires_at)
   values(new.organization_id,new.id,new.follow_through_generation,offset_min,lower(btrim(person->>'email')),(person->>'id')::uuid,person->>'kind',
    jsonb_build_object('personName',person->>'name','recipientKind',person->>'kind','applicantName',a.full_name,'startsAt',new.starts_at,'endsAt',new.ends_at,
     'timezone',new.timezone,'joinUrl',new.microsoft_join_url,'roundNumber',new.round_number,'offsetMinutes',offset_min),due,least(due+interval '30 minutes',new.starts_at))
    on conflict(interview_id,generation,offset_minutes,recipient_email) do nothing;
  end loop;
 end loop;
 return new;
end $$;
create trigger enqueue_interview_reminders after insert or update on public.talent_interviews
 for each row execute function private.enqueue_interview_reminders();

-- Staff directory JSON is a safe UI projection; recipient validation uses authoritative profiles.
create function private.interview_reminder_valid(r private.talent_interview_reminders) returns boolean
language sql stable security definer set search_path=pg_catalog,public,private as $$
 select exists(select 1 from public.talent_interviews i join public.applicants a on a.id=i.applicant_id and a.organization_id=i.organization_id
 where i.id=r.interview_id and i.organization_id=r.organization_id and i.follow_through_generation=r.generation
  and i.status='scheduled' and i.calendar_sync_status='synced' and a.archived_at is null
  and i.starts_at>clock_timestamp() and i.starts_at=(r.payload->>'startsAt')::timestamptz and i.ends_at=(r.payload->>'endsAt')::timestamptz
  and i.timezone=r.payload->>'timezone' and i.microsoft_join_url=r.payload->>'joinUrl'
  and ((r.recipient_kind='applicant' and r.recipient_email=lower(btrim(a.email)))
   or (r.recipient_kind='staff' and exists(select 1 from public.platform_users u join public.employee_profiles e on e.user_id=u.id and e.organization_id=u.organization_id
      where u.id=r.recipient_user_id and u.organization_id=i.organization_id and u.active
       and u.role in ('admin','talent_management','sales','sales_management','billing') and lower(btrim(e.email))=r.recipient_email
       and (u.id=i.interviewer_user_id or exists(select 1 from jsonb_array_elements(i.additional_attendees) p where p->>'id'=u.id::text))))))
$$;

create function public.claim_interview_reminders(p_limit integer default 3) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare r private.talent_interview_reminders; result jsonb:='[]';
begin
 update private.talent_interview_reminders set state='review',error_code='reminder_window_elapsed',lease_token=null,lease_until=null
 where state in ('pending','sending') and expires_at<=clock_timestamp();
 for r in select * from private.talent_interview_reminders
  where (state='pending' or (state='sending' and lease_until<clock_timestamp()))
   and due_at<=clock_timestamp() and expires_at>clock_timestamp() and coalesce(next_attempt_at,due_at)<=clock_timestamp()
   and (first_attempt_at is null or first_attempt_at>clock_timestamp()-interval '23 hours')
  order by due_at,id limit greatest(1,least(coalesce(p_limit,3),3)) for update skip locked
 loop
  if not private.interview_reminder_valid(r) then update private.talent_interview_reminders set state='cancelled' where id=r.id;continue;end if;
  update private.talent_interview_reminders set state='sending',lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '2 minutes',
   attempts=attempts+1,first_attempt_at=coalesce(first_attempt_at,clock_timestamp()) where id=r.id returning * into r;
  result:=result||jsonb_build_array(jsonb_build_object('outboxId',r.id,'leaseToken',r.lease_token,'to',r.recipient_email,'payload',r.payload,'requestBody',r.request_body));
 end loop;
 return result;
end $$;

create function public.prepare_interview_reminder(p_outbox_id uuid,p_lease_token uuid,p_request_body text) returns text
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare r private.talent_interview_reminders;b jsonb;
begin
 select * into r from private.talent_interview_reminders where id=p_outbox_id for update;
 if not found or r.state<>'sending' or r.lease_token is distinct from p_lease_token or r.lease_until<=clock_timestamp()
  or r.expires_at<=clock_timestamp() or not private.interview_reminder_valid(r) then return null;end if;
 if r.request_body is not null then return r.request_body;end if;
 b:=p_request_body::jsonb;
 if length(p_request_body)>100000 or jsonb_typeof(b)<>'object'
  or b->>'from' is distinct from 'The Soro Group <talents@thesorogroup.com>'
  or b->>'reply_to' is distinct from 'talents@thesorogroup.com'
  or b->'to' is distinct from jsonb_build_array(r.recipient_email)
  or exists(select 1 from jsonb_object_keys(b) k where k not in ('from','reply_to','to','subject','html','text'))
  or nullif(b->>'subject','') is null or nullif(b->>'html','') is null or nullif(b->>'text','') is null then
  raise exception using errcode='22023',message='Invalid reminder envelope.';
 end if;
 update private.talent_interview_reminders set request_body=p_request_body where id=r.id;
 return p_request_body;
end $$;

create function public.complete_interview_reminder(p_outbox_id uuid,p_lease_token uuid,p_outcome text,p_provider_message_id text default null,p_error_code text default null) returns boolean
language plpgsql security definer set search_path=pg_catalog,public,private as $$
begin
 if p_outcome is null or p_outcome not in ('sent','retry','review') then raise exception using errcode='22023',message='Invalid delivery outcome.';end if;
 if p_outcome='sent' and coalesce(p_provider_message_id,'') !~ '^[a-zA-Z0-9_-]{1,200}$' then raise exception using errcode='22023',message='Provider receipt required.';end if;
 update private.talent_interview_reminders set state=case when p_outcome='retry' then 'pending' else p_outcome end,
  provider_message_id=case when p_outcome='sent' then left(p_provider_message_id,200) else provider_message_id end,
  error_code=left(p_error_code,80),lease_token=null,lease_until=null,next_attempt_at=clock_timestamp()+interval '1 minute'
 where id=p_outbox_id and state='sending' and lease_token=p_lease_token and lease_until>clock_timestamp()
  and (p_outcome<>'sent' or request_body is not null);
 return found;
end $$;
revoke all on function private.interview_generation_timestamp(),private.enqueue_interview_reminders(),private.interview_reminder_valid(private.talent_interview_reminders),
 public.claim_interview_reminders(integer),public.prepare_interview_reminder(uuid,uuid,text),public.complete_interview_reminder(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.claim_interview_reminders(integer),public.prepare_interview_reminder(uuid,uuid,text),public.complete_interview_reminder(uuid,uuid,text,text,text) to service_role;
commit;
