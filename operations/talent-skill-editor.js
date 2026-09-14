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
  const pickerBindings = new WeakMap();
  function buildGroups(snapshot = {}) {
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
  function pickerMarkup(snapshot = {}) {
    const groups = buildGroups(snapshot), experience = snapshot.record?.legacy_application_data?.verified_skill_experience || {};
    return `<div class="profile-skill-picker" data-skill-picker>${snapshot.catalogNotice ? `<p class="profile-skill-editor-notice">${escape(snapshot.catalogNotice)}</p>` : ''}<div class="profile-skill-editor-tools"><label>Find a skill<input type="search" name="skill_search" placeholder="Search skills or work types…" autocomplete="off"></label><label>Work type<select name="skill_area"><option value="">All work types</option>${groups.map(g=>`<option value="${escape(g.id)}">${escape(g.label)}</option>`).join('')}</select></label></div><div class="profile-skill-editor-summary" aria-live="polite"><strong data-skill-selected></strong><span data-skill-visible></span></div><div class="profile-skill-editor-list">${groups.map(g=>`<fieldset data-skill-group="${escape(g.id)}"><legend>${escape(g.label)}</legend>${g.skills.map(entry=>{
      const value = experience[entry.name], years = value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : '';
      return `<div class="profile-skill-editor-row" data-skill-index="${entry.index}"><label class="profile-skill-editor-choice"><input type="checkbox" name="verified_skill" value="${entry.index}" aria-label="Verify ${escape(entry.name)}"${entry.verified?' checked':''}><span><strong>${escape(entry.name)}</strong><small>${entry.reported?'Applicant reported':entry.verified?'Previously verified':'Available to verify'}</small></span></label><label class="profile-skill-editor-years"><span>Years <span class="sr-only">for ${escape(entry.name)}</span></span><input type="number" name="skill_years_${entry.index}" min="0" max="50" step="0.5" placeholder="Optional" value="${escape(years)}"${entry.verified?'':' disabled'}></label></div>`;
    }).join('')}</fieldset>`).join('')}<p data-skill-no-results hidden>No matching skills. Try another search or work type.</p></div></div>`;
  }
  function markup(snapshot, name) {
    return `<form class="profile-skill-editor-form"><header class="dialog-heading"><div><p class="eyebrow">${escape(name || 'Talent profile')}</p><h2 id="profile-skill-editor-title">Edit skills &amp; experience</h2></div><button type="button" class="modal-close" data-skill-editor-close aria-label="Close skill editor">×</button></header><p class="dialog-copy">Add skills the applicant missed. Check only skills you have verified; experience in years is optional. Applicant-reported answers stay unchanged.</p>${pickerMarkup(snapshot)}<p class="skill-review-status" role="status" aria-live="polite"></p><footer class="modal-actions"><button type="button" class="button secondary" data-skill-editor-close>Cancel</button><button type="submit" class="button primary">Save verified skills</button></footer></form>`;
  }
  function pickerElement(scope) {
    return scope?.matches?.('[data-skill-picker]') ? scope : scope?.querySelector?.('[data-skill-picker]');
  }
  function readSelection(scope, snapshot) {
    const picker = pickerElement(scope);
    if (!picker) throw new Error('The skill picker is not ready. Reload skills and try again.');
    const entries = buildGroups(snapshot).flatMap(group => group.skills), seen = new Set();
    return [...picker.querySelectorAll('[name="verified_skill"]:checked')].map(input => {
      const value = String(input.value), index = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(index) || !entries[index] || seen.has(index)) throw new Error('Choose only skills in the current catalog. Reload skills and try again.');
      const years = picker.querySelector(`[name="skill_years_${index}"]`);
      if (!years) throw new Error('Skill experience could not be read. Reload skills and try again.');
      seen.add(index);
      return { name: entries[index].name, years: years.value };
    });
  }
  function bindPicker(scope, snapshot) {
    const picker = pickerElement(scope);
    if (!picker) return null;
    pickerBindings.get(picker)?.destroy();
    const groups = buildGroups(snapshot), entries = groups.flatMap(group => group.skills);
    const search = picker.querySelector('[name="skill_search"]'), area = picker.querySelector('[name="skill_area"]');
    if (!search || !area) return null;
    const fields = new Map([...picker.querySelectorAll('[data-skill-group]')].map(field => [field.dataset.skillGroup, field]));
    let destroyed = false;
    const refresh = () => {
      if (destroyed) return false;
      let visible = 0;
      for (const group of groups) {
        let count = 0;
        for (const entry of group.skills) {
          const show = matches(entry, group, search.value, area.value);
          const row = picker.querySelector(`[data-skill-index="${entry.index}"]`);
          if (row) row.hidden = !show;
          if (show) count++;
        }
        const field = fields.get(String(group.id));
        if (field) field.hidden = !count;
        visible += count;
      }
      picker.querySelector('[data-skill-selected]').textContent = `${picker.querySelectorAll('[name="verified_skill"]:checked').length} selected for verification`;
      picker.querySelector('[data-skill-visible]').textContent = `${visible} of ${entries.length} skills shown`;
      picker.querySelector('[data-skill-no-results]').hidden = visible !== 0;
      return true;
    };
    const change = event => {
      const input = event.target;
      if (input?.name !== 'verified_skill') return;
      if (!/^\d+$/.test(String(input.value))) return;
      const years = picker.querySelector(`[name="skill_years_${Number(input.value)}"]`);
      if (years) years.disabled = !input.checked;
      refresh();
    };
    const binding = Object.freeze({
      refresh,
      readSelection: () => readSelection(picker, snapshot),
      destroy() {
        if (destroyed) return;
        destroyed = true;
        search.removeEventListener('input', refresh);
        area.removeEventListener('change', refresh);
        picker.removeEventListener('change', change);
        if (pickerBindings.get(picker) === binding) pickerBindings.delete(picker);
      }
    });
    search.addEventListener('input', refresh);
    area.addEventListener('change', refresh);
    picker.addEventListener('change', change);
    pickerBindings.set(picker, binding);
    refresh();
    return binding;
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
      const form=dialog.querySelector('form'),picker=bindPicker(form,snapshot);
      form.addEventListener('submit',async event=>{
        event.preventDefault();const button=form.querySelector('[type="submit"]'),status=form.querySelector('[role="status"]');button.disabled=true;status.textContent='Saving skills…';
        try {
          const selected=picker.readSelection();
          const updated=await evidence.saveSkills(applicant.id,snapshot,selected);
          if(evidence.scope()!==scope || active!==dialog || !dialog.open)return;
          afterSave?.(updated.record);
          if(active===dialog)close();
        } catch(error){if(active===dialog && dialog.open){status.textContent=error.message;button.disabled=false;}}
      });
      form.elements.skill_search.focus();
    } catch(error) {
      if(active===dialog && dialog.open){dialog.querySelector('[role="status"]').textContent=error.message;const retry=root.document.createElement('button');retry.type='button';retry.className='button primary';retry.textContent='Try again';retry.addEventListener('click',()=>open(applicant,afterSave));dialog.querySelector('.profile-skill-editor-loading').append(retry);}
    }
  }
  root.addEventListener?.('soro-auth-changed',close);
  root.addEventListener?.('hashchange',close);
  return Object.freeze({open,buildGroups,markup,matches,pickerMarkup,bindPicker,readSelection});
}));
