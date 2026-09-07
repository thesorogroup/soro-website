const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const previousUrl = process.env.SUPABASE_URL;
const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.SUPABASE_URL = 'https://client-pipeline-tests.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
const service = require('../netlify/functions/client-pipeline.js');

test.after(() => {
  if (previousUrl === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = previousUrl;
  if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
});

const IDS = Object.freeze({
  actor: '11111111-1111-4111-8111-111111111111',
  operation: '22222222-2222-4222-8222-222222222222',
  client: '33333333-3333-4333-8333-333333333333',
  contact: '44444444-4444-4444-8444-444444444444',
  request: '55555555-5555-4555-8555-555555555555',
  owner: '66666666-6666-4666-8666-666666666666'
});
const UPDATED = '2026-09-01T12:34:56.000Z';

function workspace(role = 'sales') {
  return {
    generatedAt: UPDATED,
    viewerRole: role,
    salesOwners: ['admin', 'sales_management'].includes(role)
      ? [{ userId: IDS.owner, displayName: 'Sales Owner' }]
      : [],
    clients: [{
      clientId: IDS.client,
      companyName: 'Example Client',
      industry: 'Healthcare',
      lifecycleStage: 'discovery',
      salesOwnerId: IDS.owner,
      addressLine1: null,
      addressLine2: null,
      city: null,
      stateRegion: null,
      postalCode: null,
      country: 'United States',
      companyPhone: null,
      website: null,
      archivedAt: null,
      createdAt: UPDATED,
      updatedAt: UPDATED,
      canEdit: role !== 'talent_management',
      activity: [],
      contacts: [{
        contactId: IDS.contact,
        fullName: 'Primary Contact',
        email: 'contact@example.test',
        phone: null,
        contactRole: 'Primary contact',
        isPrimary: true,
        active: true,
        portalLoginEmail: null,
        portalAccessStatus: 'not_invited',
        portalInviteSentAt: null,
        portalAccessActivatedAt: null,
        pendingPortalAccess: null,
        createdAt: UPDATED,
        updatedAt: UPDATED
      }],
      hiringRequests: [{
        hiringRequestId: IDS.request,
        title: 'Medical VA',
        status: 'discovery',
        startDate: null,
        numberOfTalent: 1,
        budgetStatus: 'pending',
        requiredFields: {},
        createdAt: UPDATED,
        updatedAt: UPDATED
      }]
    }]
  };
}

test('migration hardens organization scope, direct grants, statuses, and service-only RPCs', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260901_036_client_pipeline_and_access.sql'), 'utf8');
  for (const table of ['client_contacts', 'hiring_requests', 'placements']) {
    assert.match(sql, new RegExp(`alter table public\\.${table}[\\s\\S]*add column if not exists organization_id uuid`, 'i'));
  }
  assert.match(sql, /client_contacts_client_organization_fkey/i);
  assert.match(sql, /hiring_requests_client_organization_fkey/i);
  assert.match(sql, /placements_request_client_organization_fkey/i);
  for (const table of ['clients', 'client_contacts', 'hiring_requests', 'placements']) {
    assert.match(sql, new RegExp(`revoke insert, update, delete on table public\\.${table} from public, anon, authenticated`, 'i'));
  }
  assert.match(sql, /organization_id\s*=\s*private\.current_soro_organization_id\(\)/i);
  assert.match(sql, /private\.current_soro_role\(\)\s*<>\s*'sales'.*sales_owner_id\s*=\s*auth\.uid\(\)/s);
  assert.match(sql, /'new_inquiry'.*'discovery'.*'qualified'.*'matching'.*'active'.*'paused'.*'lost'.*'archived'/s);
  assert.match(sql, /'draft'.*'discovery'.*'open'.*'sourcing'.*'shortlisting'.*'client_review'.*'interviewing'.*'selection_pending'.*'placement_pending'.*'partially_filled'.*'filled'.*'on_hold'.*'cancelled'/s);
  assert.match(sql, /'needs_reconciliation'/);
  assert.match(sql, /create table if not exists public\.client_pipeline_operations/i);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /request_fingerprint/i);
  assert.match(sql, /p_expected_updated_at/i);
  assert.match(sql, /v_actor\.role = 'sales'.*sales_owner_id/s);
  assert.match(sql, /v_actor\.role = 'talent_management'.*read-only/s);
  assert.match(sql, /v_next in \('active', 'archived'\).*dedicated workflows/s);
  assert.match(sql, /v_next not in \('discovery', 'open', 'sourcing', 'on_hold', 'cancelled'\).*shortlist, interview, or placement workflow/s);
  assert.match(sql, /grant execute on function public\.get_client_pipeline_workspace\(uuid\) to service_role/i);
  assert.match(sql, /grant execute on function public\.change_client_pipeline[\s\S]*to service_role/i);
  assert.doesNotMatch(sql, /grant execute on function public\.change_client_pipeline[\s\S]{0,200}to authenticated/i);
  const activityProjection = /'activity', coalesce\(\(([\s\S]*?)'contacts', coalesce/.exec(sql)?.[1] || '';
  assert.match(activityProjection, /event\.organization_id = client\.organization_id/i);
  assert.match(activityProjection, /activity_contact\.client_id = client\.id/i);
  assert.match(activityProjection, /activity_request\.client_id = client\.id/i);
  assert.match(activityProjection, /limit 100/i);
  assert.match(activityProjection, /case lower\(coalesce\(event\.after_value ->> 'outcome', ''\)\)[\s\S]*?when 'completed' then 'completed'[\s\S]*?when 'pending' then 'pending'[\s\S]*?when 'failed' then 'failed'[\s\S]*?else null[\s\S]*?end as outcome/i);
  assert.doesNotMatch(activityProjection, /'beforeValue'|'afterValue'|'note'|event\.note/i,
    'raw audit values and notes must not be emitted by the sanitized activity projection');

  const outcomeLabels = [
    ['client_portal_access_activate', 'Client portal invitation created', 'Client portal invitation pending', 'Client portal invitation failed'],
    ['client_portal_access_resend_invitation', 'Client portal invitation resent', 'Client portal invitation resend pending', 'Client portal invitation resend failed'],
    ['client_portal_access_change_email', 'Client portal login email changed', 'Client portal login email change pending', 'Client portal login email change failed'],
    ['client_portal_access_send_password_reset', 'Client portal password reset sent', 'Client portal password reset pending', 'Client portal password reset failed'],
    ['client_portal_access_suspend_access', 'Client portal access suspended', 'Client portal access suspension pending', 'Client portal access suspension failed'],
    ['client_portal_access_reactivate_access', 'Client portal access reactivated', 'Client portal access reactivation pending', 'Client portal access reactivation failed'],
    ['client_portal_setup_completed', 'Client portal account setup completed', 'Client portal account setup pending', 'Client portal account setup failed'],
    ['client_portal_password_recovery_completed', 'Client portal password recovery completed', 'Client portal password recovery pending', 'Client portal password recovery failed']
  ];
  for (const [eventType, completed, pending, failed] of outcomeLabels) {
    const escapedEvent = eventType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const branch = new RegExp(`when '${escapedEvent}' then case activity\\.outcome([\\s\\S]*?)\\n\\s+end`, 'i').exec(activityProjection)?.[1] || '';
    assert.match(branch, new RegExp(`when 'completed' then '${completed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`, 'i'));
    assert.match(branch, new RegExp(`when 'pending' then '${pending.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`, 'i'));
    assert.match(branch, new RegExp(`when 'failed' then '${failed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`, 'i'));
    assert.match(branch, /else '[^']*status unavailable'/i,
      `${eventType} must fail closed when its audit outcome is absent or unknown`);
  }
});

