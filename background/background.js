/**
 * Background Service Worker
 * Handles API calls and cross-origin requests
 */

chrome.runtime.onInstalled.addListener(() => {
  console.log('[JDS] Extension installed');
});

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'proxyFetch') {
    proxyFetch(request.url, request.options)
      .then(response => sendResponse({ success: true, data: response }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
});

/**
 * Proxy fetch through background to bypass CORS if needed
 */
async function proxyFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...options.headers
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return await response.json();
  }
  return await response.text();
}
