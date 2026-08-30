-- Soro Operations: separate Employee Payroll and Talent Payout preparation.
--
-- QuickBooks remains the accounting source of truth. Wise-contractor employee
-- payroll and Talent payout files are prepared for separate manual Wise uploads.
-- QuickBooks employees and employees whose route still needs setup are excluded.
-- Amounts are entered manually; Talent attendance and time-off records are
-- intentionally not consulted.
-- Direct browser access is denied. Server-side callers authenticate the user,
-- then invoke these service-role-only functions with that authenticated user id.

create type public.employee_payment_route as enum (
  'wise_contractor',
  'quickbooks_employee',
  'needs_setup'
);

alter table public.employee_profiles
  add column payment_route public.employee_payment_route not null default 'needs_setup',
  add column payout_recipient_email text,
  add constraint employee_profile_payout_route_consistent check (
    payout_recipient_email is null
    or payment_route = 'wise_contractor'::public.employee_payment_route
  ),
  add constraint employee_profile_payout_recipient_email_valid check (
    payout_recipient_email is null
    or (
      payout_recipient_email = lower(btrim(payout_recipient_email))
      and char_length(payout_recipient_email) <= 254
      and payout_recipient_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    )
  );

-- One-time initialization of the employee records that exist when this release
-- is applied. The column default remains needs_setup, so all future employees
-- fail closed until an Administrator deliberately chooses a payment route.
update public.employee_profiles as profile
set payment_route = case
  when regexp_replace(lower(btrim(profile.country)), '[^a-z]', '', 'g') in (
    'philippines', 'ph', 'phl'
  ) then 'wise_contractor'::public.employee_payment_route
  when regexp_replace(lower(btrim(profile.country)), '[^a-z]', '', 'g') in (
    'unitedstates', 'unitedstatesofamerica', 'us', 'usa'
  ) then 'quickbooks_employee'::public.employee_payment_route
  else 'needs_setup'::public.employee_payment_route
end;

create index if not exists employee_profiles_payment_route_idx
  on public.employee_profiles (organization_id, payment_route, hire_date, full_name);

create table if not exists public.employee_payroll_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  period_start date not null,
  period_end date not null,
  pay_date date not null,
  currency text not null default 'USD',
  status text not null default 'draft',
  total_amount numeric(14,2) not null default 0,
  item_count integer not null default 0,
  exception_count integer not null default 0,
  notes text,
  created_by_user_id uuid not null references public.platform_users(id) on delete restrict,
  approved_by_user_id uuid references public.platform_users(id) on delete set null,
  approved_at timestamptz,
  exported_by_user_id uuid references public.platform_users(id) on delete set null,
  exported_at timestamptz,
  export_file_name text,
  export_sha256 text,
  reconciled_by_user_id uuid references public.platform_users(id) on delete set null,
  reconciled_at timestamptz,
  external_reference text,
  cancelled_by_user_id uuid references public.platform_users(id) on delete set null,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employee_payroll_period_order check (period_end >= period_start),
  constraint employee_payroll_currency_valid check (currency ~ '^[A-Z]{3}$'),
  constraint employee_payroll_status_valid check (
    status in ('draft', 'ready', 'approved', 'exported', 'reconciled', 'cancelled')
  ),
  constraint employee_payroll_totals_valid check (
    total_amount >= 0 and item_count >= 0 and exception_count >= 0
  ),
  constraint employee_payroll_note_valid check (
    notes is null or (notes = btrim(notes) and char_length(notes) between 1 and 1000)
  ),
  constraint employee_payroll_export_hash_valid check (
    export_sha256 is null or export_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint employee_payroll_approval_complete check (
    (status in ('draft', 'ready', 'cancelled') and approved_by_user_id is null and approved_at is null)
    or (status in ('approved', 'exported', 'reconciled') and approved_by_user_id is not null and approved_at is not null)
  ),
  constraint employee_payroll_export_complete check (
    (status in ('draft', 'ready', 'approved', 'cancelled')
      and exported_by_user_id is null and exported_at is null
      and export_file_name is null and export_sha256 is null)
    or (status in ('exported', 'reconciled')
      and exported_by_user_id is not null and exported_at is not null
      and nullif(btrim(export_file_name), '') is not null and export_sha256 is not null)
  ),
  constraint employee_payroll_reconciliation_complete check (
    (status <> 'reconciled' and reconciled_by_user_id is null and reconciled_at is null)
    or (status = 'reconciled' and reconciled_by_user_id is not null and reconciled_at is not null
      and nullif(btrim(external_reference), '') is not null)
  ),
  constraint employee_payroll_cancellation_complete check (
    (status <> 'cancelled' and cancelled_by_user_id is null and cancelled_at is null)
    or (status = 'cancelled' and cancelled_by_user_id is not null and cancelled_at is not null)
  )
);

create unique index if not exists employee_payroll_one_open_period_idx
  on public.employee_payroll_runs (organization_id, period_start, period_end, pay_date)
  where status <> 'cancelled';

create index if not exists employee_payroll_runs_org_status_idx
  on public.employee_payroll_runs (organization_id, status, pay_date desc, created_at desc);

create table if not exists public.employee_payroll_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.employee_payroll_runs(id) on delete restrict,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  employee_user_id uuid not null references public.employee_profiles(user_id) on delete restrict,
  employee_name_snapshot text not null,
  employee_email_snapshot text not null,
  employee_role_snapshot text not null,
  hire_date_snapshot date not null,
  payment_route_snapshot public.employee_payment_route not null,
  payout_recipient_email_snapshot text,
  payment_reference text not null,
  included boolean not null default true,
  amount numeric(14,2),
  note text,
  exception_status text not null default 'needs_review',
  exception_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, employee_user_id),
  unique (run_id, payment_reference),
  constraint employee_payroll_item_route_valid check (
    payment_route_snapshot = 'wise_contractor'::public.employee_payment_route
  ),
  constraint employee_payroll_item_recipient_email_valid check (
    payout_recipient_email_snapshot is null
    or (
      payout_recipient_email_snapshot = lower(btrim(payout_recipient_email_snapshot))
      and char_length(payout_recipient_email_snapshot) <= 254
      and payout_recipient_email_snapshot ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    )
  ),
  constraint employee_payroll_item_amount_valid check (amount is null or amount > 0),
  constraint employee_payroll_item_exception_valid check (exception_status in ('clear', 'needs_review')),
  constraint employee_payroll_item_note_valid check (
    note is null or (note = btrim(note) and char_length(note) between 1 and 500)
  ),
  constraint employee_payroll_item_exception_note_valid check (
    exception_note is null or (exception_note = btrim(exception_note) and char_length(exception_note) between 1 and 500)
  )
);

create index if not exists employee_payroll_items_run_idx
  on public.employee_payroll_items (run_id, included, exception_status, employee_name_snapshot);

create table if not exists public.talent_payout_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  period_start date not null,
  period_end date not null,
  pay_date date not null,
  currency text not null default 'USD',
  status text not null default 'draft',
  total_amount numeric(14,2) not null default 0,
  item_count integer not null default 0,
  exception_count integer not null default 0,
  notes text,
  created_by_user_id uuid not null references public.platform_users(id) on delete restrict,
  approved_by_user_id uuid references public.platform_users(id) on delete set null,
  approved_at timestamptz,
  exported_by_user_id uuid references public.platform_users(id) on delete set null,
  exported_at timestamptz,
  export_file_name text,
  export_sha256 text,
  released_by_user_id uuid references public.platform_users(id) on delete set null,
  released_at timestamptz,
  external_reference text,
  cancelled_by_user_id uuid references public.platform_users(id) on delete set null,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint talent_payout_period_order check (period_end >= period_start),
  constraint talent_payout_pay_date_friday check (extract(isodow from pay_date) = 5),
  constraint talent_payout_currency_valid check (currency ~ '^[A-Z]{3}$'),
  constraint talent_payout_status_valid check (
    status in ('draft', 'ready', 'approved', 'exported', 'released', 'cancelled')
  ),
  constraint talent_payout_totals_valid check (
    total_amount >= 0 and item_count >= 0 and exception_count >= 0
  ),
  constraint talent_payout_note_valid check (
    notes is null or (notes = btrim(notes) and char_length(notes) between 1 and 1000)
  ),
  constraint talent_payout_export_hash_valid check (
    export_sha256 is null or export_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint talent_payout_approval_complete check (
    (status in ('draft', 'ready', 'cancelled') and approved_by_user_id is null and approved_at is null)
    or (status in ('approved', 'exported', 'released') and approved_by_user_id is not null and approved_at is not null)
  ),
  constraint talent_payout_export_complete check (
    (status in ('draft', 'ready', 'approved', 'cancelled')
      and exported_by_user_id is null and exported_at is null
      and export_file_name is null and export_sha256 is null)
    or (status in ('exported', 'released')
      and exported_by_user_id is not null and exported_at is not null
      and nullif(btrim(export_file_name), '') is not null and export_sha256 is not null)
  ),
  constraint talent_payout_release_complete check (
    (status <> 'released' and released_by_user_id is null and released_at is null)
    or (status = 'released' and released_by_user_id is not null and released_at is not null
      and nullif(btrim(external_reference), '') is not null)
  ),
  constraint talent_payout_cancellation_complete check (
    (status <> 'cancelled' and cancelled_by_user_id is null and cancelled_at is null)
    or (status = 'cancelled' and cancelled_by_user_id is not null and cancelled_at is not null)
  )
);

