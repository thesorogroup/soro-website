const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

process.env.SUPABASE_URL = 'https://talent-review-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const root = path.resolve(__dirname, '..');
const backend = require(path.join(root, 'netlify', 'functions', 'talent-review-queue.js'));

const userId = '11111111-1111-4111-8111-111111111111';
const applicantId = '22222222-2222-4222-8222-222222222222';
const ownerId = '33333333-3333-4333-8333-333333333333';
const requestId = '44444444-4444-4444-8444-444444444444';
const expectedUpdatedAt = '2026-08-30T23:00:00.000Z';

const SUMMARY_KEYS = Object.freeze(['all', 'submitted', 'in_review', 'needs_more_info', 'bench_ready', 'closed']);
const APPLICANT_KEYS = Object.freeze([
  'applicantId', 'fullName', 'preferredName', 'email', 'applicationReceivedAt',
  'updatedAt', 'stage', 'archived', 'owner', 'resume', 'checklist', 'allowedActions'
]);
const CHECKLIST_KEYS = Object.freeze(['core_profile', 'resume', 'english', 'disc', 'enneagram', 'mbti', 'internet', 'equipment', 'skills']);

function response(data, status = 200) {
  return new Response(data === undefined ? '' : JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function event(overrides = {}) {
  return {
    httpMethod: 'GET',
    headers: { authorization: 'Bearer signed-in-management-token' },
    queryStringParameters: {},
    multiValueQueryStringParameters: {},
    rawQueryString: '',
    body: '',
    ...overrides
  };
}

function checklist() {
  return CHECKLIST_KEYS.map((key, index) => ({
    key,
    label: key.replace(/_/g, ' '),
    state: index < 3 ? 'complete' : 'missing'
  }));
}

function applicantRow(overrides = {}) {
  return {
    applicantId,
    fullName: 'Santos, Mariel Anne',
    preferredName: 'Mariel',
    email: 'mariel@example.com',
    applicationReceivedAt: '2026-08-30T20:00:00.000Z',
    updatedAt: expectedUpdatedAt,
    stage: 'submitted',
    archived: false,
    owner: { id: ownerId, name: 'Jordan Reed' },
    resume: { available: true, label: 'Résumé available' },
    checklist: checklist(),
    allowedActions: ['begin_review', 'request_more_info', 'decline', 'archive'],
    ...overrides
  };
}

function queuePayload(overrides = {}) {
  return {
    generatedAt: '2026-08-30T23:05:00.000Z',
    viewerRole: 'admin',
    summary: { all: 1, submitted: 1, in_review: 0, needs_more_info: 0, bench_ready: 0, closed: 0 },
    applicants: [applicantRow()],
    ...overrides
  };
}

function installFetch(t, options = {}) {
  const {
    user = { id: userId },
    authStatus = 200,
    rpcStatus = 200,
    rpcBody = queuePayload()
  } = options;
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, requestOptions = {}) => {
    const call = { url: String(url), options: requestOptions };
    calls.push(call);
    if (call.url.endsWith('/auth/v1/user')) {
      return response(typeof user === 'function' ? user(call, calls.length) : user,
        typeof authStatus === 'function' ? authStatus(call, calls.length) : authStatus);
    }
    if (call.url.includes('/rest/v1/rpc/')) {
      return response(typeof rpcBody === 'function' ? rpcBody(call, calls.length) : rpcBody,
        typeof rpcStatus === 'function' ? rpcStatus(call, calls.length) : rpcStatus);
    }
    throw new Error(`Unexpected fetch: ${call.url}`);
  };
  t.after(() => { global.fetch = originalFetch; });
  return calls;
}

function bodyOf(result) {
  return JSON.parse(result.body);
}

test('GET authenticates once and derives queue scope only from the verified actor', async t => {
  const calls = installFetch(t);
  const result = await backend.handler(event());

  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.headers.Pragma, 'no-cache');
  assert.equal(result.headers.Vary, 'Authorization');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://talent-review-test.supabase.co/auth/v1/user');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer signed-in-management-token');
  assert.equal(calls[1].url, 'https://talent-review-test.supabase.co/rest/v1/rpc/get_talent_review_queue');
  assert.deepEqual(JSON.parse(calls[1].options.body), { p_actor_user_id: userId });
  assert.equal(calls[1].options.headers.Authorization, 'Bearer test-service-role-key');
});

