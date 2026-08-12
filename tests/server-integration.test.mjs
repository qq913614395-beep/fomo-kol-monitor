import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createBridgeSignature } from "../monitor/fomo-web.mjs";
import { after, before, test } from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");
const allowedOrigin = "http://localhost:3199";
let child;
let port;
let temporaryDirectory;
let databaseFile;
let sessionToken;
const fomoBridgeSecret = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";
const extensionOrigin = `chrome-extension://${"a".repeat(32)}`;

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.listen(0, "127.0.0.1", resolve).once("error", reject));
  const selected = socket.address().port;
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return selected;
}

function request(pathname, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port, path: pathname, method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let payload = text;
        try { payload = JSON.parse(text); } catch {}
        resolve({ status: response.statusCode, headers: response.headers, payload, text });
      });
    });
    request.on("error", reject);
    if (body != null) request.end(typeof body === "string" ? body : JSON.stringify(body));
    else request.end();
  });
}

function readSse(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port, path: pathname, headers }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        text += chunk;
        if (text.includes("event: ready")) {
          request.destroy();
          resolve({ status: response.statusCode, text });
        }
      });
    });
    request.on("error", (error) => {
      if (error.code !== "ECONNRESET") reject(error);
    });
    request.end();
    setTimeout(() => { request.destroy(); reject(new Error("SSE readiness timeout")); }, 5000).unref();
  });
}

