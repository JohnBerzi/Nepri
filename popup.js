let endpoints = [];
let inspecting = false;
let currentTabUrl = '';

document.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (tab && tab.url) {
    currentTabUrl = tab.url;

    try {
      const urlObj = new URL(tab.url);
      const pathLabel = document.getElementById('currentDomainLabel');

      if (pathLabel) {
        pathLabel.innerText =
          `Path: ${urlObj.pathname}${urlObj.search || ''}`;
      }
    } catch (error) {
      const pathLabel = document.getElementById('currentDomainLabel');

      if (pathLabel) {
        pathLabel.innerText = 'Path: Unavailable';
      }
    }
  }

  bindStaticActions();
  loadConfigurationData();
});

function bindStaticActions() {
  bindAddEndpoint();
  bindInspector();
  bindCsvDownload();
  bindResetCapturedData();
  bindExportConfiguration();
  bindImportConfiguration();

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'INSPECTOR_DONE') {
      inspecting = false;
      updateInspectButtonState();
      loadConfigurationData();
    }
  });
}

function bindAddEndpoint() {
  const addEndpointBtn = document.getElementById('addEndpointBtn');
  const endpointInput = document.getElementById('endpointInput');

  if (!addEndpointBtn || !endpointInput) return;

  const addEndpoint = () => {
    clearStatus();

    const value = String(endpointInput.value || '').trim();

    if (!value) {
      showStatus('Enter a path or URL first.');
      return;
    }

    if (endpoints.includes(value)) {
      showStatus('This endpoint already exists.');
      return;
    }

    endpoints.push(value);
    endpointInput.value = '';

    chrome.storage.local.set({ endpoints }, () => {
      chrome.runtime.sendMessage({
        type: 'UPDATE_ENDPOINTS',
        endpoints
      });

      renderEndpoints();
      loadConfigurationData();

      showStatus('Endpoint added.', false);
    });
  };

  addEndpointBtn.addEventListener('click', addEndpoint);

  endpointInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;

    event.preventDefault();
    addEndpoint();
  });
}

function bindInspector() {
  const inspectBtn =
    document.getElementById('inspectBtn') ||
    document.getElementById('toggleInspectorBtn');

  if (!inspectBtn) return;

  inspectBtn.addEventListener('click', async () => {
    clearStatus();

    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });

    if (
      !tab ||
      !tab.id ||
      !tab.url ||
      tab.url.startsWith('chrome://') ||
      tab.url.startsWith('about:')
    ) {
      showStatus('Cannot inspect internal browser or system tabs.');
      return;
    }

    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'PING'
      });
    } catch (error) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js']
        });

        await new Promise((resolve) => setTimeout(resolve, 150));
      } catch (injectError) {
        showStatus(
          'Failed to inject content script. Reload the target page and try again.'
        );

        return;
      }
    }

    inspecting = !inspecting;
    updateInspectButtonState();

    chrome.tabs.sendMessage(
      tab.id,
      {
        type: 'TOGGLE_INSPECTOR',
        status: inspecting
      },
      () => {
        if (chrome.runtime.lastError) {
          inspecting = false;
          updateInspectButtonState();

          showStatus(
            'Failed to toggle inspector. Reload the ZoomInfo page and try again.'
          );
        }
      }
    );
  });
}

