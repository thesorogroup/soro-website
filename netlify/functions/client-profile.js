/* Scoped Client portal profile reads and self-service contact updates. */

const configuredUrl = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_URL = /^https:\/\/[^/]+\.supabase\.co\/?$/.test(configuredUrl)
  ? configuredUrl.replace(/\/$/, '')
  : '';
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

const CLIENT_ROLES = new Set(['client_admin', 'client_reviewer', 'client_billing']);
const CONTACT_FIELDS = Object.freeze({
  fullName: 'full_name',
  phone: 'phone'
});
const COMPANY_FIELDS = Object.freeze({
  addressLine1: 'address_line_1',
  addressLine2: 'address_line_2',
  city: 'city',
  stateRegion: 'state_region',
  postalCode: 'postal_code',
  country: 'country',
  phone: 'company_phone',
  website: 'website'
});
const CONTACT_EDITABLE_FIELDS = Object.freeze(['contact.fullName', 'contact.phone']);
const COMPANY_EDITABLE_FIELDS = Object.freeze(Object.keys(COMPANY_FIELDS).map(field => `company.${field}`));

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

function serviceHeaders(extra = {}) {
  const headers = { apikey: SERVICE_KEY, ...extra };
  if (SERVICE_KEY && !SERVICE_KEY.startsWith('sb_secret_')) headers.Authorization = `Bearer ${SERVICE_KEY}`;
  return headers;
}

async function serviceRequest(path, options = {}) {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw httpError(503, 'service_unavailable', 'The Client profile service is not configured yet.');
  }
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: serviceHeaders(options.headers || {})
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    let parsed = {};
    try { parsed = JSON.parse(detail); } catch { /* Keep the upstream detail private. */ }
    const error = httpError(response.status, 'profile_service_error', 'The Client profile could not be updated.');
    error.upstreamCode = parsed.code || '';
    throw error;
  }
  return response;
}

async function responseJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function bearerToken(event) {
  const header = event.headers?.authorization || event.headers?.Authorization || '';
  return /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() || '';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parsePatchBody(event) {
  if (Buffer.byteLength(event.body || '', 'utf8') > 20 * 1024) {
    throw httpError(413, 'request_too_large', 'The profile update is too large.');
  }
  let body;
  try { body = event.body ? JSON.parse(event.body) : {}; } catch {
    throw httpError(400, 'invalid_request', 'The profile update could not be read.');
  }
  if (!isPlainObject(body)) throw httpError(400, 'invalid_request', 'The profile update must be an object.');
  rejectUnknownKeys(body, ['contact', 'company'], 'The profile update contains a protected field.');
  if (body.contact !== undefined && !isPlainObject(body.contact)) {
    throw httpError(400, 'invalid_contact', 'Contact updates must be an object.');
  }
  if (body.company !== undefined && !isPlainObject(body.company)) {
    throw httpError(400, 'invalid_company', 'Company updates must be an object.');
  }
  return body;
}

function rejectUnknownKeys(value, allowedKeys, message) {
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some(key => !allowed.has(key))) {
    throw httpError(400, 'protected_field', message);
  }
}

function optionalText(value, label, { minimum = 0, maximum, nullable = true } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== 'string') throw httpError(400, 'invalid_field', `${label} must be text.`);
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized && nullable) return null;
  if (normalized.length < minimum || normalized.length > maximum) {
    const range = minimum ? `between ${minimum} and ${maximum}` : `no more than ${maximum}`;
    throw httpError(400, 'invalid_field', `${label} must be ${range} characters.`);
  }
  return normalized;
}

