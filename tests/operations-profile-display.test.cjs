const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const screeningPresentation = require('../operations/screening-presentation.js');

const enhancementsPath = path.join(__dirname, '..', 'operations', 'operations-enhancements.js');
const enhancementsSource = fs.readFileSync(enhancementsPath, 'utf8');
const initialsStart = enhancementsSource.indexOf('function talentInitials');
const initialsEnd = enhancementsSource.indexOf('const pronounLabels', initialsStart);
const screeningStart = enhancementsSource.indexOf('function percentageValue');
const screeningEnd = enhancementsSource.indexOf('function personalityCard', screeningStart);

if (initialsStart < 0 || initialsEnd < 0 || screeningStart < 0 || screeningEnd < 0) throw new Error('Profile display helpers could not be located.');

const context = {
  escapeHtml: value => String(value ?? ''),
  isExternalLink: () => false,
  resultValue: value => String(value || 'Result not yet recorded'),
  screeningPresentation
};
vm.createContext(context);
vm.runInContext(enhancementsSource.slice(initialsStart, initialsEnd), context);
vm.runInContext(enhancementsSource.slice(screeningStart, screeningEnd), context);

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
