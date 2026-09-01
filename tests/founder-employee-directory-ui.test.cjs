const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('Employees uses the Admin-only directory RPC and displays the protected Founder title', () => {
  const source = read('operations/admin-employee-management.js');

  assert.match(source, /\.rpc\(['"]admin_employee_directory['"]\)/);
  assert.match(source, /access\.role === ['"]admin['"] && access\.is_founder === true/);
  assert.match(source, /return ['"]The Founder['"]/);
  assert.match(source, /Reserved overseer identity/);
  assert.doesNotMatch(source, /\.from\(['"]employee_profiles['"]\)[\s\S]{0,200}platform_users!inner/);
});

test('incomplete Founder row never invents private employee details or exposes invalid actions', () => {
  const source = read('operations/admin-employee-management.js');

  assert.match(source, /employee\?\.profile_complete === true/);
  assert.match(source, /Hire date, phone, address, and payment details have intentionally not been invented/);
  assert.match(source, /profileComplete && status\.setupRequired/);
  assert.match(source, /profileComplete \? '<button type="button" class="admin-record-button" data-edit-payment-route/);
  assert.match(source, /employee\.phone \|\| ['"]Not recorded['"]/);
  assert.match(source, /The Founder oversees Soro through the established Administrator access boundary/);
});
