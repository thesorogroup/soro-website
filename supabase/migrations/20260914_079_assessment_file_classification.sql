-- Staff may relabel existing assessment evidence, never move or share the file.
begin;

create table private.assessment_classification_requests (
 request_id uuid primary key,
 actor_id uuid not null references public.platform_users(id) on delete cascade,
 organization_id uuid not null references public.organizations(id) on delete cascade,
 applicant_id uuid not null references public.applicants(id) on delete cascade,
 document_id uuid not null references public.documents(id) on delete cascade,
 expected_type text not null,
 expected_updated_at timestamptz not null,
 document_type text not null,
 created_at timestamptz not null default now()
);
alter table private.assessment_classification_requests enable row level security;
revoke all on private.assessment_classification_requests from public,anon,authenticated,service_role;

create function public.classify_talent_assessment(
 p_actor_user_id uuid,p_request_id uuid,p_applicant_id uuid,p_document_id uuid,
 p_expected_type text,p_expected_updated_at timestamptz,p_document_type text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users; d public.documents; previous private.assessment_classification_requests; org uuid;
 allowed text[]:=array['assessment','english_proof','disc_assessment','enneagram_assessment','mbti_assessment'];
begin
 perform private.talent_review_actor(p_actor_user_id);
 select * into a from public.platform_users where id=p_actor_user_id;
 org:=a.organization_id;
 perform pg_advisory_xact_lock(hashtextextended('staff-ownership:'||a.organization_id::text,0));
 select * into a from public.platform_users where id=p_actor_user_id for share;
 perform private.talent_review_actor(p_actor_user_id);
 if a.organization_id is distinct from org then raise exception 'Workspace changed' using errcode='40001';end if;
 if p_request_id is null or p_applicant_id is null or p_document_id is null
   or p_expected_updated_at is null or not isfinite(p_expected_updated_at)
   or p_expected_type is null or not(p_expected_type=any(allowed))
   or p_document_type is null or not(p_document_type=any(allowed)) then
   raise exception 'Invalid assessment classification' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,79));
 -- Match the existing document/deferral trigger lock order.
 perform 1 from public.applicants where id=p_applicant_id and organization_id=a.organization_id
   and archived_at is null for update;
 if not found then raise exception 'Not permitted' using errcode='42501';end if;
 select * into d from public.documents where id=p_document_id and applicant_id=p_applicant_id
   and organization_id=a.organization_id for update;
 if d.id is null or not(d.document_type=any(allowed)) or d.status='rejected'
   or nullif(btrim(d.storage_path),'') is null
   or exists(select 1 from public.dc_legacy_links where document_id=d.id)
   or not private.dc_legacy_access(a,d)
   or exists(select 1 from public.documents other join public.dc_legacy_links m on m.document_id=other.id
     where other.organization_id=d.organization_id and other.storage_path=d.storage_path
       and not private.dc_legacy_access(a,other)) then
   raise exception 'Not permitted' using errcode='42501';
 end if;
 select * into previous from private.assessment_classification_requests where request_id=p_request_id;
 if found then
   if previous.actor_id<>a.id or previous.organization_id<>a.organization_id
     or previous.applicant_id<>p_applicant_id or previous.document_id<>p_document_id
     or previous.expected_type<>p_expected_type or previous.expected_updated_at<>p_expected_updated_at
     or previous.document_type<>p_document_type or d.document_type<>p_document_type then
     raise exception 'Classification request changed' using errcode='40001';
   end if;
 else
   if d.updated_at is distinct from p_expected_updated_at or d.document_type<>p_expected_type then
     raise exception 'This file changed after it was opened' using errcode='40001';
   end if;
   if d.document_type<>p_document_type then
     update public.documents set document_type=p_document_type where id=d.id returning * into d;
     insert into public.audit_events(organization_id,actor_user_id,entity_type,entity_id,event_type,before_value,after_value,note)
     values(a.organization_id,a.id,'document',d.id,'document_classified',
       jsonb_build_object('document_type',p_expected_type),jsonb_build_object('document_type',p_document_type),
       'Assessment type reviewed by staff. File, ownership and sharing unchanged.');
   end if;
   insert into private.assessment_classification_requests(request_id,actor_id,organization_id,applicant_id,document_id,expected_type,expected_updated_at,document_type)
   values(p_request_id,a.id,a.organization_id,p_applicant_id,p_document_id,p_expected_type,p_expected_updated_at,p_document_type);
 end if;
 return jsonb_build_object('documentId',d.id,'applicantId',d.applicant_id,'documentType',d.document_type,'updatedAt',d.updated_at);
end $$;
revoke all on function public.classify_talent_assessment(uuid,uuid,uuid,uuid,text,timestamptz,text) from public,anon,authenticated;
grant execute on function public.classify_talent_assessment(uuid,uuid,uuid,uuid,text,timestamptz,text) to service_role;
commit;
