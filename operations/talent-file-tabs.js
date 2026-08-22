/* Folder-style Talent profile tabs and live placement context. */
(function () {
  const originalProfilePage = profilePage;
  const originalLoadTalentProfileDocuments = loadTalentProfileDocuments;
  const benefitsRoles = new Set(['admin', 'talent', 'talent_management']);
  const payRoles = new Set(['admin', 'billing', 'talent', 'talent_management']);
  let activeTab = 'profile';
  let lastTalentId = null;
  let contextRequest = 0;

  function canViewBenefits() {
    return benefitsRoles.has(String(typeof role === 'undefined' ? '' : role).toLowerCase());
  }

  function canViewPay() {
    return payRoles.has(String(typeof role === 'undefined' ? '' : role).toLowerCase());
  }

  function tabButton(name, label, extra = '') {
    return `<button class="talent-file-tab" type="button" role="tab" id="talent-file-tab-${name}" aria-controls="talent-file-panel-${name}" aria-selected="false" tabindex="-1" data-talent-file-tab="${name}">${label}${extra}</button>`;
  }

  function panel(name, content, className = '') {
    return `<section class="talent-file-panel ${className}" id="talent-file-panel-${name}" role="tabpanel" aria-labelledby="talent-file-tab-${name}" data-talent-file-panel="${name}" hidden>${content}</section>`;
  }

  function benefitsPanel(applicant) {
    const active = String(applicant.status || '').toLowerCase() === 'active';
    return `<div class="talent-tab-heading"><div><p class="eyebrow">Protected Growth &amp; Support</p><h2>Benefits</h2><p>Restricted benefit administration and support information for authorized Soro team members.</p></div><span class="restricted-chip" aria-label="Restricted access">▣ Restricted</span></div><div class="talent-tab-summary"><article><span>Current status</span><strong>${active ? 'Eligibility review needed' : 'Not active yet'}</strong><small>${active ? 'Confirm the applicable program and effective date.' : 'Benefit administration begins only after the applicable active-placement requirements are confirmed.'}</small></article><article><span>Benefit credits</span><strong>Not configured</strong><small>No credit balance or earning rule has been approved for this Talent.</small></article><article><span>Next review</span><strong>Not scheduled</strong><small>The next Growth &amp; Support review will appear here when scheduled.</small></article></div><div class="talent-tab-empty"><span aria-hidden="true">＋</span><div><strong>No benefit records yet</strong><p>Enrollment, eligibility, approved support, and auditable benefit-credit activity will appear here without exposing clinical or provider records.</p></div></div>`;
  }

  function attendancePanel() {
    return `<div class="talent-tab-heading"><div><p class="eyebrow">Workday record</p><h2>Attendance</h2><p>Scheduled work, Start Day activity, check-outs, and exceptions for this Talent.</p></div></div><div class="talent-tab-summary"><article><span>Current assignment</span><strong id="attendance-assignment">Not assigned</strong><small id="attendance-schedule">A client schedule will appear after placement.</small></article><article><span>Recorded workdays</span><strong id="attendance-workdays">0</strong><small>Current calendar month</small></article><article><span>Exceptions</span><strong id="attendance-exceptions">0</strong><small>Late or missed check-ins recorded this month</small></article></div><div id="attendance-records" class="talent-tab-empty"><span aria-hidden="true">◷</span><div><strong>No attendance records yet</strong><p>Start Day, check-out, late, and missed check-in records will be listed here when activity is recorded.</p></div></div>`;
  }

  function formatDate(value) {
    if (!value) return 'Not recorded';
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
    const date = dateOnly
      ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
      : new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString();
  }

  function formatRate(value, rateType) {
    if (value === null || value === undefined || value === '') return 'Not recorded';
    const number = Number(value);
    const formatted = Number.isFinite(number) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(number) : String(value);
    return `${formatted}${rateType ? ` · ${titleCase(rateType)}` : ''}`;
  }

  function clientPanel(placement) {
    const client = placement.clients || {};
    const pay = canViewPay() ? formatRate(placement.virtual_assistant_rate, placement.rate_type) : 'Restricted';
    return `<div class="talent-tab-heading"><div><p class="eyebrow">Current client assignment</p><h2>${escapeHtml(client.company_name || 'Assigned client')}</h2><p>${escapeHtml(client.industry || 'Industry not recorded')} · ${escapeHtml(titleCase(placement.status || client.lifecycle_stage || 'assigned'))}</p></div><span class="tag">${escapeHtml(titleCase(placement.status || 'Assigned'))}</span></div><div class="talent-tab-summary"><article><span>Placement start</span><strong>${escapeHtml(formatDate(placement.start_date))}</strong><small>${placement.end_date ? `Ended ${escapeHtml(formatDate(placement.end_date))}` : 'Current or upcoming placement'}</small></article><article><span>Schedule</span><strong>${escapeHtml(placement.schedule_summary || 'Not recorded')}</strong><small>Confirmed placement schedule</small></article><article><span>Current Talent pay</span><strong>${escapeHtml(pay)}</strong><small>${canViewPay() ? 'Placement pay configuration' : 'Available only to authorized pay roles'}</small></article></div><div class="client-work-grid"><section><div class="panel-head"><div><p class="eyebrow">Client notes</p><h3>Placement notes</h3></div></div><div class="talent-tab-empty compact"><span aria-hidden="true">≡</span><div><strong>No client notes added</strong><p>Authorized client and placement notes will appear here.</p></div></div></section><section><div class="panel-head"><div><p class="eyebrow">Open work</p><h3>Tasks</h3></div></div><div class="talent-tab-empty compact"><span aria-hidden="true">✓</span><div><strong>No placement tasks recorded</strong><p>Tasks related to this client assignment will appear here.</p></div></div></section></div>`;
  }

  function activateTab(name, scope = document) {
    const shell = scope.querySelector?.('.talent-file-shell') || document.querySelector('.talent-file-shell');
    if (!shell) return;
    const requested = shell.querySelector(`[data-talent-file-tab="${name}"]`) ? name : 'profile';
    activeTab = requested;
    shell.querySelectorAll('[data-talent-file-tab]').forEach(button => {
      const selected = button.dataset.talentFileTab === requested;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    shell.querySelectorAll('[data-talent-file-panel]').forEach(tabPanel => {
      tabPanel.hidden = tabPanel.dataset.talentFilePanel !== requested;
    });
  }

  profilePage = function (applicant) {
    const markup = originalProfilePage(applicant);
    if (!applicant) return markup;
    lastTalentId = applicant.id;
    activeTab = 'profile';

    const template = document.createElement('template');
    template.innerHTML = markup.trim();
    const main = template.content.querySelector('.talent-profile-page');
    const hero = main?.querySelector('.talent-profile-hero');
    const stats = main?.querySelector('.profile-stat-grid');
    const layout = main?.querySelector('.profile-layout');
    const screening = main?.querySelector('.profile-screening');
    const documents = layout?.querySelector('.profile-documents-section');
    if (!main || !hero || !stats || !layout || !documents) return markup;

    const identity = hero.querySelector('.profile-identity');
    const address = hero.querySelector('.profile-private-address');
    const contact = identity?.querySelector(':scope > p:not(.eyebrow)');
    if (identity && address) contact ? contact.insertAdjacentElement('afterend', address) : identity.append(address);

    documents.remove();
    layout.classList.add('talent-profile-home-layout');
    const benefitsAvailable = canViewBenefits();
    if (!benefitsAvailable && activeTab === 'benefits') activeTab = 'profile';

    const shell = document.createElement('section');
    shell.className = 'talent-file-shell';
    shell.innerHTML = `<div class="talent-file-tabs" role="tablist" aria-label="Talent file sections">${tabButton('profile', 'Profile')}${benefitsAvailable ? tabButton('benefits', 'Benefits', '<span class="tab-lock" aria-hidden="true"></span>') : ''}${tabButton('attendance', 'Attendance')}${tabButton('documents', 'Documents')}</div><div class="talent-file-body"></div><div class="talent-file-panels">${panel('profile', '', 'talent-file-profile-panel')}${benefitsAvailable ? panel('benefits', benefitsPanel(applicant)) : ''}${panel('attendance', attendancePanel())}${panel('documents', '', 'talent-file-documents-panel')}</div>`;

    const firstDialog = main.querySelector('dialog');
    main.insertBefore(shell, hero);
    const body = shell.querySelector('.talent-file-body');
    const panels = shell.querySelector('.talent-file-panels');
    body.append(hero);
    const profilePanel = shell.querySelector('[data-talent-file-panel="profile"]');
    profilePanel.append(stats, layout);
    if (screening) profilePanel.append(screening);
    const dangerZone = document.createElement('section');
    dangerZone.className = 'talent-profile-danger-zone';
    dangerZone.hidden = true;
    dangerZone.innerHTML = '<div><p class="eyebrow">Administrator record controls</p><h2>Danger zone</h2><p>Permanent deletion is intentionally separated from everyday profile actions.</p></div><div class="talent-profile-danger-actions admin-record-actions"></div>';
    profilePanel.append(dangerZone);
    shell.querySelector('[data-talent-file-panel="documents"]').append(documents);
    if (firstDialog && firstDialog.parentElement !== main) main.append(firstDialog);
    activateTab(activeTab, shell);
    return template.innerHTML;
  };

  async function loadAttendance(applicant, placement, request) {
    const recordsTarget = document.getElementById('attendance-records');
    if (!recordsTarget || !window.soroSupabase) return;
    const { data, error } = await window.soroSupabase
      .from('audit_events')
      .select('event_type,note,created_at')
      .eq('entity_id', applicant.id)
      .in('event_type', ['start_day', 'check_out', 'attendance_status', 'late_check_in', 'missed_check_in'])
      .order('created_at', { ascending: false })
      .limit(60);
    if (request !== contextRequest || selectedTalentId !== applicant.id) return;

    const assignment = document.getElementById('attendance-assignment');
    const schedule = document.getElementById('attendance-schedule');
    if (placement) {
      if (assignment) assignment.textContent = placement.clients?.company_name || 'Assigned client';
      if (schedule) schedule.textContent = placement.schedule_summary || 'Schedule not recorded yet.';
    }
    if (error || !data?.length) return;

    const now = new Date();
    const currentMonth = data.filter(item => {
      const date = new Date(item.created_at);
      return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
    });
    const days = new Set(currentMonth.filter(item => item.event_type === 'start_day').map(item => new Date(item.created_at).toDateString())).size;
    const exceptions = currentMonth.filter(item => ['late_check_in', 'missed_check_in'].includes(item.event_type)).length;
    const workdays = document.getElementById('attendance-workdays');
    const exceptionCount = document.getElementById('attendance-exceptions');
    if (workdays) workdays.textContent = String(days);
    if (exceptionCount) exceptionCount.textContent = String(exceptions);
    recordsTarget.className = 'attendance-table-wrap';
    recordsTarget.innerHTML = `<table class="attendance-table"><thead><tr><th>Date</th><th>Record</th><th>Note</th></tr></thead><tbody>${data.map(item => `<tr><td>${escapeHtml(formatDate(item.created_at))}</td><td>${escapeHtml(titleCase(item.event_type))}</td><td>${escapeHtml(item.note || 'No note')}</td></tr>`).join('')}</tbody></table>`;
  }

  async function loadTalentFileContext(applicant) {
    if (!applicant || !window.soroSupabase) return;
    const request = ++contextRequest;
    const includePay = canViewPay();
    const placementFields = `id,client_id,status,start_date,end_date,schedule_summary,rate_type${includePay ? ',virtual_assistant_rate' : ''},clients(id,company_name,industry,lifecycle_stage)`;
    const { data, error } = await window.soroSupabase
      .from('placements')
      .select(placementFields)
      .eq('applicant_id', applicant.id)
      .order('start_date', { ascending: false, nullsFirst: false });
    if (request !== contextRequest || selectedTalentId !== applicant.id) return;

    const placements = error ? [] : (data || []);
    const placement = placements.find(item => !item.end_date && !['ended', 'cancelled', 'inactive'].includes(String(item.status || '').toLowerCase())) || placements[0] || null;
    const shell = document.querySelector('.talent-file-shell');
    const documentsTab = shell?.querySelector('[data-talent-file-tab="documents"]');
    const documentsPanel = shell?.querySelector('[data-talent-file-panel="documents"]');
    if (placement && shell && documentsTab && documentsPanel && !shell.querySelector('[data-talent-file-tab="client"]')) {
      documentsTab.insertAdjacentHTML('beforebegin', tabButton('client', 'Client'));
      documentsPanel.insertAdjacentHTML('beforebegin', panel('client', clientPanel(placement)));
      activateTab(activeTab, shell);
    }

    await loadAttendance(applicant, placement, request);
  }

  loadTalentProfileDocuments = async function () {
    await originalLoadTalentProfileDocuments();
    const applicant = liveApplicants.find(item => item.id === selectedTalentId);
    await loadTalentFileContext(applicant);
  };

  document.addEventListener('click', event => {
    const button = event.target.closest('[data-talent-file-tab]');
    if (!button) return;
    activateTab(button.dataset.talentFileTab);
  });

  document.addEventListener('keydown', event => {
    const button = event.target.closest('[data-talent-file-tab]');
    if (!button || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...button.closest('[role="tablist"]').querySelectorAll('[data-talent-file-tab]')];
    const index = tabs.indexOf(button);
    const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[tabs.length - 1] : tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    event.preventDefault();
    activateTab(next.dataset.talentFileTab);
    next.focus();
  });
})();
