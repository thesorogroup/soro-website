const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

process.env.SUPABASE_URL = 'https://global-search-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const root = path.resolve(__dirname, '..');
const backend = require(path.join(root, 'netlify', 'functions', 'global-search.js'));

const userId = '11111111-1111-4111-8111-111111111111';
const clientId = '22222222-2222-4222-8222-222222222222';
const applicantId = '33333333-3333-4333-8333-333333333333';

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
    queryStringParameters: { q: 'mel' },
    multiValueQueryStringParameters: {},
    rawQueryString: 'q=mel',
    body: '',
    ...overrides
  };
}

function result(entityType, overrides = {}) {
  return {
    entityType,
    recordId: entityType === 'client' ? clientId : applicantId,
    primaryLabel: entityType === 'client' ? 'Melliza Health' : 'Santos, Melliza Anne',
    secondaryLabel: entityType === 'client' ? 'Healthcare' : 'Goes by Mel',
    statusLabel: entityType === 'client' ? 'active' : 'in_review',
    matchedOn: entityType === 'client' ? 'company_name' : 'name',
    ...overrides
  };
}

function payload(overrides = {}) {
  return {
    query: 'mel',
    clients: [result('client')],
    talent: [result('talent')],
    ...overrides
  };
}

function installFetch(t, options = {}) {
  const {
    user = { id: userId },
    authStatus = 200,
    rpcStatus = 200,
    rpcBody = payload()
  } = options;
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, requestOptions = {}) => {
    const call = { url: String(url), options: requestOptions };
    calls.push(call);
    if (call.url.endsWith('/auth/v1/user')) return response(user, authStatus);
    if (call.url.endsWith('/rest/v1/rpc/search_operations_directory')) return response(rpcBody, rpcStatus);
    throw new Error(`Unexpected fetch: ${call.url}`);
  };
  t.after(() => { global.fetch = originalFetch; });
  return calls;
}

function bodyOf(value) {
  return JSON.parse(value.body);
}

test('GET verifies the bearer identity and calls only the actor-scoped search RPC', async t => {
  const calls = installFetch(t);
  const responseValue = await backend.handler(event());

  assert.equal(responseValue.statusCode, 200);
  assert.equal(responseValue.headers['Cache-Control'], 'no-store');
  assert.equal(responseValue.headers.Pragma, 'no-cache');
  assert.equal(responseValue.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(responseValue.headers['Referrer-Policy'], 'no-referrer');
  assert.equal(responseValue.headers.Vary, 'Authorization');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://global-search-test.supabase.co/auth/v1/user');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer signed-in-employee-token');
  assert.equal(calls[1].url, 'https://global-search-test.supabase.co/rest/v1/rpc/search_operations_directory');
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    p_actor_user_id: userId,
    p_query: 'mel'
  });
  assert.equal(calls[1].options.headers.Authorization, 'Bearer test-service-role-key');
});

test('search accepts exactly one normalized 2-to-100 character query', async t => {
  const calls = installFetch(t, { rpcBody: payload({ query: 'mel liza' }) });
  const accepted = await backend.handler(event({
    queryStringParameters: { q: '  Mel   Liza  ' },
    rawQueryString: 'q=%20%20Mel%20%20%20Liza%20%20'
  }));
  assert.equal(accepted.statusCode, 200);
  assert.equal(bodyOf(accepted).query, 'Mel Liza');
  assert.equal(JSON.parse(calls[1].options.body).p_query, 'Mel Liza');

  const before = calls.length;
  const invalid = [
    event({ queryStringParameters: {} }),
    event({ queryStringParameters: { q: 'm' } }),
    event({ queryStringParameters: { q: 'x'.repeat(101) } }),
    event({ queryStringParameters: { q: 'me\nll' } }),
    event({ queryStringParameters: { q: 'mel', role: 'admin' } }),
    event({ queryStringParameters: { q: 'mel' }, multiValueQueryStringParameters: { q: ['mel', 'melliza'] } }),
    event({ queryStringParameters: { q: 'mel' }, body: JSON.stringify({ organizationId: clientId }) })
  ];
  for (const request of invalid) {
    const rejected = await backend.handler(request);
    assert.equal(rejected.statusCode, 400);
  }
  assert.equal(calls.length, before, 'invalid scope must fail before authentication');
});

test('literal wildcard and quote characters are passed as text, never client-selected PostgREST syntax', async t => {
  const calls = installFetch(t, { rpcBody: { query: "mel%_\\'", clients: [], talent: [] } });
  const responseValue = await backend.handler(event({
    queryStringParameters: { q: "mel%_\\'" },
    rawQueryString: 'q=mel%25_%5C%27'
  }));

  assert.equal(responseValue.statusCode, 200);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    p_actor_user_id: userId,
    p_query: "mel%_\\'"
  });
});

