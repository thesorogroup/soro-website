const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

function read(relativePath) {
  const absolutePath = path.join(root, relativePath);
  assert.equal(fs.existsSync(absolutePath), true, `${relativePath} must exist.`);
  return fs.readFileSync(absolutePath, 'utf8');
}

function roleViews(source, role) {
  const match = source.match(new RegExp(`\\b${role}\\s*:\\s*new Set\\(\\[([^\\]]*)\\]\\)`, 'i'));
  assert.ok(match, `${role} must have an explicit view allowlist.`);
  return [...match[1].matchAll(/['"]([a-z-]+)['"]/g)].map(item => item[1]);
}

function loadPreview() {
  const source = read('operations/client-profile.js');
  let fetchCalls = 0;
  const window = {
    addEventListener() {},
    clearTimeout,
    setTimeout,
    fetch() { fetchCalls += 1; throw new Error('Preview must not request data.'); }
  };
  window.window = window;
  const context = vm.createContext({ AbortController, console, document: {}, fetch: window.fetch, window });
  vm.runInContext(source, context, { filename: 'client-profile.js' });
  return { preview: window.SORO_CLIENT_PROFILE_PREVIEW, fetchCalls };
}

test('Account Settings is fail-closed to the three authenticated client roles', () => {
  const operations = read('operations/operations.js');
  ['client_admin', 'client_reviewer', 'client_billing'].forEach(role => {
    assert.ok(roleViews(operations, role).includes('my-profile'), `${role} must be able to open Account Settings.`);
  });
  ['admin', 'talent_management', 'sales', 'sales_management', 'billing', 'virtual_assistant'].forEach(role => {
    assert.equal(roleViews(operations, role).includes('my-profile'), false, `${role} must not receive the client profile view.`);
  });
  assert.match(operations, /current==='my-profile'[\s\S]*isAdminWorkspacePreview\('client'\)[\s\S]*authenticatedClientRoles\.has\(actualAuthenticatedRole\(\)\)[\s\S]*SoroClientProfile\?\.canOpenProfile\(\)/);
});

test('the client identity controls open Account Settings while Admin preview stays unchanged', () => {
  const auth = read('operations/auth.js');
  const operations = read('operations/operations.js');
  const html = read('operations/index.html');

  assert.match(auth, /clientProfileRoles\s*=\s*new Set\(\['client_admin',\s*'client_reviewer',\s*'client_billing'\]\)/);
  assert.match(auth, /dataset\.accountAction\s*=\s*clientProfileAvailable\s*\?\s*'my-profile'\s*:\s*\(previewAvailable\s*\?\s*'workspace-preview'/);
  assert.match(auth, /previewAvailable\s*=\s*access\.role\s*===\s*'admin'/);
  assert.match(operations, /dataset\.accountAction==='my-profile'[\s\S]*goToMyProfile\(\)/);
  assert.match(html, /id="client-mobile-profile"[^>]*aria-label="Open Account Settings"[^>]*hidden/);
});

test('the page loads cache-busted profile assets before routing and authentication', () => {
  const html = read('operations/index.html');
  assert.match(html, /client-profile\.css\?v=20260829-client-profile/);
  assert.match(html, /client-profile\.js\?v=20260829-client-profile/);
  assert.ok(html.indexOf('client-profile.js?v=20260829-client-profile') < html.indexOf('operations.js?v=20260901-available-talent-bench'));
  assert.match(html, /auth\.js\?v=20260901-role-view-access/);
});

test('the pure preview renderer is network-free and preserves field authority', () => {
  const { preview, fetchCalls } = loadPreview();
  assert.equal(typeof preview?.renderProfile, 'function');
  const fixture = {
    contact: { fullName: 'Avery Parker', phone: '+1 555 0100' },
    company: {
      name: 'Example Company', industry: 'Professional Services', addressLine1: '10 Main Street',
      addressLine2: '', city: 'Austin', stateRegion: 'Texas', postalCode: '78701',
      country: 'United States', phone: '+1 555 0199', website: 'https://example.com'
    },
    permissions: { canEditCompany: true, editableFields: ['contact.fullName', 'contact.phone', 'company.city'] },
    signInEmail: 'avery@example.com'
  };
  const adminHtml = preview.renderProfile(fixture, 'client_admin');
  const reviewerHtml = preview.renderProfile(fixture, 'client_reviewer');

  assert.equal(fetchCalls, 0);
  assert.match(adminHtml, /name="contactFullName"/);
  assert.match(adminHtml, /name="contactPhone"/);
  assert.match(adminHtml, /name="companyAddressLine1"/);
  assert.match(adminHtml, />Example Company</);
  assert.match(adminHtml, />Professional Services</);
  assert.match(adminHtml, />Client Administrator</);
  assert.match(adminHtml, />avery@example\.com</);
  assert.doesNotMatch(reviewerHtml, /name="companyAddressLine1"/);
  assert.match(reviewerHtml, /Administrator managed/);
  assert.match(reviewerHtml, />Client Reviewer</);
});

test('profile writes use the secure endpoint and only approved mutable fields', () => {
  const source = read('operations/client-profile.js');
  assert.match(source, /ENDPOINT\s*=\s*['"]\/\.netlify\/functions\/client-profile['"]/);
  assert.match(source, /Authorization:\s*`Bearer \$\{session\.access_token\}`/);
  assert.match(source, /request\('GET'\)/);
  assert.match(source, /request\('PATCH',\s*payload\)/);
  assert.match(source, /const contact\s*=\s*\{\}[\s\S]*contact\.fullName[\s\S]*contact\.phone/);
  assert.match(source, /\['addressLine1',\s*'companyAddressLine1'\][\s\S]*\['website',\s*'companyWebsite'\]/);
  ['role', 'email', 'companyName', 'industry', 'lifecycle', 'rate', 'internalNotes'].forEach(field => {
    assert.doesNotMatch(source, new RegExp(`name=["']${field}["']`, 'i'), `${field} must not be an editable input.`);
  });
  assert.match(source, /permissions\.canEditCompany\s*===\s*true\s*&&\s*role\s*===\s*'client_admin'/);
});

test('loading, retry, save feedback, and stale-account protection are accessible', () => {
  const source = read('operations/client-profile.js');
  const css = read('operations/client-profile.css');
  assert.match(source, /aria-busy="true"/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /role="alert"/);
  assert.match(source, /data-client-profile-retry/);
  assert.match(source, /Profile changes saved\./);
  assert.match(source, /requestVersion\s*\+=\s*1/);
  assert.match(source, /activeController\?\.abort\(\)/);
  assert.match(source, /soro-auth-changed[\s\S]*nextKey[\s\S]*reset\(\)/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test('authenticated client placeholders are neutral and global search stays unavailable to Client portal roles', () => {
  const source = read('operations/operations.js');
  const globalSearch = read('operations/global-search.js');
  const safeStart = source.indexOf('const clientSafeViewData=');
  const safeEnd = source.indexOf('\n});', safeStart) + 4;
  assert.ok(safeStart >= 0 && safeEnd > safeStart, 'Client-safe view data must be declared.');
  const safeData = source.slice(safeStart, safeEnd);
  ['Haven & Co.', 'Northstar Legal', 'Sales Pipeline Health', 'Active Talent Attendance', 'Payout History', 'Client Feedback Trends'].forEach(internalName => {
    assert.equal(safeData.includes(internalName), false, `${internalName} must not appear in authenticated client-safe rows.`);
  });
  assert.match(safeData, /reports:\{[\s\S]*rows:\[\]/);
  assert.match(source, /notificationsButton\.hidden=clientPortal/);
  assert.match(source, /globalSearch\)globalSearch\.hidden=clientPortal\|\|accessRole==='virtual_assistant'/);
  assert.match(globalSearch, /const ROLE_TYPES = Object\.freeze\(\{[\s\S]*admin:[\s\S]*talent_management:[\s\S]*sales:[\s\S]*billing:/);
  assert.doesNotMatch(globalSearch, /\bclient_(?:admin|reviewer|billing)\s*:/);
  assert.doesNotMatch(globalSearch, /\bvirtual_assistant\s*:/);
  assert.doesNotMatch(source, /Client Portal search is not connected yet/);
});
