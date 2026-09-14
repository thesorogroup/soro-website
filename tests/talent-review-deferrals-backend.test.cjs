'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');

process.env.SUPABASE_URL = 'https://review-deferrals-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
const api = require('../netlify/functions/talent-review-deferrals');
const queue = require('../netlify/functions/talent-review-queue');
const verification = require('../netlify/functions/talent-verification');
const { publicDeferral } = require('../netlify/functions/lib/talent-review-deferral');

const actorId = '11111111-1111-4111-8111-111111111111';
const applicantId = '22222222-2222-4222-8222-222222222222';
const requestId = '33333333-3333-4333-8333-333333333333';
const taskId = '44444444-4444-4444-8444-444444444444';
const updatedAt = '2026-09-13T19:20:30.123456+00:00';
const deferral = () => ({ id: requestId, reason: 'Finish after equipment arrives.', createdAt: updatedAt,
  createdByName: 'Talent reviewer', dueDate: null, taskId: null });
const state = () => ({ applicantId, updatedAt, items: api.ITEM_KEYS.map(key => ({
  key, label: key.replaceAll('_', ' '), status: key === 'equipment' ? 'deferred' : 'pending',
  deferral: key === 'equipment' ? deferral() : null
})) });
const queueState = () => ({ generatedAt: updatedAt, viewerRole: 'talent_management',
  summary: { all: 1, submitted: 0, in_review: 1, needs_more_info: 0, bench_ready: 0, closed: 0 },
  applicants: [{ applicantId, fullName: 'Sample Talent', preferredName: null, email: 'talent@example.com',
    applicationReceivedAt: updatedAt, updatedAt, stage: 'in_review', archived: false,
    owner: { id: actorId, name: 'Talent reviewer' }, resume: { available: false },
    checklist: api.ITEM_KEYS.slice(0, 9).map(key => ({ key, label: key, state: 'missing', deferral: key === 'equipment' ? deferral() : null })),
    allowedActions: ['mark_bench_ready'] }]
});
const verificationState = () => ({ generatedAt: updatedAt, viewerRole: 'talent_management',
  applicant: { applicantId, fullName: 'Sample Talent', email: 'talent@example.com', stage: 'in_review', updatedAt },
  gate: { interviewAddressed: false, referencesAddressed: false, benchReadyEligible: true,
    blockers: [], deferrals: { interview: deferral(), references: deferral() } },
  interview: null, interviewers: [], references: []
});
const event = (overrides = {}) => ({ httpMethod: 'GET', headers: { authorization: 'Bearer verified-session-token' },
  queryStringParameters: { applicantId }, multiValueQueryStringParameters: { applicantId: [applicantId] },
  rawQueryString: `applicantId=${applicantId}`, body: '', ...overrides });
const input = (overrides = {}) => ({ requestId, applicantId, expectedUpdatedAt: updatedAt,
  itemKey: 'equipment', action: 'defer', reason: '  Finish after equipment arrives.  ', dueDate: null, createTask: false, ...overrides });
const post = (body, overrides = {}) => event({ httpMethod: 'POST', queryStringParameters: {},
  multiValueQueryStringParameters: {}, rawQueryString: '', body: JSON.stringify(body), ...overrides });
function mock(t, { authStatus = 200, user = { id: actorId }, rpcStatus = 200, payload = state(), networkError } = {}) {
  const calls = [], previous = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (networkError) throw new Error(networkError);
    const auth = String(url).endsWith('/auth/v1/user');
    return new Response(JSON.stringify(auth ? user : typeof payload === 'function' ? payload() : payload), {
      status: auth ? authStatus : rpcStatus, headers: { 'Content-Type': 'application/json' }
    });
  };
  t.after(() => { global.fetch = previous; });
  return calls;
}

