const { test, expect } = require('@playwright/test');
const {
  logSalesforceProfileStartup,
  launchFieldLensContext,
  diagnoseExtensionLoaded,
  getExtensionServiceWorker,
  readExtensionStorage,
  getSalesforceIdentityWithRetry,
  openLauncherAndWait,
  waitForSalesforceAppReady,
  waitForSalesforceApiSession,
  shouldClosePlaywrightContext
} = require('./helpers');

const SF_RECORD_URL = process.env.FIELDLENS_SF_RECORD_URL || '';
const SF_SECOND_RECORD_URL = process.env.FIELDLENS_SF_SECOND_RECORD_URL || '';
const SF_LOGOUT_URL = process.env.FIELDLENS_SF_LOGOUT_URL || '';
const SF_RELOGIN_RECORD_URL = process.env.FIELDLENS_SF_RELOGIN_RECORD_URL || '';
const LOGIN_TIMEOUT_MS = Number(process.env.FIELDLENS_LOGIN_TIMEOUT_MS || 180000);
const SKIP_LOGOUT_RELOGIN_TEST =
  String(process.env.FIELDLENS_SKIP_LOGOUT_RELOGIN_TEST || '').toLowerCase() === 'true';

function getIdentityScopeMarker(identity) {
  const hostname = String(identity?.hostname || '').toLowerCase();
  const userId = String(identity?.userId || '').toLowerCase();
  if (identity?.orgId && identity.orgId !== 'unknown-org') {
    return String(identity.orgId).toLowerCase();
  }
  return `${hostname}:${String(identity?.instanceKey || '').toLowerCase()}:${userId}`;
}

