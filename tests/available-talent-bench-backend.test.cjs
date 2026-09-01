const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

process.env.SUPABASE_URL = 'https://available-bench-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const root = path.resolve(__dirname, '..');
const backend = require(path.join(root, 'netlify', 'functions', 'available-talent-bench.js'));

const userId = '11111111-1111-4111-8111-111111111111';
const applicantId = '22222222-2222-4222-8222-222222222222';
const salesOwnerId = '33333333-3333-4333-8333-333333333333';
const otherSalesOwnerId = '44444444-4444-4444-8444-444444444444';
const requestId = '55555555-5555-4555-8555-555555555555';
const expectedUpdatedAt = '2026-09-01T15:30:00.000Z';

const PAYLOAD_KEYS = Object.freeze([
  'generatedAt', 'viewerRole', 'caseload', 'salesOwners', 'filters', 'items'
]);
const ITEM_KEYS = Object.freeze([
  'applicantId', 'fullName', 'preferredName', 'stage', 'vaTypes', 'verifiedSkills',
  'availability', 'rateMin', 'rateMax', 'rateLabel', 'yearsExperience', 'owner',
  'updatedAt', 'allowedActions'
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
    headers: { authorization: 'Bearer signed-in-bench-token' },
    queryStringParameters: {},
    multiValueQueryStringParameters: {},
    rawQueryString: '',
    body: '',
    ...overrides
  };
}

function benchItem(overrides = {}) {
  return {
    applicantId,
    fullName: 'Santos, Mariel Anne',
    preferredName: 'Mariel',
    stage: 'bench_ready',
    vaTypes: ['Medical VA'],
    verifiedSkills: ['Medical coding support'],
    availability: 'Full time',
    rateMin: 8,
    rateMax: 10,
    rateLabel: '$8-$10 USD per hour',
    yearsExperience: 3,
    owner: { id: null, name: 'Unassigned' },
    updatedAt: expectedUpdatedAt,
    allowedActions: ['claim'],
    ...overrides
  };
}

function benchPayload(overrides = {}) {
  return {
    generatedAt: '2026-09-01T15:35:00.000Z',
    viewerRole: 'sales',
    caseload: { claimed: 12, capacity: 40 },
    salesOwners: [
      { id: salesOwnerId, name: 'Morgan Lee', claimed: 12, capacity: 40, available: true },
      { id: otherSalesOwnerId, name: 'Sam Rivera', claimed: 40, capacity: 40, available: false }
    ],
    filters: {
      vaTypes: ['Medical VA'],
      verifiedSkills: ['Medical coding support'],
      availabilityOptions: ['Full time']
    },
    items: [benchItem()],
    ...overrides
  };
}

