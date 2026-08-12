"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";

const API = process.env.NEXT_PUBLIC_MONITOR_API || "http://127.0.0.1:8788";
const views = [
  ["live", "实时"], ["history", "历史"], ["pending", "待确认"],
  ["audit", "漏单审计"], ["people", "对象"], ["health", "运行状态"],
] as const;
const chains = [["", "全部"], ["solana", "SOL"], ["bsc", "BNB"], ["base", "Base"], ["ethereum", "ETH"]] as const;
const chainNames: Record<string, string> = { solana: "Solana", bsc: "BNB", bnb: "BNB", base: "Base", ethereum: "Ethereum", eth: "Ethereum" };

type View = typeof views[number][0];
type Binding = { id: string; targetId: string; chain: string; address: string; addressType: string; addressRole: string; verificationState: string; desiredState: string; source: string; confidence: number; evidence: Array<Record<string, unknown>>; validFrom?: string; validTo?: string; lastSeenAt?: string; generation: number; runtimeHealth?: string };
type AddressCandidate = { id: string; personId: string; chain: string; address: string; addressRole: string; verificationState: string; source: string; confidence: number; evidence: Array<Record<string, unknown>>; firstSeenAt?: string; lastSeenAt?: string; validFrom?: string; validTo?: string; promotedBindingId?: string };
type Person = { id: string; name: string; handle: string; twitter: string; enabled: boolean; desiredState: string; resolutionState: string; runtimeHealth: string; monitorState: string; bindings: Binding[]; addressCandidates: AddressCandidate[] };
type Trade = { id: string; stableSourceGroupKey?: string; personId?: string; kolIds?: string[]; chain: string; wallet?: string; txHash?: string; signature?: string; userOperationHash?: string; side?: string; token?: { address?: string; symbol?: string; name?: string; imageUrl?: string; pairUrl?: string }; quoteToken?: { address?: string; symbol?: string }; tokenAmount?: string; quoteAmount?: string; valueUsd?: string; legCount?: number; routeLegCount?: number; routeLegs?: Array<Record<string, unknown>>; timestamp?: string; sourceOccurredAt?: string; firstObservedAt?: string; confirmedAt?: string; finalizedAt?: string; signalLatencyMs?: number; confirmationState?: string; origin?: string; finality?: string; lateDetected?: boolean; normalizationVersion?: string; observations?: Array<Record<string, unknown>>; notificationStatus?: string };
type Health = { source: string; state?: string; health?: string; lastAttemptAt?: string; lastSuccessAt?: string; lastTargetEventAt?: string; blockLag?: number; effectivePollIntervalMs?: number; consecutiveFailures?: number; errorCode?: string; errorMessage?: string; reason?: string };
type FomoWebStatus = { configured: boolean; updatedAt?: string; secretMask?: string; transport?: string; authoritative?: boolean; createsTrades?: boolean; createsNotifications?: boolean; source?: Health; summary?: { windowHours: number; total: number; matched: number; appOnly: number; chainOnly: number; lastEventAt?: string; lastReceivedAt?: string } };
type Status = { readiness?: string; storage?: string; integrity?: string; activeTargets?: number; confirmedTrades24h?: number; pending?: number; asOfEventId?: number; localSessionToken?: string; startedAt?: string; config?: { gmgnPollIntervalMs?: number; notifications?: Record<string, boolean>; fomoWeb?: { configured?: boolean } }; fomoWeb?: FomoWebStatus; sourceDetails?: Record<string, Health>; error?: string };
type Reconciliation = { id: string; personId?: string; targetId?: string; chain: string; wallet: string; status: string; sourceComplete: boolean; sourceCount: number; localCount: number; matched: number; missing: number; extra: number; mismatched: number; checkedAt: string; items?: Array<Record<string, unknown>> };
type Operation = { id: string; kind: string; status: string; progress: number; result?: unknown; errorCode?: string; errorMessage?: string };

function short(value = "", left = 7, right = 5) { return value.length > left + right + 2 ? `${value.slice(0, left)}…${value.slice(-right)}` : value || "—"; }
function formatMoney(value?: string) { const number = Number(value || 0); return Number.isFinite(number) ? number.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : value || "0.00"; }
function elapsed(value?: string) { if (!value) return "—"; const ms = Math.max(0, Date.now() - new Date(value).getTime()); if (ms < 60000) return `${Math.round(ms / 1000)}秒`; if (ms < 3600000) return `${Math.round(ms / 60000)}分`; if (ms < 86400000) return `${Math.round(ms / 3600000)}小时`; return `${Math.round(ms / 86400000)}天`; }
function ago(value?: string) { return value ? `${elapsed(value)}前` : "—"; }
function explorer(trade: Trade) { const tx = trade.txHash || trade.signature; if (!tx) return ""; if (trade.chain === "solana") return `https://solscan.io/tx/${tx}`; if (trade.chain === "bsc" || trade.chain === "bnb") return `https://bscscan.com/tx/${tx}`; if (trade.chain === "base") return `https://basescan.org/tx/${tx}`; return `https://etherscan.io/tx/${tx}`; }
function sourceTone(item: Health) { return ["healthy", "connected"].includes(item.health || item.state || "") ? "good" : ["disabled", "starting", "waiting", "unconfigured", "unknown"].includes(item.health || item.state || "") ? "warn" : "bad"; }
const addressRoles = ["source_wallet", "vault", "smart_account", "deposit", "relay", "unknown"] as const;
const monitorableRoles = new Set(["source_wallet", "vault", "smart_account"]);
const roleNames: Record<string, string> = { source_wallet: "来源钱包", vault: "交易金库", smart_account: "智能账户", deposit: "充值地址", relay: "跨链路由", unknown: "待识别" };
function confidence(value = 0) { return `${Math.round(value * 100)}%`; }

