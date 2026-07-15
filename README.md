# Nepri (Data Scraper) (v1.0)
An advanced Chrome Extension utilizing Chrome Extension Manifest V3 to perform real-time, non-intrusive network interception and dynamic, state-aware DOM scraping. Designed for Single Page Applications (SPAs) and highly dynamic web environments, this system aligns unstructured web elements into unified data tables through deterministic DOM targeting, robust route parsing, and structural data-normalization strategies.

---

## File-by-File Technical Deep Dive

### 1. `manifest.json` (The Declarative Blueprint)
This file registers the extension under the **Manifest V3** specification.

*   **Permissions & Isolation**:
    *   `storage`: Grants low-latency access to `chrome.storage.local` to store target rules, endpoints, and collected elements.
    *   `webRequest` (with Host Permission `<all_urls>`): Authorizes network layer interception.
    *   `activeTab` & `scripting`: Allows programmatic execution of content scripts inside target tabs.
    *   `tabs`: Grants URL and tab state visibility to handle path resolutions.
*   **Architecture Components**:
    *   `background.service_worker`: Declares `background.js` as a non-persistent background script running on its own execution thread.
    *   `content_scripts`: Injects `content.js` automatically into all page contexts, granting direct access to document trees and layout engines.

---

### 2. `background.js` (The Network Interception Engine)
Operates inside a background service worker thread, decoupled from any DOM instance. It functions as an out-of-band network listener.

*   **State Coordination**:
    *   Maintains an in-memory array of strings (`targetEndpoints`) representing the user's active API endpoints.
    *   Loads existing endpoints from `chrome.storage.local` during initialization and listens for the IPC message `UPDATE_ENDPOINTS` to dynamically sync network targets without restarting the service worker thread.
*   **Asynchronous Network Sniffing**:
    *   Utilizes the `chrome.webRequest.onBeforeRequest` listener, bound to all URLs.
    *   As outgoing HTTP requests are fired, the engine performs substring scanning across request URLs against `targetEndpoints`.
    *   When an target endpoint match is identified, it writes the request details (`timestamp`, `matchedEndpoint`, `fullUrl`, `method`) to a transaction log in `chrome.storage.local` under the `capturedRequests` key. This provides historical verification of client-server API interactions.

---

### 3. `content.js` (The DOM Inspector, Selector Generator, & Auto-Scraper)
Runs inside the client tab context. This is the core engine responsible for state parsing, programmatic selection targeting, and background DOM scraping.

#### Key Sub-Modules:

*   **Universal SPA Routing & Page Fingerprinting**:
    *   To prevent cross-page data contamination, the script identifies unique application paths through **`parseHashRoute()`** and **`getVirtualPath()`**. It extracts parameters and routing coordinates from both traditional search paths (`window.location.search`) and SPA client-side routes (`window.location.hash`).
    *   **`getUniversalPageIdentity()`**: Traverses backwards through path segments looking for pattern-matching UUIDs, numeric IDs, or hashes (e.g. `/person/2481055131/profile`), and cross-references common entity query parameters (`id`, `contactId`, etc.). This ensures that dynamically loaded entities in SPAs are treated as unique pages rather than a generic singular route.
    *   **`getEffectivePageKey()`**: Computes a unique hash combining the page identity and the visual state signature.
    *   **`getResultSignature()`**: Computes an active layout snapshot by reading up to 30 visible text nodes across priority structures (such as `tr`, `li`, `h1`). If the layout changes, a new visual signature is triggered.

*   **Selector Engine & Precision Tuning**:
    *   During visual targeting, **`buildSelectorCandidates()`** constructs a hierarchy of CSS paths matching different specificity levels:
        1.  `buildExactSelector()`: Traverses upwards along parent nodes to form an exact positional hierarchy using tag names and `:nth-of-type()` offsets.
        2.  `getTableColumnSelector()`: Traverses the DOM tree to locate parent tables, determining column index matches (`td, th`) to target specific columns across dynamic lists.
        3.  `buildSimpleSelector()`: Constructs a selector based on element tags and sanitized class configurations.
    *   The selector tuning bar acts as a precision selector. Moving the slider maps the active selection back and forth along these generated candidates.

