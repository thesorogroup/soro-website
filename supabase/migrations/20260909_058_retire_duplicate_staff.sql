-- Recoverable consolidation: retain account identity and immutable activity history.
begin;
alter table public.platform_users add column retired_into_user_id uuid references public.platform_users(id),
  add column retired_at timestamptz;
alter table public.platform_users add constraint retired_staff_inactive check(
  (retired_into_user_id is null and retired_at is null) or
  (retired_into_user_id is not null and retired_at is not null and not active and not is_founder and retired_into_user_id<>id));

create function private.reject_retired_owner() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare column_name text; assigned uuid; previous uuid;
begin
  foreach column_name in array tg_argv loop
    assigned:=nullif(to_jsonb(new)->>column_name,'')::uuid;
    previous:=case when tg_op='UPDATE' then nullif(to_jsonb(old)->>column_name,'')::uuid else null end;
    if assigned is not null and (assigned is distinct from previous or (tg_op='UPDATE' and (
      to_jsonb(new)->'status' is distinct from to_jsonb(old)->'status' or to_jsonb(new)->'active' is distinct from to_jsonb(old)->'active'))) then
      perform 1 from public.platform_users where id=assigned for share;
      if exists(select 1 from public.platform_users where id=assigned and retired_at is not null) then
        raise exception using errcode='23514',message='This staff account has been retired. Choose its current replacement.';
      end if;
    end if;
  end loop;
  return new;
end $$;
revoke all on function private.reject_retired_owner() from public,anon,authenticated;
create trigger applicants_retired_owner before insert or update on public.applicants for each row execute function private.reject_retired_owner('talent_review_owner_id','talent_support_owner_id','sales_owner_id','auth_user_id');
create trigger clients_retired_owner before insert or update on public.clients for each row execute function private.reject_retired_owner('sales_owner_id');
create trigger tasks_retired_owner before insert or update on public.tasks for each row execute function private.reject_retired_owner('assigned_to_user_id');
create trigger documents_retired_owner before insert or update on public.documents for each row execute function private.reject_retired_owner('assigned_to_user_id');
create trigger zz_support_retired_owner before insert or update on public.support_tickets for each row execute function private.reject_retired_owner('assigned_to_user_id');
create trigger interviews_retired_owner before insert or update on public.talent_interviews for each row execute function private.reject_retired_owner('interviewer_user_id');
create trigger shortlists_retired_owner before insert or update on public.client_shortlists for each row execute function private.reject_retired_owner('sales_owner_id');
create trigger client_interviews_retired_owner before insert or update on public.client_candidate_interviews for each row execute function private.reject_retired_owner('sales_owner_id');
create trigger zz_dc_requests_retired_owner before insert or update on public.dc_requests for each row execute function private.reject_retired_owner('recipient_id');
create trigger zz_dc_legacy_retired_owner before insert or update on public.dc_legacy_links for each row execute function private.reject_retired_owner('recipient_id');
create trigger zz_bench_retired_owner before insert or update on public.available_talent_bench_settings for each row execute function private.reject_retired_owner('sales_owner_id');
create trigger zz_confirmation_retired_owner before insert or update on public.confirmation_outbox for each row execute function private.reject_retired_owner('recipient_user_id');
create trigger zz_membership_retired_owner before insert or update on public.client_portal_memberships for each row execute function private.reject_retired_owner('user_id');
create trigger zz_payroll_retired_owner before insert or update on public.employee_payroll_items for each row execute function private.reject_retired_owner('employee_user_id');

-- Employee document subjects are polymorphic, not foreign keys. Guard them too,
-- even when the recipient is a different, still-active member of staff.
create function private.reject_retired_document_subject() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if new.subject_kind='employee' and (tg_op='INSERT' or new.subject_id is distinct from old.subject_id
    or new.subject_kind is distinct from old.subject_kind) then
    perform 1 from public.platform_users where id=new.subject_id for share;
    if exists(select 1 from public.platform_users where id=new.subject_id and retired_at is not null) then
      raise exception using errcode='23514',message='This employee account has been retired. Choose its current replacement.';
    end if;
  end if;
  return new;
