-- 卡密授权服务：初始表结构
-- 时间统一存 BIGINT（epoch 毫秒），避免时区和数据库差异

CREATE TABLE plan (
  id            VARCHAR(36)  NOT NULL PRIMARY KEY,
  code          VARCHAR(32)  NOT NULL UNIQUE,
  name          VARCHAR(64)  NOT NULL,
  features_json TEXT         NOT NULL,
  device_limit  INT          NOT NULL,
  duration_days INT          NOT NULL,
  created_at    BIGINT       NOT NULL
);

CREATE TABLE license_key (
  id            VARCHAR(36)  NOT NULL PRIMARY KEY,
  -- 只存 HMAC-SHA256，绝不存卡密明文
  key_hash      VARCHAR(64)  NOT NULL UNIQUE,
  plan_id       VARCHAR(36)  NOT NULL,
  batch_id      VARCHAR(64),
  -- unused | active | revoked
  status        VARCHAR(16)  NOT NULL,
  -- 生成时可覆盖套餐默认有效期（天）
  duration_days INT,
  activated_at  BIGINT,
  expire_at     BIGINT,
  note          VARCHAR(255),
  created_at    BIGINT       NOT NULL
);
CREATE INDEX idx_key_batch  ON license_key (batch_id);
CREATE INDEX idx_key_status ON license_key (status);

CREATE TABLE activation (
  id             VARCHAR(36) NOT NULL PRIMARY KEY,
  key_id         VARCHAR(36) NOT NULL,
  device_id_hash VARCHAR(64) NOT NULL,
  app_version    VARCHAR(32),
  activated_at   BIGINT      NOT NULL,
  last_seen_at   BIGINT,
  revoked_at     BIGINT,
  last_ip        VARCHAR(64),
  CONSTRAINT uq_activation_key_device UNIQUE (key_id, device_id_hash)
);
CREATE INDEX idx_activation_key ON activation (key_id);

CREATE TABLE device (
  id             VARCHAR(36) NOT NULL PRIMARY KEY,
  device_id_hash VARCHAR(64) NOT NULL UNIQUE,
  first_seen_at  BIGINT      NOT NULL,
  last_seen_at   BIGINT,
  note           VARCHAR(255)
);

CREATE TABLE event_log (
  id             VARCHAR(36) NOT NULL PRIMARY KEY,
  type           VARCHAR(32) NOT NULL,
  key_id         VARCHAR(36),
  device_id_hash VARCHAR(64),
  meta_json      TEXT,
  created_at     BIGINT      NOT NULL
);
CREATE INDEX idx_event_time ON event_log (created_at);
