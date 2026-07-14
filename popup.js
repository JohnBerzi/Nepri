let endpoints = [];
let inspecting = false;
let currentTabUrl = '';

document.addEventListener('DOMContentLoaded', async () => {
  bindStaticActions();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const pathLabel = document.getElementById('currentDomainLabel');
  if (tab && tab.url) {
    currentTabUrl = tab.url;
    pathLabel.innerText = `Path: ${getVirtualPathFromUrl(tab.url)}`;
  } else {
    pathLabel.innerText = 'Path: Unavailable';
  }
  loadConfigurationData();
  refreshCapturedPreview();
});

function getVirtualPathFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const hash = String(url.hash || '');
    const cleanHash = hash.startsWith('#') ? hash.slice(1) : hash;
    return cleanHash ? `#${cleanHash}` : (url.pathname || '/');
  } catch (e) {
    return '/';
  }
}

function normalizeEndpointValue(endpoint) {
  let value = String(endpoint || '').trim();
  if (!value) return '';
  try {
    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value);
      value = url.hash || url.pathname || '/';
    }
  } catch (e) {}
  if (value.startsWith('/#/')) value = value.slice(1);
  return value;
}

function bindStaticActions() {
  const addEndpointBtn = document.getElementById('addEndpointBtn');
  const importBtn = document.getElementById('importBtn');
  const importFile = document.getElementById('importFile');
  const exportBtn = document.getElementById('exportBtn');
  const inspectBtn = document.getElementById('inspectBtn');
  const downloadCsvBtn = document.getElementById('downloadCsvBtn');
  const resetBtn = document.getElementById('resetCapturedDataBtn');

  addEndpointBtn && addEndpointBtn.addEventListener('click', () => {
    const input = document.getElementById('endpointInput');
    const value = (input.value || '').trim();
    clearStatus();
    if (!value) return showStatus('Enter a hash route or URL first. Example: #/apps/search/v2/results/company');
    if (endpoints.includes(value)) return showStatus('This endpoint already exists.');
    endpoints.push(value);
    input.value = '';
    chrome.storage.local.set({ endpoints }, () => {
      renderEndpoints();
      loadConfigurationData();
      showStatus('Endpoint added.', false);
    });
  });

  importBtn && importBtn.addEventListener('click', () => importFile.click());
  importFile && importFile.addEventListener('change', (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        chrome.storage.local.set({
          endpoints: data.endpoints || [],
          inspectionRules: data.inspectionRules || {},
          columnNames: data.columnNames || {},
          scrapedElements: data.scrapedElements || []
        }, () => {
          loadConfigurationData();
          refreshCapturedPreview();
          showStatus('Imported successfully.', false);
        });
      } catch (e) {
        showStatus('Import failed: invalid JSON.');
      }
    };
    reader.readAsText(file);
  });

  exportBtn && exportBtn.addEventListener('click', () => {
    chrome.storage.local.get(['endpoints', 'inspectionRules', 'columnNames', 'scrapedElements'], (res) => {
      const blob = new Blob([JSON.stringify(res, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'directory-scraper-export.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      showStatus('Exported JSON.', false);
    });
  });

  inspectBtn && inspectBtn.addEventListener('click', async () => {
    clearStatus();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id || !tab.url) return showStatus('No active tab found.');
    currentTabUrl = tab.url;
    document.getElementById('currentDomainLabel').innerText = `Path: ${getVirtualPathFromUrl(tab.url)}`;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
    } catch (err) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        await new Promise((r) => setTimeout(r, 150));
      } catch (injectErr) {
        return showStatus('Failed to inject content script.');
      }
    }
    inspecting = !inspecting;
    updateInspectButtonState();
    chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_INSPECTOR', status: inspecting }, () => {
      if (chrome.runtime.lastError) {
        inspecting = false;
        updateInspectButtonState();
        showStatus('Failed to toggle inspector.');
      }
    });
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'INSPECTOR_DONE') {
      inspecting = false;
      updateInspectButtonState();
      loadConfigurationData();
      refreshCapturedPreview();
      showStatus(`Inspection saved${message.insertedCount != null ? `: ${message.insertedCount} item(s)` : ''}.`, false);
    }
  });

  downloadCsvBtn && downloadCsvBtn.addEventListener('click', () => {
    clearStatus();
    chrome.storage.local.get(['endpoints', 'inspectionRules', 'scrapedElements', 'columnNames'], (result) => {
      const registered = result.endpoints || [];
      const rules = result.inspectionRules || {};
      const elements = result.scrapedElements || [];
      const customHeaders = result.columnNames || {};
      if (!registered.length) return showStatus('No endpoints registered.');
      let downloadedCount = 0;
      registered.forEach((endpoint) => {
        const endpointRules = rules[endpoint] || [];
        const endpointElements = elements.filter((item) => item.endpointOrigin === endpoint);
        if (!endpointRules.length || !endpointElements.length) return;
        const rows = {};
        endpointElements.forEach((item) => {
          const ruleKey = item.baseSelector || item.selector;
          if (!endpointRules.includes(ruleKey)) return;
          const rowKey = `${item.captureSessionKey || ''}__page-${item.pageNumber || '1'}__row-${item.itemIndex || 1}`;
          if (!rows[rowKey]) rows[rowKey] = { __searchFingerprint: item.searchFingerprint || '', __pageNumber: item.pageNumber || '1', __itemIndex: Number(item.itemIndex || 1) };
          rows[rowKey][ruleKey] = item.text || '';
        });
        const sortedRows = Object.values(rows).sort((a, b) => String(a.__searchFingerprint).localeCompare(String(b.__searchFingerprint)) || Number(a.__pageNumber) - Number(b.__pageNumber) || Number(a.__itemIndex) - Number(b.__itemIndex));
        if (!sortedRows.length) return;
        const headers = endpointRules.map((rule, idx) => customHeaders[rule] || `Column ${idx + 1}`);
        let csvContent = headers.map(csvEscape).join(',') + '\n';
        sortedRows.forEach((rowData) => {
          csvContent += endpointRules.map((rule) => csvEscape(rowData[rule] || '')).join(',') + '\n';
        });
        downloadCsvFile(`${sanitizeFilePart(endpoint)}.csv`, csvContent);
        downloadedCount += 1;
      });
      if (!downloadedCount) return showStatus('No CSV data found for any endpoint.');
      showStatus(`Downloaded ${downloadedCount} endpoint CSV file(s).`, false);
    });
  });

  resetBtn && resetBtn.addEventListener('click', () => {
    clearStatus();
    chrome.storage.local.set({ scrapedElements: [], capturedRequests: [] }, () => {
      showStatus('Captured data reset.', false);
      refreshCapturedPreview();
    });
  });
}

