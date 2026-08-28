(() => {
  'use strict';

  const bucket = 'soro-private-documents';
  const activeModalId = 'record-manager-dialog';
  const talentStatuses = ['draft', 'submitted', 'in_review', 'needs_more_info', 'pending_on_hold', 'interviewing', 'training', 'bench_ready', 'shortlisted', 'client_review', 'placement_confirmed', 'onboarding', 'active', 'withdrawn', 'not_selected', 'inactive', 'not_eligible'];
  let authorizedRole = null;
  let organizationId = null;
  const currentAccessRole = () => String(window.soroCurrentAccess?.role || authorizedRole || '').toLowerCase();
  const canManageTalent = () => ['admin', 'talent_management'].includes(currentAccessRole());
  const canManageClients = () => currentAccessRole() === 'admin';
  const database = () => window.soroSupabase;
  const $ = (selector, parent = document) => parent.querySelector(selector);
  const escapeHtml = (value = '') => String(value).replace(/[&<>"]/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[char]));
  const fileSafeName = (name = 'file') => name.replace(/[^a-z0-9._-]+/gi, '-').replace(/-+/g, '-');
  const option = (value, currentValue) => `<option value="${value}" ${value === currentValue ? 'selected' : ''}>${escapeHtml(titleCase(value))}</option>`;
  const countryNames = `Philippines
Afghanistan
Albania
Algeria
Andorra
Angola
Antigua and Barbuda
Argentina
Armenia
Australia
Austria
Azerbaijan
Bahamas
Bahrain
Bangladesh
Barbados
Belarus
Belgium
Belize
Benin
Bhutan
Bolivia
Bosnia and Herzegovina
Botswana
Brazil
Brunei
Bulgaria
Burkina Faso
Burundi
Cabo Verde
Cambodia
Cameroon
Canada
Central African Republic
Chad
Chile
China
Colombia
Comoros
Congo (Republic of the)
Costa Rica
Côte d’Ivoire
Croatia
Cuba
Cyprus
Czechia
Democratic Republic of the Congo
Denmark
Djibouti
Dominica
Dominican Republic
Ecuador
Egypt
El Salvador
Equatorial Guinea
Eritrea
Estonia
Eswatini
Ethiopia
Fiji
Finland
France
Gabon
Gambia
Georgia
Germany
Ghana
Greece
Grenada
Guatemala
Guinea
Guinea-Bissau
Guyana
Haiti
Honduras
Hungary
Iceland
India
Indonesia
Iran
Iraq
Ireland
Israel
Italy
Jamaica
Japan
Jordan
Kazakhstan
Kenya
Kiribati
Kuwait
Kyrgyzstan
Laos
Latvia
Lebanon
Lesotho
Liberia
Libya
Liechtenstein
Lithuania
Luxembourg
Madagascar
Malawi
Malaysia
Maldives
Mali
Malta
Marshall Islands
Mauritania
Mauritius
Mexico
Micronesia
Moldova
Monaco
Mongolia
Montenegro
Morocco
Mozambique
Myanmar
Namibia
Nauru
Nepal
Netherlands
New Zealand
Nicaragua
Niger
Nigeria
North Korea
North Macedonia
Norway
Oman
Pakistan
Palau
Panama
Papua New Guinea
Paraguay
Peru
Poland
Portugal
Qatar
Romania
Russia
Rwanda
Saint Kitts and Nevis
Saint Lucia
Saint Vincent and the Grenadines
Samoa
San Marino
Sao Tome and Principe
Saudi Arabia
Senegal
Serbia
Seychelles
Sierra Leone
Singapore
Slovakia
Slovenia
Solomon Islands
Somalia
South Africa
South Korea
South Sudan
Spain
Sri Lanka
Sudan
Suriname
Sweden
Switzerland
Syria
Tajikistan
Tanzania
Thailand
Timor-Leste
Togo
Tonga
Trinidad and Tobago
Tunisia
Türkiye
Turkmenistan
Tuvalu
Uganda
Ukraine
United Arab Emirates
United Kingdom
United States
Uruguay
Uzbekistan
Vanuatu
Vatican City
Venezuela
Vietnam
Yemen
Zambia
Zimbabwe`.split('\n');
  const timeZoneOptions = [
    ['Asia/Manila', 'Philippines — Asia/Manila (PHT, UTC+08:00)'],
    ['Pacific/Auckland', 'New Zealand — Pacific/Auckland (UTC+12:00 / UTC+13:00)'],
    ['Australia/Sydney', 'Australia — Australia/Sydney (UTC+10:00 / UTC+11:00)'],
    ['Asia/Tokyo', 'Japan — Asia/Tokyo (UTC+09:00)'],
    ['Asia/Seoul', 'South Korea — Asia/Seoul (UTC+09:00)'],
    ['Asia/Singapore', 'Singapore — Asia/Singapore (UTC+08:00)'],
    ['Asia/Hong_Kong', 'Hong Kong — Asia/Hong_Kong (UTC+08:00)'],
    ['Asia/Shanghai', 'China — Asia/Shanghai (UTC+08:00)'],
    ['Asia/Bangkok', 'Thailand / Vietnam — Asia/Bangkok (UTC+07:00)'],
    ['Asia/Jakarta', 'Indonesia (Western) — Asia/Jakarta (UTC+07:00)'],
    ['Asia/Kolkata', 'India — Asia/Kolkata (UTC+05:30)'],
    ['Asia/Dhaka', 'Bangladesh — Asia/Dhaka (UTC+06:00)'],
    ['Asia/Dubai', 'United Arab Emirates — Asia/Dubai (UTC+04:00)'],
    ['Europe/London', 'United Kingdom — Europe/London (UTC+00:00 / UTC+01:00)'],
    ['Europe/Paris', 'Central Europe — Europe/Paris (UTC+01:00 / UTC+02:00)'],
    ['Africa/Johannesburg', 'South Africa — Africa/Johannesburg (UTC+02:00)'],
    ['Africa/Nairobi', 'East Africa — Africa/Nairobi (UTC+03:00)'],
    ['America/Sao_Paulo', 'Brazil — America/Sao_Paulo (UTC-03:00)'],
    ['America/New_York', 'United States / Canada Eastern — America/New_York (UTC-05:00 / UTC-04:00)'],
    ['America/Chicago', 'United States / Canada Central — America/Chicago (UTC-06:00 / UTC-05:00)'],
    ['America/Denver', 'United States / Canada Mountain — America/Denver (UTC-07:00 / UTC-06:00)'],
    ['America/Los_Angeles', 'United States / Canada Pacific — America/Los_Angeles (UTC-08:00 / UTC-07:00)'],
    ['America/Anchorage', 'Alaska — America/Anchorage (UTC-09:00 / UTC-08:00)'],
    ['Pacific/Honolulu', 'Hawaii — Pacific/Honolulu (UTC-10:00)'],
    ['Other', 'Other / not listed — specify your UTC offset']
  ];

  function locationOptions(options, currentValue, fallbackValue, includeDivider = false) {
    const current = currentValue || fallbackValue;
    const values = options.map(item => Array.isArray(item) ? item[0] : item);
    const rows = values.includes(current) ? options : [[current, `${current} — current saved value`], ...options];
    return rows.map((item, index) => {
      const [value, label] = Array.isArray(item) ? item : [item, item];
      const divider = includeDivider && index === 0 && value === 'Philippines' ? '<option disabled>──────────</option>' : '';
      return `<option value="${escapeHtml(value)}" ${value === current ? 'selected' : ''}>${escapeHtml(label)}</option>${divider}`;
    }).join('');
  }

  async function requireBrowserPlayableVideo(file) {
    if (!file || (!String(file.type).startsWith('video/') && !/\.(mp4|mov|webm)$/i.test(file.name))) return;
    if (/webm$/i.test(file.name) || file.type === 'video/webm') return;
    const chunkSize = Math.min(file.size, 2 * 1024 * 1024);
    const chunks = [file.slice(0, chunkSize)];
    if (file.size > chunkSize) chunks.push(file.slice(Math.max(0, file.size - chunkSize)));
    const signatures = (await Promise.all(chunks.map(chunk => chunk.arrayBuffer())))
      .map(buffer => new TextDecoder('latin1').decode(buffer))
      .join('');
    const supportedVideo = /avc1|avc3|vp08|vp09|av01/.test(signatures);
    const incompatibleVideo = /mp4v|s263|hvc1|hev1|dvh1|dvhe/.test(signatures);
    if (incompatibleVideo && !supportedVideo) {
      throw new Error('This video uses a codec that web browsers cannot reliably play. Convert it to an H.264 MP4 or WebM file, then upload the converted version.');
    }
  }

  function notify(message) {
    if (typeof toast === 'function') toast(message);
    else window.alert(message);
  }

  function closeModal() {
    const dialog = document.getElementById(activeModalId);
    if (dialog) dialog.close();
  }

  function openModal({ eyebrow = 'Soro Ops', title, note = '', content, onOpen }) {
    closeModal();
    const dialog = document.createElement('dialog');
    dialog.id = activeModalId;
    dialog.className = 'record-manager-dialog';
    dialog.innerHTML = `<div class="record-manager-shell"><header class="record-manager-header"><div><p class="record-manager-eyebrow">${escapeHtml(eyebrow)}</p><h2>${escapeHtml(title)}</h2></div><button type="button" class="record-manager-close" aria-label="Close">×</button></header><div class="record-manager-form">${note ? `<p class="record-manager-note">${escapeHtml(note)}</p>` : ''}${content}</div></div>`;
    document.body.append(dialog);
    $('.record-manager-close', dialog).addEventListener('click', closeModal);
    dialog.addEventListener('cancel', event => event.preventDefault());
    dialog.addEventListener('close', () => dialog.remove());
    dialog.showModal();
    onOpen?.(dialog);
  }

  function value(record, field) { return escapeHtml(record?.[field] ?? ''); }

  function talentNameParts(record = {}) {
    const raw = String(record.full_name || '').trim();
    if (!raw) return { lastName: '', firstName: '', middleName: '' };
    const comma = raw.indexOf(',');
    const familyName = comma >= 0 ? raw.slice(0, comma).trim() : raw.split(/\s+/)[0];
    const givenNames = comma >= 0 ? raw.slice(comma + 1).trim() : raw.split(/\s+/).slice(1).join(' ');
    const givenParts = givenNames.split(/\s+/).filter(Boolean);
    return { lastName: familyName, firstName: givenParts.shift() || '', middleName: givenParts.join(' ') };
  }

  const genderIdentityOptions = [
    ['', 'Select an option'],
    ['female', 'Female'],
    ['male', 'Male'],
    ['nonbinary', 'Non-binary'],
    ['self_describe', 'Prefer to self-describe'],
    ['prefer_not_to_disclose', 'Prefer not to disclose']
  ];

  const pronounOptions = [
    ['she_her', 'She/her'],
    ['he_him', 'He/him'],
    ['they_them', 'They/them'],
    ['use_name', 'Use my name'],
    ['self_describe', 'Let them describe their pronouns'],
    ['prefer_not_to_disclose', 'Prefer not to disclose']
  ];

  function genderIdentitySelect(current) {
    return genderIdentityOptions.map(([value, label]) => `<option value="${value}" ${value === String(current || '') ? 'selected' : ''}>${label}</option>`).join('');
  }

  function pronounChoices(record) {
    const selected = Array.isArray(record.pronouns) ? record.pronouns : [];
    return pronounOptions.map(([value, label]) => `<label class="identity-choice"><input type="checkbox" name="pronouns" value="${value}" ${selected.includes(value) ? 'checked' : ''}><span>${escapeHtml(label)}</span></label>`).join('');
  }

  function bindIdentityPreferenceControls(dialog) {
    const form = $('#talent-editor-form', dialog);
    const gender = form?.elements.genderIdentity;
    const genderOther = $('[data-gender-self-description]', form);
    const pronounOther = $('[data-pronouns-self-description]', form);
    if (!form || !gender || !genderOther || !pronounOther) return;
    const syncGender = () => {
      const visible = gender.value === 'self_describe';
      genderOther.hidden = !visible;
      $('input', genderOther).required = visible;
    };
    const syncPronouns = changed => {
      const boxes = [...form.querySelectorAll('input[name="pronouns"]')];
      const privateChoice = boxes.find(box => box.value === 'prefer_not_to_disclose');
      if (changed?.value === 'prefer_not_to_disclose' && changed.checked) boxes.forEach(box => { if (box !== changed) box.checked = false; });
      else if (changed?.checked && privateChoice) privateChoice.checked = false;
      else if (!changed && privateChoice?.checked) boxes.forEach(box => { if (box !== privateChoice) box.checked = false; });
      const visible = boxes.some(box => box.value === 'self_describe' && box.checked);
      pronounOther.hidden = !visible;
      $('input', pronounOther).required = visible;
    };
    gender.addEventListener('change', syncGender);
    form.querySelectorAll('input[name="pronouns"]').forEach(box => box.addEventListener('change', () => syncPronouns(box)));
    syncGender();
    syncPronouns();
  }

  async function loadAccess() {
    const client = database();
    if (!client) return;
    const { data: { user }, error: userError } = await client.auth.getUser();
    if (userError || !user) { authorizedRole = null; organizationId = null; return; }
    const { data, error } = await client.from('platform_users').select('organization_id,role').eq('id', user.id).maybeSingle();
    if (error) throw error;
    authorizedRole = data?.role || null;
    organizationId = data?.organization_id || null;
  }

  async function getOrganizationId() {
    if (!database()) throw new Error('Soro sign-in is still loading. Refresh and try again.');
    if (!organizationId) await loadAccess();
    if (!organizationId) throw new Error('Your Soro account is not connected to an organization.');
    return organizationId;
  }

  function talentForm(record = {}) {
    const names = talentNameParts(record);
    const currentStatus = record.status || 'draft';
    return `<form id="talent-editor-form">
      <div class="record-manager-grid">
        <div class="record-manager-field"><label for="talent-last-name">Last name</label><input id="talent-last-name" name="lastName" required value="${escapeHtml(names.lastName)}"></div>
        <div class="record-manager-field"><label for="talent-first-name">First name</label><input id="talent-first-name" name="firstName" required value="${escapeHtml(names.firstName)}"></div>
        <div class="record-manager-field"><label for="talent-middle-name">Middle name <span aria-label="optional">(optional)</span></label><input id="talent-middle-name" name="middleName" value="${escapeHtml(names.middleName)}"></div>
        <div class="record-manager-field"><label for="talent-preferred-name">Preferred name <span aria-label="optional">(optional)</span></label><input id="talent-preferred-name" name="preferredName" maxlength="100" autocomplete="nickname" value="${value(record, 'preferred_name')}"></div>
        <div class="record-manager-field"><label for="talent-gender-identity">Gender identity <span aria-label="optional">(optional)</span></label><select id="talent-gender-identity" name="genderIdentity">${genderIdentitySelect(record.gender_identity)}</select></div>
        <div class="record-manager-field" data-gender-self-description ${record.gender_identity === 'self_describe' ? '' : 'hidden'}><label for="talent-gender-self-description">Self-described gender</label><input id="talent-gender-self-description" name="genderIdentitySelfDescription" maxlength="120" value="${value(record, 'gender_identity_self_description')}"></div>
        <fieldset class="record-manager-field record-manager-field--wide identity-fieldset"><legend>Pronouns <span aria-label="optional">(optional)</span></legend><p>Select all that apply.</p><div class="identity-choice-grid">${pronounChoices(record)}</div></fieldset>
        <div class="record-manager-field record-manager-field--wide" data-pronouns-self-description ${Array.isArray(record.pronouns) && record.pronouns.includes('self_describe') ? '' : 'hidden'}><label for="talent-pronouns-self-description">Self-described pronouns</label><input id="talent-pronouns-self-description" name="pronounsSelfDescription" maxlength="120" value="${value(record, 'pronouns_self_description')}" placeholder="Example: ze/hir"></div>
        <div class="record-manager-field"><label for="talent-email">Email</label><input id="talent-email" type="email" name="email" required value="${value(record, 'email')}"></div>
        <div class="record-manager-field"><label for="talent-phone">Phone</label><input id="talent-phone" name="phone" value="${value(record, 'phone')}"></div>
        <div class="record-manager-field"><label for="talent-country">Country</label><select id="talent-country" name="country">${locationOptions(countryNames, record.country, 'Philippines', true)}</select></div>
        <div class="record-manager-field"><label for="talent-timezone">Time zone</label><select id="talent-timezone" name="timezone">${locationOptions(timeZoneOptions, record.timezone, 'Asia/Manila')}</select></div>
        <div class="record-manager-field"><label for="talent-work-status">Work status</label><select id="talent-work-status" name="workStatus"><option value="unemployed" ${record.work_status === 'unemployed' ? 'selected' : ''}>Unemployed</option><option value="employed" ${record.work_status === 'employed' ? 'selected' : ''}>Employed</option><option value="freelancer" ${record.work_status === 'freelancer' ? 'selected' : ''}>Freelancer</option></select></div>
        <div class="record-manager-field"><label for="talent-application-status">Application status</label><select id="talent-application-status" name="applicationStatus">${talentStatuses.map(status => option(status, currentStatus)).join('')}</select></div>
        <div class="record-manager-field"><label for="talent-rate">Expected hourly rate</label><input id="talent-rate" type="number" min="0" step="0.01" name="expectedRate" value="${value(record, 'expected_hourly_rate')}"></div>
        <div class="record-manager-field record-manager-field--wide"><label for="talent-address">Private address / location</label><input id="talent-address" name="address" value="${value(record, 'address_line_1')}"></div>
        <div class="record-manager-field record-manager-field--wide"><label for="talent-skills">Skills (comma-separated)</label><textarea id="talent-skills" name="skills">${Array.isArray(record.verified_skills) ? escapeHtml(record.verified_skills.join(', ')) : value(record, 'verified_skills')}</textarea></div>
        <div class="record-manager-field"><label for="talent-experience-years">Relevant experience (years)</label><input id="talent-experience-years" type="number" min="0" step="0.5" name="experienceYears" value="${value(record, 'relevant_experience_years')}"></div>
        <div class="record-manager-field record-manager-field--wide"><label for="talent-experience">Relevant experience</label><textarea id="talent-experience" name="experience">${value(record, 'relevant_experience_summary')}</textarea></div>
        <div class="record-manager-field record-manager-field--wide"><label for="talent-education">Education, certifications, and training</label><textarea id="talent-education" name="education">${value(record, 'education_training_summary')}</textarea></div>
        <div class="record-manager-field record-manager-field--wide"><label for="talent-dream">Dream / goal</label><textarea id="talent-dream" name="dream">${value(record, 'greatest_dream')}</textarea></div>
      </div><footer class="record-manager-footer"><button type="button" class="admin-record-button" data-close>Cancel</button><button type="submit" class="admin-record-button admin-record-button--primary">Save Talent profile</button></footer></form>`;
  }

  async function saveTalent(form, existing) {
    const formData = new FormData(form);
    const lastName = formData.get('lastName').trim();
    const firstName = formData.get('firstName').trim();
    const middleName = formData.get('middleName').trim();
    const genderIdentity = formData.get('genderIdentity').trim();
    const pronouns = formData.getAll('pronouns').map(String);
    const payload = {
      full_name: `${lastName}, ${firstName}${middleName ? ` ${middleName}` : ''}`,
      preferred_name: formData.get('preferredName').trim() || null,
      gender_identity: genderIdentity || null,
      gender_identity_self_description: genderIdentity === 'self_describe' ? formData.get('genderIdentitySelfDescription').trim() || null : null,
      pronouns,
      pronouns_self_description: pronouns.includes('self_describe') ? formData.get('pronounsSelfDescription').trim() || null : null,
      email: formData.get('email').trim(), phone: formData.get('phone').trim() || null,
      country: formData.get('country').trim() || null, timezone: formData.get('timezone').trim() || null,
      address_line_1: formData.get('address').trim() || null, work_status: formData.get('workStatus'),
      status: formData.get('applicationStatus'), expected_hourly_rate: formData.get('expectedRate') || null,
      verified_skills: formData.get('skills').split(',').map(skill => skill.trim()).filter(Boolean),
      relevant_experience_years: formData.get('experienceYears') || null,
      relevant_experience_summary: formData.get('experience').trim() || null,
      education_training_summary: formData.get('education').trim() || null,
      greatest_dream: formData.get('dream').trim() || null,
      skill_profile_updated_at: new Date().toISOString()
    };
    const client = database();
    let result;
    if (existing?.id) result = await client.from('applicants').update(payload).eq('id', existing.id).select().single();
    else {
      const organizationId = await getOrganizationId();
      if (!organizationId) throw new Error('No Soro organization is available for this profile.');
      const now = new Date().toISOString();
      result = await client.from('applicants').insert({ ...payload, organization_id: organizationId, application_received_at: now, submitted_at: payload.status === 'draft' ? null : now }).select().single();
    }
    if (result.error) throw result.error;
    await refreshTalent();
    return result.data;
  }

  async function refreshTalent() {
    await loadLiveApplicants();
  }

  function editTalent(record) {
    openModal({ eyebrow: record?.id ? 'Edit Talent profile' : 'New Talent', title: record?.id ? `Edit ${record.full_name}` : 'Add Talent', note: 'Only Soro staff can see private contact and address information.', content: talentForm(record), onOpen(dialog) {
      $('[data-close]', dialog).addEventListener('click', closeModal);
      bindIdentityPreferenceControls(dialog);
      $('#talent-editor-form', dialog).addEventListener('submit', async event => {
        event.preventDefault();
        const submit = $('button[type=submit]', dialog); submit.disabled = true; submit.textContent = 'Saving…';
        try { const saved = await saveTalent(event.currentTarget, record); closeModal(); notify(`${saved.full_name} was saved.`); }
        catch (error) { notify(error.message || 'The Talent profile could not be saved.'); submit.disabled = false; submit.textContent = 'Save Talent profile'; }
      });
    }});
  }

  function uploadTalentFile(record) {
    const options = ['resume','english_proof','disc_assessment','enneagram_assessment','mbti_assessment','internet_proof','equipment_proof','introduction_video','profile_photo','application_attachment'];
    openModal({ eyebrow: 'Private Talent document', title: `Upload for ${record.full_name}`, note: 'The file is stored privately and remains visible only to authorized Soro staff and this Talent.', content: `<form id="talent-upload-form"><div class="record-manager-grid"><div class="record-manager-field"><label for="document-type">File category</label><select id="document-type" name="documentType">${options.map(documentType => `<option value="${documentType}">${escapeHtml(documentLabels[documentType] || titleCase(documentType))}</option>`).join('')}</select></div><div class="record-manager-field"><label for="talent-file">Choose image, video, or document</label><input id="talent-file" name="file" type="file" required accept="image/jpeg,image/png,video/mp4,video/quicktime,video/webm,.pdf,.doc,.docx,.xls,.xlsx"></div><div class="record-manager-field record-manager-field--wide"><span class="admin-upload-status">JPG, PNG, PDF, Word, Excel, MP4, MOV, and WebM files up to 95 MB are accepted. Videos must use browser-playable H.264 MP4 or WebM.</span></div></div><footer class="record-manager-footer"><button type="button" class="admin-record-button" data-close>Cancel</button><button type="submit" class="admin-record-button admin-record-button--primary">Upload private file</button></footer></form>`, onOpen(dialog) {
      $('[data-close]', dialog).addEventListener('click', closeModal);
      $('#talent-upload-form', dialog).addEventListener('submit', async event => {
        event.preventDefault(); const formData = new FormData(event.currentTarget); const file = formData.get('file');
        const submit = $('button[type=submit]', dialog); submit.disabled = true; submit.textContent = 'Uploading…';
        try {
          if (!(file instanceof File) || !file.size) throw new Error('Choose a file to upload.');
          if (file.size > 95 * 1024 * 1024) throw new Error('Choose a file smaller than 95 MB.');
          await requireBrowserPlayableVideo(file);
          const path = `talent/${record.id}/${Date.now()}-${fileSafeName(file.name)}`;
          const { error: storageError } = await database().storage.from(bucket).upload(path, file, { contentType: file.type || undefined, upsert: false });
          if (storageError) throw storageError;
          const { error: documentError } = await database().from('documents').insert({ organization_id: record.organization_id, applicant_id: record.id, file_name: file.name, storage_path: path, document_type: formData.get('documentType'), status: 'uploaded' });
          if (documentError) throw documentError;
          closeModal(); notify(`${file.name} was attached to ${record.full_name}.`); if (selectedTalentId === record.id && typeof loadTalentProfileDocuments === 'function') loadTalentProfileDocuments();
        } catch (error) { notify(error.message || 'The file could not be uploaded.'); submit.disabled = false; submit.textContent = 'Upload private file'; }
      });
    }});
  }

  async function archiveTalent(record, restore = false, requireConfirmation = true) {
    const action = restore ? 'restore' : 'archive';
    if (requireConfirmation && !window.confirm(`Do you want to ${action} ${record.full_name}? ${restore ? 'They will return to the active Talent Directory.' : 'Their profile and private files will be kept and can be restored later.'}`)) return;
    const { error } = await database().from('applicants').update({ archived_at: restore ? null : new Date().toISOString() }).eq('id', record.id);
    if (error) return notify(error.message || `Could not ${action} this Talent.`);
    if (!restore) {
      current = 'vas';
      selectedTalentId = null;
      history.pushState({}, '', `${location.pathname}#talent`);
      setActive();
    }
    await refreshTalent(); notify(`${record.full_name} was ${restore ? 'restored' : 'archived'}.`);
  }

  function clientForm(record = {}) {
    const contact = record.primary_contact || {};
    const lifecycleStage = record.lifecycle_stage || 'new_inquiry';
    return `<form id="client-editor-form"><div class="record-manager-grid"><div class="record-manager-field"><label for="client-company">Company name</label><input id="client-company" name="companyName" required value="${value(record, 'company_name')}"></div><div class="record-manager-field"><label for="client-industry">Industry</label><input id="client-industry" name="industry" value="${value(record, 'industry')}"></div><div class="record-manager-field"><label for="client-stage">Lifecycle stage</label><select id="client-stage" name="lifecycleStage">${['new_inquiry', 'discovery', 'matching', 'active', 'paused'].map(stage => option(stage, lifecycleStage)).join('')}</select></div><div class="record-manager-field"><label for="client-contact">Primary contact</label><input id="client-contact" name="contactName" required value="${value(contact, 'full_name')}"></div><div class="record-manager-field"><label for="client-email">Contact email</label><input id="client-email" type="email" name="contactEmail" required value="${value(contact, 'email')}"></div><div class="record-manager-field"><label for="client-phone">Contact phone</label><input id="client-phone" name="contactPhone" required value="${value(contact, 'phone')}"></div></div><footer class="record-manager-footer"><button type="button" class="admin-record-button" data-close>Cancel</button><button type="submit" class="admin-record-button admin-record-button--primary">Save Client</button></footer></form>`;
  }

  async function saveClient(form, existing) {
    const fd = new FormData(form); const client = database();
    const payload = { company_name: fd.get('companyName').trim(), industry: fd.get('industry').trim() || null, lifecycle_stage: fd.get('lifecycleStage') };
    let result;
    if (existing?.id) result = await client.from('clients').update(payload).eq('id', existing.id).select().single();
    else { const organizationId = await getOrganizationId(); result = await client.from('clients').insert({ ...payload, organization_id: organizationId }).select().single(); }
    if (result.error) throw result.error;
    const contact = { client_id: result.data.id, full_name: fd.get('contactName').trim(), email: fd.get('contactEmail').trim(), phone: fd.get('contactPhone').trim(), contact_role: 'primary' };
    const contactResult = existing?.primary_contact?.id
      ? await client.from('client_contacts').update(contact).eq('id', existing.primary_contact.id)
      : await client.from('client_contacts').insert(contact);
    if (contactResult.error) throw new Error(`The Client was saved, but the primary contact could not be saved: ${contactResult.error.message}`);
    return result.data;
  }

  function editClient(record) {
    openModal({ eyebrow: record?.id ? 'Edit Client record' : 'New Client', title: record?.id ? `Edit ${record.company_name}` : 'Add Client', note: 'Client archive retains relationship history and can be restored by Admin.', content: clientForm(record), onOpen(dialog) {
      $('[data-close]', dialog).addEventListener('click', closeModal);
      $('#client-editor-form', dialog).addEventListener('submit', async event => { event.preventDefault(); const submit = $('button[type=submit]', dialog); submit.disabled = true; submit.textContent = 'Saving…'; try { const saved = await saveClient(event.currentTarget, record); closeModal(); notify(`${saved.company_name} was saved.`); render(); } catch (error) { notify(error.message || 'The Client record could not be saved.'); submit.disabled = false; submit.textContent = 'Save Client'; } });
    }});
  }

  async function renderManagedClients() {
    if (current !== 'clients' || !canManageClients() || !database()) return;
    const page = $('.page'); if (!page || $('#admin-managed-clients', page)) return;
    const { data, error } = await database().from('clients').select('id,company_name,industry,lifecycle_stage,archived_at,client_contacts(id,full_name,email,phone,contact_role)').is('archived_at', null).order('created_at', { ascending: false }).limit(20);
    if (error) return notify(error.message || 'Client records could not be loaded.');
    const clients = (data || []).map(client => ({ ...client, primary_contact: (client.client_contacts || []).find(contact => contact.contact_role === 'primary') || null }));
    const section = document.createElement('section'); section.id = 'admin-managed-clients'; section.className = 'admin-managed-records';
    section.innerHTML = `<h2>Manage Client records</h2><p>Create, update, archive, or restore client records. Archived records keep their full history.</p><div class="admin-managed-list">${clients.length ? clients.map(client => `<div class="admin-managed-item"><div><strong>${escapeHtml(client.company_name)}</strong><span>${escapeHtml(client.industry || 'Industry not recorded')} · ${escapeHtml(titleCase(client.lifecycle_stage || 'new_inquiry'))}${client.primary_contact ? ` · ${escapeHtml(client.primary_contact.full_name)}` : ''}</span></div><div class="admin-record-actions"><button class="admin-record-button" data-edit-client="${client.id}">Edit</button><button class="admin-record-button admin-record-button--danger" data-archive-client="${client.id}">Archive</button></div></div>`).join('') : '<p>No Client records have been added yet.</p>'}</div><div class="record-manager-footer"><button class="admin-record-button" data-view-archived-clients>View archived Clients</button></div>`;
    page.append(section);
    section.addEventListener('click', async event => {
      const edit = event.target.closest('[data-edit-client]'); const archive = event.target.closest('[data-archive-client]');
      if (edit) { const client = clients.find(item => item.id === edit.dataset.editClient); if (client) editClient(client); }
      if (archive) { const client = clients.find(item => item.id === archive.dataset.archiveClient); if (!client || !window.confirm(`Archive ${client.company_name}? It can be restored later.`)) return; const { error: archiveError } = await database().from('clients').update({ archived_at: new Date().toISOString() }).eq('id', client.id); if (archiveError) notify(archiveError.message); else { notify(`${client.company_name} was archived.`); section.remove(); renderManagedClients(); } }
      if (event.target.closest('[data-view-archived-clients]')) showArchivedClients();
    });
  }

  async function showArchivedClients() {
    const { data, error } = await database().from('clients').select('id,company_name,industry,archived_at').not('archived_at', 'is', null).order('archived_at', { ascending: false });
    if (error) return notify(error.message);
    openModal({ eyebrow: 'Retention records', title: 'Archived Clients', note: 'These records are hidden from active workspaces but are never deleted here.', content: `<div class="admin-managed-list">${(data || []).length ? data.map(client => `<div class="admin-managed-item"><div><strong>${escapeHtml(client.company_name)}</strong><span>${escapeHtml(client.industry || 'Industry not recorded')}</span></div><button class="admin-record-button" data-restore-client="${client.id}">Restore</button></div>`).join('') : '<p class="record-manager-note">No archived Client records.</p>'}</div>`, onOpen(dialog) { dialog.addEventListener('click', async event => { const button = event.target.closest('[data-restore-client]'); if (!button) return; const { error: restoreError } = await database().from('clients').update({ archived_at: null }).eq('id', button.dataset.restoreClient); if (restoreError) return notify(restoreError.message); closeModal(); notify('Client restored.'); document.getElementById('admin-managed-clients')?.remove(); renderManagedClients(); }); } });
  }

  async function showArchivedTalent() {
    const { data, error } = await database().from('applicants').select('*').not('archived_at', 'is', null).order('archived_at', { ascending: false });
    if (error) return notify(error.message);
    openModal({ eyebrow: 'Retention records', title: 'Archived Talent', note: 'Archived Talent profiles and their private files are retained securely.', content: `<div class="admin-managed-list">${(data || []).length ? data.map(record => `<div class="admin-managed-item"><div><strong>${escapeHtml(record.full_name)}</strong><span>${escapeHtml(record.email || 'No email recorded')}</span></div><button class="admin-record-button" data-restore-talent="${record.id}">Restore</button></div>`).join('') : '<p class="record-manager-note">No archived Talent profiles.</p>'}</div>`, onOpen(dialog) { dialog.addEventListener('click', event => { const button = event.target.closest('[data-restore-talent]'); if (!button) return; const record = (data || []).find(item => item.id === button.dataset.restoreTalent); if (record) { closeModal(); archiveTalent(record, true, false); } }); } });
  }

  function addTalentProfileControls() {
    if (current !== 'talent-profile' || !canManageTalent()) return;
    const applicant = liveApplicants.find(item => item.id === selectedTalentId); const actions = $('.profile-actions');
    if (!applicant || !actions || $('.admin-profile-controls', actions)) return;
    const controls = document.createElement('div'); controls.className = 'admin-record-actions admin-profile-controls';
    controls.innerHTML = `<button class="admin-record-button" data-edit-talent>Edit profile</button><button class="admin-record-button" data-upload-talent>Upload file</button><button class="admin-record-button admin-record-button--danger" data-archive-talent>Archive</button>`;
    actions.append(controls);
    controls.addEventListener('click', event => { if (event.target.closest('[data-edit-talent]')) editTalent(applicant); if (event.target.closest('[data-upload-talent]')) uploadTalentFile(applicant); if (event.target.closest('[data-archive-talent]')) archiveTalent(applicant); });
  }

  function addDirectoryControls() {
    const actions = $('.heading-actions');
    if (!actions) return;
    if (current === 'vas' && canManageTalent() && !$('.admin-directory-controls', actions)) {
      const controls = document.createElement('span'); controls.className = 'admin-record-actions admin-directory-controls'; controls.innerHTML = '<button class="admin-record-button" data-new-talent>+ New Talent</button><button class="admin-record-button" data-archived-talent>Archived Talent</button>'; actions.prepend(controls);
      controls.addEventListener('click', event => { if (event.target.closest('[data-new-talent]')) editTalent(); if (event.target.closest('[data-archived-talent]')) showArchivedTalent(); });
    }
    if (current === 'clients' && canManageClients()) {
      const button = $('#new-record', actions);
      if (button && !button.dataset.adminClientControl) {
        button.dataset.adminClientControl = 'true';
        button.classList.add('primary');
        button.addEventListener('click', event => { event.stopImmediatePropagation(); editClient(); }, true);
      }
    }
  }

  function attachControls() { addDirectoryControls(); addTalentProfileControls(); renderManagedClients(); }
  const observer = new MutationObserver(() => requestAnimationFrame(attachControls));
  window.addEventListener('soro-auth-changed', async event => {
    if (!event.detail.session) { authorizedRole = null; organizationId = null; return; }
    try { await loadAccess(); attachControls(); } catch (error) { console.error('Soro record-management access could not be loaded.', error); }
  });
  const start = async () => {
    observer.observe(document.body, { childList: true, subtree: true });
    try { await loadAccess(); } catch (error) { console.error('Soro record-management access could not be loaded.', error); }
    attachControls();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
