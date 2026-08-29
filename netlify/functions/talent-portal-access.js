/* Secure Admin/Talent Management lifecycle controls for Talent portal access. */
const crypto = require('node:crypto');

const configuredUrl = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_URL = /^https:\/\/[^/]+\.supabase\.co\/?$/.test(configuredUrl)
  ? configuredUrl.replace(/\/$/, '')
  : '';
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim();
const FROM_EMAIL = (process.env.TALENT_ACCESS_FROM_EMAIL || process.env.APPLICATION_FROM_EMAIL || '').trim();
const PORTAL_URL = normalizedPortalUrl(
  process.env.TALENT_PORTAL_URL ||
  process.env.APPLICATION_PORTAL_URL ||
  'https://thesorogroup.com/operations/?accountSetup=1'
);
const EMAIL_COOLDOWN_MS = 60 * 1000;
const MANAGER_ROLES = new Set(['admin', 'talent_management']);
const PORTAL_STATUSES = new Set(['not_invited', 'invite_pending', 'active', 'suspended', 'delivery_failed']);
const EVENT_TYPES = Object.freeze({
  activate: 'talent_portal_access_invited',
  resend_invitation: 'talent_portal_invitation_resent',
  change_email: 'talent_portal_login_email_changed',
  send_password_reset: 'talent_portal_password_reset_sent',
  suspend_access: 'talent_portal_access_suspended',
  reactivate_access: 'talent_portal_access_reactivated'
});

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

function normalizedPortalUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error();
    return url.toString();
  } catch {
    return 'https://thesorogroup.com/operations/?accountSetup=1';
  }
}

function serviceHeaders(extra = {}) {
  const headers = { apikey: SERVICE_KEY, ...extra };
  if (SERVICE_KEY && !SERVICE_KEY.startsWith('sb_secret_')) headers.Authorization = `Bearer ${SERVICE_KEY}`;
  return headers;
}

