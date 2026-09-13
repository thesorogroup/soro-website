const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
process.env.SUPABASE_URL='https://observer-test.supabase.co';process.env.SUPABASE_SERVICE_ROLE_KEY='test-only-key';
const api=require('../netlify/functions/founder-live-portal');
const id=n=>'d0000000-0000-4000-8000-'+String(n).padStart(12,'0'),org=id(9),founder=id(1),subject=id(2),applicant=id(3);
async function run(query,options={}){
 const calls=[],original=global.fetch;
 global.fetch=async(url,init={})=>{
  const u=new URL(url);calls.push({url:u,method:init.method||'GET',body:init.body?JSON.parse(init.body):null});let value=[];
  if(u.pathname==='/auth/v1/user')value={id:founder};
  else if(u.pathname==='/auth/v1/admin/users/'+subject)value={id:subject,email:'talent@example.test'};
  else if(u.pathname.endsWith('/platform_users'))value=u.searchParams.get('id')==='eq.'+founder?[{id:founder,organization_id:org,role:'admin',active:true,is_founder:true,must_change_password:false,...options.founder}]:options.noSubject?[]:[{id:subject,organization_id:org,role:options.role||'virtual_assistant',display_name:'Talent Person'}];
  else if(u.pathname.endsWith('/applicants'))value=options.inactive?[]:u.searchParams.get('select')==='id'?[{id:applicant}]:[{id:applicant,auth_user_id:subject,organization_id:org,full_name:'Talent Person',legacy_application_data:{verified_skill_experience:{Writing:2},private_note:'not for portal'}}];
  else if(u.pathname.endsWith('/rpc/task_detail'))value={task:{},history:[],assignees:[]};
  else if(u.pathname.includes('/rpc/'))value={};
  return new Response(JSON.stringify(value),{status:200});
 };
 try{return{response:await api.handler({httpMethod:options.method||'GET',headers:{Authorization:'Bearer actual-founder-token'},queryStringParameters:query,...options.event}),calls};}finally{global.fetch=original;}
}
test('observer rejects all HTTP mutations before authenticating',async()=>{for(const method of ['POST','PATCH','DELETE','PUT']){const r=await run({}, {method});assert.equal(r.response.statusCode,405);assert.equal(r.calls.length,0);}});
test('observer requires active protected Founder with completed password setup',async()=>{for(const change of [{is_founder:false},{role:'sales'},{active:false},{must_change_password:true}]){const r=await run({action:'context',portal:'va',subject},{founder:change});assert.equal(r.response.statusCode,403);assert.equal(r.calls.length,2);}});
test('subject context keeps separate actor and subject and requires active Talent portal',async()=>{
 const r=await run({action:'context',portal:'va',subject});assert.equal(r.response.statusCode,200);const body=JSON.parse(r.response.body);assert.equal(body.actorId,founder);assert.equal(body.subject.user_id,subject);assert.equal(body.subject.email,'talent@example.test');assert.equal(body.readOnly,true);
 const q=r.calls.find(c=>c.url.pathname.endsWith('/applicants')).url.searchParams;assert.equal(q.get('portal_access_status'),'eq.active');assert.equal(q.get('organization_id'),'eq.'+org);
 assert.ok(!r.response.body.includes('actual-founder-token'));
});
test('inactive, wrong-role, and cross-organization subjects fail closed',async()=>{for(const o of [{inactive:true},{role:'sales'},{noSubject:true}]){const r=await run({action:'context',portal:'va',subject},o);assert.ok([403,404].includes(r.response.statusCode));assert.ok(!r.calls.some(c=>c.url.pathname.includes('/rpc/')));}});
test('profile uses allowlisted fields and removes unrelated legacy data',async()=>{const r=await run({action:'read',portal:'va',subject,resource:'profile',params:'{}'});assert.equal(r.response.statusCode,200);const b=JSON.parse(r.response.body);assert.deepEqual(b.data.legacy_application_data,{verified_skill_experience:{Writing:2}});assert.ok(!api.SELF_FIELDS.includes('status_reason'));});
test('unknown reads cannot become arbitrary queries or mutations',async()=>{for(const resource of ['record_talent_attendance','update_my_task','create_task','platform_users','https://example.com']){const r=await run({action:'read',portal:'va',subject,resource,params:'{}'});assert.equal(r.response.statusCode,403);assert.ok(!r.calls.some(c=>c.url.pathname.includes('/rpc/')));}});
test('task observation always uses get, never view or save',async()=>{const r=await run({action:'read',portal:'va',subject,resource:'task-detail',params:JSON.stringify({taskId:id(6)})});const c=r.calls.find(c=>c.url.pathname.endsWith('/rpc/task_detail'));assert.equal(c.body.p_action,'get');assert.equal(c.body.p_actor_user_id,subject);});
test('SQL observer helper is stable, same-organization, service-only and performs no data changes',()=>{const sql=fs.readFileSync('supabase/migrations/20260913_074_founder_portal_observer.sql','utf8');assert.match(sql,/language plpgsql stable security definer/);assert.match(sql,/a.organization_id<>founder.organization_id/);assert.match(sql,/founder.is_founder is not true/);assert.match(sql,/from public,anon,authenticated/);assert.match(sql,/to service_role/);assert.doesNotMatch(sql,/\b(?:insert into|update public\.|delete from)\b/i);assert.match(sql,/other.storage_path=x.storage_path/);});
test('opaque child cannot send mutations or request external network URLs',async()=>{
 const sent=[],listeners={};const w={parent:{postMessage:v=>sent.push(v)},history:{replaceState(){}},addEventListener:(name,fn)=>listeners[name]=fn};
 const doc={addEventListener(){}};const context={window:w,document:doc,URL,Response,Map,Promise,Object,JSON,Error,setTimeout,clearTimeout};vm.runInNewContext(fs.readFileSync('operations/live-portal/runtime.js','utf8'),context);
 for(const [url,options] of [['/.netlify/functions/talent-attendance',{method:'POST',body:'{"action":"start_day"}'}],['/.netlify/functions/support-tickets',{method:'PATCH',body:'{"action":"read"}'}],['https://example.com/.netlify/functions/tasks',{}]])assert.equal((await w.fetch(url,options)).status,403);
 assert.ok(!sent.some(m=>m.type==='soro-live-read'));
 const pending=w.fetch('/.netlify/functions/task-detail',{method:'POST',body:JSON.stringify({action:'view',taskId:id(5)})});const m=sent.find(m=>m.type==='soro-live-read');assert.equal(m.resource,'task-detail');assert.deepEqual(JSON.parse(JSON.stringify(m.params)),{taskId:id(5)});
 listeners.message({source:w.parent,data:{type:'soro-live-result',id:m.id,data:{task:{}}}});assert.equal((await pending).status,200);
});
test('parent frame excludes auth scripts and never transmits Founder credentials',()=>{const s=fs.readFileSync('operations/founder-live-portal.js','utf8');assert.match(s,/sandbox','allow-scripts allow-forms'/);assert.match(s,/connect-src 'none'/);assert.match(s,/event.origin!=='null'/);assert.match(s,/s.frame===frame/);assert.doesNotMatch(s,/allow-same-origin/);const init=s.match(/send\('soro-live-init'[^\n]+/)[0];assert.ok(!/token|session|credential/i.test(init));});

test('observer preserves canonical deep links, read controls, and Founder shell labels',()=>{
 const start=fs.readFileSync('operations/live-portal/start.js','utf8'),parent=fs.readFileSync('operations/founder-live-portal.js','utf8');
 assert.match(start,/new PopStateEvent\('popstate'\)/);
 assert.match(start,/b.type==='submit'&&b.closest\('form'\)/);
 assert.match(start,/\[data-cpw-decision\],\[data-cpw-open\],\[data-cpw-direct\]/);
 assert.match(parent,/originalNavigation\.forEach/);assert.match(parent,/originalSwitcherLabel=undefined/);
});
