/* Administrator-only destructive record operations for Soro Ops. */
const crypto = require('node:crypto');

const configuredUrl = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_URL = /^https:\/\/[^/]+\.supabase\.co\/?$/.test(configuredUrl)
  ? configuredUrl.replace(/\/$/, '')
  : 'https://rjtfpveqorggxfgbcxrw.supabase.co';
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const BUCKET = 'soro-private-documents';

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

function serviceHeaders(extra = {}) {
  const headers = { apikey: SERVICE_KEY, ...extra };
  if (SERVICE_KEY && !SERVICE_KEY.startsWith('sb_secret_')) headers.Authorization = `Bearer ${SERVICE_KEY}`;
  return headers;
}

async function serviceRequest(path, options = {}) {
  if (!SERVICE_KEY) throw new Error('The Soro administrative service is not configured.');
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: serviceHeaders(options.headers || {})
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = new Error(detail || `Supabase request failed (${response.status}).`);
    error.status = response.status;
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
    const issuedAt = Number(payload.iat);
    const now = Math.floor(Date.now() / 1000);
    return Number.isFinite(issuedAt) && issuedAt <= now + 30 && now - issuedAt <= maximumAgeSeconds;
  } catch {
    return false;
  }
}

async function requireAdministrator(event) {
  const token = bearerToken(event);
  if (!token) return null;
  const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` }
  });
  if (!userResponse.ok) return null;
  const user = await userResponse.json();
  if (!user?.id) return null;
  const accessResponse = await serviceRequest(`/rest/v1/platform_users?id=eq.${encodeURIComponent(user.id)}&active=is.true&role=eq.admin&select=id,organization_id,role&limit=1`);
  const access = (await accessResponse.json())[0];
  return access ? { user, access, tokenFresh: tokenIssuedRecently(token) } : null;
}

function parseBody(event) {
  try { return event.body ? JSON.parse(event.body) : {}; } catch { return {}; }
}

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function encodedStoragePath(path) {
  return String(path || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

async function removeStorageFiles(documents) {
  const failures = [];
  for (const document of documents) {
    if (!document.storage_path) continue;
    const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodedStoragePath(document.storage_path)}`, {
      method: 'DELETE', headers: serviceHeaders()
    });
    if (!response.ok && response.status !== 404) failures.push(document.storage_path);
  }
  if (failures.length) {
    const error = new Error('One or more private files could not be removed. No profile record was deleted.');
    error.status = 502;
    throw error;
  }
}

async function auditDeletion({ organizationId, actorId, type, id }) {
  const reference = crypto.createHash('sha256').update(`${type}:${id}`).digest('hex').slice(0, 18);
  try {
    await serviceRequest('/rest/v1/audit_events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        organization_id: organizationId,
        actor_user_id: actorId,
        entity_type: type,
        entity_id: id,
        event_type: 'permanent_delete_completed',
        note: `Administrator permanently deleted an eligible ${type} record. Reference ${reference}.`
      })
    });
    return true;
  } catch (error) {
    console.error('Permanent deletion completed but its minimal audit event could not be written.', error);
    return false;
  }
}

async function permanentDelete({ type, id, confirmationName, administrator }) {
  const talent = type === 'talent';
  const table = talent ? 'applicants' : type === 'client' ? 'clients' : '';
  const nameField = talent ? 'full_name' : 'company_name';
  const placementField = talent ? 'applicant_id' : 'client_id';
  const documentField = talent ? 'applicant_id' : 'client_id';
  if (!table) return json(400, { message: 'Choose a supported record type.' });

  const recordResponse = await serviceRequest(`/rest/v1/${table}?id=eq.${encodeURIComponent(id)}&select=id,organization_id,${nameField}&limit=1`);
  const record = (await recordResponse.json())[0];
  if (!record) return json(404, { message: 'This record no longer exists.' });
  if (String(confirmationName || '').trim() !== String(record[nameField] || '').trim()) {
    return json(400, { code: 'confirmation_mismatch', message: 'The confirmation name does not exactly match this record.' });
  }

  const dependencyResponse = await serviceRequest(`/rest/v1/placements?${placementField}=eq.${encodeURIComponent(id)}&select=id,status,start_date,end_date`);
  const placements = await dependencyResponse.json();
  if (placements.length) {
    return json(409, {
      code: 'protected_dependencies',
      message: `This ${type} has ${placements.length} placement record${placements.length === 1 ? '' : 's'} and cannot be permanently deleted. Archive it instead so placement history remains intact.`,
      dependencyCount: placements.length
    });
  }

  const documentsResponse = await serviceRequest(`/rest/v1/documents?${documentField}=eq.${encodeURIComponent(id)}&select=id,storage_path`);
  const documents = await documentsResponse.json();
  await removeStorageFiles(documents);

  await serviceRequest(`/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE', headers: { Prefer: 'return=minimal' }
  });
  const auditLogged = await auditDeletion({
    organizationId: record.organization_id,
    actorId: administrator.user.id,
    type,
    id
  });
  return json(200, { deleted: true, removedPrivateFiles: documents.filter(document => document.storage_path).length, auditLogged });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { message: 'Method not allowed.' });
  try {
    const administrator = await requireAdministrator(event);
    if (!administrator) return json(403, { message: 'Only an active Soro Administrator can permanently delete records.' });
    if (!administrator.tokenFresh) return json(401, { code: 'reauthentication_required', message: 'Re-enter your Soro password before permanently deleting this record.' });
    const body = parseBody(event);
    if (body.action !== 'permanent_delete' || !validUuid(body.id)) return json(400, { message: 'The deletion request is incomplete.' });
    return await permanentDelete({ type: body.type, id: body.id, confirmationName: body.confirmationName, administrator });
  } catch (error) {
    console.error('Administrator record operation failed.', error);
    return json(error.status || 500, { message: error.message || 'The record could not be deleted.' });
  }
};
