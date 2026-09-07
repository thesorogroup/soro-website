-- Soro Operations: Client interviews, final decisions, placement handoff,
-- and activation-safe onboarding.
--
-- Soro remains the system of record. Microsoft Graph is an optional delivery
-- side effect: every business mutation commits before the server attempts the
-- calendar command, and a separate idempotent RPC records that result.

-- A shortlist item stays unavailable to another Client while it is active,
-- selected, or placed. A final pass or a safe release makes it eligible again
-- without rewriting the Client's original response.
alter table public.client_shortlist_items
  add column if not exists workflow_state text not null default 'active';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'client_shortlist_items_workflow_state_check'
      and conrelid = 'public.client_shortlist_items'::regclass
  ) then
    alter table public.client_shortlist_items
      add constraint client_shortlist_items_workflow_state_check
      check (workflow_state in ('active', 'selected', 'placed', 'passed', 'released'));
  end if;
end
$$;

-- A partially filled multi-seat request remains open for later shortlist
-- rounds. Migration 035 owns the shortlist RPC, so redefine its shared status
-- predicate here rather than rewriting the already-applied migration.
create or replace function private.is_open_hiring_request_status(p_status text)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog
as $$
  select regexp_replace(lower(btrim(coalesce(p_status, ''))), '[[:space:]-]+', '_', 'g')
    in (
      'discovery', 'qualified', 'open', 'active', 'sourcing', 'matching',
      'shortlisting', 'interviewing', 'client_review', 'partially_filled'
    );
$$;

revoke all on function private.is_open_hiring_request_status(text)
  from public, anon, authenticated;

-- Terminal shortlist items are soft-retired so migration 035's active-item
-- compatibility query can safely admit the Talent to a later Client round.
-- The response and append-only decision remain intact as historical evidence.
alter table public.client_shortlist_items
  drop constraint if exists client_shortlist_items_removed_response_check;
alter table public.client_shortlist_items
  add constraint client_shortlist_items_removed_response_check check (
    removed_at is null
    or client_response is null
    or workflow_state in ('passed', 'released')
  );

create or replace function private.sync_shortlist_workflow_from_response()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  if new.client_response = 'not_a_fit' then
    if tg_op = 'INSERT'
      or (tg_op = 'UPDATE' and old.client_response is distinct from new.client_response) then
      raise exception using
        errcode = '42501',
        message = 'A final pass must be recorded by a Client Administrator in the decision workflow.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists sync_shortlist_workflow_from_response
on public.client_shortlist_items;
create trigger sync_shortlist_workflow_from_response
before insert or update on public.client_shortlist_items
for each row execute function private.sync_shortlist_workflow_from_response();

drop index if exists public.client_shortlist_items_one_active_candidate;
create unique index client_shortlist_items_one_active_candidate
  on public.client_shortlist_items (applicant_id)
  where removed_at is null
    and workflow_state in ('active', 'selected', 'placed')
    and (client_response is null or client_response <> 'not_a_fit');

-- Migration 035 intentionally owns shortlist mutation, while migration 036
-- introduced the canonical request pipeline. Bridge those two boundaries in
-- the same shortlist-send transaction so the Client workflow never depends on
-- a second manual status click.
create or replace function private.advance_request_when_shortlist_sent()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.status = 'sent' and (tg_op = 'INSERT' or old.status is distinct from 'sent') then
    update public.hiring_requests
    set status = 'client_review'
    where id = new.hiring_request_id
      and organization_id = new.organization_id
      and client_id = new.client_id
      and status in ('open', 'sourcing', 'shortlisting');
  end if;
  return new;
end;
$$;

drop trigger if exists advance_request_when_shortlist_sent
on public.client_shortlists;
create trigger advance_request_when_shortlist_sent
after insert or update on public.client_shortlists
for each row execute function private.advance_request_when_shortlist_sent();

create table if not exists public.client_candidate_interviews (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  client_id uuid not null,
  hiring_request_id uuid not null,
  shortlist_id uuid not null,
  shortlist_item_id uuid not null,
  applicant_id uuid not null,
  sales_owner_id uuid not null,
  client_contact_id uuid not null,
  round_number integer not null check (round_number between 1 and 100),
  status text not null default 'scheduled'
    check (status in ('scheduled', 'completed', 'cancelled', 'no_show')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null check (char_length(btrim(timezone)) between 1 and 100),
  outcome text constraint client_candidate_interviews_outcome_value_check
    check (outcome is null or outcome in ('advance', 'follow_up', 'not_selected')),
  private_notes text check (private_notes is null or char_length(private_notes) <= 4000),
  applicant_name_snapshot text not null check (char_length(btrim(applicant_name_snapshot)) between 1 and 180),
  applicant_email_snapshot text not null check (char_length(btrim(applicant_email_snapshot)) between 3 and 254),
  client_contact_name_snapshot text not null check (char_length(btrim(client_contact_name_snapshot)) between 1 and 180),
  client_contact_email_snapshot text not null check (char_length(btrim(client_contact_email_snapshot)) between 3 and 254),
  sales_owner_name_snapshot text not null check (char_length(btrim(sales_owner_name_snapshot)) between 1 and 180),
  sales_owner_email_snapshot text not null check (char_length(btrim(sales_owner_email_snapshot)) between 3 and 254),
  calendar_sync_status text not null default 'pending'
    check (calendar_sync_status in ('connection_required', 'pending', 'synced', 'sync_failed', 'not_applicable')),
  calendar_sync_action text
    check (calendar_sync_action is null or calendar_sync_action in ('create', 'update', 'cancel')),
  calendar_transaction_id uuid,
  microsoft_event_id text check (microsoft_event_id is null or char_length(microsoft_event_id) <= 1024),
  microsoft_join_url text check (microsoft_join_url is null or char_length(microsoft_join_url) <= 2048),
  microsoft_last_error_code text check (microsoft_last_error_code is null or char_length(microsoft_last_error_code) <= 100),
  microsoft_organizer_snapshot text
    check (microsoft_organizer_snapshot is null or char_length(microsoft_organizer_snapshot) <= 1024),
  calendar_sync_started_at timestamptz,
  created_by_user_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_candidate_interviews_client_organization_fkey
    foreign key (client_id, organization_id)
    references public.clients (id, organization_id) on delete restrict,
  constraint client_candidate_interviews_request_client_organization_fkey
    foreign key (hiring_request_id, client_id, organization_id)
    references public.hiring_requests (id, client_id, organization_id) on delete restrict,
  constraint client_candidate_interviews_shortlist_organization_fkey
    foreign key (shortlist_id, organization_id)
    references public.client_shortlists (id, organization_id) on delete restrict,
  constraint client_candidate_interviews_item_shortlist_fkey
    foreign key (shortlist_item_id, shortlist_id)
    references public.client_shortlist_items (id, shortlist_id) on delete restrict,
  constraint client_candidate_interviews_applicant_organization_fkey
    foreign key (applicant_id, organization_id)
    references public.applicants (id, organization_id) on delete restrict,
  constraint client_candidate_interviews_owner_organization_fkey
    foreign key (sales_owner_id, organization_id)
    references public.platform_users (id, organization_id) on delete restrict,
  constraint client_candidate_interviews_contact_organization_fkey
    foreign key (client_contact_id, organization_id)
    references public.client_contacts (id, organization_id) on delete restrict,
  constraint client_candidate_interviews_creator_organization_fkey
    foreign key (created_by_user_id, organization_id)
    references public.platform_users (id, organization_id) on delete restrict,
  constraint client_candidate_interviews_time_check check (ends_at > starts_at),
  constraint client_candidate_interviews_outcome_check check (
    (status = 'completed' and outcome is not null)
    or (status <> 'completed' and outcome is null)
  ),
  unique (hiring_request_id, applicant_id, round_number)
);

create unique index if not exists client_candidate_interviews_id_organization_unique
  on public.client_candidate_interviews (id, organization_id);
create unique index if not exists client_candidate_interviews_one_scheduled_per_item
  on public.client_candidate_interviews (shortlist_item_id)
  where status = 'scheduled';
create index if not exists client_candidate_interviews_request_schedule_idx
  on public.client_candidate_interviews (organization_id, hiring_request_id, starts_at, id);

drop trigger if exists client_candidate_interviews_updated_at
on public.client_candidate_interviews;
create trigger client_candidate_interviews_updated_at
before update on public.client_candidate_interviews
for each row execute function public.set_updated_at();

create table if not exists public.client_candidate_decisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  client_id uuid not null,
  hiring_request_id uuid not null,
  shortlist_id uuid not null,
  shortlist_item_id uuid not null unique,
  applicant_id uuid not null,
  decided_by_user_id uuid not null,
  decision text not null check (decision in ('selected', 'passed')),
  created_at timestamptz not null default now(),
  constraint client_candidate_decisions_client_organization_fkey
    foreign key (client_id, organization_id)
    references public.clients (id, organization_id) on delete restrict,
  constraint client_candidate_decisions_request_client_organization_fkey
    foreign key (hiring_request_id, client_id, organization_id)
    references public.hiring_requests (id, client_id, organization_id) on delete restrict,
  constraint client_candidate_decisions_shortlist_organization_fkey
    foreign key (shortlist_id, organization_id)
    references public.client_shortlists (id, organization_id) on delete restrict,
  constraint client_candidate_decisions_item_shortlist_fkey
    foreign key (shortlist_item_id, shortlist_id)
    references public.client_shortlist_items (id, shortlist_id) on delete restrict,
  constraint client_candidate_decisions_applicant_organization_fkey
    foreign key (applicant_id, organization_id)
    references public.applicants (id, organization_id) on delete restrict,
  constraint client_candidate_decisions_decider_organization_fkey
    foreign key (decided_by_user_id, organization_id)
    references public.platform_users (id, organization_id) on delete restrict
);

create unique index if not exists client_candidate_decisions_id_organization_unique
  on public.client_candidate_decisions (id, organization_id);
create index if not exists client_candidate_decisions_request_idx
  on public.client_candidate_decisions (organization_id, hiring_request_id, created_at, id);

-- Migration 035 briefly allowed "Not a fit" as an unattributed shortlist
-- response. Preserve only decisions that were actually made by a Client
-- Administrator; fail closed if a Reviewer-authored legacy pass is present so
-- it can be reviewed instead of silently releasing Talent.
insert into public.client_candidate_decisions (
  organization_id, client_id, hiring_request_id, shortlist_id,
  shortlist_item_id, applicant_id, decided_by_user_id, decision, created_at
)
select
  item.organization_id, shortlist.client_id, shortlist.hiring_request_id,
  shortlist.id, item.id, item.applicant_id, item.response_by_user_id,
  'passed', coalesce(item.responded_at, item.updated_at, now())
from public.client_shortlist_items as item
join public.client_shortlists as shortlist
  on shortlist.id = item.shortlist_id
 and shortlist.organization_id = item.organization_id
