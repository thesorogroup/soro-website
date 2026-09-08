const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const backend=require('../netlify/functions/support-tickets'),ui=require('../operations/support-tickets');
const dashboard=require('../operations/client-dashboard'),profile=require('../netlify/functions/client-profile');
const {content,SENDER}=require('../netlify/functions/lib/confirmation-email');
const {dispatch,handler:dispatchHandler}=require('../netlify/functions/portal-confirmations');
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const input=()=>({requestId:id(1),subject:'Example issue',area:backend.AREAS[0],details:'I need help signing in.'});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
test('Screenshot is optional; supported image bytes must match MIME and size',()=>{
  assert.equal(backend.parseImage(null),null);
  const image=backend.parseImage({type:'image/png',dataBase64:png.toString('base64')});assert.equal(image.extension,'png');assert.equal(image.bytes.length,png.length);assert.match(image.sha256,/^[a-f0-9]{64}$/);
  for(const value of [{type:'image/jpeg',dataBase64:png.toString('base64')},{type:'image/svg+xml',dataBase64:Buffer.from('<svg/>').toString('base64')},{type:'image/png',dataBase64:'!!!'},{type:'image/png',dataBase64:Buffer.alloc(backend.MAX_IMAGE_BYTES+1).toString('base64')},{type:'image/png',dataBase64:png.toString('base64'),storagePath:'other/client'}])assert.throws(()=>backend.parseImage(value));
});
test('Ticket inputs cannot inject identity, email recipient or storage path',()=>{
  assert.equal(backend.parseSubmission({body:JSON.stringify(input())}).image,null);
  assert.equal(backend.parseSubmission({body:JSON.stringify({...input(),requestId:'ABCDEF00-0000-4000-8000-000000000001'})}).requestId,'abcdef00-0000-4000-8000-000000000001');
  for(const extra of [{actorId:id(2)},{organizationId:id(3)},{to:'someone@example.com'},{storagePath:'private'},{requestId:'bad'},{subject:'a'},{details:'b'},{area:'Unknown'}])assert.throws(()=>backend.parseSubmission({body:JSON.stringify({...input(),...extra})}));
});
test('Upload UI uses optional file control and safely escaped ticket text',()=>{
  assert.match(ui.uploadMarkup(),/>Upload Image</);assert.doesNotMatch(ui.uploadMarkup(),/required/);assert.match(ui.uploadMarkup(),/3 MB/);
  const html=ui.ticketMarkup({ticketNumber:'SUP-AABBCCDD',subject:'<script>bad</script>',details:'<img onerror=bad>',createdAt:'2026-09-07',hasImage:true,ticketId:id(1)});
  assert.doesNotMatch(html,/<script>|<img/);assert.match(html,/View screenshot/);
});
test('Website accepts a bare domain, arbitrary alphabetic extension and paths',()=>{
  for(const value of ['example.com','www.example.org/path','business.photography','http://example.net','bücher.de'])assert.match(profile.normalizePatch({company:{website:value}},'client_admin').companyUpdates.website,/^https?:\/\//);
  for(const value of ['localhost','127.0.0.1','example','bad_host.com','-bad.com','https:/example.com','javascript:alert(1)','https://person:pass@example.com','a b.com'])assert.throws(()=>profile.normalizePatch({company:{website:value}},'client_admin'));
  assert.equal(profile.normalizePatch({company:{website:''}},'client_admin').companyUpdates.website,null);
});
const workspace=contact=>({generatedAt:'2026-09-07T12:00:00Z',viewerRole:'client_admin',companyName:'Example',contactName:'Avery',requests:[],interviews:[],talent:[],salesContact:contact});
test('Sales contact is allowlisted, optional, escaped and email links cannot inject headers',()=>{
  const clean=dashboard.normalizeWorkspace(workspace({name:'Jordan <Sales>',email:'rep@example.com?bcc=outside%40example.com',phone:'+1 214 555 0120',privateAddress:'SECRET'}));
  assert.equal('privateAddress' in clean.salesContact,false);
  const markup=dashboard.workspaceMarkup(clean);assert.match(markup,/Jordan &lt;Sales&gt;/);assert.match(markup,/mailto:rep%40example.com%3Fbcc%3Doutside%2540example.com/);assert.doesNotMatch(markup,/SECRET/);
  assert.equal(dashboard.normalizeWorkspace(workspace(null)).salesContact,null);
  assert.throws(()=>dashboard.normalizeWorkspace(workspace({name:'Rep',email:'',phone:'...'})));
});
test('Confirmation templates reuse Soro branding and exclude ticket text, screenshots and account values',()=>{
  for(const kind of ['support_ticket_created','client_profile_updated']){
    const email=content(kind,{ticketNumber:'SUP-AABBCCDD',subject:'SECRET',details:'SECRET',image:'SECRET',changedValue:'SECRET'});
    assert.match(email.html,/#082d5c/);assert.match(email.html,/soro-logo-final-transparent.png/);assert.match(email.html,/Open Soro Ops/);assert.doesNotMatch(JSON.stringify(email),/SECRET/);assert.match(email.text,/not monitored/);
  }
  assert.throws(()=>content('unknown'));assert.throws(()=>content('support_ticket_created',{ticketNumber:'<script>'}));
});
const row={outboxId:id(4),leaseToken:id(5),to:'client@example.com',eventType:'support_ticket_created',payload:{ticketNumber:'SUP-AABBCCDD'}};
test('Dispatcher sends only the durable snapshot and stable key',async()=>{
  const calls=[],saved=JSON.stringify({from:SENDER,to:[row.to],subject:'Saved original',text:'Original'});
  const result=await dispatch(row,{rpc:async(name,body)=>{calls.push({name,body});return name==='prepare_confirmation'?saved:{};},fetch:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({id:'provider-id'})};}},'test-key');
  assert.equal(result,'accepted');assert.equal(calls[1].options.body,saved);assert.equal(calls[1].options.headers['Idempotency-Key'],`soro-confirmation/${row.outboxId}`);assert.equal(calls[2].body.p_outcome,'sent');
});
test('No email leaves when snapshot preparation fails',async()=>{let sent=0;assert.equal(await dispatch(row,{rpc:async()=>{throw Error('lease');},fetch:async()=>{sent++;}},'test'),'not_prepared');assert.equal(sent,0);});
test('Network failures retry without failing a saved ticket, deterministic errors require review',async()=>{
  for(const scenario of ['timeout','reject']){let completion;
    const result=await dispatch(row,{rpc:async(name,body)=>{if(name==='prepare_confirmation')return '{}';completion=body;return {};},fetch:async()=>{if(scenario==='timeout')throw Error('network');return{ok:false,status:422,json:async()=>({name:'validation_error'})};}},'test');
    assert.equal(result,scenario==='timeout'?'retry':'review');assert.equal(completion.p_outcome,result);
  }
});
test('Confirmation dispatcher requires the compact explicit opt-in and key',async t=>{
  const names=['SORO_RECEIPTS','RESEND_API_KEY','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','PORTAL_CONFIRMATIONS_ENABLED','PORTAL_CONFIRMATION_FROM_EMAIL'];
  const previous=Object.fromEntries(names.map(name=>[name,process.env[name]])),oldFetch=global.fetch;
  t.after(()=>{global.fetch=oldFetch;for(const name of names){if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];}});
  process.env.SUPABASE_URL='https://example.supabase.co';process.env.SUPABASE_SERVICE_ROLE_KEY='test';
  process.env.PORTAL_CONFIRMATIONS_ENABLED='true';process.env.PORTAL_CONFIRMATION_FROM_EMAIL='do-not-reply@thesorogroup.com';
  let claims=0;
  global.fetch=async(url,options)=>{assert.equal(url,'https://example.supabase.co/rest/v1/rpc/claim_confirmation_outbox');assert.deepEqual(JSON.parse(options.body),{p_limit:3});claims++;return {ok:true,json:async()=>[]};};
  for(const [flag,key] of [[undefined,'test'],['','test'],['0','test'],['true','test'],[' 1','test'],['1',''],['1',undefined]]){
    if(flag===undefined)delete process.env.SORO_RECEIPTS;else process.env.SORO_RECEIPTS=flag;
    if(key===undefined)delete process.env.RESEND_API_KEY;else process.env.RESEND_API_KEY=key;
    assert.match((await dispatchHandler()).body,/disabled/);
  }
  assert.equal(claims,0,'disabled or legacy settings must not claim queued mail');
  process.env.SORO_RECEIPTS='1';process.env.RESEND_API_KEY='test';
  process.env.PORTAL_CONFIRMATION_FROM_EMAIL='unapproved@example.com';
  assert.equal((await dispatchHandler()).body,'Confirmation batch processed');assert.equal(claims,1);
  assert.equal(SENDER,'Soro Group <do-not-reply@thesorogroup.com>');
});
test('Support route uses server-derived actor and keeps malformed receipts retryable',async t=>{
  const oldFetch=global.fetch,oldUrl=process.env.SUPABASE_URL,oldKey=process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL='https://example.supabase.co';process.env.SUPABASE_SERVICE_ROLE_KEY='test';
  t.after(()=>{global.fetch=oldFetch;for(const [key,value] of [['SUPABASE_URL',oldUrl],['SUPABASE_SERVICE_ROLE_KEY',oldKey]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  const calls=[];let bad=false;
  global.fetch=async(url,options)=>{calls.push({url,options});return{ok:true,json:async()=>url.endsWith('/auth/v1/user')?{id:id(10)}:url.endsWith('authorize_support_image_upload')?{organizationId:id(20),requesterUserId:id(10)}:bad?null:{ticketId:id(30),ticketNumber:'SUP-AABBCCDD',hasImage:false}};};
  const event={httpMethod:'POST',headers:{Authorization:'Bearer test'},body:JSON.stringify(input())};
  assert.equal((await backend.handler(event)).statusCode,200);assert.equal(JSON.parse(calls[2].options.body).p_actor_user_id,id(10));
  bad=true;assert.equal((await backend.handler(event)).statusCode,503);
});
test('Forward migrations keep screenshot storage and mail queue private',()=>{
  const sql=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20260907_046_support_images_confirmations.sql'),'utf8');
  assert.match(sql,/soro-support-images','soro-support-images',false,3145728/);assert.match(sql,/revoke insert on public.support_tickets from authenticated/);assert.match(sql,/revoke all on public.confirmation_outbox from public,anon,authenticated,service_role/);assert.match(sql,/auth.role\(\) is distinct from 'service_role'/);assert.match(sql,/email_confirmed_at is not null/);
  const dispatchSql=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20260907_047_confirmation_dispatch.sql'),'utf8');assert.match(dispatchSql,/for update skip locked/);assert.match(dispatchSql,/interval '23 hours'/);assert.match(dispatchSql,/if q.request_body is not null then return q.request_body/);
});
