const configuredUrl = String(process.env.SUPABASE_URL || '').trim();
const SUPABASE_URL = /^https:\/\/[^/]+\.supabase\.co\/?$/.test(configuredUrl)
  ? configuredUrl.replace(/\/$/, '')
  : '';
const SERVICE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '').trim();

const MAX_REQUEST_ROWS = 1000;
const ACTIONS = new Set(['submit', 'cancel', 'approve', 'decline']);
const REQUEST_STATUSES = new Set(['pending', 'approved', 'declined', 'cancelled']);
const ELIGIBILITY_STATES = new Set(['eligible', 'unmatched', 'needs_review']);
const SUBMIT_BODY_KEYS = Object.freeze(['action', 'requestId', 'startDate', 'endDate', 'note']);
const CANCEL_BODY_KEYS = Object.freeze(['action', 'requestId', 'timeOffRequestId']);
const DECISION_BODY_KEYS = Object.freeze(['action', 'requestId', 'timeOffRequestId', 'note']);

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      Vary: 'Authorization',
      ...extraHeaders
    },
    body: JSON.stringify(body)
  };
}

function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function bearerToken(event) {
  const header = event.headers?.authorization || event.headers?.Authorization || '';
  return /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() || '';
}

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '').trim());
}

function validDate(value) {
  const normalized = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return false;
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === normalized;
}

function hasExactKeys(value, expectedKeys) {
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function parseBody(event) {
  if (Buffer.byteLength(event.body || '', 'utf8') > 8 * 1024) {
    throw httpError(413, 'request_too_large', 'The time-off request is too large.');
  }
  let body;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    throw httpError(400, 'invalid_request', 'The time-off request could not be read.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw httpError(400, 'invalid_request', 'The time-off request must be a JSON object.');
  }
  return body;
}

function rejectUnexpectedGetScope(event) {
  const query = event.queryStringParameters || {};
  const multiValueQuery = event.multiValueQueryStringParameters || {};
  const rawQuery = String(event.rawQueryString || '').trim();
  if (
    Object.keys(query).length > 0
    || Object.keys(multiValueQuery).length > 0
    || rawQuery
    || String(event.body || '').trim()
  ) {
    throw httpError(400, 'unsupported_scope', 'Time-off scope is determined by the signed-in account.');
  }
}

function serviceHeaders(extra = {}) {
  const headers = { apikey: SERVICE_KEY, ...extra };
  if (SERVICE_KEY && !SERVICE_KEY.startsWith('sb_secret_')) headers.Authorization = `Bearer ${SERVICE_KEY}`;
  return headers;
}

async function authenticatedUser(event) {
  const token = bearerToken(event);
  if (!token) throw httpError(401, 'authentication_required', 'Sign in to use Request Time Off.');
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw httpError(503, 'service_unavailable', 'Request Time Off is not configured yet.');
  }

  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw httpError(401, 'authentication_required', 'Sign in again to use Request Time Off.');
    }
    throw httpError(503, 'service_unavailable', 'Request Time Off is temporarily unavailable.');
  }

  const user = await response.json().catch(() => null);
  if (!validUuid(user?.id)) throw httpError(401, 'authentication_required', 'Sign in again to use Request Time Off.');
  return user;
}

async function responseJson(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function rpcError(status, payload) {
  const databaseCode = String(payload?.code || '');
  const databaseMessage = String(payload?.message || '');
  if (databaseCode === '42501') {
    return httpError(403, 'time_off_forbidden', 'Your account does not have access to this time-off request.');
  }
  if (databaseCode === '23P01') {
    return httpError(409, 'time_off_overlap', 'These dates overlap an existing pending or approved request.');
  }
  if (databaseCode === '21000') {
    return httpError(409, 'time_off_needs_review', 'Your current client placement needs management review before time off can be requested.');
  }
  if (databaseCode === 'P0001') {
    const cancellation = /cancel/i.test(databaseMessage);
    return httpError(
      409,
      cancellation ? 'time_off_cannot_cancel' : 'time_off_unavailable',
      cancellation
        ? 'This request can no longer be cancelled.'
        : 'Request Time Off is not available for these dates.'
    );
  }
  if (databaseCode === '23514') {
    return httpError(409, 'time_off_unavailable', 'Request Time Off is not available for these dates.');
  }
  if (databaseCode === '22023' || databaseCode === '23505') {
    return httpError(400, 'invalid_request', 'Check the request details and try again.');
  }
  if (databaseCode === 'PGRST202' || status === 404) {
    return httpError(503, 'service_unavailable', 'Request Time Off is not configured yet.');
  }
  const safeStatus = status === 401 || status === 403 ? 503 : 500;
  return httpError(safeStatus, 'time_off_service_error', 'Request Time Off is temporarily unavailable. Please try again.');
}

async function callRpc(name, body) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: serviceHeaders({
      Accept: 'application/json',
      'Content-Type': 'application/json'
    }),
    body: JSON.stringify(body)
  });
  const payload = await responseJson(response);
  if (!response.ok) throw rpcError(response.status, payload);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw httpError(502, 'time_off_service_error', 'Request Time Off returned an invalid response.');
  }
  return payload;
}

