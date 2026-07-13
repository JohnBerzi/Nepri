let endpoints = [];
let inspecting = false;
let currentTabUrl = "";

document.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (tab && tab.url) {
    currentTabUrl = tab.url;
    try {
      const urlObj = new URL(tab.url);
      document.getElementById('currentDomainLabel').innerText = `Path: ${urlObj.pathname}${urlObj.search || ''}`;
    } catch (e) {
      document.getElementById('currentDomainLabel').innerText = `Path: Unavailable`;
    }
  }

  bindStaticActions();
  loadConfigurationData();
});

function bindStaticActions() {
  const addEndpointBtn = document.getElementById('addEndpointBtn');
  if (addEndpointBtn) {
    addEndpointBtn.addEventListener('click', () => {
      const input = document.getElementById('endpointInput');
      const value = (input.value || '').trim();

      clearStatus();

      if (!value) {
        showStatus('Enter a path or URL first.');
        return;
      }

      if (endpoints.includes(value)) {
        showStatus('This endpoint already exists.');
        return;
      }

      endpoints.push(value);
      input.value = '';

      chrome.storage.local.set({ endpoints }, () => {
        renderEndpoints();
        chrome.runtime.sendMessage({ type: 'UPDATE_ENDPOINTS', endpoints });
        loadConfigurationData();
        showStatus('Endpoint added.', false);
      });
    });
  }

  const inspectBtn = document.getElementById('inspectBtn') || document.getElementById('toggleInspectorBtn');
  if (inspectBtn) {
    inspectBtn.addEventListener('click', async () => {
      clearStatus();

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab || !tab.id || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('about:')) {
        showStatus('Cannot inspect internal browser or system tabs.');
        return;
      }

      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
      } catch (err) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js']
          });
          await new Promise(resolve => setTimeout(resolve, 120));
        } catch (injectErr) {
          showStatus('Failed to inject content script.');
          return;
        }
      }

      inspecting = !inspecting;
      updateInspectButtonState();

      chrome.tabs.sendMessage(
        tab.id,
        { type: 'TOGGLE_INSPECTOR', status: inspecting },
        () => {
          if (chrome.runtime.lastError) {
            inspecting = false;
            updateInspectButtonState();
            showStatus('Failed to toggle inspector.');
          }
        }
      );
    });
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'INSPECTOR_DONE') {
      inspecting = false;
      updateInspectButtonState();
      loadConfigurationData();
    }
  });

  const downloadCsvBtn = document.getElementById('downloadCsvBtn');
  if (downloadCsvBtn) {
    downloadCsvBtn.addEventListener('click', () => {
      clearStatus();

      chrome.storage.local.get(
        ['endpoints', 'inspectionRules', 'scrapedElements', 'columnNames'],
        (result) => {
          const registered = result.endpoints || [];
          const rules = result.inspectionRules || {};
          const elements = result.scrapedElements || [];
          const customHeaders = result.columnNames || {};

          if (registered.length === 0) {
            showStatus('No endpoints registered.');
            return;
          }

          let downloadedCount = 0;

          registered.forEach((endpoint) => {
            const endpointRules = rules[endpoint] || [];
            if (endpointRules.length === 0) return;

            const endpointElements = elements.filter(item => item.endpointOrigin === endpoint);
            if (endpointElements.length === 0) return;

            const rowsByCompositeKey = {};

            endpointElements.forEach((item) => {
              const ruleKey = item.baseSelector || item.selector;
              if (!endpointRules.includes(ruleKey)) return;

              const sourcePage = item.path || '';
              const itemIndex = Number(item.itemIndex || 1);
              const compositeKey = `${sourcePage}__ROW__${itemIndex}`;

              if (!rowsByCompositeKey[compositeKey]) {
                rowsByCompositeKey[compositeKey] = {
                  path: sourcePage,
                  itemIndex
                };
              }

              rowsByCompositeKey[compositeKey][ruleKey] = item.text || '';
            });

            const sortedRows = Object.values(rowsByCompositeKey).sort((a, b) => {
              const pathCompare = String(a.path).localeCompare(String(b.path));
              if (pathCompare !== 0) return pathCompare;
              return Number(a.itemIndex) - Number(b.itemIndex);
            });

            if (sortedRows.length === 0) return;

            const headers = endpointRules.map((rule, idx) => customHeaders[rule] || `Column ${idx + 1}`);
            let csvContent = '';
            csvContent += headers.map(csvEscape).join(',') + '\n';

            sortedRows.forEach((rowData) => {
              const row = endpointRules.map((rule) => rowData[rule] || '');
              csvContent += row.map(csvEscape).join(',') + '\n';
            });

            const fileBase = sanitizeFilePart(endpoint);
            downloadCsvFile(`${fileBase}.csv`, csvContent);
            downloadedCount++;
          });

          if (downloadedCount === 0) {
            showStatus('No CSV data found for any endpoint.');
            return;
          }

          showStatus(`Downloaded ${downloadedCount} endpoint CSV file(s).`, false);
        }
      );
    });
  }

  const resetBtn = document.getElementById('resetCapturedDataBtn');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      clearStatus();

      const confirmed = confirm(
        'Delete all previously captured data and start fresh? Rules, endpoints, and column names will be kept.'
      );

      if (!confirmed) return;

      chrome.storage.local.set(
        {
          scrapedElements: [],
          capturedRequests: []
        },
        () => {
          showStatus('Captured data reset. New CSV exports will start fresh.', false);
        }
      );
    });
  }

  const exportConfigBtn = document.getElementById('exportConfigBtn');
  if (exportConfigBtn) {
    exportConfigBtn.addEventListener('click', () => {
      clearStatus();

      chrome.storage.local.get(['endpoints', 'inspectionRules', 'columnNames'], (result) => {
        const configBundle = {
          endpoints: result.endpoints || [],
          inspectionRules: result.inspectionRules || {},
          columnNames: result.columnNames || {},
          version: '1.3.1',
          exportedAt: new Date().toISOString()
        };

        const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(configBundle, null, 2));
        const dlAnchor = document.createElement('a');
        dlAnchor.setAttribute('href', dataStr);
        dlAnchor.setAttribute('download', `scraper-shared-config-${Date.now()}.json`);
        document.body.appendChild(dlAnchor);
        dlAnchor.click();
        dlAnchor.remove();

        showStatus('Setup configuration downloaded!', false);
      });
    });
  }

  const importConfigBtn = document.getElementById('importConfigBtn');
  const importFile = document.getElementById('importFile') || document.getElementById('importConfigFile');

  if (importConfigBtn && importFile) {
    importConfigBtn.addEventListener('click', () => {
      importFile.click();
    });

    importFile.addEventListener('change', (event) => {
      clearStatus();

      const file = event.target.files[0];
      if (!file) return;

      const reader = new FileReader();

      reader.onload = (e) => {
        try {
          const importedData = JSON.parse(e.target.result);

          if (!importedData.endpoints || !importedData.inspectionRules) {
            showStatus('Invalid share file layout. Missing key mapping nodes.');
            return;
          }

          chrome.storage.local.get(['endpoints', 'inspectionRules', 'columnNames'], (currentData) => {
            const mergedEndpoints = Array.from(new Set([
              ...(currentData.endpoints || []),
              ...(importedData.endpoints || [])
            ]));

            const mergedRules = {
              ...(currentData.inspectionRules || {}),
              ...(importedData.inspectionRules || {})
            };

            const mergedNames = {
              ...(currentData.columnNames || {}),
              ...(importedData.columnNames || {})
            };

            chrome.storage.local.set(
              {
                endpoints: mergedEndpoints,
                inspectionRules: mergedRules,
                columnNames: mergedNames
              },
              () => {
                endpoints = mergedEndpoints;
                loadConfigurationData();
                chrome.runtime.sendMessage({ type: 'UPDATE_ENDPOINTS', endpoints: mergedEndpoints });
                showStatus('Configuration imported successfully!', false);
              }
            );
          });
        } catch (err) {
          showStatus('Failed to parse config document file structural layers.');
        }
      };

      reader.readAsText(file);
      event.target.value = '';
    });
  }
}

