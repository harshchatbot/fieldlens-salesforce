const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

const EXTENSION_PATH = path.resolve(__dirname, '..', '..');
const MANIFEST_PATH = path.join(EXTENSION_PATH, 'manifest.json');
const PLAYWRIGHT_ROOT = path.join(EXTENSION_PATH, '.playwright');
const WELCOME_PROFILE_DIR = path.join(PLAYWRIGHT_ROOT, 'fieldlens-extension-profile');
const SALESFORCE_PROFILE_DIR = path.join(PLAYWRIGHT_ROOT, 'salesforce-profile');
const MANUAL_LOGIN_TIMEOUT_MS = Number(process.env.FIELDLENS_LOGIN_TIMEOUT_MS || 180000);
const API_SESSION_POLL_MS = 1500;
const IDENTITY_RETRY_COUNT = 3;
const EXTENSION_LOAD_TIMEOUT_MS = 15000;
const USE_BOOTSTRAPPED_PROFILE = String(process.env.FIELDLENS_USE_BOOTSTRAPPED_PROFILE || '').toLowerCase() === 'true';
const CONNECT_EXISTING_CHROME = String(process.env.FIELDLENS_CONNECT_EXISTING_CHROME || '').toLowerCase() === 'true';
const EXISTING_CHROME_CDP_ENDPOINT = process.env.FIELDLENS_CHROME_CDP_ENDPOINT || 'http://127.0.0.1:9222';
const PROFILE_TYPE_EXTENSION = 'extension';
const PROFILE_TYPE_SALESFORCE = 'salesforce';

function sanitizeIdentityValue(value, fallbackValue) {
  const normalized = String(value == null ? '' : value).trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '_');
  return normalized || fallbackValue;
}

function sanitizePageUrl(urlValue) {
  try {
    const parsed = new URL(urlValue);
    return `${parsed.origin}${parsed.pathname}`;
  } catch (_) {
    return String(urlValue || '');
  }
}

function maskIdentityValue(value) {
  const normalized = String(value || '');
  if (!normalized) {
    return 'unknown';
  }
  if (normalized.length <= 6) {
    return `${normalized.slice(0, 2)}***`;
  }
  return `${normalized.slice(0, 3)}***${normalized.slice(-3)}`;
}

function classifySalesforceApiResult(result) {
  const contentType = String(result && result.contentType ? result.contentType : '');
  const status = Number(result && result.status ? result.status : 0);
  const hasJson = /application\/json/i.test(contentType);
  const message = String(result && result.message ? result.message : '');
  const hasHtml = !!(result && result.isHtml);

  if (status === 401 || status === 403) {
    return {
      ok: false,
      code: 'HTTP_AUTH',
      message: `Salesforce API returned ${status}`
    };
  }
  if (!hasJson || hasHtml) {
    return {
      ok: false,
      code: 'NON_JSON',
      message: 'Salesforce API returned non-JSON response'
    };
  }
  if (/INVALID_SESSION_ID|Session expired or invalid/i.test(message)) {
    return {
      ok: false,
      code: 'INVALID_SESSION',
      message: 'Session expired or invalid'
    };
  }
  return {
    ok: true,
    code: 'OK',
    message: ''
  };
}

function buildFallbackIdentity(identity) {
  const safe = identity && typeof identity === 'object' ? identity : {};
  return {
    hostname: safe.hostname || 'unknown-host',
    userId: safe.userId || null,
    orgId: safe.orgId || 'unknown-org',
    instanceKey: safe.instanceKey || safe.hostname || 'unknown-instance'
  };
}

