-- Soro Operations: secure Sales shortlists and Client review responses.
--
-- One draft round may exist per hiring request. A sent round is immutable apart
-- from one Client response per candidate. Browser callers never choose an
-- organization, Client membership, role, or Sales owner; the service-only RPCs
-- derive those boundaries from the authenticated actor supplied by Netlify.

create unique index if not exists applicants_id_organization_unique
  on public.applicants (id, organization_id);
create unique index if not exists hiring_requests_id_client_unique
  on public.hiring_requests (id, client_id);

create table if not exists public.client_shortlists (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  client_id uuid not null,
  hiring_request_id uuid not null,
  sales_owner_id uuid not null,
  round_number integer not null check (round_number between 1 and 1000),
  status text not null default 'draft' check (status in ('draft', 'sent')),
  created_by_user_id uuid not null,
  sent_by_user_id uuid,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_shortlists_client_organization_fkey
    foreign key (client_id, organization_id)
    references public.clients (id, organization_id) on delete restrict,
  constraint client_shortlists_request_client_fkey
    foreign key (hiring_request_id, client_id)
    references public.hiring_requests (id, client_id) on delete restrict,
  constraint client_shortlists_owner_organization_fkey
    foreign key (sales_owner_id, organization_id)
    references public.platform_users (id, organization_id) on delete restrict,
  constraint client_shortlists_creator_organization_fkey
    foreign key (created_by_user_id, organization_id)
    references public.platform_users (id, organization_id) on delete restrict,
  constraint client_shortlists_sender_organization_fkey
    foreign key (sent_by_user_id, organization_id)
    references public.platform_users (id, organization_id) on delete restrict,
  constraint client_shortlists_sent_metadata_check check (
    (status = 'draft' and sent_by_user_id is null and sent_at is null)
    or (status = 'sent' and sent_by_user_id is not null and sent_at is not null)
  ),
  unique (hiring_request_id, round_number)
);

create unique index if not exists client_shortlists_id_organization_unique
  on public.client_shortlists (id, organization_id);
create unique index if not exists client_shortlists_one_draft_per_request
  on public.client_shortlists (hiring_request_id)
  where status = 'draft';
create index if not exists client_shortlists_owner_status_idx
  on public.client_shortlists (organization_id, sales_owner_id, status, updated_at desc);
create index if not exists client_shortlists_client_sent_idx
  on public.client_shortlists (organization_id, client_id, sent_at desc)
  where status = 'sent';

drop trigger if exists client_shortlists_updated_at on public.client_shortlists;
create trigger client_shortlists_updated_at
before update on public.client_shortlists
for each row execute function public.set_updated_at();

create table if not exists public.client_shortlist_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  shortlist_id uuid not null,
  applicant_id uuid not null,
  added_by_user_id uuid not null,
  added_at timestamptz not null default now(),
  removed_by_user_id uuid,
  removed_at timestamptz,
  client_response text check (
    client_response is null
    or client_response in ('request_interview', 'interested', 'not_a_fit')
  ),
  response_by_user_id uuid,
  responded_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint client_shortlist_items_shortlist_organization_fkey
    foreign key (shortlist_id, organization_id)
    references public.client_shortlists (id, organization_id) on delete restrict,
  constraint client_shortlist_items_applicant_organization_fkey
    foreign key (applicant_id, organization_id)
    references public.applicants (id, organization_id) on delete restrict,
  constraint client_shortlist_items_adder_organization_fkey
    foreign key (added_by_user_id, organization_id)
    references public.platform_users (id, organization_id) on delete restrict,
  constraint client_shortlist_items_remover_organization_fkey
    foreign key (removed_by_user_id, organization_id)
    references public.platform_users (id, organization_id) on delete restrict,
  constraint client_shortlist_items_responder_organization_fkey
    foreign key (response_by_user_id, organization_id)
    references public.platform_users (id, organization_id) on delete restrict,
  constraint client_shortlist_items_removed_metadata_check check (
    (removed_at is null and removed_by_user_id is null)
    or (removed_at is not null and removed_by_user_id is not null)
  ),
  constraint client_shortlist_items_response_metadata_check check (
    (client_response is null and response_by_user_id is null and responded_at is null)
    or (client_response is not null and response_by_user_id is not null and responded_at is not null)
  ),
  constraint client_shortlist_items_removed_response_check check (
    removed_at is null or client_response is null
  ),
  unique (shortlist_id, applicant_id)
);

create unique index if not exists client_shortlist_items_id_organization_unique
  on public.client_shortlist_items (id, organization_id);
create unique index if not exists client_shortlist_items_id_shortlist_unique
  on public.client_shortlist_items (id, shortlist_id);
create unique index if not exists client_shortlist_items_one_active_candidate
  on public.client_shortlist_items (applicant_id)
  where removed_at is null
    and (client_response is null or client_response <> 'not_a_fit');
create index if not exists client_shortlist_items_shortlist_active_idx
  on public.client_shortlist_items (shortlist_id, added_at, id)
  where removed_at is null;

drop trigger if exists client_shortlist_items_updated_at on public.client_shortlist_items;
create trigger client_shortlist_items_updated_at
before update on public.client_shortlist_items
for each row execute function public.set_updated_at();

create table if not exists public.client_shortlist_notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  recipient_user_id uuid not null,
  shortlist_id uuid not null,
  shortlist_item_id uuid,
  notification_type text not null check (
    notification_type in ('client_shortlist_ready', 'client_shortlist_response')
  ),
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint client_shortlist_notifications_recipient_organization_fkey
    foreign key (recipient_user_id, organization_id)
    references public.platform_users (id, organization_id) on delete cascade,
  constraint client_shortlist_notifications_shortlist_organization_fkey
    foreign key (shortlist_id, organization_id)
    references public.client_shortlists (id, organization_id) on delete cascade,
  constraint client_shortlist_notifications_item_shortlist_fkey
    foreign key (shortlist_item_id, shortlist_id)
    references public.client_shortlist_items (id, shortlist_id) on delete cascade,
  constraint client_shortlist_notifications_type_item_check check (
    (notification_type = 'client_shortlist_ready' and shortlist_item_id is null)
    or (notification_type = 'client_shortlist_response' and shortlist_item_id is not null)
  )
);

create unique index if not exists client_shortlist_ready_notification_unique
  on public.client_shortlist_notifications (recipient_user_id, shortlist_id, notification_type)
  where notification_type = 'client_shortlist_ready';
create unique index if not exists client_shortlist_response_notification_unique
  on public.client_shortlist_notifications (recipient_user_id, shortlist_item_id, notification_type)
  where notification_type = 'client_shortlist_response';
create index if not exists client_shortlist_notifications_recipient_idx
  on public.client_shortlist_notifications (
    organization_id, recipient_user_id, read_at, created_at desc
  );

create table if not exists public.client_shortlist_operations (
  operation_request_id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  actor_user_id uuid not null,
  action text not null check (
    action in ('add_candidate', 'remove_candidate', 'send_shortlist', 'respond_candidate')
  ),
  hiring_request_id uuid references public.hiring_requests(id) on delete restrict,
  applicant_id uuid,
  shortlist_id uuid,
  shortlist_item_id uuid,
  client_response text check (
    client_response is null
    or client_response in ('request_interview', 'interested', 'not_a_fit')
  ),
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  constraint client_shortlist_operations_actor_organization_fkey
    foreign key (actor_user_id, organization_id)
    references public.platform_users (id, organization_id) on delete restrict,
  constraint client_shortlist_operations_applicant_organization_fkey
    foreign key (applicant_id, organization_id)
    references public.applicants (id, organization_id) on delete restrict,
  constraint client_shortlist_operations_shortlist_organization_fkey
    foreign key (shortlist_id, organization_id)
    references public.client_shortlists (id, organization_id) on delete restrict,
  constraint client_shortlist_operations_item_organization_fkey
    foreign key (shortlist_item_id, organization_id)
    references public.client_shortlist_items (id, organization_id) on delete restrict
);

