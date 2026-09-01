/* Organization-scoped Available Talent Bench and atomic Sales claim service. */

const configuredUrl = String(process.env.SUPABASE_URL || '').trim();
const SUPABASE_URL = /^https:\/\/[^/]+\.supabase\.co\/?$/.test(configuredUrl)
  ? configuredUrl.replace(/\/$/, '')
  : '';
const SERVICE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || ''
).trim();

const MAX_REQUEST_BYTES = 6 * 1024;
const MAX_ITEMS = 2000;
const MAX_SALES_OWNERS = 250;
const MAX_FILTER_VALUES = 1000;
const ACTIONS = new Set(['claim', 'assign', 'reassign', 'release', 'set_limit']);
const ITEM_ACTIONS = new Set(['claim', 'assign', 'reassign', 'release']);
const STAGES = new Set(['bench_ready', 'shortlisted', 'interviewing', 'client_review']);
const VIEWER_ROLES = new Set(['admin', 'talent_management', 'sales_management', 'sales']);
const POST_KEYS = new Set([
  'requestId',
  'action',
  'applicantId',
  'expectedUpdatedAt',
  'salesOwnerId',
  'caseloadLimit'
]);

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

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rejectQueryScope(event) {
  const query = event.queryStringParameters || {};
  const multi = event.multiValueQueryStringParameters || {};
  if (Object.keys(query).length || Object.keys(multi).length || String(event.rawQueryString || '').trim()) {
    throw httpError(400, 'unsupported_scope', 'Talent bench scope is determined by the signed-in account.');
  }
}

function rejectUnexpectedGetInput(event) {
  rejectQueryScope(event);
  if (String(event.body || '').trim()) {
    throw httpError(400, 'unsupported_scope', 'Talent bench scope is determined by the signed-in account.');
  }
}

function parseBody(event) {
  if (Buffer.byteLength(event.body || '', 'utf8') > MAX_REQUEST_BYTES) {
    throw httpError(413, 'request_too_large', 'The Talent bench request is too large.');
  }
  let body;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    throw httpError(400, 'invalid_request', 'The Talent bench request could not be read.');
  }
  if (!isPlainObject(body)) {
    throw httpError(400, 'invalid_request', 'The Talent bench request must be a JSON object.');
  }
  if (Object.keys(body).some(key => !POST_KEYS.has(key))) {
    throw httpError(400, 'unsupported_scope', 'Only Talent claim workflow fields are accepted.');
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
    throw httpError(400, 'invalid_request', 'Reload the Talent bench and try this action again.');
  }
  return normalized;
}

