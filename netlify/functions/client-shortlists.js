/* Organization-scoped Sales shortlist and Client review service. */

const configuredUrl = String(process.env.SUPABASE_URL || '').trim();
const SUPABASE_URL = /^https:\/\/[^/]+\.supabase\.co\/?$/.test(configuredUrl)
  ? configuredUrl.replace(/\/$/, '')
  : '';
const SERVICE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || ''
).trim();

const MAX_REQUEST_BYTES = 6 * 1024;
const MAX_REQUESTS = 500;
const MAX_CANDIDATES = 2000;
const MAX_SHORTLISTS = 500;
const MAX_ITEMS_PER_SHORTLIST = 500;
const MAX_NOTIFICATIONS = 200;
const MAX_SKILLS = 250;

const INTERNAL_ROLES = new Set(['admin', 'sales_management', 'sales']);
const CLIENT_REVIEW_ROLES = new Set(['client_admin', 'client_reviewer']);
const VIEWER_ROLES = new Set([...INTERNAL_ROLES, ...CLIENT_REVIEW_ROLES]);
const ACTIONS = new Set([
  'add_candidate',
  'remove_candidate',
  'send_shortlist',
  'respond_candidate'
]);
const RESPONSES = new Set(['request_interview', 'interested', 'not_a_fit']);
const SHORTLIST_STATUSES = new Set(['draft', 'sent']);
const OPEN_REQUEST_STATUSES = new Set([
  'discovery',
  'qualified',
  'open',
  'active',
  'sourcing',
  'matching',
  'shortlisting',
  'interviewing',
  'client_review'
]);
const NOTIFICATION_TYPES = new Set(['client_shortlist_ready', 'client_shortlist_response']);
const POST_KEYS = new Set([
  'action',
  'requestId',
  'expectedUpdatedAt',
  'hiringRequestId',
  'applicantId',
  'shortlistId',
  'shortlistItemId',
  'response'
]);
const ACTION_BODY_KEYS = Object.freeze({
  add_candidate: new Set(['action', 'requestId', 'expectedUpdatedAt', 'hiringRequestId', 'applicantId']),
  remove_candidate: new Set(['action', 'requestId', 'expectedUpdatedAt', 'shortlistItemId']),
  send_shortlist: new Set(['action', 'requestId', 'expectedUpdatedAt', 'shortlistId']),
  respond_candidate: new Set(['action', 'requestId', 'expectedUpdatedAt', 'shortlistItemId', 'response'])
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

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every(key => expected.has(key));
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

function rejectQueryScope(event) {
  const query = event.queryStringParameters || {};
  const multi = event.multiValueQueryStringParameters || {};
  if (Object.keys(query).length || Object.keys(multi).length || String(event.rawQueryString || '').trim()) {
    throw httpError(400, 'unsupported_scope', 'Shortlist scope is determined by the signed-in account.');
  }
}

function rejectUnexpectedGetInput(event) {
  rejectQueryScope(event);
  if (String(event.body || '').trim()) {
    throw httpError(400, 'unsupported_scope', 'Shortlist scope is determined by the signed-in account.');
  }
}

function parseBody(event) {
  if (Buffer.byteLength(event.body || '', 'utf8') > MAX_REQUEST_BYTES) {
    throw httpError(413, 'request_too_large', 'The shortlist request is too large.');
  }
  let body;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    throw httpError(400, 'invalid_request', 'The shortlist request could not be read.');
  }
  if (!isPlainObject(body)) {
    throw httpError(400, 'invalid_request', 'The shortlist request must be a JSON object.');
  }
  if (Object.keys(body).some(key => !POST_KEYS.has(key))) {
    throw httpError(400, 'unsupported_scope', 'Only shortlist workflow fields are accepted.');
  }
  return body;
}

function inputUuid(value, label) {
  if (!validUuid(value)) {
    throw httpError(400, 'invalid_request', `Choose a valid ${label}.`);
  }
  return String(value).trim().toLowerCase();
}

function inputTimestamp(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 40 || !Number.isFinite(Date.parse(normalized))) {
    throw httpError(400, 'invalid_request', 'Reload the shortlist and try this action again.');
  }
  return normalized;
}

