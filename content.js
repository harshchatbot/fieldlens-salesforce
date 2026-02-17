(() => {
  const FIELDLENS_BUTTON_ID = 'fieldlens-floating-button';
  const FIELDLENS_PANEL_ID = 'fieldlens-panel-shell';
  const IFRAME_ID = 'fieldlens-panel-frame';

  let currentUrl = location.href;
  let currentContext = parseSalesforceContext(currentUrl);
  let panelReady = false;
  let panelOpen = false;
  let messageCounter = 0;

  const pendingRequests = new Map();

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
      const expectedOrigin = `chrome-extension://${chrome.runtime.id}`;
      if (event.origin !== expectedOrigin) {
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
      if (!message || message.type !== 'FIELDLENS_FETCH_JSON' || typeof message.url !== 'string') {
        return false;
      }

      proxyFetchJson(message.url)
        .then((result) => sendResponse({ ok: true, status: result.status, data: result.data }))
        .catch((error) =>
          sendResponse({
            ok: false,
            status: error.status || 0,
            error: {
              code: error.code || 'PROXY_FETCH_FAILED',
              message: error.message || 'Failed to fetch Salesforce API in tab context.'
            }
          })
        );
      return true;
    });
  }

  async function proxyFetchJson(urlString) {
    const target = new URL(urlString);
    const current = new URL(location.href);
    if (!isTrustedSalesforcePair(current.hostname, target.hostname)) {
      throw createError(
        'INVALID_ORIGIN',
        `Proxy fetch blocked due to untrusted origin pair. current=${current.origin} target=${target.origin}`
      );
    }

    try {
      return await proxyViaFetch(target.toString());
    } catch (fetchError) {
      // Some org/browser combinations fail with fetch() in extension isolated world.
      try {
        return await proxyViaXhr(target.toString());
      } catch (xhrError) {
        const detail = [
          `fetch=${fetchError?.message || 'unknown'}`,
          `xhr=${xhrError?.message || 'unknown'}`,
          `url=${target.toString()}`
        ].join(' | ');
        throw createError('PROXY_FETCH_FAILED', detail);
      }
    }
  }

  function isTrustedSalesforcePair(currentHost, targetHost) {
    const isSfHost = (host) =>
      host.endsWith('.salesforce.com') || host.endsWith('.force.com');
    if (!isSfHost(currentHost) || !isSfHost(targetHost)) {
      return false;
    }

    // Allow same host or expected Lightning<->MyDomain host switch.
    if (currentHost === targetHost) {
      return true;
    }

    const currentCore = normalizeSalesforceCore(currentHost);
    const targetCore = normalizeSalesforceCore(targetHost);
    return currentCore && targetCore && currentCore === targetCore;
  }

  function normalizeSalesforceCore(host) {
    return host
      .replace('.lightning.force.com', '')
      .replace('.my.salesforce.com', '')
      .replace('.force.com', '')
      .replace('.salesforce.com', '');
  }

  async function proxyViaFetch(url) {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      mode: 'same-origin',
      headers: { Accept: 'application/json' }
    });
    return parseJsonResponse(response, 'fetch');
  }

  function proxyViaXhr(url) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.withCredentials = true;
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.onreadystatechange = () => {
        if (xhr.readyState !== 4) {
          return;
        }
        const status = xhr.status || 0;
        const contentType = xhr.getResponseHeader('content-type') || '';
        const text = xhr.responseText || '';
        if (!contentType.includes('application/json')) {
          reject(createError('NOT_LOGGED_IN', `XHR non-JSON response status=${status} contentType=${contentType || 'unknown'}`));
          return;
        }
        try {
          const data = JSON.parse(text);
          resolve({ status, data });
        } catch (_) {
          resolve({ status, data: [] });
        }
      };
      xhr.onerror = () => reject(createError('XHR_NETWORK_ERROR', `XHR network error for ${url}`));
      xhr.send();
    });
  }

  async function parseJsonResponse(response, transport) {
    const contentType = response.headers.get('content-type') || '';
    const raw = await response.text();
    if (!contentType.includes('application/json')) {
      throw createError(
        'NOT_LOGGED_IN',
        `${transport} non-JSON response status=${response.status} contentType=${contentType || 'unknown'}`
      );
    }

    let data = [];
    try {
      data = JSON.parse(raw);
    } catch (_) {
      data = [];
    }

    return { status: response.status, data };
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

    throw createError('UNKNOWN_ACTION', `Unknown panel action: ${action}`);
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
      `chrome-extension://${chrome.runtime.id}`
    );
  }

  function openPanel() {
    const shell = document.getElementById(FIELDLENS_PANEL_ID);
    if (!shell) {
      return;
    }
    panelOpen = true;
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

  function applyButtonStyles(button) {
    const styles = {
      position: 'fixed',
      right: '24px',
      bottom: '24px',
      zIndex: '2147483646',
      border: '0',
      borderRadius: '999px',
      background: '#0176d3',
      color: '#fff',
      fontSize: '14px',
      fontWeight: '600',
      fontFamily: "'Salesforce Sans', 'Segoe UI', sans-serif",
      letterSpacing: '0.2px',
      boxShadow: '0 12px 24px rgba(1, 118, 211, 0.35)',
      padding: '12px 18px',
      cursor: 'pointer',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center'
    };

    Object.assign(button.style, styles);
  }

  function applyPanelShellStyles(shell) {
    const styles = {
      position: 'fixed',
      top: '0',
      right: '0',
      width: '420px',
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
