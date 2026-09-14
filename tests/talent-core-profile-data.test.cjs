'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../operations/talent-core-profile-data.js'), 'utf8');
const applicantId = '22222222-2222-4222-8222-222222222222';
const organizationId = '33333333-3333-4333-8333-333333333333';
const userId = '11111111-1111-4111-8111-111111111111';
const stamp = '2026-09-14T13:00:00.000001+00:00';
const clone = value => JSON.parse(JSON.stringify(value));
const initial = () => ({ id: applicantId, organization_id: organizationId, updated_at: stamp, archived_at: null,
  full_name: 'Rivera, Ana', email: 'ana@example.com', phone: null, timezone: 'Asia/Manila', country: 'Philippines', city: null, location: null,
  status: 'in_review', portal_login_email: 'private-login@example.com', verified_skills: ['Bookkeeping'] });

function setup(overrides = {}) {
  const state = { record: { ...initial(), ...overrides }, calls: [], failRead: false, error: null, afterRead: null, afterUpdate: null, writes: 0, events: [] };
  let context;
  const client = {
    from(table) {
      const call = { table, filters: [] };
      const query = {
        select(fields) { call.fields = fields; return this; },
        update(payload) { call.updates = clone(payload); return this; },
        eq(key, value) { call.filters.push([key, value]); return this; },
        is(key, value) { call.filters.push([key, value]); return this; },
        async maybeSingle() {
          state.calls.push(clone(call));
          const matches = call.filters.every(([key, value]) => state.record[key] === value);
          if (call.updates) {
            if (state.error) return { data: null, error: state.error };
            if (!matches) return { data: null, error: null };
            state.writes += 1;
            Object.assign(state.record, call.updates, { updated_at: `2026-09-14T13:00:01.${String(state.writes).padStart(6, '0')}+00:00` });
            const result = clone(state.record);
            state.afterUpdate?.(context);
            return { data: result, error: null };
          }
          const result = clone(state.record);
          state.afterRead?.(context);
          return { data: state.failRead || !matches ? null : result, error: state.failRead ? { code: '503' } : null };
        }
      };
      return query;
    }
  };
  context = vm.createContext({ soroSupabase: client, soroCurrentAccess: { user_id: userId, organization_id: organizationId, role: 'talent_management', active: true, must_change_password: false },
    CustomEvent: class CustomEvent { constructor(type, options) { this.type = type; this.detail = options?.detail; } }, dispatchEvent: event => state.events.push(event) });
  vm.runInContext(source, context);
  const api = context.soroTalentCoreProfileData;
  const values = (record, additions = {}) => Object.fromEntries(api.FIELDS.map(key => [key, Object.hasOwn(additions, key) ? additions[key] : record[key]]));
  return { api, context, state, values };
}

test('load requests only core fields and prevents private extras entering the editor snapshot', async () => {
  const { api, state } = setup();
  const snapshot = await api.load(applicantId);
  assert.equal(state.calls[0].table, 'applicants');
  assert.equal(state.calls[0].fields, 'id,organization_id,updated_at,full_name,email,phone,timezone,country,city,location');
  assert.deepEqual(state.calls[0].filters, [['organization_id', organizationId], ['id', applicantId], ['archived_at', null]]);
  assert.equal(snapshot.record.portal_login_email, undefined);
  assert.equal(snapshot.record.verified_skills, undefined);
  assert.equal(Object.isFrozen(snapshot.record), true);
  assert.equal(Object.isFrozen(snapshot), true);
});

test('core completion matches both supported location paths and keeps partial fields missing', () => {
  const { api } = setup();
  assert.deepEqual(clone(api.missingFields(initial())), ['phone', 'location']);
  assert.deepEqual(clone(api.missingFields({ ...initial(), phone: ' +63 912 345 6789 ', city: 'Cebu' })), []);
  assert.deepEqual(clone(api.missingFields({ ...initial(), phone: '09123456789', location: 'Cebu, Philippines', country: null })), []);
  assert.deepEqual(clone(api.missingFields({ full_name: ' ', email: '', phone: null, timezone: '', location: '', country: 'Philippines' })), ['full_name', 'email', 'phone', 'timezone', 'location']);
  assert.deepEqual(clone(api.missingFields({ ...initial(), city: 'Cebu', timezone: null })), ['phone', 'timezone']);
});

test('save changes only approved core fields and reloads the timestamp after deferral-trigger completion', async () => {
  const { api, state, values } = setup({ location: 'Historical location' });
  const snapshot = await api.load(applicantId);
  state.afterUpdate = () => { state.record.updated_at = '2026-09-14T13:00:02.000003+00:00'; };
  const updated = await api.save(applicantId, snapshot, values(snapshot.record, { phone: ' +63 912 345 6789 ', city: ' Cebu ' }));
  assert.deepEqual(state.calls[1].updates, { phone: '+63 912 345 6789', city: 'Cebu' });
  assert.deepEqual(state.calls[1].filters, [['organization_id', organizationId], ['id', applicantId], ['updated_at', stamp], ['archived_at', null]]);
  assert.equal(state.calls.length, 3);
  assert.equal(updated.record.updated_at, '2026-09-14T13:00:02.000003+00:00');
  assert.equal(updated.record.location, 'Historical location');
  assert.equal(state.record.portal_login_email, 'private-login@example.com');
  assert.deepEqual(state.record.verified_skills, ['Bookkeeping']);
  assert.deepEqual(state.events.map(event => [event.type, event.detail.applicantId]), [['soro:talent-core-profile-updated', applicantId]]);
});

