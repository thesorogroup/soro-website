const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const shortlistMigration = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '20260901_035_client_shortlists.sql'),
  'utf8'
);
const lifecycleMigration = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '20260901_037_client_interviews_placements_onboarding.sql'),
  'utf8'
);
const shortlistBackend = fs.readFileSync(
  path.join(root, 'netlify', 'functions', 'client-shortlists.js'),
  'utf8'
);
const shortlistUi = fs.readFileSync(
  path.join(root, 'operations', 'client-shortlist-workflow.js'),
  'utf8'
);
const placementBackend = fs.readFileSync(
  path.join(root, 'netlify', 'functions', 'client-placement-workflow.js'),
  'utf8'
);

test('shortlist review cannot create an unattributed final pass', () => {
  assert.match(shortlistMigration, /v_response not in \('request_interview', 'interested', 'not_a_fit'\)/i);
  assert.match(lifecycleMigration, /if new\.client_response = 'not_a_fit'[\s\S]*A final pass must be recorded by a Client Administrator/i);
  assert.match(lifecycleMigration, /decider\.role = 'client_admin'::public\.platform_role/i);
  assert.match(lifecycleMigration, /Client final decisions are append-only/i);
  assert.match(shortlistBackend, /const RESPONSES = new Set\(\['request_interview', 'interested'\]\)/i);
  assert.match(shortlistUi, /const RESPONSE_VALUES = new Set\(\['request_interview', 'interested'\]\)/i);
  assert.doesNotMatch(shortlistUi, />Not a fit<\/button>/i);
});

test('seat edits cannot undercut or reopen committed Client selections', () => {
  assert.match(lifecycleMigration, /guard_hiring_request_workflow_dependencies/i);
  assert.match(lifecycleMigration, /new\.number_of_virtual_assistants < v_committed_seats/i);
  assert.match(lifecycleMigration, /decision\.decision = 'selected'/i);
  assert.match(lifecycleMigration, /placement\.status in \('placement_confirmed', 'onboarding', 'active'\)/i);
  assert.match(lifecycleMigration, /Seat count is locked after Client review begins/i);
  assert.match(lifecycleMigration, /shortlist\.status = 'sent'/i);
});

test('request and Client terminal changes fail closed with active dependencies', () => {
  assert.match(lifecycleMigration, /new\.status in \('on_hold', 'cancelled'\)/i);
  assert.match(lifecycleMigration, /Resolve active candidates, interviews, selections, and placements/i);
  assert.match(lifecycleMigration, /new\.lifecycle_stage in \('paused', 'lost', 'archived'\)/i);
  assert.match(lifecycleMigration, /new\.archived_at is distinct from old\.archived_at and new\.archived_at is not null/i);
  assert.match(lifecycleMigration, /Resolve every open request and placement/i);
  assert.match(lifecycleMigration, /before update of number_of_virtual_assistants, status on public\.hiring_requests/i);
  assert.match(lifecycleMigration, /before update of sales_owner_id, lifecycle_stage, archived_at on public\.clients/i);
});

test('Sales owner transfer is blocked while candidate or placement state is attached', () => {
  assert.match(lifecycleMigration, /new\.sales_owner_id is distinct from old\.sales_owner_id[\s\S]*?v_has_dependent_workflow/i);
  assert.match(lifecycleMigration, /Client ownership cannot change while a shortlist, interview, selection, handoff, or placement is active/i);
  assert.match(lifecycleMigration, /item\.workflow_state in \('active', 'selected', 'placed'\)/i);
  assert.match(lifecycleMigration, /handoff\.status in \('prepared', 'confirmed'\)/i);
});

test('a scheduled or not-yet-reconciled cancelled interview blocks every final decision', () => {
  const finalDecision = /elsif v_action = 'final_decision' then([\s\S]*?)elsif v_action = 'prepare_handoff' then/i.exec(lifecycleMigration)?.[1] || '';
  assert.match(finalDecision, /interview\.status = 'scheduled'/i);
  assert.match(finalDecision, /interview\.status = 'cancelled'[\s\S]*?calendar_sync_action = 'cancel'[\s\S]*?calendar_sync_status in \('pending', 'sync_failed', 'connection_required'\)/i);
  assert.match(finalDecision, /finish cancelling its calendar event before recording a final decision/i);
});

