const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(
  path.join(root, 'netlify', 'functions', 'client-talent-profile.js'),
  'utf8'
);

process.env.SUPABASE_URL = 'https://client-talent-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
const backend = require('../netlify/functions/client-talent-profile.js');

const userId = '11111111-1111-4111-8111-111111111111';
const organizationId = '22222222-2222-4222-8222-222222222222';
const clientId = '33333333-3333-4333-8333-333333333333';
const contactId = '44444444-4444-4444-8444-444444444444';
const talentOneId = '55555555-5555-4555-8555-555555555555';
const talentTwoId = '66666666-6666-4666-8666-666666666666';
const assignmentOneId = '77777777-7777-4777-8777-777777777777';
const assignmentTwoId = '88888888-8888-4888-8888-888888888888';
const assignmentThreeId = '99999999-9999-4999-8999-999999999999';

function response(data, status = 200) {
  return new Response(data === undefined ? '' : JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function event(overrides = {}) {
  return {
    httpMethod: 'GET',
    headers: { authorization: 'Bearer signed-in-client-token' },
    ...overrides
  };
}

function applicant(overrides = {}) {
  return {
    id: talentOneId,
    full_name: 'Jordan Rivera',
    country: 'Philippines',
    timezone: 'Asia/Manila',
    verified_skills: ['Medical coding', 'Insurance claims', 'Medical coding'],
    relevant_experience_years: '4.5',
    relevant_experience_summary: 'Medical back-office support.',
    education_training_summary: 'Certified coding coursework.',
    english_test_result: '95 practice',
    personality_profile_score: 'INFJ-A',
    computer_specs: 'MacBook Air, 16 GB',
    internet_speed: '100 Mbps download, 40 Mbps upload',
    // The mapper must ignore unexpected upstream fields even if a mock adds them.
    email: 'private@example.com',
    phone: '+63 private',
    address_line_1: 'Private street',
    birth_date: '1990-01-01',
    gender_identity: 'private',
    pronouns: ['private'],
    expected_hourly_rate: 20,
    greatest_dream: 'Private goal',
    self_reported_skills: ['Unverified skill'],
    talent_review_owner_id: 'private-owner',
    resume_url: 'https://private.example/resume',
    ...overrides
  };
}

function installFetch(t, options = {}) {
  const {
    role = 'client_admin',
    access = true,
    memberships = [{
      user_id: userId,
      organization_id: organizationId,
      client_id: clientId,
      client_contact_id: contactId
    }],
    clients = [{ id: clientId }],
    contacts = [{ id: contactId }],
    placements = [
      { id: assignmentOneId, applicant_id: talentOneId, status: 'active', start_date: '2026-08-01', end_date: null, schedule_summary: 'Monday-Friday' },
      { id: assignmentTwoId, applicant_id: talentOneId, status: 'onboarding', start_date: '2026-08-20', end_date: '2026-12-31', schedule_summary: 'Training schedule' },
      { id: assignmentThreeId, applicant_id: talentTwoId, status: 'working', start_date: '2026-08-10', end_date: null, schedule_summary: null },
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', applicant_id: talentTwoId, status: 'completed', start_date: '2025-01-01', end_date: null, schedule_summary: 'Do not return' },
      { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', applicant_id: talentTwoId, status: 'active', start_date: '2025-01-01', end_date: '2026-01-31', schedule_summary: 'Past placement' }
    ],
    applicants = [
      applicant(),
      applicant({
        id: talentTwoId,
        full_name: 'Alex Santos',
        verified_skills: ['Executive assistance'],
        relevant_experience_years: 2,
        english_test_result: null,
        personality_profile_score: null,
        computer_specs: null,
        internet_speed: null
      })
    ]
  } = options;
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, requestOptions = {}) => {
    const value = String(url);
    calls.push({ url: value, options: requestOptions });
    if (value.endsWith('/auth/v1/user')) return response({ id: userId });
    if (value.includes('/rest/v1/platform_users?')) {
      return response(access ? [{ id: userId, organization_id: organizationId, role }] : []);
    }
    if (value.includes('/rest/v1/client_portal_memberships?')) return response(memberships);
    if (value.includes('/rest/v1/clients?')) return response(clients);
    if (value.includes('/rest/v1/client_contacts?')) return response(contacts);
    if (value.includes('/rest/v1/placements?')) return response(placements);
    if (value.includes('/rest/v1/applicants?')) return response(applicants);
    throw new Error(`Unexpected fetch: ${value}`);
  };
  t.after(() => { global.fetch = originalFetch; });
  return calls;
}

function bodyOf(result) {
  return JSON.parse(result.body);
}

test('Talent viewing is limited to Client Admin and Client Reviewer', () => {
  assert.deepEqual([...backend.TALENT_VIEW_ROLES].sort(), ['client_admin', 'client_reviewer']);
  assert.equal(backend.TALENT_VIEW_ROLES.has('client_billing'), false);
  assert.equal(backend.TALENT_VIEW_ROLES.has('admin'), false);
});

test('the database applicant projection is a strict client-safe allowlist', () => {
  assert.deepEqual(backend.TALENT_SELECT, [
    'id', 'full_name', 'country', 'timezone',
    'verified_skills', 'relevant_experience_years', 'relevant_experience_summary',
    'education_training_summary', 'english_test_result', 'personality_profile_score',
    'computer_specs', 'internet_speed'
  ]);
  const forbidden = [
    'email', 'phone', 'address_line_1', 'address_line_2', 'postal_code', 'birth_date',
    'preferred_name', 'city', 'gender_identity', 'pronouns', 'expected_hourly_rate', 'greatest_dream', 'status',
    'talent_review_owner_id', 'sales_owner_id', 'talent_support_owner_id',
    'self_reported_skills', 'self_reported_experience_areas', 'resume_url',
    'loom_video_url', 'interview_video_reference', 'storage_path', 'external_url'
  ];
  forbidden.forEach(field => assert.equal(backend.TALENT_SELECT.includes(field), false, `${field} must stay private.`));
  assert.doesNotMatch(source, /from\(['"]documents|\/rest\/v1\/documents|createSignedUrl|storage_path|external_url/i);
});

test('GET derives company scope from the signed-in membership and returns multiple assigned Talent safely', async t => {
  const calls = installFetch(t);
  const result = await backend.handler(event());
  const body = bodyOf(result);

  assert.equal(result.statusCode, 200);
  assert.equal(body.count, 2);
  assert.deepEqual(body.presentation, {
    tabs: ['profile'],
    readOnly: true,
    documentsAvailable: false,
    sourceFilesAvailable: false
  });
  assert.deepEqual(body.talents.map(item => item.displayName), ['Alex Santos', 'Jordan Rivera']);
  const jordan = body.talents.find(item => item.id === talentOneId);
  assert.deepEqual(jordan.location, { country: 'Philippines', timeZone: 'Asia/Manila' });
  assert.deepEqual(jordan.skills.verified, ['Medical coding', 'Insurance claims']);
  assert.equal(jordan.experience.years, 4.5);
  assert.equal(jordan.screening.englishResult, '95 practice');
  assert.deepEqual(jordan.assignments.map(item => item.id), [assignmentOneId, assignmentTwoId]);

  const serialized = JSON.stringify(body);
  [
    'private@example.com', '+63 private', 'Private street', '1990-01-01',
    'Private goal', 'Unverified skill', 'private-owner', 'private.example/resume',
    'Do not return', 'Past placement', clientId, contactId, organizationId, userId
  ].forEach(secret => assert.equal(serialized.includes(secret), false, `Response leaked ${secret}.`));

  const membershipCall = calls.find(call => call.url.includes('/client_portal_memberships?'));
  assert.match(membershipCall.url, new RegExp(`user_id=eq\\.${userId}`));
  assert.match(membershipCall.url, new RegExp(`organization_id=eq\\.${organizationId}`));
  const placementCall = calls.find(call => call.url.includes('/placements?'));
  assert.match(placementCall.url, new RegExp(`client_id=eq\\.${clientId}`));
  const applicantCall = calls.find(call => call.url.includes('/applicants?'));
  assert.match(applicantCall.url, new RegExp(`organization_id=eq\\.${organizationId}`));
  assert.match(applicantCall.url, /archived_at=is\.null/);
});

test('same canonical applicant fields are read on each request so approved updates propagate', async t => {
  let currentName = 'Jordan Rivera';
  const calls = installFetch(t, {
    placements: [{ id: assignmentOneId, applicant_id: talentOneId, status: 'active', start_date: '2026-08-01', end_date: null, schedule_summary: null }],
    applicants: []
  });
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).includes('/rest/v1/applicants?')) return response([applicant({ full_name: currentName })]);
    return originalFetch(url, options);
  };

  const first = bodyOf(await backend.handler(event()));
  currentName = 'Jordan Rivera-Santos';
  const second = bodyOf(await backend.handler(event()));
  assert.equal(first.talents[0].displayName, 'Jordan Rivera');
  assert.equal(second.talents[0].displayName, 'Jordan Rivera-Santos');
  assert.equal(calls.filter(call => call.url.includes('/placements?')).length, 2);
});

test('terminal, past, and malformed-ended placements are excluded fail closed', () => {
  assert.equal(backend.isCurrentPlacement({ status: 'active', end_date: null }, '2026-08-29'), true);
  assert.equal(backend.isCurrentPlacement({ status: 'onboarding', end_date: '2026-08-29' }, '2026-08-29'), true);
  assert.equal(backend.isCurrentPlacement({ status: 'working', end_date: '2026-08-30' }, '2026-08-29'), true);
  assert.equal(backend.isCurrentPlacement({ status: 'completed', end_date: null }, '2026-08-29'), false);
  assert.equal(backend.isCurrentPlacement({ status: 'active', end_date: '2026-08-28' }, '2026-08-29'), false);
  assert.equal(backend.isCurrentPlacement({ status: 'active', end_date: 'not-a-date' }, '2026-08-29'), false);
});

test('Client Billing and internal roles are denied before membership or Talent data is queried', async t => {
  const billingCalls = installFetch(t, { role: 'client_billing' });
  const billing = await backend.handler(event());
  assert.equal(billing.statusCode, 403);
  assert.equal(bodyOf(billing).code, 'talent_view_forbidden');
  assert.equal(billingCalls.some(call => call.url.includes('/client_portal_memberships?')), false);
});

test('inactive access, missing membership, archived Client, and inactive contact all fail closed', async t => {
  installFetch(t, { access: false });
  const inactive = await backend.handler(event());
  assert.equal(inactive.statusCode, 403);

  const originalFetch = global.fetch;
  installFetch(t, { memberships: [] });
  const unlinked = await backend.handler(event());
  assert.equal(unlinked.statusCode, 404);

  global.fetch = originalFetch;
  installFetch(t, { clients: [] });
  const archived = await backend.handler(event());
  assert.equal(archived.statusCode, 404);

  global.fetch = originalFetch;
  installFetch(t, { contacts: [] });
  const contact = await backend.handler(event());
  assert.equal(contact.statusCode, 404);
});

test('no current placements returns an empty safe result without querying applicants', async t => {
  const calls = installFetch(t, {
    placements: [{ id: assignmentOneId, applicant_id: talentOneId, status: 'completed', start_date: '2025-01-01', end_date: null, schedule_summary: null }]
  });
  const result = await backend.handler(event());
  assert.equal(result.statusCode, 200);
  assert.deepEqual(bodyOf(result).talents, []);
  assert.equal(calls.some(call => call.url.includes('/applicants?')), false);
});

test('query, body, unsupported methods, and missing authentication cannot supply another scope', async () => {
  const query = await backend.handler(event({ queryStringParameters: { clientId: 'another-client' } }));
  assert.equal(query.statusCode, 400);
  assert.equal(bodyOf(query).code, 'unsupported_scope');

  const body = await backend.handler(event({ body: JSON.stringify({ talentId: talentOneId }) }));
  assert.equal(body.statusCode, 400);
  assert.equal(bodyOf(body).code, 'unsupported_scope');

  const post = await backend.handler(event({ httpMethod: 'POST' }));
  assert.equal(post.statusCode, 405);
  assert.equal(post.headers.Allow, 'GET');

  const signedOut = await backend.handler({ httpMethod: 'GET', headers: {} });
  assert.equal(signedOut.statusCode, 401);
  assert.equal(bodyOf(signedOut).code, 'authentication_required');
});
