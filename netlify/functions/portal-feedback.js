'use strict';
const {actor,service,json,uuid,fail}=require('./lib/portal-service');
const TYPES=['suggestion','experience','general'];
function exact(v,keys){return Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k)));}
function parseBody(event){
  if(event.isBase64Encoded||typeof event.body!=='string'||Buffer.byteLength(event.body)>20000)throw fail(400,'Enter valid feedback.');
  let b;try{b=JSON.parse(event.body);}catch{throw fail(400,'Enter valid feedback.');}
  if(event.httpMethod==='PATCH'){
    if(!exact(b,['id'])||!uuid(b.id))throw fail(400,'Choose valid feedback.');return{id:b.id.toLowerCase()};
  }
  if(!exact(b,['requestId','category','message'])||!uuid(b.requestId)||!TYPES.includes(b.category)||typeof b.message!=='string'||b.message.trim().length<3||b.message.trim().length>4000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(b.message))throw fail(400,'Choose a feedback type and enter 3–4,000 characters.');
  return{requestId:b.requestId.toLowerCase(),category:b.category,message:b.message.trim()};
}
async function feedbackRpc(name,body){
  const response=await service(`/rest/v1/rpc/${name}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json().catch(()=>null);
  if(!response.ok){
    if(data?.code==='42501')throw fail(403,'This account cannot access or review that feedback.');
    if(data?.code==='23505')throw fail(409,'This submission changed. Start a new feedback submission.');
    if(data?.code==='22023'||data?.code==='23514')throw fail(400,'Check your feedback and try again.');
    if(data?.code==='P0001'&&data.message==='feedback_rate_limit')throw fail(429,'Please wait before sending more feedback. Your earlier submissions are saved.');
    throw fail(503,'Feedback is temporarily unavailable. Please try again.');
  }
  return data;
}
async function handler(event){
  if(!['GET','POST','PATCH'].includes(event.httpMethod))return json(405,{message:'Method not allowed.'});
  try{
    const userId=await actor(event),query=event.queryStringParameters||{};
    if(event.httpMethod==='GET'){
      if(Object.keys(query).some(k=>k!=='offset')||!/^\d{1,7}$/.test(query.offset||'0')||Number(query.offset||0)>1000000)throw fail(400,'Choose a valid page.');
      const data=await feedbackRpc('list_portal_feedback',{p_actor_user_id:userId,p_offset:Number(query.offset||0)});
      if(!Array.isArray(data?.items)||data.items.length>25||typeof data.canReview!=='boolean'||typeof data.hasMore!=='boolean')throw fail(503,'Feedback could not be loaded. Please refresh.');
      return json(200,data);
    }
    if(Object.keys(query).length)throw fail(400,'Unsupported request.');
    const b=parseBody(event),data=event.httpMethod==='POST'
      ?await feedbackRpc('submit_portal_feedback',{p_actor_user_id:userId,p_request_id:b.requestId,p_category:b.category,p_message:b.message})
      :await feedbackRpc('review_portal_feedback',{p_actor_user_id:userId,p_feedback_id:b.id});
    if(!uuid(data?.id)||(event.httpMethod==='PATCH'&&data.id!==b.id))throw fail(503,'Your receipt could not be verified. Please retry the same action safely.');
    return json(200,{id:data.id});
  }catch(error){return json(error.status||503,{message:error.status?error.message:'Feedback is temporarily unavailable. Please try again.'});}
}
module.exports={handler,parseBody,TYPES};
