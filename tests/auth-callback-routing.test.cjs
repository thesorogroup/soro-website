const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const workspace = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(workspace, 'operations', name), 'utf8');
const page = read('index.html');
const scriptNames = [...page.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)]
  .map(match => match[1].split('?')[0]);
const bootScripts = ['operations.js', 'operations-enhancements.js', 'auth.js'];
const USER_ID = '11111111-1111-4111-8111-111111111111';
const PROFILE_ID = '22222222-2222-4222-8222-222222222222';

function eventSurface() {
  const handlers = new Map();
  return {
    addEventListener(name, callback) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(callback);
    },
    dispatchEvent(event) {
      for (const callback of handlers.get(event.type) || []) callback(event);
      return true;
    }
  };
}

function element(id = '') {
  return {
    ...eventSurface(), id, hidden: ['app', 'auth-gate', 'password-recovery-gate', 'first-password-gate'].includes(id),
    dataset: {}, className: '', textContent: '', innerHTML: '', disabled: false,
    classList: { add() {}, remove() {}, toggle() {} },
    elements: { newPassword: { focus() {} }, confirmPassword: {}, currentPassword: { focus() {} } },
    replaceChildren() { this.innerHTML = ''; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return this; }, setAttribute() {}, reset() {}, focus() {}, close() {}, showModal() {}, remove() {}
  };
}

function bootHarness(initialUrl, { sessionRole = null, recovery = false } = {}) {
  const elements = new Map();
  const getElement = id => {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  };
  const document = {
    ...eventSurface(), title: 'Soro Ops', body: element('body'),
    getElementById: getElement, querySelector: () => null, querySelectorAll: () => [],
    createElement: () => element(), createTextNode: value => ({ textContent: value })
  };
  const location = new URL(initialUrl);
  const replacements = [];
  const history = {
    replaceState(_state, _title, next) {
      const resolved = new URL(next, location);
      replacements.push(resolved.href);
      location.href = resolved.href;
    },
    pushState(state, title, next) { this.replaceState(state, title, next); }
  };
  const timers = [];
  const schedule = (callback, delay = 0) => { timers.push({ callback, delay }); return timers.length; };
  const window = {
    ...eventSurface(), document, location, history, setTimeout: schedule,
    SORO_SUPABASE_CONFIG: { url: 'https://callback-tests.supabase.co', publishableKey: 'synthetic-public-key' }
  };
  const session = sessionRole ? {
    user: { id: USER_ID, email: 'synthetic@example.test', user_metadata: {} },
    access_token: 'synthetic-session-only'
  } : null;
  const access = sessionRole ? {
    role: sessionRole, organization_id: PROFILE_ID, active: true,
    display_name: 'Synthetic User', must_change_password: recovery,
    initial_password_issued_at: new Date().toISOString(), password_changed_at: null
  } : null;
  const observed = { url: null, recoveryFragment: false, clientCreated: false };
  window.supabase = {
    createClient() {
      observed.clientCreated = true;
      observed.url = location.href;
      const fragment = new URLSearchParams(location.hash.slice(1));
      observed.recoveryFragment = fragment.get('type') === 'recovery'
        && fragment.get('access_token') === 'synthetic-callback-only';
      const query = {
        select() { return this; }, eq() { return this; }, is() { return this; },
        maybeSingle: async () => ({ data: access, error: null }),
        order: async () => ({ data: [], error: null })
      };
      return {
        from: () => query,
        auth: {
          onAuthStateChange(callback) {
            if (recovery && observed.recoveryFragment) {
              schedule(() => callback('PASSWORD_RECOVERY', session));
            }
          },
          getSession: async () => ({ data: { session } }),
          signOut: async () => ({ error: null })
        }
      };
    }
  };
  const sandbox = {
    window, document, location, history, URL, URLSearchParams, console,
    setTimeout: schedule,
    MutationObserver: class { observe() {} disconnect() {} },
    CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    fetch: () => { throw new Error('Network access is forbidden in callback routing tests.'); }
  };
  const context = vm.createContext(sandbox);
  const run = name => vm.runInContext(read(name), context, { filename: `operations/${name}`, timeout: 1000 });
  async function flushTimers(maximumDelay = 0) {
    for (let pass = 0; pass < 8; pass += 1) {
      await Promise.resolve();
      const ready = timers.filter(timer => timer.delay <= maximumDelay);
      for (const timer of ready) {
        timers.splice(timers.indexOf(timer), 1);
        await timer.callback();
      }
    }
  }
  return {
    context, location, observed, replacements, getElement, window, run, flushTimers,
    runBeforeAuth() {
      for (const name of scriptNames) {
        if (name === 'auth.js') break;
        if (bootScripts.includes(name)) run(name);
      }
    },
    async finishAuth() {
      run('auth.js');
      await flushTimers();
    }
  };
}

test('callback regression executes the real router, enhancement, and auth scripts in page order', () => {
  const positions = bootScripts.map(name => scriptNames.indexOf(name));
  assert.ok(positions.every(index => index >= 0));
  assert.ok(positions[0] < positions[1] && positions[1] < positions[2],
    'Update the integration harness if the page bootstrap order changes.');
});

