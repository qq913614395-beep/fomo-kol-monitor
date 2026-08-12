# SQLite Schema 与迁移说明

## 存储原则

- 权威文件：`data/monitor.sqlite3`。
- `PRAGMA journal_mode=WAL`、`foreign_keys=ON`、`busy_timeout=5000`。
- `schema_meta` 保存 Schema 版本和旧状态迁移证据。
- 金额与数量以十进制字符串保存，所有聚合经 `decimal.mjs` 的 BigInt coefficient/scale 完成。
- `monitor.sqlite3.lock` 防止两个写服务同时运行。

## 表分组

| 分组 | 表 |
|---|---|
| 对象与订阅 | `people`, `wallets`, `person_wallets`, `monitor_targets`, `monitor_subscriptions` |
| 来源与水位 | `source_cursors`, `source_runs`, `source_records`, `source_sightings` |
| 归一化 | `normalization_jobs`, `canonical_trades`, `trade_observations`, `trade_legs`, `chain_verification_jobs` |
| 事件与任务 | `event_log`, `operations`, `source_health` |
| 通知 | `notification_outbox`, `notification_attempts` |
| 对账与修复 | `reconciliation_runs`, `reconciliation_items`, `repair_jobs` |

关键唯一约束覆盖：链＋规范地址、人员＋钱包、物理 Target、source identity、稳定成交键、trade＋channel＋recipient＋correctionKind、Operation 幂等键和 cursor scope。

## `state.json` 影子迁移

1. 仅当 SQLite 中没有人员时读取旧 JSON。
2. 人员地址转成兼容绑定；一个 EVM 地址按 BNB/Base/Ethereum 分别建立钱包＋链 Target。
3. 旧成交写成 `origin=legacy`，`notificationEligible=false`，不会进入实时流或 Outbox。
4. `schema_meta.legacy_import` 保存源文件绝对路径、SHA-256、导入时间、人员数与事件数。
5. 导入不修改、覆盖或删除旧 JSON。

当前影子库为 `work/shadow-v2/monitor.sqlite3`；正式切换前不得把它覆盖到 `data/`。

