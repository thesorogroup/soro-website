'use strict';
const {rpc}=require('./lib/portal-service');
const {content}=require('./lib/applicant-request-email');
async function dispatch(row,dependencies={rpc:(name,body)=>rpc(name,body,3500),fetch:globalThis.fetch},key=process.env.RESEND_API_KEY){
 const finish=(outcome,id=null,error=null)=>dependencies.rpc('complete_applicant_request_email',{p_outbox_id:row.outboxId,p_lease_token:row.leaseToken,p_outcome:outcome,p_provider_message_id:id,p_error_code:error});
 let body;
 try{body=await dependencies.rpc('prepare_applicant_request_email',{p_outbox_id:row.outboxId,p_lease_token:row.leaseToken,p_request_body:row.requestBody||JSON.stringify({...content(row.payload),to:[row.to]})});if(typeof body!=='string')return 'cancelled';}
 catch{await finish('review',null,'preparation_failed').catch(()=>{});return 'not_prepared';}
 try{
  const response=await dependencies.fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json','Idempotency-Key':`soro-applicant-request/${row.outboxId}`},body,signal:AbortSignal.timeout(5000)});
  const result=await response.json().catch(()=>null);
  if(response.ok&&/^[a-zA-Z0-9_-]{1,200}$/.test(result?.id||'')){await finish('sent',result.id);return 'accepted';}
  const retry=response.ok||[408,425,429].includes(response.status)||response.status>=500||result?.name==='concurrent_idempotent_requests';await finish(retry?'retry':'review',null,retry?'provider_unconfirmed':'provider_rejected');return retry?'retry':'review';
 }catch{await finish('retry',null,'delivery_unconfirmed').catch(()=>{});return 'retry';}
}
async function handler(){
 // Separate explicit production opt-in. Local and preview runs cannot send mail.
 if(process.env.SORO_APPLICANT_TASKS!=='production'||!process.env.RESEND_API_KEY)return {statusCode:200,body:'Applicant request emails disabled'};
 const rows=await rpc('claim_applicant_request_emails',{p_limit:3},3500);await Promise.all(rows.map(row=>dispatch(row)));return {statusCode:200,body:'Applicant request email batch processed'};
}
module.exports={handler,dispatch};