test('Graph create retries preserve the original transaction id after an ambiguous response', () => {
  const retryBranch = /else\s+if v_payload <> '\{\}'::jsonb([\s\S]*?)v_calendar_action := v_interview\.calendar_sync_action;/i.exec(lifecycleMigration)?.[1] || '';
  assert.match(retryBranch, /when calendar_sync_action = 'create' then coalesce\(calendar_transaction_id, p_request_id\)/i);
  assert.doesNotMatch(retryBranch, /when calendar_sync_action = 'create' then p_request_id/i);
  assert.match(placementBackend, /event\.transactionId = command\.transactionId/i);
  assert.match(lifecycleMigration, /'transactionId', coalesce\(interview\.calendar_transaction_id, p_request_id\)/i);
});

test('an unreconciled initial calendar create must be retried before reschedule or cancellation', () => {
  const interviewMutation = /elsif v_action in \(\s*'reschedule_interview', 'cancel_interview',[\s\S]*?elsif v_action = 'final_decision' then/i.exec(lifecycleMigration)?.[0] || '';
  assert.match(interviewMutation, /v_action in \('reschedule_interview', 'cancel_interview'\)[\s\S]*?microsoft_event_id is null[\s\S]*?calendar_sync_action = 'create'[\s\S]*?calendar_sync_status in \('pending', 'sync_failed', 'connection_required'\)/i);
  assert.match(interviewMutation, /Retry the original calendar creation before rescheduling or cancelling this interview/i);

  const retryBranch = /else\s+if v_payload <> '\{\}'::jsonb([\s\S]*?)v_calendar_action := v_interview\.calendar_sync_action;/i.exec(lifecycleMigration)?.[1] || '';
  assert.match(retryBranch, /calendar_sync_status in \('connection_required', 'sync_failed'\)[\s\S]*?calendar_sync_status = 'pending'[\s\S]*?microsoft_event_id is null[\s\S]*?calendar_sync_action = 'create'/i);
  assert.match(lifecycleMigration, /'needsCreateRetry', case[\s\S]*?microsoft_event_id is null[\s\S]*?calendar_sync_action = 'create'[\s\S]*?calendar_sync_status in \('pending', 'sync_failed', 'connection_required'\)/i);
});

test('interview invitations select only active authorized Client portal members', () => {
  const contactSelection = /select contact\.\* into v_contact([\s\S]*?)limit 1;/i.exec(lifecycleMigration)?.[1] || '';
  assert.match(contactSelection, /join public\.client_portal_memberships as membership/i);
  assert.match(contactSelection, /join public\.platform_users as client_access/i);
  assert.doesNotMatch(contactSelection, /left join public\.(?:client_portal_memberships|platform_users)/i);
  assert.match(contactSelection, /membership\.active = true/i);
  assert.match(contactSelection, /client_access\.role in \('client_admin'::public\.platform_role, 'client_reviewer'::public\.platform_role\)/i);
  assert.match(contactSelection, /contact\.portal_access_status = 'active'/i);
  assert.match(contactSelection, /nullif\(btrim\(contact\.portal_login_email\), ''\) is not null/i);
  assert.match(lifecycleMigration, /v_contact_email := nullif\(btrim\(v_contact\.portal_login_email\), ''\)/i);
  assert.doesNotMatch(lifecycleMigration, /v_contact_email\s*:=\s*coalesce\([^;]*v_contact\.email/i);
  assert.match(lifecycleMigration, /active Client Administrator or Reviewer portal account before scheduling/i);
});

test('placement activation requires a compatible Client lifecycle stage', () => {
  assert.match(lifecycleMigration, /v_client\.lifecycle_stage not in \('qualified', 'matching', 'active'\)/i);
  assert.match(lifecycleMigration, /Return the Client to an active matching stage before activating this placement/i);
});

test('passed and safely released Talent are soft-retired for a later shortlist without erasing decision history', () => {
  assert.match(shortlistMigration, /where item\.applicant_id = v_applicant\.id[\s\S]*?item\.removed_at is null[\s\S]*?already in an active Client shortlist/i);
  assert.match(shortlistMigration, /client_shortlist_items_response_metadata_check check/i);
  assert.match(lifecycleMigration, /client_shortlist_items_removed_response_check check \([\s\S]*?workflow_state in \('passed', 'released'\)/i);
  assert.match(lifecycleMigration, /set workflow_state = 'passed',[\s\S]*?removed_by_user_id = coalesce\(item\.removed_by_user_id,[\s\S]*?decision\.decided_by_user_id[\s\S]*?removed_at = coalesce\(item\.removed_at, item\.responded_at, item\.updated_at, pg_catalog\.clock_timestamp\(\)\)[\s\S]*?where item\.client_response = 'not_a_fit'/i);

  const finalDecision = /elsif v_action = 'final_decision' then([\s\S]*?)elsif v_action = 'prepare_handoff' then/i.exec(lifecycleMigration)?.[1] || '';
  assert.match(finalDecision, /set workflow_state = case when v_decision_value = 'selected' then 'selected' else 'passed' end,[\s\S]*?removed_by_user_id = case when v_decision_value = 'passed' then v_actor\.user_id end,[\s\S]*?removed_at = case when v_decision_value = 'passed' then pg_catalog\.clock_timestamp\(\) end/i);
  assert.match(finalDecision, /if v_decision_value = 'passed' then[\s\S]*?set status = 'bench_ready'::public\.applicant_status/i);
  assert.doesNotMatch(finalDecision, /set\s+client_response\s*=/i);

  const confirmation = /elsif v_action = 'confirm_placement' then([\s\S]*?)elsif v_action = 'update_onboarding' then/i.exec(lifecycleMigration)?.[1] || '';
  assert.match(confirmation, /set workflow_state = 'released',[\s\S]*?removed_by_user_id = v_actor\.user_id,[\s\S]*?removed_at = pg_catalog\.clock_timestamp\(\)[\s\S]*?set status = 'bench_ready'::public\.applicant_status/i);
  assert.doesNotMatch(confirmation, /set\s+client_response\s*=/i);
  const placementWorkspace = /create or replace function private\.client_placement_workspace_json\([\s\S]*?create or replace function private\.client_interview_calendar_command_json/i.exec(lifecycleMigration)?.[0] || '';
  assert.match(placementWorkspace, /item\.removed_at is null\s+or item\.workflow_state in \('passed', 'released'\)/i);
  assert.match(placementWorkspace, /from public\.client_candidate_decisions as decision[\s\S]*?decision\.shortlist_item_id = item\.id/i);
});

test('a partially filled multi-seat request stays open for later shortlist and interview rounds', () => {
  const openStatus = /create or replace function private\.is_open_hiring_request_status\(p_status text\)([\s\S]*?)revoke all on function private\.is_open_hiring_request_status/i.exec(lifecycleMigration)?.[1] || '';
  assert.match(openStatus, /'client_review', 'partially_filled'/i);

  const scheduleInterview = /if v_action = 'schedule_interview' then([\s\S]*?)elsif v_action in \(/i.exec(lifecycleMigration)?.[1] || '';
  assert.match(scheduleInterview, /v_request\.status not in \('client_review', 'interviewing', 'partially_filled'\)/i);
  assert.match(scheduleInterview, /item\.workflow_state = 'active'/i);
  assert.match(scheduleInterview, /item\.client_response = 'request_interview'/i);
  assert.match(scheduleInterview, /if v_request\.status in \('client_review', 'selection_pending'\) then[\s\S]*?set status = 'interviewing'/i);
  assert.doesNotMatch(scheduleInterview, /if v_request\.status in \([^)]*'partially_filled'[^)]*\) then[\s\S]*?set status = 'interviewing'/i);
});

test('one seat can finish onboarding while a later seat is in selection or handoff', () => {
  const onboarding = /elsif v_action = 'update_onboarding' then([\s\S]*?)\n  else\n    if v_actor\.role not in/i.exec(lifecycleMigration)?.[1] || '';
  assert.doesNotMatch(onboarding, /v_request\.status not in/i);
  assert.match(onboarding, /placement\.hiring_request_id = v_request\.id/i);
  assert.match(onboarding, /placement\.client_id = v_client\.id/i);
  assert.match(onboarding, /placement\.status = 'onboarding'/i);

  const activation = /\n  else\n    if v_actor\.role not in \('admin'::public\.platform_role, 'talent_management'::public\.platform_role\) then([\s\S]*?)\n  end if;\n\n  insert into public\.client_placement_operations/i.exec(lifecycleMigration)?.[1] || '';
  assert.doesNotMatch(activation, /v_request\.status not in/i);
  assert.match(activation, /placement\.hiring_request_id = v_request\.id/i);
  assert.match(activation, /placement\.client_id = v_client\.id/i);
  assert.match(activation, /placement\.status = 'onboarding'/i);
  assert.match(activation, /Complete every required onboarding item before activation/i);
});
