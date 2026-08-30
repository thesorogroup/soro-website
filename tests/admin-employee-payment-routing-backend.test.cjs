const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

process.env.SUPABASE_URL = 'https://employee-routing-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const root = path.resolve(__dirname, '..');
const backend = require(path.join(root, 'netlify', 'functions', 'admin-employees.js'));

const actorId = '11111111-1111-4111-8111-111111111111';
const organizationId = '22222222-2222-4222-8222-222222222222';
const employeeId = '33333333-3333-4333-8333-333333333333';
const auditId = '44444444-4444-4444-8444-444444444444';

function response(data, status = 200) {
  return new Response(data === undefined ? '' : JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function token({ recent = true } = {}) {
  const timestamp = Math.floor(Date.now() / 1000) - (recent ? 30 : 600);
  return [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify({ amr: [{ method: 'password', timestamp }] })).toString('base64url'),
    'signature'
  ].join('.');
}

function event(body, accessToken = token()) {
  return {
    httpMethod: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body)
  };
}

function createBody(overrides = {}) {
  return {
    action: 'create_employee',
    fullName: 'Jordan Reed',
    email: 'jordan@soro.example',
    phone: '+1 555 555 0100',
    hireDate: '2026-08-20',
    role: 'sales',
    addressLine1: '100 Main Street',
    addressLine2: '',
    city: 'Austin',
    stateRegion: 'Texas',
    postalCode: '78701',
    country: 'United States',
    paymentRoute: 'quickbooks_employee',
    payoutRecipientEmail: null,
    ...overrides
  };
}

function installAdminFetch(t, resolver) {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const call = { url: String(url), options };
    calls.push(call);
    if (call.url.endsWith('/auth/v1/user')) return response({ id: actorId, email: 'admin@soro.example' });
    if (call.url.includes('/rest/v1/platform_users?id=eq.') && (options.method || 'GET') === 'GET') {
      return response([{ id: actorId, organization_id: organizationId, role: 'admin', active: true, must_change_password: false }]);
    }
    const resolved = await resolver(call);
    if (resolved instanceof Response) return resolved;
    return response(resolved);
  };
  t.after(() => { global.fetch = originalFetch; });
  return calls;
}

function resultBody(result) {
  return JSON.parse(result.body);
}

test('new employees persist an explicit payment route and never infer it from country', async t => {
  let profileWrite;
  installAdminFetch(t, call => {
    const method = call.options.method || 'GET';
    if (call.url.endsWith('/auth/v1/admin/users') && method === 'POST') return { id: employeeId };
    if (call.url.endsWith('/rest/v1/platform_users') && method === 'POST') return undefined;
    if (call.url.endsWith('/rest/v1/employee_profiles') && method === 'POST') {
      profileWrite = JSON.parse(call.options.body);
      return undefined;
    }
    if (call.url.includes('/rest/v1/audit_events?select=id') && method === 'POST') return [{ id: auditId }];
    if (call.url.includes('/rest/v1/platform_users?id=eq.') && method === 'PATCH') return undefined;
    if (call.url.includes('/rest/v1/audit_events?id=eq.') && method === 'PATCH') return undefined;
    throw new Error(`Unexpected request ${method} ${call.url}`);
  });

  const result = await backend.handler(event(createBody({
    country: 'Philippines',
    paymentRoute: 'quickbooks_employee',
    payoutRecipientEmail: 'stale@example.com'
  })));

  assert.equal(result.statusCode, 201);
  assert.equal(profileWrite.payment_route, 'quickbooks_employee');
  assert.equal(profileWrite.payout_recipient_email, null);
  assert.equal(resultBody(result).employee.paymentRoute, 'quickbooks_employee');
  assert.equal(resultBody(result).employee.payoutRecipientEmail, null);
});
test('create accepts only allowlisted profile keys and Wise routing requires a valid recipient', async t => {
  const calls = installAdminFetch(t, () => { throw new Error('Invalid input must not authenticate.'); });
  const extraScope = await backend.handler(event(createBody({ organizationId })));
  assert.equal(extraScope.statusCode, 400);
  assert.equal(resultBody(extraScope).code, 'unsupported_scope');

  const missingRecipient = await backend.handler(event(createBody({ paymentRoute: 'wise_contractor', payoutRecipientEmail: null })));
  assert.equal(missingRecipient.statusCode, 400);
  assert.match(resultBody(missingRecipient).message, /Wise payout recipient email/i);
  assert.equal(calls.length, 2, 'valid-scope field validation may authenticate, but extra scope must be rejected first');
});

test('payment-route updates are exact, recently reauthenticated, same-organization, and audit only changed field names', async t => {
  let auditIntent;
  let profilePatch;
  const calls = installAdminFetch(t, call => {
    const method = call.options.method || 'GET';
    if (call.url.includes('/rest/v1/employee_profiles?user_id=eq.') && method === 'GET') {
      return [{ user_id: employeeId, payment_route: 'needs_setup', payout_recipient_email: null }];
    }
    if (call.url.includes('/rest/v1/audit_events?select=id') && method === 'POST') {
      auditIntent = JSON.parse(call.options.body);
      return [{ id: auditId }];
    }
    if (call.url.includes('/rest/v1/employee_profiles?user_id=eq.') && method === 'PATCH') {
      profilePatch = JSON.parse(call.options.body);
      return [{ user_id: employeeId, payment_route: profilePatch.payment_route, payout_recipient_email: profilePatch.payout_recipient_email }];
    }
    if (call.url.includes('/rest/v1/audit_events?id=eq.') && method === 'PATCH') return undefined;
    throw new Error(`Unexpected request ${method} ${call.url}`);
  });

  const request = {
    action: 'update_employee_payment_route',
    userId: employeeId,
    paymentRoute: 'wise_contractor',
    payoutRecipientEmail: 'Jordan.Wise@example.com'
  };
  const result = await backend.handler(event(request));

  assert.equal(result.statusCode, 200);
  assert.deepEqual(profilePatch, { payment_route: 'wise_contractor', payout_recipient_email: 'jordan.wise@example.com' });
  assert.match(calls.find(call => call.url.includes('/rest/v1/employee_profiles?user_id=eq.') && (call.options.method || 'GET') === 'GET').url, new RegExp(`organization_id=eq\\.${organizationId}`));
  assert.deepEqual(auditIntent.after_value.changed_fields, ['payment_route', 'payout_recipient_email']);
  assert.equal(JSON.stringify(auditIntent).includes('wise_contractor'), false);
  assert.equal(JSON.stringify(auditIntent).includes('jordan.wise@example.com'), false);
});

test('payment-route update rejects extra scope before authentication and rejects stale reauthentication', async t => {
  let calls = installAdminFetch(t, () => { throw new Error('Extra scope must not authenticate.'); });
  const extra = await backend.handler(event({
    action: 'update_employee_payment_route',
    userId: employeeId,
    paymentRoute: 'quickbooks_employee',
    payoutRecipientEmail: null,
    organizationId
  }));
  assert.equal(extra.statusCode, 400);
  assert.equal(calls.length, 0);

  calls = installAdminFetch(t, () => { throw new Error('Stale reauthentication must stop before employee lookup.'); });
  const stale = await backend.handler(event({
    action: 'update_employee_payment_route',
    userId: employeeId,
    paymentRoute: 'quickbooks_employee',
    payoutRecipientEmail: null
  }, token({ recent: false })));
  assert.equal(stale.statusCode, 401);
  assert.equal(resultBody(stale).code, 'reauthentication_required');
  assert.equal(calls.length, 2);
});
