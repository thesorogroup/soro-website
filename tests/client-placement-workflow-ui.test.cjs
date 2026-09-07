const test = require('node:test');
const assert = require('node:assert/strict');

const workflowUi = require('../operations/client-placement-workflow.js');

const REQUEST_ID = '10000000-0000-4000-8000-000000000001';
const OPERATION_ID = '70000000-0000-4000-8000-000000000001';

function response(body, ok = true, status = 200) {
  return { ok, status, async json() { return body; } };
}

function target() {
  return {
    innerHTML: '',
    replaceChildren() { this.innerHTML = ''; },
    querySelectorAll() { return []; },
    querySelector() { return null; }
  };
}

test('endpoint adapter uses the live placement endpoint and exact action allowlists', async () => {
  const calls = [];
  const adapter = workflowUi.createEndpointAdapter({
    getAccessToken: async () => 'session-token',
    createRequestId: () => OPERATION_ID,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return response(workflowUi.defaultSeed('sales'));
    }
  });

  await adapter.loadWorkflow(REQUEST_ID);
  await adapter.mutate('cancel_interview', {
    hiringRequestId: REQUEST_ID,
    expectedUpdatedAt: '2026-09-01T14:40:00.000Z',
    interviewId: '20000000-0000-4000-8000-000000000004',
    note: 'Client asked to reschedule outside the current window.'
  });

  assert.equal(adapter.kind, 'endpoint');
  assert.equal(calls[0].url, `${workflowUi.ENDPOINT}?hiringRequestId=${REQUEST_ID}`);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer session-token');
  assert.equal(calls[1].url, workflowUi.ENDPOINT);
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    action: 'cancel_interview', requestId: OPERATION_ID, hiringRequestId: REQUEST_ID,
    expectedUpdatedAt: '2026-09-01T14:40:00.000Z',
    interviewId: '20000000-0000-4000-8000-000000000004',
    note: 'Client asked to reschedule outside the current window.'
  });
});

test('endpoint retries reuse one request id after an ambiguous placement transport failure', async () => {
  const calls = [];
  let generated = 0;
  let attempts = 0;
  const adapter = workflowUi.createEndpointAdapter({
    getAccessToken: async () => 'session-token',
    createRequestId: () => `70000000-0000-4000-8000-${String(++generated).padStart(12, '0')}`,
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      attempts += 1;
      if (attempts === 1) throw new TypeError('Connection closed after commit.');
      return response(workflowUi.defaultSeed('sales'));
    }
  });
  const values = {
    hiringRequestId: REQUEST_ID,
    expectedUpdatedAt: '2026-09-01T14:40:00.000Z',
    interviewId: '20000000-0000-4000-8000-000000000004',
    note: 'Client asked to reschedule outside the current window.'
  };

  await assert.rejects(adapter.mutate('cancel_interview', values), /Connection closed/);
  await adapter.mutate('cancel_interview', values);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].requestId, calls[1].requestId);
  assert.equal(generated, 1, 'An ambiguous retry must not generate a second idempotency key.');
});

test('endpoint retries preserve the request id when a committed placement response fails verification', async () => {
  const calls = [];
  let generated = 0;
  let attempts = 0;
  const adapter = workflowUi.createEndpointAdapter({
    getAccessToken: async () => 'session-token',
    createRequestId: () => `70000000-0000-4000-8000-${String(++generated).padStart(12, '0')}`,
    fetch: async (url, options) => {
      calls.push(JSON.parse(options.body));
      attempts += 1;
      return response(attempts === 1 ? {} : workflowUi.defaultSeed('sales'));
    }
  });
  const values = {
    hiringRequestId: REQUEST_ID,
    expectedUpdatedAt: '2026-09-01T14:40:00.000Z',
    interviewId: '20000000-0000-4000-8000-000000000004'
  };
  const verify = result => {
    const normalized = workflowUi.normalizeWorkspace(result, 'sales');
    if (!normalized) throw new Error('Unverified committed response.');
    return normalized;
  };

  await assert.rejects(adapter.mutate('retry_calendar_sync', values, verify), /Unverified committed response/);
  const result = await adapter.mutate('retry_calendar_sync', values, verify);

  assert.equal(result.viewerRole, 'sales');
  assert.equal(calls[0].requestId, calls[1].requestId);
  assert.equal(generated, 1, 'A post-commit verification failure must retain its idempotency key.');
});

