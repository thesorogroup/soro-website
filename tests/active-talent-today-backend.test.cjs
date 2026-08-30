const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

process.env.SUPABASE_URL = 'https://active-talent-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const root = path.resolve(__dirname, '..');
const backend = require(path.join(root, 'netlify', 'functions', 'active-talent-today.js'));
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

const userId = '11111111-1111-4111-8111-111111111111';
const applicantId = '22222222-2222-4222-8222-222222222222';
const placementId = '33333333-3333-4333-8333-333333333333';
const clientId = '44444444-4444-4444-8444-444444444444';

const SUMMARY_KEYS = Object.freeze([
  'activeTalent',
  'checkedInToday',
  'workingNow',
  'completedToday',
  'notStarted',
  'needsReview'
]);

const ROW_KEYS = Object.freeze([
  'applicantId',
  'fullName',
  'preferredName',
  'placementId',
  'clientId',
  'clientName',
  'ownerName',
  'placementStatus',
  'placementStartDate',
  'placementEndDate',
  'scheduleSummary',
  'workDate',
  'workTimezone',
  'attendanceState',
  'accessState',
  'startedAt',
  'checkedOutAt',
  'needsAttention',
  'issueCode'
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
    headers: { authorization: 'Bearer signed-in-management-token' },
    queryStringParameters: {},
    ...overrides
  };
}

function rosterRow(overrides = {}) {
  return {
    applicantId,
    fullName: 'Santos, Mariel Anne',
    preferredName: 'Mariel',
    placementId,
    clientId,
    clientName: 'Brightlane Medical',
    ownerName: 'Jordan Reed',
    placementStatus: 'active',
    placementStartDate: '2026-08-01',
    placementEndDate: null,
    scheduleSummary: 'Monday-Friday, 8:00 AM-5:00 PM CT',
    workDate: '2026-08-30',
    workTimezone: 'Asia/Manila',
    attendanceState: 'started',
    accessState: 'ready',
    startedAt: '2026-08-29T23:30:00.000Z',
    checkedOutAt: null,
    needsAttention: false,
    issueCode: null,
    ...overrides
  };
}

function rosterPayload(overrides = {}) {
  return {
    generatedAt: '2026-08-29T23:45:00.000Z',
    summary: {
      activeTalent: 1,
      checkedInToday: 1,
      workingNow: 1,
      completedToday: 0,
      notStarted: 0,
      needsReview: 0
    },
    rows: [rosterRow()],
    ...overrides
  };
}

function installFetch(t, options = {}) {
  const {
    user = { id: userId },
    authStatus = 200,
    rpcStatus = 200,
    rpcBody = rosterPayload()
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

test('GET authenticates once and scopes the service RPC only by the verified actor', async t => {
  const calls = installFetch(t);
  const result = await backend.handler(event());

  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.headers.Pragma, 'no-cache');
  assert.equal(result.headers.Vary, 'Authorization');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://active-talent-test.supabase.co/auth/v1/user');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer signed-in-management-token');
  assert.equal(calls[1].url, 'https://active-talent-test.supabase.co/rest/v1/rpc/get_active_talent_today');
  assert.deepEqual(JSON.parse(calls[1].options.body), { p_actor_user_id: userId });
  assert.equal(calls[1].options.headers.Authorization, 'Bearer test-service-role-key');
});

test('GET rejects every client-selected scope before authentication', async t => {
  const calls = installFetch(t);
  const attempts = [
    event({ queryStringParameters: { organizationId: clientId } }),
    event({ queryStringParameters: { applicantId } }),
    event({ queryStringParameters: { role: 'admin' } }),
    event({ queryStringParameters: { workDate: '2026-08-29' } }),
    event({ body: JSON.stringify({ placementId }) })
  ];

  for (const request of attempts) {
    const result = await backend.handler(request);
    assert.equal(result.statusCode, 400);
    assert.equal(bodyOf(result).code, 'unsupported_scope');
  }
  assert.equal(calls.length, 0);
});

test('the public response is an exact operational allowlist and strips private profile data', async t => {
  const privateRow = rosterRow({
    email: 'mariel@example.com',
    phone: '+63 917 555 0100',
    address: 'Private address',
    birthDate: '1998-01-10',
    genderIdentity: 'female',
    pronouns: ['she_her'],
    expectedHourlyRate: 9,
    startRequestId: '55555555-5555-4555-8555-555555555555',
    correctionNote: 'Private manager note',
    organizationId: '66666666-6666-4666-8666-666666666666',
    authUserId: '77777777-7777-4777-8777-777777777777'
  });
  installFetch(t, {
    rpcBody: rosterPayload({
      summary: { ...rosterPayload().summary, privateCount: 99 },
      rows: [privateRow],
      privateAudit: { actor: userId }
    })
  });

  const result = await backend.handler(event());
  const payload = bodyOf(result);

  assert.equal(result.statusCode, 200);
  assert.deepEqual(Object.keys(payload).sort(), ['generatedAt', 'rows', 'summary']);
  assert.deepEqual(Object.keys(payload.summary).sort(), [...SUMMARY_KEYS].sort());
  assert.deepEqual(Object.keys(payload.rows[0]).sort(), [...ROW_KEYS].sort());
  for (const privateValue of [
    'mariel@example.com', '+63 917 555 0100', 'Private address', '1998-01-10',
    'Private manager note', '55555555-5555-4555-8555-555555555555',
    '66666666-6666-4666-8666-666666666666', '77777777-7777-4777-8777-777777777777'
  ]) {
    assert.equal(result.body.includes(privateValue), false, `must not expose ${privateValue}`);
  }
});

test('a real zero roster stays zero and is never replaced with sample people or counts', async t => {
  installFetch(t, {
    rpcBody: rosterPayload({
      summary: Object.fromEntries(SUMMARY_KEYS.map(key => [key, 0])),
      rows: []
    })
  });

  const result = await backend.handler(event());
  const payload = bodyOf(result);

  assert.equal(result.statusCode, 200);
  assert.deepEqual(payload.summary, Object.fromEntries(SUMMARY_KEYS.map(key => [key, 0])));
  assert.deepEqual(payload.rows, []);
  assert.doesNotMatch(result.body, /Mariel|Brightlane|sample|demo/i);
});

test('signed-out, invalid, and unauthorized callers never receive roster data', async t => {
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
  const before = calls.length;
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/auth/v1/user')) return response({ id: userId });
    return response({ code: '42501', message: 'private role and organization detail' }, 400);
  };
  const forbidden = await backend.handler(event());
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.body.includes('private role'), false);
  assert.equal(calls.slice(before).filter(call => call.url.includes('/rest/v1/rpc/')).length, 1);
});