end $$;
revoke all on function private.reject_retired_document_subject() from public,anon,authenticated;
create trigger zz_dc_requests_retired_subject before insert or update on public.dc_requests for each row execute function private.reject_retired_document_subject();
create trigger zz_dc_legacy_retired_subject before insert or update on public.dc_legacy_links for each row execute function private.reject_retired_document_subject();

create function private.protect_staff_retirement() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
  if (new.retired_at is distinct from old.retired_at or new.retired_into_user_id is distinct from old.retired_into_user_id)
    and auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501',message='Use the secure duplicate-account consolidation workflow.';
  end if;
  return new;
end $$;
revoke all on function private.protect_staff_retirement() from public,anon,authenticated;
create trigger protect_staff_retirement before update on public.platform_users for each row execute function private.protect_staff_retirement();

create function public.audit_staff_duplicate(p_actor_user_id uuid,p_source_user_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users; s public.platform_users; r record; n bigint; refs jsonb:='[]'; blockers jsonb:='[]'; source_email text; profile_name text;
begin
  a:=private.ownership_admin(p_actor_user_id);
  if not a.is_founder then raise exception using errcode='42501',message='The Founder must confirm account consolidation.'; end if;
  select * into s from public.platform_users where id=p_source_user_id and organization_id=a.organization_id
    and not is_founder and role in ('admin'::public.platform_role,'sales'::public.platform_role,'talent_management'::public.platform_role);
  if s.id is null then raise exception using errcode='42501',message='Duplicate employee account unavailable.'; end if;
  select email into source_email from auth.users where id=s.id;
  select full_name into profile_name from public.employee_profiles where user_id=s.id;
  -- Discover the deployed FK inventory rather than assuming the local schema is exhaustive.
  for r in select distinct ns.nspname as schema_name,cl.relname as table_name,att.attname as column_name
    from pg_constraint fk join pg_class cl on cl.oid=fk.conrelid join pg_namespace ns on ns.oid=cl.relnamespace
    cross join lateral unnest(fk.conkey,fk.confkey) pair(source_col,target_col)
    join pg_attribute att on att.attrelid=fk.conrelid and att.attnum=pair.source_col
    join pg_attribute target on target.attrelid=fk.confrelid and target.attnum=pair.target_col
    where fk.contype='f' and fk.confrelid in ('public.platform_users'::regclass,'public.employee_profiles'::regclass,'auth.users'::regclass)
      and target.attname in ('id','user_id')
    order by ns.nspname,cl.relname,att.attname loop
    execute format('select count(*) from %I.%I where %I=$1',r.schema_name,r.table_name,r.column_name) into n using s.id;
    if n>0 then
      refs:=refs||jsonb_build_array(jsonb_build_object('table',r.schema_name||'.'||r.table_name,'column',r.column_name,'count',n));
      if r.column_name ~ '(owner|assigned|recipient|interviewer)' and (r.schema_name||'.'||r.table_name) not in (
        'public.platform_users','public.applicants','public.clients','public.tasks','public.documents','public.support_tickets',
        'public.talent_interviews','public.client_shortlists','public.client_candidate_interviews','public.available_talent_bench_settings',
        'public.dc_requests','public.dc_legacy_links','public.task_notifications','public.client_shortlist_notifications','public.support_notifications','public.confirmation_outbox') then
        blockers:=blockers||jsonb_build_array('Review the additional ownership reference in '||r.schema_name||'.'||r.table_name||'.'||r.column_name||' before consolidation.');
      end if;
    end if;
  end loop;
  if exists(select 1 from public.applicants where auth_user_id=s.id) or exists(select 1 from public.client_portal_memberships where user_id=s.id and active) then
    blockers:=blockers||'"This account has an active Talent or Client login binding that needs separate reconciliation."'::jsonb;
  end if;
  if exists(select 1 from public.talent_interviews where interviewer_user_id=s.id and status='scheduled')
    or exists(select 1 from public.client_candidate_interviews where sales_owner_id=s.id and status='scheduled') then
    blockers:=blockers||'"Reschedule or resolve this account’s scheduled interviews first so Teams attendees remain correct."'::jsonb;
  end if;
  if exists(select 1 from public.employee_payroll_items where employee_user_id=s.id) then
    blockers:=blockers||'"Payroll records reference this account. Review their recipient identity before retiring it."'::jsonb;
  end if;
  if exists(select 1 from public.confirmation_outbox where recipient_user_id=s.id and status='sending') then
    blockers:=blockers||'"An email delivery is in progress for this account. Wait for it to finish before retiring it."'::jsonb;
  end if;
  return jsonb_build_object('source',jsonb_build_object('id',s.id,'name',coalesce(profile_name,s.display_name),'email',source_email,'retiredAt',s.retired_at),
    'target',jsonb_build_object('id',a.id,'name',a.display_name,'title','The Founder'),
    'references',refs,'blockers',blockers,'fingerprint',md5(jsonb_build_object('source',s,'refs',refs,'blockers',blockers)::text));
end $$;
revoke all on function public.audit_staff_duplicate(uuid,uuid) from public,anon,authenticated;
grant execute on function public.audit_staff_duplicate(uuid,uuid) to service_role;

create function public.retire_staff_duplicate(p_actor_user_id uuid,p_source_user_id uuid,p_expected_fingerprint text,p_expected_email text,p_expected_name text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users; s public.platform_users; audit jsonb; c record; counts jsonb:='{}'; n integer; moved_tasks uuid[];
begin
  a:=private.ownership_admin(p_actor_user_id);
  if not a.is_founder or auth.role() is distinct from 'service_role' then raise exception using errcode='42501',message='The secure Founder session is required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('staff-ownership:'||a.organization_id::text,0));
  select * into s from public.platform_users where id=p_source_user_id and organization_id=a.organization_id and not is_founder for update;
  if not found then raise exception using errcode='42501',message='Duplicate employee unavailable.'; end if;
  if s.retired_into_user_id=a.id then return jsonb_build_object('retired',true,'sourceId',s.id,'targetId',a.id); end if;
  perform 1 from public.confirmation_outbox where recipient_user_id=s.id and status in ('pending','sending') order by id for update;
  audit:=public.audit_staff_duplicate(a.id,s.id);
  if audit->>'fingerprint' is distinct from p_expected_fingerprint
    or lower(audit#>>'{source,email}') is distinct from lower(p_expected_email)
    or audit#>>'{source,name}' is distinct from p_expected_name then
    raise exception using errcode='40001',message='The duplicate account or its assignments changed. Review the transfer again.';
  end if;
  if jsonb_array_length(audit->'blockers')>0 then raise exception using errcode='P0001',message='Resolve the account-transfer blockers before retiring this account.'; end if;
  -- All current Client/candidate ownership moves through the same atomic service.
  for c in select id,updated_at from public.clients where organization_id=a.organization_id and sales_owner_id=s.id order by id for update loop
    perform public.change_staff_ownership(a.id,gen_random_uuid(),'client',c.id,c.updated_at,'sales',a.id);
  end loop;
  for c in select id,updated_at from public.applicants where organization_id=a.organization_id and sales_owner_id=s.id order by id for update loop
    perform public.change_staff_ownership(a.id,gen_random_uuid(),'talent',c.id,c.updated_at,'sales',a.id);
  end loop;
  if exists(select 1 from public.client_shortlists sl where sl.organization_id=a.organization_id and sl.sales_owner_id=s.id
    and (sl.status='draft' or exists(select 1 from public.client_shortlist_items i where i.shortlist_id=sl.id and i.removed_at is null and i.workflow_state in ('active','selected','placed')))) then
    raise exception using errcode='P0001',message='An active shortlist still belongs to this account. Reconcile its Client owner first.';
  end if;
  update public.applicants set talent_review_owner_id=case when talent_review_owner_id=s.id then a.id else talent_review_owner_id end,
    talent_support_owner_id=case when talent_support_owner_id=s.id then a.id else talent_support_owner_id end,
    updated_at=clock_timestamp()
    where organization_id=a.organization_id and (talent_review_owner_id=s.id or talent_support_owner_id=s.id or sales_owner_id=s.id);
  get diagnostics n=row_count;counts:=counts||jsonb_build_object('talentProfiles',n);
  select array_agg(id) into moved_tasks from public.tasks where organization_id=a.organization_id and assigned_to_user_id=s.id and status='open';
  update public.tasks set assigned_to_user_id=a.id where organization_id=a.organization_id and assigned_to_user_id=s.id and status='open';
  get diagnostics n=row_count;counts:=counts||jsonb_build_object('openTasks',n);
  insert into public.task_notifications(organization_id,recipient_user_id,task_id)
    select organization_id,a.id,id from public.tasks where id=any(coalesce(moved_tasks,'{}'::uuid[])) and assigned_to_user_id=a.id
    on conflict(task_id,recipient_user_id,notification_type) do nothing;
  update public.documents set assigned_to_user_id=a.id where organization_id=a.organization_id and assigned_to_user_id=s.id;
  get diagnostics n=row_count;counts:=counts||jsonb_build_object('documents',n);
  update public.support_tickets set assigned_to_user_id=a.id where organization_id=a.organization_id and assigned_to_user_id=s.id and status not in ('resolved','closed');
  get diagnostics n=row_count;counts:=counts||jsonb_build_object('supportTickets',n);
  update public.dc_requests set recipient_id=a.id,subject_id=case when subject_kind='employee' and subject_id=s.id then a.id else subject_id end,version=version+1,updated_at=clock_timestamp()
    where organization_id=a.organization_id and (recipient_id=s.id or (subject_kind='employee' and subject_id=s.id));
  update public.dc_legacy_links set recipient_id=a.id,subject_id=case when subject_kind='employee' and subject_id=s.id then a.id else subject_id end
    where organization_id=a.organization_id and (recipient_id=s.id or (subject_kind='employee' and subject_id=s.id));
  -- Queue messages to the old login are held for manual review, never replayed to another email.
  update public.confirmation_outbox set status='manual_review',last_error_code='staff_account_retired'
    where recipient_user_id=s.id and organization_id=a.organization_id and status='pending';
  -- Global residual checks catch malformed cross-organization ownership too.
  if exists(select 1 from public.applicants where talent_review_owner_id=s.id or talent_support_owner_id=s.id or sales_owner_id=s.id)
    or exists(select 1 from public.clients where sales_owner_id=s.id)
    or exists(select 1 from public.tasks where assigned_to_user_id=s.id and status='open')
    or exists(select 1 from public.documents where assigned_to_user_id=s.id)
    or exists(select 1 from public.support_tickets where assigned_to_user_id=s.id and status not in ('resolved','closed'))
    or exists(select 1 from public.talent_interviews where interviewer_user_id=s.id and status='scheduled')
    or exists(select 1 from public.client_candidate_interviews where sales_owner_id=s.id and status='scheduled')
    or exists(select 1 from public.client_shortlists sl where sl.sales_owner_id=s.id and (sl.status='draft' or exists(
      select 1 from public.client_shortlist_items i where i.shortlist_id=sl.id and i.removed_at is null and i.workflow_state in ('active','selected','placed'))))
    or exists(select 1 from public.dc_requests where recipient_id=s.id or (subject_kind='employee' and subject_id=s.id))
    or exists(select 1 from public.dc_legacy_links where recipient_id=s.id or (subject_kind='employee' and subject_id=s.id))
    or exists(select 1 from public.confirmation_outbox where recipient_user_id=s.id and status in ('pending','sending')) then
    raise exception using errcode='P0001',message='Current ownership remains on this account. Nothing was retired; review its remaining assignments.';
  end if;
  update public.platform_users set active=false,retired_into_user_id=a.id,retired_at=clock_timestamp() where id=s.id;
  insert into public.audit_events(organization_id,actor_user_id,entity_type,entity_id,event_type,before_value,after_value)
    values(a.organization_id,a.id,'employee',s.id,'duplicate_employee_retired',jsonb_build_object('reference_inventory',audit->'references'),jsonb_build_object('replacement_user_id',a.id,'transferred',counts));
  return jsonb_build_object('retired',true,'sourceId',s.id,'targetId',a.id,'transferred',counts);
end $$;
revoke all on function public.retire_staff_duplicate(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.retire_staff_duplicate(uuid,uuid,text,text,text) to service_role;

do $migration$
declare d text; needle text;
begin
  d:=pg_get_functiondef('public.admin_employee_directory()'::regprocedure);
  needle:='where profile.organization_id = v_organization_id';
  if strpos(d,needle)=0 then raise exception 'Employee retirement directory target missing';end if;
  execute replace(d,needle,needle||' and access.retired_at is null');
end $migration$;
commit;
