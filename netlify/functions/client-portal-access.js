/* Secure Admin/Sales lifecycle controls for Client portal accounts. */

const crypto = require('node:crypto');
const {accessEmail} = require('./lib/branded-email');

const configuredUrl = String(process.env.SUPABASE_URL || '').trim();
const SUPABASE_URL = /^https:\/\/[^/]+\.supabase\.co\/?$/.test(configuredUrl)
  ? configuredUrl.replace(/\/$/, '')
  : '';
const SERVICE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || ''
).trim();
const RESEND_API_KEY = String(process.env.RESEND_API_KEY || '').trim();
const FROM_EMAIL = String(
  process.env.CLIENT_ACCESS_FROM_EMAIL || process.env.APPLICATION_FROM_EMAIL || ''
).trim();
const PORTAL_URL = normalizedPortalUrl(
  process.env.CLIENT_PORTAL_URL ||
  process.env.APPLICATION_PORTAL_URL ||
  'https://thesorogroup.com/operations/?accountSetup=1'
);

const MAX_REQUEST_BYTES = 4 * 1024;
const EMAIL_COOLDOWN_MS = 60 * 1000;
const RESEND_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
const EMAIL_RETRY_SAFETY_MARGIN_MS = 5 * 60 * 1000;
const RESEND_IDEMPOTENCY_REFRESH_MS = RESEND_IDEMPOTENCY_WINDOW_MS + EMAIL_RETRY_SAFETY_MARGIN_MS;
const AUTH_LINK_TTL_SECONDS = boundedInteger(process.env.CLIENT_ACCESS_LINK_TTL_SECONDS, 600, 24 * 60 * 60);
const AUTH_LINK_TTL_MS = AUTH_LINK_TTL_SECONDS === null ? null : AUTH_LINK_TTL_SECONDS * 1000;
const EMAIL_IDEMPOTENCY_RETRY_MS = AUTH_LINK_TTL_MS === null ? 0 : Math.min(
  RESEND_IDEMPOTENCY_WINDOW_MS - (60 * 60 * 1000),
  AUTH_LINK_TTL_MS - EMAIL_RETRY_SAFETY_MARGIN_MS
);
const MANAGER_ROLES = new Set(['admin', 'sales_management', 'sales']);
const CLIENT_ROLES = new Set(['client_admin', 'client_reviewer', 'client_billing']);
const PORTAL_STATUSES = new Set(['not_invited', 'invite_pending', 'active', 'suspended', 'delivery_failed', 'needs_reconciliation']);
const ACTIONS = new Set([
  'activate', 'resend_invitation', 'change_email', 'send_password_reset',
  'suspend_access', 'reactivate_access'
]);
const ACTION_BODY_KEYS = Object.freeze({
  activate: new Set(['action', 'requestId', 'contactId', 'email', 'portalRole']),
  resend_invitation: new Set(['action', 'requestId', 'contactId']),
  change_email: new Set(['action', 'requestId', 'contactId', 'email']),
  send_password_reset: new Set(['action', 'requestId', 'contactId']),
  suspend_access: new Set(['action', 'requestId', 'contactId']),
  reactivate_access: new Set(['action', 'requestId', 'contactId'])
});

function boundedInteger(value, minimum, maximum) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function normalizedPortalUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error();
    return url.toString();
  } catch {
    return 'https://thesorogroup.com/operations/?accountSetup=1';
  }
}

function responseHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store', Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    Vary: 'Authorization', ...extra
  };
}

