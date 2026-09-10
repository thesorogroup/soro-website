'use strict';
const {actor,service,json,fail,uuid}=require('./lib/portal-service');
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
function parse(event){
 if(event.isBase64Encoded||typeof event.body!=='string'||Buffer.byteLength(event.body)>12000)throw fail(400,'Check the end-placement details.');let b;try{b=JSON.parse(event.body);}catch{throw fail(400,'Check the end-placement details.');}
 const fields={plan:['lastDate','reason','note','talentNextStep','replacement'],checklist:['checklist'],complete:['confirm'],cancel:[],reopen_healthcare:[]};
 if(!b||!Object.hasOwn(fields,b.action)||!exact(b,['action','requestId','placementId','version',...fields[b.action]])||!uuid(b.requestId)||!uuid(b.placementId)||!Number.isSafeInteger(b.version)||b.version<0)throw fail(400,'Choose a valid placement and action.');
 if(b.action==='plan'&&(!date(b.lastDate)||!['assignment_complete','client_request','talent_request','role_change','other'].includes(b.reason)||!['review','bench'].includes(b.talentNextStep)||typeof b.replacement!=='boolean'||typeof b.note!=='string'||b.note.length>2000||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(b.note)))throw fail(400,'Check the last working date and end plan.');
 if(b.action==='checklist'&&(!exact(b.checklist,['handover','access','time'])||Object.values(b.checklist).some(v=>typeof v!=='boolean')))throw fail(400,'Check each closing item.');
 if(b.action==='complete'&&b.confirm!==true)throw fail(400,'Confirm that the final work is complete.');return b;
}
const safeStates=new Set(['The last working date has not arrived.','Complete all closing checks.','Resolve the healthcare review first.','Review open sessions or work recorded after the last date.','Resolve the Talent’s other placement or candidate process first.','Reopen the healthcare review before changing the last date.','Review resolved healthcare before cancelling this end plan.','Carrier-confirmed cancellation cannot be reopened here. Review coverage with the carrier first.','Interview and employment references must be addressed before Bench Ready.']);
async function rpc(name,b){const r=await service('/rest/v1/rpc/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});const v=await r.json().catch(()=>null);if(!r.ok)throw fail(v?.code==='42501'?403:['40001','23505','23514','P0001'].includes(v?.code)?409:['22023','22P02','22007','22008'].includes(v?.code)?400:503,v?.code==='42501'?'Admin or Talent Management access to this placement is required.':v?.code==='40001'?'This end plan changed. Refresh before saving again.':v?.code==='23505'?'This action was already recorded with different details. Refresh and try again.':v?.code==='P0001'&&safeStates.has(v.message)?v.message:['22023','22P02','22007','22008'].includes(v?.code)?'Check the dates and closing details.':v?.code==='23514'?'This placement is not in a state that can be ended.':'The placement could not be updated. Please refresh and try again.');return v;}
async function handler(event){if(!['GET','POST'].includes(event.httpMethod))return json(405,{message:'Method not allowed.'});try{
 const q=event.queryStringParameters||{},multi=event.multiValueQueryStringParameters||{};
 if(Object.keys(q).some(k=>k!=='placementId')||Object.keys(multi).some(k=>k!=='placementId'||!Array.isArray(multi[k])||multi[k].length!==1)||q.placementId&&!uuid(q.placementId)||event.httpMethod==='GET'&&event.body||event.httpMethod==='POST'&&(Object.keys(q).length||Object.keys(multi).length))throw fail(400,'Choose one placement.');
 if(event.rawQueryString){const params=new URLSearchParams(event.rawQueryString);if([...params.keys()].some(k=>k!=='placementId')||params.getAll('placementId').length!==1||params.get('placementId')!==q.placementId)throw fail(400,'Choose one placement.');}
 const body=event.httpMethod==='POST'?parse(event):null,user=await actor(event);
 if(!body)return json(200,await rpc('get_placement_endings',{p_actor_user_id:user,p_placement_id:q.placementId||null}));
 const {action,...values}=body;return json(200,await rpc('change_placement_ending',{p_actor_user_id:user,p_action:action,p_body:values}));
 }catch(e){return json(e.status||503,{message:e.status?e.message:'Placements are temporarily unavailable. Please try again.'});}}
module.exports={handler,_test:{parse,date}};
