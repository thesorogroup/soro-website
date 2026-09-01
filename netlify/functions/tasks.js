const configuredUrl = String(process.env.SUPABASE_URL || '').trim();
const SUPABASE_URL = /^https:\/\/[^/]+\.supabase\.co\/?$/.test(configuredUrl)
  ? configuredUrl.replace(/\/$/, '')
  : '';
const SERVICE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || ''
).trim();

const MAX_REQUEST_BYTES = 8 * 1024;
const MAX_TASKS = 1000;
const MAX_NOTIFICATIONS = 1000;
const MAX_ASSIGNEES = 500;
const PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const TASK_STATUSES = new Set(['open', 'completed']);
const INTERNAL_ROLES = new Set(['admin', 'sales_management', 'sales', 'talent_management', 'billing']);
const POST_BODY_KEYS = Object.freeze([
  'action', 'title', 'relatedLabel', 'dueDate', 'assignedTo', 'priority', 'idempotencyKey'
]);
const UPDATE_BODY_KEYS = Object.freeze(['action', 'taskId', 'status']);
const READ_BODY_KEYS = Object.freeze(['action', 'notificationId']);
const READ_ALL_BODY_KEYS = Object.freeze(['action']);

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      Vary: 'Authorization',
      ...extraHeaders
    },
    body: JSON.stringify(body)
  };
}

function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function bearerToken(event) {
  const header = event.headers?.authorization || event.headers?.Authorization || '';
  return /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() || '';
}

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '').trim()
  );
}

function validDate(value) {
  const normalized = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return false;
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === normalized;
}

function hasExactKeys(value, expectedKeys) {
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function parseBody(event) {
  if (Buffer.byteLength(event.body || '', 'utf8') > MAX_REQUEST_BYTES) {
    throw httpError(413, 'request_too_large', 'The task request is too large.');
  }
  let body;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    throw httpError(400, 'invalid_request', 'The task request could not be read.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw httpError(400, 'invalid_request', 'The task request must be a JSON object.');
  }
  return body;
}

function rejectQueryScope(event, rejectBody = false) {
  const query = event.queryStringParameters || {};
  const multiValueQuery = event.multiValueQueryStringParameters || {};
  const rawQuery = String(event.rawQueryString || '').trim();
  if (
    Object.keys(query).length
    || Object.keys(multiValueQuery).length
    || rawQuery
    || (rejectBody && String(event.body || '').trim())
  ) {
    throw httpError(400, 'unsupported_scope', 'Task scope is determined by the signed-in account.');
  }
}

function serviceHeaders(extra = {}) {
  const headers = { apikey: SERVICE_KEY, ...extra };
  if (SERVICE_KEY && !SERVICE_KEY.startsWith('sb_secret_')) headers.Authorization = `Bearer ${SERVICE_KEY}`;
  return headers;
}

async function authenticatedUser(event) {
  const token = bearerToken(event);
  if (!token) throw httpError(401, 'authentication_required', 'Sign in to use My Tasks.');
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw httpError(503, 'service_unavailable', 'My Tasks is not configured yet.');
  }

  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw httpError(401, 'authentication_required', 'Sign in again to use My Tasks.');
    }
    throw httpError(503, 'service_unavailable', 'My Tasks is temporarily unavailable.');
  }

  const user = await response.json().catch(() => null);
  if (!validUuid(user?.id)) throw httpError(401, 'authentication_required', 'Sign in again to use My Tasks.');
  return user;
}

