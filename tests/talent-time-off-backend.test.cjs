const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

process.env.SUPABASE_URL = 'https://time-off-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const root = path.resolve(__dirname, '..');
const backend = require(path.join(root, 'netlify', 'functions', 'talent-time-off.js'));
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

const actorUserId = '11111111-1111-4111-8111-111111111111';
const applicantId = '22222222-2222-4222-8222-222222222222';
const placementId = '33333333-3333-4333-8333-333333333333';
const timeOffRequestId = '44444444-4444-4444-8444-444444444444';
const operationRequestId = '55555555-5555-4555-8555-555555555555';

const TOP_LEVEL_KEYS = Object.freeze(['generatedAt', 'viewerRole', 'eligibility', 'requests']);
const ELIGIBILITY_KEYS = Object.freeze([
  'eligible',
  'state',
  'placementId',
  'clientName',
  'workTimezone',
  'minStartDate'
]);
const REQUEST_KEYS = Object.freeze([
  'timeOffRequestId',
  'applicantId',
  'applicantName',
  'placementId',
  'clientName',
  'startDate',
  'endDate',
  'workTimezone',
  'status',
  'note',
  'submittedAt',
  'decidedAt',
  'decisionNote',
  'canCancel'
]);

function response(data, status = 200) {
  return new Response(data === undefined ? '' : JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function event(overrides = {}) {
  return {
    httpMethod: 'GET',
    headers: { authorization: 'Bearer signed-in-token' },
    queryStringParameters: {},
    ...overrides
  };
}

function requestRow(overrides = {}) {
  return {
    timeOffRequestId,
    applicantId,
    applicantName: 'Mariel Santos',
    placementId,
    clientName: 'Brightlane Medical',
    startDate: '2026-09-03',
    endDate: '2026-09-04',
    workTimezone: 'Asia/Manila',
    status: 'pending',
    note: 'Family appointment',
    submittedAt: '2026-08-29T20:00:00.000Z',
    decidedAt: null,
    decisionNote: null,
    canCancel: true,
    ...overrides
  };
}

function portalPayload(overrides = {}) {
  return {
    generatedAt: '2026-08-29T20:05:00.000Z',
    viewerRole: 'virtual_assistant',
    eligibility: {
      eligible: true,
      state: 'eligible',
      placementId,
      clientName: 'Brightlane Medical',
      workTimezone: 'Asia/Manila',
      minStartDate: '2026-08-30'
    },
    requests: [requestRow()],
    ...overrides
  };
}

function installFetch(t, options = {}) {
  const {
    user = { id: actorUserId },
    authStatus = 200,
    rpcStatus = 200,
    rpcBody = portalPayload()
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
        typeof rpcBody === 'function' ? rpcBody(call) : rpcBody,
        typeof rpcStatus === 'function' ? rpcStatus(call) : rpcStatus
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

test('GET authenticates once and derives viewer, organization, Talent, placement, and timezone from the verified actor', async t => {
  const calls = installFetch(t);
  const result = await backend.handler(event());

  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.headers.Pragma, 'no-cache');
  assert.equal(result.headers.Vary, 'Authorization');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://time-off-test.supabase.co/auth/v1/user');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer signed-in-token');
  assert.equal(calls[1].url, 'https://time-off-test.supabase.co/rest/v1/rpc/get_talent_time_off');
  assert.deepEqual(JSON.parse(calls[1].options.body), { p_actor_user_id: actorUserId });
  assert.equal(calls[1].options.headers.Authorization, 'Bearer test-service-role-key');
  assert.equal(bodyOf(result).viewerRole, 'virtual_assistant');
});

test('GET rejects all client-selected scope and role claims before authentication', async t => {
  const calls = installFetch(t);
  const attempts = [
    event({ queryStringParameters: { organizationId: applicantId } }),
    event({ queryStringParameters: { applicantId } }),
    event({ queryStringParameters: { placementId } }),
    event({ queryStringParameters: { viewerRole: 'admin' } }),
    event({ queryStringParameters: { status: 'pending' } }),
    event({ body: JSON.stringify({ applicantId }) })
  ];

  for (const request of attempts) {
    const result = await backend.handler(request);
    assert.equal(result.statusCode, 400);
    assert.equal(bodyOf(result).code, 'unsupported_scope');
  }
  assert.equal(calls.length, 0);
});

test('public responses use exact safe allowlists and remove private or workflow-internal data', async t => {
  installFetch(t, {
    rpcBody: portalPayload({
      organizationId: '66666666-6666-4666-8666-666666666666',
      actorUserId,
      eligibility: {
        ...portalPayload().eligibility,
        authUserId: actorUserId,
        clientEmail: 'client@example.com'
      },
      requests: [requestRow({
        email: 'mariel@example.com',
        phone: '+63 917 555 0100',
        address: 'Private address',
        birthDate: '1998-01-10',
        medicalReason: 'Private health detail',
        proofUrl: 'https://private.example/proof',
        operationRequestId,
        reviewedByUserId: actorUserId,
        hourlyRate: 9,
        payrollCode: 'PTO'
      })]
    })
  });

  const result = await backend.handler(event());
  const payload = bodyOf(result);

  assert.equal(result.statusCode, 200);
  assert.deepEqual(Object.keys(payload).sort(), [...TOP_LEVEL_KEYS].sort());
  assert.deepEqual(Object.keys(payload.eligibility).sort(), [...ELIGIBILITY_KEYS].sort());
  assert.deepEqual(Object.keys(payload.requests[0]).sort(), [...REQUEST_KEYS].sort());
  for (const privateValue of [
    '66666666-6666-4666-8666-666666666666',
    'client@example.com',
    'mariel@example.com',
    '+63 917 555 0100',
    'Private address',
    '1998-01-10',
    'Private health detail',
    'https://private.example/proof',
    operationRequestId,
    'PTO'
  ]) {
    assert.equal(result.body.includes(privateValue), false, `must not expose ${privateValue}`);
  }
});

test('submit accepts only a full-day ISO range, optional note, and one idempotency UUID', async t => {
  const calls = installFetch(t);
  const result = await backend.handler(event({
    httpMethod: 'POST',
    body: JSON.stringify({
      action: 'submit',
      requestId: operationRequestId,
      startDate: '2026-09-03',
      endDate: '2026-09-04',
      note: 'Family appointment'
    })
  }));

  assert.equal(result.statusCode, 200);
  const rpcCall = calls.find(call => call.url.includes('/rest/v1/rpc/submit_talent_time_off'));
  assert.ok(rpcCall, 'submit must use the service-only submission RPC');
  assert.deepEqual(JSON.parse(rpcCall.options.body), {
    p_actor_user_id: actorUserId,
    p_request_id: operationRequestId,
    p_start_date: '2026-09-03',
    p_end_date: '2026-09-04',
    p_note: 'Family appointment'
  });
});

test('cancel and management decisions send exact record and operation ids without accepting scope', async t => {
  const calls = installFetch(t);
  const requests = [
    {
      action: 'cancel',
      body: { action: 'cancel', requestId: operationRequestId, timeOffRequestId },
      expected: {
        p_actor_user_id: actorUserId,
        p_action: 'cancel',
        p_request_id: operationRequestId,
        p_time_off_request_id: timeOffRequestId,
        p_note: null
      }
    },
    {
      action: 'approve',
      body: { action: 'approve', requestId: operationRequestId, timeOffRequestId, note: '' },
      expected: {
        p_actor_user_id: actorUserId,
        p_action: 'approve',
        p_request_id: operationRequestId,
        p_time_off_request_id: timeOffRequestId,
        p_note: null
      }
    },
    {
      action: 'decline',
      body: { action: 'decline', requestId: operationRequestId, timeOffRequestId, note: 'Client coverage is unavailable.' },
      expected: {
        p_actor_user_id: actorUserId,
        p_action: 'decline',
        p_request_id: operationRequestId,
        p_time_off_request_id: timeOffRequestId,
        p_note: 'Client coverage is unavailable.'
      }
    }
  ];

  for (const request of requests) {
    const result = await backend.handler(event({ httpMethod: 'POST', body: JSON.stringify(request.body) }));
    assert.equal(result.statusCode, 200, request.action);
  }

  const changeCalls = calls.filter(call => call.url.includes('/rest/v1/rpc/change_talent_time_off'));
  assert.equal(changeCalls.length, 3);
  requests.forEach((request, index) => {
    assert.deepEqual(JSON.parse(changeCalls[index].options.body), request.expected);
  });
});

test('POST rejects extra scope, sensitive fields, timestamps, and malformed action bodies before authentication', async t => {
  const validSubmit = {
    action: 'submit',
    requestId: operationRequestId,
    startDate: '2026-09-03',
    endDate: '2026-09-04',
    note: ''
  };
  const attempts = [
    {},
    { ...validSubmit, applicantId },
    { ...validSubmit, placementId },
    { ...validSubmit, organizationId: applicantId },
    { ...validSubmit, workTimezone: 'UTC' },
    { ...validSubmit, status: 'approved' },
    { ...validSubmit, medicalReason: 'private' },
    { ...validSubmit, proofUrl: 'https://private.example/proof' },
    { ...validSubmit, submittedAt: '2026-08-29T20:00:00Z' },
    { action: 'cancel', requestId: operationRequestId, timeOffRequestId, note: '' },
    { action: 'approve', requestId: operationRequestId, timeOffRequestId },
    { action: 'decline', requestId: operationRequestId, timeOffRequestId, note: '' }
  ];

  for (const body of attempts) {
    const calls = installFetch(t);
    const result = await backend.handler(event({ httpMethod: 'POST', body: JSON.stringify(body) }));
    assert.equal(result.statusCode, 400, JSON.stringify(body));
    assert.equal(calls.length, 0, `invalid public body must not authenticate or call a database RPC: ${JSON.stringify(body)}`);
  }
});

test('dates must be exact calendar dates and ranges cannot be reversed', async t => {
  const attempts = [
    ['2026-9-3', '2026-09-04'],
    ['09/03/2026', '09/04/2026'],
    ['2026-09-03T00:00:00Z', '2026-09-04'],
    ['2026-02-30', '2026-03-01'],
    ['2026-09-04', '2026-09-03']
  ];

  for (const [startDate, endDate] of attempts) {
    const calls = installFetch(t);
    const result = await backend.handler(event({
      httpMethod: 'POST',
      body: JSON.stringify({ action: 'submit', requestId: operationRequestId, startDate, endDate, note: '' })
    }));
    assert.equal(result.statusCode, 400, `${startDate} - ${endDate}`);
    assert.equal(calls.length, 0, `invalid dates must not authenticate: ${startDate} - ${endDate}`);
  }
});

test('signed-out, invalid, and unauthorized roles fail closed without leaking request data', async t => {
  let authStatus = 200;
  const calls = installFetch(t, { authStatus: () => authStatus });

  const signedOut = await backend.handler(event({ headers: {} }));
  assert.equal(signedOut.statusCode, 401);
  assert.equal(calls.length, 0);

  authStatus = 401;
  const invalid = await backend.handler(event());
  assert.equal(invalid.statusCode, 401);
  assert.equal(calls.some(call => call.url.includes('/rest/v1/rpc/')), false);

  authStatus = 200;
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/auth/v1/user')) return response({ id: actorUserId });
    return response({ code: '42501', message: 'private role and organization detail' }, 400);
  };
  const forbidden = await backend.handler(event());
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.body.includes('private role'), false);
});

test('RPC conflicts and malformed successful payloads fail closed with no-store responses', async t => {
  const conflictCases = [
    { code: '23P01', expectedStatus: 409 },
    { code: '23514', expectedStatus: 409 },
    { code: 'P0001', expectedStatus: 409 },
    { code: 'XX000', expectedStatus: 500 }
  ];
  for (const item of conflictCases) {
    const calls = installFetch(t, {
      rpcStatus: 400,
      rpcBody: { code: item.code, message: 'private database detail' }
    });
    const result = await backend.handler(event());
    assert.equal(result.statusCode, item.expectedStatus);
    assert.equal(result.headers['Cache-Control'], 'no-store');
    assert.equal(result.body.includes('private database'), false);
    assert.equal(calls.filter(call => call.url.includes('/rest/v1/rpc/')).length, 1);
  }

  for (const rpcBody of [null, [], {}, { generatedAt: 'not-a-date', viewerRole: 'admin', eligibility: null, requests: [] }]) {
    installFetch(t, { rpcBody });
    const result = await backend.handler(event());
    assert.equal(result.statusCode, 502);
    assert.equal(result.headers['Cache-Control'], 'no-store');
  }
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

test('migration restricts actual roles, derives all record scope, and enforces full-day eligibility', () => {
  const sql = read('supabase/migrations/20260829_025_talent_time_off.sql');
  const getRpc = sql.slice(sql.search(/create or replace function public\.get_talent_time_off/i));

  assert.match(getRpc, /get_talent_time_off\s*\(\s*p_actor_user_id\s+uuid\s*\)/i);
  assert.doesNotMatch(getRpc.slice(0, getRpc.indexOf('returns')), /p_(?:organization|applicant|placement|timezone|viewer_role)/i);
  assert.match(getRpc, /public\.platform_users/i);
  assert.match(getRpc, /active\s*=\s*true/i);
  assert.match(getRpc, /must_change_password\s*=\s*false/i);
  assert.match(sql, /'virtual_assistant'::public\.platform_role/i);
  assert.match(sql, /'admin'::public\.platform_role/i);
  assert.match(sql, /'talent_management'::public\.platform_role/i);
  for (const forbiddenRole of ['sales', 'sales_management', 'billing', 'client_admin', 'client_reviewer', 'client_billing']) {
    assert.doesNotMatch(sql, new RegExp(`'${forbiddenRole}'::public\\.platform_role`, 'i'));
  }
  assert.match(sql, /applicant\.organization_id\s*=\s*new\.organization_id/i);
  assert.match(sql, /request\.organization_id\s*=\s*v_organization_id/i);
  assert.match(sql, /placement\.applicant_id\s*=\s*(?:v_identity\.applicant_id|v_applicant_id)/i);
  assert.match(sql, /client\.organization_id\s*=\s*(?:v_identity\.organization_id|v_organization_id)/i);
  assert.match(sql, /v_viewer_role\s*:=\s*v_role::text/i);
  assert.match(sql, /where request\.organization_id\s*=\s*v_organization_id[\s\S]*v_role in\s*\(['"]admin['"]::public\.platform_role,\s*['"]talent_management['"]::public\.platform_role\)[\s\S]*or request\.applicant_id\s*=\s*v_applicant_id/i);
  assert.match(sql, /work_timezone/i);
  assert.match(sql, /clock_timestamp\(\)\s+at time zone/i);
  assert.match(sql, /start_date\s*<=\s*(?:v_|p_)start_date/i);
  assert.match(sql, /end_date\s+is\s+null\s+or\s+placement\.end_date\s*>=\s*(?:v_|p_)end_date/i);
  assert.match(sql, /(?:p_start_date\s*<\s*v_identity\.work_date|not\s*\(\s*p_start_date\s*>=\s*v_work_date\s*\))[\s\S]*raise exception/i);
  assert.match(sql, /(?:p_|v_)end_date\s*>=\s*(?:p_|v_)start_date/i);
});

test('migration prevents overlapping requests and limits lifecycle transitions by actor role', () => {
  const sql = read('supabase/migrations/20260829_025_talent_time_off.sql');

  assert.match(sql, /exclude using gist[\s\S]*daterange\s*\([\s\S]*start_date[\s\S]*end_date[\s\S]*'\[\]'[\s\S]*&&[\s\S]*where\s*\([\s\S]*status[\s\S]*pending[\s\S]*approved/i);
  assert.match(sql, /p_action[\s\S]*'cancel'/i);
  assert.match(sql, /p_action[\s\S]*'approve'[\s\S]*'decline'/i);
  assert.match(sql, /(?:v_request\.status|v_status)\s+not in\s*\(['"]pending['"],\s*['"]approved['"]\)/i);
  assert.match(sql, /(?:v_request\.status\s*<>\s*['"]pending['"]|v_status\s*=\s*['"]pending['"])/i);
  assert.match(sql, /status\s*=\s*'approved'/i);
  assert.match(sql, /status\s*=\s*'declined'/i);
  assert.match(sql, /status\s*=\s*'cancelled'/i);
  assert.match(sql, /decision_note/i);
  assert.match(sql, /nullif\s*\(\s*btrim\s*\(\s*p_note\s*\)/i);
  assert.match(sql, /(?:clock_timestamp\(\)[\s\S]*::date\s*>=\s*v_request\.start_date|not\s*\(\s*v_request\.start_date\s*>\s*v_current_date\s*\))/i);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /create table if not exists public\.talent_time_off_operations[\s\S]*(?:operation_)?request_id uuid primary key[\s\S]*request_fingerprint/i);
});

test('management history is bounded and orders pending work before the newest completed decisions', () => {
  const sql = read('supabase/migrations/20260829_025_talent_time_off.sql');
  const endpoint = read('netlify/functions/talent-time-off.js');
  const ui = read('operations/talent-time-off.js');

  assert.match(sql, /with\s+request_scope\s+as[\s\S]*limit\s+1000/i);
  assert.match(sql, /case\s+when\s+request\.status\s*=\s*'pending'\s+then\s+0\s+else\s+1\s+end/i);
  assert.match(sql, /coalesce\s*\(\s*request\.cancelled_at\s*,\s*request\.decided_at\s*,\s*request\.submitted_at\s*\)[\s\S]*desc/i);
  assert.match(endpoint, /const\s+MAX_REQUEST_ROWS\s*=\s*1000/);
  assert.match(ui, /payload\.requests\.slice\(0,\s*1000\)/);
});

test('time-off storage contains no sensitive proof or payroll semantics and cannot mutate attendance or finance', () => {
  const sql = read('supabase/migrations/20260829_025_talent_time_off.sql');
  const tableStart = sql.search(/create table(?: if not exists)? public\.talent_time_off_requests/i);
  const tableEnd = sql.indexOf(';', tableStart);
  const table = sql.slice(tableStart, tableEnd);

  assert.ok(tableStart >= 0, 'time-off request table must exist');
  assert.doesNotMatch(table, /medical|diagnosis|doctor|proof|evidence|attachment|reason|sick|pto|paid|payroll|billing/i);
  assert.doesNotMatch(sql, /(?:insert into|update|delete from)\s+public\.talent_attendance_sessions/i);
  assert.doesNotMatch(sql, /(?:insert into|update|delete from)\s+public\.(?:invoices|payments|benefits|payroll)/i);
  assert.match(sql, /revoke all on function public\.get_talent_time_off\(uuid\) from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.get_talent_time_off\(uuid\) to service_role/i);
  assert.match(sql, /revoke all on table public\.talent_time_off_requests from public, anon, authenticated/i);
});
