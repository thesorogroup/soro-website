'use strict';
const {actor,service,json,uuid,fail}=require('./lib/portal-service');
const TYPES=Object.freeze(['assessment','english_proof','disc_assessment','enneagram_assessment','mbti_assessment']);
const KEYS=['requestId','applicantId','documentId','expectedType','expectedUpdatedAt','documentType'];
const timestamp=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value));
function input(event){
 if(event.isBase64Encoded||typeof event.body!=='string'||event.rawQueryString
  ||Object.keys(event.queryStringParameters||{}).length||Object.keys(event.multiValueQueryStringParameters||{}).length)throw fail(400,'Only assessment classification details are accepted.');
 if(Buffer.byteLength(event.body)>4096)throw fail(413,'The request is too large.');
 let value;try{value=JSON.parse(event.body);}catch{throw fail(400,'The request could not be read.');}
 if(!value||Array.isArray(value)||Object.keys(value).length!==KEYS.length||!KEYS.every(k=>Object.hasOwn(value,k))
  ||!uuid(value.requestId)||!uuid(value.applicantId)||!uuid(value.documentId)||!timestamp(value.expectedUpdatedAt)
  ||!TYPES.includes(value.expectedType)||!TYPES.includes(value.documentType))throw fail(400,'Choose a valid assessment type.');
 return {p_request_id:value.requestId.toLowerCase(),p_applicant_id:value.applicantId.toLowerCase(),p_document_id:value.documentId.toLowerCase(),p_expected_type:value.expectedType,p_expected_updated_at:value.expectedUpdatedAt,p_document_type:value.documentType};
}
async function handler(event){
 if(event.httpMethod!=='POST'){const result=json(405,{message:'Method not allowed.'});result.headers.Allow='POST';return result;}
 try{
  const body=input(event),userId=await actor(event);
  const response=await service('/rest/v1/rpc/classify_talent_assessment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p_actor_user_id:userId,...body})});
  const payload=await response.json().catch(()=>null);
  if(!response.ok){
   if(payload?.code==='42501')throw fail(403,'This file cannot be classified here. Active Admin or Talent Management access is required; shared Document Center records use their own controls.');
   if(payload?.code==='40001')throw fail(409,'This file changed. Close this window and reopen Change Assessment Type before saving again.');
   if(['22023','22007','22008'].includes(payload?.code))throw fail(400,'Choose a valid assessment type.');
   throw fail(503,'Assessment classification is temporarily unavailable. Please try again.');
  }
  if(payload?.documentId!==body.p_document_id||payload?.applicantId!==body.p_applicant_id
   ||payload?.documentType!==body.p_document_type||!timestamp(payload?.updatedAt))throw fail(502,'The saved classification could not be confirmed. Refresh the profile before trying again.');
  return json(200,{documentId:payload.documentId,applicantId:payload.applicantId,documentType:payload.documentType,updatedAt:payload.updatedAt});
 }catch(error){const status=[400,401,403,409,413,502,503].includes(error.status)?error.status:503;return json(status,{message:error.status?error.message:'Assessment classification is temporarily unavailable. Please try again.'});}
}
module.exports={handler,input,TYPES,timestamp};
