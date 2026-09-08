'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ui=require('../operations/talent-self-uploads');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const id='10000000-0000-4000-8000-000000000018',org='10000000-0000-4000-8000-000000000001';
const access={role:'virtual_assistant',user_id:id,organization_id:org},applicant={id:'talent',auth_user_id:id,organization_id:org};
test('self upload controls are limited to actual Talent and their own organization/profile',()=>{
 assert.equal(ui.canUpload(access,applicant),true);
 for(const role of ['admin','talent_management','sales','client_admin'])assert.equal(ui.canUpload({...access,role},applicant),false);
 assert.equal(ui.canUpload(access,{...applicant,auth_user_id:'other'}),false);
 assert.equal(ui.canUpload(access,{...applicant,organization_id:'other'}),false);
 assert.equal(ui.canUpload(null,applicant),false);
});
test('file inputs accept only bounded headshots and resumes and never inject file names into markup',()=>{
 for(const [kind,name,type,size]of [['profile_photo','Headshot.JPG','image/jpeg',5242880],['profile_photo','photo.png','image/png',20],['resume','resume.pdf','application/pdf',10485760],['resume','CV.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',30]]){
  assert.equal(ui.fileInfo({name,type,size},kind).type,type);assert.equal(ui.fileInfo({name,type:'',size},kind).type,type);
 }
 for(const file of [{name:'a.svg',size:20,type:'image/svg+xml'},{name:'a.png',size:5242881,type:'image/png'},{name:'../a.png',size:20,type:'image/png'},{name:'a.png',size:20,type:'image/jpeg'},{name:'a.png',size:0,type:''}])assert.throws(()=>ui.fileInfo(file,'profile_photo'));
 assert.throws(()=>ui.fileInfo({name:'old.doc',size:1},'resume'));
 assert.match(ui.markup('resume'),/Previous résumés are kept/);assert.match(ui.markup('resume'),/aria-live="polite"/);
});
function harness(){
 const controls=[],listeners={},calls=[];let current=true,refreshes=0,sessionId=id,stageHook=null;
 const window={soroCurrentAccess:{...access},SORO_SUPABASE_CONFIG:{url:'https://unit.supabase.co'},crypto:require('node:crypto').webcrypto,addEventListener:(n,f)=>listeners[n]=f,soroSupabase:{auth:{getSession:async()=>({data:{session:{access_token:'unit-token',user:{id:sessionId}}}})}}};
 function add(kind){const handlers={},input={files:[],value:'',addEventListener:(n,f)=>handlers[n]=f,click(){}},button={disabled:false,addEventListener(){}},status={textContent:''};controls.push({dataset:{selfUpload:kind},input,button,status,handlers,querySelector:s=>s==='input'?input:s==='button'?button:status});}
 const scope={isConnected:true,querySelector:s=>s==='[data-self-upload]'?controls[0]:s==='.headshot-wrap'?{insertAdjacentHTML:()=>add('profile_photo')}:s==='[data-profile-resume]'?{insertAdjacentHTML:()=>add('resume')}:null,querySelectorAll:()=>controls};
 window.fetch=async(url,opts)=>{
  const body=typeof opts.body==='string'?JSON.parse(opts.body):null;const stage=body?.action||'put';calls.push({stage,url,opts});await stageHook?.(stage);
  if(stage==='prepare')return Response.json({fileId:id,url:'https://unit.supabase.co/storage/v1/object/upload/sign/soro-private-documents/applicants/own/resume.pdf?token=test'});
  return Response.json({documentId:id});
 };
 vm.runInNewContext(read('operations/talent-self-uploads.js'),{window,URL,AbortSignal,AbortController});
 const api=window.SoroTalentSelfUploads;api.mount(scope,applicant,{isCurrent:()=>current,onUploaded:async()=>{refreshes++;}});
 const upload=async(index=1,file={name:'new.pdf',type:'application/pdf',size:9})=>{controls[index].input.files=[file];return controls[index].handlers.change();};
 return {api,window,listeners,calls,controls,scope,upload,get refreshes(){return refreshes;},setCurrent:v=>current=v,setSession:v=>sessionId=v,setHook:f=>stageHook=f};
}
test('successful upload verifies and attaches before refreshing the existing profile without rerendering',async()=>{
 const h=harness();await h.upload();assert.deepEqual(h.calls.map(x=>x.stage),['prepare','put','complete']);assert.equal(h.refreshes,1);
 assert.match(h.controls[1].status.textContent,/Previous résumés are still/);assert.equal(h.controls[1].input.value,'');
 assert.equal(h.calls[1].opts.headers['x-upsert'],'false');assert.ok(h.controls.every(c=>!c.button.disabled));
 assert.equal(h.api.mount(h.scope,applicant,{isCurrent:()=>true}),false);
});
test('stale actual auth token is rejected even before the auth-changed UI event',async()=>{
 const h=harness();h.setSession('other-user');await h.upload();assert.equal(h.calls.length,0);assert.equal(h.refreshes,0);assert.match(h.controls[1].status.textContent,/Sign in again/);
});
test('auth or route change mid upload prevents completion and stale profile painting',async()=>{
 for(const change of ['auth','route']){const h=harness();h.setHook(stage=>{if(stage==='put'){if(change==='auth'){h.window.soroCurrentAccess={...access,user_id:'other'};h.listeners['soro-auth-changed']();}else h.setCurrent(false);}});await h.upload();assert.deepEqual(h.calls.map(c=>c.stage),['prepare','put']);assert.equal(h.refreshes,0);}
});
test('invalid file never starts a network request and can be retried with a valid file',async()=>{
 const h=harness();await h.upload(1,{name:'fake.exe',type:'',size:8});assert.equal(h.calls.length,0);await h.upload();assert.equal(h.refreshes,1);
});
test('pending upload blocks a duplicate submission and reenables controls afterward',async()=>{
 const h=harness();let release;h.setHook(stage=>stage==='prepare'?new Promise(r=>release=r):null);const first=h.upload();await new Promise(r=>setImmediate(r));assert.ok(h.controls.every(c=>c.button.disabled));await h.upload();assert.equal(h.calls.length,1);release();await first;assert.equal(h.refreshes,1);assert.ok(h.controls.every(c=>!c.button.disabled));
});
test('signed upload destinations are constrained to the configured private bucket',()=>{
 const h=harness();for(const url of ['https://evil.example/storage/v1/object/upload/sign/soro-private-documents/a','https://unit.supabase.co/storage/v1/object/upload/sign/public/a'])assert.throws(()=>h.api.uploadURL(url));
});
test('integration preserves staff restrictions and chooses latest non-rejected resume/photo',()=>{
 const source=read('operations/operations-enhancements.js');assert.match(source,/removeOwnProfileManagementActions\(root\);\s*window\.SoroTalentSelfUploads\?\.mount/);assert.match(source,/onUploaded: \(\) => loadTalentProfileDocuments\(\)/);
 assert.match(source,/Previous résumés/);assert.match(source,/classifyDocument\(d\) === 'profile_photo' && d.status !== 'rejected'/);assert.match(source,/order\('created_at', \{ ascending: false \}\)\.order\('id', \{ ascending: false \}\)/);
 const sql=read('supabase/migrations/20260908_052_talent_self_uploads.sql');assert.doesNotMatch(sql,/delete from|update public\.documents|create policy/i);assert.match(sql,/grant execute on function public\.talent_self_upload\(uuid,jsonb\) to service_role/);assert.match(sql,/role='virtual_assistant'/);assert.match(sql,/for share/);assert.match(sql,/unique\(uploader_id,request_id\)/);
});
