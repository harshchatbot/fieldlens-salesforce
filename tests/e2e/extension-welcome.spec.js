const { test, expect } = require('@playwright/test');
const {
  launchFieldLensExtensionContext,
  PROFILE_TYPE_EXTENSION,
  openExtensionPage,
  assertExtensionLoaded
} = require('./helpers');

test.describe('FieldLens extension shell', () => {
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

  test('loads the welcome page and core CTA content', async () => {
    const page = await openExtensionPage(context, extensionState?.welcomePath || 'welcome.html');

    await expect(page.getByRole('heading', { name: 'Welcome to FieldLens for Salesforce' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Documentation' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Visit TechFi Labs' })).toBeVisible();
    await expect(page.getByText('FLS / Permissions with Profile & Perm Set visibility')).toBeVisible();
  });

  test('loads the panel shell standalone for UI smoke coverage', async () => {
    const page = await openExtensionPage(context, 'ui/panel.html');

    await expect(page.getByRole('heading', { name: 'FieldLens' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run Impact Scan' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
    await expect(page.getByText('Scan Mode')).toBeVisible();
  });
});