async function responseJson(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function rpcError(status, payload) {
  const databaseCode = String(payload?.code || '');
  if (databaseCode === '42501') {
    return httpError(403, 'task_forbidden', 'Your account does not have access to this task or notification.');
  }
  if (databaseCode === '23505') {
    return httpError(409, 'idempotency_conflict', 'This task request was already used with different details.');
  }
  if (databaseCode === 'P0001' || databaseCode === '40001') {
    return httpError(409, 'task_conflict', 'The task changed before this action completed. Refresh and try again.');
  }
  if (databaseCode === '22023' || databaseCode === '22P02' || databaseCode === '23514') {
    return httpError(400, 'invalid_request', 'Check the task details and try again.');
  }
  if (databaseCode === 'PGRST202' || status === 404) {
    return httpError(503, 'service_unavailable', 'My Tasks is not configured yet.');
  }
  return httpError(
    status === 401 || status === 403 ? 503 : 500,
    'task_service_error',
    'My Tasks is temporarily unavailable. Please try again.'
  );
}

async function callRpc(name, body) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: serviceHeaders({
      Accept: 'application/json',
      'Content-Type': 'application/json'
    }),
    body: JSON.stringify(body)
  });
  const payload = await responseJson(response);
  if (!response.ok) throw rpcError(response.status, payload);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw httpError(502, 'task_service_error', 'My Tasks returned an invalid response.');
  }
  return payload;
}

function nullableText(value, maximum) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    throw httpError(502, 'task_service_error', 'My Tasks returned an invalid response.');
  }
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximum) {
    throw httpError(502, 'task_service_error', 'My Tasks returned an invalid response.');
  }
  return normalized;
}

function requiredText(value, maximum) {
  const normalized = nullableText(value, maximum);
  if (!normalized) throw httpError(502, 'task_service_error', 'My Tasks returned an invalid response.');
  return normalized;
}

function requiredUuid(value) {
  if (!validUuid(value)) throw httpError(502, 'task_service_error', 'My Tasks returned an invalid response.');
  return String(value).trim().toLowerCase();
}

function requiredTimestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw httpError(502, 'task_service_error', 'My Tasks returned an invalid response.');
  }
  return value;
}

function nullableTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  return requiredTimestamp(value);
}

function nullableDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (!validDate(value)) throw httpError(502, 'task_service_error', 'My Tasks returned an invalid response.');
  return String(value).trim();
}

function requiredCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw httpError(502, 'task_service_error', 'My Tasks returned an invalid response.');
  }
  return value;
}

function publicPerson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(502, 'task_service_error', 'My Tasks returned an invalid response.');
  }
  return {
    userId: requiredUuid(value.userId),
    name: requiredText(value.name, 180)
  };
}

function publicTask(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(502, 'task_service_error', 'My Tasks returned an invalid response.');
  }
  const priority = requiredText(value.priority, 20).toLowerCase();
  const status = requiredText(value.status, 20).toLowerCase();
  if (!PRIORITIES.has(priority) || !TASK_STATUSES.has(status)) {
    throw httpError(502, 'task_service_error', 'My Tasks returned an invalid response.');
  }
  const task = {
    taskId: requiredUuid(value.taskId),
    title: requiredText(value.title, 160),
    relatedLabel: nullableText(value.relatedLabel, 200),
    dueDate: nullableDate(value.dueDate),
    priority,
    status,
    assignedTo: publicPerson(value.assignedTo),
    createdBy: publicPerson(value.createdBy),
    createdAt: requiredTimestamp(value.createdAt),
    updatedAt: requiredTimestamp(value.updatedAt),
    completedAt: nullableTimestamp(value.completedAt)
  };
  if ((task.status === 'completed') !== Boolean(task.completedAt)) {
    throw httpError(502, 'task_service_error', 'My Tasks returned an invalid response.');
  }
  return task;
}

function publicNotification(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(502, 'task_service_error', 'My Tasks returned an invalid response.');
  }
  const priority = requiredText(value.priority, 20).toLowerCase();
  if (value.type !== 'task_assigned' || value.view !== 'tasks' || !PRIORITIES.has(priority)) {
    throw httpError(502, 'task_service_error', 'My Tasks returned an invalid response.');
  }
  return {
    notificationId: requiredUuid(value.notificationId),
    type: 'task_assigned',
    taskId: requiredUuid(value.taskId),
    title: requiredText(value.title, 80),
    message: requiredText(value.message, 160),
    relatedLabel: nullableText(value.relatedLabel, 200),
    priority,
    view: 'tasks',
    createdAt: requiredTimestamp(value.createdAt),
    readAt: nullableTimestamp(value.readAt)
  };
}

