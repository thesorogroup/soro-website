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
const MAX_CANDIDATES = 500;
const MAX_INTERVIEWS = 100;
const MAX_HANDOFFS = 500;
const MAX_PLACEMENTS = 500;
const MAX_ONBOARDING_ITEMS = 50;
const VIEWER_ROLES = new Set([
  'admin', 'sales_management', 'sales', 'talent_management',
  'client_admin', 'client_reviewer'
]);
const INTERNAL_ROLES = new Set(['admin', 'sales_management', 'sales', 'talent_management']);
const INTERVIEW_STATUSES = new Set(['scheduled', 'completed', 'cancelled', 'no_show']);
const INTERVIEW_OUTCOMES = new Set(['advance', 'follow_up', 'not_selected']);
const CALENDAR_STATUSES = new Set([
  'connection_required', 'pending', 'synced', 'sync_failed', 'not_applicable'
]);
const DECISIONS = new Set(['selected', 'passed']);
const WORKFLOW_STATES = new Set(['active', 'selected', 'placed', 'passed', 'released']);
const ACTIONS = new Set([
  'schedule_interview', 'reschedule_interview', 'cancel_interview',
  'record_interview_outcome', 'retry_calendar_sync', 'final_decision',
  'prepare_handoff', 'confirm_placement', 'update_onboarding', 'activate_placement'
]);
const ACTION_KEYS = Object.freeze({
  schedule_interview: [
    'action', 'requestId', 'hiringRequestId', 'expectedUpdatedAt',
    'shortlistItemId', 'startsAt', 'durationMinutes', 'timezone'
  ],
  reschedule_interview: [
    'action', 'requestId', 'hiringRequestId', 'expectedUpdatedAt',
    'interviewId', 'startsAt', 'durationMinutes', 'timezone'
  ],
  cancel_interview: [
    'action', 'requestId', 'hiringRequestId', 'expectedUpdatedAt',
    'interviewId', 'note'
  ],
  record_interview_outcome: [
    'action', 'requestId', 'hiringRequestId', 'expectedUpdatedAt',
    'interviewId', 'status', 'outcome', 'note'
  ],
  retry_calendar_sync: [
    'action', 'requestId', 'hiringRequestId', 'expectedUpdatedAt', 'interviewId'
  ],
  final_decision: [
    'action', 'requestId', 'hiringRequestId', 'expectedUpdatedAt',
    'shortlistItemId', 'decision'
  ],
  prepare_handoff: [
    'action', 'requestId', 'hiringRequestId', 'expectedUpdatedAt',
    'decisionId', 'startDate', 'scheduleSummary', 'rateType', 'clientRate', 'talentRate'
  ],
  confirm_placement: [
    'action', 'requestId', 'hiringRequestId', 'expectedUpdatedAt', 'handoffId'
  ],
  update_onboarding: [
    'action', 'requestId', 'hiringRequestId', 'expectedUpdatedAt',
    'onboardingItemId', 'status'
  ],
  activate_placement: [
    'action', 'requestId', 'hiringRequestId', 'expectedUpdatedAt', 'placementId'
  ]
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
    throw httpError(413, 'request_too_large', 'The placement workflow request is too large.');
  }
  let body;
  try { body = event.body ? JSON.parse(event.body) : {}; } catch {
    throw httpError(400, 'invalid_request', 'The placement workflow request could not be read.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw httpError(400, 'invalid_request', 'The placement workflow request must be a JSON object.');
  }
  return body;
}

function getHiringRequestId(event) {
  const query = event.queryStringParameters || {};
  const multi = event.multiValueQueryStringParameters || {};
  const rawQuery = String(event.rawQueryString || '').trim();
  if (Object.keys(query).some(key => key !== 'hiringRequestId')
    || Object.keys(multi).some(key => key !== 'hiringRequestId')) {
    throw httpError(400, 'unsupported_scope', 'Only one hiring request can be selected.');
  }
  const values = [];
  if (Object.prototype.hasOwnProperty.call(query, 'hiringRequestId')) {
    if (Array.isArray(query.hiringRequestId)) throw httpError(400, 'unsupported_scope', 'Only one hiring request can be selected.');
    values.push(query.hiringRequestId);
  }
  if (Object.prototype.hasOwnProperty.call(multi, 'hiringRequestId')) {
    if (!Array.isArray(multi.hiringRequestId) || multi.hiringRequestId.length !== 1) {
      throw httpError(400, 'unsupported_scope', 'Only one hiring request can be selected.');
    }
    values.push(multi.hiringRequestId[0]);
  }
  if (rawQuery) {
    const params = new URLSearchParams(rawQuery);
    if ([...params.keys()].some(key => key !== 'hiringRequestId')) {
      throw httpError(400, 'unsupported_scope', 'Only one hiring request can be selected.');
    }
    const rawValues = params.getAll('hiringRequestId');
    if (rawValues.length !== 1) throw httpError(400, 'unsupported_scope', 'Only one hiring request can be selected.');
    values.push(rawValues[0]);
  }
  const normalized = values.map(value => String(value || '').trim().toLowerCase());
  if (!normalized.length || normalized.some(value => !validUuid(value)) || new Set(normalized).size !== 1) {
    throw httpError(400, 'invalid_request', 'Choose one valid hiring request.');
  }
  if (String(event.body || '').trim()) throw httpError(400, 'unsupported_scope', 'GET requests cannot include a body.');
  return normalized[0];
}

function rejectPostQuery(event) {
  if (Object.keys(event.queryStringParameters || {}).length
    || Object.keys(event.multiValueQueryStringParameters || {}).length
    || String(event.rawQueryString || '').trim()) {
    throw httpError(400, 'unsupported_scope', 'Placement scope is determined by the signed-in account and request body.');
  }
}

function serviceHeaders(extra = {}) {
  const headers = { apikey: SERVICE_KEY, ...extra };
  if (SERVICE_KEY && !SERVICE_KEY.startsWith('sb_secret_')) headers.Authorization = `Bearer ${SERVICE_KEY}`;
  return headers;
}

async function authenticatedUser(event) {
  const token = bearerToken(event);
  if (!token) throw httpError(401, 'authentication_required', 'Sign in to use the Client placement workflow.');
  if (!SUPABASE_URL || !SERVICE_KEY) throw httpError(503, 'service_unavailable', 'The Client placement workflow is not configured yet.');
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw httpError(401, 'authentication_required', 'Sign in again to use the Client placement workflow.');
    }
    throw httpError(503, 'service_unavailable', 'The Client placement workflow is temporarily unavailable.');
  }
  const user = await response.json().catch(() => null);
  if (!validUuid(user?.id)) throw httpError(401, 'authentication_required', 'Sign in again to use the Client placement workflow.');
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
  if (code === '42501') return httpError(403, 'placement_forbidden', 'This placement action is not available to your account.');
  if (code === 'P0001' && /changed after|changed\. reload/i.test(message)) {
    return httpError(409, 'placement_conflict', 'This workflow changed. Reload it before trying again.');
  }
  if (code === 'P0001' || code === '23505' || code === '23514') {
    return httpError(409, 'placement_state_conflict', 'This action is not available in the current placement state.');
  }
  if (['22023', '22P02', '22003', '22007', '22008'].includes(code)) {
    return httpError(400, 'invalid_request', 'Check the placement details and try again.');
  }
  if (code === 'PGRST202' || status === 404) return httpError(503, 'service_unavailable', 'The Client placement workflow is not configured yet.');
  return httpError(500, 'placement_service_error', 'The Client placement workflow is temporarily unavailable. Please try again.');
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
    throw httpError(502, 'placement_service_error', 'The Client placement workflow returned an invalid response.');
  }
  return payload;
}