function readManifestDetails() {
  const manifestExists = fs.existsSync(MANIFEST_PATH);
  if (!manifestExists) {
    return {
      manifestExists: false,
      manifest: null,
      backgroundWorkerPath: null,
      backgroundWorkerExists: false,
      welcomePath: 'welcome.html'
    };
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const backgroundWorkerPath =
    manifest && manifest.background && typeof manifest.background.service_worker === 'string'
      ? manifest.background.service_worker
      : null;
  const backgroundWorkerExists = backgroundWorkerPath ? fs.existsSync(path.join(EXTENSION_PATH, backgroundWorkerPath)) : false;
  const welcomePath = fs.existsSync(path.join(EXTENSION_PATH, 'welcome.html')) ? 'welcome.html' : 'ui/panel.html';

  return {
    manifestExists: true,
    manifest,
    backgroundWorkerPath,
    backgroundWorkerExists,
    welcomePath
  };
}

function logSalesforceProfileStartup() {
  const profileExists = fs.existsSync(SALESFORCE_PROFILE_DIR);
  console.log('[FieldLens][Playwright] Using installed Google Chrome');
  console.log('[FieldLens][Playwright] Salesforce profile: .playwright/salesforce-profile');
  console.log('[FieldLens][Playwright] Salesforce profile exists:', profileExists ? 'yes' : 'no');
  console.log('[FieldLens][Playwright] Bootstrapped Salesforce profile mode:', USE_BOOTSTRAPPED_PROFILE ? 'enabled' : 'disabled');
  console.log('[FieldLens][Playwright] Connect existing Chrome mode:', CONNECT_EXISTING_CHROME ? 'enabled' : 'disabled');
  if (CONNECT_EXISTING_CHROME) {
    console.log('[FieldLens][Playwright] CDP endpoint:', EXISTING_CHROME_CDP_ENDPOINT);
  }
  console.log(
    '[FieldLens][Playwright] If this is the first run, login manually when Chrome opens. Later runs should reuse this profile.'
  );
  if (!profileExists) {
    console.log('[FieldLens][Playwright] Starting with a fresh Salesforce profile. Manual login will be required.');
  } else {
    console.log(
      '[FieldLens][Playwright] Existing Salesforce profile found. The test will try to reuse the saved Salesforce session.'
    );
  }
}

function resolveProfileSelection(profileType = PROFILE_TYPE_SALESFORCE) {
  const normalizedType = profileType === PROFILE_TYPE_EXTENSION ? PROFILE_TYPE_EXTENSION : PROFILE_TYPE_SALESFORCE;
  const useBootstrappedProfile = USE_BOOTSTRAPPED_PROFILE;
  const profileDir =
    useBootstrappedProfile
      ? SALESFORCE_PROFILE_DIR
      : normalizedType === PROFILE_TYPE_EXTENSION
        ? WELCOME_PROFILE_DIR
        : SALESFORCE_PROFILE_DIR;
  const launchArgs = useBootstrappedProfile
    ? ['--disable-crash-reporter', '--disable-breakpad', '--no-first-run', '--no-default-browser-check', '--disable-sync']
    : [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--disable-crash-reporter',
        '--disable-breakpad',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-sync'
      ];

  return {
    profileType: normalizedType,
    useBootstrappedProfile,
    profileDir,
    launchArgs
  };
}

async function launchFieldLensExtensionContext(options = {}) {
  const details = readManifestDetails();
  const profileSelection = resolveProfileSelection(options.profileType || PROFILE_TYPE_SALESFORCE);
  const profileDir = options.profileDir || profileSelection.profileDir;
  console.log('[FieldLens][Playwright] Extension path:', EXTENSION_PATH);
  console.log('[FieldLens][Playwright] Manifest exists:', details.manifestExists ? 'yes' : 'no');
  if (details.manifest) {
    console.log('[FieldLens][Playwright] Manifest name:', details.manifest.name || 'unknown');
    console.log('[FieldLens][Playwright] Manifest version:', details.manifest.version || 'unknown');
    console.log('[FieldLens][Playwright] Manifest version key:', details.manifest.manifest_version || 'unknown');
    console.log('[FieldLens][Playwright] Background service worker path:', details.backgroundWorkerPath || 'none');
    console.log('[FieldLens][Playwright] Background service worker file exists:', details.backgroundWorkerExists ? 'yes' : 'no');
  }

  if (!details.manifestExists) {
    throw new Error('FieldLens extension was not loaded in Playwright browser. Check extension path and Chromium launch args.');
  }

  fs.mkdirSync(PLAYWRIGHT_ROOT, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });
  try {
    return await chromium.launchPersistentContext(profileDir, {
      channel: 'chrome',
      headless: false,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: profileSelection.launchArgs
    });
  } catch (error) {
    const message = error && error.message ? error.message : 'Unknown Chromium launch failure.';
    if (/Crashpad\/settings\.dat|crashpad/i.test(message) || /Operation not permitted/i.test(message)) {
      throw new Error(
        'Playwright could not start Chromium in this environment because Chrome Crashpad file access was blocked. Extension load could not be verified here.'
      );
    }
    throw error;
  }
}

