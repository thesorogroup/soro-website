/* Founder self-service and explicit Administrator ownership controls. */
(function(root){
  'use strict';
  const FIELDS=[['full_name','Full name','text',120],['contact_email','Private contact email','email',254],['phone','Phone number','tel',40],['hire_date','Hire date','date',10],['address_line_1','Street address','text',160],['address_line_2','Apartment / suite','text',160],['city','City','text',100],['state_region','State / province / region','text',100],['postal_code','Postal code','text',24],['country','Country','text',100],['business_email','Client-facing work email','email',254],['business_phone','Client-facing work phone','tel',40]];
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let generation=0;
  const dialogs=new Set();
  const isAdmin=()=>root.soroCurrentAccess?.role==='admin' && root.soroCurrentAccess?.active!==false && root.soroCurrentAccess?.must_change_password!==true;
  const isFounder=()=>isAdmin() && root.soroCurrentAccess?.is_founder===true;
  const scope=()=>JSON.stringify([root.soroCurrentAccess?.user_id,root.soroCurrentAccess?.organization_id,root.soroCurrentAccess?.role,root.soroCurrentAccess?.is_founder,root.soroCurrentAccess?.active,root.soroCurrentAccess?.must_change_password,generation]);
  async function request(body, captured=scope()) {
    const session=await root.soroSupabase.auth.getSession();
    if(scope()!==captured) throw new Error('Your account changed. Reopen this form.');
    const token=session.data?.session?.access_token;
    if(!token) throw new Error('Sign in again to continue.');
    const response=await fetch('/.netlify/functions/staff-account',{method:'POST',cache:'no-store',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
    const result=await response.json();
    if(scope()!==captured) throw new Error('Your account changed. Reopen this form.');
    if(!response.ok) throw new Error(result.message||'The change could not be saved.');
    return result;
  }
  function shell(title){
    const dialog=document.createElement('dialog');
    dialog.className='record-manager-dialog employee-dialog staff-account-dialog';
    dialog.innerHTML=`<section class="record-manager-shell"><header class="record-manager-header"><div><p class="record-manager-eyebrow">Private account management</p><h2>${esc(title)}</h2></div><button class="record-manager-close" type="button" aria-label="Close account management">×</button></header><div class="record-manager-form" data-staff-body><p role="status">Loading secure details…</p></div></section>`;
    dialog.querySelector('h2').id=`staff-heading-${crypto.randomUUID()}`;
    dialog.setAttribute('aria-labelledby',dialog.querySelector('h2').id);
    document.body.append(dialog);dialogs.add(dialog);
    dialog.querySelector('.record-manager-close').addEventListener('click',()=>dialog.close());
    dialog.addEventListener('close',()=>{dialogs.delete(dialog);dialog.remove();});
    dialog.showModal();return dialog;
  }
  function fail(dialog,error){if(dialog.open) dialog.querySelector('[role="status"]').textContent=error.message;}
  async function openAccount(){
    if(!isFounder())return;
    const captured=scope(),dialog=shell('My Account');
    try{
      const record=await request({action:'account_read'},captured);if(!dialog.open)return;
      dialog.querySelector('[data-staff-body]').innerHTML=`<form><section class="employee-effective-access"><strong>The Founder</strong><p>Your role and access remain protected. These details update your employee profile and the names shown in assignment lists.</p><p>Sign-in email: <strong>${esc(record.loginEmail)}</strong> · unchanged by this form.</p></section><div class="record-manager-grid">${FIELDS.map(([key,label,type,max])=>`<div class="record-manager-field"><label>${esc(label)}${['full_name','contact_email'].includes(key)?'':' <span>Optional</span>'}<input name="${key}" type="${type}" maxlength="${max}" ${['full_name','contact_email'].includes(key)?'required':''} value="${esc(record.profile[key])}" /></label></div>`).join('')}</div><p class="record-manager-note">Private contact details stay private. Only the client-facing work email and phone are shown to clients you own. Payment settings and sign-in credentials are managed separately.</p><p role="status" aria-live="polite"></p><footer class="record-manager-footer"><button type="button" class="admin-record-button" data-cancel>Cancel</button><button class="admin-record-button admin-record-button--primary" type="submit">Save account details</button></footer></form>`;
      const form=dialog.querySelector('form');form.querySelector('[data-cancel]').onclick=()=>dialog.close();
      let expected=record.updatedAt;
      form.addEventListener('submit',async event=>{
        event.preventDefault();const button=form.querySelector('[type="submit"]');button.disabled=true;
        try{
          const updated=await request({action:'account_save',profile:Object.fromEntries(FIELDS.map(([key])=>[key,form.elements[key].value.trim()||null])),expectedUpdatedAt:expected},captured);
          expected=updated.updatedAt;
          root.dispatchEvent(new CustomEvent('soro:staff-account-updated',{detail:{userId:updated.userId,displayName:updated.profile.full_name}}));
          root.soroEmployeeManagement?.loadEmployees?.();
          if(!dialog.open)return;
          form.querySelector('[role="status"]').textContent='Account details saved. Your sign-in email and permissions are unchanged.';
        }catch(error){fail(dialog,error);}finally{if(dialog.open)button.disabled=false;}
      });
    }catch(error){fail(dialog,error);}
  }
  async function openOwnership(kind,id,initialField='review',afterSave){
    if(!isAdmin())return;
    const captured=scope(),dialog=shell('Assign or reassign ownership');
    try{
      let workspace=await request({action:'ownership_read',kind,entityId:id},captured);if(!dialog.open)return;
      const fields=kind==='client'?[['sales','Client owner']]:[['review','Review owner'],['support','Talent support owner'],['sales','Sales owner']];
      dialog.querySelector('[data-staff-body]').innerHTML=`<form><h3>${esc(workspace.record.name)}</h3><p>Administrators can change the responsible team member without changing the profile’s review stage.</p><div class="record-manager-field"><label>Responsibility<select name="field">${fields.map(([key,label])=>`<option value="${key}">${label}</option>`).join('')}</select></label></div><div class="record-manager-field"><label>Assigned to<select name="owner"></select></label></div>${kind==='client'?`<p class="record-manager-note">This also transfers the connected candidate workflow (${workspace.linkedTalentCount} Talent). Scheduled interviews must be resolved through the interview workflow first so calendar attendees stay correct.</p>`:'<p class="record-manager-note">Sales ownership for a Talent already in a Client process is changed through that Client, keeping both records together.</p>'}<p role="status" aria-live="polite"></p><footer class="record-manager-footer"><button type="button" class="admin-record-button" data-cancel>Cancel</button><button type="submit" class="admin-record-button admin-record-button--primary">Save assignment</button></footer></form>`;
      const form=dialog.querySelector('form');form.elements.field.value=fields.some(([key])=>key===initialField)?initialField:fields[0][0];
      const fill=()=>{
        const field=form.elements.field.value;
        const people=workspace.assignees.filter(person=>field==='sales'?person.salesEligible:['admin','talent_management'].includes(person.role));
        form.elements.owner.innerHTML='<option value="">Unassigned</option>'+people.map(person=>`<option value="${esc(person.id)}">${esc(person.name)}${person.isFounder?' — The Founder':''}</option>`).join('');
        const value=workspace.record[`${field}OwnerId`]||'';
        if(value && !people.some(p=>p.id===value)) form.elements.owner.insertAdjacentHTML('beforeend',`<option value="${esc(value)}" disabled>Current owner (inactive or unavailable)</option>`);
        form.elements.owner.value=value;
      };
      fill();form.elements.field.onchange=fill;form.querySelector('[data-cancel]').onclick=()=>dialog.close();
      form.addEventListener('submit',async event=>{
        event.preventDefault();const button=form.querySelector('[type="submit"]');button.disabled=true;
        try{
          workspace=await request({action:'ownership_save',kind,entityId:id,field:form.elements.field.value,ownerId:form.elements.owner.value||null,requestId:crypto.randomUUID(),expectedUpdatedAt:workspace.record.updatedAt},captured);
          afterSave?.();root.dispatchEvent(new CustomEvent('soro:ownership-updated',{detail:{kind,id}}));
          if(!dialog.open)return;
          form.querySelector('[role="status"]').textContent='Assignment updated.';fill();
        }catch(error){fail(dialog,error);}finally{if(dialog.open)button.disabled=false;}
      });
    }catch(error){fail(dialog,error);}
  }
  async function openDuplicate(sourceId){
    if(!isFounder())return;
    const captured=scope(),dialog=shell('Consolidate duplicate employee');
    try{
      const audit=await request({action:'duplicate_audit',sourceId},captured);if(!dialog.open)return;
      dialog.querySelector('[data-staff-body]').innerHTML=`<form><h3>${esc(audit.source.name)}</h3><p>${esc(audit.source.email)}</p><p>Move current assignments to <strong>${esc(audit.target.name)} — The Founder</strong>, then retire this duplicate login. Completed activity and audit history remain attributed to the original account. No files or historical records are deleted.</p><details><summary>Recorded references (${audit.references.reduce((sum,r)=>sum+r.count,0)})</summary><ul>${audit.references.map(r=>`<li>${esc(r.table)} · ${esc(r.column)}: ${r.count}</li>`).join('')}</ul></details>${audit.blockers.length?`<section class="employee-effective-access"><strong>Resolve before consolidation</strong><ul>${audit.blockers.map(b=>`<li>${esc(b)}</li>`).join('')}</ul></section>`:''}<label class="record-manager-field">Type the duplicate account’s email to confirm<input name="confirmEmail" type="email" autocomplete="off" required /></label><p role="status" aria-live="polite"></p><footer class="record-manager-footer"><button class="admin-record-button" type="button" data-cancel>Cancel</button><button type="submit" class="admin-record-button admin-record-button--primary" ${audit.blockers.length?'disabled':''}>Transfer assignments & retire duplicate</button></footer></form>`;
      const form=dialog.querySelector('form');form.querySelector('[data-cancel]').onclick=()=>dialog.close();
      form.addEventListener('submit',async event=>{
        event.preventDefault();
        if(form.elements.confirmEmail.value.trim().toLowerCase()!==audit.source.email.toLowerCase()){form.querySelector('[role="status"]').textContent='Enter the exact duplicate email shown above.';return;}
        const button=form.querySelector('[type="submit"]');button.disabled=true;
        try{
          await request({action:'duplicate_retire',sourceId,fingerprint:audit.fingerprint,expectedEmail:audit.source.email,expectedName:audit.source.name},captured);
          root.soroEmployeeManagement?.loadEmployees?.();root.soroTalentReviewQueue?.refresh?.({silent:true});
          if(dialog.open)dialog.querySelector('[data-staff-body]').innerHTML='<p role="status">Current assignments transferred. The duplicate login is retired; its historical records are preserved.</p>';
        }catch(error){fail(dialog,error);if(dialog.open)button.disabled=false;}
      });
    }catch(error){fail(dialog,error);}
  }
  function syncNav(){
    let item=document.getElementById('founder-account-nav');
    if(!item){item=document.createElement('button');item.id='founder-account-nav';item.className='nav-link';item.type='button';item.textContent='My Account';document.querySelector('.sidebar nav')?.append(item);item.addEventListener('click',openAccount);}
    item.hidden=!isFounder();
  }
  root.addEventListener('soro-auth-changed',()=>{generation++;for(const dialog of dialogs)dialog.close();syncNav();});
  document.addEventListener('click',event=>{const button=event.target.closest('[data-staff-ownership]');if(button)openOwnership(button.dataset.staffOwnership,button.dataset.ownerEntity,button.dataset.ownerField||'review');});
  root.SoroStaffAccount={openAccount,openOwnership,openDuplicate,isFounder,isAdmin};
  syncNav();
})(window);
