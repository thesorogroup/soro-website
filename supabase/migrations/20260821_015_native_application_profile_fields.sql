-- Structured fields introduced by the second native Talent application.
-- Applicant-selected skills remain explicitly self-reported; verified_skills
-- continues to be controlled by Talent Management review.

alter table public.applicants
  add column if not exists expected_hourly_rate_max numeric(12,2),
  add column if not exists work_status_other_detail text,
  add column if not exists timezone_other_detail text,
  add column if not exists has_laptop boolean,
  add column if not exists has_noise_canceling_headset boolean,
  add column if not exists has_reliable_internet boolean,
  add column if not exists has_backup_internet boolean,
  add column if not exists has_emergency_workspace boolean,
  add column if not exists self_reported_experience_areas text[] not null default '{}',
  add column if not exists self_reported_skills text[] not null default '{}',
  add column if not exists other_experience_specialty text;

alter table public.applicants
  drop constraint if exists applicants_expected_hourly_rate_max_positive,
  drop constraint if exists applicants_expected_hourly_rate_range_ordered;

alter table public.applicants
  add constraint applicants_expected_hourly_rate_max_positive
    check (expected_hourly_rate_max is null or expected_hourly_rate_max > 0),
  add constraint applicants_expected_hourly_rate_range_ordered
    check (expected_hourly_rate is null or expected_hourly_rate_max is null or expected_hourly_rate_max >= expected_hourly_rate);

comment on column public.applicants.expected_hourly_rate_max is
  'Applicant-reported upper bound of the expected USD hourly-rate range.';
comment on column public.applicants.work_status_other_detail is
  'Applicant clarification shown only when current work status is Other.';
comment on column public.applicants.timezone_other_detail is
  'Applicant-provided city, time zone, or UTC offset when the listed time zones do not apply.';
comment on column public.applicants.self_reported_experience_areas is
  'Stable application category IDs selected by the applicant; not Talent Management verification.';
comment on column public.applicants.self_reported_skills is
  'Human-readable applicant-selected skill labels; keep separate from verified_skills.';
comment on column public.applicants.other_experience_specialty is
  'Applicant-provided experience specialty when Other is selected.';

-- The public application endpoint may refresh only fields supplied by the
-- applicant. It still cannot update ownership, status, verified_skills, review
-- results, or any other staff-controlled field on a repeat application.
grant update (
  full_name,
  email,
  phone,
  location,
  timezone,
  timezone_other_detail,
  country,
  city,
  province_region,
  address_line_1,
  postal_code,
  availability_note,
  expected_hourly_rate,
  expected_hourly_rate_max,
  expected_hourly_rate_text,
  education_level,
  education_training_summary,
  work_status,
  work_status_other_detail,
  greatest_dream,
  referral_source,
  dedicated_workspace,
  has_laptop,
  has_noise_canceling_headset,
  has_reliable_internet,
  has_backup_internet,
  has_emergency_workspace,
  equipment_summary,
  internet_summary,
  self_reported_experience_areas,
  self_reported_skills,
  other_experience_specialty,
  loom_video_url,
  application_received_at,
  submitted_at
) on table public.applicants to service_role;
