/* Live Active Talent Today roster for authenticated Admin and Talent Management. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.soroActiveTalentToday = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const ENDPOINT = '/.netlify/functions/active-talent-today';
  const AUTHORIZED_ROLES = new Set(['admin', 'talent_management']);
  const ATTENDANCE_STATES = new Set(['not_started', 'started', 'completed', 'needs_review']);
  const ACCESS_STATES = new Set([
    'ready', 'not_invited', 'invite_pending', 'suspended',
    'delivery_failed', 'setup_required', 'unlinked'
  ]);
  const ROW_KEYS = Object.freeze([
    'applicantId', 'fullName', 'preferredName', 'placementId', 'clientId',
    'clientName', 'ownerName', 'placementStatus', 'placementStartDate',
    'placementEndDate', 'scheduleSummary', 'workDate', 'workTimezone',
    'attendanceState', 'accessState', 'startedAt', 'checkedOutAt',
    'needsAttention', 'issueCode'
  ]);

  let roster = freezeRoster({ phase: 'idle', generatedAt: '', summary: emptySummary(), rows: [] });
  let filters = Object.freeze({ status: 'all', client: 'all', owner: 'all' });
  let activeController = null;
  let requestVersion = 0;

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

  function canUse(roleValue = actualRole()) {
    return AUTHORIZED_ROLES.has(normalizedRole(roleValue));
  }

  const canLoadForRole = canUse;

  function validUuid(value) {
    const normalized = text(value, 64);
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)
      ? normalized
      : '';
  }

  function validDate(value) {
    const normalized = text(value, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : '';
  }

  function validTimestamp(value) {
    const normalized = text(value, 50);
    return normalized && Number.isFinite(new Date(normalized).getTime()) ? normalized : '';
  }

  function integer(value) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }

  function emptySummary() {
    return Object.freeze({
      activeTalent: 0,
      checkedInToday: 0,
      workingNow: 0,
      completedToday: 0,
      notStarted: 0,
      needsReview: 0
    });
  }

  function freezeSummary(value) {
    const summary = {
      activeTalent: integer(value?.activeTalent),
      checkedInToday: integer(value?.checkedInToday),
      workingNow: integer(value?.workingNow),
      completedToday: integer(value?.completedToday),
      notStarted: integer(value?.notStarted),
      needsReview: integer(value?.needsReview)
    };
    if (Object.values(summary).some(item => item === null)) return null;
    return Object.freeze(summary);
  }

  function freezeRow(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    const attendanceState = text(source.attendanceState || source.attendance_state, 40).toLowerCase();
    const accessState = text(source.accessState || source.access_state, 40).toLowerCase();
    const applicantId = validUuid(source.applicantId || source.applicant_id);
    const fullName = text(source.fullName || source.full_name, 160);
    const workDate = validDate(source.workDate || source.work_date);
    if (!applicantId || !fullName || !workDate || !ATTENDANCE_STATES.has(attendanceState)) return null;
    const row = {
      applicantId,
      fullName,
      preferredName: text(source.preferredName || source.preferred_name, 100),
      placementId: validUuid(source.placementId || source.placement_id),
      clientId: validUuid(source.clientId || source.client_id),
      clientName: text(source.clientName || source.client_name, 160) || 'Client not recorded',
      ownerName: text(source.ownerName || source.owner_name, 120) || 'Unassigned',
      placementStatus: text(source.placementStatus || source.placement_status, 80),
      placementStartDate: validDate(source.placementStartDate || source.placement_start_date),
      placementEndDate: validDate(source.placementEndDate || source.placement_end_date),
      scheduleSummary: text(source.scheduleSummary || source.schedule_summary, 300),
      workDate,
      workTimezone: text(source.workTimezone || source.work_timezone, 100) || 'Asia/Manila',
      attendanceState,
      accessState: ACCESS_STATES.has(accessState) ? accessState : 'unlinked',
      startedAt: validTimestamp(source.startedAt || source.started_at),
      checkedOutAt: validTimestamp(source.checkedOutAt || source.checked_out_at),
      needsAttention: source.needsAttention === true || source.needs_attention === true || attendanceState === 'needs_review',
      issueCode: text(source.issueCode || source.issue_code, 80)
    };
    return Object.freeze(row);
  }

  function freezeRoster(value) {
    return Object.freeze({
      phase: text(value?.phase, 20) || 'error',
      generatedAt: validTimestamp(value?.generatedAt),
      summary: value?.summary || emptySummary(),
      rows: Object.freeze([...(value?.rows || [])]),
      message: text(value?.message, 240)
    });
  }

  function normalizePayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('The Active Talent roster returned an invalid response.');
    }
    const rows = Array.isArray(payload.rows) ? payload.rows.slice(0, 1000).map(freezeRow) : [];
    if (rows.some(row => !row)) throw new Error('The Active Talent roster contained an invalid row.');
    const summary = freezeSummary(payload.summary);
    if (!summary || summary.activeTalent > rows.length) {
      throw new Error('The Active Talent totals did not match the roster.');
    }
    const bounded = ['checkedInToday', 'workingNow', 'completedToday', 'notStarted', 'needsReview']
      .every(key => summary[key] <= rows.length);
    if (!bounded) throw new Error('The Active Talent totals were invalid.');
    const generatedAt = validTimestamp(payload.generatedAt || payload.generated_at);
    if (!generatedAt) throw new Error('The Active Talent roster timestamp was invalid.');
    return freezeRoster({ phase: 'ready', generatedAt, summary, rows });
  }

  function currentRoster() {
    return roster;
  }

  function dispatchUpdated() {
    if (typeof root?.dispatchEvent !== 'function' || typeof root?.CustomEvent !== 'function') return;
    root.dispatchEvent(new root.CustomEvent('soro:active-talent-today-updated', { detail: { roster } }));
  }

  function setRoster(value) {
    roster = value;
    dispatchUpdated();
    renderOpenDialog();
    return roster;
  }

  function abortActiveRequest() {
    activeController?.abort?.();
    activeController = null;
  }

  function reset({ silent = false } = {}) {
    requestVersion += 1;
    abortActiveRequest();
    filters = Object.freeze({ status: 'all', client: 'all', owner: 'all' });
    roster = freezeRoster({ phase: 'idle', generatedAt: '', summary: emptySummary(), rows: [] });
    if (!silent) dispatchUpdated();
    renderOpenDialog();
    return roster;
  }

  async function sessionToken() {
    if (!root?.soroSupabase?.auth?.getSession) throw new Error('Soro sign-in is still loading. Refresh and try again.');
    const { data: { session } = {}, error } = await root.soroSupabase.auth.getSession();
    if (error || !session?.access_token) throw new Error('Your secure session expired. Sign in again and retry.');
    return session.access_token;
  }

  async function requestRoster() {
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
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: controller?.signal
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('The Active Talent roster took too long to load. Please try again.');
      throw new Error('Soro could not reach the Active Talent roster. Check your connection and try again.');
    } finally {
      if (timeout && typeof root?.clearTimeout === 'function') root.clearTimeout(timeout);
      if (activeController === controller) activeController = null;
    }
    const responseText = await response.text();
    let payload = null;
    try { payload = responseText ? JSON.parse(responseText) : null; }
    catch { throw new Error(`The Active Talent service returned an unexpected response (${response.status}).`); }
    if (!response.ok) throw new Error(payload?.message || 'The Active Talent roster could not be loaded.');
    return normalizePayload(payload);
  }

  async function load() {
    const roleValue = actualRole();
    if (!canUse(roleValue)) return reset();
    const version = ++requestVersion;
    roster = freezeRoster({ phase: 'loading', generatedAt: '', summary: emptySummary(), rows: [] });
    dispatchUpdated();
    renderOpenDialog();
    try {
      const nextRoster = await requestRoster();
      if (version !== requestVersion || !canUse()) return currentRoster();
      return setRoster(nextRoster);
    } catch (error) {
      if (version !== requestVersion || !canUse()) return currentRoster();
      return setRoster(freezeRoster({
        phase: 'error', generatedAt: '', summary: emptySummary(), rows: [],
        message: error.message || 'The Active Talent roster could not be loaded.'
      }));
    }
  }

  function dashboardMetric(fallbackMetric, roleValue = actualRole(), rosterValue = roster) {
    if (!canUse(roleValue)) return fallbackMetric;
    if (rosterValue.phase === 'ready') {
      const summary = rosterValue.summary;
      const detail = summary.activeTalent
        ? `${summary.workingNow} working now · ${summary.notStarted} not started${summary.needsReview ? ` · ${summary.needsReview} need review` : ''}`
        : 'No current client placements';
      return ['Active Talent today', String(summary.activeTalent), detail, summary.needsReview ? 'warning' : ''];
    }
    if (rosterValue.phase === 'error') return ['Active Talent today', '—', 'Roster unavailable · select to retry', 'warning'];
    return ['Active Talent today', '—', 'Loading live attendance…', ''];
  }

  function titleCase(value) {
    return text(value, 100).replace(/[_-]+/g, ' ').replace(/\b\w/g, character => character.toUpperCase());
  }

  function displayTime(value, timeZone) {
    if (!value) return '—';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '—';
    try {
      return new Intl.DateTimeFormat(undefined, {
        timeZone: text(timeZone, 100) || undefined,
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
      }).format(date);
    } catch {
      return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    }
  }

  function attendanceLabel(value) {
    return ({
      not_started: 'Not started',
      started: 'Working now',
      completed: 'Complete',
      needs_review: 'Needs review'
    })[value] || 'Needs review';
  }

  function accessLabel(value) {
    return ({
      ready: 'Portal ready',
      not_invited: 'Not invited',
      invite_pending: 'Invite pending',
      suspended: 'Portal suspended',
      delivery_failed: 'Invite delivery failed',
      setup_required: 'Setup required',
      unlinked: 'Portal not linked'
    })[value] || 'Portal not linked';
  }

  function uniqueOptions(key) {
    return [...new Set(roster.rows.map(row => row[key]).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right));
  }

  function filterRows(rows, filterValue = filters) {
    const safeRows = Array.isArray(rows) ? rows : [];
    const safeFilters = filterValue && typeof filterValue === 'object' ? filterValue : {};
    return safeRows.filter(row => (
      (safeFilters.status === 'all' || !safeFilters.status || row.attendanceState === safeFilters.status)
      && (safeFilters.client === 'all' || !safeFilters.client || row.clientName === safeFilters.client)
      && (safeFilters.owner === 'all' || !safeFilters.owner || row.ownerName === safeFilters.owner)
    ));
  }

  function visibleRows() {
    return filterRows(roster.rows, filters);
  }

  function selectOptions(values, selected) {
    return values.map(value => `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(value)}</option>`).join('');
  }

  function summaryMarkup(summary) {
    return `<div class="active-talent-summary" aria-label="Active Talent summary">
      <span><strong>${summary.workingNow}</strong> Working now</span>
      <span><strong>${summary.completedToday}</strong> Complete</span>
      <span><strong>${summary.notStarted}</strong> Not started</span>
      <span${summary.needsReview ? ' class="needs-review"' : ''}><strong>${summary.needsReview}</strong> Need review</span>
    </div>`;
  }

  function rowsMarkup(rows) {
    if (!rows.length) return '<p class="active-talent-empty">No Talent members match these filters.</p>';
    return `<div class="active-talent-table-wrap"><table class="active-talent-table">
      <thead><tr><th>Talent</th><th>Client</th><th>Status</th><th>Start Day</th><th>Check Out</th><th>Owner</th></tr></thead>
      <tbody>${rows.map(row => `<tr${row.needsAttention ? ' class="needs-attention"' : ''}>
        <td><button type="button" class="active-talent-profile" data-active-talent-profile="${escapeHtml(row.applicantId)}">${escapeHtml(row.fullName)}</button><small>${escapeHtml(row.preferredName ? `Goes by ${row.preferredName} · ${accessLabel(row.accessState)}` : accessLabel(row.accessState))}</small></td>
        <td><strong>${escapeHtml(row.clientName)}</strong><small>${escapeHtml(row.scheduleSummary || titleCase(row.placementStatus) || 'Schedule not recorded')}</small></td>
        <td><span class="active-talent-status ${escapeHtml(row.attendanceState)}">${escapeHtml(attendanceLabel(row.attendanceState))}</span>${row.issueCode ? `<small>${escapeHtml(titleCase(row.issueCode))}</small>` : ''}</td>
        <td>${escapeHtml(displayTime(row.startedAt, row.workTimezone))}<small>${escapeHtml(row.workDate)} · ${escapeHtml(row.workTimezone)}</small></td>
        <td>${escapeHtml(displayTime(row.checkedOutAt, row.workTimezone))}</td>
        <td>${escapeHtml(row.ownerName)}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  }

  function dialogBodyMarkup() {
    if (roster.phase === 'loading' || roster.phase === 'idle') {
      return '<div class="active-talent-loading" role="status">Loading the live Active Talent roster…</div>';
    }
    if (roster.phase === 'error') {
      return `<div class="active-talent-error" role="alert"><strong>Roster unavailable</strong><p>${escapeHtml(roster.message)}</p><button type="button" class="button" data-active-talent-refresh>Try again</button></div>`;
    }
    const clients = uniqueOptions('clientName');
    const owners = uniqueOptions('ownerName');
    return `${summaryMarkup(roster.summary)}
      <div class="active-talent-filters">
        <label>Status<select data-active-talent-filter="status"><option value="all">All statuses</option>${['not_started', 'started', 'completed', 'needs_review'].map(value => `<option value="${value}"${value === filters.status ? ' selected' : ''}>${escapeHtml(attendanceLabel(value))}</option>`).join('')}</select></label>
        <label>Client<select data-active-talent-filter="client"><option value="all">All clients</option>${selectOptions(clients, filters.client)}</select></label>
        <label>Talent owner<select data-active-talent-filter="owner"><option value="all">All owners</option>${selectOptions(owners, filters.owner)}</select></label>
        <button type="button" class="button" data-active-talent-refresh>Refresh</button>
      </div>
      <p class="active-talent-caption">Today follows each Talent member’s recorded time zone. Attendance is a presence record, not a productivity or payroll measure.</p>
      ${rowsMarkup(visibleRows())}`;
  }

  function renderOpenDialog() {
    const dialog = root?.document?.getElementById?.('active-talent-today-dialog');
    const target = root?.document?.getElementById?.('active-talent-today-content');
    if (!dialog?.open || !target) return;
    target.innerHTML = dialogBodyMarkup();
  }

  function setFilter(key, value) {
    if (!['status', 'client', 'owner'].includes(key)) return filters;
    let normalized = text(value, 160) || 'all';
    if (key === 'status') normalized = normalized === 'all' || ATTENDANCE_STATES.has(normalized) ? normalized : 'all';
    filters = Object.freeze({ ...filters, [key]: normalized });
    renderOpenDialog();
    return filters;
  }

  function bindDialog() {
    const dialog = root?.document?.getElementById?.('active-talent-today-dialog');
    if (!dialog || dialog.dataset.activeTalentBound === 'true') return Boolean(dialog);
    dialog.dataset.activeTalentBound = 'true';
    dialog.addEventListener('change', event => {
      const control = event.target.closest?.('[data-active-talent-filter]');
      if (control) setFilter(control.dataset.activeTalentFilter, control.value);
    });
    dialog.addEventListener('click', event => {
      const refresh = event.target.closest?.('[data-active-talent-refresh]');
      if (refresh) { event.preventDefault(); load(); return; }
      const profile = event.target.closest?.('[data-active-talent-profile]');
      if (!profile) return;
      event.preventDefault();
      const applicantId = validUuid(profile.dataset.activeTalentProfile);
      if (!applicantId) return;
      dialog.close('profile');
      root.dispatchEvent?.(new root.CustomEvent('soro:active-talent-open-profile', { detail: { applicantId } }));
    });
    return true;
  }

  function openDialog() {
    if (!canUse()) return false;
    const dialog = root?.document?.getElementById?.('active-talent-today-dialog');
    if (!dialog) return false;
    bindDialog();
    const target = root.document.getElementById('active-talent-today-content');
    if (target) target.innerHTML = dialogBodyMarkup();
    if (!dialog.open) dialog.showModal();
    if (roster.phase === 'idle' || roster.phase === 'error') load();
    return true;
  }

  function bindDashboardMetric(scope = root?.document, { currentView = '', actualRole: roleValue = actualRole() } = {}) {
    if (text(currentView, 40).toLowerCase() !== 'overview' || !canUse(roleValue)) return false;
    const metric = [...(scope?.querySelectorAll?.('[data-metric]') || [])]
      .find(button => text(button.querySelector('p')?.textContent, 80).toLowerCase() === 'active talent today');
    if (!metric || metric.dataset.activeTalentBound === 'true') return Boolean(metric);
    metric.dataset.activeTalentBound = 'true';
    metric.setAttribute('aria-label', 'Open Active Talent Today roster');
    metric.addEventListener('click', event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      openDialog();
    });
    return true;
  }

  function handleAuthChange(event) {
    const detail = event?.detail || event || {};
    reset({ silent: true });
    if (detail.session && canUse(detail.access?.role)) return load();
    dispatchUpdated();
    return Promise.resolve(currentRoster());
  }

  root?.addEventListener?.('soro-auth-changed', handleAuthChange);

  return Object.freeze({
    ENDPOINT,
    ROW_KEYS,
    canUse,
    canLoadForRole,
    normalizePayload,
    normalizeRoster: normalizePayload,
    currentRoster,
    dashboardMetric,
    filterRows,
    visibleRows,
    setFilter,
    load,
    reset,
    openDialog,
    bindDashboardMetric,
    handleAuthChange
  });
}));