create index if not exists client_shortlist_operations_actor_idx
  on public.client_shortlist_operations (organization_id, actor_user_id, created_at desc);

alter table public.client_shortlists enable row level security;
alter table public.client_shortlist_items enable row level security;
alter table public.client_shortlist_notifications enable row level security;
alter table public.client_shortlist_operations enable row level security;

revoke all on table public.client_shortlists from public, anon, authenticated;
revoke all on table public.client_shortlist_items from public, anon, authenticated;
revoke all on table public.client_shortlist_notifications from public, anon, authenticated;
revoke all on table public.client_shortlist_operations from public, anon, authenticated;

grant select, insert, update on table public.client_shortlists to service_role;
grant select, insert, update on table public.client_shortlist_items to service_role;
grant select, insert, update on table public.client_shortlist_notifications to service_role;
grant select, insert on table public.client_shortlist_operations to service_role;

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
      'shortlisting', 'interviewing', 'client_review'
    );
$$;

revoke all on function private.is_open_hiring_request_status(text)
  from public, anon, authenticated;

create or replace function private.client_shortlist_actor(p_actor_user_id uuid)
returns table (
  user_id uuid,
  organization_id uuid,
  role public.platform_role,
  client_id uuid
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_access public.platform_users%rowtype;
  v_client_id uuid;
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
      'client_admin'::public.platform_role,
      'client_reviewer'::public.platform_role
    );

  if not found then
    raise exception using errcode = '42501', message = 'Active Sales or Client review access is required.';
  end if;

  if v_access.role in (
    'client_admin'::public.platform_role,
    'client_reviewer'::public.platform_role
  ) then
    select membership.client_id into v_client_id
    from public.client_portal_memberships as membership
    join public.clients as client
      on client.id = membership.client_id
     and client.organization_id = membership.organization_id
     and client.archived_at is null
    join public.client_contacts as contact
      on contact.id = membership.client_contact_id
     and contact.client_id = membership.client_id
     and contact.active = true
    where membership.user_id = v_access.id
      and membership.organization_id = v_access.organization_id
      and membership.active = true;

    if not found then
      raise exception using errcode = '42501', message = 'An active Client review membership is required.';
    end if;
  end if;

  return query select v_access.id, v_access.organization_id, v_access.role, v_client_id;
end;
$$;

revoke all on function private.client_shortlist_actor(uuid)
  from public, anon, authenticated;