function inputUuid(value, label) {
  if (!validUuid(value)) throw httpError(400, 'invalid_request', `Choose a valid ${label}.`);
  return String(value).trim().toLowerCase();
}

function inputTimestamp(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 40 || !Number.isFinite(Date.parse(normalized))) {
    throw httpError(400, 'invalid_request', `Choose a valid ${label}.`);
  }
  return normalized;
}

function inputText(value, label, maximum, { required = false, nullable = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw httpError(400, 'invalid_request', `${label} is required.`);
    return nullable ? null : '';
  }
  if (typeof value !== 'string') throw httpError(400, 'invalid_request', `${label} must be text.`);
  const normalized = value.trim();
  if ((!normalized && required) || normalized.length > maximum || /\u0000/.test(normalized)) {
    throw httpError(400, 'invalid_request', `${label} is invalid.`);
  }
  return normalized || (nullable ? null : '');
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

function inputDate(value) {
  const date = String(value || '').trim();
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)
    || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw httpError(400, 'invalid_request', 'Choose a valid start date.');
  }
  return date;
}

function inputMoney(value, label) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') {
    throw httpError(400, 'invalid_request', `${label} is required.`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 9999999999.99
    || Math.abs(Math.round(number * 100) - number * 100) > 1e-8) {
    throw httpError(400, 'invalid_request', `${label} must be a positive amount with no more than two decimal places.`);
  }
  return number;
}

