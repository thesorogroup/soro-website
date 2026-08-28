/* Secure Soro employee provisioning and first-sign-in password replacement. */
const crypto = require('node:crypto');

const configuredUrl = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_URL = /^https:\/\/[^/]+\.supabase\.co\/?$/.test(configuredUrl)
  ? configuredUrl.replace(/\/$/, '')
  : '';
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const TEMPORARY_PASSWORD_TTL_HOURS = 72;
const TEMPORARY_PASSWORD_TTL_MS = TEMPORARY_PASSWORD_TTL_HOURS * 60 * 60 * 1000;
const EMPLOYEE_ROLE_LABELS = Object.freeze({
  admin: 'Administrator',
  talent_management: 'Talent Management',
  sales: 'Sales Associate'
});
const EMPLOYEE_ROLES = new Set(Object.keys(EMPLOYEE_ROLE_LABELS));

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

function serviceHeaders(extra = {}) {
  const headers = { apikey: SERVICE_KEY, ...extra };
  if (SERVICE_KEY && !SERVICE_KEY.startsWith('sb_secret_')) headers.Authorization = `Bearer ${SERVICE_KEY}`;
  return headers;
}

async function serviceRequest(path, options = {}) {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    const error = new Error('The Soro employee service is not configured.');
    error.status = 503;
    throw error;
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

function bearerToken(event) {
  const header = event.headers.authorization || event.headers.Authorization || '';
  return /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() || '';
}

function tokenIssuedRecently(token, maximumAgeSeconds = 300) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    const passwordAuthenticationTimes = Array.isArray(payload.amr)
      ? payload.amr
        .filter(entry => entry?.method === 'password')
        .map(entry => Number(entry.timestamp))
        .filter(Number.isFinite)
      : [];
    const issuedAt = passwordAuthenticationTimes.length
      ? Math.max(...passwordAuthenticationTimes)
      : Number.NaN;
    const now = Math.floor(Date.now() / 1000);
    return Number.isFinite(issuedAt) && issuedAt <= now + 30 && now - issuedAt <= maximumAgeSeconds;
  } catch {
    return false;
  }
}

function parseBody(event) {
  try { return event.body ? JSON.parse(event.body) : {}; } catch { return {}; }
}