function json(statusCode, body, extra = {}) {
  return {
    statusCode,
    headers: responseHeaders({ 'Content-Type': 'application/json; charset=utf-8', ...extra }),
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

function normalizedEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validEmail(value) {
  return value.length >= 3 && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function bearerToken(event) {
  const header = event.headers?.authorization || event.headers?.Authorization || '';
  return /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() || '';
}

function jwtPayload(token) {
  try { return JSON.parse(Buffer.from(String(token || '').split('.')[1], 'base64url').toString('utf8')); } catch { return {}; }
}

function tokenPasswordAuthenticatedRecently(token, maximumAgeSeconds = 300) {
  const payload = jwtPayload(token);
  const timestamps = Array.isArray(payload.amr)
    ? payload.amr.filter(item => item?.method === 'password').map(item => Number(item.timestamp)).filter(Number.isFinite)
    : [];
  const authenticatedAt = timestamps.length ? Math.max(...timestamps) : Number.NaN;
  const now = Math.floor(Date.now() / 1000);
  return Number.isFinite(authenticatedAt) && authenticatedAt <= now + 30 && now - authenticatedAt <= maximumAgeSeconds;
}

function parseBody(event) {
  if (Buffer.byteLength(event.body || '', 'utf8') > MAX_REQUEST_BYTES) {
    throw httpError(413, 'request_too_large', 'The Client access request is too large.');
  }
  let body;
  try { body = event.body ? JSON.parse(event.body) : {}; } catch {
    throw httpError(400, 'invalid_request', 'The Client access request could not be read.');
  }
  if (!isPlainObject(body)) throw httpError(400, 'invalid_request', 'The Client access request must be a JSON object.');
  return body;
}

function inputActionBody(body) {
  const action = String(body?.action || '').trim().toLowerCase();
  if (!ACTIONS.has(action)) throw httpError(400, 'unsupported_action', 'Choose a supported Client portal access action.');
  if (!hasExactKeys(body, ACTION_BODY_KEYS[action])) {
    throw httpError(400, 'unsupported_scope', 'Only the fields required for this Client access action are accepted.');
  }
  if (!validUuid(body.requestId) || !validUuid(body.contactId)) {
    throw httpError(400, 'invalid_request', 'Choose a valid Client contact and request id.');
  }
  const input = {
    action,
    requestId: String(body.requestId).toLowerCase(),
    contactId: String(body.contactId).toLowerCase(),
    email: null,
    portalRole: null
  };
  if (Object.hasOwn(body, 'email')) {
    input.email = normalizedEmail(body.email);
    if (!validEmail(input.email)) throw httpError(400, 'invalid_email', 'Enter a valid Client portal login email.');
  }
  if (Object.hasOwn(body, 'portalRole')) {
    input.portalRole = String(body.portalRole || '').trim().toLowerCase();
    if (!CLIENT_ROLES.has(input.portalRole)) throw httpError(400, 'invalid_role', 'Choose Client Administrator, Reviewer, or Billing.');
  }
  return input;
}

function inputStatusQuery(event) {
  if (String(event.body || '').trim()) throw httpError(400, 'unsupported_scope', 'Status accepts only one Client contact.');
  const query = event.queryStringParameters || {};
  const multi = event.multiValueQueryStringParameters || {};
  if (!hasExactKeys(query, new Set(['contactId'])) || Object.keys(multi).some(key => key !== 'contactId')
    || (Array.isArray(multi.contactId) && multi.contactId.length > 1)
    || !validUuid(query.contactId)) {
    throw httpError(400, 'unsupported_scope', 'Status accepts only one valid Client contact id.');
  }
  return String(query.contactId).toLowerCase();
}

function rejectPostQuery(event) {
  const query = event.queryStringParameters || {};
  const multi = event.multiValueQueryStringParameters || {};
  if (Object.keys(query).length || Object.keys(multi).length || String(event.rawQueryString || '').trim()) {
    throw httpError(400, 'unsupported_scope', 'Client access scope is determined by the request body and signed-in account.');
  }
}

function serviceHeaders(extra = {}) {
  const headers = { apikey: SERVICE_KEY, ...extra };
  if (SERVICE_KEY && !SERVICE_KEY.startsWith('sb_secret_')) headers.Authorization = `Bearer ${SERVICE_KEY}`;
  return headers;
}

async function serviceRequest(path, options = {}) {
  if (!SUPABASE_URL || !SERVICE_KEY) throw httpError(503, 'service_unavailable', 'Client portal access is not configured yet.');
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: serviceHeaders(options.headers || {})
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = new Error(detail || `Supabase request failed (${response.status}).`);
    error.status = response.status;
    error.detail = detail;
    throw error;
  }
  return response;
}

async function requireAccessManager(event) {
  const token = bearerToken(event);
  if (!token) throw httpError(401, 'authentication_required', 'Sign in to manage Client portal access.');
  if (!SUPABASE_URL || !SERVICE_KEY) throw httpError(503, 'service_unavailable', 'Client portal access is not configured yet.');
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw httpError(401, 'authentication_required', 'Sign in again to manage Client portal access.');
  const user = await response.json().catch(() => null);
  if (!validUuid(user?.id)) throw httpError(401, 'authentication_required', 'Sign in again to manage Client portal access.');
  const accessResponse = await serviceRequest(
    `/rest/v1/platform_users?id=eq.${encodeURIComponent(user.id)}&select=id,organization_id,role,active,must_change_password&limit=1`
  );
  const access = (await accessResponse.json())[0];
  if (!access?.active || access.must_change_password !== false || !MANAGER_ROLES.has(access.role) || !validUuid(access.organization_id)) {
    throw httpError(403, 'forbidden', 'Only active Admin, Sales Management, or assigned Sales accounts can manage Client portal access.');
  }
  return { user, access, token, tokenFresh: tokenPasswordAuthenticatedRecently(token) };
}

async function fetchContact(manager, contactId) {
  if (!validUuid(contactId)) throw httpError(400, 'invalid_contact', 'Choose a valid Client contact.');
  const fields = [
    'id', 'organization_id', 'client_id', 'full_name', 'email', 'phone', 'contact_role',
    'active', 'updated_at', 'portal_login_email', 'portal_access_status',
    'portal_invite_sent_at', 'portal_access_activated_at', 'portal_last_password_reset_sent_at',
    'portal_email_changed_at', 'portal_access_updated_at'
  ].join(',');
  const response = await serviceRequest(
    `/rest/v1/client_contacts?id=eq.${encodeURIComponent(contactId)}&organization_id=eq.${encodeURIComponent(manager.access.organization_id)}&select=${fields}&limit=1`
  );
  const contact = (await response.json())[0];
  if (!contact) throw httpError(404, 'contact_not_found', 'The Client contact could not be found.');
  const clientResponse = await serviceRequest(
    `/rest/v1/clients?id=eq.${encodeURIComponent(contact.client_id)}&organization_id=eq.${encodeURIComponent(manager.access.organization_id)}&select=id,organization_id,company_name,sales_owner_id,archived_at&limit=1`
  );
  const client = (await clientResponse.json())[0];
  if (!client) throw httpError(404, 'client_not_found', 'The Client could not be found.');
  if (manager.access.role === 'sales' && client.sales_owner_id !== manager.user.id) {
    throw httpError(403, 'forbidden', 'Sales can manage portal access only for assigned Clients.');
  }
  return { contact, client };
}

async function fetchMembership(manager, contactId) {
  const response = await serviceRequest(
    `/rest/v1/client_portal_memberships?client_contact_id=eq.${encodeURIComponent(contactId)}&organization_id=eq.${encodeURIComponent(manager.access.organization_id)}&select=user_id,organization_id,client_id,client_contact_id,active,updated_at&limit=1`
  );
  return (await response.json())[0] || null;
}

async function fetchPortalUser(manager, userId) {
  if (!validUuid(userId)) return null;
  const response = await serviceRequest(
    `/rest/v1/platform_users?id=eq.${encodeURIComponent(userId)}&organization_id=eq.${encodeURIComponent(manager.access.organization_id)}&select=id,organization_id,role,active,must_change_password,initial_password_issued_at,password_changed_at&limit=1`
  );
  return (await response.json())[0] || null;
}

async function accessBundle(manager, contactId) {
  const { contact, client } = await fetchContact(manager, contactId);
  const membership = await fetchMembership(manager, contact.id);
  const access = membership ? await fetchPortalUser(manager, membership.user_id) : null;
  return { contact, client, membership, access };
}

function derivedStatus(bundle) {
  const { contact, client, membership, access } = bundle;
  if (contact.portal_access_status === 'needs_reconciliation') return 'needs_reconciliation';
  if (!membership) return contact.portal_access_status === 'not_invited' ? 'not_invited' : 'needs_reconciliation';
  if (client.archived_at || !contact.active || !membership.active) return 'suspended';
  if (!access || !CLIENT_ROLES.has(access.role)) return 'needs_reconciliation';
  if (!access.active) return 'suspended';
  if (access.must_change_password) return contact.portal_access_status === 'delivery_failed' ? 'delivery_failed' : 'invite_pending';
  return contact.portal_access_status === 'suspended' ? 'suspended' : 'active';
}

function availableActionsForStatus(status) {
  if (status === 'not_invited') return ['activate'];
  if (status === 'invite_pending' || status === 'delivery_failed') return ['resend_invitation', 'change_email', 'suspend_access'];
  if (status === 'active') return ['send_password_reset', 'change_email', 'suspend_access'];
  if (status === 'suspended') return ['reactivate_access'];
  return [];
}

function publicAccess(bundle, extras = {}) {
  const status = derivedStatus(bundle);
  const { contact, client, membership, access } = bundle;
  return {
    clientId: client.id,
    clientName: client.company_name,
    contactId: contact.id,
    contactName: contact.full_name,
    contactEmail: contact.email || null,
    loginEmail: contact.portal_login_email || null,
    portalRole: CLIENT_ROLES.has(access?.role) ? access.role : null,
    authUserId: membership?.user_id || null,
    status,
    inviteSentAt: contact.portal_invite_sent_at || null,
    activatedAt: contact.portal_access_activated_at || null,
    passwordResetSentAt: contact.portal_last_password_reset_sent_at || null,
    emailChangedAt: contact.portal_email_changed_at || null,
    availableActions: client.archived_at ? [] : availableActionsForStatus(status),
    ...extras
  };
}

function emailSentTooRecently(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) && Date.now() - timestamp < EMAIL_COOLDOWN_MS;
}

function generateUnreturnedSecret() {
  return `${crypto.randomBytes(48).toString('base64url')}!9Aa`;
}

function ensureEmailDeliveryConfigured() {
  if (!RESEND_API_KEY || !FROM_EMAIL) throw httpError(503, 'email_unavailable', 'Secure Client access email is not configured yet.');
  if (AUTH_LINK_TTL_MS === null || EMAIL_IDEMPOTENCY_RETRY_MS <= 0) {
    throw httpError(503, 'email_unavailable', 'Secure Client access email link expiration is not configured safely.');
  }
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
}

async function findProvisionedAuthUser(requestId, email) {
  const response = await serviceRequest('/rest/v1/rpc/find_client_auth_user_for_request', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_request_id: requestId, p_email: email })
  });
  const result = await response.json();
  return validUuid(result) ? String(result).toLowerCase() : '';
}

function reconciliationError(message, cause) {
  const error = httpError(502, 'access_needs_reconciliation', message);
  error.authOutcomeUnknown = true;
  error.operationOutcomeUnknown = true;
  error.cause = cause;
  return error;
}

