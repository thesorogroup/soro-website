-- Private healthcare administration and placement-linked follow-up only.
-- No clinical records, carrier API calls, benefit eligibility rules, or seeded data.
begin;
create table public.talent_healthcare_profiles(
 applicant_id uuid primary key references public.applicants(id) on delete restrict,
 organization_id uuid not null references public.organizations(id) on delete restrict,
 profile jsonb not null, version integer not null default 1 check(version>0),
 updated_by uuid not null references public.platform_users(id) on delete restrict,
 updated_at timestamptz not null default now()
);
create table public.talent_healthcare_actions(
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete restrict,
 applicant_id uuid not null references public.applicants(id) on delete restrict,
 placement_id uuid not null references public.placements(id) on delete restrict,
 kind text not null check(kind in('enrollment','cancellation')),
 status text not null default 'pending' check(status in('pending','in_progress','completed','not_applicable')),
 due_date date, effective_date date, reference text not null default '' check(char_length(reference)<=160),
 resolution text check(resolution in('carrier_confirmed','no_coverage','coverage_continues','talent_declined','reviewed_exception')),
 completed_by uuid references public.platform_users(id) on delete restrict, completed_at timestamptz,
 version integer not null default 1 check(version>0), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(placement_id,kind),
 check((status in('completed','not_applicable'))=(completed_at is not null)),
 check((completed_at is null)=(completed_by is null)),
 check(status<>'completed' or(effective_date is not null and length(btrim(reference))>0 and resolution='carrier_confirmed'))
);
create index talent_healthcare_action_scope on public.talent_healthcare_actions(organization_id,applicant_id,status,due_date);
create table public.talent_healthcare_events(
 id bigint generated always as identity primary key, organization_id uuid not null references public.organizations(id) on delete restrict,
 applicant_id uuid not null references public.applicants(id) on delete restrict,
 actor_user_id uuid references public.platform_users(id) on delete restrict,
 action text not null, work_id uuid references public.talent_healthcare_actions(id) on delete restrict,
 details jsonb not null default '{}',created_at timestamptz not null default now()
);
create table public.talent_healthcare_operations(
 actor_user_id uuid not null references public.platform_users(id) on delete restrict, request_id uuid not null,
 fingerprint text not null, result jsonb not null, created_at timestamptz not null default now(),primary key(actor_user_id,request_id)
);
create table public.talent_healthcare_history(
 applicant_id uuid not null references public.applicants(id) on delete restrict,
 organization_id uuid not null references public.organizations(id) on delete restrict,
 version integer not null, profile jsonb not null,
 recorded_by uuid not null references public.platform_users(id) on delete restrict,
 recorded_at timestamptz not null default now(), primary key(applicant_id,version)
);
do $$ declare t text;begin foreach t in array array['talent_healthcare_profiles','talent_healthcare_actions','talent_healthcare_events','talent_healthcare_operations','talent_healthcare_history'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
end loop;end $$;
revoke all on sequence public.talent_healthcare_events_id_seq from public,anon,authenticated,service_role;

create function private.healthcare_validate_profile(v jsonb) returns void
language plpgsql set search_path=pg_catalog as $$
declare p jsonb;k text;d date;starts date;ends date;kind_count integer;
begin
 if v is null or jsonb_typeof(v)<>'object' or v-array['coverageLevel','plans','dependents']<>'{}'::jsonb or not(v?&array['coverageLevel','plans','dependents']) or coalesce(v->>'coverageLevel','') not in('not_recorded','talent_only','plus_one','family') or jsonb_typeof(v->'plans') is distinct from 'array' or jsonb_typeof(v->'dependents') is distinct from 'array' then raise exception 'Invalid coverage' using errcode='22023';end if;
 if jsonb_array_length(v->'plans')<>4 or jsonb_array_length(v->'dependents')>10 then raise exception 'Invalid coverage count' using errcode='22023';end if;
 select count(distinct x->>'kind') into kind_count from jsonb_array_elements(v->'plans') x;
 if kind_count<>4 then raise exception 'Duplicate coverage' using errcode='22023';end if;
 for p in select x from jsonb_array_elements(v->'plans') x loop
  if jsonb_typeof(p)<>'object' or p-array['kind','status','carrier','planName','memberId','accountNumber','groupName','groupId','effectiveDate','endDate','supportPhone','website','rxBin','rxPcn','rxGroup']<>'{}'::jsonb or coalesce(p->>'kind','') not in('medical','prescription','dental','vision') or coalesce(p->>'status','') not in('not_recorded','not_enrolled','pending','active','ending','ended') then raise exception 'Invalid plan' using errcode='22023';end if;
  for k in select jsonb_object_keys(p) loop if jsonb_typeof(p->k)<>'string' or char_length(p->>k)>160 or p->>k ~ '[[:cntrl:]]' then raise exception 'Invalid plan field' using errcode='22023';end if;end loop;
  foreach k in array array['effectiveDate','endDate'] loop if coalesce(p->>k,'')<>'' and (p->>k !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or p->>k like '0000-%') then raise exception 'Use calendar dates' using errcode='22023';end if;end loop;
  starts:=nullif(p->>'effectiveDate','')::date;ends:=nullif(p->>'endDate','')::date;
  if starts>ends or(p->>'status' in('active','ending','ended') and(starts is null or coalesce(btrim(p->>'carrier'),'')='')) or(p->>'status' in('ending','ended') and ends is null) then raise exception 'Invalid coverage dates' using errcode='22023';end if;
  if coalesce(p->>'website','')<>'' and p->>'website' !~ '^https://[^/@?#[:space:]]+\.[^/@?#[:space:]]+(/[^?#[:space:]]*)?$' then raise exception 'Invalid member website' using errcode='22023';end if;
  if p->>'kind'<>'prescription' and (coalesce(p->>'rxBin','')<>'' or coalesce(p->>'rxPcn','')<>'' or coalesce(p->>'rxGroup','')<>'') then raise exception 'Invalid prescription details' using errcode='22023';end if;
 end loop;
 for p in select x from jsonb_array_elements(v->'dependents') x loop
  if jsonb_typeof(p)<>'object' or p-array['fullName','relationship','birthDate','memberId','coverageKinds','effectiveDate','endDate']<>'{}'::jsonb or coalesce(btrim(p->>'fullName'),'')='' or jsonb_typeof(p->'coverageKinds') is distinct from 'array' then raise exception 'Invalid covered person' using errcode='22023';end if;
  for k in select key from jsonb_object_keys(p) as key where key<>'coverageKinds' loop if jsonb_typeof(p->k)<>'string' or char_length(p->>k)>160 or p->>k ~ '[[:cntrl:]]' then raise exception 'Invalid covered person field' using errcode='22023';end if;end loop;
  if jsonb_array_length(p->'coverageKinds') not between 1 and 4 or exists(select 1 from jsonb_array_elements_text(p->'coverageKinds') x where x not in('medical','prescription','dental','vision')) then raise exception 'Invalid covered plans' using errcode='22023';end if;
  if (select count(distinct x) from jsonb_array_elements_text(p->'coverageKinds') x)<>jsonb_array_length(p->'coverageKinds') then raise exception 'Duplicate covered plans' using errcode='22023';end if;
  foreach k in array array['birthDate','effectiveDate','endDate'] loop if coalesce(p->>k,'')<>'' and (p->>k !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or p->>k like '0000-%') then raise exception 'Use calendar dates' using errcode='22023';end if;end loop;
  d:=nullif(p->>'birthDate','')::date;starts:=nullif(p->>'effectiveDate','')::date;ends:=nullif(p->>'endDate','')::date;
  if d>current_date or starts>ends then raise exception 'Invalid covered person dates' using errcode='22023';end if;
 end loop;
 if(v->>'coverageLevel' in('talent_only','not_recorded') and jsonb_array_length(v->'dependents')<>0) or(v->>'coverageLevel'='plus_one' and jsonb_array_length(v->'dependents')<>1) or(v->>'coverageLevel'='family' and jsonb_array_length(v->'dependents')=0) then raise exception 'Coverage arrangement mismatch' using errcode='22023';end if;
end $$;
revoke all on function private.healthcare_validate_profile(jsonb) from public,anon,authenticated,service_role;

-- New placements get an enrollment step. Ending dates/states open a cancellation
-- review, not an insurer cancellation. No existing placement is changed/backfilled.
create function private.healthcare_placement_step() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare v_kind text;v_due date;created_id uuid;
begin
 if not exists(select 1 from public.applicants a where a.id=new.applicant_id and a.organization_id=new.organization_id) then return new;end if;
 if new.end_date is not null or new.status in('ended','cancelled','inactive') then v_kind:='cancellation';v_due:=coalesce(new.end_date,current_date);
 elsif new.status in('placement_confirmed','onboarding','active') then v_kind:='enrollment';v_due:=new.start_date;
 else return new;end if;
 insert into public.talent_healthcare_actions(organization_id,applicant_id,placement_id,kind,due_date)
 values(new.organization_id,new.applicant_id,new.id,v_kind,v_due) on conflict(placement_id,kind) do nothing returning id into created_id;
 if created_id is not null then insert into public.talent_healthcare_events(organization_id,applicant_id,action,work_id,details) values(new.organization_id,new.applicant_id,'workflow_created',created_id,jsonb_build_object('kind',v_kind));
 else update public.talent_healthcare_actions set due_date=v_due,version=version+1,updated_at=now() where placement_id=new.id and kind=v_kind and status in('pending','in_progress') and due_date is distinct from v_due;end if;
 return new;
end $$;
revoke all on function private.healthcare_placement_step() from public,anon,authenticated,service_role;
create trigger healthcare_placement_step after insert or update of status,start_date,end_date on public.placements for each row execute function private.healthcare_placement_step();

create function public.talent_healthcare(p_actor_user_id uuid,p_body jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users%rowtype;t public.applicants%rowtype;p public.placements%rowtype;h public.talent_healthcare_profiles%rowtype;w public.talent_healthcare_actions%rowtype;
 staff boolean;act text:=p_body->>'action';pid uuid;rid uuid;fingerprint text;prior public.talent_healthcare_operations%rowtype;result jsonb;items jsonb;places jsonb;event_list jsonb;new_profile jsonb;
begin
 select * into a from public.platform_users where id=p_actor_user_id and active and not must_change_password and organization_id is not null for share;
 if not found or a.role not in('admin','talent_management','virtual_assistant') then raise exception 'Healthcare access required' using errcode='42501';end if;
 if p_body is null or jsonb_typeof(p_body)<>'object' or act is null or octet_length(p_body::text)>30000 then raise exception 'Invalid healthcare request' using errcode='22023';end if;
 staff:=a.role in('admin','talent_management');
 select * into t from public.applicants where id=(p_body->>'applicantId')::uuid and organization_id=a.organization_id for share;
 if not found or(not staff and(t.auth_user_id is distinct from a.id or t.archived_at is not null or t.portal_access_status is distinct from 'active')) then raise exception 'Own healthcare record required' using errcode='42501';end if;
 if act<>'view' and not staff then raise exception 'Healthcare management required' using errcode='42501';end if;
 if act='view' then
  if p_body-array['action','applicantId','placementId']<>'{}'::jsonb then raise exception 'Invalid query' using errcode='22023';end if;
  if p_body ? 'placementId' then
   if not staff then raise exception 'Private workflow' using errcode='42501';end if;
   pid:=(p_body->>'placementId')::uuid;
   if not exists(select 1 from public.placements where id=pid and organization_id=a.organization_id and applicant_id=t.id) then raise exception 'Placement unavailable' using errcode='42501';end if;
  end if;
  select * into h from public.talent_healthcare_profiles where applicant_id=t.id and organization_id=a.organization_id;
  if staff then
   select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'kind',x.kind,'status',x.status,'dueDate',x.due_date,'effectiveDate',x.effective_date,'reference',x.reference,'resolution',x.resolution,'version',x.version,'placementId',x.placement_id,'clientName',c.company_name) order by x.created_at desc),'[]') into items from public.talent_healthcare_actions x join public.placements pl on pl.id=x.placement_id join public.clients c on c.id=pl.client_id where x.applicant_id=t.id and x.organization_id=a.organization_id and(pid is null or x.placement_id=pid);
   select coalesce(jsonb_agg(jsonb_build_object('id',pl.id,'clientName',c.company_name,'status',pl.status,'startDate',pl.start_date,'endDate',pl.end_date) order by pl.start_date desc nulls last),'[]') into places from public.placements pl join public.clients c on c.id=pl.client_id where pl.applicant_id=t.id and pl.organization_id=a.organization_id and(pid is null or pl.id=pid);
   select coalesce(jsonb_agg(jsonb_build_object('action',e.action,'createdAt',e.created_at,'actorName',u.display_name,'details',e.details) order by e.id desc),'[]') into event_list from(select * from public.talent_healthcare_events where applicant_id=t.id and organization_id=a.organization_id and action<>'viewed' order by id desc limit 30)e left join public.platform_users u on u.id=e.actor_user_id;
  end if;
  insert into public.talent_healthcare_events(organization_id,applicant_id,actor_user_id,action) values(a.organization_id,t.id,a.id,'viewed');
  return jsonb_build_object('canManage',staff,'profile',case when h.applicant_id is null or pid is not null then null else h.profile||jsonb_build_object('version',h.version) end,'updatedAt',h.updated_at,'actions',coalesce(items,'[]'),'placements',coalesce(places,'[]'),'events',case when pid is not null then '[]'::jsonb else coalesce(event_list,'[]') end);
 end if;
 if act not in('save','start','resolve') or not(p_body?'requestId') then raise exception 'Invalid action' using errcode='22023';end if;
 rid:=(p_body->>'requestId')::uuid;fingerprint:=encode(sha256(convert_to(p_body::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended('talent-healthcare:'||t.id::text,0));
 select * into prior from public.talent_healthcare_operations where actor_user_id=a.id and request_id=rid;
 if found then if prior.fingerprint<>fingerprint then raise exception 'Request changed' using errcode='23505';end if;return prior.result;end if;
 if act='save' then
  if p_body-array['action','requestId','applicantId','expectedVersion','profile']<>'{}'::jsonb then raise exception 'Invalid profile fields' using errcode='22023';end if;
  new_profile:=p_body->'profile';perform private.healthcare_validate_profile(new_profile);
  if t.archived_at is not null and exists(select 1 from jsonb_array_elements(new_profile->'plans') x where x->>'status' in('pending','active')) then raise exception 'Archived Talent cannot begin coverage' using errcode='23514';end if;
  select * into h from public.talent_healthcare_profiles where applicant_id=t.id for update;
  if coalesce(h.version,0) is distinct from (p_body->>'expectedVersion')::integer then raise exception 'Record changed' using errcode='40001';end if;
  insert into public.talent_healthcare_profiles(applicant_id,organization_id,profile,updated_by) values(t.id,a.organization_id,new_profile,a.id)
  on conflict(applicant_id) do update set profile=excluded.profile,version=talent_healthcare_profiles.version+1,updated_by=a.id,updated_at=now() returning * into h;
  insert into public.talent_healthcare_history(applicant_id,organization_id,version,profile,recorded_by) values(t.id,a.organization_id,h.version,h.profile,a.id);
  insert into public.talent_healthcare_events(organization_id,applicant_id,actor_user_id,action,details)values(a.organization_id,t.id,a.id,'coverage_updated',jsonb_build_object('version',h.version));result:=jsonb_build_object('version',h.version);
 elsif act='start' then
  if p_body-array['action','requestId','applicantId','placementId','kind','dueDate']<>'{}'::jsonb or coalesce(p_body->>'kind','') not in('enrollment','cancellation') or nullif(p_body->>'dueDate','') is null then raise exception 'Invalid step' using errcode='22023';end if;
  select * into p from public.placements where id=(p_body->>'placementId')::uuid and organization_id=a.organization_id and applicant_id=t.id for share;
  if not found then raise exception 'Placement unavailable' using errcode='42501';end if;
  if p_body->>'kind'='enrollment' and(t.archived_at is not null or p.end_date is not null or p.status not in('placement_confirmed','onboarding','active')) then raise exception 'Placement is not onboarding or active' using errcode='23514';end if;
  insert into public.talent_healthcare_actions(organization_id,applicant_id,placement_id,kind,due_date)values(a.organization_id,t.id,p.id,p_body->>'kind',(p_body->>'dueDate')::date) on conflict(placement_id,kind) do nothing returning * into w;
  if not found then select * into w from public.talent_healthcare_actions where placement_id=p.id and kind=p_body->>'kind';else insert into public.talent_healthcare_events(organization_id,applicant_id,actor_user_id,action,work_id,details)values(a.organization_id,t.id,a.id,'workflow_created',w.id,jsonb_build_object('kind',w.kind));end if;
  result:=jsonb_build_object('id',w.id,'version',w.version);
 else
  if p_body-array['action','requestId','applicantId','actionId','expectedVersion','dueDate','status','resolution','effectiveDate','reference','confirmed']<>'{}'::jsonb or coalesce(p_body->>'status','') not in('in_progress','completed','not_applicable') or coalesce(p_body->>'resolution','') not in('carrier_confirmed','no_coverage','coverage_continues','talent_declined','reviewed_exception') or jsonb_typeof(p_body->'confirmed') is distinct from 'boolean' or char_length(coalesce(p_body->>'reference',''))>160 then raise exception 'Invalid result' using errcode='22023';end if;
  select * into w from public.talent_healthcare_actions where id=(p_body->>'actionId')::uuid and organization_id=a.organization_id and applicant_id=t.id for update;
  if not found then raise exception 'Step unavailable' using errcode='42501';end if;
  if w.version is distinct from (p_body->>'expectedVersion')::integer then raise exception 'Step changed' using errcode='40001';end if;
  if w.status in('completed','not_applicable') then raise exception 'Step is already closed' using errcode='23514';end if;
  if p_body->>'status'<>'in_progress' and p_body->>'confirmed'<>'true' then raise exception 'Confirmation required' using errcode='22023';end if;
  if p_body->>'status'='completed' then
   if nullif(p_body->>'effectiveDate','') is null or coalesce(btrim(p_body->>'reference'),'')='' or p_body->>'resolution'<>'carrier_confirmed' then raise exception 'Carrier confirmation required' using errcode='22023';end if;
   select * into h from public.talent_healthcare_profiles where applicant_id=t.id;
   if w.kind='cancellation' and exists(select 1 from jsonb_array_elements(h.profile->'dependents') x where nullif(x->>'endDate','') is null or (x->>'endDate')::date>(p_body->>'effectiveDate')::date) then raise exception 'Review dependent coverage end dates' using errcode='23514';end if;
   if w.kind='cancellation' and not exists(select 1 from jsonb_array_elements(h.profile->'plans') x where x->>'status' in('ending','ended')) then raise exception 'Record ended coverage or choose no coverage to change' using errcode='23514';end if;
   if w.kind='enrollment' and(t.archived_at is not null or not exists(select 1 from public.placements where id=w.placement_id and end_date is null and status in('onboarding','active','placement_confirmed')) or not exists(select 1 from jsonb_array_elements(h.profile->'plans') x where x->>'status'='active' and nullif(x->>'effectiveDate','')::date<=(p_body->>'effectiveDate')::date and (nullif(x->>'endDate','') is null or(x->>'endDate')::date>=(p_body->>'effectiveDate')::date))) then raise exception 'Confirm current enrollment details' using errcode='23514';end if;
   if w.kind='cancellation' and(exists(select 1 from public.placements where applicant_id=t.id and organization_id=a.organization_id and id<>w.placement_id and (end_date is null or end_date>=(p_body->>'effectiveDate')::date) and status in('onboarding','active','placement_confirmed')) or exists(select 1 from jsonb_array_elements(h.profile->'plans') x where x->>'status' in('active','pending') or(x->>'status' in('ending','ended') and(nullif(x->>'endDate','') is null or(x->>'endDate')::date>(p_body->>'effectiveDate')::date)))) then raise exception 'Review all current coverage before cancellation' using errcode='23514';end if;
  elsif p_body->>'status'='not_applicable' and p_body->>'resolution'='carrier_confirmed' then raise exception 'Choose reviewed reason' using errcode='22023';end if;
  update public.talent_healthcare_actions set due_date=case when p_body?'dueDate' then nullif(p_body->>'dueDate','')::date else due_date end,status=p_body->>'status',resolution=p_body->>'resolution',reference=coalesce(p_body->>'reference',''),effective_date=nullif(p_body->>'effectiveDate','')::date,completed_by=case when p_body->>'status'<>'in_progress' then a.id end,completed_at=case when p_body->>'status'<>'in_progress' then now() end,version=version+1,updated_at=now() where id=w.id returning * into w;
  insert into public.talent_healthcare_events(organization_id,applicant_id,actor_user_id,action,work_id,details)values(a.organization_id,t.id,a.id,'workflow_updated',w.id,jsonb_build_object('status',w.status,'resolution',w.resolution));result:=jsonb_build_object('id',w.id,'version',w.version);
 end if;
 insert into public.talent_healthcare_operations(actor_user_id,request_id,fingerprint,result)values(a.id,rid,fingerprint,result);
 return result;
end $$;
revoke all on function public.talent_healthcare(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.talent_healthcare(uuid,jsonb) to service_role;
comment on table public.talent_healthcare_profiles is 'Minimum benefit administration only. No clinical notes. No shared profile, Sales, Client or Billing access.';
comment on table public.talent_healthcare_events is 'Private access/change log; never copied to shared audit_events or notifications.';
commit;
