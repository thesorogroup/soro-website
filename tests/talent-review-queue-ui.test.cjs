const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const modulePath = path.join(root, 'operations', 'talent-review-queue.js');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

const applicantId = '22222222-2222-4222-8222-222222222222';
const ownerId = '33333333-3333-4333-8333-333333333333';
const requestId = '44444444-4444-4444-8444-444444444444';
const updatedAt = '2026-08-30T23:00:00.000Z';

const APPLICANT_KEYS = Object.freeze([
  'applicantId', 'fullName', 'preferredName', 'email', 'applicationReceivedAt',
  'updatedAt', 'stage', 'archived', 'owner', 'resume', 'checklist', 'allowedActions'
]);

function applicant(overrides = {}) {
  return {
    applicantId,
    fullName: 'Santos, Mariel Anne',
    preferredName: 'Mariel',
    email: 'mariel@example.com',
    applicationReceivedAt: '2026-08-30T20:00:00.000Z',
    updatedAt,
    stage: 'submitted',
    archived: false,
    owner: { id: ownerId, name: 'Jordan Reed' },
    resume: { available: true, label: 'Résumé available' },
    checklist: [
      { key: 'core_profile', label: 'Core profile', state: 'complete' },
      { key: 'resume', label: 'Resume', state: 'missing' }
    ],
    allowedActions: ['begin_review', 'request_more_info', 'decline', 'archive'],
    ...overrides
  };
}

function queuePayload(role = 'admin', rows = [applicant()], overrides = {}) {
  return {
    generatedAt: '2026-08-30T23:05:00.000Z',
    viewerRole: role,
    summary: {
      all: rows.length,
      submitted: rows.filter(row => !row.archived && row.stage === 'submitted').length,
      in_review: rows.filter(row => !row.archived && row.stage === 'in_review').length,
      needs_more_info: rows.filter(row => !row.archived && row.stage === 'needs_more_info').length,
      bench_ready: rows.filter(row => !row.archived && row.stage === 'bench_ready').length,
      closed: rows.filter(row => row.archived || row.stage === 'declined').length
    },
    applicants: rows,
    ...overrides
  };
}

function installUi(t, options = {}) {
  const role = options.role || 'admin';
  const responsePayload = options.responsePayload || queuePayload(role);
  const responseStatus = options.responseStatus || 200;
  const keys = [
    'soroCurrentAccess', 'soroSupabase', 'fetch', 'crypto', 'CustomEvent',
    'dispatchEvent', 'addEventListener', 'soroTalentReviewQueue'
  ];
  const previous = new Map(keys.map(key => [key, Object.prototype.hasOwnProperty.call(globalThis, key)
    ? { exists: true, descriptor: Object.getOwnPropertyDescriptor(globalThis, key) }
    : { exists: false }]));
  const calls = [];
  const events = [];
  globalThis.soroCurrentAccess = { role };
  globalThis.soroSupabase = {
    auth: { getSession: async () => ({ data: { session: { access_token: 'signed-in-review-token' } }, error: null }) }
  };
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    writable: true,
    value: { randomUUID: () => requestId }
  });
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
  };
  globalThis.dispatchEvent = event => { events.push(event); return true; };
  globalThis.addEventListener = () => {};
  globalThis.fetch = async (url, requestOptions = {}) => {
    const call = { url: String(url), options: requestOptions };
    calls.push(call);
    const payload = typeof responsePayload === 'function' ? responsePayload(call, calls.length) : responsePayload;
    return {
      ok: responseStatus >= 200 && responseStatus < 300,
      status: responseStatus,
      text: async () => JSON.stringify(payload)
    };
  };
  delete require.cache[require.resolve(modulePath)];
  const ui = require(modulePath);
  t.after(() => {
    ui.unmount({ clear: false });
    delete require.cache[require.resolve(modulePath)];
    for (const [key, state] of previous) {
      if (state.exists) Object.defineProperty(globalThis, key, state.descriptor);
      else delete globalThis[key];
    }
  });
  return { ui, calls, events };
}

