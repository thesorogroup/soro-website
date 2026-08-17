-- RLS decides which rows a signed-in user can access; these grants allow the
-- Data API to evaluate those policies. No anonymous-table grants are made.

grant usage on schema public to authenticated;
grant select, insert, update, delete on table public.organizations to authenticated;
grant select, insert, update, delete on table public.platform_users to authenticated;
grant select, insert, update, delete on table public.applicants to authenticated;
grant select, insert, update, delete on table public.clients to authenticated;
grant select, insert, update, delete on table public.client_contacts to authenticated;
grant select, insert, update, delete on table public.hiring_requests to authenticated;
grant select, insert, update, delete on table public.placements to authenticated;
grant select, insert, update, delete on table public.documents to authenticated;
grant select, insert, update, delete on table public.audit_events to authenticated;
