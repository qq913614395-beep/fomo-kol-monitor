# FOMO KOL Monitor Bridge

该 MV3 扩展将 `fomo.family` 已登录页面收到的 `trading_activity` WebSocket 消息转发到本机监控器，用作链上成交的二次证据。

## 安装

1. 在监控器“运行状态”页生成配对密钥。
2. 打开 Edge 的 `edge://extensions` 或 Chrome 的 `chrome://extensions`。
3. 开启开发人员模式，选择“加载解压缩的扩展”，选择本目录。
4. 打开扩展选项，填入本机 API 地址和配对密钥，点击“测试连接”。
5. 保持一个已登录的 FOMO 页面打开。

扩展不读取 Cookie、Privy JWT、钱包私钥，也不观察 WebSocket 的出站鉴权消息。离线时最多缓存 5,000 条证据，恢复后按每批 100 条补发。

远程服务器地址必须是 HTTPS 根地址，例如 `https://radar.example.com`。扩展只会在保存时向浏览器申请该精确域名的可选权限，不会自动获得任意网站访问权。
