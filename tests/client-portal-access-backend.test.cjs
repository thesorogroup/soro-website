const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const previous = {
  url: process.env.SUPABASE_URL,
  key: process.env.SUPABASE_SERVICE_ROLE_KEY,
  resend: process.env.RESEND_API_KEY,
  from: process.env.CLIENT_ACCESS_FROM_EMAIL,
  portal: process.env.CLIENT_PORTAL_URL,
  linkTtl: process.env.CLIENT_ACCESS_LINK_TTL_SECONDS
};
process.env.SUPABASE_URL = 'https://client-access-tests.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
process.env.RESEND_API_KEY = 'test-resend-key';
process.env.CLIENT_ACCESS_FROM_EMAIL = 'Soro Group <access@example.test>';
process.env.CLIENT_PORTAL_URL = 'https://thesorogroup.com/operations/?accountSetup=1';
process.env.CLIENT_ACCESS_LINK_TTL_SECONDS = '3600';
const service = require('../netlify/functions/client-portal-access.js');

test.after(() => {
  for (const [key, value] of Object.entries({
    SUPABASE_URL: previous.url,
    SUPABASE_SERVICE_ROLE_KEY: previous.key,
    RESEND_API_KEY: previous.resend,
    CLIENT_ACCESS_FROM_EMAIL: previous.from,
    CLIENT_PORTAL_URL: previous.portal,
    CLIENT_ACCESS_LINK_TTL_SECONDS: previous.linkTtl
  })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

const IDS = Object.freeze({
  actor: '11111111-1111-4111-8111-111111111111',
  org: '22222222-2222-4222-8222-222222222222',
  operation: '33333333-3333-4333-8333-333333333333',
  operation2: '99999999-9999-4999-8999-999999999999',
  client: '44444444-4444-4444-8444-444444444444',
  contact: '55555555-5555-4555-8555-555555555555',
  auth: '66666666-6666-4666-8666-666666666666',
  audit: '77777777-7777-4777-8777-777777777777',
  lease: '88888888-8888-4888-8888-888888888888'
});
const UPDATED = '2026-09-01T12:34:56.000Z';

function contact(overrides = {}) {
  return {
    id: IDS.contact, organization_id: IDS.org, client_id: IDS.client,
    full_name: 'Client Contact', email: 'contact@example.test', phone: null,
    contact_role: 'Owner', active: true, updated_at: UPDATED,
    portal_login_email: null, portal_access_status: 'not_invited',
    portal_invite_sent_at: null, portal_access_activated_at: null,
    portal_last_password_reset_sent_at: null, portal_email_changed_at: null,
    portal_access_updated_at: null, ...overrides
  };
}

function client(overrides = {}) {
  return { id: IDS.client, organization_id: IDS.org, company_name: 'Example Client', sales_owner_id: IDS.actor, archived_at: null, ...overrides };
}

function managerAccess(role = 'sales') {
  return { id: IDS.actor, organization_id: IDS.org, role, active: true, must_change_password: false };
}

function jsonResponse(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => value, text: async () => JSON.stringify(value) };
}

function emptyResponse(status = 204) {
  return { ok: status >= 200 && status < 300, status, json: async () => ({}), text: async () => '' };
}

function postEvent(body, token = 'token') {
  return {
    httpMethod: 'POST', headers: { authorization: `Bearer ${token}` }, queryStringParameters: {},
    body: JSON.stringify(body)
  };
}

function deliveryPayload(email = 'client@example.test', kind = 'setup') {
  const passwordReset = kind === 'password_reset';
  return {
    from: 'Soro Group <access@example.test>',
    to: [email],
    subject: passwordReset ? 'Reset your Soro Client Portal password' : 'Set up your Soro Client Portal access',
    text: `Saved exact ${kind} text https://client-access-tests.supabase.co/auth/v1/verify?token=saved`,
    html: `<p>Saved exact ${kind}</p><a href="https://client-access-tests.supabase.co/auth/v1/verify?token=saved">Continue</a>`
  };
}

function freshPasswordToken() {
  const payload = Buffer.from(JSON.stringify({
    amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }]
  })).toString('base64url');
  return `header.${payload}.signature`;
}

