-- Soro Operations: secure, role-scoped global directory search and internal
-- Client profile reads. Browser callers never invoke these RPCs directly;
-- authenticated Netlify functions verify the bearer token, then call them
-- with the server-only service role and the verified actor id.

create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;

-- Quick typeahead searches use literal prefix matching for two-character
-- queries and literal substring matching for longer queries. These partial
-- trigram indexes keep active-record lookups responsive without indexing
-- archived directory records.
create index if not exists clients_active_company_name_trgm_idx
  on public.clients using gin (lower(company_name) extensions.gin_trgm_ops)
  where archived_at is null;

create index if not exists client_contacts_active_full_name_trgm_idx
  on public.client_contacts using gin (lower(full_name) extensions.gin_trgm_ops)
  where active = true;

create index if not exists client_contacts_active_email_trgm_idx
  on public.client_contacts using gin (lower(email) extensions.gin_trgm_ops)
  where active = true and email is not null;

create index if not exists client_contacts_active_phone_digits_trgm_idx
  on public.client_contacts using gin (
    regexp_replace(coalesce(phone, ''), '[^0-9]+', '', 'g') extensions.gin_trgm_ops
  )
  where active = true and phone is not null;

create index if not exists applicants_active_full_name_trgm_idx
  on public.applicants using gin (lower(full_name) extensions.gin_trgm_ops)
  where archived_at is null;

create index if not exists applicants_active_preferred_name_trgm_idx
  on public.applicants using gin (lower(preferred_name) extensions.gin_trgm_ops)
  where archived_at is null and preferred_name is not null;

create index if not exists applicants_active_email_trgm_idx
  on public.applicants using gin (lower(email) extensions.gin_trgm_ops)
  where archived_at is null;

create index if not exists applicants_active_phone_digits_trgm_idx
  on public.applicants using gin (
    regexp_replace(coalesce(phone, ''), '[^0-9]+', '', 'g') extensions.gin_trgm_ops
  )
  where archived_at is null and phone is not null;

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
    and client.archived_at is null;

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
      and lower(active_contact.contact_role) = 'primary'
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

create or replace function public.get_internal_talent_profile(
  p_actor_user_id uuid,
  p_applicant_id uuid
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
  v_applicant record;
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
    'talent_management'::public.platform_role,
    'sales_management'::public.platform_role,
    'sales'::public.platform_role
  ) then
    raise exception using
      errcode = '42501',
      message = 'Active Admin, Talent Management, or Sales access is required.';
  end if;

  if p_applicant_id is null then
    raise exception using errcode = '22023', message = 'Choose a valid Talent profile.';
  end if;

  select
    applicant.id,
    applicant.full_name,
    applicant.preferred_name,
    applicant.country,
    applicant.timezone,
    applicant.status,
    applicant.work_status,
    applicant.availability_note,
    applicant.application_received_at,
    applicant.expected_hourly_rate_text,
    applicant.verified_skills,
    applicant.self_reported_experience_areas,
    applicant.self_reported_skills,
    applicant.other_experience_specialty,
    applicant.relevant_experience_years,
    applicant.relevant_experience_summary,
    applicant.education_training_summary,
    applicant.english_test_result,
    applicant.personality_profile_score,
    applicant.computer_specs,
    applicant.internet_speed
  into v_applicant
  from public.applicants as applicant
  where applicant.id = p_applicant_id
    and applicant.organization_id = v_organization_id
    and applicant.archived_at is null;

  if not found then
    raise exception using errcode = 'P0002', message = 'The Talent profile was not found.';
  end if;

  return jsonb_build_object(
    'id', v_applicant.id,
    'full_name', v_applicant.full_name,
    'preferred_name', v_applicant.preferred_name,
    'country', v_applicant.country,
    'timezone', v_applicant.timezone,
    'status', v_applicant.status,
    'work_status', v_applicant.work_status,
    'availability_note', v_applicant.availability_note,
    'application_received_at', v_applicant.application_received_at,
    'expected_hourly_rate_text', v_applicant.expected_hourly_rate_text,
    'verified_skills', coalesce(v_applicant.verified_skills, '{}'::text[]),
    'self_reported_experience_areas', coalesce(v_applicant.self_reported_experience_areas, '{}'::text[]),
    'self_reported_skills', coalesce(v_applicant.self_reported_skills, '{}'::text[]),
    'other_experience_specialty', v_applicant.other_experience_specialty,
    'relevant_experience_years', v_applicant.relevant_experience_years,
    'relevant_experience_summary', v_applicant.relevant_experience_summary,
    'education_training_summary', v_applicant.education_training_summary,
    'english_test_result', v_applicant.english_test_result,
    'personality_profile_score', v_applicant.personality_profile_score,
    'computer_specs', v_applicant.computer_specs,
    'internet_speed', v_applicant.internet_speed
  );
end;
$$;

revoke all on function public.get_internal_talent_profile(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.get_internal_talent_profile(uuid, uuid)
  to service_role;

comment on function public.search_operations_directory(uuid, text) is
  'Service-only internal Client and Talent typeahead, scoped to the verified actor role and organization.';
comment on function public.get_internal_client_profile(uuid, uuid) is
  'Service-only internal Client profile projection, scoped to the verified actor organization.';
comment on function public.get_internal_talent_profile(uuid, uuid) is
  'Service-only read-only Talent matching profile projection, scoped to the verified actor role and organization.';
