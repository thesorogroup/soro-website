const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

function read(relativePath) {
  const absolutePath = path.join(root, relativePath);
  assert.equal(fs.existsSync(absolutePath), true, `${relativePath} must exist.`);
  return fs.readFileSync(absolutePath, 'utf8');
}

function migration019() {
  const directory = path.join(root, 'supabase', 'migrations');
  const matches = fs.readdirSync(directory).filter(name => /^20260827_019_.*\.sql$/i.test(name));
  assert.equal(matches.length, 1, 'Exactly one 019 employee role-access migration is required.');
  return fs.readFileSync(path.join(directory, matches[0]), 'utf8');
}

function policyFor(sql, tableName) {
  const escaped = tableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = sql.match(new RegExp(`create\\s+policy[\\s\\S]*?on\\s+${escaped}\\s+for\\s+select[\\s\\S]*?;`, 'i'));
  assert.ok(match, `A SELECT policy for ${tableName} is required.`);
  return match[0];
}

function castRoles(sqlBlock) {
  return [...new Set([...sqlBlock.matchAll(/'([a-z_]+)'::public\.platform_role/gi)].map(match => match[1]))].sort();
}

function assertTalentPrivatePolicy(sql, tableName) {
  const policy = policyFor(sql, tableName);
  assert.deepEqual(castRoles(policy), ['admin', 'talent_management']);
  assert.match(policy, /private\.current_soro_role\(\)/i);
  assert.doesNotMatch(policy, /private\.is_internal_soro_user\(\)|'sales(?:_management)?'/i);
  return policy;
}

function namedDeclaration(fileSource, names) {
  const joined = names.join('|');
  const match = fileSource.match(new RegExp(`(?:const|let|var)\\s+(?:${joined})\\s*=\\s*[\\s\\S]*?;`, 'i'));
  assert.ok(match, `Expected one of these named declarations: ${names.join(', ')}.`);
  return match[0];
}

function namedFunction(fileSource, name) {
  const declaration = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`, 'm').exec(fileSource);
  const arrow = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*\\([^)]*\\)\\s*=>\\s*\\{`, 'm').exec(fileSource);
  const startMatch = declaration || arrow;
  assert.ok(startMatch, `${name}() must be a named authorization helper.`);
  const braceStart = fileSource.indexOf('{', startMatch.index);
  let depth = 0;
  for (let index = braceStart; index < fileSource.length; index += 1) {
    if (fileSource[index] === '{') depth += 1;
    if (fileSource[index] === '}') depth -= 1;
    if (depth === 0) return fileSource.slice(startMatch.index, index + 1);
  }
  throw new Error(`${name}() could not be parsed.`);
}

test('the canonical employee roles are exactly Admin, Talent Management, and Sales', () => {
  const ui = read('operations/admin-employee-management.js');
  const server = read('netlify/functions/admin-employees.js');

  [ui, server].forEach(fileSource => {
    const contract = namedDeclaration(fileSource, ['EMPLOYEE_ROLE_LABELS']);
    const entries = [...contract.matchAll(/\b(admin|talent_management|sales|sales_management|billing|client_admin|virtual_assistant)\s*:\s*['"]([^'"]+)['"]/g)]
      .map(match => [match[1], match[2]]);
    assert.deepEqual(entries, [
      ['admin', 'Administrator'],
      ['talent_management', 'Talent Management'],
      ['sales', 'Sales Associate']
    ]);
  });
});