create unique index if not exists talent_payout_one_open_period_idx
  on public.talent_payout_runs (organization_id, period_start, period_end, pay_date)
  where status <> 'cancelled';

create index if not exists talent_payout_runs_org_status_idx
  on public.talent_payout_runs (organization_id, status, pay_date desc, created_at desc);

create table if not exists public.talent_payout_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.talent_payout_runs(id) on delete restrict,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  applicant_id uuid not null references public.applicants(id) on delete restrict,
  placement_id uuid not null references public.placements(id) on delete restrict,
  talent_name_snapshot text not null,
  recipient_email_snapshot text,
  client_name_snapshot text not null,
  rate_type_snapshot text,
  rate_amount_snapshot numeric(14,2),
  payment_reference text not null,
  included boolean not null default true,
  amount numeric(14,2),
  note text,
  verification_status text not null default 'needs_review',
  verification_note text,
  verified_by_user_id uuid references public.platform_users(id) on delete set null,
  verified_at timestamptz,
  exception_status text not null default 'needs_review',
  exception_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, placement_id),
  unique (run_id, payment_reference),
  constraint talent_payout_item_rate_valid check (rate_amount_snapshot is null or rate_amount_snapshot >= 0),
  constraint talent_payout_item_amount_valid check (amount is null or amount > 0),
  constraint talent_payout_item_verification_valid check (verification_status in ('needs_review', 'verified')),
  constraint talent_payout_item_verification_complete check (
    (verification_status = 'needs_review' and verified_by_user_id is null and verified_at is null)
    or (verification_status = 'verified' and verified_by_user_id is not null and verified_at is not null)
  ),
  constraint talent_payout_item_exception_valid check (exception_status in ('clear', 'needs_review')),
  constraint talent_payout_item_note_valid check (
    note is null or (note = btrim(note) and char_length(note) between 1 and 500)
  ),
  constraint talent_payout_item_verification_note_valid check (
    verification_note is null or (verification_note = btrim(verification_note) and char_length(verification_note) between 1 and 500)
  ),
  constraint talent_payout_item_exception_note_valid check (
    exception_note is null or (exception_note = btrim(exception_note) and char_length(exception_note) between 1 and 500)
  )
);

create index if not exists talent_payout_items_run_idx
  on public.talent_payout_items (run_id, included, exception_status, talent_name_snapshot);

create table if not exists public.financial_run_operations (
  operation_request_id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  actor_user_id uuid not null references public.platform_users(id) on delete restrict,
  workflow_type text not null,
  action text not null,
  run_id uuid not null,
  item_id uuid,
  request_fingerprint text not null,
  created_at timestamptz not null default now(),
  constraint financial_run_operation_workflow_valid check (
    workflow_type in ('employee_payroll', 'talent_payout')
  ),
  constraint financial_run_operation_action_valid check (
    action in ('create', 'update_item', 'verify_item', 'ready', 'approve', 'export', 'reconcile', 'release', 'cancel')
  ),
  constraint financial_run_operation_fingerprint_valid check (request_fingerprint ~ '^[0-9a-f]{64}$')
);

create index if not exists financial_run_operations_run_idx
  on public.financial_run_operations (workflow_type, run_id, created_at);

alter table public.employee_payroll_runs enable row level security;
alter table public.employee_payroll_items enable row level security;
alter table public.talent_payout_runs enable row level security;
alter table public.talent_payout_items enable row level security;
alter table public.financial_run_operations enable row level security;

revoke all on table public.employee_payroll_runs from public, anon, authenticated;
revoke all on table public.employee_payroll_items from public, anon, authenticated;
revoke all on table public.talent_payout_runs from public, anon, authenticated;
revoke all on table public.talent_payout_items from public, anon, authenticated;
revoke all on table public.financial_run_operations from public, anon, authenticated;

grant select, insert, update on table public.employee_payroll_runs to service_role;
grant select, insert, update on table public.employee_payroll_items to service_role;
grant select, insert, update on table public.talent_payout_runs to service_role;
grant select, insert, update on table public.talent_payout_items to service_role;
grant select, insert on table public.financial_run_operations to service_role;

drop trigger if exists employee_payroll_runs_updated_at on public.employee_payroll_runs;
create trigger employee_payroll_runs_updated_at
before update on public.employee_payroll_runs
for each row execute function public.set_updated_at();

drop trigger if exists employee_payroll_items_updated_at on public.employee_payroll_items;
create trigger employee_payroll_items_updated_at
before update on public.employee_payroll_items
for each row execute function public.set_updated_at();

drop trigger if exists talent_payout_runs_updated_at on public.talent_payout_runs;
create trigger talent_payout_runs_updated_at
before update on public.talent_payout_runs
for each row execute function public.set_updated_at();

drop trigger if exists talent_payout_items_updated_at on public.talent_payout_items;
create trigger talent_payout_items_updated_at
before update on public.talent_payout_items
for each row execute function public.set_updated_at();

create or replace function private.financial_actor(
  p_actor_user_id uuid,
  p_allow_talent_management boolean default false
)
returns table (organization_id uuid, role public.platform_role)
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
begin
  if p_actor_user_id is null then
    raise exception using errcode = '22023', message = 'A signed-in account is required.';
  end if;

  return query
  select access.organization_id, access.role
  from public.platform_users as access
  where access.id = p_actor_user_id
    and access.active = true
    and access.must_change_password = false
    and access.organization_id is not null
    and (
      access.role = 'admin'::public.platform_role
      or (p_allow_talent_management and access.role = 'talent_management'::public.platform_role)
    );

  if not found then
    raise exception using errcode = '42501', message = case
      when p_allow_talent_management then 'Admin or Talent Management access is required.'
      else 'Administrator access is required.'
    end;
  end if;
end;
$$;

revoke all on function private.financial_actor(uuid, boolean) from public, anon, authenticated;
grant execute on function private.financial_actor(uuid, boolean) to service_role;

create or replace function private.guard_employee_payroll_run()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '42501', message = 'Employee payroll runs are retained for audit history.';
  end if;

  if new.organization_id is distinct from old.organization_id
    or new.period_start is distinct from old.period_start
    or new.period_end is distinct from old.period_end
    or new.pay_date is distinct from old.pay_date
    or new.currency is distinct from old.currency
    or new.created_by_user_id is distinct from old.created_by_user_id
    or new.created_at is distinct from old.created_at then
    raise exception using errcode = '42501', message = 'Employee payroll identity and period fields cannot be changed.';
  end if;

  if not (
    (old.status = 'draft' and new.status in ('draft', 'ready', 'cancelled'))
    or (old.status = 'ready' and new.status in ('draft', 'ready', 'approved', 'cancelled'))
    or (old.status = 'approved' and new.status in ('approved', 'exported'))
    or (old.status = 'exported' and new.status in ('exported', 'reconciled'))
    or (old.status = 'reconciled' and new.status = 'reconciled')
    or (old.status = 'cancelled' and new.status = 'cancelled')
  ) then
    raise exception using errcode = '42501', message = 'This employee payroll status transition is not allowed.';
  end if;

  if old.status in ('approved', 'exported', 'reconciled', 'cancelled') and (
    new.total_amount is distinct from old.total_amount
    or new.item_count is distinct from old.item_count
    or new.exception_count is distinct from old.exception_count
  ) then
    raise exception using errcode = '42501', message = 'Approved employee payroll totals are immutable.';
  end if;

  return new;
end;
$$;

revoke all on function private.guard_employee_payroll_run() from public, anon, authenticated;

drop trigger if exists employee_payroll_run_guard on public.employee_payroll_runs;
create trigger employee_payroll_run_guard
before update or delete on public.employee_payroll_runs
for each row execute function private.guard_employee_payroll_run();

create or replace function private.guard_talent_payout_run()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '42501', message = 'Talent payout runs are retained for audit history.';
  end if;

  if new.organization_id is distinct from old.organization_id
    or new.period_start is distinct from old.period_start
    or new.period_end is distinct from old.period_end
    or new.pay_date is distinct from old.pay_date
    or new.currency is distinct from old.currency
    or new.created_by_user_id is distinct from old.created_by_user_id
    or new.created_at is distinct from old.created_at then
    raise exception using errcode = '42501', message = 'Talent payout identity and period fields cannot be changed.';
  end if;

  if not (
    (old.status = 'draft' and new.status in ('draft', 'ready', 'cancelled'))
    or (old.status = 'ready' and new.status in ('draft', 'ready', 'approved', 'cancelled'))
    or (old.status = 'approved' and new.status in ('approved', 'exported'))
    or (old.status = 'exported' and new.status in ('exported', 'released'))
    or (old.status = 'released' and new.status = 'released')
    or (old.status = 'cancelled' and new.status = 'cancelled')
  ) then
    raise exception using errcode = '42501', message = 'This Talent payout status transition is not allowed.';
  end if;

  if old.status in ('approved', 'exported', 'released', 'cancelled') and (
    new.total_amount is distinct from old.total_amount
    or new.item_count is distinct from old.item_count
    or new.exception_count is distinct from old.exception_count
  ) then
    raise exception using errcode = '42501', message = 'Approved Talent payout totals are immutable.';
  end if;

  return new;
