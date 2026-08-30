const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const paths = {
  ui: path.join(root, 'operations', 'admin-employee-management.js'),
  auth: path.join(root, 'operations', 'auth.js'),
  html: path.join(root, 'operations', 'index.html'),
  server: path.join(root, 'netlify', 'functions', 'admin-employees.js'),
  migration: path.join(root, 'supabase', 'migrations', '20260827_018_employee_onboarding.sql'),
  hardening: path.join(root, 'supabase', 'migrations', '20260827_019_employee_role_access_hardening.sql'),
  rolePolicies: path.join(root, 'supabase', 'migrations', '20260816_006_private_role_helpers.sql')
};

function source(name) {
  assert.equal(fs.existsSync(paths[name]), true, `${path.relative(root, paths[name])} must exist.`);
  return fs.readFileSync(paths[name], 'utf8');
}

function declaredRoleContract(fileSource) {
  const start = fileSource.search(/(?:EMPLOYEE_ROLE_LABELS|ALLOWED_EMPLOYEE_ROLES|EMPLOYEE_ROLES)\s*=/);
  assert.notEqual(start, -1, 'Employee roles must be declared in one explicit allowlist.');
  const rest = fileSource.slice(start);
  const semicolon = rest.indexOf(';');
  assert.notEqual(semicolon, -1, 'Employee role declaration must have a clear end.');
  return rest.slice(0, semicolon + 1);
}

function assertExactEmployeeRoles(fileSource) {
  const contract = declaredRoleContract(fileSource);
  assert.match(contract, /\badmin\b/);
  assert.match(contract, /talent_management/);
  assert.match(contract, /sales/);
  assert.match(contract, /Administrator/);
  assert.match(contract, /Talent Management/);
  assert.match(contract, /Sales Associate/);
  assert.doesNotMatch(contract, /sales_management|billing|client_|virtual_assistant/);
}

function unsignedToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

