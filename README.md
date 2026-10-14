# FieldLens for Salesforce

FieldLens is a Chrome Extension (Manifest V3) for Salesforce Lightning Experience that scans field usage impact across Validation Rules, Apex Classes, Apex Triggers, and Flows (best effort).

## Project Structure

- `/Users/harshveersinghnirwan/Downloads/fieldlens-salesforce/manifest.json`
- `/Users/harshveersinghnirwan/Downloads/fieldlens-salesforce/content.js`
- `/Users/harshveersinghnirwan/Downloads/fieldlens-salesforce/background.js`
- `/Users/harshveersinghnirwan/Downloads/fieldlens-salesforce/ui/panel.html`
- `/Users/harshveersinghnirwan/Downloads/fieldlens-salesforce/ui/panel.css`
- `/Users/harshveersinghnirwan/Downloads/fieldlens-salesforce/ui/panel.js`
- `/Users/harshveersinghnirwan/Downloads/fieldlens-salesforce/icons/`
- `/Users/harshveersinghnirwan/Downloads/fieldlens-salesforce/scripts/smoke_test_sandbox.sh`

## Load as Unpacked Extension

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select folder: `/Users/harshveersinghnirwan/Downloads/fieldlens-salesforce`.
5. Pin **FieldLens for Salesforce** from the extensions toolbar (optional).

On first install, a welcome page opens automatically:

- `/Users/harshveersinghnirwan/Downloads/fieldlens-salesforce/welcome.html`

## Public Documentation Page

- Docs source: `/Users/harshveersinghnirwan/Downloads/fieldlens-salesforce/docs/index.html`
- Styles: `/Users/harshveersinghnirwan/Downloads/fieldlens-salesforce/docs/styles.css`

If you publish with GitHub Pages from this repo, this page can be hosted like:

- `https://<your-username>.github.io/<repo-name>/docs/`

## SEO Keywords (Website + Store Listing)

Use these naturally in your docs page, Chrome Web Store title/description, and support pages:

- Salesforce field impact analysis
- Salesforce metadata scanner
- Salesforce Chrome extension
- Salesforce Lightning extension
- Apex trigger validation rule flow usage
- Salesforce admin productivity tool

## Permissions

- `storage`: stores UI settings and 10-minute local scan cache.
- `scripting`, `activeTab`: injects content logic only in the active Salesforce Lightning tab.
- `cookies`: reads only Salesforce `sid` cookie as a fallback when browser CORS/session behavior blocks tab-context API fetches.

## Chrome Web Store Readiness

- Host access is limited to Salesforce HTTPS domains only.
- Web-accessible resources are restricted to Salesforce Lightning page matches.
- No remote code execution, no dynamic eval, and no external script loading.
- OAuth tokens are not stored; session is derived from active Salesforce login.
- Review support docs:
  - `/Users/harshveersinghnirwan/Downloads/fieldlens-salesforce/PRIVACY.md`
  - `/Users/harshveersinghnirwan/Downloads/fieldlens-salesforce/SECURITY.md`
  - `/Users/harshveersinghnirwan/Downloads/fieldlens-salesforce/CHROME_WEB_STORE_CHECKLIST.md`

## Salesforce Sandbox Testing

1. Log into your Salesforce sandbox in Lightning Experience.
2. Open a field detail page, for example:
   - `https://<your-domain>.sandbox.my.salesforce.com/lightning/setup/ObjectManager/Account/FieldsAndRelationships/Custom_Status__c/view`
3. Click the floating **FieldLens** button.
4. In the side panel, click **Run Impact Scan**.
5. Verify grouped results and counts are shown for:
   - Validation Rules
   - Apex Classes
   - Apex Triggers
   - Flows (Best Effort)
6. Click result items and verify they open in a new Salesforce tab.
7. Click **Copy Summary** and paste into a text editor to verify markdown output.

### Record Page Test

1. Open any Lightning record page:
   - `https://<your-domain>.sandbox.my.salesforce.com/lightning/r/Account/<recordId>/view`
2. Click **FieldLens**.
3. Verify field list loads.
4. Search and select a field from the dropdown.
5. Click **Run Impact Scan**.

### Error/Edge Tests

- Remove/limit API permissions and verify clear permission error messages.
- Test with a field that has no references and verify **No impact found** appears.
- Re-run the same scan within 10 minutes and verify fast return from cache.
- Navigate between Lightning pages without full refresh and verify FieldLens context updates correctly.

## Repetitive Smoke Test Runner

Run this script to execute the same QA checklist each cycle and generate a timestamped report:

