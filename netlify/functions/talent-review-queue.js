const configuredUrl = String(process.env.SUPABASE_URL || '').trim();
const SUPABASE_URL = /^https:\/\/[^/]+\.supabase\.co\/?$/.test(configuredUrl)
  ? configuredUrl.replace(/\/$/, '')
  : '';
const SERVICE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || ''
).trim();

const MAX_REQUEST_BYTES = 8 * 1024;
const MAX_APPLICANTS = 1000;
const ACTIONS = new Set([
  'begin_review',
  'request_more_info',
  'mark_bench_ready',
  'return_to_review',
  'decline',
  'archive',
  'restore',
  'reopen'
]);
const NOTE_REQUIRED_ACTIONS = new Set(['request_more_info', 'decline', 'archive']);
const STAGES = new Set(['submitted', 'in_review', 'needs_more_info', 'bench_ready', 'declined']);
const VIEWER_ROLES = new Set(['admin', 'talent_management']);
const CHECKLIST_STATES = new Set(['complete', 'missing']);
const CHECKLIST_KEYS = new Set([
  'core_profile', 'resume', 'english', 'disc', 'enneagram', 'mbti', 'internet', 'equipment', 'skills'
]);
const POST_KEYS = Object.freeze(['requestId', 'applicantId', 'expectedUpdatedAt', 'action', 'note']);

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
    headers: responseHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders
    }),
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
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '').trim()
  );
}

function hasExactKeys(value, expectedKeys) {
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function rejectQueryScope(event) {
  const query = event.queryStringParameters || {};
  const multiValueQuery = event.multiValueQueryStringParameters || {};
  const rawQuery = String(event.rawQueryString || '').trim();
  if (Object.keys(query).length || Object.keys(multiValueQuery).length || rawQuery) {
    throw httpError(400, 'unsupported_scope', 'Review scope is determined by the signed-in account.');
  }
}

function rejectUnexpectedGetScope(event) {
  rejectQueryScope(event);
  if (String(event.body || '').trim()) {
    throw httpError(400, 'unsupported_scope', 'Review scope is determined by the signed-in account.');
  }
}

function parseBody(event) {
  if (Buffer.byteLength(event.body || '', 'utf8') > MAX_REQUEST_BYTES) {
    throw httpError(413, 'request_too_large', 'The review request is too large.');
  }
  let body;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    throw httpError(400, 'invalid_request', 'The review request could not be read.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw httpError(400, 'invalid_request', 'The review request must be a JSON object.');
  }
  return body;
}

function inputUuid(value, label) {
  if (!validUuid(value)) throw httpError(400, 'invalid_request', `Choose a valid ${label}.`);
  return String(value).trim().toLowerCase();
}

function inputTimestamp(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 40 || !Number.isFinite(Date.parse(normalized))) {
    throw httpError(400, 'invalid_request', 'Reload the queue and try this review action again.');
  }
  return normalized;
}

function inputNote(value, action) {
  if (value === null || value === undefined || value === '') {
    if (NOTE_REQUIRED_ACTIONS.has(action)) {
      throw httpError(400, 'note_required', 'Add a brief note before completing this review action.');
    }
    return null;
  }
  if (typeof value !== 'string') throw httpError(400, 'invalid_request', 'The review note is invalid.');
  const normalized = value.trim();
  if (!normalized && NOTE_REQUIRED_ACTIONS.has(action)) {
    throw httpError(400, 'note_required', 'Add a brief note before completing this review action.');
  }
  if (normalized.length > 500 || /\u0000/.test(normalized)) {
    throw httpError(400, 'invalid_request', 'Keep the review note to 500 characters or fewer.');
  }
  return normalized || null;
}

function serviceHeaders(extra = {}) {
  const headers = { apikey: SERVICE_KEY, ...extra };
  if (SERVICE_KEY && !SERVICE_KEY.startsWith('sb_secret_')) headers.Authorization = `Bearer ${SERVICE_KEY}`;
  return headers;
}