test('the public payload is an exact allowlist and strips private upstream fields', async t => {
  installFetch(t, {
    rpcBody: payload({
      organizationId: '44444444-4444-4444-8444-444444444444',
      clients: [result('client', {
        organizationId: '44444444-4444-4444-8444-444444444444',
        contactEmail: 'private-client@example.com',
        contactPhone: '+1 555 0100',
        address: 'Private address'
      })],
      talent: [result('talent', {
        authUserId: userId,
        birthDate: '1998-01-10',
        genderIdentity: 'private',
        statusReason: 'private note'
      })]
    })
  });
  const responseValue = await backend.handler(event());
  const body = bodyOf(responseValue);

  assert.equal(responseValue.statusCode, 200);
  assert.deepEqual(Object.keys(body).sort(), ['clients', 'query', 'talent']);
  assert.deepEqual(Object.keys(body.clients[0]).sort(), [
    'entityType', 'matchedOn', 'primaryLabel', 'recordId', 'secondaryLabel', 'statusLabel'
  ]);
  assert.deepEqual(Object.keys(body.talent[0]).sort(), [
    'entityType', 'matchedOn', 'primaryLabel', 'recordId', 'secondaryLabel', 'statusLabel'
  ]);
  for (const privateValue of [
    'private-client@example.com', '+1 555 0100', 'Private address',
    '1998-01-10', 'private note', userId, '44444444-4444-4444-8444-444444444444'
  ]) {
    assert.equal(responseValue.body.includes(privateValue), false, `must not expose ${privateValue}`);
  }
});

test('client-only role results remain valid while each group is capped at five', async t => {
  installFetch(t, { rpcBody: { query: 'ha', clients: [result('client')], talent: [] } });
  const clientOnly = await backend.handler(event({ queryStringParameters: { q: 'ha' }, rawQueryString: 'q=ha' }));
  assert.equal(clientOnly.statusCode, 200);
  assert.equal(bodyOf(clientOnly).clients.length, 1);
  assert.deepEqual(bodyOf(clientOnly).talent, []);

  const original = global.fetch;
  global.fetch = async url => String(url).endsWith('/auth/v1/user')
    ? response({ id: userId })
    : response({ query: 'mel', clients: Array.from({ length: 6 }, (_, index) => result('client', {
      recordId: `22222222-2222-4222-8222-22222222222${index}`
    })), talent: [] });
  const tooMany = await backend.handler(event());
  global.fetch = original;
  assert.equal(tooMany.statusCode, 502);
  assert.equal(bodyOf(tooMany).code, 'search_service_error');
});

test('malformed, duplicate, and unapproved result fields fail closed', async t => {
  const cases = [
    null,
    [],
    {},
    { query: 'mel', clients: {}, talent: [] },
    { query: 'mel', clients: [result('client', { entityType: 'talent' })], talent: [] },
    { query: 'mel', clients: [result('client', { matchedOn: 'address' })], talent: [] },
    { query: 'mel', clients: [result('client'), result('client')], talent: [] }
  ];
  for (const rpcBody of cases) {
    const calls = installFetch(t, { rpcBody });
    const responseValue = await backend.handler(event());
    assert.equal(responseValue.statusCode, 502);
    assert.equal(calls.filter(call => call.url.includes('/rpc/')).length, 1);
  }
});

test('missing, invalid, portal-role, and unavailable sessions never receive search results', async t => {
  const calls = installFetch(t, { authStatus: 401 });
  const signedOut = await backend.handler(event({ headers: {} }));
  assert.equal(signedOut.statusCode, 401);
  assert.equal(calls.length, 0);

  const invalid = await backend.handler(event());
  assert.equal(invalid.statusCode, 401);
  assert.equal(calls.some(call => call.url.includes('/rpc/')), false);

  const original = global.fetch;
  global.fetch = async url => String(url).endsWith('/auth/v1/user')
    ? response({ id: userId })
    : response({ code: '42501', message: 'private role and organization detail' }, 400);
  const forbidden = await backend.handler(event());
  global.fetch = original;
  assert.equal(forbidden.statusCode, 403);
  assert.equal(bodyOf(forbidden).code, 'search_forbidden');
  assert.equal(forbidden.body.includes('private role'), false);
});

test('database validation and missing RPC errors are safely translated', async t => {
  for (const [rpcBody, rpcStatus, status, code] of [
    [{ code: '22023', message: 'private query detail' }, 400, 400, 'invalid_query'],
    [{ code: 'PGRST202', message: 'function missing' }, 404, 503, 'service_unavailable'],
    [{ code: 'XX000', message: 'private database detail' }, 500, 500, 'search_service_error']
  ]) {
    const calls = installFetch(t, { rpcBody, rpcStatus });
    const responseValue = await backend.handler(event());
    assert.equal(responseValue.statusCode, status);
    assert.equal(bodyOf(responseValue).code, code);
    assert.equal(responseValue.body.includes('private'), false);
    assert.equal(calls.filter(call => call.url.includes('/rpc/')).length, 1);
  }
});

test('unsupported methods never authenticate', async t => {
  const calls = installFetch(t);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const responseValue = await backend.handler(event({ httpMethod: method }));
    assert.equal(responseValue.statusCode, 405);
    assert.equal(responseValue.headers.Allow, 'GET');
  }
  assert.equal(calls.length, 0);
});
