(() => {
  const FIELDLENS_BUTTON_ID = 'fieldlens-floating-button';
  const FIELDLENS_PANEL_ID = 'fieldlens-panel-shell';
  const IFRAME_ID = 'fieldlens-panel-frame';
  const PAGE_PROXY_REQUEST_TYPE = 'FIELDLENS_PAGE_PROXY_REQUEST';
  const PAGE_PROXY_RESPONSE_TYPE = 'FIELDLENS_PAGE_PROXY_RESPONSE';

  let currentUrl = location.href;
  let currentContext = parseSalesforceContext(currentUrl);
  let panelReady = false;
  let panelOpen = false;
  let messageCounter = 0;
  const extensionOrigin = resolveExtensionOrigin();
  let pageBridgeInjected = false;
  let pageProxyRequestId = 0;

  const pendingRequests = new Map();
  const pendingPageProxyRequests = new Map();

  init();

  function init() {
    if (!isSalesforceHost(location.hostname)) {
      return;
    }

    ensureUiShell();
    syncUiVisibility();
    watchUrlChanges();
    bindEscHandler();
    bindWindowMessageHandler();
    bindPageProxyResponseHandler();
    bindRuntimeProxyHandler();
  }

  function ensureUiShell() {
    if (document.getElementById(FIELDLENS_BUTTON_ID) && document.getElementById(FIELDLENS_PANEL_ID)) {
      return;
    }

    const button = document.createElement('button');
    button.id = FIELDLENS_BUTTON_ID;
    button.type = 'button';
    button.textContent = 'FieldLens';
    button.setAttribute('aria-label', 'Open FieldLens panel');
    applyButtonStyles(button);
    button.addEventListener('mouseenter', () => setLauncherButtonExpanded(true));
    button.addEventListener('mouseleave', () => setLauncherButtonExpanded(false));
    button.addEventListener('focus', () => setLauncherButtonExpanded(true));
    button.addEventListener('blur', () => setLauncherButtonExpanded(false));
    button.addEventListener('click', openPanel);

    const shell = document.createElement('aside');
    shell.id = FIELDLENS_PANEL_ID;
    shell.setAttribute('aria-hidden', 'true');
    applyPanelShellStyles(shell);

    const iframe = document.createElement('iframe');
    iframe.id = IFRAME_ID;
    iframe.title = 'FieldLens';
    iframe.src = chrome.runtime.getURL('ui/panel.html');
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = '0';
    iframe.style.background = '#fff';

    shell.appendChild(iframe);
    document.documentElement.appendChild(button);
    document.documentElement.appendChild(shell);
    setLauncherButtonExpanded(false);
  }

  function bindEscHandler() {
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && panelOpen) {
        closePanel();
      }
    });
  }

  function bindWindowMessageHandler() {
    window.addEventListener('message', async (event) => {
      const panelFrame = document.getElementById(IFRAME_ID);
      if (panelFrame?.contentWindow && event.source !== panelFrame.contentWindow) {
        return;
      }
      if (extensionOrigin && event.origin !== extensionOrigin) {
        return;
      }

      const data = event.data;
      if (!data || data.source !== 'fieldlens-panel') {
        return;
      }

      if (data.type === 'PANEL_READY') {
        panelReady = true;
        postToPanel('CONTEXT_UPDATE', currentContext);
        return;
      }

      if (data.type === 'CLOSE_PANEL') {
        closePanel();
        return;
      }

      if (data.type === 'OPEN_LINK' && typeof data.url === 'string') {
        window.open(data.url, '_blank', 'noopener');
        return;
      }

      if (data.type === 'REQUEST' && typeof data.requestId === 'number') {
        try {
          const result = await routePanelRequest(data.action, data.payload || {});
          postToPanel('RESPONSE', {
            requestId: data.requestId,
            ok: true,
            data: result
          });
        } catch (error) {
          postToPanel('RESPONSE', {
            requestId: data.requestId,
            ok: false,
            error: {
              code: error.code || 'REQUEST_FAILED',
              message: error.message || 'Request failed.',
              debug: error.debug || null
            }
          });
        }
      }
    });
  }

  function bindRuntimeProxyHandler() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || message.type !== 'FIELDLENS_TOOLING_QUERY' || typeof message.url !== 'string') {
        return false;
      }

      handleToolingQuery(message.url).then(sendResponse);
      return true;
    });
  }

  function bindPageProxyResponseHandler() {
    window.addEventListener('message', (event) => {
      if (event.source !== window) {
        return;
      }
      const data = event.data;
      if (!data || data.type !== PAGE_PROXY_RESPONSE_TYPE || typeof data.requestId !== 'number') {
        return;
      }
      const pending = pendingPageProxyRequests.get(data.requestId);
      if (!pending) {
        return;
      }
      pendingPageProxyRequests.delete(data.requestId);
      pending.resolve(data.payload || { ok: false, status: 0, error: 'Empty page proxy payload' });
    });
  }

  async function handleToolingQuery(urlString) {
    try {
      const res = await fetch(urlString, {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'application/json' }
      });
      return parseToolingResponse(res);
    } catch (error) {
      const fallback = await proxyViaPageContext(urlString).catch((pageError) => ({
        ok: false,
        status: 0,
        error: `Failed to fetch (content=${error?.message || 'unknown'}; page=${pageError?.message || 'unknown'})`
      }));
      return fallback;
    }
  }

  async function parseToolingResponse(res) {
    const text = await res.text();
    const contentType = res.headers.get('content-type') || '';
    let parsedJson = null;
    try {
      parsedJson = JSON.parse(text);
    } catch (_) {
      parsedJson = null;
    }

    if (parsedJson !== null) {
      if (res.ok) {
        return { ok: true, status: res.status, data: parsedJson };
      }
      return {
        ok: false,
        status: res.status,
        statusText: res.statusText,
        body: parsedJson,
        contentType
      };
    }

    return {
      ok: false,
      status: res.status,
      statusText: res.statusText,
      body: text,
      contentType
    };
  }

  async function routePanelRequest(action, payload) {
    if (action === 'getContext') {
      return currentContext;
    }

    if (action === 'scanImpact') {
      const objectApiName = payload.objectApiName || currentContext.objectApiName;
      const fieldApiName = payload.fieldApiName || currentContext.fieldApiName;
      const scanMode = payload.scanMode === 'deep' ? 'deep' : 'quick';
      return sendToBackground({
        type: 'FIELDLENS_SCAN_IMPACT',
        baseUrl: location.origin,
        objectApiName,
        fieldApiName,
        scanMode
      });
    }

    if (action === 'loadFields') {
      const objectApiName = payload.objectApiName || currentContext.objectApiName;
      return sendToBackground({
        type: 'FIELDLENS_LOAD_FIELDS',
        baseUrl: location.origin,
        objectApiName
      });
    }

    if (action === 'copyToClipboard') {
      const text = typeof payload.text === 'string' ? payload.text : '';
      if (!text) {
        throw createError('INVALID_INPUT', 'No text provided to copy.');
      }
      const ok = copyTextInTopDocument(text);
      if (!ok) {
        throw createError('COPY_FAILED', 'Clipboard copy is blocked by browser policy on this page.');
      }
      return { copied: true };
    }

    if (action === 'getSettings') {
      const store = await chrome.storage.local.get(['fieldlensSettings']);
      const core = typeof globalThis !== 'undefined' ? globalThis.FieldLensCore : null;
      const normalize = core && typeof core.normalizeSettings === 'function' ? core.normalizeSettings : null;
      return normalize ? normalize(store.fieldlensSettings || {}) : store.fieldlensSettings || {};
    }

    if (action === 'saveSettings') {
      const incoming = payload && typeof payload.settings === 'object' ? payload.settings : {};
      const core = typeof globalThis !== 'undefined' ? globalThis.FieldLensCore : null;
      const normalize = core && typeof core.normalizeSettings === 'function' ? core.normalizeSettings : null;
      const normalized = normalize
        ? normalize(incoming)
        : {
            defaultScanMode: incoming.defaultScanMode === 'deep' ? 'deep' : 'quick',
            hideZeroGroups: !!incoming.hideZeroGroups
          };
      await chrome.storage.local.set({ fieldlensSettings: normalized });
      return normalized;
    }

    throw createError('UNKNOWN_ACTION', `Unknown panel action: ${action}`);
  }

  async function proxyViaPageContext(urlString) {
    ensurePageFetchBridgeInjected();
    const requestId = ++pageProxyRequestId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingPageProxyRequests.delete(requestId);
        reject(new Error('Page fetch bridge timed out'));
      }, 20000);

      pendingPageProxyRequests.set(requestId, {
        resolve: (payload) => {
          clearTimeout(timeout);
          resolve(payload);
        }
      });

      window.postMessage(
        {
          type: PAGE_PROXY_REQUEST_TYPE,
          requestId,
          url: urlString
        },
        window.location.origin
      );
    });
  }

  function ensurePageFetchBridgeInjected() {
    if (pageBridgeInjected) {
      return;
    }
    const script = document.createElement('script');
    script.type = 'text/javascript';
    script.textContent = `
      (() => {
        if (window.__fieldlensPageProxyInstalled) {
          return;
        }
        window.__fieldlensPageProxyInstalled = true;
        const REQUEST_TYPE = '${PAGE_PROXY_REQUEST_TYPE}';
        const RESPONSE_TYPE = '${PAGE_PROXY_RESPONSE_TYPE}';
        window.addEventListener('message', async (event) => {
          if (event.source !== window) {
            return;
          }
          const data = event.data;
          if (!data || data.type !== REQUEST_TYPE || typeof data.requestId !== 'number' || typeof data.url !== 'string') {
            return;
          }
          try {
            const target = new URL(data.url, window.location.origin);
            const isSameOrigin = target.origin === window.location.origin;
            if (!isSameOrigin) {
              throw new Error('Cross-origin page proxy blocked');
            }
            const res = await fetch(target.toString(), {
              method: 'GET',
              credentials: 'include',
              headers: { Accept: 'application/json' }
            });
            const text = await res.text();
            const contentType = res.headers.get('content-type') || '';
            let parsed = null;
            try {
              parsed = JSON.parse(text);
            } catch (_) {
              parsed = null;
            }
            let payload;
            if (parsed !== null) {
              payload = res.ok
                ? { ok: true, status: res.status, data: parsed }
                : { ok: false, status: res.status, statusText: res.statusText, body: parsed, contentType };
            } else {
              payload = { ok: false, status: res.status, statusText: res.statusText, body: text, contentType };
            }
            window.postMessage({ type: RESPONSE_TYPE, requestId: data.requestId, payload }, window.location.origin);
          } catch (error) {
            window.postMessage(
              {
                type: RESPONSE_TYPE,
                requestId: data.requestId,
                payload: { ok: false, status: 0, error: error && error.message ? error.message : 'Page proxy fetch failed' }
              },
              window.location.origin
            );
          }
        });
      })();
    `;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
    pageBridgeInjected = true;
  }

  function copyTextInTopDocument(text) {
    try {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.setAttribute('readonly', '');
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      textArea.style.pointerEvents = 'none';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      const copied = document.execCommand('copy');
      document.body.removeChild(textArea);
      return !!copied;
    } catch (_) {
      return false;
    }
  }

  function sendToBackground(message) {
    const dedupeKey = `${message.type}:${message.objectApiName || ''}:${message.fieldApiName || ''}`;
    // Prevent duplicate scans/loads when the user clicks multiple times quickly.
    if (pendingRequests.has(dedupeKey)) {
      return pendingRequests.get(dedupeKey);
    }

    const request = new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(createError('EXTENSION_ERROR', runtimeError.message));
          return;
        }

        if (!response) {
          reject(createError('NO_RESPONSE', 'No response received from background worker.'));
          return;
        }

        if (!response.ok) {
          const err = createError(response.error?.code || 'BACKGROUND_ERROR', response.error?.message || 'Background request failed.');
          err.debug = response.error?.debug || null;
          reject(err);
          return;
        }

        resolve(response.data);
      });
    });

    pendingRequests.set(dedupeKey, request);
    return request.finally(() => pendingRequests.delete(dedupeKey));
  }

  function postToPanel(type, payload) {
    const iframe = document.getElementById(IFRAME_ID);
    if (!iframe || !iframe.contentWindow) {
      return;
    }

    iframe.contentWindow.postMessage(
      {
        source: 'fieldlens-content',
        type,
        payload,
        messageId: ++messageCounter
      },
      extensionOrigin || '*'
    );
  }

  function openPanel() {
    const shell = document.getElementById(FIELDLENS_PANEL_ID);
    if (!shell) {
      return;
    }
    panelOpen = true;
    setLauncherButtonExpanded(true);
    shell.style.transform = 'translateX(0)';
    shell.setAttribute('aria-hidden', 'false');
    postToPanel('CONTEXT_UPDATE', currentContext);
  }

  function closePanel() {
    const shell = document.getElementById(FIELDLENS_PANEL_ID);
    if (!shell) {
      return;
    }
    panelOpen = false;
    setLauncherButtonExpanded(false);
    shell.style.transform = 'translateX(100%)';
    shell.setAttribute('aria-hidden', 'true');
  }

  function watchUrlChanges() {
    // Lightning navigation is client-side; poll URL changes and refresh page context.
    setInterval(() => {
      if (location.href === currentUrl) {
        return;
      }

      currentUrl = location.href;
      currentContext = parseSalesforceContext(currentUrl);
      syncUiVisibility();
      if (panelReady) {
        postToPanel('CONTEXT_UPDATE', currentContext);
      }
    }, 800);
  }

  function syncUiVisibility() {
    const button = document.getElementById(FIELDLENS_BUTTON_ID);
    if (!button) {
      return;
    }

    const shouldShowButton = currentContext.isSupportedPage;
    button.style.display = shouldShowButton ? 'inline-flex' : 'none';

    if (!shouldShowButton) {
      closePanel();
    }
  }

  function parseSalesforceContext(urlString) {
    const core = typeof globalThis !== 'undefined' ? globalThis.FieldLensCore : null;
    if (core && typeof core.parseSalesforceContext === 'function') {
      try {
        return core.parseSalesforceContext(urlString);
      } catch (_) {
        // fall back to local parser
      }
    }
    const url = new URL(urlString);
    const path = url.pathname;

    const setupMatch = path.match(/^\/lightning\/setup\/ObjectManager\/([^/]+)\/FieldsAndRelationships\/([^/]+)\/view/i);
    if (setupMatch) {
      return {
        pageType: 'setupField',
        isSupportedPage: true,
        objectApiName: decodeURIComponent(setupMatch[1]),
        fieldApiName: decodeURIComponent(setupMatch[2]),
        message: null
      };
    }

    const recordMatch = path.match(/^\/lightning\/r\/([^/]+)\/[^/]+\/view/i);
    if (recordMatch) {
      return {
        pageType: 'recordPage',
        isSupportedPage: true,
        objectApiName: decodeURIComponent(recordMatch[1]),
        fieldApiName: null,
        message: null
      };
    }

    return {
      pageType: 'unsupported',
      isSupportedPage: false,
      objectApiName: null,
      fieldApiName: null,
      message: 'FieldLens works on Object Manager field pages and record pages in Lightning Experience.'
    };
  }

  function isSalesforceHost(host) {
    return host.endsWith('.salesforce.com') || host.endsWith('.force.com');
  }

  function resolveExtensionOrigin() {
    const runtimeId = typeof chrome !== 'undefined' && chrome.runtime ? chrome.runtime.id : null;
    return runtimeId ? `chrome-extension://${runtimeId}` : null;
  }

  function applyButtonStyles(button) {
    const styles = {
      position: 'fixed',
      right: '-78px',
      top: '46%',
      zIndex: '2147483646',
      border: '0',
      borderRadius: '12px 0 0 12px',
      background: '#0176d3',
      color: '#fff',
      fontSize: '14px',
      fontWeight: '600',
      fontFamily: "'Salesforce Sans', 'Segoe UI', sans-serif",
      letterSpacing: '0.2px',
      boxShadow: '-8px 10px 24px rgba(1, 118, 211, 0.35)',
      padding: '11px 16px',
      cursor: 'pointer',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      transform: 'translateY(-50%)',
      transition: 'right 180ms ease-in-out, box-shadow 180ms ease-in-out'
    };

    Object.assign(button.style, styles);
  }

  function setLauncherButtonExpanded(expanded) {
    const button = document.getElementById(FIELDLENS_BUTTON_ID);
    if (!button) {
      return;
    }
    const shouldExpand = !!expanded || panelOpen;
    button.style.right = shouldExpand ? '0' : '-78px';
    button.style.boxShadow = shouldExpand
      ? '-10px 10px 26px rgba(1, 118, 211, 0.4)'
      : '-8px 10px 24px rgba(1, 118, 211, 0.35)';
  }

  function applyPanelShellStyles(shell) {
    const styles = {
      position: 'fixed',
      top: '0',
      right: '0',
      width: '360px',
      maxWidth: '90vw',
      height: '100vh',
      zIndex: '2147483647',
      background: '#ffffff',
      boxShadow: '-8px 0 24px rgba(0, 0, 0, 0.18)',
      transform: 'translateX(100%)',
      transition: 'transform 220ms ease-in-out'
    };

    Object.assign(shell.style, styles);
  }

  function createError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }
})();
