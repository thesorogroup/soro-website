'use strict';
const {createHash}=require('node:crypto');
const {fail,config,service,actor,uuid,json}=require('./lib/portal-service');
const MAX=10485760;
const MIME=['application/pdf','image/png','image/jpeg','application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
const ACTIONS={
 create_template:['requestId','title','team','audience','category','kind','instructions','fields','fileId'],
 create_packet:['requestId','title','description','templateIds'],retire:['requestId','kind','id'],
 assign:['requestId','packetId','subjectKind','subjectId','recipientId','dueDate'],
 submit:['requestId','id','expectedVersion','fileId','answers','acknowledge'],review:['requestId','id','expectedVersion','decision','note'],
 cancel:['requestId','id','expectedVersion'],prepare_upload:['requestId','purpose','itemId','name','type','size'],complete_upload:['fileId'],
 unlink_legacy:['requestId','id'],link_legacy:['requestId','id','subjectKind','subjectId','recipientId','category']
};
function validate(body){
 if(!body||typeof body!=='object'||Array.isArray(body)||!Object.hasOwn(ACTIONS,body.action))throw fail(400,'Choose a document action.');
 if(Object.keys(body).some(k=>k!=='action'&&!ACTIONS[body.action].includes(k)))throw fail(400,'Unexpected document field.');
 for(const key of ['requestId','id','packetId','subjectId','recipientId','fileId','itemId'])if(body[key]!=null&&!uuid(body[key]))throw fail(400,'Invalid document identifier.');
 if(body.action!=='complete_upload'&&!uuid(body.requestId))throw fail(400,'A request identifier is required.');
 if(['submit','review','cancel'].includes(body.action)&&(!uuid(body.id)||!Number.isInteger(body.expectedVersion)||body.expectedVersion<1||body.expectedVersion>2147483647))throw fail(400,'Refresh the request before saving.');
 if(body.action==='prepare_upload'){
  if(!['template','submission'].includes(body.purpose)||!MIME.includes(body.type)||!Number.isInteger(body.size)||body.size<1||body.size>MAX||typeof body.name!=='string'||!body.name.trim()||body.name.length>180||/[\x00-\x1f\x7f/\\]/.test(body.name))throw fail(400,'Choose a PDF, PNG, JPG, or DOCX up to 10 MB.');
  const ext=body.name.split('.').pop().toLowerCase();
  if(!({pdf:MIME[0],png:MIME[1],jpg:MIME[2],jpeg:MIME[2],docx:MIME[3]})[ext]||({pdf:MIME[0],png:MIME[1],jpg:MIME[2],jpeg:MIME[2],docx:MIME[3]})[ext]!==body.type)throw fail(400,'The file extension does not match its format.');
  if((body.purpose==='submission')!==uuid(body.itemId))throw fail(400,'Choose the document request for this upload.');
 }
 if(body.action==='complete_upload'&&!uuid(body.fileId))throw fail(400,'Choose a completed upload.');
 for(const[k,max]of Object.entries({title:160,instructions:4000,description:2000,note:2000}))if(body[k]!=null&&(typeof body[k]!=='string'||body[k].length>max))throw fail(400,'Document text is too long.');
 if(body.templateIds&&(!Array.isArray(body.templateIds)||!body.templateIds.length||body.templateIds.length>20||body.templateIds.some(x=>!uuid(x))))throw fail(400,'Choose up to 20 approved forms.');
 if(body.fields&&(!Array.isArray(body.fields)||body.fields.length>20))throw fail(400,'Choose up to 20 information fields.');
 if(body.dueDate!=null&&(!/^\d{4}-\d{2}-\d{2}$/.test(body.dueDate)||Number.isNaN(Date.parse(body.dueDate))||new Date(body.dueDate).toISOString().slice(0,10)!==body.dueDate))throw fail(400,'Choose a valid due date.');
 return body;
}
async function rpc(name,args){
 const res=await service('/rest/v1/rpc/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args)});
 const value=await res.json().catch(()=>null);
 if(!res.ok){const c=value?.code;throw fail(c==='42501'?403:['40001','23505'].includes(c)?409:['22023','23514','22P02','23502','22008'].includes(c)?400:503,c==='42501'?'This account cannot access that document action.':c==='40001'?'This request changed. Refresh it before saving again.':c==='23505'?'This request was already used. Refresh before retrying.':['22023','23514','22P02','23502','22008'].includes(c)?'Check the document fields, recipient, and current request status.':'The document service is temporarily unavailable.');}
 return value;
}
function pathFor(file){
 if(!['soro-document-center','soro-private-documents'].includes(file.bucket)||typeof file.path!=='string'||file.path.split('/').some(p=>!p||p==='.'||p==='..')||/[\\\x00-\x1f]/.test(file.path))throw fail(503,'The document storage reference is invalid.');
 return file.bucket+'/'+file.path.split('/').map(encodeURIComponent).join('/');
}
function storageURL(raw,kind){
 const base=config().url;const normalized=String(raw).startsWith('/object/')?'/storage/v1'+raw:raw;const url=new URL(normalized,base+'/storage/v1/');
 if(url.origin!==new URL(base).origin||!url.pathname.startsWith('/storage/v1/object/'+kind+'/'))throw fail(503,'The document link could not be created.');
 return url.href;
}
function verifyBytes(buf,mime){
 if(!Buffer.isBuffer(buf)||buf.length<4||buf.length>MAX)throw fail(400,'The uploaded document is invalid.');
 const valid=mime===MIME[0]?buf.subarray(0,5).toString()==='%PDF-':mime===MIME[1]?buf.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):mime===MIME[2]?buf[0]===255&&buf[1]===216&&buf[2]===255:mime===MIME[3]?buf.readUInt32LE(0)===0x04034b50&&buf.includes(Buffer.from('[Content_Types].xml'))&&buf.includes(Buffer.from('word/document.xml')):false;
 if(!valid)throw fail(400,'The file contents do not match the selected document format.');
 // File signatures are a format check, not an antivirus or signature-validity claim.
 return createHash('sha256').update(buf).digest('hex');
}
async function readBounded(res,expected){
 if(!res.ok)throw fail(400,'The upload is not available yet. Try again.');
 const length=Number(res.headers.get('content-length'));if(length>MAX||length>0&&length!==expected)throw fail(400,'The uploaded size does not match.');
 const reader=res.body.getReader();let size=0;const chunks=[];
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX||size>expected)throw fail(400,'The uploaded document is too large.');chunks.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});}
 if(size!==expected)throw fail(400,'The upload was incomplete.');return Buffer.concat(chunks);
}
async function handler(event){
 try{
  if(!['GET','POST'].includes(event.httpMethod))return json(405,{message:'Method not allowed.'});
  const user=await actor(event);
  if(event.httpMethod==='GET'){
   const q=event.queryStringParameters||{};
   if(Object.keys(q).some(k=>!['view','q','status','offset','filesOffset','subjectKind','subjectId','requestId','fileId','origin','recipients','notifications'].includes(k)))throw fail(400,'Invalid document filter.');
   if(q.fileId){if(!uuid(q.fileId)||!['center','legacy'].includes(q.origin||'center'))throw fail(400,'Invalid file.');const f=await rpc('document_center_file',{p_actor_user_id:user,p_id:q.fileId,p_origin:q.origin||'center'});const res=await service('/storage/v1/object/sign/'+pathFor(f),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expiresIn:60,download:f.name})});const v=await res.json();if(!res.ok||!v.signedURL)throw fail(503,'The file could not be opened.');return json(200,{url:storageURL(v.signedURL,'sign'),expiresIn:60});}
   if(q.requestId){if(!uuid(q.requestId))throw fail(400,'Invalid request.');return json(200,await rpc('document_center_detail',{p_actor_user_id:user,p_id:q.requestId}));}
   if(q.recipients==='1')return json(200,await rpc('document_center_recipients',{p_actor_user_id:user}));
   if(q.notifications==='1')return json(200,await rpc('document_center_notifications',{p_actor_user_id:user}));
   if(q.subjectId&&(!uuid(q.subjectId)||!['talent','client','employee'].includes(q.subjectKind)))throw fail(400,'Invalid profile.');
   return json(200,await rpc('document_center_workspace',{p_actor_user_id:user,p_query:q}));
  }
  if(event.isBase64Encoded||typeof event.body!=='string'||Buffer.byteLength(event.body)>60000)throw fail(400,'Document request is too large.');
  let body;try{body=JSON.parse(event.body);}catch{throw fail(400,'Invalid document request.');}validate(body);
  if(body.action==='prepare_upload'){
   const f=await rpc('document_center_upload',{p_actor_user_id:user,p_body:body});
   if(f.state==='ready')return json(409,{message:'This upload is already complete. Refresh the request.'});
   const res=await service('/storage/v1/object/upload/sign/'+pathFor(f),{method:'POST',headers:{'Content-Type':'application/json','x-upsert':'false'},body:'{}'});const v=await res.json();if(!res.ok||!v.url)throw fail(503,'The upload could not be started.');
   return json(200,{fileId:f.fileId,url:storageURL(v.url,'upload/sign')});
  }
  if(body.action==='complete_upload'){
   const f=await rpc('document_center_upload',{p_actor_user_id:user,p_body:{action:'get_upload',fileId:body.fileId}});
   const res=await service('/storage/v1/object/'+pathFor(f),{signal:AbortSignal.timeout(35000)});
   const bytes=await readBounded(res,f.size);const sha256=verifyBytes(bytes,f.type);
   await rpc('document_center_upload',{p_actor_user_id:user,p_body:{action:'finalize_upload',fileId:f.fileId,sha256,type:f.type,size:bytes.length}});
   return json(200,{fileId:f.fileId});
  }
  return json(200,await rpc('document_center_change',{p_actor_user_id:user,p_body:body}));
 }catch(e){return json(e.status||503,{message:e.status?e.message:'The document service is temporarily unavailable.'});}
}
exports.handler=handler;exports._test={validate,verifyBytes,storageURL,pathFor,readBounded};
