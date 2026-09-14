/* One classification editor for live profiles and the isolated sample runtime. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.soroAssessmentFileEditor=api;}(typeof globalThis!=='undefined'?globalThis:this,function(root){
 'use strict';
 const TYPES=Object.freeze({assessment:'Not Yet Classified',english_proof:'English Assessment',disc_assessment:'DISC Assessment',enneagram_assessment:'Enneagram Assessment',mbti_assessment:'Four-Letter Personality Assessment (MBTI)'});
 const uuid=v=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v||''));
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const scope=()=>JSON.stringify([root.soroCurrentAccess?.user_id,root.soroCurrentAccess?.organization_id,root.soroCurrentAccess?.role,root.soroCurrentAccess?.active,root.soroCurrentAccess?.must_change_password]);
 const authorized=()=>['admin','talent_management'].includes(root.soroCurrentAccess?.role)&&uuid(root.soroCurrentAccess?.user_id)&&uuid(root.soroCurrentAccess?.organization_id)&&root.soroCurrentAccess?.active!==false&&root.soroCurrentAccess?.must_change_password!==true;
 const eligible=d=>Boolean(d&&Object.hasOwn(TYPES,d.document_type)&&d.status!=='rejected'&&d.storage_path);
 let active=null;
 function close(force=false){if(!active||active.saving&&!force)return;const context=active;active=null;context.dialog.close();context.dialog.remove();context.trigger?.focus?.({preventScroll:true});}
 function markup(d){return `<form><header><div><p>Talent Assessment Evidence</p><h2 id="assessment-file-title">Change Assessment Type</h2></div><button type="button" class="button" data-close aria-label="Close assessment editor">×</button></header><div class="assessment-file-body"><section class="assessment-file-source"><strong>${esc(d.file_name)}</strong><span>Currently: ${esc(TYPES[d.document_type])}</span><button type="button" class="button" data-view>View File</button></section><label for="assessment-file-type">Assessment Type</label><select id="assessment-file-type" name="documentType">${Object.entries(TYPES).map(([value,label])=>`<option value="${value}"${d.document_type===value?' selected':''}>${label}</option>`).join('')}</select><p>Open the file, check which test it contains, then choose the matching type.</p><p class="assessment-file-note">This updates the file checklist only. Entering scores and verifying skills are separate steps. The file and its privacy stay unchanged.</p><p role="status" aria-live="polite" data-status></p></div><footer><button type="button" class="button" data-close>Cancel</button><button type="submit" class="button primary" disabled>Save Assessment Type</button></footer></form>`;}
 async function open(applicantId,documentId,{viewFile,afterSave}={}){
  if(!authorized()||!uuid(applicantId)||!uuid(documentId)||active?.saving)return false;
  close();const client=root.soroSupabase,captured=scope(),dialog=root.document.createElement('dialog');
  const context={dialog,trigger:root.document.activeElement,saving:false,scope:captured};active=context;
  const current=()=>active===context&&dialog.open&&authorized()&&scope()===captured&&root.soroSupabase===client;
  dialog.className='assessment-file-dialog';dialog.setAttribute('aria-labelledby','assessment-file-title');
  dialog.innerHTML='<div class="assessment-file-loading"><h2 id="assessment-file-title">Change Assessment Type</h2><p data-status role="status">Loading file details…</p><button class="button" data-close>Close</button></div>';
  root.document.body.append(dialog);dialog.addEventListener('click',event=>{if(event.target.closest('[data-close]'))close();});dialog.addEventListener('cancel',event=>{event.preventDefault();close();});dialog.addEventListener('close',()=>{if(active===context)active=null;dialog.remove();});dialog.showModal();
  try{
   const result=await client.from('documents').select('id,organization_id,applicant_id,file_name,storage_path,document_type,status,updated_at').eq('id',documentId).eq('applicant_id',applicantId).eq('organization_id',root.soroCurrentAccess.organization_id).maybeSingle();
   if(!current())return false;
   const d=result.data;if(result.error||!eligible(d)||d.id!==documentId||d.applicant_id!==applicantId||d.organization_id!==root.soroCurrentAccess.organization_id||!Number.isFinite(Date.parse(d.updated_at)))throw new Error('This assessment file is unavailable. Refresh the profile and try again.');
   dialog.innerHTML=markup(d);const form=dialog.querySelector('form'),select=form.elements.documentType,submit=form.querySelector('[type="submit"]'),status=form.querySelector('[data-status]');
   let requestId=null,requestedType=null;
   select.addEventListener('change',()=>{submit.disabled=select.value===d.document_type;status.textContent='';});
   form.querySelector('[data-view]').addEventListener('click',()=>{if(current())viewFile?.(d.storage_path);});
   form.addEventListener('submit',async event=>{
    event.preventDefault();if(!current()||context.saving||select.value===d.document_type||!Object.hasOwn(TYPES,select.value))return;
    const type=select.value;if(requestedType!==type){requestId=root.crypto.randomUUID();requestedType=type;}
    context.saving=true;form.querySelectorAll('button,select').forEach(c=>c.disabled=true);submit.textContent='Saving…';status.textContent='Updating the assessment category…';status.classList.remove('is-error');
    try{
     const session=await client.auth.getSession();if(!current())return;const token=session.data?.session?.access_token;if(!token)throw new Error('Sign in again to save this change.');
     const response=await root.fetch('/.netlify/functions/talent-assessment-classification',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},cache:'no-store',signal:AbortSignal.timeout(20000),body:JSON.stringify({requestId,applicantId,documentId,expectedType:d.document_type,expectedUpdatedAt:d.updated_at,documentType:type})});
     const saved=await response.json();if(!current())return;
     if(!response.ok)throw new Error(saved.message||'The category could not be saved. Please try again.');
     if(saved.documentId!==documentId||saved.applicantId!==applicantId||saved.documentType!==type)throw new Error('The saved category could not be confirmed. Refresh the profile.');
     context.saving=false;close();root.dispatchEvent(new root.CustomEvent('soro:assessment-file-classified',{detail:{applicantId}}));await afterSave?.(saved);
    }catch(error){if(current()){context.saving=false;form.querySelectorAll('button,select').forEach(c=>c.disabled=false);submit.textContent='Save Assessment Type';status.classList.add('is-error');status.textContent=error.name==='TimeoutError'?'The save could not be confirmed yet. Try again to check the same request, or refresh the profile.':error.message||'The category could not be saved. Please try again.';}}
   });select.focus();return true;
  }catch(error){if(current())dialog.querySelector('[data-status]').textContent=error.message;return false;}
 }
 root.addEventListener?.('soro-auth-changed',()=>close(true));root.addEventListener?.('hashchange',()=>close(true));
 return Object.freeze({TYPES,authorized,eligible,open,close,markup});
}));
