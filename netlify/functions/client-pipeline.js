/* Organization-scoped Client intake and lifecycle service. */

const configuredUrl = String(process.env.SUPABASE_URL || '').trim();
const SUPABASE_URL = /^https:\/\/[^/]+\.supabase\.co\/?$/.test(configuredUrl)
  ? configuredUrl.replace(/\/$/, '')
  : '';
const SERVICE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || ''
).trim();

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_CLIENTS = 5000;
const MAX_CONTACTS_PER_CLIENT = 200;
const MAX_REQUESTS_PER_CLIENT = 500;
const MAX_ACTIVITY_PER_CLIENT = 100;
const VIEWER_ROLES = new Set(['admin', 'sales_management', 'sales', 'talent_management']);
const MUTATING_ROLES = new Set(['admin', 'sales_management', 'sales']);
const PORTAL_ACCESS_ACTIONS = new Set([
  'activate', 'resend_invitation', 'change_email', 'send_password_reset',
  'suspend_access', 'reactivate_access'
]);
const CLIENT_PORTAL_ROLES = new Set(['client_admin', 'client_reviewer', 'client_billing']);
const CLIENT_STAGES = new Set([
  'new_inquiry', 'discovery', 'qualified', 'matching', 'active', 'paused', 'lost', 'archived'
]);
const REQUEST_STATUSES = new Set([
  'draft', 'discovery', 'open', 'sourcing', 'shortlisting', 'client_review',
  'interviewing', 'selection_pending', 'placement_pending', 'partially_filled',
  'filled', 'on_hold', 'cancelled'
]);
const MANUAL_REQUEST_STATUSES = new Set(['discovery', 'open', 'sourcing', 'on_hold', 'cancelled']);
const ACTIONS = new Set([
  'create_client', 'update_client', 'set_client_stage', 'archive_client', 'assign_owner',
  'create_contact', 'update_contact', 'deactivate_contact', 'reactivate_contact',
  'create_request', 'update_request', 'set_request_status'
]);

const CLIENT_KEYS = new Set([
  'companyName', 'industry', 'addressLine1', 'addressLine2', 'city', 'stateRegion',
  'postalCode', 'country', 'companyPhone', 'website', 'salesOwnerId'
]);
const CONTACT_KEYS = new Set(['fullName', 'email', 'phone', 'contactRole']);
const REQUEST_KEYS = new Set([
  'title', 'status', 'startDate', 'numberOfTalent', 'budgetStatus', 'requiredFields'
]);
const ACTION_PAYLOAD_KEYS = Object.freeze({
  update_client: new Set([...CLIENT_KEYS].filter(key => key !== 'salesOwnerId')),
  set_client_stage: new Set(['stage']),
  assign_owner: new Set(['salesOwnerId']),
  create_contact: CONTACT_KEYS,
  update_contact: CONTACT_KEYS,
  create_request: REQUEST_KEYS,
  update_request: new Set([...REQUEST_KEYS].filter(key => key !== 'status')),
  set_request_status: new Set(['status'])
});
const ACTION_BODY_KEYS = Object.freeze({
  create_client: new Set(['action', 'requestId', 'client', 'primaryContact', 'firstRequest']),
  update_client: new Set(['action', 'requestId', 'expectedUpdatedAt', 'entityId', 'payload']),
  set_client_stage: new Set(['action', 'requestId', 'expectedUpdatedAt', 'entityId', 'payload']),
  archive_client: new Set(['action', 'requestId', 'expectedUpdatedAt', 'entityId']),
  assign_owner: new Set(['action', 'requestId', 'expectedUpdatedAt', 'entityId', 'payload']),
  create_contact: new Set(['action', 'requestId', 'expectedUpdatedAt', 'parentId', 'payload']),
  update_contact: new Set(['action', 'requestId', 'expectedUpdatedAt', 'entityId', 'payload']),
  deactivate_contact: new Set(['action', 'requestId', 'expectedUpdatedAt', 'entityId']),
  reactivate_contact: new Set(['action', 'requestId', 'expectedUpdatedAt', 'entityId']),
  create_request: new Set(['action', 'requestId', 'expectedUpdatedAt', 'parentId', 'payload']),
  update_request: new Set(['action', 'requestId', 'expectedUpdatedAt', 'entityId', 'payload']),
  set_request_status: new Set(['action', 'requestId', 'expectedUpdatedAt', 'entityId', 'payload'])
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
    headers: responseHeaders({ 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders }),
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

function hasOnlyKeys(value, allowed, { requireOne = false } = {}) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return (!requireOne || keys.length > 0) && keys.every(key => allowed.has(key));
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
    throw httpError(400, 'unsupported_scope', 'Client scope is determined by the signed-in account.');
  }
}

