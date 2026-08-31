const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const migrationPath = 'supabase/migrations/20260830_028_talent_review_queue.sql';
const read = relativePath => {
  const absolute = path.join(root, relativePath);
  assert.equal(fs.existsSync(absolute), true, `${relativePath} must exist.`);
  return fs.readFileSync(absolute, 'utf8');
};

function functionBlock(sql, name, nextName) {
  const start = sql.search(new RegExp(`create or replace function (?:public|private)\\.${name}\\b`, 'i'));
  assert.notEqual(start, -1, `${name} must exist.`);
  const end = nextName
    ? sql.search(new RegExp(`create or replace function (?:public|private)\\.${nextName}\\b`, 'i'))
    : -1;
  return sql.slice(start, end > start ? end : undefined);
}

test('the signed-in actor is the only source of organization and review authority', () => {
  const sql = read(migrationPath);
  const actor = functionBlock(sql, 'talent_review_actor', 'talent_review_checklist_json');
  const readRpc = functionBlock(sql, 'get_talent_review_queue', 'change_talent_review_stage');
  const writeRpc = functionBlock(sql, 'change_talent_review_stage');

  assert.match(actor, /access\.id\s*=\s*p_actor_user_id/i);
  assert.match(actor, /access\.organization_id\s+is\s+not\s+null/i);
  assert.match(actor, /access\.active\s*=\s*true/i);
  assert.match(actor, /access\.must_change_password\s*=\s*false/i);
  assert.match(actor, /'admin'::public\.platform_role/i);
  assert.match(actor, /'talent_management'::public\.platform_role/i);
  for (const forbiddenRole of ['sales', 'sales_management', 'billing', 'client_admin', 'client_reviewer', 'client_billing', 'virtual_assistant']) {
    assert.doesNotMatch(actor, new RegExp(`'${forbiddenRole}'::public\\.platform_role`, 'i'));
  }

  assert.match(readRpc, /get_talent_review_queue\s*\(\s*p_actor_user_id\s+uuid\s*\)/i);
  assert.doesNotMatch(readRpc.slice(0, readRpc.indexOf('returns')), /p_(?:organization|role|applicant|owner|stage)/i);
  assert.match(readRpc, /private\.talent_review_actor\s*\(\s*p_actor_user_id\s*\)/i);
  assert.match(readRpc, /v_actor\.organization_id/i);
  assert.match(writeRpc, /private\.talent_review_actor\s*\(\s*p_actor_user_id\s*\)/i);
  assert.match(writeRpc, /applicant\.organization_id\s*=\s*v_actor\.organization_id/i);
  assert.doesNotMatch(writeRpc.slice(0, writeRpc.indexOf('returns')), /p_(?:organization|viewer_role|role)/i);
});

test('review tables and RPCs are service-only and unavailable to browser roles', () => {
  const sql = read(migrationPath);
  assert.match(sql, /alter table public\.talent_review_operations enable row level security/i);
  assert.match(sql, /revoke all on table public\.talent_review_operations from public, anon, authenticated/i);
  assert.match(sql, /grant select, insert on table public\.talent_review_operations to service_role/i);
  assert.match(sql, /revoke all on function public\.get_talent_review_queue\(uuid\) from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.get_talent_review_queue\(uuid\) to service_role/i);
  assert.match(sql, /revoke all on function public\.change_talent_review_stage\(uuid, uuid, uuid, timestamptz, text, text\)\s*from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.change_talent_review_stage\(uuid, uuid, uuid, timestamptz, text, text\)\s*to service_role/i);
  assert.match(sql, /create or replace function private\.protect_applicant_review_fields\(\)/i);
  assert.match(sql, /if auth\.uid\(\) is not null[\s\S]*new\.status is distinct from old\.status[\s\S]*new\.status_reason is distinct from old\.status_reason[\s\S]*new\.archived_at is distinct from old\.archived_at[\s\S]*new\.talent_review_owner_id is distinct from old\.talent_review_owner_id/i);
  assert.match(sql, /before update of status, status_reason, archived_at, talent_review_owner_id\s*on public\.applicants/i);
  assert.match(sql, /only through the secure review service/i);
});

