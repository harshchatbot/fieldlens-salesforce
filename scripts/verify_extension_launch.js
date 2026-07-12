const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

const REPO_ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'manifest.json');
const PROFILE_DIR = path.join(REPO_ROOT, '.playwright', 'verify-extension-profile');
const SALESFORCE_PROFILE_DIR = path.join(REPO_ROOT, '.playwright', 'salesforce-profile');
const EXTENSION_NAME = 'FieldLens for Salesforce';
const EXTENSION_LOAD_TIMEOUT_MS = 15000;
const VISUAL_INSPECTION_MS = 20000;
const USE_BOOTSTRAPPED_PROFILE = String(process.env.FIELDLENS_USE_BOOTSTRAPPED_PROFILE || '').toLowerCase() === 'true';

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
  const backgroundWorkerExists = backgroundWorkerPath
    ? fs.existsSync(path.join(REPO_ROOT, backgroundWorkerPath))
    : false;
  const welcomePath = fs.existsSync(path.join(REPO_ROOT, 'welcome.html')) ? 'welcome.html' : 'ui/panel.html';

  return {
    manifestExists: true,
    manifest,
    backgroundWorkerPath,
    backgroundWorkerExists,
    welcomePath
  };
}

async function getExtensionIdFromChromeExtensionsPage(context, extensionName) {
  const page = await context.newPage();
  await page.goto('chrome://extensions/', { waitUntil: 'domcontentloaded' });
  console.log('[FieldLens][Verify] Current page URL:', page.url());

  await page.waitForFunction(() => !!document.querySelector('extensions-manager'), {
    timeout: EXTENSION_LOAD_TIMEOUT_MS
  });

  const info = await page.evaluate((targetName) => {
    function textContent(node) {
      return node && typeof node.textContent === 'string' ? node.textContent.trim() : '';
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

    return extensions.find((entry) => entry.name === targetName) || null;
  }, extensionName);

  await page.close();
  return info;
}

async function main() {
  const details = readManifestDetails();
  console.log('[FieldLens][Verify] Extension path:', REPO_ROOT);
  console.log('[FieldLens][Verify] Manifest exists:', details.manifestExists ? 'yes' : 'no');
  if (!details.manifestExists) {
    throw new Error('manifest.json was not found at the repo root.');
  }

  console.log('[FieldLens][Verify] Manifest name:', details.manifest.name || 'unknown');
  console.log('[FieldLens][Verify] Manifest version:', details.manifest.version || 'unknown');
  console.log('[FieldLens][Verify] Manifest version key:', details.manifest.manifest_version || 'unknown');
  console.log('[FieldLens][Verify] Background service worker path:', details.backgroundWorkerPath || 'none');
  console.log('[FieldLens][Verify] Background service worker file exists:', details.backgroundWorkerExists ? 'yes' : 'no');
  console.log('[FieldLens][Verify] Bootstrapped profile mode:', USE_BOOTSTRAPPED_PROFILE ? 'enabled' : 'disabled');

  const selectedProfileDir = USE_BOOTSTRAPPED_PROFILE ? SALESFORCE_PROFILE_DIR : PROFILE_DIR;
  fs.mkdirSync(path.dirname(selectedProfileDir), { recursive: true });
  fs.mkdirSync(selectedProfileDir, { recursive: true });

  let context;
  try {
    context = await chromium.launchPersistentContext(selectedProfileDir, {
      channel: 'chrome',
      headless: false,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: USE_BOOTSTRAPPED_PROFILE
        ? ['--disable-crash-reporter', '--disable-breakpad', '--no-first-run', '--no-default-browser-check', '--disable-sync']
        : [
            '--disable-extensions-except=' + REPO_ROOT,
            '--load-extension=' + REPO_ROOT,
            '--disable-crash-reporter',
            '--disable-breakpad',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-sync'
          ]
    });
  } catch (error) {
    console.log('[FieldLens][Verify] Chrome launch failed.');
    throw error;
  }

  try {
    const listed = await getExtensionIdFromChromeExtensionsPage(context, EXTENSION_NAME);
    console.log('[FieldLens][Verify] Extension card found:', listed ? 'yes' : 'no');
    console.log('[FieldLens][Verify] Extension id:', listed && listed.id ? listed.id : 'unavailable');
    console.log('[FieldLens][Verify] Extension visible error:', listed && listed.errorText ? listed.errorText : 'none');

    let serviceWorker = context.serviceWorkers()[0] || null;
    if (!serviceWorker) {
      try {
        serviceWorker = await context.waitForEvent('serviceworker', { timeout: EXTENSION_LOAD_TIMEOUT_MS });
      } catch (_) {
        serviceWorker = null;
      }
    }
    console.log('[FieldLens][Verify] Service worker detected:', serviceWorker ? 'yes' : 'no');

    let welcomeLoaded = false;
    if (listed && listed.id) {
      const welcomePage = await context.newPage();
      await welcomePage.goto(`chrome-extension://${listed.id}/${details.welcomePath}`, { waitUntil: 'domcontentloaded' });
      welcomeLoaded = welcomePage.url().startsWith(`chrome-extension://${listed.id}/`);
      console.log('[FieldLens][Verify] Welcome page loaded:', welcomeLoaded ? 'yes' : 'no');
    } else {
      console.log('[FieldLens][Verify] Welcome page loaded:', 'no');
    }

    console.log(`[FieldLens][Verify] Keeping Chrome open for ${VISUAL_INSPECTION_MS / 1000} seconds for visual inspection...`);
    await new Promise((resolve) => setTimeout(resolve, VISUAL_INSPECTION_MS));
  } finally {
    if (context) {
      await context.close();
    }
  }
}

main().catch((error) => {
  console.error('[FieldLens][Verify] Failed:', error && error.message ? error.message : String(error));
  process.exitCode = 1;
});
