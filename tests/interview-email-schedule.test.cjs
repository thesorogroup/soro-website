'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const {interviewEmail,interviewSchedule,interviewTimezone,updateInterviewBody}=require('../netlify/functions/lib/branded-email');
const schedule={startsAt:'2026-09-11T01:00:00Z',endsAt:'2026-09-11T01:30:00Z',timezone:'America/Chicago'};
const id='11111111-1111-4111-8111-111111111111';
const teams='<div id="teams-meeting-blob"><a href="https://teams.microsoft.com/l/meetup-join/unchanged">Join meeting</a><p>Meeting ID: 123</p></div>';
test('shared invitation shows explicit Philippine and scheduling dates, offsets, and Group confidentiality',()=>{
 const email=interviewEmail('Talent',schedule);
 assert.match(email.html,/Friday, September 11, 2026/);assert.match(email.text,/Thursday, September 10, 2026/);
 assert.match(email.text,/9:00 AM – 9:30 AM/);assert.match(email.text,/8:00 PM – 8:30 PM/);
 assert.match(email.text,/Asia\/Manila \(UTC\+08:00\)/);assert.match(email.text,/America\/Chicago \(UTC-05:00\)/);
 const confidentiality='This is a confidential interview invitation from The Soro Group. This invitation and meeting link are intended only for the invited participants. Please do not forward them without permission.';
 for(const audience of ['Talent','Client']){const rendered=interviewEmail(audience,schedule);assert.ok(rendered.html.includes(confidentiality));assert.ok(rendered.text.includes(confidentiality));}
 assert.doesNotMatch(email.text+email.html,/Soro Ops|Hi |your local time zone|Confidential — The Soro Group/);
 assert.match(email.html,/Your interview with The Soro Group/);assert.match(interviewEmail('Client',schedule).text,/next teammate/);
});
test('winter, daylight-saving transition, half-hour offset and cross-midnight are formatted per instant',()=>{
 const rows=opts=>interviewSchedule({...schedule,...opts}).map(x=>x[1]).join('\n');
 assert.match(rows({startsAt:'2026-01-11T01:00:00Z',endsAt:'2026-01-11T01:30:00Z'}),/UTC-06:00/);
 assert.match(rows({startsAt:'2026-03-08T07:30:00Z',endsAt:'2026-03-08T08:30:00Z'}),/UTC-06:00 → UTC-05:00/);
 assert.match(rows({timezone:'Asia/Kolkata'}),/UTC\+05:30/);
 assert.match(rows({startsAt:'2026-09-10T15:45:00Z',endsAt:'2026-09-10T16:15:00Z'}),/11:45 PM – Friday, September 11, 2026 · 12:15 AM/);
});
test('interview footer provides a branded Talent team email link and a readable plain-text address',()=>{
 for(const audience of ['Talent','Client']){
  const email=interviewEmail(audience,schedule);
  assert.match(email.html,/<a href="mailto:talents@thesorogroup\.com"[^>]*>talents@thesorogroup\.com<\/a>/);
  assert.match(email.text,/Questions about this interview\? Contact talents@thesorogroup\.com\./);
  assert.doesNotMatch(email.html,/Questions about this interview\? Contact your Soro coordinator/);
 }
 const legacy=interviewEmail('Talent',schedule).html.replace(/Questions about this interview\? Contact <a[^>]*>talents@thesorogroup\.com<\/a>\./,'Questions about this interview? <span>Contact your Soro coordinator.</span>')+teams;
 const updated=updateInterviewBody({contentType:'HTML',content:legacy},'Talent',schedule).content;
 assert.match(updated,/href="mailto:talents@thesorogroup\.com"/);
 assert.ok(updated.includes(teams));
});
test('zones are not guessed from viewer and missing/invalid values use labeled UTC',()=>{
 assert.equal(interviewTimezone('not/a-zone'),'UTC');assert.equal(interviewTimezone(undefined),'UTC');
 assert.equal(interviewSchedule({...schedule,timezone:'Asia/Manila'}).length,1);
 assert.match(interviewEmail('Talent',{...schedule,timezone:'<script>'}).text,/Coordinated Universal Time/);
 assert.doesNotMatch(interviewEmail('Talent',{...schedule,timezone:'<script>'}).html,/<script>/);
 assert.throws(()=>interviewEmail('Talent',{...schedule,endsAt:schedule.startsAt}));
 assert.deepEqual(interviewSchedule(schedule),interviewSchedule({...schedule,startsAt:'2026-09-10T20:00:00-05:00',endsAt:'2026-09-10T20:30:00-05:00'}));
});
test('reschedule replaces only date block and preserves Teams and other calendar content exactly',()=>{
 const email=interviewEmail('Talent',schedule),old=email.html.replace('</body>',teams+'</body>');
 const next={...schedule,startsAt:'2026-09-12T01:00:00Z',endsAt:'2026-09-12T01:30:00Z'};
 const updated=updateInterviewBody({contentType:'html',content:old},'Talent',next).content;
 assert.ok(updated.includes(teams));assert.match(updated,/Saturday, September 12, 2026/);
 assert.doesNotMatch(updated,/Thursday, September 10, 2026/);
 assert.equal((updated.match(/id="soro-interview-schedule"/g)||[]).length,1);
 const withoutBlock=html=>html.replace(/<table id="soro-interview-schedule"[\s\S]*?<\/table>/,'');
 assert.equal(withoutBlock(updated),withoutBlock(old));
 assert.equal(updateInterviewBody({contentType:'html',content:updated},'Talent',next).content,updated);
});
test('legacy branded body gets date block and confidentiality wording without replacing Teams',()=>{
 const old=`<html><body><h1>Let’s meet your next teammate.</h1><p>Your interview is scheduled. The date and time in this calendar invitation will display in your local time zone.</p><p>Private review notes and decisions stay in Soro Ops.</p>${teams}</body></html>`;
 const updated=updateInterviewBody({contentType:'HTML',content:old},'Talent',schedule).content;
 assert.ok(updated.includes(teams));assert.doesNotMatch(updated,/Soro Ops/);assert.match(updated,/INTERVIEW DATE &amp; TIME/);
 assert.throws(()=>updateInterviewBody({contentType:'text',content:old},'Talent',schedule));
 assert.throws(()=>updateInterviewBody({contentType:'html',content:teams},'Talent',schedule));
 const duplicated=interviewEmail('Talent',schedule).html.repeat(2);
 assert.throws(()=>updateInterviewBody({contentType:'html',content:duplicated},'Talent',schedule));
 const normalized=old.replace('<p>Your interview is scheduled.', '<p class="MsoNormal"><span>Your interview is scheduled.').replace('local time zone.</p>', 'local time zone.</span></p>').replace('Private review notes and decisions stay in Soro Ops.','<span>Private review notes and decisions</span><span> stay in Soro Ops.</span>');
 const normalizedResult=updateInterviewBody({contentType:'HTML',content:normalized},'Talent',schedule).content;
 assert.ok(normalizedResult.includes(teams));assert.match(normalizedResult,/INTERVIEW DATE &amp; TIME/);assert.doesNotMatch(normalizedResult,/Soro Ops/);
});

