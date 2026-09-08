const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const ui=require('../operations/support-tickets'),api=require('../netlify/functions/support-tickets');
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('Attention view is staff-only, uses server totals and has explicit toggle state',()=>{
 assert.equal(ui.viewMarkup({internal:false,attentionSummary:{total:10}}), '');
 const html=ui.viewMarkup({internal:true,attentionSummary:{total:103}},{view:'attention'});
 assert.match(html,/Needs Attention <span>103<\/span>/);assert.match(html,/data-ticket-view="attention" aria-pressed="true"/);
 assert.match(html,/elapsed time, not a response deadline/);
 assert.doesNotMatch(ui.viewMarkup({internal:true}),/<span>0<\/span>/);
 assert.doesNotMatch(ui.viewMarkup({internal:true,attentionSummary:{total:'<img>'}}),/<img>/);
});
test('Attention wait labels are readable, bounded and handle missing timestamps',()=>{
 const now=Date.parse('2026-09-08T12:00:00Z');
 assert.equal(ui.elapsed('2026-09-08T11:59:50Z',now),'Just now');
 assert.equal(ui.elapsed('2026-09-08T11:35:00Z',now),'25m');
 assert.equal(ui.elapsed('2026-09-08T10:35:00Z',now),'1h 25m');
 assert.equal(ui.elapsed('2026-09-06T10:00:00Z',now),'2d 2h');
 assert.equal(ui.elapsed('2026-09-09T12:00:00Z',now),'Just now');
 assert.equal(ui.elapsed('invalid',now),'Time unavailable');
});
test('Attention reasons never render for requester-only access',()=>{
 const t={ticketId:id(1),canReadInternal:true,attention:{needsAttention:true,unassigned:true,awaitingReply:true,since:'2026-09-01T12:00:00Z'}};
 assert.match(ui.attentionMarkup(t),/Unassigned/);assert.match(ui.attentionMarkup(t),/Awaiting Soro reply/);
 assert.equal(ui.attentionMarkup({...t,canReadInternal:false}),'');assert.equal(ui.attentionMarkup({...t,attention:{needsAttention:false}}),'');
 assert.doesNotMatch(ui.ticketMarkup(t),/support-wait-time/);assert.match(ui.ticketMarkup(t,true),/support-wait-time/);
 assert.doesNotMatch(ui.attentionMarkup({...t,attention:{...t.attention,since:'<script>bad</script>'}}),/<script>/);
 assert.equal((ui.ticketMarkup(t,true).match(/data-open-ticket=/g)||[]).length,1);
});
test('Attention GET validates view/reason and derives the actor from the session',async t=>{
 const before={fetch:global.fetch,url:process.env.SUPABASE_URL,key:process.env.SUPABASE_SERVICE_ROLE_KEY};
 t.after(()=>{global.fetch=before.fetch;for(const [k,v] of [['SUPABASE_URL',before.url],['SUPABASE_SERVICE_ROLE_KEY',before.key]]){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
 process.env.SUPABASE_URL='https://example.supabase.co';process.env.SUPABASE_SERVICE_ROLE_KEY='test';let calls=[];
 global.fetch=async(url,opt)=>{calls.push({url,body:opt.body?JSON.parse(opt.body):null});return {ok:true,json:async()=>url.endsWith('/auth/v1/user')?{id:id(1)}:{tickets:[]}};};
 const get=query=>api.handler({httpMethod:'GET',headers:{Authorization:'Bearer test'},queryStringParameters:query});
 assert.equal((await get({view:'attention',reason:'awaiting_reply',team:'sales',assignment:'mine',offset:'50'})).statusCode,200);
 assert.deepEqual(calls[1].body,{p_actor_user_id:id(1),p_offset:50,p_status:'',p_team:'sales',p_assignment:'mine',p_view:'attention',p_reason:'awaiting_reply'});
 for(const query of [{view:'admin'},{view:'attention',reason:'overdue'},{view:'all',reason:'unassigned'},{view:'attention',status:'open'},{view:'attention',notifications:'1'},{view:'attention',actorUserId:id(2)}]){
  calls=[];assert.equal((await get(query)).statusCode,400);assert.equal(calls.length,1);
 }
});
test('Attention migration has no data backfill and keeps all grants service-only',()=>{
 const sql=fs.readFileSync(require.resolve('../supabase/migrations/20260908_049_support_needs_attention.sql'),'utf8');
 assert.match(sql,/where private.support_staff\(a,s\)/);assert.match(sql,/if staff then r:=r\|\|jsonb_build_object/);
 assert.match(sql,/actor_user_id<>t.requester_user_id/);assert.match(sql,/e.seq>last_soro order by e.seq limit 1/);
 assert.match(sql,/order by waiting_since,\(ticket\).id limit 50 offset p_offset/);
 assert.match(sql,/grant execute on function public.list_support_workspace\(uuid,integer,text,text,text,text,text\) to service_role/);
 assert.doesNotMatch(sql,/insert into|update public.support_tickets|enqueue_confirmation|grant .* to authenticated/i);
 assert.match(sql,/initial_owner_recorded boolean not null default false/);
 assert.match(sql,/new.assigned_to_user_id/);
});
test('Mounted inbox switches views, keeps filters through back navigation, and resets status shortcuts',async()=>{
 const vm=require('node:vm'),source=fs.readFileSync(require.resolve('../operations/support-tickets'),'utf8');
 const noop=()=>{},generic={insertAdjacentHTML:noop,appendChild:noop,addEventListener:noop,focus:noop},listeners={},calls=[];
 const form={...generic,elements:{area:{},subject:{},details:{}},querySelector:()=>generic};
 const list={innerHTML:'',classList:{remove:noop,add:noop},querySelectorAll:()=>[],querySelector:()=>null};
 const container={isConnected:true,querySelector:q=>q==='#help-ticket-form'?form:q==='[data-ticket-list]'?list:generic,querySelectorAll:()=>[],addEventListener:(type,fn)=>{listeners[type]=fn;}};
 const context={console,URLSearchParams,AbortController,document:{activeElement:null},soroCurrentAccess:{user_id:id(1)},addEventListener:noop};
 vm.createContext(context);vm.runInContext(source,context);
 const ticket={ticketId:id(2),team:'sales',status:'open',canReadInternal:true,attention:{needsAttention:true,unassigned:true,awaitingReply:true,since:'2026-09-01T12:00:00Z'}};
 let release;const request=async(method,body,query)=>{const params=new URLSearchParams(query);calls.push(Object.fromEntries(params));if(params.get('ticketId'))return {...ticket,entries:[],version:1,seenEntryId:0};if(method==='PATCH')return {ticketId:ticket.ticketId};if(params.get('reason')==='unassigned')await new Promise(resolve=>release=resolve);return {internal:true,isAdmin:true,summary:{open:1},attentionSummary:{total:1},tickets:[ticket],total:1};};
 context.SoroSupportTickets.mount(container,{request});const settle=()=>new Promise(setImmediate);await settle();
 assert.match(list.innerHTML,/Most recent activity first/);assert.equal(calls[0].view,'all');
 const click=async(selector,dataset={})=>{await listeners.click({target:{closest:q=>q.split(',').includes(selector)?{dataset}:null}});await settle();};
 await click('[data-ticket-view]',{ticketView:'attention'});assert.equal(calls.at(-1).view,'attention');assert.match(list.innerHTML,/Oldest waiting first/);assert.match(list.innerHTML,/data-ticket-filter="reason"/);assert.doesNotMatch(list.innerHTML,/data-ticket-filter="status"/);
 await click('[data-open-ticket]',{openTicket:ticket.ticketId});await click('[data-back-tickets]');assert.equal(calls.at(-1).view,'attention');
 await click('[data-ticket-status]',{ticketStatus:'resolved'});assert.equal(calls.at(-1).view,'all');assert.equal(calls.at(-1).status,'resolved');assert.equal(calls.at(-1).reason,'');
 // A late response for the old view must not overwrite a newly selected one.
 await click('[data-ticket-view]',{ticketView:'attention'});
 container.querySelectorAll=()=>[{dataset:{ticketFilter:'reason'},value:'unassigned'}];
 listeners.change({target:{matches:q=>q==='[data-ticket-filter]'}});await settle();
 await click('[data-ticket-view]',{ticketView:'all'});release();await settle();assert.match(list.innerHTML,/Most recent activity first/);assert.doesNotMatch(list.innerHTML,/Oldest waiting first<\/span>/);
 context.SoroSupportTickets.unmount();
});
