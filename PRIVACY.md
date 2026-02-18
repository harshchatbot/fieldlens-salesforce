# Privacy Policy - FieldLens for Salesforce

Effective date: February 18, 2026

FieldLens for Salesforce is a Chrome extension used inside Salesforce Lightning pages to analyze field impact metadata.

## Data We Access

- Salesforce metadata query responses needed to render scan results (for example, Apex/Validation/Flow/Layout references).
- Current Salesforce page URL context (object and field route parts).
- Extension-local settings and short-lived cache entries.

## Data We Store

- `chrome.storage.local` settings (scan mode preference, hide-zero-sections preference).
- `chrome.storage.local` scan cache for up to 10 minutes.

## Data We Do Not Collect

- We do not run analytics or tracking.
- We do not sell personal data.
- We do not transmit extension data to third-party servers.

## Authentication

- The extension uses the user's existing Salesforce login session.
- OAuth tokens are not stored by the extension.
- In fallback scenarios, the extension may read Salesforce `sid` cookie locally only to authorize Salesforce API requests within allowed Salesforce domains.

## Data Sharing

- Data remains in the browser and Salesforce endpoints.
- No external non-Salesforce API calls are made for scan operations.

## Contact

For privacy questions, contact TechFi Labs support.
