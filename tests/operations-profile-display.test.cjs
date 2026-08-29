const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const screeningPresentation = require('../operations/screening-presentation.js');

const enhancementsPath = path.join(__dirname, '..', 'operations', 'operations-enhancements.js');
const enhancementsSource = fs.readFileSync(enhancementsPath, 'utf8');
const tabsSource = fs.readFileSync(path.join(__dirname, '..', 'operations', 'talent-file-tabs.js'), 'utf8');
const tabsStyles = fs.readFileSync(path.join(__dirname, '..', 'operations', 'talent-file-tabs.css'), 'utf8');
const initialsStart = enhancementsSource.indexOf('function talentInitials');
const initialsEnd = enhancementsSource.indexOf('const pronounLabels', initialsStart);
const screeningStart = enhancementsSource.indexOf('function percentageValue');
const screeningEnd = enhancementsSource.indexOf('function personalityCard', screeningStart);
const folderHeightStart = tabsSource.indexOf('function syncFolderHeight');
const folderHeightEnd = tabsSource.indexOf('function watchFolderHeight', folderHeightStart);

if (initialsStart < 0 || initialsEnd < 0 || screeningStart < 0 || screeningEnd < 0 || folderHeightStart < 0 || folderHeightEnd < 0) throw new Error('Profile display helpers could not be located.');

const context = {
  escapeHtml: value => String(value ?? ''),
  isExternalLink: () => false,
  resultValue: value => String(value || 'Result not yet recorded'),
  screeningPresentation
};
vm.createContext(context);
vm.runInContext(enhancementsSource.slice(initialsStart, initialsEnd), context);
vm.runInContext(enhancementsSource.slice(screeningStart, screeningEnd), context);
vm.runInContext(tabsSource.slice(folderHeightStart, folderHeightEnd), context);

function folderHeightFixture(bodyHeight) {
  const attributes = {};
  const paths = Object.fromEntries([
    '.talent-folder-shadow',
    '.talent-folder-paper',
    '.talent-folder-grain',
    '.talent-folder-outer-edge'
  ].map(selector => [selector, { setAttribute(name, value) { attributes[`${selector}:${name}`] = value; } }]));
  const body = { getBoundingClientRect: () => ({ height: bodyHeight }) };
  const art = {
    style: {},
    setAttribute(name, value) { attributes[`art:${name}`] = value; },
    querySelector: selector => paths[selector]
  };
  const shell = { querySelector: selector => selector === '.talent-file-body' ? body : selector === '.talent-folder-art' ? art : null };
  return { shell, art, attributes };
}

test('Talent initials use first-name then last-name order', () => {
  assert.equal(context.talentInitials('Johnson, Matthew Alan'), 'MJ');
  assert.equal(context.talentInitials('Gedrianne Bansag Abadies'), 'GA');
});

test('The no-headshot placeholder uses a minimal head and bust without facial features', () => {
  const placeholder = context.talentPlaceholder('Johnson, Matthew Alan');
  assert.equal((placeholder.match(/<circle\b/g) || []).length, 1);
  assert.equal((placeholder.match(/<path\b/g) || []).length, 1);
  assert.doesNotMatch(placeholder, /eye|nose|mouth|hair/i);
  assert.match(placeholder, />MJ<\/b>/);
});

test('The approved folder is one continuous vector and the screening column remains independent', () => {
  assert.match(tabsStyles, /max-width:\s*1170px/);
  assert.match(tabsStyles, /grid-template-columns:\s*repeat\(var\(--folder-tab-count\),\s*minmax\(0,\s*1fr\)\)/);
  assert.match(tabsStyles, /grid-template-columns:\s*228px\s+minmax\(0,\s*1fr\)\s+392px/);
  assert.match(tabsStyles, /min-height:\s*374px/);
  assert.match(tabsStyles, /white-space:\s*nowrap/);
  assert.match(tabsStyles, /\.talent-file-panels\s*\{\s*padding:\s*16px 0 0;\s*\}/);
  assert.doesNotMatch(tabsStyles, /folder-tabs-rail\.svg/);
  assert.match(tabsSource, /class="talent-folder-art"/);
  assert.match(tabsSource, /class="talent-folder-front-seam" d="M0 85H1240"/);
  assert.match(tabsSource, /class="talent-folder-outer-edge" d="M0 58V415/);
  assert.match(tabsSource, /M31 13\.5C31 2\.5 8 2\.5 8 22v70/);
  assert.doesNotMatch(tabsSource, /talent-paperclip-pocket/);
  assert.match(tabsSource, /function syncFolderArt\(shell\)/);
  assert.match(tabsSource, /function syncFolderHeight\(shell\)/);
  assert.match(tabsSource, /Math\.max\(374, Math\.ceil\(body\.getBoundingClientRect\(\)\.height\)\)/);
  assert.match(tabsSource, /folderHeightObserver = new ResizeObserver/);
  assert.match(tabsSource, /art\.querySelector\('\.talent-folder-outer-edge'\)\?\.setAttribute\('d', edgePath\)/);
  assert.match(tabsSource, /scheduleFolderHeightSync\(\);/);
  assert.match(tabsSource, /const width = 1240 \/ count/);
  assert.match(tabsSource, /syncFolderArt\(shell\);\s*activateTab\(activeTab, shell\)/);
  assert.match(tabsSource, /summaryColumn\.append\(screening\)/);
  assert.doesNotMatch(tabsSource, /profilePanel\.append\(screening\)/);
});

test('The folder lower edge expands with long header content without changing its approved minimum', () => {
  const baseline = folderHeightFixture(360);
  context.syncFolderHeight(baseline.shell);
  assert.equal(baseline.attributes['art:viewBox'], '0 0 1240 434');
  assert.equal(baseline.art.style.height, '442px');
  assert.equal(baseline.attributes['.talent-folder-outer-edge:d'], 'M0 58V415Q0 432 17 432H1223Q1240 432 1240 415V58');

  const expanded = folderHeightFixture(510.4);
  context.syncFolderHeight(expanded.shell);
  assert.equal(expanded.attributes['art:viewBox'], '0 0 1240 571');
  assert.equal(expanded.art.style.height, '579px');
  assert.equal(expanded.attributes['.talent-folder-outer-edge:d'], 'M0 58V552Q0 569 17 569H1223Q1240 569 1240 552V58');
});

test('English score extraction prefers the numerator in an x/100 result', () => {
  assert.equal(context.percentageValue('EF SET 63/100 · CEFR C1'), 63);
});

test('English score extraction accepts an explicit percentage', () => {
  assert.equal(context.percentageValue('CEFR B2 · 86%'), 86);
});

test('A recorded zero score remains a real score rather than Pending', () => {
  assert.equal(context.percentageValue('0/100'), 0);
  const card = context.englishCard({ english_test_result: '0/100' });
  assert.match(card, /<strong>0<\/strong><small>practice<\/small>/);
  assert.doesNotMatch(card, /<small>Pending<\/small>/);
});

test('A plain result without a numeric score does not invent a percentage', () => {
  assert.equal(context.percentageValue('CEFR C1 · Advanced'), null);
  const card = context.englishCard({ english_test_result: 'CEFR C1 · Advanced' });
  assert.match(card, /<strong>—<\/strong><small>Pending<\/small>/);
});
