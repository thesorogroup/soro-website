/* Render an archived Loom introduction recording beside the Talent name. */
(function () {
  const originalProfilePage = profilePage;
  const baseEscapeHtml = escapeHtml;

  // A few legacy spreadsheet cells were saved with a replacement character
  // where a smart apostrophe belonged. Keep the original value intact in the
  // database, but present it cleanly throughout the profile.
  function normalizeLegacyText(value) {
    return String(value ?? '')
      .replace(/â€™/g, '’')
      .replace(/â€œ/g, '“')
      .replace(/â€/g, '”')
      .replace(/([A-Za-z])�([A-Za-z])/g, '$1’$2');
  }

  escapeHtml = function (value) {
    return baseEscapeHtml(normalizeLegacyText(value));
  };

function canEditProfileDetails() {
  return ['admin', 'talent', 'talent_management'].includes(String(typeof role === 'undefined' ? '' : role).toLowerCase());
}

  profilePage = function (applicant) {
    const editButton = canEditProfileDetails()
      ? '<button class="text-button profile-edit-details" id="edit-skills-experience" type="button">Edit details</button>'
      : '';
    return originalProfilePage(applicant)
      .replace(
        '<div class="profile-actions"><button class="button" id="profile-add-task">+ Add task</button></div></section><section class="profile-stat-grid">',
        '<div class="profile-hero-media"><div class="profile-actions"><button class="button" id="profile-add-task">+ Add task</button></div><div class="profile-introduction-video-slot" id="profile-introduction-video" aria-live="polite"></div></div></section><section class="profile-stat-grid">'
      )
      .replace(
        '</dl></section><section class="panel profile-section profile-skills-experience-section"><div class="panel-head"><div><p class="eyebrow">Matching overview</p><h2>Skills &amp; experience</h2></div>' + editButton + '</div><div id="profile-skills-experience"><p class="muted">Loading profile details…</p></div></section><section class="panel profile-section profile-documents-section">'
      );
  };

  const originalLoadTalentProfileDocuments = loadTalentProfileDocuments;
  loadTalentProfileDocuments = async function () {
    await originalLoadTalentProfileDocuments();
    const applicant = liveApplicants.find(item => item.id === selectedTalentId);
    const target = document.getElementById('profile-introduction-video');
    if (!applicant || !target || !window.soroSupabase) return;

    await loadSkillsAndExperience(applicant);

    const { data: documents, error } = await window.soroSupabase
      .from('documents')
      .select('file_name,document_type,storage_path,created_at')
      .eq('applicant_id', applicant.id)
      .order('created_at', { ascending: false });
    if (error) return;

    const introVideo = (documents || []).find(document =>
      classifyDocument(document) === 'introduction_video' && document.storage_path
    );
    const interviewVideo = (documents || []).find(document =>
      classifyDocument(document) === 'interview_video' && document.storage_path
    );
    const videoCards = await Promise.all([
      ['Introduction video', introVideo],
      ['Company interview', interviewVideo]
    ].filter(([, document]) => document).map(async ([label, document]) => {
      const { data: signed, error: signingError } = await window.soroSupabase.storage
        .from('soro-private-documents')
        .createSignedUrl(document.storage_path, 3600);
      if (signingError || !signed?.signedUrl) return '';
      return `<section class="profile-introduction-video"><div><p class="eyebrow">${label}</p><strong>${escapeHtml(document.file_name)}</strong></div><video controls preload="metadata" playsinline aria-label="${escapeHtml(applicant.full_name)} ${label.toLowerCase()}"><source src="${escapeHtml(signed.signedUrl)}" type="video/mp4" />Your browser does not support video playback.</video><small>Private Soro file</small></section>`;
    }));

    if (!videoCards.filter(Boolean).length) {
      target.innerHTML = '<section class="profile-introduction-video profile-video-empty"><p class="eyebrow">Video interviews</p><strong>No private video attached yet</strong><small>Long-form interview recordings will use secure video hosting before upload.</small></section>';
      return;
    }
    target.innerHTML = videoCards.join('');

  };

  function valueFromLegacy(data, keywords) {
    const entries = Object.entries(data || {}).filter(([, value]) =>
      value !== null && value !== undefined && String(value).trim()
    );
    const result = entries.find(([key]) => {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      return keywords.some(keyword => normalized.includes(keyword));
    });
    return result ? String(result[1]).trim() : '';
  }

  function chips(value) {
    const values = String(value || '')
      .split(/[\n,;|•]+/)
      .map(item => item.trim())
      .filter(Boolean)
      .slice(0, 16);
    return values.length
      ? `<div class="skill-chips">${values.map(item => `<span>${escapeHtml(item)}</span>`).join('')}</div>`
      : '<p class="muted">No skills recorded yet.</p>';
  }

  async function loadSkillsAndExperience(applicant) {
    const target = document.getElementById('profile-skills-experience');
    if (!target || !window.soroSupabase) return;

    const { data, error } = await window.soroSupabase
      .from('applicants')
      .select('legacy_application_data,education_level,assessment_summary,english_proficiency')
      .eq('id', applicant.id)
      .maybeSingle();
    if (error || !data) {
      target.innerHTML = '<p class="muted">Profile details are not available yet.</p>';
      return;
    }

    const legacy = data.legacy_application_data || {};
    const skills = legacy.soro_ops_skills || valueFromLegacy(legacy, ['skills', 'skillset', 'skillandexperience', 'technicalskill', 'corecompetenc']);
    const experience = legacy.soro_ops_experience || valueFromLegacy(legacy, ['workexperience', 'workhistory', 'employmenthistory', 'professionalbackground', 'careerbackground', 'experience']);
    const education = data.education_level || valueFromLegacy(legacy, ['education', 'degree', 'qualification']);

    target.innerHTML = `<div class="skills-experience-content"><div><p class="detail-label">Skills</p>${chips(skills)}</div><div><p class="detail-label">Experience</p><p class="experience-summary">${escapeHtml(experience || 'Review résumé and interview notes to complete this summary.')}</p></div>${education ? `<div><p class="detail-label">Education</p><p class="experience-summary">${escapeHtml(education)}</p></div>` : ''}</div>`;
  }

  function closeSkillsDialog() {
    document.getElementById('skills-experience-dialog')?.close();
  }

  async function openSkillsDialog() {
    const applicant = liveApplicants.find(item => item.id === selectedTalentId);
    if (!applicant || !window.soroSupabase || !canEditProfileDetails()) return;
    const { data, error } = await window.soroSupabase
      .from('applicants')
      .select('legacy_application_data')
      .eq('id', applicant.id)
      .maybeSingle();
    if (error || !data) return toast('Talent details could not be loaded for editing.');

    const legacy = data.legacy_application_data || {};
    const skills = legacy.soro_ops_skills || valueFromLegacy(legacy, ['skills', 'skillset', 'skillandexperience', 'technicalskill', 'corecompetenc']);
    const experience = legacy.soro_ops_experience || valueFromLegacy(legacy, ['workexperience', 'workhistory', 'employmenthistory', 'professionalbackground', 'careerbackground', 'experience']);
    let dialog = document.getElementById('skills-experience-dialog');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'skills-experience-dialog';
      dialog.className = 'soro-dialog profile-details-dialog';
      document.body.appendChild(dialog);
    }
    dialog.innerHTML = `<form method="dialog" id="skills-experience-form"><header class="dialog-heading"><div><p class="eyebrow">Talent profile</p><h2>Edit skills &amp; experience</h2></div><button class="modal-close" type="button" data-close-skills aria-label="Close">×</button></header><p class="dialog-copy">Use short, client-ready skill names. Your changes are saved to ${escapeHtml(applicant.full_name)}’s profile.</p><label>Skills <span>Separate skills with commas or new lines.</span><textarea id="skills-input" rows="5" spellcheck="true" autocapitalize="sentences" placeholder="Calendar management, QuickBooks, customer support">${escapeHtml(skills)}</textarea></label><label>Experience summary <span>Summarize relevant experience for matching and review.</span><textarea id="experience-input" rows="7" spellcheck="true" autocapitalize="sentences" placeholder="Describe industries, roles, and notable experience.">${escapeHtml(experience)}</textarea></label><footer class="modal-actions"><button class="button secondary" type="button" data-close-skills>Cancel</button><button class="button primary" id="save-skills-experience" type="submit">Save changes</button></footer></form>`;
    dialog.showModal();

    dialog.querySelectorAll('[data-close-skills]').forEach(button => {
      button.addEventListener('click', () => dialog.close());
    });

    dialog.querySelector('#skills-experience-form').addEventListener('submit', async event => {
      event.preventDefault();
      const saveButton = dialog.querySelector('#save-skills-experience');
      saveButton.disabled = true;
      saveButton.textContent = 'Saving…';
      const nextLegacy = {
        ...legacy,
        soro_ops_skills: dialog.querySelector('#skills-input').value.trim(),
        soro_ops_experience: dialog.querySelector('#experience-input').value.trim()
      };
      const { error: updateError } = await window.soroSupabase
        .from('applicants')
        .update({ legacy_application_data: nextLegacy })
        .eq('id', applicant.id);
      if (updateError) {
        saveButton.disabled = false;
        saveButton.textContent = 'Save changes';
        toast('Soro Ops could not save these profile details.');
        return;
      }
      closeSkillsDialog();
      toast('Skills and experience updated.');
      await loadSkillsAndExperience(applicant);
    });
  }

  document.addEventListener('click', event => {
    if (event.target.closest('#edit-skills-experience')) openSkillsDialog();
  });
})();
