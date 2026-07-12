(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FieldLensCore = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function parseSalesforceContext(urlString) {
    var url = new URL(urlString);
    var path = url.pathname;

    var setupMatch = path.match(/^\/lightning\/setup\/ObjectManager\/([^/]+)\/FieldsAndRelationships\/([^/]+)\/view/i);
    if (setupMatch) {
      return {
        pageType: 'setupField',
        isSupportedPage: true,
        objectApiName: decodeURIComponent(setupMatch[1]),
        fieldApiName: decodeURIComponent(setupMatch[2]),
        message: null
      };
    }

    var recordMatch = path.match(/^\/lightning\/r\/([^/]+)\/[^/]+\/view/i);
    if (recordMatch) {
      return {
        pageType: 'recordPage',
        isSupportedPage: true,
        objectApiName: decodeURIComponent(recordMatch[1]),
        fieldApiName: null,
        message: null
      };
    }

    return {
      pageType: 'unsupported',
      isSupportedPage: false,
      objectApiName: null,
      fieldApiName: null,
      message: 'FieldLens works on Object Manager field pages and record pages in Lightning Experience.'
    };
  }

  function normalizeSettings(incoming) {
    incoming = incoming && typeof incoming === 'object' ? incoming : {};
    return {
      defaultScanMode: incoming.defaultScanMode === 'deep' ? 'deep' : 'quick',
      hideZeroGroups: !!incoming.hideZeroGroups
    };
  }

  function shouldShowGroup(itemCount, hideZeroGroups) {
    return !hideZeroGroups || Number(itemCount || 0) > 0;
  }

  function csvEscape(value) {
    var s = String(value == null ? '' : value);
    if (/[",\n]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function buildImpactCsvRows(result) {
    var groups = result && result.groups ? result.groups : {};
    var mapping = [
      ['Validation Rules', groups.validationRules || []],
      ['Apex Classes', groups.apexClasses || []],
      ['Apex Triggers', groups.apexTriggers || []],
      ['Flows', groups.flows || []],
      ['Formula Fields', groups.formulaFields || []],
      ['Page Layouts', groups.pageLayouts || []],
      ['List Views', groups.listViews || []],
      ['Report Types', groups.reportTypes || []],
      ['FLS / Permissions', groups.fieldPermissions || []]
    ];

    var rows = [['Group', 'Name', 'Subtitle', 'URL']];
    for (var i = 0; i < mapping.length; i += 1) {
      var groupLabel = mapping[i][0];
      var items = mapping[i][1];
      for (var j = 0; j < items.length; j += 1) {
        var item = items[j] || {};
        rows.push([groupLabel, item.name || item.id || '', item.subtitle || '', item.url || '']);
      }
    }
    if (rows.length === 1) {
      rows.push(['No Results', '', '', '']);
    }
    return rows;
  }

  function normalizeHostnameFromBaseUrl(baseUrl) {
    try {
      return new URL(String(baseUrl || '')).hostname.toLowerCase();
    } catch (_) {
      return '';
    }
  }

  function sanitizeIdentityPart(value, fallbackValue) {
    var normalized = String(value == null ? '' : value).trim().toLowerCase();
    normalized = normalized.replace(/[^a-z0-9_.-]/g, '_');
    return normalized || fallbackValue;
  }

  function buildIdentityScope(baseUrl, identity) {
    identity = identity && typeof identity === 'object' ? identity : {};
    return {
      hostname: sanitizeIdentityPart(normalizeHostnameFromBaseUrl(baseUrl), 'unknown-host'),
      instanceKey: sanitizeIdentityPart(identity.instanceKey, 'unknown-instance'),
      orgId: sanitizeIdentityPart(identity.orgId, 'unknown-org'),
      userId: sanitizeIdentityPart(identity.userId, 'unknown-user')
    };
  }

  function buildScanCacheKey(options) {
    options = options && typeof options === 'object' ? options : {};
    var scope = buildIdentityScope(options.baseUrl, options.identity);
    var objectApiName = sanitizeIdentityPart(options.objectApiName, 'unknown-object');
    var fieldApiName = sanitizeIdentityPart(options.fieldApiName, 'unknown-field');
    var scanMode = options.scanMode === 'deep' ? 'deep' : 'quick';
    var schemaVersion = sanitizeIdentityPart(options.schemaVersion, 'v1');
    return [
      'scan',
      schemaVersion,
      scope.hostname,
      scope.instanceKey,
      scope.orgId,
      scope.userId,
      objectApiName,
      fieldApiName,
      scanMode
    ].join(':');
  }

  function buildFieldCacheKey(options) {
    options = options && typeof options === 'object' ? options : {};
    var scope = buildIdentityScope(options.baseUrl, options.identity);
    var objectApiName = sanitizeIdentityPart(options.objectApiName, 'unknown-object');
    var schemaVersion = sanitizeIdentityPart(options.schemaVersion, 'v1');
    return [
      'fields',
      schemaVersion,
      scope.hostname,
      scope.instanceKey,
      scope.orgId,
      scope.userId,
      objectApiName
    ].join(':');
  }

  return {
    parseSalesforceContext: parseSalesforceContext,
    normalizeSettings: normalizeSettings,
    shouldShowGroup: shouldShowGroup,
    csvEscape: csvEscape,
    buildImpactCsvRows: buildImpactCsvRows,
    normalizeHostnameFromBaseUrl: normalizeHostnameFromBaseUrl,
    buildIdentityScope: buildIdentityScope,
    buildScanCacheKey: buildScanCacheKey,
    buildFieldCacheKey: buildFieldCacheKey
  };
});
