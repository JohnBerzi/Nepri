# Nepri — Directory Scraper Browser Extension

An enterprise-grade, highly adaptive client-side scraping extension for Google Chrome. Nepri leverages **Visual DOM Inspection**, **State Signature Change Detection**, and **Robust SPA Hash Routing Syncing** to turn complex, dynamically loaded single-page web directories into clean, structured datasets (`.csv`) without relying on complex external crawling infrastructures.

---

## File-by-File Technical Deep Dive

### 1. `manifest.json` — System Decoupling and Orchestration
*   **Role**: Configures the security boundary, declaration rules, background worker mappings, content injection scope, and permission contexts.
*   **Technical Implementation Details**:
    *   **Manifest Version**: Configured using `manifest_version: 3` to align with the latest browser standards.
    *   **Permissions**:
        *   `storage`: Unlocks access to the asynchronous, persistent client-side data warehouse (`chrome.storage.local`).
        *   `webRequest`: Grants low-level lifecycle hooks over outgoing browser requests to intercept raw HTTP payloads before they are dispatched.
        *   `activeTab` & `scripting`: Provides programmatic execution permissions to dynamically inject scripts (`content.js`) when triggered by user intent.
        *   `tabs`: Grants metadata and state querying privileges over browser window tabs.
    *   **Host Permissions**: Accesses `<all_urls>` allowing intercept hooks and content script executions globally.
    *   **Service Worker**: Registers `background.js` as a background service worker that runs off the main page rendering thread, keeping the memory footprint minimal when idle.

### 2. `background.js` — Outgoing Network Request Capture & Context Validation
*   **Role**: Operates continuously in a separate browser thread to detect background requests and handle network interception.
*   **Technical Implementation Details**:
    *   **State Alignment**: Reads targeted routing rules (`targetEndpoints`) inside `chrome.storage.local` at startup and listens for dynamic runtime events (`chrome.runtime.onMessage`) matching `UPDATE_ENDPOINTS` to dynamically sync parameters without requiring service worker restarts.
    *   **Low-level Request Interception**: Registers an active listener on the web requests lifecycle using `chrome.webRequest.onBeforeRequest.addListener`. It scans outgoing URL strings on-the-fly and compares them against target endpoints using partial matching.
    *   **Storage Offloading**: When an HTTP network boundary call matches an endpoint, it captures a detailed structured context containing the matched endpoint keyword, the full target URL query string, the HTTP Verb, and a structured ISO timestamp. This metadata block is appended asynchronously into the persistent `capturedRequests` array.

