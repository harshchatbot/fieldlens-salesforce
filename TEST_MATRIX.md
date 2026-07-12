# FieldLens Test Matrix

This document tracks the minimum coverage needed before calling FieldLens validated across browser, org-shape, and security conditions.

## Automated coverage

### Lightweight unit checks

- `node scripts/unit_tests.js`
- Purpose:
  - shared URL/context parsing
  - CSV generation and escaping
  - settings normalization
  - manifest/security invariants

### Headed Playwright extension checks

- `npm run test:e2e:welcome`
- Purpose:
  - extension loads in Chromium
  - welcome page renders
  - panel shell renders

### Headed Salesforce E2E template

- `npm run test:e2e:salesforce`
- Required env vars:
  - `FIELDLENS_SF_BASE_URL`
  - `FIELDLENS_SF_SETUP_URL`
  - `FIELDLENS_SF_RECORD_URL` (optional for record page flow)
- Purpose:
  - launcher visibility on Lightning pages
  - panel open behavior
  - record-page field-picker presence

### Headed login and org isolation checks

- `npm run test:e2e:isolation`
- Optional env vars:
  - `FIELDLENS_SF_RECORD_URL`
  - `FIELDLENS_SF_SECOND_RECORD_URL`
  - `FIELDLENS_SF_LOGOUT_URL`
  - `FIELDLENS_SF_RELOGIN_RECORD_URL`
- Purpose:
  - two logged-in Salesforce contexts do not share field-list cache keys
  - logout and re-login do not invisibly reuse previous user cache scope
  - extension storage keys include org/user identity when available

## Manual certification matrix

Run the checklist below for each target environment.

### Org environments

- Scratch org
- Sandbox
- Production
- Custom-domain org (`*.my.salesforce.com` / `*.lightning.force.com`)

### Device/browser environments

- Standard developer laptop
- Company-managed / protected laptop

### Functional cases

- Setup field page auto-detect
- Record page object detect + field load
- Quick scan
- Deep scan
- Copy Summary
- Export CSV
- Clear Org Cache
- Non-permissionable `[NP]` field indicator
- Object-level fallback banner for non-permissionable fields
- Show/Hide No Access toggle
- Result links open expected setup pages
- Lightning SPA navigation updates correctly

### Security / resilience cases

- Expired Salesforce session
- Tooling API insufficient permission
- Restricted profile / permission set
- Cookie fallback path still succeeds
- No CORS allowlist entry required
- Clipboard denied by browser policy
- Managed device/browser extension restrictions

## Login & Org Isolation Certification

These checks are release-gating for environments where multiple Salesforce orgs, identities, or tabs are common.

### Multi-login behavior

- User A logged into sandbox, User B logged into production
- Same user logged into two different orgs
- Logout from one org, then log in as a different user
- Two or more Lightning tabs open at the same time
- Tab switch after a scan is already cached in another org

Pass:

- Field lists and scan results stay bound to the active tab's org/user
- No stale scan summary appears immediately after switching org or user
- Clear error or fresh reload occurs when session expires

Fail:

- Sandbox result appears in production
- Production result appears in sandbox
- A previous user's field list or scan output appears after re-login

### Multi-environment behavior

- Scratch org
- Sandbox
- Production
- Custom domain / My Domain
- `lightning.force.com` and `my.salesforce.com` entry points
- Any Visualforce redirect that returns to Lightning

Pass:

- Launcher appears only on supported Lightning pages
- Cache scope differs by hostname, orgId, and userId where available
- Redirects do not cause the extension to retain another environment's cached metadata

Fail:

- Reused cache despite different org identity
- Broken environment detection after redirect
- Cached field metadata survives into a different Salesforce environment

### Storage isolation checks

- Inspect `chrome.storage.local` after scans and field loads
- Confirm `scan:` and `fields:` keys encode host plus org/user identity
- Confirm `fieldlensSettings` is the only intentionally global preference entry
- Confirm clearing org cache removes matching environment cache entries

Pass:

- No persisted `sid`, bearer token, OAuth token, or raw session ID
- No object metadata or scan data stored under ambiguous global keys
- Org cache clear removes only the intended cache scope

Fail:

- Token-like values present in storage
- Cache keys missing org/user scope where identity is available
- Clearing one org cache removes or exposes another org's data unexpectedly

### Pass criteria

- No blocking console/runtime errors in normal flows
- No forced re-login in supported logged-in sessions
- No broken setup links for FLS / fallback rows
- Clear user-facing error when permissions or login genuinely fail
- No cross-org or cross-user data visibility across tabs, reloads, or re-login flows
