/* Live observer: the Founder token stays in this parent, never in the portal frame. */
(function(w){
 'use strict';
 if(w.parent!==w)return;
 const ENDPOINT='/.netlify/functions/founder-live-portal';
 let state=null,serial=0,sourcePromise;
 const selections={client:'',va:''};
 const originalNavigation=new Map();let originalSwitcherLabel;
 function syncObservedNavigation(){
  if(!state?.navigation)return;
  document.querySelectorAll('#main-nav [data-view]').forEach(b=>{const badge=b.querySelector('b');if(!originalNavigation.has(b))originalNavigation.set(b,{label:b.getAttribute('aria-label'),badgeText:badge?.textContent,badgeHidden:badge?.hidden});const item=state.navigation.find(n=>n.view===b.dataset.view);if(b.hidden!==!item)b.hidden=!item;if(!item)return;if(badge){const text=String(item.count||0);if(badge.textContent!==text)badge.textContent=text;if(badge.hidden!==!item.count)badge.hidden=!item.count;}if(item.label&&b.getAttribute('aria-label')!==item.label)b.setAttribute('aria-label',item.label);});
 }
 new MutationObserver(syncObservedNavigation).observe(document.getElementById('main-nav'),{subtree:true,childList:true,attributes:true,attributeFilter:['hidden','aria-label']});
 const eligible=()=>w.soroCurrentAccess?.role==='admin'&&w.soroCurrentAccess?.is_founder===true&&w.soroCurrentAccess?.active===true&&w.soroCurrentAccess?.must_change_password===false;
 async function request(query){
  if(!eligible())throw new Error('Founder access is required.');
  const actor=w.soroCurrentAccess.user_id,{data}=await w.soroSupabase.auth.getSession();
  if(!data?.session?.access_token)throw new Error('Sign in again to open the live portal.');
  const res=await fetch(ENDPOINT+'?'+new URLSearchParams(query),{headers:{Authorization:'Bearer '+data.session.access_token},cache:'no-store'});
  const result=await res.json();
  if(!eligible()||w.soroCurrentAccess.user_id!==actor)throw new Error('The signed-in account changed.');
  if(!res.ok)throw new Error(result.message||'The live portal is unavailable.');
  return result;
 }
 function clear(){
  serial++;state?.frame?.remove();state=null;document.body.classList.remove('is-live-observer');
  originalNavigation.forEach((saved,b)=>{if(saved.label===null)b.removeAttribute('aria-label');else b.setAttribute('aria-label',saved.label);const badge=b.querySelector('b');if(badge&&saved.badgeText!==undefined){badge.textContent=saved.badgeText;badge.hidden=saved.badgeHidden;}});originalNavigation.clear();
  const switcher=document.getElementById('role-switcher');if(originalSwitcherLabel!==undefined&&switcher){if(originalSwitcherLabel===null)switcher.removeAttribute('aria-label');else switcher.setAttribute('aria-label',originalSwitcherLabel);originalSwitcherLabel=undefined;}
 }
 function frameDocument(source){
  const doc=new DOMParser().parseFromString(source,'text/html');
  doc.querySelectorAll('script').forEach(s=>{const u=new URL(s.getAttribute('src')||'',location.href);if(!s.src||u.origin!==location.origin||/(?:^|\/)(auth|supabase-config|founder-test-mode|founder-live-portal)\.js$/.test(u.pathname))s.remove();});
  doc.querySelectorAll('link').forEach(l=>{if(new URL(l.getAttribute('href')||'',location.href).origin!==location.origin)l.remove();});
  const base=doc.createElement('base');base.href=new URL('/operations/',location.href).href;doc.head.prepend(base);
  const policy=doc.createElement('meta');policy.httpEquiv='Content-Security-Policy';
  policy.content=`default-src 'none'; script-src ${location.origin}; style-src ${location.origin} 'unsafe-inline'; img-src ${location.origin} https://*.supabase.co data: blob:; media-src https://*.supabase.co blob:; font-src ${location.origin}; connect-src 'none'; frame-src https://www.loom.com; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri ${location.origin}`;
  doc.head.prepend(policy);
  const runtime=doc.createElement('script');runtime.src=new URL('live-portal/runtime.js?v=20260913',base.href).href;doc.head.append(runtime);
  const start=doc.createElement('script');start.src=new URL('live-portal/start.js?v=20260913',base.href).href;doc.body.append(start);
  const style=doc.createElement('style');style.textContent='.sidebar,#sign-out,.mobile-menu,#role-switcher,#founder-test-mode{display:none!important}.app-shell{display:block!important}.topbar{justify-content:flex-end;padding:0 6px;height:48px}.main-shell{margin:0!important;width:100%!important}.page{padding:20px 6px!important}.page-task-action{display:none!important}';doc.head.append(style);
  return '<!doctype html>'+doc.documentElement.outerHTML;
 }
 function send(type,extra={}){state?.frame?.contentWindow?.postMessage({type,...extra},'*');}
 function navigate(){const s=state;if(!s?.frame)return;const key=[current,preferredHiringRequestId,preferredClientTalentId].join(':');if(key===s.lastRoute)return;s.lastRoute=key;send('soro-live-navigate',{route:current,requestId:preferredHiringRequestId,talentId:preferredClientTalentId});}
 async function selectAccount(id){
  const s=state,attempt=++serial;s.frame?.remove();s.frame=null;s.subject=null;
  selections[s.portal]=id;
  if(!id){s.status.textContent='Choose an active account to see its current portal.';return;}
  s.status.textContent='Loading the selected live account…';
  try{
   const context=await request({action:'context',portal:s.portal,subject:id});
   sourcePromise||=fetch('/operations/index.html',{cache:'no-store'}).then(r=>{if(!r.ok)throw new Error('The current portal screens could not be loaded.');return r.text();}).catch(e=>{sourcePromise=null;throw e;});
   const source=await sourcePromise;
   if(state!==s||attempt!==serial||!eligible())return;
   s.subject=context.subject;s.actorId=context.actorId;
   const frame=document.createElement('iframe');frame.title='Read-Only Live '+(s.portal==='client'?'Client':'Talent')+' Portal';frame.className='founder-live-frame';frame.setAttribute('sandbox','allow-scripts allow-forms');frame.setAttribute('referrerpolicy','no-referrer');frame.srcdoc=frameDocument(source);s.frame=frame;s.host.append(frame);
   s.status.textContent='Viewing '+context.subject.display_name+' · Read-Only. Changes must be made from your Admin Panel.';
  }catch(e){if(state===s&&attempt===serial)s.status.textContent=e.message;}
 }
 function mount(host,portal){
  if(state?.root===host&&state.portal===portal&&host.contains(state.toolbar)){navigate();return;}
  clear();
  host.innerHTML='<section class="founder-live-portal"><div class="founder-live-toolbar"><label>View Live '+(portal==='client'?'Client':'Talent')+' Account<select aria-label="Live Portal Account"><option value="">Loading accounts…</option></select></label><p><strong>Read-Only Live View</strong>Real records, with your Founder login unchanged. Test Mode remains separate.</p><button type="button" class="button" data-admin>Return to Admin</button></div><p class="founder-live-status" role="status">Loading available accounts…</p></section>';
  const section=host.firstElementChild,s={host:section,portal,toolbar:section.querySelector('.founder-live-toolbar'),status:section.querySelector('[role="status"]'),frame:null};
  // Compare the actual view root on subsequent navigation; the section owns the frame.
  s.root=host;state=s;
  const picker=section.querySelector('select');picker.onchange=()=>selectAccount(picker.value);
  section.querySelector('[data-admin]').onclick=()=>{clear();applyRole('admin');w.soroTaskCenter?.refresh?.({silent:true});};
  request({action:'accounts',portal}).then(result=>{
   if(state!==s)return;picker.replaceChildren(new Option('Choose an account…',''));
   result.accounts.forEach(a=>picker.add(new Option(a.label,a.id)));
   if(result.accounts.some(a=>a.id===selections[portal])){picker.value=selections[portal];selectAccount(picker.value);}
   else s.status.textContent=result.accounts.length?'Choose an active account to see its current portal.':'No active '+(portal==='client'?'Client':'Talent')+' portal accounts are connected yet.';
  }).catch(e=>{if(state===s){picker.replaceChildren(new Option('Accounts unavailable',''));s.status.textContent=e.message;}});
 }
 const baseRender=render;
 render=function(){
  if(eligible()&&['client','va'].includes(role)){
   if(state?.root===root&&state.portal===role&&root.contains(state.toolbar))navigate();
   else mount(root,role);
   setActive();syncObservedNavigation();document.body.classList.add('is-live-observer');const switcher=document.getElementById('role-switcher');if(switcher){if(originalSwitcherLabel===undefined)originalSwitcherLabel=switcher.getAttribute('aria-label');switcher.setAttribute('aria-label','Switch Live Portal View');}return;
  }
  if(state)clear();return baseRender();
 };
 w.addEventListener('message',async event=>{
  const s=state;if(!s?.frame||event.source!==s.frame.contentWindow||event.origin!=='null'||!eligible())return;
  const d=event.data||{};
  if(d.type==='soro-live-ready'){s.lastRoute=[current,preferredHiringRequestId,preferredClientTalentId].join(':');send('soro-live-init',{subject:s.subject,portal:s.portal,route:current});return;}
  if(d.type==='soro-live-notice'){s.status.textContent=String(d.message||'').slice(0,240);return;}
  if(d.type==='soro-live-navigation'&&Array.isArray(d.items)&&d.items.length<=30){s.navigation=d.items.filter(n=>typeof n.view==='string'&&viewAllowedForAuthenticatedRole(n.view)&&typeof n.label==='string'&&n.label.length<160&&Number.isSafeInteger(n.count)&&n.count>=0);syncObservedNavigation();return;}
  if(d.type==='soro-live-location'&&typeof d.route==='string'&&viewAllowedForAuthenticatedRole(d.route)){current=d.route;s.lastRoute=[current,preferredHiringRequestId,preferredClientTalentId].join(':');setActive();return;}
  if(d.type!=='soro-live-read'||!Number.isSafeInteger(d.id)||typeof d.resource!=='string')return;
  const frame=s.frame,attempt=serial;
  try{
   const data=await request({action:'read',portal:s.portal,subject:s.subject.user_id,resource:d.resource,params:JSON.stringify(d.params||{})});
   if(state===s&&serial===attempt&&s.frame===frame)send('soro-live-result',{id:d.id,data:data.data});
  }catch(e){if(state===s&&serial===attempt)send('soro-live-result',{id:d.id,error:e.message});}
 });
 w.addEventListener('soro-auth-changed',()=>{if(!eligible()){clear();}else if(['client','va'].includes(role))render();});
 w.SoroFounderLivePortal=Object.freeze({eligible,frameDocument});
}(window));
