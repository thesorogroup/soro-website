/* Authenticated Talent application review queue for Admin and Talent Management. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.soroTalentReviewQueue = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const ENDPOINT = '/.netlify/functions/talent-review-queue';
  const AUTO_REFRESH_MS = 30000;
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
    begin_review: 'Start Review',
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
  let filters = Object.freeze({ stage: 'all', search: '', sort: 'newest' });
  let activeReview = null;
  let activeController = null;
  let activeVerificationController = null;
  let requestVersion = 0;
  let verificationRequestVersion = 0;
  let actionContext = null;
  let verificationContext = null;
  let evidence = { skills: null, resume: null };
  let resumeViewer = null;
  let evidenceVersion = 0;
  const evidenceRequests = {skills:0,resume:0};
  let pendingStageAction = false;
  let skillsSaving = false;
  let pendingVerificationAction = null;
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

  function accessFingerprint() {
    const access = root.soroCurrentAccess || {};
    return JSON.stringify([access.user_id || access.userId, access.organization_id, access.role, access.active, access.must_change_password]);
  }

  function checkRequestScope(scope) {
    if (scope !== accessFingerprint() || !canOpenForRole() || root.soroCurrentAccess?.active === false || root.soroCurrentAccess?.must_change_password === true) throw new Error('Your review access changed. Reopen the review queue.');
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

  function normalizeInterviewers(source, maximum = 200) {
    if (typeof source === 'undefined' || source === null) return Object.freeze([]);
    if (!Array.isArray(source) || source.length > maximum) return null;
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
    const additionalAttendees = normalizeInterviewers(source.additionalAttendees);
    if (!additionalAttendees || additionalAttendees.length > 50) return null;
    if (!interviewId || !INTERVIEW_STATUSES.has(status) || !updatedAt || !interviewerName || !CALENDAR_STATUSES.has(calendarStatus)) return null;
    if (interviewerSource?.id && !interviewerId) return null;
    if (source.startsAt && !startsAt) return null;
    if (source.endsAt && !endsAt) return null;
    if (outcome && !INTERVIEW_OUTCOMES.has(outcome)) return null;
    if (source.scorecard && !scorecard) return null;
    if (source.calendar?.joinUrl && !joinUrl) return null;
    return Object.freeze({
      interviewId, status, startsAt, endsAt, timezone, updatedAt,
      roundNumber: Math.max(1, Number(source.roundNumber) || 1),
      interviewer: Object.freeze({ id: interviewerId, name: interviewerName }),
      additionalAttendees,
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
    const availableAttendees = normalizeInterviewers(payload.availableAttendees, 10000);
    if (!availableAttendees) throw new Error('The company attendee list could not be verified.');
    const calendarIntegration = normalizeCalendarIntegration(payload.calendarIntegration);
    if (!generatedAt || !canOpenForRole(viewerRole) || viewerRole !== role || !applicant || !gate || !interviewers || !calendarIntegration || (payload.interview !== null && typeof payload.interview !== 'undefined' && !interview)) throw new Error('Talent verification access could not be verified.');
    const expectedId = validUuid(expectedApplicantId);
    if (!expectedId || applicant.applicantId !== expectedId) throw new Error('The verification response did not match this applicant.');
    if (!Array.isArray(payload.references) || payload.references.length > 20) throw new Error('The verification response contained an invalid reference list.');
    const references = payload.references.map(normalizeReference);
    if (references.some(item => !item) || new Set(references.map(item => item.referenceId)).size !== references.length) throw new Error('The verification response contained an invalid reference record.');
    const interviewHistory = (Array.isArray(payload.interviewHistory) ? payload.interviewHistory : []).map(normalizeInterview);
    if (interviewHistory.some(item => !item)) throw new Error('Interview history could not be verified.');
    return Object.freeze({ generatedAt, viewerRole, applicant, gate, interview, interviewHistory: Object.freeze(interviewHistory), references: Object.freeze(references), interviewers, availableAttendees, calendarIntegration });
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
    const scope = accessFingerprint();
    const token = await sessionToken();
    checkRequestScope(scope);
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
    checkRequestScope(scope);
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
    const scope = accessFingerprint(), ownerVersion = verificationRequestVersion;
    const token = await sessionToken();
    checkRequestScope(scope);
    if (body && ownerVersion !== verificationRequestVersion) throw new Error('This review changed before the request was sent. Reopen it and try again.');
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
    checkRequestScope(scope);
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

  function attendeeSelection(values) {
    if (!Object.hasOwn(values, 'additionalAttendeeUserIds')) return {};
    if (!Array.isArray(values.additionalAttendeeUserIds) || values.additionalAttendeeUserIds.length > 50) throw new Error('Choose up to 50 additional company attendees.');
    const ids = values.additionalAttendeeUserIds.map(id => validUuid(id));
    if (ids.some(id => !id)) throw new Error('Choose additional attendees from the company list.');
    return { additionalAttendeeUserIds: Object.freeze([...new Set(ids)].filter(id => id !== validUuid(values.interviewerUserId)).sort()) };
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
      return Object.freeze({ ...base, startsAt, durationMinutes, timezone, interviewerUserId, ...attendeeSelection(values) });
    }
    if (['reschedule_interview', 'schedule_follow_up_interview'].includes(normalizedAction)) {
      const base = verificationRequestBase(normalizedAction, applicantId, values.expectedUpdatedAt);
      const interviewId = validUuid(values.interviewId);
      const startsAt = validTimestamp(values.startsAt);
      const durationMinutes = Number(values.durationMinutes);
      const timezone = requiredText(values.timezone, 'Time zone', 80);
      const interviewerUserId = validUuid(values.interviewerUserId);
      if (!interviewId || !startsAt || !Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 240 || !interviewerUserId) throw new Error('Add a valid interview date, duration, time zone, and interviewer.');
      return Object.freeze({ ...base, interviewId, startsAt, durationMinutes, timezone, interviewerUserId, ...attendeeSelection(values) });
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
    if (activeReview && !findApplicant(activeReview.applicantId)) activeReview.applicantId = '';
    syncNavigationBadge(queue);
    dispatchUpdated();
    render();
    return queue;
  }

  function reviewDialogOpen() {
    return Boolean(root?.document?.querySelector?.('[data-review-dialog][open], [data-verification-dialog][open]'));
  }

  async function refresh(options = {}) {
    if (!canOpenForRole() || pendingStageAction) return currentQueue();
    const silent = options.silent === true && queue.phase === 'ready';
    const version = ++requestVersion;
    if (!silent) {
      activeReview = null;
      feedback = Object.freeze({ type: '', message: '' });
      queue = freezeQueue({ phase: 'loading', generatedAt: '', viewerRole: actualRole(), summary: emptySummary(), applicants: [] });
      syncNavigationBadge(queue);
      render();
    }
    try {
      const next = await requestQueue();
      if (version !== requestVersion || !canOpenForRole()) return currentQueue();
      if (silent && reviewDialogOpen()) return currentQueue();
      return setQueue(next);
    } catch (error) {
      if (version !== requestVersion || !canOpenForRole()) return currentQueue();
      if (silent) return currentQueue();
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
    const rank = new Map((activeReview?.order || []).map((id, index) => [id, index]));
    const matches = queue.applicants.filter(applicant => {
      // Keep only fresh, authorized records, in the order already on screen.
      if (rank.has(applicant.applicantId)) return true;
      if (filters.stage !== 'all' && filterStage(applicant) !== filters.stage) return false;
      if (!query) return true;
      return [applicant.fullName, applicant.preferredName, applicant.email, applicant.owner.name]
        .filter(Boolean).join(' ').toLowerCase().includes(query);
    }).sort((a, b) => {
      const dateOrder = (Date.parse(b.applicationReceivedAt) || 0) - (Date.parse(a.applicationReceivedAt) || 0);
      if (filters.sort === 'name') return a.fullName.localeCompare(b.fullName) || a.applicantId.localeCompare(b.applicantId);
      if (filters.sort === 'stage') return STAGES.indexOf(filterStage(a)) - STAGES.indexOf(filterStage(b)) || dateOrder || a.applicantId.localeCompare(b.applicantId);
      return (filters.sort === 'oldest' ? -dateOrder : dateOrder) || a.applicantId.localeCompare(b.applicantId);
    });
    if (!activeReview) return matches;
    return matches.sort((a, b) => (rank.get(a.applicantId) ?? Infinity) - (rank.get(b.applicantId) ?? Infinity));
  }

  function holdReview(applicantId) {
    const applicant = findApplicant(applicantId);
    if (!applicant || !canOpenForRole()) return false;
    activeReview = { applicantId: applicant.applicantId, order: visibleApplicants().map(item => item.applicantId) };
    return true;
  }

  function setSort(value) {
    return applyFilters({ ...filters, sort: ['newest', 'oldest', 'name', 'stage'].includes(value) ? value : 'newest' });
  }

  function applyFilters(next) {
    filters = Object.freeze(next);
    activeReview = null;
    render();
    return filters;
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
    return `<button type="button" class="button talent-review-verification" data-review-verification="${escapeHtml(applicant.applicantId)}" aria-label="Open verification for ${escapeHtml(applicant.fullName)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3h8v3h3v15H5V6h3z"/><path d="M9 13l2 2 4-5M9 8h6"/></svg><span><strong>Verification</strong><small>Skills &amp; references</small></span></button>`;
  }

  function interviewButtonMarkup(applicant) {
    return `<button type="button" class="button talent-review-verification" data-review-interview="${escapeHtml(applicant.applicantId)}" aria-label="Schedule interview for ${escapeHtml(applicant.fullName)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v16H4zM8 2v6m8-6v6M4 10h16"/></svg><span><strong>Schedule Interview</strong><small>Appointment &amp; outcome</small></span></button>`;
  }

  function applicantMarkup(applicant) {
    const notStarted = applicant.stage === 'submitted' && !applicant.archived;
    const primaryActions = applicant.allowedActions.filter(action => !SECONDARY_ACTIONS.has(action));
    const guardedActions = applicant.allowedActions.filter(action => SECONDARY_ACTIONS.has(action));
    const displayedStage = filterStage(applicant);
    const gate = verificationGateCache.get(applicant.applicantId);
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
        <span class="talent-review-owner"><span class="talent-review-owner-copy"><small>Review owner</small><strong title="${escapeHtml(applicant.owner.name)}">${escapeHtml(applicant.owner.name)}</strong></span>${!notStarted && actualRole() === 'admin' ? `<button type="button" class="button talent-review-owner-edit" data-review-reassign="${escapeHtml(applicant.applicantId)}" aria-label="Edit review owner for ${escapeHtml(applicant.fullName)}">Edit</button>` : ''}</span>
        <span><small>Last updated</small><strong>${escapeHtml(formatDate(applicant.updatedAt))}</strong></span>
      </div>
      ${checklistMarkup(applicant)}
      ${!notStarted && gate ? `<div class="talent-review-readiness"><strong>Bench readiness</strong><span>${gate.benchReadyEligible ? 'Interview and reference requirements addressed. Complete the checklist before moving to Bench Ready.' : gate.blockers.map(escapeHtml).join(' · ')}</span></div>` : ''}
      <footer class="talent-review-card-actions">
        <div class="talent-review-card-main-actions">${notStarted ? (applicant.allowedActions.includes('begin_review') ? actionButtonMarkup('begin_review', applicant) : '') : `${resumeButtonMarkup(applicant)}${verificationButtonMarkup(applicant)}${interviewButtonMarkup(applicant)}<span class="talent-review-action-divider" aria-hidden="true"></span>${primaryActions.length ? primaryActions.map(action => actionButtonMarkup(action, applicant)).join('') : '<span class="talent-review-no-actions">No stage action needed</span>'}`}</div>
        ${!notStarted && guardedActions.length ? `<details class="talent-review-secondary"><summary>More actions</summary><div>${guardedActions.map(action => actionButtonMarkup(action, applicant)).join('')}</div></details>` : ''}
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

  function attendeePickerMarkup(data, interview, primaryId) {
    const selected = new Set((interview?.additionalAttendees || []).map(person => person.id));
    const available = data.availableAttendees || [];
    const people = [...available, ...(interview?.additionalAttendees || []).filter(person => !available.some(item => item.id === person.id))];
    return `<fieldset class="talent-interview-attendees talent-verification-field-wide">
      <legend>Additional attendees <span>(optional)</span></legend>
      <p>Invite company teammates to join. The applicant and assigned interviewer are already included.</p>
      ${people.length ? `<label class="talent-interview-attendee-search"><span class="sr-only">Search company attendees</span><input type="search" data-attendee-search placeholder="Search teammates by name" autocomplete="off"></label>
      <div class="talent-interview-attendee-list">${people.map(person => {
        const unavailable = !available.some(item => item.id === person.id);
        return `<label data-attendee-row data-attendee-name="${escapeHtml(person.name.toLowerCase())}"${person.id === primaryId ? ' hidden' : ''}><input type="checkbox" name="additionalAttendeeUserId" value="${escapeHtml(person.id)}"${selected.has(person.id) && person.id !== primaryId ? ' checked' : ''}><span>${escapeHtml(person.name)}${unavailable ? '<small>No longer available — uncheck to remove</small>' : ''}</span></label>`;
      }).join('')}</div><p data-attendee-empty hidden>No teammates match your search.</p><small data-attendee-count>${[...selected].filter(id => id !== primaryId).length} selected</small>` : '<p>No additional company employees are available yet.</p>'}
    </fieldset>`;
  }

  function scheduleFormMarkup(data, interview = null, followUp = false) {
    const action = followUp ? 'schedule_follow_up_interview' : interview ? 'reschedule_interview' : 'schedule_interview';
    const title = followUp ? 'Schedule follow-up interview' : interview ? 'Reschedule appointment' : 'Schedule interview';
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
        <label><span>Date and time</span><input type="datetime-local" name="startsAt" value="${followUp ? '' : escapeHtml(dateTimeLocalValue(interview?.startsAt, interview?.timezone))}" required></label>
        <label><span>Duration</span><select name="durationMinutes" required><option value="30"${interviewDuration(interview) === 30 ? ' selected' : ''}>30 minutes</option><option value="45"${interviewDuration(interview) === 45 ? ' selected' : ''}>45 minutes</option><option value="60"${interviewDuration(interview) === 60 ? ' selected' : ''}>60 minutes</option><option value="90"${interviewDuration(interview) === 90 ? ' selected' : ''}>90 minutes</option></select></label>
        <label class="talent-verification-field-wide"><span>Time zone</span><input type="text" name="timezone" maxlength="80" value="${escapeHtml(interview?.timezone || defaultTimezone())}" required></label>
        ${interviewerControl}
        ${attendeePickerMarkup(data, interview, selectedInterviewerId)}
      </div>
      <p class="talent-verification-form-note">The applicant, assigned interviewer, and selected teammates receive the same calendar invitation and Teams link. Private review notes are never included.</p>
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
    const followUp = interview.status === 'no_show' || (interview.status === 'completed' && interview.outcome === 'follow_up');
    return `<section class="talent-verification-section">
      <div class="talent-verification-section-heading"><div><p class="eyebrow">Internal interview</p><h3>${escapeHtml(humanLabel(interview.status))}</h3></div><span class="talent-verification-state is-${escapeHtml(interview.status)}">${escapeHtml(humanLabel(interview.status))}</span></div>
      <div class="talent-verification-interview-summary"><div><small>Appointment</small><strong>${escapeHtml(formatDateTime(interview.startsAt, interview.timezone))}</strong></div><div><small>Interviewer</small><strong>${escapeHtml(interview.interviewer.name)}</strong></div>${interview.outcome ? `<div><small>Recommendation</small><strong>${escapeHtml(humanLabel(interview.outcome))}</strong></div>` : ''}</div>
      ${calendarMarkup(interview)}
      ${interview.additionalAttendees?.length ? `<p class="talent-verification-form-note"><strong>Additional attendees:</strong> ${interview.additionalAttendees.map(person => escapeHtml(person.name)).join(', ')}</p>` : ''}
      ${scorecardMarkup(interview.scorecard)}
      ${interview.notes ? `<div class="talent-verification-private-note"><strong>Internal note</strong><p>${escapeHtml(interview.notes)}</p></div>` : ''}
      ${interview.status === 'scheduled' ? `<div class="talent-verification-control-grid"><details><summary>Reschedule</summary>${scheduleFormMarkup(data, interview)}</details><details><summary>Complete or waive</summary>${outcomeFormMarkup(interview)}</details><details><summary>Cancel appointment</summary><form class="talent-verification-form" data-verification-form="cancel_interview"><label><span>Internal cancellation note</span><textarea name="note" maxlength="1000" required placeholder="Why is this appointment being cancelled?"></textarea></label><p class="talent-verification-form-note">This internal note is not sent in the calendar cancellation.</p><button type="submit" class="button talent-review-confirm-guarded">Cancel interview</button></form></details></div>` : ''}
      ${interview.status === 'cancelled' ? (interview.calendar.status === 'not_applicable' ? scheduleFormMarkup(data, interview) : '<p class="talent-verification-inline-error">Finish the Microsoft 365 cancellation above before rebooking this interview.</p>') : ''}
      ${followUp ? (['synced', 'not_applicable'].includes(interview.calendar.status) && data.applicant.stage === 'in_review' ? `<details class="talent-interview-follow-up"><summary>Schedule follow-up interview</summary><p>The previous appointment and its result will stay in Interview history. This creates a new invitation.</p>${scheduleFormMarkup(data, interview, true)}</details>` : '<p class="talent-verification-form-note">Complete calendar sync and keep the application in review before scheduling another round.</p>') : terminal ? '<p class="talent-verification-complete-copy">This interview requirement is addressed. Continue with reference verification.</p>' : ''}
      ${interview.status === 'scheduled' && Date.parse(interview.endsAt) <= Date.now() ? '<p class="talent-interview-result-due" role="status"><strong>Interview result due</strong><br>Record the outcome to complete the interviewer’s follow-up task.</p>' : ''}
      ${interviewHistoryMarkup(data.interviewHistory)}
    </section>`;
  }

  function interviewHistoryMarkup(history = []) {
    if (!history.length) return '';
    return `<section class="talent-interview-history" aria-label="Interview history"><h4>Interview history</h4><p>Previous rounds are saved for your team. Notes and scores stay private.</p>${[...history].reverse().map(item => `<details><summary><span>Round ${escapeHtml(item.roundNumber)} · ${escapeHtml(humanLabel(item.status))}</span><small>${escapeHtml(formatDateTime(item.startsAt, item.timezone))}</small></summary><div class="talent-interview-history-body"><p><strong>Interviewer:</strong> ${escapeHtml(item.interviewer.name)}</p>${item.additionalAttendees.length ? `<p><strong>Also invited:</strong> ${item.additionalAttendees.map(person => escapeHtml(person.name)).join(', ')}</p>` : ''}${item.outcome ? `<p><strong>Recommendation:</strong> ${escapeHtml(humanLabel(item.outcome))}</p>` : ''}${scorecardMarkup(item.scorecard)}${item.notes ? `<p>${escapeHtml(item.notes)}</p>` : ''}</div></details>`).join('')}</section>`;
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
    const interviewMode = verificationContext.mode === 'interview';
    let content = '';
    if (verificationContext.phase === 'loading') content = `<div class="talent-verification-loading" role="status">Loading ${interviewMode ? 'interview details' : 'skills and reference verification'}…</div>`;
    else if (verificationContext.phase === 'error') content = `<div class="talent-verification-error" role="alert"><strong>Verification unavailable</strong><p>${escapeHtml(verificationContext.error)}</p><button type="button" class="button" data-verification-retry>Try again</button></div>`;
    else if (verificationContext.data) content = `${verificationContext.status ? `<div class="talent-verification-feedback ${verificationContext.statusType === 'error' ? 'is-error' : ''}" role="status">${escapeHtml(verificationContext.status)}</div>` : ''}${interviewMode ? interviewMarkup(verificationContext.data) : `<section class="talent-verification-section"><div class="talent-verification-section-heading"><div><p class="eyebrow">Applicant-reported skills</p><h3>Verify skills &amp; experience</h3></div></div><div data-review-skills-panel>${root.soroTalentReviewEvidence?.skillsMarkup(evidence.skills) || '<p>Skill review is unavailable. Refresh the page.</p>'}</div></section>${referencesMarkup(verificationContext.data)}`}`;
    return `<dialog class="talent-verification-dialog${interviewMode ? '' : ' has-resume'}" data-verification-dialog data-verification-owner="${escapeHtml(verificationContext.applicantId)}" data-verification-mode="${interviewMode ? 'interview' : 'verification'}" aria-labelledby="talent-verification-title"><div class="talent-verification-shell"><header class="talent-verification-header"><div><p class="eyebrow">${interviewMode ? 'Schedule Interview' : 'Skills &amp; reference verification'}</p><h2 id="talent-verification-title">${escapeHtml(name)}</h2><p>${interviewMode ? 'Schedule or manage the appointment and record the interview outcome.' : 'Review the résumé alongside the reported skills and employment references.'}</p></div><button type="button" data-verification-close aria-label="Close verification">×</button></header><div class="talent-verification-workspace">${interviewMode ? '' : `<aside class="review-evidence-resume" data-review-resume-panel>${root.soroTalentReviewEvidence?.resumeMarkup(evidence.resume) || '<p>Résumé preview is unavailable.</p>'}</aside>`}<div class="talent-verification-body">${content}</div></div></div></dialog>`;
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
        <div class="talent-review-toolbar"><label class="talent-review-search"><span aria-hidden="true">⌕</span><input type="search" data-review-search value="${escapeHtml(filters.search)}" maxlength="120" placeholder="Search Talent, email, or owner" autocomplete="off" aria-label="Search Talent, email, or owner"></label><label class="talent-review-sort"><span>Sort by</span><select data-review-sort>${[['newest','Newest applications'],['oldest','Oldest applications'],['name','Name A–Z'],['stage','Review stage']].map(([value,label]) => `<option value="${value}"${filters.sort === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label><small>Updated ${escapeHtml(formatDate(queue.generatedAt))}</small></div>
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
    const existing = mountedRoot.querySelector?.('[data-verification-dialog]');
    if (existing && verificationContext && existing.dataset.verificationOwner === verificationContext.applicantId && existing.dataset.verificationMode === verificationContext.mode && root.document?.createElement) {
      // Leave the résumé browsing context mounted. Keep any unsaved skill choices
      // while a reference or interview update refreshes its own controls.
      const template = root.document.createElement('template');
      template.innerHTML = verificationDialogMarkup();
      const nextBody = template.content.querySelector('.talent-verification-body');
      const body = existing.querySelector('.talent-verification-body');
      const draft = body.querySelector('[data-review-skills-form]');
      const scroll = body.scrollTop;
      const workspace = existing.querySelector('.talent-verification-workspace');
      const workspaceScroll = workspace?.scrollTop || 0;
      body.innerHTML = nextBody.innerHTML;
      const nextDraft = body.querySelector('[data-review-skills-form]');
      if (draft && nextDraft) nextDraft.replaceWith(draft);
      body.scrollTop = scroll;
      if (workspace) workspace.scrollTop = workspaceScroll;
      return true;
    }
    // Anchor the viewport, even when the last edited card has been scrolled away.
    const visibleCard = activeReview && [...(mountedRoot.querySelectorAll?.('[data-review-applicant]') || [])].find(card => {
      const bounds = card.getBoundingClientRect();
      return bounds.bottom > 0 && bounds.top < (root.innerHeight || Infinity);
    });
    const anchorId = visibleCard?.dataset?.reviewApplicant || activeReview?.applicantId;
    const anchorSelector = anchorId ? `[data-review-applicant="${anchorId}"]` : '';
    const top = anchorSelector ? mountedRoot.querySelector?.(anchorSelector)?.getBoundingClientRect?.().top : null;
    const pageScroll = activeReview ? root.scrollY : null;
    const bodyScroll = mountedRoot.querySelector?.('.talent-verification-body')?.scrollTop || 0;
    stopResumeViewer();
    mountedRoot.innerHTML = pageMarkup();
    const body = mountedRoot.querySelector?.('.talent-verification-body');
    if (body) body.scrollTop = bodyScroll;
    const dialog = mountedRoot.querySelector?.('[data-review-dialog], [data-verification-dialog]');
    if (dialog) {
      dialog.addEventListener?.('cancel', event => {
        event.preventDefault();
        if (dialog.matches?.('[data-verification-dialog]')) closeVerification();
        else closeActionDialog();
      });
      if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
    }
    mountResumeViewer();
    const after = anchorSelector ? mountedRoot.querySelector?.(anchorSelector)?.getBoundingClientRect?.().top : null;
    if (Number.isFinite(top) && Number.isFinite(after) && typeof root.scrollBy === 'function') root.scrollBy({top: after - top, behavior:'instant'});
    else if (Number.isFinite(pageScroll)) root.scrollTo?.({top:pageScroll, behavior:'instant'});
    return true;
  }

  function setStageFilter(value) {
    const stage = text(value, 40).toLowerCase();
    return applyFilters({ ...filters, stage: stage === 'all' || FILTER_STAGE_SET.has(stage) ? stage : 'all' });
  }

  function setSearch(value) {
    applyFilters({ ...filters, search: text(value, 120) });
    const input = mountedRoot?.querySelector?.('[data-review-search]');
    input?.focus?.({preventScroll:true});
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
    holdReview(applicant.applicantId);
    root.dispatchEvent?.(new root.CustomEvent('soro:talent-review-open-resume', {
      detail: { applicantId: applicant.applicantId }
    }));
    return true;
  }

  async function loadVerification(applicantId, { preserveStatus = false, mode = verificationContext?.mode || 'verification' } = {}) {
    if (pendingVerificationAction) return false;
    if (!canOpenForRole()) return false;
    const applicant = findApplicant(applicantId) || (mode === 'interview' && validUuid(applicantId) ? {applicantId: validUuid(applicantId)} : null);
    if (!applicant) return false;
    const version = ++verificationRequestVersion;
    verificationContext = Object.freeze({ applicantId: applicant.applicantId, mode, phase: 'loading', data: preserveStatus ? verificationContext?.data || null : null, error: '', status: '', statusType: '' });
    render();
    try {
      const data = await requestVerification(applicant.applicantId);
      if (version !== verificationRequestVersion || verificationContext?.applicantId !== applicant.applicantId || !canOpenForRole()) return false;
      verificationGateCache.set(applicant.applicantId, data.gate);
      verificationContext = Object.freeze({ applicantId: applicant.applicantId, mode, phase: 'ready', data, error: '', status: '', statusType: '' });
      render();
      return true;
    } catch (error) {
      if (version !== verificationRequestVersion || verificationContext?.applicantId !== applicant.applicantId) return false;
      verificationContext = Object.freeze({ applicantId: applicant.applicantId, mode, phase: 'error', data: null, error: error.message || 'Verification could not be loaded.', status: '', statusType: '' });
      render();
      return false;
    }
  }

  function stopResumeViewer() {
    resumeViewer?.destroy();
    resumeViewer = null;
  }

  function mountResumeViewer() {
    const state = evidence.resume, service = root.soroTalentReviewEvidence;
    const host = mountedRoot?.querySelector?.('[data-private-pdf-viewer]');
    if (!host || state?.kind !== 'pdf' || !service?.authorized() || !root.soroPrivatePdfViewer) return;
    stopResumeViewer();
    const version = evidenceVersion, request = evidenceRequests.resume, accessScope = service.scope();
    const client = root.soroSupabase, id = verificationContext?.applicantId;
    resumeViewer = root.soroPrivatePdfViewer.mount(host, {
      url: state.url, storageOrigin: client.supabaseUrl,
      isCurrent: () => version === evidenceVersion && request === evidenceRequests.resume &&
        evidence.resume === state && verificationContext?.applicantId === id && verificationContext.mode !== 'interview' &&
        service.authorized() && service.scope() === accessScope && root.soroSupabase === client &&
        mountedRoot?.querySelector?.('[data-private-pdf-viewer]') === host
    });
  }

  async function loadEvidence(kind) {
    if (kind === 'skills' && skillsSaving) return;
    const service = root.soroTalentReviewEvidence, id = verificationContext?.applicantId;
    if (!service || !id || verificationContext.mode === 'interview') return;
    const version = evidenceVersion;
    const request = ++evidenceRequests[kind];
    const accessScope = service.scope();
    if (kind === 'resume') stopResumeViewer();
    evidence[kind] = null;
    const panel = () => mountedRoot?.querySelector?.(`[data-review-${kind === 'resume' ? 'resume' : 'skills'}-panel]`);
    if (panel()) panel().innerHTML = kind === 'resume' ? service.resumeMarkup(null) : service.skillsMarkup(null);
    let result;
    try { result = await (kind === 'resume' ? service.loadResume(id) : service.loadSkills(id)); }
    catch (error) {
      if (request !== evidenceRequests[kind] || version !== evidenceVersion || verificationContext?.applicantId !== id || service.scope() !== accessScope || !service.authorized()) return;
      result = {error: error.message};
    }
    if (request !== evidenceRequests[kind] || version !== evidenceVersion || verificationContext?.applicantId !== id || service.scope() !== accessScope || !service.authorized()) return;
    evidence[kind] = result;
    if (panel()) panel().innerHTML = kind === 'resume' ? service.resumeMarkup(evidence[kind]) : service.skillsMarkup(evidence[kind]);
    if (kind === 'resume') mountResumeViewer();
  }

  function openVerification(applicantId, mode = 'verification') {
    if (pendingVerificationAction) return false;
    if (!canOpenForRole()) return false;
    const applicant = findApplicant(applicantId);
    if (!applicant || (applicant.stage === 'submitted' && !applicant.archived)) return false;
    holdReview(applicant.applicantId);
    stopResumeViewer();
    evidenceVersion += 1;
    evidence = {skills:null,resume:null};
    loadVerification(applicant.applicantId, {mode});
    if (mode !== 'interview') { loadEvidence('skills'); loadEvidence('resume'); }
    return true;
  }

  async function openInterviewFromTask(applicantId) {
    if (!mountedRoot || !validUuid(applicantId) || !canOpenForRole() || pendingVerificationAction) return false;
    const loaded = await loadVerification(applicantId, {mode:'interview'});
    const result = mountedRoot?.querySelector?.('[data-verification-form="record_interview_outcome"]')?.closest('details');
    if (loaded && result) result.open=true;
    return loaded;
  }

  function closeVerification() {
    if (pendingVerificationAction) return false;
    stopResumeViewer();
    evidenceVersion += 1;
    evidence = {skills:null,resume:null};
    skillsSaving = false;
    verificationRequestVersion += 1;
    abortVerificationRequest();
    verificationContext = null;
    render();
    refresh({silent:true});
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
    if (pendingVerificationAction) return null;
    if (!verificationContext?.data || !canOpenForRole()) throw new Error('Refresh this verification record and try again.');
    const context = verificationContext, version = verificationRequestVersion;
    const body = buildVerificationAction(action, { applicantId: context.applicantId, ...values });
    if (['schedule_interview', 'reschedule_interview', 'schedule_follow_up_interview'].includes(body.action) && !verificationContext.data.interviewers.some(item => item.id === body.interviewerUserId)) {
      throw new Error('Choose an eligible interviewer from the current staff list.');
    }
    if (body.additionalAttendeeUserIds?.some(id => !context.data.availableAttendees.some(person => person.id === id))) {
      throw new Error('An additional attendee is no longer available. Uncheck them or refresh the company list.');
    }
    const label = verificationProgressLabel(body.action);
    const operation = {};
    pendingVerificationAction = operation;
    const dialog = mountedRoot?.querySelector?.('[data-verification-dialog]');
    const controls = [...(dialog?.querySelectorAll?.('button, input, select, textarea') || [])].map(control => ({control,disabled:control.disabled}));
    controls.forEach(({control}) => { control.disabled = true; });
    const finish = root.SoroActionProgress?.begin(label);
    operation.finish = finish;
    try {
    const data = await requestVerification(context.applicantId, { body });
    if (version !== verificationRequestVersion || verificationContext?.applicantId !== context.applicantId || !canOpenForRole()) return data;
    verificationGateCache.set(verificationContext.applicantId, data.gate);
    verificationContext = Object.freeze({
      applicantId: context.applicantId, mode: context.mode, phase: 'ready', data, error: '',
      status: context.mode === 'interview' ? 'Interview saved.' : 'Reference verification saved.', statusType: 'success'
    });
    render();
    return data;
    } finally {
      finish?.();
      if (pendingVerificationAction === operation) {
        pendingVerificationAction = null;
        controls.forEach(({control,disabled}) => { if (control.isConnected) control.disabled = disabled; });
      }
    }
  }

  function verificationProgressLabel(action) {
    return ({schedule_interview:'Scheduling interview…',reschedule_interview:'Rescheduling interview…',schedule_follow_up_interview:'Scheduling follow-up interview…',cancel_interview:'Cancelling interview…',retry_calendar_sync:'Updating interview calendar…',record_interview_outcome:'Saving interview outcome…'})[action] || 'Saving reference verification…';
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
    if (pendingStageAction) throw new Error('Please wait for the current review update to finish.');
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
    holdReview(id);
    const version = ++requestVersion;
    pendingStageAction = version;
    let next;
    try {
      next = await requestQueue({ method:'POST', body:{ requestId:makeRequestId(), applicantId:id, expectedUpdatedAt:expected, action:normalizedAction, note:normalizedNote } });
    } finally { if (pendingStageAction === version) pendingStageAction = false; }
    if (version !== requestVersion) return currentQueue();
    if (mountedRoot) return setQueue(next);
    queue = next;
    syncNavigationBadge(queue);
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
    if (pendingVerificationAction && event.target.closest?.('[data-verification-dialog]')) { event.preventDefault(); return; }
    const evidenceRetry = event.target.closest?.('[data-evidence-retry]');
    if (evidenceRetry) { event.preventDefault(); loadEvidence(evidenceRetry.dataset.evidenceRetry === 'resume' ? 'resume' : 'skills'); return; }
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
    const interviewButton = event.target.closest?.('[data-review-interview]');
    if (interviewButton) { event.preventDefault(); openVerification(interviewButton.dataset.reviewInterview, 'interview'); return; }
    const verificationClose = event.target.closest?.('[data-verification-close]');
    if (verificationClose) { event.preventDefault(); closeVerification(); return; }
    const verificationRetry = event.target.closest?.('[data-verification-retry]');
    if (verificationRetry) { event.preventDefault(); loadVerification(verificationContext?.applicantId); return; }
    const verificationQuickAction = event.target.closest?.('[data-verification-quick-action]');
    if (verificationQuickAction && verificationContext?.data?.interview) {
      event.preventDefault();
      const interview = verificationContext.data.interview;
      const context = verificationContext, version = verificationRequestVersion;
      verificationQuickAction.disabled = true;
      try { await postVerificationAction(verificationQuickAction.dataset.verificationQuickAction, { interviewId: interview.interviewId, expectedUpdatedAt: interview.updatedAt }); }
      catch (error) {
        if (version !== verificationRequestVersion || verificationContext?.applicantId !== context.applicantId) return;
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
      const context = verificationContext, version = verificationRequestVersion;
      if (!reference || !root?.confirm?.(`Remove ${reference.name} from this verification record?`)) return;
      removeReference.disabled = true;
      try { await postVerificationAction('remove_reference', { referenceId, expectedUpdatedAt: reference.updatedAt }); }
      catch (error) {
        if (version !== verificationRequestVersion || verificationContext?.applicantId !== context.applicantId) return;
        verificationContext = Object.freeze({ ...verificationContext, status: error.message || 'The reference could not be removed.', statusType: 'error' });
        render();
      }
      return;
    }
    const reassignButton = event.target.closest?.('[data-review-reassign]');
    if (reassignButton && actualRole() === 'admin') {
      event.preventDefault();
      holdReview(reassignButton.dataset.reviewReassign);
      root.SoroStaffAccount?.openOwnership('talent', reassignButton.dataset.reviewReassign, 'review', () => refresh({ silent: true }));
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

  function updateAttendeePicker(form) {
    const picker = form?.querySelector('.talent-interview-attendees');
    if (!picker) return;
    const query = (picker.querySelector('[data-attendee-search]')?.value || '').trim().toLowerCase();
    const primary = form.querySelector('[name="interviewerUserId"]')?.value;
    let visible = 0, selected = 0;
    picker.querySelectorAll('[data-attendee-row]').forEach(row => {
      const input = row.querySelector('input');
      if (input.value === primary) input.checked = false;
      row.hidden = input.value === primary || !row.dataset.attendeeName.includes(query);
      if (!row.hidden) visible += 1;
      if (input.checked) selected += 1;
    });
    const count = picker.querySelector('[data-attendee-count]'), empty = picker.querySelector('[data-attendee-empty]');
    if (count) count.textContent = `${selected} selected`;
    if (empty) empty.hidden = visible > 0;
  }

  function handleInput(event) {
    if (event.target.matches?.('[data-attendee-search]')) updateAttendeePicker(event.target.closest('form'));
    const search = event.target.closest?.('[data-review-search]');
    if (search) setSearch(search.value);
  }

  function handleChange(event) {
    if (event.target.matches?.('[name="interviewerUserId"], [name="additionalAttendeeUserId"]')) updateAttendeePicker(event.target.closest('form'));
    const sort = event.target.closest?.('[data-review-sort]');
    if (sort) setSort(sort.value);
  }

  async function saveReviewSkills(form) {
    if (pendingVerificationAction) return;
    const service = root.soroTalentReviewEvidence, context = verificationContext, snapshot = evidence.skills, version = evidenceVersion;
    if (skillsSaving || !service || context?.mode === 'interview' || !snapshot?.record) return;
    skillsSaving = true;
    evidenceRequests.skills += 1;
    const names = service.skillNames(snapshot.record);
    const selected = [...form.querySelectorAll('[name="verified_skill"]:checked')].map(input => ({name: names[Number(input.value)], years: form.elements[`skill_years_${input.value}`]?.value || ''}));
    const status = form.querySelector('[data-review-skills-status]'), submit = form.querySelector('[type="submit"]');
    if (submit) submit.disabled = true;
    if (status) status.textContent = 'Saving verified skills…';
    try {
      const saved = await service.saveSkills(context.applicantId, snapshot, selected);
      if (version !== evidenceVersion || verificationContext?.applicantId !== context.applicantId || !service.authorized()) return;
      evidence.skills = saved;
      if (status) status.textContent = 'Verified skills saved to the Talent profile.';
    } catch (error) {
      if (version !== evidenceVersion || verificationContext?.applicantId !== context.applicantId) return;
      if (status) status.textContent = error.message || 'Skills could not be saved.';
    } finally { if (version === evidenceVersion) skillsSaving = false; if (submit?.isConnected) submit.disabled = false; }
  }

  async function handleVerificationSubmit(form) {
    if (pendingVerificationAction || !verificationContext?.data) return false;
    const context = verificationContext, version = verificationRequestVersion;
    const action = text(form.dataset.verificationForm, 50).toLowerCase();
    const values = formValues(form);
    const interview = verificationContext.data.interview;
    const referenceId = form.closest?.('[data-verification-reference]')?.dataset.verificationReference || '';
    const reference = referenceId ? verificationContext.data.references.find(item => item.referenceId === referenceId) : null;
    let bodyValues = {};
    if (['schedule_interview', 'reschedule_interview', 'schedule_follow_up_interview'].includes(action)) {
      bodyValues = {
        ...(action !== 'schedule_interview' ? { interviewId: interview?.interviewId, expectedUpdatedAt: interview?.updatedAt } : {}),
        startsAt: zonedLocalToIso(values.startsAt, values.timezone), durationMinutes: values.durationMinutes,
        timezone: values.timezone, interviewerUserId: values.interviewerUserId,
        additionalAttendeeUserIds: [...form.querySelectorAll('[name="additionalAttendeeUserId"]:checked')].map(input => input.value)
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
    const submitLabel = submit?.textContent;
    if (submit) { submit.disabled = true; submit.textContent = verificationProgressLabel(action); submit.setAttribute?.('aria-busy', 'true'); }
    try { await postVerificationAction(action, bodyValues); }
    catch (error) {
      if (version !== verificationRequestVersion || verificationContext?.applicantId !== context.applicantId) return false;
      if (submit) submit.disabled = false;
      verificationContext = Object.freeze({ ...verificationContext, status: error.message || 'The verification update could not be saved.', statusType: 'error' });
      render();
    }
    finally { if (submit?.isConnected) { submit.disabled = false; submit.textContent = submitLabel; submit.removeAttribute?.('aria-busy'); } }
    return true;
  }

  async function handleSubmit(event) {
    const skillsForm = event.target.closest?.('[data-review-skills-form]');
    if (skillsForm) { event.preventDefault(); await saveReviewSkills(skillsForm); return; }
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

  function unmount({ clear = true, reset = false } = {}) {
    pendingVerificationAction?.finish?.();
    pendingVerificationAction = null;
    // The sidebar owns a background queue load even when the queue view is absent.
    // Other portal renders must not cancel that load or strand it in loading state.
    if (!mountedRoot && !reset) return false;
    stopResumeViewer();
    requestVersion += 1;
    verificationRequestVersion += 1;
    evidenceVersion += 1;
    evidence = {skills:null,resume:null};
    skillsSaving = false;
    activeReview = null;
    pendingStageAction = false;
    abortActiveRequest();
    abortVerificationRequest();
    if (mountedRoot) {
      mountedRoot.removeEventListener?.('click', handleClick);
      mountedRoot.removeEventListener?.('input', handleInput);
      mountedRoot.removeEventListener?.('change', handleChange);
      mountedRoot.removeEventListener?.('submit', handleSubmit);
      if (clear) mountedRoot.innerHTML = '';
    }
    mountedRoot = null;
    actionContext = null;
    verificationContext = null;
    verificationGateCache.clear();
    if (queue.phase === 'loading') {
      queue = emptyQueue();
      syncNavigationBadge(queue);
    }
    return true;
  }

  function mount(target) {
    if (!target || typeof target.addEventListener !== 'function' || !canOpenForRole()) return false;
    if (mountedRoot && mountedRoot !== target) unmount();
    mountedRoot = target;
    target.removeEventListener('click', handleClick);
    target.removeEventListener('input', handleInput);
    target.removeEventListener('change', handleChange);
    target.removeEventListener('submit', handleSubmit);
    target.addEventListener('click', handleClick);
    target.addEventListener('input', handleInput);
    target.addEventListener('change', handleChange);
    target.addEventListener('submit', handleSubmit);
    filters = Object.freeze({ stage: 'all', search: '', sort: 'newest' });
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

  function navigationReviewCount(queueValue = queue) {
    if (queueValue?.phase !== 'ready') return 0;
    const summary = queueValue.summary || emptySummary();
    return summary.submitted + summary.in_review + summary.needs_more_info;
  }

  function syncNavigationBadge(queueValue = queue, roleValue = actualRole()) {
    const navigation = root?.document?.getElementById?.('talent-review-nav');
    const badge = root?.document?.getElementById?.('talent-review-count');
    if (!navigation || !badge) return 0;
    const count = canOpenForRole(roleValue) ? navigationReviewCount(queueValue) : 0;
    badge.textContent = String(count);
    badge.hidden = count === 0;
    navigation.setAttribute('aria-label', count ? `Talent Review Queue, ${count} awaiting review` : 'Talent Review Queue, none awaiting review');
    return count;
  }

  function handleAuthChange(event) {
    const detail = event?.detail || event || {};
    // Reset shared state on every auth transition, including when no view is mounted.
    unmount({ reset: true });
    filters = Object.freeze({ stage: 'all', search: '', sort: 'newest' });
    feedback = Object.freeze({ type: '', message: '' });
    setQueue(emptyQueue());
    if (!detail.session || !canOpenForRole(detail.access?.role)) {
      syncNavigationBadge(emptyQueue(), detail.access?.role);
      return Promise.resolve(currentQueue());
    }
    return refresh();
  }

  function refreshWhenActive() {
    if (!canOpenForRole() || queue.phase === 'loading' || reviewDialogOpen() || root?.document?.visibilityState === 'hidden') return;
    refresh({ silent: true });
  }

  root?.addEventListener?.('soro-auth-changed', handleAuthChange);
  if (root?.document) {
    root.addEventListener?.('focus', refreshWhenActive);
    root.document.addEventListener?.('visibilitychange', refreshWhenActive);
    root.setInterval?.(refreshWhenActive, AUTO_REFRESH_MS);
  }

  return Object.freeze({
    ENDPOINT,
    AUTO_REFRESH_MS,
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
    setSort,
    openResume,
    openVerification,
    openInterviewFromTask,
    changeApplicant,
    refresh,
    mount,
    unmount,
    dashboardMetric,
    bindDashboardMetric,
    navigationReviewCount,
    syncNavigationBadge,
    handleAuthChange
  });
}));
