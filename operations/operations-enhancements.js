/* Soro Ops interaction and profile detail improvements. */
(function () {

  const baseRender = render;

  const isExternalLink = value => /^https?:\/\//i.test(String(value || '').trim());
  const resultValue = (value, empty = 'Result not yet recorded') => escapeHtml(!value || isExternalLink(value) ? empty : value);
  const resultInputValue = value => escapeHtml(!value || isExternalLink(value) ? '' : value);
  const screeningPresentation = window.soroScreeningPresentation;
  const profileDetailsTools = window.soroProfileDetails;

  function selectedProfileApplicant() {
    return typeof currentTalentProfileApplicant === 'function'
      ? currentTalentProfileApplicant()
      : liveApplicants.find(item => item.id === selectedTalentId);
  }

  function isOwnTalentProfileView() {
    return typeof isTalentSelfProfileView === 'function' && isTalentSelfProfileView();
  }

  function canManageScreeningResults() {
    return !isOwnTalentProfileView() && ['admin', 'talent_management'].includes(currentAccessRole());
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
    return `<span class="talent-placeholder" aria-label="No headshot uploaded"><svg viewBox="0 0 160 190" aria-hidden="true"><defs><linearGradient id="portraitBackdrop" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2f5e88"/><stop offset="1" stop-color="#7fa7c3"/></linearGradient></defs><rect width="160" height="190" fill="url(#portraitBackdrop)"/><circle cx="80" cy="64" r="29" fill="#e3edf4" fill-opacity=".68"/><path d="M22 190c4-52 25-82 58-82s54 30 58 82z" fill="#dbe8f1" fill-opacity=".56"/></svg><b>${escapeHtml(talentInitials(fullName))}</b></span>`;
  }

  const pronounLabels = {
    she_her: 'she/her',
    he_him: 'he/him',
    they_them: 'they/them',
    use_name: 'use my name'
  };

  const genderLabels = {
    female: 'Female',
    male: 'Male',
    nonbinary: 'Non-binary',
    self_describe: 'Self-described',
    prefer_not_to_disclose: 'Prefer not to disclose'
  };

  function currentAccessRole() {
    return String(window.soroCurrentAccess?.role || '').toLowerCase();
  }

  function canEditOwnIdentityPreferences(applicant) {
    const access = window.soroCurrentAccess;
    return currentAccessRole() === 'virtual_assistant'
      && Boolean(applicant?.auth_user_id)
      && String(applicant.auth_user_id) === String(access?.user_id || '');
  }

  function displayedPronouns(applicant) {
    const values = Array.isArray(applicant.pronouns) ? applicant.pronouns : [];
    if (values.includes('prefer_not_to_disclose')) return '';
    return values.map(value => value === 'self_describe'
      ? String(applicant.pronouns_self_description || '').trim()
      : pronounLabels[value] || String(value).replaceAll('_', '/'))
      .filter(Boolean)
      .join(' · ');
  }

  function profilePronouns(applicant) {
    const values = Array.isArray(applicant.pronouns) ? applicant.pronouns : [];
    if (values.includes('prefer_not_to_disclose')) return 'Prefer not to disclose';
    return displayedPronouns(applicant) || 'Not shared';
  }

  function displayedGender(applicant) {
    const value = String(applicant.gender_identity || '').trim();
    if (!value) return 'Not shared';
    if (value === 'self_describe') return String(applicant.gender_identity_self_description || '').trim() || 'Self-described';
    return genderLabels[value] || titleCase(value);
  }

  function communicationPreferences(applicant) {
    const preferredName = String(applicant.preferred_name || '').trim();
    const pronouns = displayedPronouns(applicant);
    const editButton = canEditOwnIdentityPreferences(applicant)
      ? '<button class="profile-identity-edit" id="edit-own-identity-preferences" type="button">Edit my identity preferences</button>'
      : '';
    if (!preferredName && !pronouns && !editButton) return '';
    return `<div class="profile-communication-preferences">${preferredName ? `<strong>Goes by ${escapeHtml(preferredName)}</strong>` : ''}${pronouns ? `<span>${escapeHtml(pronouns)}</span>` : ''}${editButton}</div>`;
  }

  function identityOption(value, label, current) {
    return `<option value="${value}" ${value === current ? 'selected' : ''}>${label}</option>`;
  }

  function identityChoice(value, label, selectedValues) {
    return `<label class="identity-choice"><input type="checkbox" name="pronouns" value="${value}" ${selectedValues.includes(value) ? 'checked' : ''}><span>${label}</span></label>`;
  }

  function identityPreferencesForm(applicant) {
    const gender = String(applicant.gender_identity || '');
    const selectedPronouns = Array.isArray(applicant.pronouns) ? applicant.pronouns : [];
    return `<form id="own-identity-preferences-form"><header class="dialog-heading"><div><p class="eyebrow">My Talent profile</p><h2>How should Soro address you?</h2></div><button class="modal-close" type="button" data-close-identity-preferences aria-label="Close">×</button></header><p class="dialog-copy">These optional details help the team communicate with you respectfully. Your legal name remains the title of your secure file.</p><label>What name would you like us to use? <span>Leave blank if it is the same as your legal first name.</span><input name="preferred_name" maxlength="100" value="${escapeHtml(applicant.preferred_name || '')}" autocomplete="nickname"></label><label>How do you describe your gender? <span>This is optional and is kept in the private Profile details section.</span><select name="gender_identity"><option value="">Select an option</option>${identityOption('female', 'Female', gender)}${identityOption('male', 'Male', gender)}${identityOption('nonbinary', 'Non-binary', gender)}${identityOption('self_describe', 'Prefer to self-describe', gender)}${identityOption('prefer_not_to_disclose', 'Prefer not to disclose', gender)}</select></label><label data-gender-self-description ${gender === 'self_describe' ? '' : 'hidden'}>Describe your gender <input name="gender_identity_self_description" maxlength="120" value="${escapeHtml(applicant.gender_identity_self_description || '')}"></label><fieldset class="identity-fieldset"><legend>What pronouns should we use?</legend><p>Select all that apply.</p><div class="identity-choice-grid">${identityChoice('she_her', 'She/her', selectedPronouns)}${identityChoice('he_him', 'He/him', selectedPronouns)}${identityChoice('they_them', 'They/them', selectedPronouns)}${identityChoice('use_name', 'Use my name', selectedPronouns)}${identityChoice('self_describe', 'Let me describe them', selectedPronouns)}${identityChoice('prefer_not_to_disclose', 'Prefer not to disclose', selectedPronouns)}</div></fieldset><label data-pronouns-self-description ${selectedPronouns.includes('self_describe') ? '' : 'hidden'}>My pronouns <input name="pronouns_self_description" maxlength="120" value="${escapeHtml(applicant.pronouns_self_description || '')}" placeholder="Example: ze/hir"></label><p class="identity-dialog-status" aria-live="polite"></p><footer class="modal-actions"><button class="button secondary" type="button" data-close-identity-preferences>Cancel</button><button class="button primary" type="submit">Save preferences</button></footer></form>`;
  }

  function bindIdentityPreferenceControls(dialog) {
    const form = dialog.querySelector('form');
    const gender = form.elements.gender_identity;
    const genderOther = form.querySelector('[data-gender-self-description]');
    const pronounOther = form.querySelector('[data-pronouns-self-description]');
    const syncGender = () => {
      const visible = gender.value === 'self_describe';
      genderOther.hidden = !visible;
      genderOther.querySelector('input').required = visible;
    };
    const syncPronouns = changed => {
      const boxes = [...form.querySelectorAll('input[name="pronouns"]')];
      const privateChoice = boxes.find(box => box.value === 'prefer_not_to_disclose');
      if (changed?.value === 'prefer_not_to_disclose' && changed.checked) boxes.forEach(box => { if (box !== changed) box.checked = false; });
      else if (changed?.checked && privateChoice) privateChoice.checked = false;
      else if (!changed && privateChoice?.checked) boxes.forEach(box => { if (box !== privateChoice) box.checked = false; });
      const visible = boxes.some(box => box.value === 'self_describe' && box.checked);
      pronounOther.hidden = !visible;
      pronounOther.querySelector('input').required = visible;
    };
    gender.addEventListener('change', syncGender);
    form.querySelectorAll('input[name="pronouns"]').forEach(box => box.addEventListener('change', () => syncPronouns(box)));
    syncGender();
    syncPronouns();
  }

  async function openOwnIdentityPreferences() {
    const applicant = selectedProfileApplicant();
    if (!applicant || !canEditOwnIdentityPreferences(applicant) || !window.soroSupabase) return;
    let dialog = document.getElementById('own-identity-preferences-dialog');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'own-identity-preferences-dialog';
      dialog.className = 'soro-dialog profile-details-dialog identity-preferences-dialog';
      document.body.appendChild(dialog);
    }
    dialog.innerHTML = identityPreferencesForm(applicant);
    bindIdentityPreferenceControls(dialog);
    dialog.querySelectorAll('[data-close-identity-preferences]').forEach(button => button.addEventListener('click', () => dialog.close()));
    dialog.querySelector('form').addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const formData = new FormData(form);
      const pronouns = formData.getAll('pronouns').map(String);
      const gender = String(formData.get('gender_identity') || '');
      const updates = {
        preferred_name: String(formData.get('preferred_name') || '').trim() || null,
        gender_identity: gender || null,
        gender_identity_self_description: gender === 'self_describe' ? String(formData.get('gender_identity_self_description') || '').trim() || null : null,
        pronouns,
        pronouns_self_description: pronouns.includes('self_describe') ? String(formData.get('pronouns_self_description') || '').trim() || null : null
      };
      const submit = form.querySelector('[type="submit"]');
      const status = form.querySelector('.identity-dialog-status');
      submit.disabled = true;
      submit.textContent = 'Saving…';
      const { error } = await window.soroSupabase.rpc('update_own_identity_preferences', {
        p_preferred_name: updates.preferred_name,
        p_gender_identity: updates.gender_identity,
        p_gender_identity_self_description: updates.gender_identity_self_description,
        p_pronouns: updates.pronouns,
        p_pronouns_self_description: updates.pronouns_self_description
      });
      if (error) {
        submit.disabled = false;
        submit.textContent = 'Save preferences';
        status.textContent = 'Your preferences could not be saved. Refresh your secure session and try again.';
        return;
      }
      Object.assign(applicant, updates);
      dialog.close();
      toast('Your identity preferences were updated.');
      render();
    });
    dialog.showModal();
  }

  function clearOwnIdentityPreferencesDialog() {
    const dialog = document.getElementById('own-identity-preferences-dialog');
    if (!dialog) return;
    if (dialog.open) dialog.close();
    dialog.replaceChildren();
    dialog.remove();
  }
  window.soroClearOwnIdentityPreferencesDialog = clearOwnIdentityPreferencesDialog;

  function canManagePrivateProfileDetails() {
    return !isOwnTalentProfileView() && profileDetailsTools.canManageProfileDetails(currentAccessRole());
  }

  function canViewPrivateProfileDetails(applicant) {
    const access = window.soroCurrentAccess || {};
    return profileDetailsTools.canViewPrivateProfileDetails({
      role: access.role,
      userId: access.user_id,
      applicantAuthUserId: applicant?.auth_user_id
    });
  }

  function profileDetailsTimeZone(applicant) {
    return typeof window.recordedTalentTimeZone === 'function'
      ? window.recordedTalentTimeZone(applicant)
      : applicant?.timezone || 'UTC';
  }

  function privateProfileDetailRows(applicant) {
    if (!canViewPrivateProfileDetails(applicant)) return '';
    const age = profileDetailsTools.ageFromBirthDate(applicant.birth_date, profileDetailsTimeZone(applicant));
    return `<div class="private-identity-detail"><dt>Date of birth <span>Private</span></dt><dd>${escapeHtml(profileDetailsTools.formatBirthDate(applicant.birth_date))}</dd></div><div class="private-identity-detail"><dt>Age <span>Calculated</span></dt><dd>${age === null ? 'Not available' : escapeHtml(age)}</dd></div><div class="private-identity-detail"><dt>Gender identity <span>Private</span></dt><dd>${escapeHtml(displayedGender(applicant))}</dd></div><div class="private-identity-detail"><dt>Pronouns <span>Private</span></dt><dd>${escapeHtml(profilePronouns(applicant))}</dd></div>`;
  }

  function privateProfileDetailsDialog(applicant) {
    if (!canManagePrivateProfileDetails()) return '';
    const gender = String(applicant.gender_identity || '');
    const today = profileDetailsTools.calendarDateForInstant(new Date(), profileDetailsTimeZone(applicant));
    return `<dialog id="private-profile-details-dialog" class="soro-dialog profile-details-dialog private-profile-details-dialog"><form id="private-profile-details-form"><header class="dialog-heading"><div><p class="eyebrow">Private Talent information</p><h2>Edit Profile details</h2></div><button class="modal-close" type="button" data-close-private-profile-details aria-label="Close">×</button></header><p class="dialog-copy">Only date of birth and gender identity can be changed here. Age is calculated from the date of birth and is never stored separately.</p><label>Date of birth <span>Private · YYYY-MM-DD</span><input name="birth_date" type="date" min="${profileDetailsTools.EARLIEST_BIRTH_DATE}" max="${today.iso}" value="${escapeHtml(applicant.birth_date || '')}"></label><label>Gender identity <span>Private and optional</span><select name="gender_identity"><option value="">Select an option</option>${identityOption('female', 'Female', gender)}${identityOption('male', 'Male', gender)}${identityOption('nonbinary', 'Non-binary', gender)}${identityOption('self_describe', 'Prefer to self-describe', gender)}${identityOption('prefer_not_to_disclose', 'Prefer not to disclose', gender)}</select></label><label data-private-gender-self-description ${gender === 'self_describe' ? '' : 'hidden'}>Self-described gender <input name="gender_identity_self_description" maxlength="120" value="${escapeHtml(applicant.gender_identity_self_description || '')}"></label><p class="private-profile-details-status" aria-live="polite"></p><footer class="modal-actions"><button class="button secondary" type="button" data-close-private-profile-details>Cancel</button><button class="button primary" type="submit">Save private details</button></footer></form></dialog>`;
  }

  function bindPrivateProfileDetailsEditor() {
    const applicant = selectedProfileApplicant();
    const dialog = document.getElementById('private-profile-details-dialog');
    const openButton = document.getElementById('edit-private-profile-details');
    if (!applicant || !dialog || !openButton || !canManagePrivateProfileDetails()) return;
    const form = dialog.querySelector('form');
    const gender = form.elements.gender_identity;
    const selfDescription = form.querySelector('[data-private-gender-self-description]');
    const syncGender = () => {
      const visible = gender.value === 'self_describe';
      selfDescription.hidden = !visible;
      selfDescription.querySelector('input').required = visible;
    };
    openButton.addEventListener('click', () => { syncGender(); dialog.showModal(); });
    dialog.addEventListener('cancel', event => event.preventDefault());
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      event.preventDefault();
      event.stopPropagation();
    });
    dialog.querySelectorAll('[data-close-private-profile-details]').forEach(button => button.addEventListener('click', () => dialog.close()));
    gender.addEventListener('change', syncGender);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!canManagePrivateProfileDetails() || !window.soroSupabase) return;
      const formData = new FormData(form);
      const status = form.querySelector('.private-profile-details-status');
      const submit = form.querySelector('[type="submit"]');
      const birthDate = profileDetailsTools.validateBirthDate(formData.get('birth_date'), profileDetailsTimeZone(applicant));
      if (!birthDate.valid) { status.textContent = birthDate.error; return; }
      let updates;
      try {
        updates = profileDetailsTools.buildPrivateProfileUpdate({
          birthDate: birthDate.value,
          genderIdentity: formData.get('gender_identity'),
          genderSelfDescription: formData.get('gender_identity_self_description'),
          timeZone: profileDetailsTimeZone(applicant)
        });
      } catch (error) {
        status.textContent = error.message;
        return;
      }
      submit.disabled = true;
      submit.textContent = 'Saving…';
      const { data, error } = await window.soroSupabase
        .from('applicants')
        .update(updates)
        .eq('id', applicant.id)
        .select('birth_date,gender_identity,gender_identity_self_description')
        .single();
      if (error) {
        submit.disabled = false;
        submit.textContent = 'Save private details';
        status.textContent = 'Soro Ops could not save these private details. Refresh your secure session and try again.';
        return;
      }
      Object.assign(applicant, data || updates);
      dialog.close();
      toast('Private Profile details updated.');
      render();
    });
    syncGender();
  }

  const screeningSourceMap = {
    english: ['english_proof'],
    personality: ['disc_assessment', 'enneagram_assessment', 'mbti_assessment', 'assessment'],
    computer: ['equipment_proof'],
    internet: ['internet_proof']
  };

  function numericValues(value) {
    return (String(value || '').match(/\d+(?:\.\d+)?/g) || []).map(Number).filter(Number.isFinite);
  }

  function percentageValue(value) {
    const text = String(value || '');
    const scored = text.match(/(\d+(?:\.\d+)?)\s*\/\s*100\b/i)
      || text.match(/(\d+(?:\.\d+)?)\s*%/)
      || text.match(/(?:score|result)\s*[:\-]?\s*(\d+(?:\.\d+)?)/i);
    if (scored) return Math.max(0, Math.min(100, Number(scored[1])));
    const numericOnly = text.trim().match(/^\d+(?:\.\d+)?$/);
    return numericOnly ? Math.max(0, Math.min(100, Number(numericOnly[0]))) : null;
  }

  function screeningState(applicant, key, value) {
    if (value && !isExternalLink(value)) return '<span class="screening-state screening-state--ready">Recorded</span>';
    return '<span class="screening-state">Not entered</span>';
  }

  function englishCard(applicant) {
    const value = applicant.english_test_result;
    const score = percentageValue(value);
    const hasScore = score !== null;
    const tier = screeningPresentation.semanticTier('english', score);
    const ariaLabel = hasScore ? `${score} percent practice score, ${tier.label}. Visual context only, not a hiring recommendation.` : 'English practice score not recorded';
    const rangeLabel = (key, label) => tier.key === key ? `<strong>${label}</strong>` : `<span>${label}</span>`;
    const track = `<div class="proficiency-track ${tier.className}"><div class="semantic-scale" role="img" aria-label="${escapeHtml(hasScore ? `Practice score ${score} out of 100, in the ${tier.label.toLowerCase()} practice-score range` : 'Practice score not recorded')}">${hasScore ? `<i style="--score-position:${score}%" aria-hidden="true"></i>` : ''}</div><div class="scale-labels">${rangeLabel('low', '0–59 · Lower')}${rangeLabel('middle', '60–79 · Middle')}${rangeLabel('high', '80–100 · Higher')}</div></div>`;
    return `<article class="screening-card screening-card--english" data-screening-card="english"><header><div><span>English assessment</span><h4>English proficiency</h4></div>${screeningState(applicant, 'english', value)}</header><div class="screening-card__layout"><div class="screening-card__visual screening-score-visual ${tier.className}"><div class="screening-ring" style="--score:${hasScore ? score : 0}" role="img" aria-label="${escapeHtml(ariaLabel)}"><strong>${hasScore ? score : '—'}</strong><small>${hasScore ? 'practice' : 'Pending'}</small></div><span class="screening-tier-label">${escapeHtml(tier.label)}</span></div><div class="screening-card__details"><span class="screening-detail-label">EF SET Quick Check · practice score</span>${track}<p>${resultValue(value)}</p><small>Not a certified CEFR level. The recorded practice result remains linked to the applicant’s English assessment file.</small></div></div><p class="screening-tier-note">Visual practice-score context only · Not a certified CEFR level · Not a hiring recommendation</p><div class="screening-source-links" data-screening-sources="english"></div></article>`;
  }

  function personalityCard(applicant) {
    const value = applicant.personality_profile_score;
    const results = screeningPresentation.parsePersonalityResults(value);
    const mbti = results.mbtiDescription;
    const externalReference = (href, label) => `<a class="personality-reference-link" href="${href}" target="_blank" rel="noopener noreferrer">${label}<span aria-hidden="true">↗</span></a>`;
    const discExplanation = results.disc ? `<details class="personality-type-explanation"><summary>About ${escapeHtml(results.disc)}</summary><div><p>DISC describes self-reported behavioral and communication preferences. It does not measure ability or job performance.</p>${externalReference('https://www.discprofile.com/disc-styles', 'Read the full DISC style guide')}</div></details>` : '';
    const enneagramType = String(results.enneagram || '').match(/\b([1-9])\b/)?.[1];
    const enneagramExplanation = results.enneagram ? `<details class="personality-type-explanation"><summary>About ${escapeHtml(results.enneagram)}</summary><div><p>The Enneagram is a self-report framework describing recurring motivations and patterns, not a clinical diagnosis.</p>${externalReference(enneagramType ? `https://www.enneagraminstitute.com/type-${enneagramType}/` : 'https://www.enneagraminstitute.com/type-descriptions/', 'Read the full Enneagram description')}</div></details>` : '';
    const mbtiExplanation = mbti ? `<details class="personality-type-explanation"><summary>About ${escapeHtml(mbti.displayedCode)}</summary><div><strong>${escapeHtml(mbti.dimensions)}</strong><p>${escapeHtml(mbti.summary)}</p>${mbti.modifier ? `<p><b>${escapeHtml(`-${mbti.modifier}`)}</b> is the ${escapeHtml(mbti.modifierLabel.toLowerCase())} used by 16Personalities; it is not part of the core four-letter code.</p>` : ''}${externalReference(`https://www.16personalities.com/${mbti.code.toLowerCase()}-personality`, `Read the full ${escapeHtml(mbti.code)} description`)}</div></details>` : '';
    const rows = `<div><span>DISC</span><div><strong>${escapeHtml(results.disc || 'Pending')}</strong>${discExplanation}</div></div><div><span>Enneagram</span><div><strong>${escapeHtml(results.enneagram || 'Pending')}</strong>${enneagramExplanation}</div></div><div class="personality-mbti-result"><span>MBTI-style</span><div><strong>${escapeHtml(mbti?.displayedCode || results.mbti || 'Pending')}</strong>${mbtiExplanation}</div></div>`;
    return `<article class="screening-card screening-card--personality" data-screening-card="personality"><header><div><span>Three linked assessments</span><h4>Personality profile</h4></div>${screeningState(applicant, 'personality', value)}</header><div class="personality-score-grid">${rows}</div><p class="screening-result-note">DISC, Enneagram, and four-letter personality results remain separated so each result stays tied to its matching source. These self-report tools are descriptive, not clinical diagnoses or measures of job performance.</p><div class="screening-source-links" data-screening-sources="personality"></div></article>`;
  }

  function computerCard(applicant) {
    const value = applicant.computer_specs;
    const specs = screeningPresentation.parseComputerSpecs(value);
    const items = screeningPresentation.COMPUTER_SPEC_FIELDS.filter(field => specs[field.key]).map(field => ({ ...field, value: specs[field.key] }));
    const details = items.length ? `<dl class="computer-spec-list">${items.map(item => `<div><dt>${escapeHtml(item.label)}</dt><dd>${escapeHtml(item.value)}</dd></div>`).join('')}</dl>` : '<p class="screening-card-empty">Computer details have not been recorded yet.</p>';
    const device = profileDetailsTools.computerDeviceState(applicant.has_laptop);
    const icons = {
      laptop: '<svg class="professional-device-icon professional-device-icon--laptop" viewBox="0 0 144 104" aria-hidden="true"><rect class="device-shell" x="20" y="8" width="104" height="70" rx="7"/><rect class="device-screen" x="28" y="17" width="88" height="52" rx="2"/><circle class="device-camera" cx="72" cy="13" r="1.6"/><path class="device-base" d="M13 81h118l9 11c1.5 2-.2 5-3 5H7c-2.8 0-4.5-3-3-5z"/><path class="device-keyboard" d="M29 85h86l5 6H24z"/><path class="device-trackpad" d="M62 91h20"/></svg>',
      desktop: '<svg class="professional-device-icon professional-device-icon--desktop" viewBox="0 0 144 104" aria-hidden="true"><rect class="device-shell" x="17" y="8" width="91" height="65" rx="6"/><rect class="device-screen" x="25" y="16" width="75" height="48" rx="2"/><path class="device-stand" d="M62 74v11m-17 5h50"/><rect class="device-tower" x="116" y="20" width="20" height="62" rx="4"/><circle class="device-power" cx="126" cy="30" r="2"/><path class="device-keyboard" d="M27 91h77l7 7H20z"/></svg>',
      generic: '<svg class="professional-device-icon professional-device-icon--generic" viewBox="0 0 144 104" aria-hidden="true"><rect class="device-shell" x="22" y="10" width="100" height="64" rx="7"/><rect class="device-screen" x="30" y="18" width="84" height="47" rx="2"/><path class="device-stand" d="M72 75v12m-20 5h40"/><circle class="device-unknown" cx="72" cy="42" r="13"/><path class="device-question" d="M67 37c1-5 11-5 11 1 0 5-6 4-6 9m0 6h.01"/></svg>'
    };
    return `<article class="screening-card screening-card--computer" data-screening-card="computer"><header><div><span>Equipment submission</span><h4>Computer specifications</h4></div>${screeningState(applicant, 'computer', value)}</header><div class="screening-card__layout screening-card__layout--device"><div class="screening-device-visual screening-device-visual--${device.kind}" role="img" aria-label="${escapeHtml(device.label)}">${icons[device.kind]}<span>${escapeHtml(device.label)}</span></div><div class="screening-card__details">${details}</div></div><div class="screening-source-links" data-screening-sources="computer"></div></article>`;
  }

  function connectionMeterTrack(label, kind, value) {
    const hasValue = value !== null;
    const meter = screeningPresentation.speedMeterConfiguration(kind, value);
    const marker = hasValue ? `<span class="connection-meter__marker" style="--meter-position:${meter.position}%" aria-hidden="true"></span>` : '';
    const ariaLabel = hasValue
      ? `${label} ${value} megabits per second, ${meter.label}. Soro operational reference; displayed reference tier only, not eligibility.`
      : `${label} speed not recorded. Soro operational reference.`;
    return `<div class="connection-meter__row ${meter.className}" role="img" aria-label="${escapeHtml(ariaLabel)}"><div class="connection-meter__row-heading"><span>${escapeHtml(label)}</span><strong>${hasValue ? value : '—'} <small>Mbps</small></strong><b>${escapeHtml(meter.label)}</b></div><div class="connection-meter__scale" style="--lower-stop:${meter.lowerStop}%;--middle-stop:${meter.middleStop}%"><span class="connection-meter__zones" aria-hidden="true"></span><span class="connection-meter__ticks" aria-hidden="true"></span>${marker}</div><div class="connection-meter__limits" aria-hidden="true"><span style="--limit-position:0%">0</span><span style="--limit-position:${meter.lowerStop}%">${meter.lowerBoundary}</span><span style="--limit-position:${meter.middleStop}%">${meter.middleBoundary}</span><span style="--limit-position:100%">${meter.maximum}+ Mbps</span></div></div>`;
  }

  function internetCard(applicant) {
    const value = applicant.internet_speed;
    const readings = screeningPresentation.parseInternetSpeed(value);
    const latency = readings.latency !== null ? `<p class="connection-meter__latency"><span>Recorded ping / latency</span><strong>${readings.latency} ms</strong></p>` : '';
    return `<article class="screening-card screening-card--internet" data-screening-card="internet"><header><div><span>Speed-test submission</span><h4>Internet speed</h4></div>${screeningState(applicant, 'internet', value)}</header><div class="connection-meter" role="group" aria-label="Soro operational reference for recorded download and upload speeds"><div class="connection-meter__heading"><strong>Soro operational reference</strong><span>Recorded connection speeds</span></div>${connectionMeterTrack('Download', 'internetDownload', readings.download)}${connectionMeterTrack('Upload', 'internetUpload', readings.upload)}${latency}</div><p class="screening-result-note">The displayed readings remain linked to the submitted speed-test evidence.</p><p class="screening-tier-note">Color bands and text tiers provide visual context only, not a hiring recommendation, eligibility requirement, or connection-quality standard.</p><div class="screening-source-links" data-screening-sources="internet"></div></article>`;
  }

  function screeningResults(applicant) {
    const editButton = canManageScreeningResults() ? '<button class="text-button" id="edit-screening-results">Edit results</button>' : '';
    return `<section class="profile-screening" aria-labelledby="screening-results-title"><div class="screening-heading"><div><p class="eyebrow">Application screening</p><h3 class="screening-title" id="screening-results-title">Screening results</h3></div>${editButton}</div><p class="screening-copy">Admin and Talent Management record results from the applicant’s linked assessment files.</p><div class="screening-dashboard">${englishCard(applicant)}${personalityCard(applicant)}${computerCard(applicant)}${internetCard(applicant)}</div></section>`;
  }

  profilePage = function (a) {
    if (!a) return `<main class="page"><button class="text-button back-to-directory">← Back to Talent Directory</button><section class="panel profile-missing"><h1>Talent profile not found</h1><p>This profile may have been removed or you may no longer have access.</p></section></main>`;
    const contact = [a.email, a.phone].filter(Boolean).join(' · ') || 'Contact information not recorded';
    const editPrivateDetails = canManagePrivateProfileDetails() ? '<button class="text-button profile-details-private-edit" id="edit-private-profile-details" type="button">Edit</button>' : '';
    const personalityEditorValues = screeningPresentation.parsePersonalityResults(a.personality_profile_score);
    const computerEditorValues = screeningPresentation.parseComputerSpecs(a.computer_specs);
    return `<main class="page talent-profile-page"><button class="text-button back-to-directory">← Back to Talent Directory</button><section class="talent-profile-hero"><div class="headshot-wrap"><div class="talent-headshot" id="talent-headshot">${talentPlaceholder(a.full_name)}</div><label class="button headshot-upload">Upload headshot<input type="file" id="headshot-input" accept="image/jpeg,image/png,image/webp" hidden /></label><small>JPG, PNG, or WebP · up to 5 MB</small></div><div class="profile-identity"><p class="eyebrow">Talent profile</p><h1>${escapeHtml(a.full_name)}</h1>${communicationPreferences(a)}<p class="profile-contact">${escapeHtml(contact)}</p><div class="profile-tags"><span class="tag">${escapeHtml(titleCase(a.status))}</span><span class="tag neutral">${escapeHtml(titleCase(a.work_status))}</span></div></div><div class="profile-actions"><button class="button" id="profile-add-task">+ Add task</button></div></section><section class="profile-stat-grid"><article><p>Location & time zone</p><strong>${escapeHtml(formatTalentLocationTimeZone(a.location, recordedTalentTimeZone(a)))}</strong></article><article><p>Availability</p><strong>${escapeHtml(a.availability_note || a.dedicated_workspace || 'Availability to review')}</strong></article><article><p>Application received</p><strong>${a.application_received_at ? escapeHtml(new Date(a.application_received_at).toLocaleDateString()) : 'Not recorded'}</strong></article><article><p>Profile owner</p><strong>${a.talent_review_owner_id ? 'Assigned' : 'Unassigned'}</strong></article></section><div class="profile-layout"><section class="panel profile-section profile-details-section"><div class="panel-head"><div><p class="eyebrow">At a glance</p><h2>Profile details</h2></div>${editPrivateDetails}</div><dl class="profile-details"><div><dt>Work status</dt><dd>${escapeHtml(titleCase(a.work_status))}</dd></div>${privateProfileDetailRows(a)}<div><dt>Expected rate</dt><dd>${escapeHtml(a.expected_hourly_rate_text || a.expected_hourly_rate || 'Not recorded')}</dd></div><div><dt>Dream / goal</dt><dd>${escapeHtml(a.greatest_dream || 'To be discussed in the Talent interview')}</dd></div></dl></section><section class="panel profile-section profile-documents-section"><div class="panel-head"><div><p class="eyebrow">Private files</p><h2>Documents & assessments</h2></div><span class="tag">Secure</span></div><p class="eyebrow">Select a file to open its protected preview. Screening sources stay linked to their matching result card.</p><div id="profile-documents"><p class="eyebrow">Loading documents…</p></div></section></div>${screeningResults(a)}${privateProfileDetailsDialog(a)}<dialog id="screening-results-dialog"><form id="screening-results-form" class="modal screening-results-modal"><div class="modal-title"><div><p class="eyebrow">Talent screening</p><h2>Edit screening results</h2></div><button type="button" class="modal-close" aria-label="Close screening results">×</button></div><p class="eyebrow">Enter only the results shown in each applicant assessment. Every field is optional.</p><label>English test result<input name="english_test_result" maxlength="240" value="${resultInputValue(a.english_test_result)}" placeholder="Example: CEFR B2 · 86%" /></label><fieldset class="screening-editor-group"><legend>Personality profile</legend><label>DISC result<input name="personality_disc_result" maxlength="140" value="${resultInputValue(personalityEditorValues.disc)}" placeholder="Example: D 42, I 30, S 18, C 10" /></label><label>Enneagram result<input name="personality_enneagram_result" maxlength="140" value="${resultInputValue(personalityEditorValues.enneagram)}" placeholder="Example: Type 3" /></label><label>Four-letter personality result<input name="personality_mbti_result" maxlength="140" value="${resultInputValue(personalityEditorValues.mbti)}" placeholder="Example: ENFJ-T" /></label></fieldset><fieldset class="screening-editor-group"><legend>Computer specifications</legend><label>System / device type<input name="computer_system" maxlength="64" value="${resultInputValue(computerEditorValues.system)}" placeholder="Example: Laptop" /></label><label>Processor<input name="computer_processor" maxlength="64" value="${resultInputValue(computerEditorValues.processor)}" placeholder="Example: Intel Core i5" /></label><label>Memory<input name="computer_memory" maxlength="64" value="${resultInputValue(computerEditorValues.memory)}" placeholder="Example: 16 GB RAM" /></label><label>Storage<input name="computer_storage" maxlength="64" value="${resultInputValue(computerEditorValues.storage)}" placeholder="Example: 512 GB SSD" /></label><label>Operating system<input name="computer_operating_system" maxlength="64" value="${resultInputValue(computerEditorValues.operatingSystem)}" placeholder="Example: Windows 11" /></label><label>Other computer details<input name="computer_other" maxlength="64" value="${resultInputValue(computerEditorValues.other)}" placeholder="Optional additional detail" /></label></fieldset><label>Internet speed<input name="internet_speed" maxlength="240" value="${resultInputValue(a.internet_speed)}" placeholder="95 Mbps download · 48 Mbps upload" /></label><div class="modal-actions"><button class="button modal-cancel" type="button">Cancel</button><button class="button primary" type="submit">Save results</button></div><div id="screening-results-confirmation" aria-live="polite"></div></form></dialog></main>`;
  };

  const profilePageWithScreening = profilePage;

  function canVerifyTalentSkills() {
    return !isOwnTalentProfileView() && ['admin', 'talent_management'].includes(currentAccessRole());
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
    const resumeAccess = '<div class="screening-source-links profile-resume-access" data-profile-resume><span>Résumé</span><span class="screening-source-missing">Checking for an attached résumé…</span></div>';
    return markup
      .replace('</dl></section>', `</dl>${resumeAccess}</section>`)
      .replace('<section class="panel profile-section profile-documents-section">', `${skillReview}<section class="panel profile-section profile-documents-section">`);
  };

  function supportPage() {
    return `<main class="page support-page"><div class="page-heading"><div><p class="eyebrow">Soro Ops support</p><h1>Help & Support</h1><p class="eyebrow" style="margin-top:9px">Report a technical issue or ask for help using Soro Ops.</p></div></div><div class="support-grid"><section class="panel"><div class="panel-head"><div><p class="eyebrow">Technical support ticket</p><h2>Tell us what happened</h2></div></div><form id="help-ticket-form" class="support-form"><label>What do you need help with?<input name="subject" required maxlength="120" placeholder="Example: I cannot open a Talent document" /></label><label>Area<select name="area"><option>Sign-in and account access</option><option>Talent profiles and documents</option><option>Client records and placements</option><option>Tasks and notifications</option><option>Other technical issue</option></select></label><label>What happened?<textarea name="details" required placeholder="Include what you were trying to do, what you expected, and any message you saw."></textarea></label><small>Do not include passwords, payment details, or other sensitive information in a ticket.</small><button class="button primary" type="submit">Submit support ticket</button><div id="ticket-confirmation" aria-live="polite"></div></form></section><aside class="panel support-contact"><div><p class="eyebrow">Before submitting</p><h2>Quick checks</h2></div><article><h3>Document will not open?</h3><p>Allow pop-ups for Soro Ops, then select the file’s View button again.</p></article><article><h3>Can’t sign in?</h3><p>Use Forgot password on the sign-in screen. Admin and Talent Management can also send a secure reset link.</p></article><article><h3>Need an urgent workaround?</h3><p>Include the Talent or client name and the action that is blocked so the team can triage it quickly.</p></article></aside></div></main>`;
  }

  function strictLegacyAssessmentType(source) {
    if (String(source?.document_type || '').trim().toLowerCase() !== 'assessment') return '';
    const value = `${source?.file_name || ''} ${source?.storage_path || ''}`.toLowerCase();
    const matches = [
      /(^|[^a-z0-9])disc([^a-z0-9]|$)/.test(value) ? 'disc_assessment' : '',
      /(^|[^a-z0-9])enneagram([^a-z0-9]|$)/.test(value) ? 'enneagram_assessment' : '',
      /(^|[^a-z0-9])mbti([^a-z0-9]|$)|16[ _-]?personalit/.test(value) ? 'mbti_assessment' : ''
    ].filter(Boolean);
    return matches.length === 1 ? matches[0] : '';
  }

  function screeningDocumentType(source) {
    const classified = classifyDocument(source);
    return classified === 'assessment' ? strictLegacyAssessmentType(source) || 'assessment' : classified;
  }

  function sourceCategoryLabel(source) {
    const type = screeningDocumentType(source);
    return type === 'assessment'
      ? 'Legacy assessment · needs classification'
      : documentLabels[type] || titleCase(type);
  }

  function secureSourceButton(source) {
    const category = sourceCategoryLabel(source);
    return `<button class="screening-source-button open-private-document" type="button" data-storage-path="${escapeHtml(source.storage_path)}"><span class="screening-source-file-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v5h5M10 13h6m-6 4h4"/></svg></span><span class="screening-source-file-copy"><small>${escapeHtml(category)}</small><strong>${escapeHtml(source.file_name || category)}</strong></span><span class="screening-source-open">Open securely</span></button>`;
  }

  function trustedLegacyResumeUrl(value) {
    try {
      const url = new URL(String(value || '').trim());
      return url.protocol === 'https:' && ['drive.google.com', 'docs.google.com'].includes(url.hostname.toLowerCase()) ? url.href : '';
    } catch {
      return '';
    }
  }

  function openLegacyResume(value) {
    if (!canVerifyTalentSkills()) return;
    const url = trustedLegacyResumeUrl(value);
    if (!url) { toast('This legacy résumé needs to be uploaded again.'); return; }
    const viewer = window.open('', '_blank');
    if (!viewer) { toast('Allow pop-ups for Soro to open the original résumé.'); return; }
    viewer.opener = null;
    viewer.location.href = url;
  }

  function renderProfileResumeLinks(documents, applicant) {
    const target = document.querySelector('[data-profile-resume]');
    if (!target) return;
    const resumes = documents.filter(document => classifyDocument(document) === 'resume' && document.storage_path);
    const legacyResumeUrl = !resumes.length && canVerifyTalentSkills() ? trustedLegacyResumeUrl(applicant?.resume_url) : '';
    if (resumes.length) {
      target.innerHTML = `<span>Attached résumé${resumes.length === 1 ? '' : 's'}</span><div class="screening-source-file-list">${resumes.map(source => secureSourceButton(source)).join('')}</div>`;
    } else if (legacyResumeUrl) {
      target.innerHTML = '<span>Résumé</span><div class="screening-source-file-list"><button class="screening-source-button open-legacy-resume" type="button"><span class="screening-source-file-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v5h5M10 13h6m-6 4h4"/></svg></span><span class="screening-source-file-copy"><small>Original application résumé</small><strong>Legacy Google Drive file</strong></span><span class="screening-source-open">Open original</span></button></div>';
      target.querySelector('.open-legacy-resume')?.addEventListener('click', () => openLegacyResume(applicant.resume_url));
    } else if (canVerifyTalentSkills() && applicant?.resume_url) {
      target.innerHTML = '<span>Résumé</span><span class="screening-source-missing">Legacy résumé needs re-upload</span>';
    } else {
      target.innerHTML = '<span>Résumé</span><span class="screening-source-missing">Résumé not attached</span>';
    }
  }

  function renderScreeningSourceLinks(documents) {
    Object.entries(screeningSourceMap).forEach(([key, types]) => {
      const target = document.querySelector(`[data-screening-sources="${key}"]`);
      if (!target) return;
      const sources = documents.filter(document => types.includes(screeningDocumentType(document)) && document.storage_path);
      target.innerHTML = sources.length
        ? `<span>Source ${sources.length === 1 ? 'file' : 'files'}</span><div class="screening-source-file-list">${sources.map(source => secureSourceButton(source)).join('')}</div>`
        : '<span class="screening-source-missing">Source file not available</span>';
    });
  }

  function openTalentSkillReview() {
    const applicant = selectedProfileApplicant();
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

  function removeOwnProfileManagementActions(scope = root) {
    const headshotUpload = scope.querySelector('.headshot-upload');
    if (headshotUpload) {
      const uploadNote = headshotUpload.nextElementSibling;
      if (uploadNote?.tagName === 'SMALL') uploadNote.remove();
      headshotUpload.remove();
    }
    [
      '.back-to-directory', '#profile-add-task', '#edit-private-profile-details',
      '#private-profile-details-dialog', '#edit-screening-results', '#screening-results-dialog',
      '#review-talent-skills', '#edit-skills-experience', '.admin-profile-controls',
      '.talent-portal-access-card', '.talent-profile-danger-zone'
    ].forEach(selector => scope.querySelectorAll(selector).forEach(element => element.remove()));
    scope.querySelectorAll('.profile-stat-grid article').forEach(article => {
      if (article.querySelector('p')?.textContent.trim() === 'Profile owner') article.remove();
    });
    scope.querySelectorAll('.profile-actions').forEach(actions => {
      if (!actions.children.length && !actions.textContent.trim()) actions.remove();
    });
  }

  function renderOwnTalentProfile(applicant) {
    if (!applicant) {
      root.innerHTML = typeof talentSelfProfileStatusMarkup === 'function'
        ? talentSelfProfileStatusMarkup()
        : '<main class="page"><section class="panel profile-missing"><h1>My Profile</h1><p>Your Talent profile is not available yet.</p></section></main>';
      setActive();
      return;
    }
    selectedTalentId = applicant.id;
    root.innerHTML = profilePage(applicant);
    root.querySelector('.talent-profile-page')?.classList.add('talent-self-profile-page');
    removeOwnProfileManagementActions(root);
    bindView();
    bindPrivateProfileDetailsEditor();
    bindScreeningResultsEditor();
    loadTalentProfileDocuments();
    if (typeof isAdminWorkspacePreview === 'function' && isAdminWorkspacePreview('va')) {
      const documents = root.querySelector('#profile-documents');
      if (documents) documents.innerHTML = '<div class="documents-empty"><strong>Your secure files</strong><p>Files linked to the signed-in Talent profile appear here.</p></div>';
      const video = root.querySelector('#profile-introduction-video');
      if (video) video.innerHTML = '<section class="profile-introduction-video profile-video-empty"><p class="eyebrow">Video interviews</p><strong>No private video attached yet</strong><small>Any Talent-visible recording will appear here securely.</small></section>';
      root.querySelectorAll('[data-screening-sources]').forEach(source => {
        source.innerHTML = '<span class="screening-source-missing">Secure source file available in the signed-in Talent Portal</span>';
      });
    }
    setActive();
  }

  window.soroRemoveOwnProfileManagementActions = removeOwnProfileManagementActions;

  render = function () {
    if (typeof viewAllowedForAuthenticatedRole === 'function' && !viewAllowedForAuthenticatedRole(current)) {
      current = 'overview';
      selectedTalentId = null;
      history.replaceState({}, '', `${location.pathname}#overview`);
      setActive();
    }
    if (current === 'help') {
      root.innerHTML = supportPage();
      return;
    }
    if (current === 'talent-my-profile') {
      renderOwnTalentProfile(selectedProfileApplicant());
      return;
    }
    if (current === 'talent-profile') {
      const accessRole = typeof currentAuthenticatedRole === 'function'
        ? currentAuthenticatedRole()
        : currentAccessRole();
      if (['sales', 'sales_management'].includes(accessRole)) {
        if (window.SoroReadOnlyTalentProfile?.canOpenForRole?.(accessRole)) {
          window.SoroReadOnlyTalentProfile.mount(root, {
            id: selectedTalentId,
            onBack: () => window.soroGoBackFromReadOnlyTalentProfile?.()
          });
        } else {
          root.innerHTML = '<main class="page talent-profile-page"><section class="panel profile-missing" role="alert"><p class="eyebrow">Talent profile</p><h1>Talent profile unavailable</h1><p>The secure read-only profile is still loading. Refresh and try again.</p></section></main>';
        }
        return;
      }
      window.SoroReadOnlyTalentProfile?.reset?.();
      root.innerHTML = profilePage(selectedProfileApplicant());
      bindView();
      bindPrivateProfileDetailsEditor();
      bindScreeningResultsEditor();
      loadTalentProfileDocuments();
      return;
    }
    return baseRender();
  };

  document.addEventListener('click', event => {
    if (event.target.closest('#review-talent-skills')) openTalentSkillReview();
    if (event.target.closest('#edit-own-identity-preferences')) openOwnIdentityPreferences();
  });

  loadTalentProfileDocuments = async function () {
    const applicant = selectedProfileApplicant();
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
    all.filter(d => classifyDocument(d) !== 'profile_photo').forEach(d => { const type = screeningDocumentType(d); if (!groups.has(type)) groups.set(type, []); groups.get(type).push(d); });
    target.innerHTML = groups.size ? [...groups.entries()].map(([type, items]) => `<section class="document-group"><h3>${escapeHtml(type === 'assessment' ? 'Legacy assessments · needs classification' : documentLabels[type] || titleCase(type))}<span>${items.length}</span></h3>${items.map(d => `<article class="document-item"><span class="document-icon">${type === 'resume' ? '▤' : type === 'english_proof' ? 'A' : type === 'internet_proof' ? '⌁' : type === 'equipment_proof' ? '▣' : type === 'introduction_video' ? '▶' : '◫'}</span><span><strong>${escapeHtml(d.file_name)}</strong><small>${escapeHtml(titleCase(d.status || 'uploaded'))} · ${d.created_at ? escapeHtml(new Date(d.created_at).toLocaleDateString()) : 'Date not recorded'}</small></span>${d.storage_path ? `<button class="text-button file-view-button open-private-document" data-storage-path="${escapeHtml(d.storage_path)}">${type === 'introduction_video' ? 'Play video' : 'View file'}</button>` : '<span class="file-pending">File pending</span>'}</article>`).join('')}</section>`).join('') : '<div class="documents-empty"><strong>No documents attached yet</strong><p>Imported application files and new uploads will appear here.</p></div>';
    renderProfileResumeLinks(all, applicant);
    renderScreeningSourceLinks(all);
    target.querySelectorAll('.open-private-document').forEach(b => b.addEventListener('click', () => openPrivateDocument(b.dataset.storagePath)));
    document.querySelectorAll('.screening-source-button.open-private-document').forEach(button => button.addEventListener('click', () => openPrivateDocument(button.dataset.storagePath)));
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
    if (typeof viewAllowedForAuthenticatedRole === 'function' && !viewAllowedForAuthenticatedRole(action.dataset.notificationView)) return;
    current = action.dataset.notificationView;
    selectedTalentId = null;
    history.pushState({}, '', `${location.pathname}#${current}`);
    event.currentTarget.close();
    setActive();
    render();
  });
  window.addEventListener('soro-auth-changed', clearOwnIdentityPreferencesDialog);
  root.addEventListener('submit', async event => {
    if (event.target.id === 'screening-results-form') {
      event.preventDefault();
      if (!canManageScreeningResults()) return;
      const applicant = selectedProfileApplicant();
      const form = new FormData(event.target);
      const confirmation = document.getElementById('screening-results-confirmation');
      const submitButton = event.target.querySelector('[type="submit"]');
      if (!applicant || !window.soroSupabase) return;
      const optionalText = name => String(form.get(name) || '').trim();
      const updates = {
        english_test_result: optionalText('english_test_result') || null,
        personality_profile_score: screeningPresentation.serializePersonalityResults({
          disc: optionalText('personality_disc_result'),
          enneagram: optionalText('personality_enneagram_result'),
          mbti: optionalText('personality_mbti_result')
        }) || null,
        computer_specs: screeningPresentation.serializeComputerSpecs({
          system: optionalText('computer_system'),
          processor: optionalText('computer_processor'),
          memory: optionalText('computer_memory'),
          storage: optionalText('computer_storage'),
          operatingSystem: optionalText('computer_operating_system'),
          other: optionalText('computer_other')
        }) || null,
        internet_speed: optionalText('internet_speed') || null
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