join public.platform_users as decider
  on decider.id = item.response_by_user_id
 and decider.organization_id = item.organization_id
 and decider.role = 'client_admin'::public.platform_role
where item.client_response = 'not_a_fit'
on conflict (shortlist_item_id) do nothing;

update public.client_shortlist_items as item
set workflow_state = 'passed',
    removed_by_user_id = coalesce(item.removed_by_user_id, (
      select decision.decided_by_user_id
      from public.client_candidate_decisions as decision
      where decision.shortlist_item_id = item.id
        and decision.organization_id = item.organization_id
        and decision.decision = 'passed'
    )),
    removed_at = coalesce(item.removed_at, item.responded_at, item.updated_at, pg_catalog.clock_timestamp())
where item.client_response = 'not_a_fit'
  and exists (
    select 1
    from public.client_candidate_decisions as decision
    where decision.shortlist_item_id = item.id
      and decision.organization_id = item.organization_id
      and decision.decision = 'passed'
  );

do $$
begin
  if exists (
    select 1
    from public.client_shortlist_items as item
    where item.client_response = 'not_a_fit'
      and not exists (
        select 1
        from public.client_candidate_decisions as decision
        where decision.shortlist_item_id = item.id
          and decision.organization_id = item.organization_id
      )
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'A legacy Reviewer pass needs Client Administrator review before placement migration can continue.';
  end if;
end
$$;

create or replace function private.client_candidate_decision_append_only()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  raise exception using errcode = '42501', message = 'Client final decisions are append-only.';
end;
$$;

drop trigger if exists client_candidate_decisions_append_only
on public.client_candidate_decisions;
create trigger client_candidate_decisions_append_only
before update or delete on public.client_candidate_decisions
for each row execute function private.client_candidate_decision_append_only();

create table if not exists public.client_placement_handoffs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  client_id uuid not null,
  hiring_request_id uuid not null,
  shortlist_item_id uuid not null,
  applicant_id uuid not null,
  decision_id uuid not null unique,
  prepared_by_user_id uuid not null,
  status text not null default 'prepared' check (status in ('prepared', 'confirmed', 'cancelled')),
  start_date date not null,
  schedule_summary text not null check (char_length(btrim(schedule_summary)) between 2 and 1000),
  rate_type text not null check (char_length(btrim(rate_type)) between 1 and 60),
  client_rate numeric(12,2) not null check (client_rate > 0),
  talent_rate numeric(12,2) not null check (talent_rate > 0),
  confirmed_by_user_id uuid,
  confirmed_at timestamptz,
  placement_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_placement_handoffs_client_organization_fkey
    foreign key (client_id, organization_id)
    references public.clients (id, organization_id) on delete restrict,
  constraint client_placement_handoffs_request_client_organization_fkey
    foreign key (hiring_request_id, client_id, organization_id)
    references public.hiring_requests (id, client_id, organization_id) on delete restrict,
  constraint client_placement_handoffs_item_organization_fkey
    foreign key (shortlist_item_id, organization_id)
    references public.client_shortlist_items (id, organization_id) on delete restrict,
  constraint client_placement_handoffs_applicant_organization_fkey
    foreign key (applicant_id, organization_id)
    references public.applicants (id, organization_id) on delete restrict,
  constraint client_placement_handoffs_decision_organization_fkey
    foreign key (decision_id, organization_id)
    references public.client_candidate_decisions (id, organization_id) on delete restrict,
  constraint client_placement_handoffs_preparer_organization_fkey
    foreign key (prepared_by_user_id, organization_id)
    references public.platform_users (id, organization_id) on delete restrict,
  constraint client_placement_handoffs_confirmer_organization_fkey
    foreign key (confirmed_by_user_id, organization_id)
    references public.platform_users (id, organization_id) on delete restrict,
  constraint client_placement_handoffs_confirmation_check check (
    (status = 'confirmed' and confirmed_by_user_id is not null and confirmed_at is not null and placement_id is not null)
    or (status <> 'confirmed' and confirmed_by_user_id is null and confirmed_at is null and placement_id is null)
  )
);

create unique index if not exists client_placement_handoffs_id_organization_unique
  on public.client_placement_handoffs (id, organization_id);
create index if not exists client_placement_handoffs_request_idx
  on public.client_placement_handoffs (organization_id, hiring_request_id, status, updated_at desc);

drop trigger if exists client_placement_handoffs_updated_at
on public.client_placement_handoffs;
create trigger client_placement_handoffs_updated_at
before update on public.client_placement_handoffs
for each row execute function public.set_updated_at();

create table if not exists public.placement_onboarding_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  placement_id uuid not null,
  item_key text not null check (item_key ~ '^[a-z][a-z0-9_]{1,59}$'),
  title text not null check (char_length(btrim(title)) between 2 and 180),
  required boolean not null default true,
  status text not null default 'pending' check (status in ('pending', 'completed')),
  completed_by_user_id uuid,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint placement_onboarding_items_placement_organization_fkey
    foreign key (placement_id, organization_id)
    references public.placements (id, organization_id) on delete cascade,
  constraint placement_onboarding_items_completer_organization_fkey
    foreign key (completed_by_user_id, organization_id)
    references public.platform_users (id, organization_id) on delete restrict,
  constraint placement_onboarding_items_completion_check check (
    (status = 'pending' and completed_by_user_id is null and completed_at is null)
    or (status = 'completed' and completed_by_user_id is not null and completed_at is not null)
  ),
  unique (placement_id, item_key)
);

create index if not exists placement_onboarding_items_placement_idx
  on public.placement_onboarding_items (organization_id, placement_id, required, status, item_key);

drop trigger if exists placement_onboarding_items_updated_at
on public.placement_onboarding_items;
create trigger placement_onboarding_items_updated_at
before update on public.placement_onboarding_items
for each row execute function public.set_updated_at();

create table if not exists public.client_placement_operations (
  operation_request_id uuid not null,
  phase text not null default 'mutation' check (phase in ('mutation', 'calendar_sync')),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  actor_user_id uuid not null,
  action text not null check (action in (
    'schedule_interview', 'reschedule_interview', 'cancel_interview',
    'record_interview_outcome', 'retry_calendar_sync', 'final_decision',
    'prepare_handoff', 'confirm_placement', 'update_onboarding',
    'activate_placement', 'calendar_sync_result'
  )),
  hiring_request_id uuid not null,
  interview_id uuid,
  decision_id uuid,
  handoff_id uuid,
  placement_id uuid,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key (operation_request_id, phase),
  constraint client_placement_operations_actor_organization_fkey
    foreign key (actor_user_id, organization_id)
    references public.platform_users (id, organization_id) on delete restrict,
  constraint client_placement_operations_request_organization_fkey
    foreign key (hiring_request_id, organization_id)
    references public.hiring_requests (id, organization_id) on delete restrict,
  constraint client_placement_operations_interview_organization_fkey
    foreign key (interview_id, organization_id)
    references public.client_candidate_interviews (id, organization_id) on delete restrict,
  constraint client_placement_operations_decision_organization_fkey
    foreign key (decision_id, organization_id)
    references public.client_candidate_decisions (id, organization_id) on delete restrict,
  constraint client_placement_operations_handoff_organization_fkey
    foreign key (handoff_id, organization_id)
    references public.client_placement_handoffs (id, organization_id) on delete restrict,
  constraint client_placement_operations_placement_organization_fkey
    foreign key (placement_id, organization_id)
    references public.placements (id, organization_id) on delete restrict
);

create index if not exists client_placement_operations_request_idx
  on public.client_placement_operations (organization_id, hiring_request_id, created_at desc);

alter table public.client_candidate_interviews enable row level security;
alter table public.client_candidate_decisions enable row level security;
alter table public.client_placement_handoffs enable row level security;
alter table public.placement_onboarding_items enable row level security;
alter table public.client_placement_operations enable row level security;

revoke all on table public.client_candidate_interviews from public, anon, authenticated;
revoke all on table public.client_candidate_decisions from public, anon, authenticated;
revoke all on table public.client_placement_handoffs from public, anon, authenticated;
revoke all on table public.placement_onboarding_items from public, anon, authenticated;
revoke all on table public.client_placement_operations from public, anon, authenticated;

grant select, insert, update on table public.client_candidate_interviews to service_role;
grant select, insert on table public.client_candidate_decisions to service_role;
grant select, insert, update on table public.client_placement_handoffs to service_role;
grant select, insert, update on table public.placement_onboarding_items to service_role;
grant select, insert on table public.client_placement_operations to service_role;

-- Cross-workflow invariants belong at the table boundary because Client Hub,
-- shortlist, placement, and future administrative tools all update these same
-- records. Terminal changes are rejected until a dedicated withdrawal flow can
-- cancel meetings, release Talent, and retain an attributable audit trail.
create or replace function private.guard_hiring_request_workflow_dependencies()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_committed_seats integer := 0;
begin
  if new.number_of_virtual_assistants is distinct from old.number_of_virtual_assistants then
    select greatest(
      (
        select count(*)::integer
        from public.client_candidate_decisions as decision
        where decision.organization_id = old.organization_id
          and decision.hiring_request_id = old.id
          and decision.decision = 'selected'
      ),
      (
        select count(*)::integer
        from public.placements as placement
        where placement.organization_id = old.organization_id
          and placement.hiring_request_id = old.id
          and placement.status in ('placement_confirmed', 'onboarding', 'active')
          and placement.end_date is null
      )
    ) into v_committed_seats;

    if new.number_of_virtual_assistants < v_committed_seats then
      raise exception using
        errcode = 'P0001',
        message = 'The requested seats cannot be lower than the selected or placed Talent count.';
    end if;

    if old.status in (
      'client_review', 'interviewing', 'selection_pending',
      'placement_pending', 'partially_filled', 'filled'
    ) or exists (
      select 1
      from public.client_shortlists as shortlist
      where shortlist.organization_id = old.organization_id
        and shortlist.hiring_request_id = old.id
        and shortlist.status = 'sent'
    ) or exists (
      select 1
      from public.client_candidate_decisions as decision
      where decision.organization_id = old.organization_id
        and decision.hiring_request_id = old.id
    ) or exists (
      select 1
      from public.client_placement_handoffs as handoff
      where handoff.organization_id = old.organization_id
        and handoff.hiring_request_id = old.id
    ) or exists (
      select 1
      from public.placements as placement
      where placement.organization_id = old.organization_id
        and placement.hiring_request_id = old.id
    ) then
      raise exception using
        errcode = 'P0001',
        message = 'Seat count is locked after Client review begins.';
    end if;
  end if;

  if new.status is distinct from old.status
    and new.status in ('on_hold', 'cancelled')
    and (
      exists (
        select 1
        from public.client_shortlists as shortlist
        join public.client_shortlist_items as item
          on item.shortlist_id = shortlist.id
         and item.organization_id = shortlist.organization_id
        where shortlist.organization_id = old.organization_id
          and shortlist.hiring_request_id = old.id
          and item.removed_at is null
          and item.workflow_state in ('active', 'selected', 'placed')
      )
      or exists (
        select 1
        from public.client_candidate_interviews as interview
        where interview.organization_id = old.organization_id
          and interview.hiring_request_id = old.id
          and (
            interview.status = 'scheduled'
            or (
              interview.status = 'cancelled'
              and interview.calendar_sync_action = 'cancel'
              and interview.calendar_sync_status in ('pending', 'sync_failed', 'connection_required')
            )
          )
      )
      or exists (
        select 1
        from public.client_candidate_decisions as decision
        where decision.organization_id = old.organization_id
          and decision.hiring_request_id = old.id
          and decision.decision = 'selected'
      )
      or exists (
        select 1
        from public.client_placement_handoffs as handoff
        where handoff.organization_id = old.organization_id
          and handoff.hiring_request_id = old.id
          and handoff.status in ('prepared', 'confirmed')
      )
      or exists (
        select 1
        from public.placements as placement
        where placement.organization_id = old.organization_id
          and placement.hiring_request_id = old.id
          and placement.status in ('placement_confirmed', 'onboarding', 'active')
          and placement.end_date is null
      )
    ) then
      raise exception using
        errcode = 'P0001',
        message = 'Resolve active candidates, interviews, selections, and placements before pausing or cancelling this request.';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_hiring_request_workflow_dependencies
