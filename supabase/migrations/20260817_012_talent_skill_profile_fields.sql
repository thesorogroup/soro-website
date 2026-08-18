-- Verified matching fields for the Talent Directory.
-- These values are intentionally separate from uploaded documents so filters
-- only use Talent Management-reviewed profile information.

alter table public.applicants
  add column if not exists verified_skills text[] not null default '{}',
  add column if not exists relevant_experience_years numeric(5,1),
  add column if not exists relevant_experience_summary text,
  add column if not exists education_training_summary text,
  add column if not exists skill_profile_updated_at timestamptz;

alter table public.applicants
  drop constraint if exists applicants_relevant_experience_years_nonnegative;

alter table public.applicants
  add constraint applicants_relevant_experience_years_nonnegative
  check (relevant_experience_years is null or relevant_experience_years >= 0);

create index if not exists applicants_verified_skills_gin
  on public.applicants using gin (verified_skills);
