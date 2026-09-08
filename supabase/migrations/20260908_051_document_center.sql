-- Document Center: immutable originals, assigned packets, reviewed submissions.
-- No seed documents/accounts. No deletion or relabeling of captured uploads.
begin;

create table public.dc_files (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 uploader_id uuid not null references public.platform_users(id), purpose text not null check(purpose in ('template','submission')),
 item_id uuid, name text not null check(char_length(name) between 1 and 180),
 mime text not null check(mime in ('application/pdf','image/png','image/jpeg','application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
 byte_size integer not null check(byte_size between 1 and 10485760), sha256 text,
 state text not null default 'pending' check(state in ('pending','ready')), expires_at timestamptz not null default now()+interval '1 hour',
 created_at timestamptz not null default now(), completed_at timestamptz,
 check(sha256 is null or sha256 ~ '^[a-f0-9]{64}$'), check((state='ready')=(sha256 is not null)),
 check((purpose='submission')=(item_id is not null)), unique(id,item_id)
);
create table public.dc_templates (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 title text not null check(char_length(btrim(title)) between 1 and 160), team text not null check(team in ('admin','sales','talent_management','billing')),
 audience text not null check(audience in ('talent','client','employee')),
 category text not null check(category in ('onboarding','agreement','tax','policy','evidence','business')),
 kind text not null check(kind in ('print_sign','upload','acknowledge','form')),
 instructions text not null default '' check(char_length(instructions)<=4000), fields jsonb not null default '[]'::jsonb,
 file_id uuid references public.dc_files(id), active boolean not null default true,
 created_by uuid not null references public.platform_users(id), created_at timestamptz not null default now(),
 check(jsonb_typeof(fields)='array' and jsonb_array_length(fields)<=20),
 check(kind not in ('print_sign','acknowledge') or file_id is not null),
 check(category not in ('tax','agreement') or kind='print_sign'),
 check(audience<>'employee' or team='admin')
);
create table public.dc_packets (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 title text not null check(char_length(btrim(title)) between 1 and 160),description text not null default '' check(char_length(description)<=2000),
 team text not null, audience text not null, template_ids uuid[] not null check(cardinality(template_ids) between 1 and 20),
 active boolean not null default true,created_by uuid not null references public.platform_users(id),created_at timestamptz not null default now()
);
create table public.dc_requests (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 packet_id uuid not null references public.dc_packets(id),title text not null,team text not null,
 subject_kind text not null check(subject_kind in ('talent','client','employee')), subject_id uuid not null,
 recipient_id uuid not null references public.platform_users(id),created_by uuid not null references public.platform_users(id),
 due_date date,status text not null default 'pending' check(status in ('pending','submitted','returned','complete','cancelled')),
 version integer not null default 1,created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table public.dc_items (
 id uuid primary key default gen_random_uuid(),request_id uuid not null references public.dc_requests(id),template_id uuid not null references public.dc_templates(id),
 position integer not null,status text not null default 'pending' check(status in ('pending','submitted','returned','accepted')),
 latest_submission_id uuid,correction text not null default '',unique(request_id,template_id),unique(id,request_id)
);
alter table public.dc_files add foreign key(item_id) references public.dc_items(id);
create table public.dc_submissions (
 id uuid primary key default gen_random_uuid(),item_id uuid not null references public.dc_items(id),file_id uuid references public.dc_files(id),
 answers jsonb not null default '{}'::jsonb,acknowledged boolean not null default false,
 version integer not null,created_by uuid not null references public.platform_users(id),created_at timestamptz not null default now(),
 unique(item_id,version),unique(file_id),unique(id,item_id),
 foreign key(file_id,item_id) references public.dc_files(id,item_id),
 check(jsonb_typeof(answers)='object' and octet_length(answers::text)<=50000)
);
alter table public.dc_items add foreign key(latest_submission_id,id) references public.dc_submissions(id,item_id);
create table public.dc_events (
 seq bigint generated always as identity primary key,request_id uuid not null references public.dc_requests(id),
 actor_id uuid not null references public.platform_users(id),action text not null,note text not null default '',
 item_id uuid references public.dc_items(id),created_at timestamptz not null default now(),
 foreign key(item_id,request_id) references public.dc_items(id,request_id)
);
create table public.dc_operations (
 actor_id uuid not null references public.platform_users(id),request_id uuid not null,fingerprint text not null,result jsonb not null,
 created_at timestamptz not null default now(),primary key(actor_id,request_id)
);
create table public.dc_legacy_links (
 document_id uuid primary key references public.documents(id), organization_id uuid not null references public.organizations(id),
 subject_kind text not null check(subject_kind in ('talent','employee','client')),subject_id uuid not null,
 recipient_id uuid not null references public.platform_users(id),recipient_active boolean not null default true,category text not null check(category in ('onboarding','agreement','tax','policy','evidence','business')),
 reviewed_by uuid not null references public.platform_users(id),reviewed_at timestamptz not null default now()
);
create index dc_request_queue on public.dc_requests(organization_id,team,status,updated_at desc,id);
create index dc_request_recipient on public.dc_requests(recipient_id,updated_at desc,id);
create index dc_event_request on public.dc_events(request_id,seq);
create index dc_items_request on public.dc_items(request_id,position);
create index dc_templates_org on public.dc_templates(organization_id,active);
create index dc_submissions_item on public.dc_submissions(item_id,version desc);
do $$ declare t text; begin
 foreach t in array array['dc_files','dc_templates','dc_packets','dc_requests','dc_items','dc_submissions','dc_events','dc_operations','dc_legacy_links'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
 end loop;
end $$;

create function public.document_center_change(p_actor_user_id uuid,p_body jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users%rowtype;r public.dc_requests%rowtype;t public.dc_templates%rowtype;p public.dc_packets%rowtype;i public.dc_items%rowtype;f public.dc_files%rowtype;
 o public.dc_operations%rowtype;action text:=p_body->>'action';key uuid:=(p_body->>'requestId')::uuid;fingerprint text;result jsonb;ids uuid[];tid uuid;sid uuid;field jsonb;v integer;n integer;recipient public.platform_users%rowtype;
begin
 a:=private.dc_actor(p_actor_user_id);
 if key is null or octet_length(p_body::text)>60000 then raise exception 'Invalid document action' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(a.id::text||key::text,0));
 fingerprint:=encode(extensions.digest(convert_to(p_body::text,'UTF8'),'sha256'),'hex');
 select * into o from public.dc_operations where actor_id=a.id and request_id=key;
 if found then if o.fingerprint<>fingerprint then raise exception 'Request changed' using errcode='23505';end if;return o.result;end if;
 if action='create_template' then
   if a.role<>'admin' then raise exception 'Only Admin can publish originals' using errcode='42501';end if;
   if p_body->>'kind'='form' then
     if jsonb_typeof(p_body->'fields') is distinct from 'array' or coalesce(jsonb_array_length(p_body->'fields'),0) not between 1 and 20 then raise exception 'Add form questions' using errcode='22023';end if;
     for field in select value from jsonb_array_elements(p_body->'fields') loop
       if jsonb_typeof(field) is distinct from 'object' or not(field?&array['id','label','required']) or jsonb_typeof(field->'id') is distinct from 'string' or jsonb_typeof(field->'label') is distinct from 'string' or field->>'id' !~ '^q[1-9][0-9]?$' or char_length(btrim(field->>'label')) not between 1 and 160 or jsonb_typeof(field->'required') is distinct from 'boolean' or field-array['id','label','required']<>'{}'::jsonb then raise exception 'Invalid questions' using errcode='22023';end if;
     end loop;
     if(select count(*)<>count(distinct value->>'id') from jsonb_array_elements(p_body->'fields')) then raise exception 'Duplicate questions' using errcode='22023';end if;
   elsif coalesce(p_body->'fields','[]'::jsonb)<>'[]'::jsonb then raise exception 'Questions belong to information forms only' using errcode='22023';end if;
   if p_body->>'fileId' is not null then
     select * into f from public.dc_files where id=(p_body->>'fileId')::uuid and organization_id=a.organization_id and uploader_id=a.id and state='ready' and purpose='template' for update;
     if not found then raise exception 'Original not available' using errcode='42501';end if;
   end if;
   insert into public.dc_templates(organization_id,title,team,audience,category,kind,instructions,fields,file_id,created_by)
   values(a.organization_id,btrim(p_body->>'title'),p_body->>'team',p_body->>'audience',p_body->>'category',p_body->>'kind',coalesce(p_body->>'instructions',''),coalesce(p_body->'fields','[]'::jsonb),f.id,a.id) returning * into t;
   result:=jsonb_build_object('id',t.id);
   insert into public.audit_events(organization_id,actor_user_id,entity_type,entity_id,event_type) values(a.organization_id,a.id,'document_template',t.id,'original_published');
 elsif action='create_packet' then
   if a.role<>'admin' then raise exception 'Only Admin can publish packets' using errcode='42501';end if;
   select array_agg(value::uuid) into ids from jsonb_array_elements_text(p_body->'templateIds');
   if cardinality(ids) not between 1 and 20 or cardinality(ids)<>(select count(distinct x) from unnest(ids)x) then raise exception 'Choose 1 to 20 different forms' using errcode='22023';end if;
   select * into t from public.dc_templates where id=ids[1] and organization_id=a.organization_id and active for share;
   if not found or exists(select 1 from unnest(ids) x left join public.dc_templates tt on tt.id=x where tt.id is null or tt.organization_id<>a.organization_id or not tt.active or tt.team<>t.team or tt.audience<>t.audience) then raise exception 'Forms must share a team and audience' using errcode='22023';end if;
   insert into public.dc_packets(organization_id,title,description,team,audience,template_ids,created_by) values(a.organization_id,btrim(p_body->>'title'),coalesce(p_body->>'description',''),t.team,t.audience,ids,a.id) returning * into p;
   result:=jsonb_build_object('id',p.id);
   insert into public.audit_events(organization_id,actor_user_id,entity_type,entity_id,event_type) values(a.organization_id,a.id,'document_packet',p.id,'packet_published');
 elsif action='retire' then
   if a.role<>'admin' then raise exception 'Only Admin can retire originals' using errcode='42501';end if;
   if p_body->>'kind'='template' then update public.dc_templates set active=false where id=(p_body->>'id')::uuid and organization_id=a.organization_id;
   elsif p_body->>'kind'='packet' then update public.dc_packets set active=false where id=(p_body->>'id')::uuid and organization_id=a.organization_id;
   else raise exception 'Invalid original' using errcode='22023';end if;
   if not found then raise exception 'Not permitted' using errcode='42501';end if;
   result:=jsonb_build_object('id',p_body->>'id');
   insert into public.audit_events(organization_id,actor_user_id,entity_type,entity_id,event_type) values(a.organization_id,a.id,'document_'||(p_body->>'kind'),(p_body->>'id')::uuid,'original_retired');
 elsif action='unlink_legacy' then
   if a.role<>'admin' then raise exception 'Not permitted' using errcode='42501';end if;
   update public.dc_legacy_links set recipient_active=false,reviewed_by=a.id,reviewed_at=now() where document_id=(p_body->>'id')::uuid and organization_id=a.organization_id;
   if not found then raise exception 'No reviewed link exists' using errcode='22023';end if;
   insert into public.audit_events(organization_id,actor_user_id,entity_type,entity_id,event_type) values(a.organization_id,a.id,'document',(p_body->>'id')::uuid,'reviewed_document_share_removed');
   result:=jsonb_build_object('id',p_body->>'id');
 elsif action='link_legacy' then
   if a.role<>'admin' or not private.dc_subject_valid(a,p_body->>'subjectKind',(p_body->>'subjectId')::uuid,(p_body->>'recipientId')::uuid) then raise exception 'Not permitted' using errcode='42501';end if;
   -- A captured Talent relationship is authoritative; never silently reassign it.
   if not exists(select 1 from public.documents d where d.id=(p_body->>'id')::uuid and d.organization_id=a.organization_id
   and(d.applicant_id is null or(p_body->>'subjectKind'='talent' and d.applicant_id=(p_body->>'subjectId')::uuid))
   and(d.client_id is null or(p_body->>'subjectKind'='client' and d.client_id=(p_body->>'subjectId')::uuid))
   and(d.placement_id is null or exists(select 1 from public.placements pl where pl.id=d.placement_id and pl.organization_id=d.organization_id and((p_body->>'subjectKind'='talent' and pl.applicant_id=(p_body->>'subjectId')::uuid) or(p_body->>'subjectKind'='client' and pl.client_id=(p_body->>'subjectId')::uuid))))) then raise exception 'Captured relationship needs manual review' using errcode='22023';end if;
   if exists(select 1 from public.platform_users u where u.id=(p_body->>'recipientId')::uuid and ((u.role='client_reviewer' and p_body->>'category' in ('agreement','tax')) or(u.role='client_billing' and p_body->>'category'<>'tax'))) then raise exception 'Recipient role cannot receive that category' using errcode='42501';end if;
   insert into public.dc_legacy_links(document_id,organization_id,subject_kind,subject_id,recipient_id,category,reviewed_by)
   values((p_body->>'id')::uuid,a.organization_id,p_body->>'subjectKind',(p_body->>'subjectId')::uuid,(p_body->>'recipientId')::uuid,p_body->>'category',a.id)
   on conflict(document_id) do update set subject_kind=excluded.subject_kind,subject_id=excluded.subject_id,recipient_id=excluded.recipient_id,recipient_active=true,category=excluded.category,reviewed_by=a.id,reviewed_at=now();
   insert into public.audit_events(organization_id,actor_user_id,entity_type,entity_id,event_type) values(a.organization_id,a.id,'document',(p_body->>'id')::uuid,'document_classified');
   result:=jsonb_build_object('id',p_body->>'id');
 elsif action='assign' then
   select * into p from public.dc_packets where id=(p_body->>'packetId')::uuid and organization_id=a.organization_id and active for share;
   if not found or not private.dc_subject_valid(a,p_body->>'subjectKind',(p_body->>'subjectId')::uuid,(p_body->>'recipientId')::uuid) or p.audience<>p_body->>'subjectKind' then raise exception 'Recipient unavailable' using errcode='42501';end if;
   if not(a.role='admin' or(a.role='talent_management' and p.team='talent_management' and p.audience='talent') or(a.role in ('sales','sales_management') and p.team='sales' and p.audience='client' and exists(select 1 from public.clients c where c.id=(p_body->>'subjectId')::uuid and c.organization_id=a.organization_id and(a.role='sales_management' or c.sales_owner_id=a.id)))) then raise exception 'Not permitted' using errcode='42501';end if;
   if exists(select 1 from unnest(p.template_ids) x left join public.dc_templates tt on tt.id=x where tt.id is null or not tt.active or tt.organization_id<>a.organization_id or tt.team<>p.team or tt.audience<>p.audience) then raise exception 'Packet includes retired forms' using errcode='22023';end if;
   select * into recipient from public.platform_users where id=(p_body->>'recipientId')::uuid;
   if recipient.role='client_reviewer' and exists(select 1 from public.dc_templates tt where tt.id=any(p.template_ids) and(tt.kind='print_sign' or tt.category in ('agreement','tax'))) then raise exception 'Client Administrator must receive signature requests' using errcode='42501';end if;
   if recipient.role='client_billing' and exists(select 1 from public.dc_templates tt where tt.id=any(p.template_ids) and tt.category<>'tax') then raise exception 'Billing recipient cannot receive this packet' using errcode='42501';end if;
   insert into public.dc_requests(organization_id,packet_id,title,team,subject_kind,subject_id,recipient_id,created_by,due_date)
   values(a.organization_id,p.id,p.title,p.team,p.audience,(p_body->>'subjectId')::uuid,recipient.id,a.id,(p_body->>'dueDate')::date) returning * into r;
   n:=0;foreach tid in array p.template_ids loop n:=n+1;insert into public.dc_items(request_id,template_id,position) values(r.id,tid,n);end loop;
   perform private.dc_event(a,r,'Packet assigned');result:=jsonb_build_object('id',r.id);
 elsif action in ('submit','review','cancel') then
   if action='cancel' then select * into r from public.dc_requests where id=(p_body->>'id')::uuid for update;
   else
     select * into i from public.dc_items where id=(p_body->>'id')::uuid;
     select * into r from public.dc_requests where id=i.request_id for update;
     select * into i from public.dc_items where id=i.id;
     select * into t from public.dc_templates where id=i.template_id;
   end if;
   if r.id is null or not private.dc_request_access(a,r) then raise exception 'Not permitted' using errcode='42501';end if;
   if r.version is distinct from (p_body->>'expectedVersion')::integer then raise exception 'Refresh before updating' using errcode='40001';end if;
   if r.status in ('complete','cancelled') then raise exception 'Request is closed' using errcode='22023';end if;
   if action='cancel' then
     if a.id=r.recipient_id or not private.dc_team_access(a,r) or a.role='billing' then raise exception 'Not permitted' using errcode='42501';end if;
     update public.dc_requests set status='cancelled',version=version+1,updated_at=now() where id=r.id returning * into r;
     perform private.dc_event(a,r,'Request cancelled');
   elsif action='submit' then
     if a.id<>r.recipient_id or i.status not in ('pending','returned') or not private.dc_subject_valid(a,r.subject_kind,r.subject_id,r.recipient_id) then raise exception 'Not permitted' using errcode='42501';end if;
     if t.kind in ('upload','print_sign') then
       select * into f from public.dc_files where id=(p_body->>'fileId')::uuid and item_id=i.id and purpose='submission' and uploader_id=a.id and organization_id=a.organization_id and state='ready' for update;
       if not found or coalesce(p_body->'answers','{}'::jsonb)<>'{}'::jsonb or coalesce((p_body->>'acknowledge')::boolean,false) then raise exception 'Upload a completed document' using errcode='22023';end if;
     elsif t.kind='form' then
       if p_body->>'fileId' is not null or coalesce((p_body->>'acknowledge')::boolean,false) or jsonb_typeof(p_body->'answers')<>'object' then raise exception 'Invalid form response' using errcode='22023';end if;
       if exists(select 1 from jsonb_each(p_body->'answers') e where not exists(select 1 from jsonb_array_elements(t.fields) x where x->>'id'=e.key) or jsonb_typeof(e.value)<>'string' or char_length(e.value#>>'{}')>2000) then raise exception 'Invalid answers' using errcode='22023';end if;
       for field in select value from jsonb_array_elements(t.fields) loop if(field->>'required')::boolean and coalesce(btrim(p_body->'answers'->>(field->>'id')),'')='' then raise exception 'Complete required fields' using errcode='22023';end if;end loop;
     elsif t.kind='acknowledge' then
       if coalesce((p_body->>'acknowledge')::boolean,false) is not true or p_body->>'fileId' is not null or coalesce(p_body->'answers','{}'::jsonb)<>'{}'::jsonb then raise exception 'Confirm acknowledgment' using errcode='22023';end if;
     end if;
     select coalesce(max(version),0)+1 into v from public.dc_submissions where item_id=i.id;
     insert into public.dc_submissions(item_id,file_id,answers,acknowledged,version,created_by) values(i.id,f.id,coalesce(p_body->'answers','{}'::jsonb),coalesce((p_body->>'acknowledge')::boolean,false),v,a.id) returning id into sid;
     update public.dc_items set latest_submission_id=sid,status='submitted',correction='' where id=i.id;
   else
     if a.id=r.recipient_id or not private.dc_team_access(a,r) or not private.dc_item_access(a,r,t) or i.status<>'submitted' or not private.dc_subject_valid(a,r.subject_kind,r.subject_id,r.recipient_id) then raise exception 'Not permitted' using errcode='42501';end if;
     if p_body->>'decision' not in ('accepted','returned') or char_length(coalesce(p_body->>'note',''))>2000 or(p_body->>'decision'='returned' and coalesce(btrim(p_body->>'note'),'')='') then raise exception 'Enter a correction reason' using errcode='22023';end if;
     update public.dc_items set status=p_body->>'decision',correction=case when p_body->>'decision'='returned' then btrim(p_body->>'note') else '' end where id=i.id;
   end if;
   if action<>'cancel' then
     update public.dc_requests set status=case when not exists(select 1 from public.dc_items where request_id=r.id and status<>'accepted') then 'complete'
       when exists(select 1 from public.dc_items where request_id=r.id and status='returned') then 'returned'
       when exists(select 1 from public.dc_items where request_id=r.id and status='submitted') then 'submitted' else 'pending' end,version=version+1,updated_at=now() where id=r.id returning * into r;
     perform private.dc_event(a,r,case when action='submit' then 'Document submitted' when p_body->>'decision'='accepted' then 'Submission accepted' else 'Corrections requested' end,i.id,coalesce(p_body->>'note',''));
     if r.status='complete' then perform private.dc_event(a,r,'Packet complete');end if;
   end if;
   result:=jsonb_build_object('id',r.id,'version',r.version);
 else raise exception 'Unknown document action' using errcode='22023';end if;
 insert into public.dc_operations(actor_id,request_id,fingerprint,result) values(a.id,key,fingerprint,result);
 return result;
end $$;

create function public.document_center_upload(p_actor_user_id uuid,p_body jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users%rowtype;f public.dc_files%rowtype;r public.dc_requests%rowtype;i public.dc_items%rowtype;t public.dc_templates%rowtype;
 o public.dc_operations%rowtype;key uuid;fingerprint text;result jsonb;begin
 a:=private.dc_actor(p_actor_user_id);
 if coalesce(p_body->>'action','') not in ('prepare_upload','get_upload','finalize_upload') then raise exception 'Invalid upload action' using errcode='22023';end if;
 if p_body->>'action'='prepare_upload' then
   key:=(p_body->>'requestId')::uuid;
   if key is null then raise exception 'Invalid upload request' using errcode='22023';end if;
   perform pg_advisory_xact_lock(hashtextextended(a.id::text||key::text,0));
   fingerprint:=encode(extensions.digest(convert_to(p_body::text,'UTF8'),'sha256'),'hex');
   select * into o from public.dc_operations where actor_id=a.id and request_id=key;
   if found then if o.fingerprint<>fingerprint then raise exception 'Request changed' using errcode='23505';end if;select * into f from public.dc_files where id=(o.result->>'fileId')::uuid;
   else
     if p_body->>'purpose'='template' then
       if a.role<>'admin' or p_body->>'itemId' is not null then raise exception 'Not permitted' using errcode='42501';end if;
     elsif p_body->>'purpose'='submission' then
       select * into i from public.dc_items where id=(p_body->>'itemId')::uuid;
       select * into r from public.dc_requests where id=i.request_id;
       select * into t from public.dc_templates where id=i.template_id;
       if r.id is null or a.id<>r.recipient_id or not private.dc_request_access(a,r) or r.status in ('cancelled','complete') or i.status not in ('pending','returned') or t.kind not in ('print_sign','upload') then raise exception 'Not permitted' using errcode='42501';end if;
     else raise exception 'Invalid upload purpose' using errcode='22023';end if;
     insert into public.dc_files(organization_id,uploader_id,purpose,item_id,name,mime,byte_size) values(a.organization_id,a.id,p_body->>'purpose',(p_body->>'itemId')::uuid,p_body->>'name',p_body->>'type',(p_body->>'size')::integer) returning * into f;
     insert into public.dc_operations(actor_id,request_id,fingerprint,result) values(a.id,key,fingerprint,jsonb_build_object('fileId',f.id));
   end if;
 else
   select * into f from public.dc_files where id=(p_body->>'fileId')::uuid and organization_id=a.organization_id and uploader_id=a.id for update;
 end if;
 if f.id is null or f.organization_id<>a.organization_id or f.uploader_id<>a.id then raise exception 'Not permitted' using errcode='42501';end if;
 -- Recheck access on retries and finalization, not just when reserving storage.
 if f.purpose='template' then if a.role<>'admin' then raise exception 'Not permitted' using errcode='42501';end if;
 else
   select * into i from public.dc_items where id=f.item_id;select * into r from public.dc_requests where id=i.request_id;
   if a.id<>r.recipient_id or not private.dc_request_access(a,r) or r.status in ('cancelled','complete') or(i.status not in ('pending','returned') and f.state<>'ready') then raise exception 'Not permitted' using errcode='42501';end if;
 end if;
 if f.state='pending' and f.expires_at<now() then raise exception 'Upload expired' using errcode='22023';end if;
 if p_body->>'action'='finalize_upload' then
   if p_body->>'sha256' !~ '^[a-f0-9]{64}$' or f.mime<>p_body->>'type' or f.byte_size<>(p_body->>'size')::integer then raise exception 'File verification failed' using errcode='22023';end if;
   if f.state='ready' and f.sha256<>p_body->>'sha256' then raise exception 'File changed' using errcode='23505';end if;
   update public.dc_files set state='ready',sha256=p_body->>'sha256',completed_at=coalesce(completed_at,now()) where id=f.id returning * into f;
 end if;
 return jsonb_build_object('fileId',f.id,'bucket','soro-document-center','path','organizations/'||f.organization_id||'/files/'||f.id,'name',f.name,'type',f.mime,'size',f.byte_size,'state',f.state);
end $$;

create function public.document_center_notifications(p_actor_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users%rowtype;begin
 a:=private.dc_actor(p_actor_user_id);
 return jsonb_build_object('count',(select count(*) from public.dc_requests r where private.dc_request_access(a,r) and r.status not in ('complete','cancelled') and(
 (r.recipient_id=a.id and exists(select 1 from public.dc_items i where i.request_id=r.id and i.status in ('pending','returned')))
 or(r.recipient_id<>a.id and private.dc_team_access(a,r) and exists(select 1 from public.dc_items i join public.dc_templates t on t.id=i.template_id where i.request_id=r.id and i.status='submitted' and private.dc_item_access(a,r,t))))));
end $$;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('soro-document-center','soro-document-center',false,10485760,array['application/pdf','image/png','image/jpeg','application/vnd.openxmlformats-officedocument.wordprocessingml.document']);
-- No browser policies on this bucket: reads/writes use short-lived authorized URLs.

create function private.dc_actor(p_id uuid) returns public.platform_users
language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users%rowtype;begin
 select * into a from private.active_support_actor(p_id);return a;
end $$;

create function private.dc_subject_valid(a public.platform_users,k text,s uuid,u uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
select coalesce(exists(select 1 from public.platform_users p where p.id=u and p.organization_id=a.organization_id and p.active and not p.must_change_password)
 and case k when 'talent' then exists(select 1 from public.applicants x join public.platform_users p on p.id=x.auth_user_id where x.id=s and x.auth_user_id=u and x.organization_id=a.organization_id and x.archived_at is null and x.portal_access_status='active' and p.role='virtual_assistant')
 when 'employee' then exists(select 1 from public.employee_profiles e join public.platform_users p on p.id=e.user_id where e.user_id=s and s=u and e.organization_id=a.organization_id and p.organization_id=e.organization_id and p.role in ('admin','talent_management','sales','sales_management','billing'))
 when 'client' then exists(select 1 from public.client_portal_memberships m join public.clients c on c.id=m.client_id and c.organization_id=m.organization_id join public.client_contacts cc on cc.id=m.client_contact_id and cc.client_id=c.id and cc.organization_id=c.organization_id join public.platform_users p on p.id=m.user_id where m.user_id=u and m.client_id=s and m.organization_id=a.organization_id and m.active and cc.active and c.archived_at is null and p.role in ('client_admin','client_reviewer','client_billing')) else false end,false);
$$;
create function private.dc_subject_name(k text,s uuid) returns text
language sql stable security definer set search_path=pg_catalog,public as $$
select case k when 'talent' then(select full_name from public.applicants where id=s) when 'client' then(select company_name from public.clients where id=s) when 'employee' then(select display_name from public.platform_users where id=s) end;
$$;
create function private.dc_legacy_access(a public.platform_users,d public.documents) returns boolean
language sql stable security definer set search_path=pg_catalog,public,private as $$
 select coalesce(a.organization_id=d.organization_id and(a.role='admin'
 or (not exists(select 1 from public.dc_legacy_links m where m.document_id=d.id) and exists(select 1 from public.applicants x where x.id=d.applicant_id and x.organization_id=d.organization_id and x.archived_at is null and(x.auth_user_id=a.id or(a.role='talent_management' and d.status<>'rejected'))))
 or exists(select 1 from public.dc_legacy_links m where m.document_id=d.id and m.organization_id=d.organization_id and(
 (m.recipient_active and m.recipient_id=a.id and private.dc_subject_valid(a,m.subject_kind,m.subject_id,a.id))
 or(a.role='billing' and m.category='tax')
 or(a.role='talent_management' and m.subject_kind='talent' and m.category<>'tax')
 or(a.role in ('sales','sales_management') and m.subject_kind='client' and m.category<>'tax' and exists(select 1 from public.clients c where c.id=m.subject_id and c.organization_id=a.organization_id and c.archived_at is null and(a.role='sales_management' or c.sales_owner_id=a.id)))
 ))),false);
$$;
-- Restrictive policies also protect the older direct profile/storage APIs.
-- Security-definer helpers avoid recursive RLS when examining captured metadata.
create function private.legacy_document_read_allowed(p_id uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,public,private as $$
 select coalesce((select private.dc_legacy_access(a,d) and not exists(
  select 1 from public.documents other join public.dc_legacy_links m on m.document_id=other.id
  where other.organization_id=d.organization_id and other.storage_path=d.storage_path and not private.dc_legacy_access(a,other))
 from public.documents d join public.platform_users a on a.id=auth.uid() and a.active and not a.must_change_password where d.id=p_id),false);
$$;
create function private.legacy_object_read_allowed(p_path text) returns boolean
language sql stable security definer set search_path=pg_catalog,public,private as $$
 select exists(select 1 from public.documents d where d.storage_path=p_path and private.legacy_document_read_allowed(d.id));
$$;
revoke all on function private.legacy_document_read_allowed(uuid),private.legacy_object_read_allowed(text) from public,anon,authenticated,service_role;
grant execute on function private.legacy_document_read_allowed(uuid),private.legacy_object_read_allowed(text) to authenticated;
create policy "Captured document classification is enforced" on public.documents as restrictive for select to authenticated
 using(private.legacy_document_read_allowed(id));
create policy "Captured object classification is enforced" on storage.objects as restrictive for select to authenticated
 using(bucket_id<>'soro-private-documents' or private.legacy_object_read_allowed(name));
create function private.dc_team_access(a public.platform_users,r public.dc_requests) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
select coalesce(a.organization_id=r.organization_id and (
 a.role='admin' or (a.role='talent_management' and r.team='talent_management' and r.subject_kind='talent')
 or (a.role in ('sales','sales_management') and r.team='sales' and r.subject_kind='client' and exists(select 1 from public.clients c where c.id=r.subject_id and c.organization_id=a.organization_id and c.archived_at is null and(a.role='sales_management' or c.sales_owner_id=a.id)))
 or(a.role='billing' and exists(select 1 from public.dc_items i join public.dc_templates t on t.id=i.template_id where i.request_id=r.id and t.category='tax'))),false);
$$;
create function private.dc_request_access(a public.platform_users,r public.dc_requests) returns boolean
language sql stable security definer set search_path=pg_catalog,public,private as $$
select coalesce(a.organization_id=r.organization_id and (private.dc_team_access(a,r) or(a.id=r.recipient_id and private.dc_subject_valid(a,r.subject_kind,r.subject_id,r.recipient_id))),false);
$$;
create function private.dc_item_access(a public.platform_users,r public.dc_requests,t public.dc_templates) returns boolean
language sql stable security definer set search_path=pg_catalog,public,private as $$
select t.organization_id=r.organization_id and private.dc_request_access(a,r) and (a.id=r.recipient_id or a.role='admin' or(a.role='billing' and t.category='tax') or(a.role<>'billing' and t.category<>'tax' and private.dc_team_access(a,r)));
$$;
create function private.dc_library_access(a public.platform_users,t public.dc_templates) returns boolean
language sql stable set search_path=pg_catalog as $$
select a.organization_id=t.organization_id and (a.role='admin' or(a.role='talent_management' and t.team='talent_management' and t.audience='talent') or(a.role in ('sales','sales_management') and t.team='sales' and t.audience='client') or(a.role='billing' and t.category='tax'));
$$;
create function private.dc_event(a public.platform_users,r public.dc_requests,p_action text,p_item uuid default null,p_note text default '') returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 insert into public.dc_events(request_id,actor_id,action,item_id,note) values(r.id,a.id,p_action,p_item,p_note);
 insert into public.audit_events(organization_id,actor_user_id,entity_type,entity_id,event_type,after_value)
 values(a.organization_id,a.id,'document_request',r.id,p_action,jsonb_build_object('status',r.status,'version',r.version));
end $$;

-- Remove the old permissive write policy without disrupting real Talent uploads.
create function private.can_upload_legacy_talent_object(p_name text) returns boolean
language sql stable security definer set search_path=pg_catalog,public,private as $$
select coalesce(private.current_soro_role() in ('admin','talent_management') and exists(select 1 from public.applicants a
 where a.organization_id=private.current_soro_organization_id() and a.id::text=split_part(p_name,'/',2)
 and(p_name ~ '^talent/[^/]+/[A-Za-z0-9._-]+$' or p_name ~ '^applicants/[^/]+/headshots/[A-Za-z0-9._-]+$')),false);
$$;
revoke all on function private.can_upload_legacy_talent_object(text) from public,anon,service_role;
grant execute on function private.can_upload_legacy_talent_object(text) to authenticated;
drop policy if exists "admin and talent management can manage documents" on public.documents;
revoke update,delete on public.documents from authenticated;
create policy "Managers can insert scoped legacy Talent uploads" on public.documents for insert to authenticated with check(
 organization_id=private.current_soro_organization_id() and applicant_id is not null and applicant_id::text=split_part(storage_path,'/',2)
 and private.can_upload_legacy_talent_object(storage_path) and client_id is null and placement_id is null and assigned_to_user_id is null and external_url is null and status='uploaded');
drop policy if exists "Soro admin and talent management can upload private documents" on storage.objects;
drop policy if exists "Soro admin and talent management can update private documents" on storage.objects;
drop policy if exists "Soro admin and talent management can delete private documents" on storage.objects;
create policy "Managers can upload scoped legacy Talent objects" on storage.objects for insert to authenticated
 with check(bucket_id='soro-private-documents' and private.can_upload_legacy_talent_object(name));

create function public.document_center_workspace(p_actor_user_id uuid,p_query jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users%rowtype;v text:=coalesce(p_query->>'view','mine');q text:=coalesce(p_query->>'q','');s text:=coalesce(p_query->>'status','');
 off integer:=coalesce((p_query->>'offset')::integer,0);foff integer:=coalesce((p_query->>'filesOffset')::integer,0);result jsonb;files jsonb;
begin
 a:=private.dc_actor(p_actor_user_id);
 if v not in ('mine','team','library','captured') or off<0 or off>1000000 or foff<0 or foff>1000000 or char_length(q)>100 then raise exception 'Invalid document filters' using errcode='22023';end if;
 if v='captured' and a.role<>'admin' then raise exception 'Not permitted' using errcode='42501';end if;
 if a.role in ('client_admin','client_reviewer','client_billing','virtual_assistant') and v<>'mine' then raise exception 'Not permitted' using errcode='42501';end if;
 with scoped as(select r.* from public.dc_requests r where private.dc_request_access(a,r)
 and (case when v='mine' then r.recipient_id=a.id else private.dc_team_access(a,r) end)
 and(s='' or r.status=s) and(q='' or r.title ilike '%'||q||'%' or private.dc_subject_name(r.subject_kind,r.subject_id) ilike '%'||q||'%')
 and(not p_query?'subjectId' or(r.subject_id=(p_query->>'subjectId')::uuid and r.subject_kind=p_query->>'subjectKind'))),
 page as(select * from scoped order by updated_at desc,id limit 30 offset off)
 select jsonb_build_object('internal',a.role in ('admin','talent_management','sales','sales_management','billing'),'canManageTemplates',a.role='admin',
 'requests',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'title',r.title,'team',r.team,'subjectName',private.dc_subject_name(r.subject_kind,r.subject_id),'recipientName',(select display_name from public.platform_users where id=r.recipient_id),'dueDate',r.due_date,'status',r.status,'itemCount',(select count(*) from public.dc_items where request_id=r.id),'completedCount',(select count(*) from public.dc_items where request_id=r.id and status='accepted')) order by r.updated_at desc,r.id) from page r),'[]'::jsonb),
 'total',(select count(*) from scoped),'hasMore',(select count(*)>off+30 from scoped)) into result;
 select result||jsonb_build_object('templates',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'title',t.title,'team',t.team,'audience',t.audience,'category',t.category,'kind',t.kind,'fileId',t.file_id) order by t.title) from public.dc_templates t where t.active and private.dc_library_access(a,t)),'[]'::jsonb),
 'packets',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'title',p.title,'description',p.description,'team',p.team,'audience',p.audience,'templateIds',p.template_ids) order by p.title) from public.dc_packets p where p.organization_id=a.organization_id and p.active
 and not exists(select 1 from unnest(p.template_ids) tid left join public.dc_templates t on t.id=tid where t.id is null or not t.active or not private.dc_library_access(a,t))),'[]'::jsonb)) into result;
 -- Existing submissions stay in their original bucket and retain their category.
 with all_files as(
 select d.id,d.file_name as name,coalesce(m.category,d.document_type) as category,d.created_at,'legacy'::text as origin,
 coalesce(private.dc_subject_name(case when d.applicant_id is not null then 'talent' else m.subject_kind end,coalesce(d.applicant_id,m.subject_id)),'Needs classification') as subject_name,
 case when d.applicant_id is not null then 'talent' else m.subject_kind end as subject_kind,coalesce(d.applicant_id,m.subject_id) as subject_id,
 d.storage_path is not null as can_open, v='captured' as can_classify,coalesce(m.recipient_active,false) as reviewed_share
 from public.documents d left join public.dc_legacy_links m on m.document_id=d.id and m.organization_id=d.organization_id
 where private.dc_legacy_access(a,d) and (v='captured' or d.document_type not in ('headshot','profile_photo'))
 and(v='captured' or m.recipient_id=a.id or exists(select 1 from public.applicants x where x.id=d.applicant_id and x.auth_user_id=a.id and x.organization_id=a.organization_id) or p_query?'subjectId')
 union all
 select f.id,f.name,t.category,f.created_at,'center',private.dc_subject_name(r.subject_kind,r.subject_id),r.subject_kind,r.subject_id,true,false,false
 from public.dc_submissions sub join public.dc_files f on f.id=sub.file_id and f.item_id=sub.item_id join public.dc_items i on i.id=sub.item_id
 join public.dc_templates t on t.id=i.template_id join public.dc_requests r on r.id=i.request_id
 where v<>'captured' and f.state='ready' and f.organization_id=r.organization_id and private.dc_item_access(a,r,t) and (r.recipient_id=a.id or(p_query?'subjectId' and r.subject_id=(p_query->>'subjectId')::uuid and r.subject_kind=p_query->>'subjectKind'))
 ), filtered as(select * from all_files where(q='' or name ilike '%'||q||'%') and(not p_query?'subjectId' or (subject_id=(p_query->>'subjectId')::uuid and subject_kind=p_query->>'subjectKind'))),
 page as(select * from filtered order by created_at desc,id limit 50 offset foff)
 select jsonb_build_object('files',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'category',category,'createdAt',created_at,'origin',origin,'subjectName',subject_name,'canOpen',can_open,'canClassify',can_classify,'reviewedShare',reviewed_share) order by created_at desc,id) from page),'[]'::jsonb),'filesHasMore',(select count(*)>foff+50 from filtered)) into files;
 return result||case when v in ('mine','captured') or p_query?'subjectId' then files else jsonb_build_object('files','[]'::jsonb) end;
