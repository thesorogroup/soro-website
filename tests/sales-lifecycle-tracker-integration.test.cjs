const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const project = path.resolve(__dirname, '..');
const controller = fs.readFileSync(path.join(project, 'operations/operations.js'), 'utf8');
const trackerSource = fs.readFileSync(path.join(project, 'operations/sales-lifecycle-tracker.js'), 'utf8');
const tracker = require('../operations/sales-lifecycle-tracker.js');
const requestId = '20000000-0000-4000-8000-000000000001';
const clientId = '20000000-0000-4000-8000-000000000002';

function functionSource(name) {
  const start = controller.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const end = controller.indexOf('\nfunction ', start + 1);
  assert.ok(end > start, `${name} must end before the next function`);
  return controller.slice(start, end);
}
function context(options = {}) {
  const mounts = [], actions = [], navigations = [], hubMounts = [], requests = [];
  const node = { innerHTML: '', addEventListener() {}, removeEventListener() {}, querySelector() { return null; } };
  const sandbox = {
    console, Intl, Date, Set, Map, AbortController,
    current: options.view || 'overview', role: options.workspaceRole || 'sales',
    selectedClientId: null, selectedTalentId: 'old-talent',
    currentAuthenticatedRole: () => options.effectiveRole || 'sales',
    adminPreviewingNonAdminWorkspace: () => Boolean(options.preview),
    lifecyclePreviewIds: { client: clientId, request: requestId, salesOwner: '30000000-0000-4000-8000-000000000001' },
    root: { querySelector: () => node }, location: { pathname: '/operations/' },
    history: { state: null, pushState(state, title, url) { this.state = state; navigations.push({ state, url }); } },
    setActive() {}, render() {},
    CustomEvent: class { constructor(type, { detail }) { this.type = type; this.detail = detail; } },
    SoroSalesLifecycleTracker: { mount(target, config) { mounts.push({ target, config }); } },
    SoroClientWorkflow: { canOpenForRole: role => ['sales', 'sales_management', 'admin'].includes(role), mount(target, config) { hubMounts.push({ target, config }); } },
    clientWorkflowMountOptions: role => ({ role }),
    dispatchEvent(event) { actions.push(event); }, addEventListener() {}, removeEventListener() {},
    soroCurrentAccess: { role: options.effectiveRole || 'sales' },
    soroSupabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'server-scoped-test-session' } } }) } },
    fetch: async (url, init) => { requests.push({ url, init }); return { ok: true, text: async () => JSON.stringify({ generatedAt: new Date().toISOString(), viewerRole: options.effectiveRole || 'sales', rows: [] }) }; }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const functions = ['salesTrackerPreviewWorkspace', 'openSalesTrackerAction', 'openSalesTrackerClient', 'mountSalesTracker'];
  vm.runInContext(functions.map(functionSource).join('\n'), sandbox);
  return { sandbox, mounts, actions, navigations, node, hubMounts, requests };
}

test('production loads tracker style and module before the Operations controller', () => {
  const html = fs.readFileSync(path.join(project, 'operations/index.html'), 'utf8');
  const controllerAt = html.indexOf('src="operations.js?');
  for (const file of ['sales-lifecycle-tracker.css?', 'sales-lifecycle-tracker.js?']) {
    const index = html.indexOf(file);
    assert.ok(index >= 0 && index < controllerAt, `${file} must load before controller`);
  }
});

test('shell mounts the tracker only in a Sales overview with an eligible effective role', () => {
  for (const effectiveRole of ['sales', 'sales_management']) {
    const run = context({ effectiveRole });
    run.sandbox.mountSalesTracker();
    assert.equal(run.mounts.length, 1);
    assert.equal(run.mounts[0].config.role, effectiveRole);
    assert.equal(run.mounts[0].config.loader, undefined);
  }
  for (const options of [{ view: 'clients' }, { view: 'tasks' }, { workspaceRole: 'admin', effectiveRole: 'admin' }, { workspaceRole: 'talent', effectiveRole: 'talent_management' }, { effectiveRole: 'client_admin' }, { effectiveRole: 'virtual_assistant' }]) {
    const run = context(options);
    run.sandbox.mountSalesTracker();
    assert.equal(run.mounts.length, 0, JSON.stringify(options));
  }
});