test('GET verifies the session and forwards only the actor and requested applicant', async t => {
  const payload = state();
  payload.organizationId = 'PRIVATE ORG';
  payload.items[7].deferral.actorEmail = 'PRIVATE EMAIL';
  const calls = mock(t, { payload });
  const result = await api.handler(event());
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.headers.Vary, 'Authorization');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer verified-session-token');
  assert.match(calls[1].url, /\/rpc\/get_talent_review_deferrals$/);
  assert.deepEqual(JSON.parse(calls[1].options.body), { p_actor_user_id: actorId, p_applicant_id: applicantId });
  assert.deepEqual(JSON.parse(result.body), state());
  assert.doesNotMatch(result.body, /PRIVATE/);
});

test('GET rejects selected actor, organization, duplicate query scope and request bodies before authentication', async t => {
  const calls = mock(t);
  const invalid = [
    event({ queryStringParameters: {}, multiValueQueryStringParameters: {}, rawQueryString: '' }), event({ queryStringParameters: { applicantId: 'invalid' } }),
    event({ queryStringParameters: { applicantId, actorId } }),
    event({ queryStringParameters: { applicantId, organizationId: requestId } }),
    event({ queryStringParameters: { applicantId, role: 'admin' } }),
    event({ multiValueQueryStringParameters: { applicantId: [applicantId, requestId] } }),
    event({ multiValueQueryStringParameters: { applicantId: [requestId] } }),
    event({ rawQueryString: `applicantId=${applicantId}&applicantId=${applicantId}` }),
    event({ rawQueryString: `applicantId=${applicantId}&organizationId=${requestId}` }),
    event({ body: '{}' }), event({ isBase64Encoded: true, body:'e30=' })
  ];
  for (const request of invalid) assert.equal((await api.handler(request)).statusCode, 400);
  assert.equal(calls.length, 0);
});

test('GET accepts consistent Netlify query representations and an empty encoded body', () => {
  for(const request of [
    event({isBase64Encoded:true}),
    event({queryStringParameters:{},multiValueQueryStringParameters:{}}),
    event({queryStringParameters:{},rawQueryString:''}),
    event({multiValueQueryStringParameters:{},rawQueryString:''})
  ])assert.equal(api.queryApplicant(request),applicantId);
  for(const request of [event({queryStringParameters:{applicantId:[applicantId]}}),event({rawQueryString:`applicantId=${requestId}`})])assert.throws(()=>api.queryApplicant(request),/Choose one valid/);
});

test('missing or invalid sessions cannot call either deferral RPC', async t => {
  const calls = mock(t, { authStatus: 401, user: { message: 'PRIVATE AUTH' } });
  assert.equal((await api.handler(event({ headers: {} }))).statusCode, 401);
  assert.equal(calls.length, 0);
  for (const request of [event(), post(input())]) {
    const result = await api.handler(request);
    assert.equal(result.statusCode, 401);
    assert.doesNotMatch(result.body, /PRIVATE/);
  }
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.url.endsWith('/auth/v1/user')));
});

test('SQL denies cross-applicant or disallowed-role access without returning private errors', async t => {
  const calls = mock(t, { rpcStatus: 400, payload: { code: '42501', message: 'PRIVATE tenant and role details' } });
  for (const request of [event(), post(input())]) {
    const result = await api.handler(request);
    assert.equal(result.statusCode, 403);
    assert.match(JSON.parse(result.body).message, /Admin and Talent Management/);
    assert.doesNotMatch(result.body, /PRIVATE/);
    assert.equal(result.headers['Cache-Control'], 'no-store');
  }
  for (const call of calls.filter(call => call.url.includes('/rpc/'))) {
    assert.equal(JSON.parse(call.options.body).p_actor_user_id, actorId);
  }
});

