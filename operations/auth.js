(() => {
  const config = window.SORO_SUPABASE_CONFIG;
  const checking = document.getElementById('auth-checking');
  const authGate = document.getElementById('auth-gate');
  const app = document.getElementById('app');
  const form = document.getElementById('sign-in-form');
  const message = document.getElementById('auth-message');
  const reset = document.getElementById('reset-password');
  if (!config || !window.supabase || !checking || !authGate || !app) return;
  const client = window.supabase.createClient(config.url, config.publishableKey);
  window.soroSupabase = client;
  const authorizedRoles = new Set(['admin', 'sales_management', 'sales', 'talent_management', 'billing', 'client_admin', 'client_reviewer', 'client_billing', 'virtual_assistant']);
  const workspaceRole = {
    admin: 'admin', sales_management: 'sales', sales: 'sales', talent_management: 'talent', billing: 'admin',
    client_admin: 'client', client_reviewer: 'client', client_billing: 'client', virtual_assistant: 'va'
  };
  let authCheck = 0;
  let signedOutMessage = '';

  function showChecking() {
    checking.hidden = false;
    authGate.hidden = true;
    app.hidden = true;
  }

  function showSignedOut(message = '') {
    checking.hidden = true;
    authGate.hidden = false;
    app.hidden = true;
    if (message) setMessage(message, 'error');
  }

  function showAuthorizedApp(session, access) {
    window.soroCurrentAccess = { ...access, user_id: session.user.id };
    if (typeof role !== 'undefined') role = workspaceRole[access.role] || 'admin';
    if (typeof setActive === 'function') setActive();
    if (typeof render === 'function') render();
    checking.hidden = true;
    authGate.hidden = true;
    app.hidden = false;
    window.dispatchEvent(new CustomEvent('soro-auth-changed', { detail: { session, access } }));
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
      .select('organization_id,role,display_name,active')
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
  document.getElementById('sign-out')?.addEventListener('click', async () => {
    showChecking();
    signedOutMessage = 'You have been signed out.';
    await client.auth.signOut();
  });
  client.auth.onAuthStateChange((_event, session) => setTimeout(() => verifySession(session), 0));
  client.auth.getSession().then(({ data: { session } }) => verifySession(session));
})();
