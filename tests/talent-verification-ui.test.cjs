const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const modulePath = path.join(root, 'operations', 'talent-review-queue.js');
const source = () => fs.readFileSync(modulePath, 'utf8');
const cssSource = () => fs.readFileSync(path.join(root, 'operations', 'talent-review-queue.css'), 'utf8');

const applicantId = '22222222-2222-4222-8222-222222222222';
const interviewId = '33333333-3333-4333-8333-333333333333';
const interviewerId = '44444444-4444-4444-8444-444444444444';
const referenceId = '55555555-5555-4555-8555-555555555555';
const attemptId = '66666666-6666-4666-8666-666666666666';
const requestId = '77777777-7777-4777-8777-777777777777';
const expectedUpdatedAt = '2026-08-31T16:00:00.000Z';

function install(t, role = 'admin') {
  const keys = ['soroCurrentAccess', 'crypto', 'addEventListener', 'soroTalentReviewQueue'];
  const previous = new Map(keys.map(key => [key, Object.prototype.hasOwnProperty.call(globalThis, key)
    ? { exists: true, descriptor: Object.getOwnPropertyDescriptor(globalThis, key) }
    : { exists: false }]));
  globalThis.soroCurrentAccess = { role, user_id: interviewerId };
  Object.defineProperty(globalThis, 'crypto', { configurable: true, writable: true, value: { randomUUID: () => requestId } });
  globalThis.addEventListener = () => {};
  delete require.cache[require.resolve(modulePath)];
  const ui = require(modulePath);
  t.after(() => {
    ui.unmount({ clear: false });
    delete require.cache[require.resolve(modulePath)];
    for (const [key, state] of previous) {
      if (state.exists) Object.defineProperty(globalThis, key, state.descriptor);
      else delete globalThis[key];
    }
  });
  return ui;
}

function payload(overrides = {}) {
  return {
    generatedAt: '2026-08-31T16:05:00.000Z',
    viewerRole: 'admin',
    applicant: {
      applicantId,
      fullName: 'Santos, Mariel Anne',
      email: 'mariel@example.com',
      stage: 'in_review',
      updatedAt: expectedUpdatedAt
    },
    gate: {
      interviewAddressed: false,
      referencesAddressed: false,
      benchReadyEligible: false,
      blockers: ['Complete the internal interview.', 'Resolve each employment reference.']
    },
    interview: {
      interviewId,
      status: 'scheduled',
      startsAt: '2026-09-01T15:00:00.000Z',
      endsAt: '2026-09-01T15:30:00.000Z',
      timezone: 'America/Chicago',
      interviewer: { id: interviewerId, name: 'Jordan Reed' },
      outcome: null,
      scorecard: null,
      notes: '',
      calendar: { status: 'synced', joinUrl: 'https://teams.microsoft.com/l/meetup-join/example' },
      updatedAt: expectedUpdatedAt
    },
    references: [{
      referenceId,
      name: 'Pat Reyes',
      company: 'Example Health',
      relationship: 'Supervisor',
      phone: '+1 555 0100',
      email: 'pat@example.com',
      outcome: 'pending',
      outcomeNote: '',
      attempts: [{ attemptId, method: 'phone', result: 'voicemail', attemptedAt: '2026-08-31T15:00:00.000Z', note: 'Left a callback request.' }],
      updatedAt: expectedUpdatedAt
    }],
    interviewers: [{ id: interviewerId, name: 'Jordan Reed' }],
    calendarIntegration: { configured: true, organizerLabel: 'Soro Talent Interviews' },
    ...overrides
  };
}

