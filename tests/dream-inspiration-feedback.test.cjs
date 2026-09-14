'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ui = require('../operations/dream-inspiration');

test('oversized inspiration photos explain the actual size and how to retry', () => {
  const message = ui.photoDimensionError(8333, 8333);
  assert.match(message, /69\.4\s*megapixels/i);
  assert.match(message, /40\s*megapixels/i);
  assert.match(message, /resiz/i);
  assert.match(message, /copy/i);
  assert.match(message, /2,?000/);
  assert.match(message, /longest side/i);
  assert.match(message, /select|choose/i);
  assert.match(message, /save/i);
});

test('the 40-megapixel limit includes the exact boundary and permits normal photos', () => {
  for (const [width, height] of [[2000, 2000], [8000, 5000], [5000, 8000], [1, 1]]) {
    assert.equal(ui.photoDimensionError(width, height), '', `${width} by ${height}`);
  }
  assert.notEqual(ui.photoDimensionError(8001, 5000), '');
});

test('unreadable photo dimensions explain which replacement image types can be selected', () => {
  for (const [width, height] of [[0, 100], [100, 0], [0, 0], [-1, 100], [Infinity, 100], [100, NaN]]) {
    const message = ui.photoDimensionError(width, height);
    assert.match(message, /choose|select/i);
    assert.match(message, /another|different/i);
    assert.match(message, /JPG/i);
    assert.match(message, /PNG/i);
    assert.match(message, /WebP/i);
  }
});

test('save errors become visible, retain literal text, and receive focus without scrolling', () => {
  const focusCalls = [];
  const message = {textContent: ''};
  const alert = {
    hidden: true,
    focus(options) { focusCalls.push(options); },
    querySelector(selector) {
      assert.equal(selector, '[data-error-message]');
      return message;
    },
  };
  const dialog = {
    querySelector(selector) {
      if (selector === '[data-error]') return alert;
      assert.fail(`Unexpected error element selector: ${selector}`);
    },
  };
  const error = 'Photo could not be saved. Choose another image. <img src=x>';
  ui.showSaveError(dialog, error);
  assert.equal(alert.hidden, false);
  assert.equal(message.textContent, error);
  assert.deepEqual(focusCalls, [{preventScroll: true}]);
  ui.showSaveError(dialog, 'Please select the smaller copy and save again.');
  assert.equal(message.textContent, 'Please select the smaller copy and save again.');
  assert.equal(focusCalls.length, 2);
  ui.showSaveError(dialog, undefined);
  assert.match(message.textContent, /could not be saved/i);
  assert.match(message.textContent, /try again/i);
});

test('the upload form keeps errors in its footer outside the scrolling fields', () => {
  const source = fs.readFileSync(path.join(__dirname, '../operations/dream-inspiration.js'), 'utf8');
  const template = source.match(/dialog\.innerHTML\s*=\s*`([\s\S]*?)`;/)?.[1];
  assert.ok(template, 'The shared editor dialog template is present');
  const scrollStart = template.indexOf('<div class="di-form">');
  const footerStart = template.indexOf('<footer');
  const footerEnd = template.indexOf('</footer>');
  const errorStart = template.indexOf('data-error');
  assert.ok(scrollStart >= 0 && footerStart > scrollStart, 'The fields are followed by a footer');
  assert.ok(errorStart > footerStart && errorStart < footerEnd, 'The error is inside the footer');
  assert.doesNotMatch(template.slice(scrollStart, footerStart), /data-error/);
  assert.match(template.slice(footerStart, footerEnd), /data-error-message/);
  assert.match(source, /JPG, PNG, or WebP[^`]*40 megapixels/i);
  assert.match(source, /photoDimensionError\(img\.naturalWidth,\s*img\.naturalHeight\)/);
  assert.match(source, /catch\(error\)[\s\S]*?showSaveError\(dialog,/);
});
