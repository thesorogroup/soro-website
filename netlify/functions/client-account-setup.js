/* Signed-in Client completion for one-use setup and password-recovery links. */

const { createHmac } = require('node:crypto');

const configuredUrl = String(process.env.SUPABASE_URL || '').trim();
const SUPABASE_URL = /^https:\/\/[^/]+\.supabase\.co\/?$/.test(configuredUrl)
  ? configuredUrl.replace(/\/$/, '')
  : '';
const SERVICE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || ''
).trim();
const MAX_REQUEST_BYTES = 4 * 1024;
const LINK_SESSION_MAX_AGE_SECONDS = 2 * 60 * 60;
const LINK_AMR_METHODS = new Set(['email', 'magiclink', 'otp', 'recovery']);
const CLIENT_ROLES = new Set(['client_admin', 'client_reviewer', 'client_billing']);
const COMPLETION_ACTIONS = new Set(['complete_setup', 'complete_recovery']);

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    Vary: 'Authorization'
  },
  body: JSON.stringify(body)
});

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

function validPassword(value) {
  return typeof value === 'string' && value.length >= 12 && value.length <= 128;
}

function normalizedEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function parseBody(event) {
  if (Buffer.byteLength(event.body || '', 'utf8') > MAX_REQUEST_BYTES) {
    throw httpError(413, 'request_too_large', 'The password request is too large.');
  }
  let body;
  try { body = event.body ? JSON.parse(event.body) : {}; } catch {
    throw httpError(400, 'invalid_request', 'The password request could not be read.');
  }
  if (!hasExactKeys(body, new Set(['action', 'newPassword', 'requestId']))) {
    throw httpError(400, 'unsupported_scope', 'Only the password completion fields are accepted.');
  }
  const action = String(body.action || '').trim();
  if (!COMPLETION_ACTIONS.has(action)) {
    throw httpError(400, 'unsupported_action', 'Choose a supported password action.');
  }
  if (!validPassword(body.newPassword)) {
    throw httpError(400, 'invalid_password', 'Your new password must be between 12 and 128 characters.');
  }
  const requestId = String(body.requestId || '').trim().toLowerCase();
  if (!validUuid(requestId)) {
    throw httpError(400, 'invalid_request_id', 'The password request identifier is invalid.');
  }
  return { action, newPassword: body.newPassword, requestId };
}

function bearerToken(event) {
  const header = event.headers?.authorization || event.headers?.Authorization || '';
  return /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() || '';
}

function jwtPayload(token) {
  try { return JSON.parse(Buffer.from(String(token || '').split('.')[1], 'base64url').toString('utf8')); } catch { return {}; }
}

function linkAuthenticatedAt(token) {
  const payload = jwtPayload(token);
  const timestamps = Array.isArray(payload.amr)
    ? payload.amr
      .filter(entry => LINK_AMR_METHODS.has(String(entry?.method || '').toLowerCase()))
      .map(entry => Number(entry.timestamp))
      .filter(Number.isFinite)
    : [];
  return timestamps.length ? Math.max(...timestamps) : Number.NaN;
}

function linkSessionIsRecent(token, nowMs = Date.now()) {
  const authenticatedAt = linkAuthenticatedAt(token);
  const nowSeconds = Math.floor(nowMs / 1000);
  return Number.isFinite(authenticatedAt)
    && authenticatedAt <= nowSeconds + 30
    && nowSeconds - authenticatedAt <= LINK_SESSION_MAX_AGE_SECONDS;
}

function linkSessionMatchesIssueTime(token, issuedAt, nowMs = Date.now()) {
  const authenticatedAt = linkAuthenticatedAt(token);
  const issuedAtSeconds = Date.parse(issuedAt || '') / 1000;
  const nowSeconds = Math.floor(nowMs / 1000);
  return Number.isFinite(authenticatedAt)
    && Number.isFinite(issuedAtSeconds)
    && linkSessionIsRecent(token, nowMs)
    && authenticatedAt >= issuedAtSeconds - 120
    && authenticatedAt <= nowSeconds + 30;
}