function loadConfigurationData() {
  chrome.storage.local.get(['endpoints', 'inspectionRules', 'columnNames'], (result) => {
    endpoints = result.endpoints || [];
    renderEndpoints();

    const matchedEndpoint = findMatchingEndpoint(currentTabUrl, endpoints);
    const pathRules = matchedEndpoint && result.inspectionRules
      ? (result.inspectionRules[matchedEndpoint] || [])
      : [];

    renderRules(pathRules, result.columnNames || {}, matchedEndpoint);
  });
}

function findMatchingEndpoint(currentUrl, registeredEndpoints) {
  if (!currentUrl) return null;

  return registeredEndpoints.find(endpoint => {
    let cleanEndpoint = endpoint.trim();

    if (!cleanEndpoint.startsWith('http://') && !cleanEndpoint.startsWith('https://')) {
      cleanEndpoint = window.location.protocol + '//' + cleanEndpoint;
    }

    try {
      const targetUrlObj = new URL(cleanEndpoint);
      const currentUrlObj = new URL(currentUrl);

      if (targetUrlObj.hostname !== currentUrlObj.hostname) return false;

      const targetPath = targetUrlObj.pathname.replace(/\/$/, '');
      const currentPath = currentUrlObj.pathname.replace(/\/$/, '');

      return currentPath === targetPath || currentPath.startsWith(targetPath + '/');
    } catch (e) {
      return currentUrl.includes(endpoint);
    }
  }) || null;
}

function showStatus(msg, isError = true) {
  const label = document.getElementById('statusNotification');
  if (!label) return;
  label.innerText = msg;
  label.style.color = isError ? "#dc3545" : "#28a745";
}

