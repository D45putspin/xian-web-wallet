var app_page = "get-started";
var app_box = document.getElementById("app-box");
var publicKey = "";
var unencryptedPrivateKey = null;
var locked = true;
var tx_history = JSON.parse(localStorage.getItem("tx_history")) || [];

// Session management (persist session in chrome.storage.local with localStorage fallback)
const SESSION_TIMEOUT_MINUTES = 30; // Keep unlocked for 30 minutes
const SESSION_KEY = 'wallet_session';

async function getSessionData(){
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local){
      return await new Promise(resolve => chrome.storage.local.get(SESSION_KEY, data => resolve(data[SESSION_KEY] || {})));
    }
  } catch(e) {}
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || '{}'); } catch(e) { return {}; }
}

async function setSessionData(sessionData){
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local){
      await new Promise(resolve => chrome.storage.local.set({ [SESSION_KEY]: sessionData }, resolve));
      return;
    }
  } catch(e) {}
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(sessionData)); } catch(e) {}
}

async function removeSessionData(){
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local){
      await new Promise(resolve => chrome.storage.local.remove(SESSION_KEY, resolve));
      return;
    }
  } catch(e) {}
  try { localStorage.removeItem(SESSION_KEY); } catch(e) {}
}

async function isSessionValidAsync() {
  try {
    const sessionData = await getSessionData();
    if (!sessionData.timestamp || !sessionData.publicKey) return false;
    const now = Date.now();
    const sessionAge = (now - sessionData.timestamp) / (1000 * 60); // minutes
    return sessionAge < SESSION_TIMEOUT_MINUTES && sessionData.publicKey === publicKey;
  } catch(e) {
    return false;
  }
}

async function updateSession() {
  if (publicKey && !locked) {
    try {
      const existing = await getSessionData();
      await setSessionData({ ...existing, timestamp: Date.now(), publicKey });
    } catch(e) {}
  }
}

// Update walletInfo in Chrome storage for dApp communication
async function updateWalletInfo() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      const walletInfo = {
        address: publicKey || '',
        locked: !!locked,
        chainId: (typeof CHAIN_ID !== 'undefined' ? CHAIN_ID : '') || ''
      };
      chrome.storage.local.set({ walletInfo });
      console.log('Updated walletInfo in Chrome storage:', walletInfo);
    }
  } catch(e) {
    console.error('Failed to update walletInfo:', e);
  }
}

async function clearSession() {
  await removeSessionData();
}

// Try to restore session without password if valid
async function tryRestoreSession() {
  if (!(await isSessionValidAsync())) return false;
  
  try {
    const sessionData = await getSessionData();
    const [storedPublicKey, storedEncryptedKey] = await Promise.all([
      readSecureCookie('publicKey'),
      readSecureCookie('encryptedPrivateKey')
    ]);
    
    if (sessionData.publicKey === storedPublicKey && sessionData.unencryptedKey) {
      // Convert hex string back to Uint8Array if needed
      let restoredKey = sessionData.unencryptedKey;
      if (typeof restoredKey === 'string') {
        restoredKey = fromHexString(restoredKey);
      }
      
      // Restore from session
      unencryptedPrivateKey = restoredKey;
      publicKey = storedPublicKey;
      locked = false;
      updateSession();
      
      // Update walletInfo in Chrome storage for dApp communication
      if (typeof updateWalletInfo === 'function') {
        updateWalletInfo();
      }
      
      return true;
    }
  } catch(e) {
    console.error('Session restore failed:', e);
    await clearSession();
  }
  return false;
}

// Store encrypted private key in session for quick restore
async function storeSessionKey(unencryptedKey) {
  if (!publicKey || !unencryptedKey) return;
  try {
    // Convert Uint8Array to hex string for storage
    let keyToStore = unencryptedKey;
    if (unencryptedKey instanceof Uint8Array) {
      keyToStore = toHexString(unencryptedKey);
    }
    
    const sessionData = {
      timestamp: Date.now(),
      publicKey: publicKey,
      unencryptedKey: keyToStore
    };
    await setSessionData(sessionData);
    console.log('Session stored for wallet:', publicKey.substring(0, 8) + '...');
  } catch(e) {
    console.error('Failed to store session:', e);
  }
}
var sendResponse = null;
var externalWindows = {}; // Track multiple external windows by type
var lastExternal = { page: null, data: null, send_response: null };

