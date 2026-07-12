const { test, expect } = require('@playwright/test');
const {
  logSalesforceProfileStartup,
  launchFieldLensContext,
  waitForSalesforceAppReady,
  waitForSalesforceApiSession,
  diagnoseExtensionLoaded,
  shouldClosePlaywrightContext
} = require('./helpers');

const SF_BASE_URL = process.env.FIELDLENS_SF_BASE_URL || '';
const SF_SETUP_URL = process.env.FIELDLENS_SF_SETUP_URL || '';
const SF_RECORD_URL = process.env.FIELDLENS_SF_RECORD_URL || '';
const LOGIN_TIMEOUT_MS = Number(process.env.FIELDLENS_LOGIN_TIMEOUT_MS || 180000);
const SKIP_SETUP_TEST = String(process.env.FIELDLENS_SKIP_SETUP_TEST || '').toLowerCase() === 'true';

test.describe('FieldLens headed Salesforce flows', () => {
  test.skip(
    !SF_BASE_URL || (!SF_SETUP_URL && !SF_RECORD_URL),
    'Set FIELDLENS_SF_BASE_URL and at least one of FIELDLENS_SF_SETUP_URL or FIELDLENS_SF_RECORD_URL to run Salesforce E2E.'
  );

  let context;
  let extensionDiagnostic;

  test.beforeAll(async () => {
    logSalesforceProfileStartup();
    context = await launchFieldLensContext();
    extensionDiagnostic = await diagnoseExtensionLoaded(context);
    console.log('[FieldLens][Playwright] Extension diagnostic status:', extensionDiagnostic.ok ? 'passed' : 'non-blocking');
  });

  test.afterAll(async () => {
    if (context && shouldClosePlaywrightContext(context)) {
      await context.close();
    }
  });

  test('setup field page shows launcher and panel', async () => {
    test.skip(SKIP_SETUP_TEST, 'Skipping setup-page coverage because FIELDLENS_SKIP_SETUP_TEST=true.');
    test.skip(!SF_SETUP_URL, 'Set FIELDLENS_SF_SETUP_URL to run setup-page coverage.');

    const page = await context.newPage();
    await page.goto(SF_SETUP_URL, { waitUntil: 'domcontentloaded' });
    console.log('[FieldLens][Playwright] Current Salesforce URL:', page.url());
    await waitForSalesforceAppReady(page, {
      targetLabel: 'Salesforce setup field page',
      readyPattern: /\/lightning\/setup\//i,
      timeoutMs: LOGIN_TIMEOUT_MS
    });
    const setupHostname = new URL(page.url()).hostname.toLowerCase();
    const isSalesforceSetupHost = setupHostname.endsWith('.salesforce-setup.com');
    console.log('[FieldLens][Playwright] Setup host uses salesforce-setup.com:', isSalesforceSetupHost ? 'yes' : 'no');
    if (!isSalesforceSetupHost) {
      await waitForSalesforceApiSession(page, { timeoutMs: LOGIN_TIMEOUT_MS });
    }

    await expect(page.locator('#fieldlens-floating-button')).toBeVisible({
      timeout: 30000
    }).catch(() => {
      throw new Error(
        'FieldLens did not inject. Confirm FieldLens is manually loaded and enabled in .playwright/salesforce-profile.'
      );
    });
    await page.locator('#fieldlens-floating-button').click();
    await expect(page.locator('#fieldlens-panel-shell')).toHaveAttribute('aria-hidden', 'false');
  });

  test('record page loads field picker when URL is provided', async () => {
    test.skip(!SF_RECORD_URL, 'Set FIELDLENS_SF_RECORD_URL to run record-page coverage.');

    const page = await context.newPage();
    await page.goto(SF_RECORD_URL, { waitUntil: 'domcontentloaded' });
    console.log('[FieldLens][Playwright] Current Salesforce URL:', page.url());
    await waitForSalesforceAppReady(page, {
      targetLabel: 'Salesforce record page',
      readyPattern: /\/lightning\/r\//i,
      timeoutMs: LOGIN_TIMEOUT_MS
    });
    await waitForSalesforceApiSession(page, { timeoutMs: LOGIN_TIMEOUT_MS });

    await expect(page.locator('#fieldlens-floating-button')).toBeVisible({
      timeout: 30000
    }).catch(() => {
      throw new Error(
        'FieldLens did not inject. Confirm FieldLens is manually loaded and enabled in .playwright/salesforce-profile.'
      );
    });
    await page.locator('#fieldlens-floating-button').click();

    const frame = page.frameLocator('#fieldlens-panel-frame');
    await expect(frame.getByLabel('Select field')).toBeVisible({ timeout: 30000 });
  });
});
