# 需求追踪矩阵

| 需求 | 实现 | 验证 |
|---|---|---|
| SQLite 权威存储、事务、WAL、外键、单实例 | `database.mjs`, `server.mjs` | `database.test.mjs`, quick_check |
| 多钱包、多链、共享钱包单 Target | people/wallet/binding/target/subscription 分表 | 数据库测试、浏览器共享钱包验收 |
| 精确十进制 | `decimal.mjs` | 精确十进制与 Golden tests |
| GMGN 精确钱包、shell false、分页/退避/水位 | `gmgn.mjs` | monitor + frankdegods tests |
| Solana WS＋签名补扫 | `realtime.mjs`, `watchers.mjs` | monitor tests |
| EVM 普通 from＋4337、区间二分、reorg 回看 | `watchers.mjs`, `realtime.mjs` | JACKET/FOLD 与 monitor tests |
| Relay 仅证据、候选 pending | `core.mjs`, `watchers.mjs`, binding verification | Relay tests、待确认视图 |
| RPC-first/GMGN-first 稳定 tradeId | `database.recordEvent` | database/monitor tests |
| 多段聚合、route terminal asset | `core.mjs`, `database.mjs` | Nongwan/JACKET Golden tests |
| 历史零通知 | legacy/manual_backfill origin fence | database/monitor tests |
| 持久 Outbox、lease/ack、未知投递 | `database.mjs`, `server.mjs`, `notifier.mjs` | notification tests |
| 集合和字段对账、repair queue | reconciliation functions/tables | database/monitor tests |
| 完整 v1 API、202 Operation | `server.mjs` | server integration tests |
| SSE 序号、补拉、reset | `event_log`, SSE route | server integration tests |
| 六个主视图、真实按钮、错误反馈 | `app/page.tsx`, `globals.css` | rendered tests＋真实浏览器验收 |
| Host/Origin/token/安全 CORS | `server.mjs` | server integration tests |
| Windows DPAPI | `secrets.mjs` | Windows 实现审查；未写入真实凭据 |
| 公共 RPC 429 明确 degraded | health model/UI | 真实 smoke 观察与状态页 |

## 明确边界

- 无交易、签名、私钥或自动跟单功能。
- 未向真实 Telegram/Webhook 发送测试消息。
- 未切换真实 8788/3001，未覆盖真实 `state.json`。
- FOLD GMGN tx 与独立 UserOperation 的关联仍缺原始证据。
- 公共 Solana RPC 已出现 429；持续运行需专用 RPC。

