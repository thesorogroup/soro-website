-- Add saved skill-verification progress independently from applicant submission.
-- Existing source states, recorded-result flags, and Bench Ready gates stay intact.
begin;

create or replace function private.talent_review_checklist_json(
  p_applicant_id uuid,
  p_organization_id uuid
)
returns jsonb
language sql stable security definer
set search_path = pg_catalog, public, private
as $$
  with source as (
    select applicant.*,
      (select count(distinct nullif(regexp_replace(skill,
        '^[[:space:]]+|[[:space:]]+$', '', 'g'), ''))::integer
       from unnest(coalesce(applicant.verified_skills, '{}'::text[])) as skills(skill)
      ) as verified_skills_count
    from public.applicants as applicant
    where applicant.id = p_applicant_id
      and applicant.organization_id = p_organization_id
  ), personality as (
    select source.id,
      private.talent_screening_result_recorded((array_agg(
        regexp_replace(part, '^disc\M[[:space:]]*[:–—-]?[[:space:]]*', '', 'i') order by ordinal desc
      ) filter (where part ~* '^disc\M'))[1]) as disc,
      private.talent_screening_result_recorded((array_agg(
        regexp_replace(part, '^enneagram\M[[:space:]]*[:–—-]?[[:space:]]*', '', 'i') order by ordinal desc
      ) filter (where part ~* '^enneagram\M'))[1]) as enneagram,
      private.talent_screening_result_recorded(coalesce((array_agg(
        regexp_replace(part, '^(mbti(-style)?|personality[[:space:]]+type)\M[[:space:]]*[:–—-]?[[:space:]]*', '', 'i') order by ordinal desc
      ) filter (where part ~* '^(mbti(-style)?|personality[[:space:]]+type)\M'))[1],
        (array_agg(part order by ordinal) filter (where part ~* '^[EI][NS][FT][JP](-[AT])?$'))[1]
      )) as mbti
    from source
    cross join lateral (
      select regexp_replace(value, '^[[:space:]]+|[[:space:]]+$', '', 'g') as part, ordinal
      from regexp_split_to_table(coalesce(source.personality_profile_score, ''), E'[|;\n]+') with ordinality as segments(value, ordinal)
    ) as parts
    group by source.id
  ), items as (
    select item.*, source.id, source.organization_id, source.verified_skills_count
    from source join personality on personality.id = source.id
    cross join lateral (values
      (1, 'core_profile', 'Core profile', null::text, null::boolean,
        nullif(btrim(source.full_name), '') is not null
        and nullif(btrim(source.email), '') is not null
        and nullif(btrim(source.phone), '') is not null
        and nullif(btrim(source.timezone), '') is not null
        and (nullif(btrim(source.location), '') is not null or
          (nullif(btrim(source.country), '') is not null and nullif(btrim(source.city), '') is not null))),
      (2, 'resume', 'Resume', 'resume', null::boolean, nullif(btrim(source.resume_url), '') is not null),
      (3, 'english', 'English assessment', 'english_proof', private.talent_screening_result_recorded(source.english_test_result), false),
      (4, 'disc', 'DISC assessment', 'disc_assessment', personality.disc, false),
      (5, 'enneagram', 'Enneagram assessment', 'enneagram_assessment', personality.enneagram, false),
      (6, 'mbti', 'Four-letter personality assessment', 'mbti_assessment', personality.mbti, false),
      (7, 'internet', 'Internet speed proof', 'internet_proof', private.talent_screening_result_recorded(source.internet_speed), false),
      (8, 'equipment', 'Computer specifications', 'equipment_proof', private.talent_screening_result_recorded(source.computer_specs), false),
      (9, 'skills', 'Applicant-reported skills', null::text, null::boolean,
        cardinality(source.self_reported_experience_areas) > 0 or cardinality(source.self_reported_skills) > 0)
    ) as item(position, key, label, document_type, result_recorded, fields_complete)
  ), evidence as (
    select items.*,
      coalesce(fields_complete, false) or exists (
        select 1 from public.documents as document
        where document.organization_id = items.organization_id
          and document.applicant_id = items.id
          and document.document_type = items.document_type
          and document.status <> 'rejected'::public.document_status
      ) as complete,
      key in ('disc', 'enneagram', 'mbti') and exists (
        select 1 from public.documents as document
        where document.organization_id = items.organization_id
          and document.applicant_id = items.id
          and document.document_type = 'assessment'
          and document.status <> 'rejected'::public.document_status
      ) as unclassified_available
    from items
  )
  select coalesce(jsonb_agg(
    jsonb_build_object('key', key, 'label', label, 'state',
      case when complete then 'complete' when result_recorded then 'needs_review' else 'missing' end)
    || case when result_recorded is not null then jsonb_build_object(
      'resultRecorded', result_recorded,
      'evidenceState', case when complete then 'available' when unclassified_available then 'unclassified_available' else 'missing' end
    ) else '{}'::jsonb end
    || case when key = 'skills' then jsonb_build_object(
      'verifiedSkillsCount', verified_skills_count
    ) else '{}'::jsonb end
    order by position
  ), '[]'::jsonb) from evidence;
$$;
revoke all on function private.talent_review_checklist_json(uuid, uuid) from public, anon, authenticated;

commit;
