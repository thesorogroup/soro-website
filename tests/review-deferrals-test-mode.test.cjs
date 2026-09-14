'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function sandbox(){const c={parent:{postMessage(){}},document:{addEventListener(){}},history:{replaceState(){}},addEventListener(){},URL,Blob,Response,crypto:require('node:crypto').webcrypto};c.window=c;vm.createContext(c);vm.runInContext(fs.readFileSync('operations/test-mode/runtime.js','utf8'),c);c.SoroTestSession.select('talent');return c;}
async function call(c,path,body,status=200){const r=await c.fetch('/.netlify/functions/'+path,body?{method:'POST',body:JSON.stringify(body)}:{});assert.equal(r.status,status);return r.json();}
test('sample deferrals stay pending, create one private task, and do not automatically mark Bench Ready',async()=>{
 const c=sandbox(),s=c.SoroTestSession,id=s.id,applicantId=id(11);
 await call(c,'talent-review-queue',{action:'begin_review'});
 let requirements=await call(c,'talent-review-deferrals?applicantId='+applicantId);
 assert.equal(requirements.items.length,11);
 const body={requestId:id(200),applicantId,expectedUpdatedAt:requirements.updatedAt,itemKey:'resume',action:'defer',reason:'Awaiting an updated résumé.',dueDate:'2026-10-01',createTask:true};
 await call(c,'talent-review-deferrals',body);await call(c,'talent-review-deferrals',body);
 requirements=await call(c,'talent-review-deferrals?applicantId='+applicantId);
 const item=requirements.items.find(i=>i.key==='resume');assert.equal(item.status,'deferred');assert.ok(item.deferral.taskId);
 assert.equal(s.store.tasks.filter(t=>t.id===item.deferral.taskId).length,1);assert.equal(s.store.stage,'in_review');
 const q=await call(c,'talent-review-queue');assert.equal(q.applicants[0].checklist.find(i=>i.key==='resume').state,'missing');
 await call(c,'talent-review-queue',{action:'mark_bench_ready',applicantId,expectedUpdatedAt:requirements.updatedAt},409);
 await call(c,'task-detail',{action:'save',taskId:item.deferral.taskId,patch:{progress:'completed'}});
 assert.equal((await call(c,'talent-review-deferrals?applicantId='+applicantId)).items.find(i=>i.key==='resume').status,'deferred');
 for(const key of ['interview','references']){requirements=await call(c,'talent-review-deferrals?applicantId='+applicantId);await call(c,'talent-review-deferrals',{...body,requestId:c.crypto.randomUUID(),expectedUpdatedAt:requirements.updatedAt,itemKey:key,dueDate:null,createTask:false});}
 requirements=await call(c,'talent-review-deferrals?applicantId='+applicantId);
 await call(c,'talent-review-queue',{action:'mark_bench_ready',applicantId,expectedUpdatedAt:requirements.updatedAt});assert.equal(s.store.stage,'bench_ready');
 const gate=(await call(c,'talent-verification?applicantId='+applicantId)).gate;assert.equal(gate.benchReadyEligible,true);assert.equal(gate.interviewAddressed,false);assert.equal(gate.referencesAddressed,false);
 requirements=await call(c,'talent-review-deferrals?applicantId='+applicantId);
 await call(c,'talent-review-deferrals',{...body,requestId:c.crypto.randomUUID(),expectedUpdatedAt:requirements.updatedAt,action:'restore',reason:'Require résumé before matching.',dueDate:null,createTask:false});assert.equal(s.store.stage,'in_review');
 for(const role of ['client','sales','va']){s.select(role);await call(c,'talent-review-deferrals?applicantId='+applicantId,null,403);await call(c,'talent-review-deferrals',body,403);}
 s.reset();assert.equal(Object.keys(s.store.reviewDeferrals).length,0);assert.equal(s.store.tasks.some(t=>t.id===item.deferral.taskId),false);
});
test('sample legacy skills accept genuine verification, not invented self-reported answers',async()=>{
 const c=sandbox(),s=c.SoroTestSession,a=s.store.applicants[1];a.self_reported_skills=[];a.self_reported_experience_areas=[];
 assert.equal(s.queue().applicants[0].checklist.find(i=>i.key==='skills').state,'missing');
 a.verified_skills=['Calendar management'];assert.equal(s.queue().applicants[0].checklist.find(i=>i.key==='skills').state,'complete');assert.equal(a.self_reported_skills.length,0);
});