function inputActionBody(body) {
  if (!Object.prototype.hasOwnProperty.call(body, 'requestId') || !Object.prototype.hasOwnProperty.call(body, 'action')) {
    throw httpError(400, 'invalid_request', 'Request id and Talent bench action are required.');
  }
  const requestId = inputUuid(body.requestId, 'request id');
  const action = String(body.action || '').trim().toLowerCase();
  if (!ACTIONS.has(action)) {
    throw httpError(400, 'unsupported_action', 'Choose a supported Talent bench action.');
  }

  if (action === 'set_limit') {
    if (
      Object.prototype.hasOwnProperty.call(body, 'applicantId') && body.applicantId != null
      || Object.prototype.hasOwnProperty.call(body, 'expectedUpdatedAt') && body.expectedUpdatedAt != null
      || !Object.prototype.hasOwnProperty.call(body, 'salesOwnerId')
      || !Object.prototype.hasOwnProperty.call(body, 'caseloadLimit')
      || !Number.isSafeInteger(body.caseloadLimit)
      || body.caseloadLimit < 1
      || body.caseloadLimit > 500
    ) {
      throw httpError(400, 'invalid_request', 'Choose a Sales caseload limit between 1 and 500.');
    }
    return {
      requestId,
      action,
      applicantId: null,
      expectedUpdatedAt: null,
      salesOwnerId: inputUuid(body.salesOwnerId, 'Sales owner'),
      caseloadLimit: body.caseloadLimit
    };
  }

  if (Object.prototype.hasOwnProperty.call(body, 'caseloadLimit') && body.caseloadLimit != null) {
    throw httpError(400, 'unsupported_scope', 'A caseload limit cannot be included with a Talent assignment action.');
  }
  if (
    !Object.prototype.hasOwnProperty.call(body, 'applicantId')
    || !Object.prototype.hasOwnProperty.call(body, 'expectedUpdatedAt')
  ) {
    throw httpError(400, 'invalid_request', 'Talent assignment actions require the current bench card fields.');
  }
  const applicantId = inputUuid(body.applicantId, 'Talent profile');
  const expectedUpdatedAt = inputTimestamp(body.expectedUpdatedAt);
  let salesOwnerId = null;
  if (action === 'assign' || action === 'reassign') {
    salesOwnerId = inputUuid(body.salesOwnerId, 'Sales owner');
  } else if (Object.prototype.hasOwnProperty.call(body, 'salesOwnerId') && body.salesOwnerId != null) {
    throw httpError(400, 'unsupported_scope', 'This action does not accept a selected Sales owner.');
  }

  return {
    requestId,
    action,
    applicantId,
    expectedUpdatedAt,
    salesOwnerId,
    caseloadLimit: null
  };
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
  if (!token) throw httpError(401, 'authentication_required', 'Sign in to use the Available Talent Bench.');
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw httpError(503, 'service_unavailable', 'The Available Talent Bench is not configured yet.');
  }

  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw httpError(401, 'authentication_required', 'Sign in again to use the Available Talent Bench.');
    }
    throw httpError(503, 'service_unavailable', 'The Available Talent Bench is temporarily unavailable.');
  }

  const user = await response.json().catch(() => null);
  if (!validUuid(user?.id)) {
    throw httpError(401, 'authentication_required', 'Sign in again to use the Available Talent Bench.');
  }
  return user;
}

async function responseJson(response) {
  const body = await response.text();
  if (!body) return null;
  try { return JSON.parse(body); } catch { return null; }
}

function rpcError(status, payload) {
  const databaseCode = String(payload?.code || '');
  const databaseMessage = String(payload?.message || '');
  if (databaseCode === '42501') {
    return httpError(403, 'bench_forbidden', 'This account cannot perform that Talent bench action.');
  }
  if (databaseCode === '22023') {
    return httpError(400, 'invalid_request', 'Check the Talent bench details and try again.');
  }
  if (databaseCode === 'P0001' && /changed.*opened/i.test(databaseMessage)) {
    return httpError(409, 'bench_stale', 'This Talent profile changed. Reload the bench before trying again.');
  }
  if (databaseCode === 'P0001' && databaseMessage.includes('caseload limit')) {
    return httpError(409, 'caseload_full', 'That Sales owner has reached the active Talent caseload limit.');
  }
  if (databaseCode === 'P0001') {
    return httpError(409, 'claim_conflict', 'This Talent claim is no longer available. Reload the bench and try again.');
  }
  if (databaseCode === 'PGRST202' || status === 404) {
    return httpError(503, 'service_unavailable', 'The Available Talent Bench is not configured yet.');
  }
  return httpError(500, 'bench_service_error', 'The Available Talent Bench is temporarily unavailable. Please try again.');
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
    throw httpError(502, 'bench_service_error', 'The Available Talent Bench returned an invalid response.');
  }
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw httpError(502, 'bench_service_error', 'The Available Talent Bench returned an invalid response.');
  }
  return normalized;
}

function requiredText(value, maximum) {
  const normalized = nullableText(value, maximum);
  if (!normalized) {
    throw httpError(502, 'bench_service_error', 'The Available Talent Bench returned an invalid response.');
  }
  return normalized;
}

function requiredUuid(value) {
  if (!validUuid(value)) {
    throw httpError(502, 'bench_service_error', 'The Available Talent Bench returned an invalid response.');
  }
  return String(value).trim().toLowerCase();
}

function nullableUuid(value) {
  if (value === null || value === undefined || value === '') return null;
  return requiredUuid(value);
}

function requiredTimestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw httpError(502, 'bench_service_error', 'The Available Talent Bench returned an invalid response.');
  }
  return value;
}

function requiredCount(value, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw httpError(502, 'bench_service_error', 'The Available Talent Bench returned an invalid response.');
  }
  return value;
}

function nullableNumber(value, maximum) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) {
    throw httpError(502, 'bench_service_error', 'The Available Talent Bench returned an invalid response.');
  }
  return value;
}

function uniqueTextArray(value, maximumItems, maximumLength) {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw httpError(502, 'bench_service_error', 'The Available Talent Bench returned an invalid response.');
  }
  const normalized = value.map(item => requiredText(item, maximumLength));
  if (new Set(normalized.map(item => item.toLocaleLowerCase('en-US'))).size !== normalized.length) {
    throw httpError(502, 'bench_service_error', 'The Available Talent Bench returned an invalid response.');
  }
  return normalized;
}

function publicOwner(value) {
  if (value === null || value === undefined) {
    return { id: null, name: 'Unassigned' };
  }
  if (!isPlainObject(value)) {
    throw httpError(502, 'bench_service_error', 'The Available Talent Bench returned an invalid response.');
  }
  return {
    id: nullableUuid(value.id),
    name: requiredText(value.name, 180)
  };
}

function publicItem(value, viewerRole) {
  if (!isPlainObject(value)) {
    throw httpError(502, 'bench_service_error', 'The Available Talent Bench returned an invalid response.');
  }
  const stage = requiredText(value.stage, 30);
  if (!STAGES.has(stage)) {
    throw httpError(502, 'bench_service_error', 'The Available Talent Bench returned an invalid response.');
  }
  if (!Array.isArray(value.allowedActions) || value.allowedActions.some(action => !ITEM_ACTIONS.has(action))) {
    throw httpError(502, 'bench_service_error', 'The Available Talent Bench returned an invalid response.');
  }
  const allowedActions = [...new Set(value.allowedActions)];
  const permittedActions = viewerRole === 'admin' || viewerRole === 'talent_management'
    ? new Set(['assign', 'reassign', 'release'])
    : viewerRole === 'sales' && stage === 'bench_ready'
      ? new Set(['claim', 'release'])
      : new Set();
  if (allowedActions.some(action => !permittedActions.has(action))) {
    throw httpError(502, 'bench_service_error', 'The Available Talent Bench returned an invalid response.');
  }
  return {
    applicantId: requiredUuid(value.applicantId),
    fullName: requiredText(value.fullName, 180),
    preferredName: nullableText(value.preferredName, 100),
    stage,
    vaTypes: uniqueTextArray(value.vaTypes, 100, 120),
    verifiedSkills: uniqueTextArray(value.verifiedSkills, 250, 160),
    availability: nullableText(value.availability, 500),
    rateMin: nullableNumber(value.rateMin, 1000000),
    rateMax: nullableNumber(value.rateMax, 1000000),
    rateLabel: nullableText(value.rateLabel, 160),
    yearsExperience: nullableNumber(value.yearsExperience, 200),
    owner: publicOwner(value.owner),
    updatedAt: requiredTimestamp(value.updatedAt),
    allowedActions
  };
}

function publicSalesOwner(value) {
  if (!isPlainObject(value) || typeof value.available !== 'boolean') {
    throw httpError(502, 'bench_service_error', 'The Available Talent Bench returned an invalid response.');
  }
  const ownerCapacity = requiredCount(value.capacity, 500);
  const claimed = requiredCount(value.claimed);
  if (value.available !== (claimed < ownerCapacity)) {
    throw httpError(502, 'bench_service_error', 'The Available Talent Bench returned an invalid response.');
  }
  return {
    id: requiredUuid(value.id),
    name: requiredText(value.name, 180),
    claimed,
    capacity: ownerCapacity,
    available: value.available
  };
}

