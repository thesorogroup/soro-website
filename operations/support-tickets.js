/* Optional private screenshots and retry-safe ticket submissions. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.SoroSupportTickets=api;}(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  const MAX_BYTES=3*1024*1024,ENDPOINT='/.netlify/functions/support-tickets';
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const emptyFilters=()=>({status:'',team:'',assignment:'',offset:0,view:'all',reason:''});
  let node=null,version=0,options={},mountedActor='',selectedTicket=null,workspace=null,detailVersion=0,bindings=null,filters=emptyFilters();
  const STATUSES={open:'New',in_progress:'In progress',waiting_on_client:'Waiting on client',resolved:'Resolved',closed:'Resolved'};
  const TEAMS={sales:'Sales',talent_management:'Talent Management',admin:'Admin'};
  function pendingRequest(actor,hash,remove=false){
    const key=`soro-support-pending:${actor}`;let records=[];
    try{records=JSON.parse(root.sessionStorage?.getItem(key)||'[]');}catch{}
    if(!Array.isArray(records))records=[];
    records=records.filter(item=>item&&typeof item.hash==='string'&&/^[a-f0-9]{64}$/.test(item.hash)&&/^[0-9a-f-]{36}$/.test(item.id||'')&&Number.isFinite(item.at)&&Date.now()-item.at<86400000).slice(-10);
    let record=records.find(item=>item.hash===hash);
    if(remove)records=records.filter(item=>item.hash!==hash);
    else if(!record){record={hash,id:root.crypto.randomUUID(),at:Date.now()};records.push(record);}
    try{root.sessionStorage?.setItem(key,JSON.stringify(records));}catch{}
    return record?.id;
  }
  function uploadMarkup(){return `<fieldset class="support-image-field"><legend>Screenshot <span>Optional</span></legend><input type="file" id="support-image" accept="image/png,image/jpeg,image/webp" hidden><div class="support-image-actions"><button type="button" class="button" data-upload-image>Upload Image</button><button type="button" class="button" data-remove-image hidden>Remove</button></div><p data-image-name>No image selected</p><small>PNG, JPG, or WebP · up to 3 MB. Remove passwords and private information before uploading. Only you and authorized Soro support staff can open the image.</small></fieldset>`;}
  const initials=value=>String(value||'Requester').trim().split(/\s+/).slice(0,2).map(s=>s[0]).join('').toUpperCase();
  function timestamp(value,compact=false){const d=new Date(value);if(!value||!Number.isFinite(d.getTime()))return 'Not available';return d.toLocaleString(undefined,{month:'short',day:'numeric',...(compact?{}:{year:'numeric'}),hour:'numeric',minute:'2-digit'});}
  function statusMarkup(status){const key=status==='closed'?'resolved':Object.hasOwn(STATUSES,status)?status:'open';return `<span class="support-status support-status--${key}"><span aria-hidden="true"></span>${escape(STATUSES[key])}</span>`;}
  function teamMarkup(team){const key=Object.hasOwn(TEAMS,team)?team:'admin';return `<span class="support-team support-team--${key}">${escape(TEAMS[key])}</span>`;}
  function elapsed(value,now=Date.now()){
    const start=Date.parse(value);if(!Number.isFinite(start)||!Number.isFinite(now))return 'Time unavailable';
    const minutes=Math.max(0,Math.floor((now-start)/60000));
    if(minutes<1)return 'Just now';if(minutes<60)return `${minutes}m`;
    const hours=Math.floor(minutes/60);if(hours<24)return `${hours}h${minutes%60?` ${minutes%60}m`:''}`;
    return `${Math.floor(hours/24)}d${hours%24?` ${hours%24}h`:''}`;
  }
  function attentionMarkup(ticket){
    const a=ticket.canReadInternal===true?ticket.attention:null;if(!a?.needsAttention)return '';
    return `<span class="support-attention-reasons">${a.unassigned?'<span>Unassigned</span>':''}${a.awaitingReply?'<span>Awaiting Soro reply</span>':''}</span><span class="support-wait-time" title="Waiting since ${escape(timestamp(a.since))}"><strong>${escape(elapsed(a.since))}</strong> waiting</span>`;
  }
  function viewMarkup(data,current={}){
    if(!data.internal)return '';
    const total=data.attentionSummary?.total,selected=current.view==='attention';
    return `<div class="support-views" role="group" aria-label="Support inbox view"><button type="button" data-ticket-view="all" aria-pressed="${!selected}">All tickets</button><button type="button" data-ticket-view="attention" aria-pressed="${selected}">Needs Attention${Number.isSafeInteger(total)&&total>=0?` <span>${total}</span>`:''}</button></div>${selected?'<p class="support-attention-help">Unassigned requests and people awaiting a Soro reply. Oldest waiting first; elapsed time, not a response deadline.</p>':''}`;
  }
  function ticketMarkup(ticket,attentionView=false){
    const latest=ticket.lastMessage,privateMessage=latest?.visibility==='internal'&&ticket.canReadInternal===true;
    const message=latest&&(latest.visibility==='public'||privateMessage)?latest:null;
    const excerpt=String(message?.body||ticket.details||'Open this ticket to view the request.').replace(/\s+/g,' ').slice(0,190);
    return `<article class="support-ticket-row${ticket.unread?' is-unread':''}"><button type="button" class="support-ticket-open" data-open-ticket="${escape(ticket.ticketId)}" aria-label="Open ${escape(ticket.ticketNumber)}: ${escape(ticket.subject)}"><span class="support-avatar" aria-hidden="true">${escape(initials(ticket.requesterName))}</span><span class="support-row-main"><span class="support-row-identity"><span>${escape(ticket.requesterName||'Requester')}</span><span class="support-ticket-number">${escape(ticket.ticketNumber)}</span></span><strong class="support-ticket-subject">${escape(ticket.subject)}</strong><span class="support-excerpt">${privateMessage?'<span class="support-private-label">Staff-only note · </span>':message?'<span class="support-excerpt-label">Latest reply · </span>':''}${escape(excerpt)}</span><span class="support-row-meta">${teamMarkup(ticket.team)}<span class="support-owner${ticket.assigneeName?'':' is-unassigned'}">${escape(ticket.assigneeName||'Unassigned')}</span>${ticket.hasImage?'<span class="support-attachment-label">Screenshot attached</span>':''}</span></span><span class="support-row-trailing">${statusMarkup(ticket.status)}${attentionView===true?attentionMarkup(ticket):''}${ticket.unread?'<span class="support-unread">Unread update</span>':''}<span class="support-activity"><span>Last activity</span><span>${escape(timestamp(ticket.lastActivityAt||ticket.createdAt,true))}</span></span><span class="support-row-arrow" aria-hidden="true">↗</span></span></button></article>`;
  }
  function summaryMarkup(data,current={}){
    const scope=[current.team?TEAMS[current.team]:(data.isAdmin?'All accessible queues':data.internal?'Your accessible tickets':'Your tickets'),current.assignment==='mine'?'assigned to you':current.assignment==='unassigned'?'unassigned':'all assignments'].filter(Boolean).join(' · ');
    return `<section class="support-overview" aria-label="Ticket status overview"><div class="support-overview-label"><span>At a glance</span><span>${escape(scope)} · all statuses</span></div><div class="support-summary">${Object.entries(STATUSES).filter(([s])=>s!=='closed').map(([s,label])=>`<button type="button" class="support-summary-card support-summary--${s}${current.status===s?' is-selected':''}" data-ticket-status="${s}" aria-pressed="${current.status===s}"><span>${escape(label)}</span><strong>${Number.isSafeInteger(data.summary?.[s])&&data.summary[s]>=0?data.summary[s]:'—'}</strong><small>${({open:'Ready for a first look',in_progress:'Being worked on',waiting_on_client:'Awaiting requester response',resolved:'Marked complete'})[s]}</small></button>`).join('')}</div></section>`;
  }
  function nextStep(t){
    if(t.status==='resolved'||t.status==='closed')return {title:'This ticket is resolved',text:t.canReply?'The conversation stays available. A new reply from the requester reopens this ticket.':'The conversation is kept here for reference.'};
    if(t.canClaim)return {title:'Ready for an owner',text:'Assign this ticket to yourself to reply and move the work forward. The team can still follow the conversation.'};
    if(t.status==='waiting_on_client')return {title:'Waiting for the requester',text:t.canReadInternal===true?'The next step is a response from the person who opened this ticket.':'The Soro team needs more information. Add your reply below to continue.'};
    if(t.canManage)return {title:'You can move this forward',text:'Reply with the next step, update the status, or keep a staff-only note for your team.'};
    return {title:t.canReadInternal===true?'Following with your team':'Your request is with Soro',text:t.canReadInternal===true?`${t.assigneeName||'The assigned owner'} handles replies and status changes. Your whole team can follow this ticket.`:'You can follow updates here and add more information at any time.'};
  }
  function detailMarkup(t){
    const visible=(t.entries||[]).filter(e=>e.visibility==='public'||(e.visibility==='internal'&&t.canReadInternal===true));
    const replies=visible.filter(e=>e.kind==='reply').length,next=nextStep(t);
    const entries=visible.filter(e=>e.kind!=='created').map(e=>{
      const system=['status','assignment'].includes(e.kind),body=e.body||({status:`Status changed to ${STATUSES[e.status]||'New'}`,assignment:`Assigned to ${e.assigneeName||'the team queue'} · ${TEAMS[e.team]||'Admin'}`}[e.kind]||'Ticket updated');
      return `<article class="support-entry${e.visibility==='internal'?' support-private':''}${system?' support-system-entry':''}"><div class="support-entry-heading">${!system?`<span class="support-avatar support-avatar--small" aria-hidden="true">${escape(initials(e.authorName||'Soro'))}</span>`:''}<strong>${escape(e.authorName||'Soro')}</strong>${e.visibility==='internal'?'<span class="support-private-label">Staff-only</span>':''}<time>${escape(timestamp(e.createdAt))}</time></div><p>${escape(body)}</p></article>`;
    }).join('');
    return `<div class="support-detail-nav"><button class="button" type="button" data-back-tickets>← Back to inbox</button><button class="button support-quiet-button" type="button" data-refresh-thread>Refresh</button></div><header class="support-detail-heading"><div class="support-detail-kicker"><span>${escape(t.ticketNumber)}</span>${teamMarkup(t.team)}${statusMarkup(t.status)}</div><h2 tabindex="-1" data-detail-title>${escape(t.subject)}</h2><p>Opened by <strong>${escape(t.requesterName||'Requester')}</strong> · ${escape(timestamp(t.createdAt))}</p></header><div class="support-detail-layout"><aside class="support-case-sidebar" aria-label="Ticket information and controls"><section class="support-next-step"><span class="support-section-label">Next step</span><h3>${escape(next.title)}</h3><p>${escape(next.text)}</p>${t.canClaim?'<button class="button primary" type="button" data-claim-ticket>Assign to me</button>':''}</section><section class="support-case-facts"><h3>Ticket details</h3><dl><div><dt>Team</dt><dd>${teamMarkup(t.team)}</dd></div><div><dt>Assigned to</dt><dd>${escape(t.assigneeName||'Unassigned team queue')}</dd></div><div><dt>Issue type</dt><dd>${escape(t.area||'Not specified')}</dd></div><div><dt>Last activity</dt><dd>${escape(timestamp(t.lastActivityAt||t.createdAt))}</dd></div></dl></section><div class="support-management">${t.canManage?`<form data-status-form><h3>Update progress</h3><label>Status<select name="status">${Object.entries(STATUSES).filter(([s])=>s!=='closed').map(([s,label])=>`<option value="${s}" ${s===t.status?'selected':''}>${label}</option>`).join('')}</select></label><button class="button" type="submit">Update status</button></form>`:''}${t.isAdmin?`<form data-assignment-form><h3>Assignment</h3><p class="support-field-help">Admin oversight · move this ticket to the right team or owner.</p><label>Team<select name="team">${Object.entries(TEAMS).map(([value,label])=>`<option value="${value}" ${value===t.team?'selected':''}>${label}</option>`).join('')}</select></label><label>Employee<select name="assigneeId" data-assignee-select><option value="">Unassigned team queue</option>${(t.assignees||[]).filter(a=>a.team===t.team||a.team==='admin').map(a=>`<option value="${escape(a.id)}" ${a.id===t.assigneeId?'selected':''}>${escape(a.name)}</option>`).join('')}</select></label><button class="button" type="submit">Save assignment</button></form>`:''}</div></aside><section class="support-thread-main" aria-label="Ticket conversation"><div class="support-thread-title"><h3>Conversation</h3><span>${replies} ${replies===1?'reply':'replies'}</span></div><article class="support-original"><div class="support-entry-heading"><span class="support-avatar support-avatar--small" aria-hidden="true">${escape(initials(t.requesterName))}</span><strong>${escape(t.requesterName||'Requester')}</strong><span class="support-section-label">Original request</span></div><p>${escape(t.details)}</p>${t.hasImage?`<button class="button support-screenshot-button" data-ticket-image="${escape(t.ticketId)}" type="button">View screenshot ↗</button>`:''}</article><div class="support-conversation">${entries||'<p class="support-no-replies">No replies yet. Updates will appear here.</p>'}</div><p class="support-ticket-error" data-thread-feedback role="status"></p>${t.canReply?`<form class="support-form support-reply-composer" data-reply-form><label>Reply to this ticket<span class="support-visibility">Visible to the requester and the support team</span><textarea name="body" required maxlength="5000" placeholder="Write a helpful update or the next step…"></textarea></label><div class="support-composer-footer"><span>Replies stay with this conversation.</span><button class="button primary" type="submit">Send reply</button></div></form>`:''}${t.canNote?`<details class="support-note-composer"><summary>Add a staff-only note</summary><form class="support-form" data-note-form><p>Only this ticket’s authorized team and Admin can read these notes. They are never emailed to the requester.</p><label>Private note<textarea name="body" required maxlength="5000" placeholder="Add context for your team…"></textarea></label><button class="button" type="submit">Save private note</button></form></details>`:''}</section></div>`;
  }
  async function request(method,body,query=''){
    const requestVersion=version,requestActor=mountedActor;
    if(options.request)return options.request(method,body,query);
    const session=await root.soroSupabase?.auth.getSession();
    if(requestVersion!==version)throw new Error('Your account view changed. Please try again.');
    if(requestActor&&session?.data?.session?.user?.id!==requestActor)throw new Error('Your signed-in account changed. Please refresh.');
    if(!session?.data?.session?.access_token)throw new Error('Sign in again to continue.');
    const response=await root.fetch(ENDPOINT+query,{method,headers:{Authorization:`Bearer ${session.data.session.access_token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),cache:'no-store',signal:AbortSignal.timeout(55000)});
    const result=await response.json();
    if(!response.ok)throw new Error(result.message||'Support is unavailable. Please retry.');
    return result;
  }
  function readImage(file){return new Promise((resolve,reject)=>{
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>MAX_BYTES||!file.size)return reject(new Error('Choose a PNG, JPG, or WebP image up to 3 MB.'));
    const reader=new root.FileReader();reader.onerror=()=>reject(new Error('The image could not be read. Choose it again.'));reader.onload=()=>resolve({type:file.type,dataBase64:String(reader.result).split(',')[1]});reader.readAsDataURL(file);
  });}
  async function loadTickets(captured){
    const list=node?.querySelector('[data-ticket-list]'),generation=++detailVersion;if(!list)return;selectedTicket=null;
    const previousFocus=root.document?.activeElement,focusFilter=previousFocus?.dataset?.ticketFilter,focusStatus=previousFocus?.dataset?.ticketStatus,focusView=previousFocus?.dataset?.ticketView;
    try{
      const data=await request('GET',null,'?'+new URLSearchParams(filters));if(captured!==version||generation!==detailVersion||!node?.isConnected)return;if(!Array.isArray(data?.tickets))throw Error();workspace=data;
      const filtered=Boolean(filters.status||filters.team||filters.assignment||filters.reason),attentionView=data.internal&&filters.view==='attention',total=Number.isSafeInteger(data.total)?data.total:null;
      if(total!==null&&filters.offset>0&&filters.offset>=total){filters.offset=total?Math.floor((total-1)/50)*50:0;return loadTickets(captured);}
      const restoreInboxFocus=root.document?.activeElement===previousFocus;
      list.classList.remove('is-ticket-detail');
      list.innerHTML=`${summaryMarkup(data,filters)}${viewMarkup(data,filters)}<div class="support-inbox-heading"><div><h2>${attentionView?'Needs Attention':data.internal?'Support inbox':'Your tickets'}</h2><p>${data.isAdmin?'Oversee every team queue and keep each request moving.':data.internal?'Your team’s tickets stay visible, even when an owner is assigned.':'Follow your requests and keep the conversation in one place.'}</p></div><button type="button" class="button support-quiet-button" data-refresh-tickets>Refresh</button></div><div class="support-filters">${attentionView?'<label>Needs attention for<select data-ticket-filter="reason"><option value="">Any reason</option><option value="unassigned">Unassigned</option><option value="awaiting_reply">Awaiting Soro reply</option></select></label>':`<label>Status<select data-ticket-filter="status"><option value="">All statuses</option>${Object.entries(STATUSES).filter(([s])=>s!=='closed').map(([s,label])=>`<option value="${s}">${label}</option>`).join('')}</select></label>`}${data.internal?`<label>Team queue<select data-ticket-filter="team"><option value="">All accessible queues</option>${Object.entries(TEAMS).filter(([team])=>data.isAdmin||team===data.team).map(([team,label])=>`<option value="${team}">${label}</option>`).join('')}</select></label><label>Assigned to<select data-ticket-filter="assignment"><option value="">Everyone</option><option value="unassigned">Unassigned</option><option value="mine">Assigned to me</option></select></label>`:''}${filtered?'<button type="button" class="button support-quiet-button" data-reset-ticket-filters>Clear filters</button>':''}</div><div class="support-list-caption"><span>${total===null?'Tickets':`${total} ${total===1?'ticket':'tickets'}`}${filtered?' match your filters':''}</span><span>${attentionView?'Oldest waiting first':'Most recent activity first'}</span></div><div data-ticket-rows>${data.tickets.length?data.tickets.map(t=>ticketMarkup(t,attentionView)).join(''):`<div class="support-empty"><span class="support-empty-mark" aria-hidden="true">✓</span><h3>${filtered?'No tickets match these filters':attentionView?'Nothing needs attention right now':'No tickets here yet'}</h3><p>${filtered?'Try another reason, status, queue, or owner to find the request you need.':attentionView?'No unassigned requests or unanswered messages in this queue.':'New support requests and their updates will appear here.'}</p>${filtered?'<button type="button" class="button" data-reset-ticket-filters>Clear filters</button>':'<button type="button" class="button" data-new-ticket>Create a support ticket</button>'}</div>`}</div><div class="support-pagination"><span>${total===null?'':total?`Showing ${filters.offset+1}–${filters.offset+data.tickets.length} of ${total}`:'0 tickets'}</span><div><button type="button" class="button" data-ticket-page="previous" ${filters.offset===0?'disabled':''}>Previous</button><span>Page ${Math.floor(filters.offset/50)+1}</span><button type="button" class="button" data-ticket-page="next" ${data.hasMore?'':'disabled'}>Next</button></div></div>`;
      list.querySelectorAll('[data-ticket-filter]').forEach(el=>el.value=filters[el.dataset.ticketFilter]||'');
      if(restoreInboxFocus&&focusFilter)list.querySelector(`[data-ticket-filter="${focusFilter}"]`)?.focus();else if(restoreInboxFocus&&focusView)list.querySelector(`[data-ticket-view="${focusView}"]`)?.focus();else if(restoreInboxFocus&&focusStatus)list.querySelector(`[data-ticket-status="${focusStatus}"]`)?.focus();
      const announcement=node.querySelector('[data-support-announcement]');if(announcement)announcement.textContent=`${total===null?'Support inbox updated.':`${total} tickets found.`}`;refreshNotifications();
    }
    catch{if(captured===version&&generation===detailVersion&&node?.isConnected)list.innerHTML='<div class="support-empty"><h2>The inbox could not be loaded</h2><p role="status">Please retry. You can still use New ticket to submit a request.</p><button type="button" class="button" data-refresh-tickets>Retry</button></div>';}
  }
  async function openTicket(id,captured,focusHeading=true){
    const list=node?.querySelector('[data-ticket-list]'),requestDetail=++detailVersion;if(!list)return;
    try{
      const t=await request('GET',null,`?ticketId=${encodeURIComponent(id)}`);if(captured!==version||requestDetail!==detailVersion||!node?.isConnected)return;
      if(t?.ticketId!==id||!Array.isArray(t.entries)||!Number.isSafeInteger(t.version)||!Number.isSafeInteger(t.seenEntryId)||typeof t.canReadInternal!=='boolean')throw Error('Ticket details could not be verified. Please refresh.');
      // Read drafts only after the response, including typing during a slow refresh.
      const drafts=selectedTicket?.ticketId===id?[...list.querySelectorAll('[data-reply-form] textarea,[data-note-form] textarea')].map(el=>({kind:el.closest('[data-note-form]')?'note':'reply',value:el.value})):[];
      const active=root.document?.activeElement,activeForm=active?.closest?.('[data-reply-form],[data-note-form],[data-status-form],[data-assignment-form]');
      const focusForm=activeForm?.hasAttribute('data-reply-form')?'reply':activeForm?.hasAttribute('data-note-form')?'note':activeForm?.hasAttribute('data-status-form')?'status':activeForm?'assignment':null,refreshFocused=active?.hasAttribute?.('data-refresh-thread');
      selectedTicket=t;list.classList.add('is-ticket-detail');list.innerHTML=detailMarkup(t);
      for(const d of drafts){const input=list.querySelector(`[data-${d.kind}-form] textarea`);if(input){input.value=d.value;if(d.kind==='note'&&d.value)input.closest('details').open=true;}}
      if(focusHeading)list.querySelector('[data-detail-title]')?.focus();else if(focusForm){if(focusForm==='note')list.querySelector('.support-note-composer')?.setAttribute('open','');list.querySelector(`[data-${focusForm}-form] textarea,[data-${focusForm}-form] select`)?.focus();}else if(refreshFocused)list.querySelector('[data-refresh-thread]')?.focus();
      await request('PATCH',{action:'read',ticketId:id,seenEntryId:t.seenEntryId});if(captured===version)refreshNotifications();
    }
    catch(error){if(captured===version&&requestDetail===detailVersion){const feedback=list.querySelector('[data-thread-feedback]');if(feedback)feedback.textContent=error.message;else list.innerHTML=`<button class="button" data-back-tickets>← All tickets</button><p role="status">${escape(error.message)}</p>`;}}
  }
  function unmount(){version++;detailVersion++;bindings?.abort();bindings=null;node=null;options={};mountedActor='';selectedTicket=null;workspace=null;filters=emptyFilters();}
  function mount(container,config={}){
    unmount();node=container;options=config;bindings=new root.AbortController();const listenerOptions={signal:bindings.signal};mountedActor=root.soroCurrentAccess?.user_id||'';const captured=version,actor=mountedActor;
    if(config.initialView==='attention')filters.view='attention';
    const form=node.querySelector('#help-ticket-form');if(!form)return;
    const areas=['Sales, services and client accounts','Talent profiles and documents','Client records and placements','Sign-in and account access','Tasks and notifications','Billing and administrative questions','Other technical issue'];
    form.elements.area.innerHTML='<option value="" disabled selected>Choose an issue</option>'+areas.map(area=>`<option>${area}</option>`).join('');form.elements.area.required=true;
    form.elements.subject.minLength=3;form.elements.details.minLength=5;form.elements.details.maxLength=5000;
    form.querySelector('[type="submit"]').insertAdjacentHTML('beforebegin',uploadMarkup());
    const grid=node.querySelector('.support-grid');
    grid.insertAdjacentHTML('beforebegin','<section class="support-new-ticket" id="support-new-ticket" hidden aria-label="New support ticket"></section><p class="support-announcement" data-support-announcement role="status"></p><section class="panel support-tickets-list" data-ticket-list>Loading tickets…</section>');
    node.querySelector('.support-new-ticket').appendChild(grid);
    node.querySelector('.page-heading')?.insertAdjacentHTML('beforeend','<button type="button" class="button primary support-new-button" data-new-ticket aria-controls="support-new-ticket" aria-expanded="false">New ticket <span aria-hidden="true">＋</span></button>');
    const input=form.querySelector('#support-image'),name=form.querySelector('[data-image-name]'),remove=form.querySelector('[data-remove-image]'),confirmation=form.querySelector('#ticket-confirmation');
    let submission=null,busy=false;
    form.querySelector('[data-upload-image]').addEventListener('click',()=>input.click());
    input.addEventListener('change',()=>{name.textContent=input.files[0]?.name||'No image selected';remove.hidden=!input.files.length;});
    remove.addEventListener('click',()=>{input.value='';name.textContent='No image selected';remove.hidden=true;});
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(busy||captured!==version||!form.reportValidity())return;
      busy=true;const creationGeneration=detailVersion;const submit=form.querySelector('[type="submit"]');form.querySelectorAll('input,select,textarea,button').forEach(control=>control.disabled=true);submit.textContent='Submitting…';confirmation.textContent='';
      try{
        const image=input.files[0]?await readImage(input.files[0]):null;
        if(captured!==version)return;
        const intent={subject:form.elements.subject.value.trim(),area:form.elements.area.value,details:form.elements.details.value.trim(),image};
        const digest=await root.crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(intent)));
        if(captured!==version)return;
        const fingerprint=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
        if(!submission||submission.fingerprint!==fingerprint)submission={requestId:pendingRequest(actor,fingerprint),fingerprint};
        const result=await request('POST',{requestId:submission.requestId,...intent});
        if(captured!==version||!node?.isConnected)return;
        if(!result||!/^SUP-[A-F0-9]{8}$/.test(result.ticketNumber||'')||typeof result.hasImage!=='boolean')throw new Error('The receipt could not be verified. Retry without changing this ticket.');
        pendingRequest(actor,fingerprint,true);
        form.reset();submission=null;name.textContent='No image selected';remove.hidden=true;
        confirmation.className='ticket-confirmation';confirmation.textContent=`Ticket ${result.ticketNumber} submitted${result.hasImage?' with your screenshot':''}. The Soro support team can now review it.`;
        if(creationGeneration===detailVersion)loadTickets(captured);else refreshNotifications();
      }catch(error){if(captured===version){confirmation.className='support-ticket-error';confirmation.textContent=error.name==='TimeoutError'?'The connection timed out. Retry without changing the ticket to safely check the same submission.':error.message;}}
      finally{busy=false;form.querySelectorAll('input,select,textarea,button').forEach(control=>control.disabled=false);submit.textContent='Submit support ticket';}
    });
    node.addEventListener('click',async event=>{
      if(captured!==version)return;
      if(event.target.closest?.('[data-new-ticket]')){const panel=node.querySelector('.support-new-ticket');panel.hidden=!panel.hidden;const trigger=node.querySelector('.page-heading [data-new-ticket]');trigger?.setAttribute('aria-expanded',String(!panel.hidden));if(!panel.hidden)form.elements.subject.focus();return;}
      const view=event.target.closest?.('[data-ticket-view]');if(view&&workspace?.internal){filters={...filters,view:view.dataset.ticketView,status:'',reason:'',offset:0};loadTickets(captured);return;}
      const shortcut=event.target.closest?.('[data-ticket-status]');if(shortcut){filters.view='all';filters.reason='';filters.status=filters.status===shortcut.dataset.ticketStatus?'':shortcut.dataset.ticketStatus;filters.offset=0;loadTickets(captured);return;}
      if(event.target.closest?.('[data-reset-ticket-filters]')){filters={...emptyFilters(),view:filters.view};loadTickets(captured);return;}
      const open=event.target.closest?.('[data-open-ticket]');if(open){openTicket(open.dataset.openTicket,captured);return;}
      if(event.target.closest?.('[data-refresh-thread]')&&selectedTicket){openTicket(selectedTicket.ticketId,captured,false);return;}
      const page=event.target.closest?.('[data-ticket-page]');if(page&&!page.disabled){filters.offset=Math.max(0,filters.offset+(page.dataset.ticketPage==='next'?50:-50));loadTickets(captured);return;}
      if(event.target.closest?.('[data-back-tickets],[data-refresh-tickets]')){loadTickets(captured);return;}
      if(event.target.closest?.('[data-claim-ticket]')){mutate({action:'claim'},event.target.closest('[data-claim-ticket]'));return;}
      const button=event.target.closest?.('[data-ticket-image]');if(!button||button.disabled||captured!==version)return;
      const opened=root.open('about:blank','_blank');if(opened)opened.opener=null;
      button.disabled=true;
      try{const result=await request('GET',null,`?imageTicketId=${encodeURIComponent(button.dataset.ticketImage)}`);if(captured!==version){opened?.close();return;}const url=new URL(result.url);if(url.protocol!=='https:'||!url.hostname.endsWith('.supabase.co'))throw new Error('Screenshot link could not be verified.');if(opened)opened.location.replace(url.href);else throw new Error('Allow pop-ups, then select View screenshot again.');}
      catch(error){opened?.close();const feedback=node?.querySelector('[data-thread-feedback]');if(feedback)feedback.textContent=error.message;else{confirmation.textContent=error.message;confirmation.className='support-ticket-error';node.querySelector('.support-new-ticket').hidden=false;node.querySelector('.page-heading [data-new-ticket]')?.setAttribute('aria-expanded','true');}}
      finally{button.disabled=false;}
    },listenerOptions);
    let mutationBusy=false;
    async function mutate(change,control){
      if(mutationBusy||!selectedTicket||captured!==version)return;mutationBusy=true;
      const t=selectedTicket,generation=detailVersion,feedback=node.querySelector('[data-thread-feedback]'),controls=[...node.querySelector('[data-ticket-list]').querySelectorAll('input,select,textarea,button[type="submit"],[data-claim-ticket]')];if(feedback)feedback.textContent='';controls.forEach(el=>el.disabled=true);
      try{const intent={...change,ticketId:t.ticketId,expectedVersion:t.version},digest=await root.crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(intent)));if(captured!==version)return;const hash=Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');const result=await request('PATCH',{...intent,requestId:pendingRequest(actor,hash)});if(captured!==version)return;if(result?.ticketId!==t.ticketId)throw Error('The update could not be verified. Retry this same action.');pendingRequest(actor,hash,true);if(generation===detailVersion&&selectedTicket?.ticketId===t.ticketId){if(['reply','note'].includes(change.action)){const saved=node.querySelector(`[data-${change.action}-form] textarea`);if(saved)saved.value='';}await openTicket(t.ticketId,captured,false);}else refreshNotifications();}
      catch(error){if(captured===version&&feedback?.isConnected)feedback.textContent=error.message;}
      finally{mutationBusy=false;controls.forEach(el=>el.disabled=false);}
    }
    node.addEventListener('submit',event=>{
      if(captured!==version)return;
      const f=event.target;if(!f.matches('[data-reply-form],[data-note-form],[data-status-form],[data-assignment-form]'))return;
      event.preventDefault();if(!f.reportValidity())return;
      const change=f.matches('[data-reply-form]')?{action:'reply',body:f.elements.body.value}:f.matches('[data-note-form]')?{action:'note',body:f.elements.body.value}:f.matches('[data-status-form]')?{action:'status',status:f.elements.status.value}:{action:'assign',team:f.elements.team.value,assigneeId:f.elements.assigneeId.value||null};
      mutate(change,f.querySelector('[type="submit"]'));
    },listenerOptions);
    node.addEventListener('change',event=>{
      if(captured!==version)return;
      if(event.target.matches('[data-assignment-form] [name="team"]')){const select=node.querySelector('[data-assignee-select]');select.innerHTML='<option value="">Unassigned team queue</option>'+(selectedTicket?.assignees||[]).filter(a=>a.team===event.target.value||a.team==='admin').map(a=>`<option value="${escape(a.id)}">${escape(a.name)}</option>`).join('');}
      if(event.target.matches('[data-ticket-filter]')){filters={...filters,...Object.fromEntries([...node.querySelectorAll('[data-ticket-filter]')].map(el=>[el.dataset.ticketFilter,el.value])),offset:0};loadTickets(captured);}
    },listenerOptions);
    loadTickets(captured);
  }
  let notificationVersion=0;
  async function refreshNotifications(){
    const seq=++notificationVersion,access=root.soroCurrentAccess;if(!access?.user_id){root.soroTaskCenter?.setSupportNotifications?.({unread:0});return;}
    try{const session=await root.soroSupabase?.auth.getSession();if(seq!==notificationVersion||session?.data?.session?.user?.id!==access.user_id||root.soroCurrentAccess?.user_id!==access.user_id)return;const response=await root.fetch(ENDPOINT+'?notifications=1',{headers:{Authorization:`Bearer ${session.data.session.access_token}`},cache:'no-store',signal:AbortSignal.timeout(12000)});if(!response.ok)throw Error();const data=await response.json();if(seq===notificationVersion&&root.soroCurrentAccess?.user_id===access.user_id)root.soroTaskCenter?.setSupportNotifications?.(data);}
    catch{if(seq===notificationVersion)root.soroTaskCenter?.setSupportNotifications?.({unread:0});}
  }
  root.addEventListener?.('soro-auth-changed',()=>{notificationVersion++;root.soroTaskCenter?.setSupportNotifications?.({unread:0});refreshNotifications();});
  if(root.document){root.addEventListener?.('focus',refreshNotifications);root.setInterval?.(()=>{if(root.document.visibilityState!=='hidden')refreshNotifications();},30000);}
  // The owning enhancement renderer invalidates this module before each route
  // or auth render. A second auth listener here would clear its new Help view.
  return Object.freeze({uploadMarkup,ticketMarkup,detailMarkup,summaryMarkup,attentionMarkup,viewMarkup,elapsed,readImage,pendingRequest,mount,unmount,refreshNotifications,MAX_BYTES,STATUSES,TEAMS});
}));
