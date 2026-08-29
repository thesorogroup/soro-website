-- Keep Talent self-service document access inside the same organization as
-- both the signed-in portal account and its linked applicant record.

drop policy if exists "active virtual assistants can read own documents" on public.documents;
create policy "active virtual assistants can read own documents"
on public.documents for select to authenticated
using (
  private.current_soro_role() = 'virtual_assistant'::public.platform_role
  and documents.organization_id = private.current_soro_organization_id()
  and exists (
    select 1
    from public.applicants as applicant
    where applicant.id = documents.applicant_id
      and applicant.auth_user_id = auth.uid()
      and applicant.organization_id = documents.organization_id
      and applicant.organization_id = private.current_soro_organization_id()
      and applicant.archived_at is null
  )
);

drop policy if exists "Virtual assistants can read own private document objects" on storage.objects;
create policy "Virtual assistants can read own private document objects"
on storage.objects for select to authenticated
using (
  bucket_id = 'soro-private-documents'
  and private.current_soro_role() = 'virtual_assistant'::public.platform_role
  and exists (
    select 1
    from public.documents as document
    join public.applicants as applicant
      on applicant.id = document.applicant_id
     and applicant.organization_id = document.organization_id
    where document.storage_path = storage.objects.name
      and document.organization_id = private.current_soro_organization_id()
      and applicant.organization_id = private.current_soro_organization_id()
      and applicant.auth_user_id = auth.uid()
      and applicant.archived_at is null
  )
);