async function waitForOperation(operationId) {
  let operation;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    operation = (await request(`/api/v1/operations/${operationId}`, { headers: { Origin: allowedOrigin } })).payload;
    if (["succeeded", "failed"].includes(operation.status)) return operation;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Operation ${operationId} did not finish`);
}

before(async () => {
  port = await freePort();
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "fomo-server-integration-"));
  databaseFile = path.join(temporaryDirectory, "monitor.sqlite3");
  child = spawn(process.execPath, ["monitor/server.mjs"], {
    cwd: projectRoot,
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: temporaryDirectory,
      DATABASE_PATH: databaseFile,
      INSTANCE_LOCK_PATH: path.join(temporaryDirectory, "monitor.lock"),
      LEGACY_STATE_PATH: path.join(temporaryDirectory, "missing-state.json"),
      ALLOWED_ORIGINS: allowedOrigin,
      TRUSTED_HOSTS: "radar.example.com",
      DISABLE_EXTERNAL_COLLECTORS: "1",
      ENABLE_GMGN: "0",
      ENABLE_RPC_WEBSOCKET: "0",
      ENABLE_TOKEN_ENRICHMENT: "0",
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_CHAT_ID: "",
      WEBHOOK_URL: "",
      FOMO_BRIDGE_TEST_SECRET: fomoBridgeSecret,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server start timeout: ${stderr}`)), 10_000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("FOMO KOL Monitor API")) { clearTimeout(timer); resolve(); }
    });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${stderr}`)); });
  });
  const status = await request("/api/v1/status", { headers: { Origin: allowedOrigin } });
  assert.equal(status.status, 200);
  sessionToken = status.payload.localSessionToken;
});

after(async () => {
  if (child && child.exitCode == null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  }
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

test("rejects foreign Host and Origin and requires the local mutation token", async () => {
  const foreignHost = await request("/api/v1/status", { headers: { Host: `evil.example:${port}` } });
  assert.equal(foreignHost.status, 400);
  assert.equal(foreignHost.payload.error.code, "HOST_REJECTED");

  const trustedProxyHost = await request("/api/v1/status", { headers: { Host: "radar.example.com", Origin: allowedOrigin } });
  assert.equal(trustedProxyHost.status, 200);

  const noToken = await request("/api/v1/status:refresh", { method: "POST", headers: { Origin: allowedOrigin, "content-type": "application/json" }, body: {} });
  assert.equal(noToken.status, 403);
  assert.equal(noToken.payload.error.code, "LOCAL_SESSION_REQUIRED");

  const foreignOrigin = await request("/api/v1/status:refresh", { method: "POST", headers: { Origin: "https://evil.example", "x-local-session": sessionToken, "content-type": "application/json" }, body: {} });
  assert.equal(foreignOrigin.status, 403);
  assert.equal(foreignOrigin.payload.error.code, "ORIGIN_REJECTED");
});

test("FOMO browser bridge requires a fresh HMAC and stores duplicate alerts only once", async () => {
  const preflight = await request("/api/v1/ingest/fomo-alerts", { method: "OPTIONS", headers: { Origin: extensionOrigin, "Access-Control-Request-Method": "POST" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], extensionOrigin);

  const raw = JSON.stringify({ kind: "alerts", alerts: [{ id: "integration-card", type: "swap_buy", networkId: 792703809, tokenAddress: "IntegrationMint", tokenSymbol: "INT", userHandle: "integration_kol", usdAmount: "42.50", createdAt: new Date().toISOString() }] });
  const timestamp = String(Date.now());
  const headers = { Origin: extensionOrigin, "content-type": "application/json", "x-fomo-timestamp": timestamp, "x-fomo-signature": createBridgeSignature(fomoBridgeSecret, timestamp, raw) };
  const first = await request("/api/v1/ingest/fomo-alerts", { method: "POST", headers, body: raw });
  const duplicateTimestamp = String(Date.now());
  const duplicate = await request("/api/v1/ingest/fomo-alerts", { method: "POST", headers: { ...headers, "x-fomo-timestamp": duplicateTimestamp, "x-fomo-signature": createBridgeSignature(fomoBridgeSecret, duplicateTimestamp, raw) }, body: raw });
  assert.equal(first.status, 202);
  assert.equal(first.payload.inserted, 1);
  assert.equal(first.payload.unmatched, 1);
  assert.equal(duplicate.status, 202);
  assert.equal(duplicate.payload.duplicate, 1);

  const bad = await request("/api/v1/ingest/fomo-alerts", { method: "POST", headers: { ...headers, "x-fomo-signature": "00".repeat(32) }, body: raw });
  assert.equal(bad.status, 401);
  assert.equal(bad.payload.error.code, "FOMO_BRIDGE_SIGNATURE_INVALID");
  const oldTimestamp = String(Date.now() - 61_000);
  const expired = await request("/api/v1/ingest/fomo-alerts", { method: "POST", headers: { ...headers, "x-fomo-timestamp": oldTimestamp, "x-fomo-signature": createBridgeSignature(fomoBridgeSecret, oldTimestamp, raw) }, body: raw });
  assert.equal(expired.status, 401);

  const evidence = await request("/api/v1/fomo-alerts?limit=10", { headers: { Origin: allowedOrigin } });
  assert.equal(evidence.status, 200);
  assert.equal(evidence.payload.items.filter((item) => item.fomoEventId === "integration-card").length, 1);
  assert.equal(evidence.payload.summary.appOnly, 1);
  const database = new DatabaseSync(databaseFile);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM notification_outbox").get().count, 0);
  database.close();

  const paired = await request("/api/v1/fomo-web/pair", { method: "POST", headers: { Origin: allowedOrigin, "x-local-session": sessionToken, "content-type": "application/json" }, body: {} });
  assert.equal(paired.status, 201);
  assert.ok(paired.payload.secret.length >= 40);
  assert.equal(paired.payload.createsNotifications, false);
  const revoked = await request("/api/v1/fomo-web/pair", { method: "DELETE", headers: { Origin: allowedOrigin, "x-local-session": sessionToken } });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.payload.configured, false);
});

test("returns 202 operations, preserves idempotency, and survives refresh polling", async () => {
  const headers = { Origin: allowedOrigin, "x-local-session": sessionToken, "content-type": "application/json", "idempotency-key": "integration-person-1" };
  const first = await request("/api/v1/people", { method: "POST", headers, body: { handle: "integration_kol", name: "Integration KOL" } });
  const duplicate = await request("/api/v1/people", { method: "POST", headers, body: { handle: "integration_kol", name: "Integration KOL" } });
  assert.equal(first.status, 202);
  assert.equal(duplicate.status, 202);
  assert.equal(duplicate.payload.operationId, first.payload.operationId);

  let operation;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    operation = (await request(`/api/v1/operations/${first.payload.operationId}`, { headers: { Origin: allowedOrigin } })).payload;
    if (operation.status === "succeeded") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(operation.status, "succeeded");
  const people = await request("/api/v1/people?limit=10", { headers: { Origin: allowedOrigin } });
  assert.equal(people.payload.items.filter((item) => item.handle === "integration_kol").length, 1);
  const operations = await request("/api/v1/operations?limit=10", { headers: { Origin: allowedOrigin } });
  assert.ok(operations.payload.items.some((item) => item.id === first.payload.operationId));
  assert.equal((await request("/api/v1/wallet-bindings?limit=10", { headers: { Origin: allowedOrigin } })).status, 200);
  assert.equal((await request("/api/v1/relay-evidence?limit=10", { headers: { Origin: allowedOrigin } })).status, 200);
});

test("address candidates require an explicit chain and monitorable role before scanning", async () => {
  const mutationHeaders = { Origin: allowedOrigin, "x-local-session": sessionToken, "content-type": "application/json" };
  const beforeStatus = await request("/api/v1/status", { headers: { Origin: allowedOrigin } });
  const beforeTargets = beforeStatus.payload.activeTargets;
  const seedAddress = "0x1111111111111111111111111111111111111111";
  const created = await request("/api/v1/people", {
    method: "POST",
    headers: { ...mutationHeaders, "idempotency-key": "integration-address-cluster" },
    body: { handle: "cluster_kol", name: "Cluster KOL", evmAddress: seedAddress },
  });
  assert.equal(created.status, 202);
  assert.equal((await waitForOperation(created.payload.operationId)).status, "succeeded");

  const people = await request("/api/v1/people?limit=50", { headers: { Origin: allowedOrigin } });
  const person = people.payload.items.find((item) => item.handle === "cluster_kol");
  assert.ok(person);
  assert.equal(person.bindings.length, 0);
  assert.equal(person.addressCandidates.length, 1);
  assert.equal(person.addressCandidates[0].chain, "unknown");
  assert.equal(person.addressCandidates[0].addressRole, "unknown");

  const candidates = await request(`/api/v1/address-candidates?personId=${person.id}`, { headers: { Origin: allowedOrigin } });
  assert.equal(candidates.status, 200);
  assert.equal(candidates.payload.items.length, 1);
  const candidate = candidates.payload.items[0];

  const unscopedVerify = await request(`/api/v1/people/${person.id}/address-candidates/${candidate.id}:verify`, {
    method: "POST", headers: mutationHeaders, body: {},
  });
  assert.equal(unscopedVerify.status, 400);
  assert.equal(unscopedVerify.payload.error.code, "CANDIDATE_CHAIN_REQUIRED");

  const verified = await request(`/api/v1/people/${person.id}/address-candidates/${candidate.id}:verify`, {
    method: "POST", headers: mutationHeaders, body: { chain: "bsc", addressRole: "vault" },
  });
  assert.equal(verified.status, 200);
  assert.equal(verified.payload.binding.addressRole, "vault");
  assert.equal(verified.payload.binding.verificationState, "verified");
  assert.equal(verified.payload.candidate.verificationState, "verified");

  const afterPromotion = await request("/api/v1/status", { headers: { Origin: allowedOrigin } });
  assert.equal(afterPromotion.payload.activeTargets, beforeTargets + 1);
  const deposit = await request(`/api/v1/people/${person.id}/wallet-bindings`, {
    method: "POST", headers: mutationHeaders,
    body: { chain: "base", address: "0x2222222222222222222222222222222222222222", addressRole: "deposit", verificationState: "verified", source: "integration-test" },
  });
  assert.equal(deposit.status, 201);
  assert.equal(deposit.payload.addressRole, "deposit");
  const afterDeposit = await request("/api/v1/status", { headers: { Origin: allowedOrigin } });
  assert.equal(afterDeposit.payload.activeTargets, beforeTargets + 1);

  const rejectedSeed = await request("/api/v1/people", {
    method: "POST",
    headers: { ...mutationHeaders, "idempotency-key": "integration-rejected-candidate" },
    body: { handle: "rejected_cluster_kol", evmAddress: "0x3333333333333333333333333333333333333333" },
  });
  assert.equal((await waitForOperation(rejectedSeed.payload.operationId)).status, "succeeded");
  const refreshedPeople = await request("/api/v1/people?limit=50", { headers: { Origin: allowedOrigin } });
  const rejectedPerson = refreshedPeople.payload.items.find((item) => item.handle === "rejected_cluster_kol");
  const rejectedCandidate = rejectedPerson.addressCandidates[0];
  const rejected = await request(`/api/v1/people/${rejectedPerson.id}/address-candidates/${rejectedCandidate.id}:reject`, {
    method: "POST", headers: mutationHeaders, body: {},
  });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.payload.verificationState, "rejected");
});

test("replays durable SSE events and emits reset.required for an expired cursor", async () => {
  const replay = await readSse("/api/v1/events/stream?after=0", { Origin: allowedOrigin });
  assert.equal(replay.status, 200);
  assert.match(replay.text, /event: monitor-event/);
  assert.match(replay.text, /operation\.updated/);

  const database = new DatabaseSync(databaseFile);
  const maximum = Number(database.prepare("SELECT MAX(sequence) AS value FROM event_log").get().value);
  database.prepare("DELETE FROM event_log WHERE sequence<?").run(maximum);
  database.close();
  const reset = await readSse("/api/v1/events/stream?after=1", { Origin: allowedOrigin, "Last-Event-ID": "1" });
  assert.match(reset.text, /reset\.required/);
  assert.match(reset.text, /cursor_expired/);
});

test("notification diagnostics never send to real external channels", async () => {
  const result = await request("/api/v1/notifications:test", {
    method: "POST",
    headers: { Origin: allowedOrigin, "x-local-session": sessionToken, "content-type": "application/json" },
    body: {},
  });
  assert.equal(result.status, 200);
  assert.equal(result.payload.sent, false);
  assert.equal(result.payload.telegram, false);
  assert.equal(result.payload.webhook, false);
});