function serviceHeaders(extra = {}) {
  const headers = { apikey: SERVICE_KEY, ...extra };
  if (SERVICE_KEY && !SERVICE_KEY.startsWith('sb_secret_')) headers.Authorization = `Bearer ${SERVICE_KEY}`;
  return headers;
}

async function serviceRequest(path, options = {}) {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw httpError(503, 'service_unavailable', 'Client account setup is not configured yet.');
  }
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

async function authenticatedClient(event) {
  const token = bearerToken(event);
  if (!token) return null;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw httpError(503, 'service_unavailable', 'Client account setup is not configured yet.');
  }
  const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` }
  });
  if (!userResponse.ok) return null;
  const user = await userResponse.json().catch(() => null);
  if (!validUuid(user?.id)) return null;

  const accessResponse = await serviceRequest(
    `/rest/v1/platform_users?id=eq.${encodeURIComponent(user.id)}&select=id,organization_id,role,active,must_change_password,initial_password_issued_at,password_changed_at&limit=1`
  );
  const accessRows = await accessResponse.json();
  const access = Array.isArray(accessRows) && accessRows.length === 1 ? accessRows[0] : null;
  if (!access || !validUuid(access.organization_id) || !CLIENT_ROLES.has(access.role)) return null;

  const membershipResponse = await serviceRequest(
    `/rest/v1/client_portal_memberships?user_id=eq.${encodeURIComponent(user.id)}&organization_id=eq.${encodeURIComponent(access.organization_id)}&select=user_id,organization_id,client_id,client_contact_id,active&limit=1`
  );
  const membershipRows = await membershipResponse.json();
  const membership = Array.isArray(membershipRows) && membershipRows.length === 1 ? membershipRows[0] : null;
  if (!membership || membership.user_id !== user.id || membership.organization_id !== access.organization_id
    || !validUuid(membership.client_id) || !validUuid(membership.client_contact_id)) return null;

  const contactResponse = await serviceRequest(
    `/rest/v1/client_contacts?id=eq.${encodeURIComponent(membership.client_contact_id)}&client_id=eq.${encodeURIComponent(membership.client_id)}&organization_id=eq.${encodeURIComponent(access.organization_id)}&select=id,organization_id,client_id,active,portal_login_email,portal_access_status,portal_invite_sent_at,portal_access_activated_at,portal_last_password_reset_sent_at&limit=1`
  );
  const contactRows = await contactResponse.json();
  const contact = Array.isArray(contactRows) && contactRows.length === 1 ? contactRows[0] : null;
  if (!contact || contact.id !== membership.client_contact_id || contact.client_id !== membership.client_id
    || contact.organization_id !== access.organization_id) return null;

  const clientResponse = await serviceRequest(
    `/rest/v1/clients?id=eq.${encodeURIComponent(membership.client_id)}&organization_id=eq.${encodeURIComponent(access.organization_id)}&select=id,organization_id,archived_at&limit=1`
  );
  const clientRows = await clientResponse.json();
  const client = Array.isArray(clientRows) && clientRows.length === 1 ? clientRows[0] : null;
  if (!client || client.id !== membership.client_id || client.organization_id !== access.organization_id) return null;
  const authenticatedEmail = normalizedEmail(user.email);
  const portalLoginEmail = normalizedEmail(contact.portal_login_email);
  if (!authenticatedEmail || !portalLoginEmail || authenticatedEmail !== portalLoginEmail) {
    throw httpError(409, 'login_email_mismatch', 'This secure link no longer matches the Client portal login email. Ask Soro to send a new invitation.');
  }
  return { user, access, membership, contact, client, token };
}

function canonicalTimestamp(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? String(value).trim() : '';
}

function newestTimestamp(...values) {
  const candidates = values
    .map(value => ({ value: canonicalTimestamp(value), time: Date.parse(value || '') }))
    .filter(candidate => candidate.value && Number.isFinite(candidate.time));
  return candidates.reduce((newest, candidate) => (
    !newest || candidate.time > newest.time ? candidate : newest
  ), null)?.value || '';
}

function passwordRequestFingerprint(clientAccount, input, linkIssuedAt) {
  return createHmac('sha256', SERVICE_KEY)
    .update(JSON.stringify({
      action: input.action,
      actorUserId: clientAccount.user.id,
      organizationId: clientAccount.access.organization_id,
      clientContactId: clientAccount.contact.id,
      linkIssuedAt,
      newPassword: input.newPassword
    }))
    .digest('hex');
}

async function rpc(name, body) {
  const response = await serviceRequest(`/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return response.json();
}

