(() => {
  const dialog = document.getElementById('task-dialog');
  if (!dialog) return;

  const closeTaskDialog = () => {
    if (dialog.open) dialog.close('cancel');
  };

  // Capture clicks so the close control remains dependable even if other
  // workspace scripts are refreshed or re-bound later.
  dialog.addEventListener('click', event => {
    if (event.target === dialog) closeTaskDialog();
  });

  dialog.querySelector('.modal-close')?.addEventListener('click', event => {
    event.preventDefault();
    closeTaskDialog();
  });

  dialog.querySelector('.modal-cancel')?.addEventListener('click', event => {
    event.preventDefault();
    closeTaskDialog();
  });
})();
