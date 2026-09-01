/* Administrator-only employee directory and account onboarding. */
(function () {
  'use strict';

  const EMPLOYEE_ROLE_LABELS = Object.freeze({
    admin: 'Administrator',
    talent_management: 'Talent Management',
    sales: 'Sales Associate'
  });
  const EMPLOYEE_ROLES = new Set(Object.keys(EMPLOYEE_ROLE_LABELS));
  const EMPLOYEE_PAYMENT_ROUTE_LABELS = Object.freeze({
    wise_contractor: 'Philippines contractor — Wise',
    quickbooks_employee: 'U.S. employee — QuickBooks',
    needs_setup: 'Needs setup'
  });
  const EMPLOYEE_PAYMENT_ROUTES = new Set(Object.keys(EMPLOYEE_PAYMENT_ROUTE_LABELS));
  const EMPLOYEE_ROLE_ACCESS = Object.freeze({
    admin: 'Broad day-to-day Soro Ops access, including employee administration, Talent operations, clients, placements, documents, and reports. The reserved System Owner account remains separate.',
    talent_management: 'Application review, screening, Talent profiles and private Talent documents, onboarding, verified skills, support, and placements. Employee administration is excluded.',
    sales: 'Clients, hiring requests, matching and placement workflow, assigned caseload, tasks, and Sales reports. Raw applications, private Talent files, benefits, and employee administration are excluded.'
  });
  const TEMPORARY_PASSWORD_TTL_HOURS = 72;
  const TEMPORARY_PASSWORD_TTL_MS = TEMPORARY_PASSWORD_TTL_HOURS * 60 * 60 * 1000;
  const originalRender = render;
  let employeeDialogSequence = 0;
  let employees = [];
  let loading = false;
  let loadError = '';
  let employeeSearch = '';

  function payrollReadinessApi() {
    return window.soroEmployeePayrollReadiness || null;
  }

  function payrollReadinessFilter() {
    return payrollReadinessApi()?.filterState(location.search) || { active: false, asOf: '' };
  }

  function canManageEmployees() {
    return window.soroCurrentAccess?.role === 'admin';
  }

  function employeeAccess(employee) {
    return employee.platform_users || employee.access || {};
  }

  function employeeRoleLabel(employee) {
    const access = employeeAccess(employee);
    if (access.role === 'admin' && access.is_founder === true) return 'The Founder';
    return EMPLOYEE_ROLE_LABELS[access.role] || titleCase(access.role);
  }

  function hasCompleteEmployeeProfile(employee) {
    return employee?.profile_complete === true;
  }

  function employeePaymentRoute(employee) {
    return EMPLOYEE_PAYMENT_ROUTES.has(employee?.payment_route) ? employee.payment_route : 'needs_setup';
  }

  function formatEmployeeDate(value) {
    if (!value) return 'Not recorded';
    const date = new Date(`${value}T12:00:00`);
    return Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : value;
  }

  function employeeAddress(employee) {
    const street = [employee.address_line_1, employee.address_line_2].filter(Boolean).join(', ');
    const locality = [employee.city, employee.state_region, employee.postal_code].filter(Boolean).join(', ');
    return [street, locality, employee.country].filter(Boolean).join('\n');
  }

  function employeeStatus(employee) {
    const access = employeeAccess(employee);
    if (!access.active) return { label: 'Inactive', className: 'employee-status--inactive' };
    if (!hasCompleteEmployeeProfile(employee)) return { label: 'Profile setup needed', className: 'employee-status--setup', profileIncomplete: true };
    if (access.must_change_password) {
      const issuedAt = Date.parse(access.initial_password_issued_at || '');
      const expired = !Number.isFinite(issuedAt) || Date.now() - issuedAt > TEMPORARY_PASSWORD_TTL_MS;
      return { label: expired ? 'Setup expired' : 'Setup required', className: 'employee-status--setup', setupRequired: true, expired };
    }
    return { label: 'Active', className: 'employee-status--active' };
  }

  function employeePayrollReadiness(employee, asOf) {
    return payrollReadinessApi()?.employeeState(employee, asOf) || { key: 'invalid', label: 'Readiness unavailable' };
  }

  function filteredEmployees() {
    const query = employeeSearch.trim().toLowerCase();
    const readinessFilter = payrollReadinessFilter();
    return employees.filter(employee => {
      if (readinessFilter.active) {
        return payrollReadinessApi()?.includedInReview(employee, { asOf: readinessFilter.asOf, query }) === true;
      }
      return !query || [
        employee.full_name,
        employee.email,
        employee.phone,
        employee.city,
        employee.state_region,
        employee.country,
        employee.payout_recipient_email,
        EMPLOYEE_PAYMENT_ROUTE_LABELS[employeePaymentRoute(employee)],
        employeeRoleLabel(employee)
      ].filter(Boolean).join(' ').toLowerCase().includes(query);
    });
  }

  function employeeRows() {
    const filtered = filteredEmployees();
    if (!filtered.length) {
      const readinessFilter = payrollReadinessFilter();
      const message = readinessFilter.active
        ? 'No employee payment setups need attention for this payroll period.'
        : employees.length ? 'No employees match that search.' : 'No employee profiles have been added yet.';
      return `<tr><td class="employee-directory-empty" colspan="6">${escapeHtml(message)}</td></tr>`;
    }
    return filtered.map(employee => {
      const access = employeeAccess(employee);
      const status = employeeStatus(employee);
      const payrollState = employeePayrollReadiness(employee, payrollReadinessFilter().asOf);
      return `<tr class="employee-directory-row" data-employee-id="${escapeHtml(employee.user_id)}" tabindex="0" role="button" aria-label="Open ${escapeHtml(employee.full_name)} employee profile"><td><span class="employee-person"><b>${escapeHtml(initials(employee.full_name))}</b><span><strong>${escapeHtml(employee.full_name)}</strong><small>${escapeHtml(employee.email || 'Email not recorded')}</small></span></span></td><td><span class="employee-role">${escapeHtml(employeeRoleLabel(employee))}</span>${access.is_founder === true ? '<small class="employee-founder-note">Reserved overseer identity</small>' : ''}${payrollReadinessFilter().active ? `<small class="employee-payroll-state employee-payroll-state--${escapeHtml(payrollState.key)}">${escapeHtml(payrollState.label)}</small>` : ''}</td><td>${escapeHtml(formatEmployeeDate(employee.hire_date))}</td><td>${escapeHtml(employee.phone || 'Not recorded')}</td><td>${escapeHtml([employee.city, employee.state_region].filter(Boolean).join(', ') || 'Not recorded')}</td><td><span class="employee-status ${status.className}">${escapeHtml(status.label)}</span></td></tr>`;
    }).join('');
  }

  function employeesPage() {
    const adminCount = employees.filter(employee => employeeAccess(employee).role === 'admin').length;
    const talentCount = employees.filter(employee => employeeAccess(employee).role === 'talent_management').length;
    const salesCount = employees.filter(employee => employeeAccess(employee).role === 'sales').length;
    const readinessFilter = payrollReadinessFilter();
    const readinessBanner = readinessFilter.active
      ? `<section class="employee-payroll-filter" aria-label="Payroll readiness filter"><div><span>Payroll readiness review</span><strong>Showing employee payment setups that need attention</strong><small>Eligibility is checked for the payroll period ending ${escapeHtml(formatEmployeeDate(readinessFilter.asOf))}. Open a profile to complete its payment route or Wise recipient.</small></div><button class="button" id="clear-payroll-readiness-filter" type="button">Show all employees</button></section>`
      : '';
    return `<main class="page employee-management-page"><div class="page-heading employee-page-heading"><div><p class="eyebrow">Admin Panel</p><h1>Employees</h1><p class="employee-page-caption">Create Soro employee profiles, assign access, and manage first sign-in setup.</p></div><button class="button primary" id="add-employee" type="button">+ Add employee</button></div>${readinessBanner}<section class="employee-summary" aria-label="Employee summary"><article><span>Total employees</span><strong>${employees.length}</strong></article><article><span>Administrators</span><strong>${adminCount}</strong></article><article><span>Talent Management</span><strong>${talentCount}</strong></article><article><span>Sales Associates</span><strong>${salesCount}</strong></article></section><section class="panel employee-directory"><div class="employee-directory-toolbar"><div><h2>Employee directory</h2><p>Private contact and employment details are available only to Administrators.</p></div><label class="employee-search"><span aria-hidden="true">⌕</span><input id="employee-search" type="search" value="${escapeHtml(employeeSearch)}" placeholder="Search employees" autocomplete="off" /></label></div>${loading ? '<div class="employee-loading">Loading employee profiles…</div>' : loadError ? `<div class="employee-error"><strong>Employee profiles could not be loaded.</strong><span>${escapeHtml(loadError)}</span><button class="button" id="retry-employees" type="button">Try again</button></div>` : `<div class="employee-table-wrap"><table class="data-table employee-table"><thead><tr><th>Employee</th><th>Role</th><th>Hire date</th><th>Phone</th><th>Location</th><th>Access</th></tr></thead><tbody>${employeeRows()}</tbody></table></div>`}</section></main>`;
  }

  render = function () {
    if (current !== 'employees') return originalRender();
    if (!canManageEmployees()) {
      current = 'overview';
      history.replaceState({}, '', `${location.pathname}#overview`);
      setActive();
      return originalRender();
    }
    root.innerHTML = employeesPage();
    bindEmployeePage();
  };

  function bindEmployeePage() {
    document.getElementById('add-employee')?.addEventListener('click', openAddEmployeeDialog);
    document.getElementById('retry-employees')?.addEventListener('click', loadEmployees);
    document.getElementById('clear-payroll-readiness-filter')?.addEventListener('click', () => {
      const destination = new URL(location.href);
      destination.searchParams.delete('employeeFilter');
      destination.searchParams.delete('payrollAsOf');
      history.replaceState({}, '', `${destination.pathname}${destination.search}#employees`);
      render();
    });
    document.getElementById('employee-search')?.addEventListener('input', event => {
      employeeSearch = event.target.value;
      render();
      const refreshed = document.getElementById('employee-search');
      refreshed?.focus();
      refreshed?.setSelectionRange(employeeSearch.length, employeeSearch.length);
    });
    document.querySelectorAll('.employee-directory-row').forEach(row => {
      const open = () => openEmployeeProfile(row.dataset.employeeId);
      row.addEventListener('click', open);
      row.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      });
    });
  }

  async function loadEmployees() {
    if (!canManageEmployees() || !window.soroSupabase) return;
    loading = true;
    loadError = '';
    if (current === 'employees') render();
    const { data: records, error } = await window.soroSupabase.rpc('admin_employee_directory');
    loading = false;
    if (error) {
      employees = [];
      loadError = error.message || 'Refresh your secure session and try again.';
    } else {
      employees = Array.isArray(records) ? records : [];
    }
    if (current === 'employees') render();
  }

  function dialogShell({ eyebrow, title, content, className = '' }) {
    const dialog = document.createElement('dialog');
    const titleId = `employee-dialog-title-${++employeeDialogSequence}`;
    dialog.className = `record-manager-dialog employee-dialog ${className}`.trim();
    dialog.setAttribute('aria-labelledby', titleId);
    dialog.innerHTML = `<section class="record-manager-shell"><header class="record-manager-header"><div><p class="record-manager-eyebrow">${escapeHtml(eyebrow)}</p><h2 id="${titleId}">${escapeHtml(title)}</h2></div><button type="button" class="record-manager-close" aria-label="Close">×</button></header>${content}</section>`;
    document.body.append(dialog);
    dialog.addEventListener('cancel', event => event.preventDefault());
    dialog.addEventListener('click', event => {
      if (event.target === dialog) event.stopPropagation();
    });
    dialog.querySelector('.record-manager-close')?.addEventListener('click', () => dialog.close('cancel'));
    dialog.addEventListener('close', () => dialog.remove());
    return dialog;
  }

  function bindPaymentRouteFields(container) {
    const route = container.querySelector('[name="paymentRoute"]');
    const recipientField = container.querySelector('[data-wise-recipient-field]');
    const recipient = container.querySelector('[name="payoutRecipientEmail"]');
    if (!route || !recipientField || !recipient) return;
    const sync = () => {
      const usesWise = route.value === 'wise_contractor';
      recipientField.hidden = !usesWise;
      recipient.required = usesWise;
      if (!usesWise) recipient.value = '';
    };
    route.addEventListener('change', sync);
    sync();
  }

  function openAddEmployeeDialog() {
    if (!canManageEmployees()) return;
    const maximumHireDate = new Date().toISOString().slice(0, 10);
    const dialog = dialogShell({
      eyebrow: 'Administrator onboarding',
      title: 'Add a new employee',
      className: 'employee-add-dialog',
      content: `<form class="record-manager-form" id="add-employee-form">
        <p class="record-manager-note">Create the employee’s private profile and Soro Ops access. A temporary password will be generated and shown once after the account is created.</p>
        <div class="employee-form-section"><h3>Employment</h3><div class="record-manager-grid">
          <div class="record-manager-field record-manager-field--wide"><label for="employee-full-name">Full name</label><input id="employee-full-name" name="full_name" autocomplete="name" maxlength="120" required /></div>
          <div class="record-manager-field"><label for="employee-hire-date">Hire date</label><input id="employee-hire-date" name="hire_date" type="date" max="${maximumHireDate}" required /></div>
          <div class="record-manager-field"><label for="employee-role">Assigned role</label><select id="employee-role" name="role" required><option value="">Choose a role</option><option value="admin">Administrator</option><option value="talent_management">Talent Management</option><option value="sales">Sales Associate</option></select><small class="employee-role-security-note" hidden>Administrator grants broad Soro Ops access and requires a recent sign-in to assign. The reserved System Owner account cannot be assigned here.</small></div>
        </div></div>
        <div class="employee-form-section"><h3>Payment setup</h3><div class="record-manager-grid">
          <div class="record-manager-field record-manager-field--wide"><label for="employee-payment-route">Payment route</label><select id="employee-payment-route" name="paymentRoute" required><option value="">Choose a payment route</option><option value="wise_contractor">Philippines contractor — Wise</option><option value="quickbooks_employee">U.S. employee — QuickBooks</option><option value="needs_setup">Needs setup</option></select><small>The Administrator chooses this route. Soro never infers it from the employee’s address.</small></div>
          <div class="record-manager-field record-manager-field--wide" data-wise-recipient-field hidden><label for="employee-payout-recipient-email">Wise recipient email <span>Required for Wise</span></label><input id="employee-payout-recipient-email" name="payoutRecipientEmail" type="email" autocomplete="email" maxlength="254" /><small>Choose Needs setup instead if the Wise recipient email is not available yet.</small></div>
        </div></div>
        <div class="employee-form-section"><h3>Contact</h3><div class="record-manager-grid"><div class="record-manager-field"><label for="employee-email">Email</label><input id="employee-email" name="email" type="email" autocomplete="email" maxlength="254" required /></div><div class="record-manager-field"><label for="employee-phone">Phone number</label><input id="employee-phone" name="phone" type="tel" autocomplete="tel" maxlength="40" required /></div></div></div>
        <div class="employee-form-section"><h3>Address</h3><div class="record-manager-grid"><div class="record-manager-field record-manager-field--wide"><label for="employee-address-one">Street address</label><input id="employee-address-one" name="address_line_1" autocomplete="address-line1" maxlength="160" required /></div><div class="record-manager-field record-manager-field--wide"><label for="employee-address-two">Apartment, suite, or unit <span>Optional</span></label><input id="employee-address-two" name="address_line_2" autocomplete="address-line2" maxlength="160" /></div><div class="record-manager-field"><label for="employee-city">City</label><input id="employee-city" name="city" autocomplete="address-level2" maxlength="100" required /></div><div class="record-manager-field"><label for="employee-state">State / province / region</label><input id="employee-state" name="state_region" autocomplete="address-level1" maxlength="100" required /></div><div class="record-manager-field"><label for="employee-postal">Postal code</label><input id="employee-postal" name="postal_code" autocomplete="postal-code" maxlength="24" required /></div><div class="record-manager-field"><label for="employee-country">Country</label><input id="employee-country" name="country" autocomplete="country-name" maxlength="100" required /></div></div></div>
        <p class="employee-form-message" id="employee-form-message" aria-live="polite"></p><footer class="record-manager-footer"><button type="button" class="admin-record-button" data-cancel-employee>Cancel</button><button type="submit" class="admin-record-button admin-record-button--primary">Create employee &amp; password</button></footer>
      </form>`
    });
    const roleSelect = dialog.querySelector('#employee-role');
    const roleSecurityNote = dialog.querySelector('.employee-role-security-note');
    const roleAccessSummary = document.createElement('p');
    roleAccessSummary.className = 'employee-role-access-summary';
    roleAccessSummary.textContent = 'Choose a role to review its access before creating the account.';
    roleSelect?.insertAdjacentElement('afterend', roleAccessSummary);
    const administratorReauthentication = document.createElement('div');
    administratorReauthentication.className = 'record-manager-field record-manager-field--wide employee-admin-reauthentication';
    administratorReauthentication.hidden = true;
    administratorReauthentication.innerHTML = '<label for="employee-administrator-password">Administrator security check</label><input id="employee-administrator-password" name="administrator_password" type="password" autocomplete="current-password" placeholder="Re-enter your Soro password" /><small>Required only when granting full Administrator access.</small>';
    roleSelect?.closest('.record-manager-field')?.insertAdjacentElement('afterend', administratorReauthentication);
    roleSelect?.addEventListener('change', () => {
      const assigningAdministrator = roleSelect.value === 'admin';
      if (roleSecurityNote) roleSecurityNote.hidden = !assigningAdministrator;
      administratorReauthentication.hidden = !assigningAdministrator;
      const password = administratorReauthentication.querySelector('input');
      if (password) password.required = assigningAdministrator;
      roleAccessSummary.textContent = EMPLOYEE_ROLE_ACCESS[roleSelect.value]
        || 'Choose a role to review its access before creating the account.';
    });
    bindPaymentRouteFields(dialog);
    dialog.querySelector('[data-cancel-employee]')?.addEventListener('click', () => dialog.close('cancel'));
    dialog.querySelector('form')?.addEventListener('submit', event => submitEmployee(event, dialog));
    dialog.showModal();
    dialog.querySelector('[name="full_name"]')?.focus();
  }

  async function submitEmployee(event, dialog) {
    event.preventDefault();
    if (!canManageEmployees()) return;
    const form = event.currentTarget;
    const submit = form.querySelector('[type="submit"]');
    const message = form.querySelector('#employee-form-message');
    const values = Object.fromEntries(new FormData(form).entries());
    const administratorPassword = String(values.administrator_password || '');
    delete values.administrator_password;
    if (!EMPLOYEE_ROLES.has(values.role)) {
      message.textContent = 'Choose Administrator, Talent Management, or Sales Associate.';
      message.className = 'employee-form-message employee-form-message--error';
      return;
    }
    const paymentRoute = String(values.paymentRoute || '');
    const payoutRecipientEmail = String(values.payoutRecipientEmail || '').trim().toLowerCase();
    if (!EMPLOYEE_PAYMENT_ROUTES.has(paymentRoute)) {
      message.textContent = 'Choose Philippines contractor — Wise, U.S. employee — QuickBooks, or Needs setup.';
      message.className = 'employee-form-message employee-form-message--error';
      return;
    }
    if (paymentRoute === 'wise_contractor' && !form.elements.payoutRecipientEmail.checkValidity()) {
      message.textContent = 'Enter a valid Wise recipient email, or choose Needs setup until it is available.';
      message.className = 'employee-form-message employee-form-message--error';
      return;
    }
    values.paymentRoute = paymentRoute;
    values.payoutRecipientEmail = paymentRoute === 'wise_contractor' ? payoutRecipientEmail : null;
    submit.disabled = true;
    submit.textContent = 'Creating secure account…';
    message.textContent = '';
    try {
      let { data: { session } } = await window.soroSupabase.auth.getSession();
      if (!session?.access_token) throw new Error('Your secure session expired. Sign in again and retry.');
      if (values.role === 'admin') {
        if (!administratorPassword) throw new Error('Re-enter your Soro password before granting Administrator access.');
        const { data: userData } = await window.soroSupabase.auth.getUser();
        const email = userData?.user?.email;
        const { data: signInData, error: signInError } = await window.soroSupabase.auth.signInWithPassword({ email, password: administratorPassword });
        if (signInError || !signInData?.session?.access_token) throw new Error('Your password could not be verified. The Administrator account was not created.');
        session = signInData.session;
      }
      const response = await fetch('/.netlify/functions/admin-employees', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create_employee', ...values })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || 'The employee account could not be created.');
      dialog.close('created');
      await loadEmployees();
      openTemporaryPasswordDialog(result);
    } catch (error) {
      submit.disabled = false;
      submit.textContent = 'Create employee & password';
      message.textContent = error.message || 'The employee account could not be created.';
      message.className = 'employee-form-message employee-form-message--error';
    }
  }

  function signInMessage(result) {
    return `Welcome to Soro Ops, ${result.employee.fullName}.\n\nSign in: ${window.location.origin}/operations/\nEmail: ${result.employee.email}\nTemporary password: ${result.temporaryPassword}\n\nThese temporary sign-in details expire in ${result.temporaryPasswordExpiresInHours || TEMPORARY_PASSWORD_TTL_HOURS} hours. You will be required to create a private new password when you first sign in.`;
  }

  async function copyText(value) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }

  function openTemporaryPasswordDialog(result) {
    const dialog = dialogShell({
      eyebrow: 'Employee created',
      title: 'Temporary sign-in details',
      className: 'employee-credentials-dialog',
      content: `<div class="employee-credentials"><div class="employee-credentials-notice"><strong>Copy these details now.</strong><p>For security, this temporary password is shown only once, is not stored in the employee profile, and expires in ${escapeHtml(result.temporaryPasswordExpiresInHours || TEMPORARY_PASSWORD_TTL_HOURS)} hours.</p></div><dl><div><dt>Employee</dt><dd>${escapeHtml(result.employee.fullName)}</dd></div><div><dt>Role</dt><dd>${escapeHtml(result.employee.roleLabel)}</dd></div><div><dt>Email</dt><dd>${escapeHtml(result.employee.email)}</dd></div><div class="employee-temporary-password"><dt>Temporary password</dt><dd><code>${escapeHtml(result.temporaryPassword)}</code></dd></div></dl><p class="employee-copy-status" aria-live="polite"></p><footer class="record-manager-footer"><button type="button" class="admin-record-button" data-close-credentials>Done</button><button type="button" class="admin-record-button admin-record-button--primary" data-copy-credentials>Copy sign-in message</button></footer></div>`
    });
    dialog.querySelector('[data-close-credentials]')?.addEventListener('click', () => dialog.close('done'));
    dialog.querySelector('[data-copy-credentials]')?.addEventListener('click', async event => {
      const status = dialog.querySelector('.employee-copy-status');
      try {
        await copyText(signInMessage(result));
        status.textContent = 'Sign-in message copied. Send it to the employee through your trusted communication channel.';
        event.currentTarget.textContent = 'Copied';
      } catch {
        status.textContent = 'Copy was blocked by this browser. Select the email and temporary password above to copy them manually.';
      }
    });
    dialog.showModal();
  }

  function openEmployeeProfile(userId) {
    const employee = employees.find(record => record.user_id === userId);
    if (!employee || !canManageEmployees()) return;
    const access = employeeAccess(employee);
    const status = employeeStatus(employee);
    const paymentRoute = employeePaymentRoute(employee);
    const profileComplete = hasCompleteEmployeeProfile(employee);
    const effectiveAccess = access.is_founder === true
      ? 'The Founder oversees Soro through the established Administrator access boundary. The title does not create a separate permission role.'
      : (EMPLOYEE_ROLE_ACCESS[access.role] || 'Access follows the assigned Soro role.');
    const recipientDetail = paymentRoute === 'wise_contractor'
      ? `<div><dt>Wise recipient</dt><dd>${escapeHtml(employee.payout_recipient_email || 'Not recorded')}</dd></div>`
      : '';
    const dialog = dialogShell({
      eyebrow: 'Private employee profile',
      title: employee.full_name,
      className: 'employee-profile-dialog',
      content: `<div class="employee-profile-content">
        <div class="employee-profile-lead"><span class="employee-profile-avatar">${escapeHtml(initials(employee.full_name))}</span><div><span class="employee-role">${escapeHtml(employeeRoleLabel(employee))}</span><span class="employee-status ${status.className}">${escapeHtml(status.label)}</span></div></div>
        <section class="employee-effective-access"><strong>Effective access</strong><p>${escapeHtml(effectiveAccess)}</p></section>
        ${profileComplete ? '' : '<section class="employee-effective-access employee-profile-incomplete"><strong>Private profile details are not complete</strong><p>The Founder identity is active and has Administrator access. Hire date, phone, address, and payment details have intentionally not been invented and can be completed when the real information is available.</p></section>'}
        <dl class="employee-profile-details"><div><dt>Hire date</dt><dd>${escapeHtml(formatEmployeeDate(employee.hire_date))}</dd></div><div><dt>Email</dt><dd>${employee.email ? `<a href="mailto:${escapeHtml(employee.email)}">${escapeHtml(employee.email)}</a>` : 'Not recorded'}</dd></div><div><dt>Phone</dt><dd>${employee.phone ? `<a href="tel:${escapeHtml(employee.phone)}">${escapeHtml(employee.phone)}</a>` : 'Not recorded'}</dd></div><div><dt>Payment route</dt><dd>${profileComplete ? escapeHtml(EMPLOYEE_PAYMENT_ROUTE_LABELS[paymentRoute]) : 'Not recorded'}</dd></div>${profileComplete ? recipientDetail : ''}<div class="employee-profile-address"><dt>Address</dt><dd>${employeeAddress(employee) ? escapeHtml(employeeAddress(employee)).replaceAll('\n', '<br>') : 'Not recorded'}</dd></div></dl>
        ${status.setupRequired && access.role === 'admin' ? '<label class="employee-profile-security-check">Administrator security check<input name="administrator_password" type="password" autocomplete="current-password" placeholder="Re-enter your Soro password" /><small>Required before generating new credentials for an Administrator.</small></label>' : ''}
        <p class="employee-profile-action-message" aria-live="polite"></p><footer class="record-manager-footer">${profileComplete && status.setupRequired ? '<button type="button" class="admin-record-button" data-reissue-credentials>Generate new temporary password</button>' : ''}${profileComplete ? '<button type="button" class="admin-record-button" data-edit-payment-route>Edit payment setup</button>' : ''}<button type="button" class="admin-record-button admin-record-button--primary" data-close-profile>Close profile</button></footer>
      </div>`
    });
    dialog.querySelector('[data-close-profile]')?.addEventListener('click', () => dialog.close('done'));
    dialog.querySelector('[data-reissue-credentials]')?.addEventListener('click', event => reissueTemporaryPassword(employee, dialog, event.currentTarget));
    dialog.querySelector('[data-edit-payment-route]')?.addEventListener('click', () => openEmployeePaymentDialog(employee, dialog));
    dialog.showModal();
  }

  function openEmployeePaymentDialog(employee, profileDialog) {
    if (!employee || !canManageEmployees()) return;
    const currentRoute = employeePaymentRoute(employee);
    const dialog = dialogShell({
      eyebrow: 'Administrator payment setup',
      title: `Payment route for ${employee.full_name}`,
      className: 'employee-payment-dialog',
      content: `<form class="record-manager-form" id="employee-payment-form">
        <p class="record-manager-note">Choose the employee’s actual payment route. This setting controls which external payment workflow may include them; Soro does not infer it from address, country, or role.</p>
        <div class="employee-form-section"><div class="record-manager-grid">
          <div class="record-manager-field record-manager-field--wide"><label for="profile-payment-route">Payment route</label><select id="profile-payment-route" name="paymentRoute" required><option value="wise_contractor" ${currentRoute === 'wise_contractor' ? 'selected' : ''}>Philippines contractor — Wise</option><option value="quickbooks_employee" ${currentRoute === 'quickbooks_employee' ? 'selected' : ''}>U.S. employee — QuickBooks</option><option value="needs_setup" ${currentRoute === 'needs_setup' ? 'selected' : ''}>Needs setup</option></select></div>
          <div class="record-manager-field record-manager-field--wide" data-wise-recipient-field><label for="profile-payout-recipient-email">Wise recipient email <span>Required for Wise</span></label><input id="profile-payout-recipient-email" name="payoutRecipientEmail" type="email" autocomplete="email" maxlength="254" value="${escapeHtml(currentRoute === 'wise_contractor' ? employee.payout_recipient_email || '' : '')}" /><small>Choose Needs setup instead if the Wise recipient email is not available yet.</small></div>
        </div></div>
        <p class="employee-form-message" aria-live="polite"></p><footer class="record-manager-footer"><button type="button" class="admin-record-button" data-cancel-payment-route>Cancel</button><button type="submit" class="admin-record-button admin-record-button--primary">Save payment setup</button></footer>
      </form>`
    });
    bindPaymentRouteFields(dialog);
    dialog.querySelector('[data-cancel-payment-route]')?.addEventListener('click', () => dialog.close('cancel'));
    dialog.querySelector('form')?.addEventListener('submit', async event => {
      event.preventDefault();
      if (!canManageEmployees()) return;
      const form = event.currentTarget;
      const submit = form.querySelector('[type="submit"]');
      const message = form.querySelector('.employee-form-message');
      const values = Object.fromEntries(new FormData(form).entries());
      const paymentRoute = String(values.paymentRoute || '');
      const payoutRecipientEmail = String(values.payoutRecipientEmail || '').trim().toLowerCase();
      if (!EMPLOYEE_PAYMENT_ROUTES.has(paymentRoute)) {
        message.textContent = 'Choose an available employee payment route.';
        message.className = 'employee-form-message employee-form-message--error';
        return;
      }
      if (paymentRoute === 'wise_contractor' && !form.elements.payoutRecipientEmail.checkValidity()) {
        message.textContent = 'Enter a valid Wise recipient email, or choose Needs setup until it is available.';
        message.className = 'employee-form-message employee-form-message--error';
        return;
      }
      submit.disabled = true;
      submit.textContent = 'Saving payment setup…';
      message.textContent = '';
      try {
        const { data: { session } } = await window.soroSupabase.auth.getSession();
        if (!session?.access_token) throw new Error('Your secure session expired. Sign in again and retry.');
        const response = await fetch('/.netlify/functions/admin-employees', {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'update_employee_payment_route',
            userId: employee.user_id,
            paymentRoute,
            payoutRecipientEmail: paymentRoute === 'wise_contractor' ? payoutRecipientEmail : null
          })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.message || 'The employee payment setup could not be saved.');
        dialog.close('saved');
        profileDialog?.close('updated');
        await loadEmployees();
        openEmployeeProfile(employee.user_id);
      } catch (error) {
        submit.disabled = false;
        submit.textContent = 'Save payment setup';
        message.textContent = error.message || 'The employee payment setup could not be saved.';
        message.className = 'employee-form-message employee-form-message--error';
      }
    });
    dialog.showModal();
    dialog.querySelector('[name="paymentRoute"]')?.focus();
  }

  async function reissueTemporaryPassword(employee, profileDialog, button) {
    if (!canManageEmployees()) return;
    const access = employeeAccess(employee);
    const message = profileDialog.querySelector('.employee-profile-action-message');
    button.disabled = true;
    button.textContent = 'Generating secure password…';
    try {
      let { data: { session } } = await window.soroSupabase.auth.getSession();
      if (!session?.access_token) throw new Error('Your secure session expired. Sign in again and retry.');
      if (access.role === 'admin') {
        const administratorPassword = profileDialog.querySelector('[name="administrator_password"]')?.value || '';
        if (!administratorPassword) throw new Error('Re-enter your Soro password before generating Administrator credentials.');
        const { data: userData } = await window.soroSupabase.auth.getUser();
        const email = userData?.user?.email;
        const { data: signInData, error: signInError } = await window.soroSupabase.auth.signInWithPassword({ email, password: administratorPassword });
        if (signInError || !signInData?.session?.access_token) throw new Error('Your password could not be verified. No new credentials were generated.');
        session = signInData.session;
      }
      const response = await fetch('/.netlify/functions/admin-employees', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reissue_temporary_password', userId: employee.user_id })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || 'New temporary sign-in details could not be generated.');
      profileDialog.close('reissued');
      await loadEmployees();
      openTemporaryPasswordDialog(result);
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Generate new temporary password';
      message.textContent = error.message || 'New temporary sign-in details could not be generated.';
      message.className = 'employee-profile-action-message employee-form-message--error';
    }
  }

  function syncEmployeeNavigation(access) {
    const navItem = document.getElementById('employees-nav');
    if (navItem) navItem.hidden = access?.role !== 'admin';
    if (access?.role !== 'admin' && current === 'employees') {
      current = 'overview';
      history.replaceState({}, '', `${location.pathname}#overview`);
      setActive();
      render();
    }
  }

  window.addEventListener('soro-auth-changed', event => {
    const access = event.detail?.access || null;
    syncEmployeeNavigation(access);
    if (access?.role !== 'admin') {
      employees = [];
      return;
    }
    if (location.hash === '#employees') {
      current = 'employees';
      setActive();
      render();
    }
    loadEmployees();
  });

  window.addEventListener('soro:employee-payroll-review', () => {
    if (canManageEmployees()) employeeSearch = '';
  });

  window.soroEmployeeManagement = {
    EMPLOYEE_ROLE_LABELS,
    EMPLOYEE_ROLE_ACCESS,
    EMPLOYEE_PAYMENT_ROUTE_LABELS,
    canManageEmployees,
    loadEmployees
  };
})();
