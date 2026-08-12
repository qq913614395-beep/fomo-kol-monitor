function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deliver(name, task, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await task();
      return { channel: name, status: "sent", attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await wait(300 * (2 ** (attempt - 1)));
    }
  }
  return { channel: name, status: "failed", attempts, error: lastError?.message || String(lastError) };
}

export class Notifier {
  constructor(config, onError = () => {}) {
    this.config = config;
    this.onError = onError;
  }

  format(event, person) {
    const label = person?.name || person?.handle || "Unknown KOL";
    const side = event.side === "buy" ? "买入" : event.side === "sell" ? "卖出" : "成交";
    const token = event.token?.symbol || event.token?.address || "Unknown token";
    const value = Number(event.valueUsd || 0);
    const lines = [
      `FOMO KOL · ${side} ${token}`,
      `${label}${person?.twitter ? ` · @${person.twitter}` : ""}`,
      `${event.chain} · ${value ? `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "金额待确认"}`,
    ];
    if (event.tokenAmount) lines.push(`数量: ${Number(event.tokenAmount).toLocaleString(undefined, { maximumFractionDigits: 6 })}`);
    if (event.legCount > 1) lines.push(`聚合成交: ${event.legCount} 段`);
    if (event.txHash) lines.push(`Tx: ${event.txHash}`);
    return lines.join("\n");
  }

  async send(event, person) {
    const text = this.format(event, person);
    const deliveries = [];
    if (this.config.telegramBotToken && this.config.telegramChatId) {
      deliveries.push(deliver("telegram", async () => {
        const response = await fetch(`https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: this.config.telegramChatId, text, disable_web_page_preview: true }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`Telegram returned ${response.status}`);
      }));
    }
    if (this.config.webhookUrl) {
      deliveries.push(deliver("webhook", async () => {
        const response = await fetch(this.config.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "trade.confirmed", text, event, person }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`Webhook returned ${response.status}`);
      }));
    }
    if (!deliveries.length) return { status: "skipped", channels: 0, ok: 0, deliveries: [] };
    const results = await Promise.all(deliveries);
    results.filter((item) => item.status === "failed").forEach((item) => this.onError(new Error(item.error)));
    const ok = results.filter((item) => item.status === "sent").length;
    return { status: ok === results.length ? "sent" : ok ? "partial" : "failed", channels: results.length, ok, deliveries: results };
  }

  async sendChannel(channel, event, person, idempotencyKey) {
    const text = this.format(event, person);
    if (channel === "telegram") {
      if (!this.config.telegramBotToken || !this.config.telegramChatId) return { status: "skipped" };
      const response = await fetch(`https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: this.config.telegramChatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(`Telegram returned ${response.status}`), { retryable: response.status >= 500 || response.status === 429 });
      return { status: "delivered", externalId: payload.result?.message_id ? String(payload.result.message_id) : null };
    }
    if (channel === "webhook") {
      if (!this.config.webhookUrl) return { status: "skipped" };
      const response = await fetch(this.config.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify({ type: "trade.confirmed", text, event, person }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw Object.assign(new Error(`Webhook returned ${response.status}`), { retryable: response.status >= 500 || response.status === 429 });
      return { status: "delivered", externalId: response.headers.get("x-message-id") };
    }
    return { status: "skipped" };
  }
}
