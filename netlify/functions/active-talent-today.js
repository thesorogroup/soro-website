const configuredUrl = String(process.env.SUPABASE_URL || '').trim();
const SUPABASE_URL = /^https:\/\/[^/]+\.supabase\.co\/?$/.test(configuredUrl)
  ? configuredUrl.replace(/\/$/, '')
  : '';
const SERVICE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '').trim();

const MAX_ROSTER_ROWS = 2000;
const ATTENDANCE_STATES = new Set(['not_started', 'started', 'completed', 'needs_review']);
const ACCESS_STATES = new Set([
  'ready',
  'not_invited',
  'invite_pending',
  'suspended',
  'delivery_failed',
  'setup_required',
  'unlinked'
]);
const ISSUE_CODES = new Set([
  'archived_profile_open_session',
  'multiple_current_placements',
  'stale_open_session',
  'open_session_from_prior_date',
  'timezone_fallback',
  'portal_access_not_invited',
  'portal_access_invite_pending',
  'portal_access_suspended',
  'portal_access_delivery_failed',
  'portal_access_setup_required',
  'portal_access_unlinked'
]);

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

function rejectUnexpectedScope(event) {
  const query = event.queryStringParameters || {};
  const multiValueQuery = event.multiValueQueryStringParameters || {};
  const rawQuery = String(event.rawQueryString || '').trim();
  if (
    Object.keys(query).length > 0
    || Object.keys(multiValueQuery).length > 0
    || rawQuery
    || String(event.body || '').trim()
  ) {
    throw httpError(400, 'unsupported_scope', 'The Active Talent roster scope is determined by your signed-in management account.');
  }
}

function serviceHeaders(extra = {}) {
  const headers = { apikey: SERVICE_KEY, ...extra };
  if (SERVICE_KEY && !SERVICE_KEY.startsWith('sb_secret_')) headers.Authorization = `Bearer ${SERVICE_KEY}`;
  return headers;
}

async function authenticatedUser(event) {
  const token = bearerToken(event);
  if (!token) throw httpError(401, 'authentication_required', 'Sign in to view Active Talent today.');
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw httpError(503, 'service_unavailable', 'The Active Talent roster is not configured yet.');
  }

  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw httpError(401, 'authentication_required', 'Sign in again to view Active Talent today.');
    }
    throw httpError(503, 'service_unavailable', 'The Active Talent roster is temporarily unavailable.');
  }

  const user = await response.json().catch(() => null);
  if (!validUuid(user?.id)) throw httpError(401, 'authentication_required', 'Sign in again to view Active Talent today.');
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
    return httpError(403, 'active_talent_forbidden', 'Admin or Talent Management access is required.');
  }
  if (databaseCode === '22023') {
    return httpError(400, 'invalid_request', 'A signed-in management account is required.');
  }
  if (databaseCode === 'PGRST202' || status === 404) {
    return httpError(503, 'service_unavailable', 'The Active Talent roster is not configured yet.');
  }
  const safeStatus = status === 401 || status === 403 ? 503 : 500;
  return httpError(safeStatus, 'active_talent_service_error', 'The Active Talent roster is temporarily unavailable.');
}

