(function(w){
 'use strict';const observer=w.SoroLiveObserver;if(!observer||w.parent===w)return;
 let initialized=false,lastNavigation='';
 const baseSetActive=setActive;setActive=function(){baseSetActive();if(initialized)w.parent.postMessage({type:'soro-live-location',route:current},'*');};
 function routeTo(data){
  if(!initialized)return;
  w.soroTaskDetail?.close?.();document.querySelectorAll('dialog[open]').forEach(d=>d.close());
  preferredHiringRequestId=data.requestId||preferredHiringRequestId;preferredClientTalentId=data.talentId||preferredClientTalentId;
  history.replaceState({},'','#'+String(data.route||'overview'));
  // Reuse the portal's own parser for task, document, ticket, and placement links.
  w.dispatchEvent(new PopStateEvent('popstate'));
 }
 function readonlyControls(){
  document.querySelectorAll('button,input[type="submit"],input[type="file"]').forEach(b=>{
   const label=(b.textContent||b.value||'').trim();
   if(observer.isFilter(b.closest('form'))||b.matches('[data-open-task],[data-task-close],[role="tab"],[data-time-off-open]'))return;
   if((b.type==='submit'&&b.closest('form'))||b.type==='file'||b.matches('[data-cpw-decision],[data-cpw-open],[data-cpw-direct]')||/^(?:\+\s*)?(Save|Submit|Send|Upload|Replace|Start Day|Check Out|Request Screenshot|Share Screenshot|Add Task|Edit|Approve|Decline|Accept|Confirm|Cancel Request|Withdraw|Mark All|Mark Read|Sign Out|Sign in|Create)\b/i.test(label)){
    b.disabled=true;b.title='Read-Only Live View — use your Admin Panel to make changes.';
   }
  });
  document.querySelectorAll('textarea,input:not([type="search"]),form#client-profile-form select').forEach(el=>{if(!el.closest('[class*="filter"],[class*="search"]'))el.disabled=true;});
  if(initialized){const items=[...document.querySelectorAll('#main-nav [data-view]')].filter(b=>!b.hidden).map(b=>({view:b.dataset.view,label:b.getAttribute('aria-label')||b.textContent.trim(),count:Number(b.querySelector('b:not([hidden])')?.textContent||0)}));const key=JSON.stringify(items);if(key!==lastNavigation){lastNavigation=key;w.parent.postMessage({type:'soro-live-navigation',items},'*');}}
 }
 new MutationObserver(readonlyControls).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','aria-label']});
 w.addEventListener('soro-live-route',e=>routeTo({route:e.detail}));
 w.addEventListener('message',e=>{
  if(e.source!==w.parent)return;
  if(e.data?.type==='soro-live-init'&&!initialized){
   observer.init(e.data.subject);role=e.data.portal;initialized=true;
   document.body.className=roleConfig[role].className;document.getElementById('auth-checking').hidden=true;document.getElementById('auth-gate').hidden=true;document.getElementById('app').hidden=false;
   w.soroSyncAuthorizedNavigation?.(w.soroCurrentAccess);routeTo(e.data);
   w.dispatchEvent(new CustomEvent('soro-auth-changed',{detail:{session:{user:{id:w.soroCurrentAccess.user_id}},access:w.soroCurrentAccess}}));
   readonlyControls();
  }else if(e.data?.type==='soro-live-navigate')routeTo(e.data);
 });
 w.parent.postMessage({type:'soro-live-ready'},'*');
}(window));
