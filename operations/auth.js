(() => {
  const config = window.SORO_SUPABASE_CONFIG;
  const checking = document.getElementById('auth-checking');
  const authGate = document.getElementById('auth-gate');
  const app = document.getElementById('app');
  const form = document.getElementById('sign-in-form');
  const message = document.getElementById('auth-message');
  const reset = document.getElementById('reset-password');
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
  const temporaryPasswordTtlMs = 72 * 60 * 60 * 1000;
  let authCheck = 0;
  let signedOutMessage = '';

  function showChecking() {
    checking.hidden = false;
    authGate.hidden = true;
    if (firstPasswordGate) firstPasswordGate.hidden = true;
    app.hidden = true;
  }

  function showSignedOut(message = '') {
    checking.hidden = true;
    authGate.hidden = false;
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
    const name = String(access.display_name || session.user.user_metadata?.display_name || session.user.email || 'Soro employee').trim();
    profile?.querySelector('strong')?.replaceChildren(document.createTextNode(name));
    profile?.querySelector('.avatar')?.replaceChildren(document.createTextNode(shellInitials(name)));
    const roleLabel = document.getElementById('role-label');
    if (roleLabel) roleLabel.textContent = accessRoleLabel[access.role] || 'Soro employee';
    if (profile) {
      const previewAvailable = access.role === 'admin';
      profile.disabled = !previewAvailable;
      profile.classList.toggle('profile--fixed-identity', !previewAvailable);
      profile.setAttribute('aria-label', previewAvailable ? 'Preview a Soro workspace' : 'Signed-in employee');
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
    if (firstPasswordGate) firstPasswordGate.hidden = true;
    app.hidden = false;
    window.dispatchEvent(new CustomEvent('soro-auth-changed', { detail: { session, access } }));
  }

  function showRequiredPasswordChange(session, access) {
    window.soroCurrentAccess = { ...access, user_id: session.user.id };
    checking.hidden = true;
    authGate.hidden = true;
    app.hidden = true;
    if (firstPasswordGate) firstPasswordGate.hidden = false;
    firstPasswordForm?.reset();
    const issuedAt = Date.parse(access.initial_password_issued_at || '');
    const expired = !Number.isFinite(issuedAt) || Date.now() - issuedAt > temporaryPasswordTtlMs;
    firstPasswordForm?.querySelectorAll('input, button[type="submit"]').forEach(control => { control.disabled = expired; });
    if (firstPasswordMessage) {
      firstPasswordMessage.textContent = expired ? 'These temporary sign-in details have expired. Ask a Soro Administrator to generate new ones.' : '';
      firstPasswordMessage.className = expired ? 'auth-message error' : 'auth-message';
    }
    if (expired) firstPasswordSignOut?.focus();
    else firstPasswordForm?.elements.currentPassword?.focus();
  }

  async function verifySession(session) {
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
  document.getElementById('sign-out')?.addEventListener('click', async () => {
    showChecking();
    signedOutMessage = 'You have been signed out.';
    await client.auth.signOut();
  });
  client.auth.onAuthStateChange((_event, session) => setTimeout(() => verifySession(session), 0));
  client.auth.getSession().then(({ data: { session } }) => verifySession(session));
})();
