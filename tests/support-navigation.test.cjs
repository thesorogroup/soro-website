const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const ui=require('../operations/support-tickets');
const read=name=>fs.readFileSync(require.resolve(`../operations/${name}`),'utf8');

test('Support Tickets sidebar reuses the existing inbox route and starts hidden',()=>{
 const html=read('index.html');
 assert.equal((html.match(/id="support-tickets-nav"/g)||[]).length,1);
 assert.match(html,/<button class="nav-link" id="support-tickets-nav" data-view="help" hidden>Support Tickets<\/button>/);
 assert.match(html,/id="help-button"/);
});

test('Only existing ticket-review staff roles receive the inbox sidebar entry',()=>{
 for(const role of ['admin','sales','sales_management','talent_management'])assert.equal(ui.canReviewRole(role),true,role);
 for(const role of ['billing','client_admin','client_reviewer','client_billing','virtual_assistant','founder','',null,undefined])assert.equal(ui.canReviewRole(role),false,String(role));
});

test('Support sidebar visibility is reset after generic navigation on every role or access change',()=>{
 const source=read('operations.js');
 const fragment=source.split('function syncAuthorizedNavigation(access=window.soroCurrentAccess){')[1].split('  const actualRole=actualAuthenticatedRole(access);')[0];
 const button={dataset:{view:'help'},hidden:true};
 const context={access:null,effectiveWorkspaceRole:access=>access?.role,authenticatedClientRoles:new Set(),authenticatedEmployeeViews:Object.fromEntries(['admin','sales','sales_management','talent_management','billing','client_admin','virtual_assistant'].map(role=>[role,new Set(['help'])])),window:{SoroSupportTickets:ui},document:{querySelectorAll:()=>[button],getElementById:()=>button}};
 vm.createContext(context);
 const sync=access=>{context.access=access;vm.runInContext(`(()=>{${fragment}})()`,context);return button.hidden;};
 for(const role of ['admin','sales','sales_management','talent_management'])assert.equal(sync({user_id:'sample',role}),false,role);
 assert.equal(sync({user_id:'sample',role:'admin',is_founder:true}),false);
 for(const role of ['billing','client_admin','virtual_assistant'])assert.equal(sync({user_id:'sample',role}),true,role);
  for(const access of [null,{role:'admin'},{user_id:'sample',role:'admin',active:false},{user_id:'sample',role:'admin',must_change_password:true}])assert.equal(sync(access),true);
  // showAuthorizedApp passes the original platform_users row (no user_id),
  // after setting the authenticated identity on window.soroCurrentAccess.
  const authRow={organization_id:'sample-org',role:'admin',active:true,must_change_password:false,is_founder:true};
  context.window.soroCurrentAccess={...authRow,user_id:'sample'};
  assert.equal(sync(authRow),false,'Actual Founder sign-in row displays the menu');
  assert.equal(sync({...authRow,role:'talent_management'}),false);
  assert.equal(sync({...authRow,role:'sales'}),false);
  assert.equal(sync({...authRow,role:'virtual_assistant'}),true);
  assert.equal(sync({...authRow,must_change_password:true}),true);
  assert.equal(sync(null),true,'Sign-out hides navigation even while identity clears');
  context.window.soroCurrentAccess=null;
  assert.equal(sync(authRow),true,'No verified session fails closed');
 context.window.SoroSupportTickets=undefined;
 assert.equal(sync({user_id:'sample',role:'admin'}),true,'Fail closed until the support module is loaded');
});

test('Support heading follows server capabilities and prior support handlers unmount before workspace previews',()=>{
 assert.match(read('support-tickets.js'),/heading\.textContent=data\.internal\?'Support Tickets':'Help & Support'/);
 const source=read('operations-enhancements.js');
 assert.match(source,/window\.SoroSupportTickets\?\.unmount\?\.\(\);\s*if\(typeof adminPreviewingNonAdminWorkspace/);
});
