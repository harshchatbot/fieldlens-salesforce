const { test, expect } = require('@playwright/test');
const {
  launchFieldLensContext,
  getExtensionIdFromChromeExtensionsPage,
  waitForSalesforceAppReady,
  waitForSalesforceApiSession,
  shouldClosePlaywrightContext
} = require('./helpers');

const SF_RECORD_URL = process.env.FIELDLENS_SF_RECORD_URL || '';
const LOGIN_TIMEOUT_MS = Number(process.env.FIELDLENS_LOGIN_TIMEOUT_MS || 180000);
const ACTION_TIMEOUT_MS = Number(process.env.FIELDLENS_FUNCTIONAL_ACTION_TIMEOUT_MS || 30000);
const EXPECTED_EXTENSION_NAME = 'FieldLens for Salesforce';
const SCAN_FIELD_API = process.env.FIELDLENS_SCAN_FIELD_API || '';
const PRIMARY_SCAN_FIELD = process.env.FIELDLENS_SCAN_FIELD || 'Phone';
const SCAN_FIELD_FALLBACKS = ['Phone', 'Website', 'Industry', 'Type', 'AccountNumber'];
const FATAL_ERROR_PATTERN = /Unhandled|TypeError|ReferenceError|Cannot read|undefined is not/i;

test.describe.configure({ mode: 'serial' });
test.skip(!SF_RECORD_URL, 'Set FIELDLENS_SF_RECORD_URL to run the Web Store Salesforce E2E.');
test.skip(
  String(process.env.FIELDLENS_VALIDATE_WEBSTORE_EXTENSION || '').toLowerCase() !== 'true',
  'Set FIELDLENS_VALIDATE_WEBSTORE_EXTENSION=true to run the Chrome Web Store smoke test.'
);

function panelFrame(page) {
  return page.frameLocator('#fieldlens-panel-frame');
}

async function assertWebStoreExtension(context) {
  const listed = await getExtensionIdFromChromeExtensionsPage(context, EXPECTED_EXTENSION_NAME);
  expect(listed, `Chrome Web Store extension "${EXPECTED_EXTENSION_NAME}" was not found in chrome://extensions.`).toBeTruthy();
  expect(listed.name).toBe(EXPECTED_EXTENSION_NAME);
  expect(listed.id, 'Chrome Web Store extension id was not detected.').toMatch(/^[a-p]{32}$/i);
  if (listed.errorText) {
    throw new Error(`Chrome Web Store extension has a visible error: ${listed.errorText}`);
  }
  console.log('[FieldLens][Playwright] Web Store extension detected:', listed.name);
  console.log('[FieldLens][Playwright] Web Store extension id detected: yes');
  return listed;
}

async function openRecordPage(page) {
  await test.step('open Salesforce record page', async () => {
    await page.goto(SF_RECORD_URL, { waitUntil: 'domcontentloaded' });
    console.log('[FieldLens][Playwright] Current Salesforce URL:', page.url());
  });
  await test.step('wait for Lightning/session', async () => {
    await waitForSalesforceAppReady(page, {
      targetLabel: 'Salesforce record page',
      readyPattern: /\/lightning\/r\//i,
      timeoutMs: LOGIN_TIMEOUT_MS
    });
    await waitForSalesforceApiSession(page, { timeoutMs: LOGIN_TIMEOUT_MS });
  });
}

async function openPanel(page) {
  await test.step('wait for FieldLens button', async () => {
    await expect(page.locator('[data-testid="fieldlens-floating-button"], #fieldlens-floating-button')).toBeVisible({
      timeout: 30000
    });
  });
  await test.step('open FieldLens panel', async () => {
    await page.locator('[data-testid="fieldlens-floating-button"], #fieldlens-floating-button').click();
    await expect(page.locator('[data-testid="fieldlens-panel-shell"], #fieldlens-panel-shell')).toHaveAttribute(
      'aria-hidden',
      'false',
      { timeout: 30000 }
    );
  });
}

async function selectField(page, apiName) {
  const frame = panelFrame(page);
  const search = frame.locator('[data-testid="field-search-input"], input[placeholder*="Search" i], input[type="search"], input').first();
  const list = frame.locator('[data-testid="field-result-list"], #fieldSelect');
  await search.fill(apiName);
  await expect(list).toBeVisible({ timeout: 30000 });
  await expect
    .poll(
      () => list.evaluate((node) => Array.from(node.options || []).map((option) => option.textContent || '')),
      { timeout: ACTION_TIMEOUT_MS }
    )
    .toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`\\(${apiName}\\)|\\[${apiName}\\]`, 'i'))]));

  const option = await list.evaluate((node, wantedApiName) => {
    const options = Array.from(node.options || []);
    const exact = options.find((entry) => {
      const text = entry.textContent || '';
      return new RegExp(`\\(${wantedApiName}\\)|\\[${wantedApiName}\\]`, 'i').test(text);
    });
    return exact ? { value: exact.value, text: exact.textContent || '' } : null;
  }, apiName);
  expect(option, `Exact field API name ${apiName} was not found.`).toBeTruthy();
  await list.selectOption(option.value);
  console.log('[FieldLens][Playwright] Web Store smoke field selected:', option.text);
}

