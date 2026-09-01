const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootPath = path.resolve(__dirname, '..');
const modulePath = path.join(rootPath, 'operations', 'available-talent-bench.js');
const source = fs.readFileSync(modulePath, 'utf8');
const css = fs.readFileSync(path.join(rootPath, 'operations', 'available-talent-bench.css'), 'utf8');
const operations = fs.readFileSync(path.join(rootPath, 'operations', 'operations.js'), 'utf8');
const html = fs.readFileSync(path.join(rootPath, 'operations', 'index.html'), 'utf8');

const applicantId = '22222222-2222-4222-8222-222222222222';
const otherApplicantId = '33333333-3333-4333-8333-333333333333';
const salesOwnerId = '44444444-4444-4444-8444-444444444444';
const requestId = '55555555-5555-4555-8555-555555555555';
const updatedAt = '2026-09-01T15:30:00.000Z';

function item(overrides = {}) {
  return {
    applicantId,
    fullName: 'Santos, Mariel Anne',
    preferredName: 'Mariel',
    stage: 'bench_ready',
    vaTypes: ['Medical VA'],
    verifiedSkills: ['Medical coding support'],
    availability: 'Full time',
    rateMin: 8,
    rateMax: 10,
    rateLabel: '$8-$10 USD per hour',
    yearsExperience: 3,
    owner: { id: null, name: 'Unassigned' },
    updatedAt,
    allowedActions: ['claim'],
    ...overrides
  };
}

