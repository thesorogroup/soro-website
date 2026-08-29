const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('attendance migration keeps scope and timestamps server-derived', () => {
  const sql = read('supabase/migrations/20260829_023_talent_attendance.sql');

  assert.match(sql, /unique \(applicant_id, work_date\)/i);
  assert.match(sql, /where checked_out_at is null/i);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /clock_timestamp\(\)/i);
  assert.match(sql, /private\.talent_attendance_identity\(p_actor_user_id\)/i);
  assert.match(sql, /placement\.applicant_id = session\.applicant_id/i);
  assert.match(sql, /talent_attendance_scope_guard/i);
  assert.match(sql, /client\.archived_at is null/i);
  assert.match(sql, /state', 'not_yet_available'/i);
  assert.match(sql, /state', 'needs_review'/i);
  assert.doesNotMatch(sql, /grant select, insert, update, delete on table public\.talent_attendance_sessions/i);
  assert.doesNotMatch(sql, /grant select on table public\.talent_attendance_sessions to authenticated/i);
  assert.doesNotMatch(sql, /when unique_violation[\s\S]*return public\.get_talent_attendance_status/i);
});

test('browser history can read only explicitly safe attendance columns', () => {
  const sql = read('supabase/migrations/20260829_023_talent_attendance.sql');
  const tabs = read('operations/talent-file-tabs.js');
  const safeGrant = /grant select \(([\s\S]*?)\) on table public\.talent_attendance_sessions to authenticated/i.exec(sql)?.[1] || '';

  for (const safeColumn of ['applicant_id', 'placement_id', 'work_date', 'work_timezone', 'started_at', 'checked_out_at']) {
    assert.match(safeGrant, new RegExp(`\\b${safeColumn}\\b`, 'i'));
  }
  for (const privateColumn of ['start_request_id', 'checkout_request_id', 'started_by_user_id', 'checked_out_by_user_id', 'corrected_by_user_id', 'correction_note']) {
    assert.doesNotMatch(safeGrant, new RegExp(`\\b${privateColumn}\\b`, 'i'));
    assert.doesNotMatch(tabs, new RegExp(`\\b${privateColumn}\\b`, 'i'));
  }
});

test('Talent workspace contains one real dashboard action and no old placeholders', () => {
  const html = read('operations/index.html');
  const operations = read('operations/operations.js');
  const workday = read('operations/talent-workday.js');

  assert.ok(html.indexOf('talent-workday.js') < html.indexOf('operations.js'));
  assert.match(operations, /soroTalentWorkday\?\.actionMarkup\(\{currentView:current,actualRole:actualAuthenticatedRole\(\)\}\)/);
  assert.match(operations, /role==='va'[\s\S]*talentWorkdayAction/);
  assert.doesNotMatch(operations, /role==='va'\?'Start Day'/);
  assert.doesNotMatch(operations, /role==='va'\?'Time off request'/);
  assert.doesNotMatch(operations, /Checked in at 8:58 AM/);
  assert.match(workday, /currentView[^\n]*overview/);
  assert.match(workday, /actualRole[^\n]*virtual_assistant|TALENT_ROLE/);
});
