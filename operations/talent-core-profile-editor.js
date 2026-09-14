/* Focused editor for the existing applicant record; never a second profile. */
(function(root,factory){
  const api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.soroTalentCoreProfileEditor=api;
}(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const labels={full_name:'Full Name',email:'Contact Email',phone:'Phone Number',timezone:'Time Zone',location:'Location'};
  const fields=['full_name','email','phone','timezone','country','city'];
  let active=null;
  const data=()=>root.soroTalentCoreProfileData;
  function timezones(current){
    let zones=[];
    try{zones=root.Intl?.supportedValuesOf?.('timeZone')||[];}catch{}
    return [...new Set(['Asia/Manila','UTC','America/Chicago','America/New_York','America/Los_Angeles','Europe/London',...zones,...(current?[current]:[])])];
  }
  function input(key,label,value,type='text',hint=''){
    const maximum=data()?.LIMITS?.[key]||({full_name:180,email:254,phone:80,country:120,city:160})[key];
    return `<label class="core-profile-field" data-core-field="${key}"><span>${label}<small data-core-missing hidden>Missing</small></span><input name="${key}" type="${type}" value="${escape(value)}" maxlength="${maximum}"${['full_name','email'].includes(key)?' required':''}${key==='phone'?' autocomplete="tel"':''}>${hint?`<small>${hint}</small>`:''}</label>`;
  }
  function markup(snapshot){
    const r={...snapshot.record,location:String(snapshot.record.location||'').trim()};
    return `<form class="core-profile-form" novalidate><header><div><p class="core-profile-eyebrow">${escape(r.full_name||'Talent Review')}</p><h2 id="core-profile-title">Edit Core Profile</h2><p>The essential details needed to complete this part of the review.</p></div><button type="button" class="core-profile-close" data-core-close aria-label="Close core profile">×</button></header><div class="core-profile-body"><div class="core-profile-completion" data-core-completion role="status" aria-live="polite"></div><section aria-label="Identity and contact details" class="core-profile-grid">${input('full_name','Full Name',r.full_name,'text','Keep the existing name order: Last name, First name(s).')}${input('email','Contact Email',r.email,'email','Application contact only. Portal sign-in email stays unchanged.')}${input('phone','Phone Number',r.phone,'tel','Include the country code when available.')}<label class="core-profile-field" data-core-field="timezone"><span>Time Zone<small data-core-missing hidden>Missing</small></span><select name="timezone"><option value="">Choose a time zone</option>${timezones(r.timezone).map(zone=>`<option value="${escape(zone)}"${r.timezone===zone?' selected':''}>${escape(zone==='Asia/Manila'?'Philippine Time — Asia/Manila':zone.replace(/_/g,' '))}</option>`).join('')}</select><small>Used to interpret the applicant’s local time.</small></label></section><section class="core-profile-location" aria-labelledby="core-profile-location-title"><div class="core-profile-location-heading"><h3 id="core-profile-location-title">Location</h3><span data-core-location-missing hidden>Missing</span></div><p>Add both the city and country, or keep the location already recorded.</p><div class="core-profile-grid">${input('country','Country',r.country)}${input('city','City / Municipality',r.city)}</div>${r.location?`<p class="core-profile-legacy-location"><strong>Previously Recorded Location</strong><span>${escape(r.location)}</span><small>This existing location already satisfies the location requirement.</small></p>`:''}</section><p class="core-profile-save-status" data-core-status role="status" aria-live="polite"></p></div><footer><p>Changes update this Talent’s existing profile. Other review items stay separate.</p><div><button type="button" class="button" data-core-close>Cancel</button><button type="submit" class="button primary">Save Core Profile</button></div></footer></form>`;
  }
  function values(form){return Object.fromEntries(fields.map(key=>[key,String(form.elements[key]?.value||'')]));}
  function paintProgress(form,snapshot){
    const missing=data().missingFields({...snapshot.record,...values(form)});
    const status=form.querySelector('[data-core-completion]');
    status.classList.toggle('is-complete',missing.length===0);
    status.textContent=missing.length?`${5-missing.length} of 5 Core Requirements Filled · Missing: ${missing.map(key=>labels[key]).join(', ')}`:'All 5 Core Requirements Filled · Save to update the checklist';
    for(const key of ['full_name','email','phone','timezone']){
      const label=form.querySelector(`[data-core-field="${key}"]`);
      label.classList.toggle('is-missing',missing.includes(key));label.querySelector('[data-core-missing]').hidden=!missing.includes(key);
    }
    form.querySelector('[data-core-location-missing]').hidden=!missing.includes('location');
    return missing;
  }
  function close(force=false){
    const context=active;
    if(!context||context.saving&&!force)return false;
    active=null;context.dialog.close();context.dialog.remove();return true;
  }
  function isOpen(){return Boolean(active?.dialog.open);}
  async function open(applicant,afterSave){
    const service=data();
    if(!service?.authorized()||!applicant?.applicantId)return false;
    if(active?.saving)return false;
    close();
    const dialog=root.document.createElement('dialog');
    dialog.className='core-profile-dialog';dialog.dataset.coreProfileDialog='';dialog.setAttribute('aria-labelledby','core-profile-title');
    const context={dialog,scope:service.scope(),saving:false};active=context;
    const current=()=>active===context&&dialog.open&&service.authorized()&&service.scope()===context.scope;
    dialog.innerHTML='<div class="core-profile-loading"><h2 id="core-profile-title">Edit Core Profile</h2><p data-core-status role="status">Loading profile details…</p><button type="button" class="button" data-core-close>Cancel</button></div>';
    root.document.body.append(dialog);
    dialog.addEventListener('click',event=>{if(event.target.closest('[data-core-close]'))close();});
    dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
    dialog.addEventListener('close',()=>{if(active===context)active=null;dialog.remove();});
    dialog.showModal();
    try{
      const snapshot=await service.load(applicant.applicantId);
      if(!current())return false;
      dialog.innerHTML=markup(snapshot);
      const form=dialog.querySelector('form');paintProgress(form,snapshot);
      form.addEventListener('input',()=>paintProgress(form,snapshot));form.addEventListener('change',()=>paintProgress(form,snapshot));
      form.addEventListener('submit',async event=>{
        event.preventDefault();if(context.saving||!current())return;
        const status=form.querySelector('[data-core-status]');
        if(!form.reportValidity())return;
        const payload=values(form);context.saving=true;
        const controls=[...form.querySelectorAll('input,select,button')];controls.forEach(control=>control.disabled=true);
        const submit=form.querySelector('[type="submit"]');submit.textContent='Saving…';status.textContent='Saving the profile and checking required details…';status.classList.remove('is-error');
        let saved;
        try{saved=await service.save(applicant.applicantId,snapshot,payload);}
        catch(error){
          if(current()){
            status.textContent=error.message||'The profile could not be saved. Please try again.';status.classList.add('is-error');context.saving=false;
            if(error.saved){
              form.querySelectorAll('[data-core-close]').forEach(control=>control.disabled=false);submit.textContent='Saved';
              const reload=root.document.createElement('button');reload.type='button';reload.className='button';reload.textContent='Reload Saved Profile';reload.addEventListener('click',()=>open(applicant,afterSave));status.append(reload);
            }else{controls.forEach(control=>control.disabled=false);submit.textContent='Save Core Profile';}
          }
          return;
        }
        if(!current())return;
        context.saving=false;close();
        await afterSave?.(saved);
      });
      const firstMissing=service.missingFields(snapshot.record)[0];
      form.elements[firstMissing==='location'?'city':firstMissing||'full_name']?.focus();
      return true;
    }catch(error){
      if(current()){
        dialog.querySelector('[data-core-status]').textContent=error.message||'Profile details could not be loaded.';
        const retry=root.document.createElement('button');retry.type='button';retry.className='button primary';retry.textContent='Try Again';retry.addEventListener('click',()=>open(applicant,afterSave));dialog.querySelector('.core-profile-loading').append(retry);
      }
      return false;
    }
  }
  root.addEventListener?.('soro-auth-changed',()=>close(true));
  root.addEventListener?.('hashchange',()=>close(true));
  return Object.freeze({open,close,isOpen,markup,values,timezones});
}));