function tagConnectedContext(context, browser) {
  Object.defineProperty(context, '__fieldlensConnectedOverCdp', {
    value: true,
    configurable: true
  });
  Object.defineProperty(context, '__fieldlensBrowser', {
    value: browser,
    configurable: true
  });
  return context;
}

async function connectToExistingChrome() {
  console.log('[FieldLens][Playwright] Connect existing Chrome mode enabled');
  console.log('[FieldLens][Playwright] CDP endpoint used:', EXISTING_CHROME_CDP_ENDPOINT);

  let browser;
  try {
    browser = await chromium.connectOverCDP(EXISTING_CHROME_CDP_ENDPOINT);
  } catch (error) {
    const message = error && error.message ? error.message : 'Unable to connect to Chrome over CDP.';
    throw new Error(
      `Start Chrome with --remote-debugging-port=9222 and .playwright/salesforce-profile before running this test. ${message}`
    );
  }

  const contexts = browser.contexts();
  console.log('[FieldLens][Playwright] Connected Chrome contexts:', contexts.length);

  const pageUrls = [];
  contexts.forEach((context) => {
    context.pages().forEach((page) => {
      pageUrls.push(sanitizePageUrl(page.url()));
    });
  });
  console.log('[FieldLens][Playwright] Connected Chrome page URLs:', pageUrls.length ? pageUrls.join(', ') : 'none');

  if (!contexts.length) {
    throw new Error(
      'Start Chrome with --remote-debugging-port=9222 and .playwright/salesforce-profile before running this test.'
    );
  }

  return tagConnectedContext(contexts[0], browser);
}

async function launchFieldLensContext() {
  if (CONNECT_EXISTING_CHROME) {
    return connectToExistingChrome();
  }
  return launchFieldLensExtensionContext({
    profileType: PROFILE_TYPE_SALESFORCE
  });
}

function shouldClosePlaywrightContext(context) {
  return !(context && context.__fieldlensConnectedOverCdp);
}

async function getExtensionId(context) {
  let [background] = context.serviceWorkers();
  if (!background) {
    background = await context.waitForEvent('serviceworker', { timeout: EXTENSION_LOAD_TIMEOUT_MS });
  }
  console.log('[FieldLens][Playwright] Extension service worker/background detected:', background ? 'yes' : 'no');
  const url = background.url();
  const extensionId = new URL(url).host;
  console.log('[FieldLens][Playwright] Extension id:', extensionId || 'unavailable');
  return extensionId;
}