### 3. `content.js` — Core Inspection & Real-Time Dynamic Scraping Engine
*   **Role**: Injected directly into target web pages, this file is responsible for element targeting, layout abstraction, DOM change observation, and automated incremental scrapes.
*   **Technical Implementation Details & Deep Dive**:

    #### A. Initialization Guard and Memory Isolation
    To prevent memory leaks and redundant listeners when single-page applications dynamically trigger transitions, `content.js` encapsulates its entire execution context within a global guard:
    ```javascript
    if (typeof window.__scraperV5Injected === 'undefined') {
      window.__scraperV5Injected = true;
      // Core scope initialized
    }
    ```
    This ensures that multiple programmatic scripts injected via `chrome.scripting.executeScript` share the same global layout variables without throwing redeclaration errors.

    #### B. Dynamic SPA Path Extraction and Routing Abstraction
    Standard web scraping scripts rely strictly on static properties like `window.location.pathname` to identify page state. In modern single-page directories (running on frameworks like React, Vue, or Angular), client-side routers manipulate the URL structure without causing a browser-level document reload. `content.js` decouples page identity from rigid browser constraints through an abstraction layer:
    *   **`parseHashRoute()`**: Many directories utilize "hash-routing" to support deep-linking (e.g., `/#/apps/search/v2/results/company?id=123`). This function processes `window.location.hash`, strips the leading `#` character, and isolates the client-side router path from its associated query payload. It then converts the isolated query parameters into a virtualized, indexable `URLSearchParams` object to programmatically read values.
    *   **`getVirtualPath()`**: Combines the physical web route (`window.location.pathname`) with the dynamically parsed hash path to generate a unified, virtual location string. By standardizing physical and hash-based routing paths under one interface, the engine can match both routing patterns against target endpoints stored in the user config.
    *   **`getUniversalPageIdentity()`**: Traverses both active query systems (`window.location.search` and parsed virtual parameters from hash-routing) to extract a unique database key. It tests for common URL identifiers (e.g., `id`, `contactid`, `personid`, `p`). If no search query matches, the function performs a backward-scan of the path segments. It uses custom regex logic to identify alphanumeric segments representing database IDs (matching string segments that are either fully numeric or longer than 8 characters containing mixed digits and letters). This creates a reliable way to uniquely index complex, parameterized profile URLs.

    #### C. State-Signature Engine & Change Detection
    In modern directories, pages load dynamically using asynchronous API requests, and paging through directories often re-uses the same DOM structures while injecting new data. To track data changes across dynamic transitions without processing duplicate layout blocks, `content.js` implements a signature change detection engine:
    *   **`getResultSignature()`**: Rather than hashing the entire page DOM (which is prone to false positives from layout changes, animated headers, side-panels, or user input), this engine targets structural layout tags (including `table tbody tr`, `[role="row"]`, tables, list elements, and headers). It extracts the raw, whitespace-normalized textual data of up to 30 visible nodes and concatenates them into a single layout snapshot.
    *   **`hashString()` (FNV-1a Algorithm)**: The resulting snapshot is processed through an implementation of the Fowler-Noll-Vo (FNV-1a) non-cryptographic hashing algorithm. It processes each character sequentially, executing an XOR with the offset basis prime (`2166136261`) and multiplying it by the FNV prime (`16777619`), before returning a compact, base-36 representation. This algorithm produces a distinct hash from minor text updates while keeping computational overhead low to avoid blocking the main rendering thread.
    *   **`getEffectivePageKey()`**: Maps page indexes to the computed FNV-1a hash value: `${pageNumber}-${hashString(signature)}`. This establishes state boundary tracking. If a user clicks pagination or an infinite scroll triggers, the layout signature changes. This creates a new layout key, alerting the engine to capture the fresh data instead of discarding it as a duplicate.

    #### D. Smart CSS Selector Generation and User Tuning
    When a user hovers over an item in "Inspector Mode," the DOM node is passed into `buildSelectorCandidates(element)` to construct an array of selector alternatives sorted by complexity:
    1.  **Table Column Selector**: Traverses ancestors up to the nearest cell tag (`td`, `th`). It resolves the cell's sibling index using `Array.from` and targets the whole vertical dataset using `table_selector tbody tr > *:nth-child(index)`.
    2.  **Unique ID Selector**: Escapes and returns the node's native element identifier (`#id`) using `CSS.escape`.
    3.  **Exact Hierarchy Path**: Recursively traverses upwards through parents to output tag names appended with localized index calculations: `:nth-of-type(index)`.
    4.  **Simple Class & Tag Path**: Generates a standard tag string matched with clean class values (excluding dynamic CSS-in-JS hashes using custom length and pattern checks).
    
    The user can scale up or down between these compiled selectors using the arrow keys (`ArrowLeft`/`ArrowRight`) or the precision range slider. This selection changes `currentActiveSelector` and targets matching nodes across the DOM.

    #### E. Asynchronous DOM Mutation Observation and Debounce Loop
    To track asynchronous layout changes without blocking the browser interface thread, the content script implements a `MutationObserver`:
    *   The observer monitors structure changes (`childList`, `subtree`, `characterData`) inside `document.documentElement`.
    *   It implements a 400ms debounce loop (`refreshTimer`) to gather updates. This prevents multiple consecutive mutations from launching scraping passes too quickly.
    *   When the location URL changes, the engine forces a signature state reset, allowing scraping logic to run cleanly on the new view.

    #### F. Layout Alignment via Adaptive Placeholders
    When compiling columns into tabular outputs, missing values can cause row cells to shift out of alignment. If a configured column selector finds zero matches on a page, `captureSelectorNodes` automatically writes a blank placeholder record (`''`) to ensure columns line up correctly during CSV assembly.

### 4. `popup.html` — User Operations Interface
*   **Role**: Delivers a clean, styled control dashboard that allows users to manage target endpoints, rename captured table headers, preview captured rows, and run exports.
*   **Technical Implementation Details**:
    *   Provides functional cards for current path tracking, endpoint inputs, configuration actions, rules matching, and captured live previews.
    *   Excludes inline script declarations to adhere to Chrome's Extension CSP, binding all behaviors externally via `popup.js`.

### 5. `popup.js` — Client-Facing Dashboard and CSV Assembly Engine
*   **Role**: Handles interactive control wiring, data normalization, configurations import/export, and client-side database reconstruction.
*   **Technical Implementation Details**:
    *   **SPA-aware Path Determination**: Resolves the virtual hash route using window tab URLs to display the active location inside the popup.
    *   **Context Rule Pairing**: Compares active domain metadata with target endpoints to load and manage matched structural targets.
    *   **Dynamic Dataset Reconstruction & Export**:
        *   Reads raw flat records from `chrome.storage.local.scrapedElements`.
        *   **Relational Mapping**: Joins separate data fields by reconstructing rows with a composite key linking session keys, page numbers, and item indexes.
        *   **Sorting & Deduplication**: Sorts and deduplicates records by hashing combined row values before compilation.
        *   **CSV Compilation & Download**: Escapes fields, constructs tabular rows, compiles the dataset into a `.csv` format, and dynamically initiates a local system download using a temporary anchor element.

---

## Configuration JSON Schema

The extension configuration can be exported as a standard JSON file. This is useful for saving and loading complex selector patterns across different systems.

```json
{
  "endpoints": [
    "#/apps/search/v2/results/company"
  ],
  "inspectionRules": {
    "#/apps/search/v2/results/company": [
      ".company-name-selector",
      ".company-email-selector"
    ]
  },
  "columnNames": {
    ".company-name-selector": "Company Name",
    ".company-email-selector": "Email Address"
  }
}
