'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const read=name=>fs.readFileSync(path.join(__dirname,'../operations',name),'utf8');
const operations=read('operations.js');
const loaderSource=operations.slice(operations.indexOf('function applicantRenderFingerprint('),operations.indexOf('async function loadOwnTalentProfile('));
const selected={id:'a',full_name:'Selected Talent',organization_id:'org',status:'submitted',legacy_application_data:{skills:['Skill A'],details:{a:1,b:2}},updated_at:'earlier'};
function harness({wrapper=true,view='talent-profile'}={}){
 const calls=[],pending=[],window={soroCurrentAccess:{user_id:'user',organization_id:'org',role:'admin',active:true,must_change_password:false}};
 let rows=[structuredClone(selected),{id:'b',full_name:'Another Talent'}],renders=0,allowed=true;
 const context={window,liveApplicants:structuredClone(rows),liveApplicantsRequest:0,liveApplicantsScope:JSON.stringify(['user','org','admin',true,false]),selectedTalentId:'a',current:view,talentProfileSelectFields:'explicit-profile-fields',
  actualAuthenticatedRole:(access=window.soroCurrentAccess)=>String(access?.role||'').toLowerCase(),viewAllowedForAuthenticatedRole:()=>allowed,
  profilePage:()=>'',classifyDocument:doc=>doc.document_type,documentLabels:{},escapeHtml:value=>String(value),
  render:()=>{renders++;},document:{querySelectorAll:()=>[],addEventListener(){}},
 };
 const client={from(table){const call={table};calls.push(call);return {select(fields){call.fields=fields;return this;},eq(key,value){call.eq=[key,value];return this;},is(key,value){call.is=[key,value];return this;},order(key,value){call.order=[key,value];return pending.length?pending.shift():Promise.resolve({data:structuredClone(rows),error:null});}};}};
 window.soroSupabase=client;vm.createContext(context);vm.runInContext(loaderSource,context);
 if(wrapper)vm.runInContext(read('talent-profile-privacy.js'),context);
 return {context,window,calls,load:()=>context.loadLiveApplicants(),rows:value=>{rows=value;},queue:value=>pending.push(Promise.resolve(value)),defer:()=>{let resolve;pending.push(new Promise(r=>resolve=r));return resolve;},deny:()=>{allowed=false;},get renders(){return renders;}};
}

for(const wrapper of [false,true])test((wrapper?'final privacy wrapper':'base loader')+' refreshes data without replacing an unchanged selected profile',async()=>{
 const h=harness({wrapper});await h.load();assert.equal(h.renders,0);assert.equal(h.context.liveApplicants[0].full_name,'Selected Talent');
 assert.equal(h.calls[0].fields,wrapper?'*':'explicit-profile-fields');assert.deepEqual(h.calls[0].eq,['organization_id','org']);assert.deepEqual(h.calls[0].is,['archived_at',null]);
 h.rows([{updated_at:'new bookkeeping timestamp',legacy_application_data:{details:{b:2,a:1},skills:['Skill A']},status:'submitted',organization_id:'org',full_name:'Selected Talent',id:'a'},{id:'b',full_name:'Another Talent changed'}]);
 await h.load();assert.equal(h.renders,0,'Other records, key order, and updated_at alone must not reset the player');assert.equal(h.context.liveApplicants[1].full_name,'Another Talent changed');assert.equal(h.context.liveApplicants[0].updated_at,'new bookkeeping timestamp');
});

for(const delta of [{full_name:'Changed name'},{status:'bench'},{legacy_application_data:{skills:['Changed skill']}},{loom_video_url:'https://www.loom.com/share/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}])test('selected profile change '+Object.keys(delta)[0]+' updates the visible profile',async()=>{
 const h=harness();h.rows([{...selected,...delta}]);await h.load();assert.equal(h.renders,1);assert.deepEqual(h.context.liveApplicants[0][Object.keys(delta)[0]],delta[Object.keys(delta)[0]]);
});

test('removal or archival from the active query clears the selected profile instead of retaining its old player',async()=>{
 const h=harness();h.rows([{id:'b',full_name:'Other Talent'}]);await h.load();assert.equal(h.renders,1);assert.equal(h.context.liveApplicants.some(x=>x.id==='a'),false);
});

test('directory polling still refreshes rows and does not change review-queue notification dispatch',async()=>{
 const h=harness({view:'vas'});await h.load();await h.load();assert.equal(h.renders,2);
 assert.match(operations,/soro:talent-review-queue-updated',[\s\S]*?loadLiveApplicants\(\)/);
 assert.match(read('talent-review-queue.js'),/soro:talent-review-queue-updated/);
});

for(const change of ['user','organization','role','inactive','password-gate','permission','client'])test('late response after '+change+' change cannot replace current cached data',async()=>{
 const h=harness(),old=h.context.liveApplicants,release=h.defer(),request=h.load();
 if(change==='user')h.window.soroCurrentAccess={...h.window.soroCurrentAccess,user_id:'other'};
 if(change==='organization')h.window.soroCurrentAccess={...h.window.soroCurrentAccess,organization_id:'other'};
 if(change==='role')h.window.soroCurrentAccess={...h.window.soroCurrentAccess,role:'sales'};
 if(change==='inactive')h.window.soroCurrentAccess={...h.window.soroCurrentAccess,active:false};
 if(change==='password-gate')h.window.soroCurrentAccess={...h.window.soroCurrentAccess,must_change_password:true};
 if(change==='permission')h.deny();
 if(change==='client')h.window.soroSupabase={};
 release({data:[{id:'a',full_name:'Must not be applied'}],error:null});await request;
 assert.equal(h.context.liveApplicants,old);assert.equal(h.renders,0);
});

test('an older response cannot overwrite a newer refresh for the same account',async()=>{
 const h=harness(),release=h.defer(),first=h.load();h.rows([{...selected,full_name:'Newest data'}]);await h.load();release({data:[{...selected,full_name:'Stale data'}],error:null});await first;
 assert.equal(h.context.liveApplicants[0].full_name,'Newest data');assert.equal(h.renders,1);
});

test('schema fallback goes through the same selected-record and scope guards',async()=>{
 const h=harness();h.queue({data:null,error:{message:'Schema unavailable'}});await h.load();assert.deepEqual(h.calls.map(x=>x.fields),['*','explicit-profile-fields']);assert.equal(h.renders,0);
});

test('authorization loss prevents starting a new read and invalidates an earlier request',async()=>{
 const h=harness(),release=h.defer(),first=h.load();h.window.soroCurrentAccess=null;await h.load();release({data:[selected],error:null});await first;
 assert.equal(h.context.liveApplicants.length,0);assert.equal(h.calls.length,1);assert.equal(h.renders,1);
  assert.match(operations,/soro-auth-changed',event=>\{\s*liveApplicantsRequest\+=1/);
 assert.match(operations,/soro-auth-changed',event=>\{\s*liveApplicantsRequest\+=1;\s*liveApplicants=\[\];liveApplicantsScope=''/);
});

test('a new account scope clears prior cached profiles before waiting for its response',async()=>{
 const h=harness();h.window.soroCurrentAccess={...h.window.soroCurrentAccess,organization_id:'new-org'};
 const release=h.defer(),loading=h.load();assert.equal(h.context.liveApplicants.length,0);assert.equal(h.renders,1);
 release({data:[{...selected,organization_id:'new-org'}],error:null});await loading;
 assert.equal(h.renders,2);assert.equal(h.context.liveApplicants[0].organization_id,'new-org');
});
