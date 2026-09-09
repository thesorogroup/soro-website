'use strict';
const {actor,service,json,uuid,fail}=require('./lib/portal-service');
const REPORTS=['sales','placements','talent','attendance','time_off','support','documents'];
const KEYS=['report','search','status','owner','team','area','from','to','population','flag','offset'];
function filters(query={}){
 if(Object.keys(query).some(k=>!KEYS.includes(k))||Object.values(query).some(v=>typeof v!=='string')||!REPORTS.includes(query.report))throw fail(400,'Choose an available report.');
 const f={};for(const k of KEYS)if(k!=='report'&&query[k]!==undefined)f[k]=query[k];
 if((f.search||'').length>120||(f.status||'').length>80||/[\u0000-\u001f]/.test(Object.values(f).join(''))||!/^\d{1,7}$/.test(f.offset||'0')||Number(f.offset||0)>1000000)throw fail(400,'Check the report filters.');
 if(f.owner&&f.owner!=='unassigned'&&!uuid(f.owner))throw fail(400,'Choose a valid owner.');
 if(f.team&&!['admin','sales','talent_management',...(query.report==='documents'?['billing']:[])].includes(f.team))throw fail(400,'Choose a valid team.');
 if((f.area||'').length>80||f.area&&!/^[a-z0-9_]+$/.test(f.area))throw fail(400,'Choose a valid work area.');
 if(f.population&&!['all','open'].includes(f.population)||f.population==='open'&&!['sales','support'].includes(query.report))throw fail(400,'Choose a valid population.');
 if(f.flag&&!['attention','unassigned','upcoming','overdue','ready'].includes(f.flag))throw fail(400,'Choose a valid attention filter.');
 for(const k of ['from','to'])if(f[k]&&(!/^\d{4}-\d{2}-\d{2}$/.test(f[k])||!Number.isFinite(Date.parse(f[k]+'T00:00:00Z'))||new Date(f[k]+'T00:00:00Z').toISOString().slice(0,10)!==f[k]))throw fail(400,'Choose valid report dates.');
 if(f.from&&f.to&&f.from>f.to)throw fail(400,'The end date must be on or after the start date.');
 return f;
}
async function handler(event){
 if(event.httpMethod!=='GET')return json(405,{message:'Reports are read-only.'});
 try{
  const id=await actor(event),q=event.queryStringParameters||{},f=filters(q);
  const response=await service('/rest/v1/rpc/get_operations_report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p_actor_user_id:id,p_report:q.report,p_filters:f})});
  const data=await response.json().catch(()=>null);
  if(!response.ok)throw fail(data?.code==='42501'?403:['22023','22007','22008'].includes(data?.code)?400:503,data?.code==='42501'?'This account cannot access that report.':'Reports are temporarily unavailable. Refresh or try again shortly.');
  if(data?.report!==q.report||!Array.isArray(data.rows)||data.rows.length>25||!Number.isSafeInteger(data.total)||data.total<0||!data.summary||!data.options||!Number.isFinite(Date.parse(data.generatedAt)))throw fail(503,'The report could not be verified. Please refresh.');
  return json(200,data);
 }catch(error){return json(error.status||503,{message:error.status?error.message:'Reports are temporarily unavailable. Please try again.'});}
}
module.exports={handler,filters,REPORTS};