test('transitions are state-guarded and Bench Ready requires every review source', () => {
  const sql = read(migrationPath);
  const transition = functionBlock(sql, 'change_talent_review_stage');

  assert.match(transition, /v_action\s*=\s*'begin_review'[\s\S]*v_before\.status\s*<>\s*'submitted'/i);
  assert.match(transition, /set status\s*=\s*'in_review'/i);
  assert.match(transition, /v_action\s*=\s*'request_more_info'[\s\S]*set status\s*=\s*'needs_more_info'/i);
  assert.match(transition, /v_action\s*=\s*'mark_bench_ready'[\s\S]*v_before\.status\s*<>\s*'in_review'/i);
  assert.match(transition, /jsonb_array_elements\s*\(\s*v_checklist\s*\)[\s\S]*item->>'state'\s*<>\s*'complete'/i);
  assert.match(transition, /set status\s*=\s*'bench_ready'/i);
  assert.match(transition, /v_action\s*=\s*'decline'[\s\S]*set status\s*=\s*'not_selected'/i);
  assert.match(transition, /v_action\s*=\s*'reopen'[\s\S]*v_before\.status\s*<>\s*'not_selected'/i);
});

test('archive and restore preserve the applicant workflow record', () => {
  const sql = read(migrationPath);
  const queue = functionBlock(sql, 'talent_review_queue_json', 'get_talent_review_queue');
  const transition = functionBlock(sql, 'change_talent_review_stage');
  const archive = transition.slice(transition.indexOf("elsif v_action = 'archive'"), transition.indexOf("elsif v_action = 'restore'"));
  const restore = transition.slice(transition.indexOf("elsif v_action = 'restore'"), transition.indexOf("elsif v_action = 'reopen'"));

  assert.match(archive, /set archived_at\s*=\s*pg_catalog\.clock_timestamp\(\)/i);
  assert.doesNotMatch(archive, /delete\s+from\s+public\.applicants/i);
  assert.doesNotMatch(archive, /set\s+status\s*=/i);
  assert.match(restore, /set archived_at\s*=\s*null/i);
  assert.doesNotMatch(restore, /insert\s+into\s+public\.applicants/i);
  assert.match(queue, /when applicant\.status\s*=\s*'not_selected'::public\.applicant_status then 'declined'/i);
  assert.doesNotMatch(queue, /when applicant\.archived_at\s+is\s+not\s+null then 'archived'/i);
  assert.match(queue, /'archived'\s*,\s*applicant\.archived_at\s+is\s+not\s+null/i);
  assert.match(queue, /count\(\*\)\s+filter\s*\(where archived_at\s+is\s+not\s+null\s+or\s+status\s*=\s*'not_selected'[^)]*\)::integer\s+as\s+closed_count/i);
});

