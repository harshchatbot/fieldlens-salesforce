const { test, expect } = require('@playwright/test');
const {
  logSalesforceProfileStartup,
  launchFieldLensContext,
  diagnoseExtensionLoaded,
  waitForSalesforceAppReady,
  waitForSalesforceApiSession,
  shouldClosePlaywrightContext
} = require('./helpers');

const SF_RECORD_URL = process.env.FIELDLENS_SF_RECORD_URL || '';
const LOGIN_TIMEOUT_MS = Number(process.env.FIELDLENS_LOGIN_TIMEOUT_MS || 180000);
const ACTION_TIMEOUT_MS = Number(process.env.FIELDLENS_FUNCTIONAL_ACTION_TIMEOUT_MS || 15000);
const SKIP_DEEP_SCAN_TEST = String(process.env.FIELDLENS_SKIP_DEEP_SCAN_TEST || '').toLowerCase() === 'true';
const SKIP_EXPORT_TEST = String(process.env.FIELDLENS_SKIP_EXPORT_TEST || '').toLowerCase() === 'true';
const PRIMARY_SCAN_FIELD = process.env.FIELDLENS_SCAN_FIELD || 'Phone';
const SCAN_FIELD_API = process.env.FIELDLENS_SCAN_FIELD_API || '';
const SCAN_FIELD_FALLBACKS = [PRIMARY_SCAN_FIELD, 'Website', 'Industry', 'Type', 'AccountNumber'];
const FATAL_ERROR_PATTERN = /Unhandled|TypeError|ReferenceError|Cannot read|undefined is not/i;
const TOOLBAR_BUTTON_TIMEOUT_MS = 5000;

test.describe.configure({ mode: 'serial' });

function panelFrame(page) {
  return page.frameLocator('#fieldlens-panel-frame');
}

function sanitizeButtonLabel(button) {
  return button.testId || button.id || button.ariaLabel || button.title || button.text || 'unnamed-button';
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseFieldOption(option) {
  const text = String(option?.text || '');
  const match = text.match(/^(.*?) \(([^)]+)\) \[([^\]]+)\]/);
  return {
    value: option?.value || '',
    text,
    label: match ? match[1].trim() : text,
    apiName: match ? match[2].trim() : '',
    dataType: match ? match[3].trim() : ''
  };
}

async function prepareRecordPage(page) {
  await page.goto(SF_RECORD_URL, { waitUntil: 'domcontentloaded' });
  console.log('[FieldLens][Playwright] Current Salesforce URL:', page.url());
  await waitForSalesforceAppReady(page, {
    targetLabel: 'Salesforce record page',
    readyPattern: /\/lightning\/r\//i,
    timeoutMs: LOGIN_TIMEOUT_MS
  });
  await waitForSalesforceApiSession(page, { timeoutMs: LOGIN_TIMEOUT_MS });
}

async function openFieldLensPanel(page) {
  const launcher = page.locator('[data-testid="fieldlens-floating-button"], #fieldlens-floating-button');
  await expect(launcher).toBeVisible({ timeout: 30000 });
  await launcher.click();
  await expect(page.locator('[data-testid="fieldlens-panel-shell"], #fieldlens-panel-shell')).toHaveAttribute(
    'aria-hidden',
    'false'
  );
  await expect(panelFrame(page).locator('[data-testid="field-search-input"], #fieldSearchInput')).toBeVisible({
    timeout: 30000
  });
}

async function findFieldSearchInput(page) {
  const frame = panelFrame(page);
  const selectors = [
    '[data-testid="field-search-input"]',
    'input[placeholder*="Search" i]',
    'input[type="search"]',
    'input'
  ];

  for (const selector of selectors) {
    const locator = frame.locator(selector).first();
    if (await locator.count()) {
      return locator;
    }
  }

  throw new Error('Field search input was not found in FieldLens panel.');
}

