/* Read-only dashboard summary of the existing Client placement workflow. */
const configuredUrl = String(process.env.SUPABASE_URL || '').trim();
const SUPABASE_URL = /^https:\/\/[^/]+\.supabase\.co\/?$/.test(configuredUrl) ? configuredUrl.replace(/\/$/, '') : '';
const SERVICE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '').trim();
const VIEWER_ROLES = new Set(['admin', 'sales_management', 'sales']);
const STATUSES = new Set(['draft', 'discovery', 'open', 'sourcing', 'shortlisting', 'client_review', 'interviewing', 'selection_pending', 'placement_pending', 'partially_filled', 'filled', 'on_hold', 'cancelled']);
const MAX_ROWS = 5000;
const COUNT_FIELDS = ['seatCount', 'candidateCount', 'draftCandidateCount', 'sentCandidateCount', 'selectedCandidateCount', 'interviewRequestedCount', 'interviewCount', 'completedInterviewCount', 'interviewFollowUpCount', 'outcomeDueCount', 'calendarIssueCount', 'calendarPendingCount', 'preparedHandoffCount', 'placementCount', 'activePlacementCount', 'onboardingCount', 'activeContactCount', 'portalContactCount', 'portalDecisionContactCount', 'portalIssueCount'];

function error(status, code, message) { return Object.assign(new Error(message), { status, code }); }
function invalid() { throw error(502, 'tracker_response_invalid', 'The Sales tracker returned an invalid response.'); }
function uuid(value, nullable = false) {
  if (nullable && value === null) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''))) invalid();
  return value.toLowerCase();
}
function text(value, maximum, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) invalid();
  return value;
}
function timestamp(value, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) invalid();
  return value;
}
function date(value) {
  if (value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) invalid();
  return value;
}

function deriveWorkflow(row) {
  let stage;
  if (row.status === 'cancelled') stage = 'cancelled';
  else if (row.status === 'on_hold') stage = 'on_hold';
  else if (row.activePlacementCount >= row.seatCount) stage = 'active';
  else if (row.placementCount >= row.seatCount) stage = row.onboardingCount > 0 ? 'onboarding' : 'placement';
  else if (row.selectedCandidateCount > row.preparedHandoffCount) stage = 'selection';
  else if (row.preparedHandoffCount > 0) stage = 'placement';
  else if (row.interviewCount > 0 || row.interviewRequestedCount > 0 || row.interviewFollowUpCount > 0 || row.calendarPendingCount > 0) stage = 'interviewing';
  else if (row.completedInterviewCount > 0 && row.sentCandidateCount > 0) stage = 'selection';
  else if (row.sentCandidateCount > 0) stage = 'client_review';
  else if (row.draftCandidateCount > 0 || row.placementCount > 0) stage = 'matching';
  else stage = ({ draft: 'discovery', discovery: 'discovery', open: 'matching', sourcing: 'matching', shortlisting: 'matching', client_review: 'client_review', interviewing: 'interviewing', selection_pending: 'selection', placement_pending: 'placement', partially_filled: 'matching', filled: 'placement' })[row.status];

  let nextAction = ({ discovery: 'client_setup', matching: row.draftCandidateCount > 0 ? 'review_shortlist' : 'find_candidates', client_review: 'review_shortlist', interviewing: 'manage_interviews', selection: row.selectedCandidateCount > row.preparedHandoffCount ? 'prepare_handoff' : 'review_selection', placement: 'view_placement', onboarding: 'view_onboarding', active: 'view_placement', on_hold: 'client_setup', cancelled: 'client_setup' })[stage];
  let responsibleRole = ['onboarding', 'placement'].includes(stage) ? 'talent_management'
    : stage === 'client_review' || (stage === 'selection' && nextAction === 'review_selection') ? 'client' : 'sales';
  let attentionCode = null;
  if (!['active', 'on_hold', 'cancelled'].includes(stage)) {
    if (!row.ownerId || !row.ownerActive) attentionCode = 'owner_missing';
    else if (row.activeContactCount === 0) attentionCode = 'contact_missing';
    else if (row.outcomeDueCount > 0) attentionCode = 'interview_outcome_due';
    else if (row.calendarIssueCount > 0) attentionCode = 'calendar_sync_failed';
    else if ((['client_review', 'interviewing'].includes(stage) && row.portalContactCount === 0)
      || (stage === 'selection' && nextAction === 'review_selection' && row.portalDecisionContactCount === 0)) {
      attentionCode = row.portalIssueCount > 0 ? 'portal_delivery_failed' : 'portal_access_needed';
    } else if (row.targetStartDate && row.isTargetStartPast && row.placementCount < row.seatCount) {
      attentionCode = 'start_date_passed';
    }
  }
  if (['owner_missing', 'contact_missing', 'portal_delivery_failed', 'portal_access_needed'].includes(attentionCode)) {
    nextAction = 'client_setup'; responsibleRole = 'sales';
  } else if (['interview_outcome_due', 'calendar_sync_failed'].includes(attentionCode)) {
    nextAction = 'manage_interviews'; responsibleRole = 'sales';
  }
  return { stage, attentionCode, nextAction, responsibleRole };
}

