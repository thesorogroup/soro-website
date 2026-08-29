/* Client self-service profile. Authorization remains server-enforced. */
(() => {
  'use strict';

  const ENDPOINT = '/.netlify/functions/client-profile';
  const CLIENT_ROLES = new Set(['client_admin', 'client_reviewer', 'client_billing']);
  const ROLE_LABELS = Object.freeze({
    client_admin: 'Client Administrator',
    client_reviewer: 'Client Reviewer',
    client_billing: 'Client Billing'
  });
  const COMPANY_FIELDS = Object.freeze([
    ['addressLine1', 'companyAddressLine1'], ['addressLine2', 'companyAddressLine2'],
    ['city', 'companyCity'], ['stateRegion', 'companyStateRegion'],
    ['postalCode', 'companyPostalCode'], ['country', 'companyCountry'],
    ['phone', 'companyPhone'], ['website', 'companyWebsite']
  ]);

  let cachedProfile = null;
  let cachedAccountKey = '';
  let requestVersion = 0;
  let activeController = null;

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

  function canOpenProfile(role = currentRole()) {
    return CLIENT_ROLES.has(text(role).toLowerCase());
  }

  function accountKey(access = currentAccess()) {
    return `${text(access?.user_id)}:${text(access?.role).toLowerCase()}`;
  }

  function reset() {
    requestVersion += 1;
    activeController?.abort();
    activeController = null;
    cachedProfile = null;
    cachedAccountKey = '';
  }

  function normalizeProfile(result = {}, context = {}) {
    const source = result.profile && typeof result.profile === 'object' ? result.profile : result;
    const contact = source.contact && typeof source.contact === 'object' ? source.contact : {};
    const company = source.company && typeof source.company === 'object' ? source.company : {};
    const permissions = result.permissions && typeof result.permissions === 'object'
      ? result.permissions
      : (source.permissions && typeof source.permissions === 'object' ? source.permissions : {});
    const role = text(context.role || source.portalRole || currentRole()).toLowerCase();
    return {
      contact: {
        fullName: text(contact.fullName),
        phone: text(contact.phone)
      },
      company: {
        name: text(company.name),
        industry: text(company.industry),
        addressLine1: text(company.addressLine1),
        addressLine2: text(company.addressLine2),
        city: text(company.city),
        stateRegion: text(company.stateRegion),
        postalCode: text(company.postalCode),
        country: text(company.country),
        phone: text(company.phone),
        website: text(company.website)
      },
      permissions: {
        canEditCompany: permissions.canEditCompany === true && role === 'client_admin',
        editableFields: Array.isArray(permissions.editableFields) ? permissions.editableFields.map(text) : []
      },
      portalRole: ROLE_LABELS[role] || 'Client Portal user',
      role,
      signInEmail: text(context.signInEmail || source.signInEmail),
      changedFields: Array.isArray(result.changedFields) ? result.changedFields.map(text) : []
    };
  }

  function companyAddress(company) {
    return [
      company.addressLine1,
      company.addressLine2,
      [company.city, company.stateRegion, company.postalCode].filter(Boolean).join(', '),
      company.country
    ].filter(Boolean).join('\n') || 'Not recorded';
  }

  function readonlyValue(label, value) {
    return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value || 'Not recorded')}</dd></div>`;
  }

  function contactFields(profile) {
    return `<fieldset class="client-profile-fieldset"><legend>Your contact details</legend><p>These details help Soro reach you about your account and active services.</p><div class="client-profile-form-grid"><label>Contact name<input name="contactFullName" autocomplete="name" maxlength="120" required value="${escapeHtml(profile.contact.fullName)}"></label><label>Phone number<input name="contactPhone" type="tel" autocomplete="tel" maxlength="40" value="${escapeHtml(profile.contact.phone)}"></label></div></fieldset>`;
  }

  function editableCompanyFields(company) {
    return `<fieldset class="client-profile-fieldset"><legend>Company contact details</legend><p>Client Administrators can keep the company’s primary contact information current.</p><div class="client-profile-form-grid"><label class="client-profile-wide">Street address<input name="companyAddressLine1" autocomplete="address-line1" maxlength="160" value="${escapeHtml(company.addressLine1)}"></label><label class="client-profile-wide">Apartment, suite, or unit <span>Optional</span><input name="companyAddressLine2" autocomplete="address-line2" maxlength="160" value="${escapeHtml(company.addressLine2)}"></label><label>City<input name="companyCity" autocomplete="address-level2" maxlength="100" value="${escapeHtml(company.city)}"></label><label>State / province / region<input name="companyStateRegion" autocomplete="address-level1" maxlength="100" value="${escapeHtml(company.stateRegion)}"></label><label>Postal code<input name="companyPostalCode" autocomplete="postal-code" maxlength="24" value="${escapeHtml(company.postalCode)}"></label><label>Country<input name="companyCountry" autocomplete="country-name" maxlength="100" value="${escapeHtml(company.country)}"></label><label>Company phone<input name="companyPhone" type="tel" autocomplete="tel" maxlength="40" value="${escapeHtml(company.phone)}"></label><label>Company website<input name="companyWebsite" type="url" inputmode="url" autocomplete="url" maxlength="240" placeholder="https://example.com" value="${escapeHtml(company.website)}"></label></div></fieldset>`;
  }

  function readonlyCompanyContact(company) {
    return `<section class="panel client-profile-company-readonly" aria-labelledby="client-company-contact-title"><div class="panel-head"><div><p class="eyebrow">Company contact</p><h2 id="client-company-contact-title">Contact details</h2></div><span class="tag neutral">Administrator managed</span></div><dl class="client-profile-readonly-list">${readonlyValue('Address', companyAddress(company))}${readonlyValue('Company phone', company.phone)}${readonlyValue('Website', company.website)}</dl></section>`;
  }

  function renderProfile(inputProfile = {}, role = inputProfile.role || 'client_admin') {
    const profile = normalizeProfile(inputProfile.profile ? inputProfile : { profile: inputProfile, permissions: inputProfile.permissions }, {
      role,
      signInEmail: inputProfile.signInEmail
    });
    const companySection = profile.permissions.canEditCompany
      ? editableCompanyFields(profile.company)
      : readonlyCompanyContact(profile.company);
    return `<main class="page client-profile-page" data-client-profile-page><div class="page-heading"><div><p class="eyebrow">Client Portal</p><h1>Account Settings</h1><p class="client-profile-intro">Keep your contact details current and review the account information Soro uses throughout your Client Portal.</p></div></div><div class="client-profile-layout"><form class="panel client-profile-form" id="client-profile-form" novalidate><div class="panel-head"><div><p class="eyebrow">Personal information</p><h2>Profile details</h2></div><span class="client-profile-unsaved" data-client-profile-unsaved hidden>Unsaved changes</span></div>${contactFields(profile)}${profile.permissions.canEditCompany ? companySection : ''}<p class="client-profile-message" id="client-profile-message" aria-live="polite"></p><footer class="client-profile-actions"><button class="button primary" type="submit">Save changes</button></footer></form><aside class="client-profile-aside"><section class="panel client-profile-account" aria-labelledby="client-account-title"><div class="panel-head"><div><p class="eyebrow">Portal account</p><h2 id="client-account-title">Account details</h2></div></div><dl class="client-profile-readonly-list">${readonlyValue('Company', profile.company.name)}${readonlyValue('Industry', profile.company.industry)}${readonlyValue('Portal role', profile.portalRole)}${readonlyValue('Sign-in email', profile.signInEmail)}</dl><p class="client-profile-security-note"><strong>Sign-in email</strong> is managed separately from the contact details on this page. Use Forgot password on the sign-in screen if you need a secure reset link.</p></section>${profile.permissions.canEditCompany ? '' : companySection}</aside></div></main>`;
  }

  function renderLoading() {
    return `<main class="page client-profile-page" data-client-profile-page aria-busy="true"><div class="page-heading"><div><p class="eyebrow">Client Portal</p><h1>Account Settings</h1><p class="client-profile-intro">Loading your secure account details…</p></div></div><section class="panel client-profile-loading" aria-live="polite"><span></span><span></span><span></span><p>Loading your account settings…</p></section></main>`;
  }

  function renderError(message) {
    return `<main class="page client-profile-page" data-client-profile-page><div class="page-heading"><div><p class="eyebrow">Client Portal</p><h1>Account Settings</h1></div></div><section class="panel client-profile-error" role="alert"><h2>Account settings unavailable</h2><p>${escapeHtml(message || 'Your account settings could not be loaded. Please try again.')}</p><button class="button" type="button" data-client-profile-retry>Try again</button></section></main>`;
  }

  async function request(method, payload) {
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
        method,
        headers: { Authorization: `Bearer ${session.access_token}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
        body: payload ? JSON.stringify(payload) : undefined,
        signal: controller?.signal
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('The secure request took too long. Please try again.');
      throw new Error('Soro could not reach the secure profile service. Check your connection and try again.');
    } finally {
      if (timeout) window.clearTimeout(timeout);
      if (activeController === controller) activeController = null;
    }
    const responseText = await response.text();
    let result = {};
    if (responseText) {
      try { result = JSON.parse(responseText); }
      catch { throw new Error(`The secure profile service returned an unexpected response (${response.status}).`); }
    }
    if (!response.ok) {
      const error = new Error(result.message || 'Your profile could not be updated.');
      error.code = result.code || '';
      error.status = response.status;
      throw error;
    }
    return { result, session };
  }

  function pageIsCurrent(root, key) {
    return Boolean(
      root?.isConnected
      && root.querySelector('[data-client-profile-page]')
      && canOpenProfile()
      && accountKey() === key
      && (typeof current === 'undefined' || current === 'my-profile')
    );
  }

  function updateShellIdentity(profile) {
    const name = profile.contact.fullName;
    if (!name) return;
    const parts = name.split(/\s+/).filter(Boolean);
    const initials = `${parts[0]?.[0] || ''}${parts.length > 1 ? parts[parts.length - 1][0] : ''}`.toUpperCase();
    document.querySelector('#role-switcher strong')?.replaceChildren(document.createTextNode(name));
    document.querySelector('#role-switcher .avatar')?.replaceChildren(document.createTextNode(initials || 'CP'));
    document.querySelector('#client-mobile-profile .avatar')?.replaceChildren(document.createTextNode(initials || 'CP'));
  }

  function fieldValue(form, name) {
    return text(form.elements[name]?.value);
  }

  function changedPayload(form, profile) {
    const contact = {};
    const fullName = fieldValue(form, 'contactFullName');
    const phone = fieldValue(form, 'contactPhone');
    if (fullName !== profile.contact.fullName) contact.fullName = fullName;
    if (phone !== profile.contact.phone) contact.phone = phone;
    const payload = Object.keys(contact).length ? { contact } : {};
    if (profile.permissions.canEditCompany) {
      const company = {};
      COMPANY_FIELDS.forEach(([apiName, formName]) => {
        const value = fieldValue(form, formName);
        if (value !== profile.company[apiName]) company[apiName] = value;
      });
      if (Object.keys(company).length) payload.company = company;
    }
    return payload;
  }

  function setFormBusy(form, busy) {
    form.setAttribute('aria-busy', String(Boolean(busy)));
    form.querySelectorAll('input, button').forEach(control => { control.disabled = Boolean(busy); });
    const submit = form.querySelector('[type="submit"]');
    if (submit) submit.textContent = busy ? 'Saving…' : 'Save changes';
  }

  function setMessage(form, message, type = '') {
    const target = form.querySelector('#client-profile-message');
    if (!target) return;
    target.textContent = message;
    target.className = `client-profile-message${type ? ` client-profile-message--${type}` : ''}`;
  }

  function bindProfile(root, profile, key) {
    const form = root.querySelector('#client-profile-form');
    if (!form) return;
    const unsaved = form.querySelector('[data-client-profile-unsaved]');
    form.addEventListener('input', () => {
      if (unsaved) unsaved.hidden = Object.keys(changedPayload(form, profile)).length === 0;
      setMessage(form, '');
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!canOpenProfile() || accountKey() !== key) return;
      if (!form.reportValidity()) return;
      const payload = changedPayload(form, profile);
      if (!Object.keys(payload).length) {
        setMessage(form, 'Your profile is already up to date.', 'success');
        return;
      }
      setFormBusy(form, true);
      setMessage(form, 'Saving your changes…', 'working');
      const version = ++requestVersion;
      try {
        const { result, session } = await request('PATCH', payload);
        if (version !== requestVersion || !pageIsCurrent(root, key)) return;
        const updated = normalizeProfile(result, { role: currentRole(), signInEmail: session.user.email });
        cachedProfile = updated;
        profile = updated;
        updateShellIdentity(updated);
        root.innerHTML = renderProfile(updated, updated.role);
        bindProfile(root, updated, key);
        setMessage(root.querySelector('#client-profile-form'), 'Profile changes saved.', 'success');
      } catch (error) {
        if (version !== requestVersion || !pageIsCurrent(root, key)) return;
        setFormBusy(form, false);
        setMessage(form, error.message || 'Your profile could not be updated.', 'error');
      }
    });
  }

  async function load(root, key) {
    const version = ++requestVersion;
    try {
      const { result, session } = await request('GET');
      if (version !== requestVersion || !pageIsCurrent(root, key)) return;
      const profile = normalizeProfile(result, { role: currentRole(), signInEmail: session.user.email });
      cachedProfile = profile;
      cachedAccountKey = key;
      root.innerHTML = renderProfile(profile, profile.role);
      updateShellIdentity(profile);
      bindProfile(root, profile, key);
    } catch (error) {
      if (version !== requestVersion || !pageIsCurrent(root, key)) return;
      root.innerHTML = renderError(error.message);
      root.querySelector('[data-client-profile-retry]')?.addEventListener('click', () => {
        root.innerHTML = renderLoading();
        load(root, key);
      });
    }
  }

  function mount(root) {
    if (!root || !canOpenProfile()) {
      reset();
      root?.replaceChildren();
      return;
    }
    const key = accountKey();
    if (!text(currentAccess()?.user_id) || !key.startsWith(`${text(currentAccess()?.user_id)}:`)) {
      root.innerHTML = renderError('Your secure client profile is not available.');
      return;
    }
    if (cachedAccountKey && cachedAccountKey !== key) reset();
    if (cachedProfile && cachedAccountKey === key) {
      root.innerHTML = renderProfile(cachedProfile, cachedProfile.role);
      bindProfile(root, cachedProfile, key);
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

  window.SoroClientProfile = Object.freeze({ canOpenProfile, mount, normalizeProfile, renderLoading, renderProfile, reset });
  window.SORO_CLIENT_PROFILE_PREVIEW = Object.freeze({ renderProfile });
})();
