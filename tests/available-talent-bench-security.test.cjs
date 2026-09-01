const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const migrationPath = 'supabase/migrations/20260901_034_available_talent_bench.sql';

function readMigration() {
  const absolute = path.join(root, migrationPath);
  assert.equal(fs.existsSync(absolute), true, `${migrationPath} must exist.`);
  return fs.readFileSync(absolute, 'utf8');
}

function functionBlock(sql, name, nextName) {
  const start = sql.search(new RegExp(`create or replace function (?:public|private)\\.${name}\\b`, 'i'));
  assert.notEqual(start, -1, `${name} must exist.`);
  const end = nextName
    ? sql.search(new RegExp(`create or replace function (?:public|private)\\.${nextName}\\b`, 'i'))
    : -1;
  return sql.slice(start, end > start ? end : undefined);
}

test('only active Sales, Admin, and Talent Management actors can access the same-organization bench', () => {
  const sql = readMigration();
  const actor = functionBlock(sql, 'available_talent_bench_actor', 'available_talent_bench_json');
  const readRpc = functionBlock(sql, 'get_available_talent_bench', 'change_available_talent_bench');
  const changeRpc = functionBlock(sql, 'change_available_talent_bench');

  assert.match(readRpc, /get_available_talent_bench\s*\(\s*p_actor_user_id\s+uuid\s*\)/i);
  assert.doesNotMatch(readRpc.slice(0, readRpc.indexOf('returns')), /p_(?:organization|role|owner|applicant|limit|stage)/i);
  assert.match(readRpc, /private\.available_talent_bench_actor\s*\(\s*p_actor_user_id\s*\)/i);
  assert.match(readRpc, /p_actor_user_id/i);
  assert.match(actor, /access\.id\s*=\s*p_actor_user_id/i);
  assert.match(actor, /access\.organization_id\s+is\s+not\s+null/i);
  assert.match(actor, /access\.active\s*=\s*true/i);
  assert.match(actor, /access\.must_change_password\s*=\s*false/i);
  for (const role of ['admin', 'talent_management', 'sales']) {
    assert.match(actor, new RegExp(`'${role}'::public\\.platform_role`, 'i'));
  }
  assert.match(actor, /'sales_management'::public\.platform_role/i);
  for (const role of ['billing', 'client_admin', 'client_reviewer', 'client_billing', 'virtual_assistant']) {
    assert.doesNotMatch(actor, new RegExp(`'${role}'::public\\.platform_role`, 'i'));
  }

  assert.match(readRpc, /v_actor\.organization_id/i);
  assert.match(changeRpc, /applicant\.organization_id\s*=\s*v_(?:actor\.)?organization_id|applicant\.organization_id\s*=\s*v_actor\.organization_id/i);
  assert.doesNotMatch(changeRpc.slice(0, changeRpc.indexOf('returns')), /p_(?:organization|actor_role|viewer_role)/i);
});

test('the available queue contains only unarchived pre-placement stages and capacity counts the same active claim stages', () => {
  const sql = readMigration();
  const readRpc = functionBlock(sql, 'available_talent_bench_json', 'get_available_talent_bench');

  assert.match(readRpc, /applicant\.archived_at\s+is\s+null/i);
  for (const stage of ['bench_ready', 'shortlisted', 'client_review', 'interviewing']) {
    assert.match(readRpc, new RegExp(`'${stage}'(?:::\\w+(?:\\.\\w+)?)?`, 'i'));
  }
  for (const releaseStage of ['placement_confirmed', 'onboarding', 'active', 'not_selected', 'withdrawn', 'inactive']) {
    const countBlock = readRpc.match(/count\s*\(\s*\*\s*\)[\s\S]{0,1800}(?:capacity|claimed)/i)?.[0] || '';
    assert.doesNotMatch(countBlock, new RegExp(`'${releaseStage}'`, 'i'), `${releaseStage} must not consume Sales capacity`);
  }
  assert.match(readRpc, /applicant\.sales_owner_id\s+is\s+not\s+null/i);
});

test('caseload capacity defaults to 40, can be configured, and never trusts a Sales-supplied limit', () => {
  const sql = readMigration();
  const readRpc = functionBlock(sql, 'available_talent_bench_json', 'get_available_talent_bench');
  const changeRpc = functionBlock(sql, 'change_available_talent_bench');

  assert.match(sql, /(?:caseload_limit|capacity)[\s\S]{0,100}(?:default\s+40|coalesce\s*\([^)]*,\s*40\s*\))/i);
  assert.match(readRpc, /(?:caseload_limit|capacity)/i);
  assert.match(changeRpc, /p_caseload_limit\s+integer/i);
  const limitAction = changeRpc.slice(changeRpc.indexOf("v_action = 'set_limit'"));
  assert.match(limitAction, /v_actor\.role\s*(?:<>|!=)\s*'admin'::public\.platform_role|v_actor\.role\s*=\s*'admin'::public\.platform_role/i);
  assert.match(limitAction, /p_caseload_limit\s*(?:between\s+1\s+and\s+\d+|<\s*1)[\s\S]{0,80}p_caseload_limit\s*>\s*\d+/i);

  const claimAction = changeRpc.slice(changeRpc.indexOf("v_action = 'claim'"), changeRpc.indexOf("v_action = 'assign'"));
  assert.doesNotMatch(claimAction, /p_caseload_limit/i, 'Sales claiming must use stored capacity, not a client-supplied limit.');
});

