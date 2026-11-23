-- 商品、订单、支付事件
-- 金额一律用「分」存 BIGINT，避免浮点误差

CREATE TABLE product (
  id            VARCHAR(36)  NOT NULL PRIMARY KEY,
  code          VARCHAR(64)  NOT NULL UNIQUE,
  name          VARCHAR(128) NOT NULL,
  plan_code     VARCHAR(32)  NOT NULL,
  price_cents   BIGINT       NOT NULL,
  -- 空表示用套餐默认天数
  duration_days INT,
  -- active | disabled
  status        VARCHAR(16)  NOT NULL,
  created_at    BIGINT       NOT NULL
);

CREATE TABLE shop_order (
  id             VARCHAR(36)  NOT NULL PRIMARY KEY,
  out_trade_no   VARCHAR(40)  NOT NULL UNIQUE,
  product_id     VARCHAR(36)  NOT NULL,
  amount_cents   BIGINT       NOT NULL,
  channel        VARCHAR(32)  NOT NULL,
  -- created | paid | refunded | cancelled | closed
  status         VARCHAR(16)  NOT NULL,
  -- 买家查询/取卡凭证，防止猜订单号盗卡
  delivery_token VARCHAR(64)  NOT NULL,
  transaction_id VARCHAR(64),
  key_id         VARCHAR(36),
  -- 卡密明文用 AES-GCM 加密后存这里，支持客服找回
  key_cipher     TEXT,
  buyer_note     VARCHAR(255),
  expires_at     BIGINT       NOT NULL,
  paid_at        BIGINT,
  delivered_at   BIGINT,
  closed_at      BIGINT,
  created_at     BIGINT       NOT NULL
);
CREATE INDEX idx_order_status ON shop_order (status);
CREATE INDEX idx_order_created ON shop_order (created_at);

CREATE TABLE payment_event (
  id           VARCHAR(36)  NOT NULL PRIMARY KEY,
  channel      VARCHAR(32)  NOT NULL,
  event_id     VARCHAR(128) NOT NULL,
  out_trade_no VARCHAR(40),
  amount_cents BIGINT,
  raw          TEXT,
  created_at   BIGINT       NOT NULL,
  CONSTRAINT uq_payment_event UNIQUE (channel, event_id)
);
