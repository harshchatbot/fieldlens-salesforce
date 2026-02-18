const API_VERSION = 'v60.0';
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_SCHEMA_VERSION = 'v8';

const inFlightScans = new Map();
const inFlightFieldLoads = new Map();

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') {
    return false;
  }

  if (message.type === 'FIELDLENS_SCAN_IMPACT') {
    handleScanImpact(message, sender?.tab?.id)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: toClientError(error) }));
    return true;
  }

  if (message.type === 'FIELDLENS_LOAD_FIELDS') {
    handleLoadFields(message, sender?.tab?.id)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: toClientError(error) }));
    return true;
  }

  if (message.type === 'FIELDLENS_TOOLING_QUERY' && typeof message.url === 'string') {
    forwardToolingQueryToTab(message.url)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: error.message || 'Failed to forward tooling query.' }));
    return true;
  }

  return false;
});

async function handleScanImpact(message, tabId) {
  const { baseUrl, objectApiName, fieldApiName } = message;
  const scanMode = message.scanMode === 'deep' ? 'deep' : 'quick';
  const isDeep = scanMode === 'deep';
  if (!baseUrl || !objectApiName || !fieldApiName) {
    throw createError('INVALID_INPUT', 'Missing object or field context for scan.');
  }

  const scanKey = `scan:${CACHE_SCHEMA_VERSION}:${new URL(baseUrl).hostname}:${objectApiName}:${fieldApiName}:${scanMode}`;
  // Cache by org host + object + field for 10 minutes.
  const cached = await getCached(scanKey);
  if (cached) {
    return { ...cached, fromCache: true };
  }

  if (inFlightScans.has(scanKey)) {
    return inFlightScans.get(scanKey);
  }

  const promise = (async () => {
    const escapedField = escapeSoqlLike(fieldApiName);
    const fullFieldName = `${objectApiName}.${fieldApiName}`;
    const escapedObjectForSoql = escapeSoqlValue(objectApiName);
    const escapedFullFieldForSoql = escapeSoqlValue(fullFieldName);

    const apexClassSoql = `SELECT Id, Name, Body FROM ApexClass ORDER BY Name`;
    const apexTriggerSoql = `SELECT Id, Name, TableEnumOrId, Body FROM ApexTrigger ORDER BY Name`;
    const validationSoql = `SELECT Id, ValidationName, Active, EntityDefinitionId, ErrorConditionFormula FROM ValidationRule ORDER BY ValidationName`;
    const flsSoql = `SELECT Id, ParentId, PermissionsRead, PermissionsEdit, SobjectType, Field, Parent.Label, Parent.Name, Parent.IsOwnedByProfile, Parent.ProfileId, Parent.Profile.Name FROM FieldPermissions WHERE SobjectType = '${escapedObjectForSoql}' AND Field = '${escapedFullFieldForSoql}' ORDER BY Parent.Label`;

    const [classesRes, triggersRes, validationRes, flowsRes, flsRes, formulaRes, layoutRes, listViewRes, reportTypeRes] = await Promise.allSettled([
      runToolingQuery(baseUrl, apexClassSoql, tabId),
      runToolingQuery(baseUrl, apexTriggerSoql, tabId),
      runValidationRuleBestEffort(baseUrl, validationSoql, fieldApiName, tabId, isDeep),
      isDeep ? runFlowBestEffortQuery(baseUrl, escapedField, tabId) : Promise.resolve([]),
      runDataQuery(baseUrl, flsSoql, tabId),
      isDeep ? runFormulaFieldBestEffortQuery(baseUrl, objectApiName, fieldApiName, fullFieldName, tabId) : Promise.resolve([]),
      isDeep ? runPageLayoutBestEffortQuery(baseUrl, objectApiName, fieldApiName, fullFieldName, tabId) : Promise.resolve([]),
      isDeep ? runListViewBestEffortQuery(baseUrl, objectApiName, fieldApiName, fullFieldName, tabId) : Promise.resolve([]),
      isDeep ? runReportTypeBestEffortQuery(baseUrl, objectApiName, fieldApiName, fullFieldName, tabId) : Promise.resolve([])
    ]);

    const classes = filterByBodyFieldReference(resolveSettledRecords(classesRes, 'ApexClass'), fieldApiName).map((item) => ({
      id: item.Id,
      name: item.Name,
      subtitle: 'Apex Class',
      url: `${baseUrl}/lightning/setup/ApexClasses/page?address=%2F${item.Id}`
    }));

    const triggers = filterByBodyFieldReference(resolveSettledRecords(triggersRes, 'ApexTrigger'), fieldApiName).map((item) => ({
      id: item.Id,
      name: item.Name,
      subtitle: item.TableEnumOrId ? `Object: ${item.TableEnumOrId}` : 'Apex Trigger',
      url: `${baseUrl}/lightning/setup/ApexTriggers/page?address=%2F${item.Id}`
    }));

    const validationRecords =
      validationRes.status === 'fulfilled' && Array.isArray(validationRes.value?.records)
        ? validationRes.value.records
        : [];
    const validationRules = validationRecords.map((item) => ({
        id: item.Id,
        name: item.ValidationName,
        subtitle: item.Active ? 'Active' : 'Inactive',
        url: `${baseUrl}/lightning/setup/ObjectManager/${encodeURIComponent(objectApiName)}/ValidationRules/view`
      }));

    const flowItems = flowsRes.status === 'fulfilled' ? flowsRes.value : [];
    const flows = flowItems.map((item) => ({
      id: item.Id,
      name: item.MasterLabel || item.DeveloperName || item.ApiName || item.Id,
      subtitle: item.Status ? `Status: ${item.Status}` : 'Flow',
      url: `${baseUrl}/lightning/setup/Flows/page?address=%2F${item.Id}`
    }));
    const flsItems = flsRes.status === 'fulfilled' ? flsRes.value : [];
    const parentDetailsById = await loadPermissionParentDetails(baseUrl, flsItems, tabId);
    const fieldPermissions = flsItems.map((item) => {
      const parentId = item.ParentId || item.Id;
      const detail = parentDetailsById.get(parentId) || null;
      const isProfile = detail ? !!detail.isOwnedByProfile : !!item.Parent?.IsOwnedByProfile;
      const access = item.PermissionsEdit ? 'Read + Edit' : item.PermissionsRead ? 'Read' : 'No Access';
      const profileName = detail?.profileName || item.Parent?.Profile?.Name || null;
      const profileId = detail?.profileId || item.Parent?.ProfileId || null;
      const displayName =
        profileName ||
        detail?.label ||
        item.Parent?.Label ||
        detail?.name ||
        item.Parent?.Label ||
        item.Parent?.Name ||
        (looksLikeSalesforceId(parentId) ? 'Unknown Permission Container' : parentId);
      const url = isProfile
        ? profileId
          ? `${baseUrl}/lightning/setup/EnhancedProfiles/page?address=%2F${profileId}`
          : `${baseUrl}/lightning/setup/EnhancedProfiles/home`
        : `${baseUrl}/lightning/setup/PermSets/page?address=%2F${parentId}`;
      return {
        id: item.Id,
        name: displayName,
        subtitle: `${isProfile ? 'Profile' : 'Permission Set'} - ${access}`,
        url,
        permissionType: isProfile ? 'profile' : 'permissionSet',
        accessType: item.PermissionsEdit ? 'readEdit' : item.PermissionsRead ? 'read' : 'none'
      };
    });
    const formulaItems = formulaRes.status === 'fulfilled' ? formulaRes.value : [];
    const formulaFields = formulaItems.map((item) => ({
      id: item.Id,
      name: `${item.TableEnumOrId || 'Unknown'}.${item.DeveloperName || 'Unknown'}`,
      subtitle: 'Formula Field',
      url: `${baseUrl}/lightning/setup/ObjectManager/${encodeURIComponent(item.TableEnumOrId || objectApiName)}/FieldsAndRelationships/${encodeURIComponent(item.DeveloperName || '')}/view`
    }));
    const layoutItems = layoutRes.status === 'fulfilled' ? layoutRes.value : [];
    const pageLayouts = layoutItems.map((item) => ({
      id: item.Id,
      name: resolveLayoutDisplayName(item),
      subtitle: item.TableEnumOrId ? `Object: ${item.TableEnumOrId}` : 'Page Layout',
      url: `${baseUrl}/lightning/setup/ObjectManager/${encodeURIComponent(item.TableEnumOrId || objectApiName)}/PageLayouts/view`
    }));
    const listViewItems = listViewRes.status === 'fulfilled' ? listViewRes.value : [];
    const listViews = listViewItems.map((item) => ({
      id: item.Id,
      name: item.Name || item.DeveloperName || item.Id,
      subtitle: item.SobjectType ? `Object: ${item.SobjectType}` : 'List View',
      url: `${baseUrl}/lightning/o/${encodeURIComponent(item.SobjectType || objectApiName)}/list`
    }));
    const reportTypeItems = reportTypeRes.status === 'fulfilled' ? reportTypeRes.value : [];
    const reportTypes = reportTypeItems.map((item) => ({
      id: item.Id,
      name: item.reportTypeName || item.Name || item.DeveloperName || item.Id,
      subtitle: item.Field ? `Field: ${item.Field}` : 'Report Type',
      url: `${baseUrl}/lightning/setup/ReportTypes/home`
    }));

    const warnings = [];
    if (classesRes.status === 'rejected') warnings.push(classesRes.reason.message);
    if (triggersRes.status === 'rejected') warnings.push(triggersRes.reason.message);
    if (validationRes.status === 'rejected') {
      warnings.push(validationRes.reason.message);
    } else if (validationRes.value?.warning && isDeep) {
      warnings.push(validationRes.value.warning);
    }
    if (isDeep && flowsRes.status === 'rejected') warnings.push(flowsRes.reason.message);
    if (flsRes.status === 'rejected') warnings.push('FLS scan unavailable for this user/org permissions.');
    if (isDeep && formulaRes.status === 'rejected') warnings.push(formulaRes.reason.message);
    if (isDeep && layoutRes.status === 'rejected') warnings.push(layoutRes.reason.message);
    if (isDeep && listViewRes.status === 'rejected') warnings.push(listViewRes.reason.message);
    if (isDeep && reportTypeRes.status === 'rejected') warnings.push(reportTypeRes.reason.message);

    const coreResults = [classesRes, triggersRes, validationRes];
    // If all primary categories fail, return a top-level error instead of empty data.
    const coreFailed = coreResults.every((result) => result.status === 'rejected');
    if (coreFailed) {
      const coreError = coreResults.find((result) => result.status === 'rejected')?.reason;
      throw createError(coreError?.code || 'API_ERROR', coreError?.message || 'All core impact queries failed.', {
        nested: coreError?.debug || null
      });
    }

    const payload = {
      objectApiName,
      fieldApiName,
      scanMode,
      counts: {
        validationRules: validationRules.length,
        apexClasses: classes.length,
        apexTriggers: triggers.length,
        flows: flows.length,
        fieldPermissions: fieldPermissions.length,
        formulaFields: formulaFields.length,
        pageLayouts: pageLayouts.length,
        listViews: listViews.length,
        reportTypes: reportTypes.length
      },
      groups: {
        validationRules,
        apexClasses: classes,
        apexTriggers: triggers,
        flows,
        fieldPermissions,
        formulaFields,
        pageLayouts,
        listViews,
        reportTypes
      },
      warnings,
      generatedAt: Date.now(),
      fromCache: false
    };

    await setCached(scanKey, payload);
    return payload;
  })();

  inFlightScans.set(scanKey, promise);
  try {
    return await promise;
  } finally {
    inFlightScans.delete(scanKey);
  }
}

