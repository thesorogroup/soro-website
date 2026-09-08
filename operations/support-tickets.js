/* Optional private screenshots and retry-safe ticket submissions. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.SoroSupportTickets=api;}(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  const MAX_BYTES=3*1024*1024,ENDPOINT='/.netlify/functions/support-tickets';
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let node=null,version=0,options={},mountedActor='';
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
  function ticketMarkup(ticket){return `<article class="support-ticket-row"><div><strong>${escape(ticket.ticketNumber)}</strong><span class="tag neutral">${escape(String(ticket.status||'open').replaceAll('_',' '))}</span><h3>${escape(ticket.subject)}</h3><p>${escape(ticket.details)}</p><small>${escape(ticket.area)} · ${escape(new Date(ticket.createdAt).toLocaleDateString())}</small></div>${ticket.hasImage?`<button type="button" class="button" data-ticket-image="${escape(ticket.ticketId)}">View screenshot</button>`:''}</article>`;}
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
    const list=node?.querySelector('[data-ticket-list]');if(!list)return;
    try{const data=await request('GET');if(captured!==version||!node?.isConnected)return;list.innerHTML=`<div class="panel-head"><h2>${data.internal?'Support inbox':'Your recent tickets'}</h2></div>${data.tickets?.length?data.tickets.map(ticketMarkup).join(''):'<p>No support tickets yet.</p>'}`;}
    catch{if(captured===version&&node?.isConnected)list.textContent='Recent tickets could not be loaded. Your new ticket can still be submitted above.';}
  }
  function unmount(){version++;node=null;options={};mountedActor='';}
  function mount(container,config={}){
    unmount();node=container;options=config;mountedActor=root.soroCurrentAccess?.user_id||'';const captured=version,actor=mountedActor;
    const form=node.querySelector('#help-ticket-form');if(!form)return;
    form.elements.subject.minLength=3;form.elements.details.minLength=5;form.elements.details.maxLength=5000;
    form.querySelector('[type="submit"]').insertAdjacentHTML('beforebegin',uploadMarkup());
    node.querySelector('.support-grid').insertAdjacentHTML('afterend','<section class="panel support-tickets-list" data-ticket-list aria-live="polite">Loading recent tickets…</section>');
    const input=form.querySelector('#support-image'),name=form.querySelector('[data-image-name]'),remove=form.querySelector('[data-remove-image]'),confirmation=form.querySelector('#ticket-confirmation');
    let submission=null,busy=false;
    form.querySelector('[data-upload-image]').addEventListener('click',()=>input.click());
    input.addEventListener('change',()=>{name.textContent=input.files[0]?.name||'No image selected';remove.hidden=!input.files.length;});
    remove.addEventListener('click',()=>{input.value='';name.textContent='No image selected';remove.hidden=true;});
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(busy||captured!==version||!form.reportValidity())return;
      busy=true;const submit=form.querySelector('[type="submit"]');form.querySelectorAll('input,select,textarea,button').forEach(control=>control.disabled=true);submit.textContent='Submitting…';confirmation.textContent='';
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
        loadTickets(captured);
      }catch(error){if(captured===version){confirmation.className='support-ticket-error';confirmation.textContent=error.name==='TimeoutError'?'The connection timed out. Retry without changing the ticket to safely check the same submission.':error.message;}}
      finally{busy=false;form.querySelectorAll('input,select,textarea,button').forEach(control=>control.disabled=false);submit.textContent='Submit support ticket';}
    });
    node.addEventListener('click',async event=>{
      const button=event.target.closest?.('[data-ticket-image]');if(!button||button.disabled||captured!==version)return;
      const opened=root.open('about:blank','_blank');if(opened)opened.opener=null;
      button.disabled=true;
      try{const result=await request('GET',null,`?imageTicketId=${encodeURIComponent(button.dataset.ticketImage)}`);if(captured!==version){opened?.close();return;}const url=new URL(result.url);if(url.protocol!=='https:'||!url.hostname.endsWith('.supabase.co'))throw new Error('Screenshot link could not be verified.');if(opened)opened.location.replace(url.href);else throw new Error('Allow pop-ups, then select View screenshot again.');}
      catch(error){opened?.close();confirmation.textContent=error.message;confirmation.className='support-ticket-error';}
      finally{button.disabled=false;}
    });
    loadTickets(captured);
  }
  // The owning enhancement renderer invalidates this module before each route
  // or auth render. A second auth listener here would clear its new Help view.
  return Object.freeze({uploadMarkup,ticketMarkup,readImage,pendingRequest,mount,unmount,MAX_BYTES});
}));
