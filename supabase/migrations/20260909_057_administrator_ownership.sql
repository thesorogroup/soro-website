-- Explicit, organization-scoped ownership changes. Actor history is never rewritten.
begin;
create function private.is_sales_owner(p_user uuid,p_org uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from public.platform_users u where u.id=p_user and u.organization_id=p_org
    and u.active and not u.must_change_password
    and (u.role='sales'::public.platform_role or (u.role='admin'::public.platform_role and u.is_founder)))
$$;
revoke all on function private.is_sales_owner(uuid,uuid) from public,anon,authenticated;

-- Update the established target eligibility checks, not actor authorization checks.
-- Fail closed if an expected deployed function/target is absent.
do $migration$
declare f record; d text; patched text; alias text; changed integer:=0;
begin
  for f in select p.oid,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where (n.nspname,p.proname) in (
      ('private','available_talent_bench_json'),('public','change_available_talent_bench'),
      ('private','client_shortlist_workspace_json'),('public','change_client_shortlist'),
      ('private','client_pipeline_workspace_json'),('public','change_client_pipeline'),
      ('public','change_client_placement_workflow'),('private','client_sales_contact')) loop
    d:=pg_get_functiondef(f.oid); patched:=d;
    foreach alias in array array['access','owner','send_owner','response_owner','staff'] loop
      patched:=regexp_replace(patched,'\m'||alias||'\.role\s*=\s*''sales''::public\.platform_role',
        'private.is_sales_owner('||alias||'.id,'||alias||'.organization_id)','g');
    end loop;
    if patched=d then raise exception 'Owner eligibility target missing in %',f.proname; end if;
    execute patched; changed:=changed+1;
  end loop;
  if changed<>8 then raise exception 'Expected eight ownership eligibility functions'; end if;
end $migration$;

create table public.staff_ownership_operations(
  request_id uuid primary key, organization_id uuid not null references public.organizations(id),
  actor_user_id uuid not null references public.platform_users(id), fingerprint jsonb not null,
  result jsonb not null, created_at timestamptz not null default now()
);
alter table public.staff_ownership_operations enable row level security;
revoke all on public.staff_ownership_operations from public,anon,authenticated;

create function private.ownership_admin(p_actor uuid) returns public.platform_users
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.platform_users;
begin
  select * into a from public.platform_users where id=p_actor and role='admin'::public.platform_role
    and active and not must_change_password for share;
  if a.id is null or a.organization_id is null then raise exception using errcode='42501',message='Administrator access required.'; end if;
  return a;
end $$;
revoke all on function private.ownership_admin(uuid) from public,anon,authenticated;

create function public.get_staff_ownership(p_actor_user_id uuid,p_kind text,p_entity_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users; r jsonb; roster jsonb; linked integer;
begin
  a:=private.ownership_admin(p_actor_user_id);
  if p_kind='client' then
    select jsonb_build_object('id',c.id,'name',c.company_name,'updatedAt',c.updated_at,'salesOwnerId',c.sales_owner_id)
      into r from public.clients c where c.id=p_entity_id and c.organization_id=a.organization_id;
    select count(distinct i.applicant_id) into linked from public.client_shortlist_items i
      join public.client_shortlists s on s.id=i.shortlist_id and s.organization_id=i.organization_id
      where s.client_id=p_entity_id and s.organization_id=a.organization_id and i.removed_at is null and i.workflow_state in ('active','selected','placed');
  elsif p_kind='talent' then
    select jsonb_build_object('id',t.id,'name',t.full_name,'updatedAt',t.updated_at,
      'reviewOwnerId',t.talent_review_owner_id,'supportOwnerId',t.talent_support_owner_id,'salesOwnerId',t.sales_owner_id)
      into r from public.applicants t where t.id=p_entity_id and t.organization_id=a.organization_id;
  else raise exception using errcode='22023',message='Choose a Client or Talent profile.'; end if;
  if r is null then raise exception using errcode='42501',message='This profile is unavailable.'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',u.id,'name',coalesce(nullif(u.display_name,''),'Staff member'),
    'role',u.role,'isFounder',u.is_founder,'salesEligible',private.is_sales_owner(u.id,a.organization_id))
    order by u.is_founder desc,u.display_name,u.id),'[]'::jsonb) into roster
    from public.platform_users u where u.organization_id=a.organization_id and u.active and not u.must_change_password
      and u.role in ('admin'::public.platform_role,'talent_management'::public.platform_role,'sales'::public.platform_role);
  return jsonb_build_object('kind',p_kind,'record',r,'assignees',roster,'linkedTalentCount',coalesce(linked,0));
