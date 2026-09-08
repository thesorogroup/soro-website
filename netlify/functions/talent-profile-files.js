'use strict';
const {fail,service,actor,uuid,json}=require('./lib/portal-service');
const {_test:files}=require('./document-center');
const RULES={profile_photo:{max:5242880,types:['image/jpeg','image/png']},resume:{max:10485760,types:['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document']}};
function validate(body){
 if(!body||typeof body!=='object'||Array.isArray(body)||!['prepare','complete'].includes(body.action))throw fail(400,'Choose a headshot or résumé upload.');
 const allowed=body.action==='prepare'?['action','requestId','kind','name','type','size']:['action','fileId'];
 if(Object.keys(body).some(k=>!allowed.includes(k)))throw fail(400,'Unexpected upload field.');
 if(body.action==='complete'){if(!uuid(body.fileId))throw fail(400,'Choose a valid upload.');return body;}
 if(!uuid(body.requestId)||!Object.hasOwn(RULES,body.kind))throw fail(400,'Choose a headshot or résumé upload.');
 const rule=RULES[body.kind];
 if(!rule.types.includes(body.type)||!Number.isInteger(body.size)||body.size<1||body.size>rule.max||typeof body.name!=='string'||!body.name.trim()||body.name.length>180||/[\x00-\x1f\x7f/\\]/.test(body.name))throw fail(400,'Use JPG or PNG up to 5 MB for a headshot; PDF or DOCX up to 10 MB for a résumé.');
 const ext=body.name.split('.').pop().toLowerCase();
 if(({jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'})[ext]!==body.type)throw fail(400,'The file extension does not match its format.');
 return body;
}
async function rpc(user,body){
 const res=await service('/rest/v1/rpc/talent_self_upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p_actor_user_id:user,p_body:body})});
 const v=await res.json().catch(()=>null);
 if(!res.ok)throw fail(v?.code==='42501'?403:v?.code==='23505'?409:v?.code==='P0001'?429:['22023','23514','22P02','23502','22003'].includes(v?.code)?400:503,v?.code==='42501'?'Only your own active Talent profile can receive this upload.':v?.code==='P0001'?'Please wait before uploading more files.':v?.code==='23505'?'That upload changed. Choose the file again.':['22023','23514','22P02','23502','22003'].includes(v?.code)?'The upload is invalid or expired. Choose the file again.':'The upload service is temporarily unavailable.');
 if(!uuid(v?.fileId)||!Object.hasOwn(RULES,v?.kind)||!RULES[v.kind].types.includes(v.type)||!Number.isInteger(v.size)||v.size<1||v.size>RULES[v.kind].max||v.bucket!=='soro-private-documents')throw fail(503,'The upload could not be verified.');
 return v;
}
async function handler(event){
 if(event.httpMethod!=='POST')return json(405,{message:'Method not allowed.'});
 try{
  const user=await actor(event);
  if(Object.keys(event.queryStringParameters||{}).length||event.isBase64Encoded||typeof event.body!=='string'||Buffer.byteLength(event.body)>4000)throw fail(400,'Invalid upload request.');
  let body;try{body=JSON.parse(event.body);}catch{throw fail(400,'Invalid upload request.');}validate(body);
  if(body.action==='prepare'){
   const f=await rpc(user,body);
   if(f.documentId)return json(200,{fileId:f.fileId,complete:true});
   const res=await service('/storage/v1/object/upload/sign/'+files.pathFor(f),{method:'POST',headers:{'Content-Type':'application/json','x-upsert':'false'},body:'{}'});
   const v=await res.json().catch(()=>null);if(!res.ok||!v?.url)throw fail(503,'The upload could not be started. Try again.');
   return json(200,{fileId:f.fileId,url:files.storageURL(v.url,'upload/sign')});
  }
  const f=await rpc(user,{action:'get',fileId:body.fileId});
  if(f.documentId)return json(200,{fileId:f.fileId,documentId:f.documentId});
  const res=await service('/storage/v1/object/'+files.pathFor(f),{signal:AbortSignal.timeout(35000)});
  const bytes=await files.readBounded(res,f.size),sha256=files.verifyBytes(bytes,f.type);
  const done=await rpc(user,{action:'finalize',fileId:f.fileId,sha256,type:f.type,size:bytes.length});
  if(!uuid(done.documentId))throw fail(503,'The file could not be attached. Retry the upload.');
  return json(200,{fileId:f.fileId,documentId:done.documentId});
 }catch(error){return json(error.status||503,{message:error.status?error.message:'The upload service is temporarily unavailable.'});}
}
module.exports={handler,validate,RULES};
