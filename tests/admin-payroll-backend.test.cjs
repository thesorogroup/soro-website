const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const test = require('node:test');

process.env.SUPABASE_URL = 'https://payroll-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const root = path.resolve(__dirname, '..');
const backend = require(path.join(root, 'netlify', 'functions', 'admin-payroll.js'));

const actorId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const itemId = '33333333-3333-4333-8333-333333333333';
const personId = '44444444-4444-4444-8444-444444444444';
const placementId = '55555555-5555-4555-8555-555555555555';
const requestId = '66666666-6666-4666-8666-666666666666';

function response(data, status = 200) {
  return new Response(data === undefined ? '' : JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function event(overrides = {}) {
  return {
    httpMethod: 'GET',
    headers: { authorization: 'Bearer signed-in-token' },
    queryStringParameters: {},
    ...overrides
  };
}

function commonRun(overrides = {}) {
  return {
    runId,
    periodStart: '2026-08-16',
    periodEnd: '2026-08-29',
    payDate: '2026-09-04',
    currency: 'USD',
    status: 'draft',
    totalAmount: 125.5,
    itemCount: 1,
    exceptionCount: 0,
    createdBy: 'Matt Johnson',
    createdAt: '2026-08-29T22:00:00.000Z',
    approvedBy: null,
    approvedAt: null,
    exportedBy: null,
    exportedAt: null,
    exportFileName: null,
    exportSha256: null,
    externalReference: null,
    notes: null,
    updatedAt: '2026-08-29T22:00:00.000Z',
    canEdit: true,
    canApprove: false,
    canExport: false,
    canCancel: true,
    ...overrides
  };
}

function employeeRun(overrides = {}) {
  return commonRun({
    reconciledBy: null,
    reconciledAt: null,
    canReconcile: false,
    items: [{
      itemId,
      employeeUserId: personId,
      employeeName: 'Jordan Reed',
      employeeEmail: 'jordan@example.com',
      employeeRole: 'Talent Management',
      hireDate: '2026-08-01',
      paymentRoute: 'wise_contractor',
      payoutRecipientEmail: 'jordan.wise@example.com',
      included: true,
      amount: 125.5,
      note: null,
      exceptionStatus: 'clear',
      exceptionNote: null,
      updatedAt: '2026-08-29T22:00:00.000Z'
    }],
    ...overrides
  });
}

function talentRun(overrides = {}) {
  return commonRun({
    exceptionCount: 1,
    releasedBy: null,
    releasedAt: null,
    canVerify: true,
    canRelease: false,
    items: [{
      itemId,
      applicantId: personId,
      placementId,
      talentName: 'Mariel Santos',
      recipientEmail: 'mariel@example.com',
      clientName: 'Brightlane Medical',
      rateType: 'manual',
      rateAmount: null,
      paymentReference: 'SORO-20260829-001',
      included: true,
      amount: 125.5,
      note: null,
      verificationStatus: 'needs_review',
      verificationNote: null,
      verifiedBy: null,
      verifiedAt: null,
      exceptionStatus: 'needs_review',
      exceptionNote: 'Enter the manual payout amount and verify the recipient.',
      updatedAt: '2026-08-29T22:00:00.000Z'
    }],
    ...overrides
  });
}

function workspace(viewerRole = 'admin', overrides = {}) {
  return {
    generatedAt: '2026-08-29T22:05:00.000Z',
    viewerRole,
    employeePayroll: viewerRole === 'admin' ? { runs: [employeeRun()] } : null,
    talentPayouts: { runs: [talentRun()] },
    ...overrides
  };
}

function installFetch(t, resolver = () => workspace()) {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const call = { url: String(url), options };
    calls.push(call);
    if (call.url.endsWith('/auth/v1/user')) return response({ id: actorId });
    if (call.url.includes('/rest/v1/rpc/')) {
      const value = resolver(call);
      return response(value?.body === undefined ? value : value.body, value?.httpStatus || 200);
    }
    throw new Error(`Unexpected request ${call.url}`);
  };
  t.after(() => { global.fetch = originalFetch; });
  return calls;
}

function body(result) {
  return JSON.parse(result.body);
}

test('GET authenticates once and derives payroll scope only from the verified actor', async t => {
  const calls = installFetch(t);
  const result = await backend.handler(event());

  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.headers.Vary, 'Authorization');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://payroll-test.supabase.co/auth/v1/user');
  assert.equal(calls[1].url, 'https://payroll-test.supabase.co/rest/v1/rpc/get_admin_payroll_workspace');
  assert.deepEqual(JSON.parse(calls[1].options.body), { p_actor_user_id: actorId });
});