function installFetch(t, options = {}) {
  const {
    user = { id: userId },
    authStatus = 200,
    rpcStatus = 200,
    rpcBody = benchPayload()
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

test('GET authenticates once and derives organization, role, and caseload only from the verified actor', async t => {
  const calls = installFetch(t);
  const result = await backend.handler(event());

  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.headers.Pragma, 'no-cache');
  assert.equal(result.headers.Vary, 'Authorization');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://available-bench-test.supabase.co/auth/v1/user');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer signed-in-bench-token');
  assert.equal(calls[1].url, 'https://available-bench-test.supabase.co/rest/v1/rpc/get_available_talent_bench');
  assert.deepEqual(JSON.parse(calls[1].options.body), { p_actor_user_id: userId });
  assert.equal(calls[1].options.headers.Authorization, 'Bearer test-service-role-key');
});

test('the response contract keeps interviewing Talent visible and counted until placement begins', () => {
  assert.deepEqual(
    [...backend.STAGES].sort(),
    ['bench_ready', 'client_review', 'interviewing', 'shortlisted']
  );
  const publicInterview = backend.publicItem(benchItem({
    stage: 'interviewing',
    owner: { id: salesOwnerId, name: 'Morgan Lee' },
    allowedActions: []
  }), 'sales');
  assert.equal(publicInterview.stage, 'interviewing');
  assert.equal(publicInterview.owner.id, salesOwnerId);
});

test('legacy Sales Management may view the bench but can never receive claim or release actions', () => {
  assert.equal(backend.VIEWER_ROLES.has('sales_management'), true);
  const viewOnly = backend.publicPayload(benchPayload({
    viewerRole: 'sales_management',
    caseload: { claimed: 12, capacity: 80 },
    items: [benchItem({ allowedActions: [] })]
  }));
  assert.deepEqual(viewOnly.items[0].allowedActions, []);
  assert.throws(
    () => backend.publicPayload(benchPayload({ viewerRole: 'sales_management', items: [benchItem({ allowedActions: ['claim'] })] })),
    /invalid response/i
  );
});

test('GET rejects every client-selected scope before authentication', async t => {
  const calls = installFetch(t);
  const attempts = [
    event({ queryStringParameters: { organizationId: otherSalesOwnerId } }),
    event({ queryStringParameters: { role: 'admin' } }),
    event({ queryStringParameters: { salesOwnerId } }),
    event({ queryStringParameters: { caseloadLimit: '9999' } }),
    event({ multiValueQueryStringParameters: { applicantId: [applicantId] } }),
    event({ rawQueryString: `applicantId=${applicantId}` }),
    event({ body: JSON.stringify({ role: 'admin' }) })
  ];

  for (const request of attempts) {
    const result = await backend.handler(request);
    assert.equal(result.statusCode, 400);
    assert.equal(bodyOf(result).code, 'unsupported_scope');
  }
  assert.equal(calls.length, 0);
});

test('POST accepts only exact actor-independent action bodies and sends one atomic RPC', async t => {
  const calls = installFetch(t, { rpcBody: benchPayload() });
  const claim = { requestId, action: 'claim', applicantId, expectedUpdatedAt };
  const result = await backend.handler(event({ httpMethod: 'POST', body: JSON.stringify(claim) }));

  assert.equal(result.statusCode, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://available-bench-test.supabase.co/rest/v1/rpc/change_available_talent_bench');
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    p_actor_user_id: userId,
    p_request_id: requestId,
    p_applicant_id: applicantId,
    p_expected_updated_at: expectedUpdatedAt,
    p_action: 'claim',
    p_target_sales_owner_id: null,
    p_caseload_limit: null
  });

  const before = calls.length;
  for (const invalidBody of [
    { ...claim, organizationId: otherSalesOwnerId },
    { ...claim, role: 'admin' },
    { ...claim, salesOwnerId },
    { ...claim, caseloadLimit: 500 },
    { ...claim, unexpected: true }
  ]) {
    const rejected = await backend.handler(event({ httpMethod: 'POST', body: JSON.stringify(invalidBody) }));
    assert.equal(rejected.statusCode, 400);
    assert.equal(bodyOf(rejected).code, 'unsupported_scope');
  }
  for (const invalidBody of [
    { requestId, action: 'claim', applicantId },
    { requestId, action: 'set_limit', caseloadLimit: 55 },
    { requestId, action: 'set_limit', salesOwnerId, caseloadLimit: 0 }
  ]) {
    const rejected = await backend.handler(event({ httpMethod: 'POST', body: JSON.stringify(invalidBody) }));
    assert.equal(rejected.statusCode, 400);
    assert.ok(['invalid_request', 'unsupported_scope'].includes(bodyOf(rejected).code));
  }
  const unsupported = await backend.handler(event({
    httpMethod: 'POST',
    body: JSON.stringify({ requestId, action: 'delete', applicantId, expectedUpdatedAt })
  }));
  assert.equal(unsupported.statusCode, 400);
  assert.equal(bodyOf(unsupported).code, 'unsupported_action');
  assert.equal(calls.length, before, 'invalid actions must fail before authentication');
});

test('Admin and Talent Management assignment actions carry only a target owner id', async t => {
  const calls = installFetch(t, {
    rpcBody: benchPayload({
      viewerRole: 'talent_management',
      items: [benchItem({ allowedActions: ['assign'] })]
    })
  });
  for (const action of ['assign', 'reassign']) {
    const result = await backend.handler(event({
      httpMethod: 'POST',
      body: JSON.stringify({ requestId, action, applicantId, expectedUpdatedAt, salesOwnerId })
    }));
    assert.equal(result.statusCode, 200);
    const rpcBody = JSON.parse(calls.at(-1).options.body);
    assert.equal(rpcBody.p_action, action);
    assert.equal(rpcBody.p_target_sales_owner_id, salesOwnerId);
    assert.equal(rpcBody.p_actor_user_id, userId);
    assert.equal(rpcBody.p_caseload_limit, null);
  }
});

test('the Admin-only capacity action uses the same actor-scoped audited RPC', async t => {
  const calls = installFetch(t, {
    rpcBody: benchPayload({
      viewerRole: 'admin',
      caseload: { claimed: 12, capacity: 55 },
      items: [benchItem({ allowedActions: ['assign'] })]
    })
  });
  const result = await backend.handler(event({
    httpMethod: 'POST',
    body: JSON.stringify({ requestId, action: 'set_limit', salesOwnerId, caseloadLimit: 55 })
  }));

  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), {
    p_actor_user_id: userId,
    p_request_id: requestId,
    p_applicant_id: null,
    p_expected_updated_at: null,
    p_action: 'set_limit',
    p_target_sales_owner_id: salesOwnerId,
    p_caseload_limit: 55
  });
});