async function handleLoadFields(message, tabId) {
  const { baseUrl, objectApiName } = message;
  if (!baseUrl || !objectApiName) {
    throw createError('INVALID_INPUT', 'Missing object context for field list loading.');
  }

  const fieldKey = `fields:${CACHE_SCHEMA_VERSION}:${new URL(baseUrl).hostname}:${objectApiName}`;
  const cached = await getCached(fieldKey);
  if (cached) {
    return { ...cached, fromCache: true };
  }

  if (inFlightFieldLoads.has(fieldKey)) {
    return inFlightFieldLoads.get(fieldKey);
  }

  const promise = (async () => {
    const escapedObject = escapeSoqlValue(objectApiName);
    const soql = `SELECT DurableId, QualifiedApiName, Label, DataType FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${escapedObject}' ORDER BY Label`;
    const records = await runToolingQuery(baseUrl, soql, tabId);

    const fields = records.map((record) => ({
      durableId: record.DurableId,
      apiName: record.QualifiedApiName,
      label: record.Label || record.QualifiedApiName,
      dataType: record.DataType || 'Unknown'
    }));

    const payload = {
      objectApiName,
      fields,
      generatedAt: Date.now(),
      fromCache: false
    };

    await setCached(fieldKey, payload);
    return payload;
  })();

  inFlightFieldLoads.set(fieldKey, promise);
  try {
    return await promise;
  } finally {
    inFlightFieldLoads.delete(fieldKey);
  }
}

