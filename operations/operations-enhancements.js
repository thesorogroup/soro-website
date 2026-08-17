/* Soro Ops interaction and profile detail improvements. */
(function () {

  const isExternalLink = value => /^https?:\/\//i.test(String(value || '').trim());
  const resultValue = (value, empty = 'Result not yet recorded') => escapeHtml(!value || isExternalLink(value) ? empty : value);
  const resultInputValue = value => escapeHtml(!value || isExternalLink(value) ? '' : value);

  profilePage = function (a) {
    if (!a) return `<main class="page"><button class="text-button back-to-directory">← Back to Talent Directory</button><section class="panel profile-missing"><h1>Talent profile not found</h1><p>This profile may have been removed or you may no longer have access.</p></section></main>`;
    const contact = [a.email, a.phone].filter(Boolean).join(' · ') || 'Contact information not recorded';
    return `<main class="page talent-profile-page"><button class="text-button back-to-directory">← Back to Talent Directory</button><section class="talent-profile-hero"><div class="headshot-wrap"><div class="talent-headshot" id="talent-headshot"><span>${escapeHtml(initials(a.full_name))}</span></div><label class="button headshot-upload">Upload headshot<input type="file" id="headshot-input" accept="image/jpeg,image/png,image/webp" hidden /></label><small>JPG, PNG, or WebP · up to 5 MB</small></div><div class="profile-identity"><p class="eyebrow">Talent profile</p><h1>${escapeHtml(a.full_name)}</h1><p>${escapeHtml(contact)}</p><div class="profile-tags"><span class="tag">${escapeHtml(titleCase(a.status))}</span><span class="tag neutral">${escapeHtml(titleCase(a.work_status))}</span></div></div><div class="profile-actions"><button class="button" id="profile-add-task">+ Add task</button></div></section><section class="profile-stat-grid"><article><p>Location & time zone</p><strong>${escapeHtml([a.location, a.timezone].filter(Boolean).join(' · ') || 'Not recorded')}</strong></article><article><p>Availability</p><strong>${escapeHtml(a.availability_note || a.dedicated_workspace || 'Availability to review')}</strong></article><article><p>Application received</p><strong>${a.application_received_at ? escapeHtml(new Date(a.application_received_at).toLocaleDateString()) : 'Not recorded'}</strong></article><article><p>Profile owner</p><strong>${a.talent_review_owner_id ? 'Assigned' : 'Unassigned'}</strong></article></section><div class="profile-layout"><section class="panel profile-section"><div class="panel-head"><div><p class="eyebrow">At a glance</p><h2>Profile details</h2></div></div><dl class="profile-details"><div><dt>Work status</dt><dd>${escapeHtml(titleCase(a.work_status))}</dd></div><div><dt>Expected rate</dt><dd>${escapeHtml(a.expected_hourly_rate_text || a.expected_hourly_rate || 'Not recorded')}</dd></div><div><dt>Dream / goal</dt><dd>${escapeHtml(a.greatest_dream || 'To be discussed in the Talent interview')}</dd></div></dl><div class="screening-heading"><h3 class="screening-title">Screening results</h3><button class="text-button" id="edit-screening-results">Record results</button></div><p class="eyebrow">These are verified review values, separate from the supporting private files.</p><dl class="screening-results"><div class="screening-result"><dt>English test result</dt><dd>${resultValue(a.english_test_result)}</dd></div><div class="screening-result"><dt>Personality profile / score</dt><dd>${resultValue(a.personality_profile_score)}</dd></div><div class="screening-result"><dt>Computer specs</dt><dd>${resultValue(a.computer_specs)}</dd></div><div class="screening-result"><dt>Internet speed</dt><dd>${resultValue(a.internet_speed)}</dd></div></dl></section><section class="panel profile-section profile-documents-section"><div class="panel-head"><div><p class="eyebrow">Private files</p><h2>Documents & assessments</h2></div><span class="tag">Secure</span></div><p class="eyebrow">Select a file to open its protected preview. Results are summarized at left for faster review.</p><div id="profile-documents"><p class="eyebrow">Loading documents…</p></div></section></div><dialog id="screening-results-dialog"><form id="screening-results-form" class="modal screening-results-modal"><div class="modal-title"><div><p class="eyebrow">Talent screening</p><h2>Record screening results</h2></div><button type="button" class="modal-close" aria-label="Close screening results">×</button></div><p class="eyebrow">Enter the verified result from the attached file. Supporting files remain private and unchanged.</p><label>English test result<input name="english_test_result" maxlength="240" value="${resultInputValue(a.english_test_result)}" placeholder="Example: CEFR B2 · 86%" /></label><label>Personality profile / score<input name="personality_profile_score" maxlength="240" value="${resultInputValue(a.personality_profile_score)}" placeholder="Example: Enneagram Type 3 · 86th percentile" /></label><label>Computer specs<input name="computer_specs" maxlength="300" value="${resultInputValue(a.computer_specs)}" placeholder="Example: Intel i5 · 16 GB RAM · Windows 11" /></label><label>Internet speed<input name="internet_speed" maxlength="240" value="${resultInputValue(a.internet_speed)}" placeholder="Example: 95 Mbps download · 48 Mbps upload" /></label><div class="modal-actions"><button class="button modal-cancel" type="button">Cancel</button><button class="button primary" type="submit">Save results</button></div><div id="screening-results-confirmation" aria-live="polite"></div></form></dialog></main>`;
  };

  function supportPage() {
    return `<main class="page support-page"><div class="page-heading"><div><p class="eyebrow">Soro Ops support</p><h1>Help & Support</h1><p class="eyebrow" style="margin-top:9px">Report a technical issue or ask for help using Soro Ops.</p></div></div><div class="support-grid"><section class="panel"><div class="panel-head"><div><p class="eyebrow">Technical support ticket</p><h2>Tell us what happened</h2></div></div><form id="help-ticket-form" class="support-form"><label>What do you need help with?<input name="subject" required maxlength="120" placeholder="Example: I cannot open a Talent document" /></label><label>Area<select name="area"><option>Sign-in and account access</option><option>Talent profiles and documents</option><option>Client records and placements</option><option>Tasks and notifications</option><option>Other technical issue</option></select></label><label>What happened?<textarea name="details" required placeholder="Include what you were trying to do, what you expected, and any message you saw."></textarea></label><small>Do not include passwords, payment details, or other sensitive information in a ticket.</small><button class="button primary" type="submit">Submit support ticket</button><div id="ticket-confirmation" aria-live="polite"></div></form></section><aside class="panel support-contact"><div><p class="eyebrow">Before submitting</p><h2>Quick checks</h2></div><article><h3>Document will not open?</h3><p>Allow pop-ups for Soro Ops, then select the file’s View button again.</p></article><article><h3>Can’t sign in?</h3><p>Use Forgot password on the sign-in screen. Admin and Talent Management can also send a secure reset link.</p></article><article><h3>Need an urgent workaround?</h3><p>Include the Talent or client name and the action that is blocked so the team can triage it quickly.</p></article></aside></div></main>`;
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
    const importAction = current === 'vas' && role === 'admin' ? `<button class="button" id="import-drive">Import Drive files</button>` : '';
    root.innerHTML = `<main class="page"><div class="page-heading"><div><p class="eyebrow">Soro Ops</p><h1>${d.title}</h1><p class="eyebrow" style="margin-top:9px">${d.caption}</p></div><div class="heading-actions"><button class="button primary" id="add-task">${primaryAction}</button>${current === 'overview' || current === 'clients' ? `<button class="button" id="new-record">+ ${newAction}</button>` : ''}${importAction}<button class="button">Customize</button></div></div>${current === 'overview' ? overview(d) : current === 'vas' ? talentDirectory() : table(d)}</main>`;
    bindView();
  };

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
    target.innerHTML = groups.size ? [...groups.entries()].map(([type, items]) => `<section class="document-group"><h3>${escapeHtml(documentLabels[type] || titleCase(type))}<span>${items.length}</span></h3>${items.map(d => `<article class="document-item"><span class="document-icon">${type === 'resume' ? '▤' : type === 'english_proof' ? 'A' : type === 'internet_proof' ? '⌁' : type === 'equipment_proof' ? '▣' : '◫'}</span><span><strong>${escapeHtml(d.file_name)}</strong><small>${escapeHtml(titleCase(d.status || 'uploaded'))} · ${d.created_at ? escapeHtml(new Date(d.created_at).toLocaleDateString()) : 'Date not recorded'}</small></span>${d.storage_path ? `<button class="text-button file-view-button open-private-document" data-storage-path="${escapeHtml(d.storage_path)}">View file</button>` : '<span class="file-pending">File pending</span>'}</article>`).join('')}</section>`).join('') : '<div class="documents-empty"><strong>No documents attached yet</strong><p>Imported application files and new uploads will appear here.</p></div>';
    target.querySelectorAll('.open-private-document').forEach(b => b.addEventListener('click', () => openPrivateDocument(b.dataset.storagePath)));
  };

  function bindScreeningResultsEditor() {
    const dialog = document.getElementById('screening-results-dialog');
    document.getElementById('edit-screening-results')?.addEventListener('click', () => dialog?.showModal());
    dialog?.querySelector('.modal-close')?.addEventListener('click', () => dialog.close('cancel'));
    dialog?.querySelector('.modal-cancel')?.addEventListener('click', () => dialog.close('cancel'));
    dialog?.addEventListener('click', event => { if (event.target === dialog) dialog.close('cancel'); });
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
