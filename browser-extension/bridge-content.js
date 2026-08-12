(() => {
  "use strict";
  const MARKER = "__FOMO_KOL_BRIDGE_V1__";
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = event.data;
    if (!message || message.marker !== MARKER || !["alert", "status"].includes(message.kind)) return;
    chrome.runtime.sendMessage({ source: "fomo-web", kind: message.kind, data: message.data }).catch(() => {});
  });
})();
