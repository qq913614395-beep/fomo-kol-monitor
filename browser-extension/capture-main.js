(() => {
  "use strict";
  if (window.__FOMO_KOL_BRIDGE_CAPTURED__) return;
  Object.defineProperty(window, "__FOMO_KOL_BRIDGE_CAPTURED__", { value: true });

  const TARGET = "wss://prod-api.fomo.family/ws";
  const HISTORY_PATH = "/feed/tradingActivity";
  const MARKER = "__FOMO_KOL_BRIDGE_V1__";
  const NativeWebSocket = window.WebSocket;
  const scalarKeys = new Set([
    "id", "eventId", "feedId", "type", "eventType", "networkId", "chain",
    "createdAt", "occurredAt", "timestamp", "userId", "traderId", "userHandle",
    "traderHandle", "tokenAddress", "tokenSymbol", "usdAmount", "valueUsd",
    "totalVolume", "usdValue", "txHash", "transactionHash", "signature", "symbol",
    "address", "name"
  ]);
  const objectKeys = new Set(["payload", "data", "body", "token", "authorTrade", "trader", "user", "message"]);

  function clean(value, depth = 0) {
    if (depth > 5 || value == null) return null;
    if (typeof value === "string") return value.slice(0, 2000);
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.slice(0, 100).map((item) => clean(item, depth + 1)).filter((item) => item != null);
    if (typeof value !== "object") return null;
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (scalarKeys.has(key) || objectKeys.has(key)) {
        const sanitized = clean(item, depth + 1);
        if (sanitized != null) result[key] = sanitized;
      }
    }
    return result;
  }

  function topicType(value) {
    return value?.topicType || value?.topic?.topicType || value?.subscription?.topicType || value?.data?.topicType;
  }

  function findTradingActivity(value, depth = 0, found = []) {
    if (!value || typeof value !== "object" || depth > 6 || found.length >= 100) return found;
    if (topicType(value) === "trading_activity") {
      const payload = value.payload ?? value.data?.payload ?? value.data ?? value.message ?? value;
      if (Array.isArray(payload)) found.push(...payload.slice(0, 100 - found.length));
      else found.push(payload);
      return found;
    }
    if (Array.isArray(value)) for (const item of value.slice(0, 100)) findTradingActivity(item, depth + 1, found);
    else for (const item of Object.values(value)) findTradingActivity(item, depth + 1, found);
    return found;
  }

  function findHistoricalActivity(value, depth = 0, found = []) {
    if (!value || typeof value !== "object" || depth > 7 || found.length >= 100) return found;
    const eventType = String(value.type || value.eventType || value.body?.type || "").toLowerCase();
    const hasNetwork = value.networkId != null || value.token?.networkId != null || value.body?.networkId != null || value.authorTrade?.networkId != null;
    const hasToken = value.tokenAddress || value.token?.address || value.body?.tokenAddress || value.authorTrade?.tokenAddress;
    if (eventType && hasNetwork && hasToken) { found.push(value); return found; }
    if (Array.isArray(value)) for (const item of value.slice(0, 100)) findHistoricalActivity(item, depth + 1, found);
    else for (const item of Object.values(value)) findHistoricalActivity(item, depth + 1, found);
    return found;
  }

  function publish(kind, data) {
    window.postMessage({ marker: MARKER, kind, data }, window.location.origin);
  }

  async function inspect(raw) {
    try {
      const text = typeof raw === "string" ? raw : raw instanceof Blob ? await raw.text() : "";
      if (!text || text.length > 2_000_000) return;
      const decoded = JSON.parse(text);
      for (const alert of findTradingActivity(decoded)) {
        const payload = clean(alert);
        if (payload && Object.keys(payload).length) publish("alert", payload);
      }
    } catch {
      // Non-JSON WebSocket frames are not part of the alerts protocol.
    }
  }

  async function inspectHistory(response) {
    try {
      const decoded = await response.clone().json();
      for (const alert of findHistoricalActivity(decoded)) {
        const payload = clean(alert);
        if (payload && Object.keys(payload).length) publish("alert", payload);
      }
    } catch {
      // The page may return an empty or non-JSON response during navigation.
    }
  }

  class ObservedWebSocket extends NativeWebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      if (String(url) !== TARGET) return;
      this.addEventListener("open", () => publish("status", { state: "connected", pageUrl: location.href }));
      this.addEventListener("message", (event) => { void inspect(event.data); });
      this.addEventListener("close", () => publish("status", { state: "disconnected", pageUrl: location.href }));
      this.addEventListener("error", () => publish("status", { state: "error", message: "FOMO WebSocket error", pageUrl: location.href }));
    }
  }
  Object.defineProperties(ObservedWebSocket, {
    CONNECTING: { value: NativeWebSocket.CONNECTING },
    OPEN: { value: NativeWebSocket.OPEN },
    CLOSING: { value: NativeWebSocket.CLOSING },
    CLOSED: { value: NativeWebSocket.CLOSED }
  });
  window.WebSocket = ObservedWebSocket;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    try {
      const requestUrl = typeof args[0] === "string" || args[0] instanceof URL ? String(args[0]) : String(args[0]?.url || "");
      if (new URL(requestUrl, location.href).pathname.endsWith(HISTORY_PATH)) void inspectHistory(response);
    } catch { /* Ignore unrelated requests. */ }
    return response;
  };
})();