function rejectUnexpectedGetInput(event) {
  rejectQueryScope(event);
  if (String(event.body || '').trim()) {
    throw httpError(400, 'unsupported_scope', 'Client scope is determined by the signed-in account.');
  }
}

function inputUuid(value, label) {
  if (!validUuid(value)) throw httpError(400, 'invalid_request', `Choose a valid ${label}.`);
  return String(value).trim().toLowerCase();
}

function inputTimestamp(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 40 || !Number.isFinite(Date.parse(normalized))) {
    throw httpError(400, 'invalid_request', 'Reload the Client record and try again.');
  }
  return normalized;
}

function optionalText(value, label, maximum, minimum = 0) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw httpError(400, 'invalid_request', `${label} must be text.`);
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw httpError(400, 'invalid_request', `${label} must be between ${minimum} and ${maximum} characters.`);
  }
  return normalized;
}

function requiredText(value, label, maximum, minimum = 2) {
  const normalized = optionalText(value, label, maximum, minimum);
  if (!normalized) throw httpError(400, 'invalid_request', `${label} is required.`);
  return normalized;
}

function optionalEmail(value) {
  const normalized = optionalText(value, 'Email', 254, 3)?.toLowerCase() || null;
  if (normalized && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw httpError(400, 'invalid_request', 'Enter a valid email address.');
  }
  return normalized;
}

function optionalUrl(value) {
  const normalized = optionalText(value, 'Website', 2048, 8);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
  } catch {
    throw httpError(400, 'invalid_request', 'Enter a valid website beginning with http:// or https://.');
  }
  return normalized;
}

function optionalDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized) || !Number.isFinite(Date.parse(`${normalized}T00:00:00Z`))) {
    throw httpError(400, 'invalid_request', 'Choose a valid start date.');
  }
  return normalized;
}

function inputClient(value, { creating = false } = {}) {
  if (!hasOnlyKeys(value, CLIENT_KEYS, { requireOne: !creating })) {
    throw httpError(400, 'unsupported_scope', 'Only approved Client profile fields are accepted.');
  }
  const result = {};
  if (creating || Object.hasOwn(value, 'companyName')) result.companyName = requiredText(value.companyName, 'Company name', 160);
  const fields = [
    ['industry', 'Industry', 120], ['addressLine1', 'Address line 1', 160],
    ['addressLine2', 'Address line 2', 160], ['city', 'City', 100],
    ['stateRegion', 'State or region', 100], ['postalCode', 'Postal code', 24],
    ['country', 'Country', 100], ['companyPhone', 'Company phone', 40]
  ];
  for (const [key, label, maximum] of fields) {
    if (Object.hasOwn(value, key)) result[key] = optionalText(value[key], label, maximum);
  }
  if (Object.hasOwn(value, 'website')) result.website = optionalUrl(value.website);
  if (Object.hasOwn(value, 'salesOwnerId')) {
    result.salesOwnerId = value.salesOwnerId === null || value.salesOwnerId === ''
      ? null
      : inputUuid(value.salesOwnerId, 'Sales owner');
  }
  return result;
}

