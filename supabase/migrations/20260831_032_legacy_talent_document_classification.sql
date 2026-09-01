-- Restore deterministic labels for legacy Talent application files without
-- moving, copying, deleting, or otherwise changing the stored objects.
-- Ambiguous personality screenshots intentionally remain `assessment` until
-- Admin or Talent Management classifies them manually.

with resume_candidates as (
  select
    document.id,
    document.organization_id,
    document.document_type as previous_type
  from public.documents as document
  join public.applicants as applicant
    on applicant.id = document.applicant_id
   and applicant.organization_id = document.organization_id
  where document.document_type = 'application_attachment'
    and document.storage_path is not null
    and nullif(btrim(document.external_url), '') is not null
    and btrim(document.external_url) = btrim(applicant.resume_url)
), updated_resumes as (
  update public.documents as document
  set document_type = 'resume'
  from resume_candidates as candidate
  where document.id = candidate.id
  returning
    document.id,
    document.organization_id,
    candidate.previous_type,
    document.document_type as current_type
)
insert into public.audit_events (
  organization_id,
  entity_type,
  entity_id,
  event_type,
  before_value,
  after_value,
  note
)
select
  organization_id,
  'document',
  id,
  'legacy_document_classified',
  jsonb_build_object('document_type', previous_type),
  jsonb_build_object('document_type', current_type),
  'Legacy résumé matched exactly to the applicant resume URL; storage object unchanged.'
from updated_resumes;

with assessment_candidates as (
  select
    document.id,
    document.organization_id,
    document.document_type as previous_type,
    case
      when document.file_name ~* '(^|[^a-z0-9])disc([^a-z0-9]|$)'
        and document.file_name !~* '(^|[^a-z0-9])enneagram([^a-z0-9]|$)'
        and document.file_name !~* '(^|[^a-z0-9])mbti([^a-z0-9]|$)|16[ _-]?personalit'
        then 'disc_assessment'
      when document.file_name ~* '(^|[^a-z0-9])enneagram([^a-z0-9]|$)'
        and document.file_name !~* '(^|[^a-z0-9])disc([^a-z0-9]|$)'
        and document.file_name !~* '(^|[^a-z0-9])mbti([^a-z0-9]|$)|16[ _-]?personalit'
        then 'enneagram_assessment'
      when document.file_name ~* '(^|[^a-z0-9])mbti([^a-z0-9]|$)|16[ _-]?personalit'
        and document.file_name !~* '(^|[^a-z0-9])disc([^a-z0-9]|$)'
        and document.file_name !~* '(^|[^a-z0-9])enneagram([^a-z0-9]|$)'
        then 'mbti_assessment'
      else null
    end as inferred_type
  from public.documents as document
  where document.document_type = 'assessment'
    and document.storage_path is not null
), updated_assessments as (
  update public.documents as document
  set document_type = candidate.inferred_type
  from assessment_candidates as candidate
  where document.id = candidate.id
    and candidate.inferred_type is not null
  returning
    document.id,
    document.organization_id,
    candidate.previous_type,
    document.document_type as current_type
)
insert into public.audit_events (
  organization_id,
  entity_type,
  entity_id,
  event_type,
  before_value,
  after_value,
  note
)
select
  organization_id,
  'document',
  id,
  'legacy_document_classified',
  jsonb_build_object('document_type', previous_type),
  jsonb_build_object('document_type', current_type),
  'Legacy assessment type inferred from one explicit filename token; storage object unchanged.'
from updated_assessments;