test('workspace projection strips unknown finance and identity fields and withholds employee payroll from Talent Management', async t => {
  installFetch(t, () => workspace('talent_management', {
    bankAccount: 'private',
    talentPayouts: { runs: [talentRun({ privateTotal: 999 })] }
  }));
  const result = await backend.handler(event());
  const payload = body(result);

  assert.deepEqual(Object.keys(payload).sort(), ['employeePayroll', 'generatedAt', 'talentPayouts', 'viewerRole']);
  assert.equal(payload.viewerRole, 'talent_management');
  assert.equal(payload.employeePayroll, null);
  assert.equal(result.body.includes('private'), false);
  assert.equal(result.body.includes('bankAccount'), false);
});

test('workspace counts included rows while safely preserving excluded adjustment rows', async t => {
  const excluded = employeeRun({
    totalAmount: 0,
    itemCount: 0,
    exceptionCount: 0,
    items: [{ ...employeeRun().items[0], included: false, amount: null }]
  });
  installFetch(t, () => workspace('admin', { employeePayroll: { runs: [excluded] } }));

  const result = await backend.handler(event());
  const payload = body(result);
  assert.equal(result.statusCode, 200);
  assert.equal(payload.employeePayroll.runs[0].itemCount, 0);
  assert.equal(payload.employeePayroll.runs[0].items.length, 1);
  assert.equal(payload.employeePayroll.runs[0].items[0].included, false);
});

test('POST maps each exact action to its service-only RPC without browser role, organization, or totals', async t => {
  const calls = installFetch(t);
  const requests = [
    [{ action: 'create_employee_run', requestId, periodStart: '2026-08-16', periodEnd: '2026-08-29', payDate: '2026-09-04', currency: 'usd' }, 'create_employee_payroll_run', 'p_period_start'],
    [{ action: 'update_employee_item', requestId, runId, itemId, amount: '125.50', note: '', included: true, payoutRecipientEmail: 'jordan.wise@example.com' }, 'update_employee_payroll_item', 'p_payout_recipient_email'],
    [{ action: 'create_talent_run', requestId, periodStart: '2026-08-16', periodEnd: '2026-08-29', payDate: '2026-09-04', currency: 'USD' }, 'create_talent_payout_run', 'p_period_start'],
    [{ action: 'update_talent_item', requestId, runId, itemId, amount: '125.50', note: null, included: true, recipientEmail: 'mariel@example.com' }, 'update_talent_payout_item', 'p_recipient_email'],
    [{ action: 'verify_talent_item', requestId, runId, itemId, verificationStatus: 'verified', note: 'Checked' }, 'verify_talent_payout_item', 'p_verification_status'],
    [{ action: 'transition_employee_run', requestId, runId, transition: 'ready', reference: null, note: '' }, 'transition_employee_payroll_run', 'p_action'],
    [{ action: 'transition_talent_run', requestId, runId, transition: 'approve', reference: null, note: null }, 'transition_talent_payout_run', 'p_action']
  ];

  for (const [requestBody, rpcName, expectedKey] of requests) {
    const result = await backend.handler(event({ httpMethod: 'POST', body: JSON.stringify(requestBody) }));
    assert.equal(result.statusCode, 200, requestBody.action);
    const rpcCall = calls.filter(call => call.url.includes('/rest/v1/rpc/')).at(-1);
    assert.ok(rpcCall.url.endsWith(`/rpc/${rpcName}`));
    const rpcBody = JSON.parse(rpcCall.options.body);
    assert.equal(rpcBody.p_actor_user_id, actorId);
    assert.ok(Object.hasOwn(rpcBody, expectedKey));
    for (const forbidden of ['role', 'organizationId', 'totalAmount', 'itemCount']) assert.equal(Object.hasOwn(rpcBody, forbidden), false);
  }
});

