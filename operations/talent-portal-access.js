/* Secure VA Portal access controls for authorized Talent managers. */
(() => {
  'use strict';

  const ENDPOINT = '/.netlify/functions/talent-portal-access';
  const CARD_ID = 'talent-portal-access-card';
  const DIALOG_ID = 'talent-portal-access-dialog';
  const MANAGER_ROLES = new Set(['admin', 'talent_management']);
  const STATE_ALIASES = Object.freeze({
    not_invited: 'not_activated',
    invite_pending: 'invitation_pending',
    suspended: 'paused'
  });
  const STATE_DETAILS = Object.freeze({
    not_activated: {
      label: 'Not activated', className: 'talent-portal-status--inactive',
      description: 'No VA Portal sign-in has been created for this Talent.',
      cardAction: 'Activate VA Portal', primaryAction: 'activate', primaryLabel: 'Activate & send invitation'
    },
    invitation_pending: {
      label: 'Invitation pending', className: 'talent-portal-status--pending',
      description: 'A secure invitation was sent. Portal access begins after the Talent completes setup.',
      cardAction: 'Manage access', primaryAction: 'resend_invitation', primaryLabel: 'Resend invitation'
    },
    invitation_expired: {
      label: 'Invitation expired', className: 'talent-portal-status--pending',
      description: 'The previous invitation expired before account setup was completed.',
      cardAction: 'Manage access', primaryAction: 'resend_invitation', primaryLabel: 'Send new invitation'
    },
    active: {
      label: 'Active', className: 'talent-portal-status--active',
      description: 'This Talent has active access to the secure VA Portal.',
      cardAction: 'Manage access', primaryAction: 'send_password_reset', primaryLabel: 'Send password reset'
    },
    paused: {
      label: 'Access paused', className: 'talent-portal-status--paused',
      description: 'This account exists, but its VA Portal access is currently paused.',
      cardAction: 'Manage access', primaryAction: 'reactivate_access', primaryLabel: 'Reactivate VA Portal'
    },
    needs_attention: {
      label: 'Needs attention', className: 'talent-portal-status--attention',
      description: 'The portal account needs review before access can be confirmed.',
      cardAction: 'Review access', primaryAction: 'status', primaryLabel: 'Refresh status'
    },
    delivery_failed: {
      label: 'Email delivery failed', className: 'talent-portal-status--attention',
      description: 'The account update succeeded, but the secure email was not delivered.',
      cardAction: 'Review access', primaryAction: 'resend_invitation', primaryLabel: 'Resend secure email'
    },
    unavailable: {
      label: 'Status unavailable', className: 'talent-portal-status--attention',
      description: 'The current portal status could not be loaded.',
      cardAction: 'Try again', primaryAction: 'status', primaryLabel: 'Try again'
    },
    loading: {
      label: 'Checking access…', className: 'talent-portal-status--loading',
      description: 'Confirming this Talent’s secure portal access.', cardAction: '', primaryAction: '', primaryLabel: ''
    }
  });

  const accessCache = new Map();
  const deliveryNotices = new Map();
  const statusRequests = new Map();
  let requestSequence = 0;
  let attachScheduled = false;
  let lastDialogTrigger = null;

  function escapeHtml(value = '') {
    return String(value).replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function managerRole() {
    return String(window.soroCurrentAccess?.role || '').trim().toLowerCase();
  }

  function canManageTalentAccess() {
    return MANAGER_ROLES.has(managerRole());
  }

  function currentApplicant() {
    if (typeof current === 'undefined' || current !== 'talent-profile') return null;
    if (typeof selectedTalentId === 'undefined' || !selectedTalentId) return null;
    if (typeof liveApplicants === 'undefined' || !Array.isArray(liveApplicants)) return null;
    return liveApplicants.find(applicant => String(applicant.id) === String(selectedTalentId)) || null;
  }

  function validEmail(value) {
    const email = String(value || '').trim();
    return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function stateName(value, fallback = 'needs_attention') {
    const raw = String(value || '').trim().toLowerCase();
    const normalized = STATE_ALIASES[raw] || raw;
    return STATE_DETAILS[normalized] ? normalized : fallback;
  }

  function firstObject(...values) {
    return values.find(value => value && typeof value === 'object' && !Array.isArray(value)) || {};
  }

  function normalizeAccess(result, applicant, fallbackState) {
    const source = firstObject(result?.access, result?.portalAccess, result?.data?.access, result?.data, result);
    const rawState = source.state || source.status || result?.state || result?.status;
    const inferredState = fallbackState || (applicant?.auth_user_id ? 'needs_attention' : 'not_activated');
    return {
      applicantId: String(source.applicantId || source.applicant_id || applicant?.id || ''),
      authUserId: String(source.authUserId || source.auth_user_id || applicant?.auth_user_id || ''),
      state: stateName(rawState, inferredState),
      signInEmail: String(source.loginEmail || source.login_email || source.signInEmail || source.sign_in_email || '').trim(),
      inviteSentAt: source.inviteSentAt || source.invite_sent_at || source.invitationSentAt || source.invitation_sent_at || null,
      invitationExpiresAt: source.invitationExpiresAt || source.invitation_expires_at || source.expiresAt || source.expires_at || null,
      activatedAt: source.activatedAt || source.activated_at || source.passwordChangedAt || source.password_changed_at || null,
      passwordResetSentAt: source.passwordResetSentAt || source.password_reset_sent_at || null,
      availableActions: Array.isArray(source.availableActions || source.available_actions)
        ? (source.availableActions || source.available_actions).map(String)
        : [],
      actionsProvided: Array.isArray(source.availableActions || source.available_actions),
      detail: String(source.detail || source.statusDetail || source.status_detail || result?.detail || '').trim()
    };
  }

  function stateDetails(access) {
    return STATE_DETAILS[access?.state] || STATE_DETAILS.needs_attention;
  }

  function formatDateTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return date.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
  }

  async function request(action, applicantId, values = {}) {
    if (!window.soroSupabase) throw new Error('Soro sign-in is still loading. Refresh and try again.');
    const { data: { session }, error: sessionError } = await window.soroSupabase.auth.getSession();
    if (sessionError || !session?.access_token) throw new Error('Your secure session expired. Sign in again and retry.');

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = controller ? window.setTimeout(() => controller.abort(), 25000) : null;
    let response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, applicantId, ...values }),
        signal: controller?.signal
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('The secure request took too long. Please try again.');
      throw new Error('Soro could not reach the secure access service. Check your connection and try again.');
    } finally {
      if (timeout) window.clearTimeout(timeout);
    }

    const responseText = await response.text();
    let result = {};
    if (responseText) {
      try { result = JSON.parse(responseText); }
      catch { throw new Error(`The secure access service returned an unexpected response (${response.status}).`); }
    }
    if (!response.ok) {
      const error = new Error(result.message || result.error || 'VA Portal access could not be updated.');
      error.code = result.code || '';
      error.status = response.status;
      throw error;
    }
    return result;
  }

  function cardForApplicant(applicantId) {
    const card = document.getElementById(CARD_ID);
    return card && String(card.dataset.applicantId) === String(applicantId) ? card : null;
  }

  function renderNotice(applicantId) {
    const notice = deliveryNotices.get(String(applicantId));
    if (!notice) return '';
    return `<p class="talent-portal-notice talent-portal-notice--${escapeHtml(notice.type || 'success')}" role="status">${escapeHtml(notice.text)}</p>`;
  }

  function renderCard(applicant, access) {
    const card = cardForApplicant(applicant.id);
    if (!card || String(currentApplicant()?.id || '') !== String(applicant.id)) return;
    const details = stateDetails(access);
    const signInEmail = access.signInEmail || (access.state === 'not_activated' ? 'Not created' : 'Not available');
    const missingContact = access.state === 'not_activated' && !validEmail(applicant.email);
    const primaryAllowed = details.primaryAction === 'status'
      || !access.actionsProvided
      || access.availableActions.includes(details.primaryAction);
    const actionLabel = missingContact
      ? 'Add email to profile first'
      : (primaryAllowed ? details.cardAction : 'Restore profile to manage');
    const action = details.cardAction
      ? `<button class="admin-record-button${access.state === 'not_activated' ? ' admin-record-button--primary' : ''}" type="button" data-manage-talent-portal ${missingContact || !primaryAllowed ? 'disabled' : ''}>${escapeHtml(actionLabel)}</button>`
      : '<span class="talent-portal-loading-dot" aria-hidden="true"></span>';
    const detail = access.detail || details.description;

    card.className = 'panel profile-section talent-portal-access-card';
    card.setAttribute('aria-labelledby', 'talent-portal-access-title');
    card.innerHTML = `<div class="talent-portal-card-heading"><div><p class="eyebrow">Account access</p><h2 id="talent-portal-access-title">VA Portal</h2></div><span class="talent-portal-status ${escapeHtml(details.className)}">${escapeHtml(details.label)}</span></div><p class="talent-portal-description">${escapeHtml(detail)}</p><dl class="talent-portal-email-summary"><div><dt>Sign-in email</dt><dd>${escapeHtml(signInEmail)}</dd></div><div><dt>Application contact</dt><dd>${escapeHtml(applicant.email || 'Not recorded')}</dd></div></dl>${renderNotice(applicant.id)}<div class="talent-portal-card-actions">${action}</div>`;
    card.querySelector('[data-manage-talent-portal]')?.addEventListener('click', event => openAccessDialog(applicant, event.currentTarget));
  }

  function renderLoadingCard(applicant, card) {
    card.dataset.applicantId = applicant.id;
    card.className = 'panel profile-section talent-portal-access-card talent-portal-access-card--loading';
    card.innerHTML = `<div class="talent-portal-card-heading"><div><p class="eyebrow">Account access</p><h2 id="talent-portal-access-title">VA Portal</h2></div><span class="talent-portal-status talent-portal-status--loading">Checking access…</span></div><p class="talent-portal-description">Confirming this Talent’s secure portal access.</p><div class="talent-portal-card-skeleton" aria-hidden="true"><span></span><span></span></div>`;
  }

  function visibleApplicantMatches(applicantId) {
    const applicant = currentApplicant();
    return Boolean(applicant && String(applicant.id) === String(applicantId) && canManageTalentAccess());
  }

  async function loadStatus(applicant, { force = false, preserveOnError = false } = {}) {
    if (!applicant || !canManageTalentAccess()) return null;
    const key = String(applicant.id);
    const cached = accessCache.get(key);
    if (!force && cached?.access && Date.now() - cached.fetchedAt < 30000) {
      renderCard(applicant, cached.access);
      return cached.access;
    }
    const token = ++requestSequence;
    statusRequests.set(key, token);
    try {
      const result = await request('status', applicant.id);
      if (statusRequests.get(key) !== token) return null;
      const access = normalizeAccess(result, applicant);
      accessCache.set(key, { access, fetchedAt: Date.now() });
      if (visibleApplicantMatches(applicant.id)) renderCard(applicant, access);
      return access;
    } catch (error) {
      if (statusRequests.get(key) !== token) return null;
      if (preserveOnError) return null;
      const fallback = {
        applicantId: key, authUserId: String(applicant.auth_user_id || ''), state: 'unavailable', signInEmail: '',
        detail: error.message || 'The current portal status could not be loaded.'
      };
      accessCache.set(key, { access: fallback, fetchedAt: Date.now(), error: true });
      if (visibleApplicantMatches(applicant.id)) renderCard(applicant, fallback);
      return fallback;
    }
  }

  function ensureCard() {
    if (!canManageTalentAccess()) {
      document.getElementById(CARD_ID)?.remove();
      document.getElementById(DIALOG_ID)?.close();
      return;
    }
    const applicant = currentApplicant();
    const detailsPanel = document.querySelector('.talent-profile-page .profile-summary-column .profile-details-section');
    if (!applicant || !detailsPanel) {
      document.getElementById(CARD_ID)?.remove();
      return;
    }

    let card = cardForApplicant(applicant.id);
    let created = false;
    if (!card) {
      document.getElementById(CARD_ID)?.remove();
      card = document.createElement('section');
      card.id = CARD_ID;
      renderLoadingCard(applicant, card);
      detailsPanel.insertAdjacentElement('afterend', card);
      created = true;
    }
    const cached = accessCache.get(String(applicant.id));
    if (cached?.access) {
      if (created) renderCard(applicant, cached.access);
      return;
    }
    loadStatus(applicant);
  }

  function scheduleEnsureCard() {
    if (attachScheduled) return;
    attachScheduled = true;
    requestAnimationFrame(() => {
      attachScheduled = false;
      ensureCard();
    });
  }

  function statusRows(applicant, access) {
    const sent = formatDateTime(access.inviteSentAt);
    const expires = formatDateTime(access.invitationExpiresAt);
    const activated = formatDateTime(access.activatedAt);
    return `<dl class="talent-portal-dialog-summary"><div><dt>Application contact email</dt><dd>${escapeHtml(applicant.email || 'Not recorded')}</dd></div><div><dt>VA Portal sign-in email</dt><dd>${escapeHtml(access.signInEmail || 'Not created')}</dd></div>${sent ? `<div><dt>Invitation sent</dt><dd>${escapeHtml(sent)}</dd></div>` : ''}${expires ? `<div><dt>Invitation expires</dt><dd>${escapeHtml(expires)}</dd></div>` : ''}${activated ? `<div><dt>Access activated</dt><dd>${escapeHtml(activated)}</dd></div>` : ''}</dl>`;
  }

  function linkedAccess(access) {
    return Boolean(access.authUserId || access.signInEmail || !['not_activated', 'unavailable'].includes(access.state));
  }

  function createDialog(applicant, access, trigger) {
    document.getElementById(DIALOG_ID)?.remove();
    const details = stateDetails(access);
    const activation = access.state === 'not_activated';
    const unavailable = access.state === 'unavailable';
    const canChangeEmail = linkedAccess(access)
      && (!access.actionsProvided || access.availableActions.includes('change_email'));
    const initialEmail = access.signInEmail || applicant.email || '';
    const dialog = document.createElement('dialog');
    dialog.id = DIALOG_ID;
    dialog.className = 'record-manager-dialog talent-portal-access-dialog';
    dialog.setAttribute('aria-labelledby', 'talent-portal-dialog-title');
    dialog.innerHTML = `<section class="record-manager-shell"><header class="record-manager-header"><div><p class="record-manager-eyebrow">Secure Talent account</p><h2 id="talent-portal-dialog-title">${activation ? 'Activate VA Portal' : 'Manage VA Portal access'}</h2></div><button class="record-manager-close" type="button" data-close-talent-portal aria-label="Close">×</button></header><div class="talent-portal-dialog-content"><div class="talent-portal-dialog-state"><span class="talent-portal-status ${escapeHtml(details.className)}">${escapeHtml(details.label)}</span><p>${escapeHtml(access.detail || details.description)}</p></div>${statusRows(applicant, access)}<p class="talent-portal-email-note"><strong>Sign-in and application emails are managed separately.</strong> Changing the VA Portal sign-in email will not change the contact email saved on this application.</p>${activation ? `<form data-portal-activation-form><label class="talent-portal-email-field">VA Portal sign-in email<input name="email" type="email" autocomplete="email" maxlength="254" required value="${escapeHtml(initialEmail)}"><small>A one-use secure setup link will be sent to this address.</small></label><p class="talent-portal-dialog-message" aria-live="polite"></p><footer class="record-manager-footer"><button class="admin-record-button" type="button" data-close-talent-portal>Cancel</button><button class="admin-record-button admin-record-button--primary" type="submit">${escapeHtml(details.primaryLabel)}</button></footer></form>` : `<div class="talent-portal-state-actions" data-portal-state-actions><p class="talent-portal-dialog-message" aria-live="polite"></p><footer class="record-manager-footer"><button class="admin-record-button talent-portal-change-email" type="button" data-show-email-change ${canChangeEmail ? '' : 'hidden'}>Change sign-in email</button><button class="admin-record-button" type="button" data-close-talent-portal>Close</button><button class="admin-record-button admin-record-button--primary" type="button" data-portal-primary="${escapeHtml(details.primaryAction)}">${escapeHtml(details.primaryLabel)}</button></footer></div><form class="talent-portal-change-email-form" data-portal-change-email-form hidden><label class="talent-portal-email-field">New VA Portal sign-in email<input name="email" type="email" autocomplete="email" maxlength="254" required value="${escapeHtml(initialEmail)}"><small>The current sign-in email will stop working. Soro will send the appropriate secure setup or recovery link to the new address.</small></label><p class="talent-portal-dialog-message" aria-live="polite"></p><footer class="record-manager-footer"><button class="admin-record-button" type="button" data-cancel-email-change>Back</button><button class="admin-record-button admin-record-button--primary" type="submit">Change email &amp; send secure link</button></footer></form>`}</div></section>`;
    document.body.append(dialog);
    lastDialogTrigger = trigger || document.activeElement;

    const close = () => {
      if (dialog.dataset.busy === 'true') return;
      dialog.close('cancel');
    };
    dialog.querySelectorAll('[data-close-talent-portal]').forEach(button => button.addEventListener('click', close));
    dialog.addEventListener('cancel', event => {
      if (dialog.dataset.busy === 'true') event.preventDefault();
    });
    dialog.addEventListener('click', event => {
      if (event.target === dialog && dialog.dataset.busy !== 'true') dialog.close('cancel');
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (lastDialogTrigger?.isConnected) lastDialogTrigger.focus();
      lastDialogTrigger = null;
    });

    dialog.querySelector('[data-portal-activation-form]')?.addEventListener('submit', event => {
      event.preventDefault();
      const email = event.currentTarget.elements.email.value.trim();
      performAction(dialog, applicant, access, 'activate', { email }, event.currentTarget.querySelector('[type="submit"]'));
    });
    dialog.querySelector('[data-portal-primary]')?.addEventListener('click', event => {
      const action = event.currentTarget.dataset.portalPrimary;
      if (action === 'status') refreshDialogStatus(dialog, applicant, event.currentTarget);
      else performAction(dialog, applicant, access, action, {}, event.currentTarget);
    });
    const stateActions = dialog.querySelector('[data-portal-state-actions]');
    const emailForm = dialog.querySelector('[data-portal-change-email-form]');
    dialog.querySelector('[data-show-email-change]')?.addEventListener('click', () => {
      stateActions.hidden = true;
      emailForm.hidden = false;
      emailForm.elements.email.focus();
      emailForm.elements.email.select();
    });
    dialog.querySelector('[data-cancel-email-change]')?.addEventListener('click', () => {
      emailForm.hidden = true;
      stateActions.hidden = false;
      dialog.querySelector('[data-show-email-change]')?.focus();
    });
    emailForm?.addEventListener('submit', event => {
      event.preventDefault();
      const email = event.currentTarget.elements.email.value.trim();
      performAction(dialog, applicant, access, 'change_email', { email }, event.currentTarget.querySelector('[type="submit"]'));
    });

    if (unavailable) dialog.querySelector('[data-show-email-change]')?.setAttribute('hidden', '');
    dialog.showModal();
    requestAnimationFrame(() => {
      (activation ? dialog.querySelector('input[name="email"]') : dialog.querySelector('[data-portal-primary]'))?.focus();
    });
    return dialog;
  }

  function openAccessDialog(applicant, trigger) {
    if (!canManageTalentAccess() || String(currentApplicant()?.id || '') !== String(applicant.id)) return;
    const access = accessCache.get(String(applicant.id))?.access || normalizeAccess({}, applicant);
    createDialog(applicant, access, trigger);
  }

  function setDialogBusy(dialog, busy, button, label) {
    dialog.dataset.busy = String(Boolean(busy));
    dialog.setAttribute('aria-busy', String(Boolean(busy)));
    dialog.querySelectorAll('button, input').forEach(control => { control.disabled = Boolean(busy); });
    if (!button) return;
    if (busy) {
      button.dataset.originalLabel = button.textContent;
      button.textContent = label;
    } else {
      button.textContent = button.dataset.originalLabel || button.textContent;
      delete button.dataset.originalLabel;
    }
  }

  function dialogMessage(dialog, text, type = 'error') {
    const visible = [...dialog.querySelectorAll('.talent-portal-dialog-message')].find(element => !element.closest('[hidden]'))
      || dialog.querySelector('.talent-portal-dialog-message');
    if (!visible) return;
    visible.textContent = text;
    visible.className = `talent-portal-dialog-message talent-portal-dialog-message--${type}`;
  }

  function pendingLabel(action) {
    return {
      activate: 'Sending invitation…', resend_invitation: 'Sending invitation…', change_email: 'Changing email…',
      send_password_reset: 'Sending reset…', reactivate_access: 'Reactivating…', status: 'Refreshing…'
    }[action] || 'Saving…';
  }

  function fallbackStateForAction(action, access) {
    if (action === 'activate' || action === 'resend_invitation') return 'invitation_pending';
    if (action === 'change_email') return access.state === 'active' ? 'active' : 'invitation_pending';
    if (action === 'send_password_reset') return 'active';
    if (action === 'reactivate_access') return 'active';
    return access.state;
  }

  function deliveryMessage(action, email) {
    const address = email ? ` to ${email}` : '';
    return {
      activate: `Secure VA Portal invitation sent${address}.`,
      resend_invitation: `New VA Portal invitation sent${address}.`,
      change_email: `Sign-in email changed and a secure access link was sent${address}.`,
      send_password_reset: `Secure password reset email sent${address}.`,
      reactivate_access: 'VA Portal access was reactivated.'
    }[action] || 'VA Portal access was updated.';
  }

  async function refreshDialogStatus(dialog, applicant, button) {
    setDialogBusy(dialog, true, button, pendingLabel('status'));
    try {
      const access = await loadStatus(applicant, { force: true });
      if (!access || !visibleApplicantMatches(applicant.id)) return dialog.close('stale');
      dialog.dataset.busy = 'false';
      dialog.close('refreshed');
      createDialog(applicant, access, cardForApplicant(applicant.id)?.querySelector('[data-manage-talent-portal]'));
    } catch (error) {
      setDialogBusy(dialog, false, button);
      dialogMessage(dialog, error.message || 'The access status could not be refreshed.');
    }
  }

  async function performAction(dialog, applicant, previousAccess, action, values, button) {
    if (!canManageTalentAccess() || !visibleApplicantMatches(applicant.id)) return;
    if ((action === 'activate' || action === 'change_email') && !validEmail(values.email)) {
      dialogMessage(dialog, 'Enter a valid sign-in email address.');
      dialog.querySelector('input[name="email"]:not([disabled])')?.focus();
      return;
    }
    setDialogBusy(dialog, true, button, pendingLabel(action));
    dialogMessage(dialog, 'Sending the secure request…', 'working');
    try {
      const result = await request(action, applicant.id, values);
      const fallbackState = fallbackStateForAction(action, previousAccess);
      const returnedAccess = normalizeAccess(result, applicant, fallbackState);
      const key = String(applicant.id);
      accessCache.set(key, { access: returnedAccess, fetchedAt: Date.now() });
      let latestAccess = returnedAccess;
      try { latestAccess = await loadStatus(applicant, { force: true, preserveOnError: true }) || returnedAccess; }
      catch { /* Keep the successful mutation response if the follow-up check is unavailable. */ }
      const deliveryFailed = result.emailDelivered === false || result.email_delivered === false;
      const deliveredTo = latestAccess.signInEmail || returnedAccess.signInEmail || values.email || previousAccess.signInEmail;
      deliveryNotices.set(key, deliveryFailed
        ? { type: 'error', text: result.message || 'The account was updated, but the secure email could not be delivered. Verify the sign-in address and try again.' }
        : { type: 'success', text: result.message || deliveryMessage(action, deliveredTo) });
      if (visibleApplicantMatches(applicant.id)) renderCard(applicant, latestAccess);
      dialog.dataset.busy = 'false';
      dialog.close(deliveryFailed ? 'delivery-failed' : 'updated');
    } catch (error) {
      if (error.code === 'email_delivery_failed') {
        const key = String(applicant.id);
        const refreshed = await loadStatus(applicant, { force: true, preserveOnError: true });
        const latestAccess = refreshed || accessCache.get(key)?.access || previousAccess;
        deliveryNotices.set(key, {
          type: 'error',
          text: error.message || 'The account was updated, but the secure email could not be delivered. Verify the sign-in address and try again.'
        });
        if (visibleApplicantMatches(applicant.id)) renderCard(applicant, latestAccess);
        dialog.dataset.busy = 'false';
        dialog.close('delivery-failed');
        return;
      }
      setDialogBusy(dialog, false, button);
      const retry = error.status === 429 && !/wait/i.test(error.message || '') ? ' Please wait before trying again.' : '';
      dialogMessage(dialog, `${error.message || 'VA Portal access could not be updated.'}${retry}`);
    }
  }

  const observer = new MutationObserver(scheduleEnsureCard);
  function start() {
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('soro-auth-changed', event => {
      if (!MANAGER_ROLES.has(String(event.detail?.access?.role || '').toLowerCase())) {
        accessCache.clear();
        deliveryNotices.clear();
      }
      scheduleEnsureCard();
    });
    window.addEventListener('popstate', scheduleEnsureCard);
    scheduleEnsureCard();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
