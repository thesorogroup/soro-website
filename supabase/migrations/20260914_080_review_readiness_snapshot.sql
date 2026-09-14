-- Return all Bench Ready requirements with the existing queue request.
-- Read-only presentation change: no eligibility rules or applicant data change.
begin;

alter function private.talent_review_queue_json(uuid, public.platform_role)
  rename to talent_review_queue_before_readiness;

create function private.talent_review_queue_json(p_organization_id uuid, p_viewer_role public.platform_role)
returns jsonb language sql security definer
set search_path = pg_catalog, public, private as $$
  with source as (
    select private.talent_review_queue_before_readiness(p_organization_id, p_viewer_role) payload
  )
  select jsonb_set(payload, '{applicants}', coalesce((
    select jsonb_agg(applicant || jsonb_build_object('hasNativeSubmission', exists (
      select 1 from public.talent_applications application
      where application.organization_id = p_organization_id
        and application.applicant_id = (applicant->>'applicantId')::uuid
        and application.source = 'native_application' and application.status = 'submitted'
    ), 'readiness', (
      select jsonb_agg(jsonb_build_object(
        'key', item->>'key',
        'status', case when item->>'state' = 'complete' then 'complete'
          when exists (select 1 from private.talent_review_deferrals d
            where d.organization_id = p_organization_id
              and d.applicant_id = (applicant->>'applicantId')::uuid
              and d.item_key = item->>'key' and d.active) then 'deferred'
          else 'pending' end
      ) order by item_order)
      from jsonb_array_elements(private.talent_review_source_items_json(
        (applicant->>'applicantId')::uuid, p_organization_id
      )) with ordinality requirements(item, item_order)
    )) order by applicant_order)
    from jsonb_array_elements(payload->'applicants') with ordinality rows(applicant, applicant_order)
  ), '[]'::jsonb)) from source;
$$;

revoke all on function private.talent_review_queue_json(uuid, public.platform_role),
  private.talent_review_queue_before_readiness(uuid, public.platform_role)
  from public, anon, authenticated;

commit;