var callbacks = {};
var callbackId = 0;

function popup_params(width, height) {
  var a = typeof window.screenX != 'undefined' ? window.screenX : window.screenLeft;
  var i = typeof window.screenY != 'undefined' ? window.screenY : window.screenTop;
  var g = typeof window.outerWidth!='undefined' ? window.outerWidth : document.documentElement.clientWidth;
  var f = typeof window.outerHeight != 'undefined' ? window.outerHeight: (document.documentElement.clientHeight - 22);
  var h = (a < 0) ? window.screen.width + a : a;
  var left = parseInt(h + ((g - width) / 2), 10);
  var top = parseInt(i + ((f-height) / 2.5), 10);
  return 'width=' + width + ',height=' + height + ',left=' + left + ',top=' + top + ',scrollbars=1';
}   

function createExternalWindow(page, some_data = null, send_response = null) {
  lastExternal = { page: page, data: some_data, send_response: send_response };
  const loadHtmlAndScripts = (htmlPath) => {
    fetch(htmlPath)
      .then((response) => response.text())
      .then((htmlContent) => {
        // Check if we already have a window for this page type
        let targetWindow = externalWindows[page];
        if (!targetWindow || targetWindow.closed) {
          targetWindow = window.open("index-external.html", `xian-${page}`, "width=400,height=600," + popup_params(400, 600));
          externalWindows[page] = targetWindow;
          
          let loaded = false;
          targetWindow.onload = () => {
            if (loaded) return; // Prevent duplicate onload execution
            loaded = true;
            try { targetWindow.__XIAN_EXTERNAL_REQUEST__ = true; } catch(e) {}
            targetWindow.postMessage({
              type: "HTML",
              html: htmlContent
            }, "*");
            sendInitialState();
            sendPageSpecificMessage(page, some_data);
          };
        } else {
          // Reusing existing window
          targetWindow.focus();
          targetWindow.postMessage({
            type: "HTML",
            html: htmlContent
          }, "*");
          sendInitialState();
          sendPageSpecificMessage(page, some_data);
        }
      });
  };

  const sendInitialState = () => {
    const targetWindow = externalWindows[page];
    if (!targetWindow || targetWindow.closed) return;
    targetWindow.postMessage({
      type: "INITIAL_STATE",
      state: { publicKey, unencryptedPrivateKey, locked, tx_history }
    }, "*");
  };

  const sendPageSpecificMessage = (page, some_data) => {
    const targetWindow = externalWindows[page];
    if (!targetWindow || targetWindow.closed) return;
    if (send_response) {
      const callbackKey = 'callback_' + (callbackId++);
      callbacks[callbackKey] = send_response;
      let type = "";
      if (page === "request-transaction") {
        type = "REQUEST_TRANSACTION";
      } else if (page === "request-signature") {
        type = "REQUEST_SIGNATURE";
      }
      else if (page === "request-token") {
        type = "REQUEST_TOKEN";
      }
      if (type) {
        targetWindow.postMessage({
          type: type,
          data: JSON.parse(JSON.stringify(some_data)),
          callbackKey: callbackKey
        }, "*");
      }
    }
  };

  switch (page) {
    case "request-transaction":
      loadHtmlAndScripts("templates/request-transaction.html");
      break;
    case "request-signature":
      loadHtmlAndScripts("templates/request-signature.html");
      break;
    case "request-token":
      loadHtmlAndScripts("templates/request-token.html");
      break;
    default:
      break;
  }
}

