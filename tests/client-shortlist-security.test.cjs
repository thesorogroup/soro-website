const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const migrationPath = 'supabase/migrations/20260901_035_client_shortlists.sql';

function readMigration() {
  const absolute = path.join(root, migrationPath);
  assert.equal(fs.existsSync(absolute), true, `${migrationPath} must exist.`);
  return fs.readFileSync(absolute, 'utf8');
}

function functionBlock(sql, name, nextName) {
  const start = sql.search(new RegExp(`create or replace function (?:public|private)\\.${name}\\b`, 'i'));
  assert.notEqual(start, -1, `${name} must exist.`);
  const remainder = sql.slice(start + 1);
  const next = nextName
    ? remainder.search(new RegExp(`create or replace function (?:public|private)\\.${nextName}\\b`, 'i'))
    : -1;
  return sql.slice(start, next >= 0 ? start + 1 + next : undefined);
}

function mutationActionBlock(sql, action, nextAction) {
  const start = sql.lastIndexOf(`${action === 'add_candidate' ? 'if' : 'elsif'} v_action = '${action}' then`);
  assert.notEqual(start, -1, `${action} mutation branch must exist.`);
  const end = nextAction
    ? sql.indexOf(`elsif v_action = '${nextAction}' then`, start)
    : -1;
  return sql.slice(start, end > start ? end : undefined);
}

test('public RPCs derive organization, role, and Client scope from the signed-in actor', () => {
  const sql = readMigration();
  const actor = functionBlock(sql, 'client_shortlist_actor', 'client_shortlist_workspace_json');
  const readRpc = functionBlock(sql, 'get_client_shortlist_workspace', 'change_client_shortlist');
  const changeRpc = functionBlock(sql, 'change_client_shortlist');

  assert.match(readRpc, /get_client_shortlist_workspace\s*\(\s*p_actor_user_id\s+uuid\s*\)/i);
  assert.doesNotMatch(readRpc.slice(0, readRpc.indexOf('returns')), /p_(?:organization|role|client|contact|sales_owner)/i);
  assert.match(readRpc, /private\.client_shortlist_actor\s*\(\s*p_actor_user_id\s*\)/i);
  assert.match(changeRpc, /private\.client_shortlist_actor\s*\(\s*p_actor_user_id\s*\)/i);

  assert.match(actor, /access\.id\s*=\s*p_actor_user_id/i);
  assert.match(actor, /access\.organization_id\s+is\s+not\s+null/i);
  assert.match(actor, /access\.active\s*=\s*true/i);
  assert.match(actor, /access\.must_change_password\s*=\s*false/i);
  for (const role of ['admin', 'sales_management', 'sales', 'client_admin', 'client_reviewer']) {
    assert.match(actor, new RegExp(`'${role}'::public\\.platform_role`, 'i'));
  }
  for (const forbiddenRole of ['talent_management', 'billing', 'client_billing', 'virtual_assistant']) {
    assert.doesNotMatch(actor, new RegExp(`'${forbiddenRole}'::public\\.platform_role`, 'i'));
  }
});

test('Client candidate access is derived from one active same-organization membership', () => {
  const sql = readMigration();
  const actor = functionBlock(sql, 'client_shortlist_actor', 'client_shortlist_workspace_json');
  const changeRpc = functionBlock(sql, 'change_client_shortlist');

  assert.match(actor, /public\.client_portal_memberships/i);
  assert.match(actor, /membership\.user_id\s*=\s*(?:access|v_access)\.id|membership\.user_id\s*=\s*p_actor_user_id/i);
  assert.match(actor, /membership\.organization_id\s*=\s*(?:access|v_access)\.organization_id/i);
  assert.match(actor, /membership\.active\s*=\s*true/i);
  assert.match(actor, /public\.clients/i);
  assert.match(actor, /client\.organization_id\s*=\s*membership\.organization_id/i);
  assert.match(actor, /client\.archived_at\s+is\s+null/i);
  assert.match(actor, /public\.client_contacts/i);
  assert.match(actor, /contact\.id\s*=\s*membership\.client_contact_id/i);
  assert.match(actor, /contact\.client_id\s*=\s*membership\.client_id/i);
  assert.match(actor, /contact\.active\s*=\s*true/i);

  const responseBranch = changeRpc.slice(changeRpc.indexOf("v_action = 'respond_candidate'"));
  assert.match(responseBranch, /v_actor\.role[\s\S]*'client_admin'::public\.platform_role/i);
  assert.match(responseBranch, /v_actor\.role[\s\S]*'client_reviewer'::public\.platform_role/i);
  assert.match(responseBranch, /v_actor\.client_id|actor_client_id/i);
  assert.doesNotMatch(responseBranch, /'client_billing'::public\.platform_role/i);
});

