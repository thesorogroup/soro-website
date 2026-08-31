/* Admin Employee Payroll and Talent Payout workspace. No action in this module sends money. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.soroAdminPayroll = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const ENDPOINT = '/.netlify/functions/admin-payroll';
  const ADMIN_ROLE = 'admin';
  const TALENT_ROLE = 'talent_management';
  const EMPLOYEE_STATUSES = new Set(['draft', 'ready', 'approved', 'exported', 'reconciled', 'cancelled']);
  const TALENT_STATUSES = new Set(['draft', 'ready', 'approved', 'exported', 'released', 'cancelled']);
  const VERIFICATION_STATUSES = new Set(['verified', 'needs_review']);
  const FINAL_EMPLOYEE_STATUSES = new Set(['reconciled', 'cancelled']);
  const FINAL_TALENT_STATUSES = new Set(['released', 'cancelled']);
  const ICONS = Object.freeze({
    employee: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5h16v11H4zM7 7.5V5h10v2.5M8 12h8M8 15.5h5" /></svg>',
    talent: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M15.5 3.5 19 7l-3.5 3.5M19 17H5m3.5 3.5L5 17l3.5-3.5" /></svg>'
  });

  let workspace = freezeWorkspace({ phase: 'idle', generatedAt: '', viewerRole: '', employeePayroll: null, talentPayouts: { runs: [] } });
  let activeController = null;
  let requestVersion = 0;
  let selectedLane = 'employee';
  let selectedEmployeeRunId = '';
  let selectedTalentRunId = '';
  let feedback = null;
  let rendererInstalled = false;

  function text(value, max = 500) {
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
    return [ADMIN_ROLE, TALENT_ROLE].includes(normalizedRole(roleValue));
  }

  function canOpenView(view, roleValue = actualRole()) {
    const role = normalizedRole(roleValue);
    return (view === 'payroll' && role === ADMIN_ROLE)
      || (view === 'talent-payout-review' && role === TALENT_ROLE);
  }

  function validUuid(value) {
    const normalized = text(value, 64).toLowerCase();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
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

  function validCurrency(value) {
    const normalized = text(value, 3).toUpperCase();
    return /^[A-Z]{3}$/.test(normalized) ? normalized : '';
  }

  function decimal(value) {
    if (value === null || value === undefined || value === '') return null;
    const normalized = String(value).trim();
    return /^\d{1,12}(?:\.\d{1,2})?$/.test(normalized) ? normalized : null;
  }

  function nonnegativeInteger(value) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }

  function exactBoolean(value) {
    return value === true;
  }

  function freezeWorkspace(value) {
    return Object.freeze({
      ...value,
      employeePayroll: value.employeePayroll ? Object.freeze({
        runs: Object.freeze(value.employeePayroll.runs),
        readiness: value.employeePayroll.readiness
      }) : null,
      talentPayouts: Object.freeze({ runs: Object.freeze(value.talentPayouts?.runs || []) })
    });
  }

  function unavailableEmployeeReadiness() {
    return Object.freeze({
      valid: false,
      asOf: '',
      wiseEligible: 0,
      wiseConfigured: 0,
      needsSetup: 0,
      quickbooks: 0,
      inactive: 0,
      futureHire: 0,
      total: 0,
      canRunPayroll: false
    });
  }

  function normalizeEmployeeReadiness(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailableEmployeeReadiness();
    const readiness = {
      asOf: validDate(value.asOf),
      wiseEligible: nonnegativeInteger(value.wiseEligible),
      wiseConfigured: nonnegativeInteger(value.wiseConfigured),
      needsSetup: nonnegativeInteger(value.needsSetup),
      quickbooks: nonnegativeInteger(value.quickbooks),
      inactive: nonnegativeInteger(value.inactive),
      futureHire: nonnegativeInteger(value.futureHire),
      total: nonnegativeInteger(value.total),
      canRunPayroll: value.canRunPayroll
    };
    const counts = [readiness.wiseEligible, readiness.wiseConfigured, readiness.needsSetup, readiness.quickbooks, readiness.inactive, readiness.futureHire, readiness.total];
    if (!readiness.asOf || counts.some(item => item === null) || typeof readiness.canRunPayroll !== 'boolean') return unavailableEmployeeReadiness();
    if (readiness.wiseConfigured > readiness.wiseEligible || readiness.wiseEligible > readiness.total) return unavailableEmployeeReadiness();
    if (readiness.canRunPayroll !== (readiness.wiseEligible > 0)) return unavailableEmployeeReadiness();
    return Object.freeze({ valid: true, ...readiness });
  }

  function normalizeEmployeeItem(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const itemId = validUuid(value.itemId);
    const employeeUserId = validUuid(value.employeeUserId);
    const employeeName = text(value.employeeName, 180);
    const paymentRoute = text(value.paymentRoute, 50).toLowerCase();
    if (!itemId || !employeeUserId || !employeeName || paymentRoute !== 'wise_contractor' || typeof value.included !== 'boolean') return null;
    return Object.freeze({
      itemId,
      employeeUserId,
      employeeName,
      employeeEmail: text(value.employeeEmail, 254),
      employeeRole: text(value.employeeRole, 80),
      hireDate: validDate(value.hireDate),
      paymentRoute,
      payoutRecipientEmail: text(value.payoutRecipientEmail, 254),
      included: value.included,
      amount: decimal(value.amount),
      note: text(value.note, 500),
      exceptionStatus: text(value.exceptionStatus, 40).toLowerCase(),
      exceptionNote: text(value.exceptionNote, 1000),
      updatedAt: validTimestamp(value.updatedAt)
    });
  }

  function normalizeTalentItem(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const itemId = validUuid(value.itemId);
    const applicantId = validUuid(value.applicantId);
    const placementId = validUuid(value.placementId);
    const talentName = text(value.talentName, 180);
    if (!itemId || !applicantId || !placementId || !talentName || typeof value.included !== 'boolean') return null;
    const verificationStatus = text(value.verificationStatus, 40).toLowerCase() || 'needs_review';
    if (!VERIFICATION_STATUSES.has(verificationStatus)) return null;
    return Object.freeze({
      itemId,
      applicantId,
      placementId,
      talentName,
      recipientEmail: text(value.recipientEmail, 254),
      clientName: text(value.clientName, 180),
      rateType: text(value.rateType, 80),
      rateAmount: decimal(value.rateAmount),
      paymentReference: text(value.paymentReference, 180),
      included: value.included,
      amount: decimal(value.amount),
      note: text(value.note, 500),
      verificationStatus,
      verificationNote: text(value.verificationNote, 500),
      verifiedBy: text(value.verifiedBy, 180),
      verifiedAt: validTimestamp(value.verifiedAt),
      exceptionStatus: text(value.exceptionStatus, 40).toLowerCase(),
      exceptionNote: text(value.exceptionNote, 1000),
      updatedAt: validTimestamp(value.updatedAt)
    });
  }

  function normalizeRun(value, lane) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const statuses = lane === 'employee' ? EMPLOYEE_STATUSES : TALENT_STATUSES;
    const runId = validUuid(value.runId);
    const status = text(value.status, 40).toLowerCase();
    const periodStart = validDate(value.periodStart);
    const periodEnd = validDate(value.periodEnd);
    const payDate = validDate(value.payDate);
    const currency = validCurrency(value.currency);
    const itemCount = nonnegativeInteger(value.itemCount);
    const exceptionCount = nonnegativeInteger(value.exceptionCount);
    if (!runId || !statuses.has(status) || !periodStart || !periodEnd || !payDate || !currency || periodEnd < periodStart || itemCount === null || exceptionCount === null) return null;
    const items = Array.isArray(value.items) && value.items.length <= 2000
      ? value.items.map(item => lane === 'employee' ? normalizeEmployeeItem(item) : normalizeTalentItem(item))
      : null;
    if (!items || items.some(item => !item)) return null;
    const common = {
      runId,
      lane,
      periodStart,
      periodEnd,
      payDate,
      currency,
      status,
      totalAmount: decimal(value.totalAmount) || '0',
      itemCount,
      exceptionCount,
      createdBy: text(value.createdBy, 180),
      createdAt: validTimestamp(value.createdAt),
      approvedBy: text(value.approvedBy, 180),
      approvedAt: validTimestamp(value.approvedAt),
      exportedBy: text(value.exportedBy, 180),
      exportedAt: validTimestamp(value.exportedAt),
      exportFileName: text(value.exportFileName, 240),
      exportSha256: text(value.exportSha256, 64),
      externalReference: text(value.externalReference, 180),
      notes: text(value.notes, 1000),
      updatedAt: validTimestamp(value.updatedAt),
      canEdit: exactBoolean(value.canEdit),
      canApprove: exactBoolean(value.canApprove),
      canExport: exactBoolean(value.canExport),
      canCancel: exactBoolean(value.canCancel),
      items: Object.freeze(items)
    };
    return Object.freeze(lane === 'employee' ? {
      ...common,
      reconciledBy: text(value.reconciledBy, 180),
      reconciledAt: validTimestamp(value.reconciledAt),
      canReconcile: exactBoolean(value.canReconcile)
    } : {
      ...common,
      releasedBy: text(value.releasedBy, 180),
      releasedAt: validTimestamp(value.releasedAt),
      canVerify: exactBoolean(value.canVerify),
      canRelease: exactBoolean(value.canRelease)
    });
  }

  function normalizeLane(value, lane) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.runs) || value.runs.length > 500) return null;
    const runs = value.runs.map(run => normalizeRun(run, lane));
    if (runs.some(run => !run)) return null;
    return Object.freeze({
      runs: Object.freeze(runs),
      ...(lane === 'employee' ? { readiness: normalizeEmployeeReadiness(value.readiness) } : {})
    });
  }

  function normalizeWorkspace(payload, expectedRole = actualRole()) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Payroll returned an invalid response.');
    const role = normalizedRole(expectedRole);
    if (![ADMIN_ROLE, TALENT_ROLE].includes(role) || normalizedRole(payload.viewerRole) !== role) throw new Error('Payroll access could not be verified.');
    const talentPayouts = normalizeLane(payload.talentPayouts, 'talent');
    if (!talentPayouts) throw new Error('Talent payout data could not be verified.');
    let employeePayroll = null;
    if (role === ADMIN_ROLE) {
      employeePayroll = normalizeLane(payload.employeePayroll, 'employee');
      if (!employeePayroll) throw new Error('Employee payroll data could not be verified.');
    } else if (payload.employeePayroll !== null && payload.employeePayroll !== undefined) {
      throw new Error('Employee payroll is not available in Talent Management.');
    }
    return freezeWorkspace({
      phase: 'ready',
      generatedAt: validTimestamp(payload.generatedAt),
      viewerRole: role,
      employeePayroll,
      talentPayouts
    });
  }

  function dispatchUpdated() {
    if (root?.dispatchEvent && typeof root.CustomEvent === 'function') {
      root.dispatchEvent(new root.CustomEvent('soro:admin-payroll-updated', { detail: { workspace } }));
    }
  }

  function reset({ silent = false } = {}) {
    activeController?.abort?.();
    activeController = null;
    requestVersion += 1;
    workspace = freezeWorkspace({ phase: 'idle', generatedAt: '', viewerRole: '', employeePayroll: null, talentPayouts: { runs: [] } });
    selectedLane = actualRole() === TALENT_ROLE ? 'talent' : 'employee';
    selectedEmployeeRunId = '';
    selectedTalentRunId = '';
    feedback = null;
    if (!silent) dispatchUpdated();
  }

  async function sessionToken() {
    const { data, error } = await root?.soroSupabase?.auth?.getSession?.() || {};
    const token = data?.session?.access_token;
    if (error || !token) throw new Error('Your secure session expired. Sign in again and retry.');
    return token;
  }

  async function responseJson(response) {
    const responseText = await response.text();
    let payload = {};
    try { payload = responseText ? JSON.parse(responseText) : {}; } catch { payload = {}; }
    if (!response.ok) throw new Error(payload.message || 'Payroll could not complete that action.');
    return payload;
  }

  function syncSelections() {
    const employeeRuns = workspace.employeePayroll?.runs || [];
    const talentRuns = workspace.talentPayouts?.runs || [];
    if (!employeeRuns.some(run => run.runId === selectedEmployeeRunId)) selectedEmployeeRunId = preferredRun(employeeRuns, 'employee')?.runId || '';
    if (!talentRuns.some(run => run.runId === selectedTalentRunId)) selectedTalentRunId = preferredRun(talentRuns, 'talent')?.runId || '';
    if (workspace.viewerRole === TALENT_ROLE) selectedLane = 'talent';
  }

  async function load() {
    const role = actualRole();
    if (!canUse(role)) { reset(); return workspace; }
    activeController?.abort?.();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    activeController = controller;
    const version = ++requestVersion;
    workspace = freezeWorkspace({ ...workspace, phase: 'loading', viewerRole: role });
    dispatchUpdated();
    try {
      const token = await sessionToken();
      const response = await fetch(ENDPOINT, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        cache: 'no-store',
        signal: controller?.signal
      });
      const payload = await responseJson(response);
      if (version !== requestVersion) return workspace;
      workspace = normalizeWorkspace(payload, role);
      syncSelections();
      feedback = null;
    } catch (error) {
      if (version !== requestVersion || error?.name === 'AbortError') return workspace;
      workspace = freezeWorkspace({ ...workspace, phase: 'error', error: text(error?.message, 300) || 'Payroll could not be loaded.' });
    } finally {
      if (version === requestVersion) activeController = null;
    }
    dispatchUpdated();
    return workspace;
  }

  function operationRequestId() {
    const value = root?.crypto?.randomUUID?.();
    if (!validUuid(value)) throw new Error('This browser could not create a secure request. Refresh and try again.');
    return value;
  }

  async function postAction(action, fields) {
    if (!canUse()) throw new Error('Payroll access is not available for this account.');
    const token = await sessionToken();
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ action, requestId: operationRequestId(), ...fields })
    });
    await responseJson(response);
    await load();
  }

  async function exportRun(lane, runId) {
    if (actualRole() !== ADMIN_ROLE || !validUuid(runId)) throw new Error('Only an Administrator can export an approved batch.');
    const token = await sessionToken();
    const action = lane === 'employee' ? 'export_employee_run' : 'export_talent_run';
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/csv' },
      cache: 'no-store',
      body: JSON.stringify({ action, requestId: operationRequestId(), runId })
    });
    if (!response.ok) {
      let message = 'The export could not be prepared.';
      try { message = (await response.json()).message || message; } catch {}
      throw new Error(message);
    }
    const blob = await response.blob();
    const disposition = response.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="?([^";]+)"?/i);
    const fallback = lane === 'employee' ? 'soro-employee-payroll.csv' : 'soro-talent-wise-payouts.csv';
    const filename = text(match?.[1] || fallback, 180).replace(/[^a-z0-9._-]+/gi, '-') || fallback;
    const href = URL.createObjectURL(blob);
    const anchor = root.document.createElement('a');
    anchor.href = href;
    anchor.download = filename;
    anchor.rel = 'noopener';
    root.document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1500);
    await load();
  }

  function formatDate(value) {
    if (!validDate(value)) return 'Not recorded';
    const date = new Date(`${value}T12:00:00`);
    return Number.isFinite(date.getTime())
      ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      : value;
  }

  function formatDateTime(value) {
    const normalized = validTimestamp(value);
    return normalized ? new Date(normalized).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  }

  function formatMoney(value, currency) {
    const normalized = decimal(value);
    if (normalized === null) return 'Not entered';
    const [whole, fractional = ''] = normalized.split('.');
    return `${validCurrency(currency) || 'USD'} ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fractional.padEnd(2, '0')}`;
  }

  function titleCase(value) {
    return text(value, 80).replaceAll('_', ' ').replace(/\b\w/g, character => character.toUpperCase()) || 'Not recorded';
  }

  function preferredRun(runs, lane) {
    const finals = lane === 'employee' ? FINAL_EMPLOYEE_STATUSES : FINAL_TALENT_STATUSES;
    return runs.find(run => !finals.has(run.status)) || runs[0] || null;
  }

  function selectedRun(lane) {
    const runs = lane === 'employee' ? workspace.employeePayroll?.runs || [] : workspace.talentPayouts?.runs || [];
    const selectedId = lane === 'employee' ? selectedEmployeeRunId : selectedTalentRunId;
    return runs.find(run => run.runId === selectedId) || preferredRun(runs, lane);
  }

  function employeeReadinessMarkup(readiness) {
    if (!readiness?.valid) {
      return `<section class="payroll-readiness payroll-readiness--unavailable" aria-label="Employee payroll readiness"><div><span>Payroll readiness</span><strong>Needs review</strong></div><p>Current employee eligibility could not be verified. Review employee setup before creating a Wise payroll draft.</p></section>`;
    }
    const notEligible = readiness.inactive + readiness.futureHire;
    const needsSetup = readiness.needsSetup + (readiness.wiseEligible - readiness.wiseConfigured);
    return `<section class="payroll-readiness" aria-label="Employee payroll readiness"><header><div><span>Payroll readiness</span><strong>As of ${escapeHtml(formatDate(readiness.asOf))}</strong></div><small>${readiness.total} employee${readiness.total === 1 ? '' : 's'} reviewed by the server</small></header><dl>
      <div class="payroll-readiness-stat payroll-readiness-stat--ready"><dt>Wise-ready</dt><dd>${readiness.wiseConfigured}</dd><small>Wise recipient recorded</small></div>
      <div class="payroll-readiness-stat payroll-readiness-stat--setup"><dt>Needs setup</dt><dd>${needsSetup}</dd><small>Payment route or recipient needs attention</small></div>
      <div class="payroll-readiness-stat payroll-readiness-stat--quickbooks"><dt>QuickBooks-only</dt><dd>${readiness.quickbooks}</dd><small>Excluded from the Wise batch</small></div>
      <div class="payroll-readiness-stat payroll-readiness-stat--ineligible"><dt>Not currently eligible</dt><dd>${notEligible}</dd><small>${readiness.inactive} inactive · ${readiness.futureHire} future hire</small></div>
    </dl></section>`;
  }

  function laneCardMarkup(lane, role) {
    const employee = lane === 'employee';
    const runs = employee ? workspace.employeePayroll?.runs || [] : workspace.talentPayouts?.runs || [];
    const run = preferredRun(runs, lane);
    const active = run && !(employee ? FINAL_EMPLOYEE_STATUSES : FINAL_TALENT_STATUSES).has(run.status);
    const canCreate = role === ADMIN_ROLE;
    const readiness = employee ? workspace.employeePayroll?.readiness : null;
    const canStartEmployeePayroll = employee && readiness?.valid && readiness.canRunPayroll;
    const title = employee ? 'Employee Payroll' : 'Talent Payouts';
    const label = employee ? 'Philippines internal staff' : 'Philippines contract Talent';
    const description = employee
      ? 'Prepare the separate Wise batch for Soro’s Philippines internal-staff contractors. U.S. employees stay in QuickBooks and are excluded here.'
      : 'Prepare a reviewed contractor payout batch and Wise-ready export. No Soro tax withholding or fund release happens here.';
    const primaryLabel = active
      ? (employee ? 'Continue payroll' : role === TALENT_ROLE ? 'Review talent payouts' : 'Continue payout batch')
      : (employee ? 'Run payroll' : 'Create payout batch');
    const summary = run ? [
      ['Status', titleCase(run.status)],
      ['Pay date', formatDate(run.payDate)],
      ['Total', formatMoney(run.totalAmount, run.currency)]
    ] : [['Status', 'Not started'], ['Pay date', 'Not scheduled'], ['Total', '—']];
    const button = active
      ? `<button class="button payroll-lane-primary" type="button" data-payroll-open-lane="${lane}">${escapeHtml(primaryLabel)}</button>`
      : canCreate
        ? employee && !canStartEmployeePayroll
          ? '<button class="button payroll-lane-primary payroll-lane-primary--review" type="button" data-payroll-review-employees>Review employee setup</button>'
          : `<button class="button payroll-lane-primary" type="button" data-payroll-create="${lane}">${escapeHtml(primaryLabel)}</button>`
        : '<button class="button" type="button" disabled>No batch to review</button>';
    return `<article class="payroll-lane-card payroll-lane-card--${lane}"><div class="payroll-lane-head"><div><p class="payroll-lane-label">${escapeHtml(label)}</p><h2>${escapeHtml(title)}</h2></div><span class="payroll-lane-icon">${ICONS[lane]}</span></div><p>${escapeHtml(description)}</p>${employee ? employeeReadinessMarkup(readiness) : ''}<dl class="payroll-lane-summary">${summary.map(([term, value]) => `<div><dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl><div class="payroll-lane-actions">${button}<small>${employee ? 'Payment route is set by an Administrator in Employees; the browser never infers it.' : 'Only an Administrator can approve, export, or record release.'}</small></div></article>`;
  }

  function statusMarkup(value) {
    const normalized = text(value, 40).toLowerCase();
    return `<span class="payroll-status payroll-status--${escapeHtml(normalized)}">${escapeHtml(titleCase(normalized))}</span>`;
  }

  function runActionsMarkup(lane, run, role) {
    if (!run) return '';
    const employee = lane === 'employee';
    const buttons = [];
    if (run.status === 'draft' && run.canEdit && role === ADMIN_ROLE) buttons.push(`<button class="button" type="button" data-payroll-transition="ready" data-payroll-lane="${lane}" data-run-id="${run.runId}">Mark ready</button>`);
    if (run.status === 'ready' && run.canApprove && role === ADMIN_ROLE) buttons.push(`<button class="button primary" type="button" data-payroll-transition="approve" data-payroll-lane="${lane}" data-run-id="${run.runId}">Approve ${employee ? 'payroll' : 'payouts'}</button>`);
    if (run.canExport && role === ADMIN_ROLE) buttons.push(`<button class="button" type="button" data-payroll-export="${lane}" data-run-id="${run.runId}">${employee ? 'Export staff Wise CSV' : 'Export Wise CSV'}</button>`);
    if (employee && run.canReconcile && role === ADMIN_ROLE) buttons.push(`<button class="button primary" type="button" data-payroll-transition="reconcile" data-payroll-lane="employee" data-run-id="${run.runId}">Record Wise reconciliation</button>`);
    if (!employee && run.canRelease && role === ADMIN_ROLE) buttons.push(`<button class="button primary" type="button" data-payroll-transition="release" data-payroll-lane="talent" data-run-id="${run.runId}">Record Wise release</button>`);
    if (run.canCancel && role === ADMIN_ROLE) buttons.push(`<button class="button" type="button" data-payroll-transition="cancel" data-payroll-lane="${lane}" data-run-id="${run.runId}">Cancel batch</button>`);
    return buttons.join('');
  }

  function itemRowsMarkup(lane, run, role) {
    const employee = lane === 'employee';
    if (!run.items.length) return `<tr><td colspan="6" class="payroll-empty">${employee ? 'No Philippines internal-staff contractors are configured for this Wise batch.' : 'No eligible Talent were added to this draft.'}</td></tr>`;
    return run.items.map(item => {
      const name = employee ? item.employeeName : item.talentName;
      const secondary = employee
        ? [item.employeeRole && titleCase(item.employeeRole), item.employeeEmail, item.payoutRecipientEmail ? `Wise: ${item.payoutRecipientEmail}` : 'Wise recipient missing'].filter(Boolean).join(' · ')
        : [item.clientName, item.recipientEmail || 'Wise recipient email missing'].filter(Boolean).join(' · ');
      const verification = employee ? statusMarkup(item.exceptionStatus || 'ready') : statusMarkup(item.verificationStatus);
      const exception = item.exceptionNote || (item.exceptionStatus && item.exceptionStatus !== 'clear' ? titleCase(item.exceptionStatus) : 'None');
      const actions = [];
      if (run.canEdit && role === ADMIN_ROLE) actions.push(`<button class="button payroll-compact-button" type="button" data-payroll-edit-item="${item.itemId}" data-payroll-lane="${lane}" data-run-id="${run.runId}">Edit</button>`);
      if (!employee && run.canVerify && [ADMIN_ROLE, TALENT_ROLE].includes(role)) actions.push(`<button class="button payroll-compact-button" type="button" data-payroll-verify-item="${item.itemId}" data-run-id="${run.runId}">${item.verificationStatus === 'verified' ? 'Review verification' : 'Verify'}</button>`);
      return `<tr class="payroll-item${item.included ? '' : ' payroll-item--excluded'}"><td><span class="payroll-person"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(secondary || 'Details not recorded')}</small></span></td><td>${item.included ? 'Included' : 'Excluded'}</td><td><span class="payroll-amount">${escapeHtml(formatMoney(item.amount, run.currency))}</span></td><td>${verification}</td><td><span class="payroll-item-note">${escapeHtml(exception)}</span></td><td><span class="payroll-item-actions">${actions.join('') || '—'}</span></td></tr>`;
    }).join('');
  }

  function employeeRoutingScopeMarkup() {
    return `<section class="payroll-routing-scope" aria-label="Employee payment routing">
      <div class="payroll-routing-item payroll-routing-item--included"><span>Included here</span><strong>Philippines contractor — Wise</strong><small>Only this Administrator-assigned route enters the internal-staff Wise batch.</small></div>
      <div class="payroll-routing-item payroll-routing-item--excluded"><span>QuickBooks only · Excluded</span><strong>U.S. employee — QuickBooks</strong><small>U.S. employees remain outside this Wise batch and are handled through QuickBooks.</small></div>
      <div class="payroll-routing-item payroll-routing-item--blocked"><span>Setup required</span><strong>Needs setup</strong><small>Employees stay out of both runs until an Administrator selects their payment route.</small></div>
    </section>`;
  }

  function runSectionMarkup(lane, run, role) {
    const employee = lane === 'employee';
    if (!run) return `<section class="panel payroll-workspace">${employee ? employeeRoutingScopeMarkup() : ''}<div class="payroll-empty">No ${employee ? 'Philippines staff Wise' : 'Talent payout'} batch has been created yet.</div></section>`;
    const actor = run.approvedBy || run.exportedBy || (employee ? run.reconciledBy : run.releasedBy) || run.createdBy || 'Not recorded';
    return `<section class="panel payroll-workspace"><header class="payroll-workspace-head"><div><span class="payroll-lane-label">${employee ? 'Philippines staff Wise batch' : 'Talent payout batch'}</span><h2>${escapeHtml(formatDate(run.periodStart))}–${escapeHtml(formatDate(run.periodEnd))}</h2><p>Created ${escapeHtml(formatDateTime(run.createdAt) || 'recently')} · No action on this page sends money.</p></div><div class="payroll-workspace-actions">${runActionsMarkup(lane, run, role)}</div></header>${employee ? employeeRoutingScopeMarkup() : ''}<dl class="payroll-run-summary"><div><dt>Status</dt><dd>${statusMarkup(run.status)}</dd></div><div><dt>Pay date</dt><dd>${escapeHtml(formatDate(run.payDate))}</dd></div><div><dt>Included</dt><dd>${run.itemCount} ${employee ? 'Wise staff' : 'Talent'}</dd></div><div><dt>Server total</dt><dd>${escapeHtml(formatMoney(run.totalAmount, run.currency))}</dd></div><div><dt>Latest owner</dt><dd>${escapeHtml(actor)}</dd></div></dl>${run.exceptionCount ? `<div class="payroll-exception-note"><span><strong>${run.exceptionCount} exception${run.exceptionCount === 1 ? '' : 's'} need attention.</strong> Approval or export stays blocked until the server confirms they are resolved.</span>${statusMarkup('needs_review')}</div>` : ''}<div class="payroll-table-wrap"><table class="payroll-table"><thead><tr><th>${employee ? 'Wise staff / recipient' : 'Talent / recipient'}</th><th>Included</th><th>Amount</th><th>${employee ? 'Record state' : 'Verification'}</th><th>Exception</th><th>Action</th></tr></thead><tbody>${itemRowsMarkup(lane, run, role)}</tbody></table></div></section>`;
  }

  function historyMarkup(lane, runs) {
    if (!runs.length) return '';
    const selectedId = lane === 'employee' ? selectedEmployeeRunId : selectedTalentRunId;
    return `<section class="panel payroll-history"><header class="payroll-history-head"><div><h2>${lane === 'employee' ? 'Philippines staff Wise history' : 'Talent payout history'}</h2><p>Exports and external references remain separate from payment release.</p></div><span class="payroll-status">${runs.length} batch${runs.length === 1 ? '' : 'es'}</span></header><div class="payroll-history-grid">${runs.map(run => `<button class="payroll-history-card" type="button" data-payroll-history-lane="${lane}" data-run-id="${run.runId}" aria-pressed="${run.runId === selectedId}"><strong>${escapeHtml(formatDate(run.periodStart))}–${escapeHtml(formatDate(run.periodEnd))}</strong>${statusMarkup(run.status)}<small>${escapeHtml(formatMoney(run.totalAmount, run.currency))} · Pay date ${escapeHtml(formatDate(run.payDate))}</small></button>`).join('')}</div></section>`;
  }

  function readyPage(role) {
    const admin = role === ADMIN_ROLE;
    const lane = admin ? selectedLane : 'talent';
    const employeeRuns = workspace.employeePayroll?.runs || [];
    const talentRuns = workspace.talentPayouts.runs;
    const run = selectedRun(lane);
    const runs = lane === 'employee' ? employeeRuns : talentRuns;
    const heading = admin ? 'Payroll & Payouts' : 'Talent Payout Review';
    const caption = admin
      ? 'Prepare a Philippines internal-staff Wise batch separately from Talent payouts. U.S. employee payroll remains in QuickBooks.'
      : 'Verify Talent payout details and add review notes. Administrator approval, export, and release remain separate.';
    return `<main class="page payroll-page"><div class="page-heading payroll-page-heading"><div><p class="eyebrow">${admin ? 'Admin Panel' : 'Talent Management Panel'}</p><h1>${heading}</h1><p class="payroll-page-caption">${caption}</p></div><span class="payroll-safety-note">Soro records and exports approved batches. It does not send money from this screen.</span></div>${feedback ? `<div class="payroll-feedback${feedback.type === 'error' ? ' payroll-feedback--error' : ''}" role="status">${escapeHtml(feedback.message)}</div>` : ''}<section class="payroll-lane-grid${admin ? '' : ' payroll-lane-grid--single'}">${admin ? laneCardMarkup('employee', role) : ''}${laneCardMarkup('talent', role)}</section>${runSectionMarkup(lane, run, role)}${historyMarkup(lane, runs)}</main>`;
  }

  function pageMarkup(role = actualRole()) {
    const heading = role === ADMIN_ROLE ? 'Payroll & Payouts' : 'Talent Payout Review';
    if (workspace.phase === 'loading' || workspace.phase === 'idle') return `<main class="page payroll-page"><div class="page-heading"><div><p class="eyebrow">${role === ADMIN_ROLE ? 'Admin Panel' : 'Talent Management Panel'}</p><h1>${heading}</h1></div></div><section class="panel payroll-loading">Loading secure payroll and payout records…</section></main>`;
    if (workspace.phase === 'error') return `<main class="page payroll-page"><div class="page-heading"><div><p class="eyebrow">${role === ADMIN_ROLE ? 'Admin Panel' : 'Talent Management Panel'}</p><h1>${heading}</h1></div></div><section class="panel payroll-error"><strong>Payroll records could not be loaded.</strong><p>${escapeHtml(workspace.error || 'Refresh your secure session and try again.')}</p><button class="button" type="button" data-payroll-retry>Try again</button></section></main>`;
    return readyPage(role);
  }

  function dialogShell({ eyebrow, title, content }) {
    const dialog = root.document.createElement('dialog');
    const titleId = `payroll-dialog-title-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    dialog.className = 'payroll-dialog';
    dialog.setAttribute('aria-labelledby', titleId);
    dialog.innerHTML = `<section class="payroll-dialog-shell"><header class="payroll-dialog-head"><div><p class="payroll-lane-label">${escapeHtml(eyebrow)}</p><h2 id="${titleId}">${escapeHtml(title)}</h2></div><button class="payroll-dialog-close" type="button" aria-label="Close">×</button></header>${content}</section>`;
    root.document.body.append(dialog);
    dialog.querySelector('.payroll-dialog-close')?.addEventListener('click', () => dialog.close('cancel'));
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close('cancel'); });
    dialog.addEventListener('close', () => dialog.remove());
    return dialog;
  }

  function shiftIsoDate(value, days) {
    if (!validDate(value) || !Number.isSafeInteger(days)) return '';
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  function defaultRunDates(employeeReadinessAsOf = '') {
    if (validDate(employeeReadinessAsOf)) {
      return {
        periodStart: shiftIsoDate(employeeReadinessAsOf, -13),
        periodEnd: employeeReadinessAsOf,
        payDate: shiftIsoDate(employeeReadinessAsOf, 1)
      };
    }
    const today = new Date();
    const payDate = new Date(today);
    const daysUntilFriday = (5 - payDate.getDay() + 7) % 7;
    payDate.setDate(payDate.getDate() + daysUntilFriday);
    const periodEnd = new Date(payDate);
    periodEnd.setDate(periodEnd.getDate() - 1);
    const periodStart = new Date(periodEnd);
    periodStart.setDate(periodStart.getDate() - 13);
    const iso = date => date.toISOString().slice(0, 10);
    return { periodStart: iso(periodStart), periodEnd: iso(periodEnd), payDate: iso(payDate) };
  }

  function openCreateDialog(lane) {
    if (actualRole() !== ADMIN_ROLE || !['employee', 'talent'].includes(lane)) return;
    const employee = lane === 'employee';
    const readiness = workspace.employeePayroll?.readiness;
    const dates = defaultRunDates(employee && readiness?.valid ? readiness.asOf : '');
    const dialog = dialogShell({
      eyebrow: employee ? 'Employee Payroll' : 'Talent Payouts',
      title: employee ? 'Run payroll' : 'Create payout batch',
      content: `<form class="payroll-dialog-form"><p class="payroll-dialog-note"><strong>This creates a draft only.</strong> ${employee ? 'Review every amount. Any U.S. employee taxes and withholding are completed in QuickBooks, outside Soro.' : 'Review every amount and recipient before exporting the contractor payout preparation file for Wise.'}</p><div class="payroll-form-grid"><label class="payroll-field"><span>Period starts</span><input name="periodStart" type="date" value="${dates.periodStart}" required /></label><label class="payroll-field"><span>Period ends</span><input name="periodEnd" type="date" value="${dates.periodEnd}" required /></label><label class="payroll-field"><span>Pay date</span><input name="payDate" type="date" value="${dates.payDate}" required /></label><label class="payroll-field"><span>Currency</span><input name="currency" value="USD" maxlength="3" pattern="[A-Za-z]{3}" required /><small>Three-letter currency code</small></label></div><p class="payroll-dialog-message" aria-live="polite"></p><footer class="payroll-dialog-actions"><button class="button" type="button" data-payroll-dialog-cancel>Cancel</button><button class="button primary" type="submit">${employee ? 'Create payroll draft' : 'Create payout draft'}</button></footer></form>`
    });
    dialog.querySelector('[data-payroll-dialog-cancel]')?.addEventListener('click', () => dialog.close('cancel'));
    dialog.querySelector('form')?.addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const values = Object.fromEntries(new FormData(form).entries());
      const message = form.querySelector('.payroll-dialog-message');
      if (!validDate(values.periodStart) || !validDate(values.periodEnd) || !validDate(values.payDate) || values.periodEnd < values.periodStart || !validCurrency(values.currency)) {
        message.textContent = 'Choose a valid pay period, pay date, and three-letter currency.';
        message.className = 'payroll-dialog-message payroll-dialog-message--error';
        return;
      }
      selectedLane = lane;
      await submitDialogAction(form, message, lane === 'employee' ? 'create_employee_run' : 'create_talent_run', {
        periodStart: values.periodStart,
        periodEnd: values.periodEnd,
        payDate: values.payDate,
        currency: validCurrency(values.currency)
      }, dialog, employee ? 'Employee payroll draft created.' : 'Talent payout draft created.');
    });
    dialog.showModal();
  }

  function openItemDialog(lane, run, item) {
    if (actualRole() !== ADMIN_ROLE || !run?.canEdit || !item) return;
    const employee = lane === 'employee';
    const dialog = dialogShell({
      eyebrow: employee ? 'Employee Payroll' : 'Talent Payouts',
      title: `Edit ${employee ? item.employeeName : item.talentName}`,
      content: `<form class="payroll-dialog-form"><p class="payroll-dialog-note">Amounts are entered manually. The server recalculates the batch total; this screen never sends funds.</p><div class="payroll-form-grid">
        <label class="payroll-field"><span>Amount (${escapeHtml(run.currency)})</span><input name="amount" inputmode="decimal" value="${escapeHtml(item.amount || '')}" pattern="\\d{1,12}(?:\\.\\d{1,2})?" placeholder="0.00" /></label>
        ${employee ? `<label class="payroll-field"><span>Wise payout recipient</span><input name="payoutRecipientEmail" type="email" value="${escapeHtml(item.payoutRecipientEmail)}" maxlength="254" placeholder="Recipient email" /><small>Blank keeps this item in Needs review.</small></label><div class="payroll-route-readonly payroll-field--wide"><span>Payment route</span><strong>Philippines contractor — Wise</strong><small>This server-confirmed route cannot be changed from the payroll batch.</small></div>` : `<label class="payroll-field"><span>Wise recipient email</span><input name="recipientEmail" type="email" value="${escapeHtml(item.recipientEmail)}" maxlength="254" /></label>`}
        <label class="payroll-field payroll-field--wide"><span>Internal note</span><textarea name="note" maxlength="500">${escapeHtml(item.note)}</textarea></label><label class="payroll-check-field payroll-field--wide"><input name="included" type="checkbox" ${item.included ? 'checked' : ''} /><span>Include this ${employee ? 'employee' : 'Talent member'} in the batch.</span></label>
      </div><p class="payroll-dialog-message" aria-live="polite"></p><footer class="payroll-dialog-actions"><button class="button" type="button" data-payroll-dialog-cancel>Cancel</button><button class="button primary" type="submit">Save draft item</button></footer></form>`
    });
    if (employee) {
      const recipientInput = dialog.querySelector('[name="payoutRecipientEmail"]');
      if (recipientInput) recipientInput.value = item.payoutRecipientEmail || '';
    }
    dialog.querySelector('[data-payroll-dialog-cancel]')?.addEventListener('click', () => dialog.close('cancel'));
    dialog.querySelector('form')?.addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const values = Object.fromEntries(new FormData(form).entries());
      const amount = text(values.amount, 40);
      const message = form.querySelector('.payroll-dialog-message');
      if (amount && decimal(amount) === null) {
        message.textContent = 'Enter a positive amount with no more than two decimal places, or leave it blank.';
        message.className = 'payroll-dialog-message payroll-dialog-message--error';
        return;
      }
      const fields = {
        runId: run.runId,
        itemId: item.itemId,
        amount: amount || null,
        note: text(values.note, 500) || null,
        included: Boolean(form.elements.included.checked)
      };
      if (employee) fields.payoutRecipientEmail = text(values.payoutRecipientEmail, 254).toLowerCase() || null;
      else fields.recipientEmail = text(values.recipientEmail, 254) || null;
      await submitDialogAction(form, message, employee ? 'update_employee_item' : 'update_talent_item', fields, dialog, 'Draft item saved.');
    });
    dialog.showModal();
  }

  function openVerifyDialog(run, item) {
    if (![ADMIN_ROLE, TALENT_ROLE].includes(actualRole()) || !run?.canVerify || !item) return;
    const dialog = dialogShell({
      eyebrow: 'Talent payout review',
      title: `Verify ${item.talentName}`,
      content: `<form class="payroll-dialog-form"><p class="payroll-dialog-note">Verification confirms the payout details were reviewed. Only an Administrator can approve, export, or record a Wise release.</p><div class="payroll-form-grid"><label class="payroll-field payroll-field--wide"><span>Review result</span><select name="verificationStatus" required><option value="verified" ${item.verificationStatus === 'verified' ? 'selected' : ''}>Verified</option><option value="needs_review" ${item.verificationStatus === 'needs_review' ? 'selected' : ''}>Needs review</option></select></label><label class="payroll-field payroll-field--wide"><span>Review note</span><textarea name="note" maxlength="500">${escapeHtml(item.verificationNote)}</textarea></label></div><p class="payroll-dialog-message" aria-live="polite"></p><footer class="payroll-dialog-actions"><button class="button" type="button" data-payroll-dialog-cancel>Cancel</button><button class="button primary" type="submit">Save verification</button></footer></form>`
    });
    dialog.querySelector('[data-payroll-dialog-cancel]')?.addEventListener('click', () => dialog.close('cancel'));
    dialog.querySelector('form')?.addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const values = Object.fromEntries(new FormData(form).entries());
      const message = form.querySelector('.payroll-dialog-message');
      if (values.verificationStatus === 'needs_review' && !text(values.note, 500)) {
        message.textContent = 'Add a brief note describing what needs review.';
        message.className = 'payroll-dialog-message payroll-dialog-message--error';
        return;
      }
      await submitDialogAction(form, message, 'verify_talent_item', {
        runId: run.runId,
        itemId: item.itemId,
        verificationStatus: values.verificationStatus,
        note: text(values.note, 500) || null
      }, dialog, 'Talent payout verification saved.');
    });
    dialog.showModal();
  }

  function transitionCopy(lane, transition) {
    const employee = lane === 'employee';
    const map = {
      ready: { title: 'Mark batch ready', submit: 'Mark ready', note: 'This moves the draft to review. It does not send or release money.' },
      approve: { title: employee ? 'Approve employee payroll' : 'Approve Talent payouts', submit: 'Approve batch', note: 'Approval locks the reviewed batch for export. It does not send or release money.', confirm: true },
      reconcile: { title: 'Record staff Wise reconciliation', submit: 'Mark reconciled', note: 'Record the external Wise batch reference after releasing the Philippines internal-staff batch outside Soro.', reference: 'Wise batch reference', confirm: true },
      release: { title: 'Record Wise release', submit: 'Record release', note: 'Use this only after the approved Wise batch was released outside Soro. This button does not send money.', reference: 'Wise batch reference', confirm: true },
      cancel: { title: 'Cancel this batch', submit: 'Cancel batch', note: 'The batch remains in history and cannot be used for payment.', confirm: true }
    };
    return map[transition] || null;
  }

  function openTransitionDialog(lane, run, transition) {
    if (actualRole() !== ADMIN_ROLE || !run) return;
    const copy = transitionCopy(lane, transition);
    if (!copy) return;
    const dialog = dialogShell({
      eyebrow: lane === 'employee' ? 'Employee Payroll' : 'Talent Payouts',
      title: copy.title,
      content: `<form class="payroll-dialog-form"><p class="payroll-dialog-note"><strong>${escapeHtml(formatMoney(run.totalAmount, run.currency))} · ${run.itemCount} ${lane === 'employee' ? 'employees' : 'Talent'}</strong><br />${escapeHtml(copy.note)}</p><div class="payroll-form-grid">${copy.reference ? `<label class="payroll-field payroll-field--wide"><span>${escapeHtml(copy.reference)}</span><input name="reference" maxlength="180" required /></label>` : ''}<label class="payroll-field payroll-field--wide"><span>Internal note</span><textarea name="note" maxlength="500"></textarea></label>${copy.confirm ? `<label class="payroll-check-field payroll-field--wide"><input name="confirmed" type="checkbox" required /><span>I reviewed the pay period, included records, server total, and outstanding exceptions shown for this batch.</span></label>` : ''}</div><p class="payroll-dialog-message" aria-live="polite"></p><footer class="payroll-dialog-actions"><button class="button" type="button" data-payroll-dialog-cancel>Keep reviewing</button><button class="button primary" type="submit">${escapeHtml(copy.submit)}</button></footer></form>`
    });
    dialog.querySelector('[data-payroll-dialog-cancel]')?.addEventListener('click', () => dialog.close('cancel'));
    dialog.querySelector('form')?.addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const values = Object.fromEntries(new FormData(form).entries());
      const message = form.querySelector('.payroll-dialog-message');
      if (copy.confirm && !form.elements.confirmed.checked) {
        message.textContent = 'Confirm the batch details before continuing.';
        message.className = 'payroll-dialog-message payroll-dialog-message--error';
        return;
      }
      await submitDialogAction(form, message, lane === 'employee' ? 'transition_employee_run' : 'transition_talent_run', {
        runId: run.runId,
        transition,
        reference: text(values.reference, 180) || null,
        note: text(values.note, 500) || null
      }, dialog, `${copy.title} recorded.`);
    });
    dialog.showModal();
  }

  async function submitDialogAction(form, message, action, fields, dialog, successMessage) {
    const submit = form.querySelector('[type="submit"]');
    const originalLabel = submit?.textContent || 'Save';
    if (submit) { submit.disabled = true; submit.textContent = 'Saving securely…'; }
    message.textContent = '';
    try {
      await postAction(action, fields);
      feedback = { type: 'success', message: successMessage };
      dialog.close('saved');
      renderCurrentView();
    } catch (error) {
      message.textContent = text(error?.message, 300) || 'That action could not be completed.';
      message.className = 'payroll-dialog-message payroll-dialog-message--error';
      if (submit) { submit.disabled = false; submit.textContent = originalLabel; }
    }
  }

  function findRun(lane, runId) {
    const runs = lane === 'employee' ? workspace.employeePayroll?.runs || [] : workspace.talentPayouts.runs;
    return runs.find(run => run.runId === runId) || null;
  }

  function openEmployeeReadinessReview() {
    if (actualRole() !== ADMIN_ROLE || !root?.location || typeof current === 'undefined') return;
    const readiness = workspace.employeePayroll?.readiness;
    const destination = new URL(root.location.href);
    destination.searchParams.set('employeeFilter', 'payroll-readiness');
    if (readiness?.valid) destination.searchParams.set('payrollAsOf', readiness.asOf);
    else destination.searchParams.delete('payrollAsOf');
    destination.hash = 'employees';
    current = 'employees';
    root.history.pushState({}, '', `${destination.pathname}${destination.search}${destination.hash}`);
    if (typeof root.CustomEvent === 'function') root.dispatchEvent(new root.CustomEvent('soro:employee-payroll-review'));
    if (typeof setActive === 'function') setActive();
    if (typeof render === 'function') render();
    root.scrollTo?.({ top: 0, behavior: 'smooth' });
  }

  function bindPage(scope = root?.document) {
    scope?.querySelector('[data-payroll-retry]')?.addEventListener('click', load);
    scope?.querySelector('[data-payroll-review-employees]')?.addEventListener('click', openEmployeeReadinessReview);
    scope?.querySelectorAll('[data-payroll-create]').forEach(button => button.addEventListener('click', () => openCreateDialog(button.dataset.payrollCreate)));
    scope?.querySelectorAll('[data-payroll-open-lane]').forEach(button => button.addEventListener('click', () => {
      selectedLane = button.dataset.payrollOpenLane;
      renderCurrentView();
      scope.querySelector('.payroll-workspace')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    }));
    scope?.querySelectorAll('[data-payroll-history-lane]').forEach(button => button.addEventListener('click', () => {
      const lane = button.dataset.payrollHistoryLane;
      selectedLane = lane;
      if (lane === 'employee') selectedEmployeeRunId = button.dataset.runId;
      else selectedTalentRunId = button.dataset.runId;
      renderCurrentView();
    }));
    scope?.querySelectorAll('[data-payroll-edit-item]').forEach(button => button.addEventListener('click', () => {
      const lane = button.dataset.payrollLane;
      const run = findRun(lane, button.dataset.runId);
      const item = run?.items.find(value => value.itemId === button.dataset.payrollEditItem);
      openItemDialog(lane, run, item);
    }));
    scope?.querySelectorAll('[data-payroll-verify-item]').forEach(button => button.addEventListener('click', () => {
      const run = findRun('talent', button.dataset.runId);
      const item = run?.items.find(value => value.itemId === button.dataset.payrollVerifyItem);
      openVerifyDialog(run, item);
    }));
    scope?.querySelectorAll('[data-payroll-transition]').forEach(button => button.addEventListener('click', () => {
      const lane = button.dataset.payrollLane;
      openTransitionDialog(lane, findRun(lane, button.dataset.runId), button.dataset.payrollTransition);
    }));
    scope?.querySelectorAll('[data-payroll-export]').forEach(button => button.addEventListener('click', async () => {
      const lane = button.dataset.payrollExport;
      const original = button.textContent;
      button.disabled = true;
      button.textContent = 'Preparing CSV…';
      try {
        await exportRun(lane, button.dataset.runId);
        feedback = { type: 'success', message: lane === 'employee' ? 'Philippines staff Wise CSV downloaded. No funds were sent.' : 'Wise-ready CSV downloaded. Release the batch separately in Wise.' };
      } catch (error) {
        feedback = { type: 'error', message: text(error?.message, 300) || 'The export could not be prepared.' };
      }
      button.disabled = false;
      button.textContent = original;
      renderCurrentView();
    }));
  }

  function renderCurrentView() {
    if (!root?.document || typeof current === 'undefined' || !canOpenView(current)) return;
    if (typeof render === 'function') render();
  }

  function installRenderer() {
    if (rendererInstalled || !root?.document || typeof render !== 'function') return;
    rendererInstalled = true;
    const originalRender = render;
    render = function () {
      if (typeof current === 'undefined' || !['payroll', 'talent-payout-review'].includes(current)) return originalRender();
      if (!canOpenView(current, actualRole())) {
        current = 'overview';
        root.history.replaceState({}, '', `${root.location.pathname}#overview`);
        if (typeof setActive === 'function') setActive();
        return originalRender();
      }
      root.document.getElementById('view-root').innerHTML = pageMarkup(actualRole());
      bindPage(root.document.getElementById('view-root'));
      if (workspace.phase === 'idle') load();
    };
  }

  if (root?.document) {
    installRenderer();
    root.addEventListener('soro-auth-changed', event => {
      const role = actualRole(event.detail?.access);
      if (canUse(role)) load();
      else reset({ silent: true });
      if (typeof current !== 'undefined' && ['payroll', 'talent-payout-review'].includes(current) && !canOpenView(current, role)) {
        current = 'overview';
        root.history.replaceState({}, '', `${root.location.pathname}#overview`);
      }
    });
    root.addEventListener('soro:admin-payroll-updated', renderCurrentView);
  }

  return Object.freeze({
    ENDPOINT,
    canUse,
    canOpenView,
    normalizeEmployeeReadiness,
    normalizeWorkspace,
    defaultRunDates,
    pageMarkup,
    load,
    reset,
    currentWorkspace: () => workspace
  });
}));