test('create Client is one exact atomic input with no caller-controlled organization', () => {
  const input = service.inputActionBody({
    action: 'create_client',
    requestId: IDS.operation,
    client: { companyName: 'Example Client', salesOwnerId: IDS.owner, country: 'United States' },
    primaryContact: { fullName: 'Primary Contact', email: 'contact@example.test', contactRole: 'Owner' },
    firstRequest: { title: 'Medical VA', status: 'discovery', numberOfTalent: 2, requiredFields: { skills: ['Coding'] } }
  });
  assert.equal(input.entityId, null);
  assert.equal(input.parentId, null);
  assert.equal(input.expectedUpdatedAt, null);
  assert.equal(input.payload.client.companyName, 'Example Client');
  assert.equal(input.payload.primaryContact.email, 'contact@example.test');
  assert.equal(input.payload.firstRequest.numberOfTalent, 2);
  assert.throws(() => service.inputActionBody({
    action: 'create_client',
    requestId: IDS.operation,
    organizationId: IDS.client,
    client: { companyName: 'Example Client' },
    primaryContact: { fullName: 'Primary Contact' },
    firstRequest: { title: 'Medical VA' }
  }), /Only the fields/i);
});

test('all updates require exact action fields and optimistic lock timestamps', () => {
  const parsed = service.inputActionBody({
    action: 'set_request_status',
    requestId: IDS.operation,
    expectedUpdatedAt: UPDATED,
    entityId: IDS.request,
    payload: { status: 'open' }
  });
  assert.equal(parsed.expectedUpdatedAt, UPDATED);
  assert.equal(parsed.payload.status, 'open');
  assert.throws(() => service.inputActionBody({
    action: 'set_request_status',
    requestId: IDS.operation,
    entityId: IDS.request,
    payload: { status: 'open' }
  }), /Only the fields|required|Reload/i);
  assert.throws(() => service.inputActionBody({
    action: 'update_contact',
    requestId: IDS.operation,
    expectedUpdatedAt: UPDATED,
    entityId: IDS.contact,
    payload: { fullName: 'Contact', portalRole: 'client_admin' }
  }), /Only the fields/i);
  for (const status of ['client_review', 'interviewing', 'selection_pending', 'placement_pending', 'partially_filled', 'filled']) {
    assert.throws(() => service.inputActionBody({
      action: 'set_request_status', requestId: IDS.operation, expectedUpdatedAt: UPDATED,
      entityId: IDS.request, payload: { status }
    }), /controlled by the shortlist, interview, or placement workflow/i);
  }
  assert.throws(() => service.inputActionBody({
    action: 'set_client_stage', requestId: IDS.operation, expectedUpdatedAt: UPDATED,
    entityId: IDS.client, payload: { stage: 'active' }
  }), /valid active Client lifecycle stage/i);
});

