if (typeof window.__scraperV5Injected === 'undefined') {
  window.__scraperV5Injected = true;

  let isInspecting = false;
  let hoveredElement = null;
  let highlightOverlay = null;
  let multiHighlightOverlays = [];
  let layoutMutationObserver = null;
  let visualIndicatorBadge = null;
  let modeStatusFloatingBadge = null;
  let selectorTuningBar = null;
  let selectorTuningValueLabel = null;
  let selectorTuningPreviewLabel = null;
  let selectorTuningCountLabel = null;
  let selectorTuningInput = null;
  let currentActiveSelector = '';
  let currentResolvedNodes = [];
  let currentSelectorCandidates = [];
  let currentSelectorCandidateIndex = 0;
  let isWritingBatch = false;
  let lastResultSignature = '';
  let refreshTimer = null;

  function safeSendMessage(message, callback) {
    if (!chrome.runtime || !chrome.runtime.id) return;
    try {
      chrome.runtime.sendMessage(message, callback);
    } catch (e) {
      console.warn("Extension context invalidated. Please refresh the page.");
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
      if (message.type === 'PING') {
        sendResponse({ status: 'ALIVE' });
        return true;
      }
      if (message.type === 'TOGGLE_INSPECTOR') {
        isInspecting = !!message.status;
        if (isInspecting) startInspector(); else stopInspector();
        sendResponse({ success: true });
        return true;
      }
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
    return false;
  });

  const norm = value => String(value || '').replace(/\s+/g, ' ').trim();

  // UNIVERSAL: Parses any URL hash state dynamically
  function parseHashRoute() {
    const rawHash = String(window.location.hash || '');
    const withoutHash = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash;
    const [routePath, queryString = ''] = withoutHash.split('?');
    return { routePath: routePath || '/', params: new URLSearchParams(queryString), queryString };
  }

  // UNIVERSAL: Works with standard paths and single-page application hash paths
  function getVirtualPath() {
    const { routePath, queryString } = parseHashRoute();
    const cleanPath = window.location.pathname;
    return `${cleanPath}#${routePath}${queryString ? `?${queryString}` : ''}`;
  }

  // UNIVERSAL: Extracts any unique page/profile/record identifier present in the URL query params or path
  function getUniversalPageIdentity() {
    const { routePath, params } = parseHashRoute();
    const searchParams = new URLSearchParams(window.location.search);

    // 1. Look for common dynamic unique entity IDs in queries (e.g., ?id=123, ?contactId=abc, ?userId=xyz)
    const commonIdKeys = ['id', 'contactid', 'personid', 'userid', 'recid', 'profileid', 'p'];
    for (const key of commonIdKeys) {
      const val = params.get(key) || searchParams.get(key);
      if (val) return `entity-${val}`;
    }

    // 2. Look for numeric or hash-like segments inside the path (e.g., /person/2481055131/contact-profile)
    const combinedPath = `${window.location.pathname}/${routePath}`.replace(/\/+/g, '/');
    const segments = combinedPath.split('/').filter(Boolean);
    
    // Iterate backwards to find the first segment that looks like a database ID (all digits, or long hash)
    for (let i = segments.length - 1; i >= 0; i--) {
      const segment = segments[i];
      if (/^\d+$/.test(segment) || (segment.length > 8 && /[0-9].*[a-zA-Z]|[a-zA-Z].*[0-9]/.test(segment))) {
        return `path-${segment}`;
      }
    }
    return '';
  }

  function getPageNumber() {
    // If we are viewing a specific profile/entity, the "Page Number" is the entity's ID itself.
    // This guarantees that separate profiles never share a page container key and overwrite each other.
    const pageId = getUniversalPageIdentity();
    if (pageId) return pageId;

    const { params } = parseHashRoute();
    const searchParams = new URLSearchParams(window.location.search);
    return String(params.get('page') || searchParams.get('page') || '1');
  }

  function getSearchFingerprint() {
    const pageId = getUniversalPageIdentity();
    // If it's a dedicated entity page, make sure the fingerprint is completely tied to this specific entity
    if (pageId) return `#dynamic-view__${pageId}`;
    
    const { routePath, params } = parseHashRoute();
    const pairs = [];
    params.forEach((value, key) => { if (key !== 'page') pairs.push([key, value]); });
    const searchParams = new URLSearchParams(window.location.search);
    searchParams.forEach((value, key) => { if (key !== 'page') pairs.push([key, value]); });

    pairs.sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])));
    const query = pairs.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
    return `${window.location.pathname}#${routePath}${query ? `?${query}` : ''}`;
  }

  function getCaptureSessionKey() {
    return `${window.location.hostname}__${getSearchFingerprint()}`;
  }

  function extractNodeText(node) {
    if (!node) return '';
    let text = node.innerText || node.textContent || node.value || '';
    if (!text && node.placeholder) text = node.placeholder;
    return norm(text);
  }

  // UNIVERSAL: Creates a unique signature snapshot based on the actual text content visible in the DOM
  function getResultSignature() {
    const preferredSelectors = ['table tbody tr', '[role="row"]', 'tr', 'li', 'h1', 'h2', 'main'];
    for (const selector of preferredSelectors) {
      const values = Array.from(document.querySelectorAll(selector))
        .filter(node => node.getBoundingClientRect && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0)
        .map(extractNodeText)
        .filter(Boolean)
        .slice(0, 30);
      if (values.length >= 1) return values.join('\n').slice(0, 8000);
    }
    return (document.body?.innerText || '').slice(0, 4000);
  }

  function getEffectivePageKey() {
    const pageId = getUniversalPageIdentity();
    if (pageId) {
      return pageId;
    }
    const signature = getResultSignature();
    return signature ? `${getPageNumber()}-${hashString(signature)}` : getPageNumber();
  }

  function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function normalizeEndpointValue(endpoint) {
    let value = String(endpoint || '').trim().toLowerCase();
    if (!value) return '';
    value = value.replace(/^https?:\/\/[^\/]+/i, '');
    value = value.replace(/^[\/#\s]+/, '');
    return value.split('?')[0];
  }

  // UNIVERSAL: Matches any configured endpoint route agnostically
  function findMatchingEndpoint(endpoints) {
    const currentRoute = normalizeEndpointValue(getVirtualPath());
    const currentFullUrl = normalizeEndpointValue(window.location.href);

    return (endpoints || []).find(endpoint => {
      const cleanSavedEndpoint = normalizeEndpointValue(endpoint);
      if (!cleanSavedEndpoint) return false;
      return (
        currentRoute.includes(cleanSavedEndpoint) || 
        currentFullUrl.includes(cleanSavedEndpoint) ||
        cleanSavedEndpoint.includes(currentRoute)
      );
    }) || '';
  }

  function getUsableClasses(element) {
    if (!element || !element.classList) return [];
    return Array.from(element.classList).filter(name => typeof name === 'string' && name.length < 45 && name !== 'extension-multi-inspect-overlay-item' && !/[0-9a-fA-F]{8,}/.test(name));
  }

  function buildSimpleSelector(element) {
    if (!element || !element.tagName) return '';
    const tag = element.tagName.toLowerCase();
    const classes = getUsableClasses(element);
    return tag + (classes.length ? `.${classes.slice(0, 2).map(CSS.escape).join('.')}` : '');
  }

  function buildExactSelector(element) {
    if (!element) return '';
    if (element === document.body) return 'body';
    if (element === document.documentElement) return 'html';
    const token = buildSimpleSelector(element);
    if (!token) return '';
    if (!element.parentElement || element.parentElement === document.body || element.parentElement === document.documentElement) return `body > ${token}`;
    let index = 1;
    let sibling = element.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === element.tagName) index += 1;
      sibling = sibling.previousElementSibling;
    }
    return `${buildExactSelector(element.parentElement)} > ${token}:nth-of-type(${index})`;
  }

  function getCellColumnIndex(element) {
    const cell = element && element.closest ? element.closest('td,th') : null;
    return cell && cell.parentElement ? Array.from(cell.parentElement.children).indexOf(cell) : -1;
  }

  function getTableColumnSelector(element) {
    const index = getCellColumnIndex(element);
    const table = element && element.closest ? element.closest('table') : null;
    const tableSelector = buildSimpleSelector(table);
    return index >= 0 && tableSelector ? `${tableSelector} tbody tr > *:nth-child(${index + 1})` : '';
  }

  function getNodesForSelector(selector, fallback) {
    try {
      const nodes = Array.from(document.querySelectorAll(selector)).filter(node => node.getBoundingClientRect && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0);
      return nodes.length ? nodes : (fallback ? [fallback] : []);
    } catch (e) {
      return fallback ? [fallback] : [];
    }
  }

  function buildSelectorCandidates(element) {
    if (!element) return [];
    const candidates = [];
    const add = (selector, label) => {
      if (!selector || candidates.some(item => item.selector === selector)) return;
      const nodes = getNodesForSelector(selector, element);
      if (nodes.length) candidates.push({ selector, label, nodes, matchCount: nodes.length });
    };
    add(getTableColumnSelector(element), 'Table column');
    if (element.id) add(`#${CSS.escape(element.id)}`, 'Unique id');
    add(buildExactSelector(element), 'Exact element');
    add(buildSimpleSelector(element), 'Simple element');
    const parent = element.parentElement;
    if (parent) add(buildSimpleSelector(parent), 'Parent container');
    add(element.tagName ? element.tagName.toLowerCase() : '', 'Tag');
    return candidates.sort((a, b) => a.matchCount - b.matchCount || a.selector.length - b.selector.length);
  }

  function createOverlay() {
    if (highlightOverlay) return;
    highlightOverlay = document.createElement('div');
    Object.assign(highlightOverlay.style, { position: 'absolute', backgroundColor: 'rgba(0,123,255,0.18)', border: '2px solid #007bff', pointerEvents: 'none', zIndex: '2147483647' });
    document.body.appendChild(highlightOverlay);
  }

  function clearMultiOverlays() {
    multiHighlightOverlays.forEach(node => node && node.remove());
    multiHighlightOverlays = [];
  }

  function drawMultiModePreview() {
    clearMultiOverlays();
    if (!currentResolvedNodes || currentResolvedNodes.length <= 1) return;
    currentResolvedNodes.slice(1).forEach(node => {
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const overlay = document.createElement('div');
      Object.assign(overlay.style, { position: 'absolute', backgroundColor: 'rgba(233,30,99,0.16)', border: '1px dashed #e91e63', pointerEvents: 'none', zIndex: '2147483646', width: `${rect.width}px`, height: `${rect.height}px`, top: `${rect.top + window.scrollY}px`, left: `${rect.left + window.scrollX}px` });
      document.body.appendChild(overlay);
      multiHighlightOverlays.push(overlay);
    });
  }

  function createInspectorUi() {
    if (!modeStatusFloatingBadge) {
      modeStatusFloatingBadge = document.createElement('div');
      modeStatusFloatingBadge.textContent = 'Inspect Mode | use arrows to tune selector';
      Object.assign(modeStatusFloatingBadge.style, { position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)', padding: '10px 16px', borderRadius: '8px', font: 'bold 14px Arial,sans-serif', zIndex: '2147483647', background: '#212121', color: '#fff', pointerEvents: 'none' });
      document.body.appendChild(modeStatusFloatingBadge);
    }
    if (!selectorTuningBar) {
      selectorTuningBar = document.createElement('div');
      selectorTuningBar.style.cssText = 'position:fixed;top:58px;left:50%;transform:translateX(-50%);width:min(860px,calc(100vw - 32px));padding:12px 14px;border-radius:12px;background:rgba(20,20,28,.96);color:#fff;font:12px Arial,sans-serif;z-index:2147483647;box-shadow:0 10px 30px rgba(0,0,0,.32)';
      selectorTuningBar.innerHTML = '<div style="display:flex;justify-content:space-between"><b>Selector Precision</b><b id="extension-selector-tuning-value">Waiting for hover...</b></div><div style="display:flex;gap:10px;align-items:center;margin-top:8px"><span>Precise</span><input id="extension-selector-tuning-range" type="range" min="0" max="0" value="0" style="flex:1"><span>Broad</span></div><div id="extension-selector-tuning-count" style="margin-top:8px;color:#c3e88d">Matches 0</div><div id="extension-selector-tuning-preview" style="margin-top:6px;max-height:72px;overflow:auto;padding:8px 10px;border-radius:8px;background:rgba(255,255,255,.06);font-family:monospace;word-break:break-word"></div>';
      document.body.appendChild(selectorTuningBar);
      selectorTuningValueLabel = selectorTuningBar.querySelector('#extension-selector-tuning-value');
      selectorTuningCountLabel = selectorTuningBar.querySelector('#extension-selector-tuning-count');
      selectorTuningPreviewLabel = selectorTuningBar.querySelector('#extension-selector-tuning-preview');
      selectorTuningInput = selectorTuningBar.querySelector('#extension-selector-tuning-range');
      selectorTuningInput.addEventListener('input', () => {
        currentSelectorCandidateIndex = Number(selectorTuningInput.value || 0);
        applyCurrentSelectorCandidate();
      });
    }
  }

  function updateSelectorTuningBar() {
    if (!selectorTuningInput) return;
    const candidate = currentSelectorCandidates[currentSelectorCandidateIndex];
    selectorTuningInput.max = String(Math.max(0, currentSelectorCandidates.length - 1));
    selectorTuningInput.value = String(currentSelectorCandidateIndex);
    if (!candidate) {
      selectorTuningValueLabel.textContent = 'Waiting for hover...';
      selectorTuningCountLabel.textContent = 'Matches 0';
      selectorTuningPreviewLabel.textContent = '';
      return;
    }
    selectorTuningValueLabel.textContent = `${currentSelectorCandidateIndex + 1}/${currentSelectorCandidates.length} ${candidate.label}`;
    selectorTuningCountLabel.textContent = `Matches ${candidate.matchCount}`;
    selectorTuningPreviewLabel.textContent = candidate.selector;
  }

  function applyCurrentSelectorCandidate() {
    const candidate = currentSelectorCandidates[currentSelectorCandidateIndex];
    currentActiveSelector = candidate ? candidate.selector : '';
    currentResolvedNodes = candidate ? candidate.nodes : (hoveredElement ? [hoveredElement] : []);
    updateSelectorTuningBar();
    drawMultiModePreview();
  }

  function startInspector() {
    currentActiveSelector = '';
    currentResolvedNodes = [];
    currentSelectorCandidates = [];
    currentSelectorCandidateIndex = 0;
    createOverlay();
    createInspectorUi();
    document.body.style.cursor = 'crosshair';
    document.addEventListener('mousemove', handleMouseMove, true);
    document.addEventListener('click', handleElementClick, true);
    document.addEventListener('keydown', handleKeyDown, true);
  }

  function stopInspector() {
    isInspecting = false;
    document.body.style.cursor = 'default';
    document.removeEventListener('mousemove', handleMouseMove, true);
    document.removeEventListener('click', handleElementClick, true);
    document.removeEventListener('keydown', handleKeyDown, true);
    if (highlightOverlay) highlightOverlay.remove();
    if (modeStatusFloatingBadge) modeStatusFloatingBadge.remove();
    if (selectorTuningBar) selectorTuningBar.remove();
    highlightOverlay = null;
    modeStatusFloatingBadge = null;
    selectorTuningBar = null;
    selectorTuningInput = null;
    clearMultiOverlays();
  }

  function handleMouseMove(event) {
    if (!isInspecting) return;
    event.stopPropagation();
    const element = event.target;
    if (!element || element === document.body || element === document.documentElement) return;
    hoveredElement = element;
    const rect = element.getBoundingClientRect();
    Object.assign(highlightOverlay.style, { width: `${rect.width}px`, height: `${rect.height}px`, top: `${rect.top + window.scrollY}px`, left: `${rect.left + window.scrollX}px` });
    currentSelectorCandidates = buildSelectorCandidates(element);
    currentSelectorCandidateIndex = 0;
    applyCurrentSelectorCandidate();
  }

  function handleKeyDown(event) {
    if (!isInspecting || !currentSelectorCandidates.length) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault(); event.stopPropagation();
      currentSelectorCandidateIndex = Math.max(0, currentSelectorCandidateIndex - 1);
      applyCurrentSelectorCandidate();
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault(); event.stopPropagation();
      currentSelectorCandidateIndex = Math.min(currentSelectorCandidates.length - 1, currentSelectorCandidateIndex + 1);
      applyCurrentSelectorCandidate();
    }
  }

  function buildEntry(item) {
    return `${item.captureSessionKey}|${item.pageNumber}|${item.baseSelector}|${item.itemIndex}|${item.text}`;
  }

  function saveElements(elements, callback) {
    if (!chrome.runtime || !chrome.runtime.id) return;
    chrome.storage.local.set({ scrapedElements: elements }, () => callback && callback(!chrome.runtime.lastError));
  }

  function setStatus(success, title, detail, list = []) {
    if (!visualIndicatorBadge) {
      visualIndicatorBadge = document.createElement('div');
      Object.assign(visualIndicatorBadge.style, { position: 'fixed', bottom: '16px', right: '16px', minWidth: '270px', maxWidth: '420px', padding: '12px 14px', borderRadius: '14px', font: '12px Arial,sans-serif', lineHeight: '1.45', boxShadow: '0 8px 24px rgba(0,0,0,.18)', zIndex: '2147483647' });
      document.body.appendChild(visualIndicatorBadge);
    }
    visualIndicatorBadge.style.background = success ? '#e6f4ea' : '#fce8e6';
    visualIndicatorBadge.style.color = success ? '#137333' : '#c5221f';
    visualIndicatorBadge.style.border = `1px solid ${success ? '#137333' : '#c5221f'}`;
    visualIndicatorBadge.textContent = `${title}: ${detail}${list.length ? ` (${list.slice(0, 6).join(', ')})` : ''}`;
  }

  function captureSelectorNodes(selector, nodes, endpoint, rules, elements) {
    let insertedCount = 0;
    const pageNumber = getEffectivePageKey();
    
    // If no nodes are provided or nodes array is empty, inject an empty placeholder to keep CSV rows aligned
    if (!nodes || nodes.length === 0) {
      const item = {
        text: '',
        selector: `${selector}::1`,
        baseSelector: selector,
        itemIndex: 1,
        endpointOrigin: endpoint,
        domain: window.location.hostname,
        path: getVirtualPath(),
        searchFingerprint: getSearchFingerprint(),
        captureSessionKey: getCaptureSessionKey(),
        pageNumber,
        timestamp: new Date().toISOString()
      };
      item.entryKey = buildEntry(item);
      const isDuplicate = elements.some(existing => existing.entryKey === item.entryKey);
      if (!isDuplicate) {
        elements.push(item);
        insertedCount += 1;
      }
      return insertedCount;
    }

    nodes.forEach((node, index) => {
      const text = extractNodeText(node);
      const item = {
        text, // Saves empty string if text extraction returns falsy, keeping dataset aligned
        selector: `${selector}::${index + 1}`,
        baseSelector: selector,
        itemIndex: index + 1,
        endpointOrigin: endpoint,
        domain: window.location.hostname,
        path: getVirtualPath(),
        searchFingerprint: getSearchFingerprint(),
        captureSessionKey: getCaptureSessionKey(),
        pageNumber,
        timestamp: new Date().toISOString()
      };
      
      item.entryKey = buildEntry(item);
      const isDuplicate = elements.some(existing => existing.entryKey === item.entryKey);
      if (!isDuplicate) {
        elements.push(item);
        insertedCount += 1;
      }
    });
    return insertedCount;
  }

  function handleElementClick(event) {
    if (!isInspecting || isWritingBatch || !chrome.runtime?.id) return;
    event.preventDefault();
    event.stopPropagation();
    isWritingBatch = true;
    const selector = currentActiveSelector || buildExactSelector(hoveredElement);
    const nodes = currentResolvedNodes.length ? currentResolvedNodes : (hoveredElement ? [hoveredElement] : []);
    chrome.storage.local.get(['endpoints', 'inspectionRules', 'scrapedElements'], result => {
      if (!chrome.runtime?.id) return;
      const endpoints = result.endpoints || [];
      const rules = result.inspectionRules || {};
      const elements = result.scrapedElements || [];
      const endpoint = findMatchingEndpoint(endpoints);
      if (!endpoint) {
        setStatus(false, 'No endpoint selected', 'Add an endpoint before inspecting.');
        isWritingBatch = false;
        stopInspector();
        return;
      }
      rules[endpoint] = rules[endpoint] || [];
      if (selector && !rules[endpoint].includes(selector)) rules[endpoint].push(selector);
      const insertedCount = captureSelectorNodes(selector, nodes, endpoint, rules, elements);
      chrome.storage.local.set({ inspectionRules: rules }, () => {
        saveElements(elements, () => {
          setStatus(true, 'Captured successfully', `Saved ${insertedCount} item(s).`);
          safeSendMessage({ type: 'INSPECTOR_DONE', insertedCount, selector, endpoint });
          isWritingBatch = false;
          stopInspector();
        });
      });
    });
  }

  function refreshFromStoredRules() {
    if (!chrome.runtime || !chrome.runtime.id) return;
    chrome.storage.local.get(['endpoints', 'inspectionRules', 'scrapedElements', 'columnNames'], result => {
      if (!chrome.runtime || !chrome.runtime.id) return;
      const endpoint = findMatchingEndpoint(result.endpoints || []);
      const rules = result.inspectionRules || {};
      const selectors = endpoint ? (rules[endpoint] || []) : [];
      if (!endpoint || !selectors.length || isWritingBatch) return;

      const signature = getResultSignature();
      if (!signature || signature === lastResultSignature) return;
      lastResultSignature = signature;

      const elements = result.scrapedElements || [];
      const missingColumns = [];
      let totalChanges = 0;

      selectors.forEach((selector, index) => {
        const columnName = (result.columnNames || {})[selector] || `Column ${index + 1}`;
        try {
          const nodes = getNodesForSelector(selector);
          
          // If selector returned no DOM nodes, we inject a blank item placeholder so other columns still import
          if (!nodes.length) {
            missingColumns.push(columnName);
            const insertedPlaceholder = captureSelectorNodes(selector, [], endpoint, rules, elements);
            totalChanges += insertedPlaceholder;
            return;
          }
          
          const inserted = captureSelectorNodes(selector, nodes, endpoint, rules, elements);
          totalChanges += inserted;
          
          const hasText = nodes.some(node => extractNodeText(node).length > 0);
          if (!hasText) {
            missingColumns.push(columnName);
          }
        } catch (e) {
          missingColumns.push(columnName);
          const insertedPlaceholder = captureSelectorNodes(selector, [], endpoint, rules, elements);
          totalChanges += insertedPlaceholder;
        }
      });

      // We now ALWAYS save the gathered elements, even if there are missing columns
      if (totalChanges > 0) {
        saveElements(elements, () => {
          if (missingColumns.length > 0) {
            setStatus(false, 'Incomplete page captured', `${missingColumns.length} field(s) were empty or missing, but other columns were successfully saved.`, missingColumns);
          } else {
            setStatus(true, 'All elements captured', `Successfully captured and saved page data.`);
          }
        });
      } else {
        if (missingColumns.length > 0) {
          setStatus(false, 'Missing columns', `${missingColumns.length} configured column(s) are empty or missing on this page.`, missingColumns);
        } else {
          setStatus(true, 'Elements verified', `All configured columns are present on this page.`);
        }
      }
    });
  }

  // --- ROBUST UNIVERSAL SPA ROUTE CHANGE DETECTION ---
  let lastObservedUrl = window.location.href;

  function forceStateResetAndRefresh() {
    lastResultSignature = ''; 
    
    setTimeout(() => {
      refreshFromStoredRules();
    }, 150);

    setTimeout(() => {
      refreshFromStoredRules();
    }, 800);
  }

  window.addEventListener('hashchange', forceStateResetAndRefresh);
  window.addEventListener('popstate', forceStateResetAndRefresh);

  layoutMutationObserver = new MutationObserver(() => {
    if (!chrome.runtime || !chrome.runtime.id || isWritingBatch) return;

    if (window.location.href !== lastObservedUrl) {
      lastObservedUrl = window.location.href;
      forceStateResetAndRefresh();
      return;
    }

    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshFromStoredRules, 400);
  });

  layoutMutationObserver.observe(document.documentElement, { 
    childList: true, 
    subtree: true, 
    characterData: true 
  });

  setTimeout(refreshFromStoredRules, 500);
}