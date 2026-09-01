const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.join(__dirname, '..');

function read(relativePath) {
  const absolutePath = path.join(projectRoot, relativePath);
  assert.equal(fs.existsSync(absolutePath), true, `${relativePath} must exist.`);
  return fs.readFileSync(absolutePath, 'utf8');
}

function loadApi(overrides = {}) {
  const source = read('operations/internal-client-profile.js');
  const window = {
    location: { origin: 'https://thesorogroup.com' },
    ...overrides
  };
  window.window = window;
  const context = vm.createContext({ AbortController, console, encodeURIComponent, URL, window });
  vm.runInContext(source, context, { filename: 'internal-client-profile.js' });
  return window.SoroInternalClientProfile;
}

function rootElement() {
  return {
    innerHTML: '',
    querySelector() { return null; }
  };
}

test('the internal Client profile exposes an isolated renderer and loader', () => {
  const api = loadApi();
  ['load', 'mount', 'normalizeProfile', 'render', 'renderError', 'renderLoading', 'renderNotFound', 'unmount'].forEach(method => {
    assert.equal(typeof api?.[method], 'function', `${method} must be public.`);
  });
  const source = read('operations/internal-client-profile.js');
  assert.match(source, /window\.SoroInternalClientProfile\s*=\s*Object\.freeze/);
});

test('the ready view shows business identity, lifecycle, active contact, and authorized fields', () => {
  const api = loadApi();
  const html = api.render({
    clientId: 'client-123',
    companyName: 'Northstar Legal',
    company: {
      phone: '+1 214 555 0188',
      website: 'northstar.example',
      addressLine1: '100 Main Street', city: 'Dallas', stateRegion: 'Texas', postalCode: '75201', country: 'United States'
    },
    industry: 'Legal services',
    lifecycleStage: 'ready_for_matching',
    owner: { fullName: 'Morgan Lee' },
    contacts: [{
      fullName: 'Taylor Morgan',
      contactRole: 'primary',
      email: 'taylor@northstar.example',
      phone: '+1 214 555 0177'
    }]
  });

  assert.match(html, /data-profile-state="ready"/);
  assert.match(html, /← Back to Clients/);
  assert.match(html, />Northstar Legal</);
  assert.match(html, />Legal services</);
  assert.match(html, />Ready For Matching</);
  assert.match(html, />Morgan Lee</);
  assert.match(html, />Taylor Morgan</);
  assert.match(html, />Primary</);
  assert.match(html, /mailto:taylor@northstar\.example/);
  assert.match(html, /tel:\+12145550188/);
  assert.match(html, /href="https:\/\/northstar\.example\/"/);
  assert.match(html, /100 Main Street[\s\S]*Dallas, Texas, 75201[\s\S]*United States/);
});

test('omitted backend fields stay omitted and an inactive contact is never shown', () => {
  const api = loadApi();
  const html = api.render({
    company: { name: 'Private Client', industry: 'Professional services' },
    lifecycle_stage: 'active',
    primary_contact: {
      active: false,
      full_name: 'Former Contact',
      email: 'former@example.com',
      phone: '+1 555 0100'
    },
    talents: [{ name: 'Sensitive Talent Name' }],
    birthDate: '1990-01-01',
    payroll: '$9,999',
    internalNotes: 'Never expose this note'
  });

  assert.match(html, /No active primary contact is recorded/);
  assert.doesNotMatch(html, /Former Contact|former@example\.com|555 0100/);
  assert.doesNotMatch(html, /Company contact|Company phone|Company email|Website|Address/);
  assert.doesNotMatch(html, /Profile owner/);
  assert.doesNotMatch(html, /Sensitive Talent Name|1990-01-01|\$9,999|Never expose this note/);

  const secondaryOnly = api.render({
    companyName: 'Secondary Only',
    contacts: [{ fullName: 'Billing Contact', contactRole: 'billing', email: 'billing@example.com' }]
  });
  assert.match(secondaryOnly, /No active primary contact is recorded/);
  assert.doesNotMatch(secondaryOnly, /Billing Contact|billing@example\.com/);
});

