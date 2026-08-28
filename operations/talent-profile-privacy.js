/* Private location details and writing assistance for Talent profiles. */
(function () {
  const originalProfilePage = profilePage;
  const originalRender = render;
  const originalLoadLiveApplicants = loadLiveApplicants;
  const originalClassifyDocument = classifyDocument;

  function authenticatedRole() {
    return String(window.soroCurrentAccess?.role || '').toLowerCase();
  }

  function canViewPrivateLocation(applicant) {
    const accessRole = authenticatedRole();
    if (accessRole === 'admin' || accessRole === 'talent_management') return true;
    return accessRole === 'virtual_assistant'
      && Boolean(applicant?.auth_user_id)
      && applicant.auth_user_id === window.soroCurrentAccess?.user_id;
  }

  function addressLines(applicant) {
    const street = [applicant.address_line_1, applicant.address_line_2].filter(Boolean).join(', ');
    const locality = [applicant.city, applicant.province_region, applicant.postal_code].filter(Boolean).join(', ');
    return [street, locality, applicant.country || 'Philippines'].filter(Boolean);
  }

  function privateAddressMarkup(applicant) {
    if (!canViewPrivateLocation(applicant)) return '';
    const lines = addressLines(applicant);
    const hasStreetAddress = Boolean(applicant.address_line_1 || applicant.address_line_2 || applicant.city || applicant.province_region);
    const recordedTimeZone = typeof window.recordedTalentTimeZone === 'function'
      ? window.recordedTalentTimeZone(applicant)
      : applicant.timezone || 'Asia/Manila';
    const timeZone = typeof window.formatTalentTimeZone === 'function'
      ? window.formatTalentTimeZone(recordedTimeZone || 'Asia/Manila')
      : recordedTimeZone || 'Asia/Manila';
    return `<aside class="profile-private-address" aria-label="Private address and location"><div class="private-address-heading"><span class="private-address-lock" aria-hidden="true">⌖</span><span>Private — Soro &amp; Talent only</span></div><strong>Address &amp; location</strong>${hasStreetAddress ? `<p>${lines.map(escapeHtml).join('<br />')}</p>` : '<p class="muted">Address not recorded yet</p>'}<small>${escapeHtml(applicant.country || 'Philippines')} · ${escapeHtml(timeZone)}</small></aside>`;
  }

  function enableWritingAssistance(scope) {
    (scope || document).querySelectorAll('textarea, input[type="text"], input:not([type])').forEach(input => {
      input.spellcheck = true;
      input.setAttribute('autocapitalize', 'sentences');
    });
  }

  classifyDocument = function (document) {
    const fileName = `${document?.file_name || ''} ${document?.external_url || ''}`.toLowerCase();
    if (!document?.document_type || document.document_type === 'application_attachment') {
      if (/interview video|interview recording|company interview/.test(fileName)) return 'interview_video';
    }
    return originalClassifyDocument(document);
  };

  if (typeof documentLabels !== 'undefined') documentLabels.interview_video = 'Interview video';

  profilePage = function (applicant) {
    if (!applicant) return originalProfilePage(applicant);
    const timeZone = String(applicant.timezone || '').toLowerCase() === 'other' && applicant.timezone_other_detail
      ? applicant.timezone_other_detail
      : applicant.timezone || 'Asia/Manila';
    const preparedApplicant = {
      ...applicant,
      country: applicant.country || 'Philippines',
      location: applicant.location || applicant.country || 'Philippines',
      timezone: timeZone
    };
    return originalProfilePage(preparedApplicant).replace(
      '<div class="profile-actions">',
      `${privateAddressMarkup(preparedApplicant)}<div class="profile-actions">`
    );
  };

  render = function () {
    originalRender();
    enableWritingAssistance(document);
  };

  document.addEventListener('focusin', event => enableWritingAssistance(event.target.closest('form, dialog') || document));

  // Selecting all columns keeps this preview compatible before and after the
  // private-address migration is applied to Supabase.
  loadLiveApplicants = async function () {
    if (typeof viewAllowedForAuthenticatedRole === 'function' && !viewAllowedForAuthenticatedRole('vas')) {
      liveApplicants = [];
      return;
    }
    if (!window.soroSupabase) return originalLoadLiveApplicants();
    const { data: applicants, error } = await window.soroSupabase
      .from('applicants')
      .select('*')
      .order('application_received_at', { ascending: false });
    if (error) return originalLoadLiveApplicants();
    liveApplicants = applicants || [];
    if (current === 'vas' || current === 'talent-profile') render();
  };
})();
