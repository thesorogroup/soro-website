'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const applicantId = '22222222-2222-4222-8222-222222222222';
const actorId = '11111111-1111-4111-8111-111111111111';
const organizationId = '33333333-3333-4333-8333-333333333333';
const updatedAt = '2026-09-14T12:00:00.000000+00:00';
const clone = value => JSON.parse(JSON.stringify(value));
const record = extra => ({ id: applicantId, organization_id: organizationId, updated_at: updatedAt,
  full_name: 'Rivera, Ana', email: 'ana@example.com', phone: null, timezone: 'Asia/Manila', country: 'Philippines', city: null, location: null, ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const decode = value => String(value ?? '').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

class Element {
  constructor() {
    this.listeners = new Map(); this.children = []; this.dataset = {}; this.disabled = false; this.hidden = false; this.textContent = ''; this.removed = false;
    const names = new Set();
    this.classList = { add: key => names.add(key), remove: key => names.delete(key), contains: key => names.has(key), toggle(key, force) { if (force) names.add(key); else names.delete(key); } };
  }
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(callback); }
  removeEventListener() {}
  async fire(type, extra = {}) { const event = { target: this, preventDefault() {}, ...extra }; return Promise.all((this.listeners.get(type) || []).map(callback => callback(event))); }
  append(child) { this.children.push(child); }
  prepend(child) { this.children.unshift(child); }
  setAttribute(key, value) { this[key] = value; }
  remove() { this.removed = true; }
  focus() { this.focused = true; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}
class Form extends Element {
  constructor(html) {
    super(); this.elements = {}; this.labels = {}; this.status = new Element(); this.progress = new Element(); this.locationMissing = new Element();
    this.submit = new Element(); this.submit.textContent = 'Save Core Profile'; this.valid = true;
    for (const match of html.matchAll(/<input name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/g)) {
      const input = new Element(); input.value = decode(match[2]); this.elements[match[1]] = input;
    }
    const timezone = new Element();
    timezone.value = decode(/<option value="([^"]*)" selected>/.exec(html)?.[1] || ''); this.elements.timezone = timezone;
    for (const key of ['full_name', 'email', 'phone', 'timezone']) {
      const label = new Element(), missing = new Element(); label.querySelector = () => missing; this.labels[key] = label;
    }
    this.closeControls = [new Element(), new Element()];
    this.controls = [...Object.values(this.elements), this.submit, ...this.closeControls];
  }
  reportValidity() { return this.valid; }
  querySelector(selector) {
    if (selector === '[data-core-status]') return this.status;
    if (selector === '[data-core-completion]') return this.progress;
    if (selector === '[data-core-location-missing]') return this.locationMissing;
    if (selector === '[type="submit"]') return this.submit;
    return this.labels[/\[data-core-field="([^"]+)"\]/.exec(selector)?.[1]] || null;
  }
  querySelectorAll(selector) { return selector === 'input,select,button' ? this.controls : selector === '[data-core-close]' ? this.closeControls : []; }
}
class Dialog extends Element {
  set innerHTML(html) { this.html = html; this.form = html.includes('<form ') ? new Form(html) : null; this.loading = new Element(); this.loadingStatus = new Element(); this.footerActions = new Element(); }
  get innerHTML() { return this.html; }
  showModal() { this.open = true; }
  close() { this.open = false; this.fire('close'); }
  querySelector(selector) { return selector === 'footer>div' ? this.footerActions : selector === 'form' ? this.form : selector === '[data-core-status]' ? this.form?.status || this.loadingStatus : selector === '.core-profile-loading' ? this.loading : null; }
}

function setup() {
  const state = { record: record(), loadCalls: [], saveCalls: [], afterSave: [], dialogs: [], scope: 'one', authorized: true };
  const listeners = new Map();
  const context = vm.createContext({ Intl, console, Response, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, setInterval: () => 0,
    document: { body: new Element(), visibilityState: 'visible', createElement(tag) { const result = tag === 'dialog' ? new Dialog() : new Element(); if (tag === 'dialog') state.dialogs.push(result); return result; }, getElementById() { return null; }, querySelector() { return null; }, addEventListener() {} },
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(callback); },
    dispatchEvent() {}, CustomEvent: class CustomEvent { constructor(type, detail) { this.type = type; this.detail = detail; } },
    soroCurrentAccess: { user_id: actorId, organization_id: organizationId, role: 'talent_management', active: true, must_change_password: false },
    soroSupabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'test-token' } } }) } }
  });
  vm.runInContext(read('operations/talent-core-profile-data.js'), context);
  const validation = context.soroTalentCoreProfileData;
  const service = {
    ...validation, authorized: () => state.authorized, scope: () => state.scope,
    load: async id => { state.loadCalls.push(id); return { record: clone(state.record), scope: state.scope }; },
    save: async (id, snapshot, values) => { state.saveCalls.push({ id, snapshot, values: clone(values) }); state.record = { ...state.record, ...validation.normalizeValues(values), updated_at: '2026-09-14T13:00:00.000000+00:00' }; return { record: clone(state.record), scope: state.scope }; }
  };
  context.soroTalentCoreProfileData = service;
  vm.runInContext(read('operations/talent-core-profile-editor.js'), context);
  const api = context.soroTalentCoreProfileEditor;
  const open = () => api.open({ applicantId }, saved => { state.afterSave.push(saved); });
  const event = async type => { for (const callback of listeners.get(type) || []) await callback({}); };
  return { api, state, context, service, open, event, dialog: () => state.dialogs.at(-1), validation };
}

