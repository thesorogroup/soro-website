/*
 * Admin-only legacy document importer.
 *
 * This function deliberately runs on the server. Google credentials stay in
 * Netlify environment variables and never reach the browser or the public
 * Soro site. Database and storage actions run under the initiating Soro
 * Admin's short-lived session, which is protected by row-level security.
 */
const crypto = require('node:crypto');
// The project URL is public configuration. Keep a safe fallback so an
// accidental paste into Netlify's URL field cannot prevent an Admin from
// running the one-time legacy document import.
const configuredSupabaseUrl = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_URL = /^https:\/\/[^/]+\.supabase\.co\/?$/.test(configuredSupabaseUrl)
  ? configuredSupabaseUrl.replace(/\/$/, '')
  : 'https://rjtfpveqorggxfgbcxrw.supabase.co';
// A publishable key is intentionally safe to ship to the browser. It validates
// the signed-in Admin session; RLS then controls every database and storage
// action performed by this importer.
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_WWbR2hLtAPA_lhyykh3gVQ_H9cVqBDd';
const GOOGLE_DRIVE_CLIENT_ID = process.env.GOOGLE_DRIVE_CLIENT_ID;
const GOOGLE_DRIVE_CLIENT_SECRET = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
const GOOGLE_DRIVE_REFRESH_TOKEN = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
const GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
const BUCKET = 'soro-private-documents';

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

function requiredConfiguration() {
  const missing = [];
  const hasServiceAccount = Boolean(GOOGLE_SERVICE_ACCOUNT_JSON_BASE64);
  const hasOAuthRefresh = [GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET, GOOGLE_DRIVE_REFRESH_TOKEN].every(Boolean);
  if (!hasServiceAccount && !hasOAuthRefresh) missing.push('GOOGLE_SERVICE_ACCOUNT_JSON_BASE64');
  return missing;
}

function extractDriveId(url) {
  if (typeof url !== 'string') return null;
  const match = url.match(/\/d\/([\w-]+)/) || url.match(/[?&]id=([\w-]+)/);
  return match ? match[1] : null;
}

function documentType(key = '') {
  const value = key.toLowerCase();
  if (value.includes('resume')) return 'resume';
  if (value.includes('english')) return 'english_proof';
  if (value.includes('internet')) return 'internet_proof';
  if (value.includes('equipment') || value.includes('device')) return 'equipment_proof';
  if (value.includes('assessment') || value.includes('personality') || value.includes('behavioral')) return 'assessment';
  return 'application_attachment';
}

function collectDriveSources(value, key = '', results = []) {
  if (typeof value === 'string') {
    const urls = value.match(/https?:\/\/[^\s,]+/g) || [];
    for (const url of urls) {
      const fileId = extractDriveId(url);
      if (fileId) results.push({ fileId, sourceUrl: url, documentType: documentType(key) });
    }
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectDriveSources(item, key, results));
  } else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([childKey, childValue]) => collectDriveSources(childValue, childKey, results));
  }
  return results;
}

async function supabase(path, authorization, options = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: authorization,
      ...(options.headers || {})
    }
  });
  if (!response.ok) throw new Error(`Supabase request failed (${response.status}).`);
  return response;
}

async function requireAdmin(event) {
  const authorization = event.headers.authorization || event.headers.Authorization;
  if (!authorization?.startsWith('Bearer ')) return { allowed: false, reason: 'No active Soro sign-in was sent.' };
  const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: authorization }
  });
  if (!userResponse.ok) return { allowed: false, reason: 'Your Soro sign-in has expired. Please sign in again.' };
  const user = await userResponse.json();
  const profileResponse = await supabase(`/rest/v1/platform_users?id=eq.${encodeURIComponent(user.id)}&role=eq.admin&active=eq.true&select=id`, authorization);
  return (await profileResponse.json()).length === 1
    ? { allowed: true, authorization }
    : { allowed: false, reason: 'This Soro account does not have an active Admin role.' };
}