end;
$$;

revoke all on function private.guard_talent_payout_run() from public, anon, authenticated;

drop trigger if exists talent_payout_run_guard on public.talent_payout_runs;
create trigger talent_payout_run_guard
before update or delete on public.talent_payout_runs
for each row execute function private.guard_talent_payout_run();

create or replace function private.guard_employee_payroll_item()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_run_status text;
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '42501', message = 'Employee payroll items are retained for audit history.';
  end if;

  if new.run_id is distinct from old.run_id
    or new.organization_id is distinct from old.organization_id
    or new.employee_user_id is distinct from old.employee_user_id
    or new.employee_name_snapshot is distinct from old.employee_name_snapshot
    or new.employee_email_snapshot is distinct from old.employee_email_snapshot
    or new.employee_role_snapshot is distinct from old.employee_role_snapshot
    or new.hire_date_snapshot is distinct from old.hire_date_snapshot
    or new.payment_route_snapshot is distinct from old.payment_route_snapshot
    or new.payment_reference is distinct from old.payment_reference
    or new.created_at is distinct from old.created_at then
    raise exception using errcode = '42501', message = 'Employee payroll identity snapshots cannot be changed.';
  end if;

  select run.status into v_run_status
  from public.employee_payroll_runs as run
  where run.id = old.run_id
    and run.organization_id = old.organization_id;

  if v_run_status is null then
    raise exception using errcode = '23514', message = 'Employee payroll item is not linked to its run.';
  end if;
  if v_run_status in ('approved', 'exported', 'reconciled', 'cancelled') then
    raise exception using errcode = '42501', message = 'Approved employee payroll snapshots are immutable.';
  end if;

  return new;
end;
$$;

revoke all on function private.guard_employee_payroll_item() from public, anon, authenticated;

drop trigger if exists employee_payroll_item_guard on public.employee_payroll_items;
create trigger employee_payroll_item_guard
before update or delete on public.employee_payroll_items
for each row execute function private.guard_employee_payroll_item();

create or replace function private.guard_talent_payout_item()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_run_status text;
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '42501', message = 'Talent payout items are retained for audit history.';
  end if;

  if new.run_id is distinct from old.run_id
    or new.organization_id is distinct from old.organization_id
    or new.applicant_id is distinct from old.applicant_id
    or new.placement_id is distinct from old.placement_id
    or new.talent_name_snapshot is distinct from old.talent_name_snapshot
    or new.client_name_snapshot is distinct from old.client_name_snapshot
    or new.rate_type_snapshot is distinct from old.rate_type_snapshot
    or new.rate_amount_snapshot is distinct from old.rate_amount_snapshot
    or new.payment_reference is distinct from old.payment_reference
    or new.created_at is distinct from old.created_at then
    raise exception using errcode = '42501', message = 'Talent payout identity snapshots cannot be changed.';
  end if;

  select run.status into v_run_status
  from public.talent_payout_runs as run
  where run.id = old.run_id
    and run.organization_id = old.organization_id;

  if v_run_status is null then
    raise exception using errcode = '23514', message = 'Talent payout item is not linked to its run.';
  end if;
  if v_run_status in ('approved', 'exported', 'released', 'cancelled') then
    raise exception using errcode = '42501', message = 'Approved Talent payout snapshots are immutable.';
  end if;

  return new;
end;
$$;

revoke all on function private.guard_talent_payout_item() from public, anon, authenticated;

drop trigger if exists talent_payout_item_guard on public.talent_payout_items;
create trigger talent_payout_item_guard
before update or delete on public.talent_payout_items
for each row execute function private.guard_talent_payout_item();

create or replace function private.recalculate_employee_payroll_run()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_run_id uuid := coalesce(new.run_id, old.run_id);
begin
  update public.employee_payroll_runs as run
  set
    total_amount = summary.total_amount,
    item_count = summary.item_count,
    exception_count = summary.exception_count
  from (
    select
      coalesce(sum(item.amount) filter (where item.included), 0)::numeric(14,2) as total_amount,
      count(*) filter (where item.included)::integer as item_count,
      count(*) filter (
        where item.included and (
          item.amount is null
          or item.payout_recipient_email_snapshot is null
          or item.exception_status <> 'clear'
        )
      )::integer as exception_count
    from public.employee_payroll_items as item
    where item.run_id = v_run_id
  ) as summary
  where run.id = v_run_id;
  return new;
end;
$$;

revoke all on function private.recalculate_employee_payroll_run() from public, anon, authenticated;

drop trigger if exists employee_payroll_item_totals on public.employee_payroll_items;
create trigger employee_payroll_item_totals
after insert or update on public.employee_payroll_items
for each row execute function private.recalculate_employee_payroll_run();

create or replace function private.recalculate_talent_payout_run()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_run_id uuid := coalesce(new.run_id, old.run_id);
begin
  update public.talent_payout_runs as run
  set
    total_amount = summary.total_amount,
    item_count = summary.item_count,
    exception_count = summary.exception_count
  from (
    select
      coalesce(sum(item.amount) filter (where item.included), 0)::numeric(14,2) as total_amount,
      count(*) filter (where item.included)::integer as item_count,
      count(*) filter (
        where item.included and (
          item.amount is null
          or item.exception_status <> 'clear'
          or item.verification_status <> 'verified'
        )
      )::integer as exception_count
    from public.talent_payout_items as item
    where item.run_id = v_run_id
  ) as summary
  where run.id = v_run_id;
  return new;
end;
$$;

revoke all on function private.recalculate_talent_payout_run() from public, anon, authenticated;

drop trigger if exists talent_payout_item_totals on public.talent_payout_items;
create trigger talent_payout_item_totals
after insert or update on public.talent_payout_items
for each row execute function private.recalculate_talent_payout_run();

create or replace function private.employee_payroll_runs_json(p_organization_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'runId', run.id,
        'periodStart', run.period_start,
        'periodEnd', run.period_end,
        'payDate', run.pay_date,
        'currency', run.currency,
        'status', run.status,
        'totalAmount', run.total_amount,
        'itemCount', run.item_count,
        'exceptionCount', run.exception_count,
        'notes', run.notes,
        'createdByUserId', run.created_by_user_id,
        'createdBy', coalesce(nullif(btrim(creator.display_name), ''), 'Administrator'),
        'createdAt', run.created_at,
        'approvedByUserId', run.approved_by_user_id,
        'approvedBy', nullif(btrim(approver.display_name), ''),
        'approvedAt', run.approved_at,
        'exportedByUserId', run.exported_by_user_id,
        'exportedBy', nullif(btrim(exporter.display_name), ''),
        'exportedAt', run.exported_at,
        'exportFileName', run.export_file_name,
        'exportSha256', run.export_sha256,
        'reconciledByUserId', run.reconciled_by_user_id,
        'reconciledBy', nullif(btrim(reconciler.display_name), ''),
        'reconciledAt', run.reconciled_at,
        'externalReference', run.external_reference,
        'updatedAt', run.updated_at,
        'canEdit', run.status in ('draft', 'ready'),
        'canApprove', run.status = 'ready',
        'canExport', run.status = 'approved',
        'canReconcile', run.status = 'exported',
        'canCancel', run.status in ('draft', 'ready'),
        'items', coalesce(items.rows, '[]'::jsonb)
      ) order by run.pay_date desc, run.created_at desc, run.id
    ),
    '[]'::jsonb
  )
  from (
    select candidate.*
    from public.employee_payroll_runs as candidate
    where candidate.organization_id = p_organization_id
    order by candidate.pay_date desc, candidate.created_at desc, candidate.id
    limit 50
  ) as run
  left join public.platform_users as creator on creator.id = run.created_by_user_id
  left join public.platform_users as approver on approver.id = run.approved_by_user_id
  left join public.platform_users as exporter on exporter.id = run.exported_by_user_id
  left join public.platform_users as reconciler on reconciler.id = run.reconciled_by_user_id
  left join lateral (
    select jsonb_agg(
      jsonb_build_object(
        'itemId', item.id,
        'employeeUserId', item.employee_user_id,
        'employeeName', item.employee_name_snapshot,
        'employeeEmail', item.employee_email_snapshot,
        'employeeRole', item.employee_role_snapshot,
        'hireDate', item.hire_date_snapshot,
        'paymentRoute', item.payment_route_snapshot,
        'payoutRecipientEmail', item.payout_recipient_email_snapshot,
        'paymentReference', item.payment_reference,
        'included', item.included,
        'amount', item.amount,
        'note', item.note,
        'exceptionStatus', item.exception_status,
        'exceptionNote', item.exception_note,
        'updatedAt', item.updated_at
      ) order by lower(item.employee_name_snapshot), item.id
    ) as rows
    from public.employee_payroll_items as item
    where item.run_id = run.id
      and item.organization_id = run.organization_id
  ) as items on true;
$$;

revoke all on function private.employee_payroll_runs_json(uuid) from public, anon, authenticated;
grant execute on function private.employee_payroll_runs_json(uuid) to service_role;

