-- Soro Operations: real employee tasks and durable assignment notifications.
--
-- Task and notification scope is always derived from the authenticated
-- platform user. Browser clients cannot choose an organization or role, and
-- the underlying tables are available only to the server-side service role.

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  title text not null check (char_length(btrim(title)) between 1 and 160),
  related_label text check (
    related_label is null
    or char_length(btrim(related_label)) between 1 and 200
  ),
  due_date date,
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  status text not null default 'open' check (status in ('open', 'completed')),
  created_by_user_id uuid not null,
  assigned_to_user_id uuid not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tasks_creator_organization_fkey
    foreign key (created_by_user_id, organization_id)
    references public.platform_users (id, organization_id) on delete restrict,
  constraint tasks_assignee_organization_fkey
    foreign key (assigned_to_user_id, organization_id)
    references public.platform_users (id, organization_id) on delete restrict,
  constraint tasks_completion_consistent check (
    (status = 'open' and completed_at is null)
    or (status = 'completed' and completed_at is not null)
  )
);

create unique index if not exists tasks_id_organization_unique
  on public.tasks (id, organization_id);
create index if not exists tasks_assignee_status_due_idx
  on public.tasks (organization_id, assigned_to_user_id, status, due_date, created_at desc);
create index if not exists tasks_creator_idx
  on public.tasks (organization_id, created_by_user_id, created_at desc);

drop trigger if exists tasks_updated_at on public.tasks;
create trigger tasks_updated_at
before update on public.tasks
for each row execute function public.set_updated_at();

create table if not exists public.task_notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  recipient_user_id uuid not null,
  task_id uuid not null,
  notification_type text not null default 'task_assigned'
    check (notification_type in ('task_assigned')),
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint task_notifications_recipient_organization_fkey
    foreign key (recipient_user_id, organization_id)
    references public.platform_users (id, organization_id) on delete cascade,
  constraint task_notifications_task_organization_fkey
    foreign key (task_id, organization_id)
    references public.tasks (id, organization_id) on delete cascade,
  unique (task_id, recipient_user_id, notification_type)
);

create index if not exists task_notifications_recipient_unread_idx
  on public.task_notifications (organization_id, recipient_user_id, read_at, created_at desc);

create table if not exists public.task_operations (
  idempotency_key uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  actor_user_id uuid not null,
  task_id uuid not null,
  action text not null check (action = 'create_task'),
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  constraint task_operations_actor_organization_fkey
    foreign key (actor_user_id, organization_id)
    references public.platform_users (id, organization_id) on delete restrict,
  constraint task_operations_task_organization_fkey
    foreign key (task_id, organization_id)
    references public.tasks (id, organization_id) on delete restrict
);

create index if not exists task_operations_actor_idx
  on public.task_operations (organization_id, actor_user_id, created_at desc);

alter table public.tasks enable row level security;
alter table public.task_notifications enable row level security;
alter table public.task_operations enable row level security;

revoke all on table public.tasks from public, anon, authenticated;
revoke all on table public.task_notifications from public, anon, authenticated;
revoke all on table public.task_operations from public, anon, authenticated;
grant select, insert, update on table public.tasks to service_role;
grant select, insert, update on table public.task_notifications to service_role;
grant select, insert on table public.task_operations to service_role;

create or replace function private.task_actor(p_actor_user_id uuid)
returns table (
  user_id uuid,
  organization_id uuid,
  role public.platform_role,
  display_name text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
begin
  if p_actor_user_id is null then
    raise exception using errcode = '22023', message = 'A signed-in employee account is required.';
  end if;

  return query
  select
    access.id,
    access.organization_id,
    access.role,
    coalesce(nullif(btrim(access.display_name), ''), 'Soro employee')
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
      'billing'::public.platform_role
    )
  limit 1;

  if not found then
    raise exception using errcode = '42501', message = 'An active internal employee account is required.';
  end if;
end;
$$;

revoke all on function private.task_actor(uuid) from public, anon, authenticated;

