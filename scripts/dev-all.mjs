import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
try {
  for (const line of readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
} catch (error) { if (error.code !== "ENOENT") throw error; }
const webPort = String(process.env.WEB_PORT || "3001");
const children = [
  spawn(node, [path.join(root, "monitor", "server.mjs")], { cwd: root, stdio: "inherit" }),
  spawn(node, [path.join(root, "node_modules", "vinext", "dist", "cli.js"), "dev", "--port", webPort], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, WRANGLER_LOG_PATH: ".wrangler/wrangler.log" },
  }),
];

function stop(signal = "SIGTERM") {
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

for (const child of children) {
  child.on("exit", (code) => {
    if (code && code !== 0) process.exitCode = code;
  });
}

process.on("SIGINT", () => { stop("SIGINT"); setTimeout(() => process.exit(), 400).unref(); });
process.on("SIGTERM", () => { stop(); setTimeout(() => process.exit(), 400).unref(); });