test('ordinary Sales must own both the Talent and the Client while oversight stays same-organization', () => {
  const sql = readMigration();
  const changeRpc = functionBlock(sql, 'change_client_shortlist');
  const addBranch = mutationActionBlock(changeRpc, 'add_candidate', 'remove_candidate');

  assert.match(addBranch, /applicant\.organization_id\s*=\s*v_actor\.organization_id/i);
  assert.match(addBranch, /client\.organization_id\s*=\s*v_actor\.organization_id/i);
  assert.match(addBranch, /v_actor\.role\s*=\s*'sales'::public\.platform_role/i);
  assert.match(addBranch, /v_applicant\.sales_owner_id\s+is distinct from\s+v_pipeline_owner_id/i);
  assert.match(addBranch, /v_pipeline_owner_id\s*(?:<>|!=|is distinct from)\s*v_actor\.(?:id|user_id)/i);
  assert.match(addBranch, /v_applicant\.sales_owner_id\s*(?:<>|!=|is distinct from)\s*v_actor\.(?:id|user_id)/i);
  assert.match(addBranch, /'admin'::public\.platform_role/i);
  assert.match(addBranch, /'sales_management'::public\.platform_role/i);

  for (const action of ['remove_candidate', 'send_shortlist']) {
    const branch = mutationActionBlock(
      changeRpc,
      action,
      action === 'remove_candidate' ? 'send_shortlist' : 'respond_candidate'
    );
    assert.match(branch, /organization_id\s*=\s*v_actor\.organization_id/i);
    assert.match(branch, /'sales'::public\.platform_role/i);
  }
});

test('Client reassignment immediately removes former Sales read and draft-removal authority', () => {
  const sql = readMigration();
  const workspace = functionBlock(sql, 'client_shortlist_workspace_json', 'get_client_shortlist_workspace');
  const scopeStart = workspace.indexOf('shortlist_scope as');
  const scopeEnd = workspace.indexOf('shortlist_rows as', scopeStart);
  const shortlistScope = workspace.slice(scopeStart, scopeEnd);
  const changeRpc = functionBlock(sql, 'change_client_shortlist');
  const removeBranch = mutationActionBlock(changeRpc, 'remove_candidate', 'send_shortlist');

  assert.notEqual(scopeStart, -1, 'Shortlist workspace must have an explicit scope CTE.');
  assert.match(shortlistScope, /client\.sales_owner_id\s*=\s*p_actor_user_id/i);
  assert.match(shortlistScope, /client\.archived_at\s+is\s+null/i);
  assert.match(shortlistScope, /private\.is_open_hiring_request_status\s*\(\s*hiring\.status\s*\)/i);
  assert.doesNotMatch(
    shortlistScope,
    /when\s+p_viewer_role\s*=\s*'sales'::public\.platform_role\s+then\s+shortlist\.sales_owner_id\s*=\s*p_actor_user_id/i,
    'Read access must follow the current Client owner, not the historical shortlist owner.'
  );

  assert.match(removeBranch, /public\.hiring_requests\s+as\s+hiring/i);
  assert.match(removeBranch, /public\.clients\s+as\s+client/i);
  assert.match(removeBranch, /v_hiring\.client_archived_at\s+is\s+not\s+null/i);
  assert.match(removeBranch, /v_hiring\.client_sales_owner_id\s+is\s+distinct\s+from\s+v_actor\.user_id/i);
  assert.match(removeBranch, /v_shortlist\.sales_owner_id\s*<>\s*v_actor\.user_id/i);
  assert.match(removeBranch, /private\.is_open_hiring_request_status\s*\(\s*v_hiring\.hiring_status\s*\)/i);
});

test('notification and Client-response scope follows current membership, Client owner, and open request', () => {
  const sql = readMigration();
  const workspace = functionBlock(sql, 'client_shortlist_workspace_json', 'get_client_shortlist_workspace');
  const notificationStart = workspace.indexOf('notification_rows as');
  const notificationScope = workspace.slice(notificationStart);
  const changeRpc = functionBlock(sql, 'change_client_shortlist');
  const responseBranch = changeRpc.slice(changeRpc.lastIndexOf("else\n    if v_actor.role not in"));

  assert.notEqual(notificationStart, -1, 'Notifications must have an explicit current-scope CTE.');
  assert.match(notificationScope, /join\s+public\.client_shortlists\s+as\s+scoped_shortlist/i);
  assert.match(notificationScope, /join\s+public\.clients\s+as\s+scoped_client/i);
  assert.match(notificationScope, /join\s+public\.hiring_requests\s+as\s+scoped_request/i);
  assert.match(notificationScope, /scoped_client\.sales_owner_id\s*=\s*p_actor_user_id/i);
  assert.match(notificationScope, /scoped_shortlist\.client_id\s*=\s*p_actor_client_id/i);
  assert.match(notificationScope, /private\.is_open_hiring_request_status\s*\(\s*scoped_request\.status\s*\)/i);

  assert.match(responseBranch, /public\.hiring_requests\s+as\s+hiring/i);
  assert.match(responseBranch, /public\.clients\s+as\s+client/i);
  assert.match(responseBranch, /v_hiring\.client_archived_at\s+is\s+not\s+null/i);
  assert.match(responseBranch, /private\.is_open_hiring_request_status\s*\(\s*v_hiring\.hiring_status\s*\)/i);
  assert.match(responseBranch, /access\.id\s*=\s*v_hiring\.client_sales_owner_id/i);
  assert.match(responseBranch, /v_pipeline_owner_id\s*:=\s*v_pipeline_owner\.id/i);
  assert.match(responseBranch, /v_applicant\.sales_owner_id\s*<>\s*v_pipeline_owner_id/i);
  assert.match(responseBranch, /v_pipeline_owner_id[\s\S]{0,180}'client_shortlist_response'/i);
  assert.doesNotMatch(
    responseBranch,
    /v_shortlist\.sales_owner_id[\s\S]{0,180}'client_shortlist_response'/i,
    'Responses must notify the current active Client owner, never the historical shortlist owner.'
  );
});

