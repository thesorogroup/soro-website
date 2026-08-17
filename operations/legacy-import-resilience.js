/* Make the one-time legacy archive import resilient to transient Netlify responses. */
(function () {
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function importPage(session, offset) {
    const endpoint = new URL('/.netlify/functions/import-google-drive', window.location.origin).toString();
    let lastFailure;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          cache: 'no-store',
          credentials: 'same-origin',
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache'
          },
          body: JSON.stringify({ offset })
        });
        const text = await response.text();
        let report;
        try { report = text ? JSON.parse(text) : {}; } catch (_) { report = { message: text }; }

        if (response.ok) return report;
        lastFailure = new Error(report.error || report.message || `Import server returned ${response.status}.`);
        if (response.status < 500) throw lastFailure;
      } catch (error) {
        lastFailure = error;
        if (attempt === 2) break;
      }
      await pause(750 * (attempt + 1));
    }
    throw lastFailure || new Error('The import server did not return a response.');
  }

  importDriveFiles = async function () {
    const button = document.getElementById('import-drive');
    if (!button || !window.soroSupabase) return;
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = 'Checking access…';

    try {
      const { data: { session }, error: sessionError } = await window.soroSupabase.auth.getSession();
      if (sessionError || !session) throw new Error('Your Soro sign-in has expired. Please sign out, sign in again, then retry the import.');

      let offset = 0;
      let imported = 0;
      let skipped = 0;
      let total = 1;
      while (offset < total) {
        button.textContent = offset ? `Importing legacy files (${offset}/${total})…` : 'Importing legacy files…';
        const report = await importPage(session, offset);
        total = Number(report.total || total);
        offset = Number(report.nextOffset ?? offset + 1);
        imported += Number(report.imported || 0);
        skipped += Number(report.skipped || 0);
      }

      toast(`Legacy import complete: ${imported} file${imported === 1 ? '' : 's'} attached${skipped ? `, ${skipped} already on file` : ''}.`);
      if (typeof loadLiveApplicants === 'function') await loadLiveApplicants();
    } catch (error) {
      console.error('Soro Ops legacy import failed', error);
      toast(error?.message || 'The import could not start. Please try again.');
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  };

  document.addEventListener('click', event => {
    if (!event.target.closest('#import-drive')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    importDriveFiles();
  }, true);
})();
