const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const original = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '20260901_033_global_directory_search.sql'),
  'utf8'
);
const hardened = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '20260901_038_sales_client_read_scope.sql'),
  'utf8'
);
const pipeline = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '20260901_036_client_pipeline_and_access.sql'),
  'utf8'
);

function functionBlock(source, name) {
  const pattern = new RegExp(
    `create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,
    'i'
  );
  return source.match(pattern)?.[0] || '';
}

function normalize(source) {
  return source.replace(/\s+/g, ' ').trim();
}

const ownerGuard = /\s+and \(\s*v_actor_role <> 'sales'::public\.platform_role\s+or client\.sales_owner_id = p_actor_user_id\s*\)/gi;
const canonicalPrimaryGuard = /\s+and active_contact\.is_primary = true/gi;
const legacyPrimaryGuard = /\s+and lower\(active_contact\.contact_role\) = 'primary'/gi;
const originalSearch = functionBlock(original, 'search_operations_directory');
const hardenedSearch = functionBlock(hardened, 'search_operations_directory');
const originalProfile = functionBlock(original, 'get_internal_client_profile');
const hardenedProfile = functionBlock(hardened, 'get_internal_client_profile');
const auditPolicy = hardened.match(
  /drop policy if exists "authorized internal users can read audit history"[\s\S]*?\n\);/i
)?.[0] || '';

test('038 replaces both legacy security-definer RPCs and keeps them service-only', () => {
  for (const [name, block, signature] of [
    ['search_operations_directory', hardenedSearch, 'uuid, text'],
    ['get_internal_client_profile', hardenedProfile, 'uuid, uuid']
  ]) {
    assert.ok(block, `${name} must be replaced`);
    assert.match(block, /stable[\s\S]*security definer[\s\S]*set search_path = pg_catalog, public, private/i);
    assert.match(
      hardened,
      new RegExp(`revoke all on function public\\.${name}\\(${signature.replace(' ', '\\s*')}\\)\\s+from public, anon, authenticated`, 'i')
    );
    assert.match(
      hardened,
      new RegExp(`grant execute on function public\\.${name}\\(${signature.replace(' ', '\\s*')}\\)\\s+to service_role`, 'i')
    );
  }
  assert.doesNotMatch(hardened, /create or replace function public\.get_internal_talent_profile/i);
});

test('ordinary Sales search sees only owned Clients through company and contact matches', () => {
  const guards = hardenedSearch.match(ownerGuard) || [];
  assert.equal(guards.length, 2, 'both Client search branches must enforce Sales ownership');
  assert.equal((hardenedSearch.match(/from public\.clients as client/gi) || []).length, 2);
  assert.match(hardenedSearch, /client\.organization_id = v_organization_id/);
  assert.match(hardenedSearch, /client\.archived_at is null/);
  assert.doesNotMatch(hardenedSearch, /client\.sales_owner_id is null/i);
  assert.doesNotMatch(hardenedSearch, /or\s+p_actor_user_id is null/i);
});

test('internal Client profile returns not-found unless an ordinary Sales actor owns the Client', () => {
  const guards = hardenedProfile.match(ownerGuard) || [];
  assert.equal(guards.length, 1);
  assert.match(
    hardenedProfile,
    /client\.id = p_client_id[\s\S]*client\.organization_id = v_organization_id[\s\S]*client\.archived_at is null[\s\S]*v_actor_role <> 'sales'::public\.platform_role[\s\S]*client\.sales_owner_id = p_actor_user_id/i
  );
  assert.match(hardenedProfile, /if not found then[\s\S]*errcode = 'P0002'/i);
});

test('Admin, Sales Management, Talent Management, and Billing retain organization Client scope', () => {
  for (const role of ['admin', 'sales_management', 'talent_management', 'billing']) {
    assert.match(hardenedSearch, new RegExp(`'${role}'::public\\.platform_role`, 'i'));
    assert.match(hardenedProfile, new RegExp(`'${role}'::public\\.platform_role`, 'i'));
  }
  assert.match(hardenedSearch, /v_actor_role <> 'sales'::public\.platform_role/);
  assert.match(hardenedProfile, /v_actor_role <> 'sales'::public\.platform_role/);
});

test('038 changes only the Sales Client ownership predicates in the two RPC bodies', () => {
  assert.equal(
    normalize(hardenedSearch.replace(ownerGuard, '')),
    normalize(originalSearch),
    'search ranking, Client payload, and Talent behavior must stay byte-equivalent after removing the guards'
  );
  assert.equal(
    normalize(hardenedProfile.replace(ownerGuard, '').replace(canonicalPrimaryGuard, '')),
    normalize(originalProfile.replace(legacyPrimaryGuard, '')),
    'the internal Client safe projection must stay unchanged apart from ownership and the canonical primary marker'
  );
});

test('canonical Client creation marks its primary contact independently of the display role', () => {
  assert.match(
    pipeline,
    /alter table public\.client_contacts[\s\S]*add column if not exists is_primary boolean not null default false/i
  );
  assert.match(
    pipeline,
    /create unique index if not exists client_contacts_one_primary_per_client[\s\S]*on public\.client_contacts \(client_id\)[\s\S]*where is_primary = true/i
  );
  assert.match(
    pipeline,
    /insert into public\.client_contacts \(\s*organization_id, client_id, full_name, email, phone, contact_role, active, is_primary[\s\S]*?\) values \([\s\S]*?coalesce\(nullif\(btrim\(coalesce\(v_payload #>> '\{primaryContact,contactRole\}', ''\)\), ''\), 'Primary contact'\),\s*true,\s*true\s*\)/i
  );
  assert.match(hardenedProfile, /active_contact\.active = true[\s\S]*active_contact\.is_primary = true/i);
  assert.doesNotMatch(hardenedProfile, /lower\(active_contact\.contact_role\) = 'primary'/i);
});

test('raw Client lifecycle audits are limited to Admin oversight while legacy special cases stay narrow', () => {
  assert.ok(auditPolicy, '038 must replace the raw audit SELECT policy after all lifecycle entity types exist');
  const lifecycleBranch = auditPolicy.match(
    /when entity_type in \(\s*'client',[\s\S]*?\) then\s*private\.current_soro_role\(\) in \(([\s\S]*?)\)\s*else true/i
  );
  assert.ok(lifecycleBranch, 'Client lifecycle audit entity types need one explicit fail-closed branch');
  for (const entityType of [
    'client', 'client_contact', 'hiring_request', 'client_portal_access',
    'client_candidate_interview', 'client_candidate_decision', 'client_placement_handoff',
    'placement_onboarding_item', 'placement'
  ]) assert.match(lifecycleBranch[0], new RegExp(`'${entityType}'`, 'i'));
  assert.match(lifecycleBranch[1], /'admin'::public\.platform_role/i);
  assert.match(lifecycleBranch[1], /'sales_management'::public\.platform_role/i);
  for (const forbiddenRole of ['sales', 'talent_management', 'billing', 'client_admin', 'client_reviewer', 'client_billing']) {
    assert.doesNotMatch(lifecycleBranch[1], new RegExp(`'${forbiddenRole}'::public\\.platform_role`, 'i'));
  }

  assert.match(auditPolicy, /entity_type = 'employee_payroll'[\s\S]*?current_soro_role\(\) = 'admin'/i);
  assert.match(auditPolicy, /entity_type = 'employee' and event_type = 'employee_payment_route_update'[\s\S]*?current_soro_role\(\) = 'admin'/i);
  assert.match(auditPolicy, /entity_type in \('client_shortlist', 'client_shortlist_item'\)[\s\S]*?'sales_management'::public\.platform_role/i);
  for (const entityType of [
    'talent_payout', 'talent_portal_access', 'talent_attendance', 'talent_time_off',
    'talent_review_queue', 'talent_verification', 'available_talent_bench', 'available_talent_bench_settings'
  ]) assert.match(auditPolicy, new RegExp(`'${entityType}'`, 'i'));
  assert.match(auditPolicy, /'talent_management'::public\.platform_role[\s\S]*?when entity_type in \(\s*'client'/i);
});

test('search safe payload keys and result caps remain unchanged', () => {
  assert.equal((hardenedSearch.match(/limit 5/gi) || []).length, 2);
  for (const key of ['entityType', 'recordId', 'primaryLabel', 'secondaryLabel', 'statusLabel', 'matchedOn']) {
    assert.match(hardenedSearch, new RegExp(`'${key}'`, 'i'));
  }
  for (const forbidden of ['organizationId', 'salesOwnerId', 'authUserId', 'storagePath']) {
    assert.doesNotMatch(hardenedSearch, new RegExp(`'${forbidden}'`, 'i'));
  }
});