function bindCsvDownload() {
  const downloadCsvBtn = document.getElementById('downloadCsvBtn');

  if (!downloadCsvBtn) return;

  downloadCsvBtn.addEventListener('click', () => {
    clearStatus();

    chrome.storage.local.get(
      ['endpoints', 'inspectionRules', 'scrapedElements', 'columnNames'],
      (result) => {
        const registeredEndpoints = result.endpoints || [];
        const inspectionRules = result.inspectionRules || {};
        const scrapedElements = result.scrapedElements || [];
        const columnNames = result.columnNames || {};

        if (registeredEndpoints.length === 0) {
          showStatus('No endpoints registered.');
          return;
        }

        let downloadedCount = 0;
        let totalDuplicatesRemoved = 0;

        registeredEndpoints.forEach((endpoint) => {
          const endpointRules = inspectionRules[endpoint] || [];

          if (endpointRules.length === 0) return;

          const endpointElements = scrapedElements.filter(
            (item) => item.endpointOrigin === endpoint
          );

          if (endpointElements.length === 0) return;

          const csvRows = buildCsvRows(endpointRules, endpointElements);

          if (csvRows.length === 0) return;

          const headers = endpointRules.map(
            (rule, index) => columnNames[rule] || `Column ${index + 1}`
          );

          const csvResult = createDeduplicatedCsv(
            headers,
            endpointRules,
            csvRows
          );

          if (csvResult.rowCount === 0) return;

          const fileBase = sanitizeFilePart(endpoint);

          downloadCsvFile(
            `${fileBase}.csv`,
            csvResult.csvContent
          );

          downloadedCount++;
          totalDuplicatesRemoved += csvResult.duplicatesRemoved;
        });

        if (downloadedCount === 0) {
          showStatus('No CSV data found for any configured endpoint.');
          return;
        }

        const duplicateMessage =
          totalDuplicatesRemoved > 0
            ? ` Removed ${totalDuplicatesRemoved} duplicate row(s).`
            : ' No duplicate rows found.';

        showStatus(
          `Downloaded ${downloadedCount} CSV file(s).${duplicateMessage}`,
          false
        );
      }
    );
  });
}

function buildCsvRows(endpointRules, endpointElements) {
  const rowsByCompositeKey = new Map();
  const companyOnlyMode = endpointRules.length === 1;

  endpointElements.forEach((item) => {
    const ruleKey = item.baseSelector || item.selector;

    if (!endpointRules.includes(ruleKey)) return;

    const sourcePage = String(item.path || 'unknown-page');
    const itemIndex = Number(item.itemIndex || 1);
    const textKey = normalizeText(item.text).toLowerCase();
    const nodeIdentity = String(item.nodeIdentity || '')
      .trim()
      .toLowerCase();

    const compositeKey = companyOnlyMode
      ? `${sourcePage}__COMPANY__${nodeIdentity || textKey || itemIndex}`
      : `${sourcePage}__ROW__${itemIndex}`;

    if (!rowsByCompositeKey.has(compositeKey)) {
      rowsByCompositeKey.set(compositeKey, {
        path: sourcePage,
        itemIndex,
        values: {}
      });
    }

    const row = rowsByCompositeKey.get(compositeKey);
    const newValue = String(item.text || '').trim();
    const oldValue = String(row.values[ruleKey] || '').trim();

    if (!oldValue || newValue) {
      row.values[ruleKey] = newValue;
    }
  });

  return Array.from(rowsByCompositeKey.values()).sort((a, b) => {
    const pageComparison = String(a.path).localeCompare(String(b.path));

    if (pageComparison !== 0) {
      return pageComparison;
    }

    return Number(a.itemIndex) - Number(b.itemIndex);
  });
}

/*
 * This is the final CSV cleanup:
 * - Company-name-only mode: removes duplicate company names globally.
 * - Multiple columns: removes rows only when every cell is identical.
 * - Whitespace and letter case are ignored during duplicate comparison.
 */
function createDeduplicatedCsv(headers, endpointRules, rows) {
  const csvLines = [];
  const seenRows = new Set();
  const companyOnlyMode = endpointRules.length === 1;

  let duplicatesRemoved = 0;
  let rowCount = 0;

  csvLines.push(headers.map(csvEscape).join(','));

  rows.forEach((rowData) => {
    const values = endpointRules.map((rule) => {
      return String(rowData.values[rule] || '').trim();
    });

    const hasData = values.some((value) => value.length > 0);

    if (!hasData) {
      return;
    }

    let duplicateKey;

    if (companyOnlyMode) {
      duplicateKey = normalizeDuplicateValue(values[0]);
    } else {
      duplicateKey = values
        .map((value) => normalizeDuplicateValue(value))
        .join('\u001F');
    }

    if (!duplicateKey || seenRows.has(duplicateKey)) {
      duplicatesRemoved++;
      return;
    }

    seenRows.add(duplicateKey);
    csvLines.push(values.map(csvEscape).join(','));
    rowCount++;
  });

  return {
    csvContent: `${csvLines.join('\n')}\n`,
    rowCount,
    duplicatesRemoved
  };
}