on public.hiring_requests;
create trigger guard_hiring_request_workflow_dependencies
before update of number_of_virtual_assistants, status on public.hiring_requests
for each row execute function private.guard_hiring_request_workflow_dependencies();

create or replace function private.guard_client_workflow_dependencies()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_has_dependent_workflow boolean;
  v_has_open_workflow boolean;
begin
  select (
    exists (
      select 1
      from public.client_shortlists as shortlist
      join public.client_shortlist_items as item
        on item.shortlist_id = shortlist.id
       and item.organization_id = shortlist.organization_id
      where shortlist.organization_id = old.organization_id
        and shortlist.client_id = old.id
        and item.removed_at is null
        and item.workflow_state in ('active', 'selected', 'placed')
    )
    or exists (
      select 1
      from public.client_candidate_interviews as interview
      where interview.organization_id = old.organization_id
        and interview.client_id = old.id
        and (
          interview.status = 'scheduled'
          or (
            interview.status = 'cancelled'
            and interview.calendar_sync_action = 'cancel'
            and interview.calendar_sync_status in ('pending', 'sync_failed', 'connection_required')
          )
        )
    )
    or exists (
      select 1
      from public.client_candidate_decisions as decision
      where decision.organization_id = old.organization_id
        and decision.client_id = old.id
        and decision.decision = 'selected'
    )
    or exists (
      select 1
      from public.client_placement_handoffs as handoff
      where handoff.organization_id = old.organization_id
        and handoff.client_id = old.id
        and handoff.status in ('prepared', 'confirmed')
    )
    or exists (
      select 1
      from public.placements as placement
      where placement.organization_id = old.organization_id
        and placement.client_id = old.id
        and placement.status in ('placement_confirmed', 'onboarding', 'active')
        and placement.end_date is null
    )
  ) into v_has_dependent_workflow;

  select v_has_dependent_workflow or exists (
    select 1
    from public.hiring_requests as request
    where request.organization_id = old.organization_id
      and request.client_id = old.id
      and request.status not in ('filled', 'cancelled')
  ) into v_has_open_workflow;

  if new.sales_owner_id is distinct from old.sales_owner_id
    and v_has_dependent_workflow then
    raise exception using
      errcode = 'P0001',
      message = 'Client ownership cannot change while a shortlist, interview, selection, handoff, or placement is active.';
  end if;

  if (
      (new.lifecycle_stage is distinct from old.lifecycle_stage
        and new.lifecycle_stage in ('paused', 'lost', 'archived'))
      or (new.archived_at is distinct from old.archived_at and new.archived_at is not null)
    )
    and v_has_open_workflow then
    raise exception using
      errcode = 'P0001',
      message = 'Resolve every open request and placement before pausing, closing, or archiving this Client.';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_client_workflow_dependencies
on public.clients;
create trigger guard_client_workflow_dependencies
before update of sales_owner_id, lifecycle_stage, archived_at on public.clients
for each row execute function private.guard_client_workflow_dependencies();

revoke all on function private.guard_hiring_request_workflow_dependencies()
  from public, anon, authenticated;
revoke all on function private.guard_client_workflow_dependencies()
  from public, anon, authenticated;

create or replace function private.client_placement_actor(p_actor_user_id uuid)
returns table (
  user_id uuid,
  organization_id uuid,
  role public.platform_role,
  client_id uuid,
  client_contact_id uuid
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_access public.platform_users%rowtype;
  v_membership public.client_portal_memberships%rowtype;
begin
  if p_actor_user_id is null then
    raise exception using errcode = '22023', message = 'A signed-in account is required.';
  end if;

  select access.* into v_access
  from public.platform_users as access
  where access.id = p_actor_user_id
    and access.organization_id is not null
    and access.active = true
    and access.must_change_password = false
    and access.role in (
      'admin'::public.platform_role,
      'sales_management'::public.platform_role,
      'sales'::public.platform_role,
      'talent_management'::public.platform_role,
      'client_admin'::public.platform_role,
      'client_reviewer'::public.platform_role
    );
  if not found then
    raise exception using errcode = '42501', message = 'Active Client placement workflow access is required.';
  end if;

  if v_access.role in (
    'client_admin'::public.platform_role,
    'client_reviewer'::public.platform_role
  ) then
    select membership.* into v_membership
    from public.client_portal_memberships as membership
    join public.clients as client
      on client.id = membership.client_id
     and client.organization_id = membership.organization_id
     and client.archived_at is null
    join public.client_contacts as contact
      on contact.id = membership.client_contact_id
     and contact.client_id = membership.client_id
     and contact.organization_id = membership.organization_id
     and contact.active = true
    where membership.user_id = v_access.id
      and membership.organization_id = v_access.organization_id
      and membership.active = true;
    if not found then
      raise exception using errcode = '42501', message = 'An active Client membership is required.';
    end if;
  end if;

  return query select
    v_access.id,
    v_access.organization_id,
    v_access.role,
    v_membership.client_id,
    v_membership.client_contact_id;
end;
$$;

revoke all on function private.client_placement_actor(uuid)
  from public, anon, authenticated;

create or replace function private.client_placement_workspace_json(
  p_organization_id uuid,
  p_viewer_role public.platform_role,
  p_actor_user_id uuid,
  p_actor_client_id uuid,
  p_hiring_request_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  with request_scope as (
    select request.*, client.company_name, client.lifecycle_stage, client.sales_owner_id
    from public.hiring_requests as request
    join public.clients as client
      on client.id = request.client_id
     and client.organization_id = request.organization_id
     and client.archived_at is null
    where request.id = p_hiring_request_id
      and request.organization_id = p_organization_id
      and (
        p_viewer_role in (
          'admin'::public.platform_role,
          'sales_management'::public.platform_role,
          'talent_management'::public.platform_role
        )
        or (p_viewer_role = 'sales'::public.platform_role and client.sales_owner_id = p_actor_user_id)
        or (
          p_viewer_role in ('client_admin'::public.platform_role, 'client_reviewer'::public.platform_role)
          and client.id = p_actor_client_id
        )
      )
  ), placement_counts as (
    select count(*)::integer as filled_seats
    from public.placements as placement
    join request_scope as request
      on request.id = placement.hiring_request_id
     and request.client_id = placement.client_id
     and request.organization_id = placement.organization_id
    where placement.status in ('placement_confirmed', 'onboarding', 'active')
      and placement.end_date is null
  )
  select jsonb_build_object(
    'generatedAt', statement_timestamp(),
    'viewerRole', p_viewer_role::text,
    'request', (
      select jsonb_build_object(
        'hiringRequestId', request.id,
        'clientId', request.client_id,
        'companyName', request.company_name,
        'title', request.title,
        'status', request.status,
        'seats', request.number_of_virtual_assistants,
        'filledSeats', count.filled_seats,
        'updatedAt', request.updated_at
      )
      from request_scope as request
      cross join placement_counts as count
    ),
    'permissions', jsonb_build_object(
      'scheduleInterview', p_viewer_role in (
        'admin'::public.platform_role,
        'sales_management'::public.platform_role,
        'sales'::public.platform_role
      ),
      'finalDecision', p_viewer_role = 'client_admin'::public.platform_role,
      'prepareHandoff', p_viewer_role in (
        'admin'::public.platform_role,
        'sales_management'::public.platform_role,
        'sales'::public.platform_role
      ),
      'confirmPlacement', p_viewer_role in (
        'admin'::public.platform_role,
        'talent_management'::public.platform_role
      ),
      'manageOnboarding', p_viewer_role in (
        'admin'::public.platform_role,
        'talent_management'::public.platform_role
      )
    ),
    'candidates', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'shortlistItemId', item.id,
          'shortlistId', item.shortlist_id,
          'clientResponse', item.client_response,
          'workflowState', item.workflow_state,
          'updatedAt', item.updated_at,
          'applicant', jsonb_strip_nulls(jsonb_build_object(
            'applicantId', applicant.id,
            'fullName', applicant.full_name,
            'preferredName', applicant.preferred_name,
            'email', case when p_viewer_role in (
              'admin'::public.platform_role,
              'sales_management'::public.platform_role,
              'sales'::public.platform_role,
              'talent_management'::public.platform_role
            ) then applicant.email end
          )),
          'interviews', coalesce((
            select jsonb_agg(
              jsonb_strip_nulls(jsonb_build_object(
                'interviewId', interview.id,
                'roundNumber', interview.round_number,
                'status', interview.status,
                'startsAt', interview.starts_at,
                'endsAt', interview.ends_at,
                'timezone', interview.timezone,
                'outcome', case when p_viewer_role in (
                  'admin'::public.platform_role,
                  'sales_management'::public.platform_role,
                  'sales'::public.platform_role,
                  'talent_management'::public.platform_role
                ) then interview.outcome end,
                'notes', case when p_viewer_role in (
                  'admin'::public.platform_role,
                  'sales_management'::public.platform_role,
                  'sales'::public.platform_role,
                  'talent_management'::public.platform_role
                ) then interview.private_notes end,
                'calendar', jsonb_build_object(
                  'status', case
                    when p_viewer_role in ('client_admin'::public.platform_role, 'client_reviewer'::public.platform_role)
                      then case when interview.calendar_sync_status = 'synced' then 'synced' else 'pending' end
                    else interview.calendar_sync_status
                  end,
                  'needsCreateRetry', case
                    when p_viewer_role in ('client_admin'::public.platform_role, 'client_reviewer'::public.platform_role)
                      then false
                    else interview.microsoft_event_id is null
                      and interview.calendar_sync_action = 'create'
                      and interview.calendar_sync_status in ('pending', 'sync_failed', 'connection_required')
                  end,
                  'joinUrl', case when interview.calendar_sync_status = 'synced'
                    then interview.microsoft_join_url end
                ),
                'updatedAt', interview.updated_at
              )) order by interview.round_number, interview.created_at, interview.id
            )
            from public.client_candidate_interviews as interview
            where interview.organization_id = item.organization_id
              and interview.shortlist_item_id = item.id
          ), '[]'::jsonb),
          'decision', (
            select jsonb_build_object(
              'decisionId', decision.id,
              'decision', decision.decision,
              'createdAt', decision.created_at
            )
            from public.client_candidate_decisions as decision
            where decision.organization_id = item.organization_id
              and decision.shortlist_item_id = item.id
          )
        ) order by shortlist.round_number, item.added_at, item.id
      )
      from request_scope as request
      join public.client_shortlists as shortlist
        on shortlist.organization_id = request.organization_id
       and shortlist.hiring_request_id = request.id
       and shortlist.client_id = request.client_id
       and shortlist.status = 'sent'
      join public.client_shortlist_items as item
        on item.organization_id = shortlist.organization_id
       and item.shortlist_id = shortlist.id
       and (
         item.removed_at is null
         or item.workflow_state in ('passed', 'released')
       )
      join public.applicants as applicant
        on applicant.id = item.applicant_id
       and applicant.organization_id = item.organization_id
    ), '[]'::jsonb),
    'handoffs', case when p_viewer_role in (
      'admin'::public.platform_role,
      'sales_management'::public.platform_role,
      'sales'::public.platform_role,
      'talent_management'::public.platform_role
    ) then coalesce((
      select jsonb_agg(jsonb_build_object(
        'handoffId', handoff.id,
        'decisionId', handoff.decision_id,
        'shortlistItemId', handoff.shortlist_item_id,
        'applicantId', handoff.applicant_id,
        'status', handoff.status,
        'startDate', handoff.start_date,
        'scheduleSummary', handoff.schedule_summary,
        'rateType', handoff.rate_type,
        'clientRate', handoff.client_rate,
        'talentRate', handoff.talent_rate,
        'placementId', handoff.placement_id,
        'updatedAt', handoff.updated_at
      ) order by handoff.created_at, handoff.id)
      from request_scope as request
      join public.client_placement_handoffs as handoff
        on handoff.organization_id = request.organization_id
       and handoff.hiring_request_id = request.id
    ), '[]'::jsonb) else '[]'::jsonb end,
    'placements', coalesce((
      select jsonb_agg(jsonb_build_object(
        'placementId', placement.id,
        'applicantId', placement.applicant_id,
        'status', placement.status,
        'startDate', placement.start_date,
        'scheduleSummary', placement.schedule_summary,
        'updatedAt', placement.updated_at,
        'onboardingItems', case when p_viewer_role in (
          'admin'::public.platform_role,
          'talent_management'::public.platform_role
        ) then coalesce((
          select jsonb_agg(jsonb_build_object(
            'onboardingItemId', item.id,
            'itemKey', item.item_key,
            'title', item.title,
            'required', item.required,
            'status', item.status,
            'updatedAt', item.updated_at
          ) order by item.item_key, item.id)
          from public.placement_onboarding_items as item
          where item.organization_id = placement.organization_id
            and item.placement_id = placement.id
        ), '[]'::jsonb) else '[]'::jsonb end
      ) order by placement.created_at, placement.id)
      from request_scope as request
      join public.placements as placement
        on placement.organization_id = request.organization_id
       and placement.hiring_request_id = request.id
       and placement.client_id = request.client_id
    ), '[]'::jsonb)
  )
  where exists (select 1 from request_scope);
