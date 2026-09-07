-- Soro Operations: retry-safe Client self-service password completion.
--
-- Auth password changes happen outside Postgres.  This service-only ledger keeps
-- the local permission gate and audit event convergent when an Auth or RPC
-- response is lost after commit.  No password or reusable password digest is
-- stored here; request_fingerprint is an HMAC produced by the server runtime.

begin;

create table if not exists public.client_account_setup_operations (
  operation_request_id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  actor_user_id uuid not null,
  client_contact_id uuid not null,
  audit_event_id uuid not null unique references public.audit_events(id) on delete restrict,
  action text not null check (action in ('complete_setup', 'complete_recovery')),
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  link_issued_at timestamptz not null,
  expected_must_change_password boolean not null,
  expected_password_changed_at timestamptz,
  target_password_changed_at timestamptz not null,
  auth_commit_confirmed_at timestamptz,
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  result jsonb,
  failure_code text,
  lease_token uuid not null default gen_random_uuid(),
  lease_expires_at timestamptz not null default now(),
  attempt_count integer not null default 1 check (attempt_count between 1 and 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_account_setup_operations_actor_organization_fkey
    foreign key (actor_user_id, organization_id)
    references public.platform_users (id, organization_id) on delete cascade,
  constraint client_account_setup_operations_contact_organization_fkey
    foreign key (client_contact_id, organization_id)
    references public.client_contacts (id, organization_id) on delete cascade,
  constraint client_account_setup_operations_action_state_check check (
    (action = 'complete_setup' and expected_must_change_password = true)
    or (action = 'complete_recovery' and expected_must_change_password = false)
  ),
  constraint client_account_setup_operations_terminal_result_check check (
    (status = 'pending' and result is null and failure_code is null)
    or (status = 'completed' and result is not null and failure_code is null)
    or (status = 'failed' and result is not null and failure_code is not null)
  )
);

create unique index if not exists client_account_setup_semantic_request_unique
  on public.client_account_setup_operations (
    actor_user_id, client_contact_id, action, request_fingerprint
  );

create unique index if not exists client_account_setup_one_pending_per_user
  on public.client_account_setup_operations (actor_user_id)
  where status = 'pending';

create table if not exists public.client_account_setup_operation_requests (
  submitted_request_id uuid primary key,
  operation_request_id uuid not null
    references public.client_account_setup_operations(operation_request_id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists client_account_setup_operation_requests_operation_idx
  on public.client_account_setup_operation_requests (operation_request_id);

drop trigger if exists client_account_setup_operations_updated_at
on public.client_account_setup_operations;
create trigger client_account_setup_operations_updated_at
before update on public.client_account_setup_operations
for each row execute function public.set_updated_at();

alter table public.client_account_setup_operations enable row level security;
alter table public.client_account_setup_operation_requests enable row level security;
revoke all on table public.client_account_setup_operations from public, anon, authenticated, service_role;
revoke all on table public.client_account_setup_operation_requests from public, anon, authenticated, service_role;

create or replace function public.reserve_client_account_setup_operation(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_client_contact_id uuid,
  p_action text,
  p_request_fingerprint text,
  p_link_issued_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_access public.platform_users%rowtype;
  v_membership public.client_portal_memberships%rowtype;
  v_contact public.client_contacts%rowtype;
  v_client public.clients%rowtype;
  v_existing public.client_account_setup_operations%rowtype;
  v_pending public.client_account_setup_operations%rowtype;
  v_effective_request_id uuid;
  v_audit_event_id uuid;
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_event_type text;
  v_authoritative_link_issued_at timestamptz;
  v_lease_token uuid := gen_random_uuid();
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_actor_user_id is null or p_request_id is null or p_client_contact_id is null
    or v_action not in ('complete_setup', 'complete_recovery')
    or p_request_fingerprint !~ '^[0-9a-f]{64}$'
    or p_link_issued_at is null then
    raise exception using errcode = '22023', message = 'The Client password operation claim is invalid.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('client-account-setup-user:' || p_actor_user_id::text, 0)
  );

  select request_map.operation_request_id into v_effective_request_id
  from public.client_account_setup_operation_requests as request_map
  where request_map.submitted_request_id = p_request_id;

  if v_effective_request_id is not null then
    select operation.* into v_existing
    from public.client_account_setup_operations as operation
    where operation.operation_request_id = v_effective_request_id
    for update;
  else
    select operation.* into v_existing
    from public.client_account_setup_operations as operation
    where operation.operation_request_id = p_request_id
    for update;

    if v_existing.operation_request_id is null then
      select operation.* into v_existing
      from public.client_account_setup_operations as operation
      where operation.actor_user_id = p_actor_user_id
        and operation.client_contact_id = p_client_contact_id
        and operation.action = v_action
        and operation.request_fingerprint = p_request_fingerprint
      for update;
    end if;

    if v_existing.operation_request_id is not null then
      insert into public.client_account_setup_operation_requests (
        submitted_request_id, operation_request_id
      ) values (p_request_id, v_existing.operation_request_id);
    end if;
  end if;

  if v_existing.operation_request_id is not null then
    if v_existing.actor_user_id is distinct from p_actor_user_id
      or v_existing.client_contact_id is distinct from p_client_contact_id
      or v_existing.action is distinct from v_action
      or v_existing.request_fingerprint is distinct from p_request_fingerprint
      or v_existing.link_issued_at is distinct from p_link_issued_at then
      return jsonb_build_object('state', 'request_conflict');
    end if;
    if v_existing.status in ('completed', 'failed') then
      return jsonb_build_object(
        'state', v_existing.status,
        'effectiveRequestId', v_existing.operation_request_id,
        'result', v_existing.result
      );
    end if;
  end if;

  select * into v_access
  from public.platform_users as access
  where access.id = p_actor_user_id;
  select * into v_membership
  from public.client_portal_memberships as membership
  where membership.user_id = p_actor_user_id;
  if v_membership.user_id is not null then
    select * into v_contact
    from public.client_contacts as contact
    where contact.id = p_client_contact_id
      and contact.id = v_membership.client_contact_id
      and contact.client_id = v_membership.client_id
      and contact.organization_id = v_membership.organization_id;
    select * into v_client
    from public.clients as client
    where client.id = v_membership.client_id
      and client.organization_id = v_membership.organization_id;
  end if;

  if v_access.id is null
    or v_access.organization_id is null
    or v_access.role not in (
      'client_admin'::public.platform_role,
      'client_reviewer'::public.platform_role,
      'client_billing'::public.platform_role
    )
    or v_access.active is not true
    or v_membership.user_id is null
    or v_membership.organization_id is distinct from v_access.organization_id
    or v_membership.active is not true
    or v_contact.id is null
    or v_contact.organization_id is distinct from v_access.organization_id
    or v_contact.active is not true
    or v_client.id is null
    or v_client.archived_at is not null then
    return jsonb_build_object('state', 'invalid_state');
  end if;

  if v_existing.operation_request_id is not null then
    if v_action = 'complete_setup' then
      v_authoritative_link_issued_at := greatest(
        v_access.initial_password_issued_at,
        v_contact.portal_invite_sent_at
      );
      if v_authoritative_link_issued_at is distinct from p_link_issued_at then
        return jsonb_build_object('state', 'invalid_state');
      end if;
    elsif v_contact.portal_last_password_reset_sent_at is not null
      and v_contact.portal_last_password_reset_sent_at is distinct from p_link_issued_at then
      return jsonb_build_object('state', 'invalid_state');
    end if;
    v_lease_token := gen_random_uuid();
    update public.client_account_setup_operations
    set lease_token = v_lease_token,
        lease_expires_at = v_now + interval '2 minutes',
        attempt_count = least(attempt_count + 1, 1000)
    where operation_request_id = v_existing.operation_request_id;
    return jsonb_build_object(
      'state', 'claimed',
      'effectiveRequestId', v_existing.operation_request_id,
      'leaseToken', v_lease_token,
      'attemptCount', least(v_existing.attempt_count + 1, 1000),
      'resumed', true,
      'authCommitConfirmed', v_existing.auth_commit_confirmed_at is not null,
      'targetPasswordChangedAt', v_existing.target_password_changed_at
    );
  end if;

  select operation.* into v_pending
  from public.client_account_setup_operations as operation
  where operation.actor_user_id = p_actor_user_id
    and operation.status = 'pending'
  order by operation.created_at
  limit 1
  for update;
  if v_pending.operation_request_id is not null then
    return jsonb_build_object('state', 'reconciliation_required');
  end if;

  if v_action = 'complete_setup' then
    v_authoritative_link_issued_at := greatest(
      v_access.initial_password_issued_at,
      v_contact.portal_invite_sent_at
    );
    if v_access.must_change_password is not true
      or v_contact.portal_access_status not in ('invite_pending', 'delivery_failed')
      or v_authoritative_link_issued_at is distinct from p_link_issued_at then
      return jsonb_build_object('state', 'invalid_state');
    end if;
    v_event_type := 'client_portal_setup_completed';
  else
    v_authoritative_link_issued_at := v_contact.portal_last_password_reset_sent_at;
    if v_access.must_change_password is not false
      or v_contact.portal_access_status <> 'active'
      or (v_authoritative_link_issued_at is not null
        and v_authoritative_link_issued_at is distinct from p_link_issued_at) then
      return jsonb_build_object('state', 'invalid_state');
    end if;
    v_event_type := 'client_portal_password_recovery_completed';
  end if;

  insert into public.audit_events (
    organization_id, actor_user_id, entity_type, entity_id, event_type,
    after_value, note
  ) values (
    v_access.organization_id, p_actor_user_id, 'client_portal_access', p_client_contact_id,
    v_event_type,
    jsonb_build_object('outcome', 'pending', 'request_id', p_request_id),
    case when v_action = 'complete_setup'
      then 'Client portal account setup started; the final outcome is pending.'
      else 'Client portal password recovery started; the final outcome is pending.' end
  ) returning id into v_audit_event_id;

  insert into public.client_account_setup_operations (
    operation_request_id, organization_id, actor_user_id, client_contact_id,
    audit_event_id, action, request_fingerprint, link_issued_at,
    expected_must_change_password, expected_password_changed_at,
    target_password_changed_at, lease_token, lease_expires_at
  ) values (
    p_request_id, v_access.organization_id, p_actor_user_id, p_client_contact_id,
    v_audit_event_id, v_action, p_request_fingerprint, p_link_issued_at,
    v_access.must_change_password, v_access.password_changed_at,
    v_now, v_lease_token, v_now + interval '2 minutes'
  );
  insert into public.client_account_setup_operation_requests (
    submitted_request_id, operation_request_id
  ) values (p_request_id, p_request_id);

  return jsonb_build_object(
    'state', 'claimed',
    'effectiveRequestId', p_request_id,
    'leaseToken', v_lease_token,
    'attemptCount', 1,
    'resumed', false,
    'authCommitConfirmed', false,
    'targetPasswordChangedAt', v_now
  );
end;
$$;

create or replace function public.confirm_client_account_setup_auth_commit(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_client_contact_id uuid,
  p_action text,
  p_request_fingerprint text,
  p_lease_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_existing public.client_account_setup_operations%rowtype;
  v_action text := lower(btrim(coalesce(p_action, '')));
begin
  if p_actor_user_id is null or p_request_id is null or p_client_contact_id is null
    or p_lease_token is null
    or v_action not in ('complete_setup', 'complete_recovery')
    or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'The Client Auth commit confirmation is invalid.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('client-account-setup-user:' || p_actor_user_id::text, 0)
  );
  select operation.* into v_existing
  from public.client_account_setup_operations as operation
  where operation.operation_request_id = p_request_id
  for update;
  if v_existing.operation_request_id is null
    or v_existing.actor_user_id is distinct from p_actor_user_id
    or v_existing.client_contact_id is distinct from p_client_contact_id
    or v_existing.action is distinct from v_action
    or v_existing.request_fingerprint is distinct from p_request_fingerprint then
    raise exception using errcode = '42501', message = 'This Client password operation is not available.';
  end if;
  if v_existing.status = 'completed' then
    return jsonb_build_object('confirmed', true);
  end if;
  if v_existing.status <> 'pending' or v_existing.lease_token is distinct from p_lease_token then
    raise exception using errcode = 'P0001', message = 'This Client password operation lease is no longer current.';
  end if;
  update public.client_account_setup_operations
  set auth_commit_confirmed_at = coalesce(auth_commit_confirmed_at, pg_catalog.clock_timestamp())
  where operation_request_id = v_existing.operation_request_id;
  return jsonb_build_object('confirmed', true);
end;
$$;

create or replace function public.finalize_client_account_setup_operation(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_client_contact_id uuid,
  p_action text,
  p_request_fingerprint text,
  p_lease_token uuid,
  p_outcome text,
  p_failure_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_existing public.client_account_setup_operations%rowtype;
  v_access public.platform_users%rowtype;
  v_membership public.client_portal_memberships%rowtype;
  v_contact public.client_contacts%rowtype;
  v_client public.clients%rowtype;
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_outcome text := lower(btrim(coalesce(p_outcome, '')));
  v_result jsonb;
  v_event_type text;
begin
  if p_actor_user_id is null or p_request_id is null or p_client_contact_id is null
    or p_lease_token is null
    or v_action not in ('complete_setup', 'complete_recovery')
    or p_request_fingerprint !~ '^[0-9a-f]{64}$'
    or v_outcome not in ('completed', 'failed')
    or (v_outcome = 'failed' and nullif(btrim(coalesce(p_failure_code, '')), '') is null)
    or char_length(coalesce(p_failure_code, '')) > 100 then
    raise exception using errcode = '22023', message = 'The Client password operation result is invalid.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('client-account-setup-user:' || p_actor_user_id::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('client-portal-access-contact:' || p_client_contact_id::text, 0)
  );
  select operation.* into v_existing
  from public.client_account_setup_operations as operation
  where operation.operation_request_id = p_request_id
  for update;

  if v_existing.operation_request_id is null
    or v_existing.actor_user_id is distinct from p_actor_user_id
    or v_existing.client_contact_id is distinct from p_client_contact_id
    or v_existing.action is distinct from v_action
    or v_existing.request_fingerprint is distinct from p_request_fingerprint then
    raise exception using errcode = '42501', message = 'This Client password operation is not available.';
  end if;
  if v_existing.status in ('completed', 'failed') and v_existing.result is not null then
    return v_existing.result;
  end if;
  if v_existing.status <> 'pending' or v_existing.lease_token is distinct from p_lease_token then
    raise exception using errcode = 'P0001', message = 'This Client password operation lease is no longer current.';
  end if;

  select * into v_access
  from public.platform_users as access
  where access.id = p_actor_user_id
    and access.organization_id = v_existing.organization_id
  for update;
  if v_access.id is null or v_access.active is not true
    or v_access.role not in (
      'client_admin'::public.platform_role,
      'client_reviewer'::public.platform_role,
      'client_billing'::public.platform_role
    ) then
    raise exception using errcode = 'P0001', message = 'The Client password access boundary changed.';
  end if;
  select * into v_membership
  from public.client_portal_memberships as membership
  where membership.user_id = v_existing.actor_user_id
    and membership.organization_id = v_existing.organization_id
    and membership.client_contact_id = v_existing.client_contact_id
  for update;
  if v_membership.user_id is not null then
    select * into v_contact
    from public.client_contacts as contact
    where contact.id = v_membership.client_contact_id
      and contact.client_id = v_membership.client_id
      and contact.organization_id = v_membership.organization_id
    for update;
    select * into v_client
    from public.clients as client
    where client.id = v_membership.client_id
      and client.organization_id = v_membership.organization_id
    for update;
  end if;
  if v_membership.user_id is null or v_membership.active is not true
    or v_contact.id is null or v_contact.active is not true
    or v_client.id is null or v_client.archived_at is not null then
    raise exception using errcode = 'P0001', message = 'The Client password membership boundary changed.';
  end if;

  if v_outcome = 'completed' then
    if v_existing.auth_commit_confirmed_at is null then
      raise exception using errcode = 'P0001', message = 'The Client Auth password commit is not confirmed.';
    end if;
    if v_access.must_change_password is not distinct from v_existing.expected_must_change_password
      and v_access.password_changed_at is not distinct from v_existing.expected_password_changed_at then
      update public.platform_users
      set must_change_password = false,
          password_changed_at = v_existing.target_password_changed_at
      where id = v_existing.actor_user_id
        and organization_id = v_existing.organization_id;
    elsif v_access.must_change_password is not false
      or v_access.password_changed_at is distinct from v_existing.target_password_changed_at then
      raise exception using errcode = 'P0001', message = 'The Client password state requires reconciliation.';
    end if;
    v_result := jsonb_build_object(
      'changed', true,
      'status', 'active',
      'auditLogged', true,
      'auditPending', false,
      'requestId', v_existing.operation_request_id
    );
  else
    -- A deterministic Auth rejection is terminal only before an Auth commit
    -- marker was confirmed and while local state remains exactly unchanged.
    if v_existing.auth_commit_confirmed_at is not null
      or v_access.must_change_password is distinct from v_existing.expected_must_change_password
      or v_access.password_changed_at is distinct from v_existing.expected_password_changed_at then
      raise exception using errcode = 'P0001', message = 'The Client password result requires reconciliation.';
    end if;
    v_result := jsonb_build_object(
      'changed', false,
      'status', case when v_action = 'complete_setup' then 'invite_pending' else 'active' end,
      'auditLogged', true,
      'auditPending', false,
      'requestId', v_existing.operation_request_id,
      'code', p_failure_code,
      'message', 'The password was not accepted. Choose a different password and try again.',
      'statusCode', 400,
      'retryable', false
    );
  end if;

  v_event_type := case when v_action = 'complete_setup'
    then 'client_portal_setup_completed'
    else 'client_portal_password_recovery_completed' end;
  update public.audit_events
  set after_value = coalesce(after_value, '{}'::jsonb)
        || jsonb_build_object('outcome', v_outcome),
      note = case
        when v_outcome = 'completed' and v_action = 'complete_setup'
          then 'Client portal account setup completed.'
        when v_outcome = 'completed'
          then 'Client portal password recovery completed.'
        when v_action = 'complete_setup'
          then 'Client portal account setup did not complete.'
        else 'Client portal password recovery did not complete.' end
  where id = v_existing.audit_event_id
    and organization_id = v_existing.organization_id
    and actor_user_id = v_existing.actor_user_id
    and entity_type = 'client_portal_access'
    and entity_id = v_existing.client_contact_id
    and event_type = v_event_type;
  if not found then
    raise exception using errcode = 'P0001', message = 'The Client password audit event could not be finalized.';
  end if;

  update public.client_account_setup_operations
  set status = v_outcome,
      result = v_result,
      failure_code = case when v_outcome = 'failed' then p_failure_code end,
      lease_expires_at = pg_catalog.clock_timestamp()
  where operation_request_id = v_existing.operation_request_id;

  return v_result;
end;
$$;

revoke all on function public.reserve_client_account_setup_operation(uuid, uuid, uuid, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.reserve_client_account_setup_operation(uuid, uuid, uuid, text, text, timestamptz)
  to service_role;
revoke all on function public.confirm_client_account_setup_auth_commit(uuid, uuid, uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.confirm_client_account_setup_auth_commit(uuid, uuid, uuid, text, text, uuid)
  to service_role;
revoke all on function public.finalize_client_account_setup_operation(uuid, uuid, uuid, text, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.finalize_client_account_setup_operation(uuid, uuid, uuid, text, text, uuid, text, text)
  to service_role;

comment on table public.client_account_setup_operations is
  'Service-only retry and reconciliation ledger for Client setup and password recovery.';
comment on table public.client_account_setup_operation_requests is
  'Service-only aliases that make a retried Client password request resolve to its original operation.';
comment on function public.reserve_client_account_setup_operation(uuid, uuid, uuid, text, text, timestamptz) is
  'Atomically reserves or resumes one Client password operation and its pending audit event.';
comment on function public.confirm_client_account_setup_auth_commit(uuid, uuid, uuid, text, text, uuid) is
  'Checkpoints a trusted Auth app-metadata commit marker before the local permission gate can be cleared.';
comment on function public.finalize_client_account_setup_operation(uuid, uuid, uuid, text, text, uuid, text, text) is
  'Atomically changes the Client password gate, terminal audit outcome, and operation result.';

commit;
