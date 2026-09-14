-- Read applicant-provided references through the existing authorized verification
-- flow. No reference outcome, contact attempt, or Bench Ready gate is changed.
begin;

alter function private.talent_verification_state_json(uuid, public.platform_role, uuid)
  rename to talent_verification_state_before_application_references;

create function private.talent_verification_state_json(
  p_organization_id uuid, p_viewer_role public.platform_role, p_applicant_id uuid
) returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, private as $$
declare v_state jsonb; v_application public.talent_applications%rowtype;
begin
  if p_viewer_role not in ('admin', 'talent_management') or p_viewer_role is null then
    raise exception using errcode = '42501', message = 'Reference details are private.';
  end if;
  -- Original function checks that this applicant belongs to this organization.
  v_state := private.talent_verification_state_before_application_references(
    p_organization_id, p_viewer_role, p_applicant_id);
  select * into v_application from public.talent_applications
    where organization_id = p_organization_id and applicant_id = p_applicant_id
      and source = 'native_application' and status = 'submitted'
    order by submitted_at desc, created_at desc, id desc limit 1;
  -- Never search backwards for nonempty references; a later blank submission
  -- must not revive details omitted by the applicant.
  return v_state || jsonb_build_object('applicationReferences', case
    when jsonb_typeof(v_application.raw_submission->'references') = 'array'
      then jsonb_build_object(
        'items', v_application.raw_submission->'references',
        'contactConsent', coalesce(v_application.raw_submission->'referenceContactConsent' = 'true'::jsonb, false),
        'submittedAt', v_application.submitted_at)
    else null end);
end;
$$;
revoke all on function private.talent_verification_state_json(uuid, public.platform_role, uuid),
  private.talent_verification_state_before_application_references(uuid, public.platform_role, uuid)
  from public, anon, authenticated;

commit;