async function authenticatedUser(event) {
  const token = bearerToken(event);
  if (!token) return null;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    const error = new Error('The Soro employee service is not configured.');
    error.status = 503;
    throw error;
  }
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` }
  });
  if (!response.ok) return null;
  const user = await response.json();
  if (!user?.id) return null;
  const accessResponse = await serviceRequest(`/rest/v1/platform_users?id=eq.${encodeURIComponent(user.id)}&select=id,organization_id,role,active,must_change_password,initial_password_issued_at&limit=1`);
  const access = (await accessResponse.json())[0];
  return access ? { user, access, token, tokenFresh: tokenIssuedRecently(token) } : null;
}

async function requireAdministrator(event) {
  const authenticated = await authenticatedUser(event);
  const access = authenticated?.access;
  if (!access?.active) return null;
  if (access.role !== 'admin' || access.must_change_password !== false) return null;
  return authenticated;
}

function normalizedText(value, maximum = 160) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maximum);
}

function normalizedEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validEmail(value) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateEmployee(body) {
  const employee = {
    fullName: normalizedText(body.fullName || body.full_name, 120),
    email: normalizedEmail(body.email),
    phone: normalizedText(body.phone, 40),
    hireDate: String(body.hireDate || body.hire_date || '').trim(),
    role: String(body.role || '').trim(),
    addressLine1: normalizedText(body.addressLine1 || body.address_line_1, 160),
    addressLine2: normalizedText(body.addressLine2 || body.address_line_2, 160),
    city: normalizedText(body.city, 100),
    stateRegion: normalizedText(body.stateRegion || body.state_region, 100),
    postalCode: normalizedText(body.postalCode || body.postal_code, 24),
    country: normalizedText(body.country, 100)
  };
  if (employee.fullName.length < 2) return { error: 'Enter the employee’s full name.' };
  if (!validEmail(employee.email)) return { error: 'Enter a valid employee email address.' };
  if (employee.phone.length < 7) return { error: 'Enter the employee’s phone number.' };
  if (!validIsoDate(employee.hireDate) || employee.hireDate > new Date().toISOString().slice(0, 10)) return { error: 'Enter a valid hire date that is not in the future.' };
  if (!EMPLOYEE_ROLES.has(employee.role)) return { error: 'Choose Administrator, Talent Management, or Sales Associate.' };
  if (!employee.addressLine1 || !employee.city || !employee.stateRegion || !employee.postalCode || !employee.country) return { error: 'Complete the employee’s address.' };
  return { employee };
}

function generateTemporaryPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const symbols = '!@#$%';
  const required = [
    'ABCDEFGHJKLMNPQRSTUVWXYZ'[crypto.randomInt(24)],
    'abcdefghijkmnopqrstuvwxyz'[crypto.randomInt(25)],
    '23456789'[crypto.randomInt(8)],
    symbols[crypto.randomInt(symbols.length)]
  ];
  while (required.length < 18) required.push(alphabet[crypto.randomInt(alphabet.length)]);
  for (let index = required.length - 1; index > 0; index -= 1) {
    const swap = crypto.randomInt(index + 1);
    [required[index], required[swap]] = [required[swap], required[index]];
  }
  return required.join('');
}

async function rollbackCreatedAuthUser(userId) {
  try {
    await serviceRequest(`/auth/v1/admin/users/${encodeURIComponent(userId)}?should_soft_delete=false`, { method: 'DELETE' });
    return true;
  } catch (error) {
    console.error('Employee provisioning rollback requires manual review.', { userId, status: error.status });
    return false;
  }
}

function auditNote(eventType, outcome) {
  const action = eventType === 'employee_account_provisioning'
    ? 'employee account provisioning'
    : eventType === 'temporary_password_reissue'
      ? 'temporary-password reissue'
      : 'first-sign-in password replacement';
  if (outcome === 'pending') return `Soro authorized ${action}; the final outcome is pending.`;
  if (outcome === 'failed') return `Soro recorded that ${action} did not complete and requires review.`;
  return `Soro recorded that ${action} completed.`;
}

async function beginAuditAction({ organizationId, actorId, employeeId, eventType, role }) {
  const response = await serviceRequest('/rest/v1/audit_events?select=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({
      organization_id: organizationId,
      actor_user_id: actorId,
      entity_type: 'employee',
      entity_id: employeeId,
      event_type: eventType,
      after_value: { ...(role ? { role } : {}), outcome: 'pending' },
      note: auditNote(eventType, 'pending')
    })
  });
  const record = (await response.json())[0];
  if (!record?.id) throw new Error('The employee security action could not be recorded.');
  return record.id;
}

async function finalizeAuditAction({ auditId, eventType, role, outcome }) {
  try {
    await serviceRequest(`/rest/v1/audit_events?id=eq.${encodeURIComponent(auditId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({
        after_value: { ...(role ? { role } : {}), outcome },
        note: auditNote(eventType, outcome)
      })
    });
    return true;
  } catch (error) {
    // The durable pending record is intentionally retained for reconciliation.
    console.error('Employee security audit outcome remains pending.', { auditId, eventType, outcome, status: error.status });
    return false;
  }
}

function isDuplicateError(error) {
  const detail = String(error?.detail || error?.message || '').toLowerCase();
  return error?.status === 409 || error?.status === 422 || /already|duplicate|unique|registered/.test(detail);
}

