/* Render an archived Loom introduction recording beside the Talent name. */
(function () {
  const originalProfilePage = profilePage;
  profilePage = function (applicant) {
    return originalProfilePage(applicant)
      .replace(
        '<div class="profile-actions"><button class="button" id="profile-add-task">+ Add task</button></div></section><section class="profile-stat-grid">',
        '<div class="profile-hero-media"><div class="profile-actions"><button class="button" id="profile-add-task">+ Add task</button></div><div class="profile-introduction-video-slot" id="profile-introduction-video" aria-live="polite"></div></div></section><section class="profile-stat-grid">'
      )
      .replace(
        '</dl></section><section class="panel profile-section profile-documents-section">',
        '</dl></section><section class="panel profile-section profile-skills-experience-section"><div class="panel-head"><div><p class="eyebrow">Matching overview</p><h2>Skills &amp; experience</h2></div></div><div id="profile-skills-experience"><p class="muted">Loading profile details…</p></div></section><section class="panel profile-section profile-documents-section">'
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
    if (!introVideo) {
      target.remove();
      return;
    }

    const { data: signed, error: signingError } = await window.soroSupabase.storage
      .from('soro-private-documents')
      .createSignedUrl(introVideo.storage_path, 3600);
    if (signingError || !signed?.signedUrl) {
      target.remove();
    } else {
      target.innerHTML = `<section class="profile-introduction-video"><div><p class="eyebrow">Introduction video</p><strong>${escapeHtml(introVideo.file_name)}</strong></div><video controls preload="metadata" playsinline aria-label="${escapeHtml(applicant.full_name)} introduction video"><source src="${escapeHtml(signed.signedUrl)}" type="video/mp4" />Your browser does not support video playback.</video><small>Private Soro file</small></section>`;
    }

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
    const skills = valueFromLegacy(legacy, ['skills', 'skillset', 'skillandexperience', 'technicalskill', 'corecompetenc']);
    const experience = valueFromLegacy(legacy, ['workexperience', 'workhistory', 'employmenthistory', 'professionalbackground', 'careerbackground', 'experience']);
    const education = data.education_level || valueFromLegacy(legacy, ['education', 'degree', 'qualification']);

    target.innerHTML = `<div class="skills-experience-content"><div><p class="detail-label">Skills</p>${chips(skills)}</div><div><p class="detail-label">Experience</p><p class="experience-summary">${escapeHtml(experience || 'Review résumé and interview notes to complete this summary.')}</p></div>${education ? `<div><p class="detail-label">Education</p><p class="experience-summary">${escapeHtml(education)}</p></div>` : ''}</div>`;
  }
})();