test('migration adds six-state access metadata, password-change sync, and service-only operation ledger', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260901_036_client_pipeline_and_access.sql'), 'utf8');
  for (const column of [
    'portal_login_email', 'portal_access_status', 'portal_invite_sent_at',
    'portal_access_activated_at', 'portal_last_password_reset_sent_at',
    'portal_email_changed_at', 'portal_access_updated_by', 'portal_access_updated_at'
  ]) assert.match(sql, new RegExp(column, 'i'));
  for (const status of ['not_invited', 'invite_pending', 'active', 'suspended', 'delivery_failed', 'needs_reconciliation']) {
    assert.match(sql, new RegExp(`'${status}'`));
  }
  assert.match(sql, /sync_client_contact_portal_status/i);
  assert.match(sql, /must_change_password is false/i);
  assert.match(sql, /create table if not exists public\.client_portal_access_operations/i);
  assert.match(sql, /create table if not exists public\.client_portal_access_request_aliases/i);
  assert.match(sql, /alter table public\.client_portal_access_request_aliases enable row level security/i);
  assert.match(sql, /revoke all on table public\.client_portal_access_request_aliases from service_role/i);
  assert.match(sql, /audit_event_id uuid not null unique references public\.audit_events/i);
  assert.match(sql, /client_portal_access_operations_terminal_result_check/i);
  assert.match(sql, /revoke all on table public\.client_portal_access_operations from public, anon, authenticated/i);
  assert.match(sql, /revoke all on table public\.client_portal_access_operations from service_role/i);
  assert.match(sql, /create or replace function public\.find_client_auth_user_for_request/i);
  assert.match(sql, /raw_app_meta_data\s*->>\s*'soro_client_access_request_id'/i);
  assert.match(sql, /revoke all on function public\.find_client_auth_user_for_request\(uuid, text\)[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.find_client_auth_user_for_request\(uuid, text\)[\s\S]*to service_role/i);
  assert.match(sql, /create unique index if not exists client_portal_access_one_pending_per_contact[\s\S]*where status = 'pending'/i);
  assert.match(sql, /create or replace function public\.reserve_client_portal_access_operation/i);
  assert.match(sql, /pg_advisory_xact_lock[\s\S]*client-portal-access-contact:/i);
  assert.match(sql, /v_blocking\.request_fingerprint = p_request_fingerprint[\s\S]*effectiveRequestId', v_blocking\.operation_request_id/i);
  assert.match(sql, /insert into public\.client_portal_access_request_aliases[\s\S]*v_blocking\.operation_request_id/i);
  assert.match(sql, /lease_holder_user_id = v_actor\.user_id/i);
  assert.match(sql, /delivery_payload_created_at/i);
  assert.match(sql, /delivery_first_attempt_at/i);
  assert.match(sql, /requested_email text/i);
  assert.match(sql, /requested_portal_role public\.platform_role/i);
  assert.match(sql, /client_portal_access_operations_request_context_check/i);
  assert.match(sql, /drop function if exists public\.reserve_client_portal_access_operation\(uuid, uuid, uuid, text, text\)/i);
  assert.match(sql, /'pendingPortalAccess'[\s\S]*pending_access\.requested_email[\s\S]*pending_access\.requested_portal_role/i);
  assert.match(sql, /pending_access\.actor_user_id = p_actor_user_id/i);
  assert.match(sql, /'isPrimary', contact\.is_primary/i);
  assert.match(sql, /order by contact\.active desc, contact\.is_primary desc/i);
  assert.match(sql, /interval '24 hours 5 minutes'/i);
  assert.match(sql, /v_existing\.lease_holder_user_id is distinct from v_actor\.user_id/i);
  assert.match(sql, /v_existing\.requested_email is distinct from v_requested_email/i);
  assert.match(sql, /v_blocking\.requested_portal_role is not distinct from p_requested_portal_role/i);
  assert.match(sql, /checkpoint_client_portal_access_delivery[\s\S]*?scoped_client\.sales_owner_id = v_actor\.user_id/i);
  assert.match(sql, /mark_client_portal_access_delivery_attempt[\s\S]*?scoped_client\.sales_owner_id = v_actor\.user_id/i);
  assert.match(sql, /finalize_client_portal_access_operation[\s\S]*?scoped_client\.sales_owner_id = v_actor\.user_id/i);
  assert.match(sql, /coalesce\(after_value, '\{\}'::jsonb\) \|\| jsonb_build_object\('outcome', v_outcome\)/i);
  assert.match(sql, /create or replace function public\.checkpoint_client_portal_access_delivery/i);
  assert.match(sql, /create or replace function public\.finalize_client_portal_access_operation/i);
  assert.match(sql, /insert into public\.audit_events[\s\S]*insert into public\.client_portal_access_operations/i);
  assert.match(sql, /update public\.audit_events[\s\S]*update public\.client_portal_access_operations/i);
  for (const fn of ['reserve_client_portal_access_operation', 'checkpoint_client_portal_access_delivery', 'mark_client_portal_access_delivery_attempt', 'finalize_client_portal_access_operation']) {
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn}\\(`, 'i'));
  }
  assert.match(sql, /v_existing\.lease_token is distinct from p_lease_token/i);
  assert.match(sql, /revoke all on table public\.client_portal_access_operations from service_role/i);
  const reconciliationBranch = sql.indexOf("when contact.portal_access_status = 'needs_reconciliation'");
  const activeBranch = sql.indexOf('when new.must_change_password is false', reconciliationBranch);
  assert.ok(reconciliationBranch >= 0 && reconciliationBranch < activeBranch, 'needs_reconciliation must be authoritative in the database trigger');
});

test('each portal action has an exact body and no organization or auth user input', () => {
  const input = service.inputActionBody({
    action: 'activate', requestId: IDS.operation, contactId: IDS.contact,
    email: 'CLIENT@EXAMPLE.TEST', portalRole: 'client_reviewer'
  });
  assert.equal(input.email, 'client@example.test');
  assert.equal(input.portalRole, 'client_reviewer');
  assert.throws(() => service.inputActionBody({
    action: 'activate', requestId: IDS.operation, contactId: IDS.contact,
    email: 'client@example.test', portalRole: 'client_reviewer', organizationId: IDS.org
  }), /Only the fields/i);
  assert.throws(() => service.inputActionBody({
    action: 'send_password_reset', requestId: IDS.operation, contactId: IDS.contact, email: 'extra@example.test'
  }), /Only the fields/i);
  assert.throws(() => service.inputActionBody({
    action: 'abort_reconciliation', requestId: IDS.operation, contactId: IDS.contact
  }), /supported Client portal access action/i);
});

test('GET allows exactly one contactId query field', () => {
  assert.equal(service.inputStatusQuery({ body: '', queryStringParameters: { contactId: IDS.contact } }), IDS.contact);
  assert.throws(() => service.inputStatusQuery({
    body: '', queryStringParameters: { contactId: IDS.contact, organizationId: IDS.org }
  }), /only one/i);
});

test('scope roles and six-state reconciliation output are fail-closed', () => {
  assert.deepEqual([...service.MANAGER_ROLES].sort(), ['admin', 'sales', 'sales_management']);
  const bundle = {
    contact: contact({ portal_access_status: 'needs_reconciliation' }),
    client: client(),
    membership: { user_id: IDS.auth, active: true },
    access: { id: IDS.auth, role: 'virtual_assistant', active: true, must_change_password: false }
  };
  assert.equal(service.derivedStatus(bundle), 'needs_reconciliation');
  assert.deepEqual(service.publicAccess(bundle).availableActions, []);

  const missingAccess = { ...bundle, access: null };
  assert.equal(service.derivedStatus(missingAccess), 'needs_reconciliation');
  const missingMembership = { ...bundle, membership: null, access: null };
  assert.equal(service.derivedStatus(missingMembership), 'needs_reconciliation');
});

test('bootstrap secrets are high entropy and never a documented temporary password', () => {
  const one = service.generateUnreturnedSecret();
  const two = service.generateUnreturnedSecret();
  assert.notEqual(one, two);
  assert.ok(one.length >= 64);
  assert.match(one, /[A-Z]/);
  assert.match(one, /[a-z]/);
  assert.match(one, /\d/);
  assert.match(one, /!/);
});

test('ambiguous Auth creation recovers only the user correlated to the same access request', async t => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ target, options });
    if (target.endsWith('/auth/v1/admin/users')) throw new TypeError('Connection closed after Auth commit.');
    if (target.endsWith('/rest/v1/rpc/find_client_auth_user_for_request')) return jsonResponse(IDS.auth);
    throw new Error(`Unexpected fetch ${target}`);
  };
  t.after(() => { global.fetch = originalFetch; });

  const created = await service.createAuthUser('client@example.test', 'Client Contact', 'client_admin', IDS.operation);
  const createCall = calls.find(call => call.target.endsWith('/auth/v1/admin/users'));
  const lookupCall = calls.find(call => call.target.endsWith('/rest/v1/rpc/find_client_auth_user_for_request'));
  const createBody = JSON.parse(createCall.options.body);

  assert.deepEqual(created, { userId: IDS.auth, recovered: true });
  assert.equal(createBody.app_metadata.soro_client_access_request_id, IDS.operation);
  assert.equal(createBody.user_metadata.soro_client_access_request_id, undefined);
  assert.deepEqual(JSON.parse(lookupCall.options.body), { p_request_id: IDS.operation, p_email: 'client@example.test' });
});

test('ambiguous Auth email update verifies the known user before continuing', async t => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ target, options });
    if (target.endsWith(`/auth/v1/admin/users/${IDS.auth}`) && options.method === 'PUT') {
      throw new TypeError('Connection closed after Auth update.');
    }
    if (target.endsWith(`/auth/v1/admin/users/${IDS.auth}`)) {
      return jsonResponse({ id: IDS.auth, email: 'new-client@example.test' });
    }
    throw new Error(`Unexpected fetch ${target}`);
  };
  t.after(() => { global.fetch = originalFetch; });

  assert.equal(await service.updateAuthUserConfirmed(IDS.auth, { email: 'new-client@example.test' }), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.method, undefined);
});

test('a checkpointed email outside the link retry window remains pending until the provider key can be refreshed', async t => {
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error('No provider request should be made outside the safe retry window.');
  };
  t.after(() => { global.fetch = originalFetch; });
  const operation = {
    requestId: IDS.operation,
    leaseToken: IDS.lease,
    fingerprint: 'a'.repeat(64),
    createdAt: new Date().toISOString(),
    deliveryPayloadCreatedAt: new Date(Date.now() - service.EMAIL_IDEMPOTENCY_RETRY_MS - 1000).toISOString(),
    deliveryFirstAttemptAt: new Date(Date.now() - service.EMAIL_IDEMPOTENCY_RETRY_MS - 1000).toISOString(),
    deliveryPayload: deliveryPayload()
  };

  await assert.rejects(
    service.sendAccessEmail({
      manager: { user: { id: IDS.actor }, access: managerAccess() },
      input: { action: 'resend_invitation', requestId: IDS.operation, contactId: IDS.contact },
      operation, contact: contact(), to: 'client@example.test', kind: 'setup'
    }),
    error => error?.code === 'access_action_pending'
      && error?.operationOutcomeUnknown === true
      && error?.retryAfterSeconds > 0
  );
  assert.equal(fetchCalled, false);
});

test('a checkpointed email is refreshed only after the provider idempotency horizon', async t => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ target, options });
    if (target.includes('/auth/v1/admin/generate_link')) {
      return jsonResponse({ properties: { action_link: 'https://client-access-tests.supabase.co/auth/v1/verify?token=fresh' } });
    }
    if (target.endsWith('/rest/v1/rpc/checkpoint_client_portal_access_delivery')) {
      return jsonResponse(JSON.parse(options.body).p_delivery_payload);
    }
    if (target.endsWith('/rest/v1/rpc/mark_client_portal_access_delivery_attempt')) {
      return jsonResponse(new Date().toISOString());
    }
    if (target === 'https://api.resend.com/emails') return jsonResponse({ id: 'refreshed-delivery' });
    throw new Error(`Unexpected fetch ${target}`);
  };
  t.after(() => { global.fetch = originalFetch; });
  const originalPayload = deliveryPayload();
  const operation = {
    requestId: IDS.operation,
    leaseToken: IDS.lease,
    fingerprint: 'a'.repeat(64),
    createdAt: new Date(Date.now() - service.RESEND_IDEMPOTENCY_REFRESH_MS - 1000).toISOString(),
    deliveryPayloadCreatedAt: new Date(Date.now() - service.RESEND_IDEMPOTENCY_REFRESH_MS - 1000).toISOString(),
    deliveryFirstAttemptAt: new Date(Date.now() - service.RESEND_IDEMPOTENCY_REFRESH_MS - 1000).toISOString(),
    deliveryPayload: originalPayload
  };

  assert.equal(await service.sendAccessEmail({
    manager: { user: { id: IDS.actor }, access: managerAccess() },
    input: { action: 'resend_invitation', requestId: IDS.operation, contactId: IDS.contact },
    operation, contact: contact(), to: 'client@example.test', kind: 'setup'
  }), 'refreshed-delivery');
  const providerCall = calls.find(call => call.target === 'https://api.resend.com/emails');
  assert.notEqual(providerCall.options.body, JSON.stringify(originalPayload));
  assert.equal(providerCall.options.headers['Idempotency-Key'], `soro-client-access-${IDS.operation}`);
  assert.equal(calls.filter(call => call.target.includes('/auth/v1/admin/generate_link')).length, 1);
  assert.equal(calls.filter(call => call.target.endsWith('/rest/v1/rpc/checkpoint_client_portal_access_delivery')).length, 1);
});

test('an old payload that was never submitted is refreshed immediately and marked before provider delivery', async t => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ target, options });
    if (target.includes('/auth/v1/admin/generate_link')) {
      return jsonResponse({ properties: { action_link: 'https://client-access-tests.supabase.co/auth/v1/verify?token=never-submitted-refresh' } });
    }
    if (target.endsWith('/rest/v1/rpc/checkpoint_client_portal_access_delivery')) {
      return jsonResponse(JSON.parse(options.body).p_delivery_payload);
    }
    if (target.endsWith('/rest/v1/rpc/mark_client_portal_access_delivery_attempt')) return jsonResponse(new Date().toISOString());
    if (target === 'https://api.resend.com/emails') return jsonResponse({ id: 'first-real-attempt' });
    throw new Error(`Unexpected fetch ${target}`);
  };
  t.after(() => { global.fetch = originalFetch; });
  const originalPayload = deliveryPayload();

  assert.equal(await service.sendAccessEmail({
    manager: { user: { id: IDS.actor }, access: managerAccess() },
    input: { action: 'resend_invitation', requestId: IDS.operation, contactId: IDS.contact },
    operation: {
      requestId: IDS.operation,
      leaseToken: IDS.lease,
      fingerprint: 'a'.repeat(64),
      deliveryPayloadCreatedAt: new Date(Date.now() - service.EMAIL_IDEMPOTENCY_RETRY_MS - 1000).toISOString(),
      deliveryFirstAttemptAt: null,
      deliveryPayload: originalPayload
    },
    contact: contact(), to: 'client@example.test', kind: 'setup'
  }), 'first-real-attempt');

  const checkpointIndex = calls.findIndex(call => call.target.endsWith('/rest/v1/rpc/checkpoint_client_portal_access_delivery'));
  const markIndex = calls.findIndex(call => call.target.endsWith('/rest/v1/rpc/mark_client_portal_access_delivery_attempt'));
  const providerIndex = calls.findIndex(call => call.target === 'https://api.resend.com/emails');
  assert.ok(checkpointIndex >= 0 && checkpointIndex < markIndex && markIndex < providerIndex);
  assert.notEqual(calls[providerIndex].options.body, JSON.stringify(originalPayload));
});

test('an ambiguous provider-attempt checkpoint never calls the email provider', async t => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ target, options });
    if (target.endsWith('/rest/v1/rpc/mark_client_portal_access_delivery_attempt')) {
      return jsonResponse({ message: 'response lost after provider marker commit' }, 500);
    }
    throw new Error(`Unexpected fetch ${target}`);
  };
  t.after(() => { global.fetch = originalFetch; });

  await assert.rejects(service.sendAccessEmail({
    manager: { user: { id: IDS.actor }, access: managerAccess() },
    input: { action: 'resend_invitation', requestId: IDS.operation, contactId: IDS.contact },
    operation: {
      requestId: IDS.operation,
      leaseToken: IDS.lease,
      fingerprint: 'a'.repeat(64),
      deliveryPayloadCreatedAt: new Date().toISOString(),
      deliveryFirstAttemptAt: null,
      deliveryPayload: deliveryPayload()
    },
    contact: contact(), to: 'client@example.test', kind: 'setup'
  }), error => error?.code === 'access_action_pending' && error?.operationOutcomeUnknown === true);
  assert.equal(calls.some(call => call.target === 'https://api.resend.com/emails'), false);
});

test('a clock-boundary checkpoint conflict remains pending and never reaches the email provider', async t => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ target, options });
    if (target.includes('/auth/v1/admin/generate_link')) {
      return jsonResponse({ properties: { action_link: 'https://client-access-tests.supabase.co/auth/v1/verify?token=boundary' } });
    }
    if (target.endsWith('/rest/v1/rpc/checkpoint_client_portal_access_delivery')) {
      return jsonResponse({ message: 'still inside provider window' }, 409);
    }
    throw new Error(`Unexpected fetch ${target}`);
  };
  t.after(() => { global.fetch = originalFetch; });

  await assert.rejects(service.sendAccessEmail({
    manager: { user: { id: IDS.actor }, access: managerAccess() },
    input: { action: 'resend_invitation', requestId: IDS.operation, contactId: IDS.contact },
    operation: {
      requestId: IDS.operation,
      leaseToken: IDS.lease,
      fingerprint: 'a'.repeat(64),
      deliveryPayloadCreatedAt: new Date(Date.now() - service.RESEND_IDEMPOTENCY_REFRESH_MS - 1000).toISOString(),
      deliveryFirstAttemptAt: new Date(Date.now() - service.RESEND_IDEMPOTENCY_REFRESH_MS - 1000).toISOString(),
      deliveryPayload: deliveryPayload()
    },
    contact: contact(), to: 'client@example.test', kind: 'setup'
  }), error => error?.code === 'access_action_pending' && error?.operationOutcomeUnknown === true);
  assert.equal(calls.some(call => call.target === 'https://api.resend.com/emails'), false);
});

for (const [providerCode, expectedCode] of [
  ['concurrent_idempotent_requests', 'email_delivery_unknown'],
  ['invalid_idempotent_request', 'access_needs_reconciliation']
]) {
  test(`Resend 409 ${providerCode} preserves the operation as ${expectedCode}`, async t => {
    const originalFetch = global.fetch;
    global.fetch = async url => {
      if (String(url) === 'https://api.resend.com/emails') return jsonResponse({ name: providerCode }, 409);
      throw new Error(`Unexpected fetch ${url}`);
    };
    t.after(() => { global.fetch = originalFetch; });
    await assert.rejects(service.sendAccessEmail({
      manager: { user: { id: IDS.actor }, access: managerAccess() },
      input: { action: 'resend_invitation', requestId: IDS.operation, contactId: IDS.contact },
      operation: {
        requestId: IDS.operation,
        leaseToken: IDS.lease,
        fingerprint: 'a'.repeat(64),
        deliveryPayloadCreatedAt: new Date().toISOString(),
        deliveryFirstAttemptAt: new Date().toISOString(),
        deliveryPayload: deliveryPayload()
      },
      contact: contact(), to: 'client@example.test', kind: 'setup'
    }), error => error?.code === expectedCode && error?.operationOutcomeUnknown === true);
  });
}

test('a provider HTTP 408 remains delivery-unknown and retryable', async t => {
  const originalFetch = global.fetch;
  global.fetch = async url => {
    if (String(url) === 'https://api.resend.com/emails') return jsonResponse({ message: 'request timeout' }, 408);
    throw new Error(`Unexpected fetch ${url}`);
  };
  t.after(() => { global.fetch = originalFetch; });
  await assert.rejects(service.sendAccessEmail({
    manager: { user: { id: IDS.actor }, access: managerAccess() },
    input: { action: 'resend_invitation', requestId: IDS.operation, contactId: IDS.contact },
    operation: {
      requestId: IDS.operation,
      leaseToken: IDS.lease,
      fingerprint: 'a'.repeat(64),
      deliveryPayloadCreatedAt: new Date().toISOString(),
      deliveryFirstAttemptAt: new Date().toISOString(),
      deliveryPayload: deliveryPayload()
    },
    contact: contact(), to: 'client@example.test', kind: 'setup'
  }), error => error?.code === 'email_delivery_unknown' && error?.operationOutcomeUnknown === true);
});

test('an active per-contact lease rejects another action before mutable contact state is loaded', async t => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ target, options });
    if (target.endsWith('/auth/v1/user')) return jsonResponse({ id: IDS.actor });
    if (target.includes('/rest/v1/platform_users?id=eq.') && target.includes('&select=id,organization_id,role,active,must_change_password&')) return jsonResponse([managerAccess()]);
    if (target.endsWith('/rest/v1/rpc/reserve_client_portal_access_operation')) {
      return jsonResponse({ state: 'busy', retryAfterSeconds: 45 });
    }
    throw new Error(`Unexpected fetch ${target}`);
  };
  t.after(() => { global.fetch = originalFetch; });

  const result = await service.handler(postEvent({
    action: 'suspend_access', requestId: IDS.operation2, contactId: IDS.contact
  }));
  assert.equal(result.statusCode, 409);
  assert.equal(JSON.parse(result.body).code, 'access_action_pending');
  assert.equal(calls.some(call => call.target.includes('/rest/v1/client_contacts?')), false);
});

test('a zero-row scoped access PATCH remains pending and is never finalized completed', async t => {
  const originalFetch = global.fetch;
  const calls = [];
  let contactState = contact({ portal_login_email: 'client@example.test', portal_access_status: 'active' });
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    const method = String(options.method || 'GET').toUpperCase();
    calls.push({ target, method, options });
    if (target.endsWith('/auth/v1/user')) return jsonResponse({ id: IDS.actor });
    if (target.includes('/rest/v1/platform_users?id=eq.') && target.includes('&select=id,organization_id,role,active,must_change_password&')) return jsonResponse([managerAccess()]);
    if (target.endsWith('/rest/v1/rpc/reserve_client_portal_access_operation')) return jsonResponse({
      state: 'claimed', effectiveRequestId: IDS.operation, leaseToken: IDS.lease, auditEventId: IDS.audit,
      resumed: false, operationCreatedAt: new Date().toISOString(), deliveryPayload: null
    });
    if (target.includes('/rest/v1/client_contacts?id=eq.') && method === 'GET') return jsonResponse([contactState]);
    if (target.includes('/rest/v1/clients?id=eq.')) return jsonResponse([client()]);
    if (target.includes('/rest/v1/client_portal_memberships?client_contact_id=eq.') && method === 'GET') return jsonResponse([{
      user_id: IDS.auth, organization_id: IDS.org, client_id: IDS.client,
      client_contact_id: IDS.contact, active: true, updated_at: UPDATED
    }]);
    if (target.includes('/rest/v1/platform_users?id=eq.') && target.includes('initial_password_issued_at') && method === 'GET') return jsonResponse([{
      id: IDS.auth, organization_id: IDS.org, role: 'client_reviewer', active: true,
      must_change_password: false, initial_password_issued_at: UPDATED, password_changed_at: UPDATED
    }]);
    if (target.includes('/rest/v1/platform_users?id=eq.') && method === 'PATCH') return jsonResponse([]);
    if (target.includes('/rest/v1/client_contacts?id=eq.') && method === 'PATCH') {
      contactState = { ...contactState, ...JSON.parse(options.body) };
      return jsonResponse([{ id: IDS.contact }]);
    }
    throw new Error(`Unexpected fetch ${method} ${target}`);
  };
  t.after(() => { global.fetch = originalFetch; });

  const response = await service.handler(postEvent({
    action: 'suspend_access', requestId: IDS.operation, contactId: IDS.contact
  }));
  assert.equal(response.statusCode, 502);
  assert.equal(JSON.parse(response.body).code, 'access_needs_reconciliation');
  assert.equal(contactState.portal_access_status, 'needs_reconciliation');
  assert.equal(calls.some(call => call.target.includes('/rest/v1/client_portal_memberships?user_id=eq.') && call.method === 'PATCH'), false);
  assert.equal(calls.some(call => call.target.endsWith('/rest/v1/rpc/finalize_client_portal_access_operation')), false);
  const failedPatch = calls.find(call => call.target.includes('/rest/v1/platform_users?id=eq.') && call.method === 'PATCH');
  assert.equal(failedPatch.options.headers.Prefer, 'return=representation');
  assert.match(failedPatch.target, /[?&]select=id(?:&|$)/);
});

test('database error details are never returned to a browser', async t => {
  const originalFetch = global.fetch;
  const originalConsoleError = console.error;
  const logs = [];
  console.error = (...values) => { logs.push(values); };
  global.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith('/auth/v1/user')) return jsonResponse({ id: IDS.actor });
    if (target.includes('/rest/v1/platform_users?id=eq.')) return jsonResponse([managerAccess()]);
    if (target.endsWith('/rest/v1/rpc/reserve_client_portal_access_operation')) {
      return jsonResponse({ message: 'secret_table internal_constraint_name' }, 409);
    }
    throw new Error(`Unexpected fetch ${target}`);
  };
  t.after(() => {
    global.fetch = originalFetch;
    console.error = originalConsoleError;
  });

  const response = await service.handler(postEvent({
    action: 'suspend_access', requestId: IDS.operation, contactId: IDS.contact
  }));
  assert.equal(response.statusCode, 409);
  assert.equal(JSON.parse(response.body).code, 'access_action_failed');
  assert.doesNotMatch(response.body, /secret_table|internal_constraint/i);
  assert.doesNotMatch(JSON.stringify(logs), /secret_table|internal_constraint/i);
});

test('activate creates scoped membership, generates recovery link, sends email, and returns no secret', async t => {
  const originalFetch = global.fetch;
  const calls = [];
  let contactState = contact();
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    const method = String(options.method || 'GET').toUpperCase();
    calls.push({ target, method, options });
    if (target.endsWith('/auth/v1/user')) return jsonResponse({ id: IDS.actor });
    if (target.includes('/rest/v1/platform_users?id=eq.') && target.includes('&select=id,organization_id,role,active,must_change_password&')) return jsonResponse([managerAccess()]);
    if (target.includes('/rest/v1/client_contacts?id=eq.') && method === 'GET') return jsonResponse([contactState]);
    if (target.includes('/rest/v1/clients?id=eq.')) return jsonResponse([client()]);
    if (target.includes('/rest/v1/client_portal_memberships?client_contact_id=eq.') && method === 'GET') {
      if (!contactState.portal_login_email) return jsonResponse([]);
      return jsonResponse([{ user_id: IDS.auth, organization_id: IDS.org, client_id: IDS.client, client_contact_id: IDS.contact, active: true, updated_at: UPDATED }]);
    }
    if (target.includes('/rest/v1/platform_users?id=eq.') && target.includes('initial_password_issued_at') && method === 'GET') {
      return jsonResponse([{ id: IDS.auth, organization_id: IDS.org, role: 'client_reviewer', active: true, must_change_password: true, initial_password_issued_at: UPDATED, password_changed_at: null }]);
    }
    if (target.endsWith('/rest/v1/rpc/reserve_client_portal_access_operation')) return jsonResponse({
      state: 'claimed', effectiveRequestId: IDS.operation, leaseToken: IDS.lease, auditEventId: IDS.audit,
      resumed: false, operationCreatedAt: UPDATED, deliveryPayload: null
    });
    if (target.endsWith('/rest/v1/audit_events?select=id') && method === 'POST') return jsonResponse([{ id: IDS.audit }], 201);
    if (target.includes('/client_contacts?portal_login_email=eq.')) return jsonResponse([]);
    if (target.endsWith('/auth/v1/admin/users') && method === 'POST') return jsonResponse({ id: IDS.auth }, 201);
    if (target.endsWith('/rest/v1/platform_users') && method === 'POST') return emptyResponse(201);
    if (target.endsWith('/rest/v1/client_portal_memberships') && method === 'POST') return emptyResponse(201);
    if (target.includes('/rest/v1/client_contacts?id=eq.') && method === 'PATCH') {
      const update = JSON.parse(options.body);
      contactState = { ...contactState, ...update };
      return jsonResponse([{ id: IDS.contact }]);
    }
    if (target.includes('/auth/v1/admin/generate_link')) return jsonResponse({ properties: { action_link: 'https://client-access-tests.supabase.co/auth/v1/verify?token=secret' } });
    if (target.endsWith('/rest/v1/rpc/checkpoint_client_portal_access_delivery')) {
      return jsonResponse(JSON.parse(options.body).p_delivery_payload);
    }
    if (target.endsWith('/rest/v1/rpc/mark_client_portal_access_delivery_attempt')) return jsonResponse(new Date().toISOString());
    if (target === 'https://api.resend.com/emails') return jsonResponse({ id: 'delivery-record' });
    if (target.includes('/rest/v1/audit_events?id=eq.') && method === 'PATCH') return emptyResponse();
    if (target.endsWith('/rest/v1/rpc/finalize_client_portal_access_operation')) return jsonResponse({});
    throw new Error(`Unexpected fetch ${method} ${target}`);
  };
  t.after(() => { global.fetch = originalFetch; });

  const result = await service.handler({
    httpMethod: 'POST', headers: { authorization: 'Bearer token' }, queryStringParameters: {},
    body: JSON.stringify({
      action: 'activate', requestId: IDS.operation, contactId: IDS.contact,
      email: 'client@example.test', portalRole: 'client_reviewer'
    })
  });
  assert.equal(result.statusCode, 200);
  const output = result.body;
  assert.equal(output.includes('token=secret'), false);
  const authCreate = calls.find(call => call.target.endsWith('/auth/v1/admin/users') && call.method === 'POST');
  const authBody = JSON.parse(authCreate.options.body);
  assert.ok(authBody.password.length >= 64);
  assert.equal(output.includes(authBody.password), false);
  const membership = calls.find(call => call.target.endsWith('/rest/v1/client_portal_memberships') && call.method === 'POST');
  assert.deepEqual(JSON.parse(membership.options.body), {
    user_id: IDS.auth, organization_id: IDS.org, client_id: IDS.client,
    client_contact_id: IDS.contact, active: true
  });
  const delivery = calls.find(call => call.target === 'https://api.resend.com/emails');
  assert.ok(delivery);
  assert.equal(delivery.options.headers['Idempotency-Key'], `soro-client-access-${IDS.operation}`);
  const reserveIndex = calls.findIndex(call => call.target.endsWith('/rest/v1/rpc/reserve_client_portal_access_operation'));
  const contactIndex = calls.findIndex(call => call.target.includes('/rest/v1/client_contacts?id=eq.') && call.method === 'GET');
  assert.ok(reserveIndex >= 0 && reserveIndex < contactIndex, 'the durable contact claim must precede mutable bundle reads');
  const reserveBody = JSON.parse(calls[reserveIndex].options.body);
  assert.equal(reserveBody.p_requested_email, 'client@example.test');
  assert.equal(reserveBody.p_requested_portal_role, 'client_reviewer');
  assert.equal(calls.some(call => call.target.includes('/rest/v1/client_portal_access_operations?')), false);
});

test('a stale same-intent activation reuses its original Auth and platform rows and creates only the missing membership', async t => {
  const originalFetch = global.fetch;
  const calls = [];
  let contactState = contact();
  let membershipLinked = false;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    const method = String(options.method || 'GET').toUpperCase();
    calls.push({ target, method, options });
    if (target.endsWith('/auth/v1/user')) return jsonResponse({ id: IDS.actor });
    if (target.includes('/rest/v1/platform_users?id=eq.') && target.includes('&select=id,organization_id,role,active,must_change_password&')) return jsonResponse([managerAccess()]);
    if (target.endsWith('/rest/v1/rpc/reserve_client_portal_access_operation')) return jsonResponse({
      state: 'claimed', effectiveRequestId: IDS.operation, leaseToken: IDS.lease, auditEventId: IDS.audit,
      resumed: true, operationCreatedAt: UPDATED, deliveryPayload: null
    });
    if (target.includes('/rest/v1/client_contacts?id=eq.') && method === 'GET') return jsonResponse([contactState]);
    if (target.includes('/rest/v1/clients?id=eq.')) return jsonResponse([client()]);
    if (target.includes('/rest/v1/client_portal_memberships?client_contact_id=eq.') && method === 'GET') {
      return jsonResponse(membershipLinked ? [{
        user_id: IDS.auth, organization_id: IDS.org, client_id: IDS.client,
        client_contact_id: IDS.contact, active: true, updated_at: UPDATED
      }] : []);
    }
    if (target.endsWith('/rest/v1/audit_events?select=id') && method === 'POST') return jsonResponse([{ id: IDS.audit }], 201);
    if (target.includes('/client_contacts?portal_login_email=eq.')) return jsonResponse([]);
    if (target.endsWith('/rest/v1/rpc/find_client_auth_user_for_request')) return jsonResponse(IDS.auth);
    if (target.endsWith(`/auth/v1/admin/users/${IDS.auth}`) && method === 'GET') return jsonResponse({ id: IDS.auth, email: 'client@example.test' });
    if (target.includes('/rest/v1/platform_users?id=eq.') && target.includes('initial_password_issued_at') && method === 'GET') {
      return jsonResponse([{ id: IDS.auth, organization_id: IDS.org, role: 'client_reviewer', active: true, must_change_password: true, initial_password_issued_at: UPDATED, password_changed_at: null }]);
    }
    if (target.endsWith('/rest/v1/client_portal_memberships') && method === 'POST') {
      membershipLinked = true;
      return emptyResponse(201);
    }
    if (target.includes('/rest/v1/client_contacts?id=eq.') && method === 'PATCH') {
      contactState = { ...contactState, ...JSON.parse(options.body) };
      return jsonResponse([{ id: IDS.contact }]);
    }
    if (target.includes('/auth/v1/admin/generate_link')) return jsonResponse({ properties: { action_link: 'https://client-access-tests.supabase.co/auth/v1/verify?token=partial-recovery' } });
    if (target.endsWith('/rest/v1/rpc/checkpoint_client_portal_access_delivery')) return jsonResponse(JSON.parse(options.body).p_delivery_payload);
    if (target.endsWith('/rest/v1/rpc/mark_client_portal_access_delivery_attempt')) return jsonResponse(new Date().toISOString());
    if (target === 'https://api.resend.com/emails') return jsonResponse({ id: 'partial-recovery-delivery' });
    if (target.includes('/rest/v1/audit_events?id=eq.') && method === 'PATCH') return emptyResponse();
    if (target.endsWith('/rest/v1/rpc/finalize_client_portal_access_operation')) return jsonResponse({});
    throw new Error(`Unexpected fetch ${method} ${target}`);
  };
  t.after(() => { global.fetch = originalFetch; });

  const result = await service.handler(postEvent({
    action: 'activate', requestId: IDS.operation2, contactId: IDS.contact,
    email: 'client@example.test', portalRole: 'client_reviewer'
  }));
  assert.equal(result.statusCode, 200);
  assert.equal(membershipLinked, true);
  assert.equal(calls.some(call => call.target.endsWith('/auth/v1/admin/users') && call.method === 'POST'), false);
  assert.equal(calls.some(call => call.target.endsWith('/rest/v1/platform_users') && call.method === 'POST'), false);
  assert.equal(calls.some(call => call.target.includes(`/auth/v1/admin/users/${IDS.auth}`) && call.method === 'DELETE'), false);
  assert.equal(calls.some(call => call.target.includes('/rest/v1/platform_users?id=eq.') && call.method === 'DELETE'), false);
  const delivery = calls.find(call => call.target === 'https://api.resend.com/emails');
  assert.equal(delivery.options.headers['Idempotency-Key'], `soro-client-access-${IDS.operation}`);
  const finalization = calls.find(call => call.target.endsWith('/rest/v1/rpc/finalize_client_portal_access_operation'));
  assert.equal(JSON.parse(finalization.options.body).p_request_id, IDS.operation);
});

for (const action of ['activate', 'change_email']) {
  test(`resumed ${action} repeats its checkpointed setup email and restores invite_pending`, async t => {
    const originalFetch = global.fetch;
    const calls = [];
    const email = 'new-client@example.test';
    const storedPayload = deliveryPayload(email);
    let authEmail = action === 'change_email' ? 'old-client@example.test' : email;
    let contactState = contact({
      portal_login_email: email,
      portal_access_status: 'delivery_failed',
      portal_invite_sent_at: UPDATED,
      portal_email_changed_at: action === 'change_email' ? UPDATED : null
    });
    global.fetch = async (url, options = {}) => {
      const target = String(url);
      const method = String(options.method || 'GET').toUpperCase();
      calls.push({ target, method, options });
      if (target.endsWith('/auth/v1/user')) return jsonResponse({ id: IDS.actor });
      if (target.includes('/rest/v1/platform_users?id=eq.') && target.includes('&select=id,organization_id,role,active,must_change_password&')) return jsonResponse([managerAccess()]);
      if (target.endsWith('/rest/v1/rpc/reserve_client_portal_access_operation')) return jsonResponse({
        state: 'claimed', effectiveRequestId: IDS.operation, leaseToken: IDS.lease, auditEventId: IDS.audit,
        resumed: true, operationCreatedAt: new Date().toISOString(), deliveryPayload: storedPayload,
        deliveryPayloadCreatedAt: new Date().toISOString(),
        deliveryFirstAttemptAt: new Date().toISOString()
      });
      if (target.includes('/rest/v1/client_contacts?id=eq.') && method === 'GET') return jsonResponse([contactState]);
      if (target.includes('/rest/v1/clients?id=eq.')) return jsonResponse([client()]);
      if (target.includes('/rest/v1/client_portal_memberships?client_contact_id=eq.') && method === 'GET') return jsonResponse([{
        user_id: IDS.auth, organization_id: IDS.org, client_id: IDS.client,
        client_contact_id: IDS.contact, active: true, updated_at: UPDATED
      }]);
      if (target.includes('/rest/v1/platform_users?id=eq.') && target.includes('initial_password_issued_at') && method === 'GET') return jsonResponse([{
        id: IDS.auth, organization_id: IDS.org, role: 'client_reviewer', active: true,
        must_change_password: true, initial_password_issued_at: UPDATED, password_changed_at: null
      }]);
      if (target.includes('/client_contacts?portal_login_email=eq.')) return jsonResponse([]);
      if (target.endsWith(`/auth/v1/admin/users/${IDS.auth}`) && method === 'GET') return jsonResponse({ id: IDS.auth, email: authEmail });
      if (target.endsWith(`/auth/v1/admin/users/${IDS.auth}`) && method === 'PUT') {
        authEmail = JSON.parse(options.body).email;
        return jsonResponse({ id: IDS.auth, email: authEmail });
      }
      if (target.includes('/rest/v1/platform_users?id=eq.') && method === 'PATCH') return jsonResponse([{ id: IDS.auth }]);
      if (target === 'https://api.resend.com/emails') return jsonResponse({ id: `${action}-resumed-delivery` });
      if (target.includes('/rest/v1/client_contacts?id=eq.') && method === 'PATCH') {
        contactState = { ...contactState, ...JSON.parse(options.body) };
        return jsonResponse([{ id: IDS.contact }]);
      }
      if (target.includes('/rest/v1/audit_events?id=eq.') && method === 'PATCH') return emptyResponse();
      if (target.endsWith('/rest/v1/rpc/finalize_client_portal_access_operation')) return jsonResponse({});
      throw new Error(`Unexpected fetch ${method} ${target}`);
    };
    t.after(() => { global.fetch = originalFetch; });

    const body = action === 'activate'
      ? { action, requestId: IDS.operation2, contactId: IDS.contact, email, portalRole: 'client_reviewer' }
      : { action, requestId: IDS.operation2, contactId: IDS.contact, email };
    const result = await service.handler(postEvent(body, freshPasswordToken()));
    assert.equal(result.statusCode, 200);
    assert.equal(JSON.parse(result.body).access.status, 'invite_pending');
    assert.equal(contactState.portal_access_status, 'invite_pending');
    assert.equal(authEmail, email);
    assert.equal(calls.filter(call => call.target === 'https://api.resend.com/emails').length, 1);
    assert.equal(calls.some(call => call.target.includes('/auth/v1/admin/generate_link')), false);
    assert.equal(calls.some(call => call.target.endsWith('/rest/v1/rpc/checkpoint_client_portal_access_delivery')), false);
    const delivery = calls.find(call => call.target === 'https://api.resend.com/emails');
    assert.equal(delivery.options.body, JSON.stringify(storedPayload));
    assert.equal(delivery.options.headers['Idempotency-Key'], `soro-client-access-${IDS.operation}`);
    if (action === 'change_email') {
      assert.equal(calls.filter(call => call.target.endsWith(`/auth/v1/admin/users/${IDS.auth}`) && call.method === 'PUT').length, 1);
    }
  });
}

for (const ambiguousStage of ['platform user', 'membership']) {
  test(`activation reconciles a ${ambiguousStage} POST that committed before its response was lost`, async t => {
    const originalFetch = global.fetch;
    const calls = [];
    let contactState = contact();
    let platformExists = false;
    let membershipExists = false;
    global.fetch = async (url, options = {}) => {
      const target = String(url);
      const method = String(options.method || 'GET').toUpperCase();
      calls.push({ target, method, options });
      if (target.endsWith('/auth/v1/user')) return jsonResponse({ id: IDS.actor });
      if (target.includes('/rest/v1/platform_users?id=eq.') && target.includes('&select=id,organization_id,role,active,must_change_password&')) return jsonResponse([managerAccess()]);
      if (target.endsWith('/rest/v1/rpc/reserve_client_portal_access_operation')) return jsonResponse({
        state: 'claimed', effectiveRequestId: IDS.operation, leaseToken: IDS.lease, auditEventId: IDS.audit,
        resumed: false, operationCreatedAt: UPDATED, deliveryPayload: null
      });
      if (target.includes('/rest/v1/client_contacts?id=eq.') && method === 'GET') return jsonResponse([contactState]);
      if (target.includes('/rest/v1/clients?id=eq.')) return jsonResponse([client()]);
      if (target.includes('/rest/v1/client_portal_memberships?client_contact_id=eq.') && method === 'GET') {
        return jsonResponse(membershipExists ? [{
          user_id: IDS.auth, organization_id: IDS.org, client_id: IDS.client,
          client_contact_id: IDS.contact, active: true, updated_at: UPDATED
        }] : []);
      }
      if (target.includes('/client_contacts?portal_login_email=eq.')) return jsonResponse([]);
      if (target.endsWith('/auth/v1/admin/users') && method === 'POST') return jsonResponse({ id: IDS.auth }, 201);
      if (target.endsWith('/rest/v1/platform_users') && method === 'POST') {
        platformExists = true;
        if (ambiguousStage === 'platform user') throw new TypeError('Connection closed after platform user commit.');
        return emptyResponse(201);
      }
      if (target.includes('/rest/v1/platform_users?id=eq.') && target.includes('initial_password_issued_at') && method === 'GET') {
        return jsonResponse(platformExists ? [{ id: IDS.auth, organization_id: IDS.org, role: 'client_reviewer', active: true, must_change_password: true, initial_password_issued_at: UPDATED, password_changed_at: null }] : []);
      }
      if (target.endsWith('/rest/v1/client_portal_memberships') && method === 'POST') {
        membershipExists = true;
        if (ambiguousStage === 'membership') throw new TypeError('Connection closed after membership commit.');
        return emptyResponse(201);
      }
      if (target.includes('/rest/v1/client_contacts?id=eq.') && method === 'PATCH') {
        contactState = { ...contactState, ...JSON.parse(options.body) };
        return jsonResponse([{ id: IDS.contact }]);
      }
      if (target.includes('/auth/v1/admin/generate_link')) return jsonResponse({ properties: { action_link: 'https://client-access-tests.supabase.co/auth/v1/verify?token=committed' } });
      if (target.endsWith('/rest/v1/rpc/checkpoint_client_portal_access_delivery')) return jsonResponse(JSON.parse(options.body).p_delivery_payload);
      if (target.endsWith('/rest/v1/rpc/mark_client_portal_access_delivery_attempt')) return jsonResponse(new Date().toISOString());
      if (target === 'https://api.resend.com/emails') return jsonResponse({ id: 'commit-recovery-delivery' });
      if (target.includes('/rest/v1/audit_events?id=eq.') && method === 'PATCH') return emptyResponse();
      if (target.endsWith('/rest/v1/rpc/finalize_client_portal_access_operation')) return jsonResponse({});
      throw new Error(`Unexpected fetch ${method} ${target}`);
    };
    t.after(() => { global.fetch = originalFetch; });

    const result = await service.handler(postEvent({
      action: 'activate', requestId: IDS.operation, contactId: IDS.contact,
      email: 'client@example.test', portalRole: 'client_reviewer'
    }));
    assert.equal(result.statusCode, 200);
    assert.equal(platformExists, true);
    assert.equal(membershipExists, true);
    assert.equal(calls.some(call => call.method === 'DELETE'), false, 'a confirmed committed write must never trigger destructive cleanup');
  });
}

for (const action of ['resend_invitation', 'send_password_reset']) {
  test(`${action} retries a checkpointed exact email after an ambiguous provider response`, async t => {
    const originalFetch = global.fetch;
    const calls = [];
    const createdAt = new Date().toISOString();
    const isReset = action === 'send_password_reset';
    let contactState = contact({
      portal_login_email: 'client@example.test',
      portal_access_status: isReset ? 'active' : 'invite_pending',
      portal_invite_sent_at: isReset ? UPDATED : null,
      portal_last_password_reset_sent_at: null
    });
    let savedPayload = null;
    let savedPayloadCreatedAt = null;
    let savedFirstAttemptAt = null;
    let reserveCount = 0;
    let deliveryCount = 0;
    global.fetch = async (url, options = {}) => {
      const target = String(url);
      const method = String(options.method || 'GET').toUpperCase();
      calls.push({ target, method, options });
      if (target.endsWith('/auth/v1/user')) return jsonResponse({ id: IDS.actor });
      if (target.includes('/rest/v1/platform_users?id=eq.') && target.includes('&select=id,organization_id,role,active,must_change_password&')) return jsonResponse([managerAccess()]);
      if (target.endsWith('/rest/v1/rpc/reserve_client_portal_access_operation')) {
        reserveCount += 1;
        return jsonResponse({
          state: 'claimed', effectiveRequestId: IDS.operation, leaseToken: IDS.lease, auditEventId: IDS.audit,
          resumed: reserveCount > 1, operationCreatedAt: createdAt,
          deliveryPayload: reserveCount > 1 ? savedPayload : null,
          deliveryPayloadCreatedAt: reserveCount > 1 ? savedPayloadCreatedAt : null,
          deliveryFirstAttemptAt: reserveCount > 1 ? savedFirstAttemptAt : null
        });
      }
      if (target.includes('/rest/v1/client_contacts?id=eq.') && method === 'GET') return jsonResponse([contactState]);
      if (target.includes('/rest/v1/clients?id=eq.')) return jsonResponse([client()]);
      if (target.includes('/rest/v1/client_portal_memberships?client_contact_id=eq.') && method === 'GET') return jsonResponse([{
        user_id: IDS.auth, organization_id: IDS.org, client_id: IDS.client,
        client_contact_id: IDS.contact, active: true, updated_at: UPDATED
      }]);
      if (target.includes('/rest/v1/platform_users?id=eq.') && target.includes('initial_password_issued_at') && method === 'GET') {
        return jsonResponse([{ id: IDS.auth, organization_id: IDS.org, role: 'client_reviewer', active: true, must_change_password: !isReset, initial_password_issued_at: UPDATED, password_changed_at: isReset ? UPDATED : null }]);
      }
      if (target.includes('/rest/v1/client_contacts?id=eq.') && method === 'PATCH') {
        contactState = { ...contactState, ...JSON.parse(options.body) };
        return jsonResponse([{ id: IDS.contact }]);
      }
      if (target.includes('/auth/v1/admin/generate_link')) return jsonResponse({ properties: { action_link: `https://client-access-tests.supabase.co/auth/v1/verify?token=${action}` } });
      if (target.endsWith('/rest/v1/rpc/checkpoint_client_portal_access_delivery')) {
        savedPayload = JSON.parse(options.body).p_delivery_payload;
        savedPayloadCreatedAt = new Date().toISOString();
        return jsonResponse(savedPayload);
      }
      if (target.endsWith('/rest/v1/rpc/mark_client_portal_access_delivery_attempt')) {
        savedFirstAttemptAt ||= new Date().toISOString();
        return jsonResponse(savedFirstAttemptAt);
      }
      if (target === 'https://api.resend.com/emails') {
        deliveryCount += 1;
        if (deliveryCount === 1) return jsonResponse({ message: 'upstream response lost' }, 500);
        return jsonResponse({ id: `${action}-delivery` });
      }
      if (target.includes('/rest/v1/audit_events?id=eq.') && method === 'PATCH') return emptyResponse();
      if (target.endsWith('/rest/v1/rpc/finalize_client_portal_access_operation')) return jsonResponse({});
      throw new Error(`Unexpected fetch ${method} ${target}`);
    };
    t.after(() => { global.fetch = originalFetch; });

    const first = await service.handler(postEvent({ action, requestId: IDS.operation, contactId: IDS.contact }));
    assert.equal(first.statusCode, 502);
    assert.equal(JSON.parse(first.body).code, 'email_delivery_unknown');
    assert.equal(calls.some(call => call.target.endsWith('/rest/v1/rpc/finalize_client_portal_access_operation')), false);
    assert.equal(calls.some(call => call.target.includes('/rest/v1/audit_events?id=eq.') && call.method === 'PATCH'), false, 'ambiguous delivery must leave its one audit event pending');

    const second = await service.handler(postEvent({ action, requestId: IDS.operation2, contactId: IDS.contact }));
    assert.equal(second.statusCode, 200);
    const deliveries = calls.filter(call => call.target === 'https://api.resend.com/emails');
    assert.equal(deliveries.length, 2);
    assert.equal(deliveries[0].options.body, deliveries[1].options.body, 'provider retry must reuse the exact checkpointed one-use link and body');
    assert.equal(deliveries[0].options.headers['Idempotency-Key'], `soro-client-access-${IDS.operation}`);
    assert.equal(deliveries[1].options.headers['Idempotency-Key'], `soro-client-access-${IDS.operation}`);
    assert.equal(calls.filter(call => call.target.includes('/auth/v1/admin/generate_link')).length, 1);
    assert.equal(calls.filter(call => call.target.endsWith('/rest/v1/rpc/checkpoint_client_portal_access_delivery')).length, 1);
    assert.equal(calls.filter(call => call.target.endsWith('/rest/v1/rpc/mark_client_portal_access_delivery_attempt')).length, 1);
    const finalization = calls.find(call => call.target.endsWith('/rest/v1/rpc/finalize_client_portal_access_operation'));
    assert.equal(JSON.parse(finalization.options.body).p_request_id, IDS.operation, 'stale same-intent adoption must finalize the original request');
  });
}