async function authenticatedUser(event) {
  const token = bearerToken(event);
  if (!token) throw httpError(401, 'authentication_required', 'Sign in to review Talent applications.');
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw httpError(503, 'service_unavailable', 'The Talent review queue is not configured yet.');
  }

  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw httpError(401, 'authentication_required', 'Sign in again to review Talent applications.');
    }
    throw httpError(503, 'service_unavailable', 'The Talent review queue is temporarily unavailable.');
  }

  const user = await response.json().catch(() => null);
  if (!validUuid(user?.id)) {
    throw httpError(401, 'authentication_required', 'Sign in again to review Talent applications.');
  }
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
    return httpError(403, 'review_forbidden', 'Only active Admin and Talent Management accounts can use this review queue.');
  }
  if (databaseCode === '22023') {
    return httpError(400, 'invalid_request', 'Check the review details and try again.');
  }
  if (databaseCode === 'P0001' && databaseMessage === 'This Talent application changed after it was opened.') {
    return httpError(409, 'review_conflict', 'This Talent application changed. Reload the queue before choosing another action.');
  }
  if (databaseCode === 'P0001' && databaseMessage === 'Required review sources are still missing.') {
    return httpError(409, 'review_incomplete', 'Complete the missing review items before marking this Talent Bench Ready.');
  }
  if (databaseCode === 'P0001' || databaseCode === '23514' || databaseCode === '23505') {
    return httpError(409, 'review_transition_conflict', 'This review action is not available in the application’s current stage.');
  }
  if (databaseCode === 'PGRST202' || status === 404) {
    return httpError(503, 'service_unavailable', 'The Talent review queue is not configured yet.');
  }
  return httpError(500, 'review_service_error', 'The Talent review queue is temporarily unavailable. Please try again.');
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
    throw httpError(502, 'review_service_error', 'The Talent review queue returned an invalid response.');
  }
  return payload;
}

function nullableText(value, maximum) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw httpError(502, 'review_service_error', 'The Talent review queue returned an invalid response.');
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximum || /\u0000/.test(normalized)) {
    throw httpError(502, 'review_service_error', 'The Talent review queue returned an invalid response.');
  }
  return normalized;
}

function requiredText(value, maximum) {
  const normalized = nullableText(value, maximum);
  if (!normalized) throw httpError(502, 'review_service_error', 'The Talent review queue returned an invalid response.');
  return normalized;
}

function requiredUuid(value) {
  if (!validUuid(value)) throw httpError(502, 'review_service_error', 'The Talent review queue returned an invalid response.');
  return String(value).trim().toLowerCase();
}

function nullableUuid(value) {
  if (value === null || value === undefined || value === '') return null;
  return requiredUuid(value);
}

function requiredTimestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw httpError(502, 'review_service_error', 'The Talent review queue returned an invalid response.');
  }
  return value;
}

function requiredCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw httpError(502, 'review_service_error', 'The Talent review queue returned an invalid response.');
  }
  return value;
}

function publicChecklistItem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(502, 'review_service_error', 'The Talent review queue returned an invalid response.');
  }
  const key = requiredText(value.key, 60);
  const state = requiredText(value.state, 20);
  if (!CHECKLIST_KEYS.has(key) || !CHECKLIST_STATES.has(state)) {
    throw httpError(502, 'review_service_error', 'The Talent review queue returned an invalid response.');
  }
  return { key, label: requiredText(value.label, 100), state };
}

function publicResumeReference(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.available !== 'boolean') {
    throw httpError(502, 'review_service_error', 'The Talent review queue returned an invalid response.');
  }
  return {
    available: value.available,
    label: value.available ? 'Résumé available' : 'Résumé not attached'
  };
}

function publicApplicant(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(502, 'review_service_error', 'The Talent review queue returned an invalid response.');
  }
  const stage = requiredText(value.stage, 30);
  if (!STAGES.has(stage) || typeof value.archived !== 'boolean') {
    throw httpError(502, 'review_service_error', 'The Talent review queue returned an invalid response.');
  }
  if (!value.owner || typeof value.owner !== 'object' || Array.isArray(value.owner)) {
    throw httpError(502, 'review_service_error', 'The Talent review queue returned an invalid response.');
  }
  if (!Array.isArray(value.checklist) || value.checklist.length !== CHECKLIST_KEYS.size) {
    throw httpError(502, 'review_service_error', 'The Talent review queue returned an invalid response.');
  }
  const checklist = value.checklist.map(publicChecklistItem);
  if (new Set(checklist.map(item => item.key)).size !== CHECKLIST_KEYS.size) {
    throw httpError(502, 'review_service_error', 'The Talent review queue returned an invalid response.');
  }
  if (!Array.isArray(value.allowedActions) || value.allowedActions.some(action => !ACTIONS.has(action))) {
    throw httpError(502, 'review_service_error', 'The Talent review queue returned an invalid response.');
  }
  return {
    applicantId: requiredUuid(value.applicantId),
    fullName: requiredText(value.fullName, 180),
    preferredName: nullableText(value.preferredName, 100),
    email: requiredText(value.email, 254),
    applicationReceivedAt: requiredTimestamp(value.applicationReceivedAt),
    updatedAt: requiredTimestamp(value.updatedAt),
    stage,
    archived: value.archived,
    owner: {
      id: nullableUuid(value.owner.id),
      name: requiredText(value.owner.name, 180)
    },
    resume: publicResumeReference(value.resume),
    checklist,
    allowedActions: [...new Set(value.allowedActions)]
  };
}

function publicPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(502, 'review_service_error', 'The Talent review queue returned an invalid response.');
  }
  const viewerRole = requiredText(value.viewerRole, 40);
  if (!VIEWER_ROLES.has(viewerRole)) {
    throw httpError(502, 'review_service_error', 'The Talent review queue returned an invalid response.');
  }
  if (!value.summary || typeof value.summary !== 'object' || Array.isArray(value.summary)) {
    throw httpError(502, 'review_service_error', 'The Talent review queue returned an invalid response.');
  }
  if (!Array.isArray(value.applicants) || value.applicants.length > MAX_APPLICANTS) {
    throw httpError(502, 'review_service_error', 'The Talent review queue returned an invalid response.');
  }
  const applicants = value.applicants.map(publicApplicant);
  const summary = {
    all: requiredCount(value.summary.all),
    submitted: requiredCount(value.summary.submitted),
    in_review: requiredCount(value.summary.in_review),
    needs_more_info: requiredCount(value.summary.needs_more_info),
    bench_ready: requiredCount(value.summary.bench_ready),
    closed: requiredCount(value.summary.closed)
  };
  if (
    summary.all !== applicants.length
    || summary.all !== summary.submitted + summary.in_review + summary.needs_more_info + summary.bench_ready + summary.closed
  ) {
    throw httpError(502, 'review_service_error', 'The Talent review queue returned an invalid response.');
  }
  return {
    generatedAt: requiredTimestamp(value.generatedAt),
    viewerRole,
    summary,
    applicants
  };
}

async function getQueue(event) {
  rejectUnexpectedGetScope(event);
  const user = await authenticatedUser(event);
  const payload = await callRpc('get_talent_review_queue', { p_actor_user_id: user.id });
  return json(200, publicPayload(payload));
}

async function changeStage(event) {
  rejectQueryScope(event);
  const body = parseBody(event);
  if (!hasExactKeys(body, POST_KEYS)) {
    throw httpError(400, 'unsupported_scope', 'Only the fields required for this review action are accepted.');
  }
  const action = String(body.action || '').trim().toLowerCase();
  if (!ACTIONS.has(action)) throw httpError(400, 'unsupported_action', 'Choose a supported review action.');
  const user = await authenticatedUser(event);
  const payload = await callRpc('change_talent_review_stage', {
    p_actor_user_id: user.id,
    p_request_id: inputUuid(body.requestId, 'request id'),
    p_applicant_id: inputUuid(body.applicantId, 'Talent application'),
    p_expected_updated_at: inputTimestamp(body.expectedUpdatedAt),
    p_action: action,
    p_note: inputNote(body.note, action)
  });
  return json(200, publicPayload(payload));
}

async function handler(event) {
  if (!['GET', 'POST'].includes(event.httpMethod)) {
    return json(405, { code: 'method_not_allowed', message: 'Method not allowed.' }, { Allow: 'GET, POST' });
  }
  try {
    return event.httpMethod === 'GET' ? await getQueue(event) : await changeStage(event);
  } catch (error) {
    console.error('Talent review operation failed.', {
      method: event.httpMethod,
      status: error.status,
      code: error.code,
      message: error.message
    });
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    return json(status, {
      code: error.code || 'review_service_error',
      message: status >= 500 && error.code !== 'service_unavailable'
        ? 'The Talent review queue is temporarily unavailable. Please try again.'
        : error.message
    });
  }
}

exports.handler = handler;
exports.ACTIONS = ACTIONS;
exports.CHECKLIST_KEYS = CHECKLIST_KEYS;
exports.NOTE_REQUIRED_ACTIONS = NOTE_REQUIRED_ACTIONS;
exports.POST_KEYS = POST_KEYS;
exports.STAGES = STAGES;
exports.hasExactKeys = hasExactKeys;
exports.inputNote = inputNote;
exports.publicPayload = publicPayload;
exports.publicResumeReference = publicResumeReference;
exports.validUuid = validUuid;
