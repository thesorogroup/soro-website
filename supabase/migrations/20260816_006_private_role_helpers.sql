-- Keep authorization helpers outside the public API surface. They are still
-- usable by Row Level Security policies, but cannot be invoked as public RPCs.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create or replace function private.current_soro_role()
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

create or replace function private.is_soro_admin()
returns boolean
language sql
stable
security definer
set search_path = private, public
as $$
  select private.current_soro_role() = 'admin'::public.platform_role;
$$;

create or replace function private.is_internal_soro_user()
returns boolean
language sql
stable
security definer
set search_path = private, public
as $$
  select private.current_soro_role() in (
    'admin'::public.platform_role,
    'sales_management'::public.platform_role,
    'sales'::public.platform_role,
    'talent_management'::public.platform_role,
    'billing'::public.platform_role
  );
$$;

grant execute on function private.current_soro_role() to authenticated;
grant execute on function private.is_soro_admin() to authenticated;
grant execute on function private.is_internal_soro_user() to authenticated;

drop policy "soro admins can manage organizations" on public.organizations;
create policy "soro admins can manage organizations" on public.organizations for all using (private.is_soro_admin()) with check (private.is_soro_admin());

drop policy "soro admins can manage user access" on public.platform_users;
create policy "soro admins can manage user access" on public.platform_users for all using (private.is_soro_admin()) with check (private.is_soro_admin());

drop policy "talent management can manage applicant records" on public.applicants;
create policy "talent management can manage applicant records" on public.applicants for all using (private.current_soro_role() in ('admin'::public.platform_role, 'talent_management'::public.platform_role)) with check (private.current_soro_role() in ('admin'::public.platform_role, 'talent_management'::public.platform_role));

drop policy "internal users can read clients" on public.clients;
create policy "internal users can read clients" on public.clients for select using (private.is_internal_soro_user());
drop policy "sales can manage clients" on public.clients;
create policy "sales can manage clients" on public.clients for all using (private.current_soro_role() in ('admin'::public.platform_role, 'sales_management'::public.platform_role, 'sales'::public.platform_role)) with check (private.current_soro_role() in ('admin'::public.platform_role, 'sales_management'::public.platform_role, 'sales'::public.platform_role));

drop policy "internal users can read client contacts" on public.client_contacts;
create policy "internal users can read client contacts" on public.client_contacts for select using (private.is_internal_soro_user());
drop policy "sales can manage client contacts" on public.client_contacts;
create policy "sales can manage client contacts" on public.client_contacts for all using (private.current_soro_role() in ('admin'::public.platform_role, 'sales_management'::public.platform_role, 'sales'::public.platform_role)) with check (private.current_soro_role() in ('admin'::public.platform_role, 'sales_management'::public.platform_role, 'sales'::public.platform_role));

drop policy "internal users can read hiring requests" on public.hiring_requests;
create policy "internal users can read hiring requests" on public.hiring_requests for select using (private.is_internal_soro_user());
drop policy "sales can manage hiring requests" on public.hiring_requests;
create policy "sales can manage hiring requests" on public.hiring_requests for all using (private.current_soro_role() in ('admin'::public.platform_role, 'sales_management'::public.platform_role, 'sales'::public.platform_role)) with check (private.current_soro_role() in ('admin'::public.platform_role, 'sales_management'::public.platform_role, 'sales'::public.platform_role));

drop policy "internal users can read placements" on public.placements;
create policy "internal users can read placements" on public.placements for select using (private.is_internal_soro_user());
drop policy "admin and talent management can manage placements" on public.placements;
create policy "admin and talent management can manage placements" on public.placements for all using (private.current_soro_role() in ('admin'::public.platform_role, 'talent_management'::public.platform_role)) with check (private.current_soro_role() in ('admin'::public.platform_role, 'talent_management'::public.platform_role));

drop policy "internal users can read documents" on public.documents;
create policy "internal users can read documents" on public.documents for select using (private.is_internal_soro_user());
drop policy "admin and talent management can manage documents" on public.documents;
create policy "admin and talent management can manage documents" on public.documents for all using (private.current_soro_role() in ('admin'::public.platform_role, 'talent_management'::public.platform_role)) with check (private.current_soro_role() in ('admin'::public.platform_role, 'talent_management'::public.platform_role));

drop policy "internal users can read audit history" on public.audit_events;
create policy "internal users can read audit history" on public.audit_events for select using (private.is_internal_soro_user());
drop policy "admin can create audit history" on public.audit_events;
create policy "admin can create audit history" on public.audit_events for insert with check (private.is_soro_admin());

drop policy "Soro internal users can read private documents" on storage.objects;
create policy "Soro internal users can read private documents" on storage.objects for select to authenticated using (bucket_id = 'soro-private-documents' and private.is_internal_soro_user());
drop policy "Soro admin and talent management can upload private documents" on storage.objects;
create policy "Soro admin and talent management can upload private documents" on storage.objects for insert to authenticated with check (bucket_id = 'soro-private-documents' and private.current_soro_role() in ('admin'::public.platform_role, 'talent_management'::public.platform_role));
drop policy "Soro admin and talent management can update private documents" on storage.objects;
create policy "Soro admin and talent management can update private documents" on storage.objects for update to authenticated using (bucket_id = 'soro-private-documents' and private.current_soro_role() in ('admin'::public.platform_role, 'talent_management'::public.platform_role)) with check (bucket_id = 'soro-private-documents' and private.current_soro_role() in ('admin'::public.platform_role, 'talent_management'::public.platform_role));
drop policy "Soro admin and talent management can delete private documents" on storage.objects;
create policy "Soro admin and talent management can delete private documents" on storage.objects for delete to authenticated using (bucket_id = 'soro-private-documents' and private.current_soro_role() in ('admin'::public.platform_role, 'talent_management'::public.platform_role));

drop function public.is_internal_soro_user();
drop function public.is_soro_admin();
drop function public.current_soro_role();
