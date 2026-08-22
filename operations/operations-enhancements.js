/* Soro Ops interaction and profile detail improvements. */
(function () {

  const isExternalLink = value => /^https?:\/\//i.test(String(value || '').trim());
  const resultValue = (value, empty = 'Result not yet recorded') => escapeHtml(!value || isExternalLink(value) ? empty : value);
  const resultInputValue = value => escapeHtml(!value || isExternalLink(value) ? '' : value);

  function canManageScreeningResults() {
    const actualRole = String(typeof authorizedRole === 'undefined' ? '' : authorizedRole).toLowerCase();
    return ['admin', 'talent_management'].includes(actualRole);
  }

  function talentInitials(fullName) {
    const raw = String(fullName || '').trim();
    if (!raw) return '—';
    if (raw.includes(',')) {
      const [last, given] = raw.split(',').map(part => part.trim());
      return `${given?.split(/\s+/)[0]?.[0] || ''}${last?.split(/\s+/)[0]?.[0] || ''}`.toUpperCase() || '—';
    }
    const names = raw.split(/\s+/).filter(Boolean);
    return `${names[0]?.[0] || ''}${names.length > 1 ? names[names.length - 1][0] : ''}`.toUpperCase() || '—';
  }

  function talentPlaceholder(fullName) {
    return `<span class="talent-placeholder" aria-label="No headshot uploaded"><svg viewBox="0 0 160 190" aria-hidden="true"><defs><linearGradient id="portraitGradient" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#315f89"/><stop offset="1" stop-color="#83abc7"/></linearGradient></defs><rect width="160" height="190" rx="2" fill="url(#portraitGradient)"/><circle cx="80" cy="65" r="29" fill="#d8e5ef" fill-opacity=".58"/><path d="M29 190c3-52 20-83 51-83s48 31 51 83" fill="#d8e5ef" fill-opacity=".46"/><path d="M51 120c8 11 18 16 29 16s21-5 29-16" fill="none" stroke="#edf4f8" stroke-opacity=".44" stroke-width="4" stroke-linecap="round"/></svg><b>${escapeHtml(talentInitials(fullName))}</b></span>`;
  }

  const screeningSourceMap = {
    english: ['english_proof'],
    personality: ['disc_assessment', 'enneagram_assessment', 'mbti_assessment'],
    computer: ['equipment_proof'],
    internet: ['internet_proof']
  };

  function numericValues(value) {
    return (String(value || '').match(/\d+(?:\.\d+)?/g) || []).map(Number).filter(Number.isFinite);
  }

  function screeningState(applicant, key, value) {
    if (value && !isExternalLink(value)) return '<span class="screening-state screening-state--ready">Recorded</span>';
    return '<span class="screening-state">Not entered</span>';
  }

  function englishCard(applicant) {
    const value = applicant.english_test_result;
    const score = Math.max(0, Math.min(100, numericValues(value)[0] || 0));
    return `<article class="screening-card screening-card--english" data-screening-card="english"><header><div><span>English assessment</span><h4>English proficiency</h4></div>${screeningState(applicant, 'english', value)}</header><div class="screening-ring" style="--score:${score}" aria-label="${score ? `${score} percent` : 'Score not recorded'}"><strong>${score || '—'}</strong><small>${score ? '/ 100' : 'Pending'}</small></div><p>${resultValue(value)}</p><div class="screening-source-links" data-screening-sources="english"></div></article>`;
  }

  function personalityCard(applicant) {
    const value = applicant.personality_profile_score;
    const parts = String(value || '').split(/[|;\n]+/).map(part => part.trim()).filter(Boolean).slice(0, 3);
    const labels = ['DISC', 'Enneagram', 'MBTI-style'];
    const rows = labels.map((label, index) => `<div><span>${label}</span><strong>${escapeHtml(parts[index] || 'Pending')}</strong></div>`).join('');
    return `<article class="screening-card screening-card--personality" data-screening-card="personality"><header><div><span>Three assessments</span><h4>Personality profile</h4></div>${screeningState(applicant, 'personality', value)}</header><div class="personality-score-grid">${rows}</div><div class="screening-source-links" data-screening-sources="personality"></div></article>`;
  }

  function computerCard(applicant) {
    const value = applicant.computer_specs;
    const items = String(value || '').split(/[|;·\n]+/).map(item => item.trim()).filter(Boolean).slice(0, 6);
    return `<article class="screening-card screening-card--computer" data-screening-card="computer"><header><div><span>Equipment submission</span><h4>Computer specifications</h4></div>${screeningState(applicant, 'computer', value)}</header>${items.length ? `<dl class="computer-spec-list">${items.map((item, index) => `<div><dt>${['System', 'Processor', 'Memory', 'Storage', 'Operating system', 'Other'][index]}</dt><dd>${escapeHtml(item)}</dd></div>`).join('')}</dl>` : '<p class="screening-card-empty">Computer details have not been extracted yet.</p>'}<div class="screening-source-links" data-screening-sources="computer"></div></article>`;
  }

  function internetCard(applicant) {
    const value = applicant.internet_speed;
    const numbers = numericValues(value);
    const download = numbers[0] || 0;
    const upload = numbers[1] || 0;
    const gauge = Math.max(0, Math.min(100, download / 2));
    return `<article class="screening-card screening-card--internet" data-screening-card="internet"><header><div><span>Speed-test submission</span><h4>Internet speed</h4></div>${screeningState(applicant, 'internet', value)}</header><div class="speed-gauge" style="--speed:${gauge}"><div><strong>${download || '—'}</strong><small>Mbps download</small></div></div><div class="speed-stats"><span><strong>${upload || '—'}</strong> Mbps upload</span></div><div class="screening-source-links" data-screening-sources="internet"></div></article>`;
  }

  function screeningResults(applicant) {
    const editButton = canManageScreeningResults() ? '<button class="text-button" id="edit-screening-results">Edit results</button>' : '';
    return `<section class="profile-screening" aria-labelledby="screening-results-title"><div class="screening-heading"><div><p class="eyebrow">Application screening</p><h3 class="screening-title" id="screening-results-title">Screening results</h3></div>${editButton}</div><p class="screening-copy">Admin and Talent Management record results from the applicant’s linked assessment files.</p><div class="screening-dashboard">${englishCard(applicant)}${personalityCard(applicant)}${computerCard(applicant)}${internetCard(applicant)}</div></section>`;
  }

  profilePage = function (a) {
    if (!a) return `<main class="page"><button class="text-button back-to-directory">← Back to Talent Directory</button><section class="panel profile-missing"><h1>Talent profile not found</h1><p>This profile may have been removed or you may no longer have access.</p></section></main>`;
    const contact = [a.email, a.phone].filter(Boolean).join(' · ') || 'Contact information not recorded';
    return `<main class="page talent-profile-page"><button class="text-button back-to-directory">← Back to Talent Directory</button><section class="talent-profile-hero"><div class="headshot-wrap"><div class="talent-headshot" id="talent-headshot">${talentPlaceholder(a.full_name)}</div><label class="button headshot-upload">Upload headshot<input type="file" id="headshot-input" accept="image/jpeg,image/png,image/webp" hidden /></label><small>JPG, PNG, or WebP · up to 5 MB</small></div><div class="profile-identity"><p class="eyebrow">Talent profile</p><h1>${escapeHtml(a.full_name)}</h1><p>${escapeHtml(contact)}</p><div class="profile-tags"><span class="tag">${escapeHtml(titleCase(a.status))}</span><span class="tag neutral">${escapeHtml(titleCase(a.work_status))}</span></div></div><div class="profile-actions"><button class="button" id="profile-add-task">+ Add task</button></div></section><section class="profile-stat-grid"><article><p>Location & time zone</p><strong>${escapeHtml([a.location, a.timezone].filter(Boolean).join(' · ') || 'Not recorded')}</strong></article><article><p>Availability</p><strong>${escapeHtml(a.availability_note || a.dedicated_workspace || 'Availability to review')}</strong></article><article><p>Application received</p><strong>${a.application_received_at ? escapeHtml(new Date(a.application_received_at).toLocaleDateString()) : 'Not recorded'}</strong></article><article><p>Profile owner</p><strong>${a.talent_review_owner_id ? 'Assigned' : 'Unassigned'}</strong></article></section><div class="profile-layout"><section class="panel profile-section profile-details-section"><div class="panel-head"><div><p class="eyebrow">At a glance</p><h2>Profile details</h2></div></div><dl class="profile-details"><div><dt>Work status</dt><dd>${escapeHtml(titleCase(a.work_status))}</dd></div><div><dt>Expected rate</dt><dd>${escapeHtml(a.expected_hourly_rate_text || a.expected_hourly_rate || 'Not recorded')}</dd></div><div><dt>Dream / goal</dt><dd>${escapeHtml(a.greatest_dream || 'To be discussed in the Talent interview')}</dd></div></dl></section><section class="panel profile-section profile-documents-section"><div class="panel-head"><div><p class="eyebrow">Private files</p><h2>Documents & assessments</h2></div><span class="tag">Secure</span></div><p class="eyebrow">Select a file to open its protected preview. Screening sources stay linked to their matching result card.</p><div id="profile-documents"><p class="eyebrow">Loading documents…</p></div></section></div>${screeningResults(a)}<dialog id="screening-results-dialog"><form id="screening-results-form" class="modal screening-results-modal"><div class="modal-title"><div><p class="eyebrow">Talent screening</p><h2>Edit screening results</h2></div><button type="button" class="modal-close" aria-label="Close screening results">×</button></div><p class="eyebrow">Correct any result that could not be read cleanly from an uploaded assessment.</p><label>English test result<input name="english_test_result" maxlength="240" value="${resultInputValue(a.english_test_result)}" placeholder="Example: CEFR B2 · 86%" /></label><label>Personality profile / score<input name="personality_profile_score" maxlength="500" value="${resultInputValue(a.personality_profile_score)}" placeholder="DISC: D 42, I 30, S 18, C 10 | Enneagram: Type 3 | MBTI: ENFJ" /></label><label>Computer specs<input name="computer_specs" maxlength="500" value="${resultInputValue(a.computer_specs)}" placeholder="Windows 11 · Intel i5 · 16 GB RAM · 512 GB SSD" /></label><label>Internet speed<input name="internet_speed" maxlength="240" value="${resultInputValue(a.internet_speed)}" placeholder="95 Mbps download · 48 Mbps upload" /></label><div class="modal-actions"><button class="button modal-cancel" type="button">Cancel</button><button class="button primary" type="submit">Save results</button></div><div id="screening-results-confirmation" aria-live="polite"></div></form></dialog></main>`;
  };

  const profilePageWithScreening = profilePage;

  function canVerifyTalentSkills() {
    const actualRole = String(typeof authorizedRole === 'undefined' ? '' : authorizedRole).toLowerCase();
    return ['admin', 'talent_management'].includes(actualRole);
  }

  function skillExperienceMap(applicant) {
    const source = applicant.legacy_application_data?.verified_skill_experience;
    return source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  }

  function verifiedSkillRows(applicant) {
    const skills = Array.isArray(applicant.verified_skills) ? applicant.verified_skills.filter(Boolean) : [];
    const experience = skillExperienceMap(applicant);
    if (!skills.length) return '<p class="profile-skill-empty">No skills have been verified by Talent Management yet.</p>';
    return `<div class="verified-skill-list">${skills.map(skill => {
      const years = Number(experience[skill]);
      const experienceLabel = Number.isFinite(years) && years > 0 ? `${years} ${years === 1 ? 'year' : 'years'}` : 'Experience not recorded';
      return `<article><span class="verified-skill-check" aria-hidden="true">✓</span><div><strong>${escapeHtml(skill)}</strong><small>Management verified</small></div><b>${escapeHtml(experienceLabel)}</b></article>`;
    }).join('')}</div>`;
  }

  profilePage = function (applicant) {
    if (!applicant) return profilePageWithScreening(applicant);
    const workStatus = String(applicant.work_status || '').toLowerCase() === 'other' && applicant.work_status_other_detail
      ? applicant.work_status_other_detail : applicant.work_status;
    const timeZone = String(applicant.timezone || '').toLowerCase() === 'other' && applicant.timezone_other_detail
      ? applicant.timezone_other_detail : applicant.timezone;
    const displayApplicant = { ...applicant, work_status: workStatus, timezone: timeZone };
    const markup = profilePageWithScreening(displayApplicant);
    const areaLabels = {
      healthcare: 'Healthcare & Medical Support',
      general_admin: 'General & Administrative VA',
      social_media: 'Social Media & Digital Marketing',
      customer_support: 'Customer Service & Client Support',
      ecommerce: 'E-commerce Support',
      other: applicant.other_experience_specialty ? `Other — ${applicant.other_experience_specialty}` : 'Other specialty',
      no_prior: 'No prior experience in these fields'
    };
    const list = (values, empty) => {
      const items = Array.isArray(values) ? values.filter(Boolean) : [];
      return items.length
        ? `<div class="profile-skill-chips">${items.map((value) => `<span>${escapeHtml(value)}</span>`).join('')}</div>`
        : `<p class="profile-skill-empty">${escapeHtml(empty)}</p>`;
    };
    const reportedAreas = (applicant.self_reported_experience_areas || []).map((area) => areaLabels[area] || titleCase(area));
    const reviewButton = canVerifyTalentSkills() ? '<button class="text-button" id="review-talent-skills" type="button">Review skills</button>' : '';
    const skillReview = `<section class="panel profile-section profile-skill-review" aria-label="Talent skill profile">
      <div class="panel-head"><div><p class="eyebrow">Matching profile</p><h2>Skills &amp; experience</h2></div>${reviewButton}</div>
      <div class="profile-skill-review__group profile-skill-review__group--verified">
        <div class="skill-group-heading"><div><p class="eyebrow">Talent Management</p><h3>Verified skills</h3></div><span class="verified-label">Verified</span></div>
        ${verifiedSkillRows(applicant)}
      </div>
      <div class="profile-skill-review__group">
        <div class="skill-group-heading"><div><p class="eyebrow">From this application</p><h3>Applicant-reported work areas</h3></div><span class="reported-label">Unverified</span></div>
        ${list(reportedAreas, 'No work areas were reported.')}
      </div>
      <div class="profile-skill-review__group">
        <div class="skill-group-heading"><div><p class="eyebrow">From this application</p><h3>Applicant-reported skills</h3></div><span class="reported-label">Unverified</span></div>
        ${list(applicant.self_reported_skills, 'No skills were reported for the selected work areas.')}
      </div>
    </section>`;
    return markup.replace('<section class="panel profile-section profile-documents-section">', `${skillReview}<section class="panel profile-section profile-documents-section">`);
  };

  function supportPage() {
    return `<main class="page support-page"><div class="page-heading"><div><p class="eyebrow">Soro Ops support</p><h1>Help & Support</h1><p class="eyebrow" style="margin-top:9px">Report a technical issue or ask for help using Soro Ops.</p></div></div><div class="support-grid"><section class="panel"><div class="panel-head"><div><p class="eyebrow">Technical support ticket</p><h2>Tell us what happened</h2></div></div><form id="help-ticket-form" class="support-form"><label>What do you need help with?<input name="subject" required maxlength="120" placeholder="Example: I cannot open a Talent document" /></label><label>Area<select name="area"><option>Sign-in and account access</option><option>Talent profiles and documents</option><option>Client records and placements</option><option>Tasks and notifications</option><option>Other technical issue</option></select></label><label>What happened?<textarea name="details" required placeholder="Include what you were trying to do, what you expected, and any message you saw."></textarea></label><small>Do not include passwords, payment details, or other sensitive information in a ticket.</small><button class="button primary" type="submit">Submit support ticket</button><div id="ticket-confirmation" aria-live="polite"></div></form></section><aside class="panel support-contact"><div><p class="eyebrow">Before submitting</p><h2>Quick checks</h2></div><article><h3>Document will not open?</h3><p>Allow pop-ups for Soro Ops, then select the file’s View button again.</p></article><article><h3>Can’t sign in?</h3><p>Use Forgot password on the sign-in screen. Admin and Talent Management can also send a secure reset link.</p></article><article><h3>Need an urgent workaround?</h3><p>Include the Talent or client name and the action that is blocked so the team can triage it quickly.</p></article></aside></div></main>`;
  }

  function renderScreeningSourceLinks(documents) {
    Object.entries(screeningSourceMap).forEach(([key, types]) => {
      const target = document.querySelector(`[data-screening-sources="${key}"]`);
      if (!target) return;
      const sources = documents.filter(document => types.includes(classifyDocument(document)) && document.storage_path);
      target.innerHTML = sources.length
        ? `<span>Source ${sources.length === 1 ? 'file' : 'files'}</span>${sources.map(document => `<button class="screening-source-button open-private-document" type="button" data-storage-path="${escapeHtml(document.storage_path)}">${escapeHtml(documentLabels[classifyDocument(document)] || document.file_name)}</button>`).join('')}`
        : '<span class="screening-source-missing">Source file not available</span>';
    });
  }

  function openTalentSkillReview() {
    const applicant = liveApplicants.find(item => item.id === selectedTalentId);
    if (!applicant || !canVerifyTalentSkills() || !window.soroSupabase) return;
    const reported = Array.isArray(applicant.self_reported_skills) ? applicant.self_reported_skills : [];
    const verified = Array.isArray(applicant.verified_skills) ? applicant.verified_skills : [];
    const skills = [...new Set([...reported, ...verified].filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const experience = skillExperienceMap(applicant);
    let dialog = document.getElementById('talent-skill-review-dialog');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'talent-skill-review-dialog';
      dialog.className = 'soro-dialog talent-skill-review-dialog';
      document.body.appendChild(dialog);
    }
    dialog.__skillNames = skills;
    dialog.innerHTML = `<form id="talent-skill-review-form"><header class="dialog-heading"><div><p class="eyebrow">Talent Management</p><h2>Verify skills &amp; experience</h2></div><button class="modal-close" type="button" data-close-skill-review aria-label="Close">×</button></header><p class="dialog-copy">Only checked skills will appear as management verified. Record relevant experience for each approved skill.</p><div class="talent-skill-review-list">${skills.length ? skills.map((skill, index) => {
      const checked = verified.includes(skill);
      const years = Number(experience[skill]);
      return `<label class="talent-skill-review-row"><input type="checkbox" name="verified_skill" value="${index}" ${checked ? 'checked' : ''}><span><strong>${escapeHtml(skill)}</strong><small>${reported.includes(skill) ? 'Applicant reported' : 'Previously verified'}</small></span><span class="skill-years"><input type="number" min="0" max="50" step="0.5" name="skill_years_${index}" value="${Number.isFinite(years) && years > 0 ? years : ''}" ${checked ? '' : 'disabled'}><small>years</small></span></label>`;
    }).join('') : '<p class="profile-skill-empty">This applicant did not report any skills to review.</p>'}</div><p class="skill-review-status" aria-live="polite"></p><footer class="modal-actions"><button class="button secondary" type="button" data-close-skill-review>Cancel</button><button class="button primary" type="submit" ${skills.length ? '' : 'disabled'}>Save verified skills</button></footer></form>`;
    dialog.querySelectorAll('[data-close-skill-review]').forEach(button => button.addEventListener('click', () => dialog.close()));
    dialog.querySelectorAll('input[name="verified_skill"]').forEach(checkbox => checkbox.addEventListener('change', () => {
      const years = dialog.querySelector(`[name="skill_years_${checkbox.value}"]`);
      if (years) years.disabled = !checkbox.checked;
    }));
    dialog.querySelector('form').addEventListener('submit', async event => {
      event.preventDefault();
      const submit = event.currentTarget.querySelector('[type="submit"]');
      const status = event.currentTarget.querySelector('.skill-review-status');
      const selectedIndexes = [...event.currentTarget.querySelectorAll('input[name="verified_skill"]:checked')].map(input => Number(input.value));
      const nextVerified = selectedIndexes.map(index => skills[index]).filter(Boolean);
      const nextExperience = {};
      selectedIndexes.forEach(index => {
        const years = Number(event.currentTarget.elements[`skill_years_${index}`]?.value);
        if (Number.isFinite(years) && years >= 0) nextExperience[skills[index]] = years;
      });
      submit.disabled = true;
      submit.textContent = 'Saving…';
      const nextLegacy = { ...(applicant.legacy_application_data || {}), verified_skill_experience: nextExperience };
      const { error } = await window.soroSupabase.from('applicants').update({ verified_skills: nextVerified, legacy_application_data: nextLegacy, skill_profile_updated_at: new Date().toISOString() }).eq('id', applicant.id);
      if (error) {
        submit.disabled = false;
        submit.textContent = 'Save verified skills';
        status.textContent = 'Verified skills could not be saved. Refresh your secure session and try again.';
        return;
      }
      applicant.verified_skills = nextVerified;
      applicant.legacy_application_data = nextLegacy;
      dialog.close();
      toast('Verified skills and experience updated.');
      render();
    });
    dialog.showModal();
  }

  render = function () {
    if (current === 'help') {
      root.innerHTML = supportPage();
      return;
    }
    if (current === 'talent-profile') {
      root.innerHTML = profilePage(liveApplicants.find(a => a.id === selectedTalentId));
      bindView();
      bindScreeningResultsEditor();
      loadTalentProfileDocuments();
      return;
    }
    const d = current === 'overview' ? (role === 'admin' ? data.overview : roleDashboards[role]) : data[current];
    const newAction = role === 'talent' ? 'New Talent' : role === 'client' ? 'Request Talent' : role === 'va' ? 'Start Day' : 'New Client';
    const primaryAction = role === 'va' ? 'Start Day' : role === 'client' ? 'Request another Talent' : '+ Add Task';
    root.innerHTML = `<main class="page"><div class="page-heading"><div><p class="eyebrow">Soro Ops</p><h1>${d.title}</h1><p class="eyebrow" style="margin-top:9px">${d.caption}</p></div><div class="heading-actions"><button class="button primary" id="add-task">${primaryAction}</button>${current === 'overview' || current === 'clients' ? `<button class="button" id="new-record">+ ${newAction}</button>` : ''}<button class="button">Customize</button></div></div>${current === 'overview' ? overview(d) : current === 'vas' ? talentDirectory() : table(d)}</main>`;
    bindView();
  };

  document.addEventListener('click', event => {
    if (event.target.closest('#review-talent-skills')) openTalentSkillReview();
  });

  loadTalentProfileDocuments = async function () {
    const applicant = liveApplicants.find(a => a.id === selectedTalentId);
    const target = document.getElementById('profile-documents');
    if (!applicant || !target || !window.soroSupabase) return;
    const { data: documents, error } = await window.soroSupabase.from('documents').select('id,file_name,document_type,status,created_at,storage_path').eq('applicant_id', applicant.id).order('created_at', { ascending: false });
    if (error) { target.innerHTML = '<p>Documents could not be loaded for this Talent profile.</p>'; return; }
    const all = documents || [];
    const photo = all.find(d => classifyDocument(d) === 'profile_photo');
    if (photo?.storage_path) {
      const { data: signed } = await window.soroSupabase.storage.from('soro-private-documents').createSignedUrl(photo.storage_path, 3600);
      if (signed?.signedUrl) { const h = document.getElementById('talent-headshot'); if (h) h.innerHTML = `<img src="${escapeHtml(signed.signedUrl)}" alt="${escapeHtml(applicant.full_name)} headshot" />`; }
    }
    const groups = new Map();
    all.filter(d => classifyDocument(d) !== 'profile_photo').forEach(d => { const type = classifyDocument(d); if (!groups.has(type)) groups.set(type, []); groups.get(type).push(d); });
    target.innerHTML = groups.size ? [...groups.entries()].map(([type, items]) => `<section class="document-group"><h3>${escapeHtml(documentLabels[type] || titleCase(type))}<span>${items.length}</span></h3>${items.map(d => `<article class="document-item"><span class="document-icon">${type === 'resume' ? '▤' : type === 'english_proof' ? 'A' : type === 'internet_proof' ? '⌁' : type === 'equipment_proof' ? '▣' : type === 'introduction_video' ? '▶' : '◫'}</span><span><strong>${escapeHtml(d.file_name)}</strong><small>${escapeHtml(titleCase(d.status || 'uploaded'))} · ${d.created_at ? escapeHtml(new Date(d.created_at).toLocaleDateString()) : 'Date not recorded'}</small></span>${d.storage_path ? `<button class="text-button file-view-button open-private-document" data-storage-path="${escapeHtml(d.storage_path)}">${type === 'introduction_video' ? 'Play video' : 'View file'}</button>` : '<span class="file-pending">File pending</span>'}</article>`).join('')}</section>`).join('') : '<div class="documents-empty"><strong>No documents attached yet</strong><p>Imported application files and new uploads will appear here.</p></div>';
    renderScreeningSourceLinks(all);
    target.querySelectorAll('.open-private-document').forEach(b => b.addEventListener('click', () => openPrivateDocument(b.dataset.storagePath)));
    document.querySelectorAll('.screening-source-button').forEach(button => button.addEventListener('click', () => openPrivateDocument(button.dataset.storagePath)));
  };

  function bindScreeningResultsEditor() {
    const dialog = document.getElementById('screening-results-dialog');
    document.getElementById('edit-screening-results')?.addEventListener('click', () => {
      if (canManageScreeningResults()) dialog?.showModal();
    });
    dialog?.querySelector('.modal-close')?.addEventListener('click', () => dialog.close('cancel'));
    dialog?.querySelector('.modal-cancel')?.addEventListener('click', () => dialog.close('cancel'));
  }

  document.getElementById('notifications-button').addEventListener('click', () => document.getElementById('notifications-dialog').showModal());
  document.getElementById('help-button').addEventListener('click', () => { current = 'help'; selectedTalentId = null; history.pushState({}, '', `${location.pathname}#help`); setActive(); render(); });
  document.getElementById('notifications-dialog').addEventListener('click', event => {
    const action = event.target.closest('[data-notification-view]');
    if (!action) return;
    current = action.dataset.notificationView;
    selectedTalentId = null;
    history.pushState({}, '', `${location.pathname}#${current}`);
    event.currentTarget.close();
    setActive();
    render();
  });
  root.addEventListener('submit', async event => {
    if (event.target.id === 'screening-results-form') {
      event.preventDefault();
      if (!canManageScreeningResults()) return;
      const applicant = liveApplicants.find(a => a.id === selectedTalentId);
      const form = new FormData(event.target);
      const confirmation = document.getElementById('screening-results-confirmation');
      const submitButton = event.target.querySelector('[type="submit"]');
      if (!applicant || !window.soroSupabase) return;
      const updates = {
        english_test_result: form.get('english_test_result').trim() || null,
        personality_profile_score: form.get('personality_profile_score').trim() || null,
        computer_specs: form.get('computer_specs').trim() || null,
        internet_speed: form.get('internet_speed').trim() || null
      };
      submitButton.disabled = true;
      submitButton.textContent = 'Saving…';
      const { error } = await window.soroSupabase.from('applicants').update(updates).eq('id', applicant.id);
      submitButton.disabled = false;
      submitButton.textContent = 'Save results';
      if (error) {
        confirmation.innerHTML = '<p class="ticket-confirmation">The results could not be saved. Please sign in again and retry.</p>';
        return;
      }
      Object.assign(applicant, updates);
      document.getElementById('screening-results-dialog').close();
      toast('Screening results saved to this Talent profile.');
      render();
      return;
    }
    if (event.target.id !== 'help-ticket-form') return;
    event.preventDefault();
    const form = new FormData(event.target);
    const confirmation = document.getElementById('ticket-confirmation');
    const submitButton = event.target.querySelector('[type="submit"]');
    if (!window.soroSupabase) {
      confirmation.innerHTML = '<p class="ticket-confirmation">Support is temporarily unavailable. Please refresh and try again.</p>';
      return;
    }
    submitButton.disabled = true;
    submitButton.textContent = 'Submitting…';
    const { data: ticket, error } = await window.soroSupabase
      .from('support_tickets')
      .insert({ subject: form.get('subject'), area: form.get('area'), details: form.get('details') })
      .select('ticket_number')
      .single();
    submitButton.disabled = false;
    submitButton.textContent = 'Submit support ticket';
    if (error) {
      confirmation.innerHTML = `<p class="ticket-confirmation">We could not submit this ticket yet. Please try again or sign in again if your session has expired.</p>`;
      return;
    }
    event.target.reset();
    confirmation.innerHTML = `<p class="ticket-confirmation">Ticket ${escapeHtml(ticket.ticket_number)} submitted. The Soro support team can now review it.</p>`;
  });
  render();
}());