async function openExtensionPage(context, relativePath) {
  const extensionId = await getExtensionId(context);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${relativePath}`);
  console.log('[FieldLens][Playwright] Current page URL:', page.url());
  return page;
}

async function readExtensionStorage(serviceWorker) {
  return serviceWorker.evaluate(async () => chrome.storage.local.get(null));
}

async function getExtensionServiceWorker(context) {
  let [background] = context.serviceWorkers();
  if (!background) {
    background = await context.waitForEvent('serviceworker', { timeout: EXTENSION_LOAD_TIMEOUT_MS });
  }
  return background;
}

async function getExtensionIdFromChromeExtensionsPage(context, extensionName) {
  const page = await context.newPage();
  await page.goto('chrome://extensions/', { waitUntil: 'domcontentloaded' });
  console.log('[FieldLens][Playwright] Current page URL:', page.url());

  await page.waitForFunction(() => {
    const manager = document.querySelector('extensions-manager');
    return !!manager;
  }, { timeout: EXTENSION_LOAD_TIMEOUT_MS });

  const info = await page.evaluate((targetName) => {
    function textContent(node) {
      return node && typeof node.textContent === 'string' ? node.textContent.trim() : '';
    }
    function queryDeep(root, selectors) {
      let current = root;
      for (const selector of selectors) {
        if (!current) return null;
        const scope = current.shadowRoot || current;
        current = scope.querySelector(selector);
      }
      return current;
    }
    const manager = document.querySelector('extensions-manager');
    const managerRoot = manager && manager.shadowRoot;
    const itemsList = managerRoot && managerRoot.querySelector('extensions-item-list');
    const listRoot = itemsList && itemsList.shadowRoot;
    const items = listRoot ? Array.from(listRoot.querySelectorAll('extensions-item')) : [];

    const extensions = items.map((item) => {
      const root = item.shadowRoot || item;
      const name =
        textContent(root.querySelector('#name')) ||
        textContent(root.querySelector('.name')) ||
        textContent(root.querySelector('[id="name"]'));
      const idText =
        textContent(root.querySelector('#extension-id')) ||
        textContent(root.querySelector('#extension-id-line')) ||
        textContent(root.querySelector('.section .section-content')) ||
        '';
      const errorText =
        textContent(root.querySelector('#error-message')) ||
        textContent(root.querySelector('.error-message')) ||
        textContent(root.querySelector('[role="alert"]')) ||
        '';
      const idMatch = idText.match(/[a-p]{32}/i);
      return {
        name,
        id: idMatch ? idMatch[0] : null,
        errorText
      };
    });

    const found = extensions.find((entry) => entry.name === targetName) || null;
    return { found, extensions };
  }, extensionName);

  await page.close();

  if (info && info.found) {
    console.log('[FieldLens][Playwright] Extension listed in chrome://extensions:', info.found.name);
    console.log('[FieldLens][Playwright] Extension id:', info.found.id || 'unavailable');
    if (info.found.errorText) {
      console.log('[FieldLens][Playwright] Extension visible error:', info.found.errorText);
    }
    return info.found;
  }

  console.log('[FieldLens][Playwright] Extension listed in chrome://extensions:', 'no');
  return null;
}

async function assertExtensionLoaded(context) {
  const details = readManifestDetails();
  console.log('[FieldLens][Playwright] Extension path:', EXTENSION_PATH);
  console.log('[FieldLens][Playwright] Manifest exists:', details.manifestExists ? 'yes' : 'no');
  if (details.manifest) {
    console.log('[FieldLens][Playwright] Manifest name:', details.manifest.name || 'unknown');
    console.log('[FieldLens][Playwright] Manifest version:', details.manifest.version || 'unknown');
    console.log('[FieldLens][Playwright] Manifest version key:', details.manifest.manifest_version || 'unknown');
    console.log('[FieldLens][Playwright] Background service worker path:', details.backgroundWorkerPath || 'none');
    console.log('[FieldLens][Playwright] Background service worker file exists:', details.backgroundWorkerExists ? 'yes' : 'no');
  }
  if (!details.manifestExists) {
    throw new Error('FieldLens extension was not loaded in Playwright browser. Check extension path and Chromium launch args.');
  }

  console.log('[FieldLens][Playwright] Existing service workers count:', context.serviceWorkers().length);
  console.log('[FieldLens][Playwright] Existing background pages count:', typeof context.backgroundPages === 'function' ? context.backgroundPages().length : 0);

  let serviceWorker = context.serviceWorkers()[0] || null;
  let extensionId = null;
  if (!serviceWorker) {
    const listed = await getExtensionIdFromChromeExtensionsPage(context, details.manifest?.name || 'FieldLens for Salesforce');
    if (!listed) {
      throw new Error('FieldLens extension is not listed in chrome://extensions. Chrome likely rejected the unpacked extension.');
    }
    extensionId = listed.id || null;
  }
  if (!serviceWorker) {
    try {
      serviceWorker = await context.waitForEvent('serviceworker', { timeout: EXTENSION_LOAD_TIMEOUT_MS });
    } catch (_) {
      serviceWorker = null;
    }
  }
  const hasWorker = !!serviceWorker;
  console.log('[FieldLens][Playwright] Extension service worker/background detected:', hasWorker ? 'yes' : 'no');

  if (!extensionId && hasWorker) {
    extensionId = await getExtensionId(context);
  }

  if (!extensionId) {
    console.log('[FieldLens][Playwright] Extension id could not be detected automatically.');
    const diagPage = await context.newPage();
    await diagPage.goto('chrome://extensions/', { waitUntil: 'domcontentloaded' }).catch(() => null);
    console.log('[FieldLens][Playwright] Current page URL:', diagPage.url());
    await diagPage.close();
    throw new Error('FieldLens extension did not load. Chrome may have rejected the unpacked extension. Check manifest and launch args.');
  }

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${details.welcomePath}`, { waitUntil: 'domcontentloaded' });
  console.log('[FieldLens][Playwright] Current page URL:', page.url());
  const runtimeId = await page.evaluate(() => (globalThis.chrome && chrome.runtime ? chrome.runtime.id : null));
  if (!serviceWorker) {
    try {
      serviceWorker = await context.waitForEvent('serviceworker', { timeout: EXTENSION_LOAD_TIMEOUT_MS });
    } catch (_) {
      serviceWorker = null;
    }
  }
  await page.close();
  console.log('[FieldLens][Playwright] chrome.runtime.id available:', runtimeId ? 'yes' : 'no');
  console.log('[FieldLens][Playwright] Extension service worker/background detected:', serviceWorker ? 'yes' : 'no');

  if (!runtimeId) {
    throw new Error('FieldLens extension did not load. Chrome may have rejected the unpacked extension. Check manifest and launch args.');
  }

  return { extensionId, welcomePath: details.welcomePath };
}

