/* Safe, read-only Talent profile loader for Sales and Sales Management. */
(() => {
  'use strict';

  const ENDPOINT = '/.netlify/functions/internal-talent-profile';
  const READ_ONLY_ROLES = new Set(['sales', 'sales_management']);
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const MAX_SKILLS = 100;
  let activeController = null;
  let requestVersion = 0;

  const text = value => String(value ?? '').trim();
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);

  function effectiveRole() {
    if (typeof currentAuthenticatedRole === 'function') return text(currentAuthenticatedRole()).toLowerCase();
    return text(window.soroCurrentAccess?.role).toLowerCase();
  }

  function canOpenForRole(role = effectiveRole()) {
    return READ_ONLY_ROLES.has(text(role).toLowerCase());
  }

  function safeText(value, maximum = 5000) {
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    return text(value).slice(0, maximum);
  }

  function safeList(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map(item => safeText(item, 160)).filter(Boolean))].slice(0, MAX_SKILLS);
  }

  function normalizeTalent(payload) {
    const source = payload?.talent;
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    const id = text(source.id).toLowerCase();
    const fullName = safeText(source.full_name, 240);
    if (!UUID_PATTERN.test(id) || !fullName) return null;
    return {
      id,
      full_name: fullName,
      preferred_name: safeText(source.preferred_name, 120),
      country: safeText(source.country, 120),
      location: safeText(source.country, 120),
      timezone: safeText(source.timezone, 120),
      status: safeText(source.status, 80),
      work_status: safeText(source.work_status, 80),
      availability_note: safeText(source.availability_note, 500),
      application_received_at: safeText(source.application_received_at, 80),
      expected_hourly_rate_text: safeText(source.expected_hourly_rate_text, 120),
      verified_skills: safeList(source.verified_skills),
      self_reported_experience_areas: safeList(source.self_reported_experience_areas),
      self_reported_skills: safeList(source.self_reported_skills),
      other_experience_specialty: safeText(source.other_experience_specialty, 160),
      relevant_experience_years: safeText(source.relevant_experience_years, 40),
      relevant_experience_summary: safeText(source.relevant_experience_summary),
      education_training_summary: safeText(source.education_training_summary),
      english_test_result: safeText(source.english_test_result, 240),
      personality_profile_score: safeText(source.personality_profile_score, 500),
      computer_specs: safeText(source.computer_specs, 1000),
      internet_speed: safeText(source.internet_speed, 240)
    };
  }

  function accountKey(id) {
    const access = window.soroCurrentAccess || {};
    return `${text(access.user_id)}:${effectiveRole()}:${text(id).toLowerCase()}`;
  }

  function reset() {
    requestVersion += 1;
    activeController?.abort();
    activeController = null;
  }

  function renderLoading() {
    return '<main class="page talent-profile-page"><section class="panel profile-missing" aria-busy="true"><p class="eyebrow">Talent profile</p><h1>Loading Talent profile…</h1><p>Opening the approved read-only profile.</p></section></main>';
  }

  function renderError(message) {
    return `<main class="page talent-profile-page"><section class="panel profile-missing" role="alert"><p class="eyebrow">Talent profile</p><h1>Talent profile unavailable</h1><p>${escapeHtml(message || 'This Talent profile could not be loaded.')}</p><button class="button" type="button" data-readonly-talent-retry>Try again</button></section></main>`;
  }

  async function requestTalent(id) {
    if (!window.soroSupabase?.auth?.getSession) throw new Error('Soro sign-in is still loading. Refresh and try again.');
    const { data, error } = await window.soroSupabase.auth.getSession();
    const token = data?.session?.access_token;
    if (error || !token) throw new Error('Your secure session expired. Sign in again and retry.');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    activeController?.abort();
    activeController = controller;
    const timeout = controller ? window.setTimeout(() => controller.abort(), 25000) : null;
    let response;
    try {
      response = await fetch(`${ENDPOINT}?id=${encodeURIComponent(id)}`, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        cache: 'no-store',
        signal: controller?.signal
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('The secure request took too long. Please try again.');
      throw new Error('Soro could not reach the secure Talent profile service. Check your connection and try again.');
    } finally {
      if (timeout) window.clearTimeout(timeout);
      if (activeController === controller) activeController = null;
    }
    const responseText = await response.text();
    let payload = {};
    if (responseText) {
      try { payload = JSON.parse(responseText); }
      catch { throw new Error(`The secure Talent profile service returned an unexpected response (${response.status}).`); }
    }
    if (!response.ok) throw new Error(payload.message || 'This Talent profile could not be loaded.');
    const talent = normalizeTalent(payload);
    if (!talent) throw new Error('The secure Talent profile service returned an invalid profile.');
    return talent;
  }

  function applyReadOnlyPresentation(root, onBack) {
    const page = root.querySelector('.talent-profile-page');
    page?.classList.add('talent-profile-page--sales-readonly');
    const upload = root.querySelector('.headshot-upload');
    if (upload) {
      const note = upload.nextElementSibling;
      if (note?.tagName === 'SMALL') note.remove();
      upload.remove();
    }
    [
      '#profile-add-task', '#edit-private-profile-details', '#private-profile-details-dialog',
      '#edit-screening-results', '#screening-results-dialog', '#review-talent-skills',
      '#edit-skills-experience', '.admin-profile-controls', '.talent-portal-access-card',
      '.talent-profile-danger-zone', '.profile-resume-access', '.screening-source-links',
      '.profile-contact', '.profile-private-address', '.private-identity-detail',
      '.profile-introduction-video-slot'
    ].forEach(selector => root.querySelectorAll(selector).forEach(element => element.remove()));
    root.querySelectorAll('.profile-details > div').forEach(row => {
      if (/^Dream\s*\/\s*goal$/i.test(text(row.querySelector('dt')?.textContent))) row.remove();
    });
    root.querySelectorAll('.profile-stat-grid article').forEach(card => {
      if (/^Profile owner$/i.test(text(card.querySelector('p')?.textContent))) card.remove();
    });
    const actions = root.querySelector('.profile-actions');
    if (actions) actions.innerHTML = '<span class="tag neutral">View only</span>';
    const back = root.querySelector('.back-to-directory');
    if (back) {
      back.textContent = '← Back';
      back.addEventListener('click', event => {
        event.preventDefault();
        onBack?.();
      });
    }
  }

  function pageIsCurrent(id) {
    return canOpenForRole()
      && typeof current !== 'undefined'
      && current === 'talent-profile'
      && text(selectedTalentId).toLowerCase() === text(id).toLowerCase();
  }

  function renderTalent(root, talent, onBack) {
    if (typeof profilePage !== 'function') {
      root.innerHTML = renderError('The Talent profile view is still loading. Refresh and try again.');
      return;
    }
    root.innerHTML = profilePage(talent);
    applyReadOnlyPresentation(root, onBack);
  }

  async function load(root, id, key, version, onBack) {
    try {
      const talent = await requestTalent(id);
      if (version !== requestVersion || !pageIsCurrent(id) || key !== accountKey(id)) return;
      renderTalent(root, talent, onBack);
    } catch (error) {
      if (version !== requestVersion || !pageIsCurrent(id)) return;
      root.innerHTML = renderError(error.message);
      root.querySelector('[data-readonly-talent-retry]')?.addEventListener('click', () => mount(root, { id, onBack }));
    }
  }

  function mount(root, { id, onBack } = {}) {
    const normalizedId = text(id).toLowerCase();
    if (!root || !canOpenForRole() || !UUID_PATTERN.test(normalizedId)) {
      reset();
      if (root) root.innerHTML = renderError('Choose a valid Talent profile.');
      return;
    }
    const key = accountKey(normalizedId);
    const version = ++requestVersion;
    root.innerHTML = renderLoading();
    load(root, normalizedId, key, version, onBack);
  }

  window.addEventListener('soro-auth-changed', event => {
    const access = event.detail?.access;
    if (!access || !READ_ONLY_ROLES.has(effectiveRole())) reset();
  });

  window.SoroReadOnlyTalentProfile = Object.freeze({
    applyReadOnlyPresentation,
    canOpenForRole,
    mount,
    normalizeTalent,
    renderError,
    renderLoading,
    reset
  });
})();
