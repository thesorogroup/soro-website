-- Soro Operations: Available Talent Bench and atomic Sales claim queue.
--
-- The applicant status and applicants.sales_owner_id remain the workflow
-- sources of truth. Browser callers never choose an organization or role;
-- authenticated Netlify functions verify the bearer token and these RPCs
-- derive all authorization and organization scope from the actor record.

create table if not exists public.available_talent_bench_settings (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  sales_owner_id uuid not null references public.platform_users(id) on delete cascade,
  sales_caseload_limit integer not null default 40
    check (sales_caseload_limit between 1 and 500),
  updated_by_user_id uuid references public.platform_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, sales_owner_id)
);

alter table public.available_talent_bench_settings enable row level security;
revoke all on table public.available_talent_bench_settings from public, anon, authenticated;
grant select, insert, update on table public.available_talent_bench_settings to service_role;

drop trigger if exists available_talent_bench_settings_updated_at
on public.available_talent_bench_settings;
create trigger available_talent_bench_settings_updated_at
before update on public.available_talent_bench_settings
for each row execute function public.set_updated_at();

create table if not exists public.available_talent_bench_operations (
  operation_request_id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  actor_user_id uuid not null references public.platform_users(id) on delete restrict,
  applicant_id uuid references public.applicants(id) on delete cascade,
  target_sales_owner_id uuid references public.platform_users(id) on delete set null,
  action text not null check (action in (
    'claim', 'assign', 'reassign', 'release', 'set_limit'
  )),
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  check (
    (action = 'set_limit' and applicant_id is null and target_sales_owner_id is not null)
    or (action <> 'set_limit' and applicant_id is not null)
  )
);

create index if not exists available_talent_bench_operations_applicant_idx
  on public.available_talent_bench_operations (applicant_id, created_at desc)
  where applicant_id is not null;

create index if not exists applicants_active_sales_caseload_idx
  on public.applicants (organization_id, sales_owner_id, status)
  where archived_at is null
    and sales_owner_id is not null
    and status in (
      'bench_ready'::public.applicant_status,
      'shortlisted'::public.applicant_status,
      'interviewing'::public.applicant_status,
      'client_review'::public.applicant_status
    );

alter table public.available_talent_bench_operations enable row level security;
revoke all on table public.available_talent_bench_operations from public, anon, authenticated;
grant select, insert on table public.available_talent_bench_operations to service_role;