async function createDeferredTask(c,itemKey='resume'){
 const s=c.SoroTestSession,applicantId=s.id(11);
 await call(c,'talent-review-queue',{action:'begin_review'});
 const requirements=await call(c,'talent-review-deferrals?applicantId='+applicantId);
 await call(c,'talent-review-deferrals',{requestId:c.crypto.randomUUID(),applicantId,expectedUpdatedAt:requirements.updatedAt,itemKey,action:'defer',reason:'Private review follow-up reason.',dueDate:'2026-10-01',createTask:true});
 const item=(await call(c,'talent-review-deferrals?applicantId='+applicantId)).items.find(i=>i.key===itemKey);
 return{applicantId,task:s.store.tasks.find(t=>t.id===item.deferral.taskId)};
}

test('sample follow-up task copy and history match migration 077 and explain completion boundaries',async()=>{
 const c=sandbox(),{task}=await createDeferredTask(c);
 assert.equal(task.title,'Complete deferred review: Resume');
 assert.equal(task.details,'Open Talent Review for Santos, Riley and complete Resume. Reason for deferral: Private review follow-up reason.\nCompleting this reminder does not verify the requirement.');
 assert.equal(task.relatedLabel,'Santos, Riley');
 assert.equal(task.history[0].summary,'Follow-up task created for a deferred Talent review requirement.');
 assert.equal(task.history[0].note,'');
 const workspace=await call(c,'tasks');
 assert.equal(workspace.notifications.filter(n=>n.taskId===task.id).length,1);
 assert.equal(workspace.summary.urgentUnread,1);
 await call(c,'task-detail',{action:'view',taskId:task.id});
 assert.ok((await call(c,'tasks')).notifications.find(n=>n.taskId===task.id).readAt);
 assert.equal((await call(c,'tasks')).summary.urgentUnread,0);
});

test('sample deferrals reject impossible calendar dates without creating tasks',async()=>{
 const c=sandbox(),s=c.SoroTestSession,applicantId=s.id(11);
 await call(c,'talent-review-queue',{action:'begin_review'});
 const requirements=await call(c,'talent-review-deferrals?applicantId='+applicantId),initialCount=s.store.tasks.length;
 for(const dueDate of ['2026-02-29','2026-02-30','2026-04-31','2026-13-01','2026-00-01','2026-01-00','2026-2-01','not-a-date',null]){
  await call(c,'talent-review-deferrals',{requestId:c.crypto.randomUUID(),applicantId,expectedUpdatedAt:requirements.updatedAt,itemKey:'resume',action:'defer',reason:'Check the calendar date.',dueDate,createTask:true},409);
  assert.equal(s.store.tasks.length,initialCount);
  assert.equal(Object.keys(s.store.reviewDeferrals).length,0);
 }
 await call(c,'talent-review-deferrals',{requestId:c.crypto.randomUUID(),applicantId,expectedUpdatedAt:requirements.updatedAt,itemKey:'resume',action:'defer',reason:'Valid leap day.',dueDate:'2028-02-29',createTask:true});
 assert.equal(s.store.tasks.length,initialCount+1);
});

