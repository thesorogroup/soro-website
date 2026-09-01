const assert = require('node:assert/strict');
const test = require('node:test');

process.env.SUPABASE_URL = 'https://client-shortlists-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const backend = require('../netlify/functions/client-shortlists.js');

const userId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const hiringRequestId = '33333333-3333-4333-8333-333333333333';
const clientId = '44444444-4444-4444-8444-444444444444';
const shortlistId = '55555555-5555-4555-8555-555555555555';
const shortlistItemId = '66666666-6666-4666-8666-666666666666';
const applicantId = '77777777-7777-4777-8777-777777777777';
const salesOwnerId = '88888888-8888-4888-8888-888888888888';
const updatedAt = '2026-09-01T17:30:00.000Z';

function response(data, status = 200) {
  return new Response(data === undefined ? '' : JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function event(method = 'GET', overrides = {}) {
  return {
    httpMethod: method,
    headers: { authorization: 'Bearer signed-in-shortlist-token' },
    ...overrides
  };
}

function rawClientCandidate(overrides = {}) {
  return {
    applicantId,
    displayName: 'Jordan Rivera',
    country: 'Philippines',
    timeZone: 'Asia/Manila',
    verifiedSkills: ['Medical coding', 'Insurance claims'],
    yearsExperience: 4.5,
    experienceSummary: 'Medical back-office support.',
    educationAndTraining: 'Certified coding coursework.',
    screening: {
      englishResult: '95 practice',
      personalityResult: 'INFJ-A',
      computerSpecifications: 'MacBook Air, 16 GB',
      internetSpeed: '100 Mbps download, 40 Mbps upload',
      privateAssessment: 'SECRET ASSESSMENT'
    },
    email: 'secret@example.com',
    phone: '+63 secret',
    preferredName: 'SECRET PREFERRED NAME',
    availability: 'SECRET AVAILABILITY',
    rateLabel: 'SECRET RATE',
    resumeUrl: 'https://private.example/resume',
    internalNotes: 'SECRET INTERNAL NOTE',
    supportNotes: 'SECRET SUPPORT NOTE',
    salesOwnerId,
    ...overrides
  };
}

function rawPayload(role = 'client_reviewer', overrides = {}) {
  const internal = ['admin', 'sales_management', 'sales'].includes(role);
  const sent = !internal;
  const item = {
    shortlistItemId,
    applicantId,
    candidate: rawClientCandidate(),
    response: null,
    respondedAt: null,
    addedAt: '2026-09-01T17:00:00.000Z',
    updatedAt,
    canRemove: internal,
    canRespond: !internal
  };
  const shortlist = {
    shortlistId,
    hiringRequestId,
    clientId,
    clientName: 'Northstar Legal',
    requestTitle: 'Legal Operations Assistant',
    roundNumber: 1,
    status: sent ? 'sent' : 'draft',
    sentAt: sent ? '2026-09-01T17:10:00.000Z' : null,
    updatedAt,
    salesOwnerId,
    canSend: internal,
    items: [item]
  };
  return {
    generatedAt: '2026-09-01T17:35:00.000Z',
    viewerRole: role,
    requests: [{
      hiringRequestId,
      clientId,
      clientName: 'Northstar Legal',
      title: 'Legal Operations Assistant',
      status: 'matching',
      startDate: '2026-10-01',
      numberOfTalent: 1,
      canAddCandidate: internal
    }],
    candidates: internal ? [{
      applicantId,
      displayName: 'Jordan',
      stage: 'bench_ready',
      verifiedSkills: ['Medical coding'],
      yearsExperience: 4.5,
      availability: 'Full time',
      salesOwnerId,
      updatedAt
    }] : [],
    shortlists: [shortlist],
    notifications: [],
    ...overrides
  };
}

function installFetch(t, { payload = rawPayload('sales'), rpcError = null } = {}) {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const value = String(url);
    calls.push({ url: value, options });
    if (value.endsWith('/auth/v1/user')) return response({ id: userId });
    if (value.includes('/rest/v1/rpc/')) {
      if (rpcError) return response(rpcError.body, rpcError.status);
      return response(payload);
    }
    throw new Error(`Unexpected fetch: ${value}`);
  };
  t.after(() => { global.fetch = originalFetch; });
  return calls;
}

function bodyOf(result) {
  return JSON.parse(result.body);
}

test('handler exports only the approved roles, actions, and Client responses', () => {
  assert.deepEqual([...backend.INTERNAL_ROLES].sort(), ['admin', 'sales', 'sales_management']);
  assert.deepEqual([...backend.CLIENT_REVIEW_ROLES].sort(), ['client_admin', 'client_reviewer']);
  assert.deepEqual([...backend.VIEWER_ROLES].sort(), [
    'admin', 'client_admin', 'client_reviewer', 'sales', 'sales_management'
  ]);
  assert.deepEqual([...backend.ACTIONS].sort(), [
    'add_candidate', 'remove_candidate', 'respond_candidate', 'send_shortlist'
  ]);
  assert.deepEqual([...backend.RESPONSES].sort(), ['interested', 'not_a_fit', 'request_interview']);
  for (const role of ['talent_management', 'billing', 'client_billing', 'virtual_assistant']) {
    assert.equal(backend.VIEWER_ROLES.has(role), false);
  }
});

test('each action accepts its exact shape and requires a request id plus current entity timestamp', () => {
  assert.deepEqual(backend.inputActionBody({
    action: 'add_candidate', requestId, expectedUpdatedAt: updatedAt,
    hiringRequestId, applicantId
  }), {
    action: 'add_candidate', requestId, expectedUpdatedAt: updatedAt,
    hiringRequestId, applicantId, shortlistId: null, shortlistItemId: null, response: null
  });
  assert.deepEqual(backend.inputActionBody({
    action: 'remove_candidate', requestId, expectedUpdatedAt: updatedAt, shortlistItemId
  }), {
    action: 'remove_candidate', requestId, expectedUpdatedAt: updatedAt,
    hiringRequestId: null, applicantId: null, shortlistId: null, shortlistItemId, response: null
  });
  assert.deepEqual(backend.inputActionBody({
    action: 'send_shortlist', requestId, expectedUpdatedAt: updatedAt, shortlistId
  }), {
    action: 'send_shortlist', requestId, expectedUpdatedAt: updatedAt,
    hiringRequestId: null, applicantId: null, shortlistId, shortlistItemId: null, response: null
  });
  assert.deepEqual(backend.inputActionBody({
    action: 'respond_candidate', requestId, expectedUpdatedAt: updatedAt,
    shortlistItemId, response: 'request_interview'
  }), {
    action: 'respond_candidate', requestId, expectedUpdatedAt: updatedAt,
    hiringRequestId: null, applicantId: null, shortlistId: null,
    shortlistItemId, response: 'request_interview'
  });

  assert.throws(() => backend.inputActionBody({
    action: 'send_shortlist', requestId, expectedUpdatedAt: updatedAt, shortlistId, clientId
  }), error => error.code === 'unsupported_scope');
  assert.throws(() => backend.inputActionBody({
    action: 'send_shortlist', requestId, shortlistId
  }), error => error.code === 'unsupported_scope');
  assert.throws(() => backend.inputActionBody({
    action: 'respond_candidate', requestId, expectedUpdatedAt: updatedAt,
    shortlistItemId, response: 'approve'
  }), error => error.code === 'invalid_response');
});

test('Client candidate mapping is an exact allowlist and strips all unexpected private values', () => {
  const mapped = backend.publicClientCandidate(rawClientCandidate());
  assert.deepEqual(Object.keys(mapped).sort(), [
    'applicantId', 'country', 'displayName', 'educationAndTraining', 'experienceSummary',
    'screening', 'timeZone', 'verifiedSkills', 'yearsExperience'
  ]);
  assert.deepEqual(Object.keys(mapped.screening).sort(), [
    'computerSpecifications', 'englishResult', 'internetSpeed', 'personalityResult'
  ]);
  const serialized = JSON.stringify(mapped);
  for (const secret of [
    'secret@example.com', '+63 secret', 'SECRET PREFERRED NAME', 'SECRET AVAILABILITY',
    'SECRET RATE', 'private.example', 'SECRET INTERNAL NOTE', 'SECRET SUPPORT NOTE',
    'SECRET ASSESSMENT', salesOwnerId
  ]) assert.equal(serialized.includes(secret), false, `Client candidate leaked ${secret}`);
});

test('Client payload excludes internal candidate inventory and Sales owner identifiers', () => {
  const raw = rawPayload('client_admin');
  raw.candidates = [{ applicantId, email: 'should-never-map@example.com' }];
  assert.throws(() => backend.publicPayload(raw), error => error.code === 'shortlist_service_error');

  raw.candidates = [];
  const mapped = backend.publicPayload(raw);
  assert.deepEqual(mapped.candidates, []);
  assert.equal(Object.prototype.hasOwnProperty.call(mapped.shortlists[0], 'salesOwnerId'), false);
  const serialized = JSON.stringify(mapped);
  for (const secret of [
    'secret@example.com', 'SECRET PREFERRED NAME', 'SECRET AVAILABILITY',
    'SECRET RATE', 'private.example', 'SECRET INTERNAL NOTE', salesOwnerId
  ]) assert.equal(serialized.includes(secret), false, `Client workspace leaked ${secret}`);
});

test('GET derives scope from the token and invokes only the actor-scoped read RPC', async t => {
  const calls = installFetch(t, { payload: rawPayload('client_reviewer') });
  const result = await backend.handler(event('GET'));
  assert.equal(result.statusCode, 200);
  assert.match(result.headers['Cache-Control'], /no-store/i);

  const rpc = calls.find(call => call.url.includes('/rest/v1/rpc/'));
  assert.match(rpc.url, /\/rest\/v1\/rpc\/get_client_shortlist_workspace$/);
  assert.deepEqual(JSON.parse(rpc.options.body), { p_actor_user_id: userId });
  const serialized = result.body;
  assert.equal(serialized.includes('secret@example.com'), false);
  assert.equal(serialized.includes(salesOwnerId), false);
});

test('POST passes the exact mutation fields and never accepts caller-selected organization or Client scope', async t => {
  const calls = installFetch(t, { payload: rawPayload('sales') });
  const result = await backend.handler(event('POST', {
    body: JSON.stringify({
      action: 'respond_candidate', requestId, expectedUpdatedAt: updatedAt,
      shortlistItemId, response: 'not_a_fit'
    })
  }));
  assert.equal(result.statusCode, 200);
  const rpc = calls.find(call => call.url.includes('/rest/v1/rpc/change_client_shortlist'));
  assert.deepEqual(JSON.parse(rpc.options.body), {
    p_actor_user_id: userId,
    p_request_id: requestId,
    p_action: 'respond_candidate',
    p_expected_updated_at: updatedAt,
    p_hiring_request_id: null,
    p_applicant_id: null,
    p_shortlist_id: null,
    p_shortlist_item_id: shortlistItemId,
    p_response: 'not_a_fit'
  });

  const scoped = await backend.handler(event('POST', {
    body: JSON.stringify({
      action: 'send_shortlist', requestId, expectedUpdatedAt: updatedAt,
      shortlistId, clientId
    })
  }));
  assert.equal(scoped.statusCode, 400);
  assert.equal(bodyOf(scoped).code, 'unsupported_scope');
});

test('query/body scope, missing auth, forbidden actor, and stale changes fail closed', async t => {
  const query = await backend.handler(event('GET', { queryStringParameters: { clientId } }));
  assert.equal(query.statusCode, 400);
  assert.equal(bodyOf(query).code, 'unsupported_scope');

  const body = await backend.handler(event('GET', { body: JSON.stringify({ shortlistId }) }));
  assert.equal(body.statusCode, 400);
  assert.equal(bodyOf(body).code, 'unsupported_scope');

  const signedOut = await backend.handler({ httpMethod: 'GET', headers: {} });
  assert.equal(signedOut.statusCode, 401);
  assert.equal(bodyOf(signedOut).code, 'authentication_required');

  installFetch(t, { rpcError: { status: 400, body: { code: '42501', message: 'denied' } } });
  const forbidden = await backend.handler(event('GET'));
  assert.equal(forbidden.statusCode, 403);
  assert.equal(bodyOf(forbidden).code, 'shortlist_forbidden');

  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/auth/v1/user')) return response({ id: userId });
    return response({ code: 'P0001', message: 'changed after it was opened' }, 400);
  };
  t.after(() => { global.fetch = originalFetch; });
  const stale = await backend.handler(event('POST', {
    body: JSON.stringify({ action: 'send_shortlist', requestId, expectedUpdatedAt: updatedAt, shortlistId })
  }));
  assert.equal(stale.statusCode, 409);
  assert.equal(bodyOf(stale).code, 'shortlist_conflict');
});