test.describe('FieldLens login and org isolation', () => {
  test.skip(!SF_RECORD_URL, 'Set FIELDLENS_SF_RECORD_URL to run isolation coverage.');

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

  test('record-page field metadata cache is scoped to the active org and user identity', async () => {
    test.skip(!SF_SECOND_RECORD_URL, 'Set FIELDLENS_SF_SECOND_RECORD_URL to validate multi-org or multi-user isolation.');

    const pageA = await context.newPage();
    await pageA.goto(SF_RECORD_URL, { waitUntil: 'domcontentloaded' });
    console.log('[FieldLens][Playwright] Current Salesforce URL:', pageA.url());
    await waitForSalesforceAppReady(pageA, {
      targetLabel: 'Primary Salesforce record page',
      readyPattern: /\/lightning\/r\//i,
      timeoutMs: LOGIN_TIMEOUT_MS
    });
    await waitForSalesforceApiSession(pageA, { timeoutMs: LOGIN_TIMEOUT_MS });
    const identityA = await getSalesforceIdentityWithRetry(pageA, { timeoutMs: LOGIN_TIMEOUT_MS });
    await expect(pageA.locator('#fieldlens-floating-button')).toBeVisible({
      timeout: 30000
    }).catch(() => {
      throw new Error(
        'FieldLens did not inject. Confirm FieldLens is manually loaded and enabled in .playwright/salesforce-profile.'
      );
    });
    await openLauncherAndWait(pageA);
    const frameA = pageA.frameLocator('#fieldlens-panel-frame');
    await expect(frameA.getByLabel('Select field')).toBeVisible({ timeout: 30000 });

    const pageB = await context.newPage();
    await pageB.goto(SF_SECOND_RECORD_URL, { waitUntil: 'domcontentloaded' });
    console.log('[FieldLens][Playwright] Current Salesforce URL:', pageB.url());
    await waitForSalesforceAppReady(pageB, {
      targetLabel: 'Secondary Salesforce record page',
      readyPattern: /\/lightning\/r\//i,
      timeoutMs: LOGIN_TIMEOUT_MS
    });
    await waitForSalesforceApiSession(pageB, { timeoutMs: LOGIN_TIMEOUT_MS });
    const identityB = await getSalesforceIdentityWithRetry(pageB, { timeoutMs: LOGIN_TIMEOUT_MS });
    await expect(pageB.locator('#fieldlens-floating-button')).toBeVisible({
      timeout: 30000
    }).catch(() => {
      throw new Error(
        'FieldLens did not inject. Confirm FieldLens is manually loaded and enabled in .playwright/salesforce-profile.'
      );
    });
    await openLauncherAndWait(pageB);
    const frameB = pageB.frameLocator('#fieldlens-panel-frame');
    await expect(frameB.getByLabel('Select field')).toBeVisible({ timeout: 30000 });

    const serviceWorker = await getExtensionServiceWorker(context);
    const storage = await readExtensionStorage(serviceWorker);
    const fieldKeys = Object.keys(storage).filter((key) => key.startsWith('fields:'));
    const scopeMarkerA = getIdentityScopeMarker(identityA);
    const scopeMarkerB = getIdentityScopeMarker(identityB);

    expect(fieldKeys.length).toBeGreaterThan(0);
    expect(fieldKeys.some((key) => key.includes(String(identityA.userId || '').toLowerCase()))).toBeTruthy();
    if (identityA.orgId && identityA.orgId !== 'unknown-org') {
      expect(fieldKeys.some((key) => key.includes(String(identityA.orgId || '').toLowerCase()))).toBeTruthy();
    } else {
      expect(fieldKeys.some((key) => key.includes(String(identityA.instanceKey || '').toLowerCase()))).toBeTruthy();
      expect(fieldKeys.some((key) => key.includes(String(identityA.hostname || '').toLowerCase()))).toBeTruthy();
    }
    expect(fieldKeys.some((key) => key.includes(String(identityA.userId || '').toLowerCase()))).toBeTruthy();
    if (identityB.orgId && identityB.orgId !== 'unknown-org') {
      expect(fieldKeys.some((key) => key.includes(String(identityB.orgId || '').toLowerCase()))).toBeTruthy();
    } else {
      expect(fieldKeys.some((key) => key.includes(String(identityB.instanceKey || '').toLowerCase()))).toBeTruthy();
      expect(fieldKeys.some((key) => key.includes(String(identityB.hostname || '').toLowerCase()))).toBeTruthy();
    }
    expect(fieldKeys.some((key) => key.includes(String(identityB.userId || '').toLowerCase()))).toBeTruthy();
    expect(fieldKeys.some((key) => key.includes(scopeMarkerA) && key.includes(scopeMarkerB))).toBeFalsy();
  });

  test('logout and re-login should not preserve previous page cache scope invisibly', async () => {
    test.skip(SKIP_LOGOUT_RELOGIN_TEST, 'Skipping logout/re-login coverage because FIELDLENS_SKIP_LOGOUT_RELOGIN_TEST=true.');
    test.skip(!SF_LOGOUT_URL || !SF_RELOGIN_RECORD_URL, 'Set FIELDLENS_SF_LOGOUT_URL and FIELDLENS_SF_RELOGIN_RECORD_URL for session-switch coverage.');

    const page = await context.newPage();
    await page.goto(SF_RECORD_URL, { waitUntil: 'domcontentloaded' });
    console.log('[FieldLens][Playwright] Current Salesforce URL:', page.url());
    await waitForSalesforceAppReady(page, {
      targetLabel: 'Pre-logout Salesforce record page',
      readyPattern: /\/lightning\/r\//i,
      timeoutMs: LOGIN_TIMEOUT_MS
    });
    await waitForSalesforceApiSession(page, { timeoutMs: LOGIN_TIMEOUT_MS });
    const identityBefore = await getSalesforceIdentityWithRetry(page, { timeoutMs: LOGIN_TIMEOUT_MS });
    await expect(page.locator('#fieldlens-floating-button')).toBeVisible({
      timeout: 30000
    }).catch(() => {
      throw new Error(
        'FieldLens did not inject. Confirm FieldLens is manually loaded and enabled in .playwright/salesforce-profile.'
      );
    });
    await openLauncherAndWait(page);

    await page.goto(SF_LOGOUT_URL, { waitUntil: 'domcontentloaded' });
    await page.goto(SF_RELOGIN_RECORD_URL, { waitUntil: 'domcontentloaded' });
    console.log('[FieldLens][Playwright] Current Salesforce URL:', page.url());
    await waitForSalesforceAppReady(page, {
      targetLabel: 'Post-login Salesforce record page',
      readyPattern: /\/lightning\/r\//i,
      timeoutMs: LOGIN_TIMEOUT_MS
    });
    await waitForSalesforceApiSession(page, { timeoutMs: LOGIN_TIMEOUT_MS });
    const identityAfter = await getSalesforceIdentityWithRetry(page, { timeoutMs: LOGIN_TIMEOUT_MS });

    expect(`${identityBefore.orgId}:${identityBefore.userId}`).not.toBe(`${identityAfter.orgId}:${identityAfter.userId}`);

    await expect(page.locator('#fieldlens-floating-button')).toBeVisible({
      timeout: 30000
    }).catch(() => {
      throw new Error(
        'FieldLens did not inject. Confirm FieldLens is manually loaded and enabled in .playwright/salesforce-profile.'
      );
    });
    await openLauncherAndWait(page);
    const frame = page.frameLocator('#fieldlens-panel-frame');
    await expect(frame.getByLabel('Select field')).toBeVisible({ timeout: 30000 });

    const serviceWorker = await getExtensionServiceWorker(context);
    const storage = await readExtensionStorage(serviceWorker);
    const fieldKeys = Object.keys(storage).filter((key) => key.startsWith('fields:'));

    expect(fieldKeys.some((key) => key.includes(String(identityAfter.userId || '').toLowerCase()))).toBeTruthy();
  });
});
