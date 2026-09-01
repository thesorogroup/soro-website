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

function loadApi(role = 'sales') {
  const window = {
    soroCurrentAccess: { role, user_id: 'employee-user-1' },
    addEventListener() {},
    setTimeout,
    clearTimeout
  };
  window.window = window;
  const context = vm.createContext({
    AbortController,
    console,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
    window
  });
  vm.runInContext(read('operations/read-only-talent-profile.js'), context, {
    filename: 'read-only-talent-profile.js'
  });
  return window.SoroReadOnlyTalentProfile;
}

test('only Sales workspaces use the dedicated read-only Talent profile loader', () => {
  const api = loadApi();
  assert.equal(api.canOpenForRole('sales'), true);
  assert.equal(api.canOpenForRole('sales_management'), true);
  ['admin', 'talent_management', 'billing', 'client_admin', 'client_reviewer', 'virtual_assistant', ''].forEach(role => {
    assert.equal(api.canOpenForRole(role), false, `${role || 'empty role'} must not use the Sales profile loader.`);
  });
});

test('the Sales profile normalizer preserves only the approved matching summary', () => {
  const api = loadApi();
  const talent = api.normalizeTalent({
    talent: {
      id: 'b83bfca4-fea9-463f-92fb-c35305c98e34',
      full_name: 'Santos, Maria Elena',
      preferred_name: 'Maria',
      country: 'Philippines',
      timezone: 'Asia/Manila',
      status: 'bench_ready',
      work_status: 'seeking_work',
      availability_note: 'Available full time',
      application_received_at: '2026-08-24T00:00:00Z',
      expected_hourly_rate_text: '$7–$9 USD per hour',
      verified_skills: ['Medical coding'],
      self_reported_experience_areas: ['healthcare'],
      self_reported_skills: ['Insurance verification'],
      relevant_experience_summary: 'Four years supporting medical offices.',
      education_training_summary: 'Medical coding coursework.',
      english_test_result: '95 practice',
      personality_profile_score: 'INFJ-A',
      computer_specs: 'Laptop · 16 GB RAM',
      internet_speed: '120 Mbps download · 45 Mbps upload',
      email: 'private@example.com',
      phone: '+63 private',
      address_line_1: 'Private address',
      birth_date: '1998-01-01',
      gender_identity: 'private',
      pronouns: ['private'],
      greatest_dream: 'Private dream',
      talent_review_owner_id: 'private-owner',
      organization_id: 'private-organization',
      auth_user_id: 'private-auth',
      documents: [{ storage_path: 'private/path' }],
      legacy_application_data: { secret: true }
    }
  });

  assert.equal(talent.full_name, 'Santos, Maria Elena');
  assert.deepEqual([...talent.verified_skills], ['Medical coding']);
  assert.deepEqual([...talent.self_reported_skills], ['Insurance verification']);
  const serialized = JSON.stringify(talent);
  [
    'private@example.com', '+63 private', 'Private address', '1998-01-01',
    'Private dream', 'private-owner', 'private-organization', 'private-auth',
    'private/path', 'legacy_application_data'
  ].forEach(secret => assert.equal(serialized.includes(secret), false, `${secret} must be omitted.`));
});