async function createEmployee(event) {
  const administrator = await requireAdministrator(event);
  if (!administrator) return json(403, { message: 'Only an active Soro Administrator can add employees.' });
  const validation = validateEmployee(parseBody(event));
  if (validation.error) return json(400, { message: validation.error });
  const employee = validation.employee;
  if (employee.role === 'admin' && !administrator.tokenFresh) {
    return json(401, {
      code: 'reauthentication_required',
      message: 'For security, sign out and sign back in before creating another Administrator.'
    });
  }
  const temporaryPassword = generateTemporaryPassword();
  let authUserId = '';
  let auditId = '';
  let auditPending = false;
  const auditEventType = 'employee_account_provisioning';

  try {
    const authResponse = await serviceRequest('/auth/v1/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: employee.email,
        password: temporaryPassword,
        email_confirm: true,
        user_metadata: { display_name: employee.fullName }
      })
    });
    const authResult = await authResponse.json();
    authUserId = authResult?.user?.id || authResult?.id || '';
    if (!authUserId) throw new Error('Supabase did not return the new employee account.');

    await serviceRequest('/rest/v1/platform_users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({
        id: authUserId,
        organization_id: administrator.access.organization_id,
        role: employee.role,
        display_name: employee.fullName,
        active: false,
        must_change_password: true,
        initial_password_issued_at: new Date().toISOString()
      })
    });

    await serviceRequest('/rest/v1/employee_profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({
        user_id: authUserId,
        organization_id: administrator.access.organization_id,
        full_name: employee.fullName,
        email: employee.email,
        phone: employee.phone,
        hire_date: employee.hireDate,
        address_line_1: employee.addressLine1,
        address_line_2: employee.addressLine2 || null,
        city: employee.city,
        state_region: employee.stateRegion,
        postal_code: employee.postalCode,
        country: employee.country
      })
    });

    // A permission-bearing account does not activate until a durable pending
    // audit record exists. Its final outcome is reconciled after activation.
    auditId = await beginAuditAction({
      organizationId: administrator.access.organization_id,
      actorId: administrator.user.id,
      employeeId: authUserId,
      eventType: auditEventType,
      role: employee.role
    });

    await serviceRequest(`/rest/v1/platform_users?id=eq.${encodeURIComponent(authUserId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ active: true })
    });
    auditPending = !await finalizeAuditAction({
      auditId,
      eventType: auditEventType,
      role: employee.role,
      outcome: 'completed'
    });
  } catch (error) {
    if (auditId) {
      await finalizeAuditAction({ auditId, eventType: auditEventType, role: employee.role, outcome: 'failed' });
    }
    if (authUserId) await rollbackCreatedAuthUser(authUserId);
    if (isDuplicateError(error)) return json(409, { code: 'employee_exists', message: 'An employee account already uses that email address.' });
    throw error;
  }
  return json(201, {
    employee: {
      userId: authUserId,
      fullName: employee.fullName,
      email: employee.email,
      role: employee.role,
      roleLabel: EMPLOYEE_ROLE_LABELS[employee.role]
    },
    temporaryPassword,
    temporaryPasswordExpiresInHours: TEMPORARY_PASSWORD_TTL_HOURS,
    auditLogged: true,
    auditPending
  });
}

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '').trim());
}

async function reissueTemporaryPassword(event) {
  const administrator = await requireAdministrator(event);
  if (!administrator) return json(403, { message: 'Only an active Soro Administrator can generate employee sign-in details.' });
  const userId = String(parseBody(event).userId || '').trim();
  if (!validUuid(userId)) return json(400, { message: 'Choose a valid employee profile.' });

  const organizationId = administrator.access.organization_id;
  const accessResponse = await serviceRequest(`/rest/v1/platform_users?id=eq.${encodeURIComponent(userId)}&organization_id=eq.${encodeURIComponent(organizationId)}&select=id,role,active,must_change_password,initial_password_issued_at&limit=1`);
  const access = (await accessResponse.json())[0];
  if (!access?.active || access.must_change_password !== true || !EMPLOYEE_ROLES.has(access.role)) {
    return json(409, { message: 'New sign-in details can only be generated while an active employee is still completing first sign-in.' });
  }
  if (access.role === 'admin' && !administrator.tokenFresh) {
    return json(401, {
      code: 'reauthentication_required',
      message: 'For security, sign out and sign back in before generating new sign-in details for an Administrator.'
    });
  }
  const profileResponse = await serviceRequest(`/rest/v1/employee_profiles?user_id=eq.${encodeURIComponent(userId)}&organization_id=eq.${encodeURIComponent(organizationId)}&select=full_name,email&limit=1`);
  const profile = (await profileResponse.json())[0];
  if (!profile?.email) return json(404, { message: 'The employee profile could not be found.' });

  const temporaryPassword = generateTemporaryPassword();
  const issuedAt = new Date().toISOString();
  const auditEventType = 'temporary_password_reissue';
  const auditId = await beginAuditAction({
    organizationId,
    actorId: administrator.user.id,
    employeeId: userId,
    eventType: auditEventType,
    role: access.role
  });
  let auditPending = false;
  try {
    await serviceRequest(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: temporaryPassword })
    });
    await serviceRequest(`/rest/v1/platform_users?id=eq.${encodeURIComponent(userId)}&organization_id=eq.${encodeURIComponent(organizationId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ initial_password_issued_at: issuedAt })
    });
    auditPending = !await finalizeAuditAction({
      auditId,
      eventType: auditEventType,
      role: access.role,
      outcome: 'completed'
    });
  } catch (error) {
    await finalizeAuditAction({ auditId, eventType: auditEventType, role: access.role, outcome: 'failed' });
    throw error;
  }
  return json(200, {
    employee: {
      userId,
      fullName: profile.full_name,
      email: profile.email,
      role: access.role,
      roleLabel: EMPLOYEE_ROLE_LABELS[access.role]
    },
    temporaryPassword,
    temporaryPasswordExpiresInHours: TEMPORARY_PASSWORD_TTL_HOURS,
    auditLogged: true,
    auditPending
  });
}

