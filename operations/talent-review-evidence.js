/* Private evidence for the existing Admin / Talent Management review workflow. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.soroTalentReviewEvidence = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const fields = 'id,organization_id,updated_at,self_reported_skills,verified_skills,legacy_application_data';
  const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
  function scope() {
    const access = root.soroCurrentAccess || {};
    return JSON.stringify([access.user_id, access.organization_id, access.role, access.active, access.must_change_password]);
  }
  function authorized() {
    const access = root.soroCurrentAccess || {};
    return ['admin', 'talent_management'].includes(access.role) && uuid(access.user_id) && uuid(access.organization_id)
      && access.active !== false && access.must_change_password !== true;
  }
  function session(applicantId) {
    if (!authorized() || !uuid(applicantId) || !root.soroSupabase) throw new Error('Your review access is unavailable. Sign in again.');
    const client = root.soroSupabase, captured = scope(), organizationId = root.soroCurrentAccess.organization_id;
    const current = () => authorized() && root.soroSupabase === client && captured === scope();
    const check = () => { if (!current()) throw new Error('Your review access changed. Reopen this review.'); };
    return { client, organizationId, current, check, applicantId };
  }
  function skillNames(record) {
    return [...new Set([...(Array.isArray(record?.self_reported_skills) ? record.self_reported_skills : []), ...(Array.isArray(record?.verified_skills) ? record.verified_skills : [])].filter(x => typeof x === 'string' && x.trim()))].sort((a,b) => a.localeCompare(b));
  }
  async function loadSkills(applicantId) {
    const context = session(applicantId);
    const result = await context.client.from('applicants').select(fields).eq('organization_id', context.organizationId).eq('id', applicantId).is('archived_at', null).maybeSingle();
    context.check();
    if (result.error || !result.data || result.data.id !== applicantId || result.data.organization_id !== context.organizationId) throw new Error('Skills could not be loaded. Try again.');
    return { record: result.data, scope: scope() };
  }
  async function saveSkills(applicantId, snapshot, selected) {
    const context = session(applicantId);
    if (snapshot?.scope !== scope() || snapshot?.record?.id !== applicantId || !snapshot.record.updated_at) throw new Error('Reopen verification before saving skills.');
    const names = skillNames(snapshot.record), verified = [], experience = {};
    if (!Array.isArray(selected) || selected.length > names.length) throw new Error('Choose only the skills listed for this applicant.');
    for (const item of selected) {
      if (!names.includes(item.name) || verified.includes(item.name)) throw new Error('Choose only the skills listed for this applicant.');
      verified.push(item.name);
      if (item.years !== '' && item.years !== null && item.years !== undefined) {
        const years = Number(item.years);
        if (!Number.isFinite(years) || years < 0 || years > 50) throw new Error('Experience must be between 0 and 50 years, or left blank.');
        experience[item.name] = years;
      }
    }
    context.check();
    const result = await context.client.from('applicants').update({ verified_skills: verified,
      legacy_application_data: { ...(snapshot.record.legacy_application_data || {}), verified_skill_experience: experience },
      skill_profile_updated_at: new Date().toISOString()
    }).eq('organization_id', context.organizationId).eq('id', applicantId).eq('updated_at', snapshot.record.updated_at).is('archived_at', null).select(fields).maybeSingle();
    context.check();
    if (result.error || !result.data) throw new Error('This profile may have changed. Reopen verification before saving again; your selection has not overwritten newer data.');
    return { record: result.data, scope: scope() };
  }
  async function loadResume(applicantId) {
    const context = session(applicantId);
    const result = await context.client.from('documents').select('file_name,storage_path')
      .eq('organization_id', context.organizationId).eq('applicant_id', applicantId).eq('document_type', 'resume')
      .neq('status', 'rejected').not('storage_path', 'is', null).order('created_at', {ascending:false}).order('id', {ascending:false}).limit(1);
    context.check();
    const document = result.data?.[0];
    if (result.error) throw new Error('The résumé could not be loaded. Try again.');
    if (!document?.storage_path) return { missing: true };
    const signed = await context.client.storage.from('soro-private-documents').createSignedUrl(document.storage_path, 60);
    context.check();
    const url = new URL(signed.data?.signedUrl || '', context.client.supabaseUrl);
    const origin = new URL(context.client.supabaseUrl).origin;
    if (signed.error || url.protocol !== 'https:' || url.origin !== origin || !url.pathname.startsWith('/storage/v1/object/sign/soro-private-documents/')) throw new Error('The secure résumé link is unavailable. Try again.');
    const extension = String(document.file_name || '').toLowerCase().split('.').pop();
    return { url: url.href, name: document.file_name || 'Applicant résumé', kind: extension === 'pdf' ? 'pdf' : ['jpg','jpeg','png','webp'].includes(extension) ? 'image' : 'download' };
  }
  function skillsMarkup(state) {
    if (!state) return '<p role="status">Loading applicant skills…</p>';
    if (state.error) return `<p role="alert">${escape(state.error)}</p><button type="button" class="button" data-evidence-retry="skills">Reload skills</button>`;
    const names = skillNames(state.record), verified = state.record?.verified_skills || [], years = state.record?.legacy_application_data?.verified_skill_experience || {};
    return `<form data-review-skills-form><p>Check the skills you have verified. Experience in years is optional. These updates also appear on the Talent profile.</p><div class="review-evidence-skills">${names.map((name,index) => `<div class="review-evidence-skill"><label><input type="checkbox" name="verified_skill" value="${index}"${verified.includes(name) ? ' checked' : ''}><span>${escape(name)}</span></label><label><span>Years</span><input type="number" name="skill_years_${index}" min="0" max="50" step="0.5" value="${escape(years[name] ?? '')}"></label></div>`).join('') || '<p>No applicant-reported or previously verified skills are recorded yet.</p>'}</div><p data-review-skills-status role="status"></p><button class="button primary" type="submit"${names.length ? '' : ' disabled'}>Save verified skills</button></form>`;
  }
  function resumeMarkup(state) {
    const header = '<header><div><p class="eyebrow">Source document</p><h3>Applicant résumé</h3></div><button type="button" class="button" data-evidence-retry="resume">Reload résumé</button></header>';
    if (!state) return `${header}<p role="status">Opening the secure résumé…</p>`;
    if (state.error || state.missing) return `${header}<p role="status">${escape(state.error || 'No résumé is attached to this application yet.')}</p>`;
    return `${header}<p class="review-evidence-file-name">${escape(state.name)}</p><a class="button" href="${escape(state.url)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Open résumé separately</a>${state.kind === 'pdf' ? `<iframe data-review-resume-frame src="${escape(state.url)}" title="Applicant résumé preview" referrerpolicy="no-referrer" sandbox="allow-same-origin"></iframe>` : state.kind === 'image' ? `<img data-review-resume-frame src="${escape(state.url)}" alt="Applicant résumé" referrerpolicy="no-referrer">` : '<p>This document format cannot be previewed here. Open the secure file separately to review it.</p>'}<small>Private file. If the link expires, choose Reload résumé.</small>`;
  }
  return Object.freeze({ authorized, scope, skillNames, loadSkills, saveSkills, loadResume, skillsMarkup, resumeMarkup });
}));