create or replace function private.talent_payout_runs_json(
  p_organization_id uuid,
  p_viewer_role public.platform_role
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'runId', run.id,
        'periodStart', run.period_start,
        'periodEnd', run.period_end,
        'payDate', run.pay_date,
        'currency', run.currency,
        'status', run.status,
        'totalAmount', run.total_amount,
        'itemCount', run.item_count,
        'exceptionCount', run.exception_count,
        'notes', run.notes,
        'createdByUserId', run.created_by_user_id,
        'createdBy', coalesce(nullif(btrim(creator.display_name), ''), 'Administrator'),
        'createdAt', run.created_at,
        'approvedByUserId', run.approved_by_user_id,
        'approvedBy', nullif(btrim(approver.display_name), ''),
        'approvedAt', run.approved_at,
        'exportedByUserId', run.exported_by_user_id,
        'exportedBy', nullif(btrim(exporter.display_name), ''),
        'exportedAt', run.exported_at,
        'exportFileName', run.export_file_name,
        'exportSha256', run.export_sha256,
        'releasedByUserId', run.released_by_user_id,
        'releasedBy', nullif(btrim(releaser.display_name), ''),
        'releasedAt', run.released_at,
        'externalReference', run.external_reference,
        'updatedAt', run.updated_at,
        'canEdit', p_viewer_role = 'admin'::public.platform_role and run.status in ('draft', 'ready'),
        'canVerify', p_viewer_role in ('admin'::public.platform_role, 'talent_management'::public.platform_role)
          and run.status in ('draft', 'ready'),
        'canApprove', p_viewer_role = 'admin'::public.platform_role and run.status = 'ready',
        'canExport', p_viewer_role = 'admin'::public.platform_role and run.status = 'approved',
        'canRelease', p_viewer_role = 'admin'::public.platform_role and run.status = 'exported',
        'canCancel', p_viewer_role = 'admin'::public.platform_role and run.status in ('draft', 'ready'),
        'items', coalesce(items.rows, '[]'::jsonb)
      ) order by run.pay_date desc, run.created_at desc, run.id
    ),
    '[]'::jsonb
  )
  from (
    select candidate.*
    from public.talent_payout_runs as candidate
    where candidate.organization_id = p_organization_id
    order by candidate.pay_date desc, candidate.created_at desc, candidate.id
    limit 50
  ) as run
  left join public.platform_users as creator on creator.id = run.created_by_user_id
  left join public.platform_users as approver on approver.id = run.approved_by_user_id
  left join public.platform_users as exporter on exporter.id = run.exported_by_user_id
  left join public.platform_users as releaser on releaser.id = run.released_by_user_id
  left join lateral (
    select jsonb_agg(
      jsonb_build_object(
        'itemId', item.id,
        'applicantId', item.applicant_id,
        'placementId', item.placement_id,
        'talentName', item.talent_name_snapshot,
        'recipientEmail', item.recipient_email_snapshot,
        'clientName', item.client_name_snapshot,
        'rateType', item.rate_type_snapshot,
        'rateAmount', item.rate_amount_snapshot,
        'paymentReference', item.payment_reference,
        'included', item.included,
        'amount', item.amount,
        'note', item.note,
        'verificationStatus', item.verification_status,
        'verificationNote', item.verification_note,
        'verifiedByUserId', item.verified_by_user_id,
        'verifiedBy', nullif(btrim(verifier.display_name), ''),
        'verifiedAt', item.verified_at,
        'exceptionStatus', item.exception_status,
        'exceptionNote', item.exception_note,
        'updatedAt', item.updated_at
      ) order by lower(item.talent_name_snapshot), item.id
    ) as rows
    from public.talent_payout_items as item
    left join public.platform_users as verifier on verifier.id = item.verified_by_user_id
    where item.run_id = run.id
      and item.organization_id = run.organization_id
  ) as items on true;
$$;

revoke all on function private.talent_payout_runs_json(uuid, public.platform_role) from public, anon, authenticated;
grant execute on function private.talent_payout_runs_json(uuid, public.platform_role) to service_role;

