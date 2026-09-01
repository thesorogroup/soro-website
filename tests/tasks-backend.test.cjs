const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

process.env.SUPABASE_URL = 'https://tasks-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const root = path.resolve(__dirname, '..');
const backend = require(path.join(root, 'netlify', 'functions', 'tasks.js'));
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

const actorUserId = '11111111-1111-4111-8111-111111111111';
const assigneeUserId = '22222222-2222-4222-8222-222222222222';
const taskId = '33333333-3333-4333-8333-333333333333';
const notificationId = '44444444-4444-4444-8444-444444444444';
const idempotencyKey = '55555555-5555-4555-8555-555555555555';
const organizationId = '66666666-6666-4666-8666-666666666666';

const TOP_LEVEL_KEYS = Object.freeze(['tasks', 'notifications', 'assignees', 'summary']);
const TASK_KEYS = Object.freeze([
  'taskId', 'title', 'relatedLabel', 'dueDate', 'priority', 'status',
  'assignedTo', 'createdBy', 'createdAt', 'updatedAt', 'completedAt'
]);
const PERSON_KEYS = Object.freeze(['userId', 'name']);
const NOTIFICATION_KEYS = Object.freeze([
  'notificationId', 'type', 'taskId', 'title', 'message', 'relatedLabel',
  'priority', 'view', 'createdAt', 'readAt'
]);
const ASSIGNEE_KEYS = Object.freeze(['userId', 'name', 'role']);
const SUMMARY_KEYS = Object.freeze(['open', 'overdue', 'urgentUnread']);

function response(data, status = 200) {
  return new Response(data === undefined ? '' : JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function event(overrides = {}) {
  return {
    httpMethod: 'GET',
    headers: { authorization: 'Bearer signed-in-token' },
    queryStringParameters: {},
    multiValueQueryStringParameters: {},
    rawQueryString: '',
    ...overrides
  };
}

function taskRow(overrides = {}) {
  return {
    taskId,
    title: 'Review applicant references',
    relatedLabel: 'Taylor Applicant',
    dueDate: '2026-09-02',
    priority: 'high',
    status: 'open',
    assignedTo: { userId: actorUserId, name: 'Matt Johnson' },
    createdBy: { userId: assigneeUserId, name: 'Jordan Reed' },
    createdAt: '2026-08-31T14:00:00.000Z',
    updatedAt: '2026-08-31T14:00:00.000Z',
    completedAt: null,
    ...overrides
  };
}

function notificationRow(overrides = {}) {
  return {
    notificationId,
    type: 'task_assigned',
    taskId,
    title: 'Task assigned',
    message: 'Review applicant references',
    relatedLabel: 'Taylor Applicant',
    priority: 'high',
    view: 'tasks',
    createdAt: '2026-08-31T14:00:00.000Z',
    readAt: null,
    ...overrides
  };
}

function workspacePayload(overrides = {}) {
  return {
    tasks: [taskRow()],
    notifications: [notificationRow()],
    assignees: [
      { userId: actorUserId, name: 'Matt Johnson', role: 'admin' },
      { userId: assigneeUserId, name: 'Jordan Reed', role: 'talent_management' }
    ],
    summary: { open: 1, overdue: 0, urgentUnread: 1 },
    ...overrides
  };
}

function installFetch(t, options = {}) {
  const {
    user = { id: actorUserId },
    authStatus = 200,
    rpcStatus = 200,
    rpcBody = workspacePayload()
  } = options;
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, requestOptions = {}) => {
    const call = { url: String(url), options: requestOptions };
    calls.push(call);
    if (call.url.endsWith('/auth/v1/user')) {
      return response(
        typeof user === 'function' ? user(call) : user,
        typeof authStatus === 'function' ? authStatus(call) : authStatus
      );
    }
    if (call.url.includes('/rest/v1/rpc/')) {
      return response(
        typeof rpcBody === 'function' ? rpcBody(call) : rpcBody,
        typeof rpcStatus === 'function' ? rpcStatus(call) : rpcStatus
      );
    }
    throw new Error(`Unexpected fetch: ${call.url}`);
  };
  t.after(() => { global.fetch = originalFetch; });
  return calls;
}

function bodyOf(result) {
  return JSON.parse(result.body);
}

test('GET authenticates once and derives all task, notification, assignee, role, and organization scope from the actor', async t => {
  const calls = installFetch(t);
  const result = await backend.handler(event());

  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.headers.Pragma, 'no-cache');
  assert.equal(result.headers.Vary, 'Authorization');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://tasks-test.supabase.co/auth/v1/user');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer signed-in-token');
  assert.equal(calls[1].url, 'https://tasks-test.supabase.co/rest/v1/rpc/get_task_workspace');
  assert.deepEqual(JSON.parse(calls[1].options.body), { p_actor_user_id: actorUserId });
  assert.equal(calls[1].options.headers.Authorization, 'Bearer test-service-role-key');
  assert.deepEqual(Object.keys(bodyOf(result)).sort(), [...TOP_LEVEL_KEYS].sort());
});

