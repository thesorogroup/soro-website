const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootPath = path.resolve(__dirname, '..');
const modulePath = path.join(rootPath, 'operations', 'client-shortlist-workflow.js');
const requestId = '11111111-1111-4111-8111-111111111111';
const shortlistId = '22222222-2222-4222-8222-222222222222';
const shortlistItemId = '33333333-3333-4333-8333-333333333333';
const applicantId = '44444444-4444-4444-8444-444444444444';
const clientId = '55555555-5555-4555-8555-555555555555';
const actionRequestId = '66666666-6666-4666-8666-666666666666';
const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const itemUpdatedAt = '2026-09-01T17:04:00.000Z';
const shortlistUpdatedAt = '2026-09-01T17:03:00.000Z';

function generatedRequestId(index) {
  return `70000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function candidate(overrides = {}) {
  return {
    shortlistItemId,
    updatedAt: itemUpdatedAt,
    applicantId,
    displayName: 'Jordan Rivera',
    country: 'Philippines',
    timeZone: 'Asia/Manila',
    verifiedSkills: ['Medical coding', 'Insurance claims'],
    yearsExperience: 4.5,
    experienceSummary: 'Medical back-office support.',
    educationAndTraining: 'Certified coding coursework.',
    screening: {
      englishResult: '95 practice',
      personalityResult: 'INFJ-A',
      computerSpecifications: 'MacBook Air, 16 GB',
      internetSpeed: '100 Mbps download, 40 Mbps upload'
    },
    ...overrides
  };
}

function workspace(role = 'sales', options = {}) {
  const sent = options.sent ?? role.startsWith('client_');
  const item = candidate(options.candidate || {});
  item.canRemove = !sent;
  item.canRespond = sent && !item.response;
  const request = {
    hiringRequestId: requestId,
    clientId,
    clientName: 'Northstar Legal',
    roleTitle: 'Legal Operations Assistant',
    status: sent ? 'client_review' : 'ready_for_matching',
    isOpen: true,
    ...(Object.prototype.hasOwnProperty.call(options, 'canAddCandidate')
      ? { canAddCandidate: options.canAddCandidate }
      : {}),
    shortlist: {
      shortlistId,
      hiringRequestId: requestId,
      updatedAt: shortlistUpdatedAt,
      status: sent ? 'client_review' : 'draft',
      sentAt: sent ? '2026-09-01T17:00:00.000Z' : null,
      canSend: !sent,
      items: [item]
    }
  };
  return {
    generatedAt: '2026-09-01T17:05:00.000Z',
    viewerRole: role,
    requests: [request],
    notifications: []
  };
}

function fakeTarget() {
  const listeners = new Map();
  return {
    innerHTML: '',
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type) { listeners.delete(type); },
    querySelector() { return null; },
    replaceChildren() { this.innerHTML = ''; },
    listeners
  };
}

function fakeOverlayDocument() {
  let currentHost = null;
  let removals = 0;
  const body = {
    classList: { contains: () => false },
    append(host) { currentHost = host; }
  };
  const document = {
    body,
    activeElement: { focus() {} },
    createElement() {
      const dialog = {
        open: false,
        addEventListener() {},
        showModal() { this.open = true; }
      };
      return {
        dataset: {},
        innerHTML: '',
        addEventListener() {},
        querySelector(selector) { return selector === '[data-shortlist-add-dialog]' ? dialog : null; },
        remove() {
          removals += 1;
          if (currentHost === this) currentHost = null;
        }
      };
    },
    querySelector(selector) { return selector === '[data-shortlist-overlay-root]' ? currentHost : null; },
    getElementById() { return null; }
  };
  return {
    document,
    get html() { return currentHost?.innerHTML || ''; },
    get removals() { return removals; }
  };
}

function dispatchAuthChange(eventListeners, userId, role) {
  globalThis.soroCurrentAccess = userId ? { role, user_id: userId } : null;
  const event = { detail: { session: userId ? { user: { id: userId } } : null, access: userId ? { role } : null } };
  for (const handler of eventListeners.get('soro-auth-changed') || []) handler(event);
}

function install(t, role = 'sales', options = {}) {
  const keys = ['soroCurrentAccess', 'crypto', 'CustomEvent', 'dispatchEvent', 'addEventListener', 'removeEventListener', 'soroSupabase', 'fetch', 'document', 'soroClientShortlistWorkflow'];
  const previous = new Map(keys.map(key => [key, Object.prototype.hasOwnProperty.call(globalThis, key)
    ? { exists: true, descriptor: Object.getOwnPropertyDescriptor(globalThis, key) }
    : { exists: false }]));
  const eventListeners = options.eventListeners || new Map();
  globalThis.soroCurrentAccess = { role, user_id: actorId };
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    writable: true,
    value: { randomUUID: () => actionRequestId }
  });
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
  };
  globalThis.dispatchEvent = () => true;
  globalThis.addEventListener = (type, handler) => {
    const handlers = eventListeners.get(type) || [];
    handlers.push(handler);
    eventListeners.set(type, handlers);
  };
  globalThis.removeEventListener = (type, handler) => {
    const handlers = eventListeners.get(type) || [];
    eventListeners.set(type, handlers.filter(candidate => candidate !== handler));
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
  return ui;
}

async function settle() {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
}

function statusError(status, message = `Request failed with ${status}`) {
  return Object.assign(new Error(message), { status });
}

test('Sales and client-review roles are mode-separated while private roles fail closed', t => {
  const ui = install(t);
  assert.deepEqual([...ui.SALES_ROLES].sort(), ['admin', 'sales', 'sales_management']);
  assert.deepEqual([...ui.CLIENT_ROLES].sort(), ['client_admin', 'client_reviewer']);
  assert.equal(ui.canOpenForRole('admin', 'sales'), true);
  assert.equal(ui.canOpenForRole('admin', 'client'), false);
  for (const role of ['sales', 'sales_management']) {
    assert.equal(ui.canOpenForRole(role, 'sales'), true);
    assert.equal(ui.canOpenForRole(role, 'client'), false);
  }
  for (const role of ui.CLIENT_ROLES) {
    assert.equal(ui.canOpenForRole(role, 'client'), true);
    assert.equal(ui.canOpenForRole(role, 'sales'), false);
  }
  for (const role of ['talent_management', 'billing', 'client_billing', 'virtual_assistant', '', 'unknown']) {
    assert.equal(ui.canOpenForRole(role), false, `${role || 'empty role'} must not open this workflow`);
  }
});

test('client normalization retains the approved profile only and strips unexpected private values', t => {
  const ui = install(t, 'client_reviewer');
  const normalized = ui.normalizePayload(workspace('client_reviewer', {
    candidate: {
      preferredName: 'SECRET PREFERRED NAME',
      availability: 'SECRET AVAILABILITY',
      rateLabel: 'SECRET RATE',
      expectedHourlyRate: 99,
      vaTypes: ['SECRET TYPE'],
      email: 'secret@example.com',
      phone: '+63 secret',
      resumeUrl: 'https://private.example/resume',
      internalNotes: 'SECRET INTERNAL NOTE',
      supportNotes: 'SECRET SUPPORT NOTE',
      personalityProfileScore: 'SECRET PERSONALITY'
    }
  }), 'client_reviewer');

  const serialized = JSON.stringify(normalized);
  for (const safeValue of [
    'Jordan Rivera', 'Philippines', 'Asia/Manila', 'Medical coding',
    'Medical back-office support.', 'Certified coding coursework.',
    '95 practice', 'INFJ-A', 'MacBook Air, 16 GB', '100 Mbps download, 40 Mbps upload'
  ]) assert.equal(serialized.includes(safeValue), true, `approved value missing: ${safeValue}`);
  for (const secret of [
    'SECRET PREFERRED NAME', 'SECRET AVAILABILITY', 'SECRET RATE', 'SECRET TYPE',
    'secret@example.com', '+63 secret', 'private.example', 'SECRET INTERNAL NOTE',
    'SECRET SUPPORT NOTE', 'SECRET PERSONALITY', '99'
  ]) assert.equal(serialized.includes(secret), false, `client payload leaked ${secret}`);
});

test('missing add permission fails closed and only explicit server true enables a draft request', t => {
  const ui = install(t);
  const omitted = ui.normalizePayload(workspace('sales'), 'sales');
  const denied = ui.normalizePayload(workspace('sales', { canAddCandidate: false }), 'sales');
  const allowed = ui.normalizePayload(workspace('sales', { canAddCandidate: true }), 'sales');

  assert.equal(omitted.requests[0].canAddCandidate, false);
  assert.equal(denied.requests[0].canAddCandidate, false);
  assert.equal(allowed.requests[0].canAddCandidate, true);
});

test('only the three approved client response values normalize', t => {
  const ui = install(t, 'client_admin');
  assert.deepEqual([...ui.RESPONSE_VALUES].sort(), ['interested', 'not_a_fit', 'request_interview']);
  assert.equal(ui.normalizeResponse('request_interview'), 'request_interview');
  assert.equal(ui.normalizeResponse('interested'), 'interested');
  assert.equal(ui.normalizeResponse('not_a_fit'), 'not_a_fit');
  for (const value of ['approve', 'reject', 'maybe', 'hire', 'decline', '', null]) {
    assert.equal(ui.normalizeResponse(value), '');
  }
});

test('client mode shows exact decision labels and no internal shortlist controls', async t => {
  const ui = install(t, 'client_reviewer');
  const target = fakeTarget();
  const loaded = workspace('client_reviewer');
  assert.equal(ui.mount(target, { role: 'client_reviewer', mode: 'client', loader: async () => loaded }), true);
  await settle();

  for (const label of ['Request interview', 'Interested', 'Not a fit']) assert.match(target.innerHTML, new RegExp(`>${label}<`));
  assert.doesNotMatch(target.innerHTML, /Add to (?:Client )?Shortlist|Send for Client Review|data-shortlist-remove/i);
});

test('a recorded client response is immutable in the UI and directs changes through Soro', async t => {
  const ui = install(t, 'client_admin');
  const target = fakeTarget();
  const loaded = workspace('client_admin', { candidate: { response: 'interested', responseAt: '2026-09-01T17:10:00.000Z' } });
  ui.mount(target, { role: 'client_admin', mode: 'client', loader: async () => loaded });
  await settle();

  assert.match(target.innerHTML, /Your response(?: is recorded)?:[\s\S]*Interested/i);
  assert.match(target.innerHTML, /recorded|contact Soro/i);
  assert.doesNotMatch(target.innerHTML, /You can change it|data-shortlist-response=/i);
  assert.equal(await ui.respondCandidate(shortlistItemId, 'not_a_fit'), false);
});

test('client and Sales mutations submit only the exact API fields with a request id', async t => {
  const clientUi = install(t, 'client_reviewer');
  const clientCalls = [];
  const clientTarget = fakeTarget();
  clientUi.mount(clientTarget, {
    role: 'client_reviewer',
    mode: 'client',
    loader: async () => workspace('client_reviewer'),
    submitter: async body => { clientCalls.push(body); return { workspace: workspace('client_reviewer', { candidate: { response: body.response } }) }; }
  });
  await settle();
  assert.equal(await clientUi.respondCandidate(shortlistItemId, 'request_interview'), true);
  assert.deepEqual(clientCalls[0], {
    action: 'respond_candidate', requestId: actionRequestId, shortlistItemId,
    expectedUpdatedAt: itemUpdatedAt, response: 'request_interview'
  });

  clientUi.unmount({ clear: false });
  globalThis.soroCurrentAccess = { role: 'sales' };
  const salesUi = require(modulePath);
  const salesCalls = [];
  const salesTarget = fakeTarget();
  salesUi.mount(salesTarget, {
    role: 'sales',
    mode: 'sales',
    loader: async () => workspace('sales', { canAddCandidate: true }),
    submitter: async body => { salesCalls.push(body); return { workspace: workspace('sales', { canAddCandidate: true }) }; }
  });
  await settle();
  assert.equal(salesUi.openRequest(requestId), true);
  assert.equal(await salesUi.removeCandidate(shortlistItemId), true);
  assert.deepEqual(salesCalls[0], {
    action: 'remove_candidate', requestId: actionRequestId, shortlistItemId,
    expectedUpdatedAt: itemUpdatedAt
  });
  assert.equal(await salesUi.sendShortlist(shortlistId, requestId), true);
  assert.deepEqual(salesCalls[1], {
    action: 'send_shortlist', requestId: actionRequestId, shortlistId,
    expectedUpdatedAt: shortlistUpdatedAt
  });
});

test('a commit-then-timeout manual retry reuses the original request id', async t => {
  const ui = install(t, 'sales');
  const ids = [generatedRequestId(1), generatedRequestId(2)];
  let generated = 0;
  globalThis.crypto.randomUUID = () => ids[generated++];
  const calls = [];
  const committedWorkspace = workspace('sales', { canAddCandidate: true });
  committedWorkspace.requests[0].shortlist.items = [];
  let committed = false;
  const target = fakeTarget();
  ui.mount(target, {
    role: 'sales',
    mode: 'sales',
    loader: async () => workspace('sales', { canAddCandidate: true }),
    submitter: async body => {
      calls.push(body);
      if (!committed) {
        committed = true;
        throw new Error('Connection closed after the server committed.');
      }
      return { workspace: committedWorkspace };
    }
  });
  await settle();
  ui.openRequest(requestId);

  assert.equal(await ui.removeCandidate(shortlistItemId), false);
  assert.equal(await ui.removeCandidate(shortlistItemId), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].requestId, ids[0]);
  assert.equal(calls[1].requestId, ids[0]);
  assert.equal(generated, 1, 'manual retry must not generate a second request id');
});

test('retryable failures retain an id while success and definitive conflicts rotate it', async t => {
  const ui = install(t, 'sales');
  const ids = Array.from({ length: 10 }, (_, index) => generatedRequestId(index + 10));
  let generated = 0;
  globalThis.crypto.randomUUID = () => ids[generated++];
  const calls = [];
  const outcomes = [503, 408, 429, 'success', 400, 401, 403, 409, 422, 'success'];
  const target = fakeTarget();
  ui.mount(target, {
    role: 'sales',
    mode: 'sales',
    loader: async () => workspace('sales', { canAddCandidate: true }),
    submitter: async body => {
      calls.push(body);
      const outcome = outcomes[calls.length - 1];
      if (outcome !== 'success') throw statusError(outcome);
      return { workspace: workspace('sales', { canAddCandidate: true }) };
    }
  });
  await settle();
  ui.openRequest(requestId);

  for (let index = 0; index < outcomes.length; index += 1) await ui.removeCandidate(shortlistItemId);

  assert.deepEqual(calls.map(call => call.requestId), [
    ids[0], ids[0], ids[0], ids[0],
    ids[1], ids[2], ids[3], ids[4], ids[5], ids[6]
  ]);
  assert.equal(generated, 7);
});

test('malformed successful results retain an id but changed response, timestamp, or account rotates it', async t => {
  const ui = install(t, 'client_reviewer');
  const ids = Array.from({ length: 8 }, (_, index) => generatedRequestId(index + 30));
  let generated = 0;
  globalThis.crypto.randomUUID = () => ids[generated++];
  const calls = [];
  const submitter = async body => {
    calls.push(body);
    return { workspace: { viewerRole: 'sales', requests: [], shortlists: [], candidates: [] } };
  };
  const target = fakeTarget();
  ui.mount(target, {
    role: 'client_reviewer',
    mode: 'client',
    loader: async () => workspace('client_reviewer'),
    submitter
  });
  await settle();

  assert.equal(await ui.respondCandidate(shortlistItemId, 'interested'), false);
  assert.equal(await ui.respondCandidate(shortlistItemId, 'interested'), false);
  assert.equal(await ui.respondCandidate(shortlistItemId, 'not_a_fit'), false);

  const newerTimestamp = '2026-09-01T17:14:00.000Z';
  ui.unmount({ clear: false });
  ui.mount(target, {
    role: 'client_reviewer',
    mode: 'client',
    loader: async () => workspace('client_reviewer', { candidate: { updatedAt: newerTimestamp } }),
    submitter
  });
  await settle();
  assert.equal(await ui.respondCandidate(shortlistItemId, 'interested'), false);

  globalThis.soroCurrentAccess = { role: 'client_reviewer', user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
  assert.equal(await ui.respondCandidate(shortlistItemId, 'interested'), false);

  assert.deepEqual(calls.map(call => call.requestId), [ids[0], ids[0], ids[1], ids[2], ids[3]]);
  assert.deepEqual(calls.map(call => call.expectedUpdatedAt), [itemUpdatedAt, itemUpdatedAt, itemUpdatedAt, newerTimestamp, newerTimestamp]);
});

test('a post-success refresh failure remains retryable and simultaneous identical actions share one id', async t => {
  const ui = install(t, 'sales');
  const ids = Array.from({ length: 5 }, (_, index) => generatedRequestId(index + 50));
  let generated = 0;
  globalThis.crypto.randomUUID = () => ids[generated++];
  const calls = [];
  let loaderCalls = 0;
  const target = fakeTarget();
  ui.mount(target, {
    role: 'sales',
    mode: 'sales',
    loader: async () => {
      loaderCalls += 1;
      if (loaderCalls > 1) throw new Error('Refresh failed after mutation commit.');
      return workspace('sales', { canAddCandidate: true });
    },
    submitter: async body => {
      calls.push(body);
      return { ok: true };
    }
  });
  await settle();
  ui.openRequest(requestId);

  assert.equal(await ui.removeCandidate(shortlistItemId), false);
  assert.equal(await ui.removeCandidate(shortlistItemId), false);
  assert.deepEqual(calls.map(call => call.requestId), [ids[0], ids[0]]);

  ui.unmount({ clear: false });
  const simultaneousCalls = [];
  const releases = [];
  ui.mount(target, {
    role: 'sales',
    mode: 'sales',
    loader: async () => workspace('sales', { canAddCandidate: true }),
    submitter: body => {
      simultaneousCalls.push(body);
      return new Promise(resolve => releases.push(() => resolve({ workspace: workspace('sales', { canAddCandidate: true }) })));
    }
  });
  await settle();
  ui.openRequest(requestId);
  const first = ui.removeCandidate(shortlistItemId);
  const second = ui.removeCandidate(shortlistItemId);
  await settle();
  assert.equal(simultaneousCalls.length, 2);
  assert.equal(simultaneousCalls[0].requestId, ids[0], 'the retained ambiguous id should survive navigation');
  assert.equal(simultaneousCalls[1].requestId, ids[0], 'simultaneous identical mutations must share the same id');
  releases.forEach(release => release());
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
});

test('changed actions never share an id and abandoned ambiguous retries expire', async t => {
  const ui = install(t, 'sales');
  const ids = Array.from({ length: 5 }, (_, index) => generatedRequestId(index + 70));
  let generated = 0;
  let clock = 1_000_000;
  const originalNow = Date.now;
  t.after(() => { Date.now = originalNow; });
  Date.now = () => clock;
  globalThis.crypto.randomUUID = () => ids[generated++];
  const calls = [];
  const target = fakeTarget();
  ui.mount(target, {
    role: 'sales',
    mode: 'sales',
    loader: async () => workspace('sales', { canAddCandidate: true }),
    submitter: async body => {
      calls.push(body);
      throw new Error('Ambiguous connection loss.');
    }
  });
  await settle();
  ui.openRequest(requestId);

  assert.equal(await ui.removeCandidate(shortlistItemId), false);
  assert.equal(await ui.sendShortlist(shortlistId, requestId), false);
  assert.equal(await ui.removeCandidate(shortlistItemId), false);
  clock += (15 * 60 * 1000) + 1;
  assert.equal(await ui.removeCandidate(shortlistItemId), false);

  assert.deepEqual(calls.map(call => call.requestId), [ids[0], ids[1], ids[0], ids[2]]);
});

test('malformed definitive HTTP errors preserve their 4xx status and clear the retry id', async t => {
  const ui = install(t, 'sales');
  const ids = [generatedRequestId(80), generatedRequestId(81)];
  let generated = 0;
  globalThis.crypto.randomUUID = () => ids[generated++];
  globalThis.soroSupabase = {
    auth: { getSession: async () => ({ data: { session: { access_token: 'test-token' } }, error: null }) }
  };
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    if (calls.length === 1) return { ok: false, status: 409, text: async () => '{malformed-json' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ workspace: workspace('sales', { canAddCandidate: true }) }) };
  };
  const target = fakeTarget();
  ui.mount(target, {
    role: 'sales',
    mode: 'sales',
    loader: async () => workspace('sales', { canAddCandidate: true })
  });
  await settle();
  ui.openRequest(requestId);

  assert.equal(await ui.removeCandidate(shortlistItemId), false);
  assert.equal(await ui.removeCandidate(shortlistItemId), true);
  assert.deepEqual(calls.map(call => call.requestId), ids);
});

test('same-role account rotation immediately removes the prior mounted workspace', async t => {
  const eventListeners = new Map();
  const ui = install(t, 'sales', { eventListeners });
  const prior = workspace('sales', { canAddCandidate: true });
  prior.requests[0].clientName = 'Prior Account Client';
  const next = workspace('sales', { canAddCandidate: true });
  next.requests[0].clientName = 'Next Account Client';
  let resolveNext;
  let loads = 0;
  const target = fakeTarget();
  ui.mount(target, {
    role: 'sales',
    mode: 'sales',
    loader: async () => {
      loads += 1;
      if (loads === 1) return prior;
      return new Promise(resolve => { resolveNext = resolve; });
    }
  });
  await settle();
  ui.openRequest(requestId);
  assert.match(target.innerHTML, /Prior Account Client/);

  dispatchAuthChange(eventListeners, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'sales');
  assert.doesNotMatch(target.innerHTML, /Prior Account Client/);
  assert.match(target.innerHTML, /Loading client shortlists/i);

  resolveNext(next);
  await settle();
  assert.match(target.innerHTML, /Next Account Client/);
  assert.doesNotMatch(target.innerHTML, /Prior Account Client/);
});

test('same-role account rotation closes and discards the prior Add-to-Shortlist overlay', async t => {
  const eventListeners = new Map();
  const ui = install(t, 'sales', { eventListeners });
  const overlayDocument = fakeOverlayDocument();
  globalThis.document = overlayDocument.document;
  const overlayApplicantId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const prior = workspace('sales', { canAddCandidate: true });
  prior.requests[0].clientName = 'Prior Overlay Client';
  prior.candidates = [{
    applicantId: overlayApplicantId,
    displayName: 'Jordan Rivera',
    stage: 'bench_ready',
    verifiedSkills: ['Medical coding'],
    yearsExperience: 4,
    availability: 'Full time',
    salesOwnerId: actorId,
    updatedAt: itemUpdatedAt
  }];
  ui.configure({ loader: async () => prior, submitter: async () => ({ workspace: prior }) });
  assert.equal(ui.openAddDialog({ applicantId: overlayApplicantId, fullName: 'Jordan Rivera' }, { role: 'sales' }), true);
  await settle();
  assert.match(overlayDocument.html, /Prior Overlay Client/);
  const removalsBeforeSwitch = overlayDocument.removals;

  dispatchAuthChange(eventListeners, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'sales');
  assert.equal(overlayDocument.html, '');
  assert.equal(overlayDocument.removals, removalsBeforeSwitch + 1);
  assert.equal(await ui.addCandidate(requestId), false, 'the prior overlay context must be discarded');
});

test('navigation never exposes Sales shortlists to unrelated roles or client review to Client Billing', () => {
  const source = fs.readFileSync(modulePath, 'utf8');
  const operations = fs.readFileSync(path.join(rootPath, 'operations', 'operations.js'), 'utf8');
  assert.match(source, /add_candidate:\s*\{[\s\S]{0,200}keys:\s*\['action',\s*'expectedUpdatedAt',\s*'hiringRequestId',\s*'applicantId'\]/i);
  assert.match(source, /invokeSubmitter\(\{\s*\.\.\.body,\s*requestId:\s*attempt\.requestId\s*\}/i);
  assert.match(source, /MUTATION_RETRY_LIMIT\s*=\s*24[\s\S]*while\s*\(mutationRetries\.size\s*>\s*MUTATION_RETRY_LIMIT\)/i);
  for (const role of ['admin', 'sales', 'sales_management']) {
    const views = operations.match(new RegExp(`${role}:new Set\\(\\[([^\\]]*)\\]\\)`, 'i'))?.[1] || '';
    assert.equal(views.includes('client-shortlists'), true, `${role} needs the Sales shortlist view`);
    assert.equal(views.includes('client-candidate-review'), false, `${role} must not receive the Client response view`);
  }
  for (const role of ['client_admin', 'client_reviewer']) {
    const views = operations.match(new RegExp(`${role}:new Set\\(\\[([^\\]]*)\\]\\)`, 'i'))?.[1] || '';
    assert.equal(views.includes('client-candidate-review'), true, `${role} needs candidate review`);
    assert.equal(views.includes('client-shortlists'), false, `${role} must not receive Sales controls`);
  }
  for (const role of ['talent_management', 'billing', 'client_billing', 'virtual_assistant']) {
    const views = operations.match(new RegExp(`${role}:new Set\\(\\[([^\\]]*)\\]\\)`, 'i'))?.[1] || '';
    assert.equal(views.includes('client-shortlists'), false, `${role} must not receive Sales shortlists`);
    assert.equal(views.includes('client-candidate-review'), false, `${role} must not receive client candidate review`);
  }
});