async function serviceRequest(path, options = {}) {
  if (!SUPABASE_URL || !SERVICE_KEY) throw httpError(503, 'service_unavailable', 'Talent portal access is not configured yet.');
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

function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function parseBody(event) {
  try { return event.body ? JSON.parse(event.body) : {}; } catch { throw httpError(400, 'invalid_request', 'The access request could not be read.'); }
}

function bearerToken(event) {
  const header = event.headers.authorization || event.headers.Authorization || '';
  return /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() || '';
}

function jwtPayload(token) {
  try { return JSON.parse(Buffer.from(String(token || '').split('.')[1], 'base64url').toString('utf8')); } catch { return {}; }
}

function tokenPasswordAuthenticatedRecently(token, maximumAgeSeconds = 300) {
  const payload = jwtPayload(token);
  const timestamps = Array.isArray(payload.amr)
    ? payload.amr.filter(entry => entry?.method === 'password').map(entry => Number(entry.timestamp)).filter(Number.isFinite)
    : [];
  const authenticatedAt = timestamps.length ? Math.max(...timestamps) : Number.NaN;
  const now = Math.floor(Date.now() / 1000);
  return Number.isFinite(authenticatedAt) && authenticatedAt <= now + 30 && now - authenticatedAt <= maximumAgeSeconds;
}

async function requireAccessManager(event) {
  const token = bearerToken(event);
  if (!token) return null;
  if (!SUPABASE_URL || !SERVICE_KEY) throw httpError(503, 'service_unavailable', 'Talent portal access is not configured yet.');
  const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` }
  });
  if (!userResponse.ok) return null;
  const user = await userResponse.json();
  if (!user?.id) return null;
  const accessResponse = await serviceRequest(`/rest/v1/platform_users?id=eq.${encodeURIComponent(user.id)}&select=id,organization_id,role,active,must_change_password&limit=1`);
  const access = (await accessResponse.json())[0];
  if (!access?.active || access.must_change_password !== false || !MANAGER_ROLES.has(access.role)) return null;
  return { user, access, token, tokenFresh: tokenPasswordAuthenticatedRecently(token) };
}

function normalizedEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validEmail(value) {
  return value.length >= 3 && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '').trim());
}

function generateUnreturnedSecret() {
  return `${crypto.randomBytes(48).toString('base64url')}!9Aa`;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
}

function ensureEmailDeliveryConfigured() {
  // Resend accepts either an address or a display-name address such as
  // "Soro Group <access@example.com>". Treat this server-owned value as an
  // opaque sender string rather than applying recipient-address validation.
  if (!RESEND_API_KEY || !FROM_EMAIL) {
    throw httpError(503, 'email_unavailable', 'Secure Talent access email is not configured yet.');
  }
}

function emailSentTooRecently(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) && Date.now() - timestamp < EMAIL_COOLDOWN_MS;
}

async function fetchApplicant(manager, applicantId) {
  if (!validUuid(applicantId)) throw httpError(400, 'invalid_applicant', 'Choose a valid Talent profile.');
  const fields = [
    'id', 'organization_id', 'auth_user_id', 'full_name', 'email', 'archived_at',
    'portal_login_email', 'portal_access_status', 'portal_invite_sent_at',
    'portal_access_activated_at', 'portal_last_password_reset_sent_at',
    'portal_email_changed_at', 'portal_access_updated_by'
  ].join(',');
  const response = await serviceRequest(`/rest/v1/applicants?id=eq.${encodeURIComponent(applicantId)}&organization_id=eq.${encodeURIComponent(manager.access.organization_id)}&select=${fields}&limit=1`);
  const applicant = (await response.json())[0];
  if (!applicant) throw httpError(404, 'talent_not_found', 'The Talent profile could not be found.');
  return applicant;
}

async function fetchVaAccess(manager, authUserId) {
  if (!validUuid(authUserId)) return null;
  const response = await serviceRequest(`/rest/v1/platform_users?id=eq.${encodeURIComponent(authUserId)}&organization_id=eq.${encodeURIComponent(manager.access.organization_id)}&select=id,organization_id,role,active,must_change_password,initial_password_issued_at,password_changed_at&limit=1`);
  return (await response.json())[0] || null;
}

async function ensurePortalEmailAvailable(email, applicantId) {
  const response = await serviceRequest(`/rest/v1/applicants?portal_login_email=eq.${encodeURIComponent(email)}&id=neq.${encodeURIComponent(applicantId)}&select=id&limit=1`);
  if ((await response.json()).length) throw httpError(409, 'login_email_in_use', 'That email is already used for another Talent portal account.');
}

async function patchApplicant(manager, applicantId, values) {
  await serviceRequest(`/rest/v1/applicants?id=eq.${encodeURIComponent(applicantId)}&organization_id=eq.${encodeURIComponent(manager.access.organization_id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(values)
  });
}

async function patchPlatformUser(manager, authUserId, values) {
  await serviceRequest(`/rest/v1/platform_users?id=eq.${encodeURIComponent(authUserId)}&organization_id=eq.${encodeURIComponent(manager.access.organization_id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(values)
  });
}

async function createAuthUser(email, displayName) {
  const response = await serviceRequest('/auth/v1/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password: generateUnreturnedSecret(),
      email_confirm: true,
      user_metadata: { display_name: String(displayName || 'Soro Talent').trim(), account_type: 'virtual_assistant' }
    })
  });
  const result = await response.json();
  const userId = result?.user?.id || result?.id || '';
  if (!validUuid(userId)) throw new Error('Supabase did not return the new Talent account.');
  return userId;
}

async function updateAuthUser(authUserId, values) {
  await serviceRequest(`/auth/v1/admin/users/${encodeURIComponent(authUserId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(values)
  });
}

async function deleteAuthUser(authUserId) {
  await serviceRequest(`/auth/v1/admin/users/${encodeURIComponent(authUserId)}?should_soft_delete=false`, { method: 'DELETE' });
}

async function generateRecoveryLink(email) {
  const response = await serviceRequest(`/auth/v1/admin/generate_link?redirect_to=${encodeURIComponent(PORTAL_URL)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'recovery', email, redirect_to: PORTAL_URL })
  });
  const result = await response.json();
  const actionLink = result?.properties?.action_link || result?.action_link || '';
  let parsed;
  try { parsed = new URL(actionLink); } catch { throw new Error('Supabase did not return a secure account link.'); }
  if (parsed.protocol !== 'https:' || parsed.origin !== SUPABASE_URL) throw new Error('Supabase returned an unexpected account link.');
  return actionLink;
}

async function sendAccessEmail({ applicant, to, actionLink, kind }) {
  ensureEmailDeliveryConfigured();
  const firstName = String(applicant.full_name || 'there').trim().split(/\s+/)[0] || 'there';
  const setup = kind !== 'password_reset';
  const subject = setup ? 'Set up your Soro VA Portal access' : 'Reset your Soro VA Portal password';
  const instruction = setup
    ? 'Use the secure button below to create your private password and finish setting up your Soro VA Portal access.'
    : 'Use the secure button below to choose a new password for your Soro VA Portal account.';
  const button = setup ? 'Finish account setup' : 'Reset password';
  const text = `Hi ${firstName},\n\n${instruction}\n\n${actionLink}\n\nIf you were not expecting this email, contact Soro Group. Do not forward this secure one-use link.\n\nSoro Group`;
  const html = `<p>Hi ${escapeHtml(firstName)},</p><p>${escapeHtml(instruction)}</p><p><a href="${escapeHtml(actionLink)}">${escapeHtml(button)}</a></p><p><small>If you were not expecting this email, contact Soro Group. Do not forward this secure one-use link.</small></p><p>Soro Group</p>`;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, text, html })
  });
  if (!response.ok) throw httpError(502, 'email_delivery_failed', 'The secure access email could not be delivered. No password or link was exposed.');
  const result = await response.json().catch(() => ({}));
  return String(result?.id || '');
}

function auditNote(eventType, outcome) {
  const action = Object.entries(EVENT_TYPES).find(([, value]) => value === eventType)?.[0]?.replaceAll('_', ' ') || 'Talent portal access action';
  if (outcome === 'pending') return `Soro authorized ${action}; the final outcome is pending.`;
  if (outcome === 'failed') return `Soro recorded that ${action} did not complete and requires review.`;
  return `Soro recorded that ${action} completed.`;
}

async function beginAuditAction({ manager, applicantId, eventType }) {
  const response = await serviceRequest('/rest/v1/audit_events?select=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({
      organization_id: manager.access.organization_id,
      actor_user_id: manager.user.id,
      entity_type: 'talent_portal_access',
      entity_id: applicantId,
      event_type: eventType,
      after_value: { outcome: 'pending' },
      note: auditNote(eventType, 'pending')
    })
  });
  const record = (await response.json())[0];
  if (!record?.id) throw new Error('The Talent access action could not be recorded.');
  return record.id;
}

async function finalizeAuditAction({ auditId, eventType, outcome, deliveryId = '' }) {
  try {
    await serviceRequest(`/rest/v1/audit_events?id=eq.${encodeURIComponent(auditId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({
        after_value: { outcome, ...(deliveryId ? { delivery_recorded: true } : {}) },
        note: auditNote(eventType, outcome)
      })
    });
    return true;
  } catch (error) {
    console.error('Talent portal audit outcome remains pending.', { auditId, eventType, outcome, status: error.status });
    return false;
  }
}

function derivedStatus(applicant, access) {
  if (!applicant.auth_user_id) return applicant.portal_access_status === 'delivery_failed' ? 'delivery_failed' : 'not_invited';
  if (applicant.archived_at) return 'suspended';
  if (!access || access.role !== 'virtual_assistant') return 'needs_attention';
  if (!access?.active) return 'suspended';
  if (access.must_change_password) return applicant.portal_access_status === 'delivery_failed' ? 'delivery_failed' : 'invite_pending';
  return applicant.portal_access_status === 'suspended' ? 'suspended' : 'active';
}

function availableActionsForStatus(status) {
  if (status === 'not_invited') return ['activate'];
  if (status === 'invite_pending') return ['resend_invitation', 'change_email', 'suspend_access'];
  if (status === 'delivery_failed') return ['resend_invitation', 'change_email', 'suspend_access'];
  if (status === 'active') return ['send_password_reset', 'change_email', 'suspend_access'];
  if (status === 'suspended') return ['reactivate_access'];
  return [];
}

function statusAfterReactivation(access) {
  return access?.must_change_password === true ? 'invite_pending' : 'active';
}

function publicAccess(applicant, access) {
  const status = derivedStatus(applicant, access);
  return {
    applicantId: applicant.id,
    authUserId: applicant.auth_user_id || null,
    loginEmail: applicant.portal_login_email || null,
    status,
    inviteSentAt: applicant.portal_invite_sent_at || null,
    activatedAt: applicant.portal_access_activated_at || null,
    passwordResetSentAt: applicant.portal_last_password_reset_sent_at || null,
    emailChangedAt: applicant.portal_email_changed_at || null,
    availableActions: applicant.archived_at ? [] : availableActionsForStatus(status)
  };
}

function resultBody(applicant, access, { emailDelivered = null, auditLogged = false, auditPending = false } = {}) {
  return { access: publicAccess(applicant, access), emailDelivered, auditLogged, auditPending };
}

function isDuplicateError(error) {
  const detail = String(error?.detail || error?.message || '').toLowerCase();
  return error?.status === 409 || error?.status === 422 || /already|duplicate|unique|registered/.test(detail);
}

async function status(manager, body) {
  const applicant = await fetchApplicant(manager, body.applicantId);
  const access = await fetchVaAccess(manager, applicant.auth_user_id);
  return json(200, resultBody(applicant, access));
}

async function activate(manager, body) {
  ensureEmailDeliveryConfigured();
  const applicant = await fetchApplicant(manager, body.applicantId);
  if (applicant.archived_at) throw httpError(409, 'talent_archived', 'Restore this Talent profile before activating portal access.');
  if (applicant.auth_user_id) throw httpError(409, 'access_exists', 'This Talent profile already has portal access.');
  const email = normalizedEmail(body.email || applicant.portal_login_email || applicant.email);
  if (!validEmail(email)) throw httpError(400, 'invalid_email', 'Enter a valid portal login email.');
  await ensurePortalEmailAvailable(email, applicant.id);
  const eventType = EVENT_TYPES.activate;
  const auditId = await beginAuditAction({ manager, applicantId: applicant.id, eventType });
  const issuedAt = new Date().toISOString();
  let authUserId = '';
  let linked = false;
  try {
    authUserId = await createAuthUser(email, applicant.full_name);
    await serviceRequest('/rest/v1/platform_users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({
        id: authUserId,
        organization_id: manager.access.organization_id,
        role: 'virtual_assistant',
        display_name: applicant.full_name,
        active: true,
        must_change_password: true,
        initial_password_issued_at: issuedAt
      })
    });
    await patchApplicant(manager, applicant.id, {
      auth_user_id: authUserId,
      portal_login_email: email,
      portal_access_status: 'invite_pending',
      portal_invite_sent_at: issuedAt,
      portal_access_updated_by: manager.user.id
    });
    linked = true;
    const actionLink = await generateRecoveryLink(email);
    const deliveryId = await sendAccessEmail({ applicant, to: email, actionLink, kind: 'setup' });
    const auditPending = !await finalizeAuditAction({ auditId, eventType, outcome: 'completed', deliveryId });
    const updated = { ...applicant, auth_user_id: authUserId, portal_login_email: email, portal_access_status: 'invite_pending', portal_invite_sent_at: issuedAt };
    const access = await fetchVaAccess(manager, authUserId);
    return json(201, resultBody(updated, access, { emailDelivered: true, auditLogged: true, auditPending }));
  } catch (error) {
    if (linked) {
      await patchApplicant(manager, applicant.id, { portal_access_status: 'delivery_failed', portal_access_updated_by: manager.user.id }).catch(() => {});
    } else if (authUserId) {
      await deleteAuthUser(authUserId).catch(rollbackError => {
        console.error('Talent Auth rollback requires manual review.', { authUserId, status: rollbackError.status });
      });
    }
    await finalizeAuditAction({ auditId, eventType, outcome: 'failed' });
    if (isDuplicateError(error)) throw httpError(409, 'login_email_in_use', 'That email already belongs to another sign-in account.');
    throw error;
  }
}

