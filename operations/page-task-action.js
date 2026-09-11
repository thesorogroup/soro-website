/* One task entry point shared by every authorized workspace page. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.soroPageTaskAction = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  let previousScope = null;
  function scope() {
    const access = root.soroCurrentAccess;
    return JSON.stringify([access?.user_id, access?.organization_id, access?.role, root.currentAuthenticatedRole?.() || access?.role]);
  }
  function canCreate() {
    const access = root.soroCurrentAccess;
    return Boolean(access?.user_id && access.active !== false && access.must_change_password !== true
      && root.soroTaskCenter?.canCreate?.(access.role)
      && root.viewAllowedForAuthenticatedRole?.('tasks')
      && !root.adminPreviewingNonAdminWorkspace?.());
  }
  function sync() {
    const allowed = canCreate(), document = root.document;
    const toolbar = document?.getElementById('page-task-toolbar');
    if (toolbar) toolbar.hidden = !allowed;
    document?.body?.classList.toggle('has-page-task-action', allowed);
    const dialog = document?.getElementById('task-dialog');
    const nextScope = scope();
    if ((!allowed || (previousScope !== null && previousScope !== nextScope)) && dialog?.open) dialog.close('cancel');
    previousScope = nextScope;
    return allowed;
  }
  function open() {
    if (!sync()) return false;
    const document = root.document, dialog = document?.getElementById('task-dialog');
    if (!dialog || dialog.open) return false;
    const related = document.getElementById('task-related');
    // Retain the existing Talent-profile shortcut's context, but not on other pages.
    if (related && !related.value && root.location?.hash?.startsWith('#talent/')) {
      related.value = root.currentTalentProfileApplicant?.()?.full_name || '';
    }
    dialog.showModal();
    document.getElementById('task-name')?.focus();
    return true;
  }
  root.document?.getElementById('page-add-task')?.addEventListener('click', open);
  root.addEventListener?.('soro-auth-changed', sync);
  sync();
  return Object.freeze({canCreate, sync, open});
}));
