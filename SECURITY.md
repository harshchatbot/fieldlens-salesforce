# Security Notes - FieldLens for Salesforce

## Security Controls

- Manifest V3 service worker architecture.
- Host permissions restricted to Salesforce HTTPS domains.
- Content script restricted to Salesforce Lightning URL patterns.
- Web-accessible resources scoped to Salesforce Lightning URL patterns.
- No remote code loading.
- No use of `eval` or dynamic code execution.

## Session Handling

- Uses existing Salesforce browser session.
- No persistent OAuth token storage.
- `sid` cookie is read only as fallback to complete Salesforce API requests where CORS/session policies block tab-context fetch.

## Storage

- Uses `chrome.storage.local` for non-sensitive settings and 10-minute cache.
- Cache keys are scoped by org host + object + field + scan mode.

## Recommended Operational Practices

- Publish only signed builds from controlled source.
- Review permissions before each release.
- Increment manifest version for each store submission.
- Re-test in sandbox and production org shapes before release.