test('a resumed invitation finalizes without resending after the Client already completed setup', async t => {
  const originalFetch = global.fetch;
  const calls = [];
  let contactState = contact({
    portal_login_email: 'client@example.test',
    portal_access_status: 'invite_pending',
    portal_invite_sent_at: UPDATED
  });
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    const method = String(options.method || 'GET').toUpperCase();
    calls.push({ target, method, options });
    if (target.endsWith('/auth/v1/user')) return jsonResponse({ id: IDS.actor });
    if (target.includes('/rest/v1/platform_users?id=eq.') && target.includes('&select=id,organization_id,role,active,must_change_password&')) return jsonResponse([managerAccess()]);
    if (target.endsWith('/rest/v1/rpc/reserve_client_portal_access_operation')) return jsonResponse({
      state: 'claimed', effectiveRequestId: IDS.operation, leaseToken: IDS.lease, auditEventId: IDS.audit,
      resumed: true, operationCreatedAt: UPDATED, deliveryPayload: null, deliveryPayloadCreatedAt: null
    });
    if (target.includes('/rest/v1/client_contacts?id=eq.') && method === 'GET') return jsonResponse([contactState]);
    if (target.includes('/rest/v1/clients?id=eq.')) return jsonResponse([client()]);
    if (target.includes('/rest/v1/client_portal_memberships?client_contact_id=eq.') && method === 'GET') return jsonResponse([{
      user_id: IDS.auth, organization_id: IDS.org, client_id: IDS.client,
      client_contact_id: IDS.contact, active: true, updated_at: UPDATED
    }]);
    if (target.includes('/rest/v1/platform_users?id=eq.') && target.includes('initial_password_issued_at') && method === 'GET') return jsonResponse([{
      id: IDS.auth, organization_id: IDS.org, role: 'client_reviewer', active: true,
      must_change_password: false, initial_password_issued_at: UPDATED, password_changed_at: UPDATED
    }]);
    if (target.includes('/rest/v1/client_contacts?id=eq.') && method === 'PATCH') {
      contactState = { ...contactState, ...JSON.parse(options.body) };
      return jsonResponse([{ id: IDS.contact }]);
    }
    if (target.endsWith('/rest/v1/rpc/finalize_client_portal_access_operation')) return jsonResponse({});
    throw new Error(`Unexpected fetch ${method} ${target}`);
  };
  t.after(() => { global.fetch = originalFetch; });

  const result = await service.handler(postEvent({
    action: 'resend_invitation', requestId: IDS.operation2, contactId: IDS.contact
  }));
  assert.equal(result.statusCode, 200);
  assert.equal(JSON.parse(result.body).access.status, 'active');
  assert.equal(contactState.portal_access_status, 'active');
  assert.equal(calls.some(call => call.target === 'https://api.resend.com/emails'), false);
  assert.equal(calls.some(call => call.target.includes('/auth/v1/admin/generate_link')), false);
  assert.equal(calls.some(call => call.target.endsWith('/rest/v1/rpc/checkpoint_client_portal_access_delivery')), false);
});

