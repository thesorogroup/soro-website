'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const UI=require('../operations/activity-history.js'),API=require('../netlify/functions/activity-history.js');
const id='10000000-0000-4000-8000-000000000010',rid='10000000-0000-4000-8000-000000000080';
const data=()=>({role:'admin',subject:{kind:'all',id:null},rows:[{key:'audit:'+id,recordedAt:'2026-09-09T12:00:00Z',actorId:id,actorLabel:'Test actor',action:'Verified skills updated',category:'profile',record:{kind:'talent',id:rid,label:'Test Talent',href:'#talent/'+rid},outcome:'recorded',changes:[{label:'Verified skills',before:null,after:null}]}],total:1,offset:0,pageSize:30,asOf:'2026-09-09T13:00:00Z',generatedAt:'2026-09-09T13:00:00Z',options:{actors:[{id,label:'Test actor'}]}});
test('Activity query allowlist rejects role/org injection and malformed filters',()=>{
 for(const q of [{kind:'unknown'},{kind:'all',id},{kind:'talent'},{kind:'talent',id:'self'},{kind:'all',role:'admin'},{kind:'all',organization_id:id},{kind:'all',search:'x'.repeat(121)},{kind:'all',actor:'someone'},{kind:'all',from:'2026-02-29'},{kind:'all',from:'2026-09-10',to:'2026-09-09'},{kind:'all',offset:'-1'},{kind:'all',offset:'1000001'},{kind:'all',recordType:'healthcare'}])assert.throws(()=>API.queryFilters(q));
 assert.equal(API.queryFilters({kind:'client',id:'self'}).id,null);assert.equal(API.queryFilters({kind:'all',recordType:'talent',from:'2024-02-29'}).filters.recordType,'talent');
});
test('Response validation checks subject, role and simple changed values',()=>{
 assert.ok(UI.valid(data(),'all','','admin'));assert.equal(UI.valid(data(),'talent',rid,'admin'),false);assert.equal(UI.valid(data(),'all','','sales'),false);
 const v=data();v.rows[0].changes[0].after={private:'JSON'};assert.equal(UI.valid(v,'all','','admin'),false);
 v.rows[0].changes[0].after=null;v.rows[0].recordedAt='invalid';assert.equal(UI.valid(v,'all','','admin'),false);
});
test('Timeline escapes content, ignores external URLs, and keeps private values private',()=>{
 const v=data();v.rows[0].actorLabel='<img src=x>';v.rows[0].record.href='javascript:evil';v.rows[0].record.label='<script>secret</script>';
 const s=UI.markup({data:v});assert.ok(!s.includes('<script>')&&!s.includes('<img')&&!s.includes('javascript:'));assert.match(s,/&lt;img/);assert.match(s,/values kept private/);
 for(const href of ['https://evil.test','#payroll','#help?ticketId='+id+'&unsafe=1','#documents?token=secret'])assert.equal(UI.safeHref(href),false);
 assert.ok(UI.safeHref('#documents?requestId='+id));
});
test('Timeline distinguishes recorded, pending and failed; local time plus UTC filters',()=>{
 const v=data();v.rows[0].outcome='pending';let s=UI.markup({data:v});assert.match(s,/Pending/);assert.match(s,/From \(UTC\)/);assert.match(s,/Times shown in/);assert.match(s,/not a complete reconstruction/);
 v.rows[0].outcome='failed';assert.match(UI.markup({data:v}),/Failed/);assert.match(UI.markup({data:{...v,rows:[],total:0}}),/No recorded activity matches/);
 assert.match(UI.markup({data:v}),/name="recordType"/);assert.ok(!UI.markup({kind:'talent',data:v,compact:true}).includes('name="recordType"'));
});
const source=fs.readFileSync(path.join(__dirname,'../operations/activity-history.js'),'utf8'),flush=()=>new Promise(r=>setImmediate(r));
function boot(overrides={}){
 const handlers={},host={isConnected:true,innerHTML:'',addEventListener:(type,fn)=>handlers[type]=fn,querySelector:()=>({textContent:''})};
 const c={module:{exports:{}},AbortController,URLSearchParams,Intl,Date,FormData,console,addEventListener(){},soroCurrentAccess:{user_id:id,organization_id:rid,role:'admin',active:true,must_change_password:false},soroSupabase:{auth:{getSession:async()=>({data:{session:{user:{id},access_token:'TEST_ONLY'}}})}},fetch:async()=>({ok:true,json:async()=>data()}),...overrides};
 vm.runInNewContext(source,c);return {ui:c.module.exports,c,host,handlers};
}
test('Component loads real read-only endpoint with session actor',async()=>{
 let request;const b=boot({fetch:async(url,opts)=>{request={url,opts};return{ok:true,json:async()=>data()};}});b.ui.mount(b.host,{kind:'all'});await flush();assert.match(b.host.innerHTML,/Test Talent/);assert.equal(request.url,'/.netlify/functions/activity-history?kind=all');assert.equal(request.opts.headers.Authorization,'Bearer TEST_ONLY');
});
test('No live queries occur in another role preview or explicit preview',async()=>{
 for(const explicit of [true,false]){let calls=0;const b=boot({adminPreviewingNonAdminWorkspace:()=>!explicit,fetch:async()=>{calls++;throw Error();}});b.ui.mount(b.host,{preview:explicit});await flush();assert.equal(calls,0);assert.match(b.host.innerHTML,/Workspace preview only/);}
});
test('Late replies cannot cross user, organization, client, or navigation boundaries',async()=>{
 for(const invalidation of ['user','org','client','unmount','detach']){let release;const b=boot({fetch:()=>new Promise(r=>release=r)});b.ui.mount(b.host);await flush();
 if(invalidation==='user')b.c.soroCurrentAccess.user_id=rid;if(invalidation==='org')b.c.soroCurrentAccess.organization_id=id;if(invalidation==='client')b.c.soroSupabase={};if(invalidation==='unmount')b.ui.unmount();if(invalidation==='detach')b.host.isConnected=false;
 release({ok:true,json:async()=>data()});await flush();assert.ok(!b.host.innerHTML.includes('Test Talent'),invalidation);}
});
test('Session user mismatch never makes an Activity request',async()=>{
 let calls=0;const b=boot({soroSupabase:{auth:{getSession:async()=>({data:{session:{user:{id:rid},access_token:'TEST'}}})}},fetch:async()=>{calls++;}});b.ui.mount(b.host);await flush();assert.equal(calls,0);assert.match(b.host.innerHTML,/Sign in again/);
});
test('Private JSON never returned by handler error responses',async()=>{
 const m={exports:{}},fail=(status,message)=>Object.assign(Error(message),{status});let args;
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../netlify/functions/activity-history.js'),'utf8'),{module:m,require:()=>({actor:async()=>id,service:async(p,b)=>{args=JSON.parse(b.body);return{ok:false,json:async()=>({code:'42501',message:'PRIVATE secret'})};},json:(statusCode,body)=>({statusCode,body}),uuid:()=>true,fail}),Date,Number,JSON});
 const h=m.exports.handler;assert.equal((await h({httpMethod:'POST'})).statusCode,405);const r=await h({httpMethod:'GET',queryStringParameters:{kind:'talent',id:rid}});assert.equal(r.statusCode,403);assert.equal(args.p_actor_user_id,id);assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});
