import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

function environment(directory, port) {
  return {
    ...process.env,
    PORT: String(port),
    DATA_DIR: directory,
    DATABASE_PATH: path.join(directory, "monitor.sqlite3"),
    INSTANCE_LOCK_PATH: path.join(directory, "monitor.lock"),
    LEGACY_STATE_PATH: path.join(directory, "missing-state.json"),
    DISABLE_EXTERNAL_COLLECTORS: "1",
    ENABLE_GMGN: "0",
    ENABLE_RPC_WEBSOCKET: "0",
    ENABLE_TOKEN_ENRICHMENT: "0",
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_CHAT_ID: "",
    WEBHOOK_URL: "",
  };
}

async function startServer(directory) {
  const child = spawn(process.execPath, ["monitor/server.mjs"], {
    cwd: projectRoot,
    env: environment(directory, await freePort()),
    windowsHide: true,
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
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
}

test("instance lock preserves a live owner and recovers a dead PID", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fomo-instance-lock-"));
  const lockPath = path.join(directory, "monitor.lock");
  let owner;
  let recovered;
  try {
    owner = await startServer(directory);
    const liveLockText = await readFile(lockPath, "utf8");
    const liveLock = JSON.parse(liveLockText);
    assert.equal(liveLock.pid, owner.pid);
    assert.ok(liveLock.owner);

    const contender = spawn(process.execPath, ["monitor/server.mjs"], {
      cwd: projectRoot,
      env: environment(directory, await freePort()),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let contenderError = "";
    contender.stderr.on("data", (chunk) => { contenderError += chunk; });
    const contenderExit = await new Promise((resolve) => contender.once("exit", resolve));
    assert.notEqual(contenderExit, 0);
    assert.match(contenderError, /INSTANCE_ALREADY_RUNNING/);
    assert.equal(await readFile(lockPath, "utf8"), liveLockText, "a contender must not replace or delete the live owner's lock");

    const crashed = new Promise((resolve) => owner.once("exit", resolve));
    owner.kill("SIGKILL");
    await crashed;
    owner = null;
    assert.equal(await readFile(lockPath, "utf8"), liveLockText, "a forced termination must leave a recoverable PID lock");
    recovered = await startServer(directory);
    const recoveredLock = JSON.parse(await readFile(lockPath, "utf8"));
    assert.equal(recoveredLock.pid, recovered.pid);
    assert.notEqual(recoveredLock.owner, liveLock.owner);
  } finally {
    await stopServer(owner);
    await stopServer(recovered);
    await rm(directory, { recursive: true, force: true });
  }
});
