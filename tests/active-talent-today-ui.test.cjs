const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const modulePath = path.join(root, 'operations', 'active-talent-today.js');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

const applicantIds = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444'
];

function row(index, overrides = {}) {
  return {
    applicantId: applicantIds[index],
    fullName: ['Santos, Mariel', 'Ramos, Alex', 'Cruz, Daniel', 'Tan, Arielle'][index],
    preferredName: ['Mariel', 'Alex', 'Daniel', 'Arielle'][index],
    placementId: `${index + 5}5555555-5555-4555-8555-555555555555`,
    clientId: index < 2
      ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    clientName: index < 2 ? 'Brightlane Medical' : 'Haven & Co.',
    ownerName: index % 2 ? 'Morgan Lee' : 'Jordan Reed',
    placementStatus: 'active',
    placementStartDate: '2026-08-01',
    placementEndDate: null,
    scheduleSummary: 'Monday-Friday',
    workDate: '2026-08-30',
    workTimezone: 'Asia/Manila',
    attendanceState: ['started', 'completed', 'not_started', 'needs_review'][index],
    accessState: 'ready',
    startedAt: index < 2 ? '2026-08-29T23:30:00.000Z' : null,
    checkedOutAt: index === 1 ? '2026-08-30T02:30:00.000Z' : null,
    needsAttention: index === 3,
    issueCode: index === 3 ? 'multiple_current_placements' : null,
    ...overrides
  };
}

function payload(overrides = {}) {
  return {
    generatedAt: '2026-08-29T23:45:00.000Z',
    summary: {
      activeTalent: 4,
      checkedInToday: 2,
      workingNow: 1,
      completedToday: 1,
      notStarted: 1,
      needsReview: 1
    },
    rows: [row(0), row(1), row(2), row(3)],
    ...overrides
  };
}

function installUi(t, options = {}) {
  const {
    role = 'admin',
    responsePayload = payload(),
    responseStatus = 200
  } = options;
  const previous = new Map();
  for (const key of ['soroCurrentAccess', 'soroSupabase', 'fetch', 'soroActiveTalentToday']) {
    previous.set(key, Object.prototype.hasOwnProperty.call(globalThis, key)
      ? { exists: true, value: globalThis[key] }
      : { exists: false });
  }
  const calls = [];
  globalThis.soroCurrentAccess = { role };
  globalThis.soroSupabase = {
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'signed-in-management-token' } }, error: null })
    }
  };
  globalThis.fetch = async (url, requestOptions = {}) => {
    calls.push({ url: String(url), options: requestOptions });
    return {
      ok: responseStatus >= 200 && responseStatus < 300,
      status: responseStatus,
      text: async () => JSON.stringify(responsePayload)
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
  });
  return { ui, calls };
}

test('only the actual Admin and Talent Management roles can load the roster', async t => {
  const { ui, calls } = installUi(t);

  assert.equal(ui.canLoadForRole('admin'), true);
  assert.equal(ui.canLoadForRole('talent_management'), true);
  for (const role of ['sales', 'sales_management', 'billing', 'client_admin', 'client_reviewer', 'client_billing', 'virtual_assistant', '']) {
    assert.equal(ui.canLoadForRole(role), false, `${role || 'empty role'} must be denied`);
  }

  globalThis.soroCurrentAccess = { role: 'sales' };
  await ui.load();
  assert.equal(calls.length, 0);
  assert.equal(ui.currentRoster().phase, 'idle');

  globalThis.soroCurrentAccess = { role: 'admin' };
  await ui.load();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/.netlify/functions/active-talent-today');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer signed-in-management-token');
});

