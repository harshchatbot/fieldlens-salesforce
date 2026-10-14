const assert = require('assert');
const manifest = require('../manifest.json');
const core = require('../shared/fieldlens_core');
const e2eHelpers = require('../tests/e2e/helpers');

function testContextParsing() {
  const setup = core.parseSalesforceContext(
    'https://acme.lightning.force.com/lightning/setup/ObjectManager/Account/FieldsAndRelationships/Custom_Status__c/view'
  );
  assert.strictEqual(setup.pageType, 'setupField');
  assert.strictEqual(setup.objectApiName, 'Account');
  assert.strictEqual(setup.fieldApiName, 'Custom_Status__c');

  const record = core.parseSalesforceContext(
    'https://acme.lightning.force.com/lightning/r/Lead/00Q000000000001AAA/view'
  );
  assert.strictEqual(record.pageType, 'recordPage');
  assert.strictEqual(record.objectApiName, 'Lead');

  const unsupported = core.parseSalesforceContext('https://acme.lightning.force.com/lightning/o/Account/list');
  assert.strictEqual(unsupported.isSupportedPage, false);
}

function testCsvGeneration() {
  const rows = core.buildImpactCsvRows({
    groups: {
      apexClasses: [{ name: 'My"Class', subtitle: 'Apex', url: 'https://x' }],
      validationRules: []
    }
  });
  assert.strictEqual(rows[0][0], 'Group');
  assert.strictEqual(rows[1][0], 'Apex Classes');
  assert.strictEqual(core.csvEscape('a,"b"'), '"a,""b"""');
  assert.strictEqual(core.csvEscape('=SUM(A1:A2)'), "'=SUM(A1:A2)");
  assert.strictEqual(core.csvEscape('+unsafe'), "'+unsafe");
  assert.strictEqual(core.csvEscape('-unsafe'), "'-unsafe");
  assert.strictEqual(core.csvEscape('@unsafe'), "'@unsafe");
}

function testFieldReferenceMatching() {
  assert.strictEqual(core.containsFieldReferenceText('Status__c', 'Status__c'), true);
  assert.strictEqual(core.containsFieldReferenceText('Old_Status__c', 'Status__c'), false);
  assert.strictEqual(core.containsFieldReferenceText('Username', 'Name'), false);
  assert.strictEqual(core.containsFieldReferenceText('Account.Name', 'Name', 'Account.Name'), true);
  assert.strictEqual(core.containsFieldReferenceText('$ObjectType.Account.Fields.Name', 'Name', 'Account.Name'), true);
  const accountRules = core.filterValidationRulesByObject(
    [
      { ValidationName: 'AccountRule', EntityDefinition: { QualifiedApiName: 'Account' } },
      { ValidationName: 'LeadRule', EntityDefinition: { QualifiedApiName: 'Lead' } }
    ],
    'Account'
  );
  assert.deepStrictEqual(accountRules.map((rule) => rule.ValidationName), ['AccountRule']);
}

function testSettingsNormalization() {
  const normalized = core.normalizeSettings({ defaultScanMode: 'deep', hideZeroGroups: 1 });
  assert.deepStrictEqual(normalized, { defaultScanMode: 'deep', hideZeroGroups: true });

  const fallback = core.normalizeSettings({ defaultScanMode: 'weird', hideZeroGroups: 0 });
  assert.deepStrictEqual(fallback, { defaultScanMode: 'quick', hideZeroGroups: false });
}

function testGroupFilter() {
  assert.strictEqual(core.shouldShowGroup(0, true), false);
  assert.strictEqual(core.shouldShowGroup(2, true), true);
  assert.strictEqual(core.shouldShowGroup(0, false), true);
}

function testManifestSecurityShape() {
  assert.strictEqual(manifest.manifest_version, 3);
  assert.ok(Array.isArray(manifest.host_permissions));
  assert.ok(manifest.host_permissions.includes('https://*.salesforce.com/*'));
  assert.ok(manifest.host_permissions.includes('https://*.my.salesforce.com/*'));
  assert.ok(manifest.host_permissions.includes('https://*.lightning.force.com/*'));

  assert.ok(Array.isArray(manifest.permissions));
  assert.ok(manifest.permissions.includes('storage'));
  assert.ok(manifest.permissions.includes('activeTab'));
  assert.ok(manifest.permissions.includes('scripting'));
}

function testCsvNoResultsFallback() {
  const rows = core.buildImpactCsvRows({ groups: {} });
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[1][0], 'No Results');
}