test('loading reveals no editable controls and cancel discards a late profile response', async () => {
  const s = setup(), gate = deferred(); s.service.load = () => gate.promise;
  const pending = s.open();
  assert.equal(s.api.isOpen(), true); assert.equal(s.dialog().form, null); assert.match(s.dialog().innerHTML, /Loading profile details/);
  assert.equal(s.api.close(), true); gate.resolve({ record: record() }); assert.equal(await pending, false);
  assert.equal(s.dialog().removed, true); assert.equal(s.dialog().form, null);
});

test('load failure offers retry without rendering incomplete or cached applicant data', async () => {
  const s = setup(); s.service.load = async () => { throw new Error('Temporarily unavailable.'); };
  assert.equal(await s.open(), false); assert.equal(s.dialog().form, null); assert.equal(s.dialog().loadingStatus.textContent, 'Temporarily unavailable.');
  const failed = s.dialog(), retry = failed.loading.children[0]; assert.equal(retry.textContent, 'Try Again');
  s.service.load = async () => ({ record: record() }); await retry.fire('click');
  assert.equal(failed.removed, true); assert.ok(s.dialog().form); assert.equal(s.dialog().form.elements.phone.focused, true);
});

test('save locks every control immediately, blocks duplicates and unlocks preserved fields after failure', async () => {
  const s = setup(); await s.open(); const form = s.dialog().form, gate = deferred(); let saves = 0;
  s.service.save = async () => { saves += 1; return gate.promise; };
  form.elements.phone.value = '+63 912 345 6789'; form.elements.city.value = 'Cebu';
  const pending = form.fire('submit');
  assert.equal(saves, 1); assert.equal(form.controls.every(control => control.disabled), true); assert.equal(form.submit.textContent, 'Saving…');
  assert.equal(s.api.close(), false); assert.equal(await s.open(), false); await form.fire('submit'); assert.equal(saves, 1);
  gate.reject(new Error('Another reviewer changed this profile. Reopen it.')); await pending;
  assert.equal(s.api.isOpen(), true); assert.equal(form.controls.every(control => !control.disabled), true);
  assert.equal(form.elements.phone.value, '+63 912 345 6789'); assert.equal(form.elements.city.value, 'Cebu');
  assert.match(form.status.textContent, /Another reviewer/); assert.equal(form.status.classList.contains('is-error'), true);
  assert.equal(form.submit.textContent, 'Save Core Profile'); assert.equal(s.state.afterSave.length, 0);
});

test('native validity failure does not start a save or disable the form', async () => {
  const s = setup(); await s.open(); const form = s.dialog().form; form.valid = false;
  await form.fire('submit'); assert.equal(s.state.saveCalls.length, 0); assert.equal(form.controls.some(control => control.disabled), false);
});

