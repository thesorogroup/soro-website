# Soro private-file import bridge

This Netlify Function copies legacy Google Drive application files into the private Supabase Storage bucket and adds a document record to the matching Talent profile.

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

Loom recordings need their own archive connection because Loom is separate from Google Drive.
