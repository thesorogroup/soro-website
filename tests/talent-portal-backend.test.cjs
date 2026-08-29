const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const manager = require(path.join(root, 'netlify', 'functions', 'talent-portal-access.js'));
const setup = require(path.join(root, 'netlify', 'functions', 'talent-account-setup.js'));
const adminRecords = require(path.join(root, 'netlify', 'functions', 'admin-records.js'));

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function jwtWithAmr(method, timestamp) {
  const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encoded({ alg: 'none' })}.${encoded({ amr: [{ method, timestamp }] })}.unsigned`;
}

test('manager status exposes only state-appropriate action names', () => {
  assert.deepEqual(manager.availableActionsForStatus('not_invited'), ['activate']);
  assert.deepEqual(manager.availableActionsForStatus('invite_pending'), ['resend_invitation', 'change_email', 'suspend_access']);
  assert.deepEqual(manager.availableActionsForStatus('delivery_failed'), ['resend_invitation', 'change_email', 'suspend_access']);
  assert.deepEqual(manager.availableActionsForStatus('active'), ['send_password_reset', 'change_email', 'suspend_access']);
  assert.deepEqual(manager.availableActionsForStatus('suspended'), ['reactivate_access']);
  assert.deepEqual(manager.availableActionsForStatus('needs_attention'), []);
});

test('reactivation restores pending setup without bypassing the password gate', () => {
  assert.equal(manager.statusAfterReactivation({ must_change_password: true }), 'invite_pending');
  assert.equal(manager.statusAfterReactivation({ must_change_password: false }), 'active');

  const source = read('netlify/functions/talent-portal-access.js');
  const start = source.indexOf('async function reactivateAccess');
  const end = source.indexOf('exports.handler', start);
  const body = source.slice(start, end);
  assert.doesNotMatch(body, /setup_required/);
  assert.match(body, /portal_access_status: portalAccessStatus/);
  assert.match(body, /catch \(error\)[\s\S]*?patchPlatformUser\(manager, access\.id, \{ active: false \}\)/);
});

test('self-service recovery accepts a recent Supabase recovery AMR without a manager timestamp', () => {
  const nowMs = Date.UTC(2026, 7, 28, 12, 0, 0);
  const nowSeconds = Math.floor(nowMs / 1000);
  assert.equal(setup.linkSessionIsRecent(jwtWithAmr('recovery', nowSeconds - 30), nowMs), true);
  assert.equal(setup.linkSessionIsRecent(jwtWithAmr('otp', nowSeconds - 30), nowMs), true);
  assert.equal(setup.linkSessionIsRecent(jwtWithAmr('password', nowSeconds - 30), nowMs), false);
  assert.equal(setup.linkSessionIsRecent(jwtWithAmr('recovery', nowSeconds - setup.LINK_SESSION_MAX_AGE_SECONDS - 1), nowMs), false);
});

test('manager-issued recovery timestamps reject an older recovery session', () => {
  const nowMs = Date.UTC(2026, 7, 28, 12, 0, 0);
  const nowSeconds = Math.floor(nowMs / 1000);
  const token = jwtWithAmr('recovery', nowSeconds - 300);
  assert.equal(setup.linkSessionMatchesIssueTime(token, new Date(nowMs - 60_000).toISOString(), nowMs), false);
  assert.equal(setup.linkSessionMatchesIssueTime(token, new Date(nowMs - 360_000).toISOString(), nowMs), true);
});

test('migration gates every VA role helper on completed setup and active profile access', () => {
  const migration = read('supabase/migrations/20260828_020_talent_portal_access.sql');
  assert.match(migration, /create or replace function private\.current_soro_role\(\)[\s\S]*?access\.must_change_password = false/);
  assert.match(migration, /access\.role <> 'virtual_assistant'[\s\S]*?applicant\.archived_at is null[\s\S]*?applicant\.portal_access_status = 'active'/);
  assert.match(migration, /create or replace function private\.current_soro_organization_id\(\)[\s\S]*?access\.must_change_password = false/);
});

test('setup clears the password gate only after the applicant activation write', () => {
  const source = read('netlify/functions/talent-account-setup.js');
  const setupStart = source.indexOf('async function completeSetup');
  const setupEnd = source.indexOf('async function completeRecovery');
  const body = source.slice(setupStart, setupEnd);
  assert.ok(body.indexOf("portal_access_status: 'active'") < body.indexOf('must_change_password: false'));
  assert.match(source, /LINK_AMR_METHODS = new Set\(\['email', 'magiclink', 'otp', 'recovery'\]\)/);
});

test('VA setup cannot bypass the applicant lifecycle through the employee password endpoint', () => {
  const source = read('netlify/functions/admin-employees.js');
  const start = source.indexOf('async function changeInitialPassword');
  const end = source.indexOf('exports.handler', start);
  const body = source.slice(start, end);
  assert.match(body, /authenticated\.access\.role === 'virtual_assistant'/);
  assert.match(body, /secure_invitation_required/);
  assert.ok(body.indexOf("authenticated.access.role === 'virtual_assistant'") < body.indexOf('must_change_password !== true'));
});

test('permanent Talent deletion revokes verified VA access before deleting the profile', () => {
  const source = read('netlify/functions/admin-records.js');
  assert.match(source, /organization_id=eq\.\$\{encodeURIComponent\(administrator\.access\.organization_id\)\}/);
  assert.match(source, /access\.role !== 'virtual_assistant'/);
  assert.match(source, /active: false, must_change_password: true/);
  assert.ok(source.indexOf('await revokeTalentPortalAccess') < source.indexOf('await removeStorageFiles(documents)'));
  assert.ok(source.indexOf('await revokeTalentPortalAccess') < source.indexOf("await serviceRequest(`/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`"));
});

test('permanent deletion requires recent password authentication, not a fresh token alone', () => {
  const nowMs = Date.UTC(2026, 7, 28, 12, 0, 0);
  const nowSeconds = Math.floor(nowMs / 1000);
  const originalNow = Date.now;
  Date.now = () => nowMs;
  try {
    assert.equal(adminRecords.tokenIssuedRecently(jwtWithAmr('password', nowSeconds - 30)), true);
    assert.equal(adminRecords.tokenIssuedRecently(jwtWithAmr('otp', nowSeconds - 30)), false);
    assert.equal(adminRecords.tokenIssuedRecently(jwtWithAmr('password', nowSeconds - 301)), false);
  } finally {
    Date.now = originalNow;
  }
});
