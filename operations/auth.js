(() => {
  const config = window.SORO_SUPABASE_CONFIG;
  const checking = document.getElementById('auth-checking');
  const authGate = document.getElementById('auth-gate');
  const app = document.getElementById('app');
  const form = document.getElementById('sign-in-form');
  const message = document.getElementById('auth-message');
  const reset = document.getElementById('reset-password');
  const passwordRecoveryGate = document.getElementById('password-recovery-gate');
  const passwordRecoveryForm = document.getElementById('password-recovery-form');
  const passwordRecoveryMessage = document.getElementById('password-recovery-message');
  const passwordRecoverySignOut = document.getElementById('password-recovery-sign-out');
  const firstPasswordGate = document.getElementById('first-password-gate');
  const firstPasswordForm = document.getElementById('first-password-form');
  const firstPasswordMessage = document.getElementById('first-password-message');
  const firstPasswordSignOut = document.getElementById('first-password-sign-out');
  if (!config || !window.supabase || !checking || !authGate || !app) return;
  const client = window.supabase.createClient(config.url, config.publishableKey);
  window.soroSupabase = client;
  const authorizedRoles = new Set(['admin', 'sales_management', 'sales', 'talent_management', 'billing', 'client_admin', 'client_reviewer', 'client_billing', 'virtual_assistant']);
  const workspaceRole = {
    admin: 'admin', sales_management: 'sales', sales: 'sales', talent_management: 'talent', billing: 'admin',
    client_admin: 'client', client_reviewer: 'client', client_billing: 'client', virtual_assistant: 'va'
  };
  const accessRoleLabel = {
    admin: 'Administrator', sales_management: 'Sales Management', sales: 'Sales Associate', talent_management: 'Talent Management', billing: 'Billing',
    client_admin: 'Client Administrator', client_reviewer: 'Client Reviewer', client_billing: 'Client Billing', virtual_assistant: 'Talent'
  };
  const clientProfileRoles = new Set(['client_admin', 'client_reviewer', 'client_billing']);
  const temporaryPasswordTtlMs = 72 * 60 * 60 * 1000;
  let authCheck = 0;
  let signedOutMessage = '';
  let recoveryMode = recoveryRequestedByUrl();
  let recoverySession = null;
  let recoveryAccess = null;
  let recoveryEventReceived = false;
  let recoveryAccessCheck = 0;

  function recoveryRequestedByUrl() {
    const query = new URLSearchParams(window.location.search);
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    return query.get('type') === 'recovery' || fragment.get('type') === 'recovery';
  }

  function clearRecoveryUrl() {
    const url = new URL(window.location.href);
    ['code', 'type', 'token', 'token_hash'].forEach(parameter => url.searchParams.delete(parameter));
    url.hash = '';
    window.history.replaceState({}, document.title, `${url.pathname}${url.search}`);
  }

  function showChecking() {
    checking.hidden = false;
    authGate.hidden = true;
    if (passwordRecoveryGate) passwordRecoveryGate.hidden = true;
    if (firstPasswordGate) firstPasswordGate.hidden = true;
    app.hidden = true;
  }

  function showSignedOut(message = '') {
    checking.hidden = true;
    authGate.hidden = false;
    if (passwordRecoveryGate) passwordRecoveryGate.hidden = true;
    if (firstPasswordGate) firstPasswordGate.hidden = true;
    app.hidden = true;
    if (message) setMessage(message, 'error');
  }

  function shellInitials(value) {
    const names = String(value || '').trim().split(/\s+/).filter(Boolean);
    return `${names[0]?.[0] || ''}${names.length > 1 ? names[names.length - 1][0] : ''}`.toUpperCase() || 'SO';
  }

  function updateSignedInIdentity(session, access) {
    const profile = document.getElementById('role-switcher');
    const mobileProfile = document.getElementById('client-mobile-profile');
    const name = String(access.display_name || session.user.user_metadata?.display_name || session.user.email || 'Soro employee').trim();
    profile?.querySelector('strong')?.replaceChildren(document.createTextNode(name));
    const initials = shellInitials(name);
    profile?.querySelector('.avatar')?.replaceChildren(document.createTextNode(initials));
    mobileProfile?.querySelector('.avatar')?.replaceChildren(document.createTextNode(initials));
    const roleLabel = document.getElementById('role-label');
    const clientProfileAvailable = clientProfileRoles.has(access.role);
    const previewAvailable = access.role === 'admin';
    if (roleLabel) roleLabel.textContent = clientProfileAvailable
      ? `${accessRoleLabel[access.role]} · Account Settings`
      : (accessRoleLabel[access.role] || 'Soro employee');
    if (profile) {
      profile.disabled = !(previewAvailable || clientProfileAvailable);
      profile.classList.toggle('profile--fixed-identity', !(previewAvailable || clientProfileAvailable));
      profile.dataset.accountAction = clientProfileAvailable ? 'my-profile' : (previewAvailable ? 'workspace-preview' : 'identity');
      profile.setAttribute('aria-label', clientProfileAvailable ? 'Open Account Settings' : (previewAvailable ? 'Preview a Soro workspace' : 'Signed-in employee'));
      const affordance = profile.querySelector('i');
      if (affordance) affordance.textContent = clientProfileAvailable ? '›' : (previewAvailable ? '⌄' : '');
    }
    if (mobileProfile) {
      mobileProfile.hidden = !clientProfileAvailable;
      mobileProfile.setAttribute('aria-label', clientProfileAvailable ? `Open Account Settings for ${name}` : 'Open Account Settings');
    }
    const globalSearch = document.getElementById('global-search');
    if (globalSearch) {
      globalSearch.placeholder = 'Search clients, Talent, tasks…';
      const searchShell = globalSearch.closest('.global-search');
      if (searchShell) searchShell.hidden = clientProfileAvailable;
    }
  }

  function showAuthorizedApp(session, access) {
    window.soroCurrentAccess = { ...access, user_id: session.user.id };
    if (typeof role !== 'undefined') role = workspaceRole[access.role] || 'admin';
    updateSignedInIdentity(session, access);
    if (typeof window.soroSyncAuthorizedNavigation === 'function') window.soroSyncAuthorizedNavigation(access);
    if (typeof setActive === 'function') setActive();
    if (typeof render === 'function') render();
    checking.hidden = true;
    authGate.hidden = true;
    if (passwordRecoveryGate) passwordRecoveryGate.hidden = true;
    if (firstPasswordGate) firstPasswordGate.hidden = true;
    app.hidden = false;
    window.dispatchEvent(new CustomEvent('soro-auth-changed', { detail: { session, access } }));
  }

  function showRequiredPasswordChange(session, access) {
    window.soroCurrentAccess = { ...access, user_id: session.user.id };
    checking.hidden = true;
    authGate.hidden = true;
    if (passwordRecoveryGate) passwordRecoveryGate.hidden = true;
    app.hidden = true;
    if (firstPasswordGate) firstPasswordGate.hidden = false;
    firstPasswordForm?.reset();
    const issuedAt = Date.parse(access.initial_password_issued_at || '');
    const expired = !Number.isFinite(issuedAt) || Date.now() - issuedAt > temporaryPasswordTtlMs;
    firstPasswordForm?.querySelectorAll('input, button[type="submit"]').forEach(control => { control.disabled = expired; });
    if (firstPasswordMessage) {
      const help = access.role === 'virtual_assistant'
        ? 'Ask a Soro Administrator or Talent Management team member to send a new invitation.'
        : 'Ask a Soro Administrator to generate new ones.';
      firstPasswordMessage.textContent = expired ? `These temporary sign-in details have expired. ${help}` : '';
      firstPasswordMessage.className = expired ? 'auth-message error' : 'auth-message';
    }
    if (expired) firstPasswordSignOut?.focus();
    else firstPasswordForm?.elements.currentPassword?.focus();
  }

  function showPasswordRecovery(session) {
    recoverySession = session || recoverySession;
    window.soroCurrentAccess = null;
    checking.hidden = true;
    authGate.hidden = true;
    if (firstPasswordGate) firstPasswordGate.hidden = true;
    app.hidden = true;
    if (!passwordRecoveryGate || !passwordRecoveryForm) return;
    const opening = passwordRecoveryGate.hidden;
    passwordRecoveryGate.hidden = false;
    if (opening) {
      passwordRecoveryForm.reset();
      if (passwordRecoveryMessage) {
        passwordRecoveryMessage.textContent = '';
        passwordRecoveryMessage.className = 'auth-message';
      }
      passwordRecoveryForm.elements.newPassword?.focus();
    }
  }

  async function loadPasswordRecoveryAccess(session) {
    const check = ++recoveryAccessCheck;
    recoverySession = session;
    recoveryAccess = null;
    showChecking();
    if (!session?.user?.id) return;
    const { data: access, error } = await client
      .from('platform_users')
      .select('organization_id,role,display_name,active,must_change_password,initial_password_issued_at,password_changed_at')
      .eq('id', session.user.id)
      .maybeSingle();
    if (check !== recoveryAccessCheck || !recoveryMode) return;
    if (error || !access?.active || !authorizedRoles.has(access.role)) {
      recoverySession = null;
      recoveryAccess = null;
      recoveryMode = false;
      clearRecoveryUrl();
      signedOutMessage = 'This account does not have access to Soro Ops. Contact a Soro Administrator if you believe this is an error.';
      await client.auth.signOut({ scope: 'local' }).catch(() => {});
      showSignedOut(signedOutMessage);
      return;
    }
    recoveryAccess = access;
    showPasswordRecovery(session);
  }

  async function verifySession(session) {
    if (recoveryMode) {
      if (recoveryEventReceived && recoverySession?.user?.id && recoveryAccess) showPasswordRecovery(recoverySession);
      else showChecking();
      return;
    }
    const check = ++authCheck;
    if (!session?.user?.id) {
      window.soroCurrentAccess = null;
      showSignedOut(signedOutMessage);
      signedOutMessage = '';
      window.dispatchEvent(new CustomEvent('soro-auth-changed', { detail: { session: null, access: null } }));
      return;
    }

    showChecking();
    const { data: access, error } = await client
      .from('platform_users')
      .select('organization_id,role,display_name,active,must_change_password,initial_password_issued_at,password_changed_at')
      .eq('id', session.user.id)
      .maybeSingle();
    if (check !== authCheck) return;

    if (error || !access?.active || !authorizedRoles.has(access.role)) {
      signedOutMessage = 'This account does not have access to Soro Ops. Contact a Soro Administrator if you believe this is an error.';
      window.soroCurrentAccess = null;
      await client.auth.signOut({ scope: 'local' }).catch(() => {});
      if (check === authCheck) showSignedOut(signedOutMessage);
      return;
    }

    if (access.must_change_password) {
      showRequiredPasswordChange(session, access);
      return;
    }

    showAuthorizedApp(session, access);
  }
  function setMessage(text, type = '') { message.textContent = text; message.className = `auth-message ${type}`.trim(); }
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    setMessage('Signing you in…');
    const { data, error } = await client.auth.signInWithPassword({ email: form.elements.email.value.trim(), password: form.elements.password.value });
    if (error) setMessage('We could not sign you in. Check your email and password, or use Forgot password.', 'error');
    else await verifySession(data.session);
  });
  reset?.addEventListener('click', async () => {
    const email = form?.elements.email.value.trim();
    if (!email) return setMessage('Enter your Soro email first, then choose Forgot password.', 'error');
    setMessage('Sending a secure reset link…');
    const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/operations/` });
    setMessage(error ? 'We could not send the reset link. Try again or contact Soro support.' : 'If that email has a Soro account, a secure reset link is on its way.', error ? 'error' : 'success');
  });
  passwordRecoveryForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const newPassword = passwordRecoveryForm.elements.newPassword.value;
    const confirmPassword = passwordRecoveryForm.elements.confirmPassword.value;
    const submit = passwordRecoveryForm.querySelector('[type="submit"]');
    const setRecoveryMessage = (text, type = '') => {
      passwordRecoveryMessage.textContent = text;
      passwordRecoveryMessage.className = `auth-message ${type}`.trim();
    };
    if (!recoveryMode || !recoveryEventReceived || !recoverySession?.user?.id || !recoveryAccess) {
      return setRecoveryMessage('This password reset session is no longer valid. Request a new reset link.', 'error');
    }
    if (newPassword.length < 12) return setRecoveryMessage('Use at least 12 characters for your new password.', 'error');
    if (newPassword !== confirmPassword) return setRecoveryMessage('The new passwords do not match.', 'error');
    submit.disabled = true;
    submit.textContent = 'Saving your password…';
    setRecoveryMessage('Securing your account…');
    try {
      if (recoveryAccess.role === 'virtual_assistant') {
        const action = recoveryAccess.must_change_password ? 'complete_setup' : 'complete_recovery';
        const response = await fetch('/.netlify/functions/talent-account-setup', {
          method: 'POST',
          headers: { Authorization: `Bearer ${recoverySession.access_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, newPassword })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.message || 'Your password could not be changed.');
      } else {
        const { error } = await client.auth.updateUser({ password: newPassword });
        if (error) throw error;
      }
      passwordRecoveryForm.reset();
      setRecoveryMessage('Password saved. Opening your secure portal…', 'success');
      recoveryMode = false;
      recoveryEventReceived = false;
      recoverySession = null;
      recoveryAccess = null;
      clearRecoveryUrl();
      const { data: refreshed } = await client.auth.refreshSession();
      const session = refreshed.session || (await client.auth.getSession()).data.session;
      await verifySession(session);
    } catch (error) {
      setRecoveryMessage(error.message || 'Your password could not be changed. Request a new reset link and try again.', 'error');
    } finally {
      submit.disabled = false;
      submit.textContent = 'Save new password';
    }
  });
  firstPasswordForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const currentPassword = firstPasswordForm.elements.currentPassword.value;
    const newPassword = firstPasswordForm.elements.newPassword.value;
    const confirmPassword = firstPasswordForm.elements.confirmPassword.value;
    const submit = firstPasswordForm.querySelector('[type="submit"]');
    const setFirstMessage = (text, type = '') => {
      firstPasswordMessage.textContent = text;
      firstPasswordMessage.className = `auth-message ${type}`.trim();
    };
    if (newPassword.length < 12) return setFirstMessage('Use at least 12 characters for your new password.', 'error');
    if (newPassword !== confirmPassword) return setFirstMessage('The new passwords do not match.', 'error');
    if (newPassword === currentPassword) return setFirstMessage('Choose a password that is different from the temporary password.', 'error');
    submit.disabled = true;
    submit.textContent = 'Saving your password…';
    setFirstMessage('Securing your account…');
    try {
      const { data: { session } } = await client.auth.getSession();
      if (!session?.access_token) throw new Error('Your secure session expired. Sign in again and retry.');
      const response = await fetch('/.netlify/functions/admin-employees', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'change_initial_password', currentPassword, newPassword })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || 'Your password could not be changed.');
      firstPasswordForm.reset();
      setFirstMessage('Password saved. Opening Soro Ops…', 'success');
      const { data: refreshed } = await client.auth.refreshSession();
      await verifySession(refreshed.session || session);
    } catch (error) {
      setFirstMessage(error.message || 'Your password could not be changed.', 'error');
    } finally {
      submit.disabled = false;
      submit.textContent = 'Save password & enter Soro Ops';
    }
  });
  firstPasswordSignOut?.addEventListener('click', async () => {
    showChecking();
    signedOutMessage = 'You have been signed out.';
    await client.auth.signOut();
  });
  passwordRecoverySignOut?.addEventListener('click', async () => {
    showChecking();
    signedOutMessage = 'You have been signed out.';
    recoveryMode = false;
    recoveryEventReceived = false;
    recoverySession = null;
    recoveryAccess = null;
    recoveryAccessCheck += 1;
    clearRecoveryUrl();
    await client.auth.signOut();
  });
  document.getElementById('sign-out')?.addEventListener('click', async () => {
    showChecking();
    signedOutMessage = 'You have been signed out.';
    await client.auth.signOut();
  });
  function handleAuthStateChange(event, session) {
    if (event === 'PASSWORD_RECOVERY') {
      recoveryMode = true;
      recoveryEventReceived = true;
      recoverySession = session;
      recoveryAccess = null;
      if (session?.user?.id) loadPasswordRecoveryAccess(session);
      else showChecking();
      return;
    }
    if (event === 'SIGNED_OUT') {
      recoveryEventReceived = false;
      recoverySession = null;
      recoveryAccess = null;
      recoveryAccessCheck += 1;
      if (recoveryMode) {
        recoveryMode = false;
        clearRecoveryUrl();
      }
      verifySession(null);
      return;
    }
    // PASSWORD_RECOVERY can be followed by USER_UPDATED or token refresh
    // events. None of them may reveal the workspace while recovery is active.
    if (recoveryMode) {
      if (recoveryEventReceived && session?.user?.id) recoverySession = session;
      if (recoveryEventReceived && recoverySession?.user?.id && recoveryAccess) showPasswordRecovery(recoverySession);
      else showChecking();
      return;
    }
    verifySession(session);
  }
  client.auth.onAuthStateChange((event, session) => setTimeout(() => handleAuthStateChange(event, session), 0));
  client.auth.getSession().then(({ data: { session } }) => handleAuthStateChange('INITIAL_SESSION', session));
  if (recoveryMode) {
    window.setTimeout(async () => {
      if (!recoveryMode || recoveryEventReceived) return;
      recoveryMode = false;
      recoverySession = null;
      recoveryAccess = null;
      recoveryAccessCheck += 1;
      clearRecoveryUrl();
      signedOutMessage = 'This password reset link is invalid or has expired. Request a new link and try again.';
      await client.auth.signOut({ scope: 'local' }).catch(() => {});
      verifySession(null);
    }, 10000);
  }
})();
