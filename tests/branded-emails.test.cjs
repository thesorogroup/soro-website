'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {firstName, greeting, renderEmail, accessEmail, interviewEmail} = require('../netlify/functions/lib/branded-email');
const {content} = require('../netlify/functions/lib/confirmation-email');
const {templates, managementPatch} = require('../netlify/functions/lib/auth-email-templates');
const {dispatch} = require('../netlify/functions/portal-confirmations');
const Module = require('node:module');

// Expose only in this isolated test module, not in the deployed function exports.
function loadSender(t, file, localFunction) {
  const previous=Object.fromEntries(['RESEND_API_KEY','APPLICATION_FROM_EMAIL','APPLICATION_NOTIFICATION_EMAIL','TALENT_ACCESS_FROM_EMAIL','CLIENT_ACCESS_FROM_EMAIL','CLIENT_ACCESS_LINK_TTL_SECONDS'].map(key=>[key,process.env[key]]));
  for(const key of Object.keys(previous))process.env[key]=key==='RESEND_API_KEY'?'test-only-key':key==='CLIENT_ACCESS_LINK_TTL_SECONDS'?'3600':key==='APPLICATION_NOTIFICATION_EMAIL'?'internal-notice@example.com':'Soro Group <sender@example.com>';
  t.after(()=>{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  const filename=path.join(__dirname,'../netlify/functions',file);
  const mod=new Module(filename,module);mod.filename=filename;mod.paths=Module._nodeModulePaths(path.dirname(filename));
  mod._compile(fs.readFileSync(filename,'utf8')+`\nexports.testSender=${localFunction};`,filename);
  return mod.exports.testSender;
}

test('Names use current given names and exactly one greeting comma', () => {
  for (const [person, expected] of [
    ['Garin, Gabriel', 'Gabriel'], ['Garin,, Gabriel', 'Gabriel'], ['Gabriel Garin', 'Gabriel'],
    ['Gabriel Garin, Jr.', 'Gabriel'], ['Garin, Gabriel, Jr.', 'Gabriel'], ['Dr. Gabriel Garin', 'Gabriel'],
    ['Santos, Mariel Anne', 'Mariel'], ['Dela Cruz, José-Luis', 'José-Luis'], ["O’Neil, Anne-Marie", 'Anne-Marie'],
    [{firstName:'John Paul,', full_name:'Wrong Name'}, 'John Paul'],
    [{preferred_name:'Charlie Anne',full_name:'Garin, Gabriel'}, 'Charlie Anne'],
    [{full_name:'Garin, Gabriel',legacy_application_data:{first_name:'Wrong'}}, 'Gabriel'],
    ['   ', ''], [null, ''], ['person@example.com',''], ['<img src=x onerror=alert(1)>',''], ['N/A',''],
    ['Garin,',''],['Not recorded',''],['Not shared',''],[{preferred_name:'J. P.'},'']
  ]) {
    assert.equal(firstName(person), expected, JSON.stringify(person));
    assert.equal(greeting(person), expected ? `Hi ${expected},` : 'Hello,');
    assert.doesNotMatch(greeting(person), /,,/);
  }
});
test('Talent and Client setup/reset use the brand, correct greeting, link and private warning', () => {
  const link='https://project.supabase.co/auth/v1/verify?token=safe-test&type=recovery';
  for(const audience of ['Talent','Client']) for(const kind of ['setup','password_reset']) {
    const email=accessEmail({audience,kind,person:{full_name:'Garin, Gabriel'},actionLink:link});
    assert.match(email.html,/Hi Gabriel,/);assert.match(email.text,/Hi Gabriel,/);
    assert.doesNotMatch(email.html,/Hi Garin|,,/);assert.match(email.html,/#082d5c/);
    assert.match(email.html,/soro-logo-final-transparent.png/);assert.ok(email.html.includes('<!--[if mso]>'));
    assert.match(email.text,/Do not forward this secure one-use link/);
    assert.ok(email.text.includes(link));assert.ok(email.html.length<20000);
    assert.ok(email.html.includes('token=safe-test&amp;type=recovery'));
    assert.match(email.subject,new RegExp(`Soro ${audience} Portal`));
  }
});
test('Shared renderer escapes content and rejects non-HTTPS action links', () => {
  const email=renderEmail({subject:'"<script>', title:'<img>', paragraphs:['<script>alert(1)</script>'], reference:'<secret>', steps:[['<heading>','<detail>']],action:{label:'<go>',url:'https://example.com/?x="'},note:'<note>'});
  assert.doesNotMatch(email.html, /<script|<secret>|<heading>|<detail>|<note>/);
  assert.match(email.html,/&lt;script&gt;/);
  for(const url of ['javascript:alert(1)','http://example.com','https://user:pass@example.com']) assert.throws(()=>renderEmail({subject:'Test',title:'Test',action:{label:'Open',url}}));
});
test('All confirmation events reuse brand and accept only separately resolved names', () => {
  for(const kind of ['support_ticket_created','support_ticket_reply','support_ticket_resolved','support_ticket_assigned','client_profile_updated','client_shortlist_ready','client_shortlist_response']) {
    const email=content(kind,{ticketNumber:'SUP-AABBCCDD',firstName:'INJECTED',person:{firstName:'INJECTED'}},{fullName:'Garin, Gabriel'});
    assert.match(email.html,/Hi Gabriel,/);assert.match(email.text,/Hi Gabriel,/);assert.doesNotMatch(email.html,/INJECTED/);
    assert.match(email.html,/soro-logo-final-transparent.png/);assert.ok(Buffer.byteLength(JSON.stringify(email))<50000);
  }
});
test('Confirmation names are lease-resolved only for first preparation; retries keep exact bytes', async () => {
  const row={outboxId:'outbox',leaseToken:'lease',eventType:'client_profile_updated',to:'example@example.com',payload:{firstName:'FORGED'}};
  let saved;const methods=[];const bodies=[];
  const deps={rpc:async(name,body)=>{methods.push(name);if(name==='get_confirmation_greeting')return {fullName:'Garin, Gabriel'};if(name==='prepare_confirmation')return saved||=(body.p_request_body);return {};},fetch:async(url,options)=>{bodies.push(options.body);return {ok:true,json:async()=>({id:'safe-test-id'})};}};
  assert.equal(await dispatch(row,deps,'test'),'accepted');
  assert.match(saved,/Hi Gabriel,/);assert.doesNotMatch(saved,/FORGED/);
  assert.equal(await dispatch({...row,requestBody:saved},deps,'test'),'accepted');
  assert.equal(methods.filter(name=>name==='get_confirmation_greeting').length,1);assert.equal(bodies[0],bodies[1]);
});
test('Failed greeting authorization never emits an email', async () => {
  let sent=false;
  const result=await dispatch({outboxId:'x',leaseToken:'y'},{rpc:async()=>{throw Error('not authorized');},fetch:async()=>{sent=true;}},'test');
  assert.equal(result,'not_prepared');assert.equal(sent,false);
});
test('All thirteen native Auth templates are branded without changing notification flags or auth tokens', () => {
  const all=templates();assert.equal(Object.keys(all).length,13);
  for(const [key,email] of Object.entries(all)) {
    assert.match(email.html,/soro-logo-final-transparent.png/);assert.match(email.html,/Hello,/);
    assert.doesNotMatch(email.html,/\.Data|SORO_AUTH_TOKEN_PLACEHOLDER|soro-email-link\.invalid/);
    if(key==='reauthentication')assert.match(email.html,/{{ \.Token }}/);
    else if(!key.endsWith('_notification'))assert.match(email.html,/href="{{ \.ConfirmationURL }}"/);
    assert.ok(email.html.length<20000);
  }
  assert.ok(Object.keys(managementPatch()).every(key=>/^mailer_(subjects_|templates_)/.test(key)));
});
test('Interview bodies use branding without personalizing a multi-recipient invitation', () => {
  for(const audience of ['Talent','Client']) {
    const email=interviewEmail(audience);assert.match(email.html,/soro-logo-final-transparent.png/);
    assert.match(email.html,/Microsoft Teams/);assert.doesNotMatch(email.html,/Hi |not monitored|token=/);
  }
});
test('Every application-owned email sender imports the shared renderer', () => {
  for(const file of ['talent-portal-access.js','client-portal-access.js','talent-application.js','talent-verification.js','client-placement-workflow.js']) {
    const src=fs.readFileSync(path.join(__dirname,'../netlify/functions',file),'utf8');
    assert.match(src,/require\('\.\/lib\/branded-email'\)/);assert.doesNotMatch(src,/const firstName = .*split/);
  }
});

test('Talent sender and Client durable payload actually render Gabriel correctly', async t => {
  const talentSend=loadSender(t,'talent-portal-access.js','sendAccessEmail');
  const clientPayload=loadSender(t,'client-portal-access.js','accessEmailPayload');
  const oldFetch=global.fetch;const bodies=[];
  t.after(()=>{global.fetch=oldFetch;});
  global.fetch=async(url,options)=>{assert.equal(url,'https://api.resend.com/emails');bodies.push(JSON.parse(options.body));return {ok:true,json:async()=>({id:'test-only'})};};
  const args={to:'preview@example.com',actionLink:'https://test.supabase.co/auth/v1/verify?token=not-real&type=recovery',kind:'setup'};
  await talentSend({...args,applicant:{full_name:'Garin, Gabriel'}});
  bodies.push(clientPayload({...args,contact:{full_name:'Garin, Gabriel'}}));
  for(const body of bodies){assert.match(body.html,/Hi Gabriel,/);assert.match(body.text,/Hi Gabriel,/);assert.match(body.html,/soro-logo-final-transparent.png/);assert.deepEqual(body.to,['preview@example.com']);}
});

test('Application receipt comes from the Talent mailbox while internal notice routing stays unchanged', async t => {
  const send=loadSender(t,'talent-application.js','sendApplicationNotifications');
  const oldFetch=global.fetch;const bodies=[];t.after(()=>{global.fetch=oldFetch;});
  global.fetch=async(url,options)=>{assert.equal(url,'https://api.resend.com/emails');bodies.push(JSON.parse(options.body));return {ok:true,json:async()=>({id:'test-only'})};};
  await send({firstName:'Gabriel,',lastName:'Garin',email:'gabriel@example.com'});
  const receipt=bodies.find(body=>body.to[0]==='gabriel@example.com');
  const internal=bodies.find(body=>body.to[0]!=='gabriel@example.com');
  assert.match(receipt.html,/Hi Gabriel,/);assert.doesNotMatch(receipt.html,/,,/);assert.equal(internal.reply_to,'gabriel@example.com');
  assert.equal(receipt.from,'The Soro Group <talents@thesorogroup.com>');
  assert.equal(receipt.reply_to,'talents@thesorogroup.com');
  assert.equal(internal.from,'Soro Group <sender@example.com>');
  assert.deepEqual(internal.to,['internal-notice@example.com']);
  assert.match(receipt.text,/Please reply with your preferred interview date and time/);
  assert.match(receipt.html,/Philippine Time \(UTC\+08:00\)/);
  for(const body of bodies) {assert.match(body.html,/soro-logo-final-transparent.png/);assert.equal(body.attachments,undefined);}
});

test('Greeting migration is service-only and read-only without backfilling or modifying queued messages', () => {
  const sql=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20260908_054_email_recipient_greeting.sql'),'utf8');
  assert.match(sql,/auth.role\(\) is distinct from 'service_role'/);
  assert.match(sql,/private.support_confirmation_allowed\(q\) is distinct from true/);
  assert.match(sql,/q.lease_token is distinct from p_lease_token/);
  assert.match(sql,/lower\(btrim\(u.email\)\)=q.recipient_email/);
  assert.match(sql,/revoke all on function public.get_confirmation_greeting\(uuid,uuid\) from public,anon,authenticated/);
  assert.doesNotMatch(sql,/\b(?:insert into|update public\.|delete from|create trigger|grant select)\b/i);
});
