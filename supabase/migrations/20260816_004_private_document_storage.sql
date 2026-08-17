-- Soro Operations: private storage for résumés, application files, and
-- internal documents. Nothing in this bucket is publicly reachable.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'soro-private-documents',
  'soro-private-documents',
  false,
  104857600,
  array[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'image/jpeg',
    'image/png',
    'video/mp4',
    'video/quicktime',
    'video/webm'
  ]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy "Soro internal users can read private documents"
on storage.objects for select
to authenticated
using (
  bucket_id = 'soro-private-documents'
  and public.is_internal_soro_user()
);

create policy "Soro admin and talent management can upload private documents"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'soro-private-documents'
  and public.current_soro_role() in ('admin'::public.platform_role, 'talent_management'::public.platform_role)
);

create policy "Soro admin and talent management can update private documents"
on storage.objects for update
to authenticated
using (
  bucket_id = 'soro-private-documents'
  and public.current_soro_role() in ('admin'::public.platform_role, 'talent_management'::public.platform_role)
)
with check (
  bucket_id = 'soro-private-documents'
  and public.current_soro_role() in ('admin'::public.platform_role, 'talent_management'::public.platform_role)
);

create policy "Soro admin and talent management can delete private documents"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'soro-private-documents'
  and public.current_soro_role() in ('admin'::public.platform_role, 'talent_management'::public.platform_role)
);