function publicPayload(value) {
  if (
    !isPlainObject(value)
    || !isPlainObject(value.caseload)
    || !isPlainObject(value.filters)
    || !Array.isArray(value.salesOwners)
    || !Array.isArray(value.items)
    || value.salesOwners.length > MAX_SALES_OWNERS
    || value.items.length > MAX_ITEMS
  ) {
    throw httpError(502, 'bench_service_error', 'The Available Talent Bench returned an invalid response.');
  }
  const viewerRole = requiredText(value.viewerRole, 40);
  if (!VIEWER_ROLES.has(viewerRole)) {
    throw httpError(502, 'bench_service_error', 'The Available Talent Bench returned an invalid response.');
  }
  const capacity = requiredCount(
    value.caseload.capacity,
    viewerRole === 'sales' ? 500 : MAX_SALES_OWNERS * 500
  );
  if (viewerRole === 'sales' && capacity < 1) {
    throw httpError(502, 'bench_service_error', 'The Available Talent Bench returned an invalid response.');
  }
  const salesOwners = value.salesOwners.map(publicSalesOwner);
  const items = value.items.map(item => publicItem(item, viewerRole));
  if (new Set(salesOwners.map(owner => owner.id)).size !== salesOwners.length) {
    throw httpError(502, 'bench_service_error', 'The Available Talent Bench returned an invalid response.');
  }
  if (new Set(items.map(item => item.applicantId)).size !== items.length) {
    throw httpError(502, 'bench_service_error', 'The Available Talent Bench returned an invalid response.');
  }

  return {
    generatedAt: requiredTimestamp(value.generatedAt),
    viewerRole,
    caseload: {
      claimed: requiredCount(value.caseload.claimed),
      capacity
    },
    salesOwners,
    filters: {
      vaTypes: uniqueTextArray(value.filters.vaTypes, MAX_FILTER_VALUES, 120),
      verifiedSkills: uniqueTextArray(value.filters.verifiedSkills, MAX_FILTER_VALUES, 160),
      availabilityOptions: uniqueTextArray(value.filters.availabilityOptions, MAX_FILTER_VALUES, 500)
    },
    items
  };
}

async function getBench(event) {
  rejectUnexpectedGetInput(event);
  const user = await authenticatedUser(event);
  const payload = await callRpc('get_available_talent_bench', { p_actor_user_id: user.id });
  return json(200, publicPayload(payload));
}

async function changeBench(event) {
  rejectQueryScope(event);
  const input = inputActionBody(parseBody(event));
  const user = await authenticatedUser(event);
  const payload = await callRpc('change_available_talent_bench', {
    p_actor_user_id: user.id,
    p_request_id: input.requestId,
    p_applicant_id: input.applicantId,
    p_expected_updated_at: input.expectedUpdatedAt,
    p_action: input.action,
    p_target_sales_owner_id: input.salesOwnerId,
    p_caseload_limit: input.caseloadLimit
  });
  return json(200, publicPayload(payload));
}

async function handler(event) {
  const method = String(event.httpMethod || '').toUpperCase();
  if (!['GET', 'POST'].includes(method)) {
    return json(405, { code: 'method_not_allowed', message: 'Method not allowed.' }, { Allow: 'GET, POST' });
  }
  try {
    return method === 'GET' ? await getBench(event) : await changeBench(event);
  } catch (error) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600
      ? error.status
      : 500;
    if (status >= 500) {
      console.error('Available Talent Bench request failed.', {
        method,
        status,
        code: error.code || 'bench_request_failed'
      });
    }
    return json(status, {
      code: error.code || 'bench_request_failed',
      message: status >= 500 && !error.code
        ? 'The Available Talent Bench is temporarily unavailable. Please try again.'
        : error.message
    });
  }
}

exports.handler = handler;
exports.ACTIONS = ACTIONS;
exports.ITEM_ACTIONS = ITEM_ACTIONS;
exports.POST_KEYS = POST_KEYS;
exports.STAGES = STAGES;
exports.VIEWER_ROLES = VIEWER_ROLES;
exports.inputActionBody = inputActionBody;
exports.publicItem = publicItem;
exports.publicPayload = publicPayload;
exports.validUuid = validUuid;
