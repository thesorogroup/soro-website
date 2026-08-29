const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '20260829_021_client_profile_membership.sql'),
  'utf8'
);

process.env.SUPABASE_URL = 'https://client-profile-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
const backend = require('../netlify/functions/client-profile.js');

const userId = '11111111-1111-4111-8111-111111111111';
const organizationId = '22222222-2222-4222-8222-222222222222';
const clientId = '33333333-3333-4333-8333-333333333333';
const contactId = '44444444-4444-4444-8444-444444444444';

function response(data, status = 200) {
  return new Response(data === undefined ? '' : JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function event(method, body) {
  return {
    httpMethod: method,
    headers: { authorization: 'Bearer signed-in-client-token' },
    body: body === undefined ? undefined : JSON.stringify(body)
  };
}

function installProfileFetch(t, { role = 'client_admin', access = true, membership = true, client = true, contact = true } = {}) {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const value = String(url);
    calls.push({ url: value, options });
    if (value.endsWith('/auth/v1/user')) return response({ id: userId });
    if (value.includes('/rest/v1/platform_users?')) {
      return response(access ? [{ id: userId, organization_id: organizationId, role }] : []);
    }
    if (value.includes('/rest/v1/client_portal_memberships?')) {
      return response(membership ? [{
        user_id: userId,
        organization_id: organizationId,
        client_id: clientId,
        client_contact_id: contactId
      }] : []);
    }
    if (value.includes('/rest/v1/rpc/update_client_portal_profile')) {
      const body = JSON.parse(options.body);
      return response([
        ...Object.keys(body.p_contact_updates).map(key => key === 'full_name' ? 'contact.fullName' : 'contact.phone'),
        ...Object.keys(body.p_company_updates).map(key => ({
          address_line_1: 'company.addressLine1', address_line_2: 'company.addressLine2', city: 'company.city',
          state_region: 'company.stateRegion', postal_code: 'company.postalCode', country: 'company.country',
          company_phone: 'company.phone', website: 'company.website'
        })[key])
      ]);
    }
    if (value.includes('/rest/v1/clients?')) {
      return response(client ? [{
        company_name: 'Haven & Co.',
        industry: 'Legal services',
        address_line_1: '100 Main Street',
        address_line_2: null,
        city: 'Dallas',
        state_region: 'Texas',
        postal_code: '75001',
        country: 'United States',
        company_phone: '+1 214 555 0100',
        website: 'https://haven.example/',
        lifecycle_stage: 'active',
        sales_owner_id: 'do-not-return'
      }] : []);
    }
    if (value.includes('/rest/v1/client_contacts?')) {
      return response(contact ? [{
        full_name: 'Avery Parker',
        phone: '+1 214 555 0199',
        email: 'do-not-return@example.com',
        contact_role: 'primary'
      }] : []);
    }
    throw new Error(`Unexpected fetch: ${value}`);
  };
  t.after(() => { global.fetch = originalFetch; });
  return calls;
}

function bodyOf(result) {
  return JSON.parse(result.body);
}

test('021 creates one strongly-linked Client membership per portal user', () => {
  assert.match(migration, /create table if not exists public\.client_portal_memberships[\s\S]*user_id uuid primary key/i);
  assert.match(migration, /foreign key \(user_id, organization_id\)[\s\S]*references public\.platform_users \(id, organization_id\)/i);
  assert.match(migration, /foreign key \(client_id, organization_id\)[\s\S]*references public\.clients \(id, organization_id\)/i);
  assert.match(migration, /foreign key \(client_contact_id, client_id\)[\s\S]*references public\.client_contacts \(id, client_id\)/i);
  assert.match(migration, /client_contact_id uuid not null unique/i);
  assert.match(migration, /access_role not in[\s\S]*client_admin[\s\S]*client_reviewer[\s\S]*client_billing/i);
});

test('021 never infers Client authorization from matching email addresses', () => {
  assert.match(migration, /do not infer membership from contact\/auth email/i);
  assert.doesNotMatch(migration, /join auth\.users|candidate_matches|lower\(btrim\(contact\.email\)\)/i);
  assert.doesNotMatch(migration, /insert into public\.client_portal_memberships/i, 'Existing accounts require explicit Administrator reconciliation.');
});

test('021 leaves Client base tables internal-only and membership writes server-only', () => {
  assert.doesNotMatch(migration, /create policy[\s\S]{0,160}on public\.(?:clients|client_contacts)/i);
  assert.match(migration, /revoke all on table public\.client_portal_memberships from authenticated/i);
  assert.match(migration, /grant select on table public\.client_portal_memberships to service_role/i);
  assert.doesNotMatch(migration, /grant select on table public\.client_portal_memberships to authenticated/i);
  assert.match(migration, /user_id = auth\.uid\(\)[\s\S]*and active = true[\s\S]*private\.current_soro_role\(\)/i);
  assert.match(migration, /revoke all on function public\.update_client_portal_profile\(uuid, jsonb, jsonb\) from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.update_client_portal_profile\(uuid, jsonb, jsonb\) to service_role/i);
});

test('021 withholds the effective role and organization until Client membership is active', () => {
  const roleHelper = migration.match(/create or replace function private\.current_soro_role\(\)[\s\S]*?\$\$;/i)?.[0] || '';
  assert.match(roleHelper, /access\.active = true[\s\S]*access\.must_change_password = false/i);
  assert.match(roleHelper, /public\.client_portal_memberships[\s\S]*membership\.user_id = access\.id[\s\S]*membership\.active = true/i);
  assert.match(roleHelper, /client\.archived_at is null[\s\S]*contact\.active = true/i);
  assert.match(roleHelper, /applicant\.portal_access_status = 'active'/i, 'The existing Talent/VA gate must be preserved.');
  assert.match(roleHelper, /access\.role not in \([\s\S]*client_admin[\s\S]*client_reviewer[\s\S]*client_billing[\s\S]*\)\s*or exists/i, 'Non-Client internal roles must retain their existing role path.');
  const organizationHelper = migration.match(/create or replace function private\.current_soro_organization_id\(\)[\s\S]*?\$\$;/i)?.[0] || '';
  assert.match(organizationHelper, /private\.current_soro_role\(\) is not null/i);
  assert.match(migration, /after update of role, active on public\.platform_users[\s\S]*deactivate_client_membership_on_access_change/i);
  assert.match(migration, /update public\.client_portal_memberships[\s\S]*set active = false/i);
});

test('021 audits only actor, entity, action, and changed field names', () => {
  const start = migration.indexOf('insert into public.audit_events');
  assert.notEqual(start, -1);
  const auditBlock = migration.slice(start, start + 900);
  assert.match(auditBlock, /actor_user_id[\s\S]*entity_type[\s\S]*entity_id[\s\S]*event_type/i);
  assert.match(auditBlock, /jsonb_build_object\('changed_fields', to_jsonb\(changed_fields\)\)/i);
  assert.doesNotMatch(auditBlock, /before_value|contact_record|client_record|portal_login_email|auth_account/i);
});

test('GET returns only the safe projection and Client Admin edit permissions', async t => {
  const calls = installProfileFetch(t);
  const result = await backend.handler(event('GET'));
  const body = bodyOf(result);

  assert.equal(result.statusCode, 200);
  assert.deepEqual(body.profile.contact, { fullName: 'Avery Parker', phone: '+1 214 555 0199' });
  assert.equal(body.profile.company.name, 'Haven & Co.');
  assert.equal(body.profile.company.industry, 'Legal services');
  assert.equal(body.permissions.canEditCompany, true);
  assert.ok(body.permissions.editableFields.includes('company.website'));
  const serialized = JSON.stringify(body);
  ['do-not-return@example.com', 'sales_owner_id', 'lifecycle_stage', userId, clientId, contactId, 'client_admin'].forEach(secret => {
    assert.equal(serialized.includes(secret), false, `Response leaked ${secret}.`);
  });
  assert.match(calls.find(call => call.url.includes('/rest/v1/platform_users?')).url, /active=is\.true&must_change_password=is\.false/);
  assert.match(calls.find(call => call.url.includes('/rest/v1/client_portal_memberships?')).url, /organization_id=eq\./);
});

test('Client Reviewer may update only their own name and phone', async t => {
  const calls = installProfileFetch(t, { role: 'client_reviewer' });
  const result = await backend.handler(event('PATCH', {
    contact: { fullName: '  Avery   Jordan Parker  ', phone: ' +1 214 555 0111 ' }
  }));
  const body = bodyOf(result);

  assert.equal(result.statusCode, 200);
  assert.equal(body.permissions.canEditCompany, false);
  assert.deepEqual(body.permissions.editableFields, ['contact.fullName', 'contact.phone']);
  const rpc = calls.find(call => call.url.includes('/rpc/update_client_portal_profile'));
  const rpcBody = JSON.parse(rpc.options.body);
  assert.deepEqual(rpcBody, {
    p_actor_user_id: userId,
    p_contact_updates: { full_name: 'Avery Jordan Parker', phone: '+1 214 555 0111' },
    p_company_updates: {}
  });
});

test('Client Reviewer cannot update company fields', async t => {
  const calls = installProfileFetch(t, { role: 'client_reviewer' });
  const result = await backend.handler(event('PATCH', { company: { city: 'Dallas' } }));
  const body = bodyOf(result);

  assert.equal(result.statusCode, 403);
  assert.equal(body.code, 'company_edit_forbidden');
  assert.equal(calls.some(call => call.url.includes('/rpc/update_client_portal_profile')), false);
});

test('Client Admin company patch is allowlisted and normalizes the website', async t => {
  const calls = installProfileFetch(t, { role: 'client_admin' });
  const result = await backend.handler(event('PATCH', {
    company: {
      addressLine1: ' 500 Elm Street ',
      city: ' Dallas ',
      stateRegion: ' Texas ',
      postalCode: ' 75201 ',
      country: ' United States ',
      phone: ' +1 214 555 0102 ',
      website: 'haven.example/contact'
    }
  }));

  assert.equal(result.statusCode, 200);
  const rpc = calls.find(call => call.url.includes('/rpc/update_client_portal_profile'));
  const rpcBody = JSON.parse(rpc.options.body);
  assert.deepEqual(rpcBody.p_contact_updates, {});
  assert.deepEqual(rpcBody.p_company_updates, {
    address_line_1: '500 Elm Street',
    city: 'Dallas',
    state_region: 'Texas',
    postal_code: '75201',
    country: 'United States',
    company_phone: '+1 214 555 0102',
    website: 'https://haven.example/contact'
  });
});

test('immutable and unknown fields are rejected rather than ignored', async t => {
  installProfileFetch(t, { role: 'client_admin' });
  const result = await backend.handler(event('PATCH', {
    company: { name: 'Changed legal name' },
    role: 'admin'
  }));
  const body = bodyOf(result);

  assert.equal(result.statusCode, 400);
  assert.equal(body.code, 'protected_field');
  assert.throws(
    () => backend.normalizePatch({ company: { name: 'Changed legal name', industry: 'Changed industry' } }, 'client_admin'),
    error => error.code === 'protected_field'
  );
});

test('setup-required, inactive, or unlinked accounts fail closed', async t => {
  installProfileFetch(t, { access: false });
  const accessResult = await backend.handler(event('GET'));
  assert.equal(accessResult.statusCode, 403);
  assert.equal(bodyOf(accessResult).code, 'client_access_required');
});

test('an active Client role without exactly one active membership is denied', async t => {
  installProfileFetch(t, { membership: false });
  const result = await backend.handler(event('GET'));
  assert.equal(result.statusCode, 404);
  assert.equal(bodyOf(result).code, 'client_membership_not_found');
});

test('an archived Client or inactive contact is denied even with a membership', async t => {
  const originalFetch = global.fetch;
  installProfileFetch(t, { client: false });
  const archived = await backend.handler(event('GET'));
  assert.equal(archived.statusCode, 404);
  assert.equal(bodyOf(archived).code, 'client_profile_not_found');

  global.fetch = originalFetch;
  installProfileFetch(t, { contact: false });
  const inactiveContact = await backend.handler(event('GET'));
  assert.equal(inactiveContact.statusCode, 404);
  assert.equal(bodyOf(inactiveContact).code, 'client_contact_not_found');
});

test('non-Client internal roles are not admitted to the Client profile endpoint', async t => {
  installProfileFetch(t, { role: 'sales' });
  const result = await backend.handler(event('GET'));
  assert.equal(result.statusCode, 403);
  assert.equal(bodyOf(result).code, 'client_access_required');
});

test('unsupported methods and missing authentication fail closed', async () => {
  const unsupported = await backend.handler({ httpMethod: 'POST', headers: {} });
  assert.equal(unsupported.statusCode, 405);
  assert.equal(unsupported.headers.Allow, 'GET, PATCH');

  const unauthenticated = await backend.handler({ httpMethod: 'GET', headers: {} });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(bodyOf(unauthenticated).code, 'authentication_required');
});