test('only the actual Admin and Talent Management roles can open or load the queue', async t => {
  const { ui, calls } = installUi(t, { role: 'sales' });

  assert.equal(ui.canUse('admin'), true);
  assert.equal(ui.canUse('talent_management'), true);
  for (const role of ['sales', 'sales_management', 'billing', 'client_admin', 'client_reviewer', 'client_billing', 'virtual_assistant', '']) {
    assert.equal(ui.canUse(role), false, `${role || 'empty role'} must be denied`);
  }

  await ui.refresh();
  assert.equal(calls.length, 0);
  assert.equal(ui.currentQueue().phase, 'idle');

  globalThis.soroCurrentAccess = { role: 'admin' };
  await ui.refresh();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/.netlify/functions/talent-review-queue');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer signed-in-review-token');
});

test('normalization enforces the server viewer role and an exact public applicant allowlist', t => {
  const { ui } = installUi(t);
  const payload = queuePayload('admin', [applicant({
    organizationId: '55555555-5555-4555-8555-555555555555',
    birthDate: '1998-01-10',
    address: 'Private address',
    statusReason: 'Private internal reason',
    owner: { id: ownerId, name: 'Jordan Reed', email: 'jordan-private@example.com' },
    checklist: [{ key: 'core_profile', label: 'Core profile', state: 'complete', internalProof: 'private' }]
  })]);

  const normalized = ui.normalizePayload(payload, 'admin');
  assert.equal(normalized.phase, 'ready');
  assert.deepEqual(Object.keys(normalized.applicants[0]).sort(), [...APPLICANT_KEYS].sort());
  assert.deepEqual(Object.keys(normalized.applicants[0].owner).sort(), ['id', 'name']);
  assert.deepEqual(Object.keys(normalized.applicants[0].resume).sort(), ['available', 'label']);
  assert.deepEqual(Object.keys(normalized.applicants[0].checklist[0]).sort(), ['key', 'label', 'state']);
  assert.equal(JSON.stringify(normalized).includes('Private address'), false);
  assert.equal(JSON.stringify(normalized).includes('Private internal reason'), false);
  assert.equal(JSON.stringify(normalized).includes('jordan-private@example.com'), false);
  assert.throws(() => ui.normalizePayload(payload, 'talent_management'), /access|role|Talent review/i);
});

test('resume metadata is canonical and never carries a storage path or URL into queue state', t => {
  const { ui } = installUi(t);
  const normalized = ui.normalizePayload(queuePayload('admin', [applicant({
    resume: {
      available: true,
      label: 'private/org/applicant/resume.pdf',
      storagePath: 'private/org/applicant/resume.pdf',
      signedUrl: 'https://storage.example/signed',
      documentId: requestId,
      fileName: 'resume.pdf'
    }
  })]), 'admin');

  assert.deepEqual(normalized.applicants[0].resume, { available: true, label: 'Secure résumé available' });
  assert.doesNotMatch(JSON.stringify(normalized), /private\/org|storage\.example|resume\.pdf|storagePath|signedUrl|documentId|fileName/i);
});

test('a real zero queue stays zero without sample applicants or counts', t => {
  const { ui } = installUi(t, { responsePayload: queuePayload('admin', []) });
  const normalized = ui.normalizePayload(queuePayload('admin', []), 'admin');

  assert.deepEqual(normalized.summary, {
    all: 0, submitted: 0, in_review: 0, needs_more_info: 0, bench_ready: 0, closed: 0
  });
  assert.deepEqual(normalized.applicants, []);
  assert.doesNotMatch(JSON.stringify(normalized), /Mariel|Jordan|sample|demo/i);
});