test('employee provisioning is available only to the authenticated active Administrator', () => {
  const ui = read('operations/admin-employee-management.js');
  const server = read('netlify/functions/admin-employees.js');
  const uiGuard = namedFunction(ui, 'canManageEmployees');

  assert.match(uiGuard, /window\.soroCurrentAccess\??\.role\s*===\s*['"]admin['"]/);
  assert.doesNotMatch(uiGuard, /\broleConfig\b|typeof\s+role|\bpreview/i);
  assert.match(server, /platform_users/);
  assert.match(server, /active=(?:is\.)?true|!access\??\.active/i);
  assert.match(server, /role=(?:eq\.)?admin|access\??\.role\s*!==\s*['"]admin['"]/i);
  assert.doesNotMatch(server, /role=(?:eq\.)?(?:sales|talent_management)/i);
});

test('019 limits raw application drafts and submitted applications to Admin and Talent Management', () => {
  const sql = migration019();

  assertTalentPrivatePolicy(sql, 'public.talent_application_drafts');
  assertTalentPrivatePolicy(sql, 'public.talent_applications');
  assert.match(sql, /drop\s+policy\s+if\s+exists\s+["']Soro internal users can read application drafts["']/i);
  assert.match(sql, /drop\s+policy\s+if\s+exists\s+["']Soro internal users can read submitted Talent applications["']/i);
});

test('019 limits document metadata and private storage objects to Admin and Talent Management', () => {
  const sql = migration019();

  assertTalentPrivatePolicy(sql, 'public.documents');
  const storagePolicy = assertTalentPrivatePolicy(sql, 'storage.objects');
  assert.match(storagePolicy, /bucket_id\s*=\s*['"]soro-private-documents['"]/i);
  assert.match(sql, /drop\s+policy\s+if\s+exists\s+["']internal users can read documents["']/i);
  assert.match(sql, /drop\s+policy\s+if\s+exists\s+["']Soro internal users can read private documents["']/i);
});

test('019 makes the server-only service role the sole writer of employee access rows', () => {
  const sql = migration019();

  assert.match(sql, /revoke\s+insert\s*,\s*update\s*,\s*delete\s+on\s+table\s+public\.platform_users\s+from\s+authenticated/i);
  assert.match(sql, /grant\s+select\s+on\s+table\s+public\.platform_users\s+to\s+authenticated/i);
  assert.match(sql, /grant\s+select\s*,\s*insert\s*,\s*update\s+on\s+table\s+public\.platform_users\s+to\s+service_role/i);
});

test('private Talent address and Benefits authority comes from authenticated access, not preview state', () => {
  const privacy = read('operations/talent-profile-privacy.js');
  const tabs = read('operations/talent-file-tabs.js');

  assert.match(privacy, /window\.soroCurrentAccess/);
  assert.doesNotMatch(privacy, /currentPreviewRole|typeof\s+role|\broleConfig\b/);
  const privateLocationGuard = namedFunction(privacy, 'canViewPrivateLocation');
  assert.match(privateLocationGuard, /authenticatedRole\(\)|window\.soroCurrentAccess/);
  assert.doesNotMatch(privateLocationGuard, /['"]sales(?:_management)?['"]/i);

  assert.match(tabs, /window\.soroCurrentAccess/);
  assert.doesNotMatch(tabs, /typeof\s+role|\broleConfig\b/);
  const benefitsRoles = namedDeclaration(tabs, ['benefitsRoles', 'BENEFITS_ROLES']);
  assert.doesNotMatch(benefitsRoles, /['"]sales(?:_management)?['"]/i);
});

test('private Talent editing and the skill library ignore the mutable workspace preview role', () => {
  const recordManagement = read('operations/admin-record-management.js');
  const enhancements = read('operations/operations-enhancements.js');
  const skills = read('operations/admin-skill-library.js');

  assert.match(recordManagement, /window\.soroCurrentAccess/);
  assert.doesNotMatch(recordManagement, /includes\(role\)|\brole\s*===\s*['"](?:admin|talent)['"]/);
  assert.match(enhancements, /function\s+currentAccessRole\([^)]*\)\s*\{[\s\S]*?window\.soroCurrentAccess\??\.role/);
  assert.doesNotMatch(enhancements, /typeof\s+role|currentPreviewRole/);

  const skillGuard = namedFunction(skills, 'isAdminPanel');
  assert.match(skillGuard, /window\.soroCurrentAccess\??\.role\s*===\s*['"]admin['"]/);
  assert.doesNotMatch(skillGuard, /typeof\s+role|\broleConfig\b/);
});

test('Sales navigation permits safe Talent profiles while excluding the raw directory, Documents, and Employees', () => {
  const navigationSource = `${read('operations/operations.js')}\n${read('operations/auth.js')}`;
  const accessNavigation = namedDeclaration(navigationSource, [
    'ACCESS_NAVIGATION',
    'AUTHORIZED_NAVIGATION',
    'NAVIGATION_BY_ACCESS_ROLE',
    'authenticatedEmployeeViews'
  ]);
  const sales = accessNavigation.match(/\bsales\s*:\s*(?:(?:Object\.freeze|new\s+Set)\()?\s*\[([^\]]*)\]/i);
  assert.ok(sales, 'The authenticated navigation contract must define Sales views.');
  const salesViews = [...sales[1].matchAll(/['"]([a-z-]+)['"]/g)].map(match => match[1]);

  assert.ok(salesViews.includes('overview'));
  assert.ok(salesViews.includes('clients'));
  assert.ok(salesViews.includes('talent-profile'));
  ['vas', 'documents', 'employees'].forEach(view => {
    assert.equal(salesViews.includes(view), false, `Sales must not expose the ${view} view.`);
  });
  assert.match(navigationSource, /window\.soroCurrentAccess/);
  assert.match(navigationSource, /(?:hidden\s*=|\.remove\(\)|classList\.(?:add|toggle)\([^)]*hidden)/);
});

test('authenticated navigation explicitly maps every authorized role and fails closed otherwise', () => {
  const operations = read('operations/operations.js');
  const auth = read('operations/auth.js');
  const authorizedRoleDeclaration = namedDeclaration(auth, ['authorizedRoles']);
  const navigationDeclaration = namedDeclaration(operations, [
    'ACCESS_NAVIGATION',
    'AUTHORIZED_NAVIGATION',
    'NAVIGATION_BY_ACCESS_ROLE',
    'authenticatedEmployeeViews'
  ]);
  const authorizedRoles = [...authorizedRoleDeclaration.matchAll(/['"]([a-z_]+)['"]/g)]
    .map(match => match[1])
    .sort();
  const navigationRoles = [...navigationDeclaration.matchAll(/(?:^|[,{]\s*)([a-z_]+)\s*:/gm)]
    .map(match => match[1])
    .sort();

  assert.deepEqual(navigationRoles, authorizedRoles, 'Every authorized role must have an explicit navigation allowlist, with no implicit role fallback.');

  const viewGuard = namedFunction(operations, 'viewAllowedForAuthenticatedRole');
  assert.doesNotMatch(viewGuard, /if\s*\(\s*!accessRole\s*\)\s*return\s+true/);
  assert.match(viewGuard, /authenticatedEmployeeViews\s*\[\s*accessRole\s*\]/);
  assert.match(viewGuard, /Boolean\s*\(\s*allowed\??\.has\(view\)\s*\)/);

  const navigationSync = namedFunction(operations, 'syncAuthorizedNavigation');
  assert.match(navigationSync, /authenticatedEmployeeViews\s*\[\s*accessRole\s*\]\s*\|\|\s*new Set\(\)/);
  assert.doesNotMatch(navigationSync, /if\s*\(\s*!allowed\s*\)\s*return/);
  assert.match(navigationSync, /button\.hidden\s*=\s*!allowed\.has\(/);

  assert.match(operations, /if\s*\(\s*!viewAllowedForAuthenticatedRole\(current\)\s*\)/);
  assert.match(operations, /if\s*\(\s*!b\s*\|\|\s*!viewAllowedForAuthenticatedRole\(b\.dataset\.view\)\s*\)\s*return/);
});

test('every role admitted by authentication has an explicit fail-closed navigation map', () => {
  const navigationSource = `${read('operations/operations.js')}\n${read('operations/auth.js')}`;
  const contract = namedDeclaration(navigationSource, ['authenticatedEmployeeViews']);
  [
    'admin', 'talent_management', 'sales', 'sales_management', 'billing',
    'client_admin', 'client_reviewer', 'client_billing', 'virtual_assistant'
  ].forEach(role => assert.match(contract, new RegExp(`\\b${role}\\s*:`), `Missing ${role} navigation contract.`));
  assert.match(navigationSource, /return\s+Boolean\(allowed\?\.has\(view\)\)/);
});