```bash
/Users/harshveersinghnirwan/Downloads/fieldlens-salesforce/scripts/smoke_test_sandbox.sh
```

Output:

- Markdown report written to `/Users/harshveersinghnirwan/Downloads/fieldlens-salesforce/reports/fieldlens-smoke-<timestamp>.md`
- Includes PASS/FAIL/NOT_TESTED status per test plus a summary count.

## Unit Tests

Run lightweight unit tests (context parsing, CSV generation, settings normalization, group-filter logic):

```bash
node /Users/harshveersinghnirwan/Downloads/fieldlens-salesforce/scripts/unit_tests.js
```

## Headed E2E Tests

Install dependencies:

```bash
npm install
```

Run this first:

```bash
npm run test:e2e:verify-extension:local
```

Run extension-shell smoke coverage:

```bash
npm run test:e2e:welcome
```

Then run Salesforce E2E after extension verification succeeds.

Playwright automation uses the installed Google Chrome browser, not the bundled Chromium build.

Automation profiles are stored separately under:

- `.playwright/fieldlens-extension-profile`
- `.playwright/salesforce-profile`

These are dedicated automation profiles. Your normal daily Chrome profile is not used.

Manual bootstrap mode for Salesforce tests:

1. Open Chrome using the dedicated `.playwright/salesforce-profile`.
2. Go to `chrome://extensions`.
3. Use **Load unpacked** once and select the FieldLens repo root.
4. Log in to Salesforce once in that same profile.
5. Close Chrome fully.
6. Run Salesforce tests with:

```bash
FIELDLENS_USE_BOOTSTRAPPED_PROFILE=true npm run test:e2e:salesforce
```

In this mode, Salesforce tests reuse the manually bootstrapped `.playwright/salesforce-profile` and do not rely on command-line extension loading.

Connect to an already-open Chrome session:

1. Start Google Chrome with remote debugging and the dedicated Salesforce automation profile:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$(pwd)/.playwright/salesforce-profile"
```

2. In that Chrome window, confirm FieldLens is installed and enabled.
3. Log in to Salesforce in that same Chrome window.
4. Keep Chrome open.
5. Run:

```bash
npm run test:e2e:salesforce:local
```

This local script runs:

- headed Salesforce page injection coverage
- login and org isolation coverage
- functional FieldLens UI coverage

You can still run the individual suites directly if you only want one layer of coverage.

For a single-suite connected-Chrome run, use:

```bash
FIELDLENS_CONNECT_EXISTING_CHROME=true \
FIELDLENS_USE_BOOTSTRAPPED_PROFILE=true \
npx playwright test tests/e2e/salesforce-headed.spec.js --headed --workers=1
```

In connected-Chrome mode, Playwright attaches to the already-open Chrome over `http://127.0.0.1:9222`, reuses the active Salesforce session, and does not close that browser at the end of the test run.

When `FIELDLENS_USE_BOOTSTRAPPED_PROFILE=true`, all Playwright tests reuse the bootstrapped `.playwright/salesforce-profile` and stop relying on command-line unpacked-extension loading. This lets the same installed Chrome Web Store extension be used consistently across verification, welcome, and Salesforce suites.

Run headed Salesforce coverage with environment variables:

```bash
FIELDLENS_SF_BASE_URL="https://your-domain.lightning.force.com" \
FIELDLENS_SF_SETUP_URL="https://your-domain.lightning.force.com/lightning/setup/ObjectManager/Account/FieldsAndRelationships/Name/view" \
FIELDLENS_SF_RECORD_URL="https://your-domain.lightning.force.com/lightning/r/Account/<recordId>/view" \
npm run test:e2e:salesforce
```

Run FieldLens functional UI coverage on a Salesforce record page:

```bash
FIELDLENS_CONNECT_EXISTING_CHROME=true \
FIELDLENS_USE_BOOTSTRAPPED_PROFILE=true \
FIELDLENS_SKIP_DEEP_SCAN_TEST=true \
FIELDLENS_SKIP_EXPORT_TEST=true \
FIELDLENS_FUNCTIONAL_ACTION_TIMEOUT_MS=15000 \
FIELDLENS_SCAN_FIELD=Phone \
FIELDLENS_SCAN_FIELD_API=Phone \
FIELDLENS_SF_RECORD_URL="https://hrshveersdomain-dev-ed.lightning.force.com/lightning/r/Account/0015i00000ZHi6mAAD/view" \
npm run test:e2e:functional
```

For record-page-only validation, skip the setup-page test:

```bash
FIELDLENS_SKIP_SETUP_TEST=true npm run test:e2e:salesforce
```

