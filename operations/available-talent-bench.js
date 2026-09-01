/* Available Talent Bench and Sales Claim Queue. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.soroAvailableTalentBench = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const ENDPOINT = '/.netlify/functions/available-talent-bench';
  const AUTHORIZED_ROLES = new Set(['admin', 'talent_management', 'sales', 'sales_management']);
  const SALES_ROLES = new Set(['sales']);
  const VIEW_ONLY_ROLES = new Set(['sales_management']);
  const MANAGEMENT_ROLES = new Set(['admin', 'talent_management']);
  const ACTIONS = new Set(['claim', 'assign', 'reassign', 'release']);
  const STAGES = new Set(['bench_ready', 'shortlisted', 'interviewing', 'client_review']);
  const DEFAULT_CAPACITY = 40;

  let mountedRoot = null;
  let viewerRole = '';
  let queue = emptyQueue();
  let filters = emptyFilters();
  let activeController = null;
  let requestVersion = 0;
  let assignmentContext = null;
  let limitContext = false;
  let pendingApplicantId = '';
  let feedback = Object.freeze({ type: '', message: '' });

  function text(value, max = 200) {
    return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    }[character]));
  }

  function normalizedRole(value) { return text(value, 50).toLowerCase(); }

  function actualRole(access = root?.soroCurrentAccess) {
    return normalizedRole(access?.role);
  }

  function effectiveRole() {
    return normalizedRole(viewerRole || actualRole());
  }

  function canOpenForRole(value = effectiveRole()) {
    return AUTHORIZED_ROLES.has(normalizedRole(value));
  }

  function validUuid(value, { optional = false } = {}) {
    const normalized = text(value, 64).toLowerCase();
    if (optional && !normalized) return '';
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
      ? normalized
      : '';
  }

  function validTimestamp(value, { optional = false } = {}) {
    const normalized = text(value, 50);
    if (optional && !normalized) return '';
    return normalized && Number.isFinite(Date.parse(normalized)) ? normalized : '';
  }

  function nonNegativeNumber(value, fallback = null) {
    if (value === null || typeof value === 'undefined' || value === '') return fallback;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  }

  function nonNegativeInteger(value, fallback = null) {
    const number = nonNegativeNumber(value, fallback);
    return Number.isSafeInteger(number) ? number : fallback;
  }

  function normalizedList(value, { maxItems = 60, maxLength = 100 } = {}) {
    if (!Array.isArray(value)) return Object.freeze([]);
    const seen = new Set();
    const result = [];
    value.slice(0, maxItems).forEach(item => {
      const label = text(typeof item === 'string' ? item : item?.name || item?.label, maxLength);
      const key = label.toLocaleLowerCase();
      if (label && !seen.has(key)) { seen.add(key); result.push(label); }
    });
    return Object.freeze(result);
  }

  function normalizeOwner(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      return Object.freeze({ id: '', name: 'Unassigned', isCurrentUser: false });
    }
    const id = validUuid(source.id || source.userId || source.employeeId, { optional: true });
    return Object.freeze({
      id,
      name: id ? text(source.name || source.fullName, 120) || 'Assigned Sales owner' : 'Unassigned',
      isCurrentUser: Boolean(source.isCurrentUser || source.isViewer)
    });
  }

  function normalizeAllowedActions(source) {
    if (!Array.isArray(source) || source.length > ACTIONS.size) return null;
    const actions = source.map(action => text(action, 24).toLowerCase()).filter(action => ACTIONS.has(action));
    if (actions.length !== source.length || new Set(actions).size !== actions.length) return null;
    return Object.freeze(actions);
  }

  function normalizeTalent(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    const applicantId = validUuid(source.applicantId || source.id);
    const fullName = text(source.fullName || source.displayName || source.name, 160);
    if (!applicantId || !fullName) return null;
    const owner = normalizeOwner(source.owner || source.salesOwner);
    if (!owner) return null;
    const stage = text(source.stage, 40).toLowerCase();
    if (!STAGES.has(stage)) return null;
    const minimum = nonNegativeNumber(source.rateMinimum ?? source.rateMin ?? source.expectedRateMinimum, null);
    const maximum = nonNegativeNumber(source.rateMaximum ?? source.rateMax ?? source.expectedRateMaximum, minimum);
    const updatedAt = validTimestamp(source.updatedAt);
    if (!updatedAt) return null;
    const allowedActions = normalizeAllowedActions(source.allowedActions);
    if (!allowedActions) return null;
    return Object.freeze({
      applicantId,
      fullName,
      preferredName: text(source.preferredName, 100),
      vaTypes: normalizedList(source.vaTypes || source.workAreas || source.skillTypes, { maxItems: 20 }),
      verifiedSkills: normalizedList(source.verifiedSkills, { maxItems: 80 }),
      availability: text(source.availability || source.availabilityLabel || source.availabilityNote, 120) || 'Availability not recorded',
      rateMinimum: minimum,
      rateMaximum: maximum,
      rateLabel: text(source.rateLabel || source.expectedRateLabel || source.expectedHourlyRateText, 100),
      experienceLabel: text(source.experienceLabel || source.yearsExperienceLabel || (source.yearsExperience !== null && typeof source.yearsExperience !== 'undefined' ? `${source.yearsExperience} years` : ''), 100),
      stage,
      owner,
      updatedAt,
      allowedActions
    });
  }

  function normalizeSalesOwner(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    const id = validUuid(source.id || source.userId || source.employeeId);
    const name = text(source.name || source.fullName, 120);
    if (!id || !name) return null;
    return Object.freeze({
      id,
      name,
      claimed: nonNegativeInteger(source.claimed ?? source.caseload, 0),
      capacity: nonNegativeInteger(source.capacity ?? source.limit, DEFAULT_CAPACITY),
      available: source.available !== false
    });
  }

  function normalizeCaseload(source) {
    const value = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
    const claimed = nonNegativeInteger(value.claimed ?? value.assigned ?? value.current, 0);
    const capacity = Math.max(1, nonNegativeInteger(value.capacity ?? value.limit ?? value.maximum, DEFAULT_CAPACITY));
    return Object.freeze({
      ownerId: validUuid(value.ownerId, { optional: true }),
      claimed,
      capacity,
      remaining: Math.max(0, nonNegativeInteger(value.remaining, capacity - claimed))
    });
  }

  function normalizeFilterOptions(source, items) {
    const value = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
    const derived = selector => {
      const labels = new Map();
      items.forEach(item => selector(item).forEach(label => labels.set(label.toLocaleLowerCase(), label)));
      return [...labels.values()].sort((a, b) => a.localeCompare(b));
    };
    return Object.freeze({
      vaTypes: normalizedList(value.vaTypes, { maxItems: 250 }).length ? normalizedList(value.vaTypes, { maxItems: 250 }) : Object.freeze(derived(item => item.vaTypes)),
      verifiedSkills: normalizedList(value.verifiedSkills, { maxItems: 500 }).length ? normalizedList(value.verifiedSkills, { maxItems: 500 }) : Object.freeze(derived(item => item.verifiedSkills)),
      availabilityOptions: normalizedList(value.availabilityOptions, { maxItems: 100 }).length ? normalizedList(value.availabilityOptions, { maxItems: 100 }) : Object.freeze(derived(item => [item.availability]))
    });
  }

  function normalizePayload(payload, expectedRole = actualRole()) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('The Available Talent service returned an invalid response.');
    }
    const role = normalizedRole(payload.viewerRole || payload.viewer || expectedRole);
    const expected = normalizedRole(expectedRole);
    if (!canOpenForRole(role) || (expected && role !== expected)) throw new Error('Available Talent access could not be verified.');
    const generatedAt = validTimestamp(payload.generatedAt);
    if (!generatedAt) throw new Error('The Available Talent queue did not include a valid update time.');
    const sourceItems = payload.items || payload.talent || payload.applicants;
    if (!Array.isArray(sourceItems) || sourceItems.length > 1500) {
      throw new Error('The Available Talent service returned an invalid queue.');
    }
    const items = sourceItems.map(normalizeTalent);
    if (items.some(item => !item) || new Set(items.map(item => item.applicantId)).size !== items.length) {
      throw new Error('The Available Talent queue contained an invalid Talent record.');
    }
    const ownersSource = payload.salesOwners || payload.salesUsers || payload.owners || [];
    if (!Array.isArray(ownersSource) || ownersSource.length > 250) throw new Error('The Sales owner list was invalid.');
    const salesOwners = ownersSource.map(normalizeSalesOwner);
    if (salesOwners.some(owner => !owner)) throw new Error('The Sales owner list was invalid.');
    const caseload = normalizeCaseload(payload.caseload || payload.viewerCaseload);
    const normalizedItems = items.map(item => item.owner.id && item.owner.id === caseload.ownerId
      ? Object.freeze({ ...item, owner: Object.freeze({ ...item.owner, isCurrentUser: true }) })
      : item);
    return Object.freeze({
      phase: 'ready',
      generatedAt,
      viewerRole: role,
      caseload,
      items: Object.freeze(normalizedItems),
      salesOwners: Object.freeze(salesOwners),
      filterOptions: normalizeFilterOptions(payload.filters, normalizedItems),
      message: ''
    });
  }

  function emptyQueue() {
    return Object.freeze({
      phase: 'idle', generatedAt: '', viewerRole: '', caseload: normalizeCaseload(),
      items: Object.freeze([]), salesOwners: Object.freeze([]),
      filterOptions: Object.freeze({ vaTypes: Object.freeze([]), verifiedSkills: Object.freeze([]), availabilityOptions: Object.freeze([]) }),
      message: ''
    });
  }

  function emptyFilters() {
    return Object.freeze({ search: '', vaType: 'all', verifiedSkill: 'all', availability: 'all', rateMin: '', rateMax: '' });
  }

  function normalizeFilters(source = {}) {
    const rateMin = source.rateMin === '' ? '' : nonNegativeNumber(source.rateMin, '');
    const rateMax = source.rateMax === '' ? '' : nonNegativeNumber(source.rateMax, '');
    return Object.freeze({
      search: text(source.search, 120),
      vaType: text(source.vaType, 100) || 'all',
      verifiedSkill: text(source.verifiedSkill, 100) || 'all',
      availability: text(source.availability, 120) || 'all',
      rateMin,
      rateMax
    });
  }

  function sessionToken() {
    if (!root?.soroSupabase?.auth?.getSession) return Promise.reject(new Error('Soro sign-in is still loading. Refresh and try again.'));
    return root.soroSupabase.auth.getSession().then(({ data: { session } = {}, error }) => {
      if (error || !session?.access_token) throw new Error('Your secure session expired. Sign in again and retry.');
      return session.access_token;
    });
  }

  function abortRequest() {
    activeController?.abort?.();
    activeController = null;
  }

  async function requestQueue({ body = null } = {}) {
    const token = await sessionToken();
    const controller = typeof root?.AbortController === 'function' ? new root.AbortController() : null;
    abortRequest();
    activeController = controller;
    const timeout = controller && typeof root?.setTimeout === 'function' ? root.setTimeout(() => controller.abort(), 25000) : null;
    let response;
    try {
      response = await root.fetch(ENDPOINT, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        signal: controller?.signal
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('The Available Talent request took too long. Please try again.');
      throw new Error('Soro could not reach the Available Talent service. Check your connection and try again.');
    } finally {
      if (timeout && typeof root?.clearTimeout === 'function') root.clearTimeout(timeout);
      if (activeController === controller) activeController = null;
    }
    const responseText = await response.text();
    let payload = null;
    try { payload = responseText ? JSON.parse(responseText) : null; }
    catch { throw new Error(`The Available Talent service returned an unexpected response (${response.status}).`); }
    if (!response.ok) {
      const error = new Error(text(payload?.message, 280) || 'The Available Talent request could not be completed.');
      error.status = response.status;
      throw error;
    }
    return normalizePayload(payload);
  }

  function requestId() {
    if (root?.crypto?.randomUUID) return root.crypto.randomUUID();
    return '00000000-0000-4000-8000-000000000000';
  }

  async function refresh({ silent = false, preserveFeedback = false } = {}) {
    if (!canOpenForRole()) return false;
    const version = ++requestVersion;
    if (!silent) {
      queue = Object.freeze({ ...queue, phase: 'loading', message: '' });
      render();
    }
    try {
      const nextQueue = await requestQueue();
      if (version !== requestVersion || !mountedRoot) return false;
      queue = nextQueue;
      if (!preserveFeedback) feedback = Object.freeze({ type: '', message: '' });
      render();
      return true;
    } catch (error) {
      if (version !== requestVersion || !mountedRoot) return false;
      if (silent && queue.phase === 'ready') {
        feedback = Object.freeze({ type: 'error', message: error.message || 'The queue could not be refreshed.' });
      } else {
        queue = Object.freeze({ ...emptyQueue(), phase: 'error', message: error.message || 'The queue could not be loaded.' });
      }
      render();
      return false;
    }
  }

  function formatRate(item) {
    if (item.rateLabel) return item.rateLabel;
    if (item.rateMinimum === null) return 'Rate not recorded';
    if (item.rateMaximum !== null && item.rateMaximum !== item.rateMinimum) return `$${item.rateMinimum}–$${item.rateMaximum} USD/hr`;
    return `$${item.rateMinimum} USD/hr`;
  }

  function initials(name) {
    return text(name, 160).split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || 'VA';
  }

  function stageLabel(value) {
    return ({ bench_ready: 'Available', shortlisted: 'Shortlisted', interviewing: 'Interviewing', client_review: 'Client review' })[text(value, 40).toLowerCase()] || 'Available';
  }

  function optionValues(selector) {
    const values = new Map();
    queue.items.forEach(item => selector(item).forEach(value => values.set(value.toLocaleLowerCase(), value)));
    return [...values.values()].sort((a, b) => a.localeCompare(b));
  }

  function availabilityValues() {
    const values = new Map();
    queue.items.forEach(item => values.set(item.availability.toLocaleLowerCase(), item.availability));
    return [...values.values()].sort((a, b) => a.localeCompare(b));
  }

  function visibleItems(queueValue = queue, filterValue = filters) {
    const query = filterValue.search.toLocaleLowerCase();
    return queueValue.items.filter(item => {
      const searchable = [item.fullName, item.preferredName, ...item.vaTypes, ...item.verifiedSkills].join(' ').toLocaleLowerCase();
      if (query && !searchable.includes(query)) return false;
      if (filterValue.vaType !== 'all' && !item.vaTypes.some(value => value === filterValue.vaType)) return false;
      if (filterValue.verifiedSkill !== 'all' && !item.verifiedSkills.some(value => value === filterValue.verifiedSkill)) return false;
      if (filterValue.availability !== 'all' && item.availability !== filterValue.availability) return false;
      if (filterValue.rateMin !== '' && (item.rateMaximum === null || item.rateMaximum < Number(filterValue.rateMin))) return false;
      if (filterValue.rateMax !== '' && (item.rateMinimum === null || item.rateMinimum > Number(filterValue.rateMax))) return false;
      return true;
    });
  }

  function selectMarkup(id, label, values, currentValue, allLabel) {
    return `<label for="${id}"><span>${escapeHtml(label)}</span><select id="${id}"><option value="all">${escapeHtml(allLabel)}</option>${values.map(value => `<option value="${escapeHtml(value)}"${currentValue === value ? ' selected' : ''}>${escapeHtml(value)}</option>`).join('')}</select></label>`;
  }

  function capacityMarkup() {
    const { claimed, capacity, remaining } = queue.caseload;
    const percent = Math.min(100, Math.round((claimed / capacity) * 100));
    const salesView = SALES_ROLES.has(effectiveRole());
    return `<section class="bench-capacity" aria-label="${salesView ? 'Your' : 'Current'} Sales caseload: ${claimed} of ${capacity}">
      <div><p>${salesView ? 'My Sales caseload' : 'Sales caseload'}</p><strong>${claimed} <span>of ${capacity}</span></strong><small>${remaining ? `${remaining} claim${remaining === 1 ? '' : 's'} available` : 'At capacity'}</small>${effectiveRole() === 'admin' ? '<button type="button" class="text-button bench-manage-limits" data-bench-manage-limits>Manage limits</button>' : ''}</div>
      <div class="bench-capacity-track" role="progressbar" aria-valuemin="0" aria-valuemax="${capacity}" aria-valuenow="${claimed}"><span style="width:${percent}%"></span></div>
    </section>`;
  }

  function chipsMarkup(values, className) {
    if (!values.length) return '<span class="bench-empty-value">None recorded</span>';
    const visible = values.slice(0, 3);
    return `${visible.map(value => `<span class="bench-chip ${className}">${escapeHtml(value)}</span>`).join('')}${values.length > 3 ? `<span class="bench-chip bench-chip-more" title="${escapeHtml(values.slice(3).join(', '))}">+${values.length - 3}</span>` : ''}`;
  }

  function actionAllowed(item, action) {
    return item.allowedActions.includes(action) && (action !== 'claim' || queue.caseload.remaining > 0);
  }

  function actionsMarkup(item) {
    const pending = pendingApplicantId === item.applicantId;
    if (VIEW_ONLY_ROLES.has(effectiveRole())) return '<span class="bench-owned-label">View only</span>';
    if (SALES_ROLES.has(effectiveRole())) {
      if (item.owner.isCurrentUser || actionAllowed(item, 'release')) return `<span class="bench-owned-label">In my caseload</span>${actionAllowed(item, 'release') ? `<button type="button" class="text-button bench-release" data-bench-action="release" data-applicant-id="${item.applicantId}"${pending ? ' disabled' : ''}>Release</button>` : ''}`;
      if (item.owner.id) return '<span class="bench-owned-label">Claimed</span>';
      return actionAllowed(item, 'claim')
        ? `<button type="button" class="button primary bench-claim" data-bench-action="claim" data-applicant-id="${item.applicantId}"${pending ? ' disabled' : ''}>${pending ? 'Claiming…' : 'Claim Talent'}</button>`
        : '<span class="bench-owned-label">Not claimable</span>';
    }
    if (!item.allowedActions.length) return '<span class="bench-owned-label">No ownership action</span>';
    const assignmentAction = item.owner.id ? 'reassign' : 'assign';
    return `<button type="button" class="button" data-bench-action="${assignmentAction}" data-applicant-id="${item.applicantId}"${pending || !actionAllowed(item, assignmentAction) ? ' disabled' : ''}>${item.owner.id ? 'Reassign' : 'Assign'}</button>${item.owner.id ? `<button type="button" class="text-button bench-release" data-bench-action="release" data-applicant-id="${item.applicantId}"${pending || !actionAllowed(item, 'release') ? ' disabled' : ''}>Release</button>` : ''}`;
  }

  function cardMarkup(item) {
    return `<article class="bench-talent-card" data-applicant-id="${item.applicantId}" data-bench-stage="${escapeHtml(item.stage)}">
      <div class="bench-person"><span class="bench-avatar" aria-hidden="true">${escapeHtml(initials(item.fullName))}</span><div><button type="button" class="bench-profile-link" data-bench-profile="${item.applicantId}">${escapeHtml(item.fullName)}</button><small>${item.preferredName ? `Goes by ${escapeHtml(item.preferredName)} · ` : ''}${escapeHtml(stageLabel(item.stage))}</small></div></div>
      <div class="bench-card-section"><small>VA types</small><div class="bench-chips">${chipsMarkup(item.vaTypes, 'bench-chip-type')}</div></div>
      <div class="bench-card-section"><small>Verified skills</small><div class="bench-chips">${chipsMarkup(item.verifiedSkills, 'bench-chip-skill')}</div></div>
      <div class="bench-card-facts"><span><small>Availability</small><strong>${escapeHtml(item.availability)}</strong></span><span><small>Expected rate</small><strong>${escapeHtml(formatRate(item))}</strong></span><span><small>Sales owner</small><strong>${escapeHtml(item.owner.name)}</strong></span></div>
      <div class="bench-card-actions">${actionsMarkup(item)}</div>
    </article>`;
  }

  function queueMarkup() {
    const items = visibleItems();
    if (!items.length) {
      return `<div class="bench-empty" role="status"><strong>No matching Talent</strong><p>${queue.items.length ? 'Clear or change a filter to see more Bench Ready Talent.' : 'No Bench Ready Talent are available right now.'}</p>${queue.items.length ? '<button type="button" class="button" data-bench-clear>Clear filters</button>' : ''}</div>`;
    }
    return `<div class="bench-results-heading"><p><strong>${items.length}</strong> of ${queue.items.length} available</p><small>Open a name to review the existing Talent profile.</small></div><div class="bench-list">${items.map(cardMarkup).join('')}</div>`;
  }

  function assignmentDialogMarkup() {
    if (!assignmentContext) return '';
    const item = queue.items.find(candidate => candidate.applicantId === assignmentContext.applicantId);
    if (!item) return '';
    const currentId = item.owner.id;
    return `<dialog class="bench-assignment-dialog" data-bench-dialog>
      <form method="dialog" data-bench-assignment-form>
        <header><div><p class="eyebrow">Sales ownership</p><h2>${currentId ? 'Reassign Talent' : 'Assign Talent'}</h2></div><button type="button" data-bench-dialog-close aria-label="Close">×</button></header>
        <p>Choose the Sales owner responsible for ${escapeHtml(item.fullName)}. Their active caseload is shown beside their name.</p>
        <label for="bench-sales-owner">Sales owner<select id="bench-sales-owner" name="salesOwnerId" required><option value="">Select an active Sales employee</option>${queue.salesOwners.map(owner => `<option value="${owner.id}"${currentId === owner.id ? ' selected' : ''}${(!owner.available || owner.claimed >= owner.capacity) && currentId !== owner.id ? ' disabled' : ''}>${escapeHtml(owner.name)} · ${owner.claimed}/${owner.capacity}</option>`).join('')}</select></label>
        ${queue.salesOwners.length ? '' : '<p class="bench-dialog-message is-error">No active Sales employee accounts are available for assignment.</p>'}
        <p class="bench-dialog-message" aria-live="polite"></p>
        <footer><button type="button" class="button" data-bench-dialog-close>Cancel</button><button type="submit" class="button primary"${queue.salesOwners.length ? '' : ' disabled'}>${currentId ? 'Save reassignment' : 'Assign Talent'}</button></footer>
      </form>
    </dialog>`;
  }

  function limitDialogMarkup() {
    if (!limitContext || effectiveRole() !== 'admin') return '';
    const firstOwner = queue.salesOwners[0] || null;
    return `<dialog class="bench-assignment-dialog bench-limit-dialog" data-bench-limit-dialog>
      <form method="dialog" data-bench-limit-form>
        <header><div><p class="eyebrow">Admin setting</p><h2>Sales caseload limits</h2></div><button type="button" data-bench-limit-close aria-label="Close">×</button></header>
        <p>Set the maximum number of active Talent claims for each Sales employee. New Sales accounts begin at ${DEFAULT_CAPACITY}.</p>
        <label for="bench-limit-owner">Sales employee<select id="bench-limit-owner" name="salesOwnerId" required><option value="">Select an active Sales employee</option>${queue.salesOwners.map(owner => `<option value="${owner.id}" data-capacity="${owner.capacity}">${escapeHtml(owner.name)} · ${owner.claimed}/${owner.capacity}</option>`).join('')}</select></label>
        <label for="bench-caseload-limit">Maximum active claims<input id="bench-caseload-limit" name="caseloadLimit" type="number" min="1" max="500" step="1" inputmode="numeric" value="${firstOwner ? firstOwner.capacity : DEFAULT_CAPACITY}" required></label>
        ${queue.salesOwners.length ? '' : '<p class="bench-dialog-message is-error">No active Sales employee accounts are available.</p>'}
        <p class="bench-dialog-message" aria-live="polite"></p>
        <footer><button type="button" class="button" data-bench-limit-close>Cancel</button><button type="submit" class="button primary"${queue.salesOwners.length ? '' : ' disabled'}>Save limit</button></footer>
      </form>
    </dialog>`;
  }

  function readyMarkup() {
    return `<main class="page available-talent-page">
      <div class="page-heading available-talent-heading"><div><p class="eyebrow">Sales matching</p><h1>Available Talent Bench</h1><p>Find Bench Ready Talent, compare verified skills, and manage Sales ownership without exposing private application details.</p></div><button type="button" class="button" data-bench-refresh>Refresh</button></div>
      ${feedback.message ? `<div class="bench-feedback${feedback.type === 'error' ? ' is-error' : ''}" role="status">${escapeHtml(feedback.message)}</div>` : ''}
      ${capacityMarkup()}
      <section class="panel bench-workspace">
        <div class="bench-filter-heading"><div><h2>Find Talent</h2><p>Use any combination of filters.</p></div><button type="button" class="text-button" data-bench-clear>Clear all</button></div>
        <div class="bench-filters">
          <label class="bench-search" for="bench-search"><span>Search</span><input id="bench-search" type="search" maxlength="120" autocomplete="off" value="${escapeHtml(filters.search)}" placeholder="Name, VA type, or verified skill"></label>
          ${selectMarkup('bench-va-type', 'VA type', queue.filterOptions.vaTypes.length ? queue.filterOptions.vaTypes : optionValues(item => item.vaTypes), filters.vaType, 'All VA types')}
          ${selectMarkup('bench-verified-skill', 'Verified skill', queue.filterOptions.verifiedSkills.length ? queue.filterOptions.verifiedSkills : optionValues(item => item.verifiedSkills), filters.verifiedSkill, 'All verified skills')}
          ${selectMarkup('bench-availability', 'Availability', queue.filterOptions.availabilityOptions.length ? queue.filterOptions.availabilityOptions : availabilityValues(), filters.availability, 'Any availability')}
          <label for="bench-rate-min"><span>Minimum rate</span><div class="bench-rate-input"><span>$</span><input id="bench-rate-min" type="number" min="0" max="999" step="0.01" inputmode="decimal" value="${escapeHtml(filters.rateMin)}" placeholder="Any"><small>/hr</small></div></label>
          <label for="bench-rate-max"><span>Maximum rate</span><div class="bench-rate-input"><span>$</span><input id="bench-rate-max" type="number" min="0" max="999" step="0.01" inputmode="decimal" value="${escapeHtml(filters.rateMax)}" placeholder="Any"><small>/hr</small></div></label>
        </div>
        ${queueMarkup()}
      </section>
      ${assignmentDialogMarkup()}
      ${limitDialogMarkup()}
    </main>`;
  }

  function pageMarkup() {
    if (queue.phase === 'loading' || queue.phase === 'idle') return `<main class="page available-talent-page"><div class="page-heading"><div><p class="eyebrow">Sales matching</p><h1>Available Talent Bench</h1></div></div><section class="panel bench-loading" role="status"><span aria-hidden="true"></span><strong>Loading Bench Ready Talent…</strong><p>Checking availability, verified skills, and Sales ownership.</p></section></main>`;
    if (queue.phase === 'error') return `<main class="page available-talent-page"><div class="page-heading"><div><p class="eyebrow">Sales matching</p><h1>Available Talent Bench</h1></div></div><section class="panel bench-error" role="alert"><strong>Available Talent is temporarily unavailable</strong><p>${escapeHtml(queue.message)}</p><button type="button" class="button" data-bench-refresh>Try again</button></section></main>`;
    return readyMarkup();
  }

  function render() {
    if (!mountedRoot) return false;
    mountedRoot.innerHTML = pageMarkup();
    const dialog = mountedRoot.querySelector?.('[data-bench-dialog], [data-bench-limit-dialog]');
    if (dialog) {
      dialog.addEventListener?.('cancel', event => { event.preventDefault(); dialog.matches?.('[data-bench-limit-dialog]') ? closeLimits() : closeAssignment(); }, { once: true });
      if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
    }
    return true;
  }

  function restoreFilterFocus(id, value) {
    render();
    const input = mountedRoot?.querySelector?.(`#${id}`);
    input?.focus?.();
    if (input?.setSelectionRange && typeof value === 'string') input.setSelectionRange(value.length, value.length);
  }

  function setFilters(next) {
    filters = normalizeFilters({ ...filters, ...next });
    render();
    return filters;
  }

  function openProfile(applicantId) {
    const id = validUuid(applicantId);
    if (!id) return false;
    if (typeof root?.soroOpenTalentProfile === 'function') { root.soroOpenTalentProfile(id); return true; }
    if (typeof root?.CustomEvent === 'function') root.dispatchEvent?.(new root.CustomEvent('soro:available-talent-open-profile', { detail: { applicantId: id } }));
    return true;
  }

  function openAssignment(applicantId) {
    const id = validUuid(applicantId);
    if (!id || !MANAGEMENT_ROLES.has(effectiveRole())) return false;
    const item = queue.items.find(candidate => candidate.applicantId === id);
    if (!item) return false;
    assignmentContext = Object.freeze({ applicantId: id });
    render();
    return true;
  }

  function closeAssignment() {
    assignmentContext = null;
    render();
    return true;
  }

  function openLimits() {
    if (effectiveRole() !== 'admin') return false;
    limitContext = true;
    render();
    return true;
  }

  function closeLimits() {
    limitContext = false;
    render();
    return true;
  }

  async function changeLimit(salesOwnerId, caseloadLimit) {
    if (effectiveRole() !== 'admin') return false;
    const ownerId = validUuid(salesOwnerId);
    const limit = nonNegativeInteger(caseloadLimit, null);
    if (!ownerId || limit === null || limit < 1 || limit > 500) return false;
    feedback = Object.freeze({ type: '', message: '' });
    try {
      queue = await requestQueue({ body: { requestId: requestId(), action: 'set_limit', salesOwnerId: ownerId, caseloadLimit: limit } });
      limitContext = false;
      const owner = queue.salesOwners.find(candidate => candidate.id === ownerId);
      feedback = Object.freeze({ type: 'success', message: `${owner?.name || 'The Sales employee'} now has a caseload limit of ${limit}.` });
      return true;
    } catch (error) {
      feedback = Object.freeze({ type: 'error', message: error.message || 'The Sales caseload limit could not be updated.' });
      return false;
    } finally { render(); }
  }

  async function changeOwnership(action, applicantId, salesOwnerId = '') {
    const normalizedAction = text(action, 24).toLowerCase();
    const id = validUuid(applicantId);
    const item = queue.items.find(candidate => candidate.applicantId === id);
    if (!item || !ACTIONS.has(normalizedAction) || !actionAllowed(item, normalizedAction)) return false;
    const ownerId = validUuid(salesOwnerId, { optional: normalizedAction === 'claim' || normalizedAction === 'release' });
    if (['assign', 'reassign'].includes(normalizedAction) && !ownerId) return false;
    pendingApplicantId = id;
    feedback = Object.freeze({ type: '', message: '' });
    render();
    try {
      const body = {
        requestId: requestId(),
        action: normalizedAction,
        applicantId: id,
        expectedUpdatedAt: item.updatedAt
      };
      if (['assign', 'reassign'].includes(normalizedAction)) body.salesOwnerId = ownerId;
      const nextQueue = await requestQueue({ body });
      queue = nextQueue;
      filters = normalizeFilters(filters);
      assignmentContext = null;
      feedback = Object.freeze({ type: 'success', message: normalizedAction === 'claim' ? `${item.fullName} was added to your Sales caseload.` : normalizedAction === 'release' ? `${item.fullName} is available for Sales to claim again.` : `${item.fullName}’s Sales owner was updated.` });
      if (typeof root?.CustomEvent === 'function') root.dispatchEvent?.(new root.CustomEvent('soro:available-talent-updated', { detail: { action: normalizedAction, applicantId: id } }));
      return true;
    } catch (error) {
      assignmentContext = null;
      feedback = Object.freeze({ type: 'error', message: error.message || 'Sales ownership could not be updated.' });
      if (error?.status === 409) await refresh({ silent: true, preserveFeedback: true });
      return false;
    } finally {
      pendingApplicantId = '';
      render();
    }
  }

  function handleClick(event) {
    const profile = event.target.closest?.('[data-bench-profile]');
    if (profile) { openProfile(profile.dataset.benchProfile); return; }
    if (event.target.closest?.('[data-bench-refresh]')) { refresh(); return; }
    if (event.target.closest?.('[data-bench-clear]')) { filters = emptyFilters(); render(); return; }
    if (event.target.closest?.('[data-bench-dialog-close]')) { closeAssignment(); return; }
    if (event.target.closest?.('[data-bench-manage-limits]')) { openLimits(); return; }
    if (event.target.closest?.('[data-bench-limit-close]')) { closeLimits(); return; }
    const actionButton = event.target.closest?.('[data-bench-action]');
    if (!actionButton || actionButton.disabled) return;
    const { benchAction: action, applicantId } = actionButton.dataset;
    if (['assign', 'reassign'].includes(action)) openAssignment(applicantId);
    else changeOwnership(action, applicantId);
  }

  function handleInput(event) {
    if (event.target.id === 'bench-search') {
      const value = text(event.target.value, 120);
      filters = normalizeFilters({ ...filters, search: value });
      restoreFilterFocus('bench-search', value);
    }
  }

  function handleChange(event) {
    const fields = { 'bench-va-type': 'vaType', 'bench-verified-skill': 'verifiedSkill', 'bench-availability': 'availability', 'bench-rate-min': 'rateMin', 'bench-rate-max': 'rateMax' };
    const field = fields[event.target.id];
    if (field) setFilters({ [field]: event.target.value });
    if (event.target.id === 'bench-limit-owner') {
      const option = event.target.selectedOptions?.[0];
      const input = mountedRoot?.querySelector?.('#bench-caseload-limit');
      if (input && option?.dataset?.capacity) input.value = option.dataset.capacity;
    }
  }

  function handleSubmit(event) {
    const limitForm = event.target.closest?.('[data-bench-limit-form]');
    if (limitForm) {
      event.preventDefault();
      const values = new root.FormData(limitForm);
      changeLimit(values.get('salesOwnerId'), values.get('caseloadLimit'));
      return;
    }
    const form = event.target.closest?.('[data-bench-assignment-form]');
    if (!form || !assignmentContext) return;
    event.preventDefault();
    const item = queue.items.find(candidate => candidate.applicantId === assignmentContext.applicantId);
    const ownerId = validUuid(new root.FormData(form).get('salesOwnerId'));
    if (!item || !ownerId) return;
    changeOwnership(item.owner.id ? 'reassign' : 'assign', item.applicantId, ownerId);
  }

  function unmount({ clear = true } = {}) {
    requestVersion += 1;
    abortRequest();
    if (mountedRoot) {
      mountedRoot.removeEventListener?.('click', handleClick);
      mountedRoot.removeEventListener?.('input', handleInput);
      mountedRoot.removeEventListener?.('change', handleChange);
      mountedRoot.removeEventListener?.('submit', handleSubmit);
      if (clear) mountedRoot.innerHTML = '';
    }
    mountedRoot = null;
    assignmentContext = null;
    limitContext = false;
    pendingApplicantId = '';
    return true;
  }

  function mount(target, options = {}) {
    const nextRole = normalizedRole(options.role || actualRole());
    if (!target || typeof target.addEventListener !== 'function' || !canOpenForRole(nextRole)) return false;
    if (mountedRoot && mountedRoot !== target) unmount();
    mountedRoot = target;
    viewerRole = nextRole;
    target.removeEventListener('click', handleClick);
    target.removeEventListener('input', handleInput);
    target.removeEventListener('change', handleChange);
    target.removeEventListener('submit', handleSubmit);
    target.addEventListener('click', handleClick);
    target.addEventListener('input', handleInput);
    target.addEventListener('change', handleChange);
    target.addEventListener('submit', handleSubmit);
    filters = emptyFilters();
    queue = emptyQueue();
    limitContext = false;
    feedback = Object.freeze({ type: '', message: '' });
    render();
    refresh();
    return true;
  }

  function handleAuthChange(event) {
    const detail = event?.detail || {};
    if (!detail.session || !canOpenForRole(detail.access?.role)) {
      if (mountedRoot) unmount();
      return;
    }
    if (mountedRoot) refresh();
  }

  root?.addEventListener?.('soro-auth-changed', handleAuthChange);

  return Object.freeze({
    ENDPOINT,
    AUTHORIZED_ROLES,
    ACTIONS,
    STAGES,
    DEFAULT_CAPACITY,
    canOpenForRole,
    normalizePayload,
    normalizeFilters,
    visibleItems,
    setFilters,
    openProfile,
    changeOwnership,
    changeLimit,
    refresh,
    mount,
    unmount
  });
}));
