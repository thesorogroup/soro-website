(() => {
  const config = window.SORO_SUPABASE_CONFIG;
  const authGate = document.getElementById('auth-gate');
  const app = document.getElementById('app');
  const form = document.getElementById('sign-in-form');
  const message = document.getElementById('auth-message');
  const reset = document.getElementById('reset-password');
  if (!config || !window.supabase || !authGate || !app) return;
  const client = window.supabase.createClient(config.url, config.publishableKey);
  window.soroSupabase = client;
  function showApp(session) {
    const signedIn = Boolean(session);
    authGate.hidden = signedIn;
    app.hidden = !signedIn;
    window.dispatchEvent(new CustomEvent('soro-auth-changed', { detail: { session } }));
  }
  function setMessage(text, type = '') { message.textContent = text; message.className = `auth-message ${type}`.trim(); }
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    setMessage('Signing you in…');
    const { error } = await client.auth.signInWithPassword({ email: form.elements.email.value.trim(), password: form.elements.password.value });
    if (error) setMessage('We could not sign you in. Check your email and password, or use Forgot password.', 'error');
  });
  reset?.addEventListener('click', async () => {
    const email = form?.elements.email.value.trim();
    if (!email) return setMessage('Enter your Soro email first, then choose Forgot password.', 'error');
    setMessage('Sending a secure reset link…');
    const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/operations/` });
    setMessage(error ? 'We could not send the reset link. Try again or contact Soro support.' : 'If that email has a Soro account, a secure reset link is on its way.', error ? 'error' : 'success');
  });
  document.getElementById('sign-out')?.addEventListener('click', async () => {
    await client.auth.signOut();
    setMessage('You have been signed out.');
  });
  client.auth.onAuthStateChange((_event, session) => showApp(session));
  client.auth.getSession().then(({ data: { session } }) => showApp(session));
})();
