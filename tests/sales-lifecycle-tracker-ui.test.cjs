const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const modulePath = path.resolve(__dirname, '../operations/sales-lifecycle-tracker.js');
const clientId = '10000000-0000-4000-8000-000000000001';
const requestId = '20000000-0000-4000-8000-000000000001';
const ownerId = '30000000-0000-4000-8000-000000000001';
const timestamp = '2026-09-07T15:30:00Z';

function row(overrides = {}) {
  return { clientId, requestId, clientName: 'Cedar Health', roleTitle: 'Medical VA', ownerId, ownerName: 'Morgan Lee', status: 'open', stage: 'matching', candidateCount: 2, interviewCount: 1, placementCount: 0, seatCount: 2, activePlacementCount: 0, onboardingCount: 0, targetStartDate: '2026-09-21', lastActivityAt: timestamp, nextInterviewAt: null, attentionCode: null, nextAction: 'find_candidates', responsibleRole: 'sales', ...overrides };
}
function payload(rows = [row()], role = 'sales') { return { generatedAt: timestamp, viewerRole: role, rows }; }
function target() {
  const listeners = new Map();
  return { innerHTML: '', addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); }, querySelector() { return null; }, listeners };
}
function click(node, attributes) {
  const button = { disabled: false, dataset: attributes, hasAttribute: name => ({ 'data-tracker-refresh': 'trackerRefresh', 'data-tracker-attention': 'trackerAttention', 'data-tracker-clear': 'trackerClear', 'data-tracker-stage': 'trackerStage' }[name] in attributes) };
  node.listeners.get('click')?.({ target: { closest: () => button } });
}
function install(t, options = {}) {
  const keys = ['SoroSalesLifecycleTracker', 'soroCurrentAccess', 'soroSupabase', 'fetch', 'addEventListener', 'removeEventListener'];
  const saved = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const events = new Map();
  const calls = [];
  globalThis.soroCurrentAccess = { role: options.role || 'sales' };
  globalThis.soroSupabase = { auth: { getSession: async () => ({ data: { session: options.noSession ? null : { access_token: 'tracker-test-token' } } }) } };
  globalThis.addEventListener = (name, fn) => events.set(name, fn);
  globalThis.removeEventListener = name => events.delete(name);
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, text: async () => JSON.stringify(payload()) }; };
  delete require.cache[modulePath];
  const ui = require(modulePath);
  t.after(() => { ui.unmount(); delete require.cache[modulePath]; for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  return { ui, calls, events };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('tracker is limited to the authorized employee roles and clears a previous mount on denied access', async t => {
  const { ui } = install(t);
  for (const role of ['admin', 'sales', 'sales_management']) assert.equal(ui.canUse(role), true);
  for (const role of ['talent_management', 'client_admin', 'client_reviewer', 'client_billing', 'virtual_assistant', 'billing', '']) assert.equal(ui.canUse(role), false);
  const node = target();
  ui.mount(node, { role: 'sales', loader: async () => payload() });
  await settle();
  assert.match(node.innerHTML, /Cedar Health/);
  assert.equal(ui.mount(node, { role: 'client_admin' }), false);
  assert.equal(node.innerHTML, '');
});

test('normalization keeps operational fields, excludes unrelated private data, and rejects role mismatch', t => {
  const { ui } = install(t);
  const normalized = ui.normalizeWorkspace(payload([row({ address: 'private street', contactEmail: 'private@example.test', resumeUrl: 'https://example.test/secret', ownerEmail: 'owner-private@example.test' })]), 'sales');
  assert.equal(normalized.rows[0].clientName, 'Cedar Health');
  assert.doesNotMatch(JSON.stringify(normalized), /private|secret/);
  assert.throws(() => ui.normalizeWorkspace(payload([], 'admin'), 'sales'), /access/);
  assert.throws(() => ui.normalizeWorkspace(payload([], 'virtual_assistant'), 'virtual_assistant'), /access/);
});

test('malformed and ambiguous responses fail closed instead of dropping individual rows', t => {
  const { ui } = install(t);
  for (const changes of [{ requestId: 'invalid' }, { stage: 'invented' }, { nextAction: 'delete_client' }, { responsibleRole: 'unknown' }, { attentionCode: 'unknown' }, { candidateCount: -1 }, { interviewCount: '2' }, { targetStartDate: '2026-02-31' }, { roleTitle: '' }]) {
    assert.throws(() => ui.normalizeWorkspace(payload([row(changes)]), 'sales'));
  }
  assert.throws(() => ui.normalizeWorkspace(payload([row(), row()]), 'sales'), /duplicate/);
  assert.throws(() => ui.normalizeWorkspace({ ...payload(), generatedAt: null }, 'sales'), /incomplete/);
});

test('filters combine search, lifecycle stage, owner and attention without removing skillless or incomplete requests', t => {
  const { ui } = install(t);
  const data = ui.normalizeWorkspace(payload([
    row(),
    row({ requestId: '20000000-0000-4000-8000-000000000002', clientName: 'Harbor Design', roleTitle: 'General VA', ownerId: null, ownerName: null, attentionCode: 'owner_missing', stage: 'discovery', nextAction: 'client_setup' }),
    row({ requestId: '20000000-0000-4000-8000-000000000003', clientName: 'Cedar Operations', attentionCode: 'contact_missing' })
  ]), 'sales');
  assert.equal(ui.visibleRows(data, {}).length, 3);
  assert.equal(ui.visibleRows(data, { search: 'cedar', stage: 'matching', owner: ownerId, attention: true }).length, 1);
  assert.equal(ui.visibleRows(data, { owner: 'unassigned' })[0].clientName, 'Harbor Design');
  assert.equal(ui.visibleRows(data, { search: 'morgan' }).length, 2);
});

test('display escapes records, labels real stage counts, and exposes one next action per request', t => {
  const { ui } = install(t);
  const data = ui.normalizeWorkspace(payload([row({ clientName: '<img onerror="bad()">', roleTitle: 'VA & support', ownerName: 'A <script>x</script>' })]), 'sales');
  const markup = ui.workspaceMarkup(data);
  assert.doesNotMatch(markup, /<img|<script>/);
  assert.match(markup, /&lt;img/);
  assert.match(markup, /data-tracker-stage="matching" aria-pressed="false"><strong>1<\/strong>/);
  assert.equal((markup.match(/data-tracker-action=/g) || []).length, 1);
  assert.match(markup, /aria-label="Find candidates for/);
  assert.match(markup, /role="status" aria-live="polite"/);
  assert.doesNotMatch(markup, /sales-tracker-owner/);
  assert.match(ui.workspaceMarkup({ ...data, viewerRole: 'admin' }), /sales-tracker-owner/);
});

test('no dates or overdue tasks are invented for empty fields and attention follows the server', t => {
  const { ui } = install(t);
  const data = ui.normalizeWorkspace(payload([row({ targetStartDate: null, lastActivityAt: null, nextInterviewAt: null })]), 'sales');
  const markup = ui.workspaceMarkup(data);
  assert.match(markup, /No target start set/);
  assert.match(markup, /Not recorded/);
  assert.doesNotMatch(markup, /needs-attention"|overdue|Target start date has passed/);
  const overdue = ui.normalizeWorkspace(payload([row({ attentionCode: 'start_date_passed' })]), 'sales');
  assert.match(ui.workspaceMarkup(overdue), /Target start date has passed/);
});

test('an assigned owner without a display name is not labeled unassigned', t => {
  const { ui } = install(t);
  const assigned = ui.normalizeWorkspace(payload([row({ ownerName: null })]), 'sales');
  assert.match(ui.rowMarkup(assigned.rows[0]), /Assigned Sales owner/);
  assert.doesNotMatch(ui.rowMarkup(assigned.rows[0]), /Unassigned owner/);
  const unassigned = ui.normalizeWorkspace(payload([row({ ownerId: null, ownerName: null })]), 'sales');
  assert.match(ui.rowMarkup(unassigned.rows[0]), /Unassigned owner/);
});

test('empty, filtered empty, and loading states are distinct and do not display sample records', async t => {
  const { ui } = install(t);
  const node = target();
  let resolve;
  ui.mount(node, { role: 'sales', loader: () => new Promise(done => { resolve = done; }) });
  assert.match(node.innerHTML, /Loading your hiring requests/);
  assert.doesNotMatch(node.innerHTML, /Cedar Health|Sample data/);
  resolve(payload([]));
  await settle();
  assert.match(node.innerHTML, /No hiring requests yet/);
  assert.doesNotMatch(node.innerHTML, /Cedar Health/);
  const filtered = ui.workspaceMarkup(ui.normalizeWorkspace(payload(), 'sales'), { search: 'missing' });
  assert.match(filtered, /No requests match these filters/);
});

test('live default makes only a read-only authenticated request and never falls back to preview data', async t => {
  const { ui, calls } = install(t);
  const node = target();
  ui.mount(node, { role: 'sales' });
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/.netlify/functions/sales-lifecycle-tracker');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tracker-test-token');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.equal(calls[0].init.body, undefined);
  assert.doesNotMatch(node.innerHTML, /Sample data/);
  globalThis.fetch = async () => ({ ok: false, status: 403 });
  await ui.refresh();
  assert.match(node.innerHTML, /does not have access/);
  assert.doesNotMatch(node.innerHTML, /Cedar Health/);
});

test('missing session avoids querying the endpoint', async t => {
  const { ui, calls } = install(t, { noSession: true });
  const node = target();
  ui.mount(node, { role: 'sales' });
  await settle();
  assert.equal(calls.length, 0);
  assert.match(node.innerHTML, /Sign in again/);
});

test('click actions pass the current normalized request to existing workflow callbacks only', async t => {
  const { ui } = install(t);
  const node = target();
  const actions = [];
  const clients = [];
  ui.mount(node, { role: 'sales', loader: async () => payload(), onAction: value => actions.push(value), onOpenClient: value => clients.push(value) });
  await settle();
  click(node, { trackerAction: requestId });
  click(node, { trackerClient: requestId });
  click(node, { trackerAction: 'unknown' });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].nextAction, 'find_candidates');
  assert.equal(clients.length, 1);
  assert.equal(clients[0].clientId, clientId);
});

test('late responses cannot overwrite a newer mount or render after unmount', async t => {
  const { ui } = install(t);
  const first = target();
  const second = target();
  let resolveFirst;
  ui.mount(first, { role: 'sales', loader: () => new Promise(done => { resolveFirst = done; }) });
  ui.mount(second, { role: 'sales', loader: async () => payload([row({ clientName: 'Current Client' })]) });
  await settle();
  resolveFirst(payload([row({ clientName: 'Stale Client' })]));
  await settle();
  assert.equal(first.innerHTML, '');
  assert.match(second.innerHTML, /Current Client/);
  assert.doesNotMatch(second.innerHTML, /Stale Client/);
  let resolveLast;
  ui.mount(second, { role: 'sales', loader: () => new Promise(done => { resolveLast = done; }) });
  ui.unmount();
  resolveLast(payload());
  await settle();
  assert.equal(second.innerHTML, '');
});

test('sign-out clears mounted live data and detaches access listeners', async t => {
  const { ui, events } = install(t);
  const node = target();
  ui.mount(node, { role: 'sales' });
  await settle();
  assert.match(node.innerHTML, /Cedar Health/);
  events.get('soro-auth-changed')({ detail: { session: null, access: null } });
  assert.equal(node.innerHTML, '');
  assert.equal(events.has('soro-auth-changed'), false);
});

test('filters may persist through a same-role shell refresh but reset for another role', async t => {
  const { ui } = install(t);
  const node = target();
  ui.mount(node, { role: 'sales', loader: async () => payload() });
  await settle();
  ui.setFilters({ search: 'Cedar', stage: 'matching', attention: true });
  ui.unmount({ clear: false });
  ui.mount(node, { role: 'sales', preserveFilters: true, loader: async () => payload() });
  await settle();
  assert.match(node.innerHTML, /value="Cedar"/);
  assert.match(node.innerHTML, /data-tracker-attention aria-pressed="true"/);
  ui.mount(node, { role: 'admin', preserveFilters: true, loader: async () => payload([], 'admin') });
  await settle();
  assert.doesNotMatch(node.innerHTML, /value="Cedar"/);
});

test('typing and native search clearing preserve the input node and update results before another filter', async t => {
  const { ui } = install(t);
  const node = target();
  const input = { id: 'sales-tracker-search', value: '' };
  const list = { innerHTML: '' };
  const heading = { innerHTML: '' };
  const second = row({ requestId: '20000000-0000-4000-8000-000000000002', clientName: 'Harbor Design', roleTitle: 'General VA', attentionCode: 'contact_missing' });
  ui.mount(node, { role: 'sales', loader: async () => payload([row(), second]) });
  await settle();
  node.querySelector = selector => ({ '#sales-tracker-search': input, '.sales-tracker-list': list, '.sales-tracker-results-heading': heading }[selector] || null);
  const originalRootMarkup = node.innerHTML;
  input.value = 'medical';
  node.listeners.get('input')({ target: input });
  assert.equal(node.innerHTML, originalRootMarkup, 'typing must leave the input and parent tree mounted');
  assert.match(list.innerHTML, /Cedar Health/);
  assert.doesNotMatch(list.innerHTML, /Harbor Design/);
  input.value = '';
  node.listeners.get('search')({ target: input });
  assert.equal(node.innerHTML, originalRootMarkup, 'native clear must also preserve the input');
  assert.match(list.innerHTML, /Cedar Health/);
  assert.match(list.innerHTML, /Harbor Design/);
  click(node, { trackerAttention: '' });
  assert.match(node.innerHTML, /Harbor Design/);
  assert.doesNotMatch(node.innerHTML, /Cedar Health/);
  assert.match(node.innerHTML, /value=""/);
});