function bindResetCapturedData() {
  const resetBtn = document.getElementById('resetCapturedDataBtn');

  if (!resetBtn) return;

  resetBtn.addEventListener('click', () => {
    clearStatus();

    const confirmed = confirm(
      'Delete all previously captured data and start fresh?\n\n' +
      'Rules, endpoints, and column names will be kept.'
    );

    if (!confirmed) return;

    chrome.storage.local.set(
      {
        scrapedElements: [],
        capturedRequests: []
      },
      () => {
        showStatus(
          'Captured data reset. New CSV exports will start fresh.',
          false
        );
      }
    );
  });
}

function bindExportConfiguration() {
  const exportConfigBtn = document.getElementById('exportConfigBtn');

  if (!exportConfigBtn) return;

  exportConfigBtn.addEventListener('click', () => {
    clearStatus();

    chrome.storage.local.get(
      ['endpoints', 'inspectionRules', 'columnNames'],
      (result) => {
        const configBundle = {
          endpoints: result.endpoints || [],
          inspectionRules: result.inspectionRules || {},
          columnNames: result.columnNames || {},
          version: '1.5.0',
          exportedAt: new Date().toISOString()
        };

        const json = JSON.stringify(configBundle, null, 2);

        downloadBlob(
          `scraper-shared-config-${Date.now()}.json`,
          new Blob([json], {
            type: 'application/json;charset=utf-8'
          })
        );

        showStatus('Setup configuration downloaded.', false);
      }
    );
  });
}

function bindImportConfiguration() {
  const importConfigBtn = document.getElementById('importConfigBtn');
  const importFile =
    document.getElementById('importFile') ||
    document.getElementById('importConfigFile');

  if (!importConfigBtn || !importFile) return;

  importConfigBtn.addEventListener('click', () => {
    importFile.click();
  });

  importFile.addEventListener('change', (event) => {
    clearStatus();

    const file = event.target.files?.[0];

    if (!file) return;

    const reader = new FileReader();

    reader.onload = (loadEvent) => {
      try {
        const importedData = JSON.parse(loadEvent.target.result);

        if (
          !Array.isArray(importedData.endpoints) ||
          typeof importedData.inspectionRules !== 'object' ||
          importedData.inspectionRules === null
        ) {
          showStatus('Invalid configuration file.');
          return;
        }

        chrome.storage.local.get(
          ['endpoints', 'inspectionRules', 'columnNames'],
          (currentData) => {
            const mergedEndpoints = Array.from(
              new Set([
                ...(currentData.endpoints || []),
                ...importedData.endpoints
              ])
            );

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

                chrome.runtime.sendMessage({
                  type: 'UPDATE_ENDPOINTS',
                  endpoints
                });

                loadConfigurationData();
                showStatus('Configuration imported successfully.', false);
              }
            );
          }
        );
      } catch (error) {
        showStatus('Failed to parse configuration JSON file.');
      } finally {
        event.target.value = '';
      }
    };

    reader.readAsText(file);
  });
}

function loadConfigurationData() {
  chrome.storage.local.get(
    ['endpoints', 'inspectionRules', 'columnNames'],
    (result) => {
      endpoints = result.endpoints || [];

      renderEndpoints();

      const matchedEndpoint = findMatchingEndpoint(
        currentTabUrl,
        endpoints
      );

      const rules = matchedEndpoint
        ? (result.inspectionRules?.[matchedEndpoint] || [])
        : [];

      renderRules(
        rules,
        result.columnNames || {},
        matchedEndpoint
      );
    }
  );
}

