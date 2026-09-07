const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.join(__dirname, '..');
const workflow = require('../operations/client-workflow.js');

function read(relativePath) {
  const absolutePath = path.join(projectRoot, relativePath);
  assert.equal(fs.existsSync(absolutePath), true, `${relativePath} must exist.`);
  return fs.readFileSync(absolutePath, 'utf8');
}

function rootElement() {
  return {
    innerHTML: '',
    replaceChildren() { this.innerHTML = ''; },
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
}

test('Client Workflow is editable for Admin and Sales and read-only for Talent Management', () => {
  ['admin', 'sales', 'sales_management', 'talent_management'].forEach(role => assert.equal(workflow.canOpenForRole(role), true));
  ['billing', 'client_admin', 'client_reviewer', 'client_billing', 'virtual_assistant', ''].forEach(role => {
    assert.equal(workflow.canOpenForRole(role), false, `${role || 'empty role'} must not open the workflow.`);
  });
  ['admin', 'sales', 'sales_management'].forEach(role => assert.equal(workflow.canEditForRole(role), true));
  ['talent_management', 'billing', 'client_admin', ''].forEach(role => assert.equal(workflow.canEditForRole(role), false));
  assert.equal(workflow.canAssignOwner('admin'), true);
  assert.equal(workflow.canAssignOwner('sales_management'), true);
  assert.equal(workflow.canAssignOwner('sales'), false);
});

test('the guided form creates company, primary contact, owner, first request, and portal access together', async () => {
  const target = rootElement();
  await workflow.mount(target, { role: 'admin', adapter: workflow.createApprovalAdapter(), start: 'create' });

  assert.match(target.innerHTML, /Create Client &amp; Hiring Request/);
  ['companyName', 'companyPhone', 'addressLine1', 'addressLine2', 'city', 'stateRegion', 'postalCode', 'country', 'contactName', 'contactEmail', 'ownerId', 'roleTitle', 'vaType', 'seats', 'skills', 'schedule', 'timeZone', 'targetStartDate', 'portalInvite'].forEach(name => {
    assert.match(target.innerHTML, new RegExp(`name="${name}"`), `${name} must be captured in the guided form.`);
  });
  assert.match(target.innerHTML, /One submission creates the Client and first hiring request together/);
  assert.match(target.innerHTML, /Admin and Sales Management can assign this after creation/);
  assert.match(target.innerHTML, />Local approval preview</);
});

test('Sales ownership is locked to the current salesperson while Admin can assign it', async () => {
  const target = rootElement();
  const adapter = workflow.createApprovalAdapter();
  await workflow.mount(target, { role: 'sales', adapter, start: 'create' });
  assert.match(target.innerHTML, /client-workflow-owner-lock/);
  assert.match(target.innerHTML, /Assigned to you/);
  assert.doesNotMatch(target.innerHTML, /<select name="ownerId"/);

  await workflow.mount(target, { role: 'admin', adapter, start: 'create' });
  assert.match(target.innerHTML, /<select name="ownerId">/);
  assert.match(target.innerHTML, /<option value="">Unassigned<\/option>/);
  assert.doesNotMatch(target.innerHTML, /<select name="ownerId" required>/);
});

test('Admin can create an unassigned Client and Sales fallback uses the authenticated display name', async () => {
  const target = rootElement();
  const emptyAdapter = { kind: 'endpoint', async loadWorkspace() { return { owners: [], clients: [] }; } };
  const originalAccess = globalThis.soroCurrentAccess;
  try {
    globalThis.soroCurrentAccess = { role: 'admin', user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', display_name: 'Matt Johnson' };
    await workflow.mount(target, { role: 'admin', adapter: emptyAdapter, start: 'create' });
    assert.match(target.innerHTML, /<option value="">Unassigned<\/option>/);
    assert.doesNotMatch(target.innerHTML, /Local approval preview/);
    const unassigned = workflow.normalizeBundle({ companyName: 'No Owner Client', contactName: 'Casey Client', contactEmail: 'casey@example.com', ownerId: '', roleTitle: 'Virtual Assistant' });
    assert.equal(unassigned.owner.id, '');
    assert.equal(unassigned.owner.name, 'Unassigned');

    globalThis.soroCurrentAccess = { role: 'sales', user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', display_name: 'Jordan Reed' };
    await workflow.mount(target, { role: 'sales', adapter: emptyAdapter, start: 'create' });
    assert.match(target.innerHTML, />Jordan Reed</);
    assert.match(target.innerHTML, /value="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"/);
  } finally {
    globalThis.soroCurrentAccess = originalAccess;
  }
});

test('the Client Hub keeps account, access, requests, placement progress, and activity in one view', async () => {
  const target = rootElement();
  await workflow.mount(target, { role: 'sales', adapter: workflow.createApprovalAdapter() });
  workflow.openHub('preview-client-brightlane');

  assert.match(target.innerHTML, /data-client-workflow-state="hub"/);
  assert.match(target.innerHTML, />Client Hub</);
  assert.match(target.innerHTML, />Brightlane Medical</);
  assert.match(target.innerHTML, />Business &amp; owner</);
  assert.match(target.innerHTML, />Primary contact</);
  assert.match(target.innerHTML, />Client Portal</);
  assert.match(target.innerHTML, />Hiring requests</);
  assert.match(target.innerHTML, />Medical Virtual Assistant</);
  ['Hiring request', 'Shortlist', 'Client review', 'Interview', 'Selection', 'Placement', 'Onboarding'].forEach(label => {
    assert.match(target.innerHTML, new RegExp(`>${label}<`), `${label} must be visible in the placement journey.`);
  });
  assert.match(target.innerHTML, />Activity</);
  assert.match(target.innerHTML, /data-client-workflow-find-talent/);
});

test('Talent Management receives the same Client Hub data without mutation controls', async () => {
  const target = rootElement();
  await workflow.mount(target, { role: 'talent_management', adapter: workflow.createApprovalAdapter() });
  workflow.openHub('preview-client-brightlane');

  assert.match(target.innerHTML, /data-client-workflow-state="hub"/);
  assert.match(target.innerHTML, />Brightlane Medical</);
  assert.match(target.innerHTML, />View only</);
  assert.doesNotMatch(target.innerHTML, /data-client-workflow-edit=/);
  assert.doesNotMatch(target.innerHTML, /data-client-workflow-edit-request/);
  assert.doesNotMatch(target.innerHTML, /data-client-workflow-add-request/);
  assert.doesNotMatch(target.innerHTML, /data-client-workflow-find-talent/);
  assert.doesNotMatch(target.innerHTML, /data-client-workflow-portal/);
  workflow.openCreate();
  assert.match(target.innerHTML, /data-client-workflow-state="hub"/, 'Read-only viewers cannot open Client creation.');
});

test('canonical backend request statuses map to the correct visible placement steps', () => {
  const mappings = [
    ['shortlisting', 'shortlist'],
    ['client_review', 'client_review'],
    ['interviewing', 'interview'],
    ['selection_pending', 'selection'],
    ['placement_pending', 'placement'],
    ['partially_filled', 'placement'],
    ['filled', 'onboarding']
  ];
  mappings.forEach(([status, step]) => {
    const normalized = workflow.normalizeClient({
      clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      companyName: 'Status Mapping Client',
      lifecycleStage: 'matching',
      hiringRequests: [{ hiringRequestId: `request-${status}`, title: 'Virtual Assistant', status }]
    });
    assert.equal(normalized.hiringRequests[0].progressStep, step, `${status} must display as ${step}.`);
    assert.equal(normalized.hiringRequests[0].candidateCount, null, 'Missing placement counts must remain unknown.');
  });
});

test('manual status controls exclude workflow-owned placement transitions', () => {
  assert.deepEqual(workflow.clientStageOptions('matching').map(([value]) => value), ['matching', 'paused', 'lost']);
  assert.deepEqual(workflow.clientStageOptions('active').map(([value]) => value), ['active', 'paused', 'lost']);
  assert.deepEqual(workflow.requestStatusOptions('shortlisting').map(([value]) => value), ['shortlisting', 'on_hold', 'cancelled']);
  assert.deepEqual(workflow.requestStatusOptions('interviewing').map(([value]) => value), ['interviewing']);
  assert.deepEqual(workflow.requestStatusOptions('filled').map(([value]) => value), ['filled']);
});

test('the approval adapter is local-only and preserves the combined creation contract', async () => {
  const adapter = workflow.createApprovalAdapter([]);
  const bundle = workflow.normalizeBundle({
    companyName: 'Example Health',
    industry: 'Healthcare',
    contactName: 'Avery Parker',
    contactEmail: 'AVERY@EXAMPLE.COM',
    contactPhone: '(555) 010-1000',
    ownerId: 'current-user',
    roleTitle: 'Medical Virtual Assistant',
    vaType: 'Medical',
    seats: '2',
    skills: 'Medical scheduling, Insurance verification',
    schedule: 'Monday-Friday',
    timeZone: 'America/Chicago',
    targetStartDate: '2026-09-15',
    portalInvite: true
  });
  const created = await adapter.createClientBundle(bundle);
  const listed = await adapter.listClients();

  assert.equal(adapter.kind, 'approval');
  assert.equal(created.company.name, 'Example Health');
  assert.equal(created.primaryContact.email, 'avery@example.com');
  assert.equal(created.hiringRequests.length, 1);
  assert.equal(created.hiringRequests[0].seats, 2);
  assert.deepEqual([...created.hiringRequests[0].skills], ['Medical scheduling', 'Insurance verification']);
  assert.equal(created.portal.status, 'invite_pending');
  assert.equal(listed.length, 1);
});

test('the production adapter loads and normalizes the authenticated workspace', async () => {
  const originalSupabase = globalThis.soroSupabase;
  globalThis.soroSupabase = { auth: { async getSession() { return { data: { session: { access_token: 'secure-token' } } }; } } };
  let capturedUrl = '';
  let capturedOptions = null;
  try {
    const adapter = workflow.createEndpointAdapter({
      endpoint: '/secure/client-workflow',
      async fetch(url, options) {
        capturedUrl = url;
        capturedOptions = options;
        return { ok: true, async json() { return {
          viewerRole: 'admin',
          salesOwners: [{ userId: '11111111-1111-4111-8111-111111111111', displayName: 'Morgan Lee' }],
          clients: [{
            clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            companyName: 'Example Health',
            industry: 'Healthcare',
            lifecycleStage: 'matching',
            salesOwnerId: '11111111-1111-4111-8111-111111111111',
            contacts: [{ contactId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', fullName: 'Avery Parker', email: 'avery@example.com', contactRole: 'Primary contact', active: true, portalAccessStatus: 'active' }],
            hiringRequests: [{ hiringRequestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', title: 'Medical Virtual Assistant', status: 'shortlisting', numberOfTalent: 2, requiredFields: { skills: ['Medical scheduling'] } }]
          }]
        }; } };
      }
    });
    const clients = await adapter.listClients();
    assert.equal(clients.length, 1);
    assert.equal(clients[0].company.name, 'Example Health');
    assert.equal(clients[0].owner.name, 'Morgan Lee');
    assert.equal(clients[0].primaryContact.name, 'Avery Parker');
    assert.equal(clients[0].portal.status, 'active');
    assert.equal(clients[0].hiringRequests[0].progressStep, 'shortlist');
    assert.equal(adapter.kind, 'endpoint');
    assert.equal(capturedUrl, '/secure/client-workflow');
    assert.equal(capturedOptions.method, 'GET');
    assert.equal(capturedOptions.cache, 'no-store');
    assert.equal(capturedOptions.headers.Authorization, 'Bearer secure-token');
    assert.equal(capturedOptions.body, undefined);
    assert.equal(workflow.ENDPOINT, '/.netlify/functions/client-pipeline');
    assert.equal(workflow.PORTAL_ACCESS_ENDPOINT, '/.netlify/functions/client-portal-access');
  } finally {
    globalThis.soroSupabase = originalSupabase;
  }
});

test('durable pending portal intent is prioritized after reload and reused exactly for takeover', async () => {
  const originalSupabase = globalThis.soroSupabase;
  const originalAccess = globalThis.soroCurrentAccess;
  globalThis.soroSupabase = { auth: { async getSession() { return { data: { session: { access_token: 'secure-token' } } }; } } };
  globalThis.soroCurrentAccess = { user_id: '11111111-1111-4111-8111-111111111111' };
  const contactId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const base = {
    clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    companyName: 'Pending Access Client',
    lifecycleStage: 'discovery',
    owner: { id: '11111111-1111-4111-8111-111111111111', name: 'Morgan Lee' },
    contacts: [{
      contactId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', fullName: 'Other Active Contact',
      email: 'other@example.com', contactRole: 'Operations', active: true, isPrimary: false
    }, {
      contactId, fullName: 'Pending Contact', email: 'contact@example.com', isPrimary: true,
      contactRole: 'Primary contact', active: true, portalAccessStatus: 'invite_pending',
      portalLoginEmail: 'old-login@example.com',
      pendingPortalAccess: { action: 'change_email', email: 'persisted-new@example.com', portalRole: null }
    }],
    hiringRequests: []
  };
  const pendingChange = workflow.normalizeClient(base);
  const target = rootElement();
  const calls = [];
  try {
    await workflow.mount(target, {
      role: 'admin',
      adapter: { kind: 'endpoint', async loadWorkspace() { return { owners: [], clients: [pendingChange] }; } }
    });
    workflow.openHub(pendingChange.id);
    assert.equal(pendingChange.primaryContact.id, contactId);
    assert.match(target.innerHTML, /Retry pending action/);
    assert.match(target.innerHTML, /persisted-new@example\.com/);

    const adapter = workflow.createEndpointAdapter({
      endpoint: '/secure/pipeline',
      portalEndpoint: '/secure/portal',
      async fetch(url, options) {
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({ url, options, body });
        if (url === '/secure/portal') return { ok: true, async json() { return { access: { contactId, status: 'invite_pending' } }; } };
        return { ok: true, async json() { return { viewerRole: 'admin', salesOwners: [], clients: [base] }; } };
      }
    });
    await adapter.changePortalAccess(pendingChange, 'change_email', { email: 'untrusted-override@example.com' });

    const pendingActivate = workflow.normalizeClient({
      ...base,
      contacts: [{
        ...base.contacts[0], portalAccessStatus: 'not_invited', portalLoginEmail: null,
        pendingPortalAccess: { action: 'activate', email: 'persisted-activate@example.com', portalRole: 'client_billing' }
      }]
    });
    await adapter.changePortalAccess(pendingActivate, 'activate', {
      email: 'untrusted-activate@example.com', portalRole: 'client_admin'
    });

    const portalPosts = calls.filter(call => call.url === '/secure/portal');
    assert.equal(portalPosts[0].body.email, 'persisted-new@example.com');
    assert.equal(portalPosts[0].body.portalRole, undefined);
    assert.equal(portalPosts[1].body.email, 'persisted-activate@example.com');
    assert.equal(portalPosts[1].body.portalRole, 'client_billing');
  } finally {
    workflow.unmount();
    globalThis.soroSupabase = originalSupabase;
    globalThis.soroCurrentAccess = originalAccess;
  }
});

test('production creation uses the exact combined body, activates portal access, and refreshes workspace', async () => {
  const originalSupabase = globalThis.soroSupabase;
  globalThis.soroSupabase = { auth: { async getSession() { return { data: { session: { access_token: 'secure-token' } } }; } } };
  const calls = [];
  const clientId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const contactId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const ownerId = '11111111-1111-4111-8111-111111111111';
  try {
    const adapter = workflow.createEndpointAdapter({
      async fetch(url, options) {
        calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
        if (url === workflow.PORTAL_ACCESS_ENDPOINT) return { ok: true, async json() { return { access: { contactId, status: 'invite_pending' } }; } };
        if (options.method === 'POST') return { ok: true, async json() { return { action: 'create_client', clientId, contactId, hiringRequestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }; } };
        return { ok: true, async json() { return {
          viewerRole: 'admin',
          salesOwners: [{ userId: ownerId, displayName: 'Morgan Lee' }],
          clients: [{ clientId, companyName: 'Example Health', industry: 'Healthcare', lifecycleStage: 'discovery', salesOwnerId: ownerId, updatedAt: '2026-09-01T17:00:00.000Z', contacts: [{ contactId, fullName: 'Avery Parker', email: 'avery@example.com', contactRole: 'Primary contact', active: true, portalLoginEmail: 'avery@example.com', portalAccessStatus: 'invite_pending' }], hiringRequests: [{ hiringRequestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', title: 'Medical Virtual Assistant', status: 'discovery', numberOfTalent: 2, requiredFields: { vaType: 'Medical', skills: ['Medical scheduling'], schedule: 'Monday-Friday', timeZone: 'America/Chicago' } }] }]
        }; } };
      }
    });
    const bundle = workflow.normalizeBundle({ companyName: 'Example Health', industry: 'Healthcare', contactName: 'Avery Parker', contactEmail: 'avery@example.com', ownerId, roleTitle: 'Medical Virtual Assistant', vaType: 'Medical', seats: 2, skills: 'Medical scheduling', schedule: 'Monday-Friday', timeZone: 'America/Chicago', portalInvite: true });
    const outcome = await adapter.createClientBundle(bundle);

    assert.equal(outcome.warning, '');
    assert.equal(outcome.client.id, clientId);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].url, workflow.ENDPOINT);
    assert.deepEqual(Object.keys(calls[0].body).sort(), ['action', 'client', 'firstRequest', 'primaryContact', 'requestId']);
    assert.equal(calls[0].body.action, 'create_client');
    assert.equal(calls[0].body.client.companyName, 'Example Health');
    assert.equal(calls[0].body.firstRequest.requiredFields.vaType, 'Medical');
    assert.equal(calls[0].body.payload, undefined);
    assert.equal(calls[1].url, workflow.PORTAL_ACCESS_ENDPOINT);
    assert.equal(calls[1].body.action, 'activate');
    assert.equal(calls[1].body.contactId, contactId);
    assert.equal(calls[1].body.email, 'avery@example.com');
    assert.equal(calls[1].body.portalRole, 'client_admin');
    assert.equal(calls[2].options.method, 'GET');
  } finally {
    globalThis.soroSupabase = originalSupabase;
  }
});

test('portal delivery failure preserves the created Client and never retries creation', async () => {
  const originalSupabase = globalThis.soroSupabase;
  globalThis.soroSupabase = { auth: { async getSession() { return { data: { session: { access_token: 'secure-token' } } }; } } };
  const calls = [];
  const clientId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const contactId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  try {
    const adapter = workflow.createEndpointAdapter({
      async fetch(url, options) {
        calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
        if (url === workflow.PORTAL_ACCESS_ENDPOINT) return { ok: false, async json() { return { message: 'Invitation delivery failed.' }; } };
        if (options.method === 'POST') return { ok: true, async json() { return { action: 'create_client', clientId, contactId }; } };
        return { ok: true, async json() { return { viewerRole: 'admin', salesOwners: [], clients: [{ clientId, companyName: 'Saved Client', lifecycleStage: 'discovery', contacts: [{ contactId, fullName: 'Saved Contact', email: 'saved@example.com', contactRole: 'Primary contact', active: true, portalAccessStatus: 'delivery_failed' }], hiringRequests: [{ hiringRequestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', title: 'Virtual Assistant', status: 'discovery' }] }] }; } };
      }
    });
    const bundle = workflow.normalizeBundle({ companyName: 'Saved Client', contactName: 'Saved Contact', contactEmail: 'saved@example.com', ownerId: '11111111-1111-4111-8111-111111111111', roleTitle: 'Virtual Assistant', portalInvite: true });
    const outcome = await adapter.createClientBundle(bundle);

    assert.equal(outcome.client.id, clientId);
    assert.match(outcome.warning, /Invitation delivery failed/);
    assert.equal(calls.filter(call => call.url === workflow.ENDPOINT && call.options.method === 'POST').length, 1, 'Client creation must never be retried after access delivery fails.');
    assert.equal(calls.at(-1).options.method, 'GET', 'The saved Client is refreshed after the portal attempt.');
  } finally {
    globalThis.soroSupabase = originalSupabase;
  }
});

test('a Client creation retry reuses its request ID after an ambiguous transport failure', async () => {
  const originalSupabase = globalThis.soroSupabase;
  globalThis.soroSupabase = { auth: { async getSession() { return { data: { session: { access_token: 'secure-token' } } }; } } };
  const calls = [];
  const clientId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const contactId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const hiringRequestId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  let createAttempts = 0;
  try {
    const adapter = workflow.createEndpointAdapter({
      async fetch(url, options) {
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({ url, options, body });
        if (options.method === 'POST') {
          createAttempts += 1;
          if (createAttempts === 1) throw new TypeError('Connection closed after commit.');
          return { ok: true, status: 200, async json() { return { action: 'create_client', clientId, contactId, hiringRequestId }; } };
        }
        return { ok: true, status: 200, async json() { return { viewerRole: 'admin', salesOwners: [], clients: [{ clientId, companyName: 'Retry Safe Client', lifecycleStage: 'discovery', contacts: [{ contactId, fullName: 'Avery Parker', email: 'avery@example.com', contactRole: 'Primary contact', active: true, portalAccessStatus: 'not_invited' }], hiringRequests: [{ hiringRequestId, title: 'Virtual Assistant', status: 'discovery' }] }] }; } };
      }
    });
    const bundle = workflow.normalizeBundle({ companyName: 'Retry Safe Client', contactName: 'Avery Parker', contactEmail: 'avery@example.com', ownerId: '11111111-1111-4111-8111-111111111111', roleTitle: 'Virtual Assistant', portalInvite: false });

    await assert.rejects(adapter.createClientBundle(bundle), /Connection closed/);
    const outcome = await adapter.createClientBundle(bundle);
    const createCalls = calls.filter(call => call.options.method === 'POST');

    assert.equal(outcome.client.id, clientId);
    assert.equal(createCalls.length, 2);
    assert.equal(createCalls[0].body.requestId, createCalls[1].body.requestId, 'The same logical creation must reuse its idempotency key.');
  } finally {
    globalThis.soroSupabase = originalSupabase;
  }
});

test('a Client creation retry preserves its request ID when verification fails after the POST committed', async () => {
  const originalSupabase = globalThis.soroSupabase;
  globalThis.soroSupabase = { auth: { async getSession() { return { data: { session: { access_token: 'secure-token' } } }; } } };
  const calls = [];
  const clientId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const contactId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const hiringRequestId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  let workspaceAttempts = 0;
  try {
    const adapter = workflow.createEndpointAdapter({
      async fetch(url, options) {
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({ url, options, body });
        if (options.method === 'POST') return { ok: true, status: 200, async json() { return { action: 'create_client', clientId, contactId, hiringRequestId }; } };
        workspaceAttempts += 1;
        if (workspaceAttempts === 1) return { ok: false, status: 401, async json() { return { message: 'Sign in again.' }; } };
        return { ok: true, status: 200, async json() { return { viewerRole: 'admin', salesOwners: [], clients: [{ clientId, companyName: 'Committed Client', lifecycleStage: 'discovery', contacts: [{ contactId, fullName: 'Avery Parker', email: 'avery@example.com', contactRole: 'Primary contact', active: true, portalAccessStatus: 'not_invited' }], hiringRequests: [{ hiringRequestId, title: 'Virtual Assistant', status: 'discovery' }] }] }; } };
      }
    });
    const bundle = workflow.normalizeBundle({ companyName: 'Committed Client', contactName: 'Avery Parker', contactEmail: 'avery@example.com', ownerId: '11111111-1111-4111-8111-111111111111', roleTitle: 'Virtual Assistant', portalInvite: false });

    await assert.rejects(adapter.createClientBundle(bundle), /Sign in again/);
    const outcome = await adapter.createClientBundle(bundle);
    const createCalls = calls.filter(call => call.options.method === 'POST');

    assert.equal(outcome.client.id, clientId);
    assert.equal(createCalls.length, 2);
    assert.equal(createCalls[0].body.requestId, createCalls[1].body.requestId, 'A verification failure after commit must not rotate the idempotency key.');
  } finally {
    globalThis.soroSupabase = originalSupabase;
  }
});

test('a portal activation retry reuses its request ID after an ambiguous transport failure', async () => {
  const originalSupabase = globalThis.soroSupabase;
  globalThis.soroSupabase = { auth: { async getSession() { return { data: { session: { access_token: 'secure-token' } } }; } } };
  const calls = [];
  const clientId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const contactId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  let portalAttempts = 0;
  try {
    const adapter = workflow.createEndpointAdapter({
      async fetch(url, options) {
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({ url, options, body });
        if (url === workflow.PORTAL_ACCESS_ENDPOINT) {
          portalAttempts += 1;
          if (portalAttempts === 1) throw new TypeError('Connection closed after invitation commit.');
          return { ok: true, status: 200, async json() { return { access: { contactId, status: 'invite_pending' } }; } };
        }
        return { ok: true, status: 200, async json() { return { viewerRole: 'admin', salesOwners: [], clients: [{ clientId, companyName: 'Portal Retry Client', lifecycleStage: 'discovery', contacts: [{ contactId, fullName: 'Avery Parker', email: 'avery@example.com', contactRole: 'Primary contact', active: true, portalLoginEmail: 'avery@example.com', portalAccessStatus: 'invite_pending' }], hiringRequests: [] }] }; } };
      }
    });
    const client = workflow.normalizeClient({ clientId, companyName: 'Portal Retry Client', lifecycleStage: 'discovery', contacts: [{ contactId, fullName: 'Avery Parker', email: 'avery@example.com', contactRole: 'Primary contact', active: true, portalAccessStatus: 'not_invited' }], hiringRequests: [] });

    await assert.rejects(adapter.changePortalAccess(client, 'activate', { email: 'avery@example.com' }), /Connection closed/);
    const refreshed = await adapter.changePortalAccess(client, 'activate', { email: 'avery@example.com' });
    const portalCalls = calls.filter(call => call.url === workflow.PORTAL_ACCESS_ENDPOINT);

    assert.equal(refreshed.id, clientId);
    assert.equal(portalCalls.length, 2);
    assert.equal(portalCalls[0].body.requestId, portalCalls[1].body.requestId, 'The same logical activation must reuse its idempotency key.');
  } finally {
    globalThis.soroSupabase = originalSupabase;
  }
});

test('portal email retry IDs rotate after definitive delivery failure but persist for pending confirmation', async () => {
  const originalSupabase = globalThis.soroSupabase;
  globalThis.soroSupabase = { auth: { async getSession() { return { data: { session: { access_token: 'secure-token' } } }; } } };
  const clientId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const contactId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const client = workflow.normalizeClient({
    clientId, companyName: 'Portal Retry Classification', lifecycleStage: 'discovery',
    contacts: [{ contactId, fullName: 'Avery Parker', email: 'avery@example.com', contactRole: 'Primary contact', active: true, portalAccessStatus: 'invite_pending' }],
    hiringRequests: []
  });
  try {
    for (const scenario of [
      { code: 'email_delivery_failed', status: 502, expectSame: false },
      { code: 'access_action_pending', status: 503, expectSame: true }
    ]) {
      const portalBodies = [];
      let attempts = 0;
      const adapter = workflow.createEndpointAdapter({
        async fetch(url, options) {
          const body = options.body ? JSON.parse(options.body) : null;
          if (url === workflow.PORTAL_ACCESS_ENDPOINT) {
            portalBodies.push(body);
            attempts += 1;
            if (attempts === 1) return {
              ok: false, status: scenario.status,
              async json() { return { code: scenario.code, message: 'Retry classification response.' }; }
            };
            return { ok: true, status: 200, async json() { return { access: { contactId, status: 'invite_pending' } }; } };
          }
          return { ok: true, status: 200, async json() { return {
            viewerRole: 'admin', salesOwners: [], clients: [{
              clientId, companyName: 'Portal Retry Classification', lifecycleStage: 'discovery',
              contacts: [{ contactId, fullName: 'Avery Parker', email: 'avery@example.com', contactRole: 'Primary contact', active: true, portalAccessStatus: 'invite_pending' }],
              hiringRequests: []
            }]
          }; } };
        }
      });

      await assert.rejects(adapter.changePortalAccess(client, 'resend_invitation'), /Retry classification response/);
      await adapter.changePortalAccess(client, 'resend_invitation');
      assert.equal(portalBodies.length, 2);
      assert.equal(portalBodies[0].requestId === portalBodies[1].requestId, scenario.expectSame, scenario.code);
    }
  } finally {
    globalThis.soroSupabase = originalSupabase;
  }
});

test('workflow CSS is isolated, responsive, and reduced-motion aware', () => {
  const css = read('operations/client-workflow.css');
  assert.match(css, /\.client-workflow-page/);
  assert.match(css, /\.client-workflow-form-section/);
  assert.match(css, /\.client-workflow-hub-grid/);
  assert.match(css, /\.client-workflow-progress/);
  assert.match(css, /\.client-workflow-dialog/);
  assert.match(css, /@media \(max-width: 620px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /var\(--navy\)/);
  assert.match(css, /var\(--orange\)/);
});

test('the Operations shell loads and routes the workflow before the main controller', () => {
  const html = read('operations/index.html');
  const operations = read('operations/operations.js');
  assert.match(html, /client-workflow\.css\?v=/);
  assert.match(html, /client-workflow\.js\?v=/);
  assert.ok(html.indexOf('client-workflow.js') < html.indexOf('operations.js'));
  assert.match(operations, /current==='clients'[\s\S]*SoroClientWorkflow\?\.canOpenForRole/);
  assert.match(operations, /const options=clientWorkflowMountOptions\(accessRole\);[\s\S]*SoroClientWorkflow\.mount\(root,options\)/);
  assert.match(operations, /id="new-record"[\s\S]*SoroClientWorkflow\?\.canEditForRole/);
  assert.match(operations, /const options=clientWorkflowMountOptions\(currentAuthenticatedRole\(\)\);options\.start='create'[\s\S]*SoroClientWorkflow\.mount\(root,options\)/);
});
