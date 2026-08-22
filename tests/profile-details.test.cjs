const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const helpers = require('../operations/profile-details.js');
const operationsSource = fs.readFileSync(path.join(__dirname, '..', 'operations', 'operations-enhancements.js'), 'utf8');
const migrationSource = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260822_017_applicant_birth_date_bounds.sql'), 'utf8');

const computerStart = operationsSource.indexOf('function computerCard');
const computerEnd = operationsSource.indexOf('function connectionMeterTrack', computerStart);
if (computerStart < 0 || computerEnd < 0) throw new Error('Computer presentation helper could not be located.');
const computerContext = {
  escapeHtml: value => String(value ?? ''),
  screeningState: () => '<span>Recorded</span>',
  profileDetailsTools: helpers
};
vm.createContext(computerContext);
vm.runInContext(operationsSource.slice(computerStart, computerEnd), computerContext);

test('only Admin and Talent Management receive the private Profile details editor', () => {
  assert.equal(helpers.canManageProfileDetails('admin'), true);
  assert.equal(helpers.canManageProfileDetails('talent_management'), true);
  ['virtual_assistant', 'talent', 'sales', 'sales_management', 'client', 'billing', ''].forEach(role => {
    assert.equal(helpers.canManageProfileDetails(role), false, role);
  });
});

test('private Profile details remain visible to managers and the linked Talent only', () => {
  assert.equal(helpers.canViewPrivateProfileDetails({ role: 'admin' }), true);
  assert.equal(helpers.canViewPrivateProfileDetails({ role: 'talent_management' }), true);
  assert.equal(helpers.canViewPrivateProfileDetails({ role: 'virtual_assistant', userId: 'user-a', applicantAuthUserId: 'user-a' }), true);
  assert.equal(helpers.canViewPrivateProfileDetails({ role: 'virtual_assistant', userId: 'user-a', applicantAuthUserId: 'user-b' }), false);
  assert.equal(helpers.canViewPrivateProfileDetails({ role: 'sales', userId: 'user-a', applicantAuthUserId: 'user-a' }), false);
});

test('birth dates use strict ISO calendar validation', () => {
  assert.equal(helpers.parseIsoCalendarDate('2024-02-29').iso, '2024-02-29');
  assert.equal(helpers.parseIsoCalendarDate('2025-02-29'), null);
  assert.equal(helpers.parseIsoCalendarDate('08/22/2000'), null);
  assert.equal(helpers.validateBirthDate('1899-12-31', 'UTC', new Date('2026-08-22T12:00:00Z')).valid, false);
});

test('future-date validation follows the applicant IANA calendar day', () => {
  const instant = new Date('2026-01-01T00:30:00Z');
  const west = helpers.validateBirthDate('2026-01-01', 'America/Los_Angeles', instant);
  const east = helpers.validateBirthDate('2026-01-01', 'Pacific/Kiritimati', instant);
  assert.equal(west.valid, false);
  assert.match(west.error, /future/i);
  assert.equal(east.valid, true);
});

test('invalid or custom time zones fall back safely to UTC', () => {
  const invalid = helpers.calendarDateForInstant(new Date('2026-08-22T00:30:00Z'), 'Central Standard Time');
  const custom = helpers.calendarDateForInstant(new Date('2026-08-22T00:30:00Z'), 'Other');
  assert.deepEqual({ iso: invalid.iso, timeZone: invalid.timeZone, usedFallback: invalid.usedFallback }, { iso: '2026-08-22', timeZone: 'UTC', usedFallback: true });
  assert.deepEqual({ iso: custom.iso, timeZone: custom.timeZone, usedFallback: custom.usedFallback }, { iso: '2026-08-22', timeZone: 'UTC', usedFallback: true });
});

test('age changes on the calendar birthday in the applicant time zone', () => {
  const midday = new Date('2026-08-22T12:00:00Z');
  assert.equal(helpers.ageFromBirthDate('2000-08-22', 'UTC', midday), 26);
  assert.equal(helpers.ageFromBirthDate('2000-08-23', 'UTC', midday), 25);

  const nearMidnight = new Date('2026-08-22T00:30:00Z');
  assert.equal(helpers.ageFromBirthDate('2000-08-22', 'America/Los_Angeles', nearMidnight), 25);
  assert.equal(helpers.ageFromBirthDate('2000-08-22', 'Asia/Manila', nearMidnight), 26);
});

