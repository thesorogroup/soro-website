/* Own-profile file uploads; staff editing and other Talent profiles stay protected. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.SoroTalentSelfUploads=api;})(typeof window!=='undefined'?window:globalThis,function(root){
 'use strict';
 const ENDPOINT='/.netlify/functions/talent-profile-files';
 const RULES={profile_photo:{max:5242880,accept:'.jpg,.jpeg,.png',label:'Upload headshot',help:'JPG or PNG · up to 5 MB'},resume:{max:10485760,accept:'.pdf,.docx',label:'Upload updated résumé',help:'PDF or DOCX · up to 10 MB. Previous résumés are kept.'}};
 const MIME={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'};
 let active=null,epoch=0;
 function canUpload(access,applicant){return access?.role==='virtual_assistant'&&!!access.user_id&&!!access.organization_id&&applicant?.auth_user_id===access.user_id&&applicant?.organization_id===access.organization_id;}
 function fileInfo(file,kind){
  if(!Object.hasOwn(RULES,kind)||!file||typeof file.name!=='string'||!file.name.trim()||file.name.length>180||/[\x00-\x1f\x7f/\\]/.test(file.name)||!Number.isInteger(file.size)||file.size<1||file.size>RULES[kind].max)throw Error('Choose a file in the size and format shown below the button.');
  const ext=file.name.split('.').pop().toLowerCase(),type=MIME[ext];
  if(!type||!(kind==='profile_photo'?['jpg','jpeg','png']:['pdf','docx']).includes(ext)||(file.type&&file.type!==type))throw Error('That file format is not supported. '+RULES[kind].help);
  return {name:file.name,type,size:file.size,kind};
 }
 function markup(kind){const r=RULES[kind];return '<div class="talent-self-upload" data-self-upload="'+kind+'"><button type="button" class="button" data-self-choose>'+r.label+'</button><input type="file" accept="'+r.accept+'" hidden><small>'+r.help+'</small><p role="status" aria-live="polite" data-self-upload-status></p></div>';}
 function uploadURL(value){const u=new URL(value),base=new URL(root.SORO_SUPABASE_CONFIG.url);if(u.origin!==base.origin||!u.pathname.startsWith('/storage/v1/object/upload/sign/soro-private-documents/'))throw Error('The secure upload destination is invalid.');return u.href;}
 function stop(){epoch++;active?.controller.abort();active=null;}
 function mount(scope,applicant,options={}){
  if(!canUpload(root.soroCurrentAccess,applicant)||!options.isCurrent?.()||scope.querySelector('[data-self-upload]'))return false;
  stop(); // A fresh profile render retires any upload belonging to the old controls.
  const portrait=scope.querySelector('.headshot-wrap'),resume=scope.querySelector('[data-profile-resume]');
  portrait?.insertAdjacentHTML('beforeend',markup('profile_photo'));
  if(resume)resume.insertAdjacentHTML('afterend',markup('resume'));
  else scope.querySelector('.profile-documents-section .panel-head')?.insertAdjacentHTML('afterend',markup('resume'));
  const user=root.soroCurrentAccess.user_id,org=root.soroCurrentAccess.organization_id;
  const current=()=>canUpload(root.soroCurrentAccess,applicant)&&root.soroCurrentAccess.user_id===user&&root.soroCurrentAccess.organization_id===org&&scope.isConnected!==false&&options.isCurrent();
  const controls=[...scope.querySelectorAll('[data-self-upload]')];
  for(const control of controls){
   const input=control.querySelector('input'),button=control.querySelector('button'),status=control.querySelector('[data-self-upload-status]');
   button.addEventListener('click',()=>{if(current()&&!active)input.click();});
   input.addEventListener('change',async()=>{
    const file=input.files?.[0];input.value='';if(!file||!current()||active)return;
    let info;try{info=fileInfo(file,control.dataset.selfUpload);}catch(e){status.textContent=e.message;return;}
    const c={epoch,controller:new AbortController()};active=c;
    const guard=()=>{if(c.epoch!==epoch||!current()||c.controller.signal.aborted)throw Error('Upload cancelled because this profile or session changed.');};
    const api=async body=>{
     guard();const {data,error}=await root.soroSupabase.auth.getSession();guard();if(error||!data?.session?.access_token||data.session.user?.id!==user)throw Error('Sign in again before uploading.');
     const response=await root.fetch(ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+data.session.access_token},body:JSON.stringify(body),signal:AbortSignal.any([c.controller.signal,AbortSignal.timeout(45000)])});
     guard();const value=await response.json();guard();if(!response.ok)throw Error(value.message||'The file could not be saved.');return value;
    };
    controls.forEach(x=>x.querySelector('button').disabled=true);status.textContent='Uploading securely…';
    let attached=false;
    try{
     const start=await api({action:'prepare',requestId:root.crypto.randomUUID(),...info});guard();
     if(!start.complete){
      const response=await root.fetch(uploadURL(start.url),{method:'PUT',headers:{'Content-Type':info.type,'x-upsert':'false'},body:file,signal:AbortSignal.any([c.controller.signal,AbortSignal.timeout(120000)])});guard();
      if(!response.ok)throw Error('The file did not finish uploading. Choose it again to retry.');
      status.textContent='Verifying and attaching…';await api({action:'complete',fileId:start.fileId});guard();
     }
     attached=true;await options.onUploaded?.();guard();
     status.textContent=info.kind==='profile_photo'?'Your headshot is updated.':'Your updated résumé is saved. Previous résumés are still available.';
    }catch(e){if(current()&&c.epoch===epoch)status.textContent=attached?'Your file was saved. Refresh this page to view it.':e.message||'The upload could not be completed. Try again.';}
    finally{if(active===c)active=null;if(current())controls.forEach(x=>x.querySelector('button').disabled=false);}
   });
  }
  return controls.length>0;
 }
 root.addEventListener?.('soro-auth-changed',stop);
 root.addEventListener?.('hashchange',stop);
 return {canUpload,fileInfo,markup,mount,stop,uploadURL};
});
