const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

process.env.SUPABASE_URL = 'https://talent-verification-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.MICROSOFT_TENANT_ID = 'test-tenant';
process.env.MICROSOFT_CLIENT_ID = 'test-client';
process.env.MICROSOFT_CLIENT_SECRET = 'test-secret';
process.env.MICROSOFT_SHARED_ORGANIZER_USER_ID = 'soro-interviews@example.com';

const root = path.resolve(__dirname, '..');
const backend = require(path.join(root, 'netlify', 'functions', 'talent-verification.js'));
const migration = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '20260831_029_talent_verification_and_interviews.sql'),
  'utf8'
);

const userId = '11111111-1111-4111-8111-111111111111';
const applicantId = '22222222-2222-4222-8222-222222222222';
const interviewerId = '33333333-3333-4333-8333-333333333333';
const interviewId = '44444444-4444-4444-8444-444444444444';
const referenceId = '55555555-5555-4555-8555-555555555555';
const requestId = '66666666-6666-4666-8666-666666666666';
const updatedAt = '2026-08-31T18:00:00.000Z';

function response(data, status = 200) {
  return new Response(data === undefined ? '' : JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function event(overrides = {}) {
  return {
    httpMethod: 'GET',
    headers: { authorization: 'Bearer verification-token' },
    queryStringParameters: { applicantId },
    multiValueQueryStringParameters: {},
    rawQueryString: `applicantId=${applicantId}`,
    body: '',
    ...overrides
  };
}

function state(overrides = {}) {
  return {
    generatedAt: '2026-08-31T18:05:00.000Z',
    viewerRole: 'admin',
    applicant: {
      applicantId,
      fullName: 'Santos, Mariel Anne',
      email: 'mariel@example.com',
      stage: 'in_review',
      updatedAt
    },
    gate: {
      interviewAddressed: false,
      referencesAddressed: false,
      benchReadyEligible: false,
      blockers: ['Interview must be addressed', 'Employment references must be addressed']
    },
    interview: null,
    interviewers: [{ id: interviewerId, name: 'Jordan Reed', email: 'private-interviewer@example.com' }],
    references: [],
    organizationId: '77777777-7777-4777-8777-777777777777',
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

test('GET accepts only applicantId and derives organization and role from the authenticated actor', async t => {
  const calls = installFetch(t, call => {
    if (call.url.endsWith('/auth/v1/user')) return response({ id: userId });
    if (call.url.endsWith('/rest/v1/rpc/get_talent_verification')) return response(state());
    throw new Error(`Unexpected fetch ${call.url}`);
  });
  const result = await backend.handler(event());
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    p_actor_user_id: userId,
    p_applicant_id: applicantId
  });
  assert.equal(result.headers['Cache-Control'], 'no-store');

  const duplicatedByNetlify = await backend.handler(event({
    multiValueQueryStringParameters: { applicantId: [applicantId] }
  }));
  assert.equal(duplicatedByNetlify.statusCode, 200);

  const multiOnly = await backend.handler(event({
    queryStringParameters: {},
    multiValueQueryStringParameters: { applicantId: [applicantId] }
  }));
  assert.equal(multiOnly.statusCode, 200);

  for (const invalid of [
    event({ queryStringParameters: { applicantId, organizationId: userId } }),
    event({ queryStringParameters: { applicantId, role: 'admin' } }),
    event({ multiValueQueryStringParameters: { applicantId: [applicantId, applicantId] } }),
    event({ multiValueQueryStringParameters: { applicantId: [userId] } }),
    event({ multiValueQueryStringParameters: { applicantId: [applicantId], role: ['admin'] } }),
    event({ rawQueryString: `applicantId=${applicantId}&applicantId=${applicantId}` }),
    event({ rawQueryString: `applicantId=${applicantId}&role=admin` }),
    event({ queryStringParameters: { applicantId: 'not-a-uuid' } }),
    event({ body: '{}' })
  ]) {
    const rejected = await backend.handler(invalid);
    assert.equal(rejected.statusCode, 400);
  }
});

test('public response is allowlisted, exposes eligible interviewer names but no private emails or Microsoft ids', async t => {
  installFetch(t, call => {
    if (call.url.endsWith('/auth/v1/user')) return response({ id: userId });
    return response(state({
      interview: {
        interviewId,
        status: 'scheduled',
        startsAt: '2026-09-05T16:00:00.000Z',
        endsAt: '2026-09-05T16:30:00.000Z',
        timezone: 'America/Chicago',
        interviewer: { id: interviewerId, name: 'Jordan Reed', email: 'private-interviewer@example.com' },
        outcome: null,
        scorecard: null,
        notes: null,
        calendar: { status: 'synced', joinUrl: 'https://teams.microsoft.com/l/meetup-join/safe', eventId: 'private-graph-id' },
        updatedAt
      }
    }));
  });
  const result = await backend.handler(event());
  const payload = bodyOf(result);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(Object.keys(payload).sort(), [
    'applicant', 'availableAttendees', 'calendarIntegration', 'gate', 'generatedAt', 'interview', 'interviewers', 'references', 'viewerRole'
  ].sort());
  assert.deepEqual(payload.interviewers, [{ id: interviewerId, name: 'Jordan Reed' }]);
  assert.deepEqual(payload.calendarIntegration, { configured: true, organizerLabel: 'Soro Talent Interviews' });
  assert.equal(result.body.includes('private-interviewer@example.com'), false);
  assert.equal(result.body.includes('private-graph-id'), false);
  assert.equal(result.body.includes('77777777-7777-4777-8777-777777777777'), false);
});

test('additional attendees accept only bounded employee IDs and preserve omission versus removal', () => {
  const base = { startsAt: '2099-09-05T16:00:00.000Z', durationMinutes: 30, timezone: 'Asia/Manila', interviewerUserId: interviewerId, interviewId };
  for (const action of ['schedule_interview', 'reschedule_interview']) {
    assert.equal(Object.hasOwn(backend.actionPayload(base, action), 'additionalAttendeeUserIds'), false);
    assert.deepEqual(backend.actionPayload({ ...base, additionalAttendeeUserIds: [] }, action).additionalAttendeeUserIds, []);
    assert.deepEqual(backend.actionPayload({ ...base, additionalAttendeeUserIds: [userId, interviewerId, userId] }, action).additionalAttendeeUserIds, [userId]);
    for (const invalid of [null, 'anyone@example.com', [null], ['external@example.com'], Array(51).fill(userId)]) {
      assert.throws(() => backend.actionPayload({ ...base, additionalAttendeeUserIds: invalid }, action));
    }
  }
});

test('Graph sends company guests as optional and deduplicates required recipients by email', () => {
  const base = { applicantName: 'Alex', applicantEmail: 'alex@example.com', interviewerName: 'Jordan', interviewerEmail: 'jordan@example.com', startsAt: '2099-09-05T16:00:00Z', endsAt: '2099-09-05T16:30:00Z', transactionId: requestId };
  const additionalAttendees = [{ name: 'Sales teammate', email: 'sales@example.com' }, { name: 'Primary duplicate', email: 'JORDAN@example.com' }, { name: 'Applicant duplicate', email: 'Alex@example.com' }, { name: 'Guest duplicate', email: 'Sales@example.com' }];
  for (const action of ['create', 'update']) {
    const body = backend.graphEventBody({ ...base, action, additionalAttendees });
    assert.equal(body.attendees.length, 3);
    assert.deepEqual(body.attendees.map(person => person.type), ['required', 'required', 'optional']);
    assert.equal(body.attendees[2].emailAddress.address, 'sales@example.com');
    assert.equal(backend.graphEventBody({ ...base, action, additionalAttendees: [] }).attendees.length, 2);
  }
});

test('safe attendee projection strips staff emails and unrelated employee fields', () => {
  const person = { id: userId, name: 'Company teammate', role: 'sales', email: 'private@example.com', phone: 'private-phone' };
  const safe = backend.publicPayload(state({ availableAttendees: [person], interview: {
    interviewId, status: 'scheduled', startsAt: '2099-09-05T16:00:00Z', endsAt: '2099-09-05T16:30:00Z',
    timezone: 'Asia/Manila', interviewer: {id: interviewerId, name: 'Jordan'}, additionalAttendees: [person],
    outcome: null, notes: null, scorecard: null, calendar: { status: 'synced', joinUrl: null }, updatedAt
  }}));
  assert.deepEqual(safe.availableAttendees, [{ id: userId, name: person.name, role: 'sales' }]);
  assert.deepEqual(safe.interview.additionalAttendees, [{ id: userId, name: person.name }]);
  assert.doesNotMatch(JSON.stringify(safe), /private@example|private-phone/);
});

test('new attendee contract forwards only IDs through the authorized mutation RPC', async t => {
  const calls = installFetch(t, call => {
    if (call.url.endsWith('/auth/v1/user')) return response({ id: userId });
    if (call.url.endsWith('/rest/v1/rpc/mutate_talent_verification')) return response({ state: state(), calendarCommand: null });
    throw new Error('Unexpected request');
  });
  const body = { action: 'schedule_interview', requestId, applicantId, expectedUpdatedAt: null, startsAt: '2099-09-05T16:00:00Z', durationMinutes: 30, timezone: 'Asia/Manila', interviewerUserId: interviewerId, additionalAttendeeUserIds: [userId] };
  const post = data => backend.handler(event({ httpMethod: 'POST', queryStringParameters: {}, rawQueryString: '', body: JSON.stringify(data) }));
  assert.equal((await post(body)).statusCode, 200);
  assert.deepEqual(JSON.parse(calls[1].options.body).p_payload.additionalAttendeeUserIds, [userId]);
  assert.equal((await post({ ...body, additionalAttendeeEmails: ['outside@example.com'] })).statusCode, 400);
});

test('calendar synchronization uses saved attendee snapshots, not incoming selections or current directory emails', async t => {
  const guest = {id: referenceId, name: 'Saved guest', email: 'original-guest@example.com'};
  const pending = state({interview: {
    interviewId, status: 'scheduled', startsAt: '2099-09-05T16:00:00Z', endsAt: '2099-09-05T16:30:00Z',
    timezone: 'Asia/Manila', interviewer: {id: interviewerId, name: 'Jordan'}, additionalAttendees: [guest],
    outcome: null, scorecard: null, notes: null, calendar: {status: 'pending', joinUrl: null}, updatedAt
  }});
  const calls = installFetch(t, call => {
    if (call.url.endsWith('/auth/v1/user')) return response({id:userId});
    if (call.url.endsWith('/rest/v1/rpc/mutate_talent_verification')) return response({state:pending, calendarCommand: {
      action:'create', transactionId:requestId, interviewId, expectedUpdatedAt:updatedAt,
      applicantName:'Alex', applicantEmail:'alex@example.com', interviewerName:'Jordan', interviewerEmail:'jordan@example.com',
      additionalAttendees:[guest], startsAt:pending.interview.startsAt, endsAt:pending.interview.endsAt, eventId:null, joinUrl:null
    }});
    if (call.url.includes('/oauth2/v2.0/token')) return response({access_token:'test-token'});
    if (call.url.includes('graph.microsoft.com')) return response({id:'test-event', onlineMeeting:{joinUrl:'https://teams.microsoft.com/sample'}});
    if (call.url.endsWith('/rest/v1/rpc/record_talent_interview_calendar_sync')) return response({...pending,interview:{...pending.interview,calendar:{status:'synced',joinUrl:null}}});
    throw new Error('Unexpected call');
  });
  const result = await backend.handler(event({httpMethod:'POST',queryStringParameters:{},rawQueryString:'',body:JSON.stringify({
    action:'schedule_interview',requestId,applicantId,expectedUpdatedAt:null,startsAt:pending.interview.startsAt,
    durationMinutes:30,timezone:'Asia/Manila',interviewerUserId:interviewerId,additionalAttendeeUserIds:[userId]
  })}));
  assert.equal(result.statusCode,200);
  const graph = JSON.parse(calls.find(call=>call.url.includes('graph.microsoft.com')).options.body);
  assert.deepEqual(graph.attendees[2],{emailAddress:{address:guest.email,name:guest.name},type:'optional'});
  assert.doesNotMatch(result.body,/original-guest@example.com/);
  assert.deepEqual(bodyOf(result).interview.additionalAttendees,[{id:referenceId,name:guest.name}]);
});

test('POST action bodies are exact and pending is rejected as a final reference outcome before authentication', async t => {
  const calls = installFetch(t, () => { throw new Error('Invalid requests must not fetch.'); });
  const base = {
    action: 'set_reference_outcome', requestId, applicantId, expectedUpdatedAt: updatedAt,
    referenceId, outcome: 'verified', note: ''
  };
  for (const invalid of [
    { ...base, organizationId: userId },
    { ...base, viewerRole: 'admin' },
    { ...base, unexpected: true },
    { ...base, outcome: 'pending' },
    { ...base, outcome: 'discrepancy', note: '' }
  ]) {
    const result = await backend.handler(event({
      httpMethod: 'POST', queryStringParameters: {}, rawQueryString: '', body: JSON.stringify(invalid)
    }));
    assert.equal(result.statusCode, 400);
  }
  assert.equal(calls.length, 0);
});

test('interview schedules require a future start and bounded five-minute duration', () => {
  const base = {
    interviewId: null,
    startsAt: '2000-01-01T00:00:00.000Z',
    durationMinutes: 30,
    timezone: 'America/Chicago',
    interviewerUserId: interviewerId
  };
  assert.throws(() => backend.actionPayload(base, 'schedule_interview'), /future/i);
  assert.throws(() => backend.actionPayload({ ...base, startsAt: '2099-01-01T00:00:00.000Z', durationMinutes: 17 }, 'schedule_interview'), /five-minute/i);
  assert.doesNotThrow(() => backend.actionPayload({ ...base, startsAt: '2099-01-01T00:00:00.000Z' }, 'schedule_interview'));
});

test('schedule mutation saves to Soro first, creates a Teams meeting, then records the sync result', async t => {
  const pending = state({
    interview: {
      interviewId, status: 'scheduled', startsAt: '2099-09-05T16:00:00.000Z', endsAt: '2099-09-05T16:30:00.000Z',
      timezone: 'America/Chicago', interviewer: { id: interviewerId, name: 'Jordan Reed' }, outcome: null,
      scorecard: null, notes: null, calendar: { status: 'pending', joinUrl: null }, updatedAt
    }
  });
  const synced = structuredClone(pending);
  synced.interview.calendar = { status: 'synced', joinUrl: 'https://teams.microsoft.com/l/meetup-join/safe' };
  const calls = installFetch(t, call => {
    if (call.url.endsWith('/auth/v1/user')) return response({ id: userId });
    if (call.url.endsWith('/rest/v1/rpc/mutate_talent_verification')) return response({
      state: pending,
      calendarCommand: {
        action: 'create', interviewId, expectedUpdatedAt: updatedAt,
        transactionId: requestId,
        applicantName: 'Santos, Mariel Anne', applicantEmail: 'mariel@example.com',
        interviewerName: 'Jordan Reed', interviewerEmail: 'jordan@example.com',
        startsAt: '2099-09-05T16:00:00.000Z', endsAt: '2099-09-05T16:30:00.000Z',
        eventId: null, joinUrl: null
      }
    });
    if (call.url.includes('/oauth2/v2.0/token')) return response({ access_token: 'graph-token' });
    if (call.url === 'https://graph.microsoft.com/v1.0/users/soro-interviews%40example.com/events') {
      return response({ id: 'graph-event-id', onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/safe' } });
    }
    if (call.url.endsWith('/rest/v1/rpc/record_talent_interview_calendar_sync')) return response(synced);
    throw new Error(`Unexpected fetch ${call.url}`);
  });
  const body = {
    action: 'schedule_interview', requestId, applicantId, expectedUpdatedAt: null,
    startsAt: '2099-09-05T16:00:00.000Z', durationMinutes: 30,
    timezone: 'America/Chicago', interviewerUserId: interviewerId
  };
  const result = await backend.handler(event({
    httpMethod: 'POST', queryStringParameters: {}, rawQueryString: '', body: JSON.stringify(body)
  }));
  assert.equal(result.statusCode, 200);
  assert.match(calls[1].url, /mutate_talent_verification$/);
  assert.match(calls[2].url, /login\.microsoftonline\.com/);
  assert.match(calls[3].url, /graph\.microsoft\.com/);
  assert.match(calls[4].url, /record_talent_interview_calendar_sync$/);
  assert.equal(JSON.parse(calls[1].options.body).p_payload.calendarOrganizer, 'soro-interviews@example.com');
  const graphBody = JSON.parse(calls[3].options.body);
  assert.equal(graphBody.attendees.length, 2);
  assert.deepEqual(graphBody.attendees.map(item => item.emailAddress.address), ['mariel@example.com', 'jordan@example.com']);
  assert.equal(graphBody.isOnlineMeeting, true);
  assert.equal(graphBody.transactionId, requestId);
  assert.equal(calls[3].options.headers.Prefer, 'IdType="ImmutableId"');
  assert.doesNotMatch(calls[3].options.body, /reference|private note|resume/i);
});

test('Graph create and update payloads preserve online meeting safety boundaries', () => {
  const base = {
    requestId, transactionId: requestId, applicantName: 'Santos, Mariel Anne', applicantEmail: 'mariel@example.com',
    interviewerName: 'Jordan Reed', interviewerEmail: 'jordan@example.com',
    startsAt: '2099-09-05T16:00:00.000Z', endsAt: '2099-09-05T16:30:00.000Z'
  };
  const create = backend.graphEventBody({ ...base, action: 'create' });
  const update = backend.graphEventBody({ ...base, action: 'update' });
  assert.equal(create.isOnlineMeeting, true);
  assert.equal(create.onlineMeetingProvider, 'teamsForBusiness');
  assert.equal(create.transactionId, requestId);
  assert.equal(typeof create.body.content, 'string');
  for (const forbidden of ['body', 'isOnlineMeeting', 'onlineMeetingProvider', 'transactionId']) {
    assert.equal(Object.hasOwn(update, forbidden), false, `${forbidden} must be omitted from PATCH.`);
  }
});

test('retry_calendar_sync accepts an interrupted pending create and reuses its original transaction id', async t => {
  const pending = state({
    interview: {
      interviewId, status: 'scheduled', startsAt: '2099-09-05T16:00:00.000Z', endsAt: '2099-09-05T16:30:00.000Z',
      timezone: 'America/Chicago', interviewer: { id: interviewerId, name: 'Jordan Reed' }, outcome: null,
      scorecard: null, notes: null, calendar: { status: 'pending', joinUrl: null }, updatedAt
    }
  });
  const originalTransactionId = '88888888-8888-4888-8888-888888888888';
  const calls = installFetch(t, call => {
    if (call.url.endsWith('/auth/v1/user')) return response({ id: userId });
    if (call.url.endsWith('/rest/v1/rpc/mutate_talent_verification')) return response({
      state: pending,
      calendarCommand: {
        action: 'create', transactionId: originalTransactionId, interviewId, expectedUpdatedAt: updatedAt,
        applicantName: 'Santos, Mariel Anne', applicantEmail: 'mariel@example.com',
        interviewerName: 'Jordan Reed', interviewerEmail: 'jordan@example.com',
        startsAt: '2099-09-05T16:00:00.000Z', endsAt: '2099-09-05T16:30:00.000Z',
        eventId: null, joinUrl: null
      }
    });
    if (call.url.includes('/oauth2/v2.0/token')) return response({ access_token: 'graph-token' });
    if (call.url.includes('graph.microsoft.com')) {
      return response({ id: 'graph-event-id', onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/safe' } });
    }
    if (call.url.endsWith('/rest/v1/rpc/record_talent_interview_calendar_sync')) {
      const result = structuredClone(pending);
      result.interview.calendar = { status: 'synced', joinUrl: null };
      return response(result);
    }
    throw new Error(`Unexpected fetch ${call.url}`);
  });
  const result = await backend.handler(event({
    httpMethod: 'POST', queryStringParameters: {}, rawQueryString: '',
    body: JSON.stringify({ action: 'retry_calendar_sync', requestId, applicantId, expectedUpdatedAt: updatedAt, interviewId })
  }));
  assert.equal(result.statusCode, 200);
  const graphCall = calls.find(call => call.url.includes('graph.microsoft.com'));
  assert.equal(JSON.parse(graphCall.options.body).transactionId, originalTransactionId);
});

test('calendar create keeps the Graph event recoverable when Microsoft omits the Teams join link', async t => {
  const pending = state({
    interview: {
      interviewId, status: 'scheduled', startsAt: '2099-09-05T16:00:00.000Z', endsAt: '2099-09-05T16:30:00.000Z',
      timezone: 'America/Chicago', interviewer: { id: interviewerId, name: 'Jordan Reed' }, outcome: null,
      scorecard: null, notes: null, calendar: { status: 'pending', joinUrl: null }, updatedAt
    }
  });
  const calls = installFetch(t, call => {
    if (call.url.endsWith('/auth/v1/user')) return response({ id: userId });
    if (call.url.endsWith('/rest/v1/rpc/mutate_talent_verification')) return response({
      state: pending,
      calendarCommand: {
        action: 'create', transactionId: requestId, interviewId, expectedUpdatedAt: updatedAt,
        applicantName: 'Santos, Mariel Anne', applicantEmail: 'mariel@example.com',
        interviewerName: 'Jordan Reed', interviewerEmail: 'jordan@example.com',
        startsAt: '2099-09-05T16:00:00.000Z', endsAt: '2099-09-05T16:30:00.000Z',
        eventId: null, joinUrl: null
      }
    });
    if (call.url.includes('/oauth2/v2.0/token')) return response({ access_token: 'graph-token' });
    if (call.url.includes('graph.microsoft.com')) return response({ id: 'graph-event-without-teams-link' });
    if (call.url.endsWith('/rest/v1/rpc/record_talent_interview_calendar_sync')) {
      const body = JSON.parse(call.options.body);
      assert.equal(body.p_sync_status, 'sync_failed');
      assert.equal(body.p_microsoft_event_id, 'graph-event-without-teams-link');
      assert.equal(body.p_microsoft_join_url, null);
      assert.equal(body.p_error_code, 'graph_teams_link_missing');
      const result = structuredClone(pending);
      result.interview.calendar = { status: 'sync_failed', joinUrl: null };
      return response(result);
    }
    throw new Error(`Unexpected fetch ${call.url}`);
  });
  const result = await backend.handler(event({
    httpMethod: 'POST', queryStringParameters: {}, rawQueryString: '',
    body: JSON.stringify({
      action: 'schedule_interview', requestId, applicantId, expectedUpdatedAt: null,
      startsAt: '2099-09-05T16:00:00.000Z', durationMinutes: 30,
      timezone: 'America/Chicago', interviewerUserId: interviewerId
    })
  }));
  assert.equal(result.statusCode, 200);
  assert.equal(bodyOf(result).interview.calendar.status, 'sync_failed');
  assert.ok(calls.some(call => call.url.includes('graph.microsoft.com')));
});

test('retry_calendar_sync treats an already-missing Graph event as a completed cancellation', async t => {
  const failed = state({
    interview: {
      interviewId, status: 'cancelled', startsAt: '2099-09-05T16:00:00.000Z', endsAt: '2099-09-05T16:30:00.000Z',
      timezone: 'America/Chicago', interviewer: { id: interviewerId, name: 'Jordan Reed' }, outcome: null,
      scorecard: null, notes: 'Applicant requested another date.', calendar: { status: 'sync_failed', joinUrl: null }, updatedAt
    }
  });
  const calls = installFetch(t, call => {
    if (call.url.endsWith('/auth/v1/user')) return response({ id: userId });
    if (call.url.endsWith('/rest/v1/rpc/mutate_talent_verification')) return response({
      state: failed,
      calendarCommand: {
        action: 'cancel', transactionId: requestId, interviewId, expectedUpdatedAt: updatedAt,
        eventId: 'graph-event-id', joinUrl: 'https://teams.microsoft.com/l/meetup-join/safe'
      }
    });
    if (call.url.includes('/oauth2/v2.0/token')) return response({ access_token: 'graph-token' });
    if (call.url.endsWith('/events/graph-event-id/cancel')) return response({ error: { code: 'ErrorItemNotFound' } }, 404);
    if (call.url.endsWith('/rest/v1/rpc/record_talent_interview_calendar_sync')) {
      const result = structuredClone(failed);
      result.interview.calendar = { status: 'not_applicable', joinUrl: null };
      result.interview.updatedAt = '2026-08-31T18:01:00.000Z';
      return response(result);
    }
    throw new Error(`Unexpected fetch ${call.url}`);
  });
  const result = await backend.handler(event({
    httpMethod: 'POST', queryStringParameters: {}, rawQueryString: '',
    body: JSON.stringify({ action: 'retry_calendar_sync', requestId, applicantId, expectedUpdatedAt: updatedAt, interviewId })
  }));
  assert.equal(result.statusCode, 200);
  const cancelCall = calls.find(call => call.url.endsWith('/events/graph-event-id/cancel'));
  assert.ok(cancelCall);
  assert.deepEqual(JSON.parse(cancelCall.options.body), { comment: 'This Soro Talent interview has been cancelled.' });
  assert.equal(cancelCall.options.body.includes('Applicant requested another date.'), false);
  assert.equal(bodyOf(result).interview.calendar.status, 'not_applicable');
});

test('migration is service-only, same-organization, idempotent, audited, and enforces Bench Ready gate', () => {
  for (const table of ['talent_interviews', 'talent_reference_checks', 'talent_reference_attempts', 'talent_verification_operations']) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
    assert.match(migration, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`, 'i'));
  }
  assert.match(migration, /private\.talent_review_actor\(p_actor_user_id\)/i);
  assert.match(migration, /applicant\.organization_id\s*=\s*v_actor\.organization_id/i);
  assert.match(migration, /operation_request_id uuid not null[\s\S]*primary key \(operation_request_id, phase\)/i);
  assert.match(migration, /pg_advisory_xact_lock/i);
  assert.match(migration, /changed after it was opened/i);
  assert.match(migration, /insert into public\.audit_events/i);
  assert.match(migration, /Unable to reach requires at least two contact attempts and a note/i);
  assert.match(migration, /v_reference_count\s*>=\s*20/i);
  assert.match(migration, /v_reference_count\s*>=\s*50/i);
  assert.match(migration, /v_interview\.status in \('cancelled', 'no_show', 'waived'\)[\s\S]*v_interview\.calendar_sync_action = 'cancel'[\s\S]*calendar_sync_action = case[\s\S]*when calendar_sync_action = 'cancel' then 'cancel'/i);
  assert.match(migration, /v_action in \('schedule_interview', 'reschedule_interview', 'cancel_interview', 'record_interview_outcome', 'retry_calendar_sync'\)[\s\S]*v_interview\.calendar_sync_status = 'pending'/i);
  assert.match(migration, /v_interview\.status not in \('scheduled', 'cancelled'\)[\s\S]*set\s+status = 'scheduled'[\s\S]*private_notes = null[\s\S]*calendar_transaction_id = case when v_interview\.status = 'cancelled' then p_request_id/i);
  assert.match(migration, /calendar_sync_started_at > v_now - interval '90 seconds'/i);
  assert.match(migration, /Retry the calendar synchronization before changing this interview/i);
  assert.match(migration, /microsoft_organizer_snapshot/i);
  assert.match(migration, /Interview and employment references must be addressed before Bench Ready/i);
  assert.match(migration, /Return this Talent to review before adding another employment reference/i);
  assert.match(migration, /Return this Talent to review before changing a verified employment reference/i);
  assert.match(migration, /Return this Talent to review before removing an employment reference/i);
  assert.match(migration, /before insert or update on public\.applicants/i);
  assert.match(migration, /organization_id\s*=\s*private\.current_soro_organization_id\(\)/i);
  assert.match(migration, /delete from public\.talent_reference_attempts where reference_check_id = v_reference\.id/i);
  assert.match(migration, /private\.talent_reference_attempts_audit_json\(v_actor\.organization_id, v_reference\.id\)/i);
  assert.match(migration, /left join public\.platform_users as access[\s\S]*left join public\.employee_profiles as profile/i);
  assert.match(migration, /grant execute on function public\.get_talent_verification\(uuid, uuid\) to service_role/i);
  assert.match(migration, /grant execute on function public\.mutate_talent_verification\(uuid, uuid, uuid, text, timestamptz, jsonb\)[\s\S]*to service_role/i);
});

test('migration never sends Microsoft data and returns only safe interviewer identity from state JSON', () => {
  const stateStart = migration.indexOf('create or replace function private.talent_verification_state_json');
  const mutationStart = migration.indexOf('create or replace function public.mutate_talent_verification');
  const stateSql = migration.slice(stateStart, mutationStart);
  assert.match(stateSql, /'interviewers', v_interviewers/i);
  const interviewerListStart = stateSql.indexOf("'id', access.id");
  const interviewerListEnd = stateSql.indexOf('from public.platform_users as access', interviewerListStart);
  const interviewerListJson = stateSql.slice(interviewerListStart, interviewerListEnd);
  assert.match(interviewerListJson, /'name'/i);
  assert.doesNotMatch(interviewerListJson, /'email'/i);
  assert.match(migration, /'interviewerEmail', coalesce\(interview\.interviewer_email_snapshot, profile\.email\)/i);
  assert.doesNotMatch(migration, /graph\.microsoft\.com|login\.microsoftonline\.com/i);
});
