/* Full-catalog skill selection for the existing protected Talent profile. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.soroTalentSkillEditor = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const key = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  let active = null;
  function buildGroups(snapshot) {
    const groups = [], entries = new Map();
    for (const source of snapshot.catalog || []) {
      const group = {id: source.id, label: source.label, skills: []};
      groups.push(group);
      for (const skill of source.skills || []) {
        if (!key(skill.name) || entries.has(key(skill.name))) continue;
        const entry = {name: skill.name, groupId: group.id, reported: false, verified: false};
        entries.set(key(skill.name), entry); group.skills.push(entry);
      }
    }
    const previous = {id:'recorded',label:'Other recorded skills',skills:[]};
    groups.push(previous);
    for (const [field, flag] of [['self_reported_skills','reported'],['verified_skills','verified']]) {
      for (const name of snapshot.record?.[field] || []) {
        if (typeof name !== 'string' || !key(name)) continue;
        let entry = entries.get(key(name));
        if (!entry) {entry = {name,groupId:previous.id,reported:false,verified:false};entries.set(key(name),entry);previous.skills.push(entry);}
        if (flag === 'verified' && entry.verified && entry.name !== name) {
          if (!previous.skills.some(skill => skill.name === name && skill.verified)) previous.skills.push({name,groupId:previous.id,reported:false,verified:true});
          continue;
        }
        entry.name = name; entry[flag] = true;
      }
    }
    let index = 0;
    return groups.filter(g => g.skills.length).map(group => ({...group,skills:group.skills.map(entry=>({...entry,index:index++}))}));
  }
  function matches(entry, group, query, area) {
    return (!area || area === group.id) && (!key(query) || key(`${entry.name} ${group.label}`).includes(key(query)));
  }
  function markup(snapshot, name) {
    const groups = buildGroups(snapshot), experience = snapshot.record?.legacy_application_data?.verified_skill_experience || {};
    return `<form class="profile-skill-editor-form"><header class="dialog-heading"><div><p class="eyebrow">${escape(name || 'Talent profile')}</p><h2 id="profile-skill-editor-title">Edit skills &amp; experience</h2></div><button type="button" class="modal-close" data-skill-editor-close aria-label="Close skill editor">×</button></header><p class="dialog-copy">Add skills the applicant missed. Check only skills you have verified; experience in years is optional. Applicant-reported answers stay unchanged.</p><div class="profile-skill-editor-tools"><label>Find a skill<input type="search" name="skill_search" placeholder="Search skills or work types…" autocomplete="off"></label><label>Work type<select name="skill_area"><option value="">All work types</option>${groups.map(g=>`<option value="${escape(g.id)}">${escape(g.label)}</option>`).join('')}</select></label></div><div class="profile-skill-editor-summary"><strong data-skill-selected></strong><span data-skill-visible></span></div><div class="profile-skill-editor-list">${groups.map(g=>`<fieldset data-skill-group="${escape(g.id)}"><legend>${escape(g.label)}</legend>${g.skills.map(entry=>{
      const value = experience[entry.name], years = value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : '';
      return `<div class="profile-skill-editor-row" data-skill-index="${entry.index}"><label class="profile-skill-editor-choice"><input type="checkbox" name="verified_skill" value="${entry.index}"${entry.verified?' checked':''}><span><strong>${escape(entry.name)}</strong><small>${entry.reported?'Applicant reported':entry.verified?'Previously verified':'Available to add'}</small></span></label><label class="profile-skill-editor-years"><span>Years <span class="sr-only">for ${escape(entry.name)}</span></span><input type="number" name="skill_years_${entry.index}" min="0" max="50" step="0.5" placeholder="Optional" value="${escape(years)}"${entry.verified?'':' disabled'}></label></div>`;
    }).join('')}</fieldset>`).join('')}<p data-skill-no-results hidden>No matching skills. Try another search or work type.</p></div><p class="skill-review-status" role="status" aria-live="polite"></p><footer class="modal-actions"><button type="button" class="button secondary" data-skill-editor-close>Cancel</button><button type="submit" class="button primary">Save verified skills</button></footer></form>`;
  }
  function close() {if(active){const dialog=active;active=null;dialog.close();dialog.remove();}}
  async function open(applicant, afterSave) {
    const evidence = root.soroTalentReviewEvidence;
    if (!evidence?.authorized() || !applicant?.id) return;
    close();
    const scope = evidence.scope(), dialog = root.document.createElement('dialog');
    dialog.id='talent-skill-review-dialog';dialog.className='soro-dialog talent-skill-review-dialog profile-skill-editor-dialog';
    dialog.setAttribute('aria-labelledby','profile-skill-editor-title');
    dialog.innerHTML='<div class="profile-skill-editor-loading"><h2 id="profile-skill-editor-title">Edit skills &amp; experience</h2><p role="status">Loading the skill catalog…</p><button class="button" type="button" data-skill-editor-close>Cancel</button></div>';
    root.document.body.append(dialog);active=dialog;
    dialog.addEventListener('click',event=>{if(event.target.closest('[data-skill-editor-close]'))close();});
    dialog.addEventListener('close',()=>{if(active===dialog)active=null;dialog.remove();});
    dialog.showModal();
    try {
      const snapshot=await evidence.loadSkills(applicant.id,{includeCatalog:true});
      if(active!==dialog || !dialog.open || evidence.scope()!==scope)return;
      dialog.innerHTML=markup(snapshot,applicant.full_name);
      const form=dialog.querySelector('form'),groups=buildGroups(snapshot),entries=groups.flatMap(g=>g.skills);
      const refresh=()=>{
        let visible=0;
        for(const group of groups){let count=0;for(const entry of group.skills){const show=matches(entry,group,form.elements.skill_search.value,form.elements.skill_area.value);form.querySelector(`[data-skill-index="${entry.index}"]`).hidden=!show;if(show)count++;}form.querySelector(`[data-skill-group="${group.id}"]`).hidden=!count;visible+=count;}
        form.querySelector('[data-skill-selected]').textContent=`${form.querySelectorAll('[name="verified_skill"]:checked').length} selected`;
        form.querySelector('[data-skill-visible]').textContent=`${visible} of ${entries.length} skills shown`;
        form.querySelector('[data-skill-no-results]').hidden=visible!==0;
      };
      form.elements.skill_search.addEventListener('input',refresh);form.elements.skill_area.addEventListener('change',refresh);
      form.addEventListener('change',event=>{if(event.target.name==='verified_skill'){form.elements[`skill_years_${event.target.value}`].disabled=!event.target.checked;refresh();}});
      form.addEventListener('submit',async event=>{
        event.preventDefault();const button=form.querySelector('[type="submit"]'),status=form.querySelector('[role="status"]');button.disabled=true;status.textContent='Saving skills…';
        try {
          const selected=[...form.querySelectorAll('[name="verified_skill"]:checked')].map(input=>({name:entries[Number(input.value)].name,years:form.elements[`skill_years_${input.value}`].value}));
          const updated=await evidence.saveSkills(applicant.id,snapshot,selected);
          if(evidence.scope()!==scope || active!==dialog || !dialog.open)return;
          afterSave?.(updated.record);
          if(active===dialog)close();
        } catch(error){if(active===dialog && dialog.open){status.textContent=error.message;button.disabled=false;}}
      });
      refresh();form.elements.skill_search.focus();
    } catch(error) {
      if(active===dialog && dialog.open){dialog.querySelector('[role="status"]').textContent=error.message;const retry=root.document.createElement('button');retry.type='button';retry.className='button primary';retry.textContent='Try again';retry.addEventListener('click',()=>open(applicant,afterSave));dialog.querySelector('.profile-skill-editor-loading').append(retry);}
    }
  }
  root.addEventListener?.('soro-auth-changed',close);
  root.addEventListener?.('hashchange',close);
  return Object.freeze({open,buildGroups,markup,matches});
}));