test('GET rejects every client-selected scope, filter, role, and body before authentication', async t => {
  const calls = installFetch(t);
  const attempts = [
    event({ queryStringParameters: { organizationId } }),
    event({ queryStringParameters: { assignedTo: assigneeUserId } }),
    event({ queryStringParameters: { status: 'open' } }),
    event({ queryStringParameters: { role: 'admin' } }),
    event({ multiValueQueryStringParameters: { taskId: [taskId] } }),
    event({ rawQueryString: `taskId=${taskId}` }),
    event({ body: JSON.stringify({ organizationId }) })
  ];

  for (const request of attempts) {
    const result = await backend.handler(request);
    assert.equal(result.statusCode, 400);
    assert.equal(bodyOf(result).code, 'unsupported_scope');
  }
  assert.equal(calls.length, 0);
});

test('public response uses exact safe allowlists and strips organization, employee contact, and internal operation data', async t => {
  installFetch(t, {
    rpcBody: workspacePayload({
      organizationId,
      actorUserId,
      tasks: [taskRow({
        organizationId,
        assigneeEmail: 'matt@thesorogroup.com',
        creatorPhone: '+1 555 0100',
        auditNote: 'private audit detail',
        operationRequestId: idempotencyKey,
        assignedTo: { userId: actorUserId, name: 'Matt Johnson', email: 'matt@thesorogroup.com' },
        createdBy: { userId: assigneeUserId, name: 'Jordan Reed', phone: '+1 555 0100' }
      })],
      notifications: [notificationRow({ recipientUserId: actorUserId, organizationId })],
      assignees: [{
        userId: actorUserId,
        name: 'Matt Johnson',
        role: 'admin',
        email: 'matt@thesorogroup.com',
        phone: '+1 555 0100'
      }]
    })
  });

  const result = await backend.handler(event());
  const payload = bodyOf(result);

  assert.equal(result.statusCode, 200);
  assert.deepEqual(Object.keys(payload).sort(), [...TOP_LEVEL_KEYS].sort());
  assert.deepEqual(Object.keys(payload.summary).sort(), [...SUMMARY_KEYS].sort());
  assert.deepEqual(Object.keys(payload.tasks[0]).sort(), [...TASK_KEYS].sort());
  assert.deepEqual(Object.keys(payload.tasks[0].assignedTo).sort(), [...PERSON_KEYS].sort());
  assert.deepEqual(Object.keys(payload.tasks[0].createdBy).sort(), [...PERSON_KEYS].sort());
  assert.deepEqual(Object.keys(payload.notifications[0]).sort(), [...NOTIFICATION_KEYS].sort());
  assert.deepEqual(Object.keys(payload.assignees[0]).sort(), [...ASSIGNEE_KEYS].sort());
  for (const privateValue of [
    organizationId,
    'matt@thesorogroup.com',
    '+1 555 0100',
    'private audit detail',
    idempotencyKey
  ]) {
    assert.equal(result.body.includes(privateValue), false, `must not expose ${privateValue}`);
  }
});

