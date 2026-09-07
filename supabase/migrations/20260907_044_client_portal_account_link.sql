-- Soro Operations: server-only Client account linking and failed-setup cleanup.
-- The existing platform-user INSERT permission is unchanged. Membership writes
-- and compensation are restricted to the exact pending activation and Auth
-- account it created; no table grants or Auth records are changed here.

begin;

-- A cleanup decision must survive the transaction: Auth deletion is a later
-- network request, so a lease takeover must never relink its target meanwhile.
alter table public.client_portal_access_operations
  add column if not exists account_cleanup_user_id uuid;

create or replace function public.mutate_client_portal_account_link(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_client_contact_id uuid,
  p_request_fingerprint text,
  p_lease_token uuid,
  p_user_id uuid,
  p_mutation text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_actor record;
  v_contact public.client_contacts%rowtype;
  v_client public.clients%rowtype;
  v_operation public.client_portal_access_operations%rowtype;
  v_access public.platform_users%rowtype;
  v_auth record;
  v_membership public.client_portal_memberships%rowtype;
begin
  if p_actor_user_id is null or p_request_id is null
    or p_client_contact_id is null or p_lease_token is null or p_user_id is null
    or p_request_fingerprint is null or p_request_fingerprint !~ '^[0-9a-f]{64}$'
    or p_mutation is null or p_mutation not in ('link', 'cleanup') then
    raise exception using errcode = '22023', message = 'The Client account link request is invalid.';
  end if;

  select * into v_actor from private.client_pipeline_actor(p_actor_user_id);
  if v_actor.role = 'talent_management'::public.platform_role then
    raise exception using errcode = '42501', message = 'Client portal access management is required.';
  end if;

  -- Use the reservation's contact lock, then the password-setup user's lock so
  -- linking/cleanup cannot overlap takeover, delivery checkpoints, or setup.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('client-portal-access-contact:' || p_client_contact_id::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('client-account-setup-user:' || p_user_id::text, 0)
  );

  select contact.* into v_contact
  from public.client_contacts as contact
  join public.clients as client
    on client.id = contact.client_id
   and client.organization_id = contact.organization_id
  where contact.id = p_client_contact_id
    and contact.organization_id = v_actor.organization_id
    and (
      v_actor.role <> 'sales'::public.platform_role
      or client.sales_owner_id = v_actor.user_id
    )
  for update of contact, client;
  if not found then
    raise exception using errcode = '42501', message = 'This Client contact is outside your access scope.';
  end if;
  select client.* into v_client
  from public.clients as client
  where client.id = v_contact.client_id
    and client.organization_id = v_contact.organization_id;

  -- p_request_id is the persisted effective operation id, never a submitted
  -- alias. Every authority-bearing field comes from that operation.
  select operation.* into v_operation
  from public.client_portal_access_operations as operation
  where operation.operation_request_id = p_request_id
  for update;
  if not found
    or v_operation.organization_id is distinct from v_actor.organization_id
    or v_operation.client_contact_id is distinct from v_contact.id
    or v_operation.lease_holder_user_id is distinct from v_actor.user_id
    or v_operation.action is distinct from 'activate'
    or v_operation.request_fingerprint is distinct from p_request_fingerprint
    or v_operation.status is distinct from 'pending'
    or v_operation.lease_token is distinct from p_lease_token
    or v_operation.lease_expires_at <= pg_catalog.clock_timestamp()
    or v_operation.requested_email is null
    or v_operation.requested_portal_role is null
    or v_operation.requested_portal_role not in (
      'client_admin'::public.platform_role,
      'client_reviewer'::public.platform_role,
      'client_billing'::public.platform_role
    ) then
    raise exception using errcode = '42501', message = 'This Client account activation lease is no longer current.';
  end if;

  if v_operation.account_cleanup_user_id is not null and (
    p_mutation = 'link'
    or v_operation.account_cleanup_user_id is distinct from p_user_id
  ) then
    raise exception using errcode = '42501', message = 'This Client activation has already started account cleanup.';
  end if;

  -- Auth app metadata is server-controlled. User metadata and caller-supplied
  -- email/role/organization are never used as account provenance.
  select account.id, account.email, account.raw_app_meta_data into v_auth
  from auth.users as account
  where account.id = p_user_id
  for update;
  if not found
    or v_auth.raw_app_meta_data ->> 'soro_client_access_request_id'
      is distinct from v_operation.operation_request_id::text
    or lower(btrim(v_auth.email)) is distinct from v_operation.requested_email then
    raise exception using errcode = '42501', message = 'This Auth account does not belong to the Client activation.';
  end if;

  select access.* into v_access
  from public.platform_users as access
  where access.id = p_user_id
  for update;
  if v_access.id is not null and (
    v_access.organization_id is distinct from v_operation.organization_id
    or v_access.role is distinct from v_operation.requested_portal_role
    or v_access.active is not true
    or v_access.must_change_password is not true
    or v_access.password_changed_at is not null
    or v_access.is_founder is true
  ) then
    raise exception using errcode = '42501', message = 'This platform account does not match the unfinished Client activation.';
  end if;

  if exists (
    select 1 from public.employee_profiles as employee
    where employee.user_id = p_user_id
  ) or exists (
    select 1 from public.applicants as applicant
    where applicant.auth_user_id = p_user_id
  ) then
    raise exception using errcode = '42501', message = 'This account is already associated with another Soro profile.';
  end if;

  -- Lock every competing membership for this user or contact, including an
  -- inactive membership. Never reassign another account or another Client.
  perform membership.user_id
  from public.client_portal_memberships as membership
  where membership.user_id = p_user_id or membership.client_contact_id = v_contact.id
  for update;
  if exists (
    select 1 from public.client_portal_memberships as membership
    where (membership.user_id = p_user_id or membership.client_contact_id = v_contact.id)
      and (
        membership.user_id is distinct from p_user_id
        or membership.organization_id is distinct from v_operation.organization_id
        or membership.client_id is distinct from v_contact.client_id
        or membership.client_contact_id is distinct from v_contact.id
      )
  ) then
    raise exception using errcode = '42501', message = 'This account or contact already has a different Client membership.';
  end if;

  select membership.* into v_membership
  from public.client_portal_memberships as membership
  where membership.user_id = p_user_id
    and membership.organization_id = v_operation.organization_id
    and membership.client_id = v_contact.client_id
    and membership.client_contact_id = v_contact.id;

  -- Row-lock waits must not let a lease that expired while waiting authorize
  -- a mutation. The operation row remains locked until this transaction ends.
  if v_operation.lease_expires_at <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '42501', message = 'This Client account activation lease is no longer current.';
  end if;

  if p_mutation = 'link' then
    if v_access.id is null
      or v_contact.active is not true
      or v_client.archived_at is not null
      or v_client.lifecycle_stage = 'archived'
      or (v_membership.user_id is not null and v_membership.active is not true) then
      raise exception using errcode = '42501', message = 'An unfinished active Client account and active contact are required.';
    end if;
    if v_membership.user_id is null then
      insert into public.client_portal_memberships (
        user_id, organization_id, client_id, client_contact_id, active
      ) values (
        p_user_id, v_operation.organization_id, v_contact.client_id, v_contact.id, true
      );
    end if;
    return jsonb_build_object('userId', p_user_id, 'linked', true, 'cleanupAllowed', false);
  end if;

  -- Cleanup is allowed only before a first setup has become usable or any
  -- durable email delivery has started. Existing setup ledgers also protect
  -- an Auth password commit whose platform completion may still be pending.
  if v_operation.delivery_payload is not null
    or v_operation.delivery_payload_created_at is not null
    or v_operation.delivery_first_attempt_at is not null
    or v_contact.portal_access_activated_at is not null
    or exists (
      select 1 from public.client_account_setup_operations as setup
      where setup.actor_user_id = p_user_id
    )
    or exists (
      select 1 from public.client_portal_access_operations as previous
      where previous.client_contact_id = v_contact.id
        and previous.action = 'activate'
        and previous.status = 'completed'
    ) then
    raise exception using errcode = '42501', message = 'This Client account has setup or delivery history and cannot be cleaned up.';
  end if;

  -- These two deletes are one transaction and contain the entire relationship
  -- boundary. An Auth account with no platform row is an allowed failed POST
  -- case. Contact metadata is owned by the access workflow and is untouched.
  update public.client_portal_access_operations
  set account_cleanup_user_id = p_user_id
  where operation_request_id = v_operation.operation_request_id;

  delete from public.client_portal_memberships as membership
  where membership.user_id = p_user_id
    and membership.organization_id = v_operation.organization_id
    and membership.client_id = v_contact.client_id
    and membership.client_contact_id = v_contact.id;

  delete from public.platform_users as access
  where access.id = p_user_id
    and access.organization_id = v_operation.organization_id
    and access.role = v_operation.requested_portal_role
    and access.active = true
    and access.must_change_password = true
    and access.password_changed_at is null
    and access.is_founder = false;

  return jsonb_build_object('userId', p_user_id, 'linked', false, 'cleanupAllowed', true);
end;
$$;

-- Preserve the established reservation contract, adding only a cleanup fence
-- before either retry path can return a claim that creates Auth/platform rows.
create or replace function public.reserve_client_portal_access_operation(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_client_contact_id uuid,
  p_action text,
  p_request_fingerprint text,
  p_requested_email text,
  p_requested_portal_role public.platform_role
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $$
declare
  v_actor record;
  v_contact public.client_contacts%rowtype;
  v_alias public.client_portal_access_request_aliases%rowtype;
  v_existing public.client_portal_access_operations%rowtype;
  v_blocking public.client_portal_access_operations%rowtype;
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_requested_email text := nullif(lower(btrim(coalesce(p_requested_email, ''))), '');
  v_lease_token uuid := gen_random_uuid();
  v_audit_event_id uuid;
  v_effective_request_id uuid;
  v_can_take_over boolean;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_request_id is null or p_client_contact_id is null
    or p_request_fingerprint !~ '^[0-9a-f]{64}$'
    or v_action not in (
      'activate', 'resend_invitation', 'change_email',
      'send_password_reset', 'suspend_access', 'reactivate_access'
    )
    or (
      v_action = 'activate'
      and (
        v_requested_email is null
        or length(v_requested_email) not between 3 and 254
        or v_requested_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
        or p_requested_portal_role is null
        or p_requested_portal_role not in (
          'client_admin'::public.platform_role,
          'client_reviewer'::public.platform_role,
          'client_billing'::public.platform_role
        )
      )
    )
    or (
      v_action = 'change_email'
      and (
        v_requested_email is null
        or length(v_requested_email) not between 3 and 254
        or v_requested_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
        or p_requested_portal_role is not null
      )
    )
    or (
      v_action in ('resend_invitation', 'send_password_reset', 'suspend_access', 'reactivate_access')
      and (v_requested_email is not null or p_requested_portal_role is not null)
    ) then
    raise exception using errcode = '22023', message = 'The Client access operation claim is invalid.';
  end if;

  select * into v_actor from private.client_pipeline_actor(p_actor_user_id);
  if v_actor.role = 'talent_management'::public.platform_role then
    raise exception using errcode = '42501', message = 'Client portal access management is required.';
  end if;
  v_can_take_over := v_actor.role in (
    'admin'::public.platform_role,
    'sales_management'::public.platform_role
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('client-portal-access-contact:' || p_client_contact_id::text, 0)
  );
  select contact.* into v_contact
  from public.client_contacts as contact
  join public.clients as client
    on client.id = contact.client_id
   and client.organization_id = contact.organization_id
  where contact.id = p_client_contact_id
    and contact.organization_id = v_actor.organization_id
    and (
      v_actor.role <> 'sales'::public.platform_role
      or client.sales_owner_id = v_actor.user_id
    )
  for update of contact;
  if not found then
    raise exception using errcode = '42501', message = 'This Client contact is outside your access scope.';
  end if;

  select request_alias.* into v_alias
  from public.client_portal_access_request_aliases as request_alias
  where request_alias.submitted_request_id = p_request_id
  for update;
  if v_alias.submitted_request_id is not null then
    if v_alias.organization_id is distinct from v_actor.organization_id
      or v_alias.client_contact_id is distinct from p_client_contact_id
      or v_alias.action is distinct from v_action
      or v_alias.request_fingerprint is distinct from p_request_fingerprint
      or (v_alias.submitted_by_user_id is distinct from v_actor.user_id and not v_can_take_over) then
      raise exception using errcode = '23505', message = 'This request id was already used for another Client access action.';
    end if;
    v_effective_request_id := v_alias.effective_operation_request_id;
    select operation.* into v_existing
    from public.client_portal_access_operations as operation
    where operation.operation_request_id = v_effective_request_id
    for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'This Client access request alias has no durable operation.';
    end if;
  else
    select operation.* into v_existing
    from public.client_portal_access_operations as operation
    where operation.operation_request_id = p_request_id
    for update;
    if found then
      v_effective_request_id := p_request_id;
    end if;
  end if;

  if v_existing.operation_request_id is not null then
    if v_existing.organization_id is distinct from v_actor.organization_id
      or v_existing.client_contact_id is distinct from p_client_contact_id
      or v_existing.action is distinct from v_action
      or v_existing.requested_email is distinct from v_requested_email
      or v_existing.requested_portal_role is distinct from p_requested_portal_role
      or v_existing.request_fingerprint is distinct from p_request_fingerprint
      or (v_existing.actor_user_id is distinct from v_actor.user_id and not v_can_take_over) then
      raise exception using errcode = '23505', message = 'This request id was already used for another Client access action.';
    end if;
    if v_existing.account_cleanup_user_id is not null then
      return jsonb_build_object(
        'state', 'cleanup_required',
        'effectiveRequestId', v_existing.operation_request_id
      );
    end if;
    if v_alias.submitted_request_id is null then
      insert into public.client_portal_access_request_aliases (
        submitted_request_id, effective_operation_request_id, organization_id,
        submitted_by_user_id, client_contact_id, action, request_fingerprint
      ) values (
        p_request_id, v_effective_request_id, v_existing.organization_id,
        v_existing.actor_user_id, v_existing.client_contact_id, v_existing.action,
        v_existing.request_fingerprint
      );
    end if;
    if v_existing.status = 'completed' then
      if v_existing.result is null then
        raise exception using errcode = 'P0001', message = 'This completed Client access operation has no durable result.';
      end if;
      return jsonb_build_object(
        'state', 'completed', 'result', v_existing.result,
        'auditEventId', v_existing.audit_event_id
      );
    end if;
    if v_existing.status = 'failed' then
      return jsonb_build_object('state', 'failed', 'failureCode', v_existing.failure_code);
    end if;
    if v_existing.lease_expires_at > v_now then
      return jsonb_build_object(
        'state', 'busy',
        'retryAfterSeconds', greatest(1, ceil(extract(epoch from (v_existing.lease_expires_at - v_now)))::integer)
      );
    end if;

    update public.client_portal_access_operations
    set lease_token = v_lease_token,
        lease_holder_user_id = v_actor.user_id,
        last_takeover_at = case when actor_user_id is distinct from v_actor.user_id then v_now else last_takeover_at end,
        lease_expires_at = v_now + interval '2 minutes',
        attempt_count = least(attempt_count::bigint + 1, 2147483647)::integer,
        failure_code = null
    where operation_request_id = v_effective_request_id;
    return jsonb_build_object(
      'state', 'claimed',
      'effectiveRequestId', v_effective_request_id,
      'leaseToken', v_lease_token,
      'resumed', true,
      'auditEventId', v_existing.audit_event_id,
      'operationCreatedAt', v_existing.created_at,
      'deliveryPayload', v_existing.delivery_payload,
      'deliveryPayloadCreatedAt', v_existing.delivery_payload_created_at,
      'deliveryFirstAttemptAt', v_existing.delivery_first_attempt_at
    );
  end if;

  select operation.* into v_blocking
  from public.client_portal_access_operations as operation
  where operation.client_contact_id = p_client_contact_id
    and operation.status = 'pending'
  order by operation.created_at
  limit 1
  for update;
  if v_blocking.operation_request_id is not null then
    if v_blocking.organization_id = v_actor.organization_id
      and v_blocking.action = v_action
      and v_blocking.requested_email is not distinct from v_requested_email
      and v_blocking.requested_portal_role is not distinct from p_requested_portal_role
      and v_blocking.request_fingerprint = p_request_fingerprint
      and (v_blocking.actor_user_id = v_actor.user_id or v_can_take_over) then
      if v_blocking.account_cleanup_user_id is not null then
        return jsonb_build_object(
          'state', 'cleanup_required',
          'effectiveRequestId', v_blocking.operation_request_id
        );
      end if;
      insert into public.client_portal_access_request_aliases (
        submitted_request_id, effective_operation_request_id, organization_id,
        submitted_by_user_id, client_contact_id, action, request_fingerprint
      ) values (
        p_request_id, v_blocking.operation_request_id, v_actor.organization_id,
        v_actor.user_id, p_client_contact_id, v_action, p_request_fingerprint
      );
      if v_blocking.lease_expires_at > v_now then
        return jsonb_build_object(
          'state', 'busy',
          'retryAfterSeconds', greatest(1, ceil(extract(epoch from (v_blocking.lease_expires_at - v_now)))::integer)
        );
      end if;
      update public.client_portal_access_operations
      set lease_token = v_lease_token,
          lease_holder_user_id = v_actor.user_id,
          last_takeover_at = case when actor_user_id is distinct from v_actor.user_id then v_now else last_takeover_at end,
          lease_expires_at = v_now + interval '2 minutes',
          attempt_count = least(attempt_count::bigint + 1, 2147483647)::integer,
          failure_code = null
      where operation_request_id = v_blocking.operation_request_id;
      return jsonb_build_object(
        'state', 'claimed',
        'effectiveRequestId', v_blocking.operation_request_id,
        'leaseToken', v_lease_token,
        'resumed', true,
        'auditEventId', v_blocking.audit_event_id,
        'operationCreatedAt', v_blocking.created_at,
        'deliveryPayload', v_blocking.delivery_payload,
        'deliveryPayloadCreatedAt', v_blocking.delivery_payload_created_at,
        'deliveryFirstAttemptAt', v_blocking.delivery_first_attempt_at
      );
    end if;
    return jsonb_build_object(
      'state', case when v_blocking.lease_expires_at > v_now then 'busy' else 'reconciliation_required' end,
      'retryAfterSeconds', case when v_blocking.lease_expires_at > v_now
        then greatest(1, ceil(extract(epoch from (v_blocking.lease_expires_at - v_now)))::integer)
        else null end
    );
  end if;

  insert into public.audit_events (
    organization_id, actor_user_id, entity_type, entity_id, event_type,
    after_value, note
  ) values (
    v_actor.organization_id, v_actor.user_id, 'client_portal_access', p_client_contact_id,
    'client_portal_access_' || v_action,
    jsonb_build_object('outcome', 'pending', 'request_id', p_request_id),
    'Soro authorized ' || replace(v_action, '_', ' ') || '; the final outcome is pending.'
  ) returning id into v_audit_event_id;

  insert into public.client_portal_access_operations (
    operation_request_id, organization_id, actor_user_id, client_contact_id, audit_event_id,
    action, requested_email, requested_portal_role, request_fingerprint,
    status, lease_token, lease_holder_user_id,
    lease_expires_at, attempt_count
  ) values (
    p_request_id, v_actor.organization_id, v_actor.user_id, p_client_contact_id, v_audit_event_id,
    v_action, v_requested_email, p_requested_portal_role, p_request_fingerprint,
    'pending', v_lease_token, v_actor.user_id,
    v_now + interval '2 minutes', 1
  );
  insert into public.client_portal_access_request_aliases (
    submitted_request_id, effective_operation_request_id, organization_id,
    submitted_by_user_id, client_contact_id, action, request_fingerprint
  ) values (
    p_request_id, p_request_id, v_actor.organization_id,
    v_actor.user_id, p_client_contact_id, v_action, p_request_fingerprint
  );
  return jsonb_build_object(
    'state', 'claimed',
    'effectiveRequestId', p_request_id,
    'leaseToken', v_lease_token,
    'resumed', false,
    'auditEventId', v_audit_event_id,
    'operationCreatedAt', v_now,
    'deliveryPayload', null,
    'deliveryPayloadCreatedAt', null,
    'deliveryFirstAttemptAt', null
  );
end;
$$;

revoke all on function public.mutate_client_portal_account_link(uuid, uuid, uuid, text, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.mutate_client_portal_account_link(uuid, uuid, uuid, text, uuid, uuid, text)
  to service_role;

comment on function public.mutate_client_portal_account_link(uuid, uuid, uuid, text, uuid, uuid, text) is
  'Server-only membership linking and failed first-setup compensation, bound to a live activation lease and server-issued Auth provenance. No Auth writes or table permission changes.';

commit;