async function requireLinkedVa(manager, applicant) {
  if (!applicant.auth_user_id) throw httpError(409, 'access_not_created', 'Activate Talent portal access first.');
  const access = await fetchVaAccess(manager, applicant.auth_user_id);
  if (!access || access.role !== 'virtual_assistant') throw httpError(409, 'access_needs_review', 'The linked portal account needs Administrator review.');
  return access;
}

async function resendInvitation(manager, body) {
  ensureEmailDeliveryConfigured();
  const applicant = await fetchApplicant(manager, body.applicantId);
  if (applicant.archived_at) throw httpError(409, 'talent_archived', 'Restore this Talent profile before resending an invitation.');
  const access = await requireLinkedVa(manager, applicant);
  if (!access.active || access.must_change_password !== true || !['invite_pending', 'delivery_failed'].includes(applicant.portal_access_status)) {
    throw httpError(409, 'invitation_not_pending', 'A new invitation can be sent only while account setup is pending.');
  }
  const email = normalizedEmail(applicant.portal_login_email);
  if (!validEmail(email)) throw httpError(409, 'login_email_missing', 'Choose a portal login email before resending the invitation.');
  if (emailSentTooRecently(applicant.portal_invite_sent_at)) throw httpError(429, 'email_rate_limited', 'Please wait a minute before sending another invitation.');
  const eventType = EVENT_TYPES.resend_invitation;
  const auditId = await beginAuditAction({ manager, applicantId: applicant.id, eventType });
  const issuedAt = new Date().toISOString();
  try {
    await patchPlatformUser(manager, access.id, { initial_password_issued_at: issuedAt });
    await patchApplicant(manager, applicant.id, {
      portal_access_status: 'invite_pending',
      portal_invite_sent_at: issuedAt,
      portal_access_updated_by: manager.user.id
    });
    const actionLink = await generateRecoveryLink(email);
    const deliveryId = await sendAccessEmail({ applicant, to: email, actionLink, kind: 'setup' });
    const auditPending = !await finalizeAuditAction({ auditId, eventType, outcome: 'completed', deliveryId });
    const updated = { ...applicant, portal_access_status: 'invite_pending', portal_invite_sent_at: issuedAt };
    return json(200, resultBody(updated, { ...access, initial_password_issued_at: issuedAt }, { emailDelivered: true, auditLogged: true, auditPending }));
  } catch (error) {
    await patchApplicant(manager, applicant.id, { portal_access_status: 'delivery_failed', portal_access_updated_by: manager.user.id }).catch(() => {});
    await finalizeAuditAction({ auditId, eventType, outcome: 'failed' });
    throw error;
  }
}

