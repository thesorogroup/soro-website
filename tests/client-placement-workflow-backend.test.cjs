const assert = require('node:assert/strict');
const test = require('node:test');

process.env.SUPABASE_URL = 'https://client-placement-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.MICROSOFT_TENANT_ID = 'test-tenant';
process.env.MICROSOFT_CLIENT_ID = 'test-client';
process.env.MICROSOFT_CLIENT_SECRET = 'test-secret';
process.env.MICROSOFT_SHARED_ORGANIZER_USER_ID = 'talents@thesorogroup.com';

const backend = require('../netlify/functions/client-placement-workflow.js');

const userId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const hiringRequestId = '33333333-3333-4333-8333-333333333333';
const clientId = '44444444-4444-4444-8444-444444444444';
const shortlistId = '55555555-5555-4555-8555-555555555555';
const shortlistItemId = '66666666-6666-4666-8666-666666666666';
const applicantId = '77777777-7777-4777-8777-777777777777';
const interviewId = '88888888-8888-4888-8888-888888888888';
const updatedAt = '2026-09-01T17:30:00.000Z';
const retryRequestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const originalCalendarTransactionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function response(data, status = 200) {
  return new Response(data === undefined ? '' : JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function event(method = 'GET', overrides = {}) {
  return {
    httpMethod: method,
    headers: { authorization: 'Bearer signed-in-placement-token' },
    queryStringParameters: method === 'GET' ? { hiringRequestId } : {},
    multiValueQueryStringParameters: {},
    rawQueryString: method === 'GET' ? `hiringRequestId=${hiringRequestId}` : '',
    body: '',
    ...overrides
  };
}

function rawState(role = 'admin', overrides = {}) {
  const internal = ['admin', 'sales_management', 'sales', 'talent_management'].includes(role);
  return {
    generatedAt: '2026-09-01T17:35:00.000Z',
    viewerRole: role,
    request: {
      hiringRequestId,
      clientId,
      companyName: 'Northstar Legal',
      title: 'Legal Operations Assistant',
      status: 'interviewing',
      seats: 1,
      filledSeats: 0,
      updatedAt
    },
    permissions: {
      scheduleInterview: internal && role !== 'talent_management',
      finalDecision: role === 'client_admin',
      prepareHandoff: internal && role !== 'talent_management',
      confirmPlacement: role === 'admin' || role === 'talent_management',
      manageOnboarding: role === 'admin' || role === 'talent_management'
    },
    candidates: [{
      shortlistItemId,
      shortlistId,
      clientResponse: 'request_interview',
      workflowState: 'active',
      updatedAt,
      applicant: {
        applicantId,
        fullName: 'Santos, Mariel Anne',
        preferredName: 'Mariel',
        email: 'private-talent@example.com'
      },
      interviews: [{
        interviewId,
        roundNumber: 1,
        status: 'scheduled',
        startsAt: '2099-09-05T16:00:00.000Z',
        endsAt: '2099-09-05T16:30:00.000Z',
        timezone: 'America/Chicago',
        outcome: 'advance',
        notes: 'SECRET INTERNAL INTERVIEW NOTE',
        calendar: {
          status: 'synced',
          joinUrl: 'https://teams.microsoft.com/l/meetup-join/safe',
          eventId: 'SECRET GRAPH EVENT',
          needsCreateRetry: false
        },
        updatedAt
      }],
      decision: null
    }],
    handoffs: [{
      handoffId: requestId,
      decisionId: userId,
      shortlistItemId,
      applicantId,
      status: 'prepared',
      startDate: '2099-10-01',
      scheduleSummary: 'Full time',
      rateType: 'hourly',
      clientRate: 18,
      talentRate: 10,
      placementId: null,
      updatedAt
    }],
    placements: [],
    organizationId: '99999999-9999-4999-8999-999999999999',
    ...overrides
  };
}

function installFetch(t, route) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    const call = { url: String(url), options };
    calls.push(call);
    return route(call, calls);
  };
  t.after(() => { global.fetch = original; });
  return calls;
}

