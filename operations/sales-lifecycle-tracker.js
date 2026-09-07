/* Read-only Sales lifecycle tracker. Actions open the existing workflow. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SoroSalesLifecycleTracker = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const ENDPOINT = '/.netlify/functions/sales-lifecycle-tracker';
  const ROLES = new Set(['admin', 'sales', 'sales_management']);
  const STAGES = Object.freeze({ discovery: 'Setup', matching: 'Matching', client_review: 'Client review', interviewing: 'Interviews', selection: 'Selection', placement: 'Placement', onboarding: 'Onboarding', active: 'Active', on_hold: 'On hold', cancelled: 'Cancelled' });
  const ACTIONS = Object.freeze({ client_setup: 'Open client setup', find_candidates: 'Find candidates', review_shortlist: 'Review shortlist', manage_interviews: 'Manage interviews', review_selection: 'Review selection', prepare_handoff: 'Prepare handoff', view_onboarding: 'View onboarding', view_placement: 'View placement' });
  const ATTENTION = Object.freeze({ owner_missing: 'Assign a Sales owner', contact_missing: 'Add a client contact', portal_access_needed: 'Client portal access needed', portal_delivery_failed: 'Client invitation needs attention', interview_outcome_due: 'Record the interview outcome', calendar_sync_failed: 'Calendar sync needs attention', start_date_passed: 'Target start date has passed' });
  const RESPONSIBILITY = Object.freeze({ sales: 'Sales', client: 'Client', talent_management: 'Talent Management' });
  const RAIL_STAGES = Object.freeze(Object.keys(STAGES).filter(stage => !['on_hold', 'cancelled'].includes(stage)));
  let target = null;
  let role = '';
  let workspace = null;
  let phase = 'loading';
  let message = '';
  let filters = emptyFilters();
  let loader = null;
  let onAction = null;
  let onOpenClient = null;
  let controller = null;
  let generation = 0;
  let preview = false;

  function text(value, max = 180) { return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max); }
  function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])); }
  function canUse(value = root?.soroCurrentAccess?.role) { return ROLES.has(text(value, 40).toLowerCase()); }
  function uuid(value, optional = false) {
    if (optional && !value) return '';
    const candidate = text(value, 64).toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(candidate)) throw new Error('The tracker returned an invalid record.');
    return candidate;
  }
  function date(value, dateOnly = false) {
    if (value === null || value === undefined || value === '') return '';
    const candidate = text(value, 50);
    if (!Number.isFinite(Date.parse(candidate)) || (dateOnly && !/^\d{4}-\d{2}-\d{2}$/.test(candidate))) throw new Error('The tracker returned an invalid date.');
    if (dateOnly && new Date(`${candidate}T12:00:00Z`).toISOString().slice(0, 10) !== candidate) throw new Error('The tracker returned an invalid date.');
    return candidate;
  }
  function count(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('The tracker returned an invalid count.');
    return value;
  }
  function normalizeRow(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('The tracker returned an invalid record.');
    const stage = text(source.stage, 40);
    const nextAction = text(source.nextAction, 40);
    const responsibleRole = text(source.responsibleRole, 40);
    const attentionCode = text(source.attentionCode, 50);
    if (!Object.hasOwn(STAGES, stage) || !Object.hasOwn(ACTIONS, nextAction) || !Object.hasOwn(RESPONSIBILITY, responsibleRole) || (attentionCode && !Object.hasOwn(ATTENTION, attentionCode))) throw new Error('The tracker returned an unknown workflow stage.');
    const clientName = text(source.clientName, 180);
    const roleTitle = text(source.roleTitle, 180);
    if (!clientName || !roleTitle) throw new Error('The tracker returned an incomplete request.');
    return Object.freeze({
      clientId: uuid(source.clientId), clientName, requestId: uuid(source.requestId), roleTitle,
      ownerId: uuid(source.ownerId, true), ownerName: text(source.ownerName, 160),
      status: text(source.status, 40), stage, candidateCount: count(source.candidateCount), interviewCount: count(source.interviewCount),
      placementCount: count(source.placementCount), seatCount: count(source.seatCount), activePlacementCount: count(source.activePlacementCount), onboardingCount: count(source.onboardingCount),
      targetStartDate: date(source.targetStartDate, true), lastActivityAt: date(source.lastActivityAt), nextInterviewAt: date(source.nextInterviewAt),
      attentionCode, nextAction, responsibleRole
    });
  }
  function normalizeWorkspace(payload, expectedRole = role || root?.soroCurrentAccess?.role) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('The tracker response was not available.');
    const viewerRole = text(payload.viewerRole, 40).toLowerCase();
    if (!canUse(viewerRole) || (expectedRole && viewerRole !== text(expectedRole, 40).toLowerCase())) throw new Error('Your tracker access could not be verified.');
    const generatedAt = date(payload.generatedAt);
    if (!generatedAt || !Array.isArray(payload.rows) || payload.rows.length > 5000) throw new Error('The tracker response was incomplete.');
    const rows = payload.rows.map(normalizeRow);
    if (new Set(rows.map(row => row.requestId)).size !== rows.length) throw new Error('The tracker returned duplicate requests.');
    return Object.freeze({ generatedAt, viewerRole, rows: Object.freeze(rows) });
  }
  function emptyFilters() { return { search: '', stage: '', owner: '', attention: false }; }
  function normalizeFilters(value = {}) {
    return { search: text(value.search, 120), stage: Object.hasOwn(STAGES, value.stage) ? value.stage : '', owner: text(value.owner, 64), attention: value.attention === true };
  }
  function visibleRows(data, selected = filters) {
    const query = text(selected.search, 120).toLocaleLowerCase();
    return (data?.rows || []).filter(row =>
      (!query || `${row.clientName} ${row.roleTitle} ${row.ownerName}`.toLocaleLowerCase().includes(query)) &&
      (!selected.stage || row.stage === selected.stage) &&
      (!selected.owner || (selected.owner === 'unassigned' ? !row.ownerId : row.ownerId === selected.owner)) &&
      (!selected.attention || Boolean(row.attentionCode))
    ).slice().sort((a, b) => Boolean(b.attentionCode) - Boolean(a.attentionCode) || (Date.parse(b.lastActivityAt) || 0) - (Date.parse(a.lastActivityAt) || 0) || a.clientName.localeCompare(b.clientName));
  }
  function formatDate(value, withTime = false) {
    if (!value) return 'Not recorded';
    const timestamp = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value;
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', ...(withTime ? { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' } : {}) }).format(new Date(timestamp));
  }
  function statusDetail(row) {
    if (row.attentionCode) return ATTENTION[row.attentionCode];
    if (row.stage === 'active') return `${row.activePlacementCount} of ${row.seatCount} ${row.seatCount === 1 ? 'seat' : 'seats'} active`;
    if (row.stage === 'on_hold') return 'Request is on hold';
    if (row.stage === 'cancelled') return 'Request is cancelled';
    if (row.nextInterviewAt) return `Interview ${formatDate(row.nextInterviewAt, true)}`;
    return { discovery: 'Complete client and role details', matching: 'Build the candidate shortlist', client_review: 'Awaiting client review', interviewing: 'Interview coordination', selection: 'Review the client selection', placement: 'Prepare placement details', onboarding: `${row.onboardingCount} ${row.onboardingCount === 1 ? 'placement' : 'placements'} in onboarding` }[row.stage] || '';
  }
  function rowMarkup(row) {
    const id = escapeHtml(row.requestId);
    return `<article class="sales-tracker-row${row.attentionCode ? ' needs-attention' : ''}" aria-label="${escapeHtml(row.clientName)}: ${escapeHtml(row.roleTitle)}">
      <div class="sales-tracker-client"><button type="button" class="sales-tracker-client-link" data-tracker-client="${id}">${escapeHtml(row.clientName)}</button><p>${escapeHtml(row.roleTitle)}</p><small>${row.seatCount} ${row.seatCount === 1 ? 'seat' : 'seats'} · ${escapeHtml(row.ownerName || (row.ownerId ? 'Assigned Sales owner' : 'Unassigned owner'))}</small></div>
      <div class="sales-tracker-progress"><span class="sales-tracker-stage stage-${escapeHtml(row.stage)}">${escapeHtml(STAGES[row.stage])}</span><p><strong>${row.candidateCount}</strong> ${row.candidateCount === 1 ? 'candidate' : 'candidates'}<span aria-hidden="true"> · </span><strong>${row.interviewCount}</strong> ${row.interviewCount === 1 ? 'interview' : 'interviews'}</p></div>
      <div class="sales-tracker-next"><span class="sales-tracker-field-label">${row.attentionCode ? 'Needs attention' : 'Up next'}</span><p>${escapeHtml(statusDetail(row))}</p><small>${escapeHtml(RESPONSIBILITY[row.responsibleRole])}${row.responsibleRole === 'sales' && row.ownerName ? ` · ${escapeHtml(row.ownerName)}` : ''}</small></div>
      <div class="sales-tracker-dates"><span class="sales-tracker-field-label">Last activity</span><time${row.lastActivityAt ? ` datetime="${escapeHtml(row.lastActivityAt)}" title="${escapeHtml(formatDate(row.lastActivityAt, true))}"` : ''}>${escapeHtml(formatDate(row.lastActivityAt))}</time><small>${row.targetStartDate ? `Target start ${escapeHtml(formatDate(row.targetStartDate))}` : 'No target start set'}</small></div>
      <div class="sales-tracker-row-action"><button type="button" class="sales-tracker-primary" data-tracker-action="${id}" aria-label="${escapeHtml(ACTIONS[row.nextAction])} for ${escapeHtml(row.clientName)}, ${escapeHtml(row.roleTitle)}">${escapeHtml(ACTIONS[row.nextAction])}<span aria-hidden="true"> →</span></button></div>
    </article>`;
  }
  function hasFilters(selected) { return Boolean(selected.search || selected.stage || selected.owner || selected.attention); }
  function resultsHeadingMarkup(data, selected, rows) {
    const filtered = hasFilters(selected);
    return `<p role="status" aria-live="polite"><strong>${rows.length}</strong> ${rows.length === 1 ? 'request' : 'requests'}${filtered ? ` of ${data.rows.length}` : ''}</p><div>${filtered ? '<button type="button" class="sales-tracker-clear" data-tracker-clear>Clear filters</button>' : ''}<small>Updated ${escapeHtml(formatDate(data.generatedAt, true))}</small></div>`;
  }
  function resultsListMarkup(data, selected, rows) {
    if (rows.length) return rows.map(rowMarkup).join('');
    return `<div class="sales-tracker-empty"><strong>${data.rows.length ? 'No requests match these filters' : 'No hiring requests yet'}</strong><p>${data.rows.length ? 'Try another stage, owner or search term.' : data.viewerRole === 'sales' ? 'Requests for your assigned clients will appear here as they are created.' : 'Client hiring requests will appear here as they are created.'}</p>${hasFilters(selected) ? '<button type="button" class="sales-tracker-quiet" data-tracker-clear>Clear filters</button>' : ''}</div>`;
  }
  function workspaceMarkup(data, selected = emptyFilters(), options = {}) {
    const rows = visibleRows(data, selected);
    const owners = [...new Map(data.rows.filter(row => row.ownerId).map(row => [row.ownerId, row.ownerName || 'Assigned Sales owner'])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    const attentionCount = data.rows.filter(row => row.attentionCode).length;
    const counts = Object.fromEntries(Object.keys(STAGES).map(stage => [stage, data.rows.filter(row => row.stage === stage).length]));
    const management = data.viewerRole !== 'sales';
    const rail = [{ key: '', label: 'All requests', total: data.rows.length }, ...RAIL_STAGES.map(stage => ({ key: stage, label: STAGES[stage], total: counts[stage] }))];
    return `<section class="sales-tracker" aria-labelledby="sales-tracker-title">
      <header class="sales-tracker-heading"><div><span class="sales-tracker-eyebrow">${management ? 'Client pipeline' : 'Your client pipeline'}</span><h2 id="sales-tracker-title">Sales lifecycle tracker</h2><p>See where each request stands and take the next step.</p></div><div class="sales-tracker-heading-actions">${options.preview ? '<span class="sales-tracker-sample">Sample data</span>' : ''}<button type="button" class="sales-tracker-quiet" data-tracker-refresh>Refresh</button></div></header>
      <div class="sales-tracker-stage-rail" aria-label="Filter by lifecycle stage">${rail.map(item => `<button type="button" class="sales-tracker-stage-step${selected.stage === item.key ? ' is-selected' : ''}" data-tracker-stage="${item.key}" aria-pressed="${selected.stage === item.key}"><strong>${item.total}</strong><span>${escapeHtml(item.label)}</span></button>`).join('')}</div>
      <div class="sales-tracker-filters">
        <label class="sales-tracker-search"><span>Search requests</span><input id="sales-tracker-search" type="search" value="${escapeHtml(selected.search)}" maxlength="120" placeholder="Client, role or Sales owner" autocomplete="off"></label>
        <label><span>Stage</span><select id="sales-tracker-stage"><option value="">All stages</option>${Object.entries(STAGES).map(([key, label]) => `<option value="${key}"${selected.stage === key ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></label>
        ${management ? `<label><span>Sales owner</span><select id="sales-tracker-owner"><option value="">All owners</option><option value="unassigned"${selected.owner === 'unassigned' ? ' selected' : ''}>Unassigned</option>${owners.map(([id, name]) => `<option value="${escapeHtml(id)}"${selected.owner === id ? ' selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select></label>` : ''}
        <button type="button" class="sales-tracker-attention${selected.attention ? ' is-selected' : ''}" data-tracker-attention aria-pressed="${selected.attention}"><span class="sales-tracker-attention-dot" aria-hidden="true"></span>Needs attention <strong>${attentionCount}</strong></button>
      </div>
      <div class="sales-tracker-results-heading">${resultsHeadingMarkup(data, selected, rows)}</div>
      <div class="sales-tracker-list">${resultsListMarkup(data, selected, rows)}</div>
    </section>`;
  }
  function render() {
    if (!target) return;
    if (phase === 'ready' && workspace) { target.innerHTML = workspaceMarkup(workspace, filters, { preview }); return; }
    const error = phase === 'error';
    target.innerHTML = `<section class="sales-tracker sales-tracker-state" aria-label="Sales lifecycle tracker" aria-busy="${!error}"><span class="sales-tracker-eyebrow">Client pipeline</span><h2>Sales lifecycle tracker</h2><div role="${error ? 'alert' : 'status'}"><strong>${error ? 'Tracker unavailable' : 'Loading your hiring requests…'}</strong><p>${escapeHtml(error ? message : 'Checking the latest client and placement activity.')}</p></div>${error ? '<button type="button" class="sales-tracker-quiet" data-tracker-refresh>Try again</button>' : ''}</section>`;
  }
  function renderResults() {
    const list = target?.querySelector?.('.sales-tracker-list');
    const heading = target?.querySelector?.('.sales-tracker-results-heading');
    if (phase !== 'ready' || !workspace || !list || !heading) { render(); return; }
    const rows = visibleRows(workspace, filters);
    heading.innerHTML = resultsHeadingMarkup(workspace, filters, rows);
    list.innerHTML = resultsListMarkup(workspace, filters, rows);
  }
  async function requestWorkspace(signal) {
    if (loader) return loader({ role, signal });
    const sessionResult = await root?.soroSupabase?.auth?.getSession?.();
    if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    const token = sessionResult?.data?.session?.access_token;
    if (!token || sessionResult?.error) throw new Error('Sign in again to view your client pipeline.');
    const response = await root.fetch(ENDPOINT, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin', signal });
    if (!response.ok) throw new Error(response.status === 401 ? 'Your session has expired. Sign in again to continue.' : response.status === 403 ? 'Your account does not have access to this tracker.' : 'The latest requests could not be loaded. Please try again.');
    return JSON.parse(await response.text());
  }
  async function refresh() {
    if (!target || !canUse(role)) return false;
    const version = ++generation;
    controller?.abort();
    controller = typeof root.AbortController === 'function' ? new root.AbortController() : null;
    const signal = controller?.signal;
    workspace = null;
    phase = 'loading';
    message = '';
    render();
    try {
      const payload = await requestWorkspace(signal);
      if (!target || version !== generation || signal?.aborted) return false;
      workspace = normalizeWorkspace(payload, role);
      phase = 'ready';
      render();
      return true;
    } catch (error) {
      if (!target || version !== generation || error?.name === 'AbortError') return false;
      workspace = null;
      phase = 'error';
      message = error instanceof SyntaxError ? 'The tracker response could not be read. Please try again.' : text(error?.message, 200) || 'The tracker is unavailable. Please try again.';
      render();
      return false;
    }
  }
  function setFilters(next = {}, focusId = '') {
    filters = normalizeFilters({ ...filters, ...next });
    render();
    if (focusId) target?.querySelector?.(`#${focusId}`)?.focus?.({ preventScroll: true });
    return filters;
  }
  function handleClick(event) {
    const button = event.target.closest?.('button');
    if (!button || button.disabled) return;
    const searchInput = target?.querySelector?.('#sales-tracker-search');
    if (searchInput) filters.search = text(searchInput.value, 120);
    if (button.hasAttribute('data-tracker-refresh')) { refresh(); return; }
    if (button.hasAttribute('data-tracker-clear')) { setFilters(emptyFilters(), 'sales-tracker-search'); return; }
    if (button.hasAttribute('data-tracker-stage')) { const stage = button.dataset.trackerStage; setFilters({ stage }); target?.querySelector?.(`[data-tracker-stage="${stage}"]`)?.focus?.({ preventScroll: true }); return; }
    if (button.hasAttribute('data-tracker-attention')) { setFilters({ attention: !filters.attention }); target?.querySelector?.('[data-tracker-attention]')?.focus?.({ preventScroll: true }); return; }
    if (phase !== 'ready') return;
    const id = button.dataset.trackerAction || button.dataset.trackerClient;
    const row = workspace?.rows.find(item => item.requestId === id);
    if (!row) return;
    if (button.dataset.trackerAction) onAction?.(row);
    else if (button.dataset.trackerClient) onOpenClient?.(row);
  }
  function handleInput(event) {
    if (event.target.id !== 'sales-tracker-search') return;
    filters = normalizeFilters({ ...filters, search: event.target.value });
    // Keep the actual input mounted while typing or using its native clear
    // control; replacing it here loses editing state in some browsers.
    renderResults();
  }
  function handleChange(event) {
    if (event.target.id === 'sales-tracker-search') { handleInput(event); return; }
    const fields = { 'sales-tracker-stage': 'stage', 'sales-tracker-owner': 'owner' };
    const field = fields[event.target.id];
    if (field) setFilters({ [field]: event.target.value }, event.target.id);
  }
  function handleAuthChange(event) {
    if (loader) return;
    const nextRole = event?.detail?.access?.role;
    if (!event?.detail?.session || !canUse(nextRole) || nextRole !== role) { unmount(); return; }
    refresh();
  }
  function unmount({ clear = true } = {}) {
    ++generation;
    controller?.abort();
    controller = null;
    if (target) {
      target.removeEventListener('click', handleClick);
      target.removeEventListener('input', handleInput);
      target.removeEventListener('search', handleInput, true);
      target.removeEventListener('change', handleChange);
      if (clear) target.innerHTML = '';
    }
    root?.removeEventListener?.('soro-auth-changed', handleAuthChange);
    target = null;
    workspace = null;
    loader = null;
    onAction = null;
    onOpenClient = null;
    return true;
  }
  function mount(nextTarget, options = {}) {
    const nextRole = text(options.role || root?.soroCurrentAccess?.role, 40).toLowerCase();
    const savedFilters = options.preserveFilters && nextRole === role ? filters : emptyFilters();
    unmount();
    if (!nextTarget || typeof nextTarget.addEventListener !== 'function' || !canUse(nextRole)) return false;
    target = nextTarget;
    role = nextRole;
    filters = savedFilters;
    loader = typeof options.loader === 'function' ? options.loader : null;
    onAction = typeof options.onAction === 'function' ? options.onAction : null;
    onOpenClient = typeof options.onOpenClient === 'function' ? options.onOpenClient : null;
    preview = Boolean(loader && options.preview);
    target.addEventListener('click', handleClick);
    target.addEventListener('input', handleInput);
    target.addEventListener('search', handleInput, true);
    target.addEventListener('change', handleChange);
    root?.addEventListener?.('soro-auth-changed', handleAuthChange);
    refresh();
    return true;
  }
  return Object.freeze({ ENDPOINT, STAGES, ACTIONS, ATTENTION, canUse, normalizeWorkspace, normalizeFilters, visibleRows, rowMarkup, workspaceMarkup, formatDate, setFilters, refresh, mount, unmount });
}));
