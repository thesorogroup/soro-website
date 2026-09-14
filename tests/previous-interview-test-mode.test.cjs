'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function sandbox(){const c={parent:{postMessage(){}},document:{addEventListener(){}},history:{replaceState(){}},addEventListener(){},URL,Blob,Response,crypto:require('node:crypto').webcrypto};c.window=c;vm.createContext(c);vm.runInContext(fs.readFileSync('operations/test-mode/runtime.js','utf8'),c);c.SoroTestSession.select('talent');c.SoroTestSession.store.stage='in_review';return c;}
async function call(c,body,status=200){const response=await c.fetch('/.netlify/functions/talent-verification'+(body?'':'?applicantId='+c.SoroTestSession.id(11)),body?{method:'POST',body:JSON.stringify(body)}:{});assert.equal(response.status,status);return response.json();}
function request(c,changes={}){return{action:'record_previous_interview',requestId:c.crypto.randomUUID(),applicantId:c.SoroTestSession.id(11),expectedUpdatedAt:null,interviewId:null,occurredOn:'2026-01-10',interviewerName:'Taylor Morgan',outcome:'recommended',communicationScore:4,preparednessScore:4,roleFitScore:5,overallScore:4,note:'Interview completed before the portal launch. Clear communication and relevant experience.',...changes};}

test('previous interview completes the same review gate with no invitation or duplicate task',async()=>{
 const c=sandbox(),s=c.SoroTestSession,taskCount=s.store.tasks.length;
 const body=request(c),saved=await call(c,body);await call(c,body);
 assert.equal(saved.interview.recordSource,'historical');assert.equal(saved.interview.status,'completed');assert.equal(saved.interview.occurredOn,'2026-01-10');
 assert.equal(saved.interview.startsAt,null);assert.equal(saved.interview.endsAt,null);assert.equal(saved.interview.timezone,null);assert.equal(saved.interview.calendar.status,'not_applicable');
 assert.equal(saved.gate.interviewAddressed,true);assert.equal(saved.gate.referencesAddressed,false);assert.equal(saved.gate.benchReadyEligible,false);
 assert.equal(s.store.tasks.length,taskCount);assert.equal(s.store.taskNotifications.length,0);assert.equal(s.store.interviewAudit.length,1);assert.equal(s.store.stage,'in_review');
 const requirements=await(await c.fetch('/.netlify/functions/talent-review-deferrals?applicantId='+s.id(11))).json();assert.equal(requirements.items.find(i=>i.key==='interview').status,'complete');
 assert.doesNotMatch(JSON.stringify(saved),/microsoft_event_id|calendarCommand|interviewer_email/);
});

test('unknown historical date is honest and corrections are versioned without changing applicant answers',async()=>{
 const c=sandbox(),s=c.SoroTestSession,applicantName=s.store.applicants[1].full_name;
 let saved=await call(c,request(c,{occurredOn:null,communicationScore:null}));assert.equal(saved.interview.occurredOn,null);assert.equal(saved.interview.scorecard.communication,null);
 const edit=request(c,{interviewId:saved.interview.interviewId,expectedUpdatedAt:saved.interview.updatedAt,communicationScore:5,occurredOn:null});
 saved=await call(c,edit);assert.equal(saved.interview.scorecard.communication,5);assert.equal(saved.interview.interviewer.name,'Taylor Morgan');assert.equal(s.store.interviewAudit.length,2);
 await call(c,{...edit,requestId:c.crypto.randomUUID()},409);assert.equal(s.store.interviewAudit.length,2);assert.equal(s.store.applicants[1].full_name,applicantName);
});