async function verifyCurrentPassword(email, password) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: serviceHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ email, password })
  });
  return response.ok;
}

async function changeInitialPassword(event) {
  const authenticated = await authenticatedUser(event);
  if (!authenticated?.access?.active) return json(401, { message: 'Sign in again before changing your password.' });
  if (authenticated.access.must_change_password !== true) return json(409, { message: 'This account has already completed its first sign-in.' });
  const issuedAt = Date.parse(authenticated.access.initial_password_issued_at || '');
  if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > TEMPORARY_PASSWORD_TTL_MS) {
    return json(410, { code: 'temporary_password_expired', message: 'These temporary sign-in details have expired. Ask a Soro Administrator to generate new ones.' });
  }
  const body = parseBody(event);
  const currentPassword = String(body.currentPassword || '');
  const newPassword = String(body.newPassword || '');
  if (currentPassword.length < 1) return json(400, { message: 'Enter the temporary password you used to sign in.' });
  if (newPassword.length < 12 || newPassword.length > 128) return json(400, { message: 'Your new password must be at least 12 characters.' });
  if (newPassword === currentPassword) return json(400, { message: 'Choose a new password that is different from the temporary password.' });
  if (!await verifyCurrentPassword(authenticated.user.email, currentPassword)) return json(401, { message: 'The temporary password is incorrect.' });

  const auditEventType = 'initial_password_change';
  const auditId = await beginAuditAction({
    organizationId: authenticated.access.organization_id,
    actorId: authenticated.user.id,
    employeeId: authenticated.user.id,
    eventType: auditEventType
  });
  let auditPending = false;
  try {
    await serviceRequest(`/auth/v1/admin/users/${encodeURIComponent(authenticated.user.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: newPassword })
    });
    await serviceRequest(`/rest/v1/platform_users?id=eq.${encodeURIComponent(authenticated.user.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ must_change_password: false, password_changed_at: new Date().toISOString() })
    });
    auditPending = !await finalizeAuditAction({
      auditId,
      eventType: auditEventType,
      outcome: 'completed'
    });
  } catch (error) {
    await finalizeAuditAction({ auditId, eventType: auditEventType, outcome: 'failed' });
    throw error;
  }
  return json(200, { changed: true, auditLogged: true, auditPending });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { message: 'Method not allowed.' });
  try {
    const action = parseBody(event).action;
    if (action === 'create_employee') return await createEmployee(event);
    if (action === 'reissue_temporary_password') return await reissueTemporaryPassword(event);
    if (action === 'change_initial_password') return await changeInitialPassword(event);
    return json(400, { message: 'Choose a supported employee action.' });
  } catch (error) {
    console.error('Soro employee operation failed.', { status: error.status, message: error.message });
    return json(error.status && error.status < 500 ? error.status : 500, {
      message: error.status === 503 ? error.message : 'The employee action could not be completed. Please try again.'
    });
  }
};

exports.EMPLOYEE_ROLE_LABELS = EMPLOYEE_ROLE_LABELS;
exports.TEMPORARY_PASSWORD_TTL_HOURS = TEMPORARY_PASSWORD_TTL_HOURS;
exports.generateTemporaryPassword = generateTemporaryPassword;
exports.tokenIssuedRecently = tokenIssuedRecently;
exports.validateEmployee = validateEmployee;
