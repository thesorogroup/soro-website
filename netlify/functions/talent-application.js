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
const MOBILE_UPLOAD_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const MOBILE_UPLOAD_SIGNING_KEY = (process.env.MOBILE_UPLOAD_SECRET || SERVICE_KEY).trim();
const FORM_VERSION = '2026-08-v2';
const REQUIRED_DOCUMENTS = ['resume', 'english_proof', 'disc_assessment', 'enneagram_assessment', 'mbti_assessment', 'internet_proof', 'equipment_proof'];
const DOCUMENT_TYPES = new Set([...REQUIRED_DOCUMENTS, 'introduction_video']);
const DOCUMENT_FILE_RULES = {
  resume: { extensions: ['pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png'], mimeTypes: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/jpeg', 'image/png'] },
  english_proof: { extensions: ['pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png'], mimeTypes: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/jpeg', 'image/png'] },
  disc_assessment: { extensions: ['pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png'], mimeTypes: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/jpeg', 'image/png'] },
  enneagram_assessment: { extensions: ['pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png'], mimeTypes: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/jpeg', 'image/png'] },
  mbti_assessment: { extensions: ['pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png'], mimeTypes: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/jpeg', 'image/png'] },
  internet_proof: { extensions: ['pdf', 'jpg', 'jpeg', 'png'], mimeTypes: ['application/pdf', 'image/jpeg', 'image/png'] },
  equipment_proof: { extensions: ['pdf', 'jpg', 'jpeg', 'png'], mimeTypes: ['application/pdf', 'image/jpeg', 'image/png'] },
  // H.264 codec compatibility is checked in the browser before the direct upload.
  // The endpoint constrains the video container and its browser-provided MIME type.
  introduction_video: { extensions: ['mp4', 'mov', 'webm'], mimeTypes: ['video/mp4', 'video/quicktime', 'video/webm'] }
};
const EXPERIENCE_AREA_IDS = new Set(['healthcare', 'general_admin', 'social_media', 'customer_support', 'ecommerce', 'other', 'no_prior']);
const SKILL_LABELS_BY_AREA = {
  healthcare: {
    patient_scheduling: 'Patient appointment scheduling and confirmation', patient_intake: 'Patient intake and demographic updates',
    patient_follow_up: 'Patient reminder calls and non-clinical follow-up', insurance_verification: 'Insurance eligibility and benefits verification',
    prior_authorization: 'Prior authorization and referral coordination', medical_billing: 'Medical billing and payment-posting support',
    claims_follow_up: 'Claims preparation and follow-up', medical_coding: 'Medical coding support (ICD-10, CPT, or HCPCS)',
    ehr_updates: 'EHR/EMR data entry and chart maintenance', medical_records: 'Medical-record requests and document routing'
  },
  general_admin: {
    inbox_management: 'Email and inbox management', calendar_management: 'Calendar and appointment scheduling',
    data_entry: 'Data entry and database updates', document_formatting: 'Document preparation and formatting',
    file_organization: 'File and cloud-drive organization', online_research: 'Online research and information gathering',
    meeting_coordination: 'Meeting coordination and note-taking', crm_updates: 'CRM and contact-record maintenance',
    project_tracking: 'Task and project tracking', sop_documentation: 'SOP and process documentation'
  },
  social_media: {
    content_planning: 'Content-calendar planning', copywriting: 'Caption and social-copy writing', graphic_design: 'Static graphic creation',
    short_form_video: 'Short-form video editing', post_scheduling: 'Post scheduling and publishing',
    community_management: 'Comment, message, and community management', inbox_moderation: 'Inbox and comment moderation',
    social_analytics: 'Analytics and performance reporting', keyword_research: 'Hashtag and keyword research',
    paid_social_support: 'Paid-social campaign support'
  },
  customer_support: {
    email_support: 'Email customer support', live_chat_support: 'Live-chat customer support', phone_support: 'Phone customer support',
    helpdesk_systems: 'Ticketing-system management', crm_case_notes: 'CRM and customer-record updates',
    order_support: 'Order or appointment support', complaint_resolution: 'Complaint handling and de-escalation',
    returns_refunds: 'Returns, refunds, or cancellations', customer_follow_up: 'Customer follow-up and retention',
    knowledge_base: 'Knowledge-base or FAQ updates'
  },
  ecommerce: {
    product_listings: 'Product listing creation and updates', order_processing: 'Order processing',
    inventory_updates: 'Inventory monitoring and updates', customer_order_support: 'Customer order support',
    marketplace_management: 'Marketplace management', product_research: 'Product research',
    supplier_coordination: 'Supplier or vendor coordination', shipment_tracking: 'Fulfillment and shipment tracking',
    returns_management: 'Return, refund, and exchange processing', ecommerce_reporting: 'Store-performance and sales reporting'
  }
};
const SKILL_IDS_BY_AREA = Object.fromEntries(Object.entries(SKILL_LABELS_BY_AREA).map(([area, skills]) => [area, new Set(Object.keys(skills))]));

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

function cleanText(value, limit = 4000) {
  return typeof value === 'string' ? value.trim().replace(/\u0000/g, '').slice(0, limit) : '';
}
function cleanStringArray(value, itemLimit = 160, maxItems = 100) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => cleanText(item, itemLimit)).filter(Boolean))].slice(0, maxItems);
}
function compactFormValue(value) {
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return cleanStringArray(value);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [cleanText(key, 80), Array.isArray(item) ? cleanStringArray(item) : cleanText(item)]).filter(([key]) => key));
  }
  return cleanText(value);
}
function compactFormData(data) {
  return Object.fromEntries(Object.entries(data || {}).slice(0, 200).map(([key, value]) => [cleanText(key, 80), compactFormValue(value)]).filter(([key]) => key));
}
function email(value) { return cleanText(value, 254).toLowerCase(); }
function tokenHash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function newToken() { return crypto.randomBytes(32).toString('base64url'); }
function createMobileUploadToken(draftId) {
  if (!MOBILE_UPLOAD_SIGNING_KEY) throw new Error('Secure phone uploads are not configured.');
  const payload = Buffer.from(JSON.stringify({ draftId, purpose: 'mobile-video', expiresAt: Date.now() + MOBILE_UPLOAD_TOKEN_TTL_MS, nonce: crypto.randomBytes(12).toString('base64url') })).toString('base64url');
  const signature = crypto.createHmac('sha256', MOBILE_UPLOAD_SIGNING_KEY).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}