test('POST create_task accepts only the frontend contract and passes one idempotency key to the service RPC', async t => {
  const calls = installFetch(t);
  const result = await backend.handler(event({
    httpMethod: 'POST',
    body: JSON.stringify({
      action: 'create_task',
      title: '  Review applicant references  ',
      relatedLabel: '  Taylor Applicant  ',
      dueDate: '2026-09-02',
      assignedTo: assigneeUserId,
      priority: 'HIGH',
      idempotencyKey
    })
  }));

  assert.equal(result.statusCode, 200);
  const rpcCall = calls.find(call => call.url.endsWith('/rest/v1/rpc/create_task'));
  assert.ok(rpcCall, 'task creation must use the service-only create RPC');
  assert.deepEqual(JSON.parse(rpcCall.options.body), {
    p_actor_user_id: actorUserId,
    p_idempotency_key: idempotencyKey,
    p_title: 'Review applicant references',
    p_related_label: 'Taylor Applicant',
    p_due_date: '2026-09-02',
    p_assigned_to_user_id: assigneeUserId,
    p_priority: 'high'
  });
});

test('POST permits blank optional context and due date without inventing data', async t => {
  const calls = installFetch(t);
  const result = await backend.handler(event({
    httpMethod: 'POST',
    body: JSON.stringify({
      action: 'create_task',
      title: 'Follow up',
      relatedLabel: '',
      dueDate: null,
      assignedTo: actorUserId,
      priority: 'normal',
      idempotencyKey
    })
  }));

  assert.equal(result.statusCode, 200);
  const rpcBody = JSON.parse(calls.find(call => call.url.endsWith('/rest/v1/rpc/create_task')).options.body);
  assert.equal(rpcBody.p_related_label, null);
  assert.equal(rpcBody.p_due_date, null);
});

test('POST rejects scope, status, creator, notification, malformed dates, unsupported priorities, and extra keys before authentication', async t => {
  const valid = {
    action: 'create_task',
    title: 'Review applicant references',
    relatedLabel: null,
    dueDate: '2026-09-02',
    assignedTo: actorUserId,
    priority: 'normal',
    idempotencyKey
  };
  const attempts = [
    {},
    { ...valid, organizationId },
    { ...valid, createdBy: actorUserId },
    { ...valid, status: 'completed' },
    { ...valid, completedAt: '2026-08-31T14:00:00Z' },
    { ...valid, notificationId },
    { ...valid, dueDate: '09/02/2026' },
    { ...valid, dueDate: '2026-02-30' },
    { ...valid, priority: 'critical' },
    { ...valid, assignedTo: 'not-a-uuid' },
    { ...valid, idempotencyKey: 'not-a-uuid' },
    { ...valid, relatedLabel: { private: true } },
    { ...valid, title: '' }
  ];

  const calls = installFetch(t);
  for (const body of attempts) {
    const result = await backend.handler(event({ httpMethod: 'POST', body: JSON.stringify(body) }));
    assert.equal(result.statusCode, 400, JSON.stringify(body));
  }
  assert.equal(calls.length, 0, 'invalid task input must not authenticate or call a database RPC');
});

test('PATCH routes own task updates, one-notification read, and all-notifications read through exact RPC bodies', async t => {
  const calls = installFetch(t);
  const requests = [
    {
      body: { action: 'update_task', taskId, status: 'completed' },
      rpc: 'update_my_task',
      expected: { p_actor_user_id: actorUserId, p_task_id: taskId, p_status: 'completed' }
    },
    {
      body: { action: 'mark_notification_read', notificationId },
      rpc: 'mark_my_task_notification_read',
      expected: { p_actor_user_id: actorUserId, p_notification_id: notificationId }
    },
    {
      body: { action: 'mark_all_notifications_read' },
      rpc: 'mark_all_my_task_notifications_read',
      expected: { p_actor_user_id: actorUserId }
    }
  ];

  for (const request of requests) {
    const result = await backend.handler(event({ httpMethod: 'PATCH', body: JSON.stringify(request.body) }));
    assert.equal(result.statusCode, 200, request.body.action);
    const matchingCalls = calls.filter(call => call.url.endsWith(`/rest/v1/rpc/${request.rpc}`));
    assert.equal(matchingCalls.length, 1, request.rpc);
    assert.deepEqual(JSON.parse(matchingCalls[0].options.body), request.expected);
  }
});