async function sendPasswordReset(manager, body) {
  ensureEmailDeliveryConfigured();
  const applicant = await fetchApplicant(manager, body.applicantId);
  if (applicant.archived_at) throw httpError(409, 'talent_archived', 'Restore this Talent profile before sending a password reset.');
  const access = await requireLinkedVa(manager, applicant);
  if (!access.active || access.must_change_password !== false || derivedStatus(applicant, access) !== 'active') {
    throw httpError(409, 'access_not_active', 'Password reset email can be sent only for an active Talent portal account.');
  }
  if (emailSentTooRecently(applicant.portal_last_password_reset_sent_at)) throw httpError(429, 'email_rate_limited', 'Please wait a minute before sending another reset email.');
  const email = normalizedEmail(applicant.portal_login_email);
  if (!validEmail(email)) throw httpError(409, 'login_email_missing', 'This portal account does not have a valid login email.');
  const eventType = EVENT_TYPES.send_password_reset;
  const auditId = await beginAuditAction({ manager, applicantId: applicant.id, eventType });
  const sentAt = new Date().toISOString();
  try {
    await patchApplicant(manager, applicant.id, {
      portal_last_password_reset_sent_at: sentAt,
      portal_access_updated_by: manager.user.id
    });
    const actionLink = await generateRecoveryLink(email);
    const deliveryId = await sendAccessEmail({ applicant, to: email, actionLink, kind: 'password_reset' });
    const auditPending = !await finalizeAuditAction({ auditId, eventType, outcome: 'completed', deliveryId });
    const updated = { ...applicant, portal_last_password_reset_sent_at: sentAt };
    return json(200, resultBody(updated, access, { emailDelivered: true, auditLogged: true, auditPending }));
  } catch (error) {
    await patchApplicant(manager, applicant.id, {
      portal_last_password_reset_sent_at: applicant.portal_last_password_reset_sent_at || null,
      portal_access_updated_by: manager.user.id
    }).catch(() => {});
    await finalizeAuditAction({ auditId, eventType, outcome: 'failed' });
    throw error;
  }
}