$$;

revoke all on function private.client_placement_workspace_json(
  uuid, public.platform_role, uuid, uuid, uuid
) from public, anon, authenticated;

create or replace function public.get_client_placement_workspace(
  p_actor_user_id uuid,
  p_hiring_request_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_actor record;
  v_state jsonb;
begin
  if p_hiring_request_id is null then
    raise exception using errcode = '22023', message = 'Choose one hiring request.';
  end if;
  select * into v_actor from private.client_placement_actor(p_actor_user_id);
  v_state := private.client_placement_workspace_json(
    v_actor.organization_id, v_actor.role, v_actor.user_id,
    v_actor.client_id, p_hiring_request_id
  );
  if v_state is null then
    raise exception using errcode = '42501', message = 'This hiring request is not available to your account.';
  end if;
  return v_state;
end;
$$;

revoke all on function public.get_client_placement_workspace(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.get_client_placement_workspace(uuid, uuid)
  to service_role;

create or replace function private.client_interview_calendar_command_json(
  p_organization_id uuid,
  p_interview_id uuid,
  p_request_id uuid,
  p_action text
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  select jsonb_build_object(
    'action', p_action,
    'transactionId', coalesce(interview.calendar_transaction_id, p_request_id),
    'interviewId', interview.id,
    'expectedUpdatedAt', interview.updated_at,
    'eventId', interview.microsoft_event_id,
    'joinUrl', interview.microsoft_join_url,
    'organizerId', interview.microsoft_organizer_snapshot,
    'applicantName', interview.applicant_name_snapshot,
    'startsAt', interview.starts_at,
    'endsAt', interview.ends_at,
    'attendees', jsonb_build_array(
      jsonb_build_object('name', interview.applicant_name_snapshot, 'email', interview.applicant_email_snapshot),
      jsonb_build_object('name', interview.client_contact_name_snapshot, 'email', interview.client_contact_email_snapshot),
      jsonb_build_object('name', interview.sales_owner_name_snapshot, 'email', interview.sales_owner_email_snapshot)
    )
  )
  from public.client_candidate_interviews as interview
  where interview.id = p_interview_id
    and interview.organization_id = p_organization_id;
$$;

revoke all on function private.client_interview_calendar_command_json(uuid, uuid, uuid, text)
  from public, anon, authenticated;

create or replace function public.change_client_placement_workflow(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_hiring_request_id uuid,
  p_action text,
  p_expected_updated_at timestamptz,
  p_entity_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $$
declare
  v_actor record;
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_fingerprint text;
  v_existing public.client_placement_operations%rowtype;
  v_request public.hiring_requests%rowtype;
  v_client public.clients%rowtype;
  v_shortlist public.client_shortlists%rowtype;
  v_item public.client_shortlist_items%rowtype;
  v_applicant public.applicants%rowtype;
  v_interview public.client_candidate_interviews%rowtype;
  v_decision public.client_candidate_decisions%rowtype;
  v_handoff public.client_placement_handoffs%rowtype;
  v_placement public.placements%rowtype;
  v_onboarding public.placement_onboarding_items%rowtype;
  v_contact public.client_contacts%rowtype;
  v_owner public.platform_users%rowtype;
  v_owner_profile public.employee_profiles%rowtype;
  v_calendar_action text;
  v_calendar_command jsonb;
  v_round integer;
  v_status text;
  v_outcome text;
  v_decision_value text;
  v_duration integer;
  v_starts_at timestamptz;
  v_ends_at timestamptz;
  v_timezone text;
  v_note text;
  v_organizer text;
  v_contact_email text;
  v_filled integer;
  v_current_count integer;
  v_release record;
  v_before jsonb;
  v_after jsonb;
  v_state jsonb;
begin
  if p_request_id is null or p_hiring_request_id is null or p_entity_id is null then
    raise exception using errcode = '22023', message = 'A request, hiring request, and workflow record are required.';
  end if;
  if p_expected_updated_at is null then
    raise exception using errcode = '22023', message = 'The current record update time is required.';
  end if;
  if jsonb_typeof(v_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'Workflow details must be a JSON object.';
  end if;
  if v_action not in (
    'schedule_interview', 'reschedule_interview', 'cancel_interview',
    'record_interview_outcome', 'retry_calendar_sync', 'final_decision',
    'prepare_handoff', 'confirm_placement', 'update_onboarding', 'activate_placement'
  ) then
    raise exception using errcode = '22023', message = 'Choose a supported Client placement action.';
  end if;

  select * into v_actor from private.client_placement_actor(p_actor_user_id);
  v_fingerprint := encode(
    digest(
      convert_to(concat_ws(
        '|', v_action, p_hiring_request_id::text, p_entity_id::text,
        p_expected_updated_at::text, v_payload::text
      ), 'utf8'),
      'sha256'
    ),
    'hex'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('client-placement-operation:' || p_request_id::text, 0)
  );
  select operation.* into v_existing
  from public.client_placement_operations as operation
  where operation.operation_request_id = p_request_id
    and operation.phase = 'mutation';
  if v_existing.operation_request_id is not null then
    if v_existing.organization_id is distinct from v_actor.organization_id
      or v_existing.actor_user_id is distinct from v_actor.user_id
      or v_existing.action is distinct from v_action
      or v_existing.hiring_request_id is distinct from p_hiring_request_id
      or v_existing.request_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = '23505', message = 'This request id has already been used for another placement action.';
    end if;
    v_state := private.client_placement_workspace_json(
      v_actor.organization_id, v_actor.role, v_actor.user_id,
      v_actor.client_id, p_hiring_request_id
    );
    if v_state is null then
      raise exception using errcode = '42501', message = 'This hiring request is not available to your account.';
    end if;
    if v_existing.interview_id is not null then
      select * into v_interview
      from public.client_candidate_interviews
      where id = v_existing.interview_id
        and organization_id = v_actor.organization_id;
      if v_interview.id is not null
        and v_interview.calendar_sync_status = 'pending'
        and v_interview.calendar_sync_action is not null then
        v_calendar_command := private.client_interview_calendar_command_json(
          v_actor.organization_id, v_interview.id, p_request_id,
          v_interview.calendar_sync_action
        );
      end if;
    end if;
    return jsonb_build_object('state', v_state, 'calendarCommand', v_calendar_command);
  end if;

  -- Reuse the shortlist lock namespace so shortlist responses, final decisions,
  -- and placement confirmation cannot race one another.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('client-shortlist-request:' || p_hiring_request_id::text, 0)
  );
  select request.* into v_request
  from public.hiring_requests as request
  where request.id = p_hiring_request_id
    and request.organization_id = v_actor.organization_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'This hiring request is not available to your account.';
  end if;
  select client.* into v_client
  from public.clients as client
  where client.id = v_request.client_id
    and client.organization_id = v_actor.organization_id
    and client.archived_at is null
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'This Client is not available to your account.';
  end if;
  if v_actor.role = 'sales'::public.platform_role and v_client.sales_owner_id is distinct from v_actor.user_id then
    raise exception using errcode = '42501', message = 'Sales may only manage their assigned Clients.';
  end if;
  if v_actor.role in ('client_admin'::public.platform_role, 'client_reviewer'::public.platform_role)
    and v_client.id is distinct from v_actor.client_id then
    raise exception using errcode = '42501', message = 'This hiring request does not belong to your Client account.';
  end if;

  if v_action = 'schedule_interview' then
    if v_actor.role not in (
      'admin'::public.platform_role,
      'sales_management'::public.platform_role,
      'sales'::public.platform_role
    ) then
      raise exception using errcode = '42501', message = 'Only assigned Sales or an Administrator may schedule a Client interview.';
    end if;
    if v_request.status not in ('client_review', 'interviewing', 'partially_filled') then
      raise exception using errcode = 'P0001', message = 'This hiring request is not accepting Client interviews.';
    end if;
    if exists (select 1 from jsonb_object_keys(v_payload) as key where key not in (
      'startsAt', 'durationMinutes', 'timezone', 'calendarOrganizer'
    )) or not (v_payload ? 'startsAt' and v_payload ? 'durationMinutes' and v_payload ? 'timezone') then
      raise exception using errcode = '22023', message = 'Client interview scheduling details are invalid.';
    end if;
    v_starts_at := nullif(v_payload ->> 'startsAt', '')::timestamptz;
    v_duration := nullif(v_payload ->> 'durationMinutes', '')::integer;
    v_timezone := nullif(btrim(coalesce(v_payload ->> 'timezone', '')), '');
    v_organizer := nullif(btrim(coalesce(v_payload ->> 'calendarOrganizer', '')), '');
    if v_starts_at is null or v_starts_at <= pg_catalog.clock_timestamp() + interval '1 minute'
      or v_duration is null or v_duration < 15 or v_duration > 240 or mod(v_duration, 5) <> 0
      or v_timezone is null or char_length(v_timezone) > 100
      or (v_organizer is not null and char_length(v_organizer) > 1024) then
      raise exception using errcode = '22023', message = 'Choose a valid future interview time, duration, and time zone.';
    end if;
    v_ends_at := v_starts_at + make_interval(mins => v_duration);

    select item.* into v_item
    from public.client_shortlist_items as item
    join public.client_shortlists as shortlist
      on shortlist.id = item.shortlist_id
     and shortlist.organization_id = item.organization_id
    where item.id = p_entity_id
      and item.organization_id = v_actor.organization_id
      and item.removed_at is null
      and item.workflow_state = 'active'
      and item.client_response = 'request_interview'
      and shortlist.hiring_request_id = v_request.id
      and shortlist.client_id = v_client.id
      and shortlist.status = 'sent'
    for update of item;
    if not found then
      raise exception using errcode = 'P0001', message = 'This candidate is not awaiting a Client interview.';
    end if;
    if v_item.updated_at is distinct from p_expected_updated_at then
      raise exception using errcode = 'P0001', message = 'This shortlisted candidate changed after it was opened.';
    end if;
    select shortlist.* into v_shortlist
    from public.client_shortlists as shortlist
    where shortlist.id = v_item.shortlist_id
      and shortlist.organization_id = v_actor.organization_id;
    if exists (
      select 1 from public.client_candidate_decisions as decision
      where decision.shortlist_item_id = v_item.id
        and decision.organization_id = v_actor.organization_id
    ) then
      raise exception using errcode = 'P0001', message = 'A final decision has already been recorded for this candidate.';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('client-shortlist-applicant:' || v_item.applicant_id::text, 0)
    );
    select applicant.* into v_applicant
    from public.applicants as applicant
    where applicant.id = v_item.applicant_id
      and applicant.organization_id = v_actor.organization_id
      and applicant.archived_at is null
      and applicant.sales_owner_id = v_client.sales_owner_id
      and applicant.status in ('interviewing'::public.applicant_status, 'client_review'::public.applicant_status)
    for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'This candidate is no longer available for a Client interview.';
    end if;

    select owner.* into v_owner
    from public.platform_users as owner
    where owner.id = v_client.sales_owner_id
      and owner.organization_id = v_actor.organization_id
      and owner.active = true
      and owner.must_change_password = false
      and owner.role = 'sales'::public.platform_role;
    if not found then
      raise exception using errcode = 'P0001', message = 'The Client needs an active Sales owner before scheduling.';
    end if;
    select profile.* into v_owner_profile
    from public.employee_profiles as profile
    where profile.user_id = v_owner.id
      and profile.organization_id = v_actor.organization_id;
    if not found then
      raise exception using errcode = 'P0001', message = 'The Sales owner needs a complete employee profile before scheduling.';
    end if;

    select contact.* into v_contact
    from public.client_contacts as contact
    join public.client_portal_memberships as membership
      on membership.client_contact_id = contact.id
     and membership.client_id = contact.client_id
     and membership.organization_id = contact.organization_id
     and membership.active = true
    join public.platform_users as client_access
      on client_access.id = membership.user_id
     and client_access.organization_id = membership.organization_id
     and client_access.active = true
     and client_access.must_change_password = false
     and client_access.role in ('client_admin'::public.platform_role, 'client_reviewer'::public.platform_role)
    where contact.organization_id = v_actor.organization_id
      and contact.client_id = v_client.id
      and contact.active = true
      and contact.portal_access_status = 'active'
      and nullif(btrim(contact.portal_login_email), '') is not null
    order by (client_access.role = 'client_admin'::public.platform_role) desc,
      contact.created_at, contact.id
    limit 1;
    if not found then
      raise exception using errcode = 'P0001', message = 'The Client needs an active Client Administrator or Reviewer portal account before scheduling.';
    end if;
    v_contact_email := nullif(btrim(v_contact.portal_login_email), '');
    if lower(btrim(v_applicant.email)) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      or lower(btrim(v_contact_email)) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      or lower(btrim(v_owner_profile.email)) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
      raise exception using errcode = 'P0001', message = 'Talent, Client, and Sales owner email addresses must be valid before scheduling.';
    end if;

    select coalesce(max(interview.round_number), 0) + 1 into v_round
    from public.client_candidate_interviews as interview
    where interview.organization_id = v_actor.organization_id
      and interview.hiring_request_id = v_request.id
      and interview.applicant_id = v_applicant.id;

    insert into public.client_candidate_interviews (
      organization_id, client_id, hiring_request_id, shortlist_id,
      shortlist_item_id, applicant_id, sales_owner_id, client_contact_id,
      round_number, starts_at, ends_at, timezone,
      applicant_name_snapshot, applicant_email_snapshot,
      client_contact_name_snapshot, client_contact_email_snapshot,
      sales_owner_name_snapshot, sales_owner_email_snapshot,
      calendar_sync_status, calendar_sync_action, calendar_transaction_id,
      microsoft_organizer_snapshot, calendar_sync_started_at, created_by_user_id
    ) values (
      v_actor.organization_id, v_client.id, v_request.id, v_shortlist.id,
      v_item.id, v_applicant.id, v_owner.id, v_contact.id,
      v_round, v_starts_at, v_ends_at, v_timezone,
      v_applicant.full_name, lower(btrim(v_applicant.email)),
      v_contact.full_name, lower(btrim(v_contact_email)),
      coalesce(nullif(btrim(v_owner.display_name), ''), v_owner_profile.full_name), lower(btrim(v_owner_profile.email)),
      'pending', 'create', p_request_id, v_organizer,
      pg_catalog.clock_timestamp(), v_actor.user_id
    ) returning * into v_interview;
    if v_request.status in ('client_review', 'selection_pending') then
      update public.hiring_requests set status = 'interviewing' where id = v_request.id;
    end if;
    v_calendar_action := 'create';
    v_before := null;
    v_after := jsonb_build_object('interviewId', v_interview.id, 'roundNumber', v_interview.round_number, 'status', v_interview.status);

  elsif v_action in (
    'reschedule_interview', 'cancel_interview',
    'record_interview_outcome', 'retry_calendar_sync'
  ) then
    if v_actor.role not in (
      'admin'::public.platform_role,
      'sales_management'::public.platform_role,
      'sales'::public.platform_role
    ) then
      raise exception using errcode = '42501', message = 'Only assigned Sales or an Administrator may manage Client interviews.';
    end if;
    if v_request.status in ('draft', 'discovery', 'open', 'sourcing', 'shortlisting', 'on_hold', 'cancelled', 'filled') then
      raise exception using errcode = 'P0001', message = 'This hiring request is not accepting interview changes.';
    end if;
    select interview.* into v_interview
    from public.client_candidate_interviews as interview
    where interview.id = p_entity_id
      and interview.organization_id = v_actor.organization_id
      and interview.hiring_request_id = v_request.id
      and interview.client_id = v_client.id
    for update;
    if not found then
      raise exception using errcode = '42501', message = 'This Client interview is not available to your account.';
    end if;
    if v_interview.updated_at is distinct from p_expected_updated_at then
      raise exception using errcode = 'P0001', message = 'This Client interview changed after it was opened.';
    end if;
    if v_action in ('reschedule_interview', 'cancel_interview')
      and v_interview.microsoft_event_id is null
      and v_interview.calendar_sync_action = 'create'
      and v_interview.calendar_sync_status in ('pending', 'sync_failed', 'connection_required') then
      raise exception using
        errcode = 'P0001',
        message = 'Retry the original calendar creation before rescheduling or cancelling this interview.';
    end if;
    if v_interview.calendar_sync_status = 'pending'
      and v_interview.calendar_sync_started_at is not null
      and v_interview.calendar_sync_started_at > pg_catalog.clock_timestamp() - interval '90 seconds'
      and v_action <> 'retry_calendar_sync' then
      raise exception using errcode = 'P0001', message = 'Calendar synchronization is still in progress.';
    end if;
    v_before := jsonb_build_object(
      'interviewId', v_interview.id, 'status', v_interview.status,
      'startsAt', v_interview.starts_at, 'outcome', v_interview.outcome
    );

    if v_action = 'reschedule_interview' then
      if v_interview.status <> 'scheduled'
        or exists (select 1 from jsonb_object_keys(v_payload) as key where key not in (
          'startsAt', 'durationMinutes', 'timezone', 'calendarOrganizer'
        )) or not (v_payload ? 'startsAt' and v_payload ? 'durationMinutes' and v_payload ? 'timezone') then
        raise exception using errcode = '22023', message = 'This interview cannot be rescheduled with those details.';
      end if;
      v_starts_at := nullif(v_payload ->> 'startsAt', '')::timestamptz;
      v_duration := nullif(v_payload ->> 'durationMinutes', '')::integer;
      v_timezone := nullif(btrim(coalesce(v_payload ->> 'timezone', '')), '');
      v_organizer := nullif(btrim(coalesce(v_payload ->> 'calendarOrganizer', '')), '');
      if v_starts_at is null or v_starts_at <= pg_catalog.clock_timestamp() + interval '1 minute'
        or v_duration is null or v_duration < 15 or v_duration > 240 or mod(v_duration, 5) <> 0
        or v_timezone is null or char_length(v_timezone) > 100
        or (v_organizer is not null and char_length(v_organizer) > 1024) then
        raise exception using errcode = '22023', message = 'Choose a valid future interview time, duration, and time zone.';
      end if;
      update public.client_candidate_interviews set
        starts_at = v_starts_at,
        ends_at = v_starts_at + make_interval(mins => v_duration),
        timezone = v_timezone,
        calendar_sync_status = 'pending',
        calendar_sync_action = case when microsoft_event_id is null then 'create' else 'update' end,
        calendar_transaction_id = case when microsoft_event_id is null then p_request_id else calendar_transaction_id end,
        microsoft_organizer_snapshot = coalesce(v_organizer, microsoft_organizer_snapshot),
        microsoft_last_error_code = null,
        calendar_sync_started_at = pg_catalog.clock_timestamp()
      where id = v_interview.id
      returning * into v_interview;
      v_calendar_action := v_interview.calendar_sync_action;

    elsif v_action = 'cancel_interview' then
      if v_interview.status <> 'scheduled'
        or exists (select 1 from jsonb_object_keys(v_payload) as key where key <> 'note')
        or not (v_payload ? 'note') then
        raise exception using errcode = '22023', message = 'This interview cannot be cancelled with those details.';
      end if;
      v_note := nullif(btrim(coalesce(v_payload ->> 'note', '')), '');
      if v_note is null or char_length(v_note) > 1000 then
        raise exception using errcode = '22023', message = 'A cancellation note is required.';
      end if;
      update public.client_candidate_interviews set
        status = 'cancelled', outcome = null, private_notes = v_note,
        calendar_sync_status = case when microsoft_event_id is null then 'not_applicable' else 'pending' end,
        calendar_sync_action = case when microsoft_event_id is null then null else 'cancel' end,
        calendar_transaction_id = case when microsoft_event_id is null then calendar_transaction_id else p_request_id end,
        microsoft_last_error_code = null,
        calendar_sync_started_at = case when microsoft_event_id is null then null else pg_catalog.clock_timestamp() end
      where id = v_interview.id
      returning * into v_interview;
      v_calendar_action := v_interview.calendar_sync_action;

    elsif v_action = 'record_interview_outcome' then
      if v_interview.status <> 'scheduled'
        or exists (select 1 from jsonb_object_keys(v_payload) as key where key not in ('status', 'outcome', 'note'))
        or not (v_payload ? 'status' and v_payload ? 'outcome' and v_payload ? 'note') then
        raise exception using errcode = '22023', message = 'This interview outcome is invalid.';
      end if;
      v_status := lower(btrim(coalesce(v_payload ->> 'status', '')));
      v_outcome := nullif(lower(btrim(coalesce(v_payload ->> 'outcome', ''))), '');
      v_note := nullif(btrim(coalesce(v_payload ->> 'note', '')), '');
      if v_status not in ('completed', 'no_show')
        or (v_status = 'completed' and v_outcome not in ('advance', 'follow_up', 'not_selected'))
        or (v_status = 'no_show' and v_outcome is not null)
        or v_note is null or char_length(v_note) > 4000
        or pg_catalog.clock_timestamp() < v_interview.starts_at then
        raise exception using errcode = '22023', message = 'Choose a valid completed or no-show interview outcome.';
      end if;
      update public.client_candidate_interviews set
        status = v_status, outcome = v_outcome, private_notes = v_note,
        calendar_sync_action = null, calendar_sync_started_at = null
      where id = v_interview.id
      returning * into v_interview;

    else
      if v_payload <> '{}'::jsonb
        or not (
          v_interview.calendar_sync_status in ('connection_required', 'sync_failed')
          or (
            v_interview.calendar_sync_status = 'pending'
            and v_interview.microsoft_event_id is null
            and v_interview.calendar_sync_action = 'create'
          )
        )
        or v_interview.calendar_sync_action is null then
        raise exception using errcode = 'P0001', message = 'This Client interview is not awaiting a calendar retry.';
      end if;
      update public.client_candidate_interviews set
        calendar_sync_status = 'pending',
        calendar_transaction_id = case
          when calendar_sync_action = 'create' then coalesce(calendar_transaction_id, p_request_id)
          else calendar_transaction_id
        end,
        microsoft_last_error_code = null,
        calendar_sync_started_at = pg_catalog.clock_timestamp()
      where id = v_interview.id
      returning * into v_interview;
      v_calendar_action := v_interview.calendar_sync_action;
    end if;
    v_after := jsonb_build_object(
      'interviewId', v_interview.id, 'status', v_interview.status,
      'startsAt', v_interview.starts_at, 'outcome', v_interview.outcome
    );

  elsif v_action = 'final_decision' then
    if v_actor.role <> 'client_admin'::public.platform_role then
      raise exception using errcode = '42501', message = 'Only a Client Administrator may make the final candidate selection.';
    end if;
    if v_request.status not in ('client_review', 'interviewing', 'selection_pending', 'partially_filled') then
      raise exception using errcode = 'P0001', message = 'This hiring request is not accepting final Client decisions.';
    end if;
    if exists (select 1 from jsonb_object_keys(v_payload) as key where key <> 'decision')
      or not (v_payload ? 'decision') then
      raise exception using errcode = '22023', message = 'Choose one final Client decision.';
    end if;
    v_decision_value := lower(btrim(coalesce(v_payload ->> 'decision', '')));
    if v_decision_value not in ('selected', 'passed') then
      raise exception using errcode = '22023', message = 'Choose Selected or Passed.';
    end if;
    select item.* into v_item
    from public.client_shortlist_items as item
    join public.client_shortlists as shortlist
      on shortlist.id = item.shortlist_id
     and shortlist.organization_id = item.organization_id
    where item.id = p_entity_id
      and item.organization_id = v_actor.organization_id
      and item.removed_at is null
      and item.workflow_state = 'active'
      and item.client_response in ('request_interview', 'interested')
      and shortlist.hiring_request_id = v_request.id
      and shortlist.client_id = v_client.id
      and shortlist.status = 'sent'
    for update of item;
    if not found then
      raise exception using errcode = 'P0001', message = 'This candidate is not awaiting a final Client decision.';
    end if;
    if v_item.updated_at is distinct from p_expected_updated_at then
      raise exception using errcode = 'P0001', message = 'This shortlisted candidate changed after it was opened.';
    end if;
    select shortlist.* into v_shortlist
    from public.client_shortlists as shortlist
    where shortlist.id = v_item.shortlist_id
      and shortlist.organization_id = v_actor.organization_id;
    if exists (
      select 1 from public.client_candidate_decisions as decision
      where decision.shortlist_item_id = v_item.id
    ) then
      raise exception using errcode = 'P0001', message = 'A final decision has already been recorded for this candidate.';
    end if;
    if exists (
      select 1
      from public.client_candidate_interviews as interview
      where interview.organization_id = v_actor.organization_id
        and interview.shortlist_item_id = v_item.id
        and (
          interview.status = 'scheduled'
          or (
            interview.status = 'cancelled'
            and interview.calendar_sync_action = 'cancel'
            and interview.calendar_sync_status in ('pending', 'sync_failed', 'connection_required')
          )
        )
    ) then
      raise exception using
        errcode = 'P0001',
        message = 'Complete the interview or finish cancelling its calendar event before recording a final decision.';
    end if;
    if v_decision_value = 'selected' and v_item.client_response = 'request_interview' and not exists (
      select 1 from public.client_candidate_interviews as interview
      where interview.organization_id = v_actor.organization_id
        and interview.shortlist_item_id = v_item.id
        and interview.status = 'completed'
        and interview.outcome in ('advance', 'follow_up')
    ) then
      raise exception using errcode = 'P0001', message = 'Complete a Client interview before selecting this candidate.';
    end if;
    if v_decision_value = 'selected' and (
      select count(*)
      from public.client_candidate_decisions as selected_decision
      where selected_decision.organization_id = v_actor.organization_id
        and selected_decision.hiring_request_id = v_request.id
        and selected_decision.decision = 'selected'
    ) >= v_request.number_of_virtual_assistants then
      raise exception using errcode = 'P0001', message = 'Every approved seat for this hiring request already has a final selection.';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('client-shortlist-applicant:' || v_item.applicant_id::text, 0)
    );
    select applicant.* into v_applicant
    from public.applicants as applicant
    where applicant.id = v_item.applicant_id
      and applicant.organization_id = v_actor.organization_id
      and applicant.archived_at is null
      and applicant.sales_owner_id = v_client.sales_owner_id
      and applicant.status in (
        'interviewing'::public.applicant_status,
        'client_review'::public.applicant_status
      )
    for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'This candidate is no longer available.';
    end if;

    insert into public.client_candidate_decisions (
      organization_id, client_id, hiring_request_id, shortlist_id,
      shortlist_item_id, applicant_id, decided_by_user_id, decision
    ) values (
      v_actor.organization_id, v_client.id, v_request.id, v_shortlist.id,
      v_item.id, v_applicant.id, v_actor.user_id, v_decision_value
    ) returning * into v_decision;
    update public.client_shortlist_items
    set workflow_state = case when v_decision_value = 'selected' then 'selected' else 'passed' end,
        removed_by_user_id = case when v_decision_value = 'passed' then v_actor.user_id end,
        removed_at = case when v_decision_value = 'passed' then pg_catalog.clock_timestamp() end
    where id = v_item.id;
    if v_decision_value = 'passed' then
      update public.applicants
      set status = 'bench_ready'::public.applicant_status
      where id = v_applicant.id
        and status in (
          'shortlisted'::public.applicant_status,
          'client_review'::public.applicant_status,
          'interviewing'::public.applicant_status
        );
    else
      update public.hiring_requests
      set status = 'selection_pending'
      where id = v_request.id
        and status in ('client_review', 'interviewing', 'partially_filled');
    end if;
    v_before := null;
    v_after := jsonb_build_object('decisionId', v_decision.id, 'decision', v_decision.decision);

  elsif v_action = 'prepare_handoff' then
    if v_actor.role not in (
      'admin'::public.platform_role,
      'sales_management'::public.platform_role,
      'sales'::public.platform_role
    ) then
      raise exception using errcode = '42501', message = 'Only assigned Sales or an Administrator may prepare a placement handoff.';
    end if;
    if v_request.status not in ('selection_pending', 'partially_filled') then
      raise exception using errcode = 'P0001', message = 'This hiring request is not ready for a placement handoff.';
    end if;
    if exists (select 1 from jsonb_object_keys(v_payload) as key where key not in (
      'startDate', 'scheduleSummary', 'rateType', 'clientRate', 'talentRate'
    )) or not (
      v_payload ? 'startDate' and v_payload ? 'scheduleSummary'
      and v_payload ? 'rateType' and v_payload ? 'clientRate' and v_payload ? 'talentRate'
    ) then
      raise exception using errcode = '22023', message = 'Placement handoff details are invalid.';
    end if;
    select decision.* into v_decision
    from public.client_candidate_decisions as decision
    where decision.id = p_entity_id
      and decision.organization_id = v_actor.organization_id
      and decision.hiring_request_id = v_request.id
      and decision.client_id = v_client.id
      and decision.decision = 'selected'
    for share;
    if not found then
      raise exception using errcode = 'P0001', message = 'A selected Client decision is required for handoff.';
    end if;
    if v_decision.created_at is distinct from p_expected_updated_at then
      raise exception using errcode = 'P0001', message = 'This Client decision changed after it was opened.';
    end if;
    if exists (
      select 1 from public.client_placement_handoffs as handoff
      where handoff.decision_id = v_decision.id
    ) then
      raise exception using errcode = 'P0001', message = 'A placement handoff already exists for this selection.';
    end if;
    if nullif(v_payload ->> 'startDate', '')::date < current_date
      or char_length(btrim(coalesce(v_payload ->> 'scheduleSummary', ''))) not between 2 and 1000
      or char_length(btrim(coalesce(v_payload ->> 'rateType', ''))) not between 1 and 60
      or nullif(v_payload ->> 'clientRate', '')::numeric <= 0
      or nullif(v_payload ->> 'talentRate', '')::numeric <= 0 then
      raise exception using errcode = '22023', message = 'Choose a current or future start date, schedule, rate type, and positive rates.';
    end if;
    insert into public.client_placement_handoffs (
      organization_id, client_id, hiring_request_id, shortlist_item_id,
      applicant_id, decision_id, prepared_by_user_id, start_date,
      schedule_summary, rate_type, client_rate, talent_rate
    ) values (
      v_actor.organization_id, v_client.id, v_request.id, v_decision.shortlist_item_id,
      v_decision.applicant_id, v_decision.id, v_actor.user_id,
      (v_payload ->> 'startDate')::date,
      btrim(v_payload ->> 'scheduleSummary'), btrim(v_payload ->> 'rateType'),
      (v_payload ->> 'clientRate')::numeric, (v_payload ->> 'talentRate')::numeric
    ) returning * into v_handoff;
    update public.hiring_requests
    set status = 'placement_pending'
    where id = v_request.id
      and status in ('selection_pending', 'partially_filled');
    update public.clients
    set lifecycle_stage = 'matching'
    where id = v_client.id
      and lifecycle_stage in ('qualified', 'matching');
    v_before := null;
    v_after := jsonb_build_object(
      'handoffId', v_handoff.id, 'decisionId', v_decision.id,
      'status', v_handoff.status, 'startDate', v_handoff.start_date
    );

  elsif v_action = 'confirm_placement' then
    if v_actor.role not in ('admin'::public.platform_role, 'talent_management'::public.platform_role) then
      raise exception using errcode = '42501', message = 'Only Admin or Talent Management may confirm a placement.';
    end if;
    if v_request.status not in ('placement_pending', 'partially_filled') then
      raise exception using errcode = 'P0001', message = 'This hiring request is not ready for placement confirmation.';
    end if;
    if v_payload <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'Placement confirmation does not accept editable identifiers.';
    end if;
    select handoff.* into v_handoff
    from public.client_placement_handoffs as handoff
    join public.client_candidate_decisions as decision
      on decision.id = handoff.decision_id
     and decision.organization_id = handoff.organization_id
     and decision.shortlist_item_id = handoff.shortlist_item_id
     and decision.applicant_id = handoff.applicant_id
     and decision.decision = 'selected'
    where handoff.id = p_entity_id
      and handoff.organization_id = v_actor.organization_id
      and handoff.hiring_request_id = v_request.id
      and handoff.client_id = v_client.id
      and handoff.status = 'prepared'
    for update of handoff;
    if not found then
      raise exception using errcode = 'P0001', message = 'This placement handoff is no longer awaiting confirmation.';
    end if;
    if v_handoff.updated_at is distinct from p_expected_updated_at then
      raise exception using errcode = 'P0001', message = 'This placement handoff changed after it was opened.';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('client-shortlist-applicant:' || v_handoff.applicant_id::text, 0)
    );
    select applicant.* into v_applicant
    from public.applicants as applicant
    where applicant.id = v_handoff.applicant_id
      and applicant.organization_id = v_actor.organization_id
      and applicant.archived_at is null
      and applicant.sales_owner_id = v_client.sales_owner_id
      and applicant.status in (
        'interviewing'::public.applicant_status,
        'client_review'::public.applicant_status
      )
    for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'This selected candidate is no longer available.';
    end if;
    select count(*)::integer into v_current_count
    from public.placements as current_placement
    where current_placement.organization_id = v_actor.organization_id
      and current_placement.applicant_id = v_applicant.id
      and current_placement.status in ('placement_confirmed', 'onboarding', 'active')
      and current_placement.end_date is null;
    if v_current_count > 0 then
      raise exception using errcode = 'P0001', message = 'This Talent profile already has a current placement.';
    end if;
    select count(*)::integer into v_filled
    from public.placements as occupied
    where occupied.organization_id = v_actor.organization_id
      and occupied.hiring_request_id = v_request.id
      and occupied.client_id = v_client.id
      and occupied.status in ('placement_confirmed', 'onboarding', 'active')
      and occupied.end_date is null;
    if v_filled >= v_request.number_of_virtual_assistants then
      raise exception using errcode = 'P0001', message = 'Every approved seat for this hiring request is already filled.';
    end if;
    if v_filled + 1 >= v_request.number_of_virtual_assistants and exists (
      select 1
      from public.client_candidate_interviews as remaining_interview
      where remaining_interview.organization_id = v_actor.organization_id
        and remaining_interview.hiring_request_id = v_request.id
        and (
          remaining_interview.status = 'scheduled'
          or (
            remaining_interview.status = 'cancelled'
            and remaining_interview.calendar_sync_action = 'cancel'
            and remaining_interview.calendar_sync_status in ('pending', 'sync_failed', 'connection_required')
          )
        )
    ) then
      raise exception using errcode = 'P0001', message = 'Complete or cancel every remaining Client interview before filling the final seat.';
    end if;

    insert into public.placements (
      organization_id, client_id, applicant_id, hiring_request_id,
      status, start_date, schedule_summary, rate_type, client_rate, virtual_assistant_rate
    ) values (
      v_actor.organization_id, v_client.id, v_applicant.id, v_request.id,
      'onboarding', v_handoff.start_date, v_handoff.schedule_summary,
      v_handoff.rate_type, v_handoff.client_rate, v_handoff.talent_rate
    ) returning * into v_placement;
    update public.client_placement_handoffs set
      status = 'confirmed', confirmed_by_user_id = v_actor.user_id,
      confirmed_at = pg_catalog.clock_timestamp(), placement_id = v_placement.id
    where id = v_handoff.id
    returning * into v_handoff;
    update public.client_shortlist_items
    set workflow_state = 'placed'
    where id = v_handoff.shortlist_item_id
      and organization_id = v_actor.organization_id;
    update public.applicants
    set status = 'onboarding'::public.applicant_status
    where id = v_applicant.id;

    insert into public.placement_onboarding_items (
      organization_id, placement_id, item_key, title, required
    ) values
      (v_actor.organization_id, v_placement.id, 'talent_start_details', 'Talent start details confirmed', true),
      (v_actor.organization_id, v_placement.id, 'client_launch_details', 'Client launch details confirmed', true),
      (v_actor.organization_id, v_placement.id, 'required_documents', 'Required placement documents confirmed', true)
    on conflict (placement_id, item_key) do nothing;

    v_filled := v_filled + 1;
    update public.hiring_requests
    set status = case
      when v_filled >= number_of_virtual_assistants then 'filled'
      else 'partially_filled'
    end
    where id = v_request.id;
    if v_filled >= v_request.number_of_virtual_assistants then
      for v_release in
        select item.id as shortlist_item_id, item.applicant_id
        from public.client_shortlists as shortlist
        join public.client_shortlist_items as item
          on item.shortlist_id = shortlist.id
         and item.organization_id = shortlist.organization_id
        where shortlist.organization_id = v_actor.organization_id
          and shortlist.hiring_request_id = v_request.id
          and shortlist.status = 'sent'
          and item.removed_at is null
          and item.workflow_state = 'active'
          and not exists (
            select 1 from public.client_candidate_decisions as decision
            where decision.shortlist_item_id = item.id
              and decision.decision = 'selected'
          )
        order by item.applicant_id, item.id
      loop
        perform pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended('client-shortlist-applicant:' || v_release.applicant_id::text, 0)
        );
        update public.client_shortlist_items
        set workflow_state = 'released',
            removed_by_user_id = v_actor.user_id,
            removed_at = pg_catalog.clock_timestamp()
        where id = v_release.shortlist_item_id
          and workflow_state = 'active';
        update public.applicants
        set status = 'bench_ready'::public.applicant_status
        where id = v_release.applicant_id
          and organization_id = v_actor.organization_id
          and status in (
            'shortlisted'::public.applicant_status,
            'client_review'::public.applicant_status,
            'interviewing'::public.applicant_status
          );
      end loop;
    end if;
    v_before := jsonb_build_object('handoffId', v_handoff.id, 'status', 'prepared');
    v_after := jsonb_build_object(
      'handoffId', v_handoff.id, 'status', v_handoff.status,
      'placementId', v_placement.id, 'placementStatus', v_placement.status
    );

  elsif v_action = 'update_onboarding' then
    if v_actor.role not in ('admin'::public.platform_role, 'talent_management'::public.platform_role) then
      raise exception using errcode = '42501', message = 'Only Admin or Talent Management may update onboarding.';
    end if;
    if exists (select 1 from jsonb_object_keys(v_payload) as key where key <> 'status')
      or not (v_payload ? 'status') then
      raise exception using errcode = '22023', message = 'Choose one onboarding status.';
    end if;
    v_status := lower(btrim(coalesce(v_payload ->> 'status', '')));
    if v_status not in ('pending', 'completed') then
      raise exception using errcode = '22023', message = 'Choose Pending or Completed.';
    end if;
    select item.* into v_onboarding
    from public.placement_onboarding_items as item
    join public.placements as placement
      on placement.id = item.placement_id
     and placement.organization_id = item.organization_id
    where item.id = p_entity_id
      and item.organization_id = v_actor.organization_id
      and placement.hiring_request_id = v_request.id
      and placement.client_id = v_client.id
      and placement.status = 'onboarding'
    for update of item;
    if not found then
      raise exception using errcode = 'P0001', message = 'This onboarding item is no longer editable.';
    end if;
    if v_onboarding.updated_at is distinct from p_expected_updated_at then
      raise exception using errcode = 'P0001', message = 'This onboarding item changed after it was opened.';
    end if;
    v_before := jsonb_build_object('onboardingItemId', v_onboarding.id, 'status', v_onboarding.status);
    update public.placement_onboarding_items set
      status = v_status,
      completed_by_user_id = case when v_status = 'completed' then v_actor.user_id end,
      completed_at = case when v_status = 'completed' then pg_catalog.clock_timestamp() end
    where id = v_onboarding.id
    returning * into v_onboarding;
    v_placement.id := v_onboarding.placement_id;
    v_after := jsonb_build_object('onboardingItemId', v_onboarding.id, 'status', v_onboarding.status);

  else
    if v_actor.role not in ('admin'::public.platform_role, 'talent_management'::public.platform_role) then
      raise exception using errcode = '42501', message = 'Only Admin or Talent Management may activate a placement.';
    end if;
    if v_client.lifecycle_stage not in ('qualified', 'matching', 'active') then
      raise exception using errcode = 'P0001', message = 'Return the Client to an active matching stage before activating this placement.';
    end if;
    if v_payload <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'Placement activation does not accept editable identifiers.';
    end if;
    select placement.* into v_placement
    from public.placements as placement
    where placement.id = p_entity_id
      and placement.organization_id = v_actor.organization_id
      and placement.hiring_request_id = v_request.id
      and placement.client_id = v_client.id
      and placement.status = 'onboarding'
      and placement.end_date is null
    for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'This placement is not awaiting activation.';
    end if;
    if v_placement.updated_at is distinct from p_expected_updated_at then
      raise exception using errcode = 'P0001', message = 'This placement changed after it was opened.';
    end if;
    if v_placement.start_date is null or v_placement.start_date > current_date then
      raise exception using errcode = 'P0001', message = 'A placement cannot activate before its start date.';
    end if;
    if exists (
      select 1 from public.placement_onboarding_items as item
      where item.organization_id = v_actor.organization_id
        and item.placement_id = v_placement.id
        and item.required = true
        and item.status <> 'completed'
    ) then
      raise exception using errcode = 'P0001', message = 'Complete every required onboarding item before activation.';
    end if;
    v_before := jsonb_build_object('placementId', v_placement.id, 'status', v_placement.status);
    update public.placements set status = 'active'
    where id = v_placement.id
    returning * into v_placement;
    update public.applicants
    set status = 'active'::public.applicant_status
    where id = v_placement.applicant_id
      and organization_id = v_actor.organization_id;
    update public.clients
    set lifecycle_stage = 'active'
    where id = v_client.id
      and lifecycle_stage in ('qualified', 'matching', 'active');
    v_after := jsonb_build_object('placementId', v_placement.id, 'status', v_placement.status);
  end if;

  insert into public.client_placement_operations (
    operation_request_id, phase, organization_id, actor_user_id, action,
    hiring_request_id, interview_id, decision_id, handoff_id, placement_id,
    request_fingerprint
  ) values (
    p_request_id, 'mutation', v_actor.organization_id, v_actor.user_id, v_action,
    v_request.id, v_interview.id, v_decision.id, v_handoff.id, v_placement.id,
    v_fingerprint
  );

  insert into public.audit_events (
    organization_id, actor_user_id, entity_type, entity_id,
    event_type, before_value, after_value, note
  ) values (
    v_actor.organization_id,
    v_actor.user_id,
    case
      when v_interview.id is not null then 'client_candidate_interview'
      when v_decision.id is not null then 'client_candidate_decision'
      when v_handoff.id is not null then 'client_placement_handoff'
      when v_onboarding.id is not null then 'placement_onboarding_item'
      else 'placement'
    end,
    coalesce(v_interview.id, v_decision.id, v_handoff.id, v_onboarding.id, v_placement.id),
    'client_placement_' || v_action,
    v_before,
    v_after,
    'Protected notes, attendee addresses, and rates are not copied into the audit event.'
  );

  v_state := private.client_placement_workspace_json(
    v_actor.organization_id, v_actor.role, v_actor.user_id,
    v_actor.client_id, v_request.id
  );
  if v_calendar_action is not null then
    v_calendar_command := private.client_interview_calendar_command_json(
      v_actor.organization_id, v_interview.id, p_request_id, v_calendar_action
    );
  end if;
  return jsonb_build_object('state', v_state, 'calendarCommand', v_calendar_command);
