'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const api=require('../netlify/functions/talent-assessment-classification');
const editor=require('../operations/assessment-file-editor');
const id=n=>`f0000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const body=()=>({requestId:id(1),applicantId:id(11),documentId:id(80),expectedType:'assessment',expectedUpdatedAt:'2026-09-14T12:00:00.000Z',documentType:'disc_assessment'});
const event=payload=>({httpMethod:'POST',headers:{authorization:'Bearer fake'},body:JSON.stringify(payload)});
test('classification accepts only exact file metadata fields, never ownership or score changes',()=>{
 assert.equal(api.input(event(body())).p_document_type,'disc_assessment');
 for(const extra of ['actorId','organizationId','storagePath','status','score','clientId'])assert.throws(()=>api.input(event({...body(),[extra]:'injected'})));
 for(const value of ['resume','profile_photo','introduction_video','tax','application_attachment','internet_proof'])assert.throws(()=>api.input(event({...body(),documentType:value})));
 assert.throws(()=>api.input({...event(body()),rawQueryString:'applicantId=other'}));
 assert.throws(()=>api.input({...event(body()),isBase64Encoded:true}));
 assert.throws(()=>api.input(event({...body(),expectedUpdatedAt:'infinity'})));
});
test('UI offers only assessment types and escapes file labels',()=>{
 const html=editor.markup({file_name:'<img src=x onerror=alert(1)>',document_type:'assessment'});
 assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img/);assert.match(html,/View File/);assert.match(html,/privacy stay unchanged/);
 assert.deepEqual(Object.keys(editor.TYPES),api.TYPES);
 assert.equal(editor.eligible({document_type:'assessment',storage_path:'private/x',status:'uploaded'}),true);
 assert.equal(editor.eligible({document_type:'assessment',storage_path:'private/x',status:'rejected'}),false);
 assert.equal(editor.eligible({document_type:'tax',storage_path:'private/x',status:'uploaded'}),false);
});
test('endpoint authenticates server-side and returns minimal response with safe errors',async()=>{
 const original={fetch:global.fetch,url:process.env.SUPABASE_URL,key:process.env.SUPABASE_SERVICE_ROLE_KEY};
 process.env.SUPABASE_URL='https://test.supabase.co';process.env.SUPABASE_SERVICE_ROLE_KEY='sb_secret_fake';
 try{
  assert.equal((await api.handler({...event(body()),headers:{}})).statusCode,401);
  assert.equal((await api.handler({...event(body()),httpMethod:'GET'})).statusCode,405);
  let rpcBody;
  global.fetch=async(url,options)=>url.includes('/auth/')?new Response(JSON.stringify({id:id(2)})):((rpcBody=JSON.parse(options.body)),new Response(JSON.stringify({documentId:id(80),applicantId:id(11),documentType:'disc_assessment',updatedAt:body().expectedUpdatedAt,secret:'omit'})));
  const saved=await api.handler(event(body()));assert.equal(saved.statusCode,200);assert.equal(rpcBody.p_actor_user_id,id(2));assert.equal(JSON.parse(saved.body).secret,undefined);assert.equal(saved.headers['Cache-Control'],'no-store');
  for(const [code,status]of [['42501',403],['40001',409],['22023',400],['XX000',503]]){
   global.fetch=async url=>new Response(JSON.stringify(url.includes('/auth/')?{id:id(2)}:{code,message:'PRIVATE DATABASE DETAIL'}),{status:url.includes('/auth/')?200:400});
   const result=await api.handler(event(body()));assert.equal(result.statusCode,status);assert.doesNotMatch(result.body,/PRIVATE DATABASE/);
  }
 }finally{global.fetch=original.fetch;for(const [key,value]of [['SUPABASE_URL',original.url],['SUPABASE_SERVICE_ROLE_KEY',original.key]])if(value===undefined)delete process.env[key];else process.env[key]=value;}
});
function sandbox(){const c={parent:{postMessage(){}},document:{addEventListener(){}},history:{replaceState(){}},URL,Response,crypto:webcrypto,Date};c.window=c;vm.createContext(c);vm.runInContext(fs.readFileSync('operations/test-mode/runtime.js','utf8'),c);c.soroScreeningPresentation=require('../operations/screening-presentation');return c;}
test('sample classification updates evidence, preserves scores/files, blocks other roles and supports retry',async()=>{
 const c=sandbox(),s=c.SoroTestSession;s.select('talent');const d=s.store.documents[0],original=JSON.parse(JSON.stringify(d));
 const app=s.store.applicants[1];app.personality_profile_score='DISC: D 24, I 31, S 27, C 18';
 const before=s.queue().applicants[0].checklist.find(i=>i.key==='disc');assert.equal(before.evidenceState,'unclassified_available');
 const payload={...body(),expectedUpdatedAt:d.updated_at};const send=(b=payload)=>c.fetch('/.netlify/functions/talent-assessment-classification',{method:'POST',body:JSON.stringify(b)});
 assert.equal((await send()).status,200);assert.equal((await send()).status,200);assert.equal(s.store.classificationAudit.length,1);
 const after=s.queue().applicants[0].checklist.find(i=>i.key==='disc');assert.equal(after.evidenceState,'available');assert.equal(after.resultRecorded,before.resultRecorded);
 for(const key of Object.keys(original).filter(k=>!['document_type','updated_at'].includes(k)))assert.equal(d[key],original[key]);
 assert.equal((await send({...payload,requestId:id(99),documentType:'enneagram_assessment'})).status,409);
 for(const role of ['sales','client','va']){s.select(role);assert.equal((await send()).status,403);}
 s.select('talent');assert.equal((await c.fetch('https://thesorogroup.com/.netlify/functions/talent-assessment-classification',{method:'POST',body:JSON.stringify(payload)})).status,403);
 s.reset();assert.equal(s.store.documents[0].document_type,'assessment');assert.equal(s.store.classificationAudit.length,0);
});