function resolveSettledRecords(settled) {
  if (settled.status === 'fulfilled') {
    return settled.value;
  }
  return [];
}

async function runValidationRuleBestEffort(baseUrl, primarySoql, fieldApiName, tabId, allowMetadataFallback) {
  const lowerField = String(fieldApiName || '').toLowerCase();

  try {
    const records = await runToolingQuery(baseUrl, primarySoql, tabId);
    const filtered = records.filter((item) =>
      String(item?.ErrorConditionFormula || '').toLowerCase().includes(lowerField)
    );
    return { records: filtered };
  } catch (error) {
    if (!/No such column 'ErrorConditionFormula'/i.test(error.message || '')) {
      throw error;
    }
  }

  if (!allowMetadataFallback) {
    return {
      records: [],
      warning: 'Validation Rule deep scan is skipped in Quick mode.'
    };
  }

  const fallbackSoql = `SELECT Id, ValidationName, Active, EntityDefinitionId, Metadata FROM ValidationRule ORDER BY ValidationName`;
  try {
    const records = await runToolingQuery(baseUrl, fallbackSoql, tabId);
    const filtered = records.filter((item) =>
      JSON.stringify(item?.Metadata || {}).toLowerCase().includes(lowerField)
    );
    return {
      records: filtered,
      warning: 'Validation Rule formula field is unavailable in this org; using metadata best-effort matching.'
    };
  } catch (_) {
    return {
      records: [],
      warning: 'Validation Rule scanning is unavailable in this org/API shape.'
    };
  }
}

