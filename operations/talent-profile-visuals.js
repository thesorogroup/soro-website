/* Shared visual primitives for the approved Soro Talent profile folder. */
(function (root, factory) {
  const visuals = factory();
  if (typeof module === 'object' && module.exports) module.exports = visuals;
  if (root) root.SoroTalentProfileVisuals = visuals;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function cleanCoordinate(value) {
    return Number(value.toFixed(3));
  }

  function tabGeometry(index, count) {
    const safeCount = Math.max(Number(count) || 1, 1);
    const safeIndex = Math.min(Math.max(Number(index) || 0, 0), safeCount - 1);
    const width = 1240 / safeCount;
    const x = cleanCoordinate(safeIndex * width);
    const end = cleanCoordinate((safeIndex + 1) * width);
    const last = safeIndex === safeCount - 1;
    const shoulderTop = cleanCoordinate(end - (last ? 32 : 22));
    const shoulderControl = cleanCoordinate(end - (last ? 19 : 9));
    const shoulderTurn = cleanCoordinate(end - (last ? 12 : 2));
    const shoulderEnd = cleanCoordinate(end + (last ? 0 : 14));
    const fill = `M${x} 60V34Q${x} 18 ${cleanCoordinate(x + 15)} 12Q${cleanCoordinate(x + 19)} 10 ${cleanCoordinate(x + 26)} 10H${shoulderTop}Q${shoulderControl} 10 ${shoulderTurn} 22L${shoulderEnd} 43V60Z`;
    const edge = `M${x} 58V34Q${x} 18 ${cleanCoordinate(x + 15)} 12Q${cleanCoordinate(x + 19)} 10 ${cleanCoordinate(x + 26)} 10H${shoulderTop}Q${shoulderControl} 10 ${shoulderTurn} 22L${shoulderEnd} 43V58`;
    return { x, fill, edge };
  }

  function className(prefix, suffix) {
    return `${prefix}-${suffix}`;
  }

  function inactiveTabPaths(count, prefix) {
    return Array.from({ length: count }, (_, index) => index)
      .reverse()
      .map(index => `<path class="${className(prefix, 'folder-inactive-tab')}" d="${tabGeometry(index, count).fill}"/>`)
      .join('');
  }

  function normalizeFolderOptions(options) {
    if (typeof options === 'number') return { tabCount: options };
    return options && typeof options === 'object' ? options : {};
  }

  function folderArtwork(options = {}) {
    const config = normalizeFolderOptions(options);
    const tabCount = Math.max(Number(config.tabCount) || 4, 1);
    const activeIndex = Math.min(Math.max(Number(config.activeIndex) || 0, 0), tabCount - 1);
    const prefix = String(config.classPrefix || 'talent');
    const idPrefix = String(config.idPrefix || prefix);
    const includeInactive = config.includeInactive !== false;
    const active = tabGeometry(activeIndex, tabCount);
    const inactive = includeInactive ? inactiveTabPaths(tabCount, prefix) : '';
    return `<svg class="${className(prefix, 'folder-art')}" viewBox="0 0 1240 434" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="${idPrefix}-tab-paper" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbf0da"/><stop offset="1" stop-color="#f6e9ce"/></linearGradient><linearGradient id="${idPrefix}-folder-paper" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fffdf8"/><stop offset=".48" stop-color="#fffaf0"/><stop offset="1" stop-color="#fff8ec"/></linearGradient><pattern id="${idPrefix}-paper-grain" width="10" height="10" patternUnits="userSpaceOnUse"><circle cx="2" cy="3" r=".45" fill="#9a7d50" opacity=".09"/><circle cx="8" cy="7" r=".35" fill="#9a7d50" opacity=".07"/></pattern><filter id="${idPrefix}-folder-shadow" x="-10%" y="-10%" width="120%" height="140%"><feDropShadow dx="0" dy="13" stdDeviation="15" flood-color="#273746" flood-opacity=".08"/></filter></defs><g class="${className(prefix, 'folder-inactive-tabs')}">${inactive}</g><path class="${className(prefix, 'folder-shadow')}" d="M0 58H1240V415Q1240 432 1223 432H17Q0 432 0 415Z"/><path class="${className(prefix, 'folder-paper')}" d="M0 58H1240V415Q1240 432 1223 432H17Q0 432 0 415Z"/><path class="${className(prefix, 'folder-grain')}" d="M0 58H1240V415Q1240 432 1223 432H17Q0 432 0 415Z" fill="url(#${idPrefix}-paper-grain)" opacity=".7"/><path class="${className(prefix, 'folder-front-lip')}" d="M0 58H1240V85H0Z"/><path class="${className(prefix, 'folder-outer-edge')}" d="M0 58V415Q0 432 17 432H1223Q1240 432 1240 415V58"/><path class="${className(prefix, 'folder-top-transition')}" d="M0 58H1240"/><path class="${className(prefix, 'folder-front-seam')}" d="M0 85H1240"/><g class="${className(prefix, 'folder-active-tab')}"><path class="${className(prefix, 'folder-active-fill')}" d="${active.fill}"/><path class="${className(prefix, 'folder-active-edge')}" d="${active.edge}"/></g></svg>`;
  }

  function paperclipArtwork(options = {}) {
    const prefix = String(options.classPrefix || 'talent');
    return `<svg class="${className(prefix, 'paperclip')}" viewBox="0 0 48 110" aria-hidden="true"><path class="${className(prefix, 'paperclip-wire')}" d="M31 13.5C31 2.5 8 2.5 8 22v70c0 15 23 15 23 0V28c0-9-12-9-12 0v63"/><path class="${className(prefix, 'paperclip-divider')}" d="M29 15H48"/></svg>`;
  }

  function escapeText(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function portraitPlaceholder(initials, options = {}) {
    const prefix = String(options.idPrefix || 'talent');
    return `<svg viewBox="0 0 160 190" aria-hidden="true"><defs><linearGradient id="${prefix}-portrait-backdrop" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2f5e88"/><stop offset="1" stop-color="#7fa7c3"/></linearGradient></defs><rect width="160" height="190" fill="url(#${prefix}-portrait-backdrop)"/><circle cx="80" cy="64" r="29" fill="#e3edf4" fill-opacity=".68"/><path d="M22 190c4-52 25-82 58-82s54 30 58 82z" fill="#dbe8f1" fill-opacity=".56"/></svg><span>${escapeText(initials)}</span>`;
  }

  function resizeFolderArtwork(art, bodyHeight, options = {}) {
    if (!art) return;
    const prefix = String(options.classPrefix || 'talent');
    const height = Math.max(374, Math.ceil(Number(bodyHeight) || 0));
    const bottom = 58 + height;
    const curveStart = bottom - 17;
    const viewBoxHeight = bottom + 2;
    const bodyPath = `M0 58H1240V${curveStart}Q1240 ${bottom} 1223 ${bottom}H17Q0 ${bottom} 0 ${curveStart}Z`;
    const edgePath = `M0 58V${curveStart}Q0 ${bottom} 17 ${bottom}H1223Q1240 ${bottom} 1240 ${curveStart}V58`;
    art.setAttribute('viewBox', `0 0 1240 ${viewBoxHeight}`);
    art.style.height = `${viewBoxHeight + 8}px`;
    art.querySelector(`.${className(prefix, 'folder-shadow')}`)?.setAttribute('d', bodyPath);
    art.querySelector(`.${className(prefix, 'folder-paper')}`)?.setAttribute('d', bodyPath);
    art.querySelector(`.${className(prefix, 'folder-grain')}`)?.setAttribute('d', bodyPath);
    art.querySelector(`.${className(prefix, 'folder-outer-edge')}`)?.setAttribute('d', edgePath);
  }

  return Object.freeze({ cleanCoordinate, folderArtwork, inactiveTabPaths, paperclipArtwork, portraitPlaceholder, resizeFolderArtwork, tabGeometry });
});
