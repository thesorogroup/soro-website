'use strict';
const {renderEmail, PORTAL} = require('./branded-email');
// Hosted Supabase Auth templates are configured separately from Netlify.
// Generate content/subjects only: never enable new notifications or change SMTP.
// Current names are not reliably present in auth metadata (client profile edits
// do not synchronize it). Use a neutral greeting here rather than stale names.
const definitions = [
  ['confirmation', 'Confirm your Soro email address', 'Confirm your email address.', 'Confirm this email address to continue setting up your Soro account.', 'Confirm email address'],
  ['invite', 'Your Soro portal invitation', 'Welcome to your Soro portal.', 'You have been invited to Soro. Use the secure button below to continue your account setup.', 'Accept invitation'],
  ['magic_link', 'Your secure Soro sign-in link', 'Your sign-in link is ready.', 'Use the secure button below to sign in to your Soro account.', 'Sign in securely'],
  ['recovery', 'Reset your Soro password', 'Let’s get you signed in again.', 'We received a request to reset your password. Use the secure button below to choose a new private password.', 'Reset password'],
  ['email_change', 'Confirm your Soro email change', 'Confirm your email change.', 'Use the secure button below to confirm the requested change to your Soro sign-in email address.', 'Confirm email change'],
  ['reauthentication', 'Your Soro verification code', 'Verify it’s you.', 'Enter the verification code below to continue your account action. Do not share this code.', null],
  ['password_changed_notification', 'Your Soro password was changed', 'Your password was changed.', 'The password for your Soro account was recently changed.'],
  ['email_changed_notification', 'Your Soro sign-in email was changed', 'Your sign-in email was changed.', 'The email address used to sign in to your Soro account was recently changed.'],
  ['phone_changed_notification', 'Your Soro phone number was changed', 'Your phone number was changed.', 'The phone number associated with your Soro account was recently changed.'],
  ['identity_linked_notification', 'A sign-in method was added to Soro', 'A sign-in method was added.', 'A new sign-in method was linked to your Soro account.'],
  ['identity_unlinked_notification', 'A sign-in method was removed from Soro', 'A sign-in method was removed.', 'A sign-in method was removed from your Soro account.'],
  ['mfa_factor_enrolled_notification', 'A Soro verification method was added', 'A verification method was added.', 'A new sign-in verification method was added to your Soro account.'],
  ['mfa_factor_unenrolled_notification', 'A Soro verification method was removed', 'A verification method was removed.', 'A sign-in verification method was removed from your Soro account.']
];
function templates() {
  return Object.fromEntries(definitions.map(([key, subject, title, message, label]) => {
    const notification = key.endsWith('_notification');
    const token = key === 'reauthentication';
    const email = renderEmail({subject, title, person: {}, eyebrow: notification ? 'ACCOUNT SECURITY UPDATE' : 'SECURE SORO ACCOUNT', paragraphs: [message],
      reference: token ? 'SORO_AUTH_TOKEN_PLACEHOLDER' : '',
      action: token ? undefined : {label: label || 'Open Soro Ops', url: notification ? PORTAL : 'https://soro-email-link.invalid/confirmation'},
      note: notification ? 'If you did not make this change, reset your password and contact Soro immediately.' : 'If you were not expecting this email, contact Soro Group. Do not forward this secure one-use link or verification code.'});
    return [key, {...email,
      html: email.html.replaceAll('https://soro-email-link.invalid/confirmation', '{{ .ConfirmationURL }}').replaceAll('SORO_AUTH_TOKEN_PLACEHOLDER', '{{ .Token }}'),
      text: email.text.replaceAll('https://soro-email-link.invalid/confirmation', '{{ .ConfirmationURL }}').replaceAll('SORO_AUTH_TOKEN_PLACEHOLDER', '{{ .Token }}')
    }];
  }));
}
function managementPatch() {
  return Object.fromEntries(Object.entries(templates()).flatMap(([key, email]) => [[`mailer_subjects_${key}`, email.subject], [`mailer_templates_${key}_content`, email.html]]));
}
module.exports = {templates, managementPatch};