test('the Admin Panel exposes a dedicated Employees view and complete employee profile form', () => {
  const html = source('html');
  const ui = source('ui');

  assert.match(html, /data-view=["']employees["'][^>]*>\s*Employees\b/i);
  assert.match(html, /admin-employee-management\.js/);

  [
    ['name', /name=["'](?:display_name|full_name)["']/],
    ['hire date', /name=["']hire_date["']/],
    ['assigned role', /name=["']role["']/],
    ['email', /name=["']email["']/],
    ['phone', /name=["']phone["']/],
    ['street address', /name=["']address_line_1["']/],
    ['address line 2', /name=["']address_line_2["']/],
    ['city', /name=["']city["']/],
    ['state or region', /name=["'](?:state_region|region)["']/],
    ['postal code', /name=["']postal_code["']/],
    ['country', /name=["']country["']/]
  ].forEach(([label, pattern]) => assert.match(ui, pattern, `Missing ${label} field.`));
});

test('Administrators explicitly assign and edit the employee payment route without browser inference', () => {
  const ui = source('ui');

  assert.match(ui, /wise_contractor:\s*['"]Philippines contractor — Wise['"]/);
  assert.match(ui, /quickbooks_employee:\s*['"]U\.S\. employee — QuickBooks['"]/);
  assert.match(ui, /needs_setup:\s*['"]Needs setup['"]/);
  assert.match(ui, /name=["']paymentRoute["']/);
  assert.match(ui, /name=["']payoutRecipientEmail["'][^>]*type=["']email["']/);
  assert.match(ui, /route\.value\s*===\s*['"]wise_contractor['"]/);
  assert.match(ui, /recipientField\.hidden\s*=\s*!usesWise/);
  assert.match(ui, /recipient\.required\s*=\s*usesWise/);
  assert.match(ui, /if\s*\(!usesWise\)\s*recipient\.value\s*=\s*['"]['"]/);
  assert.match(ui, /Required for Wise/);
  assert.doesNotMatch(ui, /Wise recipient email <span>Optional during setup<\/span>/);
  assert.match(ui, /payment_route,payout_recipient_email/);
  assert.match(ui, /action:\s*['"]update_employee_payment_route['"]/);
  assert.match(ui, /payoutRecipientEmail:\s*paymentRoute\s*===\s*['"]wise_contractor['"]\s*\?\s*payoutRecipientEmail\s*:\s*null/);
  assert.doesNotMatch(ui, /employee\.(?:country|state_region|city)\s*===?\s*['"][^'"]+['"][\s\S]{0,120}paymentRoute/);
});

test('employee management is gated by real authenticated access, never the workspace preview role', () => {
  const ui = source('ui');
  const server = source('server');

  assert.match(ui, /window\.soroCurrentAccess\??\.role\s*===\s*["']admin["']/);
  assert.match(ui, /soro-auth-changed/);
  assert.doesNotMatch(ui, /roleConfig\s*\[|role-switcher|workspace preview|sample workspace/i);

  assert.match(server, /platform_users/);
  assert.match(server, /active=(?:is\.)?true|active\s*===\s*true|!access\??\.active/i);
  assert.match(server, /role=(?:eq\.)?admin|access\??\.role\s*!==\s*["']admin["']/i);
  assert.match(server, /Only an active Soro Administrator|administrator.+required|Admin(?:istrator)?s? only/i);
});

test('the only employee roles offered and accepted are Administrator, Talent Management, and Sales Associate', () => {
  assertExactEmployeeRoles(source('ui'));
  assertExactEmployeeRoles(source('server'));
});

test('assigning Administrator access requires a recently issued authenticated session', () => {
  const ui = source('ui');
  const server = source('server');

  assert.match(server, /function\s+tokenIssuedRecently\s*\(/);
  assert.match(server, /payload\.amr/);
  assert.match(server, /entry\?\.method\s*===\s*['"]password['"]/);
  assert.match(server, /employee\.role\s*===\s*['"]admin['"][\s\S]*?!administrator\.tokenFresh/);
  assert.match(server, /access\.role\s*===\s*['"]admin['"][\s\S]*?!administrator\.tokenFresh/);
  assert.match(server, /reauthentication_required/);
  assert.match(ui, /administrator_password/);
  assert.match(ui, /signInWithPassword/);
  assert.match(ui, /delete\s+values\.administrator_password/);
  assert.match(ui, /Administrator grants broad Soro Ops access and requires a recent sign-in/i);
  assert.match(ui, /reserved System Owner account cannot be assigned here/i);
});

test('Administrator reauthentication requires a recent password AMR event, not merely a fresh token', () => {
  const { tokenIssuedRecently } = require(paths.server);
  const now = 1_788_000_000;
  const originalNow = Date.now;
  Date.now = () => now * 1000;
  try {
    assert.equal(tokenIssuedRecently(unsignedToken({ iat: now - 10 })), false, 'A recent iat without password AMR must fail.');
    assert.equal(tokenIssuedRecently(unsignedToken({ iat: now - 10, amr: [{ method: 'otp', timestamp: now - 5 }] })), false, 'A recent non-password AMR must fail.');
    assert.equal(tokenIssuedRecently(unsignedToken({ iat: now - 900, amr: [{ method: 'password', timestamp: now - 60 }] })), true, 'A recent password authentication must pass.');
    assert.equal(tokenIssuedRecently(unsignedToken({ iat: now - 10, amr: [{ method: 'password', timestamp: now - 301 }] })), false, 'An old password authentication must fail.');
    assert.equal(tokenIssuedRecently(unsignedToken({ iat: now, amr: [{ method: 'password', timestamp: now + 31 }] })), false, 'A future AMR timestamp must fail.');
  } finally {
    Date.now = originalNow;
  }
});

test('the employee profile explains the effective access inherited from each role', () => {
  const ui = source('ui');

  assert.match(ui, /EMPLOYEE_ROLE_ACCESS/);
  assert.match(ui, /Broad day-to-day Soro Ops access/i);
  assert.match(ui, /reserved System Owner account remains separate/i);
  assert.match(ui, /Application review, screening, Talent profiles/i);
  assert.match(ui, /Raw applications, private Talent files, benefits, and employee administration are excluded/i);
  assert.match(ui, /Effective access/);
});

test('assigned employee roles inherit the established Soro workspace and database access boundaries', () => {
  const auth = source('auth');
  const policies = source('rolePolicies');
  const ui = source('ui');

  assert.match(auth, /admin\s*:\s*['"]admin['"]/);
  assert.match(auth, /talent_management\s*:\s*['"]talent['"]/);
  assert.match(auth, /sales\s*:\s*['"]sales['"]/);
  assert.match(policies, /talent management can manage applicant records[\s\S]*?admin[\s\S]*?talent_management/i);
  assert.match(policies, /sales can manage clients[\s\S]*?admin[\s\S]*?sales/i);
  assert.match(policies, /admin and talent management can manage documents[\s\S]*?admin[\s\S]*?talent_management/i);
  assert.match(ui, /window\.soroCurrentAccess\?\.role\s*===\s*['"]admin['"]/);
});

test('account provisioning is server-only and uses the Supabase administrative API', () => {
  const ui = source('ui');
  const html = source('html');
  const server = source('server');

  assert.match(ui, /\/\.netlify\/functions\/admin-employees/);
  assert.doesNotMatch(`${ui}\n${html}`, /SUPABASE_SERVICE_ROLE_KEY|\/auth\/v1\/admin\/users/);
  assert.match(server, /process\.env\.SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(server, /\/auth\/v1\/admin\/users/);
  assert.match(server, /method:\s*["']POST["']/);
  assert.match(server, /email_confirm\s*:\s*true/);
  assert.match(server, /Cache-Control["']?\s*:\s*["']no-store["']/i);
});

test('temporary credentials are generated securely, returned once, and never persisted', () => {
  const ui = source('ui');
  const server = source('server');
  const migration = source('migration');

  assert.match(server, /require\(["']node:crypto["']\)|require\(["']crypto["']\)/);
  assert.match(server, /crypto\.(?:randomBytes|randomInt|randomUUID)\s*\(/);
  assert.doesNotMatch(server, /Math\.random\s*\(/);
  assert.match(server, /temporaryPassword/);
  assert.match(ui, /temporaryPassword/);
  assert.match(ui, /shown once|one-time|copy temporary|copy sign-in/i);
  assert.match(server, /must_change_password\s*:\s*true/);
  assert.match(migration, /must_change_password\s+boolean\s+not null/i);
  assert.doesNotMatch(migration, /(?:temporary_password|temp_password|plaintext_password|password_text)\s+(?:text|varchar)/i);
});

test('temporary credentials expire and an Administrator can securely reissue them', () => {
  const ui = source('ui');
  const server = source('server');

  assert.match(server, /TEMPORARY_PASSWORD_TTL_HOURS\s*=\s*72/);
  assert.match(server, /temporary_password_expired/);
  assert.match(server, /reissue_temporary_password/);
  assert.match(server, /requireAdministrator\(event\)/);
  assert.match(ui, /Generate new temporary password/);
  assert.match(ui, /reissue_temporary_password/);
  assert.match(`${ui}\n${server}`, /expires in/);
});

test('temporary-password reissue has durable intent before Auth and records the outcome afterward', () => {
  const server = source('server');
  const start = server.indexOf('async function reissueTemporaryPassword');
  const end = server.indexOf('async function verifyCurrentPassword', start);
  assert.notEqual(start, -1, 'The reissue handler must exist.');
  assert.notEqual(end, -1, 'The reissue handler must have a clear boundary.');
  const reissue = server.slice(start, end);
  const auditIntent = reissue.indexOf('const auditId = await beginAuditAction');
  const authPasswordUpdate = reissue.indexOf('serviceRequest(`/auth/v1/admin/users/${encodeURIComponent(userId)}`');
  const issueTimestampUpdate = reissue.indexOf('body: JSON.stringify({ initial_password_issued_at: issuedAt })');
  const auditOutcome = reissue.indexOf("outcome: 'completed'");

  assert.notEqual(auditIntent, -1, 'Reissue must have a durable pending audit record before changing credentials.');
  assert.notEqual(authPasswordUpdate, -1, 'Reissue must update the employee Auth password.');
  assert.notEqual(issueTimestampUpdate, -1, 'Reissue must record the new issue timestamp.');
  assert.notEqual(auditOutcome, -1, 'Reissue must record its final audit outcome.');
  assert.ok(auditIntent < authPasswordUpdate, 'The durable audit intent must precede the Auth password change.');
  assert.ok(authPasswordUpdate < issueTimestampUpdate, 'Auth password must update before the issue timestamp advances.');
  assert.ok(issueTimestampUpdate < auditOutcome, 'The completed outcome must follow the reissue mutation.');
  assert.match(reissue.slice(authPasswordUpdate, issueTimestampUpdate), /method:\s*['"]PUT['"]/);
});

test('durable audit intent precedes account activation and first-sign-in gate removal', () => {
  const server = source('server');
  const hardening = source('hardening');
  const createStart = server.indexOf('async function createEmployee');
  const createEnd = server.indexOf('function validUuid', createStart);
  const changeStart = server.indexOf('async function changeInitialPassword');
  const changeEnd = server.indexOf('exports.handler', changeStart);
  assert.notEqual(createStart, -1);
  assert.notEqual(createEnd, -1);
  assert.notEqual(changeStart, -1);
  assert.notEqual(changeEnd, -1);

  const create = server.slice(createStart, createEnd);
  const creationAudit = create.indexOf('auditId = await beginAuditAction');
  const activation = create.indexOf('body: JSON.stringify({ active: true })');
  assert.notEqual(creationAudit, -1, 'Account activation must have a durable pending audit record.');
  assert.notEqual(activation, -1, 'A completed employee account must be activated.');
  assert.ok(creationAudit < activation, 'The durable audit intent must exist before the permission-bearing account activates.');

  const change = server.slice(changeStart, changeEnd);
  const passwordAudit = change.indexOf('const auditId = await beginAuditAction');
  const passwordMutation = change.indexOf('serviceRequest(`/auth/v1/admin/users/${encodeURIComponent(authenticated.user.id)}`');
  const gateClear = change.indexOf('must_change_password: false');
  assert.notEqual(passwordAudit, -1, 'Initial password replacement must have a durable pending audit record.');
  assert.notEqual(passwordMutation, -1, 'Initial password replacement must update Auth.');
  assert.notEqual(gateClear, -1, 'The first-sign-in gate must eventually clear.');
  assert.ok(passwordAudit < passwordMutation, 'The durable audit intent must precede the Auth password change.');
  assert.ok(passwordMutation < gateClear, 'The Auth password must change before normal workspace access is enabled.');
  assert.match(server, /outcome:\s*['"]pending['"]/);
  assert.match(server, /outcome:\s*['"](?:completed|failed)['"]/);
  assert.match(server, /durable pending record is intentionally retained for reconciliation/i);
  assert.match(hardening, /grant\s+select\s*,\s*insert\s*,\s*update\s+on\s+table\s+public\.audit_events\s+to\s+service_role/i);
});

test('secure employee provisioning fails closed and only activates a complete account', () => {
  const server = source('server');

  assert.match(server, /const SUPABASE_URL[\s\S]*?:\s*['"]['"]/);
  assert.match(server, /if \(!SUPABASE_URL \|\| !SERVICE_KEY\)/);
  assert.match(server, /active\s*:\s*false/);
  assert.match(server, /employee_profiles[\s\S]*?body:\s*JSON\.stringify[\s\S]*?platform_users[\s\S]*?active\s*:\s*true/);
});

test('first sign-in is blocked behind a mandatory password change', () => {
  const auth = source('auth');
  const html = source('html');
  const server = source('server');
  const migration = source('migration');

  assert.match(auth, /select\([^)]*must_change_password/);
  assert.match(auth, /access\??\.must_change_password/);
  assert.match(`${auth}\n${html}`, /new-password/);
  assert.match(`${auth}\n${html}`, /confirm/i);
  assert.match(`${auth}\n${server}`, /change_(?:initial|temporary)_password|complete_(?:first|initial)_password_change/i);
  assert.match(server, /must_change_password\s*:\s*false/);
  assert.match(migration, /password_changed_at\s+timestamptz/i);
});

test('employee PII is isolated by row-level security and gated accounts receive no workspace role', () => {
  const migration = source('migration');

  assert.match(migration, /alter table public\.employee_profiles enable row level security/i);
  assert.match(migration, /employee_profiles[\s\S]*?for select[\s\S]*?user_id\s*=\s*auth\.uid\(\)/i);
  assert.match(migration, /employee_profiles[\s\S]*?for all[\s\S]*?private\.is_soro_admin\(\)/i);
  assert.match(migration, /current_soro_role\(\)[\s\S]*?must_change_password\s*=\s*false/i);
  assert.match(migration, /employees can read their own private profile[\s\S]*?current_soro_role\(\) is not null/i);
});

test('employee dialogs expose an accessible title and begin on the first field', () => {
  const ui = source('ui');

  assert.match(ui, /aria-labelledby/);
  assert.equal(ui.includes(`dialog.querySelector('[name="full_name"]')?.focus();`), true);
});

test('a failed profile write rolls back the newly created authentication account', () => {
  const server = source('server');

  assert.match(server, /rollback|clean(?:up)?Created|deleteCreated|removeCreated/i);
  assert.match(server, /\/auth\/v1\/admin\/users\/\$\{|\/auth\/v1\/admin\/users\//);
  assert.match(server, /method:\s*["']DELETE["']/);
  assert.match(server, /catch\s*\([^)]*\)\s*\{[\s\S]*?(?:rollback|clean(?:up)?Created|deleteCreated|removeCreated)/i);
});

test('employee creation writes a minimal audit event without recording credentials', () => {
  const server = source('server');
  const migration = source('migration');

  assert.match(server, /audit_events/);
  assert.match(server, /employee_account_provisioning/);
  assert.doesNotMatch(server, /note\s*:\s*`[^`]*(?:temporaryPassword|password)[^`]*`/i);
  assert.match(migration, /hire_date\s+date/i);
  assert.match(migration, /(?:email|phone|address_line_1|address_line_2|city|state_region|postal_code|country)\s+(?:text|citext)/i);
  ['email', 'phone', 'address_line_1', 'address_line_2', 'city', 'state_region', 'postal_code', 'country']
    .forEach(column => assert.match(migration, new RegExp(`\\b${column}\\s+(?:text|citext)`, 'i'), `Missing ${column} employee profile column.`));
});

test('employee payment routing is explicit, Admin-only, same-organization, and value-free in audit history', () => {
  const server = source('server');
  assert.match(server, /PAYMENT_ROUTES\s*=\s*new Set\(\[['"]wise_contractor['"],\s*['"]quickbooks_employee['"],\s*['"]needs_setup['"]\]\)/);
  assert.match(server, /payment_route:\s*employee\.paymentRoute/);
  assert.match(server, /payout_recipient_email:\s*employee\.payoutRecipientEmail/);
  assert.match(server, /action === ['"]update_employee_payment_route['"]/);
  assert.match(server, /hasExactKeys\(body, UPDATE_PAYMENT_ROUTE_REQUIRED_KEYS, UPDATE_PAYMENT_ROUTE_OPTIONAL_KEYS\)/);
  assert.match(server, /async function updateEmployeePaymentRoute[\s\S]*requireAdministrator\(event\)/);
  assert.match(server, /employee_profiles\?user_id=eq\.\$\{encodeURIComponent\(userId\)\}&organization_id=eq\.\$\{encodeURIComponent\(organizationId\)\}/);
  assert.match(server, /changed_fields:\s*changedFields/);
  const updateStart = server.indexOf('async function updateEmployeePaymentRoute');
  const updateEnd = server.indexOf('async function reissueTemporaryPassword', updateStart);
  const update = server.slice(updateStart, updateEnd);
  assert.doesNotMatch(update, /after_value:[^\n]*(?:paymentRoute|payoutRecipientEmail)/);
  assert.match(update, /reauthentication_required/);
});