end $$;

create function public.document_center_detail(p_actor_user_id uuid,p_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users%rowtype;r public.dc_requests%rowtype;begin
 a:=private.dc_actor(p_actor_user_id);select * into r from public.dc_requests where id=p_id;
 if not found or not private.dc_request_access(a,r) then raise exception 'Not permitted' using errcode='42501';end if;
 return jsonb_build_object('id',r.id,'title',r.title,'team',r.team,'subjectName',private.dc_subject_name(r.subject_kind,r.subject_id),'recipientName',(select display_name from public.platform_users where id=r.recipient_id),'dueDate',r.due_date,'status',r.status,'version',r.version,
 'canSubmit',a.id=r.recipient_id and r.status not in ('cancelled','complete'),
 'canReview',a.id<>r.recipient_id and private.dc_team_access(a,r) and r.status not in ('cancelled','complete'),
 'canReadAnswers',true,'canCancel',a.id<>r.recipient_id and private.dc_team_access(a,r) and a.role<>'billing' and r.status not in ('complete','cancelled'),
 'items',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'title',t.title,'kind',t.kind,'category',t.category,'status',i.status,'instructions',t.instructions,'fields',t.fields,
 'restricted',not private.dc_item_access(a,r,t),'sourceFileId',t.file_id,
 'latestFileId',case when private.dc_item_access(a,r,t) then sub.file_id end,
 'answers',case when private.dc_item_access(a,r,t) then coalesce(sub.answers,'{}'::jsonb) else '{}'::jsonb end,
 'canReview',a.id<>r.recipient_id and private.dc_item_access(a,r,t) and i.status='submitted' and r.status not in ('cancelled','complete') and private.dc_subject_valid(a,r.subject_kind,r.subject_id,r.recipient_id),
 'correction',case when private.dc_item_access(a,r,t) then i.correction else '' end,
 'versions',case when private.dc_item_access(a,r,t) then coalesce((select jsonb_agg(jsonb_build_object('version',ss.version,'createdAt',ss.created_at,'fileId',ss.file_id) order by ss.version desc) from public.dc_submissions ss where ss.item_id=i.id),'[]'::jsonb) else '[]'::jsonb end) order by i.position)
 from public.dc_items i join public.dc_templates t on t.id=i.template_id left join public.dc_submissions sub on sub.id=i.latest_submission_id and sub.item_id=i.id where i.request_id=r.id and(a.id=r.recipient_id or a.role<>'billing' or t.category='tax')),'[]'::jsonb),
 'activity',coalesce((select jsonb_agg(jsonb_build_object('action',e.action,'actorName',(select display_name from public.platform_users where id=e.actor_id),'createdAt',e.created_at,'note',case when e.item_id is null or private.dc_item_access(a,r,t) then e.note else '' end) order by e.seq desc)
 from public.dc_events e left join public.dc_items i on i.id=e.item_id and i.request_id=e.request_id left join public.dc_templates t on t.id=i.template_id where e.request_id=r.id),'[]'::jsonb));
