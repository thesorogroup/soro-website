-- Soro Operations: establish the first internal administrator and access rules.
-- Run after 20260816_001_soro_operations.sql.

insert into public.platform_users (id, organization_id, role, display_name, active)
select u.id, o.id, 'admin'::public.platform_role, 'Matt', true
from auth.users u
join public.organizations o on o.name = 'Soro Group'
where lower(u.email) = 'matt@thesorogroup.com'
on conflict (id) do update
set organization_id = excluded.organization_id,
    role = excluded.role,
    display_name = excluded.display_name,
    active = true,
    updated_at = now();

create or replace function public.current_soro_role()
returns public.platform_role
language sql
stable
security definer
set search_path = public
as $$
  select role
  from public.platform_users
  where id = auth.uid() and active = true
  limit 1;
$$;

create or replace function public.is_soro_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_soro_role() = 'admin'::public.platform_role;
$$;

create or replace function public.is_internal_soro_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_soro_role() in (
    'admin'::public.platform_role,
    'sales_management'::public.platform_role,
    'sales'::public.platform_role,
    'talent_management'::public.platform_role,
    'billing'::public.platform_role
  );
$$;

create policy "soro admins can manage organizations"
on public.organizations for all
using (public.is_soro_admin())
with check (public.is_soro_admin());

create policy "users can read their own access record"
on public.platform_users for select
using (id = auth.uid());

create policy "soro admins can manage user access"
on public.platform_users for all
using (public.is_soro_admin())
with check (public.is_soro_admin());

create policy "talent management can manage applicant records"
on public.applicants for all
using (public.current_soro_role() in ('admin'::public.platform_role, 'talent_management'::public.platform_role))
with check (public.current_soro_role() in ('admin'::public.platform_role, 'talent_management'::public.platform_role));

create policy "a virtual assistant can read their own profile"
on public.applicants for select
using (auth_user_id = auth.uid());

create policy "internal users can read clients"
on public.clients for select
using (public.is_internal_soro_user());

create policy "sales can manage clients"
on public.clients for all
using (public.current_soro_role() in ('admin'::public.platform_role, 'sales_management'::public.platform_role, 'sales'::public.platform_role))
with check (public.current_soro_role() in ('admin'::public.platform_role, 'sales_management'::public.platform_role, 'sales'::public.platform_role));

create policy "internal users can read client contacts"
on public.client_contacts for select
using (public.is_internal_soro_user());

create policy "sales can manage client contacts"
on public.client_contacts for all
using (public.current_soro_role() in ('admin'::public.platform_role, 'sales_management'::public.platform_role, 'sales'::public.platform_role))
with check (public.current_soro_role() in ('admin'::public.platform_role, 'sales_management'::public.platform_role, 'sales'::public.platform_role));

create policy "internal users can read hiring requests"
on public.hiring_requests for select
using (public.is_internal_soro_user());

create policy "sales can manage hiring requests"
on public.hiring_requests for all
using (public.current_soro_role() in ('admin'::public.platform_role, 'sales_management'::public.platform_role, 'sales'::public.platform_role))
with check (public.current_soro_role() in ('admin'::public.platform_role, 'sales_management'::public.platform_role, 'sales'::public.platform_role));

create policy "internal users can read placements"
on public.placements for select
using (public.is_internal_soro_user());

create policy "admin and talent management can manage placements"
on public.placements for all
using (public.current_soro_role() in ('admin'::public.platform_role, 'talent_management'::public.platform_role))
with check (public.current_soro_role() in ('admin'::public.platform_role, 'talent_management'::public.platform_role));

create policy "internal users can read documents"
on public.documents for select
using (public.is_internal_soro_user());

create policy "virtual assistants can read own documents"
on public.documents for select
using (exists (
  select 1 from public.applicants a
  where a.id = documents.applicant_id and a.auth_user_id = auth.uid()
));

create policy "admin and talent management can manage documents"
on public.documents for all
using (public.current_soro_role() in ('admin'::public.platform_role, 'talent_management'::public.platform_role))
with check (public.current_soro_role() in ('admin'::public.platform_role, 'talent_management'::public.platform_role));

create policy "internal users can read audit history"
on public.audit_events for select
using (public.is_internal_soro_user());

create policy "admin can create audit history"
on public.audit_events for insert
with check (public.is_soro_admin());