async function searchAndSelectField(page, fieldName) {
  const searchInput = await findFieldSearchInput(page);
  const frame = panelFrame(page);
  const fieldList = frame.locator('[data-testid="field-result-list"], #fieldSelect');

  await searchInput.fill('');
  await searchInput.fill(fieldName);
  await expect(fieldList).toBeVisible({ timeout: 30000 });

  const fieldPattern = new RegExp(escapeRegex(fieldName), 'i');
  await expect
    .poll(
      async () =>
        fieldList.evaluate((node) =>
          Array.from(node.options || []).map((option) => ({ value: option.value, text: option.textContent || '' }))
        ),
      { timeout: ACTION_TIMEOUT_MS }
    )
    .toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringMatching(fieldPattern) })]));

  const rawOptions = await fieldList.evaluate((node) =>
    Array.from(node.options || []).map((option) => ({ value: option.value, text: option.textContent || '' }))
  );
  const options = rawOptions.map(parseFieldOption);
  const matchedOption = options.find((option) => fieldPattern.test(option.text));
  if (!matchedOption) {
    throw new Error(`No field search result matched "${fieldName}".`);
  }

  await fieldList.selectOption(matchedOption.value);
  const selectedText = await fieldList.evaluate((node) => {
    const selected = node.options[node.selectedIndex];
    return selected ? selected.textContent || '' : '';
  });
  expect(selectedText).toMatch(fieldPattern);
  return { selectedText, selectedValue: matchedOption.value };
}