// Handshake from external window ensures scripts/listeners are ready before we push content
window.addEventListener('message', (evt) => {
  if (evt && evt.data && evt.data.type === 'EXTERNAL_READY') {
    console.log('Main window received EXTERNAL_READY, sending content...');
    try {
      // Find which window sent the ready message
      let readyWindow = null;
      let readyPage = null;
      for (const [page, win] of Object.entries(externalWindows)) {
        if (win && !win.closed && win === evt.source) {
          readyWindow = win;
          readyPage = page;
          break;
        }
      }
      if (!readyWindow || !readyPage) return;
      // Re-send HTML and initial state for the ready window's page
      const map = {
        'request-transaction': 'templates/request-transaction.html',
        'request-signature': 'templates/request-signature.html',
        'request-token': 'templates/request-token.html'
      };
      const htmlPath = map[readyPage];
      if (!htmlPath) return;
      fetch(htmlPath)
        .then((response) => response.text())
        .then((htmlContent) => {
          readyWindow.postMessage({ type: 'HTML', html: htmlContent }, '*');
          readyWindow.postMessage({ type: 'INITIAL_STATE', state: { publicKey, unencryptedPrivateKey, locked, tx_history } }, '*');
          let type = '';
          if (readyPage === 'request-transaction') type = 'REQUEST_TRANSACTION';
          else if (readyPage === 'request-signature') type = 'REQUEST_SIGNATURE';
          else if (readyPage === 'request-token') type = 'REQUEST_TOKEN';
          if (type && lastExternal.send_response) {
            const callbackKey = 'callback_' + (callbackId++);
            callbacks[callbackKey] = lastExternal.send_response;
            readyWindow.postMessage({ type, data: JSON.parse(JSON.stringify(lastExternal.data)), callbackKey }, '*');
          }
        });
    } catch(e) {}
  }
});

window.addEventListener("message", (event) => {
  if (event.data.type === "REQUEST_TRANSACTION") {
    const some_data = event.data.data;
    const callbackKey = event.data.callbackKey;
    if (callbacks[callbackKey] && typeof callbacks[callbackKey] === 'function') {
      callbacks[callbackKey](event.data.data);
      delete callbacks[callbackKey];
    }
    // Do not auto-navigate the main app upon request completion to avoid UX jumps
    try { tx_history = JSON.parse(localStorage.getItem("tx_history")) || []; } catch(_) { tx_history = []; }
  }
  if (event.data.type === "REQUEST_SIGNATURE") {
    const some_data = event.data.data;
    const callbackKey = event.data.callbackKey;
    if (callbacks[callbackKey] && typeof callbacks[callbackKey] === 'function') {
      callbacks[callbackKey](event.data.data);
      delete callbacks[callbackKey];
    }
    toast('success', 'Successfully signed message');
  }
  if (event.data.type === "REQUEST_TOKEN") {
    const some_data = event.data.data;
    const callbackKey = event.data.callbackKey;
    if (callbacks[callbackKey] && typeof callbacks[callbackKey] === 'function') {
      callbacks[callbackKey](event.data.data);
      delete callbacks[callbackKey];
    }
    token_list = JSON.parse(localStorage.getItem("token_list")) || ["currency"];
    if (app_page == "wallet"){
      changePage("settings");
    }
  }
});