create or replace function private.client_shortlist_workspace_json(
  p_organization_id uuid,
  p_viewer_role public.platform_role,
  p_actor_user_id uuid,
  p_actor_client_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  with scoped_requests as (
    select
      hiring.id as hiring_request_id,
      client.id as client_id,
      client.company_name as client_name,
      client.sales_owner_id as client_sales_owner_id,
      hiring.title,
      hiring.status,
      hiring.start_date,
      hiring.number_of_virtual_assistants
    from public.hiring_requests as hiring
    join public.clients as client on client.id = hiring.client_id
    where client.organization_id = p_organization_id
      and client.archived_at is null
      and private.is_open_hiring_request_status(hiring.status)
      and case
        when p_viewer_role = 'sales'::public.platform_role
          then client.sales_owner_id = p_actor_user_id
        when p_viewer_role in (
          'admin'::public.platform_role,
          'sales_management'::public.platform_role
        ) then true
        else client.id = p_actor_client_id
          and exists (
            select 1
            from public.client_shortlists as sent
            where sent.hiring_request_id = hiring.id
              and sent.organization_id = p_organization_id
              and sent.client_id = p_actor_client_id
              and sent.status = 'sent'
          )
      end
    order by lower(client.company_name), lower(hiring.title), hiring.id
    limit 500
  ), request_rows as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'hiringRequestId', request.hiring_request_id,
          'clientId', request.client_id,
          'clientName', request.client_name,
          'title', request.title,
          'status', request.status,
          'startDate', request.start_date,
          'numberOfTalent', request.number_of_virtual_assistants,
          'canAddCandidate', p_viewer_role in (
            'admin'::public.platform_role,
            'sales_management'::public.platform_role,
            'sales'::public.platform_role
          ) and exists (
            select 1
            from public.platform_users as owner
            where owner.id = request.client_sales_owner_id
              and owner.organization_id = p_organization_id
              and owner.active = true
              and owner.must_change_password = false
              and owner.role = 'sales'::public.platform_role
          ) and exists (
            select 1
            from public.applicants as eligible
            where eligible.organization_id = p_organization_id
              and eligible.archived_at is null
              and eligible.status = 'bench_ready'::public.applicant_status
              and eligible.sales_owner_id = request.client_sales_owner_id
              and (
                p_viewer_role <> 'sales'::public.platform_role
                or eligible.sales_owner_id = p_actor_user_id
              )
          ) and not exists (
            select 1
            from public.client_shortlists as stale_draft
            where stale_draft.hiring_request_id = request.hiring_request_id
              and stale_draft.organization_id = p_organization_id
              and stale_draft.status = 'draft'
              and exists (
                select 1
                from public.client_shortlist_items as active_draft_item
                where active_draft_item.shortlist_id = stale_draft.id
                  and active_draft_item.organization_id = stale_draft.organization_id
                  and active_draft_item.removed_at is null
              )
              and (
                stale_draft.sales_owner_id is distinct from request.client_sales_owner_id
                or exists (
                  select 1
                  from public.client_shortlist_items as stale_item
                  join public.applicants as stale_applicant
                    on stale_applicant.id = stale_item.applicant_id
                   and stale_applicant.organization_id = stale_item.organization_id
                  where stale_item.shortlist_id = stale_draft.id
                    and stale_item.organization_id = stale_draft.organization_id
                    and stale_item.removed_at is null
                    and (
                      stale_applicant.archived_at is not null
                      or stale_applicant.sales_owner_id is distinct from request.client_sales_owner_id
                      or stale_applicant.status <> 'shortlisted'::public.applicant_status
                    )
                )
              )
          )
        ) order by lower(request.client_name), lower(request.title), request.hiring_request_id
      ),
      '[]'::jsonb
    ) as payload
    from scoped_requests as request
  ), candidate_scope as (
    select applicant.*
    from public.applicants as applicant
    where p_viewer_role in (
        'admin'::public.platform_role,
        'sales_management'::public.platform_role,
        'sales'::public.platform_role
      )
      and applicant.organization_id = p_organization_id
      and applicant.archived_at is null
      and applicant.status = 'bench_ready'::public.applicant_status
      and applicant.sales_owner_id is not null
      and (
        p_viewer_role <> 'sales'::public.platform_role
        or applicant.sales_owner_id = p_actor_user_id
      )
    order by lower(
      coalesce(nullif(btrim(applicant.preferred_name), ''), applicant.full_name)
    ), applicant.id
    limit 2000
  ), candidate_rows as (
    select case
      when p_viewer_role in (
        'admin'::public.platform_role,
        'sales_management'::public.platform_role,
        'sales'::public.platform_role
      ) then coalesce(
        jsonb_agg(
          jsonb_build_object(
            'applicantId', applicant.id,
            'displayName', coalesce(
              nullif(btrim(applicant.preferred_name), ''),
              nullif(btrim(applicant.full_name), ''),
              'Talent'
            ),
            'stage', applicant.status::text,
            'verifiedSkills', to_jsonb(coalesce(applicant.verified_skills, '{}'::text[])),
            'yearsExperience', applicant.relevant_experience_years,
            'availability', nullif(btrim(applicant.availability_note), ''),
            'salesOwnerId', applicant.sales_owner_id,
            'updatedAt', applicant.updated_at
          ) order by lower(
            coalesce(nullif(btrim(applicant.preferred_name), ''), applicant.full_name)
          ), applicant.id
        ),
        '[]'::jsonb
      )
      else '[]'::jsonb
    end as payload
    from candidate_scope as applicant
  ), shortlist_scope as (
    select
      shortlist.*,
      client.company_name as client_name,
      client.sales_owner_id as client_sales_owner_id,
      client.archived_at as client_archived_at,
      hiring.title as request_title
    from public.client_shortlists as shortlist
    join public.clients as client
      on client.id = shortlist.client_id
     and client.organization_id = shortlist.organization_id
    join public.hiring_requests as hiring
      on hiring.id = shortlist.hiring_request_id
     and hiring.client_id = shortlist.client_id
    where shortlist.organization_id = p_organization_id
      and private.is_open_hiring_request_status(hiring.status)
      and case
        when p_viewer_role = 'sales'::public.platform_role
          then client.archived_at is null
            and client.sales_owner_id = p_actor_user_id
            and not exists (
              select 1
              from public.client_shortlist_items as owned_item
              join public.applicants as owned_applicant
                on owned_applicant.id = owned_item.applicant_id
               and owned_applicant.organization_id = owned_item.organization_id
              where owned_item.shortlist_id = shortlist.id
                and owned_item.organization_id = shortlist.organization_id
                and owned_item.removed_at is null
                and (
                  owned_applicant.archived_at is not null
                  or owned_applicant.sales_owner_id is distinct from p_actor_user_id
                )
            )
        when p_viewer_role in (
          'admin'::public.platform_role,
          'sales_management'::public.platform_role
        ) then true
        else shortlist.client_id = p_actor_client_id
          and shortlist.status = 'sent'
          and client.archived_at is null
      end
    order by shortlist.created_at desc, shortlist.id
    limit 500
  ), shortlist_rows as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'shortlistId', shortlist.id,
          'hiringRequestId', shortlist.hiring_request_id,
          'clientId', shortlist.client_id,
          'clientName', shortlist.client_name,
          'requestTitle', shortlist.request_title,
          'roundNumber', shortlist.round_number,
          'status', shortlist.status,
          'sentAt', shortlist.sent_at,
          'updatedAt', shortlist.updated_at,
          'salesOwnerId', shortlist.sales_owner_id,
          'canSend', shortlist.status = 'draft'
            and p_viewer_role in (
              'admin'::public.platform_role,
              'sales_management'::public.platform_role,
              'sales'::public.platform_role
            )
            and shortlist.client_archived_at is null
            and shortlist.client_sales_owner_id = shortlist.sales_owner_id
            and exists (
              select 1
              from public.platform_users as send_owner
              where send_owner.id = shortlist.client_sales_owner_id
                and send_owner.organization_id = shortlist.organization_id
                and send_owner.active = true
                and send_owner.must_change_password = false
                and send_owner.role = 'sales'::public.platform_role
            )
            and exists (
              select 1
              from public.client_portal_memberships as send_membership
              join public.platform_users as send_recipient
                on send_recipient.id = send_membership.user_id
               and send_recipient.organization_id = send_membership.organization_id
               and send_recipient.active = true
               and send_recipient.must_change_password = false
               and send_recipient.role in (
                 'client_admin'::public.platform_role,
                 'client_reviewer'::public.platform_role
               )
              join public.client_contacts as send_contact
                on send_contact.id = send_membership.client_contact_id
               and send_contact.client_id = send_membership.client_id
               and send_contact.active = true
              where send_membership.organization_id = shortlist.organization_id
                and send_membership.client_id = shortlist.client_id
                and send_membership.active = true
            )
            and (
              p_viewer_role <> 'sales'::public.platform_role
              or shortlist.sales_owner_id = p_actor_user_id
            )
            and exists (
              select 1
              from public.client_shortlist_items as sendable
              where sendable.shortlist_id = shortlist.id
                and sendable.organization_id = shortlist.organization_id
                and sendable.removed_at is null
            )
            and not exists (
              select 1
              from public.client_shortlist_items as blocked_item
              join public.applicants as blocked_applicant
                on blocked_applicant.id = blocked_item.applicant_id
               and blocked_applicant.organization_id = blocked_item.organization_id
              where blocked_item.shortlist_id = shortlist.id
                and blocked_item.organization_id = shortlist.organization_id
                and blocked_item.removed_at is null
                and (
                  blocked_applicant.archived_at is not null
                  or blocked_applicant.sales_owner_id is distinct from shortlist.client_sales_owner_id
                  or blocked_applicant.status <> 'shortlisted'::public.applicant_status
                )
            ),
          'items', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'shortlistItemId', item.id,
                'applicantId', applicant.id,
                'candidate', jsonb_build_object(
                  'applicantId', applicant.id,
                  'displayName', coalesce(
                    nullif(btrim(applicant.full_name), ''),
                    'Talent'
                  ),
                  'country', nullif(btrim(applicant.country), ''),
                  'timeZone', nullif(btrim(applicant.timezone), ''),
                  'verifiedSkills', to_jsonb(coalesce(applicant.verified_skills, '{}'::text[])),
                  'yearsExperience', applicant.relevant_experience_years,
                  'experienceSummary', nullif(btrim(applicant.relevant_experience_summary), ''),
                  'educationAndTraining', nullif(btrim(applicant.education_training_summary), ''),
                  'screening', jsonb_build_object(
                    'englishResult', nullif(btrim(applicant.english_test_result), ''),
                    'personalityResult', nullif(btrim(applicant.personality_profile_score), ''),
                    'computerSpecifications', nullif(btrim(applicant.computer_specs), ''),
                    'internetSpeed', nullif(btrim(applicant.internet_speed), '')
                  )
                ),
                'response', item.client_response,
                'respondedAt', item.responded_at,
                'addedAt', item.added_at,
                'updatedAt', item.updated_at,
                'canRemove', shortlist.status = 'draft'
                  and (
                    p_viewer_role in (
                      'admin'::public.platform_role,
                      'sales_management'::public.platform_role
                    )
                    or (p_viewer_role = 'sales'::public.platform_role
                      and shortlist.client_archived_at is null
                      and shortlist.client_sales_owner_id = p_actor_user_id
                      and shortlist.sales_owner_id = p_actor_user_id
                      and applicant.archived_at is null
                      and applicant.sales_owner_id = p_actor_user_id
                      and applicant.status = 'shortlisted'::public.applicant_status
                      and not exists (
                        select 1
                        from public.client_shortlist_items as removable_scope_item
                        join public.applicants as removable_scope_applicant
                          on removable_scope_applicant.id = removable_scope_item.applicant_id
                         and removable_scope_applicant.organization_id = removable_scope_item.organization_id
                        where removable_scope_item.shortlist_id = shortlist.id
                          and removable_scope_item.organization_id = shortlist.organization_id
                          and removable_scope_item.removed_at is null
                          and (
                            removable_scope_applicant.archived_at is not null
                            or removable_scope_applicant.sales_owner_id is distinct from p_actor_user_id
                            or removable_scope_applicant.status <> 'shortlisted'::public.applicant_status
                          )
                      )
                    )
                  ),
                'canRespond', shortlist.status = 'sent'
                  and item.client_response is null
                  and p_viewer_role in (
                    'client_admin'::public.platform_role,
                    'client_reviewer'::public.platform_role
                  )
                  and applicant.archived_at is null
                  and applicant.sales_owner_id = shortlist.client_sales_owner_id
                  and applicant.status = 'client_review'::public.applicant_status
                  and exists (
                    select 1
                    from public.platform_users as response_owner
                    where response_owner.id = shortlist.client_sales_owner_id
                      and response_owner.organization_id = shortlist.organization_id
                      and response_owner.active = true
                      and response_owner.must_change_password = false
                      and response_owner.role = 'sales'::public.platform_role
                  )
              ) order by item.added_at, item.id
            )
            from public.client_shortlist_items as item
            join public.applicants as applicant
              on applicant.id = item.applicant_id
             and applicant.organization_id = item.organization_id
            where item.shortlist_id = shortlist.id
              and item.organization_id = shortlist.organization_id
              and item.removed_at is null
          ), '[]'::jsonb)
        ) order by shortlist.created_at desc, shortlist.id
      ),
      '[]'::jsonb
    ) as payload
    from shortlist_scope as shortlist
  ), notification_rows as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'notificationId', notification.id,
          'type', notification.notification_type,
          'title', case notification.notification_type
            when 'client_shortlist_ready' then 'Candidate shortlist ready'
            else 'Client shortlist response'
          end,
          'message', case notification.notification_type
            when 'client_shortlist_ready' then 'A candidate shortlist is ready for your review.'
            else 'A Client response was recorded for a shortlisted candidate.'
          end,
          'shortlistId', notification.shortlist_id,
          'shortlistItemId', notification.shortlist_item_id,
          'createdAt', notification.created_at,
          'readAt', notification.read_at
        ) order by
          case when notification.read_at is null then 0 else 1 end,
          notification.created_at desc,
          notification.id
      ),
      '[]'::jsonb
    ) as payload
    from (
      select scoped.*
      from public.client_shortlist_notifications as scoped
      join public.client_shortlists as scoped_shortlist
        on scoped_shortlist.id = scoped.shortlist_id
       and scoped_shortlist.organization_id = scoped.organization_id
      join public.clients as scoped_client
        on scoped_client.id = scoped_shortlist.client_id
       and scoped_client.organization_id = scoped_shortlist.organization_id
      join public.hiring_requests as scoped_request
        on scoped_request.id = scoped_shortlist.hiring_request_id
       and scoped_request.client_id = scoped_shortlist.client_id
      where scoped.organization_id = p_organization_id
        and scoped.recipient_user_id = p_actor_user_id
        and case
          when p_viewer_role = 'sales'::public.platform_role then
            scoped_client.archived_at is null
            and scoped_client.sales_owner_id = p_actor_user_id
            and private.is_open_hiring_request_status(scoped_request.status)
            and not exists (
              select 1
              from public.client_shortlist_items as notification_item
              join public.applicants as notification_applicant
                on notification_applicant.id = notification_item.applicant_id
               and notification_applicant.organization_id = notification_item.organization_id
              where notification_item.shortlist_id = scoped_shortlist.id
                and notification_item.organization_id = scoped_shortlist.organization_id
                and notification_item.removed_at is null
                and (
                  notification_applicant.archived_at is not null
                  or notification_applicant.sales_owner_id is distinct from p_actor_user_id
                )
            )
          when p_viewer_role in (
            'client_admin'::public.platform_role,
            'client_reviewer'::public.platform_role
          ) then
            scoped_shortlist.client_id = p_actor_client_id
            and scoped_shortlist.status = 'sent'
            and scoped_client.archived_at is null
            and private.is_open_hiring_request_status(scoped_request.status)
          else true
        end
      order by scoped.created_at desc, scoped.id
      limit 200
    ) as notification
  )
  select jsonb_build_object(
    'generatedAt', pg_catalog.clock_timestamp(),
    'viewerRole', p_viewer_role::text,
    'requests', request_rows.payload,
    'candidates', candidate_rows.payload,
    'shortlists', shortlist_rows.payload,
    'notifications', notification_rows.payload
  )
  from request_rows
  cross join candidate_rows
  cross join shortlist_rows
  cross join notification_rows;