create or replace function private.task_workspace_json(
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_actor_role public.platform_role
)
returns jsonb
language sql
security definer
set search_path = pg_catalog, public, private
as $$
  select jsonb_build_object(
    'summary', jsonb_build_object(
      'open', (
        select count(*)::integer
        from public.tasks as task
        where task.organization_id = p_organization_id
          and task.assigned_to_user_id = p_actor_user_id
          and task.status = 'open'
      ),
      'overdue', (
        select count(*)::integer
        from public.tasks as task
        where task.organization_id = p_organization_id
          and task.assigned_to_user_id = p_actor_user_id
          and task.status = 'open'
          and task.due_date < (pg_catalog.clock_timestamp() at time zone 'America/Chicago')::date
      ),
      'urgentUnread', (
        select count(*)::integer
        from public.task_notifications as notification
        join public.tasks as task
          on task.id = notification.task_id
         and task.organization_id = notification.organization_id
        where notification.organization_id = p_organization_id
          and notification.recipient_user_id = p_actor_user_id
          and notification.read_at is null
      )
    ),
    'tasks', coalesce((
      select jsonb_agg(
        task_row.payload
        order by task_row.status_rank, task_row.due_missing, task_row.due_date, task_row.created_at desc, task_row.task_id
      )
      from (
        select
          task.id as task_id,
          task.created_at,
          task.due_date,
          case when task.status = 'open' then 0 else 1 end as status_rank,
          case when task.due_date is null then 1 else 0 end as due_missing,
          jsonb_build_object(
            'taskId', task.id,
            'title', task.title,
            'relatedLabel', task.related_label,
            'dueDate', task.due_date,
            'priority', task.priority,
            'status', task.status,
            'assignedTo', jsonb_build_object(
              'userId', assignee.id,
              'name', coalesce(nullif(btrim(assignee.display_name), ''), 'Soro employee')
            ),
            'createdBy', jsonb_build_object(
              'userId', creator.id,
              'name', coalesce(nullif(btrim(creator.display_name), ''), 'Soro employee')
            ),
            'createdAt', task.created_at,
            'updatedAt', task.updated_at,
            'completedAt', task.completed_at
          ) as payload
        from public.tasks as task
        join public.platform_users as assignee
          on assignee.id = task.assigned_to_user_id
         and assignee.organization_id = task.organization_id
        join public.platform_users as creator
          on creator.id = task.created_by_user_id
         and creator.organization_id = task.organization_id
        where task.organization_id = p_organization_id
          and task.assigned_to_user_id = p_actor_user_id
        order by
          case when task.status = 'open' then 0 else 1 end,
          case when task.due_date is null then 1 else 0 end,
          task.due_date,
          task.created_at desc,
          task.id
        limit 1000
      ) as task_row
    ), '[]'::jsonb),
    'notifications', coalesce((
      select jsonb_agg(
        notification_row.payload
        order by notification_row.unread_rank, notification_row.created_at desc, notification_row.notification_id
      )
      from (
        select
          notification.id as notification_id,
          notification.created_at,
          case when notification.read_at is null then 0 else 1 end as unread_rank,
          jsonb_build_object(
            'notificationId', notification.id,
            'type', notification.notification_type,
            'taskId', task.id,
            'title', 'Task assigned',
            'message', task.title,
            'relatedLabel', task.related_label,
            'priority', task.priority,
            'view', 'tasks',
            'createdAt', notification.created_at,
            'readAt', notification.read_at
          ) as payload
        from public.task_notifications as notification
        join public.tasks as task
          on task.id = notification.task_id
         and task.organization_id = notification.organization_id
        where notification.organization_id = p_organization_id
          and notification.recipient_user_id = p_actor_user_id
        order by
          case when notification.read_at is null then 0 else 1 end,
          notification.created_at desc,
          notification.id
        limit 1000
      ) as notification_row
    ), '[]'::jsonb),
    'assignees', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'userId', assignee.id,
          'name', coalesce(nullif(btrim(assignee.display_name), ''), 'Soro employee'),
          'role', assignee.role::text
        ) order by
          case when assignee.id = p_actor_user_id then 0 else 1 end,
          lower(coalesce(nullif(btrim(assignee.display_name), ''), 'Soro employee')),
          assignee.id
      )
      from public.platform_users as assignee
      where assignee.organization_id = p_organization_id
        and assignee.active = true
        and assignee.must_change_password = false
        and assignee.role in (
          'admin'::public.platform_role,
          'sales_management'::public.platform_role,
          'sales'::public.platform_role,
          'talent_management'::public.platform_role,
          'billing'::public.platform_role
        )
        and (
          p_actor_role = 'admin'::public.platform_role
          or assignee.id = p_actor_user_id
        )
    ), '[]'::jsonb)
  );
$$;

revoke all on function private.task_workspace_json(uuid, uuid, public.platform_role)
  from public, anon, authenticated;