test('action payload builder rejects incomplete actions and never forwards extra fields', () => {
  const payload = workflowUi.buildActionPayload('retry_calendar_sync', OPERATION_ID, {
    hiringRequestId: REQUEST_ID,
    expectedUpdatedAt: '2026-09-01T14:40:00.000Z',
    interviewId: '20000000-0000-4000-8000-000000000004',
    injected: 'must not be forwarded'
  });
  assert.deepEqual(Object.keys(payload).sort(), ['action', 'expectedUpdatedAt', 'hiringRequestId', 'interviewId', 'requestId'].sort());
  assert.throws(() => workflowUi.buildActionPayload('prepare_handoff', OPERATION_ID, {
    hiringRequestId: REQUEST_ID,
    expectedUpdatedAt: '2026-09-01T14:38:00.000Z',
    decisionId: '40000000-0000-4000-8000-000000000003'
  }), /startDate field is required/);
});

test('client-safe normalization strips email, internal notes, rates, onboarding details, and sync failure states', () => {
  const seed = workflowUi.defaultSeed('client_admin');
  seed.placements = [{
    placementId: '60000000-0000-4000-8000-000000000001', applicantId: seed.candidates[0].applicant.applicantId,
    status: 'onboarding', startDate: '2026-09-15', scheduleSummary: 'Weekdays', updatedAt: '2026-09-01T14:55:00.000Z',
    onboardingItems: [{ onboardingItemId: '60000000-0000-4000-8000-000000000002', itemKey: 'secret', title: 'Internal access', required: true, status: 'pending', updatedAt: '2026-09-01T14:55:00.000Z' }]
  }];
  seed.handoffs[0].privateNote = 'never show this';

  const normalized = workflowUi.normalizeWorkspace(seed, 'admin');
  const markup = workflowUi.workspaceMarkup(normalized);

  assert.equal(normalized.viewerRole, 'client_admin', 'server viewer role must override a more privileged caller hint');
  assert.equal(normalized.candidates[0].applicant.email, undefined);
  assert.equal(normalized.candidates[0].interviews[0].notes, undefined);
  assert.equal(normalized.candidates[0].interviews[0].calendar.status, 'pending');
  assert.deepEqual(normalized.handoffs, []);
  assert.deepEqual(normalized.placements[0].onboardingItems, []);
  assert.doesNotMatch(markup, /avery@example\.test|Internal preparation note|\$18\.00|sync_failed|Retry calendar sync|Client rate|Talent rate/i);
  assert.match(markup, /Client-safe review/);
  assert.match(markup, /Select candidate/);
  assert.match(markup, /Calendar invitation pending/);
});

test('Client Reviewer receives the same safe candidate view without final-decision controls', () => {
  const normalized = workflowUi.normalizeWorkspace(workflowUi.defaultSeed('client_reviewer'), 'client_reviewer');
  const markup = workflowUi.workspaceMarkup(normalized);
  assert.match(markup, /Review-only access/);
  assert.doesNotMatch(markup, /data-cpw-decision=/);
  assert.doesNotMatch(markup, /Prepare handoff|Confirm placement|Internal note|@example\.test/);
});

test('Sales workspace offers only calendar retry while the original event create is unreconciled', () => {
  const seed = workflowUi.defaultSeed('sales');
  seed.handoffs = [];
  const normalized = workflowUi.normalizeWorkspace(seed, 'sales');
  const markup = workflowUi.workspaceMarkup(normalized);
  assert.match(markup, /avery@example\.test/);
  assert.match(markup, /Internal preparation note/);
  assert.equal(normalized.candidates[0].interviews[0].calendar.needsCreateRetry, true);
  assert.match(markup, /Retry calendar sync/);
  assert.doesNotMatch(markup, /data-cpw-open="reschedule"|data-cpw-open="cancel"|Record outcome/);
  assert.match(markup, /Prepare handoff/);
  assert.doesNotMatch(markup, /Confirm placement/);
});