test('Talent Management output is read-only and reconciliation status is accepted', () => {
  const value = workspace('talent_management');
  value.clients[0].contacts[0].portalAccessStatus = 'needs_reconciliation';
  value.clients[0].activity = [{
    eventType: 'client_pipeline_update_client',
    label: 'Client details updated',
    createdAt: UPDATED
  }];
  const output = service.publicPayload(value);
  assert.equal(output.clients[0].canEdit, false);
  assert.equal(output.clients[0].contacts[0].isPrimary, true);
  assert.equal(output.clients[0].contacts[0].portalAccessStatus, 'needs_reconciliation');
  assert.equal(output.clients[0].contacts[0].pendingPortalAccess, null);
  assert.deepEqual(output.clients[0].activity, value.clients[0].activity);
  const activityLeak = workspace('talent_management');
  activityLeak.clients[0].activity = [{
    eventType: 'client_pipeline_update_client', label: 'Client details updated',
    createdAt: UPDATED, afterValue: { companyName: 'Private' }
  }];
  assert.throws(() => service.publicPayload(activityLeak), /invalid response/i);
  const improper = workspace('talent_management');
  improper.clients[0].canEdit = true;
  assert.throws(() => service.publicPayload(improper), /invalid response/i);
});

test('pending portal takeover intent is narrowly projected only to mutating roles', () => {
  const adminValue = workspace('admin');
  adminValue.clients[0].contacts[0].portalAccessStatus = 'invite_pending';
  adminValue.clients[0].contacts[0].pendingPortalAccess = {
    action: 'activate', email: 'persisted@example.test', portalRole: 'client_billing'
  };
  const adminOutput = service.publicPayload(adminValue);
  assert.deepEqual(adminOutput.clients[0].contacts[0].pendingPortalAccess, {
    action: 'activate', email: 'persisted@example.test', portalRole: 'client_billing'
  });

  const talentLeak = workspace('talent_management');
  talentLeak.clients[0].contacts[0].pendingPortalAccess = {
    action: 'change_email', email: 'private-new@example.test', portalRole: null
  };
  assert.throws(() => service.publicPayload(talentLeak), /invalid response/i);

  const malformed = workspace('admin');
  malformed.clients[0].contacts[0].pendingPortalAccess = {
    action: 'activate', email: 'persisted@example.test', portalRole: 'admin'
  };
  assert.throws(() => service.publicPayload(malformed), /invalid response/i);
});

