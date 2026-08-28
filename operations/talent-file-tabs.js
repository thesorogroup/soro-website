/* Folder-style Talent profile tabs and live placement context. */
(function () {
  const originalProfilePage = profilePage;
  const originalLoadTalentProfileDocuments = loadTalentProfileDocuments;
  const benefitsRoles = new Set(['admin', 'talent_management']);
  const payRoles = new Set(['admin', 'billing', 'talent_management']);
  let activeTab = 'profile';
  let lastTalentId = null;
  let contextRequest = 0;
  let folderHeightObserver = null;
  let folderHeightFallback = null;

  function canViewBenefits() {
    return benefitsRoles.has(String(window.soroCurrentAccess?.role || '').toLowerCase());
  }

  function canViewPay() {
    return payRoles.has(String(window.soroCurrentAccess?.role || '').toLowerCase());
  }

  function tabButton(name, label, extra = '') {
    return `<button class="talent-file-tab" type="button" role="tab" id="talent-file-tab-${name}" aria-controls="talent-file-panel-${name}" aria-selected="false" tabindex="-1" data-talent-file-tab="${name}">${label}${extra}</button>`;
  }

  function cleanCoordinate(value) {
    return Number(value.toFixed(3));
  }

  function tabGeometry(index, count) {
    const width = 1240 / count;
    const x = cleanCoordinate(index * width);
    const end = cleanCoordinate((index + 1) * width);
    const last = index === count - 1;
    const shoulderTop = cleanCoordinate(end - (last ? 32 : 22));
    const shoulderControl = cleanCoordinate(end - (last ? 19 : 9));
    const shoulderTurn = cleanCoordinate(end - (last ? 12 : 2));
    const shoulderEnd = cleanCoordinate(end + (last ? 0 : 14));
    const fill = `M${x} 60V34Q${x} 18 ${cleanCoordinate(x + 15)} 12Q${cleanCoordinate(x + 19)} 10 ${cleanCoordinate(x + 26)} 10H${shoulderTop}Q${shoulderControl} 10 ${shoulderTurn} 22L${shoulderEnd} 43V60Z`;
    const edge = `M${x} 58V34Q${x} 18 ${cleanCoordinate(x + 15)} 12Q${cleanCoordinate(x + 19)} 10 ${cleanCoordinate(x + 26)} 10H${shoulderTop}Q${shoulderControl} 10 ${shoulderTurn} 22L${shoulderEnd} 43V58`;
    return { x, fill, edge };
  }

  function inactiveTabPaths(count) {
    return Array.from({ length: count }, (_, index) => index)
      .reverse()
      .map(index => `<path d="${tabGeometry(index, count).fill}"/>`)
      .join('');
  }

  function folderArtwork(tabCount = 4) {
    const first = tabGeometry(0, tabCount);
    return `<svg class="talent-folder-art" viewBox="0 0 1240 434" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="talent-tab-paper" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbf0da"/><stop offset="1" stop-color="#f6e9ce"/></linearGradient><linearGradient id="talent-folder-paper" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fffdf8"/><stop offset=".48" stop-color="#fffaf0"/><stop offset="1" stop-color="#fff8ec"/></linearGradient><pattern id="talent-paper-grain" width="10" height="10" patternUnits="userSpaceOnUse"><circle cx="2" cy="3" r=".45" fill="#9a7d50" opacity=".09"/><circle cx="8" cy="7" r=".35" fill="#9a7d50" opacity=".07"/></pattern><filter id="talent-folder-shadow" x="-10%" y="-10%" width="120%" height="140%"><feDropShadow dx="0" dy="13" stdDeviation="15" flood-color="#273746" flood-opacity=".08"/></filter></defs><g class="talent-folder-inactive-tabs">${inactiveTabPaths(tabCount)}</g><path class="talent-folder-shadow" d="M0 58H1240V415Q1240 432 1223 432H17Q0 432 0 415Z"/><path class="talent-folder-paper" d="M0 58H1240V415Q1240 432 1223 432H17Q0 432 0 415Z"/><path class="talent-folder-grain" d="M0 58H1240V415Q1240 432 1223 432H17Q0 432 0 415Z" fill="url(#talent-paper-grain)" opacity=".7"/><path class="talent-folder-front-lip" d="M0 58H1240V85H0Z"/><path class="talent-folder-outer-edge" d="M0 58V415Q0 432 17 432H1223Q1240 432 1240 415V58"/><path class="talent-folder-top-transition" d="M0 58H1240"/><path class="talent-folder-front-seam" d="M0 85H1240"/><g class="talent-folder-active-tab"><path class="talent-folder-active-fill" d="${first.fill}"/><path class="talent-folder-active-edge" d="${first.edge}"/></g></svg>`;
  }

  function paperclipArtwork() {
    return `<svg class="talent-paperclip" viewBox="0 0 48 110" aria-hidden="true"><path class="talent-paperclip-wire" d="M31 13.5C31 2.5 8 2.5 8 22v70c0 15 23 15 23 0V28c0-9-12-9-12 0v63"/><path class="talent-paperclip-divider" d="M29 15H48"/></svg>`;
  }

  function panel(name, content, className = '') {
    return `<section class="talent-file-panel ${className}" id="talent-file-panel-${name}" role="tabpanel" aria-labelledby="talent-file-tab-${name}" data-talent-file-panel="${name}" hidden>${content}</section>`;
  }

  function syncFolderArt(shell) {
    if (!shell) return;
    const tabs = [...shell.querySelectorAll('[data-talent-file-tab]')];
    const count = Math.max(tabs.length, 1);
    shell.style.setProperty('--folder-tab-count', count);
    const inactive = shell.querySelector('.talent-folder-inactive-tabs');
    if (inactive) inactive.innerHTML = inactiveTabPaths(count);
  }

  function syncFolderHeight(shell) {
    const body = shell?.querySelector('.talent-file-body');
    const art = shell?.querySelector('.talent-folder-art');
    if (!body || !art) return;

    const bodyHeight = Math.max(374, Math.ceil(body.getBoundingClientRect().height));
    const bottom = 58 + bodyHeight;
    const curveStart = bottom - 17;
    const viewBoxHeight = bottom + 2;
    const bodyPath = `M0 58H1240V${curveStart}Q1240 ${bottom} 1223 ${bottom}H17Q0 ${bottom} 0 ${curveStart}Z`;
    const edgePath = `M0 58V${curveStart}Q0 ${bottom} 17 ${bottom}H1223Q1240 ${bottom} 1240 ${curveStart}V58`;

    art.setAttribute('viewBox', `0 0 1240 ${viewBoxHeight}`);
    art.style.height = `${viewBoxHeight + 8}px`;
    art.querySelector('.talent-folder-shadow')?.setAttribute('d', bodyPath);
    art.querySelector('.talent-folder-paper')?.setAttribute('d', bodyPath);
    art.querySelector('.talent-folder-grain')?.setAttribute('d', bodyPath);
    art.querySelector('.talent-folder-outer-edge')?.setAttribute('d', edgePath);
  }

  function watchFolderHeight(shell) {
    if (!shell) return;
    folderHeightObserver?.disconnect();
    if (folderHeightFallback) window.removeEventListener('resize', folderHeightFallback);
    syncFolderHeight(shell);

    if (typeof ResizeObserver === 'function') {
      folderHeightObserver = new ResizeObserver(() => syncFolderHeight(shell));
      folderHeightObserver.observe(shell.querySelector('.talent-file-body'));
      return;
    }

    folderHeightFallback = () => syncFolderHeight(shell);
    window.addEventListener('resize', folderHeightFallback);
  }

  function scheduleFolderHeightSync() {
    const run = () => watchFolderHeight(document.querySelector('.talent-file-shell'));
    if (typeof queueMicrotask === 'function') queueMicrotask(run);
    else setTimeout(run, 0);
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
    const shell = scope.matches?.('.talent-file-shell')
      ? scope
      : scope.querySelector?.('.talent-file-shell') || document.querySelector('.talent-file-shell');
    if (!shell) return;
    const tabs = [...shell.querySelectorAll('[data-talent-file-tab]')];
    const requested = shell.querySelector(`[data-talent-file-tab="${name}"]`) ? name : 'profile';
    activeTab = requested;
    tabs.forEach(button => {
      const selected = button.dataset.talentFileTab === requested;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    shell.querySelectorAll('[data-talent-file-panel]').forEach(tabPanel => {
      tabPanel.hidden = tabPanel.dataset.talentFilePanel !== requested;
    });
    syncFolderArt(shell);
    const index = Math.max(tabs.findIndex(button => button.dataset.talentFileTab === requested), 0);
    const geometry = tabGeometry(index, Math.max(tabs.length, 1));
    const activeArtwork = shell.querySelector('.talent-folder-active-tab');
    const fillPath = shell.querySelector('.talent-folder-active-fill');
    const edgePath = shell.querySelector('.talent-folder-active-edge');
    activeArtwork?.removeAttribute('transform');
    fillPath?.setAttribute('d', geometry.fill);
    edgePath?.setAttribute('d', geometry.edge);
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
    const details = layout?.querySelector('.profile-details-section');
    const documents = layout?.querySelector('.profile-documents-section');
    if (!main || !hero || !stats || !layout || !details || !documents) return markup;

    const identity = hero.querySelector('.profile-identity');
    const address = hero.querySelector('.profile-private-address');
    const contact = identity?.querySelector(':scope > p:not(.eyebrow)');
    if (identity && address) contact ? contact.insertAdjacentElement('afterend', address) : identity.append(address);

    documents.remove();
    layout.classList.add('talent-profile-home-layout');
    const summaryColumn = document.createElement('div');
    summaryColumn.className = 'profile-summary-column';
    details.insertAdjacentElement('beforebegin', summaryColumn);
    summaryColumn.append(details);
    if (screening) summaryColumn.append(screening);
    const benefitsAvailable = canViewBenefits();
    if (!benefitsAvailable && activeTab === 'benefits') activeTab = 'profile';

    const shell = document.createElement('section');
    shell.className = 'talent-file-shell';
    const initialTabCount = benefitsAvailable ? 4 : 3;
    shell.innerHTML = `${folderArtwork(initialTabCount)}<div class="talent-file-tabs" role="tablist" aria-label="Talent file sections">${tabButton('profile', 'Profile')}${benefitsAvailable ? tabButton('benefits', 'Benefits', '<span class="tab-lock" aria-hidden="true"></span>') : ''}${tabButton('attendance', 'Attendance')}${tabButton('documents', 'Documents')}</div><div class="talent-file-body"></div><div class="talent-file-panels">${panel('profile', '', 'talent-file-profile-panel')}${benefitsAvailable ? panel('benefits', benefitsPanel(applicant)) : ''}${panel('attendance', attendancePanel())}${panel('documents', '', 'talent-file-documents-panel')}</div>`;
    syncFolderArt(shell);

    const firstDialog = main.querySelector('dialog');
    main.insertBefore(shell, hero);
    const body = shell.querySelector('.talent-file-body');
    const panels = shell.querySelector('.talent-file-panels');
    body.append(hero);
    const headshot = hero.querySelector('.talent-headshot');
    if (headshot) headshot.insertAdjacentHTML('afterend', paperclipArtwork());
    const profilePanel = shell.querySelector('[data-talent-file-panel="profile"]');
    profilePanel.append(stats, layout);
    const dangerZone = document.createElement('section');
    dangerZone.className = 'talent-profile-danger-zone';
    dangerZone.hidden = true;
    dangerZone.innerHTML = '<div><p class="eyebrow">Administrator record controls</p><h2>Danger zone</h2><p>Permanent deletion is intentionally separated from everyday profile actions.</p></div><div class="talent-profile-danger-actions admin-record-actions"></div>';
    profilePanel.append(dangerZone);
    shell.querySelector('[data-talent-file-panel="documents"]').append(documents);
    if (firstDialog && firstDialog.parentElement !== main) main.append(firstDialog);
    activateTab(activeTab, shell);
    scheduleFolderHeightSync();
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
      syncFolderArt(shell);
      activateTab(activeTab, shell);
    }

    await loadAttendance(applicant, placement, request);
  }

  loadTalentProfileDocuments = async function () {
    await originalLoadTalentProfileDocuments();
    watchFolderHeight(document.querySelector('.talent-file-shell'));
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
