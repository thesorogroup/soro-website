-- Shared Soro Ops technical-support queue. Tickets belong to the signed-in
-- user and their organization; only internal Soro staff can triage all tickets.

create or replace function private.current_soro_organization_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select organization_id
  from public.platform_users
  where id = auth.uid() and active = true
  limit 1;
$$;

grant execute on function private.current_soro_organization_id() to authenticated;

create table public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null default private.current_soro_organization_id() references public.organizations(id) on delete cascade,
  requester_user_id uuid not null default auth.uid() references public.platform_users(id) on delete restrict,
  ticket_number text not null unique default ('SUP-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))),
  subject text not null check (char_length(subject) between 3 and 120),
  area text not null,
  details text not null check (char_length(details) between 5 and 5000),
  status text not null default 'open' check (status in ('open', 'in_progress', 'resolved', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index support_tickets_organization_status_idx
  on public.support_tickets (organization_id, status, created_at desc);
create index support_tickets_requester_idx
  on public.support_tickets (requester_user_id, created_at desc);

create trigger support_tickets_updated_at
  before update on public.support_tickets
  for each row execute function public.set_updated_at();

alter table public.support_tickets enable row level security;
grant select, insert, update on table public.support_tickets to authenticated;

create policy "users can create their own support tickets"
on public.support_tickets for insert to authenticated
with check (
  requester_user_id = auth.uid()
  and organization_id = private.current_soro_organization_id()
);

create policy "users can read their own support tickets"
on public.support_tickets for select to authenticated
using (requester_user_id = auth.uid());

create policy "Soro internal users can manage support tickets"
on public.support_tickets for all to authenticated
using (private.is_internal_soro_user())
with check (private.is_internal_soro_user());
