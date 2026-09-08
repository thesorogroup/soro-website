'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {content,SENDER}=require('../netlify/functions/lib/confirmation-email');
const {dispatch}=require('../netlify/functions/portal-confirmations');
const {publicEmailDelivery}=require('../netlify/functions/client-shortlists');
const ui=require('../operations/client-shortlist-workflow');
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('Both review emails keep fixed branding, safe role links and no submitted data',()=>{
  for(const [kind,route] of [['client_shortlist_ready','client-candidate-review'],['client_shortlist_response','client-shortlists']]){
    const value=content(kind,{candidate:'SECRET',client:'SECRET',html:'<script>SECRET</script>',url:'https://evil.example',to:'SECRET',ticketNumber:'SECRET'});
    assert.match(value.html,/#082d5c/);assert.match(value.html,/soro-logo-final-transparent.png/);
    assert.match(value.html,new RegExp(`https://thesorogroup.com/operations/#${route}`));
    assert.ok(value.text.includes(`#${route}`));assert.doesNotMatch(JSON.stringify(value),/SECRET|evil\.example|<script/);
    assert.match(value.text,/not monitored/);assert.ok(value.html.length<50000);assert.ok(value.subject.length<100);
  }
  assert.equal(SENDER,'Soro Group <do-not-reply@thesorogroup.com>');
  assert.match(content('client_shortlist_response',{requestId:id(1)}).html,new RegExp(`#client-placement/${id(1)}`));
  assert.match(content('client_shortlist_ready',{requestId:id(1)}).html,new RegExp(`#client-candidate-review/${id(1)}`));
  assert.throws(()=>content('client_shortlist_ready',{requestId:'javascript:alert(1)'}));
});
test('New emails use existing durable dispatch and retry the exact original body',async()=>{
  const row={outboxId:id(1),leaseToken:id(2),eventType:'client_shortlist_ready',to:'example@example.com',payload:{}};
  let snapshot,requests=[];
  const deps={rpc:async(name,p)=>{if(name==='prepare_confirmation')return snapshot||=(p.p_request_body);return {};},fetch:async(url,opt)=>{requests.push(opt);return {ok:requests.length>1,status:requests.length>1?200:503,json:async()=>({id:'sample-provider-id'})};}};
  assert.equal(await dispatch(row,deps,'test-key'),'retry');
  assert.equal(await dispatch({...row,eventType:'client_shortlist_response',requestBody:snapshot},deps,'test-key'),'accepted');
  assert.equal(requests[0].body,requests[1].body);assert.equal(requests[0].headers['Idempotency-Key'],requests[1].headers['Idempotency-Key']);
});
test('Email progress projection permits only authorized shortlist counts',()=>{
  const row={shortlistId:id(1),clientCount:2,salesCount:1,sentCount:1,pendingCount:1,reviewCount:1,lastSentAt:'2026-09-08T12:00:00Z',to:'PRIVATE',requestBody:'PRIVATE',leaseToken:'PRIVATE'};
  assert.doesNotMatch(JSON.stringify(publicEmailDelivery([row],[{shortlistId:id(1)}])),/PRIVATE/);
  for(const bad of [{...row,shortlistId:id(2)},{...row,pendingCount:-1},{...row,sentCount:1.5},{...row,salesCount:5}])assert.throws(()=>publicEmailDelivery([bad],[{shortlistId:id(1)}]));
  assert.throws(()=>publicEmailDelivery([row,row],[{shortlistId:id(1)}]));
});
test('Client-mode normalization never keeps staff delivery metadata',()=>{
  const result=ui.normalizePayload({viewerRole:'client_admin',requests:[],shortlists:[],candidates:[],notifications:[],emailDeliveries:[{to:'PRIVATE'}],emailDeliveryUnavailable:true},'client_admin','client');
  assert.deepEqual(result.emailDeliveries,[]);assert.equal(result.emailDeliveryUnavailable,false);
});
test('Migration only hooks future inserts and preserves service-only delivery access',()=>{
  const sql=fs.readFileSync(require('node:path').join(__dirname,'../supabase/migrations/20260908_050_shortlist_emails.sql'),'utf8');
  assert.match(sql,/after insert on public.client_shortlist_notifications/);
  assert.match(sql,/after insert on public.client_candidate_decisions/);
  assert.match(sql,/when\(new.decision='passed'\)/);assert.doesNotMatch(sql,/insert into public.confirmation_outbox|update public.confirmation_outbox|grant select/i);
  assert.match(sql,/w:=public.get_client_shortlist_workspace/);assert.match(sql,/revoke all on function public.get_client_shortlist_email_delivery\(uuid,uuid\) from public,anon,authenticated/);
});

test('Candidate-review email route survives initial load and browser history navigation',()=>{
  const source=fs.readFileSync(require('node:path').join(__dirname,'../operations/operations.js'),'utf8');
  const history=source.slice(source.indexOf("window.addEventListener('popstate'"),source.indexOf('function applyRole'));
  assert.match(history,/else if\(reviewMatch\).*preferredHiringRequestId=reviewMatch\[1\].*current='client-candidate-review'/);
  assert.match(source,/else if\(initialReviewHash\).*current='client-candidate-review'.*preferredHiringRequestId=initialReviewHash\[1\]/);
});
