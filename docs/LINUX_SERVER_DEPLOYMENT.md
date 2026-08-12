# Ubuntu 云服务器部署

## 推荐架构

```text
桌面 Edge/Chrome 的 FOMO Bridge
             │ HTTPS + HMAC（仅 ingest 无 Basic Auth）
             ▼
        Nginx :443
        ├─ /api/v1/ingest/fomo-alerts → API 127.0.0.1:8788
        ├─ /api/*                    → API 127.0.0.1:8788（Basic Auth）
        └─ /                         → Web 127.0.0.1:3001（Basic Auth）

API → SQLite WAL + GMGN CLI + 专用 Solana/BNB/Base/ETH RPC
```

公网只开放 `22/tcp`（建议限制管理 IP）和 `80/443`。`3001`、`8788`、SQLite 与 GMGN 凭据不得直接暴露公网。

## 服务器配置

| 规模 | 建议配置 | 说明 |
|---|---:|---|
| 约 100 KOL | 4 vCPU / 8 GB / 80 GB NVMe | 仍应使用专用 RPC |
| 约 1,000 物理 Target | 8 vCPU / 16 GB / 160 GB NVMe | 推荐 GMGN 20–50 req/s，Solana RPC 支持大量地址订阅 |
| 1,000 KOL 且每人多链多钱包 | 16 vCPU / 32 GB / 320 GB NVMe | 实际 Target 可能超过 4,000，建议拆分采集节点 |

GMGN 最短确认轮询周期近似为 `物理 Target 数 ÷ GMGN_REQUESTS_PER_SECOND`。例如 1,000 Target、20 req/s，理论下限约 50 秒；RPC 链上提示仍可更快。不能把“1,000 KOL”当成已经验证的 5 秒全量 GMGN 轮询承诺。

## 前置条件

1. Ubuntu 22.04 或 24.04 的独立服务器。
2. 一个已解析到服务器公网 IP 的域名，例如 `radar.example.com`。
3. 云防火墙开放 80/443；SSH 使用密钥登录。
4. 专用 RPC URL、GMGN API Key；公共 RPC 只适合 smoke test。
5. 桌面 Edge/Chrome 保持一个已登录的 FOMO 页面。iPhone Safari 不能安装该 MV3 扩展。

## 自动安装

先把项目复制到服务器，例如：

```bash
rsync -az --exclude node_modules --exclude data ./fomo-kol-monitor/ root@SERVER:/root/fomo-kol-monitor/
ssh root@SERVER
cd /root/fomo-kol-monitor
sudo bash deploy/install-ubuntu.sh radar.example.com admin@example.com
```

安装脚本会：

- 安装 Node 24、Nginx、Certbot、SQLite 和 GMGN CLI 1.5.6。
- 创建无登录权限的 `fomo-monitor` 系统用户。
- 生成 Linux AES-256-GCM 主密钥和仪表盘 Basic Auth 密码。
- 构建页面并安装 API/Web systemd 服务。
- 配置 Nginx、Let's Encrypt HTTPS、SSE 和 HMAC ingest 限速。
- 启用每日 SQLite 在线备份，不自动删除旧备份。
- 执行服务器自检。

安装完成后必须编辑：

```bash
sudoedit /etc/fomo-kol-monitor/api.env
sudo systemctl restart fomo-monitor-api
sudo -u fomo-monitor env MONITOR_ENV_FILE=/etc/fomo-kol-monitor/api.env \
  node /opt/fomo-kol-monitor/scripts/server-doctor.mjs
```

至少填写专用 RPC、`GMGN_API_KEY`，并确认 `PUBLIC_BASE_URL`、`ALLOWED_ORIGINS`、`TRUSTED_HOSTS` 是同一个正式域名。

## FOMO Bridge 连接服务器

1. 登录 HTTPS 仪表盘，进入“运行状态”。
2. 生成新的配对密钥。
3. 扩展选项中的 API 地址填写 `https://radar.example.com`。
4. 浏览器只会申请这个精确 HTTPS 域名的可选权限。
5. 点击“测试连接”，状态应从 `waiting` 变为 `healthy`。

Nginx 对仪表盘和普通 API 使用 Basic Auth；只有 ingest 路由免 Basic Auth，但仍要求 60 秒时窗内的 HMAC 签名、批量上限和数据库幂等约束。

## 运维命令

```bash
systemctl status fomo-monitor-api fomo-monitor-web
journalctl -u fomo-monitor-api -f
journalctl -u fomo-monitor-web -f
systemctl list-timers fomo-monitor-backup.timer
sudo systemctl start fomo-monitor-backup.service
sudo nginx -t
```

备份位于 `/var/backups/fomo-kol-monitor/<UTC时间>/`，包含 SQLite 在线备份、JSON 密钥文件和 SHA-256。更新前必须先运行备份服务并记录目录。

## 安全边界

- Linux 不使用 Windows DPAPI；`MONITOR_MASTER_KEY` 是 32 字节 base64url，只存在 root 可读的 systemd 环境文件。
- Nginx Basic Auth 是最低门槛。正式多人使用应再放到 Tailscale、Cloudflare Access 或 VPN 后面。
- 不把 API 改成 `0.0.0.0`，反向代理仍只访问 loopback。
- 不向服务器上传 FOMO Cookie、Privy JWT 或钱包私钥。FOMO 登录态继续留在用户桌面浏览器。
- 自动跟单、签名和资金操作不属于本服务。

## 尚未自动化的外部条件

- 域名 DNS 生效和云厂商防火墙规则。
- 专用 RPC/GMGN 套餐额度。
- FOMO 服务端对 1,000 Following 的真实上限；前端未发现限制，但必须用测试账户压测后才能确认。
- Telegram/Webhook 的真实接收端验收。