test('PATCH rejects reassignment, organization, audit timestamps, and malformed action bodies before authentication', async t => {
  const attempts = [
    {},
    { action: 'update_task', taskId, status: 'completed', assignedTo: assigneeUserId },
    { action: 'update_task', taskId, status: 'completed', organizationId },
    { action: 'update_task', taskId, status: 'done' },
    { action: 'update_task', taskId: 'bad-id', status: 'open' },
    { action: 'mark_notification_read', notificationId, readAt: '2026-08-31T14:00:00Z' },
    { action: 'mark_notification_read', notificationId: 'bad-id' },
    { action: 'mark_all_notifications_read', organizationId },
    { action: 'delete_task', taskId }
  ];

  const calls = installFetch(t);
  for (const body of attempts) {
    const result = await backend.handler(event({ httpMethod: 'PATCH', body: JSON.stringify(body) }));
    assert.equal(result.statusCode, 400, JSON.stringify(body));
  }
  assert.equal(calls.length, 0, 'invalid task mutations must not authenticate or call a database RPC');
});

test('signed-out, invalid-token, forbidden-role, conflict, and database failures fail closed without leaking details', async t => {
  let authStatus = 200;
  let rpcStatus = 200;
  let rpcBody = workspacePayload();
  const calls = installFetch(t, {
    authStatus: () => authStatus,
    rpcStatus: () => rpcStatus,
    rpcBody: () => rpcBody
  });

  const signedOut = await backend.handler(event({ headers: {} }));
  assert.equal(signedOut.statusCode, 401);
  assert.equal(calls.length, 0);

  authStatus = 401;
  const invalid = await backend.handler(event());
  assert.equal(invalid.statusCode, 401);
  assert.equal(calls.some(call => call.url.includes('/rest/v1/rpc/')), false);

  authStatus = 200;
  rpcStatus = 400;
  rpcBody = { code: '42501', message: 'private role and organization detail' };
  const forbidden = await backend.handler(event());
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.body.includes('private role'), false);

  rpcBody = { code: '23505', message: 'private fingerprint detail' };
  const conflict = await backend.handler(event());
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.body.includes('private fingerprint'), false);

  rpcBody = { code: 'XX000', message: 'private database detail' };
  const failed = await backend.handler(event());
  assert.equal(failed.statusCode, 500);
  assert.equal(failed.body.includes('private database'), false);
});

test('malformed successful payloads and inconsistent counts fail closed', async t => {
  const malformed = [
    null,
    [],
    {},
    workspacePayload({ summary: { open: 0, overdue: 0, urgentUnread: 1 } }),
    workspacePayload({ summary: { open: 1, overdue: 2, urgentUnread: 1 } }),
    workspacePayload({ summary: { open: 1, overdue: 0, urgentUnread: 0 } }),
    workspacePayload({ tasks: [taskRow({ status: 'completed', completedAt: null })] }),
    workspacePayload({ notifications: [notificationRow({ type: 'billing_due' })] }),
    workspacePayload({ assignees: [{ userId: actorUserId, name: 'Client', role: 'client_admin' }] })
  ];

  for (const rpcBody of malformed) {
    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return String(url).endsWith('/auth/v1/user')
        ? response({ id: actorUserId })
        : response(rpcBody);
    };
    const result = await backend.handler(event());
    global.fetch = originalFetch;
    assert.equal(result.statusCode, 502, JSON.stringify(rpcBody));
    assert.equal(result.headers['Cache-Control'], 'no-store');
  }
});

test('bounded workspace arrays can carry larger authoritative counts without failing the task center', async t => {
  installFetch(t, { rpcBody: workspacePayload({ summary: { open: 12, overdue: 3, urgentUnread: 4 } }) });
  const result = await backend.handler(event());
  assert.equal(result.statusCode, 200);
  assert.deepEqual(bodyOf(result).summary, { open: 12, overdue: 3, urgentUnread: 4 });
});

