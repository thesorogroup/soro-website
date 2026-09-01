/* Safe internal Client profile reads for authenticated Soro employees. */

const configuredUrl = String(process.env.SUPABASE_URL || '').trim();
const SUPABASE_URL = /^https:\/\/[^/]+\.supabase\.co\/?$/.test(configuredUrl)
  ? configuredUrl.replace(/\/$/, '')
  : '';
const SERVICE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || ''
).trim();

const MAX_CONTACTS = 1;

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

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '').trim()
  );
}

function bearerToken(event) {
  const header = event.headers?.authorization || event.headers?.Authorization || '';
  return /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() || '';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function inputClientId(event) {
  if (String(event.body || '').trim()) {
    throw httpError(400, 'unsupported_scope', 'Choose one Client profile.');
  }
  const query = event.queryStringParameters || {};
  const multi = event.multiValueQueryStringParameters || {};
  const queryKeys = Object.keys(query);
  const multiKeys = Object.keys(multi);
  if (
    queryKeys.length !== 1
    || queryKeys[0] !== 'id'
    || multiKeys.some(key => key !== 'id')
    || (Array.isArray(multi.id) && multi.id.length !== 1)
    || !validUuid(query.id)
  ) {
    throw httpError(400, 'unsupported_scope', 'Choose one valid Client profile.');
  }
  return String(query.id).trim().toLowerCase();
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
  if (!token) throw httpError(401, 'authentication_required', 'Sign in to view this Client profile.');
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw httpError(503, 'service_unavailable', 'The internal Client profile service is not configured yet.');
  }
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw httpError(401, 'authentication_required', 'Sign in again to view this Client profile.');
    }
    throw httpError(503, 'service_unavailable', 'The internal Client profile service is temporarily unavailable.');
  }
  const user = await response.json().catch(() => null);
  if (!validUuid(user?.id)) {
    throw httpError(401, 'authentication_required', 'Sign in again to view this Client profile.');
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
    return httpError(403, 'client_profile_forbidden', 'This portal account cannot view internal Client profiles.');
  }
  if (databaseCode === 'P0002') {
    return httpError(404, 'client_profile_not_found', 'The Client profile was not found.');
  }
  if (databaseCode === '22023' || databaseCode === '22P02') {
    return httpError(400, 'invalid_client', 'Choose a valid Client profile.');
  }
  if (databaseCode === 'PGRST202' || status === 404) {
    return httpError(503, 'service_unavailable', 'The internal Client profile service is not configured yet.');
  }
  return httpError(500, 'client_profile_service_error', 'The Client profile is temporarily unavailable.');
}

async function callProfileRpc(userId, clientId) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_internal_client_profile`, {
    method: 'POST',
    headers: serviceHeaders({ Accept: 'application/json', 'Content-Type': 'application/json' }),
    body: JSON.stringify({ p_actor_user_id: userId, p_client_id: clientId })
  });
  const payload = await responseJson(response);
  if (!response.ok) throw rpcError(response.status, payload);
  return payload;
}

function nullableText(value, maximum) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    throw httpError(502, 'client_profile_service_error', 'The Client profile returned an invalid response.');
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw httpError(502, 'client_profile_service_error', 'The Client profile returned an invalid response.');
  }
  return normalized;
}

function requiredText(value, maximum) {
  const normalized = nullableText(value, maximum);
  if (!normalized) {
    throw httpError(502, 'client_profile_service_error', 'The Client profile returned an invalid response.');
  }
  return normalized;
}

function nullableWebsite(value) {
  const normalized = nullableText(value, 2048);
  if (!normalized) return null;
  let parsed;
  try { parsed = new URL(normalized); } catch {
    throw httpError(502, 'client_profile_service_error', 'The Client profile returned an invalid response.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || !parsed.hostname) {
    throw httpError(502, 'client_profile_service_error', 'The Client profile returned an invalid response.');
  }
  return parsed.toString();
}

function publicContact(value) {
  if (!isPlainObject(value) || !validUuid(value.contactId)) {
    throw httpError(502, 'client_profile_service_error', 'The Client profile returned an invalid response.');
  }
  return {
    contactId: String(value.contactId).trim().toLowerCase(),
    fullName: requiredText(value.fullName, 120),
    email: nullableText(value.email, 254),
    phone: nullableText(value.phone, 40),
    contactRole: requiredText(value.contactRole, 80)
  };
}

function publicProfile(value) {
  if (!isPlainObject(value) || !validUuid(value.clientId) || !isPlainObject(value.company) || !Array.isArray(value.contacts)) {
    throw httpError(502, 'client_profile_service_error', 'The Client profile returned an invalid response.');
  }
  if (value.contacts.length > MAX_CONTACTS) {
    throw httpError(502, 'client_profile_service_error', 'The Client profile returned an invalid response.');
  }
  const contacts = value.contacts.map(publicContact);
  if (new Set(contacts.map(contact => contact.contactId)).size !== contacts.length) {
    throw httpError(502, 'client_profile_service_error', 'The Client profile returned an invalid response.');
  }
  return {
    clientId: String(value.clientId).trim().toLowerCase(),
    companyName: requiredText(value.companyName, 180),
    industry: nullableText(value.industry, 180),
    lifecycleStage: requiredText(value.lifecycleStage, 80),
    company: {
      addressLine1: nullableText(value.company.addressLine1, 160),
      addressLine2: nullableText(value.company.addressLine2, 160),
      city: nullableText(value.company.city, 100),
      stateRegion: nullableText(value.company.stateRegion, 100),
      postalCode: nullableText(value.company.postalCode, 24),
      country: nullableText(value.company.country, 100),
      phone: nullableText(value.company.phone, 40),
      website: nullableWebsite(value.company.website)
    },
    contacts
  };
}

async function handler(event) {
  if (String(event.httpMethod || '').toUpperCase() !== 'GET') {
    return json(405, { code: 'method_not_allowed', message: 'Method not allowed.' }, { Allow: 'GET' });
  }
  try {
    const clientId = inputClientId(event);
    const user = await authenticatedUser(event);
    const payload = await callProfileRpc(user.id, clientId);
    return json(200, { profile: publicProfile(payload) });
  } catch (error) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600
      ? error.status
      : 500;
    if (status >= 500) {
      console.error('Internal Client profile request failed.', {
        status,
        code: error.code || 'client_profile_request_failed'
      });
    }
    return json(status, {
      code: error.code || 'client_profile_request_failed',
      message: status >= 500 && !error.code
        ? 'The Client profile is temporarily unavailable.'
        : error.message
    });
  }
}

exports.handler = handler;
exports.MAX_CONTACTS = MAX_CONTACTS;
exports.inputClientId = inputClientId;
exports.nullableWebsite = nullableWebsite;
exports.publicContact = publicContact;
exports.publicProfile = publicProfile;
exports.validUuid = validUuid;