end $$;

create function public.document_center_recipients(p_actor_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users%rowtype;begin
 a:=private.dc_actor(p_actor_user_id);
 return jsonb_build_object('recipients',coalesce((select jsonb_agg(x order by x->>'name') from(
 select jsonb_build_object('kind','talent','subjectId',x.id,'userId',x.auth_user_id,'name',x.full_name) x from public.applicants x
 where a.role in ('admin','talent_management') and private.dc_subject_valid(a,'talent',x.id,x.auth_user_id)
 union all select jsonb_build_object('kind','employee','subjectId',p.id,'userId',p.id,'name',p.display_name) from public.platform_users p
 where a.role='admin' and private.dc_subject_valid(a,'employee',p.id,p.id)
 union all select jsonb_build_object('kind','client','subjectId',c.id,'userId',m.user_id,'name',c.company_name||' · '||cc.full_name)
 from public.clients c join public.client_portal_memberships m on m.client_id=c.id join public.client_contacts cc on cc.id=m.client_contact_id
 where a.role in ('admin','sales','sales_management') and(a.role<>'sales' or c.sales_owner_id=a.id) and private.dc_subject_valid(a,'client',c.id,m.user_id)
 )s),'[]'::jsonb));
end $$;

create function public.document_center_file(p_actor_user_id uuid,p_id uuid,p_origin text default 'center') returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users%rowtype;f public.dc_files%rowtype;d public.documents%rowtype;r public.dc_requests%rowtype;t public.dc_templates%rowtype;ok boolean:=false;begin
 a:=private.dc_actor(p_actor_user_id);
 if p_origin='legacy' then
 select * into d from public.documents where id=p_id and organization_id=a.organization_id;
 if not found or not private.dc_legacy_access(a,d) then raise exception 'Not permitted' using errcode='42501';end if;
 if exists(select 1 from public.documents other join public.dc_legacy_links m on m.document_id=other.id where other.organization_id=d.organization_id and other.storage_path=d.storage_path and not private.dc_legacy_access(a,other)) then raise exception 'Restricted captured file' using errcode='42501';end if;
 if d.storage_path is null then raise exception 'This legacy link has not been imported into private storage' using errcode='22023';end if;
 insert into public.audit_events(organization_id,actor_user_id,entity_type,entity_id,event_type) values(a.organization_id,a.id,'document',d.id,'secure_link_requested');
 return jsonb_build_object('bucket','soro-private-documents','path',d.storage_path,'name',d.file_name);
 end if;
 select * into f from public.dc_files where id=p_id and organization_id=a.organization_id and state='ready';
 if not found then raise exception 'Not permitted' using errcode='42501';end if;
 if f.purpose='template' then
 select exists(select 1 from public.dc_templates tt where tt.file_id=f.id and private.dc_library_access(a,tt)) or exists(select 1 from public.dc_items i join public.dc_templates tt on tt.id=i.template_id join public.dc_requests rr on rr.id=i.request_id where tt.file_id=f.id and private.dc_request_access(a,rr)) into ok;
 else
 select rr.* into r from public.dc_items i join public.dc_requests rr on rr.id=i.request_id where i.id=f.item_id;
 select tt.* into t from public.dc_items i join public.dc_templates tt on tt.id=i.template_id where i.id=f.item_id;
 ok:=f.organization_id=r.organization_id and private.dc_item_access(a,r,t) and exists(select 1 from public.dc_submissions s where s.file_id=f.id and s.item_id=f.item_id);
 end if;
 if not coalesce(ok,false) then raise exception 'Not permitted' using errcode='42501';end if;
 insert into public.audit_events(organization_id,actor_user_id,entity_type,entity_id,event_type) values(a.organization_id,a.id,'document_center_file',f.id,'secure_link_requested');
 return jsonb_build_object('bucket','soro-document-center','path','organizations/'||f.organization_id||'/files/'||f.id,'name',f.name);
end $$;

-- These RPCs accept a verified actor from the server, never from a browser.
do $$ declare f record;begin
 for f in select p.oid::regprocedure signature,n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where (n.nspname='private' and p.proname like 'dc\_%' escape '\') or (n.nspname='public' and p.proname like 'document_center\_%' escape '\') loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
 if f.nspname='public' then execute format('grant execute on function %s to service_role',f.signature);end if;
 end loop;
end $$;
revoke all on sequence public.dc_events_seq_seq from public,anon,authenticated,service_role;
commit;
