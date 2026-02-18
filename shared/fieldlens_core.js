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

  return {
    parseSalesforceContext: parseSalesforceContext,
    normalizeSettings: normalizeSettings,
    shouldShowGroup: shouldShowGroup,
    csvEscape: csvEscape,
    buildImpactCsvRows: buildImpactCsvRows
  };
});