test('a deterministic Resend 4xx records one failed operation and one failed audit outcome', async t => {
  const originalFetch = global.fetch;
  const calls = [];
  let contactState = contact({ portal_login_email: 'client@example.test', portal_access_status: 'invite_pending' });
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    const method = String(options.method || 'GET').toUpperCase();
    calls.push({ target, method, options });
    if (target.endsWith('/auth/v1/user')) return jsonResponse({ id: IDS.actor });
    if (target.includes('/rest/v1/platform_users?id=eq.') && target.includes('&select=id,organization_id,role,active,must_change_password&')) return jsonResponse([managerAccess()]);
    if (target.endsWith('/rest/v1/rpc/reserve_client_portal_access_operation')) return jsonResponse({
      state: 'claimed', effectiveRequestId: IDS.operation, leaseToken: IDS.lease, auditEventId: IDS.audit,
      resumed: false, operationCreatedAt: new Date().toISOString(), deliveryPayload: null
    });
    if (target.includes('/rest/v1/client_contacts?id=eq.') && method === 'GET') return jsonResponse([contactState]);
    if (target.includes('/rest/v1/clients?id=eq.')) return jsonResponse([client()]);
    if (target.includes('/rest/v1/client_portal_memberships?client_contact_id=eq.') && method === 'GET') return jsonResponse([{
      user_id: IDS.auth, organization_id: IDS.org, client_id: IDS.client,
      client_contact_id: IDS.contact, active: true, updated_at: UPDATED
    }]);
    if (target.includes('/rest/v1/platform_users?id=eq.') && target.includes('initial_password_issued_at') && method === 'GET') return jsonResponse([{
      id: IDS.auth, organization_id: IDS.org, role: 'client_reviewer', active: true,
      must_change_password: true, initial_password_issued_at: UPDATED, password_changed_at: null
    }]);
    if (target.includes('/rest/v1/client_contacts?id=eq.') && method === 'PATCH') {
      contactState = { ...contactState, ...JSON.parse(options.body) };
      return jsonResponse([{ id: IDS.contact }]);
    }
    if (target.includes('/auth/v1/admin/generate_link')) return jsonResponse({ properties: { action_link: 'https://client-access-tests.supabase.co/auth/v1/verify?token=rejected' } });
    if (target.endsWith('/rest/v1/rpc/checkpoint_client_portal_access_delivery')) return jsonResponse(JSON.parse(options.body).p_delivery_payload);
    if (target.endsWith('/rest/v1/rpc/mark_client_portal_access_delivery_attempt')) return jsonResponse(new Date().toISOString());
    if (target === 'https://api.resend.com/emails') return jsonResponse({ message: 'invalid sender' }, 422);
    if (target.includes('/rest/v1/audit_events?id=eq.') && method === 'PATCH') return emptyResponse();
    if (target.endsWith('/rest/v1/rpc/finalize_client_portal_access_operation')) return jsonResponse({});
    throw new Error(`Unexpected fetch ${method} ${target}`);
  };
  t.after(() => { global.fetch = originalFetch; });

  const result = await service.handler(postEvent({
    action: 'resend_invitation', requestId: IDS.operation, contactId: IDS.contact
  }));
  assert.equal(result.statusCode, 502);
  assert.equal(JSON.parse(result.body).code, 'email_delivery_failed');
  assert.equal(contactState.portal_access_status, 'delivery_failed');
  const finalizations = calls.filter(call => call.target.endsWith('/rest/v1/rpc/finalize_client_portal_access_operation'));
  assert.equal(finalizations.length, 1);
  assert.equal(JSON.parse(finalizations[0].options.body).p_outcome, 'failed');
  assert.equal(calls.some(call => call.target.includes('/rest/v1/audit_events')), false, 'audit and failed ledger terminalization must be one RPC transaction');
});

