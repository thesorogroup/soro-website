const configuredUrl = String(process.env.SUPABASE_URL || '').trim();
const SUPABASE_URL = /^https:\/\/[^/]+\.supabase\.co\/?$/.test(configuredUrl)
  ? configuredUrl.replace(/\/$/, '')
  : '';
const SERVICE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '').trim();

const ATTENDANCE_ACTIONS = new Set(['start_day', 'check_out']);
const ATTENDANCE_STATES = new Set(['unmatched', 'not_yet_available', 'needs_review', 'not_started', 'started', 'completed']);
const POST_BODY_KEYS = Object.freeze(['action', 'requestId']);

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

function parseBody(event) {
  if (Buffer.byteLength(event.body || '', 'utf8') > 8 * 1024) {
    throw httpError(413, 'request_too_large', 'The attendance request is too large.');
  }
  let body;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    throw httpError(400, 'invalid_request', 'The attendance request could not be read.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw httpError(400, 'invalid_request', 'The attendance request must be a JSON object.');
  }
  return body;
}

function hasExactKeys(value, expectedKeys) {
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function rejectUnexpectedScope(event) {
  const query = event.queryStringParameters || {};
  if (Object.keys(query).length > 0) {
    throw httpError(400, 'unsupported_scope', 'Attendance scope is determined by the signed-in Talent account.');
  }
  if (event.httpMethod === 'GET' && String(event.body || '').trim()) {
    throw httpError(400, 'unsupported_scope', 'Attendance scope is determined by the signed-in Talent account.');
  }
}

function serviceHeaders(extra = {}) {
  const headers = { apikey: SERVICE_KEY, ...extra };
  if (SERVICE_KEY && !SERVICE_KEY.startsWith('sb_secret_')) headers.Authorization = `Bearer ${SERVICE_KEY}`;
  return headers;
}

async function authenticatedUser(event) {
  const token = bearerToken(event);
  if (!token) throw httpError(401, 'authentication_required', 'Sign in to use Talent attendance.');
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw httpError(503, 'service_unavailable', 'Talent attendance is not configured yet.');
  }
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw httpError(401, 'authentication_required', 'Sign in again to use Talent attendance.');
  const user = await response.json().catch(() => null);
  if (!validUuid(user?.id)) throw httpError(401, 'authentication_required', 'Sign in again to use Talent attendance.');
  return user;
}

async function responseJson(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function rpcError(status, payload) {
  const databaseCode = String(payload?.code || '');
  if (databaseCode === '42501') {
    return httpError(403, 'attendance_forbidden', 'Active Talent Portal access is required.');
  }
  if (databaseCode === 'P0001') {
    return httpError(409, 'attendance_unavailable', 'A current client placement is required before starting the day.');
  }
  if (databaseCode === '21000') {
    return httpError(409, 'attendance_needs_review', 'Your Talent profile needs management review before attendance can be recorded.');
  }
  if (databaseCode === '22023') {
    return httpError(400, 'invalid_request', 'Choose a supported attendance action.');
  }
  const safeStatus = status === 401 || status === 403 ? 503 : 500;
  return httpError(safeStatus, 'attendance_service_error', 'Talent attendance is temporarily unavailable. Please try again.');
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
    throw httpError(502, 'attendance_service_error', 'Talent attendance is temporarily unavailable. Please try again.');
  }
  return payload;
}

function nullableText(value, maximum) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function nullableUuid(value) {
  return validUuid(value) ? String(value).trim().toLowerCase() : null;
}

function nullableTimestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

function publicStatus(payload) {
  const state = ATTENDANCE_STATES.has(payload.state) ? payload.state : null;
  const workDate = /^\d{4}-\d{2}-\d{2}$/.test(String(payload.workDate || '')) ? payload.workDate : null;
  const workTimezone = nullableText(payload.workTimezone, 100);
  if (!state || !workDate || !workTimezone || typeof payload.eligible !== 'boolean') {
    throw httpError(502, 'attendance_service_error', 'Talent attendance is temporarily unavailable. Please try again.');
  }
  return {
    eligible: payload.eligible,
    state,
    applicantId: nullableUuid(payload.applicantId),
    placementId: nullableUuid(payload.placementId),
    sessionId: nullableUuid(payload.sessionId),
    clientName: nullableText(payload.clientName, 180),
    scheduleSummary: nullableText(payload.scheduleSummary, 500),
    workDate,
    workTimezone,
    startedAt: nullableTimestamp(payload.startedAt),
    checkedOutAt: nullableTimestamp(payload.checkedOutAt),
    message: nullableText(payload.message, 240)
  };
}

async function getStatus(event) {
  rejectUnexpectedScope(event);
  const user = await authenticatedUser(event);
  const payload = await callRpc('get_talent_attendance_status', { p_actor_user_id: user.id });
  return json(200, publicStatus(payload));
}

async function recordAction(event) {
  rejectUnexpectedScope(event);
  const body = parseBody(event);
  if (!hasExactKeys(body, POST_BODY_KEYS)) {
    throw httpError(400, 'unsupported_scope', 'Only action and requestId are accepted. Attendance scope and times are determined securely.');
  }
  const action = String(body.action || '').trim();
  const requestId = String(body.requestId || '').trim();
  if (!ATTENDANCE_ACTIONS.has(action)) {
    throw httpError(400, 'unsupported_action', 'Choose Start Day or Check Out.');
  }
  if (!validUuid(requestId)) {
    throw httpError(400, 'invalid_request_id', 'A valid request id is required.');
  }
  const user = await authenticatedUser(event);
  const payload = await callRpc('record_talent_attendance', {
    p_actor_user_id: user.id,
    p_action: action,
    p_request_id: requestId
  });
  return json(200, publicStatus(payload));
}

async function handler(event) {
  if (!['GET', 'POST'].includes(event.httpMethod)) {
    return json(405, { code: 'method_not_allowed', message: 'Method not allowed.' }, { Allow: 'GET, POST' });
  }
  try {
    return event.httpMethod === 'GET' ? await getStatus(event) : await recordAction(event);
  } catch (error) {
    console.error('Talent attendance operation failed.', {
      method: event.httpMethod,
      status: error.status,
      code: error.code,
      message: error.message
    });
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    return json(status, {
      code: error.code || 'attendance_action_failed',
      message: status >= 500 && error.code !== 'service_unavailable'
        ? 'Talent attendance is temporarily unavailable. Please try again.'
        : error.message
    });
  }
}

exports.handler = handler;
exports.ATTENDANCE_ACTIONS = ATTENDANCE_ACTIONS;
exports.POST_BODY_KEYS = POST_BODY_KEYS;
exports.hasExactKeys = hasExactKeys;
exports.publicStatus = publicStatus;
exports.validUuid = validUuid;
