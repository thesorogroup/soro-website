/* Authenticated Talent application review queue for Admin and Talent Management. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.soroTalentReviewQueue = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const ENDPOINT = '/.netlify/functions/talent-review-queue';
  const VERIFICATION_ENDPOINT = '/.netlify/functions/talent-verification';
  const AUTHORIZED_ROLES = new Set(['admin', 'talent_management']);
  const STAGES = Object.freeze(['submitted', 'in_review', 'needs_more_info', 'bench_ready', 'closed']);
  const RECORD_STAGES = Object.freeze(['submitted', 'in_review', 'needs_more_info', 'bench_ready', 'declined']);
  const FILTER_STAGE_SET = new Set(STAGES);
  const STAGE_SET = new Set(RECORD_STAGES);
  const CHECKLIST_STATES = new Set(['complete', 'missing', 'needs_review']);
  const ACTIONS = Object.freeze([
    'begin_review', 'request_more_info', 'mark_bench_ready', 'return_to_review',
    'decline', 'archive', 'restore', 'reopen'
  ]);
  const ACTION_SET = new Set(ACTIONS);
  const INTERVIEW_STATUSES = new Set(['scheduled', 'completed', 'cancelled', 'no_show', 'waived']);
  const INTERVIEW_OUTCOMES = new Set(['recommended', 'follow_up', 'not_recommended']);
  const CALENDAR_STATUSES = new Set(['connection_required', 'pending', 'synced', 'sync_failed', 'not_applicable']);
  const REFERENCE_OUTCOMES = new Set(['pending', 'verified', 'discrepancy', 'unable_to_reach', 'not_provided']);
  const REFERENCE_METHODS = new Set(['phone', 'email', 'other']);
  const REFERENCE_RESULTS = new Set(['reached', 'no_answer', 'voicemail', 'wrong_number', 'bounced', 'other']);
  const NOTE_REQUIRED_ACTIONS = new Set(['request_more_info', 'decline', 'archive']);
  const SECONDARY_ACTIONS = new Set(['decline', 'archive', 'restore']);
  const CONFIRM_ACTIONS = new Set(['decline', 'archive', 'restore']);
  const STAGE_LABELS = Object.freeze({
    all: 'All',
    submitted: 'New applications',
    in_review: 'In review',
    needs_more_info: 'Needs more information',
    bench_ready: 'Bench ready',
    closed: 'Closed'
  });
  const ACTION_LABELS = Object.freeze({
    begin_review: 'Start review',
    request_more_info: 'Request more information',
    mark_bench_ready: 'Mark bench ready',
    return_to_review: 'Return to review',
    decline: 'Decline',
    archive: 'Archive',
    restore: 'Restore',
    reopen: 'Reopen review'
  });

  let mountedRoot = null;
  let queue = emptyQueue();
  let filters = Object.freeze({ stage: 'all', search: '' });
  let activeController = null;
  let activeVerificationController = null;
  let requestVersion = 0;
  let verificationRequestVersion = 0;
  let actionContext = null;
  let verificationContext = null;
  const verificationGateCache = new Map();
  let feedback = Object.freeze({ type: '', message: '' });

  function text(value, max = 200) {
    return String(value ?? '').trim().slice(0, max);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    }[character]));
  }

  function normalizedRole(value) {
    return text(value, 50).toLowerCase();
  }

  function actualRole(access = root?.soroCurrentAccess) {
    return normalizedRole(access?.role);
  }

  function actualUserId(access = root?.soroCurrentAccess) {
    return validUuid(access?.user_id || access?.userId, { optional: true });
  }

  function canOpenForRole(roleValue = actualRole()) {
    return AUTHORIZED_ROLES.has(normalizedRole(roleValue));
  }

  const canUse = canOpenForRole;

  function validUuid(value, { optional = false } = {}) {
    const normalized = text(value, 64);
    if (optional && !normalized) return '';
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)
      ? normalized
      : '';
  }

  function validTimestamp(value, { optional = false } = {}) {
    const normalized = text(value, 50);
    if (optional && !normalized) return '';
    return normalized && Number.isFinite(new Date(normalized).getTime()) ? normalized : '';
  }

  function nonNegativeInteger(value) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }

  function emptySummary() {
    return Object.freeze({ all: 0, submitted: 0, in_review: 0, needs_more_info: 0, bench_ready: 0, closed: 0 });
  }

  function emptyQueue() {
    return Object.freeze({
      phase: 'idle', generatedAt: '', viewerRole: '', summary: emptySummary(), applicants: Object.freeze([]), message: ''
    });
  }

  function freezeQueue(value) {
    return Object.freeze({
      phase: text(value?.phase, 20) || 'error',
      generatedAt: validTimestamp(value?.generatedAt, { optional: true }),
      viewerRole: normalizedRole(value?.viewerRole),
      summary: value?.summary || emptySummary(),
      applicants: Object.freeze([...(value?.applicants || [])]),
      message: text(value?.message, 280)
    });
  }

  function normalizeSummary(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    const summary = { all: nonNegativeInteger(source.all) };
    STAGES.forEach(stage => { summary[stage] = nonNegativeInteger(source[stage]); });
    return Object.values(summary).some(value => value === null) ? null : Object.freeze(summary);
  }

  function normalizeOwner(source) {
    if (source === null || typeof source === 'undefined') return Object.freeze({ id: '', name: 'Unassigned' });
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    const id = validUuid(source.id, { optional: true });
    if (source.id && !id) return null;
    return Object.freeze({ id, name: text(source.name, 120) || 'Unassigned' });
  }

  function normalizeChecklist(source) {
    if (!Array.isArray(source) || source.length > 24) return null;
    const seen = new Set();
    const items = source.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const key = text(item.key, 64).toLowerCase();
      const label = text(item.label, 100);
      const state = text(item.state, 32).toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(key) || seen.has(key) || !label || !CHECKLIST_STATES.has(state)) return null;
      seen.add(key);
      return Object.freeze({ key, label, state });
    });
    return items.some(item => !item) ? null : Object.freeze(items);
  }

  function normalizeAllowedActions(source) {
    if (!Array.isArray(source) || source.length > ACTIONS.length) return null;
    const normalized = source.map(action => text(action, 40).toLowerCase());
    if (normalized.some(action => !ACTION_SET.has(action)) || new Set(normalized).size !== normalized.length) return null;
    return Object.freeze(normalized);
  }

  function normalizeResume(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source) || typeof source.available !== 'boolean') return null;
    return Object.freeze({
      available: source.available,
      label: source.available ? 'Secure résumé available' : 'Secure résumé not attached'
    });
  }

  function normalizeApplicant(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    const applicantId = validUuid(source.applicantId);
    const fullName = text(source.fullName, 160);
    const stage = text(source.stage, 40).toLowerCase();
    const applicationReceivedAt = validTimestamp(source.applicationReceivedAt, { optional: true });
    const updatedAt = validTimestamp(source.updatedAt);
    const owner = normalizeOwner(source.owner);
    const checklist = normalizeChecklist(source.checklist);
    const allowedActions = normalizeAllowedActions(source.allowedActions);
    const resume = normalizeResume(source.resume);
    const email = text(source.email, 254);
    if (!applicantId || !fullName || !STAGE_SET.has(stage) || !updatedAt || !owner || !checklist || !allowedActions || !resume) return null;
    if (source.applicationReceivedAt && !applicationReceivedAt) return null;
    if (typeof source.archived !== 'boolean') return null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
    return Object.freeze({
      applicantId,
      fullName,
      preferredName: text(source.preferredName, 100),
      email,
      applicationReceivedAt,
      updatedAt,
      stage,
      archived: source.archived,
      owner,
      checklist,
      allowedActions,
      resume
    });
  }

  function normalizePayload(payload, expectedRole = actualRole()) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('The Talent review service returned an invalid response.');
    }
    const generatedAt = validTimestamp(payload.generatedAt);
    const viewerRole = normalizedRole(payload.viewerRole);
    const role = normalizedRole(expectedRole);
    const summary = normalizeSummary(payload.summary);
    if (!generatedAt || !canOpenForRole(viewerRole) || viewerRole !== role || !summary) {
      throw new Error('Talent review access could not be verified.');
    }
    if (!Array.isArray(payload.applicants) || payload.applicants.length > 1000) {
      throw new Error('The Talent review queue contained an invalid applicant list.');
    }
    const applicants = payload.applicants.map(normalizeApplicant);
    if (applicants.some(applicant => !applicant)) {
      throw new Error('The Talent review queue contained an invalid applicant record.');
    }
    if (new Set(applicants.map(applicant => applicant.applicantId)).size !== applicants.length) {
      throw new Error('The Talent review queue contained a duplicate applicant.');
    }
    const expectedCounts = { all: applicants.length };
    ['submitted', 'in_review', 'needs_more_info', 'bench_ready'].forEach(stage => {
      expectedCounts[stage] = applicants.filter(applicant => !applicant.archived && applicant.stage === stage).length;
    });
    expectedCounts.closed = applicants.filter(applicant => applicant.archived || applicant.stage === 'declined').length;
    if (Object.keys(expectedCounts).some(key => summary[key] !== expectedCounts[key])) {
      throw new Error('The Talent review totals did not match the queue.');
    }
    return freezeQueue({ phase: 'ready', generatedAt, viewerRole, summary, applicants });
  }

  function safeHttpsUrl(value) {
    const normalized = text(value, 1800);
    if (!normalized) return '';
    try {
      const parsed = new URL(normalized);
      return parsed.protocol === 'https:' ? parsed.href : '';
    } catch { return ''; }
  }

  function nullableScore(value) {
    if (value === null || typeof value === 'undefined' || value === '') return null;
    const score = Number(value);
    return Number.isFinite(score) && score >= 0 && score <= 100 ? score : null;
  }

  function normalizeVerificationApplicant(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    const applicantId = validUuid(source.applicantId);
    const fullName = text(source.fullName, 160);
    const email = text(source.email, 254);
    const stage = text(source.stage, 40).toLowerCase();
    const updatedAt = validTimestamp(source.updatedAt);
    if (!applicantId || !fullName || !STAGE_SET.has(stage) || !updatedAt) return null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
    return Object.freeze({ applicantId, fullName, email, stage, updatedAt });
  }

  function normalizeVerificationGate(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    if (typeof source.interviewAddressed !== 'boolean' || typeof source.referencesAddressed !== 'boolean' || typeof source.benchReadyEligible !== 'boolean') return null;
    if (!Array.isArray(source.blockers) || source.blockers.length > 12) return null;
    const blockers = source.blockers.map(item => text(item, 180)).filter(Boolean);
    if (blockers.length !== source.blockers.length) return null;
    return Object.freeze({
      interviewAddressed: source.interviewAddressed,
      referencesAddressed: source.referencesAddressed,
      benchReadyEligible: source.benchReadyEligible,
      blockers: Object.freeze(blockers)
    });
  }

  function normalizeInterviewers(source) {
    if (typeof source === 'undefined' || source === null) return Object.freeze([]);
    if (!Array.isArray(source) || source.length > 200) return null;
    const interviewers = source.map(item => {
      const id = validUuid(item?.id);
      const name = text(item?.name, 120);
      return id && name ? Object.freeze({ id, name }) : null;
    });
    if (interviewers.some(item => !item) || new Set(interviewers.map(item => item.id)).size !== interviewers.length) return null;
    return Object.freeze(interviewers);
  }

  function normalizeCalendarIntegration(source) {
    if (typeof source === 'undefined' || source === null) return Object.freeze({ configured: false, organizerLabel: '' });
    if (!source || typeof source !== 'object' || Array.isArray(source) || typeof source.configured !== 'boolean') return null;
    return Object.freeze({ configured: source.configured, organizerLabel: text(source.organizerLabel, 160) });
  }

  function normalizeScorecard(source) {
    if (source === null || typeof source === 'undefined') return null;
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    const scorecard = {
      communication: nullableScore(source.communication),
      preparedness: nullableScore(source.preparedness),
      roleFit: nullableScore(source.roleFit),
      overall: nullableScore(source.overall)
    };
    if (Object.keys(scorecard).some(key => source[key] !== null && typeof source[key] !== 'undefined' && source[key] !== '' && scorecard[key] === null)) return null;
    return Object.freeze(scorecard);
  }

  function normalizeInterview(source) {
    if (source === null || typeof source === 'undefined') return null;
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    const interviewId = validUuid(source.interviewId);
    const status = text(source.status, 40).toLowerCase();
    const startsAt = validTimestamp(source.startsAt, { optional: true });
    const endsAt = validTimestamp(source.endsAt, { optional: true });
    const updatedAt = validTimestamp(source.updatedAt);
    const outcome = text(source.outcome, 40).toLowerCase();
    const timezone = text(source.timezone, 80);
    const interviewerSource = source.interviewer;
    const interviewerId = validUuid(interviewerSource?.id, { optional: true });
    const interviewerName = text(interviewerSource?.name, 120);
    const calendarStatus = text(source.calendar?.status, 40).toLowerCase();
    const joinUrl = safeHttpsUrl(source.calendar?.joinUrl);
    const scorecard = normalizeScorecard(source.scorecard);
    if (!interviewId || !INTERVIEW_STATUSES.has(status) || !updatedAt || !interviewerName || !CALENDAR_STATUSES.has(calendarStatus)) return null;
    if (interviewerSource?.id && !interviewerId) return null;
    if (source.startsAt && !startsAt) return null;
    if (source.endsAt && !endsAt) return null;
    if (outcome && !INTERVIEW_OUTCOMES.has(outcome)) return null;
    if (source.scorecard && !scorecard) return null;
    if (source.calendar?.joinUrl && !joinUrl) return null;
    return Object.freeze({
      interviewId, status, startsAt, endsAt, timezone, updatedAt,
      interviewer: Object.freeze({ id: interviewerId, name: interviewerName }),
      outcome: outcome || '', scorecard, notes: text(source.notes, 4000),
      calendar: Object.freeze({ status: calendarStatus, joinUrl })
    });
  }

  function normalizeReferenceAttempt(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    const attemptId = validUuid(source.attemptId);
    const method = text(source.method, 30).toLowerCase();
    const result = text(source.result, 30).toLowerCase();
    const attemptedAt = validTimestamp(source.attemptedAt);
    if (!attemptId || !REFERENCE_METHODS.has(method) || !REFERENCE_RESULTS.has(result) || !attemptedAt) return null;
    return Object.freeze({ attemptId, method, result, attemptedAt, note: text(source.note, 1000) });
  }

  function normalizeReference(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    const referenceId = validUuid(source.referenceId);
    const name = text(source.name, 160);
    const outcome = text(source.outcome, 40).toLowerCase();
    const updatedAt = validTimestamp(source.updatedAt);
    const phone = text(source.phone, 80);
    const email = text(source.email, 254);
    if (!referenceId || !name || !REFERENCE_OUTCOMES.has(outcome) || !updatedAt) return null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
    if (!Array.isArray(source.attempts) || source.attempts.length > 50) return null;
    const attempts = source.attempts.map(normalizeReferenceAttempt);
    if (attempts.some(item => !item)) return null;
    return Object.freeze({
      referenceId, name, company: text(source.company, 160), relationship: text(source.relationship, 120),
      phone, email, outcome, outcomeNote: text(source.outcomeNote, 2000),
      attempts: Object.freeze(attempts), updatedAt
    });
  }

  function normalizeVerificationPayload(payload, expectedApplicantId, expectedRole = actualRole()) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('The verification service returned an invalid response.');
    const generatedAt = validTimestamp(payload.generatedAt);
    const viewerRole = normalizedRole(payload.viewerRole);
    const role = normalizedRole(expectedRole);
    const applicant = normalizeVerificationApplicant(payload.applicant);
    const gate = normalizeVerificationGate(payload.gate);
    const interview = normalizeInterview(payload.interview);
    const interviewers = normalizeInterviewers(payload.interviewers);
    const calendarIntegration = normalizeCalendarIntegration(payload.calendarIntegration);
    if (!generatedAt || !canOpenForRole(viewerRole) || viewerRole !== role || !applicant || !gate || !interviewers || !calendarIntegration || (payload.interview !== null && typeof payload.interview !== 'undefined' && !interview)) throw new Error('Talent verification access could not be verified.');
    const expectedId = validUuid(expectedApplicantId);
    if (!expectedId || applicant.applicantId !== expectedId) throw new Error('The verification response did not match this applicant.');
    if (!Array.isArray(payload.references) || payload.references.length > 20) throw new Error('The verification response contained an invalid reference list.');
    const references = payload.references.map(normalizeReference);
    if (references.some(item => !item) || new Set(references.map(item => item.referenceId)).size !== references.length) throw new Error('The verification response contained an invalid reference record.');
    return Object.freeze({ generatedAt, viewerRole, applicant, gate, interview, references: Object.freeze(references), interviewers, calendarIntegration });
  }

  function currentQueue() {
    return queue;
  }

  function makeRequestId() {
    if (typeof root?.crypto?.randomUUID === 'function') return root.crypto.randomUUID();
    if (typeof root?.crypto?.getRandomValues !== 'function') {
      throw new Error('This browser cannot create a secure request. Refresh in a supported browser.');
    }
    const bytes = new Uint8Array(16);
    root.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  async function sessionToken() {
    if (!root?.soroSupabase?.auth?.getSession) throw new Error('Soro sign-in is still loading. Refresh and try again.');
    const { data: { session } = {}, error } = await root.soroSupabase.auth.getSession();
    if (error || !session?.access_token) throw new Error('Your secure session expired. Sign in again and retry.');
    return session.access_token;
  }

  function abortActiveRequest() {
    activeController?.abort?.();
    activeController = null;
  }

  async function requestQueue({ method = 'GET', body = null } = {}) {
    const token = await sessionToken();
    const controller = typeof root?.AbortController === 'function' ? new root.AbortController() : null;
    abortActiveRequest();
    activeController = controller;
    const timeout = controller && typeof root?.setTimeout === 'function'
      ? root.setTimeout(() => controller.abort(), 25000)
      : null;
    let response;
    try {
      response = await root.fetch(ENDPOINT, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller?.signal
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('The Talent review request took too long. Please try again.');
      throw new Error('Soro could not reach the Talent review service. Check your connection and try again.');
    } finally {
      if (timeout && typeof root?.clearTimeout === 'function') root.clearTimeout(timeout);
      if (activeController === controller) activeController = null;
    }
    const responseText = await response.text();
    let payload = null;
    try { payload = responseText ? JSON.parse(responseText) : null; }
    catch { throw new Error(`The Talent review service returned an unexpected response (${response.status}).`); }
    if (!response.ok) throw new Error(text(payload?.message, 280) || 'The Talent review request could not be completed.');
    return normalizePayload(payload);
  }

  function abortVerificationRequest() {
    activeVerificationController?.abort?.();
    activeVerificationController = null;
  }

  async function requestVerification(applicantId, { body = null } = {}) {
    if (!canOpenForRole()) throw new Error('Only Admin and Talent Management can access Talent verification.');
    const id = validUuid(applicantId);
    if (!id) throw new Error('Choose a valid Talent application and try again.');
    const token = await sessionToken();
    const controller = typeof root?.AbortController === 'function' ? new root.AbortController() : null;
    abortVerificationRequest();
    activeVerificationController = controller;
    const timeout = controller && typeof root?.setTimeout === 'function'
      ? root.setTimeout(() => controller.abort(), 25000)
      : null;
    let response;
    try {
      response = await root.fetch(body ? VERIFICATION_ENDPOINT : `${VERIFICATION_ENDPOINT}?applicantId=${encodeURIComponent(id)}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller?.signal
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('The verification request took too long. Please try again.');
      throw new Error('Soro could not reach the verification service. Check your connection and try again.');
    } finally {
      if (timeout && typeof root?.clearTimeout === 'function') root.clearTimeout(timeout);
      if (activeVerificationController === controller) activeVerificationController = null;
    }
    const responseText = await response.text();
    let payload = null;
    try { payload = responseText ? JSON.parse(responseText) : null; }
    catch { throw new Error(`The verification service returned an unexpected response (${response.status}).`); }
    if (!response.ok) throw new Error(text(payload?.message, 280) || 'The verification update could not be completed.');
    return normalizeVerificationPayload(payload, id);
  }

  function verificationRequestBase(action, applicantId, expectedUpdatedAt) {
    const normalizedAction = text(action, 50).toLowerCase();
    const id = validUuid(applicantId);
    const expected = expectedUpdatedAt === null ? null : validTimestamp(expectedUpdatedAt);
    if (!id || (expectedUpdatedAt !== null && !expected)) throw new Error('The verification record changed. Refresh and try again.');
    return { action: normalizedAction, requestId: makeRequestId(), applicantId: id, expectedUpdatedAt: expected };
  }

  function requiredText(value, label, max) {
    const normalized = text(value, max);
    if (!normalized) throw new Error(`${label} is required.`);
    return normalized;
  }

  function nullableFormScore(value) {
    if (value === null || typeof value === 'undefined' || String(value).trim() === '') return null;
    const score = Number(value);
    if (!Number.isFinite(score) || score < 1 || score > 5) throw new Error('Interview scores must be from 1 to 5.');
    return score;
  }

  function buildVerificationAction(action, values = {}) {
    const normalizedAction = text(action, 50).toLowerCase();
    const applicantId = values.applicantId;
    if (normalizedAction === 'schedule_interview') {
      const base = verificationRequestBase(normalizedAction, applicantId, null);
      const startsAt = validTimestamp(values.startsAt);
      const durationMinutes = Number(values.durationMinutes);
      const timezone = requiredText(values.timezone, 'Time zone', 80);
      const interviewerUserId = validUuid(values.interviewerUserId);
      if (!startsAt || !Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 240 || !interviewerUserId) throw new Error('Add a valid interview date, duration, time zone, and interviewer.');
      return Object.freeze({ ...base, startsAt, durationMinutes, timezone, interviewerUserId });
    }
    if (normalizedAction === 'reschedule_interview') {
      const base = verificationRequestBase(normalizedAction, applicantId, values.expectedUpdatedAt);
      const interviewId = validUuid(values.interviewId);
      const startsAt = validTimestamp(values.startsAt);
      const durationMinutes = Number(values.durationMinutes);
      const timezone = requiredText(values.timezone, 'Time zone', 80);
      const interviewerUserId = validUuid(values.interviewerUserId);
      if (!interviewId || !startsAt || !Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 240 || !interviewerUserId) throw new Error('Add a valid interview date, duration, time zone, and interviewer.');
      return Object.freeze({ ...base, interviewId, startsAt, durationMinutes, timezone, interviewerUserId });
    }
    if (normalizedAction === 'cancel_interview') {
      const base = verificationRequestBase(normalizedAction, applicantId, values.expectedUpdatedAt);
      const interviewId = validUuid(values.interviewId);
      const note = requiredText(values.note, 'Cancellation note', 1000);
      if (!interviewId) throw new Error('The interview record is incomplete. Refresh and try again.');
      return Object.freeze({ ...base, interviewId, note });
    }
    if (normalizedAction === 'record_interview_outcome') {
      const base = verificationRequestBase(normalizedAction, applicantId, values.expectedUpdatedAt);
      const interviewId = validUuid(values.interviewId);
      const status = text(values.status, 40).toLowerCase();
      const outcome = text(values.outcome, 40).toLowerCase();
      const note = text(values.note, 4000);
      if (!interviewId || !['completed', 'no_show', 'waived'].includes(status)) throw new Error('Choose a valid interview result.');
      if (status === 'completed' && !INTERVIEW_OUTCOMES.has(outcome)) throw new Error('Choose an interview recommendation.');
      if (!note) throw new Error('Add a concise internal interview summary.');
      return Object.freeze({
        ...base, interviewId, status, outcome: status === 'completed' ? outcome : null,
        communicationScore: nullableFormScore(values.communicationScore),
        preparednessScore: nullableFormScore(values.preparednessScore),
        roleFitScore: nullableFormScore(values.roleFitScore),
        overallScore: nullableFormScore(values.overallScore), note
      });
    }
    if (normalizedAction === 'retry_calendar_sync') {
      const base = verificationRequestBase(normalizedAction, applicantId, values.expectedUpdatedAt);
      const interviewId = validUuid(values.interviewId);
      if (!interviewId) throw new Error('The interview record is incomplete. Refresh and try again.');
      return Object.freeze({ ...base, interviewId });
    }
    if (normalizedAction === 'save_reference') {
      const creating = !values.referenceId;
      const base = verificationRequestBase(normalizedAction, applicantId, creating ? null : values.expectedUpdatedAt);
      const referenceId = creating ? null : validUuid(values.referenceId);
      const name = requiredText(values.name, 'Reference name', 160);
      const email = text(values.email, 254);
      if (!creating && !referenceId) throw new Error('The reference record is incomplete. Refresh and try again.');
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid reference email address.');
      return Object.freeze({ ...base, referenceId, name, company: text(values.company, 160), relationship: text(values.relationship, 120), phone: text(values.phone, 80), email });
    }
    if (normalizedAction === 'record_reference_attempt') {
      const base = verificationRequestBase(normalizedAction, applicantId, values.expectedUpdatedAt);
      const referenceId = validUuid(values.referenceId);
      const method = text(values.method, 30).toLowerCase();
      const result = text(values.result, 30).toLowerCase();
      const attemptedAt = validTimestamp(values.attemptedAt);
      if (!referenceId || !REFERENCE_METHODS.has(method) || !REFERENCE_RESULTS.has(result) || !attemptedAt) throw new Error('Add a valid contact method, result, and attempt time.');
      return Object.freeze({ ...base, referenceId, method, result, attemptedAt, note: text(values.note, 1000) });
    }
    if (normalizedAction === 'set_reference_outcome') {
      const base = verificationRequestBase(normalizedAction, applicantId, values.expectedUpdatedAt);
      const referenceId = validUuid(values.referenceId);
      const outcome = text(values.outcome, 40).toLowerCase();
      const note = text(values.note, 2000);
      if (!referenceId || !REFERENCE_OUTCOMES.has(outcome) || outcome === 'pending') throw new Error('Choose a final reference outcome.');
      if (['discrepancy', 'unable_to_reach', 'not_provided'].includes(outcome) && !note) throw new Error('Add a note explaining this reference outcome.');
      return Object.freeze({ ...base, referenceId, outcome, note });
    }
    if (normalizedAction === 'remove_reference') {
      const base = verificationRequestBase(normalizedAction, applicantId, values.expectedUpdatedAt);
      const referenceId = validUuid(values.referenceId);
      if (!referenceId) throw new Error('The reference record is incomplete. Refresh and try again.');
      return Object.freeze({ ...base, referenceId });
    }
    throw new Error('That verification action is not available.');
  }

  function dispatchUpdated() {
    if (typeof root?.dispatchEvent !== 'function' || typeof root?.CustomEvent !== 'function') return;
    root.dispatchEvent(new root.CustomEvent('soro:talent-review-queue-updated', { detail: { queue } }));
  }

  function setQueue(value) {
    queue = value;
    dispatchUpdated();
    render();
    return queue;
  }

  async function refresh() {
    if (!canOpenForRole()) return currentQueue();
    const version = ++requestVersion;
    feedback = Object.freeze({ type: '', message: '' });
    queue = freezeQueue({ phase: 'loading', generatedAt: '', viewerRole: actualRole(), summary: emptySummary(), applicants: [] });
    render();
    try {
      const next = await requestQueue();
      if (version !== requestVersion || !canOpenForRole()) return currentQueue();
      return setQueue(next);
    } catch (error) {
      if (version !== requestVersion || !canOpenForRole()) return currentQueue();
      return setQueue(freezeQueue({
        phase: 'error', generatedAt: '', viewerRole: actualRole(), summary: emptySummary(), applicants: [],
        message: error.message || 'The Talent review queue could not be loaded.'
      }));
    }
  }

  function stageLabel(value) {
    if (value === 'declined') return 'Declined';
    return STAGE_LABELS[value] || 'Needs review';
  }

  function filterStage(applicant) {
    return applicant?.archived || applicant?.stage === 'declined' ? 'closed' : applicant?.stage;
  }

  function applicantStageLabel(applicant) {
    return applicant?.archived ? 'Archived' : stageLabel(applicant?.stage);
  }

  function formatDate(value) {
    if (!value) return 'Date not recorded';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return 'Date not recorded';
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
  }

  function initials(value) {
    const words = text(value, 160).split(/\s+/).filter(Boolean);
    return words.slice(0, 2).map(word => word[0]).join('').toUpperCase() || 'T';
  }

  function visibleApplicants() {
    const query = filters.search.toLowerCase();
    return queue.applicants.filter(applicant => {
      if (filters.stage !== 'all' && filterStage(applicant) !== filters.stage) return false;
      if (!query) return true;
      return [applicant.fullName, applicant.preferredName, applicant.email, applicant.owner.name]
        .filter(Boolean).join(' ').toLowerCase().includes(query);
    });
  }

  function summaryMarkup() {
    return `<section class="talent-review-summary" aria-label="Talent review summary">
      ${['all', ...STAGES].map(stage => `<button type="button" class="talent-review-summary-card${filters.stage === stage ? ' is-selected' : ''}" data-review-stage="${stage}" aria-pressed="${filters.stage === stage}">
        <span>${escapeHtml(stageLabel(stage))}</span><strong>${queue.summary[stage]}</strong>
      </button>`).join('')}
    </section>`;
  }

  function stageChipsMarkup() {
    return `<div class="talent-review-stage-chips" aria-label="Filter by review stage">
      ${['all', ...STAGES].map(stage => `<button type="button" data-review-stage="${stage}" class="talent-review-stage-chip${filters.stage === stage ? ' is-active' : ''}" aria-pressed="${filters.stage === stage}">${escapeHtml(stageLabel(stage))}<span>${queue.summary[stage]}</span></button>`).join('')}
    </div>`;
  }

  function checklistMarkup(applicant) {
    const complete = applicant.checklist.filter(item => item.state === 'complete').length;
    return `<div class="talent-review-checklist">
      <div class="talent-review-checklist-heading"><strong>Review checklist</strong><span>${complete} of ${applicant.checklist.length} complete</span></div>
      <ul>${applicant.checklist.map(item => `<li class="is-${escapeHtml(item.state)}"><span aria-hidden="true">${item.state === 'complete' ? '✓' : item.state === 'needs_review' ? '!' : '–'}</span>${escapeHtml(item.label)}<small>${item.state === 'complete' ? 'Complete' : item.state === 'needs_review' ? 'Needs review' : 'Missing'}</small></li>`).join('')}</ul>
    </div>`;
  }

  function actionButtonMarkup(action, applicant) {
    const primary = ['begin_review', 'mark_bench_ready'].includes(action);
    const guarded = ['decline', 'archive'].includes(action);
    const restore = action === 'restore';
    const checklistIncomplete = action === 'mark_bench_ready' && applicant.checklist.some(item => item.state !== 'complete');
    const verificationGate = verificationGateCache.get(applicant.applicantId);
    const verificationIncomplete = action === 'mark_bench_ready' && !verificationGate?.benchReadyEligible;
    const disabledReason = checklistIncomplete
      ? 'Complete every review checklist item first'
      : verificationIncomplete
        ? verificationGate ? 'Resolve the interview and reference verification items first' : 'Open Verification to confirm Bench Ready eligibility'
        : '';
    return `<button type="button" class="button talent-review-action${primary ? ' primary' : ''}${guarded ? ' talent-review-action--guarded' : ''}${restore ? ' talent-review-action--restore' : ''}" data-review-action="${escapeHtml(action)}"${disabledReason ? ` disabled title="${escapeHtml(disabledReason)}"` : ''}>${escapeHtml(ACTION_LABELS[action])}</button>`;
  }

  function resumeButtonMarkup(applicant) {
    const available = applicant.resume.available;
    const label = available ? 'Open résumé' : 'Résumé not attached';
    const title = available ? applicant.resume.label : 'A secure résumé has not been attached';
    return `<button type="button" class="button talent-review-resume" data-review-resume="${escapeHtml(applicant.applicantId)}" aria-label="${escapeHtml(available ? `Open ${applicant.fullName}’s secure résumé in a new tab` : `${applicant.fullName} does not have a secure résumé attached`)}" title="${escapeHtml(title)}"${available ? '' : ' disabled aria-disabled="true"'}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v5h5M10 13h6m-6 4h4"/></svg><span>${label}</span></button>`;
  }

  function verificationButtonMarkup(applicant) {
    const gate = verificationGateCache.get(applicant.applicantId);
    const state = gate?.benchReadyEligible ? 'Ready' : gate ? `${gate.blockers.length} follow-up${gate.blockers.length === 1 ? '' : 's'}` : 'Interview & references';
    return `<button type="button" class="button talent-review-verification${gate?.benchReadyEligible ? ' is-ready' : ''}" data-review-verification="${escapeHtml(applicant.applicantId)}" aria-label="Open verification for ${escapeHtml(applicant.fullName)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3h8v3h3v15H5V6h3z"/><path d="M9 13l2 2 4-5M9 8h6"/></svg><span><strong>Verification</strong><small>${escapeHtml(state)}</small></span></button>`;
  }

  function applicantMarkup(applicant) {
    const primaryActions = applicant.allowedActions.filter(action => !SECONDARY_ACTIONS.has(action));
    const guardedActions = applicant.allowedActions.filter(action => SECONDARY_ACTIONS.has(action));
    const displayedStage = filterStage(applicant);
    return `<article class="talent-review-card" data-review-applicant="${escapeHtml(applicant.applicantId)}">
      <header class="talent-review-card-heading">
        <span class="talent-review-avatar" aria-hidden="true">${escapeHtml(initials(applicant.fullName))}</span>
        <div class="talent-review-person">
          <button type="button" class="talent-review-profile-link" data-review-profile="${escapeHtml(applicant.applicantId)}">${escapeHtml(applicant.fullName)}</button>
          ${applicant.preferredName ? `<span>Goes by ${escapeHtml(applicant.preferredName)}</span>` : ''}
          ${applicant.email ? `<small>${escapeHtml(applicant.email)}</small>` : ''}
        </div>
        <span class="talent-review-stage talent-review-stage--${escapeHtml(displayedStage)}">${escapeHtml(applicantStageLabel(applicant))}</span>
      </header>
      <div class="talent-review-card-meta">
        <span><small>Application received</small><strong>${escapeHtml(formatDate(applicant.applicationReceivedAt))}</strong></span>
        <span><small>Review owner</small><strong>${escapeHtml(applicant.owner.name)}</strong></span>
        <span><small>Last updated</small><strong>${escapeHtml(formatDate(applicant.updatedAt))}</strong></span>
      </div>
      ${checklistMarkup(applicant)}
      <footer class="talent-review-card-actions">
        <div class="talent-review-card-main-actions">${resumeButtonMarkup(applicant)}${verificationButtonMarkup(applicant)}<span class="talent-review-action-divider" aria-hidden="true"></span>${primaryActions.length ? primaryActions.map(action => actionButtonMarkup(action, applicant)).join('') : '<span class="talent-review-no-actions">No stage action needed</span>'}</div>
        ${guardedActions.length ? `<details class="talent-review-secondary"><summary>More actions</summary><div>${guardedActions.map(action => actionButtonMarkup(action, applicant)).join('')}</div></details>` : ''}
      </footer>
    </article>`;
  }

  function queueMarkup() {
    const applicants = visibleApplicants();
    if (!applicants.length) {
      return `<div class="talent-review-empty"><strong>No applications match these filters.</strong><p>Clear the search or choose another review stage.</p></div>`;
    }
    return `<section class="talent-review-list" aria-label="Applications awaiting Talent review">${applicants.map(applicantMarkup).join('')}</section>`;
  }

  function formatDateTime(value, timezone = '') {
    if (!value) return 'Not scheduled';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return 'Not scheduled';
    try {
      return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short', ...(timezone ? { timeZone: timezone } : {}) }).format(date);
    } catch {
      return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(date);
    }
  }

  function dateTimeLocalValue(value, timezone = '') {
    const date = value ? new Date(value) : new Date(Date.now() + 24 * 60 * 60 * 1000);
    if (!Number.isFinite(date.getTime())) return '';
    const pad = number => String(number).padStart(2, '0');
    if (timezone) {
      try {
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
        return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
      } catch { /* use the browser time zone below */ }
    }
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function interviewDuration(interview) {
    if (!interview?.startsAt || !interview?.endsAt) return 30;
    const minutes = Math.round((new Date(interview.endsAt).getTime() - new Date(interview.startsAt).getTime()) / 60000);
    return Number.isInteger(minutes) && minutes >= 15 && minutes <= 240 ? minutes : 30;
  }

  function defaultTimezone() {
    try { return text(Intl.DateTimeFormat().resolvedOptions().timeZone, 80) || 'America/Chicago'; }
    catch { return 'America/Chicago'; }
  }

  function humanLabel(value) {
    return text(value, 80).replace(/_/g, ' ').replace(/\b\w/g, character => character.toUpperCase());
  }

  function calendarMarkup(interview) {
    if (!interview) return '';
    const status = interview.calendar.status;
    const copy = {
      connection_required: ['Microsoft 365 connection needed', 'The appointment is saved in Soro, but it is not on the shared calendar yet.'],
      pending: ['Calendar sync pending', 'The appointment is saved. Microsoft 365 synchronization is still processing.'],
      synced: ['Outlook and Teams synced', 'The appointment is on the Microsoft 365 calendar.'],
      sync_failed: ['Calendar sync needs attention', 'The appointment remains saved in Soro. Retry the Microsoft 365 sync.'],
      not_applicable: ['Calendar sync not applicable', 'This interview no longer needs an active calendar appointment.']
    }[status] || ['Calendar status unavailable', 'Refresh to check Microsoft 365 synchronization.'];
    return `<div class="talent-verification-calendar is-${escapeHtml(status)}"><span class="talent-verification-calendar-dot" aria-hidden="true"></span><div><strong>${escapeHtml(copy[0])}</strong><p>${escapeHtml(copy[1])}</p></div><div class="talent-verification-calendar-actions">${interview.calendar.joinUrl ? `<a class="button primary" href="${escapeHtml(interview.calendar.joinUrl)}" target="_blank" rel="noopener noreferrer">Join Teams meeting</a>` : ''}${['pending', 'sync_failed', 'connection_required'].includes(status) ? `<button type="button" class="button" data-verification-quick-action="retry_calendar_sync">${status === 'pending' ? 'Check sync' : 'Retry sync'}</button>` : ''}</div></div>`;
  }

  function scheduleFormMarkup(data, interview = null) {
    const action = interview ? 'reschedule_interview' : 'schedule_interview';
    const title = interview ? 'Reschedule appointment' : 'Schedule interview';
    const interviewerUserId = actualUserId();
    const selectedInterviewerId = interview?.interviewer?.id || (data.interviewers.some(item => item.id === interviewerUserId) ? interviewerUserId : data.interviewers[0]?.id || interviewerUserId);
    const interviewerControl = data.interviewers.length
      ? `<label class="talent-verification-field-wide"><span>Assigned interviewer</span><select name="interviewerUserId" required>${data.interviewers.map(item => `<option value="${escapeHtml(item.id)}"${item.id === selectedInterviewerId ? ' selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select></label>`
      : `<p class="talent-verification-inline-error talent-verification-field-wide" role="alert">No eligible interviewer is available. Add an active Admin or Talent Management employee account before scheduling.</p>`;
    const calendarCopy = data.calendarIntegration.configured
      ? `Microsoft 365 connected${data.calendarIntegration.organizerLabel ? ` through ${escapeHtml(data.calendarIntegration.organizerLabel)}` : ''} — a calendar invitation and Teams meeting will be created.`
      : 'Microsoft 365 connection required — the appointment will remain in Soro until calendar sync is configured.';
    return `<form class="talent-verification-form talent-verification-schedule-form" data-verification-form="${action}">
      <h4>${title}</h4>
      <div class="talent-verification-integration-note ${data.calendarIntegration.configured ? 'is-connected' : 'is-unconfigured'}">${calendarCopy}</div>
      <div class="talent-verification-form-grid">
        <label><span>Date and time</span><input type="datetime-local" name="startsAt" value="${escapeHtml(dateTimeLocalValue(interview?.startsAt, interview?.timezone))}" required></label>
        <label><span>Duration</span><select name="durationMinutes" required><option value="30"${interviewDuration(interview) === 30 ? ' selected' : ''}>30 minutes</option><option value="45"${interviewDuration(interview) === 45 ? ' selected' : ''}>45 minutes</option><option value="60"${interviewDuration(interview) === 60 ? ' selected' : ''}>60 minutes</option><option value="90"${interviewDuration(interview) === 90 ? ' selected' : ''}>90 minutes</option></select></label>
        <label class="talent-verification-field-wide"><span>Time zone</span><input type="text" name="timezone" maxlength="80" value="${escapeHtml(interview?.timezone || defaultTimezone())}" required></label>
        ${interviewerControl}
      </div>
      <p class="talent-verification-form-note">The applicant and assigned interviewer receive the calendar invitation. Private review notes are never included.</p>
      ${data.interviewers.length ? `<button type="submit" class="button primary">${title}</button>` : ''}
    </form>`;
  }

  function scorecardMarkup(scorecard) {
    if (!scorecard) return '';
    const values = [['Communication', scorecard.communication], ['Preparedness', scorecard.preparedness], ['Role fit', scorecard.roleFit], ['Overall', scorecard.overall]];
    return `<dl class="talent-verification-scorecard">${values.map(([label, value]) => `<div><dt>${label}</dt><dd>${value === null ? '—' : `${escapeHtml(value)} / 5`}</dd></div>`).join('')}</dl>`;
  }

  function outcomeFormMarkup(interview) {
    return `<form class="talent-verification-form" data-verification-form="record_interview_outcome">
      <h4>Record interview result</h4>
      <div class="talent-verification-form-grid">
        <label><span>Interview status</span><select name="status" required><option value="completed">Completed</option><option value="no_show">Applicant did not attend</option><option value="waived">Interview waived</option></select></label>
        <label><span>Recommendation</span><select name="outcome"><option value="recommended">Recommended</option><option value="follow_up">Follow-up needed</option><option value="not_recommended">Not recommended</option></select></label>
        ${[['communicationScore', 'Communication'], ['preparednessScore', 'Preparedness'], ['roleFitScore', 'Role fit'], ['overallScore', 'Overall']].map(([name, label]) => `<label><span>${label} score</span><input type="number" name="${name}" min="1" max="5" step="1" inputmode="numeric" placeholder="1–5"></label>`).join('')}
        <label class="talent-verification-field-wide"><span>Internal summary</span><textarea name="note" maxlength="4000" required placeholder="Record the interview result and follow-up. This is not added to calendar invitations."></textarea></label>
      </div>
      <button type="submit" class="button primary">Save interview result</button>
    </form>`;
  }

  function interviewMarkup(data) {
    const interview = data.interview;
    if (!interview) return `<section class="talent-verification-section"><div class="talent-verification-section-heading"><div><p class="eyebrow">Internal interview</p><h3>No interview scheduled</h3></div><span class="talent-verification-state is-open">Action needed</span></div>${scheduleFormMarkup(data)}</section>`;
    const terminal = ['completed', 'no_show', 'waived'].includes(interview.status);
    return `<section class="talent-verification-section">
      <div class="talent-verification-section-heading"><div><p class="eyebrow">Internal interview</p><h3>${escapeHtml(humanLabel(interview.status))}</h3></div><span class="talent-verification-state is-${escapeHtml(interview.status)}">${escapeHtml(humanLabel(interview.status))}</span></div>
      <div class="talent-verification-interview-summary"><div><small>Appointment</small><strong>${escapeHtml(formatDateTime(interview.startsAt, interview.timezone))}</strong></div><div><small>Interviewer</small><strong>${escapeHtml(interview.interviewer.name)}</strong></div>${interview.outcome ? `<div><small>Recommendation</small><strong>${escapeHtml(humanLabel(interview.outcome))}</strong></div>` : ''}</div>
      ${calendarMarkup(interview)}
      ${scorecardMarkup(interview.scorecard)}
      ${interview.notes ? `<div class="talent-verification-private-note"><strong>Internal note</strong><p>${escapeHtml(interview.notes)}</p></div>` : ''}
      ${interview.status === 'scheduled' ? `<div class="talent-verification-control-grid"><details><summary>Reschedule</summary>${scheduleFormMarkup(data, interview)}</details><details><summary>Complete or waive</summary>${outcomeFormMarkup(interview)}</details><details><summary>Cancel appointment</summary><form class="talent-verification-form" data-verification-form="cancel_interview"><label><span>Internal cancellation note</span><textarea name="note" maxlength="1000" required placeholder="Why is this appointment being cancelled?"></textarea></label><p class="talent-verification-form-note">This internal note is not sent in the calendar cancellation.</p><button type="submit" class="button talent-review-confirm-guarded">Cancel interview</button></form></details></div>` : ''}
      ${interview.status === 'cancelled' ? (interview.calendar.status === 'not_applicable' ? scheduleFormMarkup(data, interview) : '<p class="talent-verification-inline-error">Finish the Microsoft 365 cancellation above before rebooking this interview.</p>') : ''}
      ${terminal ? '<p class="talent-verification-complete-copy">This interview requirement is addressed. Continue with reference verification below.</p>' : ''}
    </section>`;
  }

  function referenceOutcomeLabel(reference) {
    return reference.outcome === 'pending' ? 'In progress' : humanLabel(reference.outcome);
  }

  function referenceMarkup(reference) {
    const latest = reference.attempts[reference.attempts.length - 1];
    return `<article class="talent-verification-reference" data-verification-reference="${escapeHtml(reference.referenceId)}">
      <header><div><h4>${escapeHtml(reference.name)}</h4><p>${escapeHtml([reference.relationship, reference.company].filter(Boolean).join(' · ') || 'Relationship not recorded')}</p></div><span class="talent-verification-reference-outcome is-${escapeHtml(reference.outcome)}">${escapeHtml(referenceOutcomeLabel(reference))}</span></header>
      <div class="talent-verification-reference-contact">${reference.phone ? `<span><small>Phone</small>${escapeHtml(reference.phone)}</span>` : ''}${reference.email ? `<span><small>Email</small>${escapeHtml(reference.email)}</span>` : ''}<span><small>Attempts</small>${reference.attempts.length}</span>${latest ? `<span><small>Latest</small>${escapeHtml(humanLabel(latest.result))} · ${escapeHtml(formatDateTime(latest.attemptedAt))}</span>` : ''}</div>
      ${reference.outcomeNote ? `<p class="talent-verification-reference-note">${escapeHtml(reference.outcomeNote)}</p>` : ''}
      ${reference.attempts.length ? `<details class="talent-verification-attempt-history"><summary>View contact history</summary><ol>${reference.attempts.map(attempt => `<li><strong>${escapeHtml(humanLabel(attempt.method))} · ${escapeHtml(humanLabel(attempt.result))}</strong><span>${escapeHtml(formatDateTime(attempt.attemptedAt))}</span>${attempt.note ? `<p>${escapeHtml(attempt.note)}</p>` : ''}</li>`).join('')}</ol></details>` : ''}
      <div class="talent-verification-reference-actions">
        <details><summary>Add contact attempt</summary><form class="talent-verification-form" data-verification-form="record_reference_attempt"><div class="talent-verification-form-grid"><label><span>Method</span><select name="method"><option value="phone">Phone</option><option value="email">Email</option><option value="other">Other</option></select></label><label><span>Result</span><select name="result"><option value="reached">Reached</option><option value="no_answer">No answer</option><option value="voicemail">Voicemail</option><option value="wrong_number">Wrong number</option><option value="bounced">Email bounced</option><option value="other">Other</option></select></label><label class="talent-verification-field-wide"><span>Attempted at</span><input type="datetime-local" name="attemptedAt" value="${escapeHtml(dateTimeLocalValue(new Date().toISOString()))}" required></label><label class="talent-verification-field-wide"><span>Internal note</span><textarea name="note" maxlength="1000"></textarea></label></div><button type="submit" class="button primary">Save attempt</button></form></details>
        <details><summary>Set outcome</summary><form class="talent-verification-form" data-verification-form="set_reference_outcome"><label><span>Outcome</span><select name="outcome"><option value="verified">Verified</option><option value="discrepancy">Discrepancy found</option><option value="unable_to_reach">Unable to reach</option><option value="not_provided">Not provided</option></select></label><label><span>Internal outcome note</span><textarea name="note" maxlength="2000" placeholder="Required for discrepancies, unable to reach, or not provided"></textarea></label><p class="talent-verification-form-note">Unable to reach requires at least two recorded contact attempts and an internal note.</p><button type="submit" class="button primary">Save outcome</button></form></details>
        <details><summary>Edit details</summary><form class="talent-verification-form" data-verification-form="save_reference"><div class="talent-verification-form-grid"><label><span>Name</span><input name="name" maxlength="160" value="${escapeHtml(reference.name)}" required></label><label><span>Company</span><input name="company" maxlength="160" value="${escapeHtml(reference.company)}"></label><label><span>Relationship</span><input name="relationship" maxlength="120" value="${escapeHtml(reference.relationship)}"></label><label><span>Phone</span><input name="phone" maxlength="80" value="${escapeHtml(reference.phone)}"></label><label class="talent-verification-field-wide"><span>Email</span><input type="email" name="email" maxlength="254" value="${escapeHtml(reference.email)}"></label></div><button type="submit" class="button">Save reference</button></form></details>
        <button type="button" class="talent-verification-text-button is-danger" data-verification-remove-reference>Remove</button>
      </div>
    </article>`;
  }

  function referencesMarkup(data) {
    return `<section class="talent-verification-section"><div class="talent-verification-section-heading"><div><p class="eyebrow">Employment references</p><h3>${data.references.length ? `${data.references.length} reference${data.references.length === 1 ? '' : 's'}` : 'No references recorded'}</h3></div><span class="talent-verification-state ${data.gate.referencesAddressed ? 'is-completed' : 'is-open'}">${data.gate.referencesAddressed ? 'Addressed' : 'Action needed'}</span></div>
      <div class="talent-verification-reference-list">${data.references.map(referenceMarkup).join('')}</div>
      <details class="talent-verification-add-reference"><summary>Add employment reference</summary><form class="talent-verification-form" data-verification-form="save_reference"><div class="talent-verification-form-grid"><label><span>Name</span><input name="name" maxlength="160" required></label><label><span>Company</span><input name="company" maxlength="160"></label><label><span>Relationship</span><input name="relationship" maxlength="120"></label><label><span>Phone</span><input name="phone" maxlength="80"></label><label class="talent-verification-field-wide"><span>Email</span><input type="email" name="email" maxlength="254"></label></div><button type="submit" class="button primary">Add reference</button></form></details>
    </section>`;
  }

  function gateMarkup(data) {
    const gate = data.gate;
    return `<section class="talent-verification-gate ${gate.benchReadyEligible ? 'is-ready' : 'is-blocked'}" aria-label="Bench Ready status"><div><p class="eyebrow">Bench Ready gate</p><h3>${gate.benchReadyEligible ? 'Verification complete' : 'Follow-up required'}</h3><p>${gate.benchReadyEligible ? 'Interview and reference requirements are addressed. The review can move to Bench Ready when the main checklist is complete.' : 'Finish the items below before moving this Talent to Bench Ready.'}</p></div>${gate.blockers.length ? `<ul>${gate.blockers.map(blocker => `<li>${escapeHtml(blocker)}</li>`).join('')}</ul>` : '<span class="talent-verification-ready-mark" aria-hidden="true">✓</span>'}</section>`;
  }

  function verificationDialogMarkup() {
    if (!verificationContext) return '';
    const applicant = findApplicant(verificationContext.applicantId);
    const name = verificationContext.data?.applicant?.fullName || applicant?.fullName || 'Talent applicant';
    let content = '';
    if (verificationContext.phase === 'loading') content = '<div class="talent-verification-loading" role="status">Loading interview and reference verification…</div>';
    else if (verificationContext.phase === 'error') content = `<div class="talent-verification-error" role="alert"><strong>Verification unavailable</strong><p>${escapeHtml(verificationContext.error)}</p><button type="button" class="button" data-verification-retry>Try again</button></div>`;
    else if (verificationContext.data) content = `${verificationContext.status ? `<div class="talent-verification-feedback ${verificationContext.statusType === 'error' ? 'is-error' : ''}" role="status">${escapeHtml(verificationContext.status)}</div>` : ''}${gateMarkup(verificationContext.data)}${interviewMarkup(verificationContext.data)}${referencesMarkup(verificationContext.data)}`;
    return `<dialog class="talent-verification-dialog" data-verification-dialog aria-labelledby="talent-verification-title"><div class="talent-verification-shell"><header class="talent-verification-header"><div><p class="eyebrow">Talent verification</p><h2 id="talent-verification-title">${escapeHtml(name)}</h2><p>Schedule the internal interview, document references, and resolve Bench Ready requirements.</p></div><button type="button" data-verification-close aria-label="Close verification">×</button></header><div class="talent-verification-body">${content}</div></div></dialog>`;
  }

  function actionDialogMarkup() {
    if (!actionContext) return '';
    const applicant = queue.applicants.find(item => item.applicantId === actionContext.applicantId);
    if (!applicant) return '';
    const dangerous = ['decline', 'archive'].includes(actionContext.action);
    const title = ACTION_LABELS[actionContext.action] || 'Update review';
    return `<dialog class="talent-review-dialog" data-review-dialog>
      <form method="dialog" data-review-action-form>
        <header><div><p class="eyebrow">${dangerous ? 'Guarded record action' : 'Talent review note'}</p><h2>${escapeHtml(title)}</h2></div><button type="button" data-review-dialog-close aria-label="Close">×</button></header>
        <p>${dangerous ? `This changes ${escapeHtml(applicant.fullName)}’s review record. Explain the reason before confirming.` : `Add the information ${escapeHtml(applicant.fullName)} needs before the review can continue.`}</p>
        <label>Internal review note <span>Required</span><textarea name="note" maxlength="500" required placeholder="Record the reason and the next step"></textarea></label>
        <div class="talent-review-dialog-status" aria-live="polite"></div>
        <footer><button type="button" class="button" data-review-dialog-close>Cancel</button><button type="submit" class="button${dangerous ? ' talent-review-confirm-guarded' : ' primary'}">${escapeHtml(title)}</button></footer>
      </form>
    </dialog>`;
  }

  function readyMarkup() {
    return `<main class="page talent-review-page">
      <div class="page-heading talent-review-page-heading"><div><p class="eyebrow">Talent Management Panel</p><h1>Application Review Queue</h1><p>Move each application through one clear review stage, with the source profile one click away.</p></div><button type="button" class="button" data-review-refresh>Refresh queue</button></div>
      ${feedback.message ? `<div class="talent-review-feedback${feedback.type === 'error' ? ' is-error' : ''}" role="status">${escapeHtml(feedback.message)}</div>` : ''}
      ${summaryMarkup()}
      <section class="panel talent-review-workspace">
        <div class="talent-review-toolbar"><label><span aria-hidden="true">⌕</span><input type="search" data-review-search value="${escapeHtml(filters.search)}" maxlength="120" placeholder="Search Talent, email, or owner" autocomplete="off"></label><small>Updated ${escapeHtml(formatDate(queue.generatedAt))}</small></div>
        ${stageChipsMarkup()}
        ${queueMarkup()}
      </section>
      ${actionDialogMarkup()}
      ${verificationDialogMarkup()}
    </main>`;
  }

  function pageMarkup() {
    if (queue.phase === 'loading' || queue.phase === 'idle') {
      return `<main class="page talent-review-page"><div class="page-heading"><div><p class="eyebrow">Talent Management Panel</p><h1>Application Review Queue</h1></div></div><section class="panel talent-review-loading" role="status">Loading the secure review queue…</section></main>`;
    }
    if (queue.phase === 'error') {
      return `<main class="page talent-review-page"><div class="page-heading"><div><p class="eyebrow">Talent Management Panel</p><h1>Application Review Queue</h1></div></div><section class="panel talent-review-error" role="alert"><strong>Review queue unavailable</strong><p>${escapeHtml(queue.message)}</p><button type="button" class="button" data-review-refresh>Try again</button></section></main>`;
    }
    return readyMarkup();
  }

  function render() {
    if (!mountedRoot) return false;
    mountedRoot.innerHTML = pageMarkup();
    const dialog = mountedRoot.querySelector?.('[data-review-dialog], [data-verification-dialog]');
    if (dialog) {
      dialog.addEventListener?.('cancel', event => {
        event.preventDefault();
        if (dialog.matches?.('[data-verification-dialog]')) closeVerification();
        else closeActionDialog();
      }, { once: true });
      if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
    }
    return true;
  }

  function setStageFilter(value) {
    const stage = text(value, 40).toLowerCase();
    filters = Object.freeze({ ...filters, stage: stage === 'all' || FILTER_STAGE_SET.has(stage) ? stage : 'all' });
    render();
    return filters;
  }

  function setSearch(value) {
    filters = Object.freeze({ ...filters, search: text(value, 120) });
    render();
    const input = mountedRoot?.querySelector?.('[data-review-search]');
    input?.focus?.();
    input?.setSelectionRange?.(filters.search.length, filters.search.length);
    return filters;
  }

  function openProfile(applicantId) {
    const id = validUuid(applicantId);
    if (!id || typeof root?.CustomEvent !== 'function') return false;
    root.dispatchEvent?.(new root.CustomEvent('soro:talent-review-open-profile', { detail: { applicantId: id } }));
    return true;
  }

  function openResume(applicantId) {
    if (!canOpenForRole() || typeof root?.CustomEvent !== 'function') return false;
    const applicant = findApplicant(applicantId);
    if (!applicant?.resume?.available) return false;
    root.dispatchEvent?.(new root.CustomEvent('soro:talent-review-open-resume', {
      detail: { applicantId: applicant.applicantId }
    }));
    return true;
  }

  async function loadVerification(applicantId, { preserveStatus = false } = {}) {
    if (!canOpenForRole()) return false;
    const applicant = findApplicant(applicantId);
    if (!applicant) return false;
    const version = ++verificationRequestVersion;
    verificationContext = Object.freeze({ applicantId: applicant.applicantId, phase: 'loading', data: preserveStatus ? verificationContext?.data || null : null, error: '', status: '', statusType: '' });
    render();
    try {
      const data = await requestVerification(applicant.applicantId);
      if (version !== verificationRequestVersion || verificationContext?.applicantId !== applicant.applicantId || !canOpenForRole()) return false;
      verificationGateCache.set(applicant.applicantId, data.gate);
      verificationContext = Object.freeze({ applicantId: applicant.applicantId, phase: 'ready', data, error: '', status: '', statusType: '' });
      render();
      return true;
    } catch (error) {
      if (version !== verificationRequestVersion || verificationContext?.applicantId !== applicant.applicantId) return false;
      verificationContext = Object.freeze({ applicantId: applicant.applicantId, phase: 'error', data: null, error: error.message || 'Verification could not be loaded.', status: '', statusType: '' });
      render();
      return false;
    }
  }

  function openVerification(applicantId) {
    if (!canOpenForRole()) return false;
    const applicant = findApplicant(applicantId);
    if (!applicant) return false;
    loadVerification(applicant.applicantId);
    return true;
  }

  function closeVerification() {
    verificationRequestVersion += 1;
    abortVerificationRequest();
    verificationContext = null;
    render();
    return true;
  }

  function formValues(form) {
    const entries = {};
    for (const [key, value] of new FormData(form).entries()) entries[key] = typeof value === 'string' ? value.trim() : value;
    return entries;
  }

  function zonedLocalToIso(value, timezone) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text(value, 32));
    if (!match) return '';
    const desired = match.slice(1).map(Number);
    const target = Date.UTC(desired[0], desired[1] - 1, desired[2], desired[3], desired[4], 0, 0);
    let formatter;
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: requiredText(timezone, 'Time zone', 80), year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
      });
    } catch { return ''; }
    let candidate = target;
    for (let index = 0; index < 3; index += 1) {
      const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate)).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
      const renderedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0, 0);
      candidate = target - (renderedAsUtc - candidate);
    }
    const check = Object.fromEntries(formatter.formatToParts(new Date(candidate)).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
    if (check.year !== desired[0] || check.month !== desired[1] || check.day !== desired[2] || check.hour !== desired[3] || check.minute !== desired[4]) return '';
    return new Date(candidate).toISOString();
  }

  async function postVerificationAction(action, values) {
    if (!verificationContext?.data || !canOpenForRole()) throw new Error('Refresh this verification record and try again.');
    const body = buildVerificationAction(action, { applicantId: verificationContext.applicantId, ...values });
    if (['schedule_interview', 'reschedule_interview'].includes(body.action) && !verificationContext.data.interviewers.some(item => item.id === body.interviewerUserId)) {
      throw new Error('Choose an eligible interviewer from the current staff list.');
    }
    const data = await requestVerification(verificationContext.applicantId, { body });
    verificationGateCache.set(verificationContext.applicantId, data.gate);
    verificationContext = Object.freeze({
      applicantId: verificationContext.applicantId, phase: 'ready', data, error: '',
      status: 'Verification saved.', statusType: 'success'
    });
    render();
    return data;
  }

  function findApplicant(applicantId) {
    const id = validUuid(applicantId);
    return id ? queue.applicants.find(applicant => applicant.applicantId === id) || null : null;
  }

  function openActionDialog(applicantId, action) {
    const applicant = findApplicant(applicantId);
    const normalizedAction = text(action, 40).toLowerCase();
    if (!applicant || !ACTION_SET.has(normalizedAction) || !applicant.allowedActions.includes(normalizedAction)) return false;
    actionContext = Object.freeze({ applicantId: applicant.applicantId, action: normalizedAction });
    render();
    return true;
  }

  function closeActionDialog() {
    actionContext = null;
    render();
  }

  async function changeApplicant({ applicantId, expectedUpdatedAt, action, note = '' } = {}) {
    if (!canOpenForRole()) throw new Error('Only Admin and Talent Management can update Talent review records.');
    const id = validUuid(applicantId);
    const expected = validTimestamp(expectedUpdatedAt);
    const normalizedAction = text(action, 40).toLowerCase();
    const normalizedNote = text(note, 500);
    if (!id || !expected || !ACTION_SET.has(normalizedAction)) {
      throw new Error('The Talent review update was incomplete. Refresh the record and try again.');
    }
    const applicant = findApplicant(id);
    if (applicant && !applicant.allowedActions.includes(normalizedAction)) {
      throw new Error('That review action is not currently available. Refresh the queue and try again.');
    }
    if (NOTE_REQUIRED_ACTIONS.has(normalizedAction) && !normalizedNote) throw new Error('Add a review note before continuing.');
    const next = await requestQueue({
      method: 'POST',
      body: { requestId: makeRequestId(), applicantId: id, expectedUpdatedAt: expected, action: normalizedAction, note: normalizedNote }
    });
    if (mountedRoot) return setQueue(next);
    queue = next;
    dispatchUpdated();
    return queue;
  }

  async function submitAction(applicantId, action, note = '') {
    const applicant = findApplicant(applicantId);
    if (!applicant) throw new Error('That Talent application is no longer in this queue. Refresh and try again.');
    const next = await changeApplicant({
      applicantId: applicant.applicantId,
      expectedUpdatedAt: applicant.updatedAt,
      action,
      note
    });
    actionContext = null;
    feedback = Object.freeze({ type: 'success', message: `${applicant.fullName} moved to the next review step.` });
    render();
    return next;
  }

  function confirmationMessage(applicant, action) {
    if (action === 'decline') return `Decline ${applicant.fullName}’s application? The review note will remain in the audit history.`;
    if (action === 'archive') return `Archive ${applicant.fullName}’s application? The record will leave the active review queue.`;
    if (action === 'restore') return `Restore ${applicant.fullName}’s application to its previous review stage?`;
    return '';
  }

  async function handleClick(event) {
    const refreshButton = event.target.closest?.('[data-review-refresh]');
    if (refreshButton) { event.preventDefault(); refresh(); return; }
    const stageButton = event.target.closest?.('[data-review-stage]');
    if (stageButton) { event.preventDefault(); setStageFilter(stageButton.dataset.reviewStage); return; }
    const resumeButton = event.target.closest?.('[data-review-resume]');
    if (resumeButton) {
      event.preventDefault();
      openResume(resumeButton.dataset.reviewResume);
      return;
    }
    const verificationButton = event.target.closest?.('[data-review-verification]');
    if (verificationButton) { event.preventDefault(); openVerification(verificationButton.dataset.reviewVerification); return; }
    const verificationClose = event.target.closest?.('[data-verification-close]');
    if (verificationClose) { event.preventDefault(); closeVerification(); return; }
    const verificationRetry = event.target.closest?.('[data-verification-retry]');
    if (verificationRetry) { event.preventDefault(); loadVerification(verificationContext?.applicantId); return; }
    const verificationQuickAction = event.target.closest?.('[data-verification-quick-action]');
    if (verificationQuickAction && verificationContext?.data?.interview) {
      event.preventDefault();
      const interview = verificationContext.data.interview;
      verificationQuickAction.disabled = true;
      try { await postVerificationAction(verificationQuickAction.dataset.verificationQuickAction, { interviewId: interview.interviewId, expectedUpdatedAt: interview.updatedAt }); }
      catch (error) {
        verificationContext = Object.freeze({ ...verificationContext, status: error.message || 'Calendar sync could not be retried.', statusType: 'error' });
        render();
      }
      return;
    }
    const removeReference = event.target.closest?.('[data-verification-remove-reference]');
    if (removeReference && verificationContext?.data) {
      event.preventDefault();
      const referenceId = removeReference.closest?.('[data-verification-reference]')?.dataset.verificationReference;
      const reference = verificationContext.data.references.find(item => item.referenceId === referenceId);
      if (!reference || !root?.confirm?.(`Remove ${reference.name} from this verification record?`)) return;
      removeReference.disabled = true;
      try { await postVerificationAction('remove_reference', { referenceId, expectedUpdatedAt: reference.updatedAt }); }
      catch (error) {
        verificationContext = Object.freeze({ ...verificationContext, status: error.message || 'The reference could not be removed.', statusType: 'error' });
        render();
      }
      return;
    }
    const profileButton = event.target.closest?.('[data-review-profile]');
    if (profileButton) { event.preventDefault(); openProfile(profileButton.dataset.reviewProfile); return; }
    const closeButton = event.target.closest?.('[data-review-dialog-close]');
    if (closeButton) { event.preventDefault(); closeActionDialog(); return; }
    const actionButton = event.target.closest?.('[data-review-action]');
    if (!actionButton) return;
    event.preventDefault();
    const card = actionButton.closest('[data-review-applicant]');
    const applicant = findApplicant(card?.dataset.reviewApplicant);
    const action = text(actionButton.dataset.reviewAction, 40).toLowerCase();
    if (!applicant || !applicant.allowedActions.includes(action)) return;
    if (NOTE_REQUIRED_ACTIONS.has(action)) { openActionDialog(applicant.applicantId, action); return; }
    if (CONFIRM_ACTIONS.has(action) && !root?.confirm?.(confirmationMessage(applicant, action))) return;
    actionButton.disabled = true;
    try { await submitAction(applicant.applicantId, action); }
    catch (error) {
      feedback = Object.freeze({ type: 'error', message: error.message || 'The review stage could not be updated.' });
      render();
    }
  }

  function handleInput(event) {
    const search = event.target.closest?.('[data-review-search]');
    if (search) setSearch(search.value);
  }

  async function handleVerificationSubmit(form) {
    if (!verificationContext?.data) return false;
    const action = text(form.dataset.verificationForm, 50).toLowerCase();
    const values = formValues(form);
    const interview = verificationContext.data.interview;
    const referenceId = form.closest?.('[data-verification-reference]')?.dataset.verificationReference || '';
    const reference = referenceId ? verificationContext.data.references.find(item => item.referenceId === referenceId) : null;
    let bodyValues = {};
    if (action === 'schedule_interview' || action === 'reschedule_interview') {
      bodyValues = {
        ...(action === 'reschedule_interview' ? { interviewId: interview?.interviewId, expectedUpdatedAt: interview?.updatedAt } : {}),
        startsAt: zonedLocalToIso(values.startsAt, values.timezone), durationMinutes: values.durationMinutes,
        timezone: values.timezone, interviewerUserId: values.interviewerUserId
      };
    } else if (action === 'cancel_interview') {
      bodyValues = { interviewId: interview?.interviewId, expectedUpdatedAt: interview?.updatedAt, note: values.note };
    } else if (action === 'record_interview_outcome') {
      bodyValues = {
        interviewId: interview?.interviewId, expectedUpdatedAt: interview?.updatedAt,
        status: values.status, outcome: values.outcome,
        communicationScore: values.communicationScore, preparednessScore: values.preparednessScore,
        roleFitScore: values.roleFitScore, overallScore: values.overallScore, note: values.note
      };
    } else if (action === 'save_reference') {
      bodyValues = {
        referenceId: reference?.referenceId || null, expectedUpdatedAt: reference?.updatedAt || null,
        name: values.name, company: values.company, relationship: values.relationship, phone: values.phone, email: values.email
      };
    } else if (action === 'record_reference_attempt') {
      bodyValues = {
        referenceId: reference?.referenceId, expectedUpdatedAt: reference?.updatedAt,
        method: values.method, result: values.result, attemptedAt: zonedLocalToIso(values.attemptedAt, defaultTimezone()), note: values.note
      };
    } else if (action === 'set_reference_outcome') {
      bodyValues = { referenceId: reference?.referenceId, expectedUpdatedAt: reference?.updatedAt, outcome: values.outcome, note: values.note };
    } else return false;
    const submit = form.querySelector?.('[type="submit"]');
    if (submit) submit.disabled = true;
    try { await postVerificationAction(action, bodyValues); }
    catch (error) {
      if (submit) submit.disabled = false;
      verificationContext = Object.freeze({ ...verificationContext, status: error.message || 'The verification update could not be saved.', statusType: 'error' });
      render();
    }
    return true;
  }

  async function handleSubmit(event) {
    const verificationForm = event.target.closest?.('[data-verification-form]');
    if (verificationForm) {
      event.preventDefault();
      await handleVerificationSubmit(verificationForm);
      return;
    }
    const form = event.target.closest?.('[data-review-action-form]');
    if (!form || !actionContext) return;
    event.preventDefault();
    const applicant = findApplicant(actionContext.applicantId);
    if (!applicant) { closeActionDialog(); return; }
    const note = text(new FormData(form).get('note'), 500);
    const status = form.querySelector('.talent-review-dialog-status');
    if (!note) { if (status) status.textContent = 'Add a review note before continuing.'; return; }
    if (CONFIRM_ACTIONS.has(actionContext.action)) {
      const message = confirmationMessage(applicant, actionContext.action);
      if (!root?.confirm?.(message)) return;
    }
    const submit = form.querySelector('[type="submit"]');
    if (submit) submit.disabled = true;
    if (status) status.textContent = 'Saving the review update…';
    try { await submitAction(applicant.applicantId, actionContext.action, note); }
    catch (error) {
      if (submit) submit.disabled = false;
      if (status) status.textContent = error.message || 'The review update could not be saved.';
    }
  }

  function unmount({ clear = true } = {}) {
    requestVersion += 1;
    verificationRequestVersion += 1;
    abortActiveRequest();
    abortVerificationRequest();
    if (mountedRoot) {
      mountedRoot.removeEventListener?.('click', handleClick);
      mountedRoot.removeEventListener?.('input', handleInput);
      mountedRoot.removeEventListener?.('submit', handleSubmit);
      if (clear) mountedRoot.innerHTML = '';
    }
    mountedRoot = null;
    actionContext = null;
    verificationContext = null;
    verificationGateCache.clear();
    return true;
  }

  function mount(target) {
    if (!target || typeof target.addEventListener !== 'function' || !canOpenForRole()) return false;
    if (mountedRoot && mountedRoot !== target) unmount();
    mountedRoot = target;
    target.removeEventListener('click', handleClick);
    target.removeEventListener('input', handleInput);
    target.removeEventListener('submit', handleSubmit);
    target.addEventListener('click', handleClick);
    target.addEventListener('input', handleInput);
    target.addEventListener('submit', handleSubmit);
    filters = Object.freeze({ stage: 'all', search: '' });
    queue = emptyQueue();
    render();
    refresh();
    return true;
  }

  function bindDashboardMetric(scope = root?.document, { currentView = '', actualRole: roleValue = actualRole() } = {}) {
    if (text(currentView, 40).toLowerCase() !== 'overview' || !canOpenForRole(roleValue)) return false;
    const metric = [...(scope?.querySelectorAll?.('[data-metric]') || [])]
      .find(button => text(button.querySelector('p')?.textContent, 100).toLowerCase() === 'talent review queue');
    if (!metric || metric.dataset.talentReviewQueueBound === 'true') return Boolean(metric);
    metric.dataset.talentReviewQueueBound = 'true';
    metric.setAttribute('aria-label', 'Open the Talent Application Review Queue');
    metric.addEventListener('click', event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (typeof root?.CustomEvent === 'function') {
        root.dispatchEvent?.(new root.CustomEvent('soro:talent-review-open-queue'));
      }
    });
    return true;
  }

  function dashboardMetric(fallbackMetric, roleValue = actualRole(), queueValue = queue) {
    if (!canOpenForRole(roleValue)) return fallbackMetric;
    if (queueValue?.phase === 'ready') {
      const summary = queueValue.summary || emptySummary();
      const reviewCount = summary.submitted + summary.in_review + summary.needs_more_info;
      const detail = reviewCount
        ? `${summary.submitted} new · ${summary.needs_more_info} need information`
        : 'No applications currently need review';
      return ['Talent Review Queue', String(reviewCount), detail, summary.needs_more_info ? 'warning' : ''];
    }
    if (queueValue?.phase === 'error') return ['Talent Review Queue', '—', 'Queue unavailable · select to retry', 'warning'];
    return ['Talent Review Queue', '—', 'Loading live applications…', ''];
  }

  function handleAuthChange(event) {
    const detail = event?.detail || event || {};
    if (!detail.session || !canOpenForRole(detail.access?.role)) {
      if (mountedRoot) unmount();
      return Promise.resolve(emptyQueue());
    }
    return refresh();
  }

  root?.addEventListener?.('soro-auth-changed', handleAuthChange);

  return Object.freeze({
    ENDPOINT,
    VERIFICATION_ENDPOINT,
    STAGES,
    ACTIONS,
    STAGE_LABELS,
    canUse,
    canOpenForRole,
    normalizePayload,
    normalizeVerificationPayload,
    buildVerificationAction,
    zonedLocalToIso,
    currentQueue,
    visibleApplicants,
    setStageFilter,
    setSearch,
    openResume,
    openVerification,
    changeApplicant,
    refresh,
    mount,
    unmount,
    dashboardMetric,
    bindDashboardMetric,
    handleAuthChange
  });
}));
