const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const previousUrl = process.env.SUPABASE_URL;
const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.SUPABASE_URL = 'https://client-account-tests.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
const setup = require('../netlify/functions/client-account-setup.js');

test.after(() => {
  if (previousUrl === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = previousUrl;
  if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
});

const IDS = Object.freeze({
  user: '11111111-1111-4111-8111-111111111111',
  organization: '22222222-2222-4222-8222-222222222222',
  client: '33333333-3333-4333-8333-333333333333',
  contact: '44444444-4444-4444-8444-444444444444',
  request: '55555555-5555-4555-8555-555555555555',
  request2: '66666666-6666-4666-8666-666666666666',
  lease: '77777777-7777-4777-8777-777777777777'
});

const PASSWORD = 'A secure passphrase 42!';

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
    text: async () => JSON.stringify(value)
  };
}

function tokenWithAmr(method = 'recovery', timestamp = Math.floor(Date.now() / 1000)) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({ amr: [{ method, timestamp }] })}.unsigned`;
}

function postEvent(body = {}, token = tokenWithAmr()) {
  return {
    httpMethod: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ action: 'complete_setup', newPassword: PASSWORD, requestId: IDS.request, ...body })
  };
}

function baseRecords(overrides = {}) {
  const issuedAt = new Date(Date.now() - 60_000).toISOString().replace(/Z$/, '456+00:00');
  return {
    user: { id: IDS.user, email: 'client@example.test' },
    access: {
      id: IDS.user, organization_id: IDS.organization, role: 'client_reviewer', active: true,
      must_change_password: true, initial_password_issued_at: issuedAt, password_changed_at: null,
      ...(overrides.access || {})
    },
    membership: {
      user_id: IDS.user, organization_id: IDS.organization, client_id: IDS.client,
      client_contact_id: IDS.contact, active: true, ...(overrides.membership || {})
    },
    contact: {
      id: IDS.contact, organization_id: IDS.organization, client_id: IDS.client, active: true,
      portal_login_email: 'client@example.test', portal_access_status: 'invite_pending',
      portal_invite_sent_at: issuedAt, portal_access_activated_at: null,
      portal_last_password_reset_sent_at: null, ...(overrides.contact || {})
    },
    client: {
      id: IDS.client, organization_id: IDS.organization, archived_at: null,
      ...(overrides.client || {})
    }
  };
}

function completedResult(requestId = IDS.request) {
  return { changed: true, status: 'active', auditLogged: true, auditPending: false, requestId };
}

function claimedReservation(overrides = {}) {
  return {
    state: 'claimed', effectiveRequestId: IDS.request, leaseToken: IDS.lease,
    attemptCount: 1, resumed: false, authCommitConfirmed: false,
    targetPasswordChangedAt: new Date().toISOString(), ...overrides
  };
}

function installFetch(t, records, hooks = {}) {
  const originalFetch = global.fetch;
  const calls = [];
  let adminUser = {
    id: IDS.user, email: records.user.email,
    app_metadata: { provider: 'email', providers: ['email'] }, ...(hooks.adminUser || {})
  };
  const setAdminUser = value => { adminUser = value; };

  global.fetch = async (url, options = {}) => {
    const target = String(url);
    const method = String(options.method || 'GET').toUpperCase();
    const body = options.body ? JSON.parse(options.body) : null;
    const call = { target, method, options, body };
    calls.push(call);
    if (target.endsWith('/auth/v1/user')) return jsonResponse(records.user);
    if (target.includes('/rest/v1/platform_users?') && method === 'GET') return jsonResponse([records.access]);
    if (target.includes('/rest/v1/client_portal_memberships?')) return jsonResponse([records.membership]);
    if (target.includes('/rest/v1/client_contacts?')) return jsonResponse([records.contact]);
    if (target.includes('/rest/v1/clients?')) return jsonResponse([records.client]);
    if (target.endsWith('/rest/v1/rpc/reserve_client_account_setup_operation')) {
      return jsonResponse(hooks.reserve ? await hooks.reserve({ call, calls }) : claimedReservation());
    }
    if (target.endsWith(`/auth/v1/admin/users/${IDS.user}`) && method === 'GET') {
      if (hooks.authGet) return hooks.authGet({ call, calls, adminUser, setAdminUser });
      return jsonResponse(adminUser);
    }
    if (target.endsWith(`/auth/v1/admin/users/${IDS.user}`) && method === 'PUT') {
      if (hooks.authPut) return hooks.authPut({ call, calls, adminUser, setAdminUser });
      adminUser = { ...adminUser, app_metadata: body.app_metadata };
      return jsonResponse(adminUser);
    }
    if (target.endsWith('/rest/v1/rpc/confirm_client_account_setup_auth_commit')) {
      if (hooks.confirm) return jsonResponse(await hooks.confirm({ call, calls }));
      return jsonResponse({ confirmed: true });
    }
    if (target.endsWith('/rest/v1/rpc/finalize_client_account_setup_operation')) {
      const defaultValue = body.p_outcome === 'completed'
        ? completedResult(body.p_request_id)
        : {
            changed: false, status: body.p_action === 'complete_setup' ? 'invite_pending' : 'active',
            auditLogged: true, auditPending: false, requestId: body.p_request_id,
            code: body.p_failure_code,
            message: 'The password was not accepted. Choose a different password and try again.',
            statusCode: 400, retryable: false
          };
      return jsonResponse(hooks.finalize ? await hooks.finalize({ call, calls, defaultValue }) : defaultValue);
    }
    throw new Error(`Unexpected fetch ${method} ${target}`);
  };
  t.after(() => { global.fetch = originalFetch; });
  return { calls, getAdminUser: () => adminUser, setAdminUser };
}

function callsTo(calls, suffix, method = 'POST') {
  return calls.filter(call => call.method === method && call.target.endsWith(suffix));
}

test('completion input is exact, request-scoped, and accepts no caller-controlled identity', () => {
  assert.deepEqual(setup.parseBody({
    body: JSON.stringify({ action: 'complete_setup', newPassword: PASSWORD, requestId: IDS.request })
  }), { action: 'complete_setup', newPassword: PASSWORD, requestId: IDS.request });
  assert.throws(() => setup.parseBody({
    body: JSON.stringify({ action: 'complete_setup', newPassword: PASSWORD })
  }), /password completion fields/i);
  assert.throws(() => setup.parseBody({
    body: JSON.stringify({ action: 'complete_setup', newPassword: PASSWORD, requestId: IDS.request, userId: IDS.user })
  }), /Only the password completion fields/i);
  assert.throws(() => setup.parseBody({
    body: JSON.stringify({ action: 'complete_setup', newPassword: 'short', requestId: IDS.request })
  }), /between 12 and 128/i);
});

test('Client setup uses service RPCs for the pending audit and atomic gate, audit, and ledger finalization', async t => {
  const records = baseRecords();
  const { calls, getAdminUser } = installFetch(t, records);
  const response = await setup.handler(postEvent());

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), completedResult());
  const reserve = callsTo(calls, '/rest/v1/rpc/reserve_client_account_setup_operation')[0];
  const authGet = calls.findIndex(call => call.target.endsWith(`/auth/v1/admin/users/${IDS.user}`) && call.method === 'GET');
  const authPut = calls.findIndex(call => call.target.endsWith(`/auth/v1/admin/users/${IDS.user}`) && call.method === 'PUT');
  const finalize = callsTo(calls, '/rest/v1/rpc/finalize_client_account_setup_operation')[0];
  assert.ok(calls.indexOf(reserve) < authGet && authGet < authPut && authPut < calls.indexOf(finalize));
  assert.equal(reserve.body.p_actor_user_id, IDS.user);
  assert.equal(reserve.body.p_request_id, IDS.request);
  assert.equal(reserve.body.p_client_contact_id, IDS.contact);
  assert.equal(reserve.body.p_action, 'complete_setup');
  assert.equal(reserve.body.p_link_issued_at, records.access.initial_password_issued_at);
  assert.match(reserve.body.p_request_fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(reserve.body).includes(PASSWORD), false, 'RPC payload must not expose the password');
  assert.equal(calls.some(call => call.target.includes('/rest/v1/audit_events')), false);
  assert.equal(calls.some(call => call.target.includes('/rest/v1/platform_users?') && call.method === 'PATCH'), false);

  const passwordPut = calls[authPut];
  assert.equal(passwordPut.body.password, PASSWORD);
  assert.equal(passwordPut.body.app_metadata.provider, 'email');
  assert.deepEqual(passwordPut.body.app_metadata.providers, ['email']);
  assert.deepEqual(passwordPut.body.app_metadata.soro_client_password_operation, {
    request_id: IDS.request,
    request_fingerprint: reserve.body.p_request_fingerprint
  });
  assert.deepEqual(getAdminUser().app_metadata, passwordPut.body.app_metadata);
  const confirm = callsTo(calls, '/rest/v1/rpc/confirm_client_account_setup_auth_commit')[0];
  assert.equal(confirm.body.p_request_id, IDS.request);
  assert.ok(authPut < calls.indexOf(confirm) && calls.indexOf(confirm) < calls.indexOf(finalize));
  assert.equal(finalize.body.p_outcome, 'completed');
  assert.equal(finalize.body.p_lease_token, IDS.lease);
});

test('active Client recovery reserves the reset-link version and uses the recovery action', async t => {
  const resetSentAt = new Date(Date.now() - 60_000).toISOString();
  const records = baseRecords({
    access: { must_change_password: false, password_changed_at: resetSentAt },
    contact: {
      portal_access_status: 'active', portal_access_activated_at: resetSentAt,
      portal_last_password_reset_sent_at: resetSentAt
    }
  });
  const { calls } = installFetch(t, records);
  const response = await setup.handler(postEvent({ action: 'complete_recovery' }));
  assert.equal(response.statusCode, 200);
  const reserve = callsTo(calls, '/rest/v1/rpc/reserve_client_account_setup_operation')[0];
  assert.equal(reserve.body.p_action, 'complete_recovery');
  assert.equal(reserve.body.p_link_issued_at, resetSentAt);
  assert.equal(callsTo(calls, '/rest/v1/rpc/finalize_client_account_setup_operation')[0].body.p_action, 'complete_recovery');
});

test('a non-Client role fails before operation, password, or audit mutation', async t => {
  const { calls } = installFetch(t, baseRecords({ access: { role: 'sales' } }));
  const response = await setup.handler(postEvent());
  assert.equal(response.statusCode, 403);
  assert.equal(calls.some(call => call.method === 'PUT' || call.target.includes('/rpc/')), false);
});

test('a mismatched Client membership fails before operation, password, or audit mutation', async t => {
  const { calls } = installFetch(t, baseRecords({ membership: { organization_id: IDS.client } }));
  const response = await setup.handler(postEvent());
  assert.equal(response.statusCode, 403);
  assert.equal(calls.some(call => call.method === 'PUT' || call.target.includes('/rpc/')), false);
});

test('a secure-link email mismatch fails before all writes', async t => {
  const { calls } = installFetch(t, baseRecords({ contact: { portal_login_email: 'new-client@example.test' } }));
  const response = await setup.handler(postEvent());
  assert.equal(response.statusCode, 409);
  assert.equal(JSON.parse(response.body).code, 'login_email_mismatch');
  assert.equal(calls.some(call => call.method === 'PUT' || call.target.includes('/rpc/')), false);
});

test('a stale setup link fails before operation, Auth, or audit writes', async t => {
  const old = new Date(Date.now() - (setup.LINK_SESSION_MAX_AGE_SECONDS + 300) * 1000).toISOString();
  const records = baseRecords({ access: { initial_password_issued_at: old }, contact: { portal_invite_sent_at: old } });
  const token = tokenWithAmr('recovery', Math.floor(Date.now() / 1000) - setup.LINK_SESSION_MAX_AGE_SECONDS - 1);
  const { calls } = installFetch(t, records);
  const response = await setup.handler(postEvent({}, token));
  assert.equal(response.statusCode, 401);
  assert.equal(JSON.parse(response.body).code, 'secure_link_required');
  assert.equal(calls.some(call => call.method === 'PUT' || call.target.includes('/rpc/')), false);
});

test('an Auth password post-commit response loss is reconciled by trusted app_metadata and completes once', async t => {
  const { calls } = installFetch(t, baseRecords(), {
    authPut: ({ call, adminUser, setAdminUser }) => {
      setAdminUser({ ...adminUser, app_metadata: call.body.app_metadata });
      throw new TypeError('socket closed after commit');
    }
  });
  const response = await setup.handler(postEvent());
  assert.equal(response.statusCode, 200);
  assert.equal(callsTo(calls, '/rest/v1/rpc/confirm_client_account_setup_auth_commit').length, 1);
  assert.equal(callsTo(calls, '/rest/v1/rpc/finalize_client_account_setup_operation').length, 1);
  assert.equal(calls.filter(call => call.target.endsWith(`/auth/v1/admin/users/${IDS.user}`) && call.method === 'GET').length, 2);
  assert.equal(calls.filter(call => call.target.endsWith(`/auth/v1/admin/users/${IDS.user}`) && call.method === 'PUT').length, 1);
});

test('an ambiguous Auth result without a matching marker stays pending and never records a false failure', async t => {
  const { calls } = installFetch(t, baseRecords(), {
    authPut: () => { throw new TypeError('network failure'); }
  });
  const response = await setup.handler(postEvent());
  assert.equal(response.statusCode, 503);
  assert.deepEqual(JSON.parse(response.body), {
    code: 'password_action_pending', retryable: true,
    message: 'The password change is still being confirmed. Keep this page open and try Save new password again.'
  });
  assert.equal(callsTo(calls, '/rest/v1/rpc/finalize_client_account_setup_operation').length, 0);
});

test('a completed finalization whose response is lost replays the result without repeating Auth', async t => {
  let terminal = false;
  const { calls } = installFetch(t, baseRecords(), {
    reserve: () => terminal
      ? { state: 'completed', effectiveRequestId: IDS.request, result: completedResult() }
      : claimedReservation(),
    finalize: () => {
      terminal = true;
      throw new TypeError('RPC response lost after commit');
    }
  });
  assert.equal((await setup.handler(postEvent())).statusCode, 503);
  const second = await setup.handler(postEvent());
  assert.equal(second.statusCode, 200);
  assert.deepEqual(JSON.parse(second.body), completedResult());
  assert.equal(calls.filter(call => call.method === 'PUT' && call.target.includes('/auth/v1/admin/users/')).length, 1);
  assert.equal(callsTo(calls, '/rest/v1/rpc/finalize_client_account_setup_operation').length, 1);
});

test('a new submitted request id can alias and replay a completed semantic operation', async t => {
  let invocation = 0;
  const { calls } = installFetch(t, baseRecords(), {
    reserve: () => (++invocation === 1)
      ? claimedReservation()
      : { state: 'completed', effectiveRequestId: IDS.request, result: completedResult() }
  });
  assert.equal((await setup.handler(postEvent())).statusCode, 200);
  assert.equal((await setup.handler(postEvent({ requestId: IDS.request2 }))).statusCode, 200);
  const reserves = callsTo(calls, '/rest/v1/rpc/reserve_client_account_setup_operation');
  assert.equal(reserves[0].body.p_request_id, IDS.request);
  assert.equal(reserves[1].body.p_request_id, IDS.request2);
  assert.equal(reserves[0].body.p_request_fingerprint, reserves[1].body.p_request_fingerprint);
  assert.equal(calls.filter(call => call.method === 'PUT' && call.target.includes('/auth/v1/admin/users/')).length, 1);
});

test('a first-attempt deterministic Auth rejection terminalizes failed through the atomic RPC', async t => {
  const { calls } = installFetch(t, baseRecords(), {
    authPut: () => jsonResponse({ code: 'weak_password' }, 422)
  });
  const response = await setup.handler(postEvent());
  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).code, 'password_rejected');
  const finalizes = callsTo(calls, '/rest/v1/rpc/finalize_client_account_setup_operation');
  assert.equal(finalizes.length, 1);
  assert.equal(finalizes[0].body.p_outcome, 'failed');
  assert.equal(finalizes[0].body.p_failure_code, 'password_rejected');
});

test('a retry with a durable Auth commit checkpoint skips Auth and only finishes local state', async t => {
  const { calls } = installFetch(t, baseRecords(), {
    reserve: () => claimedReservation({ attemptCount: 2, resumed: true, authCommitConfirmed: true })
  });
  const response = await setup.handler(postEvent());
  assert.equal(response.statusCode, 200);
  assert.equal(calls.filter(call => call.target.includes('/auth/v1/admin/users/')).length, 0);
  assert.equal(callsTo(calls, '/rest/v1/rpc/confirm_client_account_setup_auth_commit').length, 0);
  assert.equal(callsTo(calls, '/rest/v1/rpc/finalize_client_account_setup_operation').length, 1);
});

test('migration keeps password operations private, aliased, retryable, and atomically terminalized', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260901_039_client_account_setup_idempotency.sql'), 'utf8');
  assert.match(sql, /create table if not exists public\.client_account_setup_operations/i);
  assert.match(sql, /create table if not exists public\.client_account_setup_operation_requests/i);
  assert.match(sql, /create unique index if not exists client_account_setup_semantic_request_unique/i);
  assert.match(sql, /create unique index if not exists client_account_setup_one_pending_per_user[\s\S]*where status = 'pending'/i);
  assert.match(sql, /alter table public\.client_account_setup_operations enable row level security/i);
  assert.match(sql, /revoke all on table public\.client_account_setup_operations from public, anon, authenticated, service_role/i);
  assert.match(sql, /create or replace function public\.reserve_client_account_setup_operation[\s\S]*insert into public\.audit_events[\s\S]*insert into public\.client_account_setup_operations/i);
  assert.match(sql, /create or replace function public\.finalize_client_account_setup_operation[\s\S]*update public\.platform_users[\s\S]*update public\.audit_events[\s\S]*update public\.client_account_setup_operations/i);
  assert.match(sql, /after_value = coalesce\(after_value, '\{\}'::jsonb\)[\s\S]*jsonb_build_object\('outcome', v_outcome\)/i);
  assert.match(sql, /create or replace function public\.confirm_client_account_setup_auth_commit/i);
  assert.match(sql, /auth_commit_confirmed_at is null[\s\S]*Client Auth password commit is not confirmed/i);
  assert.match(sql, /before an Auth commit[\s\S]*v_existing\.auth_commit_confirmed_at is not null/i);
  assert.doesNotMatch(sql, /new_password|password_digest|password_hash/i);
});

test('raw service failures are absent from password responses and logs', async t => {
  const originalFetch = global.fetch;
  const originalConsoleError = console.error;
  const privateDetail = 'private-client@example.test SECRET_AUTH_DIAGNOSTIC';
  const logs = [];
  global.fetch = async url => {
    if (String(url).endsWith('/auth/v1/user')) return jsonResponse({ id: IDS.user, email: 'client@example.test' });
    return jsonResponse({ message: privateDetail }, 400);
  };
  console.error = (...values) => { logs.push(values); };
  t.after(() => {
    global.fetch = originalFetch;
    console.error = originalConsoleError;
  });

  const response = await setup.handler(postEvent());
  const serialized = JSON.stringify({ body: JSON.parse(response.body), logs });
  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).code, 'request_failed');
  assert.equal(serialized.includes(privateDetail), false);
  assert.equal(serialized.includes('private-client@example.test'), false);
});