test('a deterministic action failure with ambiguous atomic terminalization returns retryable 503', async t => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    const method = String(options.method || 'GET').toUpperCase();
    calls.push({ target, method, options });
    if (target.endsWith('/auth/v1/user')) return jsonResponse({ id: IDS.actor });
    if (target.includes('/rest/v1/platform_users?id=eq.') && target.includes('&select=id,organization_id,role,active,must_change_password&')) return jsonResponse([managerAccess()]);
    if (target.endsWith('/rest/v1/rpc/reserve_client_portal_access_operation')) return jsonResponse({
      state: 'claimed', effectiveRequestId: IDS.operation, leaseToken: IDS.lease, auditEventId: IDS.audit,
      resumed: false, operationCreatedAt: new Date().toISOString(), deliveryPayload: null
    });
    if (target.includes('/rest/v1/client_contacts?id=eq.') && method === 'GET') return jsonResponse([contact({ portal_login_email: 'client@example.test', portal_access_status: 'invite_pending' })]);
    if (target.includes('/rest/v1/clients?id=eq.')) return jsonResponse([client()]);
    if (target.includes('/rest/v1/client_portal_memberships?client_contact_id=eq.') && method === 'GET') return jsonResponse([{
      user_id: IDS.auth, organization_id: IDS.org, client_id: IDS.client,
      client_contact_id: IDS.contact, active: true, updated_at: UPDATED
    }]);
    if (target.includes('/rest/v1/platform_users?id=eq.') && target.includes('initial_password_issued_at') && method === 'GET') return jsonResponse([{
      id: IDS.auth, organization_id: IDS.org, role: 'client_reviewer', active: true,
      must_change_password: true, initial_password_issued_at: UPDATED, password_changed_at: null
    }]);
    if (target.endsWith('/rest/v1/rpc/finalize_client_portal_access_operation')) return jsonResponse({ message: 'terminal transaction response lost' }, 500);
    throw new Error(`Unexpected fetch ${method} ${target}`);
  };
  t.after(() => { global.fetch = originalFetch; });

  const result = await service.handler(postEvent({
    action: 'activate', requestId: IDS.operation, contactId: IDS.contact,
    email: 'client@example.test', portalRole: 'client_reviewer'
  }));
  assert.equal(result.statusCode, 503);
  assert.equal(result.headers['Retry-After'], '120');
  assert.equal(JSON.parse(result.body).code, 'access_action_pending');
  const finalization = calls.find(call => call.target.endsWith('/rest/v1/rpc/finalize_client_portal_access_operation'));
  assert.equal(JSON.parse(finalization.options.body).p_outcome, 'failed');
  assert.equal(calls.some(call => call.target.includes('/rest/v1/audit_events')), false);
});

