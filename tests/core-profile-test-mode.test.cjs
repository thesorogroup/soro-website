'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

function sandbox(){
 const messages=[],c={parent:{postMessage:value=>messages.push(value)},document:{addEventListener(){}},history:{replaceState(){}},addEventListener(){},URL,Blob,Response,crypto:require('node:crypto').webcrypto,fetch(){throw new Error('A live request must never be made.');}};
 c.window=c;vm.createContext(c);vm.runInContext(fs.readFileSync('operations/test-mode/runtime.js','utf8'),c);
 c.SoroTestSession.select('talent');c.soroCurrentAccess=c.SoroTestSession.access();
 vm.runInContext(fs.readFileSync('operations/talent-core-profile-data.js','utf8'),c);
 return c;
}
const serial=value=>JSON.parse(JSON.stringify(value));
const core=c=>c.SoroTestSession.queue().applicants[0].checklist.find(item=>item.key==='core_profile');
const values=(snapshot,patch={})=>Object.fromEntries(['full_name','email','phone','timezone','country','city'].map(field=>[field,Object.hasOwn(patch,field)?patch[field]:snapshot.record[field]||'']));
async function requirements(c){const response=await c.fetch('/.netlify/functions/talent-review-deferrals?applicantId='+c.SoroTestSession.id(11));assert.equal(response.status,200);return response.json();}

test('saving a missing core field through the real helper checks off the sample queue and preserves unrelated records',async()=>{
 const c=sandbox(),s=c.SoroTestSession,api=c.soroTalentCoreProfileData,applicantId=s.id(11),before=serial(s.store.applicants),tasks=serial(s.store.tasks);
 assert.equal(core(c).state,'missing');
 const snapshot=await api.load(applicantId);assert.deepEqual(serial(api.missingFields(snapshot.record)),['phone']);
 const saved=await api.save(applicantId,snapshot,values(snapshot,{phone:' +63 917 555 0100 '}));
 assert.equal(saved.record.phone,'+63 917 555 0100');assert.equal(core(c).state,'complete');
 assert.equal((await requirements(c)).items.find(item=>item.key==='core_profile').status,'complete');
 assert.equal(s.store.stage,'submitted');assert.equal(s.store.applicants[1].auth_user_id,null);assert.equal(s.store.applicants[1].email,'riley@example.test');
 assert.deepEqual(serial(s.store.applicants[0]),before[0]);assert.deepEqual(serial(s.store.tasks),tasks);
 assert.deepEqual(serial({...s.store.applicants[1],phone:before[1].phone,updated_at:before[1].updated_at}),before[1]);
 assert.equal(s.store.taskNotifications.length,0);
});

test('sample completion matches required fields and accepts a preserved legacy location',()=>{
 const c=sandbox(),a=c.SoroTestSession.store.applicants[1],api=c.soroTalentCoreProfileData;
 a.phone='+63 917 555 0100';assert.equal(core(c).state,'complete');
 for(const field of ['full_name','email','phone','timezone']){
  const prior=a[field];a[field]='   ';assert.equal(core(c).state,'missing',field);assert.ok(api.missingFields(a).includes(field));a[field]=prior;
 }
 a.location=null;
 for(const field of ['country','city']){
  const prior=a[field];a[field]='';assert.equal(core(c).state,'missing',field);assert.ok(api.missingFields(a).includes('location'));a[field]=prior;
 }
 a.location='Cebu City, Philippines';a.country='';a.city='';
 assert.equal(core(c).state,'complete');assert.deepEqual(serial(api.missingFields(a)),[]);
});

test('partial core edits keep the remaining requirement open and cannot modify the preserved location',async()=>{
 const c=sandbox(),s=c.SoroTestSession,api=c.soroTalentCoreProfileData,a=s.store.applicants[1];
 a.timezone='';a.location='Imported location';
 const snapshot=await api.load(a.id),saved=await api.save(a.id,snapshot,values(snapshot,{phone:'+63 917 555 0100'}));
 assert.equal(core(c).state,'missing');assert.deepEqual(serial(api.missingFields(saved.record)),['timezone']);assert.equal(a.location,'Imported location');
 assert.equal((await requirements(c)).items.find(item=>item.key==='core_profile').status,'pending');
 await assert.rejects(api.save(a.id,saved,{...values(saved),location:'Replacement'}));assert.equal(a.location,'Imported location');
});