function publicPayload(value) {
  if (!value || !VIEWER_ROLES.has(value.viewerRole) || !Array.isArray(value.rows) || value.rows.length > MAX_ROWS) invalid();
  const generatedAt = timestamp(value.generatedAt);
  const seen = new Set();
  const rows = value.rows.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !STATUSES.has(raw.status)
      || typeof raw.ownerActive !== 'boolean' || typeof raw.isTargetStartPast !== 'boolean') invalid();
    const row = {
      clientId: uuid(raw.clientId), clientName: text(raw.clientName, 160),
      requestId: uuid(raw.requestId), roleTitle: text(raw.roleTitle, 160),
      ownerId: uuid(raw.ownerId, true), ownerName: text(raw.ownerName, 160, true),
      ownerActive: raw.ownerActive, isTargetStartPast: raw.isTargetStartPast, status: raw.status,
      targetStartDate: date(raw.targetStartDate), lastActivityAt: timestamp(raw.lastActivityAt),
      nextInterviewAt: timestamp(raw.nextInterviewAt, true)
    };
    if (seen.has(row.requestId)) invalid();
    seen.add(row.requestId);
    for (const field of COUNT_FIELDS) {
      if (!Number.isSafeInteger(raw[field]) || raw[field] < 0 || raw[field] > 1000000) invalid();
      row[field] = raw[field];
    }
    if (row.seatCount < 1 || row.seatCount > 100 || row.activePlacementCount + row.onboardingCount > row.placementCount
      || row.draftCandidateCount > row.candidateCount || row.sentCandidateCount > row.candidateCount
      || row.selectedCandidateCount > row.candidateCount || row.outcomeDueCount > row.interviewCount
      || row.interviewRequestedCount > row.candidateCount || row.interviewCount > row.candidateCount
      || row.completedInterviewCount > row.candidateCount || row.interviewFollowUpCount > row.candidateCount
      || row.calendarIssueCount > row.candidateCount || row.calendarPendingCount > row.candidateCount
      || row.portalContactCount > row.activeContactCount || row.portalDecisionContactCount > row.portalContactCount
      || (!row.targetStartDate && row.isTargetStartPast)) invalid();
    const workflow = deriveWorkflow(row);
    // Copy only the dashboard contract; raw aggregates and unexpected fields
    // never pass through to the browser.
    return {
      clientId: row.clientId, clientName: row.clientName, requestId: row.requestId,
      roleTitle: row.roleTitle, ownerId: row.ownerId, ownerName: row.ownerName,
      status: row.status, candidateCount: row.candidateCount, interviewCount: row.interviewCount,
      placementCount: row.placementCount, seatCount: row.seatCount,
      activePlacementCount: row.activePlacementCount, onboardingCount: row.onboardingCount,
      targetStartDate: row.targetStartDate, lastActivityAt: row.lastActivityAt,
      nextInterviewAt: row.nextInterviewAt, ...workflow
    };
  });
  return { generatedAt, viewerRole: value.viewerRole, rows };
}

function json(statusCode, body, extra = {}) {
  return { statusCode, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', Vary: 'Authorization', ...extra }, body: JSON.stringify(body) };
}
async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { code: 'method_not_allowed', message: 'Method not allowed.' }, { Allow: 'GET' });
  try {
    if (Object.keys(event.queryStringParameters || {}).length || Object.keys(event.multiValueQueryStringParameters || {}).length
      || String(event.rawQueryString || '').trim() || String(event.body || '').trim()) {
      throw error(400, 'unsupported_scope', 'Sales tracker scope comes from your signed-in account.');
    }
    const token = /^Bearer\s+(.+)$/i.exec(event.headers?.authorization || event.headers?.Authorization || '')?.[1]?.trim();
    if (!token) throw error(401, 'authentication_required', 'Sign in to view the Sales tracker.');
    if (!SUPABASE_URL || !SERVICE_KEY) throw error(503, 'service_unavailable', 'The Sales tracker is not configured yet.');
    const auth = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` } });
    if (!auth.ok) throw [401, 403].includes(auth.status)
      ? error(401, 'authentication_required', 'Sign in again to view the Sales tracker.')
      : error(503, 'service_unavailable', 'The Sales tracker is temporarily unavailable.');
    const user = await auth.json().catch(() => null);
    const actorId = uuid(user?.id);
    const rpc = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_sales_lifecycle_tracker`, {
      method: 'POST', headers: { apikey: SERVICE_KEY, ...(SERVICE_KEY.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${SERVICE_KEY}` }), 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_actor_user_id: actorId })
    });
    const payload = await rpc.json().catch(() => null);
    if (!rpc.ok) {
      if (payload?.code === '42501') throw error(403, 'tracker_forbidden', 'This account cannot view the Sales tracker.');
      if (payload?.code === 'PGRST202' || rpc.status === 404) throw error(503, 'service_unavailable', 'The Sales tracker is not configured yet.');
      throw error(503, 'service_unavailable', 'The Sales tracker is temporarily unavailable.');
    }
    return json(200, publicPayload(payload));
  } catch (failure) {
    const status = Number.isInteger(failure.status) ? failure.status : 500;
    return json(status, { code: failure.code || 'tracker_unavailable', message: status >= 500 ? 'The Sales tracker is temporarily unavailable. Please try again.' : failure.message });
  }
}

exports.handler = handler;
exports.publicPayload = publicPayload;
exports.deriveWorkflow = deriveWorkflow;
exports.MAX_ROWS = MAX_ROWS;