function inputActionBody(body) {
  const action = String(body?.action || '').trim().toLowerCase();
  if (!ACTIONS.has(action)) {
    throw httpError(400, 'unsupported_action', 'Choose a supported shortlist action.');
  }
  if (!hasExactKeys(body, ACTION_BODY_KEYS[action])) {
    throw httpError(400, 'unsupported_scope', 'Only the fields required for this shortlist action are accepted.');
  }

  const input = {
    action,
    requestId: inputUuid(body.requestId, 'request id'),
    expectedUpdatedAt: inputTimestamp(body.expectedUpdatedAt),
    hiringRequestId: null,
    applicantId: null,
    shortlistId: null,
    shortlistItemId: null,
    response: null
  };

  if (action === 'add_candidate') {
    input.hiringRequestId = inputUuid(body.hiringRequestId, 'hiring request');
    input.applicantId = inputUuid(body.applicantId, 'Talent profile');
  } else if (action === 'remove_candidate') {
    input.shortlistItemId = inputUuid(body.shortlistItemId, 'shortlist candidate');
  } else if (action === 'send_shortlist') {
    input.shortlistId = inputUuid(body.shortlistId, 'shortlist');
  } else {
    input.shortlistItemId = inputUuid(body.shortlistItemId, 'shortlist candidate');
    input.response = String(body.response || '').trim().toLowerCase();
    if (!RESPONSES.has(input.response)) {
      throw httpError(400, 'invalid_response', 'Choose Request interview, Interested, or Not a fit.');
    }
  }
  return input;
}

function serviceHeaders(extra = {}) {
  const headers = { apikey: SERVICE_KEY, ...extra };
  if (SERVICE_KEY && !SERVICE_KEY.startsWith('sb_secret_')) {
    headers.Authorization = `Bearer ${SERVICE_KEY}`;
  }
  return headers;
}

async function authenticatedUser(event) {
  const token = bearerToken(event);
  if (!token) throw httpError(401, 'authentication_required', 'Sign in to use Client shortlists.');
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw httpError(503, 'service_unavailable', 'Client shortlists are not configured yet.');
  }

  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw httpError(401, 'authentication_required', 'Sign in again to use Client shortlists.');
    }
    throw httpError(503, 'service_unavailable', 'Client shortlists are temporarily unavailable.');
  }

  const user = await response.json().catch(() => null);
  if (!validUuid(user?.id)) {
    throw httpError(401, 'authentication_required', 'Sign in again to use Client shortlists.');
  }
  return user;
}

async function responseJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function rpcError(status, payload) {
  const databaseCode = String(payload?.code || '');
  const databaseMessage = String(payload?.message || '');
  if (databaseCode === '42501') {
    return httpError(403, 'shortlist_forbidden', 'This account cannot perform that shortlist action.');
  }
  if (databaseCode === '22023') {
    return httpError(400, 'invalid_request', 'Check the shortlist details and try again.');
  }
  if (databaseCode === '23505') {
    return httpError(409, 'idempotency_conflict', 'This request identifier was already used for another action.');
  }
  if (databaseCode === 'P0001' && /reviewer|membership/i.test(databaseMessage)) {
    return httpError(409, 'client_review_unavailable', 'Connect an active Client reviewer before sending this shortlist.');
  }
  if (databaseCode === 'P0001') {
    return httpError(409, 'shortlist_conflict', 'The shortlist changed. Reload it and try again.');
  }
  if (databaseCode === 'PGRST202' || status === 404) {
    return httpError(503, 'service_unavailable', 'Client shortlists are not configured yet.');
  }
  return httpError(500, 'shortlist_service_error', 'Client shortlists are temporarily unavailable. Please try again.');
}