test('partial save persists available information without claiming completion or changing review stage', async () => {
  const { api, state, values } = setup();
  const snapshot = await api.load(applicantId);
  const saved = await api.save(applicantId, snapshot, values(snapshot.record, { city: 'Davao', phone: '', timezone: '' }));
  assert.deepEqual(clone(api.missingFields(saved.record)), ['phone', 'timezone']);
  assert.equal(state.record.status, 'in_review');
  assert.equal(saved.record.phone, null);
  assert.equal(saved.record.timezone, null);
});

test('stale or archived profiles cannot be overwritten', async () => {
  for (const changes of [{ updated_at: '2026-09-14T13:01:00Z', phone: 'Newer phone' }, { archived_at: '2026-09-14T13:01:00Z' }]) {
    const { api, state, values } = setup();
    const snapshot = await api.load(applicantId);
    Object.assign(state.record, changes);
    await assert.rejects(api.save(applicantId, snapshot, values(snapshot.record, { phone: 'Old phone' })), /may have changed/);
    assert.equal(state.writes, 0);
    assert.equal(state.events.length, 0);
  }
});

test('roles outside Admin and Talent Management never read or write core fields', async () => {
  for (const role of ['sales', 'sales_management', 'billing', 'virtual_assistant', 'client_admin']) {
    const { api, state, context } = setup();
    context.soroCurrentAccess.role = role;
    assert.equal(api.authorized(), false);
    await assert.rejects(api.load(applicantId), /review access is unavailable/);
    assert.equal(state.calls.length, 0);
  }
  for (const changes of [{ active: false }, { must_change_password: true }, { organization_id: 'invalid' }]) {
    const { api, context } = setup();
    Object.assign(context.soroCurrentAccess, changes);
    assert.equal(api.authorized(), false);
  }
});

test('changed account scope rejects pending reads and loaded snapshots before writing', async () => {
  const pending = setup();
  pending.state.afterRead = context => { context.soroCurrentAccess.role = 'sales'; };
  await assert.rejects(pending.api.load(applicantId), /review access changed/);

  for (const mutate of [context => { context.soroCurrentAccess.user_id = applicantId; }, context => { context.soroSupabase = {}; }]) {
    const { api, state, context, values } = setup();
    const snapshot = await api.load(applicantId);
    mutate(context);
    await assert.rejects(api.save(applicantId, snapshot, values(snapshot.record)), /Reopen this core profile/);
    assert.equal(state.writes, 0);
  }
});

test('forged snapshots, field injection and invalid values are rejected before any write', async () => {
  const { api, state, values } = setup();
  const snapshot = await api.load(applicantId), valid = values(snapshot.record);
  await assert.rejects(api.save(applicantId, clone(snapshot), valid), /Reopen this core profile/);
  const invalid = [
    { ...valid, organization_id: userId }, { ...valid, status: 'bench_ready' }, { ...valid, location: 'Invented legacy location' },
    { ...valid, full_name: '' }, { ...valid, email: 'not an email' }, { ...valid, email: 'a@example.com\nBcc:x@example.com' },
    { ...valid, phone: 12345 }, { ...valid, full_name: 'x'.repeat(181) }, { ...valid, timezone: '\u0000' }
  ];
  for (const input of invalid) await assert.rejects(api.save(applicantId, snapshot, input));
  assert.equal(state.writes, 0);
  assert.equal(state.calls.length, 1);
});

test('duplicate email error is actionable and a saved-but-unrefreshed result is reported accurately', async () => {
  const duplicate = setup(), snapshot = await duplicate.api.load(applicantId);
  duplicate.state.error = { code: '23505', message: 'PRIVATE SQL DETAILS' };
  await assert.rejects(duplicate.api.save(applicantId, snapshot, duplicate.values(snapshot.record, { email: 'new@example.com' })), error => {
    assert.match(error.message, /already used by another Talent/);
    assert.doesNotMatch(error.message, /PRIVATE/);
    return true;
  });

  const refresh = setup(), before = await refresh.api.load(applicantId);
  refresh.state.afterUpdate = () => { refresh.state.failRead = true; };
  await assert.rejects(refresh.api.save(applicantId, before, refresh.values(before.record, { city: 'Cebu' })), error => {
    assert.equal(error.saved, true);
    assert.match(error.message, /was saved/);
    return true;
  });
  assert.equal(refresh.state.record.city, 'Cebu');
  assert.equal(refresh.state.writes, 1);
});

test('unchanged save does not create an update and still fetches the current record', async () => {
  const { api, state, values } = setup();
  const snapshot = await api.load(applicantId);
  state.record.phone = 'New phone from another reviewer';
  const saved = await api.save(applicantId, snapshot, values(snapshot.record));
  assert.equal(state.writes, 0);
  assert.equal(saved.record.phone, 'New phone from another reviewer');
});