process.env.MICROSOFT_TENANT_ID='test-tenant';process.env.MICROSOFT_CLIENT_ID='test-client';process.env.MICROSOFT_CLIENT_SECRET='test-secret';process.env.MICROSOFT_SHARED_ORGANIZER_USER_ID='organizer@example.test';
function backend(file){const filename=path.resolve(__dirname,'../netlify/functions',file);const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));m._compile(fs.readFileSync(filename,'utf8')+'\nexports.testCalendarCommand=calendarCommand;',filename);return m.exports;}
for(const [file,audience] of [['talent-verification.js','Talent'],['client-placement-workflow.js','Client']]){
 const api=backend(file);
 const command={...schedule,action:'update',requestId:id,transactionId:id,interviewId:id,expectedUpdatedAt:'2026-09-10T01:00:00Z',eventId:'safe-event',joinUrl:'https://teams.microsoft.com/l/meetup-join/unchanged',applicantName:'Example Talent',applicantEmail:'talent@example.test',interviewerName:'Example Interviewer',interviewerEmail:'interviewer@example.test',attendees:[{name:'Talent',email:'talent@example.test'},{name:'Client',email:'client@example.test'},{name:'Sales',email:'sales@example.test'}]};
 test(`${audience} scheduling zone comes from matching authoritative interview state`,()=>{
  const interview={interviewId:id,...schedule};
  const state=i=>audience==='Talent'?{interview:i}:{candidates:[{interviews:[i]}]};
  assert.equal(api.testCalendarCommand(command,id,state(interview)).timezone,'America/Chicago');
  assert.equal(api.testCalendarCommand(command,id,state({...interview,interviewId:'22222222-2222-4222-8222-222222222222'})).timezone,'UTC');
  assert.equal(api.testCalendarCommand(command,id,state({...interview,endsAt:'2026-09-12T01:30:00Z'})).timezone,'UTC');
 });
 test(`${audience} reschedule fetches current body before guarded PATCH and retains Teams`,async t=>{
  const previous=global.fetch,calls=[];t.after(()=>{global.fetch=previous;});
  global.fetch=async(url,opts)=>{calls.push({url,opts});if(url.includes('oauth2'))return Response.json({access_token:'fake'});if(opts.method==='GET')return Response.json({'@odata.etag':'W/"version1"',body:{contentType:'HTML',content:interviewEmail(audience,{...schedule,startsAt:'2026-09-10T01:00:00Z',endsAt:'2026-09-10T01:30:00Z'}).html.replace('</body>',teams+'</body>')}});return Response.json({onlineMeeting:{joinUrl:command.joinUrl}});};
  const result=await api.syncGraphCalendar(command);assert.equal(result.status,'synced');assert.equal(calls[1].opts.method,'GET');assert.equal(calls[2].opts.method,'PATCH');
  const patch=JSON.parse(calls[2].opts.body);assert.ok(patch.body.content.includes(teams));assert.match(patch.body.content,/Friday, September 11, 2026/);assert.equal(calls[2].opts.headers['If-Match'],'W/"version1"');
  for(const field of ['isOnlineMeeting','onlineMeetingProvider','transactionId'])assert.equal(Object.hasOwn(patch,field),false);
 });
 test(`${audience} unreadable existing body blocks PATCH instead of stripping the meeting`,async t=>{
  const previous=global.fetch;let patches=0;t.after(()=>{global.fetch=previous;});
  global.fetch=async(url,opts)=>{if(url.includes('oauth2'))return Response.json({access_token:'fake'});if(opts.method==='PATCH')patches++;return Response.json({body:{contentType:'HTML',content:teams}});};
  const result=await api.syncGraphCalendar(command);assert.equal(result.status,'sync_failed');assert.equal(patches,0);
 });
}
