/*
 * Public, native Talent application endpoint.
 *
 * Applicant data and private files never use a public Supabase policy. This
 * function creates short-lived, single-file upload URLs with its service role
 * and writes the final application only after the mandatory checklist passes.
 */
const crypto = require('node:crypto');

const configuredUrl = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_URL = /^https:\/\/[^/]+\.supabase\.co\/?$/.test(configuredUrl)
  ? configuredUrl.replace(/\/$/, '')
  : 'https://rjtfpveqorggxfgbcxrw.supabase.co';
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim();
const APPLICATION_FROM_EMAIL = (process.env.APPLICATION_FROM_EMAIL || '').trim();
const APPLICATION_NOTIFICATION_EMAIL = (process.env.APPLICATION_NOTIFICATION_EMAIL || 'talents@thesorogroup.com').trim();
const APPLICATION_PORTAL_URL = (process.env.APPLICATION_PORTAL_URL || 'https://thesorogroup.com/operations/').trim();
const BUCKET = 'soro-private-documents';
const MAX_FILE_BYTES = 95 * 1024 * 1024;
const REQUIRED_DOCUMENTS = ['resume', 'english_proof', 'disc_assessment', 'enneagram_assessment', 'mbti_assessment', 'internet_proof', 'equipment_proof'];
const DOCUMENT_TYPES = new Set([...REQUIRED_DOCUMENTS, 'introduction_video']);
const ALLOWED_TYPES = new Set([
  'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg', 'image/png', 'video/mp4', 'video/quicktime', 'video/webm'
]);

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

