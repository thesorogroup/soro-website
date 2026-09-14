'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const presentation=require('../operations/screening-presentation');
const source=fs.readFileSync(require.resolve('../operations/talent-checklist-editor.js'),'utf8');
const aid='11111111-1111-4111-8111-111111111111',org='22222222-2222-4222-8222-222222222222',uid='33333333-3333-4333-8333-333333333333';
function setup(){
  const calls=[],state={record:{id:aid,organization_id:org,updated_at:'2026-09-14T12:00:00Z',english_test_result:'B2',personality_profile_score:'DISC: D 20, I 30 | Enneagram: Type 2 | MBTI-style: INFJ-A | legacy note',internet_speed:'Download: 20 Mbps | Upload: 5 Mbps | Ping: 8 ms',computer_specs:'System: Laptop | Processor: M5'},docs:[],allowed:true,scope:'one',conflict:false};
  const root={module:{exports:{}},URL,Date,console,soroScreeningPresentation:presentation,soroCurrentAccess:{organization_id:org,user_id:uid,role:'admin'},soroTalentCoreProfileData:{authorized:()=>state.allowed,scope:()=>state.scope},addEventListener(){}};
  root.soroSupabase={supabaseUrl:'https://private.example',from(table){
    const call={table,filters:[],update:null};calls.push(call);
    const q={select(){return q;},eq(k,v){call.filters.push([k,v]);return q;},is(k,v){call.filters.push([k,v]);return q;},in(k,v){call.filters.push([k,v]);return q;},neq(k,v){call.filters.push([k,'!=',v]);return q;},order(){return q;},maybeSingle(){return q;},update(v){call.update=v;return q;},then(resolve){
      if(call.update&&state.conflict)return Promise.resolve({data:null,error:null}).then(resolve);
      if(call.update)Object.assign(state.record,call.update);
      return Promise.resolve({data:table==='applicants'?{...state.record}:state.docs,error:null}).then(resolve);
    }};return q;
  },storage:{from(){return{createSignedUrl:async()=>({data:{signedUrl:state.url||'https://private.example/storage/v1/object/sign/soro-private-documents/sample?token=fake'}})};}}};
  vm.runInNewContext(source,root);return{api:root.module.exports,root,state,calls};
}
test('single assessment edits preserve unrelated results including legacy personality notes',()=>{
  const{api,state}=setup();const updates=api.updatesFor('disc',state.record,{result:'D 24, I 31, S 27, C 18'});
  assert.deepEqual(Object.keys(updates),['personality_profile_score']);
  assert.match(updates.personality_profile_score,/Enneagram: Type 2/);assert.match(updates.personality_profile_score,/MBTI-style: INFJ-A/);assert.match(updates.personality_profile_score,/legacy note/);assert.doesNotMatch(updates.personality_profile_score,/D 20/);
  assert.deepEqual(Object.keys(api.updatesFor('english',state.record,{result:'C1 · 95%'})),['english_test_result']);
});
test('numeric internet inputs use existing serialization and preserve latency',()=>{
  const{api,state}=setup();assert.equal(api.updatesFor('internet',state.record,{download:'100.25',upload:'0'}).internet_speed,'Download: 100.25 Mbps | Upload: 0 Mbps | Ping: 8 ms');
  for(const values of [{download:'-1',upload:'2'},{download:'NaN',upload:'2'},{download:'',upload:''}])assert.throws(()=>api.updatesFor('internet',state.record,values));
});
test('MBTI edits do not remove codes mentioned inside other tests or legacy notes',()=>{
  const{api,state}=setup();state.record.personality_profile_score='DISC: C high (often INTP) | Enneagram: 5 | Note: prior INFP result needs review | MBTI-style: INTJ';
  const value=api.updatesFor('mbti',state.record,{result:'ENFJ'}).personality_profile_score;
  assert.equal(value,'DISC: C high (often INTP) | Enneagram: 5 | Note: prior INFP result needs review | MBTI-style: ENFJ');
});
test('legacy resume links are restricted to the existing trusted Drive hosts',()=>{
  const{api}=setup();assert.equal(api.legacyResumeUrl('https://drive.google.com/file/d/example/view'),'https://drive.google.com/file/d/example/view');
  for(const url of ['javascript:alert(1)','https://drive.google.com.evil.example/x','https://user:secret@drive.google.com/x','http://docs.google.com/x'])assert.equal(api.legacyResumeUrl(url),'');
});
test('field validation disallows unrelated updates, empty results and multi-field delimiters',()=>{
  const{api,state}=setup();for(const values of [{result:''},{result:'one | MBTI: forged'},{result:'a'.repeat(141)},{result:'one',english_test_result:'other'}])assert.throws(()=>api.updatesFor('disc',state.record,values));
  assert.throws(()=>api.updatesFor('resume',state.record,{result:'verified'}));
});
test('save scopes to the applicant organization and exact original timestamp',async()=>{
  const{api,state,calls}=setup(),snapshot=await api.load(aid);await api.save(aid,snapshot,'enneagram',{result:'Type 3'});
  const mutation=calls.find(c=>c.update);assert.deepEqual(JSON.parse(JSON.stringify(mutation.filters)),[['organization_id',org],['id',aid],['updated_at','2026-09-14T12:00:00Z'],['archived_at',null]]);
  assert.equal(state.record.english_test_result,'B2');assert.match(state.record.personality_profile_score,/DISC: D 20/);assert.match(state.record.personality_profile_score,/Enneagram: Type 3/);
});
test('forged, stale and changed-role saves are rejected',async()=>{
  const{api,state}=setup();const snapshot=await api.load(aid);await assert.rejects(()=>api.save(aid,{...snapshot},'disc',{result:'D 1'}),/Reopen/);
  state.conflict=true;await assert.rejects(()=>api.save(aid,snapshot,'disc',{result:'D 1'}),/Newer results have not been overwritten/);
  state.conflict=false;state.scope='two';await assert.rejects(()=>api.save(aid,snapshot,'disc',{result:'D 1'}),/Reopen/);
  state.allowed=false;await assert.rejects(()=>api.load(aid),/access/);
});
test('file category mapping matches existing proof categories; rejected and cross-applicant files never preview',async()=>{
  const{api,state,calls}=setup();assert.equal(api.TYPES.internet,'internet_proof');assert.equal(api.TYPES.equipment,'equipment_proof');
  state.docs=[{id:uid,applicant_id:aid,organization_id:org,status:'uploaded',document_type:'disc_assessment'},{id:org,applicant_id:uid,organization_id:org,status:'uploaded',document_type:'disc_assessment'},{id:aid,applicant_id:aid,organization_id:org,status:'rejected',document_type:'disc_assessment'}];
  assert.equal((await api.documents(aid,'disc')).length,1);assert.ok(calls[0].filters.some(f=>f[0]==='applicant_id'&&f[1]===aid));
});
test('live file URLs stay on private signed storage; sample URLs never bypass the top-level guard',async()=>{
  const{api,state,root}=setup(),doc={applicant_id:aid,organization_id:org,storage_path:'sample'};
  assert.match(await api.signedFile(aid,doc),/^https:\/\/private.example/);
  for(const url of ['https://evil.example/file.pdf','data:image/png;base64,AAA','https://private.example/public/file.pdf']){state.url=url;await assert.rejects(()=>api.signedFile(aid,doc),/secure file/);}
  root.SoroTestSession={previewFile:()=> 'data:image/png;base64,AAA'};await assert.rejects(()=>api.signedFile(aid,doc),/secure file/);
});
test('markup places only selected result fields alongside evidence and retains Verify Later',()=>{
  const{api,state}=setup();const html=api.fieldsMarkup('disc',state.record);assert.match(html,/DISC Assessment Result/);assert.doesNotMatch(html,/Enneagram|Download Speed/);
  const internet=api.fieldsMarkup('internet',state.record);assert.match(internet,/Download Speed/);assert.match(internet,/Upload Speed/);assert.match(internet,/type="number"/);
  const shell=api.markup({fullName:'<script>'},'disc');assert.match(shell,/Submitted File/);assert.match(shell,/Verify Later/);assert.match(shell,/&lt;script&gt;/);
});
test('queue dispatches tiles directly to focused editors without a requirements fetch',()=>{
  const queue=fs.readFileSync(require.resolve('../operations/talent-review-queue.js'),'utf8');
  assert.match(queue,/openChecklistItem\(requirementsButton\.dataset\.reviewRequirements, requirementsButton\.dataset\.reviewItem\)/);
  const dispatch=queue.slice(queue.indexOf('function openChecklistItem('),queue.indexOf('async function handleClick('));
  assert.match(dispatch,/openCoreProfile/);assert.match(dispatch,/openVerification\(applicant.applicantId,itemKey\)/);assert.match(dispatch,/editor.open\(applicant,itemKey/);assert.doesNotMatch(dispatch,/loadRequirements\(/);
  assert.match(queue,/soroTalentChecklistEditor\?\.isOpen/);assert.match(queue,/soroTalentChecklistEditor\?\.close/);
});