test('unknown or extra body fields, number amounts, bad dates, and unsupported transitions fail before authentication', async t => {
  const calls = installFetch(t);
  const attempts = [
    { action: 'create_employee_run', requestId, periodStart: '2026-08-30', periodEnd: '2026-08-29', payDate: '2026-09-04', currency: 'USD' },
    { action: 'update_employee_item', requestId, runId, itemId, amount: 125.5, note: null, included: true, payoutRecipientEmail: 'jordan.wise@example.com' },
    { action: 'verify_talent_item', requestId, runId, itemId, verificationStatus: 'approved', note: null },
    { action: 'transition_talent_run', requestId, runId, transition: 'export', reference: null, note: null },
    { action: 'create_talent_run', requestId, periodStart: '2026-08-16', periodEnd: '2026-08-29', payDate: '2026-09-04', currency: 'USD', organizationId: personId },
    { action: 'made_up', requestId }
  ];

  for (const requestBody of attempts) {
    const before = calls.length;
    const result = await backend.handler(event({ httpMethod: 'POST', body: JSON.stringify(requestBody) }));
    assert.equal(result.statusCode, 400, requestBody.action);
    assert.equal(calls.length, before, `invalid ${requestBody.action} must not authenticate`);
  }
});

test('Talent export is deterministic, formula-safe, server-sourced, hashed, and then durably transitioned', async t => {
  const rows = [
    { itemId: '77777777-7777-4777-8777-777777777777', talentName: '=Injected', recipientEmail: 'safe2@example.com', amount: 20.42, currency: 'USD', reference: '@unsafe' },
    { itemId, talentName: 'Ana, Cruz', recipientEmail: 'safe@example.com', amount: 45.57, currency: 'USD', reference: 'SORO-001' }
  ];
  const calls = installFetch(t, call => {
    if (call.url.endsWith('/rpc/get_talent_payout_export')) {
      return { runId, periodStart: '2026-08-16', periodEnd: '2026-08-29', payDate: '2026-09-04', currency: 'USD', status: 'approved', rows };
    }
    return workspace();
  });

  const result = await backend.handler(event({
    httpMethod: 'POST',
    body: JSON.stringify({ action: 'export_talent_run', requestId, runId })
  }));

  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['Content-Type'], 'text/csv; charset=utf-8');
  assert.match(result.headers['Content-Disposition'], /^attachment; filename="soro-talent-payouts-2026-08-16-to-2026-08-29-usd\.csv"$/);
  assert.ok(result.body.indexOf("'=Injected") < result.body.indexOf('Ana, Cruz'), 'rows must be deterministically name sorted');
  assert.match(result.body, /"Ana, Cruz"/);
  assert.match(result.body, /"'=Injected"/);
  assert.match(result.body, /"'@unsafe"/);

  const transition = calls.find(call => call.url.endsWith('/rpc/transition_talent_payout_run'));
  const transitionBody = JSON.parse(transition.options.body);
  assert.equal(transitionBody.p_action, 'export');
  assert.equal(transitionBody.p_request_id, requestId);
  assert.equal(transitionBody.p_export_file_name, 'soro-talent-payouts-2026-08-16-to-2026-08-29-usd.csv');
  assert.equal(transitionBody.p_export_sha256, crypto.createHash('sha256').update(result.body, 'utf8').digest('hex'));
  assert.equal(JSON.stringify(transitionBody).includes('safe@example.com'), false, 'export rows must never be echoed to transition input');
});