async function callRpc(name, body) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: serviceHeaders({ Accept: 'application/json', 'Content-Type': 'application/json' }),
    body: JSON.stringify(body)
  });
  const payload = await responseJson(response);
  if (!response.ok) throw rpcError(response.status, payload);
  return payload;
}

function nullableText(value, maximum) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    throw httpError(502, 'shortlist_service_error', 'Client shortlists returned an invalid response.');
  }
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw httpError(502, 'shortlist_service_error', 'Client shortlists returned an invalid response.');
  }
  return normalized;
}

function requiredText(value, maximum) {
  const normalized = nullableText(value, maximum);
  if (!normalized) {
    throw httpError(502, 'shortlist_service_error', 'Client shortlists returned an invalid response.');
  }
  return normalized;
}

function requiredUuid(value) {
  if (!validUuid(value)) {
    throw httpError(502, 'shortlist_service_error', 'Client shortlists returned an invalid response.');
  }
  return String(value).trim().toLowerCase();
}

function nullableUuid(value) {
  if (value === null || value === undefined || value === '') return null;
  return requiredUuid(value);
}

function requiredTimestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw httpError(502, 'shortlist_service_error', 'Client shortlists returned an invalid response.');
  }
  return value;
}

function nullableTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  return requiredTimestamp(value);
}

function nullableDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw httpError(502, 'shortlist_service_error', 'Client shortlists returned an invalid response.');
  }
  return value;
}

function requiredInteger(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw httpError(502, 'shortlist_service_error', 'Client shortlists returned an invalid response.');
  }
  return value;
}

function nullableNumber(value, maximum) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) {
    throw httpError(502, 'shortlist_service_error', 'Client shortlists returned an invalid response.');
  }
  return value;
}

function requiredBoolean(value) {
  if (typeof value !== 'boolean') {
    throw httpError(502, 'shortlist_service_error', 'Client shortlists returned an invalid response.');
  }
  return value;
}

function uniqueTextArray(value, maximumItems, maximumLength) {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw httpError(502, 'shortlist_service_error', 'Client shortlists returned an invalid response.');
  }
  const normalized = value.map(item => requiredText(item, maximumLength));
  if (new Set(normalized.map(item => item.toLocaleLowerCase('en-US'))).size !== normalized.length) {
    throw httpError(502, 'shortlist_service_error', 'Client shortlists returned an invalid response.');
  }
  return normalized;
}

