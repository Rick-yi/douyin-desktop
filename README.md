# Douyin Desktop（闪拓）

Windows 桌面版抖音多账号管理工具 + 卡密授权服务端。

- 客户端：Electron + Vue 3 + Element Plus
- 协议层：`douyin-im` 协议 SDK（无需开浏览器）
- 服务端：Spring Boot 3.2 + MySQL 8，签发/校验卡密与设备授权
- 本地数据：SQLite，存在用户目录，不上传

> 仅用于学习、研究和自有账号管理。请遵守抖音平台规则，不要用于垃圾信息、
> 骚扰、欺诈、群控或任何违规用途。

---

## 1. 项目组成

| 目录 | 作用 |
|---|---|
| `apps/main` | Electron 主进程：数据库、业务服务、IPC |
| `apps/preload` | contextBridge 白名单 |
| `apps/renderer` | Vue 3 界面 |
| `packages/im-sdk` | `douyin-im` 封装 + 多账号管理 |
| `packages/sender` | 发送队列、节流、熔断 |
| `packages/autorespond` | 自动回复决策 |
| `packages/risk` | 敏感词与合规改写 |
| `packages/net` | 按账号代理层 |
| `packages/license` | 客户端授权 |
| `server` | Spring Boot 授权服务端 |
| `build` | 图标、打包、签名脚本 |

## 文档

- [架构说明](docs/ARCHITECTURE.md)：客户端/服务端/SDK/授权/数据流
- [生产部署步骤](docs/DEPLOYMENT.md)：从零到 HTTPS、MySQL、systemd、Nginx、备份
- [服务端 README](server/README.md)：服务端配置与排错

---

## 2. 环境要求

| 组件 | 版本 | 说明 |
|---|---|---|
| Windows | 10 / 11 x64 | 客户端当前只做 Windows 桌面版 |
| Node.js | **22 LTS 或更高** | 构建 Vite、运行 Electron 工具链 |
| npm | 10+ | 随 Node 安装 |
| JDK | **17+** | 服务端 Spring Boot 3.2 |
| Maven | 3.9+ | 服务端构建 |
| MySQL | **8.0+** | 授权服务数据库 |
| Docker | 可选 | 用 Compose 起 MySQL + 服务端 |

> 客户端主进程使用 Electron 45 自带的 Node 和 `node:sqlite`。
> 不要把主进程代码直接用系统 Node 跑；测试/打包请用 `electron` 或 `npm run`。

---

## 3. 本地启动（5 步）

### 3.1 建数据库

登录 MySQL 8，执行：

```sql
CREATE DATABASE zmtjl_license
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

CREATE USER 'zmtjl'@'%' IDENTIFIED BY 'change-me';
GRANT ALL PRIVILEGES ON zmtjl_license.* TO 'zmtjl'@'%';
FLUSH PRIVILEGES;
```

表结构由 Flyway 在服务端启动时自动创建，不需要手工导入 SQL。

### 3.2 配置并启动服务端

```bash
cd server
cp .env.example .env
```

Windows 用：

```bat
copy .env.example .env
```

编辑 `server/.env`，至少改这几项：

```dotenv
ADMIN_TOKEN=<随机 32 字节>
KEY_HMAC_SECRET=<随机 32 字节>
DATA_ENC_KEY=<随机 32 字节>
DB_URL=jdbc:mysql://127.0.0.1:3306/zmtjl_license?useUnicode=true&characterEncoding=utf8&serverTimezone=Asia/Shanghai&allowPublicKeyRetrieval=true&useSSL=false
DB_USER=zmtjl
DB_PASSWORD=change-me
PUBLIC_BASE_URL=http://127.0.0.1:8089
```

生成随机密钥（跨平台）：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**加载 `.env` 再启动。** Spring Boot 不会自动读取 `.env`。

Linux / macOS / Git Bash：