function nullableText(value, maximum) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    throw httpError(502, 'time_off_service_error', 'Request Time Off returned an invalid response.');
  }
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximum) {
    throw httpError(502, 'time_off_service_error', 'Request Time Off returned an invalid response.');
  }
  return normalized;
}

function requiredText(value, maximum) {
  const normalized = nullableText(value, maximum);
  if (!normalized) throw httpError(502, 'time_off_service_error', 'Request Time Off returned an invalid response.');
  return normalized;
}

function requiredUuid(value) {
  if (!validUuid(value)) throw httpError(502, 'time_off_service_error', 'Request Time Off returned an invalid response.');
  return String(value).trim().toLowerCase();
}

function nullableUuid(value) {
  if (value === null || value === undefined || value === '') return null;
  return requiredUuid(value);
}

function requiredDate(value) {
  if (!validDate(value)) throw httpError(502, 'time_off_service_error', 'Request Time Off returned an invalid response.');
  return String(value).trim();
}

function requiredTimestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw httpError(502, 'time_off_service_error', 'Request Time Off returned an invalid response.');
  }
  return value;
}

function nullableTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  return requiredTimestamp(value);
}

function publicEligibility(value, viewerRole) {
  if (viewerRole !== 'virtual_assistant') {
    if (value !== null && value !== undefined) {
      throw httpError(502, 'time_off_service_error', 'Request Time Off returned an invalid response.');
    }
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(502, 'time_off_service_error', 'Request Time Off returned an invalid response.');
  }
  if (typeof value.eligible !== 'boolean' || !ELIGIBILITY_STATES.has(value.state)) {
    throw httpError(502, 'time_off_service_error', 'Request Time Off returned an invalid response.');
  }
  const eligibility = {
    eligible: value.eligible,
    state: value.state,
    placementId: nullableUuid(value.placementId),
    clientName: nullableText(value.clientName, 180),
    workTimezone: requiredText(value.workTimezone, 100),
    minStartDate: requiredDate(value.minStartDate)
  };
  if (eligibility.eligible !== (eligibility.state === 'eligible')) {
    throw httpError(502, 'time_off_service_error', 'Request Time Off returned an invalid response.');
  }
  if (eligibility.eligible && (!eligibility.placementId || !eligibility.clientName)) {
    throw httpError(502, 'time_off_service_error', 'Request Time Off returned an invalid response.');
  }
  if (!eligibility.eligible && (eligibility.placementId || eligibility.clientName)) {
    throw httpError(502, 'time_off_service_error', 'Request Time Off returned an invalid response.');
  }
  return eligibility;
}

function publicRequest(value, viewerRole) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(502, 'time_off_service_error', 'Request Time Off returned an invalid response.');
  }
  if (!REQUEST_STATUSES.has(value.status) || typeof value.canCancel !== 'boolean') {
    throw httpError(502, 'time_off_service_error', 'Request Time Off returned an invalid response.');
  }
  const request = {
    timeOffRequestId: requiredUuid(value.timeOffRequestId),
    applicantId: requiredUuid(value.applicantId),
    applicantName: requiredText(value.applicantName, 180),
    placementId: requiredUuid(value.placementId),
    clientName: requiredText(value.clientName, 180),
    startDate: requiredDate(value.startDate),
    endDate: requiredDate(value.endDate),
    workTimezone: requiredText(value.workTimezone, 100),
    status: value.status,
    note: nullableText(value.note, 500),
    submittedAt: requiredTimestamp(value.submittedAt),
    decidedAt: nullableTimestamp(value.decidedAt),
    decisionNote: nullableText(value.decisionNote, 500),
    canCancel: value.canCancel
  };
  if (request.endDate < request.startDate) {
    throw httpError(502, 'time_off_service_error', 'Request Time Off returned an invalid response.');
  }
  if (viewerRole !== 'virtual_assistant' && request.canCancel) {
    throw httpError(502, 'time_off_service_error', 'Request Time Off returned an invalid response.');
  }
  if ((request.status === 'approved' || request.status === 'declined') && !request.decidedAt) {
    throw httpError(502, 'time_off_service_error', 'Request Time Off returned an invalid response.');
  }
  if (request.status === 'pending' && (request.decidedAt || request.decisionNote)) {
    throw httpError(502, 'time_off_service_error', 'Request Time Off returned an invalid response.');
  }
  if (request.status === 'declined' && !request.decisionNote) {
    throw httpError(502, 'time_off_service_error', 'Request Time Off returned an invalid response.');
  }
  return request;
}