function operationPending(message = 'The password change is still being confirmed. Keep this page open and try Save new password again.') {
  const error = httpError(503, 'password_action_pending', message);
  error.retryable = true;
  return error;
}

function operationReconciliationRequired() {
  const error = httpError(
    409,
    'password_action_reconciliation_required',
    'A previous password change is still being reconciled. Retry with the same password, or ask Soro for help before starting another reset.'
  );
  error.retryable = true;
  return error;
}

function terminalOperationResponse(state, result, expectedRequestId) {
  if (!isPlainObject(result)) throw operationPending();
  if (!validUuid(expectedRequestId) || result.requestId !== expectedRequestId) throw operationPending();
  if (state === 'completed') {
    if (result.changed !== true || result.status !== 'active'
      || result.auditLogged !== true || result.auditPending !== false
      || !validUuid(result.requestId)) throw operationPending();
    return json(200, {
      changed: true,
      status: 'active',
      auditLogged: true,
      auditPending: false,
      requestId: result.requestId
    });
  }
  if (state !== 'failed' || result.changed !== false || result.auditLogged !== true
    || result.auditPending !== false || !validUuid(result.requestId)
    || result.retryable !== false) throw operationPending();
  const statusCode = Number.isInteger(result.statusCode) && result.statusCode >= 400 && result.statusCode < 500
    ? result.statusCode
    : 400;
  return json(statusCode, {
    code: String(result.code || 'password_rejected'),
    message: String(result.message || 'The password was not accepted. Choose a different password and try again.'),
    retryable: false
  });
}

async function reservePasswordOperation(clientAccount, input, linkIssuedAt, requestFingerprint) {
  let reservation;
  try {
    reservation = await rpc('reserve_client_account_setup_operation', {
      p_actor_user_id: clientAccount.user.id,
      p_request_id: input.requestId,
      p_client_contact_id: clientAccount.contact.id,
      p_action: input.action,
      p_request_fingerprint: requestFingerprint,
      p_link_issued_at: linkIssuedAt
    });
  } catch (error) {
    console.error('Client password operation reservation is uncertain.', {
      action: input.action, requestId: input.requestId, status: error.status
    });
    throw operationPending();
  }
  const state = String(reservation?.state || '');
  if (state === 'request_conflict') {
    const error = httpError(409, 'request_id_conflict', 'Retry this password request with the same password you entered originally.');
    error.retryable = true;
    throw error;
  }
  if (state === 'reconciliation_required') throw operationReconciliationRequired();
  if (state === 'invalid_state') {
    throw httpError(
      409,
      input.action === 'complete_setup' ? 'setup_not_pending' : 'access_not_active',
      input.action === 'complete_setup'
        ? 'This Client account does not have a current setup invitation.'
        : 'Ask Soro to restore this Client portal account before resetting its password.'
    );
  }
  if (state === 'completed' || state === 'failed') return reservation;
  if (state !== 'claimed' || !validUuid(reservation?.effectiveRequestId)
    || !validUuid(reservation?.leaseToken) || !Number.isInteger(reservation?.attemptCount)
    || typeof reservation?.authCommitConfirmed !== 'boolean') {
    throw operationPending();
  }
  return reservation;
}

function authOperationMarker(operation, requestFingerprint) {
  return Object.freeze({
    request_id: operation.effectiveRequestId,
    request_fingerprint: requestFingerprint
  });
}

function authOperationMatches(user, marker) {
  const recorded = user?.app_metadata?.soro_client_password_operation;
  return isPlainObject(recorded)
    && recorded.request_id === marker.request_id
    && recorded.request_fingerprint === marker.request_fingerprint;
}