test('Integration uses Reports entry and existing profile surfaces without new sidebar clutter',()=>{
 const read=n=>fs.readFileSync(path.join(__dirname,'../operations',n),'utf8');
 assert.match(read('reports.js'),/role==='admin'.*Open Activity Log/);assert.match(read('operations.js'),/current==='activity'/);assert.ok(!read('index.html').includes('data-view="activity"'));
 assert.match(read('talent-file-tabs.js'),/tabButton\('activity', 'Activity'\).*tabButton\('documents', 'Documents'\)/);
 for(const file of ['client-workflow.js','client-profile.js','admin-employee-management.js','staff-account.js','client-placement-workflow.js'])assert.match(read(file),/data-activity-kind/);
 assert.match(read('task-detail.js'),/Task History/);assert.match(read('task-center.js'),/data-open-task/);
});
test('Migration uses service-only projection, exact existing source strings and no backfill',()=>{
 const sql=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20260909_061_activity_history.sql'),'utf8'),capture=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20260909_062_profile_activity_capture.sql'),'utf8');
 assert.match(sql,/private.active_support_actor\(p_actor_user_id\)/);assert.match(sql,/private.dc_item_access\(a,r,t\)/);assert.match(sql,/private.support_can_read\(a.id,t.id\)/);assert.match(sql,/grant execute on function public.get_activity_history.*to service_role/);assert.match(sql,/limit 30 offset skip/);assert.match(sql,/'Packet assigned','Document submitted','Submission accepted'/);assert.match(sql,/when 'review' then 'Review owner'/);
 assert.ok(!/insert into|delete from|update public/i.test(sql));assert.match(capture,/auth.jwt\(\)->>'role'/);assert.match(capture,/verified_skill_experience/);assert.match(capture,/'birth_date'/);assert.match(capture,/'english_test_result'/);assert.ok(!capture.includes('verified_skill_keys'));
});