function inputContact(value, { creating = false } = {}) {
  if (!hasOnlyKeys(value, CONTACT_KEYS, { requireOne: !creating })) {
    throw httpError(400, 'unsupported_scope', 'Only approved Client contact fields are accepted.');
  }
  const result = {};
  if (creating || Object.hasOwn(value, 'fullName')) result.fullName = requiredText(value.fullName, 'Contact name', 120);
  if (Object.hasOwn(value, 'email')) result.email = optionalEmail(value.email);
  if (Object.hasOwn(value, 'phone')) result.phone = optionalText(value.phone, 'Phone', 40);
  if (creating || Object.hasOwn(value, 'contactRole')) {
    result.contactRole = creating && !String(value.contactRole || '').trim()
      ? 'Primary contact'
      : requiredText(value.contactRole, 'Contact role', 120, 1);
  }
  return result;
}

function inputRequest(value, { creating = false, statusAllowed = true } = {}) {
  const allowed = statusAllowed ? REQUEST_KEYS : new Set([...REQUEST_KEYS].filter(key => key !== 'status'));
  if (!hasOnlyKeys(value, allowed, { requireOne: !creating })) {
    throw httpError(400, 'unsupported_scope', 'Only approved hiring request fields are accepted.');
  }
  const result = {};
  if (creating || Object.hasOwn(value, 'title')) result.title = requiredText(value.title, 'Hiring request title', 160);
  if (Object.hasOwn(value, 'status')) {
    const status = String(value.status || '').trim().toLowerCase();
    if (!REQUEST_STATUSES.has(status)) throw httpError(400, 'invalid_request', 'Choose a valid hiring request status.');
    result.status = status;
  }
  if (Object.hasOwn(value, 'startDate')) result.startDate = optionalDate(value.startDate);
  if (Object.hasOwn(value, 'numberOfTalent')) {
    const number = Number(value.numberOfTalent);
    if (!Number.isInteger(number) || number < 1 || number > 100) {
      throw httpError(400, 'invalid_request', 'Number of Talent must be between 1 and 100.');
    }
    result.numberOfTalent = number;
  }
  if (Object.hasOwn(value, 'budgetStatus')) result.budgetStatus = requiredText(value.budgetStatus, 'Budget status', 80, 1);
  if (Object.hasOwn(value, 'requiredFields')) {
    if (!isPlainObject(value.requiredFields) || Buffer.byteLength(JSON.stringify(value.requiredFields), 'utf8') > 8 * 1024) {
      throw httpError(400, 'invalid_request', 'Hiring request requirements must be a small JSON object.');
    }
    result.requiredFields = value.requiredFields;
  }
  return result;
}

function parseBody(event) {
  if (Buffer.byteLength(event.body || '', 'utf8') > MAX_REQUEST_BYTES) {
    throw httpError(413, 'request_too_large', 'The Client request is too large.');
  }
  let body;
  try { body = event.body ? JSON.parse(event.body) : {}; } catch {
    throw httpError(400, 'invalid_request', 'The Client request could not be read.');
  }
  if (!isPlainObject(body)) throw httpError(400, 'invalid_request', 'The Client request must be a JSON object.');
  return body;
}

