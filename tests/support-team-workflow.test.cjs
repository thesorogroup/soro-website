const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const api=require('../netlify/functions/support-tickets'),ui=require('../operations/support-tickets'),task=require('../operations/task-center');
const {content}=require('../netlify/functions/lib/confirmation-email');
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const base=()=>({ticketId:id(1),requestId:id(2),expectedVersion:1});
const parse=b=>api.parseChange({body:JSON.stringify(b)});
test('Ticket actions have exact allowlists and bounded values',()=>{
 for(const b of [{...base(),action:'reply',body:'Hello'},{...base(),action:'note',body:'Internal'},{...base(),action:'status',status:'waiting_on_client'},{...base(),action:'assign',team:'sales',assigneeId:null},{...base(),action:'claim'},{action:'read',ticketId:id(1),seenEntryId:1}])assert.deepEqual(parse(b),b);
 for(const b of [{...base(),action:'reply',body:''},{...base(),action:'note',body:'a'.repeat(5001)},{...base(),action:'note',body:'Safe',visibility:'public'},{...base(),action:'claim',actorUserId:id(3)},{...base(),action:'assign',team:'client',assigneeId:null},{...base(),action:'assign',team:'sales',assigneeId:'not-a-uuid'},{...base(),action:'status',status:'closed'},{...base(),action:'reply',body:'Hi',to:'outside@example.com'},{...base(),action:'reply',body:'Hi',expectedVersion:-1},{action:'read',ticketId:id(1),seenEntryId:-1}])assert.throws(()=>parse(b));
});
test('Client markup excludes internal entries without explicit staff read capability',()=>{
 const ticket={team:'sales',ticketNumber:'SUP-AABBCCDD',entries:[{visibility:'public',kind:'reply',body:'Public reply',createdAt:'2026-09-08'},{visibility:'internal',kind:'note',body:'SECRET NOTE',createdAt:'2026-09-08'}]};
 assert.doesNotMatch(ui.detailMarkup(ticket),/SECRET NOTE|Add a staff-only note|Save assignment|Update status/);
 assert.match(ui.detailMarkup({...ticket,canReadInternal:true}),/SECRET NOTE/);
 assert.doesNotMatch(ui.detailMarkup({...ticket,canReadInternal:true}),/Add a staff-only note/);
 const staff=ui.detailMarkup({...ticket,canReadInternal:true,canNote:true,canManage:true,isAdmin:true});assert.match(staff,/Staff-only|Save assignment|Update status/);
 assert.doesNotMatch(ui.detailMarkup({...ticket,subject:'<img onerror=x>',details:'<script>bad</script>'}),/<img|<script/);
});

test('Inbox rows surface requester, ownership, latest visible message and one open target',()=>{
 const ticket={ticketId:id(1),ticketNumber:'SUP-AABBCCDD',requesterName:'Avery <Client>',subject:'Help with onboarding',details:'Original issue',createdAt:'2026-09-01T10:00:00Z',lastActivityAt:'2026-09-07T12:00:00Z',team:'sales',status:'in_progress',assigneeName:'Jordan',unread:true,lastMessage:{visibility:'public',body:'Latest <reply>'}};
 const html=ui.ticketMarkup(ticket);assert.match(html,/Avery &lt;Client&gt;/);assert.match(html,/Jordan/);assert.match(html,/Latest &lt;reply&gt;/);assert.match(html,/Last activity/);assert.match(html,/Unread update/);assert.equal((html.match(/data-open-ticket=/g)||[]).length,1);
 const privateTicket={...ticket,lastMessage:{visibility:'internal',body:'SECRET NOTE'}};
 assert.doesNotMatch(ui.ticketMarkup(privateTicket),/SECRET NOTE|Staff-only note/);assert.match(ui.ticketMarkup(privateTicket),/Original issue/);
 assert.match(ui.ticketMarkup({...privateTicket,canReadInternal:true}),/Staff-only note · .*SECRET NOTE/);
 assert.doesNotMatch(ui.ticketMarkup({...ticket,team:'<script>',status:'<script>'}),/<script>/);
});

test('Status summary uses explicit server totals and explains its filter scope',()=>{
 const data={internal:true,isAdmin:true,summary:{open:105,in_progress:12,waiting_on_client:3,resolved:9},tickets:[{}]};
 const html=ui.summaryMarkup(data,{team:'sales',assignment:'unassigned',status:'open'});
 assert.match(html,/Sales · unassigned · all statuses/);assert.match(html,/<strong>105<\/strong>/);assert.equal((html.match(/data-ticket-status=/g)||[]).length,4);assert.equal((html.match(/aria-pressed="true"/g)||[]).length,1);
 const unavailable=ui.summaryMarkup({internal:false},{});assert.equal((unavailable.match(/<strong>—<\/strong>/g)||[]).length,4);assert.doesNotMatch(unavailable,/<strong>0<\/strong>/);
 assert.doesNotMatch(ui.summaryMarkup({...data,summary:{open:'<img onerror=x>'}}),/<img/);
});