async function diagnoseExtensionLoaded(context) {
  const details = readManifestDetails();
  const result = {
    ok: false,
    manifestExists: details.manifestExists,
    extensionId: null,
    welcomePath: details.welcomePath,
    serviceWorkerDetected: false,
    listedInChromeExtensions: false,
    error: null
  };

  try {
    console.log('[FieldLens][Playwright] Extension diagnostic (non-blocking) starting.');
    console.log('[FieldLens][Playwright] Extension path:', EXTENSION_PATH);
    console.log('[FieldLens][Playwright] Manifest exists:', details.manifestExists ? 'yes' : 'no');
    if (details.manifest) {
      console.log('[FieldLens][Playwright] Manifest name:', details.manifest.name || 'unknown');
      console.log('[FieldLens][Playwright] Manifest version:', details.manifest.version || 'unknown');
      console.log('[FieldLens][Playwright] Manifest version key:', details.manifest.manifest_version || 'unknown');
      console.log('[FieldLens][Playwright] Background service worker path:', details.backgroundWorkerPath || 'none');
      console.log('[FieldLens][Playwright] Background service worker file exists:', details.backgroundWorkerExists ? 'yes' : 'no');
    }

    const existingWorker = context.serviceWorkers()[0] || null;
    result.serviceWorkerDetected = !!existingWorker;
    console.log('[FieldLens][Playwright] Existing service workers count:', context.serviceWorkers().length);
    console.log('[FieldLens][Playwright] Existing background pages count:', typeof context.backgroundPages === 'function' ? context.backgroundPages().length : 0);

    if (existingWorker) {
      result.extensionId = new URL(existingWorker.url()).host;
      result.ok = true;
      console.log('[FieldLens][Playwright] Extension diagnostic passed via service worker.');
      console.log('[FieldLens][Playwright] Extension id:', result.extensionId);
      return result;
    }

    const listed = await getExtensionIdFromChromeExtensionsPage(
      context,
      details.manifest?.name || 'FieldLens for Salesforce'
    ).catch((error) => {
      console.log('[FieldLens][Playwright] Extension diagnostic chrome://extensions lookup failed:', error?.message || 'Unknown error');
      return null;
    });

    if (listed) {
      result.listedInChromeExtensions = true;
      result.extensionId = listed.id || null;
      result.ok = true;
      console.log('[FieldLens][Playwright] Extension diagnostic found extension in chrome://extensions.');
      if (listed.errorText) {
        console.log('[FieldLens][Playwright] Extension visible error:', listed.errorText);
      }
    } else {
      console.log('[FieldLens][Playwright] Extension diagnostic did not find extension in chrome://extensions.');
    }
  } catch (error) {
    result.error = error?.message || 'Unknown diagnostic error';
    console.log('[FieldLens][Playwright] Extension diagnostic failed (non-blocking):', result.error);
  }

  console.log('[FieldLens][Playwright] Continuing to Salesforce test.');
  return result;
}

