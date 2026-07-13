if (typeof window.__zoomInfoFlexibleScraperInstalled === 'undefined') {
  window.__zoomInfoFlexibleScraperInstalled = true;

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
  let companyOnlyToggle = null;
  let textOnlyToggle = null;
  let currentActiveSelector = '';
  let currentResolvedNodes = [];
  let currentSelectorCandidates = [];
  let currentSelectorCandidateIndex = 0;
  let isWritingBatch = false;

  let pageSnapshotCache = {
    fingerprint: '',
    key: ''
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
      if (message.type === 'PING') {
        sendResponse({ status: 'ALIVE' });
        return true;
      }

      if (message.type === 'TOGGLE_INSPECTOR') {
        isInspecting = Boolean(message.status);

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
    } catch (error) {
      console.error('[ZoomInfo Scraper] Message handler error:', error);
      sendResponse({
        success: false,
        error: String(error)
      });
      return false;
    }

    return false;
  });

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeDuplicateValue(value) {
    return normalizeText(value).toLowerCase();
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function escapeCss(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(value);
    }

    return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function extractNodeText(node) {
    if (!node) return '';
    return normalizeText(node.innerText || node.textContent || '');
  }

  function isVisibleElement(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }

    const style = window.getComputedStyle(node);

    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.opacity === '0'
    ) {
      return false;
    }

    const rect = node.getBoundingClientRect();

    return rect.width > 0 && rect.height > 0;
  }

  function isExtensionUi(node) {
    if (!node || !node.closest) return false;

    return Boolean(
      node.closest('#extension-inspect-overlay') ||
      node.closest('#extension-selector-tuning-bar') ||
      node.closest('#scraped-status-indicator') ||
      node.closest('.extension-multi-inspect-overlay-item')
    );
  }

  function uniqueNodes(nodes) {
    const seen = new Set();
    const output = [];

    for (const node of nodes || []) {
      if (!node || seen.has(node)) continue;

      seen.add(node);
      output.push(node);
    }

    return output;
  }

  function getUsableClasses(element) {
    if (!element || !element.classList) return [];

    return Array.from(element.classList).filter((className) => {
      if (!className) return false;
      if (className.startsWith('extension-')) return false;
      if (className.length > 60) return false;
      if (/^[0-9a-f]{8,}$/i.test(className)) return false;
      if (/^(css|sc)-[a-z0-9_-]{8,}$/i.test(className)) return false;

      return true;
    });
  }

  function getStableAttributes(element) {
    if (!element || !element.getAttribute) return [];

    const result = [];
    const names = [
      'data-testid',
      'data-test',
      'data-qa',
      'data-id',
      'data-field',
      'data-column',
      'aria-label',
      'role'
    ];

    for (const name of names) {
      const value = String(element.getAttribute(name) || '').trim();

      if (!value || value.length > 100) continue;
      if (/^[a-f0-9-]{20,}$/i.test(value)) continue;

      result.push(`[${name}="${escapeCss(value)}"]`);
    }

    return result;
  }

  function buildSimpleSelector(element) {
    if (!element || !element.tagName) return '';

    const tagName = element.tagName.toLowerCase();

    if (element.id && element.id.length < 80) {
      return `${tagName}#${escapeCss(element.id)}`;
    }

    const attributes = getStableAttributes(element);

    if (attributes.length > 0) {
      return `${tagName}${attributes.slice(0, 2).join('')}`;
    }

    const classes = getUsableClasses(element).slice(0, 2);

    if (classes.length > 0) {
      return `${tagName}.${classes.map(escapeCss).join('.')}`;
    }

    return tagName;
  }

  function buildExactSelector(element) {
    if (!element || !element.tagName) return '';

    if (element === document.body) return 'body';
    if (element === document.documentElement) return 'html';

    const ownSelector = buildSimpleSelector(element);

    if (!ownSelector) return '';

    if (element.id) return ownSelector;

    const parent = element.parentElement;

    if (!parent || parent === document.documentElement) {
      return ownSelector;
    }

    let index = 1;
    let sibling = element.previousElementSibling;

    while (sibling) {
      if (sibling.tagName === element.tagName) {
        index++;
      }

      sibling = sibling.previousElementSibling;
    }

    return `${buildExactSelector(parent)} > ${ownSelector}:nth-of-type(${index})`;
  }

  function buildBroadChainSelector(element, ancestorDepth) {
    if (!element || !element.tagName) return '';

    let ancestor = element;
    let moved = 0;

    while (
      ancestor.parentElement &&
      ancestor !== document.body &&
      moved < ancestorDepth
    ) {
      ancestor = ancestor.parentElement;
      moved++;
    }

    const ancestorSelector = buildSimpleSelector(ancestor);
    const elementSelector = buildSimpleSelector(element);

    if (!elementSelector) return '';
    if (!ancestorSelector || ancestor === element) return elementSelector;

    return `${ancestorSelector} ${elementSelector}`;
  }

  function buildAncestorOnlySelector(element, ancestorDepth) {
    if (!element || !element.tagName) return '';

    let ancestor = element;
    let moved = 0;

    while (
      ancestor.parentElement &&
      ancestor !== document.body &&
      moved < ancestorDepth
    ) {
      ancestor = ancestor.parentElement;
      moved++;
    }

    return buildSimpleSelector(ancestor);
  }

  function getNodesForSelector(selector, fallbackElement) {
    if (!selector) {
      return fallbackElement ? [fallbackElement] : [];
    }

    try {
      const nodes = Array.from(document.querySelectorAll(selector))
        .filter(isVisibleElement)
        .filter((node) => !isExtensionUi(node));

      if (nodes.length > 0) {
        return uniqueNodes(nodes);
      }
    } catch (error) {
      console.warn('[ZoomInfo Scraper] Invalid selector:', selector);
    }

    return fallbackElement ? [fallbackElement] : [];
  }

  function isTextLeafNode(node) {
    if (!node || !isVisibleElement(node)) return false;

    const text = extractNodeText(node);

    if (!text || text.length > 250) return false;

    const visibleChildren = Array.from(node.children || [])
      .filter(isVisibleElement)
      .filter((child) => extractNodeText(child));

    if (visibleChildren.length === 0) {
      return true;
    }

    const directText = normalizeText(
      Array.from(node.childNodes)
        .filter((child) => child.nodeType === Node.TEXT_NODE)
        .map((child) => child.nodeValue)
        .join(' ')
    );

    return Boolean(directText);
  }

  function isLikelyCompanyNameNode(node) {
    if (!node || !isVisibleElement(node)) return false;

    const text = extractNodeText(node);

    if (!text || text.length < 2 || text.length > 180) {
      return false;
    }

    const tag = String(node.tagName || '').toLowerCase();
    const role = String(node.getAttribute('role') || '').toLowerCase();
    const ariaLabel = String(node.getAttribute('aria-label') || '').toLowerCase();
    const href = String(node.getAttribute('href') || '').toLowerCase();
    const className = String(node.className || '').toLowerCase();

    const hasCompanyHint =
      /company|account|organization|org|business|entity|name/.test(
        `${ariaLabel} ${className}`
      );

    const isLinkLike =
      tag === 'a' ||
      tag === 'button' ||
      role === 'link' ||
      href.includes('company') ||
      href.includes('account');

    const lines = String(node.innerText || '')
      .split('\n')
      .filter(Boolean);

    const isLikelyContainer =
      lines.length > 2 ||
      text.length > 100 ||
      (node.querySelectorAll('a,button,[role="link"]').length > 0 && !isLinkLike);

    return (isLinkLike || hasCompanyHint) && !isLikelyContainer;
  }

  function applyNodeFilters(nodes) {
    let filtered = uniqueNodes(nodes)
      .filter(isVisibleElement)
      .filter((node) => !isExtensionUi(node));

    if (textOnlyToggle && textOnlyToggle.checked) {
      filtered = filtered.filter(isTextLeafNode);
    }

    if (companyOnlyToggle && companyOnlyToggle.checked) {
      const companyNodes = filtered.filter(isLikelyCompanyNameNode);

      if (companyNodes.length > 0) {
        filtered = companyNodes;
      }
    }

    return filtered;
  }

  function addCandidate(candidateMap, selector, label, fallbackElement) {
    if (!selector || selector === 'body' || selector === 'html') {
      return;
    }

    if (candidateMap.has(selector)) return;

    const nodes = applyNodeFilters(
      getNodesForSelector(selector, fallbackElement)
    );

    if (nodes.length === 0) return;

    candidateMap.set(selector, {
      selector,
      label,
      matchCount: nodes.length,
      nodes
    });
  }

  function buildSelectorCandidates(element) {
    if (!element) return [];

    const candidateMap = new Map();

    addCandidate(
      candidateMap,
      buildExactSelector(element),
      'Exact',
      element
    );

    addCandidate(
      candidateMap,
      buildBroadChainSelector(element, 1),
      'Balanced',
      element
    );

    addCandidate(
      candidateMap,
      buildBroadChainSelector(element, 2),
      'Broader',
      element
    );

    addCandidate(
      candidateMap,
      buildBroadChainSelector(element, 3),
      'Very broad',
      element
    );

    addCandidate(
      candidateMap,
      buildSimpleSelector(element),
      'Simple element',
      element
    );

    addCandidate(
      candidateMap,
      buildAncestorOnlySelector(element, 1),
      'Parent container',
      element
    );

    addCandidate(
      candidateMap,
      buildAncestorOnlySelector(element, 2),
      'Broad parent',
      element
    );

    const candidates = Array.from(candidateMap.values());

    candidates.sort((a, b) => {
      if (a.matchCount !== b.matchCount) {
        return a.matchCount - b.matchCount;
      }

      return a.selector.length - b.selector.length;
    });

    return candidates;
  }

  function stableHash(value) {
    let hash = 2166136261;

    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index);
      hash +=
        (hash << 1) +
        (hash << 4) +
        (hash << 7) +
        (hash << 8) +
        (hash << 24);
    }

    return (hash >>> 0).toString(36);
  }

  function buildPageFingerprint() {
    const resultSelectors = [
      '[role="row"]',
      'table tbody tr',
      '[data-testid*="search-result"]',
      '[data-testid*="company"]',
      '[data-test*="search-result"]',
      '[data-test*="company"]'
    ];

    let resultNodes = [];

    for (const selector of resultSelectors) {
      const nodes = Array.from(document.querySelectorAll(selector))
        .filter(isVisibleElement)
        .filter((node) => !isExtensionUi(node));

      if (nodes.length >= 2) {
        resultNodes = nodes;
        break;
      }
    }

    if (resultNodes.length === 0) {
      resultNodes = Array.from(document.querySelectorAll('a'))
        .filter(isVisibleElement)
        .filter((node) => {
          const href = String(node.getAttribute('href') || '').toLowerCase();
          const text = extractNodeText(node);

          return (
            text.length >= 2 &&
            text.length <= 180 &&
            (href.includes('company') || href.includes('account'))
          );
        });
    }

    const fingerprint = resultNodes
      .slice(0, 10)
      .map((node) => {
        const href = String(node.getAttribute('href') || '').trim();
        const text = extractNodeText(node).slice(0, 180);

        return `${href}|${text}`;
      })
      .filter(Boolean)
      .join('||');

    return fingerprint || 'no-results-yet';
  }

  function getPageKey() {
    const urlKey = `${window.location.pathname}${window.location.search || ''}`;
    const fingerprint = buildPageFingerprint();

    if (fingerprint !== pageSnapshotCache.fingerprint) {
      pageSnapshotCache = {
        fingerprint,
        key: `${urlKey}::results-${stableHash(fingerprint)}`
      };
    }

    return pageSnapshotCache.key;
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
    multiHighlightOverlays.forEach((overlay) => overlay?.remove());
    multiHighlightOverlays = [];
  }

  function positionPrimaryOverlay(node) {
    if (!highlightOverlay || !node) return;

    const rect = node.getBoundingClientRect();

    highlightOverlay.style.width = `${rect.width}px`;
    highlightOverlay.style.height = `${rect.height}px`;
    highlightOverlay.style.top = `${rect.top + window.scrollY}px`;
    highlightOverlay.style.left = `${rect.left + window.scrollX}px`;
  }

  function drawSecondaryOverlays(nodes, primaryNode) {
    clearMultiOverlays();

    for (const node of nodes) {
      if (!node || node === primaryNode) continue;

      const rect = node.getBoundingClientRect();

      if (rect.width <= 0 || rect.height <= 0) continue;

      const overlay = document.createElement('div');

      overlay.className = 'extension-multi-inspect-overlay-item';
      overlay.style.position = 'absolute';
      overlay.style.backgroundColor = 'rgba(233, 30, 99, 0.18)';
      overlay.style.border = '1px dashed #e91e63';
      overlay.style.pointerEvents = 'none';
      overlay.style.zIndex = '2147483646';
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;
      overlay.style.top = `${rect.top + window.scrollY}px`;
      overlay.style.left = `${rect.left + window.scrollX}px`;

      document.body.appendChild(overlay);
      multiHighlightOverlays.push(overlay);
    }
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
    modeStatusFloatingBadge.style.backgroundColor = '#212121';
    modeStatusFloatingBadge.style.color = '#ffffff';
    modeStatusFloatingBadge.textContent =
      'Inspect Mode — hover a company name, adjust the bar, then click';

    document.body.appendChild(modeStatusFloatingBadge);
  }

  function createSelectorTuningBar() {
    if (selectorTuningBar) return;

    selectorTuningBar = document.createElement('div');
    selectorTuningBar.id = 'extension-selector-tuning-bar';
    selectorTuningBar.style.position = 'fixed';
    selectorTuningBar.style.top = '58px';
    selectorTuningBar.style.left = '50%';
    selectorTuningBar.style.transform = 'translateX(-50%)';
    selectorTuningBar.style.width = 'min(860px, calc(100vw - 32px))';
    selectorTuningBar.style.padding = '12px 14px';
    selectorTuningBar.style.borderRadius = '12px';
    selectorTuningBar.style.background = 'rgba(20, 20, 28, 0.97)';
    selectorTuningBar.style.color = '#ffffff';
    selectorTuningBar.style.fontFamily = 'Arial, sans-serif';
    selectorTuningBar.style.fontSize = '12px';
    selectorTuningBar.style.lineHeight = '1.45';
    selectorTuningBar.style.zIndex = '2147483647';
    selectorTuningBar.style.boxShadow = '0 10px 30px rgba(0,0,0,0.32)';
    selectorTuningBar.style.border = '1px solid rgba(255,255,255,0.12)';

    selectorTuningBar.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:9px">
        <div style="font-size:13px;font-weight:700">Selector precision</div>
        <div id="extension-selector-tuning-value" style="font-weight:700;color:#8ab4ff">
          Hover a company name
        </div>
      </div>

      <div style="display:flex;align-items:center;gap:10px">
        <span style="white-space:nowrap;color:#c6dafc">Precise</span>
        <input
          id="extension-selector-tuning-range"
          type="range"
          min="0"
          max="0"
          value="0"
          style="flex:1"
        >
        <span style="white-space:nowrap;color:#c6dafc">Broad</span>
      </div>

      <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-top:10px">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input id="extension-company-only-toggle" type="checkbox" checked>
          <span>Company-name mode</span>
        </label>

        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input id="extension-text-only-toggle" type="checkbox" checked>
          <span>Text-only matches</span>
        </label>

        <span style="color:#b9c6d6">
          Use [ and ] to change precision
        </span>
      </div>

      <div id="extension-selector-tuning-count" style="margin-top:10px;color:#c3e88d">
        Matches: 0
      </div>

      <div
        id="extension-selector-tuning-preview"
        style="margin-top:7px;max-height:76px;overflow:auto;padding:8px 10px;border-radius:8px;background:rgba(255,255,255,0.06);font-family:Consolas,Monaco,monospace;word-break:break-word"
      >
        Hover the company-name link or text, then choose a selector.
      </div>
    `;

    document.body.appendChild(selectorTuningBar);

    selectorTuningValueLabel = selectorTuningBar.querySelector(
      '#extension-selector-tuning-value'
    );

    selectorTuningPreviewLabel = selectorTuningBar.querySelector(
      '#extension-selector-tuning-preview'
    );

    selectorTuningCountLabel = selectorTuningBar.querySelector(
      '#extension-selector-tuning-count'
    );

    selectorTuningInput = selectorTuningBar.querySelector(
      '#extension-selector-tuning-range'
    );

    companyOnlyToggle = selectorTuningBar.querySelector(
      '#extension-company-only-toggle'
    );

    textOnlyToggle = selectorTuningBar.querySelector(
      '#extension-text-only-toggle'
    );

    selectorTuningInput.addEventListener('input', () => {
      currentSelectorCandidateIndex = Number(selectorTuningInput.value || 0);
      applyCurrentSelectorCandidate();
    });

    const rebuildCandidates = () => {
      if (!hoveredElement) return;

      currentSelectorCandidates = buildSelectorCandidates(hoveredElement);
      currentSelectorCandidateIndex = 0;
      applyCurrentSelectorCandidate();
    };

    companyOnlyToggle.addEventListener('change', rebuildCandidates);
    textOnlyToggle.addEventListener('change', rebuildCandidates);
  }

  function updateSelectorTuningBar() {
    if (
      !selectorTuningBar ||
      !selectorTuningInput ||
      !selectorTuningValueLabel ||
      !selectorTuningCountLabel ||
      !selectorTuningPreviewLabel
    ) {
      return;
    }

    const total = currentSelectorCandidates.length;

    if (total === 0) {
      selectorTuningInput.min = '0';
      selectorTuningInput.max = '0';
      selectorTuningInput.value = '0';

      selectorTuningValueLabel.textContent = 'No valid selector';
      selectorTuningCountLabel.textContent = 'Matches: 0';
      selectorTuningPreviewLabel.textContent =
        'Hover directly over a company name or company link.';

      return;
    }

    const candidate = currentSelectorCandidates[currentSelectorCandidateIndex];

    selectorTuningInput.min = '0';
    selectorTuningInput.max = String(Math.max(total - 1, 0));
    selectorTuningInput.value = String(currentSelectorCandidateIndex);

    selectorTuningValueLabel.textContent =
      `${currentSelectorCandidateIndex + 1}/${total} — ${candidate.label}`;

    selectorTuningCountLabel.textContent =
      `Matches: ${candidate.matchCount}`;

    selectorTuningPreviewLabel.textContent = candidate.selector;
  }

  function syncCandidateIndexWithinBounds() {
    if (currentSelectorCandidates.length === 0) {
      currentSelectorCandidateIndex = 0;
      return;
    }

    currentSelectorCandidateIndex = Math.max(
      0,
      Math.min(
        currentSelectorCandidateIndex,
        currentSelectorCandidates.length - 1
      )
    );
  }

  function shiftSelectorCandidate(delta) {
    if (currentSelectorCandidates.length === 0) return;

    currentSelectorCandidateIndex += delta;
    syncCandidateIndexWithinBounds();
    applyCurrentSelectorCandidate();
  }

  function applyCurrentSelectorCandidate() {
    syncCandidateIndexWithinBounds();

    const candidate = currentSelectorCandidates[currentSelectorCandidateIndex];

    if (!candidate) {
      currentActiveSelector = '';
      currentResolvedNodes = hoveredElement ? [hoveredElement] : [];

      clearMultiOverlays();
      updateSelectorTuningBar();

      return;
    }

    currentActiveSelector = candidate.selector;
    currentResolvedNodes = uniqueNodes(candidate.nodes);

    if (hoveredElement) {
      positionPrimaryOverlay(hoveredElement);
      drawSecondaryOverlays(currentResolvedNodes, hoveredElement);
    }

    updateSelectorTuningBar();
  }

  function handleMouseMove(event) {
    if (!isInspecting) return;

    const element = event.target;

    if (!element || isExtensionUi(element)) return;

    hoveredElement = element;
    positionPrimaryOverlay(element);

    currentSelectorCandidates = buildSelectorCandidates(element);
    currentSelectorCandidateIndex = 0;

    applyCurrentSelectorCandidate();
  }

  function handleKeyDown(event) {
    if (!isInspecting) return;

    if (event.key === '[') {
      event.preventDefault();
      event.stopPropagation();

      shiftSelectorCandidate(-1);
      return;
    }

    if (event.key === ']') {
      event.preventDefault();
      event.stopPropagation();

      shiftSelectorCandidate(1);
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();

      stopInspector();
      chrome.runtime.sendMessage({ type: 'INSPECTOR_DONE' });
    }
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
            `${window.location.protocol}//${normalizedEndpoint}`;
        }

        const targetUrl = new URL(normalizedEndpoint);
        const activeUrl = new URL(currentUrl);

        if (targetUrl.hostname !== activeUrl.hostname) {
          continue;
        }

        const targetPath = targetUrl.pathname.replace(/\/$/, '');
        const activePath = activeUrl.pathname.replace(/\/$/, '');

        if (
          activePath === targetPath ||
          activePath.startsWith(`${targetPath}/`)
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

  function getNodeIdentity(node) {
    if (!node) return '';

    const href = String(node.getAttribute?.('href') || '').trim();
    const dataId = String(node.getAttribute?.('data-id') || '').trim();
    const testId = String(node.getAttribute?.('data-testid') || '').trim();
    const text = normalizeDuplicateValue(extractNodeText(node));

    return `${href}|${dataId}|${testId}|${text}`;
  }

  function isStoredDuplicate(elements, candidate) {
    return elements.some((item) => {
      return (
        String(item.endpointOrigin || '') ===
          String(candidate.endpointOrigin || '') &&
        String(item.path || '') === String(candidate.path || '') &&
        String(item.baseSelector || item.selector || '') ===
          String(candidate.baseSelector || candidate.selector || '') &&
        Number(item.itemIndex || 1) === Number(candidate.itemIndex || 1) &&
        normalizeDuplicateValue(item.text) ===
          normalizeDuplicateValue(candidate.text)
      );
    });
  }

  function pushCapturedNode(elements, node, meta) {
    const text = extractNodeText(node);

    if (!text) return false;

    const candidate = {
      text,
      selector: meta.selectorKey,
      baseSelector: meta.baseSelector,
      itemIndex: meta.itemIndex,
      endpointOrigin: meta.endpointOrigin,
      domain: window.location.hostname,
      path: meta.path,
      nodeIdentity: getNodeIdentity(node),
      timestamp: new Date().toISOString()
    };

    if (isStoredDuplicate(elements, candidate)) {
      return false;
    }

    elements.push(candidate);

    return true;
  }

  function renderLiveStatusIndicator(allCaptured, missingItems) {
    if (!visualIndicatorBadge) {
      visualIndicatorBadge = document.createElement('div');
      visualIndicatorBadge.id = 'scraped-status-indicator';
      visualIndicatorBadge.style.position = 'fixed';
      visualIndicatorBadge.style.right = '16px';
      visualIndicatorBadge.style.bottom = '16px';
      visualIndicatorBadge.style.minWidth = '245px';
      visualIndicatorBadge.style.maxWidth = '390px';
      visualIndicatorBadge.style.padding = '12px 14px';
      visualIndicatorBadge.style.borderRadius = '14px';
      visualIndicatorBadge.style.fontFamily = 'Arial, sans-serif';
      visualIndicatorBadge.style.fontSize = '12px';
      visualIndicatorBadge.style.lineHeight = '1.45';
      visualIndicatorBadge.style.boxShadow = '0 8px 24px rgba(0,0,0,0.18)';
      visualIndicatorBadge.style.zIndex = '2147483647';
      visualIndicatorBadge.style.wordBreak = 'break-word';
      visualIndicatorBadge.style.pointerEvents = 'none';

      document.body.appendChild(visualIndicatorBadge);
    }

    if (allCaptured) {
      visualIndicatorBadge.style.background = '#e6f4ea';
      visualIndicatorBadge.style.color = '#137333';
      visualIndicatorBadge.style.border = '1px solid #137333';
      visualIndicatorBadge.textContent =
        'Captured: all configured elements on this result page.';

      return;
    }

    const uniqueMissing = Array.from(
      new Set((missingItems || []).filter(Boolean))
    );

    visualIndicatorBadge.style.background = '#fce8e6';
    visualIndicatorBadge.style.color = '#c5221f';
    visualIndicatorBadge.style.border = '1px solid #c5221f';
    visualIndicatorBadge.innerHTML =
      '<strong>Missing elements:</strong><br>' +
      uniqueMissing.slice(0, 6).map(escapeHtml).join('<br>');
  }

  function runAutomaticScraper() {
    if (isWritingBatch) return;

    const currentUrl = window.location.href;

    chrome.storage.local.get(
      ['endpoints', 'inspectionRules', 'scrapedElements', 'columnNames'],
      (result) => {
        if (chrome.runtime.lastError || isWritingBatch) return;

        const endpoints = result.endpoints || [];
        const rules = result.inspectionRules || {};
        const elements = result.scrapedElements || [];
        const columnNames = result.columnNames || {};

        const matchedEndpoint = findMatchingEndpoint(currentUrl, endpoints);

        if (!matchedEndpoint) return;

        const endpointRules = rules[matchedEndpoint] || [];

        if (endpointRules.length === 0) return;

        const pageKey = getPageKey();
        const missingItems = [];
        let updated = false;

        endpointRules.forEach((selector) => {
          try {
            const targets = applyNodeFilters(
              Array.from(document.querySelectorAll(selector))
            );

            if (targets.length === 0) {
              missingItems.push(columnNames[selector] || selector);
              return;
            }

            targets.forEach((target, index) => {
              const inserted = pushCapturedNode(elements, target, {
                selectorKey: `${selector}::${index + 1}`,
                baseSelector: selector,
                itemIndex: index + 1,
                endpointOrigin: matchedEndpoint,
                path: pageKey
              });

              if (inserted) {
                updated = true;
              }
            });
          } catch (error) {
            missingItems.push(
              `${columnNames[selector] || selector} (invalid selector)`
            );
          }
        });

        if (updated) {
          chrome.storage.local.set({ scrapedElements: elements });
        }

        renderLiveStatusIndicator(missingItems.length === 0, missingItems);
      }
    );
  }

  function installMutationObserver() {
    if (layoutMutationObserver) {
      layoutMutationObserver.disconnect();
    }

    let debounceTimer = null;

    layoutMutationObserver = new MutationObserver(() => {
      clearTimeout(debounceTimer);

      debounceTimer = setTimeout(() => {
        runAutomaticScraper();
      }, 700);
    });

    layoutMutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function handleElementClick(event) {
    if (!isInspecting || isWritingBatch) return;

    event.preventDefault();
    event.stopPropagation();

    const finalSelector =
      currentActiveSelector || buildExactSelector(hoveredElement);

    if (
      !finalSelector ||
      finalSelector === 'body' ||
      finalSelector === 'html'
    ) {
      alert(
        'Please hover over the company-name element, not the full page or result container.'
      );

      return;
    }

    isWritingBatch = true;

    const currentUrl = window.location.href;

    chrome.storage.local.get(
      ['endpoints', 'inspectionRules', 'scrapedElements'],
      (result) => {
        const endpoints = result.endpoints || [];
        const rules = result.inspectionRules || {};
        const elements = result.scrapedElements || [];

        const matchedEndpoint = findMatchingEndpoint(currentUrl, endpoints);

        if (!matchedEndpoint) {
          alert(
            'Add this ZoomInfo search URL or path in the extension before selecting a field.'
          );

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

        const pageKey = getPageKey();

        const capturedNodes = applyNodeFilters(
          currentResolvedNodes.length > 0
            ? currentResolvedNodes
            : [hoveredElement]
        );

        capturedNodes.forEach((node, index) => {
          pushCapturedNode(elements, node, {
            selectorKey: `${finalSelector}::${index + 1}`,
            baseSelector: finalSelector,
            itemIndex: index + 1,
            endpointOrigin: matchedEndpoint,
            path: pageKey
          });
        });

        chrome.storage.local.set(
          {
            inspectionRules: rules,
            scrapedElements: elements
          },
          () => {
            stopInspector();
            chrome.runtime.sendMessage({ type: 'INSPECTOR_DONE' });

            setTimeout(() => {
              isWritingBatch = false;
              runAutomaticScraper();
              installMutationObserver();
            }, 300);
          }
        );
      }
    );
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
    }

    selectorTuningValueLabel = null;
    selectorTuningPreviewLabel = null;
    selectorTuningCountLabel = null;
    selectorTuningInput = null;
    companyOnlyToggle = null;
    textOnlyToggle = null;

    clearMultiOverlays();

    hoveredElement = null;
    currentActiveSelector = '';
    currentResolvedNodes = [];
    currentSelectorCandidates = [];
    currentSelectorCandidateIndex = 0;
  }

  setTimeout(() => {
    runAutomaticScraper();
    installMutationObserver();
  }, 1000);
}