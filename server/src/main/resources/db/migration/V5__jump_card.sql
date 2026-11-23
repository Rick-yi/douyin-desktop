-- 跳转卡（短链跳转卡片）
-- code 是短链里的稳定标识；target_url 可以随时在后台改，已发出去的卡片链接不变
-- 点击统计分两张表：jump_card 上存累计值，jump_click 存明细

CREATE TABLE jump_card (
  id            VARCHAR(36)   NOT NULL PRIMARY KEY,
  code          VARCHAR(16)   NOT NULL UNIQUE,
  name          VARCHAR(128)  NOT NULL,
  target_url    VARCHAR(1024) NOT NULL,
  title         VARCHAR(128),
  description   VARCHAR(255),
  cover_url     VARCHAR(1024),
  group_name    VARCHAR(64),
  -- active | disabled
  status        VARCHAR(16)   NOT NULL,
  click_count   BIGINT        NOT NULL DEFAULT 0,
  last_click_at BIGINT,
  created_at    BIGINT        NOT NULL,
  updated_at    BIGINT        NOT NULL
);
CREATE INDEX idx_jump_status ON jump_card (status);
CREATE INDEX idx_jump_created ON jump_card (created_at);

CREATE TABLE jump_click (
  id         VARCHAR(36)   NOT NULL PRIMARY KEY,
  card_id    VARCHAR(36)   NOT NULL,
  code       VARCHAR(16)   NOT NULL,
  ip         VARCHAR(64),
  user_agent VARCHAR(512),
  referer    VARCHAR(1024),
  clicked_at BIGINT        NOT NULL
);
CREATE INDEX idx_jump_click_card ON jump_click (card_id, clicked_at);
CREATE INDEX idx_jump_click_time ON jump_click (clicked_at);