test('pre-auth rendering preserves the recovery callback until the Auth client reads it and opens password setup', async () => {
  const initial = 'https://thesorogroup.com/operations/?accountSetup=1#access_token=synthetic-callback-only&refresh_token=synthetic-refresh-only&type=recovery';
  const harness = bootHarness(initial, { sessionRole: 'client_admin', recovery: true });
  harness.getElement('view-root').innerHTML = '<p>Stale private workspace</p>';
  harness.runBeforeAuth();
  assert.equal(harness.location.href, initial);
  assert.equal(harness.replacements.length, 0);
  assert.equal(harness.getElement('view-root').innerHTML, '');
  assert.equal(harness.getElement('app').hidden, true);
  assert.equal(harness.observed.clientCreated, false);

  await harness.finishAuth();
  assert.equal(harness.observed.url, initial);
  assert.equal(harness.observed.recoveryFragment, true);
  assert.equal(harness.getElement('password-recovery-gate').hidden, false);
  assert.equal(harness.getElement('auth-gate').hidden, true);
  assert.equal(harness.getElement('first-password-gate').hidden, true);
  assert.equal(harness.getElement('app').hidden, true);
});

test('ordinary signed-out startup clears stale workspace content and keeps private surfaces locked', async () => {
  const harness = bootHarness('https://thesorogroup.com/operations/');
  harness.getElement('view-root').innerHTML = '<p>Stale private workspace</p>';
  harness.runBeforeAuth();
  assert.equal(harness.getElement('view-root').innerHTML, '');
  assert.equal(harness.getElement('app').hidden, true);
  await harness.finishAuth();
  assert.equal(harness.getElement('auth-gate').hidden, false);
  assert.equal(harness.getElement('password-recovery-gate').hidden, true);
  assert.equal(harness.getElement('first-password-gate').hidden, true);
  assert.equal(harness.getElement('view-root').innerHTML, '');
  assert.equal(harness.getElement('app').hidden, true);
});

test('an invalid or expired callback without a recovery event times out behind the locked workspace', async () => {
  const initial = 'https://thesorogroup.com/operations/?accountSetup=1#access_token=synthetic-callback-only&type=recovery';
  const harness = bootHarness(initial);
  harness.runBeforeAuth();
  await harness.finishAuth();
  assert.equal(harness.observed.url, initial);
  assert.equal(harness.getElement('auth-checking').hidden, false);
  assert.equal(harness.getElement('auth-gate').hidden, true);
  assert.equal(harness.getElement('password-recovery-gate').hidden, true);
  assert.equal(harness.getElement('app').hidden, true);

  // Run the actual ten-second timeout callback without sleeping or using Auth.
  await harness.flushTimers(10000);
  assert.equal(harness.getElement('auth-checking').hidden, true);
  assert.equal(harness.getElement('auth-gate').hidden, false);
  assert.equal(harness.getElement('password-recovery-gate').hidden, true);
  assert.equal(harness.getElement('first-password-gate').hidden, true);
  assert.equal(harness.getElement('app').hidden, true);
  assert.match(harness.getElement('auth-message').textContent, /invalid or has expired/i);
  assert.equal(harness.location.hash.includes('synthetic-callback-only'), false);
});

test('the accountSetup query marker alone cannot open password setup without a validated recovery session', async () => {
  const initial = 'https://thesorogroup.com/operations/?accountSetup=1';
  const harness = bootHarness(initial);
  harness.runBeforeAuth();
  assert.equal(harness.location.href, initial);
  await harness.finishAuth();
  assert.equal(harness.observed.url, initial);
  assert.equal(harness.observed.recoveryFragment, false);
  assert.equal(harness.getElement('auth-gate').hidden, false);
  assert.equal(harness.getElement('password-recovery-gate').hidden, true);
  assert.equal(harness.getElement('first-password-gate').hidden, true);
  assert.equal(harness.getElement('view-root').innerHTML, '');
  assert.equal(harness.getElement('app').hidden, true);
});

test('authenticated forbidden routes still normalize to the authorized overview', async () => {
  const harness = bootHarness('https://thesorogroup.com/operations/#reports', { sessionRole: 'client_admin' });
  harness.runBeforeAuth();
  assert.equal(harness.location.hash, '#reports');
  await harness.finishAuth();
  assert.equal(harness.location.hash, '#overview');
  assert.equal(vm.runInContext('current', harness.context), 'overview');
  assert.equal(harness.getElement('app').hidden, false);
  assert.equal(harness.getElement('auth-gate').hidden, true);
});

for (const [route, view, selected] of [
  ['client', 'client-record', 'selectedClientId'],
  ['talent', 'talent-profile', 'selectedTalentId']
]) {
  test(`${route} profile deep links survive initial authentication`, async () => {
    const initial = `https://thesorogroup.com/operations/#${route}/${PROFILE_ID}`;
    const harness = bootHarness(initial, { sessionRole: 'sales' });
    harness.runBeforeAuth();
    assert.equal(harness.location.href, initial);
    assert.equal(vm.runInContext('current', harness.context), view);
    await harness.finishAuth();
    assert.equal(harness.observed.url, initial);
    assert.equal(harness.location.href, initial);
    assert.equal(vm.runInContext('current', harness.context), view);
    assert.equal(vm.runInContext(selected, harness.context), PROFILE_ID);
    assert.equal(harness.getElement('app').hidden, false);
  });
}