function sideNavActive() {
  try {
    if (app_page === "wallet") {
      document.getElementById("side-change-page-wallet").classList.add("active-side-nav");
      document.getElementById("side-change-page-ide").classList.remove("active-side-nav");
      document.getElementById("side-change-page-insights").classList.remove("active-side-nav");
      document.getElementById("side-change-page-ecosystem-news").classList.remove("active-side-nav");
      document.getElementById("side-change-page-settings").classList.remove("active-side-nav");
      document.getElementById("side-change-page-messenger").classList.remove("active-side-nav");
    }
    else if (app_page === "ide") {
      document.getElementById("side-change-page-wallet").classList.remove("active-side-nav");
      document.getElementById("side-change-page-ide").classList.add("active-side-nav");
      document.getElementById("side-change-page-insights").classList.remove("active-side-nav");
      document.getElementById("side-change-page-ecosystem-news").classList.remove("active-side-nav");
      document.getElementById("side-change-page-settings").classList.remove("active-side-nav");
      document.getElementById("side-change-page-messenger").classList.remove("active-side-nav");
    }
    else if (app_page === "insights") {
      document.getElementById("side-change-page-wallet").classList.remove("active-side-nav");
      document.getElementById("side-change-page-ide").classList.remove("active-side-nav");
      document.getElementById("side-change-page-insights").classList.add("active-side-nav");
      document.getElementById("side-change-page-ecosystem-news").classList.remove("active-side-nav");
      document.getElementById("side-change-page-settings").classList.remove("active-side-nav");
      document.getElementById("side-change-page-messenger").classList.remove("active-side-nav");
    }
    else if (app_page === "ecosystem-news") {
      document.getElementById("side-change-page-wallet").classList.remove("active-side-nav");
      document.getElementById("side-change-page-ide").classList.remove("active-side-nav");
      document.getElementById("side-change-page-insights").classList.remove("active-side-nav");
      document.getElementById("side-change-page-ecosystem-news").classList.add("active-side-nav");
      document.getElementById("side-change-page-settings").classList.remove("active-side-nav");
      document.getElementById("side-change-page-messenger").classList.remove("active-side-nav");
    }
    else if (app_page === "settings") {
      document.getElementById("side-change-page-wallet").classList.remove("active-side-nav");
      document.getElementById("side-change-page-ide").classList.remove("active-side-nav");
      document.getElementById("side-change-page-insights").classList.remove("active-side-nav");
      document.getElementById("side-change-page-ecosystem-news").classList.remove("active-side-nav");
      document.getElementById("side-change-page-settings").classList.add("active-side-nav");
      document.getElementById("side-change-page-messenger").classList.remove("active-side-nav");
    }
    else if (app_page === "messenger") {
      document.getElementById("side-change-page-wallet").classList.remove("active-side-nav");
      document.getElementById("side-change-page-ide").classList.remove("active-side-nav");
      document.getElementById("side-change-page-insights").classList.remove("active-side-nav");
      document.getElementById("side-change-page-ecosystem-news").classList.remove("active-side-nav");
      document.getElementById("side-change-page-settings").classList.remove("active-side-nav");
      document.getElementById("side-change-page-messenger").classList.add("active-side-nav");
    }
    
  } catch (error) {
    console.log(error);
  }
}