function normalizedWebsite(value) {
  const normalized = optionalText(value, 'Website', { maximum: 2048, nullable: true });
  if (!normalized) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(normalized) ? normalized : `https://${normalized}`;
  let url;
  try { url = new URL(withScheme); } catch {
    throw httpError(400, 'invalid_field', 'Enter a valid company website.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) {
    throw httpError(400, 'invalid_field', 'Enter a valid http or https company website.');
  }
  const result = url.toString();
  if (result.length > 2048) throw httpError(400, 'invalid_field', 'Website must be no more than 2048 characters.');
  return result;
}

function normalizePatch(body, role) {
  const contact = body.contact || {};
  const company = body.company || {};
  rejectUnknownKeys(contact, Object.keys(CONTACT_FIELDS), 'Only your name and phone can be changed here.');
  rejectUnknownKeys(company, Object.keys(COMPANY_FIELDS), 'The company update contains a protected field.');
  if (Object.keys(company).length && role !== 'client_admin') {
    throw httpError(403, 'company_edit_forbidden', 'Only a Client Administrator can update company contact details.');
  }

  const contactUpdates = {};
  const companyUpdates = {};
  if (Object.hasOwn(contact, 'fullName')) {
    contactUpdates.full_name = optionalText(contact.fullName, 'Full name', { minimum: 2, maximum: 120, nullable: false });
  }
  if (Object.hasOwn(contact, 'phone')) {
    contactUpdates.phone = optionalText(contact.phone, 'Phone', { minimum: 7, maximum: 40, nullable: true });
  }
  if (Object.hasOwn(company, 'addressLine1')) companyUpdates.address_line_1 = optionalText(company.addressLine1, 'Address line 1', { minimum: 2, maximum: 160, nullable: true });
  if (Object.hasOwn(company, 'addressLine2')) companyUpdates.address_line_2 = optionalText(company.addressLine2, 'Address line 2', { maximum: 160, nullable: true });
  if (Object.hasOwn(company, 'city')) companyUpdates.city = optionalText(company.city, 'City', { maximum: 100, nullable: true });
  if (Object.hasOwn(company, 'stateRegion')) companyUpdates.state_region = optionalText(company.stateRegion, 'State or region', { maximum: 100, nullable: true });
  if (Object.hasOwn(company, 'postalCode')) companyUpdates.postal_code = optionalText(company.postalCode, 'Postal code', { maximum: 24, nullable: true });
  if (Object.hasOwn(company, 'country')) companyUpdates.country = optionalText(company.country, 'Country', { minimum: 2, maximum: 100, nullable: true });
  if (Object.hasOwn(company, 'phone')) companyUpdates.company_phone = optionalText(company.phone, 'Company phone', { minimum: 7, maximum: 40, nullable: true });
  if (Object.hasOwn(company, 'website')) companyUpdates.website = normalizedWebsite(company.website);

  if (!Object.keys(contactUpdates).length && !Object.keys(companyUpdates).length) {
    throw httpError(400, 'no_changes', 'Choose at least one profile field to update.');
  }
  return { contactUpdates, companyUpdates };
}

async function authenticatedClient(event) {
  const token = bearerToken(event);
  if (!token) throw httpError(401, 'authentication_required', 'Sign in to view this Client profile.');
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw httpError(503, 'service_unavailable', 'The Client profile service is not configured yet.');
  }
  const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` }
  });
  if (!userResponse.ok) throw httpError(401, 'authentication_required', 'Sign in again to view this Client profile.');
  const user = await userResponse.json();
  if (!user?.id) throw httpError(401, 'authentication_required', 'Sign in again to view this Client profile.');

  const accessResponse = await serviceRequest(
    `/rest/v1/platform_users?id=eq.${encodeURIComponent(user.id)}&active=is.true&must_change_password=is.false&select=id,organization_id,role&limit=1`
  );
  const access = (await responseJson(accessResponse) || [])[0];
  if (!access || !CLIENT_ROLES.has(access.role)) {
    throw httpError(403, 'client_access_required', 'Active Client portal access is required.');
  }

  const membershipResponse = await serviceRequest(
    `/rest/v1/client_portal_memberships?user_id=eq.${encodeURIComponent(user.id)}&organization_id=eq.${encodeURIComponent(access.organization_id)}&active=is.true&select=user_id,organization_id,client_id,client_contact_id&limit=2`
  );
  const memberships = await responseJson(membershipResponse) || [];
  if (memberships.length !== 1) {
    throw httpError(404, 'client_membership_not_found', 'Your active Client profile is not connected yet. Contact a Soro Administrator.');
  }
  return { user, access, membership: memberships[0] };
}

async function loadSafeProfile(context) {
  const { access, membership } = context;
  const clientSelect = 'company_name,industry,address_line_1,address_line_2,city,state_region,postal_code,country,company_phone,website';
  const clientResponse = await serviceRequest(
    `/rest/v1/clients?id=eq.${encodeURIComponent(membership.client_id)}&organization_id=eq.${encodeURIComponent(access.organization_id)}&archived_at=is.null&select=${clientSelect}&limit=1`
  );
  const client = (await responseJson(clientResponse) || [])[0];
  if (!client) throw httpError(404, 'client_profile_not_found', 'The active Client profile could not be found.');

  const contactResponse = await serviceRequest(
    `/rest/v1/client_contacts?id=eq.${encodeURIComponent(membership.client_contact_id)}&client_id=eq.${encodeURIComponent(membership.client_id)}&active=is.true&select=full_name,phone&limit=1`
  );
  const contact = (await responseJson(contactResponse) || [])[0];
  if (!contact) throw httpError(404, 'client_contact_not_found', 'The active Client contact could not be found.');

  return {
    profile: {
      contact: {
        fullName: contact.full_name,
        phone: contact.phone
      },
      company: {
        name: client.company_name,
        industry: client.industry,
        addressLine1: client.address_line_1,
        addressLine2: client.address_line_2,
        city: client.city,
        stateRegion: client.state_region,
        postalCode: client.postal_code,
        country: client.country,
        phone: client.company_phone,
        website: client.website
      }
    },
    permissions: {
      canEditCompany: access.role === 'client_admin',
      editableFields: access.role === 'client_admin'
        ? [...CONTACT_EDITABLE_FIELDS, ...COMPANY_EDITABLE_FIELDS]
        : [...CONTACT_EDITABLE_FIELDS]
    }
  };
}

function translatedServiceError(error) {
  if (error.code && error.code !== 'profile_service_error') return error;
  if (error.upstreamCode === '42501') return httpError(403, 'profile_update_forbidden', 'This account cannot update those profile fields.');
  if (error.upstreamCode === 'P0002') return httpError(404, 'client_profile_not_found', 'The active Client profile could not be found.');
  if (['22023', '23514', '23503'].includes(error.upstreamCode)) return httpError(400, 'invalid_field', 'The profile update contains an invalid value.');
  return httpError(error.status === 503 ? 503 : 500, error.status === 503 ? 'service_unavailable' : 'profile_update_failed', error.status === 503 ? error.message : 'The Client profile could not be updated.');
}

async function handler(event) {
  const method = String(event.httpMethod || '').toUpperCase();
  if (!['GET', 'PATCH'].includes(method)) {
    return json(405, { code: 'method_not_allowed', message: 'Method not allowed.' }, { Allow: 'GET, PATCH' });
  }
  try {
    const context = await authenticatedClient(event);
    if (method === 'GET') return json(200, await loadSafeProfile(context));

    const body = parsePatchBody(event);
    const { contactUpdates, companyUpdates } = normalizePatch(body, context.access.role);
    const updateResponse = await serviceRequest('/rest/v1/rpc/update_client_portal_profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        p_actor_user_id: context.user.id,
        p_contact_updates: contactUpdates,
        p_company_updates: companyUpdates
      })
    });
    const changedFields = await responseJson(updateResponse);
    return json(200, {
      ...await loadSafeProfile(context),
      changedFields: Array.isArray(changedFields) ? changedFields : []
    });
  } catch (caught) {
    const error = translatedServiceError(caught);
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    if (status >= 500) console.error('Client profile request failed.', { status, code: error.code || 'profile_request_failed' });
    return json(status, {
      code: error.code || 'profile_request_failed',
      message: status >= 500 && !error.code ? 'The Client profile is temporarily unavailable.' : error.message
    });
  }
}

exports.handler = handler;
exports.CLIENT_ROLES = CLIENT_ROLES;
exports.CONTACT_FIELDS = CONTACT_FIELDS;
exports.COMPANY_FIELDS = COMPANY_FIELDS;
exports.normalizePatch = normalizePatch;
exports.parsePatchBody = parsePatchBody;
exports.loadSafeProfile = loadSafeProfile;
