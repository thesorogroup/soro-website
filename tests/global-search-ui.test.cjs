const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'operations', 'global-search.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'operations', 'global-search.css'), 'utf8');

function loadHelpers() {
  const document = {
    getElementById() { return null; }
  };
  const window = {
    dispatchEvent() { return true; }
  };
  vm.createContext({ window, document, console, CustomEvent: class CustomEvent {} });
  vm.runInContext(source, vm.createContext({ window, document, console, CustomEvent: class CustomEvent {} }));
  return window.SoroGlobalSearch.__test;
}

test('global search applies the established role boundaries before asking for records', () => {
  const helpers = loadHelpers();

  assert.deepEqual(Array.from(helpers.searchTypesForRole('admin')), ['client', 'talent']);
  assert.deepEqual(Array.from(helpers.searchTypesForRole('talent_management')), ['client', 'talent']);
  assert.deepEqual(Array.from(helpers.searchTypesForRole('sales')), ['client', 'talent']);
  assert.deepEqual(Array.from(helpers.searchTypesForRole('sales_management')), ['client', 'talent']);
  assert.deepEqual(Array.from(helpers.searchTypesForRole('billing')), ['client']);
  for (const role of ['client_admin', 'client_reviewer', 'client_billing', 'virtual_assistant', '', 'unknown']) {
    assert.deepEqual(Array.from(helpers.searchTypesForRole(role)), []);
  }

  assert.equal(helpers.placeholderForTypes(['client', 'talent']), 'Search clients and Talent…');
  assert.equal(helpers.placeholderForTypes(['client']), 'Search clients…');
});

test('results normalize database-shaped Client and Talent records without exposing arbitrary fields', () => {
  const helpers = loadHelpers();
  const client = helpers.normalizeRecord({
    id: 'client-1',
    company_name: 'Northstar Medical',
    industry: 'Healthcare',
    lifecycle_stage: 'ready_for_matching',
    client_contacts: [{ full_name: 'Alex Rivera', email: 'alex@example.com', contact_role: 'primary' }],
    address_line_1: 'Private address must not render'
  }, 'client');
  const talent = helpers.normalizeRecord({
    id: 'talent-1',
    full_name: 'Santos, Maria Elena',
    preferred_name: 'Maria',
    email: 'maria@example.com',
    status: 'bench_ready',
    birth_date: '1998-01-01'
  }, 'talent');

  assert.deepEqual({ ...client }, {
    kind: 'record', entityType: 'client', id: 'client-1', recordId: 'client-1', label: 'Northstar Medical', primaryLabel: 'Northstar Medical',
    subtitle: 'Alex Rivera · Healthcare · Ready For Matching', secondaryLabel: 'Alex Rivera · Healthcare · Ready For Matching',
    meta: 'alex@example.com', statusLabel: '', matchedOn: ''
  });
  assert.deepEqual({ ...talent }, {
    kind: 'record', entityType: 'talent', id: 'talent-1', recordId: 'talent-1', label: 'Santos, Maria Elena', primaryLabel: 'Santos, Maria Elena',
    subtitle: 'Goes by Maria · Bench Ready', secondaryLabel: 'Goes by Maria · Bench Ready',
    meta: 'maria@example.com', statusLabel: '', matchedOn: ''
  });
  assert.doesNotMatch(JSON.stringify(client), /Private address/);
  assert.doesNotMatch(JSON.stringify(talent), /1998-01-01/);
});

test('the production search contract is accepted without translation by the provider', () => {
  const helpers = loadHelpers();
  const groups = helpers.normalizePayload({ results: [
    {
      entityType: 'client', recordId: 'client-contract', primaryLabel: 'Cedar Health',
      secondaryLabel: 'Primary contact · c@example.com', statusLabel: 'Active', matchedOn: 'company name'
    },
    {
      entityType: 'talent', recordId: 'talent-contract', primaryLabel: 'Reyes, Ana Marie',
      secondaryLabel: 'ana@example.com · Medical VA', statusLabel: 'Bench', matchedOn: 'skill'
    }
  ] }, ['client', 'talent']);

  assert.equal(groups.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(groups[0].items[0])), {
    kind: 'record', entityType: 'client', id: 'client-contract', recordId: 'client-contract',
    label: 'Cedar Health', primaryLabel: 'Cedar Health', subtitle: 'Primary contact · c@example.com',
    secondaryLabel: 'Primary contact · c@example.com', meta: 'Active',
    statusLabel: 'Active', matchedOn: 'company name'
  });
  assert.equal(groups[1].items[0].recordId, 'talent-contract');
  assert.equal(groups[1].items[0].meta, 'Bench');
});

