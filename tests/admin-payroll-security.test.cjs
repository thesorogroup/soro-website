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

const migrationPath = 'supabase/migrations/20260829_026_payroll_and_payout_batches.sql';

test('financial tables and RPCs are service-only with no authenticated direct access', () => {
  const sql = read(migrationPath);
  for (const table of ['employee_payroll_runs', 'employee_payroll_items', 'talent_payout_runs', 'talent_payout_items', 'financial_run_operations']) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
    assert.match(sql, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`, 'i'));
  }
  for (const rpc of [
    'get_admin_payroll_workspace', 'create_employee_payroll_run', 'update_employee_payroll_item',
    'transition_employee_payroll_run', 'get_employee_payroll_export', 'create_talent_payout_run',
    'update_talent_payout_item', 'verify_talent_payout_item', 'transition_talent_payout_run',
    'get_talent_payout_export'
  ]) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${rpc}\\([^;]+from public, anon, authenticated`, 'i'), `${rpc} must be revoked from browser roles`);
    assert.match(sql, new RegExp(`grant execute on function public\\.${rpc}\\([^;]+to service_role`, 'i'), `${rpc} must be service-only`);
  }
});

test('employee payroll is Administrator-only and Talent Management is limited to Talent verification', () => {
  const sql = read(migrationPath);
  const actorStart = sql.indexOf('create or replace function private.financial_actor');
  const actorEnd = sql.indexOf('create or replace function private.record_financial_audit', actorStart);
  const actorHelper = sql.slice(actorStart, actorEnd);
  assert.match(actorHelper, /access\.role\s*=\s*'admin'::public\.platform_role/i);
  assert.match(actorHelper, /p_allow_talent_management\s+and\s+access\.role\s*=\s*'talent_management'::public\.platform_role/i);

  const employeeStart = sql.indexOf('create or replace function public.create_employee_payroll_run');
  const talentStart = sql.indexOf('create or replace function public.create_talent_payout_run');
  assert.ok(employeeStart >= 0 && talentStart > employeeStart);
  const employeeFunctions = sql.slice(employeeStart, talentStart);
  assert.match(employeeFunctions, /private\.financial_actor\([^)]*false\)/i);
  assert.doesNotMatch(employeeFunctions, /p_allow_talent_management\s*=>\s*true/i);

  const verificationStart = sql.indexOf('create or replace function public.verify_talent_payout_item');
  const verificationEnd = sql.indexOf('create or replace function public.transition_talent_payout_run', verificationStart);
  const verification = sql.slice(verificationStart, verificationEnd);
  assert.match(verification, /private\.financial_actor\([^)]*true\)/i);

  const transition = sql.slice(verificationEnd, sql.indexOf('create or replace function public.get_talent_payout_export', verificationEnd));
  assert.match(transition, /private\.financial_actor\([^)]*false\)/i, 'Talent approval, export, release, and cancellation must be Admin-only');
});

test('organization scope, totals, payment references, and eligible populations are server-derived', () => {
  const endpoint = read('netlify/functions/admin-payroll.js');
  const sql = read(migrationPath);

  assert.doesNotMatch(endpoint, /body\.(?:organizationId|organization_id|viewerRole|role|totalAmount|itemCount|paymentReference)/);
  assert.match(endpoint, /p_actor_user_id:\s*user\.id/);
  assert.match(sql, /organization_id\s*=\s*v_actor\.organization_id/i);
  assert.match(sql, /private\.recalculate_employee_payroll_run/i);
  assert.match(sql, /private\.recalculate_talent_payout_run/i);
  assert.match(sql, /payment_reference/i);
  assert.match(sql, /placements/i);
  assert.match(sql, /access\.active\s*=\s*true/i);
  assert.match(sql, /profile\.payment_route\s*=\s*'wise_contractor'::public\.employee_payment_route/i);
  assert.match(sql, /'paymentRoute'\s*,\s*item\.payment_route_snapshot/i);
  assert.match(sql, /'payoutRecipientEmail'\s*,\s*item\.payout_recipient_email_snapshot/i);
  assert.doesNotMatch(sql.slice(sql.indexOf('create or replace function public.create_employee_payroll_run'), sql.indexOf('create or replace function public.update_employee_payroll_item')), /quickbooks_employee/i);
  assert.match(sql, /array\[['"]placement_confirmed['"][\s\S]*['"]active['"][\s\S]*['"]placed['"]\]/i);
});

test('idempotency fingerprints prevent request-id replay with different financial inputs', () => {
  const sql = read(migrationPath);
  assert.match(sql, /create table if not exists public\.financial_run_operations[\s\S]*operation_request_id uuid[\s\S]*request_fingerprint text/i);
  assert.match(sql, /private\.financial_operation_seen/i);
  assert.match(sql, /request_fingerprint\s+is\s+distinct\s+from\s+p_fingerprint/i);
  assert.match(sql, /request id has already been used for another financial operation/i);
  assert.match(sql, /operation_request_id\s+uuid\s+primary key/i);
});

