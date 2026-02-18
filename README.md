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

## Notes

- Uses active Salesforce session cookies (`credentials: include`), with no OAuth UI.
- No access token is stored by the extension.
- Cache key shape: `host + object + field`, TTL 10 minutes in `chrome.storage.local`.