test('sample saves reject stale versions and keep their timestamps strictly increasing',async()=>{
 const c=sandbox(),s=c.SoroTestSession,api=c.soroTalentCoreProfileData,a=s.store.applicants[1];
 a.updated_at=new Date(Date.now()+100000).toISOString();
 const snapshot=await api.load(a.id),saved=await api.save(a.id,snapshot,values(snapshot,{phone:'+63 917 555 0100'}));
 assert.ok(Date.parse(saved.record.updated_at)>Date.parse(snapshot.record.updated_at));
 await assert.rejects(api.save(a.id,snapshot,values(snapshot,{phone:'+63 917 555 0199'})));
 assert.equal(a.phone,'+63 917 555 0100');
 const corrected=await api.save(a.id,saved,values(saved,{full_name:'Santos, Riley Sample'}));
 assert.ok(Date.parse(corrected.record.updated_at)>Date.parse(saved.record.updated_at));
 assert.equal(s.queue().applicants[0].fullName,'Santos, Riley Sample');
});

test('core editing remains scoped to authorized roles, organization, applicant and unarchived records',async()=>{
 const c=sandbox(),s=c.SoroTestSession,api=c.soroTalentCoreProfileData,a=s.store.applicants[1],snapshot=await api.load(a.id),before=serial(a);
 for(const role of ['sales','client','va']){
  s.select(role);c.soroCurrentAccess=s.access();
  await assert.rejects(api.load(a.id));await assert.rejects(api.save(a.id,snapshot,values(snapshot,{phone:'+63 917 555 0100'})));
 }
 s.select('talent');c.soroCurrentAccess=s.access();
 await assert.rejects(api.save(s.id(10),snapshot,values(snapshot,{phone:'+63 917 555 0100'})));
 c.soroCurrentAccess={...s.access(),organization_id:s.id(91)};
 await assert.rejects(api.load(a.id));await assert.rejects(api.save(a.id,snapshot,values(snapshot,{phone:'+63 917 555 0100'})));
 c.soroCurrentAccess=s.access();a.archived_at=new Date().toISOString();
 await assert.rejects(api.load(a.id));await assert.rejects(api.save(a.id,snapshot,values(snapshot,{phone:'+63 917 555 0100'})));
 a.archived_at=null;assert.deepEqual(serial(a),before);
});

test('completing a deferred core profile leaves its separate follow-up task open',async()=>{
 const c=sandbox(),s=c.SoroTestSession,api=c.soroTalentCoreProfileData,applicantId=s.id(11);s.store.stage='in_review';
 const required=await requirements(c);
 const response=await c.fetch('/.netlify/functions/talent-review-deferrals',{method:'POST',body:JSON.stringify({action:'defer',requestId:c.crypto.randomUUID(),applicantId,expectedUpdatedAt:required.updatedAt,itemKey:'core_profile',reason:'Confirm the missing phone number.',createTask:true,dueDate:'2026-10-01'})});assert.equal(response.status,200);
 const taskId=s.store.reviewDeferrals.core_profile.taskId,before=serial(s.store.tasks.find(task=>task.id===taskId));
 const snapshot=await api.load(applicantId);await api.save(applicantId,snapshot,values(snapshot,{phone:'+63 917 555 0100'}));
 assert.equal((await requirements(c)).items.find(item=>item.key==='core_profile').status,'complete');
 assert.equal(s.store.reviewDeferrals.core_profile,undefined);assert.deepEqual(serial(s.store.tasks.find(task=>task.id===taskId)),before);
 assert.equal(s.store.stage,'in_review');assert.equal(s.store.tasks.find(task=>task.id===taskId).status,'open');
});

test('sample reset discards the profile edit and blocked external URLs never reach a live service',async()=>{
 const c=sandbox(),s=c.SoroTestSession,api=c.soroTalentCoreProfileData,a=s.store.applicants[1];
 a.updated_at='2026-01-01T00:00:00.000Z';
 const snapshot=await api.load(a.id);await api.save(a.id,snapshot,values(snapshot,{phone:'+63 917 555 0100'}));assert.equal(core(c).state,'complete');
 assert.equal((await c.fetch('https://example.test/.netlify/functions/talent-core-profile',{method:'POST',body:'{}'})).status,403);
 s.reset();assert.equal(core(c).state,'missing');assert.equal(s.store.applicants[1].phone,'');
 await assert.rejects(api.save(a.id,snapshot,values(snapshot,{phone:'+63 917 555 0199'})));
});