test('GET derives actor scope and calls only the service-only workspace RPC', async t => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/auth/v1/user')) return { ok: true, status: 200, json: async () => ({ id: IDS.actor }) };
    return { ok: true, status: 200, text: async () => JSON.stringify(workspace()) };
  };
  t.after(() => { global.fetch = originalFetch; });
  const result = await service.handler({ httpMethod: 'GET', headers: { authorization: 'Bearer token' }, queryStringParameters: {} });
  assert.equal(result.statusCode, 200);
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /\/rest\/v1\/rpc\/get_client_pipeline_workspace$/);
  assert.deepEqual(JSON.parse(calls[1].options.body), { p_actor_user_id: IDS.actor });
});

test('POST passes only the fixed RPC contract and returns a compact allowlisted result', async t => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/auth/v1/user')) return { ok: true, status: 200, json: async () => ({ id: IDS.actor }) };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ action: 'update_client', clientId: IDS.client, updatedAt: UPDATED })
    };
  };
  t.after(() => { global.fetch = originalFetch; });
  const result = await service.handler({
    httpMethod: 'POST', headers: { authorization: 'Bearer token' }, queryStringParameters: {},
    body: JSON.stringify({
      action: 'update_client', requestId: IDS.operation, expectedUpdatedAt: UPDATED,
      entityId: IDS.client, payload: { companyName: 'Updated Client' }
    })
  });
  assert.equal(result.statusCode, 200);
  const rpc = JSON.parse(calls[1].options.body);
  assert.deepEqual(Object.keys(rpc), [
    'p_actor_user_id', 'p_request_id', 'p_action', 'p_expected_updated_at',
    'p_entity_id', 'p_parent_id', 'p_payload'
  ]);
  assert.equal(rpc.p_actor_user_id, IDS.actor);
  assert.deepEqual(JSON.parse(result.body), { action: 'update_client', clientId: IDS.client, updatedAt: UPDATED });
});

test('raw database failures are absent from the Client response and logs', async t => {
  const originalFetch = global.fetch;
  const originalConsoleError = console.error;
  const privateDetail = 'private-client@example.test changed after SECRET_INTERNAL_NOTE';
  const logs = [];
  global.fetch = async url => {
    if (String(url).endsWith('/auth/v1/user')) {
      return { ok: true, status: 200, json: async () => ({ id: IDS.actor }) };
    }
    return {
      ok: false,
      status: 409,
      text: async () => JSON.stringify({ code: 'P0001', message: privateDetail })
    };
  };
  console.error = (...values) => { logs.push(values); };
  t.after(() => {
    global.fetch = originalFetch;
    console.error = originalConsoleError;
  });

  const result = await service.handler({
    httpMethod: 'GET', headers: { authorization: 'Bearer token' }, queryStringParameters: {}
  });
  const serialized = JSON.stringify({ body: JSON.parse(result.body), logs });
  assert.equal(result.statusCode, 409);
  assert.equal(JSON.parse(result.body).code, 'stale_client');
  assert.equal(serialized.includes(privateDetail), false);
  assert.equal(serialized.includes('private-client@example.test'), false);
});