test('Employee export is a staff Wise-preparation file routed only to the payout recipient', async t => {
  const calls = installFetch(t, call => {
    if (call.url.endsWith('/rpc/get_employee_payroll_export')) {
      return {
        runId,
        periodStart: '2026-08-16',
        periodEnd: '2026-08-29',
        payDate: '2026-09-04',
        currency: 'USD',
        status: 'approved',
        rows: [{
          itemId,
          employeeName: 'Jordan Reed',
          employeeEmail: 'login@example.com',
          payoutRecipientEmail: 'jordan.wise@example.com',
          paymentRoute: 'wise_contractor',
          amount: 125.5,
          note: 'Manual review complete',
          reference: 'EP-20260904-ABC12345'
        }]
      };
    }
    return workspace();
  });

  const result = await backend.handler(event({
    httpMethod: 'POST',
    body: JSON.stringify({ action: 'export_employee_run', requestId, runId })
  }));

  assert.equal(result.statusCode, 200);
  assert.match(result.headers['Content-Disposition'], /soro-staff-wise-preparation-/);
  assert.match(result.body, /"Staff name","Wise recipient email"/);
  assert.match(result.body, /jordan\.wise@example\.com/);
  assert.equal(result.body.includes('login@example.com'), false);
  assert.equal(result.body.toLowerCase().includes('sent'), false);
  const transition = calls.find(call => call.url.endsWith('/rpc/transition_employee_payroll_run'));
  assert.equal(JSON.parse(transition.options.body).p_action, 'export');
});

test('Employee Wise export rejects QuickBooks-routed staff and missing payout recipients', () => {
  const base = {
    runId,
    periodStart: '2026-08-16',
    periodEnd: '2026-08-29',
    payDate: '2026-09-04',
    currency: 'USD',
    status: 'approved',
    rows: [{ itemId, employeeName: 'Jordan Reed', payoutRecipientEmail: 'wise@example.com', paymentRoute: 'wise_contractor', amount: 10, note: null, reference: 'EP-1' }]
  };
  assert.throws(() => backend.exportSnapshot({ ...base, rows: [{ ...base.rows[0], paymentRoute: 'quickbooks_employee' }] }, 'employee'));
  assert.throws(() => backend.exportSnapshot({ ...base, rows: [{ ...base.rows[0], payoutRecipientEmail: null }] }, 'employee'));
});

test('exports fail closed when a server snapshot omits a payout amount', async t => {
  installFetch(t, call => call.url.endsWith('/rpc/get_talent_payout_export')
    ? {
        runId,
        periodStart: '2026-08-16',
        periodEnd: '2026-08-29',
        payDate: '2026-09-04',
        currency: 'USD',
        status: 'approved',
        rows: [{ itemId, talentName: 'Ana Cruz', recipientEmail: 'safe@example.com', amount: null, currency: 'USD', reference: 'SORO-001' }]
      }
    : workspace());

  const result = await backend.handler(event({
    httpMethod: 'POST',
    body: JSON.stringify({ action: 'export_talent_run', requestId, runId })
  }));
  assert.equal(result.statusCode, 502);
  assert.equal(result.headers['Cache-Control'], 'no-store');
});

test('signed-out, unauthorized, unsupported, and malformed database responses fail closed with no-store', async t => {
  let calls = installFetch(t);
  const signedOut = await backend.handler(event({ headers: {} }));
  assert.equal(signedOut.statusCode, 401);
  assert.equal(calls.length, 0);

  for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const result = await backend.handler(event({ httpMethod: method }));
    assert.equal(result.statusCode, 405);
    assert.equal(result.headers.Allow, 'GET, POST');
  }

  calls = installFetch(t, () => ({ body: { code: '42501', message: 'private role detail' }, httpStatus: 400 }));
  const forbidden = await backend.handler(event());
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.body.includes('private role'), false);

  calls = installFetch(t, () => ({}));
  const malformed = await backend.handler(event());
  assert.equal(malformed.statusCode, 502);
  assert.equal(malformed.headers['Cache-Control'], 'no-store');
});
