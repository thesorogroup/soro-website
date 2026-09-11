'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const helpers = require('../operations/screening-presentation');

test('speed editor fills separate values from existing before-label and prefix entries', () => {
  for (const source of ['20.42 MBPS Download - 45.57 MBPS Upload', 'Upload: 45.57 Mbps | Download: 20.42 Mbps']) {
    assert.deepEqual(helpers.internetSpeedEditorValues(source), { download: '20.42', upload: '45.57' });
  }
  assert.deepEqual(helpers.internetSpeedEditorValues('Download: 1,000 Mbps'), { download: '1000', upload: '' });
  assert.deepEqual(helpers.internetSpeedEditorValues(null), { download: '', upload: '' });
});

test('speed editor saves numeric values in the format used by the existing meters', () => {
  const stored = helpers.serializeInternetSpeed({ download: '20.42', upload: '45.57' });
  assert.equal(stored, 'Download: 20.42 Mbps | Upload: 45.57 Mbps');
  const speeds = helpers.parseInternetSpeed(stored);
  assert.deepEqual(speeds, { download: 20.42, upload: 45.57, latency: null });
  assert.equal(helpers.speedMeterPosition('internetDownload', speeds.download), 20.42 / 250 * 100);
  assert.equal(helpers.speedMeterPosition('internetUpload', speeds.upload), 45.57);
});

test('speed editor distinguishes zero, decimals, missing and cleared readings', () => {
  assert.equal(helpers.serializeInternetSpeed({download:'0',upload:'0'}), 'Download: 0 Mbps | Upload: 0 Mbps');
  assert.equal(helpers.serializeInternetSpeed({download:'.5',upload:'0.25'}), 'Download: 0.5 Mbps | Upload: 0.25 Mbps');
  assert.equal(helpers.serializeInternetSpeed({download:'',upload:'45'}), 'Upload: 45 Mbps');
  assert.equal(helpers.serializeInternetSpeed({download:'20',upload:''}, 'Download: 20 Mbps | Upload: 45 Mbps'), 'Download: 20 Mbps');
  assert.equal(helpers.serializeInternetSpeed({download:'',upload:''}, 'Download: 20 Mbps | Upload: 45 Mbps'), null);
});

test('saving unrelated results preserves the original speed entry verbatim', () => {
  for (const original of ['20.42 MBPS Download - 45.57 MBPS Upload; Ping 8 ms; https://speed.example/result/12', 'Broadband proof attached', null]) {
    assert.equal(helpers.serializeInternetSpeed(helpers.internetSpeedEditorValues(original), original), original);
  }
});

test('updating speeds retains recorded latency without borrowing the Upload reading', () => {
  const original = 'Download: 100 Mbps Upload: 5 Mbps Ping: 7 ms';
  const stored = helpers.serializeInternetSpeed({download:'120',upload:'20'}, original);
  assert.equal(stored, 'Download: 120 Mbps | Upload: 20 Mbps | Ping: 7 ms');
  assert.deepEqual(helpers.parseInternetSpeed(stored), {download:120,upload:20,latency:7});
  assert.deepEqual(helpers.internetSpeedEditorValues('Download 95 Mbps Upload not recorded'), {download:'95',upload:''});
});

test('speed editor rejects labels, negative and nonfinite values', () => {
  for (const value of ['95 Mbps', 'Download 95', '-2', 'Infinity', 'NaN', '1,000', '1e309']) {
    assert.throws(() => helpers.serializeInternetSpeed({download:value,upload:''}), /Enter a number/);
  }
});

test('real screening editor exposes two optional decimal fields and serializes before saving', () => {
  const source = fs.readFileSync(require.resolve('../operations/operations-enhancements'), 'utf8');
  const section = source.match(/<fieldset class="screening-editor-group screening-speed-group">[\s\S]*?<\/fieldset>/)[0];
  assert.match(section, /<label>Download Speed<input name="internet_download_speed" type="number" inputmode="decimal" min="0" step="any"/);
  assert.match(section, /<label>Upload Speed<input name="internet_upload_speed" type="number" inputmode="decimal" min="0" step="any"/);
  assert.doesNotMatch(section, /required|name="internet_speed"/);
  assert.match(source, /serializeInternetSpeed\(\{[\s\S]*?download: optionalText\('internet_download_speed'\),[\s\S]*?upload: optionalText\('internet_upload_speed'\)/);
  assert.match(source, /internet_speed: internetSpeed/);
});