async function getGoogleAccessToken() {
  if (GOOGLE_SERVICE_ACCOUNT_JSON_BASE64) {
    let account;
    try {
      const decoded = Buffer.from(GOOGLE_SERVICE_ACCOUNT_JSON_BASE64.replace(/\s/g, ''), 'base64').toString('utf8');
      account = JSON.parse(decoded);
    } catch {
      throw new Error('The saved Google service-account file is not readable. Its Netlify value needs to be replaced with the original encoded key file.');
    }
    if (!account.client_email || !account.private_key) {
      throw new Error('The saved Google service-account file is missing required credentials.');
    }
    const now = Math.floor(Date.now() / 1000);
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsignedToken = `${encode({ alg: 'RS256', typ: 'JWT', kid: account.private_key_id })}.${encode({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/drive.readonly',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600
    })}`;
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(unsignedToken); signer.end();
    const assertion = `${unsignedToken}.${signer.sign(account.private_key, 'base64url')}`;
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
    });
    if (!response.ok) throw new Error('Soro’s Google service account cannot be authorized.');
    return (await response.json()).access_token;
  }
  const body = new URLSearchParams({
    client_id: GOOGLE_DRIVE_CLIENT_ID,
    client_secret: GOOGLE_DRIVE_CLIENT_SECRET,
    refresh_token: GOOGLE_DRIVE_REFRESH_TOKEN,
    grant_type: 'refresh_token'
  });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
  });
  if (!response.ok) throw new Error('Google Drive authorization needs to be reconnected.');
  return (await response.json()).access_token;
}

async function getDriveFile(fileId, accessToken) {
  const metadataResponse = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,size`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!metadataResponse.ok) throw new Error(`Google Drive file ${fileId} cannot be read.`);
  const metadata = await metadataResponse.json();
  const fileResponse = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!fileResponse.ok) throw new Error(`Google Drive file ${fileId} cannot be downloaded.`);
  return { metadata, bytes: await fileResponse.arrayBuffer() };
}

function safePathPart(value) { return String(value || 'file').replace(/[^a-zA-Z0-9._-]/g, '_'); }

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
  const missing = requiredConfiguration();
  if (missing.length) return json(503, { error: 'Import bridge is not configured.', missing });
  try {
    const adminCheck = await requireAdmin(event);
    if (!adminCheck.allowed) return json(403, { error: adminCheck.reason });
    const requested = event.body ? JSON.parse(event.body) : {};
    const selectedIds = Array.isArray(requested.applicantIds) ? requested.applicantIds : null;
    const offset = Number.isInteger(requested.offset) && requested.offset >= 0 ? requested.offset : 0;
    const batchSize = 1;
    const query = new URLSearchParams({
      select: 'id,organization_id,full_name,resume_url,legacy_application_data',
      order: 'application_received_at.asc'
    });
    if (selectedIds?.length) query.set('id', `in.(${selectedIds.join(',')})`);
    const authorization = adminCheck.authorization;
    const applicants = await (await supabase(`/rest/v1/applicants?${query}`, authorization)).json();
    const workItems = [];
    let loomNeedsArchive = 0;
    for (const applicant of applicants) {
      const sources = collectDriveSources({ resume: applicant.resume_url, ...(applicant.legacy_application_data || {}) });
      const uniqueSources = [...new Map(sources.map((source) => [source.fileId, source])).values()];
      if ((applicant.legacy_application_data?.['Introduction video'] || applicant.legacy_application_data?.['Loom Video']) && applicant.legacy_application_data?.['Introduction video']?.includes('loom.com')) loomNeedsArchive += 1;
      uniqueSources.forEach((source) => workItems.push({ applicant, source }));
    }
    const batch = workItems.slice(offset, offset + batchSize);
    const report = { imported: 0, skipped: 0, failed: [], loomNeedsArchive, total: workItems.length, nextOffset: offset + batch.length };
    if (batch.length) {
      const accessToken = await getGoogleAccessToken();
      for (const { applicant, source } of batch) {
        try {
          const existing = await (await supabase(`/rest/v1/documents?applicant_id=eq.${applicant.id}&external_url=eq.${encodeURIComponent(source.sourceUrl)}&select=id`, authorization)).json();
          if (existing.length) { report.skipped += 1; continue; }
          const { metadata, bytes } = await getDriveFile(source.fileId, accessToken);
          const storagePath = `applicants/${applicant.id}/${source.fileId}-${safePathPart(metadata.name)}`;
          await supabase(`/storage/v1/object/${BUCKET}/${storagePath.split('/').map(encodeURIComponent).join('/')}`, authorization, {
            method: 'POST',
            headers: { 'Content-Type': metadata.mimeType || 'application/octet-stream', 'x-upsert': 'true' },
            body: Buffer.from(bytes)
          });
          await supabase('/rest/v1/documents', authorization, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({
              organization_id: applicant.organization_id,
              applicant_id: applicant.id,
              file_name: metadata.name,
              storage_path: storagePath,
              external_url: source.sourceUrl,
              document_type: source.documentType,
              status: 'uploaded'
            })
          });
          report.imported += 1;
        } catch (error) {
          report.failed.push({ applicant: applicant.full_name, file: source.fileId, message: error.message });
        }
    }
    }
    report.complete = report.nextOffset >= report.total;
    return json(200, report);
  } catch (error) {
    return json(500, { error: error.message || 'Import failed.' });
  }
};