export default function Home() {
  const [view, setView] = useState<View>("live");
  const [chain, setChain] = useState("");
  const [status, setStatus] = useState<Status>({});
  const [people, setPeople] = useState<Person[]>([]);
  const [trades, setTrades] = useState<Record<"live" | "history" | "pending", Trade[]>>({ live: [], history: [], pending: [] });
  const [reconciliations, setReconciliations] = useState<Reconciliation[]>([]);
  const [streamConnected, setStreamConnected] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [mode, setMode] = useState<"add" | "import" | "binding">("add");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [confirmingRemove, setConfirmingRemove] = useState("");
  const [selectedTrade, setSelectedTrade] = useState<Trade | null>(null);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);
  const [pairingSecret, setPairingSecret] = useState("");
  const [confirmingFomoRevoke, setConfirmingFomoRevoke] = useState(false);
  const [visibleLimit, setVisibleLimit] = useState(40);
  const [form, setForm] = useState({ handle: "", twitter: "", notes: "", solanaAddress: "", evmAddress: "" });
  const [bindingForm, setBindingForm] = useState({ personId: "", chain: "solana", address: "", addressType: "UNKNOWN", addressRole: "source_wallet" });
  const [importText, setImportText] = useState("handle,twitter,solanaAddress,evmAddress\n");
  const [importPreview, setImportPreview] = useState<{ items: Array<{ action: string; reason?: string; row: Person }>; summary: Record<string, number> } | null>(null);
  const tokenRef = useRef("");
  const notifiedRef = useRef<Set<string>>(new Set());
  const refreshTimer = useRef<number | null>(null);
  const eventCursorRef = useRef(0);

  const request = useCallback(async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    if (init.method && init.method !== "GET") headers.set("x-local-session", tokenRef.current);
    const response = await fetch(`${API}${path}`, { ...init, headers, cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error?.message || payload.error || `HTTP ${response.status}`);
    return payload as T;
  }, []);

  const refresh = useCallback(async () => {
    try {
      const currentStatus = await request<Status>("/api/v1/status");
      tokenRef.current = currentStatus.localSessionToken || tokenRef.current;
      eventCursorRef.current = Math.max(eventCursorRef.current, Number(currentStatus.asOfEventId || 0));
      const [peopleResult, liveResult, historyResult, pendingResult, auditResult] = await Promise.all([
        request<{ items: Person[] }>("/api/v1/people?limit=200"),
        request<{ items: Trade[] }>("/api/v1/trades?view=live&limit=200"),
        request<{ items: Trade[] }>("/api/v1/trades?view=history&limit=200"),
        request<{ items: Trade[] }>("/api/v1/trades?view=pending&limit=200"),
        request<{ items: Reconciliation[] }>("/api/v1/reconciliations?limit=200"),
      ]);
      setStatus(currentStatus); setPeople(peopleResult.items); setTrades({ live: liveResult.items, history: historyResult.items, pending: pendingResult.items }); setReconciliations(auditResult.items);
    } catch (error) { setMessage(`刷新失败：${error instanceof Error ? error.message : String(error)}`); }
  }, [request]);

  const trackOperation = useCallback((operation: Operation) => {
    setOperations((current) => [operation, ...current.filter((item) => item.id !== operation.id)].slice(0, 8));
    const stored = JSON.parse(localStorage.getItem("fomo-operation-ids") || "[]") as string[];
    localStorage.setItem("fomo-operation-ids", JSON.stringify([operation.id, ...stored.filter((id) => id !== operation.id)].slice(0, 12)));
  }, []);

  const processBrowserIntents = useCallback(async () => {
    if (!("Notification" in window) || Notification.permission !== "granted" || !tokenRef.current) return;
    const owner = sessionStorage.getItem("fomo-browser-owner") || crypto.randomUUID();
    sessionStorage.setItem("fomo-browser-owner", owner);
    const result = await request<{ items: Array<{ id: string; trade: Trade }> }>("/api/v1/notification-intents?channel=browser&status=pending");
    for (const intent of result.items) {
      if (notifiedRef.current.has(intent.id)) continue;
      try {
        await request(`/api/v1/notification-intents/${intent.id}:claim`, { method: "POST", body: JSON.stringify({ owner }) });
        const trade = intent.trade; const person = people.find((item) => item.id === trade.personId || trade.kolIds?.includes(item.id));
        new Notification(`${person?.name || person?.handle || "FOMO KOL"} · ${trade.side === "buy" ? "买入" : "卖出"} ${trade.token?.symbol || "Token"}`, { body: `${chainNames[trade.chain] || trade.chain} · $${formatMoney(trade.valueUsd)}`, tag: intent.id });
        notifiedRef.current.add(intent.id);
        await request(`/api/v1/notification-intents/${intent.id}:ack`, { method: "POST", body: JSON.stringify({ status: "delivered", owner }) });
      } catch { /* another tab may have claimed it */ }
    }
  }, [people, request]);

  useEffect(() => {
    const kickoff = window.setTimeout(() => void refresh(), 0);
    const poll = window.setInterval(() => void refresh(), 15000);
    let stream: EventSource | null = null;
    let reconnectTimer: number | null = null;
    let stopped = false;
    const connect = () => {
      if (stopped) return;
      stream = new EventSource(`${API}/api/v1/events/stream?after=${eventCursorRef.current}`);
      stream.addEventListener("ready", () => setStreamConnected(true));
      stream.addEventListener("monitor-event", (raw) => {
        setStreamConnected(true);
        const envelope = JSON.parse((raw as MessageEvent).data);
        eventCursorRef.current = Math.max(eventCursorRef.current, Number(envelope.sequence || 0));
        if (envelope.type === "reset.required") void refresh();
        else {
          if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
          refreshTimer.current = window.setTimeout(() => void refresh(), 250);
          if (envelope.type === "notification.pending") void processBrowserIntents();
        }
      });
      stream.onerror = () => {
        setStreamConnected(false);
        stream?.close();
        reconnectTimer = window.setTimeout(connect, 1500);
      };
    };
    connect();
    return () => { stopped = true; window.clearTimeout(kickoff); window.clearInterval(poll); if (reconnectTimer) window.clearTimeout(reconnectTimer); if (refreshTimer.current) window.clearTimeout(refreshTimer.current); stream?.close(); };
  }, [processBrowserIntents, refresh]);

  useEffect(() => {
    const pollOperations = async () => {
      const ids = JSON.parse(localStorage.getItem("fomo-operation-ids") || "[]") as string[];
      if (!ids.length || !tokenRef.current) return;
      const results = await Promise.all(ids.slice(0, 8).map((id) => request<Operation>(`/api/v1/operations/${id}`).catch(() => null)));
      const valid = results.filter((item): item is Operation => Boolean(item));
      setOperations(valid);
    };
    const timer = window.setInterval(() => void pollOperations(), 1000);
    return () => window.clearInterval(timer);
  }, [request]);

  const filtered = useMemo(() => {
    const source = view === "history" ? trades.history : view === "pending" ? trades.pending : trades.live;
    return chain ? source.filter((item) => item.chain === chain || (chain === "bsc" && item.chain === "bnb")) : source;
  }, [chain, trades, view]);
  const missingCount = reconciliations.filter((item) => item.status === "closed").reduce((sum, item) => sum + item.missing, 0);
  const activeOperations = operations.filter((item) => ["queued", "running", "failed"].includes(item.status)).slice(0, 4);
  const collectorsDisabled = status.sourceDetails?.collectors?.state === "disabled";
  const collectorsActive = ["connected", "healthy"].includes(status.sourceDetails?.collectors?.state || "");
  const gmgnHealthyCount = Object.entries(status.sourceDetails || {}).filter(([key, item]) => key.startsWith("gmgn_") && sourceTone(item) === "good").length;
  const sourcePriority = ["collectors", "gmgn_sol", "gmgn_bsc", "gmgn_base", "gmgn_eth", "fomo_web", "solana_ws", "bsc_ws", "base_ws", "ethereum_ws", "solana_poll", "bsc_poll", "base_poll", "ethereum_poll", "relay", "market"];
  const visibleSources = Object.entries(status.sourceDetails || {}).sort(([left], [right]) => {
    const leftIndex = sourcePriority.indexOf(left); const rightIndex = sourcePriority.indexOf(right);
    return (leftIndex < 0 ? 999 : leftIndex) - (rightIndex < 0 ? 999 : rightIndex) || left.localeCompare(right);
  }).slice(0, 10);
  const selectedPerson = selectedTrade ? people.find((person) => person.id === selectedTrade.personId || selectedTrade.kolIds?.includes(person.id)) : undefined;
  const selectedWallet = selectedTrade?.wallet || selectedPerson?.bindings.find((binding) => binding.chain === selectedTrade?.chain || (selectedTrade?.chain === "bnb" && binding.chain === "bsc"))?.address;

  async function withBusy(key: string, task: () => Promise<void>) {
    setBusy(key); setMessage("");
    try { await task(); await refresh(); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(""); }
  }
  async function addPerson(event: FormEvent) {
    event.preventDefault();
    await withBusy("add", async () => {
      const created = await request<{ operation: Operation }>("/api/v1/people", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(form) });
      trackOperation(created.operation);
      setMessage(form.evmAddress.trim()
        ? `${form.handle || form.twitter} 创建任务已提交；EVM 种子地址将进入候选区，确认链和角色后才监听。`
        : form.solanaAddress.trim()
          ? `${form.handle || form.twitter} 创建任务已提交；Solana 来源钱包将核验并启用。`
          : `${form.handle || form.twitter} 创建任务已提交；当前未解析且不会启动监听。`);
      setForm({ handle: "", twitter: "", notes: "", solanaAddress: "", evmAddress: "" });
    });
  }
  async function previewImport() { await withBusy("preview", async () => { const preview = await request<typeof importPreview>("/api/v1/people/import:preview", { method: "POST", body: JSON.stringify({ text: importText }) }); setImportPreview(preview); setMessage("导入预览已生成，确认后才会写入。"); }); }
  async function commitImport() { await withBusy("import", async () => { const result = await request<{ operation: Operation }>("/api/v1/people/import:commit", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ text: importText }) }); trackOperation(result.operation); setImportPreview(null); setMessage("导入任务已提交，可刷新页面继续查看进度。"); }); }
  async function addBinding(event: FormEvent) { event.preventDefault(); await withBusy("binding", async () => { await request(`/api/v1/people/${bindingForm.personId}/wallet-bindings`, { method: "POST", body: JSON.stringify({ chain: bindingForm.chain, address: bindingForm.address, addressType: bindingForm.addressType, addressRole: bindingForm.addressRole, verificationState: "verified", source: "manual" }) }); setBindingForm({ ...bindingForm, address: "" }); setMessage(monitorableRoles.has(bindingForm.addressRole) ? "已保存为可监听的核验地址。" : "已保存为证据地址；该角色不会启动监听。"); }); }
  async function personAction(person: Person, action: "pause" | "resume" | "backfill" | "resolve") { await withBusy(person.id, async () => { const path = action === "resolve" ? `/api/v1/people/${person.id}/address-resolution` : `/api/v1/people/${person.id}:${action}`; const result = await request<{ operation?: Operation } | Person>(path, { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: "{}" }); if ("operation" in result && result.operation) trackOperation(result.operation); setMessage(action === "pause" ? `${person.name} 已暂停。` : action === "resume" ? `${person.name} 已恢复并建立新通知边界。` : "任务已提交。"); }); }
  async function bindingAction(personId: string, binding: Binding, action: "verify" | "reject" | "toggle") { await withBusy(binding.id, async () => { const path = action === "toggle" ? `/api/v1/people/${personId}/wallet-bindings/${binding.id}` : `/api/v1/people/${personId}/wallet-bindings/${binding.id}:${action}`; await request(path, { method: action === "toggle" ? "PATCH" : "POST", body: action === "toggle" ? JSON.stringify({ desiredState: binding.desiredState === "enabled" ? "disabled" : "enabled" }) : "{}" }); setMessage("钱包绑定状态已更新。"); }); }
  async function candidateAction(personId: string, candidate: AddressCandidate, action: "verify" | "reject") { await withBusy(candidate.id, async () => { await request(`/api/v1/people/${personId}/address-candidates/${candidate.id}:${action}`, { method: "POST", body: "{}" }); setMessage(action === "verify" ? "候选地址已核验，并提升为监听钱包。" : "候选地址已拒绝，不会进入监听。"); }); }
  async function removePerson(person: Person) { if (confirmingRemove !== person.id) { setConfirmingRemove(person.id); setMessage(`再次点击“确认移除 ${person.name}”才会执行；历史证据会保留。`); return; } await withBusy(person.id, async () => { await request(`/api/v1/people/${person.id}`, { method: "DELETE" }); setConfirmingRemove(""); setMessage(`${person.name} 已从当前监听对象移除，历史数据已保留。`); }); }
  async function refreshStatus() { await withBusy("refresh", async () => { const result = await request<{ operation: Operation }>("/api/v1/status:refresh", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: "{}" }); trackOperation(result.operation); setMessage("状态刷新任务已提交。"); }); }
  async function runAudit() { await withBusy("audit", async () => { const result = await request<{ operation: Operation }>("/api/v1/reconciliations", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: "{}" }); trackOperation(result.operation); setMessage("对账任务已提交。"); }); }
  async function pairFomoWeb() {
    if (status.fomoWeb?.configured && !window.confirm("轮换密钥后，现有扩展会立即断开。确定继续吗？")) return;
    await withBusy("fomo-pair", async () => {
      const result = await request<FomoWebStatus & { secret: string }>("/api/v1/fomo-web/pair", { method: "POST", body: "{}" });
      setPairingSecret(result.secret); setConfirmingFomoRevoke(false);
      setMessage("新配对密钥已生成。它只显示这一次，请复制到扩展选项页并测试连接。");
    });
  }
  async function copyPairingSecret() {
    if (!pairingSecret) return setMessage("请先生成配对密钥；已保存的原始密钥不会通过 API 再次返回。");
    try { await navigator.clipboard.writeText(pairingSecret); setMessage("配对密钥已复制。请粘贴到扩展选项页。"); }
    catch { setMessage("浏览器未允许自动复制，请手动选择密钥文本复制。"); }
  }
  async function revokeFomoWeb() {
    if (!confirmingFomoRevoke) { setConfirmingFomoRevoke(true); setMessage("再次点击“确认撤销配对”才会使现有扩展失效。"); return; }
    await withBusy("fomo-revoke", async () => {
      await request("/api/v1/fomo-web/pair", { method: "DELETE" });
      setPairingSecret(""); setConfirmingFomoRevoke(false); setMessage("FOMO Web Bridge 配对已撤销。");
    });
  }
  async function enableBrowserPush() {
    if (!("Notification" in window)) return setMessage("当前浏览器不支持桌面通知，建议配置 Telegram 或 Webhook。");
    const permission = await Notification.requestPermission();
    setMessage(permission === "granted" ? "浏览器通知已开启；新成交将通过 intent claim/ack 只弹一次。" : permission === "denied" ? "浏览器通知被拒绝，请在站点权限中重新开启。" : "尚未授予通知权限。");
    if (permission === "granted") await processBrowserIntents();
  }

  return <main>
    <header className="topbar">
      <div className="brand"><span>ϟ</span><div><strong>FOMO</strong><small>EXACT WALLET RADAR · SQLITE</small></div></div>
      <nav aria-label="主导航">{views.map(([id, label]) => <button key={id} type="button" className={view === id ? "active" : ""} onClick={() => { setView(id); setVisibleLimit(40); }}>{label}</button>)}</nav>
      <div className="top-actions"><button type="button" onClick={() => setCapabilitiesOpen(true)}>功能说明</button><button type="button" onClick={enableBrowserPush}>开启通知</button><button type="button" className="primary-action" onClick={() => setManageOpen(true)}>＋ 添加监控</button></div>
    </header>

    <section className={`mode-banner ${collectorsDisabled ? "sandbox" : status.readiness === "healthy" ? "healthy" : "degraded"}`} aria-label="当前运行模式">
      <div><strong>{collectorsDisabled ? "采集器已关闭" : collectorsActive && status.readiness === "healthy" ? "正在实时监听" : collectorsActive ? "实时监听运行中（部分降级）" : "采集器启动中"}</strong><p>{collectorsDisabled ? "只有页面、SQLite 和 SSE 在运行，不会产生新的实时成交。" : collectorsActive && status.readiness === "healthy" ? "RPC 负责低延迟提示，GMGN 负责方向、资产、金额确认与补漏。" : collectorsActive ? `GMGN ${gmgnHealthyCount}/4 条链健康；红色来源表示公共 RPC、Relay 或市场补全正在限流/超时，不会伪装成全绿。` : "正在建立目标钱包订阅并执行第一次精确钱包轮询。"}</p></div><button type="button" onClick={() => setView("health")}>查看运行状态</button>
    </section>

    <section className="summary" aria-label="监控摘要">
      <button type="button" onClick={() => setView("people")}><span>有效目标</span><strong>{status.activeTargets ?? 0}</strong><small>物理钱包＋链</small></button>
      <button type="button" onClick={() => setView("health")}><span>真实采集器</span><strong>{collectorsDisabled ? "已关闭" : collectorsActive ? "运行中" : "启动中"}</strong><small>GMGN {gmgnHealthyCount}/4 · {status.readiness || "starting"}</small></button>
      <button type="button" onClick={() => setView("live")}><span>24h 确认成交</span><strong>{status.confirmedTrades24h ?? trades.live.length}</strong><small>live + gap recovery</small></button>
      <button type="button" onClick={() => setView("pending")}><span>待确认</span><strong>{status.pending ?? trades.pending.length}</strong><small>仅链上提示</small></button>
    </section>

    <section className="source-strip" aria-label="数据源快捷入口">
      <strong>数据源</strong>{visibleSources.map(([key, item]) => <button type="button" key={key} className={sourceTone(item)} onClick={() => setView("health")}><i />{key.replaceAll("_", " ").toUpperCase()}<small>{item.health || item.state || "unknown"}</small></button>)}
      <span className={missingCount ? "bad" : "good"}>{missingCount} 当前漏单</span>
    </section>

    {!["audit", "people", "health"].includes(view) && <div className="filterbar">
      <div>{chains.map(([id, label]) => <button type="button" key={id || "all"} className={chain === id ? "active" : ""} onClick={() => { setChain(id); setVisibleLimit(40); }}>{label}</button>)}</div>
      <small>精确轮询 {status.config?.gmgnPollIntervalMs || 5000}ms · 金额为 GMGN 确认十进制值</small>
    </div>}

    {message && <div className="toast" role="status"><span>{message}</span><button type="button" aria-label="关闭提示" onClick={() => setMessage("")}>×</button></div>}
    {activeOperations.length > 0 && <section className="operations" aria-label="正在执行的后台任务">{activeOperations.map((item) => <article key={item.id}><span>{item.kind}</span><progress max="100" value={item.progress} /><strong>{item.status}</strong>{item.errorMessage && <small>{item.errorMessage}</small>}</article>)}</section>}

    {(view === "live" || view === "history" || view === "pending") && <section className="feed" aria-label="成交信号">
      <div className="view-title"><div><span>{view === "live" ? "CONFIRMED LIVE TRADES" : view === "history" ? "NON-NOTIFYING HISTORY" : "CHAIN HINTS"}</span><h1>{view === "live" ? "实时确认成交" : view === "history" ? "历史回放" : "待 GMGN 确认"}</h1></div><small>{filtered.length} 条 · 点击查看证据和路由</small></div>
      <div className="trade-head" aria-hidden="true"><span>KOL / 动作</span><span>金额 / 数量</span><span>资产 / 链</span><span>确认状态</span><span>交易</span></div>
      <div className="trade-list">{filtered.slice(0, visibleLimit).map((trade) => {
        const person = people.find((item) => item.id === trade.personId || trade.kolIds?.includes(item.id));
        return <button type="button" className="trade-card" key={trade.id} onClick={() => setSelectedTrade(trade)} aria-label={`查看 ${person?.name || "KOL"} ${trade.side || "待确认"} ${trade.token?.symbol || "交易"}`}>
          <span className="avatar">{(person?.name || "?").slice(0, 1).toUpperCase()}</span><span className="trade-who"><strong>{person?.name || person?.handle || "未知 KOL"}</strong><small>{trade.side === "buy" ? "买入" : trade.side === "sell" ? "卖出" : "链上活动"} · {elapsed(trade.timestamp || trade.firstObservedAt)}前</small></span>
          <span className="trade-amount"><strong>{trade.valueUsd ? `$${formatMoney(trade.valueUsd)}` : "待确认"}</strong><small>{trade.tokenAmount ? `${short(trade.tokenAmount, 12, 6)} ${trade.token?.symbol || ""}` : trade.confirmationState || "pending"}</small></span>
          <span className="trade-token"><strong>{trade.token?.symbol || short(trade.token?.address) || "解析中"}</strong><small>{chainNames[trade.chain] || trade.chain} · {trade.legCount || 0} 成交段 / {trade.routeLegCount || 0} 路由段</small></span>
          <span className={`state-pill ${trade.confirmationState || "pending"}`}>{trade.origin || "live"} · {trade.finality || "observed"}</span>
          <span className="tx-label">TX {short(trade.txHash || trade.signature, 6, 4)}</span>
        </button>;
      })}</div>
      {filtered.length > visibleLimit && <div className="load-more"><button type="button" onClick={() => setVisibleLimit((value) => value + 40)}>显示更多（剩余 {filtered.length - visibleLimit} 条）</button></div>}
      {!filtered.length && <div className="feed-empty"><span>◎</span><strong>{view === "live" ? "暂时没有新的确认成交" : "当前筛选范围没有记录"}</strong><p>{collectorsDisabled && view === "live" ? "这是影子验收环境的预期结果。请到历史页查看真实金额、方向和交易详情。" : "系统不会用模拟数据填充；请查看运行状态确认来源是否健康。"}</p><div><button type="button" onClick={() => setView("history")}>查看历史成交</button><button type="button" onClick={() => setView("health")}>检查运行状态</button></div></div>}
    </section>}

    {view === "audit" && <section className="audit-view"><div className="view-title"><div><span>SET RECONCILIATION</span><h1>漏单与字段一致性审计</h1></div><button type="button" disabled={busy === "audit"} onClick={runAudit}>{busy === "audit" ? "提交中…" : "立即对账"}</button></div>
      <div className="audit-summary"><article><span>审计窗口</span><strong>{reconciliations.length}</strong></article><article><span>Closed</span><strong>{reconciliations.filter((item) => item.status === "closed").length}</strong></article><article className={missingCount ? "bad" : "good"}><span>Closed 缺失</span><strong>{missingCount}</strong></article><article><span>字段不一致</span><strong>{reconciliations.reduce((sum, item) => sum + item.mismatched, 0)}</strong></article></div>
      <div className="audit-table">{reconciliations.map((item) => <article key={item.id}><div><strong>{people.find((person) => person.id === item.personId)?.name || short(item.wallet)}</strong><small>{short(item.wallet, 10, 6)}</small></div><span>{chainNames[item.chain] || item.chain}</span><span className={`state-pill ${item.status}`}>{item.status}</span><span>来源 {item.sourceCount}</span><span>本地 {item.localCount}</span><b className={item.missing || item.mismatched ? "bad" : item.status === "closed" ? "good" : "warn"}>{item.status !== "closed" ? "不可判零漏单" : `缺 ${item.missing} · 差 ${item.mismatched}`}</b><time>{ago(item.checkedAt)}</time></article>)}</div>
      {!reconciliations.length && <div className="panel-empty"><strong>还没有可核验的审计窗口</strong><p>点击“立即对账”后，系统会按钱包、链和固定时间窗口比较 GMGN 来源与本地稳定交易集合。只有来源分页完整且宽限期结束，窗口才会标记 Closed 并判定是否漏单。</p></div>}
    </section>}

    {view === "people" && <section className="follow-view"><div className="view-title"><div><span>MULTI-WALLET SUBSCRIPTIONS</span><h1>监控对象与钱包绑定</h1></div><button type="button" onClick={() => setManageOpen(true)}>+ 导入 KOL</button></div>
      <div className="follow-grid">{people.map((person) => <article key={person.id} className={person.monitorState !== "active" ? "paused" : ""}><div className="follow-card-head"><span className="avatar">{person.name.slice(0, 1).toUpperCase()}</span><div><a href={`https://x.com/${person.twitter || person.handle}`} target="_blank" rel="noopener noreferrer">{person.name}</a><small className={`state-${person.monitorState}`}>{person.monitorState} · {person.resolutionState} · {person.runtimeHealth}</small></div></div>
        <div className="binding-list">{person.bindings.map((binding) => <div key={binding.id}><span>{chainNames[binding.chain] || binding.chain}</span><code title={binding.address}>{short(binding.address, 9, 7)}</code><small><b className={`role-badge ${monitorableRoles.has(binding.addressRole) ? "monitorable" : "evidence"}`}>{roleNames[binding.addressRole] || binding.addressRole}</b> · 第 {binding.generation || 1} 代 · {binding.verificationState} · {binding.desiredState}</small><small className="validity">有效期 {binding.validFrom ? new Date(binding.validFrom).toLocaleDateString() : "—"} → {binding.validTo ? new Date(binding.validTo).toLocaleDateString() : "持续"} · 最近发现 {ago(binding.lastSeenAt)}</small><div>{binding.verificationState === "pending" && <><button type="button" aria-label={`核验 ${person.name} 的 ${chainNames[binding.chain] || binding.chain} 钱包`} disabled={busy === binding.id} onClick={() => bindingAction(person.id, binding, "verify")}>核验</button><button type="button" aria-label={`拒绝 ${person.name} 的 ${chainNames[binding.chain] || binding.chain} 钱包`} disabled={busy === binding.id} onClick={() => bindingAction(person.id, binding, "reject")}>拒绝</button></>}<button type="button" aria-label={`${binding.desiredState === "enabled" ? "停用" : "启用"} ${person.name} 的 ${chainNames[binding.chain] || binding.chain} 钱包`} disabled={busy === binding.id} onClick={() => bindingAction(person.id, binding, "toggle")}>{binding.desiredState === "enabled" ? "停用" : "启用"}</button></div></div>)}</div>
        {person.addressCandidates?.length > 0 && <div className="candidate-section"><div className="candidate-title"><strong>待核验地址</strong><span>{person.addressCandidates.filter((item) => item.verificationState === "pending").length} pending</span></div>{person.addressCandidates.map((candidate) => { const canPromote = candidate.verificationState === "pending" && Boolean(chainNames[candidate.chain]) && monitorableRoles.has(candidate.addressRole); return <article className={`candidate-card ${candidate.verificationState}`} key={candidate.id}><div><span>{chainNames[candidate.chain] || "链待确认"}</span><b>{roleNames[candidate.addressRole] || candidate.addressRole}</b><em>{confidence(candidate.confidence)}</em></div><code title={candidate.address}>{short(candidate.address, 10, 8)}</code><small>{candidate.source} · {candidate.evidence?.length || 0} 条证据 · 最近发现 {ago(candidate.lastSeenAt)}</small>{candidate.verificationState === "pending" && <div className="candidate-actions">{canPromote ? <button type="button" aria-label={`核验 ${person.name} 的候选地址 ${short(candidate.address)}`} disabled={busy === candidate.id} onClick={() => candidateAction(person.id, candidate, "verify")}>核验并监听</button> : <button type="button" onClick={() => { setBindingForm({ personId: person.id, chain: candidate.chain === "unknown" ? "bsc" : candidate.chain, address: candidate.address, addressType: "UNKNOWN", addressRole: candidate.addressRole === "unknown" ? "vault" : candidate.addressRole }); setMode("binding"); setManageOpen(true); }}>补充链与角色</button>}<button type="button" aria-label={`拒绝 ${person.name} 的候选地址 ${short(candidate.address)}`} disabled={busy === candidate.id} onClick={() => candidateAction(person.id, candidate, "reject")}>拒绝</button></div>}</article>; })}</div>}
        {!person.bindings.length && !person.addressCandidates?.length && <p className="unresolved-copy">没有已核验地址或候选证据，不会启动监听。</p>}
        <div className="follow-actions"><button type="button" disabled={busy === person.id} onClick={() => personAction(person, person.enabled ? "pause" : "resume")}>{person.enabled ? "暂停" : "恢复"}</button><button type="button" disabled={busy === person.id} onClick={() => personAction(person, "resolve")}>发现地址</button><button type="button" disabled={busy === person.id || !person.bindings.some((item) => item.verificationState === "verified")} onClick={() => personAction(person, "backfill")}>历史回放</button><button type="button" className={confirmingRemove === person.id ? "confirm-remove" : ""} disabled={busy === person.id} onClick={() => removePerson(person)}>{confirmingRemove === person.id ? `确认移除 ${person.name}` : "移除"}</button></div>
      </article>)}</div>
    </section>}

    {view === "health" && <section className="health-view"><div className="view-title"><div><span>AUTHORITATIVE RUNTIME HEALTH</span><h1>运行状态与降级原因</h1></div><button type="button" disabled={busy === "refresh"} onClick={refreshStatus}>{busy === "refresh" ? "刷新中…" : "立即刷新"}</button></div>
      <div className="health-summary"><article className={streamConnected ? "good" : "bad"}><span>SSE</span><strong>{streamConnected ? "在线" : "重连中"}</strong><small>持久事件游标 {status.asOfEventId || 0}</small></article><article className={status.integrity === "ok" ? "good" : "bad"}><span>SQLite</span><strong>{status.integrity || "unknown"}</strong><small>{status.storage || "—"}</small></article><article><span>服务就绪</span><strong>{status.readiness || "starting"}</strong><small>启动于 {status.startedAt ? new Date(status.startedAt).toLocaleString() : "—"}</small></article></div>
      <article className={`fomo-bridge-card ${sourceTone(status.fomoWeb?.source || { source: "fomo_web", state: status.fomoWeb?.configured ? "waiting" : "unconfigured" })}`}>
        <div className="bridge-intro"><div><span>SECONDARY EVIDENCE · OPTIONAL</span><h2>FOMO Web Bridge</h2><p>链上仍是最快和权威来源。FOMO 提醒只用于核对身份、发现 app-only 漏单证据，不会直接创建成交或通知。</p></div><strong>{status.fomoWeb?.source?.health || status.fomoWeb?.source?.state || (status.fomoWeb?.configured ? "waiting" : "unconfigured")}</strong></div>
        <div className="bridge-metrics"><span><small>24h 匹配</small><b>{status.fomoWeb?.summary?.matched ?? 0}</b></span><span><small>仅 FOMO</small><b>{status.fomoWeb?.summary?.appOnly ?? 0}</b></span><span><small>仅链上</small><b>{status.fomoWeb?.summary?.chainOnly ?? 0}</b></span><span><small>最近提醒</small><b>{ago(status.fomoWeb?.summary?.lastReceivedAt)}</b></span></div>
        <div className="bridge-pairing"><div><label htmlFor="fomo-pair-secret">配对密钥（仅生成时显示）</label><input id="fomo-pair-secret" readOnly value={pairingSecret} placeholder={status.fomoWeb?.configured ? status.fomoWeb.secretMask || "已配置" : "尚未配对"} onFocus={(event) => event.currentTarget.select()} /><small>扩展目录：browser-extension/ · API：{API}</small></div><div className="bridge-actions"><button type="button" disabled={busy === "fomo-pair"} onClick={pairFomoWeb}>{busy === "fomo-pair" ? "生成中…" : status.fomoWeb?.configured ? "轮换配对密钥" : "生成配对密钥"}</button><button type="button" disabled={!pairingSecret} onClick={copyPairingSecret}>复制密钥</button><button type="button" className={confirmingFomoRevoke ? "confirm-remove" : ""} disabled={busy === "fomo-revoke" || !status.fomoWeb?.configured} onClick={revokeFomoWeb}>{busy === "fomo-revoke" ? "撤销中…" : confirmingFomoRevoke ? "确认撤销配对" : "撤销配对"}</button></div></div>
      </article>
      <div className="health-grid">{Object.entries(status.sourceDetails || {}).map(([key, item]) => <article key={key} className={sourceTone(item)}><div><strong>{key.replaceAll("_", " ").toUpperCase()}</strong><span>{item.health || item.state || "unknown"}</span></div><dl><div><dt>最近尝试</dt><dd>{ago(item.lastAttemptAt)}</dd></div><div><dt>最近成功</dt><dd>{ago(item.lastSuccessAt)}</dd></div><div><dt>目标命中</dt><dd>{ago(item.lastTargetEventAt)}</dd></div><div><dt>区块滞后</dt><dd>{item.blockLag ?? "—"}</dd></div><div><dt>有效轮询</dt><dd>{item.effectivePollIntervalMs ? `${item.effectivePollIntervalMs}ms` : "—"}</dd></div><div><dt>连续失败</dt><dd>{item.consecutiveFailures ?? 0}</dd></div></dl>{(item.errorCode || item.errorMessage || (sourceTone(item) === "bad" && item.reason)) && <p><strong>{item.errorCode || "DEGRADED"}</strong>{item.errorMessage || item.reason}</p>}</article>)}</div>
      {status.error && <div className="health-error"><strong>最近错误</strong><span>{status.error}</span></div>}
    </section>}

    {manageOpen && <aside className="manager" aria-label="监控对象管理"><div className="manager-head"><div><span>WATCHLIST</span><strong>监控对象管理</strong></div><button type="button" aria-label="关闭管理面板" onClick={() => setManageOpen(false)}>×</button></div>
      <div className="manager-tabs"><button type="button" className={mode === "add" ? "active" : ""} onClick={() => setMode("add")}>新增</button><button type="button" className={mode === "import" ? "active" : ""} onClick={() => setMode("import")}>批量导入</button><button type="button" className={mode === "binding" ? "active" : ""} onClick={() => setMode("binding")}>添加钱包</button></div>
      {mode === "add" && <form className="compact-form" onSubmit={addPerson}><label><span>FOMO HANDLE</span><input value={form.handle} onChange={(event) => setForm({ ...form, handle: event.target.value })} required /></label><label><span>TWITTER / X</span><input value={form.twitter} onChange={(event) => setForm({ ...form, twitter: event.target.value })} /></label><label><span>SOLANA 来源钱包（可留空）</span><input value={form.solanaAddress} onChange={(event) => setForm({ ...form, solanaAddress: event.target.value })} /></label><label><span>EVM 种子地址（可留空）</span><input value={form.evmAddress} onChange={(event) => setForm({ ...form, evmAddress: event.target.value })} /><small className="field-help">只作为地址发现线索，不会复制到 BNB、Base、Ethereum；确认真实链和执行角色后才监听。</small></label><label><span>备注</span><input value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label><button type="submit" className="submit" disabled={busy === "add"}>{busy === "add" ? "添加中…" : "添加 KOL"}</button></form>}
      {mode === "import" && <div className="import-form"><p>先预览，再提交；大小写和前导 @ 不会创建重复人物。</p><textarea value={importText} onChange={(event) => { setImportText(event.target.value); setImportPreview(null); }} spellCheck={false} />{importPreview && <div className="import-preview"><strong>新增 {importPreview.summary.create || 0} · 更新 {importPreview.summary.update || 0} · 无效 {importPreview.summary.invalid || 0}</strong>{importPreview.items.slice(0, 8).map((item, index) => <small key={index}>{item.action} · {item.row.handle || item.reason}</small>)}</div>}<div className="split-actions"><button type="button" onClick={previewImport} disabled={busy === "preview"}>预览</button><button type="button" className="submit" onClick={commitImport} disabled={busy === "import" || !importPreview}>确认导入</button></div></div>}
      {mode === "binding" && <form className="compact-form" onSubmit={addBinding}><label><span>KOL</span><select value={bindingForm.personId} onChange={(event) => setBindingForm({ ...bindingForm, personId: event.target.value })} required><option value="">选择对象</option>{people.map((person) => <option value={person.id} key={person.id}>{person.name}</option>)}</select></label><label><span>链</span><select value={bindingForm.chain} onChange={(event) => setBindingForm({ ...bindingForm, chain: event.target.value })}>{chains.slice(1).map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label><label><span>钱包地址</span><input value={bindingForm.address} onChange={(event) => setBindingForm({ ...bindingForm, address: event.target.value })} required /></label><label><span>地址角色</span><select value={bindingForm.addressRole} onChange={(event) => setBindingForm({ ...bindingForm, addressRole: event.target.value })}>{addressRoles.map((item) => <option value={item} key={item}>{roleNames[item]}{monitorableRoles.has(item) ? " · 监听" : " · 仅证据"}</option>)}</select><small className="field-help">只有来源钱包、交易金库和智能账户会成为扫描目标。</small></label><label><span>账户类型</span><select value={bindingForm.addressType} onChange={(event) => setBindingForm({ ...bindingForm, addressType: event.target.value })}>{["UNKNOWN", "EOA", "ERC4337", "SAFE", "CONTRACT"].map((item) => <option key={item}>{item}</option>)}</select></label><button type="submit" className="submit" disabled={busy === "binding"}>{monitorableRoles.has(bindingForm.addressRole) ? "核验并开始监听" : "保存为证据地址"}</button></form>}
      <footer className="manager-foot"><div><span>READ ONLY</span><p>只读监控，不接触私钥或签名</p></div><button type="button" onClick={enableBrowserPush}>开启通知</button></footer>
    </aside>}

    {capabilitiesOpen && <div className="modal-backdrop" role="presentation"><section className="capability-modal" role="dialog" aria-modal="true" aria-label="已实现功能说明"><header><div><span>WHAT IS WORKING</span><h2>这套监控器已经实现什么</h2><p>从导入 KOL 到只推送一次，数据按下面的流程工作。</p></div><button type="button" aria-label="关闭功能说明" onClick={() => setCapabilitiesOpen(false)}>×</button></header><div className="capability-flow">{[
      ["01", "按链地址簇", "一个 KOL 可绑定多链、多代钱包；EVM 种子不会被复制到所有链，共享物理钱包仍只扫描一次。"],
      ["02", "链上实时提示", "Solana 订阅与补扫；BNB/Base/ETH 普通交易及 ERC-4337。"],
      ["03", "GMGN 成交确认", "逐钱包分页，确认买卖方向、最终资产、精确数量和美元金额。"],
      ["04", "证据与防误报", "Relay、充值和临时地址只保留为证据；只有核验后的来源钱包、交易金库或智能账户参与监听。"],
      ["05", "FOMO 二次核对", "可选浏览器 Bridge 只转发交易提醒入站消息；不读取 JWT，不直接创建成交或通知。"],
      ["06", "可靠通知", "浏览器 claim/ack；Telegram/Webhook Outbox、租约和重试。"],
      ["07", "漏单审计", "比较稳定交易身份及经济字段，缺失记录进入修复队列。"],
    ].map(([number, title, copy]) => <article key={number}><b>{number}</b><div><strong>{title}</strong><p>{copy}</p></div></article>)}</div><footer><span>当前：{collectorsDisabled ? "影子验收模式（外部采集关闭）" : status.readiness || "starting"}</span><button type="button" onClick={() => { setCapabilitiesOpen(false); setView("health"); }}>查看真实状态</button></footer></section></div>}

    {selectedTrade && <div className="modal-backdrop" role="presentation"><section className="trade-detail" role="dialog" aria-modal="true" aria-label="成交详情"><header><div><span>CANONICAL TRADE</span><h2>{selectedTrade.side === "buy" ? "买入" : selectedTrade.side === "sell" ? "卖出" : "待确认"} {selectedTrade.token?.symbol || "Token"}</h2><p>{selectedPerson?.name || selectedPerson?.handle || "未知 KOL"}{selectedPerson?.twitter ? ` · @${selectedPerson.twitter.replace(/^@/, "")}` : ""}</p></div><button type="button" aria-label="关闭成交详情" onClick={() => setSelectedTrade(null)}>×</button></header><dl><div><dt>链 / 钱包</dt><dd>{chainNames[selectedTrade.chain] || selectedTrade.chain} · {selectedWallet ? short(selectedWallet, 12, 8) : "历史记录未保存钱包"}</dd></div><div><dt>资产</dt><dd>{selectedTrade.token?.address || "待解析"}</dd></div><div><dt>数量 / 金额</dt><dd>{selectedTrade.tokenAmount || "—"} · ${formatMoney(selectedTrade.valueUsd)}</dd></div><div><dt>状态</dt><dd>{selectedTrade.confirmationState} · {selectedTrade.origin} · {selectedTrade.finality}</dd></div><div><dt>成交 / 路由段</dt><dd>{selectedTrade.legCount || 0} / {selectedTrade.routeLegCount || 0}</dd></div><div><dt>规则版本</dt><dd>{selectedTrade.normalizationVersion || "1.0"}</dd></div></dl><div className="timeline"><strong>时间线</strong><span>链上发生：{selectedTrade.timestamp ? new Date(selectedTrade.timestamp).toLocaleString() : "—"}</span><span>首次观察：{selectedTrade.firstObservedAt ? new Date(selectedTrade.firstObservedAt).toLocaleString() : "—"}</span><span>GMGN 确认：{selectedTrade.confirmedAt ? new Date(selectedTrade.confirmedAt).toLocaleString() : "—"}</span><span>最终确认：{selectedTrade.finalizedAt ? new Date(selectedTrade.finalizedAt).toLocaleString() : "待确认"}</span></div><div className="detail-actions">{selectedPerson?.twitter && <a href={selectedPerson.twitter.startsWith("http") ? selectedPerson.twitter : `https://x.com/${selectedPerson.twitter.replace(/^@/, "")}`} target="_blank" rel="noopener noreferrer">打开 KOL 推特</a>}{explorer(selectedTrade) && <a href={explorer(selectedTrade)} target="_blank" rel="noopener noreferrer">打开交易</a>}{selectedTrade.token?.pairUrl && <a href={selectedTrade.token.pairUrl} target="_blank" rel="noopener noreferrer">查看市场</a>}</div></section></div>}
  </main>;
}
