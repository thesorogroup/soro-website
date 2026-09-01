const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const operationsDirectory = path.join(__dirname, '..', 'operations');
const source = fs.readFileSync(path.join(operationsDirectory, 'talent-portal-access.js'), 'utf8');
const styles = fs.readFileSync(path.join(operationsDirectory, 'talent-portal-access.css'), 'utf8');
const page = fs.readFileSync(path.join(operationsDirectory, 'index.html'), 'utf8');

test('VA Portal access is management-only and stays out of the approved profile header', () => {
  assert.match(source, /new Set\(\['admin', 'talent_management'\]\)/);
  assert.match(source, /\.profile-summary-column \.profile-details-section/);
  assert.match(source, /detailsPanel\.insertAdjacentElement\('afterend', card\)/);
  assert.doesNotMatch(source, /querySelector\(['"]\.profile-actions/);
});

test('cached portal state does not trigger a self-sustaining MutationObserver render loop', () => {
  assert.match(source, /if \(cached\?\.access\) \{\s*if \(created\) renderCard\(applicant, cached\.access\);\s*return;\s*\}\s*loadStatus\(applicant\);/);
});

test('portal actions use secure emailed links and never expose credentials', () => {
  for (const action of ['status', 'activate', 'resend_invitation', 'change_email', 'send_password_reset']) {
    assert.match(source, new RegExp(`['\"]${action}['\"]`));
  }
  assert.match(source, /emailDelivered/);
  assert.doesNotMatch(source, /temporaryPassword|temporary_password|copyable.*password|copy.*token/i);
  assert.match(source, /Sign-in and application emails are managed separately/);
  assert.match(source, /change_email', \{ email \}/);
  assert.match(source, /reactivate_access: 'VA Portal access was reactivated\.'/);
  assert.doesNotMatch(source, /reactivated and a secure access email was sent/i);
});

test('paused and failed-delivery states have usable recovery actions', () => {
  assert.match(source, /paused:[\s\S]*?primaryAction: 'reactivate_access'/);
  assert.match(source, /delivery_failed:[\s\S]*?primaryAction: 'resend_invitation'/);
  assert.match(source, /error\.code === 'email_delivery_failed'[\s\S]*?loadStatus\(applicant, \{ force: true, preserveOnError: true \}\)/);
});

test('portal controls and accessible mobile styles are loaded by Soro Ops', () => {
  assert.match(page, /talent-portal-access\.css\?v=20260828-va-portal-access/);
  assert.match(page, /talent-portal-access\.js\?v=20260901-role-view-access/);
  assert.match(styles, /@media \(max-width: 640px\)/);
  assert.match(source, /aria-live=\"polite\"/);
  assert.match(source, /aria-busy/);
});
