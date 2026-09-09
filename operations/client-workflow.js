/* Sales and Admin Client Pipeline, guided intake, and Client Hub approval workflow. */
(function attachSoroClientWorkflow(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SoroClientWorkflow = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createSoroClientWorkflow(root) {
  'use strict';

  const ENDPOINT = '/.netlify/functions/client-pipeline';
  const PORTAL_ACCESS_ENDPOINT = '/.netlify/functions/client-portal-access';
  const AUTHORIZED_ROLES = new Set(['admin', 'sales', 'sales_management', 'talent_management']);
  const EDIT_ROLES = new Set(['admin', 'sales', 'sales_management']);
  const OWNER_ASSIGNMENT_ROLES = new Set(['admin', 'sales_management']);
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const PORTAL_STATUSES = new Set(['not_invited', 'invite_pending', 'active', 'suspended', 'delivery_failed', 'needs_reconciliation']);
  const PORTAL_ACTIONS = new Set(['activate', 'resend_invitation', 'change_email', 'send_password_reset', 'suspend_access', 'reactivate_access']);
  const CLIENT_PORTAL_ROLES = new Set(['client_admin', 'client_reviewer', 'client_billing']);
  const MUTATION_RETRY_TTL_MS = 15 * 60 * 1000;
  const MUTATION_RETRY_LIMIT = 40;
  const PIPELINE_STEPS = Object.freeze([
    ['request', 'Hiring request'],
    ['shortlist', 'Shortlist'],
    ['client_review', 'Client review'],
    ['interview', 'Interview'],
    ['selection', 'Selection'],
    ['placement', 'Placement'],
    ['onboarding', 'Onboarding']
  ]);

  let mountedRoot = null;
  let viewerRole = '';
  let activeAdapter = null;
  let clients = [];
  let owners = [];
  let selectedClientId = '';
  let phase = 'loading';
  let busy = false;
  let feedback = Object.freeze({ tone: '', message: '' });
  let requestVersion = 0;
  let editorKind = '';
  let editorRequestId = '';

  function text(value, max = 240) {
    return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]));
  }

  function normalizedRole(value) {
    return text(value, 50).toLowerCase();
  }

  function canOpenForRole(value) {
    return AUTHORIZED_ROLES.has(normalizedRole(value));
  }

  function canEditForRole(value = viewerRole) {
    return EDIT_ROLES.has(normalizedRole(value));
  }

  function canAssignOwner(value = viewerRole) {
    return OWNER_ASSIGNMENT_ROLES.has(normalizedRole(value));
  }

  function titleCase(value) {
    return text(value, 80).replace(/[_-]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
  }

  function list(value, maxItems = 20, maxLength = 100) {
    const source = Array.isArray(value)
      ? value
      : String(value ?? '').split(/[\n,]/);
    const seen = new Set();
    return source.slice(0, maxItems).map(item => text(typeof item === 'object' ? item?.name || item?.label : item, maxLength)).filter(item => {
      const key = item.toLocaleLowerCase();
      if (!item || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function positiveInteger(value, fallback = 1) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : fallback;
  }

  function safeDate(value) {
    const normalized = text(value, 30);
    return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : '';
  }

  function safeEmail(value) {
    const normalized = text(value, 254).toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : '';
  }

  function currentUserName() {
    const access = root?.soroCurrentAccess || {};
    return text(access.displayName || access.display_name || access.fullName || access.full_name || access.name || access.email, 120) || 'Current Sales owner';
  }

  function currentUserId() {
    const access = root?.soroCurrentAccess || {};
    return text(access.userId || access.user_id || access.id || access.employeeId || access.employee_id, 80) || 'current-user';
  }

  function normalizeOwner(source) {
    if (!source || typeof source !== 'object') return null;
    const id = text(source.id || source.userId || source.user_id || source.employeeId || source.employee_id, 80);
    const name = text(source.name || source.displayName || source.display_name || source.fullName || source.full_name, 120);
    return id && name ? Object.freeze({ id, name, active: source.active !== false, current: source.current === true }) : null;
  }

  function normalizeActivity(source) {
    if (!source || typeof source !== 'object') return null;
    const label = text(source.label || source.title || source.message, 240);
    if (!label) return null;
    const timestamp = text(source.timestamp || source.createdAt || source.created_at, 80);
    return Object.freeze({
      label,
      detail: text(source.detail || source.description, 300),
      timestamp: timestamp && Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp).toISOString() : ''
    });
  }

  function normalizeHiringRequest(source) {
    if (!source || typeof source !== 'object') return null;
    const roleTitle = text(source.roleTitle || source.role_title || source.title, 160);
    if (!roleTitle) return null;
    const requiredFields = source.requiredFields && typeof source.requiredFields === 'object'
      ? source.requiredFields
      : (source.required_fields && typeof source.required_fields === 'object' ? source.required_fields : {});
    const rawStatus = text(source.status, 40).toLowerCase();
    const rawStep = text(source.progressStep || source.progress_step, 40).toLowerCase();
    const statusStep = ({
      draft: 'request', discovery: 'request', open: 'request', sourcing: 'shortlist',
      shortlisting: 'shortlist', client_review: 'client_review', interviewing: 'interview',
      selection_pending: 'selection', placement_pending: 'placement', partially_filled: 'placement',
      filled: 'onboarding'
    })[rawStatus] || 'request';
    const progressStep = PIPELINE_STEPS.some(([key]) => key === rawStep) ? rawStep : statusStep;
    function optionalCount(...values) {
      const raw = values.find(value => value !== undefined && value !== null && value !== '');
      if (raw === undefined) return null;
      const number = Number(raw);
      return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
    }
    return Object.freeze({
      id: text(source.id || source.hiringRequestId || source.hiring_request_id, 80) || `preview-request-${Date.now()}`,
      roleTitle,
      vaType: text(source.vaType || source.va_type || source.workArea || source.work_area || requiredFields.vaType || requiredFields.workArea, 120),
      seats: positiveInteger(source.seats || source.requestedCount || source.requested_count || source.numberOfTalent || source.number_of_talent, 1),
      skills: Object.freeze(list(source.skills || source.requiredSkills || source.required_skills || requiredFields.skills || requiredFields.requiredSkills)),
      schedule: text(source.schedule || source.scheduleSummary || source.schedule_summary || requiredFields.schedule, 180),
      timeZone: text(source.timeZone || source.timezone || source.time_zone || requiredFields.timeZone || requiredFields.timezone, 100),
      targetStartDate: safeDate(source.targetStartDate || source.target_start_date || source.startDate || source.start_date),
      status: rawStatus || 'discovery',
      progressStep,
      candidateCount: optionalCount(source.candidateCount, source.candidate_count),
      interviewCount: optionalCount(source.interviewCount, source.interview_count),
      placementCount: optionalCount(source.placementCount, source.placement_count),
      updatedAt: text(source.updatedAt || source.updated_at, 80)
    });
  }

  function normalizeClient(source, ownerCandidates = owners) {
    if (!source || typeof source !== 'object') return null;
    const company = source.company && typeof source.company === 'object' ? source.company : source;
    const contacts = Array.isArray(source.contacts) ? source.contacts : [];
    const activeContacts = contacts.filter(contact => contact && typeof contact === 'object' && contact.active !== false);
    const contactSource = source.primaryContact || source.primary_contact || source.contact
      || activeContacts.find(contact => contact.isPrimary === true || contact.is_primary === true)
      || activeContacts.find(contact => /primary/i.test(text(contact.contactRole || contact.contact_role || contact.role, 80)))
      || activeContacts[0]
      || {};
    const ownerId = text(source.salesOwnerId || source.sales_owner_id, 80);
    const owner = normalizeOwner(source.owner || source.salesOwner || source.sales_owner)
      || ownerCandidates.find(candidate => candidate.id === ownerId)
      || Object.freeze({ id: ownerId, name: ownerId ? 'Assigned Sales owner' : 'Unassigned', active: true, current: false });
    const companyName = text(company.name || source.companyName || source.company_name, 160);
    if (!companyName) return null;
    const requests = (source.hiringRequests || source.hiring_requests || source.requests || []).map(normalizeHiringRequest).filter(Boolean);
    const activity = (source.activity || []).map(normalizeActivity).filter(Boolean);
    const contactEmail = safeEmail(contactSource.email);
    const rawPortalStatus = text(source.portal?.status || source.portalStatus || source.portal_status || contactSource.portalAccessStatus || contactSource.portal_access_status, 40).toLowerCase();
    const pendingSource = source.portal?.pendingAccess || source.portal?.pending_access
      || contactSource.pendingPortalAccess || contactSource.pending_portal_access;
    const pendingAction = text(pendingSource?.action, 40).toLowerCase();
    const pendingEmail = safeEmail(pendingSource?.email);
    const pendingPortalRole = text(pendingSource?.portalRole || pendingSource?.portal_role, 40).toLowerCase();
    const pendingAccess = PORTAL_ACTIONS.has(pendingAction)
      && (pendingAction !== 'activate' || (pendingEmail && CLIENT_PORTAL_ROLES.has(pendingPortalRole)))
      && (pendingAction !== 'change_email' || pendingEmail)
      ? Object.freeze({
        action: pendingAction,
        email: pendingEmail,
        portalRole: CLIENT_PORTAL_ROLES.has(pendingPortalRole) ? pendingPortalRole : ''
      })
      : null;
    return Object.freeze({
      id: text(source.id || source.clientId || source.client_id, 80) || `preview-client-${Date.now()}`,
      company: Object.freeze({
        name: companyName,
        industry: text(company.industry, 120),
        website: text(company.website, 200),
        addressLine1: text(company.addressLine1 || company.address_line_1, 160),
        addressLine2: text(company.addressLine2 || company.address_line_2, 160),
        city: text(company.city, 100),
        stateRegion: text(company.stateRegion || company.state_region, 100),
        postalCode: text(company.postalCode || company.postal_code, 24),
        country: text(company.country, 100),
        phone: text(company.companyPhone || company.company_phone, 40)
      }),
      primaryContact: Object.freeze({
        id: text(contactSource.id || contactSource.contactId || contactSource.contact_id, 80),
        name: text(contactSource.name || contactSource.fullName || contactSource.full_name, 140),
        title: text(contactSource.title || contactSource.role || contactSource.contactRole || contactSource.contact_role, 120),
        email: contactEmail,
        phone: text(contactSource.phone, 60),
        updatedAt: text(contactSource.updatedAt || contactSource.updated_at, 80)
      }),
      owner,
      lifecycleStage: text(source.lifecycleStage || source.lifecycle_stage, 50).toLowerCase() || 'discovery',
      portal: Object.freeze({
        requested: source.portal?.requested === true || source.portalInviteRequested === true || source.portal_invite_requested === true || (Boolean(rawPortalStatus) && rawPortalStatus !== 'not_invited'),
        status: PORTAL_STATUSES.has(rawPortalStatus) ? rawPortalStatus : 'not_invited',
        email: safeEmail(source.portal?.email || source.portalEmail || contactSource.portalLoginEmail || contactSource.portal_login_email || contactEmail),
        lastSentAt: text(source.portal?.lastSentAt || source.portal?.last_sent_at || contactSource.portalInviteSentAt || contactSource.portal_invite_sent_at, 80),
        pendingAccess
      }),
      hiringRequests: Object.freeze(requests),
      activity: Object.freeze(activity),
      updatedAt: text(source.updatedAt || source.updated_at, 80)
    });
  }

  function normalizeBundle(input = {}) {
    const companyName = text(input.companyName, 160);
    const contactName = text(input.contactName, 140);
    const contactEmail = safeEmail(input.contactEmail);
    const roleTitle = text(input.roleTitle, 160);
    const ownerId = text(input.ownerId, 80);
    const owner = owners.find(candidate => candidate.id === ownerId)
      || (ownerId ? normalizeOwner({ id: ownerId, name: ownerId === currentUserId() ? currentUserName() : 'Assigned Sales owner', current: ownerId === currentUserId() }) : null)
      || (canAssignOwner() ? Object.freeze({ id: '', name: 'Unassigned', active: true, current: false }) : normalizeOwner({ id: currentUserId(), name: currentUserName(), current: true }));
    if (!companyName) throw new Error('Enter the company name.');
    if (!contactName) throw new Error('Enter the primary contact name.');
    if (!contactEmail) throw new Error('Enter a valid primary contact email.');
    if (!owner) throw new Error('Choose a Sales owner.');
    if (!roleTitle) throw new Error('Enter the first role the Client needs filled.');
    return Object.freeze({
      company: Object.freeze({
        name: companyName,
        industry: text(input.industry, 120),
        website: text(input.website, 200),
        addressLine1: text(input.addressLine1, 160),
        addressLine2: text(input.addressLine2, 160),
        city: text(input.city, 100),
        stateRegion: text(input.stateRegion, 100),
        postalCode: text(input.postalCode, 24),
        country: text(input.country, 100),
        phone: text(input.companyPhone, 40)
      }),
      primaryContact: Object.freeze({
        name: contactName,
        title: text(input.contactTitle, 120),
        email: contactEmail,
        phone: text(input.contactPhone, 60)
      }),
      owner,
      firstHiringRequest: Object.freeze({
        roleTitle,
        vaType: text(input.vaType, 120),
        seats: positiveInteger(input.seats, 1),
        skills: Object.freeze(list(input.skills)),
        schedule: text(input.schedule, 180),
        timeZone: text(input.timeZone, 100),
        targetStartDate: safeDate(input.targetStartDate)
      }),
      portalInvite: Object.freeze({
        requested: input.portalInvite === true,
        email: contactEmail
      })
    });
  }

  function defaultSeed() {
    return [
      {
        id: 'preview-client-brightlane',
        company: { name: 'Brightlane Medical', industry: 'Healthcare services', website: 'brightlane.example' },
        primaryContact: { name: 'Taylor Morgan', title: 'Practice Administrator', email: 'taylor@brightlane.example', phone: '(214) 555-0177' },
        owner: { id: 'preview-owner-morgan', name: 'Morgan Lee', current: true },
        lifecycleStage: 'matching',
        portal: { requested: true, status: 'invite_pending', email: 'taylor@brightlane.example', lastSentAt: '2026-09-01T14:00:00.000Z' },
        hiringRequests: [{ id: '10000000-0000-4000-8000-000000000001', roleTitle: 'Medical Virtual Assistant', vaType: 'Medical', seats: 1, skills: ['Medical scheduling', 'Insurance verification'], schedule: 'Monday-Friday · 8:00 AM-5:00 PM CT', timeZone: 'America/Chicago', targetStartDate: '2026-09-15', status: 'open', progressStep: 'shortlist', candidateCount: 3 }],
        activity: [{ label: 'Client Portal invitation sent', detail: 'Sent to Taylor Morgan.', timestamp: '2026-09-01T14:00:00.000Z' }, { label: 'Hiring request created', detail: 'Medical Virtual Assistant · 1 opening', timestamp: '2026-09-01T13:58:00.000Z' }]
      },
      {
        id: 'preview-client-northstar',
        company: { name: 'Northstar Legal', industry: 'Legal services' },
        primaryContact: { name: 'Jordan Avery', title: 'Office Manager', email: 'jordan@northstar.example', phone: '(972) 555-0183' },
        owner: { id: 'preview-owner-morgan', name: 'Morgan Lee', current: true },
        lifecycleStage: 'discovery',
        portal: { requested: false, status: 'not_invited', email: 'jordan@northstar.example' },
        hiringRequests: [{ id: '10000000-0000-4000-8000-000000000011', roleTitle: 'Legal Administrative VA', vaType: 'Legal', seats: 1, skills: ['Calendar management', 'Client intake'], status: 'open', progressStep: 'request' }],
        activity: [{ label: 'Client record created', detail: 'Discovery is in progress.', timestamp: '2026-08-30T16:30:00.000Z' }]
      }
    ];
  }

  function createApprovalAdapter(seed = defaultSeed()) {
    let records = seed.map(record => normalizeClient(record)).filter(Boolean);
    let previewIdSequence = 0;
    const newPreviewId = () => `f0000000-0000-4000-8000-${String(++previewIdSequence).padStart(12, '0')}`;
    const ownerRecords = [
      normalizeOwner({ id: 'preview-owner-morgan', name: 'Morgan Lee', active: true, current: true }),
      normalizeOwner({ id: 'preview-owner-jordan', name: 'Jordan Reed', active: true }),
      normalizeOwner({ id: 'preview-owner-founder', name: 'Matt Johnson', active: true })
    ].filter(Boolean);
    function updateRecord(clientId, update, label, detail = '') {
      const now = new Date().toISOString();
      records = records.map(record => {
        if (record.id !== clientId) return record;
        const next = typeof update === 'function' ? update(record, now) : { ...record, ...update };
        return normalizeClient({ ...next, updatedAt: now, activity: [{ label, detail, timestamp: now }, ...record.activity] }, ownerRecords);
      });
      return records.find(record => record.id === clientId) || null;
    }
    return Object.freeze({
      kind: 'approval',
      async listOwners() { return ownerRecords.slice(); },
      async listClients() { return records.slice(); },
      async loadWorkspace() { return { owners: ownerRecords.slice(), clients: records.slice() }; },
      async loadClient(clientId) { return records.find(record => record.id === text(clientId, 80)) || null; },
      async createClientBundle(bundle) {
        const now = new Date().toISOString();
        const id = newPreviewId();
        const requestId = newPreviewId();
        const record = normalizeClient({
          id,
          company: bundle.company,
          primaryContact: bundle.primaryContact,
          owner: bundle.owner,
          lifecycleStage: 'discovery',
          portal: { requested: bundle.portalInvite.requested, status: bundle.portalInvite.requested ? 'invite_pending' : 'not_invited', email: bundle.portalInvite.email, lastSentAt: bundle.portalInvite.requested ? now : '' },
          hiringRequests: [{ id: requestId, ...bundle.firstHiringRequest, status: 'open', progressStep: 'request' }],
          activity: [
            ...(bundle.portalInvite.requested ? [{ label: 'Client Portal invitation prepared', detail: `Invitation will be sent to ${bundle.portalInvite.email} when the secure backend is connected.`, timestamp: now }] : []),
            { label: 'Client and first hiring request created', detail: `${bundle.firstHiringRequest.roleTitle} · ${bundle.firstHiringRequest.seats} opening${bundle.firstHiringRequest.seats === 1 ? '' : 's'}`, timestamp: now }
          ]
        });
        records = [record, ...records];
        return record;
      },
      async updateCompany(client, company) {
        return updateRecord(client.id, record => ({ ...record, company: { ...record.company, ...company } }), 'Company details updated');
      },
      async assignOwner(client, salesOwnerId) {
        const owner = ownerRecords.find(candidate => candidate.id === salesOwnerId) || { id: '', name: 'Unassigned' };
        return updateRecord(client.id, record => ({ ...record, owner }), 'Client owner updated', owner.name);
      },
      async updatePrimaryContact(client, primaryContact) {
        return updateRecord(client.id, record => ({ ...record, primaryContact: { ...record.primaryContact, ...primaryContact, updatedAt: new Date().toISOString() } }), 'Primary contact updated');
      },
      async updateClientStatus(client, status) {
        return updateRecord(client.id, record => ({ ...record, lifecycleStage: status }), 'Client stage updated', titleCase(status));
      },
      async addHiringRequest(client, hiringRequest) {
        const request = normalizeHiringRequest({ id: newPreviewId(), ...hiringRequest, status: 'discovery', progressStep: 'request', updatedAt: new Date().toISOString() });
        return updateRecord(client.id, record => ({ ...record, hiringRequests: [request, ...record.hiringRequests] }), 'Hiring request created', request.roleTitle);
      },
      async updateHiringRequest(client, hiringRequest, changes) {
        return updateRecord(client.id, record => ({ ...record, hiringRequests: record.hiringRequests.map(request => request.id === hiringRequest.id ? normalizeHiringRequest({ ...request, ...changes, updatedAt: new Date().toISOString() }) : request) }), 'Hiring request updated', changes.roleTitle);
      },
      async setHiringRequestStatus(client, hiringRequest, status) {
        return updateRecord(client.id, record => ({ ...record, hiringRequests: record.hiringRequests.map(request => request.id === hiringRequest.id ? normalizeHiringRequest({ ...request, status, updatedAt: new Date().toISOString() }) : request) }), 'Hiring request stage updated', titleCase(status));
      },
      async changePortalAccess(client, action) {
        const status = action === 'activate' || action === 'resend_invitation' ? 'invite_pending' : action === 'suspend_access' ? 'suspended' : action === 'reactivate_access' ? 'active' : client.portal.status;
        return updateRecord(client.id, record => ({ ...record, portal: { ...record.portal, requested: true, status, lastSentAt: new Date().toISOString() } }), 'Client Portal access updated', titleCase(action));
      },
      async resendPortalInvite(clientId) {
        const now = new Date().toISOString();
        const normalizedId = typeof clientId === 'object' ? clientId.id : clientId;
        records = records.map(record => record.id !== normalizedId ? record : normalizeClient({
          ...record,
          portal: { ...record.portal, requested: true, status: 'invite_pending', lastSentAt: now },
          activity: [{ label: 'Client Portal invitation prepared again', detail: `Invitation will be sent to ${record.portal.email} when the secure backend is connected.`, timestamp: now }, ...record.activity]
        }));
        return records.find(record => record.id === normalizedId) || null;
      }
    });
  }

  function createEndpointAdapter(options = {}) {
    const endpoint = text(options.endpoint || options.pipelineEndpoint, 240) || ENDPOINT;
    const portalEndpoint = text(options.portalEndpoint, 240) || PORTAL_ACCESS_ENDPOINT;
    const fetchImpl = options.fetch || root?.fetch?.bind(root);
    const mutationRetries = new Map();
    let mutationRetryOwner = '';
    async function token() {
      const sessionResult = await root?.soroSupabase?.auth?.getSession?.();
      const accessToken = sessionResult?.data?.session?.access_token;
      if (!accessToken) throw new Error('Your secure session has expired. Sign in again.');
      return accessToken;
    }
    async function request(url, method, payload) {
      if (typeof fetchImpl !== 'function') throw new Error('The secure Client workflow service is unavailable.');
      const accessToken = await token();
      const response = await fetchImpl(url, {
        method,
        cache: 'no-store',
        headers: { Authorization: `Bearer ${accessToken}`, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
        ...(method === 'POST' ? { body: JSON.stringify(payload || {}) } : {})
      });
      let data;
      try {
        data = await response.json();
      } catch (cause) {
        const error = new Error(response.ok
          ? 'The Client workflow response could not be verified. Try the same action again.'
          : 'The Client workflow could not be updated.');
        if (!response.ok) error.status = response.status;
        error.cause = cause;
        throw error;
      }
      if (!response.ok) {
        const error = new Error(text(data.error || data.message, 300) || 'The Client workflow could not be updated.');
        error.status = response.status;
        error.code = text(data.code, 80);
        throw error;
      }
      return data;
    }
    function operationId() {
      if (typeof root?.crypto?.randomUUID === 'function') return root.crypto.randomUUID();
      const bytes = typeof root?.crypto?.getRandomValues === 'function' ? root.crypto.getRandomValues(new Uint8Array(16)) : null;
      if (bytes) {
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      }
      throw new Error('This browser cannot safely create an operation request. Refresh in a current browser.');
    }
    function currentMutationOwner() {
      const access = root?.soroCurrentAccess || {};
      return JSON.stringify({
        userId: text(access.user_id || access.userId, 160),
        role: normalizedRole(access.role),
        organizationId: text(access.organization_id || access.organizationId, 160)
      });
    }
    function syncMutationRetryOwner() {
      const owner = currentMutationOwner();
      if (owner === mutationRetryOwner) return;
      mutationRetries.clear();
      mutationRetryOwner = owner;
    }
    function stableValue(value) {
      if (Array.isArray(value)) return value.map(stableValue);
      if (!value || typeof value !== 'object') return value;
      return Object.keys(value).sort().reduce((result, key) => {
        if (value[key] !== undefined) result[key] = stableValue(value[key]);
        return result;
      }, {});
    }
    function pruneMutationRetries(now = Date.now()) {
      for (const [fingerprint, entry] of mutationRetries) {
        if (!entry || now - entry.lastUsedAt > MUTATION_RETRY_TTL_MS) mutationRetries.delete(fingerprint);
      }
      while (mutationRetries.size > MUTATION_RETRY_LIMIT) {
        const oldest = [...mutationRetries.entries()].sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
        if (!oldest) break;
        mutationRetries.delete(oldest[0]);
      }
    }
    function prepareMutationAttempt(url, body) {
      syncMutationRetryOwner();
      const now = Date.now();
      pruneMutationRetries(now);
      const action = text(body?.action, 80).toLowerCase();
      if (!action) throw new Error('The secure Client action could not be prepared. Refresh and try again.');
      const fingerprint = JSON.stringify(stableValue({ owner: mutationRetryOwner, url, ...body }));
      let entry = mutationRetries.get(fingerprint);
      if (!entry) {
        entry = { requestId: operationId(), createdAt: now, lastUsedAt: now };
        mutationRetries.set(fingerprint, entry);
        pruneMutationRetries(now);
      } else {
        entry.lastUsedAt = now;
      }
      return Object.freeze({ fingerprint, requestId: entry.requestId, owner: mutationRetryOwner });
    }
    function mutationErrorIsAmbiguous(error) {
      const code = text(error?.code, 80).toLowerCase();
      if (['email_delivery_failed', 'email_unavailable'].includes(code)) return false;
      if (['email_delivery_unknown', 'access_action_pending'].includes(code)) return true;
      const status = Number(error?.status);
      return !Number.isInteger(status) || status === 408 || status === 429 || status >= 500;
    }
    function settleMutationAttempt(attempt, error = null) {
      const entry = attempt ? mutationRetries.get(attempt.fingerprint) : null;
      if (!entry || entry.requestId !== attempt.requestId) return;
      if (!error || !mutationErrorIsAmbiguous(error)) mutationRetries.delete(attempt.fingerprint);
      else entry.lastUsedAt = Date.now();
    }
    function retainMutationAttempt(attempt) {
      const entry = attempt ? mutationRetries.get(attempt.fingerprint) : null;
      if (entry?.requestId === attempt.requestId) entry.lastUsedAt = Date.now();
    }
    async function mutate(url, body, apply = null) {
      const attempt = prepareMutationAttempt(url, body);
      let mutationAccepted = false;
      try {
        const result = await request(url, 'POST', { requestId: attempt.requestId, ...body });
        mutationAccepted = true;
        if (attempt.owner !== mutationRetryOwner || attempt.owner !== currentMutationOwner()) {
          throw new Error('Your Soro account changed before this Client action finished. Review the current workspace and try again.');
        }
        const applied = typeof apply === 'function' ? await apply(result) : result;
        settleMutationAttempt(attempt);
        return applied;
      } catch (error) {
        if (mutationAccepted) retainMutationAttempt(attempt);
        else settleMutationAttempt(attempt, error);
        throw error;
      }
    }
    async function change(action, options = {}, apply = null) {
      const body = { action, expectedUpdatedAt: options.expectedUpdatedAt || null };
      if (options.entityId) body.entityId = options.entityId;
      if (options.parentId) body.parentId = options.parentId;
      if (Object.hasOwn(options, 'payload')) body.payload = options.payload;
      return mutate(endpoint, body, apply);
    }
    async function fetchWorkspace() {
      const data = await request(endpoint, 'GET');
      return data.workspace && typeof data.workspace === 'object' ? data.workspace : data;
    }
    function pipelineBundle(bundle) {
      return {
        client: {
          companyName: bundle.company.name,
          industry: bundle.company.industry || '',
          addressLine1: bundle.company.addressLine1 || '',
          addressLine2: bundle.company.addressLine2 || '',
          city: bundle.company.city || '',
          stateRegion: bundle.company.stateRegion || '',
          postalCode: bundle.company.postalCode || '',
          country: bundle.company.country || '',
          companyPhone: bundle.company.phone || '',
          website: bundle.company.website || '',
          salesOwnerId: bundle.owner?.id || null
        },
        primaryContact: {
          fullName: bundle.primaryContact.name,
          contactRole: bundle.primaryContact.title || 'Primary contact',
          email: bundle.primaryContact.email,
          phone: bundle.primaryContact.phone || ''
        },
        firstRequest: {
          title: bundle.firstHiringRequest.roleTitle,
          status: 'discovery',
          startDate: bundle.firstHiringRequest.targetStartDate || '',
          numberOfTalent: bundle.firstHiringRequest.seats,
          budgetStatus: 'pending',
          requiredFields: {
            vaType: bundle.firstHiringRequest.vaType || '',
            skills: [...bundle.firstHiringRequest.skills],
            schedule: bundle.firstHiringRequest.schedule || '',
            timeZone: bundle.firstHiringRequest.timeZone || ''
          }
        }
      };
    }
    async function refreshedClient(clientId) {
      const data = await fetchWorkspace();
      const ownerRecords = Array.isArray(data.salesOwners) ? data.salesOwners.map(normalizeOwner).filter(Boolean) : [];
      return (Array.isArray(data.clients) ? data.clients : []).map(client => normalizeClient(client, ownerRecords)).find(client => client?.id === clientId) || null;
    }
    async function portalChange(action, values, apply = null) {
      return mutate(portalEndpoint, { action, ...values }, apply);
    }
    return Object.freeze({
      kind: 'endpoint',
      async loadWorkspace() {
        const workspaceData = await fetchWorkspace();
        const ownerRecords = Array.isArray(workspaceData.salesOwners) ? workspaceData.salesOwners.map(normalizeOwner).filter(Boolean) : [];
        return {
          owners: ownerRecords,
          clients: Array.isArray(workspaceData.clients) ? workspaceData.clients.map(client => normalizeClient(client, ownerRecords)).filter(Boolean) : []
        };
      },
      async listOwners() { const workspace = await this.loadWorkspace(); return workspace.owners; },
      async listClients() { const workspace = await this.loadWorkspace(); return workspace.clients; },
      async loadClient(clientId) { return refreshedClient(clientId); },
      async createClientBundle(bundle) {
        let warning = '';
        const client = await mutate(endpoint, {
          action: 'create_client',
          ...pipelineBundle(bundle)
        }, async result => {
          const clientId = text(result?.clientId, 80);
          const contactId = text(result?.contactId, 80);
          if (!clientId || !contactId) throw new Error('The saved Client could not be verified. Try the same action again.');
          let refreshed = null;
          if (bundle.portalInvite.requested) {
            try {
              refreshed = await portalChange('activate', { contactId, email: bundle.portalInvite.email, portalRole: 'client_admin' }, () => refreshedClient(clientId));
            } catch (error) {
              warning = text(error?.message, 300) || 'The Client was created, but portal access needs attention.';
            }
          }
          refreshed ||= await refreshedClient(clientId);
          if (!refreshed) throw new Error('The saved Client could not be verified. Try the same action again.');
          return refreshed;
        });
        return { client, warning };
      },
      async updateCompany(client, company) {
        return change('update_client', { expectedUpdatedAt: client.updatedAt, entityId: client.id, payload: { companyName: company.name, industry: company.industry || '', addressLine1: company.addressLine1 || '', addressLine2: company.addressLine2 || '', city: company.city || '', stateRegion: company.stateRegion || '', postalCode: company.postalCode || '', country: company.country || '', companyPhone: company.phone || '', website: company.website || '' } }, () => refreshedClient(client.id));
      },
      async assignOwner(client, salesOwnerId) {
        return change('assign_owner', { expectedUpdatedAt: client.updatedAt, entityId: client.id, payload: { salesOwnerId } }, () => refreshedClient(client.id));
      },
      async updatePrimaryContact(client, primaryContact) {
        return change('update_contact', { expectedUpdatedAt: client.primaryContact.updatedAt, entityId: client.primaryContact.id, payload: { fullName: primaryContact.name, contactRole: primaryContact.title || 'Primary contact', email: primaryContact.email || '', phone: primaryContact.phone || '' } }, () => refreshedClient(client.id));
      },
      async updateClientStatus(client, status) {
        return change('set_client_stage', { expectedUpdatedAt: client.updatedAt, entityId: client.id, payload: { stage: status } }, () => refreshedClient(client.id));
      },
      async addHiringRequest(client, hiringRequest) {
        return change('create_request', { expectedUpdatedAt: client.updatedAt, parentId: client.id, payload: { title: hiringRequest.roleTitle, status: 'discovery', startDate: hiringRequest.targetStartDate || '', numberOfTalent: hiringRequest.seats, budgetStatus: 'pending', requiredFields: { vaType: hiringRequest.vaType || '', skills: [...hiringRequest.skills], schedule: hiringRequest.schedule || '', timeZone: hiringRequest.timeZone || '' } } }, () => refreshedClient(client.id));
      },
      async updateHiringRequest(client, hiringRequest, changes) {
        return change('update_request', { expectedUpdatedAt: hiringRequest.updatedAt, entityId: hiringRequest.id, payload: { title: changes.roleTitle, startDate: changes.targetStartDate || '', numberOfTalent: changes.seats, budgetStatus: 'pending', requiredFields: { vaType: changes.vaType || '', skills: [...changes.skills], schedule: changes.schedule || '', timeZone: changes.timeZone || '' } } }, () => refreshedClient(client.id));
      },
      async setHiringRequestStatus(client, hiringRequest, status) {
        return change('set_request_status', { expectedUpdatedAt: hiringRequest.updatedAt, entityId: hiringRequest.id, payload: { status } }, () => refreshedClient(client.id));
      },
      async changePortalAccess(client, action, values = {}) {
        const payload = { contactId: client.primaryContact.id };
        const pendingAccess = client.portal.pendingAccess?.action === action
          ? client.portal.pendingAccess
          : null;
        if (action === 'activate' || action === 'change_email') {
          payload.email = pendingAccess?.email || values.email || client.portal.email || client.primaryContact.email;
        }
        if (action === 'activate') payload.portalRole = pendingAccess?.portalRole || values.portalRole || 'client_admin';
        return portalChange(action, payload, () => refreshedClient(client.id));
      },
      async resendPortalInvite(client) { return this.changePortalAccess(client, client.portal.status === 'not_invited' ? 'activate' : 'resend_invitation'); }
    });
  }

  function ownerOptions() {
    const available = owners.filter(owner => owner.active !== false);
    return available.map(owner => `<option value="${escapeHtml(owner.id)}" ${owner.current ? 'selected' : ''}>${escapeHtml(owner.name)}</option>`).join('');
  }

  function formMarkup() {
    const lockedOwner = owners.find(owner => owner.current) || owners[0] || normalizeOwner({ id: currentUserId(), name: currentUserName(), current: true });
    const ownerControl = canAssignOwner()
      ? `<label>Sales owner <span>Optional</span><select name="ownerId"><option value="">Unassigned</option>${ownerOptions()}</select><small>Admin and Sales Management can assign this after creation.</small></label>`
      : `<div class="client-workflow-owner-lock"><span>Sales owner</span><strong>${escapeHtml(lockedOwner?.name || currentUserName())}</strong><small>Assigned to you</small><input type="hidden" name="ownerId" value="${escapeHtml(lockedOwner?.id || currentUserId())}" /></div>`;
    return `<main class="page client-workflow-page client-workflow-create" data-client-workflow data-client-workflow-state="create">
      <button class="client-workflow-back" type="button" data-client-workflow-back>← Back to Client Pipeline</button>
      <header class="client-workflow-heading">
        <div><p class="eyebrow">Guided Client setup</p><h1>Create Client &amp; Hiring Request</h1><p>Add the Client, primary contact, ownership, first role, and portal access in one pass.</p></div>
        ${activeAdapter?.kind === 'approval' ? '<span class="client-workflow-preview-note">Local approval preview</span>' : ''}
      </header>
      ${feedbackMarkup()}
      <form class="client-workflow-form" data-client-workflow-form novalidate>
        <section class="panel client-workflow-form-section" aria-labelledby="client-workflow-company-title">
          <span class="client-workflow-step" aria-hidden="true">1</span><div class="client-workflow-form-copy"><p class="eyebrow">Business</p><h2 id="client-workflow-company-title">Company</h2><p>Create the Client record used throughout Soro Ops.</p></div>
          <div class="client-workflow-fields client-workflow-fields--three">
            <label>Company name<input name="companyName" required maxlength="160" autocomplete="organization" placeholder="Brightlane Medical" /></label>
            <label>Industry<input name="industry" maxlength="120" placeholder="Healthcare services" /></label>
            <label>Website <span>Optional</span><input name="website" maxlength="200" inputmode="url" placeholder="https://example.com" /></label>
            <label>Company phone <span>Optional</span><input name="companyPhone" maxlength="40" type="tel" autocomplete="tel" placeholder="(214) 555-0100" /></label>
            <label class="client-workflow-field--wide">Address line 1 <span>Optional</span><input name="addressLine1" maxlength="160" autocomplete="address-line1" /></label>
            <label class="client-workflow-field--wide">Address line 2 <span>Optional</span><input name="addressLine2" maxlength="160" autocomplete="address-line2" /></label>
            <label>City <span>Optional</span><input name="city" maxlength="100" autocomplete="address-level2" /></label>
            <label>State or region <span>Optional</span><input name="stateRegion" maxlength="100" autocomplete="address-level1" /></label>
            <label>Postal code <span>Optional</span><input name="postalCode" maxlength="24" autocomplete="postal-code" /></label>
            <label>Country <span>Optional</span><input name="country" maxlength="100" autocomplete="country-name" /></label>
          </div>
        </section>
        <section class="panel client-workflow-form-section" aria-labelledby="client-workflow-contact-title">
          <span class="client-workflow-step" aria-hidden="true">2</span><div class="client-workflow-form-copy"><p class="eyebrow">Client contact</p><h2 id="client-workflow-contact-title">Primary contact</h2><p>This person receives Client Portal access and shortlist updates.</p></div>
          <div class="client-workflow-fields client-workflow-fields--two">
            <label>Full name<input name="contactName" required maxlength="140" autocomplete="name" placeholder="Taylor Morgan" /></label>
            <label>Role or title <span>Optional</span><input name="contactTitle" maxlength="120" autocomplete="organization-title" placeholder="Practice Administrator" /></label>
            <label>Email<input name="contactEmail" required maxlength="254" type="email" autocomplete="email" placeholder="taylor@example.com" /></label>
            <label>Phone <span>Optional</span><input name="contactPhone" maxlength="60" type="tel" autocomplete="tel" placeholder="(214) 555-0100" /></label>
          </div>
        </section>
        <section class="panel client-workflow-form-section" aria-labelledby="client-workflow-owner-title">
          <span class="client-workflow-step" aria-hidden="true">3</span><div class="client-workflow-form-copy"><p class="eyebrow">Accountability</p><h2 id="client-workflow-owner-title">Client owner</h2><p>The owner receives response alerts and carries the placement forward.</p></div>
          <div class="client-workflow-fields">${ownerControl}</div>
        </section>
        <section class="panel client-workflow-form-section" aria-labelledby="client-workflow-request-title">
          <span class="client-workflow-step" aria-hidden="true">4</span><div class="client-workflow-form-copy"><p class="eyebrow">First opening</p><h2 id="client-workflow-request-title">Hiring request</h2><p>Capture enough detail to open the matching workflow immediately.</p></div>
          <div class="client-workflow-fields client-workflow-fields--three">
            <label>Role title<input name="roleTitle" required maxlength="160" placeholder="Medical Virtual Assistant" /></label>
            <label>VA type<input name="vaType" maxlength="120" placeholder="Medical" /></label>
            <label>Number needed<input name="seats" type="number" min="1" max="50" value="1" inputmode="numeric" /></label>
            <label class="client-workflow-field--wide">Required skills <span>Separate with commas</span><textarea name="skills" rows="3" maxlength="1200" placeholder="Medical scheduling, Insurance verification"></textarea></label>
            <label>Schedule <span>Optional</span><input name="schedule" maxlength="180" placeholder="Monday-Friday · 8 AM-5 PM" /></label>
            <label>Client time zone <span>Optional</span><input name="timeZone" maxlength="100" placeholder="America/Chicago" /></label>
            <label>Target start <span>Optional</span><input name="targetStartDate" type="date" /></label>
          </div>
        </section>
        <section class="panel client-workflow-form-section client-workflow-form-section--portal" aria-labelledby="client-workflow-portal-title">
          <span class="client-workflow-step" aria-hidden="true">5</span><div class="client-workflow-form-copy"><p class="eyebrow">Secure access</p><h2 id="client-workflow-portal-title">Client Portal invitation</h2><p>Use the primary contact email. Access is role-scoped and can be resent later.</p></div>
          <label class="client-workflow-toggle"><input name="portalInvite" type="checkbox" checked /><span aria-hidden="true"></span><strong>Send the Client Portal invitation</strong><small>The Client is saved first, so an email delivery issue cannot create a duplicate record.</small></label>
        </section>
        <div class="client-workflow-form-actions">
          <p id="client-workflow-form-message" role="status" aria-live="polite">One submission creates the Client and first hiring request together.</p>
          <div><button class="button" type="button" data-client-workflow-back>Cancel</button><button class="button primary" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Creating…' : 'Create Client & Hiring Request'}</button></div>
        </div>
      </form>
    </main>`;
  }

  function feedbackMarkup() {
    if (!feedback.message) return '';
    return `<div class="client-workflow-feedback ${feedback.tone === 'error' ? 'is-error' : ''}" role="${feedback.tone === 'error' ? 'alert' : 'status'}">${escapeHtml(feedback.message)}</div>`;
  }

  function stageLabel(client) {
    const steps = client.hiringRequests.map(request => request.progressStep);
    const furthest = Math.max(0, ...steps.map(step => PIPELINE_STEPS.findIndex(([key]) => key === step)));
    return PIPELINE_STEPS[furthest]?.[1] || titleCase(client.lifecycleStage) || 'Discovery';
  }

  function pipelineMarkup() {
    const rows = clients.map(client => {
      const openRequests = client.hiringRequests.filter(request => !['closed', 'filled', 'cancelled'].includes(request.status));
      const currentStage = stageLabel(client);
      const next = openRequests[0]?.progressStep === 'request' ? 'Build shortlist' : openRequests[0]?.progressStep === 'shortlist' ? 'Send to Client' : openRequests[0]?.progressStep === 'client_review' ? 'Review Client response' : openRequests.length ? `Continue ${currentStage}` : 'Open Client Hub';
      return `<button class="client-workflow-client-row" type="button" data-client-workflow-client="${escapeHtml(client.id)}">
        <span class="client-workflow-client-mark" aria-hidden="true">${escapeHtml(initials(client.company.name))}</span>
        <span class="client-workflow-client-main"><strong>${escapeHtml(client.company.name)}</strong><small>${escapeHtml(client.primaryContact.name || 'Primary contact not recorded')}</small></span>
        <span><small>Stage</small><strong>${escapeHtml(currentStage)}</strong></span>
        <span><small>Open requests</small><strong>${openRequests.length}</strong></span>
        <span><small>Owner</small><strong>${escapeHtml(client.owner.name)}</strong></span>
        <span class="client-workflow-client-next">${escapeHtml(next)} <b aria-hidden="true">→</b></span>
      </button>`;
    }).join('');
    return `<main class="page client-workflow-page" data-client-workflow data-client-workflow-state="pipeline">
      <div class="page-heading client-workflow-heading"><div><p class="eyebrow">Soro Operations</p><h1>Client Pipeline</h1><p>Move each Client from first request through placement without losing the next action.</p></div>${canEditForRole() ? '<div class="heading-actions"><button class="button primary" type="button" data-client-workflow-create>+ New Client</button></div>' : '<span class="client-workflow-preview-note">View only</span>'}</div>
      ${feedbackMarkup()}
      <section class="client-workflow-summary" aria-label="Client pipeline summary">
        <article><span>Clients</span><strong>${clients.length}</strong><small>Visible to your role</small></article>
        <article><span>Open hiring requests</span><strong>${clients.reduce((sum, client) => sum + client.hiringRequests.filter(request => !['closed', 'filled', 'cancelled'].includes(request.status)).length, 0)}</strong><small>Ready for action</small></article>
        <article><span>In Client review</span><strong>${clients.reduce((sum, client) => sum + client.hiringRequests.filter(request => request.progressStep === 'client_review').length, 0)}</strong><small>Awaiting decisions</small></article>
        <article><span>In onboarding</span><strong>${clients.reduce((sum, client) => sum + client.hiringRequests.filter(request => request.progressStep === 'onboarding').length, 0)}</strong><small>Preparing start</small></article>
      </section>
      <section class="panel client-workflow-pipeline" aria-labelledby="client-workflow-list-title">
        <div class="client-workflow-section-heading"><div><p class="eyebrow">Owned accounts</p><h2 id="client-workflow-list-title">Clients and next actions</h2></div><span>${clients.length} Client${clients.length === 1 ? '' : 's'}</span></div>
        <div class="client-workflow-client-list">${rows || '<p class="client-workflow-empty">No Clients are assigned to this workspace yet.</p>'}</div>
      </section>
    </main>`;
  }

  function initials(name) {
    const words = text(name, 160).split(/\s+/).filter(Boolean);
    return `${words[0]?.[0] || ''}${words.length > 1 ? words[words.length - 1][0] : ''}`.toUpperCase() || 'CL';
  }

  function linkValue(value, kind) {
    const label = text(value, 240);
    if (!label) return '<span>Not recorded</span>';
    if (kind === 'email' && safeEmail(label)) return `<a href="mailto:${escapeHtml(label)}">${escapeHtml(label)}</a>`;
    if (kind === 'phone') {
      const href = label.replace(/[^\d+]/g, '');
      if (href) return `<a href="tel:${escapeHtml(href)}">${escapeHtml(label)}</a>`;
    }
    return `<span>${escapeHtml(label)}</span>`;
  }

  function portalStatusLabel(portal) {
    if (portal.status === 'active') return 'Active';
    if (portal.status === 'invite_pending') return 'Invitation pending';
    if (portal.status === 'suspended') return 'Suspended';
    if (portal.status === 'delivery_failed') return 'Delivery failed';
    if (portal.status === 'needs_reconciliation') return 'Needs review';
    return 'Not invited';
  }

  function optionsMarkup(values, selected) {
    return values.map(([value, label]) => `<option value="${escapeHtml(value)}" ${value === selected ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('');
  }

  function clientStageOptions(current) {
    const transitions = {
      new_inquiry: ['new_inquiry', 'discovery', 'lost'],
      discovery: ['discovery', 'qualified', 'paused', 'lost'],
      qualified: ['qualified', 'matching', 'paused', 'lost'],
      matching: ['matching', 'paused', 'lost'],
      active: ['active', 'paused', 'lost'],
      paused: ['paused', 'discovery', 'qualified', 'matching', 'lost'],
      lost: ['lost'], archived: ['archived']
    };
    return (transitions[current] || [current]).map(value => [value, titleCase(value)]);
  }

  function requestStatusOptions(current) {
    const transitions = {
      draft: ['draft', 'discovery', 'cancelled'],
      discovery: ['discovery', 'open', 'on_hold', 'cancelled'],
      open: ['open', 'sourcing', 'on_hold', 'cancelled'],
      sourcing: ['sourcing', 'shortlisting', 'on_hold', 'cancelled'],
      shortlisting: ['shortlisting', 'on_hold', 'cancelled'],
      client_review: ['client_review'],
      interviewing: ['interviewing'],
      selection_pending: ['selection_pending'],
      placement_pending: ['placement_pending'],
      partially_filled: ['partially_filled'],
      on_hold: ['on_hold', 'discovery', 'open', 'sourcing', 'shortlisting', 'cancelled'],
      filled: ['filled'], cancelled: ['cancelled']
    };
    return (transitions[current] || [current]).map(value => [value, titleCase(value)]);
  }

  function requestEditorFields(request = {}) {
    const seatsLocked = ['client_review', 'interviewing', 'selection_pending', 'placement_pending', 'partially_filled', 'filled'].includes(request.status);
    return `<div class="client-workflow-dialog-grid">
      <label>Role title<input name="roleTitle" required maxlength="160" value="${escapeHtml(request.roleTitle || '')}" /></label>
      <label>VA type<input name="vaType" maxlength="120" value="${escapeHtml(request.vaType || '')}" /></label>
      <label>Number needed${seatsLocked ? '<span>Locked after Client review begins</span>' : ''}<input name="seats" type="number" min="1" max="100" value="${request.seats || 1}" ${seatsLocked ? 'readonly aria-readonly="true"' : ''} /></label>
      <label class="client-workflow-dialog-wide">Required skills <span>Separate with commas</span><textarea name="skills" rows="3" maxlength="1200">${escapeHtml((request.skills || []).join(', '))}</textarea></label>
      <label>Schedule<input name="schedule" maxlength="180" value="${escapeHtml(request.schedule || '')}" /></label>
      <label>Client time zone<input name="timeZone" maxlength="100" value="${escapeHtml(request.timeZone || '')}" /></label>
      <label>Target start<input name="targetStartDate" type="date" value="${escapeHtml(request.targetStartDate || '')}" /></label>
      ${request.id ? `<label>Status<select name="status">${optionsMarkup(requestStatusOptions(request.status), request.status)}</select></label>` : ''}
    </div>`;
  }

  function portalActions(portal) {
    if (portal.pendingAccess) return [[portal.pendingAccess.action, `Retry pending ${titleCase(portal.pendingAccess.action)}`]];
    if (portal.status === 'not_invited') return [['activate', 'Activate and send invitation']];
    if (portal.status === 'invite_pending') return [['resend_invitation', 'Resend invitation'], ['change_email', 'Change sign-in email'], ['suspend_access', 'Suspend access']];
    if (portal.status === 'active') return [['send_password_reset', 'Send password reset'], ['change_email', 'Change sign-in email'], ['suspend_access', 'Suspend access']];
    if (portal.status === 'suspended') return [['reactivate_access', 'Reactivate access']];
    if (portal.status === 'delivery_failed') return [['resend_invitation', 'Retry invitation'], ['change_email', 'Change sign-in email'], ['suspend_access', 'Suspend access']];
    return [];
  }

  function primaryPortalAction(portal) {
    if (portal.pendingAccess) return portal.pendingAccess.action;
    if (portal.status === 'not_invited') return 'activate';
    if (portal.status === 'invite_pending' || portal.status === 'delivery_failed') return 'resend_invitation';
    if (portal.status === 'active') return 'send_password_reset';
    if (portal.status === 'suspended') return 'reactivate_access';
    return '';
  }

  function editorMarkup(client) {
    if (!editorKind || !canEditForRole()) return '';
    const request = client.hiringRequests.find(candidate => candidate.id === editorRequestId) || null;
    let eyebrow = 'Client Hub';
    let title = '';
    let body = '';
    if (editorKind === 'company') {
      title = 'Edit company & ownership';
      body = `<div class="client-workflow-dialog-grid"><label>Company name<input name="companyName" required maxlength="160" value="${escapeHtml(client.company.name)}" /></label><label>Industry<input name="industry" maxlength="120" value="${escapeHtml(client.company.industry)}" /></label><label>Company phone<input name="companyPhone" maxlength="40" type="tel" value="${escapeHtml(client.company.phone)}" /></label><label>Website<input name="website" maxlength="200" value="${escapeHtml(client.company.website)}" /></label><label class="client-workflow-dialog-wide">Address line 1<input name="addressLine1" maxlength="160" value="${escapeHtml(client.company.addressLine1)}" /></label><label class="client-workflow-dialog-wide">Address line 2<input name="addressLine2" maxlength="160" value="${escapeHtml(client.company.addressLine2)}" /></label><label>City<input name="city" maxlength="100" value="${escapeHtml(client.company.city)}" /></label><label>State or region<input name="stateRegion" maxlength="100" value="${escapeHtml(client.company.stateRegion)}" /></label><label>Postal code<input name="postalCode" maxlength="24" value="${escapeHtml(client.company.postalCode)}" /></label><label>Country<input name="country" maxlength="100" value="${escapeHtml(client.company.country)}" /></label><label>Client stage<select name="lifecycleStage">${optionsMarkup(clientStageOptions(client.lifecycleStage), client.lifecycleStage)}</select></label>${canAssignOwner() ? `<label>Sales owner<select name="ownerId"><option value="">Unassigned</option>${owners.map(owner => `<option value="${escapeHtml(owner.id)}" ${owner.id === client.owner.id ? 'selected' : ''}>${escapeHtml(owner.name)}</option>`).join('')}</select></label>` : ''}</div>`;
    } else if (editorKind === 'contact') {
      title = 'Edit primary contact';
      body = `<div class="client-workflow-dialog-grid"><label>Full name<input name="contactName" required maxlength="140" value="${escapeHtml(client.primaryContact.name)}" /></label><label>Role or title<input name="contactTitle" maxlength="120" value="${escapeHtml(client.primaryContact.title)}" /></label><label>Email<input name="contactEmail" required type="email" maxlength="254" value="${escapeHtml(client.primaryContact.email)}" /></label><label>Phone<input name="contactPhone" type="tel" maxlength="60" value="${escapeHtml(client.primaryContact.phone)}" /></label></div>`;
    } else if (editorKind === 'request-add') {
      eyebrow = 'Hiring request'; title = 'Add another hiring request'; body = requestEditorFields();
    } else if (editorKind === 'request-edit' && request) {
      eyebrow = 'Hiring request'; title = `Edit ${request.roleTitle}`; body = requestEditorFields(request);
    } else if (editorKind === 'portal') {
      const actions = portalActions(client.portal);
      if (!actions.length) return '';
      eyebrow = 'Secure Client access'; title = 'Manage Client Portal'; body = `<div class="client-workflow-dialog-grid"><label>Action<select name="portalAction">${optionsMarkup(actions, actions[0][0])}</select></label><label>Sign-in email<input name="portalEmail" type="email" maxlength="254" value="${escapeHtml(client.portal.pendingAccess?.email || client.portal.email || client.primaryContact.email)}" /></label></div><p class="client-workflow-dialog-note">Access actions use the primary contact record and are logged by the secure service.</p>`;
    } else return '';
    return `<dialog class="client-workflow-dialog" data-client-workflow-dialog><form data-client-workflow-editor><div class="client-workflow-dialog-heading"><div><p class="eyebrow">${escapeHtml(eyebrow)}</p><h2>${escapeHtml(title)}</h2></div><button type="button" data-client-workflow-editor-close aria-label="Close">×</button></div>${body}<p class="client-workflow-dialog-message ${feedback.tone === 'error' ? 'is-error' : ''}" role="status" aria-live="polite">${escapeHtml(feedback.tone === 'error' ? feedback.message : '')}</p><div class="client-workflow-dialog-actions"><button class="button" type="button" data-client-workflow-editor-close>Cancel</button><button class="button primary" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Saving…' : 'Save changes'}</button></div></form></dialog>`;
  }

  function requestProgressMarkup(request) {
    const currentIndex = Math.max(0, PIPELINE_STEPS.findIndex(([key]) => key === request.progressStep));
    return `<ol class="client-workflow-progress" aria-label="${escapeHtml(request.roleTitle)} placement progress">${PIPELINE_STEPS.map(([key, label], index) => `<li class="${index < currentIndex ? 'is-complete' : index === currentIndex ? 'is-current' : ''}" ${index === currentIndex ? 'aria-current="step"' : ''}><span aria-hidden="true">${index < currentIndex ? '✓' : index + 1}</span><small>${escapeHtml(label)}</small></li>`).join('')}</ol>`;
  }

  function requestCardMarkup(request, clientId) {
    const skills = request.skills.map(skill => `<span>${escapeHtml(skill)}</span>`).join('');
    const nextAction = request.progressStep === 'request' ? 'Find Talent' : request.progressStep === 'shortlist' ? 'Open shortlist' : request.progressStep === 'client_review' ? 'Review responses' : request.progressStep === 'interview' ? 'Open interviews' : 'Continue workflow';
    const counts = [[request.candidateCount, 'candidate'], [request.interviewCount, 'interview'], [request.placementCount, 'placement']]
      .filter(([count]) => count !== null)
      .map(([count, label]) => `${count} ${label}${count === 1 ? '' : 's'}`)
      .join(' · ');
    const editableControls = canEditForRole() ? `<button class="text-button" type="button" data-client-workflow-edit-request="${escapeHtml(request.id)}">Edit request</button>` : '';
    const canOpenOperationalStep = canEditForRole() || ['interview', 'selection', 'placement', 'onboarding'].includes(request.progressStep);
    const controls = canOpenOperationalStep ? `<div>${editableControls}<button class="button" type="button" data-client-workflow-next="${escapeHtml(request.progressStep)}" data-client-id="${escapeHtml(clientId)}" data-request-id="${escapeHtml(request.id)}">${escapeHtml(nextAction)} →</button></div>` : '';
    return `<article class="client-workflow-request-card">
      <div class="client-workflow-request-head"><div><p class="eyebrow">${escapeHtml(request.vaType || 'Virtual Assistant')}</p><h3>${escapeHtml(request.roleTitle)}</h3></div><span class="client-workflow-status">${escapeHtml(titleCase(request.status))}</span></div>
      <dl class="client-workflow-request-facts"><div><dt>Openings</dt><dd>${request.seats}</dd></div><div><dt>Schedule</dt><dd>${escapeHtml(request.schedule || 'To confirm')}</dd></div><div><dt>Time zone</dt><dd>${escapeHtml(request.timeZone || 'To confirm')}</dd></div><div><dt>Target start</dt><dd>${escapeHtml(request.targetStartDate || 'To confirm')}</dd></div></dl>
      ${skills ? `<div class="client-workflow-skill-list" aria-label="Required skills">${skills}</div>` : ''}
      ${requestProgressMarkup(request)}
      ${counts || controls ? `<div class="client-workflow-request-footer">${counts ? `<span>${escapeHtml(counts)}</span>` : ''}${controls}</div>` : ''}
    </article>`;
  }

  function activityMarkup(activity) {
    if (!activity.length) return '<p class="client-workflow-empty">Activity will appear here as the Client moves through the workflow.</p>';
    return `<ol class="client-workflow-activity">${activity.map(item => `<li><span aria-hidden="true"></span><div><strong>${escapeHtml(item.label)}</strong>${item.detail ? `<p>${escapeHtml(item.detail)}</p>` : ''}<small>${item.timestamp ? escapeHtml(new Date(item.timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })) : 'Time not recorded'}</small></div></li>`).join('')}</ol>`;
  }

  function hubMarkup(client) {
    const requests = client.hiringRequests.map(request => requestCardMarkup(request, client.id)).join('');
    const portalAction = client.portal.pendingAccess ? 'Retry pending action' : client.portal.status === 'active' ? 'Send password reset' : client.portal.status === 'invite_pending' ? 'Send invite again' : client.portal.status === 'suspended' ? 'Reactivate access' : 'Send portal invite';
    const portalCanManage = portalActions(client.portal).length > 0;
    return `<main class="page client-workflow-page client-workflow-hub" data-client-workflow data-client-workflow-state="hub" data-client-id="${escapeHtml(client.id)}">
      <button class="client-workflow-back" type="button" data-client-workflow-back>← Back to Client Pipeline</button>
      <div class="dc-profile-link"><button type="button" class="button" data-document-profile="client" data-document-subject="${escapeHtml(client.id)}">Documents & requests</button></div>
      <header class="client-workflow-hub-heading">
        <span class="client-workflow-hub-mark" aria-hidden="true">${escapeHtml(initials(client.company.name))}</span>
        <div><p class="eyebrow">Client Hub</p><h1>${escapeHtml(client.company.name)}</h1><p>${escapeHtml(client.company.industry || 'Industry not recorded')} · Owned by ${escapeHtml(client.owner.name)}</p></div>
        ${canEditForRole() ? '<div class="heading-actions"><button class="button" type="button" data-client-workflow-add-request>+ Hiring request</button><button class="button primary" type="button" data-client-workflow-find-talent>Find Talent</button></div>' : '<span class="client-workflow-preview-note">View only</span>'}
      </header>
      ${feedbackMarkup()}
      <section class="client-workflow-hub-summary" aria-label="Client Hub summary">
        <article><span>Account stage</span><strong>${escapeHtml(titleCase(client.lifecycleStage))}</strong></article>
        <article><span>Primary contact</span><strong>${escapeHtml(client.primaryContact.name || 'Not recorded')}</strong></article>
        <article><span>Open requests</span><strong>${client.hiringRequests.filter(request => !['closed', 'filled', 'cancelled'].includes(request.status)).length}</strong></article>
        <article><span>Portal access</span><strong>${escapeHtml(portalStatusLabel(client.portal))}</strong></article>
      </section>
      <div class="client-workflow-hub-grid">
        <section class="panel client-workflow-hub-card" aria-labelledby="client-workflow-company-card-title"><div class="client-workflow-section-heading"><div><p class="eyebrow">Company</p><h2 id="client-workflow-company-card-title">Business &amp; owner</h2></div>${canEditForRole() ? '<button class="text-button" type="button" data-client-workflow-edit="company">Edit</button>' : ''}</div><dl class="client-workflow-detail-list"><div><dt>Company</dt><dd>${escapeHtml(client.company.name)}</dd></div><div><dt>Industry</dt><dd>${escapeHtml(client.company.industry || 'Not recorded')}</dd></div><div><dt>Company phone</dt><dd>${linkValue(client.company.phone, 'phone')}</dd></div><div><dt>Website</dt><dd>${escapeHtml(client.company.website || 'Not recorded')}</dd></div><div><dt>Address</dt><dd>${escapeHtml([client.company.addressLine1, client.company.addressLine2, [client.company.city, client.company.stateRegion].filter(Boolean).join(', '), [client.company.postalCode, client.company.country].filter(Boolean).join(' ')].filter(Boolean).join(' · ') || 'Not recorded')}</dd></div><div><dt>Sales owner</dt><dd>${escapeHtml(client.owner.name)}</dd></div></dl></section>
        <section class="panel client-workflow-hub-card" aria-labelledby="client-workflow-contact-card-title"><div class="client-workflow-section-heading"><div><p class="eyebrow">Active contact</p><h2 id="client-workflow-contact-card-title">Primary contact</h2></div>${canEditForRole() ? '<button class="text-button" type="button" data-client-workflow-edit="contact">Edit</button>' : ''}</div><dl class="client-workflow-detail-list"><div><dt>Name</dt><dd>${escapeHtml(client.primaryContact.name || 'Not recorded')}</dd></div><div><dt>Role</dt><dd>${escapeHtml(client.primaryContact.title || 'Not recorded')}</dd></div><div><dt>Email</dt><dd>${linkValue(client.primaryContact.email, 'email')}</dd></div><div><dt>Phone</dt><dd>${linkValue(client.primaryContact.phone, 'phone')}</dd></div></dl></section>
        <section class="panel client-workflow-hub-card client-workflow-portal-card" aria-labelledby="client-workflow-portal-card-title"><div class="client-workflow-section-heading"><div><p class="eyebrow">Secure Client access</p><h2 id="client-workflow-portal-card-title">Client Portal</h2></div><span class="client-workflow-status client-workflow-status--${escapeHtml(client.portal.status)}">${escapeHtml(portalStatusLabel(client.portal))}</span></div><p>Portal access is tied to <strong>${escapeHtml(client.portal.pendingAccess?.email || client.portal.email || client.primaryContact.email || 'the primary contact')}</strong>.</p>${canEditForRole() && portalCanManage ? `<div class="client-workflow-portal-actions"><button class="button" type="button" data-client-workflow-portal>${escapeHtml(portalAction)}</button><button class="text-button" type="button" data-client-workflow-edit="portal">Manage access</button></div>` : client.portal.status === 'needs_reconciliation' ? '<p class="client-workflow-dialog-note">This access relationship needs secure administrator reconciliation before another action is available.</p>' : ''}</section>
        <section class="panel client-workflow-activity-card" aria-labelledby="client-workflow-activity-title"><div class="client-workflow-section-heading"><div><p class="eyebrow">Complete history</p><h2 id="client-workflow-activity-title">Activity</h2></div></div>${activityMarkup(client.activity)}</section>
      </div>
      <section class="panel client-workflow-requests" aria-labelledby="client-workflow-requests-title"><div class="client-workflow-section-heading"><div><p class="eyebrow">Placement journey</p><h2 id="client-workflow-requests-title">Hiring requests</h2></div>${canEditForRole() ? '<button class="button" type="button" data-client-workflow-add-request>+ New request</button>' : ''}</div><div class="client-workflow-request-list">${requests || '<p class="client-workflow-empty">No hiring requests have been opened for this Client.</p>'}</div></section>
      ${editorMarkup(client)}
    </main>`;
  }

  function stateMarkup(title, message, state, retry = false) {
    return `<main class="page client-workflow-page" data-client-workflow data-client-workflow-state="${escapeHtml(state)}"><section class="panel client-workflow-state" ${state === 'loading' ? 'role="status" aria-busy="true"' : 'role="alert"'}><span aria-hidden="true"></span><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${retry ? '<button class="button" type="button" data-client-workflow-retry>Try again</button>' : ''}</section></main>`;
  }

  function render() {
    if (!mountedRoot) return;
    if (!canOpenForRole(viewerRole)) { mountedRoot.replaceChildren?.(); return; }
    if (phase === 'loading') mountedRoot.innerHTML = stateMarkup('Loading Client Pipeline', 'Retrieving the Clients assigned to this workspace.', 'loading');
    else if (phase === 'error') mountedRoot.innerHTML = stateMarkup('Client Pipeline unavailable', feedback.message || 'The Client workflow could not be loaded.', 'error', true);
    else if (phase === 'create') mountedRoot.innerHTML = formMarkup();
    else if (phase === 'hub') {
      const client = clients.find(record => record.id === selectedClientId);
      mountedRoot.innerHTML = client ? hubMarkup(client) : stateMarkup('Client unavailable', 'This Client could not be opened from the current workspace.', 'error');
    } else mountedRoot.innerHTML = pipelineMarkup();
    bind();
    if (phase === 'hub' && editorKind) mountedRoot.querySelector?.('[data-client-workflow-dialog]')?.showModal?.();
  }

  async function load() {
    const version = ++requestVersion;
    phase = 'loading';
    feedback = Object.freeze({ tone: '', message: '' });
    render();
    try {
      const workspace = typeof activeAdapter.loadWorkspace === 'function'
        ? await activeAdapter.loadWorkspace()
        : { owners: await activeAdapter.listOwners(), clients: await activeAdapter.listClients() };
      if (version !== requestVersion) return;
      owners = (Array.isArray(workspace.owners) ? workspace.owners : []).map(normalizeOwner).filter(Boolean);
      if (viewerRole === 'sales') {
        owners = owners.map(owner => Object.freeze({ ...owner, current: owner.current || owner.id === currentUserId() }));
        if (!owners.some(owner => owner.current)) owners.unshift(normalizeOwner({ id: currentUserId(), name: currentUserName(), current: true }));
      }
      clients = (Array.isArray(workspace.clients) ? workspace.clients : []).map(client => normalizeClient(client)).filter(Boolean);
      phase = selectedClientId && clients.some(client => client.id === selectedClientId) ? 'hub' : 'pipeline';
    } catch (error) {
      if (version !== requestVersion) return;
      phase = 'error';
      feedback = Object.freeze({ tone: 'error', message: text(error?.message, 300) || 'The Client workflow could not be loaded.' });
    }
    render();
  }

  function formValues(form) {
    const data = new FormData(form);
    return {
      companyName: data.get('companyName'), industry: data.get('industry'), website: data.get('website'), companyPhone: data.get('companyPhone'),
      addressLine1: data.get('addressLine1'), addressLine2: data.get('addressLine2'), city: data.get('city'), stateRegion: data.get('stateRegion'), postalCode: data.get('postalCode'), country: data.get('country'),
      contactName: data.get('contactName'), contactTitle: data.get('contactTitle'), contactEmail: data.get('contactEmail'), contactPhone: data.get('contactPhone'),
      ownerId: data.get('ownerId'), roleTitle: data.get('roleTitle'), vaType: data.get('vaType'), seats: data.get('seats'), skills: data.get('skills'),
      schedule: data.get('schedule'), timeZone: data.get('timeZone'), targetStartDate: data.get('targetStartDate'), portalInvite: data.get('portalInvite') === 'on'
    };
  }

  async function submitCreate(event) {
    event.preventDefault();
    if (busy || !canEditForRole()) return;
    const form = event.currentTarget;
    try {
      const bundle = normalizeBundle(formValues(form));
      busy = true;
      feedback = Object.freeze({ tone: '', message: '' });
      render();
      const outcome = await activeAdapter.createClientBundle(bundle);
      const created = normalizeClient(outcome?.client || outcome);
      if (!created) throw new Error('The Client record could not be verified after creation.');
      clients = [created, ...clients.filter(client => client.id !== created.id)];
      selectedClientId = created.id;
      phase = 'hub';
      const warning = text(outcome?.warning, 300);
      feedback = Object.freeze({ tone: warning ? 'error' : 'success', message: warning ? `Client and first hiring request created. Portal access needs attention: ${warning}` : 'Client and first hiring request created together.' });
    } catch (error) {
      phase = 'create';
      feedback = Object.freeze({ tone: 'error', message: text(error?.message, 300) || 'Check the required Client details and try again.' });
    } finally {
      busy = false;
      render();
    }
  }

  async function resendPortalInvite() {
    if (busy || !selectedClientId || !canEditForRole()) return;
    const client = clients.find(record => record.id === selectedClientId);
    if (!client) return;
    const action = primaryPortalAction(client.portal);
    if (!action) return;
    busy = true;
    feedback = Object.freeze({ tone: '', message: '' });
    render();
    try {
      const updated = normalizeClient(typeof activeAdapter.changePortalAccess === 'function'
        ? await activeAdapter.changePortalAccess(client, action)
        : await activeAdapter.resendPortalInvite(client));
      if (!updated) throw new Error('The portal invitation could not be prepared.');
      clients = clients.map(client => client.id === updated.id ? updated : client);
      feedback = Object.freeze({ tone: 'success', message: 'Client Portal invitation prepared for the primary contact.' });
    } catch (error) {
      feedback = Object.freeze({ tone: 'error', message: text(error?.message, 300) || 'The portal invitation could not be prepared.' });
    } finally {
      busy = false;
      render();
    }
  }

  function dispatchWorkflowAction(action, detail = {}) {
    if (!canEditForRole()) return;
    if (typeof root?.CustomEvent === 'function' && typeof root?.dispatchEvent === 'function') {
      root.dispatchEvent(new root.CustomEvent('soro:client-workflow-action', { detail: { action, clientId: selectedClientId, ...detail } }));
    }
    feedback = Object.freeze({ tone: '', message: `${action === 'add_request' ? 'New hiring request' : action === 'find_talent' ? 'Talent matching' : 'This workflow step'} is ready for the next secure backend slice.` });
    render();
  }

  function openEditor(kind, requestId = '') {
    if (!canEditForRole()) return;
    editorKind = text(kind, 40);
    editorRequestId = text(requestId, 80);
    feedback = Object.freeze({ tone: '', message: '' });
    render();
  }

  function closeEditor() {
    editorKind = '';
    editorRequestId = '';
    feedback = Object.freeze({ tone: '', message: '' });
    render();
  }

  function requestValues(data) {
    const roleTitle = text(data.get('roleTitle'), 160);
    if (!roleTitle) throw new Error('Enter the role title.');
    return Object.freeze({
      roleTitle,
      vaType: text(data.get('vaType'), 120),
      seats: positiveInteger(data.get('seats'), 1),
      skills: Object.freeze(list(data.get('skills'))),
      schedule: text(data.get('schedule'), 180),
      timeZone: text(data.get('timeZone'), 100),
      targetStartDate: safeDate(data.get('targetStartDate'))
    });
  }

  async function submitEditor(event) {
    event.preventDefault();
    if (busy || !canEditForRole()) return;
    let client = clients.find(record => record.id === selectedClientId);
    if (!client) return;
    const data = new FormData(event.currentTarget);
    busy = true;
    feedback = Object.freeze({ tone: '', message: '' });
    render();
    try {
      let updated = null;
      if (editorKind === 'company') {
        const company = { name: text(data.get('companyName'), 160), industry: text(data.get('industry'), 120), website: text(data.get('website'), 200), phone: text(data.get('companyPhone'), 40), addressLine1: text(data.get('addressLine1'), 160), addressLine2: text(data.get('addressLine2'), 160), city: text(data.get('city'), 100), stateRegion: text(data.get('stateRegion'), 100), postalCode: text(data.get('postalCode'), 24), country: text(data.get('country'), 100) };
        if (!company.name) throw new Error('Enter the company name.');
        updated = normalizeClient(await activeAdapter.updateCompany(client, company));
        if (!updated) throw new Error('The updated Client could not be verified.');
        const ownerId = text(data.get('ownerId'), 80);
        if (canAssignOwner() && ownerId !== updated.owner.id && typeof activeAdapter.assignOwner === 'function') {
          updated = normalizeClient(await activeAdapter.assignOwner(updated, ownerId));
        }
        const nextStage = text(data.get('lifecycleStage'), 50).toLowerCase();
        if (nextStage && nextStage !== updated.lifecycleStage) updated = normalizeClient(await activeAdapter.updateClientStatus(updated, nextStage));
      } else if (editorKind === 'contact') {
        const primaryContact = { name: text(data.get('contactName'), 140), title: text(data.get('contactTitle'), 120), email: safeEmail(data.get('contactEmail')), phone: text(data.get('contactPhone'), 60) };
        if (!primaryContact.name || !primaryContact.email) throw new Error('Enter a contact name and valid email.');
        updated = normalizeClient(await activeAdapter.updatePrimaryContact(client, primaryContact));
      } else if (editorKind === 'request-add') {
        updated = normalizeClient(await activeAdapter.addHiringRequest(client, requestValues(data)));
      } else if (editorKind === 'request-edit') {
        const request = client.hiringRequests.find(candidate => candidate.id === editorRequestId);
        if (!request) throw new Error('Reload this hiring request and try again.');
        updated = normalizeClient(await activeAdapter.updateHiringRequest(client, request, requestValues(data)));
        if (!updated) throw new Error('The updated hiring request could not be verified.');
        const refreshedRequest = updated.hiringRequests.find(candidate => candidate.id === request.id);
        const nextStatus = text(data.get('status'), 40).toLowerCase();
        if (refreshedRequest && nextStatus && nextStatus !== refreshedRequest.status) updated = normalizeClient(await activeAdapter.setHiringRequestStatus(updated, refreshedRequest, nextStatus));
      } else if (editorKind === 'portal') {
        const action = text(data.get('portalAction'), 40).toLowerCase();
        const email = safeEmail(data.get('portalEmail'));
        if ((action === 'activate' || action === 'change_email') && !email) throw new Error('Enter a valid Client Portal sign-in email.');
        updated = normalizeClient(await activeAdapter.changePortalAccess(client, action, { email, portalRole: 'client_admin' }));
      }
      if (!updated) throw new Error('The Client update could not be verified.');
      clients = clients.map(record => record.id === updated.id ? updated : record);
      editorKind = '';
      editorRequestId = '';
      feedback = Object.freeze({ tone: 'success', message: 'Client Hub updated.' });
    } catch (error) {
      feedback = Object.freeze({ tone: 'error', message: text(error?.message, 300) || 'The Client Hub could not be updated.' });
    } finally {
      busy = false;
      render();
    }
  }

  function bind() {
    if (!mountedRoot?.querySelector) return;
    mountedRoot.querySelectorAll?.('[data-client-workflow-create]')?.forEach(button => button.addEventListener('click', openCreate));
    mountedRoot.querySelectorAll?.('[data-client-workflow-back]')?.forEach(button => button.addEventListener('click', openPipeline));
    mountedRoot.querySelectorAll?.('[data-client-workflow-client]')?.forEach(button => button.addEventListener('click', () => openHub(button.dataset.clientWorkflowClient)));
    mountedRoot.querySelector?.('[data-client-workflow-form]')?.addEventListener('submit', submitCreate);
    mountedRoot.querySelector?.('[data-client-workflow-retry]')?.addEventListener('click', load);
    mountedRoot.querySelector?.('[data-client-workflow-portal]')?.addEventListener('click', resendPortalInvite);
    mountedRoot.querySelectorAll?.('[data-client-workflow-add-request]')?.forEach(button => button.addEventListener('click', () => openEditor('request-add')));
    mountedRoot.querySelector?.('[data-client-workflow-find-talent]')?.addEventListener('click', () => dispatchWorkflowAction('find_talent'));
    mountedRoot.querySelectorAll?.('[data-client-workflow-next]')?.forEach(button => button.addEventListener('click', () => dispatchWorkflowAction(button.dataset.clientWorkflowNext, { requestId: button.dataset.requestId })));
    mountedRoot.querySelectorAll?.('[data-client-workflow-edit]')?.forEach(button => button.addEventListener('click', () => openEditor(button.dataset.clientWorkflowEdit)));
    if (root.soroCurrentAccess?.role === 'admin') {
      const heading = mountedRoot.querySelector?.('#client-workflow-company-card-title')?.closest('.client-workflow-section-heading');
      if (heading) {
        const ownerButton = root.document.createElement('button');
        ownerButton.type = 'button'; ownerButton.className = 'text-button'; ownerButton.textContent = 'Reassign owner';
        ownerButton.addEventListener('click', () => root.SoroStaffAccount?.openOwnership('client', selectedClientId, 'sales', load));
        heading.append(ownerButton);
      }
    }
    mountedRoot.querySelectorAll?.('[data-client-workflow-edit-request]')?.forEach(button => button.addEventListener('click', () => openEditor('request-edit', button.dataset.clientWorkflowEditRequest)));
    mountedRoot.querySelector?.('[data-client-workflow-editor]')?.addEventListener('submit', submitEditor);
    mountedRoot.querySelectorAll?.('[data-client-workflow-editor-close]')?.forEach(button => button.addEventListener('click', closeEditor));
    mountedRoot.querySelectorAll?.('[data-client-workflow-placeholder]')?.forEach(button => button.addEventListener('click', () => dispatchWorkflowAction(button.dataset.clientWorkflowPlaceholder)));
  }

  function openPipeline() {
    selectedClientId = '';
    phase = 'pipeline';
    feedback = Object.freeze({ tone: '', message: '' });
    editorKind = '';
    editorRequestId = '';
    render();
  }

  function openCreate() {
    if (!canEditForRole()) return;
    phase = 'create';
    feedback = Object.freeze({ tone: '', message: '' });
    editorKind = '';
    editorRequestId = '';
    render();
    mountedRoot?.querySelector?.('[name="companyName"]')?.focus?.();
  }

  function openHub(clientId) {
    const normalized = text(clientId, 80);
    if (!clients.some(client => client.id === normalized)) return;
    selectedClientId = normalized;
    phase = 'hub';
    feedback = Object.freeze({ tone: '', message: '' });
    editorKind = '';
    editorRequestId = '';
    render();
  }

  async function mount(target, options = {}) {
    mountedRoot = target || null;
    viewerRole = normalizedRole(options.role || root?.soroCurrentAccess?.role);
    activeAdapter = options.adapter || createEndpointAdapter(options.endpointOptions);
    selectedClientId = text(options.clientId, 80);
    if (!mountedRoot || !canOpenForRole(viewerRole)) {
      mountedRoot?.replaceChildren?.();
      return false;
    }
    await load();
    if (options.start === 'create' && canEditForRole()) openCreate();
    return true;
  }

  function unmount(options = {}) {
    requestVersion += 1;
    if (options.clear !== false) mountedRoot?.replaceChildren?.();
    mountedRoot = null;
    selectedClientId = '';
    phase = 'idle';
    feedback = Object.freeze({ tone: '', message: '' });
    editorKind = '';
    editorRequestId = '';
  }

  return Object.freeze({
    ENDPOINT,
    PORTAL_ACCESS_ENDPOINT,
    PIPELINE_STEPS,
    canAssignOwner,
    canEditForRole,
    canOpenForRole,
    clientStageOptions,
    createApprovalAdapter,
    createEndpointAdapter,
    defaultSeed,
    hubMarkup,
    mount,
    normalizeBundle,
    normalizeClient,
    openCreate,
    openHub,
    openPipeline,
    pipelineMarkup,
    requestStatusOptions,
    unmount
  });
}));
