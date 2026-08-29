const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

function roleViews(source, role) {
  const match = source.match(new RegExp(`\\b${role}\\s*:\\s*new Set\\(\\[([^\\]]*)\\]\\)`, 'i'));
  assert.ok(match, `${role} must have an explicit view allowlist.`);
  return [...match[1].matchAll(/['"]([a-z-]+)['"]/g)].map(item => item[1]);
}

function sourceBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `Missing source marker: ${startMarker}`);
  assert.ok(end > start, `Missing source boundary: ${endMarker}`);
  return source.slice(start, end);
}

test('My Profile is a Talent Portal route and is hidden from every real non-Talent role', () => {
  const html = read('operations/index.html');
  const operations = read('operations/operations.js');

  assert.match(html, /id="talent-my-profile-nav"[^>]*data-view="talent-my-profile"[^>]*hidden[^>]*>My Profile<\/button>/);
  assert.ok(roleViews(operations, 'virtual_assistant').includes('talent-my-profile'));
  for (const role of ['admin', 'talent_management', 'sales', 'sales_management', 'billing', 'client_admin', 'client_reviewer', 'client_billing']) {
    assert.equal(roleViews(operations, role).includes('talent-my-profile'), false, `${role} must not receive a real Talent self-profile route.`);
  }
  assert.match(operations, /workspacePreviewAccessRole[^;]*va:'virtual_assistant'/);
});

test('the Talent self-profile loader is explicitly scoped to the authenticated user', () => {
  const operations = read('operations/operations.js');
  const loader = sourceBlock(operations, 'async function loadOwnTalentProfile()', 'function ');

  assert.match(loader, /actualAuthenticatedRole\(access\)!==['"]virtual_assistant['"]/);
  assert.match(loader, /\.from\(['"]applicants['"]\)/);
  assert.match(loader, /\.eq\(['"]auth_user_id['"],\s*access\.user_id\)/);
  assert.match(loader, /\.eq\(['"]organization_id['"],\s*access\.organization_id\)/);
  assert.match(loader, /\.is\(['"]archived_at['"],\s*null\)/);
  assert.match(loader, /\.maybeSingle\(\)/);
  assert.doesNotMatch(loader, /\.select\(['"]\*['"]\)/);
  assert.match(loader, /ownTalentProfile\s*=\s*(?:data|profile|applicant)\s*\|\|\s*null/);
  assert.match(read('supabase/migrations/20260828_020_talent_portal_access.sql'), /auth_user_id = auth\.uid\(\)[\s\S]*private\.current_soro_role\(\) = 'virtual_assistant'/);
});

test('My Profile reuses the canonical enhanced Talent renderer', () => {
  const operations = read('operations/operations.js');
  const enhancements = read('operations/operations-enhancements.js');
  const resolver = sourceBlock(operations, 'function currentTalentProfileApplicant()', 'window.soroCurrentTalentProfileApplicant');
  const route = sourceBlock(enhancements, 'function renderOwnTalentProfile(applicant)', 'window.soroRemoveOwnProfileManagementActions');

  assert.match(resolver, /isTalentSelfProfileView\(\)[\s\S]*isAdminWorkspacePreview\(['"]va['"]\)[\s\S]*ownTalentProfile/);
  assert.match(route, /root\.innerHTML\s*=\s*profilePage\(applicant\)/);
  assert.match(route, /selectedTalentId\s*=\s*applicant\.id/);
  assert.match(route, /removeOwnProfileManagementActions\(root\)/);
  assert.match(route, /bindView\(\)/);
  assert.match(route, /loadTalentProfileDocuments\(\)/);
  assert.match(enhancements, /if \(current === ['"]talent-my-profile['"]\)\s*{\s*renderOwnTalentProfile\(selectedProfileApplicant\(\)\)/);
  assert.match(enhancements, /const baseRender = render;/);
  assert.match(enhancements, /return baseRender\(\);/);
});

test('desktop self-profile spacing returns the unused staff action rail to identity details', () => {
  const styles = read('operations/talent-file-tabs.css');

  assert.match(styles, /\.talent-file-body \.talent-profile-hero\s*{[\s\S]*?grid-template-columns:\s*228px minmax\(0, 1fr\) 392px;/);
  assert.match(styles, /\.talent-self-profile-page \.talent-file-body \.talent-profile-hero\s*{\s*grid-template-columns:\s*228px minmax\(0, 1fr\) 270px;\s*gap:\s*28px;/);
  assert.match(styles, /@media \(min-width: 1101px\) and \(max-width: 1219px\)[\s\S]*\.talent-self-profile-page \.talent-file-body \.talent-profile-hero\s*{\s*grid-template-columns:\s*210px minmax\(0, 1fr\)/);
  assert.match(styles, /@media \(min-width: 1101px\) and \(max-width: 1219px\)[\s\S]*\.talent-self-profile-page \.talent-file-body \.profile-hero-media\s*{\s*grid-column:\s*2;[\s\S]*max-width:\s*none;/);
  assert.doesNotMatch(styles, /\.talent-profile-page \.talent-file-body \.talent-profile-hero\s*{\s*grid-template-columns:\s*228px minmax\(0, 1fr\) 270px;/);
});

test('private identity values are scrubbed on every authentication transition', () => {
  const auth = read('operations/auth.js');
  const enhancements = read('operations/operations-enhancements.js');
  const cleanup = sourceBlock(enhancements, 'function clearOwnIdentityPreferencesDialog()', "document.getElementById('notifications-dialog')");

  assert.match(cleanup, /getElementById\('own-identity-preferences-dialog'\)/);
  assert.match(cleanup, /if \(dialog\.open\) dialog\.close\(\)/);
  assert.match(cleanup, /dialog\.replaceChildren\(\)/);
  assert.match(cleanup, /dialog\.remove\(\)/);
  assert.match(enhancements, /window\.soroClearOwnIdentityPreferencesDialog = clearOwnIdentityPreferencesDialog/);
  assert.match(auth, /function showSignedOut[\s\S]*window\.soroClearOwnIdentityPreferencesDialog\(\)/);
  assert.match(enhancements, /addEventListener\('soro-auth-changed', clearOwnIdentityPreferencesDialog\)/);
});

test('Talent My Profile removes management-only actions without weakening role checks', () => {
  const operations = read('operations/operations.js');
  const enhancements = read('operations/operations-enhancements.js');
  const records = read('operations/admin-record-management.js');
  const cleanup = sourceBlock(enhancements, 'function removeOwnProfileManagementActions', 'function renderOwnTalentProfile');

  for (const selector of [
    '.back-to-directory', '#profile-add-task', '.headshot-upload', '#edit-private-profile-details',
    '#edit-screening-results', '#review-talent-skills', '.admin-profile-controls', '.talent-profile-danger-zone'
  ]) {
    assert.ok(cleanup.includes(selector), `${selector} must be removed from the Talent self-profile.`);
  }
  assert.match(cleanup, /\.remove\(\)/);
  assert.match(records, /canManageTalent\s*=\s*\(\)\s*=>\s*\['admin',\s*'talent_management'\]\.includes\(currentAccessRole\(\)\)/);
  assert.match(enhancements, /function canManageScreeningResults\(\)[\s\S]*\['admin', 'talent_management'\]\.includes\(currentAccessRole\(\)\)/);
  assert.match(enhancements, /function canVerifyTalentSkills\(\)[\s\S]*\['admin', 'talent_management'\]\.includes\(currentAccessRole\(\)\)/);
  assert.match(enhancements, /currentAccessRole\(\) === 'virtual_assistant'[\s\S]*applicant\.auth_user_id[\s\S]*access\?\.user_id/);
});

test('route restoration and auth changes cannot retain another Talent record', () => {
  const operations = read('operations/operations.js');

  assert.match(operations, /location\.hash\.slice\(1\)[\s\S]*['"]talent-my-profile['"]/);
  assert.match(operations, /soro-auth-changed[\s\S]*ownTalentProfile\s*=\s*null/);
  assert.match(operations, /soro-auth-changed[\s\S]*actualAuthenticatedRole\(event\.detail\.access\)===['"]virtual_assistant['"][\s\S]*loadOwnTalentProfile\(\)/);
});

test('Talent document reads require the same organization as the linked self profile', () => {
  const migration = read('supabase/migrations/20260829_022_talent_self_document_scope.sql');

  assert.match(migration, /documents\.organization_id = private\.current_soro_organization_id\(\)/);
  assert.match(migration, /applicant\.organization_id = documents\.organization_id/);
  assert.match(migration, /applicant\.auth_user_id = auth\.uid\(\)/);
  assert.match(migration, /document\.organization_id = private\.current_soro_organization_id\(\)/);
  assert.match(migration, /applicant\.organization_id = document\.organization_id/);
  assert.match(migration, /bucket_id = 'soro-private-documents'/);
});