test('malformed successful RPC payloads fail closed instead of fabricating a dashboard', async t => {
  for (const rpcBody of [null, [], {}, { generatedAt: 'not-a-date', summary: {}, rows: [] }]) {
    installFetch(t, { rpcBody });
    const result = await backend.handler(event());
    assert.equal(result.statusCode, 502);
    assert.deepEqual(Object.keys(bodyOf(result)).sort(), ['code', 'message']);
  }
});

test('the management roster is read-only', async t => {
  const calls = installFetch(t);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const result = await backend.handler(event({ httpMethod: method }));
    assert.equal(result.statusCode, 405);
    assert.equal(result.headers.Allow, 'GET');
    assert.equal(result.headers['Cache-Control'], 'no-store');
  }
  assert.equal(calls.length, 0);
});

test('the RPC derives organization, role, and local dates and keeps open overnight sessions active', () => {
  const sql = read('supabase/migrations/20260829_024_active_talent_today.sql');
  const rpc = sql.slice(sql.search(/create or replace function public\.get_active_talent_today/i));

  assert.match(rpc, /get_active_talent_today\s*\(\s*p_actor_user_id\s+uuid\s*\)/i);
  assert.doesNotMatch(rpc.slice(0, rpc.indexOf('returns')), /p_(?:organization|applicant|placement|work_date|timezone)/i);
  assert.match(rpc, /public\.platform_users/i);
  assert.match(rpc, /active\s*=\s*true/i);
  assert.match(rpc, /must_change_password\s*=\s*false/i);
  assert.match(rpc, /'admin'::public\.platform_role/i);
  assert.match(rpc, /'talent_management'::public\.platform_role/i);
  const authorization = rpc.slice(0, rpc.indexOf('with applicant_zones'));
  for (const forbiddenRole of ['sales', 'sales_management', 'billing', 'client_admin', 'client_reviewer', 'client_billing', 'virtual_assistant']) {
    assert.doesNotMatch(authorization, new RegExp(`'${forbiddenRole}'::public\\.platform_role`, 'i'));
  }
  assert.match(rpc, /clock_timestamp\(\)/i);
  assert.match(rpc, /v_now\s+at time zone\s+applicant_zones\.work_timezone/i);
  assert.match(rpc, /checked_out_at\s+is\s+null/i);
  assert.match(rpc, /applicant\.organization_id\s*=\s*v_organization_id/i);
  assert.match(rpc, /client\.organization_id\s*=\s*v_organization_id/i);
  assert.match(rpc, /session\.organization_id\s*=\s*v_organization_id/i);
  assert.match(rpc, /work_timezone/i);
  assert.match(rpc, /work_date/i);
  assert.match(sql, /revoke all on function public\.get_active_talent_today\(uuid\) from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.get_active_talent_today\(uuid\) to service_role/i);
});