test('invalid details and attempts to overwrite scheduled or regular completed interviews are rejected',async()=>{
 const c=sandbox(),s=c.SoroTestSession;
 for(const patch of [{occurredOn:'2026-02-30'},{occurredOn:'2099-01-01'},{interviewerName:''},{note:''},{outcome:''},{communicationScore:0},{overallScore:5.5},{interviewerUserId:s.id(2)},{applicantId:s.id(10)}])await call(c,request(c,patch),patch.applicantId?403:409);
 assert.equal(s.store.interview,null);
 for(const status of ['scheduled','completed']){
  s.store.interview={interviewId:s.id(800),updatedAt:'2026-01-01T00:00:00Z',recordSource:'scheduled',status,calendar:{status:'synced'}};
  await call(c,request(c,{interviewId:s.id(800),expectedUpdatedAt:s.store.interview.updatedAt}),409);assert.equal(s.store.interview.status,status);
 }
 assert.equal(s.store.interviewAudit.length,0);
});

test('a fully cancelled appointment is retained in history before manual previous-interview entry',async()=>{
 const c=sandbox(),s=c.SoroTestSession;
 s.store.interview={interviewId:s.id(801),roundNumber:1,updatedAt:'2026-01-01T00:00:00Z',recordSource:'scheduled',status:'cancelled',calendar:{status:'pending'}};
 const body=request(c,{interviewId:s.id(801),expectedUpdatedAt:s.store.interview.updatedAt});await call(c,body,409);
 s.store.interview.calendar.status='not_applicable';const saved=await call(c,body);
 assert.equal(saved.interview.roundNumber,2);assert.equal(saved.interviewHistory.length,1);assert.equal(saved.interviewHistory[0].status,'cancelled');
});

test('manual interview data stays private to management roles and resets with sample state',async()=>{
 const c=sandbox(),s=c.SoroTestSession,body=request(c);await call(c,body);
 for(const role of ['sales','client','va']){s.select(role);await call(c,null,403);await call(c,{...body,requestId:c.crypto.randomUUID()},403);}
 s.select('talent');s.reset();assert.equal((await call(c)).interview,null);assert.equal(s.store.interviewAudit.length,0);assert.equal(s.store.interviewHistory.length,0);
});

test('recording a real past interview replaces a deferral without completing other review requirements',async()=>{
 const c=sandbox(),s=c.SoroTestSession;s.store.reviewDeferrals.interview={id:s.id(900),reason:'Awaiting historical notes',createdAt:'2026-01-01T00:00:00Z',createdByName:'Taylor Morgan',dueDate:null,taskId:null};
 const saved=await call(c,request(c));assert.equal(saved.gate.interviewAddressed,true);assert.equal(saved.gate.deferrals.interview,null);assert.ok(saved.gate.blockers.includes('Employment references must be addressed'));
 assert.equal(saved.applicant.checklist.find(i=>i.key==='resume').state,'missing');assert.equal(saved.applicant.checklist.find(i=>i.key==='skills').verifiedSkillsCount,0);
});

test('recording a previous interview clears its deferral without changing a separately managed reminder',async()=>{
 const c=sandbox(),s=c.SoroTestSession;
 const response=await c.fetch('/.netlify/functions/talent-review-deferrals',{method:'POST',body:JSON.stringify({action:'defer',requestId:c.crypto.randomUUID(),applicantId:s.id(11),expectedUpdatedAt:s.store.applicants[1].updated_at,itemKey:'interview',reason:'Retrieve previous interview notes',createTask:true,dueDate:'2026-09-20'})});
 assert.equal(response.status,200);
 const taskId=s.store.reviewDeferrals.interview.taskId,taskCount=s.store.tasks.length;
 const body=request(c,{outcome:'follow_up'}),saved=await call(c,body);await call(c,body);
 assert.equal(saved.gate.interviewAddressed,true);assert.equal(s.store.tasks.length,taskCount);
 const task=s.store.tasks.find(t=>t.id===taskId);assert.equal(task.status,'open');assert.equal(task.progress,'not_started');assert.equal(task.history.length,1);
 assert.equal(saved.gate.deferrals.interview,null);
 assert.equal(s.store.reviewDeferralTaskIds[taskId],true);
});
