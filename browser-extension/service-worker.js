const DEFAULT_API = "http://127.0.0.1:8788";
const MAX_QUEUE = 5000;
let flushing = false;
let timer = null;

function base64UrlBytes(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function hmac(secret, timestamp, rawBody) {
  const key = await crypto.subtle.importKey("raw", base64UrlBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function settings() {
  const saved = await chrome.storage.local.get(["apiBase", "pairingSecret", "queue"]);
  return { apiBase: String(saved.apiBase || DEFAULT_API).replace(/\/$/, ""), secret: String(saved.pairingSecret || ""), queue: Array.isArray(saved.queue) ? saved.queue : [] };
}

async function signedPost(apiBase, secret, payload) {
  const raw = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const signature = await hmac(secret, timestamp, raw);
  const response = await fetch(`${apiBase}/api/v1/ingest/fomo-alerts`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-fomo-timestamp": timestamp, "x-fomo-signature": signature },
    body: raw
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result?.error?.message || `HTTP ${response.status}`);
  return result;
}

async function saveQueue(queue) {
  await chrome.storage.local.set({ queue: queue.slice(-MAX_QUEUE), queueSize: Math.min(queue.length, MAX_QUEUE) });
}

async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    const config = await settings();
    if (!config.secret || !config.queue.length) return;
    const queue = [...config.queue];
    while (queue.length) {
      const first = queue[0];
      if (first.kind === "status") {
        await signedPost(config.apiBase, config.secret, { kind: "status", ...first.data });
        queue.shift();
      } else {
        const batch = queue.filter((item) => item.kind === "alert").slice(0, 100);
        await signedPost(config.apiBase, config.secret, { kind: "alerts", alerts: batch.map((item) => item.data) });
        const sent = new Set(batch.map((item) => item.id));
        for (let index = queue.length - 1; index >= 0; index -= 1) if (sent.has(queue[index].id)) queue.splice(index, 1);
      }
      await saveQueue(queue);
    }
    await chrome.storage.local.set({ lastSuccessAt: new Date().toISOString(), lastError: "" });
  } catch (error) {
    await chrome.storage.local.set({ lastError: String(error.message || error), lastErrorAt: new Date().toISOString() });
  } finally {
    flushing = false;
  }
}

function scheduleFlush(delay = 150) {
  clearTimeout(timer);
  timer = setTimeout(() => { void flush(); }, delay);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action === "bridge:test") {
    signedPost(message.apiBase, message.secret, { kind: "status", state: "connected", pageUrl: "extension-options://connection-test" })
      .then((result) => sendResponse({ ok: true, result })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.source !== "fomo-web" || !["alert", "status"].includes(message.kind)) return false;
  if (!/^https:\/\/([a-z0-9-]+\.)?fomo\.family\//i.test(sender.url || "")) return false;
  settings().then(async (config) => {
    config.queue.push({ id: crypto.randomUUID(), kind: message.kind, data: message.data, capturedAt: new Date().toISOString() });
    await saveQueue(config.queue);
    scheduleFlush();
  }).catch(() => {});
  return false;
});

chrome.alarms.create("flush-fomo-bridge", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === "flush-fomo-bridge") void flush(); });
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
void flush();