function payload(role = 'sales', items = [item()], overrides = {}) {
  return {
    generatedAt: '2026-09-01T15:35:00.000Z',
    viewerRole: role,
    caseload: { claimed: 12, capacity: 40 },
    salesOwners: [{ id: salesOwnerId, name: 'Morgan Lee', claimed: 12, capacity: 40, available: true }],
    filters: {
      vaTypes: ['Medical VA', 'General VA'],
      verifiedSkills: ['Medical coding support', 'Calendar management'],
      availabilityOptions: ['Full time', 'Part time']
    },
    items,
    ...overrides
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

function install(t, options = {}) {
  const role = options.role || 'sales';
  const calls = [];
  const events = [];
  const queueResponses = Array.isArray(options.responses) ? [...options.responses] : [
    { status: options.status || 200, body: options.responsePayload || payload(role) }
  ];
  const keys = [
    'soroCurrentAccess', 'soroSupabase', 'fetch', 'crypto', 'CustomEvent', 'dispatchEvent',
    'addEventListener', 'AbortController', 'soroAvailableTalentBench', 'soroOpenTalentProfile'
  ];
  const previous = new Map(keys.map(key => [key, Object.prototype.hasOwnProperty.call(globalThis, key)
    ? { exists: true, descriptor: Object.getOwnPropertyDescriptor(globalThis, key) }
    : { exists: false }]));
  globalThis.soroCurrentAccess = { role };
  globalThis.soroSupabase = {
    auth: { getSession: async () => ({ data: { session: { access_token: 'signed-in-bench-token' } }, error: null }) }
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
    calls.push({ url: String(url), options: requestOptions });
    const next = queueResponses.length > 1 ? queueResponses.shift() : queueResponses[0];
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => JSON.stringify(next.body)
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

async function settle() {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
}

test('authorized employee workspaces include legacy Sales Management as view-only access', t => {
  const { ui } = install(t);
  for (const role of ['admin', 'talent_management', 'sales', 'sales_management']) {
    assert.equal(ui.canOpenForRole(role), true, `${role} should be authorized`);
  }
  for (const role of ['billing', 'client_admin', 'client_reviewer', 'client_billing', 'virtual_assistant', '']) {
    assert.equal(ui.canOpenForRole(role), false, `${role || 'empty role'} must be denied`);
  }
});

test('payload normalization retains only safe operational fields and accepts interviewing as active caseload', t => {
  const { ui } = install(t);
  const normalized = ui.normalizePayload(payload('sales', [item({
    stage: 'interviewing',
    owner: { id: salesOwnerId, name: 'Morgan Lee', privateEmail: 'morgan-private@example.com' },
    allowedActions: [],
    email: 'mariel@example.com', phone: '+63 917 555 0100', address: 'Private address',
    birthDate: '1998-01-10', genderIdentity: 'female', pronouns: ['she_her'],
    greatestDream: 'Private dream', resumeUrl: 'https://private.example/resume.pdf',
    organizationId: otherApplicantId, authUserId: otherApplicantId
  })]), 'sales');

  assert.equal(normalized.phase, 'ready');
  assert.equal(normalized.items[0].stage, 'interviewing');
  assert.deepEqual(Object.keys(normalized.items[0]).sort(), [
    'allowedActions', 'applicantId', 'availability', 'experienceLabel', 'fullName', 'owner',
    'preferredName', 'rateLabel', 'rateMaximum', 'rateMinimum', 'stage', 'updatedAt',
    'vaTypes', 'verifiedSkills'
  ]);
  assert.deepEqual(Object.keys(normalized.items[0].owner).sort(), ['id', 'isCurrentUser', 'name']);
  const serialized = JSON.stringify(normalized);
  for (const privateValue of [
    'mariel@example.com', '+63 917 555 0100', 'Private address', '1998-01-10',
    'Private dream', 'private.example', 'morgan-private@example.com', otherApplicantId
  ]) assert.equal(serialized.includes(privateValue), false, `must strip ${privateValue}`);
});

test('normalization rejects unauthorized roles, invalid records, duplicate ids, and post-placement stages', t => {
  const { ui } = install(t);
  assert.throws(() => ui.normalizePayload(payload('sales'), 'admin'), /access/i);
  assert.throws(() => ui.normalizePayload(payload('client_admin'), 'client_admin'), /access/i);
  assert.throws(() => ui.normalizePayload(payload('sales', [{ ...item(), applicantId: 'not-a-uuid' }]), 'sales'), /invalid/i);
  assert.throws(() => ui.normalizePayload(payload('sales', [item(), item()]), 'sales'), /invalid/i);
  assert.throws(() => ui.normalizePayload(payload('sales', [item({ stage: 'placement_confirmed' })]), 'sales'), /invalid|stage|queue/i);
});

test('all filters combine without widening cards or mixing private fields into search', t => {
  const { ui } = install(t);
  const second = item({
    applicantId: otherApplicantId,
    fullName: 'Reyes, Ana',
    preferredName: 'Ana',
    vaTypes: ['General VA'],
    verifiedSkills: ['Calendar management'],
    availability: 'Part time',
    rateMin: 5,
    rateMax: 7,
    rateLabel: '$5-$7 USD per hour'
  });
  const normalized = ui.normalizePayload(payload('sales', [item(), second]), 'sales');
  const filters = ui.normalizeFilters({
    search: 'medical', vaType: 'Medical VA', verifiedSkill: 'Medical coding support',
    availability: 'Full time', rateMin: 7, rateMax: 9
  });
  const visible = ui.visibleItems(normalized, filters);
  assert.deepEqual(visible.map(entry => entry.applicantId), [applicantId]);

  assert.deepEqual(ui.visibleItems(normalized, ui.normalizeFilters({ search: 'ana' })).map(entry => entry.applicantId), [otherApplicantId]);
  assert.deepEqual(ui.visibleItems(normalized, ui.normalizeFilters({ rateMin: 11 })), []);
});

test('mount shows loading, loads through the authenticated no-store endpoint, and renders an empty real queue', async t => {
  const { ui, calls } = install(t, {
    responsePayload: payload('sales', [], {
      caseload: { claimed: 0, capacity: 40 }, salesOwners: [],
      filters: { vaTypes: [], verifiedSkills: [], availabilityOptions: [] }
    })
  });
  const target = fakeTarget();
  assert.equal(ui.mount(target, { role: 'sales' }), true);
  assert.match(target.innerHTML, /bench-loading[\s\S]*Loading Bench Ready Talent/i);
  await settle();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/.netlify/functions/available-talent-bench');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer signed-in-bench-token');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.match(target.innerHTML, /bench-empty[\s\S]*No matching Talent/i);
  assert.doesNotMatch(target.innerHTML, /Mariel|Morgan|sample|demo/i);
});

test('claim and release actions post only server-recognized fields and preserve audit request ids', async t => {
  const claimed = item({ owner: { id: salesOwnerId, name: 'Morgan Lee' }, allowedActions: ['release'] });
  const { ui, calls, events } = install(t, {
    responses: [
      { status: 200, body: payload('sales', [item()]) },
      { status: 200, body: payload('sales', [claimed], { caseload: { claimed: 13, capacity: 40 } }) },
      { status: 200, body: payload('sales', [item()], { caseload: { claimed: 12, capacity: 40 } }) }
    ]
  });
  const target = fakeTarget();
  ui.mount(target, { role: 'sales' });
  await settle();

  assert.equal(await ui.changeOwnership('claim', applicantId), true);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    requestId, action: 'claim', applicantId, expectedUpdatedAt: updatedAt
  });
  assert.equal(await ui.changeOwnership('release', applicantId), true);
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    requestId, action: 'release', applicantId, expectedUpdatedAt: updatedAt
  });
  assert.deepEqual(events.map(event => event.type), ['soro:available-talent-updated', 'soro:available-talent-updated']);
});