test('the public response is an exact operational allowlist with no private Talent data', async t => {
  installFetch(t, {
    rpcBody: benchPayload({
      organizationId: '66666666-6666-4666-8666-666666666666',
      caseload: { claimed: 12, capacity: 40, internalLimitSource: 'private' },
      salesOwners: [{
        id: salesOwnerId, name: 'Morgan Lee', claimed: 12, capacity: 40, available: true,
        email: 'morgan-private@example.com', authUserId: userId
      }],
      filters: {
        vaTypes: ['Medical VA'], verifiedSkills: ['Medical coding support'],
        availabilityOptions: ['Full time'], privateTaxonomy: 'private'
      },
      items: [benchItem({
        email: 'mariel@example.com', phone: '+63 917 555 0100', address: 'Private address',
        birthDate: '1998-01-10', genderIdentity: 'female', pronouns: ['she_her'],
        greatestDream: 'Private dream', resumeUrl: 'https://private.example/resume.pdf',
        organizationId: '66666666-6666-4666-8666-666666666666', authUserId: userId,
        talentReviewOwnerId: otherSalesOwnerId, talentSupportOwnerId: otherSalesOwnerId,
        owner: { id: salesOwnerId, name: 'Morgan Lee', email: 'morgan-private@example.com' }
      })]
    })
  });

  const result = await backend.handler(event());
  const payload = bodyOf(result);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(Object.keys(payload).sort(), [...PAYLOAD_KEYS].sort());
  assert.deepEqual(Object.keys(payload.caseload).sort(), ['capacity', 'claimed']);
  assert.deepEqual(Object.keys(payload.salesOwners[0]).sort(), ['available', 'capacity', 'claimed', 'id', 'name']);
  assert.deepEqual(Object.keys(payload.filters).sort(), ['availabilityOptions', 'vaTypes', 'verifiedSkills']);
  assert.deepEqual(Object.keys(payload.items[0]).sort(), [...ITEM_KEYS].sort());
  assert.deepEqual(Object.keys(payload.items[0].owner).sort(), ['id', 'name']);
  for (const privateValue of [
    'mariel@example.com', '+63 917 555 0100', 'Private address', '1998-01-10',
    'Private dream', 'private.example', 'morgan-private@example.com',
    '66666666-6666-4666-8666-666666666666', userId
  ]) {
    assert.equal(result.body.includes(privateValue), false, `must not expose ${privateValue}`);
  }
});

test('a real empty bench remains empty and never receives sample Talent', async t => {
  installFetch(t, {
    rpcBody: benchPayload({
      caseload: { claimed: 0, capacity: 40 }, salesOwners: [],
      filters: { vaTypes: [], verifiedSkills: [], availabilityOptions: [] }, items: []
    })
  });
  const result = await backend.handler(event());
  const payload = bodyOf(result);

  assert.deepEqual(payload.items, []);
  assert.deepEqual(payload.caseload, { claimed: 0, capacity: 40 });
  assert.doesNotMatch(result.body, /Mariel|Morgan|sample|demo/i);
});

test('signed-out, invalid, and unauthorized callers never receive bench data', async t => {
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
  assert.equal(bodyOf(forbidden).code, 'bench_forbidden');
  assert.equal(forbidden.body.includes('private organization'), false);
});

test('claim collisions, full caseloads, and stale cards return safe conflicts', async t => {
  const cases = [
    ['Talent is already claimed by another Sales Associate.', 'claim_conflict'],
    ['Sales Associate has reached the available Talent caseload limit.', 'caseload_full'],
    ['This Talent profile changed after it was opened.', 'bench_stale']
  ];
  for (const [message, code] of cases) {
    installFetch(t, { rpcStatus: 400, rpcBody: { code: 'P0001', message } });
    const result = await backend.handler(event({
      httpMethod: 'POST',
      body: JSON.stringify({ requestId, action: 'claim', applicantId, expectedUpdatedAt })
    }));
    assert.equal(result.statusCode, 409);
    assert.equal(bodyOf(result).code, code);
    assert.deepEqual(Object.keys(bodyOf(result)).sort(), ['code', 'message']);
  }
});

test('malformed successful RPC payloads fail closed and unsupported methods do not authenticate', async t => {
  for (const rpcBody of [null, [], {}, { generatedAt: 'not-a-date', items: [] }]) {
    installFetch(t, { rpcBody });
    const result = await backend.handler(event());
    assert.equal(result.statusCode, 502);
    assert.deepEqual(Object.keys(bodyOf(result)).sort(), ['code', 'message']);
  }

  const calls = installFetch(t);
  for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const result = await backend.handler(event({ httpMethod: method }));
    assert.equal(result.statusCode, 405);
    assert.equal(result.headers.Allow, 'GET, POST');
  }
  assert.equal(calls.length, 0);
});
