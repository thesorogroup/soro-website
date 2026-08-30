const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const modulePath = path.join(root, 'operations', 'talent-time-off.js');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

const applicantId = '22222222-2222-4222-8222-222222222222';
const placementId = '33333333-3333-4333-8333-333333333333';
const timeOffRequestId = '44444444-4444-4444-8444-444444444444';
const operationRequestId = '55555555-5555-4555-8555-555555555555';

const REQUEST_KEYS = Object.freeze([
  'timeOffRequestId',
  'applicantId',
  'applicantName',
  'placementId',
  'clientName',
  'startDate',
  'endDate',
  'workTimezone',
  'status',
  'note',
  'submittedAt',
  'decidedAt',
  'decisionNote',
  'canCancel'
]);

function requestRow(overrides = {}) {
  return {
    timeOffRequestId,
    applicantId,
    applicantName: 'Mariel Santos',
    placementId,
    clientName: 'Brightlane Medical',
    startDate: '2026-09-03',
    endDate: '2026-09-04',
    workTimezone: 'Asia/Manila',
    status: 'pending',
    note: 'Family appointment',
    submittedAt: '2026-08-29T20:00:00.000Z',
    decidedAt: null,
    decisionNote: null,
    canCancel: true,
    ...overrides
  };
}

function talentPayload(overrides = {}) {
  return {
    generatedAt: '2026-08-29T20:05:00.000Z',
    viewerRole: 'virtual_assistant',
    eligibility: {
      eligible: true,
      state: 'eligible',
      placementId,
      clientName: 'Brightlane Medical',
      workTimezone: 'Asia/Manila',
      minStartDate: '2026-08-30'
    },
    requests: [requestRow()],
    ...overrides
  };
}

function managementPayload(role = 'admin', overrides = {}) {
  return {
    generatedAt: '2026-08-29T20:05:00.000Z',
    viewerRole: role,
    eligibility: null,
    requests: [requestRow()],
    ...overrides
  };
}

function installUi(t, options = {}) {
  const {
    role = 'virtual_assistant',
    responsePayload = role === 'virtual_assistant' ? talentPayload() : managementPayload(role),
    responseStatus = 200
  } = options;
  const keys = ['soroCurrentAccess', 'soroSupabase', 'fetch', 'soroTalentTimeOff'];
  const previous = new Map(keys.map(key => [key, Object.prototype.hasOwnProperty.call(globalThis, key)
    ? { exists: true, value: globalThis[key] }
    : { exists: false }]));
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const calls = [];
  globalThis.soroCurrentAccess = { role };
  globalThis.soroSupabase = {
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'signed-in-token' } }, error: null })
    }
  };
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    writable: true,
    value: { randomUUID: () => operationRequestId }
  });
  globalThis.fetch = async (url, requestOptions = {}) => {
    calls.push({ url: String(url), options: requestOptions });
    return {
      ok: responseStatus >= 200 && responseStatus < 300,
      status: responseStatus,
      text: async () => JSON.stringify(typeof responsePayload === 'function'
        ? responsePayload(calls.at(-1))
        : responsePayload)
    };
  };
  delete require.cache[require.resolve(modulePath)];
  const ui = require(modulePath);
  t.after(() => {
    ui.reset({ silent: true });
    delete require.cache[require.resolve(modulePath)];
    for (const [key, state] of previous) {
      if (state.exists) globalThis[key] = state.value;
      else delete globalThis[key];
    }
    if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
    else delete globalThis.crypto;
  });
  return { ui, calls };
}

test('only actual Talent, Admin, and Talent Management roles can load their respective workflow view', async t => {
  const { ui, calls } = installUi(t);

  assert.equal(ui.canLoadForRole('virtual_assistant'), true);
  assert.equal(ui.canLoadForRole('admin'), true);
  assert.equal(ui.canLoadForRole('talent_management'), true);
  for (const role of ['sales', 'sales_management', 'billing', 'client_admin', 'client_reviewer', 'client_billing', '']) {
    assert.equal(ui.canLoadForRole(role), false, `${role || 'empty role'} must be denied`);
  }

  globalThis.soroCurrentAccess = { role: 'sales' };
  await ui.load();
  assert.equal(calls.length, 0);
  assert.equal(ui.currentPortal().phase, 'idle');

  globalThis.soroCurrentAccess = { role: 'virtual_assistant' };
  await ui.load();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/.netlify/functions/talent-time-off');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer signed-in-token');
});

