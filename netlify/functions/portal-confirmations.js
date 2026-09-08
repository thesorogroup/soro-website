'use strict';
const {rpc}=require('./lib/portal-service');
const {content,SENDER}=require('./lib/confirmation-email');
async function dispatch(row,dependencies={rpc:(name,body)=>rpc(name,body,4000),fetch:globalThis.fetch},key=process.env.RESEND_API_KEY) {
  const finish=(outcome,id=null,error=null)=>dependencies.rpc('complete_confirmation',{p_outbox_id:row.outboxId,p_lease_token:row.leaseToken,p_outcome:outcome,p_provider_message_id:id,p_error_code:error});
  let body;
  try {
    // Prepared deliveries, including greetings, remain byte-identical on retry.
    const person=row.requestBody?{}:await dependencies.rpc('get_confirmation_greeting',{p_outbox_id:row.outboxId,p_lease_token:row.leaseToken});
    const proposed=row.requestBody||JSON.stringify({from:SENDER,to:[row.to],...content(row.eventType,row.payload,person||{})});
    body=await dependencies.rpc('prepare_confirmation',{p_outbox_id:row.outboxId,p_lease_token:row.leaseToken,p_request_body:proposed});
    if(typeof body!=='string')throw new Error('Invalid prepared body');
  }catch{return 'not_prepared';} // Never send without a durable snapshot/lease.
  try {
    const response=await dependencies.fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json','Idempotency-Key':`soro-confirmation/${row.outboxId}`},body,signal:AbortSignal.timeout(5000)});
    const result=await response.json().catch(()=>null);
    if(response.ok&&/^[a-zA-Z0-9_-]{1,200}$/.test(result?.id||'')){await finish('sent',result.id);return 'accepted';}
    const retry=response.ok||[408,425,429].includes(response.status)||response.status>=500||result?.name==='concurrent_idempotent_requests';
    await finish(retry?'retry':'review',null,retry?'provider_unconfirmed':'provider_rejected');
    return retry?'retry':'review';
  }catch{await finish('retry',null,'delivery_unconfirmed').catch(()=>{});return 'retry';}
}
async function handler() {
  // Production-only opt-in; the sender is pinned in the template and database.
  // Keep one compact flag within Lambda's shared environment size limit.
  if(process.env.SORO_RECEIPTS!=='1'||!process.env.RESEND_API_KEY)return {statusCode:200,body:'Confirmations disabled'};
  const rows=await rpc('claim_confirmation_outbox',{p_limit:3},4000);
  await Promise.all(rows.map(row=>dispatch(row)));
  return {statusCode:200,body:'Confirmation batch processed'};
}
module.exports={handler,dispatch};