function publicAssignee(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(502, 'task_service_error', 'My Tasks returned an invalid response.');
  }
  const role = requiredText(value.role, 40).toLowerCase();
  if (!INTERNAL_ROLES.has(role)) {
    throw httpError(502, 'task_service_error', 'My Tasks returned an invalid response.');
  }
  return {
    userId: requiredUuid(value.userId),
    name: requiredText(value.name, 180),
    role
  };
}

function publicPayload(payload) {
  if (
    !Array.isArray(payload.tasks)
    || !Array.isArray(payload.notifications)
    || !Array.isArray(payload.assignees)
    || payload.tasks.length > MAX_TASKS
    || payload.notifications.length > MAX_NOTIFICATIONS
    || payload.assignees.length > MAX_ASSIGNEES
    || !payload.summary
    || typeof payload.summary !== 'object'
    || Array.isArray(payload.summary)
  ) {
    throw httpError(502, 'task_service_error', 'My Tasks returned an invalid response.');
  }
  const tasks = payload.tasks.map(publicTask);
  const notifications = payload.notifications.map(publicNotification);
  const assignees = payload.assignees.map(publicAssignee);
  const summary = {
    open: requiredCount(payload.summary.open),
    overdue: requiredCount(payload.summary.overdue),
    urgentUnread: requiredCount(payload.summary.urgentUnread)
  };
  if (
    summary.open < tasks.filter(task => task.status === 'open').length
    || summary.overdue > summary.open
    || summary.urgentUnread < notifications.filter(notification => !notification.readAt).length
    || new Set(tasks.map(task => task.taskId)).size !== tasks.length
    || new Set(notifications.map(notification => notification.notificationId)).size !== notifications.length
    || new Set(assignees.map(assignee => assignee.userId)).size !== assignees.length
  ) {
    throw httpError(502, 'task_service_error', 'My Tasks returned an invalid response.');
  }
  return { tasks, notifications, assignees, summary };
}

function inputUuid(value, label) {
  const normalized = String(value || '').trim();
  if (!validUuid(normalized)) throw httpError(400, 'invalid_request', `A valid ${label} is required.`);
  return normalized.toLowerCase();
}

