'use strict';
const {rpc}=require('./lib/portal-service');
const {content}=require('./lib/interview-reminder-email');
async function dispatch(row,dependencies={rpc:(name,body)=>rpc(name,body,3500),fetch:globalThis.fetch},key=process.env.RESEND_API_KEY) {
  const finish=(outcome,id=null,error=null)=>dependencies.rpc('complete_interview_reminder',{p_outbox_id:row.outboxId,p_lease_token:row.leaseToken,p_outcome:outcome,p_provider_message_id:id,p_error_code:error});
  let body;
  try {
    const proposed=row.requestBody||JSON.stringify({...content(row.payload),to:[row.to]});
    body=await dependencies.rpc('prepare_interview_reminder',{p_outbox_id:row.outboxId,p_lease_token:row.leaseToken,p_request_body:proposed});
    if(typeof body!=='string')return 'cancelled';
  }catch{await finish('review',null,'preparation_failed').catch(()=>{});return 'not_prepared';}
  try {
    const response=await dependencies.fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json','Idempotency-Key':`soro-interview/${row.outboxId}`},body,signal:AbortSignal.timeout(5000)});
    const data=await response.json().catch(()=>null);
    if(response.ok&&/^[a-zA-Z0-9_-]{1,200}$/.test(data?.id||'')){await finish('sent',data.id);return 'accepted';}
    const retry=response.ok||[408,425,429].includes(response.status)||response.status>=500||data?.name==='concurrent_idempotent_requests';
    await finish(retry?'retry':'review',null,retry?'provider_unconfirmed':'provider_rejected');return retry?'retry':'review';
  }catch{await finish('retry',null,'delivery_unconfirmed').catch(()=>{});return 'retry';}
}
async function handler() {
  // The scheduled designation prevents public HTTP invocation. Separately opt in
  // only the production Functions context; local/preview Run now stays inert.
  if(process.env.SORO_INTERVIEWS!=='production')return {statusCode:200,body:'Interview follow-through disabled'};
  let taskFailure=false;
  try{await rpc('reconcile_interview_result_tasks',{p_limit:100},4000);}catch{taskFailure=true;}
  if(process.env.RESEND_API_KEY){
    const rows=await rpc('claim_interview_reminders',{p_limit:3},3500);
    await Promise.all(rows.map(row=>dispatch(row)));
  }
  return {statusCode:taskFailure?500:200,body:taskFailure?'Interview task reconciliation needs attention; reminder processing attempted':'Interview follow-through processed'};
}
module.exports={handler,dispatch};
