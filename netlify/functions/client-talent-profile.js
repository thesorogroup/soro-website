const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';

// Billing-only accounts intentionally do not receive Talent profile access.
const TALENT_VIEW_ROLES = new Set(['client_admin', 'client_reviewer']);
const TERMINAL_PLACEMENT_STATUSES = new Set([
  'ended', 'complete', 'completed', 'cancelled', 'canceled', 'terminated',
  'closed', 'archived', 'inactive'
]);
const MAX_PLACEMENTS = 500;

const PLACEMENT_SELECT = Object.freeze([
  'id',
  'applicant_id',
  'status',
  'start_date',
  'end_date',
  'schedule_summary'
]);

// This is the complete applicant allowlist for the Client portal. Keep personal
// contact, identity, private application, management, rate, and file fields out.
const TALENT_SELECT = Object.freeze([
  'id',
  'full_name',
  'country',
  'timezone',
  'verified_skills',
  'relevant_experience_years',
  'relevant_experience_summary',
  'education_training_summary',
  'english_test_result',
  'personality_profile_score',
  'computer_specs',
  'internet_speed'
]);

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      Vary: 'Authorization',
      ...extraHeaders
    },
    body: JSON.stringify(body)
  };
}

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
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw httpError(503, 'service_unavailable', 'The assigned Talent service is not configured yet.');
  }
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: serviceHeaders(options.headers || {})
  });
  if (!response.ok) {
    throw httpError(response.status === 401 || response.status === 403 ? 503 : response.status, 'talent_service_error', 'Assigned Talent profiles could not be loaded.');
  }
  return response;
}

async function responseJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function bearerToken(event) {
  const header = event.headers?.authorization || event.headers?.Authorization || '';
  return /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() || '';
}

function hasUnsupportedScope(event) {
  const query = event.queryStringParameters || {};
  return Object.keys(query).length > 0 || Boolean(String(event.body || '').trim());
}