function changePage(page, some_data = null, send_response = null) {
  try { if (typeof sendEventGA === 'function') sendEventGA("page_view", {engagement_time_msec: 100, page_title: page, page_location: page}); } catch(_) {}
  app_page = page;
  sideNavActive();
  const loadHtmlAndScripts = (htmlPath) => {
    fetch(htmlPath)
      .then((response) => response.text())
      .then((htmlContent) => insertHTMLAndExecuteScripts(app_box, htmlContent))
      .then(() => {
        lucide.createIcons();
        if (page === "send-token")
          document.getElementById("tokenName").innerHTML = some_data;
        else if (page === "request-transaction") {
          document.getElementById("requestTransactionContract").innerHTML =
            some_data["data"]["contract"];
          document.getElementById("requestTransactionFunction").innerHTML =
            some_data["data"]["method"];
          document.getElementById("requestTransactionParams").innerHTML =
            JSON.stringify(some_data["data"]["kwargs"]);
          document.getElementById("requestTransactionStampLimit").innerHTML =
            some_data["data"]["stampLimit"];
            sendResponse = send_response;
        }
        else if(page === "request-signature"){
          document.getElementById("requestSignatureMessage").innerHTML = some_data["data"]["message"];
          sendResponse = send_response;
        }
        else if (page === "request-token") {
          document.getElementById("requestTokenMessage").innerHTML = some_data;
          sendResponse = send_response;
        }
        else if (page === "password-input" || page === "create-wallet" || page === "import-wallet" || page === "get-started") {
          document.getElementsByClassName("side-nav")[0].style.display = "none";
          if (window.innerWidth > 768) {
            document.getElementsByClassName("app-box")[0].style.borderTopLeftRadius = "8px";
            document.getElementsByClassName("app-box")[0].style.borderBottomLeftRadius = "8px";
           
          }
          else{
            document.getElementsByClassName("app-box")[0].style.borderTopLeftRadius = "8px";
            document.getElementsByClassName("app-box")[0].style.borderTopRightRadius = "8px";
          }
          document.getElementsByClassName("app-box")[0].style.borderLeftWidth = "1px";
        }
        else{
          document.getElementsByClassName("side-nav")[0].style.display = "flex";
          if (window.innerWidth > 768) {
            document.getElementsByClassName("app-box")[0].style.borderLeftWidth = "0px";
           
            document.getElementsByClassName("app-box")[0].style.borderTopLeftRadius = "0px";
            document.getElementsByClassName("app-box")[0].style.borderTopRightRadius = "8px";
            document.getElementsByClassName("app-box")[0].style.borderBottomLeftRadius = "0px";
            document.getElementsByClassName("side-nav")[0].style.borderBottomLeftRadius = "8px";
            document.getElementsByClassName("side-nav")[0].style.borderTopRightRadius = "0px";
            document.getElementsByClassName("side-nav")[0].style.borderBottomWidth = "1px";
          }
          else{
            document.getElementsByClassName("app-box")[0].style.borderTopLeftRadius = "0px";
            document.getElementsByClassName("app-box")[0].style.borderTopRightRadius = "0px";
            document.getElementsByClassName("app-box")[0].style.borderBottomLeftRadius = "8px";
            document.getElementsByClassName("app-box")[0].style.borderLeftWidth = "1px";
            document.getElementsByClassName("side-nav")[0].style.borderTopRightRadius = "8px";
            document.getElementsByClassName("side-nav")[0].style.borderBottomLeftRadius = "0px";
            document.getElementsByClassName("side-nav")[0].style.borderBottomWidth = "0px";
          }
        }
      });
  };

  switch (app_page) {
    case "get-started":
      loadHtmlAndScripts("templates/get-started.html");
      break;
    case "create-wallet":
      loadHtmlAndScripts("templates/create-wallet.html");
      break;
    case "import-wallet":
      loadHtmlAndScripts("templates/import-wallet.html");
      break;
    case "wallet":
      loadHtmlAndScripts("templates/wallet.html");
      break;
    case "password-input":
      loadHtmlAndScripts("templates/password-input.html");
      break;
    case "send-token":
      loadHtmlAndScripts("templates/send-token.html");
      break;
    case "receive-token":
      loadHtmlAndScripts("templates/receive-token.html");
      break;
    case "settings":
      loadHtmlAndScripts("templates/settings.html");
      break;
    case "send-advanced-transaction":
      loadHtmlAndScripts("templates/advanced-transaction.html");
      break;
    case "add-to-token-list":
      loadHtmlAndScripts("templates/add-to-token-list.html");
      break;
    case "ide":
      loadHtmlAndScripts("templates/ide.html");
      break;
    case "request-transaction":
      loadHtmlAndScripts("templates/request-transaction.html");
      break;
    case "insights":
      loadHtmlAndScripts("templates/insights.html");
      break;
    case "new-proposal":
      loadHtmlAndScripts("templates/new-proposal.html");
      break;
    case "request-signature":
      loadHtmlAndScripts("templates/request-signature.html");
      break;
    case "ecosystem-news":
      loadHtmlAndScripts("templates/ecosystem-news.html");
      break;
    case "create-token":
      loadHtmlAndScripts("templates/create-token.html");
      break;
    case "messenger":
      loadHtmlAndScripts("templates/messenger.html");
      break;
    default:
      break;
  }
}

