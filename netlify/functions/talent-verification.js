const configuredUrl = String(process.env.SUPABASE_URL || '').trim();
const SUPABASE_URL = /^https:\/\/[^/]+\.supabase\.co\/?$/.test(configuredUrl)
  ? configuredUrl.replace(/\/$/, '')
  : '';
const SERVICE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || ''
).trim();

const GRAPH_TENANT_ID = String(process.env.MICROSOFT_TENANT_ID || '').trim();
const GRAPH_CLIENT_ID = String(process.env.MICROSOFT_CLIENT_ID || '').trim();
const GRAPH_CLIENT_SECRET = String(process.env.MICROSOFT_CLIENT_SECRET || '').trim();
const GRAPH_ORGANIZER = String(process.env.MICROSOFT_SHARED_ORGANIZER_USER_ID || '').trim();

const MAX_REQUEST_BYTES = 24 * 1024;
const GRAPH_REQUEST_TIMEOUT_MS = 15 * 1000;
const MAX_REFERENCES = 20;
const MAX_ATTEMPTS = 50;
const VIEWER_ROLES = new Set(['admin', 'talent_management']);
const INTERVIEW_STATUSES = new Set(['scheduled', 'completed', 'cancelled', 'no_show', 'waived']);
const INTERVIEW_OUTCOMES = new Set(['recommended', 'follow_up', 'not_recommended']);
const CALENDAR_STATUSES = new Set(['connection_required', 'pending', 'synced', 'sync_failed', 'not_applicable']);
const REFERENCE_OUTCOMES = new Set(['pending', 'verified', 'discrepancy', 'unable_to_reach', 'not_provided']);
const FINAL_REFERENCE_OUTCOMES = new Set(['verified', 'discrepancy', 'unable_to_reach', 'not_provided']);
const ATTEMPT_METHODS = new Set(['phone', 'email', 'other']);
const ATTEMPT_RESULTS = new Set(['reached', 'no_answer', 'voicemail', 'wrong_number', 'bounced', 'other']);
const ACTIONS = new Set([
  'schedule_interview',
  'reschedule_interview',
  'cancel_interview',
  'record_interview_outcome',
  'retry_calendar_sync',
  'save_reference',
  'record_reference_attempt',
  'set_reference_outcome',
  'remove_reference'
]);
const ACTION_KEYS = Object.freeze({
  schedule_interview: ['action', 'requestId', 'applicantId', 'expectedUpdatedAt', 'startsAt', 'durationMinutes', 'timezone', 'interviewerUserId'],
  reschedule_interview: ['action', 'requestId', 'applicantId', 'expectedUpdatedAt', 'interviewId', 'startsAt', 'durationMinutes', 'timezone', 'interviewerUserId'],
  cancel_interview: ['action', 'requestId', 'applicantId', 'expectedUpdatedAt', 'interviewId', 'note'],
  record_interview_outcome: [
    'action', 'requestId', 'applicantId', 'expectedUpdatedAt', 'interviewId', 'status', 'outcome',
    'communicationScore', 'preparednessScore', 'roleFitScore', 'overallScore', 'note'
  ],
  retry_calendar_sync: ['action', 'requestId', 'applicantId', 'expectedUpdatedAt', 'interviewId'],
  save_reference: ['action', 'requestId', 'applicantId', 'expectedUpdatedAt', 'referenceId', 'name', 'company', 'relationship', 'phone', 'email'],
  record_reference_attempt: ['action', 'requestId', 'applicantId', 'expectedUpdatedAt', 'referenceId', 'method', 'result', 'attemptedAt', 'note'],
  set_reference_outcome: ['action', 'requestId', 'applicantId', 'expectedUpdatedAt', 'referenceId', 'outcome', 'note'],
  remove_reference: ['action', 'requestId', 'applicantId', 'expectedUpdatedAt', 'referenceId']
});

function responseHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    Vary: 'Authorization',
    ...extra
  };
}

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: responseHeaders({ 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders }),
    body: JSON.stringify(body)
  };
}

function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '').trim()
  );
}

