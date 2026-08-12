# 仓库地图与数据流

## 运行入口

- `monitor/server.mjs`：仅绑定 `127.0.0.1` 的 HTTP API、SSE、Operation 调度、Outbox worker、单实例锁与优雅关闭。
- `app/page.tsx`：六个主视图、对象/绑定操作、Operation 恢复、持久 SSE 游标和浏览器通知 claim/ack。
- `scripts/dev-all.mjs`：本地同时启动监控 API 与 Vinext 页面。
- `Start-Monitor.ps1`：Windows 双击入口，优先使用已校验的 Node 运行时。

## 领域模块

- `monitor/database.mjs`：SQLite Schema、事务、唯一约束、迁移、Source Record/Sighting、Canonical Trade、Outbox、Operation、Reconciliation。
- `monitor/store.mjs`：application service 兼容层；旧 API 与 v1 API 共用。
- `monitor/decimal.mjs`：BigInt coefficient/scale 精确十进制。
- `monitor/gmgn.mjs`：逐目标钱包活动、分页、限速、退避、独立 cursor stream、对账来源。
- `monitor/realtime.mjs`：Solana WebSocket、EVM WebSocket、物理 Target 低延迟提示。
- `monitor/watchers.mjs`：Solana 签名补扫、EVM 普通交易/4337、Relay 路由证据。
- `monitor/enricher.mjs`：市场信息补全；不能创建通知。
- `monitor/notifier.mjs`：Telegram/Webhook 投递适配器。
- `monitor/secrets.mjs`：Windows DPAPI 配置存储及掩码返回。
- `monitor/core.mjs`：地址归一化、GMGN 聚合、EVM/4337/Relay 解码与稳定键辅助。

## 权威数据流

```text
RPC WS / RPC poll / GMGN CLI / Relay
                |
                v
        source_records (唯一身份)
                |
                +--> source_sightings (每次观察)
                |
                v
       canonical_trades + trade_legs
                |
                +--> event_log.sequence --> SSE replay/reset
                |
                +--> notification_outbox --> claim/lease/ack/attempt
                |
                +--> reconciliation_runs --> repair_jobs
```

GMGN-first 会建立 `chain_verification_jobs`；RPC-first 与 GMGN-first 使用相同的稳定成交身份。Relay 只进入来源证据和待确认流，不可直接生成买卖成交。

## 测试与证据

- `tests/monitor.test.mjs`：监听、聚合、Relay/EVM/4337、历史零通知与水位。
- `tests/database.test.mjs`：SQLite、精确十进制、多对多 Target、Outbox、Operation、对账 repair。
- `tests/golden-fixtures.test.mjs`：Nongwan、JACKET、FOLD、frankdegods 真实只读 fixture。
- `tests/server-integration.test.mjs`：隔离 API 进程、Host/Origin/token、202/幂等、SSE replay/reset、零外发通知。
- `tests/rendered-html.test.mjs`：六视图、按钮、浏览器 claim/ack 和错误反馈源码契约。
- `fixtures/real/`：原始输入、独立 expected、metadata 与 SHA-256。

