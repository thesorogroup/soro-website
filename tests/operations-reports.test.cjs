'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const api=require('../netlify/functions/operations-reports.js'),D=require('../operations/report-definitions.js'),UI=require('../operations/reports.js');
const id='10000000-0000-4000-8000-000000000001';
test('Reports keep the agreed role-family boundaries',()=>{
 assert.equal(D.visible('admin').length,5);assert.deepEqual(D.visible('sales').map(g=>g.id),['sales','support','documents']);
 assert.deepEqual(D.visible('talent_management').map(g=>g.id),['talent','attendance','support','documents']);
 assert.deepEqual(D.visible('billing').map(g=>g.id),['documents']);for(const role of ['client_admin','client_reviewer','client_billing','virtual_assistant','founder',''])assert.equal(D.visible(role).length,0);
});
test('Reports validate dates and pagination without normalizing impossible dates',()=>{
 for(const q of [{report:'talent',from:'2026-02-29'},{report:'talent',from:'2026-09-10',to:'2026-09-09'},{report:'talent',offset:'-1'},{report:'talent',offset:'1000001'},{report:'talent',search:'a'.repeat(121)},{report:'talent',owner:'evil'},{report:'talent',population:'open'}])assert.throws(()=>api.filters(q));
 assert.equal(api.filters({report:'attendance',from:'2024-02-29',offset:'25'}).offset,'25');
});
test('No actor, organization, role, projection, or write parameters accepted',()=>{
 for(const key of ['actor','organization_id','role','select','action'])assert.throws(()=>api.filters({report:'support',[key]:id}));
 assert.throws(()=>api.filters({report:'activity'}));assert.throws(()=>api.filters({report:['support']}));
 assert.throws(()=>api.filters({report:'support',team:'billing'}));
 assert.equal(api.filters({report:'documents',team:'billing'}).team,'billing');
});
test('Status wording is requester-neutral and report-specific',()=>{
 assert.equal(D.label('waiting_on_client','support'),'Waiting on requester');assert.equal(D.label('open','attendance'),'Open session');assert.equal(D.label('submitted','documents'),'Submitted');
});
test('All seven views document population, dates and limitations',()=>{
 assert.equal(Object.keys(D.VIEWS).length,7);for(const v of Object.values(D.VIEWS)){assert.ok(v.population&&v.limits&&v.date);assert.equal(v.columns.length,6);assert.equal(v.metrics.length,4);}assert.match(D.VIEWS.time_off.limits,/Reasons and private notes/);assert.match(D.VIEWS.talent.limits,/not time in stage/);
});
test('Links cannot navigate outside allowlisted source workflows',()=>{
 assert.ok(UI.routeSafe('#help?ticketId='+id));assert.ok(UI.routeSafe('#documents?requestId='+id));assert.ok(UI.routeSafe('#talent/'+id));
 for(const href of ['https://evil.test','#payroll','#help?ticketId='+id+'&admin=1','javascript:alert(1)'])assert.equal(UI.routeSafe(href),false);
});
test('Unavailable totals remain dashes; real empty totals are zero',()=>{
 assert.equal(UI.metricValue(null,'total'),'—');assert.equal(UI.metricValue({summary:{total:0,statuses:{},flags:{}}},'status:submitted'),0);
});
test('Report rows escape user text and hide unsafe links',()=>{
 const markup=UI.detail('talent','admin',{}, {rows:[{id,title:'<img src=x onerror=alert(1)>',detail:'<script>',cells:['submitted','<b>','2026-09-09','0 days'],href:'javascript:evil'}],summary:{total:1,statuses:{},flags:{}},options:{},generatedAt:'2026-09-09T00:00:00Z',total:1,offset:0});
 assert.ok(!markup.includes('<img'));assert.match(markup,/&lt;img/);assert.ok(!markup.includes('javascript:evil'));
});
function handlerWith(fake){const m={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../netlify/functions/operations-reports.js'),'utf8'),{module:m,require:n=>{assert.equal(n,'./lib/portal-service');return fake;},Date,Number,JSON,Set,Buffer});return m.exports.handler;}
const fail=(status,message)=>Object.assign(Error(message),{status});const json=(statusCode,body)=>({statusCode,body});
test('Endpoint uses the verified actor and only GET; response is private/no-store',async()=>{
 let received;const payload={report:'support',role:'admin',generatedAt:'2026-09-09T00:00:00Z',rows:[],total:0,summary:{},options:{}};
 const handler=handlerWith({actor:async()=>id,service:async(p,b)=>{received=JSON.parse(b.body);return{ok:true,json:async()=>payload};},json,uuid:()=>true,fail});
 assert.equal((await handler({httpMethod:'GET',queryStringParameters:{report:'support'}})).statusCode,200);assert.equal(received.p_actor_user_id,id);assert.equal((await handler({httpMethod:'POST'})).statusCode,405);
 assert.match(fs.readFileSync(path.join(__dirname,'../netlify/functions/lib/portal-service.js'),'utf8'),/'Cache-Control':'no-store'/);
});
test('Endpoint rejects unauthorized DB response and masks internal errors',async()=>{
 for(const [code,status]of [['42501',403],['42P01',503]]){const h=handlerWith({actor:async()=>id,service:async()=>({ok:false,json:async()=>({code,message:'private database secret'})}),json,uuid:()=>true,fail});const result=await h({httpMethod:'GET',queryStringParameters:{report:'support'}});assert.equal(result.statusCode,status);assert.ok(!JSON.stringify(result).includes('private database secret'));}
});
test('Reports revoke direct execution; paginate only after authorized aggregation',()=>{
 const sql=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20260909_060_operations_reports.sql'),'utf8');
 assert.match(sql,/private\.task_actor\(p_actor_user_id\)/);assert.match(sql,/private\.support_staff\(a,t\)/);assert.match(sql,/private\.dc_item_access\(a,r,t\)/);assert.match(sql,/a.role<>'billing' or t.category='tax'/);
 assert.match(sql,/from public,anon,authenticated,service_role/);assert.match(sql,/grant execute on function public.get_operations_report.*to service_role/);
 assert.match(sql,/limit 25 offset skip/);assert.match(sql,/'total',\(select count\(\*\) from filtered\)/);assert.ok(!/insert into|update public|delete from/i.test(sql));
});
test('Report requests are invalidated on navigation/auth and preview never queries',()=>{
 const ui=fs.readFileSync(path.join(__dirname,'../operations/reports.js'),'utf8'),ops=fs.readFileSync(path.join(__dirname,'../operations/operations.js'),'utf8');
 assert.match(ui,/opts.preview\)\{loading=false/);assert.match(ui,/soro-auth-changed/);assert.match(ui,/scope\(\)===captured/);assert.match(ui,/own!==requestId/);assert.match(ops,/if\(current!=='reports'\)window.SoroReports\?\.unmount/);
});