test('an empty server allowedActions list never falls back to a client-invented claim or release', async t => {
  const { ui, calls } = install(t, {
    responsePayload: payload('sales', [item({ allowedActions: [] })])
  });
  const target = fakeTarget();
  ui.mount(target, { role: 'sales' });
  await settle();

  assert.equal(await ui.changeOwnership('claim', applicantId), false);
  assert.equal(await ui.changeOwnership('release', applicantId), false);
  assert.equal(calls.length, 1, 'denied actions must not reach the endpoint');
  assert.doesNotMatch(target.innerHTML, /data-bench-action="(?:claim|release)"/i);
});

test('legacy Sales Management renders team capacity and no ownership controls', async t => {
  const { ui, calls } = install(t, {
    role: 'sales_management',
    responsePayload: payload('sales_management', [item({ allowedActions: [] })], {
      caseload: { claimed: 12, capacity: 80 }
    })
  });
  const target = fakeTarget();
  ui.mount(target, { role: 'sales_management' });
  await settle();

  assert.equal(calls.length, 1);
  assert.match(target.innerHTML, />Sales caseload</i);
  assert.doesNotMatch(target.innerHTML, />My Sales caseload</i);
  assert.match(target.innerHTML, /View only/i);
  assert.doesNotMatch(target.innerHTML, /data-bench-action=/i);
  assert.doesNotMatch(target.innerHTML, /data-bench-manage-limits/i);
});

test('Admin assignment and per-Sales capacity changes send the selected Sales employee only', async t => {
  const { ui, calls } = install(t, {
    role: 'admin',
    responses: [
      { status: 200, body: payload('admin', [item({ allowedActions: ['assign'] })]) },
      { status: 200, body: payload('admin', [item({ owner: { id: salesOwnerId, name: 'Morgan Lee' }, allowedActions: ['reassign', 'release'] })]) },
      { status: 200, body: payload('admin', [], { caseload: { claimed: 0, capacity: 55 }, salesOwners: [{ id: salesOwnerId, name: 'Morgan Lee', claimed: 0, capacity: 55, available: true }] }) }
    ]
  });
  const target = fakeTarget();
  ui.mount(target, { role: 'admin' });
  await settle();

  assert.equal(await ui.changeOwnership('assign', applicantId, salesOwnerId), true);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    requestId, action: 'assign', applicantId, expectedUpdatedAt: updatedAt, salesOwnerId
  });
  assert.equal(await ui.changeLimit(salesOwnerId, 55), true);
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    requestId, action: 'set_limit', salesOwnerId, caseloadLimit: 55
  });
});

