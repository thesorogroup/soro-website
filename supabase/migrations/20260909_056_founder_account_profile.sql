-- The Founder keeps the existing protected Administrator identity. No dummy HR data.
begin;

alter table public.employee_profiles
  alter column phone drop not null,
  alter column hire_date drop not null,
  alter column address_line_1 drop not null,
  alter column city drop not null,
  alter column state_region drop not null,
  alter column postal_code drop not null,
  alter column country drop not null;

create function private.require_employee_profile_details()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if not exists (select 1 from public.platform_users u where u.id=new.user_id
    and u.organization_id=new.organization_id and u.role='admin'::public.platform_role and u.is_founder)
    and (new.phone is null or new.hire_date is null or new.address_line_1 is null
      or new.city is null or new.state_region is null or new.postal_code is null or new.country is null) then
    raise exception using errcode='23502',message='Complete the required employee contact and employment details.';
  end if;
  return new;
end $$;
revoke all on function private.require_employee_profile_details() from public,anon,authenticated;
create trigger require_employee_profile_details before insert or update on public.employee_profiles
for each row execute function private.require_employee_profile_details();

-- Known name and login email only. Optional details remain genuinely unknown.
insert into public.employee_profiles(user_id,organization_id,full_name,email)
select u.id,u.organization_id,coalesce(nullif(btrim(u.display_name),''),'The Founder'),lower(a.email)
from public.platform_users u join auth.users a on a.id=u.id
where u.is_founder and u.role='admin'::public.platform_role and u.active
on conflict(user_id) do nothing;

-- Preserve the current projection (including deliberately public work contacts).
do $migration$
declare d text; needle text;
begin
  d:=replace(pg_get_functiondef('public.admin_employee_directory()'::regprocedure),E'\r\n',E'\n');
  needle:='true as profile_complete';
  if strpos(d,needle)=0 then raise exception 'Employee completeness patch target missing'; end if;
  d:=replace(d,needle,'(profile.phone is not null and profile.hire_date is not null and profile.address_line_1 is not null and profile.city is not null and profile.state_region is not null and profile.postal_code is not null and profile.country is not null) as profile_complete');
  execute d;
end $migration$;

create function public.founder_account_profile(p_actor_user_id uuid,p_action text default 'read',p_payload jsonb default '{}'::jsonb,p_expected_updated_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users; p public.employee_profiles; v_email text; changed jsonb;
begin
  select * into a from public.platform_users where id=p_actor_user_id and active and not must_change_password
    and role='admin'::public.platform_role and is_founder for update;
  if a.id is null then raise exception using errcode='42501',message='The signed-in Founder account is required.'; end if;
  select * into strict p from public.employee_profiles where user_id=a.id and organization_id=a.organization_id for update;
  select email into v_email from auth.users where id=a.id;
  if p_action='save' then
    if p.updated_at is distinct from p_expected_updated_at then
      raise exception using errcode='40001',message='Your account details changed. Reload before saving.';
    end if;
    if jsonb_typeof(p_payload)<>'object' or (p_payload - array['full_name','contact_email','phone','hire_date','address_line_1','address_line_2','city','state_region','postal_code','country','business_email','business_phone'])<>'{}'::jsonb then
      raise exception using errcode='22023',message='Only personal account details can be changed here.';
    end if;
    if not (p_payload ?& array['full_name','contact_email','phone','hire_date','address_line_1','address_line_2','city','state_region','postal_code','country','business_email','business_phone']) then
      raise exception using errcode='22023',message='Reload the account form before saving.';
    end if;
    if exists(select 1 from jsonb_each(p_payload) f where jsonb_typeof(f.value) not in ('string','null')) then
      raise exception using errcode='22023',message='Account details must be text.';
    end if;
    if length(btrim(coalesce(p_payload->>'full_name',''))) not between 2 and 120
      or coalesce(p_payload->>'contact_email','') !~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$' then
      raise exception using errcode='22023',message='Enter your name and a valid contact email.';
    end if;
    if nullif(p_payload->>'hire_date','') is not null and ((p_payload->>'hire_date')::date > current_date) then
      raise exception using errcode='22023',message='Hire date cannot be in the future.';
    end if;
    select coalesce(jsonb_agg(key),'[]'::jsonb) into changed from jsonb_each(p_payload)
      where value is distinct from case when key='contact_email' then to_jsonb(p.email)
        when key='business_email' then to_jsonb(a.business_email)
        when key='business_phone' then to_jsonb(a.business_phone) else to_jsonb(p)->key end;
    update public.employee_profiles set full_name=btrim(p_payload->>'full_name'),email=lower(btrim(p_payload->>'contact_email')),
      phone=nullif(btrim(p_payload->>'phone'),''),hire_date=nullif(p_payload->>'hire_date','')::date,
      address_line_1=nullif(btrim(p_payload->>'address_line_1'),''),address_line_2=nullif(btrim(p_payload->>'address_line_2'),''),
      city=nullif(btrim(p_payload->>'city'),''),state_region=nullif(btrim(p_payload->>'state_region'),''),
      postal_code=nullif(btrim(p_payload->>'postal_code'),''),country=nullif(btrim(p_payload->>'country'),'')
      where user_id=a.id returning * into p;
    update public.platform_users set display_name=p.full_name,
      business_email=nullif(lower(btrim(p_payload->>'business_email')),''),business_phone=nullif(btrim(p_payload->>'business_phone'),'')
      where id=a.id returning * into a;
    insert into public.audit_events(organization_id,actor_user_id,entity_type,entity_id,event_type,after_value)
      values(a.organization_id,a.id,'employee',a.id,'founder_account_updated',jsonb_build_object('changed_fields',changed));
  elsif p_action<>'read' or p_payload<>'{}'::jsonb then
    raise exception using errcode='22023',message='Unsupported account action.';
  end if;
  return jsonb_build_object('userId',a.id,'updatedAt',p.updated_at,'loginEmail',v_email,'title','The Founder',
    'profile',jsonb_build_object('full_name',p.full_name,'contact_email',p.email,'phone',p.phone,'hire_date',p.hire_date,
      'address_line_1',p.address_line_1,'address_line_2',p.address_line_2,'city',p.city,'state_region',p.state_region,
      'postal_code',p.postal_code,'country',p.country,'business_email',a.business_email,'business_phone',a.business_phone));
end $$;
revoke all on function public.founder_account_profile(uuid,text,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.founder_account_profile(uuid,text,jsonb,timestamptz) to service_role;
commit;
