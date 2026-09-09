/* Local, read-only PDF rendering. No document URLs are sent to a third-party viewer. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.soroPrivatePdfViewer = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const ASSETS = '/operations/vendor/pdfjs-6.3.289/';
  const MAX_BYTES = 25 * 1024 * 1024, MAX_PIXELS = 8000000, MAX_PAGES = 250;
  let library;
  function loadLibrary() {
    if (!library) library = import('./vendor/pdfjs-6.3.289/pdf.min.mjs').then(pdf => {
      pdf.GlobalWorkerOptions.workerSrc = ASSETS + 'pdf.worker.min.mjs';
      return pdf;
    }).catch(error => { library = null; throw error; });
    return library;
  }
  function validateUrl(value, origin) {
    const url = new URL(value), allowed = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== allowed.origin || url.username || url.password || !url.pathname.startsWith('/storage/v1/object/sign/soro-private-documents/')) throw new Error('Invalid private file URL');
    return url.href;
  }
  async function readPdf(response, signal) {
    if (!response.ok) throw new Error('File unavailable');
    const length = Number(response.headers.get('content-length') || 0);
    if (length > MAX_BYTES || !response.body?.getReader) throw new Error('Preview size unavailable');
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      for (;;) {
        if (signal.aborted) throw new Error('Cancelled');
        const {done, value} = await reader.read();
        if (signal.aborted) throw new Error('Cancelled');
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) throw new Error('Preview too large');
        chunks.push(value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    const data = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
    // PDF headers may follow a small leading byte-order mark/preamble.
    if (!new TextDecoder('latin1').decode(data.subarray(0, 1024)).includes('%PDF-')) throw new Error('Not a PDF');
    return data;
  }
  function dimensions(width, height, available, zoom, dpr) {
    if (![width,height].every(n => Number.isFinite(n) && n > 0 && n <= 20000)) throw new Error('Unsupported page size');
    const scale = Math.min(4, Math.max(.1, (Math.max(240, available) / width) * zoom));
    const density = Math.min(2, Math.max(1, dpr || 1), Math.sqrt(MAX_PIXELS / (width * height * scale * scale)));
    return {scale, density};
  }
  function markup() {
    return '<div class="private-pdf-viewer" data-private-pdf-viewer><div class="private-pdf-toolbar" aria-label="Résumé page controls"><button type="button" class="button" data-pdf-prev disabled aria-label="Previous résumé page">Previous</button><span data-pdf-page aria-live="polite">Loading…</span><button type="button" class="button" data-pdf-next disabled aria-label="Next résumé page">Next</button><label>Zoom <select data-pdf-zoom disabled><option value="1">Fit width</option><option value="1.25">125%</option><option value="1.5">150%</option><option value="2">200%</option></select></label></div><p data-pdf-status role="status">Loading the private PDF…</p><div class="private-pdf-pages" data-pdf-pages tabindex="0" aria-label="Résumé PDF page"></div><details class="private-pdf-text" data-pdf-text-details hidden><summary>Readable page text</summary><div data-pdf-text></div></details></div>';
  }
  function mount(host, options, dependencies = {}) {
    const controller = new AbortController();
    const status = host.querySelector('[data-pdf-status]'), pages = host.querySelector('[data-pdf-pages]');
    const prev = host.querySelector('[data-pdf-prev]'), next = host.querySelector('[data-pdf-next]');
    const label = host.querySelector('[data-pdf-page]'), zoomControl = host.querySelector('[data-pdf-zoom]');
    const text = host.querySelector('[data-pdf-text]'), textDetails = host.querySelector('[data-pdf-text-details]');
    let dead = false, loading = null, pdf = null, rendering = null, pageNumber = 1, zoom = 1, renderVersion = 0, resizeTimer = null, observer = null, lastWidth = 0, loadTimer = null, renderTimer = null;
    const alive = () => !dead && host.isConnected && options.isCurrent();
    function disposeDocument() {
      rendering?.cancel(); rendering = null;
      if (loading) { Promise.resolve(loading.destroy()).catch(() => {}); loading = null; }
      pdf = null;
    }
    function clearPages() {
      for (const canvas of pages.querySelectorAll('canvas')) { canvas.width = 0; canvas.height = 0; }
      pages.replaceChildren(); text.textContent = ''; textDetails.hidden = true;
    }
    function destroy() {
      if (dead) return;
      dead = true; renderVersion += 1; controller.abort();
      clearTimeout(resizeTimer); clearTimeout(loadTimer); clearTimeout(renderTimer); observer?.disconnect(); disposeDocument(); clearPages();
      host.removeEventListener('click', click); host.removeEventListener('change', change);
    }
    function fail() {
      if (!alive()) return;
      renderVersion += 1; controller.abort(); clearTimeout(loadTimer); clearTimeout(renderTimer);
      disposeDocument(); clearPages();
      status.hidden = false;
      status.textContent = 'This PDF could not be previewed here. Try Reload résumé, or Open résumé separately. Password-protected or very large files may need to be opened separately.';
      label.textContent = 'Preview unavailable'; prev.disabled = next.disabled = zoomControl.disabled = true;
    }
    function controls(busy) {
      prev.disabled = busy || pageNumber <= 1;
      next.disabled = busy || pageNumber >= (pdf?.numPages || 0);
      zoomControl.disabled = busy;
    }
    async function renderPage() {
      if (!alive() || !pdf) return;
      const version = ++renderVersion, current = () => alive() && version === renderVersion;
      clearTimeout(renderTimer); renderTimer = setTimeout(() => { if (current()) fail(); }, 20000);
      const previous = rendering;
      previous?.cancel(); rendering = null;
      controls(true); status.hidden = false; status.textContent = 'Rendering résumé page…';
      try {
        if (previous) await previous.promise.catch(() => {});
        if (!current()) return;
        clearPages();
        const page = await pdf.getPage(pageNumber);
        if (!current()) return;
        const base = page.getViewport({scale:1});
        const available = pages.clientWidth - 24;
        lastWidth = pages.clientWidth;
        const {scale, density} = dimensions(base.width, base.height, available, zoom, root.devicePixelRatio);
        const viewport = page.getViewport({scale});
        const canvas = host.ownerDocument.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(viewport.width * density));
        canvas.height = Math.max(1, Math.floor(viewport.height * density));
        canvas.style.width = Math.floor(viewport.width) + 'px'; canvas.style.height = Math.floor(viewport.height) + 'px';
        canvas.setAttribute('role','img'); canvas.setAttribute('aria-label', `Résumé page ${pageNumber}. Readable text is available below.`);
        pages.append(canvas);
        rendering = page.render({canvas, canvasContext:canvas.getContext('2d'), viewport, transform: density === 1 ? null : [density,0,0,density,0,0], annotationMode:0});
        await rendering.promise;
        if (!current()) return;
        rendering = null;
        // Readable text is an optional aid; extraction must not discard a good page.
        const content = await page.getTextContent().catch(() => ({items:[]}));
        if (!current()) return;
        text.textContent = content.items.map(item => typeof item.str === 'string' ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('');
        textDetails.hidden = !text.textContent.trim();
        label.textContent = `Page ${pageNumber} of ${pdf.numPages}`;
        status.textContent = ''; status.hidden = true;
        clearTimeout(renderTimer);
        controls(false); page.cleanup();
      } catch (_) { if (current()) fail(); }
    }
    function click(event) {
      const action = event.target.closest('[data-pdf-prev], [data-pdf-next]');
      if (!action || action.disabled || !pdf || !alive()) return;
      event.preventDefault();
      pageNumber = Math.max(1, Math.min(pdf.numPages, pageNumber + (action.hasAttribute('data-pdf-next') ? 1 : -1)));
      renderPage();
    }
    function change(event) {
      if (event.target !== zoomControl || !alive()) return;
      const value = Number(zoomControl.value);
      zoom = [1,1.25,1.5,2].includes(value) ? value : 1; renderPage();
    }
    host.addEventListener('click', click); host.addEventListener('change', change);
    loadTimer = setTimeout(fail, 45000);
    const ready = (async () => {
      try {
        if (!alive()) return;
        const url = validateUrl(options.url, options.storageOrigin);
        const response = await (dependencies.fetch || root.fetch)(url, {signal:controller.signal, credentials:'omit', cache:'no-store', referrerPolicy:'no-referrer', redirect:'error'});
        if (!alive()) { controller.abort(); return; }
        let data = await readPdf(response, controller.signal);
        if (!alive()) return;
        const engine = await (dependencies.loadLibrary || loadLibrary)();
        if (!alive()) { data = null; return; }
        loading = engine.getDocument({data, isEvalSupported:false, enableXfa:false, maxImageSize:MAX_PIXELS,
          cMapUrl:ASSETS+'cmaps/', cMapPacked:true, standardFontDataUrl:ASSETS+'standard_fonts/',
          wasmUrl:ASSETS+'wasm/', iccUrl:ASSETS+'iccs/', useWorkerFetch:true});
        data = null; // PDF.js owns the transferred bytes until destroy().
        pdf = await loading.promise;
        if (!alive()) { disposeDocument(); return; }
        if (!Number.isInteger(pdf.numPages) || pdf.numPages < 1 || pdf.numPages > MAX_PAGES) throw new Error('Page limit');
        clearTimeout(loadTimer);
        await renderPage();
        if (!alive() || !pdf) return;
        if (root.ResizeObserver) {
          observer = new root.ResizeObserver(() => {
            if (!alive() || Math.abs(pages.clientWidth-lastWidth) < 2) return;
            clearTimeout(resizeTimer); resizeTimer = setTimeout(renderPage, 150);
          });
          observer.observe(pages);
        }
      } catch (_) { fail(); }
    })();
    return Object.freeze({destroy, ready});
  }
  return Object.freeze({markup, mount, validateUrl, readPdf, dimensions, MAX_BYTES});
}));
