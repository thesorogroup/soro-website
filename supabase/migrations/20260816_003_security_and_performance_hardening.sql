-- Soro Operations: close executable helper-function API surfaces and add
-- indexes for the relationship fields used by the first-release queues.

revoke execute on function public.current_soro_role() from anon, authenticated, public;
revoke execute on function public.is_soro_admin() from anon, authenticated, public;
revoke execute on function public.is_internal_soro_user() from anon, authenticated, public;

-- This event-trigger helper is created for automatic RLS enforcement. It is
-- not an application RPC and must not be callable through the public API.
revoke execute on function public.rls_auto_enable() from anon, authenticated, public;

create index if not exists applicants_talent_review_owner_idx
  on public.applicants (talent_review_owner_id);
create index if not exists applicants_sales_owner_idx
  on public.applicants (sales_owner_id);
create index if not exists applicants_talent_support_owner_idx
  on public.applicants (talent_support_owner_id);
create index if not exists clients_sales_owner_idx
  on public.clients (sales_owner_id);
create index if not exists client_contacts_client_idx
  on public.client_contacts (client_id);
create index if not exists hiring_requests_client_idx
  on public.hiring_requests (client_id);
create index if not exists placements_client_idx
  on public.placements (client_id);
create index if not exists placements_applicant_idx
  on public.placements (applicant_id);
create index if not exists placements_hiring_request_idx
  on public.placements (hiring_request_id);
create index if not exists documents_org_idx
  on public.documents (organization_id);
create index if not exists documents_applicant_idx
  on public.documents (applicant_id);
create index if not exists documents_client_idx
  on public.documents (client_id);
create index if not exists documents_placement_idx
  on public.documents (placement_id);
create index if not exists documents_assigned_user_idx
  on public.documents (assigned_to_user_id);
create index if not exists audit_events_org_idx
  on public.audit_events (organization_id);
create index if not exists audit_events_actor_user_idx
  on public.audit_events (actor_user_id);