end;
$$;

revoke all on function public.change_client_placement_workflow(
  uuid, uuid, uuid, text, timestamptz, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.change_client_placement_workflow(
  uuid, uuid, uuid, text, timestamptz, uuid, jsonb
) to service_role;

create or replace function public.record_client_interview_calendar_sync(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_hiring_request_id uuid,
  p_interview_id uuid,
  p_expected_updated_at timestamptz,
  p_sync_status text,
  p_microsoft_event_id text,
  p_microsoft_join_url text,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $$
declare
  v_actor record;
  v_interview public.client_candidate_interviews%rowtype;
  v_mutation public.client_placement_operations%rowtype;
  v_existing public.client_placement_operations%rowtype;
  v_status text := lower(btrim(coalesce(p_sync_status, '')));
  v_fingerprint text;
  v_state jsonb;
begin
  if p_request_id is null or p_hiring_request_id is null or p_interview_id is null
    or p_expected_updated_at is null
    or v_status not in ('connection_required', 'synced', 'sync_failed', 'not_applicable')
    or (p_microsoft_event_id is not null and char_length(p_microsoft_event_id) > 1024)
    or (p_microsoft_join_url is not null and char_length(p_microsoft_join_url) > 2048)
    or (p_error_code is not null and char_length(p_error_code) > 100) then
    raise exception using errcode = '22023', message = 'The Client interview calendar result is invalid.';
  end if;
  if v_status = 'synced' and p_microsoft_event_id is null then
    raise exception using errcode = '22023', message = 'A synchronized calendar event requires an event id.';
  end if;
  select * into v_actor from private.client_placement_actor(p_actor_user_id);
  v_fingerprint := encode(
    digest(convert_to(concat_ws(
      '|', 'calendar_sync_result', p_hiring_request_id::text,
      p_interview_id::text, p_expected_updated_at::text, v_status,
      coalesce(p_microsoft_event_id, ''), coalesce(p_microsoft_join_url, ''),
      coalesce(p_error_code, '')
    ), 'utf8'), 'sha256'),
    'hex'
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('client-placement-calendar:' || p_request_id::text, 0)
  );
  select operation.* into v_mutation
  from public.client_placement_operations as operation
  where operation.operation_request_id = p_request_id
    and operation.phase = 'mutation';
  if not found
    or v_mutation.organization_id is distinct from v_actor.organization_id
    or v_mutation.actor_user_id is distinct from v_actor.user_id
    or v_mutation.hiring_request_id is distinct from p_hiring_request_id
    or v_mutation.interview_id is distinct from p_interview_id
    or v_mutation.action not in (
      'schedule_interview', 'reschedule_interview',
      'cancel_interview', 'retry_calendar_sync'
    ) then
    raise exception using errcode = '42501', message = 'This calendar command is not available to your account.';
  end if;
  select operation.* into v_existing
  from public.client_placement_operations as operation
  where operation.operation_request_id = p_request_id
    and operation.phase = 'calendar_sync';
  if v_existing.operation_request_id is not null then
    if v_existing.organization_id is distinct from v_actor.organization_id
      or v_existing.actor_user_id is distinct from v_actor.user_id
      or v_existing.hiring_request_id is distinct from p_hiring_request_id
      or v_existing.interview_id is distinct from p_interview_id
      or v_existing.request_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = '23505', message = 'This request id has already recorded another calendar result.';
    end if;
    return public.get_client_placement_workspace(v_actor.user_id, p_hiring_request_id);
  end if;

  select interview.* into v_interview
  from public.client_candidate_interviews as interview
  where interview.id = p_interview_id
    and interview.organization_id = v_actor.organization_id
    and interview.hiring_request_id = p_hiring_request_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'This Client interview is not available to your account.';
  end if;
  if v_interview.updated_at is distinct from p_expected_updated_at then
    raise exception using errcode = 'P0001', message = 'This Client interview changed after the calendar command started.';
  end if;
  update public.client_candidate_interviews set
    calendar_sync_status = v_status,
    calendar_sync_action = case when v_status in ('synced', 'not_applicable') then null else calendar_sync_action end,
    microsoft_event_id = coalesce(p_microsoft_event_id, microsoft_event_id),
    microsoft_join_url = case
      when v_status = 'not_applicable' then null
      else coalesce(p_microsoft_join_url, microsoft_join_url)
    end,
    microsoft_last_error_code = case when v_status = 'sync_failed'
      then coalesce(nullif(p_error_code, ''), 'graph_sync_failed') end,
    calendar_sync_started_at = null
  where id = v_interview.id;
  insert into public.client_placement_operations (
    operation_request_id, phase, organization_id, actor_user_id, action,
    hiring_request_id, interview_id, request_fingerprint
  ) values (
    p_request_id, 'calendar_sync', v_actor.organization_id, v_actor.user_id,
    'calendar_sync_result', p_hiring_request_id, p_interview_id, v_fingerprint
  );
  insert into public.audit_events (
    organization_id, actor_user_id, entity_type, entity_id,
    event_type, before_value, after_value, note
  ) values (
    v_actor.organization_id, v_actor.user_id, 'client_candidate_interview', p_interview_id,
    'client_interview_calendar_sync_result',
    jsonb_build_object('status', v_interview.calendar_sync_status),
    jsonb_build_object('status', v_status),
    'Calendar identifiers, join links, attendee addresses, and provider errors are not copied into the audit event.'
  );
  v_state := public.get_client_placement_workspace(v_actor.user_id, p_hiring_request_id);
  return v_state;
end;
$$;

revoke all on function public.record_client_interview_calendar_sync(
  uuid, uuid, uuid, uuid, timestamptz, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.record_client_interview_calendar_sync(
  uuid, uuid, uuid, uuid, timestamptz, text, text, text, text
) to service_role;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'client_placement_handoffs_placement_organization_fkey'
      and conrelid = 'public.client_placement_handoffs'::regclass
  ) then
    alter table public.client_placement_handoffs
      add constraint client_placement_handoffs_placement_organization_fkey
      foreign key (placement_id, organization_id)
      references public.placements (id, organization_id) on delete restrict;
  end if;
end
$$;

comment on table public.client_candidate_interviews is
  'Many-round Client interview records. Private notes and attendee snapshots are service-only.';
comment on table public.client_candidate_decisions is
  'Append-only final Client Administrator selections or passes.';
comment on table public.client_placement_handoffs is
  'Sales-prepared rate and schedule handoff; only Admin or Talent Management confirms placement.';
comment on table public.placement_onboarding_items is
  'Required placement activation checklist managed only by Admin or Talent Management.';
comment on function public.change_client_placement_workflow(
  uuid, uuid, uuid, text, timestamptz, uuid, jsonb
) is 'Service-only, idempotent Client interview-through-activation mutation boundary.';
