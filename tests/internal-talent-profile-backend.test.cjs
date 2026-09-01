const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

process.env.SUPABASE_URL = 'https://global-search-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const root = path.resolve(__dirname, '..');
const backend = require(path.join(root, 'netlify', 'functions', 'internal-talent-profile.js'));

const userId = '11111111-1111-4111-8111-111111111111';
const applicantId = '22222222-2222-4222-8222-222222222222';

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
    queryStringParameters: { id: applicantId },
    multiValueQueryStringParameters: {},
    rawQueryString: `id=${applicantId}`,
    body: '',
    ...overrides
  };
}

function talent(overrides = {}) {
  return {
    id: applicantId,
    full_name: 'Santos, Mariel Anne',
    preferred_name: 'Mariel',
    country: 'Philippines',
    timezone: 'Asia/Manila',
    status: 'bench_ready',
    work_status: 'seeking_work',
    availability_note: 'Full time',
    application_received_at: '2026-08-24T12:00:00+00:00',
    expected_hourly_rate_text: '$8-$10 USD per hour',
    verified_skills: ['Calendar management', 'Medical scheduling'],
    self_reported_experience_areas: ['medical', 'general_admin'],
    self_reported_skills: ['Inbox management', 'Insurance verification'],
    other_experience_specialty: null,
    relevant_experience_years: 4.5,
    relevant_experience_summary: 'Four years supporting remote medical teams.',
    education_training_summary: 'Business administration and healthcare support training.',
    english_test_result: '92%',
    personality_profile_score: 'DISC: S 35, C 29 | Enneagram: Type 2 | MBTI: ENFJ-A',
    computer_specs: 'Laptop | 16 GB | Windows 11',
    internet_speed: '95 Mbps download · 45 Mbps upload',
    ...overrides
  };
}

function installFetch(t, options = {}) {
  const { authStatus = 200, rpcStatus = 200, rpcBody = talent() } = options;
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, requestOptions = {}) => {
    const call = { url: String(url), options: requestOptions };
    calls.push(call);
    if (call.url.endsWith('/auth/v1/user')) return response({ id: userId }, authStatus);
    if (call.url.endsWith('/rest/v1/rpc/get_internal_talent_profile')) return response(rpcBody, rpcStatus);
    throw new Error(`Unexpected fetch: ${call.url}`);
  };
  t.after(() => { global.fetch = originalFetch; });
  return calls;
}

function bodyOf(value) {
  return JSON.parse(value.body);
}

test('GET verifies the bearer identity and derives Talent scope from the actor-scoped RPC', async t => {
  const calls = installFetch(t);
  const responseValue = await backend.handler(event());

  assert.equal(responseValue.statusCode, 200);
  assert.equal(responseValue.headers['Cache-Control'], 'no-store');
  assert.equal(responseValue.headers.Pragma, 'no-cache');
  assert.equal(responseValue.headers.Vary, 'Authorization');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer signed-in-employee-token');
  assert.equal(calls[1].url, 'https://global-search-test.supabase.co/rest/v1/rpc/get_internal_talent_profile');
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    p_actor_user_id: userId,
    p_applicant_id: applicantId
  });
  assert.equal(calls[1].options.headers.Authorization, 'Bearer test-service-role-key');
});

test('Talent profile scope accepts exactly one valid UUID and no request body', async t => {
  const calls = installFetch(t);
  const invalid = [
    event({ queryStringParameters: {} }),
    event({ queryStringParameters: { id: 'not-a-uuid' } }),
    event({ queryStringParameters: { id: applicantId, organizationId: userId } }),
    event({ multiValueQueryStringParameters: { id: [applicantId, userId] } }),
    event({ body: JSON.stringify({ role: 'sales' }) })
  ];
  for (const request of invalid) {
    const rejected = await backend.handler(request);
    assert.equal(rejected.statusCode, 400);
    assert.equal(bodyOf(rejected).code, 'unsupported_scope');
  }
  assert.equal(calls.length, 0);
});

test('the public Talent projection returns only the approved matching fields', async t => {
  installFetch(t, {
    rpcBody: talent({
      email: 'private@example.com',
      phone: '+63 private',
      birth_date: '1995-01-02',
      gender_identity: 'private identity',
      address_line_1: 'private street',
      greatest_dream: 'private dream',
      talent_review_owner_id: userId,
      resume_url: 'https://private.example/resume.pdf',
      legacy_application_data: { private: true }
    })
  });
  const responseValue = await backend.handler(event());
  const body = bodyOf(responseValue);

  assert.equal(responseValue.statusCode, 200);
  assert.deepEqual(Object.keys(body), ['talent']);
  assert.deepEqual(Object.keys(body.talent), [
    'id', 'full_name', 'preferred_name', 'country', 'timezone', 'status', 'work_status',
    'availability_note', 'application_received_at', 'expected_hourly_rate_text',
    'verified_skills', 'self_reported_experience_areas', 'self_reported_skills',
    'other_experience_specialty', 'relevant_experience_years',
    'relevant_experience_summary', 'education_training_summary', 'english_test_result',
    'personality_profile_score', 'computer_specs', 'internet_speed'
  ]);
  for (const privateValue of [
    'private@example.com', '+63 private', '1995-01-02', 'private identity',
    'private street', 'private dream', userId, 'private.example', 'legacy_application_data'
  ]) {
    assert.equal(responseValue.body.includes(privateValue), false, `must not expose ${privateValue}`);
  }
});

test('malformed profile fields fail closed before a response is returned', () => {
  const invalid = [
    null,
    [],
    {},
    talent({ status: null }),
    talent({ application_received_at: 'not-a-timestamp' }),
    talent({ relevant_experience_years: -1 }),
    talent({ verified_skills: ['Duplicate', 'duplicate'] }),
    talent({ self_reported_skills: Array.from({ length: 101 }, (_, index) => `Skill ${index}`) }),
    talent({ computer_specs: { unsafe: true } })
  ];
  for (const value of invalid) {
    assert.throws(
      () => backend.publicTalent(value),
      error => error?.status === 502 && error?.code === 'talent_profile_service_error'
    );
  }
});

test('unauthorized roles and cross-organization or archived Talent misses are safely translated', async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  for (const [rpcBody, rpcStatus, status, code] of [
    [{ code: '42501', message: 'private role detail' }, 400, 403, 'talent_profile_forbidden'],
    [{ code: 'P0002', message: 'private organization detail' }, 400, 404, 'talent_profile_not_found'],
    [{ code: 'PGRST202', message: 'missing function' }, 404, 503, 'service_unavailable']
  ]) {
    global.fetch = async url => String(url).endsWith('/auth/v1/user')
      ? response({ id: userId })
      : response(rpcBody, rpcStatus);
    const responseValue = await backend.handler(event());
    assert.equal(responseValue.statusCode, status);
    assert.equal(bodyOf(responseValue).code, code);
    assert.equal(responseValue.body.includes('private'), false);
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
