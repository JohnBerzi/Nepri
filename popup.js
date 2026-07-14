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
    return hash || url.pathname || '/';
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
    if (!value) return showStatus('Enter a hash route or URL first.');
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
  importFile && importFile.addEventListener('change', event => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        chrome.storage.local.set({
          endpoints: Array.isArray(data.endpoints) ? data.endpoints : [],
          inspectionRules: data.inspectionRules && typeof data.inspectionRules === 'object' ? data.inspectionRules : {},
          columnNames: data.columnNames && typeof data.columnNames === 'object' ? data.columnNames : {}
        }, () => {
          loadConfigurationData();
          refreshCapturedPreview();
          showStatus('Configuration imported. Captured data was kept.', false);
        });
      } catch (e) {
        showStatus('Import failed: invalid JSON.');
      }
    };
    reader.readAsText(file);
    event.target.value = '';
  });

  exportBtn && exportBtn.addEventListener('click', () => {
    chrome.storage.local.get(['endpoints', 'inspectionRules', 'columnNames'], result => {
      const configuration = {
        endpoints: result.endpoints || [],
        inspectionRules: result.inspectionRules || {},
        columnNames: result.columnNames || {}
      };
      const blob = new Blob([JSON.stringify(configuration, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'directory-scraper-configuration.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showStatus('Configuration exported. Captured data was excluded.', false);
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
    } catch (e) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        await new Promise(resolve => setTimeout(resolve, 150));
      } catch (injectError) {
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

  chrome.runtime.onMessage.addListener(message => {
    if (message.type === 'INSPECTOR_DONE') {
      inspecting = false;
      updateInspectButtonState();
      loadConfigurationData();
      refreshCapturedPreview();
      showStatus(`Inspection saved: ${message.insertedCount || 0} item(s).`, false);
    }
  });

  downloadCsvBtn && downloadCsvBtn.addEventListener('click', () => {
    clearStatus();
    chrome.storage.local.get(['endpoints', 'inspectionRules', 'scrapedElements', 'columnNames'], result => {
      const registered = result.endpoints || [];
      const rules = result.inspectionRules || {};
      const elements = result.scrapedElements || [];
      const names = result.columnNames || {};
      if (!registered.length) return showStatus('No endpoints registered.');
      let downloaded = 0;
      registered.forEach(endpoint => {
        const endpointRules = rules[endpoint] || [];
        const endpointElements = elements.filter(item => item.endpointOrigin === endpoint);
        if (!endpointRules.length || !endpointElements.length) return;
        const rows = {};
        endpointElements.forEach(item => {
          const rule = item.baseSelector || item.selector;
          if (!endpointRules.includes(rule)) return;
          const key = `${item.captureSessionKey || ''}__page-${item.pageNumber || '1'}__row-${item.itemIndex || 1}`;
          rows[key] = rows[key] || { __search: item.searchFingerprint || '', __page: String(item.pageNumber || '1'), __row: Number(item.itemIndex || 1) };
          rows[key][rule] = item.text || '';
        });
        const records = Object.values(rows).sort((a, b) => String(a.__search).localeCompare(String(b.__search)) || String(a.__page).localeCompare(String(b.__page), undefined, { numeric: true }) || a.__row - b.__row);
        const uniqueRecords = [];
        const seenRowValues = new Set();
        records.forEach(record => {
          const duplicateKey = endpointRules.map(rule => normCsvValue(record[rule])).join('\u001f');
          if (!duplicateKey || seenRowValues.has(duplicateKey)) return;
          seenRowValues.add(duplicateKey);
          uniqueRecords.push(record);
        });
        if (!uniqueRecords.length) return;
        let csv = endpointRules.map((rule, index) => csvEscape(names[rule] || `Column ${index + 1}`)).join(',') + '\n';
        uniqueRecords.forEach(record => { csv += endpointRules.map(rule => csvEscape(record[rule] || '')).join(',') + '\n'; });
        downloadCsvFile(`${sanitizeFilePart(endpoint)}.csv`, csv);
        downloaded += 1;
      });
      showStatus(downloaded ? `Downloaded ${downloaded} endpoint CSV file(s).` : 'No CSV data found for any endpoint.', !downloaded);
    });
  });

  resetBtn && resetBtn.addEventListener('click', () => {
    clearStatus();
    chrome.storage.local.set({ scrapedElements: [], capturedRequests: [] }, () => {
      refreshCapturedPreview();
      showStatus('Captured data reset.', false);
    });
  });
}

function loadConfigurationData() {
  chrome.storage.local.get(['endpoints', 'inspectionRules', 'columnNames'], result => {
    endpoints = result.endpoints || [];
    renderEndpoints();
    const matched = findMatchedEndpointForPopup(currentTabUrl, endpoints);
    renderRules(matched ? ((result.inspectionRules || {})[matched] || []) : [], result.columnNames || {}, matched);
  });
}

function findMatchedEndpointForPopup(currentUrl, registeredEndpoints) {
  const route = getVirtualPathFromUrl(currentUrl).split('?')[0];
  return (registeredEndpoints || []).find(endpoint => {
    const clean = normalizeEndpointValue(endpoint).split('?')[0];
    return clean && (route === clean || route.startsWith(clean) || clean.startsWith(route));
  }) || '';
}

function refreshCapturedPreview() {
  chrome.storage.local.get(['scrapedElements'], result => {
    const box = document.getElementById('capturedPreview');
    const items = result.scrapedElements || [];
    if (!box) return;
    if (!items.length) {
      box.innerHTML = '<div class="muted">No captured items yet.</div>';
      return;
    }
    box.innerHTML = items.slice(-8).reverse().map(item => `<div style="padding:6px 0;border-bottom:1px solid #e6ebf2"><div style="font-size:11px;color:#7b8794">${escapeHtml(item.pageNumber)} — ${escapeHtml(item.endpointOrigin)}</div><div style="font-size:12px;color:#132033;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(item.text)}</div></div>`).join('');
  });
}

function renderEndpoints() {
  const container = document.getElementById('endpointList');
  if (!container) return;
  if (!endpoints.length) { container.innerText = 'No active endpoints.'; return; }
  container.innerHTML = '';
  endpoints.forEach((endpoint, index) => {
    const row = document.createElement('div');
    row.className = 'item-row';
    row.style.flexDirection = 'row';
    row.style.justifyContent = 'space-between';
    row.style.alignItems = 'center';
    row.innerHTML = `<span style="width:85%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;font-weight:600;color:#132033" title="${escapeHtml(endpoint)}">${escapeHtml(endpoint)}</span><button class="delete-btn" data-index="${index}" type="button">Delete</button>`;
    row.querySelector('.delete-btn').addEventListener('click', event => {
      const removed = endpoints.splice(Number(event.target.dataset.index), 1)[0];
      chrome.storage.local.get(['inspectionRules'], result => {
        const allRules = result.inspectionRules || {};
        delete allRules[removed];
        chrome.storage.local.set({ endpoints, inspectionRules: allRules }, () => { renderEndpoints(); loadConfigurationData(); });
      });
    });
    container.appendChild(row);
  });
}

function renderRules(rules, savedNames, matchedEndpoint) {
  const container = document.getElementById('rulesList');
  if (!container) return;
  if (!matchedEndpoint || !rules.length) { container.innerText = 'No structural targets mapped for this hash route.'; return; }
  container.innerHTML = '';
  rules.forEach((rule, index) => {
    const row = document.createElement('div');
    row.className = 'item-row';
    const label = savedNames[rule] || `Column ${index + 1}`;
    row.innerHTML = `<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px"><input type="text" class="column-name-input" data-rule="${escapeHtml(rule)}" value="${escapeHtml(label)}" placeholder="Enter Column Name..." style="flex:1;padding:6px 8px;border:1px solid #cfd8e3;border-radius:6px"><button class="delete-btn" data-index="${index}" type="button">Delete</button></div><span title="${escapeHtml(rule)}" style="font-size:12px;color:#5b6677;word-break:break-all">${escapeHtml(rule)}</span>`;
    const input = row.querySelector('.column-name-input');
    ['change', 'blur'].forEach(eventName => input.addEventListener(eventName, event => {
      chrome.storage.local.get(['columnNames'], result => {
        const columnNames = result.columnNames || {};
        columnNames[rule] = event.target.value.trim() || `Column ${index + 1}`;
        chrome.storage.local.set({ columnNames }, () => showStatus('Column name saved.', false));
      });
    }));
    row.querySelector('.delete-btn').addEventListener('click', event => {
      chrome.storage.local.get(['inspectionRules', 'columnNames'], result => {
        const allRules = result.inspectionRules || {};
        const allNames = result.columnNames || {};
        const removedRule = (allRules[matchedEndpoint] || []).splice(Number(event.target.dataset.index), 1)[0];
        delete allNames[removedRule];
        chrome.storage.local.set({ inspectionRules: allRules, columnNames: allNames }, () => { loadConfigurationData(); showStatus('Rule removed.', false); });
      });
    });
    container.appendChild(row);
  });
}

function updateInspectButtonState() {
  const button = document.getElementById('inspectBtn');
  if (!button) return;
  button.innerText = inspecting ? 'Click Target Element on Page...' : 'Inspect Element';
  button.style.background = inspecting ? '#dc3545' : '#28a745';
}

function showStatus(message, isError = true) {
  const label = document.getElementById('statusNotification');
  if (!label) return;
  label.innerText = message;
  label.style.color = isError ? '#dc3545' : '#28a745';
}

function clearStatus() {
  const label = document.getElementById('statusNotification');
  if (label) label.innerText = '';
}

function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function normCsvValue(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function csvEscape(value) {
  return `"${String(value || '').replace(/"/g, '""')}"`;
}

function sanitizeFilePart(value) {
  return String(value || 'export').replace(/^https?:\/\//i, '').replace(/[\\/:*?"<>|#]+/g, '-').replace(/-+/g, '-').slice(0, 120);
}

function downloadCsvFile(filename, csv) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