test('normalization requires the server-derived actual viewer role and discards unknown private fields', t => {
  const { ui } = installUi(t);
  const payload = talentPayload({
    organizationId: '66666666-6666-4666-8666-666666666666',
    eligibility: { ...talentPayload().eligibility, authUserId: applicantId },
    requests: [requestRow({
      email: 'private@example.com',
      medicalReason: 'Private health detail',
      proofUrl: 'https://private.example/proof',
      operationRequestId
    })]
  });

  const normalized = ui.normalizePortal(payload, 'virtual_assistant');
  assert.equal(normalized.phase, 'ready');
  assert.equal(normalized.viewerRole, 'virtual_assistant');
  assert.equal(normalized.eligibility.placementId, placementId);
  assert.deepEqual(Object.keys(normalized.requests[0]).sort(), [...REQUEST_KEYS].sort());
  assert.equal(JSON.stringify(normalized).includes('private@example.com'), false);
  assert.equal(JSON.stringify(normalized).includes('Private health detail'), false);
  assert.equal(JSON.stringify(normalized).includes(operationRequestId), false);

  assert.throws(() => ui.normalizePortal(payload, 'admin'), /role|viewer|access/i);
  assert.throws(() => ui.normalizePortal(managementPayload('admin'), 'talent_management'), /role|viewer|access/i);
  assert.throws(() => ui.normalizePortal({ ...payload, eligibility: null }, 'virtual_assistant'), /eligib|Talent/i);
});

test('Request Time Off appears only on the real Talent dashboard with one eligible current placement', t => {
  const { ui } = installUi(t);
  const portal = ui.normalizePortal(talentPayload(), 'virtual_assistant');
  const markup = ui.actionMarkup({ currentView: 'overview', actualRole: 'virtual_assistant', portal });

  assert.match(markup, /data-time-off-open="talent"/);
  assert.match(markup, />Request Time Off</);
  assert.equal((markup.match(/<button\b/g) || []).length, 1);

  for (const currentView of ['tasks', 'documents', 'talent-my-profile']) {
    assert.equal(ui.actionMarkup({ currentView, actualRole: 'virtual_assistant', portal }), '');
  }
  for (const actualRole of ['admin', 'talent_management', 'sales', 'client_admin', '']) {
    assert.equal(ui.actionMarkup({ currentView: 'overview', actualRole, portal }), '');
  }
  for (const state of ['unmatched', 'not_yet_available', 'needs_review']) {
    const ineligible = ui.normalizePortal(talentPayload({
      eligibility: { ...talentPayload().eligibility, eligible: false, state, placementId: null }
    }), 'virtual_assistant');
    assert.equal(ui.actionMarkup({ currentView: 'overview', actualRole: 'virtual_assistant', portal: ineligible }), '');
  }
});

test('management review opens only for the actual Admin and Talent Management roles', t => {
  const { ui } = installUi(t, { role: 'admin', responsePayload: managementPayload('admin') });
  const portal = ui.normalizePortal(managementPayload('admin'), 'admin');

  const markup = ui.managementActionMarkup({ currentView: 'overview', actualRole: 'admin', portal });
  assert.match(markup, /data-time-off-open="management"/);
  assert.match(markup, /Time Off Requests/);
  for (const actualRole of ['virtual_assistant', 'sales', 'client_admin', 'billing']) {
    assert.equal(ui.managementActionMarkup({ currentView: 'overview', actualRole, portal }), '');
  }
  assert.equal(ui.managementActionMarkup({
    currentView: 'overview',
    actualRole: 'talent_management',
    portal: ui.normalizePortal(managementPayload('talent_management'), 'talent_management')
  }), '', 'an Admin workspace preview must not gain Talent Management authority');
  assert.equal(ui.managementActionMarkup({ currentView: 'tasks', actualRole: 'admin', portal }), '');
});