test('GET rejects every client-selected scope before authentication', async t => {
  const calls = installFetch(t);
  const attempts = [
    event({ queryStringParameters: { organizationId: ownerId } }),
    event({ queryStringParameters: { role: 'admin' } }),
    event({ queryStringParameters: { stage: 'submitted' } }),
    event({ multiValueQueryStringParameters: { applicantId: [applicantId] } }),
    event({ rawQueryString: `applicantId=${applicantId}` }),
    event({ body: JSON.stringify({ organizationId: ownerId }) })
  ];

  for (const request of attempts) {
    const result = await backend.handler(request);
    assert.equal(result.statusCode, 400);
    assert.equal(bodyOf(result).code, 'unsupported_scope');
  }
  assert.equal(calls.length, 0);
});

test('POST accepts only the exact optimistic-concurrency keys and sends an actor-scoped RPC', async t => {
  const calls = installFetch(t);
  const requestBody = { requestId, applicantId, expectedUpdatedAt, action: 'request_more_info', note: 'Please upload the missing proof.' };
  const result = await backend.handler(event({ httpMethod: 'POST', body: JSON.stringify(requestBody) }));

  assert.equal(result.statusCode, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://talent-review-test.supabase.co/rest/v1/rpc/change_talent_review_stage');
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    p_actor_user_id: userId,
    p_request_id: requestId,
    p_applicant_id: applicantId,
    p_expected_updated_at: expectedUpdatedAt,
    p_action: 'request_more_info',
    p_note: 'Please upload the missing proof.'
  });

  const before = calls.length;
  for (const invalidBody of [
    { ...requestBody, organizationId: ownerId },
    { ...requestBody, role: 'admin' },
    { ...requestBody, stage: 'needs_more_info' },
    { requestId, applicantId, action: 'request_more_info', note: 'Missing timestamp' },
    { ...requestBody, unexpected: true }
  ]) {
    const rejected = await backend.handler(event({ httpMethod: 'POST', body: JSON.stringify(invalidBody) }));
    assert.equal(rejected.statusCode, 400);
    assert.equal(bodyOf(rejected).code, 'unsupported_scope');
  }
  assert.equal(calls.length, before, 'invalid bodies must fail before authentication');
});

test('the public response is an exact allowlist that strips private and organization data', async t => {
  installFetch(t, {
    rpcBody: queuePayload({
      organizationId: '55555555-5555-4555-8555-555555555555',
      privateAudit: { actor: userId },
      summary: { ...queuePayload().summary, internalTotal: 99 },
      applicants: [applicantRow({
        organizationId: '55555555-5555-4555-8555-555555555555',
        birthDate: '1998-01-10',
        address: 'Private address',
        statusReason: 'Private review note',
        owner: { id: ownerId, name: 'Jordan Reed', email: 'private-owner@example.com' },
        checklist: checklist().map(item => ({ ...item, sourceDocumentId: requestId }))
      })]
    })
  });

  const result = await backend.handler(event());
  const payload = bodyOf(result);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(Object.keys(payload).sort(), ['applicants', 'generatedAt', 'summary', 'viewerRole']);
  assert.deepEqual(Object.keys(payload.summary).sort(), [...SUMMARY_KEYS].sort());
  assert.deepEqual(Object.keys(payload.applicants[0]).sort(), [...APPLICANT_KEYS].sort());
  assert.deepEqual(Object.keys(payload.applicants[0].owner).sort(), ['id', 'name']);
  assert.deepEqual(Object.keys(payload.applicants[0].resume).sort(), ['available', 'label']);
  assert.deepEqual(payload.applicants[0].resume, { available: true, label: 'Résumé available' });
  assert.deepEqual(Object.keys(payload.applicants[0].checklist[0]).sort(), ['key', 'label', 'state']);
  for (const privateValue of ['Private address', 'Private review note', 'private-owner@example.com', '55555555-5555-4555-8555-555555555555', requestId]) {
    assert.equal(result.body.includes(privateValue), false, `must not expose ${privateValue}`);
  }
});

test('resume availability is canonical and can never carry a path, filename, document id, or URL', () => {
  assert.deepEqual(backend.publicResumeReference({
    available: true,
    label: 'private/org/applicant/resume.pdf',
    storagePath: 'private/org/applicant/resume.pdf',
    signedUrl: 'https://storage.example/signed',
    documentId: requestId,
    fileName: 'resume.pdf'
  }), { available: true, label: 'Résumé available' });
  assert.deepEqual(backend.publicResumeReference({
    available: false,
    label: 'https://public.example/resume.pdf'
  }), { available: false, label: 'Résumé not attached' });
});