test('request ids are idempotent and stale cards fail optimistic concurrency', () => {
  const sql = read(migrationPath);
  const transition = functionBlock(sql, 'change_talent_review_stage');

  assert.match(sql, /operation_request_id uuid primary key/i);
  assert.match(sql, /request_fingerprint text not null/i);
  assert.match(transition, /digest\s*\([\s\S]*v_action[\s\S]*p_applicant_id::text[\s\S]*p_expected_updated_at::text[\s\S]*coalesce\(v_note, ''\)/i);
  assert.match(transition, /pg_advisory_xact_lock/i);
  assert.match(transition, /where operation_request_id\s*=\s*p_request_id/i);
  assert.match(transition, /request id has already been used for another review action/i);
  assert.match(transition, /return private\.talent_review_queue_json\(v_actor\.organization_id, v_actor\.role\)/i);
  assert.match(transition, /v_before\.updated_at\s+is\s+distinct\s+from\s+p_expected_updated_at/i);
  assert.match(transition, /changed after it was opened/i);
});

test('review audit notes are restricted to Admin and Talent Management', () => {
  const sql = read(migrationPath);
  const audit = sql.slice(sql.indexOf('drop policy if exists "authorized internal users can read audit history"'));

  assert.match(sql, /insert into public\.audit_events[\s\S]*'talent_review_queue'/i);
  assert.match(audit, /entity_type\s+in\s*\([\s\S]*'talent_review_queue'[\s\S]*private\.current_soro_role\(\)\s+in\s*\([\s\S]*'admin'::public\.platform_role[\s\S]*'talent_management'::public\.platform_role/i);
  for (const role of ['sales', 'sales_management', 'billing', 'client_admin', 'client_reviewer', 'client_billing', 'virtual_assistant']) {
    assert.doesNotMatch(audit, new RegExp(`'${role}'::public\\.platform_role`, 'i'));
  }
});

test('resume availability is same-organization metadata and never exposes a document locator', () => {
  const sql = read(migrationPath);
  const queue = functionBlock(sql, 'talent_review_queue_json', 'get_talent_review_queue');
  const sourceStart = queue.indexOf('from public.documents as document');
  const sourceEnd = queue.indexOf(') as resume_source on true', sourceStart);
  const resumeSource = queue.slice(sourceStart, sourceEnd);
  const applicantJsonStart = queue.indexOf("'applicantId', applicant.id");
  const applicantJsonEnd = queue.indexOf("'checklist'", applicantJsonStart);
  const publicResume = queue.slice(applicantJsonStart, applicantJsonEnd);

  assert.match(resumeSource, /document\.organization_id\s*=\s*applicant\.organization_id/i);
  assert.match(resumeSource, /document\.applicant_id\s*=\s*applicant\.id/i);
  assert.match(resumeSource, /document\.document_type\s*=\s*'resume'/i);
  assert.match(resumeSource, /document\.storage_path\s+is\s+not\s+null/i);
  assert.match(resumeSource, /document\.status\s*<>\s*'rejected'/i);
  assert.match(resumeSource, /order by document\.created_at desc, document\.id desc[\s\S]*limit 1/i);

  assert.match(publicResume, /'resume'\s*,\s*jsonb_build_object\s*\(\s*'available'/i);
  assert.match(publicResume, /'Résumé available'/i);
  assert.match(publicResume, /'Résumé not attached'/i);
  assert.doesNotMatch(publicResume, /storage_path|storagePath|signedUrl|documentId|file_name|fileName|resume_url/i);
});

test('manager document and private-storage reads are limited to the actor organization', () => {
  const sql = read(migrationPath);
  const documentPolicyStart = sql.lastIndexOf('create policy "Soro Admin and Talent Management can read documents"');
  const storagePolicyStart = sql.lastIndexOf('create policy "Soro Admin and Talent Management can read private documents"');
  assert.notEqual(documentPolicyStart, -1, '028 must replace the earlier role-only document policy.');
  assert.notEqual(storagePolicyStart, -1, '028 must replace the earlier role-only private storage policy.');
  const documentPolicy = sql.slice(documentPolicyStart, storagePolicyStart);
  const storagePolicy = sql.slice(storagePolicyStart);

  assert.match(documentPolicy, /private\.current_soro_role\(\)\s+in\s*\([\s\S]*'admin'[\s\S]*'talent_management'/i);
  assert.match(documentPolicy, /organization_id\s*=\s*private\.current_soro_organization_id\(\)/i);
  assert.match(storagePolicy, /bucket_id\s*=\s*'soro-private-documents'/i);
  assert.match(storagePolicy, /private\.current_soro_role\(\)\s+in\s*\([\s\S]*'admin'[\s\S]*'talent_management'/i);
  assert.match(storagePolicy, /exists\s*\([\s\S]*from public\.documents[\s\S]*document\.storage_path\s*=\s*storage\.objects\.name/i);
  assert.match(storagePolicy, /document\.organization_id\s*=\s*private\.current_soro_organization_id\(\)/i);
});