test('management capacity is the team sum while Sales receives only their own configured/default limit', () => {
  const sql = readMigration();
  const queueJson = functionBlock(sql, 'available_talent_bench_json', 'get_available_talent_bench');
  assert.match(queueJson, /team_capacity\s+as\s*\([\s\S]*sum\s*\(\s*sales\.capacity\s*\)/i);
  assert.match(queueJson, /'capacity'\s*,\s*case[\s\S]*p_viewer_role\s*=\s*'sales'::public\.platform_role[\s\S]*then\s+actor_limit\.capacity[\s\S]*else\s+team_capacity\.capacity/i);
  assert.match(queueJson, /'claimed'\s*,\s*case[\s\S]*p_viewer_role\s*=\s*'sales'::public\.platform_role[\s\S]*actor_claimed[\s\S]*else[\s\S]*team_claimed/i);
});

test('claiming is serialized and first-writer-wins instead of silently stealing ownership', () => {
  const sql = readMigration();
  const changeRpc = functionBlock(sql, 'change_available_talent_bench');
  const claimAction = changeRpc.slice(changeRpc.indexOf("v_action = 'claim'"), changeRpc.indexOf("v_action = 'assign'"));

  assert.match(changeRpc, /pg_advisory_xact_lock|for\s+update/i);
  assert.match(changeRpc, /v_before\.updated_at\s+is\s+distinct\s+from\s+p_expected_updated_at|updated_at\s*(?:<>|!=)\s*p_expected_updated_at/i);
  assert.match(claimAction, /sales_owner_id\s+is\s+not\s+null/i);
  assert.match(claimAction, /already (?:been )?claimed|claim conflict|another Sales Associate/i);
  assert.match(changeRpc, /v_claimed[\s\S]{0,400}v_limit/i);
  assert.match(changeRpc, /update\s+public\.applicants[\s\S]*sales_owner_id/i);
  assert.doesNotMatch(claimAction, /delete\s+from\s+public\.applicants/i);
});

test('Sales can claim for self and release only their own claim while management can override assignment', () => {
  const sql = readMigration();
  const changeRpc = functionBlock(sql, 'change_available_talent_bench');
  const claimAction = changeRpc.slice(changeRpc.indexOf("v_action = 'claim'"), changeRpc.indexOf("v_action = 'assign'"));
  const assignAction = changeRpc.slice(changeRpc.indexOf("v_action = 'assign'"), changeRpc.indexOf("v_action = 'reassign'"));
  const reassignAction = changeRpc.slice(changeRpc.indexOf("v_action = 'reassign'"), changeRpc.indexOf("v_action = 'release'"));
  const releaseStart = changeRpc.indexOf("v_action = 'release'");
  const releaseEnd = changeRpc.indexOf('if v_target_owner_id is not null', releaseStart);
  const releaseAction = changeRpc.slice(releaseStart, releaseEnd > releaseStart ? releaseEnd : undefined);

  assert.match(claimAction, /v_actor\.role\s*(?:<>|!=)\s*'sales'::public\.platform_role|v_actor\.role\s+not\s+in\s*\([\s\S]*'sales'::public\.platform_role/i);
  assert.doesNotMatch(claimAction, /'sales_management'::public\.platform_role/i);
  assert.match(claimAction, /v_target_owner_id\s*:=\s*v_actor\.(?:id|user_id)/i);
  assert.doesNotMatch(claimAction, /p_target_sales_owner_id/i);

  for (const managementAction of [assignAction, reassignAction]) {
    assert.match(managementAction, /'admin'::public\.platform_role/i);
    assert.match(managementAction, /'talent_management'::public\.platform_role/i);
    assert.match(managementAction, /p_target_sales_owner_id/i);
  }
  assert.match(changeRpc, /access\.id\s*=\s*v_target_owner_id[\s\S]*access\.organization_id\s*=\s*v_actor\.organization_id[\s\S]*access\.active\s*=\s*true[\s\S]*access\.role\s*=\s*'sales'::public\.platform_role/i);

  assert.match(releaseAction, /'admin'::public\.platform_role/i);
  assert.match(releaseAction, /'talent_management'::public\.platform_role/i);
  assert.match(releaseAction, /v_actor\.role\s*=\s*'sales'::public\.platform_role/i);
  assert.match(releaseAction, /v_before\.sales_owner_id\s*(?:<>|!=)\s*v_actor\.(?:id|user_id)/i);
  assert.match(releaseAction, /v_actor\.role\s*=\s*'sales'::public\.platform_role[\s\S]*v_before\.status\s*<>\s*'bench_ready'::public\.applicant_status[\s\S]*only Admin or Talent Management/i);
  assert.match(releaseAction, /v_target_owner_id\s*:=\s*null/i);
});

test('request ids and stale timestamps make claim actions idempotent and concurrency-safe', () => {
  const sql = readMigration();
  const changeRpc = functionBlock(sql, 'change_available_talent_bench');

  assert.match(sql, /operation_request_id\s+uuid\s+primary key|primary key\s*\(\s*operation_request_id\s*\)/i);
  assert.match(sql, /request_fingerprint\s+text\s+not null/i);
  assert.match(changeRpc, /where\s+(?:operation\.)?operation_request_id\s*=\s*p_request_id/i);
  assert.match(changeRpc, /request id has already been used/i);
  assert.match(changeRpc, /digest\s*\([\s\S]*v_action[\s\S]*p_applicant_id::text[\s\S]*p_expected_updated_at::text/i);
  assert.match(changeRpc, /v_before\.updated_at\s+is\s+distinct\s+from\s+p_expected_updated_at/i);
});

test('every claim, assignment, reassignment, release, and configuration change is audited', () => {
  const sql = readMigration();
  const changeRpc = functionBlock(sql, 'change_available_talent_bench');

  assert.match(changeRpc, /insert\s+into\s+public\.audit_events/i);
  assert.match(changeRpc, /'available_talent_bench'/i);
  for (const action of ['claim', 'assign', 'reassign', 'release']) {
    assert.match(changeRpc, new RegExp(`'${action}'`, 'i'));
  }
  assert.match(changeRpc, /old_sales_owner_id|previous_sales_owner_id|before_owner|v_before\.sales_owner_id/i);
  assert.match(changeRpc, /new_sales_owner_id|sales_owner_id|after_owner/i);
  assert.match(changeRpc, /set_limit[\s\S]*audit_events|audit_events[\s\S]*set_limit/i);
});

test('bench operation/configuration tables and RPCs remain service-only', () => {
  const sql = readMigration();

  assert.match(sql, /alter table public\.[a-z0-9_]*(?:available_talent|bench)[a-z0-9_]* enable row level security/i);
  assert.match(sql, /revoke all on table public\.[a-z0-9_]*(?:available_talent|bench)[a-z0-9_]* from public, anon, authenticated/i);
  assert.match(sql, /grant (?:select, insert|select, insert, update|all) on table public\.[a-z0-9_]*(?:available_talent|bench)[a-z0-9_]* to service_role/i);
  assert.match(sql, /revoke all on function public\.get_available_talent_bench\(uuid\)\s+from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.get_available_talent_bench\(uuid\)\s+to service_role/i);
  assert.match(sql, /revoke all on function public\.change_available_talent_bench\(\s*uuid, uuid, uuid, timestamptz, text, uuid, integer\s*\)\s+from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.change_available_talent_bench\(\s*uuid, uuid, uuid, timestamptz, text, uuid, integer\s*\)\s+to service_role/i);
});

test('the database payload is a deliberate operational allowlist and excludes private profile fields', () => {
  const sql = readMigration();
  const readRpc = functionBlock(sql, 'available_talent_bench_json', 'get_available_talent_bench');
  const itemStart = readRpc.indexOf("'applicantId'");
  const itemEnd = readRpc.indexOf("'allowedActions'", itemStart);
  assert.notEqual(itemStart, -1, 'The response must build an explicit Talent item.');
  assert.notEqual(itemEnd, -1, 'The response item must include server-derived actions.');
  const itemJson = readRpc.slice(itemStart, itemEnd + 600);

  for (const safeKey of [
    'applicantId', 'fullName', 'preferredName', 'stage', 'vaTypes', 'verifiedSkills',
    'availability', 'rateMin', 'rateMax', 'rateLabel', 'yearsExperience', 'owner',
    'updatedAt', 'allowedActions'
  ]) {
    assert.match(itemJson, new RegExp(`'${safeKey}'`, 'i'));
  }
  for (const privateField of [
    'email', 'phone', 'address', 'birth_date', 'gender_identity', 'pronouns',
    'greatest_dream', 'resume_url', 'auth_user_id', 'talent_review_owner_id',
    'talent_support_owner_id', 'legacy_application_data', 'storage_path'
  ]) {
    assert.doesNotMatch(itemJson, new RegExp(`['\"]?${privateField}['\"]?`, 'i'));
  }
});
