-- Recorded work time and deliberate, private screenshot sharing. No background capture.
begin;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('soro-work-evidence','soro-work-evidence',false,3145728,array['image/png','image/jpeg','image/webp'])
on conflict(id) do update set public=false,file_size_limit=3145728,allowed_mime_types=excluded.allowed_mime_types;
create policy work_evidence_no_direct_access on storage.objects as restrictive for all to anon,authenticated
using(bucket_id<>'soro-work-evidence') with check(bucket_id<>'soro-work-evidence');

create table public.work_screenshot_requests(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references organizations(id),
 placement_id uuid not null references placements(id),work_date date not null,note text not null default '' check(char_length(note)<=500),
 requested_by uuid not null references platform_users(id),request_id uuid not null,
 status text not null default 'requested' check(status in('requested','shared','cancelled')),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(requested_by,request_id)
);
create unique index work_screenshot_one_request_per_day on public.work_screenshot_requests(placement_id,work_date) where status='requested';
create table public.work_screenshots(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references organizations(id),
 placement_id uuid not null references placements(id),applicant_id uuid not null references applicants(id),
 session_id uuid not null references talent_attendance_sessions(id),uploaded_by uuid not null references platform_users(id),
 request_id uuid not null,note text not null default '' check(char_length(note)<=500),
 sha256 text not null check(sha256~'^[0-9a-f]{64}$'),content_type text not null check(content_type in('image/png','image/jpeg','image/webp')),
 byte_size integer not null check(byte_size between 1 and 3145728),storage_path text not null unique,
 state text not null default 'pending' check(state in('pending','shared','withdrawn')),
 created_at timestamptz not null default now(),shared_at timestamptz,withdrawn_at timestamptz,
 unique(uploaded_by,request_id)
);
create index work_screenshots_session_idx on public.work_screenshots(session_id,shared_at desc);
create table public.work_log_events(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references organizations(id),
 placement_id uuid not null references placements(id),actor_user_id uuid references platform_users(id),
 action text not null check(action in('screenshot_requested','screenshot_request_cancelled','screenshot_shared','screenshot_withdrawn')),
 source_id uuid not null,created_at timestamptz not null default now(),unique(action,source_id)
);
alter table public.work_screenshot_requests enable row level security;
alter table public.work_screenshots enable row level security;
alter table public.work_log_events enable row level security;
revoke all on public.work_screenshot_requests,public.work_screenshots,public.work_log_events from public,anon,authenticated;
grant select on public.work_screenshot_requests,public.work_screenshots,public.work_log_events to service_role;

create function private.work_log_actor(p_user uuid) returns public.platform_users
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users; n integer;
begin
 select * into a from private.active_support_actor(p_user);
 if a.role not in('admin','talent_management','client_admin','client_reviewer','virtual_assistant') then raise exception using errcode='42501',message='Work log access is unavailable.';end if;
 if a.role='virtual_assistant' then
  select count(*) into n from applicants t where t.auth_user_id=a.id and t.organization_id=a.organization_id and t.portal_access_status='active' and t.archived_at is null;
  if n<>1 then raise exception using errcode='42501',message='One active Talent profile is required.';end if;
 end if;
 if a.role in('client_admin','client_reviewer') then
  select count(*) into n from client_portal_memberships m join clients c on c.id=m.client_id and c.organization_id=m.organization_id
  join client_contacts cc on cc.id=m.client_contact_id and cc.client_id=c.id and cc.organization_id=c.organization_id
  where m.user_id=a.id and m.organization_id=a.organization_id and m.active and cc.active and c.archived_at is null;
  if n<>1 then raise exception using errcode='42501',message='One active Client membership is required.';end if;
 end if;
 return a;
