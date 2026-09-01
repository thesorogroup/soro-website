const assert = require('node:assert/strict');
const test = require('node:test');

const previousUrl = process.env.SUPABASE_URL;
const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.SUPABASE_URL = 'https://shortlist-tests.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
const shortlistService = require('../netlify/functions/client-shortlists.js');

test.after(() => {
  if (previousUrl === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = previousUrl;
  if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
});

const IDS = Object.freeze({
  actor: '11111111-1111-4111-8111-111111111111',
  requestOperation: '22222222-2222-4222-8222-222222222222',
  hiringRequest: '33333333-3333-4333-8333-333333333333',
  client: '44444444-4444-4444-8444-444444444444',
  applicant: '55555555-5555-4555-8555-555555555555',
  shortlist: '66666666-6666-4666-8666-666666666666',
  item: '77777777-7777-4777-8777-777777777777',
  salesOwner: '88888888-8888-4888-8888-888888888888'
});
const UPDATED_AT = '2026-09-01T12:34:56.000Z';

function emptyPayload(viewerRole = 'sales') {
  return {
    generatedAt: UPDATED_AT,
    viewerRole,
    requests: [],
    candidates: [],
    shortlists: [],
    notifications: []
  };
}

function clientPayload() {
  return {
    generatedAt: UPDATED_AT,
    viewerRole: 'client_reviewer',
    requests: [{
      hiringRequestId: IDS.hiringRequest,
      clientId: IDS.client,
      clientName: 'Example Client',
      title: 'Operations Assistant',
      status: 'open',
      startDate: '2026-09-15',
      numberOfTalent: 1,
      canAddCandidate: false
    }],
    candidates: [],
    shortlists: [{
      shortlistId: IDS.shortlist,
      hiringRequestId: IDS.hiringRequest,
      clientId: IDS.client,
      clientName: 'Example Client',
      requestTitle: 'Operations Assistant',
      roundNumber: 1,
      status: 'sent',
      sentAt: UPDATED_AT,
      updatedAt: UPDATED_AT,
      salesOwnerId: IDS.salesOwner,
      canSend: false,
      internalNote: 'must not leave the service',
      items: [{
        shortlistItemId: IDS.item,
        applicantId: IDS.applicant,
        candidate: {
          applicantId: IDS.applicant,
          displayName: 'Taylor Candidate',
          country: 'Philippines',
          timeZone: 'Asia/Manila',
          verifiedSkills: ['Scheduling', 'Email management'],
          yearsExperience: 4,
          experienceSummary: 'Supported a distributed operations team.',
          educationAndTraining: 'Business administration training.',
          screening: {
            englishResult: 'Verified professional proficiency',
            personalityResult: 'Verified client-safe work-style summary',
            computerSpecifications: 'Verified workstation',
            internetSpeed: 'Verified broadband',
            privateAssessmentNote: 'must not leave the service'
          },
          email: 'private@example.test',
          phone: '+1 555 0100',
          preferredName: 'Private preference',
          expectedHourlyRate: 99,
          resumeUrl: 'https://private.invalid/resume',
          internalNotes: 'must not leave the service'
        },
        response: null,
        respondedAt: null,
        addedAt: UPDATED_AT,
        updatedAt: UPDATED_AT,
        canRemove: false,
        canRespond: true
      }]
    }],
    notifications: []
  };
}

function internalDraftPayload(viewerRole = 'sales') {
  const payload = clientPayload();
  payload.viewerRole = viewerRole;
  payload.requests[0].canAddCandidate = false;
  payload.candidates = [];
  payload.shortlists[0].status = 'draft';
  payload.shortlists[0].sentAt = null;
  payload.shortlists[0].canSend = false;
  payload.shortlists[0].items[0].canRemove = false;
  payload.shortlists[0].items[0].canRespond = false;
  return payload;
}

test('POST actions require requestId and the expected record version', () => {
  const add = shortlistService.inputActionBody({
    action: 'add_candidate',
    requestId: IDS.requestOperation,
    expectedUpdatedAt: UPDATED_AT,
    hiringRequestId: IDS.hiringRequest,
    applicantId: IDS.applicant
  });
  assert.deepEqual(add, {
    action: 'add_candidate',
    requestId: IDS.requestOperation,
    expectedUpdatedAt: UPDATED_AT,
    hiringRequestId: IDS.hiringRequest,
    applicantId: IDS.applicant,
    shortlistId: null,
    shortlistItemId: null,
    response: null
  });

  assert.throws(() => shortlistService.inputActionBody({
    action: 'send_shortlist',
    requestId: IDS.requestOperation,
    shortlistId: IDS.shortlist
  }), /fields|required|Reload/i);
  assert.throws(() => shortlistService.inputActionBody({
    action: 'send_shortlist',
    requestId: IDS.requestOperation,
    expectedUpdatedAt: UPDATED_AT,
    shortlistId: IDS.shortlist,
    clientId: IDS.client
  }), /Only the fields/i);
});

test('Client responses accept only the three approved immutable decisions', () => {
  for (const response of ['request_interview', 'interested', 'not_a_fit']) {
    const input = shortlistService.inputActionBody({
      action: 'respond_candidate',
      requestId: IDS.requestOperation,
      expectedUpdatedAt: UPDATED_AT,
      shortlistItemId: IDS.item,
      response
    });
    assert.equal(input.response, response);
  }
  for (const response of ['not_fit', 'approve', 'reject', 'maybe', 'hire']) {
    assert.throws(() => shortlistService.inputActionBody({
      action: 'respond_candidate',
      requestId: IDS.requestOperation,
      expectedUpdatedAt: UPDATED_AT,
      shortlistItemId: IDS.item,
      response
    }), /Request interview, Interested, or Not a fit/i);
  }
});

test('Client payload strips private, internal, ownership, and source fields', () => {
  const payload = shortlistService.publicPayload(clientPayload());
  assert.equal(payload.viewerRole, 'client_reviewer');
  assert.equal(payload.requests[0].canAddCandidate, false);
  assert.equal(Object.hasOwn(payload.shortlists[0], 'salesOwnerId'), false);
  assert.equal(Object.hasOwn(payload.shortlists[0], 'internalNote'), false);

  const candidate = payload.shortlists[0].items[0].candidate;
  assert.deepEqual(Object.keys(candidate), [
    'applicantId',
    'displayName',
    'country',
    'timeZone',
    'verifiedSkills',
    'yearsExperience',
    'experienceSummary',
    'educationAndTraining',
    'screening'
  ]);
  assert.deepEqual(Object.keys(candidate.screening), [
    'englishResult',
    'personalityResult',
    'computerSpecifications',
    'internetSpeed'
  ]);
  const serialized = JSON.stringify(payload);
  for (const secret of [
    'private@example.test',
    '+1 555 0100',
    'Private preference',
    'https://private.invalid/resume',
    'must not leave the service'
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('Client payload fails closed if candidate-pool or draft data crosses the role boundary', () => {
  const candidateLeak = clientPayload();
  candidateLeak.candidates.push({ applicantId: IDS.applicant });
  assert.throws(() => shortlistService.publicPayload(candidateLeak), /invalid response/i);

  const draftLeak = clientPayload();
  draftLeak.shortlists[0].status = 'draft';
  draftLeak.shortlists[0].sentAt = null;
  assert.throws(() => shortlistService.publicPayload(draftLeak), /invalid response/i);
});

test('server permission booleans may fail closed without invalidating a valid workspace', () => {
  const adminStaleDraft = shortlistService.publicPayload(internalDraftPayload('admin'));
  assert.equal(adminStaleDraft.shortlists[0].canSend, false);
  assert.equal(adminStaleDraft.shortlists[0].items[0].canRemove, false);

  const salesStaleDraft = shortlistService.publicPayload(internalDraftPayload('sales'));
  assert.equal(salesStaleDraft.shortlists[0].canSend, false);
  assert.equal(salesStaleDraft.shortlists[0].items[0].canRemove, false);

  const clientIneligible = clientPayload();
  clientIneligible.shortlists[0].items[0].canRespond = false;
  const mappedClient = shortlistService.publicPayload(clientIneligible);
  assert.equal(mappedClient.shortlists[0].items[0].canRespond, false);
});

test('server permission booleans cannot grant actions outside the coarse role and state boundary', () => {
  const clientSend = clientPayload();
  clientSend.shortlists[0].canSend = true;
  assert.throws(() => shortlistService.publicPayload(clientSend), /invalid response/i);

  const clientRemove = clientPayload();
  clientRemove.shortlists[0].items[0].canRemove = true;
  assert.throws(() => shortlistService.publicPayload(clientRemove), /invalid response/i);

  const salesRespond = internalDraftPayload('sales');
  salesRespond.shortlists[0].items[0].canRespond = true;
  assert.throws(() => shortlistService.publicPayload(salesRespond), /invalid response/i);
});

test('POST handler derives actor scope and passes only the exact RPC contract', async t => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith('/auth/v1/user')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: IDS.actor })
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(emptyPayload('sales'))
    };
  };
  t.after(() => { global.fetch = originalFetch; });

  const result = await shortlistService.handler({
    httpMethod: 'POST',
    headers: { authorization: 'Bearer user-token' },
    body: JSON.stringify({
      action: 'send_shortlist',
      requestId: IDS.requestOperation,
      expectedUpdatedAt: UPDATED_AT,
      shortlistId: IDS.shortlist
    })
  });
  assert.equal(result.statusCode, 200);
  assert.equal(requests.length, 2);
  assert.match(requests[1].url, /\/rest\/v1\/rpc\/change_client_shortlist$/);
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    p_actor_user_id: IDS.actor,
    p_request_id: IDS.requestOperation,
    p_action: 'send_shortlist',
    p_expected_updated_at: UPDATED_AT,
    p_hiring_request_id: null,
    p_applicant_id: null,
    p_shortlist_id: IDS.shortlist,
    p_shortlist_item_id: null,
    p_response: null
  });
});