```bash
set -a
. ./.env
set +a
mvn -DskipTests package
java -jar target/license-server-1.0.0.jar
```

Windows PowerShell：

```powershell
Get-Content .env | Where-Object { $_ -match '^\s*[^#].*=' } | ForEach-Object {
  $k, $v = $_ -split '=', 2
  $v = $v.Trim().Trim("'").Trim('"')
  [Environment]::SetEnvironmentVariable($k.Trim(), $v, 'Process')
}
mvn -DskipTests package
java -jar target/license-server-1.0.0.jar
```

也可以用 Docker Compose（Compose 会自动读取同目录 `.env`）：

```bash
cd server
docker compose -f docker-compose.example.yml up -d --build
```

启动成功后：

- 服务地址：`http://127.0.0.1:8089`
- 管理登录：`http://127.0.0.1:8089/login.html`
- 登录令牌：就是你设置的 `ADMIN_TOKEN`

首次启动会在 `KEYS_DIR`（默认 `server/data/keys`）自动生成
`ed25519-private.pem` / `ed25519-public.pem`。**私钥必须备份**；丢了以后已签发
的授权 token 无法继续验签。

### 3.3 在管理后台生成卡密

1. 打开 `http://127.0.0.1:8089/login.html`
2. 输入 `ADMIN_TOKEN`
3. 进入「卡密」页，新建一张卡密
4. 复制卡密，下一步激活客户端用

如果登录提示 `ADMIN_DISABLED`，说明 `ADMIN_TOKEN` 没设置或服务端没重启。

### 3.4 启动客户端

```bash
npm install
```

如果 Electron 下载慢：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm install
```

开发模式启动（PowerShell）：

```powershell
$env:LICENSE_SERVER="http://127.0.0.1:8089"
npm run dev
```

cmd：

```bat
set LICENSE_SERVER=http://127.0.0.1:8089
npm run dev
```

bash：

```bash
LICENSE_SERVER=http://127.0.0.1:8089 npm run dev
```

> 开发模式默认不强制授权。要测试卡密门禁，加 `LICENSE_ENFORCE=1`：
>
> ```powershell
> $env:LICENSE_ENFORCE="1"
> npm run dev
> ```

### 3.5 激活并登录抖音

1. 左侧最下面「授权」→ 输入卡密 → 激活
2. 「账号管理」→ 添加账号 → 抖音 App 扫码
3. 扫码成功后账号会显示在线，聊天、群发、线索雷达等按授权功能开放

开发模式如果没开 `LICENSE_ENFORCE`，可以跳过激活直接登录账号；但打包后的正式版
会强制校验。

---

## 4. 服务端详细配置

### 4.1 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `PORT` | 否 | `8089` | 服务端口 |
| `ADMIN_TOKEN` | **是** | 空 | 管理后台令牌；空则管理接口禁用 |
| `KEY_HMAC_SECRET` | **是（生产）** | 空 | 卡密 HMAC 密钥；空则用开发默认值并告警 |
| `DATA_ENC_KEY` | 建议 | 空 | 订单卡密 AES 密钥，Base64 32 字节；空则从 HMAC 派生 |
| `TOKEN_TTL_HOURS` | 否 | `720` | 授权 token 有效期 |
| `DB_URL` | 是 | 本地 MySQL | MySQL 8 JDBC URL |
| `DB_USER` / `DB_PASSWORD` | 是 | `zmtjl` / 空 | 数据库账号 |
| `DB_DRIVER` | 否 | MySQL 驱动 | 一般不用改 |
| `DB_POOL` / `DB_MIN_IDLE` | 否 | `10` / `2` | Hikari 连接池 |
| `PUBLIC_BASE_URL` | 生产必填 | `http://127.0.0.1:8089` | 对外地址，用于支付回调/收银台/更新 |
| `PAY_CHANNELS` | 否 | `manual` | `manual` 手动开卡；其他渠道按需接入 |
| `ORDER_EXPIRE_MINUTES` | 否 | `30` | 订单过期时间 |
| `KEYS_DIR` | 否 | `./data/keys` | Ed25519 密钥目录，必须持久化 |
| `RELEASES_DIR` | 否 | `./data/releases` | 客户端安装包目录 |
| `TRUST_FORWARDED_FOR` | 否 | `false` | 反向代理后设为 `true` |
| `TRUSTED_PROXIES` | 否 | 空 | 可信代理网段，如 `127.0.0.1,::1` |
| `REQUIRE_PUBLIC_URL` | 生产 | `false` | 设为 `true` 时禁止 localhost |
| `REQUIRE_HTTPS_PUBLIC_URL` | 生产 | `false` | 设为 `true` 时强制 HTTPS |
| `UPDATE_ENABLED` | 否 | `false` | 开启客户端版本清单/强制更新 |