function bodyOf(result) { return JSON.parse(result.body); }

test('GET accepts only one hiring request and sends only actor plus request to the scoped RPC', async t => {
  const calls = installFetch(t, call => {
    if (call.url.endsWith('/auth/v1/user')) return response({ id: userId });
    if (call.url.endsWith('/rest/v1/rpc/get_client_placement_workspace')) return response(rawState('admin'));
    throw new Error(`Unexpected fetch ${call.url}`);
  });
  const result = await backend.handler(event());
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    p_actor_user_id: userId,
    p_hiring_request_id: hiringRequestId
  });

  for (const invalid of [
    event('GET', { queryStringParameters: { hiringRequestId, organizationId: userId } }),
    event('GET', { queryStringParameters: { hiringRequestId, role: 'admin' } }),
    event('GET', { rawQueryString: `hiringRequestId=${hiringRequestId}&hiringRequestId=${hiringRequestId}` }),
    event('GET', { body: '{}' })
  ]) {
    const rejected = await backend.handler(invalid);
    assert.equal(rejected.statusCode, 400);
  }
});

test('Client projection strips Talent contact data, internal notes, rates, organization ids, and Graph ids', () => {
  const mapped = backend.publicPayload(rawState('client_admin'));
  assert.equal(Object.hasOwn(mapped.candidates[0].applicant, 'email'), false);
  assert.equal(Object.hasOwn(mapped.candidates[0].interviews[0], 'outcome'), false);
  assert.equal(Object.hasOwn(mapped.candidates[0].interviews[0], 'notes'), false);
  assert.deepEqual(mapped.handoffs, []);
  const serialized = JSON.stringify(mapped);
  for (const secret of [
    'private-talent@example.com', 'SECRET INTERNAL INTERVIEW NOTE',
    'SECRET GRAPH EVENT', '99999999-9999-4999-8999-999999999999',
    'clientRate', 'talentRate'
  ]) assert.equal(serialized.includes(secret), false, `Client projection leaked ${secret}`);
});

test('internal projection exposes only the safe initial-create retry flag and Client projection strips it', () => {
  const internalState = rawState('sales');
  internalState.candidates[0].interviews[0].calendar = {
    status: 'sync_failed', joinUrl: null, eventId: null, needsCreateRetry: true
  };
  const internal = backend.publicPayload(internalState);
  assert.equal(internal.candidates[0].interviews[0].calendar.needsCreateRetry, true);
  assert.deepEqual(Object.keys(internal.candidates[0].interviews[0].calendar).sort(), [
    'joinUrl', 'needsCreateRetry', 'status'
  ]);

  const clientState = rawState('client_admin');
  clientState.candidates[0].interviews[0].calendar = {
    status: 'pending', joinUrl: null, eventId: null, needsCreateRetry: false
  };
  const client = backend.publicPayload(clientState);
  assert.equal(Object.hasOwn(client.candidates[0].interviews[0].calendar, 'needsCreateRetry'), false);
});

test('action bodies are exact and caller-selected organization, Client, attendees, or owner fields are rejected before authentication', async t => {
  const calls = installFetch(t, () => { throw new Error('Invalid input must not fetch.'); });
  const base = {
    action: 'schedule_interview', requestId, hiringRequestId, expectedUpdatedAt: updatedAt,
    shortlistItemId, startsAt: '2099-09-05T16:00:00.000Z', durationMinutes: 30,
    timezone: 'America/Chicago'
  };
  for (const extra of [
    { organizationId: userId }, { clientId }, { salesOwnerId: userId },
    { attendees: [{ email: 'attacker@example.com' }] }
  ]) {
    const result = await backend.handler(event('POST', { body: JSON.stringify({ ...base, ...extra }) }));
    assert.equal(result.statusCode, 400);
  }
  assert.equal(calls.length, 0);
});

