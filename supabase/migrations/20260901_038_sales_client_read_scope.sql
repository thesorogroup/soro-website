-- Close the legacy Sales read-scope gap in the global directory and internal
-- Client profile projection. Ordinary Sales actors may read only active
-- Clients assigned to them; Admin, Sales Management, Talent Management, and
-- Billing keep their existing organization-wide Client reads. The Talent
-- branch and every returned payload key remain unchanged from migration 033.

create or replace function public.search_operations_directory(
  p_actor_user_id uuid,
  p_query text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_organization_id uuid;
  v_actor_role public.platform_role;
  v_query text;
  v_phone_query text;
  v_escaped_query text;
  v_prefix_pattern text;
  v_contains_pattern text;
  v_allow_contains boolean;
  v_clients jsonb := '[]'::jsonb;
  v_talent jsonb := '[]'::jsonb;
begin
  select access.organization_id, access.role
    into v_organization_id, v_actor_role
  from public.platform_users as access
  where access.id = p_actor_user_id
    and access.organization_id is not null
    and access.active = true
    and access.must_change_password = false
  limit 1;

  if not found or v_actor_role not in (
    'admin'::public.platform_role,
    'sales_management'::public.platform_role,
    'sales'::public.platform_role,
    'talent_management'::public.platform_role,
    'billing'::public.platform_role
  ) then
    raise exception using
      errcode = '42501',
      message = 'Active internal Soro access is required.';
  end if;

  if p_query is null or p_query ~ '[[:cntrl:]]' then
    raise exception using
      errcode = '22023',
      message = 'Search text must contain between 2 and 100 characters.';
  end if;

  v_query := lower(regexp_replace(btrim(p_query), '[[:space:]]+', ' ', 'g'));
  if char_length(v_query) < 2 or char_length(v_query) > 100 then
    raise exception using
      errcode = '22023',
      message = 'Search text must contain between 2 and 100 characters.';
  end if;

  -- Escape LIKE metacharacters so %, _, and backslash are always searched as
  -- literal user text rather than interpreted as query syntax.
  v_escaped_query := replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_');
  v_prefix_pattern := v_escaped_query || '%';
  v_contains_pattern := '%' || v_escaped_query || '%';
  v_allow_contains := char_length(v_query) >= 3;
  v_phone_query := regexp_replace(v_query, '[^0-9]+', '', 'g');

  with client_matches as (
    select
      client.id as client_id,
      client.company_name,
      client.industry,
      client.lifecycle_stage,
      null::text as matched_contact_name,
      case
        when lower(client.company_name) = v_query then 0
        when lower(client.company_name) like v_prefix_pattern escape '\' then 1
        else 3
      end as match_rank,
      'company_name'::text as matched_on
    from public.clients as client
    where client.organization_id = v_organization_id
      and client.archived_at is null
      and (
        v_actor_role <> 'sales'::public.platform_role
        or client.sales_owner_id = p_actor_user_id
      )
      and (
        lower(client.company_name) like v_prefix_pattern escape '\'
        or (
          v_allow_contains
          and lower(client.company_name) like v_contains_pattern escape '\'
        )
      )

    union all

    select
      client.id as client_id,
      client.company_name,
      client.industry,
      client.lifecycle_stage,
      contact.full_name as matched_contact_name,
      least(
        case
          when lower(contact.full_name) = v_query then 0
          when lower(contact.full_name) like v_prefix_pattern escape '\' then 1
          when v_allow_contains and lower(contact.full_name) like v_contains_pattern escape '\' then 3
          else 99
        end,
        case
          when lower(coalesce(contact.email, '')) = v_query then 0
          when lower(coalesce(contact.email, '')) like v_prefix_pattern escape '\' then 1
          when v_allow_contains and lower(coalesce(contact.email, '')) like v_contains_pattern escape '\' then 3
          else 99
        end,
        case
          when v_phone_query <> '' and regexp_replace(coalesce(contact.phone, ''), '[^0-9]+', '', 'g') = v_phone_query then 0
          when v_phone_query <> '' and regexp_replace(coalesce(contact.phone, ''), '[^0-9]+', '', 'g') like v_phone_query || '%' then 1
          when v_allow_contains and v_phone_query <> '' and regexp_replace(coalesce(contact.phone, ''), '[^0-9]+', '', 'g') like '%' || v_phone_query || '%' then 3
          else 99
        end
      ) as match_rank,
      case
        when lower(contact.full_name) = v_query
          or lower(contact.full_name) like v_prefix_pattern escape '\'
          or (v_allow_contains and lower(contact.full_name) like v_contains_pattern escape '\')
          then 'contact_name'
        when lower(coalesce(contact.email, '')) = v_query
          or lower(coalesce(contact.email, '')) like v_prefix_pattern escape '\'
          or (v_allow_contains and lower(coalesce(contact.email, '')) like v_contains_pattern escape '\')
          then 'contact_email'
        else 'contact_phone'
      end as matched_on
    from public.clients as client
    join public.client_contacts as contact on contact.client_id = client.id
    where client.organization_id = v_organization_id
      and client.archived_at is null
      and (
        v_actor_role <> 'sales'::public.platform_role
        or client.sales_owner_id = p_actor_user_id
      )
      and contact.active = true
      and (
        lower(contact.full_name) like v_prefix_pattern escape '\'
        or (v_allow_contains and lower(contact.full_name) like v_contains_pattern escape '\')
        or lower(coalesce(contact.email, '')) like v_prefix_pattern escape '\'
        or (v_allow_contains and lower(coalesce(contact.email, '')) like v_contains_pattern escape '\')
        or (
          v_phone_query <> ''
          and (
            regexp_replace(coalesce(contact.phone, ''), '[^0-9]+', '', 'g') like v_phone_query || '%'
            or (
              v_allow_contains
              and regexp_replace(coalesce(contact.phone, ''), '[^0-9]+', '', 'g') like '%' || v_phone_query || '%'
            )
          )
        )
      )
  ), deduplicated_clients as (
    select distinct on (client_id)
      client_id,
      company_name,
      industry,
      lifecycle_stage,
      matched_contact_name,
      match_rank,
      matched_on
    from client_matches
    order by client_id, match_rank, lower(coalesce(matched_contact_name, company_name)), matched_on
  ), limited_clients as (
    select *
    from deduplicated_clients
    order by match_rank, lower(company_name), client_id
    limit 5
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'entityType', 'client',
        'recordId', client_id,
        'primaryLabel', company_name,
        'secondaryLabel', case
          when matched_contact_name is not null then 'Contact: ' || matched_contact_name
          else nullif(btrim(industry), '')
        end,
        'statusLabel', lifecycle_stage,
        'matchedOn', matched_on
      )
      order by match_rank, lower(company_name), client_id
    ),
    '[]'::jsonb
  ) into v_clients
  from limited_clients;

  if v_actor_role in (
    'admin'::public.platform_role,
    'talent_management'::public.platform_role,
    'sales_management'::public.platform_role,
    'sales'::public.platform_role
  ) then
    with talent_matches as (
      select
        applicant.id as applicant_id,
        applicant.full_name,
        applicant.preferred_name,
        applicant.status,
        least(
          case
            when lower(applicant.full_name) = v_query then 0
            when lower(applicant.full_name) like v_prefix_pattern escape '\' then 1
            when v_allow_contains and lower(applicant.full_name) like v_contains_pattern escape '\' then 3
            else 99
          end,
          case
            when lower(coalesce(applicant.preferred_name, '')) = v_query then 0
            when lower(coalesce(applicant.preferred_name, '')) like v_prefix_pattern escape '\' then 1
            when v_allow_contains and lower(coalesce(applicant.preferred_name, '')) like v_contains_pattern escape '\' then 3
            else 99
          end,
          case
            when lower(applicant.email) = v_query then 0
            when lower(applicant.email) like v_prefix_pattern escape '\' then 1
            when v_allow_contains and lower(applicant.email) like v_contains_pattern escape '\' then 3
            else 99
          end,
          case
            when v_phone_query <> '' and regexp_replace(coalesce(applicant.phone, ''), '[^0-9]+', '', 'g') = v_phone_query then 0
            when v_phone_query <> '' and regexp_replace(coalesce(applicant.phone, ''), '[^0-9]+', '', 'g') like v_phone_query || '%' then 1
            when v_allow_contains and v_phone_query <> '' and regexp_replace(coalesce(applicant.phone, ''), '[^0-9]+', '', 'g') like '%' || v_phone_query || '%' then 3
            else 99
          end
        ) as match_rank,
        case
          when lower(applicant.full_name) = v_query
            or lower(applicant.full_name) like v_prefix_pattern escape '\'
            or (v_allow_contains and lower(applicant.full_name) like v_contains_pattern escape '\')
            then 'name'
          when lower(coalesce(applicant.preferred_name, '')) = v_query
            or lower(coalesce(applicant.preferred_name, '')) like v_prefix_pattern escape '\'
            or (v_allow_contains and lower(coalesce(applicant.preferred_name, '')) like v_contains_pattern escape '\')
            then 'preferred_name'
          when lower(applicant.email) = v_query
            or lower(applicant.email) like v_prefix_pattern escape '\'
            or (v_allow_contains and lower(applicant.email) like v_contains_pattern escape '\')
            then 'email'
          else 'phone'
        end as matched_on
      from public.applicants as applicant
      where applicant.organization_id = v_organization_id
        and applicant.archived_at is null
        and (
          lower(applicant.full_name) like v_prefix_pattern escape '\'
          or (v_allow_contains and lower(applicant.full_name) like v_contains_pattern escape '\')
          or lower(coalesce(applicant.preferred_name, '')) like v_prefix_pattern escape '\'
          or (v_allow_contains and lower(coalesce(applicant.preferred_name, '')) like v_contains_pattern escape '\')
          or lower(applicant.email) like v_prefix_pattern escape '\'
          or (v_allow_contains and lower(applicant.email) like v_contains_pattern escape '\')
          or (
            v_phone_query <> ''
            and (
              regexp_replace(coalesce(applicant.phone, ''), '[^0-9]+', '', 'g') like v_phone_query || '%'
              or (
                v_allow_contains
                and regexp_replace(coalesce(applicant.phone, ''), '[^0-9]+', '', 'g') like '%' || v_phone_query || '%'
              )
            )
          )
        )
      order by match_rank, lower(applicant.full_name), applicant.id
      limit 5
    )
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'entityType', 'talent',
          'recordId', applicant_id,
          'primaryLabel', full_name,
          'secondaryLabel', case
            when nullif(btrim(preferred_name), '') is not null
              then 'Goes by ' || btrim(preferred_name)
            else null
          end,
          'statusLabel', status,
          'matchedOn', matched_on
        )
        order by match_rank, lower(full_name), applicant_id
      ),
      '[]'::jsonb
    ) into v_talent
    from talent_matches;
  end if;

  return jsonb_build_object(
    'query', v_query,
    'clients', v_clients,
    'talent', v_talent
  );
end;
$$;

revoke all on function public.search_operations_directory(uuid, text)
  from public, anon, authenticated;
grant execute on function public.search_operations_directory(uuid, text)
  to service_role;

create or replace function public.get_internal_client_profile(
  p_actor_user_id uuid,
  p_client_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_organization_id uuid;
  v_actor_role public.platform_role;
  v_client public.clients%rowtype;
  v_contacts jsonb;
begin
  select access.organization_id, access.role
    into v_organization_id, v_actor_role
  from public.platform_users as access
  where access.id = p_actor_user_id
    and access.organization_id is not null
    and access.active = true
    and access.must_change_password = false
  limit 1;

  if not found or v_actor_role not in (
    'admin'::public.platform_role,
    'sales_management'::public.platform_role,
    'sales'::public.platform_role,
    'talent_management'::public.platform_role,
    'billing'::public.platform_role
  ) then
    raise exception using
      errcode = '42501',
      message = 'Active internal Soro access is required.';
  end if;

  if p_client_id is null then
    raise exception using errcode = '22023', message = 'Choose a valid Client profile.';
  end if;

  select client.*
    into v_client
  from public.clients as client
  where client.id = p_client_id
    and client.organization_id = v_organization_id
    and client.archived_at is null
    and (
      v_actor_role <> 'sales'::public.platform_role
      or client.sales_owner_id = p_actor_user_id
    );

  if not found then
    raise exception using errcode = 'P0002', message = 'The Client profile was not found.';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'contactId', contact.id,
        'fullName', contact.full_name,
        'email', contact.email,
        'phone', contact.phone,
        'contactRole', contact.contact_role
      )
    ),
    '[]'::jsonb
  ) into v_contacts
  from (
    select active_contact.*
    from public.client_contacts as active_contact
    where active_contact.client_id = v_client.id
      and active_contact.active = true
      and active_contact.is_primary = true
    order by
      lower(active_contact.full_name),
      active_contact.id
    limit 1
  ) as contact;

  return jsonb_build_object(
    'clientId', v_client.id,
    'companyName', v_client.company_name,
    'industry', v_client.industry,
    'lifecycleStage', v_client.lifecycle_stage,
    'company', jsonb_build_object(
      'addressLine1', v_client.address_line_1,
      'addressLine2', v_client.address_line_2,
      'city', v_client.city,
      'stateRegion', v_client.state_region,
      'postalCode', v_client.postal_code,
      'country', v_client.country,
      'phone', v_client.company_phone,
      'website', v_client.website
    ),
    'contacts', v_contacts
  );
end;
$$;

revoke all on function public.get_internal_client_profile(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.get_internal_client_profile(uuid, uuid)
  to service_role;

-- Raw Client-lifecycle audit rows can contain contact, access, interview, and
-- placement details that are broader than each workflow's safe projection.
-- Keep direct audit oversight with Admin and Sales Management; ordinary Sales
-- and Talent Management consume the owner/role-scoped service RPCs instead.
-- Preserve every narrower legacy audit category installed by migration 035.
drop policy if exists "authorized internal users can read audit history" on public.audit_events;
create policy "authorized internal users can read audit history"
on public.audit_events for select to authenticated
using (
  private.is_internal_soro_user()
  and organization_id = private.current_soro_organization_id()
  and case
    when entity_type = 'employee_payroll' then
      private.current_soro_role() = 'admin'::public.platform_role
    when entity_type = 'employee' and event_type = 'employee_payment_route_update' then
      private.current_soro_role() = 'admin'::public.platform_role
    when entity_type in ('client_shortlist', 'client_shortlist_item') then
      private.current_soro_role() in (
        'admin'::public.platform_role,
        'sales_management'::public.platform_role
      )
    when entity_type in (
      'talent_payout',
      'talent_portal_access',
      'talent_attendance',
      'talent_time_off',
      'talent_review_queue',
      'talent_verification',
      'available_talent_bench',
      'available_talent_bench_settings'
    ) then
      private.current_soro_role() in (
        'admin'::public.platform_role,
        'talent_management'::public.platform_role
      )
    when entity_type in (
      'client',
      'client_contact',
      'hiring_request',
      'client_portal_access',
      'client_candidate_interview',
      'client_candidate_decision',
      'client_placement_handoff',
      'placement_onboarding_item',
      'placement'
    ) then
      private.current_soro_role() in (
        'admin'::public.platform_role,
        'sales_management'::public.platform_role
      )
    else true
  end
);

comment on function public.search_operations_directory(uuid, text) is
  'Service-only internal Client and Talent typeahead. Sales Client results are limited to Clients assigned to the verified actor; other allowed internal roles remain organization-scoped.';
comment on function public.get_internal_client_profile(uuid, uuid) is
  'Service-only internal Client profile projection. Sales reads are limited to Clients assigned to the verified actor; other allowed internal roles remain organization-scoped.';
