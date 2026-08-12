import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  }, { waitUntil() {}, passThroughOnException() {} });
}

test("server-renders the exact-wallet monitor shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>FOMO KOL Monitor<\/title>/i);
  assert.match(html, /实时确认成交/);
  assert.match(html, /漏单审计/);
  assert.match(html, /系统不会用模拟数据填充/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|Building your site/i);
});

test("client uses persistent event envelopes and v1 reconciliation", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /envelope\.type === "reset\.required"/);
  assert.match(page, /api\/v1\/events\/stream/);
  assert.match(page, /api\/v1\/reconciliations/);
  assert.match(page, /view=live/);
  assert.match(page, /view=history/);
  assert.match(page, /view=pending/);
  assert.match(page, /notification-intents\?channel=browser&status=pending/);
  assert.match(page, /notification-intents\/\$\{intent\.id\}:claim/);
  assert.match(page, /notification-intents\/\$\{intent\.id\}:ack/);
  assert.doesNotMatch(page, /follow-wallet/);
});

test("client controls provide feedback and guard destructive actions", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /confirmingRemove === person\.id/);
  assert.match(page, /确认移除 \$\{person\.name\}/);
  assert.match(page, /role="status"/);
  assert.match(page, /personAction\(person, "backfill"\)/);
  assert.match(page, /"Notification" in window/);
  assert.match(page, /aria-label="关闭提示"/);
  assert.match(page, /aria-label="关闭管理面板"/);
  assert.match(page, /aria-label="关闭成交详情"/);
});

test("summary, sources, and all six views use real buttons", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /className="summary"/);
  assert.match(page, /onClick=\{\(\) => setView\("people"\)\}/);
  assert.match(page, /onClick=\{\(\) => setView\("health"\)\}/);
  assert.match(page, /onClick=\{\(\) => setView\("live"\)\}/);
  assert.match(page, /onClick=\{\(\) => setView\("pending"\)\}/);
  assert.match(page, /<button type="button" key=\{key\} className=\{sourceTone\(item\)\}/);
  assert.match(page, /\["audit", "漏单审计"\]/);
  assert.match(page, /AUTHORITATIVE RUNTIME HEALTH/);
});

test("FOMO Web bridge has real pairing controls and remains a non-authoritative evidence source", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const server = await readFile(new URL("../monitor/server.mjs", import.meta.url), "utf8");
  const manifest = JSON.parse(await readFile(new URL("../browser-extension/manifest.json", import.meta.url), "utf8"));
  const capture = await readFile(new URL("../browser-extension/capture-main.js", import.meta.url), "utf8");
  assert.match(page, /FOMO Web Bridge/);
  assert.match(page, /onClick=\{pairFomoWeb\}/);
  assert.match(page, /onClick=\{copyPairingSecret\}/);
  assert.match(page, /onClick=\{revokeFomoWeb\}/);
  assert.match(page, /确认撤销配对/);
  assert.match(server, /createsTrades: false/);
  assert.match(server, /createsNotifications: false/);
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.optional_host_permissions.includes("https://*/*"));
  assert.ok(manifest.content_scripts.some((item) => item.world === "MAIN" && item.run_at === "document_start"));
  assert.match(capture, /wss:\/\/prod-api\.fomo\.family\/ws/);
  assert.match(capture, /\/feed\/tradingActivity/);
  assert.doesNotMatch(capture, /\.send\s*=|prototype\.send/);
});
