-- Soro Operations: tighten employee role boundaries around applicant source data.
-- Sales Associates work from approved, role-specific records; raw application
-- submissions and private applicant files remain limited to Admin and Talent
-- Management. The existing VA own-document policy is intentionally unchanged.

drop policy if exists "Soro internal users can read application drafts"
on public.talent_application_drafts;
drop policy if exists "Soro Admin and Talent Management can read application drafts"
on public.talent_application_drafts;
create policy "Soro Admin and Talent Management can read application drafts"
on public.talent_application_drafts for select to authenticated
using (
  private.current_soro_role() in (
    'admin'::public.platform_role,
    'talent_management'::public.platform_role
  )
);

drop policy if exists "Soro internal users can read submitted Talent applications"
on public.talent_applications;
drop policy if exists "Soro Admin and Talent Management can read submitted Talent applications"
on public.talent_applications;
create policy "Soro Admin and Talent Management can read submitted Talent applications"
on public.talent_applications for select to authenticated
using (
  private.current_soro_role() in (
    'admin'::public.platform_role,
    'talent_management'::public.platform_role
  )
);

drop policy if exists "internal users can read documents"
on public.documents;
drop policy if exists "Soro Admin and Talent Management can read documents"
on public.documents;
create policy "Soro Admin and Talent Management can read documents"
on public.documents for select to authenticated
using (
  private.current_soro_role() in (
    'admin'::public.platform_role,
    'talent_management'::public.platform_role
  )
);

drop policy if exists "Soro internal users can read private documents"
on storage.objects;
drop policy if exists "Soro Admin and Talent Management can read private documents"
on storage.objects;
create policy "Soro Admin and Talent Management can read private documents"
on storage.objects for select to authenticated
using (
  bucket_id = 'soro-private-documents'
  and private.current_soro_role() in (
    'admin'::public.platform_role,
    'talent_management'::public.platform_role
  )
);

-- The employee-onboarding Netlify function uses the server-only service role.
-- Grant only the table operations that function performs. RLS still protects
-- browser requests made with authenticated employee sessions.
revoke insert, update, delete on table public.platform_users from authenticated;
grant select on table public.platform_users to authenticated;
grant select, insert, update on table public.platform_users to service_role;
grant select, insert on table public.employee_profiles to service_role;
grant select, insert, update on table public.audit_events to service_role;
