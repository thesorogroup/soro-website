-- Soro Operations: preserve the fields received in the existing applicant
-- workbook while retaining structured fields for matching and review.

alter table public.applicants
  add column if not exists birth_date date,
  add column if not exists application_received_at timestamptz,
  add column if not exists expected_hourly_rate_text text,
  add column if not exists legacy_application_data jsonb not null default '{}'::jsonb;

create index if not exists applicants_application_received_idx
  on public.applicants (application_received_at desc);