test('Admin-as-Sales preview preserves its isolated loader without fictional client records', async () => {
  const run = context({ preview: true });
  run.sandbox.mountSalesTracker();
  const config = run.mounts[0].config;
  assert.equal(config.preview, true);
  assert.equal(typeof config.loader, 'function');
  const sample = await config.loader();
  const normalized = tracker.normalizeWorkspace(sample, 'sales');
  assert.equal(normalized.rows.length, 0);
  for (const row of normalized.rows) for (const key of ['seatCount', 'candidateCount', 'interviewCount', 'placementCount', 'activePlacementCount', 'onboardingCount']) assert.equal(Number.isInteger(row[key]), true, key);
});

test('each next action opens the existing workflow with its original request id', () => {
  const run = context();
  const mapping = { find_candidates: 'find_talent', review_shortlist: 'shortlist', manage_interviews: 'interview', review_selection: 'selection', prepare_handoff: 'placement', view_onboarding: 'onboarding', view_placement: 'placement' };
  for (const [nextAction, action] of Object.entries(mapping)) {
    run.sandbox.openSalesTrackerAction({ clientId, requestId, nextAction });
    const event = run.actions.at(-1);
    assert.equal(event.type, 'soro:client-workflow-action');
    assert.equal(event.detail.action, action);
    assert.equal(event.detail.requestId, requestId);
  }
  assert.equal(run.actions.length, Object.keys(mapping).length);
  run.sandbox.openSalesTrackerAction({ clientId, requestId, nextAction: 'delete_everything' });
  assert.equal(run.actions.length, Object.keys(mapping).length);
  for (const effectiveRole of ['admin', 'talent_management', 'client_admin', 'virtual_assistant']) {
    const denied = context({ effectiveRole });
    denied.sandbox.openSalesTrackerAction({ clientId, requestId, nextAction: 'find_candidates' });
    assert.equal(denied.actions.length, 0);
  }
});

test('client setup and client-name selection both open the existing Client Hub with the selected client', () => {
  for (const action of ['client_setup', 'client_click']) {
    const run = context();
    if (action === 'client_setup') run.sandbox.openSalesTrackerAction({ clientId, requestId, nextAction: action });
    else run.sandbox.openSalesTrackerClient({ clientId, requestId });
    assert.equal(run.sandbox.current, 'clients');
    assert.equal(run.sandbox.selectedClientId, clientId);
    assert.equal(run.sandbox.selectedTalentId, null);
    assert.equal(run.navigations[0].url, '/operations/#clients');
    assert.equal(run.navigations[0].state.clientHubId, clientId);
    const start = controller.indexOf("  if(current==='clients'&&window.SoroClientWorkflow");
    const end = controller.indexOf("  if(current==='talent-profile')", start);
    assert.ok(start >= 0 && end > start);
    vm.runInContext(`function mountExistingClientHub(){${controller.slice(start, end)}};mountExistingClientHub();`, run.sandbox);
    assert.equal(run.hubMounts.length, 1);
    assert.equal(run.hubMounts[0].config.clientId, clientId);
    assert.equal(run.hubMounts[0].config.role, 'sales');
  }
  const invalid = context();
  invalid.sandbox.openSalesTrackerClient({ clientId: 'invalid' });
  assert.equal(invalid.navigations.length, 0);
});

test('real shell mounting loads server-scoped data without role, client or owner request parameters', async () => {
  const run = context({ effectiveRole: 'sales_management' });
  vm.runInContext(trackerSource, run.sandbox);
  run.sandbox.mountSalesTracker();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(run.requests.length, 1);
  const request = run.requests[0];
  assert.equal(request.url, '/.netlify/functions/sales-lifecycle-tracker');
  assert.equal(request.init.method, 'GET');
  assert.equal(request.init.body, undefined);
  assert.equal(request.init.headers.Authorization, 'Bearer server-scoped-test-session');
  assert.deepEqual(Object.keys(request.init.headers).sort(), ['Accept', 'Authorization']);
  assert.match(run.node.innerHTML, /No hiring requests yet/);
  run.sandbox.SoroSalesLifecycleTracker.unmount();
});