This is useful when Salesforce setup redirects to `*.salesforce-setup.com` and you only want to validate FieldLens injection and field loading on record pages. Full setup-page coverage remains available separately when setup-domain handling is stable.

Manual login note for headed Salesforce tests:

- At startup, the test prints whether `.playwright/salesforce-profile` already exists.
- If it does not exist, expect a fresh login.
- If it does exist, the test will try to reuse the saved Salesforce session.
- If `FIELDLENS_USE_BOOTSTRAPPED_PROFILE=true`, the test uses the manually bootstrapped `.playwright/salesforce-profile` and checks FieldLens by actual Salesforce page injection.
- If `FIELDLENS_CONNECT_EXISTING_CHROME=true`, the test connects to an already-open Chrome on `http://127.0.0.1:9222` instead of launching a new persistent session.
- The first Salesforce automation run usually requires manual login inside the Playwright Chrome window.
- Later runs reuse the saved Salesforce session from `.playwright/salesforce-profile`.
- Delete `.playwright/salesforce-profile` if you want to reset the saved Salesforce login.
- Manually installing the extension in your normal Chrome profile does not affect Playwright.
- FieldLens must be loaded into Playwright Chromium through the launch args:
  - `--disable-extensions-except=<extension path>`
  - `--load-extension=<extension path>`
- If the test detects the Salesforce login page, it will print:
  - `Please login to Salesforce manually in the Playwright browser, then return to the test.`
- After login, the test waits for both Lightning page readiness and Salesforce API session readiness before continuing with identity checks.
- Default manual-login timeout is 3 minutes. Override with:

```bash
FIELDLENS_LOGIN_TIMEOUT_MS=300000 npm run test:e2e:salesforce
```

Run login and org isolation coverage:

```bash
FIELDLENS_SF_RECORD_URL="https://your-sandbox.lightning.force.com/lightning/r/Account/<recordId>/view" \
FIELDLENS_SF_SECOND_RECORD_URL="https://your-prod.lightning.force.com/lightning/r/Account/<recordId>/view" \
npm run test:e2e:isolation
```

Recommended local connected-Chrome isolation command:

```bash
FIELDLENS_CONNECT_EXISTING_CHROME=true \
FIELDLENS_USE_BOOTSTRAPPED_PROFILE=true \
FIELDLENS_SKIP_LOGOUT_RELOGIN_TEST=true \
FIELDLENS_SF_RECORD_URL="https://your-sandbox.lightning.force.com/lightning/r/Account/<recordId>/view" \
FIELDLENS_SF_SECOND_RECORD_URL="https://your-prod.lightning.force.com/lightning/r/Account/<recordId>/view" \
npx playwright test tests/e2e/salesforce-isolation.spec.js --headed --workers=1
```

If Salesforce org identity lookup is blocked with `401` or `403`, the isolation suite falls back to a safe scope using `hostname + instanceKey + userId` instead of failing the test.

The same manual-login behavior applies to the isolation suite. If the Playwright browser opens on a Salesforce login page, complete login there and return to the terminal while the test waits for `/lightning/r/` to load.

Run logout / re-login isolation coverage:

```bash
FIELDLENS_SF_RECORD_URL="https://your-sandbox.lightning.force.com/lightning/r/Account/<recordId>/view" \
FIELDLENS_SF_LOGOUT_URL="https://your-sandbox.lightning.force.com/secur/logout.jsp" \
FIELDLENS_SF_RELOGIN_RECORD_URL="https://your-prod.lightning.force.com/lightning/r/Account/<recordId>/view" \
npm run test:e2e:isolation
```

Run the broader security-focused suite:

```bash
npm run test:unit
npm run test:security
```

See `/Users/harshveersinghnirwan/Downloads/fieldlens-salesforce/TEST_MATRIX.md` for the full environment and security certification matrix.

## Notes

- Uses active Salesforce session cookies (`credentials: include`), with no OAuth UI.
- No access token is stored by the extension.
- Cache key shape: `host + instance + orgId + userId + object (+ field/scan mode)`, with host-only fallback when identity endpoints are temporarily unavailable.
- UI settings are global extension preferences only. Salesforce metadata caches should remain org- and user-scoped.

## Security Test Instructions

Validate these before release:

- Open two Salesforce environments at the same time and confirm field lists and scan results do not bleed between tabs.
- Log out, log in as another user, and verify old cached field metadata is not silently reused.
- Clear org cache from FieldLens settings and confirm fresh queries occur on the next scan.
- Inspect `chrome.storage.local` during testing and confirm no `sid`, bearer token, or session ID values are persisted.
- Confirm the manifest permissions remain limited to `storage`, `activeTab`, `scripting`, and `cookies`.
