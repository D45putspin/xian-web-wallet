let appTabId = null;
let appReadyResolvers = [];

// Retrieve the stored `appTabId` when the service worker starts
chrome.storage.local.get("appTabId", (result) => {
    if (result.appTabId) {
        appTabId = result.appTabId;
        verifyTab(appTabId); // Ensure the tab is still valid on startup
    }
});

// Listener for the extension icon click: always show popup
chrome.action.onClicked.addListener(() => {
    try { chrome.action.setPopup({ popup: 'index-external.html' }); } catch(_) {}
});

// Always force the action popup to the small window
try { chrome.action.setPopup({ popup: 'index-external.html' }); } catch(_) {}

// Function to open a new tab or focus on an existing one
function openOrFocusAppTab() {
    const url = chrome.runtime.getURL('index.html');
    if (appTabId !== null) {
        chrome.tabs.get(appTabId, (existingTab) => {
            if (chrome.runtime.lastError || !existingTab) {
                createTab(); // Create a new tab if the existing one is missing or closed
            } else {
                chrome.tabs.update(appTabId, { active: true }); // Focus on the existing tab
            }
        });
    } else {
        findTab(); // Try finding the tab first before creating a new one
    }
}

// Function to find the existing app tab by URL
function findTab() {
    const url = chrome.runtime.getURL('index.html');
    chrome.tabs.query({ url }, (tabs) => {
        if (tabs.length > 0) {
            appTabId = tabs[0].id;
            chrome.storage.local.set({ appTabId });
            // Do not focus the tab for background dApp requests
            resolveAppReadyWhenComplete(appTabId);
        } else {
            createTab(); // If no existing tab, create a new one
        }
    });
}

// Function to create a new app tab
function createTab() {
    const url = chrome.runtime.getURL('index.html');
    // Create inactive tab for background handling
    chrome.tabs.create({ url, active: false }, (newTab) => {
        appTabId = newTab.id;
        chrome.storage.local.set({ appTabId });
        // Ensure the tab stays in background
        chrome.tabs.update(newTab.id, { active: false });
        resolveAppReadyWhenComplete(appTabId);
    });
}

function resolveAppReadyWhenComplete(tabId){
    try {
        chrome.tabs.get(tabId, (tab) => {
            if (chrome.runtime.lastError) return;
            if (tab.status === 'complete') {
                // Tab is ready now
                appReadyResolvers.splice(0).forEach(fn => { try{ fn(); } catch(_){} });
            } else {
                const listener = (updatedId, changeInfo) => {
                    if (updatedId === tabId && changeInfo.status === 'complete'){
                        chrome.tabs.onUpdated.removeListener(listener);
                        appReadyResolvers.splice(0).forEach(fn => { try{ fn(); } catch(_){} });
                    }
                };
                chrome.tabs.onUpdated.addListener(listener);
            }
        });
    } catch(_) {}
}

function sendToAppTabWhenReady(message, sendResponse){
    const sendNow = () => {
        try {
            chrome.tabs.sendMessage(appTabId, message, sendResponse);
        } catch(e) {
            sendResponse && sendResponse({ errors: ["Wallet app unavailable"] });
        }
    };
    if (appTabId === null){
        findTab();
        appReadyResolvers.push(sendNow);
        return true;
    }
    try {
        chrome.tabs.get(appTabId, (tab) => {
            if (chrome.runtime.lastError || !tab){
                findTab();
                appReadyResolvers.push(sendNow);
                return;
            }
            if (tab.status === 'complete') {
                sendNow();
            } else {
                appReadyResolvers.push(sendNow);
                resolveAppReadyWhenComplete(appTabId);
            }
        });
    } catch(e) {
        findTab();
        appReadyResolvers.push(sendNow);
    }
    return true;
}

// Verify if a stored tab ID is still valid and open
function verifyTab(tabId) {
    chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
            appTabId = null;
            chrome.storage.local.remove("appTabId");
        }
    });
}

// Listener for messages from the content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'OPEN_APP_TAB') {
        openOrFocusAppTab();
        sendResponse && sendResponse('ok');
        return true;
    }
    if (["dAppSendTransaction", "getWalletInfo", "dAppSignMessage", "dAppAddToken"].includes(message.type)) {
        // Handle lightweight connect (getWalletInfo) without opening the full app tab
        if (message.type === 'getWalletInfo') {
            try {
                chrome.storage.local.get('walletInfo', (res) => {
                    const info = res.walletInfo || { address: "", locked: true, chainId: "" };
                    sendResponse(info);
                });
                return true; // async response
            } catch (e) {
                sendResponse({ address: "", locked: true, chainId: "" });
                return false;
            }
        }

        // For other interactive requests, ensure we have an app tab and it's ready before sending
        const sourceTabId = sender?.tab?.id || null;
        if (!message.meta) message.meta = {};
        message.meta.sourceTabId = sourceTabId;

        return sendToAppTabWhenReady(message, sendResponse);
    }

    // Relay overlay messages from app tab to the originating tab
    if (["XIAN_OVERLAY_OPEN", "XIAN_OVERLAY_DATA", "XIAN_OVERLAY_CLOSE"].includes(message.type)) {
        const targetTabId = message?.meta?.sourceTabId;
        if (targetTabId) {
            chrome.tabs.sendMessage(targetTabId, message);
        }
    }

    // Forward results from content overlay back to app tab
    if (["REQUEST_TRANSACTION", "REQUEST_SIGNATURE", "REQUEST_TOKEN"].includes(message.type)) {
        if (appTabId !== null) {
            chrome.tabs.sendMessage(appTabId, message);
        }
    }

    return true; // Indicate that we will send a response asynchronously
});

// Listener for when a tab is removed
chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId === appTabId) {
        appTabId = null;
        chrome.storage.local.remove("appTabId");
    }
});

// Listener for when a tab is updated
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId === appTabId && changeInfo.status === "complete") {
        appTabId = tabId;
        chrome.storage.local.set({ appTabId });
    }
});
