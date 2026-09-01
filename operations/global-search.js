/* Accessible, role-aware global search presentation for Clients and Talent.
   Data loading and navigation stay injectable so the operations shell remains
   the single authority for database access and profile routing. */
(function (window, document) {
  'use strict';

  const MIN_QUERY_LENGTH = 2;
  const DEBOUNCE_MS = 250;
  const MAX_RESULTS_PER_GROUP = 5;
  const TYPE_ORDER = ['client', 'talent'];
  const TYPE_LABELS = Object.freeze({ client: 'Clients', talent: 'Talent' });
  const ROLE_TYPES = Object.freeze({
    admin: ['client', 'talent'],
    talent_management: ['client', 'talent'],
    talent: ['client', 'talent'],
    sales: ['client', 'talent'],
    sales_management: ['client', 'talent'],
    billing: ['client']
  });

  let activeController = null;
  let sharedOptions = {};

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function normalizedRole(value) {
    return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  }

  function searchTypesForRole(value) {
    return (ROLE_TYPES[normalizedRole(value)] || []).slice();
  }

  function placeholderForTypes(types) {
    if (types.includes('client') && types.includes('talent')) return 'Search clients and Talent…';
    if (types.includes('client')) return 'Search clients…';
    if (types.includes('talent')) return 'Search Talent…';
    return 'Search clients and Talent…';
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function firstText() {
    for (const value of arguments) {
      const text = String(value ?? '').trim();
      if (text) return text;
    }
    return '';
  }

  function titleCase(value) {
    return String(value || '').replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
  }

  function clientContact(record) {
    const direct = record.primary_contact || record.primaryContact;
    if (direct) return direct;
    const contacts = asArray(record.client_contacts || record.contacts);
    return contacts.find(contact => String(contact?.contact_role || '').toLowerCase() === 'primary') || contacts[0] || {};
  }

  function normalizeRecord(record, entityType) {
    if (!record || typeof record !== 'object') return null;
    const safeEntityType = firstText(record.entityType, entityType).toLowerCase();
    if (!TYPE_ORDER.includes(safeEntityType)) return null;
    const id = firstText(record.recordId, record.id, record.client_id, record.applicant_id);
    if (!id) return null;

    if (safeEntityType === 'client') {
      const contact = clientContact(record);
      const label = firstText(record.primaryLabel, record.label, record.company_name, record.companyName, record.name);
      if (!label) return null;
      const backendSubtitle = firstText(record.secondaryLabel);
      const detailParts = backendSubtitle ? [backendSubtitle] : [
        firstText(record.subtitle, contact.full_name, contact.fullName), firstText(record.industry),
        record.lifecycle_stage ? titleCase(record.lifecycle_stage) : ''
      ].filter(Boolean);
      const statusLabel = firstText(record.statusLabel);
      const matchedOn = firstText(record.matchedOn);
      const meta = statusLabel || firstText(record.meta, contact.email, record.email);
      return {
        kind: 'record',
        entityType: safeEntityType,
        id, recordId: id,
        label, primaryLabel: label,
        subtitle: detailParts.join(' · '),
        secondaryLabel: detailParts.join(' · '),
        meta, statusLabel, matchedOn
      };
    }

    const label = firstText(record.primaryLabel, record.label, record.display_name, record.displayName, record.full_name, record.fullName, record.name);
    if (!label) return null;
    const backendSubtitle = firstText(record.secondaryLabel);
    const detailParts = backendSubtitle ? [backendSubtitle] : [
      firstText(record.subtitle, record.preferred_name && `Goes by ${record.preferred_name}`, record.email),
      firstText(record.va_type, record.vaType), record.status ? titleCase(record.status) : ''
    ].filter(Boolean);
    const statusLabel = firstText(record.statusLabel);
    const matchedOn = firstText(record.matchedOn);
    const meta = statusLabel || firstText(record.meta, record.email);
    return {
      kind: 'record',
      entityType: safeEntityType,
      id, recordId: id,
      label, primaryLabel: label,
      subtitle: detailParts.join(' · '),
      secondaryLabel: detailParts.join(' · '),
      meta, statusLabel, matchedOn
    };
  }

  function payloadRecords(payload, type) {
    const combined = asArray(payload?.results || payload?.records).filter(record => firstText(record?.entityType).toLowerCase() === type);
    if (combined.length) return combined;
    if (type === 'client') return asArray(payload?.clients || payload?.clientResults);
    return asArray(payload?.talent || payload?.talents || payload?.applicants || payload?.talentResults);
  }

  function payloadTotal(payload, type, fallback) {
    const candidates = type === 'client'
      ? [payload?.clientTotal, payload?.clientsTotal, payload?.totals?.clients]
      : [payload?.talentTotal, payload?.talentsTotal, payload?.applicantTotal, payload?.totals?.talent];
    const total = candidates.map(Number).find(Number.isFinite);
    return total == null ? fallback : Math.max(0, total);
  }

  function payloadHasMore(payload, type) {
    const value = type === 'client'
      ? (payload?.clientHasMore ?? payload?.clientsHasMore ?? payload?.hasMore?.clients)
      : (payload?.talentHasMore ?? payload?.talentsHasMore ?? payload?.hasMore?.talent);
    return value === true;
  }

  function normalizePayload(payload, types, maxPerGroup = MAX_RESULTS_PER_GROUP) {
    const allowed = new Set(types);
    return TYPE_ORDER.filter(type => allowed.has(type)).map(type => {
      const source = payloadRecords(payload, type);
      const seen = new Set();
      const normalized = [];
      for (const record of source) {
        const item = normalizeRecord(record, type);
        if (!item) continue;
        const key = `${type}:${item.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        normalized.push(item);
      }
      const total = Math.max(payloadTotal(payload, type, normalized.length), normalized.length);
      return {
        type,
        label: TYPE_LABELS[type],
        items: normalized.slice(0, maxPerGroup),
        total,
        hasMore: payloadHasMore(payload, type) || total > maxPerGroup || normalized.length > maxPerGroup
      };
    }).filter(group => group.items.length);
  }

  function resultEntries(groups, query) {
    const entries = [];
    groups.forEach(group => {
      group.items.forEach(item => entries.push(item));
      if (group.hasMore) {
        entries.push({
          kind: 'view-all',
          entityType: group.type,
          query,
          label: `View all ${group.label} matches`
        });
      }
    });
    return entries;
  }

  function optionMarkup(item, index, listboxId, activeIndex) {
    const selected = index === activeIndex;
    const optionId = `${listboxId}-option-${index}`;
    if (item.kind === 'view-all') {
      return `<button class="soro-global-search-option soro-global-search-view-all${selected ? ' is-active' : ''}" id="${optionId}" type="button" role="option" tabindex="-1" aria-selected="${selected}" data-global-search-index="${index}"><span>${escapeHtml(item.label)}</span><span aria-hidden="true">→</span></button>`;
    }
    const shortType = item.entityType === 'client' ? 'C' : 'T';
    return `<button class="soro-global-search-option${selected ? ' is-active' : ''}" id="${optionId}" type="button" role="option" tabindex="-1" aria-selected="${selected}" data-global-search-index="${index}"><span class="soro-global-search-type" aria-hidden="true">${shortType}</span><span class="soro-global-search-copy"><strong>${escapeHtml(item.label)}</strong>${item.subtitle ? `<small>${escapeHtml(item.subtitle)}</small>` : ''}${item.meta && !item.subtitle.includes(item.meta) ? `<small>${escapeHtml(item.meta)}</small>` : ''}</span></button>`;
  }

  function resultsMarkup(groups, query, listboxId, activeIndex) {
    const entries = resultEntries(groups, query);
    let cursor = 0;
    const markup = groups.map(group => {
      const groupId = `${listboxId}-${group.type}-heading`;
      const optionCount = group.items.length + (group.hasMore ? 1 : 0);
      const options = entries.slice(cursor, cursor + optionCount).map((item, offset) => optionMarkup(item, cursor + offset, listboxId, activeIndex)).join('');
      cursor += optionCount;
      return `<section class="soro-global-search-group" role="group" aria-labelledby="${groupId}"><h3 id="${groupId}">${escapeHtml(group.label)}</h3>${options}</section>`;
    }).join('');
    return { entries, markup };
  }

  function stateMarkup(kind, message) {
    const icon = kind === 'loading' ? '<span class="soro-global-search-spinner" aria-hidden="true"></span>' : '';
    return `<div class="soro-global-search-state soro-global-search-state--${escapeHtml(kind)}" role="status">${icon}<span>${escapeHtml(message)}</span></div>`;
  }

  function isAbortError(error) {
    return error?.name === 'AbortError' || error?.code === 20;
  }

  function createController(options = {}) {
    const input = document.getElementById('global-search');
    if (!input) return null;
    const originalField = input.closest('.global-search');
    if (!originalField || originalField.dataset.globalSearchEnhanced === 'true') return activeController;

    const listboxId = 'soro-global-search-listbox';
    const host = document.createElement('div');
    host.className = 'global-search soro-global-search-host';
    host.dataset.globalSearchEnhanced = 'true';
    originalField.parentNode.insertBefore(host, originalField);
    host.append(originalField);
    originalField.classList.remove('global-search');
    originalField.classList.add('soro-global-search-field');

    const popup = document.createElement('div');
    popup.className = 'soro-global-search-popup';
    popup.id = listboxId;
    popup.setAttribute('role', 'listbox');
    popup.setAttribute('aria-label', 'Search results');
    popup.hidden = true;
    host.append(popup);

    input.type = 'search';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-haspopup', 'listbox');
    input.setAttribute('aria-controls', listboxId);
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-label', 'Search clients and Talent');

    let config = { ...options };
    let timer = null;
    let abortController = null;
    let requestSequence = 0;
    let entries = [];
    let groups = [];
    let activeIndex = -1;
    let lastQuery = '';
    let destroyed = false;

    function effectiveRole() {
      if (typeof config.getEffectiveRole === 'function') return config.getEffectiveRole();
      if (typeof window.currentAuthenticatedRole === 'function') return window.currentAuthenticatedRole();
      return window.soroCurrentAccess?.role || '';
    }

    function currentTypes() {
      return searchTypesForRole(effectiveRole());
    }

    function refreshRole() {
      const types = currentTypes();
      input.placeholder = placeholderForTypes(types);
      input.setAttribute('aria-label', types.length === 1 ? 'Search clients' : 'Search clients and Talent');
      if (!types.length) closePopup();
      return types;
    }

    function setExpanded(expanded) {
      popup.hidden = !expanded;
      input.setAttribute('aria-expanded', String(expanded));
      if (!expanded) input.removeAttribute('aria-activedescendant');
    }

    function closePopup() {
      setExpanded(false);
      activeIndex = -1;
    }

    function openState(kind, message, busy = false) {
      groups = [];
      entries = [];
      activeIndex = -1;
      popup.setAttribute('aria-busy', String(busy));
      popup.innerHTML = stateMarkup(kind, message);
      setExpanded(true);
    }

    function renderResults(nextGroups, query, preferredIndex = 0) {
      groups = nextGroups;
      const initial = resultsMarkup(groups, query, listboxId, -1);
      entries = initial.entries;
      activeIndex = entries.length ? Math.max(0, Math.min(preferredIndex, entries.length - 1)) : -1;
      const rendered = resultsMarkup(groups, query, listboxId, activeIndex);
      popup.removeAttribute('aria-busy');
      popup.innerHTML = rendered.markup;
      setExpanded(true);
      syncActiveDescendant();
    }

    function syncActiveDescendant() {
      popup.querySelectorAll('[role="option"]').forEach((option, index) => {
        const selected = index === activeIndex;
        option.classList.toggle('is-active', selected);
        option.setAttribute('aria-selected', String(selected));
      });
      if (activeIndex < 0) {
        input.removeAttribute('aria-activedescendant');
        return;
      }
      const active = popup.querySelector(`[data-global-search-index="${activeIndex}"]`);
      if (active) {
        input.setAttribute('aria-activedescendant', active.id);
        active.scrollIntoView?.({ block: 'nearest' });
      }
    }

    function moveActive(direction) {
      if (!entries.length) return;
      activeIndex = activeIndex < 0
        ? (direction > 0 ? 0 : entries.length - 1)
        : (activeIndex + direction + entries.length) % entries.length;
      syncActiveDescendant();
    }

    function emitSelection(result) {
      const event = new CustomEvent('soro:global-search-select', {
        detail: { result },
        bubbles: false,
        cancelable: true
      });
      const proceed = window.dispatchEvent(event);
      if (proceed && typeof config.navigateResult === 'function') config.navigateResult(result);
    }

    function selectIndex(index) {
      const result = entries[index];
      if (!result) return;
      if (result.kind === 'record') input.value = result.label;
      closePopup();
      emitSelection({ ...result });
    }

    async function runSearch(expectedQuery) {
      if (destroyed) return;
      const query = String(expectedQuery ?? input.value).trim();
      const types = refreshRole();
      if (query.length < MIN_QUERY_LENGTH || !types.length) return closePopup();
      if (typeof config.searchRecords !== 'function') {
        openState('error', 'Search is still loading. Please try again.');
        return;
      }

      abortController?.abort();
      abortController = new AbortController();
      const request = ++requestSequence;
      lastQuery = query;
      openState('loading', 'Searching…', true);
      try {
        const payload = await config.searchRecords({
          query,
          types: types.slice(),
          limit: MAX_RESULTS_PER_GROUP + 1,
          signal: abortController.signal
        });
        if (destroyed || request !== requestSequence || query !== String(input.value).trim()) return;
        const normalized = normalizePayload(payload, types);
        if (!normalized.length) {
          openState('empty', types.length === 1 ? 'No matching clients found.' : 'No matching clients or Talent found.');
          return;
        }
        renderResults(normalized, query, 0);
      } catch (error) {
        if (isAbortError(error) || destroyed || request !== requestSequence) return;
        openState('error', 'Search is temporarily unavailable. Please try again.');
      }
    }

    function scheduleSearch(delay = DEBOUNCE_MS) {
      if (timer) window.clearTimeout(timer);
      const query = String(input.value || '').trim();
      if (!query) return closePopup();
      if (query.length < MIN_QUERY_LENGTH) {
        abortController?.abort();
        openState('hint', `Enter at least ${MIN_QUERY_LENGTH} characters to search.`);
        return;
      }
      timer = window.setTimeout(() => {
        timer = null;
        runSearch(query);
      }, delay);
    }

    function handleInput() {
      activeIndex = -1;
      scheduleSearch();
    }

    function handleFocus() {
      refreshRole();
      const query = String(input.value || '').trim();
      if (query.length < MIN_QUERY_LENGTH) return;
      if (query === lastQuery && entries.length) {
        setExpanded(true);
        syncActiveDescendant();
      } else scheduleSearch(0);
    }

    function handleKeydown(event) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (popup.hidden || !entries.length) scheduleSearch(0);
        else moveActive(event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!popup.hidden && activeIndex >= 0) selectIndex(activeIndex);
        else scheduleSearch(0);
        return;
      }
      if (event.key === 'Escape') {
        if (!popup.hidden) {
          event.preventDefault();
          event.stopImmediatePropagation();
          closePopup();
        }
        return;
      }
      if (event.key === 'Tab') closePopup();
    }

    function handlePopupClick(event) {
      const option = event.target.closest('[data-global-search-index]');
      if (!option) return;
      event.preventDefault();
      selectIndex(Number(option.dataset.globalSearchIndex));
    }

    function handlePopupPointerMove(event) {
      const option = event.target.closest('[data-global-search-index]');
      if (!option) return;
      activeIndex = Number(option.dataset.globalSearchIndex);
      syncActiveDescendant();
    }

    function handleOutsidePointer(event) {
      if (!host.contains(event.target)) closePopup();
    }

    function handleAuthChange() {
      refreshRole();
      if (document.activeElement === input && String(input.value || '').trim().length >= MIN_QUERY_LENGTH) scheduleSearch(0);
    }

    input.addEventListener('input', handleInput);
    input.addEventListener('focus', handleFocus);
    input.addEventListener('keydown', handleKeydown, true);
    popup.addEventListener('click', handlePopupClick);
    popup.addEventListener('pointermove', handlePopupPointerMove);
    document.addEventListener('pointerdown', handleOutsidePointer);
    window.addEventListener('soro-auth-changed', handleAuthChange);
    refreshRole();

    return {
      configure(next = {}) {
        config = { ...config, ...next };
        refreshRole();
        return this;
      },
      refreshRole,
      searchNow() {
        scheduleSearch(0);
      },
      close: closePopup,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        if (timer) window.clearTimeout(timer);
        abortController?.abort();
        input.removeEventListener('input', handleInput);
        input.removeEventListener('focus', handleFocus);
        input.removeEventListener('keydown', handleKeydown, true);
        popup.removeEventListener('click', handlePopupClick);
        popup.removeEventListener('pointermove', handlePopupPointerMove);
        document.removeEventListener('pointerdown', handleOutsidePointer);
        window.removeEventListener('soro-auth-changed', handleAuthChange);
        input.removeAttribute('role');
        input.removeAttribute('aria-autocomplete');
        input.removeAttribute('aria-haspopup');
        input.removeAttribute('aria-controls');
        input.removeAttribute('aria-expanded');
        input.removeAttribute('aria-activedescendant');
        originalField.classList.remove('soro-global-search-field');
        originalField.classList.add('global-search');
        host.parentNode?.insertBefore(originalField, host);
        host.remove();
        activeController = null;
      }
    };
  }

  const api = {
    init(options = {}) {
      sharedOptions = { ...sharedOptions, ...options };
      if (activeController) return activeController.configure(sharedOptions);
      activeController = createController(sharedOptions);
      return activeController;
    },
    setSearchProvider(searchRecords) {
      return this.init({ searchRecords });
    },
    setNavigationHandler(navigateResult) {
      return this.init({ navigateResult });
    },
    setRoleResolver(getEffectiveRole) {
      return this.init({ getEffectiveRole });
    },
    refreshRole() {
      return activeController?.refreshRole() || [];
    },
    destroy() {
      activeController?.destroy();
    },
    __test: Object.freeze({
      MIN_QUERY_LENGTH,
      DEBOUNCE_MS,
      MAX_RESULTS_PER_GROUP,
      searchTypesForRole,
      placeholderForTypes,
      normalizeRecord,
      normalizePayload,
      resultEntries,
      resultsMarkup,
      stateMarkup
    })
  };

  window.SoroGlobalSearch = api;
}(window, document));
