const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '20260901_033_global_directory_search.sql'),
  'utf8'
);

function functionBlock(name) {
  const pattern = new RegExp(
    `create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,
    'i'
  );
  return migration.match(pattern)?.[0] || '';
}

const searchFunction = functionBlock('search_operations_directory');
const profileFunction = functionBlock('get_internal_client_profile');
const talentProfileFunction = functionBlock('get_internal_talent_profile');

test('033 exposes only service-role RPCs with pinned search paths', () => {
  for (const [name, block, signature] of [
    ['search_operations_directory', searchFunction, 'uuid, text'],
    ['get_internal_client_profile', profileFunction, 'uuid, uuid'],
    ['get_internal_talent_profile', talentProfileFunction, 'uuid, uuid']
  ]) {
    assert.ok(block, `${name} must exist`);
    assert.match(block, /stable[\s\S]*security definer[\s\S]*set search_path = pg_catalog, public, private/i);
    assert.match(
      migration,
      new RegExp(`revoke all on function public\\.${name}\\(${signature.replace(' ', '\\s*')}\\)\\s+from public, anon, authenticated`, 'i')
    );
    assert.match(
      migration,
      new RegExp(`grant execute on function public\\.${name}\\(${signature.replace(' ', '\\s*')}\\)\\s+to service_role`, 'i')
    );
    assert.doesNotMatch(
      migration,
      new RegExp(`grant execute on function public\\.${name}[\\s\\S]{0,100}to (?:anon|authenticated)`, 'i')
    );
  }
});

test('search validates active first-sign-in-complete internal roles and keeps portal roles out', () => {
  assert.match(searchFunction, /access\.id = p_actor_user_id/i);
  assert.match(searchFunction, /access\.organization_id is not null/i);
  assert.match(searchFunction, /access\.active = true/i);
  assert.match(searchFunction, /access\.must_change_password = false/i);
  for (const role of ['admin', 'sales_management', 'sales', 'talent_management', 'billing']) {
    assert.match(searchFunction, new RegExp(`'${role}'::public\\.platform_role`, 'i'));
  }
  for (const role of ['client_admin', 'client_reviewer', 'client_billing', 'virtual_assistant']) {
    assert.doesNotMatch(searchFunction, new RegExp(`'${role}'::public\\.platform_role`, 'i'));
  }
  assert.match(searchFunction, /errcode = '42501'/i);
});

test('search scopes both entity types and contact matches to the verified organization and active records', () => {
  assert.match(searchFunction, /from public\.clients as client[\s\S]*client\.organization_id = v_organization_id[\s\S]*client\.archived_at is null/i);
  assert.match(searchFunction, /join public\.client_contacts as contact on contact\.client_id = client\.id[\s\S]*contact\.active = true/i);
  assert.match(searchFunction, /from public\.applicants as applicant[\s\S]*applicant\.organization_id = v_organization_id[\s\S]*applicant\.archived_at is null/i);
  assert.match(searchFunction, /if v_actor_role in \([\s\S]*'admin'[\s\S]*'talent_management'[\s\S]*'sales_management'[\s\S]*'sales'[\s\S]*\) then[\s\S]*from public\.applicants/i);
  assert.doesNotMatch(searchFunction, /select\s+(?:client|applicant|contact)\.\*/i);
});

test('internal Client profile returns only the active primary contact', () => {
  assert.match(migration, /where active_contact\.client_id = v_client\.id[\s\S]*active_contact\.active = true[\s\S]*lower\(active_contact\.contact_role\) = 'primary'[\s\S]*limit 1/i);
  assert.doesNotMatch(migration, /limit 100/i);
});

test('search normalizes strict query bounds and escapes wildcard query syntax', () => {
  assert.match(searchFunction, /char_length\(v_query\) < 2 or char_length\(v_query\) > 100/i);
  assert.match(searchFunction, /p_query ~ '\[\[:cntrl:\]\]'/i);
  assert.match(searchFunction, /replace\(replace\(replace\(v_query,[\s\S]*'%'[\s\S]*'_'/i);
  assert.match(searchFunction, /escape '\\'/i);
  assert.match(searchFunction, /v_allow_contains := char_length\(v_query\) >= 3/i);
});

test('search caps and deduplicates each group while returning only the safe projection', () => {
  assert.match(searchFunction, /select distinct on \(client_id\)/i);
  assert.equal((searchFunction.match(/limit 5/gi) || []).length, 2);
  for (const key of ['entityType', 'recordId', 'primaryLabel', 'secondaryLabel', 'statusLabel', 'matchedOn']) {
    assert.match(searchFunction, new RegExp(`'${key}'`, 'i'));
  }
  for (const forbiddenKey of [
    'organizationId', 'authUserId', 'birthDate', 'genderIdentity', 'pronouns',
    'statusReason', 'ownerId', 'documentId', 'storagePath'
  ]) {
    assert.doesNotMatch(searchFunction, new RegExp(`'${forbiddenKey}'`, 'i'));
  }
});

test('033 provides indexes for every first-release searchable identifier', () => {
  assert.match(migration, /create extension if not exists pg_trgm/i);
  for (const index of [
    'clients_active_company_name_trgm_idx',
    'client_contacts_active_full_name_trgm_idx',
    'client_contacts_active_email_trgm_idx',
    'client_contacts_active_phone_digits_trgm_idx',
    'applicants_active_full_name_trgm_idx',
    'applicants_active_preferred_name_trgm_idx',
    'applicants_active_email_trgm_idx',
    'applicants_active_phone_digits_trgm_idx'
  ]) {
    assert.match(migration, new RegExp(`create index if not exists ${index}`, 'i'));
  }
  assert.match(migration, /clients[\s\S]*where archived_at is null/i);
  assert.match(migration, /client_contacts[\s\S]*where active = true/i);
  assert.match(migration, /applicants[\s\S]*where archived_at is null/i);
});

test('internal Client profiles are role, organization, archive, and contact scoped', () => {
  assert.match(profileFunction, /access\.id = p_actor_user_id/i);
  assert.match(profileFunction, /access\.active = true[\s\S]*access\.must_change_password = false/i);
  for (const role of ['admin', 'sales_management', 'sales', 'talent_management', 'billing']) {
    assert.match(profileFunction, new RegExp(`'${role}'::public\\.platform_role`, 'i'));
  }
  assert.match(profileFunction, /client\.id = p_client_id[\s\S]*client\.organization_id = v_organization_id[\s\S]*client\.archived_at is null/i);
  assert.match(profileFunction, /active_contact\.client_id = v_client\.id[\s\S]*active_contact\.active = true/i);
  assert.match(profileFunction, /lower\(active_contact\.contact_role\) = 'primary'[\s\S]*limit 1/i);
  assert.doesNotMatch(profileFunction, /sales_owner_id|organizationId|organization_id',|archivedAt|audit/i);
});

test('internal Talent profiles are role, organization, and archive scoped while Billing and portals fail closed', () => {
  assert.match(talentProfileFunction, /access\.id = p_actor_user_id/i);
  assert.match(talentProfileFunction, /access\.organization_id is not null/i);
  assert.match(talentProfileFunction, /access\.active = true[\s\S]*access\.must_change_password = false/i);
  for (const role of ['admin', 'talent_management', 'sales_management', 'sales']) {
    assert.match(talentProfileFunction, new RegExp(`'${role}'::public\\.platform_role`, 'i'));
  }
  for (const role of ['billing', 'client_admin', 'client_reviewer', 'client_billing', 'virtual_assistant']) {
    assert.doesNotMatch(talentProfileFunction, new RegExp(`'${role}'::public\\.platform_role`, 'i'));
  }
  assert.match(talentProfileFunction, /applicant\.id = p_applicant_id[\s\S]*applicant\.organization_id = v_organization_id[\s\S]*applicant\.archived_at is null/i);
  assert.doesNotMatch(talentProfileFunction, /select\s+applicant\.\*/i);
});

test('internal Talent profiles return only the approved applicant-shaped read projection', () => {
  const approvedKeys = [
    'id', 'full_name', 'preferred_name', 'country', 'timezone', 'status', 'work_status',
    'availability_note', 'application_received_at', 'expected_hourly_rate_text',
    'verified_skills', 'self_reported_experience_areas', 'self_reported_skills',
    'other_experience_specialty', 'relevant_experience_years',
    'relevant_experience_summary', 'education_training_summary', 'english_test_result',
    'personality_profile_score', 'computer_specs', 'internet_speed'
  ];
  for (const key of approvedKeys) {
    assert.match(
      talentProfileFunction,
      new RegExp(`'${key}'\\s*,\\s*(?:coalesce\\()?v_applicant\\.${key}`, 'i')
    );
  }
  for (const forbiddenKey of [
    'email', 'phone', 'birth_date', 'gender_identity', 'pronouns', 'location',
    'address_line_1', 'address_line_2', 'greatest_dream', 'talent_review_owner_id',
    'sales_owner_id', 'talent_support_owner_id', 'auth_user_id', 'resume_url',
    'loom_video_url', 'document_id', 'storage_path', 'legacy_application_data'
  ]) {
    assert.doesNotMatch(talentProfileFunction, new RegExp(`'${forbiddenKey}'\\s*,`, 'i'));
  }
});