function readMobileUploadToken(value) {
  if (!MOBILE_UPLOAD_SIGNING_KEY || typeof value !== 'string') return null;
  const [payload, signature, extra] = value.split('.');
  if (!payload || !signature || extra) return null;
  const expected = crypto.createHmac('sha256', MOBILE_UPLOAD_SIGNING_KEY).update(payload).digest();
  let supplied;
  try { supplied = Buffer.from(signature, 'base64url'); } catch { return null; }
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (decoded.purpose !== 'mobile-video' || !/^[0-9a-f-]{36}$/i.test(decoded.draftId) || !Number.isFinite(decoded.expiresAt) || decoded.expiresAt < Date.now()) return null;
    return decoded;
  } catch { return null; }
}
function safeFileName(value) { return cleanText(value, 180).replace(/[^a-zA-Z0-9._ -]/g, '_') || 'attachment'; }
function safePath(value) { return safeFileName(value).replace(/\s+/g, '_'); }
function fileExtension(value) {
  const match = cleanText(value, 180).toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}
function allowedFile(documentType, fileName, mimeType, size) {
  const rule = DOCUMENT_FILE_RULES[documentType];
  const normalizedMimeType = cleanText(mimeType, 120).toLowerCase();
  return Boolean(rule)
    && rule.extensions.includes(fileExtension(fileName))
    && (rule.mimeTypes.includes(normalizedMimeType) || normalizedMimeType === 'application/octet-stream')
    && Number.isFinite(size)
    && size > 0
    && size <= MAX_FILE_BYTES;
}
function fileRuleMessage(documentType) {
  if (documentType === 'introduction_video') return 'Use an H.264 MP4, browser-compatible MOV, or WebM video up to 95 MB.';
  if (documentType === 'internet_proof' || documentType === 'equipment_proof') return 'Use a PDF, JPG, JPEG, or PNG file up to 95 MB.';
  return 'Use a PDF, DOC, DOCX, JPG, JPEG, or PNG file up to 95 MB.';
}
function positiveNumber(value) {
  const parsed = Number(cleanText(value, 40));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
function displayNumber(value) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}
function yesNo(value) {
  const normalized = cleanText(value, 8).toLowerCase();
  return normalized === 'yes' || normalized === 'no' ? normalized : '';
}
function yesNoBoolean(value) { return yesNo(value) === 'yes'; }
function yesNoLabel(value) { return yesNoBoolean(value) ? 'Yes' : 'No'; }
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
async function findDraftById(id) {
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const response = await supabase(`/rest/v1/talent_application_drafts?id=eq.${encodeURIComponent(id)}&select=*`);
  return (await response.json())[0] || null;
}
async function findMobileUploadDraft(token) {
  const session = readMobileUploadToken(token);
  if (!session) return null;
  return findDraftById(session.draftId);
}
async function ensureDraft(token, data) {
  let actualToken = token;
  let draft = await findDraft(token);
  const compactData = compactFormData(data);
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
function validateApplication(data) {
  const errors = [];
  const requiredText = {
    firstName: 'first legal name', lastName: 'last / family name', email: 'email address', phone: 'phone / WhatsApp number',
    country: 'country', timezone: 'time zone', addressLine1: 'street address', city: 'city / municipality', provinceRegion: 'province / region',
    currentWorkStatus: 'current work status', availability: 'availability', desiredHours: 'preferred work hours',
    workInterests: 'work interests', education: 'education, certifications, or training', greatestDream: 'biggest dream in life'
  };
  Object.entries(requiredText).forEach(([key, label]) => { if (!cleanText(data[key])) errors.push(label); });
  if (cleanText(data.email) && !isEmail(data.email)) errors.push('valid email address');

  if (cleanText(data.timezone).toLowerCase() === 'other' && !cleanText(data.timezoneOther)) errors.push('other time zone details');
  if (cleanText(data.currentWorkStatus).toLowerCase() === 'other' && !cleanText(data.currentWorkStatusOther)) errors.push('other work status details');

  const rateMin = positiveNumber(data.expectedRateMin);
  const rateMax = positiveNumber(data.expectedRateMax);
  if (rateMin === null) errors.push('positive minimum expected rate');
  else if (!Number.isInteger(rateMin)) errors.push('whole-dollar minimum expected rate');
  if (rateMax === null) errors.push('positive maximum expected rate');
  else if (!Number.isInteger(rateMax)) errors.push('whole-dollar maximum expected rate');
  if (rateMin !== null && rateMax !== null && rateMax < rateMin) errors.push('an expected-rate maximum that is at least the minimum');

  const experienceAreas = cleanStringArray(data.experienceAreas, 40, 12).filter((area) => EXPERIENCE_AREA_IDS.has(area));
  if (!experienceAreas.length) errors.push('at least one previous-work experience area');
  if (experienceAreas.includes('no_prior') && experienceAreas.length > 1) errors.push('either no prior experience or specific experience areas, not both');
  if (experienceAreas.includes('other') && !cleanText(data.experienceOther, 500)) errors.push('other experience specialty');

  const selectedSkillIds = cleanStringArray(data.skillsByCategory, 80, 100);
  const standardAreas = experienceAreas.filter((area) => SKILL_IDS_BY_AREA[area]);
  standardAreas.forEach((area) => {
    if (!selectedSkillIds.some((skillId) => SKILL_IDS_BY_AREA[area].has(skillId))) errors.push(`at least one skill for ${area.replace(/_/g, ' ')}`);
  });
  const invalidSkillIds = selectedSkillIds.filter((skillId) => !standardAreas.some((area) => SKILL_IDS_BY_AREA[area].has(skillId)));
  if (invalidSkillIds.length) errors.push('skills that match the selected work areas');
  const selfReportedSkills = cleanStringArray(selectedSkillIds.map((skillId) => {
    const area = standardAreas.find((areaId) => SKILL_LABELS_BY_AREA[areaId][skillId]);
    return area ? SKILL_LABELS_BY_AREA[area][skillId] : '';
  }), 120, 100);

  if (!yesNo(data.dedicatedWorkspace)) errors.push('dedicated quiet workspace answer');
  const yesNoFields = {
    hasLaptop: 'laptop answer',
    hasNoiseCancelingHeadset: 'noise-canceling headset answer',
    hasReliableInternet: 'reliable internet answer',
    hasBackupInternet: 'backup internet answer',
    hasEmergencyWorkspace: 'emergency backup workspace answer'
  };
  Object.entries(yesNoFields).forEach(([key, label]) => { if (!yesNo(data[key])) errors.push(label); });

  return { errors, rateMin, rateMax, experienceAreas, selfReportedSkills, selectedSkillIds };
}
function applicantDisplayName(data) {
  const first = cleanText(data.firstName, 80);
  const middle = cleanText(data.middleName, 120);
  const last = cleanText(data.lastName, 100);
  return last && first ? `${last}, ${first}${middle ? ` ${middle}` : ''}` : cleanText(data.fullName, 180);
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
    if (!['save_draft', 'load_draft', 'create_mobile_upload', 'load_mobile_upload', 'prepare_upload', 'complete_upload', 'submit'].includes(action)) return json(400, { error: 'Unknown application action.' });

    if (action === 'load_draft') {
      const draft = await findDraft(request.resumeToken);
      if (!draft || draft.completed_at) return json(404, { error: 'This saved application link is no longer available.' });
      return json(200, { data: draft.form_data || {}, uploads: draft.uploaded_documents || [] });
    }

    if (action === 'create_mobile_upload') {
      const draft = await findDraft(request.resumeToken);
      if (!draft || draft.completed_at) return json(404, { error: 'This saved application link is no longer available.' });
      const mobileUploadToken = createMobileUploadToken(draft.id);
      return json(200, { mobileUploadToken, expiresAt: new Date(Date.now() + MOBILE_UPLOAD_TOKEN_TTL_MS).toISOString() });
    }

    if (action === 'load_mobile_upload') {
      const draft = await findMobileUploadDraft(request.mobileUploadToken);
      if (!draft || draft.completed_at) return json(404, { error: 'This secure upload link is no longer available.' });
      const uploads = (draft.uploaded_documents || [])
        .filter((item) => item.documentType === 'introduction_video')
        .map(({ documentType, fileName, size, uploadedAt }) => ({ documentType, fileName, size, uploadedAt }));
      return json(200, { uploads });
    }

    if (action === 'save_draft') {
      const saved = await ensureDraft(request.resumeToken, request.data || {});
      return json(200, { resumeToken: saved.token, resumeUrl: publicResumeUrl(event, saved.token), savedAt: saved.draft.updated_at });
    }

    if (action === 'prepare_upload') {
      let saved;
      if (request.mobileVideoUpload) {
        const draft = await findMobileUploadDraft(request.mobileUploadToken);
        if (!draft || draft.completed_at) return json(404, { error: 'This secure upload link is no longer available. Generate a new QR code from the application on your computer.' });
        saved = { token: null, draft };
      } else {
        saved = await ensureDraft(request.resumeToken, request.data || {});
      }
      const documentType = cleanText(request.documentType, 40);
      const mimeType = cleanText(request.mimeType, 120);
      const size = Number(request.size);
      if (request.mobileVideoUpload && documentType !== 'introduction_video') return json(400, { error: 'This secure link only accepts an introduction video.' });
      if (!DOCUMENT_TYPES.has(documentType)) return json(400, { error: 'This application file type is not supported.' });
      if (!allowedFile(documentType, request.fileName, mimeType, size)) {
        return json(400, { error: fileRuleMessage(documentType) });
      }
      const path = `applications/drafts/${saved.draft.id}/${documentType}/${crypto.randomUUID()}-${safePath(request.fileName)}`;
      const signing = await supabase(`/storage/v1/object/upload/sign/${BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ upsert: false })
      });
      const payload = await signing.json();
      const signedUrl = payload.url?.startsWith('http') ? payload.url : `${SUPABASE_URL}/storage/v1${payload.url || ''}`;
      if (!payload.url) throw new Error('Soro could not prepare this file upload.');
      return json(200, {
        ...(saved.token ? { resumeToken: saved.token, resumeUrl: publicResumeUrl(event, saved.token) } : {}),
        storagePath: path,
        signedUrl
      });
    }

    if (action === 'complete_upload') {
      const draft = request.mobileVideoUpload
        ? await findMobileUploadDraft(request.mobileUploadToken)
        : await findDraft(request.resumeToken);
      if (!draft || draft.completed_at) return json(404, { error: 'Your saved application session is no longer available.' });
      const documentType = cleanText(request.documentType, 40);
      const storagePath = cleanText(request.storagePath, 500);
      if (request.mobileVideoUpload && documentType !== 'introduction_video') return json(400, { error: 'This secure link only accepts an introduction video.' });
      if (!DOCUMENT_TYPES.has(documentType) || !storagePath.startsWith(`applications/drafts/${draft.id}/${documentType}/`)) return json(400, { error: 'This file upload could not be verified.' });
      const mimeType = cleanText(request.mimeType, 120);
      const size = Number(request.size);
      if (!allowedFile(documentType, request.fileName, mimeType, size)) return json(400, { error: fileRuleMessage(documentType) });
      const document = { documentType, storagePath, fileName: safeFileName(request.fileName), mimeType, size, uploadedAt: new Date().toISOString() };
      const uploads = [...(draft.uploaded_documents || []).filter((item) => item.documentType !== documentType), document];
      const draftFilter = request.mobileVideoUpload
        ? `id=eq.${encodeURIComponent(draft.id)}`
        : `resume_token_hash=eq.${tokenHash(request.resumeToken)}`;
      await supabase(`/rest/v1/talent_application_drafts?${draftFilter}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uploaded_documents: uploads })
      });
      return json(200, { uploads });
    }

    const draft = await findDraft(request.resumeToken);
    if (!draft || draft.completed_at) return json(404, { error: 'Your saved application session is no longer available. Please use your saved link or start again.' });
    const data = compactFormData({ ...(draft.form_data || {}), ...(request.data || {}) });
    const validation = validateApplication(data);
    const missing = [...validation.errors];
    if (!data.confirmAccurate || !data.confirmPrivacy || !data.confirmContact) missing.push('required acknowledgements');
    const uploads = draft.uploaded_documents || [];
    const uploadTypes = new Set(uploads.map((item) => item.documentType));
    REQUIRED_DOCUMENTS.forEach((type) => { if (!uploadTypes.has(type)) missing.push(type.replace('_', ' ')); });
    if (missing.length) return json(400, { error: `Please complete: ${[...new Set(missing)].join(', ')}.` });

    const orgId = await organizationId();
    const applicantSearch = await supabase(`/rest/v1/applicants?organization_id=eq.${orgId}&email=eq.${encodeURIComponent(email(data.email))}&select=id&limit=1`);
    let applicant = (await applicantSearch.json())[0];
    const submittedAt = new Date().toISOString();
    const expectedRateText = `$${displayNumber(validation.rateMin)}-$${displayNumber(validation.rateMax)} USD per hour`;
    const otherSkills = validation.experienceAreas.includes('no_prior')
      ? []
      : cleanStringArray(cleanText(data.otherSkills, 1000).split(/[\n,]+/), 160, 50);
    const selfReportedSkills = cleanStringArray([...validation.selfReportedSkills, ...otherSkills], 160, 100);
    const equipmentSummary = `Laptop: ${yesNoLabel(data.hasLaptop)} · Noise-canceling headset: ${yesNoLabel(data.hasNoiseCancelingHeadset)}`;
    const internetSummary = `Reliable internet: ${yesNoLabel(data.hasReliableInternet)} · Backup internet: ${yesNoLabel(data.hasBackupInternet)} · Emergency backup workspace: ${yesNoLabel(data.hasEmergencyWorkspace)}`;
    const submissionFields = {
      full_name: applicantDisplayName(data),
      email: email(data.email),
      phone: cleanText(data.phone, 80),
      location: [cleanText(data.city, 100), cleanText(data.provinceRegion || data.province, 100), cleanText(data.country, 100)].filter(Boolean).join(', '),
      timezone: cleanText(data.timezone, 80),
      timezone_other_detail: cleanText(data.timezoneOther, 160) || null,
      country: cleanText(data.country, 100),
      city: cleanText(data.city, 100),
      province_region: cleanText(data.provinceRegion || data.province, 100),
      address_line_1: cleanText(data.addressLine1, 160),
      postal_code: cleanText(data.postalCode, 24) || null,
      availability_note: cleanText(data.availability, 1000),
      expected_hourly_rate: validation.rateMin,
      expected_hourly_rate_max: validation.rateMax,
      expected_hourly_rate_text: expectedRateText,
      education_level: cleanText(data.education, 500),
      education_training_summary: cleanText(data.education, 4000),
      work_status: cleanText(data.currentWorkStatus, 100),
      work_status_other_detail: cleanText(data.currentWorkStatusOther, 240) || null,
      greatest_dream: cleanText(data.greatestDream, 4000),
      referral_source: cleanText(data.referralSource, 120),
      dedicated_workspace: yesNoBoolean(data.dedicatedWorkspace),
      has_laptop: yesNoBoolean(data.hasLaptop),
      has_noise_canceling_headset: yesNoBoolean(data.hasNoiseCancelingHeadset),
      has_reliable_internet: yesNoBoolean(data.hasReliableInternet),
      has_backup_internet: yesNoBoolean(data.hasBackupInternet),
      has_emergency_workspace: yesNoBoolean(data.hasEmergencyWorkspace),
      equipment_summary: equipmentSummary,
      internet_summary: internetSummary,
      self_reported_experience_areas: validation.experienceAreas,
      self_reported_skills: selfReportedSkills,
      other_experience_specialty: cleanText(data.experienceOther, 500) || null,
      loom_video_url: cleanText(data.loomVideoUrl, 500) || null,
      application_received_at: submittedAt,
      submitted_at: submittedAt
    };
    if (!applicant) {
      const inserted = await supabase('/rest/v1/applicants', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify({
          organization_id: orgId,
          ...submissionFields,
          address_line_2: cleanText(data.addressLine2, 160) || null,
          status: 'submitted', resume_url: null, legacy_application_data: {
            source: 'native_application', form_version: FORM_VERSION, work_background: cleanText(data.workBackground, 4000),
            work_interests: cleanText(data.workInterests, 1500), skills: selfReportedSkills.join(', '), desired_hours: cleanText(data.desiredHours, 80),
            birth_date: cleanText(data.birthDate, 30), first_name: cleanText(data.firstName, 80),
            middle_name: cleanText(data.middleName, 120), last_name: cleanText(data.lastName, 100),
            uploaded_from_native_application: true
          }
        })
      });
      applicant = (await inserted.json())[0];
    } else {
      const updated = await supabase(`/rest/v1/applicants?id=eq.${applicant.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(submissionFields)
      });
      applicant = (await updated.json())[0] || applicant;
    }

    await supabase('/rest/v1/talent_applications', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organization_id: orgId, applicant_id: applicant.id, form_version: FORM_VERSION, raw_submission: data })
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