function loadConfigurationData() {
  chrome.storage.local.get(['endpoints', 'inspectionRules', 'columnNames'], (result) => {
    endpoints = result.endpoints || [];
    renderEndpoints();
    const matchedEndpoint = findMatchedEndpointForPopup(currentTabUrl, endpoints);
    const pathRules = matchedEndpoint && result.inspectionRules ? (result.inspectionRules[matchedEndpoint] || []) : [];
    renderRules(pathRules, result.columnNames || {}, matchedEndpoint);
  });
}

function findMatchedEndpointForPopup(currentUrl, registeredEndpoints) {
  const currentRoute = getVirtualPathFromUrl(currentUrl).split('?')[0].replace(/^\/#/, '#');
  return (registeredEndpoints || []).find((endpoint) => {
    const clean = normalizeEndpointValue(endpoint).split('?')[0];
    return clean && (currentRoute === clean || currentRoute.startsWith(clean) || clean.startsWith(currentRoute));
  }) || currentRoute;
}

function refreshCapturedPreview() {
  chrome.storage.local.get(['scrapedElements'], (result) => {
    const previewBox = document.getElementById('capturedPreview');
    if (!previewBox) return;
    const items = result.scrapedElements || [];
    if (!items.length) {
      previewBox.innerHTML = '<div class="muted">No captured items yet.</div>';
      return;
    }
    previewBox.innerHTML = items.slice(-8).reverse().map((item) => `<div style="padding:6px 0;border-bottom:1px solid #e6ebf2;"><div style="font-size:11px;color:#7b8794;">${escapeHtml(item.pageNumber || '')} • ${escapeHtml(item.endpointOrigin || '')}</div><div style="font-size:12px;color:#132033;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(item.text || '')}</div></div>`).join('');
  });
}

function showStatus(msg, isError = true) { const label = document.getElementById('statusNotification'); if (!label) return; label.innerText = msg; label.style.color = isError ? '#dc3545' : '#28a745'; }
function clearStatus() { const label = document.getElementById('statusNotification'); if (!label) return; label.innerText = ''; }
function escapeHtml(str) { return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;').replace(/'/g, '&#39;'); }
function csvEscape(value) { return `"${String(value || '').replace(/"/g, '""')}"`; }
function sanitizeFilePart(value) { return String(value || 'export').replace(/^https?:\/\//i, '').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120); }
function downloadCsvFile(filename, csvContent) { const encodedUri = encodeURI(`data:text/csv;charset=utf-8,${csvContent}`); const link = document.createElement('a'); link.setAttribute('href', encodedUri); link.setAttribute('download', filename); document.body.appendChild(link); link.click(); document.body.removeChild(link); }
function renderEndpoints() { const container = document.getElementById('endpointList'); if (!container) return; if (!endpoints.length) { container.innerText = 'No active endpoints.'; return; } container.innerHTML = ''; endpoints.forEach((ep, index) => { const row = document.createElement('div'); row.className = 'item-row'; row.style.flexDirection = 'row'; row.style.justifyContent = 'space-between'; row.style.alignItems = 'center'; row.innerHTML = `<span style="width:85%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;font-weight:600;color:#132033;" title="${escapeHtml(ep)}">${escapeHtml(ep)}</span><button class="delete-btn" data-index="${index}" type="button">Delete</button>`; row.querySelector('.delete-btn').addEventListener('click', (e) => { const idx = parseInt(e.target.getAttribute('data-index'), 10); const removedEndpoint = endpoints.splice(idx, 1)[0]; chrome.storage.local.get(['inspectionRules'], (result) => { const allRules = result.inspectionRules || {}; delete allRules[removedEndpoint]; chrome.storage.local.set({ endpoints, inspectionRules: allRules }, () => { renderEndpoints(); loadConfigurationData(); refreshCapturedPreview(); }); }); }); container.appendChild(row); }); }
function renderRules(rules, savedNames, matchedEndpoint) { const container = document.getElementById('rulesList'); if (!container) return; if (!matchedEndpoint || !rules.length) { container.innerText = 'No structural targets mapped for this hash route.'; return; } container.innerHTML = ''; rules.forEach((rule, index) => { const defaultLabel = savedNames[rule] || `Column ${index + 1}`; const row = document.createElement('div'); row.className = 'item-row'; row.innerHTML = `<div class="row-controls" style="display:flex;gap:8px;align-items:center;margin-bottom:6px;"><input type="text" class="column-name-input" data-rule="${escapeHtml(rule)}" value="${escapeHtml(defaultLabel)}" placeholder="Enter Column Name..." style="flex:1;padding:6px 8px;border:1px solid #cfd8e3;border-radius:6px;" /><button class="delete-btn" data-index="${index}" type="button">Delete</button></div><span class="item-text" title="${escapeHtml(rule)}" style="font-size:12px;color:#5b6677;word-break:break-all;">${escapeHtml(rule)}</span>`; const input = row.querySelector('.column-name-input'); ['change','blur'].forEach((eventName) => { input.addEventListener(eventName, (e) => { const targetRule = e.target.getAttribute('data-rule'); const val = e.target.value.trim(); chrome.storage.local.get(['columnNames'], (res) => { const names = res.columnNames || {}; names[targetRule] = val || `Column ${index + 1}`; chrome.storage.local.set({ columnNames: names }, () => showStatus('Column name saved.', false)); }); }); }); row.querySelector('.delete-btn').addEventListener('click', (e) => { const idx = parseInt(e.target.getAttribute('data-index'), 10); chrome.storage.local.get(['inspectionRules','columnNames'], (result) => { const allRules = result.inspectionRules || {}; const allNames = result.columnNames || {}; if (allRules[matchedEndpoint]) { const removedRule = allRules[matchedEndpoint][idx]; allRules[matchedEndpoint].splice(idx, 1); delete allNames[removedRule]; chrome.storage.local.set({ inspectionRules: allRules, columnNames: allNames }, () => { renderRules(allRules[matchedEndpoint] || [], allNames, matchedEndpoint); refreshCapturedPreview(); showStatus('Rule removed.', false); }); } }); }); container.appendChild(row); }); }
function updateInspectButtonState() { const btn = document.getElementById('inspectBtn'); if (!btn) return; btn.innerText = inspecting ? 'Click Target Element on Page...' : 'Inspect Element'; btn.style.background = inspecting ? '#dc3545' : '#28a745'; }