test('profile values are escaped and unsafe website schemes never become links', () => {
  const api = loadApi();
  const html = api.render({
    company: {
      name: '<img src=x onerror=alert(1)>',
      industry: '<script>alert(2)</script>',
      website: 'javascript:alert(3)',
      email: 'bad\" onclick="alert(4)@example.com'
    },
    lifecycleStage: '<svg onload=alert(5)>',
    primaryContact: { active: true, fullName: '<b>Contact</b>' }
  });

  assert.doesNotMatch(html, /<img|<script|<svg|<b>Contact/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.doesNotMatch(html, /mailto:bad/i);
});

test('loading, error, and not-found states are accessible and retain the Clients return action', () => {
  const api = loadApi();
  const loading = api.renderLoading();
  const error = api.renderError('<unsafe>');
  const missing = api.renderNotFound();

  assert.match(loading, /aria-busy="true"/);
  assert.match(loading, /role="status"/);
  assert.match(error, /role="alert"/);
  assert.match(error, /data-internal-client-retry/);
  assert.match(error, /&lt;unsafe&gt;/);
  assert.match(missing, /Client not found/);
  assert.match(missing, /unavailable or you do not have access/);
  [loading, error, missing].forEach(html => assert.match(html, /href="#clients"[^>]*data-internal-client-back/));
});

test('the loader requests one authorized Client by opaque id without caching the response', async () => {
  let requestedUrl = '';
  let requestedOptions = null;
  const api = loadApi({
    soroSupabase: {
      auth: {
        async getSession() {
          return { data: { session: { access_token: 'secure-token' } }, error: null };
        }
      }
    }
  });
  const root = rootElement();
  const profile = await api.load(root, {
    id: 'client_ABC-123',
    endpoint: '/secure/client-profile',
    async fetch(url, options) {
      requestedUrl = url;
      requestedOptions = options;
      return {
        ok: true,
        status: 200,
        async json() {
          return { profile: { company: { name: 'Loaded Company' }, lifecycleStage: 'active' } };
        }
      };
    }
  });

  assert.equal(requestedUrl, '/secure/client-profile?id=client_ABC-123');
  assert.equal(requestedOptions.method, 'GET');
  assert.equal(requestedOptions.cache, 'no-store');
  assert.equal(requestedOptions.headers.Authorization, 'Bearer secure-token');
  assert.equal(profile.companyName, 'Loaded Company');
  assert.match(root.innerHTML, /Loaded Company/);
});

test('the loader renders a neutral not-found state for invalid ids and 404 responses', async () => {
  const api = loadApi({
    soroSupabase: {
      auth: {
        async getSession() {
          return { data: { session: { access_token: 'secure-token' } }, error: null };
        }
      }
    }
  });
  const invalidRoot = rootElement();
  const invalidResult = await api.load(invalidRoot, { id: '../private' });
  assert.equal(invalidResult, null);
  assert.match(invalidRoot.innerHTML, /Client not found/);

  const missingRoot = rootElement();
  const missingResult = await api.load(missingRoot, {
    id: 'valid-id',
    async fetch() {
      return { ok: false, status: 404, async json() { return {}; } };
    }
  });
  assert.equal(missingResult, null);
  assert.match(missingRoot.innerHTML, /unavailable or you do not have access/);
  assert.doesNotMatch(missingRoot.innerHTML, /valid-id/);
});

test('profile CSS is namespaced, responsive, and honors reduced motion', () => {
  const css = read('operations/internal-client-profile.css');
  assert.match(css, /\.internal-client-profile-heading/);
  assert.match(css, /\.internal-client-profile-grid/);
  assert.match(css, /@media \(max-width: 720px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /var\(--navy\)/);
  assert.match(css, /var\(--orange\)/);
});
