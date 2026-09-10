'use strict';
const {actor,service,json,uuid,fail}=require('./lib/portal-service');
const KINDS=['all','talent','client','employee','placement','document','task','support'];
const CATEGORIES=['profile','review','ownership','access','workflow','files','tasks','support','attendance'];
function queryFilters(q={}){
 if(Object.keys(q).some(k=>!['kind','id','search','category','recordType','actor','from','to','offset','asOf'].includes(k))||Object.values(q).some(v=>typeof v!=='string')||!KINDS.includes(q.kind))throw fail(400,'Choose an available activity record.');
 if(q.kind==='all'?Boolean(q.id):!uuid(q.id)&&!(q.kind==='client'&&q.id==='self'))throw fail(400,'Choose a valid record.');
 if((q.search||'').length>120||/[\u0000-\u001f]/.test(Object.values(q).join(''))||q.category&&!CATEGORIES.includes(q.category)||q.recordType&&!KINDS.slice(1).includes(q.recordType)||q.actor&&!uuid(q.actor)||!/^\d{1,7}$/.test(q.offset||'0')||Number(q.offset||0)>1000000)throw fail(400,'Check the activity filters.');
 for(const key of ['from','to'])if(q[key]&&(!/^\d{4}-\d{2}-\d{2}$/.test(q[key])||!Number.isFinite(Date.parse(q[key]+'T00:00:00Z'))||new Date(q[key]+'T00:00:00Z').toISOString().slice(0,10)!==q[key]))throw fail(400,'Choose valid activity dates.');
 if(q.from&&q.to&&q.from>q.to||q.asOf&&(!/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(q.asOf)||!Number.isFinite(Date.parse(q.asOf))))throw fail(400,'Check the date range.');
 const {kind,id,...filters}=q;return {kind,id:id==='self'?null:id||null,filters};
}
async function handler(event){
 if(event.httpMethod!=='GET')return json(405,{message:'Activity History is read-only.'});
 try {const user=await actor(event),q=queryFilters(event.queryStringParameters);const r=await service('/rest/v1/rpc/get_activity_history',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p_actor_user_id:user,p_kind:q.kind,p_entity_id:q.id,p_filters:q.filters})});const v=await r.json().catch(()=>null);if(!r.ok)throw fail(v?.code==='42501'?403:['22023','22007','22008'].includes(v?.code)?400:503,v?.code==='42501'?'This account cannot access that history.':'Activity History is temporarily unavailable.');if(!v?.subject||v.subject.kind!==q.kind||!Array.isArray(v.rows)||v.rows.length>30||!Number.isSafeInteger(v.total)||v.total<0)throw fail(503,'Activity History could not be verified.');return json(200,v);}catch(e){return json(e.status||503,{message:e.status?e.message:'Activity History is temporarily unavailable.'});}
}
module.exports={handler,queryFilters,KINDS,CATEGORIES};
