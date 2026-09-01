/* Sales shortlist and client candidate-review workflow. */
(function attachClientShortlistWorkflow(factory) {
  const scope = typeof window !== 'undefined' ? window : globalThis;
  const api = factory(scope);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (scope) scope.soroClientShortlistWorkflow = api;
}(function createClientShortlistWorkflow(root) {
  'use strict';

  const ENDPOINT = '/.netlify/functions/client-shortlists';
  const SALES_ROLES = new Set(['admin', 'sales_management', 'sales']);
  const CLIENT_ROLES = new Set(['client_admin', 'client_reviewer']);
  const AUTHORIZED_ROLES = new Set([...SALES_ROLES, ...CLIENT_ROLES]);
  const RESPONSE_VALUES = new Set(['request_interview', 'interested', 'not_a_fit']);
  const SUBMITTED_STATUSES = new Set(['client_review', 'submitted', 'sent']);
  const OPEN_REQUEST_STATUSES = new Set(['discovery', 'qualified', 'open', 'active', 'recruiting', 'ready_for_matching', 'matching', 'shortlisting']);
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const MUTATION_RETRY_TTL_MS = 15 * 60 * 1000;
  const MUTATION_RETRY_LIMIT = 24;

  let mountedRoot = null;
  let viewerRole = '';
  let mode = '';
  let phase = 'idle';
  let message = '';
  let workspace = emptyWorkspace();
  let selectedRequestId = '';
  let pendingAction = '';
  let feedback = Object.freeze({ type: '', message: '' });
  let sendConfirmationId = '';
  let activeController = null;
  let requestVersion = 0;
  let activeLoader = null;
  let activeSubmitter = null;
  let configuredLoader = null;
  let configuredSubmitter = null;
  let overlay = null;
  let overlayReturnFocus = null;
  let benchObserver = null;
  let mutationRetryOwner = '';
  const mutationRetries = new Map();

  function text(value, maxLength = 240) {
    return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[character]));
  }

  function validUuid(value, { optional = false } = {}) {
    const normalized = text(value, 80).toLowerCase();
    if (!normalized && optional) return '';
    return UUID_PATTERN.test(normalized) ? normalized : '';
  }

  function validTimestamp(value, { optional = true } = {}) {
    const normalized = text(value, 80);
    if (!normalized && optional) return '';
    const timestamp = Date.parse(normalized);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
  }

  function nonNegativeInteger(value, fallback = 0) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 ? number : fallback;
  }

  function normalizedRole(value) {
    const role = text(value, 40).toLowerCase();
    return AUTHORIZED_ROLES.has(role) ? role : '';
  }

  function modeForRole(role) {
    const normalized = normalizedRole(role);
    if (CLIENT_ROLES.has(normalized)) return 'client';
    if (SALES_ROLES.has(normalized)) return 'sales';
    return '';
  }

  function effectiveRole() {
    const actual = normalizedRole(root?.soroCurrentAccess?.role);
    if (actual === 'admin' && root?.document?.body?.classList?.contains('role-sales')) return 'sales';
    if (actual === 'admin' && root?.document?.body?.classList?.contains('role-client')) return 'client_admin';
    return actual || viewerRole;
  }

  function canOpenForRole(role, requestedMode = '') {
    const normalized = normalizedRole(role);
    const allowedMode = modeForRole(normalized);
    return Boolean(allowedMode && (!requestedMode || requestedMode === allowedMode));
  }

  function normalizedList(source, { maxItems = 30, maxLength = 100 } = {}) {
    if (!Array.isArray(source)) return Object.freeze([]);
    const seen = new Set();
    const result = [];
    for (const value of source.slice(0, maxItems)) {
      const label = text(typeof value === 'object' ? value?.name || value?.label : value, maxLength);
      const key = label.toLocaleLowerCase();
      if (label && !seen.has(key)) { seen.add(key); result.push(label); }
    }
    return Object.freeze(result);
  }

  function normalizeResponse(value) {
    const response = text(typeof value === 'object' ? value?.value || value?.response : value, 40).toLowerCase();
    return RESPONSE_VALUES.has(response) ? response : '';
  }

  function normalizeCandidate(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    const profile = source.candidate || source.talent || source.applicant || source.profile || source;
    const shortlistItemId = validUuid(source.shortlistItemId || source.shortlist_item_id || source.id, { optional: true });
    const applicantId = validUuid(source.applicantId || source.applicant_id || profile.applicantId || profile.id);
    const fullName = text(profile.fullName || profile.full_name || profile.displayName || profile.display_name || profile.name, 160);
    if (!applicantId || !fullName) return null;
    const response = normalizeResponse(source.response || source.clientResponse || source.client_response || source.decision);
    const responseAt = validTimestamp(source.responseAt || source.respondedAt || source.responded_at, { optional: true });
    const screeningSource = profile.screening && typeof profile.screening === 'object' && !Array.isArray(profile.screening) ? profile.screening : {};
    const visibleValue = source.visibleToClient ?? source.visible_to_client ?? source.clientVisible;
    return Object.freeze({
      shortlistItemId,
      applicantId,
      fullName,
      preferredName: text(profile.preferredName || profile.preferred_name, 100),
      verifiedSkills: normalizedList(profile.verifiedSkills || profile.verified_skills),
      vaTypes: normalizedList(profile.vaTypes || profile.va_types || profile.workAreas || profile.specialties, { maxItems: 15 }),
      availability: text(profile.availability || profile.availabilityLabel || profile.availability_note, 120) || 'Availability available from Soro',
      experienceYears: text(profile.experienceYears || profile.yearsExperience || profile.relevant_experience_years, 40),
      experienceSummary: text(profile.experienceSummary || profile.relevant_experience_summary || profile.summary, 500),
      educationAndTraining: text(profile.educationAndTraining || profile.education_and_training || profile.educationTrainingSummary, 1000),
      country: text(profile.country, 120),
      location: text(profile.location || profile.country, 120),
      timeZone: text(profile.timeZone || profile.timezone, 120),
      rateLabel: text(profile.rateLabel || profile.expectedRateLabel || profile.expected_hourly_rate_text, 100),
      screening: Object.freeze({
        englishResult: text(screeningSource.englishResult || profile.englishResult, 500),
        personalityResult: text(screeningSource.personalityResult || profile.personalityResult, 500),
        computerSpecifications: text(screeningSource.computerSpecifications || profile.computerSpecifications, 1000),
        internetSpeed: text(screeningSource.internetSpeed || profile.internetSpeed, 500)
      }),
      response,
      responseAt,
      clientVisible: visibleValue !== false,
      addedAt: validTimestamp(source.addedAt || source.createdAt || source.created_at, { optional: true }),
      updatedAt: validTimestamp(source.updatedAt || source.updated_at, { optional: true }),
      canRemove: source.canRemove === true || source.can_remove === true,
      canRespond: source.canRespond === true || source.can_respond === true
    });
  }

  function normalizeInternalCandidate(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    const applicantId = validUuid(source.applicantId || source.applicant_id || source.id);
    const displayName = text(source.displayName || source.display_name || source.fullName || source.name, 180);
    const updatedAt = validTimestamp(source.updatedAt || source.updated_at, { optional: true });
    if (!applicantId || !displayName || !updatedAt) return null;
    return Object.freeze({
      applicantId,
      displayName,
      stage: text(source.stage, 40).toLowerCase(),
      verifiedSkills: normalizedList(source.verifiedSkills || source.verified_skills),
      yearsExperience: text(source.yearsExperience || source.experienceYears, 40),
      availability: text(source.availability, 240),
      salesOwnerId: validUuid(source.salesOwnerId || source.sales_owner_id, { optional: true }),
      updatedAt
    });
  }

  function normalizeShortlist(source, fallbackRequestId = '') {
    const shortlist = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
    const hiringRequestId = validUuid(shortlist.hiringRequestId || shortlist.hiring_request_id || fallbackRequestId, { optional: true });
    const id = validUuid(shortlist.shortlistId || shortlist.shortlist_id || shortlist.id, { optional: true });
    const rawStatus = text(shortlist.status, 40).toLowerCase();
    const sentAt = validTimestamp(shortlist.sentAt || shortlist.submittedAt || shortlist.sent_at || shortlist.submitted_at, { optional: true });
    const status = SUBMITTED_STATUSES.has(rawStatus) || sentAt ? 'client_review' : rawStatus === 'closed' ? 'closed' : 'draft';
    const itemSource = shortlist.items || shortlist.candidates || shortlist.shortlistItems || shortlist.shortlist_items || [];
    if (!Array.isArray(itemSource)) throw new Error('The shortlist candidates could not be verified.');
    const items = itemSource.map(normalizeCandidate).filter(Boolean);
    const identifiers = items.map(item => item.shortlistItemId).filter(Boolean);
    if (new Set(identifiers).size !== identifiers.length) throw new Error('The shortlist contains duplicate candidate records.');
    return Object.freeze({
      id,
      hiringRequestId,
      status,
      sentAt,
      items: Object.freeze(items),
      responseDueAt: validTimestamp(shortlist.responseDueAt || shortlist.response_due_at, { optional: true }),
      updatedAt: validTimestamp(shortlist.updatedAt || shortlist.updated_at, { optional: true }),
      canSend: shortlist.canSend === true || shortlist.can_send === true
    });
  }

  function normalizeRequest(source, shortlists = []) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    const id = validUuid(source.hiringRequestId || source.hiring_request_id || source.requestId || source.id);
    if (!id) return null;
    const client = source.client && typeof source.client === 'object' ? source.client : {};
    const relatedShortlist = source.shortlist
      || shortlists.find(candidate => validUuid(candidate?.hiringRequestId || candidate?.hiring_request_id, { optional: true }) === id)
      || {};
    const shortlist = normalizeShortlist(relatedShortlist, id);
    const rawStatus = text(source.status, 40).toLowerCase();
    const clientName = text(client.name || client.companyName || source.clientName || source.client_name || source.companyName, 160);
    const roleTitle = text(source.roleTitle || source.role_title || source.positionTitle || source.position_title || source.title, 180);
    if (!clientName || !roleTitle) return null;
    const isOpen = source.isOpen === true || source.is_open === true || OPEN_REQUEST_STATUSES.has(rawStatus) || (!rawStatus && shortlist.status === 'draft');
    return Object.freeze({
      id,
      clientId: validUuid(client.id || source.clientId || source.client_id, { optional: true }),
      clientName,
      roleTitle,
      status: rawStatus || (isOpen ? 'open' : 'closed'),
      isOpen,
      requestedCount: Math.max(1, nonNegativeInteger(source.requestedCount || source.openings || source.numberOfOpenings || source.numberOfTalent, 1)),
      targetStartDate: validTimestamp(source.targetStartDate || source.target_start_date || source.startDate, { optional: true }),
      schedule: text(source.schedule || source.scheduleSummary || source.schedule_summary, 180),
      workArea: text(source.workArea || source.vaType || source.va_type || source.specialty, 120),
      canAddCandidate: (source.canAddCandidate === true || source.can_add_candidate === true) && isOpen && shortlist.status === 'draft',
      shortlist
    });
  }

  function emptyWorkspace(role = '') {
    return Object.freeze({
      generatedAt: '',
      viewerRole: normalizedRole(role),
      requests: Object.freeze([]),
      candidates: Object.freeze([]),
      notifications: Object.freeze([])
    });
  }

  function clientSafeCandidate(candidate) {
    return Object.freeze({
      shortlistItemId: candidate.shortlistItemId,
      applicantId: candidate.applicantId,
      fullName: candidate.fullName,
      verifiedSkills: candidate.verifiedSkills,
      experienceYears: candidate.experienceYears,
      experienceSummary: candidate.experienceSummary,
      educationAndTraining: candidate.educationAndTraining,
      country: candidate.country,
      timeZone: candidate.timeZone,
      screening: candidate.screening,
      response: candidate.response,
      responseAt: candidate.responseAt,
      addedAt: candidate.addedAt,
      updatedAt: candidate.updatedAt,
      canRemove: false,
      canRespond: candidate.canRespond === true && !candidate.response
    });
  }

  function normalizePayload(input, requestedRole = '', requestedMode = '') {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('The shortlist workspace returned an invalid response.');
    const payload = input.workspace && typeof input.workspace === 'object' ? input.workspace : input;
    const expectedRole = normalizedRole(requestedRole || viewerRole || effectiveRole());
    const returnedRole = normalizedRole(payload.viewerRole || payload.viewer_role || input.viewerRole || input.viewer_role || expectedRole);
    if (!returnedRole || (expectedRole && returnedRole !== expectedRole)) throw new Error('The shortlist workspace did not match this signed-in role.');
    const requestSource = payload.hiringRequests || payload.hiring_requests || payload.requests || [];
    const shortlistSource = payload.shortlists || [];
    const candidateSource = payload.candidates || [];
    if (!Array.isArray(requestSource) || !Array.isArray(shortlistSource) || !Array.isArray(candidateSource)) throw new Error('The shortlist workspace could not be verified.');
    const candidates = candidateSource.map(normalizeInternalCandidate).filter(Boolean);
    const candidateIds = candidates.map(candidate => candidate.applicantId);
    if (new Set(candidateIds).size !== candidateIds.length) throw new Error('The shortlist workspace contains duplicate owned Talent records.');
    let requests = requestSource.map(value => normalizeRequest(value, shortlistSource)).filter(Boolean);
    if (!CLIENT_ROLES.has(returnedRole) && candidates.length) {
      requests = requests.map(request => Object.freeze({
        ...request,
        shortlist: Object.freeze({
          ...request.shortlist,
          items: Object.freeze(request.shortlist.items.map(item => {
            const internal = candidates.find(candidate => candidate.applicantId === item.applicantId);
            return internal ? Object.freeze({
              ...item,
              verifiedSkills: item.verifiedSkills.length ? item.verifiedSkills : internal.verifiedSkills,
              availability: internal.availability || item.availability,
              experienceYears: item.experienceYears || internal.yearsExperience
            }) : item;
          }))
        })
      }));
    }
    const ids = requests.map(request => request.id);
    if (new Set(ids).size !== ids.length) throw new Error('The shortlist workspace contains duplicate hiring requests.');
    const clientMode = (requestedMode || modeForRole(returnedRole)) === 'client';
    const visibleRequests = clientMode
      ? requests.filter(request => request.shortlist.status === 'client_review').map(request => Object.freeze({
        ...request,
        canAddCandidate: false,
        shortlist: Object.freeze({
          ...request.shortlist,
          items: Object.freeze(request.shortlist.items.filter(item => item.clientVisible).map(clientSafeCandidate))
        })
      }))
      : requests;
    const notificationSource = payload.notifications || [];
    if (!Array.isArray(notificationSource)) throw new Error('The shortlist notifications could not be verified.');
    return Object.freeze({
      generatedAt: validTimestamp(payload.generatedAt || payload.generated_at, { optional: true }),
      viewerRole: returnedRole,
      requests: Object.freeze(visibleRequests),
      candidates: clientMode ? Object.freeze([]) : Object.freeze(candidates),
      notifications: Object.freeze(notificationSource.slice(0, 50).map(item => Object.freeze({
        id: validUuid(item?.id, { optional: true }),
        label: text(item?.label || item?.title || item?.message, 200)
      })).filter(item => item.label))
    });
  }

  function initials(name) {
    const parts = text(name, 160).replace(',', ' ').split(/\s+/).filter(Boolean);
    return `${parts[0]?.[0] || ''}${parts[1]?.[0] || ''}`.toUpperCase() || 'T';
  }

  function formatDate(value) {
    const timestamp = Date.parse(value || '');
    if (!Number.isFinite(timestamp)) return '';
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(timestamp));
  }

  function responseLabel(value) {
    return ({ request_interview: 'Interview requested', interested: 'Interested', not_a_fit: 'Not a fit' })[value] || 'Awaiting response';
  }

  function statusLabel(request) {
    if (request.shortlist.status === 'client_review') return 'Client review';
    if (request.shortlist.status === 'closed') return 'Closed';
    return request.shortlist.items.length ? 'Draft shortlist' : 'Needs shortlist';
  }

  function safeLocation(candidate) {
    return [candidate.country || candidate.location, candidate.timeZone].filter(Boolean).join(' · ') || 'Not recorded';
  }

  function skillChips(candidate) {
    const values = candidate.verifiedSkills.slice(0, 5);
    if (!values.length) return '<span class="shortlist-muted-value">Verified skills are being prepared</span>';
    return `${values.map(skill => `<span>${escapeHtml(skill)}</span>`).join('')}${candidate.verifiedSkills.length > values.length ? `<span>+${candidate.verifiedSkills.length - values.length}</span>` : ''}`;
  }

  function requestCardMarkup(request, clientMode = false) {
    const count = request.shortlist.items.length;
    const responses = request.shortlist.items.filter(item => item.response).length;
    return `<article class="shortlist-request-card" data-request-id="${request.id}">
      <div class="shortlist-request-status"><span class="shortlist-status shortlist-status--${request.shortlist.status}">${escapeHtml(statusLabel(request))}</span>${request.targetStartDate ? `<small>Target ${escapeHtml(formatDate(request.targetStartDate))}</small>` : ''}</div>
      <div class="shortlist-request-main"><p class="eyebrow">${escapeHtml(request.clientName)}</p><h2>${escapeHtml(request.roleTitle)}</h2><p>${escapeHtml([request.workArea, request.schedule].filter(Boolean).join(' · ') || 'Hiring request details are available in the client record.')}</p></div>
      <div class="shortlist-request-count"><strong>${count}</strong><span>${count === 1 ? 'candidate' : 'candidates'}</span>${clientMode && count ? `<small>${responses}/${count} responded</small>` : ''}</div>
      <button type="button" class="button${clientMode && responses < count ? ' primary' : ''}" data-shortlist-open="${request.id}">${clientMode ? 'Review Candidates' : 'Review Shortlist'}</button>
    </article>`;
  }

  function salesCandidateMarkup(candidate, request) {
    const response = responseLabel(candidate.response);
    return `<article class="shortlist-candidate" data-shortlist-item-id="${candidate.shortlistItemId}">
      <header><span class="shortlist-avatar" aria-hidden="true">${escapeHtml(initials(candidate.fullName))}</span><div><button type="button" class="shortlist-profile-link" data-shortlist-profile="${candidate.applicantId}">${escapeHtml(candidate.fullName)}</button><small>${escapeHtml(candidate.preferredName ? `Goes by ${candidate.preferredName}` : 'Client-safe profile')}</small></div><span class="shortlist-response shortlist-response--${candidate.response || 'pending'}">${escapeHtml(response)}</span></header>
      <div class="shortlist-candidate-facts"><span><small>Availability</small><strong>${escapeHtml(candidate.availability || 'Review in Talent profile')}</strong></span><span><small>Location &amp; time zone</small><strong>${escapeHtml(safeLocation(candidate))}</strong></span><span><small>Relevant experience</small><strong>${escapeHtml(candidate.experienceYears ? `${candidate.experienceYears} years` : 'Review in Talent profile')}</strong></span></div>
      <div class="shortlist-skill-row"><small>Soro-verified skills</small><div>${skillChips(candidate)}</div></div>
      ${candidate.experienceSummary ? `<p class="shortlist-experience">${escapeHtml(candidate.experienceSummary)}</p>` : ''}
      ${request.shortlist.status === 'draft' && candidate.shortlistItemId && candidate.canRemove ? `<footer><button type="button" class="text-button shortlist-remove" data-shortlist-remove="${candidate.shortlistItemId}">Remove</button></footer>` : ''}
    </article>`;
  }

  function clientScreeningMarkup(candidate) {
    const screening = candidate.screening || {};
    const results = [
      ['English proficiency', screening.englishResult, 'EN'],
      ['Personality summary', screening.personalityResult, 'PP'],
      ['Computer specifications', screening.computerSpecifications, 'PC'],
      ['Internet speed', screening.internetSpeed, '↕']
    ].filter(([, value]) => value);
    if (!results.length) return '';
    return `<section class="shortlist-client-screening" aria-label="Approved screening results"><div><small>Client-ready screening</small><strong>Soro-approved summaries</strong></div><div class="shortlist-screening-list">${results.map(([label, value, icon]) => `<article><span aria-hidden="true">${escapeHtml(icon)}</span><div><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></div></article>`).join('')}</div></section>`;
  }

  function clientCandidateMarkup(candidate) {
    const current = candidate.response;
    const decision = current
      ? `<p class="shortlist-client-decision" role="status"><strong>Your response is recorded: ${escapeHtml(responseLabel(current))}</strong><span>Contact your Soro team if you need to discuss this response.</span></p>`
      : candidate.canRespond
        ? '<p class="shortlist-client-decision"><strong>What would you like to do?</strong><span>Your Soro team will follow up on your choice.</span></p>'
        : '<p class="shortlist-client-decision"><strong>Response unavailable</strong><span>Contact your Soro team if you need help with this candidate review.</span></p>';
    const actions = !current && candidate.canRespond ? `<div class="shortlist-decision-actions" role="group" aria-label="Response for ${escapeHtml(candidate.fullName)}"><button type="button" class="button" aria-pressed="false" data-shortlist-response="request_interview" data-shortlist-item-id="${candidate.shortlistItemId}"${pendingAction === candidate.shortlistItemId ? ' disabled' : ''}>Request interview</button><button type="button" class="button" aria-pressed="false" data-shortlist-response="interested" data-shortlist-item-id="${candidate.shortlistItemId}"${pendingAction === candidate.shortlistItemId ? ' disabled' : ''}>Interested</button><button type="button" class="button shortlist-not-fit" aria-pressed="false" data-shortlist-response="not_a_fit" data-shortlist-item-id="${candidate.shortlistItemId}"${pendingAction === candidate.shortlistItemId ? ' disabled' : ''}>Not a fit</button></div>` : '';
    return `<article class="shortlist-client-candidate" data-shortlist-item-id="${candidate.shortlistItemId}">
      <header><span class="shortlist-avatar" aria-hidden="true">${escapeHtml(initials(candidate.fullName))}</span><div><p class="eyebrow">Candidate for your review</p><h2>${escapeHtml(candidate.fullName)}</h2></div></header>
      <div class="shortlist-client-profile-grid"><section><small>Country &amp; time zone</small><strong>${escapeHtml(safeLocation(candidate))}</strong></section><section><small>Relevant experience</small><strong>${escapeHtml(candidate.experienceYears ? `${candidate.experienceYears} years` : 'Summary reviewed by Soro')}</strong></section><section><small>Education &amp; training</small><strong>${escapeHtml(candidate.educationAndTraining || 'Not recorded')}</strong></section></div>
      <div class="shortlist-skill-row"><small>Soro-verified skills</small><div>${skillChips(candidate)}</div></div>
      ${candidate.experienceSummary ? `<p class="shortlist-experience">${escapeHtml(candidate.experienceSummary)}</p>` : ''}
      ${clientScreeningMarkup(candidate)}
      <footer class="${current ? 'shortlist-decision-recorded' : ''}">${decision}${actions}</footer>
    </article>`;
  }

  function salesOverviewMarkup() {
    const drafts = workspace.requests.filter(request => request.shortlist.status === 'draft');
    const inReview = workspace.requests.filter(request => request.shortlist.status === 'client_review');
    const candidateCount = drafts.reduce((total, request) => total + request.shortlist.items.length, 0);
    const requests = workspace.requests.filter(request => request.isOpen || request.shortlist.status === 'client_review');
    return `<main class="page shortlist-page" data-shortlist-page data-shortlist-mode="sales">
      <div class="page-heading shortlist-heading"><div><p class="eyebrow">Sales matching</p><h1>Client Shortlists</h1><p>Build each shortlist for one open hiring request, then send only approved candidate profiles to that client.</p></div><button type="button" class="button" data-shortlist-bench>Find Available Talent</button></div>
      ${feedbackMarkup()}
      <section class="shortlist-summary" aria-label="Shortlist summary"><article><span>Open requests</span><strong>${requests.length}</strong><small>Ready for matching</small></article><article><span>Draft shortlists</span><strong>${drafts.length}</strong><small>${candidateCount} candidate${candidateCount === 1 ? '' : 's'} selected</small></article><article><span>With clients</span><strong>${inReview.length}</strong><small>Waiting for client decisions</small></article></section>
      <section class="panel shortlist-workspace"><div class="shortlist-section-heading"><div><h2>Hiring requests</h2><p>Open a request to review its candidate list and client-safe details.</p></div></div>${requests.length ? `<div class="shortlist-request-list">${requests.map(request => requestCardMarkup(request)).join('')}</div>` : emptySalesMarkup()}</section>
    </main>`;
  }

  function clientOverviewMarkup() {
    const requests = workspace.requests.filter(request => request.shortlist.status === 'client_review');
    const candidateCount = requests.reduce((total, request) => total + request.shortlist.items.length, 0);
    const pendingCount = requests.reduce((total, request) => total + request.shortlist.items.filter(item => !item.response).length, 0);
    if (requests.length === 1 && !selectedRequestId) selectedRequestId = requests[0].id;
    if (selectedRequestId) return requestDetailMarkup(requests.find(request => request.id === selectedRequestId), true);
    return `<main class="page shortlist-page" data-shortlist-page data-shortlist-mode="client">
      <div class="page-heading shortlist-heading"><div><p class="eyebrow">Client Portal</p><h1>Candidates for Review</h1><p>Review only the candidates Soro submitted for your open hiring requests.</p></div></div>
      ${feedbackMarkup()}
      <section class="shortlist-summary shortlist-summary--client" aria-label="Candidate review summary"><article><span>Hiring requests</span><strong>${requests.length}</strong><small>With candidates ready</small></article><article><span>Candidates</span><strong>${candidateCount}</strong><small>Submitted by your Soro team</small></article><article><span>Awaiting your response</span><strong>${pendingCount}</strong><small>${pendingCount ? 'Choose an option on each profile' : 'You are all caught up'}</small></article></section>
      <section class="panel shortlist-workspace"><div class="shortlist-section-heading"><div><h2>Your open reviews</h2><p>Choose a hiring request to see its submitted candidates.</p></div></div>${requests.length ? `<div class="shortlist-request-list">${requests.map(request => requestCardMarkup(request, true)).join('')}</div>` : emptyClientMarkup()}</section>
    </main>`;
  }

  function requestDetailMarkup(request, clientMode = false) {
    if (!request) {
      selectedRequestId = '';
      return clientMode ? clientOverviewMarkup() : salesOverviewMarkup();
    }
    const items = request.shortlist.items;
    const submitted = request.shortlist.status === 'client_review';
    const responses = items.filter(item => item.response).length;
    return `<main class="page shortlist-page" data-shortlist-page data-shortlist-mode="${clientMode ? 'client' : 'sales'}">
      <button type="button" class="text-button shortlist-back" data-shortlist-back>← ${clientMode ? 'All candidate reviews' : 'All shortlists'}</button>
      <div class="shortlist-detail-heading"><div><p class="eyebrow">${escapeHtml(request.clientName)}</p><h1>${escapeHtml(request.roleTitle)}</h1><p>${escapeHtml([request.workArea, request.schedule].filter(Boolean).join(' · ') || 'Hiring request')}</p></div><div><span class="shortlist-status shortlist-status--${request.shortlist.status}">${escapeHtml(statusLabel(request))}</span>${submitted && request.shortlist.sentAt ? `<small>Sent ${escapeHtml(formatDate(request.shortlist.sentAt))}</small>` : ''}</div></div>
      ${feedbackMarkup()}
      ${clientMode ? `<section class="shortlist-client-intro"><strong>${items.length} candidate${items.length === 1 ? '' : 's'} selected for you</strong><span>${responses}/${items.length} response${items.length === 1 ? '' : 's'} completed</span></section>` : ''}
      <section class="shortlist-candidate-list" aria-label="${clientMode ? 'Submitted candidates' : 'Shortlist candidates'}">${items.length ? items.map(candidate => clientMode ? clientCandidateMarkup(candidate) : salesCandidateMarkup(candidate, request)).join('') : (clientMode ? emptyClientMarkup() : emptyDraftMarkup())}</section>
      ${!clientMode ? salesSendBarMarkup(request) : ''}
      ${sendConfirmationId === request.id ? sendDialogMarkup(request) : ''}
    </main>`;
  }

  function salesSendBarMarkup(request) {
    const count = request.shortlist.items.length;
    if (request.shortlist.status === 'client_review') return `<section class="shortlist-send-bar shortlist-send-bar--sent"><div><strong>Sent for client review</strong><span>Client responses appear on each candidate as they arrive.</span></div><span>${request.shortlist.items.filter(item => item.response).length}/${count} responded</span></section>`;
    return `<section class="shortlist-send-bar"><div><strong>Ready to share this shortlist?</strong><span>Soro will send ${count} client-safe candidate profile${count === 1 ? '' : 's'} to ${escapeHtml(request.clientName)}.</span></div><button type="button" class="button primary" data-shortlist-send="${request.id}"${!count || !request.shortlist.id || !request.shortlist.updatedAt || !request.shortlist.canSend || pendingAction ? ' disabled' : ''}>Send for Client Review</button></section>`;
  }

  function sendDialogMarkup(request) {
    const count = request.shortlist.items.length;
    return `<dialog class="shortlist-dialog shortlist-send-dialog" data-shortlist-send-dialog><form method="dialog" data-shortlist-send-form><header><div><p class="eyebrow">Final review</p><h2>Send for Client Review?</h2></div><button type="button" data-shortlist-dialog-close aria-label="Close">×</button></header><p><strong>${escapeHtml(request.clientName)}</strong> will be notified and can review ${count} candidate${count === 1 ? '' : 's'} for <strong>${escapeHtml(request.roleTitle)}</strong>.</p><div class="shortlist-privacy-note"><span aria-hidden="true">✓</span><p><strong>Client-safe profiles only</strong><small>Direct contact details, private documents, and internal notes are not shared.</small></p></div><footer><button type="button" class="button" data-shortlist-dialog-close>Cancel</button><button type="submit" class="button primary"${pendingAction ? ' disabled' : ''}>${pendingAction ? 'Sending…' : 'Send for Client Review'}</button></footer></form></dialog>`;
  }

  function feedbackMarkup() {
    if (!feedback.message) return '';
    return `<div class="shortlist-feedback${feedback.type === 'error' ? ' is-error' : ''}" role="status">${escapeHtml(feedback.message)}</div>`;
  }

  function emptySalesMarkup() {
    return '<div class="shortlist-empty" role="status"><span aria-hidden="true">◇</span><h2>No open hiring requests</h2><p>Open client hiring requests will appear here when they are ready for matching.</p></div>';
  }

  function emptyDraftMarkup() {
    return '<div class="shortlist-empty" role="status"><span aria-hidden="true">＋</span><h2>No candidates selected yet</h2><p>Open Available Talent and add an owned Talent profile to this hiring request.</p><button type="button" class="button" data-shortlist-bench>Find Available Talent</button></div>';
  }

  function emptyClientMarkup() {
    return '<div class="shortlist-empty" role="status"><span aria-hidden="true">✓</span><h2>No candidates need your review</h2><p>Your Soro team will notify you when a client-safe shortlist is ready.</p></div>';
  }

  function loadingMarkup() {
    return `<main class="page shortlist-page" data-shortlist-page aria-busy="true"><div class="page-heading"><div><p class="eyebrow">${mode === 'client' ? 'Client Portal' : 'Sales matching'}</p><h1>${mode === 'client' ? 'Candidates for Review' : 'Client Shortlists'}</h1></div></div><section class="panel shortlist-loading" role="status"><span aria-hidden="true"></span><strong>Loading ${mode === 'client' ? 'your candidate reviews' : 'client shortlists'}…</strong><p>Checking the latest hiring requests and authorized candidate profiles.</p></section></main>`;
  }

  function errorMarkup() {
    return `<main class="page shortlist-page" data-shortlist-page><div class="page-heading"><div><p class="eyebrow">${mode === 'client' ? 'Client Portal' : 'Sales matching'}</p><h1>${mode === 'client' ? 'Candidates for Review' : 'Client Shortlists'}</h1></div></div><section class="panel shortlist-error" role="alert"><strong>${mode === 'client' ? 'Candidate reviews' : 'Client shortlists'} are temporarily unavailable</strong><p>${escapeHtml(message || 'Soro could not load this secure workspace.')}</p><button type="button" class="button" data-shortlist-retry>Try again</button></section></main>`;
  }

  function pageMarkup() {
    if (phase === 'loading' || phase === 'idle') return loadingMarkup();
    if (phase === 'error') return errorMarkup();
    const selected = workspace.requests.find(request => request.id === selectedRequestId);
    if (selected) return requestDetailMarkup(selected, mode === 'client');
    return mode === 'client' ? clientOverviewMarkup() : salesOverviewMarkup();
  }

  function showOpenDialog() {
    const dialog = mountedRoot?.querySelector?.('[data-shortlist-send-dialog]');
    if (!dialog) return;
    dialog.addEventListener?.('cancel', event => { event.preventDefault(); closeSendConfirmation(); }, { once: true });
    if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
  }

  function render() {
    if (!mountedRoot) return false;
    mountedRoot.innerHTML = pageMarkup();
    showOpenDialog();
    return true;
  }

  function configure({ loader = null, submitter = null } = {}) {
    configuredLoader = typeof loader === 'function' ? loader : null;
    configuredSubmitter = typeof submitter === 'function' ? submitter : null;
    return true;
  }

  async function secureRequest(method = 'GET', body = null) {
    if (!root?.soroSupabase) throw new Error('Soro sign-in is still loading. Refresh and try again.');
    const { data: { session } = {}, error } = await root.soroSupabase.auth.getSession();
    if (error || !session?.access_token) throw new Error('Your secure Soro session expired. Sign in again and retry.');
    activeController?.abort?.();
    const controller = typeof root.AbortController === 'function' ? new root.AbortController() : null;
    activeController = controller;
    const timeout = controller ? root.setTimeout(() => controller.abort(), 25000) : null;
    let response;
    try {
      response = await root.fetch(ENDPOINT, {
        method,
        headers: { Authorization: `Bearer ${session.access_token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller?.signal
      });
    } catch (requestError) {
      if (requestError?.name === 'AbortError') throw new Error('The secure shortlist request took too long. Please try again.');
      throw new Error('Soro could not reach the secure shortlist service. Check your connection and try again.');
    } finally {
      if (timeout) root.clearTimeout(timeout);
      if (activeController === controller) activeController = null;
    }
    const responseText = await response.text();
    let result = {};
    if (responseText) {
      try { result = JSON.parse(responseText); }
      catch {
        const requestError = new Error(`The secure shortlist service returned an unexpected response (${response.status}).`);
        requestError.status = response.status;
        throw requestError;
      }
    }
    if (!response.ok) {
      const requestError = new Error(result.message || result.error || 'The shortlist action could not be completed.');
      requestError.status = response.status;
      throw requestError;
    }
    return result;
  }

  async function invokeLoader(role = viewerRole, targetMode = mode) {
    const loader = activeLoader || configuredLoader;
    return typeof loader === 'function' ? loader({ role, mode: targetMode }) : secureRequest('GET');
  }

  async function invokeSubmitter(body, role = viewerRole, targetMode = mode) {
    const submitter = activeSubmitter || configuredSubmitter;
    return typeof submitter === 'function' ? submitter(body, { role, mode: targetMode }) : secureRequest('POST', body);
  }

  function operationRequestId() {
    if (typeof root?.crypto?.randomUUID === 'function') return root.crypto.randomUUID();
    throw new Error('This browser cannot create a secure shortlist request. Refresh in a supported browser.');
  }

  function currentMutationOwner() {
    return text(root?.soroCurrentAccess?.user_id || root?.soroCurrentAccess?.userId, 160);
  }

  function syncMutationRetryOwner(owner = currentMutationOwner()) {
    const nextOwner = text(owner, 160);
    if (nextOwner === mutationRetryOwner) return false;
    mutationRetries.clear();
    mutationRetryOwner = nextOwner;
    return true;
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

  function mutationFingerprint(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return '';
    const action = text(body.action, 40).toLowerCase();
    const expectedUpdatedAt = validTimestamp(body.expectedUpdatedAt, { optional: false });
    const definitions = {
      add_candidate: {
        keys: ['action', 'expectedUpdatedAt', 'hiringRequestId', 'applicantId'],
        values: {
          action,
          expectedUpdatedAt,
          hiringRequestId: validUuid(body.hiringRequestId),
          applicantId: validUuid(body.applicantId)
        }
      },
      remove_candidate: {
        keys: ['action', 'expectedUpdatedAt', 'shortlistItemId'],
        values: {
          action,
          expectedUpdatedAt,
          shortlistItemId: validUuid(body.shortlistItemId)
        }
      },
      send_shortlist: {
        keys: ['action', 'expectedUpdatedAt', 'shortlistId'],
        values: {
          action,
          expectedUpdatedAt,
          shortlistId: validUuid(body.shortlistId)
        }
      },
      respond_candidate: {
        keys: ['action', 'expectedUpdatedAt', 'shortlistItemId', 'response'],
        values: {
          action,
          expectedUpdatedAt,
          shortlistItemId: validUuid(body.shortlistItemId),
          response: normalizeResponse(body.response)
        }
      }
    };
    const definition = definitions[action];
    if (!definition || !expectedUpdatedAt) return '';
    const receivedKeys = Object.keys(body).sort();
    const expectedKeys = [...definition.keys].sort();
    if (receivedKeys.length !== expectedKeys.length || receivedKeys.some((key, index) => key !== expectedKeys[index])) return '';
    if (Object.values(definition.values).some(value => !value)) return '';
    return JSON.stringify(definition.values);
  }

  function prepareMutationAttempt(body) {
    syncMutationRetryOwner();
    const now = Date.now();
    pruneMutationRetries(now);
    const fingerprint = mutationFingerprint(body);
    if (!fingerprint) throw new Error('The secure shortlist action could not be prepared. Refresh and try again.');
    let entry = mutationRetries.get(fingerprint);
    if (!entry) {
      entry = { requestId: operationRequestId(), createdAt: now, lastUsedAt: now };
      mutationRetries.set(fingerprint, entry);
      pruneMutationRetries(now);
    } else {
      entry.lastUsedAt = now;
    }
    return Object.freeze({ fingerprint, requestId: entry.requestId, owner: mutationRetryOwner });
  }

  function mutationErrorIsAmbiguous(error) {
    const status = Number(error?.status);
    return !Number.isInteger(status) || status === 408 || status === 429 || status >= 500;
  }

  function settleMutationAttempt(attempt, error = null) {
    if (!attempt) return;
    const entry = mutationRetries.get(attempt.fingerprint);
    if (!entry || entry.requestId !== attempt.requestId) return;
    if (!error || !mutationErrorIsAmbiguous(error)) {
      mutationRetries.delete(attempt.fingerprint);
      return;
    }
    entry.lastUsedAt = Date.now();
  }

  async function executeMutation(body, { role = viewerRole, targetMode = mode, apply = null } = {}) {
    const attempt = prepareMutationAttempt(body);
    try {
      const result = await invokeSubmitter({ ...body, requestId: attempt.requestId }, role, targetMode);
      if (attempt.owner !== mutationRetryOwner) throw new Error('Your Soro account changed before this shortlist action finished. Review the current workspace and try again.');
      const applied = typeof apply === 'function' ? await apply(result) : result;
      settleMutationAttempt(attempt);
      return Object.freeze({ result, applied });
    } catch (error) {
      settleMutationAttempt(attempt, error);
      throw error;
    }
  }

  function applyWorkspaceResult(result, role = viewerRole, requestedMode = mode) {
    const candidate = result?.workspace || result;
    workspace = normalizePayload(candidate, role, requestedMode);
    return workspace;
  }

  async function refresh({ silent = false } = {}) {
    if (!mountedRoot || !canOpenForRole(viewerRole, mode)) return false;
    const version = ++requestVersion;
    if (!silent) { phase = 'loading'; message = ''; render(); }
    try {
      const result = await invokeLoader();
      if (version !== requestVersion || !mountedRoot) return false;
      applyWorkspaceResult(result);
      if (selectedRequestId && !workspace.requests.some(request => request.id === selectedRequestId)) selectedRequestId = '';
      phase = 'ready';
      message = '';
      render();
      dispatchUpdated('refresh');
      return true;
    } catch (error) {
      if (version !== requestVersion || !mountedRoot) return false;
      phase = 'error';
      message = error.message || 'The secure shortlist workspace could not be loaded.';
      render();
      return false;
    }
  }

  async function prime(options = {}) {
    const role = normalizedRole(options.role || effectiveRole());
    const requestedMode = text(options.mode, 20).toLowerCase() || modeForRole(role);
    if (!canOpenForRole(role, requestedMode)) return false;
    syncMutationRetryOwner();
    try {
      const loader = configuredLoader;
      const result = typeof loader === 'function'
        ? await loader({ role, mode: requestedMode })
        : await secureRequest('GET');
      viewerRole = role;
      mode = requestedMode;
      workspace = normalizePayload(result?.workspace || result, role, requestedMode);
      syncNavigationBadges();
      return true;
    } catch {
      return false;
    }
  }

  function workspaceCounts(source = workspace, sourceMode = mode) {
    const draft = source.requests.filter(request => request.shortlist.status === 'draft').length;
    const responseNeeded = source.requests.reduce((total, request) => total + request.shortlist.items.filter(item => request.shortlist.status === 'client_review' && !item.response && item.canRespond).length, 0);
    return Object.freeze({ draft, responseNeeded });
  }

  function syncNavigationBadges() {
    const counts = workspaceCounts();
    const salesBadge = root?.document?.getElementById?.('client-shortlists-count');
    const clientBadge = root?.document?.getElementById?.('client-candidate-review-count');
    if (salesBadge && SALES_ROLES.has(viewerRole)) {
      salesBadge.textContent = String(counts.draft);
      salesBadge.hidden = counts.draft === 0;
    }
    if (clientBadge && CLIENT_ROLES.has(viewerRole)) {
      clientBadge.textContent = String(counts.responseNeeded);
      clientBadge.hidden = counts.responseNeeded === 0;
    }
    return counts;
  }

  function dispatchUpdated(action, detail = {}) {
    const counts = syncNavigationBadges();
    if (typeof root?.CustomEvent !== 'function') return;
    root.dispatchEvent?.(new root.CustomEvent('soro:client-shortlists-updated', { detail: { action, counts, ...detail } }));
  }

  async function performAction(body, { successMessage = '', keepFeedback = true } = {}) {
    const execution = await executeMutation(body, {
      apply: async result => {
        if (result?.workspace || result?.requests || result?.hiringRequests || result?.hiring_requests) applyWorkspaceResult(result);
        else {
          const refreshed = await invokeLoader();
          applyWorkspaceResult(refreshed);
        }
        phase = 'ready';
        feedback = keepFeedback ? Object.freeze({ type: 'success', message: successMessage }) : Object.freeze({ type: '', message: '' });
        return workspace;
      }
    });
    return execution.result;
  }

  async function removeCandidate(shortlistItemId) {
    const itemId = validUuid(shortlistItemId);
    const request = workspace.requests.find(candidate => candidate.id === selectedRequestId);
    const item = request?.shortlist.items.find(candidate => candidate.shortlistItemId === itemId);
    if (!itemId || mode !== 'sales' || request?.shortlist.status !== 'draft' || !item?.canRemove || !item.updatedAt) return false;
    pendingAction = itemId;
    feedback = Object.freeze({ type: '', message: '' });
    render();
    try {
      await performAction({ action: 'remove_candidate', expectedUpdatedAt: item.updatedAt, shortlistItemId: itemId }, { successMessage: 'The candidate was removed from this draft shortlist.' });
      dispatchUpdated('remove_candidate', { shortlistItemId: itemId, hiringRequestId: request.id });
      return true;
    } catch (error) {
      feedback = Object.freeze({ type: 'error', message: error.message || 'The candidate could not be removed.' });
      return false;
    } finally { pendingAction = ''; render(); }
  }

  async function sendShortlist(shortlistId, requestId) {
    const id = validUuid(shortlistId);
    const request = workspace.requests.find(candidate => candidate.id === validUuid(requestId));
    if (!id || mode !== 'sales' || !request || request.shortlist.status !== 'draft' || !request.shortlist.items.length || !request.shortlist.canSend || !request.shortlist.updatedAt) return false;
    pendingAction = id;
    render();
    try {
      await performAction({ action: 'send_shortlist', expectedUpdatedAt: request.shortlist.updatedAt, shortlistId: id }, { successMessage: `${request.clientName} can now review ${request.shortlist.items.length} candidate profile${request.shortlist.items.length === 1 ? '' : 's'}.` });
      sendConfirmationId = '';
      dispatchUpdated('send_shortlist', { shortlistId: id, hiringRequestId: request.id });
      return true;
    } catch (error) {
      feedback = Object.freeze({ type: 'error', message: error.message || 'The shortlist could not be sent for client review.' });
      return false;
    } finally { pendingAction = ''; render(); }
  }

  async function respondCandidate(shortlistItemId, response) {
    const itemId = validUuid(shortlistItemId);
    const normalizedResponse = normalizeResponse(response);
    const request = workspace.requests.find(candidate => candidate.id === selectedRequestId);
    const item = request?.shortlist.items.find(candidate => candidate.shortlistItemId === itemId);
    if (!itemId || !normalizedResponse || mode !== 'client' || !item?.canRespond || item.response || !item.updatedAt) return false;
    pendingAction = itemId;
    feedback = Object.freeze({ type: '', message: '' });
    render();
    try {
      await performAction({ action: 'respond_candidate', expectedUpdatedAt: item.updatedAt, shortlistItemId: itemId, response: normalizedResponse }, { successMessage: `Your response was saved: ${responseLabel(normalizedResponse)}.` });
      dispatchUpdated('respond_candidate', { shortlistItemId: itemId, response: normalizedResponse });
      return true;
    } catch (error) {
      feedback = Object.freeze({ type: 'error', message: error.message || 'Your response could not be saved.' });
      return false;
    } finally { pendingAction = ''; render(); }
  }

  function openRequest(requestId) {
    const id = validUuid(requestId);
    if (!id || !workspace.requests.some(request => request.id === id)) return false;
    selectedRequestId = id;
    feedback = Object.freeze({ type: '', message: '' });
    render();
    mountedRoot?.querySelector?.('.shortlist-back')?.focus?.();
    return true;
  }

  function closeRequest() {
    selectedRequestId = '';
    feedback = Object.freeze({ type: '', message: '' });
    render();
    return true;
  }

  function openSendConfirmation(requestId) {
    const id = validUuid(requestId);
    const request = workspace.requests.find(candidate => candidate.id === id);
    if (!request || mode !== 'sales' || request.shortlist.status !== 'draft' || !request.shortlist.items.length || !request.shortlist.canSend || !request.shortlist.updatedAt) return false;
    sendConfirmationId = id;
    render();
    return true;
  }

  function closeSendConfirmation() {
    sendConfirmationId = '';
    render();
    return true;
  }

  function openTalentProfile(applicantId) {
    const id = validUuid(applicantId);
    if (!id || mode !== 'sales' || typeof root?.CustomEvent !== 'function') return false;
    root.dispatchEvent(new root.CustomEvent('soro:client-shortlist-open-profile', { detail: { applicantId: id } }));
    return true;
  }

  function openAvailableTalent() {
    if (mode !== 'sales' || typeof root?.CustomEvent !== 'function') return false;
    root.dispatchEvent(new root.CustomEvent('soro:client-shortlist-open-bench'));
    return true;
  }

  function handleClick(event) {
    const open = event.target.closest?.('[data-shortlist-open]');
    if (open) { openRequest(open.dataset.shortlistOpen); return; }
    if (event.target.closest?.('[data-shortlist-back]')) { closeRequest(); return; }
    if (event.target.closest?.('[data-shortlist-retry]')) { refresh(); return; }
    if (event.target.closest?.('[data-shortlist-bench]')) { openAvailableTalent(); return; }
    if (event.target.closest?.('[data-shortlist-dialog-close]')) { closeSendConfirmation(); return; }
    const send = event.target.closest?.('[data-shortlist-send]');
    if (send && !send.disabled) { openSendConfirmation(send.dataset.shortlistSend); return; }
    const remove = event.target.closest?.('[data-shortlist-remove]');
    if (remove && !remove.disabled) { removeCandidate(remove.dataset.shortlistRemove); return; }
    const profile = event.target.closest?.('[data-shortlist-profile]');
    if (profile) { openTalentProfile(profile.dataset.shortlistProfile); return; }
    const response = event.target.closest?.('[data-shortlist-response]');
    if (response && !response.disabled) respondCandidate(response.dataset.shortlistItemId, response.dataset.shortlistResponse);
  }

  function handleSubmit(event) {
    const form = event.target.closest?.('[data-shortlist-send-form]');
    if (!form) return;
    event.preventDefault();
    const request = workspace.requests.find(candidate => candidate.id === sendConfirmationId);
    if (request) sendShortlist(request.shortlist.id, request.id);
  }

  function mount(target, options = {}) {
    const nextRole = normalizedRole(options.role || effectiveRole());
    const nextMode = text(options.mode, 20).toLowerCase() || modeForRole(nextRole);
    if (!target || typeof target.addEventListener !== 'function' || !canOpenForRole(nextRole, nextMode)) {
      target?.replaceChildren?.();
      return false;
    }
    syncMutationRetryOwner();
    if (mountedRoot && mountedRoot !== target) unmount();
    mountedRoot = target;
    viewerRole = nextRole;
    mode = nextMode;
    selectedRequestId = validUuid(options.requestId, { optional: true });
    activeLoader = typeof options.loader === 'function' ? options.loader : null;
    activeSubmitter = typeof options.submitter === 'function' ? options.submitter : null;
    phase = 'loading';
    message = '';
    feedback = Object.freeze({ type: '', message: '' });
    sendConfirmationId = '';
    target.removeEventListener('click', handleClick);
    target.removeEventListener('submit', handleSubmit);
    target.addEventListener('click', handleClick);
    target.addEventListener('submit', handleSubmit);
    render();
    refresh();
    return true;
  }

  function unmount({ clear = true } = {}) {
    requestVersion += 1;
    activeController?.abort?.();
    activeController = null;
    if (mountedRoot) {
      mountedRoot.removeEventListener?.('click', handleClick);
      mountedRoot.removeEventListener?.('submit', handleSubmit);
      if (clear) mountedRoot.innerHTML = '';
    }
    mountedRoot = null;
    selectedRequestId = '';
    sendConfirmationId = '';
    pendingAction = '';
    activeLoader = null;
    activeSubmitter = null;
    return true;
  }

  function normalizeTalentSummary(source) {
    if (!source || typeof source !== 'object') return null;
    const applicantId = validUuid(source.applicantId || source.id);
    const fullName = text(source.fullName || source.displayName || source.name, 160);
    if (!applicantId || !fullName) return null;
    return Object.freeze({ applicantId, fullName, preferredName: text(source.preferredName, 100) });
  }

  function eligibleAddRequests(talent, sourceWorkspace = workspace) {
    const ownedTalent = sourceWorkspace.candidates.some(candidate => candidate.applicantId === talent.applicantId);
    if (!ownedTalent) return [];
    return sourceWorkspace.requests.filter(request => request.canAddCandidate
      && request.shortlist.status === 'draft'
      && !request.shortlist.items.some(item => item.applicantId === talent.applicantId));
  }

  function overlayMarkup() {
    if (!overlay) return '';
    const talent = overlay.talent;
    if (overlay.phase === 'loading') return `<dialog class="shortlist-dialog shortlist-add-dialog" data-shortlist-add-dialog aria-busy="true"><div class="shortlist-overlay-loading"><span aria-hidden="true"></span><strong>Loading open hiring requests…</strong><p>Finding requests available to your Sales caseload.</p></div></dialog>`;
    if (overlay.phase === 'error') return `<dialog class="shortlist-dialog shortlist-add-dialog" data-shortlist-add-dialog><div class="shortlist-overlay-state" role="alert"><button type="button" class="shortlist-dialog-x" data-shortlist-overlay-close aria-label="Close">×</button><strong>Hiring requests unavailable</strong><p>${escapeHtml(overlay.message)}</p><button type="button" class="button" data-shortlist-overlay-retry>Try again</button></div></dialog>`;
    if (overlay.phase === 'success') return `<dialog class="shortlist-dialog shortlist-add-dialog" data-shortlist-add-dialog><div class="shortlist-overlay-state shortlist-overlay-success" role="status"><span aria-hidden="true">✓</span><strong>Added to shortlist</strong><p>${escapeHtml(talent.fullName)} is now on the draft shortlist for <strong>${escapeHtml(overlay.request.clientName)} · ${escapeHtml(overlay.request.roleTitle)}</strong>.</p><footer><button type="button" class="button" data-shortlist-overlay-close>Keep browsing Talent</button><button type="button" class="button primary" data-shortlist-overlay-review="${overlay.request.id}">Review Shortlist</button></footer></div></dialog>`;
    const requests = eligibleAddRequests(talent, overlay.workspace);
    return `<dialog class="shortlist-dialog shortlist-add-dialog" data-shortlist-add-dialog><form method="dialog" data-shortlist-add-form><header><div><p class="eyebrow">Client shortlist</p><h2>Add to Client Shortlist</h2></div><button type="button" data-shortlist-overlay-close aria-label="Close">×</button></header><p>Choose the specific open hiring request for <strong>${escapeHtml(talent.fullName)}</strong>.</p>${requests.length ? `<fieldset><legend>Open hiring requests</legend>${requests.map((request, index) => `<label class="shortlist-request-option"><input type="radio" name="hiringRequestId" value="${request.id}"${index === 0 ? ' checked' : ''}><span><strong>${escapeHtml(request.clientName)}</strong><b>${escapeHtml(request.roleTitle)}</b><small>${escapeHtml([request.workArea, request.schedule].filter(Boolean).join(' · ') || 'Open hiring request')} · ${request.shortlist.items.length} selected</small></span></label>`).join('')}</fieldset>` : `<div class="shortlist-overlay-empty"><strong>No eligible hiring requests</strong><p>This Talent is already selected for every open draft request you own, or no request is ready for matching.</p></div>`}<p class="shortlist-dialog-message${overlay.message ? ' is-error' : ''}" aria-live="polite">${escapeHtml(overlay.message)}</p><footer><button type="button" class="button" data-shortlist-overlay-close>Cancel</button><button type="submit" class="button primary"${!requests.length || overlay.pending ? ' disabled' : ''}>${overlay.pending ? 'Adding…' : 'Add to Shortlist'}</button></footer></form></dialog>`;
  }

  function renderOverlay() {
    if (!root?.document?.body || !overlay) return false;
    root.document.querySelector('[data-shortlist-overlay-root]')?.remove?.();
    const host = root.document.createElement('div');
    host.dataset.shortlistOverlayRoot = '';
    host.innerHTML = overlayMarkup();
    host.addEventListener('click', handleOverlayClick);
    host.addEventListener('submit', handleOverlaySubmit);
    root.document.body.append(host);
    const dialog = host.querySelector('[data-shortlist-add-dialog]');
    dialog?.addEventListener?.('cancel', event => { event.preventDefault(); closeOverlay(); }, { once: true });
    if (typeof dialog?.showModal === 'function' && !dialog.open) dialog.showModal();
    return true;
  }

  function closeOverlay() {
    root?.document?.querySelector?.('[data-shortlist-overlay-root]')?.remove?.();
    overlay = null;
    overlayReturnFocus?.focus?.();
    overlayReturnFocus = null;
    return true;
  }

  async function loadOverlayWorkspace() {
    const context = overlay;
    if (!context) return false;
    try {
      const result = await invokeLoader(context.role, 'sales');
      if (overlay !== context) return false;
      const nextWorkspace = normalizePayload(result?.workspace || result, context.role, 'sales');
      overlay = { ...context, phase: 'ready', workspace: nextWorkspace, message: '', pending: false };
      workspace = nextWorkspace;
      renderOverlay();
      return true;
    } catch (error) {
      if (overlay !== context) return false;
      overlay = { ...context, phase: 'error', message: error.message || 'Open hiring requests could not be loaded.' };
      renderOverlay();
      return false;
    }
  }

  function openAddDialog(talentInput, options = {}) {
    const role = normalizedRole(options.role || effectiveRole());
    const talent = normalizeTalentSummary(talentInput);
    if (!talent || !SALES_ROLES.has(role) || !root?.document?.body) return false;
    syncMutationRetryOwner();
    overlayReturnFocus = options.returnFocus || root.document.activeElement;
    if (typeof options.loader === 'function') configuredLoader = options.loader;
    if (typeof options.submitter === 'function') configuredSubmitter = options.submitter;
    overlay = { talent, role, owner: mutationRetryOwner, phase: 'loading', message: '', pending: false, workspace: emptyWorkspace(role), request: null };
    renderOverlay();
    loadOverlayWorkspace();
    return true;
  }

  async function addCandidate(hiringRequestId) {
    const context = overlay;
    const requestId = validUuid(hiringRequestId);
    const request = context?.workspace?.requests?.find(candidate => candidate.id === requestId);
    if (!context || !request || context.pending || !request.canAddCandidate) return false;
    overlay = { ...context, pending: true, message: '' };
    renderOverlay();
    try {
      const ownedTalent = context.workspace.candidates.find(candidate => candidate.applicantId === context.talent.applicantId);
      if (!ownedTalent?.updatedAt) throw new Error('This Talent profile changed or is no longer in your Sales caseload. Refresh Available Talent and try again.');
      await executeMutation({ action: 'add_candidate', expectedUpdatedAt: ownedTalent.updatedAt, hiringRequestId: request.id, applicantId: context.talent.applicantId }, {
        role: context.role,
        targetMode: 'sales',
        apply: async result => {
          if (!overlay || context.owner !== mutationRetryOwner) throw new Error('Your Soro account changed before this shortlist action finished.');
          let nextWorkspace = context.workspace;
          if (result?.workspace || result?.requests || result?.hiringRequests || result?.hiring_requests) nextWorkspace = normalizePayload(result?.workspace || result, context.role, 'sales');
          else {
            const refreshed = await invokeLoader(context.role, 'sales');
            nextWorkspace = normalizePayload(refreshed?.workspace || refreshed, context.role, 'sales');
          }
          workspace = nextWorkspace;
          overlay = { ...context, phase: 'success', pending: false, workspace: nextWorkspace, request, message: '' };
          renderOverlay();
          return nextWorkspace;
        }
      });
      dispatchUpdated('add_candidate', { hiringRequestId: request.id, applicantId: context.talent.applicantId });
      return true;
    } catch (error) {
      if (!overlay || context.owner !== mutationRetryOwner) return false;
      overlay = { ...context, phase: 'ready', pending: false, message: error.message || 'This Talent could not be added to the shortlist.' };
      renderOverlay();
      return false;
    }
  }

  function handleOverlayClick(event) {
    if (event.target.closest?.('[data-shortlist-overlay-close]')) { closeOverlay(); return; }
    if (event.target.closest?.('[data-shortlist-overlay-retry]')) {
      overlay = { ...overlay, phase: 'loading', message: '' };
      renderOverlay();
      loadOverlayWorkspace();
      return;
    }
    const review = event.target.closest?.('[data-shortlist-overlay-review]');
    if (review) {
      const requestId = review.dataset.shortlistOverlayReview;
      closeOverlay();
      if (typeof root?.CustomEvent === 'function') root.dispatchEvent(new root.CustomEvent('soro:client-shortlist-open', { detail: { view: 'client-shortlists', requestId } }));
    }
  }

  function handleOverlaySubmit(event) {
    const form = event.target.closest?.('[data-shortlist-add-form]');
    if (!form) return;
    event.preventDefault();
    const requestId = new root.FormData(form).get('hiringRequestId');
    addCandidate(requestId);
  }

  function enhanceAvailableTalentBench(scope = root?.document) {
    if (!scope?.querySelectorAll) return false;
    const role = effectiveRole();
    const transportRole = normalizedRole(root?.soroCurrentAccess?.role) || role;
    const salesView = role === 'admin' || role === 'sales' || role === 'sales_management';
    scope.querySelectorAll('.shortlist-bench-add').forEach(button => {
      if (!salesView) button.remove();
    });
    if (!salesView) return false;
    scope.querySelectorAll('.bench-talent-card').forEach(card => {
      const actions = card.querySelector('.bench-card-actions');
      const assignedOwner = text(card.querySelector('.bench-card-facts > span:nth-child(3) strong')?.textContent, 120);
      const owned = [...(actions?.querySelectorAll?.('.bench-owned-label') || [])].some(label => text(label.textContent, 60) === 'In my caseload')
        || (role === 'admin' && assignedOwner && assignedOwner !== 'Unassigned');
      const benchReady = text(card.dataset.benchStage, 40).toLowerCase() === 'bench_ready';
      if (!actions || !owned || !benchReady || actions.querySelector('.shortlist-bench-add')) return;
      const applicantId = validUuid(card.dataset.applicantId);
      const fullName = text(card.querySelector('.bench-profile-link')?.textContent, 160);
      if (!applicantId || !fullName) return;
      const button = root.document.createElement('button');
      button.type = 'button';
      button.className = 'button primary shortlist-bench-add';
      button.textContent = 'Add to Client Shortlist';
      button.addEventListener('click', event => {
        event.stopPropagation();
        openAddDialog({ applicantId, fullName }, { role: transportRole, returnFocus: button });
      });
      const release = actions.querySelector('.bench-release');
      actions.insertBefore(button, release || null);
    });
    return true;
  }

  function observeAvailableTalentBench() {
    if (!root?.document || typeof root.MutationObserver !== 'function' || benchObserver) return false;
    const start = () => {
      const target = root.document.getElementById('view-root') || root.document.body;
      if (!target || benchObserver) return;
      benchObserver = new root.MutationObserver(() => enhanceAvailableTalentBench(target));
      benchObserver.observe(target, { childList: true, subtree: true });
      enhanceAvailableTalentBench(target);
    };
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
    root.addEventListener?.('soro-auth-changed', () => enhanceAvailableTalentBench(root.document));
    return true;
  }

  function handleAuthChanged(event) {
    const ownerChanged = syncMutationRetryOwner(event?.detail?.session ? event.detail.session?.user?.id : '');
    if (ownerChanged) closeOverlay();
    const nextRole = normalizedRole(event?.detail?.access?.role);
    if (!event?.detail?.session || !canOpenForRole(nextRole)) {
      if (mountedRoot) unmount();
      closeOverlay();
      return;
    }
    const nextMode = modeForRole(nextRole);
    if (mountedRoot) {
      if (ownerChanged || nextRole !== viewerRole || nextMode !== mode) {
        requestVersion += 1;
        activeController?.abort?.();
        activeController = null;
        viewerRole = nextRole;
        mode = nextMode;
        workspace = emptyWorkspace(nextRole);
        selectedRequestId = '';
        pendingAction = '';
        sendConfirmationId = '';
        feedback = Object.freeze({ type: '', message: '' });
      }
      refresh();
      return;
    }
    prime({ role: nextRole, mode: nextMode });
  }

  root?.addEventListener?.('soro-auth-changed', handleAuthChanged);
  observeAvailableTalentBench();

  return Object.freeze({
    ENDPOINT,
    SALES_ROLES,
    CLIENT_ROLES,
    AUTHORIZED_ROLES,
    RESPONSE_VALUES,
    canOpenForRole,
    modeForRole,
    normalizePayload,
    normalizeCandidate,
    normalizeResponse,
    responseLabel,
    workspaceCounts,
    pageMarkup,
    configure,
    prime,
    refresh,
    mount,
    unmount,
    openRequest,
    closeRequest,
    openAddDialog,
    addCandidate,
    removeCandidate,
    sendShortlist,
    respondCandidate,
    enhanceAvailableTalentBench
  });
}));
