-- Capture successful direct staff writes from now on. Never reconstruct history.
-- Existing service/RPC actions keep their current canonical audit writer.
begin;
create function private.capture_staff_profile_activity() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users%rowtype;changed text[]:='{}';b jsonb;n jsonb;event text;field text;
begin
 n:=to_jsonb(new);if tg_op='UPDATE' then b:=to_jsonb(old);else b:='{}';end if;
 if tg_table_name='applicants' and coalesce(auth.jwt()->>'role','')='service_role' and n->'legacy_application_data'->>'source'='native_application' and n->>'status'='submitted' and n->>'submitted_at' is not null and b->>'submitted_at' is null then
  insert into public.audit_events(organization_id,actor_user_id,entity_type,entity_id,event_type) values(new.organization_id,null,'talent_application',new.id,'application_submitted');return new;
 end if;
 if coalesce(auth.jwt()->>'role','')<>'authenticated' then return new;end if;
 select * into a from public.platform_users where id=auth.uid() and active and not must_change_password and role in ('admin','talent_management','virtual_assistant');
 if not found or a.organization_id is distinct from new.organization_id then return new;end if;
 if a.role='virtual_assistant' and(tg_table_name<>'applicants' or tg_op<>'UPDATE' or n->>'auth_user_id' is distinct from a.id::text or n->>'portal_access_status' is distinct from 'active' or n->>'archived_at' is not null) then return new;end if;
 if tg_table_name='documents' then
  if tg_op<>'INSERT' or new.applicant_id is null then return new;end if;
  insert into public.audit_events(organization_id,actor_user_id,entity_type,entity_id,event_type) values(a.organization_id,a.id,'document',new.id,'staff_document_uploaded');return new;
 end if;
 foreach field in array array['full_name','preferred_name','email','phone','pronouns','work_status'] loop
  if b->field is distinct from n->field then changed:=array_append(changed,field);end if;
 end loop;
 if exists(select 1 from unnest(array['address_line_1','address_line_2','city','state_region','postal_code','country','timezone']) f where b->f is distinct from n->f) then changed:=array_append(changed,'address');end if;
 if exists(select 1 from unnest(array['birth_date','gender_identity','gender_identity_self_description','pronouns_self_description']) f where b->f is distinct from n->f) then changed:=array_append(changed,'profile_details');end if;
 if b->'verified_skills' is distinct from n->'verified_skills' then changed:=array_append(changed,'verified_skills');end if;
 if b->'legacy_application_data'->'verified_skill_experience' is distinct from n->'legacy_application_data'->'verified_skill_experience' then changed:=array_append(changed,'skill_experience');end if;
 if exists(select 1 from unnest(array['status','availability_note','english_proficiency','english_test_result','personality_profile_score','equipment_summary','computer_specs','internet_summary','internet_speed','greatest_dream','expected_hourly_rate','expected_hourly_rate_text','relevant_experience_years','relevant_experience_summary','education_training_summary','self_reported_experience_areas','self_reported_skills']) f where b->f is distinct from n->f) then changed:=array_append(changed,'profile_details');end if;
 if tg_op='INSERT' then event:='talent_profile_created';elsif cardinality(changed)=0 then return new;elsif a.role='virtual_assistant' then event:='talent_identity_updated';elsif changed<@array['verified_skills','skill_experience']::text[] then event:='talent_skills_updated';else event:='talent_profile_updated';end if;
 insert into public.audit_events(organization_id,actor_user_id,entity_type,entity_id,event_type,after_value) values(a.organization_id,a.id,'applicant',new.id,event,jsonb_build_object('changed_fields',changed));
 return new;
end $$;
revoke all on function private.capture_staff_profile_activity() from public,anon,authenticated,service_role;
create trigger capture_staff_talent_activity after insert or update on public.applicants for each row execute function private.capture_staff_profile_activity();
create trigger capture_staff_document_activity after insert on public.documents for each row execute function private.capture_staff_profile_activity();
create policy "New profile capture visibility" on public.audit_events as restrictive for select to authenticated using(event_type not in ('talent_profile_created','talent_profile_updated','talent_skills_updated','staff_document_uploaded','talent_identity_updated','application_submitted') or(organization_id=private.current_soro_organization_id() and(private.current_soro_role() in ('admin','talent_management') or(private.current_soro_role()='virtual_assistant' and event_type in ('talent_identity_updated','application_submitted') and exists(select 1 from public.applicants t where t.id=entity_id and t.organization_id=audit_events.organization_id and t.auth_user_id=auth.uid() and t.portal_access_status='active' and t.archived_at is null)))));
create policy "Captured activity inserts use trusted writers" on public.audit_events as restrictive for insert to authenticated with check(event_type not in ('talent_profile_created','talent_profile_updated','talent_skills_updated','staff_document_uploaded','talent_identity_updated','application_submitted'));
create policy "Captured activity cannot be edited" on public.audit_events as restrictive for update to authenticated using(event_type not in ('talent_profile_created','talent_profile_updated','talent_skills_updated','staff_document_uploaded','talent_identity_updated','application_submitted')) with check(event_type not in ('talent_profile_created','talent_profile_updated','talent_skills_updated','staff_document_uploaded','talent_identity_updated','application_submitted'));
create policy "Captured activity cannot be deleted" on public.audit_events as restrictive for delete to authenticated using(event_type not in ('talent_profile_created','talent_profile_updated','talent_skills_updated','staff_document_uploaded','talent_identity_updated','application_submitted'));
commit;
