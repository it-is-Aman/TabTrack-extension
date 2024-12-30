// Listen for installation
chrome.runtime.onInstalled.addListener(() => {
    // Initialize storage with empty sessions array if needed
    chrome.storage.local.get(['sessions'], (result) => {
        if (!result.sessions) {
            chrome.storage.local.set({ sessions: [] });
        }
    });
});
