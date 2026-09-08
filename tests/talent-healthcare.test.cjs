'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ui=require('../operations/talent-healthcare');
const backend=require('../netlify/functions/talent-healthcare');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const access={role:'virtual_assistant',user_id:id(18),organization_id:id(1)};
const applicant={id:id(80),auth_user_id:id(18),organization_id:id(1)};
const clean=()=>{const p=ui.blank();delete p.version;return p;};

test('healthcare access is own-Talent read or same-organization Admin/Talent Management',()=>{
 assert.equal(ui.canView(access,applicant,true),true);assert.equal(ui.canView(access,applicant,false),false);
 for(const role of ['admin','talent_management'])assert.equal(ui.canView({...access,role},applicant,false),true);
 for(const role of ['sales','sales_management','client_admin','client_reviewer','client_billing','billing'])assert.equal(ui.canView({...access,role},applicant,true),false);
 assert.equal(ui.canView(access,{...applicant,organization_id:id(2)},true),false);assert.equal(ui.canView(access,{...applicant,auth_user_id:id(21)},true),false);assert.equal(ui.canView(null,applicant,true),false);
});
test('coverage renders the four requested types, empty states and private masking without invented plan data',()=>{
 const data={profile:ui.blank(),canManage:false};const html=ui.markup(data);
 for(const label of ['Medical','Prescription','Dental','Vision','Dependents &amp; +1'])assert.ok(html.includes(label));
 assert.doesNotMatch(html,/Manage coverage|data-hc-action=|TEST-CARRIER/);
 Object.assign(data.profile.plans[0],{memberId:'ID',accountNumber:'1234567890',carrier:'<img src=x onerror=alert(1)>'});
 data.profile.dependents=[{fullName:'Name',memberId:'22',birthDate:'2000-02-29',coverageKinds:['medical']}];
 assert.doesNotMatch(ui.markup(data),/>ID<|>22<|1234567890|<img src=x|Feb 29, 2000/);
 assert.match(ui.markup(data),/•••• 7890/);assert.match(ui.markup(data,{reveal:true}),/1234567890/);
 assert.match(ui.markup(data,{reveal:true}),/Feb 29, 2000/);assert.match(ui.markup(data),/&lt;img/);
});
test('upcoming and ended coverage dates are not labelled currently active',()=>{
 assert.equal(ui.planState({status:'active',effectiveDate:'2030-01-01'},'2026-09-08'),'Upcoming');
 assert.equal(ui.planState({status:'ending',endDate:'2026-01-01'},'2026-09-08'),'Coverage ended');
 assert.equal(ui.planState({status:'active',effectiveDate:'2026-01-01'},'2026-09-08'),'Active');
});
test('member websites exclude credentials and private query tokens',()=>{
 assert.equal(ui.safeURL('https://example.com/member'),'https://example.com/member');
 for(const url of ['javascript:alert(1)','http://example.com','https://x:y@example.com','https://example.com/?token=x','https://example.com/#secret'])assert.equal(ui.safeURL(url),'');
});
test('edit controls include group/account/Rx fields and dependents without clinical-record inputs',()=>{
 const html=ui.editForm({profile:ui.blank()});for(const name of ['carrier','memberId','accountNumber','groupName','groupId','rxBin','rxPcn','rxGroup','effectiveDate','endDate'])assert.match(html,new RegExp(`name="${name}"`));
 assert.match(html,/Add covered dependent \/ \+1/);assert.doesNotMatch(html,/name="(?:diagnosis|medication|treatment|ssn|password)"/);
 assert.match(ui.stepForm({kind:'cancellation'}),/Nothing here sends a request to the carrier/);assert.match(ui.stepForm({kind:'enrollment'}),/name="confirmed"/);
});
test('endpoint validates blank and four distinct plans and rejects arbitrary fields',()=>{
 assert.deepEqual(backend.profile(clean()).plans.map(p=>p.kind),ui.KINDS);
 for(const p of [{...clean(),diagnosis:'x'},{...clean(),plans:[]},{...clean(),plans:clean().plans.map(()=>({kind:'medical',status:'active'}))}])assert.throws(()=>backend.profile(p),{status:400});
 for(const action of ['constructor','__proto__','unknown'])assert.throws(()=>backend.validate({action,applicantId:id(80)}),{status:400});
 assert.throws(()=>backend.validate({action:'view',applicantId:id(80),actorId:id(18)}),{status:400});
});
test('coverage calendar dates, status requirements and Rx-only identifiers are validated',()=>{
 assert.equal(backend.date('2000-02-29'),'2000-02-29');for(const d of ['2026-02-29','2026-13-01','yesterday','2026-1-1'])assert.throws(()=>backend.date(d),{status:400});
 for(const fields of [{status:'active'},{status:'ending',carrier:'Carrier',effectiveDate:'2026-01-01'},{effectiveDate:'2026-02-01',endDate:'2026-01-01'},{rxBin:'123456'},{website:'https://example.com/?token=secret'}]){const p=clean();Object.assign(p.plans[0],fields);assert.throws(()=>backend.profile(p),{status:400});}
 const p=clean();p.plans[0].website='example.com';assert.equal(backend.profile(p).plans[0].website,'https://example.com/');
});
test('plus-one and family arrangements match valid named dependents',()=>{
 const p=clean();p.coverageLevel='plus_one';p.dependents=[{fullName:'Covered person',coverageKinds:['medical','vision'],birthDate:'2000-02-29'}];assert.equal(backend.profile(p).dependents.length,1);
 for(const over of [{fullName:''},{coverageKinds:['medical','medical']},{coverageKinds:['clinical']},{birthDate:'2999-01-01'},{diagnosis:'not permitted'}])assert.throws(()=>backend.profile({...p,dependents:[{...p.dependents[0],...over}]}),{status:400});
 assert.throws(()=>backend.profile({...p,coverageLevel:'talent_only'}),{status:400});assert.throws(()=>backend.profile({...p,dependents:[]}),{status:400});
});
test('workflow completion requires confirmation, a date and carrier reference',()=>{
 const b={action:'resolve',applicantId:id(80),requestId:id(999),actionId:id(200),expectedVersion:1,status:'completed',resolution:'carrier_confirmed',confirmed:true,effectiveDate:'2026-09-08',reference:'CASE-1'};
 assert.equal(backend.validate(b).reference,'CASE-1');for(const over of [{confirmed:false},{reference:''},{effectiveDate:''},{resolution:'no_coverage'},{expectedVersion:-1},{expectedVersion:1.1}])assert.throws(()=>backend.validate({...b,...over}),{status:400});
 assert.equal(backend.validate({...b,status:'not_applicable',resolution:'coverage_continues',effectiveDate:null,reference:''}).resolution,'coverage_continues');
});
function harness(){
 const listeners={},calls=[];let pending=null,preview=false;
 const target={isConnected:true,innerHTML:'',replaceChildren(){this.innerHTML='';},querySelector(){return null;},querySelectorAll(){return[];},firstElementChild:{textContent:''}};
 const window={soroCurrentAccess:{...access},addEventListener:(n,f)=>listeners[n]=f,adminPreviewingNonAdminWorkspace:()=>preview,crypto:require('node:crypto').webcrypto,soroSupabase:{auth:{getSession:async()=>({data:{session:{access_token:'unit',user:{id:access.user_id}}}})}}};
 window.fetch=async(url,options)=>{calls.push({url,options});if(pending)await pending;return Response.json({profile:ui.blank(),canManage:false,actions:[]});};
 vm.runInNewContext(read('operations/talent-healthcare.js'),{window,URL,AbortSignal,AbortController,Intl,Date});
 return{window,target,calls,listeners,api:window.SoroTalentHealthcare,setPending:v=>pending=v,setPreview:v=>preview=v};
}
test('mount uses verified own session, POST-only private endpoint and renders no client-side persistence',async()=>{
 const h=harness();await h.api.mount(h.target,{applicantId:applicant.id});assert.equal(h.calls.length,1);
 assert.equal(h.calls[0].url,'/.netlify/functions/talent-healthcare');assert.equal(h.calls[0].options.method,'POST');assert.equal(h.calls[0].options.headers.Authorization,'Bearer unit');
 assert.match(h.target.innerHTML,/Healthcare/);assert.doesNotMatch(read('operations/talent-healthcare.js'),/localStorage|sessionStorage|console\.log/);
});
test('live requests cannot run as a preview or from a disallowed role',async()=>{
 for(const mode of ['preview','adminPreview','sales','compactTalent']){const h=harness();if(mode==='adminPreview')h.setPreview(true);if(mode==='sales')h.window.soroCurrentAccess.role='sales';await h.api.mount(h.target,{applicantId:applicant.id,preview:mode==='preview',compact:mode==='compactTalent'});assert.equal(h.calls.length,0);}
});
test('late healthcare responses never repaint a different account or disconnected profile',async()=>{
 for(const mode of ['auth','route']){const h=harness();let release;h.setPending(new Promise(r=>release=r));const run=h.api.mount(h.target,{applicantId:applicant.id});await new Promise(r=>setImmediate(r));
  if(mode==='auth'){h.window.soroCurrentAccess={...access,user_id:id(21)};h.listeners['soro-auth-changed']();}else{h.target.isConnected=false;h.listeners.hashchange();}release();await run;assert.equal(h.target.innerHTML,'');}
});
test('auth event for the same actor does not clear a newly mounted healthcare view',async()=>{
 const h=harness();await h.api.mount(h.target,{applicantId:applicant.id});const html=h.target.innerHTML;h.listeners['soro-auth-changed']();assert.equal(h.target.innerHTML,html);
});
test('isolated review adapter cannot fall through into production requests',async()=>{
 const h=harness();await h.api.mount(h.target,{preview:true,adapter:async()=>({profile:ui.blank(),canManage:false}),applicantId:'preview'});assert.equal(h.calls.length,0);assert.match(h.target.innerHTML,/Healthcare/);
});
test('Benefits reuse and placement integration leave the original activation gates intact',()=>{
 const tabs=read('operations/talent-file-tabs.js'),cpw=read('operations/client-placement-workflow.js'),sql=read('supabase/migrations/20260908_053_talent_healthcare.sql');
 assert.match(tabs,/canViewBenefits\(applicant\)/);assert.match(tabs,/target\?\.isConnected/);assert.match(tabs,/requested === 'benefits'/);
 assert.match(cpw,/!clientSafe && workspace.permissions.manageOnboarding && !mountedOptions.adapter/);
 assert.match(cpw,/const canActivate = workspace.permissions.manageOnboarding && placement.status === 'onboarding' && !requiredPending && !beforeStart/);
 assert.doesNotMatch(sql,/update public\.placements|insert into public\.audit_events|insert into public\.tasks|create policy|insurance.*fetch/i);
 assert.match(sql,/talent_healthcare_history/);assert.match(sql,/grant execute on function public\.talent_healthcare\(uuid,jsonb\) to service_role/);
});

