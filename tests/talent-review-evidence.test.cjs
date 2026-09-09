const test=require('node:test'),assert=require('node:assert/strict');
const modulePath=require.resolve('../operations/talent-review-evidence.js');
const id='22222222-2222-4222-8222-222222222222',org='33333333-3333-4333-8333-333333333333',user='44444444-4444-4444-8444-444444444444';
function setup(t){
 const keys=['soroCurrentAccess','soroSupabase','soroTalentReviewEvidence','soroPrivatePdfViewer','soroTalentSkillCatalog'],old=keys.map(key=>[key,globalThis[key]]),calls=[];
 globalThis.soroPrivatePdfViewer=require('../operations/private-pdf-viewer.js');
 let record={id,organization_id:org,updated_at:'2026-09-08T00:00:00Z',self_reported_skills:['Scheduling','Coding'],verified_skills:['Coding'],legacy_application_data:{keep:'unrelated',verified_skill_experience:{Coding:2}}};
 let documents=[{file_name:'Resume.pdf',storage_path:'applicants/example/resume.pdf'}],signedUrl='https://project.supabase.co/storage/v1/object/sign/soro-private-documents/applicants/example/resume.pdf?token=test';
 let updateEmpty=false,wait=null,libraryWait=null,libraryError=null,library=[{name:'Custom library skill',is_active:true},{name:'Retired library skill',is_active:false}];
 globalThis.soroTalentSkillCatalog={getGroups:()=>[{id:'medical',label:'Medical',skills:[{name:'Medical coding'},{name:'Coding'}]}]};
 globalThis.soroCurrentAccess={user_id:user,organization_id:org,role:'talent_management',active:true};
 globalThis.soroSupabase={supabaseUrl:'https://project.supabase.co',from(table){const call={table,filters:[]};calls.push(call);const query={
  select(fields){call.fields=fields;return this;},update(values){call.update=values;return this;},eq(k,v){call.filters.push([k,v]);return this;},is(k,v){call.filters.push([k,v]);return this;},neq(k,v){call.filters.push([k,v]);return this;},not(...v){call.filters.push(v);return this;},order(){return this;},limit(){return this;},
  range(start,end){call.range=[start,end];return this;},async maybeSingle(){if(wait)await wait;return {data:updateEmpty&&call.update?null:{...record,...call.update},error:null};},async then(resolve){if(table==='skill_library'&&libraryWait)await libraryWait;return resolve({data:table==='skill_library'?library.slice(call.range?.[0]||0,(call.range?.[1]??library.length-1)+1):documents,error:table==='skill_library'?libraryError:null});}
 };return query;},storage:{from(bucket){return {async createSignedUrl(path,seconds){calls.push({bucket,path,seconds});return {data:{signedUrl},error:null};}};}}};
 delete require.cache[modulePath];const api=require(modulePath);
 t.after(()=>{delete require.cache[modulePath];for(const [key,value]of old){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
 return {api,calls,conflict:()=>updateEmpty=true,url:v=>signedUrl=v,docs:v=>documents=v,library:v=>library=v,record:v=>record={...record,...v},libraryError:()=>libraryError={message:'Unavailable'},deferLibrary:()=>{let release;libraryWait=new Promise(r=>release=r);return release;},defer:()=>{let release;wait=new Promise(r=>release=r);return release;}};
}

test('active library loading paginates beyond a single response cap',async t=>{
 const h=setup(t);h.library(Array.from({length:501},(_,i)=>({name:`Library ${i}`,is_active:true})));
 const snapshot=await h.api.loadSkills(id,{includeCatalog:true});
 assert.equal(snapshot.catalog.at(-1).skills.length,501);
 assert.deepEqual(h.calls.filter(c=>c.table==='skill_library').map(c=>c.range),[[0,499],[500,999]]);
 await h.api.saveSkills(id,snapshot,[{name:'Library 500',years:''}]);
});

test('full catalog permits missing application and active library skills without rewriting applicant answers',async t=>{
 const h=setup(t),snapshot=await h.api.loadSkills(id,{includeCatalog:true});
 assert.equal(snapshot.catalog.length,2);
 assert.ok(h.calls.find(c=>c.table==='skill_library').filters.some(x=>x[0]==='is_active'&&x[1]===true));
 const saved=await h.api.saveSkills(id,snapshot,[{name:'Medical coding',years:''},{name:'Custom library skill',years:'0'}]);
 const change=h.calls.find(c=>c.update).update;
 assert.deepEqual(change.verified_skills,['Medical coding','Custom library skill']);
 assert.deepEqual(change.legacy_application_data.verified_skill_experience,{'Custom library skill':0});
 assert.equal(change.legacy_application_data.keep,'unrelated');
 assert.equal(Object.hasOwn(change,'self_reported_skills'),false);
 assert.equal(Object.hasOwn(change,'self_reported_experience_areas'),false);
 assert.deepEqual(saved.record.self_reported_skills,['Scheduling','Coding']);
 await h.api.saveSkills(id,saved,[{name:'Medical coding',years:'1'}]);
 await assert.rejects(h.api.saveSkills(id,snapshot,[{name:'Retired library skill',years:''}]),/listed/);
});
test('a Talent without any recorded skills can receive catalog skills',async t=>{
 const h=setup(t);h.record({self_reported_skills:[],verified_skills:[]});
 const snapshot=await h.api.loadSkills(id,{includeCatalog:true});
 await h.api.saveSkills(id,snapshot,[{name:'Medical coding',years:''}]);
 assert.deepEqual(h.calls.find(c=>c.update).update.verified_skills,['Medical coding']);
});
test('default queue scope stays recorded-only and cannot be expanded by a forged catalog',async t=>{
 const h=setup(t),snapshot=await h.api.loadSkills(id);
 assert.equal(h.calls.some(c=>c.table==='skill_library'),false);
 snapshot.catalog=[{skills:[{name:'Medical coding'}]}];
 await assert.rejects(h.api.saveSkills(id,snapshot,[{name:'Medical coding',years:''}]),/listed/);
});
test('library failure stops loading without a stale local fallback',async t=>{
 const h=setup(t);h.libraryError();
 await assert.rejects(h.api.loadSkills(id,{includeCatalog:true}),/library could not be loaded/);
 assert.equal(h.calls.some(c=>c.update),false);
});
test('late library response is rejected after an account change',async t=>{
 const h=setup(t),release=h.deferLibrary(),loading=h.api.loadSkills(id,{includeCatalog:true});
 await new Promise(resolve=>setImmediate(resolve));
 globalThis.soroCurrentAccess={...globalThis.soroCurrentAccess,user_id:id};release();
 await assert.rejects(loading,/access changed/);
});
test('evidence only permits active actual Admin/Talent Management access',t=>{const{api}=setup(t);assert.equal(api.authorized(),true);for(const role of ['sales','virtual_assistant','client_admin']){globalThis.soroCurrentAccess.role=role;assert.equal(api.authorized(),false);}globalThis.soroCurrentAccess.role='admin';globalThis.soroCurrentAccess.must_change_password=true;assert.equal(api.authorized(),false);});
test('skills save is scoped, conditional and preserves unrelated legacy values',async t=>{const{api,calls}=setup(t),snapshot=await api.loadSkills(id);await api.saveSkills(id,snapshot,[{name:'Scheduling',years:'3'}]);const save=calls.find(c=>c.update);assert.deepEqual(save.update.verified_skills,['Scheduling']);assert.equal(save.update.legacy_application_data.keep,'unrelated');assert.deepEqual(save.update.legacy_application_data.verified_skill_experience,{Scheduling:3});assert.ok(save.filters.some(x=>x[0]==='organization_id'&&x[1]===org));assert.ok(save.filters.some(x=>x[0]==='updated_at'&&x[1]===snapshot.record.updated_at));});
test('conflicts, injected skills and invalid years cannot silently overwrite a record',async t=>{const h=setup(t),snapshot=await h.api.loadSkills(id);await assert.rejects(h.api.saveSkills(id,snapshot,[{name:'Injected',years:2}]),/listed/);await assert.rejects(h.api.saveSkills(id,snapshot,[{name:'Coding',years:99}]),/50/);h.conflict();await assert.rejects(h.api.saveSkills(id,snapshot,[]),/changed/);});
test('a late private skill response is rejected after an account change',async t=>{const h=setup(t),release=h.defer(),loading=h.api.loadSkills(id);globalThis.soroCurrentAccess={...globalThis.soroCurrentAccess,user_id:id};release();await assert.rejects(loading,/access changed/);});
test('resume lookup keeps private same-applicant scope and uses local PDF rendering instead of native frames',async t=>{const{api,calls}=setup(t),resume=await api.loadResume(id);assert.equal(resume.kind,'pdf');assert.equal(calls[0].fields,'file_name,storage_path');for(const filter of [['organization_id',org],['applicant_id',id],['document_type','resume'],['status','rejected']])assert.ok(calls[0].filters.some(x=>JSON.stringify(x)===JSON.stringify(filter)));assert.equal(calls[1].seconds,60);const html=api.resumeMarkup(resume);assert.match(html,/data-private-pdf-viewer/);assert.doesNotMatch(html,/<iframe|<object|google|office|allow-scripts/i);});
test('unsupported resume formats get a secure open link and missing files get an explicit state',async t=>{const h=setup(t);h.docs([{file_name:'Resume.docx',storage_path:'private/docx'}]);const resume=await h.api.loadResume(id);assert.equal(resume.kind,'download');assert.doesNotMatch(h.api.resumeMarkup(resume),/<iframe/);h.docs([]);assert.deepEqual(await h.api.loadResume(id),{missing:true});});
test('off-origin or non-storage signed URLs are rejected',async t=>{const h=setup(t);for(const url of ['https://evil.example/file.pdf','https://project.supabase.co/other','http://project.supabase.co/storage/v1/object/sign/soro-private-documents/file']){h.url(url);await assert.rejects(h.api.loadResume(id),/unavailable/);}});