function insertHTMLAndExecuteScripts(container, htmlContent) {
  container.innerHTML = htmlContent;
  const scripts = container.querySelectorAll("script");

  // Identify and remove previously loaded scripts to prevent duplicates
  const oldScripts = document.querySelectorAll('script[data-script="dynamic"]');
  oldScripts.forEach(script => script.remove());

  scripts.forEach((originalScript) => {
    if (originalScript.src) {
      const script = document.createElement("script");
      script.src = originalScript.src;
      script.setAttribute('data-script', 'dynamic'); // Mark script for identification
      script.onload = () => {
        console.log(`Script loaded: ${script.src}`);
      };
      document.head.appendChild(script);
    } else {
      console.warn("Inline script execution is blocked by CSP");
    }
  });
}


document.addEventListener("DOMContentLoaded", (event) => {
  if (document.getElementById("onlineStatus") == null) {
    return;
  }
  let online_status_element = document.getElementById("onlineStatus");

  ping().then(online_status => {
        
        if (!online_status) {
            online_status_element.innerHTML = "<div class='mt-1px'><div class='offline-circle' title='Node is Offline'></div></div> <div>" + RPC.replace("https://", "").replace("http://", "") + "</div>";
        }
        else {
            online_status_element.innerHTML = "<div class='mt-1px'><div class='online-circle' title='Node is Online'></div></div> <div>" + RPC.replace("https://", "").replace("http://", "") + "</div>";
        }
        }).catch(error => {
        online_status_element.innerHTML = "<div class='mt-1px'><div class='offline-circle' title='Node is Offline'></div></div> <div>" + RPC.replace("https://", "").replace("http://", "") + "</div>";
    });

    getChainID().then(chain_id => {
      CHAIN_ID = chain_id;
  });

  Promise.all([
    readSecureCookie("publicKey"),
    readSecureCookie("encryptedPrivateKey"),
  ]).then((values) => {
  // Set global publicKey for session validation
  publicKey = values[0] || '';
  
  // Check if this is a background tab handling dApp requests
  let isBackgroundDappTab = !document.hasFocus() && document.visibilityState === 'hidden';
  let didNavigateOnVisible = false;
  const navigateWhenVisible = (targetPage) => {
    if (didNavigateOnVisible) return;
    const handler = () => {
      if (document.visibilityState === 'visible' || document.hasFocus()) {
        if (!didNavigateOnVisible) {
          didNavigateOnVisible = true;
          try { changePage(targetPage); } catch(e) {}
        }
        document.removeEventListener('visibilitychange', handler);
        window.removeEventListener('focus', handler);
      }
    };
    document.addEventListener('visibilitychange', handler);
    window.addEventListener('focus', handler);
  };
  
  if (
    values[0] &&
    values[1] &&
    unencryptedPrivateKey != null
  ) {
    updateSession();
    // Don't auto-navigate to wallet if this is a background dApp handling tab
    if (!isBackgroundDappTab) {
      changePage("wallet");
    } else {
      navigateWhenVisible("wallet");
    }
  } else if (
    values[0] &&
    values[1] &&
    unencryptedPrivateKey == null
  ) {
    // Check if we have a valid session to skip password input
    console.log('Checking session for wallet:', values[0] ? values[0].substring(0, 8) + '...' : 'none');
    tryRestoreSession().then(restored => {
      if (restored) {
        console.log('Session restored successfully');
        // Don't auto-navigate to wallet if this is a background dApp handling tab
        if (!isBackgroundDappTab) {
          changePage("wallet");
        } else {
          navigateWhenVisible("wallet");
        }
      } else {
        console.log('Session restore failed, going to password input');
        if (!isBackgroundDappTab) {
          changePage("password-input");
        } else {
          navigateWhenVisible("password-input");
        }
      }
    }).catch((e) => {
      console.error('Session restore error:', e);
      if (!isBackgroundDappTab) {
        changePage("password-input");
      } else {
        navigateWhenVisible("password-input");
      }
    });
  } else {
    if (!isBackgroundDappTab) {
      changePage("get-started");
    } else {
      navigateWhenVisible("get-started");
    }
  }
  });

});