async function adminAuthUser(userId) {
  const response = await serviceRequest(`/auth/v1/admin/users/${encodeURIComponent(userId)}`);
  const payload = await response.json();
  const user = isPlainObject(payload?.user) ? payload.user : payload;
  return isPlainObject(user) && user.id === userId ? user : null;
}

function authUpdateErrorIsDefinitive(error) {
  return error?.status === 400 || error?.status === 422;
}

async function updateAuthPassword(clientAccount, newPassword, operation, requestFingerprint) {
  const marker = authOperationMarker(operation, requestFingerprint);
  let currentUser;
  try {
    currentUser = await adminAuthUser(clientAccount.user.id);
  } catch (error) {
    error.operationOutcomeUnknown = true;
    throw error;
  }
  if (!currentUser) throw operationPending();
  if (authOperationMatches(currentUser, marker)) return { recovered: true };

  const existingAppMetadata = isPlainObject(currentUser.app_metadata) ? currentUser.app_metadata : {};
  try {
    const response = await serviceRequest(`/auth/v1/admin/users/${encodeURIComponent(clientAccount.user.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        password: newPassword,
        app_metadata: {
          ...existingAppMetadata,
          soro_client_password_operation: marker
        }
      })
    });
    const payload = await response.json().catch(() => null);
    const updatedUser = isPlainObject(payload?.user) ? payload.user : payload;
    if (authOperationMatches(updatedUser, marker)) return { recovered: false };
  } catch (error) {
    try {
      const reconciledUser = await adminAuthUser(clientAccount.user.id);
      if (authOperationMatches(reconciledUser, marker)) return { recovered: true };
      if (!reconciledUser) error.operationOutcomeUnknown = true;
    } catch (lookupError) {
      error.operationOutcomeUnknown = true;
      console.error('Client Auth password reconciliation lookup failed.', {
        requestId: operation.effectiveRequestId, status: lookupError.status
      });
    }
    throw error;
  }

  try {
    const reconciledUser = await adminAuthUser(clientAccount.user.id);
    if (authOperationMatches(reconciledUser, marker)) return { recovered: true };
  } catch (error) {
    console.error('Client Auth password confirmation lookup failed.', {
      requestId: operation.effectiveRequestId, status: error.status
    });
  }
  throw operationPending();
}

async function confirmAuthCommit(clientAccount, input, operation, requestFingerprint) {
  let result;
  try {
    result = await rpc('confirm_client_account_setup_auth_commit', {
      p_actor_user_id: clientAccount.user.id,
      p_request_id: operation.effectiveRequestId,
      p_client_contact_id: clientAccount.contact.id,
      p_action: input.action,
      p_request_fingerprint: requestFingerprint,
      p_lease_token: operation.leaseToken
    });
  } catch (error) {
    console.error('Client Auth password commit checkpoint is uncertain.', {
      action: input.action, requestId: operation.effectiveRequestId, status: error.status
    });
    throw operationPending();
  }
  if (result?.confirmed !== true) throw operationPending();
}

async function finalizePasswordOperation(clientAccount, input, operation, requestFingerprint, outcome, failureCode = null) {
  try {
    return await rpc('finalize_client_account_setup_operation', {
      p_actor_user_id: clientAccount.user.id,
      p_request_id: operation.effectiveRequestId,
      p_client_contact_id: clientAccount.contact.id,
      p_action: input.action,
      p_request_fingerprint: requestFingerprint,
      p_lease_token: operation.leaseToken,
      p_outcome: outcome,
      p_failure_code: failureCode
    });
  } catch (error) {
    console.error('Client password operation finalization is uncertain.', {
      action: input.action, requestId: operation.effectiveRequestId,
      outcome, status: error.status
    });
    throw operationPending();
  }
}

async function completePasswordAction(clientAccount, input) {
  const tokenAuthenticatedAt = linkAuthenticatedAt(clientAccount.token);
  const linkIssuedAt = input.action === 'complete_setup'
    ? newestTimestamp(clientAccount.access.initial_password_issued_at, clientAccount.contact.portal_invite_sent_at)
    : canonicalTimestamp(clientAccount.contact.portal_last_password_reset_sent_at)
      || (Number.isFinite(tokenAuthenticatedAt) ? new Date(tokenAuthenticatedAt * 1000).toISOString() : '');
  const secureSession = input.action === 'complete_setup'
    ? linkSessionMatchesIssueTime(clientAccount.token, linkIssuedAt)
    : clientAccount.contact.portal_last_password_reset_sent_at
      ? linkSessionMatchesIssueTime(clientAccount.token, linkIssuedAt)
      : linkSessionIsRecent(clientAccount.token);
  if (!linkIssuedAt || !secureSession) {
    throw httpError(
      401,
      'secure_link_required',
      input.action === 'complete_setup'
        ? 'Open the newest secure Client setup link from your email before choosing a password.'
        : 'Open the newest secure Client password-reset link from your email before choosing a password.'
    );
  }

  const requestFingerprint = passwordRequestFingerprint(clientAccount, input, linkIssuedAt);
  const operation = await reservePasswordOperation(clientAccount, input, linkIssuedAt, requestFingerprint);
  if (operation.state === 'completed' || operation.state === 'failed') {
    return terminalOperationResponse(operation.state, operation.result, operation.effectiveRequestId);
  }

  if (operation.authCommitConfirmed !== true) {
    try {
      await updateAuthPassword(clientAccount, input.newPassword, operation, requestFingerprint);
    } catch (error) {
      if (authUpdateErrorIsDefinitive(error) && error.operationOutcomeUnknown !== true) {
        const result = await finalizePasswordOperation(
          clientAccount, input, operation, requestFingerprint, 'failed', 'password_rejected'
        );
        return terminalOperationResponse('failed', result, operation.effectiveRequestId);
      }
      throw operationPending();
    }
    await confirmAuthCommit(clientAccount, input, operation, requestFingerprint);
  }

  const result = await finalizePasswordOperation(
    clientAccount, input, operation, requestFingerprint, 'completed'
  );
  return terminalOperationResponse('completed', result, operation.effectiveRequestId);
}

exports.handler = async event => {
  if (event.httpMethod !== 'POST') {
    return json(405, { code: 'method_not_allowed', message: 'Method not allowed.' });
  }
  try {
    const input = parseBody(event);
    const clientAccount = await authenticatedClient(event);
    if (!clientAccount) {
      return json(403, { code: 'forbidden', message: 'Open the secure Client account link again before continuing.' });
    }
    return await completePasswordAction(clientAccount, input);
  } catch (error) {
    const statusCode = Number.isInteger(error.status) && error.status >= 400 && error.status < 600
      ? error.status
      : 500;
    const hasSafeCode = /^[a-z][a-z0-9_]{2,64}$/.test(String(error?.code || ''));
    const code = hasSafeCode
      ? String(error.code)
      : (statusCode === 500 ? 'password_action_failed' : 'request_failed');
    console.error('Client password completion failed.', { status: statusCode, code });
    return json(statusCode, {
      code,
      ...(error.retryable === true ? { retryable: true } : {}),
      message: statusCode >= 500
        ? (code === 'password_action_pending'
          ? error.message
          : 'The password action could not be completed. Please try again.')
        : hasSafeCode
          ? error.message
          : 'The password request could not be completed. Please try again.'
    });
  }
};

exports.CLIENT_ROLES = CLIENT_ROLES;
exports.LINK_AMR_METHODS = LINK_AMR_METHODS;
exports.LINK_SESSION_MAX_AGE_SECONDS = LINK_SESSION_MAX_AGE_SECONDS;
exports.linkSessionIsRecent = linkSessionIsRecent;
exports.linkSessionMatchesIssueTime = linkSessionMatchesIssueTime;
exports.authOperationMatches = authOperationMatches;
exports.authUpdateErrorIsDefinitive = authUpdateErrorIsDefinitive;
exports.parseBody = parseBody;
exports.passwordRequestFingerprint = passwordRequestFingerprint;
exports.validPassword = validPassword;
