const assert = require('assert');
const core = require('../shared/fieldlens_core');

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

function run() {
  testContextParsing();
  testCsvGeneration();
  testSettingsNormalization();
  testGroupFilter();
  console.log('All unit tests passed.');
}

run();
