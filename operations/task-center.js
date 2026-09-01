/* Live task and notification center. No sample records are created in the browser. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.soroTaskCenter = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const ENDPOINT = '/.netlify/functions/tasks';
  const AUTO_REFRESH_MS = 30000;
  const OPERATIONS_TIME_ZONE = 'America/Chicago';
  const ENABLED_ROLES = new Set(['admin', 'talent_management', 'sales', 'sales_management', 'billing']);
  const PRIORITY_LABELS = Object.freeze({ low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' });
  let state = emptyState();
  let requestVersion = 0;
  let reviewCount = 0;

  function emptyState(phase = 'idle', message = '') {
    return Object.freeze({ phase, message, tasks: [], notifications: [], assignees: [], summary: Object.freeze({ open: 0, overdue: 0, urgentUnread: 0 }) });
  }

  function text(value, maximum = 240) {
    return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, maximum);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
  }

  function actualRole() {
    return text(root?.soroCurrentAccess?.role, 60).toLowerCase();
  }

  function canLoad(role = actualRole()) {
    return ENABLED_ROLES.has(text(role, 60).toLowerCase());
  }

  function taskDate(task) {
    return task?.dueDate || task?.due_date || '';
  }

  function taskStatus(task) {
    return text(task?.status, 24).toLowerCase() || 'open';
  }

  function taskPriority(task) {
    const priority = text(task?.priority, 24).toLowerCase();
    return Object.hasOwn(PRIORITY_LABELS, priority) ? priority : 'normal';
  }

  function taskId(task) {
    return text(task?.id || task?.taskId || task?.task_id, 80);
  }

  function assignedName(task) {
    return text(task?.assignedTo?.name || task?.assigneeName || task?.assignee_name || task?.assignedToName || task?.assigned_to_name, 160) || 'Assigned to me';
  }

  function relatedLabel(task) {
    return text(task?.relatedLabel || task?.related_label, 180) || 'General';
  }

  function normalizePayload(payload) {
    const raw = payload && typeof payload === 'object' ? payload : {};
    const tasks = Array.isArray(raw.tasks) ? raw.tasks.filter(task => task && typeof task === 'object') : [];
    const notifications = Array.isArray(raw.notifications) ? raw.notifications.filter(item => item && typeof item === 'object') : [];
    const assignees = Array.isArray(raw.assignees) ? raw.assignees.filter(item => item && typeof item === 'object') : [];
    const supplied = raw.summary && typeof raw.summary === 'object' ? raw.summary : {};
    const open = Number.isFinite(Number(supplied.open)) ? Math.max(0, Number(supplied.open)) : tasks.filter(task => taskStatus(task) === 'open').length;
    const overdue = Number.isFinite(Number(supplied.overdue)) ? Math.max(0, Number(supplied.overdue)) : tasks.filter(isOverdue).length;
    const urgentUnread = Number.isFinite(Number(supplied.urgentUnread ?? supplied.urgent_unread))
      ? Math.max(0, Number(supplied.urgentUnread ?? supplied.urgent_unread))
      : notifications.filter(notification => !(notification.readAt || notification.read_at)).length;
    return Object.freeze({
      phase: 'ready', message: '', tasks: Object.freeze(tasks), notifications: Object.freeze(notifications), assignees: Object.freeze(assignees),
      summary: Object.freeze({ open, overdue, urgentUnread })
    });
  }

  function operationsTodayIso(now = new Date()) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: OPERATIONS_TIME_ZONE,
        year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(now).reduce((values, part) => ({ ...values, [part.type]: part.value }), {});
      if (parts.year && parts.month && parts.day) return `${parts.year}-${parts.month}-${parts.day}`;
    } catch (_) {}
    return now.toISOString().slice(0, 10);
  }

  function isOverdue(task, today = new Date()) {
    if (taskStatus(task) !== 'open' || !taskDate(task)) return false;
    return taskDate(task) < operationsTodayIso(today);
  }

  function formatDue(task, now = new Date()) {
    const value = taskDate(task);
    if (!value) return 'No due date';
    const date = new Date(`${value}T12:00:00Z`);
    if (!Number.isFinite(date.getTime())) return value;
    const todayIso = operationsTodayIso(now);
    const days = Math.round((Date.parse(`${value}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Tomorrow';
    if (days === -1) return 'Yesterday';
    return date.toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric', year: value.slice(0, 4) === todayIso.slice(0, 4) ? undefined : 'numeric' });
  }

  async function token() {
    const { data } = await root?.soroSupabase?.auth?.getSession?.() || {};
    return data?.session?.access_token || '';
  }

  async function request(method = 'GET', body) {
    const accessToken = await token();
    if (!accessToken) throw new Error('Your secure session expired. Sign in again and retry.');
    const response = await root.fetch(ENDPOINT, {
      method,
      headers: { Authorization: `Bearer ${accessToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || 'Tasks could not be loaded.');
    return payload;
  }

  function dispatchUpdated() {
    updateShell();
    if (typeof root?.CustomEvent === 'function') root.dispatchEvent?.(new root.CustomEvent('soro:task-center-updated', { detail: { state } }));
  }

  async function refresh(options = {}) {
    if (!canLoad()) {
      state = emptyState();
      dispatchUpdated();
      return state;
    }
    const silent = options.silent === true && state.phase === 'ready';
    const version = ++requestVersion;
    if (!silent) {
      state = emptyState('loading');
      dispatchUpdated();
    }
    try {
      const next = normalizePayload(await request());
      if (version !== requestVersion) return state;
      state = next;
    } catch (error) {
      if (version !== requestVersion) return state;
      if (silent) return state;
      state = emptyState('error', error.message || 'Tasks could not be loaded.');
    }
    dispatchUpdated();
    return state;
  }

  function reviewQueueCount(queueValue) {
    if (queueValue?.phase !== 'ready') return 0;
    const summary = queueValue.summary || {};
    return ['submitted', 'in_review', 'needs_more_info'].reduce((total, key) => total + Math.max(0, Number(summary[key]) || 0), 0);
  }

  function canOpenReviewQueue() {
    if (typeof root?.viewAllowedForAuthenticatedRole === 'function') {
      return root.viewAllowedForAuthenticatedRole('talent-review');
    }
    return ['admin', 'talent_management'].includes(actualRole());
  }

  function updateShell() {
    const tasksBadge = root?.document?.getElementById?.('my-tasks-count');
    const open = state.phase === 'ready' ? state.summary.open : 0;
    if (tasksBadge) {
      tasksBadge.textContent = String(open);
      tasksBadge.hidden = open === 0;
    }
    const tasksNav = root?.document?.getElementById?.('my-tasks-nav');
    if (tasksNav) tasksNav.setAttribute('aria-label', open ? `My Tasks, ${open} open` : 'My Tasks, none open');

    const accessibleReviewCount = canOpenReviewQueue() ? reviewCount : 0;
    const notificationCount = state.phase === 'ready' ? state.summary.urgentUnread + accessibleReviewCount : accessibleReviewCount;
    const bell = root?.document?.getElementById?.('notifications-button');
    const badge = root?.document?.getElementById?.('notifications-count');
    if (badge) {
      badge.textContent = String(notificationCount);
      badge.hidden = notificationCount === 0;
    }
    if (bell) bell.setAttribute('aria-label', notificationCount ? `View ${notificationCount} notifications` : 'No notifications');
    renderNotifications();
    populateAssignees();
  }

  function notificationText(notification) {
    return {
      id: text(notification.id || notification.notificationId || notification.notification_id, 80),
      title: text(notification.title, 180) || 'Task assigned',
      message: text(notification.message || notification.body, 260) || 'A task needs your attention.',
      unread: !(notification.readAt || notification.read_at)
    };
  }

  function renderNotifications() {
    const list = root?.document?.getElementById?.('notification-list');
    if (!list) return;
    const taskNotifications = state.phase === 'ready'
      ? state.notifications.map(notificationText).filter(item => item.unread)
      : [];
    const queueItem = reviewCount > 0 && canOpenReviewQueue()
      ? `<button type="button" data-notification-view="talent-review"><span class="notification-dot urgent"></span><span><strong>${escapeHtml(`${reviewCount} Talent ${reviewCount === 1 ? 'profile needs' : 'profiles need'} review`)}</strong><small>Open the live Talent Review Queue to continue.</small></span><b>Open</b></button>`
      : '';
    const taskItems = taskNotifications.map(item => `<button type="button" data-notification-view="tasks" data-notification-id="${escapeHtml(item.id)}"><span class="notification-dot"></span><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.message)}</small></span><b>Open</b></button>`).join('');
    list.innerHTML = `${queueItem}${taskItems}` || '<p class="notifications-empty">You have no notifications requiring attention.</p>';
  }

  function assigneeId(assignee) {
    return text(assignee.id || assignee.userId || assignee.user_id, 80);
  }

  function assigneeName(assignee) {
    return text(assignee.name || assignee.displayName || assignee.display_name || assignee.fullName || assignee.full_name, 160) || 'Soro employee';
  }

  function populateAssignees() {
    const select = root?.document?.getElementById?.('task-assignee');
    if (!select) return;
    const selectedAssignee = text(select.value, 80);
    if (state.phase === 'loading') {
      select.innerHTML = '<option value="">Loading available employees…</option>';
      select.disabled = true;
      return;
    }
    const currentUserId = text(root?.soroCurrentAccess?.user_id, 80);
    const assignees = state.phase === 'ready' ? state.assignees : [];
    const preferredAssignee = assignees.some(assignee => assigneeId(assignee) === selectedAssignee)
      ? selectedAssignee
      : currentUserId;
    const options = assignees.map(assignee => {
      const id = assigneeId(assignee);
      const suffix = id && id === currentUserId ? ' — Me' : '';
      return `<option value="${escapeHtml(id)}" ${id === preferredAssignee ? 'selected' : ''}>${escapeHtml(`${assigneeName(assignee)}${suffix}`)}</option>`;
    }).join('');
    select.innerHTML = options || `<option value="${escapeHtml(currentUserId)}">Me</option>`;
    select.disabled = false;
  }

  function dashboardData(fallback) {
    if (!fallback || !canLoad()) return fallback;
    const loading = state.phase === 'loading' || state.phase === 'idle';
    const metric = loading
      ? ['Tasks needing attention', '—', 'Loading your assigned tasks…', '']
      : state.phase === 'error'
        ? ['Tasks needing attention', '—', 'Tasks unavailable · select to retry', 'warning']
        : ['Tasks needing attention', String(state.summary.open), state.summary.overdue ? `${state.summary.overdue} overdue` : 'No overdue tasks', state.summary.overdue ? 'alert' : ''];
    const tasks = state.phase === 'ready' ? state.tasks.filter(task => taskStatus(task) === 'open').slice(0, 5) : [];
    const items = tasks.map(task => [isOverdue(task) || taskPriority(task) === 'urgent' ? 'red' : '', text(task.title, 180), relatedLabel(task), formatDue(task)]);
    return {
      ...fallback,
      metrics: (fallback.metrics || []).map(item => /^(?:tasks needing attention|talent actions needing attention)$/i.test(text(item?.[0], 100)) ? metric : item),
      primary: 'Priority work',
      items,
      emptyMessage: state.phase === 'error' ? state.message : state.phase === 'ready' ? 'No tasks are assigned to you.' : 'Loading your assigned tasks…'
    };
  }

  function taskRows() {
    return state.tasks.map(task => {
      const status = taskStatus(task);
      const priority = taskPriority(task);
      return `<tr data-task-id="${escapeHtml(taskId(task))}"><td><span class="task-title"><strong>${escapeHtml(text(task.title, 180) || 'Untitled task')}</strong><small class="task-priority task-priority--${escapeHtml(priority)}">${escapeHtml(PRIORITY_LABELS[priority])}</small></span></td><td>${escapeHtml(relatedLabel(task))}</td><td><span class="${isOverdue(task) ? 'task-due--overdue' : ''}">${escapeHtml(formatDue(task))}</span></td><td>${escapeHtml(assignedName(task))}</td><td><button type="button" class="button task-status-action" data-task-status="${status === 'completed' ? 'open' : 'completed'}">${status === 'completed' ? 'Reopen' : 'Complete'}</button></td></tr>`;
    }).join('');
  }

  function renderPage() {
    const listedOpen = state.tasks.filter(task => taskStatus(task) === 'open').length;
    const hiddenOpen = state.phase === 'ready' ? Math.max(0, state.summary.open - listedOpen) : 0;
    const truncationNotice = hiddenOpen
      ? `<p class="task-truncation-notice">Showing the first ${listedOpen.toLocaleString()} open tasks. ${hiddenOpen.toLocaleString()} additional open ${hiddenOpen === 1 ? 'task remains' : 'tasks remain'}.</p>`
      : '';
    const content = state.phase === 'loading' || state.phase === 'idle'
      ? '<div class="employee-loading">Loading your tasks…</div>'
      : state.phase === 'error'
        ? `<div class="employee-error"><strong>Tasks could not be loaded.</strong><span>${escapeHtml(state.message)}</span><button class="button" id="retry-tasks" type="button">Try again</button></div>`
        : state.tasks.length
          ? `${truncationNotice}<div class="panel table-wrap"><table class="data-table task-table"><thead><tr><th>Task</th><th>Related to</th><th>Due</th><th>Owner</th><th>Status</th></tr></thead><tbody>${taskRows()}</tbody></table></div>`
          : '<section class="panel task-empty"><strong>No tasks are assigned to you.</strong><p>New assignments will appear here automatically.</p></section>';
    return `<main class="page task-center-page"><div class="page-heading"><div><p class="eyebrow">Soro Operations</p><h1>My Tasks</h1><p class="eyebrow" style="margin-top:9px">Your active and completed work, updated from the live task register.</p></div><div class="heading-actions"><button class="button primary" id="add-task">+ Add Task</button></div></div>${content}</main>`;
  }

  async function updateTask(taskIdValue, status) {
    await request('PATCH', { action: 'update_task', taskId: taskIdValue, status });
    return refresh();
  }

  function bindPage(scope) {
    scope?.querySelector?.('#retry-tasks')?.addEventListener('click', refresh);
    scope?.querySelectorAll?.('[data-task-id]')?.forEach(row => {
      row.querySelector('[data-task-status]')?.addEventListener('click', async event => {
        const button = event.currentTarget;
        button.disabled = true;
        try { await updateTask(row.dataset.taskId, button.dataset.taskStatus); }
        catch (error) { button.disabled = false; root?.dispatchEvent?.(new root.CustomEvent('soro:task-center-error', { detail: { message: error.message } })); }
      });
    });
  }

  function bindDashboardMetric(scope, currentView = '') {
    if (text(currentView, 40).toLowerCase() !== 'overview') return false;
    const metric = [...(scope?.querySelectorAll?.('[data-metric]') || [])].find(button => /^(?:tasks needing attention|talent actions needing attention)$/i.test(text(button.querySelector('p')?.textContent, 100)));
    if (!metric) return false;
    metric.addEventListener('click', event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (state.phase === 'error') refresh();
      root?.dispatchEvent?.(new root.CustomEvent('soro:task-center-open-tasks'));
    });
    return true;
  }

  function createUuid() {
    if (typeof root?.crypto?.randomUUID === 'function') return root.crypto.randomUUID();
    if (typeof root?.crypto?.getRandomValues !== 'function') throw new Error('This browser cannot create a secure task request. Please update the browser and retry.');
    const bytes = root.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(value => value.toString(16).padStart(2, '0'));
    return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
  }

  async function createTask(form) {
    const values = Object.fromEntries(new FormData(form).entries());
    const idempotencyKey = form.dataset.taskIdempotencyKey || createUuid();
    form.dataset.taskIdempotencyKey = idempotencyKey;
    const body = {
      action: 'create_task', title: text(values.title, 160), relatedLabel: text(values.relatedLabel, 200) || null,
      dueDate: text(values.dueDate, 10) || null, assignedTo: text(values.assignedTo, 80) || text(root?.soroCurrentAccess?.user_id, 80),
      priority: text(values.priority, 24) || 'normal', idempotencyKey
    };
    if (!body.title) throw new Error('Enter a task name.');
    await request('POST', body);
    delete form.dataset.taskIdempotencyKey;
    return refresh();
  }

  function bindTaskForm() {
    const form = root?.document?.getElementById?.('task-form');
    if (!form || form.dataset.taskCenterBound === 'true') return;
    form.dataset.taskCenterBound = 'true';
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const submit = form.querySelector('[type="submit"]');
      const message = root.document.getElementById('task-form-message');
      submit.disabled = true;
      if (message) { message.textContent = 'Saving task…'; message.className = 'task-form-message'; }
      try {
        await createTask(form);
        root.document.getElementById('task-dialog')?.close('saved');
        form.reset();
        if (message) message.textContent = '';
      } catch (error) {
        if (message) { message.textContent = error.message || 'The task could not be saved.'; message.className = 'task-form-message task-form-message--error'; }
      } finally { submit.disabled = false; }
    });
    root.document.getElementById('task-dialog')?.addEventListener('close', () => {
      delete form.dataset.taskIdempotencyKey;
      if (root.document.getElementById('task-dialog')?.returnValue !== 'saved') form.reset();
      const message = root.document.getElementById('task-form-message');
      if (message) { message.textContent = ''; message.className = 'task-form-message'; }
      populateAssignees();
    });
  }

  async function markNotificationRead(notificationId) {
    if (!notificationId) return;
    await request('PATCH', { action: 'mark_notification_read', notificationId });
    await refresh();
  }

  function bindNotifications() {
    const list = root?.document?.getElementById?.('notification-list');
    if (!list || list.dataset.taskCenterBound === 'true') return;
    list.dataset.taskCenterBound = 'true';
    list.addEventListener('click', event => {
      const button = event.target.closest('[data-notification-id]');
      if (button?.dataset.notificationId) markNotificationRead(button.dataset.notificationId).catch(() => {});
    });
  }

  function handleAuthChange(event) {
    const access = event?.detail?.access || null;
    if (!access || !canLoad(access.role)) {
      requestVersion += 1;
      state = emptyState();
      reviewCount = 0;
      dispatchUpdated();
      return Promise.resolve(state);
    }
    return refresh();
  }

  function handleReviewQueueUpdate(event) {
    reviewCount = reviewQueueCount(event?.detail?.queue);
    updateShell();
  }

  function refreshWhenActive() {
    if (!canLoad() || state.phase === 'loading' || root?.document?.visibilityState === 'hidden') return;
    refresh({ silent: true });
  }

  bindTaskForm();
  bindNotifications();
  root?.addEventListener?.('soro-auth-changed', handleAuthChange);
  root?.addEventListener?.('soro:talent-review-queue-updated', handleReviewQueueUpdate);
  if (root?.document) {
    root.addEventListener?.('focus', refreshWhenActive);
    root.document.addEventListener?.('visibilitychange', refreshWhenActive);
    root.setInterval?.(refreshWhenActive, AUTO_REFRESH_MS);
  }

  return Object.freeze({
    ENDPOINT, AUTO_REFRESH_MS, OPERATIONS_TIME_ZONE, PRIORITY_LABELS, canLoad, normalizePayload, currentState: () => state, reviewQueueCount,
    dashboardData, renderPage, bindPage, bindDashboardMetric, refresh, updateTask, createTask, handleAuthChange, handleReviewQueueUpdate
  });
}));
