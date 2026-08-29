const assert = require('node:assert/strict');
const test = require('node:test');

const workday = require('../operations/talent-workday.js');

const talentContext = Object.freeze({ currentView: 'overview', actualRole: 'virtual_assistant' });

test('only an actual Talent dashboard receives one workday action', () => {
  assert.deepEqual(
    workday.actionForStatus({ state: 'not_started', eligible: true }, talentContext),
    { action: 'start_day', label: 'Start Day' }
  );
  assert.deepEqual(
    workday.actionForStatus({ state: 'started', eligible: true }, talentContext),
    { action: 'check_out', label: 'Check Out' }
  );

  for (const currentView of ['tasks', 'documents', 'talent-my-profile']) {
    assert.equal(workday.actionForStatus({ state: 'not_started', eligible: true }, {
      currentView,
      actualRole: 'virtual_assistant'
    }), null);
  }
  for (const actualRole of ['admin', 'talent_management', 'sales', 'client_admin', '']) {
    assert.equal(workday.actionForStatus({ state: 'not_started', eligible: true }, {
      currentView: 'overview',
      actualRole
    }), null);
  }
});

test('unmatched, future, completed, review, loading, and error states never render a workday button', () => {
  for (const state of ['completed', 'unmatched', 'not_yet_available', 'needs_review', 'loading', 'error', 'idle']) {
    assert.equal(workday.actionMarkup({ ...talentContext, status: { state, eligible: state === 'completed' } }), '');
  }
  assert.equal(workday.actionMarkup({ ...talentContext, status: { state: 'not_started', eligible: false } }), '');
});

test('dashboard markup contains one clearly labeled action without placeholder controls', () => {
  const start = workday.actionMarkup({ ...talentContext, status: { state: 'not_started', eligible: true } });
  const checkout = workday.actionMarkup({ ...talentContext, status: { state: 'started', eligible: true } });

  assert.match(start, /data-talent-workday-action="start_day"/);
  assert.match(start, />Start Day<\/button>/);
  assert.match(checkout, /data-talent-workday-action="check_out"/);
  assert.match(checkout, />Check Out<\/button>/);
  assert.equal((start.match(/<button\b/g) || []).length, 1);
  assert.equal((checkout.match(/<button\b/g) || []).length, 1);
  assert.doesNotMatch(`${start}${checkout}`, /\+\s*Start Day|Request Time Off|Customize/);
});

test('Talent dashboard metric reflects the secure workday state while other roles retain their metric', () => {
  const fallback = ['Existing metric', '12', 'Unchanged', 'warning'];
  assert.equal(workday.dashboardMetric(fallback, 'admin', { state: 'started', eligible: true }), fallback);
  assert.deepEqual(
    workday.dashboardMetric(fallback, 'virtual_assistant', {
      state: 'not_started', eligible: true, clientName: 'Example Client'
    }),
    ['Today’s work', 'Not started', 'Ready to start · Example Client', '']
  );
  assert.deepEqual(
    workday.dashboardMetric(fallback, 'virtual_assistant', { state: 'unmatched', eligible: false }),
    ['Today’s work', 'Not scheduled', 'No current client placement', '']
  );
  assert.deepEqual(
    workday.dashboardMetric(fallback, 'virtual_assistant', { state: 'completed', eligible: true }),
    ['Today’s work', 'Complete', 'Workday completed', '']
  );
});

test('status normalization accepts the service wrappers and fails closed on unknown values', () => {
  const wrapped = workday.normalizeStatus({ attendance: {
    state: 'started', eligible: true, placement_id: 'placement-1', started_at: '2026-08-29T14:00:00Z'
  } });
  assert.equal(wrapped.state, 'started');
  assert.equal(wrapped.placementId, 'placement-1');
  assert.equal(wrapped.startedAt, '2026-08-29T14:00:00Z');
  assert.equal(wrapped.eligible, true);
  assert.equal(Object.isFrozen(wrapped), true);

  const unknown = workday.normalizeStatus({ state: 'maybe', eligible: true });
  assert.equal(unknown.state, 'error');
  assert.equal(unknown.eligible, false);
  assert.equal(workday.actionMarkup({ ...talentContext, status: unknown }), '');
});

test('load uses the bearer session and actions post one idempotency UUID', async t => {
  const originals = {
    access: globalThis.soroCurrentAccess,
    database: globalThis.soroSupabase,
    fetch: globalThis.fetch
  };
  t.after(() => {
    if (originals.access === undefined) delete globalThis.soroCurrentAccess;
    else globalThis.soroCurrentAccess = originals.access;
    if (originals.database === undefined) delete globalThis.soroSupabase;
    else globalThis.soroSupabase = originals.database;
    globalThis.fetch = originals.fetch;
    workday.reset({ silent: true });
  });

  globalThis.soroCurrentAccess = { role: 'virtual_assistant', user_id: 'talent-user' };
  globalThis.soroSupabase = {
    auth: { getSession: async () => ({ data: { session: { access_token: 'secure-token' } }, error: null }) }
  };
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    const result = options.method === 'GET'
      ? { state: 'not_started', eligible: true, placementId: 'placement-1', clientName: 'Example Client' }
      : { state: 'started', eligible: true, placementId: 'placement-1', sessionId: 'session-1', startedAt: '2026-08-29T14:00:00Z' };
    return { ok: true, status: 200, text: async () => JSON.stringify(result) };
  };

  await workday.load();
  assert.equal(calls[0].url, '/.netlify/functions/talent-attendance');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secure-token');
  assert.equal(workday.currentStatus().state, 'not_started');

  await workday.performAction('start_day');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer secure-token');
  assert.equal(calls[1].options.headers['Content-Type'], 'application/json');
  const request = JSON.parse(calls[1].options.body);
  assert.equal(request.action, 'start_day');
  assert.match(request.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(workday.currentStatus().state, 'started');

  await workday.handleAuthChange({ detail: { session: null, access: null } });
  assert.equal(workday.currentStatus().state, 'idle');
  assert.equal(workday.actionMarkup(talentContext), '');
});

test('dashboard binding registers one handler and ignores repeated binding', () => {
  let registrations = 0;
  const button = {
    dataset: { talentWorkdayAction: 'start_day' },
    addEventListener(type) { if (type === 'click') registrations += 1; }
  };
  const scope = { querySelector: () => button };

  assert.equal(workday.bindDashboardAction(scope), true);
  assert.equal(workday.bindDashboardAction(scope), false);
  assert.equal(registrations, 1);
});
