const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const applicantId='33333333-3333-4333-8333-333333333333',staff='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',interviewId='99999999-9999-4999-8999-999999999999',updatedAt='2026-09-10T12:00:00.000Z';
function payload(interview=null){return {generatedAt:updatedAt,viewerRole:'talent_management',applicant:{applicantId,fullName:'Sample Legacy Applicant',stage:'in_review',updatedAt},gate:{interviewAddressed:!!interview,referencesAddressed:false,benchReadyEligible:false,blockers:['References pending']},interview,interviewHistory:[],interviewers:[],availableAttendees:[],calendarIntegration:{configured:false,organizerLabel:''},references:[]};}
function setup(){
 const calls=[],progress=[];
 const context=vm.createContext({console,Response,URL,URLSearchParams,AbortController,Date,Intl,Promise,FormData,setTimeout,clearTimeout,setInterval:()=>{},crypto:{randomUUID:()=>interviewId},addEventListener(){}});
 context.window=context;context.soroCurrentAccess={role:'talent_management',user_id:staff};
 context.soroSupabase={auth:{getSession:async()=>({data:{session:{access_token:'sample-only'}}})}};
 context.SoroActionProgress={begin:label=>{const token={label,done:false};progress.push(token);return()=>{token.done=true;};}};
 const host={innerHTML:'',querySelector:()=>null,querySelectorAll:()=>[],removeEventListener(){}};
 const original=fs.readFileSync('operations/talent-review-queue.js','utf8');
 const source=original.replace('    ENDPOINT,\n    AUTO_REFRESH_MS,','    __stateTest: {postVerificationAction, closeVerification, render, markup:verificationDialogMarkup, pending:()=>!!pendingVerificationAction, set:(data,host,statusType="")=>{verificationContext={applicantId:data.applicant.applicantId,mode:"interview",phase:"ready",data,statusType};mountedRoot=host;}},\n    ENDPOINT,\n    AUTO_REFRESH_MS,');
 assert.notEqual(source,original);vm.runInContext(source,context);
 const api=context.soroTalentReviewQueue,internal=api.__stateTest;
 internal.set(payload(),host);
 const values={interviewId:null,expectedUpdatedAt:null,occurredOn:null,interviewerName:'Past interviewer',outcome:'recommended',communicationScore:4,note:'Original interview summary.'};
 const recorded={interviewId,recordSource:'historical',occurredOn:null,status:'completed',startsAt:null,endsAt:null,timezone:null,updatedAt,roundNumber:1,interviewer:{id:null,name:'Past interviewer'},outcome:'recommended',scorecard:{communication:4,preparedness:null,roleFit:null,overall:null},notes:values.note,additionalAttendees:[],calendar:{status:'not_applicable',joinUrl:null}};
 context.fetch=async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(payload(recorded)),{status:200});};
 return {context,api,internal,values,host,calls,progress,recorded};
}
test('manual interview save locks before session lookup and performs only one mutation',async()=>{
 const s=setup();let release;s.context.soroSupabase.auth.getSession=()=>new Promise(resolve=>{release=resolve;});
 const pending=s.internal.postVerificationAction('record_previous_interview',s.values);
 assert.equal(s.internal.pending(),true);assert.equal(s.progress[0].label,'Saving previous interview…');
 assert.equal(s.internal.closeVerification(),false);assert.equal(await s.internal.postVerificationAction('record_previous_interview',s.values),null);
 release({data:{session:{access_token:'sample-only'}}});await pending;
 assert.equal(s.calls.length,1);assert.equal(s.internal.pending(),false);assert.equal(s.progress[0].done,true);
 const body=JSON.parse(s.calls[0].options.body);assert.equal(body.action,'record_previous_interview');assert.equal(body.interviewId,null);
 assert.match(s.internal.markup(),/Previous Interview Completed/);assert.match(s.internal.markup(),/Previous interview saved/);
 assert.doesNotMatch(JSON.stringify(body),/schedule_interview|send_email|create_task/);
});
test('scheduled interview and stale history cannot be overwritten by a manual call',async()=>{
 const s=setup();s.internal.set(payload({...s.recorded,recordSource:'scheduled',status:'scheduled'}),s.host);
 await assert.rejects(s.internal.postVerificationAction('record_previous_interview',{...s.values,interviewId,expectedUpdatedAt:updatedAt}),/cannot be replaced/);
 assert.equal(s.calls.length,0);s.internal.set(payload(s.recorded),s.host);
 await assert.rejects(s.internal.postVerificationAction('record_previous_interview',s.values),/record changed/);
 assert.equal(s.calls.length,0);
});
test('failed manual saves release progress and allow retry without any success message',async()=>{
 const s=setup();s.context.fetch=async()=>{throw Error('offline');};
 await assert.rejects(s.internal.postVerificationAction('record_previous_interview',s.values),/could not reach/);
 assert.equal(s.internal.pending(),false);assert.equal(s.progress[0].done,true);assert.doesNotMatch(s.host.innerHTML,/Previous interview saved/);
 await assert.rejects(s.internal.postVerificationAction('record_previous_interview',s.values));assert.equal(s.progress.length,2);
});
test('manual interview draft, expanded section and scroll survive a validation or save error',()=>{
 const s=setup();let replaced=false,repainted=false;const draft={marker:'unsaved interviewer, scores and note'};
 const nextDraft={replaceWith(node){assert.equal(node,draft);replaced=true;}};
 const openChoice={dataset:{interviewChoice:'previous'},open:true},nextChoice={dataset:{interviewChoice:'previous'},open:false};
 const body={scrollTop:173,querySelector(selector){if(selector==='[data-verification-form="record_previous_interview"]')return repainted?nextDraft:draft;return null;},querySelectorAll(selector){return selector.includes('[open]')?[openChoice]:[nextChoice];},set innerHTML(value){repainted=true;}};
 const workspace={scrollTop:61};const dialog={dataset:{verificationOwner:applicantId,verificationMode:'interview'},querySelector(selector){return selector==='.talent-verification-body'?body:selector==='.talent-verification-workspace'?workspace:null;}};
 s.context.document={createElement(){return {set innerHTML(value){},content:{querySelector(){return {innerHTML:'new view'};}}};}};
 const host={querySelector(selector){return selector==='[data-verification-dialog]'?dialog:null;}};
 s.internal.set(payload(),host,'error');s.internal.render();
 assert.equal(replaced,true);assert.equal(nextChoice.open,true);assert.equal(body.scrollTop,173);assert.equal(workspace.scrollTop,61);
});
