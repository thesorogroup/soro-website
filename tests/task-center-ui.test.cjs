const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const taskCenter = require(path.join(root, 'operations', 'task-center.js'));
const reviewQueue = require(path.join(root, 'operations', 'talent-review-queue.js'));

test('task and notification badges start empty and are owned by the live task center', () => {
  const html = read('operations/index.html');
  const source = read('operations/task-center.js');

  assert.match(html, /id="my-tasks-count" hidden>0</);
  assert.match(html, /id="notifications-count" hidden>0</);
  assert.match(html, /id="talent-review-count" hidden>0</);
  assert.doesNotMatch(html, /aria-label="View 3 notifications"|My Tasks <b>5<\/b>/);
  assert.doesNotMatch(html, /billing verification is due tomorrow|Talent profiles need review/);
  assert.match(source, /state\.summary\.urgentUnread \+ accessibleReviewCount/);
  assert.match(source, /tasksBadge\.hidden = open === 0/);
});

test('real task service loads before the canonical renderer and replaces placeholder task rows', () => {
  const html = read('operations/index.html');
  const operations = read('operations/operations.js');
  const taskScript = html.indexOf('task-center.js');
  const operationsScript = html.indexOf('operations.js');

  assert.ok(taskScript >= 0 && taskScript < operationsScript);
  assert.match(operations, /if\(current==='tasks'&&window\.soroTaskCenter\?\.canLoad/);
  assert.match(operations, /window\.soroTaskCenter\.renderPage\(\)/);
  assert.match(operations, /window\.soroTaskCenter\.dashboardData\(baseData\)/);
  assert.doesNotMatch(operations, /Review missing client agreement|Review payout exception|Check in with Alex Ramos|Review 2 incomplete applications|Sign the Soro client agreement|Choose interview windows|Complete your Dream Pathway action|Update payout verification/);
  assert.match(operations, /client:\{[^}]*primary:'Action needed',items:\[\],emptyMessage:'No actions are assigned right now\.'/);
  assert.match(operations, /va:\{[^}]*primary:'Action needed',items:\[\],emptyMessage:'No actions are assigned right now\.'/);
  assert.doesNotMatch(operations, /virtual_assistant:new Set\(\[[^\]]*['"]tasks['"]/);
});

test('task center refreshes active sessions and preserves one UUID across a failed create retry', () => {
  const source = read('operations/task-center.js');
  assert.match(source, /const AUTO_REFRESH_MS = 30000/);
  assert.match(source, /addEventListener\?\.\(['"]focus['"], refreshWhenActive\)/);
  assert.match(source, /addEventListener\?\.\(['"]visibilitychange['"], refreshWhenActive\)/);
  assert.match(source, /refresh\(\{ silent: true \}\)/);
  assert.match(source, /form\.dataset\.taskIdempotencyKey \|\| createUuid\(\)/);
  assert.match(source, /form\.dataset\.taskIdempotencyKey = idempotencyKey/);
  assert.match(source, /const selectedAssignee = text\(select\.value, 80\)/);
  assert.match(source, /id === preferredAssignee \? 'selected' : ''/);
  assert.doesNotMatch(source, /Date\.now\(\).*Math\.random/);
});

test('Talent review notifications follow the effective workspace, not only the signed-in Admin role', () => {
  const source = read('operations/task-center.js');
  assert.match(source, /viewAllowedForAuthenticatedRole\('talent-review'\)/);
  assert.match(source, /const accessibleReviewCount = canOpenReviewQueue\(\) \? reviewCount : 0/);
  assert.match(source, /reviewCount > 0 && canOpenReviewQueue\(\)/);
});

test('overdue rows and server counts share the Soro operations day boundary', () => {
  const source = read('operations/task-center.js');
  const sql = read('supabase/migrations/20260831_030_tasks_and_notifications.sql');
  assert.match(source, /const OPERATIONS_TIME_ZONE = ['"]America\/Chicago['"]/);
  assert.match(source, /taskDate\(task\) < operationsTodayIso\(today\)/);
  assert.match(sql, /task\.due_date < \(pg_catalog\.clock_timestamp\(\) at time zone 'America\/Chicago'\)::date/i);
});

test('task payload normalization uses service counts and preserves only live arrays', () => {
  const normalized = taskCenter.normalizePayload({
    summary: { open: 2, overdue: 1, urgentUnread: 1 },
    tasks: [{ taskId: 'one', title: 'Call reference', status: 'open' }],
    notifications: [{ notificationId: 'notice', title: 'Task assigned', readAt: null }],
    assignees: [{ userId: 'person', name: 'Matt' }]
  });

  assert.equal(normalized.phase, 'ready');
  assert.deepEqual(normalized.summary, { open: 2, overdue: 1, urgentUnread: 1 });
  assert.equal(normalized.tasks[0].title, 'Call reference');
  assert.equal(normalized.notifications.length, 1);
  assert.equal(normalized.assignees.length, 1);
});

test('Talent Review Queue count uses the exact pending-stage formula', () => {
  const queue = { phase: 'ready', summary: { submitted: 3, in_review: 2, needs_more_info: 1, bench_ready: 8, closed: 4 } };
  assert.equal(reviewQueue.navigationReviewCount(queue), 6);
  assert.equal(taskCenter.reviewQueueCount(queue), 6);
  assert.equal(reviewQueue.navigationReviewCount({ phase: 'loading', summary: queue.summary }), 0);
});

test('Admin dashboard includes the live Talent Review Queue metric', () => {
  const operations = read('operations/operations.js');
  assert.match(operations, /overview:\{title:'Admin Panel'[\s\S]*?\['Talent Review Queue','—','Loading live applications…',''\]/);
  assert.match(operations, /soroTalentReviewQueue\.dashboardMetric/);
  assert.match(operations, /soro:talent-review-open-queue/);
});