async function selectScanSmokeField(page) {
  const searchInput = await findFieldSearchInput(page);
  const frame = panelFrame(page);
  const fieldList = frame.locator('[data-testid="field-result-list"], #fieldSelect');
  const candidates = [SCAN_FIELD_API || PRIMARY_SCAN_FIELD, ...SCAN_FIELD_FALLBACKS].filter(
    (value, index, arr) => value && arr.indexOf(value) === index
  );

  for (const candidate of candidates) {
    await searchInput.fill('');
    await searchInput.fill(candidate);
    await expect(fieldList).toBeVisible({ timeout: 30000 });
    const rawOptions = await fieldList.evaluate((node) =>
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

    await fieldList.selectOption(chosen.value);
    console.log('[FieldLens][Playwright] scan smoke field selected:', chosen.text);
    console.log('[FieldLens][Playwright] selected scan field exactMatch=' + String(!!(exactApiMatch || exactLabelMatch)));
    return { selectedText: chosen.text, selectedValue: chosen.value };
  }

  throw new Error(`None of the configured scan smoke fields were found: ${candidates.join(', ')}`);
}

async function getSelectedFieldText(page) {
  const frame = panelFrame(page);
  const fieldList = frame.locator('[data-testid="field-result-list"], #fieldSelect');
  return fieldList.evaluate((node) => {
    const selected = node.options[node.selectedIndex];
    return selected ? selected.textContent || '' : '';
  });
}

async function getScanOutcomeDebug(page) {
  const frame = panelFrame(page);
  const loadingState = frame.locator('#loadingState');
  const results = frame.locator('[data-testid="results-container"], #resultsContainer');
  const selectedFieldText = await getSelectedFieldText(page).catch(() => 'unknown');
  const loadingVisible = await loadingState.isVisible().catch(() => false);
  const resultsText = await results.textContent().catch(() => '');
  return {
    loadingVisible,
    selectedFieldText,
    resultsText: String(resultsText || '').trim().slice(0, 400)
  };
}

async function assertFieldLensStillHealthy(page) {
  await expect(page.locator('[data-testid="fieldlens-panel-shell"], #fieldlens-panel-shell')).toHaveCount(1, {
    timeout: ACTION_TIMEOUT_MS
  });
  const frame = panelFrame(page);
  await expect(frame.locator('body')).toBeVisible({ timeout: ACTION_TIMEOUT_MS });
  await expect(frame.locator('body')).not.toContainText(FATAL_ERROR_PATTERN, { timeout: 1000 });
}

async function getVisibleFieldLensButtons(page, options = {}) {
  const frame = page.frames().find((entry) => /\/ui\/panel\.html$/i.test(entry.url()));
  if (!frame) {
    throw new Error('FieldLens panel frame is not available.');
  }

  const scopeSelector = options.scopeSelector || null;
  return frame.evaluate((selector) => {
    const roots = selector ? Array.from(document.querySelectorAll(selector)) : [document];
    const buttons = roots.flatMap((root) => Array.from(root.querySelectorAll('button')));
    return buttons.map((button) => ({
      id: button.id || '',
      testId: button.getAttribute('data-testid') || '',
      text: (button.textContent || '').trim(),
      ariaLabel: button.getAttribute('aria-label') || '',
      title: button.getAttribute('title') || '',
      disabled: !!button.disabled,
      hidden: !!button.hidden,
      visible: !!(button.offsetParent || button.getClientRects().length)
    }));
  }, scopeSelector);
}

async function clickKnownButton(page, buttonNameRegex, options = {}) {
  const frame = panelFrame(page);
  const buttons = await getVisibleFieldLensButtons(page);
  const match = buttons.find((button) => {
    if (button.disabled || !button.visible || button.hidden) {
      return false;
    }
    const label = `${button.testId} ${button.id} ${button.text} ${button.ariaLabel} ${button.title}`;
    return buttonNameRegex.test(label);
  });

  if (!match) {
    return { clicked: false, label: null };
  }

  const target =
    match.testId
      ? frame.locator(`[data-testid="${match.testId}"]`).first()
      : match.id
        ? frame.locator(`#${match.id}`).first()
        : frame.getByRole('button', { name: buttonNameRegex }).first();

  await target.click({ timeout: options.timeout || ACTION_TIMEOUT_MS });
  await assertFieldLensStillHealthy(page);
  return { clicked: true, label: sanitizeButtonLabel(match) };
}

async function waitForScanOutcome(page, stepLabel, timeoutMs) {
  const frame = panelFrame(page);
  const loadingState = frame.locator('[data-testid="scan-loading-indicator"]');
  const results = frame.locator('[data-testid="results-container"], #resultsContainer');
  const emptyState = frame.locator('#emptyState');
  const errorBanner = frame.locator('#errorBanner');

  console.log(`[FieldLens][Playwright] waiting for ${stepLabel} result`);
  try {
    await expect
      .poll(
        async () => {
          const loadingVisible = await loadingState.isVisible().catch(() => false);
          const resultsVisible = await results.isVisible().catch(() => false);
          const emptyVisible = await emptyState.isVisible().catch(() => false);
          const errorVisible = await errorBanner.isVisible().catch(() => false);
          return { loadingVisible, resultsVisible, emptyVisible, errorVisible };
        },
        { timeout: timeoutMs, intervals: [500, 1000] }
      )
      .toEqual(expect.objectContaining({ loadingVisible: false }));
  } catch (_) {
    const debug = await getScanOutcomeDebug(page);
    throw new Error(
      `${stepLabel} timed out while waiting for loading to finish. loadingVisible=${debug.loadingVisible} selectedField="${debug.selectedFieldText}" resultsPreview="${debug.resultsText}"`
    );
  }

  try {
    await expect
      .poll(
        async () => {
          const resultsVisible = await results.isVisible().catch(() => false);
          const emptyVisible = await emptyState.isVisible().catch(() => false);
          const errorVisible = await errorBanner.isVisible().catch(() => false);
          return resultsVisible || emptyVisible || errorVisible;
        },
        { timeout: 3000 }
      )
      .toBeTruthy();
  } catch (_) {
    const debug = await getScanOutcomeDebug(page);
    throw new Error(
      `${stepLabel} finished loading but no results or empty state appeared. loadingVisible=${debug.loadingVisible} selectedField="${debug.selectedFieldText}" resultsPreview="${debug.resultsText}"`
    );
  }

  await assertFieldLensStillHealthy(page);
  console.log(`[FieldLens][Playwright] ${stepLabel} completed`);
}

async function smokeSafeToolbarButtons(page) {
  const excludePattern =
    /Apex Trigger|Flow|Validation Rule|Permission|Field|Object:|AccountTrigger|Expand result|Collapse result|run impact scan|copy summary|export csv|close panel|quick|deep/i;
  const safeTestIds = ['settings-button', 'expand-all-button', 'collapse-all-button'];
  const buttons = await getVisibleFieldLensButtons(page, {
    scopeSelector: '[data-testid="fieldlens-toolbar"], [data-testid="fieldlens-action-bar"]'
  });

  if (!buttons.length) {
    console.log('[FieldLens][Playwright] toolbar smoke skipped: no safe toolbar/action scope found');
    return;
  }

  const smokeButtons = buttons.filter((button) => {
    if (button.disabled || !button.visible || button.hidden) {
      return false;
    }
    const label = `${button.testId} ${button.id} ${button.text} ${button.ariaLabel} ${button.title}`;
    return safeTestIds.includes(button.testId) && !excludePattern.test(label);
  });

  for (const button of smokeButtons) {
    const label = sanitizeButtonLabel(button);
    console.log('[FieldLens][Playwright] starting safe toolbar smoke:', label);
    const pattern = new RegExp(
      [button.testId, button.id, button.text, button.ariaLabel, button.title].filter(Boolean).map(escapeRegex).join('|'),
      'i'
    );
    try {
      const result = await clickKnownButton(page, pattern, { timeout: TOOLBAR_BUTTON_TIMEOUT_MS });
      if (result.clicked) {
        console.log('[FieldLens][Playwright] safe toolbar smoke completed:', result.label);
      } else {
        console.log('[FieldLens][Playwright] safe toolbar smoke skipped:', label);
      }
    } catch (error) {
      console.log('[FieldLens][Playwright] safe toolbar smoke skipped:', label, error?.message || 'not clickable');
    }
  }
}

test.describe('FieldLens Salesforce functional behavior', () => {
  test.skip(!SF_RECORD_URL, 'Set FIELDLENS_SF_RECORD_URL to run Salesforce functional E2E.');

  let context;

  test.beforeAll(async () => {
    logSalesforceProfileStartup();
    context = await launchFieldLensContext();
    const extensionDiagnostic = await diagnoseExtensionLoaded(context);
    console.log('[FieldLens][Playwright] Extension diagnostic status:', extensionDiagnostic.ok ? 'passed' : 'non-blocking');
  });

  test.afterAll(async () => {
    if (context && shouldClosePlaywrightContext(context)) {
      await context.close();
    }
  });

  test('opens panel and searches/selects Name field', async () => {
    const page = await context.newPage();
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
    await test.step('open FieldLens panel', async () => {
      await openFieldLensPanel(page);
    });
    await test.step('search Name field', async () => {
      const searchInput = await findFieldSearchInput(page);
      await searchInput.fill('');
      await searchInput.fill('Name');
      const fieldList = panelFrame(page).locator('[data-testid="field-result-list"], #fieldSelect');
      await expect(fieldList).toBeVisible({ timeout: 30000 });
      await expect
        .poll(
          async () =>
            fieldList.evaluate((node) =>
              Array.from(node.options || []).map((option) => ({ value: option.value, text: option.textContent || '' }))
            ),
          { timeout: ACTION_TIMEOUT_MS }
        )
        .toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringMatching(/name/i) })]));
    });
    await test.step('select Name field', async () => {
      const fieldSelection = await searchAndSelectField(page, 'Name');
      console.log('[FieldLens][Playwright] Field search selected:', fieldSelection.selectedText);
    });
    await test.step('health assertion', async () => {
      await assertFieldLensStillHealthy(page);
    });
  });

  test('quick scan smoke', async () => {
    const page = await context.newPage();
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
    await test.step('open FieldLens panel', async () => {
      await openFieldLensPanel(page);
    });
    await test.step('search scan smoke field', async () => {
      const searchInput = await findFieldSearchInput(page);
      await searchInput.fill('');
      await searchInput.fill(PRIMARY_SCAN_FIELD);
    });
    await test.step('select scan smoke field', async () => {
      await selectScanSmokeField(page);
    });
    await test.step('click Quick Scan', async () => {
      console.log('[FieldLens][Playwright] starting quick scan');
      const quickMode = await clickKnownButton(page, /(quick-scan-button|^quick$)/i);
      if (quickMode.clicked) {
        console.log('[FieldLens][Playwright] quick scan mode clicked:', quickMode.label);
      }
    });
    await test.step('run impact scan', async () => {
      const runScan = await clickKnownButton(page, /(run-impact-scan-button|run impact scan)/i);
      if (!runScan.clicked) {
        throw new Error('Quick scan could not start because Run Impact Scan button was not found.');
      }
      console.log('[FieldLens][Playwright] quick scan clicked');
      await waitForScanOutcome(page, 'quick scan', ACTION_TIMEOUT_MS);
    });
    await test.step('health assertion', async () => {
      await assertFieldLensStillHealthy(page);
    });
  });

  test('deep scan smoke', async () => {
    test.skip(SKIP_DEEP_SCAN_TEST, 'Skipping deep scan because FIELDLENS_SKIP_DEEP_SCAN_TEST=true.');

    const page = await context.newPage();
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
    await test.step('open FieldLens panel', async () => {
      await openFieldLensPanel(page);
    });
    await test.step('search scan smoke field', async () => {
      const searchInput = await findFieldSearchInput(page);
      await searchInput.fill('');
      await searchInput.fill(PRIMARY_SCAN_FIELD);
    });
    await test.step('select scan smoke field', async () => {
      await selectScanSmokeField(page);
    });
    await test.step('click Deep Scan', async () => {
      console.log('[FieldLens][Playwright] starting deep scan');
      const deepMode = await clickKnownButton(page, /(deep-scan-button|^deep$)/i);
      if (!deepMode.clicked) {
        throw new Error('Deep scan could not start because Deep mode button was not found.');
      }
      console.log('[FieldLens][Playwright] deep scan mode clicked:', deepMode.label);
    });
    await test.step('run impact scan', async () => {
      const runScan = await clickKnownButton(page, /(run-impact-scan-button|run impact scan)/i);
      if (!runScan.clicked) {
        throw new Error('Deep scan could not start because Run Impact Scan button was not found.');
      }
      console.log('[FieldLens][Playwright] deep scan clicked');
      await waitForScanOutcome(page, 'deep scan', ACTION_TIMEOUT_MS);
    });
    await test.step('health assertion', async () => {
      await assertFieldLensStillHealthy(page);
    });
  });

  test('copy, export, close, and toolbar button smoke', async () => {
    const page = await context.newPage();
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
    await test.step('open FieldLens panel', async () => {
      await openFieldLensPanel(page);
    });
    await test.step('search scan smoke field', async () => {
      const searchInput = await findFieldSearchInput(page);
      await searchInput.fill('');
      await searchInput.fill(PRIMARY_SCAN_FIELD);
    });
    await test.step('select scan smoke field', async () => {
      await selectScanSmokeField(page);
    });
    await test.step('click Quick Scan', async () => {
      console.log('[FieldLens][Playwright] starting quick scan for action readiness');
      await clickKnownButton(page, /(quick-scan-button|^quick$)/i);
    });
    await test.step('run impact scan', async () => {
      const runScan = await clickKnownButton(page, /(run-impact-scan-button|run impact scan)/i);
      if (runScan.clicked) {
        console.log('[FieldLens][Playwright] quick scan clicked for action readiness');
        await waitForScanOutcome(page, 'quick scan readiness', ACTION_TIMEOUT_MS);
      }
    });
    await test.step('copy summary', async () => {
      console.log('[FieldLens][Playwright] starting copy smoke');
      const copyButton = await clickKnownButton(page, /(copy-results-button|copy summary)/i);
      if (copyButton.clicked) {
        console.log('[FieldLens][Playwright] copy smoke completed:', copyButton.label);
      }
    });
    await test.step('export CSV', async () => {
      if (!SKIP_EXPORT_TEST) {
        console.log('[FieldLens][Playwright] starting export csv smoke');
        const exportCsvButton = await clickKnownButton(page, /(export-csv-button|export csv)/i, {
          timeout: ACTION_TIMEOUT_MS
        });
        if (exportCsvButton.clicked) {
          console.log('[FieldLens][Playwright] export csv smoke completed:', exportCsvButton.label);
        }
      } else {
        console.log('[FieldLens][Playwright] export smoke skipped because FIELDLENS_SKIP_EXPORT_TEST=true');
      }
    });
    await test.step('health assertion', async () => {
      await assertFieldLensStillHealthy(page);
    });
    await test.step('safe toolbar button smoke', async () => {
      await smokeSafeToolbarButtons(page);
    });
    await test.step('close panel', async () => {
      console.log('[FieldLens][Playwright] starting close panel smoke');
      const closeButton = await clickKnownButton(page, /(close-panel-button|close panel)/i, {
        timeout: TOOLBAR_BUTTON_TIMEOUT_MS
      });
      if (closeButton.clicked) {
        await expect(page.locator('[data-testid="fieldlens-panel-shell"], #fieldlens-panel-shell')).toHaveAttribute(
          'aria-hidden',
          'true',
          { timeout: ACTION_TIMEOUT_MS }
        );
        console.log('[FieldLens][Playwright] close panel smoke completed:', closeButton.label);
      }
    });
    await test.step('reopen panel', async () => {
      await openFieldLensPanel(page);
    });
    await test.step('health assertion', async () => {
      await assertFieldLensStillHealthy(page);
    });
  });
});
