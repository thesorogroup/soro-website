'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {handler,_test:api}=require('../netlify/functions/document-center');
const ui=require('../operations/document-center');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const id='10000000-0000-4000-8000-000000000010';
test('document action allowlists reject injected authority and malformed values',()=>{
 for(const action of ['toString','__proto__','constructor','finalize_upload'])assert.throws(()=>api.validate({action}),/Choose a document action/);
 assert.throws(()=>api.validate({action:'cancel',requestId:id,id,expectedVersion:1,actorId:id}),/Unexpected/);
 assert.throws(()=>api.validate({action:'review',requestId:id,id,expectedVersion:Number.MAX_SAFE_INTEGER}),/Refresh/);
 assert.throws(()=>api.validate({action:'prepare_upload',requestId:id,purpose:'template',name:'../secret.pdf',type:'application/pdf',size:10}),/Choose/);
 assert.throws(()=>api.validate({action:'prepare_upload',requestId:id,purpose:'submission',name:'file.pdf',type:'application/pdf',size:10}),/request/);
 assert.throws(()=>api.validate({action:'prepare_upload',requestId:id,purpose:'template',name:'file.jpg',type:'application/pdf',size:10}),/extension/);
 assert.equal(api.validate({action:'unlink_legacy',requestId:id,id}).action,'unlink_legacy');
});
test('file content checking is bounded and refuses MIME impersonation',async()=>{
 assert.match(api.verifyBytes(Buffer.from('%PDF-1.7\n'),'application/pdf'),/^[a-f0-9]{64}$/);
 assert.throws(()=>api.verifyBytes(Buffer.from('<script>fake.pdf</script>'),'application/pdf'),/contents/);
 assert.throws(()=>api.verifyBytes(Buffer.alloc(10485761),'application/pdf'),/invalid/);
 assert.throws(()=>api.verifyBytes(Buffer.from('PK\x03\x04fake zip'),'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),/contents/);
 await assert.rejects(()=>api.readBounded(new Response('too big'),2),/large|size/);
 assert.equal((await api.readBounded(new Response('four'),4)).toString(),'four');
});
test('private storage URL normalization never accepts a foreign origin or unsafe object reference',()=>{
 const old=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;
 process.env.SUPABASE_URL='https://test.supabase.co';process.env.SUPABASE_SERVICE_ROLE_KEY='local-unit-test';
 try{
  assert.equal(api.storageURL('/object/sign/bucket/file?token=test','sign'),'https://test.supabase.co/storage/v1/object/sign/bucket/file?token=test');
  assert.match(api.storageURL('/object/upload/sign/bucket/file?token=test','upload/sign'),/storage\/v1\/object\/upload\/sign/);
  assert.throws(()=>api.storageURL('https://evil.example/object/sign/a','sign'),/link/);
  assert.throws(()=>api.pathFor({bucket:'public',path:'file'}),/reference/);
  assert.throws(()=>api.pathFor({bucket:'soro-private-documents',path:'a/../file'}),/reference/);
 }finally{if(old===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=old;if(key===undefined)delete process.env.SUPABASE_SERVICE_ROLE_KEY;else process.env.SUPABASE_SERVICE_ROLE_KEY=key;}
});
test('endpoint derives actor from verified token, not user-selected scope',async()=>{
 const oldFetch=global.fetch,env={url:process.env.SUPABASE_URL,key:process.env.SUPABASE_SERVICE_ROLE_KEY};
 process.env.SUPABASE_URL='https://test.supabase.co';process.env.SUPABASE_SERVICE_ROLE_KEY='local-unit-test';const calls=[];
 global.fetch=async(url,opts)=>{calls.push({url,opts});if(url.endsWith('/auth/v1/user'))return Response.json({id});return Response.json({internal:true,requests:[],files:[]});};
 try{
  const result=await handler({httpMethod:'GET',headers:{authorization:'Bearer verified-test'},queryStringParameters:{view:'mine'}});
  assert.equal(result.statusCode,200);assert.equal(JSON.parse(calls[1].opts.body).p_actor_user_id,id);
  assert.equal(result.headers['Cache-Control'],'no-store');
  const invalid=await handler({httpMethod:'POST',headers:{authorization:'Bearer verified-test'},body:JSON.stringify({action:'cancel',requestId:id,id,expectedVersion:1,actorId:id})});
  assert.equal(invalid.statusCode,400);assert.equal(calls.length,3);
 }finally{global.fetch=oldFetch;for(const[name,val]of [['SUPABASE_URL',env.url],['SUPABASE_SERVICE_ROLE_KEY',env.key]])if(val===undefined)delete process.env[name];else process.env[name]=val;}
});
test('UI escapes captured names, preserves external-source states and offers controlled classification',()=>{
 const html=ui.filesMarkup([{id,name:'<img src=x onerror=evil()>',category:'resume',origin:'legacy',canOpen:false,canClassify:true,reviewedShare:true}]);
 assert.doesNotMatch(html,/<img/);assert.match(html,/&lt;img/);assert.match(html,/External source/);assert.match(html,/data-dc-unshare/);
 assert.match(ui.filesMarkup([]),/No completed documents/);assert.doesNotMatch(ui.filesMarkup([]),/Sample|Mariel|Brightlane/);
});
function mountHarness(){
 const listeners={};const window={document:{visibilityState:'visible'},soroCurrentAccess:{user_id:id,role:'admin'},addEventListener:(n,f)=>listeners[n]=f,dispatchEvent:()=>{},crypto:require('node:crypto').webcrypto,CustomEvent:class{constructor(type){this.type=type;}}};
 const sandbox={window,AbortSignal,AbortController,URLSearchParams,FormData,console,setTimeout};vm.runInNewContext(read('operations/document-center.js'),sandbox);
 const host=()=>{const content={innerHTML:''},feedback={textContent:''};return{innerHTML:'',addEventListener(){},removeEventListener(){},querySelector:s=>s==='[data-dc-content]'?content:feedback,querySelectorAll:()=>[],content};};
 return{ui:window.SoroDocumentCenter,window,listeners,host};
}
test('an old mount cannot load its request in a new account or overwrite the new view',async()=>{
 const h=mountHarness(),one=h.host(),two=h.host();let resolve;const calls=[];
 h.ui.mount(one,{preview:true,requestId:'old-request',request:()=>new Promise(r=>resolve=r)});
 h.window.soroCurrentAccess.user_id='new-actor';
 h.ui.mount(two,{preview:true,request:async(method,body,q)=>{calls.push(q);return{internal:false,requests:[],files:[]};}});
 await new Promise(r=>setImmediate(r));resolve({internal:true,requests:[],files:[]});await new Promise(r=>setImmediate(r));
 assert.equal(calls.some(x=>x.includes('old-request')),false);assert.match(two.content.innerHTML,/You’re up to date/);h.ui.unmount();
});
test('new-center SQL retains originals, grants service-only RPCs and protects legacy direct reads',()=>{
 const sql=read('supabase/migrations/20260908_051_document_center.sql');
 assert.match(sql,/for select to authenticated\s+using\(private\.legacy_document_read_allowed/);
 assert.match(sql,/as restrictive for select/);assert.match(sql,/recipient_active=false/);assert.doesNotMatch(sql,/delete from public\.(documents|applicants|clients|platform_users)|delete from storage/i);
 assert.match(sql,/foreign key\(latest_submission_id,id\)/);assert.match(sql,/foreign key\(file_id,item_id\)/);
 assert.match(sql,/revoke all on function %s from public,anon,authenticated,service_role/);assert.match(sql,/grant execute on function %s to service_role/);
 assert.match(sql,/kind='print_sign'/);assert.match(sql,/No seed documents/);
});
test('all portal routes get the same Document Center without changing authenticated identity',()=>{
 const source=read('operations/operations.js');
 for(const role of ['admin','sales','sales_management','talent_management','billing','virtual_assistant','client_admin','client_reviewer','client_billing'])assert.match(source,new RegExp(role+":new Set\\(\\[[^\\]]*'documents'"));
 assert.match(source,/SoroDocumentCenter\?\.mount\(root,opts\)/);
 assert.match(read('operations/operations-enhancements.js'),/data-document-subject="\$\{escapeHtml\(a\.id\)\}"/);
 for(const file of ['operations/operations-enhancements.js','operations/admin-employee-management.js','operations/admin-payroll.js'])assert.match(read(file),/SoroDocumentCenter\?\.unmount/);
 assert.match(read('operations/task-center.js'),/setDocumentNotifications/);
 assert.doesNotMatch(source,/full_name:'Santos, Mariel Anne'|companyName:'Brightlane Medical'/);
});
