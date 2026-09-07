const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260907_044_client_portal_account_link.sql'), 'utf8');
const body = sql.slice(sql.indexOf('as $$'), sql.indexOf('\n$$;'));
const link = body.slice(body.indexOf("if p_mutation = 'link' then"), body.indexOf('-- Cleanup is allowed'));
const cleanup = body.slice(body.indexOf('-- Cleanup is allowed'));
const reservationStart = sql.indexOf('create or replace function public.reserve_client_portal_access_operation(');
const reservation = sql.slice(reservationStart, sql.indexOf('\n$$;', reservationStart));

test('account link RPC exposes only lease-bound identifiers and grants execute only to service_role', () => {
  assert.match(sql, /create or replace function public\.mutate_client_portal_account_link\(\s*p_actor_user_id uuid,\s*p_request_id uuid,\s*p_client_contact_id uuid,\s*p_request_fingerprint text,\s*p_lease_token uuid,\s*p_user_id uuid,\s*p_mutation text\s*\)/i);
  assert.match(sql, /security definer\s+set search_path = pg_catalog, public, private/i);
  assert.match(sql, /p_mutation is null or p_mutation not in \('link', 'cleanup'\)/);
  assert.match(sql, /revoke all on function public\.mutate_client_portal_account_link\([^;]+from public, anon, authenticated;/i);
  assert.match(sql, /grant execute on function public\.mutate_client_portal_account_link\([^;]+to service_role;/i);
  assert.doesNotMatch(sql, /(?:grant|revoke)[^;]+on (?:table|all tables)/i);
  assert.doesNotMatch(sql, /grant[^;]+to (?:public|anon|authenticated)/i);
});

test('linking and cleanup share verified manager, organization, Sales ownership, and contact locks', () => {
  assert.match(body, /private\.client_pipeline_actor\(p_actor_user_id\)/);
  assert.match(body, /v_actor\.role = 'talent_management'::public\.platform_role then\s+raise exception/);
  assert.match(body, /'client-portal-access-contact:' \|\| p_client_contact_id::text/);
  assert.match(body, /'client-account-setup-user:' \|\| p_user_id::text/);
  assert.match(body, /contact\.organization_id = v_actor\.organization_id/);
  assert.match(body, /v_actor\.role <> 'sales'::public\.platform_role\s+or client\.sales_owner_id = v_actor\.user_id/);
  assert.match(body, /for update of contact, client;/);
});

test('every mutation checks the effective pending activation, fingerprint, holder, token, and current expiry', () => {
  for (const guard of [
    "v_operation.organization_id is distinct from v_actor.organization_id",
    "v_operation.client_contact_id is distinct from v_contact.id",
    "v_operation.lease_holder_user_id is distinct from v_actor.user_id",
    "v_operation.action is distinct from 'activate'",
    "v_operation.request_fingerprint is distinct from p_request_fingerprint",
    "v_operation.status is distinct from 'pending'",
    "v_operation.lease_token is distinct from p_lease_token",
    "v_operation.lease_expires_at <= pg_catalog.clock_timestamp()",
  ]) assert.ok(body.includes(guard), `Missing lease guard: ${guard}`);
  assert.match(body, /operation\.operation_request_id = p_request_id\s+for update;/);
  assert.match(body, /p_request_fingerprint is null or p_request_fingerprint !~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.ok(body.indexOf('pg_advisory_xact_lock') < body.indexOf('v_operation.lease_expires_at <= pg_catalog.clock_timestamp()'));
});

test('Auth provenance and platform authority come from persisted activation data', () => {
  assert.match(body, /from auth\.users as account\s+where account\.id = p_user_id\s+for update;/);
  assert.match(body, /v_auth\.raw_app_meta_data ->> 'soro_client_access_request_id'\s+is distinct from v_operation\.operation_request_id::text/);
  assert.match(body, /lower\(btrim\(v_auth\.email\)\) is distinct from v_operation\.requested_email/);
  assert.doesNotMatch(body, /raw_user_meta_data/);
  for (const field of ['organization_id is distinct from v_operation.organization_id', 'role is distinct from v_operation.requested_portal_role', 'active is not true', 'must_change_password is not true', 'password_changed_at is not null', 'is_founder is true']) {
    assert.ok(body.includes(`v_access.${field}`), `Missing platform guard: ${field}`);
  }
  assert.match(body, /v_operation\.requested_portal_role not in \(\s*'client_admin'::public\.platform_role,\s*'client_reviewer'::public\.platform_role,\s*'client_billing'::public\.platform_role\s*\)/);
});

test('link is idempotent only for the exact active user, contact, Client, and organization', () => {
  assert.match(body, /membership\.user_id = p_user_id or membership\.client_contact_id = v_contact\.id\s+for update;/);
  for (const guard of ['user_id is distinct from p_user_id', 'organization_id is distinct from v_operation.organization_id', 'client_id is distinct from v_contact.client_id', 'client_contact_id is distinct from v_contact.id']) {
    assert.ok(body.includes(`membership.${guard}`), `Missing membership guard: ${guard}`);
  }
  assert.match(link, /v_access\.id is null/);
  assert.match(link, /v_contact\.active is not true/);
  assert.match(link, /v_client\.archived_at is not null/);
  assert.match(link, /v_client\.lifecycle_stage = 'archived'/);
  assert.match(link, /v_membership\.user_id is not null and v_membership\.active is not true/);
  assert.match(link, /if v_membership\.user_id is null then\s+insert into public\.client_portal_memberships/);
  assert.match(link, /p_user_id, v_operation\.organization_id, v_contact\.client_id, v_contact\.id, true/);
  assert.match(link, /'userId', p_user_id, 'linked', true, 'cleanupAllowed', false/);
  assert.doesNotMatch(link, /update public\.platform_users|on conflict[^;]+do update/i);
});

test('cleanup refuses delivery, completed setup, employee/talent, or unrelated membership history', () => {
  assert.match(body, /from public\.employee_profiles as employee\s+where employee\.user_id = p_user_id/);
  assert.match(body, /from public\.applicants as applicant\s+where applicant\.auth_user_id = p_user_id/);
  for (const guard of ['delivery_payload', 'delivery_payload_created_at', 'delivery_first_attempt_at']) {
    assert.ok(cleanup.includes(`v_operation.${guard} is not null`));
  }
  assert.match(cleanup, /v_contact\.portal_access_activated_at is not null/);
  assert.match(cleanup, /from public\.client_account_setup_operations as setup\s+where setup\.actor_user_id = p_user_id/);
  assert.match(cleanup, /previous\.client_contact_id = v_contact\.id\s+and previous\.action = 'activate'\s+and previous\.status = 'completed'/);
});

test('a durable cleanup marker prevents a later lease holder from relinking the account awaiting Auth deletion', () => {
  assert.match(sql, /alter table public\.client_portal_access_operations\s+add column if not exists account_cleanup_user_id uuid;/);
  assert.match(body, /v_operation\.account_cleanup_user_id is not null and \(\s*p_mutation = 'link'\s*or v_operation\.account_cleanup_user_id is distinct from p_user_id\s*\) then\s+raise exception/);
  assert.match(cleanup, /update public\.client_portal_access_operations\s+set account_cleanup_user_id = p_user_id\s+where operation_request_id = v_operation\.operation_request_id;/);
  assert.ok(body.indexOf('v_operation.account_cleanup_user_id is not null') < body.indexOf("if p_mutation = 'link' then"));
  assert.ok(cleanup.indexOf('set account_cleanup_user_id = p_user_id') < cleanup.indexOf('delete from public.client_portal_memberships'));
});

test('reservation refuses cleaned-up existing requests and same-intent takeover before returning an Auth provisioning claim', () => {
  assert.match(reservation, /if v_existing\.account_cleanup_user_id is not null then\s+return jsonb_build_object\(\s*'state', 'cleanup_required',\s*'effectiveRequestId', v_existing\.operation_request_id\s*\);\s+end if;/);
  assert.match(reservation, /if v_blocking\.account_cleanup_user_id is not null then\s+return jsonb_build_object\(\s*'state', 'cleanup_required',\s*'effectiveRequestId', v_blocking\.operation_request_id\s*\);\s+end if;/);
  assert.ok(reservation.indexOf('if v_existing.account_cleanup_user_id') < reservation.indexOf('set lease_token = v_lease_token'));
  const takeover = reservation.slice(reservation.indexOf('if v_blocking.operation_request_id is not null then'));
  assert.ok(takeover.indexOf('if v_blocking.account_cleanup_user_id') < takeover.indexOf('set lease_token = v_lease_token'));
  const previous = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260901_036_client_pipeline_and_access.sql'), 'utf8').replace(/\r\n/g, '\n');
  const previousStart = previous.indexOf('create or replace function public.reserve_client_portal_access_operation(');
  const previousReservation = previous.slice(previousStart, previous.indexOf('\n$$;', previousStart));
  const withoutNewGuards = reservation.replace(/^ +if v_(?:existing|blocking)\.account_cleanup_user_id is not null then\n[\s\S]*?^ +end if;\n/gm, '');
  assert.equal(withoutNewGuards, previousReservation, 'Reservation changes must remain limited to cleanup fences.');
});

test('cleanup deletes only matching local rows transactionally and allows missing rows without touching Auth or contact metadata', () => {
  assert.match(sql, /\bbegin;/i);
  assert.match(sql, /\bcommit;\s*$/i);
  assert.match(cleanup, /delete from public\.client_portal_memberships as membership\s+where membership\.user_id = p_user_id\s+and membership\.organization_id = v_operation\.organization_id\s+and membership\.client_id = v_contact\.client_id\s+and membership\.client_contact_id = v_contact\.id;/);
  assert.match(cleanup, /delete from public\.platform_users as access\s+where access\.id = p_user_id\s+and access\.organization_id = v_operation\.organization_id\s+and access\.role = v_operation\.requested_portal_role\s+and access\.active = true\s+and access\.must_change_password = true\s+and access\.password_changed_at is null\s+and access\.is_founder = false;/);
  assert.match(cleanup, /'userId', p_user_id, 'linked', false, 'cleanupAllowed', true/);
  assert.doesNotMatch(cleanup, /if v_access\.id is null|if v_membership\.user_id is null/);
  assert.doesNotMatch(body, /(?:delete from|update|insert into) auth\.users/i);
  assert.doesNotMatch(body, /(?:delete from|update|insert into) public\.client_contacts/i);
  assert.equal((body.match(/delete from /g) || []).length, 2);
});
