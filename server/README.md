# 授权服务端（Spring Boot）

卡密签发、设备绑定、心跳续签、强制更新和商城订单。

## 1. 要求

| 组件 | 版本 |
|---|---|
| JDK | 17+ |
| Maven | 3.9+ |
| MySQL | 8.0+ |
| Docker | 可选 |

## 2. 快速开始

### 2.1 建数据库

```sql
CREATE DATABASE zmtjl_license
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

CREATE USER 'zmtjl'@'%' IDENTIFIED BY 'change-me';
GRANT ALL PRIVILEGES ON zmtjl_license.* TO 'zmtjl'@'%';
FLUSH PRIVILEGES;
```

Flyway 会在启动时自动建表，不需要手工导入 SQL。

### 2.2 配置

```bash
cp .env.example .env
```

Windows：

```bat
copy .env.example .env
```

至少修改：

```dotenv
ADMIN_TOKEN=<随机 32 字节>
KEY_HMAC_SECRET=<随机 32 字节>
DATA_ENC_KEY=<随机 32 字节>
DB_URL=jdbc:mysql://127.0.0.1:3306/zmtjl_license?useUnicode=true&characterEncoding=utf8&serverTimezone=Asia/Shanghai&allowPublicKeyRetrieval=true&useSSL=false
DB_USER=zmtjl
DB_PASSWORD=change-me
PUBLIC_BASE_URL=http://127.0.0.1:8089
```

生成随机密钥：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### 2.3 加载 `.env`

Spring Boot 不会自动读取 `.env`，启动前先导入环境变量。

Linux / macOS / Git Bash：

```bash
set -a
. ./.env
set +a
```

Windows PowerShell：

```powershell
Get-Content .env | Where-Object { $_ -match '^\s*[^#].*=' } | ForEach-Object {
  $k, $v = $_ -split '=', 2
  $v = $v.Trim().Trim("'").Trim('"')
  [Environment]::SetEnvironmentVariable($k.Trim(), $v, 'Process')
}
```

### 2.4 启动

```bash
mvn -DskipTests package
java -jar target/license-server-1.0.0.jar
```

或者：

```bash
mvn spring-boot:run
```

启动后：

- 服务：`http://127.0.0.1:8089`
- 管理登录：`http://127.0.0.1:8089/login.html`
- 令牌：`ADMIN_TOKEN`

### 2.5 Docker Compose

```bash
docker compose -f docker-compose.example.yml up -d --build
```

Compose 会自动读取同目录 `.env`。至少设置：

```dotenv
DB_ROOT_PASSWORD=...
DB_PASSWORD=...
ADMIN_TOKEN=...
KEY_HMAC_SECRET=...
DATA_ENC_KEY=...
PUBLIC_BASE_URL=http://localhost:8089
```

## 3. 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `PORT` | 否 | `8089` | 服务端口 |
| `ADMIN_TOKEN` | **是** | 空 | 管理后台令牌；空则管理接口禁用 |
| `KEY_HMAC_SECRET` | **是（生产）** | 空 | 卡密 HMAC 密钥；空则用开发默认值并告警 |
| `DATA_ENC_KEY` | 建议 | 空 | 订单卡密 AES 密钥，Base64 32 字节 |
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

## 4. 管理后台

| 页面 | 作用 |
|---|---|
| `/login.html` | 输入 `ADMIN_TOKEN`，令牌存 sessionStorage |
| `/admin.html` | 卡密、套餐、商城、跳转卡、版本发布 |

管理接口请求头：

```http
X-Admin-Token: <ADMIN_TOKEN>
```

新建卡密：登录后台 → 「卡密」→ 新建 → 复制卡密给客户端激活。

## 5. 密钥与数据

首次启动会在 `KEYS_DIR`（默认 `server/data/keys`）自动生成：

```text
ed25519-private.pem
ed25519-public.pem
```

- **私钥必须备份**；丢失后已签发的授权 token 无法继续验签。
- `KEYS_DIR` 必须放在持久化卷/备份目录，不要随容器重建丢失。
- 数据库用 Flyway 迁移；不要修改已执行的迁移文件。
- 生产不要开启 `flyway clean`（项目默认禁用）。
- 备份：`KEYS_DIR` + `zmtjl_license` 数据库。

## 6. 生产部署检查

- [ ] `ADMIN_TOKEN`、`KEY_HMAC_SECRET`、`DATA_ENC_KEY` 都是独立随机值
- [ ] `PUBLIC_BASE_URL` 是真实 HTTPS 域名
- [ ] `REQUIRE_PUBLIC_URL=true`、`REQUIRE_HTTPS_PUBLIC_URL=true`
- [ ] `TRUST_FORWARDED_FOR=true`，`TRUSTED_PROXIES` 只包含反代地址
- [ ] 8089 不直接暴露公网，由 Nginx/Caddy 反代
- [ ] MySQL 只允许内网访问
- [ ] `KEYS_DIR` 和数据库有定时备份
- [ ] 管理后台使用强令牌，不与其他系统复用
- [ ] 客户端强制更新清单（如启用）使用 HTTPS 和正确 SHA-256

## 7. 排错

**`Access denied for user`**

- 检查 `DB_USER` / `DB_PASSWORD`；
- MySQL 8 的 `caching_sha2_password` 需要 JDBC URL 带
  `allowPublicKeyRetrieval=true`；
- 确认用户对 `zmtjl_license` 有权限。

**Flyway 校验失败**

- 不要改已执行过的迁移；
- 新变更用新的 `V*__xxx.sql`；
- 生产不要 `flyway clean`。

**`ADMIN_DISABLED`**

- `ADMIN_TOKEN` 为空；设置后重启服务端。

**`PUBLIC_BASE_URL` localhost 报错**

- 生产开了 `REQUIRE_PUBLIC_URL=true` 时不能是 localhost；
- 本地开发保持 `REQUIRE_PUBLIC_URL=false`。

**端口被占用**

- 设置 `PORT=18089`，同步改客户端 `LICENSE_SERVER` 和反代。

**授权激活失败**

- 检查 `PUBLIC_BASE_URL` 是否可访问；
- 检查 `KEYS_DIR` 是否可写、是否更换过密钥；
- 检查服务器时间；
- 查看服务端 `license` 相关日志。

## 8. 安全

- 不要提交 `.env`、`data/`、`*.db`、`data/keys/*.pem`。
- 本仓库的 `application.yml` 已把所有密钥改成环境变量占位。
- 生产使用独立强随机密钥；不要把管理令牌和卡密密钥复用。
- 如果密钥曾经外泄，轮换 `ADMIN_TOKEN`、`KEY_HMAC_SECRET`、`DATA_ENC_KEY`、
  DB 密码，并重新生成 Ed25519 密钥。