function actionInput(body, action) {
  const entityKey = {
    schedule_interview: 'shortlistItemId',
    reschedule_interview: 'interviewId',
    cancel_interview: 'interviewId',
    record_interview_outcome: 'interviewId',
    retry_calendar_sync: 'interviewId',
    final_decision: 'shortlistItemId',
    prepare_handoff: 'decisionId',
    confirm_placement: 'handoffId',
    update_onboarding: 'onboardingItemId',
    activate_placement: 'placementId'
  }[action];
  const entityId = inputUuid(body[entityKey], entityKey.replace(/Id$/, ''));
  const payload = {};
  if (action === 'schedule_interview' || action === 'reschedule_interview') {
    payload.startsAt = inputTimestamp(body.startsAt, 'interview start time');
    if (Date.parse(payload.startsAt) <= Date.now() + 60 * 1000) throw httpError(400, 'invalid_request', 'Choose an interview time in the future.');
    payload.durationMinutes = inputDuration(body.durationMinutes);
    payload.timezone = inputTimezone(body.timezone);
    payload.calendarOrganizer = graphConfigured() ? GRAPH_ORGANIZER : null;
  } else if (action === 'cancel_interview') {
    payload.note = inputText(body.note, 'Cancellation note', 1000, { required: true });
  } else if (action === 'record_interview_outcome') {
    payload.status = String(body.status || '').trim().toLowerCase();
    if (!['completed', 'no_show'].includes(payload.status)) throw httpError(400, 'invalid_request', 'Choose Completed or No show.');
    payload.outcome = body.outcome === null ? null : String(body.outcome || '').trim().toLowerCase();
    if (payload.status === 'completed' && !INTERVIEW_OUTCOMES.has(payload.outcome)) throw httpError(400, 'invalid_request', 'Choose an interview outcome.');
    if (payload.status === 'no_show' && payload.outcome !== null) throw httpError(400, 'invalid_request', 'No show does not use an outcome.');
    payload.note = inputText(body.note, 'Interview note', 4000, { required: true });
  } else if (action === 'final_decision') {
    payload.decision = String(body.decision || '').trim().toLowerCase();
    if (!DECISIONS.has(payload.decision)) throw httpError(400, 'invalid_request', 'Choose Selected or Passed.');
  } else if (action === 'prepare_handoff') {
    payload.startDate = inputDate(body.startDate);
    payload.scheduleSummary = inputText(body.scheduleSummary, 'Schedule', 1000, { required: true });
    payload.rateType = inputText(body.rateType, 'Rate type', 60, { required: true });
    payload.clientRate = inputMoney(body.clientRate, 'Client rate');
    payload.talentRate = inputMoney(body.talentRate, 'Talent rate');
  } else if (action === 'update_onboarding') {
    payload.status = String(body.status || '').trim().toLowerCase();
    if (!['pending', 'completed'].includes(payload.status)) throw httpError(400, 'invalid_request', 'Choose Pending or Completed.');
  }
  return { entityId, payload };
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

function inputEmailAddress(value, label = 'attendee email') {
  const email = inputText(value, label, 254, { required: true }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw httpError(502, 'placement_service_error', 'The placement workflow returned an invalid calendar attendee.');
  }
  return email;
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
    subject: `Soro Client Interview — ${command.applicantName}`,
    start: { dateTime: new Date(command.startsAt).toISOString().replace(/Z$/, ''), timeZone: 'UTC' },
    end: { dateTime: new Date(command.endsAt).toISOString().replace(/Z$/, ''), timeZone: 'UTC' },
    location: { displayName: 'Microsoft Teams' },
    attendees: command.attendees.map(attendee => ({
      emailAddress: { address: attendee.email, name: attendee.name },
      type: 'required'
    }))
  };
  if (command.action === 'create') {
    event.body = {
      contentType: 'HTML',
      content: '<p>Soro Client interview. Manage private candidate notes and the final decision in Soro.</p>'
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
      const joinUrl = typeof event?.onlineMeeting?.joinUrl === 'string' ? event.onlineMeeting.joinUrl.trim() : '';
      if (!joinUrl) return { status: 'sync_failed', eventId: event.id, joinUrl: null, errorCode: 'graph_teams_link_missing' };
      return { status: 'synced', eventId: event.id, joinUrl, errorCode: null };
    }
    if (command.action === 'update') {
      const response = await fetch(`${base}/${safeGraphId(command.eventId)}`, {
        method: 'PATCH', headers, redirect: 'error', signal: AbortSignal.timeout(GRAPH_REQUEST_TIMEOUT_MS),
        body: JSON.stringify(graphEventBody(command))
      });
      const event = await responseJson(response);
      if (!response.ok) throw new Error(`graph_update_${response.status}`);
      return {
        status: 'synced', eventId: command.eventId,
        joinUrl: typeof event?.onlineMeeting?.joinUrl === 'string' ? event.onlineMeeting.joinUrl : command.joinUrl,
        errorCode: null
      };
    }
    if (command.action === 'cancel') {
      const response = await fetch(`${base}/${safeGraphId(command.eventId)}/cancel`, {
        method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(GRAPH_REQUEST_TIMEOUT_MS),
        body: JSON.stringify({ comment: 'This Soro Client interview has been cancelled.' })
      });
      if (response.status === 404 || response.status === 410) {
        return { status: 'not_applicable', eventId: command.eventId, joinUrl: null, errorCode: null };
      }
      if (!response.ok) throw new Error(`graph_cancel_${response.status}`);
      return { status: 'not_applicable', eventId: command.eventId, joinUrl: null, errorCode: null };
    }
    throw new Error('unsupported_calendar_action');
  } catch (error) {
    console.error('Microsoft Client interview synchronization failed.', {
      action: command.action
    });
    return {
      status: 'sync_failed',
      eventId: command.eventId || null,
      joinUrl: command.joinUrl || null,
      errorCode: 'graph_sync_failed'
    };
  }
}