test('a real zero queue remains zero and is never replaced by sample applications', async t => {
  installFetch(t, {
    rpcBody: queuePayload({
      summary: Object.fromEntries(SUMMARY_KEYS.map(key => [key, 0])),
      applicants: []
    })
  });
  const result = await backend.handler(event());
  const payload = bodyOf(result);

  assert.equal(result.statusCode, 200);
  assert.deepEqual(payload.summary, Object.fromEntries(SUMMARY_KEYS.map(key => [key, 0])));
  assert.deepEqual(payload.applicants, []);
  assert.doesNotMatch(result.body, /Mariel|Jordan|sample|demo/i);
});

test('invalid or unauthorized sessions never receive review data', async t => {
  const calls = installFetch(t, { authStatus: 401 });

  const signedOut = await backend.handler(event({ headers: {} }));
  assert.equal(signedOut.statusCode, 401);
  assert.equal(calls.length, 0);

  const invalid = await backend.handler(event());
  assert.equal(invalid.statusCode, 401);
  assert.equal(calls.some(call => call.url.includes('/rest/v1/rpc/')), false);

  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/auth/v1/user')) return response({ id: userId });
    return response({ code: '42501', message: 'private organization and role detail' }, 400);
  };
  const forbidden = await backend.handler(event());
  global.fetch = original;
  assert.equal(forbidden.statusCode, 403);
  assert.equal(bodyOf(forbidden).code, 'review_forbidden');
  assert.equal(forbidden.body.includes('private organization'), false);
});

test('conflict, incomplete checklist, and invalid transition database errors are safely classified', async t => {
  const scenarios = [
    [{ code: 'P0001', message: 'This Talent application changed after it was opened.' }, 'review_conflict'],
    [{ code: 'P0001', message: 'Required review sources are still missing.' }, 'review_incomplete'],
    [{ code: 'P0001', message: 'Only an in-review application can be marked Bench Ready.' }, 'review_transition_conflict']
  ];
  for (const [rpcBody, expectedCode] of scenarios) {
    const calls = installFetch(t, { rpcBody, rpcStatus: 400 });
    const result = await backend.handler(event({ httpMethod: 'POST', body: JSON.stringify({
      requestId, applicantId, expectedUpdatedAt, action: 'mark_bench_ready', note: ''
    }) }));
    assert.equal(result.statusCode, 409);
    assert.equal(bodyOf(result).code, expectedCode);
    assert.equal(calls.filter(call => call.url.includes('/rest/v1/rpc/')).length, 1);
  }
});

test('an exact request replay returns the same server queue without duplicate client behavior', async t => {
  const calls = installFetch(t);
  const requestBody = { requestId, applicantId, expectedUpdatedAt, action: 'begin_review', note: '' };
  const first = await backend.handler(event({ httpMethod: 'POST', body: JSON.stringify(requestBody) }));
  const second = await backend.handler(event({ httpMethod: 'POST', body: JSON.stringify(requestBody) }));

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(bodyOf(first), bodyOf(second));
  assert.equal(calls.filter(call => call.url.includes('/rest/v1/rpc/change_talent_review_stage')).length, 2);
  for (const call of calls.filter(item => item.url.includes('/rest/v1/rpc/change_talent_review_stage'))) {
    assert.equal(JSON.parse(call.options.body).p_request_id, requestId);
  }
});

test('malformed successful RPC payloads fail closed and unsupported methods never authenticate', async t => {
  for (const rpcBody of [null, [], {}, { generatedAt: 'not-a-date', viewerRole: 'admin', summary: {}, applicants: [] }]) {
    const calls = installFetch(t, { rpcBody });
    const result = await backend.handler(event());
    assert.equal(result.statusCode, 502);
    assert.deepEqual(Object.keys(bodyOf(result)).sort(), ['code', 'message']);
    assert.equal(calls.filter(call => call.url.includes('/rest/v1/rpc/')).length, 1);
  }

  const calls = installFetch(t);
  for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const result = await backend.handler(event({ httpMethod: method }));
    assert.equal(result.statusCode, 405);
    assert.equal(result.headers.Allow, 'GET, POST');
  }
  assert.equal(calls.length, 0);
});