test('Sales workspace restores interview lifecycle controls after the original calendar create reconciles', () => {
  const seed = workflowUi.defaultSeed('sales');
  seed.handoffs = [];
  seed.candidates[0].interviews[0].calendar = {
    status: 'synced',
    joinUrl: 'https://teams.microsoft.com/l/meetup-join/reconciled',
    needsCreateRetry: false
  };
  const normalized = workflowUi.normalizeWorkspace(seed, 'sales');
  const markup = workflowUi.workspaceMarkup(normalized);
  assert.equal(normalized.candidates[0].interviews[0].calendar.needsCreateRetry, false);
  assert.match(markup, /data-cpw-open="reschedule"/);
  assert.match(markup, /data-cpw-open="cancel"/);
  assert.match(markup, /Record outcome/);
  assert.doesNotMatch(markup, /Retry calendar sync/);
  assert.match(markup, /Prepare handoff/);
  assert.doesNotMatch(markup, /Confirm placement/);
});

test('Admin and Talent Management views expose confirmation and onboarding, not Sales interview controls for Talent Management', async () => {
  const adminAdapter = workflowUi.createApprovalAdapter(workflowUi.defaultSeed('admin'));
  let state = await adminAdapter.mutate('confirm_placement', {
    hiringRequestId: REQUEST_ID,
    expectedUpdatedAt: '2026-09-01T14:45:00.000Z',
    handoffId: '50000000-0000-4000-8000-000000000001'
  });
  state.placements[0].startDate = new Date().toISOString().slice(0, 10);
  let adminWorkspace = workflowUi.normalizeWorkspace(state, 'founder');
  let adminMarkup = workflowUi.workspaceMarkup(adminWorkspace);
  assert.equal(adminWorkspace.viewerRole, 'founder');
  assert.match(adminMarkup, /Onboarding & activation/);
  assert.match(adminMarkup, /data-cpw-onboarding=/);
  assert.match(adminMarkup, /Activate placement/);

  const talentSeed = workflowUi.defaultSeed('talent_management');
  const talentWorkspace = workflowUi.normalizeWorkspace(talentSeed, 'talent_management');
  const talentMarkup = workflowUi.workspaceMarkup(talentWorkspace);
  assert.match(talentMarkup, /Confirm placement/);
  assert.doesNotMatch(talentMarkup, /Retry calendar sync|data-cpw-open="reschedule"|data-cpw-open="cancel"/);
});

test('approval adapter supports the complete handoff, checklist, and activation sequence only when explicitly supplied', async () => {
  const seed = workflowUi.defaultSeed('admin');
  seed.handoffs[0].startDate = new Date().toISOString().slice(0, 10);
  const adapter = workflowUi.createApprovalAdapter(seed);
  let state = await adapter.mutate('confirm_placement', {
    hiringRequestId: REQUEST_ID,
    expectedUpdatedAt: seed.handoffs[0].updatedAt,
    handoffId: seed.handoffs[0].handoffId
  });
  assert.equal(state.placements[0].status, 'onboarding');
  for (const item of state.placements[0].onboardingItems) {
    state = await adapter.mutate('update_onboarding', {
      hiringRequestId: REQUEST_ID,
      expectedUpdatedAt: item.updatedAt,
      onboardingItemId: item.onboardingItemId,
      status: 'completed'
    });
  }
  state = await adapter.mutate('activate_placement', {
    hiringRequestId: REQUEST_ID,
    expectedUpdatedAt: state.placements[0].updatedAt,
    placementId: state.placements[0].placementId
  });
  assert.equal(state.placements[0].status, 'active');
  assert.equal(adapter.kind, 'approval');
});

test('mount uses the endpoint adapter by default and approval data only with an explicit adapter', async () => {
  const fetchCalls = [];
  const liveTarget = target();
  const mounted = await workflowUi.mount(liveTarget, {
    role: 'sales',
    hiringRequestId: REQUEST_ID,
    endpointOptions: {
      getAccessToken: async () => 'live-session',
      fetch: async (url) => { fetchCalls.push(url); return response(workflowUi.defaultSeed('sales')); }
    }
  });
  assert.equal(mounted, true);
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0], /client-placement-workflow\?hiringRequestId=/);
  assert.match(liveTarget.innerHTML, /Client placement workspace/);
  workflowUi.unmount();

  const approvalTarget = target();
  const approvalAdapter = workflowUi.createApprovalAdapter(workflowUi.defaultSeed('client_reviewer'));
  assert.equal(await workflowUi.mount(approvalTarget, { role: 'client_reviewer', hiringRequestId: REQUEST_ID, adapter: approvalAdapter }), true);
  assert.match(approvalTarget.innerHTML, /Review-only access/);
  workflowUi.unmount();
});