test('normalization preserves Talent-local work dates and an open overnight session', t => {
  const { ui } = installUi(t);
  const overnight = payload({
    generatedAt: '2026-08-30T06:30:00.000Z',
    summary: {
      activeTalent: 1,
      checkedInToday: 0,
      workingNow: 1,
      completedToday: 0,
      notStarted: 0,
      needsReview: 1
    },
    rows: [row(0, {
      workDate: '2026-08-29',
      workTimezone: 'America/Chicago',
      startedAt: '2026-08-30T04:45:00.000Z',
      checkedOutAt: null,
      attendanceState: 'started',
      needsAttention: true,
      issueCode: 'open_session_from_prior_date'
    })]
  });

  const normalized = ui.normalizeRoster(overnight);
  assert.equal(normalized.phase, 'ready');
  assert.equal(normalized.summary.workingNow, 1);
  assert.equal(normalized.summary.checkedInToday, 0);
  assert.equal(normalized.rows[0].attendanceState, 'started');
  assert.equal(normalized.rows[0].workDate, '2026-08-29');
  assert.equal(normalized.rows[0].workTimezone, 'America/Chicago');
  assert.equal(normalized.rows[0].checkedOutAt, '');
  assert.equal(normalized.rows[0].issueCode, 'open_session_from_prior_date');
});

test('a stale open overnight session can appear for review without inflating active placement totals', t => {
  const { ui } = installUi(t);
  const staleOpen = payload({
    summary: {
      activeTalent: 0,
      checkedInToday: 0,
      workingNow: 1,
      completedToday: 0,
      notStarted: 0,
      needsReview: 1
    },
    rows: [row(0, {
      placementId: null,
      clientId: null,
      clientName: 'Former client',
      workDate: '2026-08-29',
      attendanceState: 'started',
      needsAttention: true,
      issueCode: 'stale_open_session'
    })]
  });

  const normalized = ui.normalizeRoster(staleOpen);
  assert.equal(normalized.summary.activeTalent, 0);
  assert.equal(normalized.summary.workingNow, 1);
  assert.equal(normalized.rows.length, 1);
  assert.equal(normalized.rows[0].issueCode, 'stale_open_session');
});

test('the live metric is derived from the same summary and a real zero stays zero', t => {
  const { ui } = installUi(t);
  const ready = ui.normalizeRoster(payload());
  assert.deepEqual(ui.dashboardMetric(['fallback'], 'admin', ready), [
    'Active Talent today',
    '4',
    '1 working now · 1 not started · 1 need review',
    'warning'
  ]);

  const zero = ui.normalizeRoster(payload({
    summary: {
      activeTalent: 0,
      checkedInToday: 0,
      workingNow: 0,
      completedToday: 0,
      notStarted: 0,
      needsReview: 0
    },
    rows: []
  }));
  assert.deepEqual(ui.dashboardMetric(['fallback'], 'talent_management', zero), [
    'Active Talent today', '0', 'No current client placements', ''
  ]);
  assert.deepEqual(ui.dashboardMetric(['fallback'], 'sales', ready), ['fallback']);
});

test('status, client, and owner filters combine without mutating the source roster', t => {
  const { ui } = installUi(t);
  const original = ui.normalizeRoster(payload()).rows;

  assert.deepEqual(ui.filterRows(original, {
    status: 'started', client: 'all', owner: 'all'
  }).map(item => item.fullName), ['Santos, Mariel']);

  assert.deepEqual(ui.filterRows(original, {
    status: 'all', client: 'Brightlane Medical', owner: 'all'
  }).map(item => item.fullName), ['Santos, Mariel', 'Ramos, Alex']);

  assert.deepEqual(ui.filterRows(original, {
    status: 'all', client: 'Brightlane Medical', owner: 'Morgan Lee'
  }).map(item => item.fullName), ['Ramos, Alex']);

  assert.deepEqual(ui.filterRows(original, {
    status: 'all', client: 'Haven & Co.', owner: 'Morgan Lee'
  }).map(item => item.fullName), ['Tan, Arielle']);
  assert.equal(original.length, 4);
});

