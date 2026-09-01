/* Secure, role-scoped Client and Talent typeahead for Soro Operations. */

const configuredUrl = String(process.env.SUPABASE_URL || '').trim();
const SUPABASE_URL = /^https:\/\/[^/]+\.supabase\.co\/?$/.test(configuredUrl)
  ? configuredUrl.replace(/\/$/, '')
  : '';
const SERVICE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || ''
).trim();

const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 100;
const MAX_RESULTS_PER_GROUP = 5;
const CLIENT_MATCH_FIELDS = new Set(['company_name', 'contact_name', 'contact_email', 'contact_phone']);
const TALENT_MATCH_FIELDS = new Set(['name', 'preferred_name', 'email', 'phone']);

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

function normalizeQuery(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) {
    throw httpError(400, 'invalid_query', 'Enter between 2 and 100 characters to search.');
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length < MIN_QUERY_LENGTH || normalized.length > MAX_QUERY_LENGTH) {
    throw httpError(400, 'invalid_query', 'Enter between 2 and 100 characters to search.');
  }
  return normalized;
}

function inputQuery(event) {
  if (String(event.body || '').trim()) {
    throw httpError(400, 'unsupported_scope', 'Search accepts only one search phrase.');
  }

  const query = event.queryStringParameters || {};
  const multi = event.multiValueQueryStringParameters || {};
  const queryKeys = Object.keys(query);
  const multiKeys = Object.keys(multi);
  if (
    queryKeys.length !== 1
    || queryKeys[0] !== 'q'
    || multiKeys.some(key => key !== 'q')
    || (Array.isArray(multi.q) && multi.q.length !== 1)
  ) {
    throw httpError(400, 'unsupported_scope', 'Search accepts only one search phrase.');
  }

  return normalizeQuery(query.q);
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
  if (!token) throw httpError(401, 'authentication_required', 'Sign in to search Soro records.');
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw httpError(503, 'service_unavailable', 'Soro search is not configured yet.');
  }

  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw httpError(401, 'authentication_required', 'Sign in again to search Soro records.');
    }
    throw httpError(503, 'service_unavailable', 'Soro search is temporarily unavailable.');
  }

  const user = await response.json().catch(() => null);
  if (!validUuid(user?.id)) {
    throw httpError(401, 'authentication_required', 'Sign in again to search Soro records.');
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
  if (databaseCode === '42501') {
    return httpError(403, 'search_forbidden', 'This portal account cannot search Client or Talent records.');
  }
  if (databaseCode === '22023') {
    return httpError(400, 'invalid_query', 'Enter between 2 and 100 characters to search.');
  }
  if (databaseCode === 'PGRST202' || status === 404) {
    return httpError(503, 'service_unavailable', 'Soro search is not configured yet.');
  }
  return httpError(500, 'search_service_error', 'Soro search is temporarily unavailable. Please try again.');
}

async function callSearchRpc(userId, query) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/search_operations_directory`, {
    method: 'POST',
    headers: serviceHeaders({
      Accept: 'application/json',
      'Content-Type': 'application/json'
    }),
    body: JSON.stringify({ p_actor_user_id: userId, p_query: query })
  });
  const payload = await responseJson(response);
  if (!response.ok) throw rpcError(response.status, payload);
  return payload;
}

function nullableText(value, maximum) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    throw httpError(502, 'search_service_error', 'Soro search returned an invalid response.');
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw httpError(502, 'search_service_error', 'Soro search returned an invalid response.');
  }
  return normalized;
}

function requiredText(value, maximum) {
  const normalized = nullableText(value, maximum);
  if (!normalized) {
    throw httpError(502, 'search_service_error', 'Soro search returned an invalid response.');
  }
  return normalized;
}

function publicResult(value, expectedType) {
  if (!isPlainObject(value) || value.entityType !== expectedType || !validUuid(value.recordId)) {
    throw httpError(502, 'search_service_error', 'Soro search returned an invalid response.');
  }
  const matchedOn = requiredText(value.matchedOn, 40);
  const allowedMatchFields = expectedType === 'client' ? CLIENT_MATCH_FIELDS : TALENT_MATCH_FIELDS;
  if (!allowedMatchFields.has(matchedOn)) {
    throw httpError(502, 'search_service_error', 'Soro search returned an invalid response.');
  }
  return {
    entityType: expectedType,
    recordId: String(value.recordId).trim().toLowerCase(),
    primaryLabel: requiredText(value.primaryLabel, 180),
    secondaryLabel: nullableText(value.secondaryLabel, 254),
    statusLabel: nullableText(value.statusLabel, 60),
    matchedOn
  };
}

function publicPayload(value, input) {
  if (!isPlainObject(value) || !Array.isArray(value.clients) || !Array.isArray(value.talent)) {
    throw httpError(502, 'search_service_error', 'Soro search returned an invalid response.');
  }
  if (value.clients.length > MAX_RESULTS_PER_GROUP || value.talent.length > MAX_RESULTS_PER_GROUP) {
    throw httpError(502, 'search_service_error', 'Soro search returned an invalid response.');
  }

  const clients = value.clients.map(item => publicResult(item, 'client'));
  const talent = value.talent.map(item => publicResult(item, 'talent'));
  const resultKeys = [
    ...clients.map(item => `${item.entityType}:${item.recordId}`),
    ...talent.map(item => `${item.entityType}:${item.recordId}`)
  ];
  if (new Set(resultKeys).size !== resultKeys.length) {
    throw httpError(502, 'search_service_error', 'Soro search returned an invalid response.');
  }

  return { query: input, clients, talent };
}

async function handler(event) {
  if (String(event.httpMethod || '').toUpperCase() !== 'GET') {
    return json(405, { code: 'method_not_allowed', message: 'Method not allowed.' }, { Allow: 'GET' });
  }

  try {
    const query = inputQuery(event);
    const user = await authenticatedUser(event);
    const payload = await callSearchRpc(user.id, query);
    return json(200, publicPayload(payload, query));
  } catch (error) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600
      ? error.status
      : 500;
    if (status >= 500) {
      console.error('Global search request failed.', {
        status,
        code: error.code || 'search_request_failed'
      });
    }
    return json(status, {
      code: error.code || 'search_request_failed',
      message: status >= 500 && !error.code
        ? 'Soro search is temporarily unavailable. Please try again.'
        : error.message
    });
  }
}

exports.handler = handler;
exports.CLIENT_MATCH_FIELDS = CLIENT_MATCH_FIELDS;
exports.TALENT_MATCH_FIELDS = TALENT_MATCH_FIELDS;
exports.MAX_RESULTS_PER_GROUP = MAX_RESULTS_PER_GROUP;
exports.inputQuery = inputQuery;
exports.normalizeQuery = normalizeQuery;
exports.publicPayload = publicPayload;
exports.publicResult = publicResult;
exports.validUuid = validUuid;
