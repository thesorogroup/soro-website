const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const helpers = require('../operations/screening-presentation.js');

test('English presentation tiers use the announced lower, middle, and higher ranges', () => {
  assert.deepEqual([0, 59].map(value => helpers.semanticTier('english', value).label), ['Lower', 'Lower']);
  assert.deepEqual([60, 79].map(value => helpers.semanticTier('english', value).label), ['Middle', 'Middle']);
  assert.deepEqual([80, 100].map(value => helpers.semanticTier('english', value).label), ['Higher', 'Higher']);
  assert.equal(helpers.semanticTier('english', 80).className, 'screening-tier--high');
  assert.equal(helpers.semanticTier('english', null).className, 'screening-tier--pending');
});

test('Download track has its own reference tiers and 250 Mbps visual scale', () => {
  assert.equal(helpers.semanticTier('internetDownload', 24).label, 'Lower reference range');
  assert.equal(helpers.semanticTier('internetDownload', 25).label, 'Standard reference range');
  assert.equal(helpers.semanticTier('internetDownload', 99).label, 'Standard reference range');
  assert.equal(helpers.semanticTier('internetDownload', 100).label, 'Higher reference range');
  const meter = helpers.speedMeterConfiguration('internetDownload', 125);
  assert.equal(meter.maximum, 250);
  assert.equal(meter.position, 50);
  assert.deepEqual([meter.lowerBoundary, meter.middleBoundary], [25, 100]);
});

test('Upload track has independent tiers and a 100 Mbps visual scale', () => {
  assert.equal(helpers.semanticTier('internetUpload', 4).label, 'Lower reference range');
  assert.equal(helpers.semanticTier('internetUpload', 5).label, 'Standard reference range');
  assert.equal(helpers.semanticTier('internetUpload', 24).label, 'Standard reference range');
  assert.equal(helpers.semanticTier('internetUpload', 25).label, 'Higher reference range');
  const meter = helpers.speedMeterConfiguration('internetUpload', 25);
  assert.equal(meter.maximum, 100);
  assert.equal(meter.position, 25);
  assert.deepEqual([meter.lowerBoundary, meter.middleBoundary], [5, 25]);
});

test('Reference thresholds remain configurable without changing the parser', () => {
  const overrides = { internetUpload: { lowerMax: 2, middleMax: 9, meterMax: 50 } };
  assert.equal(helpers.semanticTier('internetUpload', 10, overrides).label, 'Higher reference range');
  assert.equal(helpers.speedMeterConfiguration('internetUpload', 25, overrides).position, 50);
});

test('Speed parsing uses explicit labels in any order, ignores URL digits, and preserves zero', () => {
  const parsed = helpers.parseInternetSpeed('https://speed.example/results/987654 · Upload: 0 Mbps · Ping 7 ms · Download 125.5 Mbps');
  assert.deepEqual({ ...parsed }, { download: 125.5, upload: 0, latency: 7 });

  const reverseLabels = helpers.parseInternetSpeed('0 Mbps download · 12.5 Mbps upload · 0 ms latency');
  assert.deepEqual({ ...reverseLabels }, { download: 0, upload: 12.5, latency: 0 });
});

test('Speed parsing does not infer meaning from unlabeled number order', () => {
  assert.deepEqual({ ...helpers.parseInternetSpeed('95 · 48 · 7') }, { download: null, upload: null, latency: null });
});

test('Every standard four-letter personality code has a neutral decoder', () => {
  Object.keys(helpers.MBTI_DESCRIPTIONS).forEach(code => {
    const result = helpers.mbtiDescriptionFromValue(`MBTI: ${code}`);
    assert.equal(result.code, code);
    assert.match(result.dimensions, / · /);
    assert.ok(result.summary.length > 30);
  });
});

test('ENFJ-A and ENFJ-T retain the 16Personalities modifier separately', () => {
  const assertive = helpers.mbtiDescriptionFromValue('Personality type: ENFJ-A');
  const turbulent = helpers.mbtiDescriptionFromValue('MBTI-style ENFJ-T');
  assert.equal(assertive.code, 'ENFJ');
  assert.equal(assertive.modifierLabel, 'Assertive modifier');
  assert.equal(turbulent.displayedCode, 'ENFJ-T');
  assert.equal(turbulent.modifierLabel, 'Turbulent modifier');
});

test('Personality parsing uses explicit result labels instead of positional guessing', () => {
  const parsed = helpers.parsePersonalityResults('MBTI: ENFJ-T | DISC: I 42, S 31 | Enneagram: Type 2');
  assert.equal(parsed.disc, 'I 42, S 31');
  assert.equal(parsed.enneagram, 'Type 2');
  assert.equal(parsed.mbti, 'ENFJ-T');
  assert.equal(parsed.mbtiDescription.code, 'ENFJ');

  const unlabeled = helpers.parsePersonalityResults('D 42, I 30 | Type 3');
  assert.equal(unlabeled.disc, '');
  assert.equal(unlabeled.enneagram, '');
});

test('Production cards retain required practice-score and reference-tier wording', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'operations', 'operations-enhancements.js'), 'utf8');
  assert.match(source, /EF SET Quick Check · practice score/);
  assert.match(source, /Not a certified CEFR level\./);
  assert.match(source, /visual context only, not a hiring recommendation/);
  assert.match(source, /Soro operational reference/);
  assert.match(source, /connectionMeterTrack\('Download', 'internetDownload'/);
  assert.match(source, /connectionMeterTrack\('Upload', 'internetUpload'/);
  assert.match(source, /not clinical diagnoses or measures of job performance/);
});
