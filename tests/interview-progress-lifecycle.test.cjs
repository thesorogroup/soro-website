const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const id='33333333-3333-4333-8333-333333333333',staff='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function payload(){return {generatedAt:'2026-09-10T12:00:00.000Z',viewerRole:'talent_management',applicant:{applicantId:id,fullName:'Santos, Alex',email:'alex@example.com',stage:'in_review',updatedAt:'2026-09-10T12:00:00.000Z'},gate:{interviewAddressed:false,referencesAddressed:false,benchReadyEligible:false,blockers:['Interview must be addressed']},interview:null,interviewers:[{id:staff,name:'Sample interviewer'}],calendarIntegration:{configured:true,organizerLabel:'Sample calendar'},references:[]};}
function setup(){
 const calls=[],progress=[],listeners={};
 const context=vm.createContext({console,Response,URL,URLSearchParams,AbortController,Date,Intl,Promise,FormData,setTimeout,clearTimeout,setInterval:()=>{},crypto:{randomUUID:()=> '99999999-9999-4999-8999-999999999999'},addEventListener:(name,fn)=>{listeners[name]=fn;}});
 context.window=context;
 context.soroCurrentAccess={role:'talent_management',user_id:staff};
 context.soroSupabase={auth:{getSession:async()=>({data:{session:{access_token:'local-sample'}}})}};
 context.SoroActionProgress={begin:label=>{const token={label,done:false};progress.push(token);return ()=>{token.done=true;};}};
 const host={innerHTML:'',querySelector:()=>null,querySelectorAll:()=>[],removeEventListener(){}};
 const original=fs.readFileSync('operations/talent-review-queue.js','utf8');
 const source=original.replace('    ENDPOINT,\n    AUTO_REFRESH_MS,','    __progressTest: {postVerificationAction, closeVerification, loadVerification, pending:()=>!!pendingVerificationAction, set:(data,host)=>{verificationContext={applicantId:data.applicant.applicantId,mode:"interview",data};mountedRoot=host;}},\n    ENDPOINT,\n    AUTO_REFRESH_MS,');
 assert.notEqual(source,original,'test-only private access instrumentation applied');
 vm.runInContext(source,context);
 const api=context.soroTalentReviewQueue,internal=api.__progressTest;
 internal.set(payload(),host);
 context.fetch=async(...args)=>{calls.push(args);return new Response(JSON.stringify(payload()),{status:200});};
 const values={startsAt:'2026-10-01T15:00:00.000Z',durationMinutes:30,timezone:'America/Chicago',interviewerUserId:staff};
 return {context,calls,progress,api,internal,values,host};
}
test('scheduling locks immediately during session lookup and ignores duplicate submits and closes',async()=>{
 const s=setup();let release;s.context.soroSupabase.auth.getSession=()=>new Promise(resolve=>{release=resolve;});
 const request=s.internal.postVerificationAction('schedule_interview',s.values);
 assert.equal(s.internal.pending(),true);assert.equal(s.progress[0].label,'Scheduling interview…');
 assert.equal(s.internal.closeVerification(),false);
 assert.equal(await s.internal.postVerificationAction('schedule_interview',s.values),null);
 assert.equal(await s.internal.loadVerification(id),false);assert.equal(s.calls.length,0);
 release({data:{session:{access_token:'local-sample'}}});await request;
 assert.equal(s.calls.length,1);assert.equal(s.internal.pending(),false);assert.equal(s.progress[0].done,true);
});
test('failed scheduling releases progress and permits an intentional retry',async()=>{
 const s=setup();s.context.fetch=async()=>{throw Error('network');};
 await assert.rejects(s.internal.postVerificationAction('schedule_interview',s.values),/could not reach/);
 assert.equal(s.internal.pending(),false);assert.equal(s.progress[0].done,true);
 await assert.rejects(s.internal.postVerificationAction('schedule_interview',s.values));assert.equal(s.progress.length,2);assert.equal(s.progress[1].done,true);
});
test('unmount releases a waiting operation and prevents a stale write after session lookup',async()=>{
 const s=setup();let release;s.context.soroSupabase.auth.getSession=()=>new Promise(resolve=>{release=resolve;});
 const request=s.internal.postVerificationAction('schedule_interview',s.values);
 s.api.unmount({clear:false});assert.equal(s.internal.pending(),false);assert.equal(s.progress[0].done,true);
 release({data:{session:{access_token:'local-sample'}}});await assert.rejects(request,/review changed/);assert.equal(s.calls.length,0);
});
