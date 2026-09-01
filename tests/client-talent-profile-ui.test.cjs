const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

function loadPreview(role = 'client_admin') {
  const window = {
    soroCurrentAccess: { role, user_id: 'client-user-1' },
    addEventListener() {},
    setTimeout,
    clearTimeout
  };
  window.window = window;
  const context = vm.createContext({ window, console, AbortController, setTimeout, clearTimeout, Date });
  vm.runInContext(read('operations/talent-profile-visuals.js'), context, { filename: 'talent-profile-visuals.js' });
  vm.runInContext(read('operations/client-talent-profile.js'), context, { filename: 'client-talent-profile.js' });
  return window;
}

const fixture = {
  talents: [
    {
      id: 'talent-1',
      displayName: 'Example, Taylor Alex',
      location: { country: 'Philippines', timeZone: 'Asia/Manila' },
      skills: { verified: ['Medical coding', 'Insurance verification', 'Patient scheduling'] },
      experience: {
        years: 4,
        summary: 'Healthcare support and claims coordination.',
        educationAndTraining: 'Certified medical coding coursework.'
      },
      screening: {
        englishResult: 'C1 - Advanced',
        personalityResult: 'INFJ-A',
        computerSpecifications: 'MacBook Air, 16 GB RAM',
        internetSpeed: '120 Mbps download · 45 Mbps upload'
      },
      assignments: [{ id: 'placement-1', status: 'active', startDate: '2026-08-24', scheduleSummary: 'Weekday schedule' }]
    }
  ],
  count: 1,
  presentation: { tabs: ['profile'], readOnly: true, documentsAvailable: false, sourceFilesAvailable: false }
};

