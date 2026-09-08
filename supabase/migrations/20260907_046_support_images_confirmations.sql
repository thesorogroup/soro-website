-- Private ticket screenshots and a transactionally queued receipt. No email
-- contains user-entered ticket content, profile values, or an attachment URL.
begin;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('soro-support-images','soro-support-images',false,3145728,array['image/png','image/jpeg','image/webp'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
-- Intentionally no authenticated storage policies: only scoped server routes.
alter table public.support_tickets add column request_id uuid,add column request_fingerprint text,
  add column image_storage_path text,add column image_content_type text,add column image_byte_size integer,add column image_sha256 text;
create unique index support_tickets_actor_request_unique on public.support_tickets(requester_user_id,request_id) where request_id is not null;
alter table public.support_tickets add constraint support_request_pair check ((request_id is null and request_fingerprint is null) or (request_id is not null and request_fingerprint is not null and request_fingerprint ~ '^[0-9a-f]{64}$')),
  add constraint support_image_complete check ((image_storage_path is null and image_content_type is null and image_byte_size is null and image_sha256 is null)
  or (request_id is not null and image_storage_path is not null and image_content_type is not null and image_byte_size is not null and image_sha256 is not null and image_content_type in ('image/png','image/jpeg','image/webp') and image_byte_size between 1 and 3145728 and image_sha256 ~ '^[0-9a-f]{64}$'));

create table public.confirmation_outbox (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  recipient_user_id uuid not null, event_type text not null check(event_type in ('support_ticket_created','client_profile_updated')),
  source_id uuid not null,recipient_email text,payload jsonb not null,template_version integer not null default 1 check(template_version=1),
  status text not null default 'pending' check(status in ('pending','sending','sent','manual_review')),
  attempt_count integer not null default 0 check(attempt_count between 0 and 100),next_attempt_at timestamptz not null default now(),
  first_attempt_at timestamptz,request_body text check(request_body is null or octet_length(request_body)<=50000),
  lease_token uuid,lease_expires_at timestamptz,provider_message_id text,sent_at timestamptz,last_error_code text,created_at timestamptz not null default now(),
  unique(event_type,source_id,recipient_user_id),
  foreign key(recipient_user_id,organization_id) references public.platform_users(id,organization_id),
  check(status<>'sending' or (lease_token is not null and lease_expires_at is not null)),
  check(status='manual_review' or recipient_email is not null),
  check((request_body is null)=(first_attempt_at is null)),
  check((event_type='client_profile_updated' and payload='{}'::jsonb) or (event_type='support_ticket_created' and payload ? 'ticketNumber' and payload-'ticketNumber'='{}'::jsonb and jsonb_typeof(payload->'ticketNumber')='string' and payload->>'ticketNumber' ~ '^SUP-[A-F0-9]{8}$'))
);
alter table public.confirmation_outbox enable row level security;
revoke all on public.confirmation_outbox from public,anon,authenticated,service_role;
create index confirmation_outbox_due on public.confirmation_outbox(status,next_attempt_at,created_at) where status in ('pending','sending');

create function private.active_support_actor(p_actor_user_id uuid)
returns public.platform_users language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users%rowtype;
begin
  select * into a from public.platform_users where id=p_actor_user_id and organization_id is not null and active and not must_change_password;
  if not found then raise exception using errcode='42501',message='Active Soro access is required.'; end if;
  if a.role in ('client_admin','client_reviewer','client_billing') and not exists (
    select 1 from public.client_portal_memberships m join public.clients c on c.id=m.client_id and c.organization_id=m.organization_id
    join public.client_contacts cc on cc.id=m.client_contact_id and cc.client_id=c.id and cc.organization_id=m.organization_id
    where m.user_id=a.id and m.organization_id=a.organization_id and m.active and cc.active and c.archived_at is null
  ) then raise exception using errcode='42501',message='Active Client membership is required.'; end if;
  if a.role='virtual_assistant' and not exists(select 1 from public.applicants t where t.auth_user_id=a.id and t.organization_id=a.organization_id and t.archived_at is null and t.portal_access_status='active') then raise exception using errcode='42501',message='Active Talent access is required.'; end if;
  if a.role not in ('admin','sales_management','sales','talent_management','billing','client_admin','client_reviewer','client_billing','virtual_assistant') then raise exception using errcode='42501',message='Support access is required.'; end if;
  return a;
end $$;
revoke all on function private.active_support_actor(uuid) from public,anon,authenticated,service_role;
create function public.authorize_support_image_upload(p_actor_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users%rowtype;
begin select * into a from private.active_support_actor(p_actor_user_id);
  return jsonb_build_object('organizationId',a.organization_id,'requesterUserId',a.id);
end $$;
revoke all on function public.authorize_support_image_upload(uuid) from public,anon,authenticated;
grant execute on function public.authorize_support_image_upload(uuid) to service_role;

create function private.enqueue_confirmation(p_event_type text,p_source_id uuid,p_organization_id uuid,p_recipient_user_id uuid,p_payload jsonb)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_email text; v_id uuid;
begin
  select lower(btrim(u.email)) into v_email from auth.users u join public.platform_users a on a.id=u.id
  where u.id=p_recipient_user_id and a.organization_id=p_organization_id and u.email_confirmed_at is not null;
  if v_email is null or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then v_email:=null; end if;
  insert into public.confirmation_outbox(organization_id,recipient_user_id,event_type,source_id,recipient_email,payload,status,last_error_code)
  values(p_organization_id,p_recipient_user_id,p_event_type,p_source_id,v_email,p_payload,case when v_email is null then 'manual_review' else 'pending' end,case when v_email is null then 'recipient_unavailable' end)
  on conflict(event_type,source_id,recipient_user_id) do nothing returning id into v_id;
  if v_id is null then select id into v_id from public.confirmation_outbox where event_type=p_event_type and source_id=p_source_id and recipient_user_id=p_recipient_user_id and organization_id=p_organization_id; end if;
  return v_id;
end $$;
revoke all on function private.enqueue_confirmation(text,uuid,uuid,uuid,jsonb) from public,anon,authenticated,service_role;

create function public.create_support_ticket(p_actor_user_id uuid,p_request_id uuid,p_subject text,p_area text,p_details text,
  p_image_sha256 text default null,p_image_content_type text default null,p_image_byte_size integer default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users%rowtype; t public.support_tickets%rowtype;
  v_subject text:=nullif(btrim(p_subject),''); v_area text:=nullif(btrim(p_area),''); v_details text:=nullif(btrim(p_details),'');
  v_image boolean:=p_image_sha256 is not null or p_image_content_type is not null or p_image_byte_size is not null;
  v_path text; v_fingerprint text;
begin
  select * into a from private.active_support_actor(p_actor_user_id);
  if p_request_id is null or v_subject is null or char_length(v_subject) not between 3 and 120 or v_details is null or char_length(v_details) not between 5 and 5000 or v_area is null or v_area not in ('Sign-in and account access','Talent profiles and documents','Client records and placements','Tasks and notifications','Other technical issue') then raise exception using errcode='22023',message='Enter valid support ticket details.'; end if;
  if v_image then
    if p_image_sha256 is null or p_image_sha256 !~ '^[0-9a-f]{64}$' or p_image_content_type is null or p_image_content_type not in ('image/png','image/jpeg','image/webp') or p_image_byte_size is null or p_image_byte_size not between 1 and 3145728 then raise exception using errcode='22023',message='Choose a supported screenshot under 3 MB.'; end if;
    v_path:='organizations/'||a.organization_id::text||'/support/'||a.id::text||'/'||p_request_id::text||'/'||p_image_sha256||case p_image_content_type when 'image/png' then '.png' when 'image/jpeg' then '.jpg' else '.webp' end;
  end if;
  v_fingerprint:=encode(extensions.digest(convert_to(jsonb_build_object('actor',a.id,'organization',a.organization_id,'subject',v_subject,'area',v_area,'details',v_details,'imageSha256',p_image_sha256,'imageType',p_image_content_type,'imageSize',p_image_byte_size)::text,'UTF8'),'sha256'),'hex');
  perform pg_advisory_xact_lock(hashtextextended('support-ticket-request:'||a.id::text||':'||p_request_id::text,0));
  select * into t from public.support_tickets where requester_user_id=a.id and request_id=p_request_id for update;
  if found then
    if t.organization_id is distinct from a.organization_id or t.request_fingerprint is distinct from v_fingerprint then raise exception using errcode='23505',message='This ticket request was already used with different details.'; end if;
  else
    if v_image and not exists(select 1 from storage.objects o join storage.buckets b on b.id=o.bucket_id and not b.public where o.bucket_id='soro-support-images' and o.name=v_path and o.metadata->>'mimetype'=p_image_content_type and o.metadata->>'size'=p_image_byte_size::text) then raise exception using errcode='22023',message='The uploaded screenshot could not be verified.'; end if;
    insert into public.support_tickets(organization_id,requester_user_id,subject,area,details,status,request_id,request_fingerprint,image_storage_path,image_content_type,image_byte_size,image_sha256)
    values(a.organization_id,a.id,v_subject,v_area,v_details,'open',p_request_id,v_fingerprint,v_path,p_image_content_type,p_image_byte_size,p_image_sha256) returning * into t;
  end if;
  perform private.enqueue_confirmation('support_ticket_created',t.id,a.organization_id,a.id,jsonb_build_object('ticketNumber',t.ticket_number));
  return jsonb_build_object('ticketId',t.id,'ticketNumber',t.ticket_number,'createdAt',t.created_at,'hasImage',t.image_storage_path is not null);
end $$;
revoke all on function public.create_support_ticket(uuid,uuid,text,text,text,text,text,integer) from public,anon,authenticated;
grant execute on function public.create_support_ticket(uuid,uuid,text,text,text,text,text,integer) to service_role;

create function public.get_support_tickets(p_actor_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users%rowtype; r jsonb; v_internal boolean;
begin
  select * into a from private.active_support_actor(p_actor_user_id);
  v_internal:=a.role in ('admin','sales_management','sales','talent_management','billing');
  select coalesce(jsonb_agg(jsonb_build_object('ticketId',t.id,'ticketNumber',t.ticket_number,'subject',t.subject,'area',t.area,'details',t.details,'status',t.status,'createdAt',t.created_at,'hasImage',t.image_storage_path is not null) order by t.created_at desc,t.id),'[]'::jsonb) into r
  from (select s.* from public.support_tickets s where s.organization_id=a.organization_id and (s.requester_user_id=a.id or v_internal) order by s.created_at desc,s.id limit 100) t;
  return jsonb_build_object('tickets',r,'internal',v_internal);
end $$;
revoke all on function public.get_support_tickets(uuid) from public,anon,authenticated;
grant execute on function public.get_support_tickets(uuid) to service_role;
create function public.get_support_ticket_image(p_actor_user_id uuid,p_ticket_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users%rowtype; t public.support_tickets%rowtype;
begin
  select * into a from private.active_support_actor(p_actor_user_id);
  select * into t from public.support_tickets s where s.id=p_ticket_id and s.organization_id=a.organization_id
  and (s.requester_user_id=a.id or a.role in ('admin','sales_management','sales','talent_management','billing'));
  if not found or t.image_storage_path is null then raise exception using errcode='42501',message='This ticket image is unavailable.'; end if;
  if t.image_storage_path is distinct from ('organizations/'||t.organization_id::text||'/support/'||t.requester_user_id::text||'/'||t.request_id::text||'/'||t.image_sha256||case t.image_content_type when 'image/png' then '.png' when 'image/jpeg' then '.jpg' when 'image/webp' then '.webp' end) then raise exception using errcode='42501',message='This ticket image is unavailable.'; end if;
  return jsonb_build_object('storagePath',t.image_storage_path);
end $$;
revoke all on function public.get_support_ticket_image(uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_support_ticket_image(uuid,uuid) to service_role;

-- Keep existing ticket reading/triage, but close legacy direct inserts and
-- ensure an internal staff member cannot cross an organization boundary.
revoke insert on public.support_tickets from authenticated;
drop policy if exists "active users can read their own support tickets" on public.support_tickets;
drop policy if exists "users can read their own support tickets" on public.support_tickets;
create policy "Users can read their own organization support tickets" on public.support_tickets for select to authenticated
using (requester_user_id=auth.uid() and organization_id=private.current_soro_organization_id() and private.current_soro_role() is not null);
drop policy "Soro internal users can manage support tickets" on public.support_tickets;
create policy "Soro staff can read organization support tickets" on public.support_tickets for select to authenticated
using (organization_id=private.current_soro_organization_id() and private.is_internal_soro_user());
create policy "Soro staff can update organization support tickets" on public.support_tickets for update to authenticated
using (organization_id=private.current_soro_organization_id() and private.is_internal_soro_user())
with check (organization_id=private.current_soro_organization_id() and private.is_internal_soro_user());
create function private.protect_support_ticket_identity() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if row(new.id,new.ticket_number,new.created_at,new.organization_id,new.requester_user_id,new.request_id,new.request_fingerprint,new.image_storage_path,new.image_content_type,new.image_byte_size,new.image_sha256)
    is distinct from row(old.id,old.ticket_number,old.created_at,old.organization_id,old.requester_user_id,old.request_id,old.request_fingerprint,old.image_storage_path,old.image_content_type,old.image_byte_size,old.image_sha256)
  then raise exception using errcode='42501',message='Ticket ownership and attachment cannot change.'; end if;
  return new;
end $$;
create trigger protect_support_ticket_identity before update on public.support_tickets for each row execute function private.protect_support_ticket_identity();

-- Queue actual profile updates in their existing transaction, after its audit.
create function private.queue_client_profile_confirmation() returns trigger language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users%rowtype;
begin
  if new.event_type<>'client_profile_updated' or new.entity_type<>'client_profile' or auth.role() is distinct from 'service_role' then return new; end if;
  select * into a from private.active_support_actor(new.actor_user_id);
  if a.organization_id<>new.organization_id or a.role not in ('client_admin','client_reviewer','client_billing') or not exists(select 1 from public.client_portal_memberships m where m.user_id=a.id and m.organization_id=a.organization_id and m.client_id=new.entity_id and m.active) then return new; end if;
  if jsonb_typeof(new.after_value->'changed_fields') is distinct from 'array' then return new; end if;
  if jsonb_array_length(new.after_value->'changed_fields')=0 then return new; end if;
  if exists(select 1 from jsonb_array_elements_text(new.after_value->'changed_fields') as f(name) where f.name is null or f.name not in ('contact.fullName','contact.phone','company.addressLine1','company.addressLine2','company.city','company.stateRegion','company.postalCode','company.country','company.phone','company.website')) then return new; end if;
  perform private.enqueue_confirmation('client_profile_updated',new.id,a.organization_id,a.id,'{}'::jsonb);
  return new;
end $$;
revoke all on function private.queue_client_profile_confirmation() from public,anon,authenticated,service_role;
create trigger queue_client_profile_confirmation after insert on public.audit_events for each row execute function private.queue_client_profile_confirmation();
commit;
