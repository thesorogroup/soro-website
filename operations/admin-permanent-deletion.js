/* Administrator-only permanent deletion with deliberate confirmation. */
(function () {
  const observer = new MutationObserver(() => requestAnimationFrame(addDeleteControls));

  function isAdministrator() {
    return window.soroCurrentAccess?.role === 'admin';
  }

  function addButton(actions, type, id, name, archived) {
    if (!actions || actions.querySelector(`[data-permanent-delete-id="${CSS.escape(id)}"]`)) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'admin-record-button admin-record-button--permanent-delete';
    button.dataset.permanentDeleteType = type;
    button.dataset.permanentDeleteId = id;
    button.dataset.permanentDeleteName = name;
    button.dataset.permanentDeleteArchived = String(Boolean(archived));
    button.textContent = 'Delete permanently';
    actions.append(button);
  }

  function addDeleteControls() {
    if (!isAdministrator()) return;
    const applicant = typeof liveApplicants !== 'undefined' ? liveApplicants.find(item => item.id === selectedTalentId) : null;
    const profileActions = document.querySelector('.admin-profile-controls');
    if (applicant && profileActions) addButton(profileActions, 'talent', applicant.id, applicant.full_name, false);

    document.querySelectorAll('[data-edit-client]').forEach(edit => {
      const item = edit.closest('.admin-managed-item');
      const name = item?.querySelector('strong')?.textContent?.trim();
      const actions = edit.closest('.admin-record-actions');
      if (name && actions) addButton(actions, 'client', edit.dataset.editClient, name, false);
    });

    document.querySelectorAll('[data-restore-client], [data-restore-talent]').forEach(restore => {
      const item = restore.closest('.admin-managed-item');
      const name = item?.querySelector('strong')?.textContent?.trim();
      if (!item || !name) return;
      let actions = restore.closest('.admin-record-actions');
      if (!actions) {
        actions = document.createElement('div');
        actions.className = 'admin-record-actions';
        restore.replaceWith(actions);
        actions.append(restore);
      }
      const type = restore.hasAttribute('data-restore-client') ? 'client' : 'talent';
      const id = restore.dataset.restoreClient || restore.dataset.restoreTalent;
      addButton(actions, type, id, name, true);
    });
  }

  function closeDialog(dialog) {
    dialog?.close();
  }

  async function archiveInstead(type, id, name, dialog) {
    const table = type === 'talent' ? 'applicants' : 'clients';
    const { error } = await window.soroSupabase.from(table).update({ archived_at: new Date().toISOString() }).eq('id', id);
    if (error) return setDialogError(dialog, error.message || `Could not archive ${name}.`);
    closeDialog(dialog);
    toast(`${name} was archived and can be restored later.`);
    if (type === 'talent') {
      current = 'vas'; selectedTalentId = null;
      history.pushState({}, '', `${location.pathname}#talent`);
      setActive();
      await loadLiveApplicants();
    } else {
      document.getElementById('admin-managed-clients')?.remove();
      render();
    }
  }

  function setDialogError(dialog, message) {
    const target = dialog?.querySelector('[data-delete-error]');
    if (target) {
      target.textContent = message;
      target.hidden = false;
    }
  }

  function openDeleteDialog({ type, id, name, archived }) {
    const label = type === 'talent' ? 'Talent profile' : 'Client record';
    const dialog = document.createElement('dialog');
    dialog.className = 'permanent-delete-dialog';
    dialog.innerHTML = `<form class="permanent-delete-card"><header><div><p class="eyebrow">Administrator security check</p><h2>Delete this ${label.toLowerCase()} permanently?</h2></div><button type="button" class="permanent-delete-close" aria-label="Close permanent deletion">×</button></header><div class="permanent-delete-warning"><strong>Archiving is safer and reversible.</strong><p>Permanent deletion removes <b>${escapeHtml(name)}</b> and eligible connected private files. This cannot be undone. Records with placement history are protected and cannot be deleted.</p></div><label>Type the exact name to confirm<input name="confirmationName" autocomplete="off" spellcheck="false" required placeholder="${escapeHtml(name)}"></label><label>Re-enter your Soro password<input name="password" type="password" autocomplete="current-password" required placeholder="Your password"></label><p class="permanent-delete-error" data-delete-error hidden></p><footer><button type="button" class="admin-record-button" data-cancel-delete>Cancel</button>${archived ? '<button type="button" class="admin-record-button" data-keep-archived>Keep archived</button>' : '<button type="button" class="admin-record-button" data-archive-instead>Archive instead</button>'}<button type="submit" class="admin-record-button admin-record-button--permanent-delete">Permanently delete</button></footer></form>`;
    document.body.append(dialog);
    dialog.addEventListener('cancel', event => event.preventDefault());
    dialog.querySelector('.permanent-delete-close').addEventListener('click', () => closeDialog(dialog));
    dialog.querySelector('[data-cancel-delete]')?.addEventListener('click', () => closeDialog(dialog));
    dialog.querySelector('[data-keep-archived]')?.addEventListener('click', () => closeDialog(dialog));
    dialog.querySelector('[data-archive-instead]')?.addEventListener('click', () => archiveInstead(type, id, name, dialog));
    dialog.addEventListener('close', () => dialog.remove());
    dialog.querySelector('form').addEventListener('submit', async event => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      if (form.get('confirmationName') !== name) return setDialogError(dialog, `Enter “${name}” exactly as shown.`);
      const submit = event.currentTarget.querySelector('[type="submit"]');
      submit.disabled = true;
      submit.textContent = 'Verifying and deleting…';
      const { data: userData } = await window.soroSupabase.auth.getUser();
      const email = userData?.user?.email;
      const { data: signInData, error: signInError } = await window.soroSupabase.auth.signInWithPassword({ email, password: form.get('password') });
      if (signInError || !signInData?.session?.access_token) {
        submit.disabled = false;
        submit.textContent = 'Permanently delete';
        return setDialogError(dialog, 'Your password could not be verified. Nothing was deleted.');
      }
      const response = await fetch('/.netlify/functions/admin-records', {
        method: 'POST',
        headers: { Authorization: `Bearer ${signInData.session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'permanent_delete', type, id, confirmationName: name })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        submit.disabled = false;
        submit.textContent = 'Permanently delete';
        return setDialogError(dialog, result.message || 'Nothing was deleted. Please try again.');
      }
      closeDialog(dialog);
      toast(`${name} was permanently deleted.`);
      if (type === 'talent') {
        current = 'vas'; selectedTalentId = null;
        history.pushState({}, '', `${location.pathname}#talent`);
        setActive();
        await loadLiveApplicants();
      } else {
        document.getElementById('admin-managed-clients')?.remove();
        render();
      }
    });
    dialog.showModal();
  }

  document.addEventListener('click', event => {
    const button = event.target.closest('[data-permanent-delete-id]');
    if (!button || !isAdministrator()) return;
    event.preventDefault();
    event.stopPropagation();
    openDeleteDialog({
      type: button.dataset.permanentDeleteType,
      id: button.dataset.permanentDeleteId,
      name: button.dataset.permanentDeleteName,
      archived: button.dataset.permanentDeleteArchived === 'true'
    });
  }, true);

  window.addEventListener('soro-auth-changed', addDeleteControls);
  observer.observe(document.body, { childList: true, subtree: true });
  addDeleteControls();
})();