test('extra private fields are discarded and invalid summaries fail closed', t => {
  const { ui } = installUi(t);
  const safe = ui.normalizeRoster(payload({
    rows: [
      row(0, { email: 'private@example.com', phone: '+63 917 555 0100', correctionNote: 'Private note' }),
      row(1), row(2), row(3)
    ]
  }));
  assert.deepEqual(Object.keys(safe.rows[0]).sort(), [...ui.ROW_KEYS].sort());
  assert.equal(JSON.stringify(safe).includes('private@example.com'), false);
  assert.equal(JSON.stringify(safe).includes('Private note'), false);

  assert.throws(() => ui.normalizeRoster(payload({
    summary: { ...payload().summary, activeTalent: 99 }
  })), /totals (?:were invalid|exceeded|did not match)/i);
  assert.throws(() => ui.normalizeRoster(payload({
    summary: { ...payload().summary, workingNow: 99 }
  })), /totals were invalid/i);
});

test('network errors show an unavailable metric and never substitute fake people or counts', async t => {
  const { ui } = installUi(t, {
    responseStatus: 500,
    responsePayload: { message: 'The roster is temporarily unavailable.' }
  });
  await ui.load();
  const failed = ui.currentRoster();

  assert.equal(failed.phase, 'error');
  assert.deepEqual(failed.rows, []);
  assert.deepEqual(ui.dashboardMetric(['fallback'], 'admin', failed), [
    'Active Talent today', '—', 'Roster unavailable · select to retry', 'warning'
  ]);
  assert.doesNotMatch(JSON.stringify(failed), /Mariel|Brightlane|24|22 checked in/i);
});

test('dashboard integration uses actual authorization, opens the live dialog, and removes placeholder behavior', () => {
  const html = read('operations/index.html');
  const operations = read('operations/operations.js');
  const rosterSource = read('operations/active-talent-today.js');

  assert.ok(
    html.indexOf('active-talent-today.js') >= 0
      && html.indexOf('active-talent-today.js') < html.indexOf('operations.js'),
    'the roster module must load before the canonical operations renderer'
  );
  assert.match(html, /id="active-talent-today-dialog"/);
  assert.match(html, /id="active-talent-today-content"/);
  assert.match(operations, /soroActiveTalentToday\.dashboardMetric\(metric,actualAuthenticatedRole\(\)\)/);
  assert.match(operations, /soroActiveTalentToday\?\.bindDashboardMetric\([^;]*currentView:current[^;]*actualRole:actualAuthenticatedRole\(\)/);
  assert.match(operations, /soro:active-talent-open-profile/);
  assert.match(rosterSource, /addEventListener\?\.\('soro-auth-changed', handleAuthChange\)/);
  assert.doesNotMatch(operations, /\['Active Talent today','24','22 checked in'/);
  assert.doesNotMatch(rosterSource, /Open the detailed queue to continue|View recent activity|Alex Ramos|Mariel Santos/);
  assert.match(rosterSource, /Loading the live Active Talent roster/);
  assert.match(rosterSource, /Roster unavailable/);
  assert.match(rosterSource, /No Talent members match these filters/);
  assert.match(rosterSource, /Attendance is a presence record, not a productivity or payroll measure/);
  assert.match(rosterSource, /data-active-talent-profile/);
  assert.match(rosterSource, /soro:active-talent-open-profile/);
});

test('Admin preview state cannot grant roster access to another authenticated role', () => {
  const operations = read('operations/operations.js');
  const rosterSource = read('operations/active-talent-today.js');

  assert.match(operations, /function actualAuthenticatedRole\(/);
  assert.match(operations, /function effectiveWorkspaceRole\(/);
  assert.match(rosterSource, /const AUTHORIZED_ROLES = new Set\(\['admin', 'talent_management'\]\)/);
  assert.match(rosterSource, /function actualRole\([^)]*soroCurrentAccess/);
  assert.match(rosterSource, /function canUse\([^)]*actualRole\(\)/);
  assert.doesNotMatch(rosterSource, /effectiveWorkspaceRole|workspacePreviewAccessRole|currentAuthenticatedRole/);
  assert.match(rosterSource, /bindDashboardMetric\([^)]*actualRole/);
});