test('every shortlist is bound to one open hiring request belonging to its same-org Client', () => {
  const sql = readMigration();
  const openStatus = functionBlock(sql, 'is_open_hiring_request_status', 'client_shortlist_actor');
  const changeRpc = functionBlock(sql, 'change_client_shortlist');

  assert.match(sql, /create table if not exists public\.client_shortlists/i);
  assert.match(sql, /hiring_request_id\s+uuid\s+not null/i);
  assert.match(sql, /client_id\s+uuid\s+not null/i);
  assert.match(sql, /organization_id\s+uuid\s+not null/i);
  assert.match(sql, /unique\s*\(\s*hiring_request_id\s*,\s*round_number\s*\)|create unique index[\s\S]*hiring_request_id/i);

  assert.match(openStatus, /lower\s*\(|case|in\s*\(/i);
  for (const terminal of ['closed', 'cancelled', 'canceled', 'filled', 'inactive', 'archived']) {
    assert.doesNotMatch(openStatus, new RegExp(`then\\s+true[\\s\\S]{0,80}'${terminal}'|'${terminal}'[\\s\\S]{0,80}then\\s+true`, 'i'));
  }

  const addBranch = mutationActionBlock(changeRpc, 'add_candidate', 'remove_candidate');
  assert.match(addBranch, /public\.hiring_requests/i);
  assert.match(addBranch, /hiring\.id\s*=\s*p_hiring_request_id|hiring_request\.id\s*=\s*p_hiring_request_id/i);
  assert.match(addBranch, /client\.id\s*=\s*hiring\.client_id|hiring_request\.client_id\s*=\s*client\.id/i);
  assert.match(addBranch, /private\.is_open_hiring_request_status\s*\(/i);
  assert.match(addBranch, /hiring\.client_id|hiring_request\.client_id/i);
});

test('client-facing candidate JSON uses an allowlist and excludes private or internal fields', () => {
  const sql = readMigration();
  const workspace = functionBlock(sql, 'client_shortlist_workspace_json', 'get_client_shortlist_workspace');
  const candidateStart = workspace.search(/'candidate'\s*,\s*jsonb_build_object|'talent'\s*,\s*jsonb_build_object/i);
  assert.notEqual(candidateStart, -1, 'The payload must build an explicit client-safe candidate object.');
  const candidateEnd = workspace.indexOf("'response'", candidateStart);
  assert.notEqual(candidateEnd, -1, 'Candidate profile must end before workflow response metadata.');
  const candidateJson = workspace.slice(candidateStart, candidateEnd);

  for (const safeField of [
    'applicantId', 'displayName', 'country', 'timeZone', 'verifiedSkills',
    'yearsExperience', 'experienceSummary', 'educationAndTraining', 'screening',
    'englishResult', 'personalityResult', 'computerSpecifications', 'internetSpeed'
  ]) {
    assert.match(candidateJson, new RegExp(`'${safeField}'`, 'i'));
  }
  for (const privateField of [
    'email', 'phone', 'address_line_1', 'address_line_2', 'postal_code', 'birth_date',
    'preferred_name', 'gender_identity', 'pronouns', 'greatest_dream',
    'expected_hourly_rate', 'availability_note',
    'sales_owner_id', 'talent_review_owner_id', 'talent_support_owner_id',
    'resume_url', 'loom_video_url', 'storage_path', 'external_url', 'legacy_application_data'
  ]) {
    assert.doesNotMatch(candidateJson, new RegExp(`['\"]?${privateField}['\"]?`, 'i'));
  }
  assert.match(candidateJson, /'personalityResult'[\s\S]{0,100}applicant\.personality_profile_score/i);
});

test('client responses are limited to the three approved values and only after send', () => {
  const sql = readMigration();
  const changeRpc = functionBlock(sql, 'change_client_shortlist');
  const responseBranch = changeRpc.slice(changeRpc.indexOf("v_action = 'respond_candidate'"));

  for (const value of ['request_interview', 'interested', 'not_a_fit']) {
    assert.match(sql, new RegExp(`'${value}'`, 'i'));
    assert.match(responseBranch, new RegExp(`'${value}'`, 'i'));
  }
  for (const unapproved of ['approve', 'reject', 'maybe', 'hire', 'decline']) {
    assert.doesNotMatch(responseBranch, new RegExp(`'${unapproved}'`, 'i'));
  }
  assert.match(responseBranch, /sent_at\s+is\s+not\s+null|status\s*=\s*'sent'|v_shortlist\.status\s*=\s*'client_review'/i);
  assert.match(responseBranch, /client_response\s+is\s+not\s+null|client_response\s+is\s+null/i);
  assert.match(responseBranch, /already (?:been )?(?:recorded|responded)|response conflict|cannot be changed/i);
});

test('unique rows, request fingerprints, and locks make retries and races safe', () => {
  const sql = readMigration();
  const changeRpc = functionBlock(sql, 'change_client_shortlist');

  assert.match(sql, /create table if not exists public\.client_shortlist_operations/i);
  assert.match(sql, /operation_request_id\s+uuid\s+primary key|idempotency_key\s+uuid\s+primary key|primary key\s*\(\s*(?:operation_request_id|idempotency_key)\s*\)/i);
  assert.match(sql, /request_fingerprint\s+text\s+not null/i);
  assert.match(sql, /unique\s*\(\s*shortlist_id\s*,\s*applicant_id\s*\)|create unique index[\s\S]*shortlist_id[\s\S]*applicant_id/i);

  assert.match(changeRpc, /pg_advisory_xact_lock/i);
  assert.match(changeRpc, /p_request_id|p_idempotency_key/i);
  assert.match(changeRpc, /p_expected_updated_at\s+timestamptz/i);
  for (const record of ['applicant', 'shortlist', 'item']) {
    assert.match(changeRpc, new RegExp(`v_${record}\\.updated_at\\s+is\\s+distinct\\s+from\\s+p_expected_updated_at|${record}\\.updated_at\\s+is\\s+distinct\\s+from\\s+p_expected_updated_at`, 'i'));
  }
  assert.match(changeRpc, /request id has already been used|idempotency key has already been used|request fingerprint/i);
  assert.match(changeRpc, /for\s+(?:no key\s+)?update/i);
  assert.match(changeRpc, /on conflict|unique_violation|already (?:on|in) (?:this|the) shortlist/i);
});

test('all mutations create organization-scoped audit events and response notifications', () => {
  const sql = readMigration();
  const changeRpc = functionBlock(sql, 'change_client_shortlist');

  for (const eventName of [
    'client_shortlist_created',
    'client_shortlist_candidate_added',
    'client_shortlist_candidate_removed',
    'client_shortlist_sent',
    'client_shortlist_response_recorded'
  ]) {
    assert.match(changeRpc, new RegExp(`'${eventName}'`, 'i'));
  }
  for (const entityType of ['client_shortlist', 'client_shortlist_item']) {
    assert.match(changeRpc, new RegExp(`'${entityType}'`, 'i'));
  }
  for (const notification of ['client_shortlist_ready', 'client_shortlist_response']) {
    assert.match(changeRpc, new RegExp(`'${notification}'`, 'i'));
  }
  assert.match(changeRpc, /insert\s+into\s+public\.audit_events/i);
  assert.match(changeRpc, /organization_id[\s\S]{0,200}v_actor\.organization_id|v_actor\.organization_id[\s\S]{0,200}organization_id/i);
});

test('shortlist tables and RPCs remain service-role only behind RLS', () => {
  const sql = readMigration();
  for (const table of [
    'client_shortlists', 'client_shortlist_items',
    'client_shortlist_notifications', 'client_shortlist_operations'
  ]) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
    assert.match(sql, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`, 'i'));
    assert.match(sql, new RegExp(`grant [^;]+ on table public\\.${table} to service_role`, 'i'));
  }
  assert.match(sql, /revoke all on function public\.get_client_shortlist_workspace\(uuid\)\s+from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.get_client_shortlist_workspace\(uuid\)\s+to service_role/i);
  assert.match(sql, /revoke all on function public\.change_client_shortlist\(\s*uuid, uuid, text, timestamptz, uuid, uuid, uuid, uuid, text\s*\)\s+from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.change_client_shortlist\(\s*uuid, uuid, text, timestamptz, uuid, uuid, uuid, uuid, text\s*\)\s+to service_role/i);
});
