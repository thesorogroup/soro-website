const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.SUPABASE_URL = 'https://tracker-tests.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
const service = require('../netlify/functions/sales-lifecycle-tracker.js');
const actor = '11111111-1111-4111-8111-111111111111';
const request = '22222222-2222-4222-8222-222222222222';
const client = '33333333-3333-4333-8333-333333333333';
const now = '2026-09-07T12:00:00.000Z';
function row(changes = {}) {
  return {
    clientId: client, clientName: 'Example Client', requestId: request, roleTitle: 'Medical VA',
    ownerId: actor, ownerName: 'Sales Owner', ownerActive: true, status: 'open', seatCount: 1,
    candidateCount: 0, draftCandidateCount: 0, sentCandidateCount: 0, selectedCandidateCount: 0,
    interviewRequestedCount: 0, interviewCount: 0, completedInterviewCount: 0, interviewFollowUpCount: 0,
    outcomeDueCount: 0, calendarIssueCount: 0, calendarPendingCount: 0, preparedHandoffCount: 0,
    placementCount: 0, activePlacementCount: 0, onboardingCount: 0,
    activeContactCount: 1, portalContactCount: 1, portalDecisionContactCount: 1, portalIssueCount: 0,
    targetStartDate: '2026-09-14', isTargetStartPast: false, nextInterviewAt: null, lastActivityAt: now, ...changes
  };
}
function payload(record = row(), viewerRole = 'sales') {
  return { generatedAt: now, viewerRole, rows: [record] };
}

test('tracker derives active and onboarding from live placement counts, never filled status alone', () => {
  assert.equal(service.publicPayload(payload(row({ status: 'filled' }))).rows[0].stage, 'placement');
  assert.equal(service.publicPayload(payload(row({ status: 'filled', placementCount: 1, onboardingCount: 1 }))).rows[0].stage, 'onboarding');
  assert.equal(service.publicPayload(payload(row({ status: 'filled', placementCount: 1, activePlacementCount: 1 }))).rows[0].stage, 'active');
  const partial = service.publicPayload(payload(row({ status: 'partially_filled', seatCount: 3, placementCount: 1, activePlacementCount: 1 }))).rows[0];
  assert.equal(partial.stage, 'matching');
  assert.equal(partial.nextAction, 'find_candidates');
});

test('partial requests surface remaining interviews and handoffs while onboarding grows independently', () => {
  const record = row({ status: 'partially_filled', seatCount: 3, placementCount: 1, onboardingCount: 1, candidateCount: 1, sentCandidateCount: 1, interviewCount: 1 });
  assert.equal(service.publicPayload(payload(record)).rows[0].stage, 'interviewing');
  assert.equal(service.publicPayload(payload({ ...record, interviewCount: 0, sentCandidateCount: 0, selectedCandidateCount: 1 })).rows[0].nextAction, 'prepare_handoff');
  assert.equal(service.publicPayload(payload({ ...record, interviewCount: 0, sentCandidateCount: 0, selectedCandidateCount: 1, preparedHandoffCount: 1 })).rows[0].responsibleRole, 'talent_management');
});

test('attention uses explicit evidence; no arbitrary inactivity deadline', () => {
  const oldActivity = row({ lastActivityAt: '2020-01-01T00:00:00Z', targetStartDate: null });
  assert.equal(service.publicPayload(payload(oldActivity)).rows[0].attentionCode, null);
  assert.equal(service.publicPayload(payload(row({ targetStartDate: '2026-09-06', isTargetStartPast: true }))).rows[0].attentionCode, 'start_date_passed');
  assert.equal(service.publicPayload(payload(row({ targetStartDate: '2026-09-07' }))).rows[0].attentionCode, null);
  const due = service.publicPayload(payload(row({ candidateCount: 1, interviewCount: 1, outcomeDueCount: 1 }))).rows[0];
  assert.equal(due.attentionCode, 'interview_outcome_due');
  assert.equal(due.nextAction, 'manage_interviews');
});

test('Central evening keeps a same-day target current even after UTC midnight', () => {
  const snapshot = { ...payload(row({ targetStartDate: '2026-09-07', isTargetStartPast: false })), generatedAt: '2026-09-08T01:00:00.000Z' };
  const current = service.publicPayload(snapshot).rows[0];
  assert.equal(current.attentionCode, null);
  assert.equal(current.isTargetStartPast, undefined);
  assert.equal(service.publicPayload({ ...snapshot, rows: [row({ targetStartDate: '2026-09-07', isTargetStartPast: true })] }).rows[0].attentionCode, 'start_date_passed');
});

