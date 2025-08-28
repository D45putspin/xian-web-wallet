if (runningAsExtension()) {
    let isUnsafe = (str) => {
        if (str.length < 2 ){
            return true;
        }
        if (str.length > 10000){
            return true;
        }
        try {
            obj = JSON.parse(str);
            if (obj.hasOwnProperty('payload')){
                return true;
            }
            if (obj.hasOwnProperty('metadata')){
                return true;
            }
            if (obj.hasOwnProperty('chain_id')){
                return true;
            }
            return false;
        } catch (e) {
            return false;
        }
        return false;
    };

    // De-duplication of rapid duplicate dApp requests
    const pendingRequests = new Map(); // key -> { responses: [sendResponse], timer: number }
    function requestKey(type, message){
        try {
            const src = message?.meta?.sourceTabId ?? 'na';
            if (type === 'dAppSendTransaction'){
                const d = message?.data?.data || {};
                return `${type}:${src}:${d.contract || ''}:${d.method || ''}:${JSON.stringify(d.kwargs || {})}:${d.stampLimit || ''}:${d.chainId || ''}`;
            }
            if (type === 'dAppSignMessage'){
                const d = message?.data || {};
                return `${type}:${src}:${String(d.message || '')}`;
            }
            if (type === 'dAppAddToken'){
                const d = message?.data || {};
                return `${type}:${src}:${String(d.contract || '')}`;
            }
            return `${type}:${src}`;
        } catch(_) { return `${type}:unknown`; }
    }
    function addPending(key, sendResponse){
        const entry = pendingRequests.get(key) || { responses: [], timer: null };
        entry.responses.push(sendResponse);
        if (!entry.timer){
            entry.timer = setTimeout(() => { pendingRequests.delete(key); }, 120000);
        }
        pendingRequests.set(key, entry);
    }
    function resolvePending(key, payload){
        const entry = pendingRequests.get(key);
        if (!entry) return;
        for (const resp of entry.responses){
            try { resp(payload); } catch(_) {}
        }
        clearTimeout(entry.timer);
        pendingRequests.delete(key);
    }

    // Listen for messages from the background script
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'getWalletInfo') {
            sendResponse({address: publicKey, locked: locked, chainId: CHAIN_ID});
        }
        if (message.type === 'dAppSendTransaction') {
            const key = requestKey('dAppSendTransaction', message);
            if (pendingRequests.has(key)) {
                addPending(key, sendResponse);
                return true; // do not open another window
            }
            // wrap response to fan-out to duplicates
            const wrappedResponse = (payload) => { resolvePending(key, payload); };
            addPending(key, sendResponse);
            if (locked) {
                wrappedResponse({errors: ['Wallet is locked']});
                return;
            }
            message.data.chainId = CHAIN_ID;
            createExternalWindow('request-transaction', message, wrappedResponse);
            
        }
        if (message.type === 'dAppSignMessage') {
            const key = requestKey('dAppSignMessage', message);
            if (pendingRequests.has(key)) {
                addPending(key, sendResponse);
                return true;
            }
            const wrappedResponse = (payload) => { resolvePending(key, payload); };
            addPending(key, sendResponse);
            // We expect the message to be a string that cannot be parsed as JSON
            if (isUnsafe(message.data.message)) {
                wrappedResponse({errors: ['Invalid message']});
                return;
            }

            if (locked) {
                wrappedResponse({errors: ['Wallet is locked']});
                return;
            }
            createExternalWindow('request-signature', message, wrappedResponse);
            
        }
        if (message.type === 'dAppAddToken') {
            const key = requestKey('dAppAddToken', message);
            if (pendingRequests.has(key)) {
                addPending(key, sendResponse);
                return true;
            }
            const wrappedResponse = (payload) => { resolvePending(key, payload); };
            addPending(key, sendResponse);
            if (locked) {
                wrappedResponse({errors: ['Wallet is locked']});
                return;
            }
            createExternalWindow('request-token', message, wrappedResponse);
            
        }

        return true;
    });
}