function nullableText(value, maximum) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw httpError(502, 'placement_service_error', 'The Client placement workflow returned an invalid response.');
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximum || /\u0000/.test(normalized)) {
    throw httpError(502, 'placement_service_error', 'The Client placement workflow returned an invalid response.');
  }
  return normalized;
}

function requiredText(value, maximum) {
  const result = nullableText(value, maximum);
  if (!result) throw httpError(502, 'placement_service_error', 'The Client placement workflow returned an invalid response.');
  return result;
}

function requiredUuid(value) {
  if (!validUuid(value)) throw httpError(502, 'placement_service_error', 'The Client placement workflow returned an invalid response.');
  return String(value).trim().toLowerCase();
}

function nullableUuid(value) {
  if (value === null || value === undefined || value === '') return null;
  return requiredUuid(value);
}

function requiredTimestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw httpError(502, 'placement_service_error', 'The Client placement workflow returned an invalid response.');
  }
  return value;
}

function nullableTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  return requiredTimestamp(value);
}

function requiredInteger(value, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw httpError(502, 'placement_service_error', 'The Client placement workflow returned an invalid response.');
  }
  return value;
}

function requiredBoolean(value) {
  if (typeof value !== 'boolean') throw httpError(502, 'placement_service_error', 'The Client placement workflow returned an invalid response.');
  return value;
}

