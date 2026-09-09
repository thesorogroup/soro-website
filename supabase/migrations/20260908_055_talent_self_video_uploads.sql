-- Extend the existing own-profile uploader to private introduction videos.
-- Existing documents and objects are preserved. No new direct table/storage grants.
begin;
alter table public.talent_profile_uploads
 drop constraint talent_profile_uploads_kind_check,
 drop constraint talent_profile_uploads_mime_check,
 drop constraint talent_profile_uploads_byte_size_check;
alter table public.talent_profile_uploads
 add constraint talent_profile_uploads_kind_check check(kind in ('profile_photo','resume','introduction_video')),
 add constraint talent_profile_uploads_mime_check check(mime in ('image/jpeg','image/png','application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','video/mp4','video/webm','video/quicktime')),
 add constraint talent_profile_uploads_byte_size_check check(byte_size between 1 and 99614720),
 add constraint talent_profile_uploads_resume_size_check check(kind<>'resume' or byte_size<=10485760),
 add constraint talent_profile_uploads_video_format_check check(kind<>'introduction_video' or mime in ('video/mp4','video/webm','video/quicktime'));

create or replace function public.talent_self_upload(p_actor_user_id uuid,p_body jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users%rowtype;t public.applicants%rowtype;f public.talent_profile_uploads%rowtype;
 action text:=p_body->>'action';object_path text;doc uuid;
begin
 -- Locks keep account/profile revocation from racing the final document insert.
 select * into a from public.platform_users where id=p_actor_user_id and active and not must_change_password and role='virtual_assistant' and organization_id is not null for share;
 if not found then raise exception 'Active Talent access required' using errcode='42501';end if;
 select * into t from public.applicants where auth_user_id=a.id and organization_id=a.organization_id and archived_at is null and portal_access_status='active' for share;
 if not found then raise exception 'Own active Talent profile required' using errcode='42501';end if;
 if p_body is null or jsonb_typeof(p_body)<>'object' or action is null then raise exception 'Invalid upload' using errcode='22023';end if;
 if action='prepare' then
  if p_body-array['action','requestId','kind','name','type','size']<>'{}'::jsonb or not(p_body?&array['requestId','kind','name','type','size']) then raise exception 'Invalid upload fields' using errcode='22023';end if;
  if p_body->>'kind' not in ('profile_photo','resume','introduction_video') or char_length(btrim(p_body->>'name')) not between 1 and 180 or p_body->>'name' ~ '[\\/[:cntrl:]]' or jsonb_typeof(p_body->'size')<>'number' or (p_body->>'size')::numeric<>trunc((p_body->>'size')::numeric) then raise exception 'Invalid file' using errcode='22023';end if;
  if not ((p_body->>'type'='image/jpeg' and lower(p_body->>'name')~'\.(jpg|jpeg)$') or (p_body->>'type'='image/png' and lower(p_body->>'name')~'\.png$') or (p_body->>'type'='application/pdf' and lower(p_body->>'name')~'\.pdf$') or (p_body->>'type'='application/vnd.openxmlformats-officedocument.wordprocessingml.document' and lower(p_body->>'name')~'\.docx$') or (p_body->>'type'='video/mp4' and lower(p_body->>'name')~'\.mp4$') or (p_body->>'type'='video/webm' and lower(p_body->>'name')~'\.webm$') or (p_body->>'type'='video/quicktime' and lower(p_body->>'name')~'\.mov$')) then raise exception 'Invalid format' using errcode='22023';end if;
  perform pg_advisory_xact_lock(hashtextextended('talent-self-upload:'||a.id::text,0));
  select * into f from public.talent_profile_uploads where uploader_id=a.id and request_id=(p_body->>'requestId')::uuid for update;
  if found then
   if f.applicant_id<>t.id or f.organization_id<>a.organization_id or f.kind<>p_body->>'kind' or f.name<>btrim(p_body->>'name') or f.mime<>p_body->>'type' or f.byte_size<>(p_body->>'size')::integer then raise exception 'Request changed' using errcode='23505';end if;
  else
   if (select count(*) from public.talent_profile_uploads where uploader_id=a.id and created_at>now()-interval '1 hour')>=15 then raise exception 'Upload limit reached; retry later' using errcode='P0001';end if;
   insert into public.talent_profile_uploads(organization_id,applicant_id,uploader_id,request_id,kind,name,mime,byte_size)
   values(a.organization_id,t.id,a.id,(p_body->>'requestId')::uuid,p_body->>'kind',btrim(p_body->>'name'),p_body->>'type',(p_body->>'size')::integer) returning * into f;
  end if;
 elsif action in ('get','finalize') then
  if p_body-(case when action='get' then array['action','fileId'] else array['action','fileId','sha256','size','type'] end)<>'{}'::jsonb then raise exception 'Invalid upload fields' using errcode='22023';end if;
  select * into f from public.talent_profile_uploads where id=(p_body->>'fileId')::uuid and uploader_id=a.id and applicant_id=t.id and organization_id=a.organization_id for update;
  if not found then raise exception 'Own upload required' using errcode='42501';end if;
 else raise exception 'Invalid action' using errcode='22023';end if;
 object_path:='applicants/'||t.id::text||'/self-service/'||f.id::text||'/'||case f.mime when 'image/jpeg' then 'headshot.jpg' when 'image/png' then 'headshot.png' when 'application/pdf' then 'resume.pdf' when 'video/mp4' then 'introduction.mp4' when 'video/webm' then 'introduction.webm' when 'video/quicktime' then 'introduction.mov' else 'resume.docx' end;
 if f.document_id is null and f.expires_at<=now() then raise exception 'Upload expired' using errcode='22023';end if;
 if action='finalize' then
  if coalesce(p_body->>'sha256','')!~'^[a-f0-9]{64}$' or (p_body->>'size')::integer is distinct from f.byte_size or p_body->>'type' is distinct from f.mime then raise exception 'Verified file mismatch' using errcode='22023';end if;
  if f.document_id is not null then
   if f.sha256<>p_body->>'sha256' then raise exception 'File changed' using errcode='23505';end if;
  else
   insert into public.documents(organization_id,applicant_id,file_name,storage_path,document_type,status)
   values(a.organization_id,t.id,f.name,object_path,f.kind,'uploaded') returning id into doc;
   update public.talent_profile_uploads set document_id=doc,sha256=p_body->>'sha256',completed_at=now() where id=f.id returning * into f;
   insert into public.audit_events(organization_id,actor_user_id,entity_type,entity_id,event_type,after_value)
   values(a.organization_id,a.id,'document',doc,'talent_profile_file_uploaded',jsonb_build_object('document_type',f.kind,'applicant_id',t.id));
  end if;
 end if;
 return jsonb_build_object('fileId',f.id,'bucket','soro-private-documents','path',object_path,'size',f.byte_size,'type',f.mime,'kind',f.kind,'documentId',f.document_id);
end $$;
revoke all on function public.talent_self_upload(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.talent_self_upload(uuid,jsonb) to service_role;
commit;
