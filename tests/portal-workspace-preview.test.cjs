const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

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

  assert.deepEqual(roleViews(source, 'admin'), ['overview', 'tasks', 'clients', 'vas', 'talent-review', 'talent-profile', 'placements', 'documents', 'reports', 'employees', 'payroll', 'help']);
  assert.deepEqual(roleViews(source, 'sales'), ['overview', 'tasks', 'clients', 'placements', 'reports', 'help']);
  assert.deepEqual(roleViews(source, 'talent_management'), ['overview', 'tasks', 'clients', 'vas', 'talent-review', 'talent-profile', 'placements', 'documents', 'reports', 'talent-payout-review', 'help']);
  assert.deepEqual(roleViews(source, 'client_admin'), ['overview', 'client-talent-profile', 'my-profile', 'help']);
  assert.deepEqual(roleViews(source, 'virtual_assistant'), ['overview', 'talent-my-profile', 'documents', 'help']);

  assert.match(source, /function actualAuthenticatedRole\(access=window\.soroCurrentAccess\)\{return String\(access\?\.role\|\|''\)\.toLowerCase\(\)\}/);
  assert.match(source, /function effectiveWorkspaceRole\([^)]*\)[\s\S]*actualAuthenticatedRole\(access\)[\s\S]*workspacePreviewAccessRole\[role\]/);
  assert.match(source, /function currentAuthenticatedRole\(\)\{return effectiveWorkspaceRole\(\)\}/);
  assert.match(source, /function syncAuthorizedNavigation\([^)]*\)\{\s*const accessRole=effectiveWorkspaceRole\(access\)/);
  assert.match(source, /function applyRole\([^)]*\)[\s\S]*actualAuthenticatedRole\(\)!==['"]admin['"][\s\S]*syncAuthorizedNavigation\(\)[\s\S]*render\(\)/);
  assert.match(source, /profileButton\?\.dataset\.authenticatedRoleLabel/);
  assert.match(source, /profileButton\?\.dataset\.authenticatedName/);
  assert.match(read('operations/auth.js'), /profile\.dataset\.authenticatedRoleLabel\s*=\s*roleLabelForAccess\(access\)/);
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
  assert.match(talentRoute, /SoroClientTalentProfile\.mount\(root\)/);
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

  assert.match(html, /operations\.css\?v=20260829-profile-center/);
  assert.match(html, /sidebar-theme\.css\?v=20260831-fixed-switcher/);
  assert.match(theme, /--sidebar-navy:\s*#082550/);
  assert.match(theme, /--sidebar-hover:\s*#123b6d/);
  assert.match(theme, /--sidebar-active:\s*#1e578e/);
  assert.match(theme, /--sidebar-focus:\s*#ffb37a/);
  assert.match(theme, /--sidebar-badge:\s*#c53d19/);
  assert.match(theme, /#app \[hidden\][\s\S]*display:\s*none !important/);
  assert.match(theme, /\.profile:not\(:disabled\):hover/);
  assert.match(base, /\.profile\{[^}]*padding:10px;[^}]*align-items:center/);
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