test('409 conflicts surface a safe message and trigger a silent refresh', async t => {
  const { ui, calls } = install(t, {
    responses: [
      { status: 200, body: payload('sales') },
      { status: 409, body: { code: 'claim_conflict', message: 'This Talent was just claimed. Reload the bench.' } },
      { status: 200, body: payload('sales', []) }
    ]
  });
  const target = fakeTarget();
  ui.mount(target, { role: 'sales' });
  await settle();
  assert.equal(await ui.changeOwnership('claim', applicantId), false);
  await settle();
  assert.equal(calls.length, 3);
  assert.equal(calls[2].options.method, 'GET');
  assert.match(target.innerHTML, /just claimed|claim.*no longer available|Reload the bench/i);
});

test('loading, errors, empty results, accessible controls, and keyboard-safe dialogs are explicit', () => {
  assert.match(source, /bench-loading[\s\S]*role="status"/i);
  assert.match(source, /bench-error[\s\S]*role="alert"[\s\S]*data-bench-refresh/i);
  assert.match(source, /bench-empty[\s\S]*No matching Talent[\s\S]*data-bench-clear/i);
  for (const id of ['bench-search', 'bench-va-type', 'bench-verified-skill', 'bench-availability', 'bench-rate-min', 'bench-rate-max']) {
    if (id === 'bench-search' || id.startsWith('bench-rate-')) {
      assert.match(source, new RegExp(`(?:for|id)=["']${id}["']`, 'i'));
    } else {
      assert.match(source, new RegExp(`selectMarkup\\(["']${id}["']`, 'i'));
    }
  }
  for (const action of ['claim', 'assign', 'reassign', 'release']) {
    assert.match(source, new RegExp(`data-bench-action=["'](?:\\$\\{[^}]+\\}|${action})["']|['"]${action}['"]`, 'i'));
  }
  assert.match(source, /dialog\.addEventListener\?\.\('cancel'[\s\S]*preventDefault/i);
  assert.match(source, /\.focus\?\.\(\)[\s\S]*setSelectionRange/i);
  assert.match(css, /\.bench-profile-link:focus-visible/i);
  assert.match(css, /@media\s*\(max-width:\s*680px\)[\s\S]*\.bench-filters\s*\{\s*grid-template-columns:\s*1fr 1fr/i);
  assert.match(css, /@media\s*\(max-width:\s*430px\)[\s\S]*\.bench-talent-card\s*\{\s*display:\s*block/i);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/i);
});

test('navigation and routing expose the bench only through authorized employee workspaces', () => {
  assert.match(html, /id="available-talent-nav"\s+data-view="available-talent"\s+hidden/i);
  assert.match(html, /available-talent-bench\.css\?v=20260901-available-talent-bench/i);
  assert.match(html, /available-talent-bench\.js\?v=20260901-available-talent-bench/i);
  for (const role of ['admin', 'talent_management', 'sales', 'sales_management']) {
    assert.match(operations, new RegExp(`${role}:new Set\\(\\[[^\\]]*'available-talent'`, 'i'));
  }
  for (const role of ['billing', 'client_admin', 'client_reviewer', 'client_billing', 'virtual_assistant']) {
    const views = operations.match(new RegExp(`${role}:new Set\\(\\[([^\\]]*)\\]\\)`, 'i'))?.[1] || '';
    assert.equal(views.includes('available-talent'), false, `${role} must not expose the bench`);
  }
  assert.match(operations, /current==='available-talent'[\s\S]*soroAvailableTalentBench\.mount\(root,\{role:currentAuthenticatedRole\(\)\}\)/i);
});