test('verification normalization accepts the exact safe GET contract and strips unknown private or Graph fields', t => {
  const ui = install(t);
  const raw = payload({
    graphAccessToken: 'private-token',
    applicant: { ...payload().applicant, address: 'Private applicant address' },
    interview: {
      ...payload().interview,
      calendar: { ...payload().interview.calendar, graphEventId: 'private-event-id', attendeeEmails: ['private@example.com'] },
      internalGraphError: 'private diagnostics'
    },
    references: [{ ...payload().references[0], privateDocumentPath: 'private/reference.pdf' }],
    interviewers: [{ id: interviewerId, name: 'Jordan Reed', email: 'jordan-private@example.com' }]
  });
  const normalized = ui.normalizeVerificationPayload(raw, applicantId, 'admin');

  assert.equal(normalized.gate.benchReadyEligible, false);
  assert.equal(normalized.interview.calendar.status, 'synced');
  assert.equal(normalized.interview.endsAt, '2026-09-01T15:30:00.000Z');
  assert.equal(normalized.interview.calendar.joinUrl.startsWith('https://teams.microsoft.com/'), true);
  assert.deepEqual(normalized.interviewers, [{ id: interviewerId, name: 'Jordan Reed' }]);
  assert.deepEqual(normalized.calendarIntegration, { configured: true, organizerLabel: 'Soro Talent Interviews' });
  assert.doesNotMatch(JSON.stringify(normalized), /private-token|Private applicant address|private-event-id|attendeeEmails|private diagnostics|reference\.pdf|jordan-private/i);

  const unassigned = ui.normalizeVerificationPayload(payload({
    interview: { ...payload().interview, interviewer: { id: null, name: 'Unassigned' } }
  }), applicantId, 'admin');
  assert.deepEqual(unassigned.interview.interviewer, { id: '', name: 'Unassigned' });
});

test('verification normalization rejects role confusion, applicant confusion, unsafe links, and invalid gate records', t => {
  const ui = install(t);
  assert.throws(() => ui.normalizeVerificationPayload(payload(), applicantId, 'talent_management'), /access/i);
  assert.throws(() => ui.normalizeVerificationPayload(payload(), '88888888-8888-4888-8888-888888888888', 'admin'), /did not match/i);
  assert.throws(() => ui.normalizeVerificationPayload(payload({ interview: { ...payload().interview, calendar: { status: 'synced', joinUrl: 'javascript:alert(1)' } } }), applicantId, 'admin'), /access|invalid/i);
  assert.throws(() => ui.normalizeVerificationPayload(payload({ gate: { ...payload().gate, benchReadyEligible: 'yes' } }), applicantId, 'admin'), /access/i);
  assert.throws(() => ui.normalizeVerificationPayload(payload({ references: Array.from({ length: 21 }, (_, index) => ({
    ...payload().references[0], referenceId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
  })) }), applicantId, 'admin'), /reference list/i);
});

test('schedule and reschedule bodies use only the exact endpoint contract', t => {
  const ui = install(t);
  assert.deepEqual(ui.buildVerificationAction('schedule_interview', {
    applicantId,
    startsAt: '2026-09-01T15:00:00.000Z',
    durationMinutes: '45',
    timezone: 'America/Chicago',
    interviewerUserId: interviewerId,
    privateNote: 'must never be sent'
  }), {
    action: 'schedule_interview', requestId, applicantId, expectedUpdatedAt: null,
    startsAt: '2026-09-01T15:00:00.000Z', durationMinutes: 45,
    timezone: 'America/Chicago', interviewerUserId: interviewerId
  });
  assert.deepEqual(ui.buildVerificationAction('reschedule_interview', {
    applicantId, expectedUpdatedAt, interviewId,
    startsAt: '2026-09-02T15:00:00.000Z', durationMinutes: 30,
    timezone: 'America/Chicago', interviewerUserId: interviewerId
  }), {
    action: 'reschedule_interview', requestId, applicantId, expectedUpdatedAt, interviewId,
    startsAt: '2026-09-02T15:00:00.000Z', durationMinutes: 30,
    timezone: 'America/Chicago', interviewerUserId: interviewerId
  });
});

test('local appointment times are converted using the selected IANA time zone', t => {
  const ui = install(t);
  assert.equal(ui.zonedLocalToIso('2026-09-01T10:00', 'America/Chicago'), '2026-09-01T15:00:00.000Z');
  assert.equal(ui.zonedLocalToIso('2026-12-01T10:00', 'America/Chicago'), '2026-12-01T16:00:00.000Z');
  assert.equal(ui.zonedLocalToIso('2026-09-01T10:00', 'Not/A_Timezone'), '');
});