$$;

revoke all on function private.client_shortlist_workspace_json(
  uuid, public.platform_role, uuid, uuid
) from public, anon, authenticated;

create or replace function public.get_client_shortlist_workspace(p_actor_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_actor record;
begin
  select * into v_actor from private.client_shortlist_actor(p_actor_user_id);
  return private.client_shortlist_workspace_json(
    v_actor.organization_id,
    v_actor.role,
    v_actor.user_id,
    v_actor.client_id
  );
end;
$$;

revoke all on function public.get_client_shortlist_workspace(uuid)
  from public, anon, authenticated;
grant execute on function public.get_client_shortlist_workspace(uuid)
  to service_role;

create or replace function public.change_client_shortlist(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_action text,
  p_expected_updated_at timestamptz,
  p_hiring_request_id uuid,
  p_applicant_id uuid,
  p_shortlist_id uuid,
  p_shortlist_item_id uuid,
  p_response text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $$
declare
  v_actor record;
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_response text := nullif(lower(btrim(coalesce(p_response, ''))), '');
  v_fingerprint text;
  v_existing public.client_shortlist_operations%rowtype;
  v_hiring record;
  v_pipeline_owner_id uuid;
  v_pipeline_owner record;
  v_applicant public.applicants%rowtype;
  v_shortlist public.client_shortlists%rowtype;
  v_item public.client_shortlist_items%rowtype;
  v_round_number integer;
  v_created_shortlist boolean := false;
  v_has_draft boolean := false;
  v_rebased_shortlist boolean := false;
  v_previous_owner_id uuid;
  v_lock_hiring_request_id uuid;
  v_lock_client_id uuid;
  v_lock_shortlist_id uuid;
  v_lock_applicant_id uuid;
  v_active_item_id uuid;
  v_item_count integer;
  v_recipient_count integer;
  v_next_status public.applicant_status;
begin
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'A request id is required.';
  end if;
  if p_expected_updated_at is null then
    raise exception using errcode = '22023', message = 'The current record update time is required.';
  end if;
  if v_action not in (
    'add_candidate', 'remove_candidate', 'send_shortlist', 'respond_candidate'
  ) then
    raise exception using errcode = '22023', message = 'Choose a supported shortlist action.';
  end if;

  if v_action = 'add_candidate' then
    if p_hiring_request_id is null or p_applicant_id is null
      or p_shortlist_id is not null or p_shortlist_item_id is not null
      or v_response is not null then
      raise exception using errcode = '22023', message = 'Choose one hiring request and one Talent profile.';
    end if;
  elsif v_action = 'remove_candidate' then
    if p_shortlist_item_id is null or p_hiring_request_id is not null
      or p_applicant_id is not null or p_shortlist_id is not null
      or v_response is not null then
      raise exception using errcode = '22023', message = 'Choose one draft shortlist candidate.';
    end if;
  elsif v_action = 'send_shortlist' then
    if p_shortlist_id is null or p_hiring_request_id is not null
      or p_applicant_id is not null or p_shortlist_item_id is not null
      or v_response is not null then
      raise exception using errcode = '22023', message = 'Choose one draft shortlist.';
    end if;
  elsif v_action = 'respond_candidate' then
    if p_shortlist_item_id is null
      or v_response not in ('request_interview', 'interested', 'not_a_fit')
      or p_hiring_request_id is not null or p_applicant_id is not null
      or p_shortlist_id is not null then
      raise exception using errcode = '22023', message = 'Choose one available Client response.';
    end if;
  end if;

  select * into v_actor from private.client_shortlist_actor(p_actor_user_id);

  v_fingerprint := encode(
    digest(
      concat_ws(
        '|',
        v_action,
        coalesce(p_hiring_request_id::text, ''),
        coalesce(p_applicant_id::text, ''),
        coalesce(p_shortlist_id::text, ''),
        coalesce(p_shortlist_item_id::text, ''),
        coalesce(v_response, ''),
        p_expected_updated_at::text
      ),
      'sha256'
    ),
    'hex'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('client-shortlist-operation:' || p_request_id::text, 0)
  );

  select operation.* into v_existing
  from public.client_shortlist_operations as operation
  where operation.operation_request_id = p_request_id;

  if v_existing.operation_request_id is not null then
    if v_existing.organization_id is distinct from v_actor.organization_id
      or v_existing.actor_user_id is distinct from v_actor.user_id
      or v_existing.action is distinct from v_action
      or v_existing.request_fingerprint is distinct from v_fingerprint then
      raise exception using
        errcode = '23505',
        message = 'This request id has already been used for another shortlist request.';
    end if;
    return private.client_shortlist_workspace_json(
      v_actor.organization_id, v_actor.role, v_actor.user_id, v_actor.client_id
    );
  end if;

  if v_action = 'add_candidate' then
    if v_actor.role not in (
      'admin'::public.platform_role,
      'sales_management'::public.platform_role,
      'sales'::public.platform_role
    ) then
      raise exception using errcode = '42501', message = 'Only Sales can build a Client shortlist.';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('client-shortlist-request:' || p_hiring_request_id::text, 0)
    );

    select
      hiring.id as hiring_request_id,
      hiring.client_id,
      hiring.status as hiring_status,
      client.sales_owner_id as client_sales_owner_id
    into v_hiring
    from public.hiring_requests as hiring
    join public.clients as client
      on client.id = hiring.client_id
     and client.organization_id = v_actor.organization_id
     and client.archived_at is null
    where hiring.id = p_hiring_request_id
    for update of hiring, client;

    if not found then
      raise exception using errcode = '42501', message = 'This hiring request is not available to your account.';
    end if;
    if not private.is_open_hiring_request_status(v_hiring.hiring_status) then
      raise exception using errcode = 'P0001', message = 'Candidates can be added only to an open hiring request.';
    end if;

    select shortlist.* into v_shortlist
    from public.client_shortlists as shortlist
    where shortlist.hiring_request_id = p_hiring_request_id
      and shortlist.organization_id = v_actor.organization_id
      and shortlist.status = 'draft'
    for update;
    v_has_draft := found;

    v_pipeline_owner_id := v_hiring.client_sales_owner_id;
    select access.id, access.role into v_pipeline_owner
    from public.platform_users as access
    where access.id = v_pipeline_owner_id
      and access.organization_id = v_actor.organization_id
      and access.active = true
      and access.must_change_password = false
      and access.role = 'sales'::public.platform_role;
    if not found then
      raise exception using errcode = 'P0001', message = 'Assign an active Sales owner to this Client before building a shortlist.';
    end if;
    if v_actor.role = 'sales'::public.platform_role
      and v_pipeline_owner_id <> v_actor.user_id then
      raise exception using errcode = '42501', message = 'Sales can build shortlists only for their own Clients.';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('client-shortlist-applicant:' || p_applicant_id::text, 0)
    );

    select applicant.* into v_applicant
    from public.applicants as applicant
    where applicant.id = p_applicant_id
      and applicant.organization_id = v_actor.organization_id
    for update;
    if not found then
      raise exception using errcode = '42501', message = 'This Talent profile is not available to your account.';
    end if;
    if v_applicant.archived_at is not null
      or v_applicant.status <> 'bench_ready'::public.applicant_status then
      raise exception using errcode = 'P0001', message = 'Only Bench Ready Talent can be added to a shortlist.';
    end if;
    if v_applicant.updated_at is distinct from p_expected_updated_at then
      raise exception using errcode = 'P0001', message = 'This Talent profile changed after it was opened.';
    end if;
    if v_applicant.sales_owner_id is distinct from v_pipeline_owner_id then
      raise exception using errcode = '42501', message = 'The Talent and Client must have the same Sales owner.';
    end if;
    if v_actor.role = 'sales'::public.platform_role
      and v_applicant.sales_owner_id <> v_actor.user_id then
      raise exception using errcode = '42501', message = 'Sales can shortlist only Talent they own.';
    end if;

    select item.id into v_active_item_id
    from public.client_shortlist_items as item
    where item.applicant_id = v_applicant.id
      and item.removed_at is null
      and (item.client_response is null or item.client_response <> 'not_a_fit')
    limit 1;
    if found then
      raise exception using errcode = 'P0001', message = 'This Talent profile is already in an active Client shortlist.';
    end if;

    if not v_has_draft then
      select coalesce(max(shortlist.round_number), 0) + 1 into v_round_number
      from public.client_shortlists as shortlist
      where shortlist.hiring_request_id = p_hiring_request_id;

      insert into public.client_shortlists (
        organization_id,
        client_id,
        hiring_request_id,
        sales_owner_id,
        round_number,
        created_by_user_id
      ) values (
        v_actor.organization_id,
        v_hiring.client_id,
        p_hiring_request_id,
        v_pipeline_owner_id,
        v_round_number,
        v_actor.user_id
      ) returning * into v_shortlist;
      v_created_shortlist := true;
    elsif v_shortlist.organization_id <> v_actor.organization_id
      or v_shortlist.client_id <> v_hiring.client_id then
      raise exception using errcode = '42501', message = 'The open draft is not available to your account.';
    end if;

    select count(*)::integer into v_item_count
    from public.client_shortlist_items as item
    where item.shortlist_id = v_shortlist.id
      and item.organization_id = v_actor.organization_id
      and item.removed_at is null;

    if not v_created_shortlist
      and v_shortlist.sales_owner_id is distinct from v_pipeline_owner_id then
      if v_item_count > 0 then
        raise exception using errcode = 'P0001', message = 'Clear the stale draft before adding Talent for the current Sales owner.';
      end if;

      v_previous_owner_id := v_shortlist.sales_owner_id;
      update public.client_shortlists
      set sales_owner_id = v_pipeline_owner_id,
          updated_at = pg_catalog.clock_timestamp()
      where id = v_shortlist.id
      returning * into v_shortlist;
      v_rebased_shortlist := true;
    end if;

    if v_item_count > 0 and exists (
      select 1
      from public.client_shortlist_items as existing_item
      join public.applicants as existing_applicant
        on existing_applicant.id = existing_item.applicant_id
       and existing_applicant.organization_id = existing_item.organization_id
      where existing_item.shortlist_id = v_shortlist.id
        and existing_item.organization_id = v_actor.organization_id
        and existing_item.removed_at is null
        and (
          existing_applicant.archived_at is not null
          or existing_applicant.sales_owner_id is distinct from v_pipeline_owner_id
          or existing_applicant.status <> 'shortlisted'::public.applicant_status
        )
    ) then
      raise exception using errcode = 'P0001', message = 'Clear stale draft candidates before adding more Talent.';
    end if;

    if v_item_count >= 500 then
      raise exception using errcode = 'P0001', message = 'A shortlist can include no more than 500 candidates.';
    end if;

    select item.* into v_item
    from public.client_shortlist_items as item
    where item.shortlist_id = v_shortlist.id
      and item.applicant_id = v_applicant.id
    for update;

    if found then
      if v_item.removed_at is null then
        raise exception using errcode = 'P0001', message = 'This Talent profile is already in the draft shortlist.';
      end if;
      update public.client_shortlist_items
      set added_by_user_id = v_actor.user_id,
          added_at = pg_catalog.clock_timestamp(),
          removed_by_user_id = null,
          removed_at = null
      where id = v_item.id
      returning * into v_item;
    else
      insert into public.client_shortlist_items (
        organization_id,
        shortlist_id,
        applicant_id,
        added_by_user_id
      ) values (
        v_actor.organization_id,
        v_shortlist.id,
        v_applicant.id,
        v_actor.user_id
      ) returning * into v_item;
    end if;

    update public.client_shortlists
    set updated_at = pg_catalog.clock_timestamp()
    where id = v_shortlist.id
    returning * into v_shortlist;

    update public.applicants
    set status = 'shortlisted'::public.applicant_status
    where id = v_applicant.id;

    if v_created_shortlist then
      insert into public.audit_events (
        organization_id, actor_user_id, entity_type, entity_id,
        event_type, after_value, note
      ) values (
        v_actor.organization_id, v_actor.user_id, 'client_shortlist', v_shortlist.id,
        'client_shortlist_created',
        jsonb_build_object(
          'hiringRequestId', v_shortlist.hiring_request_id,
          'clientId', v_shortlist.client_id,
          'salesOwnerId', v_shortlist.sales_owner_id,
          'roundNumber', v_shortlist.round_number,
          'status', v_shortlist.status
        ),
        'Draft shortlist created for a specific open hiring request.'
      );
    end if;

    if v_rebased_shortlist then
      insert into public.audit_events (
        organization_id, actor_user_id, entity_type, entity_id,
        event_type, before_value, after_value, note
      ) values (
        v_actor.organization_id, v_actor.user_id, 'client_shortlist', v_shortlist.id,
        'client_shortlist_owner_rebased',
        jsonb_build_object('salesOwnerId', v_previous_owner_id),
        jsonb_build_object('salesOwnerId', v_shortlist.sales_owner_id),
        'Empty draft reassigned to the Client current active Sales owner.'
      );
    end if;

    insert into public.audit_events (
      organization_id, actor_user_id, entity_type, entity_id,
      event_type, before_value, after_value, note
    ) values (
      v_actor.organization_id, v_actor.user_id, 'client_shortlist_item', v_item.id,
      'client_shortlist_candidate_added',
      jsonb_build_object('applicantStatus', v_applicant.status::text),
      jsonb_build_object(
        'shortlistId', v_shortlist.id,
        'hiringRequestId', v_shortlist.hiring_request_id,
        'applicantId', v_applicant.id,
        'applicantStatus', 'shortlisted'
      ),
      'Sales added owned Talent to a draft shortlist.'
    );

  elsif v_action = 'remove_candidate' then
    if v_actor.role not in (
      'admin'::public.platform_role,
      'sales_management'::public.platform_role,
      'sales'::public.platform_role
    ) then
      raise exception using errcode = '42501', message = 'Only Sales can edit a draft shortlist.';
    end if;

    select
      shortlist.hiring_request_id,
      shortlist.client_id,
      shortlist.id,
      item.applicant_id
    into
      v_lock_hiring_request_id,
      v_lock_client_id,
      v_lock_shortlist_id,
      v_lock_applicant_id
    from public.client_shortlist_items as item
    join public.client_shortlists as shortlist
      on shortlist.id = item.shortlist_id
     and shortlist.organization_id = item.organization_id
    where item.id = p_shortlist_item_id
      and item.organization_id = v_actor.organization_id
      and shortlist.organization_id = v_actor.organization_id;
    if not found then
      raise exception using errcode = '42501', message = 'This shortlist candidate is not available to your account.';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('client-shortlist-request:' || v_lock_hiring_request_id::text, 0)
    );

    select
      hiring.id as hiring_request_id,
      hiring.client_id,
      hiring.status as hiring_status,
      client.sales_owner_id as client_sales_owner_id,
      client.archived_at as client_archived_at
    into v_hiring
    from public.hiring_requests as hiring
    join public.clients as client
      on client.id = hiring.client_id
     and client.organization_id = v_actor.organization_id
    where hiring.id = v_lock_hiring_request_id
      and hiring.client_id = v_lock_client_id
    for update of hiring, client;
    if not found then
      raise exception using errcode = '42501', message = 'This shortlist hiring request is not available to your account.';
    end if;
    if not private.is_open_hiring_request_status(v_hiring.hiring_status) then
      raise exception using errcode = 'P0001', message = 'Candidates can be removed only while the hiring request is open.';
    end if;

    select shortlist.* into v_shortlist
    from public.client_shortlists as shortlist
    where shortlist.id = v_lock_shortlist_id
      and shortlist.organization_id = v_actor.organization_id
      and shortlist.hiring_request_id = v_hiring.hiring_request_id
      and shortlist.client_id = v_hiring.client_id
    for update;
    if not found then
      raise exception using errcode = '42501', message = 'This shortlist is not available to your account.';
    end if;
    if v_shortlist.status <> 'draft' then
      raise exception using errcode = 'P0001', message = 'Only an active candidate in a draft shortlist can be removed.';
    end if;
    if v_actor.role = 'sales'::public.platform_role
      and (
        v_shortlist.sales_owner_id <> v_actor.user_id
        or v_hiring.client_archived_at is not null
        or v_hiring.client_sales_owner_id is distinct from v_actor.user_id
      ) then
      raise exception using errcode = '42501', message = 'Sales can edit only their own Client shortlist.';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('client-shortlist-applicant:' || v_lock_applicant_id::text, 0)
    );

    select applicant.* into v_applicant
    from public.applicants as applicant
    where applicant.id = v_lock_applicant_id
      and applicant.organization_id = v_actor.organization_id
    for update;
    if not found then
      raise exception using errcode = '42501', message = 'This Talent profile is not available to your account.';
    end if;

    select item.* into v_item
    from public.client_shortlist_items as item
    where item.id = p_shortlist_item_id
      and item.organization_id = v_actor.organization_id
      and item.shortlist_id = v_shortlist.id
      and item.applicant_id = v_applicant.id
    for update;
    if not found then
      raise exception using errcode = '42501', message = 'This shortlist candidate is not available to your account.';
    end if;
    if v_item.removed_at is not null then
      raise exception using errcode = 'P0001', message = 'Only an active candidate in a draft shortlist can be removed.';
    end if;
    if v_item.updated_at is distinct from p_expected_updated_at then
      raise exception using errcode = 'P0001', message = 'This shortlist candidate changed after it was opened.';
    end if;

    if v_actor.role = 'sales'::public.platform_role
      and (
        v_applicant.archived_at is not null
        or v_applicant.sales_owner_id is distinct from v_actor.user_id
        or v_applicant.sales_owner_id is distinct from v_shortlist.sales_owner_id
        or v_applicant.status <> 'shortlisted'::public.applicant_status
        or exists (
          select 1
          from public.client_shortlist_items as stale_remove_item
          join public.applicants as stale_remove_applicant
            on stale_remove_applicant.id = stale_remove_item.applicant_id
           and stale_remove_applicant.organization_id = stale_remove_item.organization_id
          where stale_remove_item.shortlist_id = v_shortlist.id
            and stale_remove_item.organization_id = v_actor.organization_id
            and stale_remove_item.removed_at is null
            and (
              stale_remove_applicant.archived_at is not null
              or stale_remove_applicant.sales_owner_id is distinct from v_actor.user_id
              or stale_remove_applicant.status <> 'shortlisted'::public.applicant_status
            )
        )
      ) then
      raise exception using errcode = '42501', message = 'Sales can remove only currently owned Talent from an aligned draft.';
    end if;

    update public.client_shortlist_items
    set removed_by_user_id = v_actor.user_id,
        removed_at = pg_catalog.clock_timestamp()
    where id = v_item.id
    returning * into v_item;

    v_next_status := v_applicant.status;
    if v_applicant.archived_at is null
      and v_applicant.status = 'shortlisted'::public.applicant_status then
      update public.applicants
      set status = 'bench_ready'::public.applicant_status
      where id = v_applicant.id
      returning status into v_next_status;
    end if;

    update public.client_shortlists
    set updated_at = pg_catalog.clock_timestamp()
    where id = v_shortlist.id
    returning * into v_shortlist;

    insert into public.audit_events (
      organization_id, actor_user_id, entity_type, entity_id,
      event_type, before_value, after_value, note
    ) values (
      v_actor.organization_id, v_actor.user_id, 'client_shortlist_item', v_item.id,
      'client_shortlist_candidate_removed',
      jsonb_build_object(
        'shortlistId', v_shortlist.id,
        'applicantId', v_applicant.id,
        'applicantStatus', v_applicant.status::text,
        'applicantSalesOwnerId', v_applicant.sales_owner_id,
        'shortlistSalesOwnerId', v_shortlist.sales_owner_id,
        'clientSalesOwnerId', v_hiring.client_sales_owner_id
      ),
      jsonb_build_object(
        'removedAt', v_item.removed_at,
        'applicantStatus', v_next_status::text,
        'applicantSalesOwnerId', v_applicant.sales_owner_id
      ),
      'Authorized internal user removed Talent before the shortlist was sent.'
    );

  elsif v_action = 'send_shortlist' then
    if v_actor.role not in (
      'admin'::public.platform_role,
      'sales_management'::public.platform_role,
      'sales'::public.platform_role
    ) then
      raise exception using errcode = '42501', message = 'Only Sales can send a Client shortlist.';
    end if;

    select shortlist.* into v_shortlist
    from public.client_shortlists as shortlist
    where shortlist.id = p_shortlist_id
      and shortlist.organization_id = v_actor.organization_id;
    if not found then
      raise exception using errcode = '42501', message = 'This shortlist is not available to your account.';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('client-shortlist-request:' || v_shortlist.hiring_request_id::text, 0)
    );
    select shortlist.* into v_shortlist
    from public.client_shortlists as shortlist
    where shortlist.id = p_shortlist_id
      and shortlist.organization_id = v_actor.organization_id
    for update;
    if v_shortlist.status <> 'draft' then
      raise exception using errcode = 'P0001', message = 'This shortlist has already been sent.';
    end if;
    if v_shortlist.updated_at is distinct from p_expected_updated_at then
      raise exception using errcode = 'P0001', message = 'This shortlist changed after it was opened.';
    end if;
    if v_actor.role = 'sales'::public.platform_role
      and v_shortlist.sales_owner_id <> v_actor.user_id then
      raise exception using errcode = '42501', message = 'Sales can send only their own Client shortlist.';
    end if;

    select
      hiring.id as hiring_request_id,
      hiring.client_id,
      hiring.status as hiring_status,
      client.sales_owner_id as client_sales_owner_id
    into v_hiring
    from public.hiring_requests as hiring
    join public.clients as client
      on client.id = hiring.client_id
     and client.organization_id = v_actor.organization_id
     and client.archived_at is null
    where hiring.id = v_shortlist.hiring_request_id
      and hiring.client_id = v_shortlist.client_id
    for update of hiring, client;
    if not found or not private.is_open_hiring_request_status(v_hiring.hiring_status) then
      raise exception using errcode = 'P0001', message = 'The hiring request is no longer open.';
    end if;
    if v_hiring.client_sales_owner_id is distinct from v_shortlist.sales_owner_id then
      raise exception using errcode = 'P0001', message = 'The Client Sales owner changed after this shortlist was created.';
    end if;

    select access.id, access.role into v_pipeline_owner
    from public.platform_users as access
    where access.id = v_shortlist.sales_owner_id
      and access.organization_id = v_actor.organization_id
      and access.active = true
      and access.must_change_password = false
      and access.role = 'sales'::public.platform_role;
    if not found then
      raise exception using errcode = 'P0001', message = 'The assigned Sales owner is no longer active.';
    end if;

    select count(*)::integer into v_item_count
    from public.client_shortlist_items as item
    where item.shortlist_id = v_shortlist.id
      and item.organization_id = v_actor.organization_id
      and item.removed_at is null;
    if v_item_count < 1 then
      raise exception using errcode = 'P0001', message = 'Add at least one candidate before sending the shortlist.';
    end if;

    perform applicant.id
    from public.client_shortlist_items as item
    join public.applicants as applicant
      on applicant.id = item.applicant_id
     and applicant.organization_id = item.organization_id
    where item.shortlist_id = v_shortlist.id
      and item.removed_at is null
    for update of applicant;

    if exists (
      select 1
      from public.client_shortlist_items as item
      join public.applicants as applicant
        on applicant.id = item.applicant_id
       and applicant.organization_id = item.organization_id
      where item.shortlist_id = v_shortlist.id
        and item.removed_at is null
        and (
          applicant.archived_at is not null
          or applicant.sales_owner_id <> v_shortlist.sales_owner_id
          or applicant.status <> 'shortlisted'::public.applicant_status
        )
    ) then
      raise exception using errcode = 'P0001', message = 'A shortlisted Talent profile changed before the shortlist was sent.';
    end if;

    select count(*)::integer into v_recipient_count
    from public.client_portal_memberships as membership
    join public.platform_users as access
      on access.id = membership.user_id
     and access.organization_id = membership.organization_id
     and access.active = true
     and access.must_change_password = false
     and access.role in (
       'client_admin'::public.platform_role,
       'client_reviewer'::public.platform_role
     )
    join public.client_contacts as contact
      on contact.id = membership.client_contact_id
     and contact.client_id = membership.client_id
     and contact.active = true
    where membership.organization_id = v_actor.organization_id
      and membership.client_id = v_shortlist.client_id
      and membership.active = true;
    if v_recipient_count < 1 then
      raise exception using errcode = 'P0001', message = 'Connect an active Client reviewer before sending this shortlist.';
    end if;

    update public.client_shortlists
    set status = 'sent',
        sent_by_user_id = v_actor.user_id,
        sent_at = pg_catalog.clock_timestamp()
    where id = v_shortlist.id
    returning * into v_shortlist;

    update public.applicants as applicant
    set status = 'client_review'::public.applicant_status
    from public.client_shortlist_items as item
    where item.shortlist_id = v_shortlist.id
      and item.removed_at is null
      and applicant.id = item.applicant_id
      and applicant.organization_id = item.organization_id;

    insert into public.client_shortlist_notifications (
      organization_id, recipient_user_id, shortlist_id, notification_type
    )
    select
      v_actor.organization_id,
      membership.user_id,
      v_shortlist.id,
      'client_shortlist_ready'
    from public.client_portal_memberships as membership
    join public.platform_users as access
      on access.id = membership.user_id
     and access.organization_id = membership.organization_id
     and access.active = true
     and access.must_change_password = false
     and access.role in (
       'client_admin'::public.platform_role,
       'client_reviewer'::public.platform_role
     )
    join public.client_contacts as contact
      on contact.id = membership.client_contact_id
     and contact.client_id = membership.client_id
     and contact.active = true
    where membership.organization_id = v_actor.organization_id
      and membership.client_id = v_shortlist.client_id
      and membership.active = true
    on conflict do nothing;

    insert into public.audit_events (
      organization_id, actor_user_id, entity_type, entity_id,
      event_type, before_value, after_value, note
    ) values (
      v_actor.organization_id, v_actor.user_id, 'client_shortlist', v_shortlist.id,
      'client_shortlist_sent',
      jsonb_build_object('status', 'draft', 'candidateCount', v_item_count),
      jsonb_build_object(
        'status', v_shortlist.status,
        'sentAt', v_shortlist.sent_at,
        'candidateCount', v_item_count,
        'recipientCount', v_recipient_count
      ),
      'Shortlist sent to active Client Admin and Client Reviewer memberships.'
    );

  else
    if v_actor.role not in (
      'client_admin'::public.platform_role,
      'client_reviewer'::public.platform_role
    ) then
      raise exception using errcode = '42501', message = 'Only an eligible Client reviewer can respond to a candidate.';
    end if;

    select
      shortlist.hiring_request_id,
      shortlist.client_id,
      shortlist.id,
      item.applicant_id
    into
      v_lock_hiring_request_id,
      v_lock_client_id,
      v_lock_shortlist_id,
      v_lock_applicant_id
    from public.client_shortlist_items as item
    join public.client_shortlists as shortlist
      on shortlist.id = item.shortlist_id
     and shortlist.organization_id = item.organization_id
    where item.id = p_shortlist_item_id
      and item.organization_id = v_actor.organization_id
      and shortlist.client_id = v_actor.client_id
      and shortlist.organization_id = v_actor.organization_id;
    if not found then
      raise exception using errcode = '42501', message = 'This shortlisted candidate is not available to your Client account.';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('client-shortlist-request:' || v_lock_hiring_request_id::text, 0)
    );

    select
      hiring.id as hiring_request_id,
      hiring.client_id,
      hiring.status as hiring_status,
      client.sales_owner_id as client_sales_owner_id,
      client.archived_at as client_archived_at
    into v_hiring
    from public.hiring_requests as hiring
    join public.clients as client
      on client.id = hiring.client_id
     and client.organization_id = v_actor.organization_id
    where hiring.id = v_lock_hiring_request_id
      and hiring.client_id = v_lock_client_id
    for update of hiring, client;
    if not found
      or v_hiring.client_archived_at is not null
      or not private.is_open_hiring_request_status(v_hiring.hiring_status) then
      raise exception using errcode = 'P0001', message = 'This hiring request is no longer open for Client review.';
    end if;

    select shortlist.* into v_shortlist
    from public.client_shortlists as shortlist
    where shortlist.id = v_lock_shortlist_id
      and shortlist.organization_id = v_actor.organization_id
      and shortlist.hiring_request_id = v_hiring.hiring_request_id
      and shortlist.client_id = v_hiring.client_id
      and shortlist.client_id = v_actor.client_id
      and shortlist.status = 'sent'
    for update;
    if not found then
      raise exception using errcode = '42501', message = 'This shortlist is not available to your Client account.';
    end if;

    select access.id, access.role into v_pipeline_owner
    from public.platform_users as access
    where access.id = v_hiring.client_sales_owner_id
      and access.organization_id = v_actor.organization_id
      and access.active = true
      and access.must_change_password = false
      and access.role = 'sales'::public.platform_role;
    if not found then
      raise exception using errcode = 'P0001', message = 'The Client does not have an active Sales owner for this response.';
    end if;
    v_pipeline_owner_id := v_pipeline_owner.id;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('client-shortlist-applicant:' || v_lock_applicant_id::text, 0)
    );

    select applicant.* into v_applicant
    from public.applicants as applicant
    where applicant.id = v_lock_applicant_id
      and applicant.organization_id = v_actor.organization_id
    for update;
    if not found or v_applicant.archived_at is not null
      or v_applicant.sales_owner_id <> v_pipeline_owner_id
      or v_applicant.status <> 'client_review'::public.applicant_status then
      raise exception using errcode = 'P0001', message = 'This candidate is no longer awaiting Client review.';
    end if;

    select item.* into v_item
    from public.client_shortlist_items as item
    where item.id = p_shortlist_item_id
      and item.organization_id = v_actor.organization_id
      and item.shortlist_id = v_shortlist.id
      and item.applicant_id = v_applicant.id
      and item.removed_at is null
    for update;
    if not found then
      raise exception using errcode = '42501', message = 'This shortlisted candidate is not available to your Client account.';
    end if;
    if v_item.client_response is not null then
      raise exception using errcode = 'P0001', message = 'A response has already been recorded for this candidate.';
    end if;
    if v_item.updated_at is distinct from p_expected_updated_at then
      raise exception using errcode = 'P0001', message = 'This shortlisted candidate changed after it was opened.';
    end if;

    update public.client_shortlist_items
    set client_response = v_response,
        response_by_user_id = v_actor.user_id,
        responded_at = pg_catalog.clock_timestamp()
    where id = v_item.id
    returning * into v_item;

    v_next_status := case v_response
      when 'request_interview' then 'interviewing'::public.applicant_status
      when 'interested' then 'client_review'::public.applicant_status
      else 'bench_ready'::public.applicant_status
    end;
    update public.applicants
    set status = v_next_status
    where id = v_applicant.id;

    insert into public.client_shortlist_notifications (
      organization_id, recipient_user_id, shortlist_id, shortlist_item_id,
      notification_type
    ) values (
      v_actor.organization_id,
      v_pipeline_owner_id,
      v_shortlist.id,
      v_item.id,
      'client_shortlist_response'
    ) on conflict do nothing;

    insert into public.audit_events (
      organization_id, actor_user_id, entity_type, entity_id,
      event_type, before_value, after_value, note
    ) values (
      v_actor.organization_id, v_actor.user_id, 'client_shortlist_item', v_item.id,
      'client_shortlist_response_recorded',
      jsonb_build_object(
        'clientResponse', null,
        'applicantStatus', v_applicant.status::text
      ),
      jsonb_build_object(
        'clientResponse', v_item.client_response,
        'respondedAt', v_item.responded_at,
        'applicantStatus', v_next_status::text
      ),
      'Client response recorded without a free-text note.'
    );
  end if;

  insert into public.client_shortlist_operations (
    operation_request_id,
    organization_id,
    actor_user_id,
    action,
    hiring_request_id,
    applicant_id,
    shortlist_id,
    shortlist_item_id,
    client_response,
    request_fingerprint
  ) values (
    p_request_id,
    v_actor.organization_id,
    v_actor.user_id,
    v_action,
    case when v_action = 'add_candidate' then p_hiring_request_id else v_shortlist.hiring_request_id end,
    case when v_action = 'add_candidate' then p_applicant_id else coalesce(v_item.applicant_id, p_applicant_id) end,
    coalesce(v_shortlist.id, p_shortlist_id),
    coalesce(v_item.id, p_shortlist_item_id),
    v_response,
    v_fingerprint
  );

  return private.client_shortlist_workspace_json(
    v_actor.organization_id, v_actor.role, v_actor.user_id, v_actor.client_id
  );
