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
  const state = { step: 1, resumeToken: new URLSearchParams(location.search).get('resume') || new URLSearchParams(location.hash.slice(1)).get('resume'), uploads: {}, uploadIds: {} };
  const mobileVideoMode = new URLSearchParams(location.search).has('mobileVideo');
  // Local file previews (and an explicit ?review=1 link) let Soro review layout freely.
  // The deployed applicant experience remains a guided, validated step-by-step flow.
  const reviewMode = location.protocol === 'file:' || new URLSearchParams(location.search).has('review');
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
  const formData = () => {
    const value = Object.fromEntries([...new FormData(form).entries()].filter(([, value]) => !(value instanceof File)));
    const first = String(value.firstName || '').trim();
    const middle = String(value.middleName || '').trim();
    const last = String(value.lastName || '').trim();
    // Store the display value in the same Last, First Middle format used in Soro Ops.
    value.fullName = last && first ? `${last}, ${first}${middle ? ` ${middle}` : ''}` : '';
    ['confirmAccurate', 'confirmPrivacy', 'confirmContact'].forEach(key => { value[key] = form.elements[key].checked; });
    return value;
  };
  const call = async (action, body = {}) => {
    const response = await fetch('/.netlify/functions/talent-application', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, resumeToken: state.resumeToken, ...body }) });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.error || 'We could not complete that request. Please try again.');
    return json;
  };
  const showStep = number => {
    state.step = number;
    steps.forEach(section => section.classList.toggle('is-active', Number(section.dataset.step) === number));
    stepLinks.forEach((item, index) => item.classList.toggle('is-active', index + 1 === number));
    previous.hidden = number === 1;
    next.hidden = number === 4;
    submit.hidden = number !== 4;
    message('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  if (reviewMode) {
    stepLinks.forEach((item, index) => {
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      item.setAttribute('aria-label', `Preview step ${index + 1}`);
      const openStep = () => showStep(index + 1);
      item.addEventListener('click', openStep);
      item.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openStep();
        }
      });
    });
  }
  const visibleFieldsValid = () => {
    const current = steps[state.step - 1];
    const fields = [...current.querySelectorAll('input, select, textarea')].filter(field => field.type !== 'file' && field.type !== 'hidden' && field.name !== 'website');
    const invalid = fields.find(field => !field.checkValidity());
    if (invalid) { invalid.reportValidity(); return false; }
    if (state.step === 3) {
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
    if (location.protocol === 'file:') {
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

videoMethodOptions.forEach((input) => input.addEventListener('change', updateVideoMethod));
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
    if (!state.resumeToken) return;
    try {
      const result = await call('load_draft');
      Object.entries(result.data || {}).forEach(([name, value]) => {
        const field = form.elements[name];
        if (!field) return;
        if (field.type === 'checkbox') field.checked = Boolean(value); else field.value = value || '';
      });
      state.uploads = Object.fromEntries((result.uploads || []).map(file => [file.documentType, file]));
      renderUploads();
      confirmation.innerHTML = '<strong>Your saved application has been restored.</strong> Previously uploaded files remain attached. You may replace a file by selecting a new version.';
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
      phoneUploadButton.textContent = location.protocol === 'file:' ? 'Showing QR preview…' : 'Creating secure QR…';
      if (location.protocol === 'file:') {
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
  updateVideoMethod();
});
})();
