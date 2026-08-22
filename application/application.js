(() => {
  const form = document.querySelector('#talent-application');
  if (!form) return;
  const steps = [...document.querySelectorAll('.form-step')];
  const stepLinks = [...document.querySelectorAll('.application-steps li')];
  const alertBox = document.querySelector('#application-alert');
  const confirmation = document.querySelector('#save-confirmation');
  const applicationShell = document.querySelector('.application-shell');
  const previous = document.querySelector('#previous-step');
  const next = document.querySelector('#next-step');
  const submit = document.querySelector('#submit-application');
  const save = document.querySelector('#save-draft');
  const uploadStatus = document.querySelector('#upload-status');
  const phoneUpload = document.querySelector('#phone-upload');
  const phoneUploadQr = document.querySelector('#phone-upload-qr');
const phoneUploadLink = document.querySelector('#phone-upload-link');
const phoneUploadButton = document.querySelector('#generate-phone-upload');
const videoMethodOptions = Array.from(form.querySelectorAll('input[name="videoMethod"]'));
const videoMethodPanels = Array.from(form.querySelectorAll('[data-video-method-panel]'));
  const state = { step: 1, maxVisitedStep: 1, resumeToken: new URLSearchParams(location.search).get('resume') || new URLSearchParams(location.hash.slice(1)).get('resume'), uploads: {}, uploadIds: {} };
  const mobileVideoMode = new URLSearchParams(location.search).has('mobileVideo');
  const localPreview = location.protocol === 'file:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  // Local previews (and an explicit ?review=1 link) let Soro review layout freely.
  // The deployed applicant experience remains a guided, validated step-by-step flow.
  const reviewMode = localPreview || new URLSearchParams(location.search).has('review');
  const localDraftKey = 'soro-talent-application-preview-draft-v2';
  const arrayFieldNames = new Set(['experienceAreas', 'skillsByCategory']);
  const experienceCatalog = [
    {
      id: 'healthcare',
      label: 'Medical & healthcare support',
      skills: [
        ['patient_scheduling', 'Patient appointment scheduling and confirmation'],
        ['patient_intake', 'Patient intake and demographic updates'],
        ['patient_follow_up', 'Patient reminder calls and non-clinical follow-up'],
        ['insurance_verification', 'Insurance eligibility and benefits verification'],
        ['prior_authorization', 'Prior authorization and referral coordination'],
        ['medical_billing', 'Medical billing and payment-posting support'],
        ['claims_follow_up', 'Claims preparation and follow-up'],
        ['medical_coding', 'Medical coding support (ICD-10, CPT, or HCPCS)'],
        ['ehr_updates', 'EHR/EMR data entry and chart maintenance'],
        ['medical_records', 'Medical-record requests and document routing']
      ]
    },
    {
      id: 'general_admin',
      label: 'General administrative & executive support',
      skills: [
        ['inbox_management', 'Email and inbox management'],
        ['calendar_management', 'Calendar and appointment scheduling'],
        ['data_entry', 'Data entry and database updates'],
        ['document_formatting', 'Document preparation and formatting'],
        ['file_organization', 'File and cloud-drive organization'],
        ['online_research', 'Online research and information gathering'],
        ['meeting_coordination', 'Meeting coordination and note-taking'],
        ['crm_updates', 'CRM and contact-record maintenance'],
        ['project_tracking', 'Task and project tracking'],
        ['sop_documentation', 'SOP and process documentation']
      ]
    },
    {
      id: 'social_media',
      label: 'Social media & digital marketing',
      skills: [
        ['content_planning', 'Content-calendar planning'],
        ['copywriting', 'Caption and social-copy writing'],
        ['graphic_design', 'Static graphic creation'],
        ['short_form_video', 'Short-form video editing'],
        ['post_scheduling', 'Post scheduling and publishing'],
        ['community_management', 'Comment, message, and community management'],
        ['inbox_moderation', 'Inbox and comment moderation'],
        ['social_analytics', 'Analytics and performance reporting'],
        ['keyword_research', 'Hashtag and keyword research'],
        ['paid_social_support', 'Paid-social campaign support']
      ]
    },
    {
      id: 'customer_support',
      label: 'Customer service & client support',
      skills: [
        ['email_support', 'Email customer support'],
        ['live_chat_support', 'Live-chat customer support'],
        ['phone_support', 'Phone customer support'],
        ['helpdesk_systems', 'Ticketing-system management'],
        ['crm_case_notes', 'CRM and customer-record updates'],
        ['order_support', 'Order or appointment support'],
        ['complaint_resolution', 'Complaint handling and de-escalation'],
        ['returns_refunds', 'Returns, refunds, or cancellations'],
        ['customer_follow_up', 'Customer follow-up and retention'],
        ['knowledge_base', 'Knowledge-base or FAQ updates']
      ]
    },
    {
      id: 'ecommerce',
      label: 'E-commerce support',
      skills: [
        ['product_listings', 'Product listing creation and updates'],
        ['order_processing', 'Order processing'],
        ['inventory_updates', 'Inventory monitoring and updates'],
        ['customer_order_support', 'Customer order support'],
        ['marketplace_management', 'Marketplace management'],
        ['product_research', 'Product research'],
        ['supplier_coordination', 'Supplier or vendor coordination'],
        ['shipment_tracking', 'Fulfillment and shipment tracking'],
        ['returns_management', 'Return, refund, and exchange processing'],
        ['ecommerce_reporting', 'Store-performance and sales reporting']
      ]
    }
  ];
  const experienceById = new Map(experienceCatalog.map(category => [category.id, category]));
  const skillLabels = new Map(experienceCatalog.flatMap(category => category.skills));
  previous.textContent = '← Back';
  document.querySelector('#current-year').textContent = new Date().getFullYear();

  const setBusy = (isBusy, label) => {
    [save, previous, next, submit].forEach(button => { button.disabled = isBusy; });
    if (isBusy && label) submit.textContent = label;
    if (!isBusy) submit.textContent = 'Submit application';
  };
const message = (text, kind = 'error') => {
  const hasMessage = Boolean(text);
  alertBox.textContent = hasMessage ? text : '';
  alertBox.hidden = !hasMessage;
  alertBox.classList.toggle('is-success', hasMessage && kind === 'success');
  alertBox.style.display = hasMessage ? 'block' : 'none';
  if (hasMessage) alertBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};
  const namedControls = name => [...form.querySelectorAll('[name]')].filter(control => control.name === name);
  const selectedExperienceAreas = () => namedControls('experienceAreas').filter(input => input.checked && !input.disabled).map(input => input.value);
  const selectedSkillIds = () => namedControls('skillsByCategory').filter(input => input.checked && !input.disabled).map(input => input.value);

  const renderExperienceCatalog = () => {
    const container = form.querySelector('#experience-skills');
    if (!container) return;
    container.innerHTML = experienceCatalog.map(category => `
      <fieldset data-skill-category="${category.id}" hidden>
        <legend>${category.label}</legend>
        <div class="skill-options">
          ${category.skills.map(([id, label]) => `<label for="skill-${id}"><input id="skill-${id}" name="skillsByCategory" type="checkbox" value="${id}" data-category="${category.id}"><span>${label}</span></label>`).join('')}
        </div>
      </fieldset>`).join('');
  };

  const setConditionalField = (triggerName, fieldName, wrapperSelector) => {
    const trigger = form.elements[triggerName];
    const field = form.elements[fieldName];
    const wrapper = form.querySelector(wrapperSelector) || field?.closest('label, .field');
    if (!trigger || !field || !wrapper) return;
    const selectedText = trigger.selectedOptions?.[0]?.textContent || '';
    const show = String(trigger.value).trim().toLowerCase() === 'other' || /^other\b/i.test(selectedText.trim());
    wrapper.hidden = !show;
    field.disabled = !show;
    field.required = show;
    if (!show) field.setCustomValidity('');
  };

  const updateConditionalFields = () => {
    setConditionalField('timezone', 'timezoneOther', '#timezone-other-field');
    setConditionalField('currentWorkStatus', 'currentWorkStatusOther', '#work-status-other-field');
  };

  const updateExperienceUI = changedInput => {
    const areaInputs = namedControls('experienceAreas');
    const noPrior = areaInputs.find(input => input.value === 'no_prior');
    if (changedInput?.checked && changedInput.value === 'no_prior') {
      areaInputs.forEach(input => { if (input !== changedInput) input.checked = false; });
      namedControls('skillsByCategory').forEach(input => { input.checked = false; });
    } else if (changedInput?.checked && noPrior) {
      noPrior.checked = false;
    }

    areaInputs.forEach(input => input.setCustomValidity(''));
    namedControls('skillsByCategory').forEach(input => input.setCustomValidity(''));
    const selected = selectedExperienceAreas();
    const hasNoPrior = selected.includes('no_prior');
    const selectedCatalogIds = selected.filter(id => experienceById.has(id));
    const otherSelected = selected.includes('other');
    const otherField = form.elements.experienceOther;
    const otherWrapper = form.querySelector('#experience-other-field') || otherField?.closest('label, .field');
    if (otherField && otherWrapper) {
      otherWrapper.hidden = !otherSelected || hasNoPrior;
      otherField.disabled = !otherSelected || hasNoPrior;
      otherField.required = otherSelected && !hasNoPrior;
      if (otherField.disabled) otherField.setCustomValidity('');
    }

    const note = form.querySelector('#experience-no-prior-note');
    if (note) note.hidden = !hasNoPrior;
    const skillsContainer = form.querySelector('#experience-skills');
    if (skillsContainer) {
      skillsContainer.hidden = hasNoPrior || selectedCatalogIds.length === 0;
      skillsContainer.querySelectorAll('[data-skill-category]').forEach(panel => {
        const show = !hasNoPrior && selectedCatalogIds.includes(panel.dataset.skillCategory);
        panel.hidden = !show;
        panel.querySelectorAll('input').forEach(input => { input.disabled = !show; });
      });
    }

    const otherSkills = form.elements.otherSkills;
    const otherSkillsWrapper = form.querySelector('#other-skills-field') || otherSkills?.closest('label, .field');
    const showOtherSkills = !hasNoPrior && selected.length > 0;
    if (otherSkills && otherSkillsWrapper) {
      otherSkillsWrapper.hidden = !showOtherSkills;
      otherSkills.disabled = !showOtherSkills;
      otherSkills.required = false;
    }
  };

  const formatRateNumber = number => Number.isInteger(number) ? String(number) : String(Number(number.toFixed(2)));
  const expectedRateText = () => {
    const minimum = Number(form.elements.expectedRateMin?.value);
    const maximum = Number(form.elements.expectedRateMax?.value);
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum <= 0 || maximum <= 0 || maximum < minimum) return '';
    return `$${formatRateNumber(minimum)}-$${formatRateNumber(maximum)} USD per hour`;
  };
  const updateExpectedRatePreview = () => {
    const text = expectedRateText();
    const stored = form.elements.expectedRateText;
    if (stored) stored.value = text;
    const preview = form.querySelector('#expected-rate-preview');
    if (!preview) return text;
    preview.textContent = text ? 'Your rate will appear as: ' : 'Enter both amounts to confirm your expected hourly range.';
    if (text) {
      const strong = document.createElement('strong');
      strong.textContent = text;
      preview.append(strong);
    }
    return text;
  };

  const validateExpectedRate = () => {
    const minimumField = form.elements.expectedRateMin;
    const maximumField = form.elements.expectedRateMax;
    if (!minimumField || !maximumField) return true;
    minimumField.setCustomValidity('');
    maximumField.setCustomValidity('');
    const minimum = Number(minimumField.value);
    const maximum = Number(maximumField.value);
    if (!minimumField.value || !Number.isFinite(minimum) || minimum <= 0) {
      minimumField.setCustomValidity('Enter a minimum hourly rate greater than zero.');
      minimumField.reportValidity();
      return false;
    }
    if (!maximumField.value || !Number.isFinite(maximum) || maximum <= 0) {
      maximumField.setCustomValidity('Enter a maximum hourly rate greater than zero.');
      maximumField.reportValidity();
      return false;
    }
    if (maximum < minimum) {
      maximumField.setCustomValidity('Your maximum rate must be equal to or greater than your minimum rate.');
      maximumField.reportValidity();
      return false;
    }
    updateExpectedRatePreview();
    return true;
  };

  const validateExperienceSkills = () => {
    const areaInputs = namedControls('experienceAreas');
    if (!areaInputs.length) return true;
    areaInputs.forEach(input => input.setCustomValidity(''));
    namedControls('skillsByCategory').forEach(input => input.setCustomValidity(''));
    const selected = selectedExperienceAreas();
    if (!selected.length) {
      areaInputs[0].setCustomValidity('Select at least one work area, or choose that you do not have prior professional experience.');
      areaInputs[0].reportValidity();
      return false;
    }
    if (selected.includes('no_prior')) return true;
    const missingCategory = selected.map(id => experienceById.get(id)).filter(Boolean).find(category => !namedControls('skillsByCategory').some(input => input.dataset.category === category.id && input.checked && !input.disabled));
    if (!missingCategory) return true;
    const firstSkill = namedControls('skillsByCategory').find(input => input.dataset.category === missingCategory.id && !input.disabled);
    if (firstSkill) {
      firstSkill.setCustomValidity(`Select at least one skill for ${missingCategory.label}.`);
      firstSkill.reportValidity();
      firstSkill.closest('fieldset')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return false;
  };

  const formData = () => {
    const data = new FormData(form);
    const value = {};
    const names = [...new Set([...form.querySelectorAll('[name]')].map(control => control.name).filter(Boolean))];
    names.forEach(name => {
      const controls = namedControls(name);
      if (!controls.length || controls[0].type === 'file') return;
      if (arrayFieldNames.has(name)) {
        value[name] = data.getAll(name).map(String);
      } else if (controls.every(control => control.type === 'checkbox')) {
        value[name] = controls.length === 1 ? controls[0].checked : data.getAll(name).map(String);
      } else {
        value[name] = data.get(name) ?? '';
      }
    });
    const first = String(value.firstName || '').trim();
    const middle = String(value.middleName || '').trim();
    const last = String(value.lastName || '').trim();
    // Store the display value in the same Last, First Middle format used in Soro Ops.
    value.fullName = last && first ? `${last}, ${first}${middle ? ` ${middle}` : ''}` : '';
    value.selfReportedSkills = selectedSkillIds().map(id => skillLabels.get(id)).filter(Boolean);
    value.expectedRateText = updateExpectedRatePreview();
    // Keep the existing profile field populated while the more structured range is adopted.
    value.expectedRate = value.expectedRateText;
    ['confirmAccurate', 'confirmPrivacy', 'confirmContact'].forEach(key => { if (form.elements[key]) value[key] = form.elements[key].checked; });
    return value;
  };
  const call = async (action, body = {}) => {
    const response = await fetch('/.netlify/functions/talent-application', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, resumeToken: state.resumeToken, ...body }) });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.error || 'We could not complete that request. Please try again.');
    return json;
  };
  const updateStepNavigation = () => {
    stepLinks.forEach((item, index) => {
      const number = index + 1;
      const control = item.querySelector('button') || item;
      const isCurrent = number === state.step;
      const canOpen = reviewMode || number <= state.maxVisitedStep;
      item.classList.toggle('is-active', isCurrent);
      item.classList.toggle('is-complete', number < state.step);
      item.classList.toggle('is-visited', number <= state.maxVisitedStep);
      if (isCurrent) control.setAttribute('aria-current', 'step'); else control.removeAttribute('aria-current');
      control.disabled = !canOpen;
      control.setAttribute('aria-disabled', String(!canOpen));
      control.tabIndex = canOpen ? 0 : -1;
    });
  };
  const showStep = (number, { focusHeading = true } = {}) => {
    state.step = Math.max(1, Math.min(steps.length, number));
    state.maxVisitedStep = Math.max(state.maxVisitedStep, state.step);
    steps.forEach(section => section.classList.toggle('is-active', Number(section.dataset.step) === number));
    updateStepNavigation();
    previous.hidden = state.step === 1;
    next.hidden = state.step === steps.length;
    submit.hidden = state.step !== steps.length;
    message('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (focusHeading) {
      const heading = steps[state.step - 1]?.querySelector('.step-heading h2');
      if (heading) {
        heading.tabIndex = -1;
        requestAnimationFrame(() => heading.focus({ preventScroll: true }));
      }
    }
  };
  stepLinks.forEach((item, index) => {
    const control = item.querySelector('button') || item;
    control.addEventListener('click', () => {
      const number = index + 1;
      if (reviewMode || number <= state.maxVisitedStep) showStep(number);
    });
  });
  updateStepNavigation();
  const visibleFieldsValid = () => {
    const current = steps[state.step - 1];
    const fields = [...current.querySelectorAll('input, select, textarea')].filter(field => !field.disabled && field.type !== 'file' && field.type !== 'hidden' && field.name !== 'website');
    const invalid = fields.find(field => !field.checkValidity());
    if (invalid) { invalid.reportValidity(); return false; }
    if (state.step === 2 && (!validateExpectedRate() || !validateExperienceSkills())) return false;
    if (state.step === 3 && !reviewMode) {
  const directVideo = form.elements.introductionVideo.files.length || state.uploads.introduction_video;
  const loom = form.elements.loomVideoUrl.value.trim();
  const videoMethod = form.elements.videoMethod.value;
  if (videoMethod === 'device' && !directVideo) { message('Please choose your introduction video file before continuing.'); return false; }
  if (videoMethod === 'phone' && !directVideo) { message('Please save your draft and upload your video from the phone link before continuing.'); return false; }
  if (videoMethod === 'loom' && !loom) { message('Please paste the Loom share link before continuing.'); return false; }
      const required = ['resume', 'englishProof', 'discAssessment', 'enneagramAssessment', 'mbtiAssessment', 'internetProof', 'equipmentProof'];
      const missing = required.find(name => !form.elements[name].files.length && !state.uploads[document.querySelector(`[name="${name}"]`).dataset.document]);
      if (missing) { message('Please select every required application file before continuing.'); return false; }
    }
    return true;
  };
  const saveDraft = async (announce = true) => {
    if (form.elements.website.value) throw new Error('Unable to save this application.');
    if (localPreview) {
      const previewData = formData();
      try { sessionStorage.setItem(localDraftKey, JSON.stringify(previewData)); } catch (_) { /* Preview still works without storage. */ }
      state.resumeToken = state.resumeToken || 'local-preview';
      await renderPhoneUploadQr();
      if (announce) {
        confirmation.innerHTML = '<strong>Preview progress saved in this browser tab.</strong><br>This local review does not send applicant information or files to the live application service.';
        confirmation.hidden = false;
        confirmation.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      return { resumeToken: state.resumeToken, resumeUrl: location.href, preview: true };
    }
    const result = await call('save_draft', { data: formData() });
    state.resumeToken = result.resumeToken;
    if (history.replaceState) history.replaceState(null, '', `${location.pathname}?resume=${encodeURIComponent(result.resumeToken)}`);
    await renderPhoneUploadQr();
    if (announce) {
      confirmation.innerHTML = `<strong>Your progress is saved.</strong><br>Copy and keep this private return link: <a href="${result.resumeUrl}">${result.resumeUrl}</a>`;
      confirmation.hidden = false;
      confirmation.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    return result;
  };
const renderPhoneUploadQr = async () => {
  if (!state.resumeToken || !phoneUpload || !phoneUploadQr || !phoneUploadLink) return;
  if (form.elements.videoMethod?.value !== 'phone' && !mobileVideoMode) return;
    // A file:// preview cannot create a server-backed draft token that a phone can
    // reopen. Still show a deliberate preview state so the application layout is
    // reviewable instead of displaying a broken image.
    if (localPreview) {
      phoneUploadQr.src = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><rect width="200" height="200" fill="white"/><g fill="#0d3b70"><path d="M12 12h52v52H12zm12 12v28h28V24zM136 12h52v52h-52zm12 12v28h28V24zM12 136h52v52H12zm12 12v28h28v-28zM78 12h12v12H78zm18 0h12v12H96zm-18 18h12v12H78zm18 18h12v12H96zm18-18h12v12h-12zm-36 36h12v12H78zm18 0h12v12H96zm18 0h12v12h-12zm18 0h12v12h-12zm-54 18h12v12H60zm18 0h12v12H78zm36 0h12v12h-12zm18 0h12v12h-12zm-72 18h12v12H60zm36 0h12v12H96zm18 0h12v12h-12zm18 0h12v12h-12zm-54 18h12v12H60zm18 0h12v12H78zm18 0h12v12H96zm36 0h12v12h-12zm18 0h12v12h-12zm-54 18h12v12H78zm18 0h12v12H96zm36 0h12v12h-12z"/></g><text x="100" y="196" text-anchor="middle" font-family="Arial" font-size="8" fill="#5c7186">LOCAL PREVIEW</text></svg>`);
      phoneUploadLink.removeAttribute('href');
      phoneUploadLink.textContent = 'Secure link available after draft save';
      phoneUpload.hidden = false;
      return;
    }
    const phoneUrl = new URL(location.href);
    phoneUrl.searchParams.set('resume', state.resumeToken);
    phoneUrl.searchParams.set('mobileVideo', '1');
    phoneUploadLink.href = phoneUrl.toString();
    phoneUpload.hidden = false;
    if (!window.QRCode || typeof window.QRCode.toDataURL !== 'function') return;
    try {
      phoneUploadQr.src = await window.QRCode.toDataURL(phoneUrl.toString(), { width: 200, margin: 1, errorCorrectionLevel: 'M' });
    } catch (_) {
      phoneUpload.hidden = true;
    }
};

const updateVideoMethod = () => {
  const selected = videoMethodOptions.find((input) => input.checked)?.value || '';
  videoMethodPanels.forEach((panel) => {
    const isActive = panel.dataset.videoMethodPanel === selected;
    panel.hidden = !isActive;
    panel.setAttribute('aria-hidden', String(!isActive));
    panel.querySelectorAll('input, button, select, textarea').forEach((control) => {
      control.disabled = !isActive;
    });
  });
  videoMethodOptions.forEach((input) => {
    input.closest('.video-method')?.classList.toggle('is-selected', input.checked);
  });
  if (selected === 'phone') renderPhoneUploadQr();
  else if (phoneUpload) phoneUpload.hidden = true;
};

  const requireBrowserPlayableVideo = async file => {
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
      throw new Error('This video uses an older phone codec that Soro profiles cannot play. Convert it to an H.264 MP4 or WebM file, then choose the converted version.');
    }
  };

renderExperienceCatalog();
namedControls('experienceAreas').forEach(input => input.addEventListener('change', () => updateExperienceUI(input)));
namedControls('skillsByCategory').forEach(input => input.addEventListener('change', () => {
  namedControls('skillsByCategory').filter(skill => skill.dataset.category === input.dataset.category).forEach(skill => skill.setCustomValidity(''));
}));
form.elements.timezone?.addEventListener('change', updateConditionalFields);
form.elements.currentWorkStatus?.addEventListener('change', updateConditionalFields);
[form.elements.expectedRateMin, form.elements.expectedRateMax].filter(Boolean).forEach(input => input.addEventListener('input', () => {
  input.setCustomValidity('');
  updateExpectedRatePreview();
}));
videoMethodOptions.forEach((input) => input.addEventListener('change', updateVideoMethod));
updateExperienceUI();
updateConditionalFields();
updateExpectedRatePreview();
updateVideoMethod();
  const renderUploads = () => {
    const entries = Object.entries(state.uploads);
    uploadStatus.innerHTML = entries.length ? entries.map(([type, file]) => `<p>✓ ${file.fileName || file.filename || file.name || type} is saved for this application.</p>`).join('') : '';
  };
  const uploadFile = async input => {
    const documentType = input.dataset.document;
    const file = input.files[0];
    if (!file) return;
    if (documentType === 'introduction_video') await requireBrowserPlayableVideo(file);
    if (!state.resumeToken) await saveDraft(false);
    const prepared = await call('prepare_upload', { data: formData(), documentType, fileName: file.name, mimeType: file.type || 'application/octet-stream', size: file.size });
    state.resumeToken = prepared.resumeToken || state.resumeToken;
    const transfer = await fetch(prepared.signedUrl, { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-upsert': 'false' }, body: file });
    if (!transfer.ok) throw new Error(`Could not upload ${file.name}. Please choose the file again.`);
    const complete = await call('complete_upload', { documentType, storagePath: prepared.storagePath, fileName: file.name, mimeType: file.type || 'application/octet-stream', size: file.size });
    state.uploads[documentType] = (complete.uploads || []).find(item => item.documentType === documentType) || { fileName: file.name };
    renderUploads();
  };
  const uploadSelectedFiles = async () => {
    for (const input of form.querySelectorAll('input[type="file"]')) {
      if (input.files.length) await uploadFile(input);
    }
  };
  const loadDraft = async () => {
    if (!state.resumeToken && !localPreview) return;
    try {
      let result;
      if (localPreview) {
        let data = {};
        try { data = JSON.parse(sessionStorage.getItem(localDraftKey) || '{}'); } catch (_) { data = {}; }
        if (!Object.keys(data).length) return;
        result = { data, uploads: [] };
      } else {
        result = await call('load_draft');
      }
      Object.entries(result.data || {}).forEach(([name, value]) => {
        const controls = namedControls(name);
        if (!controls.length) return;
        const values = Array.isArray(value) ? value.map(String) : [String(value ?? '')];
        controls.forEach(field => {
          if (field.type === 'checkbox') {
            field.checked = Array.isArray(value) ? values.includes(field.value) : (typeof value === 'boolean' ? value : values.includes(field.value));
          } else if (field.type === 'radio') {
            field.checked = values.includes(field.value);
          } else if (field.tagName === 'SELECT' && typeof value === 'boolean' && [...field.options].some(option => option.value === 'yes')) {
            field.value = value ? 'yes' : 'no';
          } else {
            field.value = value ?? '';
          }
        });
      });
      state.uploads = Object.fromEntries((result.uploads || []).map(file => [file.documentType, file]));
      renderUploads();
      updateExperienceUI();
      updateConditionalFields();
      updateExpectedRatePreview();
      updateVideoMethod();
      confirmation.innerHTML = localPreview
        ? '<strong>Your local preview answers have been restored.</strong> Nothing has been sent to the live application service.'
        : '<strong>Your saved application has been restored.</strong> Previously uploaded files remain attached. You may replace a file by selecting a new version.';
      confirmation.hidden = false;
    } catch (error) { message('We could not restore that saved application link. You can start a new application below.'); }
  };

  next.addEventListener('click', async () => { if (!visibleFieldsValid()) return; try { setBusy(true); await saveDraft(false); showStep(Math.min(4, state.step + 1)); } catch (error) { message(error.message); } finally { setBusy(false); } });
  previous.addEventListener('click', () => showStep(Math.max(1, state.step - 1)));
  save.addEventListener('click', async () => { try { setBusy(true); await saveDraft(true); } catch (error) { message(error.message); } finally { setBusy(false); } });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!visibleFieldsValid()) return;
    try {
      setBusy(true, 'Uploading files…');
      if (reviewMode) {
        await saveDraft(false);
        message('Preview complete. No application data or files were sent.', 'success');
        return;
      }
      await saveDraft(false);
      await uploadSelectedFiles();
      submit.textContent = 'Submitting application…';
      const result = await call('submit', { data: formData() });
      message('');
      form.hidden = true;
      applicationShell.classList.add('is-submitted');
      confirmation.classList.add('is-submission-success');
      confirmation.innerHTML = `
        <div class="submission-success__icon" aria-hidden="true">✓</div>
        <p class="eyebrow">Application received</p>
        <h2>Thank you for taking this step with Soro.</h2>
        <p>Talent Management will review your complete application and contact you if there is a next step.</p>
        <p class="submission-success__email">${result.notifications?.applicantConfirmationSent
          ? 'A confirmation email is on its way to the address you provided.'
          : 'Your application is safely submitted. If you do not receive a confirmation email, you do not need to submit it again.'}</p>
        <div class="submission-success__actions">
          <a class="button button-primary" href="../">Return to the Soro Group website</a>
        </div>`;
      confirmation.hidden = false;
      confirmation.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (error) { message(error.message); } finally { setBusy(false); }
  });
  form.querySelectorAll('input[type="file"]').forEach(input => input.addEventListener('change', async () => {
    if (!input.files[0]) return;
    const picker = input.closest('.upload-field')?.querySelector(`label[for="${input.id}"]`);
    if (input.dataset.document === 'introduction_video') {
      try { await requireBrowserPlayableVideo(input.files[0]); }
      catch (error) {
        input.value = '';
        if (picker) picker.textContent = 'Choose video file';
        message(error.message);
        return;
      }
    }
    if (picker) picker.textContent = input.files[0].name;
  }));
  phoneUploadButton?.addEventListener('click', async () => {
    try {
      phoneUploadButton.disabled = true;
      phoneUploadButton.textContent = localPreview ? 'Showing QR preview…' : 'Creating secure QR…';
      if (localPreview) {
        state.resumeToken = state.resumeToken || 'local-preview';
        await renderPhoneUploadQr();
        message('QR preview shown. On the live application, Save & continue later creates the secure phone-upload link.', 'success');
        return;
      }
      await saveDraft(false);
    } catch (error) {
      message(error.message);
    } finally {
      phoneUploadButton.disabled = false;
    phoneUploadButton.textContent = 'Save draft & show phone QR';
    }
  });
loadDraft().finally(() => {
  if (mobileVideoMode) showStep(3);
  updateExperienceUI();
  updateConditionalFields();
  updateExpectedRatePreview();
  updateVideoMethod();
});
})();