function bearerToken(event) {
  const header = event.headers?.authorization || event.headers?.Authorization || '';
  return /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() || '';
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseBody(event) {
  if (Buffer.byteLength(event.body || '', 'utf8') > MAX_REQUEST_BYTES) {
    throw httpError(413, 'request_too_large', 'The verification request is too large.');
  }
  let body;
  try { body = event.body ? JSON.parse(event.body) : {}; } catch {
    throw httpError(400, 'invalid_request', 'The verification request could not be read.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw httpError(400, 'invalid_request', 'The verification request must be a JSON object.');
  }
  return body;
}

function getApplicantId(event) {
  const query = event.queryStringParameters || {};
  const multi = event.multiValueQueryStringParameters || {};
  if (Object.keys(query).some(key => key !== 'applicantId') || Object.keys(multi).length > 0) {
    throw httpError(400, 'unsupported_scope', 'Only a Talent application can be selected.');
  }
  const applicantId = query.applicantId;
  if (!validUuid(applicantId)) throw httpError(400, 'invalid_request', 'Choose a valid Talent application.');
  if (String(event.body || '').trim()) throw httpError(400, 'unsupported_scope', 'GET requests cannot include a body.');
  return String(applicantId).trim().toLowerCase();
}

function rejectPostQuery(event) {
  if (
    Object.keys(event.queryStringParameters || {}).length
    || Object.keys(event.multiValueQueryStringParameters || {}).length
    || String(event.rawQueryString || '').trim()
  ) {
    throw httpError(400, 'unsupported_scope', 'Verification scope is determined by the signed-in account and request body.');
  }
}

function serviceHeaders(extra = {}) {
  const headers = { apikey: SERVICE_KEY, ...extra };
  if (SERVICE_KEY && !SERVICE_KEY.startsWith('sb_secret_')) headers.Authorization = `Bearer ${SERVICE_KEY}`;
  return headers;
}

async function authenticatedUser(event) {
  const token = bearerToken(event);
  if (!token) throw httpError(401, 'authentication_required', 'Sign in to manage Talent verification.');
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw httpError(503, 'service_unavailable', 'Talent verification is not configured yet.');
  }
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw httpError(401, 'authentication_required', 'Sign in again to manage Talent verification.');
    }
    throw httpError(503, 'service_unavailable', 'Talent verification is temporarily unavailable.');
  }
  const user = await response.json().catch(() => null);
  if (!validUuid(user?.id)) throw httpError(401, 'authentication_required', 'Sign in again to manage Talent verification.');
  return user;
}

async function responseJson(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function rpcError(status, payload) {
  const code = String(payload?.code || '');
  const message = String(payload?.message || '');
  if (code === '42501') {
    return httpError(403, 'verification_forbidden', 'Only active Admin and Talent Management accounts can manage verification.');
  }
  if (code === 'P0001' && /changed after it was opened/i.test(message)) {
    return httpError(409, 'verification_conflict', 'This verification changed. Reload it before trying again.');
  }
  if (code === 'P0001' && /two contact attempts/i.test(message)) {
    return httpError(409, 'reference_attempts_required', 'Record at least two contact attempts and add a note before using Unable to reach.');
  }
  if (code === 'P0001' || code === '23505' || code === '23514') {
    return httpError(409, 'verification_state_conflict', 'This action is not available in the current verification state.');
  }
  if (code === '22023') return httpError(400, 'invalid_request', 'Check the verification details and try again.');
  if (code === 'PGRST202' || status === 404) {
    return httpError(503, 'service_unavailable', 'Talent verification is not configured yet.');
  }
  return httpError(500, 'verification_service_error', 'Talent verification is temporarily unavailable. Please try again.');
}

async function callRpc(name, body) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: serviceHeaders({ Accept: 'application/json', 'Content-Type': 'application/json' }),
    body: JSON.stringify(body)
  });
  const payload = await responseJson(response);
  if (!response.ok) throw rpcError(response.status, payload);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw httpError(502, 'verification_service_error', 'Talent verification returned an invalid response.');
  }
  return payload;
}

function inputUuid(value, label) {
  if (!validUuid(value)) throw httpError(400, 'invalid_request', `Choose a valid ${label}.`);
  return String(value).trim().toLowerCase();
}

function inputNullableUuid(value, label) {
  if (value === null) return null;
  return inputUuid(value, label);
}

function inputTimestamp(value, label, nullable = false) {
  if (nullable && value === null) return null;
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 40 || !Number.isFinite(Date.parse(normalized))) {
    throw httpError(400, 'invalid_request', `Choose a valid ${label}.`);
  }
  return normalized;
}