test('unsupported methods return the exact allowlist and never authenticate', async t => {
  const calls = installFetch(t);
  for (const method of ['PUT', 'DELETE', 'OPTIONS']) {
    const result = await backend.handler(event({ httpMethod: method }));
    assert.equal(result.statusCode, 405);
    assert.equal(result.headers.Allow, 'GET, POST, PATCH');
    assert.equal(result.headers['Cache-Control'], 'no-store');
  }
  assert.equal(calls.length, 0);
});

test('migration creates no seed tasks and locks every table and RPC behind the service role', () => {
  const sql = read('supabase/migrations/20260831_030_tasks_and_notifications.sql');
  const ddl = sql.slice(0, sql.search(/create or replace function private\.task_actor/i));

  assert.match(sql, /create table if not exists public\.tasks/i);
  assert.match(sql, /create table if not exists public\.task_notifications/i);
  assert.match(sql, /create table if not exists public\.task_operations/i);
  assert.doesNotMatch(ddl, /insert into public\.tasks/i);
  assert.doesNotMatch(ddl, /insert into public\.task_notifications/i);
  for (const table of ['tasks', 'task_notifications', 'task_operations']) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
    assert.match(sql, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`, 'i'));
  }
  for (const signature of [
    'get_task_workspace\\(uuid\\)',
    'create_task\\(uuid, uuid, text, text, date, uuid, text\\)',
    'update_my_task\\(uuid, uuid, text\\)',
    'mark_my_task_notification_read\\(uuid, uuid\\)',
    'mark_all_my_task_notifications_read\\(uuid\\)'
  ]) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${signature}\\s*from public, anon, authenticated`, 'i'));
    assert.match(sql, new RegExp(`grant execute on function public\\.${signature}[\\s\\S]*?to service_role`, 'i'));
  }
});

test('migration derives internal actor scope and excludes every client and Talent portal role', () => {
  const sql = read('supabase/migrations/20260831_030_tasks_and_notifications.sql');
  const actorStart = sql.search(/create or replace function private\.task_actor/i);
  const actorEnd = sql.indexOf('revoke all on function private.task_actor', actorStart);
  const actor = sql.slice(actorStart, actorEnd);

  assert.match(actor, /public\.platform_users/i);
  assert.match(actor, /access\.id\s*=\s*p_actor_user_id/i);
  assert.match(actor, /access\.organization_id is not null/i);
  assert.match(actor, /access\.active\s*=\s*true/i);
  assert.match(actor, /access\.must_change_password\s*=\s*false/i);
  for (const role of ['admin', 'sales_management', 'sales', 'talent_management', 'billing']) {
    assert.match(actor, new RegExp(`'${role}'::public\\.platform_role`, 'i'));
  }
  for (const role of ['client_admin', 'client_reviewer', 'client_billing', 'virtual_assistant']) {
    assert.doesNotMatch(actor, new RegExp(`'${role}'::public\\.platform_role`, 'i'));
  }
});

test('migration lets Admin assign only active same-organization internal employees and forces everyone else to self-assign', () => {
  const sql = read('supabase/migrations/20260831_030_tasks_and_notifications.sql');
  const createStart = sql.search(/create or replace function public\.create_task/i);
  const createEnd = sql.indexOf('revoke all on function public.create_task', createStart);
  const create = sql.slice(createStart, createEnd);

  assert.match(create, /v_actor\.role\s*<>\s*'admin'::public\.platform_role[\s\S]*p_assigned_to_user_id\s*<>\s*v_actor\.user_id/i);
  assert.match(create, /assignee\.organization_id\s*=\s*v_actor\.organization_id/i);
  assert.match(create, /assignee\.active\s*=\s*true/i);
  assert.match(create, /assignee\.must_change_password\s*=\s*false/i);
  for (const role of ['admin', 'sales_management', 'sales', 'talent_management', 'billing']) {
    assert.match(create, new RegExp(`'${role}'::public\\.platform_role`, 'i'));
  }
  assert.match(sql, /foreign key \(assigned_to_user_id, organization_id\)[\s\S]*references public\.platform_users \(id, organization_id\)/i);
  assert.match(sql, /foreign key \(created_by_user_id, organization_id\)[\s\S]*references public\.platform_users \(id, organization_id\)/i);
});