end $$;
revoke all on function public.get_staff_ownership(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.get_staff_ownership(uuid,text,uuid) to service_role;

-- The regular dependency guard stays in force for all ordinary writes. Only an
-- exact-client secure transfer may reconcile ownership across the linked workflow.
do $migration$
declare d text; needle text;
begin
  d:=replace(pg_get_functiondef('private.guard_client_workflow_dependencies()'::regprocedure),E'\r\n',E'\n');
  needle:=E'    and v_has_dependent_workflow then';
  if strpos(d,needle)=0 then raise exception 'Client dependency guard target missing'; end if;
  execute replace(d,needle,E'    and v_has_dependent_workflow\n    and not (coalesce(auth.role(), '''') = ''service_role'' and coalesce(current_setting(''soro.ownership_client'',true),'''')=old.id::text) then');
end $migration$;

create function public.change_staff_ownership(p_actor_user_id uuid,p_request_id uuid,p_kind text,p_entity_id uuid,
  p_expected_updated_at timestamptz,p_field text,p_owner_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users; target public.platform_users; t public.applicants; c public.clients;
  previous uuid; fingerprint jsonb; prior public.staff_ownership_operations; result jsonb; prior_context text;
begin
  a:=private.ownership_admin(p_actor_user_id);
  if auth.role() is distinct from 'service_role' then raise exception using errcode='42501',message='Secure ownership service required.'; end if;
  if p_request_id is null or p_expected_updated_at is null then raise exception using errcode='22023',message='Reload the profile before changing ownership.'; end if;
  fingerprint:=jsonb_build_object('kind',p_kind,'id',p_entity_id,'version',p_expected_updated_at,'field',p_field,'owner',p_owner_id);
  perform pg_advisory_xact_lock(hashtextextended('staff-ownership:'||a.organization_id::text,0));
  select * into prior from public.staff_ownership_operations where request_id=p_request_id;
  if found then
    if prior.actor_user_id<>a.id or prior.organization_id<>a.organization_id or prior.fingerprint<>fingerprint then
      raise exception using errcode='22023',message='This request ID was already used for another change.';
    end if;
    return prior.result;
  end if;
  if p_owner_id is not null then
    select * into target from public.platform_users where id=p_owner_id and organization_id=a.organization_id and active and not must_change_password for share;
    if target.id is null or (p_field='sales' and not private.is_sales_owner(target.id,a.organization_id))
      or (p_field in ('review','support') and target.role not in ('admin'::public.platform_role,'talent_management'::public.platform_role)) then
      raise exception using errcode='22023',message='Choose an active, eligible owner from this organization.';
    end if;
  end if;
  if p_kind='talent' and p_field in ('review','support','sales') then
    select * into t from public.applicants where id=p_entity_id and organization_id=a.organization_id for update;
    if not found then raise exception using errcode='42501',message='Talent profile unavailable.'; end if;
    if t.updated_at is distinct from p_expected_updated_at then raise exception using errcode='40001',message='This Talent profile changed. Reload before reassigning.'; end if;
    previous:=case p_field when 'review' then t.talent_review_owner_id when 'support' then t.talent_support_owner_id else t.sales_owner_id end;
    if p_field='sales' and exists(select 1 from public.client_shortlist_items i where i.applicant_id=t.id
      and i.organization_id=a.organization_id and i.removed_at is null and i.workflow_state in ('active','selected','placed')) then
      raise exception using errcode='P0001',message='This Talent is in a Client process. Reassign the Client owner to keep the connected workflow together.';
    end if;
    if p_field='sales' and p_owner_id is not null then
      perform pg_advisory_xact_lock(hashtextextended('available-talent-owner:'||a.organization_id::text||':'||p_owner_id::text,0));
      if (select count(*) from public.applicants x where x.organization_id=a.organization_id and x.sales_owner_id=p_owner_id
        and x.id<>t.id and x.archived_at is null and x.status in ('bench_ready','shortlisted','interviewing','client_review')) >=
        coalesce((select sales_caseload_limit from public.available_talent_bench_settings where organization_id=a.organization_id and sales_owner_id=p_owner_id),40) then
        raise exception using errcode='P0001',message='The selected owner has reached the active Talent caseload limit.';
      end if;
    end if;
    update public.applicants set talent_review_owner_id=case when p_field='review' then p_owner_id else talent_review_owner_id end,
      talent_support_owner_id=case when p_field='support' then p_owner_id else talent_support_owner_id end,
      sales_owner_id=case when p_field='sales' then p_owner_id else sales_owner_id end,updated_at=clock_timestamp() where id=t.id;
  elsif p_kind='client' and p_field='sales' then
    select * into c from public.clients where id=p_entity_id and organization_id=a.organization_id for update;
    if not found then raise exception using errcode='42501',message='Client profile unavailable.'; end if;
    if c.updated_at is distinct from p_expected_updated_at then raise exception using errcode='40001',message='This Client changed. Reload before reassigning.'; end if;
    previous:=c.sales_owner_id;
    if p_owner_id is null and exists(select 1 from public.client_shortlists s
      where s.client_id=c.id and s.organization_id=a.organization_id and (s.status='draft' or exists(
        select 1 from public.client_shortlist_items i where i.shortlist_id=s.id and i.removed_at is null and i.workflow_state in ('active','selected','placed')))) then
      raise exception using errcode='P0001',message='Choose a replacement owner while this Client has an active candidate process.';
    end if;
    -- A scheduled meeting keeps its real organizer/attendees. Move it through the
    -- interview workflow first so an ownership edit cannot silently desync Teams.
    if exists(select 1 from public.client_candidate_interviews where client_id=c.id and organization_id=a.organization_id and status='scheduled') then
      raise exception using errcode='P0001',message='Resolve the scheduled Client interview before transferring this Client; its calendar attendees must not be silently changed.';
    end if;
    perform 1 from public.applicants x where x.id in(select i.applicant_id from public.client_shortlist_items i join public.client_shortlists s on s.id=i.shortlist_id
      where s.client_id=c.id and i.removed_at is null and i.workflow_state in ('active','selected','placed')) order by x.id for update;
    if p_owner_id is not null then
      perform pg_advisory_xact_lock(hashtextextended('available-talent-owner:'||a.organization_id::text||':'||p_owner_id::text,0));
      if (select count(*) from public.applicants x where x.organization_id=a.organization_id and x.archived_at is null
        and x.status in ('bench_ready','shortlisted','interviewing','client_review') and (x.sales_owner_id=p_owner_id or x.id in(
          select i.applicant_id from public.client_shortlist_items i join public.client_shortlists s on s.id=i.shortlist_id
          where s.client_id=c.id and i.removed_at is null and i.workflow_state in ('active','selected','placed')))) >
        coalesce((select sales_caseload_limit from public.available_talent_bench_settings where organization_id=a.organization_id and sales_owner_id=p_owner_id),40) then
        raise exception using errcode='P0001',message='The replacement owner has insufficient Talent caseload capacity.';
      end if;
    end if;
    update public.applicants x set sales_owner_id=p_owner_id,updated_at=clock_timestamp() where x.organization_id=a.organization_id and x.id in(
      select i.applicant_id from public.client_shortlist_items i join public.client_shortlists s on s.id=i.shortlist_id
      where s.client_id=c.id and i.removed_at is null and i.workflow_state in ('active','selected','placed'));
    update public.client_shortlists s set sales_owner_id=p_owner_id,updated_at=clock_timestamp() where s.client_id=c.id and s.organization_id=a.organization_id
      and (s.status='draft' or exists(select 1 from public.client_shortlist_items i where i.shortlist_id=s.id and i.removed_at is null and i.workflow_state in ('active','selected','placed')));
    prior_context:=current_setting('soro.ownership_client',true);
    perform set_config('soro.ownership_client',c.id::text,true);
    update public.clients set sales_owner_id=p_owner_id,updated_at=clock_timestamp() where id=c.id;
    perform set_config('soro.ownership_client',coalesce(prior_context,''),true);
  else raise exception using errcode='22023',message='Unsupported ownership change.'; end if;
  insert into public.audit_events(organization_id,actor_user_id,entity_type,entity_id,event_type,before_value,after_value)
    values(a.organization_id,a.id,case when p_kind='talent' then 'applicant' else 'client' end,p_entity_id,'administrator_owner_reassigned',
      jsonb_build_object('field',p_field,'owner_id',previous),jsonb_build_object('field',p_field,'owner_id',p_owner_id,'request_id',p_request_id));
  result:=public.get_staff_ownership(a.id,p_kind,p_entity_id);
  insert into public.staff_ownership_operations(request_id,organization_id,actor_user_id,fingerprint,result)
    values(p_request_id,a.organization_id,a.id,fingerprint,result);
  return result;
end $$;
revoke all on function public.change_staff_ownership(uuid,uuid,text,uuid,timestamptz,text,uuid) from public,anon,authenticated;
grant execute on function public.change_staff_ownership(uuid,uuid,text,uuid,timestamptz,text,uuid) to service_role;

commit;
