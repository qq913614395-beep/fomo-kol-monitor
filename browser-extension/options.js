const apiBase = document.querySelector("#apiBase");
const secret = document.querySelector("#secret");
const result = document.querySelector("#result");
const queue = document.querySelector("#queue");
const success = document.querySelector("#success");
const error = document.querySelector("#error");

async function load() {
  const saved = await chrome.storage.local.get(["apiBase", "pairingSecret", "queueSize", "lastSuccessAt", "lastError"]);
  apiBase.value = saved.apiBase || "http://127.0.0.1:8788";
  secret.value = saved.pairingSecret || "";
  queue.textContent = String(saved.queueSize || 0);
  success.textContent = saved.lastSuccessAt ? new Date(saved.lastSuccessAt).toLocaleString() : "—";
  error.textContent = saved.lastError || "—";
}

async function save() {
  const normalized = apiBase.value.trim().replace(/\/$/, "");
  const pairingSecret = secret.value.trim();
  let parsed;
  try { parsed = new URL(normalized); } catch { throw new Error("API 地址格式无效"); }
  const local = parsed.protocol === "http:" && ["127.0.0.1", "localhost"].includes(parsed.hostname) && Boolean(parsed.port);
  const remote = parsed.protocol === "https:" && parsed.pathname === "/" && !parsed.search && !parsed.hash;
  if (!local && !remote) throw new Error("本机使用 localhost HTTP；远程服务器必须使用不带路径的 HTTPS 地址");
  if (pairingSecret.length < 32) throw new Error("配对密钥无效");
  if (remote) {
    const origins = [`${parsed.origin}/*`];
    const granted = await chrome.permissions.contains({ origins }) || await chrome.permissions.request({ origins });
    if (!granted) throw new Error("未授予该服务器域名的访问权限");
  }
  await chrome.storage.local.set({ apiBase: normalized, pairingSecret });
  return { apiBase: normalized, secret: pairingSecret };
}

document.querySelector("#save").addEventListener("click", async () => {
  try { await save(); result.className = "good"; result.textContent = "配置已保存，FOMO 页面保持打开即可接收提醒。"; }
  catch (failure) { result.className = "bad"; result.textContent = failure.message; }
});

document.querySelector("#test").addEventListener("click", async () => {
  result.className = ""; result.textContent = "正在测试…";
  try {
    const config = await save();
    const response = await chrome.runtime.sendMessage({ action: "bridge:test", ...config });
    if (!response?.ok) throw new Error(response?.error || "连接失败");
    result.className = "good"; result.textContent = "连接成功，本机服务已验证签名。";
  } catch (failure) { result.className = "bad"; result.textContent = failure.message; }
  await load();
});

void load();