function inputActionBody(body) {
  const action = String(body?.action || '').trim().toLowerCase();
  if (!ACTIONS.has(action)) throw httpError(400, 'unsupported_action', 'Choose a supported Client action.');
  if (!hasExactKeys(body, ACTION_BODY_KEYS[action])) {
    throw httpError(400, 'unsupported_scope', 'Only the fields required for this Client action are accepted.');
  }
  const input = {
    action,
    requestId: inputUuid(body.requestId, 'request id'),
    expectedUpdatedAt: null,
    entityId: null,
    parentId: null,
    payload: {}
  };
  if (action === 'create_client') {
    input.payload = {
      client: inputClient(body.client, { creating: true }),
      primaryContact: inputContact(body.primaryContact, { creating: true }),
      firstRequest: inputRequest(body.firstRequest, { creating: true })
    };
    if (input.payload.firstRequest.status && !['draft', 'discovery'].includes(input.payload.firstRequest.status)) {
      throw httpError(400, 'invalid_request', 'The first hiring request must begin in Draft or Discovery.');
    }
    return input;
  }

  input.expectedUpdatedAt = inputTimestamp(body.expectedUpdatedAt);
  if (Object.hasOwn(body, 'entityId')) input.entityId = inputUuid(body.entityId, 'record');
  if (Object.hasOwn(body, 'parentId')) input.parentId = inputUuid(body.parentId, 'Client');
  if (!Object.hasOwn(body, 'payload')) return input;

  if (!hasOnlyKeys(body.payload, ACTION_PAYLOAD_KEYS[action], { requireOne: true })) {
    throw httpError(400, 'unsupported_scope', 'Only the fields required for this Client action are accepted.');
  }
  if (action === 'update_client') input.payload = inputClient(body.payload);
  else if (action === 'set_client_stage') {
    const stage = String(body.payload.stage || '').trim().toLowerCase();
    if (!CLIENT_STAGES.has(stage) || ['active', 'archived'].includes(stage)) {
      throw httpError(400, 'invalid_request', 'Choose a valid active Client lifecycle stage.');
    }
    input.payload = { stage };
  } else if (action === 'assign_owner') {
    input.payload = {
      salesOwnerId: body.payload.salesOwnerId === null || body.payload.salesOwnerId === ''
        ? null
        : inputUuid(body.payload.salesOwnerId, 'Sales owner')
    };
  } else if (action === 'create_contact') input.payload = inputContact(body.payload, { creating: true });
  else if (action === 'update_contact') input.payload = inputContact(body.payload);
  else if (action === 'create_request') {
    input.payload = inputRequest(body.payload, { creating: true });
    if (input.payload.status && !['draft', 'discovery'].includes(input.payload.status)) {
      throw httpError(400, 'invalid_request', 'A new hiring request must begin in Draft or Discovery.');
    }
  } else if (action === 'update_request') input.payload = inputRequest(body.payload, { statusAllowed: false });
  else {
    const status = String(body.payload.status || '').trim().toLowerCase();
    if (!MANUAL_REQUEST_STATUSES.has(status)) {
      throw httpError(400, 'invalid_request', 'That hiring request state is controlled by the shortlist, interview, or placement workflow.');
    }
    input.payload = { status };
  }
  return input;
}

function serviceHeaders(extra = {}) {
  const headers = { apikey: SERVICE_KEY, ...extra };
  if (SERVICE_KEY && !SERVICE_KEY.startsWith('sb_secret_')) headers.Authorization = `Bearer ${SERVICE_KEY}`;
  return headers;
}

async function authenticatedUser(event) {
  const token = bearerToken(event);
  if (!token) throw httpError(401, 'authentication_required', 'Sign in to manage Clients.');
  if (!SUPABASE_URL || !SERVICE_KEY) throw httpError(503, 'service_unavailable', 'Client management is not configured yet.');
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    if ([401, 403].includes(response.status)) throw httpError(401, 'authentication_required', 'Sign in again to manage Clients.');
    throw httpError(503, 'service_unavailable', 'Client management is temporarily unavailable.');
  }
  const user = await response.json().catch(() => null);
  if (!validUuid(user?.id)) throw httpError(401, 'authentication_required', 'Sign in again to manage Clients.');
  return user;
}

