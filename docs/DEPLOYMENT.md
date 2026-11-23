# 生产部署步骤（从零到可用）

> 本文以 Ubuntu 22.04/24.04 + Nginx + Java 为例。所有域名、IP、密码都是占位符，
> 请替换成你自己的。不要把 `.env`、`KEYS_DIR`、数据库备份提交到 Git。

---

## 0. 部署前准备

| 项目 | 示例 | 说明 |
|---|---|---|
| 域名 | `license.example.com` | 必须能解析到服务器 |
| 服务器 | Ubuntu 22.04/24.04，2C4G，40GB | 授权服务很轻，2C4G 足够 |
| 公网 IP | `SERVER_IP` | 只开放 22/80/443 |
| MySQL | 8.0+ | 可以和授权服务同机 |
| 备份目录 | `/var/backups/zmtjl` | 不要放在系统盘临时目录 |
| 管理员邮箱 | `admin@example.com` | 申请 HTTPS 证书用 |

**不要对公网开放：** `8089`（授权服务）、`3306`（MySQL）。

---

## 1. 服务器初始化

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl unzip ufw
```

创建专用用户和目录：

```bash
sudo useradd --system --home /opt/zmtjl --shell /usr/sbin/nologin zmtjl || true
sudo mkdir -p /opt/zmtjl
sudo chown -R zmtjl:zmtjl /opt/zmtjl
```

防火墙：

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

> 不要 `ufw allow 8089` 或 `3306`。

---

## 2. 安装 JDK 17、Maven、MySQL、Nginx

```bash
sudo apt install -y openjdk-17-jdk maven mysql-server nginx certbot python3-certbot-nginx
```

确认 Java 17：

```bash
java -version
mvn -version
```

如果系统默认 Java 不是 17：

```bash
sudo update-alternatives --config java
sudo update-alternatives --config javac
```

启动 MySQL：

```bash
sudo systemctl enable --now mysql
sudo systemctl status mysql
```

---

## 3. 建数据库

```bash
sudo mysql
```

在 MySQL 里执行：

```sql
CREATE DATABASE zmtjl_license
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

CREATE USER 'zmtjl'@'127.0.0.1' IDENTIFIED BY 'CHANGE_ME_DB_PASSWORD';
GRANT ALL PRIVILEGES ON zmtjl_license.* TO 'zmtjl'@'127.0.0.1';
FLUSH PRIVILEGES;
EXIT;
```

确认能登录：

```bash
mysql -h 127.0.0.1 -u zmtjl -p zmtjl_license -e "SELECT 1;"
```

表结构由 Flyway 在服务端启动时自动创建，不需要手工导入。

---

## 4. 拉代码并构建

```bash
sudo -u zmtjl -H git clone https://github.com/Rick-yi/douyin-desktop.git /opt/zmtjl/app
cd /opt/zmtjl/app/server
```

构建：

```bash
sudo -u zmtjl -H bash -lc 'cd /opt/zmtjl/app/server && mvn -DskipTests package'
```

产物：

```text
/opt/zmtjl/app/server/target/license-server-1.0.0.jar
```

> 第一次构建会下载 Maven 依赖，耐心等待。国内网络慢可以配置 Maven 镜像。

---

## 5. 配置 `.env`

```bash
cd /opt/zmtjl/app/server
sudo -u zmtjl -H cp .env.example .env
sudo -u zmtjl -H nano .env
```

生成三个随机密钥：

```bash
openssl rand -base64 32
openssl rand -base64 32
openssl rand -base64 32
```

填入：

```dotenv
PORT=8089
SERVER_ADDRESS=127.0.0.1

ADMIN_TOKEN=<第一段随机值>
KEY_HMAC_SECRET=<第二段随机值>
DATA_ENC_KEY=<第三段随机值>

PUBLIC_BASE_URL=https://license.example.com

