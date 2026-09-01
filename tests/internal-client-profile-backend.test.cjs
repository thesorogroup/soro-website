const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

process.env.SUPABASE_URL = 'https://global-search-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const root = path.resolve(__dirname, '..');
const backend = require(path.join(root, 'netlify', 'functions', 'internal-client-profile.js'));

const userId = '11111111-1111-4111-8111-111111111111';
const clientId = '22222222-2222-4222-8222-222222222222';
const contactId = '33333333-3333-4333-8333-333333333333';

function response(data, status = 200) {
  return new Response(data === undefined ? '' : JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function event(overrides = {}) {
  return {
    httpMethod: 'GET',
    headers: { authorization: 'Bearer signed-in-employee-token' },
    queryStringParameters: { id: clientId },
    multiValueQueryStringParameters: {},
    rawQueryString: `id=${clientId}`,
    body: '',
    ...overrides
  };
}

function profile(overrides = {}) {
  return {
    clientId,
    companyName: 'Haven & Co.',
    industry: 'Legal services',
    lifecycleStage: 'active',
    company: {
      addressLine1: '100 Main Street',
      addressLine2: null,
      city: 'Dallas',
      stateRegion: 'Texas',
      postalCode: '75001',
      country: 'United States',
      phone: '+1 214 555 0100',
      website: 'https://haven.example/'
    },
    contacts: [{
      contactId,
      fullName: 'Avery Parker',
      email: 'avery@haven.example',
      phone: '+1 214 555 0199',
      contactRole: 'primary'
    }],
    ...overrides
  };
}

function installFetch(t, options = {}) {
  const { authStatus = 200, rpcStatus = 200, rpcBody = profile() } = options;
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, requestOptions = {}) => {
    const call = { url: String(url), options: requestOptions };
    calls.push(call);
    if (call.url.endsWith('/auth/v1/user')) return response({ id: userId }, authStatus);
    if (call.url.endsWith('/rest/v1/rpc/get_internal_client_profile')) return response(rpcBody, rpcStatus);
    throw new Error(`Unexpected fetch: ${call.url}`);
  };
  t.after(() => { global.fetch = originalFetch; });
  return calls;
}

function bodyOf(value) {
  return JSON.parse(value.body);
}

test('GET verifies the bearer identity and derives Client scope from the actor-scoped RPC', async t => {
  const calls = installFetch(t);
  const responseValue = await backend.handler(event());

  assert.equal(responseValue.statusCode, 200);
  assert.equal(responseValue.headers['Cache-Control'], 'no-store');
  assert.equal(responseValue.headers.Pragma, 'no-cache');
  assert.equal(responseValue.headers.Vary, 'Authorization');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer signed-in-employee-token');
  assert.equal(calls[1].url, 'https://global-search-test.supabase.co/rest/v1/rpc/get_internal_client_profile');
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    p_actor_user_id: userId,
    p_client_id: clientId
  });
  assert.equal(calls[1].options.headers.Authorization, 'Bearer test-service-role-key');
});

test('Client profile scope accepts exactly one valid UUID and no request body', async t => {
  const calls = installFetch(t);
  const invalid = [
    event({ queryStringParameters: {} }),
    event({ queryStringParameters: { id: 'not-a-uuid' } }),
    event({ queryStringParameters: { id: clientId, organizationId: userId } }),
    event({ multiValueQueryStringParameters: { id: [clientId, userId] } }),
    event({ body: JSON.stringify({ role: 'admin' }) })
  ];
  for (const request of invalid) {
    const rejected = await backend.handler(request);
    assert.equal(rejected.statusCode, 400);
    assert.equal(bodyOf(rejected).code, 'unsupported_scope');
  }
  assert.equal(calls.length, 0);
});