function publicInterview(value, internal) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(502, 'placement_service_error', 'The Client placement workflow returned an invalid response.');
  const status = requiredText(value.status, 30);
  if (!INTERVIEW_STATUSES.has(status)) throw httpError(502, 'placement_service_error', 'The Client placement workflow returned an invalid response.');
  const calendarStatus = requiredText(value.calendar?.status, 30);
  if (!CALENDAR_STATUSES.has(calendarStatus)) throw httpError(502, 'placement_service_error', 'The Client placement workflow returned an invalid response.');
  const result = {
    interviewId: requiredUuid(value.interviewId),
    roundNumber: requiredInteger(value.roundNumber, 1, 100),
    status,
    startsAt: requiredTimestamp(value.startsAt),
    endsAt: requiredTimestamp(value.endsAt),
    timezone: requiredText(value.timezone, 100),
    calendar: {
      status: calendarStatus,
      joinUrl: nullableText(value.calendar?.joinUrl, 2048)
    },
    updatedAt: requiredTimestamp(value.updatedAt)
  };
  if (internal) {
    result.calendar.needsCreateRetry = requiredBoolean(value.calendar?.needsCreateRetry);
    const outcome = nullableText(value.outcome, 30);
    if (outcome && !INTERVIEW_OUTCOMES.has(outcome)) throw httpError(502, 'placement_service_error', 'The Client placement workflow returned an invalid response.');
    result.outcome = outcome;
    result.notes = nullableText(value.notes, 4000);
  }
  return result;
}

function publicCandidate(value, internal) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !value.applicant || !Array.isArray(value.interviews) || value.interviews.length > MAX_INTERVIEWS) {
    throw httpError(502, 'placement_service_error', 'The Client placement workflow returned an invalid response.');
  }
  const workflowState = requiredText(value.workflowState, 30);
  if (!WORKFLOW_STATES.has(workflowState)) throw httpError(502, 'placement_service_error', 'The Client placement workflow returned an invalid response.');
  const clientResponse = nullableText(value.clientResponse, 30);
  if (clientResponse && !['request_interview', 'interested', 'not_a_fit'].includes(clientResponse)) {
    throw httpError(502, 'placement_service_error', 'The Client placement workflow returned an invalid response.');
  }
  const applicant = {
    applicantId: requiredUuid(value.applicant.applicantId),
    fullName: requiredText(value.applicant.fullName, 180),
    preferredName: nullableText(value.applicant.preferredName, 100)
  };
  if (internal) applicant.email = requiredText(value.applicant.email, 254);
  let decision = null;
  if (value.decision !== null && value.decision !== undefined) {
    const decisionValue = requiredText(value.decision.decision, 20);
    if (!DECISIONS.has(decisionValue)) throw httpError(502, 'placement_service_error', 'The Client placement workflow returned an invalid response.');
    decision = {
      decisionId: requiredUuid(value.decision.decisionId),
      decision: decisionValue,
      createdAt: requiredTimestamp(value.decision.createdAt)
    };
  }
  return {
    shortlistItemId: requiredUuid(value.shortlistItemId),
    shortlistId: requiredUuid(value.shortlistId),
    clientResponse,
    workflowState,
    updatedAt: requiredTimestamp(value.updatedAt),
    applicant,
    interviews: value.interviews.map(item => publicInterview(item, internal)),
    decision
  };
}

function publicHandoff(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(502, 'placement_service_error', 'The Client placement workflow returned an invalid response.');
  const clientRate = Number(value.clientRate);
  const talentRate = Number(value.talentRate);
  if (!Number.isFinite(clientRate) || clientRate <= 0 || !Number.isFinite(talentRate) || talentRate <= 0) {
    throw httpError(502, 'placement_service_error', 'The Client placement workflow returned an invalid response.');
  }
  return {
    handoffId: requiredUuid(value.handoffId),
    decisionId: requiredUuid(value.decisionId),
    shortlistItemId: requiredUuid(value.shortlistItemId),
    applicantId: requiredUuid(value.applicantId),
    status: requiredText(value.status, 30),
    startDate: requiredText(value.startDate, 10),
    scheduleSummary: requiredText(value.scheduleSummary, 1000),
    rateType: requiredText(value.rateType, 60),
    clientRate,
    talentRate,
    placementId: nullableUuid(value.placementId),
    updatedAt: requiredTimestamp(value.updatedAt)
  };
}

function publicOnboardingItem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(502, 'placement_service_error', 'The Client placement workflow returned an invalid response.');
  const status = requiredText(value.status, 20);
  if (!['pending', 'completed'].includes(status)) throw httpError(502, 'placement_service_error', 'The Client placement workflow returned an invalid response.');
  return {
    onboardingItemId: requiredUuid(value.onboardingItemId),
    itemKey: requiredText(value.itemKey, 60),
    title: requiredText(value.title, 180),
    required: requiredBoolean(value.required),
    status,
    updatedAt: requiredTimestamp(value.updatedAt)
  };
}

