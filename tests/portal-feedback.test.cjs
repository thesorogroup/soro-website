const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const api=require('../netlify/functions/portal-feedback'),ui=require('../operations/feedback'),nav=require('../operations/sidebar-navigation');
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const read=name=>fs.readFileSync(require.resolve('../'+name),'utf8');
const post=body=>({httpMethod:'POST',body:JSON.stringify(body)});
test('Feedback validates text/category and rejects caller-selected ownership or status',()=>{
 const valid={requestId:id(1),category:'suggestion',message:' A helpful idea '};
 assert.equal(api.parseBody(post(valid)).message,'A helpful idea');
 for(const extra of [{organizationId:id(2)},{authorUserId:id(2)},{role:'admin'},{reviewed:true}])assert.throws(()=>api.parseBody(post({...valid,...extra})));
 for(const category of ['billing','<script>','',null])assert.throws(()=>api.parseBody(post({...valid,category})));
 for(const message of ['',null,'ab','x'.repeat(4001),'hello\u0000'])assert.throws(()=>api.parseBody(post({...valid,message})));
 assert.throws(()=>api.parseBody({...post(valid),isBase64Encoded:true}));
 assert.throws(()=>api.parseBody({httpMethod:'POST',body:'x'.repeat(20001)}));
 assert.deepEqual(api.parseBody({httpMethod:'PATCH',body:JSON.stringify({id:id(2)})}),{id:id(2)});
 assert.throws(()=>api.parseBody({httpMethod:'PATCH',body:JSON.stringify({id:id(2),reviewer:id(1)})}));
});
test('Feedback renders escaped text and never exposes review controls to a non-admin inbox',()=>{
 const row={id:id(1),category:'general',message:'<img src=x onerror=x>',authorName:'<script>',createdAt:'2026-09-09'};
 const own=ui.itemsMarkup({items:[row],canReview:false});assert.doesNotMatch(own,/<img|<script|data-review-feedback|feedback-author/);assert.match(own,/&lt;img/);
 const admin=ui.itemsMarkup({items:[row],canReview:true});assert.match(admin,/Mark reviewed/);assert.match(admin,/&lt;script&gt;/);
 assert.doesNotMatch(ui.itemsMarkup({items:[{...row,reviewedAt:'2026-09-09'}],canReview:true}),/Mark reviewed/);
 assert.match(ui.pageMarkup({preview:true}),/type="submit" disabled/);
});
test('Every existing portal gets Feedback without changing any other role permission',()=>{
 const source=read('operations/operations.js');
 const start=source.indexOf('const authenticatedEmployeeViews='),end=source.indexOf('const workspacePreviewAccessRole=');
 const context=vm.createContext({});vm.runInContext(source.slice(start,end)+';this.views=authenticatedEmployeeViews;',context);
 assert.deepEqual(Object.keys(context.views).sort(),[...ui.ROLES].sort());
 for(const [role,views] of Object.entries(context.views))assert.equal(views.has('feedback'),true,role);
 assert.equal(context.views.virtual_assistant.has('employees'),false);assert.equal(context.views.sales.has('payroll'),false);assert.equal(context.views.client_admin.has('talent-review'),false);
 assert.match(source,/\['help','feedback','my-profile'/);
 for(const role of ui.ROLES)assert.equal(ui.eligible({user_id:id(1),organization_id:id(2),role,active:true}),true);
 for(const a of [null,{role:'admin'},{user_id:id(1),organization_id:id(2),role:'founder'},{user_id:id(1),organization_id:id(2),role:'admin',active:false},{user_id:id(1),organization_id:id(2),role:'admin',must_change_password:true}])assert.equal(ui.eligible(a),false);
});
test('Menus preserve route identities and keep utilities separate from scrolling groups',()=>{
 const all=nav.GROUPS.flatMap(g=>g.views);assert.equal(new Set(all).size,all.length);
 assert.deepEqual(nav.GROUPS.find(g=>g.id==='talent').views,['vas','available-talent','talent-review']);
 assert.doesNotMatch(JSON.stringify(nav.GROUPS),/feedback|my-profile|tasks|overview/);
 const source=read('operations/sidebar-navigation.js');assert.match(source,/badge\.hidden=!count\|\|group\.open/);assert.match(source,/links\.some\(b=>!b\.hidden\)/);
 assert.match(source,/links\.some\(b=>!b\.hidden&&b\.classList\.contains\('active'\)\)/);
 assert.match(read('operations/sidebar-theme.css'),/sidebar-nav-scroll \{flex:1 1 auto;min-height:0;overflow-y:auto/);
 assert.match(read('operations/sidebar-theme.css'),/sidebar-nav-footer \{flex:0 0 auto/);
 assert.match(read('operations/staff-account.js'),/footer\.insertBefore\(item,document\.getElementById\('feedback-nav'\)\)/);
});
test('Feedback navigation cleans up before outer views and blocks workspace-preview writes',()=>{
 const source=read('operations/operations.js'),uiSource=read('operations/feedback.js');
 assert.match(source,/function setActive\(\)\{\s*if\(current!=='feedback'\)window\.SoroFeedback\?\.unmount/);
 assert.match(source,/preview:adminPreviewingNonAdminWorkspace\(\)/);
 assert.match(uiSource,/root\.soroSupabase/);assert.doesNotMatch(uiSource,/soroSupabaseClient/);
 assert.match(uiSource,/session\.user\?\.id!==root\.soroCurrentAccess\?\.user_id/);
 assert.match(uiSource,/element\.querySelector\('\[data-feedback-form\]'\)===form/);
 assert.match(uiSource,/form\.elements\.message\.disabled=true/);
 assert.match(uiSource,/soro-auth-changed/);
});
test('Feedback persistence is actor-scoped and service-only with replay before quotas',()=>{
 const sql=read('supabase/migrations/20260909_059_portal_feedback.sql');
 assert.match(sql,/enable row level security/);assert.match(sql,/revoke all on public.portal_feedback from public,anon,authenticated,service_role/);
 assert.match(sql,/f\.organization_id=a\.organization_id and \(a\.role='admin' or f\.author_user_id=a\.id\)/);
 assert.match(sql,/if a\.role<>'admin' then raise exception/);assert.match(sql,/where id=p_feedback_id and organization_id=a\.organization_id for update/);
 assert.match(sql,/if f\.reviewed_at is null then update/);assert.match(sql,/unique\(author_user_id,request_id\)/);
 assert(sql.indexOf('return jsonb_build_object(\'id\',f.id)')<sql.indexOf("interval '1 minute'"));
 assert.doesNotMatch(sql,/create policy|enqueue_confirmation|support_tickets|delete from|insert into public\.platform_users/);
});
test('Feedback endpoint derives the actor and maps private API failures without exposing server details',async t=>{
 const old={fetch:global.fetch,url:process.env.SUPABASE_URL,key:process.env.SUPABASE_SERVICE_ROLE_KEY};
 t.after(()=>{global.fetch=old.fetch;for(const [k,v] of [['SUPABASE_URL',old.url],['SUPABASE_SERVICE_ROLE_KEY',old.key]]){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
 process.env.SUPABASE_URL='https://example.supabase.co';process.env.SUPABASE_SERVICE_ROLE_KEY='test';
 let body={items:[],canReview:false,hasMore:false},ok=true,calls=[];
 global.fetch=async(url,options)=>{calls.push({url,body:options.body?JSON.parse(options.body):null});return url.endsWith('/auth/v1/user')?{ok:true,json:async()=>({id:id(9)})}:{ok,json:async()=>body};};
 const event={httpMethod:'GET',headers:{Authorization:'Bearer test'}};
 assert.equal((await api.handler(event)).statusCode,200);assert.deepEqual(calls[1].body,{p_actor_user_id:id(9),p_offset:0});
 assert.equal((await api.handler({...event,queryStringParameters:{role:'admin'}})).statusCode,400);
 assert.equal((await api.handler({...event,headers:{}})).statusCode,401);
 body={id:id(5)};assert.equal((await api.handler({...post({requestId:id(1),category:'general',message:'Example feedback'}),headers:event.headers})).statusCode,200);
 assert.equal(calls.at(-1).body.p_actor_user_id,id(9));
 assert.equal((await api.handler({...event,httpMethod:'PATCH',body:JSON.stringify({id:id(2)})})).statusCode,503,'Mismatched receipt rejected');
 ok=false;for(const [code,message,status] of [['42501','private server detail',403],['23505','private server detail',409],['P0001','feedback_rate_limit',429],['unknown','private server detail',503]]){body={code,message};const result=await api.handler(event);assert.equal(result.statusCode,status);assert.doesNotMatch(result.body,/private server detail/);}
 assert.equal((await api.handler({...event,httpMethod:'DELETE'})).statusCode,405);
});

function browserFixture(sessionUser=id(1)){
 const listeners={},fields={category:{value:'suggestion',disabled:false},message:{value:'A local test suggestion',disabled:false}},submit={disabled:false};
 const element=()=>({textContent:'',innerHTML:'',hidden:false,replaceChildren(){this.innerHTML='';},addEventListener(){}});
 const form={elements:fields,querySelector:()=>submit,addEventListener:(name,fn)=>{listeners[name]=fn;},reportValidity:()=>true,reset:()=>{fields.message.value='';}};
 const parts=new Map();let html='';const host={get innerHTML(){return html;},set innerHTML(v){html=v;},querySelector(selector){if(selector==='[data-feedback-form]')return html.includes('data-feedback-form')?form:null;if(!parts.has(selector))parts.set(selector,element());return parts.get(selector);},addEventListener(){},replaceChildren(){html='';}};
 const events={},calls=[];let response=async()=>({ok:true,json:async()=>({items:[],canReview:false,hasMore:false})});
 const context=vm.createContext({AbortController,crypto:require('node:crypto').webcrypto,console,
  soroCurrentAccess:{user_id:id(1),organization_id:id(2),role:'virtual_assistant',active:true,must_change_password:false},
  soroSupabase:{auth:{getSession:async()=>({data:{session:{access_token:'sample-token',user:{id:sessionUser}}}})}},
  fetch:async(url,options)=>{calls.push({url,options});return response(url,options);},
  addEventListener:(name,fn)=>{events[name]=fn;}
 });
 vm.runInContext(read('operations/feedback.js'),context);
 return{api:context.SoroFeedback,context,host,parts,fields,submit,listeners,events,calls,setResponse:fn=>{response=fn;}};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('Feedback never requests data with a session token belonging to another account',async()=>{
 const f=browserFixture(id(9));f.api.mount(f.host);await flush();assert.equal(f.calls.length,0);assert.match(f.parts.get('[data-feedback-list-status]').textContent,/Sign in again/);f.api.unmount();
});
test('Late Feedback results cannot overwrite another page or a signed-out session',async()=>{
 const f=browserFixture();let finish;f.setResponse(()=>new Promise(resolve=>{finish=resolve;}));f.api.mount(f.host);await flush();
 f.host.innerHTML='<h1>Employees</h1>';finish({ok:true,json:async()=>({items:[{message:'Private feedback'}],canReview:false,hasMore:false})});await flush();
 assert.equal(f.host.innerHTML,'<h1>Employees</h1>');assert.doesNotMatch(f.parts.get('[data-feedback-items]')?.innerHTML||'',/Private feedback/);f.api.unmount();
 f.api.mount(f.host,{preview:true});await flush();const calls=f.calls.length;f.events['soro-auth-changed']();assert.equal(f.host.innerHTML,'');assert.equal(f.calls.length,calls);
});
test('Feedback submission locks the draft and retries an uncertain receipt without duplicating it',async()=>{
 const f=browserFixture();f.api.mount(f.host);await flush();let finish;
 f.setResponse(()=>new Promise(resolve=>{finish=resolve;}));const first=f.listeners.submit({preventDefault(){}});await flush();
 assert.equal(f.fields.message.disabled,true);assert.equal(f.fields.category.disabled,true);const firstId=JSON.parse(f.calls.at(-1).options.body).requestId;
 finish({ok:false,json:async()=>({message:'Please retry.'})});await first;assert.equal(f.fields.message.value,'A local test suggestion');assert.equal(f.fields.message.disabled,false);
 f.setResponse(async(url,opt)=>({ok:true,json:async()=>opt.method==='POST'?{id:id(5)}:{items:[],canReview:false,hasMore:false}}));
 await f.listeners.submit({preventDefault(){}});const submitted=f.calls.filter(c=>c.options.method==='POST');assert.equal(JSON.parse(submitted.at(-1).options.body).requestId,firstId);assert.equal(f.fields.message.value,'');f.api.unmount();
});
