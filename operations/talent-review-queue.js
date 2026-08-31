/* Authenticated Talent application review queue for Admin and Talent Management. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.soroTalentReviewQueue = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const ENDPOINT = '/.netlify/functions/talent-review-queue';
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
  let requestVersion = 0;
  let actionContext = null;
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
    return `<button type="button" class="button talent-review-action${primary ? ' primary' : ''}${guarded ? ' talent-review-action--guarded' : ''}${restore ? ' talent-review-action--restore' : ''}" data-review-action="${escapeHtml(action)}"${checklistIncomplete ? ' disabled title="Complete every review checklist item first"' : ''}>${escapeHtml(ACTION_LABELS[action])}</button>`;
  }

  function resumeButtonMarkup(applicant) {
    const available = applicant.resume.available;
    const label = available ? 'Open résumé' : 'Résumé not attached';
    const title = available ? applicant.resume.label : 'A secure résumé has not been attached';
    return `<button type="button" class="button talent-review-resume" data-review-resume="${escapeHtml(applicant.applicantId)}" aria-label="${escapeHtml(available ? `Open ${applicant.fullName}’s secure résumé in a new tab` : `${applicant.fullName} does not have a secure résumé attached`)}" title="${escapeHtml(title)}"${available ? '' : ' disabled aria-disabled="true"'}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v5h5M10 13h6m-6 4h4"/></svg><span>${label}</span></button>`;
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
        <div class="talent-review-card-main-actions">${resumeButtonMarkup(applicant)}<span class="talent-review-action-divider" aria-hidden="true"></span>${primaryActions.length ? primaryActions.map(action => actionButtonMarkup(action, applicant)).join('') : '<span class="talent-review-no-actions">No stage action needed</span>'}</div>
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
    const dialog = mountedRoot.querySelector?.('[data-review-dialog]');
    if (dialog && typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
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

  async function handleSubmit(event) {
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
    abortActiveRequest();
    if (mountedRoot) {
      mountedRoot.removeEventListener?.('click', handleClick);
      mountedRoot.removeEventListener?.('input', handleInput);
      mountedRoot.removeEventListener?.('submit', handleSubmit);
      if (clear) mountedRoot.innerHTML = '';
    }
    mountedRoot = null;
    actionContext = null;
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
    STAGES,
    ACTIONS,
    STAGE_LABELS,
    canUse,
    canOpenForRole,
    normalizePayload,
    currentQueue,
    visibleApplicants,
    setStageFilter,
    setSearch,
    openResume,
    changeApplicant,
    refresh,
    mount,
    unmount,
    dashboardMetric,
    bindDashboardMetric,
    handleAuthChange
  });
}));