function normalizeStatus(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function publicRequest(value, viewerRole) {
  if (!isPlainObject(value)) {
    throw httpError(502, 'shortlist_service_error', 'Client shortlists returned an invalid response.');
  }
  const status = requiredText(value.status, 60);
  if (!OPEN_REQUEST_STATUSES.has(normalizeStatus(status))) {
    throw httpError(502, 'shortlist_service_error', 'Client shortlists returned an invalid response.');
  }
  const canAddCandidate = requiredBoolean(value.canAddCandidate);
  if (CLIENT_REVIEW_ROLES.has(viewerRole) && canAddCandidate) {
    throw httpError(502, 'shortlist_service_error', 'Client shortlists returned an invalid response.');
  }
  return {
    hiringRequestId: requiredUuid(value.hiringRequestId),
    clientId: requiredUuid(value.clientId),
    clientName: requiredText(value.clientName, 200),
    title: requiredText(value.title, 200),
    status,
    startDate: nullableDate(value.startDate),
    numberOfTalent: requiredInteger(value.numberOfTalent, 1, 10000),
    canAddCandidate
  };
}

function publicInternalCandidate(value) {
  if (!isPlainObject(value)) {
    throw httpError(502, 'shortlist_service_error', 'Client shortlists returned an invalid response.');
  }
  const stage = requiredText(value.stage, 40);
  if (stage !== 'bench_ready') {
    throw httpError(502, 'shortlist_service_error', 'Client shortlists returned an invalid response.');
  }
  return {
    applicantId: requiredUuid(value.applicantId),
    displayName: requiredText(value.displayName, 180),
    stage,
    verifiedSkills: uniqueTextArray(value.verifiedSkills, MAX_SKILLS, 160),
    yearsExperience: nullableNumber(value.yearsExperience, 200),
    availability: nullableText(value.availability, 500),
    salesOwnerId: requiredUuid(value.salesOwnerId),
    updatedAt: requiredTimestamp(value.updatedAt)
  };
}

// This is the complete Client-facing candidate allowlist. Keep direct contact,
// rates, availability, source URLs, documents, identity/preferences, support
// data, unapproved assessments, and internal notes out.
function publicClientCandidate(value) {
  if (!isPlainObject(value) || !isPlainObject(value.screening)) {
    throw httpError(502, 'shortlist_service_error', 'Client shortlists returned an invalid response.');
  }
  return {
    applicantId: requiredUuid(value.applicantId),
    displayName: requiredText(value.displayName, 180),
    country: nullableText(value.country, 100),
    timeZone: nullableText(value.timeZone, 100),
    verifiedSkills: uniqueTextArray(value.verifiedSkills, MAX_SKILLS, 160),
    yearsExperience: nullableNumber(value.yearsExperience, 200),
    experienceSummary: nullableText(value.experienceSummary, 5000),
    educationAndTraining: nullableText(value.educationAndTraining, 5000),
    screening: {
      englishResult: nullableText(value.screening.englishResult, 1000),
      personalityResult: nullableText(value.screening.personalityResult, 1000),
      computerSpecifications: nullableText(value.screening.computerSpecifications, 2000),
      internetSpeed: nullableText(value.screening.internetSpeed, 1000)
    }
  };
}

function publicShortlistItem(value, viewerRole, shortlistStatus) {
  if (!isPlainObject(value)) {
    throw httpError(502, 'shortlist_service_error', 'Client shortlists returned an invalid response.');
  }
  const response = value.response === null || value.response === undefined
    ? null
    : requiredText(value.response, 40);
  if (response !== null && !RESPONSES.has(response)) {
    throw httpError(502, 'shortlist_service_error', 'Client shortlists returned an invalid response.');
  }
  const canRemove = requiredBoolean(value.canRemove);
  const canRespond = requiredBoolean(value.canRespond);
  const internal = INTERNAL_ROLES.has(viewerRole);
  const client = CLIENT_REVIEW_ROLES.has(viewerRole);
  if (
    (canRemove && !(internal && shortlistStatus === 'draft'))
    || (canRespond && !(client && shortlistStatus === 'sent' && response === null))
  ) {
    throw httpError(502, 'shortlist_service_error', 'Client shortlists returned an invalid response.');
  }
  const candidate = publicClientCandidate(value.candidate);
  const applicantId = requiredUuid(value.applicantId);
  if (candidate.applicantId !== applicantId) {
    throw httpError(502, 'shortlist_service_error', 'Client shortlists returned an invalid response.');
  }
  const respondedAt = nullableTimestamp(value.respondedAt);
  if ((response === null) !== (respondedAt === null)) {
    throw httpError(502, 'shortlist_service_error', 'Client shortlists returned an invalid response.');
  }
  return {
    shortlistItemId: requiredUuid(value.shortlistItemId),
    applicantId,
    candidate,
    response,
    respondedAt,
    addedAt: requiredTimestamp(value.addedAt),
    updatedAt: requiredTimestamp(value.updatedAt),
    canRemove,
    canRespond
  };
}

function publicShortlist(value, viewerRole) {
  if (!isPlainObject(value) || !Array.isArray(value.items) || value.items.length > MAX_ITEMS_PER_SHORTLIST) {
    throw httpError(502, 'shortlist_service_error', 'Client shortlists returned an invalid response.');
  }
  const status = requiredText(value.status, 20);
  if (!SHORTLIST_STATUSES.has(status)) {
    throw httpError(502, 'shortlist_service_error', 'Client shortlists returned an invalid response.');
  }
  if (CLIENT_REVIEW_ROLES.has(viewerRole) && status !== 'sent') {
    throw httpError(502, 'shortlist_service_error', 'Client shortlists returned an invalid response.');
  }
  const sentAt = nullableTimestamp(value.sentAt);
  if ((status === 'sent') !== (sentAt !== null)) {
    throw httpError(502, 'shortlist_service_error', 'Client shortlists returned an invalid response.');
  }
  const items = value.items.map(item => publicShortlistItem(item, viewerRole, status));
  if (
    new Set(items.map(item => item.shortlistItemId)).size !== items.length
    || new Set(items.map(item => item.applicantId)).size !== items.length
  ) {
    throw httpError(502, 'shortlist_service_error', 'Client shortlists returned an invalid response.');
  }
  const canSend = requiredBoolean(value.canSend);
  if (canSend && !(INTERNAL_ROLES.has(viewerRole) && status === 'draft' && items.length > 0)) {
    throw httpError(502, 'shortlist_service_error', 'Client shortlists returned an invalid response.');
  }
  const result = {
    shortlistId: requiredUuid(value.shortlistId),
    hiringRequestId: requiredUuid(value.hiringRequestId),
    clientId: requiredUuid(value.clientId),
    clientName: requiredText(value.clientName, 200),
    requestTitle: requiredText(value.requestTitle, 200),
    roundNumber: requiredInteger(value.roundNumber, 1, 1000),
    status,
    sentAt,
    updatedAt: requiredTimestamp(value.updatedAt),
    canSend,
    items
  };
  if (INTERNAL_ROLES.has(viewerRole)) {
    result.salesOwnerId = requiredUuid(value.salesOwnerId);
  }
  return result;
}

function publicNotification(value) {
  if (!isPlainObject(value)) {
    throw httpError(502, 'shortlist_service_error', 'Client shortlists returned an invalid response.');
  }
  const type = requiredText(value.type, 60);
  if (!NOTIFICATION_TYPES.has(type)) {
    throw httpError(502, 'shortlist_service_error', 'Client shortlists returned an invalid response.');
  }
  const shortlistItemId = nullableUuid(value.shortlistItemId);
  if ((type === 'client_shortlist_ready') !== (shortlistItemId === null)) {
    throw httpError(502, 'shortlist_service_error', 'Client shortlists returned an invalid response.');
  }
  return {
    notificationId: requiredUuid(value.notificationId),
    type,
    title: requiredText(value.title, 160),
    message: requiredText(value.message, 500),
    shortlistId: requiredUuid(value.shortlistId),
    shortlistItemId,
    createdAt: requiredTimestamp(value.createdAt),
    readAt: nullableTimestamp(value.readAt)
  };
}

function publicPayload(value) {
  if (
    !isPlainObject(value)
    || !Array.isArray(value.requests)
    || !Array.isArray(value.candidates)
    || !Array.isArray(value.shortlists)
    || !Array.isArray(value.notifications)
    || value.requests.length > MAX_REQUESTS
    || value.candidates.length > MAX_CANDIDATES
    || value.shortlists.length > MAX_SHORTLISTS
    || value.notifications.length > MAX_NOTIFICATIONS
  ) {
    throw httpError(502, 'shortlist_service_error', 'Client shortlists returned an invalid response.');
  }
  const viewerRole = requiredText(value.viewerRole, 40);
  if (!VIEWER_ROLES.has(viewerRole)) {
    throw httpError(502, 'shortlist_service_error', 'Client shortlists returned an invalid response.');
  }
  if (CLIENT_REVIEW_ROLES.has(viewerRole) && value.candidates.length !== 0) {
    throw httpError(502, 'shortlist_service_error', 'Client shortlists returned an invalid response.');
  }

  const requests = value.requests.map(request => publicRequest(request, viewerRole));
  const candidates = INTERNAL_ROLES.has(viewerRole)
    ? value.candidates.map(publicInternalCandidate)
    : [];
  const shortlists = value.shortlists.map(shortlist => publicShortlist(shortlist, viewerRole));
  const notifications = value.notifications.map(publicNotification);
  if (
    new Set(requests.map(request => request.hiringRequestId)).size !== requests.length
    || new Set(candidates.map(candidate => candidate.applicantId)).size !== candidates.length
    || new Set(shortlists.map(shortlist => shortlist.shortlistId)).size !== shortlists.length
    || new Set(notifications.map(notification => notification.notificationId)).size !== notifications.length
  ) {
    throw httpError(502, 'shortlist_service_error', 'Client shortlists returned an invalid response.');
  }

  return {
    generatedAt: requiredTimestamp(value.generatedAt),
    viewerRole,
    requests,
    candidates,
    shortlists,
    notifications
  };
}

async function getWorkspace(event) {
  rejectUnexpectedGetInput(event);
  const user = await authenticatedUser(event);
  const payload = await callRpc('get_client_shortlist_workspace', {
    p_actor_user_id: user.id
  });
  return json(200, publicPayload(payload));
}

async function changeWorkspace(event) {
  rejectQueryScope(event);
  const input = inputActionBody(parseBody(event));
  const user = await authenticatedUser(event);
  const payload = await callRpc('change_client_shortlist', {
    p_actor_user_id: user.id,
    p_request_id: input.requestId,
    p_action: input.action,
    p_expected_updated_at: input.expectedUpdatedAt,
    p_hiring_request_id: input.hiringRequestId,
    p_applicant_id: input.applicantId,
    p_shortlist_id: input.shortlistId,
    p_shortlist_item_id: input.shortlistItemId,
    p_response: input.response
  });
  return json(200, publicPayload(payload));
}

async function handler(event) {
  const method = String(event.httpMethod || '').toUpperCase();
  if (!['GET', 'POST'].includes(method)) {
    return json(405, { code: 'method_not_allowed', message: 'Method not allowed.' }, { Allow: 'GET, POST' });
  }
  try {
    return method === 'GET' ? await getWorkspace(event) : await changeWorkspace(event);
  } catch (error) {
    console.error('Client shortlist operation failed.', {
      method,
      status: error.status,
      code: error.code,
      message: error.message
    });
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600
      ? error.status
      : 500;
    return json(status, {
      code: error.code || 'shortlist_service_error',
      message: status >= 500 && error.code !== 'service_unavailable'
        ? 'Client shortlists are temporarily unavailable. Please try again.'
        : error.message
    });
  }
}

exports.handler = handler;
exports.ACTIONS = ACTIONS;
exports.ACTION_BODY_KEYS = ACTION_BODY_KEYS;
exports.CLIENT_REVIEW_ROLES = CLIENT_REVIEW_ROLES;
exports.INTERNAL_ROLES = INTERNAL_ROLES;
exports.MAX_CANDIDATES = MAX_CANDIDATES;
exports.MAX_ITEMS_PER_SHORTLIST = MAX_ITEMS_PER_SHORTLIST;
exports.MAX_NOTIFICATIONS = MAX_NOTIFICATIONS;
exports.MAX_REQUESTS = MAX_REQUESTS;
exports.MAX_SHORTLISTS = MAX_SHORTLISTS;
exports.OPEN_REQUEST_STATUSES = OPEN_REQUEST_STATUSES;
exports.POST_KEYS = POST_KEYS;
exports.RESPONSES = RESPONSES;
exports.VIEWER_ROLES = VIEWER_ROLES;
exports.hasExactKeys = hasExactKeys;
exports.inputActionBody = inputActionBody;
exports.inputTimestamp = inputTimestamp;
exports.normalizeStatus = normalizeStatus;
exports.publicClientCandidate = publicClientCandidate;
exports.publicPayload = publicPayload;
exports.validUuid = validUuid;