test('an aliased request replays its original operation after a lost finalization response without repeating side effects', async t => {
  const originalFetch = global.fetch;
  const calls = [];
  let contactState = contact({ portal_login_email: 'client@example.test', portal_access_status: 'suspended' });
  let membershipActive = false;
  let platformActive = false;
  let reserveCount = 0;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    const method = String(options.method || 'GET').toUpperCase();
    calls.push({ target, method, options });
    if (target.endsWith('/auth/v1/user')) return jsonResponse({ id: IDS.actor });
    if (target.includes('/rest/v1/platform_users?id=eq.') && target.includes('&select=id,organization_id,role,active,must_change_password&')) return jsonResponse([managerAccess()]);
    if (target.endsWith('/rest/v1/rpc/reserve_client_portal_access_operation')) {
      reserveCount += 1;
      if (reserveCount > 1) return jsonResponse({
        state: 'completed', auditEventId: IDS.audit,
        result: {
          access: { contactId: IDS.contact, status: 'active' },
          emailDelivered: null, auditLogged: true, auditPending: false
        }
      });
      return jsonResponse({
        state: 'claimed', effectiveRequestId: IDS.operation, leaseToken: IDS.lease, auditEventId: IDS.audit,
        resumed: false, operationCreatedAt: new Date().toISOString(), deliveryPayload: null
      });
    }
    if (target.includes('/rest/v1/client_contacts?id=eq.') && method === 'GET') return jsonResponse([contactState]);
    if (target.includes('/rest/v1/clients?id=eq.')) return jsonResponse([client()]);
    if (target.includes('/rest/v1/client_portal_memberships?client_contact_id=eq.') && method === 'GET') return jsonResponse([{
      user_id: IDS.auth, organization_id: IDS.org, client_id: IDS.client,
      client_contact_id: IDS.contact, active: membershipActive, updated_at: UPDATED
    }]);
    if (target.includes('/rest/v1/platform_users?id=eq.') && target.includes('initial_password_issued_at') && method === 'GET') return jsonResponse([{
      id: IDS.auth, organization_id: IDS.org, role: 'client_reviewer', active: platformActive,
      must_change_password: false, initial_password_issued_at: UPDATED, password_changed_at: UPDATED
    }]);
    if (target.includes('/rest/v1/client_portal_memberships?user_id=eq.') && method === 'PATCH') {
      membershipActive = JSON.parse(options.body).active;
      return jsonResponse([{ user_id: IDS.auth }]);
    }
    if (target.includes('/rest/v1/platform_users?id=eq.') && method === 'PATCH') {
      platformActive = JSON.parse(options.body).active;
      return jsonResponse([{ id: IDS.auth }]);
    }
    if (target.includes('/rest/v1/client_contacts?id=eq.') && method === 'PATCH') {
      contactState = { ...contactState, ...JSON.parse(options.body) };
      return jsonResponse([{ id: IDS.contact }]);
    }
    if (target.includes('/rest/v1/audit_events?id=eq.') && method === 'PATCH') return emptyResponse();
    if (target.endsWith('/rest/v1/rpc/finalize_client_portal_access_operation')) return jsonResponse({ message: 'response lost after commit boundary' }, 500);
    throw new Error(`Unexpected fetch ${method} ${target}`);
  };
  t.after(() => { global.fetch = originalFetch; });

  const result = await service.handler(postEvent({
    action: 'reactivate_access', requestId: IDS.operation2, contactId: IDS.contact
  }));
  assert.equal(result.statusCode, 503);
  assert.equal(result.headers['Retry-After'], '120');
  assert.equal(JSON.parse(result.body).code, 'access_action_pending');
  assert.equal(membershipActive, true);
  assert.equal(platformActive, true);
  assert.equal(contactState.portal_access_status, 'active');
  const finalizations = calls.filter(call => call.target.endsWith('/rest/v1/rpc/finalize_client_portal_access_operation'));
  assert.equal(finalizations.length, 2);
  assert.deepEqual(finalizations.map(call => JSON.parse(call.options.body).p_outcome), ['completed', 'completed']);
  assert.ok(finalizations.every(call => JSON.parse(call.options.body).p_request_id === IDS.operation), 'the alias must finalize the effective original operation');
  assert.equal(calls.some(call => call.target.endsWith('/rest/v1/audit_events?select=id')), false, 'the RPC-created audit must be reused rather than duplicated');
  assert.equal(calls.some(call => call.target.includes('/rest/v1/audit_events')), false, 'audit and completed ledger terminalization must be one RPC transaction');

  const replay = await service.handler(postEvent({
    action: 'reactivate_access', requestId: IDS.operation2, contactId: IDS.contact
  }));
  assert.equal(replay.statusCode, 200);
  assert.equal(JSON.parse(replay.body).access.status, 'active');
  assert.equal(calls.filter(call => call.target.endsWith('/rest/v1/rpc/finalize_client_portal_access_operation')).length, 2);
  assert.equal(calls.filter(call => call.target.includes('/rest/v1/client_portal_memberships?user_id=eq.') && call.method === 'PATCH').length, 1);
  assert.equal(calls.filter(call => call.target.includes('/rest/v1/platform_users?id=eq.') && call.method === 'PATCH').length, 1);
});