async function changeEmail(manager, body) {
  ensureEmailDeliveryConfigured();
  if (!manager.tokenFresh) throw httpError(401, 'reauthentication_required', 'Sign out and sign back in before changing a Talent portal login email.');
  const applicant = await fetchApplicant(manager, body.applicantId);
  if (applicant.archived_at) throw httpError(409, 'talent_archived', 'Restore this Talent profile before changing its login email.');
  if (emailSentTooRecently(applicant.portal_email_changed_at)) throw httpError(429, 'email_rate_limited', 'Please wait a minute before changing the login email again.');
  const access = await requireLinkedVa(manager, applicant);
  if (!access.active) throw httpError(409, 'access_suspended', 'Reactivate this portal account before changing its login email.');
  const email = normalizedEmail(body.email);
  if (!validEmail(email)) throw httpError(400, 'invalid_email', 'Enter a valid portal login email.');
  if (email === normalizedEmail(applicant.portal_login_email)) throw httpError(409, 'email_unchanged', 'Enter a different portal login email.');
  await ensurePortalEmailAvailable(email, applicant.id);
  const eventType = EVENT_TYPES.change_email;
  const auditId = await beginAuditAction({ manager, applicantId: applicant.id, eventType });
  const changedAt = new Date().toISOString();
  let authEmailUpdated = false;
  try {
    await patchPlatformUser(manager, access.id, {
      must_change_password: true,
      initial_password_issued_at: changedAt
    });
    await patchApplicant(manager, applicant.id, {
      portal_login_email: email,
      portal_access_status: 'invite_pending',
      portal_invite_sent_at: changedAt,
      portal_email_changed_at: changedAt,
      portal_access_updated_by: manager.user.id
    });
    await updateAuthUser(access.id, {
      email,
      email_confirm: true,
      password: generateUnreturnedSecret(),
      user_metadata: { display_name: applicant.full_name, account_type: 'virtual_assistant' }
    });
    authEmailUpdated = true;
    const actionLink = await generateRecoveryLink(email);
    const deliveryId = await sendAccessEmail({ applicant, to: email, actionLink, kind: 'setup' });
    const auditPending = !await finalizeAuditAction({ auditId, eventType, outcome: 'completed', deliveryId });
    const updated = {
      ...applicant,
      portal_login_email: email,
      portal_access_status: 'invite_pending',
      portal_invite_sent_at: changedAt,
      portal_email_changed_at: changedAt
    };
    return json(200, resultBody(updated, { ...access, must_change_password: true, initial_password_issued_at: changedAt }, { emailDelivered: true, auditLogged: true, auditPending }));
  } catch (error) {
    if (authEmailUpdated) {
      await patchApplicant(manager, applicant.id, { portal_access_status: 'delivery_failed', portal_access_updated_by: manager.user.id }).catch(() => {});
    } else {
      await patchApplicant(manager, applicant.id, {
        portal_login_email: applicant.portal_login_email,
        portal_access_status: applicant.portal_access_status,
        portal_invite_sent_at: applicant.portal_invite_sent_at,
        portal_email_changed_at: applicant.portal_email_changed_at,
        portal_access_updated_by: manager.user.id
      }).catch(() => {});
      await patchPlatformUser(manager, access.id, {
        must_change_password: access.must_change_password,
        initial_password_issued_at: access.initial_password_issued_at
      }).catch(() => {});
    }
    await finalizeAuditAction({ auditId, eventType, outcome: 'failed' });
    if (isDuplicateError(error)) throw httpError(409, 'login_email_in_use', 'That email already belongs to another sign-in account.');
    throw error;
  }
}

