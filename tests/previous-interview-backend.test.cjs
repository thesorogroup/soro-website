const test=require('node:test');
const assert=require('node:assert/strict');
process.env.SUPABASE_URL='https://previous-interview-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY='test-only';
process.env.MICROSOFT_TENANT_ID='test-tenant';
process.env.MICROSOFT_CLIENT_ID='test-client';
process.env.MICROSOFT_CLIENT_SECRET='test-secret';
process.env.MICROSOFT_SHARED_ORGANIZER_USER_ID='talents@example.invalid';
const backend=require('../netlify/functions/talent-verification');
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const base=()=>({action:'record_previous_interview',requestId:id(9),applicantId:id(20),expectedUpdatedAt:null,
 interviewId:null,occurredOn:null,interviewerName:'Actual previous interviewer',outcome:'recommended',
 communicationScore:4,preparednessScore:null,roleFitScore:3,overallScore:null,note:'Recorded from the prior interview notes.'});
const interview=()=>({interviewId:id(30),recordSource:'historical',occurredOn:null,roundNumber:1,status:'completed',
 startsAt:null,endsAt:null,timezone:null,interviewer:{id:null,name:'Actual previous interviewer'},additionalAttendees:[],
 outcome:'recommended',scorecard:{communication:4,preparedness:null,roleFit:3,overall:null},notes:'Prior notes.',
 calendar:{status:'not_applicable',joinUrl:null},updatedAt:'2026-09-01T00:00:00Z'});
const state=()=>({generatedAt:'2026-09-01T00:00:00Z',viewerRole:'admin',applicant:{applicantId:id(20),fullName:'Sample Talent',email:'sample@example.invalid',stage:'in_review',updatedAt:'2026-09-01T00:00:00Z'},
 gate:{interviewAddressed:true,referencesAddressed:false,benchReadyEligible:false,blockers:[]},interview:interview(),references:[],interviewers:[]});
const event=body=>({httpMethod:'POST',headers:{authorization:'Bearer test-user'},body:JSON.stringify(body)});

test('previous interview input permits unknown dates and blank scores without invented data',()=>{
 const value=backend.actionPayload(base(),'record_previous_interview');
 assert.deepEqual(value,{interviewId:null,occurredOn:null,interviewerName:'Actual previous interviewer',outcome:'recommended',scorecard:{communication:4,preparedness:null,roleFit:3,overall:null},note:'Recorded from the prior interview notes.'});
 assert.equal(backend.actionPayload({...base(),occurredOn:'2026-02-28'},'record_previous_interview').occurredOn,'2026-02-28');
 for(const patch of [{occurredOn:'2026-02-30'},{occurredOn:'2099-01-01'},{occurredOn:'yesterday'},{interviewerName:' '},{interviewerName:'x'.repeat(181)},{outcome:null},{outcome:'waived'},{note:' '},{communicationScore:0},{communicationScore:6},{communicationScore:4.5},{roleFitScore:'3'},{overallScore:undefined}]){
  assert.throws(()=>backend.actionPayload({...base(),...patch},'record_previous_interview'),undefined,JSON.stringify(patch));
 }
});

test('historical response retains truthful source and optional date while rejecting calendar identities',()=>{
 const payload=state();assert.equal(backend.publicPayload(payload).interview.recordSource,'historical');
 payload.interview.occurredOn='2026-08-15';assert.equal(backend.publicPayload(payload).interview.occurredOn,'2026-08-15');
 for(const patch of [{recordSource:'invented'},{occurredOn:'2026-02-30'},{startsAt:'2026-08-01T12:00:00Z'},{endsAt:'2026-08-01T12:00:00Z'},
  {timezone:'Asia/Manila'},{status:'scheduled'},{outcome:null},{interviewer:{id:id(10),name:'Internal'}},{additionalAttendees:[{id:id(10),name:'Guest'}]},
  {calendar:{status:'synced',joinUrl:null}},{calendar:{status:'not_applicable',joinUrl:'https://teams.microsoft.com/test'}}]){
  assert.throws(()=>backend.publicPayload({...state(),interview:{...interview(),...patch}}));
 }
 const normal={...interview(),recordSource:undefined,occurredOn:undefined,startsAt:'2026-08-01T12:00:00Z',endsAt:'2026-08-01T12:30:00Z',timezone:'Asia/Manila'};
 assert.equal(backend.publicPayload({...state(),interview:normal}).interview.recordSource,'scheduled');
});

test('manual recording only calls authentication and mutation; even a stray command cannot send invitations',async t=>{
 const original=global.fetch;const calls=[];let command=null;
 global.fetch=async(url,options={})=>{calls.push({url:String(url),options});
  if(String(url).endsWith('/auth/v1/user'))return new Response(JSON.stringify({id:id(10)}));
  if(String(url).endsWith('/rest/v1/rpc/mutate_talent_verification'))return new Response(JSON.stringify({state:state(),calendarCommand:command}));
  throw new Error('Unexpected external operation');
 };t.after(()=>global.fetch=original);
 let result=await backend.handler(event(base()));assert.equal(result.statusCode,200);assert.equal(calls.length,2);
 const rpc=JSON.parse(calls[1].options.body);assert.equal(rpc.p_actor_user_id,id(10));assert.equal(rpc.p_action,'record_previous_interview');
 assert.equal(rpc.p_expected_updated_at,null);assert.ok(!('calendarOrganizer' in rpc.p_payload));
 command={action:'create'};result=await backend.handler(event(base()));assert.equal(result.statusCode,502);assert.equal(calls.length,4);
 const before=calls.length;
 for(const body of [{...base(),organizationId:id(2)},{...base(),status:'completed'},{...base(),startsAt:'2026-01-01'}, {...base(),interviewId:id(30),expectedUpdatedAt:null}]){
  const denied=await backend.handler(event(body));assert.equal(denied.statusCode,400);
 }
 assert.equal(calls.length,before,'invalid scope is rejected before any authenticated or database request');
});

test('previous-interview validation errors are actionable without exposing raw database details',async t=>{
 const original=global.fetch;let databaseMessage='';
 global.fetch=async url=>String(url).endsWith('/auth/v1/user')?new Response(JSON.stringify({id:id(10)})):
  new Response(JSON.stringify({code:'22023',message:databaseMessage,details:'PRIVATE DATABASE DETAIL'}),{status:400});
 t.after(()=>global.fetch=original);
 for(const [message,expected] of [
  ['Complete the previous interview details.',/Your entries have been kept/],
  ['Use a valid past interview date or leave it unknown.',/leave the date blank/],
  ['Scores must be whole numbers from 1 to 5 or blank.',/whole-number interview scores from 1 to 5/],
  ['PRIVATE UNRECOGNIZED ERROR',/^Check the verification details and try again\.$/]
 ]){
  databaseMessage=message;const response=await backend.handler(event(base()));
  assert.equal(response.statusCode,400);assert.match(JSON.parse(response.body).message,expected);
  assert.doesNotMatch(response.body,/PRIVATE/);
 }
});
