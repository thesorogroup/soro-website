/* Read-only Talent profiles shared with an authenticated client account. */
(() => {
  'use strict';

  const ENDPOINT = '/.netlify/functions/client-talent-profile';
  const CLIENT_TALENT_ROLES = new Set(['client_admin', 'client_reviewer']);
  let cachedDirectory = null;
  let cachedAccountKey = '';
  let selectedTalentId = '';
  let requestVersion = 0;
  let activeController = null;
  let folderHeightObserver = null;

  const text = value => String(value ?? '').trim();
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);

  function currentAccess() {
    return window.soroCurrentAccess || null;
  }

  function currentRole() {
    return text(currentAccess()?.role).toLowerCase();
  }

  function canOpenTalentProfile(role = currentRole()) {
    return CLIENT_TALENT_ROLES.has(text(role).toLowerCase());
  }

  function accountKey(access = currentAccess()) {
    return `${text(access?.user_id)}:${text(access?.role).toLowerCase()}`;
  }

  function reset() {
    requestVersion += 1;
    activeController?.abort();
    activeController = null;
    cachedDirectory = null;
    cachedAccountKey = '';
    selectedTalentId = '';
    folderHeightObserver?.disconnect();
    folderHeightObserver = null;
  }

  function safeSummary(value) {
    if (typeof value === 'string' || typeof value === 'number') return text(value);
    if (Array.isArray(value) && value.every(item => typeof item === 'string' || typeof item === 'number')) {
      return value.map(text).filter(Boolean).join(' · ');
    }
    return '';
  }

  function normalizeSkill(value) {
    if (typeof value === 'string') return { name: text(value), years: '' };
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const name = text(value.name || value.label || value.skill);
    if (!name) return null;
    const yearsValue = value.years ?? value.yearsExperience ?? value.experienceYears;
    const years = typeof yearsValue === 'number' || typeof yearsValue === 'string' ? text(yearsValue) : '';
    return { name, years };
  }

  function normalizeAssignment(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const id = text(value.id);
    if (!id) return null;
    return {
      id,
      status: text(value.status),
      startDate: text(value.startDate),
      scheduleSummary: text(value.scheduleSummary)
    };
  }

  function normalizeTalent(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const id = text(value.id);
    const displayName = text(value.displayName);
    if (!id || !displayName) return null;
    const location = value.location && typeof value.location === 'object' && !Array.isArray(value.location) ? value.location : {};
    const skills = value.skills && typeof value.skills === 'object' && !Array.isArray(value.skills) ? value.skills : {};
    const experience = value.experience && typeof value.experience === 'object' && !Array.isArray(value.experience) ? value.experience : {};
    const screening = value.screening && typeof value.screening === 'object' && !Array.isArray(value.screening) ? value.screening : {};
    return {
      id,
      displayName,
      location: {
        country: text(location.country),
        timeZone: text(location.timeZone)
      },
      skills: {
        verified: (Array.isArray(skills.verified) ? skills.verified : []).map(normalizeSkill).filter(Boolean)
      },
      experience: {
        years: safeSummary(experience.years),
        summary: safeSummary(experience.summary),
        educationAndTraining: safeSummary(experience.educationAndTraining)
      },
      screening: {
        englishResult: safeSummary(screening.englishResult),
        personalityResult: safeSummary(screening.personalityResult),
        computerSpecifications: safeSummary(screening.computerSpecifications),
        internetSpeed: safeSummary(screening.internetSpeed)
      },
      assignments: (Array.isArray(value.assignments) ? value.assignments : []).map(normalizeAssignment).filter(Boolean)
    };
  }

  function normalizeDirectory(result = {}) {
    const talents = (Array.isArray(result.talents) ? result.talents : []).map(normalizeTalent).filter(Boolean);
    return {
      talents,
      count: talents.length,
      presentation: {
        tabs: ['profile'],
        readOnly: true,
        documentsAvailable: false,
        sourceFilesAvailable: false
      }
    };
  }

  function titleCase(value, fallback = 'Not recorded') {
    const source = text(value);
    return source ? source.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase()) : fallback;
  }

  function formatDate(value) {
    const source = text(value);
    if (!source) return 'Not recorded';
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(source);
    const date = dateOnly
      ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
      : new Date(source);
    return Number.isNaN(date.getTime()) ? source : date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  }

  function initials(name) {
    const source = text(name).replace(/\s+/g, ' ');
    if (!source) return 'VA';
    const commaParts = source.split(',').map(part => part.trim()).filter(Boolean);
    const ordered = commaParts.length > 1
      ? `${commaParts.slice(1).join(' ')} ${commaParts[0]}`.trim().split(/\s+/)
      : source.split(/\s+/);
    return `${ordered[0]?.[0] || ''}${ordered.length > 1 ? ordered[ordered.length - 1][0] : ''}`.toUpperCase() || 'VA';
  }

  function locationText(talent) {
    return talent.location.country || 'Not recorded';
  }

  function assignmentFor(talent) {
    return talent.assignments[0] || { id: '', status: '', startDate: '', scheduleSummary: '' };
  }

  function selectorMarkup(directory, talent) {
    if (directory.talents.length < 2) return '';
    return `<section class="panel client-talent-chooser" aria-labelledby="client-talent-chooser-title"><div><p class="eyebrow">Your assigned Talent</p><h2 id="client-talent-chooser-title">Choose a profile</h2></div><label><span>Talent Profile</span><select data-client-talent-select>${directory.talents.map(item => `<option value="${escapeHtml(item.id)}"${item.id === talent.id ? ' selected' : ''}>${escapeHtml(item.displayName)}</option>`).join('')}</select></label></section>`;
  }

  function profileDetailsMarkup(talent) {
    const details = [
      ['Relevant experience', talent.experience.years ? `${talent.experience.years}${/^\d+(?:\.\d+)?$/.test(talent.experience.years) ? ' years' : ''}` : 'Not recorded'],
      ['Experience summary', talent.experience.summary || 'Not recorded'],
      ['Education & training', talent.experience.educationAndTraining || 'Not recorded']
    ];
    return `<section class="panel client-talent-details"><div class="panel-head"><div><p class="eyebrow">At a glance</p><h2>Profile details</h2></div><span class="client-talent-readonly">Read only</span></div><dl>${details.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl></section>`;
  }

  function skillsMarkup(talent) {
    const content = talent.skills.verified.length
      ? `<ul>${talent.skills.verified.map(skill => `<li><span>${escapeHtml(skill.name)}</span>${skill.years ? `<small>${escapeHtml(skill.years)}${/^\d+(?:\.\d+)?$/.test(skill.years) ? ' yrs' : ''}</small>` : ''}</li>`).join('')}</ul>`
      : '<div class="client-talent-empty"><strong>No verified skills have been shared yet</strong><p>Only skills verified by Soro Talent Management appear in the Client Portal.</p></div>';
    return `<section class="panel client-talent-skills"><div class="panel-head"><div><p class="eyebrow">Matching profile</p><h2>Skills &amp; experience</h2></div><span class="client-talent-verified">Soro verified</span></div>${content}</section>`;
  }

  function screeningMarkup(talent) {
    const summaries = [
      ['English proficiency', talent.screening.englishResult, 'EN'],
      ['Personality profile', talent.screening.personalityResult, 'PP'],
      ['Computer specifications', talent.screening.computerSpecifications, 'PC'],
      ['Internet speed', talent.screening.internetSpeed, '↕']
    ].filter(([, value]) => value);
    if (!summaries.length) return '';
    return `<section class="panel client-talent-screening"><div class="panel-head"><div><p class="eyebrow">Client-ready summary</p><h2>Screening results</h2><p>Only Soro-recorded summaries approved for this profile are shown.</p></div><span class="client-talent-verified">Soro verified</span></div><div class="client-talent-screening-list">${summaries.map(([label, value, icon]) => `<article><span aria-hidden="true">${escapeHtml(icon)}</span><div><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></div></article>`).join('')}</div></section>`;
  }

  function approvedFolderArtwork() {
    return window.SoroTalentProfileVisuals?.folderArtwork({
      tabCount: 4,
      activeIndex: 0,
      includeInactive: false,
      classPrefix: 'client-talent',
      idPrefix: 'client-talent'
    }) || '';
  }

  function approvedPortraitArtwork(displayName) {
    return window.SoroTalentProfileVisuals?.portraitPlaceholder(initials(displayName), { idPrefix: 'client-talent' })
      || `<svg viewBox="0 0 160 190" aria-hidden="true"><defs><linearGradient id="client-talent-portrait-backdrop" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2f5e88"/><stop offset="1" stop-color="#7fa7c3"/></linearGradient></defs><rect width="160" height="190" fill="url(#client-talent-portrait-backdrop)"/><circle cx="80" cy="64" r="29" fill="#e3edf4" fill-opacity=".68"/><path d="M22 190c4-52 25-82 58-82s54 30 58 82z" fill="#dbe8f1" fill-opacity=".56"/></svg><span>${escapeHtml(initials(displayName))}</span>`;
  }

  function approvedPaperclipArtwork() {
    return window.SoroTalentProfileVisuals?.paperclipArtwork({ classPrefix: 'client-talent' })
      || '<svg class="client-talent-paperclip" viewBox="0 0 48 110" aria-hidden="true"><path class="client-talent-paperclip-wire" d="M31 13.5C31 2.5 8 2.5 8 22v70c0 15 23 15 23 0V28c0-9-12-9-12 0v63"/><path class="client-talent-paperclip-divider" d="M29 15H48"/></svg>';
  }

  function renderTalent(directory, talent) {
    const assignment = assignmentFor(talent);
    const assignmentCount = talent.assignments.length;
    return `<section class="client-talent-folder" aria-labelledby="client-talent-name">${approvedFolderArtwork()}<div class="client-talent-folder-tab" aria-current="page">Profile</div><div class="client-talent-folder-body"><div class="client-talent-folder-lip" aria-hidden="true"></div><header class="client-talent-hero"><div class="client-talent-photo-wrap"><div class="client-talent-photo" aria-label="Profile placeholder for ${escapeHtml(talent.displayName)}">${approvedPortraitArtwork(talent.displayName)}</div>${approvedPaperclipArtwork()}</div><div class="client-talent-identity"><p class="eyebrow">Talent profile</p><h1 id="client-talent-name">${escapeHtml(talent.displayName)}</h1><div class="client-talent-tags"><span>Assigned to your company</span>${assignment.status ? `<span>${escapeHtml(titleCase(assignment.status))}</span>` : ''}</div></div><aside class="client-talent-assignment"><p class="eyebrow">Current assignment</p><h2>${escapeHtml(titleCase(assignment.status, 'Assigned'))}</h2><dl><div><dt>Start date</dt><dd>${escapeHtml(formatDate(assignment.startDate))}</dd></div><div><dt>Schedule</dt><dd>${escapeHtml(assignment.scheduleSummary || 'Not recorded')}</dd></div></dl>${assignmentCount > 1 ? `<small>${assignmentCount} current assignment records are linked to this Talent.</small>` : ''}</aside></header></div><div class="client-talent-summary-grid"><article><span>Location &amp; time zone</span><strong>${escapeHtml(locationText(talent))}</strong><small>${escapeHtml(talent.location.timeZone || 'Time zone not recorded')}</small></article><article><span>Assignment status</span><strong>${escapeHtml(titleCase(assignment.status, 'Assigned'))}</strong><small>Visible for your company only</small></article><article><span>Placement start</span><strong>${escapeHtml(formatDate(assignment.startDate))}</strong><small>Current placement</small></article><article><span>Schedule</span><strong>${escapeHtml(assignment.scheduleSummary || 'Not recorded')}</strong><small>Confirmed assignment schedule</small></article></div><div class="client-talent-profile-grid"><div class="client-talent-left-column">${profileDetailsMarkup(talent)}${screeningMarkup(talent)}</div>${skillsMarkup(talent)}</div></section>`;
  }

  function syncFolderArtwork(root = document) {
    const folder = root?.querySelector?.('.client-talent-folder');
    const body = folder?.querySelector('.client-talent-folder-body');
    const art = folder?.querySelector('.client-talent-folder-art');
    if (!body || !art || !window.SoroTalentProfileVisuals) return;
    window.SoroTalentProfileVisuals.resizeFolderArtwork(art, body.getBoundingClientRect().height, { classPrefix: 'client-talent' });
  }

  function refreshVisuals(root = document) {
    folderHeightObserver?.disconnect();
    folderHeightObserver = null;
    const folderBody = root?.querySelector?.('.client-talent-folder-body');
    syncFolderArtwork(root);
    if (folderBody && typeof ResizeObserver === 'function') {
      folderHeightObserver = new ResizeObserver(() => syncFolderArtwork(root));
      folderHeightObserver.observe(folderBody);
    }
  }

  function unmount() {
    folderHeightObserver?.disconnect();
    folderHeightObserver = null;
  }

  function renderProfile(input = {}, preferredTalentId = '') {
    const directory = normalizeDirectory(input);
    if (!directory.talents.length) {
      return `<main class="page client-talent-page" data-client-talent-page><div class="page-heading"><div><p class="eyebrow">Client Portal</p><h1>Talent Profile</h1><p class="client-talent-intro">Profiles for Talent currently assigned to your company appear here.</p></div></div><section class="panel client-talent-empty-state"><span aria-hidden="true">◇</span><h2>No Talent Profile is available yet</h2><p>Once Soro links an active Talent assignment to your company, the approved profile will appear here automatically.</p></section></main>`;
    }
    const requested = text(preferredTalentId || selectedTalentId);
    const talent = directory.talents.find(item => item.id === requested) || directory.talents[0];
    return `<main class="page client-talent-page" data-client-talent-page><div class="page-heading client-talent-page-heading"><div><p class="eyebrow">Client Portal</p><h1>Talent Profile</h1><p class="client-talent-intro">Review the approved profile for Talent currently assigned to your company.</p></div></div>${selectorMarkup(directory, talent)}${renderTalent(directory, talent)}</main>`;
  }

  function renderLoading() {
    return `<main class="page client-talent-page" data-client-talent-page aria-busy="true"><div class="page-heading"><div><p class="eyebrow">Client Portal</p><h1>Talent Profile</h1><p class="client-talent-intro">Loading the approved Talent Profile…</p></div></div><section class="panel client-talent-loading" aria-live="polite"><span></span><span></span><span></span><p>Loading your assigned Talent…</p></section></main>`;
  }

  function renderError(message) {
    return `<main class="page client-talent-page" data-client-talent-page><div class="page-heading"><div><p class="eyebrow">Client Portal</p><h1>Talent Profile</h1></div></div><section class="panel client-talent-error" role="alert"><h2>Talent Profile unavailable</h2><p>${escapeHtml(message || 'The assigned Talent Profile could not be loaded. Please try again.')}</p><button class="button" type="button" data-client-talent-retry>Try again</button></section></main>`;
  }

  async function request() {
    if (!window.soroSupabase) throw new Error('Soro sign-in is still loading. Refresh and try again.');
    const { data: { session }, error: sessionError } = await window.soroSupabase.auth.getSession();
    if (sessionError || !session?.access_token) throw new Error('Your secure session expired. Sign in again and retry.');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    activeController?.abort();
    activeController = controller;
    const timeout = controller ? window.setTimeout(() => controller.abort(), 25000) : null;
    let response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'GET',
        headers: { Authorization: `Bearer ${session.access_token}` },
        signal: controller?.signal
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('The secure request took too long. Please try again.');
      throw new Error('Soro could not reach the secure Talent Profile service. Check your connection and try again.');
    } finally {
      if (timeout) window.clearTimeout(timeout);
      if (activeController === controller) activeController = null;
    }
    const responseText = await response.text();
    let result = {};
    if (responseText) {
      try { result = JSON.parse(responseText); }
      catch { throw new Error(`The secure Talent Profile service returned an unexpected response (${response.status}).`); }
    }
    if (!response.ok) throw new Error(result.message || 'The assigned Talent Profile could not be loaded.');
    return result;
  }

  function pageIsCurrent(root, key) {
    return Boolean(
      root?.isConnected
      && root.querySelector('[data-client-talent-page]')
      && canOpenTalentProfile()
      && accountKey() === key
      && (typeof current === 'undefined' || current === 'client-talent-profile')
    );
  }

  function bindProfile(root, directory, key) {
    refreshVisuals(root);
    root.querySelector('[data-client-talent-select]')?.addEventListener('change', event => {
      if (!pageIsCurrent(root, key)) return;
      const requested = text(event.target.value);
      if (!directory.talents.some(item => item.id === requested)) return;
      selectedTalentId = requested;
      root.innerHTML = renderProfile(directory, selectedTalentId);
      bindProfile(root, directory, key);
      root.querySelector('[data-client-talent-select]')?.focus();
    });
  }

  async function load(root, key) {
    const version = ++requestVersion;
    try {
      const result = await request();
      if (version !== requestVersion || !pageIsCurrent(root, key)) return;
      const directory = normalizeDirectory(result);
      cachedDirectory = directory;
      cachedAccountKey = key;
      if (!directory.talents.some(item => item.id === selectedTalentId)) selectedTalentId = directory.talents[0]?.id || '';
      root.innerHTML = renderProfile(directory, selectedTalentId);
      bindProfile(root, directory, key);
    } catch (error) {
      if (version !== requestVersion || !pageIsCurrent(root, key)) return;
      root.innerHTML = renderError(error.message);
      root.querySelector('[data-client-talent-retry]')?.addEventListener('click', () => {
        root.innerHTML = renderLoading();
        load(root, key);
      });
    }
  }

  function mount(root) {
    if (!root || !canOpenTalentProfile()) {
      reset();
      root?.replaceChildren();
      return;
    }
    const key = accountKey();
    if (!text(currentAccess()?.user_id) || !key.startsWith(`${text(currentAccess()?.user_id)}:`)) {
      root.innerHTML = renderError('Your secure client account is not available.');
      return;
    }
    if (cachedAccountKey && cachedAccountKey !== key) reset();
    if (cachedDirectory && cachedAccountKey === key) {
      root.innerHTML = renderProfile(cachedDirectory, selectedTalentId);
      bindProfile(root, cachedDirectory, key);
      return;
    }
    root.innerHTML = renderLoading();
    load(root, key);
  }

  window.addEventListener('soro-auth-changed', event => {
    const access = event.detail?.access;
    const nextKey = access && event.detail?.session ? `${text(event.detail.session.user?.id)}:${text(access.role).toLowerCase()}` : '';
    if (!nextKey || nextKey !== cachedAccountKey) reset();
  });

  window.SoroClientTalentProfile = Object.freeze({ canOpenTalentProfile, mount, normalizeDirectory, refreshVisuals, renderError, renderLoading, renderProfile, reset, unmount });
  window.SORO_CLIENT_TALENT_PROFILE_PREVIEW = Object.freeze({ normalizeDirectory, refreshVisuals, renderProfile, unmount });
})();
