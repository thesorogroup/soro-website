/* Safe read-only Talent matching profiles for authenticated Soro employees. */

const configuredUrl = String(process.env.SUPABASE_URL || '').trim();
const SUPABASE_URL = /^https:\/\/[^/]+\.supabase\.co\/?$/.test(configuredUrl)
  ? configuredUrl.replace(/\/$/, '')
  : '';
const SERVICE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || ''
).trim();

const MAX_LIST_ITEMS = 100;

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

function inputTalentId(event) {
  if (String(event.body || '').trim()) {
    throw httpError(400, 'unsupported_scope', 'Choose one Talent profile.');
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
    throw httpError(400, 'unsupported_scope', 'Choose one valid Talent profile.');
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
  if (!token) throw httpError(401, 'authentication_required', 'Sign in to view this Talent profile.');
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw httpError(503, 'service_unavailable', 'The internal Talent profile service is not configured yet.');
  }
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw httpError(401, 'authentication_required', 'Sign in again to view this Talent profile.');
    }
    throw httpError(503, 'service_unavailable', 'The internal Talent profile service is temporarily unavailable.');
  }
  const user = await response.json().catch(() => null);
  if (!validUuid(user?.id)) {
    throw httpError(401, 'authentication_required', 'Sign in again to view this Talent profile.');
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
    return httpError(403, 'talent_profile_forbidden', 'This portal account cannot view internal Talent profiles.');
  }
  if (databaseCode === 'P0002') {
    return httpError(404, 'talent_profile_not_found', 'The Talent profile was not found.');
  }
  if (databaseCode === '22023' || databaseCode === '22P02') {
    return httpError(400, 'invalid_talent', 'Choose a valid Talent profile.');
  }
  if (databaseCode === 'PGRST202' || status === 404) {
    return httpError(503, 'service_unavailable', 'The internal Talent profile service is not configured yet.');
  }
  return httpError(500, 'talent_profile_service_error', 'The Talent profile is temporarily unavailable.');
}

async function callProfileRpc(userId, applicantId) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_internal_talent_profile`, {
    method: 'POST',
    headers: serviceHeaders({ Accept: 'application/json', 'Content-Type': 'application/json' }),
    body: JSON.stringify({ p_actor_user_id: userId, p_applicant_id: applicantId })
  });
  const payload = await responseJson(response);
  if (!response.ok) throw rpcError(response.status, payload);
  return payload;
}

function profileError() {
  return httpError(502, 'talent_profile_service_error', 'The Talent profile returned an invalid response.');
}

function nullableText(value, maximum) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw profileError();
  const normalized = value.trim();
  if (
    !normalized
    || normalized.length > maximum
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)
  ) {
    throw profileError();
  }
  return normalized;
}

function requiredText(value, maximum) {
  const normalized = nullableText(value, maximum);
  if (!normalized) throw profileError();
  return normalized;
}

function nullableTimestamp(value) {
  const normalized = nullableText(value, 64);
  if (!normalized) return null;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(normalized) || !Number.isFinite(Date.parse(normalized))) {
    throw profileError();
  }
  return normalized;
}

function nullableNumber(value, minimum, maximum) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw profileError();
  return number;
}

function textList(value, itemMaximum = 180) {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) throw profileError();
  const normalized = value.map(item => requiredText(item, itemMaximum));
  if (new Set(normalized.map(item => item.toLocaleLowerCase('en-US'))).size !== normalized.length) {
    throw profileError();
  }
  return normalized;
}

function publicTalent(value) {
  if (!isPlainObject(value) || !validUuid(value.id)) throw profileError();
  return {
    id: String(value.id).trim().toLowerCase(),
    full_name: requiredText(value.full_name, 160),
    preferred_name: nullableText(value.preferred_name, 120),
    country: nullableText(value.country, 100),
    timezone: nullableText(value.timezone, 100),
    status: requiredText(value.status, 80),
    work_status: nullableText(value.work_status, 120),
    availability_note: nullableText(value.availability_note, 1000),
    application_received_at: nullableTimestamp(value.application_received_at),
    expected_hourly_rate_text: nullableText(value.expected_hourly_rate_text, 240),
    verified_skills: textList(value.verified_skills),
    self_reported_experience_areas: textList(value.self_reported_experience_areas),
    self_reported_skills: textList(value.self_reported_skills),
    other_experience_specialty: nullableText(value.other_experience_specialty, 500),
    relevant_experience_years: nullableNumber(value.relevant_experience_years, 0, 100),
    relevant_experience_summary: nullableText(value.relevant_experience_summary, 12000),
    education_training_summary: nullableText(value.education_training_summary, 12000),
    english_test_result: nullableText(value.english_test_result, 2000),
    personality_profile_score: nullableText(value.personality_profile_score, 4000),
    computer_specs: nullableText(value.computer_specs, 4000),
    internet_speed: nullableText(value.internet_speed, 2000)
  };
}

async function handler(event) {
  if (String(event.httpMethod || '').toUpperCase() !== 'GET') {
    return json(405, { code: 'method_not_allowed', message: 'Method not allowed.' }, { Allow: 'GET' });
  }
  try {
    const applicantId = inputTalentId(event);
    const user = await authenticatedUser(event);
    const payload = await callProfileRpc(user.id, applicantId);
    return json(200, { talent: publicTalent(payload) });
  } catch (error) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600
      ? error.status
      : 500;
    if (status >= 500) {
      console.error('Internal Talent profile request failed.', {
        status,
        code: error.code || 'talent_profile_request_failed'
      });
    }
    return json(status, {
      code: error.code || 'talent_profile_request_failed',
      message: status >= 500 && !error.code
        ? 'The Talent profile is temporarily unavailable.'
        : error.message
    });
  }
}

exports.handler = handler;
exports.MAX_LIST_ITEMS = MAX_LIST_ITEMS;
exports.inputTalentId = inputTalentId;
exports.publicTalent = publicTalent;
exports.textList = textList;
exports.validUuid = validUuid;