test('POST preserves optimistic timestamp and idempotency key and returns the sanitized queue', async t => {
  const calls = mock(t, { payload: queueState() });
  const result = await api.handler(post(input({ createTask: true, dueDate: '2028-02-29' })));
  assert.equal(result.statusCode, 200);
  assert.match(calls[1].url, /\/rpc\/manage_talent_review_deferral$/);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    p_actor_user_id: actorId, p_request_id: requestId, p_applicant_id: applicantId,
    p_expected_updated_at: updatedAt, p_item_key: 'equipment', p_action: 'defer',
    p_reason: 'Finish after equipment arrives.', p_due_date: '2028-02-29', p_create_task: true
  });
  assert.deepEqual(JSON.parse(result.body), queue.publicPayload(queueState()));
  const replay = await api.handler(post(input({ createTask: true, dueDate: '2028-02-29' })));
  assert.equal(replay.statusCode, 200);
  assert.equal(JSON.parse(calls[3].options.body).p_request_id, requestId);
});

test('POST rejects extra scope, incomplete bodies, invalid dates and task combinations before authentication', async t => {
  const calls = mock(t);
  for (const patch of [
    { actorId }, { organizationId: requestId }, { role: 'admin' }, { assigneeId: requestId },
    { requestId: undefined }, { expectedUpdatedAt: null }, { expectedUpdatedAt: '2026-02-30T00:00:00Z' },
    { expectedUpdatedAt: '2026-09-13' }, { applicantId: 'wrong' }, { requestId: 'wrong' },
    { itemKey: 'any_requirement' }, { action: 'complete' }, { createTask: 'true' },
    { reason: null }, { reason: '' }, { reason: '   ' }, { reason: 'x'.repeat(501) }, { reason: 'x\u0000' },
    { createTask: true, dueDate: null }, { createTask: true, dueDate: '2026-02-29' },
    { createTask: true, dueDate: '2026-04-31' }, { createTask: true, dueDate: '2026-12-01T00:00:00Z' },
    { dueDate: '2026-12-01' }, { dueDate: undefined },
    { action: 'restore', reason: '' }, { action: 'restore', createTask: true, dueDate: '2026-12-01' }
  ]) assert.equal((await api.handler(post(input(patch)))).statusCode, 400, JSON.stringify(patch));
  for (const request of [post(input(), { rawQueryString: `actorId=${actorId}` }),
    post(input(), { queryStringParameters: { applicantId } }),
    post(input(), { multiValueQueryStringParameters: { applicantId: [applicantId] } }),
    post(input(), { body: '{' }), post(input(), { body: '[]' }), post(input(), { body: 'null' }),
    post(input(), { isBase64Encoded: true })]) assert.equal((await api.handler(request)).statusCode, 400);
  assert.equal((await api.handler(post(input(), { body: ' '.repeat(8193) }))).statusCode, 413);
  assert.equal(calls.length, 0);
});

test('restore requires a reason and carries no new task or date', async t => {
  const calls = mock(t, { payload: queueState() });
  const result = await api.handler(post(input({ action: 'restore', reason: 'Evidence is now required before matching.' })));
  assert.equal(result.statusCode, 200);
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.p_action, 'restore');
  assert.equal(body.p_create_task, false);
  assert.equal(body.p_due_date, null);
});

test('successful GET responses reject cross-applicant, missing, duplicate or inconsistent items', async t => {
  let payload;
  mock(t, { payload: () => payload });
  const attempts = [null, [], {}, { ...state(), applicantId: requestId },
    { ...state(), items: state().items.slice(1) },
    { ...state(), updatedAt: '2026-02-30T12:00:00Z' },
    { ...state(), items: [...state().items.slice(1), state().items[1]] }];
  for (const patch of [{ status: 'complete', deferral: deferral() }, { status: 'deferred', deferral: null },
    { status: 'guessed' }, { deferral: {} }, { deferral: { ...deferral(), taskId: 'invalid' } },
    { deferral: { ...deferral(), dueDate: '2026-12-01' } }]) {
    const value = state(); value.items[7] = { ...value.items[7], ...patch }; attempts.push(value);
  }
  for (payload of attempts) {
    const result = await api.handler(event());
    assert.equal(result.statusCode, 502);
    assert.deepEqual(Object.keys(JSON.parse(result.body)), ['message']);
  }
});

