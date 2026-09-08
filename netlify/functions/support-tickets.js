'use strict';
const crypto=require('node:crypto');
const {fail,service,rpc,actor,uuid,json,config}=require('./lib/portal-service');
const MAX_IMAGE_BYTES=3*1024*1024;
const AREAS=['Sign-in and account access','Talent profiles and documents','Client records and placements','Tasks and notifications','Other technical issue'];
function exact(value,keys) {return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));}
function parseImage(image) {
  if(image==null)return null;
  if(!exact(image,['dataBase64','type'])||typeof image.dataBase64!=='string'||!image.dataBase64||image.dataBase64.length>Math.ceil(MAX_IMAGE_BYTES/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.dataBase64))throw fail(400,'Choose a PNG, JPG, or WebP image up to 3 MB.');
  const bytes=Buffer.from(image.dataBase64,'base64');
  let type='',extension='';
  if(bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.toString('ascii',12,16)==='IHDR'){type='image/png';extension='png';}
  else if(bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255&&bytes[bytes.length-2]===255&&bytes[bytes.length-1]===217){type='image/jpeg';extension='jpg';}
  else if(bytes.length>=20&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'&&bytes.readUInt32LE(4)+8===bytes.length){type='image/webp';extension='webp';}
  if(!type||image.type!==type||bytes.length>MAX_IMAGE_BYTES)throw fail(400,'The file is not a supported image. Choose a PNG, JPG, or WebP up to 3 MB.');
  return {bytes,type,extension,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
}
function parseSubmission(event) {
  if(event.isBase64Encoded||typeof event.body!=='string'||Buffer.byteLength(event.body)>4300000)throw fail(413,'The ticket is too large. Use an image up to 3 MB.');
  let body;try{body=JSON.parse(event.body);}catch{throw fail(400,'Enter a valid ticket.');}
  if(!exact(body,['requestId','subject','area','details','image'])||!uuid(body.requestId))throw fail(400,'Start a new support ticket.');
  body.requestId=body.requestId.toLowerCase();
  for(const [key,min,max] of [['subject',3,120],['details',5,5000]]) {
    if(typeof body[key]!=='string'||body[key].trim().length<min||body[key].trim().length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(body[key]))throw fail(400,`Enter ${key} between ${min} and ${max} characters.`);
    body[key]=body[key].trim();
  }
  if(!AREAS.includes(body.area))throw fail(400,'Choose an available support area.');
  return {...body,image:parseImage(body.image)};
}
async function handler(event) {
  if(!['GET','POST'].includes(event.httpMethod))return json(405,{message:'Method not allowed.'});
  try {
    const userId=await actor(event),query=event.queryStringParameters||{};
    if(event.httpMethod==='GET') {
      if(Object.keys(query).some(key=>key!=='imageTicketId'))throw fail(400,'Unsupported request.');
      if(query.imageTicketId) {
        if(!uuid(query.imageTicketId))throw fail(400,'Choose a valid ticket.');
        const image=await rpc('get_support_ticket_image',{p_actor_user_id:userId,p_ticket_id:query.imageTicketId});
        if(!image?.storagePath)throw fail(404,'No screenshot is attached to this ticket.');
        const response=await service(`/storage/v1/object/sign/soro-support-images/${image.storagePath.split('/').map(encodeURIComponent).join('/')}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expiresIn:60})});
        const result=await response.json().catch(()=>null);
        if(!response.ok||typeof result?.signedURL!=='string')throw fail(503,'The screenshot could not be opened.');
        return json(200,{url:`${config().url}/storage/v1${result.signedURL}`});
      }
      return json(200,await rpc('get_support_tickets',{p_actor_user_id:userId}));
    }
    if(Object.keys(query).length)throw fail(400,'Unsupported request.');
    const body=parseSubmission(event);
    const access=await rpc('authorize_support_image_upload',{p_actor_user_id:userId});
    if(!uuid(access?.organizationId)||access.requesterUserId!==userId)throw fail(403,'Support access is unavailable.');
    if(body.image) {
      const path=`organizations/${access.organizationId}/support/${userId}/${body.requestId}/${body.image.sha256}.${body.image.extension}`;
      const response=await service(`/storage/v1/object/soro-support-images/${path}`,{method:'POST',headers:{'Content-Type':body.image.type,'x-upsert':'false'},body:body.image.bytes});
      if(!response.ok) {
        const result=await response.json().catch(()=>null);
        // Only a content-addressed exact-path duplicate is safe on retries.
        if(![409,'409'].includes(result?.statusCode)&&response.status!==409&&result?.error!=='Duplicate')throw fail(503,'The screenshot could not be saved. Your ticket has not been submitted yet; please retry.');
      }
    }
    const ticket=await rpc('create_support_ticket',{p_actor_user_id:userId,p_request_id:body.requestId,p_subject:body.subject,p_area:body.area,p_details:body.details,p_image_sha256:body.image?.sha256||null,p_image_content_type:body.image?.type||null,p_image_byte_size:body.image?.bytes.length||null});
    if(!uuid(ticket?.ticketId)||!/^SUP-[A-F0-9]{8}$/.test(ticket?.ticketNumber||'')||typeof ticket?.hasImage!=='boolean')throw fail(503,'The receipt could not be verified. Retry this same ticket to check its status safely.');
    return json(200,ticket);
  }catch(error){return json(error.status||503,{message:error.status?error.message:'Support is temporarily unavailable. Please retry the same ticket.'});}
}
module.exports={handler,parseImage,parseSubmission,MAX_IMAGE_BYTES,AREAS};