test('an Auth identity recovered after an ambiguous create is never deleted by downstream failure cleanup', async t => {
  const originalFetch = global.fetch;
  const calls = [];
  let contactState = contact();
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    const method = String(options.method || 'GET').toUpperCase();
    calls.push({ target, method, options });
    if (target.endsWith('/auth/v1/user')) return jsonResponse({ id: IDS.actor });
    if (target.includes('/rest/v1/platform_users?id=eq.') && target.includes('&select=id,organization_id,role,active,must_change_password&')) return jsonResponse([managerAccess()]);
    if (target.endsWith('/rest/v1/rpc/reserve_client_portal_access_operation')) return jsonResponse({
      state: 'claimed', effectiveRequestId: IDS.operation, leaseToken: IDS.lease, auditEventId: IDS.audit,
      resumed: false, operationCreatedAt: UPDATED, deliveryPayload: null, deliveryPayloadCreatedAt: null
    });
    if (target.includes('/rest/v1/client_contacts?id=eq.') && method === 'GET') return jsonResponse([contactState]);
    if (target.includes('/rest/v1/clients?id=eq.')) return jsonResponse([client()]);
    if (target.includes('/rest/v1/client_portal_memberships?client_contact_id=eq.') && method === 'GET') return jsonResponse([]);
    if (target.includes('/client_contacts?portal_login_email=eq.')) return jsonResponse([]);
    if (target.endsWith('/auth/v1/admin/users') && method === 'POST') throw new TypeError('Auth response lost after commit');
    if (target.endsWith('/rest/v1/rpc/find_client_auth_user_for_request')) return jsonResponse(IDS.auth);
    if (target.endsWith('/rest/v1/platform_users') && method === 'POST') return jsonResponse({ message: 'definitively rejected' }, 400);
    if (target.includes('/rest/v1/platform_users?id=eq.') && target.includes('initial_password_issued_at') && method === 'GET') return jsonResponse([]);
    if (target.includes('/rest/v1/client_contacts?id=eq.') && method === 'PATCH') {
      contactState = { ...contactState, ...JSON.parse(options.body) };
      return jsonResponse([{ id: IDS.contact }]);
    }
    throw new Error(`Unexpected fetch ${method} ${target}`);
  };
  t.after(() => { global.fetch = originalFetch; });

  const result = await service.handler(postEvent({
    action: 'activate', requestId: IDS.operation, contactId: IDS.contact,
    email: 'client@example.test', portalRole: 'client_admin'
  }));
  assert.equal(result.statusCode, 502);
  assert.equal(JSON.parse(result.body).code, 'access_needs_reconciliation');
  assert.equal(contactState.portal_access_status, 'needs_reconciliation');
  assert.equal(calls.some(call => call.method === 'DELETE'), false);
  assert.equal(calls.some(call => call.target.endsWith('/rest/v1/rpc/finalize_client_portal_access_operation')), false);
});