test('Client Portal navigation contains only Dashboard, Talent Profile, Account Settings and Help for Talent viewers', () => {
  const operations = read('operations/operations.js');
  const html = read('operations/index.html');
  assert.match(operations, /client_admin:new Set\(\['overview','client-talent-profile','my-profile','help'\]\)/);
  assert.match(operations, /client_reviewer:new Set\(\['overview','client-talent-profile','my-profile','help'\]\)/);
  assert.match(operations, /client_billing:new Set\(\['overview','my-profile','help'\]\)/);
  assert.doesNotMatch(operations, /client_billing:new Set\([^\n]*client-talent-profile/);
  assert.match(html, /id="client-talent-profile-nav"[^>]*data-view="client-talent-profile"[^>]*hidden>Talent Profile</);
  assert.match(html, /id="client-account-settings-nav"[^>]*data-view="my-profile"[^>]*hidden>Account Settings</);
  assert.match(operations, /overviewNav\.textContent=clientPortal\|\|accessRole==='virtual_assistant'\?'Dashboard':'Overview'/);
});

test('Client Talent Profile mounts only through the authenticated, fail-closed route', () => {
  const operations = read('operations/operations.js');
  const source = read('operations/client-talent-profile.js');
  assert.match(operations, /current==='client-talent-profile'[\s\S]*SoroClientTalentProfile\?\.canOpenTalentProfile\(\)[\s\S]*SoroClientTalentProfile\.mount\(root\)/);
  assert.match(source, /CLIENT_TALENT_ROLES\s*=\s*new Set\(\['client_admin', 'client_reviewer'\]\)/);
  assert.match(source, /ENDPOINT\s*=\s*'\/\.netlify\/functions\/client-talent-profile'/);
  assert.match(source, /method:\s*'GET'/);
  assert.doesNotMatch(source, /\.from\(['"](?:applicants|placements|documents|audit_events)['"]\)/);
  const clientAdmin = loadPreview('client_admin');
  const reviewer = loadPreview('client_reviewer');
  const billing = loadPreview('client_billing');
  assert.equal(clientAdmin.SoroClientTalentProfile.canOpenTalentProfile(), true);
  assert.equal(reviewer.SoroClientTalentProfile.canOpenTalentProfile(), true);
  assert.equal(billing.SoroClientTalentProfile.canOpenTalentProfile(), false);
});

test('Talent Profile pure renderer shows the approved folder view and only client-safe fields', () => {
  const { SORO_CLIENT_TALENT_PROFILE_PREVIEW: preview } = loadPreview();
  const html = preview.renderProfile(fixture);
  assert.match(html, /client-talent-folder/);
  assert.match(html, /client-talent-folder-tab[^>]*aria-current="page">Profile/);
  assert.match(html, /class="client-talent-folder-art"/);
  assert.match(html, /class="client-talent-folder-front-seam" d="M0 85H1240"/);
  assert.match(html, /M31 13\.5C31 2\.5 8 2\.5 8 22v70/);
  assert.match(html, /Example, Taylor Alex/);
  assert.match(html, />Philippines</);
  assert.match(html, />Asia\/Manila</);
  assert.match(html, /Soro verified/);
  assert.match(html, /Medical coding/);
  assert.match(html, /C1 - Advanced/);
  assert.match(html, /MacBook Air, 16 GB RAM/);
  assert.match(html, /120 Mbps download/);
  assert.doesNotMatch(html, />Email<|>Phone<|Street address|Date of birth|Gender identity|Pronouns|Expected rate|Dream \/ goal|Application received|Profile owner|Source file|Open securely|Benefits|Archive|Upload file|Edit profile/i);
});

test('renderer drops non-allowlisted profile values and escapes safe strings', () => {
  const { SORO_CLIENT_TALENT_PROFILE_PREVIEW: preview } = loadPreview();
  const hostile = {
    talents: [{
      ...fixture.talents[0],
      displayName: '<img src=x onerror=alert(1)>',
      email: 'private@example.com',
      phone: '+1 private',
      addressLine1: 'Private street',
      genderIdentity: 'Private identity',
      preferredName: 'Private preferred name',
      documents: [{ fileName: 'private.pdf', storagePath: 'secret/path' }],
      skills: { verified: ['<script>alert(1)</script>'], applicantReported: ['Unverified secret'] }
    }]
  };
  const normalized = preview.normalizeDirectory(hostile);
  const html = preview.renderProfile(normalized);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  ['private@example.com', '+1 private', 'Private street', 'Private identity', 'Private preferred name', 'private.pdf', 'secret/path', 'Unverified secret'].forEach(secret => {
    assert.equal(html.includes(secret), false, `${secret} must not render.`);
  });
});

test('multiple assigned Talent use a clean local chooser without rescoping the endpoint', () => {
  const { SORO_CLIENT_TALENT_PROFILE_PREVIEW: preview } = loadPreview();
  const second = {
    ...fixture.talents[0],
    id: 'talent-2',
    displayName: 'Example, Jordan Lee',
    assignments: [{ id: 'placement-2', status: 'onboarding', startDate: '2026-09-01', scheduleSummary: 'Flexible' }]
  };
  const html = preview.renderProfile({ talents: [fixture.talents[0], second] }, 'talent-2');
  assert.match(html, /data-client-talent-select/);
  assert.match(html, /value="talent-2" selected>Example, Jordan Lee/);
  assert.match(html, /id="client-talent-name">Example, Jordan Lee/);
  const source = read('operations/client-talent-profile.js');
  assert.doesNotMatch(source, /ENDPOINT\s*\+|URLSearchParams|\?talent|\?placement/);
});

test('Account Settings keeps the existing canonical profile editor and updates shell identity', () => {
  const profile = read('operations/client-profile.js');
  const auth = read('operations/auth.js');
  assert.match(profile, /<h1>Account Settings<\/h1>/);
  assert.match(profile, /ENDPOINT\s*=\s*'\/\.netlify\/functions\/client-profile'/);
  assert.match(profile, /updateShellIdentity\(updated\)/);
  assert.match(auth, /Client Administrator.*Account Settings|\$\{accessRoleLabel\[access\.role\]\} · Account Settings/);
  assert.match(auth, /Open Account Settings/);
});

test('Client Talent assets load before routing and include desktop/mobile safeguards', () => {
  const html = read('operations/index.html');
  const css = read('operations/client-talent-profile.css');
  assert.match(html, /client-talent-profile\.css\?v=20260829-production-visuals/);
  assert.match(html, /talent-profile-visuals\.js\?v=20260829-production-visuals/);
  assert.match(html, /client-talent-profile\.js\?v=20260829-production-visuals/);
  assert.ok(html.indexOf('talent-profile-visuals.js?v=20260829-production-visuals') < html.indexOf('client-talent-profile.js?v=20260829-production-visuals'));
  assert.ok(html.indexOf('client-talent-profile.js?v=20260829-production-visuals') < html.indexOf('operations.js?v=20260831-legacy-files'));
  assert.match(css, /grid-template-columns:\s*230px minmax\(0, 1fr\) minmax\(280px, 350px\)/);
  assert.match(css, /@media \(min-width: 1101px\)[\s\S]*\.client-talent-folder-art/);
  assert.match(css, /\.client-talent-folder-front-seam[\s\S]*stroke:\s*rgba\(144, 125, 91, \.24\)/);
  assert.match(css, /\.client-talent-paperclip-wire[\s\S]*stroke:\s*#969da4/);
  assert.match(css, /@media \(max-width: 820px\)[\s\S]*client-talent-hero\s*\{\s*grid-template-columns:\s*1fr/);
  assert.match(css, /@media \(max-width: 540px\)[\s\S]*client-talent-summary-grid\s*\{\s*grid-template-columns:\s*1fr/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
});