async function getSalesforceIdentity(page) {
  console.log('[FieldLens][Playwright] Current URL before getSalesforceIdentity:', page.url());
  const result = await page.evaluate(async () => {
    async function readApi(path, label) {
      try {
        const res = await fetch(path, {
          method: 'GET',
          credentials: 'include',
          headers: { Accept: 'application/json' }
        });
        const contentType = res.headers.get('content-type') || '';
        const text = await res.text();
        let data = null;
        try {
          data = JSON.parse(text);
        } catch (_) {
          data = null;
        }
        const message =
          Array.isArray(data) && data[0] && typeof data[0].message === 'string'
            ? data[0].message
            : data && typeof data.message === 'string'
              ? data.message
              : '';

        return {
          ok: res.ok,
          label,
          path,
          status: res.status,
          contentType,
          message,
          isHtml: /<html/i.test(text),
          data
        };
      } catch (error) {
        return {
          ok: false,
          label,
          path,
          status: 0,
          contentType: '',
          message: error && error.message ? error.message : 'Network error',
          isHtml: false,
          data: null
        };
      }
    }

    const hostname = window.location.hostname;
    const href = window.location.href;
    const userLookup = await readApi('/services/data/v60.0/chatter/users/me', 'user_lookup');
    const orgLookup = await readApi(
      '/services/data/v60.0/query/?q=' + encodeURIComponent('SELECT Id, InstanceName FROM Organization LIMIT 1'),
      'org_lookup'
    );

    return { hostname, href, userLookup, orgLookup };
  });

  const logLookup = (lookup, purpose) => {
    console.log(
      `[FieldLens][Playwright] Identity ${purpose}: endpoint=${lookup.path} status=${lookup.status} contentType=${lookup.contentType || 'unknown'} hostname=${result.hostname} url=${result.href}`
    );
  };

  logLookup(result.userLookup, 'user lookup');
  const userStatus = classifySalesforceApiResult(result.userLookup);
  if (!userStatus.ok) {
    throw new Error(`Failed to resolve Salesforce user identity: ${userStatus.message}`);
  }

  const userData = result.userLookup.data && typeof result.userLookup.data === 'object' ? result.userLookup.data : null;
  const userId = userData && (userData.id || userData.userId) ? userData.id || userData.userId : null;
  if (!userId) {
    throw new Error('Failed to resolve Salesforce user identity: Missing user id');
  }

  logLookup(result.orgLookup, 'org lookup');
  const orgStatus = classifySalesforceApiResult(result.orgLookup);
  let orgId = 'unknown-org';
  let instanceKey = sanitizeIdentityValue(result.hostname, 'unknown-instance');

  if (orgStatus.ok) {
    const rows = result.orgLookup.data && Array.isArray(result.orgLookup.data.records) ? result.orgLookup.data.records : [];
    const org = rows[0] || null;
    if (org && org.Id) {
      orgId = org.Id;
    }
    if (org && org.InstanceName) {
      instanceKey = sanitizeIdentityValue(org.InstanceName, instanceKey);
    }
  } else {
    console.log(`[FieldLens][Playwright] Failed to resolve Salesforce org identity: ${orgStatus.message}`);
    console.log('[FieldLens][Playwright] Org lookup failed, using fallback identity');
    console.log('[FieldLens][Playwright] Fallback scope marker:', `${sanitizeIdentityValue(result.hostname, 'unknown-host')}:${instanceKey}`);
    console.log('[FieldLens][Playwright] Masked userId:', maskIdentityValue(userId));
    console.log('[FieldLens][Playwright] Hostname:', result.hostname);
    console.log('[FieldLens][Playwright] InstanceKey:', instanceKey);
  }

  return buildFallbackIdentity({
    hostname: result.hostname,
    userId,
    orgId,
    instanceKey
  });
}

