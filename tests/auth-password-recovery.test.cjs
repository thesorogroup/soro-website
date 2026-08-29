const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

function read(relativePath) {
  const absolutePath = path.join(root, relativePath);
  assert.equal(fs.existsSync(absolutePath), true, `${relativePath} must exist.`);
  return fs.readFileSync(absolutePath, 'utf8');
}

function namedFunction(source, name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`, 'm').exec(source);
  assert.ok(declaration, `${name}() must be a named function.`);
  const braceStart = source.indexOf('{', declaration.index);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(declaration.index, index + 1);
  }
  throw new Error(`${name}() could not be parsed.`);
}

test('the operations sign-in page has a dedicated accessible password-recovery gate', () => {
  const html = read('operations/index.html');

  assert.match(html, /id=["']password-recovery-gate["'][^>]*aria-labelledby=["']password-recovery-title["'][^>]*hidden/i);
  assert.match(html, /id=["']password-recovery-form["']/i);
  assert.match(html, /name=["']newPassword["'][^>]*autocomplete=["']new-password["'][^>]*minlength=["']12["']/i);
  assert.match(html, /name=["']confirmPassword["'][^>]*autocomplete=["']new-password["'][^>]*minlength=["']12["']/i);
  assert.match(html, /id=["']password-recovery-sign-out["']/i);
  assert.match(html, /id=["']password-recovery-message["'][^>]*aria-live=["']polite["']/i);
  assert.match(html, /Your portal will remain locked until this change is complete/i);
});

test('recovery completion validates the new password and updates it through Supabase Auth', () => {
  const auth = read('operations/auth.js');

  assert.match(auth, /resetPasswordForEmail\(email,\s*\{\s*redirectTo:\s*`\$\{window\.location\.origin\}\/operations\/`\s*\}\)/);
  assert.match(auth, /event\s*===\s*['"]PASSWORD_RECOVERY['"]/);
  assert.match(auth, /newPassword\.length\s*<\s*12/);
  assert.match(auth, /newPassword\s*!==\s*confirmPassword/);
  assert.match(auth, /client\.auth\.updateUser\(\{\s*password:\s*newPassword\s*\}\)/);
  assert.match(auth, /client\.auth\.refreshSession\(\)/);
  assert.match(auth, /clearRecoveryUrl\(\)/);
});

test('recovery loads authenticated access and routes VA passwords through the audited setup endpoint', () => {
  const auth = read('operations/auth.js');
  const accessLookup = namedFunction(auth, 'loadPasswordRecoveryAccess');

  assert.match(accessLookup, /\.from\(['"]platform_users['"]\)/);
  assert.match(accessLookup, /\.eq\(['"]id['"],\s*session\.user\.id\)/);
  assert.match(accessLookup, /!access\?\.active\s*\|\|\s*!authorizedRoles\.has\(access\.role\)/);
  assert.match(auth, /recoveryAccess\.role\s*===\s*['"]virtual_assistant['"]/);
  assert.match(auth, /fetch\(['"]\/\.netlify\/functions\/talent-account-setup['"]/);
  assert.match(auth, /Authorization:\s*`Bearer \$\{recoverySession\.access_token\}`/);
  assert.match(auth, /recoveryAccess\.must_change_password\s*\?\s*['"]complete_setup['"]\s*:\s*['"]complete_recovery['"]/);
  assert.match(auth, /JSON\.stringify\(\{\s*action,\s*newPassword\s*\}\)/);
  assert.match(auth, /else\s*\{\s*const \{ error \} = await client\.auth\.updateUser\(\{\s*password:\s*newPassword\s*\}\)/);
});

test('recovery mode hides every normal workspace surface until password update succeeds', () => {
  const auth = read('operations/auth.js');
  const recoveryView = namedFunction(auth, 'showPasswordRecovery');
  const verify = namedFunction(auth, 'verifySession');
  const stateChange = namedFunction(auth, 'handleAuthStateChange');

  assert.match(recoveryView, /checking\.hidden\s*=\s*true/);
  assert.match(recoveryView, /authGate\.hidden\s*=\s*true/);
  assert.match(recoveryView, /firstPasswordGate\)\s*firstPasswordGate\.hidden\s*=\s*true/);
  assert.match(recoveryView, /app\.hidden\s*=\s*true/);
  assert.match(recoveryView, /passwordRecoveryGate\.hidden\s*=\s*false/);

  const verifyRecoveryGuard = verify.indexOf('if (recoveryMode)');
  const verifyAccessLookup = verify.indexOf(".from('platform_users')");
  assert.notEqual(verifyRecoveryGuard, -1);
  assert.notEqual(verifyAccessLookup, -1);
  assert.ok(verifyRecoveryGuard < verifyAccessLookup, 'Recovery must be checked before normal role access.');

  const stateRecoveryGuard = stateChange.indexOf('if (recoveryMode)');
  const normalVerification = stateChange.lastIndexOf('verifySession(session)');
  assert.notEqual(stateRecoveryGuard, -1);
  assert.notEqual(normalVerification, -1);
  assert.ok(stateRecoveryGuard < normalVerification, 'USER_UPDATED and refresh events must remain behind the recovery gate.');
  assert.match(stateChange, /PASSWORD_RECOVERY can be followed by USER_UPDATED/);
  assert.match(stateChange, /event\s*===\s*['"]PASSWORD_RECOVERY['"][\s\S]*?loadPasswordRecoveryAccess\(session\)/);
  assert.match(stateChange, /recoverySession\?\.user\?\.id\s*&&\s*recoveryAccess/);
});

test('recovery supports sign-out and invalid or expired links fail closed', () => {
  const auth = read('operations/auth.js');

  assert.match(auth, /passwordRecoverySignOut\?\.addEventListener\(['"]click['"][\s\S]*?recoveryMode\s*=\s*false[\s\S]*?client\.auth\.signOut\(\)/);
  assert.match(auth, /recoveryRequestedByUrl\(\)/);
  assert.match(auth, /This password reset link is invalid or has expired/i);
  assert.match(auth, /if\s*\(!recoveryMode\s*\|\|\s*!recoveryEventReceived\s*\|\|\s*!recoverySession\?\.user\?\.id\s*\|\|\s*!recoveryAccess\)/);
});

test('the temporary-password gate remains distinct and its expired guidance is role-aware', () => {
  const html = read('operations/index.html');
  const auth = read('operations/auth.js');

  assert.match(html, /id=["']first-password-gate["']/i);
  assert.match(auth, /action:\s*['"]change_initial_password['"]/);
  assert.match(auth, /access\.role\s*===\s*['"]virtual_assistant['"]/);
  assert.match(auth, /Soro Administrator or Talent Management team member to send a new invitation/i);
  assert.match(auth, /Ask a Soro Administrator to generate new ones/i);
});

test('password recovery has deliberate focus and busy-state presentation', () => {
  const css = read('operations/auth.css');
  const auth = read('operations/auth.js');

  assert.match(css, /\.password-recovery-gate\s+\.auth-card/);
  assert.match(css, /\.password-recovery-gate\s+\.auth-submit:disabled/);
  assert.match(auth, /passwordRecoveryForm\.elements\.newPassword\?\.focus\(\)/);
  assert.match(auth, /submit\.disabled\s*=\s*true/);
});
