/* Full-day Talent time-off requests for the Talent Portal and management queue. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.soroTalentTimeOff = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const ENDPOINT = '/.netlify/functions/talent-time-off';
  const TALENT_ROLE = 'virtual_assistant';
  const MANAGEMENT_ROLES = Object.freeze(['admin', 'talent_management']);
  const AUTHORIZED_ROLES = new Set([TALENT_ROLE, ...MANAGEMENT_ROLES]);
  const REQUEST_STATUSES = new Set(['pending', 'approved', 'declined', 'cancelled']);
  const REQUEST_KEYS = Object.freeze([
    'timeOffRequestId', 'applicantId', 'applicantName', 'placementId',
    'clientName', 'startDate', 'endDate', 'workTimezone', 'status', 'note',
    'submittedAt', 'decidedAt', 'decisionNote', 'canCancel'
  ]);

  let portal = freezePortal({ phase: 'idle', viewerRole: '', eligibility: null, requests: [] });
  let filters = Object.freeze({ status: 'all', query: '' });
  let feedback = Object.freeze({ type: '', message: '' });
  let actionPending = '';
  let activeController = null;
  let requestVersion = 0;

  function text(value, max = 300) {
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

  function canLoadForRole(roleValue = actualRole()) {
    return AUTHORIZED_ROLES.has(normalizedRole(roleValue));
  }

  function isManagementRole(roleValue = actualRole()) {
    return MANAGEMENT_ROLES.includes(normalizedRole(roleValue));
  }

  function validUuid(value) {
    const normalized = text(value, 64);
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)
      ? normalized
      : '';
  }

  function validDate(value) {
    const normalized = text(value, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return '';
    const parsed = new Date(`${normalized}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === normalized
      ? normalized
      : '';
  }

  function validTimestamp(value) {
    const normalized = text(value, 50);
    return normalized && Number.isFinite(new Date(normalized).getTime()) ? normalized : '';
  }

  function freezeEligibility(value, viewerRole) {
    if (viewerRole !== TALENT_ROLE) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('The time-off service did not return Talent eligibility.');
    }
    const state = text(value.state, 80).toLowerCase() || 'unavailable';
    const placementId = validUuid(value.placementId || value.placement_id);
    const minStartDate = validDate(value.minStartDate || value.min_start_date);
    const eligible = value.eligible === true && state === 'eligible' && Boolean(placementId) && Boolean(minStartDate);
    return Object.freeze({
      eligible,
      state,
      placementId: eligible ? placementId : '',
      clientName: text(value.clientName || value.client_name, 160),
      workTimezone: text(value.workTimezone || value.work_timezone, 100),
      minStartDate
    });
  }

  function freezeRequest(value, viewerRole) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const status = text(value.status, 30).toLowerCase();
    const timeOffRequestId = validUuid(value.timeOffRequestId || value.time_off_request_id);
    const applicantId = validUuid(value.applicantId || value.applicant_id);
    const placementId = validUuid(value.placementId || value.placement_id);
    const startDate = validDate(value.startDate || value.start_date);
    const endDate = validDate(value.endDate || value.end_date);
    if (!timeOffRequestId || !applicantId || !placementId || !startDate || !endDate
      || endDate < startDate || !REQUEST_STATUSES.has(status)) return null;
    const applicantName = text(value.applicantName || value.applicant_name, 160);
    if (isManagementRole(viewerRole) && !applicantName) return null;
    return Object.freeze({
      timeOffRequestId,
      applicantId,
      applicantName,
      placementId,
      clientName: text(value.clientName || value.client_name, 160),
      startDate,
      endDate,
      workTimezone: text(value.workTimezone || value.work_timezone, 100),
      status,
      note: text(value.note, 300),
      submittedAt: validTimestamp(value.submittedAt || value.submitted_at),
      decidedAt: validTimestamp(value.decidedAt || value.decided_at),
      decisionNote: text(value.decisionNote || value.decision_note, 300),
      canCancel: value.canCancel === true || value.can_cancel === true
    });
  }

  function freezePortal(value) {
    return Object.freeze({
      phase: text(value?.phase, 20) || 'error',
      generatedAt: validTimestamp(value?.generatedAt),
      viewerRole: normalizedRole(value?.viewerRole),
      eligibility: value?.eligibility || null,
      requests: Object.freeze([...(value?.requests || [])]),
      message: text(value?.message, 240)
    });
  }

  function normalizePortal(payload, roleValue = actualRole()) {
    const expectedRole = normalizedRole(roleValue);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !canLoadForRole(expectedRole)) {
      throw new Error('The time-off service returned an invalid response.');
    }
    const viewerRole = normalizedRole(payload.viewerRole || payload.viewer_role);
    if (viewerRole !== expectedRole) throw new Error('The time-off response did not match the signed-in role.');
    const generatedAt = validTimestamp(payload.generatedAt || payload.generated_at);
    if (!generatedAt) throw new Error('The time-off response timestamp was invalid.');
    if (isManagementRole(viewerRole) && payload.eligibility != null) {
      throw new Error('The management time-off response included an unexpected Talent scope.');
    }
    const eligibility = freezeEligibility(payload.eligibility, viewerRole);
    if (!Array.isArray(payload.requests)) throw new Error('The time-off request history was invalid.');
    const requests = payload.requests.slice(0, 1000).map(value => freezeRequest(value, viewerRole));
    if (requests.some(value => !value)) throw new Error('The time-off request history contained an invalid entry.');
    return freezePortal({ phase: 'ready', generatedAt, viewerRole, eligibility, requests });
  }

  function currentPortal() {
    return portal;
  }

  function dispatchUpdated() {
    if (typeof root?.dispatchEvent !== 'function' || typeof root?.CustomEvent !== 'function') return;
    root.dispatchEvent(new root.CustomEvent('soro:talent-time-off-updated', {
      detail: { portal, pending: Boolean(actionPending) }
    }));
  }

  function setPortal(value) {
    portal = value;
    dispatchUpdated();
    renderOpenDialogs();
    return portal;
  }

  function setFeedback(type, message) {
    feedback = Object.freeze({ type: text(type, 20), message: text(message, 240) });
    renderOpenDialogs();
  }

  function abortActiveRequest() {
    activeController?.abort?.();
    activeController = null;
  }

  function reset({ silent = false } = {}) {
    requestVersion += 1;
    abortActiveRequest();
    filters = Object.freeze({ status: 'all', query: '' });
    feedback = Object.freeze({ type: '', message: '' });
    actionPending = '';
    portal = freezePortal({ phase: 'idle', viewerRole: '', eligibility: null, requests: [] });
    if (!silent) dispatchUpdated();
    renderOpenDialogs();
    return portal;
  }

  async function sessionToken() {
    if (!root?.soroSupabase?.auth?.getSession) throw new Error('Soro sign-in is still loading. Refresh and try again.');
    const { data: { session } = {}, error } = await root.soroSupabase.auth.getSession();
    if (error || !session?.access_token) throw new Error('Your secure session expired. Sign in again and retry.');
    return session.access_token;
  }

  async function request(method, payload) {
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
          ...(payload ? { 'Content-Type': 'application/json' } : {})
        },
        body: payload ? JSON.stringify(payload) : undefined,
        cache: 'no-store',
        signal: controller?.signal
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('The secure time-off request took too long. Please try again.');
      throw new Error('Soro could not reach the secure time-off service. Check your connection and try again.');
    } finally {
      if (timeout && typeof root?.clearTimeout === 'function') root.clearTimeout(timeout);
      if (activeController === controller) activeController = null;
    }
    const responseText = await response.text();
    let result = null;
    try { result = responseText ? JSON.parse(responseText) : null; }
    catch { throw new Error(`The secure time-off service returned an unexpected response (${response.status}).`); }
    if (!response.ok) {
      const error = new Error(result?.message || result?.error || 'The time-off request could not be completed.');
      error.code = text(result?.code, 80);
      error.status = response.status;
      throw error;
    }
    return result;
  }

  async function load() {
    const roleValue = actualRole();
    if (!canLoadForRole(roleValue)) return reset();
    const version = ++requestVersion;
    actionPending = '';
    feedback = Object.freeze({ type: '', message: '' });
    portal = freezePortal({ phase: 'loading', viewerRole: roleValue, eligibility: null, requests: [] });
    dispatchUpdated();
    renderOpenDialogs();
    try {
      const result = await request('GET');
      if (version !== requestVersion || actualRole() !== roleValue) return currentPortal();
      return setPortal(normalizePortal(result, roleValue));
    } catch (error) {
      if (version !== requestVersion || actualRole() !== roleValue) return currentPortal();
      return setPortal(freezePortal({
        phase: 'error', viewerRole: roleValue, eligibility: null, requests: [],
        message: error.message || 'The time-off service could not be loaded.'
      }));
    }
  }

  function secureRequestId() {
    if (typeof root?.crypto?.randomUUID !== 'function') {
      throw new Error('This browser cannot create a secure request. Refresh in a current browser and try again.');
    }
    return root.crypto.randomUUID();
  }

  async function performMutation(action, body, successMessage) {
    const roleValue = actualRole();
    if (!canLoadForRole(roleValue) || actionPending) return currentPortal();
    let requestId;
    try { requestId = secureRequestId(); }
    catch (error) { setFeedback('error', error.message); return currentPortal(); }
    const version = ++requestVersion;
    actionPending = action;
    setFeedback('', '');
    dispatchUpdated();
    renderOpenDialogs();
    try {
      const result = await request('POST', { action, requestId, ...body });
      if (version !== requestVersion || actualRole() !== roleValue) return currentPortal();
      actionPending = '';
      const next = normalizePortal(result, roleValue);
      portal = next;
      feedback = Object.freeze({ type: 'success', message: successMessage });
      dispatchUpdated();
      renderOpenDialogs();
      if (typeof root?.toast === 'function') root.toast(successMessage);
      return portal;
    } catch (error) {
      if (version !== requestVersion || actualRole() !== roleValue) return currentPortal();
      actionPending = '';
      setFeedback('error', error.message || 'The time-off action could not be completed.');
      dispatchUpdated();
      return currentPortal();
    }
  }

  async function submitRequest({ startDate, endDate, note = '' } = {}) {
    if (actualRole() !== TALENT_ROLE || portal.viewerRole !== TALENT_ROLE
      || portal.phase !== 'ready' || portal.eligibility?.eligible !== true) return currentPortal();
    const start = validDate(startDate);
    const end = validDate(endDate);
    const safeNote = text(note, 300);
    if (!start || !end || end < start) {
      setFeedback('error', 'Choose a valid start and end date. The end date cannot come before the start date.');
      return currentPortal();
    }
    if (portal.eligibility.minStartDate && start < portal.eligibility.minStartDate) {
      setFeedback('error', `Choose ${portal.eligibility.minStartDate} or a later date.`);
      return currentPortal();
    }
    return performMutation('submit', { startDate: start, endDate: end, note: safeNote }, 'Your time-off request was submitted for review.');
  }

  async function cancelRequest(timeOffRequestId) {
    const id = validUuid(timeOffRequestId);
    const entry = portal.requests.find(requestValue => requestValue.timeOffRequestId === id);
    if (actualRole() !== TALENT_ROLE || portal.viewerRole !== TALENT_ROLE || !entry?.canCancel) return currentPortal();
    return performMutation('cancel', { timeOffRequestId: id }, 'Your time-off request was cancelled.');
  }

  async function decideRequest(action, timeOffRequestId, note = '') {
    const decision = text(action, 20).toLowerCase();
    const id = validUuid(timeOffRequestId);
    const safeNote = text(note, 300);
    const entry = portal.requests.find(requestValue => requestValue.timeOffRequestId === id);
    if (!isManagementRole(actualRole()) || !isManagementRole(portal.viewerRole)
      || !entry || entry.status !== 'pending' || !['approve', 'decline'].includes(decision)) return currentPortal();
    if (decision === 'decline' && !safeNote) {
      setFeedback('error', 'Add a short note before marking this request Not approved.');
      return currentPortal();
    }
    return performMutation(decision, { timeOffRequestId: id, note: safeNote },
      decision === 'approve' ? 'The time-off request was approved.' : 'The time-off request was marked Not approved.');
  }

  function actionMarkup({ currentView = '', actualRole: roleValue = actualRole(), portal: portalValue = portal } = {}) {
    const roleName = normalizedRole(roleValue);
    if (text(currentView, 40).toLowerCase() !== 'overview' || roleName !== TALENT_ROLE
      || actualRole() !== TALENT_ROLE || portalValue?.phase !== 'ready'
      || portalValue?.viewerRole !== TALENT_ROLE || portalValue?.eligibility?.eligible !== true
      || !validUuid(portalValue.eligibility.placementId)) return '';
    return '<button class="button talent-time-off-open" type="button" data-time-off-open="talent">Request Time Off</button>';
  }

  function managementActionMarkup({ currentView = '', actualRole: roleValue = actualRole(), portal: portalValue = portal } = {}) {
    const roleName = normalizedRole(roleValue);
    if (text(currentView, 40).toLowerCase() !== 'overview' || !isManagementRole(roleName)
      || actualRole() !== roleName) return '';
    const pendingCount = portalValue?.phase === 'ready' && portalValue?.viewerRole === roleName
      ? portalValue.requests.filter(requestValue => requestValue.status === 'pending').length
      : null;
    const badge = Number.isSafeInteger(pendingCount) && pendingCount > 0
      ? `<span class="time-off-action-count" aria-label="${pendingCount} pending">${pendingCount}</span>`
      : '';
    return `<button class="button time-off-management-open" type="button" data-time-off-open="management">Time Off Requests${badge}</button>`;
  }

  const requestButtonMarkup = actionMarkup;
  const dashboardManagementMarkup = managementActionMarkup;

  function statusLabel(status) {
    return ({ pending: 'Pending review', approved: 'Approved', declined: 'Not approved', cancelled: 'Cancelled' })[status] || 'Unknown';
  }

  function formatDate(value) {
    const date = validDate(value);
    if (!date) return 'Date unavailable';
    return new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' })
      .format(new Date(`${date}T00:00:00.000Z`));
  }

  function dateRangeLabel(requestValue) {
    const start = formatDate(requestValue.startDate);
    const end = formatDate(requestValue.endDate);
    return requestValue.startDate === requestValue.endDate ? start : `${start} – ${end}`;
  }

  function filterRequests(rows, filterValue = filters) {
    const safeRows = Array.isArray(rows) ? rows : [];
    const safeFilters = filterValue && typeof filterValue === 'object' ? filterValue : {};
    const status = text(safeFilters.status, 30).toLowerCase() || 'all';
    const query = text(safeFilters.query, 160).toLowerCase();
    return safeRows.filter(requestValue => (
      (status === 'all' || requestValue.status === status)
      && (!query || [requestValue.applicantName, requestValue.clientName]
        .some(value => text(value, 160).toLowerCase().includes(query)))
    ));
  }

  function setFilter(key, value) {
    if (!['status', 'query'].includes(key)) return filters;
    let normalized = text(value, key === 'query' ? 160 : 30);
    if (key === 'status' && normalized !== 'all' && !REQUEST_STATUSES.has(normalized)) normalized = 'all';
    filters = Object.freeze({ ...filters, [key]: normalized || (key === 'status' ? 'all' : '') });
    renderOpenDialogs();
    return filters;
  }

  function feedbackMarkup() {
    if (!feedback.message) return '';
    return `<div class="time-off-feedback ${escapeHtml(feedback.type)}" role="${feedback.type === 'error' ? 'alert' : 'status'}">${escapeHtml(feedback.message)}</div>`;
  }

  function statusMarkup(status) {
    return `<span class="time-off-status ${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span>`;
  }

  function talentHistoryMarkup(requests) {
    if (!requests.length) return '<p class="time-off-empty">You have not submitted any time-off requests.</p>';
    return `<div class="time-off-history-list">${requests.map(requestValue => `<article class="time-off-history-card">
      <div><strong>${escapeHtml(dateRangeLabel(requestValue))}</strong><small>${escapeHtml(requestValue.clientName || 'Current client')} · ${escapeHtml(requestValue.workTimezone || 'Recorded time zone')}</small></div>
      <div class="time-off-history-state">${statusMarkup(requestValue.status)}${requestValue.canCancel ? `<button class="text-button" type="button" data-time-off-cancel="${escapeHtml(requestValue.timeOffRequestId)}"${actionPending ? ' disabled' : ''}>Cancel request</button>` : ''}</div>
      ${requestValue.note ? `<p><span>Your scheduling note</span>${escapeHtml(requestValue.note)}</p>` : ''}
      ${requestValue.decisionNote ? `<p><span>Review note</span>${escapeHtml(requestValue.decisionNote)}</p>` : ''}
    </article>`).join('')}</div>`;
  }

  function talentDialogMarkup(portalValue = portal) {
    if (portalValue.phase === 'loading' || portalValue.phase === 'idle') {
      return '<div class="time-off-loading" role="status">Loading your time-off options…</div>';
    }
    if (portalValue.phase === 'error') {
      return `<div class="time-off-error" role="alert"><strong>Time-off requests are unavailable</strong><p>${escapeHtml(portalValue.message)}</p><button class="button" type="button" data-time-off-refresh>Try again</button></div>`;
    }
    if (portalValue.viewerRole !== TALENT_ROLE) return '';
    const eligibility = portalValue.eligibility;
    const form = eligibility?.eligible ? `<form class="time-off-request-form" data-time-off-submit>
      <div class="time-off-date-grid">
        <label>First day off<input type="date" name="startDate" min="${escapeHtml(eligibility.minStartDate)}" required /></label>
        <label>Last day off<input type="date" name="endDate" min="${escapeHtml(eligibility.minStartDate)}" required /></label>
      </div>
      <label>Scheduling note <span>(optional)</span><textarea name="note" maxlength="300" rows="3" placeholder="Share a short scheduling note for Talent Management."></textarea><small>Do not include medical information or other sensitive personal details.</small></label>
      <div class="time-off-scope-note"><strong>Scheduling request only</strong><p>Approval records your availability with Soro. It does not change attendance, pay, benefits, or client billing.</p></div>
      <div class="time-off-form-actions"><button class="button primary" type="submit"${actionPending ? ' disabled aria-busy="true"' : ''}>${actionPending === 'submit' ? 'Submitting…' : 'Submit request'}</button></div>
    </form>` : `<div class="time-off-ineligible"><strong>Request Time Off is not available right now.</strong><p>${escapeHtml(eligibility?.state === 'needs_review' ? 'Talent Management needs to confirm your current client placement before requests can be submitted.' : 'This action appears once you have one current client placement.')}</p></div>`;
    return `${feedbackMarkup()}${form}<section class="time-off-history" aria-labelledby="talent-time-off-history-title"><div class="time-off-section-heading"><div><p class="eyebrow">Your requests</p><h3 id="talent-time-off-history-title">Request history</h3></div></div>${talentHistoryMarkup(portalValue.requests)}</section>`;
  }

  function managementDecisionMarkup(requestValue) {
    return `<form class="time-off-decision" data-time-off-decision-form data-time-off-request-id="${escapeHtml(requestValue.timeOffRequestId)}">
      <label>Review note <span>(required when Not approved)</span><textarea name="note" maxlength="300" rows="2" aria-describedby="time-off-decision-help-${escapeHtml(requestValue.timeOffRequestId)}"></textarea></label>
      <small id="time-off-decision-help-${escapeHtml(requestValue.timeOffRequestId)}" data-time-off-decision-error>Approval records scheduling availability only.</small>
      <div><button class="button" type="button" data-time-off-decision="decline"${actionPending ? ' disabled' : ''}>Not approved</button><button class="button primary" type="button" data-time-off-decision="approve"${actionPending ? ' disabled' : ''}>Approve</button></div>
    </form>`;
  }

  function managementRequestMarkup(requestValue) {
    return `<article class="time-off-management-card ${escapeHtml(requestValue.status)}">
      <header><div><strong>${escapeHtml(requestValue.applicantName)}</strong><small>${escapeHtml(requestValue.clientName || 'Client not recorded')}</small></div>${statusMarkup(requestValue.status)}</header>
      <dl><div><dt>Full-day dates</dt><dd>${escapeHtml(dateRangeLabel(requestValue))}</dd></div><div><dt>Time zone</dt><dd>${escapeHtml(requestValue.workTimezone || 'Not recorded')}</dd></div></dl>
      ${requestValue.note ? `<p class="time-off-note"><span>Talent scheduling note</span>${escapeHtml(requestValue.note)}</p>` : '<p class="time-off-note muted">No scheduling note provided.</p>'}
      ${requestValue.decisionNote ? `<p class="time-off-note"><span>Review note</span>${escapeHtml(requestValue.decisionNote)}</p>` : ''}
      ${requestValue.status === 'pending' ? managementDecisionMarkup(requestValue) : ''}
    </article>`;
  }

  function managementDialogMarkup(portalValue = portal) {
    if (portalValue.phase === 'loading' || portalValue.phase === 'idle') {
      return '<div class="time-off-loading" role="status">Loading the time-off review queue…</div>';
    }
    if (portalValue.phase === 'error') {
      return `<div class="time-off-error" role="alert"><strong>Time-off requests are unavailable</strong><p>${escapeHtml(portalValue.message)}</p><button class="button" type="button" data-time-off-refresh>Try again</button></div>`;
    }
    if (!isManagementRole(portalValue.viewerRole)) return '';
    const visible = filterRequests(portalValue.requests, filters);
    const pendingCount = portalValue.requests.filter(requestValue => requestValue.status === 'pending').length;
    const pending = visible.filter(requestValue => requestValue.status === 'pending');
    const history = visible.filter(requestValue => requestValue.status !== 'pending');
    return `${feedbackMarkup()}<div class="time-off-management-summary"><span><strong>${pendingCount}</strong> Pending review</span><p>Approval records schedule availability only; it does not alter attendance, pay, benefits, or billing.</p></div>
      <div class="time-off-management-filters">
        <label>Status<select data-time-off-filter="status"><option value="all"${filters.status === 'all' ? ' selected' : ''}>All statuses</option>${[...REQUEST_STATUSES].map(status => `<option value="${status}"${filters.status === status ? ' selected' : ''}>${escapeHtml(statusLabel(status))}</option>`).join('')}</select></label>
        <label>Search Talent or client<input type="search" value="${escapeHtml(filters.query)}" data-time-off-filter="query" placeholder="Name or client" /></label>
        <button class="button" type="button" data-time-off-refresh>Refresh</button>
      </div>
      <section class="time-off-management-section" aria-labelledby="time-off-pending-title"><div class="time-off-section-heading"><div><p class="eyebrow">Needs attention</p><h3 id="time-off-pending-title">Pending requests</h3></div><span>${pending.length}</span></div>${pending.length ? pending.map(managementRequestMarkup).join('') : '<p class="time-off-empty">No pending requests match these filters.</p>'}</section>
      <section class="time-off-management-section" aria-labelledby="time-off-history-title"><div class="time-off-section-heading"><div><p class="eyebrow">Recorded decisions</p><h3 id="time-off-history-title">Recent history</h3></div></div>${history.length ? history.map(managementRequestMarkup).join('') : '<p class="time-off-empty">No recent requests match these filters.</p>'}</section>`;
  }

  function renderOpenDialogs() {
    const talentDialog = root?.document?.getElementById?.('talent-time-off-dialog');
    const talentContent = root?.document?.getElementById?.('talent-time-off-content');
    if (talentDialog?.open && talentContent) talentContent.innerHTML = talentDialogMarkup();
    const managementDialog = root?.document?.getElementById?.('time-off-management-dialog');
    const managementContent = root?.document?.getElementById?.('time-off-management-content');
    if (managementDialog?.open && managementContent) managementContent.innerHTML = managementDialogMarkup();
  }

  function openTalentDialog() {
    if (actualRole() !== TALENT_ROLE) return false;
    const dialog = root?.document?.getElementById?.('talent-time-off-dialog');
    const content = root?.document?.getElementById?.('talent-time-off-content');
    if (!dialog || !content) return false;
    bindDialog();
    content.innerHTML = talentDialogMarkup();
    if (!dialog.open) dialog.showModal();
    if (portal.phase === 'idle' || portal.phase === 'error') load();
    return true;
  }

  function openManagementDialog() {
    if (!isManagementRole(actualRole())) return false;
    const dialog = root?.document?.getElementById?.('time-off-management-dialog');
    const content = root?.document?.getElementById?.('time-off-management-content');
    if (!dialog || !content) return false;
    bindDialog();
    content.innerHTML = managementDialogMarkup();
    if (!dialog.open) dialog.showModal();
    if (portal.phase === 'idle' || portal.phase === 'error') load();
    return true;
  }

  function bindDashboardActions(scope = root?.document, { currentView = '', actualRole: roleValue = actualRole() } = {}) {
    const authenticatedRole = actualRole();
    const requestedRole = normalizedRole(roleValue);
    if (text(currentView, 40).toLowerCase() !== 'overview' || !canLoadForRole(authenticatedRole)
      || requestedRole !== authenticatedRole) return false;
    let bound = false;
    for (const button of scope?.querySelectorAll?.('[data-time-off-open]') || []) {
      const target = text(button.dataset.timeOffOpen, 20).toLowerCase();
      const allowed = (target === 'talent' && authenticatedRole === TALENT_ROLE)
        || (target === 'management' && isManagementRole(authenticatedRole));
      if (!allowed || button.dataset.timeOffBound === 'true') continue;
      button.dataset.timeOffBound = 'true';
      button.addEventListener('click', event => {
        event.preventDefault();
        if (target === 'talent') openTalentDialog();
        else openManagementDialog();
      });
      bound = true;
    }
    return bound;
  }

  function bindDialog() {
    const talentDialog = root?.document?.getElementById?.('talent-time-off-dialog');
    if (talentDialog && talentDialog.dataset.timeOffBound !== 'true') {
      talentDialog.dataset.timeOffBound = 'true';
      talentDialog.addEventListener('change', event => {
        const start = event.target.closest?.('input[name="startDate"]');
        if (!start) return;
        const end = talentDialog.querySelector('input[name="endDate"]');
        if (end && (!end.value || end.value < start.value)) end.value = start.value;
      });
      talentDialog.addEventListener('submit', event => {
        const form = event.target.closest?.('[data-time-off-submit]');
        if (!form) return;
        event.preventDefault();
        const formData = new root.FormData(form);
        submitRequest({ startDate: formData.get('startDate'), endDate: formData.get('endDate'), note: formData.get('note') });
      });
      talentDialog.addEventListener('click', event => {
        const refresh = event.target.closest?.('[data-time-off-refresh]');
        if (refresh) { event.preventDefault(); load(); return; }
        const cancel = event.target.closest?.('[data-time-off-cancel]');
        if (cancel) { event.preventDefault(); cancelRequest(cancel.dataset.timeOffCancel); }
      });
    }
    const managementDialog = root?.document?.getElementById?.('time-off-management-dialog');
    if (managementDialog && managementDialog.dataset.timeOffBound !== 'true') {
      managementDialog.dataset.timeOffBound = 'true';
      managementDialog.addEventListener('input', event => {
        const control = event.target.closest?.('[data-time-off-filter="query"]');
        if (!control) return;
        const value = control.value;
        setFilter('query', value);
        const replacement = managementDialog.querySelector?.('[data-time-off-filter="query"]');
        replacement?.focus?.();
        replacement?.setSelectionRange?.(value.length, value.length);
      });
      managementDialog.addEventListener('change', event => {
        const control = event.target.closest?.('[data-time-off-filter="status"]');
        if (control) setFilter('status', control.value);
      });
      managementDialog.addEventListener('click', event => {
        const refresh = event.target.closest?.('[data-time-off-refresh]');
        if (refresh) { event.preventDefault(); load(); return; }
        const decision = event.target.closest?.('[data-time-off-decision]');
        if (!decision) return;
        event.preventDefault();
        const form = decision.closest('[data-time-off-decision-form]');
        const note = text(form?.querySelector?.('[name="note"]')?.value, 300);
        const error = form?.querySelector?.('[data-time-off-decision-error]');
        if (decision.dataset.timeOffDecision === 'decline' && !note) {
          if (error) { error.textContent = 'Add a short note before choosing Not approved.'; error.classList.add('error'); }
          form?.querySelector?.('[name="note"]')?.focus?.();
          return;
        }
        decideRequest(decision.dataset.timeOffDecision, form?.dataset.timeOffRequestId, note);
      });
    }
    return Boolean(talentDialog || managementDialog);
  }

  function handleAuthChange(event) {
    const detail = event?.detail || event || {};
    reset({ silent: true });
    const roleValue = normalizedRole(detail.access?.role);
    if (detail.session && canLoadForRole(roleValue) && roleValue === actualRole(detail.access)) return load();
    dispatchUpdated();
    return Promise.resolve(currentPortal());
  }

  root?.addEventListener?.('soro-auth-changed', handleAuthChange);

  return Object.freeze({
    ENDPOINT,
    TALENT_ROLE,
    MANAGEMENT_ROLES,
    REQUEST_KEYS,
    canLoadForRole,
    isManagementRole,
    normalizePortal,
    currentPortal,
    actionMarkup,
    requestButtonMarkup,
    managementActionMarkup,
    dashboardManagementMarkup,
    filterRequests,
    setFilter,
    talentDialogMarkup,
    managementDialogMarkup,
    load,
    reset,
    submitRequest,
    cancelRequest,
    decideRequest,
    openTalentDialog,
    openManagementDialog,
    bindDashboardActions,
    bindDialog,
    handleAuthChange
  });
}));
