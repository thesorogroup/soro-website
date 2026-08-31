const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const migrationPath = path.join(root, 'supabase', 'migrations', '20260830_027_employee_payroll_readiness.sql');
const sql = fs.readFileSync(migrationPath, 'utf8');

test('employee payroll readiness stays service-only and organization-scoped', () => {
  assert.match(sql, /create or replace function private\.employee_payroll_readiness_json\s*\(\s*p_organization_id uuid,\s*p_as_of date default null\s*\)/i);
  assert.match(sql, /security definer\s+set search_path\s*=\s*pg_catalog,\s*public,\s*private/i);
  assert.match(sql, /profile\.organization_id\s*=\s*p_organization_id/i);
  assert.match(sql, /access\.organization_id\s*=\s*profile\.organization_id/i);
  assert.match(sql, /revoke all on function private\.employee_payroll_readiness_json\(uuid, date\)\s+from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function private\.employee_payroll_readiness_json\(uuid, date\)\s+to service_role/i);
});

test('workspace exposes employee readiness to Administrators only', () => {
  const workspace = sql.slice(sql.indexOf('create or replace function public.get_admin_payroll_workspace'));
  assert.match(workspace, /private\.financial_actor\(p_actor_user_id, true\)/i);
  assert.match(workspace, /when v_actor\.role\s*=\s*'admin'::public\.platform_role then[\s\S]*'readiness'\s*,\s*private\.employee_payroll_readiness_json\(v_actor\.organization_id, null\)/i);
  assert.match(workspace, /else null/i);
  assert.match(workspace, /revoke all on function public\.get_admin_payroll_workspace\(uuid\)\s+from public, anon, authenticated/i);
  assert.match(workspace, /grant execute on function public\.get_admin_payroll_workspace\(uuid\)\s+to service_role/i);
});

test('readiness is a no-PII count summary aligned to the default payroll period end', () => {
  const readiness = sql.slice(
    sql.indexOf('create or replace function private.employee_payroll_readiness_json'),
    sql.indexOf('revoke all on function private.employee_payroll_readiness_json')
  );
  for (const key of ['asOf', 'total', 'wiseEligible', 'wiseConfigured', 'needsSetup', 'quickbooks', 'inactive', 'futureHire', 'canRunPayroll']) {
    assert.match(readiness, new RegExp(`'${key}'`));
  }
  for (const pii of ['full_name', 'email_snapshot', 'phone', 'address_line', 'display_name']) {
    assert.doesNotMatch(readiness, new RegExp(pii, 'i'));
  }
  assert.match(readiness, /pg_catalog\.statement_timestamp\(\)\s+at time zone 'America\/Chicago'/i);
  assert.match(readiness, /extract\(isodow from business_clock\.business_date\)/i);
  assert.match(readiness, /profile\.hire_date\s*<=\s*boundary\.as_of/i);
  assert.match(readiness, /profile\.hire_date\s*>\s*boundary\.as_of/i);
  assert.match(readiness, /nullif\(btrim\(profile\.payout_recipient_email\), ''\) is not null/i);
  assert.match(readiness, /coalesce\(counts\.wise_eligible, 0\)\s*>\s*0/i);
});
