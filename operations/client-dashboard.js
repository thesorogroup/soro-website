/* Client home: live, company-scoped summaries with links to existing workflows. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SoroClientDashboard = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const ENDPOINT = '/.netlify/functions/client-dashboard';
  const ROLES = new Set(['client_admin', 'client_reviewer', 'client_billing']);
  const STATUS = Object.freeze({draft:'Getting started',discovery:'Confirming your needs',open:'Finding candidates',sourcing:'Finding candidates',shortlisting:'Preparing candidates',client_review:'Candidate review',interviewing:'Interviews',selection_pending:'Selection recorded',placement_pending:'Preparing placement',partially_filled:'Matching remaining seats',filled:'Team in place',on_hold:'On hold',cancelled:'Closed'});
  const COUNTS = ['seatCount','candidateCount','pendingReviewCount','pendingDecisionCount','placementCount','activePlacementCount','onboardingCount'];
  let target=null, options={}, workspace=null, controller=null, generation=0;
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
  function invalid() { throw new Error('Your dashboard response could not be verified. Please refresh.'); }
  function text(value,max=180) { if(typeof value!=='string'||value.length>max)invalid(); return value.trim(); }
  function uuid(value) { if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value||''))invalid(); return value.toLowerCase(); }
  function date(value,day=false) { if(value===null)return null; if(typeof value!=='string'||value.length>40||!Number.isFinite(Date.parse(value))||(day&&(!/^\d{4}-\d{2}-\d{2}$/.test(value)||new Date(`${value}T12:00:00Z`).toISOString().slice(0,10)!==value)))invalid(); return value; }
  function joinUrl(value) { if(!value)return null; try { const url=new URL(value); return url.protocol==='https:'&&!url.username&&!url.password&&['teams.microsoft.com','teams.live.com'].includes(url.hostname)?url.href:null; } catch { return null; } }
  function list(value,key,normalize) { if(!Array.isArray(value)||value.length>1000)invalid(); const rows=value.map(normalize); if(new Set(rows.map(row=>row[key])).size!==rows.length)invalid(); return Object.freeze(rows); }
  function normalizeWorkspace(payload,expectedRole) {
    if(!payload||!ROLES.has(payload.viewerRole)||(expectedRole&&payload.viewerRole!==expectedRole))invalid();
    const data={generatedAt:date(payload.generatedAt),viewerRole:payload.viewerRole,companyName:text(payload.companyName),contactName:text(payload.contactName)};
    if(!data.generatedAt||!data.companyName)invalid();
    const contact=payload.salesContact;
    data.salesContact=contact?Object.freeze({name:text(contact.name),email:text(contact.email||'',254),phone:text(contact.phone||'',40)}):null;
    if(data.salesContact&&(!data.salesContact.name||(data.salesContact.email&&!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(data.salesContact.email))||(data.salesContact.phone&&(!/^[+\d(). x-]{3,40}$/i.test(data.salesContact.phone)||!/[0-9]/.test(data.salesContact.phone)))))invalid();
    data.requests=list(payload.requests,'requestId',raw=>{
      if(!raw||!Object.hasOwn(STATUS,raw.status))invalid();
      const row={requestId:uuid(raw.requestId),roleTitle:text(raw.roleTitle),status:raw.status,targetStartDate:date(raw.targetStartDate,true)};
      for(const key of COUNTS){if(!Number.isSafeInteger(raw[key])||raw[key]<0||raw[key]>1000000)invalid(); row[key]=raw[key];}
      if(!row.roleTitle||row.seatCount<1||row.pendingReviewCount+row.pendingDecisionCount>row.candidateCount||row.activePlacementCount+row.onboardingCount>row.placementCount)invalid();
      return Object.freeze(row);
    });
    data.interviews=list(payload.interviews,'interviewId',raw=>{
      const row={interviewId:uuid(raw.interviewId),requestId:uuid(raw.requestId),roleTitle:text(raw.roleTitle),candidateName:text(raw.candidateName),startsAt:date(raw.startsAt),endsAt:date(raw.endsAt),timezone:text(raw.timezone,100),joinUrl:joinUrl(raw.joinUrl)};
      if(!row.startsAt||!row.endsAt||Date.parse(row.endsAt)<=Date.parse(row.startsAt)||!data.requests.some(request=>request.requestId===row.requestId))invalid();
      try { new Intl.DateTimeFormat('en-US',{timeZone:row.timezone}); } catch { invalid(); }
      return Object.freeze(row);
    });
    data.talent=list(payload.talent,'placementId',raw=>{
      if(!['placement_confirmed','onboarding','active'].includes(raw.status))invalid();
      return Object.freeze({placementId:uuid(raw.placementId),applicantId:uuid(raw.applicantId),fullName:text(raw.fullName),preferredName:text(raw.preferredName||''),roleTitle:text(raw.roleTitle),status:raw.status,startDate:date(raw.startDate,true),scheduleSummary:text(raw.scheduleSummary||'',1000)});
    });
    if(data.viewerRole==='client_billing'&&(data.requests.length||data.interviews.length||data.talent.length))invalid();
    if(data.viewerRole==='client_reviewer'&&data.requests.some(row=>row.pendingDecisionCount))invalid();
    return Object.freeze(data);
  }
  function formatDate(value,timeZone) {
    if(!value)return 'To be confirmed';
    const day=/^\d{4}-\d{2}-\d{2}$/.test(value);
    return new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric',...(day?{}:{hour:'numeric',minute:'2-digit',timeZoneName:'short',...(timeZone?{timeZone}: {})})}).format(new Date(day?`${value}T12:00:00`:value));
  }
  function totals(data,now=Date.now()) {
    return {review:data.requests.reduce((sum,row)=>sum+row.pendingReviewCount,0),decisions:data.requests.reduce((sum,row)=>sum+row.pendingDecisionCount,0),interviews:data.interviews.filter(row=>Date.parse(row.endsAt)>now).length,requests:data.requests.filter(row=>!['filled','cancelled'].includes(row.status)).length,talent:new Set(data.talent.map(row=>row.applicantId)).size};
  }
  function actionButton(action,id,label,primary=false) { return `<button type="button" class="client-home-button${primary?' is-primary':''}" data-home-action="${action}"${id?` data-home-id="${escapeHtml(id)}"`:''}>${escapeHtml(label)}<span aria-hidden="true"> →</span></button>`; }
  function requestMarkup(row,viewerRole) {
    const pending=row.pendingReviewCount>0;
    const decision=viewerRole==='client_admin'&&row.pendingDecisionCount>0;
    const closed=['on_hold','cancelled'].includes(row.status);
    const message=pending?`${row.pendingReviewCount} candidate${row.pendingReviewCount===1?' is':'s are'} ready for your review.`:decision?`${row.pendingDecisionCount} candidate${row.pendingDecisionCount===1?' is':'s are'} ready for your decision.`:row.status==='filled'&&row.activePlacementCount>=row.seatCount?'Your team is active.':row.onboardingCount?`${row.onboardingCount} placement${row.onboardingCount===1?' is':'s are'} in onboarding.`:row.placementCount?`${row.placementCount} of ${row.seatCount} seat${row.seatCount===1?'':'s'} confirmed.`:closed?'Contact Soro if you would like to discuss this request.':row.candidateCount?'Your Soro team is coordinating the next step.':'Your Soro team will share candidates here when they are ready.';
    return `<article class="client-home-request"><div><span class="client-home-status status-${row.status}">${escapeHtml(STATUS[row.status])}</span><h3>${escapeHtml(row.roleTitle)}</h3><p>${escapeHtml(message)}</p><small>${row.seatCount} ${row.seatCount===1?'seat':'seats'}${row.targetStartDate?` · Target start ${escapeHtml(formatDate(row.targetStartDate))}`:''}</small></div>${closed?actionButton('help','', 'Contact Soro'):actionButton(pending?'review':'progress',row.requestId,pending?'Review candidates':decision?'Review & decide':'View progress',pending||decision)}</article>`;
  }
  function salesContactMarkup(contact) {
    if(!contact)return '';
    return `<section class="client-home-sales-contact" aria-label="Your Sales Associate"><p class="eyebrow">Your Sales Associate</p><h2>${escapeHtml(contact.name)}</h2>${contact.email?`<a href="mailto:${escapeHtml(encodeURIComponent(contact.email))}">${escapeHtml(contact.email)}</a>`:''}${contact.phone?`<a href="tel:${escapeHtml(contact.phone.replace(/[^+\d]/g,''))}">${escapeHtml(contact.phone)}</a>`:''}${!contact.email&&!contact.phone?'<p>Use Contact Soro to reach your account team.</p>':''}</section>`;
  }
  function workspaceMarkup(data,{preview=false,now=Date.now()}={}) {
    const count=totals(data,now),billing=data.viewerRole==='client_billing';
    const pending=data.requests.filter(row=>row.pendingReviewCount||row.pendingDecisionCount);
    const upcoming=data.interviews.filter(row=>Date.parse(row.endsAt)>now).sort((a,b)=>Date.parse(a.startsAt)-Date.parse(b.startsAt));
    const salesContact=salesContactMarkup(data.salesContact);
    return `<main class="page client-home" aria-labelledby="client-home-title"><header class="client-home-heading"><div><p class="eyebrow">${escapeHtml(data.companyName)} · Client Portal</p><h1 id="client-home-title">Your Soro dashboard</h1><p>${data.contactName?`Welcome, ${escapeHtml(data.contactName)}.`:'Welcome back.'}</p></div><div class="client-home-tools">${preview?'<span class="client-home-sample">Sample data · review only</span>':''}<button type="button" class="client-home-button" data-home-refresh>Refresh</button></div></header>
      ${billing?`<section class="panel client-home-billing">${salesContact}<h2>Your account</h2><p>Manage your contact details or reach your Soro team. Candidate reviews and talent profiles are available to your company’s authorized reviewers.</p>${actionButton('account','','Account Settings')}${actionButton('help','','Contact Soro')}</section>`:`
      <section class="client-home-metrics" aria-label="Your account at a glance">${[['review',count.review,'Candidates to review','Ready for your response'],['progress',count.interviews,'Upcoming interviews','Includes meetings in progress'],['requests',count.requests,'Hiring requests','Open and on-hold requests'],['talent',count.talent,'Your talent','Confirmed and active placements']].map(([action,value,label,note])=>`<button type="button" class="client-home-metric" data-home-section="${action}"><span>${label}</span><strong>${value}</strong><small>${note}</small></button>`).join('')}</section>
      <div class="client-home-grid"><div class="client-home-main"><section class="panel client-home-panel" id="client-home-review" tabindex="-1"><div class="panel-head"><div><p class="eyebrow">Your next step</p><h2>Needs your attention</h2></div>${count.review+count.decisions?`<span class="client-home-count">${count.review+count.decisions}</span>`:''}</div>${pending.length?pending.map(row=>requestMarkup(row,data.viewerRole)).join(''):'<div class="client-home-empty"><strong>You’re all caught up</strong><p>New candidates and decisions that need your attention will appear here.</p></div>'}</section>
      <section class="panel client-home-panel" id="client-home-requests" tabindex="-1"><div class="panel-head"><h2>Your hiring requests</h2></div>${data.requests.length?data.requests.map(row=>requestMarkup(row,data.viewerRole)).join(''):'<div class="client-home-empty"><strong>Let’s build your team</strong><p>Your Soro team will confirm your role requirements and add your first hiring request.</p>'+actionButton('help','','Contact Soro')+'</div>'}</section></div>
      <aside class="client-home-aside"><section class="panel client-home-panel" id="client-home-progress" tabindex="-1"><div class="panel-head"><h2>Upcoming interviews</h2></div>${upcoming.length?upcoming.map(row=>`<article class="client-home-interview"><div class="client-home-calendar" aria-hidden="true"><span>${new Intl.DateTimeFormat('en-US',{month:'short',timeZone:row.timezone}).format(new Date(row.startsAt))}</span><strong>${new Intl.DateTimeFormat('en-US',{day:'numeric',timeZone:row.timezone}).format(new Date(row.startsAt))}</strong></div><div><h3>${escapeHtml(row.candidateName)}</h3><p>${escapeHtml(row.roleTitle)}</p><time datetime="${escapeHtml(row.startsAt)}">${escapeHtml(formatDate(row.startsAt,row.timezone))}</time><small>${escapeHtml(row.timezone)}</small><div class="client-home-interview-actions">${row.joinUrl?`<a class="client-home-button is-primary" href="${escapeHtml(row.joinUrl)}" target="_blank" rel="noopener noreferrer">Join Teams <span aria-hidden="true">↗</span></a>`:'<span class="client-home-note">Meeting link pending</span>'}${actionButton('progress',row.requestId,'Details')}</div></div></article>`).join(''):'<div class="client-home-empty"><strong>No upcoming interviews</strong><p>Request an interview from Candidate Review. Your Soro team will coordinate the time.</p></div>'}</section>
      <section class="panel client-home-panel" id="client-home-talent" tabindex="-1"><div class="panel-head"><h2>Your talent</h2></div>${data.talent.length?data.talent.map(row=>`<article class="client-home-talent"><span class="client-home-avatar" aria-hidden="true">${escapeHtml((row.preferredName||row.fullName).slice(0,1))}</span><div><h3>${escapeHtml(row.preferredName||row.fullName)}</h3><p>${escapeHtml(row.roleTitle)}</p><span class="client-home-status">${({active:'Active',onboarding:'Onboarding',placement_confirmed:'Placement confirmed'})[row.status]}</span>${row.startDate?`<small>Starts ${escapeHtml(formatDate(row.startDate))}</small>`:''}${row.scheduleSummary?`<small>${escapeHtml(row.scheduleSummary)}</small>`:''}${actionButton('talent',row.applicantId,'View profile')}</div></article>`).join(''):'<div class="client-home-empty"><strong>Your team starts here</strong><p>Once a placement is confirmed, you can find your talent’s profile here.</p></div>'}</section>
      <section class="panel client-home-support">${salesContact}<h2>Your Soro team</h2><p>Questions about candidates, interviews, or your placement? We’re here to help.</p>${actionButton('help','','Contact Soro')}${actionButton('account','','Account Settings')}</section></aside></div>`}
      <p class="client-home-updated">Updated ${escapeHtml(formatDate(data.generatedAt))}</p></main>`;
  }
  async function request(signal) {
    if(options.loader)return options.loader({signal});
    const session=await root?.soroSupabase?.auth?.getSession?.();
    if(signal?.aborted)throw Object.assign(new Error('Aborted'),{name:'AbortError'});
    const token=session?.data?.session?.access_token;
    if(!token||session.error)throw new Error('Sign in again to view your dashboard.');
    const response=await root.fetch(ENDPOINT,{method:'GET',headers:{Authorization:`Bearer ${token}`,Accept:'application/json'},cache:'no-store',credentials:'same-origin',signal});
    if(!response.ok)throw new Error(response.status===401?'Your session has expired. Sign in again to continue.':'Your dashboard could not be loaded. Please try again.');
    return response.json();
  }
  async function refresh() {
    if(!target)return false;
    const version=++generation; controller?.abort(); controller=new AbortController(); workspace=null;
    target.innerHTML='<main class="page client-home"><section class="panel client-home-panel" aria-busy="true"><h1>Your Soro dashboard</h1><p role="status">Loading your latest updates…</p></section></main>';
    try { const payload=await request(controller.signal); if(!target||target.isConnected===false||version!==generation)return false; workspace=normalizeWorkspace(payload,options.role); target.innerHTML=workspaceMarkup(workspace,{preview:Boolean(options.loader&&options.preview)}); return true; }
    catch(error) { if(!target||target.isConnected===false||version!==generation||error.name==='AbortError')return false; target.innerHTML=`<main class="page client-home"><section class="panel client-home-panel"><h1>Your Soro dashboard</h1><p role="alert">${escapeHtml(error.message||'Your dashboard is temporarily unavailable.')}</p><button class="client-home-button" data-home-refresh>Try again</button>${actionButton('help','','Contact Soro')}</section></main>`; return false; }
  }
  function click(event) {
    const button=event.target.closest?.('button'); if(!button||button.disabled)return;
    if(button.hasAttribute('data-home-refresh')){refresh();return;}
    if(button.dataset.homeSection){const section=target.querySelector(`#client-home-${button.dataset.homeSection}`);section?.scrollIntoView?.({behavior:'auto',block:'start'});section?.focus?.({preventScroll:true});return;}
    const action=button.dataset.homeAction,id=button.dataset.homeId||'';
    if(['account','help'].includes(action)){options.onNavigate?.(action,'');return;}
    if(!workspace||workspace.viewerRole==='client_billing')return;
    if(['review','progress'].includes(action)&&workspace.requests.some(row=>row.requestId===id))options.onNavigate?.(action,id);
    if(action==='talent'&&workspace.talent.some(row=>row.applicantId===id))options.onNavigate?.(action,id);
  }
  function unmount({clear=true}={}) { ++generation;controller?.abort();target?.removeEventListener?.('click',click);root?.removeEventListener?.('soro-auth-changed',authChanged); if(clear&&target)target.innerHTML='';target=null;workspace=null;options={}; }
  function authChanged(){unmount();}
  function mount(node,config={}) { unmount();if(!node||!ROLES.has(config.role||root?.soroCurrentAccess?.role))return false;target=node;options={...config,role:config.role||root.soroCurrentAccess.role};target.addEventListener('click',click);root?.addEventListener?.('soro-auth-changed',authChanged);refresh();return true; }
  return Object.freeze({ENDPOINT,STATUS,COUNTS,normalizeWorkspace,workspaceMarkup,totals,formatDate,joinUrl,mount,unmount,refresh});
}));