async function suspendAccess(manager, body) {
  const applicant = await fetchApplicant(manager, body.applicantId);
  const access = await requireLinkedVa(manager, applicant);
  if (!access.active && applicant.portal_access_status === 'suspended') return json(200, resultBody(applicant, access));
  const eventType = EVENT_TYPES.suspend_access;
  const auditId = await beginAuditAction({ manager, applicantId: applicant.id, eventType });
  try {
    await patchPlatformUser(manager, access.id, { active: false });
    await patchApplicant(manager, applicant.id, { portal_access_status: 'suspended', portal_access_updated_by: manager.user.id });
    const auditPending = !await finalizeAuditAction({ auditId, eventType, outcome: 'completed' });
    return json(200, resultBody({ ...applicant, portal_access_status: 'suspended' }, { ...access, active: false }, { auditLogged: true, auditPending }));
  } catch (error) {
    await finalizeAuditAction({ auditId, eventType, outcome: 'failed' });
    throw error;
  }
}

async function reactivateAccess(manager, body) {
  const applicant = await fetchApplicant(manager, body.applicantId);
  if (applicant.archived_at) throw httpError(409, 'talent_archived', 'Restore this Talent profile before reactivating portal access.');
  const access = await requireLinkedVa(manager, applicant);
  if (access.active && derivedStatus(applicant, access) === 'active') return json(200, resultBody(applicant, access));
  const eventType = EVENT_TYPES.reactivate_access;
  const auditId = await beginAuditAction({ manager, applicantId: applicant.id, eventType });
  const portalAccessStatus = statusAfterReactivation(access);
  try {
    await patchPlatformUser(manager, access.id, { active: true });
    await patchApplicant(manager, applicant.id, { portal_access_status: portalAccessStatus, portal_access_updated_by: manager.user.id });
    const auditPending = !await finalizeAuditAction({ auditId, eventType, outcome: 'completed' });
    return json(200, resultBody({ ...applicant, portal_access_status: portalAccessStatus }, { ...access, active: true }, { auditLogged: true, auditPending }));
  } catch (error) {
    // Keep the account paused if the applicant lifecycle write fails after
    // the role gate was reopened. This avoids a split state that looks like a
    // pending invitation but cannot be resent.
    await patchPlatformUser(manager, access.id, { active: false }).catch(() => {});
    await finalizeAuditAction({ auditId, eventType, outcome: 'failed' });
    throw error;
  }
}

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return json(405, { code: 'method_not_allowed', message: 'Method not allowed.' });
  try {
    const manager = await requireAccessManager(event);
    if (!manager) return json(403, { code: 'forbidden', message: 'Only active Admin or Talent Management accounts can manage Talent portal access.' });
    const body = parseBody(event);
    const action = String(body.action || '').trim();
    if (action === 'status') return await status(manager, body);
    if (action === 'activate') return await activate(manager, body);
    if (action === 'resend_invitation') return await resendInvitation(manager, body);
    if (action === 'change_email') return await changeEmail(manager, body);
    if (action === 'send_password_reset') return await sendPasswordReset(manager, body);
    if (action === 'suspend_access') return await suspendAccess(manager, body);
    if (action === 'reactivate_access') return await reactivateAccess(manager, body);
    return json(400, { code: 'unsupported_action', message: 'Choose a supported Talent portal access action.' });
  } catch (error) {
    let action = '';
    try { action = String(event.body ? JSON.parse(event.body)?.action || '' : ''); } catch { action = ''; }
    console.error('Talent portal access operation failed.', { action, status: error.status, code: error.code, message: error.message });
    const statusCode = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    return json(statusCode, {
      code: error.code || (statusCode === 500 ? 'access_action_failed' : 'request_failed'),
      message: statusCode >= 500 && error.code !== 'email_unavailable' && error.code !== 'email_delivery_failed'
        ? 'The Talent portal access action could not be completed. Please try again.'
        : error.message
    });
  }
};

exports.EMAIL_COOLDOWN_MS = EMAIL_COOLDOWN_MS;
exports.MANAGER_ROLES = MANAGER_ROLES;
exports.PORTAL_STATUSES = PORTAL_STATUSES;
exports.availableActionsForStatus = availableActionsForStatus;
exports.derivedStatus = derivedStatus;
exports.generateUnreturnedSecret = generateUnreturnedSecret;
exports.normalizedEmail = normalizedEmail;
exports.publicAccess = publicAccess;
exports.statusAfterReactivation = statusAfterReactivation;
exports.tokenPasswordAuthenticatedRecently = tokenPasswordAuthenticatedRecently;
exports.validEmail = validEmail;