test('stage and search filters are conjunctive and Closed includes declined or archived records', async t => {
  const rows = [
    applicant(),
    applicant({ applicantId: '55555555-5555-4555-8555-555555555555', fullName: 'Cruz, Alex', preferredName: 'Alex', email: 'alex@example.com', stage: 'in_review', allowedActions: ['request_more_info', 'mark_bench_ready'] }),
    applicant({ applicantId: '66666666-6666-4666-8666-666666666666', fullName: 'Reyes, Casey', email: 'casey@example.com', stage: 'declined', allowedActions: ['reopen', 'archive'] }),
    applicant({ applicantId: '77777777-7777-4777-8777-777777777777', fullName: 'Flores, Jamie', email: 'jamie@example.com', stage: 'needs_more_info', archived: true, allowedActions: ['restore'] })
  ];
  const { ui } = installUi(t, { responsePayload: queuePayload('admin', rows) });
  await ui.refresh();

  ui.setStageFilter('closed');
  assert.deepEqual(ui.visibleApplicants().map(row => row.fullName), ['Reyes, Casey', 'Flores, Jamie']);
  ui.setSearch('jamie');
  assert.deepEqual(ui.visibleApplicants().map(row => row.fullName), ['Flores, Jamie']);
  ui.setStageFilter('in_review');
  assert.deepEqual(ui.visibleApplicants(), []);
  ui.setSearch('alex');
  assert.deepEqual(ui.visibleApplicants().map(row => row.fullName), ['Cruz, Alex']);
});

test('a review action posts only the exact optimistic-concurrency contract', async t => {
  const { ui, calls } = installUi(t);
  await ui.refresh();
  await ui.changeApplicant({ applicantId, expectedUpdatedAt: updatedAt, action: 'begin_review', note: '' });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, '/.netlify/functions/talent-review-queue');
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer signed-in-review-token');
  assert.equal(calls[1].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    requestId,
    applicantId,
    expectedUpdatedAt: updatedAt,
    action: 'begin_review',
    note: ''
  });
});

test('client-chosen roles, stale omission, unavailable actions, and missing required notes fail before POST', async t => {
  const { ui, calls } = installUi(t);
  await ui.refresh();
  const baseline = calls.length;

  await assert.rejects(() => ui.changeApplicant({ applicantId, action: 'begin_review', note: '' }), /incomplete|Refresh/i);
  await assert.rejects(() => ui.changeApplicant({ applicantId, expectedUpdatedAt: updatedAt, action: 'restore', note: '' }), /not currently available/i);
  await assert.rejects(() => ui.changeApplicant({ applicantId, expectedUpdatedAt: updatedAt, action: 'request_more_info', note: '' }), /note/i);
  globalThis.soroCurrentAccess = { role: 'client_admin' };
  await assert.rejects(() => ui.changeApplicant({ applicantId, expectedUpdatedAt: updatedAt, action: 'begin_review', note: '', role: 'admin' }), /Only Admin|Talent Management/i);
  assert.equal(calls.length, baseline);
});

test('the live dashboard metric uses the normalized queue instead of the old sample count', t => {
  const { ui } = installUi(t);
  const queue = ui.normalizePayload(queuePayload('talent_management', [
    applicant(),
    applicant({ applicantId: '55555555-5555-4555-8555-555555555555', fullName: 'Cruz, Alex', stage: 'needs_more_info', archived: false })
  ]), 'talent_management');

  assert.deepEqual(ui.dashboardMetric(['Talent Review Queue', '12', '5 interview ready', ''], 'talent_management', queue), [
    'Talent Review Queue', '2', '1 new · 1 need information', 'warning'
  ]);
  assert.deepEqual(ui.dashboardMetric(['Talent Review Queue', '12', 'sample', ''], 'sales', queue), [
    'Talent Review Queue', '12', 'sample', ''
  ]);
});

test('resume open dispatches only an authorized available applicant id', async t => {
  const missingId = '55555555-5555-4555-8555-555555555555';
  const rows = [
    applicant(),
    applicant({ applicantId: missingId, fullName: 'Cruz, Alex', email: 'alex@example.com', resume: { available: false, label: 'Résumé not attached' } })
  ];
  const { ui, events } = installUi(t, { responsePayload: queuePayload('admin', rows) });
  await ui.refresh();
  events.length = 0;

  assert.equal(ui.openResume(applicantId), true);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'soro:talent-review-open-resume');
  assert.deepEqual(events[0].detail, { applicantId });
  assert.equal(JSON.stringify(events[0]).includes('storage'), false);
  assert.equal(JSON.stringify(events[0]).includes('http'), false);

  assert.equal(ui.openResume(missingId), false);
  assert.equal(ui.openResume('66666666-6666-4666-8666-666666666666'), false);
  globalThis.soroCurrentAccess = { role: 'sales' };
  assert.equal(ui.openResume(applicantId), false);
  assert.equal(events.length, 1);
});

