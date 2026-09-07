const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '20260901_037_client_interviews_placements_onboarding.sql'),
  'utf8'
);
const backend = fs.readFileSync(
  path.join(root, 'netlify', 'functions', 'client-placement-workflow.js'),
  'utf8'
);

test('new placement workflow tables are service-only behind RLS', () => {
  for (const table of [
    'client_candidate_interviews', 'client_candidate_decisions',
    'client_placement_handoffs', 'placement_onboarding_items',
    'client_placement_operations'
  ]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
    assert.match(migration, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`, 'i'));
  }
  assert.doesNotMatch(migration, /grant\s+(?:select|insert|update|delete|all)[^;]*\bto\s+authenticated\b/i);
  assert.match(migration, /grant execute on function public\.change_client_placement_workflow[\s\S]*?to service_role/i);
});

test('actor scope is derived and Client Reviewer cannot make a final decision', () => {
  assert.match(migration, /private\.client_placement_actor\(p_actor_user_id uuid\)/i);
  assert.match(migration, /membership\.user_id = v_access\.id[\s\S]*?membership\.active = true/i);
  assert.match(migration, /if v_actor\.role <> 'client_admin'::public\.platform_role then[\s\S]*?Only a Client Administrator/i);
  assert.match(migration, /v_actor\.role = 'sales'::public\.platform_role and v_client\.sales_owner_id is distinct from v_actor\.user_id/i);
  assert.match(migration, /client_reviewer'::public\.platform_role/);
});

test('decisions are attributable and append-only while handoff confirmation is role separated', () => {
  assert.match(migration, /decided_by_user_id uuid not null/i);
  assert.match(migration, /client_candidate_decisions_append_only[\s\S]*?before update or delete/i);
  assert.match(migration, /Client final decisions are append-only/i);
  assert.match(migration, /prepare_handoff[\s\S]*?sales_management[\s\S]*?sales/i);
  assert.match(migration, /confirm_placement[\s\S]*?Only Admin or Talent Management may confirm a placement/i);
  assert.match(migration, /selected_decision\.decision = 'selected'[\s\S]*?>= v_request\.number_of_virtual_assistants/i);
});

test('confirmation reuses shortlist lock order, derives ids from handoff, enforces seats, and fails closed on one current placement', () => {
  assert.match(migration, /client-shortlist-request:' \|\| p_hiring_request_id::text/i);
  assert.match(migration, /client-shortlist-applicant:' \|\| v_handoff\.applicant_id::text/i);
  assert.match(migration, /join public\.client_candidate_decisions as decision[\s\S]*?decision\.decision = 'selected'/i);
  assert.match(migration, /v_current_count > 0[\s\S]*?already has a current placement/i);
  assert.match(migration, /v_filled >= v_request\.number_of_virtual_assistants[\s\S]*?approved seat/i);
  assert.match(migration, /Complete or cancel every remaining Client interview before filling the final seat/i);
  assert.match(migration, /insert into public\.placements \([\s\S]*?organization_id, client_id, applicant_id, hiring_request_id/i);
  assert.match(migration, /workflow_state = 'released'[\s\S]*?status = 'bench_ready'/i);
});

test('sent shortlist automatically advances the canonical request pipeline before interview actions', () => {
  assert.match(migration, /advance_request_when_shortlist_sent/i);
  assert.match(migration, /new\.status = 'sent'[\s\S]*?set status = 'client_review'/i);
  assert.match(migration, /status in \('open', 'sourcing', 'shortlisting'\)/i);
  assert.match(migration, /if v_request\.status in \('client_review', 'selection_pending'\)[\s\S]*?set status = 'interviewing'/i);
  assert.match(migration, /set status = 'selection_pending'[\s\S]*?status in \('client_review', 'interviewing', 'partially_filled'\)/i);
  assert.match(migration, /set status = 'placement_pending'[\s\S]*?status in \('selection_pending', 'partially_filled'\)/i);
  assert.match(migration, /when v_filled >= number_of_virtual_assistants then 'filled'[\s\S]*?else 'partially_filled'/i);
});

test('onboarding activation is blocked until required items are complete and the start date arrives', () => {
  assert.match(migration, /insert into public\.placement_onboarding_items[\s\S]*?talent_start_details[\s\S]*?client_launch_details[\s\S]*?required_documents/i);
  assert.match(migration, /item\.required = true[\s\S]*?item\.status <> 'completed'/i);
  assert.match(migration, /v_placement\.start_date is null or v_placement\.start_date > current_date/i);
  assert.match(migration, /update public\.placements set status = 'active'/i);
});

test('idempotency has independent mutation and calendar phases and durable state precedes Graph', () => {
  assert.match(migration, /phase text not null default 'mutation' check \(phase in \('mutation', 'calendar_sync'\)\)/i);
  assert.match(migration, /primary key \(operation_request_id, phase\)/i);
  assert.match(migration, /client-placement-operation:' \|\| p_request_id::text/i);
  assert.match(migration, /client-placement-calendar:' \|\| p_request_id::text/i);
  assert.match(backend, /const mutation = await callRpc\('change_client_placement_workflow'/);
  assert.match(backend, /const sync = await syncGraphCalendar\(command\)/);
  assert.match(
    backend,
    /const mutation = await callRpc\('change_client_placement_workflow',[\s\S]*?const sync = await syncGraphCalendar\(command\)/,
    'Soro mutation must precede Graph synchronization'
  );
  assert.match(backend, /calendarSyncPending: true/);
});

test('calendar attendees are derived in SQL and Client projection strips private workflow material', () => {
  assert.match(migration, /client_interview_calendar_command_json[\s\S]*?applicant_email_snapshot[\s\S]*?client_contact_email_snapshot[\s\S]*?sales_owner_email_snapshot/i);
  assert.match(backend, /value\.attendees\.length !== 3/i);
  assert.match(backend, /handoffs: internal \? value\.handoffs\.map\(publicHandoff\) : \[\]/i);
  assert.match(backend, /if \(internal\) applicant\.email/i);
  assert.match(backend, /if \(internal\) \{[\s\S]*?result\.outcome[\s\S]*?result\.notes/i);
});