test('Detail separates case controls from conversation and describes reopen behavior accurately',()=>{
 const t={status:'resolved',team:'sales',entries:[],canReply:true,canManage:true,isAdmin:true};
 const html=ui.detailMarkup(t);assert.match(html,/support-case-sidebar/);assert.match(html,/support-thread-main/);assert.match(html,/A new reply from the requester reopens/);assert.match(html,/Original request/);assert.match(html,/data-assignment-form/);
 assert.doesNotMatch(ui.detailMarkup({...t,canManage:false,isAdmin:false}),/data-status-form|data-assignment-form/);
 const css=fs.readFileSync(require.resolve('../operations/support.css'),'utf8');assert.match(css,/@media\(max-width:850px\)/);assert.match(css,/support-thread-main\{grid-row:2;grid-column:1\}/);assert.match(css,/prefers-reduced-motion/);
});
test('Support mail is generic and never embeds conversation or private content',()=>{
 for(const kind of ['support_ticket_reply','support_ticket_resolved','support_ticket_assigned']){const mail=content(kind,{ticketNumber:'SUP-AABBCCDD',body:'SECRET',note:'SECRET',subject:'SECRET',imageUrl:'SECRET'});assert.doesNotMatch(JSON.stringify(mail),/SECRET/);assert.match(mail.text,/SUP-AABBCCDD/);assert.match(mail.html,/not monitored/);assert.throws(()=>content(kind,{ticketNumber:'bad'}));}
});
test('Clients get support-only bell counts without enabling the employee task service',async t=>{
 const old={document:global.document,access:global.soroCurrentAccess};
 t.after(()=>{global.document=old.document;global.soroCurrentAccess=old.access;task.setSupportNotifications({unread:0});});
 const els={'notifications-count':{},'notifications-button':{setAttribute(k,v){this[k]=v;}},'notification-list':{}};
 global.document={getElementById:id=>els[id]||null};global.soroCurrentAccess={user_id:id(1),role:'client_admin'};
 await task.handleAuthChange({detail:{access:global.soroCurrentAccess}});task.setSupportNotifications({unread:3});
 assert.equal(task.canLoad('client_admin'),false);assert.equal(els['notifications-count'].textContent,'3');assert.equal(els['notifications-count'].hidden,false);
 assert.match(els['notification-list'].innerHTML,/data-notification-view="help"/);assert.doesNotMatch(els['notification-list'].innerHTML,/data-notification-id=|data-notification-view="tasks"/);
 task.setSupportNotifications({unread:0});assert.equal(els['notifications-count'].hidden,true);
});
test('Ticket endpoint derives actor, passes server filters, and rejects malformed mutation receipts',async t=>{
 const old={fetch:global.fetch,url:process.env.SUPABASE_URL,key:process.env.SUPABASE_SERVICE_ROLE_KEY};
 t.after(()=>{global.fetch=old.fetch;for(const [k,v] of [['SUPABASE_URL',old.url],['SUPABASE_SERVICE_ROLE_KEY',old.key]]){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
 process.env.SUPABASE_URL='https://example.supabase.co';process.env.SUPABASE_SERVICE_ROLE_KEY='test';let result={ticketId:id(1)},calls=[];
 global.fetch=async(url,opt)=>{calls.push({url,body:opt.body?JSON.parse(opt.body):null});return {ok:true,json:async()=>url.endsWith('/auth/v1/user')?{id:id(10)}:result};};
 const event={httpMethod:'PATCH',headers:{Authorization:'Bearer test'},body:JSON.stringify({...base(),action:'reply',body:'Hello'})};
 assert.equal((await api.handler(event)).statusCode,200);assert.equal(calls[1].body.p_actor_user_id,id(10));
 result=null;assert.equal((await api.handler(event)).statusCode,503);
 calls=[];result={tickets:[]};assert.equal((await api.handler({httpMethod:'GET',headers:event.headers,queryStringParameters:{offset:'50',status:'open',team:'sales',assignment:'unassigned'}})).statusCode,200);
 assert.match(calls[1].url,/list_support_workspace$/);assert.deepEqual(calls[1].body,{p_actor_user_id:id(10),p_offset:50,p_status:'open',p_team:'sales',p_assignment:'unassigned',p_view:'all',p_reason:''});
 assert.equal((await api.handler({httpMethod:'GET',headers:event.headers,queryStringParameters:{notifications:'1',ticketId:id(1)}})).statusCode,400);
});
test('Workflow schema closes legacy writes and returns strict authorization booleans',()=>{
 const sql=fs.readFileSync(require.resolve('../supabase/migrations/20260908_048_support_team_workflow.sql'),'utf8');
 assert.match(sql,/revoke insert,update,delete on public.support_tickets from authenticated/);assert.match(sql,/revoke all on public.support_entries,public.support_notifications,public.support_operations from public,anon,authenticated,service_role/);
 assert.match(sql,/return coalesce\(found/);assert.match(sql,/manager:=coalesce/);assert.match(sql,/if manager is not true/);assert.match(sql,/primary key\(ticket_id,recipient_user_id,visibility\)/);
 assert.match(sql,/join public.platform_users u on u.id=c.sales_owner_id/);assert.doesNotMatch(sql,/client_sales_contact|create_client/);assert.match(sql,/for update/);assert.match(sql,/expectedVersion/);
});