test('finished interviews advance to selection while current follow-up and no-show rounds stay actionable', () => {
  const completed = row({ status: 'interviewing', candidateCount: 1, sentCandidateCount: 1, completedInterviewCount: 1 });
  const decision = service.publicPayload(payload(completed)).rows[0];
  assert.equal(decision.stage, 'selection');
  assert.equal(decision.nextAction, 'review_selection');
  assert.equal(decision.responsibleRole, 'client');
  const followUp = service.publicPayload(payload({ ...completed, interviewFollowUpCount: 1 })).rows[0];
  assert.equal(followUp.stage, 'interviewing');
  assert.equal(followUp.nextAction, 'manage_interviews');
  assert.equal(followUp.responsibleRole, 'sales');
});

test('calendar, owner, contact, and portal attention point to actionable existing screens', () => {
  for (const [changes, code, action] of [
    [{ ownerId: null, ownerName: null, ownerActive: false }, 'owner_missing', 'client_setup'],
    [{ activeContactCount: 0, portalContactCount: 0, portalDecisionContactCount: 0 }, 'contact_missing', 'client_setup'],
    [{ candidateCount: 1, interviewCount: 1, calendarIssueCount: 1 }, 'calendar_sync_failed', 'manage_interviews'],
    [{ status: 'client_review', portalContactCount: 0, portalDecisionContactCount: 0 }, 'portal_access_needed', 'client_setup'],
    [{ status: 'client_review', portalContactCount: 0, portalDecisionContactCount: 0, portalIssueCount: 1 }, 'portal_delivery_failed', 'client_setup']
  ]) {
    const result = service.publicPayload(payload(row(changes))).rows[0];
    assert.equal(result.attentionCode, code);
    assert.equal(result.nextAction, action);
    assert.equal(result.responsibleRole, 'sales');
  }
});

test('review access does not imply final-decision access, and cancelled calendar work remains actionable', () => {
  const reviewerOnly = service.publicPayload(payload(row({ status: 'selection_pending', portalDecisionContactCount: 0 }))).rows[0];
  assert.equal(reviewerOnly.attentionCode, 'portal_access_needed');
  assert.equal(reviewerOnly.nextAction, 'client_setup');
  const failedCancel = service.publicPayload(payload(row({ status: 'selection_pending', candidateCount: 1, calendarIssueCount: 1, interviewCount: 0 }))).rows[0];
  assert.equal(failedCancel.attentionCode, 'calendar_sync_failed');
  assert.equal(failedCancel.nextAction, 'manage_interviews');
  const pendingCancel = service.publicPayload(payload(row({ status: 'selection_pending', candidateCount: 1, calendarPendingCount: 1 }))).rows[0];
  assert.equal(pendingCancel.nextAction, 'manage_interviews');
  assert.equal(pendingCancel.attentionCode, null);
});

test('held, cancelled, and active rows do not invent blockers from historical data', () => {
  for (const changes of [{ status: 'on_hold' }, { status: 'cancelled' }, { placementCount: 1, activePlacementCount: 1 }]) {
    assert.equal(service.publicPayload(payload(row({ ...changes, ownerId: null, ownerName: null, ownerActive: false, targetStartDate: '2020-01-01' }))).rows[0].attentionCode, null);
  }
});

test('public contract strips private and raw aggregate fields', () => {
  const value = service.publicPayload(payload(row({ privateNotes: 'secret', talentRate: 30, organizationId: 'hidden' })));
  assert.equal(value.rows[0].privateNotes, undefined);
  assert.equal(value.rows[0].talentRate, undefined);
  assert.equal(value.rows[0].organizationId, undefined);
  assert.equal(value.rows[0].portalContactCount, undefined);
  assert.equal(value.rows[0].ownerActive, undefined);
  assert.equal(value.rows[0].candidateCount, 0);
});

test('invalid roles, duplicate requests, malformed dates, and impossible counts fail closed', () => {
  for (const role of ['talent_management', 'client_admin', 'virtual_assistant']) assert.throws(() => service.publicPayload(payload(row(), role)));
  assert.throws(() => service.publicPayload({ ...payload(), rows: [row(), row()] }));
  for (const changes of [
    { targetStartDate: '2026-02-30' }, { seatCount: 0 }, { interviewCount: -1 },
    { candidateCount: '3' }, { activePlacementCount: 1 }, { outcomeDueCount: 1 },
    { sentCandidateCount: 1 }, { portalContactCount: 2 }, { status: 'unknown' }
  ]) assert.throws(() => service.publicPayload(payload(row(changes))));
  assert.throws(() => service.publicPayload({ ...payload(), rows: Array(service.MAX_ROWS + 1).fill(row()) }));
});