function inputText(value, maximum, label) {
  if (typeof value !== 'string') throw httpError(400, 'invalid_request', `${label} must be text.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw httpError(400, 'invalid_request', `${label} must be between 1 and ${maximum} characters.`);
  }
  return normalized;
}

function inputNullableText(value, maximum, label) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw httpError(400, 'invalid_request', `${label} must be text or blank.`);
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximum) {
    throw httpError(400, 'invalid_request', `${label} must be ${maximum} characters or fewer.`);
  }
  return normalized;
}

function inputNullableDate(value) {
  if (value === null || value === '') return null;
  if (!validDate(value)) throw httpError(400, 'invalid_request', 'Choose a valid due date.');
  return String(value).trim();
}

async function getTasks(event) {
  rejectQueryScope(event, true);
  const user = await authenticatedUser(event);
  return json(200, publicPayload(await callRpc('get_task_workspace', { p_actor_user_id: user.id })));
}

async function createTask(event) {
  rejectQueryScope(event);
  const body = parseBody(event);
  if (!hasExactKeys(body, POST_BODY_KEYS) || body.action !== 'create_task') {
    throw httpError(400, 'unsupported_scope', 'Only the fields required to create a task are accepted.');
  }
  const priority = inputText(body.priority, 20, 'Priority').toLowerCase();
  if (!PRIORITIES.has(priority)) throw httpError(400, 'invalid_request', 'Choose a supported task priority.');
  const rpcBody = {
    p_actor_user_id: null,
    p_idempotency_key: inputUuid(body.idempotencyKey, 'idempotency key'),
    p_title: inputText(body.title, 160, 'Task title'),
    p_related_label: inputNullableText(body.relatedLabel, 200, 'Related label'),
    p_due_date: inputNullableDate(body.dueDate),
    p_assigned_to_user_id: inputUuid(body.assignedTo, 'task assignee'),
    p_priority: priority
  };
  const user = await authenticatedUser(event);
  rpcBody.p_actor_user_id = user.id;
  return json(200, publicPayload(await callRpc('create_task', rpcBody)));
}

async function patchTaskWorkspace(event) {
  rejectQueryScope(event);
  const body = parseBody(event);
  const action = String(body.action || '').trim().toLowerCase();
  let rpcName;
  let rpcBody;

  if (action === 'update_task') {
    if (!hasExactKeys(body, UPDATE_BODY_KEYS)) {
      throw httpError(400, 'unsupported_scope', 'Only the fields required to update a task are accepted.');
    }
    const status = inputText(body.status, 20, 'Task status').toLowerCase();
    if (!TASK_STATUSES.has(status)) throw httpError(400, 'invalid_request', 'Choose an available task status.');
    rpcName = 'update_my_task';
    rpcBody = {
      p_actor_user_id: null,
      p_task_id: inputUuid(body.taskId, 'task id'),
      p_status: status
    };
  } else if (action === 'mark_notification_read') {
    if (!hasExactKeys(body, READ_BODY_KEYS)) {
      throw httpError(400, 'unsupported_scope', 'Only the fields required to read a notification are accepted.');
    }
    rpcName = 'mark_my_task_notification_read';
    rpcBody = {
      p_actor_user_id: null,
      p_notification_id: inputUuid(body.notificationId, 'notification id')
    };
  } else if (action === 'mark_all_notifications_read') {
    if (!hasExactKeys(body, READ_ALL_BODY_KEYS)) {
      throw httpError(400, 'unsupported_scope', 'This action does not accept additional fields.');
    }
    rpcName = 'mark_all_my_task_notifications_read';
    rpcBody = { p_actor_user_id: null };
  } else {
    throw httpError(400, 'unsupported_action', 'Choose a supported task or notification action.');
  }

  const user = await authenticatedUser(event);
  rpcBody.p_actor_user_id = user.id;
  return json(200, publicPayload(await callRpc(rpcName, rpcBody)));
}

async function handler(event) {
  if (!['GET', 'POST', 'PATCH'].includes(event.httpMethod)) {
    return json(405, { code: 'method_not_allowed', message: 'Method not allowed.' }, { Allow: 'GET, POST, PATCH' });
  }
  try {
    if (event.httpMethod === 'GET') return await getTasks(event);
    if (event.httpMethod === 'POST') return await createTask(event);
    return await patchTaskWorkspace(event);
  } catch (error) {
    console.error('Task workspace operation failed.', {
      method: event.httpMethod,
      status: error.status,
      code: error.code,
      message: error.message
    });
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    return json(status, {
      code: error.code || 'task_service_error',
      message: status >= 500 && error.code !== 'service_unavailable'
        ? 'My Tasks is temporarily unavailable. Please try again.'
        : error.message
    });
  }
}

exports.handler = handler;
exports.INTERNAL_ROLES = INTERNAL_ROLES;
exports.MAX_ASSIGNEES = MAX_ASSIGNEES;
exports.MAX_NOTIFICATIONS = MAX_NOTIFICATIONS;
exports.MAX_TASKS = MAX_TASKS;
exports.POST_BODY_KEYS = POST_BODY_KEYS;
exports.PRIORITIES = PRIORITIES;
exports.READ_ALL_BODY_KEYS = READ_ALL_BODY_KEYS;
exports.READ_BODY_KEYS = READ_BODY_KEYS;
exports.TASK_STATUSES = TASK_STATUSES;
exports.UPDATE_BODY_KEYS = UPDATE_BODY_KEYS;
exports.hasExactKeys = hasExactKeys;
exports.publicPayload = publicPayload;
exports.validDate = validDate;
exports.validUuid = validUuid;