### 4.2 生产检查清单

- [ ] `ADMIN_TOKEN`、`KEY_HMAC_SECRET`、`DATA_ENC_KEY` 都是独立随机值
- [ ] `PUBLIC_BASE_URL` 是真实 HTTPS 域名
- [ ] `REQUIRE_PUBLIC_URL=true`、`REQUIRE_HTTPS_PUBLIC_URL=true`
- [ ] `TRUST_FORWARDED_FOR=true` 且 `TRUSTED_PROXIES` 只包含反代地址
- [ ] `KEYS_DIR` 在持久化卷/备份目录里
- [ ] MySQL 只允许内网访问
- [ ] 8089 不直接暴露公网，由 Nginx/Caddy 反代
- [ ] 定期备份 `KEYS_DIR` 和 `zmtjl_license` 库
- [ ] 管理后台使用强令牌，不与其他系统复用

### 4.3 管理后台

| 页面 | 说明 |
|---|---|
| `/login.html` | 输入 `ADMIN_TOKEN`，令牌存在浏览器 sessionStorage |
| `/admin.html` | 卡密、套餐、商城、跳转卡、版本发布 |

管理接口使用请求头：

```http
X-Admin-Token: <ADMIN_TOKEN>
```

---

## 5. 客户端详细配置

### 5.1 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `LICENSE_SERVER` | `https://license.example.com` | 授权服务地址；本地开发设为 `http://127.0.0.1:8089` |
| `LICENSE_ENFORCE` | 空 | 开发模式下也强制校验授权（`1` 开启） |
| `ALLOWED_LINK_HOST` | 空 | 额外允许作为“单独官方链接”发送的域名 |
| `DRY_RUN` | 空 | `1` 为演练模式：只走调度/风控，不真实发送 |
| `APP_USER_DATA` | 空 | 覆盖 Electron 数据目录（测试隔离用） |
| `SDK_LOG` | `error` | `info` 打开 SDK 日志 |

### 5.2 本地数据目录

- 默认：Electron 的 `userData` 目录
- 生产包：`%APPDATA%/Shantuo`
- 开发模式：通常是 `%APPDATA%/Electron`
- 备份：`<dataDir>/backups`
- 聊天媒体：`<dataDir>/chat-media`

数据目录里包含 SQLite 数据库、账号 session、卡片、聊天媒体。**不要提交到 Git**。
当前本地库和 session 是明文，建议开启 BitLocker。

### 5.3 构建与打包

```bash
npm run build      # Vite 构建渲染层
npm run dist       # electron-builder + 自定义打包脚本
```

产物：

```text
release/闪拓-<version>-x64.exe
```

签名是可选的：

```powershell
# 自签名（仅本机测试，不解决 SmartScreen 信任）
npm run cert:self
$env:SELFSIGN="1"
npm run dist

# 使用已有 PFX
$env:SIGN_WIN="1"
$env:WINDOWS_CERT_FILE="C:\path\to\cert.pfx"
$env:WINDOWS_CERT_PASSWORD="..."
npm run dist
```