async function responseJson(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function rpcError(status, payload) {
  const code = String(payload?.code || '');
  const message = String(payload?.message || '');
  if (code === '42501') return httpError(403, 'client_forbidden', 'This account cannot perform that Client action.');
  if (code === '22023' || code === '22P02' || code === '22007') return httpError(400, 'invalid_request', 'Check the Client details and try again.');
  if (code === '23505') return httpError(409, 'duplicate_request', 'This request was already used or the Client data conflicts with an existing record.');
  if (code === '23503' || code === '23514') return httpError(409, 'client_conflict', 'The Client data conflicts with another active record.');
  if (code === 'P0001') return httpError(409, 'stale_client', 'The Client changed. Reload it and try again.');
  // PostgreSQL undefined-function errors also use HTTP 404. Only a missing
  // RPC (or a bare missing endpoint) means the Client workflow is unconfigured.
  if (code === 'PGRST202' || (status === 404 && !code)) return httpError(503, 'service_unavailable', 'Client management is not configured yet.');
  return httpError(500, 'client_service_error', 'Client management is temporarily unavailable.');
}

async function callRpc(name, body) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: serviceHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
    body: JSON.stringify(body)
  });
  const payload = await responseJson(response);
  if (!response.ok) throw rpcError(response.status, payload);
  return payload;
}

function textOutput(value, maximum, nullable = true) {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || value.length > maximum) throw httpError(502, 'client_service_error', 'Client management returned an invalid response.');
  return value;
}

function uuidOutput(value, nullable = false) {
  if ((value === null || value === undefined) && nullable) return null;
  if (!validUuid(value)) throw httpError(502, 'client_service_error', 'Client management returned an invalid response.');
  return String(value).toLowerCase();
}

function timestampOutput(value, nullable = false) {
  if ((value === null || value === undefined) && nullable) return null;
  const normalized = String(value || '');
  if (!normalized || !Number.isFinite(Date.parse(normalized))) throw httpError(502, 'client_service_error', 'Client management returned an invalid response.');
  return normalized;
}

function publicPendingPortalAccess(value, viewerRole) {
  if (value === null) return null;
  if (!MUTATING_ROLES.has(viewerRole)
    || !hasExactKeys(value, new Set(['action', 'email', 'portalRole']))) {
    throw httpError(502, 'client_service_error', 'Client management returned an invalid response.');
  }
  const action = textOutput(value.action, 40, false);
  const email = textOutput(value.email, 254);
  const portalRole = textOutput(value.portalRole, 40);
  const emailValid = typeof email === 'string'
    && email === email.trim().toLowerCase()
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!PORTAL_ACCESS_ACTIONS.has(action)
    || (action === 'activate' && (!emailValid || !CLIENT_PORTAL_ROLES.has(portalRole)))
    || (action === 'change_email' && (!emailValid || portalRole !== null))
    || (!['activate', 'change_email'].includes(action) && (email !== null || portalRole !== null))) {
    throw httpError(502, 'client_service_error', 'Client management returned an invalid response.');
  }
  return { action, email, portalRole };
}

function publicContact(value, viewerRole) {
  if (!isPlainObject(value)) throw httpError(502, 'client_service_error', 'Client management returned an invalid response.');
  const status = textOutput(value.portalAccessStatus, 40, false);
  if (!new Set(['not_invited', 'invite_pending', 'active', 'suspended', 'delivery_failed', 'needs_reconciliation']).has(status)
    || typeof value.isPrimary !== 'boolean'
    || !Object.hasOwn(value, 'pendingPortalAccess')) {
    throw httpError(502, 'client_service_error', 'Client management returned an invalid response.');
  }
  return {
    contactId: uuidOutput(value.contactId), fullName: textOutput(value.fullName, 120, false),
    email: textOutput(value.email, 254), phone: textOutput(value.phone, 40),
    contactRole: textOutput(value.contactRole, 120, false), isPrimary: value.isPrimary, active: value.active === true,
    portalLoginEmail: textOutput(value.portalLoginEmail, 254), portalAccessStatus: status,
    portalInviteSentAt: timestampOutput(value.portalInviteSentAt, true),
    portalAccessActivatedAt: timestampOutput(value.portalAccessActivatedAt, true),
    pendingPortalAccess: publicPendingPortalAccess(value.pendingPortalAccess, viewerRole),
    createdAt: timestampOutput(value.createdAt), updatedAt: timestampOutput(value.updatedAt)
  };
}

