(() => {
  const SCAN_TIMEOUT_MS = Number(globalThis.FIELDLENS_SCAN_TIMEOUT_MS || 30000);
  const state = {
    context: null,
    allFields: [],
    filteredFields: [],
    selectedFieldApiName: null,
    lastScan: null,
    searchDebounceTimer: null,
    resultSearchDebounceTimer: null,
    resultSearchTerm: '',
    scanMode: 'quick',
    flsFilter: 'all',
    loadingMessageTimer: null,
    loadingMessageIndex: 0,
    hideZeroGroups: false,
    settingsLoaded: false,
    lastFailure: null,
    showNoAccessInFallback: false,
    scanTimeoutTimer: null,
    activeScanCorrelationId: null
  };

  const el = {
    brandLinkBtn: document.getElementById('brandLinkBtn'),
    modeBadge: document.getElementById('modeBadge'),
    contextLine: document.getElementById('contextLine'),
    freshnessBadge: document.getElementById('freshnessBadge'),
    closeBtn: document.getElementById('closeBtn'),
    errorBanner: document.getElementById('errorBanner'),
    retryActions: document.getElementById('retryActions'),
    retryLoadBtn: document.getElementById('retryLoadBtn'),
    retryScanBtn: document.getElementById('retryScanBtn'),
    warningBanner: document.getElementById('warningBanner'),
    toast: document.getElementById('toast'),
    nonPermissionableBanner: document.getElementById('nonPermissionableBanner'),
    diagnosticsSection: document.getElementById('diagnosticsSection'),
    diagnosticsCount: document.getElementById('diagnosticsCount'),
    diagnosticsList: document.getElementById('diagnosticsList'),
    recordFieldPicker: document.getElementById('recordFieldPicker'),
    fieldSearchInput: document.getElementById('fieldSearchInput'),
    fieldSelect: document.getElementById('fieldSelect'),
    scanBtn: document.getElementById('scanBtn'),
    copyBtn: document.getElementById('copyBtn'),
    exportCsvBtn: document.getElementById('exportCsvBtn'),
    settingsBtn: document.getElementById('settingsBtn'),
    settingsPanel: document.getElementById('settingsPanel'),
    defaultScanModeSelect: document.getElementById('defaultScanModeSelect'),
    hideZeroGroupsCheckbox: document.getElementById('hideZeroGroupsCheckbox'),
    clearCacheBtn: document.getElementById('clearCacheBtn'),
    modeQuickBtn: document.getElementById('modeQuickBtn'),
    modeDeepBtn: document.getElementById('modeDeepBtn'),
    resultSearchWrap: document.getElementById('resultSearchWrap'),
    resultSearchInput: document.getElementById('resultSearchInput'),
    accordionControls: document.getElementById('accordionControls'),
    expandAllBtn: document.getElementById('expandAllBtn'),
    collapseAllBtn: document.getElementById('collapseAllBtn'),
    loadingState: document.getElementById('loadingState'),
    loadingTextValue: document.getElementById('loadingTextValue'),
    loadingProgressFill: document.getElementById('loadingProgressFill'),
    loadingPercentValue: document.getElementById('loadingPercentValue'),
    emptyState: document.getElementById('emptyState'),
    resultsContainer: document.getElementById('resultsContainer'),
    topImpact: document.getElementById('topImpact'),
    topImpactCount: document.getElementById('topImpactCount'),
    topImpactList: document.getElementById('topImpactList'),
    flsControls: document.getElementById('flsControls'),
    flsCounters: document.getElementById('flsCounters'),
    toggleNoAccessBtn: document.getElementById('toggleNoAccessBtn')
  };

  const pendingRequestMap = new Map();
  let requestIdCounter = 0;

  setupEvents();
  setScanMode('quick', false);
  syncFlsFilterButtons();
  syncNoAccessToggleLabel();
  setModeBadge(false);
  loadUserSettings();
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
    if (el.retryLoadBtn) {
      el.retryLoadBtn.addEventListener('click', retryLoadFields);
    }
    if (el.retryScanBtn) {
      el.retryScanBtn.addEventListener('click', retryScan);
    }

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
        showToast('Copied ✓');
      } catch (_) {
        showError('Could not copy summary on this page due to browser policy.');
      }
    });
    if (el.exportCsvBtn) {
      el.exportCsvBtn.addEventListener('click', () => {
        if (!state.lastScan) {
          return;
        }
        exportCsv(state.lastScan);
      });
    }
    if (el.settingsBtn && el.settingsPanel) {
      el.settingsBtn.addEventListener('click', () => {
        el.settingsPanel.classList.toggle('hidden');
      });
    }
    if (el.defaultScanModeSelect) {
      el.defaultScanModeSelect.addEventListener('change', async () => {
        const next = el.defaultScanModeSelect.value === 'deep' ? 'deep' : 'quick';
        setScanMode(next, false);
        await persistUserSettings();
      });
    }
    if (el.hideZeroGroupsCheckbox) {
      el.hideZeroGroupsCheckbox.addEventListener('change', async () => {
        state.hideZeroGroups = !!el.hideZeroGroupsCheckbox.checked;
        await persistUserSettings();
        if (state.lastScan) {
          renderScanResult(state.lastScan);
        }
      });
    }
    if (el.clearCacheBtn) {
      el.clearCacheBtn.addEventListener('click', async () => {
        el.clearCacheBtn.disabled = true;
        const originalLabel = el.clearCacheBtn.textContent;
        el.clearCacheBtn.textContent = 'Clearing...';
        try {
          const result = await requestParent('clearCache', {});
          const removed = Number(result?.removed || 0);
          showWarning(`Org cache cleared (${removed} entr${removed === 1 ? 'y' : 'ies'} removed). Run scan again for fresh data.`);
          clearFreshness();
        } catch (error) {
          showError(error?.message || 'Failed to clear cache.');
        } finally {
          el.clearCacheBtn.disabled = false;
          el.clearCacheBtn.textContent = originalLabel || 'Clear Org Cache';
        }
      });
    }

    el.resultSearchInput.addEventListener('input', () => {
      clearTimeout(state.resultSearchDebounceTimer);
      state.resultSearchDebounceTimer = setTimeout(() => {
        state.resultSearchTerm = (el.resultSearchInput.value || '').trim().toLowerCase();
        if (state.lastScan) {
          renderScanResult(state.lastScan);
        }
      }, 180);
    });
    if (el.expandAllBtn) {
      el.expandAllBtn.addEventListener('click', () => setAllAccordions(true));
    }
    if (el.collapseAllBtn) {
      el.collapseAllBtn.addEventListener('click', () => setAllAccordions(false));
    }

    el.fieldSearchInput.addEventListener('input', () => {
      clearTimeout(state.searchDebounceTimer);
      state.searchDebounceTimer = setTimeout(() => {
        applyFieldFilter(el.fieldSearchInput.value || '');
      }, 250);
    });

    el.fieldSelect.addEventListener('change', () => {
      state.selectedFieldApiName = el.fieldSelect.value || null;
      if (state.context?.objectApiName && state.selectedFieldApiName && state.context.pageType === 'recordPage') {
        el.contextLine.textContent = `${state.context.objectApiName}.${state.selectedFieldApiName}`;
      }
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
    if (el.toggleNoAccessBtn) {
      el.toggleNoAccessBtn.addEventListener('click', () => {
        state.showNoAccessInFallback = !state.showNoAccessInFallback;
        syncNoAccessToggleLabel();
        if (state.lastScan) {
          renderScanResult(state.lastScan);
        }
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
    state.showNoAccessInFallback = false;
    el.copyBtn.disabled = true;
    if (el.exportCsvBtn) {
      el.exportCsvBtn.disabled = true;
    }
    hideFlsControls();
    hideAllNotices();
    clearRetryState();
    hideDiagnostics();
    clearFreshness();
    resetResults();
    setModeBadge(false);

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
        setRetryState('loadFields', { objectApiName });
      } else {
        hideError();
        clearRetryState();
      }
    } catch (error) {
      console.error('[FieldLens] loadFields failed', error);
      showError(error.message || 'Failed to load fields for this object.');
      setRetryState('loadFields', { objectApiName });
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
      opt.setAttribute('data-testid', 'field-result');
      const nonPermSuffix = field.isPermissionable === false ? ' [NP]' : '';
      opt.textContent = `${field.label} (${field.apiName}) [${field.dataType}]${nonPermSuffix}`;
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
    clearRetryState();
    resetResults();
    startScanLoading();
    setModeBadge(true);
    const scanCorrelationId = `scan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    state.activeScanCorrelationId = scanCorrelationId;
    console.log('[FieldLens] scan started', { scanCorrelationId, objectApiName, fieldApiName, scanMode: state.scanMode });

    try {
      await runScanLifecycleWithTimeout({ objectApiName, fieldApiName, scanMode: state.scanMode, scanCorrelationId });
      console.log('[FieldLens] scan completed', { scanCorrelationId, objectApiName, fieldApiName, scanMode: state.scanMode });
    } catch (error) {
      console.error('[FieldLens] scanImpact failed', error);
      handleScanFailure(error.message || 'Impact scan failed.', {
        objectApiName,
        fieldApiName,
        scanMode: state.scanMode,
        scanCorrelationId
      });
      console.log('[FieldLens] scan failed', { scanCorrelationId, objectApiName, fieldApiName, scanMode: state.scanMode });
    } finally {
      if (state.activeScanCorrelationId === scanCorrelationId) {
        state.activeScanCorrelationId = null;
      }
      clearScanTimeoutGuard();
      hideLoading();
      setModeBadge(false);
    }
  }

  function renderScanResult(result) {
    if (el.resultSearchWrap) {
      el.resultSearchWrap.classList.remove('hidden');
    }
    if (el.accordionControls) {
      el.accordionControls.classList.remove('hidden');
    }

    renderTopImpact(result);
    renderFlsControls(result);

    const flsAll = Array.isArray(result.groups?.fieldPermissions) ? result.groups.fieldPermissions : [];
    const flsFiltered = filterFlsItems(
      flsAll,
      state.flsFilter,
      result?.flsFallbackUsed === true && !state.showNoAccessInFallback
    );
    const isDeep = (result.scanMode || state.scanMode) === 'deep';
    const groups = [
      { key: 'validationRules', label: 'Validation Rules' },
      { key: 'apexClasses', label: 'Apex Classes' },
      { key: 'apexTriggers', label: 'Apex Triggers' },
      { key: 'flows', label: 'Flows' },
      { key: 'fieldPermissions', label: 'FLS / Permissions', itemsOverride: flsFiltered, totalCount: flsAll.length }
    ];
    groups.splice(
      4,
      0,
      { key: 'formulaFields', label: 'Formula Fields' },
      { key: 'pageLayouts', label: 'Page Layouts' },
      { key: 'listViews', label: 'List Views' },
      { key: 'reportTypes', label: 'Report Types' }
    );

    el.resultsContainer.innerHTML = '';
    let total = 0;

    for (const group of groups) {
      const rawItems =
        group.itemsOverride || (Array.isArray(result.groups?.[group.key]) ? result.groups[group.key] : []);
      const items = filterItemsBySearch(rawItems);
      const shouldShowGroup = getCore().shouldShowGroup || ((count, hideZero) => !hideZero || count > 0);
      if (!shouldShowGroup(items.length, state.hideZeroGroups)) {
        continue;
      }
      total += items.length;

      const card = document.createElement('details');
      card.className = 'result-group result-accordion';
      if (items.length > 0) {
        card.open = true;
      }

      const head = document.createElement('summary');
      head.className = 'result-group-header';
      const skippedInQuick = !isDeep && !['validationRules', 'apexClasses', 'apexTriggers', 'flows', 'fieldPermissions'].includes(group.key);
      const countLabel =
        skippedInQuick
          ? '—'
          : typeof group.totalCount === 'number'
          ? `${items.length}/${group.totalCount}`
          : `${items.length}`;
      head.innerHTML = `<span>${group.label} (${countLabel})</span>`;
      card.appendChild(head);

      const list = document.createElement('ul');
      list.className = 'result-list';

      if (skippedInQuick) {
        const li = document.createElement('li');
        li.className = 'result-item';
        li.innerHTML = '<span class="result-link"><span class="result-subtitle">Not scanned in Quick mode</span></span>';
        list.appendChild(li);
      } else if (!items.length) {
        const li = document.createElement('li');
        li.className = 'result-item result-item-muted';
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

      const body = document.createElement('div');
      body.className = 'result-group-body';
      body.appendChild(list);
      card.appendChild(body);
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

    if (total === 0 && isDeep) {
      el.emptyState.classList.remove('hidden');
      el.resultsContainer.classList.add('hidden');
    } else {
      el.emptyState.classList.add('hidden');
      el.resultsContainer.classList.remove('hidden');
    }
    renderScanSummary(result, groups);
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
      ['Flows', result.groups?.flows || []],
      ['Formula Fields', result.groups?.formulaFields || []],
      ['Page Layouts', result.groups?.pageLayouts || []],
      ['List Views', result.groups?.listViews || []],
      ['Report Types', result.groups?.reportTypes || []],
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
    console.log('[FieldLens] panel received response', {
      requestId: payload.requestId,
      scanCorrelationId: payload?.data?.scanCorrelationId || payload?.error?.scanCorrelationId || null,
      ok: !!payload.ok
    });

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
    console.log('[FieldLens] message sent to background', {
      action,
      requestId,
      scanCorrelationId: payload?.scanCorrelationId || null
    });
    notifyParent({ source: 'fieldlens-panel', type: 'REQUEST', action, payload, requestId });
    const timeoutMs =
      action === 'scanImpact' && payload?.scanMode === 'deep'
        ? 180000
        : action === 'scanImpact'
          ? 90000
          : 60000;

    return new Promise((resolve, reject) => {
      pendingRequestMap.set(requestId, { resolve, reject });

      setTimeout(() => {
        if (pendingRequestMap.has(requestId)) {
          pendingRequestMap.delete(requestId);
          reject({ code: 'TIMEOUT', message: 'Request timed out while waiting for extension response.' });
        }
      }, timeoutMs);
    });
  }

  function notifyParent(message) {
    window.parent.postMessage(message, '*');
  }

  function isParentMessage(event) {
    return event.data?.source === 'fieldlens-content';
  }

  function showLoading(text) {
    stopScanLoading();
    el.loadingTextValue.textContent = text || 'Loading...';
    setLoadingProgress(20);
    el.loadingState.classList.remove('hidden');
  }

  function hideLoading() {
    stopScanLoading();
    setLoadingProgress(0);
    el.loadingState.classList.add('hidden');
  }

  function startScanLoading() {
    const stages = state.scanMode === 'deep'
      ? [
          { text: 'Scanning references...', pct: 8 },
          { text: 'Analyzing Apex classes...', pct: 20 },
          { text: 'Analyzing Apex triggers...', pct: 32 },
          { text: 'Analyzing validation rules...', pct: 44 },
          { text: 'Analyzing field permissions...', pct: 56 },
          { text: 'Analyzing flows...', pct: 66 },
          { text: 'Analyzing formula fields...', pct: 74 },
          { text: 'Analyzing page layouts...', pct: 82 },
          { text: 'Analyzing list views...', pct: 90 },
          { text: 'Analyzing report types...', pct: 96 }
        ]
      : [
          { text: 'Scanning references...', pct: 15 },
          { text: 'Analyzing Apex classes...', pct: 35 },
          { text: 'Analyzing Apex triggers...', pct: 55 },
          { text: 'Analyzing validation rules...', pct: 75 },
          { text: 'Analyzing field permissions...', pct: 95 }
        ];

    stopScanLoading();
    let stageIndex = 0;
    state.loadingMessageIndex = 0;
    el.loadingTextValue.textContent = stages[0].text;
    setLoadingProgress(stages[0].pct);
    el.loadingState.classList.remove('hidden');
    state.loadingMessageTimer = setInterval(() => {
      if (stageIndex >= stages.length - 1) {
        return;
      }
      stageIndex += 1;
      state.loadingMessageIndex = stageIndex;
      el.loadingTextValue.textContent = stages[stageIndex].text;
      setLoadingProgress(stages[stageIndex].pct);
    }, 1100);
  }

  function stopScanLoading() {
    if (state.loadingMessageTimer) {
      clearInterval(state.loadingMessageTimer);
      state.loadingMessageTimer = null;
    }
    state.loadingMessageIndex = 0;
  }

  function setLoadingProgress(value) {
    const pct = Math.max(0, Math.min(100, Number(value || 0)));
    if (el.loadingProgressFill) {
      el.loadingProgressFill.style.width = `${pct}%`;
    }
    if (el.loadingPercentValue) {
      el.loadingPercentValue.textContent = `${Math.round(pct)}%`;
    }
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
    hideNonPermissionableBanner();
  }

  function renderNonPermissionableBanner(result) {
    if (!el.nonPermissionableBanner) {
      return;
    }
    if (result?.flsFallbackUsed === true) {
      el.nonPermissionableBanner.textContent =
        'This field is non-permissionable in Salesforce. Showing object-level permissions fallback.';
      el.nonPermissionableBanner.classList.remove('hidden');
      return;
    }
    hideNonPermissionableBanner();
  }

  function hideNonPermissionableBanner() {
    if (!el.nonPermissionableBanner) {
      return;
    }
    el.nonPermissionableBanner.classList.add('hidden');
    el.nonPermissionableBanner.textContent = '';
  }

  function setRetryState(action, payload) {
    state.lastFailure = { action, payload };
    if (!el.retryActions || !el.retryLoadBtn || !el.retryScanBtn) {
      return;
    }
    el.retryActions.classList.remove('hidden');
    el.retryLoadBtn.classList.toggle('hidden', action !== 'loadFields');
    el.retryScanBtn.classList.toggle('hidden', action !== 'scanImpact');
  }

  function clearRetryState() {
    state.lastFailure = null;
    if (!el.retryActions || !el.retryLoadBtn || !el.retryScanBtn) {
      return;
    }
    el.retryActions.classList.add('hidden');
    el.retryLoadBtn.classList.add('hidden');
    el.retryScanBtn.classList.add('hidden');
  }

  async function retryLoadFields() {
    const payload = state.lastFailure?.action === 'loadFields' ? state.lastFailure.payload : null;
    const objectApiName = payload?.objectApiName || state.context?.objectApiName;
    if (!objectApiName) {
      return;
    }
    hideAllNotices();
    await loadObjectFields(objectApiName);
  }

  async function retryScan() {
    const payload = state.lastFailure?.action === 'scanImpact' ? state.lastFailure.payload : null;
    if (!payload?.objectApiName || !payload?.fieldApiName) {
      return;
    }
    hideAllNotices();
    clearRetryState();
    resetResults();
    startScanLoading();
    setModeBadge(true);
    const scanCorrelationId = payload.scanCorrelationId || `scan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    state.activeScanCorrelationId = scanCorrelationId;
    console.log('[FieldLens] scan started', {
      scanCorrelationId,
      objectApiName: payload.objectApiName,
      fieldApiName: payload.fieldApiName,
      scanMode: payload.scanMode || state.scanMode
    });
    try {
      await runScanLifecycleWithTimeout({ ...payload, scanCorrelationId });
      console.log('[FieldLens] scan completed', {
        scanCorrelationId,
        objectApiName: payload.objectApiName,
        fieldApiName: payload.fieldApiName,
        scanMode: payload.scanMode || state.scanMode
      });
    } catch (error) {
      handleScanFailure(error.message || 'Impact scan failed.', { ...payload, scanCorrelationId });
      console.log('[FieldLens] scan failed', {
        scanCorrelationId,
        objectApiName: payload.objectApiName,
        fieldApiName: payload.fieldApiName,
        scanMode: payload.scanMode || state.scanMode
      });
    } finally {
      if (state.activeScanCorrelationId === scanCorrelationId) {
        state.activeScanCorrelationId = null;
      }
      clearScanTimeoutGuard();
      hideLoading();
      setModeBadge(false);
    }
  }

  async function runScanLifecycleWithTimeout(payload) {
    const scanCorrelationId = payload.scanCorrelationId;
    const operation = (async () => {
      const result = await requestParent('scanImpact', payload);
      if (state.activeScanCorrelationId !== scanCorrelationId) {
        return result;
      }
      state.lastScan = result;
      el.copyBtn.disabled = false;
      if (el.exportCsvBtn) {
        el.exportCsvBtn.disabled = false;
      }
      renderScanResult(result);
      renderFreshness(result);
      renderDiagnostics(result.warnings || []);
      if (Array.isArray(result.warnings) && result.warnings.some((warning) => /more metadata than the scan limit/i.test(warning))) {
        showWarning('Results may be incomplete because this org has more metadata than the scan limit.');
      }
      renderNonPermissionableBanner(result);
      clearRetryState();
      return result;
    })();

    const timeout = new Promise((_, reject) => {
      clearScanTimeoutGuard();
      state.scanTimeoutTimer = setTimeout(() => {
        if (state.activeScanCorrelationId !== scanCorrelationId) {
          return;
        }
        state.activeScanCorrelationId = null;
        hideLoading();
        setModeBadge(false);
        renderScanFailure('Scan timed out. Please try again or use a smaller scan mode.');
        showError('Scan timed out. Please try again or use a smaller scan mode.');
        console.log('[FieldLens] scan timed out', {
          scanCorrelationId,
          objectApiName: payload.objectApiName,
          fieldApiName: payload.fieldApiName,
          scanMode: payload.scanMode || state.scanMode
        });
        reject(new Error('Scan timed out. Please try again or use a smaller scan mode.'));
      }, SCAN_TIMEOUT_MS);
    });

    return Promise.race([operation, timeout]);
  }

  function clearScanTimeoutGuard() {
    if (state.scanTimeoutTimer) {
      clearTimeout(state.scanTimeoutTimer);
      state.scanTimeoutTimer = null;
    }
  }

  function handleScanFailure(message, payload) {
    showError(message);
    renderScanFailure(message);
    el.copyBtn.disabled = true;
    if (el.exportCsvBtn) {
      el.exportCsvBtn.disabled = true;
    }
    setRetryState('scanImpact', payload);
    hideDiagnostics();
    clearFreshness();
  }

  function renderScanFailure(message) {
    el.emptyState.classList.add('hidden');
    el.resultsContainer.innerHTML = `<div class="result-group"><div class="result-group-body"><div class="result-item"><span class="result-subtitle">${escapeHtml(
      message
    )}</span></div></div></div>`;
    el.resultsContainer.classList.remove('hidden');
  }

  function renderFreshness(result) {
    if (!el.freshnessBadge) {
      return;
    }
    const generatedAt = Number(result?.generatedAt || 0);
    const fromCache = !!result?.fromCache;
    if (!generatedAt) {
      el.freshnessBadge.textContent = fromCache ? 'Cached' : 'Live';
      el.freshnessBadge.classList.toggle('cached', fromCache);
      el.freshnessBadge.classList.remove('hidden');
      return;
    }

    if (!fromCache) {
      el.freshnessBadge.textContent = 'Live';
      el.freshnessBadge.classList.remove('cached');
      el.freshnessBadge.classList.remove('hidden');
      return;
    }

    const ageMs = Math.max(0, Date.now() - generatedAt);
    const ageMin = Math.max(1, Math.round(ageMs / 60000));
    el.freshnessBadge.textContent = `Cached ${ageMin}m ago`;
    el.freshnessBadge.classList.add('cached');
    el.freshnessBadge.classList.remove('hidden');
  }

  function renderScanSummary(result, groups) {
    if (!el.resultsContainer) return;
    const existing = el.resultsContainer.querySelector('.scan-summary');
    if (existing) existing.remove();
    const total = groups.reduce((sum, group) => sum + (Array.isArray(result.groups?.[group.key]) ? result.groups[group.key].length : 0), 0);
    const summary = document.createElement('div');
    summary.className = 'scan-summary';
    summary.innerHTML = `<strong>${total} reference${total === 1 ? '' : 's'}</strong><span>${result.scanMode === 'deep' ? 'Deep' : 'Quick'} scan</span><span>${result.fromCache ? 'Cached' : 'Live'}</span>`;
    el.resultsContainer.prepend(summary);
  }

  function showToast(message) {
    if (!el.toast) return;
    el.toast.textContent = message;
    el.toast.classList.remove('hidden');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 1800);
  }

  function clearFreshness() {
    if (!el.freshnessBadge) {
      return;
    }
    el.freshnessBadge.textContent = '';
    el.freshnessBadge.classList.add('hidden');
    el.freshnessBadge.classList.remove('cached');
  }

  function renderDiagnostics(warnings) {
    const filtered = Array.isArray(warnings)
      ? warnings
          .map((x) => String(x || '').trim())
          .filter(Boolean)
      : [];
    if (!filtered.length || !el.diagnosticsSection || !el.diagnosticsList || !el.diagnosticsCount) {
      hideDiagnostics();
      return;
    }

    el.diagnosticsCount.textContent = String(filtered.length);
    el.diagnosticsList.innerHTML = filtered.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
    el.diagnosticsSection.classList.remove('hidden');
  }

  function hideDiagnostics() {
    if (!el.diagnosticsSection || !el.diagnosticsList || !el.diagnosticsCount) {
      return;
    }
    el.diagnosticsCount.textContent = '0';
    el.diagnosticsList.innerHTML = '';
    el.diagnosticsSection.classList.add('hidden');
  }

  function resetResults() {
    el.resultsContainer.classList.add('hidden');
    el.resultsContainer.innerHTML = '';
    el.emptyState.classList.add('hidden');
    if (el.resultSearchWrap) {
      el.resultSearchWrap.classList.add('hidden');
    }
    if (el.accordionControls) {
      el.accordionControls.classList.add('hidden');
    }
    clearRetryState();
    hideTopImpact();
    hideFlsControls();
  }

  function setAllAccordions(open) {
    if (!el.resultsContainer) {
      return;
    }
    el.resultsContainer.querySelectorAll('.result-accordion').forEach((node) => {
      node.open = !!open;
    });
  }

  async function loadUserSettings() {
    try {
      const settings = await requestParent('getSettings', {});
      const core = getCore();
      const normalized = core.normalizeSettings
        ? core.normalizeSettings(settings || {})
        : {
            defaultScanMode: settings?.defaultScanMode === 'deep' ? 'deep' : 'quick',
            hideZeroGroups: !!settings?.hideZeroGroups
          };
      const defaultScanMode = normalized.defaultScanMode;
      state.hideZeroGroups = !!normalized.hideZeroGroups;
      if (el.hideZeroGroupsCheckbox) {
        el.hideZeroGroupsCheckbox.checked = state.hideZeroGroups;
      }
      setScanMode(defaultScanMode, false);
      state.settingsLoaded = true;
    } catch (_) {
      state.settingsLoaded = true;
    }
  }

  async function persistUserSettings() {
    if (!state.settingsLoaded) {
      return;
    }
    try {
      await requestParent('saveSettings', {
        settings: {
          defaultScanMode: state.scanMode,
          hideZeroGroups: !!state.hideZeroGroups
        }
      });
    } catch (_) {
      // settings are non-critical
    }
  }

  function exportCsv(result) {
    const core = getCore();
    const rows = core.buildImpactCsvRows ? core.buildImpactCsvRows(result) : [['Group', 'Name', 'Subtitle', 'URL']];
    const csvEscapeFn = core.csvEscape || csvEscape;
    const csv = rows.map((row) => row.map(csvEscapeFn).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fieldlens_${result.objectApiName}_${result.fieldApiName}_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function csvEscape(value) {
    let s = String(value ?? '');
    if (/^[=+\-@]/.test(s)) {
      s = `'${s}`;
    }
    if (/[",\n]/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }

  function getCore() {
    const core = typeof globalThis !== 'undefined' ? globalThis.FieldLensCore : null;
    return core && typeof core === 'object' ? core : {};
  }

  function renderTopImpact(result) {
    if (!el.topImpact || !el.topImpactList || !el.topImpactCount) {
      return;
    }

    const ranked = buildRankedImpactItems(result).filter(matchesResultSearch).slice(0, 5);
    if (!ranked.length) {
      hideTopImpact();
      return;
    }

    el.topImpactCount.textContent = `${ranked.length} shown`;
    el.topImpactList.innerHTML = ranked
      .map(
        (item) => `
        <li class="top-impact-item">
          <button type="button" class="top-impact-link" data-url="${escapeHtml(item.url || '')}">
            <span class="top-impact-title">${escapeHtml(item.name || 'Unnamed')}</span>
            <span class="top-impact-sub">${escapeHtml(item.groupLabel)} - ${escapeHtml(item.subtitle || '')}</span>
          </button>
        </li>
      `
      )
      .join('');

    el.topImpactList.querySelectorAll('[data-url]').forEach((node) => {
      node.addEventListener('click', () => {
        const url = node.getAttribute('data-url');
        if (url) {
          notifyParent({ source: 'fieldlens-panel', type: 'OPEN_LINK', url });
        }
      });
    });

    el.topImpact.classList.remove('hidden');
  }

  function hideTopImpact() {
    if (!el.topImpact) {
      return;
    }
    el.topImpact.classList.add('hidden');
    if (el.topImpactList) {
      el.topImpactList.innerHTML = '';
    }
    if (el.topImpactCount) {
      el.topImpactCount.textContent = '0';
    }
  }

  function buildRankedImpactItems(result) {
    const groups = result.groups || {};
    const riskOrder = [
      { key: 'apexTriggers', label: 'Apex Trigger', score: 100 },
      { key: 'validationRules', label: 'Validation Rule', score: 90 },
      { key: 'flows', label: 'Flow', score: 80 },
      { key: 'apexClasses', label: 'Apex Class', score: 70 },
      { key: 'formulaFields', label: 'Formula Field', score: 60 },
      { key: 'pageLayouts', label: 'Page Layout', score: 50 },
      { key: 'reportTypes', label: 'Report Type', score: 40 },
      { key: 'listViews', label: 'List View', score: 35 },
      { key: 'fieldPermissions', label: 'FLS / Permissions', score: 20 }
    ];

    const ranked = [];
    for (const group of riskOrder) {
      const items = Array.isArray(groups[group.key]) ? groups[group.key] : [];
      for (const item of items) {
        ranked.push({
          ...item,
          score: group.score,
          groupLabel: group.label
        });
      }
    }

    ranked.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
    return ranked;
  }

  function filterItemsBySearch(items) {
    if (!state.resultSearchTerm) {
      return items;
    }
    return items.filter(matchesResultSearch);
  }

  function matchesResultSearch(item) {
    if (!state.resultSearchTerm) {
      return true;
    }
    const haystack = `${item?.name || ''} ${item?.subtitle || ''}`.toLowerCase();
    return haystack.includes(state.resultSearchTerm);
  }

  function setScanMode(mode, persist = true) {
    state.scanMode = mode === 'deep' ? 'deep' : 'quick';
    el.modeQuickBtn.classList.toggle('mode-btn-active', state.scanMode === 'quick');
    el.modeDeepBtn.classList.toggle('mode-btn-active', state.scanMode === 'deep');
    el.modeQuickBtn.setAttribute('aria-pressed', state.scanMode === 'quick' ? 'true' : 'false');
    el.modeDeepBtn.setAttribute('aria-pressed', state.scanMode === 'deep' ? 'true' : 'false');
    if (el.defaultScanModeSelect) {
      el.defaultScanModeSelect.value = state.scanMode;
    }
    setModeBadge(false);
    if (persist) {
      persistUserSettings();
    }
  }

  function setModeBadge(isRunning) {
    if (!el.modeBadge) {
      return;
    }
    const label = state.scanMode === 'deep' ? 'Deep' : 'Quick';
    el.modeBadge.textContent = isRunning ? `Mode: ${label} - Scanning` : `Mode: ${label}`;
    el.modeBadge.classList.toggle('mode-badge-deep', state.scanMode === 'deep');
    el.modeBadge.classList.toggle('mode-badge-running', !!isRunning);
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
    if (el.toggleNoAccessBtn) {
      const useFallbackToggle = result?.flsFallbackUsed === true;
      el.toggleNoAccessBtn.classList.toggle('hidden', !useFallbackToggle);
      syncNoAccessToggleLabel();
    }
    syncFlsFilterButtons();
  }

  function hideFlsControls() {
    if (el.flsControls) {
      el.flsControls.classList.add('hidden');
    }
    if (el.toggleNoAccessBtn) {
      el.toggleNoAccessBtn.classList.add('hidden');
    }
  }

  function filterFlsItems(items, filter, hideNone = false) {
    const source = hideNone ? items.filter((x) => x.accessType !== 'none') : items;
    switch (filter) {
      case 'profile':
        return source.filter((x) => x.permissionType === 'profile');
      case 'permissionSet':
        return source.filter((x) => x.permissionType === 'permissionSet');
      case 'readEdit':
        return source.filter((x) => x.accessType === 'readEdit');
      case 'read':
        return source.filter((x) => x.accessType === 'read');
      default:
        return source;
    }
  }

  function syncNoAccessToggleLabel() {
    if (!el.toggleNoAccessBtn) {
      return;
    }
    el.toggleNoAccessBtn.textContent = state.showNoAccessInFallback ? 'Hide No Access' : 'Show No Access';
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
