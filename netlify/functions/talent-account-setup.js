/* Signed-in Talent completion for one-use setup and password-recovery links. */

const configuredUrl = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_URL = /^https:\/\/[^/]+\.supabase\.co\/?$/.test(configuredUrl)
  ? configuredUrl.replace(/\/$/, '')
  : '';
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const LINK_SESSION_MAX_AGE_SECONDS = 2 * 60 * 60;
const LINK_AMR_METHODS = new Set(['email', 'magiclink', 'otp', 'recovery']);
const COMPLETION_ACTIONS = new Set(['complete_setup', 'complete_recovery']);

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  },
  body: JSON.stringify(body)
});

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
  if (!SUPABASE_URL || !SERVICE_KEY) throw httpError(503, 'service_unavailable', 'Talent account setup is not configured yet.');
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

function parseBody(event) {
  try { return event.body ? JSON.parse(event.body) : {}; } catch { throw httpError(400, 'invalid_request', 'The password request could not be read.'); }
}

function bearerToken(event) {
  const header = event.headers.authorization || event.headers.Authorization || '';
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

function validPassword(value) {
  return typeof value === 'string' && value.length >= 12 && value.length <= 128;
}

function normalizedEmail(value) {
  return String(value || '').trim().toLowerCase();
}

async function authenticatedTalent(event) {
  const token = bearerToken(event);
  if (!token) return null;
  if (!SUPABASE_URL || !SERVICE_KEY) throw httpError(503, 'service_unavailable', 'Talent account setup is not configured yet.');
  const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` }
  });
  if (!userResponse.ok) return null;
  const user = await userResponse.json();
  if (!user?.id) return null;

  const accessResponse = await serviceRequest(`/rest/v1/platform_users?id=eq.${encodeURIComponent(user.id)}&select=id,organization_id,role,active,must_change_password,initial_password_issued_at,password_changed_at&limit=1`);
  const access = (await accessResponse.json())[0];
  if (!access || access.role !== 'virtual_assistant') return null;

  const applicantFields = [
    'id', 'organization_id', 'auth_user_id', 'archived_at', 'portal_login_email',
    'portal_access_status', 'portal_invite_sent_at',
    'portal_access_activated_at', 'portal_last_password_reset_sent_at',
    'portal_email_changed_at'
  ].join(',');
  const applicantResponse = await serviceRequest(`/rest/v1/applicants?auth_user_id=eq.${encodeURIComponent(user.id)}&organization_id=eq.${encodeURIComponent(access.organization_id)}&select=${applicantFields}&limit=1`);
  const applicant = (await applicantResponse.json())[0];
  if (!applicant || applicant.organization_id !== access.organization_id) return null;
  if (normalizedEmail(user.email) !== normalizedEmail(applicant.portal_login_email)) {
    throw httpError(409, 'login_email_mismatch', 'This secure link no longer matches the Talent portal login email. Ask Soro to send a new invitation.');
  }
  return { user, access, applicant, token };
}

function publicAccess(applicant) {
  return {
    applicantId: applicant.id,
    authUserId: applicant.auth_user_id,
    loginEmail: applicant.portal_login_email,
    status: applicant.portal_access_status,
    inviteSentAt: applicant.portal_invite_sent_at || null,
    activatedAt: applicant.portal_access_activated_at || null,
    passwordResetSentAt: applicant.portal_last_password_reset_sent_at || null,
    emailChangedAt: applicant.portal_email_changed_at || null,
    availableActions: applicant.portal_access_status === 'active'
      ? ['send_password_reset', 'change_email', 'suspend_access']
      : []
  };
}

function auditNote(eventType, outcome) {
  const action = eventType === 'talent_portal_setup_completed' ? 'Talent portal account setup' : 'Talent portal password recovery';
  if (outcome === 'pending') return `${action} started; the final outcome is pending.`;
  if (outcome === 'failed') return `${action} did not complete and requires review.`;
  return `${action} completed.`;
}

async function beginAuditAction({ talent, eventType }) {
  const response = await serviceRequest('/rest/v1/audit_events?select=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({
      organization_id: talent.access.organization_id,
      actor_user_id: talent.user.id,
      entity_type: 'talent_portal_access',
      entity_id: talent.applicant.id,
      event_type: eventType,
      after_value: { outcome: 'pending' },
      note: auditNote(eventType, 'pending')
    })
  });
  const record = (await response.json())[0];
  if (!record?.id) throw new Error('The password action could not be recorded.');
  return record.id;
}

async function finalizeAuditAction({ auditId, eventType, outcome }) {
  try {
    await serviceRequest(`/rest/v1/audit_events?id=eq.${encodeURIComponent(auditId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({
        after_value: { outcome },
        note: auditNote(eventType, outcome)
      })
    });
    return true;
  } catch (error) {
    console.error('Talent password audit outcome remains pending.', { auditId, eventType, outcome, status: error.status });
    return false;
  }
}

async function updateAuthPassword(userId, newPassword) {
  await serviceRequest(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: newPassword })
  });
}

