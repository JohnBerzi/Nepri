let targetEndpoints = [];

chrome.storage.local.get(['endpoints'], (result) => {
  if (result.endpoints) {
    targetEndpoints = result.endpoints;
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'UPDATE_ENDPOINTS') {
    targetEndpoints = message.endpoints;
  }
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const url = details.url;
    const match = targetEndpoints.find(endpoint => url.includes(endpoint));
    
    if (match) {
      chrome.storage.local.get(['capturedRequests'], (result) => {
        const requests = result.capturedRequests || [];
        requests.push({
          timestamp: new Date().toISOString(),
          matchedEndpoint: match,
          fullUrl: url,
          method: details.method
        });
        chrome.storage.local.set({ capturedRequests: requests });
      });
    }
  },
  { urls: ["<all_urls>"] }
);