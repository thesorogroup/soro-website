/* Focused checklist evidence/results editor using the existing private records and RLS. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.soroTalentChecklistEditor=api;}(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  const TYPES=Object.freeze({resume:'resume',english:'english_proof',disc:'disc_assessment',enneagram:'enneagram_assessment',mbti:'mbti_assessment',internet:'internet_proof',equipment:'equipment_proof'});
  const LABELS=Object.freeze({resume:'Résumé',english:'English Assessment',disc:'DISC Assessment',enneagram:'Enneagram Assessment',mbti:'Four-Letter Personality',internet:'Internet Speed',equipment:'Computer Specifications'});
  const COLUMNS='id,organization_id,updated_at,resume_url,english_test_result,personality_profile_score,computer_specs,internet_speed';
  const DOC_COLUMNS='id,organization_id,applicant_id,file_name,storage_path,document_type,status,updated_at,created_at';
  const uuid=v=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v||''));
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const service=()=>root.soroTalentCoreProfileData;
  const presentation=()=>root.soroScreeningPresentation;
  const snapshots=new WeakMap();
  let active=null;
  function session(applicantId){
    if(!service()?.authorized()||!uuid(applicantId)||!root.soroSupabase)throw new Error('Your review access is unavailable. Sign in again.');
    const client=root.soroSupabase,scope=service().scope(),organizationId=root.soroCurrentAccess.organization_id;
    return{client,scope,organizationId,applicantId,check(){if(!service().authorized()||service().scope()!==scope||client!==root.soroSupabase)throw new Error('Your review access changed. Reopen this item.');}};
  }
  async function load(applicantId){
    const context=session(applicantId);
    const result=await context.client.from('applicants').select(COLUMNS).eq('organization_id',context.organizationId).eq('id',applicantId).is('archived_at',null).maybeSingle();
    context.check();const record=result.data;
    if(result.error||!record||record.id!==applicantId||record.organization_id!==context.organizationId||!Number.isFinite(Date.parse(record.updated_at)))throw new Error('The saved results could not be loaded. Try again.');
    const snapshot={record:Object.freeze({...record})};snapshots.set(snapshot,context);return snapshot;
  }
  function editorValues(key,record){
    const p=presentation();
    if(key==='english')return{result:record.english_test_result||''};
    if(['disc','enneagram','mbti'].includes(key))return{result:p.parsePersonalityResults(record.personality_profile_score)[key]};
    if(key==='internet')return p.internetSpeedEditorValues(record.internet_speed);
    if(key==='equipment')return p.parseComputerSpecs(record.computer_specs);
    return{};
  }
  function updatesFor(key,record,values){
    const p=presentation(),limits=key==='equipment'?64:key==='english'?240:140;
    const expected=Object.keys(editorValues(key,record));
    if(!expected.length||!values||Object.keys(values).length!==expected.length||expected.some(k=>!Object.hasOwn(values,k)))throw new Error('Only this checklist item can be updated here.');
    const clean={};for(const k of expected){const v=String(values[k]??'').trim();if(v.length>limits||/[\u0000-\u001f|;\u007f]/.test(v))throw new Error('Use a single result per field, within the displayed length limit.');clean[k]=v;}
    if(!Object.values(clean).some(Boolean))throw new Error('Enter the result you reviewed, or choose Verify Later.');
    if(key==='english')return{english_test_result:clean.result};
    if(['disc','enneagram','mbti'].includes(key)){
      // Replace only the selected tagged segment; preserve other tests AND unrecognized legacy notes.
      const patterns={disc:/^disc\b/i,enneagram:/^enneagram\b/i,mbti:/^(?:mbti(?:-style)?|personality\s+type)\b/i};
      const raw=String(record.personality_profile_score||'');
      const parts=raw.split(/[|;\n]+/).map(s=>s.trim()).filter(Boolean).filter(part=>!patterns[key].test(part)&&!(key==='mbti'&&/^[EI][NS][FT][JP](?:-[AT])?$/i.test(part)));
      parts.push(`${{disc:'DISC',enneagram:'Enneagram',mbti:'MBTI-style'}[key]}: ${clean.result}`);
      return{personality_profile_score:parts.join(' | ')};
    }
    if(key==='internet')return{internet_speed:p.serializeInternetSpeed(clean,record.internet_speed)};
    return{computer_specs:p.serializeComputerSpecs(clean)};
  }
  async function save(applicantId,snapshot,key,values){
    const context=session(applicantId),trusted=snapshots.get(snapshot);
    if(!trusted||trusted.client!==context.client||trusted.scope!==context.scope||trusted.applicantId!==applicantId)throw new Error('Reopen this checklist item before saving.');
    const updates=updatesFor(key,snapshot.record,values);context.check();
    const result=await context.client.from('applicants').update(updates).eq('organization_id',context.organizationId).eq('id',applicantId).eq('updated_at',snapshot.record.updated_at).is('archived_at',null).select(COLUMNS).maybeSingle();
    context.check();
    if(result.error||!result.data)throw new Error('This profile may have changed. Close and reopen this item before saving again. Newer results have not been overwritten.');
    if(result.data.id!==applicantId||result.data.organization_id!==context.organizationId)throw new Error('The save could not be confirmed. Refresh the queue before trying again.');
    return result.data;
  }
  async function documents(applicantId,key){
    const context=session(applicantId),types=['disc','enneagram','mbti'].includes(key)?[TYPES[key],'assessment']:[TYPES[key]];
    const result=await context.client.from('documents').select(DOC_COLUMNS).eq('organization_id',context.organizationId).eq('applicant_id',applicantId).in('document_type',types).neq('status','rejected').order('created_at',{ascending:false}).order('id',{ascending:false});
    context.check();if(result.error||!Array.isArray(result.data))throw new Error('The submitted files could not be loaded. Your result fields are still available.');
    return result.data.filter(d=>d.applicant_id===applicantId&&d.organization_id===context.organizationId&&d.status!=='rejected'&&types.includes(d.document_type));
  }
  function legacyResumeUrl(value){try{const url=new URL(String(value||''));return url.protocol==='https:'&&!url.username&&!url.password&&['drive.google.com','docs.google.com'].includes(url.hostname)?url.href:'';}catch{return '';}}
  async function signedFile(applicantId,document){
    const context=session(applicantId);
    if(document.applicant_id!==applicantId||document.organization_id!==context.organizationId||!document.storage_path)throw new Error('The file has not finished uploading. Request a new copy or choose Verify Later.');
    // Only the opaque, offline Test Mode runtime can supply an owned fictional image.
    if(root.parent!==root&&root.location?.protocol==='about:'&&root.SoroTestSession?.previewFile){
      const sample=root.SoroTestSession.previewFile(applicantId,document.id);context.check();
      if(sample&&/^data:image\/(?:png|jpeg|webp|svg\+xml)[;,]/.test(sample))return sample;
    }
    const signed=await context.client.storage.from('soro-private-documents').createSignedUrl(document.storage_path,60);context.check();
    let url;try{url=new URL(signed.data?.signedUrl||'');}catch{throw new Error('The secure file could not be opened. Try Reload File.');}
    if(signed.error||url.protocol!=='https:'||url.origin!==new URL(context.client.supabaseUrl).origin||!url.pathname.startsWith('/storage/v1/object/sign/soro-private-documents/')||url.username||url.password)throw new Error('The secure file could not be opened. Try Reload File.');
    return url.href;
  }
  function fieldsMarkup(key,record){
    const values=editorValues(key,record);
    const input=(name,label,placeholder='',numeric=false,max=140)=>`<label><span>${label}</span><input name="${name}" ${numeric?'type="number" inputmode="decimal" min="0" step="any"':'type="text"'} maxlength="${max}" value="${esc(values[name])}" placeholder="${esc(placeholder)}"></label>`;
    if(key==='resume')return '<div class="checklist-resume-note"><h3>Review the Résumé</h3><p>Check the applicant’s experience, skills, and references in the submitted file.</p><p>A résumé on file satisfies this checklist item. Skills and references are verified separately.</p></div>';
    if(key==='internet')return`${input('download','Download Speed','Mbps',true)}${input('upload','Upload Speed','Mbps',true)}<small>Enter numbers only, in Mbps.</small>`;
    if(key==='equipment')return presentation().COMPUTER_SPEC_FIELDS.map(f=>input(f.key,f.label,'',false,64)).join('');
    const examples={english:'e.g. CEFR B2 · 86%',disc:'e.g. D 42, I 30, S 18, C 10',enneagram:'e.g. Type 3',mbti:'e.g. ENFJ-T'};
    return input('result',`${LABELS[key]} Result`,examples[key],false,key==='english'?240:140);
  }
  function markup(applicant,key){return `<header class="checklist-editor-header"><div><p>${esc(applicant.fullName)}</p><h2 id="checklist-editor-title">${LABELS[key]}</h2><p>Review the submitted file and record the matching details here.</p></div><button type="button" class="button" data-checklist-close aria-label="Close checklist editor">×</button></header><div class="checklist-editor-workspace"><aside class="checklist-editor-evidence"><div class="checklist-source-heading"><h3>Submitted File</h3><button type="button" class="button" data-checklist-reload>Reload File</button></div><div data-checklist-files></div><div data-checklist-preview role="region" aria-label="Submitted evidence"><p role="status">Loading submitted files…</p></div></aside><section class="checklist-editor-details"><div data-checklist-fields><p role="status">Loading recorded details…</p></div><p data-checklist-status role="status" aria-live="polite"></p></section></div><footer class="checklist-editor-footer"><button type="button" class="button" data-checklist-defer>Verify Later</button><div><button type="button" class="button" data-checklist-close>${key==='resume'?'Done':'Cancel'}</button>${key==='resume'?'':'<button type="submit" form="checklist-result-form" class="button primary" data-checklist-save disabled>Save Result</button>'}</div></footer>`;}
  function close(force=false){
    if(!active||active.saving&&!force)return false;
    const context=active;active=null;context.viewer?.destroy();context.dialog.close();context.dialog.remove();context.trigger?.focus?.({preventScroll:true});return true;
  }
  function isOpen(){return Boolean(active?.dialog.open);}
  async function open(applicant,key,{afterSave,onVerifyLater}={}){
    if(!Object.hasOwn(TYPES,key)||!service()?.authorized()||!uuid(applicant?.applicantId)||active?.saving)return false;
    close();const captured=session(applicant.applicantId),dialog=root.document.createElement('dialog');
    const context={dialog,trigger:root.document.activeElement,saving:false,viewer:null,fileVersion:0,fieldVersion:0};active=context;
    const current=()=>active===context&&dialog.open&&service().authorized()&&service().scope()===captured.scope&&root.soroSupabase===captured.client;
    dialog.className='checklist-editor-dialog';dialog.setAttribute('aria-labelledby','checklist-editor-title');dialog.innerHTML=markup(applicant,key);
    root.document.body.append(dialog);dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
    dialog.addEventListener('close',()=>{if(active===context){active=null;context.viewer?.destroy();}dialog.remove();});
    dialog.addEventListener('click',e=>{if(e.target.closest('[data-checklist-close]'))close();if(e.target.closest('[data-checklist-defer]')&&!context.saving){close();onVerifyLater?.();}});
    dialog.showModal();
    const status=dialog.querySelector('[data-checklist-status]');
    async function showFile(document){
      const version=++context.fileVersion;context.viewer?.destroy();context.viewer=null;
      const host=dialog.querySelector('[data-checklist-preview]');host.innerHTML='<p role="status">Opening the private file…</p>';
      try{
        const url=await signedFile(applicant.applicantId,document);if(!current()||version!==context.fileVersion)return;
        const ext=url.startsWith('data:image/')?'png':String(document.file_name||'').toLowerCase().split('.').pop();
        const unknown=document.document_type==='assessment';
        host.innerHTML=`${unknown?'<p class="checklist-file-warning">This file has not been categorized yet. Check that it is the correct assessment before recording a result.</p>':''}<p class="checklist-file-name">${esc(document.file_name)}</p><div class="checklist-source-actions"><a class="button" href="${esc(url)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Open Separately</a>${root.soroAssessmentFileEditor?.eligible(document)?'<button type="button" class="button" data-checklist-classify>Change Assessment Type</button>':''}</div>${ext==='pdf'?root.soroPrivatePdfViewer?.documentMarkup()||'<p>Open this PDF separately to review it.</p>':['jpg','jpeg','png','webp'].includes(ext)?`<div class="checklist-image-scroll"><img src="${esc(url)}" alt="${esc(LABELS[key])} submitted evidence" referrerpolicy="no-referrer"></div>`:'<p>This format can be reviewed using Open Separately.</p>'}`;
        host.querySelector('img')?.addEventListener('error',()=>{if(current()&&version===context.fileVersion){host.querySelector('.checklist-image-scroll').innerHTML='<p role="alert">The image could not be displayed. Choose Reload File, or open it separately.</p>';}});
        if(ext==='pdf'&&root.soroPrivatePdfViewer){context.viewer=root.soroPrivatePdfViewer.mount(host.querySelector('[data-private-pdf-viewer]'),{url,storageOrigin:captured.client.supabaseUrl,label:'Assessment file',isCurrent:()=>current()&&version===context.fileVersion});}
        host.querySelector('[data-checklist-classify]')?.addEventListener('click',()=>{if(current()&&!context.saving)root.soroAssessmentFileEditor.open(applicant.applicantId,document.id,{viewFile:()=>host.querySelector('a').click(),afterSave:async()=>{
          if(!current())return;
          context.snapshotRefreshing=true;
          const saveButton=dialog.querySelector('[data-checklist-save]');if(saveButton)saveButton.disabled=true;
          await loadFiles();
          try{const latest=await load(applicant.applicantId);if(!current())return;
            if(context.snapshot&&['english_test_result','personality_profile_score','computer_specs','internet_speed'].every(k=>latest.record[k]===context.snapshot.record[k])){context.snapshot=latest;context.snapshotRefreshing=false;if(saveButton&&!context.saving)saveButton.disabled=false;}
            else{status.textContent='The file category was saved. Other results changed while this item was open; close and reopen before saving your result.';status.classList.add('is-error');}
          }catch(error){if(current()){status.textContent=error.message;status.classList.add('is-error');}}
        }});});
      }catch(error){if(current()&&version===context.fileVersion)host.innerHTML=`<p role="alert">${esc(error.message)}</p>`;}
    }
    async function loadFiles(){
      const version=++context.fileVersion;
      try{
        const files=await documents(applicant.applicantId,key);if(!current()||version!==context.fileVersion)return;
        context.files=files;const assigned=files.filter(d=>d.document_type===TYPES[key]);const selected=assigned[0]||files[0];
        const chooser=dialog.querySelector('[data-checklist-files]');
        chooser.innerHTML=files.length>1?`<label>File<select data-checklist-file>${files.map(d=>`<option value="${esc(d.id)}"${selected.id===d.id?' selected':''}>${esc(d.file_name)}${d.document_type==='assessment'?' · Not Yet Classified':''}</option>`).join('')}</select></label>`:'';
        chooser.querySelector('select')?.addEventListener('change',e=>{const d=files.find(d=>d.id===e.target.value);if(d)showFile(d);});
        if(selected)await showFile(selected);else{
          let original='';if(key==='resume'){const snapshot=await load(applicant.applicantId);if(!current()||version!==context.fileVersion)return;original=legacyResumeUrl(snapshot.record.resume_url);}
          context.viewer?.destroy();dialog.querySelector('[data-checklist-preview]').innerHTML=original?`<div class="checklist-file-empty"><h3>Original Application Résumé</h3><p>This legacy résumé is stored in Google Drive. Open the original to review it.</p><a class="button" href="${esc(original)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Open Original Résumé</a></div>`:'<div class="checklist-file-empty"><h3>No File on Record</h3><p>You can record known results from a previous review, or choose Verify Later if you still need evidence.</p></div>';
        }
      }catch(error){if(current()&&version===context.fileVersion)dialog.querySelector('[data-checklist-preview]').innerHTML=`<p role="alert">${esc(error.message)} Choose Reload File to try again.</p>`;}
    }
    dialog.querySelector('[data-checklist-reload]').addEventListener('click',()=>{if(!context.saving)loadFiles();});
    async function loadFields(){
      const version=++context.fieldVersion;const retry=dialog.querySelector('[data-checklist-retry]');if(retry)retry.disabled=true;
      try{
        const snapshot=await load(applicant.applicantId);if(!current()||version!==context.fieldVersion)return;context.snapshot=snapshot;
        const host=dialog.querySelector('[data-checklist-fields]');host.innerHTML=`<form id="checklist-result-form" class="checklist-result-form">${key==='resume'?'':'<h3>Record Result</h3><p>Enter only what you have reviewed. Saving updates this Talent’s profile and the queue checklist.</p>'}${fieldsMarkup(key,snapshot.record)}</form>`;
        const form=host.querySelector('form'),submit=dialog.querySelector('[data-checklist-save]');if(submit)submit.disabled=false;
        form.addEventListener('submit',async event=>{
          event.preventDefault();if(!current()||context.saving||context.snapshotRefreshing||key==='resume'||!form.reportValidity())return;
          const values=Object.fromEntries([...new root.FormData(form).entries()]);
          try{updatesFor(key,context.snapshot.record,values);}catch(error){status.textContent=error.message;status.classList.add('is-error');return;}
          context.saving=true;const controls=[...dialog.querySelectorAll('button,input,select')].map(c=>[c,c.disabled]);controls.forEach(([c])=>c.disabled=true);submit.textContent='Saving…';status.classList.remove('is-error');status.textContent='Saving the result…';
          try{
            const saved=await save(applicant.applicantId,context.snapshot,key,values);if(!current())return;
            context.saving=false;close();await afterSave?.(saved);
          }catch(error){if(current()){context.saving=false;controls.forEach(([c,disabled])=>c.disabled=disabled);submit.textContent='Save Result';status.textContent=error.message||'The result could not be saved. Please try again.';status.classList.add('is-error');}}
        });
      }catch(error){if(current()&&version===context.fieldVersion){dialog.querySelector('[data-checklist-fields]').innerHTML=`<p role="alert">${esc(error.message)}</p><button class="button" data-checklist-retry>Try Again</button>`;dialog.querySelector('[data-checklist-retry]').addEventListener('click',loadFields);}}
    }
    await Promise.all([loadFiles(),loadFields()]);return current();
  }
  root.addEventListener?.('soro-auth-changed',()=>close(true));root.addEventListener?.('hashchange',()=>close(true));
  return Object.freeze({open,close,isOpen,load,save,documents,signedFile,legacyResumeUrl,editorValues,updatesFor,fieldsMarkup,markup,TYPES,LABELS});
}));
