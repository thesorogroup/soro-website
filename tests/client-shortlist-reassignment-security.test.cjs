const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const MIGRATION = path.join(
  __dirname,
  '..',
  'supabase',
  'migrations',
  '20260901_035_client_shortlists.sql'
);

function migrationSql() {
  return fs.readFileSync(MIGRATION, 'utf8');
}

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing SQL marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `Missing SQL marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

function lastBetween(source, start, end) {
  const startIndex = source.lastIndexOf(start);
  assert.notEqual(startIndex, -1, `Missing SQL marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `Missing SQL marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test('Sales reads and controls follow current Client and active Talent ownership', () => {
  const sql = migrationSql();
  const workspace = between(
    sql,
    'create or replace function private.client_shortlist_workspace_json',
    'create or replace function public.get_client_shortlist_workspace'
  );
  const scope = between(workspace, 'shortlist_scope as (', 'shortlist_rows as (');
  const rows = between(workspace, 'shortlist_rows as (', 'notification_rows as (');

  assert.match(scope, /client\.sales_owner_id\s*=\s*p_actor_user_id/i);
  assert.match(scope, /owned_item\.removed_at\s+is\s+null/i);
  assert.match(scope, /owned_applicant\.sales_owner_id\s+is\s+distinct\s+from\s+p_actor_user_id/i);

  assert.match(rows, /'canSend'[\s\S]*shortlist\.client_sales_owner_id\s*=\s*shortlist\.sales_owner_id/i);
  assert.match(rows, /send_owner\.active\s*=\s*true/i);
  assert.match(rows, /client_portal_memberships\s+as\s+send_membership/i);
  assert.match(rows, /send_recipient\.role\s+in\s*\([\s\S]*'client_admin'[\s\S]*'client_reviewer'/i);
  assert.match(rows, /send_contact\.active\s*=\s*true/i);
  assert.match(rows, /send_membership\.active\s*=\s*true/i);
  assert.match(rows, /blocked_applicant\.sales_owner_id\s+is\s+distinct\s+from\s+shortlist\.client_sales_owner_id/i);
  assert.match(rows, /'canRemove'[\s\S]*p_viewer_role\s+in\s*\([\s\S]*'admin'[\s\S]*'sales_management'/i);
  assert.match(rows, /p_viewer_role\s*=\s*'sales'[\s\S]*shortlist\.client_sales_owner_id\s*=\s*p_actor_user_id[\s\S]*shortlist\.sales_owner_id\s*=\s*p_actor_user_id[\s\S]*applicant\.sales_owner_id\s*=\s*p_actor_user_id/i);
});

test('request Add is hidden for a non-empty stale draft but empty drafts remain recoverable', () => {
  const sql = migrationSql();
  const workspace = between(
    sql,
    'create or replace function private.client_shortlist_workspace_json',
    'create or replace function public.get_client_shortlist_workspace'
  );
  const requests = between(workspace, 'request_rows as (', 'candidate_scope as (');

  assert.match(requests, /'canAddCandidate'[\s\S]*not\s+exists\s*\([\s\S]*client_shortlists\s+as\s+stale_draft/i);
  assert.match(requests, /active_draft_item\.removed_at\s+is\s+null/i);
  assert.match(requests, /stale_draft\.sales_owner_id\s+is\s+distinct\s+from\s+request\.client_sales_owner_id/i);
  assert.match(requests, /stale_applicant\.sales_owner_id\s+is\s+distinct\s+from\s+request\.client_sales_owner_id/i);
  assert.match(requests, /stale_applicant\.status\s*<>\s*'shortlisted'/i);
});

test('an empty stale draft is atomically rebased and owner changes are audited', () => {
  const sql = migrationSql();
  const rpc = between(
    sql,
    'create or replace function public.change_client_shortlist',
    'revoke all on function public.change_client_shortlist'
  );
  const add = lastBetween(rpc, "if v_action = 'add_candidate' then", "elsif v_action = 'remove_candidate' then");

  assert.match(add, /select\s+count\(\*\)::integer\s+into\s+v_item_count[\s\S]*item\.removed_at\s+is\s+null/i);
  assert.match(add, /v_shortlist\.sales_owner_id\s+is\s+distinct\s+from\s+v_pipeline_owner_id[\s\S]*if\s+v_item_count\s*>\s*0\s+then[\s\S]*clear the stale draft/i);
  assert.match(add, /set\s+sales_owner_id\s*=\s*v_pipeline_owner_id[\s\S]*returning\s+\*\s+into\s+v_shortlist/i);
  assert.match(add, /existing_applicant\.sales_owner_id\s+is\s+distinct\s+from\s+v_pipeline_owner_id/i);
  assert.match(add, /'client_shortlist_owner_rebased'/i);
  assert.match(add, /jsonb_build_object\('salesOwnerId',\s*v_previous_owner_id\)[\s\S]*jsonb_build_object\('salesOwnerId',\s*v_shortlist\.sales_owner_id\)/i);
});

test('oversight can clear stale draft items without overwriting a changed Talent stage', () => {
  const sql = migrationSql();
  const rpc = between(
    sql,
    'create or replace function public.change_client_shortlist',
    'revoke all on function public.change_client_shortlist'
  );
  const remove = lastBetween(rpc, "elsif v_action = 'remove_candidate' then", "elsif v_action = 'send_shortlist' then");

  assert.match(remove, /v_actor\.role\s+not\s+in\s*\([\s\S]*'admin'[\s\S]*'sales_management'[\s\S]*'sales'/i);
  assert.match(remove, /if\s+v_actor\.role\s*=\s*'sales'[\s\S]*v_applicant\.sales_owner_id\s+is\s+distinct\s+from\s+v_actor\.user_id/i);
  assert.match(remove, /stale_remove_item\.removed_at\s+is\s+null/i);
  assert.match(remove, /stale_remove_applicant\.sales_owner_id\s+is\s+distinct\s+from\s+v_actor\.user_id/i);
  assert.match(remove, /v_next_status\s*:=\s*v_applicant\.status/i);
  assert.match(remove, /if\s+v_applicant\.archived_at\s+is\s+null[\s\S]*v_applicant\.status\s*=\s*'shortlisted'[\s\S]*set\s+status\s*=\s*'bench_ready'/i);
  assert.match(remove, /'applicantStatus',\s*v_next_status::text/i);
  assert.doesNotMatch(
    remove,
    /update\s+public\.applicants\s+set\s+status\s*=\s*'bench_ready'[^;]+where\s+id\s*=\s*v_applicant\.id\s*;/i,
    'Stage restoration must remain inside the guarded update and return the actual result.'
  );
});

test('add, remove, and respond share the request lock before a consistent row-lock sequence', () => {
  const sql = migrationSql();
  const rpc = between(
    sql,
    'create or replace function public.change_client_shortlist',
    'revoke all on function public.change_client_shortlist'
  );
  const add = lastBetween(rpc, "if v_action = 'add_candidate' then", "elsif v_action = 'remove_candidate' then");
  const remove = lastBetween(rpc, "elsif v_action = 'remove_candidate' then", "elsif v_action = 'send_shortlist' then");
  const send = lastBetween(rpc, "elsif v_action = 'send_shortlist' then", "  else\n    if v_actor.role not in (");
  const respondStart = rpc.lastIndexOf("  else\n    if v_actor.role not in (");
  const respondEnd = rpc.indexOf('\n  end if;\n\n  insert into public.client_shortlist_operations', respondStart);
  assert.notEqual(respondStart, -1, 'Missing respond mutation branch.');
  assert.notEqual(respondEnd, -1, 'Missing respond mutation branch terminator.');
  const respond = rpc.slice(respondStart, respondEnd);

  const addOrder = [
    add.indexOf("'client-shortlist-request:'"),
    add.indexOf('for update of hiring, client'),
    add.indexOf('select shortlist.* into v_shortlist'),
    add.indexOf('select applicant.* into v_applicant'),
    add.indexOf('select item.* into v_item')
  ];
  const removeOrder = [
    remove.indexOf("'client-shortlist-request:'"),
    remove.indexOf('for update of hiring, client'),
    remove.indexOf('select shortlist.* into v_shortlist'),
    remove.indexOf('select applicant.* into v_applicant'),
    remove.indexOf('select item.* into v_item')
  ];
  const respondOrder = [
    respond.indexOf("'client-shortlist-request:'"),
    respond.indexOf('for update of hiring, client'),
    respond.indexOf('select shortlist.* into v_shortlist'),
    respond.indexOf('select applicant.* into v_applicant'),
    respond.indexOf('select item.* into v_item')
  ];

  assert.equal(addOrder.every(index => index >= 0), true, 'Add must include every common lock stage.');
  assert.equal(removeOrder.every(index => index >= 0), true, 'Remove must include every common lock stage.');
  assert.equal(respondOrder.every(index => index >= 0), true, 'Respond must include every common lock stage.');
  assert.deepEqual([...addOrder].sort((a, b) => a - b), addOrder);
  assert.deepEqual([...removeOrder].sort((a, b) => a - b), removeOrder);
  assert.deepEqual([...respondOrder].sort((a, b) => a - b), respondOrder);
  assert.doesNotMatch(
    remove.slice(0, removeOrder[0]),
    /for\s+(?:no\s+key\s+)?update/i,
    'Remove may resolve immutable IDs before the advisory lock but must not take a row lock.'
  );
  assert.doesNotMatch(
    respond.slice(0, respondOrder[0]),
    /for\s+(?:no\s+key\s+)?update/i,
    'Respond may resolve immutable IDs before the advisory lock but must not take a row lock.'
  );
  assert.match(remove, /item\.shortlist_id\s*=\s*v_shortlist\.id/i);
  assert.match(remove, /item\.applicant_id\s*=\s*v_applicant\.id/i);
  assert.match(respond, /item\.shortlist_id\s*=\s*v_shortlist\.id/i);
  assert.match(respond, /item\.applicant_id\s*=\s*v_applicant\.id/i);
  assert.match(send, /'client-shortlist-request:'\s*\|\|\s*v_shortlist\.hiring_request_id::text/i);
  assert.match(respond, /'client-shortlist-request:'\s*\|\|\s*v_lock_hiring_request_id::text/i);
});
