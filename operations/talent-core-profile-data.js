/* Core profile fields use the existing authenticated staff/RLS editing path. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.soroTalentCoreProfileData = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const LIMITS = Object.freeze({ full_name: 180, email: 254, phone: 80, timezone: 100, country: 120, city: 160 });
  const FIELDS = Object.freeze(Object.keys(LIMITS));
  const READ_FIELDS = 'id,organization_id,updated_at,full_name,email,phone,timezone,country,city,location';
  const LABELS = { full_name: 'Full name', email: 'Contact email', phone: 'Phone number', timezone: 'Time zone', country: 'Country', city: 'City' };
  const snapshots = new WeakMap();
  const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
  const present = value => typeof value === 'string' && Boolean(value.trim());

  function scope() {
    const access = root.soroCurrentAccess || {};
    return JSON.stringify([access.user_id, access.organization_id, access.role, access.active, access.must_change_password]);
  }
  function authorized() {
    const access = root.soroCurrentAccess || {};
    return ['admin', 'talent_management'].includes(access.role) && uuid(access.user_id) && uuid(access.organization_id)
      && access.active !== false && access.must_change_password !== true;
  }
  function session(applicantId) {
    if (!authorized() || !uuid(applicantId) || !root.soroSupabase) throw new Error('Your review access is unavailable. Sign in again.');
    const client = root.soroSupabase, captured = scope(), organizationId = root.soroCurrentAccess.organization_id;
    const check = () => {
      if (!authorized() || root.soroSupabase !== client || scope() !== captured) throw new Error('Your review access changed. Reopen this profile.');
    };
    return { client, organizationId, captured, applicantId, check };
  }
  function missingFields(record = {}) {
    // Keep this aligned with talent_review_checklist_json (migration 072).
    const missing = ['full_name', 'email', 'phone', 'timezone'].filter(key => !present(record[key]));
    if (!present(record.location) && !(present(record.country) && present(record.city))) missing.push('location');
    return missing;
  }
  function normalizeValues(values) {
    if (!values || typeof values !== 'object' || Array.isArray(values)
      || Object.keys(values).length !== FIELDS.length || FIELDS.some(key => !Object.hasOwn(values, key))) {
      throw new Error('Only the core profile fields can be saved here.');
    }
    const normalized = {};
    for (const key of FIELDS) {
      const value = values[key];
      if (value !== null && typeof value !== 'string') throw new Error(`${LABELS[key]} must be text.`);
      if (typeof value === 'string' && /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${LABELS[key]} must be a single line of text.`);
      const text = String(value ?? '').trim();
      if (text.length > LIMITS[key]) throw new Error(`Keep ${LABELS[key].toLowerCase()} to ${LIMITS[key]} characters or fewer.`);
      if (['full_name', 'email'].includes(key) && !text) throw new Error(`Enter ${LABELS[key].toLowerCase()}.`);
      normalized[key] = text || null;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized.email)) throw new Error('Enter a valid contact email address.');
    return normalized;
  }
  function snapshotFrom(data, context) {
    if (!data || data.id !== context.applicantId || data.organization_id !== context.organizationId
      || typeof data.updated_at !== 'string' || !Number.isFinite(Date.parse(data.updated_at))) {
      throw new Error('The core profile could not be loaded. Reopen it and try again.');
    }
    const record = { id: data.id, organization_id: data.organization_id, updated_at: data.updated_at };
    for (const key of [...FIELDS, 'location']) {
      if (data[key] !== null && data[key] !== undefined && typeof data[key] !== 'string') throw new Error('The core profile returned an invalid field.');
      record[key] = data[key] ?? null;
    }
    const snapshot = Object.freeze({ record: Object.freeze(record), scope: context.captured });
    snapshots.set(snapshot, { client: context.client, record });
    return snapshot;
  }
  async function read(context) {
    const result = await context.client.from('applicants').select(READ_FIELDS)
      .eq('organization_id', context.organizationId).eq('id', context.applicantId).is('archived_at', null).maybeSingle();
    context.check();
    if (result.error || !result.data) throw new Error('The core profile could not be loaded. Reopen it and try again.');
    return snapshotFrom(result.data, context);
  }
  async function load(applicantId) {
    return read(session(applicantId));
  }
  async function save(applicantId, snapshot, values) {
    const context = session(applicantId), trusted = snapshots.get(snapshot);
    if (!trusted || trusted.client !== context.client || snapshot.scope !== context.captured
      || trusted.record.id !== applicantId || trusted.record.organization_id !== context.organizationId) {
      throw new Error('Reopen this core profile before saving.');
    }
    const normalized = normalizeValues(values), updates = {};
    for (const key of FIELDS) {
      if (normalized[key] !== trusted.record[key]) updates[key] = normalized[key];
    }
    context.check();
    if (!Object.keys(updates).length) return read(context);
    const result = await context.client.from('applicants').update(updates)
      .eq('organization_id', context.organizationId).eq('id', applicantId)
      .eq('updated_at', trusted.record.updated_at).is('archived_at', null).select(READ_FIELDS).maybeSingle();
    context.check();
    if (result.error?.code === '23505') throw new Error('That contact email is already used by another Talent profile. Check the address and try again.');
    if (result.error || !result.data) throw new Error('This profile may have changed. Reopen it before saving again; newer information has not been overwritten.');
    snapshotFrom(result.data, context);
    // Completing a deferred core item can update the timestamp in an AFTER
    // trigger. Read the committed record so another edit uses its latest value.
    let updated;
    try { updated = await read(context); }
    catch (error) {
      context.check();
      const refreshError = new Error('The core profile was saved, but its latest details could not be refreshed. Reload the queue before editing again.');
      refreshError.saved = true;
      throw refreshError;
    }
    if (typeof root.CustomEvent === 'function') root.dispatchEvent?.(new root.CustomEvent('soro:talent-core-profile-updated', { detail: { applicantId } }));
    return updated;
  }
  return Object.freeze({ authorized, scope, load, save, missingFields, normalizeValues, LIMITS, FIELDS });
}));
