const assert = require('node:assert/strict');
const test = require('node:test');

const readiness = require('../operations/employee-payroll-readiness.js');

const AS_OF = '2026-09-03';
const employee = overrides => ({
  full_name: 'Jordan Reed',
  email: 'jordan@example.com',
  phone: '+1 555 0100',
  hire_date: '2026-08-01',
  payment_route: 'wise_contractor',
  payout_recipient_email: 'jordan@example.com',
  city: 'Manila',
  country: 'Philippines',
  profile_complete: true,
  platform_users: { active: true, role: 'talent_management' },
  ...overrides
});

test('the portal cache-busts the Founder-aware payroll readiness helper', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'operations', 'index.html'), 'utf8');
  assert.match(html, /employee-payroll-readiness\.js\?v=20260831-founder-readiness/);
});

test('an incomplete directory-only identity never appears as a payroll setup exception', () => {
  const incomplete = employee({ profile_complete: false, hire_date: null, payment_route: 'needs_setup' });
  assert.deepEqual(readiness.employeeState(incomplete, AS_OF), { key: 'profile_incomplete', label: 'Employee profile incomplete' });
  assert.equal(readiness.includedInReview(incomplete, { asOf: AS_OF }), false);
});

test('employee payroll readiness classifies every directory state without browser inference', () => {
  const fixtures = [
    [employee({}), 'wise_ready', 'Wise-ready'],
    [employee({ payout_recipient_email: '' }), 'needs_setup', 'Wise recipient missing'],
    [employee({ payment_route: 'needs_setup', payout_recipient_email: '' }), 'needs_setup', 'Payment setup required'],
    [employee({ payment_route: 'quickbooks_employee', payout_recipient_email: '' }), 'quickbooks', 'QuickBooks-only'],
    [employee({ platform_users: { active: false, role: 'sales' } }), 'inactive', 'Inactive'],
    [employee({ hire_date: '2026-09-04' }), 'future_hire', 'Future hire']
  ];
  for (const [record, key, label] of fixtures) {
    assert.deepEqual(readiness.employeeState(record, AS_OF), { key, label });
  }
});

test('invalid calendar dates are rejected and resolve only to a valid fallback', () => {
  for (const invalid of ['2026-02-30', '2026-13-01', '09/03/2026', '', null]) {
    assert.equal(readiness.validIsoDate(invalid), '');
    assert.equal(readiness.resolveAsOf(invalid, AS_OF), AS_OF);
    assert.equal(readiness.employeeState(employee({}), invalid).key, 'invalid');
  }
  assert.equal(readiness.resolveAsOf('2026-02-30', 'also-bad'), '');
});

test('the directory review filter activates only with its allowlisted mode and a real cutoff date', () => {
  assert.deepEqual(readiness.filterState(`?employeeFilter=payroll-readiness&payrollAsOf=${AS_OF}`), { active: true, asOf: AS_OF });
  assert.deepEqual(readiness.filterState('?employeeFilter=payroll-readiness&payrollAsOf=2026-99-99'), { active: false, asOf: '' });
  assert.deepEqual(readiness.filterState(`?employeeFilter=anything-else&payrollAsOf=${AS_OF}`), { active: false, asOf: AS_OF });
  assert.deepEqual(readiness.filterState(''), { active: false, asOf: '' });
});

test('the payroll-readiness directory filter includes only setup attention and keeps search conjunctive', () => {
  const missingRecipient = employee({ full_name: 'Jordan Missing', payout_recipient_email: '' });
  const explicitSetup = employee({ full_name: 'Alex Setup', email: 'alex@example.com', payment_route: 'needs_setup', payout_recipient_email: '' });
  const ready = employee({ full_name: 'Jordan Ready' });

  assert.equal(readiness.includedInReview(missingRecipient, { asOf: AS_OF }), true);
  assert.equal(readiness.includedInReview(explicitSetup, { asOf: AS_OF }), true);
  assert.equal(readiness.includedInReview(ready, { asOf: AS_OF }), false);
  assert.equal(readiness.includedInReview(missingRecipient, { asOf: AS_OF, query: 'jordan' }), true);
  assert.equal(readiness.includedInReview(missingRecipient, { asOf: AS_OF, query: 'alex' }), false);
  assert.equal(readiness.includedInReview(explicitSetup, { asOf: AS_OF, query: 'alex@example.com' }), true);
});