async function getSalesforceIdentityWithRetry(page, options = {}) {
  const attempts = Number(options.attempts || IDENTITY_RETRY_COUNT);
  const timeoutMs = Number(options.timeoutMs || MANUAL_LOGIN_TIMEOUT_MS);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await getSalesforceIdentity(page);
    } catch (error) {
      lastError = error;
      console.log(
        `[FieldLens][Playwright] Identity attempt ${attempt}/${attempts} failed: ${error && error.message ? error.message : 'Unknown error'}`
      );
      if (attempt < attempts) {
        await waitForSalesforceApiSession(page, { timeoutMs });
      }
    }
  }

  throw lastError || new Error('Failed to resolve Salesforce identity after retries');
}

async function pageNeedsSalesforceLogin(page) {
  return page.evaluate(() => {
    const href = window.location.href.toLowerCase();
    const hostname = window.location.hostname.toLowerCase();
    if (hostname === 'login.salesforce.com' || hostname === 'test.salesforce.com') {
      return true;
    }

    const formSelectors = [
      'form[action*="login"]',
      'input#username',
      'input#password',
      'input[name="username"]',
      'input[name="pw"]',
      'input[type="password"]'
    ];

    return formSelectors.some((selector) => document.querySelector(selector)) || href.includes('/secur/frontdoor.jsp');
  });
}

async function waitForSalesforceAppReady(page, options = {}) {
  const targetLabel = options.targetLabel || 'Salesforce page';
  const readyPattern = options.readyPattern || /\/lightning\/(r|setup)\//i;
  const timeoutMs = options.timeoutMs || MANUAL_LOGIN_TIMEOUT_MS;
  console.log('[FieldLens][Playwright] Current URL before login detection:', page.url());

  const needsLogin = await pageNeedsSalesforceLogin(page);
  console.log('[FieldLens][Playwright] Login page detected:', needsLogin ? 'yes' : 'no');
  if (needsLogin) {
    console.log('[FieldLens][Playwright] Please login to Salesforce manually in the Playwright browser, then return to the test.');
  }

  try {
    await page.waitForFunction(
      ({ readySource }) => {
        const href = window.location.href;
        const bodyText = document.body ? document.body.innerText || '' : '';
        return new RegExp(readySource, 'i').test(href) || /record[- ]home|details|related/i.test(bodyText);
      },
      { readySource: readyPattern.source },
      { timeout: timeoutMs }
    );
    console.log('[FieldLens][Playwright] Lightning page detected:', 'yes');
  } catch (_) {
    throw new Error(
      `${targetLabel} was not reached after manual login. Please complete login in the Playwright browser and wait for the Lightning page to load.`
    );
  }
}