test('schedule commits to Soro first, then creates one Teams meeting with the three server-derived attendees', async t => {
  const state = rawState('sales');
  const calls = installFetch(t, call => {
    if (call.url.endsWith('/auth/v1/user')) return response({ id: userId });
    if (call.url.endsWith('/rest/v1/rpc/change_client_placement_workflow')) return response({
      state,
      calendarCommand: {
        action: 'create', transactionId: requestId, interviewId, expectedUpdatedAt: updatedAt,
        eventId: null, joinUrl: null, organizerId: 'talents@thesorogroup.com',
        applicantName: 'Santos, Mariel Anne',
        startsAt: '2099-09-05T16:00:00.000Z', endsAt: '2099-09-05T16:30:00.000Z',
        attendees: [
          { name: 'Santos, Mariel Anne', email: 'mariel@example.com' },
          { name: 'Client Contact', email: 'client@example.com' },
          { name: 'Sales Owner', email: 'sales@example.com' }
        ]
      }
    });
    if (call.url.includes('/oauth2/v2.0/token')) return response({ access_token: 'graph-token' });
    if (call.url === 'https://graph.microsoft.com/v1.0/users/talents%40thesorogroup.com/events') {
      return response({ id: 'graph-event', onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/safe' } });
    }
    if (call.url.endsWith('/rest/v1/rpc/record_client_interview_calendar_sync')) return response(state);
    throw new Error(`Unexpected fetch ${call.url}`);
  });
  const result = await backend.handler(event('POST', {
    body: JSON.stringify({
      action: 'schedule_interview', requestId, hiringRequestId, expectedUpdatedAt: updatedAt,
      shortlistItemId, startsAt: '2099-09-05T16:00:00.000Z', durationMinutes: 30,
      timezone: 'America/Chicago'
    })
  }));
  assert.equal(result.statusCode, 200);
  assert.match(calls[1].url, /change_client_placement_workflow$/);
  assert.match(calls[2].url, /login\.microsoftonline\.com/);
  assert.match(calls[3].url, /graph\.microsoft\.com/);
  assert.match(calls[4].url, /record_client_interview_calendar_sync$/);
  const mutationBody = JSON.parse(calls[1].options.body);
  assert.deepEqual(Object.keys(mutationBody).sort(), [
    'p_action', 'p_actor_user_id', 'p_entity_id', 'p_expected_updated_at',
    'p_hiring_request_id', 'p_payload', 'p_request_id'
  ].sort());
  assert.equal(mutationBody.p_payload.calendarOrganizer, 'talents@thesorogroup.com');
  const graphBody = JSON.parse(calls[3].options.body);
  assert.deepEqual(graphBody.attendees.map(item => item.emailAddress.address), [
    'mariel@example.com', 'client@example.com', 'sales@example.com'
  ]);
  assert.equal(graphBody.transactionId, requestId);
  assert.doesNotMatch(calls[3].options.body, /private note|rate|resume/i);
});

test('an ambiguous create retry sends the original Graph transaction id, not the retry request id', async t => {
  const state = rawState('sales');
  const calls = installFetch(t, call => {
    if (call.url.endsWith('/auth/v1/user')) return response({ id: userId });
    if (call.url.endsWith('/rest/v1/rpc/change_client_placement_workflow')) return response({
      state,
      calendarCommand: {
        action: 'create', transactionId: originalCalendarTransactionId,
        interviewId, expectedUpdatedAt: updatedAt,
        eventId: null, joinUrl: null, organizerId: 'talents@thesorogroup.com',
        applicantName: 'Santos, Mariel Anne',
        startsAt: '2099-09-05T16:00:00.000Z', endsAt: '2099-09-05T16:30:00.000Z',
        attendees: [
          { name: 'Santos, Mariel Anne', email: 'mariel@example.com' },
          { name: 'Client Contact', email: 'client@example.com' },
          { name: 'Sales Owner', email: 'sales@example.com' }
        ]
      }
    });
    if (call.url.includes('/oauth2/v2.0/token')) return response({ access_token: 'graph-token' });
    if (call.url === 'https://graph.microsoft.com/v1.0/users/talents%40thesorogroup.com/events') {
      return response({ id: 'graph-event', onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/safe' } });
    }
    if (call.url.endsWith('/rest/v1/rpc/record_client_interview_calendar_sync')) return response(state);
    throw new Error(`Unexpected fetch ${call.url}`);
  });

  const result = await backend.handler(event('POST', {
    body: JSON.stringify({
      action: 'retry_calendar_sync', requestId: retryRequestId,
      hiringRequestId, expectedUpdatedAt: updatedAt, interviewId
    })
  }));

  assert.equal(result.statusCode, 200);
  const mutationBody = JSON.parse(calls[1].options.body);
  assert.equal(mutationBody.p_request_id, retryRequestId);
  const graphBody = JSON.parse(calls[3].options.body);
  assert.equal(graphBody.transactionId, originalCalendarTransactionId);
  assert.notEqual(graphBody.transactionId, retryRequestId);
});

test('a calendar result-recording failure returns the already-durable Soro state as pending instead of pretending rollback', async t => {
  const state = rawState('sales');
  installFetch(t, call => {
    if (call.url.endsWith('/auth/v1/user')) return response({ id: userId });
    if (call.url.endsWith('/rest/v1/rpc/change_client_placement_workflow')) return response({
      state,
      calendarCommand: {
        action: 'create', transactionId: requestId, interviewId, expectedUpdatedAt: updatedAt,
        eventId: null, joinUrl: null, organizerId: 'talents@thesorogroup.com',
        applicantName: 'Santos, Mariel Anne', startsAt: '2099-09-05T16:00:00.000Z',
        endsAt: '2099-09-05T16:30:00.000Z',
        attendees: [
          { name: 'Talent', email: 'talent@example.com' },
          { name: 'Client', email: 'client@example.com' },
          { name: 'Sales', email: 'sales@example.com' }
        ]
      }
    });
    if (call.url.includes('/oauth2/v2.0/token')) return response({ access_token: 'graph-token' });
    if (call.url.includes('graph.microsoft.com')) return response({ id: 'graph-event', onlineMeeting: { joinUrl: 'https://teams.example/join' } });
    if (call.url.endsWith('/rest/v1/rpc/record_client_interview_calendar_sync')) {
      return response({ code: 'P0001', message: 'changed after the calendar command started' }, 409);
    }
    throw new Error(`Unexpected fetch ${call.url}`);
  });
  const result = await backend.handler(event('POST', {
    body: JSON.stringify({
      action: 'schedule_interview', requestId, hiringRequestId, expectedUpdatedAt: updatedAt,
      shortlistItemId, startsAt: '2099-09-05T16:00:00.000Z', durationMinutes: 30,
      timezone: 'America/Chicago'
    })
  }));
  assert.equal(result.statusCode, 202);
  assert.equal(bodyOf(result).calendarSyncPending, true);
  assert.equal(bodyOf(result).request.hiringRequestId, hiringRequestId);
});

test('raw Microsoft transport failures are absent from placement logs', async t => {
  const originalFetch = global.fetch;
  const originalConsoleError = console.error;
  const privateDetail = 'private-client@example.test SECRET_GRAPH_DIAGNOSTIC';
  const logs = [];
  global.fetch = async () => { throw new TypeError(privateDetail); };
  console.error = (...values) => { logs.push(values); };
  t.after(() => {
    global.fetch = originalFetch;
    console.error = originalConsoleError;
  });

  const outcome = await backend.syncGraphCalendar({
    action: 'create', transactionId: requestId, interviewId,
    applicantName: 'Client-safe name', organizerId: 'talents@thesorogroup.com',
    startsAt: '2099-09-05T16:00:00.000Z', endsAt: '2099-09-05T16:30:00.000Z',
    attendees: []
  });
  assert.equal(outcome.status, 'sync_failed');
  assert.equal(JSON.stringify(logs).includes(privateDetail), false);
  assert.equal(JSON.stringify(logs).includes('private-client@example.test'), false);
});
