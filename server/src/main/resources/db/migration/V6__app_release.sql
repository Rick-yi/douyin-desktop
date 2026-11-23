-- 客户端安装包发布记录
CREATE TABLE app_release (
  id            VARCHAR(36)   NOT NULL PRIMARY KEY,
  platform      VARCHAR(16)   NOT NULL,
  channel       VARCHAR(16)   NOT NULL,
  version       VARCHAR(32)   NOT NULL,
  min_version   VARCHAR(32),
  force_update  BOOLEAN       NOT NULL DEFAULT FALSE,
  notes         TEXT,
  file_name     VARCHAR(255)  NOT NULL,
  stored_name   VARCHAR(255)  NOT NULL,
  file_size     BIGINT        NOT NULL,
  sha256        CHAR(64)      NOT NULL,
  active        BOOLEAN       NOT NULL DEFAULT FALSE,
  created_at    BIGINT        NOT NULL,
  published_at  BIGINT
);

CREATE UNIQUE INDEX uk_app_release_version ON app_release (platform, channel, version);
CREATE INDEX idx_app_release_active ON app_release (platform, channel, active, published_at);
CREATE INDEX idx_app_release_created ON app_release (created_at);
