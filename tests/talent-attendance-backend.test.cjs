const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

process.env.SUPABASE_URL = 'https://attendance-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const backend = require(path.join(__dirname, '..', 'netlify', 'functions', 'talent-attendance.js'));

const userId = '11111111-1111-4111-8111-111111111111';
const applicantId = '22222222-2222-4222-8222-222222222222';
const placementId = '33333333-3333-4333-8333-333333333333';
const sessionId = '44444444-4444-4444-8444-444444444444';
const requestId = '55555555-5555-4555-8555-555555555555';

function response(data, status = 200) {
  return new Response(data === undefined ? '' : JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function event(overrides = {}) {
  return {
    httpMethod: 'GET',
    headers: { authorization: 'Bearer signed-in-talent-token' },
    queryStringParameters: {},
    ...overrides
  };
}

function startedStatus(overrides = {}) {
  return {
    eligible: true,
    state: 'started',
    applicantId,
    placementId,
    sessionId,
    clientName: 'Brightlane Medical',
    scheduleSummary: 'Monday-Friday',
    workDate: '2026-08-29',
    workTimezone: 'Asia/Manila',
    startedAt: '2026-08-29T13:00:00.000Z',
    checkedOutAt: null,
    ...overrides
  };
}

function installFetch(t, options = {}) {
  const {
    user = { id: userId },
    authStatus = 200,
    rpcStatus = 200,
    rpcBody = startedStatus()
  } = options;
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, requestOptions = {}) => {
    const call = { url: String(url), options: requestOptions };
    calls.push(call);
    if (call.url.endsWith('/auth/v1/user')) {
      return response(
        typeof user === 'function' ? user() : user,
        typeof authStatus === 'function' ? authStatus() : authStatus
      );
    }
    if (call.url.includes('/rest/v1/rpc/')) {
      return response(
        typeof rpcBody === 'function' ? rpcBody() : rpcBody,
        typeof rpcStatus === 'function' ? rpcStatus() : rpcStatus
      );
    }
    throw new Error(`Unexpected fetch: ${call.url}`);
  };
  t.after(() => { global.fetch = originalFetch; });
  return calls;
}

function bodyOf(result) {
  return JSON.parse(result.body);
}

test('GET verifies the bearer user and requests only that user attendance status', async t => {
  const calls = installFetch(t, {
    rpcBody: {
      eligible: false,
      state: 'unmatched',
      workDate: '2026-08-29',
      workTimezone: 'Asia/Manila',
      unexpectedPrivateValue: 'must-not-leak'
    }
  });

  const result = await backend.handler(event());
  const body = bodyOf(result);

  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.headers.Pragma, 'no-cache');
  assert.equal(result.headers.Vary, 'Authorization');
  assert.equal(body.state, 'unmatched');
  assert.equal(body.eligible, false);
  assert.equal(JSON.stringify(body).includes('must-not-leak'), false);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://attendance-test.supabase.co/auth/v1/user');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer signed-in-talent-token');
  assert.equal(calls[1].url, 'https://attendance-test.supabase.co/rest/v1/rpc/get_talent_attendance_status');
  assert.deepEqual(JSON.parse(calls[1].options.body), { p_actor_user_id: userId });
  assert.equal(calls[1].options.headers.Authorization, 'Bearer test-service-role-key');
  assert.notEqual(calls[1].options.headers.Authorization, calls[0].options.headers.Authorization);
});

test('POST maps Start Day and Check Out to the service-only attendance RPC', async t => {
  const calls = installFetch(t);

  for (const action of ['start_day', 'check_out']) {
    const result = await backend.handler(event({
      httpMethod: 'POST',
      body: JSON.stringify({ action, requestId })
    }));
    assert.equal(result.statusCode, 200);
    assert.equal(bodyOf(result).state, 'started');
  }

  const rpcCalls = calls.filter(call => call.url.includes('/rest/v1/rpc/record_talent_attendance'));
  assert.equal(rpcCalls.length, 2);
  assert.deepEqual(JSON.parse(rpcCalls[0].options.body), {
    p_actor_user_id: userId,
    p_action: 'start_day',
    p_request_id: requestId
  });
  assert.deepEqual(JSON.parse(rpcCalls[1].options.body), {
    p_actor_user_id: userId,
    p_action: 'check_out',
    p_request_id: requestId
  });
});

test('POST requires exactly action and requestId and never accepts record scope or times', async t => {
  const calls = installFetch(t);
  const forbiddenBodies = [
    {},
    { action: 'start_day' },
    { action: 'start_day', requestId, applicantId },
    { action: 'start_day', requestId, placementId },
    { action: 'start_day', requestId, workDate: '2026-08-29' },
    { action: 'start_day', requestId, startedAt: '2026-08-29T13:00:00Z' },
    { action: 'start_day', requestId, checkedOutAt: '2026-08-29T21:00:00Z' }
  ];

  for (const body of forbiddenBodies) {
    const result = await backend.handler(event({ httpMethod: 'POST', body: JSON.stringify(body) }));
    assert.equal(result.statusCode, 400);
    assert.equal(bodyOf(result).code, 'unsupported_scope');
  }
  assert.equal(calls.length, 0);
});