test('a real Talent Management account receives the management queue action', t => {
  const { ui } = installUi(t, {
    role: 'talent_management',
    responsePayload: managementPayload('talent_management')
  });
  const portal = ui.normalizePortal(managementPayload('talent_management'), 'talent_management');
  const markup = ui.managementActionMarkup({ currentView: 'overview', actualRole: 'talent_management', portal });
  assert.match(markup, /data-time-off-open="management"/);
  assert.match(markup, /Time Off Requests/);
});

test('status filtering supports real request history without mutating source rows', t => {
  const { ui } = installUi(t);
  const rows = [
    requestRow(),
    requestRow({ timeOffRequestId: '77777777-7777-4777-8777-777777777777', status: 'approved', canCancel: true }),
    requestRow({ timeOffRequestId: '88888888-8888-4888-8888-888888888888', status: 'declined', canCancel: false }),
    requestRow({ timeOffRequestId: '99999999-9999-4999-8999-999999999999', status: 'cancelled', canCancel: false })
  ];

  assert.deepEqual(ui.filterRequests(rows, { status: 'pending' }).map(row => row.status), ['pending']);
  assert.deepEqual(ui.filterRequests(rows, { status: 'approved' }).map(row => row.status), ['approved']);
  assert.deepEqual(ui.filterRequests(rows, { status: 'declined' }).map(row => row.status), ['declined']);
  assert.deepEqual(ui.filterRequests(rows, { status: 'cancelled' }).map(row => row.status), ['cancelled']);
  assert.equal(ui.filterRequests(rows, { status: 'all' }).length, 4);
  assert.equal(rows.length, 4);
});

test('Talent submission posts only the full-day range, optional note, and a secure idempotency id', async t => {
  const { ui, calls } = installUi(t);
  await ui.load();
  await ui.submitRequest({ startDate: '2026-09-03', endDate: '2026-09-04', note: 'Family appointment' });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, '/.netlify/functions/talent-time-off');
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer signed-in-token');
  assert.equal(calls[1].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    action: 'submit',
    requestId: operationRequestId,
    startDate: '2026-09-03',
    endDate: '2026-09-04',
    note: 'Family appointment'
  });
});

test('Talent cancellation and management decisions post exact action-specific bodies', async t => {
  const talent = installUi(t);
  await talent.ui.load();
  await talent.ui.cancelRequest(timeOffRequestId);
  assert.deepEqual(JSON.parse(talent.calls[1].options.body), {
    action: 'cancel',
    requestId: operationRequestId,
    timeOffRequestId
  });

  const manager = installUi(t, { role: 'admin', responsePayload: managementPayload('admin') });
  await manager.ui.load();
  await manager.ui.decideRequest('approve', timeOffRequestId, '');
  await manager.ui.decideRequest('decline', timeOffRequestId, 'Coverage is unavailable.');
  assert.deepEqual(JSON.parse(manager.calls[1].options.body), {
    action: 'approve',
    requestId: operationRequestId,
    timeOffRequestId,
    note: ''
  });
  assert.deepEqual(JSON.parse(manager.calls[2].options.body), {
    action: 'decline',
    requestId: operationRequestId,
    timeOffRequestId,
    note: 'Coverage is unavailable.'
  });
});

test('actions fail closed for wrong roles, ineligible Talent, and non-cancellable records without making requests', async t => {
  const { ui, calls } = installUi(t);
  await ui.load();
  const baseline = calls.length;

  globalThis.soroCurrentAccess = { role: 'sales' };
  await ui.submitRequest({ startDate: '2026-09-03', endDate: '2026-09-04', note: '' });
  await ui.cancelRequest(timeOffRequestId);
  await ui.decideRequest('approve', timeOffRequestId, '');
  assert.equal(calls.length, baseline);
});