test('the Sales loader uses one bearer-authenticated GET and never queries private tables or storage directly', () => {
  const source = read('operations/read-only-talent-profile.js');
  assert.match(source, /ENDPOINT\s*=\s*'\/\.netlify\/functions\/internal-talent-profile'/);
  assert.match(source, /method:\s*'GET'/);
  assert.match(source, /Authorization:\s*`Bearer \$\{token\}`/);
  assert.match(source, /cache:\s*'no-store'/);
  assert.doesNotMatch(source, /\.from\(['"](?:applicants|documents|placements|talent_attendance_sessions)['"]\)/);
  assert.doesNotMatch(source, /\.storage\.|createSignedUrl|storage_path/);
});

test('the read-only presentation removes mutation, private, document, and management surfaces', () => {
  const source = read('operations/read-only-talent-profile.js');
  [
    '#profile-add-task', '#edit-private-profile-details', '#edit-screening-results',
    '#review-talent-skills', '.admin-profile-controls', '.headshot-upload',
    '.profile-resume-access', '.screening-source-links', '.profile-contact',
    '.profile-private-address', '.private-identity-detail', '.profile-introduction-video-slot'
  ].forEach(selector => assert.equal(source.includes(selector), true, `${selector} must be removed.`));
  assert.match(source, /View only/);
  assert.match(source, /row\.querySelector\('dt'\)/);
  assert.match(source, /Profile owner/);
  assert.doesNotMatch(source, /cachedTalent|cacheKey/);
});

test('the portal renderer routes Sales through the isolated profile and keeps a single Profile tab', () => {
  const operations = read('operations/operations.js');
  const enhancements = read('operations/operations-enhancements.js');
  const tabs = read('operations/talent-file-tabs.js');
  const html = read('operations/index.html');

  assert.match(operations, /sales:new Set\(\['overview','tasks','clients','client-shortlists','available-talent','talent-profile','placements','reports','help'\]\)/);
  assert.match(operations, /sales_management:new Set\(\['overview','tasks','clients','client-shortlists','available-talent','talent-profile','placements','reports','help'\]\)/);
  assert.match(enhancements, /current === 'talent-profile'[\s\S]*\['sales', 'sales_management'\]\.includes\(accessRole\)[\s\S]*SoroReadOnlyTalentProfile\?\.canOpenForRole[\s\S]*SoroReadOnlyTalentProfile\.mount\(root/);
  assert.match(enhancements, /secure read-only profile is still loading/);
  assert.match(operations, /if\(\['sales','sales_management'\]\.includes\(accessRole\)\)[\s\S]*SoroReadOnlyTalentProfile\?\.canOpenForRole[\s\S]*secure read-only profile is still loading/);
  assert.match(tabs, /const readOnlySales = isReadOnlySalesProfile\(\)/);
  assert.match(tabs, /const initialTabCount = readOnlySales \? 1/);
  assert.match(tabs, /readOnlySales[\s\S]*\? tabButton\('profile', 'Profile'\)/);
  assert.match(tabs, /if \(isReadOnlySalesProfile\(\)\)[\s\S]*return;/);
  assert.ok(html.indexOf('talent-file-tabs.js?v=20260901-role-view-access') < html.indexOf('read-only-talent-profile.js?v=20260901-role-view-access'));
});

test('Talent Management keeps Client viewing but does not receive a Clients-page create control', () => {
  const operations = read('operations/operations.js');
  assert.match(operations, /talent_management:new Set\(\['overview','tasks','clients'/);
  assert.match(operations, /const canCreateClient=\['admin','sales','sales_management'\]\.includes\(currentAuthenticatedRole\(\)\)/);
  assert.match(operations, /current==='clients'&&canCreateClient/);
  assert.doesNotMatch(operations, /canCreateClient=\[[^\]]*talent_management/);
});

test('Admin workspace previews may narrow management UI but never widen it', () => {
  const recordManagement = read('operations/admin-record-management.js');
  const portalAccess = read('operations/talent-portal-access.js');
  const deletion = read('operations/admin-permanent-deletion.js');

  assert.match(recordManagement, /function currentAuthenticatedRole|typeof currentAuthenticatedRole/);
  assert.match(recordManagement, /canManageTalent[\s\S]*currentAccessRole\(\)[\s\S]*effectiveAccessRole\(\)/);
  assert.match(recordManagement, /canManageClients[\s\S]*currentAccessRole\(\) === 'admin'[\s\S]*effectiveAccessRole\(\) === 'admin'/);
  assert.match(portalAccess, /canManageTalentAccess\(\)[\s\S]*MANAGER_ROLES\.has\(managerRole\(\)\)[\s\S]*MANAGER_ROLES\.has\(effectiveManagerRole\(\)\)/);
  assert.match(deletion, /authenticated === 'admin' && effective === 'admin'/);
});

test('Talent search can match contact data without returning contact values to Sales', () => {
  const migration = read('supabase/migrations/20260901_033_global_directory_search.sql');
  assert.match(migration, /lower\(applicant\.email\)[\s\S]*regexp_replace\(coalesce\(applicant\.phone/);
  assert.match(migration, /'secondaryLabel', case[\s\S]*'Goes by ' \|\| btrim\(preferred_name\)[\s\S]*else null/);
  assert.doesNotMatch(migration, /'secondaryLabel', case[\s\S]{0,180}else email/);
});