create or replace function public.get_task_workspace(p_actor_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_actor record;
begin
  select * into v_actor from private.task_actor(p_actor_user_id);
  return private.task_workspace_json(v_actor.organization_id, v_actor.user_id, v_actor.role);
end;
$$;

revoke all on function public.get_task_workspace(uuid) from public, anon, authenticated;
grant execute on function public.get_task_workspace(uuid) to service_role;

create or replace function public.create_task(
  p_actor_user_id uuid,
  p_idempotency_key uuid,
  p_title text,
  p_related_label text,
  p_due_date date,
  p_assigned_to_user_id uuid,
  p_priority text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_actor record;
  v_assignee record;
  v_title text := nullif(btrim(p_title), '');
  v_related_label text := nullif(btrim(p_related_label), '');
  v_priority text := lower(nullif(btrim(p_priority), ''));
  v_fingerprint text;
  v_existing public.task_operations%rowtype;
  v_task public.tasks%rowtype;
begin
  select * into v_actor from private.task_actor(p_actor_user_id);

  if p_idempotency_key is null then
    raise exception using errcode = '22023', message = 'An idempotency key is required.';
  end if;
  if v_title is null or char_length(v_title) > 160 then
    raise exception using errcode = '22023', message = 'A task title between 1 and 160 characters is required.';
  end if;
  if v_related_label is not null and char_length(v_related_label) > 200 then
    raise exception using errcode = '22023', message = 'The related label must be 200 characters or fewer.';
  end if;
  if v_priority is null or v_priority not in ('low', 'normal', 'high', 'urgent') then
    raise exception using errcode = '22023', message = 'Choose a supported task priority.';
  end if;
  if p_assigned_to_user_id is null then
    raise exception using errcode = '22023', message = 'Choose a task assignee.';
  end if;
  if v_actor.role <> 'admin'::public.platform_role and p_assigned_to_user_id <> v_actor.user_id then
    raise exception using errcode = '42501', message = 'Only Administrators can assign tasks to another employee.';
  end if;

  select
    assignee.id,
    assignee.organization_id,
    assignee.role,
    assignee.display_name
  into v_assignee
  from public.platform_users as assignee
  where assignee.id = p_assigned_to_user_id
    and assignee.organization_id = v_actor.organization_id
    and assignee.active = true
    and assignee.must_change_password = false
    and assignee.role in (
      'admin'::public.platform_role,
      'sales_management'::public.platform_role,
      'sales'::public.platform_role,
      'talent_management'::public.platform_role,
      'billing'::public.platform_role
    )
  limit 1;

  if not found then
    raise exception using errcode = '42501', message = 'The selected active employee is not available in this organization.';
  end if;

  v_fingerprint := encode(extensions.digest(jsonb_build_object(
    'action', 'create_task',
    'organizationId', v_actor.organization_id,
    'actorUserId', v_actor.user_id,
    'assignedTo', v_assignee.id,
    'title', v_title,
    'relatedLabel', v_related_label,
    'dueDate', p_due_date,
    'priority', v_priority
  )::text, 'sha256'), 'hex');

  perform pg_advisory_xact_lock(
    pg_catalog.hashtextextended('soro-task-create:' || p_idempotency_key::text, 0)
  );

  select * into v_existing
  from public.task_operations as operation
  where operation.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.organization_id <> v_actor.organization_id
      or v_existing.actor_user_id <> v_actor.user_id
      or v_existing.action <> 'create_task'
      or v_existing.request_fingerprint <> v_fingerprint then
      raise exception using errcode = '23505', message = 'This idempotency key was already used for another task request.';
    end if;
    return private.task_workspace_json(v_actor.organization_id, v_actor.user_id, v_actor.role);
  end if;

  insert into public.tasks (
    organization_id,
    title,
    related_label,
    due_date,
    priority,
    status,
    created_by_user_id,
    assigned_to_user_id
  ) values (
    v_actor.organization_id,
    v_title,
    v_related_label,
    p_due_date,
    v_priority,
    'open',
    v_actor.user_id,
    v_assignee.id
  ) returning * into v_task;

  insert into public.task_notifications (
    organization_id,
    recipient_user_id,
    task_id,
    notification_type
  ) values (
    v_actor.organization_id,
    v_assignee.id,
    v_task.id,
    'task_assigned'
  );

  insert into public.task_operations (
    idempotency_key,
    organization_id,
    actor_user_id,
    task_id,
    action,
    request_fingerprint
  ) values (
    p_idempotency_key,
    v_actor.organization_id,
    v_actor.user_id,
    v_task.id,
    'create_task',
    v_fingerprint
  );

  insert into public.audit_events (
    organization_id,
    actor_user_id,
    entity_type,
    entity_id,
    event_type,
    after_value,
    note
  ) values (
    v_actor.organization_id,
    v_actor.user_id,
    'task',
    v_task.id,
    'task_created',
    jsonb_build_object(
      'assignedToUserId', v_task.assigned_to_user_id,
      'priority', v_task.priority,
      'status', v_task.status,
      'dueDate', v_task.due_date
    ),
    'Task created and assignment notification recorded.'
  );

  return private.task_workspace_json(v_actor.organization_id, v_actor.user_id, v_actor.role);
end;
$$;

revoke all on function public.create_task(uuid, uuid, text, text, date, uuid, text)
  from public, anon, authenticated;
grant execute on function public.create_task(uuid, uuid, text, text, date, uuid, text)
  to service_role;

create or replace function public.update_my_task(
  p_actor_user_id uuid,
  p_task_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_actor record;
  v_task public.tasks%rowtype;
  v_status text := lower(nullif(btrim(p_status), ''));
  v_changed boolean := false;
begin
  select * into v_actor from private.task_actor(p_actor_user_id);

  if p_task_id is null or v_status is null or v_status not in ('open', 'completed') then
    raise exception using errcode = '22023', message = 'Choose an available task status.';
  end if;

  select * into v_task
  from public.tasks as task
  where task.id = p_task_id
    and task.organization_id = v_actor.organization_id
    and task.assigned_to_user_id = v_actor.user_id
  for update;

  if not found then
    raise exception using errcode = '42501', message = 'This task is not assigned to your account.';
  end if;

  if v_task.status <> v_status then
    update public.tasks
    set
      status = v_status,
      completed_at = case when v_status = 'completed' then pg_catalog.clock_timestamp() else null end
    where id = v_task.id
      and organization_id = v_actor.organization_id
    returning * into v_task;
    v_changed := true;
  end if;

  if v_status = 'completed' then
    update public.task_notifications
    set read_at = coalesce(read_at, pg_catalog.clock_timestamp())
    where organization_id = v_actor.organization_id
      and recipient_user_id = v_actor.user_id
      and task_id = v_task.id;
  end if;

  if v_changed then
    insert into public.audit_events (
      organization_id,
      actor_user_id,
      entity_type,
      entity_id,
      event_type,
      after_value,
      note
    ) values (
      v_actor.organization_id,
      v_actor.user_id,
      'task',
      v_task.id,
      case when v_status = 'completed' then 'task_completed' else 'task_reopened' end,
      jsonb_build_object('status', v_task.status, 'completedAt', v_task.completed_at),
      case when v_status = 'completed' then 'Assigned employee completed the task.' else 'Assigned employee reopened the task.' end
    );
  end if;

  return private.task_workspace_json(v_actor.organization_id, v_actor.user_id, v_actor.role);
end;
$$;

revoke all on function public.update_my_task(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.update_my_task(uuid, uuid, text)
  to service_role;

create or replace function public.mark_my_task_notification_read(
  p_actor_user_id uuid,
  p_notification_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_actor record;
begin
  select * into v_actor from private.task_actor(p_actor_user_id);

  if p_notification_id is null then
    raise exception using errcode = '22023', message = 'Choose a notification.';
  end if;

  update public.task_notifications as notification
  set read_at = coalesce(notification.read_at, pg_catalog.clock_timestamp())
  where notification.id = p_notification_id
    and notification.organization_id = v_actor.organization_id
    and notification.recipient_user_id = v_actor.user_id;

  if not found then
    raise exception using errcode = '42501', message = 'This notification is not available to your account.';
  end if;

  return private.task_workspace_json(v_actor.organization_id, v_actor.user_id, v_actor.role);
end;
$$;

revoke all on function public.mark_my_task_notification_read(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.mark_my_task_notification_read(uuid, uuid)
  to service_role;

create or replace function public.mark_all_my_task_notifications_read(p_actor_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_actor record;
begin
  select * into v_actor from private.task_actor(p_actor_user_id);

  update public.task_notifications as notification
  set read_at = pg_catalog.clock_timestamp()
  where notification.organization_id = v_actor.organization_id
    and notification.recipient_user_id = v_actor.user_id
    and notification.read_at is null;

  return private.task_workspace_json(v_actor.organization_id, v_actor.user_id, v_actor.role);
end;
$$;

revoke all on function public.mark_all_my_task_notifications_read(uuid)
  from public, anon, authenticated;
grant execute on function public.mark_all_my_task_notifications_read(uuid)
  to service_role;

comment on table public.tasks is
  'Organization-scoped employee tasks. Every visible or mutable task is assigned to the signed-in employee.';
comment on table public.task_notifications is
  'Durable, recipient-scoped notifications created when a task is assigned.';
comment on table public.task_operations is
  'Service-only idempotency ledger preventing duplicate task creation.';
comment on function public.get_task_workspace(uuid) is
  'Service-only task workspace derived from the authenticated internal employee.';
comment on function public.create_task(uuid, uuid, text, text, date, uuid, text) is
  'Service-only idempotent task creation. Admin may assign active same-organization employees; other internal roles may assign only themselves.';
comment on function public.update_my_task(uuid, uuid, text) is
  'Service-only complete or reopen action limited to the task assignee.';
comment on function public.mark_my_task_notification_read(uuid, uuid) is
  'Service-only notification read action limited to the recipient.';
comment on function public.mark_all_my_task_notifications_read(uuid) is
  'Service-only bulk read action limited to the signed-in recipient.';
