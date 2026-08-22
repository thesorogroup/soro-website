const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const applicationFunction = require('../netlify/functions/talent-application.js');
const { isBirthDateAlias, sanitizeRawSubmission } = applicationFunction._test;
const source = fs.readFileSync(path.join(__dirname, '..', 'netlify', 'functions', 'talent-application.js'), 'utf8');

test('birth-date aliases are recognized regardless of case or separator style', () => {
  ['birthDate', 'birth_date', 'BIRTH-DATE', 'Birth Date', 'dateOfBirth', 'date_of_birth', 'DATE-OF-BIRTH', 'DOB', 'candidateBirthDate'].forEach(key => {
    assert.equal(isBirthDateAlias(key), true, key);
  });
  ['firstName', 'applicationDate', 'birthdayPreferenceNotes'].forEach(key => {
    assert.equal(isBirthDateAlias(key), false, key);
  });
});

test('raw application storage recursively removes DOB aliases while preserving normal fields', () => {
  const raw = {
    firstName: 'Alex',
    email: 'alex@example.com',
    birthDate: '2000-01-01',
    BIRTH_DATE: '2000-01-01',
    answers: {
      dateOfBirth: '2000-01-01',
      desiredHours: 'Full time',
      nested: [{ date_of_birth: '2000-01-01', skill: 'Calendar management' }]
    },
    consent: true
  };
  const sanitized = sanitizeRawSubmission(raw);
  assert.deepEqual(sanitized, {
    firstName: 'Alex',
    email: 'alex@example.com',
    answers: {
      desiredHours: 'Full time',
      nested: [{ skill: 'Calendar management' }]
    },
    consent: true
  });
  assert.equal(raw.birthDate, '2000-01-01', 'sanitizing must not mutate the active draft data');
});

test('persistence source sanitizes raw_submission and no longer copies DOB into legacy data', () => {
  assert.match(source, /raw_submission: sanitizeRawSubmission\(data\)/);
  const legacyStart = source.indexOf('legacy_application_data:');
  const legacyEnd = source.indexOf('uploaded_from_native_application: true', legacyStart);
  assert.ok(legacyStart >= 0 && legacyEnd > legacyStart);
  assert.doesNotMatch(source.slice(legacyStart, legacyEnd), /birth_date|birthDate|dateOfBirth|date_of_birth/i);
  assert.match(source.slice(legacyStart, legacyEnd), /first_name/);
  assert.match(source.slice(legacyStart, legacyEnd), /work_background/);
});