function publicRequest(value) {
  if (!isPlainObject(value)) throw httpError(502, 'client_service_error', 'Client management returned an invalid response.');
  const status = textOutput(value.status, 40, false);
  if (!REQUEST_STATUSES.has(status) || !isPlainObject(value.requiredFields)) throw httpError(502, 'client_service_error', 'Client management returned an invalid response.');
  return {
    hiringRequestId: uuidOutput(value.hiringRequestId), title: textOutput(value.title, 160, false), status,
    startDate: textOutput(value.startDate, 10), numberOfTalent: Number(value.numberOfTalent),
    budgetStatus: textOutput(value.budgetStatus, 80, false), requiredFields: value.requiredFields,
    createdAt: timestampOutput(value.createdAt), updatedAt: timestampOutput(value.updatedAt)
  };
}

function publicActivity(value) {
  if (!hasExactKeys(value, new Set(['eventType', 'label', 'createdAt']))) {
    throw httpError(502, 'client_service_error', 'Client management returned an invalid response.');
  }
  return {
    eventType: textOutput(value.eventType, 120, false),
    label: textOutput(value.label, 160, false),
    createdAt: timestampOutput(value.createdAt)
  };
}

function publicClient(value, viewerRole) {
  if (!isPlainObject(value) || !Array.isArray(value.contacts) || !Array.isArray(value.hiringRequests)
    || !Array.isArray(value.activity) || value.contacts.length > MAX_CONTACTS_PER_CLIENT
    || value.hiringRequests.length > MAX_REQUESTS_PER_CLIENT || value.activity.length > MAX_ACTIVITY_PER_CLIENT) {
    throw httpError(502, 'client_service_error', 'Client management returned an invalid response.');
  }
  const stage = textOutput(value.lifecycleStage, 40, false);
  if (!CLIENT_STAGES.has(stage) || typeof value.canEdit !== 'boolean') throw httpError(502, 'client_service_error', 'Client management returned an invalid response.');
  if (value.canEdit !== MUTATING_ROLES.has(viewerRole)) throw httpError(502, 'client_service_error', 'Client management returned an invalid response.');
  return {
    clientId: uuidOutput(value.clientId), companyName: textOutput(value.companyName, 160, false),
    industry: textOutput(value.industry, 120), lifecycleStage: stage,
    salesOwnerId: uuidOutput(value.salesOwnerId, true), addressLine1: textOutput(value.addressLine1, 160),
    addressLine2: textOutput(value.addressLine2, 160), city: textOutput(value.city, 100),
    stateRegion: textOutput(value.stateRegion, 100), postalCode: textOutput(value.postalCode, 24),
    country: textOutput(value.country, 100), companyPhone: textOutput(value.companyPhone, 40),
    website: textOutput(value.website, 2048), archivedAt: timestampOutput(value.archivedAt, true),
    createdAt: timestampOutput(value.createdAt), updatedAt: timestampOutput(value.updatedAt),
    canEdit: value.canEdit, activity: value.activity.map(publicActivity),
    contacts: value.contacts.map(contact => publicContact(contact, viewerRole)), hiringRequests: value.hiringRequests.map(publicRequest)
  };
}

function publicPayload(value) {
  if (!isPlainObject(value) || !Array.isArray(value.clients) || !Array.isArray(value.salesOwners)
    || value.clients.length > MAX_CLIENTS || value.salesOwners.length > 1000) {
    throw httpError(502, 'client_service_error', 'Client management returned an invalid response.');
  }
  const viewerRole = textOutput(value.viewerRole, 40, false);
  if (!VIEWER_ROLES.has(viewerRole)) throw httpError(502, 'client_service_error', 'Client management returned an invalid response.');
  if (!['admin', 'sales_management'].includes(viewerRole) && value.salesOwners.length) {
    throw httpError(502, 'client_service_error', 'Client management returned an invalid response.');
  }
  const clients = value.clients.map(client => publicClient(client, viewerRole));
  const salesOwners = value.salesOwners.map(owner => ({
    userId: uuidOutput(owner.userId), displayName: textOutput(owner.displayName, 160, false)
  }));
  return { generatedAt: timestampOutput(value.generatedAt), viewerRole, clients, salesOwners };
}