function publicPayload(payload) {
  const viewerRole = ['virtual_assistant', 'admin', 'talent_management'].includes(payload.viewerRole)
    ? payload.viewerRole
    : null;
  if (!viewerRole || !Array.isArray(payload.requests) || payload.requests.length > MAX_REQUEST_ROWS) {
    throw httpError(502, 'time_off_service_error', 'Request Time Off returned an invalid response.');
  }
  return {
    generatedAt: requiredTimestamp(payload.generatedAt),
    viewerRole,
    eligibility: publicEligibility(payload.eligibility, viewerRole),
    requests: payload.requests.map(value => publicRequest(value, viewerRole))
  };
}

function normalizeInputNote(value) {
  if (value !== null && typeof value !== 'string') {
    throw httpError(400, 'invalid_note', 'The note must be text or blank.');
  }
  const normalized = String(value || '').trim();
  if (normalized.length > 500) {
    throw httpError(400, 'invalid_note', 'The note must be 500 characters or fewer.');
  }
  return normalized || null;
}

function validRequestId(value, fieldName) {
  const normalized = String(value || '').trim();
  if (!validUuid(normalized)) throw httpError(400, 'invalid_request_id', `A valid ${fieldName} is required.`);
  return normalized.toLowerCase();
}

async function getRequests(event) {
  rejectUnexpectedGetScope(event);
  const user = await authenticatedUser(event);
  const payload = await callRpc('get_talent_time_off', { p_actor_user_id: user.id });
  return json(200, publicPayload(payload));
}

async function postAction(event) {
  const query = event.queryStringParameters || {};
  const multiValueQuery = event.multiValueQueryStringParameters || {};
  if (Object.keys(query).length || Object.keys(multiValueQuery).length || String(event.rawQueryString || '').trim()) {
    throw httpError(400, 'unsupported_scope', 'Time-off scope is determined by the signed-in account.');
  }

  const body = parseBody(event);
  const action = String(body.action || '').trim().toLowerCase();
  if (!ACTIONS.has(action)) throw httpError(400, 'unsupported_action', 'Choose a supported time-off action.');
  const expectedKeys = action === 'submit'
    ? SUBMIT_BODY_KEYS
    : (action === 'cancel' ? CANCEL_BODY_KEYS : DECISION_BODY_KEYS);
  if (!hasExactKeys(body, expectedKeys)) {
    throw httpError(400, 'unsupported_scope', 'Only the fields required for this time-off action are accepted.');
  }

  const requestId = validRequestId(body.requestId, 'request id');
  let rpcName;
  let rpcBody;

  if (action === 'submit') {
    if (!validDate(body.startDate) || !validDate(body.endDate)) {
      throw httpError(400, 'invalid_dates', 'Choose valid start and end dates.');
    }
    if (body.endDate < body.startDate) {
      throw httpError(400, 'invalid_dates', 'End date must be on or after start date.');
    }
    rpcName = 'submit_talent_time_off';
    rpcBody = {
      p_request_id: requestId,
      p_start_date: body.startDate,
      p_end_date: body.endDate,
      p_note: normalizeInputNote(body.note)
    };
  } else {
    const timeOffRequestId = validRequestId(body.timeOffRequestId, 'time-off request id');
    const note = action === 'cancel' ? null : normalizeInputNote(body.note);
    if (action === 'decline' && !note) {
      throw httpError(400, 'decision_note_required', 'Add a brief note when a request is not approved.');
    }
    rpcName = 'change_talent_time_off';
    rpcBody = {
      p_action: action,
      p_request_id: requestId,
      p_time_off_request_id: timeOffRequestId,
      p_note: note
    };
  }

  const user = await authenticatedUser(event);
  const payload = await callRpc(rpcName, { p_actor_user_id: user.id, ...rpcBody });
  return json(200, publicPayload(payload));
}

async function handler(event) {
  if (!['GET', 'POST'].includes(event.httpMethod)) {
    return json(405, { code: 'method_not_allowed', message: 'Method not allowed.' }, { Allow: 'GET, POST' });
  }
  try {
    return event.httpMethod === 'GET' ? await getRequests(event) : await postAction(event);
  } catch (error) {
    console.error('Talent time-off operation failed.', {
      method: event.httpMethod,
      status: error.status,
      code: error.code,
      message: error.message
    });
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    return json(status, {
      code: error.code || 'time_off_service_error',
      message: status >= 500 && error.code !== 'service_unavailable'
        ? 'Request Time Off is temporarily unavailable. Please try again.'
        : error.message
    });
  }
}

exports.handler = handler;
exports.ACTIONS = ACTIONS;
exports.CANCEL_BODY_KEYS = CANCEL_BODY_KEYS;
exports.DECISION_BODY_KEYS = DECISION_BODY_KEYS;
exports.ELIGIBILITY_STATES = ELIGIBILITY_STATES;
exports.REQUEST_STATUSES = REQUEST_STATUSES;
exports.SUBMIT_BODY_KEYS = SUBMIT_BODY_KEYS;
exports.hasExactKeys = hasExactKeys;
exports.publicPayload = publicPayload;
exports.validDate = validDate;
exports.validUuid = validUuid;
