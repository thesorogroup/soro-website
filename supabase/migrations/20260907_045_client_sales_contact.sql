-- Publish only deliberately configured work contact details, never HR contacts.
begin;
alter table public.platform_users
  add column business_email text,
  add column business_phone text;
alter table public.platform_users
  add constraint platform_business_email_valid check (business_email is null or (length(business_email)<=254 and business_email ~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$')),
  add constraint platform_business_phone_valid check (business_phone is null or (business_phone ~ '^[+0-9(). xX-]{3,40}$' and business_phone ~ '[0-9]'));

create function public.update_employee_business_contact(p_actor_user_id uuid,p_user_id uuid,p_email text,p_phone text)
returns void language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare v_org uuid;
begin
  select organization_id into v_org from public.platform_users
  where id=p_actor_user_id and active and not must_change_password and role='admin'::public.platform_role;
  if v_org is null then raise exception using errcode='42501',message='Administrator access required.'; end if;
  update public.platform_users set business_email=nullif(lower(btrim(p_email)),''),business_phone=nullif(btrim(p_phone),'')
  where id=p_user_id and organization_id=v_org and role='sales'::public.platform_role;
  if not found then raise exception using errcode='42501',message='Sales employee not available.'; end if;
  insert into public.audit_events(organization_id,actor_user_id,entity_type,entity_id,event_type,after_value)
  values(v_org,p_actor_user_id,'employee',p_user_id,'employee_business_contact_updated',jsonb_build_object('changed_fields',jsonb_build_array('business_email','business_phone')));
end $$;
revoke all on function public.update_employee_business_contact(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.update_employee_business_contact(uuid,uuid,text,text) to service_role;

create function private.client_sales_contact(p_org uuid,p_client uuid,p_owner uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog,public,private as $$
  with creator as (
    select actor_user_id from public.client_pipeline_operations
    where organization_id=p_org and client_id=p_client and action='create_client'
    order by created_at,operation_request_id limit 1
  ), candidates as (
    select p_owner as user_id,0 as priority union all select actor_user_id,1 from creator
  )
  select jsonb_build_object('name',coalesce(nullif(btrim(staff.display_name),''),'Your Sales Associate'),
    'email',staff.business_email,'phone',staff.business_phone)
  from candidates join public.platform_users staff on staff.id=candidates.user_id and staff.organization_id=p_org
  where staff.active and not staff.must_change_password and staff.role='sales'::public.platform_role
  order by candidates.priority limit 1
$$;
revoke all on function private.client_sales_contact(uuid,uuid,uuid) from public,anon,authenticated;

-- Preserve the existing dashboard and directory projections, including role gates.
do $migration$
declare v_definition text; v_needle text;
begin
  v_definition:=replace(pg_get_functiondef('public.get_client_dashboard(uuid)'::regprocedure),E'\r\n',E'\n');
  v_needle:='  if v_actor.role = ''client_billing''::public.platform_role then return v_result; end if;';
  if strpos(v_definition,v_needle)=0 then raise exception 'Client dashboard patch target missing'; end if;
  execute replace(v_definition,v_needle,E'  v_result := v_result || jsonb_build_object(''salesContact'', private.client_sales_contact(v_actor.organization_id,v_actor.client_id,v_actor.sales_owner_id));\n'||v_needle);
  v_definition:=replace(pg_get_functiondef('public.admin_employee_directory()'::regprocedure),E'\r\n',E'\n');
  v_needle:='''password_changed_at'', access.password_changed_at';
  if strpos(v_definition,v_needle)=0 then raise exception 'Employee directory patch target missing'; end if;
  execute replace(v_definition,v_needle,v_needle||E',\n        ''business_email'', access.business_email,\n        ''business_phone'', access.business_phone');
end $migration$;
commit;
