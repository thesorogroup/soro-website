-- Read-only observation helpers. Actor and subject are separate and checked on every call.
begin;
create function public.founder_portal_private_read(p_actor_user_id uuid,p_subject_user_id uuid,p_resource text,p_params jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare founder public.platform_users%rowtype;a public.platform_users%rowtype;talent public.applicants%rowtype;
 h public.talent_healthcare_profiles%rowtype;d public.documents%rowtype;f public.dc_files%rowtype;
 r public.dc_requests%rowtype;t public.dc_templates%rowtype;ok boolean:=false;result jsonb;
begin
 founder:=private.dc_actor(p_actor_user_id);
 if founder.role<>'admin' or founder.is_founder is not true then raise exception 'Founder required' using errcode='42501';end if;
 a:=private.dc_actor(p_subject_user_id);
 if a.organization_id<>founder.organization_id or a.role not in('client_admin','client_reviewer','client_billing','virtual_assistant') then raise exception 'Subject unavailable' using errcode='42501';end if;
 if a.role='virtual_assistant' then
  if (select count(*) from public.applicants where organization_id=a.organization_id and auth_user_id=a.id and archived_at is null and portal_access_status='active')<>1 then raise exception 'Subject unavailable' using errcode='42501';end if;
  select * into talent from public.applicants where organization_id=a.organization_id and auth_user_id=a.id and archived_at is null and portal_access_status='active';
 else
  if (select count(*) from public.client_portal_memberships m join public.clients c on c.id=m.client_id and c.organization_id=m.organization_id join public.client_contacts cc on cc.id=m.client_contact_id and cc.client_id=c.id and cc.organization_id=c.organization_id where m.user_id=a.id and m.organization_id=a.organization_id and m.active and cc.active and c.archived_at is null)<>1 then raise exception 'Subject unavailable' using errcode='42501';end if;
 end if;
 if p_resource in('healthcare','profile-documents','profile-file') and a.role<>'virtual_assistant' then raise exception 'Talent required' using errcode='42501';end if;
 if p_resource='healthcare' then
  -- Match the self-service projection without writing a viewed event as the Talent.
  select * into h from public.talent_healthcare_profiles where applicant_id=talent.id and organization_id=a.organization_id;
  return jsonb_build_object('canManage',false,'profile',case when h.applicant_id is null then null else h.profile||jsonb_build_object('version',h.version) end,'updatedAt',h.updated_at,'actions','[]'::jsonb,'placements','[]'::jsonb,'events','[]'::jsonb);
 elsif p_resource='profile-documents' then
  select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'applicant_id',x.applicant_id,'file_name',x.file_name,'document_type',x.document_type,'status',x.status,'storage_path',x.storage_path,'external_url',x.external_url,'created_at',x.created_at) order by x.created_at desc,x.id desc),'[]'::jsonb) into result
  from public.documents x where x.organization_id=a.organization_id and x.applicant_id=talent.id and private.dc_legacy_access(a,x)
  and not exists(select 1 from public.documents other join public.dc_legacy_links m on m.document_id=other.id where other.organization_id=x.organization_id and other.storage_path=x.storage_path and not private.dc_legacy_access(a,other));
  return result;
 elsif p_resource='profile-file' then
  select * into d from public.documents x where x.organization_id=a.organization_id and x.applicant_id=talent.id and x.storage_path=p_params->>'path' and private.dc_legacy_access(a,x) order by x.created_at desc limit 1;
  if not found then raise exception 'File unavailable' using errcode='42501';end if;
 elsif p_resource='document-file' and coalesce(p_params->>'origin','center')='legacy' then
  select * into d from public.documents where id=(p_params->>'id')::uuid and organization_id=a.organization_id;
  if not found or not private.dc_legacy_access(a,d) then raise exception 'File unavailable' using errcode='42501';end if;
 elsif p_resource='document-file' and coalesce(p_params->>'origin','center')='center' then
  select * into f from public.dc_files where id=(p_params->>'id')::uuid and organization_id=a.organization_id and state='ready';
  if not found then raise exception 'File unavailable' using errcode='42501';end if;
  if f.purpose='template' then
   select exists(select 1 from public.dc_templates tt where tt.file_id=f.id and private.dc_library_access(a,tt)) or exists(select 1 from public.dc_items i join public.dc_templates tt on tt.id=i.template_id join public.dc_requests rr on rr.id=i.request_id where tt.file_id=f.id and private.dc_request_access(a,rr)) into ok;
  else
   select rr.* into r from public.dc_items i join public.dc_requests rr on rr.id=i.request_id where i.id=f.item_id;
   select tt.* into t from public.dc_items i join public.dc_templates tt on tt.id=i.template_id where i.id=f.item_id;
   ok:=f.organization_id=r.organization_id and private.dc_item_access(a,r,t) and exists(select 1 from public.dc_submissions s where s.file_id=f.id and s.item_id=f.item_id);
  end if;
  if not coalesce(ok,false) then raise exception 'File unavailable' using errcode='42501';end if;
  return jsonb_build_object('bucket','soro-document-center','path','organizations/'||f.organization_id||'/files/'||f.id,'name',f.name);
 else raise exception 'Unsupported observation' using errcode='22023';end if;
 if d.storage_path is null or exists(select 1 from public.documents other join public.dc_legacy_links m on m.document_id=other.id where other.organization_id=d.organization_id and other.storage_path=d.storage_path and not private.dc_legacy_access(a,other)) then raise exception 'Restricted file' using errcode='42501';end if;
 return jsonb_build_object('bucket','soro-private-documents','path',d.storage_path,'name',d.file_name);
end $$;
revoke all on function public.founder_portal_private_read(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.founder_portal_private_read(uuid,uuid,text,jsonb) to service_role;
commit;
