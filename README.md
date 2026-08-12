# FOMO KOL Monitor

一个本地只读的 FOMO KOL 链上监控器。它把 Solana、EVM/ERC-4337 与 Relay 跨链活动统一为实时信号，并在网页、Telegram 或 Webhook 中推送。

当前版本不会读取私钥、签名交易或自动下单。关于 FOMO 购入链路、地址验证方法和已知限制，见 [RESEARCH.md](./RESEARCH.md)。

## 已实现功能

- 按 FOMO handle 添加监控对象，也支持 CSV/JSON 批量导入。
- 自动解析候选 Solana/EVM 金库地址，并用 `referrer=fomo` 的 Relay 请求交叉验证地址配对。
- 添加对象后按精确钱包回放 GMGN 成交；历史数据只展示，统一标记为 `skipped`，不触发推送。
- 实时监听 Solana 地址、EVM 普通金库交易与 ERC-4337 UserOperation，通过 SSE 无刷新更新页面。
- 优先使用 Solana/EVM WebSocket 订阅；每条链的轮询补偿独立运行，单个 RPC 超时不会阻塞其他链。
- 逐钱包调用 GMGN `portfolio activity --chain <chain> --wallet <address> --raw`，补充买卖方向、美元金额和代币，并按链、钱包、交易、代币和方向聚合分段成交。
- 使用 DexScreener 补充代币名称、符号、图标、美元价格、市值和流动性。
- 可选 FOMO Web Bridge 被动接收已登录网页的实时提醒和历史 Feed 响应，作为链上成交的二次证据；它不读取 JWT，也不会直接创建成交或通知。
- 页面分为“实时、历史、待确认、漏单审计、对象、运行状态”六个主视图；Relay 只作为资金路径证据，不会被显示成买入。
- 漏单审计持续比较 GMGN 精确钱包窗口与本地确认记录，按 Solana、BNB、Base、Ethereum 显示来源数、本地数和缺失数。
- 支持暂停/恢复监控和精确回放；没有有效地址的对象标记为“未解析 · 不监听”，不计入有效钱包。
- 支持浏览器通知、Telegram 和通用 Webhook；管理区可测试信号和推送通道。
- 每条记录提供 KOL Twitter、交易哈希和 DexScreener 交易对链接（可获取时）。

## 首次启动

1. 确认已安装 Node.js 22.13 或更高版本，并在项目目录执行 `npm install`（若依赖尚未安装）。
2. 复制 `.env.example` 为 `.env`，按需填写 RPC 与推送配置。
3. 双击 `Start-Monitor.ps1`，或在 PowerShell 中执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\Start-Monitor.ps1
```

4. 打开终端输出中的本地网页地址（默认 `http://localhost:3001`）。本地监控 API 默认使用 `http://127.0.0.1:8788`，可分别用 `WEB_PORT` 和 `PORT` 修改。
5. 在“添加监控”中输入 FOMO handle，或导入 CSV/JSON。

## 导入格式

只提供 `handle` 即可；地址越完整，解析和验证越快。

```csv
handle,twitter,solanaAddress,evmAddress,priority
frankdegods,@frankdegods,498g1rVnFcnjBjpfw1xyqA1WvgQXUU8RWuELjxkjAayQ,0x696d1265c8fc4f14797abebfae3c43ebfa9d8e28,1
```

JSON 示例：

```json
[
  {
    "handle": "frankdegods",
    "twitter": "@frankdegods",
    "solanaAddress": "498g1rVnFcnjBjpfw1xyqA1WvgQXUU8RWuELjxkjAayQ",
    "evmAddress": "0x696d1265c8fc4f14797abebfae3c43ebfa9d8e28",
    "priority": 1
  }
]
```

监控器会尝试从公开 Fomoscan 页面取得候选地址，并用 Relay 证据验证 Solana/EVM 配对。没有 Relay 证据时会标记为 `UNVERIFIED`，不会把推测当成已确认地址。

## 推送配置

Telegram：

```env
TELEGRAM_BOT_TOKEN=123456:token
TELEGRAM_CHAT_ID=123456789
```

通用 Webhook：

```env
WEBHOOK_URL=https://your-endpoint.example/events
```

也可在页面管理区写入配置；此方式使用当前 Windows 用户的 DPAPI 加密保存，API 只返回配置状态和掩码。页面中的“检查通知”只检查配置，不会向真实 Telegram/Webhook 发送测试消息。浏览器通知需要先授权；关闭网页后，已配置的 Telegram/Webhook 仍可工作。

## FOMO Web 二次核对

1. 打开“运行状态”，在 FOMO Web Bridge 卡片生成配对密钥。
2. 在 Edge 的 `edge://extensions` 或 Chrome 的 `chrome://extensions` 开启开发人员模式。
3. 选择“加载解压缩的扩展”，目录为项目内的 `browser-extension`。
4. 打开扩展选项，填写卡片显示的 API 地址和配对密钥，然后点击“测试连接”。
5. 保持一个已经登录的 `fomo.family` 页面打开。

扩展只观察 `wss://prod-api.fomo.family/ws` 的入站 `trading_activity` 消息，以及页面自己已经取得的 `/feed/tradingActivity` 响应副本；不观察 WebSocket 出站鉴权，不读取 Cookie、Privy JWT 或钱包密钥。断网时最多缓存 5,000 条证据，恢复后按每批 100 条补交。