function clearStatus() {
  const label = document.getElementById('statusNotification');
  if (!label) return;
  label.innerText = "";
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function csvEscape(value) {
  return `"${String(value || '').replace(/"/g, '""')}"`;
}

function sanitizeFilePart(value) {
  return String(value || 'export')
    .replace(/^https?:\/\//i, '')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

function downloadCsvFile(filename, csvContent) {
  const encodedUri = encodeURI("data:text/csv;charset=utf-8," + csvContent);
  const link = document.createElement('a');
  link.setAttribute('href', encodedUri);
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function renderEndpoints() {
  const container = document.getElementById('endpointList');
  if (!container) return;

  if (endpoints.length === 0) {
    container.innerText = "No active endpoints.";
    return;
  }

  container.innerHTML = '';

  endpoints.forEach((ep, index) => {
    const row = document.createElement('div');
    row.className = 'item-row';
    row.style.flexDirection = 'row';
    row.style.justifyContent = 'space-between';
    row.style.alignItems = 'center';

    row.innerHTML = `
      <span style="width:85%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;font-weight:600;color:#132033;" title="${escapeHtml(ep)}">${escapeHtml(ep)}</span>
      <button class="delete-btn" data-index="${index}" type="button">Delete</button>
    `;

    row.querySelector('.delete-btn').addEventListener('click', (e) => {
      const idx = parseInt(e.target.getAttribute('data-index'), 10);
      const removedEndpoint = endpoints.splice(idx, 1)[0];

      chrome.storage.local.get(['inspectionRules'], (result) => {
        const allRules = result.inspectionRules || {};
        delete allRules[removedEndpoint];

        chrome.storage.local.set({ endpoints, inspectionRules: allRules }, () => {
          renderEndpoints();
          chrome.runtime.sendMessage({ type: 'UPDATE_ENDPOINTS', endpoints });
          loadConfigurationData();
        });
      });
    });

    container.appendChild(row);
  });
}

function renderRules(rules, savedNames, matchedEndpoint) {
  const container = document.getElementById('rulesList');
  if (!container) return;

  if (!matchedEndpoint || rules.length === 0) {
    container.innerText = "No structural targets mapped for this path layout.";
    return;
  }

  container.innerHTML = '';

  rules.forEach((rule, index) => {
    const defaultLabel = savedNames[rule] || `Column ${index + 1}`;
    const row = document.createElement('div');
    row.className = 'item-row';

    row.innerHTML = `
      <div class="row-controls" style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">
        <input
          type="text"
          class="column-name-input"
          data-rule="${escapeHtml(rule)}"
          value="${escapeHtml(defaultLabel)}"
          placeholder="Enter Column Name..."
          style="flex:1;padding:6px 8px;border:1px solid #cfd8e3;border-radius:6px;"
        />
        <button class="delete-btn" data-index="${index}" type="button">Delete</button>
      </div>
      <span class="item-text" title="${escapeHtml(rule)}" style="font-size:12px;color:#5b6677;word-break:break-all;">${escapeHtml(rule)}</span>
    `;

    const input = row.querySelector('.column-name-input');
    input.addEventListener('change', (e) => {
      const targetRule = e.target.getAttribute('data-rule');
      const val = e.target.value.trim();

      chrome.storage.local.get(['columnNames'], (res) => {
        const names = res.columnNames || {};
        names[targetRule] = val || `Column ${index + 1}`;

        chrome.storage.local.set({ columnNames: names }, () => {
          showStatus('Column name saved.', false);
        });
      });
    });

    input.addEventListener('blur', (e) => {
      const targetRule = e.target.getAttribute('data-rule');
      const val = e.target.value.trim();

      chrome.storage.local.get(['columnNames'], (res) => {
        const names = res.columnNames || {};
        names[targetRule] = val || `Column ${index + 1}`;

        chrome.storage.local.set({ columnNames: names }, () => {
          showStatus('Column name saved.', false);
        });
      });
    });

    row.querySelector('.delete-btn').addEventListener('click', (e) => {
      const idx = parseInt(e.target.getAttribute('data-index'), 10);

      chrome.storage.local.get(['inspectionRules', 'columnNames'], (result) => {
        const allRules = result.inspectionRules || {};
        const allNames = result.columnNames || {};

        if (allRules[matchedEndpoint]) {
          const removedRule = allRules[matchedEndpoint][idx];
          allRules[matchedEndpoint].splice(idx, 1);
          delete allNames[removedRule];
        }

        chrome.storage.local.set(
          {
            inspectionRules: allRules,
            columnNames: allNames
          },
          () => {
            renderRules(allRules[matchedEndpoint] || [], allNames, matchedEndpoint);
            showStatus('Rule removed.', false);
          }
        );
      });
    });

    container.appendChild(row);
  });
}

function updateInspectButtonState() {
  const btn = document.getElementById('inspectBtn') || document.getElementById('toggleInspectorBtn');
  if (!btn) return;

  if (inspecting) {
    btn.innerText = 'Click Target Element on Page...';
    btn.style.background = '#dc3545';
  } else {
    btn.innerText = 'Inspect Element';
    btn.style.background = '#28a745';
  }
}