create or replace function public.get_admin_payroll_workspace(p_actor_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_actor record;
begin
  select * into v_actor from private.financial_actor(p_actor_user_id, true);

  return jsonb_build_object(
    'generatedAt', pg_catalog.clock_timestamp(),
    'viewerRole', v_actor.role::text,
    'employeePayroll', case
      when v_actor.role = 'admin'::public.platform_role then
        jsonb_build_object('runs', private.employee_payroll_runs_json(v_actor.organization_id))
      else null
    end,
    'talentPayouts', jsonb_build_object(
      'runs', private.talent_payout_runs_json(v_actor.organization_id, v_actor.role)
    )
  );
end;
$$;

revoke all on function public.get_admin_payroll_workspace(uuid) from public, anon, authenticated;
grant execute on function public.get_admin_payroll_workspace(uuid) to service_role;

create or replace function private.financial_operation_seen(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_workflow_type text,
  p_action text,
  p_run_id uuid,
  p_item_id uuid,
  p_fingerprint text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_operation public.financial_run_operations%rowtype;
begin
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'A request id is required.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('financial-run-operation:' || p_request_id::text, 0)
  );
  select * into v_operation
  from public.financial_run_operations
  where operation_request_id = p_request_id;

  if v_operation.operation_request_id is null then
    return false;
  end if;
  if v_operation.actor_user_id is distinct from p_actor_user_id
    or v_operation.workflow_type is distinct from p_workflow_type
    or v_operation.action is distinct from p_action
    or (p_run_id is not null and v_operation.run_id is distinct from p_run_id)
    or v_operation.item_id is distinct from p_item_id
    or v_operation.request_fingerprint is distinct from p_fingerprint then
    raise exception using errcode = '22023', message = 'This request id has already been used for another financial operation.';
  end if;
  return true;
end;
$$;

revoke all on function private.financial_operation_seen(uuid, uuid, text, text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function private.financial_operation_seen(uuid, uuid, text, text, uuid, uuid, text) to service_role;

create or replace function private.record_financial_operation(
  p_request_id uuid,
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_workflow_type text,
  p_action text,
  p_run_id uuid,
  p_item_id uuid,
  p_fingerprint text
)
returns void
language sql
security definer
set search_path = pg_catalog, public, private
as $$
  insert into public.financial_run_operations (
    operation_request_id, organization_id, actor_user_id, workflow_type,
    action, run_id, item_id, request_fingerprint
  ) values (
    p_request_id, p_organization_id, p_actor_user_id, p_workflow_type,
    p_action, p_run_id, p_item_id, p_fingerprint
  );
$$;

revoke all on function private.record_financial_operation(uuid, uuid, uuid, text, text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function private.record_financial_operation(uuid, uuid, uuid, text, text, uuid, uuid, text) to service_role;

create or replace function private.record_financial_audit(
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_event_type text,
  p_before_value jsonb,
  p_after_value jsonb,
  p_note text default null
)
returns void
language sql
security definer
set search_path = pg_catalog, public, private
as $$
  insert into public.audit_events (
    organization_id, actor_user_id, entity_type, entity_id, event_type,
    before_value, after_value, note
  ) values (
    p_organization_id, p_actor_user_id, p_entity_type, p_entity_id, p_event_type,
    p_before_value, p_after_value, p_note
  );
$$;

revoke all on function private.record_financial_audit(uuid, uuid, text, uuid, text, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function private.record_financial_audit(uuid, uuid, text, uuid, text, jsonb, jsonb, text) to service_role;

create or replace function public.create_employee_payroll_run(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_period_start date,
  p_period_end date,
  p_pay_date date,
  p_currency text default 'USD'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $$
declare
  v_actor record;
  v_run public.employee_payroll_runs%rowtype;
  v_currency text := upper(btrim(coalesce(p_currency, 'USD')));
  v_fingerprint text;
  v_item_count integer;
begin
  select * into v_actor from private.financial_actor(p_actor_user_id, false);
  if p_period_start is null or p_period_end is null or p_pay_date is null or p_period_end < p_period_start then
    raise exception using errcode = '22023', message = 'Enter a valid payroll period and pay date.';
  end if;
  if v_currency !~ '^[A-Z]{3}$' then
    raise exception using errcode = '22023', message = 'Enter a valid three-letter currency code.';
  end if;

  v_fingerprint := encode(digest(concat_ws('|', 'create', p_period_start, p_period_end, p_pay_date, v_currency), 'sha256'), 'hex');
  if private.financial_operation_seen(p_actor_user_id, p_request_id, 'employee_payroll', 'create', null, null, v_fingerprint) then
    return public.get_admin_payroll_workspace(p_actor_user_id);
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(concat_ws(':', 'employee-payroll-period', v_actor.organization_id, p_period_start, p_period_end, p_pay_date), 0)
  );

  insert into public.employee_payroll_runs (
    organization_id, period_start, period_end, pay_date, currency, created_by_user_id
  ) values (
    v_actor.organization_id, p_period_start, p_period_end, p_pay_date, v_currency, p_actor_user_id
  ) returning * into v_run;

  insert into public.employee_payroll_items (
    id, run_id, organization_id, employee_user_id, employee_name_snapshot,
    employee_email_snapshot, employee_role_snapshot, hire_date_snapshot,
    payment_route_snapshot, payout_recipient_email_snapshot,
    payment_reference, included, amount, exception_status, exception_note
  )
  select
    gen_random_uuid(),
    v_run.id,
    v_actor.organization_id,
    profile.user_id,
    profile.full_name,
    profile.email,
    access.role::text,
    profile.hire_date,
    profile.payment_route,
    profile.payout_recipient_email,
    concat('EP-', to_char(p_pay_date, 'YYYYMMDD'), '-', upper(substr(md5(profile.user_id::text), 1, 8))),
    true,
    null,
    'needs_review',
    case
      when profile.payout_recipient_email is null
        then 'Add the Wise payout recipient email and enter the manual employee payroll amount.'
      else 'Enter the manual employee payroll amount.'
    end
  from public.employee_profiles as profile
  join public.platform_users as access
    on access.id = profile.user_id
   and access.organization_id = profile.organization_id
  where profile.organization_id = v_actor.organization_id
    and profile.hire_date <= p_period_end
    and access.active = true
    and profile.payment_route = 'wise_contractor'::public.employee_payment_route
  order by lower(profile.full_name), profile.user_id;

  select count(*)::integer into v_item_count
  from public.employee_payroll_items where run_id = v_run.id;
  if v_item_count = 0 then
    raise exception using errcode = 'P0001', message = 'No active Wise-contractor employee profiles are eligible for this payroll period.';
  end if;

  perform private.record_financial_operation(
    p_request_id, v_actor.organization_id, p_actor_user_id, 'employee_payroll',
    'create', v_run.id, null, v_fingerprint
  );
  perform private.record_financial_audit(
    v_actor.organization_id, p_actor_user_id, 'employee_payroll', v_run.id, 'create', null,
    jsonb_build_object(
      'periodStart', p_period_start, 'periodEnd', p_period_end, 'payDate', p_pay_date,
      'currency', v_currency, 'itemCount', v_item_count, 'amountSource', 'manual',
      'paymentRoute', 'wise_contractor'
    ),
    'Employee payroll preparation created. QuickBooks remains the accounting source of truth.'
  );
  return public.get_admin_payroll_workspace(p_actor_user_id);
end;
$$;

revoke all on function public.create_employee_payroll_run(uuid, uuid, date, date, date, text) from public, anon, authenticated;
grant execute on function public.create_employee_payroll_run(uuid, uuid, date, date, date, text) to service_role;

create or replace function public.update_employee_payroll_item(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_run_id uuid,
  p_item_id uuid,
  p_amount numeric,
  p_note text,
  p_included boolean,
  p_payout_recipient_email text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $$
declare
  v_actor record;
  v_run public.employee_payroll_runs%rowtype;
  v_before public.employee_payroll_items%rowtype;
  v_note text := nullif(btrim(p_note), '');
  v_email text := nullif(lower(btrim(p_payout_recipient_email)), '');
  v_next_email text;
  v_fingerprint text;
begin
  select * into v_actor from private.financial_actor(p_actor_user_id, false);
  if p_run_id is null or p_item_id is null or p_included is null then
    raise exception using errcode = '22023', message = 'Payroll run, item, and inclusion state are required.';
  end if;
  if p_amount is not null and p_amount <= 0 then
    raise exception using errcode = '22023', message = 'Payroll amounts must be greater than zero.';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception using errcode = '22023', message = 'The payroll note is too long.';
  end if;
  if v_email is not null and (char_length(v_email) > 254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then
    raise exception using errcode = '22023', message = 'Enter a valid Wise payout recipient email.';
  end if;

  v_fingerprint := encode(digest(concat_ws('|', 'update_item', p_run_id, p_item_id, coalesce(p_amount::text, ''), coalesce(v_note, ''), p_included, coalesce(v_email, '')), 'sha256'), 'hex');
  if private.financial_operation_seen(p_actor_user_id, p_request_id, 'employee_payroll', 'update_item', p_run_id, p_item_id, v_fingerprint) then
    return public.get_admin_payroll_workspace(p_actor_user_id);
  end if;

  select * into v_run from public.employee_payroll_runs
  where id = p_run_id and organization_id = v_actor.organization_id for update;
  if v_run.id is null then
    raise exception using errcode = '42501', message = 'This employee payroll run is not available.';
  end if;
  if v_run.status not in ('draft', 'ready') then
    raise exception using errcode = '42501', message = 'Approved employee payroll snapshots cannot be changed.';
  end if;

  select * into v_before from public.employee_payroll_items
  where id = p_item_id and run_id = p_run_id and organization_id = v_actor.organization_id for update;
  if v_before.id is null then
    raise exception using errcode = '42501', message = 'This employee payroll item is not available.';
  end if;
  -- The backend sends this field explicitly. A null value deliberately clears
  -- the snapshot and reopens the exception instead of silently retaining a
  -- potentially incorrect Wise recipient.
  v_next_email := v_email;

  if v_run.status = 'ready' then
    update public.employee_payroll_runs set status = 'draft' where id = p_run_id;
  end if;
  update public.employee_payroll_items
  set
    included = p_included,
    amount = p_amount,
    note = v_note,
    payout_recipient_email_snapshot = v_next_email,
    exception_status = case
      when not p_included or (p_amount is not null and v_next_email is not null) then 'clear'
      else 'needs_review'
    end,
    exception_note = case
      when not p_included then null
      when p_amount is null and v_next_email is null
        then 'Add the Wise payout recipient email and enter the manual employee payroll amount.'
      when p_amount is null then 'Enter the manual employee payroll amount.'
      when v_next_email is null then 'Add the Wise payout recipient email.'
      else null
    end
  where id = p_item_id;

  perform private.record_financial_operation(
    p_request_id, v_actor.organization_id, p_actor_user_id, 'employee_payroll',
    'update_item', p_run_id, p_item_id, v_fingerprint
  );
  perform private.record_financial_audit(
    v_actor.organization_id, p_actor_user_id, 'employee_payroll', p_run_id, 'update_item',
    jsonb_build_object('itemId', p_item_id, 'included', v_before.included, 'amount', v_before.amount,
      'payoutRecipientEmailRecorded', v_before.payout_recipient_email_snapshot is not null),
    jsonb_build_object('itemId', p_item_id, 'included', p_included, 'amount', p_amount,
      'payoutRecipientEmailRecorded', v_next_email is not null),
    'Manual employee payroll item updated.'
  );
  return public.get_admin_payroll_workspace(p_actor_user_id);
end;
$$;

revoke all on function public.update_employee_payroll_item(uuid, uuid, uuid, uuid, numeric, text, boolean, text) from public, anon, authenticated;
grant execute on function public.update_employee_payroll_item(uuid, uuid, uuid, uuid, numeric, text, boolean, text) to service_role;

create or replace function public.create_talent_payout_run(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_period_start date,
  p_period_end date,
  p_pay_date date,
  p_currency text default 'USD'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $$
declare
  v_actor record;
  v_run public.talent_payout_runs%rowtype;
  v_currency text := upper(btrim(coalesce(p_currency, 'USD')));
  v_fingerprint text;
  v_item_count integer;
begin
  select * into v_actor from private.financial_actor(p_actor_user_id, false);
  if p_period_start is null or p_period_end is null or p_pay_date is null or p_period_end < p_period_start then
    raise exception using errcode = '22023', message = 'Enter a valid Talent payout period and pay date.';
  end if;
  if extract(isodow from p_pay_date) <> 5 then
    raise exception using errcode = '22023', message = 'Talent payout dates must be Fridays.';
  end if;
  if v_currency !~ '^[A-Z]{3}$' then
    raise exception using errcode = '22023', message = 'Enter a valid three-letter currency code.';
  end if;

  v_fingerprint := encode(digest(concat_ws('|', 'create', p_period_start, p_period_end, p_pay_date, v_currency), 'sha256'), 'hex');
  if private.financial_operation_seen(p_actor_user_id, p_request_id, 'talent_payout', 'create', null, null, v_fingerprint) then
    return public.get_admin_payroll_workspace(p_actor_user_id);
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(concat_ws(':', 'talent-payout-period', v_actor.organization_id, p_period_start, p_period_end, p_pay_date), 0)
  );

  insert into public.talent_payout_runs (
    organization_id, period_start, period_end, pay_date, currency, created_by_user_id
  ) values (
    v_actor.organization_id, p_period_start, p_period_end, p_pay_date, v_currency, p_actor_user_id
  ) returning * into v_run;

  insert into public.talent_payout_items (
    id, run_id, organization_id, applicant_id, placement_id, talent_name_snapshot,
    recipient_email_snapshot, client_name_snapshot, rate_type_snapshot,
    rate_amount_snapshot, payment_reference, included, amount,
    verification_status, exception_status, exception_note
  )
  select
    gen_random_uuid(),
    v_run.id,
    v_actor.organization_id,
    applicant.id,
    placement.id,
    applicant.full_name,
    lower(coalesce(nullif(btrim(applicant.portal_login_email), ''), nullif(btrim(applicant.email), ''))),
    client.company_name,
    nullif(btrim(placement.rate_type), ''),
    placement.virtual_assistant_rate,
    concat('TP-', to_char(p_pay_date, 'YYYYMMDD'), '-', upper(substr(md5(placement.id::text), 1, 8))),
    true,
    null,
    'needs_review',
    'needs_review',
    case
      when coalesce(nullif(btrim(applicant.portal_login_email), ''), nullif(btrim(applicant.email), '')) is null
        then 'Add a recipient email, enter the manual payout amount, and verify this payout.'
      else 'Enter the manual payout amount and verify the recipient.'
    end
  from public.placements as placement
  join public.applicants as applicant
    on applicant.id = placement.applicant_id
   and applicant.organization_id = v_actor.organization_id
   and applicant.archived_at is null
  join public.clients as client
    on client.id = placement.client_id
   and client.organization_id = v_actor.organization_id
   and client.archived_at is null
  where placement.start_date is not null
    and placement.start_date <= p_period_end
    and (placement.end_date is null or placement.end_date >= p_period_start)
    and regexp_replace(lower(btrim(placement.status)), '[[:space:]-]+', '_', 'g') = any (
      array['placement_confirmed', 'matched', 'onboarding', 'active', 'live', 'working', 'placed']
    )
  order by lower(applicant.full_name), placement.id;

  select count(*)::integer into v_item_count
  from public.talent_payout_items where run_id = v_run.id;
  if v_item_count = 0 then
    raise exception using errcode = 'P0001', message = 'No current Talent placements are eligible for this payout period.';
  end if;

  perform private.record_financial_operation(
    p_request_id, v_actor.organization_id, p_actor_user_id, 'talent_payout',
    'create', v_run.id, null, v_fingerprint
  );
  perform private.record_financial_audit(
    v_actor.organization_id, p_actor_user_id, 'talent_payout', v_run.id, 'create', null,
    jsonb_build_object(
      'periodStart', p_period_start, 'periodEnd', p_period_end, 'payDate', p_pay_date,
      'currency', v_currency, 'itemCount', v_item_count, 'amountSource', 'manual'
    ),
    'Talent payout preparation created for manual Wise release.'
  );
  return public.get_admin_payroll_workspace(p_actor_user_id);
end;
$$;

revoke all on function public.create_talent_payout_run(uuid, uuid, date, date, date, text) from public, anon, authenticated;
grant execute on function public.create_talent_payout_run(uuid, uuid, date, date, date, text) to service_role;

create or replace function public.update_talent_payout_item(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_run_id uuid,
  p_item_id uuid,
  p_amount numeric,
  p_note text default null,
  p_included boolean default true,
  p_recipient_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $$
declare
  v_actor record;
  v_run public.talent_payout_runs%rowtype;
  v_before public.talent_payout_items%rowtype;
  v_note text := nullif(btrim(p_note), '');
  v_email text := nullif(lower(btrim(p_recipient_email)), '');
  v_next_email text;
  v_material_change boolean;
  v_next_verification text;
  v_fingerprint text;
begin
  select * into v_actor from private.financial_actor(p_actor_user_id, false);
  if p_run_id is null or p_item_id is null or p_included is null then
    raise exception using errcode = '22023', message = 'Payout run, item, and inclusion state are required.';
  end if;
  if p_amount is not null and p_amount <= 0 then
    raise exception using errcode = '22023', message = 'Payout amounts must be greater than zero.';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception using errcode = '22023', message = 'The payout note is too long.';
  end if;
  if v_email is not null and (char_length(v_email) > 254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then
    raise exception using errcode = '22023', message = 'Enter a valid payout recipient email.';
  end if;

  v_fingerprint := encode(digest(concat_ws('|', 'update_item', p_run_id, p_item_id, coalesce(p_amount::text, ''), coalesce(v_note, ''), p_included, coalesce(v_email, '')), 'sha256'), 'hex');
  if private.financial_operation_seen(p_actor_user_id, p_request_id, 'talent_payout', 'update_item', p_run_id, p_item_id, v_fingerprint) then
    return public.get_admin_payroll_workspace(p_actor_user_id);
  end if;

  select * into v_run from public.talent_payout_runs
  where id = p_run_id and organization_id = v_actor.organization_id for update;
  if v_run.id is null then
    raise exception using errcode = '42501', message = 'This Talent payout run is not available.';
  end if;
  if v_run.status not in ('draft', 'ready') then
    raise exception using errcode = '42501', message = 'Approved Talent payout snapshots cannot be changed.';
  end if;

  select * into v_before from public.talent_payout_items
  where id = p_item_id and run_id = p_run_id and organization_id = v_actor.organization_id for update;
  if v_before.id is null then
    raise exception using errcode = '42501', message = 'This Talent payout item is not available.';
  end if;
  v_next_email := v_email;
  v_material_change := v_before.amount is distinct from p_amount
    or v_before.included is distinct from p_included
    or v_before.recipient_email_snapshot is distinct from v_next_email;
  v_next_verification := case
    when v_material_change then 'needs_review'
    else v_before.verification_status
  end;

  if v_run.status = 'ready' then
    update public.talent_payout_runs set status = 'draft' where id = p_run_id;
  end if;
  update public.talent_payout_items
  set
    included = p_included,
    amount = p_amount,
    note = v_note,
    recipient_email_snapshot = v_next_email,
    verification_status = v_next_verification,
    verification_note = case
      when v_material_change then 'Payout details changed and must be verified again.'
      else verification_note
    end,
    verified_by_user_id = case
      when v_material_change then null
      else verified_by_user_id
    end,
    verified_at = case
      when v_material_change then null
      else verified_at
    end,
    exception_status = case
      when not p_included then 'clear'
      when p_amount is not null and v_next_email is not null
        and v_next_verification = 'verified' then 'clear'
      else 'needs_review'
    end,
    exception_note = case
      when not p_included then null
      when p_amount is null then 'Enter the manual Talent payout amount.'
      when v_next_email is null then 'Add a payout recipient email.'
      when v_material_change then 'Verify the changed payout details.'
      when v_next_verification <> 'verified' then 'Verify the payout recipient.'
      else null
    end
  where id = p_item_id;

  perform private.record_financial_operation(
    p_request_id, v_actor.organization_id, p_actor_user_id, 'talent_payout',
    'update_item', p_run_id, p_item_id, v_fingerprint
  );
  perform private.record_financial_audit(
    v_actor.organization_id, p_actor_user_id, 'talent_payout', p_run_id, 'update_item',
    jsonb_build_object('itemId', p_item_id, 'included', v_before.included, 'amount', v_before.amount),
    jsonb_build_object('itemId', p_item_id, 'included', p_included, 'amount', p_amount, 'recipientChanged', v_before.recipient_email_snapshot is distinct from v_next_email),
    'Manual Talent payout item updated.'
  );
  return public.get_admin_payroll_workspace(p_actor_user_id);
end;
$$;

revoke all on function public.update_talent_payout_item(uuid, uuid, uuid, uuid, numeric, text, boolean, text) from public, anon, authenticated;
grant execute on function public.update_talent_payout_item(uuid, uuid, uuid, uuid, numeric, text, boolean, text) to service_role;

create or replace function public.verify_talent_payout_item(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_run_id uuid,
  p_item_id uuid,
  p_verification_status text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $$
declare
  v_actor record;
  v_run public.talent_payout_runs%rowtype;
  v_before public.talent_payout_items%rowtype;
  v_status text := lower(btrim(coalesce(p_verification_status, '')));
  v_note text := nullif(btrim(p_note), '');
  v_fingerprint text;
begin
  select * into v_actor from private.financial_actor(p_actor_user_id, true);
  if v_status not in ('verified', 'needs_review') then
    raise exception using errcode = '22023', message = 'Choose Verified or Needs review.';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception using errcode = '22023', message = 'The verification note is too long.';
  end if;
  if v_status = 'needs_review' and v_note is null then
    raise exception using errcode = '22023', message = 'Add a note explaining what needs review.';
  end if;

  v_fingerprint := encode(digest(concat_ws('|', 'verify_item', p_run_id, p_item_id, v_status, coalesce(v_note, '')), 'sha256'), 'hex');
  if private.financial_operation_seen(p_actor_user_id, p_request_id, 'talent_payout', 'verify_item', p_run_id, p_item_id, v_fingerprint) then
    return public.get_admin_payroll_workspace(p_actor_user_id);
  end if;

  select * into v_run from public.talent_payout_runs
  where id = p_run_id and organization_id = v_actor.organization_id for update;
  if v_run.id is null then
    raise exception using errcode = '42501', message = 'This Talent payout run is not available.';
  end if;
  if v_run.status not in ('draft', 'ready') then
    raise exception using errcode = '42501', message = 'Approved Talent payout snapshots cannot be changed.';
  end if;

  select * into v_before from public.talent_payout_items
  where id = p_item_id and run_id = p_run_id and organization_id = v_actor.organization_id for update;
  if v_before.id is null then
    raise exception using errcode = '42501', message = 'This Talent payout item is not available.';
  end if;
  if v_status = 'verified' and (
    v_before.recipient_email_snapshot is null
    or v_before.recipient_email_snapshot !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ) then
    raise exception using errcode = '22023', message = 'A valid payout recipient email is required before verification.';
  end if;

  if v_run.status = 'ready' then
    update public.talent_payout_runs set status = 'draft' where id = p_run_id;
  end if;
  update public.talent_payout_items
  set
    verification_status = v_status,
    verification_note = v_note,
    verified_by_user_id = case when v_status = 'verified' then p_actor_user_id else null end,
    verified_at = case when v_status = 'verified' then pg_catalog.clock_timestamp() else null end,
    exception_status = case
      when not included then 'clear'
      when v_status = 'verified' and amount is not null and recipient_email_snapshot is not null then 'clear'
      else 'needs_review'
    end,
    exception_note = case
      when not included then null
      when v_status = 'needs_review' then v_note
      when amount is null then 'Enter the manual Talent payout amount.'
      when recipient_email_snapshot is null then 'Add a payout recipient email.'
      else null
    end
  where id = p_item_id;

  perform private.record_financial_operation(
    p_request_id, v_actor.organization_id, p_actor_user_id, 'talent_payout',
    'verify_item', p_run_id, p_item_id, v_fingerprint
  );
  perform private.record_financial_audit(
    v_actor.organization_id, p_actor_user_id, 'talent_payout', p_run_id, 'verify_item',
    jsonb_build_object('itemId', p_item_id, 'verificationStatus', v_before.verification_status),
    jsonb_build_object('itemId', p_item_id, 'verificationStatus', v_status),
    v_note
  );
  return public.get_admin_payroll_workspace(p_actor_user_id);
end;
$$;

revoke all on function public.verify_talent_payout_item(uuid, uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.verify_talent_payout_item(uuid, uuid, uuid, uuid, text, text) to service_role;

create or replace function public.transition_employee_payroll_run(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_run_id uuid,
  p_action text,
  p_reference text default null,
  p_note text default null,
  p_export_file_name text default null,
  p_export_sha256 text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $$
declare
  v_actor record;
  v_run public.employee_payroll_runs%rowtype;
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_reference text := nullif(btrim(p_reference), '');
  v_note text := nullif(btrim(p_note), '');
  v_file_name text := nullif(btrim(p_export_file_name), '');
  v_export_sha256 text := lower(nullif(btrim(p_export_sha256), ''));
  v_fingerprint text;
  v_blockers integer;
begin
  select * into v_actor from private.financial_actor(p_actor_user_id, false);
  if v_action not in ('ready', 'approve', 'export', 'reconcile', 'cancel') then
    raise exception using errcode = '22023', message = 'Choose a supported employee payroll transition.';
  end if;
  if v_note is not null and char_length(v_note) > 1000 then
    raise exception using errcode = '22023', message = 'The payroll note is too long.';
  end if;
  if v_reference is not null and char_length(v_reference) > 240 then
    raise exception using errcode = '22023', message = 'The external payroll reference is too long.';
  end if;
  if v_action = 'export' and (
    v_file_name is null or char_length(v_file_name) > 180
    or v_export_sha256 is null or v_export_sha256 !~ '^[0-9a-f]{64}$'
  ) then
    raise exception using errcode = '22023', message = 'A safe export file name and SHA-256 hash are required.';
  end if;
  if v_action = 'reconcile' and v_reference is null then
    raise exception using errcode = '22023', message = 'Enter the QuickBooks payroll reference before reconciliation.';
  end if;

  v_fingerprint := encode(digest(concat_ws('|', v_action, p_run_id, coalesce(v_reference, ''), coalesce(v_note, ''), coalesce(v_file_name, ''), coalesce(v_export_sha256, '')), 'sha256'), 'hex');
  if private.financial_operation_seen(p_actor_user_id, p_request_id, 'employee_payroll', v_action, p_run_id, null, v_fingerprint) then
    return public.get_admin_payroll_workspace(p_actor_user_id);
  end if;

  select * into v_run from public.employee_payroll_runs
  where id = p_run_id and organization_id = v_actor.organization_id for update;
  if v_run.id is null then
    raise exception using errcode = '42501', message = 'This employee payroll run is not available.';
  end if;

  if v_action = 'ready' then
    if v_run.status <> 'draft' then
      raise exception using errcode = '22023', message = 'Only a draft employee payroll run can be marked ready.';
    end if;
    select count(*)::integer into v_blockers
    from public.employee_payroll_items as item
    where item.run_id = v_run.id
      and item.included
      and (
        item.amount is null
        or item.payout_recipient_email_snapshot is null
        or item.exception_status <> 'clear'
      );
    if v_run.item_count = 0 or v_run.total_amount <= 0 or v_blockers > 0 then
      raise exception using errcode = '22023', message = 'Resolve every included Wise recipient and employee payroll amount before review.';
    end if;
    update public.employee_payroll_runs set status = 'ready', notes = coalesce(v_note, notes) where id = v_run.id;
  elsif v_action = 'approve' then
    if v_run.status <> 'ready' then
      raise exception using errcode = '22023', message = 'Employee payroll must be ready before approval.';
    end if;
    update public.employee_payroll_runs set
      status = 'approved', approved_by_user_id = p_actor_user_id,
      approved_at = pg_catalog.clock_timestamp(), notes = coalesce(v_note, notes)
    where id = v_run.id;
  elsif v_action = 'export' then
    if v_run.status <> 'approved' then
      raise exception using errcode = '22023', message = 'Only approved employee payroll can be exported.';
    end if;
    update public.employee_payroll_runs set
      status = 'exported', exported_by_user_id = p_actor_user_id,
      exported_at = pg_catalog.clock_timestamp(), export_file_name = v_file_name,
      export_sha256 = v_export_sha256, notes = coalesce(v_note, notes)
    where id = v_run.id;
  elsif v_action = 'reconcile' then
    if v_run.status <> 'exported' then
      raise exception using errcode = '22023', message = 'Export employee payroll before recording it in QuickBooks.';
    end if;
    update public.employee_payroll_runs set
      status = 'reconciled', reconciled_by_user_id = p_actor_user_id,
      reconciled_at = pg_catalog.clock_timestamp(), external_reference = v_reference,
      notes = coalesce(v_note, notes)
    where id = v_run.id;
  else
    if v_run.status not in ('draft', 'ready') then
      raise exception using errcode = '22023', message = 'Approved employee payroll cannot be cancelled. Record any correction with the external payroll provider and its reference.';
    end if;
    update public.employee_payroll_runs set
      status = 'cancelled', cancelled_by_user_id = p_actor_user_id,
      cancelled_at = pg_catalog.clock_timestamp(), notes = coalesce(v_note, notes)
    where id = v_run.id;
  end if;

  perform private.record_financial_operation(
    p_request_id, v_actor.organization_id, p_actor_user_id, 'employee_payroll',
    v_action, v_run.id, null, v_fingerprint
  );
  perform private.record_financial_audit(
    v_actor.organization_id, p_actor_user_id, 'employee_payroll', v_run.id, v_action,
    jsonb_build_object('status', v_run.status, 'totalAmount', v_run.total_amount, 'itemCount', v_run.item_count),
    jsonb_build_object('status', case v_action when 'ready' then 'ready' when 'approve' then 'approved' when 'export' then 'exported' when 'reconcile' then 'reconciled' else 'cancelled' end,
      'totalAmount', v_run.total_amount, 'itemCount', v_run.item_count,
      'externalReferenceRecorded', v_reference is not null,
      'exportHashRecorded', v_export_sha256 is not null),
    v_note
  );
  return public.get_admin_payroll_workspace(p_actor_user_id);
end;
$$;

revoke all on function public.transition_employee_payroll_run(uuid, uuid, uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.transition_employee_payroll_run(uuid, uuid, uuid, text, text, text, text, text) to service_role;

create or replace function public.transition_talent_payout_run(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_run_id uuid,
  p_action text,
  p_reference text default null,
  p_note text default null,
  p_export_file_name text default null,
  p_export_sha256 text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $$
declare
  v_actor record;
  v_run public.talent_payout_runs%rowtype;
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_reference text := nullif(btrim(p_reference), '');
  v_note text := nullif(btrim(p_note), '');
  v_file_name text := nullif(btrim(p_export_file_name), '');
  v_export_sha256 text := lower(nullif(btrim(p_export_sha256), ''));
  v_fingerprint text;
  v_blockers integer;
begin
  select * into v_actor from private.financial_actor(p_actor_user_id, false);
  if v_action not in ('ready', 'approve', 'export', 'release', 'cancel') then
    raise exception using errcode = '22023', message = 'Choose a supported Talent payout transition.';
  end if;
  if v_note is not null and char_length(v_note) > 1000 then
    raise exception using errcode = '22023', message = 'The payout note is too long.';
  end if;
  if v_reference is not null and char_length(v_reference) > 240 then
    raise exception using errcode = '22023', message = 'The Wise batch reference is too long.';
  end if;
  if v_action = 'export' and (
    v_file_name is null or char_length(v_file_name) > 180
    or v_export_sha256 is null or v_export_sha256 !~ '^[0-9a-f]{64}$'
  ) then
    raise exception using errcode = '22023', message = 'A safe export file name and SHA-256 hash are required.';
  end if;
  if v_action = 'release' and v_reference is null then
    raise exception using errcode = '22023', message = 'Enter the Wise batch reference before recording release.';
  end if;

  v_fingerprint := encode(digest(concat_ws('|', v_action, p_run_id, coalesce(v_reference, ''), coalesce(v_note, ''), coalesce(v_file_name, ''), coalesce(v_export_sha256, '')), 'sha256'), 'hex');
  if private.financial_operation_seen(p_actor_user_id, p_request_id, 'talent_payout', v_action, p_run_id, null, v_fingerprint) then
    return public.get_admin_payroll_workspace(p_actor_user_id);
  end if;

  select * into v_run from public.talent_payout_runs
  where id = p_run_id and organization_id = v_actor.organization_id for update;
  if v_run.id is null then
    raise exception using errcode = '42501', message = 'This Talent payout run is not available.';
  end if;

  if v_action = 'ready' then
    if v_run.status <> 'draft' then
      raise exception using errcode = '22023', message = 'Only a draft Talent payout run can be marked ready.';
    end if;
    select count(*)::integer into v_blockers
    from public.talent_payout_items as item
    where item.run_id = v_run.id
      and item.included
      and (
        item.amount is null or item.exception_status <> 'clear'
        or item.verification_status <> 'verified'
        or item.recipient_email_snapshot is null
      );
    if v_run.item_count = 0 or v_run.total_amount <= 0 or v_blockers > 0 then
      raise exception using errcode = '22023', message = 'Resolve every included Talent amount, recipient, and verification before review.';
    end if;
    update public.talent_payout_runs set status = 'ready', notes = coalesce(v_note, notes) where id = v_run.id;
  elsif v_action = 'approve' then
    if v_run.status <> 'ready' then
      raise exception using errcode = '22023', message = 'Talent payouts must be ready before approval.';
    end if;
    update public.talent_payout_runs set
      status = 'approved', approved_by_user_id = p_actor_user_id,
      approved_at = pg_catalog.clock_timestamp(), notes = coalesce(v_note, notes)
    where id = v_run.id;
  elsif v_action = 'export' then
    if v_run.status <> 'approved' then
      raise exception using errcode = '22023', message = 'Only approved Talent payouts can be exported.';
    end if;
    update public.talent_payout_runs set
      status = 'exported', exported_by_user_id = p_actor_user_id,
      exported_at = pg_catalog.clock_timestamp(), export_file_name = v_file_name,
      export_sha256 = v_export_sha256, notes = coalesce(v_note, notes)
    where id = v_run.id;
  elsif v_action = 'release' then
    if v_run.status <> 'exported' then
      raise exception using errcode = '22023', message = 'Export the Wise-ready file before recording release.';
    end if;
    update public.talent_payout_runs set
      status = 'released', released_by_user_id = p_actor_user_id,
      released_at = pg_catalog.clock_timestamp(), external_reference = v_reference,
      notes = coalesce(v_note, notes)
    where id = v_run.id;
  else
    if v_run.status not in ('draft', 'ready') then
      raise exception using errcode = '22023', message = 'Approved Talent payouts cannot be cancelled. Record any correction with the payout provider and its reference.';
    end if;
    update public.talent_payout_runs set
      status = 'cancelled', cancelled_by_user_id = p_actor_user_id,
      cancelled_at = pg_catalog.clock_timestamp(), notes = coalesce(v_note, notes)
    where id = v_run.id;
  end if;

  perform private.record_financial_operation(
    p_request_id, v_actor.organization_id, p_actor_user_id, 'talent_payout',
    v_action, v_run.id, null, v_fingerprint
  );
  perform private.record_financial_audit(
    v_actor.organization_id, p_actor_user_id, 'talent_payout', v_run.id, v_action,
    jsonb_build_object('status', v_run.status, 'totalAmount', v_run.total_amount, 'itemCount', v_run.item_count),
    jsonb_build_object('status', case v_action when 'ready' then 'ready' when 'approve' then 'approved' when 'export' then 'exported' when 'release' then 'released' else 'cancelled' end,
      'totalAmount', v_run.total_amount, 'itemCount', v_run.item_count,
      'externalReferenceRecorded', v_reference is not null,
      'exportHashRecorded', v_export_sha256 is not null),
    v_note
  );
  return public.get_admin_payroll_workspace(p_actor_user_id);
end;
$$;

revoke all on function public.transition_talent_payout_run(uuid, uuid, uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.transition_talent_payout_run(uuid, uuid, uuid, text, text, text, text, text) to service_role;

create or replace function public.get_employee_payroll_export(
  p_actor_user_id uuid,
  p_run_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_actor record;
  v_run public.employee_payroll_runs%rowtype;
  v_rows jsonb;
begin
  select * into v_actor from private.financial_actor(p_actor_user_id, false);
  select * into v_run from public.employee_payroll_runs
  where id = p_run_id and organization_id = v_actor.organization_id;
  if v_run.id is null then
    raise exception using errcode = '42501', message = 'This employee payroll export is not available.';
  end if;
  if v_run.status not in ('approved', 'exported', 'reconciled') then
    raise exception using errcode = '42501', message = 'Approve employee payroll before export.';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'itemId', item.id,
        'employeeName', item.employee_name_snapshot,
        'employeeEmail', item.payout_recipient_email_snapshot,
        'payoutRecipientEmail', item.payout_recipient_email_snapshot,
        'paymentRoute', item.payment_route_snapshot,
        'amount', item.amount,
        'note', item.note,
        'reference', item.payment_reference
      ) order by lower(item.employee_name_snapshot), item.id
    ),
    '[]'::jsonb
  ) into v_rows
  from public.employee_payroll_items as item
  where item.run_id = v_run.id
    and item.organization_id = v_actor.organization_id
    and item.included;

  return jsonb_build_object(
    'runId', v_run.id,
    'periodStart', v_run.period_start,
    'periodEnd', v_run.period_end,
    'payDate', v_run.pay_date,
    'currency', v_run.currency,
    'status', v_run.status,
    'rows', v_rows
  );
end;
$$;

revoke all on function public.get_employee_payroll_export(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_employee_payroll_export(uuid, uuid) to service_role;

create or replace function public.get_talent_payout_export(
  p_actor_user_id uuid,
  p_run_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_actor record;
  v_run public.talent_payout_runs%rowtype;
  v_rows jsonb;
begin
  select * into v_actor from private.financial_actor(p_actor_user_id, false);
  select * into v_run from public.talent_payout_runs
  where id = p_run_id and organization_id = v_actor.organization_id;
  if v_run.id is null then
    raise exception using errcode = '42501', message = 'This Talent payout export is not available.';
  end if;
  if v_run.status not in ('approved', 'exported', 'released') then
    raise exception using errcode = '42501', message = 'Approve Talent payouts before export.';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'itemId', item.id,
        'talentName', item.talent_name_snapshot,
        'recipientEmail', item.recipient_email_snapshot,
        'amount', item.amount,
        'currency', v_run.currency,
        'reference', item.payment_reference
      ) order by lower(item.talent_name_snapshot), item.id
    ),
    '[]'::jsonb
  ) into v_rows
  from public.talent_payout_items as item
  where item.run_id = v_run.id
    and item.organization_id = v_actor.organization_id
    and item.included
    and item.verification_status = 'verified';

  return jsonb_build_object(
    'runId', v_run.id,
    'periodStart', v_run.period_start,
    'periodEnd', v_run.period_end,
    'payDate', v_run.pay_date,
    'currency', v_run.currency,
    'status', v_run.status,
    'rows', v_rows
  );
end;
$$;

revoke all on function public.get_talent_payout_export(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_talent_payout_export(uuid, uuid) to service_role;

-- Financial audit events contain sensitive amounts and workflow state. Preserve
-- the earlier Talent Portal, attendance, and time-off restrictions while making
-- Employee Payroll Administrator-only and Talent Payouts available only to
-- Administrators and Talent Management.
drop policy if exists "authorized internal users can read audit history" on public.audit_events;
create policy "authorized internal users can read audit history"
on public.audit_events for select to authenticated
using (
  private.is_internal_soro_user()
  and case
    when entity_type = 'employee_payroll' then
      private.current_soro_role() = 'admin'::public.platform_role
    when entity_type = 'employee' and event_type = 'employee_payment_route_update' then
      private.current_soro_role() = 'admin'::public.platform_role
    when entity_type = 'talent_payout' then
      private.current_soro_role() in (
        'admin'::public.platform_role,
        'talent_management'::public.platform_role
      )
    when entity_type in ('talent_portal_access', 'talent_attendance', 'talent_time_off') then
      private.current_soro_role() in (
        'admin'::public.platform_role,
        'talent_management'::public.platform_role
      )
    else true
  end
);

comment on table public.employee_payroll_runs is
  'Administrator-only manual Wise-contractor Employee Payroll preparation and QuickBooks reconciliation headers.';
comment on table public.employee_payroll_items is
  'Immutable-after-approval Wise-contractor Employee Payroll snapshots. Amounts are manually entered and are not tax calculations.';
comment on table public.talent_payout_runs is
  'Talent payout preparation headers for Administrator-approved manual Wise CSV release.';
comment on table public.talent_payout_items is
  'One manual Talent payout snapshot per placement; no attendance or time-off calculation is performed.';
comment on table public.financial_run_operations is
  'Shared idempotency ledger for Employee Payroll and Talent Payout mutations.';
comment on column public.employee_profiles.payment_route is
  'Administrator-selected payment route. New employee profiles fail closed as needs_setup.';
comment on column public.employee_profiles.payout_recipient_email is
  'Optional Wise payout recipient email, stored separately from the employee account email.';
comment on type public.employee_payment_route is
  'Fail-closed routing for internal staff: Wise contractor, QuickBooks employee, or needs setup.';
comment on function public.get_admin_payroll_workspace(uuid) is
  'Service-only role-scoped Employee Payroll and Talent Payout workspace.';
comment on function public.get_talent_payout_export(uuid, uuid) is
  'Service-only deterministic approved Talent payout rows for manual Wise CSV generation.';