async function callRosterRpc(actorUserId) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_active_talent_today`, {
    method: 'POST',
    headers: serviceHeaders({
      Accept: 'application/json',
      'Content-Type': 'application/json'
    }),
    body: JSON.stringify({ p_actor_user_id: actorUserId })
  });
  const payload = await responseJson(response);
  if (!response.ok) throw rpcError(response.status, payload);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw httpError(502, 'active_talent_service_error', 'The Active Talent roster returned an invalid response.');
  }
  return payload;
}

function nullableText(value, maximum) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    throw httpError(502, 'active_talent_service_error', 'The Active Talent roster returned an invalid response.');
  }
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function requiredText(value, maximum) {
  const normalized = nullableText(value, maximum);
  if (!normalized) throw httpError(502, 'active_talent_service_error', 'The Active Talent roster returned an invalid response.');
  return normalized;
}

function nullableUuid(value) {
  if (value === null || value === undefined || value === '') return null;
  if (!validUuid(value)) {
    throw httpError(502, 'active_talent_service_error', 'The Active Talent roster returned an invalid response.');
  }
  return String(value).trim().toLowerCase();
}

function requiredUuid(value) {
  const normalized = nullableUuid(value);
  if (!normalized) throw httpError(502, 'active_talent_service_error', 'The Active Talent roster returned an invalid response.');
  return normalized;
}

function nullableDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    throw httpError(502, 'active_talent_service_error', 'The Active Talent roster returned an invalid response.');
  }
  return String(value);
}

function requiredDate(value) {
  const normalized = nullableDate(value);
  if (!normalized) throw httpError(502, 'active_talent_service_error', 'The Active Talent roster returned an invalid response.');
  return normalized;
}

function nullableTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw httpError(502, 'active_talent_service_error', 'The Active Talent roster returned an invalid response.');
  }
  return value;
}

function requiredTimestamp(value) {
  const normalized = nullableTimestamp(value);
  if (!normalized) throw httpError(502, 'active_talent_service_error', 'The Active Talent roster returned an invalid response.');
  return normalized;
}

function safeCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw httpError(502, 'active_talent_service_error', 'The Active Talent roster returned an invalid response.');
  }
  return value;
}

function publicSummary(value, rowCount) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(502, 'active_talent_service_error', 'The Active Talent roster returned an invalid response.');
  }
  const summary = {
    activeTalent: safeCount(value.activeTalent),
    checkedInToday: safeCount(value.checkedInToday),
    workingNow: safeCount(value.workingNow),
    completedToday: safeCount(value.completedToday),
    notStarted: safeCount(value.notStarted),
    needsReview: safeCount(value.needsReview)
  };
  if (Object.values(summary).some(count => count > rowCount)) {
    throw httpError(502, 'active_talent_service_error', 'The Active Talent roster returned an invalid response.');
  }
  return summary;
}

function publicRow(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(502, 'active_talent_service_error', 'The Active Talent roster returned an invalid response.');
  }
  const attendanceState = ATTENDANCE_STATES.has(value.attendanceState) ? value.attendanceState : null;
  const accessState = ACCESS_STATES.has(value.accessState) ? value.accessState : null;
  const issueCode = value.issueCode === null || value.issueCode === undefined
    ? null
    : (ISSUE_CODES.has(value.issueCode) ? value.issueCode : null);
  if (!attendanceState || !accessState || (value.issueCode !== null && value.issueCode !== undefined && !issueCode)) {
    throw httpError(502, 'active_talent_service_error', 'The Active Talent roster returned an invalid response.');
  }

  const row = {
    applicantId: requiredUuid(value.applicantId),
    fullName: requiredText(value.fullName, 180),
    preferredName: nullableText(value.preferredName, 100),
    ownerName: requiredText(value.ownerName, 180),
    placementId: nullableUuid(value.placementId),
    clientId: nullableUuid(value.clientId),
    clientName: nullableText(value.clientName, 180),
    placementStatus: nullableText(value.placementStatus, 80),
    placementStartDate: nullableDate(value.placementStartDate),
    placementEndDate: nullableDate(value.placementEndDate),
    scheduleSummary: nullableText(value.scheduleSummary, 500),
    workDate: requiredDate(value.workDate),
    workTimezone: requiredText(value.workTimezone, 100),
    attendanceState,
    accessState,
    startedAt: nullableTimestamp(value.startedAt),
    checkedOutAt: nullableTimestamp(value.checkedOutAt),
    needsAttention: value.needsAttention === true,
    issueCode
  };

  if (typeof value.needsAttention !== 'boolean') {
    throw httpError(502, 'active_talent_service_error', 'The Active Talent roster returned an invalid response.');
  }
  if (attendanceState === 'started' && !row.startedAt) {
    throw httpError(502, 'active_talent_service_error', 'The Active Talent roster returned an invalid response.');
  }
  if (attendanceState === 'started' && row.checkedOutAt) {
    throw httpError(502, 'active_talent_service_error', 'The Active Talent roster returned an invalid response.');
  }
  if (attendanceState === 'completed' && (!row.startedAt || !row.checkedOutAt)) {
    throw httpError(502, 'active_talent_service_error', 'The Active Talent roster returned an invalid response.');
  }
  if ((attendanceState === 'not_started' || attendanceState === 'needs_review') && (row.startedAt || row.checkedOutAt)) {
    throw httpError(502, 'active_talent_service_error', 'The Active Talent roster returned an invalid response.');
  }
  if (Boolean(row.placementId) !== Boolean(row.clientId)) {
    throw httpError(502, 'active_talent_service_error', 'The Active Talent roster returned an invalid response.');
  }
  if (row.needsAttention !== Boolean(row.issueCode)) {
    throw httpError(502, 'active_talent_service_error', 'The Active Talent roster returned an invalid response.');
  }
  return row;
}

function publicRoster(payload) {
  const generatedAt = requiredTimestamp(payload.generatedAt);
  if (!Array.isArray(payload.rows) || payload.rows.length > MAX_ROSTER_ROWS) {
    throw httpError(502, 'active_talent_service_error', 'The Active Talent roster returned an invalid response.');
  }
  const rows = payload.rows.map(publicRow);
  return {
    generatedAt,
    summary: publicSummary(payload.summary, rows.length),
    rows
  };
}

async function handler(event) {
  if (event.httpMethod !== 'GET') {
    return json(405, { code: 'method_not_allowed', message: 'Method not allowed.' }, { Allow: 'GET' });
  }
  try {
    rejectUnexpectedScope(event);
    const user = await authenticatedUser(event);
    const payload = await callRosterRpc(user.id);
    return json(200, publicRoster(payload));
  } catch (error) {
    console.error('Active Talent roster operation failed.', {
      method: event.httpMethod,
      status: error.status,
      code: error.code,
      message: error.message
    });
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    return json(status, {
      code: error.code || 'active_talent_service_error',
      message: status >= 500
        ? 'The Active Talent roster is temporarily unavailable.'
        : error.message
    });
  }
}

exports.handler = handler;
exports.ACCESS_STATES = ACCESS_STATES;
exports.ATTENDANCE_STATES = ATTENDANCE_STATES;
exports.ISSUE_CODES = ISSUE_CODES;
exports.publicRoster = publicRoster;
exports.validUuid = validUuid;