test('saved-but-unrefreshed details stay locked and offer a fresh reload instead of another save', async () => {
  const s = setup(); await s.open(); const dialog = s.dialog(), form = dialog.form;
  s.service.save = async () => {
    s.state.record = record({ city: 'Cebu', updated_at: '2026-09-14T13:00:00Z' });
    const error = new Error('The core profile was saved, but its latest details could not be refreshed.'); error.saved = true; throw error;
  };
  form.elements.city.value = 'Cebu'; await form.fire('submit');
  assert.equal(s.api.isOpen(), true); assert.equal(form.submit.disabled, true); assert.equal(form.submit.textContent, 'Saved');
  assert.equal(Object.values(form.elements).every(control => control.disabled), true);
  assert.equal(form.closeControls.every(control => !control.disabled), true);
  assert.equal(s.state.afterSave.length, 0);
  const reload = form.status.children[0]; assert.equal(reload.textContent, 'Reload Saved Profile');
  await reload.fire('click');
  assert.equal(dialog.removed, true); assert.notEqual(s.dialog(), dialog);
  assert.equal(s.dialog().form.elements.city.value, 'Cebu'); assert.equal(s.dialog().form.submit.disabled, false);
});

test('live progress shows missing details, but a partial save closes with missing core fields', async () => {
  const s = setup(); await s.open(); const form = s.dialog().form;
  assert.match(form.progress.textContent, /3 of 5.*Phone Number, Location/);
  assert.equal(form.labels.phone.classList.contains('is-missing'), true); assert.equal(form.locationMissing.hidden, false);
  form.elements.city.value = 'Cebu'; await form.fire('input');
  assert.match(form.progress.textContent, /4 of 5.*Phone Number/); assert.equal(form.locationMissing.hidden, true);
  await form.fire('submit');
  assert.equal(s.api.isOpen(), false); assert.equal(s.state.afterSave.length, 1);
  assert.deepEqual(clone(s.validation.missingFields(s.state.afterSave[0].record)), ['phone']);
  assert.deepEqual(Object.keys(s.state.saveCalls[0].values).sort(), ['city', 'country', 'email', 'full_name', 'phone', 'timezone']);
});

test('all-filled progress is provisional until save succeeds and existing location remains read-only', async () => {
  const s = setup(); s.state.record = record({ location: 'Legacy City, Philippines', phone: '1234' }); await s.open();
  const form = s.dialog().form;
  assert.match(form.progress.textContent, /All 5.*Save to update the checklist/); assert.match(s.dialog().innerHTML, /Previously Recorded Location/);
  assert.equal(form.elements.location, undefined); assert.equal(s.state.afterSave.length, 0);
  await form.fire('submit'); assert.deepEqual(clone(s.validation.missingFields(s.state.afterSave[0].record)), []);
  assert.doesNotMatch(s.api.markup({ record: record({ location: '   ' }) }), /This existing location already satisfies/);
});

test('auth changes discard both loading responses and a save callback from the previous account', async () => {
  for (const phase of ['loading', 'saving']) {
    const s = setup(), gate = deferred(); let pending;
    if (phase === 'loading') { s.service.load = () => gate.promise; pending = s.open(); }
    else { await s.open(); s.service.save = () => gate.promise; pending = s.dialog().form.fire('submit'); }
    s.state.authorized = false; s.state.scope = 'other'; await s.event('soro-auth-changed');
    assert.equal(s.api.isOpen(), false); assert.equal(s.dialog().removed, true);
    gate.resolve({ record: record({ phone: 'saved' }) }); await pending; assert.equal(s.state.afterSave.length, 0);
  }
});

test('route change closes and discards an unsaved editor, while unauthorized open does nothing', async () => {
  const s = setup(); await s.open(); s.dialog().form.elements.city.value = 'Unsubmitted'; await s.event('hashchange');
  assert.equal(s.api.isOpen(), false); assert.equal(s.state.saveCalls.length, 0);
  s.state.authorized = false; assert.equal(await s.open(), false); assert.equal(s.state.dialogs.length, 1);
});