test('every digest-using financial RPC resolves Supabase pgcrypto from the extensions schema', () => {
  const sql = read(migrationPath);
  for (const rpc of [
    'create_employee_payroll_run', 'update_employee_payroll_item', 'create_talent_payout_run',
    'update_talent_payout_item', 'verify_talent_payout_item', 'transition_employee_payroll_run',
    'transition_talent_payout_run'
  ]) {
    const start = sql.indexOf(`create or replace function public.${rpc}`);
    assert.notEqual(start, -1, `${rpc} must exist.`);
    const nextFunction = sql.indexOf('create or replace function ', start + 1);
    const definition = sql.slice(start, nextFunction === -1 ? undefined : nextFunction);
    assert.match(definition, /set search_path\s*=\s*pg_catalog,\s*public,\s*private,\s*extensions/i, `${rpc} must resolve pgcrypto securely.`);
    assert.match(definition, /\bdigest\s*\(/i, `${rpc} must fingerprint financial operations.`);
  }
});

test('approved and exported snapshots cannot be edited or silently recalculated', () => {
  const sql = read(migrationPath);
  assert.match(sql, /approved employee payroll snapshots cannot be changed/i);
  assert.match(sql, /approved Talent payout snapshots cannot be changed|approved talent payout snapshots cannot be changed/i);
  assert.match(sql, /guard_employee_payroll_run/i);
  assert.match(sql, /guard_talent_payout_run/i);
  assert.match(sql, /guard_employee_payroll_item/i);
  assert.match(sql, /guard_talent_payout_item/i);
});

test('editing material Talent payout details invalidates prior verification', () => {
  const sql = read(migrationPath);
  const updateStart = sql.indexOf('create or replace function public.update_talent_payout_item');
  const updateEnd = sql.indexOf('create or replace function public.verify_talent_payout_item', updateStart);
  const updateFunction = sql.slice(updateStart, updateEnd);
  assert.match(updateFunction, /v_next_email\s*:=\s*v_email\s*;/i, 'A blank edited recipient must clear a stale payout address.');
  assert.doesNotMatch(updateFunction, /v_next_email\s*:=\s*coalesce\s*\(\s*v_email\s*,\s*v_before\.recipient_email_snapshot\s*\)/i);
  assert.match(updateFunction, /v_before\.amount\s+is\s+distinct\s+from\s+p_amount/i);
  assert.match(updateFunction, /v_before\.included\s+is\s+distinct\s+from\s+p_included/i);
  assert.match(updateFunction, /v_before\.recipient_email_snapshot\s+is\s+distinct\s+from\s+v_next_email/i);
  assert.match(updateFunction, /when\s+v_material_change\s+then\s+'needs_review'/i);
  assert.match(updateFunction, /when\s+v_material_change\s+then\s+null[\s\S]*verified_at\s*=\s*case[\s\S]*when\s+v_material_change\s+then\s+null/i);
});

test('financial audit visibility excludes Sales, legacy Billing, Client, and Talent roles', () => {
  const sql = read(migrationPath);
  assert.match(sql, /when entity_type\s*=\s*'employee_payroll'/i);
  assert.match(sql, /when entity_type\s*=\s*'talent_payout'/i);
  assert.match(sql, /private\.current_soro_role\(\)\s*=\s*'admin'::public\.platform_role/i);
  assert.match(sql, /private\.current_soro_role\(\)\s+in\s*\(\s*'admin'::public\.platform_role\s*,\s*'talent_management'::public\.platform_role\s*\)/i);
  const financialPolicy = sql.slice(sql.search(/drop policy[^;]+audit history/i));
  for (const role of ['sales', 'billing', 'client_admin', 'client_reviewer', 'client_billing', 'virtual_assistant']) {
    assert.doesNotMatch(financialPolicy, new RegExp(`'${role}'::public\\.platform_role`, 'i'));
  }
});

test('exports never accept browser rows or totals and are hardened against spreadsheet formulas', () => {
  const endpoint = read('netlify/functions/admin-payroll.js');
  const contracts = endpoint.slice(endpoint.indexOf('const ACTION_KEYS'), endpoint.indexOf('function responseHeaders'));
  assert.match(contracts, /export_employee_run:[^\n]*\['action', 'requestId', 'runId'\]/);
  assert.match(contracts, /export_talent_run:[^\n]*\['action', 'requestId', 'runId'\]/);
  assert.doesNotMatch(contracts, /export_(?:employee|talent)_run[^\n]*(?:rows|total|currency|reference)/i);
  assert.match(endpoint, /\^\[\\t \]\*\[=\+\\-@\]/);
  assert.match(endpoint, /createHash\('sha256'\)/);
  assert.match(endpoint, /Content-Disposition/);
  assert.match(endpoint, /Cache-Control': 'no-store/);
  assert.match(endpoint, /staff-wise-preparation/);
  assert.match(endpoint, /Wise recipient email/);
  assert.match(endpoint, /value\.paymentRoute\s*!==\s*EMPLOYEE_WISE_ROUTE/);
  assert.doesNotMatch(endpoint, /api\.wise\.com|transferwise|funds sent successfully|payment sent successfully/i);
});
