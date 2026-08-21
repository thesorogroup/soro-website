-- Server-side permanent deletion is available only through the Netlify
-- administrative function after it verifies an active Administrator account.
-- Browser users retain the existing RLS policies and cannot bypass the check.

grant select, delete on table public.applicants to service_role;
grant select, delete on table public.clients to service_role;
grant select on table public.placements to service_role;
grant select on table public.documents to service_role;
grant select on table public.platform_users to service_role;
grant insert on table public.audit_events to service_role;
