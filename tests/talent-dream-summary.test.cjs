'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dream = require('../operations/talent-dream-summary.js');
const applicant = { id: 'talent-1', auth_user_id: 'talent-user', organization_id: 'soro', greatest_dream: 'Finish my education and support my family.' };
const access = role => ({ user_id: role === 'virtual_assistant' ? 'talent-user' : 'staff-user', organization_id: 'soro', role });
const options = (role, extra = {}) => ({ access: access(role), applicant, effectiveRole: role, selfView: role === 'virtual_assistant', ...extra });

for (const role of ['admin', 'talent_management', 'virtual_assistant']) {
  test(`${role} sees the existing private aspiration in its authorized context`, () => {
    const html = dream.render(options(role));
    assert.match(html, /Finish my education and support my family\./);
    assert.match(html, /Dream Pathway/);
    assert.doesNotMatch(html, /credit balance|\$200|funded|milestone complete/i);
  });
}
for (const role of ['sales', 'sales_management', 'client_admin', 'client_reviewer', 'client_billing', 'billing', '', 'founder']) {
  test(`${role || 'missing role'} cannot render a private Dream card`, () => assert.equal(dream.render(options(role)), ''));
}
test('Founder authorization uses its real Admin role, not a new role string', () => {
  assert.ok(dream.render(options('admin', { access: { ...access('admin'), is_founder: true } })));
});
test('workspace previews cannot cross the actual or effective role privacy boundary', () => {
  for (const effectiveRole of ['sales', 'sales_management', 'client_admin', 'virtual_assistant', '']) {
    assert.equal(dream.render(options('admin', { effectiveRole })), '');
  }
  assert.equal(dream.render(options('sales', { effectiveRole: 'admin' })), '');
  assert.equal(dream.render(options('admin', { effectiveRole: 'virtual_assistant', selfView: true })), '');
});
test('Talent needs the self route and exact linked account, not only a Talent role', () => {
  assert.equal(dream.render(options('virtual_assistant', { selfView: false })), '');
  assert.equal(dream.render(options('virtual_assistant', { applicant: { ...applicant, auth_user_id: 'someone-else' } })), '');
  assert.equal(dream.render(options('virtual_assistant', { applicant: { ...applicant, auth_user_id: '' } })), '');
});
test('missing identity, missing organization, and organization mismatches fail closed', () => {
  for (const role of ['admin', 'talent_management', 'virtual_assistant']) {
    for (const replacement of [null, { role }, { ...access(role), user_id: '' }, { ...access(role), organization_id: '' }, { ...access(role), organization_id: 'other' }]) {
      assert.equal(dream.render(options(role, { access: replacement })), '');
    }
    assert.equal(dream.render(options(role, { applicant: { ...applicant, organization_id: '' } })), '');
  }
  assert.equal(dream.render(), '');
});
test('empty state contains no invented goal, progress, allocation, or funding promise', () => {
  const html = dream.render(options('virtual_assistant', { applicant: { ...applicant, greatest_dream: '   ' } }));
  assert.match(html, /Every dream starts somewhere/);
  assert.doesNotMatch(html, /Finish my education|\$|\d+%|Next check-in/);
});
test('Dream text is escaped and long dreams have a native, keyboard-accessible disclosure', () => {
  const content = '<img src=x onerror="alert(1)"> & my family\n' + 'A meaningful personal goal. '.repeat(30);
  const html = dream.render(options('admin', { applicant: { ...applicant, greatest_dream: content } }));
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp;/);
  assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /<details class="talent-dream-story"><summary>/);
  assert.match(html, /Read Full Dream/);
  assert.match(html, /Show Less/);
});
test('Benefits action appears only when the existing Benefits tab is authorized', () => {
  assert.doesNotMatch(dream.render(options('admin')), /data-talent-dream-benefits/);
  assert.match(dream.render(options('admin', { benefitsAvailable: true })), /data-talent-dream-benefits/);
  assert.equal(dream.render(options('sales', { benefitsAvailable: true })), '');
});
test('shared renderer has one aspiration home with defensive Sales cleanup and ordered assets', () => {
  const read = file => fs.readFileSync(path.join(__dirname, '../operations', file), 'utf8');
  const tabs = read('talent-file-tabs.js');
  const index = read('index.html');
  assert.ok(index.indexOf('talent-dream-summary.js') < index.indexOf('talent-file-tabs.js'));
  assert.ok(index.indexOf('talent-profile-theme.css') > index.indexOf('talent-file-tabs.css'));
  assert.match(tabs, /profilePanel\.insertAdjacentHTML\('beforeend', dreamMarkup\)/);
  assert.match(tabs, /details\.querySelectorAll\('\.profile-details > div'\)/);
  assert.match(tabs, /activateTab\('benefits', shell\)/);
  assert.match(read('read-only-talent-profile.js'), /'\.talent-dream-summary'/);
  assert.doesNotMatch(read('talent-profile-theme.css'), /talent-headshot|talent-paperclip|talent-folder/);
});
