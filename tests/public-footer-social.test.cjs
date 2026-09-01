const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const pages = [
  'index.html',
  'about-us.html',
  'businesses.html',
  'contact.html',
  'how-it-works.html',
  'virtual-assistants.html'
];
const instagramUrl = 'https://www.instagram.com/thesorogroup?igsi=NjllNmUwMzl6N3V0';
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

function instagramAnchor(source) {
  const escapedUrl = instagramUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`<a\\b[^>]*href="${escapedUrl}"[^>]*>[\\s\\S]*?<\\/a>`));
  assert.ok(match, 'Expected an Instagram footer link.');
  return match[0].replace(/\s+/g, ' ').trim();
}

test('every public footer links safely and accessibly to the Soro Instagram account', () => {
  for (const page of pages) {
    const source = read(page);
    const anchor = instagramAnchor(source);

    assert.equal(source.split(instagramUrl).length - 1, 1, `${page} must contain one Instagram URL.`);
    assert.match(anchor, /class="soro-footer-social-link"/);
    assert.match(anchor, /aria-label="Follow Soro Group on Instagram"/);
    assert.match(anchor, /target="_blank"/);
    assert.match(anchor, /rel="noopener noreferrer"/);
    assert.match(anchor, /<span[^>]*aria-hidden="true"[^>]*>[\s\S]*<svg\b/);
    assert.match(anchor, />Instagram<\/a>$/);
  }
});

test('the Instagram glyph is sized by the shared footer stylesheet', () => {
  const styles = read('assets/styles.css');
  assert.match(styles, /\.soro-footer-social-link \.soro-instagram-icon svg\s*\{[^}]*display:\s*block[^}]*width:\s*15px[^}]*height:\s*15px/s);
});
