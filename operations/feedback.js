(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.SoroFeedback=api;}(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  const TYPES={suggestion:'Suggestion',experience:'Something could be easier',general:'General feedback'};
  const ROLES=['admin','sales','sales_management','talent_management','billing','client_admin','client_reviewer','client_billing','virtual_assistant'];
  const ROLE_LABELS={admin:'Admin',sales:'Sales',sales_management:'Sales Management',talent_management:'Talent Management',billing:'Billing',client_admin:'Client',client_reviewer:'Client',client_billing:'Client',virtual_assistant:'Talent'};
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let host=null,generation=0,bindings=null;
  function scope(){const a=root.soroCurrentAccess||{};return JSON.stringify([a.user_id,a.organization_id,a.role,a.active,a.must_change_password]);}
  function eligible(a){return Boolean(a?.user_id&&a.organization_id&&a.active!==false&&a.must_change_password!==true&&ROLES.includes(a.role));}
  function itemsMarkup(data){
    return (data.items||[]).map(item=>`<article class="feedback-entry"><header><strong>${esc(TYPES[item.category]||'Feedback')}</strong><span class="feedback-state${item.reviewedAt?' is-reviewed':''}">${item.reviewedAt?'Reviewed':'Received'}</span></header>${data.canReview?`<p class="feedback-author">${esc(item.authorName||'Portal member')} · ${esc(ROLE_LABELS[item.authorRole]||'Portal member')}</p>`:''}<p class="feedback-message">${esc(item.message)}</p><footer><time>${esc(item.createdAt?new Date(item.createdAt).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}):'')}</time>${data.canReview&&!item.reviewedAt?`<button type="button" class="button" data-review-feedback="${esc(item.id)}">Mark reviewed</button>`:''}</footer></article>`).join('')||'<div class="feedback-empty"><h3>No feedback yet</h3><p>Your ideas and observations help us improve Soro Ops.</p></div>';
  }
  function pageMarkup({preview=false}={}){
    return `<main class="page feedback-page"><div class="page-heading"><div><p class="eyebrow">Make Soro better</p><h1>Feedback</h1><p>Tell us what works well and what could be easier.</p></div></div>${preview?'<p class="feedback-preview" role="status">Workspace preview — no feedback is sent and no private submissions are shown.</p>':''}<div class="feedback-layout"><section class="panel feedback-compose"><h2>Share your feedback</h2><p>Feedback goes privately to The Founder and Admin team. It is not shared with other clients or talent.</p><form data-feedback-form><label>Feedback type<select name="category">${Object.entries(TYPES).map(([v,label])=>`<option value="${v}">${label}</option>`).join('')}</select></label><label>What would you like us to know?<textarea name="message" rows="7" required minlength="3" maxlength="4000" placeholder="Tell us about your experience or suggest an improvement…"></textarea></label><small>Please leave out passwords, payment details, and other sensitive information.</small><button class="button primary" type="submit" ${preview?'disabled':''}>Send feedback</button><p data-feedback-status role="status" aria-live="polite"></p></form><div class="feedback-support-note"><strong>Need help with an issue?</strong><p>Use a support ticket when you need a response or a problem resolved.</p><button class="button" type="button" data-feedback-support>Open Help & Support</button></div></section><section class="panel feedback-inbox"><div class="feedback-inbox-heading"><div><p class="eyebrow" data-feedback-scope>Private feedback</p><h2 data-feedback-heading>Your feedback</h2></div><button class="button" data-feedback-refresh type="button">Refresh</button></div><div data-feedback-items aria-live="polite"><p>Loading feedback…</p></div><div class="feedback-pagination"><button class="button" type="button" data-feedback-previous hidden>Previous</button><button class="button" type="button" data-feedback-next hidden>Next</button></div><p data-feedback-list-status role="status"></p></section></div></main>`;
  }
  async function request(method,body,offset,captured,tokenVersion){
    const current=()=>scope()===captured&&generation===tokenVersion&&eligible(root.soroCurrentAccess);
    if(!current())throw new Error('Your session changed. Reopen Feedback to continue.');
    const client=root.soroSupabase;
    const result=await client?.auth.getSession();
    if(!current()||root.soroSupabase!==client||!result?.data?.session?.access_token||result.data.session.user?.id!==root.soroCurrentAccess?.user_id)throw new Error('Sign in again to continue.');
    const response=await root.fetch(`/.netlify/functions/portal-feedback${method==='GET'?`?offset=${offset}`:''}`,{method,signal:bindings?.signal,headers:{Authorization:`Bearer ${result.data.session.access_token}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const data=await response.json().catch(()=>null);
    if(!current()||root.soroSupabase!==client)throw new Error('Your session changed. Reopen Feedback to continue.');
    if(!response.ok)throw new Error(data?.message||'Feedback could not be loaded. Please try again.');
    return data;
  }
  function unmount(){generation++;bindings?.abort();bindings=null;host=null;}
  function mount(element,options={}){
    unmount();host=element;const tokenVersion=generation,captured=scope(),controller=new AbortController();bindings=controller;
    const current=()=>host===element&&generation===tokenVersion&&scope()===captured&&element.querySelector('[data-feedback-form]')===form;
    element.innerHTML=pageMarkup(options);
    const form=element.querySelector('[data-feedback-form]'),feedback=element.querySelector('[data-feedback-status]'),listStatus=element.querySelector('[data-feedback-list-status]');
    const call=options.adapter||((method,body,offset)=>request(method,body,offset,captured,tokenVersion));
    let offset=0,loading=0,pending=null;
    async function load(){
      const ticket=++loading;listStatus.textContent='';
      try{
        const data=options.preview?{items:[],canReview:false,hasMore:false}:await call('GET',null,offset);
        if(!current()||ticket!==loading)return;
        if(!Array.isArray(data?.items)||typeof data.canReview!=='boolean'||typeof data.hasMore!=='boolean')throw new Error('Feedback could not be verified. Refresh to try again.');
        element.querySelector('[data-feedback-heading]').textContent=data.canReview?'Feedback inbox':'Your feedback';
        element.querySelector('[data-feedback-scope]').textContent=data.canReview?'Founder & Admin only':'Only you and the Admin team';
        element.querySelector('[data-feedback-items]').innerHTML=itemsMarkup(data);
        element.querySelector('[data-feedback-previous]').hidden=!offset;element.querySelector('[data-feedback-next]').hidden=!data.hasMore;
      }catch(error){if(current()&&ticket===loading){listStatus.textContent=error.message;element.querySelector('[data-feedback-items]').replaceChildren();}}
    }
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(!current()||options.preview||!form.reportValidity())return;
      const category=form.elements.category.value,message=form.elements.message.value.trim(),fingerprint=JSON.stringify([category,message]);
      if(!pending||pending.fingerprint!==fingerprint)pending={fingerprint,requestId:root.crypto.randomUUID()};
      const button=form.querySelector('[type="submit"]');button.disabled=true;form.elements.category.disabled=true;form.elements.message.disabled=true;feedback.textContent='Sending…';
      try{const receipt=await call('POST',{requestId:pending.requestId,category,message});if(!current())return;if(typeof receipt?.id!=='string')throw new Error('Your receipt could not be verified. Retry the same feedback safely.');pending=null;form.reset();feedback.textContent='Thank you—your feedback has been received by the Admin team.';offset=0;await load();}
      catch(error){if(current())feedback.textContent=error.message;}finally{if(current()){button.disabled=false;form.elements.category.disabled=false;form.elements.message.disabled=false;}}
    },{signal:controller.signal});
    element.addEventListener('click',async event=>{
      const button=event.target.closest('button');if(!button||!current())return;
      if(button.hasAttribute('data-feedback-support')){options.onSupport?.();return;}
      if(button.hasAttribute('data-feedback-refresh')){load();return;}
      if(button.hasAttribute('data-feedback-next')){offset+=25;load();return;}
      if(button.hasAttribute('data-feedback-previous')){offset=Math.max(0,offset-25);load();return;}
      if(button.dataset.reviewFeedback&&!options.preview){button.disabled=true;listStatus.textContent='';try{await call('PATCH',{id:button.dataset.reviewFeedback});if(current())await load();}catch(error){if(current()){listStatus.textContent=error.message;button.disabled=false;}}}
    },{signal:controller.signal});
    load();return {unmount};
  }
  root.addEventListener?.('soro-auth-changed',()=>{if(host)host.replaceChildren();unmount();});
  return {TYPES,ROLES,eligible,itemsMarkup,pageMarkup,mount,unmount};
}));