test('migration makes create idempotent and records exactly one durable assignment notification', () => {
  const sql = read('supabase/migrations/20260831_030_tasks_and_notifications.sql');
  const createStart = sql.search(/create or replace function public\.create_task/i);
  const createEnd = sql.indexOf('revoke all on function public.create_task', createStart);
  const create = sql.slice(createStart, createEnd);

  assert.match(sql, /idempotency_key uuid primary key/i);
  assert.match(sql, /request_fingerprint text not null check \(request_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'\)/i);
  assert.match(create, /extensions\.digest\s*\([\s\S]*'sha256'\s*\)/i);
  assert.match(create, /pg_advisory_xact_lock/i);
  assert.match(create, /where operation\.idempotency_key\s*=\s*p_idempotency_key/i);
  assert.match(create, /v_existing\.request_fingerprint\s*<>\s*v_fingerprint/i);
  assert.match(create, /insert into public\.tasks/i);
  assert.match(create, /insert into public\.task_notifications[\s\S]*'task_assigned'/i);
  assert.match(create, /insert into public\.task_operations/i);
  assert.match(sql, /unique \(task_id, recipient_user_id, notification_type\)/i);
});

test('unread assignment count includes every unread notification even after its task is completed', () => {
  const sql = read('supabase/migrations/20260831_030_tasks_and_notifications.sql');
  const workspaceStart = sql.search(/create or replace function private\.task_workspace_json/i);
  const workspaceEnd = sql.indexOf('revoke all on function private.task_workspace_json', workspaceStart);
  const workspace = sql.slice(workspaceStart, workspaceEnd);
  const countStart = workspace.indexOf("'urgentUnread'");
  const countEnd = workspace.indexOf("'tasks'", countStart);
  const unreadCount = workspace.slice(countStart, countEnd);
  assert.match(unreadCount, /notification\.read_at is null/i);
  assert.doesNotMatch(unreadCount, /task\.status\s*=\s*'open'/i);
});

test('migration limits task updates and notification reads to the signed-in owner and recipient', () => {
  const sql = read('supabase/migrations/20260831_030_tasks_and_notifications.sql');
  const updateStart = sql.search(/create or replace function public\.update_my_task/i);
  const updateEnd = sql.indexOf('revoke all on function public.update_my_task', updateStart);
  const update = sql.slice(updateStart, updateEnd);
  const readStart = sql.search(/create or replace function public\.mark_my_task_notification_read/i);
  const readEnd = sql.indexOf('revoke all on function public.mark_my_task_notification_read', readStart);
  const readOne = sql.slice(readStart, readEnd);
  const readAllStart = sql.search(/create or replace function public\.mark_all_my_task_notifications_read/i);
  const readAllEnd = sql.indexOf('revoke all on function public.mark_all_my_task_notifications_read', readAllStart);
  const readAll = sql.slice(readAllStart, readAllEnd);

  assert.match(update, /task\.organization_id\s*=\s*v_actor\.organization_id/i);
  assert.match(update, /task\.assigned_to_user_id\s*=\s*v_actor\.user_id/i);
  assert.match(update, /status\s*=\s*v_status/i);
  assert.match(update, /completed_at\s*=\s*case when v_status = 'completed'/i);
  const taskSetClause = update.slice(update.search(/update public\.tasks/i), update.search(/where id = v_task\.id/i));
  assert.doesNotMatch(taskSetClause, /assigned_to_user_id\s*=/i);
  assert.match(readOne, /notification\.organization_id\s*=\s*v_actor\.organization_id/i);
  assert.match(readOne, /notification\.recipient_user_id\s*=\s*v_actor\.user_id/i);
  assert.match(readAll, /notification\.organization_id\s*=\s*v_actor\.organization_id/i);
  assert.match(readAll, /notification\.recipient_user_id\s*=\s*v_actor\.user_id/i);
});
