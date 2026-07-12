const { test, expect } = require('@playwright/test');
const {
  launchFieldLensExtensionContext,
  PROFILE_TYPE_EXTENSION,
  assertExtensionLoaded,
  openExtensionPage
} = require('./helpers');

test.describe('FieldLens extension verification', () => {
  let context;
  let extensionState;

  test.beforeAll(async () => {
    context = await launchFieldLensExtensionContext({ profileType: PROFILE_TYPE_EXTENSION });
    extensionState = await assertExtensionLoaded(context);
  });

  test.afterAll(async () => {
    if (context) {
      await context.close();
    }
  });

  test('lists extension and opens welcome page', async ({}, testInfo) => {
    const page = await openExtensionPage(context, extensionState?.welcomePath || 'welcome.html');
    await expect(page).toHaveURL(new RegExp(`chrome-extension://${extensionState.extensionId}/`));
    await page.screenshot({ path: testInfo.outputPath('verify-extension.png'), fullPage: true });
  });
});
