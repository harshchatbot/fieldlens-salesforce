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

## Notes

- Uses active Salesforce session cookies (`credentials: include`), with no OAuth UI.
- No access token is stored by the extension.
- Cache key shape: `host + object + field`, TTL 10 minutes in `chrome.storage.local`.
