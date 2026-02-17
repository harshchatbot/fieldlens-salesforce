const API_VERSION = 'v60.0';
const CACHE_TTL_MS = 10 * 60 * 1000;

const inFlightScans = new Map();
const inFlightFieldLoads = new Map();

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

  return false;
});

async function handleScanImpact(message, tabId) {
  const { baseUrl, objectApiName, fieldApiName } = message;
  const scanMode = message.scanMode === 'deep' ? 'deep' : 'quick';
  const isDeep = scanMode === 'deep';
  if (!baseUrl || !objectApiName || !fieldApiName) {
    throw createError('INVALID_INPUT', 'Missing object or field context for scan.');
  }

  const scanKey = `scan:${new URL(baseUrl).hostname}:${objectApiName}:${fieldApiName}:${scanMode}`;
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

    const [classesRes, triggersRes, validationRes, flowsRes, flsRes] = await Promise.allSettled([
      runToolingQuery(baseUrl, apexClassSoql, tabId),
      runToolingQuery(baseUrl, apexTriggerSoql, tabId),
      runValidationRuleBestEffort(baseUrl, validationSoql, fieldApiName, tabId, isDeep),
      isDeep ? runFlowBestEffortQuery(baseUrl, escapedField, tabId) : Promise.resolve([]),
      runDataQuery(baseUrl, flsSoql, tabId)
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
        fieldPermissions: fieldPermissions.length
      },
      groups: {
        validationRules,
        apexClasses: classes,
        apexTriggers: triggers,
        flows,
        fieldPermissions
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

  const fieldKey = `fields:${new URL(baseUrl).hostname}:${objectApiName}`;
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
  // Flow tooling schema varies across org/API versions, so this is best-effort.
  const candidates = [
    `SELECT Id, MasterLabel, Status FROM Flow WHERE Definition LIKE '%${escapedField}%' ORDER BY LastModifiedDate DESC`,
    `SELECT Id, ApiName, Label, ProcessType FROM FlowDefinitionView WHERE Metadata LIKE '%${escapedField}%' ORDER BY LastModifiedDate DESC`
  ];

  let lastError;
  for (const soql of candidates) {
    try {
      return await runToolingQuery(baseUrl, soql, tabId);
    } catch (error) {
      lastError = error;
      if (isPermissionError(error)) {
        throw error;
      }
    }
  }

  if (lastError) {
    throw createError('FLOW_BEST_EFFORT_FAILED', 'Flow scan is unavailable in this org/API shape.');
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
  const debugTrail = [];
  const primary = await fetchInServiceWorker(url, baseUrl);
  if (primary.debug) {
    debugTrail.push(primary.debug);
  }
  const shouldTryTabFallback =
    Number.isInteger(tabId) &&
    ((primary.ok && primary.status === 401) ||
      (!primary.ok && (primary.errorCode === 'NOT_LOGGED_IN' || primary.errorCode === 'NETWORK_ERROR')));

  if (shouldTryTabFallback) {
    const proxy = await fetchViaTab(tabId, url);
    if (proxy.debug) {
      debugTrail.push(proxy.debug);
    }
    if (proxy.ok) {
      return {
        ...proxy,
        debug: { stage: 'resolved', path: 'tab_proxy', status: proxy.status, tabId, url, debugTrail }
      };
    }
    throw createError(proxy.errorCode || 'API_ERROR', proxy.errorMessage || 'Salesforce API request failed.', { debugTrail });
  }

  if (primary.ok) {
    return {
      ...primary,
      debug: { stage: 'resolved', path: 'service_worker', status: primary.status, url, debugTrail }
    };
  }

  throw createError(primary.errorCode || 'API_ERROR', primary.errorMessage || 'Salesforce API request failed.', { debugTrail });
}

async function fetchInServiceWorker(url) {
  try {
    const response = await fetch(url, buildFetchOptions());

    const contentType = response.headers.get('content-type') || '';
    const raw = await response.text();
    if (response.status === 401) {
      const retry = await fetchWithSessionBearer(url);
      if (retry) {
        return retry;
      }
    }

    if (!contentType.includes('application/json')) {
      return {
        ok: false,
        status: response.status,
        errorCode: 'NOT_LOGGED_IN',
        errorMessage: 'Unexpected non-JSON response from Salesforce. Session may be expired.',
        debug: { stage: 'service_worker_fetch', url, status: response.status, contentType: contentType || 'unknown', auth: 'cookie' }
      };
    }

    return {
      ok: true,
      status: response.status,
      data: safeJsonParse(raw),
      debug: { stage: 'service_worker_fetch', url, status: response.status, contentType, auth: 'cookie' }
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      errorCode: 'NETWORK_ERROR',
      errorMessage: error.message || 'Network error while contacting Salesforce.',
      debug: { stage: 'service_worker_fetch', url, status: 0, message: error.message || 'Network error', auth: 'cookie' }
    };
  }
}

function buildFetchOptions(extraHeaders = null) {
  const headers = { Accept: 'application/json' };
  if (extraHeaders && typeof extraHeaders === 'object') {
    Object.assign(headers, extraHeaders);
  }
  return {
    method: 'GET',
    credentials: 'include',
    headers
  };
}

async function fetchWithSessionBearer(url) {
  try {
    const sid = await getSidForUrl(url);
    if (!sid) {
      return null;
    }

    const response = await fetch(url, buildFetchOptions({ Authorization: `Bearer ${sid}` }));
    const contentType = response.headers.get('content-type') || '';
    const raw = await response.text();
    if (!contentType.includes('application/json')) {
      return {
        ok: false,
        status: response.status,
        errorCode: response.status === 401 ? 'NOT_LOGGED_IN' : 'API_ERROR',
        errorMessage: 'Non-JSON response from Salesforce using bearer session.',
        debug: { stage: 'service_worker_fetch', url, status: response.status, contentType: contentType || 'unknown', auth: 'bearer_sid' }
      };
    }

    return {
      ok: true,
      status: response.status,
      data: safeJsonParse(raw),
      debug: { stage: 'service_worker_fetch', url, status: response.status, contentType, auth: 'bearer_sid' }
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      errorCode: 'NETWORK_ERROR',
      errorMessage: error.message || 'Network error while contacting Salesforce with bearer session.',
      debug: { stage: 'service_worker_fetch', url, status: 0, message: error.message || 'Network error', auth: 'bearer_sid' }
    };
  }
}

async function getSidForUrl(urlString) {
  const url = new URL(urlString);
  const hosts = buildApiBaseCandidates(`${url.protocol}//${url.hostname}`).map((origin) => new URL(origin).hostname);

  for (const host of hosts) {
    try {
      const cookie = await chrome.cookies.get({ url: `${url.protocol}//${host}/`, name: 'sid' });
      if (cookie && cookie.value) {
        return cookie.value;
      }
    } catch (_) {
      // ignore and continue fallback hosts
    }
  }

  return null;
}

async function fetchViaTab(tabId, url) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'FIELDLENS_FETCH_JSON',
      url
    });

    if (response && response.ok) {
      return {
        ok: true,
        status: response.status,
        data: response.data,
        debug: { stage: 'tab_proxy_fetch', transport: 'content_script', url, tabId, status: response.status }
      };
    }

    const scriptFallback = await fetchViaMainWorld(tabId, url);
    if (scriptFallback.ok) {
      return {
        ok: true,
        status: scriptFallback.status,
        data: scriptFallback.data,
        debug: { stage: 'tab_proxy_fetch', transport: 'main_world', url, tabId, status: scriptFallback.status }
      };
    }

    return {
      ok: false,
      status: response?.status || scriptFallback.status || 0,
      errorCode: response?.error?.code || scriptFallback.errorCode || 'NOT_LOGGED_IN',
      errorMessage:
        response?.error?.message ||
        scriptFallback.errorMessage ||
        'Unable to proxy Salesforce request through tab context.',
      debug: {
        stage: 'tab_proxy_fetch',
        transport: 'content_script+main_world',
        url,
        tabId,
        status: response?.status || scriptFallback.status || 0,
        message:
          response?.error?.message ||
          scriptFallback.errorMessage ||
          'Proxy request failed'
      }
    };
  } catch (error) {
    const scriptFallback = await fetchViaMainWorld(tabId, url);
    if (scriptFallback.ok) {
      return {
        ok: true,
        status: scriptFallback.status,
        data: scriptFallback.data,
        debug: { stage: 'tab_proxy_fetch', transport: 'main_world', url, tabId, status: scriptFallback.status }
      };
    }

    return {
      ok: false,
      status: 0,
      errorCode: 'NOT_LOGGED_IN',
      errorMessage: scriptFallback.errorMessage || 'Unable to access tab session for Salesforce API request.',
      debug: {
        stage: 'tab_proxy_fetch',
        transport: 'main_world',
        url,
        tabId,
        status: scriptFallback.status || 0,
        message: scriptFallback.errorMessage || error.message || 'tabs.sendMessage failed'
      }
    };
  }
}

