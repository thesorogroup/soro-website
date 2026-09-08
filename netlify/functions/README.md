# Soro private-file import bridge

This Netlify Function copies legacy Google Drive application files and publicly shared Loom introduction videos into the private Supabase Storage bucket, then adds a document record to the matching Talent profile.

Set these **server-only** Netlify environment variables before deploying:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` (recommended)

The service-account value is the Base64-encoded contents of the Google Cloud JSON key file. Create a Soro-owned service account, enable Google Drive API for its Cloud project, and share the source folder or files with the service-account email as a Viewer. This is preferred because the importer is owned by Soro, not an individual employee.

The importer can alternatively use the following three OAuth variables when a service account is impractical:

- `GOOGLE_DRIVE_CLIENT_ID`
- `GOOGLE_DRIVE_CLIENT_SECRET`
- `GOOGLE_DRIVE_REFRESH_TOKEN`

Do not put any of these values in `operations/supabase-config.js`, browser JavaScript, or a public repository. The browser sends only the signed-in Admin session to `/.netlify/functions/import-google-drive`; the function checks the Soro role before it runs.

Loom recording archival needs no additional account connection: the importer uses each applicant's existing public Loom link. Files above Supabase Storage's 50 MB per-file limit are reported for manual handling instead of being exposed as public links.

## Portal confirmation emails

`portal-confirmations` processes the private receipt outbox once per minute.
After verifying the Resend sending domain and reviewing queued messages, set
`SORO_RECEIPTS=1` in the production deploy context only and redeploy. It reuses
the existing `RESEND_API_KEY`; no invitation sender settings change. Other
values or an absent flag leave it disabled. The sender is fixed to
`Soro Group <do-not-reply@thesorogroup.com>` in code and the database.

Remove the superseded `PORTAL_CONFIRMATIONS_ENABLED` and
`PORTAL_CONFIRMATION_FROM_EMAIL` variables when upgrading; they are no longer
read. One compact flag avoids duplicating the sender in Lambda's size-limited
environment. To pause sending, remove the production `SORO_RECEIPTS` value and
redeploy; preserve the outbox and all provider idempotency snapshots.