end $$;
create function private.work_log_can_read(a public.platform_users,p public.placements) returns boolean
language sql stable security definer set search_path=pg_catalog,public,private as $$
 select p.organization_id=a.organization_id and exists(
  select 1 from applicants t join clients c on c.id=p.client_id and c.organization_id=t.organization_id
  where t.id=p.applicant_id and t.organization_id=a.organization_id
   and (a.role='admin' or (t.archived_at is null and c.archived_at is null))
   and (a.role in('admin','talent_management') or (a.role='virtual_assistant' and t.auth_user_id=a.id and t.portal_access_status='active')
    or (a.role in('client_admin','client_reviewer') and exists(select 1 from client_portal_memberships m
       join client_contacts cc on cc.id=m.client_contact_id and cc.organization_id=m.organization_id and cc.client_id=m.client_id and cc.active
       where m.user_id=a.id and m.organization_id=a.organization_id and m.client_id=p.client_id and m.active)))
   and (lower(replace(coalesce(p.status,''),' ','_')) in('placement_confirmed','matched','onboarding','active','live','working','placed','ended','completed')
     or exists(select 1 from talent_attendance_sessions s where s.placement_id=p.id and s.applicant_id=t.id and s.organization_id=a.organization_id))
 );
$$;
create function private.work_log_today(p public.placements) returns date
language sql stable security definer set search_path=pg_catalog,public as $$
 select (statement_timestamp() at time zone coalesce((select z.name from applicants t join pg_catalog.pg_timezone_names z on z.name=nullif(btrim(t.timezone),'') where t.id=p.applicant_id),'Asia/Manila'))::date;
$$;
create function private.work_log_current(p public.placements) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
 select lower(replace(coalesce(p.status,''),' ','_')) in('placement_confirmed','matched','onboarding','active','live','working','placed')
  and p.start_date is not null and p.start_date <= private.work_log_today(p)
  and (p.end_date is null or p.end_date >= private.work_log_today(p))
  and exists(select 1 from applicants t join clients c on c.id=p.client_id and c.organization_id=t.organization_id
    where t.id=p.applicant_id and t.organization_id=p.organization_id and t.archived_at is null and c.archived_at is null);
$$;

create function public.get_work_log(p_actor_user_id uuid,p_filters jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users; f date; t date; off integer; pid uuid; result jsonb;
begin
 a:=private.work_log_actor(p_actor_user_id);
 if jsonb_typeof(p_filters)<>'object' or exists(select 1 from jsonb_object_keys(p_filters) k where k not in('placementId','from','to','offset')) then raise exception using errcode='22023',message='Invalid work log filter.';end if;
 f:=coalesce(nullif(p_filters->>'from','')::date,(statement_timestamp() at time zone 'Asia/Manila')::date-30);
 t:=coalesce(nullif(p_filters->>'to','')::date,(statement_timestamp() at time zone 'Asia/Manila')::date);
 off:=coalesce(nullif(p_filters->>'offset','')::integer,0);pid:=nullif(p_filters->>'placementId','')::uuid;
 if f>t or t-f>366 or off<0 or off>100000 then raise exception using errcode='22023',message='Choose a date range of up to one year.';end if;
 if pid is not null and not exists(select 1 from placements p where p.id=pid and private.work_log_can_read(a,p)) then raise exception using errcode='42501',message='Placement unavailable.';end if;
 with allowed as materialized(select p.* from placements p where private.work_log_can_read(a,p)),
 filtered as materialized(select s.* from talent_attendance_sessions s join allowed p on p.id=s.placement_id and p.applicant_id=s.applicant_id and p.organization_id=s.organization_id
  where (pid is null or p.id=pid) and s.work_date between f and t),
 page as materialized(select * from filtered order by work_date desc,started_at desc,id desc limit 30 offset off),
 requests as(select r.*,coalesce(nullif(tl.timezone,''),'Asia/Manila') timezone from work_screenshot_requests r
  join allowed p on p.id=r.placement_id and p.organization_id=r.organization_id join applicants tl on tl.id=p.applicant_id
  where (pid is null or p.id=pid) and r.work_date between f and t and r.status='requested' order by r.created_at desc,r.id limit 100)
 select jsonb_build_object('viewerRole',a.role,'generatedAt',statement_timestamp(),'from',f,'to',t,'offset',off,'total',(select count(*) from filtered),
 'placements',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'talentName',coalesce(nullif(tl.preferred_name,''),tl.full_name),'clientName',c.company_name,'status',p.status,
   'canRequest',a.role='client_admin' and private.work_log_current(p),'canShare',a.role='virtual_assistant' and private.work_log_current(p)) order by tl.full_name,p.id)
   from allowed p join applicants tl on tl.id=p.applicant_id join clients c on c.id=p.client_id),'[]'::jsonb),
 'sessions',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'placementId',s.placement_id,'workDate',s.work_date,'timezone',s.work_timezone,'startedAt',s.started_at,'checkedOutAt',s.checked_out_at,'corrected',s.corrected_at is not null) order by s.work_date desc,s.started_at desc,s.id desc) from page s),'[]'::jsonb),
 'requests',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'placementId',r.placement_id,'workDate',r.work_date,'timezone',r.timezone,'status',r.status,'note',r.note,'createdAt',r.created_at)) from requests r),'[]'::jsonb),
 'images',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'sessionId',i.session_id,'placementId',i.placement_id,'note',i.note,'sharedAt',i.shared_at) order by i.shared_at desc,i.id)
  from work_screenshots i join page s on s.id=i.session_id and s.placement_id=i.placement_id and s.applicant_id=i.applicant_id and s.organization_id=i.organization_id where i.state='shared'),'[]'::jsonb)) into result;
 return result;