function cleanText(value, limit = 4000) {
  return typeof value === 'string' ? value.trim().replace(/\u0000/g, '').slice(0, limit) : '';
}
function email(value) { return cleanText(value, 254).toLowerCase(); }
function tokenHash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function newToken() { return crypto.randomBytes(32).toString('base64url'); }
function safeFileName(value) { return cleanText(value, 180).replace(/[^a-zA-Z0-9._ -]/g, '_') || 'attachment'; }
function safePath(value) { return safeFileName(value).replace(/\s+/g, '_'); }
function allowedFile(type, size) { return ALLOWED_TYPES.has(type) && Number.isFinite(size) && size > 0 && size <= MAX_FILE_BYTES; }
function parseBody(event) {
  try { return event.body ? JSON.parse(event.body) : {}; } catch { throw new Error('The application request could not be read. Please try again.'); }
}
function publicResumeUrl(event, token) {
  const host = event.headers.host || event.headers.Host || 'thesorogroup.com';
  const protocol = host.startsWith('localhost') ? 'http' : 'https';
  return `${protocol}://${host}/application/?resume=${encodeURIComponent(token)}`;
}
function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email(value));
}
function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
}
async function sendEmail({ to, subject, text, html, replyTo }) {
  if (!RESEND_API_KEY || !APPLICATION_FROM_EMAIL || !isEmail(to)) {
    return {
      delivered: false,
      reason: !RESEND_API_KEY
        ? 'RESEND_API_KEY is not configured.'
        : !APPLICATION_FROM_EMAIL
          ? 'APPLICATION_FROM_EMAIL is not configured.'
          : 'The destination email address is invalid.'
    };
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: APPLICATION_FROM_EMAIL,
      to: [email(to)],
      subject,
      text,
      html,
      ...(isEmail(replyTo) ? { reply_to: email(replyTo) } : {})
    })
  });
  if (!response.ok) throw new Error(`Email notification failed (${response.status}).`);
  return { delivered: true };
}
async function sendApplicationNotifications(data) {
  const applicantName = applicantDisplayName(data) || 'New Talent applicant';
  const applicantEmail = email(data.email);
  const firstName = cleanText(data.firstName, 80) || 'there';
  const safeName = escapeHtml(applicantName);
  const safeEmail = escapeHtml(applicantEmail);
  const safePortalUrl = escapeHtml(APPLICATION_PORTAL_URL);
  const results = await Promise.allSettled([
    sendEmail({
      to: APPLICATION_NOTIFICATION_EMAIL,
      replyTo: applicantEmail,
      subject: `New Talent application: ${applicantName}`,
      text: `A new Talent application was submitted.\n\nApplicant: ${applicantName}\nEmail: ${applicantEmail}\n\nReview the complete application and private files in Soro Ops: ${APPLICATION_PORTAL_URL}\n\nFor privacy, this notification does not include attachments or file links.`,
      html: `<p>A new Talent application was submitted.</p><p><strong>Applicant:</strong> ${safeName}<br><strong>Email:</strong> ${safeEmail}</p><p><a href="${safePortalUrl}">Review securely in Soro Ops</a></p><p><em>For privacy, this notification does not include attachments or file links.</em></p>`
    }),
    sendEmail({
      to: applicantEmail,
      replyTo: APPLICATION_NOTIFICATION_EMAIL,
      subject: 'We received your Soro Group application',
      text: `Hi ${firstName},\n\nThank you for taking this first step with Soro Group. We received your application and stored your information privately. Talent Management will contact you if there is a next step.\n\nSoro Group`,
      html: `<p>Hi ${escapeHtml(firstName)},</p><p>Thank you for taking this first step with Soro Group. We received your application and stored your information privately. Talent Management will contact you if there is a next step.</p><p>Soro Group</p>`
    })
  ]);
  const talentNotificationSent = results[0].status === 'fulfilled' && results[0].value.delivered;
  const applicantConfirmationSent = results[1].status === 'fulfilled' && results[1].value.delivered;
  if (!talentNotificationSent || !applicantConfirmationSent) {
    const reasons = results.map((result) => result.status === 'fulfilled' ? result.value.reason : result.reason?.message).filter(Boolean);
    console.warn('Talent application email notification was skipped.', reasons.join(' '));
  }
  return {
    configured: Boolean(RESEND_API_KEY && APPLICATION_FROM_EMAIL),
    talentNotificationSent,
    applicantConfirmationSent
  };
}
async function supabase(path, options = {}) {
  if (!SERVICE_KEY) throw new Error('The Talent application service is not configured yet.');
  const headers = {
    apikey: SERVICE_KEY,
    ...(options.headers || {})
  };

  // Supabase's current sb_secret_* keys authenticate through the apikey
  // header and are not JWTs. Legacy service_role keys remain JWT-backed and
  // still need the Authorization header for the database role to be applied.
  if (!SERVICE_KEY.startsWith('sb_secret_')) {
    headers.Authorization = `Bearer ${SERVICE_KEY}`;
  }

  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Soro could not save this application (${response.status}).${detail ? ` ${detail.slice(0, 180)}` : ''}`);
  }
  return response;
}
async function findDraft(token) {
  if (!token || typeof token !== 'string' || token.length < 30) return null;
  const hash = tokenHash(token);
  const response = await supabase(`/rest/v1/talent_application_drafts?resume_token_hash=eq.${hash}&select=*`);
  return (await response.json())[0] || null;
}
async function ensureDraft(token, data) {
  let actualToken = token;
  let draft = await findDraft(token);
  const compactData = Object.fromEntries(Object.entries(data || {}).map(([key, value]) => [key, typeof value === 'boolean' ? value : cleanText(value)]));
  if (!draft) {
    actualToken = newToken();
    const row = {
      resume_token_hash: tokenHash(actualToken),
      email: email(compactData.email) || null,
      form_data: compactData
    };
    const created = await supabase('/rest/v1/talent_application_drafts', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(row)
    });
    draft = (await created.json())[0];
  } else {
    const update = await supabase(`/rest/v1/talent_application_drafts?resume_token_hash=eq.${tokenHash(actualToken)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ email: email(compactData.email) || draft.email, form_data: { ...(draft.form_data || {}), ...compactData } })
    });
    draft = (await update.json())[0];
  }
  return { token: actualToken, draft };
}
async function organizationId() {
  const existing = await supabase('/rest/v1/organizations?name=eq.Soro%20Group&select=id&limit=1');
  const row = (await existing.json())[0];
  if (row?.id) return row.id;
  const created = await supabase('/rest/v1/organizations', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ name: 'Soro Group' })
  });
  return (await created.json())[0].id;
}
function requiredFields(data) {
  return ['firstName', 'lastName', 'email', 'phone', 'city', 'provinceRegion', 'availability', 'desiredHours', 'skills', 'workBackground', 'workInterests', 'education', 'expectedRate', 'equipmentSummary', 'internetSummary', 'dedicatedWorkspace', 'greatestDream']
    .filter((key) => !cleanText(data[key]));
}
function applicantDisplayName(data) {
  const first = cleanText(data.firstName, 80);
  const middle = cleanText(data.middleName, 120);
  const last = cleanText(data.lastName, 100);
  return last && first ? `${last}, ${first}${middle ? ` ${middle}` : ''}` : cleanText(data.fullName, 180);
}
function numberValue(value) {
  const parsed = Number(String(value || '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
function documentKind(documentType) {
  return {
    resume: 'resume', english_proof: 'english_proof', disc_assessment: 'disc_assessment',
    enneagram_assessment: 'enneagram_assessment', mbti_assessment: 'mbti_assessment',
    internet_proof: 'internet_proof', equipment_proof: 'equipment_proof', introduction_video: 'introduction_video'
  }[documentType] || 'application_attachment';
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { Allow: 'POST, OPTIONS' }, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
  try {
    const request = parseBody(event);
    const action = request.action;
    if (!['save_draft', 'load_draft', 'prepare_upload', 'complete_upload', 'submit'].includes(action)) return json(400, { error: 'Unknown application action.' });

    if (action === 'load_draft') {
      const draft = await findDraft(request.resumeToken);
      if (!draft || draft.completed_at) return json(404, { error: 'This saved application link is no longer available.' });
      return json(200, { data: draft.form_data || {}, uploads: draft.uploaded_documents || [] });
    }

    if (action === 'save_draft') {
      const saved = await ensureDraft(request.resumeToken, request.data || {});
      return json(200, { resumeToken: saved.token, resumeUrl: publicResumeUrl(event, saved.token), savedAt: saved.draft.updated_at });
    }

    if (action === 'prepare_upload') {
      const saved = await ensureDraft(request.resumeToken, request.data || {});
      const documentType = cleanText(request.documentType, 40);
      const mimeType = cleanText(request.mimeType, 120);
      const size = Number(request.size);
      if (!DOCUMENT_TYPES.has(documentType) || !allowedFile(mimeType, size)) {
        return json(400, { error: 'Use a PDF, Word document, JPG, PNG, MP4, MOV, or WebM file up to 95 MB.' });
      }
      const path = `applications/drafts/${saved.draft.id}/${documentType}/${crypto.randomUUID()}-${safePath(request.fileName)}`;
      const signing = await supabase(`/storage/v1/object/upload/sign/${BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ upsert: false })
      });
      const payload = await signing.json();
      const signedUrl = payload.url?.startsWith('http') ? payload.url : `${SUPABASE_URL}/storage/v1${payload.url || ''}`;
      if (!payload.url) throw new Error('Soro could not prepare this file upload.');
      return json(200, { resumeToken: saved.token, resumeUrl: publicResumeUrl(event, saved.token), storagePath: path, signedUrl });
    }

    if (action === 'complete_upload') {
      const draft = await findDraft(request.resumeToken);
      if (!draft || draft.completed_at) return json(404, { error: 'Your saved application session is no longer available.' });
      const documentType = cleanText(request.documentType, 40);
      const storagePath = cleanText(request.storagePath, 500);
      if (!DOCUMENT_TYPES.has(documentType) || !storagePath.startsWith(`applications/drafts/${draft.id}/${documentType}/`)) return json(400, { error: 'This file upload could not be verified.' });
      const document = { documentType, storagePath, fileName: safeFileName(request.fileName), mimeType: cleanText(request.mimeType, 120), size: Number(request.size) || null, uploadedAt: new Date().toISOString() };
      const uploads = [...(draft.uploaded_documents || []).filter((item) => item.documentType !== documentType), document];
      await supabase(`/rest/v1/talent_application_drafts?resume_token_hash=eq.${tokenHash(request.resumeToken)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uploaded_documents: uploads })
      });
      return json(200, { uploads });
    }

    const draft = await findDraft(request.resumeToken);
    if (!draft || draft.completed_at) return json(404, { error: 'Your saved application session is no longer available. Please use your saved link or start again.' });
    const data = { ...(draft.form_data || {}), ...(request.data || {}) };
    const missing = requiredFields(data);
    if (!data.confirmAccurate || !data.confirmPrivacy || !data.confirmContact) missing.push('required acknowledgements');
    const uploads = draft.uploaded_documents || [];
    const uploadTypes = new Set(uploads.map((item) => item.documentType));
    REQUIRED_DOCUMENTS.forEach((type) => { if (!uploadTypes.has(type)) missing.push(type.replace('_', ' ')); });
    if (missing.length) return json(400, { error: `Please complete: ${[...new Set(missing)].join(', ')}.` });

    const orgId = await organizationId();
    const applicantSearch = await supabase(`/rest/v1/applicants?organization_id=eq.${orgId}&email=eq.${encodeURIComponent(email(data.email))}&select=id&limit=1`);
    let applicant = (await applicantSearch.json())[0];
    if (!applicant) {
      const inserted = await supabase('/rest/v1/applicants', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify({
          organization_id: orgId, full_name: applicantDisplayName(data), email: email(data.email), phone: cleanText(data.phone, 80),
          location: [cleanText(data.city, 100), cleanText(data.provinceRegion || data.province, 100), cleanText(data.country, 100) || 'Philippines'].filter(Boolean).join(', '), timezone: cleanText(data.timezone, 80) || 'Asia/Manila',
          country: cleanText(data.country, 100) || 'Philippines', city: cleanText(data.city, 100), province_region: cleanText(data.provinceRegion || data.province, 100), address_line_1: cleanText(data.addressLine1, 160) || null,
          address_line_2: cleanText(data.addressLine2, 160) || null, postal_code: cleanText(data.postalCode, 24) || null,
          status: 'submitted', submitted_at: new Date().toISOString(), availability_note: cleanText(data.availability, 1000),
          expected_hourly_rate: numberValue(data.expectedRate), education_level: cleanText(data.education, 500), work_status: cleanText(data.currentWorkStatus, 100),
          greatest_dream: cleanText(data.greatestDream, 4000), referral_source: cleanText(data.referralSource, 120),
          dedicated_workspace: data.dedicatedWorkspace === 'yes', equipment_summary: cleanText(data.equipmentSummary, 1000),
          internet_summary: cleanText(data.internetSummary, 1000), english_proficiency: cleanText(data.englishProficiency, 120),
          assessment_summary: cleanText(data.personalitySummary, 1000), loom_video_url: cleanText(data.loomVideoUrl, 500) || null,
          resume_url: null, legacy_application_data: {
            source: 'native_application', form_version: '2026-08', work_background: cleanText(data.workBackground, 4000),
            work_interests: cleanText(data.workInterests, 1500), skills: cleanText(data.skills, 2000), desired_hours: cleanText(data.desiredHours, 80),
            birth_date: cleanText(data.birthDate, 30), first_name: cleanText(data.firstName, 80),
            middle_name: cleanText(data.middleName, 120), last_name: cleanText(data.lastName, 100),
            uploaded_from_native_application: true
          }
        })
      });
      applicant = (await inserted.json())[0];
    }

    await supabase('/rest/v1/talent_applications', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organization_id: orgId, applicant_id: applicant.id, raw_submission: data })
    });
    const documents = uploads.map((item) => ({ organization_id: orgId, applicant_id: applicant.id, file_name: item.fileName, storage_path: item.storagePath, document_type: documentKind(item.documentType), status: 'uploaded' }));
    if (!uploadTypes.has('introduction_video') && cleanText(data.loomVideoUrl)) documents.push({ organization_id: orgId, applicant_id: applicant.id, file_name: 'Loom introduction video', external_url: cleanText(data.loomVideoUrl), document_type: 'introduction_video', status: 'uploaded' });
    if (documents.length) await supabase('/rest/v1/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(documents) });
    await supabase(`/rest/v1/talent_application_drafts?resume_token_hash=eq.${tokenHash(request.resumeToken)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ completed_at: new Date().toISOString(), applicant_id: applicant.id, form_data: data })
    });
    let notificationStatus = { configured: false, talentNotificationSent: false, applicantConfirmationSent: false };
    try {
      notificationStatus = await sendApplicationNotifications(data);
    } catch (notificationError) {
      console.warn('Talent application email notification was not delivered.', notificationError.message);
    }
    return json(201, {
      ok: true,
      applicantId: applicant.id,
      notifications: notificationStatus,
      message: notificationStatus.applicantConfirmationSent
        ? 'Your application has been received. Please check your inbox for a confirmation.'
        : 'Your application has been received. Soro Talent Management will contact you if a next step is needed.'
    });
  } catch (error) {
    console.error('Native talent application error', error);
    return json(500, { error: error.message || 'Soro could not save this application. Please try again.' });
  }
};