function publicPlacement(value, canManageOnboarding) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.onboardingItems)
    || value.onboardingItems.length > MAX_ONBOARDING_ITEMS) {
    throw httpError(502, 'placement_service_error', 'The Client placement workflow returned an invalid response.');
  }
  return {
    placementId: requiredUuid(value.placementId),
    applicantId: requiredUuid(value.applicantId),
    status: requiredText(value.status, 40),
    startDate: nullableText(value.startDate, 10),
    scheduleSummary: nullableText(value.scheduleSummary, 1000),
    updatedAt: requiredTimestamp(value.updatedAt),
    onboardingItems: canManageOnboarding ? value.onboardingItems.map(publicOnboardingItem) : []
  };
}

function publicPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !value.request || !value.permissions || !Array.isArray(value.candidates)
    || !Array.isArray(value.handoffs) || !Array.isArray(value.placements)
    || value.candidates.length > MAX_CANDIDATES || value.handoffs.length > MAX_HANDOFFS
    || value.placements.length > MAX_PLACEMENTS) {
    throw httpError(502, 'placement_service_error', 'The Client placement workflow returned an invalid response.');
  }
  const viewerRole = requiredText(value.viewerRole, 40);
  if (!VIEWER_ROLES.has(viewerRole)) throw httpError(502, 'placement_service_error', 'The Client placement workflow returned an invalid response.');
  const internal = INTERNAL_ROLES.has(viewerRole);
  const canManageOnboarding = viewerRole === 'admin' || viewerRole === 'talent_management';
  const result = {
    generatedAt: requiredTimestamp(value.generatedAt),
    viewerRole,
    request: {
      hiringRequestId: requiredUuid(value.request.hiringRequestId),
      clientId: requiredUuid(value.request.clientId),
      companyName: requiredText(value.request.companyName, 180),
      title: requiredText(value.request.title, 180),
      status: requiredText(value.request.status, 40),
      seats: requiredInteger(value.request.seats, 1, 10000),
      filledSeats: requiredInteger(value.request.filledSeats, 0, 10000),
      updatedAt: requiredTimestamp(value.request.updatedAt)
    },
    permissions: {
      scheduleInterview: requiredBoolean(value.permissions.scheduleInterview),
      finalDecision: requiredBoolean(value.permissions.finalDecision),
      prepareHandoff: requiredBoolean(value.permissions.prepareHandoff),
      confirmPlacement: requiredBoolean(value.permissions.confirmPlacement),
      manageOnboarding: requiredBoolean(value.permissions.manageOnboarding)
    },
    calendarIntegration: {
      configured: graphConfigured(),
      organizerLabel: 'Soro Client Interviews'
    },
    candidates: value.candidates.map(item => publicCandidate(item, internal)),
    handoffs: internal ? value.handoffs.map(publicHandoff) : [],
    placements: value.placements.map(item => publicPlacement(item, canManageOnboarding))
  };
  return result;
}

function calendarCommand(value, requestId) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['create', 'update', 'cancel'].includes(value.action)) {
    throw httpError(502, 'placement_service_error', 'The placement workflow returned an invalid calendar command.');
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
    if (!command.eventId) throw httpError(502, 'placement_service_error', 'The placement workflow returned an invalid calendar command.');
    return command;
  }
  if (!Array.isArray(value.attendees) || value.attendees.length !== 3) {
    throw httpError(502, 'placement_service_error', 'The placement workflow returned an invalid calendar command.');
  }
  return {
    ...command,
    applicantName: requiredText(value.applicantName, 180),
    startsAt: requiredTimestamp(value.startsAt),
    endsAt: requiredTimestamp(value.endsAt),
    attendees: value.attendees.map(attendee => {
      if (!attendee || typeof attendee !== 'object' || Array.isArray(attendee)) {
        throw httpError(502, 'placement_service_error', 'The placement workflow returned an invalid calendar attendee.');
      }
      return {
        name: requiredText(attendee.name, 180),
        email: inputEmailAddress(attendee.email)
      };
    })
  };
}