create or replace function private.available_talent_bench_actor(p_actor_user_id uuid)
returns table (
  id uuid,
  organization_id uuid,
  role public.platform_role,
  display_name text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
begin
  if p_actor_user_id is null then
    raise exception using errcode = '22023', message = 'A signed-in account is required.';
  end if;

  return query
  select
    access.id,
    access.organization_id,
    access.role,
    coalesce(nullif(btrim(access.display_name), ''), 'Soro team member')
  from public.platform_users as access
  where access.id = p_actor_user_id
    and access.organization_id is not null
    and access.active = true
    and access.must_change_password = false
    and access.role in (
      'admin'::public.platform_role,
      'talent_management'::public.platform_role,
      'sales_management'::public.platform_role,
      'sales'::public.platform_role
    )
  limit 1;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'Active Admin, Talent Management, or Sales access is required.';
  end if;
end;
$$;

revoke all on function private.available_talent_bench_actor(uuid)
  from public, anon, authenticated;

create or replace function private.available_talent_bench_json(
  p_organization_id uuid,
  p_viewer_role public.platform_role,
  p_actor_user_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  with defaults as (
    select 40::integer as caseload_limit
  ), active_claims as (
    select
      applicant.sales_owner_id,
      count(*)::integer as claimed
    from public.applicants as applicant
    where applicant.organization_id = p_organization_id
      and applicant.archived_at is null
      and applicant.sales_owner_id is not null
      and applicant.status in (
        'bench_ready'::public.applicant_status,
        'shortlisted'::public.applicant_status,
        'interviewing'::public.applicant_status,
        'client_review'::public.applicant_status
    )
    group by applicant.sales_owner_id
  ), actor_limit as (
    select coalesce(
      (
        select configured.sales_caseload_limit
        from public.available_talent_bench_settings as configured
        where configured.organization_id = p_organization_id
          and configured.sales_owner_id = p_actor_user_id
      ),
      defaults.caseload_limit
    )::integer as capacity
    from defaults
  ), sales_people as (
    select
      access.id,
      coalesce(nullif(btrim(access.display_name), ''), 'Sales team member') as name,
      coalesce(load.claimed, 0)::integer as claimed,
      coalesce(configured.sales_caseload_limit, defaults.caseload_limit)::integer as capacity
    from public.platform_users as access
    cross join defaults
    left join active_claims as load on load.sales_owner_id = access.id
    left join public.available_talent_bench_settings as configured
      on configured.organization_id = access.organization_id
     and configured.sales_owner_id = access.id
    where access.organization_id = p_organization_id
      and access.active = true
      and access.must_change_password = false
      and access.role = 'sales'::public.platform_role
  ), scoped as (
    select
      applicant.id,
      applicant.full_name,
      nullif(btrim(applicant.preferred_name), '') as preferred_name,
      applicant.status,
      coalesce(applicant.self_reported_experience_areas, '{}'::text[]) as va_types,
      coalesce(applicant.verified_skills, '{}'::text[]) as verified_skills,
      nullif(btrim(applicant.availability_note), '') as availability,
      applicant.expected_hourly_rate,
      applicant.expected_hourly_rate_max,
      nullif(btrim(applicant.expected_hourly_rate_text), '') as rate_label,
      applicant.relevant_experience_years,
      applicant.sales_owner_id,
      coalesce(nullif(btrim(owner.display_name), ''), 'Unassigned') as owner_name,
      applicant.updated_at,
      coalesce(actor_load.claimed, 0)::integer as actor_claimed,
      actor_limit.capacity as actor_capacity
    from public.applicants as applicant
    cross join actor_limit
    left join public.platform_users as owner
      on owner.id = applicant.sales_owner_id
     and owner.organization_id = applicant.organization_id
    left join active_claims as actor_load
      on actor_load.sales_owner_id = p_actor_user_id
    where applicant.organization_id = p_organization_id
      and applicant.archived_at is null
      and applicant.status in (
        'bench_ready'::public.applicant_status,
        'shortlisted'::public.applicant_status,
        'interviewing'::public.applicant_status,
        'client_review'::public.applicant_status
      )
  ), item_rows as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'applicantId', applicant.id,
          'fullName', applicant.full_name,
          'preferredName', applicant.preferred_name,
          'stage', applicant.status::text,
          'vaTypes', to_jsonb(applicant.va_types),
          'verifiedSkills', to_jsonb(applicant.verified_skills),
          'availability', applicant.availability,
          'rateMin', applicant.expected_hourly_rate,
          'rateMax', applicant.expected_hourly_rate_max,
          'rateLabel', applicant.rate_label,
          'yearsExperience', applicant.relevant_experience_years,
          'owner', jsonb_build_object(
            'id', applicant.sales_owner_id,
            'name', applicant.owner_name
          ),
          'updatedAt', applicant.updated_at,
          'allowedActions', case
            when p_viewer_role in (
              'admin'::public.platform_role,
              'talent_management'::public.platform_role
            ) then case
              when applicant.sales_owner_id is null then jsonb_build_array('assign')
              else jsonb_build_array('reassign', 'release')
            end
            when p_viewer_role = 'sales'::public.platform_role then case
              when applicant.sales_owner_id = p_actor_user_id
                and applicant.status = 'bench_ready'::public.applicant_status
                then jsonb_build_array('release')
              when applicant.sales_owner_id is null
                and applicant.status = 'bench_ready'::public.applicant_status
                and applicant.actor_claimed < applicant.actor_capacity
                then jsonb_build_array('claim')
              else '[]'::jsonb
            end
            else '[]'::jsonb
          end
        )
        order by
          case applicant.status
            when 'bench_ready'::public.applicant_status then 1
            when 'shortlisted'::public.applicant_status then 2
            when 'interviewing'::public.applicant_status then 3
            when 'client_review'::public.applicant_status then 4
            else 5
          end,
          lower(applicant.full_name),
          applicant.id
      ),
      '[]'::jsonb
    ) as items
    from scoped as applicant
  ), sales_owner_rows as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', sales.id,
          'name', sales.name,
          'claimed', sales.claimed,
          'capacity', sales.capacity,
          'available', sales.claimed < sales.capacity
        ) order by lower(sales.name), sales.id
      ),
      '[]'::jsonb
    ) as owners
    from sales_people as sales
  ), team_capacity as (
    select coalesce(sum(sales.capacity), 0)::integer as capacity
    from sales_people as sales
  ), va_type_filter as (
    select coalesce(jsonb_agg(value order by lower(value)), '[]'::jsonb) as values
    from (
      select distinct btrim(raw.value) as value
      from scoped as applicant
      cross join lateral unnest(applicant.va_types) as raw(value)
      where nullif(btrim(raw.value), '') is not null
    ) as unique_values
  ), skill_filter as (
    select coalesce(jsonb_agg(value order by lower(value)), '[]'::jsonb) as values
    from (
      select distinct btrim(raw.value) as value
      from scoped as applicant
      cross join lateral unnest(applicant.verified_skills) as raw(value)
      where nullif(btrim(raw.value), '') is not null
    ) as unique_values
  ), availability_filter as (
    select coalesce(jsonb_agg(value order by lower(value)), '[]'::jsonb) as values
    from (
      select distinct applicant.availability as value
      from scoped as applicant
      where applicant.availability is not null
    ) as unique_values
  ), queue_counts as (
    select
      count(*) filter (where sales_owner_id is not null)::integer as team_claimed,
      count(*) filter (where sales_owner_id = p_actor_user_id)::integer as actor_claimed
    from scoped
  )
  select jsonb_build_object(
    'generatedAt', pg_catalog.clock_timestamp(),
    'viewerRole', p_viewer_role::text,
    'caseload', jsonb_build_object(
      'claimed', case
        when p_viewer_role = 'sales'::public.platform_role
          then coalesce(queue_counts.actor_claimed, 0)
        else coalesce(queue_counts.team_claimed, 0)
      end,
      'capacity', case
        when p_viewer_role = 'sales'::public.platform_role
          then actor_limit.capacity
        else team_capacity.capacity
      end
    ),
    'salesOwners', sales_owner_rows.owners,
    'filters', jsonb_build_object(
      'vaTypes', va_type_filter.values,
      'verifiedSkills', skill_filter.values,
      'availabilityOptions', availability_filter.values
    ),
    'items', item_rows.items
  )
  from item_rows
  cross join sales_owner_rows
  cross join team_capacity
  cross join va_type_filter
  cross join skill_filter
  cross join availability_filter
  cross join queue_counts
  cross join actor_limit;
