# Windows 本机运行手册

## 前置条件

- Node.js `22.13+`；当前环境实际使用 Node 24 随附运行时。
- `npm install` 已完成。
- GMGN 功能需要本机 GMGN CLI 与用户自己的 API 配置。
- 生产持续监听建议配置专用 Solana/BNB/Base/Ethereum RPC。

## 日常命令

```powershell
npm run typecheck
npm run lint
npm test
npm run test:rendered
npm run build
npm run monitor
npm run dev
```

也可运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\Start-Monitor.ps1
```

启动脚本按 `FOMO_NODE_PATH`、系统 `PATH`、当前用户的 Codex 随附运行时依次寻找 Node，并验证版本。新电脑若没有 Node 22.13+，脚本会给出明确安装提示，不依赖原开发电脑的固定用户路径。

API 固定绑定 `127.0.0.1`。页面 Origin 必须列在 `ALLOWED_ORIGINS`；所有写请求同时需要启动后生成的 `x-local-session`。请勿把本服务反向代理到公网。

## 状态判断

- `healthy`：来源近期成功且水位可推进。
- `degraded`：429、超时、Schema/认证错误、RPC 不支持或隔离 collectors；不能解释为在线监听。
- `unresolved`：没有已核验且启用的钱包，不建立 Target。
- SQLite：`GET /api/v1/status` 的 `integrity` 应为 `ok`。
- 单实例锁保存 PID 与随机 owner。进程仍存活（包括无权探测但 PID 存在）时新实例会拒绝启动，绝不删除锁；崩溃或断电留下的已死亡 PID 锁会在下一次启动时自动恢复。内容损坏的新锁有 30 秒保护窗口，避免并发启动误删。

## 通知

- 浏览器：页面开启时，通过 pending intent → claim → Notification → ack；每个标签使用独立 `sessionStorage` owner。
- Telegram/Webhook：关闭页面后仍由 Outbox worker 投递；最多三次退避重试。
- 页面/API 的通知诊断只检查配置，`sent=false`，不会向真实端点发送测试消息。
- 通过页面保存的外部通道配置使用当前 Windows 用户 DPAPI 加密。

## 故障恢复

1. 查看运行状态页中的 errorCode、lastAttemptAt、lastSuccessAt、blockLag、effectivePollIntervalMs。
2. RPC 429 时更换专用 RPC；不要把 `degraded` 手工改成绿色。
3. GMGN Schema 漂移时停止该 adapter 的水位推进，保留 raw 响应，更新解析和 fixture 后再恢复。
4. 服务异常退出后，通知租约到期可重新 claim；稳定幂等键避免生成第二个 intent。
5. 若显示 `INSTANCE_ALREADY_RUNNING`，先检查错误中 PID 对应的进程；不要手工删除仍存活进程的锁。死亡 PID 的锁应由下一次启动自动清理。