function findMatchingEndpoint(currentUrl, registeredEndpoints) {
  if (!currentUrl || !Array.isArray(registeredEndpoints)) {
    return null;
  }

  for (const endpoint of registeredEndpoints) {
    if (!endpoint) continue;

    const rawEndpoint = String(endpoint).trim();

    try {
      let normalizedEndpoint = rawEndpoint;

      if (!/^https?:\/\//i.test(normalizedEndpoint)) {
        normalizedEndpoint =
          `${new URL(currentUrl).protocol}//${normalizedEndpoint}`;
      }

      const endpointUrl = new URL(normalizedEndpoint);
      const activeUrl = new URL(currentUrl);

      if (endpointUrl.hostname !== activeUrl.hostname) {
        continue;
      }

      const endpointPath = endpointUrl.pathname.replace(/\/$/, '');
      const activePath = activeUrl.pathname.replace(/\/$/, '');

      if (
        activePath === endpointPath ||
        activePath.startsWith(`${endpointPath}/`)
      ) {
        return endpoint;
      }
    } catch (error) {
      if (currentUrl.includes(rawEndpoint)) {
        return endpoint;
      }
    }
  }

  return null;
}

function renderEndpoints() {
  const container = document.getElementById('endpointList');

  if (!container) return;

  if (endpoints.length === 0) {
    container.innerText = 'No active endpoints.';
    return;
  }

  container.innerHTML = '';

  endpoints.forEach((endpoint, index) => {
    const row = document.createElement('div');

    row.className = 'item-row';
    row.style.flexDirection = 'row';
    row.style.justifyContent = 'space-between';
    row.style.alignItems = 'center';

    const text = document.createElement('span');

    text.style.width = '85%';
    text.style.whiteSpace = 'nowrap';
    text.style.overflow = 'hidden';
    text.style.textOverflow = 'ellipsis';
    text.style.fontSize = '12px';
    text.style.fontWeight = '600';
    text.style.color = '#132033';
    text.title = endpoint;
    text.textContent = endpoint;

    const deleteButton = document.createElement('button');

    deleteButton.className = 'delete-btn';
    deleteButton.type = 'button';
    deleteButton.textContent = 'Delete';

    deleteButton.addEventListener('click', () => {
      const removedEndpoint = endpoints.splice(index, 1)[0];

      chrome.storage.local.get(
        ['inspectionRules', 'scrapedElements'],
        (result) => {
          const rules = result.inspectionRules || {};
          const elements = result.scrapedElements || [];

          delete rules[removedEndpoint];

          const remainingElements = elements.filter(
            (item) => item.endpointOrigin !== removedEndpoint
          );

          chrome.storage.local.set(
            {
              endpoints,
              inspectionRules: rules,
              scrapedElements: remainingElements
            },
            () => {
              chrome.runtime.sendMessage({
                type: 'UPDATE_ENDPOINTS',
                endpoints
              });

              renderEndpoints();
              loadConfigurationData();

              showStatus(
                'Endpoint and its captured data were removed.',
                false
              );
            }
          );
        }
      );
    });

    row.appendChild(text);
    row.appendChild(deleteButton);

    container.appendChild(row);
  });
}

