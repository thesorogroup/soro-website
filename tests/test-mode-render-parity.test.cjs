'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const runtime=fs.readFileSync('operations/test-mode/runtime.js','utf8');
function sandbox(){
  const messages=[],c={parent:{postMessage:v=>messages.push(v)},document:{addEventListener(){}},history:{replaceState(){}},addEventListener(){},URL,Blob,Response,crypto:require('node:crypto').webcrypto};
  c.window=c;vm.createContext(c);vm.runInContext(runtime,c);c.SoroTalentSelfUploads=require('../operations/talent-self-uploads');return c;
}
const read=async(c,path,body)=>{const response=await c.fetch('/.netlify/functions/'+path,body?{method:'POST',body:JSON.stringify(body)}:{});assert.equal(response.status,200);return response.json();};

test('Test Mode uses current production entrypoint and styles, with data-only adapters',()=>{
  const launcher=fs.readFileSync('operations/founder-test-mode.js','utf8'),start=fs.readFileSync('operations/test-mode/start.js','utf8');
  assert.match(launcher,/fetch\('\/operations\/index.html',\{cache:'no-store'\}\)/);
  assert.match(launcher,/DOMParser\(\).parseFromString\(source/);
  assert.doesNotMatch(runtime,/innerHTML\s*=|\.style\s*[.=]|createElement/);
  assert.doesNotMatch(start,/innerHTML\s*=|\.style\s*[.=]/);
  assert.match(start,/options.adapter.kind='sample'/);
  assert.match(launcher,/media-src blob:/);assert.match(launcher,/connect-src 'none'/);
});
test('matched Talent profile uses one record for Client tab, attendance and Work Log',async()=>{
  const c=sandbox(),id=c.SoroTestSession.id;c.SoroTestSession.select('va');
  const a=(await c.soroSupabase.from('applicants').eq('id',id(10)).single()).data;
  assert.ok(a.relevant_experience_summary);assert.ok(a.self_reported_experience_areas.length);
  const placement=(await c.soroSupabase.from('placements').eq('applicant_id',a.id)).data[0];
  assert.equal(placement.clients.company_name,'Sample Company');
  await read(c,'talent-attendance',{action:'start_day'});
  const rows=(await c.soroSupabase.from('talent_attendance_sessions').eq('applicant_id',a.id)).data;
  const log=await read(c,'work-log');assert.equal(rows[0].started_at,log.sessions[0].startedAt);assert.equal(rows[0].placement_id,placement.id);
  c.SoroTestSession.select('talent');const roster=require('../operations/active-talent-today').normalizePayload(await read(c,'active-talent-today'));assert.equal(roster.summary.workingNow,1);assert.equal(roster.rows[0].applicantId,a.id);
});
test('Benefits, time off and Activity render their normal empty states, not adapter errors',async()=>{
  const c=sandbox(),id=c.SoroTestSession.id;c.SoroTestSession.select('va');
  const hc=await read(c,'talent-healthcare',{action:'view',applicantId:id(10)});
  assert.equal(hc.canManage,false);assert.equal(hc.profile.plans.length,4);
  assert.match(require('../operations/talent-healthcare').markup(hc),/No plan details added/);
  const time=await read(c,'talent-time-off');assert.equal(time.eligibility.eligible,true);
  const history=await read(c,'activity-history?kind=talent&id='+id(10));
  assert.equal(require('../operations/activity-history').valid(history,'talent',id(10),'virtual_assistant'),true);
  c.SoroTestSession.select('talent');assert.equal((await read(c,'talent-portal-access',{action:'status',applicantId:id(10)})).access.state,'active');
  assert.equal((await read(c,'talent-portal-access',{action:'status',applicantId:id(11)})).access.state,'not_activated');
});
test('sample healthcare edits are shared with the Talent, but Sales and Client cannot access them',async()=>{
  const c=sandbox(),id=c.SoroTestSession.id;c.SoroTestSession.select('talent');
  const hc=await read(c,'talent-healthcare',{action:'view',applicantId:id(10)});hc.profile.coverageLevel='talent_only';
  await read(c,'talent-healthcare',{action:'save',applicantId:id(10),expectedVersion:0,profile:hc.profile});
  c.SoroTestSession.select('va');assert.equal((await read(c,'talent-healthcare',{action:'view',applicantId:id(10)})).profile.coverageLevel,'talent_only');
  for(const role of ['sales','client']){c.SoroTestSession.select(role);assert.equal((await c.fetch('/.netlify/functions/talent-healthcare',{method:'POST',body:JSON.stringify({action:'view',applicantId:id(10)})})).status,403);}
});
test('Sales uses the read-only production talent payload with no private identity, dream or contact data',async()=>{
  const c=sandbox(),id=c.SoroTestSession.id;c.SoroTestSession.select('sales');
  const {talent}=await read(c,'internal-talent-profile?id='+id(10));assert.equal(talent.id,id(10));assert.ok(talent.relevant_experience_summary);
  for(const k of ['email','phone','greatest_dream','address_line_1','auth_user_id','legacy_application_data'])assert.equal(Object.hasOwn(talent,k),false);
  const search=await read(c,'global-search?q=jamie');assert.equal(search.talent[0].recordId,id(10));assert.equal(search.clients.length,0);
});
test('self video uploads stay local, use shared validation, retain versions and render through normal documents/signing',async()=>{
  const c=sandbox(),id=c.SoroTestSession.id;c.SoroTestSession.select('va');
  async function upload(name,kind='introduction_video',type='video/mp4'){
    const file=new Blob(['test file'],{type}),prep=await read(c,'talent-profile-files',{action:'prepare',requestId:c.crypto.randomUUID(),name,kind,type,size:file.size});
    assert.equal((await c.fetch(prep.url,{method:'PUT',body:file})).status,200);
    assert.equal((await c.fetch(prep.url,{method:'PUT',body:file})).status,409);
    await read(c,'talent-profile-files',{action:'complete',fileId:prep.fileId});await read(c,'talent-profile-files',{action:'complete',fileId:prep.fileId});return prep;
  }
  await upload('first.mp4');await upload('replacement.mp4');
  let docs=(await c.soroSupabase.from('documents').eq('applicant_id',id(10)).order('created_at',{ascending:false})).data;
  assert.equal(docs.length,2);assert.equal(docs[0].file_name,'replacement.mp4');
  assert.equal((await read(c,'document-center?view=mine')).files.length,2);
  const signing=c.soroSupabase.storage.from('soro-private-documents'),path=docs[0].storage_path;
  assert.match((await signing.createSignedUrl(path)).data.signedUrl,/^blob:/);
  c.SoroTestSession.select('talent');assert.equal((await c.soroSupabase.from('documents').eq('applicant_id',id(10))).data.length,2);
  for(const role of ['sales','client']){c.SoroTestSession.select(role);assert.equal((await c.soroSupabase.from('documents')).data.length,0);assert.ok((await signing.createSignedUrl(path)).error);}
  c.SoroTestSession.reset();c.SoroTestSession.select('va');assert.equal((await c.soroSupabase.from('documents')).data.length,0);assert.ok((await signing.createSignedUrl(path)).error);
});
test('sample upload cannot complete after a role change or reset, and never accepts a live upload URL',async()=>{
  const c=sandbox();c.SoroTestSession.select('va');const prep=await read(c,'talent-profile-files',{action:'prepare',requestId:c.crypto.randomUUID(),name:'intro.mp4',kind:'introduction_video',type:'video/mp4',size:9});
  c.SoroTestSession.select('sales');assert.equal((await c.fetch(prep.url,{method:'PUT',body:new Blob(['test file'])})).status,403);
  c.SoroTestSession.reset();c.SoroTestSession.select('va');assert.equal((await c.fetch(prep.url,{method:'PUT',body:new Blob(['test file'])})).status,403);
  assert.equal((await c.fetch('https://real.supabase.co/storage/v1/object/upload/sign/soro-private-documents/a',{method:'PUT',body:new Blob(['test file'])})).status,403);
});
