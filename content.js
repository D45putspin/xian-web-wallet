const isJSON = (json) => {
	if (Object.prototype.toString.call(json) !== "[object String]") return false
    try{
        return JSON.parse(json)
    }catch (e){ return false}
}

document.addEventListener('xianWalletGetInfo', (event) => {
    getWalletInfo()
});

document.addEventListener('xianWalletSendTx', (event) => {
    xianWalletSendTx(event.detail)
});

document.addEventListener('xianWalletSignMsg', (event) => {
    xianWalletSignMsg(event.detail)
});

document.addEventListener('xianWalletAddToken', (event) => {
    xianWalletAddToken(event.detail)
});

const xianWalletSendTx = (detail) => { 
    chrome.runtime.sendMessage({type: 'dAppSendTransaction', data: detail}, (response) => {
        if(!chrome.runtime.lastError || response !== 'ok'){
            document.dispatchEvent(new CustomEvent('xianWalletTxStatus', {detail: response}));
            handleFocus();
        }
    });
}

const getWalletInfo = () => {  
    chrome.runtime.sendMessage({type: 'getWalletInfo'}, (response) => {
        if(!chrome.runtime.lastError || response !== 'ok'){
            document.dispatchEvent(new CustomEvent('xianWalletInfo', {detail: response}));
        }
    });
}

const xianWalletSignMsg = (detail) => {
    chrome.runtime.sendMessage({type: 'dAppSignMessage', data: detail}, (response) => {
        if(!chrome.runtime.lastError || response !== 'ok'){
            document.dispatchEvent(new CustomEvent('xianWalletSignMsgResponse', {detail: response}));
            handleFocus();
        }
    });
}

const xianWalletAddToken = (detail) => {
    chrome.runtime.sendMessage({type: 'dAppAddToken', data: detail}, (response) => {
        if(!chrome.runtime.lastError || response !== 'ok'){
            document.dispatchEvent(new CustomEvent('xianWalletAddTokenResponse', {detail: response}));
            handleFocus();
        }
    });
}

const handleFocus = () => {
    window.blur();
    setTimeout(() => {
        window.focus();
    }, 100);
};

// Dispatch xianReady event when the content script is loaded and ready
document.dispatchEvent(new CustomEvent('xianReady'));

// --- Lite Mode Overlay injection ---
let xianOverlayContainer = null;
let xianOverlayIframe = null;
let xianOverlayMeta = null;
let xianOverlayLoaded = false;
let xianOverlayQueue = [];

const ensureOverlay = () => {
    if (xianOverlayContainer) return;
    xianOverlayContainer = document.createElement('div');
    xianOverlayContainer.id = 'xian-overlay-container';
    xianOverlayContainer.style.position = 'fixed';
    xianOverlayContainer.style.inset = '0';
    xianOverlayContainer.style.display = 'flex';
    xianOverlayContainer.style.alignItems = 'center';
    xianOverlayContainer.style.justifyContent = 'center';
    xianOverlayContainer.style.background = 'rgba(0,0,0,0.35)';
    xianOverlayContainer.style.zIndex = '2147483647';

    const panel = document.createElement('div');
    panel.style.width = '400px';
    panel.style.height = '600px';
    panel.style.boxShadow = '0 10px 30px rgba(0,0,0,0.4)';
    panel.style.borderRadius = '8px';
    panel.style.overflow = 'hidden';

    xianOverlayIframe = document.createElement('iframe');
    xianOverlayIframe.id = 'xian-overlay-iframe';
    xianOverlayIframe.style.width = '100%';
    xianOverlayIframe.style.height = '100%';
    xianOverlayIframe.style.border = '0';
    xianOverlayIframe.referrerPolicy = 'no-referrer';
    xianOverlayLoaded = false;
    xianOverlayIframe.addEventListener('load', () => {
        xianOverlayLoaded = true;
        // Flush any queued payloads
        if (xianOverlayIframe && xianOverlayIframe.contentWindow) {
            xianOverlayQueue.forEach(payload => {
                try { xianOverlayIframe.contentWindow.postMessage(payload, '*'); } catch (e) {}
            });
        }
        xianOverlayQueue = [];
    });
    try {
        xianOverlayIframe.src = chrome.runtime.getURL('index-external.html');
    } catch (e) {
        // non-extension context
    }

    panel.appendChild(xianOverlayIframe);
    xianOverlayContainer.appendChild(panel);
    document.documentElement.appendChild(xianOverlayContainer);
};

const destroyOverlay = () => {
    if (xianOverlayContainer && xianOverlayContainer.parentNode) {
        xianOverlayContainer.parentNode.removeChild(xianOverlayContainer);
    }
    xianOverlayContainer = null;
    xianOverlayIframe = null;
    xianOverlayMeta = null;
    xianOverlayLoaded = false;
    xianOverlayQueue = [];
};

// Receive overlay control/data from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'XIAN_OVERLAY_OPEN') {
        xianOverlayMeta = message.meta || null;
        ensureOverlay();
    }
    if (message.type === 'XIAN_OVERLAY_DATA') {
        ensureOverlay();
        const payload = message.payload;
        if (xianOverlayLoaded && xianOverlayIframe && xianOverlayIframe.contentWindow) {
            xianOverlayIframe.contentWindow.postMessage(payload, '*');
        } else {
            xianOverlayQueue.push(payload);
        }
    }
    if (message.type === 'XIAN_OVERLAY_CLOSE') {
        destroyOverlay();
    }
});

// Forward messages from overlay iframe back to background (extension page)
window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (!['REQUEST_TRANSACTION', 'REQUEST_SIGNATURE', 'REQUEST_TOKEN'].includes(data.type)) return;
    chrome.runtime.sendMessage({ type: data.type, data, meta: xianOverlayMeta || {} });
});