$$;

revoke all on function private.available_talent_bench_json(uuid, public.platform_role, uuid)
  from public, anon, authenticated;

create or replace function public.get_available_talent_bench(p_actor_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_actor record;
begin
  select * into v_actor from private.available_talent_bench_actor(p_actor_user_id);
  return private.available_talent_bench_json(
    v_actor.organization_id,
    v_actor.role,
    v_actor.id
  );
end;
$$;

revoke all on function public.get_available_talent_bench(uuid)
  from public, anon, authenticated;
grant execute on function public.get_available_talent_bench(uuid)
  to service_role;

create or replace function public.change_available_talent_bench(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_applicant_id uuid,
  p_expected_updated_at timestamptz,
  p_action text,
  p_target_sales_owner_id uuid,
  p_caseload_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $$
declare
  v_actor record;
  v_action text := lower(btrim(p_action));
  v_fingerprint text;
  v_operation public.available_talent_bench_operations%rowtype;
  v_before public.applicants%rowtype;
  v_after public.applicants%rowtype;
  v_target_owner record;
  v_target_owner_id uuid;
  v_limit integer;
  v_claimed integer;
  v_previous_limit integer;
begin
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'A request id is required.';
  end if;
  if v_action is null or v_action not in (
    'claim', 'assign', 'reassign', 'release', 'set_limit'
  ) then
    raise exception using errcode = '22023', message = 'Unsupported Talent bench action.';
  end if;

  select * into v_actor from private.available_talent_bench_actor(p_actor_user_id);

  if v_action = 'set_limit' then
    if v_actor.role <> 'admin'::public.platform_role then
      raise exception using errcode = '42501', message = 'Only an Administrator can change the Sales caseload limit.';
    end if;
    if p_applicant_id is not null or p_expected_updated_at is not null or p_target_sales_owner_id is null
      or p_caseload_limit is null or p_caseload_limit < 1 or p_caseload_limit > 500 then
      raise exception using errcode = '22023', message = 'Choose a Sales caseload limit between 1 and 500.';
    end if;
  else
    if p_applicant_id is null or p_expected_updated_at is null or p_caseload_limit is not null then
      raise exception using errcode = '22023', message = 'Talent application and current update time are required.';
    end if;
    if v_action in ('assign', 'reassign') and p_target_sales_owner_id is null then
      raise exception using errcode = '22023', message = 'Choose an active Sales owner.';
    end if;
    if v_action in ('claim', 'release') and p_target_sales_owner_id is not null then
      raise exception using errcode = '22023', message = 'This action does not accept a selected Sales owner.';
    end if;
  end if;

  v_fingerprint := encode(
    digest(
      concat_ws(
        '|',
        v_action,
        coalesce(p_applicant_id::text, ''),
        coalesce(p_expected_updated_at::text, ''),
        coalesce(p_target_sales_owner_id::text, ''),
        coalesce(p_caseload_limit::text, '')
      ),
      'sha256'
    ),
    'hex'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('available-talent-operation:' || p_request_id::text, 0)
  );

  select operation.* into v_operation
  from public.available_talent_bench_operations as operation
  where operation.operation_request_id = p_request_id;

  if v_operation.operation_request_id is not null then
    if v_operation.organization_id is distinct from v_actor.organization_id
      or v_operation.actor_user_id is distinct from p_actor_user_id
      or v_operation.applicant_id is distinct from p_applicant_id
      or v_operation.target_sales_owner_id is distinct from p_target_sales_owner_id
      or v_operation.action <> v_action
      or v_operation.request_fingerprint <> v_fingerprint then
      raise exception using errcode = '22023', message = 'This request id has already been used for another Talent bench action.';
    end if;
    return private.available_talent_bench_json(
      v_actor.organization_id,
      v_actor.role,
      v_actor.id
    );
  end if;

  if v_action = 'set_limit' then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'available-talent-owner:' || v_actor.organization_id::text || ':' || p_target_sales_owner_id::text,
        0
      )
    );

    select
      access.id,
      access.organization_id,
      access.role,
      access.active,
      access.must_change_password
    into v_target_owner
    from public.platform_users as access
    where access.id = p_target_sales_owner_id
      and access.organization_id = v_actor.organization_id
      and access.active = true
      and access.must_change_password = false
      and access.role = 'sales'::public.platform_role;

    if v_target_owner.id is null then
      raise exception using errcode = '22023', message = 'Choose an active Sales owner in this organization.';
    end if;

    select coalesce(
      (
        select settings.sales_caseload_limit
        from public.available_talent_bench_settings as settings
        where settings.organization_id = v_actor.organization_id
          and settings.sales_owner_id = p_target_sales_owner_id
      ),
      40
    ) into v_previous_limit;

    insert into public.available_talent_bench_settings (
      organization_id,
      sales_owner_id,
      sales_caseload_limit,
      updated_by_user_id
    ) values (
      v_actor.organization_id,
      p_target_sales_owner_id,
      p_caseload_limit,
      v_actor.id
    )
    on conflict (organization_id, sales_owner_id) do update
      set sales_caseload_limit = excluded.sales_caseload_limit,
          updated_by_user_id = excluded.updated_by_user_id;

    insert into public.available_talent_bench_operations (
      operation_request_id,
      organization_id,
      actor_user_id,
      applicant_id,
      target_sales_owner_id,
      action,
      request_fingerprint
    ) values (
      p_request_id,
      v_actor.organization_id,
      v_actor.id,
      null,
      p_target_sales_owner_id,
      v_action,
      v_fingerprint
    );

    insert into public.audit_events (
      organization_id,
      actor_user_id,
      entity_type,
      entity_id,
      event_type,
      before_value,
      after_value,
      note
    ) values (
      v_actor.organization_id,
      v_actor.id,
      'available_talent_bench_settings',
      p_target_sales_owner_id,
      'set_limit',
      jsonb_build_object('salesCaseloadLimit', v_previous_limit),
      jsonb_build_object('salesCaseloadLimit', p_caseload_limit),
      null
    );

    return private.available_talent_bench_json(
      v_actor.organization_id,
      v_actor.role,
      v_actor.id
    );
  end if;

  select applicant.* into v_before
  from public.applicants as applicant
  where applicant.id = p_applicant_id
    and applicant.organization_id = v_actor.organization_id
  for update;

  if v_before.id is null then
    raise exception using errcode = '42501', message = 'This Talent profile is not available to your account.';
  end if;
  if v_before.updated_at is distinct from p_expected_updated_at then
    raise exception using errcode = 'P0001', message = 'This Talent profile changed after it was opened.';
  end if;
  if v_before.archived_at is not null or v_before.status not in (
    'bench_ready'::public.applicant_status,
    'shortlisted'::public.applicant_status,
    'interviewing'::public.applicant_status,
    'client_review'::public.applicant_status
  ) then
    raise exception using errcode = 'P0001', message = 'This Talent profile is no longer in the active Sales claim workflow.';
  end if;

  if v_action = 'claim' then
    if v_actor.role not in ('sales'::public.platform_role) then
      raise exception using errcode = '42501', message = 'Only Sales can claim an available Talent profile.';
    end if;
    if v_before.status <> 'bench_ready'::public.applicant_status or v_before.sales_owner_id is not null then
      raise exception using errcode = 'P0001', message = 'This Talent profile is already claimed or is no longer Bench Ready.';
    end if;
    v_target_owner_id := v_actor.id;

  elsif v_action = 'assign' then
    if v_actor.role not in (
      'admin'::public.platform_role,
      'talent_management'::public.platform_role
    ) then
      raise exception using errcode = '42501', message = 'Only Admin or Talent Management can assign Talent profiles.';
    end if;
    if v_before.sales_owner_id is not null then
      raise exception using errcode = 'P0001', message = 'This Talent profile is already assigned. Use reassign instead.';
    end if;
    v_target_owner_id := p_target_sales_owner_id;

  elsif v_action = 'reassign' then
    if v_actor.role not in (
      'admin'::public.platform_role,
      'talent_management'::public.platform_role
    ) then
      raise exception using errcode = '42501', message = 'Only Admin or Talent Management can reassign Talent profiles.';
    end if;
    if v_before.sales_owner_id is null then
      raise exception using errcode = 'P0001', message = 'This Talent profile is not assigned. Use assign instead.';
    end if;
    if v_before.sales_owner_id = p_target_sales_owner_id then
      raise exception using errcode = 'P0001', message = 'Choose a different Sales owner.';
    end if;
    v_target_owner_id := p_target_sales_owner_id;

  elsif v_action = 'release' then
    if v_before.sales_owner_id is null then
      raise exception using errcode = 'P0001', message = 'This Talent profile is not currently claimed.';
    end if;
    if v_actor.role = 'sales'::public.platform_role then
      if v_before.sales_owner_id <> v_actor.id then
        raise exception using errcode = '42501', message = 'Sales can release only their own Talent claims.';
      end if;
      if v_before.status <> 'bench_ready'::public.applicant_status then
        raise exception using errcode = '42501', message = 'After shortlisting, only Admin or Talent Management can release a Talent claim.';
      end if;
    end if;
    if v_actor.role not in (
      'admin'::public.platform_role,
      'talent_management'::public.platform_role,
      'sales'::public.platform_role
    ) then
      raise exception using errcode = '42501', message = 'This Talent claim cannot be released by your account.';
    end if;
    v_target_owner_id := null;
  end if;

  if v_target_owner_id is not null then
    select
      access.id,
      access.organization_id,
      access.role,
      access.active,
      access.must_change_password
    into v_target_owner
    from public.platform_users as access
    where access.id = v_target_owner_id
      and access.organization_id = v_actor.organization_id
      and access.active = true
      and access.must_change_password = false
      and access.role = 'sales'::public.platform_role;

    if v_target_owner.id is null then
      raise exception using errcode = '22023', message = 'Choose an active Sales owner in this organization.';
    end if;

    -- The per-owner advisory lock serializes claims of different Talent rows.
    -- The applicant row lock above separately prevents two owners from
    -- claiming the same Talent profile.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'available-talent-owner:' || v_actor.organization_id::text || ':' || v_target_owner_id::text,
        0
      )
    );

    select coalesce(
      (
        select settings.sales_caseload_limit
        from public.available_talent_bench_settings as settings
        where settings.organization_id = v_actor.organization_id
          and settings.sales_owner_id = v_target_owner_id
      ),
      40
    ) into v_limit;

    select count(*)::integer into v_claimed
    from public.applicants as claimed
    where claimed.organization_id = v_actor.organization_id
      and claimed.archived_at is null
      and claimed.sales_owner_id = v_target_owner_id
      and claimed.id <> v_before.id
      and claimed.status in (
        'bench_ready'::public.applicant_status,
        'shortlisted'::public.applicant_status,
        'interviewing'::public.applicant_status,
        'client_review'::public.applicant_status
      );

    if v_claimed >= v_limit then
      raise exception using errcode = 'P0001', message = 'The selected Sales owner has reached the active Talent caseload limit.';
    end if;
  end if;

  update public.applicants
  set sales_owner_id = v_target_owner_id
  where id = v_before.id
  returning * into v_after;

  insert into public.available_talent_bench_operations (
    operation_request_id,
    organization_id,
    actor_user_id,
    applicant_id,
    target_sales_owner_id,
    action,
    request_fingerprint
  ) values (
    p_request_id,
    v_actor.organization_id,
    v_actor.id,
    v_before.id,
    v_target_owner_id,
    v_action,
    v_fingerprint
  );

  insert into public.audit_events (
    organization_id,
    actor_user_id,
    entity_type,
    entity_id,
    event_type,
    before_value,
    after_value,
    note
  ) values (
    v_actor.organization_id,
    v_actor.id,
    'available_talent_bench',
    v_before.id,
    v_action,
    jsonb_build_object(
      'status', v_before.status::text,
      'salesOwnerId', v_before.sales_owner_id
    ),
    jsonb_build_object(
      'status', v_after.status::text,
      'salesOwnerId', v_after.sales_owner_id
    ),
    null
  );

  return private.available_talent_bench_json(
    v_actor.organization_id,
    v_actor.role,
    v_actor.id
  );
