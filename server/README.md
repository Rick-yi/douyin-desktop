# 授权服务端（Spring Boot）

卡密签发、设备绑定、心跳续签、强制更新和商城订单。

## 要求

- JDK 17+
- Maven 3.9+
- MySQL 8（独立库，例如 `zmtjl_license`）

## 配置

```bash
cp .env.example .env
```

至少修改：

```dotenv
ADMIN_TOKEN=<openssl rand -base64 32>
KEY_HMAC_SECRET=<openssl rand -base64 32>
DATA_ENC_KEY=<openssl rand -base64 32>
DB_URL=jdbc:mysql://127.0.0.1:3306/zmtjl_license?useUnicode=true&characterEncoding=utf8&serverTimezone=Asia/Shanghai&allowPublicKeyRetrieval=true&useSSL=false
DB_USER=zmtjl
DB_PASSWORD=<your-password>
PUBLIC_BASE_URL=https://license.example.com
```

`KEYS_DIR` 下的 Ed25519 私钥用于签发客户端授权，**必须备份**；丢失后已签发
token 无法继续验签。

## 运行

```bash
mvn -DskipTests package
java -jar target/license-server-1.0.0.jar
```

或：

```bash
docker compose -f docker-compose.example.yml up -d
```

默认监听 `8089`。生产环境请放在 HTTPS 反向代理后，并设置
`PUBLIC_BASE_URL` 与 `TRUST_FORWARDED_FOR`。

## 数据库

Flyway 会在启动时执行 `src/main/resources/db/migration` 下的迁移。
不要在生产开启 `flyway clean`；项目已默认禁用。

## 管理后台

- `/login.html`：管理令牌登录
- `/admin.html`：卡密、套餐、商城、跳转卡、版本发布
- 管理令牌通过 `ADMIN_TOKEN` 环境变量设置，不写在代码里

## 安全

- 不要提交 `.env`、`data/`、`*.db`、`data/keys/*.pem`。
- 生产使用独立强随机密钥；不要把管理令牌和卡密密钥复用。
- 定期备份 `KEYS_DIR` 和数据库。
- 对外只暴露 HTTPS 反向代理，不要直接暴露 8089。
