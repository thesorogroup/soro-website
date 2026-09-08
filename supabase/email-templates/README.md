# Soro automatic email release

All application-owned messages use `netlify/functions/lib/branded-email.js`, the
existing approved shortlist email visual language. Recipient-provided strings are
escaped. Names use an explicitly provided preferred/given name, or the current
profile's `Family, Given` / `Given Family` name. Never use a legacy import name or
derive a name from an email address. The fallback is `Hello,`.

## Release order

1. Apply migration `20260908_054_email_recipient_greeting.sql` (read-only recipient
   lookup; no record edits or email triggers). Deploy the matching Netlify code.
2. Supabase Auth is a separate sender for the portal's **Forgot password** action.
   Generate `managementPatch()` from `netlify/functions/lib/auth-email-templates.js`.
   Back up existing email subjects/content only, then apply those fields through
   the Supabase Auth email settings or Management API. Do not change SMTP,
   recipients, redirect configuration, security notification enabled flags, or
   generate a test recovery link as part of applying templates.
3. Verify all 13 subjects/content fields, especially recovery's original
   `{{ .ConfirmationURL }}` and reauthentication's `{{ .Token }}`. Native Auth uses
   `Hello,` because current profile names are not consistently synchronized into
   Auth metadata. This avoids greeting someone with an outdated or family name.
4. Request approval before sending new test emails. Inspect delivered desktop and
   mobile emails; source tests do not prove inbox rendering or delivery.

Official Auth configuration reference:
https://supabase.com/docs/guides/auth/auth-email-templates

## Boundaries

- Existing prepared confirmation and Client invitation payloads remain byte-for-byte
  unchanged on retry. Do not rewrite or replay sent/queued messages for restyling.
- Interview creation uses the shared brand. Microsoft owns the invitation envelope,
  response buttons, cancellation text and Teams join block. Existing meeting bodies
  are not rewritten during rescheduling; this preserves the Teams information.
- Employee initial credentials are copied manually by an Admin; there is no automatic
  employee welcome sender. Do not introduce password delivery by email here.
- Netlify Forms and historical Power Automate campaigns are separate integrations.
  No active autoresponder configuration is represented in this checkout. Inspect
  their actual settings before claiming those emails have been restyled.
- No delivery, SMTP, sender address, role permission, or account setup flow changes.