test('Feb. 29 birthdays advance on Mar. 1 in non-leap years', () => {
  assert.equal(helpers.ageFromBirthDate('2000-02-29', 'UTC', new Date('2025-02-28T12:00:00Z')), 24);
  assert.equal(helpers.ageFromBirthDate('2000-02-29', 'UTC', new Date('2025-03-01T12:00:00Z')), 25);
});

test('private profile updates contain only the three editable columns and never persist age', () => {
  const update = helpers.buildPrivateProfileUpdate({
    birthDate: '2000-08-22',
    genderIdentity: 'self_describe',
    genderSelfDescription: 'My own wording',
    timeZone: 'America/Chicago',
    instant: new Date('2026-08-22T12:00:00Z')
  });
  assert.deepEqual(Object.keys(update), ['birth_date', 'gender_identity', 'gender_identity_self_description']);
  assert.equal(Object.hasOwn(update, 'age'), false);
  assert.throws(() => helpers.buildPrivateProfileUpdate({ birthDate: '2026-08-23', timeZone: 'UTC', instant: new Date('2026-08-22T12:00:00Z') }), /future/i);
});

test('computer presentation distinguishes reported laptop states without replacing specifications', () => {
  assert.deepEqual({ ...helpers.computerDeviceState(true) }, { kind: 'laptop', label: 'Laptop reported' });
  assert.deepEqual({ ...helpers.computerDeviceState(false) }, { kind: 'desktop', label: 'No laptop reported' });
  assert.deepEqual({ ...helpers.computerDeviceState(null) }, { kind: 'generic', label: 'Device type not recorded' });
  assert.match(operationsSource, /professional-device-icon--laptop/);
  assert.match(operationsSource, /professional-device-icon--desktop/);
  assert.match(operationsSource, /computer-spec-list/);

  const laptop = computerContext.computerCard({ has_laptop: true, computer_specs: 'Windows 11 · Intel i5 · 16 GB RAM' });
  const noLaptop = computerContext.computerCard({ has_laptop: false, computer_specs: 'Desktop · Ryzen 5 · 16 GB RAM' });
  const unknown = computerContext.computerCard({ has_laptop: null, computer_specs: '' });
  assert.match(laptop, /screening-device-visual--laptop[^>]+aria-label="Laptop reported"/);
  assert.match(noLaptop, /screening-device-visual--desktop[^>]+aria-label="No laptop reported"/);
  assert.match(unknown, /screening-device-visual--generic[^>]+aria-label="Device type not recorded"/);
  assert.match(laptop, /<dt>System<\/dt><dd>Windows 11/);
});

test('real profile source keeps Dream, binds the restricted editor, and updates narrow columns', () => {
  assert.match(operationsSource, /Dream \/ goal/);
  assert.match(operationsSource, /bindPrivateProfileDetailsEditor\(\);/);
  assert.match(operationsSource, /select\('birth_date,gender_identity,gender_identity_self_description'\)/);
  assert.doesNotMatch(operationsSource, /age\s*:/);
});

test('private Profile details remain open for Escape and backdrop clicks', () => {
  assert.match(operationsSource, /dialog\.addEventListener\('cancel', event => event\.preventDefault\(\)\)/);
  assert.match(operationsSource, /if \(event\.target !== dialog\) return;[\s\S]*?event\.stopPropagation\(\)/);
  assert.match(operationsSource, /data-close-private-profile-details/);
});

test('database trigger enforces date hygiene without imposing an employment-age rule or copying raw data', () => {
  assert.match(migrationSource, /before insert or update of birth_date on public\.applicants/i);
  assert.match(migrationSource, /new\.birth_date < date '1900-01-01'/i);
  assert.match(migrationSource, /new\.birth_date > current_date/i);
  assert.doesNotMatch(migrationSource, /minimum age|employment age|legacy_application_data|raw_submission|\bage\s*=\s*/i);
});