async function createAuthUser(email, displayName, portalRole, requestId) {
  try {
    const response = await serviceRequest('/auth/v1/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: generateUnreturnedSecret(),
        email_confirm: true,
        user_metadata: {
          display_name: displayName,
          account_type: portalRole
        },
        app_metadata: {
          soro_client_access_request_id: requestId
        }
      })
    });
    const result = await response.json();
    const id = result?.user?.id || result?.id || '';
    if (!validUuid(id)) throw new Error('Supabase did not return the new Client account.');
    return { userId: String(id).toLowerCase(), recovered: false };
  } catch (error) {
    const ambiguousCreate = !Number.isInteger(error?.status) || error.status >= 500;
    try {
      const reconciledId = await findProvisionedAuthUser(requestId, email);
      if (reconciledId) return { userId: reconciledId, recovered: true };
    } catch (lookupError) {
      throw reconciliationError('Client account creation needs Administrator review before it can be retried.', error);
    }
    if (ambiguousCreate) {
      throw reconciliationError('Client account creation could not be confirmed and needs Administrator review before it can be retried.', error);
    }
    throw error;
  }
}

async function updateAuthUser(userId, values) {
  await serviceRequest(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values)
  });
}

async function authUserHasEmail(userId, email) {
  const response = await serviceRequest(`/auth/v1/admin/users/${encodeURIComponent(userId)}`);
  const result = await response.json();
  const account = result?.user || result;
  if (!validUuid(account?.id)) throw new Error('Supabase did not return the Client account for reconciliation.');
  return normalizedEmail(account.email) === normalizedEmail(email);
}

async function updateAuthUserConfirmed(userId, values) {
  try {
    await updateAuthUser(userId, values);
    return true;
  } catch (error) {
    let matches;
    try {
      matches = await authUserHasEmail(userId, values?.email);
    } catch (lookupError) {
      throw reconciliationError('The Client login email change needs Administrator review before another change is attempted.', error);
    }
    if (matches) return true;
    throw error;
  }
}

async function deleteAuthUser(userId) {
  await serviceRequest(`/auth/v1/admin/users/${encodeURIComponent(userId)}?should_soft_delete=false`, { method: 'DELETE' });
}