test('applicant-supplied names, values, custom time zones and legacy locations are escaped', () => {
  const s = setup();
  const markup = s.api.markup({ record: record({ full_name: '<script>alert(1)</script>', email: 'a" autofocus="true', location: '<img src=x onerror=alert(2)>', timezone: '"><script>zone()</script>' }) });
  assert.doesNotMatch(markup, /<script>|<img|value="a" autofocus/);
  assert.match(markup, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/); assert.match(markup, /a&quot; autofocus=&quot;true/);
  assert.match(markup, /&lt;img src=x onerror=alert\(2\)&gt;/);
});

function queuePayload(r, validation) {
  return { generatedAt: updatedAt, viewerRole: 'talent_management', summary: { all: 1, submitted: 0, in_review: 1, needs_more_info: 0, bench_ready: 0, closed: 0 },
    applicants: [{ applicantId, fullName: r.full_name, preferredName: null, email: r.email, applicationReceivedAt: updatedAt, updatedAt: r.updated_at,
      stage: 'in_review', archived: false, owner: { id: actorId, name: 'Reviewer' }, resume: { available: false, label: 'Not attached' },
      checklist: [{ key: 'core_profile', label: 'Core profile', state: validation.missingFields(r).length ? 'missing' : 'complete' }, { key: 'resume', label: 'Resume', state: 'missing' }],
      allowedActions: ['mark_bench_ready', 'request_more_info', 'decline', 'archive'] }]
  };
}
test('queue wiring refreshes authoritative core progress after partial and complete saves', async () => {
  const s = setup(), host = new Element(); let requests = 0;
  s.context.fetch = async () => { requests += 1; return new Response(JSON.stringify(queuePayload(s.state.record, s.validation)), { status: 200 }); };
  vm.runInContext(read('operations/talent-review-queue.js'), s.context);
  const queue = s.context.soroTalentReviewQueue; queue.mount(host); await tick();
  assert.equal(queue.currentQueue().phase, 'ready'); assert.match(host.innerHTML, /data-review-core-profile/);
  await queue.openCoreProfile(applicantId); s.dialog().form.elements.city.value = 'Cebu'; await s.dialog().form.fire('submit');
  assert.equal(requests, 2); assert.equal(queue.currentQueue().applicants[0].checklist[0].state, 'missing');
  assert.match(host.innerHTML, /Core Profile saved\. Some required details are still missing/);
  await queue.openCoreProfile(applicantId); s.dialog().form.elements.phone.value = '+63 912 345 6789'; await s.dialog().form.fire('submit');
  assert.equal(requests, 3); assert.equal(queue.currentQueue().applicants[0].checklist[0].state, 'complete');
  assert.equal(queue.currentQueue().applicants[0].checklist[1].state, 'missing');
  assert.match(host.innerHTML, /Core Profile saved — all core requirements are filled/);
  queue.unmount();
});

test('a successful profile save with failed queue refresh preserves the old checklist and shows a refresh notice', async () => {
  const s = setup(), host = new Element(); let requests = 0;
  const originalSave = s.service.save;
  s.service.save = async (...args) => {
    const saved = await originalSave(...args);
    // PostgreSQL's update token can change below Date.parse's millisecond precision.
    s.state.record.updated_at = '2026-09-14T12:00:00.000001+00:00';
    saved.record.updated_at = s.state.record.updated_at;
    return saved;
  };
  s.context.fetch = async () => {
    requests += 1;
    if (requests > 1) throw new Error('Offline');
    return new Response(JSON.stringify(queuePayload(s.state.record, s.validation)), { status: 200 });
  };
  vm.runInContext(read('operations/talent-review-queue.js'), s.context);
  const queue = s.context.soroTalentReviewQueue; queue.mount(host); await tick();
  await queue.openCoreProfile(applicantId);
  s.dialog().form.elements.city.value = 'Cebu'; s.dialog().form.elements.phone.value = '+63 912 345 6789';
  await s.dialog().form.fire('submit');
  assert.deepEqual(clone(s.validation.missingFields(s.state.record)), []);
  assert.equal(queue.currentQueue().applicants[0].checklist[0].state, 'missing');
  assert.match(host.innerHTML, /Core Profile saved, but the checklist could not be refreshed/);
  assert.doesNotMatch(host.innerHTML, /Core Profile saved — all core requirements are filled/);
  queue.unmount();
});