DB_URL=jdbc:mysql://127.0.0.1:3306/zmtjl_license?useUnicode=true&characterEncoding=utf8&serverTimezone=Asia/Shanghai&allowPublicKeyRetrieval=true&useSSL=false&rewriteBatchedStatements=true
DB_USER=zmtjl
DB_PASSWORD=CHANGE_ME_DB_PASSWORD

KEYS_DIR=/opt/zmtjl/app/server/data/keys
RELEASES_DIR=/opt/zmtjl/app/server/data/releases

TRUST_FORWARDED_FOR=true
TRUSTED_PROXIES=127.0.0.1,::1

REQUIRE_PUBLIC_URL=true
REQUIRE_HTTPS_PUBLIC_URL=true

PAY_CHANNELS=manual
```

权限：

```bash
sudo chmod 600 /opt/zmtjl/app/server/.env
sudo chown zmtjl:zmtjl /opt/zmtjl/app/server/.env
```

> `KEYS_DIR` 下的 Ed25519 私钥是核心资产，必须备份。
> 生产不要用 `PUBLIC_BASE_URL=http://...`，`REQUIRE_HTTPS_PUBLIC_URL=true` 会直接拒绝启动。

---

## 6. 用 systemd 启动

创建启动脚本：

```bash
sudo tee /opt/zmtjl/app/server/run.sh >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
set -a
. ./.env
set +a
exec java -XX:MaxRAMPercentage=75 -jar target/license-server-1.0.0.jar
EOF
sudo chmod 750 /opt/zmtjl/app/server/run.sh
sudo chown zmtjl:zmtjl /opt/zmtjl/app/server/run.sh
```

创建 systemd 服务：

```bash
sudo tee /etc/systemd/system/zmtjl-license.service >/dev/null <<'EOF'
[Unit]
Description=ZMTJL License Server
After=network-online.target mysql.service
Wants=network-online.target

[Service]
Type=simple
User=zmtjl
Group=zmtjl
WorkingDirectory=/opt/zmtjl/app/server
ExecStart=/opt/zmtjl/app/server/run.sh
Restart=always
RestartSec=5
LimitNOFILE=65535
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
```