async function runFlowBestEffortQuery(baseUrl, escapedField, tabId) {
  // Flow tooling schema varies heavily; query broad records first, then inspect content client-side.
  const fieldNeedle = String(escapedField || '').replace(/\\'/g, "'").toLowerCase();
  const candidates = [
    `SELECT Id, MasterLabel, Status, ProcessType FROM Flow ORDER BY LastModifiedDate DESC LIMIT 200`,
    `SELECT Id, DeveloperName, MasterLabel, ProcessType FROM FlowDefinitionView ORDER BY LastModifiedDate DESC LIMIT 200`
  ];

  const byId = new Map();
  let hadSuccess = false;
  let lastError = null;

  for (const soql of candidates) {
    try {
      const records = await runToolingQuery(baseUrl, soql, tabId);
      hadSuccess = true;
      for (const item of records) {
        const text = JSON.stringify(item || {}).toLowerCase();
        if (fieldNeedle && text.includes(fieldNeedle)) {
          byId.set(item.Id, item);
        }
      }

      // If raw rows don't contain field references, inspect flow metadata details.
      if (!byId.size && soql.includes(' FROM Flow ')) {
        const detailed = await scanFlowMetadataDetails(baseUrl, records.slice(0, 80), fieldNeedle, tabId);
        for (const item of detailed) {
          byId.set(item.Id, item);
        }
      }
    } catch (error) {
      lastError = error;
      if (isPermissionError(error)) {
        throw error;
      }
    }
  }

  if (byId.size) {
    return Array.from(byId.values());
  }
  if (!hadSuccess && lastError) {
    throw createError('FLOW_BEST_EFFORT_FAILED', 'Flow scan is unavailable in this org/API shape.');
  }
  return [];
}

async function scanFlowMetadataDetails(baseUrl, flowRecords, fieldNeedle, tabId) {
  const matches = [];
  if (!fieldNeedle) {
    return matches;
  }

  for (const flow of flowRecords) {
    const flowId = flow?.Id;
    if (!flowId) {
      continue;
    }
    try {
      const detail = await runSingleJsonGet(
        baseUrl,
        `/services/data/${API_VERSION}/tooling/sobjects/Flow/${encodeURIComponent(flowId)}`,
        tabId
      );
      const text = JSON.stringify(detail?.Metadata || detail || {}).toLowerCase();
      if (!text.includes(fieldNeedle)) {
        continue;
      }
      matches.push({
        Id: flowId,
        MasterLabel: flow?.MasterLabel || detail?.MasterLabel || detail?.Label || flowId,
        Status: flow?.Status || detail?.Status || null
      });
    } catch (_) {
      // best-effort: ignore individual flow metadata read errors
    }
  }

  return matches;
}

async function runFormulaFieldBestEffortQuery(baseUrl, objectApiName, fieldApiName, fullFieldName, tabId) {
  const escapedObject = escapeSoqlValue(objectApiName);
  const escapedFullField = escapeSoqlLike(fullFieldName);

  const candidates = [
    `SELECT Id, DeveloperName, TableEnumOrId, Metadata FROM CustomField WHERE Metadata LIKE '%${escapedFullField}%' ORDER BY TableEnumOrId, DeveloperName`,
    `SELECT Id, DeveloperName, TableEnumOrId, Metadata FROM CustomField WHERE TableEnumOrId = '${escapedObject}' ORDER BY DeveloperName`
  ];

  let lastError;
  for (const soql of candidates) {
    try {
      const records = await runToolingQuery(baseUrl, soql, tabId);
      return records.filter((item) =>
        containsFieldReferenceText(JSON.stringify(item?.Metadata || {}), fieldApiName, fullFieldName)
      );
    } catch (error) {
      lastError = error;
    }
  }

  // Fallback: Describe API is often more reliable for calculatedFormula text.
  let describeError = null;
  try {
    const describeMatches = await runFormulaDescribeFallback(baseUrl, objectApiName, fieldApiName, fullFieldName, tabId);
    // Describe fallback executed successfully (match or no match), so do not report unavailable.
    return describeMatches;
  } catch (error) {
    describeError = error;
  }

  if (lastError || describeError) {
    throw createError('FORMULA_SCAN_UNAVAILABLE', 'Formula field scan is unavailable in this org/API shape.');
  }
  return [];
}

async function runFormulaDescribeFallback(baseUrl, objectApiName, fieldApiName, fullFieldName, tabId) {
  const describe = await runSObjectDescribe(baseUrl, objectApiName, tabId);
  const fields = Array.isArray(describe?.fields) ? describe.fields : [];

  return fields
    .filter((field) => {
      const formulaText = String(field?.calculatedFormula || '');
      const isCalculated = !!field?.calculated || formulaText.length > 0;
      return isCalculated && containsFieldReferenceText(formulaText, fieldApiName, fullFieldName);
    })
    .map((field) => ({
      Id: field.name || `${objectApiName}.${field.label || 'Formula'}`,
      DeveloperName: field.name || field.label || 'UnknownFormula',
      TableEnumOrId: objectApiName,
      Metadata: { formula: field.calculatedFormula || '' }
    }));
}

async function runSObjectDescribe(baseUrl, objectApiName, tabId) {
  const describePath = `/services/data/${API_VERSION}/sobjects/${encodeURIComponent(objectApiName)}/describe`;
  const candidates = buildApiBaseCandidates(baseUrl);
  const candidateErrors = [];

  for (const candidate of candidates) {
    const url = `${candidate}${describePath}`;
    try {
      const result = await fetchSalesforceJson(candidate, url, tabId);
      if (result.status < 200 || result.status >= 300) {
        throw createError('API_ERROR', `Describe API failed with status ${result.status}.`);
      }
      if (!result.data || typeof result.data !== 'object') {
        throw createError('API_ERROR', 'Describe API returned unexpected response.');
      }
      return result.data;
    } catch (error) {
      candidateErrors.push({
        candidate,
        code: error.code || 'UNKNOWN_ERROR',
        message: error.message || 'Unknown error',
        debug: error.debug || null
      });
      if (isPermissionError(error)) {
        throw error;
      }
    }
  }

  const first = candidateErrors[0];
  throw createError(first?.code || 'API_ERROR', first?.message || 'Unable to run describe for formula scan.', {
    candidates: candidateErrors
  });
}

async function runPageLayoutBestEffortQuery(baseUrl, objectApiName, fieldApiName, fullFieldName, tabId) {
  const escapedObject = escapeSoqlValue(objectApiName);
  const byId = new Map();
  let hadSuccessfulAttempt = false;
  let lastError = null;

  const withMetadataSoql = `SELECT Id, Name, TableEnumOrId, Metadata FROM Layout WHERE TableEnumOrId = '${escapedObject}' ORDER BY Name`;
  try {
    const records = await runToolingQuery(baseUrl, withMetadataSoql, tabId);
    hadSuccessfulAttempt = true;
    for (const item of records) {
      if (!containsFieldReferenceText(JSON.stringify(item?.Metadata || {}), fieldApiName, fullFieldName)) {
        continue;
      }
      byId.set(item.Id, item);
    }
  } catch (error) {
    lastError = error;
  }

  const basicSoql = `SELECT Id, Name, TableEnumOrId FROM Layout WHERE TableEnumOrId = '${escapedObject}' ORDER BY Name`;
  try {
    const layouts = await runToolingQuery(baseUrl, basicSoql, tabId);
    hadSuccessfulAttempt = true;
    const capped = layouts.slice(0, 80);
    for (const item of capped) {
      const layoutId = item?.Id;
      if (!layoutId || byId.has(layoutId)) {
        continue;
      }
      try {
        const detail = await runSingleJsonGet(
          baseUrl,
          `/services/data/${API_VERSION}/tooling/sobjects/Layout/${encodeURIComponent(layoutId)}`,
          tabId
        );
        if (!containsFieldReferenceText(JSON.stringify(detail?.Metadata || detail || {}), fieldApiName, fullFieldName)) {
          continue;
        }
        byId.set(layoutId, {
          Id: layoutId,
          Name: resolveLayoutDisplayName({
            ...item,
            ...detail,
            Id: layoutId,
            Metadata: detail?.Metadata || item?.Metadata
          }),
          TableEnumOrId: item?.TableEnumOrId || detail?.TableEnumOrId || objectApiName
        });
      } catch (_) {
        // Ignore per-layout detail failures.
      }
    }
  } catch (error) {
    lastError = error;
  }

  try {
    const describeLayouts = await runPageLayoutDescribeBestEffort(baseUrl, objectApiName, fieldApiName, fullFieldName, tabId);
    hadSuccessfulAttempt = true;
    for (const item of describeLayouts) {
      byId.set(item.Id, item);
    }
  } catch (error) {
    lastError = error;
  }

  if (byId.size > 0) {
    return Array.from(byId.values());
  }
  if (!hadSuccessfulAttempt && lastError) {
    throw createError('LAYOUT_SCAN_UNAVAILABLE', 'Page Layout scan is unavailable in this org/API shape.');
  }
  return [];
}

async function runPageLayoutDescribeBestEffort(baseUrl, objectApiName, fieldApiName, fullFieldName, tabId) {
  const payload = await runSingleJsonGet(
    baseUrl,
    `/services/data/${API_VERSION}/sobjects/${encodeURIComponent(objectApiName)}/describe/layouts/`,
    tabId
  );
  const layouts = Array.isArray(payload?.layouts) ? payload.layouts : [];
  const matches = [];
  for (const layout of layouts) {
    const text = JSON.stringify(layout || {});
    if (!containsFieldReferenceText(text, fieldApiName, fullFieldName)) {
      continue;
    }
    const id = layout?.id || layout?.Id || layout?.name || `layout:${matches.length + 1}`;
    matches.push({
      Id: id,
      Name: resolveLayoutDisplayName({
        ...layout,
        Id: id
      }),
      TableEnumOrId: objectApiName
    });
  }
  return matches;
}

async function runListViewBestEffortQuery(baseUrl, objectApiName, fieldApiName, fullFieldName, tabId) {
  const escapedObject = escapeSoqlValue(objectApiName);
  const candidates = [
    `SELECT Id, Name, SobjectType, Query FROM ListView WHERE SobjectType = '${escapedObject}' ORDER BY Name`,
    `SELECT Id, Name, SobjectType, Columns FROM ListView WHERE SobjectType = '${escapedObject}' ORDER BY Name`,
    `SELECT Id, Name, SobjectType, DeveloperName FROM ListView WHERE SobjectType = '${escapedObject}' ORDER BY Name`
  ];

  const byId = new Map();
  for (const soql of candidates) {
    try {
      const records = await runDataQuery(baseUrl, soql, tabId);
      for (const item of records) {
        const scanText = [
          item?.Query || '',
          item?.Columns || '',
          item?.DeveloperName || '',
          item?.Name || ''
        ].join(' ');
        if (containsFieldReferenceText(scanText, fieldApiName, fullFieldName)) {
          byId.set(item.Id, item);
        }
      }
    } catch (_) {
      // keep trying other list-view shapes
    }
  }

  if (byId.size > 0) {
    return Array.from(byId.values());
  }

  // Extra fallback: UI API list metadata often contains selected/displayed fields.
  try {
    const uiApiItems = await runListViewUiApiBestEffort(baseUrl, objectApiName, fieldApiName, fullFieldName, tabId);
    for (const item of uiApiItems) {
      byId.set(item.Id, item);
    }
  } catch (_) {
    // Best-effort only.
  }

  // Additional fallback: classic listview describe endpoints.
  try {
    const describedItems = await runListViewDescribeBestEffort(baseUrl, objectApiName, fieldApiName, fullFieldName, tabId);
    for (const item of describedItems) {
      byId.set(item.Id, item);
    }
  } catch (_) {
    // Best-effort only.
  }

  return Array.from(byId.values());
}

async function runListViewUiApiBestEffort(baseUrl, objectApiName, fieldApiName, fullFieldName, tabId) {
  const path = `/services/data/${API_VERSION}/ui-api/list-info/${encodeURIComponent(objectApiName)}`;
  const payload = await runSingleJsonGet(baseUrl, path, tabId);
  const listMap = payload?.lists && typeof payload.lists === 'object' ? payload.lists : {};

  const items = [];
  for (const [id, raw] of Object.entries(listMap)) {
    const text = JSON.stringify(raw || {});
    if (!containsFieldReferenceText(text, fieldApiName, fullFieldName)) {
      continue;
    }
    items.push({
      Id: id,
      Name: raw?.label || raw?.developerName || id,
      SobjectType: objectApiName
    });
  }
  return items;
}

async function runListViewDescribeBestEffort(baseUrl, objectApiName, fieldApiName, fullFieldName, tabId) {
  const listPath = `/services/data/${API_VERSION}/sobjects/${encodeURIComponent(objectApiName)}/listviews`;
  const listPayload = await runSingleJsonGet(baseUrl, listPath, tabId);
  const listviews = Array.isArray(listPayload?.listviews) ? listPayload.listviews : [];
  const matches = [];

  // Guardrail: avoid excessive API calls in very large orgs.
  const capped = listviews.slice(0, 60);
  for (const lv of capped) {
    const lvId = lv?.id || lv?.Id;
    if (!lvId) {
      continue;
    }
    const describePath = `/services/data/${API_VERSION}/sobjects/${encodeURIComponent(objectApiName)}/listviews/${encodeURIComponent(
      lvId
    )}/describe`;
    try {
      const detail = await runSingleJsonGet(baseUrl, describePath, tabId);
      const text = JSON.stringify(detail || {});
      if (!containsFieldReferenceText(text, fieldApiName, fullFieldName)) {
        continue;
      }
      matches.push({
        Id: lvId,
        Name: lv?.label || lv?.developerName || lv?.name || lvId,
        SobjectType: objectApiName
      });
    } catch (_) {
      // skip individual listview describe failures
    }
  }

  return matches;
}

async function runSingleJsonGet(baseUrl, path, tabId) {
  const candidates = buildApiBaseCandidates(baseUrl);
  let lastError = null;
  for (const candidate of candidates) {
    const url = `${candidate}${path}`;
    try {
      const result = await fetchSalesforceJson(candidate, url, tabId);
      if (result.status < 200 || result.status >= 300) {
        throw createError('API_ERROR', `Request failed with status ${result.status}`);
      }
      if (!result.data || typeof result.data !== 'object') {
        throw createError('API_ERROR', 'Unexpected non-JSON response body.');
      }
      return result.data;
    } catch (error) {
      lastError = error;
      if (isPermissionError(error)) {
        throw error;
      }
    }
  }
  throw lastError || createError('API_ERROR', 'Unable to execute API request.');
}

async function runReportTypeBestEffortQuery(baseUrl, objectApiName, fieldApiName, fullFieldName, tabId) {
  const escapedObject = escapeSoqlValue(objectApiName);
  const escapedFullField = escapeSoqlValue(fullFieldName);

  const candidates = [
    `SELECT Id, Field, ReportType.Name FROM ReportTypeColumn WHERE Field = '${escapedFullField}' ORDER BY ReportType.Name`,
    `SELECT Id, Name, Description, SobjectType FROM ReportType WHERE SobjectType = '${escapedObject}' ORDER BY Name`
  ];

  let lastError;
  for (const soql of candidates) {
    try {
      const records = await runDataQuery(baseUrl, soql, tabId);
      if (soql.includes('ReportTypeColumn')) {
        return records.map((item) => ({
          Id: item.Id,
          Field: item.Field,
          reportTypeName: item.ReportType?.Name || 'Unknown Report Type'
        }));
      }
      return records.filter((item) =>
        containsFieldReferenceText(
          `${item?.Name || ''} ${item?.Description || ''}`,
          fieldApiName,
          fullFieldName
        )
      );
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw createError('REPORT_TYPE_SCAN_UNAVAILABLE', 'Report Type scan is unavailable in this org/API shape.');
  }
  return [];
}

async function runToolingQuery(baseUrl, soql, tabId) {
  const queryPath = `/services/data/${API_VERSION}/tooling/query/?q=${encodeURIComponent(soql)}`;
  const candidates = buildApiBaseCandidates(baseUrl);
  const candidateErrors = [];

  for (const candidate of candidates) {
    try {
      return await runPaginatedQueryForBase(candidate, queryPath, tabId);
    } catch (error) {
      candidateErrors.push({
        candidate,
        code: error.code || 'UNKNOWN_ERROR',
        message: error.message || 'Unknown error',
        debug: error.debug || null
      });
      if (isPermissionError(error)) {
        throw error;
      }
    }
  }

  const first = candidateErrors[0];
  throw createError(
    first?.code || 'API_ERROR',
    first?.message || 'Unable to execute Tooling API query.',
    { candidates: candidateErrors }
  );
}

async function runDataQuery(baseUrl, soql, tabId) {
  const queryPath = `/services/data/${API_VERSION}/query/?q=${encodeURIComponent(soql)}`;
  const candidates = buildApiBaseCandidates(baseUrl);
  const candidateErrors = [];

  for (const candidate of candidates) {
    try {
      return await runPaginatedQueryForBase(candidate, queryPath, tabId);
    } catch (error) {
      candidateErrors.push({
        candidate,
        code: error.code || 'UNKNOWN_ERROR',
        message: error.message || 'Unknown error',
        debug: error.debug || null
      });
      if (isPermissionError(error)) {
        throw error;
      }
    }
  }

  const first = candidateErrors[0];
  throw createError(
    first?.code || 'API_ERROR',
    first?.message || 'Unable to execute Salesforce data API query.',
    { candidates: candidateErrors }
  );
}

async function runPaginatedQueryForBase(apiBase, initialPath, tabId) {
  const allRecords = [];
  let nextUrl = `${apiBase}${initialPath}`;
  const debugTrail = [];

  while (nextUrl) {
    const result = await fetchSalesforceJson(apiBase, nextUrl, tabId);
    const { status, data, debug } = result;
    if (debug) {
      debugTrail.push(debug);
    }

    if (status === 401) {
      throw createError('NOT_LOGGED_IN', 'Salesforce session is not available. Please log in again.', {
        apiBase,
        debugTrail
      });
    }

    if (status === 403) {
      throw createError('INSUFFICIENT_PERMISSIONS', 'Tooling API access denied for this user.', {
        apiBase,
        debugTrail
      });
    }

    if (status < 200 || status >= 300) {
      const sfMessage = Array.isArray(data) && data[0]?.message ? data[0].message : `Salesforce API error (${status})`;
      if (/INSUFFICIENT_ACCESS|INVALID_SESSION_ID|API_DISABLED_FOR_ORG/i.test(sfMessage)) {
        throw createError('INSUFFICIENT_PERMISSIONS', sfMessage, { apiBase, debugTrail });
      }
      throw createError('API_ERROR', sfMessage, { apiBase, debugTrail });
    }

    if (Array.isArray(data.records)) {
      allRecords.push(...data.records);
    }

    nextUrl = data.nextRecordsUrl ? `${apiBase}${data.nextRecordsUrl}` : null;
  }

  return allRecords;
}

function buildApiBaseCandidates(baseUrl) {
  const base = new URL(baseUrl);
  const candidates = [];
  const host = base.hostname;

  if (host.includes('.lightning.force.com')) {
    const myDomainHost = host.replace('.lightning.force.com', '.my.salesforce.com');
    // Prefer my.salesforce.com first for API calls in Lightning orgs.
    candidates.push(`${base.protocol}//${myDomainHost}`);
    candidates.push(base.origin);
    return [...new Set(candidates)];
  }

  candidates.push(base.origin);
  if (host.endsWith('.force.com') && !host.includes('.my.salesforce.com') && !host.includes('.lightning.force.com')) {
    const alt = host.replace('.force.com', '.my.salesforce.com');
    if (alt !== host) {
      candidates.push(`${base.protocol}//${alt}`);
    }
  }

  return [...new Set(candidates)];
}

function isPermissionError(error) {
  return error && (error.code === 'INSUFFICIENT_PERMISSIONS' || /permission/i.test(error.message || ''));
}

function toClientError(error) {
  return {
    code: error.code || 'UNKNOWN_ERROR',
    message: error.message || 'Unknown error while communicating with Salesforce.',
    debug: error.debug || null
  };
}

function extractSalesforceErrorMessage(data) {
  if (!data) {
    return null;
  }
  if (Array.isArray(data)) {
    const first = data[0];
    if (first && typeof first.message === 'string' && first.message.trim()) {
      return first.message.trim();
    }
    return null;
  }
  if (typeof data === 'object') {
    if (typeof data.message === 'string' && data.message.trim()) {
      return data.message.trim();
    }
    if (Array.isArray(data.errors) && data.errors.length) {
      const first = data.errors[0];
      if (first && typeof first.message === 'string' && first.message.trim()) {
        return first.message.trim();
      }
    }
    if (Array.isArray(data.error) && data.error.length) {
      const first = data.error[0];
      if (first && typeof first.message === 'string' && first.message.trim()) {
        return first.message.trim();
      }
    }
  }
  return null;
}

function createError(code, message, options = null) {
  const error = new Error(message);
  error.code = code;
  if (options && typeof options === 'object') {
    error.debug = options;
  }
  return error;
}

function escapeSoqlLike(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function escapeSoqlValue(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function filterByBodyFieldReference(records, fieldApiName) {
  const needle = String(fieldApiName || '').toLowerCase();
  if (!needle) {
    return [];
  }
  return records.filter((item) => String(item?.Body || '').toLowerCase().includes(needle));
}

function containsFieldReferenceText(text, fieldApiName, fullFieldName) {
  const haystack = String(text || '').toLowerCase();
  const shortNeedle = String(fieldApiName || '').toLowerCase();
  const fullNeedle = String(fullFieldName || '').toLowerCase();
  return (!!shortNeedle && haystack.includes(shortNeedle)) || (!!fullNeedle && haystack.includes(fullNeedle));
}

function resolveLayoutDisplayName(layout) {
  const nameCandidate =
    layout?.Name ||
    layout?.name ||
    layout?.layoutName ||
    layout?.FullName ||
    layout?.fullName ||
    layout?.Metadata?.fullName ||
    layout?.Metadata?.FullName ||
    layout?.DeveloperName ||
    null;
  if (nameCandidate) {
    return String(nameCandidate);
  }
  return layout?.Id || layout?.id || 'Unknown Layout';
}

async function loadPermissionParentDetails(baseUrl, flsItems, tabId) {
  const ids = Array.from(
    new Set(
      (flsItems || [])
        .map((item) => item?.ParentId)
        .filter((id) => typeof id === 'string' && id.length >= 15)
    )
  );
  if (!ids.length) {
    return new Map();
  }

  const idList = ids.map((id) => `'${escapeSoqlValue(id)}'`).join(',');
  const soql =
    `SELECT Id, Label, Name, IsOwnedByProfile, ProfileId, Profile.Name ` +
    `FROM PermissionSet WHERE Id IN (${idList})`;

  try {
    const records = await runDataQuery(baseUrl, soql, tabId);
    const byId = new Map();
    for (const record of records) {
      byId.set(record.Id, {
        label: record.Label || null,
        name: record.Name || null,
        isOwnedByProfile: !!record.IsOwnedByProfile,
        profileName: record.Profile?.Name || null,
        profileId: record.ProfileId || null
      });
    }
    return byId;
  } catch (_) {
    return new Map();
  }
}

function looksLikeSalesforceId(value) {
  return /^[a-zA-Z0-9]{15,18}$/.test(String(value || ''));
}

async function fetchSalesforceJson(baseUrl, url, tabId) {
  const proxy = await forwardToolingQueryToTab(url, Number.isInteger(tabId) ? tabId : null);
  if (proxy?.ok === true) {
    return {
      status: proxy.status,
      data: proxy.data,
      debug: { stage: 'tab_content_fetch', status: proxy.status, url }
    };
  }

  const shouldRetryWithSid =
    proxy?.status === 0 ||
    /failed to fetch/i.test(proxy?.error || '') ||
    /cross-origin blocked/i.test(proxy?.error || '');
  if (shouldRetryWithSid) {
    try {
      const sidResult = await fetchSalesforceJsonWithSid(url);
      return {
        status: sidResult.status,
        data: sidResult.data,
        debug: {
          stage: 'service_worker_sid_fetch',
          status: sidResult.status,
          url
        }
      };
    } catch (sidError) {
      throw createError(sidError.code || 'NOT_LOGGED_IN', sidError.message || 'Salesforce session is not available.', {
        debugTrail: [
          { stage: 'tab_content_fetch', url, response: proxy || null },
          { stage: 'service_worker_sid_fetch', url, error: toClientError(sidError) }
        ]
      });
    }
  }

  const code =
    proxy?.status === 401 || proxy?.status === 0
      ? 'NOT_LOGGED_IN'
      : proxy?.status === 403
        ? 'INSUFFICIENT_PERMISSIONS'
        : 'API_ERROR';
  const message =
    proxy?.error ||
    (typeof proxy?.contentType === 'string' &&
    !proxy.contentType.includes('application/json')
      ? 'Salesforce session is not available. Please log in and refresh.'
      : null) ||
    proxy?.statusText ||
    (typeof proxy?.body === 'string' ? proxy.body : null) ||
    'Salesforce API request failed.';
  throw createError(code, message, {
    debugTrail: [{ stage: 'tab_content_fetch', url, response: proxy || null }]
  });
}

async function fetchSalesforceJsonWithSid(urlString) {
  const sid = await findSidForUrl(urlString);
  if (!sid) {
    throw createError('NOT_LOGGED_IN', 'Salesforce session cookie is not available.');
  }

  let res;
  try {
    res = await fetch(urlString, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${sid}`
      }
    });
  } catch (error) {
    throw createError('NETWORK_ERROR', error?.message || 'Failed to fetch with session cookie.');
  }

  const text = await res.text();
  const contentType = res.headers.get('content-type') || '';
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (_) {
    data = null;
  }

  if (res.status === 401) {
    throw createError('NOT_LOGGED_IN', 'Salesforce session is not available. Please log in again.');
  }
  if (res.status === 403) {
    throw createError('INSUFFICIENT_PERMISSIONS', 'Tooling API access denied for this user.');
  }
  if (!res.ok) {
    const sfMessage = extractSalesforceErrorMessage(data) || text || `Salesforce API failed with status ${res.status}.`;
    throw createError('API_ERROR', sfMessage);
  }
  if (!contentType.includes('application/json') || data === null) {
    throw createError('NOT_LOGGED_IN', 'Salesforce returned a non-JSON response. Please log in and refresh.');
  }

  return { status: res.status, data };
}

async function findSidForUrl(urlString) {
  const target = new URL(urlString);
  const candidates = [target.origin];
  const host = target.hostname;
  if (host.includes('.lightning.force.com')) {
    candidates.push(`${target.protocol}//${host.replace('.lightning.force.com', '.my.salesforce.com')}`);
  } else if (host.includes('.my.salesforce.com')) {
    candidates.push(`${target.protocol}//${host.replace('.my.salesforce.com', '.lightning.force.com')}`);
  }

  for (const origin of [...new Set(candidates)]) {
    try {
      const cookie = await chrome.cookies.get({ url: origin, name: 'sid' });
      if (cookie?.value) {
        return cookie.value;
      }
    } catch (_) {
      // continue to next candidate
    }
  }
  return null;
}

async function forwardToolingQueryToTab(url, preferredTabId = null) {
  if (Number.isInteger(preferredTabId)) {
    return sendToolingQueryToTab(preferredTabId, url);
  }

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (!tab || !Number.isInteger(tab.id)) {
    return { ok: false, error: 'No active tab' };
  }

  return sendToolingQueryToTab(tab.id, url);
}


async function sendToolingQueryToTab(tabId, url) {
  console.debug('[FieldLens] Forwarding tooling query to tab', tabId);

  // Helper: send message once
  async function _send() {
    try {
      const injected = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: async (targetUrl) => {
          try {
            const parsedUrl = new URL(targetUrl, window.location.origin);
            if (parsedUrl.origin !== window.location.origin) {
              return { ok: false, status: 0, error: `Cross-origin blocked in main-world fetch: ${parsedUrl.origin}` };
            }
            const res = await fetch(parsedUrl.toString(), {
              method: 'GET',
              credentials: 'include',
              headers: { Accept: 'application/json' }
            });
            const text = await res.text();
            const contentType = res.headers.get('content-type') || '';
            let json = null;
            try {
              json = JSON.parse(text);
            } catch (_) {
              json = null;
            }
            if (json !== null) {
              if (res.ok) {
                return { ok: true, status: res.status, data: json };
              }
              return {
                ok: false,
                status: res.status,
                statusText: res.statusText,
                body: json,
                contentType
              };
            }
            return {
              ok: false,
              status: res.status,
              statusText: res.statusText,
              body: text,
              contentType
            };
          } catch (error) {
            return { ok: false, status: 0, error: error?.message || 'Main-world fetch failed' };
          }
        },
        args: [url]
      });
      const first = Array.isArray(injected) && injected[0] ? injected[0].result : null;
      if (first) {
        return first;
      }
    } catch (_) {
      // fall through to content script messaging fallback
    }

    return await chrome.tabs.sendMessage(tabId, {
      type: 'FIELDLENS_TOOLING_QUERY',
      url
    });
  }

  // Helper: check if tab URL looks like Salesforce Lightning
  async function _isSalesforceLightningTab() {
    try {
      const tab = await chrome.tabs.get(tabId);
      const tabUrl = tab?.url || '';

      // Must be HTTPS + one of the allowed SF domains + Lightning path
      // (matches your content_scripts patterns)
      return (
        /^https:\/\/.+\.(salesforce\.com|my\.salesforce\.com|lightning\.force\.com)\/lightning\//.test(
          tabUrl
        )
      );
    } catch {
      return false;
    }
  }

  // Helper: try injecting content.js then retry once
  async function _injectContentScriptOnce() {
    // In MV3, executeScript requires "scripting" permission (you already have)
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
  }

  // 1) First attempt
  try {
    const response = await _send();
    if (response) return response;

    // No response is unusual but handle it.
    // Try injection if on SF Lightning.
    if (await _isSalesforceLightningTab()) {
      console.debug('[FieldLens] No response; attempting content.js injection + retry');
      await _injectContentScriptOnce();

      const response2 = await _send();
      if (response2) return response2;
    }

    return {
      ok: false,
      error: 'FieldLens content script not available. Open a Salesforce Lightning tab and refresh.'
    };
  } catch (error) {
    // 2) If sendMessage throws, attempt inject+retry only if on SF Lightning
    const isSf = await _isSalesforceLightningTab();

    if (isSf) {
      try {
        console.debug('[FieldLens] sendMessage failed; injecting content.js + retry', error?.message);
        await _injectContentScriptOnce();

        const response2 = await _send();
        if (response2) return response2;
      } catch (error2) {
        return {
          ok: false,
          error: 'FieldLens content script not available. Open a Salesforce Lightning tab and refresh.',
          detail: error2?.message || error?.message || null
        };
      }
    }

    return {
      ok: false,
      error: 'FieldLens can only run on Salesforce Lightning pages. Open a Lightning tab and try again.',
      detail: error?.message || null
    };
  }
}


async function getCached(key) {
  const store = await chrome.storage.local.get(key);
  const entry = store[key];
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const age = Date.now() - entry.cachedAt;
  if (age > CACHE_TTL_MS) {
    await chrome.storage.local.remove(key);
    return null;
  }

  return entry.payload;
}

async function setCached(key, payload) {
  await chrome.storage.local.set({
    [key]: {
      cachedAt: Date.now(),
      payload
    }
  });
}
