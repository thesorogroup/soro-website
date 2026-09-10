-- Safe read-only projections of retained changes/actions. No seeds or backfill.
begin;
create function private.activity_record(a public.platform_users,k text,s uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare label text;href text;client_id uuid;doc public.documents%rowtype;req public.dc_requests%rowtype;
begin
 if k='all' then if a.role='admin' then return jsonb_build_object('kind','all','id',null,'label','Organization activity','href',null);end if;return null;
 elsif k='talent' then
  select t.full_name,case when a.role='virtual_assistant' then '#talent-my-profile' when t.archived_at is null then '#talent/'||t.id else '#talent-review' end into label,href from public.applicants t where t.id=s and t.organization_id=a.organization_id and(a.role in ('admin','talent_management') or(a.role='virtual_assistant' and t.auth_user_id=a.id and t.portal_access_status='active' and t.archived_at is null and(select count(*) from public.applicants x where x.auth_user_id=a.id and x.organization_id=a.organization_id and x.portal_access_status='active' and x.archived_at is null)=1));
 elsif k='client' then
  select c.company_name,case when a.role in ('client_admin','client_reviewer','client_billing') then '#my-profile' else '#client/'||c.id end into label,href from public.clients c where c.id=s and c.organization_id=a.organization_id and(c.archived_at is null or a.role='admin') and(a.role in ('admin','sales_management','talent_management') or(a.role='sales' and c.sales_owner_id=a.id) or private.dc_subject_valid(a,'client',c.id,a.id));
 elsif k='employee' then
  select u.display_name,'#employees' into label,href from public.platform_users u where u.id=s and u.organization_id=a.organization_id and u.role in ('admin','sales','sales_management','talent_management','billing') and(a.role='admin' or a.id=u.id);if a.role<>'admin' then href:=null;end if;
 elsif k='placement' then
  select c.company_name||' · '||t.full_name,case when a.role in ('admin','sales','sales_management','talent_management','client_admin','client_reviewer') and p.hiring_request_id is not null then '#client-placement/'||p.hiring_request_id when a.role='virtual_assistant' then '#talent-my-profile' end into label,href from public.placements p join public.clients c on c.id=p.client_id and c.organization_id=p.organization_id join public.applicants t on t.id=p.applicant_id and t.organization_id=p.organization_id where p.id=s and p.organization_id=a.organization_id and(a.role in ('admin','talent_management','sales_management') or(a.role='sales' and c.sales_owner_id=a.id and c.archived_at is null) or(a.role in ('client_admin','client_reviewer') and private.dc_subject_valid(a,'client',c.id,a.id)) or(a.role='virtual_assistant' and private.activity_record(a,'talent',t.id) is not null));
 elsif k='document' then
  select * into req from public.dc_requests where id=s and organization_id=a.organization_id;
  if found and private.dc_request_access(a,req) then label:=req.title;href:='#documents?requestId='||req.id;
  else select * into doc from public.documents where id=s and organization_id=a.organization_id;if found and private.dc_legacy_access(a,doc) then label:='Captured document';href:='#documents';end if;end if;
 elsif k='task' then
  select t.title,'#tasks' into label,href from public.tasks t where t.id=s and t.organization_id=a.organization_id and(a.role='admin' or t.assigned_to_user_id=a.id);
 elsif k='support' then
  select 'Ticket '||t.ticket_number,'#help?ticketId='||t.id into label,href from public.support_tickets t where t.id=s and t.organization_id=a.organization_id and private.support_can_read(a.id,t.id);
 end if;
 if label is null then return null;end if;return jsonb_build_object('kind',k,'id',s,'label',label,'href',href);
end $$;

create function private.activity_catalog(t text,e text) returns jsonb
language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_object('action',v.label,'category',v.category,'external',v.external) from (values
 ('applicant','talent_profile_created','Talent profile created','profile',false),
 ('talent_application','application_submitted','Application submission recorded','profile',true),
 ('applicant','talent_identity_updated','Personal profile details updated','profile',true),
 ('applicant','talent_profile_updated','Talent profile updated','profile',false),
 ('applicant','talent_skills_updated','Verified skills updated','profile',false),
 ('applicant','administrator_owner_reassigned','Talent owner changed','ownership',false),
 ('client','administrator_owner_reassigned','Client owner changed','ownership',false),
 ('employee','founder_account_updated','Account details updated','profile',true),
 ('employee','employee_account_provisioning','Employee access requested','access',false),
 ('employee','temporary_password_reissue','Temporary password requested','access',false),
 ('employee','initial_password_change','Account setup completed','access',true),
 ('talent_review_queue','begin_review','Application review started','review',false),
 ('talent_review_queue','request_more_info','More information requested','review',false),
 ('talent_review_queue','mark_bench_ready','Talent marked bench ready','review',false),
 ('talent_review_queue','return_to_review','Talent returned to review','review',false),
 ('talent_review_queue','decline','Application declined','review',false),
 ('talent_review_queue','archive','Talent profile archived','review',false),
 ('talent_review_queue','restore','Talent profile restored','review',false),
 ('talent_review_queue','reopen','Application review reopened','review',false),
 ('talent_attendance','start_day','Workday started','attendance',true),
 ('talent_attendance','check_out','Workday checked out','attendance',true),
 ('talent_time_off','submit','Time off requested','attendance',true),
 ('talent_time_off','approve','Time off approved','attendance',true),
 ('talent_time_off','decline','Time off declined','attendance',true),
 ('talent_time_off','cancel','Time off cancelled','attendance',true),
 ('task','task_created','Task created','tasks',false),
 ('task','task_completed','Task completed','tasks',false),
 ('task','task_reopened','Task reopened','tasks',false),
 ('document','talent_profile_file_uploaded','Profile file uploaded','files',true),
 ('document','staff_document_uploaded','Profile file attached','files',true),
 ('document','document_classified','Document classification updated','files',false),
 ('document','reviewed_document_share_removed','Document sharing removed','files',false),
 ('client_profile','client_profile_updated','Client account details updated','profile',true),
 ('client','client_created','Client created','workflow',false),
 ('client','client_pipeline_update_client','Client details updated','profile',false),
 ('client','client_pipeline_set_client_stage','Client stage updated','workflow',false),
 ('client','client_pipeline_archive_client','Client archived','workflow',false),
 ('client','client_pipeline_assign_owner','Sales owner updated','ownership',false),
 ('client_contact','client_pipeline_create_contact','Client contact added','profile',false),
 ('client_contact','client_pipeline_update_contact','Client contact updated','profile',false),
 ('client_contact','client_pipeline_deactivate_contact','Client contact deactivated','access',false),
 ('client_contact','client_pipeline_reactivate_contact','Client contact reactivated','access',false),
 ('hiring_request','client_pipeline_create_request','Hiring request created','workflow',false),
 ('hiring_request','client_pipeline_update_request','Hiring request updated','workflow',false),
 ('hiring_request','client_pipeline_set_request_status','Hiring request status updated','workflow',false),
 ('client_shortlist','client_shortlist_created','Shortlist created','workflow',false),
 ('client_shortlist','client_shortlist_owner_rebased','Shortlist owner updated','ownership',false),
 ('client_shortlist','client_shortlist_sent','Shortlist sent for review','workflow',false),
 ('client_shortlist_item','client_shortlist_candidate_added','Candidate added to shortlist','workflow',false),
 ('client_shortlist_item','client_shortlist_candidate_removed','Candidate removed from shortlist','workflow',false),
 ('client_shortlist_item','client_shortlist_response_recorded','Client response recorded','workflow',false),
 ('client_candidate_interview','client_placement_schedule_interview','Client interview scheduled','workflow',false),
 ('client_candidate_interview','client_placement_reschedule_interview','Client interview rescheduled','workflow',false),
 ('client_candidate_interview','client_placement_cancel_interview','Client interview cancelled','workflow',false),
 ('client_candidate_interview','client_placement_record_interview_outcome','Client interview outcome recorded','workflow',false),
 ('client_candidate_interview','client_placement_retry_calendar_sync','Calendar sync retry requested','workflow',false),
 ('client_candidate_interview','client_interview_calendar_sync_result','Calendar sync result recorded','workflow',false),
 ('client_candidate_decision','client_placement_final_decision','Client decision recorded','workflow',false),
 ('client_candidate_decision','client_placement_prepare_handoff','Placement handoff prepared','workflow',false),
 ('client_placement_handoff','client_placement_confirm_placement','Placement confirmed','workflow',false),
 ('placement_onboarding_item','client_placement_update_onboarding','Onboarding step updated','workflow',false),
 ('placement','client_placement_activate_placement','Placement activated','workflow',true),
 ('client_portal_access','client_portal_access_activate','Client invitation requested','access',false),
 ('client_portal_access','client_portal_access_resend_invitation','Client invitation requested again','access',false),
 ('client_portal_access','client_portal_access_change_email','Client sign-in email change requested','access',false),
 ('client_portal_access','client_portal_access_send_password_reset','Client password reset requested','access',false),
 ('client_portal_access','client_portal_access_suspend_access','Client access suspension requested','access',false),
 ('client_portal_access','client_portal_access_reactivate_access','Client access reactivation requested','access',false),
 ('client_portal_access','client_portal_setup_completed','Client account setup recorded','access',true),
 ('client_portal_access','client_portal_password_recovery_completed','Client password recovery recorded','access',true),
 ('talent_portal_access','talent_portal_access_invited','Talent invitation requested','access',false),
 ('talent_portal_access','talent_portal_invitation_resent','Talent invitation requested again','access',false),
 ('talent_portal_access','talent_portal_login_email_changed','Talent sign-in email change requested','access',false),
 ('talent_portal_access','talent_portal_password_reset_sent','Talent password reset requested','access',false),
 ('talent_portal_access','talent_portal_access_suspended','Talent access suspension requested','access',false),
 ('talent_portal_access','talent_portal_access_reactivated','Talent access reactivation requested','access',false),
 ('talent_portal_access','talent_portal_setup_completed','Talent account setup recorded','access',true),
 ('talent_portal_access','talent_portal_password_recovery_completed','Talent password recovery recorded','access',true),
 ('talent_verification','schedule_interview','Talent interview scheduled','review',false),
 ('talent_verification','reschedule_interview','Talent interview rescheduled','review',false),
 ('talent_verification','cancel_interview','Talent interview cancelled','review',false),
 ('talent_verification','record_interview_outcome','Talent interview outcome recorded','review',false),
 ('talent_verification','retry_calendar_sync','Talent calendar retry requested','review',false),
 ('talent_verification','save_reference','Employment reference updated','review',false),
 ('talent_verification','record_reference_attempt','Reference contact attempt recorded','review',false),
 ('talent_verification','set_reference_outcome','Reference verification outcome recorded','review',false),
 ('talent_verification','remove_reference','Employment reference removed','review',false),
 ('talent_verification','calendar_sync_result','Talent calendar result recorded','review',false),
 ('available_talent_bench','claim','Talent claimed for matching','ownership',false),
 ('available_talent_bench','assign','Talent assigned for matching','ownership',false),
 ('available_talent_bench','reassign','Talent matching assignment changed','ownership',false),
 ('available_talent_bench','release','Talent released to available bench','ownership',false),
 ('employee','employee_business_contact_updated','Work contact details updated','profile',true),
 ('employee','duplicate_employee_retired','Duplicate employee account retired','access',false)
 ) v(entity,event,label,category,external) where v.entity=t and v.event=e;
$$;

create function private.activity_project(a public.platform_users,e public.audit_events) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare spec jsonb;rec jsonb;k text;s uuid;related jsonb:='[]';changes jsonb:='[]';actor_label text;old_status text;new_status text;f text;field_label text;owner_before text;owner_after text;talent_id uuid;placement_id uuid;
begin
 if e.organization_id<>a.organization_id then return null;end if;
 spec:=private.activity_catalog(e.entity_type,e.event_type);if spec is null then return null;end if;
 if a.role in ('virtual_assistant','client_admin','client_reviewer','client_billing') and not (spec->>'external')::boolean then return null;end if;
 k:=case when e.entity_type in ('applicant','talent_application','talent_review_queue','talent_verification','talent_attendance','talent_portal_access','available_talent_bench') then 'talent' when e.entity_type in ('client','client_profile') then 'client' when e.entity_type in ('employee','document','task','placement') then e.entity_type end;s:=e.entity_id;
 if e.entity_type='talent_time_off' then k:='talent';select t.applicant_id into s from public.talent_time_off_requests t where t.id=e.entity_id and t.organization_id=e.organization_id;
 elsif e.entity_type in ('client_contact','client_portal_access') then k:='client';select c.client_id into s from public.client_contacts c where c.id=e.entity_id and c.organization_id=e.organization_id;
 elsif e.entity_type='hiring_request' then k:='client';select h.client_id into s from public.hiring_requests h where h.id=e.entity_id and h.organization_id=e.organization_id;
 elsif e.entity_type='client_shortlist' then k:='client';select h.client_id into s from public.client_shortlists h where h.id=e.entity_id and h.organization_id=e.organization_id;
 elsif e.entity_type='client_shortlist_item' then k:='client';select h.client_id,i.applicant_id into s,talent_id from public.client_shortlist_items i join public.client_shortlists h on h.id=i.shortlist_id and h.organization_id=i.organization_id where i.id=e.entity_id and i.organization_id=e.organization_id;
 elsif e.entity_type='client_candidate_interview' then k:='client';select i.client_id,i.applicant_id into s,talent_id from public.client_candidate_interviews i where i.id=e.entity_id and i.organization_id=e.organization_id;
 elsif e.entity_type='client_candidate_decision' then k:='client';select i.client_id,i.applicant_id into s,talent_id from public.client_candidate_decisions i where i.id=e.entity_id and i.organization_id=e.organization_id;
 elsif e.entity_type='client_placement_handoff' then k:='client';select i.client_id,i.applicant_id,i.placement_id into s,talent_id,placement_id from public.client_placement_handoffs i where i.id=e.entity_id and i.organization_id=e.organization_id;
 elsif e.entity_type='placement_onboarding_item' then k:='placement';select i.placement_id into s from public.placement_onboarding_items i where i.id=e.entity_id and i.organization_id=e.organization_id;
 end if;
 if k is null or s is null then return null;end if;
 rec:=private.activity_record(a,k,s);if rec is null then return null;end if;
 if talent_id is not null then related:=related||jsonb_build_array(jsonb_build_object('kind','talent','id',talent_id));end if;
 if placement_id is not null then related:=related||jsonb_build_array(jsonb_build_object('kind','placement','id',placement_id));end if;
 if k='placement' then select related||jsonb_build_array(jsonb_build_object('kind','talent','id',p.applicant_id),jsonb_build_object('kind','client','id',p.client_id)) into related from public.placements p where p.id=s and p.organization_id=e.organization_id;end if;
 if a.role='talent_management' and spec->>'category'='access' and k='client' then return null;end if;
 if k='employee' and a.role<>'admin' and(e.actor_user_id is distinct from a.id or not (spec->>'external')::boolean) then return null;end if;
 if a.role in ('client_admin','client_reviewer','client_billing') and e.actor_user_id is distinct from a.id then return null;end if;
 if k='document' then
  select jsonb_build_array(jsonb_build_object('kind','talent','id',d.applicant_id)) into related from public.documents d where d.id=s and d.organization_id=e.organization_id and d.applicant_id is not null;
 end if;
 if e.entity_type='talent_review_queue' then
  old_status:=case e.before_value->>'status' when 'submitted' then 'New application' when 'in_review' then 'In review' when 'needs_more_info' then 'Needs information' when 'bench_ready' then 'Bench ready' when 'not_selected' then 'Closed' end;
  new_status:=case e.after_value->>'status' when 'submitted' then 'New application' when 'in_review' then 'In review' when 'needs_more_info' then 'Needs information' when 'bench_ready' then 'Bench ready' when 'not_selected' then 'Closed' end;
  if old_status is distinct from new_status then changes:=jsonb_build_array(jsonb_build_object('label','Review status','before',old_status,'after',new_status));end if;
 elsif e.event_type='administrator_owner_reassigned' then
  field_label:=case e.after_value->>'field' when 'review' then 'Review owner' when 'support' then 'Talent support owner' when 'sales' then 'Sales owner' end;
  if field_label is not null then
   select display_name into owner_before from public.platform_users where id::text=e.before_value->>'owner_id' and organization_id=e.organization_id;
   select display_name into owner_after from public.platform_users where id::text=e.after_value->>'owner_id' and organization_id=e.organization_id;
   changes:=jsonb_build_array(jsonb_build_object('label',field_label,'before',coalesce(owner_before,case when e.before_value->>'owner_id' is null then 'Unassigned' else 'Former team member' end),'after',coalesce(owner_after,case when e.after_value->>'owner_id' is null then 'Unassigned' else 'Team member unavailable' end)));
  end if;
 elsif jsonb_typeof(e.after_value->'changed_fields')='array' then
  for f in select jsonb_array_elements_text(e.after_value->'changed_fields') loop
   field_label:=case f when 'full_name' then 'Name' when 'display_name' then 'Display name' when 'email' then 'Contact details' when 'contact_email' then 'Contact details' when 'phone' then 'Contact details' when 'business_email' then 'Work contact details' when 'business_phone' then 'Work contact details' when 'address' then 'Address' when 'birth_date' then 'Private profile details' when 'gender_identity' then 'Private profile details' when 'pronouns' then 'Pronouns' when 'preferred_name' then 'Preferred name' when 'verified_skills' then 'Verified skills' when 'skill_experience' then 'Years of experience' when 'work_status' then 'Work status' when 'profile_details' then 'Profile details' when 'hire_date' then 'Hire date' end;
   if field_label is not null and not exists(select 1 from jsonb_array_elements(changes) c where c->>'label'=field_label) then changes:=changes||jsonb_build_array(jsonb_build_object('label',field_label,'before',null,'after',null));end if;
  end loop;
 end if;
 select display_name into actor_label from public.platform_users u where u.id=e.actor_user_id and u.organization_id=e.organization_id;
 if a.role in ('virtual_assistant','client_admin','client_reviewer','client_billing') and e.actor_user_id is distinct from a.id then actor_label:=case when e.actor_user_id is null then 'Actor unavailable' else 'Soro team' end;end if;
 if e.actor_user_id is null and e.entity_type='talent_application' and e.event_type='application_submitted' then actor_label:='Application intake';end if;
 return jsonb_build_object('key','audit:'||e.id,'recordedAt',e.created_at,'actorId',case when a.role in ('virtual_assistant','client_admin','client_reviewer','client_billing') and e.actor_user_id is distinct from a.id then null else e.actor_user_id end,'actorLabel',coalesce(actor_label,'Actor unavailable'),'action',spec->>'action','category',spec->>'category','record',rec,'outcome',case when e.after_value->>'outcome' in ('pending','failed','completed') then e.after_value->>'outcome' else 'recorded' end,'changes',changes,'related',coalesce(related,'[]'));
end $$;

create function private.activity_rows(a public.platform_users) returns setof jsonb
language sql stable security definer set search_path=pg_catalog,public,private as $$
 select v from public.audit_events e cross join lateral(select private.activity_project(a,e) v) p where e.organization_id=a.organization_id and v is not null
 union all
 select jsonb_build_object('key','document:'||e.seq,'recordedAt',e.created_at,'actorId',case when a.role in ('virtual_assistant','client_admin','client_reviewer','client_billing') and e.actor_id<>a.id then null else e.actor_id end,'actorLabel',case when a.role in ('virtual_assistant','client_admin','client_reviewer','client_billing') and e.actor_id<>a.id then 'Soro team' else coalesce(u.display_name,'Actor unavailable') end,'category','files','action',case e.action when 'Packet assigned' then 'Document packet requested' when 'Document submitted' then 'Document request submitted' when 'Submission accepted' then 'Document accepted' when 'Corrections requested' then 'Document returned for correction' when 'Request cancelled' then 'Document request cancelled' when 'Packet complete' then 'Document packet completed' end,'record',jsonb_build_object('kind','document','id',r.id,'label',r.title,'href','#documents?requestId='||r.id),'outcome','recorded','changes','[]'::jsonb,'related',jsonb_build_array(jsonb_build_object('kind',r.subject_kind,'id',r.subject_id)))
 from public.dc_events e join public.dc_requests r on r.id=e.request_id left join public.dc_items i on i.id=e.item_id and i.request_id=r.id left join public.dc_templates t on t.id=i.template_id and t.organization_id=r.organization_id left join public.platform_users u on u.id=e.actor_id and u.organization_id=r.organization_id
 where r.organization_id=a.organization_id and private.dc_request_access(a,r) and(e.item_id is null or private.dc_item_access(a,r,t)) and e.action in ('Packet assigned','Document submitted','Submission accepted','Corrections requested','Request cancelled','Packet complete')
 union all
 select jsonb_build_object('key','support:'||e.id,'recordedAt',e.created_at,'actorId',case when not private.support_staff(a,t) and e.actor_user_id<>a.id then null else e.actor_user_id end,'actorLabel',case when not private.support_staff(a,t) and e.actor_user_id<>a.id then 'Soro team' else coalesce(u.display_name,'Actor unavailable') end,'category','support','action',case e.kind when 'created' then 'Support ticket submitted' when 'status' then 'Support status updated' when 'assignment' then 'Support ticket assignment updated' end,'record',jsonb_build_object('kind','support','id',t.id,'label','Ticket '||t.ticket_number,'href','#help?ticketId='||t.id),'outcome','recorded','changes',case when e.kind='status' then jsonb_build_array(jsonb_build_object('label','Status','before',null,'after',case e.status when 'open' then 'New' when 'in_progress' then 'In progress' when 'waiting_on_client' then 'Waiting on requester' when 'resolved' then 'Resolved' else 'Updated' end)) else '[]'::jsonb end,'related','[]'::jsonb)
 from public.support_entries e join public.support_tickets t on t.id=e.ticket_id left join public.platform_users u on u.id=e.actor_user_id and u.organization_id=t.organization_id where t.organization_id=a.organization_id and private.support_can_read(a.id,t.id) and(e.visibility='public' or private.support_staff(a,t)) and e.kind in ('created','status','assignment');
$$;

create function public.get_activity_history(p_actor_user_id uuid,p_kind text,p_entity_id uuid default null,p_filters jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users%rowtype;f jsonb:=p_filters;subject jsonb;result jsonb;cutoff timestamptz;first_date date;last_date date;skip integer;
begin
 select * into a from private.active_support_actor(p_actor_user_id);
 if p_kind='client' and p_entity_id is null and a.role in ('client_admin','client_reviewer','client_billing') then
  select m.client_id into p_entity_id from public.client_portal_memberships m where m.user_id=a.id and m.organization_id=a.organization_id and m.active and private.dc_subject_valid(a,'client',m.client_id,a.id) group by m.client_id;
  if (select count(distinct m.client_id) from public.client_portal_memberships m where m.user_id=a.id and m.organization_id=a.organization_id and m.active and private.dc_subject_valid(a,'client',m.client_id,a.id))<>1 then raise exception 'Activity access denied' using errcode='42501';end if;
 end if;
 subject:=private.activity_record(a,p_kind,p_entity_id);if subject is null or(p_kind='all' and p_entity_id is not null) then raise exception 'Activity access denied' using errcode='42501';end if;
 if f is null or jsonb_typeof(f)<>'object' or exists(select 1 from jsonb_object_keys(f) k where k not in ('search','category','recordType','actor','from','to','offset','asOf')) or exists(select 1 from jsonb_each(f) e where jsonb_typeof(e.value)<>'string') or length(coalesce(f->>'search',''))>120 or coalesce(f->>'category','') not in ('','profile','review','ownership','access','workflow','files','tasks','support','attendance') or coalesce(f->>'recordType','') not in ('','talent','client','employee','placement','document','task','support') or coalesce(f->>'offset','0')!~'^[0-9]{1,7}$' then raise exception 'Invalid activity filters' using errcode='22023';end if;
 if coalesce(f->>'actor','')<>'' and (f->>'actor')!~'^[a-fA-F0-9-]{36}$' then raise exception 'Invalid actor' using errcode='22023';end if;
 first_date:=nullif(f->>'from','')::date;last_date:=nullif(f->>'to','')::date;skip:=coalesce(f->>'offset','0')::int;cutoff:=least(coalesce(nullif(f->>'asOf','')::timestamptz,statement_timestamp()),statement_timestamp());
 if first_date>last_date or skip>1000000 then raise exception 'Invalid page or date range' using errcode='22023';end if;
 with authorized as materialized(select v from private.activity_rows(a) v where(p_kind='all' or(v->'record'->>'kind'=p_kind and v->'record'->>'id'=p_entity_id::text) or v->'related' @> jsonb_build_array(jsonb_build_object('kind',p_kind,'id',p_entity_id))) and(v->>'recordedAt')::timestamptz<=cutoff),
 filtered as materialized(select v from authorized where(coalesce(f->>'recordType','')='' or v->'record'->>'kind'=f->>'recordType') and(coalesce(f->>'search','')='' or strpos(lower((v->>'action')||' '||(v->>'actorLabel')||' '||(v->'record'->>'label')),lower(f->>'search'))>0) and(coalesce(f->>'category','')='' or v->>'category'=f->>'category') and(coalesce(f->>'actor','')='' or v->>'actorId'=lower(f->>'actor')) and(first_date is null or((v->>'recordedAt')::timestamptz at time zone 'UTC')::date>=first_date) and(last_date is null or((v->>'recordedAt')::timestamptz at time zone 'UTC')::date<=last_date)),
 page as(select v from filtered order by(v->>'recordedAt')::timestamptz desc,v->>'key' desc limit 30 offset skip)
 select jsonb_build_object('role',a.role,'subject',subject,'total',(select count(*) from filtered),'offset',skip,'pageSize',30,'asOf',cutoff,'generatedAt',statement_timestamp(),'rows',coalesce((select jsonb_agg(v-'related' order by(v->>'recordedAt')::timestamptz desc,v->>'key' desc) from page),'[]'::jsonb),'options',jsonb_build_object('actors',coalesce((select jsonb_agg(jsonb_build_object('id',id,'label',label) order by label,id) from(select distinct v->>'actorId' id,v->>'actorLabel' label from authorized where v->>'actorId' is not null) x),'[]'::jsonb))) into result;
 return result;
end $$;
revoke all on function private.activity_record(public.platform_users,text,uuid),private.activity_catalog(text,text),private.activity_project(public.platform_users,public.audit_events),private.activity_rows(public.platform_users),public.get_activity_history(uuid,text,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.get_activity_history(uuid,text,uuid,jsonb) to service_role;
create index if not exists activity_org_recorded_idx on public.audit_events(organization_id,created_at desc,id desc);
commit;
