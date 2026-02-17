(() => {
  const state = {
    context: null,
    allFields: [],
    filteredFields: [],
    selectedFieldApiName: null,
    lastScan: null,
    searchDebounceTimer: null,
    scanMode: 'quick',
    flsFilter: 'all'
  };

  const el = {
    brandLinkBtn: document.getElementById('brandLinkBtn'),
    contextLine: document.getElementById('contextLine'),
    closeBtn: document.getElementById('closeBtn'),
    errorBanner: document.getElementById('errorBanner'),
    warningBanner: document.getElementById('warningBanner'),
    recordFieldPicker: document.getElementById('recordFieldPicker'),
    fieldSearchInput: document.getElementById('fieldSearchInput'),
    fieldSelect: document.getElementById('fieldSelect'),
    scanBtn: document.getElementById('scanBtn'),
    copyBtn: document.getElementById('copyBtn'),
    modeQuickBtn: document.getElementById('modeQuickBtn'),
    modeDeepBtn: document.getElementById('modeDeepBtn'),
    loadingState: document.getElementById('loadingState'),
    loadingTextValue: document.getElementById('loadingTextValue'),
    emptyState: document.getElementById('emptyState'),
    resultsContainer: document.getElementById('resultsContainer'),
    flsControls: document.getElementById('flsControls'),
    flsCounters: document.getElementById('flsCounters')
  };

  const pendingRequestMap = new Map();
  let requestIdCounter = 0;

  setupEvents();
  setScanMode('quick');
  syncFlsFilterButtons();
  notifyParent({ source: 'fieldlens-panel', type: 'PANEL_READY' });

  window.addEventListener('message', (event) => {
    if (!isParentMessage(event)) {
      return;
    }

    const message = event.data;
    if (message.type === 'CONTEXT_UPDATE') {
      onContextUpdate(message.payload);
      return;
    }

    if (message.type === 'RESPONSE') {
      onResponse(message.payload);
    }
  });

  function setupEvents() {
    el.brandLinkBtn.addEventListener('click', () => {
      notifyParent({
        source: 'fieldlens-panel',
        type: 'OPEN_LINK',
        url: 'https://techfilabs.com'
      });
    });

    el.closeBtn.addEventListener('click', () => {
      notifyParent({ source: 'fieldlens-panel', type: 'CLOSE_PANEL' });
    });

    el.scanBtn.addEventListener('click', runScan);
    el.modeQuickBtn.addEventListener('click', () => setScanMode('quick'));
    el.modeDeepBtn.addEventListener('click', () => setScanMode('deep'));

    el.copyBtn.addEventListener('click', async () => {
      if (!state.lastScan) {
        return;
      }

      const markdown = buildMarkdownSummary(state.lastScan);
      try {
        await requestParent('copyToClipboard', { text: markdown });
        showWarning('Summary copied to clipboard.');
      } catch (_) {
        showError('Could not copy summary on this page due to browser policy.');
      }
    });

    el.fieldSearchInput.addEventListener('input', () => {
      clearTimeout(state.searchDebounceTimer);
      state.searchDebounceTimer = setTimeout(() => {
        applyFieldFilter(el.fieldSearchInput.value || '');
      }, 250);
    });

    el.fieldSelect.addEventListener('change', () => {
      state.selectedFieldApiName = el.fieldSelect.value || null;
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        notifyParent({ source: 'fieldlens-panel', type: 'CLOSE_PANEL' });
      }
    });

    if (el.flsControls) {
      el.flsControls.addEventListener('click', (event) => {
        const button = event.target.closest('[data-fls-filter]');
        if (!button) {
          return;
        }
        const next = button.getAttribute('data-fls-filter') || 'all';
        setFlsFilter(next);
      });
    }
  }

  async function onContextUpdate(context) {
    const previous = state.context;
    const sameContext =
      previous &&
      previous.pageType === context?.pageType &&
      previous.objectApiName === context?.objectApiName &&
      previous.fieldApiName === context?.fieldApiName;
    if (sameContext) {
      return;
    }

    state.context = context;
    state.lastScan = null;
    el.copyBtn.disabled = true;
    hideFlsControls();
    hideAllNotices();
    resetResults();

    if (!context || !context.isSupportedPage) {
      el.contextLine.textContent = context?.message || 'Unsupported page';
      el.recordFieldPicker.classList.add('hidden');
      el.scanBtn.disabled = true;
      showError('Open a Lightning record page or Object Manager field detail page.');
      return;
    }

    if (context.pageType === 'setupField') {
      el.contextLine.textContent = `${context.objectApiName}.${context.fieldApiName}`;
      el.recordFieldPicker.classList.add('hidden');
      el.scanBtn.disabled = false;
      state.selectedFieldApiName = context.fieldApiName;
      return;
    }

    if (context.pageType === 'recordPage') {
      el.contextLine.textContent = `Record page: ${context.objectApiName}`;
      el.recordFieldPicker.classList.remove('hidden');
      el.scanBtn.disabled = false;
      await loadObjectFields(context.objectApiName);
    }
  }

  async function loadObjectFields(objectApiName) {
    showLoading('Loading object fields...');

    try {
      const response = await requestParent('loadFields', { objectApiName });
      state.allFields = Array.isArray(response.fields) ? response.fields : [];
      applyFieldFilter(el.fieldSearchInput.value || '');

      if (!state.allFields.length) {
        showError('No fields found or Tooling API access is unavailable for FieldDefinition.');
      } else {
        hideError();
      }
    } catch (error) {
      showError(error.message || 'Failed to load fields for this object.');
    } finally {
      hideLoading();
    }
  }

  function applyFieldFilter(term) {
    const normalizedTerm = term.trim().toLowerCase();
    state.filteredFields = state.allFields.filter((field) => {
      if (!normalizedTerm) {
        return true;
      }
      const searchable = `${field.label} ${field.apiName}`.toLowerCase();
      return searchable.includes(normalizedTerm);
    });

    renderFieldOptions();
  }

  function renderFieldOptions() {
    el.fieldSelect.innerHTML = '';

    if (!state.filteredFields.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No matching fields';
      opt.disabled = true;
      opt.selected = true;
      el.fieldSelect.appendChild(opt);
      state.selectedFieldApiName = null;
      return;
    }

    for (const field of state.filteredFields) {
      const opt = document.createElement('option');
      opt.value = field.apiName;
      opt.textContent = `${field.label} (${field.apiName}) [${field.dataType}]`;
      el.fieldSelect.appendChild(opt);
    }

    if (!state.selectedFieldApiName || !state.filteredFields.some((field) => field.apiName === state.selectedFieldApiName)) {
      state.selectedFieldApiName = state.filteredFields[0].apiName;
    }
    el.fieldSelect.value = state.selectedFieldApiName;
  }

  async function runScan() {
    if (!state.context || !state.context.isSupportedPage) {
      showError('This page is not supported.');
      return;
    }

    const objectApiName = state.context.objectApiName;
    const fieldApiName = state.context.pageType === 'setupField' ? state.context.fieldApiName : state.selectedFieldApiName;

    if (!objectApiName || !fieldApiName) {
      showError('Select a field before running the scan.');
      return;
    }

    hideAllNotices();
    resetResults();
    showLoading('Scanning references...');

    try {
      const result = await requestParent('scanImpact', { objectApiName, fieldApiName, scanMode: state.scanMode });
      state.lastScan = result;
      el.copyBtn.disabled = false;
      renderScanResult(result);

      if (Array.isArray(result.warnings) && result.warnings.length) {
        showWarning(result.warnings.join(' | '));
      }
    } catch (error) {
      showError(error.message || 'Impact scan failed.');
      el.copyBtn.disabled = true;
    } finally {
      hideLoading();
    }
  }

  function renderScanResult(result) {
    renderFlsControls(result);

    const flsAll = Array.isArray(result.groups?.fieldPermissions) ? result.groups.fieldPermissions : [];
    const flsFiltered = filterFlsItems(flsAll, state.flsFilter);
    const groups = [
      { key: 'validationRules', label: 'Validation Rules' },
      { key: 'apexClasses', label: 'Apex Classes' },
      { key: 'apexTriggers', label: 'Apex Triggers' },
      { key: 'flows', label: 'Flows (Best Effort)' },
      { key: 'fieldPermissions', label: 'FLS / Permissions', itemsOverride: flsFiltered, totalCount: flsAll.length }
    ];

    el.resultsContainer.innerHTML = '';
    let total = 0;

    for (const group of groups) {
      const items =
        group.itemsOverride || (Array.isArray(result.groups?.[group.key]) ? result.groups[group.key] : []);
      total += items.length;

      const card = document.createElement('article');
      card.className = 'result-group';

      const head = document.createElement('header');
      head.className = 'result-group-header';
      const countLabel =
        typeof group.totalCount === 'number' && group.totalCount !== items.length
          ? `${items.length}/${group.totalCount}`
          : `${items.length}`;
      head.innerHTML = `<span>${group.label}</span><span>${countLabel}</span>`;
      card.appendChild(head);

      const list = document.createElement('ul');
      list.className = 'result-list';

      if (!items.length) {
        const li = document.createElement('li');
        li.className = 'result-item';
        li.innerHTML = '<span class="result-link"><span class="result-subtitle">No references</span></span>';
        list.appendChild(li);
      } else {
        for (const item of items) {
          const li = document.createElement('li');
          li.className = 'result-item';
          const url = item.url || '#';
          li.innerHTML = `
            <a href="${escapeHtml(url)}" data-url="${escapeHtml(url)}" class="result-link" target="_blank" rel="noopener noreferrer">
              <span class="result-name">${escapeHtml(item.name || item.id || 'Unnamed')}</span>
              <span class="result-subtitle">${escapeHtml(item.subtitle || '')}</span>
            </a>
          `;
          list.appendChild(li);
        }
      }

      card.appendChild(list);
      el.resultsContainer.appendChild(card);
    }

    el.resultsContainer.querySelectorAll('[data-url]').forEach((node) => {
      node.addEventListener('click', (event) => {
        event.preventDefault();
        const url = node.getAttribute('data-url');
        if (url && url !== '#') {
          notifyParent({ source: 'fieldlens-panel', type: 'OPEN_LINK', url });
        }
      });
    });

    if (total === 0) {
      el.emptyState.classList.remove('hidden');
      el.resultsContainer.classList.add('hidden');
    } else {
      el.emptyState.classList.add('hidden');
      el.resultsContainer.classList.remove('hidden');
    }
  }

  function buildMarkdownSummary(result) {
    const lines = [];
    lines.push('# FieldLens Impact Summary');
    lines.push('');
    lines.push(`- Object: ${result.objectApiName}`);
    lines.push(`- Field: ${result.fieldApiName}`);
    lines.push(`- Scan Mode: ${result.scanMode || state.scanMode}`);
    lines.push(`- Generated: ${new Date(result.generatedAt || Date.now()).toISOString()}`);
    lines.push('');

    const mapping = [
      ['Validation Rules', result.groups?.validationRules || []],
      ['Apex Classes', result.groups?.apexClasses || []],
      ['Apex Triggers', result.groups?.apexTriggers || []],
      ['Flows (Best Effort)', result.groups?.flows || []],
      ['FLS / Permissions', result.groups?.fieldPermissions || []]
    ];

    for (const [title, items] of mapping) {
      lines.push(`## ${title} (${items.length})`);
      if (!items.length) {
        lines.push('- No references found');
      } else {
        for (const item of items) {
          lines.push(`- ${item.name || item.id}${item.url ? ` - ${item.url}` : ''}`);
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  function onResponse(payload) {
    if (!payload || typeof payload.requestId !== 'number') {
      return;
    }

    const pending = pendingRequestMap.get(payload.requestId);
    if (!pending) {
      return;
    }

    pendingRequestMap.delete(payload.requestId);
    if (payload.ok) {
      pending.resolve(payload.data);
    } else {
      pending.reject(payload.error || { message: 'Unknown panel response failure.' });
    }
  }

  function requestParent(action, payload) {
    const requestId = ++requestIdCounter;
    notifyParent({ source: 'fieldlens-panel', type: 'REQUEST', action, payload, requestId });

    return new Promise((resolve, reject) => {
      pendingRequestMap.set(requestId, { resolve, reject });

      setTimeout(() => {
        if (pendingRequestMap.has(requestId)) {
          pendingRequestMap.delete(requestId);
          reject({ code: 'TIMEOUT', message: 'Request timed out while waiting for extension response.' });
        }
      }, 45000);
    });
  }

  function notifyParent(message) {
    window.parent.postMessage(message, '*');
  }

  function isParentMessage(event) {
    return event.data?.source === 'fieldlens-content';
  }

  function showLoading(text) {
    el.loadingTextValue.textContent = text || 'Loading...';
    el.loadingState.classList.remove('hidden');
  }

  function hideLoading() {
    el.loadingState.classList.add('hidden');
  }

  function showError(message) {
    el.errorBanner.textContent = message;
    el.errorBanner.classList.remove('hidden');
  }

  function hideError() {
    el.errorBanner.classList.add('hidden');
    el.errorBanner.textContent = '';
  }

  function showWarning(message) {
    el.warningBanner.textContent = message;
    el.warningBanner.classList.remove('hidden');
  }

  function hideWarning() {
    el.warningBanner.classList.add('hidden');
    el.warningBanner.textContent = '';
  }

  function hideAllNotices() {
    hideError();
    hideWarning();
  }

  function resetResults() {
    el.resultsContainer.classList.add('hidden');
    el.resultsContainer.innerHTML = '';
    el.emptyState.classList.add('hidden');
    hideFlsControls();
  }

  function setScanMode(mode) {
    state.scanMode = mode === 'deep' ? 'deep' : 'quick';
    el.modeQuickBtn.classList.toggle('mode-btn-active', state.scanMode === 'quick');
    el.modeDeepBtn.classList.toggle('mode-btn-active', state.scanMode === 'deep');
    el.modeQuickBtn.setAttribute('aria-pressed', state.scanMode === 'quick' ? 'true' : 'false');
    el.modeDeepBtn.setAttribute('aria-pressed', state.scanMode === 'deep' ? 'true' : 'false');
  }

  function setFlsFilter(filter) {
    const allowed = new Set(['all', 'profile', 'permissionSet', 'readEdit', 'read']);
    state.flsFilter = allowed.has(filter) ? filter : 'all';
    syncFlsFilterButtons();
    if (state.lastScan) {
      renderScanResult(state.lastScan);
    }
  }

  function syncFlsFilterButtons() {
    if (!el.flsControls) {
      return;
    }
    el.flsControls.querySelectorAll('[data-fls-filter]').forEach((btn) => {
      const active = btn.getAttribute('data-fls-filter') === state.flsFilter;
      btn.classList.toggle('fls-filter-btn-active', active);
    });
  }

  function renderFlsControls(result) {
    const items = Array.isArray(result.groups?.fieldPermissions) ? result.groups.fieldPermissions : [];
    if (!items.length || !el.flsControls || !el.flsCounters) {
      hideFlsControls();
      return;
    }

    const counters = {
      total: items.length,
      readEdit: items.filter((x) => x.accessType === 'readEdit').length,
      read: items.filter((x) => x.accessType === 'read').length,
      profile: items.filter((x) => x.permissionType === 'profile').length
    };

    el.flsCounters.innerHTML = [
      counterHtml('Total', counters.total),
      counterHtml('Read+Edit', counters.readEdit),
      counterHtml('Read only', counters.read),
      counterHtml('Profiles', counters.profile)
    ].join('');
    el.flsControls.classList.remove('hidden');
    syncFlsFilterButtons();
  }

  function hideFlsControls() {
    if (el.flsControls) {
      el.flsControls.classList.add('hidden');
    }
  }

  function filterFlsItems(items, filter) {
    switch (filter) {
      case 'profile':
        return items.filter((x) => x.permissionType === 'profile');
      case 'permissionSet':
        return items.filter((x) => x.permissionType === 'permissionSet');
      case 'readEdit':
        return items.filter((x) => x.accessType === 'readEdit');
      case 'read':
        return items.filter((x) => x.accessType === 'read');
      default:
        return items;
    }
  }

  function counterHtml(key, value) {
    return `<div class=\"fls-counter\"><span class=\"fls-counter-key\">${escapeHtml(key)}</span><span class=\"fls-counter-value\">${value}</span></div>`;
  }

  function escapeHtml(input) {
    return String(input || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
})();
