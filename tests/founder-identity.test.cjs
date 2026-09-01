const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase', 'migrations', '20260831_031_founder_identity.sql'), 'utf8');
const auth = fs.readFileSync(path.join(root, 'operations', 'auth.js'), 'utf8');

test('Founder remains an Admin identity marker rather than a new authorization role', () => {
  assert.match(migration, /add column if not exists is_founder boolean not null default false/i);
  assert.match(migration, /role\s*=\s*'admin'::public\.platform_role/i);
  assert.match(migration, /platform_users_founder_requires_admin/i);
  assert.doesNotMatch(migration, /alter type public\.platform_role[\s\S]*add value[\s\S]*founder/i);
  assert.doesNotMatch(auth, /authorizedRoles[\s\S]{0,300}['"]founder['"]/i);
});

test('Founder identity is globally unique and reserved for the existing Matt account', () => {
  assert.match(migration, /lower\(account\.email\)\s*=\s*'matt@thesorogroup\.com'/i);
  assert.match(migration, /if v_match_count <> 1 then[\s\S]*raise exception/i);
  assert.match(migration, /if exists\s*\([\s\S]*is_founder\s*=\s*true[\s\S]*id\s*<>\s*v_founder_user_id[\s\S]*raise exception/i);
  assert.match(migration, /create unique index if not exists platform_users_single_founder_uidx[\s\S]*on public\.platform_users \(is_founder\)[\s\S]*where is_founder = true/i);
  assert.doesNotMatch(migration, /insert into auth\.users|\/auth\/v1\/admin\/users/i);
  assert.doesNotMatch(migration, /insert into public\.employee_profiles/i);
});

test('Founder migration fails closed unless the existing account is an organization-linked Administrator', () => {
  assert.match(migration, /v_founder_role\s*<>\s*'admin'::public\.platform_role/i);
  assert.match(migration, /v_founder_organization_id is null/i);
  assert.match(migration, /v_founder_active is not true/i);
  assert.match(migration, /select access\.id, access\.role, access\.organization_id, access\.active[\s\S]*into strict/i);
  assert.match(migration, /if not found and not exists[\s\S]*raise exception/i);
});

test('Founder identity cannot be reassigned or deleted through ordinary Administrator access', () => {
  assert.match(migration, /create or replace function private\.protect_founder_identity\(\)/i);
  assert.match(migration, /if new\.is_founder is distinct from old\.is_founder[\s\S]*errcode = '42501'/i);
  assert.match(migration, /new\.id is distinct from old\.id[\s\S]*new\.role is distinct from old\.role[\s\S]*new\.organization_id is distinct from old\.organization_id[\s\S]*new\.active is distinct from old\.active[\s\S]*new\.must_change_password is distinct from old\.must_change_password/i);
  assert.match(migration, /if tg_op = 'DELETE' and old\.is_founder = true then[\s\S]*errcode = '42501'/i);
  assert.match(migration, /before update of id, is_founder, role, organization_id, active, must_change_password on public\.platform_users/i);
  assert.match(migration, /before delete on public\.platform_users/i);
  assert.match(migration, /revoke all on function private\.protect_founder_identity\(\) from public, anon, authenticated/i);
});

test('Founder migration is a data no-op when the reserved marker is already correct', () => {
  assert.match(migration, /where id = v_founder_user_id\s+and is_founder = false/i);
  assert.match(migration, /if not found and not exists\s*\([\s\S]*is_founder = true[\s\S]*then/i);
});

test('authenticated shell reads the marker and displays The Founder without changing Admin access', () => {
  const selectMatches = auth.match(/\.select\('organization_id,role,display_name,is_founder,active,must_change_password,initial_password_issued_at,password_changed_at'\)/g) || [];
  assert.equal(selectMatches.length, 2, 'Normal and recovery access lookups must both include is_founder.');
  assert.match(auth, /function roleLabelForAccess\(access\)/);
  assert.match(auth, /access\?\.role === 'admin' && access\?\.is_founder === true/);
  assert.match(auth, /return 'The Founder'/);
  assert.match(auth, /admin:\s*'admin'/, 'The Founder must continue using the Admin workspace mapping.');
});

test('Admin employee directory includes an honest incomplete Founder fallback without fake PII', () => {
  assert.match(migration, /create or replace function public\.admin_employee_directory\(\)/i);
  assert.match(migration, /security definer/i);
  assert.match(migration, /if not private\.is_soro_admin\(\) then[\s\S]*errcode = '42501'/i);
  assert.match(migration, /where profile\.organization_id = v_organization_id/i);
  assert.match(migration, /access\.is_founder = true[\s\S]*not exists[\s\S]*public\.employee_profiles/i);
  assert.match(migration, /false as profile_complete/i);
  assert.match(migration, /true as profile_complete/i);
  assert.match(migration, /null::text as phone/i);
  assert.match(migration, /null::date as hire_date/i);
  assert.match(migration, /null::text as address_line_1/i);
  assert.match(migration, /join auth\.users as account on account\.id = access\.id/i);
  assert.match(migration, /lower\(account\.email\) as email/i);
  assert.match(migration, /revoke all on function public\.admin_employee_directory\(\) from public, anon/i);
  assert.match(migration, /grant execute on function public\.admin_employee_directory\(\) to authenticated/i);
});