async function authenticatedClient(event) {
  const token = bearerToken(event);
  if (!token) throw httpError(401, 'authentication_required', 'Sign in to view assigned Talent profiles.');
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw httpError(503, 'service_unavailable', 'The assigned Talent service is not configured yet.');
  }

  const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` }
  });
  if (!userResponse.ok) throw httpError(401, 'authentication_required', 'Sign in again to view assigned Talent profiles.');
  const user = await userResponse.json();
  if (!user?.id) throw httpError(401, 'authentication_required', 'Sign in again to view assigned Talent profiles.');

  const accessResponse = await serviceRequest(
    `/rest/v1/platform_users?id=eq.${encodeURIComponent(user.id)}&active=is.true&must_change_password=is.false&select=id,organization_id,role&limit=1`
  );
  const access = (await responseJson(accessResponse) || [])[0];
  if (!access || !TALENT_VIEW_ROLES.has(access.role)) {
    throw httpError(403, 'talent_view_forbidden', 'This Client portal role cannot view Talent profiles.');
  }

  const membershipResponse = await serviceRequest(
    `/rest/v1/client_portal_memberships?user_id=eq.${encodeURIComponent(user.id)}&organization_id=eq.${encodeURIComponent(access.organization_id)}&active=is.true&select=user_id,organization_id,client_id,client_contact_id&limit=2`
  );
  const memberships = await responseJson(membershipResponse) || [];
  if (memberships.length !== 1) {
    throw httpError(404, 'client_membership_not_found', 'Your Client portal membership is not connected yet. Contact a Soro Administrator.');
  }

  const membership = memberships[0];
  const clientResponse = await serviceRequest(
    `/rest/v1/clients?id=eq.${encodeURIComponent(membership.client_id)}&organization_id=eq.${encodeURIComponent(access.organization_id)}&archived_at=is.null&select=id&limit=1`
  );
  const clients = await responseJson(clientResponse) || [];
  if (clients.length !== 1) {
    throw httpError(404, 'client_membership_not_found', 'Your active Client organization could not be found.');
  }

  const contactResponse = await serviceRequest(
    `/rest/v1/client_contacts?id=eq.${encodeURIComponent(membership.client_contact_id)}&client_id=eq.${encodeURIComponent(membership.client_id)}&active=is.true&select=id&limit=1`
  );
  const contacts = await responseJson(contactResponse) || [];
  if (contacts.length !== 1) {
    throw httpError(404, 'client_membership_not_found', 'Your active Client contact could not be found.');
  }

  return { access, membership };
}

function normalizeStatus(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function isCurrentPlacement(placement, today = new Date().toISOString().slice(0, 10)) {
  if (!placement || TERMINAL_PLACEMENT_STATUSES.has(normalizeStatus(placement.status))) return false;
  const endDate = String(placement.end_date || '').trim();
  if (!endDate) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return false;
  return endDate >= today;
}

function nullableText(value) {
  if (typeof value !== 'string') return null;
  return value.trim() || null;
}

function safeSkills(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(nullableText).filter(Boolean))].slice(0, 100);
}

function safeYears(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function publicPlacement(placement) {
  return {
    id: placement.id,
    status: nullableText(placement.status),
    startDate: nullableText(placement.start_date),
    scheduleSummary: nullableText(placement.schedule_summary)
  };
}

function publicTalent(applicant, assignments) {
  return {
    id: applicant.id,
    displayName: nullableText(applicant.full_name) || 'Assigned Talent',
    location: {
      country: nullableText(applicant.country),
      timeZone: nullableText(applicant.timezone)
    },
    skills: {
      verified: safeSkills(applicant.verified_skills)
    },
    experience: {
      years: safeYears(applicant.relevant_experience_years),
      summary: nullableText(applicant.relevant_experience_summary),
      educationAndTraining: nullableText(applicant.education_training_summary)
    },
    screening: {
      englishResult: nullableText(applicant.english_test_result),
      personalityResult: nullableText(applicant.personality_profile_score),
      computerSpecifications: nullableText(applicant.computer_specs),
      internetSpeed: nullableText(applicant.internet_speed)
    },
    assignments: assignments.map(publicPlacement)
  };
}

async function loadAssignedTalents(context, today = new Date().toISOString().slice(0, 10)) {
  const placementResponse = await serviceRequest(
    `/rest/v1/placements?client_id=eq.${encodeURIComponent(context.membership.client_id)}&select=${PLACEMENT_SELECT.join(',')}&order=start_date.desc.nullslast&limit=${MAX_PLACEMENTS + 1}`
  );
  const placementRows = await responseJson(placementResponse) || [];
  if (placementRows.length > MAX_PLACEMENTS) {
    throw httpError(409, 'too_many_assignments', 'Assigned Talent profiles cannot be displayed safely right now. Contact Soro support.');
  }
  const currentPlacements = placementRows.filter(placement => isCurrentPlacement(placement, today));
  if (!currentPlacements.length) return [];

  const applicantIds = [...new Set(currentPlacements.map(placement => placement.applicant_id).filter(Boolean))];
  if (!applicantIds.length) return [];
  const applicantFilter = encodeURIComponent(`(${applicantIds.join(',')})`);
  const applicantResponse = await serviceRequest(
    `/rest/v1/applicants?id=in.${applicantFilter}&organization_id=eq.${encodeURIComponent(context.access.organization_id)}&archived_at=is.null&select=${TALENT_SELECT.join(',')}`
  );
  const applicants = await responseJson(applicantResponse) || [];
  const placementsByApplicant = new Map();
  currentPlacements.forEach(placement => {
    if (!placementsByApplicant.has(placement.applicant_id)) placementsByApplicant.set(placement.applicant_id, []);
    placementsByApplicant.get(placement.applicant_id).push(placement);
  });

  return applicants
    .filter(applicant => placementsByApplicant.has(applicant.id))
    .map(applicant => publicTalent(applicant, placementsByApplicant.get(applicant.id)))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

async function handler(event) {
  const method = String(event.httpMethod || '').toUpperCase();
  if (method !== 'GET') {
    return json(405, { code: 'method_not_allowed', message: 'Method not allowed.' }, { Allow: 'GET' });
  }
  if (hasUnsupportedScope(event)) {
    return json(400, { code: 'unsupported_scope', message: 'Assigned Talent scope is determined by your signed-in Client account.' });
  }

  try {
    const context = await authenticatedClient(event);
    const talents = await loadAssignedTalents(context);
    return json(200, {
      talents,
      count: talents.length,
      presentation: {
        tabs: ['profile'],
        readOnly: true,
        documentsAvailable: false,
        sourceFilesAvailable: false
      }
    });
  } catch (error) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    if (status >= 500) console.error('Assigned Talent request failed.', { status, code: error.code || 'talent_request_failed' });
    return json(status, {
      code: error.code || 'talent_request_failed',
      message: status >= 500 && !error.code ? 'Assigned Talent profiles are temporarily unavailable.' : error.message
    });
  }
}

exports.handler = handler;
exports.TALENT_VIEW_ROLES = TALENT_VIEW_ROLES;
exports.TERMINAL_PLACEMENT_STATUSES = TERMINAL_PLACEMENT_STATUSES;
exports.PLACEMENT_SELECT = PLACEMENT_SELECT;
exports.TALENT_SELECT = TALENT_SELECT;
exports.isCurrentPlacement = isCurrentPlacement;
exports.publicTalent = publicTalent;
exports.loadAssignedTalents = loadAssignedTalents;
