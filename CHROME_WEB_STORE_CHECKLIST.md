# Chrome Web Store Deployment Checklist - FieldLens for Salesforce

## Pre-Submission

- [ ] Manifest version is 3.
- [ ] Extension version is bumped for this release.
- [ ] `host_permissions` are limited to Salesforce domains only.
- [ ] `web_accessible_resources.matches` are Lightning-only.
- [ ] No remote code, no minified-obfuscated unknown dependencies.
- [ ] Privacy policy URL/content is ready (`PRIVACY.md`).
- [ ] Security notes reviewed (`SECURITY.md`).

## Required Store Metadata

- [ ] Single-purpose description clearly states Salesforce field impact analysis.
- [ ] Permission justification text includes:
  - `storage` for local settings/cache
  - `scripting`/`activeTab` for Salesforce tab injection
  - `cookies` fallback only for Salesforce session continuity
- [ ] Screenshots (panel on setup field page and record page).
- [ ] Support contact and website.

## Functional QA

- [ ] Setup field page auto-detect works.
- [ ] Record page field selector works.
- [ ] Quick and Deep scan both work in sandbox.
- [ ] Error states are user-friendly.
- [ ] Copy Summary and Export CSV work.
- [ ] Retry actions work on failed load/scan.
- [ ] Settings persist after refresh/reopen.

## Packaging

- [ ] Remove temporary debug instrumentation (done).
- [ ] Run syntax checks:
  - `node --check background.js`
  - `node --check content.js`
  - `node --check ui/panel.js`
  - `node --check shared/fieldlens_core.js`
- [ ] Run unit tests:
  - `node scripts/unit_tests.js`
- [ ] Zip extension root for upload (exclude `.git`, reports, temp files).

## Post-Submission

- [ ] Monitor review feedback and respond with permission rationale if requested.
- [ ] Track first-release runtime errors in sandbox before broad rollout.