test('database conflicts and outages are safely classified', async t => {
  let payload;
  mock(t, { rpcStatus: 400, payload: () => payload });
  for (const [code, message, status] of [
    ['P0001', 'This Talent application changed after it was opened.', 409],
    ['P0001', 'PRIVATE transition detail', 409], ['40001', 'PRIVATE conflict', 409],
    ['23505', 'PRIVATE duplicate', 409], ['22023', 'PRIVATE validation', 400],
    ['22007', 'PRIVATE invalid date', 400], ['PGRST202', 'PRIVATE configuration', 503]
  ]) {
    payload = { code, message };
    const result = await api.handler(post(input()));
    assert.equal(result.statusCode, status);
    assert.doesNotMatch(result.body, /PRIVATE/);
  }
});

test('network details stay private and unsupported methods never authenticate', async t => {
  const calls = mock(t, { networkError: 'PRIVATE upstream URL and token' });
  for (const httpMethod of ['PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const result = await api.handler(event({ httpMethod }));
    assert.equal(result.statusCode, 405);
    assert.equal(result.headers.Allow, 'GET, POST');
  }
  assert.equal(calls.length, 0);
  const result = await api.handler(event());
  assert.equal(result.statusCode, 503);
  assert.doesNotMatch(result.body, /PRIVATE/);
});

test('queue deferral metadata never changes actual evidence completion', () => {
  const payload = queueState();
  const item = payload.applicants[0].checklist[7];
  item.resultRecorded = false; item.evidenceState = 'missing';
  item.deferral.organizationId = 'PRIVATE';
  const actual = queue.publicPayload(payload).applicants[0].checklist[7];
  assert.equal(actual.state, 'missing');
  assert.equal(actual.resultRecorded, false);
  assert.equal(actual.evidenceState, 'missing');
  assert.deepEqual(actual.deferral, deferral());
  item.state = 'complete'; item.evidenceState = 'available';
  assert.throws(() => queue.publicPayload(payload), error => error.status === 502);
  item.deferral = null;
  assert.equal(queue.publicPayload(payload).applicants[0].checklist[7].state, 'complete');
});

test('verification eligibility may include deferrals while addressed booleans remain actual', () => {
  const payload = verificationState();
  payload.gate.deferrals.organizationId = 'PRIVATE';
  const actual = verification.publicPayload(payload).gate;
  assert.equal(actual.interviewAddressed, false);
  assert.equal(actual.referencesAddressed, false);
  assert.equal(actual.benchReadyEligible, true);
  assert.deepEqual(actual.deferrals, { interview: deferral(), references: deferral() });
  payload.gate.interviewAddressed = true;
  assert.throws(() => verification.publicPayload(payload), error => error.status === 502);
  payload.gate.deferrals.interview = null;
  assert.equal(verification.publicPayload(payload).gate.interviewAddressed, true);
  delete payload.gate.deferrals;
  assert.equal('deferrals' in verification.publicPayload(payload).gate, false);
});

test('all projections reject malformed deferral metadata instead of inventing reviewer or task details', () => {
  for (const invalid of [undefined, [], {}, { ...deferral(), id: 'invalid' },
    { ...deferral(), reason: '' }, { ...deferral(), reason: 'x'.repeat(501) },
    { ...deferral(), createdByName: null }, { ...deferral(), createdAt: 'not a time' },
    { ...deferral(), dueDate: '2026-02-30', taskId }, { ...deferral(), taskId },
    { ...deferral(), dueDate: undefined }, { ...deferral(), taskId: undefined }]) {
    assert.throws(() => publicDeferral(invalid), error => error.status === 502);
    const q = queueState(); q.applicants[0].checklist[7].deferral = invalid;
    assert.throws(() => queue.publicPayload(q), error => error.status === 502);
    const v = verificationState(); v.gate.deferrals.interview = invalid;
    assert.throws(() => verification.publicPayload(v), error => error.status === 502);
  }
  assert.deepEqual(publicDeferral({ ...deferral(), dueDate: '2028-02-29', taskId }), { ...deferral(), dueDate: '2028-02-29', taskId });
});