function publicMutationResult(value, action) {
  if (!isPlainObject(value) || value.action !== action) throw httpError(502, 'client_service_error', 'Client management returned an invalid response.');
  const allowed = new Set(['action', 'clientId', 'contactId', 'hiringRequestId', 'updatedAt', 'clientUpdatedAt', 'contactUpdatedAt', 'hiringRequestUpdatedAt']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw httpError(502, 'client_service_error', 'Client management returned an invalid response.');
  const result = { action };
  for (const key of ['clientId', 'contactId', 'hiringRequestId']) if (Object.hasOwn(value, key)) result[key] = uuidOutput(value[key]);
  for (const key of ['updatedAt', 'clientUpdatedAt', 'contactUpdatedAt', 'hiringRequestUpdatedAt']) {
    if (Object.hasOwn(value, key)) result[key] = timestampOutput(value[key]);
  }
  return result;
}

async function getWorkspace(event) {
  rejectUnexpectedGetInput(event);
  const user = await authenticatedUser(event);
  return json(200, publicPayload(await callRpc('get_client_pipeline_workspace', { p_actor_user_id: user.id })));
}

async function changeWorkspace(event) {
  rejectQueryScope(event);
  const input = inputActionBody(parseBody(event));
  const user = await authenticatedUser(event);
  const payload = await callRpc('change_client_pipeline', {
    p_actor_user_id: user.id,
    p_request_id: input.requestId,
    p_action: input.action,
    p_expected_updated_at: input.expectedUpdatedAt,
    p_entity_id: input.entityId,
    p_parent_id: input.parentId,
    p_payload: input.payload
  });
  return json(200, publicMutationResult(payload, input.action));
}

async function handler(event) {
  const method = String(event.httpMethod || '').toUpperCase();
  if (!['GET', 'POST'].includes(method)) return json(405, { code: 'method_not_allowed', message: 'Method not allowed.' }, { Allow: 'GET, POST' });
  try {
    return method === 'GET' ? await getWorkspace(event) : await changeWorkspace(event);
  } catch (error) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    const hasSafeCode = /^[a-z][a-z0-9_]{2,64}$/.test(String(error?.code || ''));
    const code = hasSafeCode ? String(error.code) : 'client_service_error';
    console.error('Client pipeline operation failed.', { method, status, code });
    return json(status, {
      code,
      message: status >= 500 && code !== 'service_unavailable'
        ? 'Client management is temporarily unavailable. Please try again.'
        : hasSafeCode
          ? error.message
          : 'The Client request could not be completed. Please try again.'
    });
  }
}

exports.handler = handler;
exports.ACTIONS = ACTIONS;
exports.ACTION_BODY_KEYS = ACTION_BODY_KEYS;
exports.CLIENT_STAGES = CLIENT_STAGES;
exports.MAX_ACTIVITY_PER_CLIENT = MAX_ACTIVITY_PER_CLIENT;
exports.MANUAL_REQUEST_STATUSES = MANUAL_REQUEST_STATUSES;
exports.MUTATING_ROLES = MUTATING_ROLES;
exports.REQUEST_STATUSES = REQUEST_STATUSES;
exports.VIEWER_ROLES = VIEWER_ROLES;
exports.hasExactKeys = hasExactKeys;
exports.inputActionBody = inputActionBody;
exports.publicActivity = publicActivity;
exports.publicMutationResult = publicMutationResult;
exports.publicPayload = publicPayload;
exports.validUuid = validUuid;
