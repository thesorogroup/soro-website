const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {content}=require('../netlify/functions/lib/interview-reminder-email');
const {dispatch,handler}=require('../netlify/functions/interview-follow-through');
const ui=require('../operations/talent-review-queue');
const payload={personName:'Garin, Gabriel',applicantName:'Garin, Gabriel',startsAt:'2099-09-05T16:00:00Z',endsAt:'2099-09-05T16:30:00Z',timezone:'America/Chicago',joinUrl:'https://teams.microsoft.com/l/meetup-join/sample',offsetMinutes:1440};
test('reminder uses first name, branded layout, date zones, Teams link, and Talent reply mailbox',()=>{
 const email=content(payload);assert.equal(email.from,'The Soro Group <talents@thesorogroup.com>');assert.equal(email.reply_to,'talents@thesorogroup.com');
 assert.match(email.html,/Hi Gabriel,/);assert.doesNotMatch(email.html,/Hi Garin|Gabriel,,|Soro Ops/);
 assert.match(email.html,/soro-logo-final-transparent/);assert.match(email.html,/Philippine Time/);assert.match(email.html,/America\/Chicago/);
 assert.match(email.html,/mailto:talents@thesorogroup.com/);assert.match(email.html,/Join Microsoft Teams/);
 assert.match(email.text,/2099/);assert.doesNotMatch(email.html,/tomorrow/);
});
test('reminders reject unsafe meeting links, unsupported windows and escape caller content',()=>{
 for(const joinUrl of ['http://teams.microsoft.com/a','https://teams.microsoft.com.evil.test/a','https://evil.test/a','https://u:p@teams.microsoft.com/a'])assert.throws(()=>content({...payload,joinUrl}));
 assert.throws(()=>content({...payload,offsetMinutes:5}));
 assert.doesNotMatch(content({...payload,applicantName:'<script>bad()</script>',private_notes:'SECRET',scorecard:{overall:5}}).html,/<script>|SECRET/);
});
test('a follow-up action requires current interview and optimistic timestamp, and retains explicit guests',()=>{
 const result=ui.buildVerificationAction('schedule_follow_up_interview',{applicantId:'10000000-0000-4000-8000-000000000020',interviewId:'10000000-0000-4000-8000-000000000021',expectedUpdatedAt:'2099-09-01T16:00:00Z',startsAt:payload.startsAt,durationMinutes:30,timezone:payload.timezone,interviewerUserId:'10000000-0000-4000-8000-000000000011',additionalAttendeeUserIds:[]});
 assert.equal(result.action,'schedule_follow_up_interview');assert.deepEqual(result.additionalAttendeeUserIds,[]);
 assert.throws(()=>ui.buildVerificationAction('schedule_follow_up_interview',{}));
});
test('cancelled/stale reminder preparation never reaches provider',async()=>{
 let sent=0;const result=await dispatch({outboxId:'id',leaseToken:'lease',to:'sample@example.com',payload},{rpc:async()=>null,fetch:async()=>{sent++;}},'sample-key');
 assert.equal(result,'cancelled');assert.equal(sent,0);
});
test('delivery retries use byte-identical persisted bodies and per-reminder keys',async()=>{
 const body=JSON.stringify({...content(payload),to:['sample@example.com']}),calls=[];
 const row={outboxId:'sample-id',leaseToken:'sample-lease',requestBody:body};
 const deps={rpc:async(name,args)=>{calls.push([name,args]);return name==='prepare_interview_reminder'?body:true;},fetch:async(url,options)=>{assert.equal(options.body,body);assert.equal(options.headers['Idempotency-Key'],'soro-interview/sample-id');return {ok:false,status:429,json:async()=>({})};}};
 assert.equal(await dispatch(row,deps,'fake'),'retry');assert.equal(calls[0][1].p_request_body,body);assert.equal(calls[1][1].p_outcome,'retry');
});
test('successful provider acceptance is recorded without exposing response data',async()=>{
 let completed;const result=await dispatch({outboxId:'sample-id',leaseToken:'sample-lease',payload,to:'sample@example.com'},{rpc:async(name,args)=>name==='prepare_interview_reminder'?args.p_request_body:(completed=args,true),fetch:async()=>({ok:true,status:200,json:async()=>({id:'provider-id'})})},'fake');
 assert.equal(result,'accepted');assert.equal(completed.p_provider_message_id,'provider-id');
});
test('worker is inert without explicit production function-scoped opt-in',async()=>{
 const old=process.env.SORO_INTERVIEWS;try{delete process.env.SORO_INTERVIEWS;assert.match((await handler()).body,/disabled/);process.env.SORO_INTERVIEWS='1';assert.match((await handler()).body,/disabled/);}finally{if(old===undefined)delete process.env.SORO_INTERVIEWS;else process.env.SORO_INTERVIEWS=old;}
});
test('automatic result tasks use dedicated navigation instead of manual completion',()=>{
 const source=fs.readFileSync('operations/task-center.js','utf8'),queue=fs.readFileSync('operations/talent-review-queue.js','utf8');
 assert.match(source,/task\.source\?\.kind === 'interview_result'/);assert.match(source,/Record result/);assert.match(queue,/function openInterviewFromTask/);
 assert.match(fs.readFileSync('netlify.toml','utf8'),/\[functions\."interview-follow-through"\][\s\S]*?schedule = "\* \* \* \* \*"/);
});
