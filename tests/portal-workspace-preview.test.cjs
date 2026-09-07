const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const clientWorkflow = require('../operations/client-workflow.js');
const placementWorkflow = require('../operations/client-placement-workflow.js');
const shortlistWorkflow = require('../operations/client-shortlist-workflow.js');

function operationElement(id = '') {
  const listeners = new Map();
  return {
    id,
    dataset: {},
    hidden: false,
    innerHTML: '',
    textContent: '',
    value: '',
    className: '',
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(type, listener) {
      const entries = listeners.get(type) || [];
      entries.push(listener);
      listeners.set(type, entries);
    },
    dispatch(type, event) { for (const listener of listeners.get(type) || []) listener(event); },
    append() {},
    appendChild() {},
    close() {},
    closest() { return this; },
    focus() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    remove() {},
    removeEventListener(type, listener) { listeners.set(type, (listeners.get(type) || []).filter(entry => entry !== listener)); },
    replaceChildren() { this.innerHTML = ''; },
    setAttribute() {},
    showModal() {}
  };
}

function loadOperationsController() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, operationElement(id));
    return elements.get(id);
  };
  const body = operationElement('body');
  const profileName = operationElement('profile-name');
  const sidebar = operationElement('sidebar');
  const document = {
    body,
    createElement: tag => operationElement(tag),
    getElementById: element,
    querySelector(selector) {
      if (selector === '.profile strong') return profileName;
      if (selector === '.sidebar') return sidebar;
      return null;
    },
    querySelectorAll() { return []; }
  };
  const listeners = new Map();
  class CustomEvent {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
  }
  const calls = {
    fetch: 0,
    session: 0,
    internalClientProfile: 0,
    readOnlyTalentProfile: 0,
    localClientMounts: [],
    shortlistMounts: [],
    placementMounts: [],
    history: []
  };
  const location = { hash: '', pathname: '/operations/' };
  const history = {
    pushState(state, unused, url) { calls.history.push({ method: 'push', state, url }); location.hash = String(url).includes('#') ? String(url).slice(String(url).indexOf('#')) : ''; },
    replaceState(state, unused, url) { calls.history.push({ method: 'replace', state, url }); location.hash = String(url).includes('#') ? String(url).slice(String(url).indexOf('#')) : ''; }
  };
  const window = {
    CustomEvent,
    document,
    history,
    location,
    soroCurrentAccess: { role: 'admin', user_id: 'admin-user', organization_id: 'org-one' },
    soroSupabase: { auth: { async getSession() { calls.session += 1; return { data: { session: { access_token: 'admin-token' } } }; } } },
    SoroGlobalSearch: { init(config) { calls.searchConfig = config; }, refreshRole() {} },
    SoroClientWorkflow: {
      canOpenForRole: clientWorkflow.canOpenForRole,
      createApprovalAdapter: clientWorkflow.createApprovalAdapter,
      defaultSeed: clientWorkflow.defaultSeed,
      mount(target, options) { calls.localClientMounts.push({ target, options }); return true; },
      unmount() {}
    },
    SoroInternalClientProfile: { load() { calls.internalClientProfile += 1; }, unmount() {} },
    SoroReadOnlyTalentProfile: { canOpenForRole() { return true; }, mount() { calls.readOnlyTalentProfile += 1; }, reset() {} },
    soroClientShortlistWorkflow: {
      canOpenForRole() { return true; },
      mount(target, options) { calls.shortlistMounts.push({ target, options }); return true; },
      unmount() {}
    },
    SoroClientPlacementWorkflow: {
      canOpenForRole: placementWorkflow.canOpenForRole,
      createApprovalAdapter(seed) { return { kind: 'approval', seed }; },
      defaultSeed: placementWorkflow.defaultSeed,
      mount(target, options) { calls.placementMounts.push({ target, options }); return true; },
      unmount() {}
    },
    addEventListener(type, listener) {
      const entries = listeners.get(type) || [];
      entries.push(listener);
      listeners.set(type, entries);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) listener.call(window, event);
      return true;
    }
  };
  window.window = window;
  const fetch = async () => { calls.fetch += 1; throw new Error('A role preview must not use live network data.'); };
  window.fetch = fetch;
  const context = vm.createContext({
    AbortController, CustomEvent, Date, FormData: class FormData {}, Intl, JSON, Math, Promise, URL,
    clearTimeout() {}, console, document, fetch, history, location,
    MutationObserver: class MutationObserver { observe() {} disconnect() {} },
    navigator: {}, setTimeout() { return 1; }, window
  });
  const source = `${read('operations/operations.js')}\nwindow.__operationsTest=Object.freeze({applyRole,openClientPlacementWorkflow,openClientProfile,openTalentProfile,searchOperationsRecords,state:()=>({current,preferredHiringRequestId,role})});`;
  vm.runInContext(source, context, { filename: 'operations.js' });
  return { api: window.__operationsTest, calls, elements, window };
}

