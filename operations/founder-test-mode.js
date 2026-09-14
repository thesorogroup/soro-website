/* Founder-owned, disposable test sessions. The live page never assumes a sample identity. */
(function(root){
  'use strict';
  const ROLES={client:'Client Portal',talent:'Talent Management Panel',sales:'Sales Panel',va:'Talent Portal'};
  let dialog=null,frame=null,launch=0;
  const founder=()=>root.soroCurrentAccess?.role==='admin'&&root.soroCurrentAccess?.is_founder===true&&root.soroCurrentAccess?.active===true&&root.soroCurrentAccess?.must_change_password===false;
  function close(){launch++;if(dialog){dialog.close();dialog.remove();}dialog=frame=null;}
  function message(command,value){frame?.contentWindow?.postMessage({type:'soro-test-control',command,value},'*');}
  function createDocument(source){
    const doc=new DOMParser().parseFromString(source,'text/html');
    // No production auth client, configuration, test launcher, or external scripts in the child.
    doc.querySelectorAll('script').forEach(s=>{const url=new URL(s.getAttribute('src')||'',location.href);if(!s.src||url.origin!==location.origin||/(?:^|\/)(?:auth|supabase-config|founder-test-mode)\.js$/.test(url.pathname))s.remove();});
    doc.querySelectorAll('link').forEach(link=>{const url=new URL(link.getAttribute('href')||'',location.href);if(url.origin!==location.origin)link.remove();});
    const base=doc.createElement('base');base.href=new URL('/operations/',location.href).href;doc.head.prepend(base);
    const policy=doc.createElement('meta');policy.httpEquiv='Content-Security-Policy';
    policy.content=`default-src 'none'; script-src ${location.origin}; style-src ${location.origin} 'unsafe-inline'; img-src ${location.origin} data: blob:; media-src blob:; font-src ${location.origin}; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri ${location.origin}`;
    doc.head.prepend(policy);
    const boot=doc.createElement('script');boot.src=new URL('test-mode/runtime.js?v=20260914-core-profile',base.href).href;doc.head.append(boot);
    const ready=doc.createElement('script');ready.src=new URL('test-mode/start.js?v=20260913-render-parity',base.href).href;doc.body.append(ready);
    doc.title='Soro Ops — Test Mode';
    return '<!doctype html>'+doc.documentElement.outerHTML;
  }
  async function open(){
    if(!founder()||dialog)return;
    const attempt=++launch,actor=root.soroCurrentAccess.user_id;
    dialog=document.createElement('dialog');dialog.className='founder-test-dialog';dialog.setAttribute('aria-label','Founder Test Mode');
    dialog.innerHTML='<header class="founder-test-bar"><div><strong>Test Mode</strong><small>Fictional accounts · No live records, emails, meetings, or payments</small></div><label>View As<select aria-label="Test portal">'+Object.entries(ROLES).map(([value,label])=>`<option value="${value}">${label}</option>`).join('')+'</select></label><button type="button" class="button" data-reset>Reset Samples</button><button type="button" class="button" data-exit>Exit Test Mode</button></header><p class="founder-test-status" role="status">Opening your private test session…</p>';
    document.body.append(dialog);dialog.showModal();
    dialog.querySelector('[data-exit]').onclick=close;dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
    dialog.querySelector('select').onchange=e=>message('role',e.target.value);
    let resetArmed=false;
    dialog.querySelector('[data-reset]').onclick=event=>{
      if(!frame)return;
      if(!resetArmed){resetArmed=true;event.currentTarget.textContent='Confirm Reset';dialog.querySelector('[role="status"]').textContent='Click Confirm Reset to discard this sample session. Live records will not change.';return;}
      resetArmed=false;event.currentTarget.textContent='Reset Samples';frame.srcdoc=frame.srcdoc;
    };
    try{
      const session=await root.soroSupabase.auth.getSession(),token=session.data?.session?.access_token;
      if(!token)throw new Error('Sign in again to open Test Mode.');
      const gate=await fetch('/.netlify/functions/founder-test-mode',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:'{}',cache:'no-store'});
      const access=await gate.json();if(!gate.ok||access.allowed!==true)throw new Error(access.message||'Test Mode is unavailable.');
      const response=await fetch('/operations/index.html',{cache:'no-store'});if(!response.ok)throw new Error('The current portal screens could not be loaded.');
      const source=await response.text();if(attempt!==launch||!founder()||root.soroCurrentAccess.user_id!==actor)return;
      // Forms need submit events for the real UI; CSP form-action/connect-src still deny transmission.
      frame=document.createElement('iframe');frame.title='Sample Portal';frame.setAttribute('sandbox','allow-scripts allow-forms');frame.setAttribute('referrerpolicy','no-referrer');frame.srcdoc=createDocument(source);dialog.append(frame);
      dialog.querySelector('[role="status"]').textContent='Changes are temporary. Reset or exit to discard this session. Some external-service actions are unavailable.';
    }catch(error){if(attempt===launch&&dialog)dialog.querySelector('[role="status"]').textContent=error.message;}
  }
  function sync(){
    let button=document.getElementById('founder-test-mode');
    if(!button){button=document.createElement('button');button.id='founder-test-mode';button.className='nav-link founder-test-entry';button.type='button';button.textContent='Test Mode';button.onclick=open;document.getElementById('role-switcher')?.before(button);}
    button.hidden=!founder();if(!founder())close();
  }
  root.addEventListener('soro-auth-changed',sync);
  root.addEventListener('message',event=>{if(event.source!==frame?.contentWindow||event.origin!=='null'||!dialog)return;if(event.data?.type==='soro-test-ready')message('role',dialog.querySelector('select').value);if(event.data?.type==='soro-test-notice')dialog.querySelector('[role="status"]').textContent=String(event.data.message||'').slice(0,220);});
  root.SoroFounderTestMode=Object.freeze({open,close});sync();
}(window));