test('GET authenticates once and makes one actor-scoped aggregate RPC for any row count', async t => {
  const calls = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(calls.length === 1 ? { id: actor } : payload()), { status: 200 });
  });
  const result = await service.handler({ httpMethod: 'GET', headers: { authorization: 'Bearer user-token' } });
  assert.equal(result.statusCode, 200);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /auth\/v1\/user$/);
  assert.match(calls[1].url, /rpc\/get_sales_lifecycle_tracker$/);
  assert.deepEqual(JSON.parse(calls[1].options.body), { p_actor_user_id: actor });
  assert.equal(result.headers['Cache-Control'], 'no-store');
});

test('service rejects caller supplied scope and all writes without backend access', async t => {
  let calls = 0;
  t.mock.method(global, 'fetch', async () => { calls++; throw new Error('must not fetch'); });
  for (const extra of [{ queryStringParameters: { role: 'admin' } }, { multiValueQueryStringParameters: { clientId: [client] } }, { rawQueryString: 'organizationId=x' }, { body: '{}' }]) {
    assert.equal((await service.handler({ httpMethod: 'GET', headers: { authorization: 'Bearer token' }, ...extra })).statusCode, 400);
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal((await service.handler({ httpMethod: method })).statusCode, 405);
  assert.equal((await service.handler({ httpMethod: 'GET' })).statusCode, 401);
  assert.equal(calls, 0);
});

test('forbidden database actors receive no rows or database details', async t => {
  let count = 0;
  t.mock.method(global, 'fetch', async () => ++count === 1
    ? new Response(JSON.stringify({ id: actor }), { status: 200 })
    : new Response(JSON.stringify({ code: '42501', message: 'private database details' }), { status: 403 }));
  const result = await service.handler({ httpMethod: 'GET', headers: { authorization: 'Bearer token' } });
  assert.equal(result.statusCode, 403);
  assert.doesNotMatch(result.body, /private database details|rows/);
});

test('migration remains service-only, read-only, organization and owner scoped with batched aggregates', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20260907_040_sales_lifecycle_tracker.sql'), 'utf8');
  assert.match(sql, /private\.client_pipeline_actor\(p_actor_user_id\)/);
  assert.match(sql, /v_actor\.role not in\s*\([\s\S]*?'admin'[\s\S]*?'sales_management'[\s\S]*?'sales'/);
  assert.match(sql, /request\.organization_id = v_actor\.organization_id/);
  assert.match(sql, /v_actor\.role <> 'sales'::public\.platform_role or client\.sales_owner_id = v_actor\.user_id/);
  assert.match(sql, /client\.archived_at is null/);
  assert.match(sql, /revoke all on function public\.get_sales_lifecycle_tracker\(uuid\) from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.get_sales_lifecycle_tracker\(uuid\) to service_role/);
  assert.doesNotMatch(sql, /\b(insert into|update public\.|delete from)\b/i);
  assert.match(sql, /interview\.ends_at < statement_timestamp\(\)/);
  assert.match(sql, /placement\.end_date is null and placement\.status = 'active'/);
  assert.match(sql, /item\.removed_at is null and item\.workflow_state in \('active', 'selected'\)/);
  assert.match(sql, /group by interview\.hiring_request_id/);
  assert.match(sql, /select distinct on \(interview\.shortlist_item_id\)/);
  assert.match(sql, /interview\.round_number desc/);
  assert.match(sql, /last_interview\.id is null or last_interview\.status = 'cancelled'/);
  assert.match(sql, /scope\.start_date < timezone\('America\/Chicago', statement_timestamp\(\)\)::date/);
  assert.match(sql, /membership\.active and access\.active and not access\.must_change_password/);
  assert.match(sql, /access\.role in \('client_admin'::public\.platform_role, 'client_reviewer'::public\.platform_role\)/);
  assert.match(sql, /owner\.role = 'sales'::public\.platform_role/);
  assert.match(sql, /interview\.status = 'cancelled' and interview\.calendar_sync_action = 'cancel'/);
  assert.doesNotMatch(sql, /'privateNotes'|'email'|'clientRate'|'talentRate'|'joinUrl'/);
});
