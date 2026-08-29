/* Manual Talent Portal Start Day / Check Out dashboard control. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.soroTalentWorkday = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const ENDPOINT = '/.netlify/functions/talent-attendance';
  const TALENT_ROLE = 'virtual_assistant';
  const ACTION_BY_STATE = Object.freeze({
    not_started: Object.freeze({ action: 'start_day', label: 'Start Day' }),
    started: Object.freeze({ action: 'check_out', label: 'Check Out' })
  });
  const KNOWN_STATES = new Set([
    'idle', 'loading', 'not_started', 'started', 'completed',
    'unmatched', 'not_yet_available', 'needs_review', 'error'
  ]);

  let status = freezeStatus({ state: 'idle', eligible: false });
  let activeController = null;
  let requestVersion = 0;
  let actionPending = false;

  function text(value) {
    return String(value ?? '').trim();
  }

  function normalizedRole(value) {
    return text(value).toLowerCase();
  }

  function actualRole(access = root?.soroCurrentAccess) {
    return normalizedRole(access?.role);
  }

  function freezeStatus(value) {
    return Object.freeze({
      state: text(value?.state).toLowerCase() || 'error',
      eligible: value?.eligible === true,
      applicantId: text(value?.applicantId || value?.applicant_id),
      placementId: text(value?.placementId || value?.placement_id),
      sessionId: text(value?.sessionId || value?.session_id),
      clientName: text(value?.clientName || value?.client_name),
      scheduleSummary: text(value?.scheduleSummary || value?.schedule_summary),
      workDate: text(value?.workDate || value?.work_date),
      workTimezone: text(value?.workTimezone || value?.work_timezone),
      startedAt: text(value?.startedAt || value?.started_at),
      checkedOutAt: text(value?.checkedOutAt || value?.checked_out_at),
      message: text(value?.message)
    });
  }

  function normalizeStatus(payload) {
    const source = payload?.attendance || payload?.status || payload;
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      return freezeStatus({ state: 'error', eligible: false, message: 'Attendance status was unavailable.' });
    }
    const state = text(source.state).toLowerCase();
    if (!KNOWN_STATES.has(state)) {
      return freezeStatus({ state: 'error', eligible: false, message: 'Attendance status was unavailable.' });
    }
    const eligible = ['not_started', 'started', 'completed'].includes(state)
      ? source.eligible !== false
      : false;
    return freezeStatus({ ...source, state, eligible });
  }

  function dispatchUpdated() {
    if (typeof root?.dispatchEvent !== 'function' || typeof root?.CustomEvent !== 'function') return;
    root.dispatchEvent(new root.CustomEvent('soro:talent-workday-updated', {
      detail: { status, pending: actionPending }
    }));
  }

  function setStatus(nextStatus) {
    status = normalizeStatus(nextStatus);
    dispatchUpdated();
    return status;
  }

  function currentStatus() {
    return status;
  }

  function actionForStatus(statusValue, { currentView = '', actualRole: roleValue = '' } = {}) {
    if (normalizedRole(roleValue) !== TALENT_ROLE || text(currentView).toLowerCase() !== 'overview') return null;
    const normalized = normalizeStatus(statusValue);
    if (!normalized.eligible) return null;
    return ACTION_BY_STATE[normalized.state] || null;
  }

  function actionMarkup({ currentView = '', actualRole: roleValue = actualRole(), status: statusValue = status } = {}) {
    const action = actionForStatus(statusValue, { currentView, actualRole: roleValue });
    if (!action) return '';
    const busy = actionPending && statusValue === status;
    return `<button class="button primary" type="button" id="talent-workday-action" data-talent-workday-action="${action.action}"${busy ? ' disabled aria-busy="true"' : ''}>${action.label}</button>`;
  }

  function validDate(value) {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }

  function displayTime(value, timeZone) {
    const date = validDate(value);
    if (!date) return '';
    try {
      return new Intl.DateTimeFormat(undefined, {
        timeZone: text(timeZone) || undefined,
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short'
      }).format(date);
    } catch {
      return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    }
  }

  function metricForStatus(statusValue) {
    const normalized = normalizeStatus(statusValue);
    const client = normalized.clientName ? ` · ${normalized.clientName}` : '';
    if (normalized.state === 'not_started') return ['Today’s work', 'Not started', `Ready to start${client}`, ''];
    if (normalized.state === 'started') {
      const time = displayTime(normalized.startedAt, normalized.workTimezone);
      return ['Today’s work', 'Active', `${time ? `Started at ${time}` : 'Workday in progress'}${client}`, ''];
    }
    if (normalized.state === 'completed') {
      const time = displayTime(normalized.checkedOutAt, normalized.workTimezone);
      return ['Today’s work', 'Complete', `${time ? `Checked out at ${time}` : 'Workday completed'}${client}`, ''];
    }
    if (normalized.state === 'unmatched') return ['Today’s work', 'Not scheduled', 'No current client placement', ''];
    if (normalized.state === 'not_yet_available') return ['Today’s work', 'Not scheduled', normalized.message || 'Your client placement has not started yet', ''];
    if (normalized.state === 'needs_review') return ['Today’s work', 'Needs review', normalized.message || 'Contact Talent Management', 'warning'];
    if (normalized.state === 'error') return ['Today’s work', 'Unavailable', normalized.message || 'Refresh to check your workday status', 'warning'];
    return ['Today’s work', 'Loading', 'Checking your current placement', ''];
  }

  function dashboardMetric(fallbackMetric, roleValue = actualRole(), statusValue = status) {
    if (normalizedRole(roleValue) !== TALENT_ROLE) return fallbackMetric;
    return metricForStatus(statusValue);
  }

  function abortActiveRequest() {
    activeController?.abort?.();
    activeController = null;
  }

  function reset({ silent = false } = {}) {
    requestVersion += 1;
    abortActiveRequest();
    actionPending = false;
    status = freezeStatus({ state: 'idle', eligible: false });
    if (!silent) dispatchUpdated();
    return status;
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
          ...(payload ? { 'Content-Type': 'application/json' } : {})
        },
        body: payload ? JSON.stringify(payload) : undefined,
        signal: controller?.signal
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('The secure attendance request took too long. Please try again.');
      throw new Error('Soro could not reach the secure attendance service. Check your connection and try again.');
    } finally {
      if (timeout && typeof root?.clearTimeout === 'function') root.clearTimeout(timeout);
      if (activeController === controller) activeController = null;
    }
    const responseText = await response.text();
    let result = {};
    if (responseText) {
      try { result = JSON.parse(responseText); }
      catch { throw new Error(`The secure attendance service returned an unexpected response (${response.status}).`); }
    }
    if (!response.ok) {
      const error = new Error(result.message || result.error || 'Your attendance action could not be completed.');
      error.code = text(result.code);
      error.status = response.status;
      throw error;
    }
    return result;
  }

  async function load() {
    const version = ++requestVersion;
    if (actualRole() !== TALENT_ROLE) return reset();
    actionPending = false;
    setStatus({ state: 'loading', eligible: false });
    try {
      const result = await request('GET');
      if (version !== requestVersion || actualRole() !== TALENT_ROLE) return currentStatus();
      return setStatus(result);
    } catch (error) {
      if (version !== requestVersion || actualRole() !== TALENT_ROLE) return currentStatus();
      return setStatus({ state: 'error', eligible: false, message: error.message });
    }
  }

  function secureRequestId() {
    if (typeof root?.crypto?.randomUUID !== 'function') {
      throw new Error('This browser cannot create a secure attendance request. Refresh in a current browser and try again.');
    }
    return root.crypto.randomUUID();
  }

  async function performAction(action) {
    const requestedAction = text(action).toLowerCase();
    const expected = ACTION_BY_STATE[status.state]?.action;
    if (actualRole() !== TALENT_ROLE || requestedAction !== expected || actionPending) return currentStatus();
    const version = ++requestVersion;
    let requestId;
    try { requestId = secureRequestId(); }
    catch (error) { return setStatus({ state: 'error', eligible: false, message: error.message }); }
    const previousStatus = status;
    actionPending = true;
    dispatchUpdated();
    try {
      const result = await request('POST', { action: requestedAction, requestId });
      if (version !== requestVersion || actualRole() !== TALENT_ROLE) return currentStatus();
      actionPending = false;
      return setStatus(result);
    } catch (error) {
      if (version !== requestVersion || actualRole() !== TALENT_ROLE) return currentStatus();
      actionPending = false;
      status = previousStatus;
      dispatchUpdated();
      if (typeof root?.toast === 'function') root.toast(error.message);
      return status;
    }
  }

  function bindDashboardAction(scope = root?.document) {
    const button = scope?.querySelector?.('[data-talent-workday-action]');
    if (!button || button.dataset.talentWorkdayBound === 'true') return false;
    button.dataset.talentWorkdayBound = 'true';
    button.addEventListener('click', () => performAction(button.dataset.talentWorkdayAction));
    return true;
  }

  function handleAuthChange(event) {
    const detail = event?.detail || event || {};
    reset();
    if (detail.session && normalizedRole(detail.access?.role) === TALENT_ROLE) return load();
    return Promise.resolve(currentStatus());
  }

  root?.addEventListener?.('soro-auth-changed', handleAuthChange);

  return Object.freeze({
    ENDPOINT,
    normalizeStatus,
    actionForStatus,
    actionMarkup,
    metricForStatus,
    dashboardMetric,
    currentStatus,
    load,
    performAction,
    bindDashboardAction,
    handleAuthChange,
    reset
  });
}));
