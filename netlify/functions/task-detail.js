'use strict';
const {actor,rpc,uuid,json,fail}=require('./lib/portal-service');
const {publicPayload,publicTask,publicAssignee}=require('./tasks');
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
function validate(body){
 if(!body||typeof body!=='object'||Array.isArray(body))throw fail(400,'Invalid task request.');
 if(['workspace'].includes(body.action)){if(!exact(body,['action']))throw fail(400,'Unsupported task fields.');return body;}
 if(['get','view'].includes(body.action)){if(!exact(body,['action','taskId'])||!uuid(body.taskId))throw fail(400,'Choose a valid task.');return body;}
 const create=body.action==='create';
 if(!['save','create'].includes(body.action)||!exact(body,create?['action','requestId','patch']:['action','requestId','taskId','expectedVersion','patch'])||!uuid(body.requestId)||(!create&&(!uuid(body.taskId)||!Number.isSafeInteger(body.expectedVersion)||body.expectedVersion<1)))throw fail(400,'The task request is incomplete.');
 const p=body.patch,allowed=new Set(['title','details','relatedLabel','dueDate','priority','assigneeIds','progress','note','response','closeRequest']);
 if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!allowed.has(k)))throw fail(400,'Unsupported task fields.');
 for(const [k,max] of Object.entries({title:160,details:4000,relatedLabel:200,note:2000,response:4000}))if(k in p&&(typeof p[k]!=='string'||p[k].length>max||(k==='title'&&!p[k].trim())))throw fail(400,`Check ${k}.`);
 if('assigneeIds'in p&&(!Array.isArray(p.assigneeIds)||p.assigneeIds.length<1||p.assigneeIds.length>30||p.assigneeIds.some(id=>!uuid(id))||new Set(p.assigneeIds).size!==p.assigneeIds.length))throw fail(400,'Choose 1–30 different assignees.');
 if('priority'in p&&!['low','normal','high','urgent'].includes(p.priority))throw fail(400,'Choose a valid priority.');
 if('progress'in p&&!['not_started','in_progress','blocked','completed'].includes(p.progress))throw fail(400,'Choose a valid status.');
 if('dueDate'in p&&p.dueDate!==null&&!require('./tasks').validDate(p.dueDate))throw fail(400,'Choose a valid due date.');
 if('closeRequest'in p&&p.closeRequest!==true)throw fail(400,'Invalid close action.');
 if(create&&!['title','details','relatedLabel','dueDate','priority','assigneeIds'].every(k=>Object.hasOwn(p,k)))throw fail(400,'Complete the task details.');
 return body;
}
function detail(value){
 if(!value||!Array.isArray(value.assignees)||value.assignees.length>500||!Array.isArray(value.history)||value.history.length>200)throw fail(502,'Invalid task response.');
 return {task:publicTask(value.task),assignees:value.assignees.map(publicAssignee),history:value.history.map(h=>{if(typeof h.actor!=='string'||h.actor.length>180||!Number.isFinite(Date.parse(h.at))||typeof h.summary!=='string'||h.summary.length>600||(h.note!==null&&typeof h.note!=='string')||String(h.note||'').length>4000)throw fail(502,'Invalid task history.');return {actor:h.actor,at:h.at,summary:h.summary,note:h.note};})};
}
async function handler(event){
 if(event.httpMethod!=='POST')return json(405,{message:'Method not allowed.'});
 try{
  if(Object.keys(event.queryStringParameters||{}).length||event.rawQueryString||Object.keys(event.multiValueQueryStringParameters||{}).length)throw fail(400,'Unsupported task scope.');
  if(event.isBase64Encoded||Buffer.byteLength(event.body||'')>24000)throw fail(413,'Task request too large.');
  let body;try{body=JSON.parse(event.body||'{}');}catch{throw fail(400,'Invalid task request.');}validate(body);
  const id=await actor(event);
  if(body.action==='workspace')return json(200,publicPayload(await rpc('get_applicant_task_workspace',{p_actor_user_id:id})));
  const value=await rpc('task_detail',{p_actor_user_id:id,p_task_id:body.taskId||null,p_action:body.action,p_expected_version:body.expectedVersion||null,p_request_id:body.requestId||null,p_patch:body.patch||{}});
  return json(200,detail(value));
 }catch(e){const status=e.status||500;return json(status,{message:status===403?'This task is unavailable for your account.':status===409?'This task changed. Close and reopen it before saving again.':status>=500?'The task service is temporarily unavailable. Please try again.':e.message});}
}
module.exports={handler,validate,detail};
