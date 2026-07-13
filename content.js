if (typeof isInspecting === 'undefined') {
  var isInspecting = false;
  var hoveredElement = null;
  var highlightOverlay = null;
  var multiHighlightOverlays = [];
  var layoutMutationObserver = null;
  var visualIndicatorBadge = null;
  var isContextInvalidated = false;
  var modeStatusFloatingBadge = null;
  var selectorTuningBar = null;
  var selectorTuningValueLabel = null;
  var selectorTuningPreviewLabel = null;
  var selectorTuningCountLabel = null;
  var selectorTuningInput = null;
  var currentActiveSelector = '';
  var currentResolvedNodes = [];
  var currentSelectorCandidates = [];
  var currentSelectorCandidateIndex = 0;
  var isWritingBatch = false;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (isContextInvalidated) {
      sendResponse({ status: "CONTEXT_INVALIDATED" });
      return false;
    }

    try {
      if (message.type === 'PING') {
        sendResponse({ status: "ALIVE" });
        return true;
      }

      if (message.type === 'TOGGLE_INSPECTOR') {
        isInspecting = message.status;

        if (isInspecting) {
          currentActiveSelector = '';
          currentResolvedNodes = [];
          currentSelectorCandidates = [];
          currentSelectorCandidateIndex = 0;
          isWritingBatch = false;
          createOverlay();
          createModeStatusFloatingBadge();
          createSelectorTuningBar();
          document.body.style.cursor = 'crosshair';
          document.addEventListener('mousemove', handleMouseMove, true);
          document.addEventListener('click', handleElementClick, true);
          document.addEventListener('keydown', handleKeyDown, true);
        } else {
          stopInspector();
        }

        sendResponse({ success: true });
        return true;
      }
    } catch (err) {
      isContextInvalidated = true;
      return false;
    }

    return false;
  });

  function getPageKey() {
    return `${window.location.pathname}${window.location.search || ''}`;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizeText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function extractNodeText(node) {
    if (!node) return '';
    return normalizeText(node.innerText || node.textContent || '');
  }

  function handleKeyDown(e) {
    if (!isInspecting) return;

    if (e.key === '[') {
      e.preventDefault();
      e.stopPropagation();
      shiftSelectorCandidate(-1);
      return;
    }

    if (e.key === ']') {
      e.preventDefault();
      e.stopPropagation();
      shiftSelectorCandidate(1);
      return;
    }
  }

  function createOverlay() {
    if (highlightOverlay) return;

    highlightOverlay = document.createElement('div');
    highlightOverlay.id = 'extension-inspect-overlay';
    highlightOverlay.style.position = 'absolute';
    highlightOverlay.style.backgroundColor = 'rgba(0, 123, 255, 0.25)';
    highlightOverlay.style.border = '2px solid #007bff';
    highlightOverlay.style.pointerEvents = 'none';
    highlightOverlay.style.zIndex = '2147483647';
    document.body.appendChild(highlightOverlay);
  }

  function clearMultiOverlays() {
    multiHighlightOverlays.forEach(div => {
      if (div) div.remove();
    });
    multiHighlightOverlays = [];
  }

  function createModeStatusFloatingBadge() {
    if (modeStatusFloatingBadge) return;

    modeStatusFloatingBadge = document.createElement('div');
    modeStatusFloatingBadge.style.position = 'fixed';
    modeStatusFloatingBadge.style.top = '12px';
    modeStatusFloatingBadge.style.left = '50%';
    modeStatusFloatingBadge.style.transform = 'translateX(-50%)';
    modeStatusFloatingBadge.style.padding = '10px 16px';
    modeStatusFloatingBadge.style.borderRadius = '8px';
    modeStatusFloatingBadge.style.fontSize = '14px';
    modeStatusFloatingBadge.style.fontFamily = 'Arial, sans-serif';
    modeStatusFloatingBadge.style.fontWeight = 'bold';
    modeStatusFloatingBadge.style.zIndex = '2147483647';
    modeStatusFloatingBadge.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
    modeStatusFloatingBadge.style.pointerEvents = 'none';
    document.body.appendChild(modeStatusFloatingBadge);
    updateModeStatusFloatingBadge();
  }

  function updateModeStatusFloatingBadge() {
    if (!modeStatusFloatingBadge) return;
    modeStatusFloatingBadge.innerHTML = "🔍 Inspect Mode | Use the selector bar or [ / ] to adjust breadth";
    modeStatusFloatingBadge.style.backgroundColor = '#212121';
    modeStatusFloatingBadge.style.color = '#ffffff';
  }

  function createSelectorTuningBar() {
    if (selectorTuningBar) return;

    selectorTuningBar = document.createElement('div');
    selectorTuningBar.id = 'extension-selector-tuning-bar';
    selectorTuningBar.style.position = 'fixed';
    selectorTuningBar.style.top = '58px';
    selectorTuningBar.style.left = '50%';
    selectorTuningBar.style.transform = 'translateX(-50%)';
    selectorTuningBar.style.width = 'min(760px, calc(100vw - 32px))';
    selectorTuningBar.style.padding = '12px 14px';
    selectorTuningBar.style.borderRadius = '12px';
    selectorTuningBar.style.background = 'rgba(20, 20, 28, 0.96)';
    selectorTuningBar.style.color = '#ffffff';
    selectorTuningBar.style.fontFamily = 'Arial, sans-serif';
    selectorTuningBar.style.fontSize = '12px';
    selectorTuningBar.style.lineHeight = '1.45';
    selectorTuningBar.style.zIndex = '2147483647';
    selectorTuningBar.style.boxShadow = '0 10px 30px rgba(0,0,0,0.32)';
    selectorTuningBar.style.border = '1px solid rgba(255,255,255,0.12)';

    selectorTuningBar.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px;">
        <div style="font-weight:700;">Selector Precision</div>
        <div id="extension-selector-tuning-value" style="font-weight:700;color:#8ab4ff;">Waiting for hover...</div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;">
        <span style="white-space:nowrap;color:#c6dafc;">Precise</span>
        <input id="extension-selector-tuning-range" type="range" min="0" max="0" value="0" style="flex:1;" />
        <span style="white-space:nowrap;color:#c6dafc;">Broad</span>
      </div>
      <div id="extension-selector-tuning-count" style="margin-top:8px;color:#c3e88d;">Matches: 0</div>
      <div id="extension-selector-tuning-preview" style="margin-top:6px;max-height:72px;overflow:auto;padding:8px 10px;border-radius:8px;background:rgba(255,255,255,0.06);font-family:Consolas, Monaco, monospace;word-break:break-word;"></div>
    `;

    document.body.appendChild(selectorTuningBar);

    selectorTuningValueLabel = selectorTuningBar.querySelector('#extension-selector-tuning-value');
    selectorTuningPreviewLabel = selectorTuningBar.querySelector('#extension-selector-tuning-preview');
    selectorTuningCountLabel = selectorTuningBar.querySelector('#extension-selector-tuning-count');
    selectorTuningInput = selectorTuningBar.querySelector('#extension-selector-tuning-range');

    selectorTuningInput.addEventListener('input', () => {
      currentSelectorCandidateIndex = Number(selectorTuningInput.value || 0);
      applyCurrentSelectorCandidate();
    });
  }

  function updateSelectorTuningBar() {
    if (!selectorTuningBar || !selectorTuningInput) return;

    const total = currentSelectorCandidates.length;

    if (!total) {
      selectorTuningInput.min = 0;
      selectorTuningInput.max = 0;
      selectorTuningInput.value = 0;
      selectorTuningValueLabel.textContent = 'Waiting for hover...';
      selectorTuningCountLabel.textContent = 'Matches: 0';
      selectorTuningPreviewLabel.textContent = '';
      return;
    }

    selectorTuningInput.min = 0;
    selectorTuningInput.max = Math.max(total - 1, 0);
    selectorTuningInput.value = currentSelectorCandidateIndex;

    const candidate = currentSelectorCandidates[currentSelectorCandidateIndex];
    const levelText = `${currentSelectorCandidateIndex + 1} / ${total} — ${candidate.label}`;
    selectorTuningValueLabel.textContent = levelText;
    selectorTuningCountLabel.textContent = `Matches: ${candidate.matchCount}`;
    selectorTuningPreviewLabel.textContent = candidate.selector;
  }

  function stopInspector() {
    isInspecting = false;
    document.body.style.cursor = 'default';
    document.removeEventListener('mousemove', handleMouseMove, true);
    document.removeEventListener('click', handleElementClick, true);
    document.removeEventListener('keydown', handleKeyDown, true);

    if (highlightOverlay) {
      highlightOverlay.remove();
      highlightOverlay = null;
    }

    if (modeStatusFloatingBadge) {
      modeStatusFloatingBadge.remove();
      modeStatusFloatingBadge = null;
    }

    if (selectorTuningBar) {
      selectorTuningBar.remove();
      selectorTuningBar = null;
      selectorTuningValueLabel = null;
      selectorTuningPreviewLabel = null;
      selectorTuningCountLabel = null;
      selectorTuningInput = null;
    }

    clearMultiOverlays();
    hoveredElement = null;
    currentResolvedNodes = [];
    currentSelectorCandidates = [];
    currentSelectorCandidateIndex = 0;
    currentActiveSelector = '';
  }

  function getUsableClasses(el) {
    if (!el || !el.classList) return [];

    return Array.from(el.classList).filter(c => {
      if (typeof c !== 'string') return false;
      if (c === 'extension-multi-inspect-overlay-item') return false;
      if (/\b[0-9a-fA-F]{8,}\b/.test(c)) return false;
      if (c.length > 45) return false;
      return true;
    });
  }

  function buildSimpleSelector(el) {
    if (!el || !el.tagName) return '';

    const tagName = el.tagName.toLowerCase();
    const validClasses = getUsableClasses(el);
    const classSelector = validClasses.length > 0 ? '.' + validClasses.slice(0, 2).join('.') : '';
    return `${tagName}${classSelector}`;
  }

  function buildExactSelector(el) {
    if (!el) return '';
    if (el === document.body) return 'body';
    if (el === document.documentElement) return 'html';

    const selectorToken = buildSimpleSelector(el);
    if (!selectorToken) return '';

    if (el.parentElement && el.parentElement !== document.documentElement && el.parentElement !== document.body) {
      let index = 1;
      let sibling = el.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === el.tagName) index++;
        sibling = sibling.previousElementSibling;
      }
      return `${buildExactSelector(el.parentElement)} > ${selectorToken}:nth-of-type(${index})`;
    }

    const rootPrefix = el.parentElement === document.body ? 'body > ' : '';
    return rootPrefix + selectorToken;
  }

  function buildBroadChainSelector(el, ancestorDepth = 1) {
    if (!el) return '';
    const child = buildSimpleSelector(el);
    if (!child) return '';

    let ancestor = el;
    let steps = 0;

    while (ancestor && ancestor.parentElement && ancestor !== document.body && steps < ancestorDepth) {
      ancestor = ancestor.parentElement;
      steps++;
    }

    if (!ancestor || ancestor === document.body || ancestor === document.documentElement) {
      return child;
    }

    const ancestorSel = buildSimpleSelector(ancestor);
    if (!ancestorSel) return child;

    return `${ancestorSel} ${child}`;
  }

  function buildAncestorOnlySelector(el, ancestorDepth = 1) {
    if (!el) return '';

    let ancestor = el;
    let steps = 0;

    while (ancestor && ancestor.parentElement && ancestor !== document.body && steps < ancestorDepth) {
      ancestor = ancestor.parentElement;
      steps++;
    }

    if (!ancestor || ancestor === document.body || ancestor === document.documentElement) {
      return buildSimpleSelector(el);
    }

    return buildSimpleSelector(ancestor);
  }

  function isVisibleElement(node) {
    if (!node || !node.getBoundingClientRect) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function uniqueNodes(nodes) {
    const seen = new Set();
    const out = [];
    nodes.forEach(node => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      out.push(node);
    });
    return out;
  }

  function getNodesForSelector(selector, fallbackElement) {
    try {
      if (!selector) {
        return fallbackElement ? [fallbackElement] : [];
      }

      const matched = Array.from(document.querySelectorAll(selector)).filter(isVisibleElement);
      if (matched.length > 0) return uniqueNodes(matched);
      return fallbackElement ? [fallbackElement] : [];
    } catch (e) {
      return fallbackElement ? [fallbackElement] : [];
    }
  }

  function buildSelectorCandidates(element) {
    if (!element) return [];

    const candidateMap = new Map();

    function addCandidate(selector, label) {
      if (!selector || selector === 'body' || selector === 'html') return;
      if (candidateMap.has(selector)) return;

      try {
        const nodes = getNodesForSelector(selector, element);
        const matchCount = nodes.length;
        if (!matchCount) return;

        candidateMap.set(selector, {
          selector,
          label,
          matchCount,
          nodes
        });
      } catch (e) {}
    }

    addCandidate(buildExactSelector(element), 'Exact element');
    addCandidate(buildBroadChainSelector(element, 1), 'Balanced');
    addCandidate(buildBroadChainSelector(element, 2), 'Broader');
    addCandidate(buildSimpleSelector(element), 'Simple element');
    addCandidate(buildAncestorOnlySelector(element, 1), 'Parent container');
    addCandidate(buildAncestorOnlySelector(element, 2), 'Broad parent');

    const candidates = Array.from(candidateMap.values());

    candidates.sort((a, b) => {
      if (a.matchCount === b.matchCount) {
        return b.selector.length - a.selector.length;
      }
      return a.matchCount - b.matchCount;
    });

    return candidates;
  }

  function syncCandidateIndexWithinBounds() {
    if (!currentSelectorCandidates.length) {
      currentSelectorCandidateIndex = 0;
      return;
    }

    if (currentSelectorCandidateIndex < 0) {
      currentSelectorCandidateIndex = 0;
    }

    if (currentSelectorCandidateIndex >= currentSelectorCandidates.length) {
      currentSelectorCandidateIndex = currentSelectorCandidates.length - 1;
    }
  }

  function shiftSelectorCandidate(delta) {
    if (!currentSelectorCandidates.length) return;
    currentSelectorCandidateIndex += delta;
    syncCandidateIndexWithinBounds();
    applyCurrentSelectorCandidate();
  }

  function positionPrimaryOverlay(node) {
    if (!highlightOverlay || !node) return;
    const rect = node.getBoundingClientRect();
    highlightOverlay.style.width = `${rect.width}px`;
    highlightOverlay.style.height = `${rect.height}px`;
    highlightOverlay.style.top = `${rect.top + window.scrollY}px`;
    highlightOverlay.style.left = `${rect.left + window.scrollX}px`;
  }

  function drawSecondaryOverlays(nodes, hoveredNode) {
    clearMultiOverlays();

    nodes.forEach(node => {
      if (!node || node === hoveredNode) return;

      const nodeRect = node.getBoundingClientRect();
      if (nodeRect.width === 0 || nodeRect.height === 0) return;

      const secondaryOverlay = document.createElement('div');
      secondaryOverlay.className = 'extension-multi-inspect-overlay-item';
      secondaryOverlay.style.position = 'absolute';
      secondaryOverlay.style.backgroundColor = 'rgba(233, 30, 99, 0.2)';
      secondaryOverlay.style.border = '1px dashed #e91e63';
      secondaryOverlay.style.pointerEvents = 'none';
      secondaryOverlay.style.zIndex = '2147483646';
      secondaryOverlay.style.width = `${nodeRect.width}px`;
      secondaryOverlay.style.height = `${nodeRect.height}px`;
      secondaryOverlay.style.top = `${nodeRect.top + window.scrollY}px`;
      secondaryOverlay.style.left = `${nodeRect.left + window.scrollX}px`;
      document.body.appendChild(secondaryOverlay);
      multiHighlightOverlays.push(secondaryOverlay);
    });
  }

  function applyCurrentSelectorCandidate() {
    syncCandidateIndexWithinBounds();

    const candidate = currentSelectorCandidates[currentSelectorCandidateIndex];
    if (!candidate) {
      currentActiveSelector = '';
      currentResolvedNodes = hoveredElement ? [hoveredElement] : [];
      updateSelectorTuningBar();
      clearMultiOverlays();
      return;
    }

    currentActiveSelector = candidate.selector;
    currentResolvedNodes = uniqueNodes(candidate.nodes || []);

    if (hoveredElement) {
      positionPrimaryOverlay(hoveredElement);
    }

    drawSecondaryOverlays(currentResolvedNodes, hoveredElement);
    updateSelectorTuningBar();
  }

  function handleMouseMove(e) {
    if (!isInspecting) return;
    e.stopPropagation();

    const element = e.target;
    if (
      !element ||
      element === document.body ||
      element === document.documentElement ||
      element === highlightOverlay ||
      element.id === 'extension-inspect-overlay' ||
      element.id === 'extension-selector-tuning-bar' ||
      element.closest?.('#extension-selector-tuning-bar') ||
      element.className === 'extension-multi-inspect-overlay-item'
    ) {
      return;
    }

    hoveredElement = element;
    positionPrimaryOverlay(element);

    currentSelectorCandidates = buildSelectorCandidates(element);
    currentSelectorCandidateIndex = 0;
    applyCurrentSelectorCandidate();
  }

  function isStoredDuplicate(elements, candidate) {
    return elements.some(el =>
      String(el.endpointOrigin || '') === String(candidate.endpointOrigin || '') &&
      String(el.path || '') === String(candidate.path || '') &&
      String(el.baseSelector || el.selector || '') === String(candidate.baseSelector || candidate.selector || '') &&
      Number(el.itemIndex || 1) === Number(candidate.itemIndex || 1) &&
      String(el.text || '').trim().toLowerCase() === String(candidate.text || '').trim().toLowerCase()
    );
  }

  function pushCapturedNode(elements, node, meta) {
    const textContent = extractNodeText(node);
    if (!textContent) return false;

    const candidate = {
      text: textContent,
      selector: meta.selectorKey,
      baseSelector: meta.baseSelector,
      itemIndex: meta.itemIndex,
      endpointOrigin: meta.endpointOrigin,
      domain: window.location.hostname,
      path: getPageKey(),
      timestamp: new Date().toISOString()
    };

    if (isStoredDuplicate(elements, candidate)) {
      return false;
    }

    elements.push(candidate);
    return true;
  }

  function findMatchingEndpoint(currentUrl, registeredEndpoints) {
    if (!registeredEndpoints || !Array.isArray(registeredEndpoints)) return null;

    const cleanCurrent = currentUrl.trim().toLowerCase().replace(/\/$/, "");

    for (let i = 0; i < registeredEndpoints.length; i++) {
      let endpoint = registeredEndpoints[i];
      if (!endpoint) continue;

      let cleanEndpoint = endpoint.trim().toLowerCase().replace(/\/$/, "");
      if (cleanCurrent.includes(cleanEndpoint)) return endpoint;

      let fallbackEndpoint = cleanEndpoint;
      if (!fallbackEndpoint.startsWith('http://') && !fallbackEndpoint.startsWith('https://')) {
        fallbackEndpoint = window.location.protocol + '//' + fallbackEndpoint;
      }

      try {
        const targetUrlObj = new URL(fallbackEndpoint);
        const currentUrlObj = new URL(cleanCurrent);

        if (targetUrlObj.hostname === currentUrlObj.hostname) {
          const targetPath = targetUrlObj.pathname.replace(/\/$/, "");
          const currentPath = currentUrlObj.pathname.replace(/\/$/, "");

          if (currentPath === targetPath || currentPath.startsWith(targetPath + '/')) {
            return endpoint;
          }
        }
      } catch (e) {}
    }

    return null;
  }

  function handleElementClick(e) {
    if (!isInspecting || isWritingBatch) return;

    e.preventDefault();
    e.stopPropagation();

    const finalSelector = currentActiveSelector || buildExactSelector(hoveredElement);

    if (!finalSelector || finalSelector === 'body' || finalSelector === 'html') {
      stopInspector();
      chrome.runtime.sendMessage({ type: 'INSPECTOR_DONE' });
      return;
    }

    isWritingBatch = true;
    const currentUrl = window.location.href;

    chrome.storage.local.get(['endpoints', 'inspectionRules', 'scrapedElements'], (result) => {
      const endpoints = result.endpoints || [];
      const rules = result.inspectionRules || {};
      const elements = result.scrapedElements || [];
      const matchedEndpoint = findMatchingEndpoint(currentUrl, endpoints);

      if (!matchedEndpoint) {
        alert("Please add this target directory endpoint to popup setup parameters first.");
        isWritingBatch = false;
        stopInspector();
        chrome.runtime.sendMessage({ type: 'INSPECTOR_DONE' });
        return;
      }

      if (!rules[matchedEndpoint]) {
        rules[matchedEndpoint] = [];
      }

      if (!rules[matchedEndpoint].includes(finalSelector)) {
        rules[matchedEndpoint].push(finalSelector);
      }

      const capturedNodes = uniqueNodes(currentResolvedNodes.length ? currentResolvedNodes : [hoveredElement]).filter(Boolean);

      capturedNodes.forEach((node, idx) => {
        const itemIndex = idx + 1;
        const selectorKey = `${finalSelector}::${itemIndex}`;
        pushCapturedNode(elements, node, {
          selectorKey,
          baseSelector: finalSelector,
          itemIndex,
          endpointOrigin: matchedEndpoint
        });
      });

      chrome.storage.local.set({ inspectionRules: rules, scrapedElements: elements }, () => {
        stopInspector();
        chrome.runtime.sendMessage({ type: 'INSPECTOR_DONE' });

        setTimeout(() => {
          isWritingBatch = false;
          runAutomaticScraper();
          currentActiveSelector = '';
          currentResolvedNodes = [];
        }, 150);
      });
    });
  }

  function renderLiveStatusIndicator(allCapturedState, missingItems = []) {
    if (!visualIndicatorBadge) {
      visualIndicatorBadge = document.createElement('div');
      visualIndicatorBadge.id = 'scraped-status-indicator';
      visualIndicatorBadge.style.position = 'fixed';
      visualIndicatorBadge.style.bottom = '16px';
      visualIndicatorBadge.style.right = '16px';
      visualIndicatorBadge.style.minWidth = '240px';
      visualIndicatorBadge.style.maxWidth = '360px';
      visualIndicatorBadge.style.padding = '12px 14px';
      visualIndicatorBadge.style.borderRadius = '14px';
      visualIndicatorBadge.style.fontFamily = 'Arial, sans-serif';
      visualIndicatorBadge.style.fontSize = '12px';
      visualIndicatorBadge.style.lineHeight = '1.45';
      visualIndicatorBadge.style.boxShadow = '0 8px 24px rgba(0,0,0,0.18)';
      visualIndicatorBadge.style.zIndex = '2147483647';
      visualIndicatorBadge.style.whiteSpace = 'normal';
      visualIndicatorBadge.style.wordBreak = 'break-word';
      document.body.appendChild(visualIndicatorBadge);
    }

    if (allCapturedState) {
      visualIndicatorBadge.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;font-weight:bold;">
          <span>✅</span>
          <span>All elements captured</span>
        </div>
      `;
      visualIndicatorBadge.style.backgroundColor = '#e6f4ea';
      visualIndicatorBadge.style.color = '#137333';
      visualIndicatorBadge.style.border = '1px solid #137333';
      return;
    }

    const uniqueMissing = Array.from(new Set(missingItems.filter(Boolean)));
    const visibleItems = uniqueMissing.slice(0, 6);
    const remainingCount = uniqueMissing.length - visibleItems.length;

    const listHtml = visibleItems.map(item => `
      <li style="margin:0 0 4px 0;padding:0;list-style:none;display:flex;align-items:flex-start;gap:6px;">
        <span style="font-weight:bold;line-height:1.4;">•</span>
        <span>${escapeHtml(item)}</span>
      </li>
    `).join('');

    const moreHtml = remainingCount > 0
      ? `<div style="margin-top:6px;font-size:11px;opacity:0.9;">+ ${remainingCount} more missing items</div>`
      : '';

    visualIndicatorBadge.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;font-weight:bold;margin-bottom:8px;">
        <span>⚠️</span>
        <span>Missing elements</span>
      </div>
      <ul style="margin:0;padding:0;">
        ${listHtml || '<li style="list-style:none;">Unknown missing element</li>'}
      </ul>
      ${moreHtml}
    `;

    visualIndicatorBadge.style.backgroundColor = '#fce8e6';
    visualIndicatorBadge.style.color = '#c5221f';
    visualIndicatorBadge.style.border = '1px solid #c5221f';
  }

  function runAutomaticScraper() {
    if (isWritingBatch) return;

    const currentUrl = window.location.href;

    chrome.storage.local.get(['endpoints', 'inspectionRules', 'scrapedElements', 'columnNames'], (result) => {
      if (isWritingBatch) return;

      const endpoints = result.endpoints || [];
      const rules = result.inspectionRules || {};
      const columnNames = result.columnNames || {};
      let elements = result.scrapedElements || [];
      const matchedEndpoint = findMatchingEndpoint(currentUrl, endpoints);
      const pathIsolatedRules = matchedEndpoint ? (rules[matchedEndpoint] || []) : [];

      if (pathIsolatedRules.length === 0) {
        if (visualIndicatorBadge) {
          visualIndicatorBadge.remove();
          visualIndicatorBadge = null;
        }
        return;
      }

      let updated = false;
      const missingItems = [];

      pathIsolatedRules.forEach(selector => {
        try {
          const targets = Array.from(document.querySelectorAll(selector)).filter(isVisibleElement);

          if (targets.length === 0) {
            missingItems.push(columnNames[selector] || selector);
            return;
          }

          targets.forEach((target, idx) => {
            const itemIndex = idx + 1;
            const selectorKey = `${selector}::${itemIndex}`;
            const inserted = pushCapturedNode(elements, target, {
              selectorKey,
              baseSelector: selector,
              itemIndex,
              endpointOrigin: matchedEndpoint
            });

            if (inserted) updated = true;
          });
        } catch (e) {
          missingItems.push(columnNames[selector] || `${selector} (invalid selector)`);
        }
      });

      if (updated && !isWritingBatch) {
        chrome.storage.local.set({ scrapedElements: elements });
      }

      const allFound = missingItems.length === 0;
      renderLiveStatusIndicator(allFound, missingItems);

      if (layoutMutationObserver) {
        try {
          layoutMutationObserver.disconnect();
        } catch (e) {}
      }

      layoutMutationObserver = new MutationObserver(() => {
        if (!chrome.runtime || !chrome.runtime.id || isWritingBatch) return;
        runAutomaticScraper();
      });

      layoutMutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      });
    });
  }

  runAutomaticScraper();
}