function renderRules(rules, savedNames, matchedEndpoint) {
  const container = document.getElementById('rulesList');

  if (!container) return;

  if (!matchedEndpoint || rules.length === 0) {
    container.innerText =
      'No structural targets mapped for this path layout.';

    return;
  }

  container.innerHTML = '';

  rules.forEach((rule, index) => {
    const defaultName = savedNames[rule] || `Column ${index + 1}`;

    const row = document.createElement('div');
    row.className = 'item-row';

    const controls = document.createElement('div');

    controls.className = 'row-controls';
    controls.style.display = 'flex';
    controls.style.gap = '8px';
    controls.style.alignItems = 'center';
    controls.style.marginBottom = '6px';

    const nameInput = document.createElement('input');

    nameInput.type = 'text';
    nameInput.className = 'column-name-input';
    nameInput.value = defaultName;
    nameInput.placeholder = 'Enter column name';
    nameInput.style.flex = '1';
    nameInput.style.padding = '6px 8px';
    nameInput.style.border = '1px solid #cfd8e3';
    nameInput.style.borderRadius = '6px';

    const deleteButton = document.createElement('button');

    deleteButton.className = 'delete-btn';
    deleteButton.type = 'button';
    deleteButton.textContent = 'Delete';

    const selectorText = document.createElement('span');

    selectorText.className = 'item-text';
    selectorText.title = rule;
    selectorText.style.fontSize = '12px';
    selectorText.style.color = '#5b6677';
    selectorText.style.wordBreak = 'break-all';
    selectorText.textContent = rule;

    const saveColumnName = () => {
      const columnName =
        String(nameInput.value || '').trim() || `Column ${index + 1}`;

      chrome.storage.local.get(['columnNames'], (result) => {
        const names = result.columnNames || {};

        names[rule] = columnName;

        chrome.storage.local.set(
          {
            columnNames: names
          },
          () => {
            showStatus('Column name saved.', false);
          }
        );
      });
    };

    nameInput.addEventListener('change', saveColumnName);
    nameInput.addEventListener('blur', saveColumnName);

    deleteButton.addEventListener('click', () => {
      chrome.storage.local.get(
        ['inspectionRules', 'columnNames', 'scrapedElements'],
        (result) => {
          const allRules = result.inspectionRules || {};
          const allNames = result.columnNames || {};
          const allElements = result.scrapedElements || {};

          const endpointRules = allRules[matchedEndpoint] || [];
          const targetIndex = endpointRules.indexOf(rule);

          if (targetIndex >= 0) {
            endpointRules.splice(targetIndex, 1);
          }

          allRules[matchedEndpoint] = endpointRules;
          delete allNames[rule];

          const remainingElements = Array.isArray(allElements)
            ? allElements.filter((item) => {
              return !(
                item.endpointOrigin === matchedEndpoint &&
                (item.baseSelector || item.selector) === rule
              );
            })
            : [];

          chrome.storage.local.set(
            {
              inspectionRules: allRules,
              columnNames: allNames,
              scrapedElements: remainingElements
            },
            () => {
              renderRules(
                allRules[matchedEndpoint] || [],
                allNames,
                matchedEndpoint
              );

              showStatus(
                'Rule and its captured data were removed.',
                false
              );
            }
          );
        }
      );
    });

    controls.appendChild(nameInput);
    controls.appendChild(deleteButton);

    row.appendChild(controls);
    row.appendChild(selectorText);

    container.appendChild(row);
  });
}

function updateInspectButtonState() {
  const inspectBtn =
    document.getElementById('inspectBtn') ||
    document.getElementById('toggleInspectorBtn');

  if (!inspectBtn) return;

  if (inspecting) {
    inspectBtn.innerText = 'Stop Inspection';
    inspectBtn.style.background = '#dc3545';
  } else {
    inspectBtn.innerText = 'Start Inspection';
    inspectBtn.style.background = '#28a745';
  }
}

function showStatus(message, isError = true) {
  const label = document.getElementById('statusNotification');

  if (!label) return;

  label.innerText = message;
  label.style.color = isError ? '#dc3545' : '#28a745';
}

function clearStatus() {
  const label = document.getElementById('statusNotification');

  if (!label) return;

  label.innerText = '';
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeDuplicateValue(value) {
  return normalizeText(value).toLowerCase();
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
  const blob = new Blob(['\uFEFF', csvContent], {
    type: 'text/csv;charset=utf-8'
  });

  downloadBlob(filename, blob);
}

function downloadBlob(filename, blob) {
  const blobUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = blobUrl;
  link.download = filename;

  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => {
    URL.revokeObjectURL(blobUrl);
  }, 1000);
}