end;
$$;

revoke all on function public.change_client_shortlist(
  uuid, uuid, text, timestamptz, uuid, uuid, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.change_client_shortlist(
  uuid, uuid, text, timestamptz, uuid, uuid, uuid, uuid, text
) to service_role;

-- Keep shortlist and Client-response audit history out of Client, Talent,
-- Billing, and ordinary Sales table reads. Sales receives its own live state
-- through the scoped workspace RPC; Admin and Sales Management retain audit
-- oversight through the existing audit table.
drop policy if exists "authorized internal users can read audit history" on public.audit_events;
create policy "authorized internal users can read audit history"
on public.audit_events for select to authenticated
using (
  private.is_internal_soro_user()
  and organization_id = private.current_soro_organization_id()
  and case
    when entity_type = 'employee_payroll' then
      private.current_soro_role() = 'admin'::public.platform_role
    when entity_type = 'employee' and event_type = 'employee_payment_route_update' then
      private.current_soro_role() = 'admin'::public.platform_role
    when entity_type in ('client_shortlist', 'client_shortlist_item') then
      private.current_soro_role() in (
        'admin'::public.platform_role,
        'sales_management'::public.platform_role
      )
    when entity_type in (
      'talent_payout',
      'talent_portal_access',
      'talent_attendance',
      'talent_time_off',
      'talent_review_queue',
      'talent_verification',
      'available_talent_bench',
      'available_talent_bench_settings'
    ) then
      private.current_soro_role() in (
        'admin'::public.platform_role,
        'talent_management'::public.platform_role
      )
    else true
  end
);

comment on table public.client_shortlists is
  'Service-only, organization-scoped shortlist rounds tied to one Client hiring request and one Sales pipeline owner.';
comment on table public.client_shortlist_items is
  'Service-only candidate shortlist history with removal markers and one constrained Client response.';
comment on table public.client_shortlist_notifications is
  'Durable recipient-scoped notifications for sent shortlists and Client responses.';
comment on table public.client_shortlist_operations is
  'Idempotency ledger for atomic shortlist edits, sending, and Client responses.';
comment on function private.is_open_hiring_request_status(text) is
  'Positive allowlist for hiring-request states that may accept or send shortlist rounds.';
comment on function public.get_client_shortlist_workspace(uuid) is
  'Service-only role-scoped shortlist workspace with a client-safe Talent projection.';
comment on function public.change_client_shortlist(uuid, uuid, text, timestamptz, uuid, uuid, uuid, uuid, text) is
  'Service-only atomic and audited shortlist workflow with same-organization ownership, active membership, and idempotency enforcement.';