end;
$$;

revoke all on function public.change_available_talent_bench(
  uuid, uuid, uuid, timestamptz, text, uuid, integer
) from public, anon, authenticated;
grant execute on function public.change_available_talent_bench(
  uuid, uuid, uuid, timestamptz, text, uuid, integer
) to service_role;

-- Prevent authenticated browser code from bypassing the atomic claim service.
-- Service-role calls have no auth.uid(), so the audited RPC above can update
-- sales_owner_id while ordinary profile edits remain unaffected.
create or replace function private.protect_applicant_review_fields()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is not null
    and (
      new.status is distinct from old.status
      or new.status_reason is distinct from old.status_reason
      or new.archived_at is distinct from old.archived_at
      or new.talent_review_owner_id is distinct from old.talent_review_owner_id
      or new.sales_owner_id is distinct from old.sales_owner_id
    ) then
    raise exception using
      errcode = '42501',
      message = 'Talent workflow ownership can be changed only through the secure workflow service.';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_applicant_review_fields on public.applicants;
create trigger protect_applicant_review_fields
before update of status, status_reason, archived_at, talent_review_owner_id, sales_owner_id
on public.applicants
for each row execute function private.protect_applicant_review_fields();

-- Claim history contains internal ownership decisions. Keep it organization
-- scoped and visible only to Admin and Talent Management, while preserving all
-- earlier audit restrictions.
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
    else true
  end
);

comment on table public.available_talent_bench_settings is
  'Service-only per-Sales-employee active Talent caseload setting, defaulting to 40 when no override exists.';
comment on table public.available_talent_bench_operations is
  'Service-only idempotency ledger for atomic Talent claim, assignment, reassignment, release, and caseload-limit actions.';
comment on function public.get_available_talent_bench(uuid) is
  'Service-only safe Talent matching projection scoped from the active internal actor organization.';
comment on function public.change_available_talent_bench(uuid, uuid, uuid, timestamptz, text, uuid, integer) is
  'Service-only atomic and audited Talent claim workflow with per-Sales caseload enforcement.';
