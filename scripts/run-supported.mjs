import { spawnSync } from "node:child_process";
import path from "node:path";

function supported(executable) {
  try {
    const result = spawnSync(executable, ["-p", "process.versions.node"], { encoding: "utf8", windowsHide: true });
    if (result.status !== 0) return false;
    const [major, minor] = result.stdout.trim().split(".").map(Number);
    return major > 22 || (major === 22 && minor >= 13);
  } catch {
    return false;
  }
}

const bundled = process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "bin", "node.exe") : "";
const candidates = [process.execPath, process.env.FOMO_NODE_PATH, bundled].filter(Boolean);
const node = candidates.find(supported);
if (!node) {
  console.error("FOMO Monitor requires Node.js 22.13 or newer. Set FOMO_NODE_PATH to a supported Node.js executable.");
  process.exit(1);
}

const task = process.argv[2];
const taskArgs = process.argv.slice(3);
const commands = {
  monitor: [path.resolve("monitor", "server.mjs")],
  devall: [path.resolve("scripts", "dev-all.mjs"), ...taskArgs],
  dev: [path.resolve("node_modules", "vinext", "dist", "cli.js"), "dev", ...taskArgs],
  build: [path.resolve("node_modules", "vinext", "dist", "cli.js"), "build", ...taskArgs],
  start: [path.resolve("node_modules", "vinext", "dist", "cli.js"), "start", ...taskArgs],
  test: ["--test", ...taskArgs.map((argument) => argument.startsWith("-") ? argument : path.resolve(argument))],
  lint: [path.resolve("node_modules", "eslint", "bin", "eslint.js"), ...taskArgs],
  typecheck: [path.resolve("node_modules", "typescript", "bin", "tsc"), ...taskArgs],
  doctor: [path.resolve("scripts", "server-doctor.mjs"), ...taskArgs],
};
if (!commands[task]) {
  console.error(`Unknown task: ${task || "<missing>"}`);
  process.exit(1);
}
const result = spawnSync(node, commands[task], {
  cwd: process.cwd(), stdio: "inherit", windowsHide: true,
  env: { ...process.env, WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH || ".wrangler/wrangler.log" },
});
process.exit(result.status ?? 1);