async function getWorkflow(event) {
  const hiringRequestId = getHiringRequestId(event);
  const user = await authenticatedUser(event);
  const payload = await callRpc('get_client_placement_workspace', {
    p_actor_user_id: user.id,
    p_hiring_request_id: hiringRequestId
  });
  return json(200, publicPayload(payload));
}

async function mutateWorkflow(event) {
  rejectPostQuery(event);
  const body = parseBody(event);
  const action = String(body.action || '').trim().toLowerCase();
  if (!ACTIONS.has(action)) throw httpError(400, 'unsupported_action', 'Choose a supported Client placement action.');
  if (!hasExactKeys(body, ACTION_KEYS[action])) {
    throw httpError(400, 'unsupported_scope', 'Only the fields required for this placement action are accepted.');
  }
  const requestId = inputUuid(body.requestId, 'request id');
  const hiringRequestId = inputUuid(body.hiringRequestId, 'hiring request');
  const expectedUpdatedAt = inputTimestamp(body.expectedUpdatedAt, 'last update time');
  const input = actionInput(body, action);
  const user = await authenticatedUser(event);
  const mutation = await callRpc('change_client_placement_workflow', {
    p_actor_user_id: user.id,
    p_request_id: requestId,
    p_hiring_request_id: hiringRequestId,
    p_action: action,
    p_expected_updated_at: expectedUpdatedAt,
    p_entity_id: input.entityId,
    p_payload: input.payload
  });
  if (!mutation.state || typeof mutation.state !== 'object' || Array.isArray(mutation.state)) {
    throw httpError(502, 'placement_service_error', 'The Client placement workflow returned an invalid response.');
  }
  const command = calendarCommand(mutation.calendarCommand, requestId);
  if (!command) return json(200, publicPayload(mutation.state));

  const sync = await syncGraphCalendar(command);
  try {
    const synced = await callRpc('record_client_interview_calendar_sync', {
      p_actor_user_id: user.id,
      p_request_id: requestId,
      p_hiring_request_id: hiringRequestId,
      p_interview_id: command.interviewId,
      p_expected_updated_at: command.expectedUpdatedAt,
      p_sync_status: sync.status,
      p_microsoft_event_id: sync.eventId,
      p_microsoft_join_url: sync.joinUrl,
      p_error_code: sync.errorCode
    });
    return json(200, publicPayload(synced));
  } catch (error) {
    // The Soro mutation already committed. Do not misrepresent a Graph or
    // result-recording failure as a rolled-back interview; a retry reuses the
    // same Graph transaction id and safely reconciles the pending command.
    console.error('Client interview calendar result could not be recorded.', {
      requestId,
      interviewId: command.interviewId,
      code: /^[a-z][a-z0-9_]{2,64}$/.test(String(error?.code || '')) ? error.code : null
    });
    return json(202, {
      ...publicPayload(mutation.state),
      calendarSyncPending: true
    });
  }
}

async function handler(event) {
  if (!['GET', 'POST'].includes(event.httpMethod)) {
    return json(405, { code: 'method_not_allowed', message: 'Method not allowed.' }, { Allow: 'GET, POST' });
  }
  try {
    return event.httpMethod === 'GET' ? await getWorkflow(event) : await mutateWorkflow(event);
  } catch (error) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    const hasSafeCode = /^[a-z][a-z0-9_]{2,64}$/.test(String(error?.code || ''));
    const code = hasSafeCode ? String(error.code) : 'placement_service_error';
    console.error('Client placement workflow operation failed.', {
      method: event.httpMethod,
      status,
      code
    });
    return json(status, {
      code,
      message: status >= 500 && code !== 'service_unavailable'
        ? 'The Client placement workflow is temporarily unavailable. Please try again.'
        : hasSafeCode
          ? error.message
          : 'The Client placement request could not be completed. Please try again.'
    });
  }
}

exports.handler = handler;
exports.ACTIONS = ACTIONS;
exports.ACTION_KEYS = ACTION_KEYS;
exports.actionInput = actionInput;
exports.calendarCommand = calendarCommand;
exports.graphConfigured = graphConfigured;
exports.graphEventBody = graphEventBody;
exports.hasExactKeys = hasExactKeys;
exports.publicPayload = publicPayload;
exports.syncGraphCalendar = syncGraphCalendar;
exports.validUuid = validUuid;
