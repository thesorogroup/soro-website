const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

test('the Operations shell loads every Client lifecycle module before its controller', () => {
  const html = read('operations/index.html');
  const controller = html.indexOf('operations.js?v=20260901-client-lifecycle');
  ['available-talent-bench.js', 'client-shortlist-workflow.js', 'client-workflow.js', 'client-placement-workflow.js'].forEach(file => {
    assert.ok(html.indexOf(file) > -1, `${file} must be loaded.`);
    assert.ok(html.indexOf(file) < controller, `${file} must load before operations.js.`);
  });
  assert.match(html, /client-placement-workflow\.css/);
});

test('placement routing preserves one hiring request through internal and Client roles', () => {
  const source = read('operations/operations.js');
  ['admin', 'talent_management', 'sales', 'sales_management', 'client_admin', 'client_reviewer'].forEach(role => {
    assert.match(source, new RegExp(`${role}:new Set\\(\\[[^\\]]*'client-placement'`), `${role} must be allowed into the request-scoped placement view.`);
  });
  assert.match(source, /#client-placement\/\$\{id\}/);
  assert.match(source, /initialPlacementHash=location\.hash\.match/);
  assert.match(source, /placement\.mount\(root,options\)/);
  assert.match(source, /if\(!authenticatedClientRoles\.has\(accessRole\)\)options\.onOpenTalent/);
  assert.match(source, /previewingAnotherWorkspace[\s\S]*createApprovalAdapter/);
});

test('Client Hub and shortlist both continue into interviews and placement without reselecting the request', () => {
  const controller = read('operations/operations.js');
  const clientWorkflow = read('operations/client-workflow.js');
  const shortlist = read('operations/client-shortlist-workflow.js');

  assert.match(controller, /\['interview','selection','placement','onboarding'\]\.includes\(action\)/);
  assert.match(controller, /preferredHiringRequestId/);
  assert.match(clientWorkflow, /data-client-workflow-next=/);
  assert.match(shortlist, /data-shortlist-placement=/);
  assert.match(shortlist, /soro:client-placement-open/);
  assert.match(shortlist, /Interviews &amp; selection/);
});

test('the live placement module remains the default and preview data is explicit only', () => {
  const source = read('operations/client-placement-workflow.js');
  assert.match(source, /const ENDPOINT = '\/\.netlify\/functions\/client-placement-workflow'/);
  assert.match(source, /activeAdapter = options\.adapter \|\| createEndpointAdapter/);
  assert.doesNotMatch(source, /activeAdapter = createApprovalAdapter\(\)/);
});
