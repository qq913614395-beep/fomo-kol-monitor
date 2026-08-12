import { execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

function mask(value = "") {
  const text = String(value);
  if (!text) return "";
  if (text.length < 9) return `${text.slice(0, 2)}***`;
  return `${text.slice(0, 4)}***${text.slice(-4)}`;
}

export function validateWebhookUrl(value) {
  let url;
  try { url = new URL(String(value || "")); }
  catch { throw Object.assign(new Error("A valid HTTPS webhook URL is required"), { code: "INVALID_CHANNEL" }); }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)?.slice(1).map(Number);
  const privateV4 = ipv4 && ipv4.every((part) => part >= 0 && part <= 255) && (
    ipv4[0] === 10 || ipv4[0] === 127 || ipv4[0] === 0 ||
    (ipv4[0] === 169 && ipv4[1] === 254) || (ipv4[0] === 192 && ipv4[1] === 168) ||
    (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31)
  );
  const localHost = host === "localhost" || host.endsWith(".localhost") || host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd");
  if (url.protocol !== "https:" || privateV4 || localHost || url.username || url.password) {
    throw Object.assign(new Error("Webhook must use HTTPS and cannot target local, private, or link-local addresses"), { code: "INVALID_CHANNEL" });
  }
  return url.toString();
}

async function dpapi(script, input) {
  if (process.platform !== "win32") throw Object.assign(new Error("Windows DPAPI is required for persistent notification secrets"), { code: "DPAPI_UNAVAILABLE" });
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    env: { ...process.env, FOMO_DPAPI_INPUT: input },
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

function masterKey() {
  const encoded = String(process.env.MONITOR_MASTER_KEY || "").trim();
  if (!encoded) throw Object.assign(new Error("MONITOR_MASTER_KEY is required for persistent secrets on this platform"), { code: "MASTER_KEY_REQUIRED" });
  let key;
  try { key = Buffer.from(encoded, "base64url"); } catch { key = Buffer.alloc(0); }
  if (key.length !== 32) throw Object.assign(new Error("MONITOR_MASTER_KEY must be a 32-byte base64url value"), { code: "MASTER_KEY_INVALID" });
  return key;
}

function encryptPortable(value) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), nonce);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `aesgcm:${Buffer.concat([nonce, tag, encrypted]).toString("base64url")}`;
}

function decryptPortable(value) {
  const payload = Buffer.from(String(value).slice("aesgcm:".length), "base64url");
  if (payload.length < 29) throw Object.assign(new Error("Encrypted secret payload is invalid"), { code: "SECRET_PAYLOAD_INVALID" });
  const nonce = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8");
}

export async function protectSecret(value) {
  if (process.env.MONITOR_MASTER_KEY || process.platform !== "win32") return encryptPortable(value);
  const encrypted = await dpapi("Add-Type -AssemblyName System.Security; $b=[Text.Encoding]::UTF8.GetBytes($env:FOMO_DPAPI_INPUT); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))", String(value));
  return `dpapi:${encrypted}`;
}

export async function unprotectSecret(value) {
  if (String(value).startsWith("aesgcm:")) return decryptPortable(value);
  const encrypted = String(value).startsWith("dpapi:") ? String(value).slice("dpapi:".length) : String(value);
  return dpapi("Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String($env:FOMO_DPAPI_INPUT); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))", encrypted);
}

export class NotificationSecretStore {
  constructor(file) { this.file = path.resolve(file); this.records = {}; }

  async load() {
    try { this.records = JSON.parse(await readFile(this.file, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    return this.list();
  }

  list() {
    return [
      { id: "browser", type: "browser", configured: true, enabled: true, mask: "local" },
      ...["telegram", "webhook"].map((id) => ({ id, type: id, configured: Boolean(this.records[id]), enabled: this.records[id]?.enabled !== false, mask: this.records[id]?.mask || "" })),
    ];
  }

  async set(id, value) {
    if (!["telegram", "webhook"].includes(id)) throw Object.assign(new Error("Unsupported notification channel"), { code: "UNSUPPORTED_CHANNEL" });
    const payload = id === "telegram"
      ? { botToken: String(value.botToken || ""), chatId: String(value.chatId || ""), enabled: value.enabled !== false }
      : { url: String(value.url || ""), enabled: value.enabled !== false };
    if (id === "telegram" && (!payload.botToken || !payload.chatId)) throw Object.assign(new Error("Telegram botToken and chatId are required"), { code: "INVALID_CHANNEL" });
    if (id === "webhook") payload.url = validateWebhookUrl(payload.url);
    this.records[id] = { encrypted: await protectSecret(JSON.stringify(payload)), enabled: payload.enabled, mask: id === "telegram" ? `${mask(payload.botToken)} / ${mask(payload.chatId)}` : mask(payload.url), updatedAt: new Date().toISOString() };
    await this.save();
    return this.list().find((item) => item.id === id);
  }

  async get(id) {
    const record = this.records[id];
    if (!record) return null;
    return JSON.parse(await unprotectSecret(record.encrypted));
  }

  async remove(id) { delete this.records[id]; await this.save(); return true; }

  async save() {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, JSON.stringify(this.records, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.file);
  }
}