function testIsolationCacheKeys() {
  const baseUrl = 'https://acme.lightning.force.com';
  const sandboxIdentity = {
    instanceKey: 'cs42',
    orgId: '00D_SANDBOX',
    userId: '005_USER_A'
  };
  const prodIdentity = {
    instanceKey: 'na172',
    orgId: '00D_PROD',
    userId: '005_USER_B'
  };

  const sandboxKey = core.buildScanCacheKey({
    schemaVersion: 'v8',
    baseUrl,
    identity: sandboxIdentity,
    objectApiName: 'Account',
    fieldApiName: 'Name',
    scanMode: 'quick'
  });
  const prodKey = core.buildScanCacheKey({
    schemaVersion: 'v8',
    baseUrl,
    identity: prodIdentity,
    objectApiName: 'Account',
    fieldApiName: 'Name',
    scanMode: 'quick'
  });

  assert.notStrictEqual(sandboxKey, prodKey);
  assert.ok(sandboxKey.includes('00d_sandbox'));
  assert.ok(sandboxKey.includes('005_user_a'));
  assert.ok(prodKey.includes('00d_prod'));
  assert.ok(prodKey.includes('005_user_b'));

  const fieldKey = core.buildFieldCacheKey({
    schemaVersion: 'v8',
    baseUrl: 'https://prod.my.salesforce.com',
    identity: prodIdentity,
    objectApiName: 'Opportunity'
  });
  assert.ok(fieldKey.startsWith('fields:v8:prod.my.salesforce.com:na172:00d_prod:005_user_b:opportunity'));
}

function testFallbackIsolationScope() {
  const key = core.buildScanCacheKey({
    schemaVersion: 'v8',
    baseUrl: 'https://example.lightning.force.com',
    identity: {},
    objectApiName: 'Lead',
    fieldApiName: 'Status',
    scanMode: 'deep'
  });
  assert.ok(key.includes(':unknown-instance:unknown-org:unknown-user:'));
  assert.ok(!/sid|token|session/i.test(key));
}

function testManifestPermissionMinimums() {
  const allowedPermissions = new Set(['storage', 'activeTab', 'scripting', 'cookies']);
  for (const permission of manifest.permissions) {
    assert.ok(allowedPermissions.has(permission), `Unexpected manifest permission: ${permission}`);
  }

  const deniedPermissions = ['tabs', 'history', 'bookmarks', 'webRequest', 'debugger'];
  for (const permission of deniedPermissions) {
    assert.ok(!manifest.permissions.includes(permission), `Permission should not be present: ${permission}`);
  }
}

function testIdentityApiClassification() {
  const ok = e2eHelpers.classifySalesforceApiResult({
    status: 200,
    contentType: 'application/json',
    message: ''
  });
  assert.strictEqual(ok.ok, true);

  const invalidSession = e2eHelpers.classifySalesforceApiResult({
    status: 200,
    contentType: 'application/json',
    message: 'Session expired or invalid'
  });
  assert.strictEqual(invalidSession.ok, false);
  assert.strictEqual(invalidSession.code, 'INVALID_SESSION');

  const nonJson = e2eHelpers.classifySalesforceApiResult({
    status: 200,
    contentType: 'text/html',
    message: '',
    isHtml: true
  });
  assert.strictEqual(nonJson.ok, false);
  assert.strictEqual(nonJson.code, 'NON_JSON');

  const authError = e2eHelpers.classifySalesforceApiResult({
    status: 401,
    contentType: 'application/json',
    message: ''
  });
  assert.strictEqual(authError.ok, false);
  assert.strictEqual(authError.code, 'HTTP_AUTH');
}

function testFallbackIdentityBuilder() {
  const fallback = e2eHelpers.buildFallbackIdentity({
    hostname: 'acme.lightning.force.com',
    userId: '005USER',
    orgId: 'unknown-org',
    instanceKey: 'NA123'
  });
  assert.deepStrictEqual(fallback, {
    hostname: 'acme.lightning.force.com',
    userId: '005USER',
    orgId: 'unknown-org',
    instanceKey: 'NA123'
  });
  assert.ok(!/sid|token|session/i.test(JSON.stringify(fallback)));
}

function testIdentityFallbackScenarios() {
  const userOnlyIdentity = e2eHelpers.buildFallbackIdentity({
    hostname: 'prod.lightning.force.com',
    userId: '005ABC',
    instanceKey: 'cs88'
  });
  assert.strictEqual(userOnlyIdentity.userId, '005ABC');
  assert.strictEqual(userOnlyIdentity.orgId, 'unknown-org');
  assert.strictEqual(userOnlyIdentity.instanceKey, 'cs88');
}

function run() {
  testContextParsing();
  testCsvGeneration();
  testFieldReferenceMatching();
  testSettingsNormalization();
  testGroupFilter();
  testManifestSecurityShape();
  testCsvNoResultsFallback();
  testIsolationCacheKeys();
  testFallbackIsolationScope();
  testManifestPermissionMinimums();
  testIdentityApiClassification();
  testFallbackIdentityBuilder();
  testIdentityFallbackScenarios();
  console.log('All unit tests passed.');
}

run();