function inputText(value, label, maximum, { nullable = false, required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw httpError(400, 'invalid_request', `${label} is required.`);
    return null;
  }
  if (typeof value !== 'string') throw httpError(400, 'invalid_request', `${label} must be text.`);
  const normalized = value.trim();
  if (!normalized) {
    if (required) throw httpError(400, 'invalid_request', `${label} is required.`);
    return null;
  }
  if (normalized.length > maximum || /\u0000/.test(normalized)) {
    throw httpError(400, 'invalid_request', `${label} is too long.`);
  }
  return normalized;
}

function inputScore(value, label) {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw httpError(400, 'invalid_request', `${label} must be a whole number from 1 to 5 or blank.`);
  }
  return value;
}

function inputDuration(value) {
  if (!Number.isInteger(value) || value < 15 || value > 240 || value % 5 !== 0) {
    throw httpError(400, 'invalid_request', 'Interview duration must be 15 to 240 minutes in five-minute increments.');
  }
  return value;
}

function inputTimezone(value) {
  const timezone = inputText(value, 'Time zone', 100, { required: true });
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); } catch {
    throw httpError(400, 'invalid_request', 'Choose a valid time zone.');
  }
  return timezone;
}

function inputEmail(value) {
  const email = inputText(value, 'Reference email', 254, { nullable: true });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw httpError(400, 'invalid_request', 'Enter a valid reference email or leave it blank.');
  }
  return email;
}

function actionPayload(body, action) {
  const payload = {};
  if (action === 'schedule_interview' || action === 'reschedule_interview') {
    payload.interviewId = action === 'reschedule_interview' ? inputUuid(body.interviewId, 'interview') : null;
    payload.startsAt = inputTimestamp(body.startsAt, 'interview start time');
    if (Date.parse(payload.startsAt) <= Date.now() + 60 * 1000) {
      throw httpError(400, 'invalid_request', 'Choose an interview time in the future.');
    }
    payload.durationMinutes = inputDuration(body.durationMinutes);
    payload.timezone = inputTimezone(body.timezone);
    payload.interviewerUserId = inputUuid(body.interviewerUserId, 'interviewer');
  } else if (action === 'cancel_interview') {
    payload.interviewId = inputUuid(body.interviewId, 'interview');
    payload.note = inputText(body.note, 'Cancellation note', 1000, { required: true });
  } else if (action === 'record_interview_outcome') {
    payload.interviewId = inputUuid(body.interviewId, 'interview');
    payload.status = String(body.status || '').trim().toLowerCase();
    if (!['completed', 'no_show', 'waived'].includes(payload.status)) {
      throw httpError(400, 'invalid_request', 'Choose Completed, No show, or Waived.');
    }
    payload.outcome = body.outcome === null ? null : String(body.outcome || '').trim().toLowerCase();
    if (payload.status === 'completed' && !INTERVIEW_OUTCOMES.has(payload.outcome)) {
      throw httpError(400, 'invalid_request', 'Choose an interview outcome.');
    }
    if (payload.status !== 'completed' && payload.outcome !== null) {
      throw httpError(400, 'invalid_request', 'No show and Waived do not use an interview outcome.');
    }
    payload.scorecard = {
      communication: inputScore(body.communicationScore, 'Communication score'),
      preparedness: inputScore(body.preparednessScore, 'Preparedness score'),
      roleFit: inputScore(body.roleFitScore, 'Role fit score'),
      overall: inputScore(body.overallScore, 'Overall score')
    };
    payload.note = inputText(body.note, 'Interview note', 4000, { required: true });
  } else if (action === 'retry_calendar_sync') {
    payload.interviewId = inputUuid(body.interviewId, 'interview');
  } else if (action === 'save_reference') {
    payload.referenceId = inputNullableUuid(body.referenceId, 'reference');
    payload.name = inputText(body.name, 'Reference name', 180, { required: true });
    payload.company = inputText(body.company, 'Company', 180, { nullable: true });
    payload.relationship = inputText(body.relationship, 'Relationship', 180, { nullable: true });
    payload.phone = inputText(body.phone, 'Reference phone', 60, { nullable: true });
    payload.email = inputEmail(body.email);
  } else if (action === 'record_reference_attempt') {
    payload.referenceId = inputUuid(body.referenceId, 'reference');
    payload.method = String(body.method || '').trim().toLowerCase();
    payload.result = String(body.result || '').trim().toLowerCase();
    if (!ATTEMPT_METHODS.has(payload.method) || !ATTEMPT_RESULTS.has(payload.result)) {
      throw httpError(400, 'invalid_request', 'Choose a supported contact method and result.');
    }
    payload.attemptedAt = inputTimestamp(body.attemptedAt, 'contact attempt time');
    payload.note = inputText(body.note, 'Attempt note', 1000, { nullable: true });
  } else if (action === 'set_reference_outcome') {
    payload.referenceId = inputUuid(body.referenceId, 'reference');
    payload.outcome = String(body.outcome || '').trim().toLowerCase();
    if (!FINAL_REFERENCE_OUTCOMES.has(payload.outcome)) throw httpError(400, 'invalid_request', 'Choose a final reference outcome.');
    payload.note = inputText(body.note, 'Reference outcome note', 2000, {
      required: payload.outcome === 'discrepancy' || payload.outcome === 'unable_to_reach' || payload.outcome === 'not_provided'
    });
  } else if (action === 'remove_reference') {
    payload.referenceId = inputUuid(body.referenceId, 'reference');
  }
  return payload;
}