async function patchApplicant(talent, values) {
  await serviceRequest(`/rest/v1/applicants?id=eq.${encodeURIComponent(talent.applicant.id)}&organization_id=eq.${encodeURIComponent(talent.access.organization_id)}&auth_user_id=eq.${encodeURIComponent(talent.user.id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(values)
  });
}

async function patchAccess(talent, values) {
  await serviceRequest(`/rest/v1/platform_users?id=eq.${encodeURIComponent(talent.user.id)}&organization_id=eq.${encodeURIComponent(talent.access.organization_id)}&role=eq.virtual_assistant`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(values)
  });
}

async function completeSetup(talent, newPassword) {
  if (talent.applicant.archived_at) {
    throw httpError(409, 'talent_archived', 'Ask Soro to restore this Talent profile before completing account setup.');
  }
  if (!talent.access.active || talent.access.must_change_password !== true) {
    throw httpError(409, 'setup_not_pending', 'This Talent account does not have a pending setup invitation.');
  }
  if (!['invite_pending', 'delivery_failed', 'active'].includes(talent.applicant.portal_access_status)) {
    throw httpError(409, 'setup_not_pending', 'Ask Soro to send a new Talent portal invitation.');
  }
  const issuedAt = talent.access.initial_password_issued_at || talent.applicant.portal_invite_sent_at;
  if (!linkSessionMatchesIssueTime(talent.token, issuedAt)) {
    throw httpError(401, 'secure_link_required', 'Open the newest secure setup link from your email before choosing a password.');
  }

  const eventType = 'talent_portal_setup_completed';
  const auditId = await beginAuditAction({ talent, eventType });
  const completedAt = new Date().toISOString();
  const previousStatus = talent.applicant.portal_access_status;
  try {
    await updateAuthPassword(talent.user.id, newPassword);
    await patchApplicant(talent, {
      portal_access_status: 'active',
      portal_access_activated_at: talent.applicant.portal_access_activated_at || completedAt
    });
    // Clear this gate last. Until this write succeeds, current_soro_role()
    // returns null and the recovery-link session cannot read Talent data.
    await patchAccess(talent, { must_change_password: false, password_changed_at: completedAt });
    const auditPending = !await finalizeAuditAction({ auditId, eventType, outcome: 'completed' });
    return json(200, {
      changed: true,
      access: publicAccess({
        ...talent.applicant,
        portal_access_status: 'active',
        portal_access_activated_at: talent.applicant.portal_access_activated_at || completedAt
      }),
      auditLogged: true,
      auditPending
    });
  } catch (error) {
    // Restoring the display state is best effort; the authoritative access
    // gate remains must_change_password=true unless setup completed fully.
    await patchApplicant(talent, { portal_access_status: previousStatus }).catch(() => {});
    await finalizeAuditAction({ auditId, eventType, outcome: 'failed' });
    throw error;
  }
}

async function completeRecovery(talent, newPassword) {
  if (talent.applicant.archived_at) {
    throw httpError(409, 'talent_archived', 'Ask Soro to restore this Talent profile before resetting its password.');
  }
  if (!talent.access.active || talent.access.must_change_password !== false || talent.applicant.portal_access_status !== 'active') {
    throw httpError(409, 'access_not_active', 'Ask Soro to restore this Talent portal account before resetting its password.');
  }
  const managerResetAt = talent.applicant.portal_last_password_reset_sent_at;
  const secureRecoverySession = managerResetAt
    ? linkSessionMatchesIssueTime(talent.token, managerResetAt)
    : linkSessionIsRecent(talent.token);
  if (!secureRecoverySession) {
    throw httpError(401, 'secure_link_required', 'Open the newest secure password-reset link from your email before choosing a password.');
  }

  const eventType = 'talent_portal_password_recovery_completed';
  const auditId = await beginAuditAction({ talent, eventType });
  const completedAt = new Date().toISOString();
  try {
    await updateAuthPassword(talent.user.id, newPassword);
    await patchAccess(talent, { password_changed_at: completedAt });
    const auditPending = !await finalizeAuditAction({ auditId, eventType, outcome: 'completed' });
    return json(200, {
      changed: true,
      access: publicAccess(talent.applicant),
      auditLogged: true,
      auditPending
    });
  } catch (error) {
    await finalizeAuditAction({ auditId, eventType, outcome: 'failed' });
    throw error;
  }
}

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return json(405, { code: 'method_not_allowed', message: 'Method not allowed.' });
  try {
    const body = parseBody(event);
    const action = String(body.action || '').trim();
    if (!COMPLETION_ACTIONS.has(action)) return json(400, { code: 'unsupported_action', message: 'Choose a supported password action.' });
    if (!validPassword(body.newPassword)) return json(400, { code: 'invalid_password', message: 'Your new password must be between 12 and 128 characters.' });
    const talent = await authenticatedTalent(event);
    if (!talent) return json(403, { code: 'forbidden', message: 'Open the secure Talent account link again before continuing.' });
    return action === 'complete_setup'
      ? await completeSetup(talent, body.newPassword)
      : await completeRecovery(talent, body.newPassword);
  } catch (error) {
    console.error('Talent password completion failed.', { status: error.status, code: error.code, message: error.message });
    const statusCode = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    return json(statusCode, {
      code: error.code || (statusCode === 500 ? 'password_action_failed' : 'request_failed'),
      message: statusCode >= 500 ? 'The password action could not be completed. Please try again.' : error.message
    });
  }
};

exports.LINK_AMR_METHODS = LINK_AMR_METHODS;
exports.LINK_SESSION_MAX_AGE_SECONDS = LINK_SESSION_MAX_AGE_SECONDS;
exports.linkAuthenticatedAt = linkAuthenticatedAt;
exports.linkSessionIsRecent = linkSessionIsRecent;
exports.linkSessionMatchesIssueTime = linkSessionMatchesIssueTime;
exports.validPassword = validPassword;