*   **Dynamic DOM Change Detection**:
    *   A **`MutationObserver`** watches the entire document tree (`childList`, `subtree`, `characterData`).
    *   To avoid rendering degradation, mutations trigger a debounced scraping execution after a short delay.
    *   If a URL change or hash change is detected, the script invalidates the signature cache via **`forceStateResetAndRefresh()`**. It then schedules scraping passes at 150ms and 800ms to allow asynchronous layout renders to complete.

*   **Structured Column Alignment**:
    *   To avoid missing values, **`captureSelectorNodes()`** enforces structured layout safety.
    *   If a selector fails to find nodes in the DOM (e.g., a missing table column or an optional profile card field), the script captures an empty placeholder object containing a blank string `text: ""`.
    *   This preserves structural alignments across all rows in local storage.

---

### 4. `popup.html` & `popup.js` (The State Controller & CSV Generation Engine)
These files govern the control panel popup, managing UI updates, background storage coordination, and data export.

*   **Message Dispatch & Action Binding**:
    *   Initializes tab checking, reads extension storage, and displays matching routes.
    *   Coordinates the visual targeting process by sending message payloads (`TOGGLE_INSPECTOR`) directly to `content.js`. It handles runtime injection edge cases by executing fallback content scripts via `chrome.scripting.executeScript` when context invalidations are encountered.
*   **Configuration Import/Export**:
    *   Allows configuration schemas to be exported as a JSON manifest containing active targets, rules, and custom column definitions. Importing a JSON schema restores these targets without affecting currently scraped datasets in local storage.
*   **Relational Aggregation & CSV Generator**:
    *   Converts unstructured stored rows into a structured relational format.
    *   Retrieves all scraped nodes, groups them by their parent endpoint, and processes them through an aggregation pipeline:
        1.  **Composite Row Alignment**: Creates a unique composite key combining the page/entity token and the row index:
            $$\text{RowKey} = \text{captureSessionKey} + "\_\_\text{page}-" + \text{pageNumber} + "\_\_\text{row}-" + \text{itemIndex}$$
        2.  **Pivot Table Normalization**: Transforms the linear key-value store into structured data rows, mapping active CSS rules to their matched columns.
        3.  **Denoising & Deduplication**: Concatenates column values into row signatures to identify and drop identical duplicate records.
        4.  **Escaping & Binary Download**: Sanitizes row outputs by doubling up internal quote marks, converting records into formatted strings, and invoking programmatic binary downloads:
            ```javascript
            const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
            ```

---

## Architectural & Technical Best Practices

### 1. Robust Single Page Application (SPA) Isolation
Traditional scraping tools often fail on SPAs because URLs rarely reload when state changes. This extension bypasses that issue by utilizing:
*   **Dynamic Client-Side Route Parsing**: Intercepts changes in query states and dynamic location hashes.
*   **Visual Fingerprinting**: Tracks visual DOM updates. When elements transition dynamically on-screen, the visual signature changes, letting the auto-scraper capture updated views without relying on page reload events.

### 2. Structural Integrity via Empty Placeholders
If columns or elements are missing on certain views, typical web scrapers often omit those entries entirely. This shifts subsequent columns and breaks CSV tabular alignment. 

This extension implements **structural data alignment**: if an element selector fails to resolve, a placeholder containing an empty text field is injected into storage. This ensures that every database row contains the exact same column count, keeping CSV tables perfectly aligned.

### 3. Decoupled Processing Threads
*   **Background Worker Thread**: Continuously monitors the HTTP web request layer.
*   **Content Scripts**: Continuously monitor structural DOM adjustments.
*   **Popup Thread**: Processes intensive data transformations, pivots, and CSV generation only when requested.

This division of labor keeps memory usage low and ensures zero interface degradation for the user.
