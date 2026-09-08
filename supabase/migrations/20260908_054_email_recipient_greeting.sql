begin;

-- Read only; no backfill, new recipient, queued-body rewrite or email trigger.
create function public.get_confirmation_greeting(p_outbox_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare q public.confirmation_outbox%rowtype; a public.platform_users%rowtype;
  v_name text; v_preferred text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501',message='Service access required.';
  end if;
  select * into q from public.confirmation_outbox where id=p_outbox_id;
  if not found or q.status<>'sending' or p_lease_token is null
    or q.lease_token is distinct from p_lease_token or q.lease_expires_at<=clock_timestamp()
    or q.lease_expires_at is null then
    raise exception using errcode='42501',message='Lease expired.';
  end if;
  select p.* into a from public.platform_users p join auth.users u on u.id=p.id
    where p.id=q.recipient_user_id and p.organization_id=q.organization_id and p.active
      and not p.must_change_password and u.email_confirmed_at is not null
      and lower(btrim(u.email))=q.recipient_email;
  if not found or private.support_confirmation_allowed(q) is distinct from true then
    raise exception using errcode='42501',message='Recipient unavailable.';
  end if;
  if a.role='virtual_assistant' then
    select t.full_name,t.preferred_name into v_name,v_preferred from public.applicants t
      where t.auth_user_id=a.id and t.organization_id=a.organization_id
        and t.archived_at is null and t.portal_access_status='active';
  elsif a.role in ('client_admin','client_reviewer','client_billing') then
    select cc.full_name into v_name from public.client_portal_memberships m
      join public.client_contacts cc on cc.id=m.client_contact_id and cc.client_id=m.client_id
        and cc.organization_id=m.organization_id and cc.active
      join public.clients c on c.id=m.client_id and c.organization_id=m.organization_id and c.archived_at is null
      where m.user_id=a.id and m.organization_id=a.organization_id and m.active;
  elsif a.role in ('admin','sales_management','sales','talent_management','billing') then
    select e.full_name into v_name from public.employee_profiles e
      where e.user_id=a.id and e.organization_id=a.organization_id;
    v_name:=coalesce(nullif(btrim(v_name),''),a.display_name);
  end if;
  return jsonb_build_object('fullName',v_name,'preferredName',v_preferred);
end $$;
revoke all on function public.get_confirmation_greeting(uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_confirmation_greeting(uuid,uuid) to service_role;

commit;