test('interview result always requires an internal summary and sends nullable score keys', t => {
  const ui = install(t);
  assert.throws(() => ui.buildVerificationAction('record_interview_outcome', {
    applicantId, expectedUpdatedAt, interviewId, status: 'completed', outcome: 'recommended', note: ''
  }), /summary/i);
  assert.deepEqual(ui.buildVerificationAction('record_interview_outcome', {
    applicantId, expectedUpdatedAt, interviewId, status: 'completed', outcome: 'recommended',
    communicationScore: '5', preparednessScore: '', roleFitScore: '4', overallScore: '5', note: 'Strong interview.'
  }), {
    action: 'record_interview_outcome', requestId, applicantId, expectedUpdatedAt, interviewId,
    status: 'completed', outcome: 'recommended', communicationScore: 5,
    preparednessScore: null, roleFitScore: 4, overallScore: 5, note: 'Strong interview.'
  });
});

test('reference action bodies are exact and final exception outcomes require notes', t => {
  const ui = install(t);
  assert.deepEqual(ui.buildVerificationAction('record_reference_attempt', {
    applicantId, expectedUpdatedAt, referenceId, method: 'phone', result: 'voicemail',
    attemptedAt: '2026-08-31T15:00:00.000Z', note: 'Left a message.', extra: 'ignored'
  }), {
    action: 'record_reference_attempt', requestId, applicantId, expectedUpdatedAt,
    referenceId, method: 'phone', result: 'voicemail', attemptedAt: '2026-08-31T15:00:00.000Z', note: 'Left a message.'
  });
  for (const outcome of ['discrepancy', 'unable_to_reach', 'not_provided']) {
    assert.throws(() => ui.buildVerificationAction('set_reference_outcome', {
      applicantId, expectedUpdatedAt, referenceId, outcome, note: ''
    }), /note/i);
  }
  assert.throws(() => ui.buildVerificationAction('set_reference_outcome', {
    applicantId, expectedUpdatedAt, referenceId, outcome: 'pending', note: 'No'
  }), /final reference outcome/i);
});

test('calendar-facing UI copy excludes private notes and recovery is available for pending sync', () => {
  const code = source();
  assert.match(code, /Microsoft 365 connected/);
  assert.match(code, /Microsoft 365 connection required/);
  assert.match(code, /Join Teams meeting/);
  assert.match(code, /rel="noopener noreferrer"/);
  assert.match(code, /\['pending', 'sync_failed', 'connection_required'\]\.includes\(status\)/);
  assert.match(code, /Private review notes are never included/);
  assert.match(code, /data-review-verification=/);
  assert.match(code, /interview\.endsAt/);
  assert.match(code, /scheduleFormMarkup\(data, interview\)/);
  assert.match(code, /attempts\[reference\.attempts\.length - 1\]/);
  assert.match(code, /No eligible interviewer is available/);
  assert.doesNotMatch(code, /You will be the interviewer/);
  assert.doesNotMatch(code.slice(code.indexOf('function scheduleFormMarkup'), code.indexOf('function scorecardMarkup')), /textarea name="note"/);
});

test('verification drawer remains scrollable and responsive without widening the queue cards', () => {
  const css = cssSource();
  assert.match(css, /\.talent-verification-dialog\s*\{[^}]*width:\s*min\(920px,\s*100vw\)/s);
  assert.match(css, /\.talent-verification-body\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.talent-verification-dialog\s*\{[^}]*width:\s*100vw/s);
  assert.match(css, /\.talent-review-verification\s*\{/);
  assert.doesNotMatch(css, /\.talent-review-card\s*\{[^}]*min-width:\s*[6-9]\d\dpx/s);
});

test('the verification entry point remains limited to the actual Admin and Talent Management roles', t => {
  const ui = install(t, 'sales');
  assert.equal(ui.canOpenForRole('admin'), true);
  assert.equal(ui.canOpenForRole('talent_management'), true);
  for (const role of ['sales', 'client_admin', 'client_reviewer', 'virtual_assistant', 'billing']) {
    assert.equal(ui.canOpenForRole(role), false);
  }
  assert.equal(ui.openVerification(applicantId), false);
});