test('View all is omitted when the backend returns a bounded batch without an explicit total or hasMore', () => {
  const helpers = loadHelpers();
  const groups = helpers.normalizePayload({ results: Array.from({ length: 5 }, (_, index) => ({
    entityType: 'client', recordId: `bounded-${index}`, primaryLabel: `Bounded ${index}`
  })) }, ['client']);

  assert.equal(groups[0].hasMore, false);
  assert.equal(helpers.resultEntries(groups, 'bounded').some(item => item.kind === 'view-all'), false);
});

test('each group displays at most five records and safely adds a View all result', () => {
  const helpers = loadHelpers();
  const payload = {
    clients: Array.from({ length: 7 }, (_, index) => ({ id: `c-${index}`, company_name: `Client ${index}` })),
    talent: Array.from({ length: 6 }, (_, index) => ({ id: `t-${index}`, full_name: `Talent ${index}` })),
    totals: { clients: 12, talent: 6 }
  };
  payload.clients.push({ id: 'c-0', company_name: 'Duplicate client' });
  const groups = helpers.normalizePayload(payload, ['client', 'talent']);
  const entries = helpers.resultEntries(groups, 'mar');

  assert.equal(groups[0].items.length, 5);
  assert.equal(groups[1].items.length, 5);
  assert.equal(groups[0].hasMore, true);
  assert.equal(groups[1].hasMore, true);
  assert.equal(entries.filter(item => item.kind === 'record').length, 10);
  const viewAllEntries = JSON.parse(JSON.stringify(entries.filter(item => item.kind === 'view-all')));
  assert.deepEqual(viewAllEntries, [
    { kind: 'view-all', entityType: 'client', query: 'mar', label: 'View all Clients matches' },
    { kind: 'view-all', entityType: 'talent', query: 'mar', label: 'View all Talent matches' }
  ]);
});

test('group and option markup is accessible and escapes record content', () => {
  const helpers = loadHelpers();
  const groups = helpers.normalizePayload({
    clients: [{ id: 'unsafe', company_name: '<img src=x onerror=alert(1)>', industry: 'Medical & Dental' }],
    clientTotal: 1
  }, ['client']);
  const rendered = helpers.resultsMarkup(groups, '<query>', 'search-list', 0);

  assert.match(rendered.markup, /role="group" aria-labelledby="search-list-client-heading"/);
  assert.match(rendered.markup, /role="option"[^>]+aria-selected="true"[^>]+data-global-search-index="0"/);
  assert.match(rendered.markup, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(rendered.markup, /Medical &amp; Dental/);
  assert.doesNotMatch(rendered.markup, /<img src=x/);
});

test('runtime controller includes the QuickBooks-style interaction contract', () => {
  assert.match(source, /const MIN_QUERY_LENGTH = 2/);
  assert.match(source, /const DEBOUNCE_MS = 250/);
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /searchRecords\(\{[\s\S]*?query,[\s\S]*?types:[\s\S]*?limit:[\s\S]*?signal:/);
  assert.match(source, /input\.setAttribute\('role', 'combobox'\)/);
  assert.match(source, /popup\.setAttribute\('role', 'listbox'\)/);
  assert.match(source, /aria-activedescendant/);
  assert.match(source, /event\.key === 'ArrowDown' \|\| event\.key === 'ArrowUp'/);
  assert.match(source, /event\.key === 'Enter'/);
  assert.match(source, /event\.key === 'Escape'/);
  assert.match(source, /event\.key === 'Tab'/);
  assert.match(source, /document\.addEventListener\('pointerdown', handleOutsidePointer\)/);
  assert.match(source, /input\.addEventListener\('keydown', handleKeydown, true\)/);
  assert.match(source, /event\.stopImmediatePropagation\(\)/);
  assert.match(source, /new CustomEvent\('soro:global-search-select'/);
  assert.match(source, /typeof config\.navigateResult === 'function'/);
  assert.doesNotMatch(source, /history\.(?:push|replace)State|location\.hash\s*=/);
});

test('the public API supports idempotent shell integration without owning navigation', () => {
  assert.match(source, /window\.SoroGlobalSearch = api/);
  assert.match(source, /init\(options = \{\}\)/);
  assert.match(source, /setSearchProvider\(searchRecords\)/);
  assert.match(source, /setNavigationHandler\(navigateResult\)/);
  assert.match(source, /setRoleResolver\(getEffectiveRole\)/);
  assert.match(source, /refreshRole\(\)/);
  assert.match(source, /destroy\(\)/);
});

test('the dropdown remains compact, responsive, and visible over the portal shell', () => {
  assert.match(styles, /\.soro-global-search-host\s*\{[^}]*position:\s*relative[^}]*z-index:\s*20/s);
  assert.match(styles, /\.soro-global-search-popup\s*\{[^}]*position:\s*absolute[^}]*max-height:[^}]*overflow-y:\s*auto/s);
  assert.match(styles, /\.soro-global-search-copy strong,[\s\S]*white-space:\s*nowrap/);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*\.soro-global-search-popup\s*\{[^}]*position:\s*fixed/s);
  assert.match(styles, /\.soro-global-search-option:focus-visible/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});