async function waitForSalesforceApiSession(page, options = {}) {
  const timeoutMs = options.timeoutMs || MANUAL_LOGIN_TIMEOUT_MS;
  const pollMs = options.pollMs || API_SESSION_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  let lastState = 'unknown';

  while (Date.now() < deadline) {
    const currentUrl = page.url();
    let sessionState = null;
    try {
      sessionState = await page.evaluate(async () => {
        try {
          const res = await fetch('/services/data/v60.0/chatter/users/me', {
            method: 'GET',
            credentials: 'include',
            headers: { Accept: 'application/json' }
          });
          const contentType = res.headers.get('content-type') || '';
          const text = await res.text();

          let data = null;
          try {
            data = JSON.parse(text);
          } catch (_) {
            data = null;
          }

          const sfMessage =
            Array.isArray(data) && data[0] && typeof data[0].message === 'string'
              ? data[0].message
              : data && typeof data.message === 'string'
                ? data.message
                : '';

          if (
            res.ok &&
            /application\/json/i.test(contentType) &&
            data &&
            typeof data === 'object' &&
            (data.id || data.userId)
          ) {
            return { ready: true };
          }

          if (
            res.status === 401 ||
            res.status === 403 ||
            !/application\/json/i.test(contentType) ||
            /INVALID_SESSION_ID|Session expired or invalid/i.test(sfMessage || '') ||
            /<html/i.test(text)
          ) {
            return {
              ready: false,
              state:
                res.status === 401 || res.status === 403
                  ? `http_${res.status}`
                  : !/application\/json/i.test(contentType)
                    ? 'non_json'
                    : /<html/i.test(text)
                      ? 'html_login'
                      : 'invalid_session'
            };
          }

          return { ready: false, state: `not_ready_${res.status}` };
        } catch (_) {
          return { ready: false, state: 'network_or_redirect' };
        }
      });
    } catch (_) {
      sessionState = { ready: false, state: 'page_eval_failed' };
    }

    if (sessionState && sessionState.ready) {
      console.log('[FieldLens][Playwright] API session is ready:', 'yes');
      return;
    }

    const stateLabel = sessionState && sessionState.state ? sessionState.state : 'waiting';
    if (stateLabel !== lastState) {
      console.log('[FieldLens][Playwright] API session is ready:', 'no');
      console.log('[FieldLens][Playwright] Waiting for Salesforce API session. URL:', currentUrl);
      lastState = stateLabel;
    }

    await page.waitForTimeout(pollMs);
  }

  throw new Error(
    'Salesforce API session was not ready before timeout. Please complete login in the Playwright browser, wait for Salesforce to finish redirecting, and try again.'
  );
}

async function openLauncherAndWait(page) {
  await page.locator('#fieldlens-floating-button').click();
  await expectVisible(page.locator('#fieldlens-panel-shell'));
}

async function expectVisible(locator) {
  await locator.waitFor({ state: 'visible', timeout: 30000 });
}

module.exports = {
  EXTENSION_PATH,
  WELCOME_PROFILE_DIR,
  SALESFORCE_PROFILE_DIR,
  PROFILE_TYPE_EXTENSION,
  PROFILE_TYPE_SALESFORCE,
  CONNECT_EXISTING_CHROME,
  EXISTING_CHROME_CDP_ENDPOINT,
  logSalesforceProfileStartup,
  resolveProfileSelection,
  launchFieldLensContext,
  launchFieldLensExtensionContext,
  shouldClosePlaywrightContext,
  getExtensionId,
  openExtensionPage,
  assertExtensionLoaded,
  diagnoseExtensionLoaded,
  getExtensionServiceWorker,
  readExtensionStorage,
  getSalesforceIdentity,
  getSalesforceIdentityWithRetry,
  pageNeedsSalesforceLogin,
  waitForSalesforceAppReady,
  waitForSalesforceApiSession,
  openLauncherAndWait,
  expectVisible,
  classifySalesforceApiResult,
  buildFallbackIdentity
};
