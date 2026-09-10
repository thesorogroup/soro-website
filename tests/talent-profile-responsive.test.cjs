'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const css = fs.readFileSync(path.join(__dirname, '../operations/talent-file-tabs.css'), 'utf8');
const marker = '/* Keep responsive rules after the approved folder styles';
const responsive = css.slice(css.indexOf(marker));

// Browser geometry is also checked in work/mobile-profile-review. These guards
// catch the original cascade regression without pretending to emulate layout.
test('responsive overrides follow the final desktop and self-profile folder rules', () => {
  assert.ok(css.indexOf(marker) > css.lastIndexOf('@media (min-width: 1101px)'));
  assert.match(responsive, /@media \(max-width: 1399px\)/);
  assert.match(responsive, /grid-template-columns: 190px minmax\(0, 1fr\)/);
  assert.match(responsive, /\.profile-communication-preferences \{ overflow-wrap: anywhere; word-break: normal; \}/);
  const index = fs.readFileSync(path.join(__dirname, '../operations/index.html'), 'utf8');
  assert.match(index, /talent-file-tabs\.css\?v=20260910-mobile-profile/);
});

test('phone hero stacks for both staff and Talent self-view without fixed identity columns', () => {
  const phone = responsive.slice(responsive.indexOf('@media (max-width: 760px)'));
  assert.match(phone, /\.talent-file-body \.talent-profile-hero,\s*\.talent-self-profile-page \.talent-file-body \.talent-profile-hero \{\s*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(phone, /\.talent-headshot \{ width: 160px; height: 196px;/);
  assert.match(phone, /\.profile-identity \{ width: 100%; padding-top: 0; \}/);
  assert.match(phone, /min-height: 44px; font-size: 14px; white-space: normal;/);
});

test('supporting grids fit tablet and phone widths including the more-specific self-view stats', () => {
  assert.match(responsive, /\.profile-layout \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(responsive, /\.talent-self-profile-page \.talent-file-profile-panel \.profile-stat-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
  const smallPhone = responsive.slice(responsive.indexOf('@media (max-width: 520px)'));
  assert.match(smallPhone, /\.talent-self-profile-page \.talent-file-profile-panel \.profile-stat-grid \{ grid-template-columns: minmax\(0, 1fr\); \}/);
});

test('mobile photos are straight and centered with both paperclip renderers hidden', () => {
  const mobile = responsive.slice(responsive.indexOf('@media (max-width: 1100px)'));
  assert.match(mobile, /\.talent-headshot \{ transform: none; justify-self: center; \}/);
  assert.match(mobile, /\.talent-headshot::before,\s*\.talent-file-body \.talent-headshot::after \{ content: none; display: none; \}/);
  assert.match(mobile, /\.talent-paperclip \{ display: none; \}/);
  assert.doesNotMatch(mobile, /transform: rotate/);
});