test('definitively rejected database linking compensates by deleting the created Auth account', async t => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    const method = String(options.method || 'GET').toUpperCase();
    calls.push({ target, method, options });
    if (target.endsWith('/auth/v1/user')) return jsonResponse({ id: IDS.actor });
    if (target.includes('/rest/v1/platform_users?id=eq.') && target.includes('&select=id,organization_id,role,active,must_change_password&')) return jsonResponse([managerAccess()]);
    if (target.includes('/rest/v1/client_contacts?id=eq.') && method === 'GET') return jsonResponse([contact()]);
    if (target.includes('/rest/v1/clients?id=eq.')) return jsonResponse([client()]);
    if (target.includes('/rest/v1/client_portal_memberships?client_contact_id=eq.')) return jsonResponse([]);
    if (target.endsWith('/rest/v1/rpc/reserve_client_portal_access_operation')) return jsonResponse({
      state: 'claimed', effectiveRequestId: IDS.operation, leaseToken: IDS.lease, auditEventId: IDS.audit,
      resumed: false, operationCreatedAt: UPDATED, deliveryPayload: null
    });
    if (target.endsWith('/rest/v1/audit_events?select=id') && method === 'POST') return jsonResponse([{ id: IDS.audit }], 201);
    if (target.includes('/client_contacts?portal_login_email=eq.')) return jsonResponse([]);
    if (target.endsWith('/auth/v1/admin/users') && method === 'POST') return jsonResponse({ id: IDS.auth }, 201);
    if (target.endsWith('/rest/v1/platform_users') && method === 'POST') return emptyResponse(201);
    if (target.endsWith('/rest/v1/client_portal_memberships') && method === 'POST') return jsonResponse({ message: 'link failed' }, 400);
    if (target.includes('/rest/v1/client_portal_memberships?user_id=eq.') && method === 'DELETE') return emptyResponse();
    if (target.includes('/rest/v1/platform_users?id=eq.') && method === 'DELETE') return emptyResponse();
    if (target.includes(`/auth/v1/admin/users/${IDS.auth}`) && method === 'DELETE') return emptyResponse();
    if (target.includes('/rest/v1/client_contacts?id=eq.') && method === 'PATCH') return jsonResponse([{ id: IDS.contact }]);
    if (target.includes('/rest/v1/audit_events?id=eq.') && method === 'PATCH') return emptyResponse();
    if (target.endsWith('/rest/v1/rpc/finalize_client_portal_access_operation')) return jsonResponse({});
    throw new Error(`Unexpected fetch ${method} ${target}`);
  };
  t.after(() => { global.fetch = originalFetch; });

  const result = await service.handler({
    httpMethod: 'POST', headers: { authorization: 'Bearer token' }, queryStringParameters: {},
    body: JSON.stringify({
      action: 'activate', requestId: IDS.operation, contactId: IDS.contact,
      email: 'client@example.test', portalRole: 'client_admin'
    })
  });
  assert.equal(result.statusCode, 400);
  assert.ok(calls.some(call => call.target.includes(`/auth/v1/admin/users/${IDS.auth}`) && call.method === 'DELETE'));
  assert.ok(calls.some(call => call.target.includes('/rest/v1/platform_users?id=eq.') && call.method === 'DELETE'));
});