test('POST rejects malformed JSON, non-object JSON, unsupported actions, and invalid request ids', async t => {
  const calls = installFetch(t);
  const requests = [
    { body: '{', code: 'invalid_request' },
    { body: '[]', code: 'invalid_request' },
    { body: JSON.stringify({ action: 'start', requestId }), code: 'unsupported_action' },
    { body: JSON.stringify({ action: 'start_day', requestId: 'not-a-uuid' }), code: 'invalid_request_id' }
  ];

  for (const request of requests) {
    const result = await backend.handler(event({ httpMethod: 'POST', body: request.body }));
    assert.equal(result.statusCode, 400);
    assert.equal(bodyOf(result).code, request.code);
  }
  assert.equal(calls.length, 0);
});

test('GET rejects query or body scope before authentication', async t => {
  const calls = installFetch(t);
  const query = await backend.handler(event({ queryStringParameters: { applicantId } }));
  const body = await backend.handler(event({ body: JSON.stringify({ placementId }) }));

  assert.equal(query.statusCode, 400);
  assert.equal(bodyOf(query).code, 'unsupported_scope');
  assert.equal(body.statusCode, 400);
  assert.equal(bodyOf(body).code, 'unsupported_scope');
  assert.equal(calls.length, 0);
});

test('authentication is required and invalid Auth responses never reach an RPC', async t => {
  let authStatus = 200;
  let user = { id: userId };
  const calls = installFetch(t, { authStatus: () => authStatus, user: () => user });
  const signedOut = await backend.handler(event({ headers: {} }));
  assert.equal(signedOut.statusCode, 401);
  assert.equal(bodyOf(signedOut).code, 'authentication_required');
  assert.equal(calls.length, 0);

  authStatus = 401;
  const invalid = await backend.handler(event());
  assert.equal(invalid.statusCode, 401);
  assert.equal(calls.some(call => call.url.includes('/rest/v1/rpc/')), false);

  authStatus = 200;
  user = { id: 'not-a-uuid' };
  const malformed = await backend.handler(event());
  assert.equal(malformed.statusCode, 401);
  assert.equal(calls.some(call => call.url.includes('/rest/v1/rpc/')), false);
});

test('database authorization and placement errors are mapped without leaking database detail', async t => {
  const cases = [
    { rpcBody: { code: '42501', message: 'private database role detail' }, expectedStatus: 403, expectedCode: 'attendance_forbidden' },
    { rpcBody: { code: 'P0001', message: 'private placement row detail' }, expectedStatus: 409, expectedCode: 'attendance_unavailable' },
    { rpcBody: { code: '21000', message: 'private duplicate profile detail' }, expectedStatus: 409, expectedCode: 'attendance_needs_review' },
    { rpcBody: { code: 'XX000', message: 'private database failure detail' }, expectedStatus: 500, expectedCode: 'attendance_service_error' }
  ];

  let currentCase = cases[0];
  const calls = installFetch(t, {
    rpcStatus: () => 400,
    rpcBody: () => currentCase.rpcBody
  });
  for (const item of cases) {
    currentCase = item;
    const callsBefore = calls.length;
    const result = await backend.handler(event());
    const body = bodyOf(result);
    assert.equal(result.statusCode, item.expectedStatus);
    assert.equal(body.code, item.expectedCode);
    assert.equal(result.body.includes('private'), false);
    assert.equal(calls.slice(callsBefore).filter(call => call.url.includes('/rest/v1/rpc/')).length, 1);
  }
});

test('malformed successful RPC payloads fail closed', async t => {
  installFetch(t, { rpcBody: ['not', 'an', 'object'] });
  const arrayResult = await backend.handler(event());
  assert.equal(arrayResult.statusCode, 502);
  assert.equal(bodyOf(arrayResult).code, 'attendance_service_error');
});

test('unsupported methods return an explicit allowlist and never authenticate', async t => {
  const calls = installFetch(t);
  for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const result = await backend.handler(event({ httpMethod: method }));
    assert.equal(result.statusCode, 405);
    assert.equal(result.headers.Allow, 'GET, POST');
    assert.equal(result.headers['Cache-Control'], 'no-store');
  }
  assert.equal(calls.length, 0);
});

test('UUID and exact-key validators enforce the public request contract', () => {
  assert.equal(backend.validUuid(requestId), true);
  assert.equal(backend.validUuid('55555555-5555-0555-8555-555555555555'), false);
  assert.equal(backend.validUuid('55555555-5555-4555-0555-555555555555'), false);
  assert.equal(backend.hasExactKeys({ requestId, action: 'start_day' }, backend.POST_BODY_KEYS), true);
  assert.equal(backend.hasExactKeys({ requestId, action: 'start_day', date: '2026-08-29' }, backend.POST_BODY_KEYS), false);
});