function endpointHarness(){
 const calls=[];let authError=null,response=Response.json({canManage:false,profile:null,actions:[],placements:[],events:[]});
 const helper=require('../netlify/functions/lib/portal-service');
 const module={exports:{}};
 vm.runInNewContext(read('netlify/functions/talent-healthcare.js'),{module,exports:module.exports,require:p=>{
  assert.equal(p,'./lib/portal-service');return {...helper,actor:async()=>{calls.push('auth');if(authError)throw authError;return id(18);},service:async(p,opts)=>{calls.push({p,opts});return response;}};} ,URL,Buffer,Date});
 const run=body=>module.exports.handler({httpMethod:'POST',headers:{authorization:'Bearer test'},body:JSON.stringify(body)});
 return{run,calls,setResponse:r=>response=r,setAuthError:e=>authError=e,handler:module.exports.handler};
}
test('healthcare endpoint takes actor identity only from verified authentication and never caches private responses',async()=>{
 const h=endpointHarness(),r=await h.run({action:'view',applicantId:id(80)});assert.equal(r.statusCode,200);assert.equal(r.headers['Cache-Control'],'no-store');assert.equal(r.headers.Vary,'Authorization');
 assert.equal(h.calls[1].p,'/rest/v1/rpc/talent_healthcare');assert.equal(JSON.parse(h.calls[1].opts.body).p_actor_user_id,id(18));
 const forged=endpointHarness();assert.equal((await forged.run({action:'view',applicantId:id(80),actorId:id(10)})).statusCode,400);assert.equal(forged.calls.length,1);
});
test('healthcare endpoint stops unauthenticated, oversized, query-string and malformed submissions',async()=>{
 const h=endpointHarness();h.setAuthError(Object.assign(Error('Sign in.'),{status:401}));assert.equal((await h.run({action:'view',applicantId:id(80)})).statusCode,401);assert.equal(h.calls.length,1);
 for(const options of [{body:'x'.repeat(30001)},{body:'{'},{body:'{}',queryStringParameters:{member:'secret'}},{body:'{}',isBase64Encoded:true}]){const unit=endpointHarness();assert.equal((await unit.handler({httpMethod:'POST',...options})).statusCode,400);assert.equal(unit.calls.length,1);}
 assert.equal((await endpointHarness().handler({httpMethod:'GET'})).statusCode,405);
});
test('database authorization/version errors are sanitized without exposing private field values',async()=>{
 for(const [code,status]of [['42501',403],['40001',409],['23505',409],['23514',400],['22023',400],['XX000',503]]){const h=endpointHarness();h.setResponse(Response.json({code,message:'PRIVATE-MEMBER internal SQL details'},{status:400}));const r=await h.run({action:'view',applicantId:id(80)});assert.equal(r.statusCode,status);assert.doesNotMatch(r.body,/PRIVATE-MEMBER|internal SQL/);}
});