FOMO Bridge 只是一条可选核对源：链上 RPC 仍负责低延迟发现，GMGN 仍负责方向、资产和金额确认。FOMO-only 记录只进入证据与漏单检查，不会触发交易通知。一个登录会话对应一个 WebSocket，而不是每个 KOL 一条连接；前端未发现关注数量限制，但 FOMO 服务端能否稳定承载 1,000 个关注对象仍需用专用测试账户实测，当前不能宣称已验证。

## GMGN 配置

本机安装 `gmgn-cli` 后，在 GMGN 创建 API Key，并按 GMGN CLI 要求配置 `GMGN_API_KEY`。监控器只查询公开钱包活动，不读取资金钱包私钥，也不会签名交易。

```env
ENABLE_GMGN=true
GMGN_CHAINS=sol,bsc,base,eth
GMGN_POLL_INTERVAL_MS=5000
```

监控器不会使用 GMGN 账号关注列表。每个“钱包＋链”都有独立水位、分页补漏、全局限速和退避重试；GMGN 负责确认成交与持续对账，RPC WebSocket/区块扫描负责低延迟提示。

## 实时订阅

建议为每条链填写专用 WebSocket RPC：

```env
SOLANA_RPC_WS=wss://your-solana-provider.example
BASE_RPC_WS=wss://your-base-provider.example
BNB_RPC_WS=wss://your-bnb-provider.example
```

未填写时程序会尝试从 HTTP RPC 地址推导 `wss://` 地址；服务商不支持时自动保留轮询补偿。页面顶部会分别显示 `SOL WS`、`BASE WS`、`BNB WS`、`GMGN` 和 `RELAY` 状态，黄色表示等待/降级，绿色表示连接，红色表示错误。

EVM 同时扫描新区块中的普通交易 `tx.from === 金库地址`，并监听 ERC-4337 EntryPoint v0.7/v0.8。前者覆盖 BNB 普通金库交易，后者覆盖 Base 等智能账户交易。轮询查询失败时不会推进区块游标。

## 市场数据与 RPC

默认启用 DexScreener 市场数据：

```env
ENABLE_TOKEN_ENRICHMENT=true
DEXSCREENER_API_BASE=https://api.dexscreener.com
TOKEN_CACHE_TTL_MS=60000
```

DexScreener 属于第三方聚合源，代币刚创建、流动性很低或接口限流时，价格和市值可能暂时缺失或滞后。链上信号会先立即显示，市场数据随后异步补齐。

公共 RPC 适合少量对象测试。监控人数和信号量增加后，应将 `.env` 中的 Solana、Base、BNB 等 RPC 换成支持高频日志查询的专用端点。

## 信号含义

- `INTENT_SEEN`：已看到 Solana Relay Deposit 或 EVM UserOperation 上链。
- `ROUTE_IDENTIFIED`：Relay 已暴露目标链/目标代币，但尚未最终结算。
- `SETTLED`：目标链交易已经完成。

系统以最快可获取的公开链上证据发出信号，因此同一笔跨链活动可能随状态推进被补充或更新。`signalLatencyMs` 表示从链上时间到监控器接收时间的估算延迟。

## 数据与安全边界

- SQLite 是权威存储，默认数据库为 `data/monitor.sqlite3`，启用 WAL、外键、事务、唯一约束和单实例锁。旧 `state.json` 只用于首次影子迁移，迁入的旧成交统一标记为历史且永不补发通知。
- 人员、钱包、绑定和物理监听 Target 分离，同一钱包可属于多个 KOL，但实际只扫描一次。
- Telegram/Webhook 使用持久 Outbox、租约和最多三次退避重试；浏览器通知使用 claim/ack，避免多标签重复领取。
- 首次启动默认不全量回放旧区块，避免旧通知轰炸；添加单个 KOL 时仅在页面中回放最近 10 条 Relay 记录。
- Relay `/requests/v2` 已被标记为旧接口，正式长期运行前建议申请 v3 API，并配置 `RELAY_REQUESTS_PATH` 与 `RELAY_API_KEY`。
- 本项目是监控与推送工具，不构成投资建议。自动跟单应拆成独立执行器，并额外设置单笔限额、滑点、冷却时间、代币白名单/黑名单和总开关。

## 测试

```powershell
npm run test:all
```

该命令依次运行 TypeScript、lint、核心/集成/黄金数据测试、生产构建和页面源码测试。迁移、回滚、fixture 与验收细节见 `docs/`。

## 实施与验收文档

- [仓库地图与数据流](./docs/REPOSITORY_MAP.md)
- [需求追踪矩阵](./docs/REQUIREMENTS_TRACEABILITY.md)
- [Schema 与迁移](./docs/SCHEMA_AND_MIGRATION.md)
- [Windows 运行手册](./docs/WINDOWS_RUNBOOK.md)
- [Ubuntu 云服务器部署](./docs/LINUX_SERVER_DEPLOYMENT.md)
- [备份、切换与回滚](./docs/BACKUP_MIGRATION_ROLLBACK.md)
- [真实 fixture 清单](./docs/FIXTURE_MANIFEST.md)
- [最终切换前验收报告](./docs/FINAL_ACCEPTANCE_REPORT.md)
