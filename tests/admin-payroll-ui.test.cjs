const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = relativePath => {
  const absolute = path.join(root, relativePath);
  assert.equal(fs.existsSync(absolute), true, `${relativePath} must exist.`);
  return fs.readFileSync(absolute, 'utf8');
};

function loadModule(role = 'admin') {
  const modulePath = path.join(root, 'operations', 'admin-payroll.js');
  delete require.cache[require.resolve(modulePath)];
  globalThis.soroCurrentAccess = { role };
  return require(modulePath);
}

test('Admin and Talent Management receive different fail-closed payroll routes', () => {
  const ui = loadModule('admin');
  assert.equal(ui.ENDPOINT, '/.netlify/functions/admin-payroll');
  assert.equal(ui.canUse('admin'), true);
  assert.equal(ui.canUse('talent_management'), true);
  for (const role of ['sales', 'sales_management', 'billing', 'client_admin', 'client_reviewer', 'client_billing', 'virtual_assistant', '']) {
    assert.equal(ui.canUse(role), false, role);
  }
  assert.equal(ui.canOpenView('payroll', 'admin'), true);
  assert.equal(ui.canOpenView('talent-payout-review', 'admin'), false);
  assert.equal(ui.canOpenView('talent-payout-review', 'talent_management'), true);
  assert.equal(ui.canOpenView('payroll', 'talent_management'), false);
});

test('navigation exposes Payroll & Payouts only to Admin and Talent Payout Review only to Talent Management', () => {
  const operations = read('operations/operations.js');
  const html = read('operations/index.html');
  assert.match(operations, /admin:new Set\(\[[^\]]*['"]payroll['"]/);
  assert.match(operations, /talent_management:new Set\(\[[^\]]*['"]talent-payout-review['"]/);
  assert.doesNotMatch(operations, /\bsales(?:_management)?\s*:\s*new Set\(\[[^\]]*(?:payroll|talent-payout-review)/);
  assert.match(html, /data-view=["']payroll["'][^>]*>Payroll &amp; Payouts</i);
  assert.match(html, /data-view=["']talent-payout-review["'][^>]*>Talent Payout Review</i);
  assert.match(html, /admin-payroll\.css/);
  assert.match(html, /admin-payroll\.js/);
});

test('UI authorization uses actual soroCurrentAccess and never the mutable workspace preview role', () => {
  const source = read('operations/admin-payroll.js');
  assert.match(source, /function actualRole\([^)]*soroCurrentAccess/);
  assert.match(source, /actualRole\(\) !== ADMIN_ROLE/);
  assert.doesNotMatch(source, /effectiveWorkspaceRole|workspacePreviewAccessRole|currentAuthenticatedRole|\broleConfig\b/);
  assert.match(source, /if \(!canOpenView\(current, actualRole\(\)\)\)/);
});

test('Admin sees separate Employee Payroll and Talent Payouts while Talent Management never receives employee controls', () => {
  const source = read('operations/admin-payroll.js');
  assert.match(source, /Employee Payroll/);
  assert.match(source, /Talent Payouts/);
  assert.match(source, /Philippines internal staff/);
  assert.match(source, /Philippines contract Talent/);
  assert.match(source, /U\.S\. employees stay in QuickBooks and are excluded here/);
  assert.match(source, /No Soro tax withholding or fund release happens here/);
  assert.match(source, /Run payroll/);
  assert.match(source, /Only an Administrator can approve, export, or record release/);
  assert.match(source, /const admin\s*=\s*role\s*===\s*ADMIN_ROLE/);
  assert.match(source, /admin\s*\?\s*laneCardMarkup\(['"]employee['"],\s*role\)\s*:\s*['"]/);
  assert.doesNotMatch(source, /Run Talent Payroll|Talent Payroll/);
});

test('Employee Payroll is the separate Philippines staff Wise batch and keeps QuickBooks employees excluded', () => {
  const source = read('operations/admin-payroll.js');
  assert.match(source, /paymentRoute\s*!==\s*['"]wise_contractor['"]/);
  assert.match(source, /payoutRecipientEmail:\s*text\(value\.payoutRecipientEmail/);
  assert.match(source, /Philippines internal staff/);
  assert.match(source, /U\.S\. employee — QuickBooks/);
  assert.match(source, /QuickBooks only · Excluded/);
  assert.match(source, /Export staff Wise CSV/);
  assert.match(source, /fields\.payoutRecipientEmail\s*=\s*text\(values\.payoutRecipientEmail/);
  assert.match(source, /recipientInput\.value\s*=\s*item\.payoutRecipientEmail\s*\|\|\s*['"]/);
  assert.match(source, /Payment route is set by an Administrator in Employees; the browser never infers it/);
  assert.doesNotMatch(source, /value\.(?:country|stateRegion|city)[\s\S]{0,100}wise_contractor/);
});

test('browser actions submit only item inputs and never browser-calculated totals, authority, or organization scope', () => {
  const source = read('operations/admin-payroll.js');
  for (const action of [
    'create_employee_run', 'update_employee_item', 'transition_employee_run', 'export_employee_run',
    'create_talent_run', 'update_talent_item', 'verify_talent_item', 'transition_talent_run', 'export_talent_run'
  ]) assert.match(source, new RegExp(`['"]${action}['"]`), action);
  assert.match(source, /body:\s*JSON\.stringify\(\{\s*action,\s*requestId:\s*operationRequestId\(\),\s*\.\.\.fields\s*\}\)/);
  assert.doesNotMatch(source, /body:\s*JSON\.stringify\([^)]*(?:viewerRole|organizationId|totalAmount|itemCount|exceptionCount)/);
  assert.match(source, /amount:\s*amount\s*\|\|\s*null/);
  assert.match(source, /The server recalculates the batch total/);
});

test('Talent Management can verify but only actual Admin can edit, transition, or export', () => {
  const source = read('operations/admin-payroll.js');
  assert.match(source, /function openVerifyDialog[\s\S]*\[ADMIN_ROLE, TALENT_ROLE\]\.includes\(actualRole\(\)\)/);
  assert.match(source, /function openItemDialog[\s\S]*actualRole\(\) !== ADMIN_ROLE/);
  assert.match(source, /function openTransitionDialog[\s\S]*actualRole\(\) !== ADMIN_ROLE/);
  assert.match(source, /async function exportRun[\s\S]*actualRole\(\) !== ADMIN_ROLE/);
  assert.match(source, /verify_talent_item/);
  assert.match(source, /Only an Administrator can export an approved batch/);
});

test('export is a download-only action and UI never claims that Soro sent funds', () => {
  const source = read('operations/admin-payroll.js');
  assert.match(source, /response\.blob\(\)/);
  assert.match(source, /Content-Disposition/);
  assert.match(source, /anchor\.download/);
  assert.match(source, /No funds were sent/);
  assert.match(source, /Release the batch separately in Wise/);
  assert.match(source, /This button does not send money/);
  assert.doesNotMatch(source, /payment sent successfully|funds sent successfully/i);
});