end $$;

create function public.change_work_log(p_actor_user_id uuid,p_action text,p_body jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users;p public.placements;target public.placements;s public.talent_attendance_sessions;i public.work_screenshots;r public.work_screenshot_requests;
 rid uuid;note_value text;work_day date;event_name text;extension text; n integer;
begin
 a:=private.work_log_actor(p_actor_user_id);
 perform pg_advisory_xact_lock(hashtextextended('work-log:'||a.id::text,0));
 if p_body is null or jsonb_typeof(p_body)<>'object' or p_action is null or p_action not in('request','cancel','reserve','finalize','withdraw') then raise exception using errcode='22023',message='Invalid work log action.';end if;
 if (select array_agg(k order by k) from jsonb_object_keys(p_body) k) is distinct from
   (select array_agg(k order by k) from unnest(case p_action when 'request' then array['requestId','placementId','workDate','note'] when 'reserve' then array['requestId','sessionId','note','sha256','type','size'] else array['requestId','id'] end) k)
 then raise exception using errcode='22023',message='Unexpected work log fields.';end if;
 select * into target from placements where id=case p_action
  when 'request' then (p_body->>'placementId')::uuid
  when 'cancel' then (select placement_id from work_screenshot_requests where id=(p_body->>'id')::uuid)
  when 'reserve' then (select placement_id from talent_attendance_sessions where id=(p_body->>'sessionId')::uuid)
  else (select placement_id from work_screenshots where id=(p_body->>'id')::uuid) end;
 if target.id is null or not private.work_log_can_read(a,target) then raise exception using errcode='42501',message='Placement unavailable.';end if;
 -- Every mutation locks in the same order: actor, membership/contact, Client,
 -- Talent, placement, then request/image. Client request and Talent upload do
 -- not take opposite Client/Talent lock orders. Revalidate after any wait.
 perform 1 from platform_users where id=p_actor_user_id for share;
 perform 1 from client_portal_memberships where user_id=p_actor_user_id order by client_id for share;
 perform 1 from client_contacts cc where cc.id in(select client_contact_id from client_portal_memberships where user_id=p_actor_user_id) order by cc.id for share;
 perform 1 from clients c where c.id=target.client_id or c.id in(select client_id from client_portal_memberships where user_id=p_actor_user_id) order by c.id for share;
 perform 1 from applicants where id=target.applicant_id or auth_user_id=p_actor_user_id order by id for share;
 select * into p from placements where id=target.id for update;
 if p.client_id is distinct from target.client_id or p.applicant_id is distinct from target.applicant_id or p.organization_id is distinct from target.organization_id then raise exception using errcode='40001',message='Placement changed. Refresh before trying again.';end if;
 a:=private.work_log_actor(p_actor_user_id);
 rid:=nullif(p_body->>'requestId','')::uuid;note_value:=btrim(coalesce(p_body->>'note',''));
 if rid is null or char_length(note_value)>500 or note_value~'[\x01-\x08\x0b\x0c\x0e-\x1f]' then raise exception using errcode='22023',message='Invalid work log details.';end if;
 if p_action='request' then
  if a.role<>'client_admin' then raise exception using errcode='42501',message='Only a Client administrator can request screenshots.';end if;
  select * into p from placements where id=(p_body->>'placementId')::uuid for update;
  perform 1 from applicants where id=p.applicant_id for share;
  if p.id is null or not private.work_log_can_read(a,p) or not private.work_log_current(p) then raise exception using errcode='42501',message='An active matched placement is required.';end if;
  work_day:=(p_body->>'workDate')::date;
  if work_day is null or work_day<p.start_date or work_day>private.work_log_today(p) or work_day<private.work_log_today(p)-366 then raise exception using errcode='22023',message='Choose a work date during this placement, up to today.';end if;
  select * into r from work_screenshot_requests where requested_by=a.id and request_id=rid;
  if r.id is not null then
   if r.placement_id<>p.id or r.work_date<>work_day or r.note<>note_value then raise exception using errcode='23505',message='Request changed.';end if;
   return jsonb_build_object('id',r.id,'status',r.status);
  end if;
  if (select count(*) from work_screenshot_requests where requested_by=a.id and created_at>now()-interval '1 day')>=30 then raise exception using errcode='P0001',message='Daily request limit reached.';end if;
  insert into work_screenshot_requests(organization_id,placement_id,work_date,note,requested_by,request_id) values(a.organization_id,p.id,work_day,note_value,a.id,rid) returning * into r;
  insert into work_log_events(organization_id,placement_id,actor_user_id,action,source_id)values(a.organization_id,p.id,a.id,'screenshot_requested',r.id);
  return jsonb_build_object('id',r.id,'status',r.status);
 elsif p_action='cancel' then
  select * into r from work_screenshot_requests where id=(p_body->>'id')::uuid for update;
  select * into p from placements where id=r.placement_id;
  if r.id is null or r.organization_id<>a.organization_id or a.role<>'client_admin' or not private.work_log_can_read(a,p) then raise exception using errcode='42501',message='Request unavailable.';end if;
  if r.status='requested' then
   update work_screenshot_requests set status='cancelled',updated_at=now() where id=r.id;
   insert into work_log_events(organization_id,placement_id,actor_user_id,action,source_id)values(a.organization_id,p.id,a.id,'screenshot_request_cancelled',r.id) on conflict do nothing;
  end if;
  return jsonb_build_object('id',r.id);
 elsif p_action='reserve' then
  if a.role<>'virtual_assistant' then raise exception using errcode='42501',message='Only Talent can share their own screenshot.';end if;
  select * into s from talent_attendance_sessions where id=(p_body->>'sessionId')::uuid;
  select * into p from placements where id=s.placement_id for update;
  perform 1 from clients where id=p.client_id for share;
  if s.id is null or s.organization_id<>a.organization_id or s.applicant_id<>p.applicant_id or not private.work_log_can_read(a,p) or not private.work_log_current(p) then raise exception using errcode='42501',message='An active own work session is required.';end if;
  if (p_body->>'sha256') is null or (p_body->>'sha256')!~'^[0-9a-f]{64}$' or coalesce(p_body->>'type','') not in('image/png','image/jpeg','image/webp') or coalesce((p_body->>'size')::integer,0) not between 1 and 3145728 then raise exception using errcode='22023',message='Invalid image.';end if;
  select * into i from work_screenshots where uploaded_by=a.id and request_id=rid for update;
  if i.id is not null then
   if i.session_id<>s.id or i.sha256<>p_body->>'sha256' or i.content_type<>p_body->>'type' or i.byte_size<>(p_body->>'size')::int or i.note<>note_value then raise exception using errcode='23505',message='Upload changed.';end if;
   if i.state='withdrawn' or (i.state='pending' and i.created_at<now()-interval '30 minutes') then raise exception using errcode='22023',message='Upload expired.';end if;
  else
   if (select count(*) from work_screenshots where uploaded_by=a.id and created_at>now()-interval '1 day')>=20
    or (select count(*) from work_screenshots where session_id=s.id and (state='shared' or (state='pending' and created_at>now()-interval '30 minutes')))>=6 then raise exception using errcode='P0001',message='Upload limit reached.';end if;
   extension:=case p_body->>'type' when 'image/png' then '.png' when 'image/jpeg' then '.jpg' else '.webp' end;
   insert into work_screenshots(organization_id,placement_id,applicant_id,session_id,uploaded_by,request_id,note,sha256,content_type,byte_size,storage_path)
   values(a.organization_id,p.id,s.applicant_id,s.id,a.id,rid,note_value,p_body->>'sha256',p_body->>'type',(p_body->>'size')::int,
    a.organization_id::text||'/'||p.id::text||'/'||a.id::text||'/'||rid::text||'/'||(p_body->>'sha256')||extension) returning * into i;
  end if;
  return jsonb_build_object('id',i.id,'path',i.storage_path,'state',i.state);
 else
  select * into i from work_screenshots where id=(p_body->>'id')::uuid for update;
  select * into p from placements where id=i.placement_id for update;
  perform 1 from clients where id=p.client_id for share;
  if i.id is null or i.organization_id<>a.organization_id or a.role<>'virtual_assistant' or i.uploaded_by<>a.id or not private.work_log_can_read(a,p) then raise exception using errcode='42501',message='Image unavailable.';end if;
  if p_action='withdraw' then
   if i.state='shared' then
    update work_screenshots set state='withdrawn',withdrawn_at=now() where id=i.id;
    insert into work_log_events(organization_id,placement_id,actor_user_id,action,source_id)values(a.organization_id,p.id,a.id,'screenshot_withdrawn',i.id) on conflict do nothing;
   end if;
   return jsonb_build_object('id',i.id);
  end if;
  if not private.work_log_current(p) then raise exception using errcode='42501',message='Placement is no longer active.';end if;
  if i.state='shared' then return jsonb_build_object('id',i.id);end if;
  if i.state<>'pending' or i.created_at<now()-interval '30 minutes' then raise exception using errcode='22023',message='Upload expired.';end if;
  if not exists(select 1 from storage.objects o join storage.buckets b on b.id=o.bucket_id and not b.public
    where o.bucket_id='soro-work-evidence' and o.name=i.storage_path and o.metadata->>'mimetype'=i.content_type and o.metadata->>'size'=i.byte_size::text) then raise exception using errcode='22023',message='Uploaded image not found.';end if;
  update work_screenshots set state='shared',shared_at=now() where id=i.id;
  update work_screenshot_requests set status='shared',updated_at=now() where placement_id=p.id and organization_id=a.organization_id and status='requested' and work_date=(select work_date from talent_attendance_sessions where id=i.session_id);
  insert into work_log_events(organization_id,placement_id,actor_user_id,action,source_id)values(a.organization_id,p.id,a.id,'screenshot_shared',i.id) on conflict do nothing;
  return jsonb_build_object('id',i.id);
 end if;
end $$;

create function public.get_work_screenshot(p_actor_user_id uuid,p_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users;i public.work_screenshots;p public.placements;
begin
 a:=private.work_log_actor(p_actor_user_id);select * into i from work_screenshots where id=p_id and state='shared';select * into p from placements where id=i.placement_id;
 if i.id is null or i.organization_id<>a.organization_id or not private.work_log_can_read(a,p) then raise exception using errcode='42501',message='Image unavailable.';end if;
 return jsonb_build_object('path',i.storage_path);
end $$;
revoke all on function private.work_log_actor(uuid),private.work_log_can_read(public.platform_users,public.placements),private.work_log_today(public.placements),private.work_log_current(public.placements) from public,anon,authenticated,service_role;
revoke all on function public.get_work_log(uuid,jsonb),public.change_work_log(uuid,text,jsonb),public.get_work_screenshot(uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_work_log(uuid,jsonb),public.change_work_log(uuid,text,jsonb),public.get_work_screenshot(uuid,uuid) to service_role;
commit;
