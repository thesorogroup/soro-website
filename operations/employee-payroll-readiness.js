/* Pure Employee-directory helpers for the Administrator payroll-readiness review. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.soroEmployeePayrollReadiness = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ROUTE_LABELS = Object.freeze({
    wise_contractor: 'Philippines contractor Wise',
    quickbooks_employee: 'U.S. employee QuickBooks',
    needs_setup: 'Needs setup'
  });

  function text(value) {
    return String(value ?? '').trim();
  }

  function validIsoDate(value) {
    const normalized = text(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return '';
    const [year, month, day] = normalized.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === normalized ? normalized : '';
  }

  function resolveAsOf(value, fallback) {
    return validIsoDate(value) || validIsoDate(fallback);
  }

  function filterState(search) {
    const params = new URLSearchParams(text(search).replace(/^\?/, ''));
    const requested = params.get('employeeFilter') === 'payroll-readiness';
    const asOf = validIsoDate(params.get('payrollAsOf'));
    return Object.freeze({ active: requested && Boolean(asOf), asOf });
  }

  function accessFor(employee) {
    return employee?.platform_users || employee?.access || {};
  }

  function employeeState(employee, asOfValue) {
    const asOf = validIsoDate(asOfValue);
    if (!asOf || !employee || typeof employee !== 'object' || Array.isArray(employee)) {
      return Object.freeze({ key: 'invalid', label: 'Readiness unavailable' });
    }
    const access = accessFor(employee);
    if (access.active !== true) return Object.freeze({ key: 'inactive', label: 'Inactive' });
    if (employee.profile_complete !== true) return Object.freeze({ key: 'profile_incomplete', label: 'Employee profile incomplete' });
    const hireDate = validIsoDate(employee.hire_date);
    if (!hireDate) return Object.freeze({ key: 'needs_setup', label: 'Hire date needs review' });
    if (hireDate > asOf) return Object.freeze({ key: 'future_hire', label: 'Future hire' });
    const route = text(employee.payment_route).toLowerCase();
    if (route === 'wise_contractor' && text(employee.payout_recipient_email)) {
      return Object.freeze({ key: 'wise_ready', label: 'Wise-ready' });
    }
    if (route === 'wise_contractor') return Object.freeze({ key: 'needs_setup', label: 'Wise recipient missing' });
    if (route === 'quickbooks_employee') return Object.freeze({ key: 'quickbooks', label: 'QuickBooks-only' });
    return Object.freeze({ key: 'needs_setup', label: 'Payment setup required' });
  }

  function matchesSearch(employee, query) {
    const normalized = text(query).toLowerCase();
    if (!normalized) return true;
    const access = accessFor(employee);
    return [
      employee?.full_name,
      employee?.email,
      employee?.phone,
      employee?.city,
      employee?.state_region,
      employee?.country,
      employee?.payout_recipient_email,
      employee?.payment_route,
      ROUTE_LABELS[text(employee?.payment_route).toLowerCase()],
      access.role
    ].filter(Boolean).join(' ').toLowerCase().includes(normalized);
  }

  function includedInReview(employee, { asOf, query = '' } = {}) {
    return employeeState(employee, asOf).key === 'needs_setup' && matchesSearch(employee, query);
  }

  return Object.freeze({ validIsoDate, resolveAsOf, filterState, employeeState, matchesSearch, includedInReview });
}));
