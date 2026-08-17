-- Verified result values are intentionally distinct from legacy source URLs.
-- Review staff enter these after confirming the attached private document.
alter table public.applicants
  add column if not exists english_test_result text,
  add column if not exists personality_profile_score text,
  add column if not exists computer_specs text,
  add column if not exists internet_speed text;

comment on column public.applicants.english_test_result is 'Verified English screening result; never stores an external source URL.';
comment on column public.applicants.personality_profile_score is 'Verified personality assessment score or profile; never stores an external source URL.';
comment on column public.applicants.computer_specs is 'Verified computer hardware and operating-system details.';
comment on column public.applicants.internet_speed is 'Verified internet speed test result.';