function graphConfigured() {
  return Boolean(
    GRAPH_TENANT_ID && GRAPH_CLIENT_ID && GRAPH_CLIENT_SECRET && GRAPH_ORGANIZER
    && GRAPH_ORGANIZER.length <= 1024 && !/[\u0000-\u001f]/.test(GRAPH_ORGANIZER)
  );
}

function safeGraphId(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 1024 || /[\u0000-\u001f]/.test(normalized)) {
    throw httpError(502, 'calendar_sync_failed', 'The calendar connection returned an invalid event.');
  }
  return encodeURIComponent(normalized);
}

async function graphAccessToken() {
  const response = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(GRAPH_TENANT_ID)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      redirect: 'error',
      signal: AbortSignal.timeout(GRAPH_REQUEST_TIMEOUT_MS),
      body: new URLSearchParams({
        client_id: GRAPH_CLIENT_ID,
        client_secret: GRAPH_CLIENT_SECRET,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials'
      }).toString()
    }
  );
  const payload = await responseJson(response);
  if (!response.ok || typeof payload?.access_token !== 'string' || !payload.access_token) {
    throw httpError(502, 'calendar_sync_failed', 'Microsoft calendar connection failed.');
  }
  return payload.access_token;
}

function graphEventBody(command) {
  const event = {
    subject: `Soro Talent Interview — ${command.applicantName}`,
    start: { dateTime: new Date(command.startsAt).toISOString().replace(/Z$/, ''), timeZone: 'UTC' },
    end: { dateTime: new Date(command.endsAt).toISOString().replace(/Z$/, ''), timeZone: 'UTC' },
    location: { displayName: 'Microsoft Teams' },
    attendees: [
      { emailAddress: { address: command.applicantEmail, name: command.applicantName }, type: 'required' },
      { emailAddress: { address: command.interviewerEmail, name: command.interviewerName }, type: 'required' }
    ]
  };
  if (command.action === 'create') {
    event.body = {
      contentType: 'HTML',
      content: '<p>Soro Talent interview. Manage the interview and all private review notes in Soro.</p>'
    };
    event.isOnlineMeeting = true;
    event.onlineMeetingProvider = 'teamsForBusiness';
    event.transactionId = command.transactionId;
  }
  return event;
}

