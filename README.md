# Douyin Desktop（闪拓）

Windows 桌面版抖音多账号管理工具 + 卡密授权服务端。

- 客户端：Electron + Vue 3 + Element Plus
- 协议层：`douyin-im` 协议 SDK（无需开浏览器）
- 服务端：Spring Boot + MySQL 8，签发/校验卡密与设备授权
- 本地数据：SQLite，存在用户目录，不上传

> 仅用于学习、研究和自有账号管理。请遵守抖音平台规则，不要用于垃圾信息、骚扰、欺诈或任何违规用途。

## 功能

- 多账号扫码登录、账号隔离、按账号代理
- 聚合聊天：文本/图片/文件/富消息、引用回复、转发、撤回、草稿
- 自动回复：规则、冷却、转人工、文本/表情/卡片
- 智能群发：多文案轮换、失败重试、排除最近联系过的人、定时发送
- 线索雷达：关键词搜视频、评论采集、持续监控、CSV 导出
- 敏感词：本地词库 + 正则 + 合规改写
- 发送保护：每日/每小时配额、随机间隔、失败熔断、风控信号熔断
- 卡密授权：设备指纹绑定、心跳续签、断网宽限、强制更新

## 快速开始（客户端）

```bash
npm install
npm run dev
```

首次启动：账号管理 → 添加账号 → 抖音 App 扫码。

构建：

```bash
npm run build
npm run dist
```

产物在 `release/`。打包脚本包含 asar 完整性校验和 Electron Fuses 加固。

## 快速开始（服务端）

需要 JDK 17+、Maven、MySQL 8。

```bash
cd server
cp .env.example .env
# 编辑 .env，至少设置：
#   ADMIN_TOKEN / KEY_HMAC_SECRET / DATA_ENC_KEY
#   DB_URL / DB_USER / DB_PASSWORD
mvn -DskipTests package
java -jar target/license-server-1.0.0.jar
```

或使用示例 Compose：

```bash
cd server
docker compose -f docker-compose.example.yml up -d
```

服务端默认监听 `8089`。生产环境请放在 HTTPS 反向代理后面，并设置
`PUBLIC_BASE_URL` 为真实域名。

## 配置

客户端：

| 变量 | 作用 |
|---|---|
| `LICENSE_SERVER` | 授权服务地址，默认 `https://license.example.com` |
| `ALLOWED_LINK_HOST` | 可选，额外允许作为“单独官方链接”发送的域名 |
| `DRY_RUN=1` | 演练模式：只走调度和风控，不真实发送 |
| `LICENSE_ENFORCE=1` | 开发模式下也强制校验授权 |
| `SDK_LOG=info` | 打开 SDK 日志 |

服务端：

| 变量 | 作用 |
|---|---|
| `ADMIN_TOKEN` | 管理后台令牌，至少 32 字节随机值 |
| `KEY_HMAC_SECRET` | 卡密 HMAC 密钥，至少 32 字节随机值 |
| `DATA_ENC_KEY` | 订单卡密加密密钥，Base64 32 字节 |
| `DB_URL` / `DB_USER` / `DB_PASSWORD` | MySQL 8 连接 |
| `PUBLIC_BASE_URL` | 对外 HTTPS 地址 |
| `KEYS_DIR` | Ed25519 密钥目录，务必备份 |
| `PAY_CHANNELS` | 支付渠道，默认 `manual` |
| `TRUST_FORWARDED_FOR` / `TRUSTED_PROXIES` | 反向代理下的真实 IP |

生成密钥：

```bash
openssl rand -base64 32
```

## 目录结构

```
apps/
  main/        Electron 主进程（db / 服务 / IPC）
  preload/     contextBridge 白名单
  renderer/    Vue 3 界面
packages/
  im-sdk/      douyin-im 封装 + 多账号管理
  sender/      发送队列、节流、熔断
  autorespond/ 自动回复决策
  risk/        敏感词与合规改写
  net/         按账号代理
  license/     客户端授权
server/        Spring Boot 授权服务
build/         图标、打包、签名脚本
```

## 安全与隐私

这个仓库**不包含**任何真实账号 Cookie、Session、设备指纹、卡密、数据库、
签名证书或服务端密钥。本地客户端数据只存在用户目录，不会上传。

- 不要把自己的 `.env`、`data/keys`、`*.db`、`*.pem`、`build/certs` 提交到仓库。
- 生产环境请使用独立强随机密钥，并定期备份 `KEYS_DIR`。
- 客户端和授权服务都应按平台规则使用；不要用于群控、骚扰或规避审核。

## 第三方

- `douyin-im`（MIT）
- Vue 3 / Element Plus（MIT）
- 敏感词词库与第三方声明见 `packages/risk/` 下的 LICENSE / NOTICE 文件。
