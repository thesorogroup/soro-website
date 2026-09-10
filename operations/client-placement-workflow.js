/* Soro Client interview, decision, placement handoff, and onboarding workspace. */
(function attachSoroClientPlacementWorkflow(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SoroClientPlacementWorkflow = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createSoroClientPlacementWorkflow(root) {
  'use strict';

  const ENDPOINT = '/.netlify/functions/client-placement-workflow';
  const INTERNAL_ROLES = new Set(['admin', 'founder', 'sales_management', 'sales', 'talent_management']);
  const CLIENT_ROLES = new Set(['client_admin', 'client_reviewer']);
  const AUTHORIZED_ROLES = new Set([...INTERNAL_ROLES, ...CLIENT_ROLES]);
  const MUTATION_RETRY_TTL_MS = 15 * 60 * 1000;
  const MUTATION_RETRY_LIMIT = 40;
  const ACTION_FIELDS = Object.freeze({
    schedule_interview: Object.freeze(['expectedUpdatedAt', 'shortlistItemId', 'startsAt', 'durationMinutes', 'timezone']),
    reschedule_interview: Object.freeze(['expectedUpdatedAt', 'interviewId', 'startsAt', 'durationMinutes', 'timezone']),
    cancel_interview: Object.freeze(['expectedUpdatedAt', 'interviewId', 'note']),
    record_interview_outcome: Object.freeze(['expectedUpdatedAt', 'interviewId', 'status', 'outcome', 'note']),
    retry_calendar_sync: Object.freeze(['expectedUpdatedAt', 'interviewId']),
    final_decision: Object.freeze(['expectedUpdatedAt', 'shortlistItemId', 'decision']),
    prepare_handoff: Object.freeze(['expectedUpdatedAt', 'decisionId', 'startDate', 'scheduleSummary', 'rateType', 'clientRate', 'talentRate']),
    confirm_placement: Object.freeze(['expectedUpdatedAt', 'handoffId']),
    update_onboarding: Object.freeze(['expectedUpdatedAt', 'onboardingItemId', 'status']),
    activate_placement: Object.freeze(['expectedUpdatedAt', 'placementId'])
  });

  let mountedRoot = null;
  let activeAdapter = null;
  let mountedOptions = {};
  let hiringRequestId = '';
  let requestedRole = '';
  let workspace = null;
  let phase = 'idle';
  let busy = false;
  let pendingMutation = null;
  let feedback = Object.freeze({ tone: '', message: '' });
  let editor = null;
  let loadVersion = 0;

  function text(value, maximum = 240) {
    return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, maximum);
  }

  function multiline(value, maximum = 4000) {
    return String(value ?? '').trim().replace(/\r\n?/g, '\n').slice(0, maximum);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]));
  }

  function normalizedRole(value) {
    const role = text(value, 60).toLowerCase().replace(/[\s-]+/g, '_');
    if (role === 'administrator') return 'admin';
    if (role === 'talent_manager' || role === 'talent_management_panel') return 'talent_management';
    if (role === 'client_reviewer_read_only') return 'client_reviewer';
    return role;
  }

  function titleCase(value) {
    return text(value, 100).replace(/[_-]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
  }

  function safeTimestamp(value) {
    const normalized = text(value, 60);
    return normalized && Number.isFinite(Date.parse(normalized)) ? new Date(normalized).toISOString() : '';
  }

  function safeDate(value) {
    const normalized = text(value, 20);
    return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : '';
  }

  function safeUrl(value) {
    const normalized = text(value, 2048);
    if (!normalized) return '';
    try {
      const parsed = new URL(normalized);
      return ['https:', 'http:'].includes(parsed.protocol) ? parsed.href : '';
    } catch {
      return '';
    }
  }

  function safeInteger(value, fallback = 0) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
  }

  function safeMoney(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.round(number * 100) / 100 : 0;
  }

  function formatDateTime(value, timezone = '') {
    const timestamp = safeTimestamp(value);
    if (!timestamp) return 'Time not available';
    const options = { dateStyle: 'medium', timeStyle: 'short' };
    if (timezone) options.timeZone = timezone;
    try { return new Intl.DateTimeFormat('en-US', options).format(new Date(timestamp)); } catch {
      return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
    }
  }

  function formatDate(value) {
    const date = safeDate(value);
    if (!date) return 'Not scheduled';
    return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
  }

  function formatMoney(value) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(safeMoney(value));
  }

  function roleLabel(role) {
    return ({
      admin: 'Admin', founder: 'Founder', sales_management: 'Sales Management', sales: 'Sales',
      talent_management: 'Talent Management', client_admin: 'Client Administrator', client_reviewer: 'Client Reviewer'
    })[normalizedRole(role)] || titleCase(role);
  }

  function isClientRole(role) {
    return CLIENT_ROLES.has(normalizedRole(role));
  }

  function canOpenForRole(role) {
    return AUTHORIZED_ROLES.has(normalizedRole(role));
  }

  function copyPermissions(source) {
    const value = source && typeof source === 'object' ? source : {};
    return Object.freeze({
      scheduleInterview: value.scheduleInterview === true,
      finalDecision: value.finalDecision === true,
      prepareHandoff: value.prepareHandoff === true,
      confirmPlacement: value.confirmPlacement === true,
      manageOnboarding: value.manageOnboarding === true
    });
  }

  function normalizeInterview(source, clientSafe) {
    if (!source || typeof source !== 'object') return null;
    const calendarSource = source.calendar && typeof source.calendar === 'object' ? source.calendar : {};
    const rawCalendarStatus = text(calendarSource.status, 40).toLowerCase() || 'pending';
    const calendarStatus = clientSafe ? (rawCalendarStatus === 'synced' ? 'synced' : 'pending') : rawCalendarStatus;
    const needsCreateRetry = !clientSafe && (
      calendarSource.needsCreateRetry === true
      || (calendarSource.needsCreateRetry !== false
        && ['pending', 'sync_failed', 'connection_required'].includes(rawCalendarStatus))
    );
    const record = {
      interviewId: text(source.interviewId || source.id, 100),
      roundNumber: Math.max(1, safeInteger(source.roundNumber, 1)),
      status: text(source.status, 40).toLowerCase() || 'scheduled',
      startsAt: safeTimestamp(source.startsAt),
      endsAt: safeTimestamp(source.endsAt),
      timezone: text(source.timezone, 100) || 'UTC',
      calendar: Object.freeze({ status: calendarStatus, joinUrl: safeUrl(calendarSource.joinUrl), needsCreateRetry }),
      updatedAt: safeTimestamp(source.updatedAt) || safeTimestamp(source.startsAt)
    };
    if (!clientSafe) {
      record.outcome = text(source.outcome, 40).toLowerCase();
      record.notes = multiline(source.notes, 4000);
    }
    return Object.freeze(record);
  }

  function normalizeCandidate(source, clientSafe) {
    if (!source || typeof source !== 'object') return null;
    const applicantSource = source.applicant && typeof source.applicant === 'object' ? source.applicant : {};
    const fullName = text(applicantSource.fullName, 180);
    if (!fullName) return null;
    const applicant = {
      applicantId: text(applicantSource.applicantId || applicantSource.id, 100),
      fullName,
      preferredName: text(applicantSource.preferredName, 100)
    };
    if (!clientSafe) applicant.email = text(applicantSource.email, 254).toLowerCase();
    const decisionSource = source.decision && typeof source.decision === 'object' ? source.decision : null;
    return Object.freeze({
      shortlistItemId: text(source.shortlistItemId || source.id, 100),
      shortlistId: text(source.shortlistId, 100),
      clientResponse: text(source.clientResponse, 40).toLowerCase(),
      workflowState: text(source.workflowState, 40).toLowerCase() || 'active',
      updatedAt: safeTimestamp(source.updatedAt),
      applicant: Object.freeze(applicant),
      interviews: Object.freeze((Array.isArray(source.interviews) ? source.interviews : []).map(item => normalizeInterview(item, clientSafe)).filter(Boolean)),
      decision: decisionSource ? Object.freeze({
        decisionId: text(decisionSource.decisionId || decisionSource.id, 100),
        decision: text(decisionSource.decision, 30).toLowerCase(),
        createdAt: safeTimestamp(decisionSource.createdAt)
      }) : null
    });
  }

  function normalizeHandoff(source) {
    if (!source || typeof source !== 'object') return null;
    return Object.freeze({
      handoffId: text(source.handoffId || source.id, 100),
      decisionId: text(source.decisionId, 100),
      shortlistItemId: text(source.shortlistItemId, 100),
      applicantId: text(source.applicantId, 100),
      status: text(source.status, 40).toLowerCase(),
      startDate: safeDate(source.startDate),
      scheduleSummary: text(source.scheduleSummary, 1000),
      rateType: text(source.rateType, 60),
      clientRate: safeMoney(source.clientRate),
      talentRate: safeMoney(source.talentRate),
      placementId: text(source.placementId, 100),
      updatedAt: safeTimestamp(source.updatedAt)
    });
  }

  function normalizeOnboardingItem(source) {
    if (!source || typeof source !== 'object') return null;
    return Object.freeze({
      onboardingItemId: text(source.onboardingItemId || source.id, 100),
      itemKey: text(source.itemKey, 60),
      title: text(source.title, 180),
      required: source.required === true,
      status: text(source.status, 20).toLowerCase() === 'completed' ? 'completed' : 'pending',
      updatedAt: safeTimestamp(source.updatedAt)
    });
  }

  function normalizePlacement(source, clientSafe) {
    if (!source || typeof source !== 'object') return null;
    return Object.freeze({
      placementId: text(source.placementId || source.id, 100),
      applicantId: text(source.applicantId, 100),
      status: text(source.status, 40).toLowerCase(),
      startDate: safeDate(source.startDate),
      endDate: safeDate(source.endDate),
      scheduleSummary: text(source.scheduleSummary, 1000),
      updatedAt: safeTimestamp(source.updatedAt),
      onboardingItems: Object.freeze(clientSafe ? [] : (Array.isArray(source.onboardingItems) ? source.onboardingItems : []).map(normalizeOnboardingItem).filter(Boolean))
    });
  }

  function normalizeWorkspace(source, roleOverride = '') {
    if (!source || typeof source !== 'object') return null;
    const requestSource = source.request && typeof source.request === 'object' ? source.request : {};
    const serverRole = normalizedRole(source.viewerRole);
    const overrideRole = normalizedRole(roleOverride);
    // The server projection is authoritative. Founder is a display-level alias
    // for the authenticated Admin overseer account and does not expand access.
    const role = overrideRole === 'founder' && serverRole === 'admin'
      ? 'founder'
      : (serverRole || overrideRole);
    if (!canOpenForRole(role)) return null;
    const companyName = text(requestSource.companyName, 180);
    const title = text(requestSource.title, 180);
    const requestId = text(requestSource.hiringRequestId || requestSource.id, 100);
    if (!companyName || !title || !requestId) return null;
    const clientSafe = isClientRole(role);
    const normalized = {
      generatedAt: safeTimestamp(source.generatedAt) || new Date().toISOString(),
      viewerRole: role,
      request: Object.freeze({
        hiringRequestId: requestId,
        clientId: text(requestSource.clientId, 100),
        companyName,
        title,
        status: text(requestSource.status, 40).toLowerCase(),
        seats: Math.max(1, safeInteger(requestSource.seats, 1)),
        filledSeats: safeInteger(requestSource.filledSeats, 0),
        updatedAt: safeTimestamp(requestSource.updatedAt)
      }),
      permissions: copyPermissions(source.permissions),
      calendarIntegration: Object.freeze({
        configured: source.calendarIntegration?.configured === true,
        organizerLabel: text(source.calendarIntegration?.organizerLabel, 100) || 'Soro Client Interviews'
      }),
      candidates: Object.freeze((Array.isArray(source.candidates) ? source.candidates : []).map(item => normalizeCandidate(item, clientSafe)).filter(Boolean)),
      handoffs: Object.freeze(clientSafe ? [] : (Array.isArray(source.handoffs) ? source.handoffs : []).map(normalizeHandoff).filter(Boolean)),
      placements: Object.freeze((Array.isArray(source.placements) ? source.placements : []).map(item => normalizePlacement(item, clientSafe)).filter(Boolean)),
      calendarSyncPending: source.calendarSyncPending === true
    };
    if (['admin','sales_management','sales'].includes(role)) {
      normalized.emailDeliveryUnavailable = source.emailDeliveryUnavailable === true;
      normalized.emailDeliveries = (Array.isArray(source.emailDeliveries) ? source.emailDeliveries : []).filter(row =>
        ['sentCount','pendingCount','reviewCount'].every(key=>Number.isSafeInteger(row?.[key])&&row[key]>=0)
      ).map(row=>Object.freeze({sentCount:row.sentCount,pendingCount:row.pendingCount,reviewCount:row.reviewCount}));
    }
    return Object.freeze(normalized);
  }

  function requestIdFactory() {
    const cryptoApi = root?.crypto || (typeof crypto !== 'undefined' ? crypto : null);
    if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
    if (typeof cryptoApi?.getRandomValues === 'function') {
      const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    throw new Error('This browser cannot safely create a placement request. Refresh in a current browser.');
  }

  function buildActionPayload(action, requestId, values = {}) {
    const fields = ACTION_FIELDS[action];
    if (!fields) throw new Error('Choose a supported Client placement action.');
    const operationId = text(requestId, 100);
    const request = text(values.hiringRequestId, 100);
    if (!operationId || !request) throw new Error('The placement request is missing its secure identifiers.');
    const payload = { action, requestId: operationId, hiringRequestId: request };
    fields.forEach(field => {
      if (!Object.prototype.hasOwnProperty.call(values, field)) throw new Error(`The ${field} field is required.`);
      payload[field] = values[field];
    });
    return payload;
  }

  function createEndpointAdapter(options = {}) {
    const endpoint = text(options.endpoint, 240) || ENDPOINT;
    const fetchImpl = options.fetch || root?.fetch?.bind(root);
    const makeRequestId = options.createRequestId || requestIdFactory;
    const mutationRetries = new Map();
    let mutationRetryOwner = '';
    async function accessToken() {
      if (typeof options.getAccessToken === 'function') {
        const supplied = await options.getAccessToken();
        if (text(supplied, 4096)) return text(supplied, 4096);
      }
      const result = await root?.soroSupabase?.auth?.getSession?.();
      const token = result?.data?.session?.access_token;
      if (!token) throw new Error('Your secure session has expired. Sign in again.');
      return token;
    }
    async function request(url, method, body) {
      if (typeof fetchImpl !== 'function') throw new Error('The secure Client placement service is unavailable.');
      const token = await accessToken();
      const response = await fetchImpl(url, {
        method,
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {})
        },
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {})
      });
      let data;
      try {
        data = await response.json();
      } catch (cause) {
        const error = new Error(response.ok
          ? 'The Client placement response could not be verified. Try the same action again.'
          : 'The Client placement workflow could not be updated.');
        if (!response.ok) error.status = response.status;
        error.cause = cause;
        throw error;
      }
      if (!response.ok) {
        const error = new Error(text(data.message || data.error, 300) || 'The Client placement workflow could not be updated.');
        error.status = response.status;
        error.code = text(data.code, 80);
        throw error;
      }
      return data;
    }
    function retryOwner() {
      const access = root?.soroCurrentAccess || {};
      return JSON.stringify({
        userId: text(access.user_id || access.userId, 160),
        role: normalizedRole(access.role),
        organizationId: text(access.organization_id || access.organizationId, 160)
      });
    }
    function stableValue(value) {
      if (Array.isArray(value)) return value.map(stableValue);
      if (!value || typeof value !== 'object') return value;
      return Object.keys(value).sort().reduce((result, key) => {
        if (value[key] !== undefined) result[key] = stableValue(value[key]);
        return result;
      }, {});
    }
    function pruneRetries(now = Date.now()) {
      for (const [fingerprint, entry] of mutationRetries) {
        if (!entry || now - entry.lastUsedAt > MUTATION_RETRY_TTL_MS) mutationRetries.delete(fingerprint);
      }
      while (mutationRetries.size > MUTATION_RETRY_LIMIT) {
        const oldest = [...mutationRetries.entries()].sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
        if (!oldest) break;
        mutationRetries.delete(oldest[0]);
      }
    }
    function prepareAttempt(action, values) {
      const owner = retryOwner();
      if (owner !== mutationRetryOwner) {
        mutationRetries.clear();
        mutationRetryOwner = owner;
      }
      const sanitized = buildActionPayload(action, 'fingerprint', values);
      delete sanitized.requestId;
      const fingerprint = JSON.stringify(stableValue({ owner, endpoint, ...sanitized }));
      const now = Date.now();
      pruneRetries(now);
      let entry = mutationRetries.get(fingerprint);
      if (!entry) {
        entry = { requestId: makeRequestId(), lastUsedAt: now };
        mutationRetries.set(fingerprint, entry);
        pruneRetries(now);
      } else {
        entry.lastUsedAt = now;
      }
      return Object.freeze({ fingerprint, requestId: entry.requestId, owner });
    }
    function retainAttempt(attempt) {
      const entry = mutationRetries.get(attempt.fingerprint);
      if (entry?.requestId === attempt.requestId) entry.lastUsedAt = Date.now();
    }
    function settleAttempt(attempt, error = null) {
      const entry = mutationRetries.get(attempt.fingerprint);
      if (!entry || entry.requestId !== attempt.requestId) return;
      const status = Number(error?.status);
      const ambiguous = !Number.isInteger(status) || status === 408 || status === 429 || status >= 500;
      if (!error || !ambiguous) mutationRetries.delete(attempt.fingerprint);
      else retainAttempt(attempt);
    }
    return Object.freeze({
      kind: 'endpoint',
      async loadWorkflow(requestId) {
        const id = text(requestId, 100);
        if (!id) throw new Error('Choose a hiring request to open.');
        return request(`${endpoint}?hiringRequestId=${encodeURIComponent(id)}`, 'GET');
      },
      async mutate(action, values, verify = null) {
        const attempt = prepareAttempt(action, values);
        let mutationAccepted = false;
        try {
          const result = await request(endpoint, 'POST', buildActionPayload(action, attempt.requestId, values));
          mutationAccepted = true;
          if (attempt.owner !== mutationRetryOwner || attempt.owner !== retryOwner()) {
            throw new Error('Your Soro account changed before this placement action finished. Review the workflow and try again.');
          }
          const verified = typeof verify === 'function' ? await verify(result) : result;
          settleAttempt(attempt);
          return verified;
        } catch (error) {
          if (mutationAccepted) retainAttempt(attempt);
          else settleAttempt(attempt, error);
          throw error;
        }
      }
    });
  }

  function deepCopy(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function defaultSeed(role = 'sales') {
    const viewerRole = normalizedRole(role) || 'sales';
    return {
      generatedAt: '2026-09-01T15:00:00.000Z',
      viewerRole: viewerRole === 'founder' ? 'admin' : viewerRole,
      request: {
        hiringRequestId: '10000000-0000-4000-8000-000000000001',
        clientId: '10000000-0000-4000-8000-000000000002',
        companyName: 'Brightlane Medical',
        title: 'Medical Virtual Assistant', status: 'interviewing', seats: 2, filledSeats: 0,
        updatedAt: '2026-09-01T14:55:00.000Z'
      },
      permissions: {
        scheduleInterview: ['admin', 'sales_management', 'sales'].includes(viewerRole),
        finalDecision: viewerRole === 'client_admin',
        prepareHandoff: ['admin', 'sales_management', 'sales'].includes(viewerRole),
        confirmPlacement: ['admin', 'talent_management'].includes(viewerRole) || viewerRole === 'founder',
        manageOnboarding: ['admin', 'talent_management'].includes(viewerRole) || viewerRole === 'founder'
      },
      calendarIntegration: { configured: true, organizerLabel: 'Soro Client Interviews' },
      candidates: [
        {
          shortlistItemId: '20000000-0000-4000-8000-000000000001', shortlistId: '20000000-0000-4000-8000-000000000002',
          clientResponse: 'request_interview', workflowState: 'active', updatedAt: '2026-09-01T14:30:00.000Z',
          applicant: { applicantId: '20000000-0000-4000-8000-000000000003', fullName: 'Avery Santos', preferredName: 'Avery', email: 'avery@example.test' },
          interviews: [{
            interviewId: '20000000-0000-4000-8000-000000000004', roundNumber: 1, status: 'scheduled',
            startsAt: '2026-09-04T16:00:00.000Z', endsAt: '2026-09-04T16:45:00.000Z', timezone: 'America/Chicago',
            outcome: null, notes: 'Internal preparation note', calendar: { status: 'sync_failed', joinUrl: null, needsCreateRetry: true },
            updatedAt: '2026-09-01T14:40:00.000Z'
          }]
        },
        {
          shortlistItemId: '30000000-0000-4000-8000-000000000001', shortlistId: '20000000-0000-4000-8000-000000000002',
          clientResponse: 'interested', workflowState: 'active', updatedAt: '2026-09-01T14:35:00.000Z',
          applicant: { applicantId: '30000000-0000-4000-8000-000000000002', fullName: 'Morgan Reyes', preferredName: 'Morgan', email: 'morgan@example.test' },
          interviews: []
        },
        {
          shortlistItemId: '40000000-0000-4000-8000-000000000001', shortlistId: '20000000-0000-4000-8000-000000000002',
          clientResponse: 'interested', workflowState: 'selected', updatedAt: '2026-09-01T14:38:00.000Z',
          applicant: { applicantId: '40000000-0000-4000-8000-000000000002', fullName: 'Casey Lim', preferredName: 'Casey', email: 'casey@example.test' },
          interviews: [], decision: { decisionId: '40000000-0000-4000-8000-000000000003', decision: 'selected', createdAt: '2026-09-01T14:38:00.000Z' }
        }
      ],
      handoffs: [{
        handoffId: '50000000-0000-4000-8000-000000000001', decisionId: '40000000-0000-4000-8000-000000000003',
        shortlistItemId: '40000000-0000-4000-8000-000000000001', applicantId: '40000000-0000-4000-8000-000000000002',
        status: 'prepared', startDate: '2026-09-15', scheduleSummary: 'Monday-Friday, 8:00 AM-5:00 PM CT',
        rateType: 'Hourly', clientRate: 18, talentRate: 10, placementId: null, updatedAt: '2026-09-01T14:45:00.000Z'
      }],
      placements: []
    };
  }

  function createApprovalAdapter(seed = defaultSeed()) {
    let state = deepCopy(seed);
    let sequence = 1;
    function id() {
      const suffix = String(sequence++).padStart(12, '0');
      return `90000000-0000-4000-8000-${suffix}`;
    }
    function now() { return new Date().toISOString(); }
    function candidateByApplicant(applicantId) {
      return state.candidates.find(candidate => candidate.applicant?.applicantId === applicantId);
    }
    return Object.freeze({
      kind: 'approval',
      async loadWorkflow() { return deepCopy(state); },
      async mutate(action, values) {
        const timestamp = now();
        if (action === 'schedule_interview') {
          const candidate = state.candidates.find(item => item.shortlistItemId === values.shortlistItemId);
          if (candidate) {
            const start = new Date(values.startsAt);
            candidate.interviews.push({
              interviewId: id(), roundNumber: candidate.interviews.length + 1, status: 'scheduled',
              startsAt: start.toISOString(), endsAt: new Date(start.getTime() + Number(values.durationMinutes) * 60000).toISOString(),
              timezone: values.timezone, outcome: null, notes: null, calendar: { status: 'synced', joinUrl: 'https://teams.microsoft.com/l/meetup-join/approval' }, updatedAt: timestamp
            });
            candidate.updatedAt = timestamp;
          }
        } else if (['reschedule_interview', 'cancel_interview', 'record_interview_outcome', 'retry_calendar_sync'].includes(action)) {
          const candidate = state.candidates.find(item => item.interviews.some(interview => interview.interviewId === values.interviewId));
          const interview = candidate?.interviews.find(item => item.interviewId === values.interviewId);
          if (interview && action === 'reschedule_interview') {
            const start = new Date(values.startsAt);
            interview.startsAt = start.toISOString();
            interview.endsAt = new Date(start.getTime() + Number(values.durationMinutes) * 60000).toISOString();
            interview.timezone = values.timezone; interview.calendar = { status: 'synced', joinUrl: interview.calendar?.joinUrl || 'https://teams.microsoft.com/l/meetup-join/approval' };
          } else if (interview && action === 'cancel_interview') {
            interview.status = 'cancelled'; interview.notes = values.note; interview.calendar = { status: 'not_applicable', joinUrl: null };
          } else if (interview && action === 'record_interview_outcome') {
            interview.status = values.status; interview.outcome = values.outcome; interview.notes = values.note;
          } else if (interview) {
            interview.calendar = { status: 'synced', joinUrl: interview.calendar?.joinUrl || 'https://teams.microsoft.com/l/meetup-join/approval' };
          }
          if (interview) interview.updatedAt = timestamp;
        } else if (action === 'final_decision') {
          const candidate = state.candidates.find(item => item.shortlistItemId === values.shortlistItemId);
          if (candidate) {
            candidate.decision = { decisionId: id(), decision: values.decision, createdAt: timestamp };
            candidate.workflowState = values.decision === 'selected' ? 'selected' : 'passed';
            candidate.updatedAt = timestamp;
          }
        } else if (action === 'prepare_handoff') {
          const candidate = state.candidates.find(item => item.decision?.decisionId === values.decisionId);
          if (candidate) state.handoffs.push({
            handoffId: id(), decisionId: values.decisionId, shortlistItemId: candidate.shortlistItemId,
            applicantId: candidate.applicant.applicantId, status: 'prepared', startDate: values.startDate,
            scheduleSummary: values.scheduleSummary, rateType: values.rateType, clientRate: Number(values.clientRate),
            talentRate: Number(values.talentRate), placementId: null, updatedAt: timestamp
          });
        } else if (action === 'confirm_placement') {
          const handoff = state.handoffs.find(item => item.handoffId === values.handoffId);
          if (handoff) {
            handoff.status = 'confirmed'; handoff.updatedAt = timestamp; handoff.placementId = id();
            state.placements.push({
              placementId: handoff.placementId, applicantId: handoff.applicantId, status: 'onboarding', startDate: handoff.startDate,
              scheduleSummary: handoff.scheduleSummary, updatedAt: timestamp,
              onboardingItems: [
                { onboardingItemId: id(), itemKey: 'client_welcome', title: 'Client welcome and working agreement', required: true, status: 'pending', updatedAt: timestamp },
                { onboardingItemId: id(), itemKey: 'system_access', title: 'System access confirmed', required: true, status: 'pending', updatedAt: timestamp },
                { onboardingItemId: id(), itemKey: 'first_day', title: 'First-day plan shared', required: true, status: 'pending', updatedAt: timestamp }
              ]
            });
          }
        } else if (action === 'update_onboarding') {
          state.placements.forEach(placement => placement.onboardingItems?.forEach(item => {
            if (item.onboardingItemId === values.onboardingItemId) { item.status = values.status; item.updatedAt = timestamp; placement.updatedAt = timestamp; }
          }));
        } else if (action === 'activate_placement') {
          const placement = state.placements.find(item => item.placementId === values.placementId);
          if (placement) { placement.status = 'active'; placement.updatedAt = timestamp; }
        }
        state.generatedAt = timestamp;
        state.request.updatedAt = timestamp;
        if (action === 'confirm_placement') state.request.filledSeats = Math.min(state.request.seats, state.request.filledSeats + 1);
        return deepCopy(state);
      }
    });
  }

  function feedbackMarkup() {
    if (!feedback.message) return '';
    return `<div class="cpw-feedback cpw-feedback--${escapeHtml(feedback.tone || 'info')}" role="status">${escapeHtml(feedback.message)}</div>`;
  }

  function statusPill(value, extra = '') {
    const token = text(value, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pending';
    return `<span class="cpw-pill ${escapeHtml(extra)} cpw-pill--${escapeHtml(token)}">${escapeHtml(titleCase(value || 'pending'))}</span>`;
  }

  function candidateName(candidate) {
    const preferred = candidate.applicant.preferredName;
    return preferred && preferred.toLowerCase() !== candidate.applicant.fullName.toLowerCase()
      ? `${candidate.applicant.fullName} · goes by ${preferred}`
      : candidate.applicant.fullName;
  }

  function candidateForApplicant(applicantId) {
    return workspace?.candidates.find(candidate => candidate.applicant.applicantId === applicantId) || null;
  }

  function interviewMarkup(interview, candidate, clientSafe) {
    const joinUrl = safeUrl(interview.calendar.joinUrl);
    const calendarLabel = clientSafe
      ? (interview.calendar.status === 'synced' ? 'Calendar invitation ready' : 'Calendar invitation pending')
      : ({ synced: 'Microsoft 365 synced', pending: 'Calendar sync in progress', sync_failed: 'Calendar sync needs retry', connection_required: 'Microsoft 365 connection required', not_applicable: 'No active calendar event' })[interview.calendar.status] || titleCase(interview.calendar.status);
    const isScheduled = interview.status === 'scheduled';
    const hasStarted = Boolean(interview.startsAt && Date.parse(interview.startsAt) <= Date.now());
    const needsCreateRetry = interview.calendar.needsCreateRetry === true;
    const controls = !clientSafe && workspace.permissions.scheduleInterview ? `
      <div class="cpw-inline-actions">
        ${isScheduled && !needsCreateRetry ? `<button type="button" class="cpw-link" data-cpw-open="reschedule" data-candidate-id="${escapeHtml(candidate.shortlistItemId)}" data-interview-id="${escapeHtml(interview.interviewId)}">Reschedule</button>
        <button type="button" class="cpw-link cpw-link--danger" data-cpw-open="cancel" data-candidate-id="${escapeHtml(candidate.shortlistItemId)}" data-interview-id="${escapeHtml(interview.interviewId)}">Cancel</button>
        <button type="button" class="cpw-link" data-cpw-open="outcome" data-candidate-id="${escapeHtml(candidate.shortlistItemId)}" data-interview-id="${escapeHtml(interview.interviewId)}" ${hasStarted ? '' : 'disabled title="Available after the interview begins"'}>Record outcome</button>` : ''}
        ${needsCreateRetry || ['sync_failed', 'connection_required'].includes(interview.calendar.status) ? `<button type="button" class="cpw-link" data-cpw-direct="retry_calendar_sync" data-interview-id="${escapeHtml(interview.interviewId)}">Retry calendar sync</button>` : ''}
      </div>` : '';
    return `<article class="cpw-interview">
      <div class="cpw-interview__top"><strong>Round ${interview.roundNumber}</strong>${statusPill(interview.status)}</div>
      <p class="cpw-interview__time">${escapeHtml(formatDateTime(interview.startsAt, interview.timezone))} · ${escapeHtml(interview.timezone)}</p>
      <div class="cpw-calendar ${interview.calendar.status === 'sync_failed' || interview.calendar.status === 'connection_required' ? 'cpw-calendar--attention' : ''}">
        <span aria-hidden="true">${interview.calendar.status === 'synced' ? '✓' : '◷'}</span><span>${escapeHtml(calendarLabel)}</span>
        ${joinUrl ? `<a href="${escapeHtml(joinUrl)}" target="_blank" rel="noopener noreferrer">Join Teams meeting</a>` : ''}
      </div>
      ${!clientSafe && interview.outcome ? `<p><span class="cpw-label">Outcome</span> ${escapeHtml(titleCase(interview.outcome))}</p>` : ''}
      ${!clientSafe && interview.notes ? `<p class="cpw-private-note"><span class="cpw-label">Internal note</span> ${escapeHtml(interview.notes)}</p>` : ''}
      ${controls}
    </article>`;
  }

  function canSelectCandidate(candidate) {
    if (candidate.clientResponse !== 'request_interview') return true;
    return candidate.interviews.some(interview => interview.status === 'completed' && ['advance', 'follow_up'].includes(interview.outcome));
  }

  function candidateActionsMarkup(candidate, clientSafe) {
    if (candidate.decision) return `<div class="cpw-decision cpw-decision--${escapeHtml(candidate.decision.decision)}">Final decision: <strong>${escapeHtml(titleCase(candidate.decision.decision))}</strong></div>`;
    if (candidate.workflowState !== 'active') return '';
    if (clientSafe) {
      if (!workspace.permissions.finalDecision || !['interested', 'request_interview'].includes(candidate.clientResponse)) return '';
      const canSelect = canSelectCandidate(candidate);
      return `<div class="cpw-decision-actions" aria-label="Final candidate decision">
        <button type="button" class="cpw-button cpw-button--primary" data-cpw-decision="selected" data-candidate-id="${escapeHtml(candidate.shortlistItemId)}" ${canSelect ? '' : 'disabled title="Complete the requested interview before selecting"'}>Select candidate</button>
        <button type="button" class="cpw-button cpw-button--secondary" data-cpw-decision="passed" data-candidate-id="${escapeHtml(candidate.shortlistItemId)}">Pass on candidate</button>
      </div>`;
    }
    const hasOpenInterview = candidate.interviews.some(interview => interview.status === 'scheduled');
    const schedule = workspace.permissions.scheduleInterview && candidate.clientResponse === 'request_interview' && !hasOpenInterview
      ? `<button type="button" class="cpw-button cpw-button--primary" data-cpw-open="schedule" data-candidate-id="${escapeHtml(candidate.shortlistItemId)}">${candidate.interviews.length ? 'Schedule next interview' : 'Schedule interview'}</button>` : '';
    return schedule ? `<div class="cpw-decision-actions">${schedule}</div>` : '';
  }

  function candidateMarkup(candidate, clientSafe) {
    const responseLabel = ({ request_interview: 'Interview requested', interested: 'Interested', not_a_fit: 'Not a fit' })[candidate.clientResponse] || 'Awaiting Client response';
    return `<article class="cpw-candidate">
      <header class="cpw-candidate__header">
        <div><p class="cpw-eyebrow">Candidate</p><h3>${escapeHtml(candidateName(candidate))}</h3>
          ${!clientSafe && candidate.applicant.email ? `<p class="cpw-candidate__email">${escapeHtml(candidate.applicant.email)}</p>` : ''}
        </div>
        <div class="cpw-badge-row">${statusPill(responseLabel)}${statusPill(candidate.workflowState)}</div>
      </header>
      ${typeof mountedOptions.onOpenTalent === 'function' ? `<button type="button" class="cpw-link cpw-profile-link" data-cpw-profile="${escapeHtml(candidate.applicant.applicantId)}">View candidate profile</button>` : ''}
      <section class="cpw-interview-list" aria-label="Interview schedule">
        ${candidate.interviews.length ? candidate.interviews.map(interview => interviewMarkup(interview, candidate, clientSafe)).join('') : '<p class="cpw-empty-inline">No Client interview is scheduled.</p>'}
      </section>
      ${candidateActionsMarkup(candidate, clientSafe)}
    </article>`;
  }

  function handoffsMarkup() {
    if (!workspace.handoffs.length && !workspace.candidates.some(candidate => candidate.decision?.decision === 'selected')) return '';
    const cards = workspace.candidates.filter(candidate => candidate.decision?.decision === 'selected').map(candidate => {
      const handoff = workspace.handoffs.find(item => item.decisionId === candidate.decision.decisionId);
      if (!handoff) return `<article class="cpw-handoff">
        <div><p class="cpw-eyebrow">Selected by Client</p><h3>${escapeHtml(candidateName(candidate))}</h3><p>Placement terms have not been prepared yet.</p></div>
        ${workspace.permissions.prepareHandoff ? `<button type="button" class="cpw-button cpw-button--primary" data-cpw-open="handoff" data-candidate-id="${escapeHtml(candidate.shortlistItemId)}">Prepare handoff</button>` : ''}
      </article>`;
      return `<article class="cpw-handoff">
        <div><p class="cpw-eyebrow">Placement handoff</p><h3>${escapeHtml(candidateName(candidate))}</h3>
          <p>${escapeHtml(formatDate(handoff.startDate))} · ${escapeHtml(handoff.scheduleSummary)}</p>
          <p class="cpw-rate"><strong>${escapeHtml(formatMoney(handoff.clientRate))}</strong> Client · <strong>${escapeHtml(formatMoney(handoff.talentRate))}</strong> Talent · ${escapeHtml(handoff.rateType)}</p>
        </div>
        <div class="cpw-handoff__action">${statusPill(handoff.status)}
          ${workspace.permissions.confirmPlacement && handoff.status === 'prepared' ? `<button type="button" class="cpw-button cpw-button--primary" data-cpw-direct="confirm_placement" data-handoff-id="${escapeHtml(handoff.handoffId)}">Confirm placement</button>` : ''}
        </div>
      </article>`;
    }).join('');
    return `<section class="cpw-section" aria-labelledby="cpw-handoffs-heading"><div class="cpw-section__heading"><div><p class="cpw-eyebrow">Internal handoff</p><h2 id="cpw-handoffs-heading">Selected talent</h2></div><p>Sales prepares terms; Admin or Talent Management confirms the placement.</p></div><div class="cpw-stack">${cards}</div></section>`;
  }

  function placementMarkup(placement, clientSafe) {
    const candidate = candidateForApplicant(placement.applicantId);
    const requiredPending = placement.onboardingItems.some(item => item.required && item.status !== 'completed');
    const beforeStart = placement.startDate && new Date(`${placement.startDate}T00:00:00`) > new Date();
    const canActivate = workspace.permissions.manageOnboarding && placement.status === 'onboarding' && !requiredPending && !beforeStart;
    const checklist = !clientSafe && workspace.permissions.manageOnboarding ? `<div class="cpw-checklist">
      ${placement.onboardingItems.map(item => `<label class="cpw-checklist__item">
        <input type="checkbox" data-cpw-onboarding="${escapeHtml(item.onboardingItemId)}" ${item.status === 'completed' ? 'checked' : ''} ${busy ? 'disabled' : ''}>
        <span><strong>${escapeHtml(item.title)}</strong>${item.required ? '<small>Required</small>' : '<small>Optional</small>'}</span>
      </label>`).join('') || '<p class="cpw-empty-inline">The onboarding checklist has not been created.</p>'}
    </div>` : '';
    return `<article class="cpw-placement">
      <header><div><p class="cpw-eyebrow">${clientSafe ? 'Placement' : 'Onboarding'}</p><h3>${escapeHtml(candidate ? candidateName(candidate) : 'Selected talent')}</h3></div>${statusPill(placement.status)}</header>
      <div class="cpw-placement__facts"><span><strong>Start date</strong>${escapeHtml(formatDate(placement.startDate))}</span><span><strong>Schedule</strong>${escapeHtml(placement.scheduleSummary || 'To be confirmed')}</span></div>
      ${placement.endDate ? `<p>Last working day: ${escapeHtml(formatDate(placement.endDate))}</p>` : ''}
      ${checklist}
      ${!mountedOptions.adapter ? `<p><button type="button" class="button ah-record-action" data-activity-kind="placement" data-activity-id="${escapeHtml(placement.placementId)}">Activity History</button></p>` : ''}
      ${!clientSafe && workspace.permissions.manageOnboarding && !mountedOptions.adapter && ['active','live','working','placed','ended'].includes(placement.status) ? `<p><button type="button" class="cpw-button cpw-button--secondary" data-placement-ending-open="${escapeHtml(placement.placementId)}">${placement.status==='ended'?'View closing record':'End placement'}</button></p>` : ''}
      ${!clientSafe && workspace.permissions.manageOnboarding && !mountedOptions.adapter && root.SoroTalentHealthcare?.liveAllowed() && ['admin','talent_management'].includes(root.soroCurrentAccess?.role) ? `<div data-cpw-healthcare="${escapeHtml(placement.placementId)}" data-healthcare-applicant="${escapeHtml(placement.applicantId)}"></div>` : ''}
      ${workspace.permissions.manageOnboarding && placement.status === 'onboarding' ? `<div class="cpw-activation"><button type="button" class="cpw-button cpw-button--primary" data-cpw-direct="activate_placement" data-placement-id="${escapeHtml(placement.placementId)}" ${canActivate ? '' : 'disabled'}>Activate placement</button>${requiredPending ? '<small>Complete every required onboarding item first.</small>' : beforeStart ? '<small>Activation becomes available on the start date.</small>' : ''}</div>` : ''}
    </article>`;
  }

  function placementsMarkup(clientSafe) {
    if (!workspace.placements.length) return '';
    return `<section class="cpw-section" aria-labelledby="cpw-placements-heading"><div class="cpw-section__heading"><div><p class="cpw-eyebrow">${clientSafe ? 'Confirmed match' : 'Placement setup'}</p><h2 id="cpw-placements-heading">${clientSafe ? 'Placement status' : 'Onboarding & activation'}</h2></div>${clientSafe ? '<p>Start details stay current as onboarding progresses.</p>' : '<p>Complete the required checklist before activating the placement.</p>'}</div><div class="cpw-stack">${workspace.placements.map(placement => placementMarkup(placement, clientSafe)).join('')}</div></section>`;
  }

  function editorMarkup() {
    if (!editor) return '';
    const candidate = workspace.candidates.find(item => item.shortlistItemId === editor.candidateId);
    const interview = candidate?.interviews.find(item => item.interviewId === editor.interviewId);
    let title = '';
    let body = '';
    if (editor.kind === 'schedule' || editor.kind === 'reschedule') {
      title = editor.kind === 'schedule' ? 'Schedule Client interview' : 'Reschedule Client interview';
      const defaultStart = interview?.startsAt || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const localValue = new Date(defaultStart);
      localValue.setMinutes(localValue.getMinutes() - localValue.getTimezoneOffset());
      const duration = interview?.startsAt && interview?.endsAt ? Math.max(15, Math.round((Date.parse(interview.endsAt) - Date.parse(interview.startsAt)) / 60000)) : 45;
      body = `<div class="cpw-form-grid"><label class="cpw-field"><span>Date and time</span><input type="datetime-local" name="startsAt" value="${escapeHtml(localValue.toISOString().slice(0, 16))}" required></label>
        <label class="cpw-field"><span>Duration</span><select name="durationMinutes">${[15, 30, 45, 60, 90, 120].map(value => `<option value="${value}" ${value === duration ? 'selected' : ''}>${value} minutes</option>`).join('')}</select></label>
        <label class="cpw-field cpw-field--wide"><span>Time zone</span><input name="timezone" value="${escapeHtml(interview?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago')}" maxlength="100" required></label></div>
        <p class="cpw-form-note">Soro will create or update the Microsoft Teams calendar event for the Client, talent, and Sales owner.</p>`;
    } else if (editor.kind === 'cancel') {
      title = 'Cancel Client interview';
      body = '<label class="cpw-field"><span>Cancellation note</span><textarea name="note" maxlength="1000" required placeholder="Why is this interview being cancelled?"></textarea></label>';
    } else if (editor.kind === 'outcome') {
      title = 'Record interview outcome';
      body = `<div class="cpw-form-grid"><label class="cpw-field"><span>Attendance</span><select name="status"><option value="completed">Completed</option><option value="no_show">No show</option></select></label>
        <label class="cpw-field"><span>Outcome</span><select name="outcome"><option value="advance">Advance</option><option value="follow_up">Follow up</option><option value="not_selected">Do not advance</option></select></label>
        <label class="cpw-field cpw-field--wide"><span>Internal interview note</span><textarea name="note" maxlength="4000" required></textarea></label></div>
        <p class="cpw-form-note">This note remains internal and is never shown in the Client Portal.</p>`;
    } else if (editor.kind === 'handoff') {
      title = 'Prepare placement handoff';
      body = `<div class="cpw-form-grid"><label class="cpw-field"><span>Start date</span><input type="date" name="startDate" min="${escapeHtml(new Date().toISOString().slice(0, 10))}" required></label>
        <label class="cpw-field"><span>Rate type</span><input name="rateType" maxlength="60" placeholder="Hourly" required></label>
        <label class="cpw-field cpw-field--wide"><span>Schedule</span><textarea name="scheduleSummary" maxlength="1000" required placeholder="Monday-Friday, 8:00 AM-5:00 PM CT"></textarea></label>
        <label class="cpw-field"><span>Client rate (USD)</span><input type="number" name="clientRate" min="0.01" max="9999999999.99" step="0.01" required></label>
        <label class="cpw-field"><span>Talent rate (USD)</span><input type="number" name="talentRate" min="0.01" max="9999999999.99" step="0.01" required></label></div>
        <p class="cpw-form-note">Rates are internal and are never included in the Client decision view.</p>`;
    }
    if (!title) return '';
    return `<dialog class="cpw-dialog" open data-cpw-dialog><form method="dialog" class="cpw-dialog__surface" data-cpw-form>
      <header><div><p class="cpw-eyebrow">${escapeHtml(workspace.request.companyName)}</p><h2>${escapeHtml(title)}</h2></div><button type="button" class="cpw-icon-button" data-cpw-close aria-label="Close">×</button></header>
      <div class="cpw-dialog__body">${body}</div><footer><button type="button" class="cpw-button cpw-button--secondary" data-cpw-close>Cancel</button><button type="submit" class="cpw-button cpw-button--primary" ${busy ? 'disabled' : ''}>${busy ? 'Saving…' : 'Save'}</button></footer>
    </form></dialog>`;
  }

  function workspaceMarkup(value = workspace) {
    if (!value) return '';
    workspace = value;
    const clientSafe = isClientRole(value.viewerRole);
    const reviewer = value.viewerRole === 'client_reviewer';
    return `<section class="cpw-shell cpw-shell--${clientSafe ? 'client' : 'internal'}" data-client-placement-workflow>
      <header class="cpw-hero">
        <div><p class="cpw-eyebrow">${clientSafe ? 'Client Portal' : `${escapeHtml(roleLabel(value.viewerRole))} workspace`}</p><h1>${clientSafe ? 'Candidates for your review' : 'Client placement workspace'}</h1>
          <p>${escapeHtml(value.request.companyName)} · ${escapeHtml(value.request.title)}</p></div>
        <div class="cpw-hero__facts"><span>${statusPill(value.request.status)}</span><span><strong>${value.request.filledSeats}</strong> of <strong>${value.request.seats}</strong> seats filled</span><button type="button" class="cpw-link" data-cpw-refresh ${busy ? 'disabled' : ''}>Refresh</button></div>
      </header>
      ${feedbackMarkup()}
      ${clientSafe ? `<div class="cpw-privacy-note"><strong>${reviewer ? 'Review-only access' : 'Client-safe review'}</strong><span>${reviewer ? 'You can review candidates and interviews, but only a Client Administrator can record the final decision.' : 'Only the candidate information needed for your decision is shown here.'}</span></div>` : `<div class="cpw-integration-note"><span class="cpw-integration-dot cpw-integration-dot--${value.calendarIntegration.configured ? 'ready' : 'attention'}"></span><span>${value.calendarIntegration.configured ? 'Microsoft 365 calendar sync is connected.' : 'Microsoft 365 needs attention before Teams invitations can sync.'}</span></div>`}
      <section class="cpw-section" aria-labelledby="cpw-candidates-heading"><div class="cpw-section__heading"><div><p class="cpw-eyebrow">${clientSafe ? 'Shortlist' : 'Candidate workflow'}</p><h2 id="cpw-candidates-heading">${value.candidates.length} candidate${value.candidates.length === 1 ? '' : 's'}</h2></div><p>${clientSafe ? 'Review interview details and record the final selection when ready.' : 'Coordinate interviews, outcomes, and the Client decision from one request.'}</p></div>
        <div class="cpw-candidate-grid">${value.candidates.length ? value.candidates.map(candidate => candidateMarkup(candidate, clientSafe)).join('') : '<div class="cpw-empty"><h3>No candidates are ready for review.</h3><p>Shortlisted talent will appear here after Sales sends the shortlist.</p></div>'}</div>
      </section>
      ${clientSafe ? placementsMarkup(true) : `${handoffsMarkup()}${placementsMarkup(false)}`}
      ${['admin','sales_management','sales'].includes(value.viewerRole) ? `<section class="cpw-section" aria-label="Candidate email updates"><h2>Candidate email updates</h2>${value.emailDeliveryUnavailable?'<p>Email status is temporarily unavailable. Your hiring request remains saved.</p>':value.emailDeliveries?.length?`<p>${value.emailDeliveries.reduce((n,r)=>n+r.sentCount,0)} sent · ${value.emailDeliveries.reduce((n,r)=>n+r.pendingCount,0)} queued / retrying · ${value.emailDeliveries.reduce((n,r)=>n+r.reviewCount,0)} need attention</p><p>Sent means accepted by the email service, not confirmed inbox delivery. An administrator can review messages needing attention.</p>`:'<p>No email record loaded. Older activity is not emailed again.</p>'}<button type="button" class="cpw-link" data-cpw-refresh>Refresh email status</button></section>`:''}
      ${editorMarkup()}
    </section>`;
  }

  function stateMarkup(title, message, tone = 'loading', retry = false) {
    return `<section class="cpw-state cpw-state--${escapeHtml(tone)}"><div class="cpw-state__icon" aria-hidden="true">${tone === 'loading' ? '◷' : '!'}</div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p>${retry ? '<button type="button" class="cpw-button cpw-button--primary" data-cpw-refresh>Try again</button>' : ''}</section>`;
  }

  function render() {
    if (!mountedRoot) return;
    if (phase === 'loading') mountedRoot.innerHTML = stateMarkup('Loading placement workflow', 'Retrieving the current Client request, interviews, and placement status.');
    else if (phase === 'error') mountedRoot.innerHTML = stateMarkup('Placement workflow unavailable', feedback.message || 'This request could not be loaded.', 'error', true);
    else if (phase === 'ready' && workspace) mountedRoot.innerHTML = workspaceMarkup(workspace);
    else mountedRoot.replaceChildren?.();
    bind();
  }

  function openEditor(kind, button) {
    if (busy) return;
    const interviewId = text(button?.dataset?.interviewId, 100);
    const interview = workspace?.candidates?.flatMap(candidate => candidate.interviews)
      .find(item => item.interviewId === interviewId);
    if (['reschedule', 'cancel'].includes(kind) && interview?.calendar?.needsCreateRetry) {
      feedback = Object.freeze({ tone: 'attention', message: 'Retry calendar sync before rescheduling or cancelling this interview.' });
      editor = null;
      render();
      return;
    }
    editor = {
      kind,
      candidateId: text(button?.dataset?.candidateId, 100),
      interviewId
    };
    feedback = Object.freeze({ tone: '', message: '' });
    render();
  }

  function closeEditor() {
    if (busy) return;
    editor = null;
    render();
  }

  async function performMutation(action, values, successMessage) {
    if (busy || !activeAdapter || !workspace) return;
    const operation = { adapter:activeAdapter, host:mountedRoot, version:loadVersion, role:requestedRole };
    pendingMutation = operation;
    const current = () => pendingMutation === operation && mountedRoot === operation.host && loadVersion === operation.version && activeAdapter === operation.adapter;
    busy = true;
    feedback = Object.freeze({ tone: '', message: '' });
    render();
    const progressLabel = ({schedule_interview:'Scheduling interview…',reschedule_interview:'Rescheduling interview…',cancel_interview:'Cancelling interview…',retry_calendar_sync:'Updating interview calendar…'})[action] || 'Saving placement update…';
    const finish = root.SoroActionProgress?.begin(progressLabel);
    try {
      const result = await operation.adapter.mutate(action, { hiringRequestId: workspace.request.hiringRequestId, ...values }, candidate => {
        const verified = normalizeWorkspace(candidate, operation.role);
        if (!verified) throw new Error('The updated placement workflow could not be verified.');
        return verified;
      });
      if (!current()) return;
      const normalized = normalizeWorkspace(result, requestedRole);
      if (!normalized) throw new Error('The updated placement workflow could not be verified.');
      workspace = normalized;
      feedback = Object.freeze({
        tone: workspace.calendarSyncPending ? 'attention' : 'success',
        message: workspace.calendarSyncPending ? 'The workflow was saved. Calendar synchronization is still reconciling; use Retry if it does not finish.' : successMessage
      });
      editor = null;
      if (typeof mountedOptions.onChange === 'function') mountedOptions.onChange(workspace, action);
    } catch (error) {
      if (!current()) return;
      feedback = Object.freeze({ tone: 'error', message: text(error?.message, 300) || 'This placement action could not be completed.' });
    } finally {
      finish?.();
      if (current()) { pendingMutation = null; busy = false; render(); }
    }
  }

  function confirmed(message) {
    return typeof root?.confirm !== 'function' || root.confirm(message);
  }

  async function directAction(button) {
    const action = text(button?.dataset?.cpwDirect, 50).toLowerCase();
    if (action === 'retry_calendar_sync') {
      const interview = workspace.candidates.flatMap(candidate => candidate.interviews).find(item => item.interviewId === button.dataset.interviewId);
      if (interview) await performMutation(action, { expectedUpdatedAt: interview.updatedAt, interviewId: interview.interviewId }, 'Calendar synchronization completed.');
    } else if (action === 'confirm_placement') {
      const handoff = workspace.handoffs.find(item => item.handoffId === button.dataset.handoffId);
      if (handoff && confirmed('Confirm this placement and create its onboarding checklist?')) await performMutation(action, { expectedUpdatedAt: handoff.updatedAt, handoffId: handoff.handoffId }, 'Placement confirmed. The onboarding checklist is ready.');
    } else if (action === 'activate_placement') {
      const placement = workspace.placements.find(item => item.placementId === button.dataset.placementId);
      if (placement && confirmed('Activate this placement now?')) await performMutation(action, { expectedUpdatedAt: placement.updatedAt, placementId: placement.placementId }, 'Placement activated.');
    }
  }

  async function finalDecision(button) {
    const candidate = workspace.candidates.find(item => item.shortlistItemId === button.dataset.candidateId);
    const decision = text(button.dataset.cpwDecision, 20).toLowerCase();
    if (!candidate || !['selected', 'passed'].includes(decision)) return;
    const verb = decision === 'selected' ? 'select' : 'pass on';
    if (!confirmed(`Record the final decision to ${verb} ${candidate.applicant.preferredName || candidate.applicant.fullName}? This cannot be undone.`)) return;
    await performMutation('final_decision', { expectedUpdatedAt: candidate.updatedAt, shortlistItemId: candidate.shortlistItemId, decision }, decision === 'selected' ? 'Candidate selected. Sales can prepare the placement handoff.' : 'Candidate decision recorded.');
  }

  async function toggleOnboarding(input) {
    const item = workspace.placements.flatMap(placement => placement.onboardingItems).find(candidate => candidate.onboardingItemId === input.dataset.cpwOnboarding);
    if (!item) return;
    await performMutation('update_onboarding', { expectedUpdatedAt: item.updatedAt, onboardingItemId: item.onboardingItemId, status: input.checked ? 'completed' : 'pending' }, 'Onboarding checklist updated.');
  }

  function formData(form) {
    const FormDataConstructor = root?.FormData || (typeof FormData !== 'undefined' ? FormData : null);
    if (!FormDataConstructor) throw new Error('This browser cannot read the placement form.');
    return new FormDataConstructor(form);
  }

  async function submitEditor(event) {
    event.preventDefault();
    if (!editor || busy) return;
    const data = formData(event.currentTarget);
    const candidate = workspace.candidates.find(item => item.shortlistItemId === editor.candidateId);
    const interview = candidate?.interviews.find(item => item.interviewId === editor.interviewId);
    if (editor.kind === 'schedule' || editor.kind === 'reschedule') {
      const startsAt = new Date(String(data.get('startsAt') || ''));
      if (!Number.isFinite(startsAt.getTime())) { feedback = Object.freeze({ tone: 'error', message: 'Choose a valid interview date and time.' }); render(); return; }
      const common = { startsAt: startsAt.toISOString(), durationMinutes: Number(data.get('durationMinutes')), timezone: text(data.get('timezone'), 100) };
      if (editor.kind === 'schedule' && candidate) await performMutation('schedule_interview', { expectedUpdatedAt: candidate.updatedAt, shortlistItemId: candidate.shortlistItemId, ...common }, 'Client interview scheduled and sent to Microsoft 365.');
      else if (interview) await performMutation('reschedule_interview', { expectedUpdatedAt: interview.updatedAt, interviewId: interview.interviewId, ...common }, 'Client interview rescheduled.');
    } else if (editor.kind === 'cancel' && interview) {
      await performMutation('cancel_interview', { expectedUpdatedAt: interview.updatedAt, interviewId: interview.interviewId, note: multiline(data.get('note'), 1000) }, 'Client interview cancelled.');
    } else if (editor.kind === 'outcome' && interview) {
      const status = text(data.get('status'), 20).toLowerCase();
      await performMutation('record_interview_outcome', { expectedUpdatedAt: interview.updatedAt, interviewId: interview.interviewId, status, outcome: status === 'no_show' ? null : text(data.get('outcome'), 30).toLowerCase(), note: multiline(data.get('note'), 4000) }, 'Interview outcome recorded.');
    } else if (editor.kind === 'handoff' && candidate?.decision) {
      await performMutation('prepare_handoff', {
        expectedUpdatedAt: candidate.decision.createdAt, decisionId: candidate.decision.decisionId,
        startDate: safeDate(data.get('startDate')), scheduleSummary: multiline(data.get('scheduleSummary'), 1000),
        rateType: text(data.get('rateType'), 60), clientRate: Number(data.get('clientRate')), talentRate: Number(data.get('talentRate'))
      }, 'Placement handoff prepared for Admin or Talent Management confirmation.');
    }
  }

  function bind() {
    if (!mountedRoot?.querySelectorAll) return;
    mountedRoot.querySelectorAll('[data-cpw-open]').forEach(button => button.addEventListener('click', () => openEditor(button.dataset.cpwOpen, button)));
    mountedRoot.querySelectorAll('[data-cpw-close]').forEach(button => button.addEventListener('click', closeEditor));
    mountedRoot.querySelectorAll('[data-cpw-direct]').forEach(button => button.addEventListener('click', () => directAction(button)));
    mountedRoot.querySelectorAll('[data-cpw-decision]').forEach(button => button.addEventListener('click', () => finalDecision(button)));
    mountedRoot.querySelectorAll('[data-cpw-onboarding]').forEach(input => input.addEventListener('change', () => toggleOnboarding(input)));
    mountedRoot.querySelectorAll('[data-cpw-profile]').forEach(button => button.addEventListener('click', () => mountedOptions.onOpenTalent?.(button.dataset.cpwProfile, { hiringRequestId: workspace.request.hiringRequestId, clientSafe: isClientRole(workspace.viewerRole) })));
    mountedRoot.querySelectorAll('[data-cpw-refresh]').forEach(button => button.addEventListener('click', load));
    mountedRoot.querySelector('[data-cpw-form]')?.addEventListener('submit', submitEditor);
    const healthcareRoot = mountedRoot;
    healthcareRoot.querySelectorAll('[data-cpw-healthcare]').forEach(target => {
      const applicantId = target.dataset.healthcareApplicant;
      root.SoroTalentHealthcare.mount(target, { applicantId, placementId: target.dataset.cpwHealthcare, compact: true,
        isCurrent: () => mountedRoot === healthcareRoot && !!workspace?.permissions.manageOnboarding,
        onOpenBenefits: () => {
          root.SoroTalentHealthcare.requestOpen(applicantId);
          mountedOptions.onOpenTalent?.(applicantId, { hiringRequestId: workspace.request.hiringRequestId, clientSafe: false });
        }
      });
    });
  }

  async function load() {
    if (busy || !activeAdapter || !hiringRequestId) return;
    const version = ++loadVersion;
    phase = 'loading';
    feedback = Object.freeze({ tone: '', message: '' });
    editor = null;
    render();
    try {
      const result = await activeAdapter.loadWorkflow(hiringRequestId);
      if (version !== loadVersion) return;
      const normalized = normalizeWorkspace(result, requestedRole);
      if (!normalized) throw new Error('This hiring request is not available to the current portal.');
      workspace = normalized;
      phase = 'ready';
    } catch (error) {
      if (version !== loadVersion) return;
      phase = 'error';
      feedback = Object.freeze({ tone: 'error', message: text(error?.message, 300) || 'This placement workflow could not be loaded.' });
    }
    render();
  }

  async function mount(target, options = {}) {
    pendingMutation = null;
    busy = false;
    mountedRoot = target || null;
    mountedOptions = options || {};
    requestedRole = normalizedRole(options.role || root?.soroCurrentAccess?.role);
    hiringRequestId = text(options.hiringRequestId || options.requestId, 100);
    activeAdapter = options.adapter || createEndpointAdapter(options.endpointOptions || {});
    workspace = null;
    editor = null;
    phase = 'idle';
    if (!mountedRoot || !hiringRequestId || (requestedRole && !canOpenForRole(requestedRole))) {
      mountedRoot?.replaceChildren?.();
      return false;
    }
    await load();
    return phase === 'ready';
  }

  function unmount(options = {}) {
    pendingMutation = null;
    loadVersion += 1;
    if (options.clear !== false) mountedRoot?.replaceChildren?.();
    mountedRoot = null;
    activeAdapter = null;
    mountedOptions = {};
    hiringRequestId = '';
    requestedRole = '';
    workspace = null;
    editor = null;
    phase = 'idle';
    busy = false;
    feedback = Object.freeze({ tone: '', message: '' });
  }

  return Object.freeze({
    ACTION_FIELDS,
    AUTHORIZED_ROLES,
    CLIENT_ROLES,
    ENDPOINT,
    INTERNAL_ROLES,
    buildActionPayload,
    canOpenForRole,
    createApprovalAdapter,
    createEndpointAdapter,
    defaultSeed,
    isClientRole,
    mount,
    normalizeWorkspace,
    unmount,
    workspaceMarkup
  });
}));