test('the public Client profile projection strips organization, owner, archive, and audit data', async t => {
  installFetch(t, {
    rpcBody: profile({
      organizationId: '44444444-4444-4444-8444-444444444444',
      salesOwnerId: userId,
      archivedAt: '2026-09-01T00:00:00.000Z',
      auditNotes: 'private audit note',
      company: {
        ...profile().company,
        protectedBillingField: 'private billing detail'
      },
      contacts: [{
        ...profile().contacts[0],
        active: true,
        internalNote: 'private contact note'
      }]
    })
  });
  const responseValue = await backend.handler(event());
  const body = bodyOf(responseValue);

  assert.equal(responseValue.statusCode, 200);
  assert.deepEqual(Object.keys(body), ['profile']);
  assert.deepEqual(Object.keys(body.profile).sort(), [
    'clientId', 'company', 'companyName', 'contacts', 'industry', 'lifecycleStage'
  ]);
  assert.deepEqual(Object.keys(body.profile.company).sort(), [
    'addressLine1', 'addressLine2', 'city', 'country', 'phone', 'postalCode', 'stateRegion', 'website'
  ]);
  assert.deepEqual(Object.keys(body.profile.contacts[0]).sort(), [
    'contactId', 'contactRole', 'email', 'fullName', 'phone'
  ]);
  for (const privateValue of [
    '44444444-4444-4444-8444-444444444444', userId, 'private audit note',
    'private billing detail', 'private contact note', 'archivedAt', 'salesOwnerId'
  ]) {
    assert.equal(responseValue.body.includes(privateValue), false, `must not expose ${privateValue}`);
  }
});

test('unsafe websites, duplicate contacts, too many contacts, and malformed payloads fail closed', async t => {
  const cases = [
    null,
    [],
    {},
    profile({ company: { ...profile().company, website: 'javascript:alert(1)' } }),
    profile({ contacts: [profile().contacts[0], profile().contacts[0]] }),
    profile({ contacts: Array.from({ length: 101 }, (_, index) => ({
      ...profile().contacts[0],
      contactId: `33333333-3333-4333-8333-333333333${String(index).padStart(3, '0')}`
    })) })
  ];
  for (const rpcBody of cases) {
    const calls = installFetch(t, { rpcBody });
    const responseValue = await backend.handler(event());
    assert.equal(responseValue.statusCode, 502);
    assert.equal(bodyOf(responseValue).code, 'client_profile_service_error');
    assert.equal(calls.filter(call => call.url.includes('/rpc/')).length, 1);
  }
});

test('portal roles and cross-organization or archived Client misses are safely translated', async t => {
  for (const [rpcBody, rpcStatus, status, code] of [
    [{ code: '42501', message: 'private role detail' }, 400, 403, 'client_profile_forbidden'],
    [{ code: 'P0002', message: 'private organization detail' }, 400, 404, 'client_profile_not_found'],
    [{ code: 'PGRST202', message: 'missing function' }, 404, 503, 'service_unavailable']
  ]) {
    const calls = installFetch(t, { rpcBody, rpcStatus });
    const responseValue = await backend.handler(event());
    assert.equal(responseValue.statusCode, status);
    assert.equal(bodyOf(responseValue).code, code);
    assert.equal(responseValue.body.includes('private'), false);
    assert.equal(calls.filter(call => call.url.includes('/rpc/')).length, 1);
  }
});

test('missing or invalid authentication and unsupported methods fail before profile reads', async t => {
  const calls = installFetch(t, { authStatus: 401 });
  const signedOut = await backend.handler(event({ headers: {} }));
  assert.equal(signedOut.statusCode, 401);
  assert.equal(calls.length, 0);

  const invalid = await backend.handler(event());
  assert.equal(invalid.statusCode, 401);
  assert.equal(calls.some(call => call.url.includes('/rpc/')), false);

  const before = calls.length;
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const responseValue = await backend.handler(event({ httpMethod: method }));
    assert.equal(responseValue.statusCode, 405);
    assert.equal(responseValue.headers.Allow, 'GET');
  }
  assert.equal(calls.length, before);
});
