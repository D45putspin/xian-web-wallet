var callbackKey = null;
// Mark this window as an external request shell by default; extension popup will override
try { window.__XIAN_EXTERNAL_REQUEST__ = true; } catch(e) {}

// lite mode toggle removed

function injectHTMLWithScripts(container, htmlContent){
  try {
    container.innerHTML = htmlContent;
    const scripts = container.querySelectorAll('script');
    scripts.forEach((originalScript) => {
      if (originalScript.src) {
        const script = document.createElement('script');
        script.src = originalScript.src;
        script.setAttribute('data-script', 'dynamic');
        document.head.appendChild(script);
      }
    });
  } catch(e) { console.error('Failed to inject HTML:', e); }
}
window.addEventListener("message", (event) => {
    if (event.data.type === "HTML") {
      insertHTMLAndExecuteScripts(document.getElementById("app-box"), event.data.html);
    }
    if (event.data.type === "INITIAL_STATE") {
      publicKey = event.data.state.publicKey;
      unencryptedPrivateKey = event.data.state.unencryptedPrivateKey;
      locked = event.data.state.locked;
      tx_history = event.data.state.tx_history;
    }
    if (event.data.type === "REQUEST_TRANSACTION") {
      const some_data = event.data.data;
      callbackKey = event.data.callbackKey;
      
      // Wait for DOM to be ready before accessing elements
      const updateTransactionElements = () => {
        const contractEl = document.getElementById("requestTransactionContract");
        const functionEl = document.getElementById("requestTransactionFunction");
        const paramsEl = document.getElementById("requestTransactionParams");
        const stampLimitEl = document.getElementById("requestTransactionStampLimit");
        const chainIdEl = document.getElementById("requestTransactionChainId");
        
        if (contractEl && functionEl && paramsEl && stampLimitEl && chainIdEl) {
          contractEl.innerHTML = some_data["data"]["contract"];
          functionEl.innerHTML = some_data["data"]["method"];
          paramsEl.innerHTML = JSON.stringify(some_data["data"]["kwargs"]);
          stampLimitEl.innerHTML = some_data["data"]["stampLimit"];
          chainIdEl.innerHTML = some_data["data"]["chainId"];
        } else {
          // Retry after a short delay if elements not found
          setTimeout(updateTransactionElements, 100);
        }
      };
      
      updateTransactionElements();
    }
    if (event.data.type === "REQUEST_SIGNATURE") {
      const some_data = event.data.data;
      callbackKey = event.data.callbackKey;
      document.getElementById("requestSignatureMessage").innerHTML = some_data["data"]["message"];
    }
    if (event.data.type === "REQUEST_TOKEN") {
      const some_data = event.data.data;
      callbackKey = event.data.callbackKey;
      document.getElementById("requestTokenMessage").innerHTML = some_data["data"]["contract"];
      getTokenInfo(some_data["data"]["contract"]).then(token_info => {
        document.getElementById("requestTokenName").innerHTML = token_info.name;
        document.getElementById("requestTokenSymbol").innerHTML = token_info.symbol;
      });
    }
  });

// Check if running as extension popup vs transaction request window
function isExtensionPopup() {
  try {
    return !window.opener && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
  } catch(e) {
    return false;
  }
}

// If this is an extension popup, initialize the wallet interface directly
if (isExtensionPopup()) {
  try { window.__XIAN_EXTERNAL_REQUEST__ = false; } catch(e) {}
  console.log('Running as extension popup, initializing wallet...');
  document.addEventListener('DOMContentLoaded', () => {
    // lite mode toggle removed
    try {
      const btn = document.getElementById('openFull');
      if (btn) {
        btn.addEventListener('click', () => {
          try { chrome.runtime.sendMessage({ type: 'OPEN_APP_TAB' }); } catch(_) {}
          window.close();
        });
      }
    } catch(_) {}
    // Initialize wallet state from storage
    Promise.all([
      readSecureCookie("publicKey"),
      readSecureCookie("encryptedPrivateKey"),
    ]).then((values) => {
      // Persist lightweight walletInfo for background quick connect
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local){
          chrome.storage.local.set({ walletInfo: { address: values[0] || '', locked: !!locked, chainId: CHAIN_ID || '' } });
        }
      } catch(e) {}
      // Backwards-compat: if we have active cookies but wallet list empty, register it
      try {
        if (typeof WalletManager !== 'undefined'){
          const listRaw = localStorage.getItem('wallets');
          const list = listRaw ? JSON.parse(listRaw) : [];
          if (values[0] && values[1] && (!Array.isArray(list) || list.length === 0)){
            WalletManager.addOrUpdateWallet(values[0], values[1]);
          }
        }
      } catch(e) {}
      
      // Set global publicKey for session validation
      publicKey = values[0] || '';
      
      if (values[0] && values[1] && unencryptedPrivateKey != null) {
        if (typeof updateSession === 'function') updateSession();
        changePage("wallet");
      } else if (values[0] && values[1] && unencryptedPrivateKey == null) {
        // Check if we have a valid session and try to restore
        console.log('Extension popup checking session for wallet:', values[0] ? values[0].substring(0, 8) + '...' : 'none');
        if (typeof tryRestoreSession === 'function') {
          tryRestoreSession().then(restored => {
            if (restored) {
              console.log('Extension popup: Session restored successfully, going to wallet');
              changePage("wallet");
            } else {
              console.log('Extension popup: Session restore failed, going to password input');
              changePage("password-input");
            }
          }).catch((e) => {
            console.error('Extension popup: Session restore error:', e);
            changePage("password-input");
          });
        } else {
          changePage("password-input");
        }
      } else {
        changePage("get-started");
      }
    });
  });
} else {
  // This is a transaction request window, notify parent and wait for content
  console.log('Running as transaction request window, waiting for parent...');
  
  document.addEventListener('DOMContentLoaded', () => {
    console.log('External window DOM ready, notifying parent...');
    try { window.opener?.postMessage({ type: 'EXTERNAL_READY' }, '*'); } catch(e) { console.error('Failed to notify parent:', e); }
  });

  // Also try immediately in case DOMContentLoaded already fired
  try { 
    console.log('External window script loaded, notifying parent immediately...');
    window.opener?.postMessage({ type: 'EXTERNAL_READY' }, '*'); 
  } catch(e) { console.error('Failed to notify parent immediately:', e); }
}