不配置签名时也能打包，但 Windows 会提示“未知发布者”。

---

## 6. 目录结构

```text
apps/
  main/         Electron 主进程
    src/        db / repo / 业务服务
    ipc/        渲染层接口
  preload/      contextBridge 白名单
  renderer/     Vue 界面
packages/
  im-sdk/       douyin-im 封装 + 多账号管理
  sender/       发送队列、节流、熔断
  autorespond/  自动回复决策引擎
  risk/         敏感词引擎
  net/          按账号代理层
  license/      客户端授权
server/
  src/main/java/           Spring Boot 服务
  src/main/resources/
    application.yml        公共配置（密钥全部走环境变量）
    db/migration/          Flyway 迁移
    static/                管理后台页面
  pom.xml
  Dockerfile
  .env.example
  docker-compose.example.yml
build/          图标、打包、签名脚本
docs/           架构、部署、运维说明
```

---

## 7. 常见问题

### 7.1 客户端

**`npm install` 卡在 Electron 下载**

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm install
```

**`npm run dev` 报 `node:sqlite` / 模块找不到**

- 确认 Node 是 22+；
- 主进程代码不要用系统 Node 直接跑，用 `npm run dev` 或 `electron`；
- `npm install` 后先跑 `npm run patch:sdk`（`predev` 会自动执行）。

**登录后发送失败/授权被拦**

- 开发模式默认不强制授权；如果设置了 `LICENSE_ENFORCE=1`，需要先激活；
- 检查 `LICENSE_SERVER` 是否指向正在运行的服务端；
- 正式包必须能访问 HTTPS 授权服务。

**扫码登录失败**

- 换手机号/短信验证码或密码登录；
- 抖音对频繁登录/新设备有风控，先用测试号；
- 不要把账号 session 复制到其他机器。

### 7.2 服务端

**`Access denied for user`**

- 检查 `DB_USER` / `DB_PASSWORD`；
- MySQL 8 使用 `caching_sha2_password` 时，JDBC URL 加
  `allowPublicKeyRetrieval=true`；
- 确认用户对 `zmtjl_license` 库有权限。

**Flyway 校验失败**

- 不要修改已经执行过的迁移文件；
- 新增变更用新的 `V*__xxx.sql`；
- 开发库可以重建，生产库不要 `flyway clean`。

**`ADMIN_DISABLED`**

- `ADMIN_TOKEN` 为空；设置后重启服务端。

**`PUBLIC_BASE_URL` 报 localhost 错误**

- 生产把 `REQUIRE_PUBLIC_URL=true` 时不能是 localhost；
- 本地开发保持 `REQUIRE_PUBLIC_URL=false`。

**端口 8089 被占用**

- 设置 `PORT=18089`，同时改客户端 `LICENSE_SERVER` 和反代。

**授权激活失败**

- 检查 `PUBLIC_BASE_URL` 是否可访问；
- 检查 `KEYS_DIR` 是否可写、是否更换过密钥；
- 检查服务器时间是否准确；
- 看服务端日志里的 `license` 相关错误。

### 7.3 数据与安全

- 本仓库不包含任何真实账号 Cookie、Session、卡密、数据库、证书或服务端密钥。
- 本地 `.env`、`server/data`、`build/certs` 已被 `.gitignore` 排除。
- 如果这些文件曾经外泄，轮换 `ADMIN_TOKEN`、`KEY_HMAC_SECRET`、`DATA_ENC_KEY`、
  DB 密码，并重新生成 Ed25519 密钥。
- 客户端和授权服务都应按平台规则使用，不要用于群控、骚扰或规避审核。

---

## 8. 第三方

- `douyin-im`（MIT）
- Vue 3 / Element Plus（MIT）
- 敏感词词库与第三方声明见 `packages/risk/` 下的 LICENSE / NOTICE 文件。
