-- Private Talent profile fields. These fields are intentionally kept on the
-- applicant record, which clients have no select policy for. Internal Soro
-- users and the authenticated Talent can read their own protected record.

alter table public.applicants
  add column if not exists country text,
  add column if not exists address_line_1 text,
  add column if not exists address_line_2 text,
  add column if not exists city text,
  add column if not exists province_region text,
  add column if not exists postal_code text,
  add column if not exists interview_video_provider text,
  add column if not exists interview_video_reference text;

alter table public.applicants
  alter column country set default 'Philippines',
  alter column timezone set default 'Asia/Manila';

update public.applicants
set country = coalesce(nullif(trim(country), ''), 'Philippines'),
    timezone = coalesce(nullif(trim(timezone), ''), 'Asia/Manila')
where country is null
   or trim(country) = ''
   or timezone is null
   or trim(timezone) = '';

comment on column public.applicants.address_line_1 is
  'Private Talent address. Visible to Soro internal users and the authenticated Talent only; never render in client views.';
comment on column public.applicants.interview_video_provider is
  'Secure video provider for long-form company interview recordings, for example Mux.';
comment on column public.applicants.interview_video_reference is
  'Provider-specific private playback or asset reference; do not expose directly to clients.';