async function syncGraphCalendar(command) {
  if (!graphConfigured()) return { status: 'connection_required', eventId: null, joinUrl: null, errorCode: null };
  try {
    const token = await graphAccessToken();
    const organizer = command.organizerId || GRAPH_ORGANIZER;
    const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(organizer)}/events`;
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Prefer: 'IdType="ImmutableId"'
    };
    if (command.action === 'create') {
      const response = await fetch(base, {
        method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(GRAPH_REQUEST_TIMEOUT_MS),
        body: JSON.stringify(graphEventBody(command))
      });
      const event = await responseJson(response);
      if (!response.ok || typeof event?.id !== 'string') throw new Error(`graph_create_${response.status}`);
      const joinUrl = typeof event?.onlineMeeting?.joinUrl === 'string'
        ? event.onlineMeeting.joinUrl.trim()
        : '';
      if (!joinUrl) {
        console.error('Microsoft calendar event was created without a Teams join link.', { action: command.action });
        return {
          status: 'sync_failed',
          eventId: event.id,
          joinUrl: null,
          errorCode: 'graph_teams_link_missing'
        };
      }
      return {
        status: 'synced',
        eventId: event.id,
        joinUrl,
        errorCode: null
      };
    }
    if (command.action === 'update') {
      const response = await fetch(`${base}/${safeGraphId(command.eventId)}`, {
        method: 'PATCH', headers, redirect: 'error', signal: AbortSignal.timeout(GRAPH_REQUEST_TIMEOUT_MS),
        body: JSON.stringify(graphEventBody(command))
      });
      const event = await responseJson(response);
      if (!response.ok) throw new Error(`graph_update_${response.status}`);
      return {
        status: 'synced',
        eventId: command.eventId,
        joinUrl: typeof event?.onlineMeeting?.joinUrl === 'string' ? event.onlineMeeting.joinUrl : command.joinUrl,
        errorCode: null
      };
    }
    if (command.action === 'cancel') {
      const response = await fetch(`${base}/${safeGraphId(command.eventId)}/cancel`, {
        method: 'POST',
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(GRAPH_REQUEST_TIMEOUT_MS),
        body: JSON.stringify({ comment: 'This Soro Talent interview has been cancelled.' })
      });
      if (response.status === 404 || response.status === 410) {
        return { status: 'not_applicable', eventId: command.eventId, joinUrl: null, errorCode: null };
      }
      if (!response.ok) throw new Error(`graph_cancel_${response.status}`);
      return { status: 'not_applicable', eventId: command.eventId, joinUrl: null, errorCode: null };
    }
    throw new Error('unsupported_calendar_action');
  } catch (error) {
    console.error('Microsoft calendar synchronization failed.', { action: command.action, message: error.message });
    return { status: 'sync_failed', eventId: command.eventId || null, joinUrl: command.joinUrl || null, errorCode: 'graph_sync_failed' };
  }
}

function nullableText(value, maximum) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw httpError(502, 'verification_service_error', 'Talent verification returned an invalid response.');
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximum || /\u0000/.test(normalized)) {
    throw httpError(502, 'verification_service_error', 'Talent verification returned an invalid response.');
  }
  return normalized;
}

function requiredText(value, maximum) {
  const result = nullableText(value, maximum);
  if (!result) throw httpError(502, 'verification_service_error', 'Talent verification returned an invalid response.');
  return result;
}

function requiredUuid(value) {
  if (!validUuid(value)) throw httpError(502, 'verification_service_error', 'Talent verification returned an invalid response.');
  return String(value).trim().toLowerCase();
}

function nullableUuid(value) {
  if (value === null || value === undefined || value === '') return null;
  return requiredUuid(value);
}

function requiredTimestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw httpError(502, 'verification_service_error', 'Talent verification returned an invalid response.');
  }
  return value;
}

function nullableTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  return requiredTimestamp(value);
}

function nullableScore(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw httpError(502, 'verification_service_error', 'Talent verification returned an invalid response.');
  }
  return value;
}

function publicAttempt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(502, 'verification_service_error', 'Talent verification returned an invalid response.');
  const method = requiredText(value.method, 20);
  const result = requiredText(value.result, 30);
  if (!ATTEMPT_METHODS.has(method) || !ATTEMPT_RESULTS.has(result)) throw httpError(502, 'verification_service_error', 'Talent verification returned an invalid response.');
  return {
    attemptId: requiredUuid(value.attemptId),
    method,
    result,
    attemptedAt: requiredTimestamp(value.attemptedAt),
    note: nullableText(value.note, 1000)
  };
}

function publicReference(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.attempts) || value.attempts.length > MAX_ATTEMPTS) {
    throw httpError(502, 'verification_service_error', 'Talent verification returned an invalid response.');
  }
  const outcome = requiredText(value.outcome, 30);
  if (!REFERENCE_OUTCOMES.has(outcome)) throw httpError(502, 'verification_service_error', 'Talent verification returned an invalid response.');
  return {
    referenceId: requiredUuid(value.referenceId),
    name: requiredText(value.name, 180),
    company: nullableText(value.company, 180),
    relationship: nullableText(value.relationship, 180),
    phone: nullableText(value.phone, 60),
    email: nullableText(value.email, 254),
    outcome,
    outcomeNote: nullableText(value.outcomeNote, 2000),
    attempts: value.attempts.map(publicAttempt),
    updatedAt: requiredTimestamp(value.updatedAt)
  };
}

function publicInterview(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(502, 'verification_service_error', 'Talent verification returned an invalid response.');
  const status = requiredText(value.status, 30);
  if (!INTERVIEW_STATUSES.has(status)) throw httpError(502, 'verification_service_error', 'Talent verification returned an invalid response.');
  const outcome = nullableText(value.outcome, 30);
  if (outcome && !INTERVIEW_OUTCOMES.has(outcome)) throw httpError(502, 'verification_service_error', 'Talent verification returned an invalid response.');
  const calendarStatus = requiredText(value.calendar?.status, 30);
  if (!CALENDAR_STATUSES.has(calendarStatus)) throw httpError(502, 'verification_service_error', 'Talent verification returned an invalid response.');
  const scorecard = value.scorecard === null || value.scorecard === undefined ? null : {
    communication: nullableScore(value.scorecard.communication),
    preparedness: nullableScore(value.scorecard.preparedness),
    roleFit: nullableScore(value.scorecard.roleFit),
    overall: nullableScore(value.scorecard.overall)
  };
  return {
    interviewId: requiredUuid(value.interviewId),
    status,
    startsAt: nullableTimestamp(value.startsAt),
    endsAt: nullableTimestamp(value.endsAt),
    timezone: nullableText(value.timezone, 100),
    interviewer: { id: nullableUuid(value.interviewer?.id), name: requiredText(value.interviewer?.name, 180) },
    outcome,
    scorecard,
    notes: nullableText(value.notes, 4000),
    calendar: { status: calendarStatus, joinUrl: nullableText(value.calendar?.joinUrl, 2048) },
    updatedAt: requiredTimestamp(value.updatedAt)
  };
}

function publicPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(502, 'verification_service_error', 'Talent verification returned an invalid response.');
  const viewerRole = requiredText(value.viewerRole, 40);
  if (!VIEWER_ROLES.has(viewerRole) || !Array.isArray(value.references) || value.references.length > MAX_REFERENCES) {
    throw httpError(502, 'verification_service_error', 'Talent verification returned an invalid response.');
  }
  if (!value.applicant || !value.gate || typeof value.gate.interviewAddressed !== 'boolean' || typeof value.gate.referencesAddressed !== 'boolean' || typeof value.gate.benchReadyEligible !== 'boolean' || !Array.isArray(value.gate.blockers) || !Array.isArray(value.interviewers)) {
    throw httpError(502, 'verification_service_error', 'Talent verification returned an invalid response.');
  }
  return {
    generatedAt: requiredTimestamp(value.generatedAt),
    viewerRole,
    applicant: {
      applicantId: requiredUuid(value.applicant.applicantId),
      fullName: requiredText(value.applicant.fullName, 180),
      email: requiredText(value.applicant.email, 254),
      stage: requiredText(value.applicant.stage, 40),
      updatedAt: requiredTimestamp(value.applicant.updatedAt)
    },
    calendarIntegration: {
      configured: graphConfigured(),
      organizerLabel: 'Soro Talent Interviews'
    },
    gate: {
      interviewAddressed: value.gate.interviewAddressed,
      referencesAddressed: value.gate.referencesAddressed,
      benchReadyEligible: value.gate.benchReadyEligible,
      blockers: value.gate.blockers.map(item => requiredText(item, 100))
    },
    interview: publicInterview(value.interview),
    interviewers: value.interviewers.map(interviewer => ({
      id: requiredUuid(interviewer.id),
      name: requiredText(interviewer.name, 180)
    })),
    references: value.references.map(publicReference)
  };
}

function calendarCommand(value, requestId) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !['create', 'update', 'cancel'].includes(value.action)) {
    throw httpError(502, 'verification_service_error', 'Talent verification returned an invalid calendar command.');
  }
  const command = {
    action: value.action,
    requestId,
    transactionId: requiredUuid(value.transactionId),
    interviewId: requiredUuid(value.interviewId),
    expectedUpdatedAt: requiredTimestamp(value.expectedUpdatedAt),
    eventId: nullableText(value.eventId, 1024),
    joinUrl: nullableText(value.joinUrl, 2048),
    organizerId: nullableText(value.organizerId, 1024)
  };
  if (command.action === 'cancel') {
    if (!command.eventId) throw httpError(502, 'verification_service_error', 'Talent verification returned an invalid calendar command.');
    return command;
  }
  return {
    ...command,
    applicantName: requiredText(value.applicantName, 180),
    applicantEmail: requiredText(value.applicantEmail, 254),
    interviewerName: requiredText(value.interviewerName, 180),
    interviewerEmail: requiredText(value.interviewerEmail, 254),
    startsAt: requiredTimestamp(value.startsAt),
    endsAt: requiredTimestamp(value.endsAt)
  };
}

async function getVerification(event) {
  const applicantId = getApplicantId(event);
  const user = await authenticatedUser(event);
  const payload = await callRpc('get_talent_verification', { p_actor_user_id: user.id, p_applicant_id: applicantId });
  return json(200, publicPayload(payload));
}

async function mutateVerification(event) {
  rejectPostQuery(event);
  const body = parseBody(event);
  const action = String(body.action || '').trim().toLowerCase();
  if (!ACTIONS.has(action)) throw httpError(400, 'unsupported_action', 'Choose a supported verification action.');
  if (!hasExactKeys(body, ACTION_KEYS[action])) {
    throw httpError(400, 'unsupported_scope', 'Only the fields required for this verification action are accepted.');
  }
  const requestId = inputUuid(body.requestId, 'request id');
  const applicantId = inputUuid(body.applicantId, 'Talent application');
  const expectedUpdatedAt = inputTimestamp(body.expectedUpdatedAt, 'last update time', action === 'schedule_interview' || (action === 'save_reference' && body.referenceId === null));
  const payloadInput = actionPayload(body, action);
  if (['schedule_interview', 'reschedule_interview', 'cancel_interview', 'record_interview_outcome', 'retry_calendar_sync'].includes(action)) {
    payloadInput.calendarOrganizer = graphConfigured() ? GRAPH_ORGANIZER : null;
  }
  const user = await authenticatedUser(event);
  const mutation = await callRpc('mutate_talent_verification', {
    p_actor_user_id: user.id,
    p_request_id: requestId,
    p_applicant_id: applicantId,
    p_action: action,
    p_expected_updated_at: expectedUpdatedAt,
    p_payload: payloadInput
  });
  const command = calendarCommand(mutation.calendarCommand, requestId);
  if (!command) return json(200, publicPayload(mutation.state));

  const sync = await syncGraphCalendar(command);
  const synced = await callRpc('record_talent_interview_calendar_sync', {
    p_actor_user_id: user.id,
    p_request_id: requestId,
    p_applicant_id: applicantId,
    p_interview_id: command.interviewId,
    p_expected_updated_at: command.expectedUpdatedAt,
    p_sync_status: sync.status,
    p_microsoft_event_id: sync.eventId,
    p_microsoft_join_url: sync.joinUrl,
    p_error_code: sync.errorCode
  });
  return json(200, publicPayload(synced));
}

async function handler(event) {
  if (!['GET', 'POST'].includes(event.httpMethod)) {
    return json(405, { code: 'method_not_allowed', message: 'Method not allowed.' }, { Allow: 'GET, POST' });
  }
  try {
    return event.httpMethod === 'GET' ? await getVerification(event) : await mutateVerification(event);
  } catch (error) {
    console.error('Talent verification operation failed.', {
      method: event.httpMethod,
      status: error.status,
      code: error.code,
      message: error.message
    });
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    return json(status, {
      code: error.code || 'verification_service_error',
      message: status >= 500 && error.code !== 'service_unavailable'
        ? 'Talent verification is temporarily unavailable. Please try again.'
        : error.message
    });
  }
}

exports.handler = handler;
exports.ACTIONS = ACTIONS;
exports.ACTION_KEYS = ACTION_KEYS;
exports.actionPayload = actionPayload;
exports.graphConfigured = graphConfigured;
exports.graphEventBody = graphEventBody;
exports.hasExactKeys = hasExactKeys;
exports.publicPayload = publicPayload;
exports.syncGraphCalendar = syncGraphCalendar;
exports.validUuid = validUuid;
