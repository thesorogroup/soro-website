const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../operations/page-task-action.js'),'utf8');
const operations=fs.readFileSync(require.resolve('../operations/operations.js'),'utf8');
const roleBlock=operations.match(/const authenticatedEmployeeViews=Object.freeze\(([\s\S]*?)\);/)[1];
const views=vm.runInNewContext('('+roleBlock+')');
function setup(role='admin'){
 const classes=new Set(),listeners={},toolbar={hidden:true},button={addEventListener(type,fn){this[type]=fn;}},related={value:''},title={focused:false,focus(){this.focused=true;}},dialog={open:false,opens:0,showModal(){this.open=true;this.opens++;},close(reason){this.open=false;this.reason=reason;}};
 const nodes={'page-task-toolbar':toolbar,'page-add-task':button,'task-dialog':dialog,'task-related':related,'task-name':title};
 const context={soroCurrentAccess:{user_id:'sample-user',role,active:true},soroTaskCenter:{canCreate:r=>['admin','talent_management','sales','sales_management','billing'].includes(r)},viewAllowedForAuthenticatedRole:view=>views[context.soroCurrentAccess?.role]?.has(view),adminPreviewingNonAdminWorkspace:()=>false,location:{hash:'#overview'},currentTalentProfileApplicant:()=>({full_name:'Sample Talent'}),document:{getElementById:id=>nodes[id],body:{classList:{toggle(name,enabled){if(enabled)classes.add(name);else classes.delete(name);}}}},addEventListener(type,fn){listeners[type]=fn;}};
 vm.runInNewContext(source,context);
 return {context,api:context.soroPageTaskAction,toolbar,button,related,title,dialog,classes,listeners};
}
test('every actual role with Tasks gets the same shared action regardless of its sidebar page',()=>{
 for(const [role,allowed]of Object.entries(views)){
  const h=setup(role);
  assert.equal(h.api.canCreate(),(allowed.has('tasks')&&role!=='virtual_assistant'),role);
  for(const page of allowed){h.context.location.hash='#'+page;assert.equal(h.api.sync(),(allowed.has('tasks')&&role!=='virtual_assistant'),`${role}/${page}`);}
 }
});
test('signed out, inactive, password-change and Admin-preview sessions do not gain task access',()=>{
 for(const change of [h=>h.context.soroCurrentAccess=null,h=>h.context.soroCurrentAccess.active=false,h=>h.context.soroCurrentAccess.must_change_password=true,h=>h.context.adminPreviewingNonAdminWorkspace=()=>true,h=>h.context.viewAllowedForAuthenticatedRole=()=>false]){
  const h=setup();change(h);assert.equal(h.api.sync(),false);assert.equal(h.toolbar.hidden,true);assert.equal(h.api.open(),false);assert.equal(h.dialog.opens,0);
 }
});
test('one click opens the existing form and focuses the task name without creating anything',()=>{
 const h=setup();h.button.click();assert.equal(h.dialog.opens,1);assert.equal(h.title.focused,true);assert.equal(h.api.open(),false);assert.equal(h.dialog.opens,1);assert.equal(h.related.value,'');
});
test('Talent profile context is retained without overwriting a draft',()=>{
 const h=setup();h.context.location.hash='#talent/sample';h.api.open();assert.equal(h.related.value,'Sample Talent');h.dialog.open=false;h.related.value='Existing draft context';h.api.open();assert.equal(h.related.value,'Existing draft context');
});
test('access loss closes the task dialog and removes the duplicate-hiding class',()=>{
 const h=setup();h.api.open();assert.equal(h.classes.has('has-page-task-action'),true);h.context.soroCurrentAccess.role='virtual_assistant';h.listeners['soro-auth-changed']();assert.equal(h.dialog.open,false);assert.equal(h.dialog.reason,'cancel');assert.equal(h.classes.size,0);
});
test('switching between authorized accounts closes a draft but a same-account refresh preserves it',()=>{
 const h=setup();h.api.open();h.api.sync();assert.equal(h.dialog.open,true);
 h.context.soroCurrentAccess.user_id='different-user';h.api.sync();assert.equal(h.dialog.open,false);
 h.api.open();h.context.soroCurrentAccess.organization_id='different-organization';h.api.sync();assert.equal(h.dialog.open,false);
});
test('shared action is outside replaceable view content and initialized before authentication',()=>{
 const html=fs.readFileSync(require.resolve('../operations/index.html'),'utf8');
 assert.match(html,/id="page-task-toolbar" hidden>[\s\S]*?id="page-add-task"[\s\S]*?aria-controls="task-dialog">\+ Add Task<\/button><\/div>\s*<div id="view-root">/);
 assert.ok(html.indexOf('page-task-action.js')>html.indexOf('operations.js'));
 assert.ok(html.indexOf('page-task-action.js')<html.indexOf('auth.js'));
 assert.match(operations,/function syncAuthorizedNavigation\([^)]*\)\{\s*const accessRole=effectiveWorkspaceRole\(access\);\s*window\.soroPageTaskAction\?\.sync\(\)/);
 const css=fs.readFileSync(require.resolve('../operations/page-task-action.css'),'utf8');
 assert.match(css,/has-page-task-action #view-root #add-task/);assert.match(css,/#profile-add-task \{ display:none!important/);
 assert.doesNotMatch(source,/fetch\(|\.update\(|\.insert\(|MutationObserver|localStorage/);
 const tasks=fs.readFileSync(require.resolve('../operations/task-center.js'),'utf8');
 assert.match(tasks,/async function createTask\(form\) \{\s*if \(root.soroPageTaskAction && !root.soroPageTaskAction.canCreate\(\)\)/);
});
function createRequestHarness(){
 let releaseToken,releaseResponse,calls=0;
 const session=new Promise(resolve=>releaseToken=()=>resolve({data:{session:{access_token:'sample-token',user:{id:'first-user'}}}}));
 const response=new Promise(resolve=>releaseResponse=()=>resolve({ok:true,json:async()=>({tasks:[],notifications:[],assignees:[],summary:{}})}));
 const context={soroCurrentAccess:{user_id:'first-user',organization_id:'first-org',role:'admin'},soroSupabase:{auth:{getSession:()=>session}},soroPageTaskAction:{canCreate:()=>true},crypto:{randomUUID:()=> 'sample-idempotency'},FormData:class{getAll(){return [];}entries(){return [['title','Local test'],['priority','normal']];}},fetch:async()=>{calls++;return response;}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../operations/task-detail.js'),'utf8'),context);
 vm.runInNewContext(fs.readFileSync(require.resolve('../operations/task-center.js'),'utf8'),context);
 return {context,api:context.soroTaskCenter,releaseToken,releaseResponse,calls:()=>calls};
}
test('account switching while acquiring a token cannot submit the old draft under the new account',async()=>{
 const h=createRequestHarness(),pending=h.api.createTask({dataset:{}});
 h.context.soroCurrentAccess.user_id='next-user';h.releaseToken();
 await assert.rejects(pending,/workspace changed/);assert.equal(h.calls(),0);
});
test('late save responses from another account cannot refresh or complete the new workspace',async()=>{
 const h=createRequestHarness(),pending=h.api.createTask({dataset:{}});h.releaseToken();
 await new Promise(resolve=>setImmediate(resolve));assert.equal(h.calls(),1);
 h.context.soroCurrentAccess.organization_id='next-org';h.releaseResponse();
 await assert.rejects(pending,/workspace changed/);assert.equal(h.calls(),1);
});
test('an earlier save cannot erase the idempotency key of a newly opened task',async()=>{
 const h=createRequestHarness(),form={dataset:{}},pending=h.api.createTask(form);h.releaseToken();
 await new Promise(resolve=>setImmediate(resolve));form.dataset.taskIdempotencyKey='newer-task-key';
 h.releaseResponse();await pending;assert.equal(form.dataset.taskIdempotencyKey,'newer-task-key');
});