async function generateRecoveryLink(email) {
  const response = await serviceRequest(`/auth/v1/admin/generate_link?redirect_to=${encodeURIComponent(PORTAL_URL)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'recovery', email, redirect_to: PORTAL_URL })
  });
  const result = await response.json();
  const actionLink = result?.properties?.action_link || result?.action_link || '';
  let parsed;
  try { parsed = new URL(actionLink); } catch { throw new Error('Supabase did not return a secure Client account link.'); }
  if (parsed.protocol !== 'https:' || parsed.origin !== SUPABASE_URL) throw new Error('Supabase returned an unexpected Client account link.');
  return actionLink;
}

function accessEmailPayload({ contact, to, actionLink, kind }) {
  ensureEmailDeliveryConfigured();
  const {subject, text, html} = accessEmail({person: contact, actionLink, kind, audience: 'Client'});
  return { from: FROM_EMAIL, to: [to], subject, text, html };
}

function validatedDeliveryPayload(value, expectedEmail) {
  if (!isPlainObject(value) || !hasExactKeys(value, new Set(['from', 'to', 'subject', 'text', 'html']))
    || value.from !== FROM_EMAIL || !Array.isArray(value.to) || value.to.length !== 1
    || normalizedEmail(value.to[0]) !== normalizedEmail(expectedEmail)
    || !['subject', 'text', 'html'].every(key => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 20000)) {
    throw reconciliationError('The saved Client access email needs Administrator review before delivery can continue.');
  }
  return value;
}

async function checkpointDeliveryPayload(manager, input, operation, payload) {
  try {
    const response = await serviceRequest('/rest/v1/rpc/checkpoint_client_portal_access_delivery', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        p_actor_user_id: manager.user.id,
        p_request_id: operation.requestId,
        p_client_contact_id: input.contactId,
        p_action: input.action,
        p_request_fingerprint: operation.fingerprint,
        p_lease_token: operation.leaseToken,
        p_delivery_payload: payload
      })
    });
    return validatedDeliveryPayload(await response.json(), payload.to[0]);
  } catch (cause) {
    if (cause?.status === 409) {
      const error = emailDeliveryDeferred(EMAIL_RETRY_SAFETY_MARGIN_MS);
      error.cause = cause;
      throw error;
    }
    if (!Number.isInteger(cause?.status) || [408, 425, 429].includes(cause.status) || cause.status >= 500) {
      const error = operationPendingError(
        'The secure email checkpoint could not be confirmed. Retry this same Client access action.',
        2 * 60 * 1000
      );
      error.cause = cause;
      throw error;
    }
    throw cause;
  }
}

async function markDeliveryAttempt(manager, input, operation) {
  try {
    const response = await serviceRequest('/rest/v1/rpc/mark_client_portal_access_delivery_attempt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        p_actor_user_id: manager.user.id,
        p_request_id: operation.requestId,
        p_client_contact_id: input.contactId,
        p_action: input.action,
        p_request_fingerprint: operation.fingerprint,
        p_lease_token: operation.leaseToken
      })
    });
    const firstAttemptAt = await response.json();
    if (!Number.isFinite(Date.parse(firstAttemptAt || ''))) throw new Error('Invalid delivery attempt checkpoint.');
    return firstAttemptAt;
  } catch (cause) {
    const error = operationPendingError(
      'The email delivery attempt could not be safely checkpointed. Retry this same Client access action.',
      2 * 60 * 1000
    );
    error.cause = cause;
    throw error;
  }
}

function emailDeliveryUnknown(cause) {
  const error = httpError(502, 'email_delivery_unknown', 'Email delivery could not be confirmed. Retry this same Client access action.');
  error.operationOutcomeUnknown = true;
  error.cause = cause;
  return error;
}

function emailDeliveryDeferred(retryAfterMilliseconds) {
  const error = httpError(
    409,
    'access_action_pending',
    'The saved email request is waiting for its safe provider retry window. Retry this same Client access action later.'
  );
  error.operationOutcomeUnknown = true;
  error.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMilliseconds / 1000));
  return error;
}

function operationPendingError(message, retryAfterMilliseconds) {
  const error = httpError(503, 'access_action_pending', message);
  error.operationOutcomeUnknown = true;
  error.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMilliseconds / 1000));
  return error;
}

function emailWorkflowIsPending(error) {
  return ['email_delivery_unknown', 'access_action_pending'].includes(error?.code);
}

async function sendAccessEmail({ manager, input, operation, contact, to, kind }) {
  ensureEmailDeliveryConfigured();
  if (!validUuid(operation?.requestId)) throw httpError(500, 'email_delivery_failed', 'The secure Client access email could not be prepared.');
  let payload = null;
  if (operation.deliveryPayload) {
    const payloadCreatedAt = Date.parse(operation.deliveryPayloadCreatedAt || '');
    if (!Number.isFinite(payloadCreatedAt)) {
      throw reconciliationError('The saved Client access email is missing its delivery checkpoint time. Administrator review is required.');
    }
    const savedPayload = validatedDeliveryPayload(operation.deliveryPayload, to);
    const payloadAge = Math.max(0, Date.now() - payloadCreatedAt);
    if (payloadAge < EMAIL_IDEMPOTENCY_RETRY_MS) {
      payload = savedPayload;
    } else if (operation.deliveryFirstAttemptAt) {
      const firstAttemptAt = Date.parse(operation.deliveryFirstAttemptAt);
      if (!Number.isFinite(firstAttemptAt)) {
        throw reconciliationError('The saved Client access email has an invalid provider-attempt checkpoint. Administrator review is required.');
      }
      const providerWindowAge = Math.max(0, Date.now() - firstAttemptAt);
      if (providerWindowAge < RESEND_IDEMPOTENCY_REFRESH_MS) {
        throw emailDeliveryDeferred(RESEND_IDEMPOTENCY_REFRESH_MS - providerWindowAge);
      }
      operation.deliveryFirstAttemptAt = null;
    }
  }
  if (!payload) {
    try {
      const actionLink = await generateRecoveryLink(to);
      payload = await checkpointDeliveryPayload(
        manager, input, operation, accessEmailPayload({ contact, to, actionLink, kind })
      );
    } catch (error) {
      if (error?.operationOutcomeUnknown === true) throw error;
      if (!Number.isInteger(error?.status) || [408, 425, 429].includes(error.status) || error.status >= 500) {
        const pending = operationPendingError(
          'The secure Client access link could not be confirmed. Retry this same action.',
          2 * 60 * 1000
        );
        pending.cause = error;
        throw pending;
      }
      throw error;
    }
    operation.deliveryPayload = payload;
    operation.deliveryPayloadCreatedAt = new Date().toISOString();
  }
  if (!operation.deliveryFirstAttemptAt) {
    operation.deliveryFirstAttemptAt = await markDeliveryAttempt(manager, input, operation);
  }
  let response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `soro-client-access-${operation.requestId}`
      },
      body: JSON.stringify(payload)
    });
  } catch (cause) {
    throw emailDeliveryUnknown(cause);
  }
  if (!response.ok) {
    const providerError = await response.json().catch(() => ({}));
    const providerCode = String(providerError?.name || providerError?.code || providerError?.error || '')
      .trim().toLowerCase();
    if ([408, 425].includes(response.status) || response.status >= 500
      || (response.status === 409 && providerCode === 'concurrent_idempotent_requests')) {
      throw emailDeliveryUnknown();
    }
    if (response.status === 409) {
      throw reconciliationError(
        providerCode === 'invalid_idempotent_request'
          ? 'The email provider rejected the saved request because its idempotency payload no longer matches. Administrator review is required.'
          : 'The email provider returned an idempotency conflict that needs Administrator review before delivery can continue.'
      );
    }
    throw httpError(502, 'email_delivery_failed', 'The secure Client access email could not be delivered. No password or link was exposed.');
  }
  return String((await response.json().catch(() => ({})))?.id || '');
}

async function patchContact(manager, contactId, values) {
  const response = await serviceRequest(`/rest/v1/client_contacts?id=eq.${encodeURIComponent(contactId)}&organization_id=eq.${encodeURIComponent(manager.access.organization_id)}&select=id`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ ...values, portal_access_updated_by: manager.user.id, portal_access_updated_at: new Date().toISOString() })
  });
  const rows = await response.json().catch(() => null);
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.id !== contactId) {
    throw reconciliationError('The Client contact access update could not be verified. Administrator review is required.');
  }
}

async function patchPlatformUser(manager, userId, values) {
  const response = await serviceRequest(`/rest/v1/platform_users?id=eq.${encodeURIComponent(userId)}&organization_id=eq.${encodeURIComponent(manager.access.organization_id)}&select=id`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(values)
  });
  const rows = await response.json().catch(() => null);
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.id !== userId) {
    throw reconciliationError('The Client platform access update could not be verified. Administrator review is required.');
  }
}

async function patchMembership(manager, userId, values) {
  const response = await serviceRequest(`/rest/v1/client_portal_memberships?user_id=eq.${encodeURIComponent(userId)}&organization_id=eq.${encodeURIComponent(manager.access.organization_id)}&select=user_id`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(values)
  });
  const rows = await response.json().catch(() => null);
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.user_id !== userId) {
    throw reconciliationError('The Client membership access update could not be verified. Administrator review is required.');
  }
}

async function mutateAccountLink(manager, input, operation, userId, mutation) {
  const response = await serviceRequest('/rest/v1/rpc/mutate_client_portal_account_link', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      p_actor_user_id: manager.user.id,
      p_request_id: input.requestId,
      p_client_contact_id: input.contactId,
      p_request_fingerprint: operation.fingerprint,
      p_lease_token: operation.leaseToken,
      p_user_id: userId,
      p_mutation: mutation
    })
  });
  const result = await response.json().catch(() => null);
  if (!hasExactKeys(result, new Set(['userId', 'linked', 'cleanupAllowed']))
    || result.userId !== userId
    || result.linked !== (mutation === 'link')
    || result.cleanupAllowed !== (mutation === 'cleanup')) {
    throw reconciliationError('The Client account link update could not be verified. Administrator review is required.');
  }
  return result;
}

function operationFingerprint(input) {
  return crypto.createHash('sha256').update(JSON.stringify({
    action: input.action, contactId: input.contactId, email: input.email, portalRole: input.portalRole
  })).digest('hex');
}

async function beginOperation(manager, input) {
  const fingerprint = operationFingerprint(input);
  const response = await serviceRequest('/rest/v1/rpc/reserve_client_portal_access_operation', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      p_actor_user_id: manager.user.id,
      p_request_id: input.requestId,
      p_client_contact_id: input.contactId,
      p_action: input.action,
      p_request_fingerprint: fingerprint,
      p_requested_email: input.email,
      p_requested_portal_role: input.portalRole
    })
  });
  const claim = await response.json();
  if (!isPlainObject(claim) || !['claimed', 'completed', 'failed', 'busy', 'reconciliation_required', 'cleanup_required'].includes(claim.state)) {
    throw httpError(502, 'access_service_error', 'The Client access operation returned an invalid claim.');
  }
  if (claim.state === 'completed') {
    if (!isPlainObject(claim.result)) throw httpError(502, 'access_service_error', 'The completed Client access operation has no result.');
    return { replay: claim.result, fingerprint, leaseToken: null, resumed: false, createdAt: null };
  }
  if (claim.state === 'busy') {
    const error = httpError(409, 'access_action_pending', 'Another Client access action is already being processed for this contact.');
    error.retryAfterSeconds = Number.isInteger(claim.retryAfterSeconds) ? claim.retryAfterSeconds : null;
    throw error;
  }
  if (claim.state === 'reconciliation_required') {
    throw httpError(409, 'access_needs_reconciliation', 'Finish reconciling the earlier Client access action before starting another one.');
  }
  if (claim.state === 'cleanup_required') {
    throw reconciliationError('The earlier Client account cleanup needs Administrator review before activation can be retried.');
  }
  if (claim.state === 'failed') {
    throw httpError(409, 'access_action_failed', 'That Client access attempt ended and cannot be replayed. Start the action again.');
  }
  if (!validUuid(claim.effectiveRequestId) || !validUuid(claim.leaseToken) || !validUuid(claim.auditEventId)
    || !Number.isFinite(Date.parse(claim.operationCreatedAt || ''))
    || (claim.deliveryPayload !== null && claim.deliveryPayload !== undefined && !isPlainObject(claim.deliveryPayload))
    || (isPlainObject(claim.deliveryPayload) && !Number.isFinite(Date.parse(claim.deliveryPayloadCreatedAt || '')))
    || (claim.deliveryFirstAttemptAt !== null && claim.deliveryFirstAttemptAt !== undefined
      && !Number.isFinite(Date.parse(claim.deliveryFirstAttemptAt || '')))
    || (!isPlainObject(claim.deliveryPayload) && claim.deliveryPayloadCreatedAt !== null
      && claim.deliveryPayloadCreatedAt !== undefined)
    || (!isPlainObject(claim.deliveryPayload) && claim.deliveryFirstAttemptAt !== null
      && claim.deliveryFirstAttemptAt !== undefined)) {
    throw httpError(502, 'access_service_error', 'The Client access operation returned an invalid lease.');
  }
  return {
    replay: null,
    fingerprint,
    requestId: String(claim.effectiveRequestId).toLowerCase(),
    leaseToken: String(claim.leaseToken).toLowerCase(),
    auditId: String(claim.auditEventId).toLowerCase(),
    resumed: claim.resumed === true,
    createdAt: claim.operationCreatedAt,
    deliveryPayload: claim.deliveryPayload || null,
    deliveryPayloadCreatedAt: claim.deliveryPayloadCreatedAt || null,
    deliveryFirstAttemptAt: claim.deliveryFirstAttemptAt || null
  };
}

async function finalizeOperation(manager, input, operation, status, result = null, failureCode = null) {
  const response = await serviceRequest('/rest/v1/rpc/finalize_client_portal_access_operation', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      p_actor_user_id: manager.user.id,
      p_request_id: input.requestId,
      p_client_contact_id: input.contactId,
      p_action: input.action,
      p_request_fingerprint: operation.fingerprint,
      p_lease_token: operation.leaseToken,
      p_outcome: status,
      p_result: result,
      p_failure_code: failureCode
    })
  });
  return response.json();
}

function isDuplicateError(error) {
  return [409, 422].includes(error?.status) || /already|duplicate|unique|registered/i.test(String(error?.detail || error?.message || ''));
}

async function ensurePortalEmailAvailable(email, contactId) {
  const response = await serviceRequest(
    `/rest/v1/client_contacts?portal_login_email=eq.${encodeURIComponent(email)}&id=neq.${encodeURIComponent(contactId)}&select=id&limit=1`
  );
  if ((await response.json()).length) throw httpError(409, 'login_email_in_use', 'That email is already used for another Client portal account.');
}

async function refreshBundle(manager, contactId) {
  return accessBundle(manager, contactId);
}

function platformUserMatchesActivation(access, manager, input) {
  return Boolean(access)
    && access.organization_id === manager.access.organization_id
    && access.role === input.portalRole
    && access.active === true
    && typeof access.must_change_password === 'boolean';
}

function membershipMatchesActivation(membership, manager, bundle, userId) {
  return Boolean(membership)
    && membership.user_id === userId
    && membership.organization_id === manager.access.organization_id
    && membership.client_id === bundle.client.id
    && membership.client_contact_id === bundle.contact.id
    && membership.active === true;
}

async function activate(manager, input, bundle, operation) {
  if (bundle.client.archived_at || !bundle.contact.active) throw httpError(409, 'client_inactive', 'Restore the Client and contact before activating portal access.');
  if (operation?.resumed && bundle.membership) {
    const access = await requireLinked(bundle);
    const savedEmail = normalizedEmail(bundle.contact.portal_login_email);
    const matches = (!savedEmail || savedEmail === input.email)
      && access.role === input.portalRole
      && bundle.membership.active === true
      && access.active === true
      && await authUserHasEmail(access.id, input.email);
    if (matches) {
      if (!savedEmail || !['invite_pending', 'delivery_failed', 'active'].includes(bundle.contact.portal_access_status)) {
        await patchContact(manager, bundle.contact.id, {
          portal_login_email: input.email,
          portal_access_status: access.must_change_password === false ? 'active' : 'invite_pending',
          portal_invite_sent_at: bundle.contact.portal_invite_sent_at || new Date().toISOString()
        });
      }
      if (access.must_change_password === false) {
        await patchContact(manager, bundle.contact.id, {
          portal_login_email: input.email,
          portal_access_status: 'active'
        });
        return {
          bundle: await refreshBundle(manager, bundle.contact.id),
          deliveryId: '', emailDelivered: null, reconciled: true
        };
      }
      ensureEmailDeliveryConfigured();
      const deliveryId = await sendAccessEmail({ manager, input, operation, contact: bundle.contact, to: input.email, kind: 'setup' });
      await patchContact(manager, bundle.contact.id, {
        portal_login_email: input.email,
        portal_access_status: access.must_change_password === false ? 'active' : 'invite_pending',
        portal_invite_sent_at: bundle.contact.portal_invite_sent_at || new Date().toISOString()
      });
      return { bundle: await refreshBundle(manager, bundle.contact.id), deliveryId, emailDelivered: true, reconciled: true };
    }
    throw reconciliationError('The earlier Client account activation needs Administrator review before it can continue.');
  }
  ensureEmailDeliveryConfigured();
  if (bundle.membership) throw httpError(409, 'access_exists', 'This Client contact already has portal access.');
  await ensurePortalEmailAvailable(input.email, bundle.contact.id);
  const issuedAt = new Date().toISOString();
  let userId = '';
  let recoveredAuthUser = false;
  let existingPlatformUser = null;
  let linked = false;
  try {
    if (operation?.resumed) {
      userId = await findProvisionedAuthUser(input.requestId, input.email);
      recoveredAuthUser = Boolean(userId);
      if (recoveredAuthUser) {
        if (!await authUserHasEmail(userId, input.email)) {
          throw reconciliationError('The earlier Client account activation has conflicting Auth data.');
        }
        existingPlatformUser = await fetchPortalUser(manager, userId);
        if (existingPlatformUser && !platformUserMatchesActivation(existingPlatformUser, manager, input)) {
          throw reconciliationError('The earlier Client account activation has conflicting platform access data.');
        }
      }
    }
    if (!userId) {
      const createdAuthUser = await createAuthUser(input.email, bundle.contact.full_name, input.portalRole, input.requestId);
      userId = createdAuthUser.userId;
      recoveredAuthUser = createdAuthUser.recovered;
    }
    if (!existingPlatformUser) {
      try {
        await serviceRequest('/rest/v1/platform_users', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({
            id: userId, organization_id: manager.access.organization_id, role: input.portalRole,
            display_name: bundle.contact.full_name, active: true, must_change_password: true,
            initial_password_issued_at: issuedAt
          })
        });
      } catch (error) {
        let reconciledPlatformUser;
        try { reconciledPlatformUser = await fetchPortalUser(manager, userId); } catch {
          throw reconciliationError('Client account provisioning needs Administrator review before it can continue.', error);
        }
        if (!platformUserMatchesActivation(reconciledPlatformUser, manager, input)) {
          if (!Number.isInteger(error.status) || error.status >= 500) {
            throw reconciliationError('Client account provisioning needs Administrator review before it can continue.', error);
          }
          throw error;
        }
        existingPlatformUser = reconciledPlatformUser;
      }
    }
    try {
      await mutateAccountLink(manager, input, operation, userId, 'link');
    } catch (error) {
      // Only an uncertain transport outcome may be reconciled by reading the
      // committed membership. A rejected or malformed RPC must not be bypassed.
      if (error?.code === 'access_needs_reconciliation' || !operationOutcomeIsAmbiguous(error)) throw error;
      let reconciledMembership;
      try { reconciledMembership = await fetchMembership(manager, bundle.contact.id); } catch {
        throw reconciliationError('Client account membership needs Administrator review before it can continue.', error);
      }
      if (!membershipMatchesActivation(reconciledMembership, manager, bundle, userId)) {
        if (!Number.isInteger(error.status) || error.status >= 500) {
          throw reconciliationError('Client account membership needs Administrator review before it can continue.', error);
        }
        throw error;
      }
    }
    await patchContact(manager, bundle.contact.id, {
      portal_login_email: input.email,
      portal_access_status: existingPlatformUser?.must_change_password === false ? 'active' : 'invite_pending',
      portal_invite_sent_at: issuedAt
    });
    linked = true;
    if (existingPlatformUser?.must_change_password === false) {
      return {
        bundle: await refreshBundle(manager, bundle.contact.id),
        deliveryId: '', emailDelivered: null, reconciled: true
      };
    }
    const deliveryId = await sendAccessEmail({ manager, input, operation, contact: bundle.contact, to: input.email, kind: 'setup' });
    return { bundle: await refreshBundle(manager, bundle.contact.id), deliveryId, emailDelivered: true };
  } catch (error) {
    const originalOutcomeAmbiguous = operationOutcomeIsAmbiguous(error);
    if (linked && emailWorkflowIsPending(error)) throw error;
    if (error.authOutcomeUnknown || (!linked && (originalOutcomeAmbiguous || recoveredAuthUser))) {
      await patchContact(manager, bundle.contact.id, {
        portal_login_email: input.email,
        portal_access_status: 'needs_reconciliation'
      }).catch(() => {});
      if (error?.code === 'access_needs_reconciliation') throw error;
      throw reconciliationError('Client account provisioning needs Administrator review before it can continue.', error);
    } else if (!linked) {
      try {
        if (userId && !recoveredAuthUser) {
          // The server checks the live lease, request provenance and unfinished
          // account before removing its rows and authorizing Auth cleanup.
          await mutateAccountLink(manager, input, operation, userId, 'cleanup');
          await deleteAuthUser(userId);
        }
        // No successful contact update precedes this branch. Do not overwrite
        // contact metadata from the earlier snapshot after cleanup releases its lock.
        error.operationCompensated = true;
      } catch (cleanupError) {
        await patchContact(manager, bundle.contact.id, { portal_access_status: 'needs_reconciliation' }).catch(() => {});
        throw reconciliationError('Client account cleanup could not be confirmed and needs Administrator review.', cleanupError);
      }
    } else if (!operationOutcomeIsAmbiguous(error)) {
      await patchContact(manager, bundle.contact.id, { portal_access_status: 'delivery_failed' }).catch(() => {});
    }
    if (operationOutcomeIsAmbiguous(error)) {
      if (error?.code === 'access_needs_reconciliation') throw error;
      throw reconciliationError('The Client account activation needs Administrator review before it can continue.', error);
    }
    if (isDuplicateError(error) && operation?.resumed) {
      throw reconciliationError('The earlier Client account activation needs Administrator review before it can continue.', error);
    }
    if (isDuplicateError(error)) throw httpError(409, 'login_email_in_use', 'That email already belongs to another sign-in account.');
    throw error;
  }
}

async function requireLinked(bundle) {
  if (!bundle.membership || !bundle.access || !CLIENT_ROLES.has(bundle.access.role)) {
    throw httpError(409, 'access_not_linked', 'This Client contact does not have a valid portal account.');
  }
  return bundle.access;
}

async function resendInvitation(manager, input, bundle, operation) {
  const access = await requireLinked(bundle);
  if (operation?.resumed && access.must_change_password === false) {
    if (access.active && bundle.membership.active && !bundle.client.archived_at && bundle.contact.active) {
      await patchContact(manager, bundle.contact.id, { portal_access_status: 'active' });
    }
    return {
      bundle: await refreshBundle(manager, bundle.contact.id),
      deliveryId: '', emailDelivered: null, reconciled: true
    };
  }
  ensureEmailDeliveryConfigured();
  if (bundle.client.archived_at || !bundle.contact.active || !bundle.membership.active || !access.active || access.must_change_password !== true) {
    throw httpError(409, 'invitation_not_pending', 'Invitation email can be resent only for an active pending Client account.');
  }
  if (!operation?.resumed && emailSentTooRecently(bundle.contact.portal_invite_sent_at)) throw httpError(429, 'email_rate_limited', 'Please wait a minute before sending another invitation.');
  const email = normalizedEmail(bundle.contact.portal_login_email);
  if (!validEmail(email)) throw httpError(409, 'login_email_missing', 'This portal account does not have a valid login email.');
  const sentAt = new Date().toISOString();
  await patchContact(manager, bundle.contact.id, { portal_access_status: 'invite_pending', portal_invite_sent_at: sentAt });
  try {
    const deliveryId = await sendAccessEmail({ manager, input, operation, contact: bundle.contact, to: email, kind: 'setup' });
    return { bundle: await refreshBundle(manager, bundle.contact.id), deliveryId, emailDelivered: true };
  } catch (error) {
    if (!operationOutcomeIsAmbiguous(error)) {
      await patchContact(manager, bundle.contact.id, { portal_access_status: 'delivery_failed' }).catch(() => {});
    }
    throw error;
  }
}

async function sendPasswordReset(manager, input, bundle, operation) {
  ensureEmailDeliveryConfigured();
  const access = await requireLinked(bundle);
  if ((derivedStatus(bundle) !== 'active'
      && !(operation?.resumed && bundle.contact.portal_access_status === 'needs_reconciliation'))
    || !access.active || !bundle.membership.active || access.must_change_password !== false) {
    throw httpError(409, 'access_not_active', 'Password reset email can be sent only for an active Client portal account.');
  }
  if (!operation?.resumed && emailSentTooRecently(bundle.contact.portal_last_password_reset_sent_at)) throw httpError(429, 'email_rate_limited', 'Please wait a minute before sending another reset email.');
  const email = normalizedEmail(bundle.contact.portal_login_email);
  if (!validEmail(email)) throw httpError(409, 'login_email_missing', 'This portal account does not have a valid login email.');
  const sentAt = new Date().toISOString();
  await patchContact(manager, bundle.contact.id, { portal_last_password_reset_sent_at: sentAt });
  try {
    const deliveryId = await sendAccessEmail({ manager, input, operation, contact: bundle.contact, to: email, kind: 'password_reset' });
    if (operation?.resumed && bundle.contact.portal_access_status === 'needs_reconciliation') {
      await patchContact(manager, bundle.contact.id, { portal_access_status: 'active' });
    }
    return { bundle: await refreshBundle(manager, bundle.contact.id), deliveryId, emailDelivered: true };
  } catch (error) {
    if (!operationOutcomeIsAmbiguous(error)) {
      await patchContact(manager, bundle.contact.id, {
        portal_last_password_reset_sent_at: bundle.contact.portal_last_password_reset_sent_at
      }).catch(() => {});
    }
    throw error;
  }
}

async function changeEmail(manager, input, bundle, operation) {
  if (!manager.tokenFresh) throw httpError(401, 'reauthentication_required', 'Sign out and sign back in before changing a Client portal login email.');
  const access = await requireLinked(bundle);
  if (bundle.client.archived_at || !bundle.contact.active || !bundle.membership.active || !access.active) {
    throw httpError(409, 'access_suspended', 'Reactivate this Client portal account before changing its login email.');
  }
  if (operation?.resumed && input.email === normalizedEmail(bundle.contact.portal_login_email)) {
    try {
      await ensurePortalEmailAvailable(input.email, bundle.contact.id);
      let authMatches;
      try { authMatches = await authUserHasEmail(access.id, input.email); } catch (error) {
        throw reconciliationError('The earlier Client login email change needs Administrator review before it can continue.', error);
      }
      if (authMatches && access.must_change_password === false) {
        await patchContact(manager, bundle.contact.id, { portal_access_status: 'active' });
        return {
          bundle: await refreshBundle(manager, bundle.contact.id),
          deliveryId: '', emailDelivered: null, reconciled: true
        };
      }
      ensureEmailDeliveryConfigured();
      if (!authMatches) {
        try {
          await updateAuthUserConfirmed(access.id, {
            email: input.email, email_confirm: true, password: generateUnreturnedSecret(),
            user_metadata: { display_name: bundle.contact.full_name, account_type: access.role }
          });
        } catch (error) {
          throw reconciliationError('The earlier Client login email change needs Administrator review before it can continue.', error);
        }
      }
      try {
        await patchPlatformUser(manager, access.id, {
          must_change_password: true,
          initial_password_issued_at: access.initial_password_issued_at || bundle.contact.portal_email_changed_at || new Date().toISOString()
        });
      } catch (error) {
        throw reconciliationError('The earlier Client login email change needs Administrator review before it can continue.', error);
      }
      const deliveryId = await sendAccessEmail({ manager, input, operation, contact: bundle.contact, to: input.email, kind: 'setup' });
      await patchContact(manager, bundle.contact.id, {
        portal_access_status: 'invite_pending',
        portal_invite_sent_at: bundle.contact.portal_invite_sent_at || new Date().toISOString()
      });
      return { bundle: await refreshBundle(manager, bundle.contact.id), deliveryId, emailDelivered: true, reconciled: true };
    } catch (error) {
      if (!operationOutcomeIsAmbiguous(error)) {
        await patchContact(manager, bundle.contact.id, { portal_access_status: 'delivery_failed' }).catch(() => {});
      }
      throw error;
    }
  }
  ensureEmailDeliveryConfigured();
  if (!operation?.resumed && emailSentTooRecently(bundle.contact.portal_email_changed_at)) throw httpError(429, 'email_rate_limited', 'Please wait a minute before changing the login email again.');
  if (input.email === normalizedEmail(bundle.contact.portal_login_email)) throw httpError(409, 'email_unchanged', 'Enter a different Client portal login email.');
  await ensurePortalEmailAvailable(input.email, bundle.contact.id);
  const changedAt = new Date().toISOString();
  let authChanged = false;
  try {
    await patchPlatformUser(manager, access.id, { must_change_password: true, initial_password_issued_at: changedAt });
    await patchContact(manager, bundle.contact.id, {
      portal_login_email: input.email, portal_access_status: 'invite_pending',
      portal_invite_sent_at: changedAt, portal_email_changed_at: changedAt
    });
    await updateAuthUserConfirmed(access.id, {
      email: input.email, email_confirm: true, password: generateUnreturnedSecret(),
      user_metadata: { display_name: bundle.contact.full_name, account_type: access.role }
    });
    authChanged = true;
    const deliveryId = await sendAccessEmail({ manager, input, operation, contact: bundle.contact, to: input.email, kind: 'setup' });
    return { bundle: await refreshBundle(manager, bundle.contact.id), deliveryId, emailDelivered: true };
  } catch (error) {
    const originalOutcomeAmbiguous = operationOutcomeIsAmbiguous(error);
    if (originalOutcomeAmbiguous) {
      if (emailWorkflowIsPending(error)) throw error;
      await patchContact(manager, bundle.contact.id, { portal_access_status: 'needs_reconciliation' }).catch(() => {});
      if (error?.code === 'access_needs_reconciliation') throw error;
      throw reconciliationError('The Client login email change needs Administrator review before it can continue.', error);
    } else if (authChanged) {
      await patchContact(manager, bundle.contact.id, { portal_access_status: 'delivery_failed' }).catch(() => {});
    } else {
      const rollbackResults = await Promise.allSettled([
        patchPlatformUser(manager, access.id, {
        must_change_password: access.must_change_password,
        initial_password_issued_at: access.initial_password_issued_at
        }),
        patchContact(manager, bundle.contact.id, {
        portal_login_email: bundle.contact.portal_login_email,
        portal_access_status: bundle.contact.portal_access_status,
        portal_invite_sent_at: bundle.contact.portal_invite_sent_at,
        portal_email_changed_at: bundle.contact.portal_email_changed_at
        })
      ]);
      if (rollbackResults.some(result => result.status === 'rejected')) {
        await patchContact(manager, bundle.contact.id, { portal_access_status: 'needs_reconciliation' }).catch(() => {});
        throw reconciliationError('The Client login email rollback could not be confirmed and needs Administrator review.', error);
      } else error.operationCompensated = true;
    }
    if (operationOutcomeIsAmbiguous(error)) {
      if (error?.code === 'access_needs_reconciliation') throw error;
      throw reconciliationError('The Client login email change needs Administrator review before it can continue.', error);
    }
    if (isDuplicateError(error)) throw httpError(409, 'login_email_in_use', 'That email already belongs to another sign-in account.');
    throw error;
  }
}

async function suspendAccess(manager, input, bundle) {
  const access = await requireLinked(bundle);
  if (bundle.membership.active === false && access.active === false && bundle.contact.portal_access_status === 'suspended') {
    return { bundle, deliveryId: '', emailDelivered: null };
  }
  try {
    await patchPlatformUser(manager, access.id, { active: false });
    await patchMembership(manager, access.id, { active: false });
    await patchContact(manager, bundle.contact.id, { portal_access_status: 'suspended' });
    return { bundle: await refreshBundle(manager, bundle.contact.id), deliveryId: '', emailDelivered: null };
  } catch (error) {
    if (operationOutcomeIsAmbiguous(error)) {
      await patchContact(manager, bundle.contact.id, { portal_access_status: 'needs_reconciliation' }).catch(() => {});
      if (error?.code === 'access_needs_reconciliation') throw error;
      throw reconciliationError('The Client portal suspension could not be confirmed and needs Administrator review.', error);
    }
    const rollbackResults = await Promise.allSettled([
      patchMembership(manager, access.id, { active: bundle.membership.active }),
      patchPlatformUser(manager, access.id, { active: bundle.access.active }),
      patchContact(manager, bundle.contact.id, { portal_access_status: bundle.contact.portal_access_status })
    ]);
    if (rollbackResults.some(result => result.status === 'rejected')) {
      await patchContact(manager, bundle.contact.id, { portal_access_status: 'needs_reconciliation' }).catch(() => {});
      throw reconciliationError('The Client portal suspension rollback could not be confirmed and needs Administrator review.', error);
    } else error.operationCompensated = true;
    throw error;
  }
}

async function reactivateAccess(manager, input, bundle) {
  const access = await requireLinked(bundle);
  if (bundle.client.archived_at || !bundle.contact.active) throw httpError(409, 'client_inactive', 'Restore the Client and contact before reactivating portal access.');
  if (derivedStatus(bundle) === 'active' || derivedStatus(bundle) === 'invite_pending') return { bundle, deliveryId: '', emailDelivered: null };
  const status = access.must_change_password ? 'invite_pending' : 'active';
  try {
    await patchMembership(manager, access.id, { active: true });
    await patchPlatformUser(manager, access.id, { active: true });
    await patchContact(manager, bundle.contact.id, { portal_access_status: status });
    return { bundle: await refreshBundle(manager, bundle.contact.id), deliveryId: '', emailDelivered: null };
  } catch (error) {
    if (operationOutcomeIsAmbiguous(error)) {
      await patchContact(manager, bundle.contact.id, { portal_access_status: 'needs_reconciliation' }).catch(() => {});
      if (error?.code === 'access_needs_reconciliation') throw error;
      throw reconciliationError('The Client portal reactivation could not be confirmed and needs Administrator review.', error);
    }
    const rollbackResults = await Promise.allSettled([
      patchPlatformUser(manager, access.id, { active: false }),
      patchMembership(manager, access.id, { active: false }),
      patchContact(manager, bundle.contact.id, { portal_access_status: 'suspended' })
    ]);
    if (rollbackResults.some(result => result.status === 'rejected')) {
      await patchContact(manager, bundle.contact.id, { portal_access_status: 'needs_reconciliation' }).catch(() => {});
      throw reconciliationError('The Client portal reactivation rollback could not be confirmed and needs Administrator review.', error);
    } else error.operationCompensated = true;
    throw error;
  }
}

async function getStatus(event) {
  const contactId = inputStatusQuery(event);
  const manager = await requireAccessManager(event);
  return json(200, { access: publicAccess(await accessBundle(manager, contactId)) });
}

function assertActionResult(input, actionResult) {
  const bundle = actionResult?.bundle;
  if (!bundle?.contact || !bundle?.client) {
    throw reconciliationError('The completed Client access action could not be verified. Administrator review is required.');
  }
  const status = derivedStatus(bundle);
  const linked = Boolean(bundle.membership && bundle.access && CLIENT_ROLES.has(bundle.access.role));
  let verified = false;
  if (input.action === 'activate') {
    verified = linked && bundle.membership.active === true && bundle.access.active === true
      && normalizedEmail(bundle.contact.portal_login_email) === input.email
      && bundle.access.role === input.portalRole
      && ['invite_pending', 'active'].includes(status);
  } else if (input.action === 'resend_invitation') {
    verified = linked && bundle.membership.active === true && bundle.access.active === true
      && ['invite_pending', 'active'].includes(status);
  } else if (input.action === 'send_password_reset') {
    verified = linked && bundle.membership.active === true && bundle.access.active === true
      && bundle.access.must_change_password === false && status === 'active';
  } else if (input.action === 'change_email') {
    verified = linked && bundle.membership.active === true && bundle.access.active === true
      && normalizedEmail(bundle.contact.portal_login_email) === input.email
      && ['invite_pending', 'active'].includes(status);
  } else if (input.action === 'suspend_access') {
    verified = linked && bundle.membership.active === false && bundle.access.active === false
      && bundle.contact.portal_access_status === 'suspended' && status === 'suspended';
  } else if (input.action === 'reactivate_access') {
    verified = linked && bundle.membership.active === true && bundle.access.active === true
      && ['invite_pending', 'active'].includes(status);
  }
  if (!verified) {
    throw reconciliationError('The completed Client access action did not match its requested state. Administrator review is required.');
  }
}

function operationOutcomeIsAmbiguous(error) {
  if (error?.operationOutcomeUnknown === true || error?.authOutcomeUnknown === true) return true;
  if (error?.operationCompensated === true) return false;
  if (['email_delivery_failed', 'email_unavailable'].includes(error?.code)) return false;
  const status = Number(error?.status);
  return !Number.isInteger(status) || [408, 425, 429].includes(status) || status >= 500;
}

async function finalizeCompletedOperation(manager, input, operation, result) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await finalizeOperation(manager, input, operation, 'completed', result, null);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function changeAccess(event) {
  rejectPostQuery(event);
  const input = inputActionBody(parseBody(event));
  const manager = await requireAccessManager(event);
  const operation = await beginOperation(manager, input);
  if (operation.replay) return json(200, operation.replay);
  const operationInput = operation.requestId === input.requestId
    ? input
    : { ...input, requestId: operation.requestId };
  let actionResult;
  try {
    const bundle = await accessBundle(manager, operationInput.contactId);
    if (operationInput.action === 'activate') actionResult = await activate(manager, operationInput, bundle, operation);
    else if (operationInput.action === 'resend_invitation') actionResult = await resendInvitation(manager, operationInput, bundle, operation);
    else if (operationInput.action === 'change_email') actionResult = await changeEmail(manager, operationInput, bundle, operation);
    else if (operationInput.action === 'send_password_reset') actionResult = await sendPasswordReset(manager, operationInput, bundle, operation);
    else if (operationInput.action === 'suspend_access') actionResult = await suspendAccess(manager, operationInput, bundle);
    else actionResult = await reactivateAccess(manager, operationInput, bundle);
    assertActionResult(operationInput, actionResult);
  } catch (error) {
    const ambiguous = operationOutcomeIsAmbiguous(error);
    if (error?.code === 'access_needs_reconciliation') {
      await patchContact(manager, operationInput.contactId, { portal_access_status: 'needs_reconciliation' }).catch(() => {});
    }
    if (!ambiguous) {
      try {
        await finalizeOperation(
          manager, operationInput, operation, 'failed', null, String(error.code || 'access_action_failed')
        );
      } catch (finalizeError) {
        console.error('Failed Client portal access action remains pending finalization.', {
          requestId: operationInput.requestId,
          contactId: operationInput.contactId,
          status: Number.isInteger(finalizeError?.status) ? finalizeError.status : null,
          code: /^[a-z][a-z0-9_]{2,64}$/.test(String(finalizeError?.code || '')) ? finalizeError.code : null
        });
        return json(503, {
          code: 'access_action_pending',
          message: 'The Client access attempt could not be confirmed. Retry the same action.',
          operationPending: true
        }, { 'Retry-After': '120' });
      }
    }
    throw error;
  }

  const result = {
    access: publicAccess(actionResult.bundle),
    emailDelivered: actionResult.emailDelivered,
    auditLogged: true,
    auditPending: false
  };
  try {
    await finalizeCompletedOperation(manager, operationInput, operation, result);
    return json(200, result);
  } catch (error) {
    console.error('Completed Client portal access action remains pending finalization.', {
      requestId: operationInput.requestId,
      contactId: operationInput.contactId,
      status: Number.isInteger(error?.status) ? error.status : null,
      code: /^[a-z][a-z0-9_]{2,64}$/.test(String(error?.code || '')) ? error.code : null
    });
    return json(503, {
      code: 'access_action_pending',
      message: 'The Client access change completed, but its confirmation is still pending. Retry the same action.',
      operationPending: true
    }, { 'Retry-After': '120' });
  }
}

async function handler(event) {
  const method = String(event.httpMethod || '').toUpperCase();
  if (!['GET', 'POST'].includes(method)) return json(405, { code: 'method_not_allowed', message: 'Method not allowed.' }, { Allow: 'GET, POST' });
  try {
    return method === 'GET' ? await getStatus(event) : await changeAccess(event);
  } catch (error) {
    console.error('Client portal access operation failed.', {
      method,
      status: Number.isInteger(error?.status) ? error.status : null,
      code: /^[a-z][a-z0-9_]{2,64}$/.test(String(error?.code || '')) ? error.code : null
    });
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    const hasSafeCode = Number.isInteger(error.status) && /^[a-z][a-z0-9_]{2,64}$/.test(String(error.code || ''));
    const code = hasSafeCode ? error.code : 'access_action_failed';
    const body = {
      code,
      message: hasSafeCode
        ? error.message
        : 'The Client portal access action could not be completed. Please try again.'
    };
    if (code === 'access_action_pending') body.operationPending = true;
    const extraHeaders = Number.isInteger(error.retryAfterSeconds)
      ? { 'Retry-After': String(Math.max(1, error.retryAfterSeconds)) }
      : {};
    return json(status, body, extraHeaders);
  }
}

exports.handler = handler;
exports.ACTIONS = ACTIONS;
exports.ACTION_BODY_KEYS = ACTION_BODY_KEYS;
exports.CLIENT_ROLES = CLIENT_ROLES;
exports.EMAIL_COOLDOWN_MS = EMAIL_COOLDOWN_MS;
exports.EMAIL_IDEMPOTENCY_RETRY_MS = EMAIL_IDEMPOTENCY_RETRY_MS;
exports.RESEND_IDEMPOTENCY_REFRESH_MS = RESEND_IDEMPOTENCY_REFRESH_MS;
exports.MANAGER_ROLES = MANAGER_ROLES;
exports.PORTAL_STATUSES = PORTAL_STATUSES;
exports.availableActionsForStatus = availableActionsForStatus;
exports.authUserHasEmail = authUserHasEmail;
exports.createAuthUser = createAuthUser;
exports.derivedStatus = derivedStatus;
exports.findProvisionedAuthUser = findProvisionedAuthUser;
exports.generateUnreturnedSecret = generateUnreturnedSecret;
exports.inputActionBody = inputActionBody;
exports.inputStatusQuery = inputStatusQuery;
exports.normalizedEmail = normalizedEmail;
exports.operationFingerprint = operationFingerprint;
exports.publicAccess = publicAccess;
exports.sendAccessEmail = sendAccessEmail;
exports.tokenPasswordAuthenticatedRecently = tokenPasswordAuthenticatedRecently;
exports.updateAuthUserConfirmed = updateAuthUserConfirmed;
exports.validEmail = validEmail;
exports.validUuid = validUuid;
