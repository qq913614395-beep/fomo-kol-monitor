# 最终切换前验收报告

验收日期：2026-08-04（Asia/Shanghai）  
范围：影子数据库、隔离 API、影子页面和公开只读 fixture；未执行正式切换。

## 结论

影子版本已达到“可操作、可恢复、可审计”的切换候选状态。所有代码质量门为退出码 0；隔离 API 与真实浏览器验收通过；影子 SQLite `quick_check=ok`；测试对象已清理；真实外部通知发送数为 0。正式 8788/3001 切换仍需用户明确确认。

## 自动验证

统一命令：

```powershell
npm run test:all
```

结果：退出码 `0`，总耗时约 16.3 秒。

- TypeScript：通过。
- ESLint：0 error，0 warning。
- 核心、数据库、Golden fixture、隔离服务集成：36/36 通过。
- Vinext 生产构建：通过。
- 页面源码/交互契约：4/4 通过。

服务集成测试真实启动临时端口与临时 SQLite，覆盖：

- foreign Host/Origin 拒绝、本地 session token。
- 新增对象 `202 + operationId`、幂等键、刷新后 Operation 查询。
- `/api/v1/operations`、`wallet-bindings`、`relay-evidence`。
- SSE 持久事件补拉与 `reset.required`。
- 通知诊断 `sent=false`。

## Golden fixture

- Nongwan：sell，2 legs，`2255.54482840545`，`4747376.720885`。
- JACKET：BNB 普通 `tx.from` 命中；JACKET terminal，NVDAB route-only；`1163.1332351698225`。
- FOLD：独立 ERC-4337 sender/userOpHash/txHash 解码通过。
- frankdegods：精确钱包分页与重复处理通过。
- 完整 SHA-256 见 `FIXTURE_MANIFEST.md`。

FOLD 限制：GMGN FOLD tx 与所获 UserOperation tx 不同，现有原始证据不能证明直接关联，保留 `blocked_unverified`，没有编造关系。

## 真实浏览器验收

影子页面：`http://localhost:3002/`。

已逐项点击：六个导航、五个链筛选、四个摘要入口、来源徽标、管理开关、新增、CSV 预览/提交、共享钱包、暂停/恢复、单绑定启停、历史回放、立即对账、状态刷新、通知拒绝分支、成交详情与二次移除。

- Nongwan 显示 `$2,255.54`、`4747376.720885`、2 成交段。
- JACKET 显示 `$1,163.13`。
- `1280×720` 与 `390×844`：无横向溢出、无按钮裁切。
- 最终控制台 error：0。
- `codex_shadow_ui_v2`、`codex_import_v2` 已移除；有效 Target 回到 4。

项目未安装独立 `@playwright/test`，因此没有新增仓库内可重复 Playwright suite；本次使用本机浏览器的 Playwright 控制面完成真实点击验收，重复 API/页面契约由 40 项自动测试覆盖。

## 影子服务与数据库

- API：`127.0.0.1:8790`，最新代码 PID `15424`。
- 页面：`localhost:3002`，PID `4976`。
- 数据库：`work/shadow-v2/monitor.sqlite3`。
- readiness：`degraded`（预期；`DISABLE_EXTERNAL_COLLECTORS=1`）。
- SQLite：`quick_check=ok`；people 2；physical targets 4；canonical trades 131。
- notification outbox 0；notification attempts 0。
- 影子 DPAPI 验收：写入 `.invalid` Webhook、API 仅返回掩码、随后删除；最终 configured=false，Outbox 仍为 0。

最新代码重启后以下 GET 均返回 200：status、people、wallet-bindings、operations、relay-evidence、reconciliations、notification-channels。

## 真实旧服务保护证据

验收结束时监听仍为：

- `127.0.0.1:8788` PID `34184`。
- `[::1]:3001` PID `6292`。

没有停止或替换这两个进程，也没有进行真实 SQLite 切换。

真实 `data/state.json` 在验收期间由持续运行的旧服务并发更新，因此无法给出“文件内容完全不变”的哈希证明：本轮首次只读快照为 `CC83DA03F92E74AC773FC4169048055C2EE501BD4C5C7434D43E84CB1FB25509`，结束快照为 `192651E0C1A8B0935E2D5D5C94F51D0B60C6BEC41B00B13E0B8E79096E80672A`。本轮迁移/测试均使用 shadow/temp 路径，没有以真实文件为写入目标；哈希漂移与 PID 34184 持续运行相伴。正式切换前必须先暂停旧写入并创建可验证备份。

## 未执行或外部阻塞

- 公共 Solana RPC 真实 smoke 曾返回 HTTP 429；应保持 degraded，持续运行需专用 RPC。
- 未发送真实 Telegram/Webhook 消息；外部端到端投递只应使用专用测试接收端。
- 未启用 Windows 登录启动任务。
- 未执行正式备份、停旧服务、真实迁移、正式启动或回滚演练；这些操作等待用户确认。