function clientHubTarget() {
  const target = operationElement('client-hub');
  target.nextButtons = [];
  target.querySelectorAll = selector => {
    if (selector !== '[data-client-workflow-next]') return [];
    target.nextButtons = [...target.innerHTML.matchAll(/data-client-workflow-next="([^"]+)"[^>]*data-request-id="([^"]+)"/g)].map(match => {
      const button = operationElement('client-next');
      button.dataset.clientWorkflowNext = match[1];
      button.dataset.requestId = match[2];
      button.addEventListener = (type, listener) => { if (type === 'click') button.click = listener; };
      return button;
    });
    return target.nextButtons;
  };
  return target;
}

function roleViews(source, accessRole) {
  const match = source.match(new RegExp(`\\b${accessRole}\\s*:\\s*new Set\\(\\[([^\\]]*)\\]\\)`, 'i'));
  assert.ok(match, `${accessRole} must have an explicit view allowlist.`);
  return [...match[1].matchAll(/['"]([a-z-]+)['"]/g)].map(item => item[1]);
}

function routeBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `Missing route marker: ${startMarker}`);
  assert.ok(end > start, `Missing route boundary: ${endMarker}`);
  return source.slice(start, end);
}

test('workspace picker uses the approved five portal names', () => {
  const html = read('operations/index.html');
  const operations = read('operations/operations.js');

  for (const label of ['Admin Panel', 'Sales Panel', 'Talent Management Panel', 'Client Portal', 'Talent Portal']) {
    assert.match(html, new RegExp(`<strong>${label.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}</strong>`));
  }
  assert.doesNotMatch(html, /<strong>Talent Panel<\/strong>|<strong>Virtual Assistant Portal<\/strong>/);
  assert.match(operations, /talent:\{title:'Talent Management Panel'/);
  assert.match(operations, /va:\{title:'Talent Portal'/);
  assert.match(operations, /workspaceName=\{admin:'Admin Panel',sales:'Sales Panel',talent:'Talent Management Panel',client:'Client Portal',va:'Talent Portal'\}\[role\]/);
  assert.doesNotMatch(operations, /role==='talent'\?'Talent Panel'|Virtual Assistant Portal/);
});

test('Admin workspace previews map all five choices to the real role navigation', () => {
  const source = read('operations/operations.js');
  const expectedRoleMap = {
    admin: 'admin',
    sales: 'sales',
    talent: 'talent_management',
    client: 'client_admin',
    va: 'virtual_assistant'
  };

  for (const [workspace, accessRole] of Object.entries(expectedRoleMap)) {
    assert.match(source, new RegExp(`\\b${workspace}\\s*:\\s*['"]${accessRole}['"]`), `${workspace} must preview ${accessRole}.`);
  }

  assert.deepEqual(roleViews(source, 'admin'), ['overview', 'tasks', 'clients', 'client-shortlists', 'client-placement', 'vas', 'available-talent', 'talent-review', 'talent-profile', 'placements', 'documents', 'reports', 'employees', 'payroll', 'help']);
  assert.deepEqual(roleViews(source, 'sales'), ['overview', 'tasks', 'clients', 'client-shortlists', 'client-placement', 'available-talent', 'talent-profile', 'placements', 'reports', 'help']);
  assert.deepEqual(roleViews(source, 'talent_management'), ['overview', 'tasks', 'clients', 'client-placement', 'vas', 'available-talent', 'talent-review', 'talent-profile', 'placements', 'documents', 'reports', 'talent-payout-review', 'help']);
  assert.deepEqual(roleViews(source, 'client_admin'), ['overview', 'client-candidate-review', 'client-placement', 'client-talent-profile', 'my-profile', 'help']);
  assert.deepEqual(roleViews(source, 'virtual_assistant'), ['overview', 'talent-my-profile', 'documents', 'help']);
  assert.deepEqual(roleViews(source, 'billing'), ['overview', 'tasks', 'placements', 'documents', 'reports', 'help']);

  assert.match(source, /function actualAuthenticatedRole\(access=window\.soroCurrentAccess\)\{return String\(access\?\.role\|\|''\)\.toLowerCase\(\)\}/);
  assert.match(source, /function effectiveWorkspaceRole\([^)]*\)[\s\S]*actualAuthenticatedRole\(access\)[\s\S]*workspacePreviewAccessRole\[role\]/);
  assert.match(source, /function currentAuthenticatedRole\(\)\{return effectiveWorkspaceRole\(\)\}/);
  assert.match(source, /function syncAuthorizedNavigation\([^)]*\)\{\s*const accessRole=effectiveWorkspaceRole\(access\)/);
  assert.match(source, /function applyRole\([^)]*\)[\s\S]*actualAuthenticatedRole\(\)!==['"]admin['"][\s\S]*syncAuthorizedNavigation\(\)[\s\S]*render\(\)/);
  assert.match(source, /profileButton\?\.dataset\.authenticatedRoleLabel/);
  assert.match(source, /profileButton\?\.dataset\.authenticatedName/);
  assert.match(read('operations/auth.js'), /profile\.dataset\.authenticatedRoleLabel\s*=\s*roleLabelForAccess\(access\)/);
});

test('Admin non-Admin lifecycle previews use local adapters while signed-in roles keep live transports', () => {
  const operations = read('operations/operations.js');
  const clientWorkflow = read('operations/client-workflow.js');
  const shortlist = read('operations/client-shortlist-workflow.js');
  const bench = read('operations/available-talent-bench.js');
  const availableRoute = routeBlock(operations, "if(current==='available-talent')", "if(current==='client-shortlists')");
  const salesShortlistRoute = routeBlock(operations, "if(current==='client-shortlists')", "if(current==='client-candidate-review')");
  const clientReviewRoute = routeBlock(operations, "if(current==='client-candidate-review')", "if(current==='client-placement')");
  const clientsRoute = routeBlock(operations, "if(current==='clients'", "if(current==='talent-profile')");

  assert.match(operations, /function adminPreviewingNonAdminWorkspace\(\)\{return actualAuthenticatedRole\(\)===['"]admin['"]&&currentAuthenticatedRole\(\)!==['"]admin['"]\}/);
  assert.match(operations, /function clientWorkflowMountOptions\([\s\S]*createApprovalAdapter/);
  assert.match(operations, /function clientShortlistMountOptions\([\s\S]*createShortlistApprovalAdapter[\s\S]*options\.loader=adapter\.loader[\s\S]*options\.submitter=adapter\.submitter/);
  assert.match(operations, /function availableTalentMountOptions\([\s\S]*createAvailableTalentApprovalAdapter[\s\S]*shortlistLoader[\s\S]*shortlistSubmitter/);
  assert.match(availableRoute, /availableTalentMountOptions\(accessRole\)/);
  assert.match(salesShortlistRoute, /const accessRole=currentAuthenticatedRole\(\)/);
  assert.match(salesShortlistRoute, /clientShortlistMountOptions\(accessRole,'sales'/);
  assert.match(clientReviewRoute, /const accessRole=currentAuthenticatedRole\(\)/);
  assert.match(clientReviewRoute, /clientShortlistMountOptions\(accessRole,'client',preferredHiringRequestId\)/);
  assert.match(clientsRoute, /clientWorkflowMountOptions\(accessRole\)/);

  assert.match(clientWorkflow, /activeAdapter = options\.adapter \|\| createEndpointAdapter/);
  assert.match(shortlist, /typeof loader === ['"]function['"] \? loader\([\s\S]*: secureRequest\(['"]GET['"]\)/);
  assert.match(shortlist, /usesLocalTransport:\s*typeof options\.loader === ['"]function['"] \|\| typeof options\.submitter === ['"]function['"]/);
  assert.doesNotMatch(shortlist, /configuredLoader\s*=\s*options\.loader|configuredSubmitter\s*=\s*options\.submitter/);
  assert.match(bench, /usesLocalTransport[\s\S]*local approval preview[\s\S]*sessionToken\(\)/);
  assert.match(operations, /new-record[\s\S]*clientWorkflowMountOptions\(currentAuthenticatedRole\(\)\)[\s\S]*options\.start=['"]create['"][\s\S]*SoroClientWorkflow\.mount\(root,options\)/);
});

test('Admin-to-Sales preview cannot use the Admin session for search or live profile reads', async () => {
  const { api, calls, elements } = loadOperationsController();
  api.applyRole('sales');

  assert.equal(elements.get('global-search').hidden, true, 'Global search must be hidden in the local Sales preview.');
  assert.equal(calls.searchConfig.getEffectiveRole(), '', 'The search controller must receive no searchable role in a local workspace preview.');
  const result = await api.searchOperationsRecords({ query: 'Brightlane', types: ['client', 'talent'] });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { query: 'Brightlane', clients: [], talent: [] });
  assert.equal(calls.session, 0, 'The preview search guard must run before reading the Admin session.');
  assert.equal(calls.fetch, 0, 'The preview search guard must run before the global-search request.');

  api.openClientProfile('10000000-0000-4000-8000-000000000002');
  assert.equal(calls.internalClientProfile, 0, 'The live internal Client profile must not mount in Sales preview.');
  assert.equal(calls.localClientMounts.length, 1);
  assert.equal(calls.localClientMounts[0].options.adapter.kind, 'approval');

  api.openTalentProfile('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
  assert.equal(calls.readOnlyTalentProfile, 0, 'The live Talent profile must fail closed in Sales preview.');
  assert.equal(calls.session, 0);
  assert.equal(calls.fetch, 0);
});

test('the preview Client Hub preserves one valid request UUID through shortlist and placement routing', async t => {
  const { api, calls, window } = loadOperationsController();
  api.applyRole('sales');
  const originalCustomEvent = globalThis.CustomEvent;
  const originalDispatchEvent = globalThis.dispatchEvent;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.dispatchEvent = event => window.dispatchEvent(event);
  t.after(() => {
    clientWorkflow.unmount();
    shortlistWorkflow.unmount();
    if (originalCustomEvent === undefined) delete globalThis.CustomEvent;
    else globalThis.CustomEvent = originalCustomEvent;
    if (originalDispatchEvent === undefined) delete globalThis.dispatchEvent;
    else globalThis.dispatchEvent = originalDispatchEvent;
  });

  const previewSeed = clientWorkflow.defaultSeed();
  const clientId = previewSeed[0].id;
  const requestId = previewSeed[0].hiringRequests[0].id;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert.match(requestId, uuid);
  assert.equal(requestId, placementWorkflow.defaultSeed('sales').request.hiringRequestId);
  const generatedAdapter = clientWorkflow.createApprovalAdapter();
  const createdPreview = await generatedAdapter.createClientBundle(clientWorkflow.normalizeBundle({
    companyName: 'Preview Client', contactName: 'Avery Parker', contactEmail: 'avery@preview.example',
    ownerId: 'preview-owner-morgan', roleTitle: 'Operations VA', portalInvite: false
  }));
  assert.match(createdPreview.id, uuid);
  assert.match(createdPreview.hiringRequests[0].id, uuid);
  const previewWithAnotherRequest = await generatedAdapter.addHiringRequest(createdPreview, { roleTitle: 'Support VA' });
  assert.match(previewWithAnotherRequest.hiringRequests[0].id, uuid);

  const shortlistTarget = clientHubTarget();
  await clientWorkflow.mount(shortlistTarget, { role: 'sales', clientId, adapter: clientWorkflow.createApprovalAdapter(previewSeed) });
  assert.match(shortlistTarget.innerHTML, /data-client-workflow-state="hub"/);
  const shortlistButton = shortlistTarget.nextButtons.find(button => button.dataset.clientWorkflowNext === 'shortlist');
  assert.ok(shortlistButton);
  shortlistButton.click();
  const shortlistOptions = calls.shortlistMounts.at(-1).options;
  assert.equal(shortlistOptions.requestId, requestId);
  assert.equal(api.state().preferredHiringRequestId, requestId);

  await shortlistOptions.submitter({ action: 'send_shortlist' });
  const shortlistPage = operationElement('shortlist-page');
  shortlistWorkflow.mount(shortlistPage, shortlistOptions);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(shortlistPage.innerHTML, new RegExp(`data-shortlist-placement="${requestId}"`));
  const placementLink = { dataset: { shortlistPlacement: requestId } };
  shortlistPage.dispatch('click', { target: { closest(selector) { return selector === '[data-shortlist-placement]' ? placementLink : null; } } });
  const placementOptions = calls.placementMounts.at(-1).options;
  assert.equal(placementOptions.hiringRequestId, requestId);
  assert.equal(placementOptions.adapter.kind, 'approval');
  assert.equal(placementOptions.adapter.seed.request.hiringRequestId, requestId);
  assert.match(calls.history.at(-1).url, new RegExp(`#client-placement/${requestId}$`));

  const placementCount = calls.placementMounts.length;
  assert.equal(api.openClientPlacementWorkflow('preview-request-medical-va'), false);
  assert.equal(calls.placementMounts.length, placementCount, 'Invalid live IDs must remain rejected.');
});

test('workspace preview state never mutates the authenticated authorization record', () => {
  const operations = read('operations/operations.js');
  const enhancements = read('operations/operations-enhancements.js');
  const auth = read('operations/auth.js');

  assert.doesNotMatch(operations, /(?:window\.)?soroCurrentAccess\s*=(?!=)/);
  assert.doesNotMatch(enhancements, /(?:window\.)?soroCurrentAccess\s*=(?!=)/);
  assert.match(auth, /window\.soroCurrentAccess\s*=\s*\{\s*\.\.\.access,\s*user_id:\s*session\.user\.id\s*\}/);
});

test('Client workspace preview uses network-free renderers while live routes stay fail closed', () => {
  const operations = read('operations/operations.js');
  const clientProfile = read('operations/client-profile.js');
  const clientTalent = read('operations/client-talent-profile.js');
  const profileRoute = routeBlock(operations, "if(current==='my-profile')", "if(current==='client-talent-profile')");
  const talentRoute = routeBlock(operations, "if(current==='client-talent-profile')", "if(current==='talent-profile')");
  const profilePreview = routeBlock(operations, 'function renderClientAccountWorkspacePreview(){', 'function renderClientTalentWorkspacePreview(){');
  const talentPreview = routeBlock(operations, 'function renderClientTalentWorkspacePreview(){', 'function viewAllowedForAuthenticatedRole(view){');

  assert.match(clientProfile, /const CLIENT_ROLES = new Set\(\['client_admin', 'client_reviewer', 'client_billing'\]\)/);
  assert.doesNotMatch(clientProfile, /CLIENT_ROLES[^;]*['"]admin['"]/);
  assert.match(clientTalent, /const CLIENT_TALENT_ROLES = new Set\(\['client_admin', 'client_reviewer'\]\)/);
  assert.doesNotMatch(clientTalent, /CLIENT_TALENT_ROLES[^;]*['"]admin['"]/);
  assert.match(clientProfile, /SORO_CLIENT_PROFILE_PREVIEW = Object\.freeze\(\{ renderProfile \}\)/);
  assert.match(clientTalent, /SORO_CLIENT_TALENT_PROFILE_PREVIEW = Object\.freeze\(\{[^}]*renderProfile[^}]*\}\)/);

  assert.match(profileRoute, /isAdminWorkspacePreview\(['"]client['"]\)/);
  assert.match(profileRoute, /renderClientAccountWorkspacePreview\(\)/);
  assert.match(profilePreview, /SORO_CLIENT_PROFILE_PREVIEW/);
  assert.match(profilePreview, /preview\.renderProfile\(/);
  assert.doesNotMatch(profilePreview, /\.mount\(/);
  assert.match(profileRoute, /SoroClientProfile\?\.canOpenProfile\(\)/);
  assert.match(profileRoute, /SoroClientProfile\.mount\(root\)/);

  assert.match(talentRoute, /isAdminWorkspacePreview\(['"]client['"]\)/);
  assert.match(talentRoute, /renderClientTalentWorkspacePreview\(\)/);
  assert.match(talentPreview, /SORO_CLIENT_TALENT_PROFILE_PREVIEW/);
  assert.match(talentPreview, /preview\.renderProfile\(/);
  assert.doesNotMatch(talentPreview, /\.mount\(/);
  assert.match(talentRoute, /SoroClientTalentProfile\?\.canOpenTalentProfile\(\)/);
  assert.match(talentRoute, /SoroClientTalentProfile\.mount\(root,\{talentId:preferredClientTalentId\}\)/);
});

test('operations enhancements delegates ordinary portal views back to the canonical renderer', () => {
  const source = read('operations/operations-enhancements.js');
  const override = routeBlock(source, 'render = function () {', "document.addEventListener('click'");

  assert.match(source, /const baseRender = render;/);
  assert.match(override, /if \(current === 'help'\)/);
  assert.match(override, /if \(current === 'talent-profile'\)/);
  assert.match(override, /return baseRender\(\);/);
  assert.doesNotMatch(override, /roleDashboards\[role\]|root\.innerHTML = `<main class="page"><div class="page-heading"/);
});

test('every portal uses the same accessible Soro navy sidebar treatment', () => {
  const html = read('operations/index.html');
  const base = read('operations/operations.css');
  const roles = read('operations/roles.css');
  const theme = read('operations/sidebar-theme.css');
  const foxCommand = read('assets/soro-ops-fox-command.svg');

  assert.match(html, /operations\.css\?v=20260829-profile-center/);
  assert.match(html, /roles\.css\?v=20260831-fox-command/);
  assert.match(html, /sidebar-theme\.css\?v=20260831-fixed-switcher/);
  assert.equal((html.match(/src="\.\.\/assets\/soro-ops-fox-command\.svg" alt="Soro Ops"/g) || []).length, 5);
  assert.match(html, /rel="icon"[^>]+soro-ops-fox-command-icon\.png/);
  assert.match(html, /rel="apple-touch-icon"[^>]+soro-ops-fox-command-icon\.png/);
  assert.doesNotMatch(html, /brand-ops|soro-logo-horizontal\.svg/);
  assert.ok(fs.existsSync(path.join(root, 'assets/soro-ops-fox-command.png')));
  assert.ok(fs.existsSync(path.join(root, 'assets/soro-ops-fox-command-icon.png')));
  assert.match(foxCommand, /viewBox="0 0 1350 480"/);
  assert.match(foxCommand, /<rect[^>]+fill="#082550"/);
  assert.doesNotMatch(foxCommand, /<text\b/i);
  assert.match(theme, /--sidebar-navy:\s*#082550/);
  assert.match(theme, /--sidebar-hover:\s*#123b6d/);
  assert.match(theme, /--sidebar-active:\s*#1e578e/);
  assert.match(theme, /--sidebar-focus:\s*#ffb37a/);
  assert.match(theme, /--sidebar-badge:\s*#c53d19/);
  assert.match(theme, /#app \[hidden\][\s\S]*display:\s*none !important/);
  assert.match(theme, /\.profile:not\(:disabled\):hover/);
  assert.match(base, /\.profile\{[^}]*padding:10px;[^}]*align-items:center/);
  assert.match(roles, /\.brand\s*\{[^}]*width:\s*100%[^}]*overflow:\s*hidden/s);
  assert.match(roles, /\.brand img\s*\{[^}]*width:\s*248px[^}]*height:\s*auto[^}]*max-width:\s*none[^}]*filter:\s*none/s);
  assert.match(theme, /\.nav-link:focus-visible,[\s\S]*\.profile:focus-visible/);
  assert.doesNotMatch(roles, /\.role-(?:talent|client|va)\s+\.sidebar\s*\{/);
});

test('the workspace switcher stays visible while long sidebar navigation scrolls independently', () => {
  const base = read('operations/operations.css');
  const theme = read('operations/sidebar-theme.css');

  assert.match(theme, /\.sidebar\s*>\s*nav\s*\{[^}]*flex:\s*1 1 auto[^}]*min-height:\s*0[^}]*align-content:\s*start[^}]*grid-auto-rows:\s*max-content[^}]*overflow-y:\s*auto[^}]*overscroll-behavior:\s*contain/s);
  assert.match(theme, /\.profile\s*\{[^}]*flex:\s*0 0 auto[^}]*margin-top:\s*12px/s);
  assert.match(theme, /@media\s*\(min-width:\s*951px\)\s*\{\s*\.sidebar\s*\{[^}]*position:\s*sticky[^}]*top:\s*0[^}]*align-self:\s*start[^}]*height:\s*100dvh[^}]*overflow:\s*hidden/s);
  assert.match(base, /@media\(max-width:950px\)\{[\s\S]*?\.sidebar\{[^}]*position:fixed/);
  assert.match(theme, /@media\s*\(max-width:\s*950px\)\s*\{\s*\.sidebar\s*\{[^}]*height:\s*100dvh[^}]*max-height:\s*100dvh[^}]*overflow:\s*hidden/s);
});