启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now zmtjl-license
sudo systemctl status zmtjl-license
```

看日志：

```bash
sudo journalctl -u zmtjl-license -n 100 --no-pager
```

确认只监听回环：

```bash
ss -lntp | grep 8089
# 期望 127.0.0.1:8089，不是 0.0.0.0:8089
```

---

## 7. 配置 Nginx + HTTPS

创建站点配置：

```bash
sudo tee /etc/nginx/sites-available/zmtjl-license >/dev/null <<'EOF'
server {
    listen 80;
    server_name license.example.com;

    client_max_body_size 300m;

    location / {
        proxy_pass http://127.0.0.1:8089;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/zmtjl-license /etc/nginx/sites-enabled/zmtjl-license
sudo nginx -t
sudo systemctl reload nginx
```

申请证书：

```bash
sudo certbot --nginx -d license.example.com --redirect
```

> 证书申请需要 80/443 可达；如果失败，先检查 DNS 和防火墙。
> 证书会自动续期；可以 `sudo certbot renew --dry-run` 验证。

---

## 8. 验证服务

```bash
curl -fsS https://license.example.com/v1/health
curl -I https://license.example.com/login.html
```

期望：

- `/v1/health` 返回 200；
- `/login.html` 返回 200。

打开：

```text
https://license.example.com/login.html
```

输入 `.env` 里的 `ADMIN_TOKEN`，进入管理后台。

如果提示 `ADMIN_DISABLED`：

- `ADMIN_TOKEN` 为空；
- 或修改 `.env` 后没有重启：`sudo systemctl restart zmtjl-license`。

---

## 9. 生成卡密并激活客户端

1. 管理后台 →「卡密」→ 新建；
2. 选择套餐/有效期；
3. 复制卡密；
4. 客户端左侧「授权」→ 输入卡密 → 激活。

开发模式默认不强制授权；要测试门禁：

```powershell
$env:LICENSE_ENFORCE="1"
npm run dev
```

---

## 10. 客户端指向你的域名

公开仓库默认授权地址是：

```js
https://license.example.com
```

正式打包前，二选一：

### 方式 A：改默认值（推荐）

编辑 `packages/license/index.js`：

```js
const PROD_SERVER = process.env.LICENSE_SERVER || 'https://license.example.com';
```

把 `https://license.example.com` 改成你的真实域名，然后：

```powershell
npm install
npm run dist
```

产物在 `release/`。

### 方式 B：运行时环境变量

只在开发/内部测试用：

```powershell
$env:LICENSE_SERVER="https://license.example.com"
npm run dev
```

> 打包后的客户端不会自动读取你构建机上的环境变量；给最终用户安装包时，用方式 A
> 把域名写进默认值。

---

## 11. 备份

### 11.1 数据库

```bash
sudo mkdir -p /var/backups/zmtjl
mysqldump --single-transaction --quick --routines --triggers \
  -h 127.0.0.1 -u zmtjl -p zmtjl_license \
  | gzip > /var/backups/zmtjl/db-$(date +%F).sql.gz
```

### 11.2 Ed25519 密钥

```bash
tar czf /var/backups/zmtjl/keys-$(date +%F).tgz \
  -C /opt/zmtjl/app/server data/keys
chmod 600 /var/backups/zmtjl/keys-*.tgz
```

### 11.3 `.env`

```bash
install -m 600 /opt/zmtjl/app/server/.env /var/backups/zmtjl/env-$(date +%F)
```

> `.env` 和 keys 备份包含敏感信息，建议加密后再传到异地。

### 11.4 定时任务

```bash
sudo crontab -e
```

示例：

```cron
0 3 * * * mysqldump --single-transaction --quick --routines --triggers -h 127.0.0.1 -u zmtjl -p'CHANGE_ME_DB_PASSWORD' zmtjl_license | gzip > /var/backups/zmtjl/db-$(date +\%F).sql.gz
10 3 * * * tar czf /var/backups/zmtjl/keys-$(date +\%F).tgz -C /opt/zmtjl/app/server data/keys
```

> 生产不要把密码明文写进 crontab；可以用 `~/.my.cnf` 或专用备份用户。

### 11.5 恢复

```bash
# 停服务
sudo systemctl stop zmtjl-license

# 恢复数据库
gunzip < /var/backups/zmtjl/db-2026-01-01.sql.gz | mysql -h 127.0.0.1 -u zmtjl -p zmtjl_license

# 恢复密钥
tar xzf /var/backups/zmtjl/keys-2026-01-01.tgz -C /opt/zmtjl/app/server

# 启动
sudo systemctl start zmtjl-license
```

恢复后必须验证：

- `/v1/health` 200；
- 管理后台能登录；
- 已激活客户端心跳正常。

---

## 12. 升级与回滚

### 升级

```bash
# 1. 备份（见上）
cd /opt/zmtjl/app
sudo -u zmtjl -H git pull
sudo -u zmtjl -H bash -lc 'cd /opt/zmtjl/app/server && mvn -DskipTests package'
sudo systemctl restart zmtjl-license
sudo journalctl -u zmtjl-license -n 50 --no-pager
```

### 回滚

保留上一版 jar：

```bash
cp /opt/zmtjl/app/server/target/license-server-1.0.0.jar /opt/zmtjl/app/server/target/license-server-1.0.0.jar.bak
```

回滚时替换 jar、恢复对应数据库备份、重启：

```bash
sudo systemctl stop zmtjl-license
cp /opt/zmtjl/app/server/target/license-server-1.0.0.jar.bak /opt/zmtjl/app/server/target/license-server-1.0.0.jar
sudo systemctl start zmtjl-license
```

> 数据库迁移不可逆；升级前一定备份。不要修改已执行的 Flyway 迁移文件。

---

## 13. Docker Compose 方案（可选）

如果不想在宿主机装 JDK/Maven，可以用 Compose 起 MySQL + 服务端。

```bash
cd /opt/zmtjl/app/server
cp .env.example .env
nano .env
```

至少设置：

```dotenv
DB_ROOT_PASSWORD=CHANGE_ME_ROOT
DB_PASSWORD=CHANGE_ME_APP
ADMIN_TOKEN=<随机>
KEY_HMAC_SECRET=<随机>
DATA_ENC_KEY=<随机>
PUBLIC_BASE_URL=https://license.example.com
```

启动：

```bash
docker compose -f docker-compose.example.yml up -d --build
docker compose -f docker-compose.example.yml ps
docker compose -f docker-compose.example.yml logs -f app
```

Compose 只把端口绑到 `127.0.0.1:8089`；Nginx 仍然按第 7 节反代。

Docker 下备份数据库：

```bash
docker compose -f docker-compose.example.yml exec db \
  sh -c 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --quick zmtjl_license' \
  | gzip > /var/backups/zmtjl/db-$(date +%F).sql.gz
```

备份 keys 卷：

```bash
docker compose -f docker-compose.example.yml cp app:/app/keys /var/backups/zmtjl/keys-$(date +%F)
```

> Docker 方案下反代来源 IP 是 Docker 网段；Compose 默认
> `TRUST_FORWARDED_FOR=true`、`TRUSTED_PROXIES=172.16.0.0/12`。
> 如果 Nginx 不在本机，按实际网段改。

---

## 14. 安全加固

- [ ] SSH 只允许密钥登录，禁用 root 密码登录
- [ ] UFW 只开 22/80/443
- [ ] MySQL 只监听 127.0.0.1 或内网
- [ ] 8089 只监听 127.0.0.1
- [ ] `.env` 权限 600，属主 `zmtjl`
- [ ] `KEYS_DIR` 权限 600/700，定期备份
- [ ] `ADMIN_TOKEN`、`KEY_HMAC_SECRET`、`DATA_ENC_KEY` 独立随机
- [ ] HTTPS 证书自动续期
- [ ] 管理后台不暴露在无 HTTPS 的地址
- [ ] 备份加密并异地保存
- [ ] 定期检查 `journalctl` 和磁盘空间

---

## 15. 常见故障

| 现象 | 排查 |
|---|---|
| 502 Bad Gateway | `systemctl status zmtjl-license`；`ss -lntp \| grep 8089`；看 journal |
| 413 Request Entity Too Large | Nginx `client_max_body_size 300m` |
| 数据库连接失败 | 用户权限、`allowPublicKeyRetrieval=true`、MySQL 是否监听 127.0.0.1 |
| Flyway 校验失败 | 不要改已执行迁移；看日志里的 migration 版本 |
| `ADMIN_DISABLED` | `ADMIN_TOKEN` 为空或未重启 |
| 客户端激活失败 | `PUBLIC_BASE_URL`、DNS、HTTPS、服务器时间、KEYS_DIR |
| 所有请求 IP 一样 | 反代下设置 `TRUST_FORWARDED_FOR=true` 和 `TRUSTED_PROXIES` |
| 上传安装包失败 | Nginx 体积限制、磁盘空间、`RELEASES_DIR` 权限 |
| 证书申请失败 | DNS 未生效、80 端口被占用、防火墙 |

---

## 16. 上线检查清单

- [ ] 域名解析到服务器
- [ ] HTTPS 证书有效，HTTP 自动跳转
- [ ] `/v1/health` 200
- [ ] `/login.html` 能打开，`ADMIN_TOKEN` 能登录
- [ ] 新建卡密成功
- [ ] 客户端能激活
- [ ] 客户端扫码登录成功
- [ ] 发送/线索/自动回复按授权功能正常
- [ ] 8089/3306 未对公网开放
- [ ] `KEYS_DIR` 和数据库已备份
- [ ] 备份恢复演练通过
- [ ] 日志和磁盘监控已配置
- [ ] 升级/回滚步骤已演练