for(const closure of ['active','restored','requirement_met'])test(`sample deferred-review tasks remain private when ${closure}, even with old recipient or ownership links`,async()=>{
 const c=sandbox(),s=c.SoroTestSession;
 if(closure==='requirement_met'){s.store.applicants[1].self_reported_skills=[];s.store.applicants[1].self_reported_experience_areas=[];}
 const {task,applicantId}=await createDeferredTask(c,closure==='requirement_met'?'skills':'resume');
 if(closure==='restored'){
  const requirements=await call(c,'talent-review-deferrals?applicantId='+applicantId);
  await call(c,'talent-review-deferrals',{requestId:c.crypto.randomUUID(),applicantId,expectedUpdatedAt:requirements.updatedAt,itemKey:'resume',action:'restore',reason:'Require this before matching.',dueDate:null,createTask:false});
 }
 if(closure==='requirement_met'){s.store.applicants[1].verified_skills=['Calendar management'];await call(c,'talent-review-deferrals?applicantId='+applicantId);}
 assert.equal(Boolean(s.store.reviewDeferrals[closure==='requirement_met'?'skills':'resume']),closure==='active');
 assert.equal(s.store.reviewDeferralTaskIds[task.id],true);
 for(const role of ['sales','client','va']){
  const person=s.personas[role];
  // Model historical assignments/notifications that could outlive a role change.
  task.assignees.push({id:person.id,userId:person.id,name:person.name});
  s.store.taskNotifications.push({id:c.crypto.randomUUID(),taskId:task.id,recipientUserId:person.id,title:task.title,message:task.details,readAt:null});
  s.select(role);
  for(const path of ['tasks','tasks?notifications=true']){
   const workspace=await call(c,path);
   assert.equal(workspace.tasks.some(t=>t.id===task.id),false);
   assert.equal(workspace.notifications.some(n=>n.taskId===task.id),false);
   assert.doesNotMatch(JSON.stringify(workspace),/Private review follow-up reason|Complete deferred review/);
  }
  const workspace=await call(c,'task-detail',{action:'workspace'});
  assert.equal(workspace.tasks.some(t=>t.id===task.id),false);
  for(const action of ['get','view','save'])await call(c,'task-detail',{action,taskId:task.id,patch:{progress:'completed'}},404);
 }
 s.select('talent');
 assert.equal((await call(c,'task-detail',{action:'get',taskId:task.id})).task.id,task.id);
 // Ownership alone cannot restore access after the creator changes roles.
 s.personas.talent.role='sales';
 assert.equal((await call(c,'tasks')).tasks.some(t=>t.id===task.id),false);
 await call(c,'task-detail',{action:'get',taskId:task.id},404);
 s.personas.talent.role='admin';
 assert.equal((await call(c,'task-detail',{action:'get',taskId:task.id})).task.id,task.id);
});

test('sample deferred-review task assignments reject Sales, Client and Talent before any edit, including after restoration',async()=>{
 const c=sandbox(),s=c.SoroTestSession,{task,applicantId}=await createDeferredTask(c);
 for(const restored of [false,true]){
  if(restored){const requirements=await call(c,'talent-review-deferrals?applicantId='+applicantId);await call(c,'talent-review-deferrals',{requestId:c.crypto.randomUUID(),applicantId,expectedUpdatedAt:requirements.updatedAt,itemKey:'resume',action:'restore',reason:'Restore the requirement.',dueDate:null,createTask:false});}
  const detail=await call(c,'task-detail',{action:'get',taskId:task.id});
  assert.deepEqual(detail.assignees.map(p=>p.role),['talent_management']);
  assert.equal(detail.task.canAssign,true);
  for(const assigneeIds of [[s.id(3)],[s.id(1)],[s.id(4)],[s.id(2),s.id(3)],[],null,'invalid']){
   await call(c,'task-detail',{action:'save',taskId:task.id,patch:{assigneeIds,title:'Must not apply'}},403);
   assert.equal(task.title,'Complete deferred review: Resume');
   assert.deepEqual(Array.from(task.assignees,p=>p.id),[s.id(2)]);
  }
 }
 await call(c,'task-detail',{action:'save',taskId:task.id,patch:{assigneeIds:[s.id(2)],progress:'completed'}});
 assert.equal(task.status,'completed');
 assert.equal(s.store.reviewDeferralTaskIds[task.id],true);
});