function parseFieldOption(option) {
  const text = String(option?.text || '');
  const match = text.match(/^(.*?) \(([^)]+)\) \[([^\]]+)\]/);
  return {
    value: option?.value || '',
    text,
    label: match ? match[1].trim() : text,
    apiName: match ? match[2].trim() : ''
  };
}

async function selectScanSmokeField(page) {
  const frame = panelFrame(page);
  const search = frame.locator('[data-testid="field-search-input"], input[placeholder*="Search" i], input[type="search"], input').first();
  const list = frame.locator('[data-testid="field-result-list"], #fieldSelect');
  const candidates = [SCAN_FIELD_API || PRIMARY_SCAN_FIELD, ...SCAN_FIELD_FALLBACKS].filter(
    (value, index, values) => value && values.indexOf(value) === index
  );

  for (const candidate of candidates) {
    await search.fill('');
    await search.fill(candidate);
    await expect(list).toBeVisible({ timeout: 30000 });
    const rawOptions = await list.evaluate((node) =>
      Array.from(node.options || []).map((option) => ({ value: option.value, text: option.textContent || '' }))
    );
    const options = rawOptions.map(parseFieldOption);
    const normalized = candidate.toLowerCase();
    const exactApiMatch = options.find((option) => option.apiName.toLowerCase() === normalized);
    const exactLabelMatch = options.find((option) => option.label.toLowerCase() === normalized);
    const containsMatch = options.find(
      (option) =>
        option.apiName.toLowerCase().includes(normalized) ||
        option.label.toLowerCase().includes(normalized) ||
        option.text.toLowerCase().includes(normalized)
    );
    const chosen = exactApiMatch || exactLabelMatch || containsMatch;
    if (!chosen) {
      continue;
    }

    await list.selectOption(chosen.value);
    console.log('[FieldLens][Playwright] Web Store scan field selected:', chosen.text);
    console.log('[FieldLens][Playwright] selected scan field exactMatch=' + String(!!(exactApiMatch || exactLabelMatch)));
    return { selectedText: chosen.text, selectedValue: chosen.value };
  }

  throw new Error(`None of the configured Web Store scan fields were found: ${candidates.join(', ')}`);
}

async function assertHealthy(page) {
  await expect(page.locator('#fieldlens-panel-shell')).toBeAttached();
  const frameText = await panelFrame(page).locator('body').innerText().catch(() => '');
  expect(frameText).not.toMatch(FATAL_ERROR_PATTERN);
}

test('Chrome Web Store extension supports the Salesforce record-page smoke flow', async () => {
  let context;
  try {
    console.log('[FieldLens][Playwright] Chrome Web Store validation mode enabled.');
    context = await launchFieldLensContext();
    await test.step('verify installed Web Store extension', async () => {
      await assertWebStoreExtension(context);
    });

    const page = await context.newPage();
    await openRecordPage(page);
    await openPanel(page);

    await test.step('search and select Name field', async () => {
      await selectField(page, 'Name');
    });
    await test.step('select Phone scan field', async () => {
      await selectScanSmokeField(page);
    });
    await test.step('run Quick Scan', async () => {
      const frame = panelFrame(page);
      await frame.locator('[data-testid="quick-scan-button"], button:has-text("Quick")').first().click();
      await frame.locator('[data-testid="run-impact-scan-button"], button:has-text("Run Impact Scan")').first().click();
      await expect(frame.locator('[data-testid="scan-loading-indicator"]')).toBeHidden({ timeout: ACTION_TIMEOUT_MS });
    });
    await test.step('copy summary', async () => {
      await frameButton(page, '[data-testid="copy-results-button"], button:has-text("Copy")').click();
    });
    await test.step('close panel', async () => {
      await frameButton(page, '[data-testid="close-panel-button"], button:has-text("Close")').click();
      await expect(page.locator('#fieldlens-panel-shell')).toHaveAttribute('aria-hidden', 'true');
    });
    await test.step('health assertion', async () => {
      await assertHealthy(page);
    });
  } finally {
    if (context && shouldClosePlaywrightContext(context)) {
      await context.close();
    }
  }
});

function frameButton(page, selector) {
  return panelFrame(page).locator(selector).first();
}