test('index and canonical renderer wire real dialogs and actual-role actions without preview escalation', () => {
  const html = read('operations/index.html');
  const operations = read('operations/operations.js');
  const source = read('operations/talent-time-off.js');

  assert.ok(
    html.indexOf('talent-time-off.js') >= 0
      && html.indexOf('talent-time-off.js') < html.indexOf('operations.js'),
    'time-off module must load before the canonical operations renderer'
  );
  assert.match(html, /id="talent-time-off-dialog"/);
  assert.match(html, /id="talent-time-off-content"/);
  assert.match(html, /id="time-off-management-dialog"/);
  assert.match(html, /id="time-off-management-content"/);
  assert.match(operations, /soroTalentTimeOff\?\.actionMarkup\([^;]*currentView:current[^;]*actualRole:actualAuthenticatedRole\(\)/);
  assert.match(operations, /soroTalentTimeOff\?\.(?:managementActionMarkup|dashboardManagementMarkup)\([^;]*currentView:current[^;]*actualRole:actualAuthenticatedRole\(\)/);
  assert.match(operations, /soroTalentTimeOff\?\.bindDashboardActions\([^;]*actualRole:actualAuthenticatedRole\(\)/);
  assert.match(operations, /soro:talent-time-off-updated/);
  assert.match(operations, /managementTimeOffAction=role===['"]admin['"]\|\|role===['"]talent['"]/);
  assert.match(source, /const TALENT_ROLE\s*=\s*['"]virtual_assistant['"]/);
  assert.match(source, /const MANAGEMENT_ROLES\s*=\s*(?:Object\.freeze\()?\[['"]admin['"],\s*['"]talent_management['"]\]\)?/);
  assert.match(source, /function actualRole\([^)]*soroCurrentAccess/);
  assert.doesNotMatch(source, /effectiveWorkspaceRole|workspacePreviewAccessRole|currentAuthenticatedRole/);
});

test('Talent placeholders and staff-only notifications do not leak into the real Talent Portal', () => {
  const operations = read('operations/operations.js');
  const html = read('operations/index.html');
  const source = read('operations/talent-time-off.js');

  assert.match(operations, /notificationsButton\.hidden\s*=\s*clientPortal\s*\|\|\s*accessRole===['"]virtual_assistant['"]/);
  assert.match(operations, /const talentSafeViewData\s*=\s*Object\.freeze\(/);
  assert.match(operations, /talentSafeViewData[\s\S]*tasks\s*:\s*\{[\s\S]*rows\s*:\s*\[\]/);
  assert.match(operations, /talentSafeViewData[\s\S]*documents\s*:\s*\{[\s\S]*rows\s*:\s*\[\]/);
  assert.match(operations, /if\(actualAuthenticatedRole\(\)===['"]virtual_assistant['"]\)return talentSafeViewData\[view\]\|\|viewData/);
  assert.doesNotMatch(source, /Alex Ramos|Mariel Santos|2 time-off requests|Approve time-off request|sample|demo/i);
  assert.match(source, /No time-off requests|Request Time Off/);
  assert.doesNotMatch(html, /data-time-off[^>]*>[^<]*(?:Approve|Pending)[^<]*</i);
});

test('labels describe schedule availability and never promise paid leave or attendance effects', () => {
  const source = read('operations/talent-time-off.js');

  for (const label of ['Request Time Off', 'Pending review', 'Approved', 'Not approved', 'Cancelled']) {
    assert.match(source, new RegExp(label, 'i'));
  }
  assert.doesNotMatch(source, /\bPTO\b|paid leave|sick leave|accrual|payroll|automatically (?:updates?|changes?) attendance/i);
  assert.match(source, /does not (?:automatically )?(?:change|update|affect)[^.;]*(?:attendance|pay|billing)/i);
  assert.match(source, /eligibility\?\.state\s*===\s*['"]needs_review['"]/);
});
