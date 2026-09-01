/* Internal Client profile presentation. The backend remains the source of truth for field visibility. */
(() => {
  'use strict';

  const DEFAULT_ENDPOINT = '/.netlify/functions/internal-client-profile';
  let requestVersion = 0;
  let activeController = null;
  const hasOwn = (object, key) => Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
  const text = value => String(value ?? '').trim();
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);

  function firstPresent(candidates) {
    for (const [object, keys] of candidates) {
      for (const key of keys) {
        if (hasOwn(object, key)) return { present: true, value: object[key] };
      }
    }
    return { present: false, value: undefined };
  }

  function titleCase(value) {
    return text(value)
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, character => character.toUpperCase());
  }

  function addressValue(value) {
    if (typeof value === 'string') return text(value);
    if (!value || typeof value !== 'object') return '';
    const lines = Array.isArray(value.lines) ? value.lines.map(text).filter(Boolean) : [];
    const line1 = text(value.line1 ?? value.addressLine1 ?? value.address_line_1);
    const line2 = text(value.line2 ?? value.addressLine2 ?? value.address_line_2);
    const city = text(value.city);
    const state = text(value.stateRegion ?? value.state_region ?? value.state ?? value.province);
    const postalCode = text(value.postalCode ?? value.postal_code ?? value.zip);
    const country = text(value.country);
    return [
      ...lines,
      line1,
      line2,
      [city, state, postalCode].filter(Boolean).join(', '),
      country
    ].filter(Boolean).join('\n');
  }

  function companyAddressField(company, source) {
    const direct = firstPresent([
      [company, ['address']],
      [source, ['address', 'companyAddress', 'company_address']]
    ]);
    if (direct.present) return { present: true, value: addressValue(direct.value) };
    const addressKeys = [
      'addressLine1', 'address_line_1', 'line1', 'addressLine2', 'address_line_2', 'line2',
      'city', 'stateRegion', 'state_region', 'state', 'province', 'postalCode', 'postal_code', 'zip', 'country'
    ];
    if (!addressKeys.some(key => hasOwn(company, key))) return { present: false, value: '' };
    return { present: true, value: addressValue(company) };
  }

  function normalizeProfile(input = {}) {
    const source = input?.profile && typeof input.profile === 'object'
      ? input.profile
      : (input?.client && typeof input.client === 'object' ? input.client : input);
    const company = source?.company && typeof source.company === 'object' ? source.company : source;
    const directContactCandidate = firstPresent([
      [source, ['primaryContact', 'primary_contact']],
      [source, ['contact']]
    ]);
    const contacts = Array.isArray(source?.contacts) ? source.contacts.filter(contact => contact && typeof contact === 'object') : [];
    const listContact = contacts.find(contact => text(contact.contactRole ?? contact.contact_role ?? contact.role).toLowerCase() === 'primary');
    const contactCandidate = directContactCandidate.present
      ? directContactCandidate
      : { present: Boolean(listContact), value: listContact };
    const rawContact = contactCandidate.value && typeof contactCandidate.value === 'object'
      ? contactCandidate.value
      : {};
    const contactIsActive = rawContact.active !== false && rawContact.isActive !== false && rawContact.is_active !== false;
    const ownerCandidate = firstPresent([
      [source, ['owner', 'accountOwner', 'account_owner', 'profileOwner', 'profile_owner']]
    ]);
    const rawOwner = ownerCandidate.value && typeof ownerCandidate.value === 'object'
      ? ownerCandidate.value
      : {};
    const ownerName = typeof ownerCandidate.value === 'string'
      ? text(ownerCandidate.value)
      : text(rawOwner.fullName ?? rawOwner.full_name ?? rawOwner.name);
    const contactName = firstPresent([[rawContact, ['fullName', 'full_name', 'name']]]);
    const contactRole = firstPresent([[rawContact, ['role', 'contactRole', 'contact_role', 'title']]]);
    const contactEmail = firstPresent([[rawContact, ['email']]]);
    const contactPhone = firstPresent([[rawContact, ['phone']]]);
    const companyEmail = firstPresent([
      [company, ['email']],
      [source, ['companyEmail', 'company_email']]
    ]);
    const companyPhone = firstPresent([
      [company, ['phone', 'companyPhone', 'company_phone']],
      [source, ['companyPhone', 'company_phone']]
    ]);
    const companyWebsite = firstPresent([
      [company, ['website']],
      [source, ['website', 'companyWebsite', 'company_website']]
    ]);
    const address = companyAddressField(company, source);

    return {
      id: text(source?.id ?? source?.clientId ?? source?.client_id),
      companyName: text(company?.name ?? company?.companyName ?? company?.company_name ?? source?.companyName ?? source?.company_name ?? source?.name) || 'Client profile',
      industry: text(company?.industry ?? source?.industry),
      lifecycleStage: text(source?.lifecycleStage ?? source?.lifecycle_stage ?? source?.stage),
      owner: {
        present: ownerCandidate.present,
        name: ownerName
      },
      primaryContact: {
        present: contactCandidate.present && contactIsActive,
        name: contactIsActive ? text(contactName.value) : '',
        role: contactIsActive && contactRole.present ? titleCase(contactRole.value) : '',
        email: { present: contactIsActive && contactEmail.present, value: contactIsActive ? text(contactEmail.value) : '' },
        phone: { present: contactIsActive && contactPhone.present, value: contactIsActive ? text(contactPhone.value) : '' }
      },
      companyContact: {
        email: { present: companyEmail.present, value: text(companyEmail.value) },
        phone: { present: companyPhone.present, value: text(companyPhone.value) },
        website: { present: companyWebsite.present, value: text(companyWebsite.value) },
        address
      }
    };
  }

  function initials(name) {
    const words = text(name).split(/\s+/).filter(Boolean);
    return `${words[0]?.[0] || ''}${words.length > 1 ? words[words.length - 1][0] : ''}`.toUpperCase() || 'CL';
  }

  function stageTone(stage) {
    const normalized = text(stage).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (normalized === 'active') return 'active';
    if (normalized === 'paused' || normalized === 'inactive') return 'paused';
    if (normalized === 'matching' || normalized === 'ready-for-matching') return 'matching';
    return 'progress';
  }

  function safeWebsiteHref(value) {
    const raw = text(value);
    if (!raw) return '';
    if (/^[a-z][a-z\d+.-]*:/i.test(raw) && !/^https?:/i.test(raw)) return '';
    const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
      const parsed = new URL(candidate);
      return /^https?:$/.test(parsed.protocol) ? parsed.href : '';
    } catch {
      return '';
    }
  }

  function detailRow(label, value, options = {}) {
    const displayValue = text(value) || 'Not recorded';
    let content = escapeHtml(displayValue);
    if (options.kind === 'website') {
      const href = safeWebsiteHref(displayValue);
      if (href) content = `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(displayValue)}</a>`;
    } else if (options.kind === 'email' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(displayValue)) {
      content = `<a href="mailto:${escapeHtml(displayValue)}">${escapeHtml(displayValue)}</a>`;
    } else if (options.kind === 'phone') {
      const phoneHref = displayValue.replace(/[^\d+]/g, '');
      if (phoneHref) content = `<a href="tel:${escapeHtml(phoneHref)}">${escapeHtml(displayValue)}</a>`;
    }
    return `<div class="internal-client-profile-detail"><dt>${escapeHtml(label)}</dt><dd>${content}</dd></div>`;
  }

  function backLink() {
    return '<a class="internal-client-profile-back" href="#clients" data-internal-client-back>← Back to Clients</a>';
  }

  function stateShell(title, message, state, options = {}) {
    return `<main class="page internal-client-profile-page" data-internal-client-profile data-profile-state="${escapeHtml(state)}">${backLink()}<section class="panel internal-client-profile-state" ${options.alert ? 'role="alert"' : 'role="status"'} ${state === 'loading' ? 'aria-busy="true"' : ''}><span class="internal-client-profile-state-icon" aria-hidden="true"></span><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${options.retry ? '<button class="button" type="button" data-internal-client-retry>Try again</button>' : ''}</section></main>`;
  }

  function renderLoading() {
    return stateShell('Loading Client profile', 'Retrieving the Client details you are authorized to view.', 'loading');
  }

  function renderError(message) {
    return stateShell('Client profile unavailable', message || 'The Client profile could not be loaded. Please try again.', 'error', { alert: true, retry: true });
  }

  function renderNotFound() {
    return stateShell('Client not found', 'This Client is unavailable or you do not have access to its profile.', 'not-found', { alert: true });
  }

  function render(input = {}) {
    const profile = normalizeProfile(input);
    const stageLabel = profile.lifecycleStage ? titleCase(profile.lifecycleStage) : 'Stage not recorded';
    const contact = profile.primaryContact;
    const companyContact = profile.companyContact;
    const companyRows = [
      companyContact.phone.present ? detailRow('Company phone', companyContact.phone.value, { kind: 'phone' }) : '',
      companyContact.email.present ? detailRow('Company email', companyContact.email.value, { kind: 'email' }) : '',
      companyContact.website.present ? detailRow('Website', companyContact.website.value, { kind: 'website' }) : '',
      companyContact.address.present ? detailRow('Address', companyContact.address.value) : ''
    ].filter(Boolean).join('');
    const contactRows = contact.present
      ? [
          detailRow('Contact name', contact.name),
          contact.role ? detailRow('Role', contact.role) : '',
          contact.email.present ? detailRow('Email', contact.email.value, { kind: 'email' }) : '',
          contact.phone.present ? detailRow('Phone', contact.phone.value, { kind: 'phone' }) : ''
        ].filter(Boolean).join('')
      : '';
    const ownerRow = profile.owner.present ? detailRow('Profile owner', profile.owner.name || 'Unassigned') : '';

    return `<main class="page internal-client-profile-page" data-internal-client-profile data-profile-state="ready">${backLink()}<header class="internal-client-profile-heading"><div class="internal-client-profile-mark" aria-hidden="true">${escapeHtml(initials(profile.companyName))}</div><div><p class="eyebrow">Client profile</p><h1>${escapeHtml(profile.companyName)}</h1><div class="internal-client-profile-summary"><span class="internal-client-profile-stage internal-client-profile-stage--${stageTone(profile.lifecycleStage)}">${escapeHtml(stageLabel)}</span>${profile.industry ? `<span>${escapeHtml(profile.industry)}</span>` : ''}</div></div></header><div class="internal-client-profile-grid"><section class="panel internal-client-profile-card" aria-labelledby="internal-client-business-title"><div class="panel-head"><div><p class="eyebrow">Account overview</p><h2 id="internal-client-business-title">Business details</h2></div></div><dl class="internal-client-profile-list">${detailRow('Company', profile.companyName)}${detailRow('Industry', profile.industry)}${detailRow('Lifecycle stage', stageLabel)}${ownerRow}</dl></section><section class="panel internal-client-profile-card" aria-labelledby="internal-client-contact-title"><div class="panel-head"><div><p class="eyebrow">Active contact</p><h2 id="internal-client-contact-title">Primary contact</h2></div></div>${contactRows ? `<dl class="internal-client-profile-list">${contactRows}</dl>` : '<p class="internal-client-profile-empty">No active primary contact is recorded.</p>'}</section>${companyRows ? `<section class="panel internal-client-profile-card internal-client-profile-card--wide" aria-labelledby="internal-client-company-contact-title"><div class="panel-head"><div><p class="eyebrow">Authorized details</p><h2 id="internal-client-company-contact-title">Company contact</h2></div></div><dl class="internal-client-profile-list internal-client-profile-list--columns">${companyRows}</dl></section>` : ''}</div></main>`;
  }

  function bind(root, options = {}) {
    root?.querySelector?.('[data-internal-client-back]')?.addEventListener('click', event => {
      if (typeof options.onBack !== 'function') return;
      event.preventDefault();
      options.onBack(event);
    });
  }

  function mount(root, input, options = {}) {
    if (!root) throw new TypeError('A profile root element is required.');
    root.innerHTML = render(input);
    bind(root, options);
    return normalizeProfile(input);
  }

  function unmount() {
    requestVersion += 1;
    activeController?.abort();
    activeController = null;
  }

  async function accessToken(options) {
    if (text(options.accessToken)) return text(options.accessToken);
    if (!window.soroSupabase?.auth?.getSession) throw new Error('Your secure session is unavailable.');
    const { data, error } = await window.soroSupabase.auth.getSession();
    if (error || !data?.session?.access_token) throw new Error('Your secure session expired. Sign in again and retry.');
    return data.session.access_token;
  }

  async function load(root, options = {}) {
    if (!root) throw new TypeError('A profile root element is required.');
    const version = ++requestVersion;
    activeController?.abort();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    activeController = controller;
    const id = text(options.id);
    if (!id || !/^[a-z\d_-]{1,200}$/i.test(id)) {
      root.innerHTML = renderNotFound();
      bind(root, options);
      if (activeController === controller) activeController = null;
      return null;
    }
    root.innerHTML = renderLoading();
    bind(root, options);
    try {
      const token = await accessToken(options);
      const fetchProfile = options.fetch || window.fetch.bind(window);
      const endpoint = text(options.endpoint) || DEFAULT_ENDPOINT;
      const separator = endpoint.includes('?') ? '&' : '?';
      const response = await fetchProfile(`${endpoint}${separator}id=${encodeURIComponent(id)}`, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        cache: 'no-store',
        signal: controller?.signal
      });
      let result = {};
      try { result = await response.json(); } catch { result = {}; }
      if (version !== requestVersion || root.isConnected === false) return null;
      if (response.status === 404) {
        root.innerHTML = renderNotFound();
        bind(root, options);
        return null;
      }
      if (!response.ok) throw new Error(response.status === 401 ? 'Your secure session expired. Sign in again and retry.' : 'The Client profile could not be loaded. Please try again.');
      return mount(root, result, options);
    } catch (error) {
      if (error?.name === 'AbortError' || version !== requestVersion || root.isConnected === false) return null;
      root.innerHTML = renderError(error?.message);
      bind(root, options);
      root.querySelector?.('[data-internal-client-retry]')?.addEventListener('click', () => load(root, options));
      return null;
    } finally {
      if (activeController === controller) activeController = null;
    }
  }

  window.SoroInternalClientProfile = Object.freeze({
    load,
    mount,
    normalizeProfile,
    render,
    renderError,
    renderLoading,
    renderNotFound,
    unmount
  });
})();
