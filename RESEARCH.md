# FOMO 购入链路核验（2026-08-03）

## 结论

FOMO 不是单一链上的普通钱包跟单。公开资料与链上样本共同显示：用户拥有独立的 Solana 与 EVM 金库地址，跨链买入会经过 Relay；EVM 一侧采用 EIP-7702 委托账户并通过 ERC-4337 EntryPoint 执行。因此，可靠的早期监控应同时观察 Solana Relay 存款、EVM `UserOperationEvent` 和 Relay 路由状态，而不是只等 App 通知或只跟踪最终收币。

## 三层证据

1. FOMO 官方钱包架构说明：EVM 侧使用 EIP-7702 与 ERC-4337，并为用户提供跨链账户体系。  
   <https://fomo.family/blog/learn/fomo-security-wallet-architecture>
2. Relay 官方 Solana Depository 文档给出的程序地址：  
   `99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2`  
   <https://docs.relay.link/references/protocol/contracts/solana-depository>
3. 公开样本 `frankdegods` 的 Fomoscan 页面与 Relay 请求可相互配对：  
   Solana `498g1rVnFcnjBjpfw1xyqA1WvgQXUU8RWuELjxkjAayQ`  
   EVM `0x696d1265c8fc4f14797abebfae3c43ebfa9d8e28`  
   Relay 返回的请求包含 `referrer: "fomo"`。  
   <https://www.fomoscan.sh/frankdegods>

## EVM 样本

- 用户地址：`0x696d1265c8fc4f14797abebfae3c43ebfa9d8e28`
- EIP-7702 委托实现 `Simple7702Account`：`0xe6cae83bde06e4c305530e199d7217f42808555b`
- ERC-4337 EntryPoint v0.8：`0x4337084d9e255ff0702461cf8895ce9e3b5ff108`
- `UserOperationEvent` topic：`0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f`

在抽样交易中，Solana 原始存款信号早于 BNB 目标链结算约 3 秒。这只能说明“存在可利用的提前量”，不能保证每笔交易都有固定延迟或可盈利尾气。

## 本监控器如何使用这些证据

- `INTENT_SEEN`：捕获 Solana Relay Deposit，或 EVM EntryPoint 的用户操作。
- `ROUTE_IDENTIFIED`：Relay 已给出目标链或目标代币，但交易尚未完成。
- `SETTLED`：Relay 显示目标链结算成功。
- 地址只有在公开 Relay 记录中出现 `referrer=fomo` 时才显示 `RELAY VERIFIED`。

## 局限

- Relay `/requests/v2` 当前仍可公开读取，但已标记弃用；正式运行应迁移到带认证的 v3。
- 公共 RPC 可能限流、漏过短暂故障窗口；监控人数多时需专用 RPC。
- Fomoscan 仅用于可选的公开地址种子解析，最终配对仍由 Relay 记录验证；可用 `ENABLE_FOMOSCAN_RESOLVER=false` 关闭。
- 约 3 秒是样本观测，不是收益保证。滑点、MEV、跨链失败和代币流动性都可能让跟随交易亏损。