test('the portal opens review resumes only through the same-organization private document flow', () => {
  const operations = read('operations/operations.js');
  const start = operations.indexOf('async function openTalentReviewResume');
  const end = operations.indexOf('async function importDriveFiles', start);
  assert.ok(start >= 0 && end > start, 'the secure review-resume handler must exist in the canonical portal');
  const handler = operations.slice(start, end);

  assert.match(handler, /canOpenForRole\?\.\(actualAuthenticatedRole\(\)\)/);
  assert.match(handler, /organizationId=String\(window\.soroCurrentAccess\?\.organization_id/);
  assert.match(handler, /window\.open\('','_blank'\)/);
  assert.match(handler, /viewer\.opener=null/);
  assert.match(handler, /\.from\('documents'\)/);
  assert.match(handler, /\.select\('storage_path'\)/);
  assert.match(handler, /\.eq\('organization_id',organizationId\)/);
  assert.match(handler, /\.eq\('applicant_id',id\)/);
  assert.match(handler, /\.eq\('document_type','resume'\)/);
  assert.match(handler, /\.neq\('status','rejected'\)/);
  assert.match(handler, /\.not\('storage_path','is',null\)/);
  assert.match(handler, /\.order\('created_at',\{ascending:false\}\)/);
  assert.match(handler, /\.limit\(1\)/);
  assert.match(handler, /storage\.from\('soro-private-documents'\)\.createSignedUrl\(storagePath,60\)/);
  assert.match(handler, /if\(documentError\|\|!storagePath\)throw new Error\('resume_missing'\)/);
  assert.match(handler, /viewer\.close\(\)/);
  assert.match(handler, /A secure resume is not attached to this Talent profile yet/);
  assert.doesNotMatch(handler, /innerHTML|dataset|dispatchEvent|localStorage|sessionStorage|history\.pushState/);
});

test('the canonical portal wires the queue route, profile event, navigation, and live metric opener', () => {
  const html = read('operations/index.html');
  const operations = read('operations/operations.js');
  const source = read('operations/talent-review-queue.js');
  const portalTest = read('tests/portal-workspace-preview.test.cjs');

  assert.ok(html.indexOf('talent-review-queue.js') >= 0 && html.indexOf('talent-review-queue.js') < html.indexOf('operations.js'));
  assert.match(html, /data-view="talent-review"[^>]*>Review Queue</);
  assert.match(operations, /admin\s*:\s*new Set\(\[[^\]]*'talent-review'/);
  assert.match(operations, /talent_management\s*:\s*new Set\(\[[^\]]*'talent-review'/);
  for (const role of ['sales', 'sales_management', 'billing', 'client_admin', 'client_reviewer', 'client_billing', 'virtual_assistant']) {
    const match = operations.match(new RegExp(`${role}\\s*:\\s*new Set\\(\\[([^\\]]*)\\]`, 'i'));
    if (match) assert.doesNotMatch(match[1], /talent-review/);
  }
  assert.match(operations, /soro:talent-review-open-queue/);
  assert.match(operations, /soro:talent-review-open-profile/);
  assert.match(source, /new root\.CustomEvent\('soro:talent-review-open-queue'\)/);
  assert.match(source, /new root\.CustomEvent\('soro:talent-review-open-profile'/);
  assert.match(source, /new root\.CustomEvent\('soro:talent-review-open-resume'/);
  assert.match(source, /data-review-resume="\$\{escapeHtml\(applicant\.applicantId\)\}"/);
  assert.match(source, /available \? '' : ' disabled aria-disabled="true"'/);
  assert.doesNotMatch(source, /storage_path|storagePath|signedUrl|createSignedUrl|soro-private-documents/i);
  assert.match(source, /function dashboardMetric/);
  assert.match(portalTest, /'talent-review'/, 'the exact portal allowlist test must include the new authorized view');
});