async function fetchViaMainWorld(tabId, url) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (requestUrl) => {
        try {
          const response = await fetch(requestUrl, {
            method: 'GET',
            credentials: 'include',
            headers: { Accept: 'application/json' }
          });
          const contentType = response.headers.get('content-type') || '';
          const raw = await response.text();
          return {
            ok: true,
            status: response.status,
            contentType,
            raw
          };
        } catch (error) {
          return {
            ok: false,
            status: 0,
            errorMessage: error?.message || 'MAIN world fetch failed'
          };
        }
      },
      args: [url]
    });

    const result = Array.isArray(results) ? results[0]?.result : null;
    if (!result || !result.ok) {
      return {
        ok: false,
        status: result?.status || 0,
        errorCode: 'PROXY_FETCH_FAILED',
        errorMessage: result?.errorMessage || 'MAIN world execution returned no result.'
      };
    }

    if (!String(result.contentType || '').includes('application/json')) {
      return {
        ok: false,
        status: result.status || 0,
        errorCode: 'PROXY_FETCH_FAILED',
        errorMessage: `MAIN world non-JSON response status=${result.status || 0} contentType=${result.contentType || 'unknown'}`
      };
    }

    return {
      ok: true,
      status: result.status,
      data: safeJsonParse(result.raw || '')
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      errorCode: 'PROXY_FETCH_FAILED',
      errorMessage: error?.message || 'MAIN world script execution failed'
    };
  }
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch (_) {
    return [];
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
