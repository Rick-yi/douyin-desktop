/**
 * SQLite 数据层
 * 用 Node 内置 node:sqlite（Node 22.5+），零额外依赖
 */
import { DatabaseSync } from 'node:sqlite';
import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let db = null;

/** 本地 schema 版本；每次结构性迁移 +1 */
const SCHEMA_VERSION = 19;
let migrationErrors = [];

export function getDataDir() {
  const dir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 迁移前备份，最多保留 5 份 */
function backupBeforeMigration(file, database) {
  const dir = path.join(path.dirname(file), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const cp = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (cp?.busy) throw new Error('WAL checkpoint busy');
  } catch (e) {
    throw new Error(`迁移前无法安全备份数据库（WAL checkpoint 失败）：${e.message}`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, `app-${stamp}.db`);
  fs.copyFileSync(file, dest);

  try {
    const files = fs.readdirSync(dir)
      .filter((f) => f.startsWith('app-') && f.endsWith('.db'))
      .sort();
    while (files.length > 5) {
      fs.unlinkSync(path.join(dir, files.shift()));
    }
  } catch {}
  return dest;
}

export function initDb() {
  if (db) return db;
  const dir = getDataDir();
  const file = path.join(dir, 'app.db');
  db = new DatabaseSync(file);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;`);

  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  const tableCount = Number(
    db.prepare(
      "SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    ).get()?.c ?? 0,
  );

  if (version > SCHEMA_VERSION) {
    throw new Error(`数据库版本 ${version} 高于当前客户端支持的 ${SCHEMA_VERSION}，请升级客户端`);
  }

  // 老库升级前先备份；新库不需要
  if (tableCount > 0 && version < SCHEMA_VERSION) {
    const backup = backupBeforeMigration(file, db);
    console.log(`[db] 迁移前已备份 -> ${backup}`);
  }

  db.exec(`

    -- ══════ 账号 ══════
    CREATE TABLE IF NOT EXISTS account (
      id            TEXT PRIMARY KEY,      -- 本地 id
      uid           TEXT UNIQUE,           -- 抖音 uid（字符串，防精度丢失）
      sec_uid       TEXT,
      douyin_id     TEXT,                  -- 抖音号
      nickname      TEXT,
      avatar_url    TEXT,
      avatar_local_url TEXT,              -- 本地缓存的头像（zmtjl-media URL）
      signature     TEXT,
      group_id      TEXT,
      tags          TEXT DEFAULT '[]',
      note          TEXT,
      -- 能力位（决定能用哪些功能）
      is_verified      INTEGER DEFAULT 0,  -- 是否蓝V
      can_send_image   INTEGER DEFAULT 0,
      can_send_emoji   INTEGER DEFAULT 0,
      can_invite_group INTEGER DEFAULT 0,
      can_dm           INTEGER DEFAULT 1,
      -- 状态
      status        TEXT DEFAULT 'cold',   -- cold|warm|hot|expired|blocked
      conn_state    TEXT DEFAULT 'offline', -- online|reconnecting|offline|expired
      exit_ip       TEXT,                   -- 该账号代理的实际出口 IP
      exit_ip_checked_at INTEGER,
      exit_ip_status TEXT DEFAULT 'unknown', -- ok|changed|failed|unknown
      risk_level    TEXT DEFAULT 'normal',
      last_login_at INTEGER,
      last_online_at INTEGER,
      last_sync_at  INTEGER,
      session_days  INTEGER DEFAULT 0,
      fail_count    INTEGER DEFAULT 0,
      enabled       INTEGER DEFAULT 1,
      proxy_id      TEXT,
      created_at    INTEGER NOT NULL
    );

    -- ══════ 会话 ══════
    CREATE TABLE IF NOT EXISTS conversation (
      id               TEXT PRIMARY KEY,
      account_id       TEXT NOT NULL,
      peer_uid         TEXT NOT NULL,
      peer_sec_uid     TEXT,
      conv_id          TEXT,
      peer_nickname    TEXT,
      peer_douyin_id   TEXT,
      peer_avatar      TEXT,
      kind             TEXT DEFAULT 'friend', -- friend|group|stranger
      last_msg_preview TEXT,
      last_msg_type    TEXT DEFAULT 'text',
      last_msg_at      INTEGER,
      unread_count     INTEGER DEFAULT 0,
      pinned           INTEGER DEFAULT 0,
      muted            INTEGER DEFAULT 0,
      archived         INTEGER DEFAULT 0,
      created_at       INTEGER,
      UNIQUE(account_id, peer_uid)
    );
    CREATE INDEX IF NOT EXISTS idx_conv_account ON conversation(account_id, last_msg_at DESC);

    -- ══════ 消息 ══════
    CREATE TABLE IF NOT EXISTS message (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      account_id      TEXT NOT NULL,
      direction       TEXT,             -- in|out
      msg_type        TEXT,             -- text|image|video|card|emoji|file|system|unknown
      content         TEXT,             -- 展示用文本
      raw_content     TEXT,             -- SDK 原始 content（用于富消息重渲染）
      chat_type       TEXT,             -- private|group|stranger
      sender_uid      TEXT,
      sender_sec_uid  TEXT,
      sender_name     TEXT,
      sender_avatar   TEXT,
      media_url       TEXT,             -- 远端图片/视频/表情地址
      media_path      TEXT,             -- 本地缓存文件
      index_in_conversation    TEXT,    -- 已读回执用
      index_in_conversation_v2 TEXT,
      recalled        INTEGER DEFAULT 0,
      recalled_at     INTEGER,
      seq             INTEGER,
      source_msg_id   TEXT UNIQUE,      -- 幂等键（服务端 ID 或客户端 ID）
      server_msg_id   TEXT,             -- 真实服务端消息 ID（回复/撤回/转发/表态用）
      client_msg_id   TEXT,             -- 客户端消息 ID（删除/幂等）
      message_type    INTEGER,          -- SDK 原始 messageType（回复引用用）
      sent_at         INTEGER,
      status          TEXT,             -- pending|sent|failed|unknown
      verify_level    TEXT,             -- strong|weak|fail
      created_at      INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_msg_conv ON message(conversation_id, seq);

    -- ══════ 发送日志 ══════
    CREATE TABLE IF NOT EXISTS send_log (
      id            TEXT PRIMARY KEY,
      account_id    TEXT NOT NULL,
      scene         TEXT,               -- dm|comment|broadcast|intercept
      task_id       TEXT,
      peer_uid      TEXT,
      peer_nickname TEXT,
      content       TEXT,
      msg_type      TEXT,
      status        TEXT,               -- sent|failed|skipped|unknown
      reason        TEXT,
      verify_level  TEXT,
      screenshot    TEXT,
      created_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sendlog_acc ON send_log(account_id, created_at DESC);

    -- ══════ 代理 ══════
    CREATE TABLE IF NOT EXISTS proxy (
      id          TEXT PRIMARY KEY,
      url         TEXT UNIQUE,
      type        TEXT DEFAULT 'http',
      exit_ip     TEXT,
      location    TEXT,
      latency_ms  INTEGER,
      status      TEXT DEFAULT 'unknown',
      checked_at  INTEGER
    );

    -- ══════ 自动回复规则 ══════
    CREATE TABLE IF NOT EXISTS reply_rule (
      id          TEXT PRIMARY KEY,
      name        TEXT,
      scope       TEXT DEFAULT 'dm',    -- dm|comment|both
      match_type  TEXT DEFAULT 'contains',
      pattern     TEXT,
      reply_text  TEXT,
      reply_type  TEXT DEFAULT 'text',   -- text|card（旧字段，兼容保留）
      card_id     TEXT,                  -- reply_type=card 时引用的卡片
      content_json TEXT,                 -- 多消息组合（版本化）
      content_version INTEGER DEFAULT 1,
      level       TEXT DEFAULT 'draft', -- auto|draft|notify
      priority    INTEGER DEFAULT 0,
      account_ids TEXT DEFAULT '',       -- 逗号分隔本地账号 id，空=全部
      chat_types  TEXT DEFAULT 'private,group,stranger',
      cooldown_sec INTEGER DEFAULT 0,    -- 同一条规则对同一会话的冷却
      enabled     INTEGER DEFAULT 1,
      hit_count   INTEGER DEFAULT 0,
      created_at  INTEGER
    );

    -- ══════ 敏感词 ══════
    CREATE TABLE IF NOT EXISTS sensitive_group (
      id   TEXT PRIMARY KEY,
      name TEXT,
      sort INTEGER DEFAULT 0,
      description TEXT
    );
    CREATE TABLE IF NOT EXISTS sensitive_word (
      id         TEXT PRIMARY KEY,
      group_id   TEXT,
      word       TEXT NOT NULL,
      match_type TEXT DEFAULT 'contains',
      action     TEXT DEFAULT 'warn',   -- block|warn|replace
      replace_to TEXT,
      -- 合规改写
      suggestion     TEXT,              -- 合规替代说法，空表示只能删除
      rewrite_policy TEXT DEFAULT 'manual', -- replace|remove|block|manual
      category       TEXT,              -- 广告法/医疗/导流/迷信...
      basis          TEXT,              -- 法条/规则依据
      scope      TEXT DEFAULT 'dm,comment,broadcast,intercept',
      enabled    INTEGER DEFAULT 1,
      severity   INTEGER DEFAULT 2,     -- 1 低危 / 2 中危 / 3 高危（用于评分）
      message    TEXT                   -- 命中提示语
    );

    -- ══════ 合规整句模板 ══════
    CREATE TABLE IF NOT EXISTS rewrite_template (
      id            TEXT PRIMARY KEY,
      industry      TEXT DEFAULT '通用',
      scene         TEXT DEFAULT 'dm',
      name          TEXT,
      triggers      TEXT DEFAULT '',
      template_text TEXT,
      basis         TEXT,
      priority      INTEGER DEFAULT 0,
      enabled       INTEGER DEFAULT 1,
      created_at    INTEGER
    );

    -- ══════ 敏感词命中记录 ══════
    CREATE TABLE IF NOT EXISTS sensitive_hit (
      id         TEXT PRIMARY KEY,
      word_id    TEXT,
      word       TEXT,
      group_id   TEXT,
      account_id TEXT,
      scene      TEXT,
      content    TEXT,
      action     TEXT,
      severity   INTEGER,
      created_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_hit_day ON sensitive_hit(created_at);
    CREATE INDEX IF NOT EXISTS idx_hit_word ON sensitive_hit(word_id, created_at);

    -- ══════ 卡片（只保留跳转卡片；旧类型字段仅为兼容历史数据）══════
    CREATE TABLE IF NOT EXISTS card (
      id          TEXT PRIMARY KEY,
      kind        TEXT DEFAULT 'image',  -- link；历史数据可能是 image|share|user|file
      name        TEXT,
      group_name  TEXT DEFAULT '默认',
      file_path   TEXT NOT NULL,      -- 历史图片/文件卡片使用，跳转卡为空串
      mime        TEXT,
      size_bytes  INTEGER,
      width       INTEGER,
      height      INTEGER,
      text_tpl    TEXT,               -- 配套文本，支持变量
      link_url        TEXT,           -- 跳转卡片：跳转地址
      link_title      TEXT,           -- 跳转卡片：标题
      link_desc       TEXT,           -- 跳转卡片：描述
      link_cover_url  TEXT,           -- 跳转卡片：封面图（必须是公网 http/https）
      server_code     TEXT,           -- 服务端跳转卡标识（同步卡片使用）
      payload     TEXT,               -- 历史卡片扩展字段，跳转卡不使用
      use_count   INTEGER DEFAULT 0,
      created_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_card_group ON card(group_name, created_at DESC);

    -- ══════ 自动回复草稿 ══════
    CREATE TABLE IF NOT EXISTS reply_draft (
      id           TEXT PRIMARY KEY,
      account_id   TEXT NOT NULL,
      peer_uid     TEXT NOT NULL,
      peer_name    TEXT,
      trigger_text TEXT,              -- 触发的原消息
      draft_text   TEXT,              -- 生成的草稿（卡片时为附带文本）
      draft_type   TEXT DEFAULT 'text', -- text|card
      card_id      TEXT,
      card_name    TEXT,
      content_json TEXT,                 -- 多消息草稿快照
      content_version INTEGER DEFAULT 1,
      rule_id      TEXT,
      reason       TEXT,              -- 为什么进草稿：rule_draft|sensitive|manual
      status       TEXT DEFAULT 'pending',  -- pending|sent|discarded
      created_at   INTEGER,
      handled_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_draft_status ON reply_draft(status, created_at DESC);

    -- ══════ 会话自动回复状态（防刷屏）══════
    CREATE TABLE IF NOT EXISTS reply_session_state (
      account_id         TEXT NOT NULL,
      peer_uid           TEXT NOT NULL,
      last_auto_reply_at INTEGER,
      auto_reply_count   INTEGER DEFAULT 0,   -- 当天自动回复次数
      transferred        INTEGER DEFAULT 0,   -- 是否已转人工
      paused_until       INTEGER,              -- 转人工暂停到什么时候
      last_rule_id       TEXT,
      last_rule_at       INTEGER,
      day_key            TEXT,                -- YYYYMMDD，跨天重置
      PRIMARY KEY (account_id, peer_uid)
    );

    -- ══════ 自动回复日志 ══════
    CREATE TABLE IF NOT EXISTS reply_log (
      id           TEXT PRIMARY KEY,
      account_id   TEXT NOT NULL,
      peer_uid     TEXT,
      peer_name    TEXT,
      rule_id      TEXT,
      rule_name    TEXT,
      trigger_text TEXT,
      reply_text   TEXT,
      action       TEXT,              -- auto_sent|draft|notify|no_reply|blocked
      reason       TEXT,              -- 为什么：命中规则/静默时段/冷却/超限/转人工/敏感词
      score        INTEGER,           -- 敏感词评分
      created_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_replylog_time ON reply_log(created_at DESC);

    -- ══════ 任务（群发/截流共用） ══════
    CREATE TABLE IF NOT EXISTS outreach_task (
      id            TEXT PRIMARY KEY,
      kind          TEXT NOT NULL,      -- broadcast|intercept
      name          TEXT,
      account_ids   TEXT DEFAULT '[]',
      target_mode   TEXT,
      target_raw    TEXT,
      target_count  INTEGER DEFAULT 0,
      source_json   TEXT,
      content_type  TEXT DEFAULT 'text',
      content_items TEXT DEFAULT '[]',
      content_strategy TEXT DEFAULT 'random',
      gap_sec        INTEGER DEFAULT 15,
      batch_size     INTEGER DEFAULT 5,
      round_wait_sec INTEGER DEFAULT 300,
      daily_limit    INTEGER DEFAULT 20,
      hourly_limit   INTEGER DEFAULT 5,
      stage         TEXT DEFAULT 'draft',
      progress      INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      fail_count    INTEGER DEFAULT 0,
      -- 采集进度（后台采集时 UI 轮询显示）
      harvest_total   INTEGER DEFAULT 0,
      harvest_scanned INTEGER DEFAULT 0,
      harvest_phase   TEXT DEFAULT '',   -- searching|scanning|monitoring|done|failed
      search_total    INTEGER DEFAULT 0,
      search_found    INTEGER DEFAULT 0,
      harvest_error   TEXT,
      harvest_summary TEXT,
      targets_json    TEXT,               -- 群发任务目标快照（重启恢复用）
      throttle_json   TEXT,               -- 群发任务节流配置快照（重启恢复用）
      scheduled_at  INTEGER,
      created_at    INTEGER,
      started_at    INTEGER,
      finished_at   INTEGER
    );

    -- ══════ 任务目标（群发/截流的收件人）══════
    CREATE TABLE IF NOT EXISTS outreach_item (
      id            TEXT PRIMARY KEY,
      task_id       TEXT NOT NULL,
      account_id    TEXT,
      peer_uid      TEXT NOT NULL,
      peer_nickname TEXT,
      source_video  TEXT,
      source_video_title TEXT,
      source_comment TEXT,
      source_keyword TEXT,
      source_cid    TEXT,               -- 命中的评论/回复 ID
      comment_type  TEXT DEFAULT 'root', -- root|reply|manual
      parent_cid    TEXT,               -- 楼中楼所属根评论
      comment_likes INTEGER DEFAULT 0,
      comment_at    INTEGER,
      content       TEXT,
      status        TEXT DEFAULT 'pending',  -- pending|approved|excluded|sent|failed|skipped
      reason        TEXT,
      server_msg_id TEXT,
      sent_at       INTEGER,
      peer_sec_uid  TEXT,               -- 评论用户 sec_uid（在线状态接口需要）
      last_active_at INTEGER,           -- 最近活跃时间（毫秒）
      online        INTEGER,            -- 1 在线 / 0 离线 / NULL 未知
      presence_checked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_item_task ON outreach_item(task_id, status);

    -- 同一用户的多条评论来源历史（outreach_item 只保留最新一条）
    CREATE TABLE IF NOT EXISTS outreach_comment_history (
      id            TEXT PRIMARY KEY,
      task_id       TEXT NOT NULL,
      item_id       TEXT,
      peer_uid      TEXT NOT NULL,
      source_video  TEXT,
      source_video_title TEXT,
      source_comment TEXT,
      source_keyword TEXT,
      source_cid    TEXT,
      comment_type  TEXT,
      parent_cid    TEXT,
      comment_likes INTEGER DEFAULT 0,
      comment_at    INTEGER,
      created_at    INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_history_unique
      ON outreach_comment_history(task_id, peer_uid, source_cid);
    CREATE INDEX IF NOT EXISTS idx_comment_history_item
      ON outreach_comment_history(item_id);

    -- ══════ 同行监控（独立资产库）══════
    CREATE TABLE IF NOT EXISTS competitor (
      id                 TEXT PRIMARY KEY,
      sec_uid            TEXT NOT NULL UNIQUE,
      uid                TEXT,
      nickname           TEXT,
      avatar_url         TEXT,
      latest_video_at    INTEGER,
      active_level       TEXT DEFAULT 'unknown', -- active|normal|inactive|unknown
      video_count        INTEGER DEFAULT 0,
      monitor_enabled    INTEGER DEFAULT 1,      -- 默认全视频监控
      video_scope        TEXT DEFAULT 'all',
      last_synced_at     INTEGER,
      last_error         TEXT,
      created_at         INTEGER,
      updated_at         INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_competitor_active ON competitor(active_level, latest_video_at DESC);
    CREATE INDEX IF NOT EXISTS idx_competitor_updated ON competitor(updated_at DESC);

    CREATE TABLE IF NOT EXISTS competitor_keyword (
      competitor_id  TEXT NOT NULL,
      keyword        TEXT NOT NULL,
      created_at     INTEGER,
      PRIMARY KEY (competitor_id, keyword)
    );
    CREATE INDEX IF NOT EXISTS idx_competitor_keyword ON competitor_keyword(keyword, competitor_id);

    CREATE TABLE IF NOT EXISTS competitor_video (
      aweme_id        TEXT PRIMARY KEY,
      competitor_id   TEXT NOT NULL,
      title           TEXT,
      cover_url       TEXT,
      create_time     INTEGER,
      digg_count      INTEGER DEFAULT 0,
      comment_count   INTEGER DEFAULT 0,
      share_count     INTEGER DEFAULT 0,
      share_url       TEXT,
      monitor_enabled INTEGER DEFAULT 1,
      excluded        INTEGER DEFAULT 0,
      unavailable     INTEGER DEFAULT 0,
      last_synced_at  INTEGER,
      created_at      INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_competitor_video_peer ON competitor_video(competitor_id, create_time DESC);
    CREATE INDEX IF NOT EXISTS idx_competitor_video_time ON competitor_video(create_time DESC);

    CREATE TABLE IF NOT EXISTS competitor_scan_job (
      id              TEXT PRIMARY KEY,
      keywords        TEXT,
      account_id      TEXT,
      status          TEXT DEFAULT 'running', -- running|done|failed|cancelled
      phase           TEXT,
      competitors     INTEGER DEFAULT 0,
      active_count    INTEGER DEFAULT 0,
      video_count     INTEGER DEFAULT 0,
      error           TEXT,
      summary         TEXT,
      created_at      INTEGER,
      finished_at     INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_competitor_job_time ON competitor_scan_job(created_at DESC);

    -- 同行采集断点：关键词翻页进度 + 候选同行处理进度
    CREATE TABLE IF NOT EXISTS competitor_scan_keyword (
      job_id      TEXT NOT NULL,
      keyword     TEXT NOT NULL,
      cursor      INTEGER DEFAULT 0,
      done        INTEGER DEFAULT 0,
      updated_at  INTEGER,
      PRIMARY KEY (job_id, keyword)
    );

    CREATE TABLE IF NOT EXISTS competitor_scan_item (
      job_id          TEXT NOT NULL,
      sec_uid         TEXT NOT NULL,
      uid             TEXT,
      nickname        TEXT,
      avatar_url      TEXT,
      keywords        TEXT DEFAULT '[]',
      status          TEXT DEFAULT 'pending', -- pending|done|skipped|failed
      active_level    TEXT,
      competitor_id   TEXT,
      video_count     INTEGER DEFAULT 0,
      attempts        INTEGER DEFAULT 0,
      error           TEXT,
      created_at      INTEGER,
      updated_at      INTEGER,
      PRIMARY KEY (job_id, sec_uid)
    );
    CREATE INDEX IF NOT EXISTS idx_scan_item_status ON competitor_scan_item(job_id, status);

    -- 线索任务引用同行（任务默认全视频监控）
    CREATE TABLE IF NOT EXISTS outreach_task_competitor (
      task_id         TEXT NOT NULL,
      competitor_id   TEXT NOT NULL,
      created_at      INTEGER,
      PRIMARY KEY (task_id, competitor_id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_competitor ON outreach_task_competitor(competitor_id, task_id);

    -- ══════ 持续监控（挂在截流任务上）══════
    CREATE TABLE IF NOT EXISTS monitor (
      task_id       TEXT PRIMARY KEY,
      mode          TEXT,                    -- video | keyword
      keywords      TEXT DEFAULT '[]',
      videos        TEXT DEFAULT '[]',       -- [{awemeId, desc, commentCount, keyword, addedAt, lastScanAt}]
      interval_min  INTEGER DEFAULT 60,
      interval_sec  INTEGER DEFAULT 60,
      pages_per_video INTEGER DEFAULT 1,
      keywords_per_round INTEGER DEFAULT 3,
      videos_per_round   INTEGER DEFAULT 2,
      request_gap_min_ms INTEGER DEFAULT 1500,
      request_gap_max_ms INTEGER DEFAULT 3000,
      scan_concurrency  INTEGER DEFAULT 10,
      discovery_interval_sec INTEGER DEFAULT 120,
      last_discovery_at INTEGER,
      enabled       INTEGER DEFAULT 1,
      rounds        INTEGER DEFAULT 0,
      last_run_at   INTEGER,
      next_run_at   INTEGER,
      last_summary  TEXT,
      since_at      INTEGER,
      created_at    INTEGER
    );

    -- 监控期间见过的新评论（用于统计「开始监控之后的新评论」）
    CREATE TABLE IF NOT EXISTS monitor_comment (
      task_id       TEXT NOT NULL,
      cid           TEXT NOT NULL,
      create_time   INTEGER,
      first_seen_at INTEGER,
      aweme_id      TEXT,               -- 所属视频（楼中楼请求需要）
      parent_cid    TEXT,               -- NULL=根评论；非空=根评论下的回复
      reply_total   INTEGER DEFAULT 0,  -- 根评论当前回复数
      reply_seen_total INTEGER DEFAULT 0,
      reply_fetched_at INTEGER,
      PRIMARY KEY (task_id, cid)
    );

    -- 跨任务去重：同一个人不能被同一账号私信第二次
    CREATE TABLE IF NOT EXISTS dm_history (
      account_id TEXT NOT NULL,
      peer_uid   TEXT NOT NULL,
      first_at   INTEGER,
      last_at    INTEGER,
      count      INTEGER DEFAULT 0,
      PRIMARY KEY (account_id, peer_uid)
    );

    -- ══════ 设置 ══════
    CREATE TABLE IF NOT EXISTS setting (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    -- ══════ 发送器持久状态（配额/熔断，重启不丢）══════
    CREATE TABLE IF NOT EXISTS sender_state (
      account_id        TEXT PRIMARY KEY,
      hour_key          TEXT,
      hourly            INTEGER DEFAULT 0,
      day_key           TEXT,
      daily             INTEGER DEFAULT 0,
      last_send_at      INTEGER,
      breaker_until     INTEGER,
      breaker_reason    TEXT,
      breaker_tripped_at INTEGER,
      consecutive_fail  INTEGER DEFAULT 0,
      recent            TEXT DEFAULT '[]',
      updated_at        INTEGER
    );

    -- 热查询索引在 migrate() 里创建：旧库可能还没补列
  `);

  migrationErrors = [];
  migrate(db);
  if (migrationErrors.length) {
    const detail = migrationErrors.map((e) => `${e.table}.${e.column}: ${e.error}`).join('; ');
    throw new Error(`数据库迁移失败（已备份）：${detail}`);
  }

  // v14：把历史监控任务的扫描并发从 2/3/4 提升到 10（20 路档保持 20）
  if (version > 0 && version < 14) {
    try {
      const n = db.prepare(
        'UPDATE monitor SET scan_concurrency = 10 WHERE scan_concurrency IS NULL OR scan_concurrency < 10',
      ).run().changes;
      if (n) console.log(`[db] 监控扫描并发已提升到 10：${n} 个任务`);
    } catch (e) {
      console.warn('[db] 提升监控并发失败:', e.message);
    }
  }

  seedDefaults(db);
  seedRewriteTemplates(db);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

  const integrity = db.prepare('PRAGMA integrity_check').get();
  if (integrity?.integrity_check !== 'ok') {
    throw new Error(`数据库完整性检查失败：${integrity?.integrity_check ?? 'unknown'}`);
  }
  cleanupOldData(db);
  return db;
}

/** 启动时清理过期日志，避免 send_log/reply_log/monitor_comment 无限增长 */
function cleanupOldData(database) {
  try {
    const now = Date.now();
    const logCut = now - 90 * 86400000;
    const n1 = database.prepare('DELETE FROM send_log WHERE created_at < ?').run(logCut).changes;
    const n2 = database.prepare('DELETE FROM reply_log WHERE created_at < ?').run(logCut).changes;
    const n3 = database
      .prepare('DELETE FROM monitor_comment WHERE create_time < ?')
      .run(Math.floor((now - 30 * 86400000) / 1000)).changes;
    const n4 = database
      .prepare('DELETE FROM outreach_comment_history WHERE created_at < ?')
      .run(now - 180 * 86400000).changes;
    if (n1 || n2 || n3 || n4) {
      console.log(`[db] 清理过期数据：send_log=${n1} reply_log=${n2} monitor_comment=${n3} comment_history=${n4}`);
    }
    database.exec('PRAGMA optimize');
  } catch (e) {
    console.warn('[db] 清理过期数据失败:', e.message);
  }
}

/**
 * 轻量迁移：给已存在的表补列
 *
 * ★ 为什么需要：CREATE TABLE IF NOT EXISTS 不会修改已有表结构，
 *   老数据库升级后会缺列，导致 seedDefaults 报错。
 */
function migrate(db) {
  function addColumnIfMissing(table, column, ddl) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all();
      if (!cols.length) return false; // 表不存在，CREATE 会处理
      if (cols.some((c) => c.name === column)) return false;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
      console.log(`[db] 迁移：${table}.${column} 已添加`);
      return true;
    } catch (e) {
      console.warn(`[db] 迁移 ${table}.${column} 失败:`, e.message);
      if (!/duplicate column name/i.test(String(e.message ?? ''))) {
        migrationErrors.push({ table, column, error: e.message });
      }
      return false;
    }
  }

  // 敏感词
  addColumnIfMissing('sensitive_word', 'severity', 'INTEGER DEFAULT 2');
  // v10：给已有整句模板补评论场景（新库 seed 已包含 comment）
  try {
    db.exec("UPDATE rewrite_template SET scene = scene || ',comment' WHERE scene NOT LIKE '%comment%'");
  } catch {}
  addColumnIfMissing('sensitive_word', 'message', 'TEXT');
  addColumnIfMissing('sensitive_word', 'suggestion', 'TEXT');
  addColumnIfMissing('sensitive_word', 'rewrite_policy', "TEXT DEFAULT 'manual'");
  addColumnIfMissing('sensitive_word', 'category', 'TEXT');
  addColumnIfMissing('sensitive_word', 'basis', 'TEXT');
  addColumnIfMissing('sensitive_group', 'description', 'TEXT');

  // 自动回复
  addColumnIfMissing('reply_rule', 'action_type', "TEXT DEFAULT 'reply'");
  addColumnIfMissing('reply_rule', 'delay_ms', 'INTEGER DEFAULT 1500');
  addColumnIfMissing('reply_rule', 'delay_jitter_ms', 'INTEGER DEFAULT 3000');
  addColumnIfMissing('reply_rule', 'account_ids', "TEXT DEFAULT ''");
  addColumnIfMissing('reply_rule', 'chat_types', "TEXT DEFAULT 'private,group,stranger'");
  addColumnIfMissing('reply_rule', 'cooldown_sec', 'INTEGER DEFAULT 0');
  addColumnIfMissing('reply_rule', 'reply_type', "TEXT DEFAULT 'text'");
  addColumnIfMissing('reply_rule', 'card_id', 'TEXT');
  addColumnIfMissing('reply_rule', 'content_json', 'TEXT');
  addColumnIfMissing('reply_rule', 'content_version', 'INTEGER DEFAULT 1');
  addColumnIfMissing('reply_draft', 'draft_type', "TEXT DEFAULT 'text'");
  addColumnIfMissing('reply_draft', 'card_id', 'TEXT');
  addColumnIfMissing('reply_draft', 'card_name', 'TEXT');
  addColumnIfMissing('reply_draft', 'content_json', 'TEXT');
  addColumnIfMissing('reply_draft', 'content_version', 'INTEGER DEFAULT 1');
  addColumnIfMissing('reply_session_state', 'paused_until', 'INTEGER');
  addColumnIfMissing('reply_session_state', 'last_rule_id', 'TEXT');
  addColumnIfMissing('reply_session_state', 'last_rule_at', 'INTEGER');

  // 修复历史消息时间戳：旧版本把毫秒 createTime 又乘了 1000
  try {
    const fixed = db.prepare(
      'UPDATE message SET sent_at = CAST(sent_at / 1000 AS INTEGER) WHERE sent_at > 100000000000000',
    ).run();
    if (fixed.changes) console.log(`[db] 修复消息时间戳 ${fixed.changes} 条`);
  } catch {}

  // 发送日志
  addColumnIfMissing('send_log', 'task_id', 'TEXT');
  addColumnIfMissing('send_log', 'verify_level', 'TEXT');

  // 代理
  addColumnIfMissing('proxy', 'name', 'TEXT');
  addColumnIfMissing('proxy', 'note', 'TEXT');
  addColumnIfMissing('proxy', 'enabled', 'INTEGER DEFAULT 1');

  // 账号：在线状态与最后在线时间（断线不再直接标成登录失效）
  addColumnIfMissing('account', 'conn_state', "TEXT DEFAULT 'offline'");
  addColumnIfMissing('account', 'avatar_local_url', 'TEXT');
  addColumnIfMissing('account', 'last_online_at', 'INTEGER');
  addColumnIfMissing('account', 'exit_ip', 'TEXT');
  addColumnIfMissing('account', 'exit_ip_checked_at', 'INTEGER');
  addColumnIfMissing('account', 'exit_ip_status', "TEXT DEFAULT 'unknown'");

  // 会话：类型/免打扰/最后消息类型（群聊、富消息预览）
  addColumnIfMissing('conversation', 'kind', "TEXT DEFAULT 'friend'");
  addColumnIfMissing('conversation', 'last_msg_type', "TEXT DEFAULT 'text'");
  addColumnIfMissing('conversation', 'muted', 'INTEGER DEFAULT 0');

  // 消息：富消息与已读回执所需字段
  addColumnIfMissing('message', 'raw_content', 'TEXT');
  addColumnIfMissing('message', 'chat_type', 'TEXT');
  addColumnIfMissing('message', 'sender_uid', 'TEXT');
  addColumnIfMissing('message', 'sender_sec_uid', 'TEXT');
  addColumnIfMissing('message', 'sender_name', 'TEXT');
  addColumnIfMissing('message', 'sender_avatar', 'TEXT');
  addColumnIfMissing('message', 'server_msg_id', 'TEXT');
  addColumnIfMissing('message', 'client_msg_id', 'TEXT');
  addColumnIfMissing('message', 'message_type', 'INTEGER');
  addColumnIfMissing('message', 'media_url', 'TEXT');
  addColumnIfMissing('message', 'index_in_conversation', 'TEXT');
  addColumnIfMissing('message', 'index_in_conversation_v2', 'TEXT');
  addColumnIfMissing('message', 'recalled', 'INTEGER DEFAULT 0');
  addColumnIfMissing('message', 'recalled_at', 'INTEGER');
  addColumnIfMissing('message', 'sent_at', 'INTEGER');

  // 卡片：跳转卡片（kind=image 的老数据保持原样）
  addColumnIfMissing('card', 'kind', "TEXT DEFAULT 'image'");
  addColumnIfMissing('card', 'link_url', 'TEXT');
  addColumnIfMissing('card', 'link_title', 'TEXT');
  addColumnIfMissing('card', 'link_desc', 'TEXT');
  addColumnIfMissing('card', 'link_cover_url', 'TEXT');
  addColumnIfMissing('card', 'server_code', 'TEXT');
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_card_server_code
             ON card(server_code) WHERE server_code IS NOT NULL`);
  } catch (e) {
    console.warn('[db] 创建服务端卡片索引失败:', e.message);
  }
  addColumnIfMissing('card', 'payload', 'TEXT');

  // 监控基线（只统计开始监控后的新评论）
  addColumnIfMissing('monitor', 'since_at', 'INTEGER');
  // 监控扫描速度：请求间隔可按任务单独调快
  addColumnIfMissing('monitor', 'request_gap_min_ms', 'INTEGER DEFAULT 1500');
  addColumnIfMissing('monitor', 'request_gap_max_ms', 'INTEGER DEFAULT 3000');
  addColumnIfMissing('monitor', 'scan_concurrency', 'INTEGER DEFAULT 10');
  addColumnIfMissing('monitor', 'discovery_interval_sec', 'INTEGER DEFAULT 120');
  addColumnIfMissing('monitor', 'last_discovery_at', 'INTEGER');
  // 楼中楼：记录根评论所属视频、回复数和抓取进度
  addColumnIfMissing('monitor_comment', 'aweme_id', 'TEXT');
  addColumnIfMissing('monitor_comment', 'parent_cid', 'TEXT');
  addColumnIfMissing('monitor_comment', 'reply_total', 'INTEGER DEFAULT 0');
  addColumnIfMissing('monitor_comment', 'reply_seen_total', 'INTEGER DEFAULT 0');
  addColumnIfMissing('monitor_comment', 'reply_fetched_at', 'INTEGER');

  // 监控支持秒级间隔：老数据按分钟换算一次
  try {
    const had = db.prepare('PRAGMA table_info(monitor)').all().some((c) => c.name === 'interval_sec');
    addColumnIfMissing('monitor', 'interval_sec', 'INTEGER DEFAULT 60');
    if (!had) db.exec('UPDATE monitor SET interval_sec = interval_min * 60');
  } catch (e) {}

  // 任务被删后残留的监控记录：会阻塞调度器，启动时清掉
  try {
    const n = db.prepare('DELETE FROM monitor WHERE task_id NOT IN (SELECT id FROM outreach_task)').run().changes;
    if (n) console.log(`[db] 清理 ${n} 条孤儿监控`);
  } catch (e) {}

  // 采集进度
  addColumnIfMissing('outreach_task', 'harvest_total', 'INTEGER DEFAULT 0');
  addColumnIfMissing('outreach_task', 'harvest_scanned', 'INTEGER DEFAULT 0');
  addColumnIfMissing('outreach_task', 'harvest_phase', "TEXT DEFAULT ''");
  addColumnIfMissing('outreach_task', 'search_total', 'INTEGER DEFAULT 0');
  addColumnIfMissing('outreach_task', 'search_found', 'INTEGER DEFAULT 0');
  addColumnIfMissing('outreach_task', 'search_keywords', "TEXT DEFAULT '[]'");
  addColumnIfMissing('outreach_task', 'harvest_error', 'TEXT');
  addColumnIfMissing('outreach_task', 'harvest_summary', 'TEXT');
  addColumnIfMissing('outreach_task', 'scheduled_at', 'INTEGER');
  addColumnIfMissing('outreach_task', 'targets_json', 'TEXT');
  addColumnIfMissing('outreach_task', 'throttle_json', 'TEXT');

  // 截流线索来源
  addColumnIfMissing('outreach_item', 'source_video_title', 'TEXT');
  addColumnIfMissing('outreach_item', 'source_keyword', 'TEXT');
  addColumnIfMissing('outreach_item', 'comment_likes', 'INTEGER DEFAULT 0');
  addColumnIfMissing('outreach_item', 'comment_at', 'INTEGER');
  addColumnIfMissing('outreach_item', 'source_cid', 'TEXT');
  const addedCommentType = addColumnIfMissing('outreach_item', 'comment_type', "TEXT DEFAULT 'root'");
  addColumnIfMissing('outreach_item', 'parent_cid', 'TEXT');
  // 线索用户在线状态
  addColumnIfMissing('outreach_item', 'peer_sec_uid', 'TEXT');
  addColumnIfMissing('outreach_item', 'last_active_at', 'INTEGER');
  addColumnIfMissing('outreach_item', 'online', 'INTEGER');
  addColumnIfMissing('outreach_item', 'presence_checked_at', 'INTEGER');

  // 热查询索引：放在补列之后，避免旧库缺列导致启动失败
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_msg_conv_time ON message(conversation_id, sent_at DESC);
      CREATE INDEX IF NOT EXISTS idx_item_task_status_time ON outreach_item(task_id, status, comment_at DESC);
      CREATE INDEX IF NOT EXISTS idx_item_task_uid ON outreach_item(task_id, peer_uid);
      CREATE INDEX IF NOT EXISTS idx_sendlog_task ON send_log(task_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_monitor_comment_time ON monitor_comment(task_id, create_time);
      CREATE INDEX IF NOT EXISTS idx_monitor_comment_reply ON monitor_comment(task_id, parent_cid, reply_fetched_at);
      CREATE INDEX IF NOT EXISTS idx_monitor_comment_video_time ON monitor_comment(aweme_id, create_time);
      CREATE INDEX IF NOT EXISTS idx_monitor_due ON monitor(enabled, next_run_at);
      CREATE INDEX IF NOT EXISTS idx_item_task_presence ON outreach_item(task_id, presence_checked_at);
    `);
  } catch (e) {
    console.warn('[db] 创建热查询索引失败:', e.message);
  }

  // v6：给历史线索补“根评论/楼中楼/手动导入”标注
  if (addedCommentType) {
    try {
      const manual = db.prepare(
        `UPDATE outreach_item SET comment_type = 'manual'
         WHERE task_id IN (SELECT id FROM outreach_task WHERE target_mode = 'manual')`,
      ).run().changes;

      const reply = db.prepare(
        `UPDATE outreach_item
         SET comment_type = 'reply',
             parent_cid = COALESCE(parent_cid, (
               SELECT mc.parent_cid FROM monitor_comment mc
               WHERE mc.aweme_id = outreach_item.source_video
                 AND mc.create_time = CAST(outreach_item.comment_at / 1000 AS INTEGER)
                 AND mc.parent_cid IS NOT NULL LIMIT 1
             )),
             source_cid = COALESCE(source_cid, (
               SELECT mc.cid FROM monitor_comment mc
               WHERE mc.aweme_id = outreach_item.source_video
                 AND mc.create_time = CAST(outreach_item.comment_at / 1000 AS INTEGER)
                 AND mc.parent_cid IS NOT NULL LIMIT 1
             ))
         WHERE comment_type <> 'reply'
           AND EXISTS (
             SELECT 1 FROM monitor_comment mc
             WHERE mc.aweme_id = outreach_item.source_video
               AND mc.create_time = CAST(outreach_item.comment_at / 1000 AS INTEGER)
               AND mc.parent_cid IS NOT NULL
           )`,
      ).run().changes;

      const root = db.prepare(
        `UPDATE outreach_item
         SET source_cid = (
           SELECT mc.cid FROM monitor_comment mc
           WHERE mc.aweme_id = outreach_item.source_video
             AND mc.create_time = CAST(outreach_item.comment_at / 1000 AS INTEGER)
             AND mc.parent_cid IS NULL LIMIT 1
         )
         WHERE source_cid IS NULL
           AND EXISTS (
             SELECT 1 FROM monitor_comment mc
             WHERE mc.aweme_id = outreach_item.source_video
               AND mc.create_time = CAST(outreach_item.comment_at / 1000 AS INTEGER)
               AND mc.parent_cid IS NULL
           )`,
      ).run().changes;

      if (manual || reply || root) {
        console.log(`[db] 线索类型回填：手动 ${manual}，楼中楼 ${reply}，根评论 cid ${root}`);
      }
    } catch (e) {
      console.warn('[db] 线索类型回填失败:', e.message);
    }
  }

  // 截流目标视频数：旧默认 60 -> 300（手机搜索单任务可覆盖多关键词）
  try {
    const row = db.prepare("SELECT value FROM setting WHERE key = 'harvest.config'").get();
    if (row) {
      const c = JSON.parse(row.value);
      if (c.maxVideosPerTask === 60) {
        c.maxVideosPerTask = 300;
        db.prepare("UPDATE setting SET value = ? WHERE key = 'harvest.config'").run(JSON.stringify(c));
        console.log('[db] 截流目标视频数已从 60 调整到 300');
      }
    }
  } catch {}

  // 采集到一半退出应用：标记失败，可重采
  try {
    const n = db
      .prepare(
        "UPDATE outreach_task SET stage = 'failed', harvest_error = '应用重启，采集已中断' " +
        "WHERE kind = 'intercept' AND stage = 'harvesting'",
      )
      .run().changes;
    if (n) console.log(`[db] 已把 ${n} 个中断的采集任务标记为 failed`);
  } catch (e) {}

  // 上次进程异常退出时，任务会永远停在 running；启动时改判为 paused
  try {
    const n = db
      .prepare("UPDATE outreach_task SET stage = 'paused' WHERE stage = 'running'")
      .run().changes;
    if (n) console.log(`[db] 已把 ${n} 个中断的任务标记为 paused`);
  } catch (e) {}
}


/**
 * 导入广告法词库（campfire-code/banned-words-checker，MIT）
 * 只补充合规改写字段，不覆盖已有词的动作/分组。
 */
function seedAdLexicon(db) {
  let data;
  try {
    data = require('../../../packages/risk/ad-lexicon.json');
  } catch (e) {
    console.warn('[db] 广告法词库未加载:', e.message);
    return;
  }
  if (!data?.words?.length) return;

  const groupMap = {
    极限用语: 'g-ad-extreme',
    国家名义: 'g-ad-authority',
    医疗功效: 'g-efficacy',
    绝对化承诺: 'g-ad-absolute',
    虚假宣传: 'g-ad-false',
    贬低同行: 'g-ad-derogate',
    迷信: 'g-superstition',
  };

  const find = db.prepare(
    'SELECT id, suggestion, rewrite_policy FROM sensitive_word WHERE word = ? LIMIT 1',
  );
  const update = db.prepare(
    `UPDATE sensitive_word
       SET suggestion = ?, rewrite_policy = ?, category = ?, basis = ?, severity = ?
     WHERE id = ?`,
  );
  const insert = db.prepare(
    `INSERT OR IGNORE INTO sensitive_word
       (id, group_id, word, match_type, action, replace_to, suggestion,
        rewrite_policy, category, basis, scope, enabled, severity, message)
     VALUES (?, ?, ?, 'contains', ?, ?, ?, ?, ?, ?, 'dm,comment,broadcast,intercept', 1, ?, ?)`,
  );

  data.words.forEach((w, index) => {
    const word = String(w?.w ?? '').trim();
    if (!word) return;
    const category = String(w.c || '广告法');
    const suggestion = w.r ? String(w.r) : null;
    const policy = suggestion ? 'replace' : 'remove';
    const basis = w.b ? (data.basis?.[w.b] || String(w.b)) : null;
    const severity = Math.min(3, Math.max(1, Number(w.l) || 2));
    const message = w.t || `${category}：${suggestion ? `建议改为「${suggestion}」` : '建议删除'}`;

    const existing = find.get(word);
    if (existing) {
      // 用户已经改过替代说法/改写策略，不再覆盖
      if (existing.suggestion || (existing.rewrite_policy && existing.rewrite_policy !== 'manual')) {
        return;
      }
      update.run(suggestion, policy, category, basis, severity, existing.id);
      return;
    }

    const action = category === '医疗功效' ? 'block' : (suggestion ? 'replace' : 'warn');
    insert.run(
      `ad-lex-${String(index + 1).padStart(3, '0')}`,
      groupMap[category] || 'g-ad-extreme',
      word,
      action,
      suggestion,
      suggestion,
      policy,
      category,
      basis,
      severity,
      message,
    );
  });
}

/** 给旧词补默认改写策略 */
function backfillRewritePolicies(db) {
  const groupPolicies = {
    'g-diversion-strong': 'block',
    'g-high-risk': 'block',
    'g-minor': 'block',
    'g-ad-extreme': 'remove',
    'g-ad-absolute': 'remove',
    'g-efficacy': 'remove',
    'g-diversion-weak': 'manual',
    'g-competitor': 'manual',
  };
  for (const [gid, policy] of Object.entries(groupPolicies)) {
    try {
      db.prepare(
        `UPDATE sensitive_word SET rewrite_policy = ?
         WHERE group_id = ? AND (rewrite_policy IS NULL OR rewrite_policy = '' OR rewrite_policy = 'manual')`,
      ).run(policy, gid);
    } catch {}
  }
}

/** 合规整句模板：只提供平台允许的表达，不做同音字/零宽等规避 */
function seedRewriteTemplates(db) {
  try {
    const marker = db.prepare("SELECT value FROM setting WHERE key = 'rewriteTemplatesSeeded'").get();
    if (marker?.value === '1') return;

    const rows = [
      ['tpl-auto-loan-1', '车贷', 'dm,comment,broadcast,intercept', '车贷利率额度',
        '利息,利率,额度,放款,车抵贷',
        '具体利率、额度以审核结果为准，详情可在平台内咨询。',
        '金融营销应避免承诺具体利率/额度', 20],
      ['tpl-auto-loan-2', '车贷', 'dm,comment,broadcast,intercept', '车贷资质',
        '征信,流水,负债,黑户',
        '能否办理需要结合实际情况评估，具体以审核结果为准。',
        '不得承诺必过/无视征信', 20],
      ['tpl-home-1', '家装', 'dm,comment,broadcast,intercept', '家装报价',
        '报价,装修,全包,半包,定金',
        '具体方案和报价需要根据房屋实际情况评估，可在平台内沟通。',
        '价格与服务内容应以实际评估为准', 15],
      ['tpl-ecom-1', '电商', 'dm,comment,broadcast,intercept', '价格活动',
        '最低价,全网最低,最便宜,史上最低',
        '价格和活动以店铺页面展示为准。',
        '广告法禁止使用绝对化价格表述', 15],
      ['tpl-ecom-2', '电商', 'dm,comment,broadcast,intercept', '收益承诺',
        '稳赚,保本,零风险,躺赚,暴利',
        '收益和风险请以实际产品说明为准。',
        '不得承诺收益或保本', 25],
      ['tpl-job-1', '招聘', 'dm,comment,broadcast,intercept', '薪资福利',
        '高薪,包吃住,月入,日结,轻松',
        '薪资福利以岗位说明和面试沟通为准。',
        '招聘信息应真实、具体', 15],
      ['tpl-local-1', '本地生活', 'dm,comment,broadcast,intercept', '免费活动',
        '免费,0元,白嫖,不要钱',
        '活动内容以门店公示为准。',
        '活动规则应清晰可查', 10],
      ['tpl-edu-1', '教培', 'dm,comment,broadcast,intercept', '效果承诺',
        '保过,包过,提分,速成,名师',
        '课程效果因个人情况而异，具体以课程说明为准。',
        '不得承诺培训效果', 20],
      ['tpl-med-1', '医疗', 'dm,comment,broadcast,intercept', '医疗功效',
        '治疗,治愈,疗效,根治,药到病除',
        '相关内容仅供参考，不构成医疗建议。',
        '非医疗场景不得宣称治疗功效', 25],
      ['tpl-common-1', '通用', 'dm,comment,broadcast,intercept', '站内沟通',
        '加微信,加V,加v,私信,联系方式,电话',
        '可在平台内私信沟通，具体信息以平台展示为准。',
        '优先使用平台内沟通方式', 30],
    ];

    const stmt = db.prepare(
      `INSERT OR IGNORE INTO rewrite_template
         (id, industry, scene, name, triggers, template_text, basis, priority, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    );
    const now = Date.now();
    for (const r of rows) stmt.run(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], now);
    db.prepare(
      "INSERT INTO setting (key, value) VALUES ('rewriteTemplatesSeeded', '1') " +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run();
    console.log(`[db] 已初始化 ${rows.length} 条合规整句模板`);
  } catch (e) {
    console.warn('[db] 初始化合规模板失败:', e.message);
  }
}

function seedDefaults(db) {
  // ── 敏感词：八个分组 + 60+ 词条 ──
  // 词条按《广告法》条文与抖音公开规则自行整理，不复制无许可项目的词表
  const GROUP_SEED = [
    ['g-diversion-strong', '导流-强（封号高危）', 0, '抖音明确禁止，发出去极易封号'],
    ['g-diversion-weak', '导流-弱（营销嫌疑）', 1, '引导站外的暗示性表达'],
    ['g-competitor', '竞品平台', 2, '提及其他电商或内容平台'],
    ['g-ad-extreme', '广告法-极限词', 3, '《广告法》第九条禁止的绝对化用语'],
    ['g-ad-absolute', '广告法-绝对化', 4, '绝对化承诺，易被认定虚假宣传'],
    ['g-efficacy', '功效违规', 5, '医疗/功效类过度承诺'],
    ['g-high-risk', '高风险活动', 6, '涉嫌诈骗、违规服务'],
    ['g-minor', '未成年保护', 7, '涉及未成年人的不当营销'],
    ['g-ad-authority', '广告法-权威背书', 8, '国家机关/专家/驰名商标等无据背书'],
    ['g-ad-false', '广告法-虚假宣传', 9, '虚假紧迫感、虚假承诺、误导性对比'],
    ['g-ad-derogate', '广告法-贬低同行', 10, '贬低其他生产经营者的商品或服务'],
    ['g-superstition', '迷信/风水', 11, '平台普遍禁宣的迷信、风水、转运内容'],
  ];

  const WORD_SEED = [
    // 导流-强（阻断）
    // 注意：不要加 "v:" "薇:" 这类「单字+冒号」的词
    // 因为归一化会删掉冒号，只剩单字，而单字词不支持匹配。
    // 这类结构由 PATTERN_RULES 的正则负责。
    ['g-diversion-strong', ['微信', '威信', '薇信', '危信', '薇心', 'v信', 'vx', '微x', '加我', '加微', '私聊加', '扣扣', 'qq号', 'qq', '二维码', '扫码加'], 'block', 3, '导流站外，封号高危'],
    ['g-diversion-strong', ['手机号', '电话号码', '联系方式'], 'block', 3, '留联系方式，封号高危'],
    // 导流-弱（警告）
    ['g-diversion-weak', ['私聊', '主页有', '看简介', '上车', '橱窗', '链接在', '点击下方'], 'warn', 2, '暗示引导站外'],
    // 竞品平台
    ['g-competitor', ['淘宝', '天猫', '京东', '拼多多', '快手', '小红书', '咸鱼', '闲鱼'], 'warn', 2, '提及竞品平台'],
    // 广告法-极限词
    ['g-ad-extreme', ['最好', '最佳', '最强', '最优', '第一', '首个', '首选', '独家', '顶级', '顶尖', '国家级', '世界级', '全球级', '绝无仅有', '史无前例', '独一无二', '万能', '冠军', '销量第一', '销量冠军', '抄底价'], 'warn', 2, '《广告法》禁止的极限词'],
    // 广告法-绝对化
    ['g-ad-absolute', ['100%', '百分百', '绝对', '永久', '完全', '彻底', '无效退款', '保证有效', '包过', '必赚', '稳赚'], 'warn', 2, '绝对化承诺，涉嫌虚假宣传'],
    // 功效违规（阻断）
    ['g-efficacy', ['治愈', '根治', '根除', '不反弹', '包治', '药到病除', '治疗'], 'block', 3, '医疗功效承诺，严重违规'],
    // 高风险活动（阻断）
    ['g-high-risk', ['刷单', '刷量', '代练', '套现', '高仿', '复刻', 'A货', '原单', '洗钱', '博彩'], 'block', 3, '涉嫌违法或违规服务'],
    // 未成年保护（阻断）
    ['g-minor', ['未成年', '早恋', '萝莉', '正太'], 'block', 3, '涉及未成年人的不当内容'],
  ];

  // ★ 清理无效词条：单字 + 冒号（归一化后失效，改由正则处理）
  try {
    db.prepare(
      `DELETE FROM sensitive_word
       WHERE length(word) <= 2 AND (word LIKE '%:%' OR word LIKE '%：%')`,
    ).run();
  } catch {}

  // ★ 清理旧版遗留的分组（v1 只有 3 个分组，已被 8 分组替代）
  const LEGACY_GROUPS = ['g-diversion', 'g-absolute'];
  for (const gid of LEGACY_GROUPS) {
    const exists = db.prepare('SELECT 1 FROM sensitive_group WHERE id = ?').get(gid);
    if (exists) {
      db.prepare('DELETE FROM sensitive_word WHERE group_id = ?').run(gid);
      db.prepare('DELETE FROM sensitive_group WHERE id = ?').run(gid);
      console.log(`[db] 清理旧分组 ${gid}`);
    }
  }

  const insertGroup = db.prepare(
    `INSERT OR IGNORE INTO sensitive_group (id, name, sort, description)
     VALUES (?, ?, ?, ?)`,
  );
  for (const [id, name, sort, desc] of GROUP_SEED) {
    insertGroup.run(id, name, sort, desc);
  }

  const insertWord = db.prepare(
    `INSERT OR IGNORE INTO sensitive_word
       (id, group_id, word, match_type, action, scope, severity, message)
     VALUES (?, ?, ?, 'contains', ?, 'dm,comment,broadcast,intercept', ?, ?)`,
  );
  for (const [gid, list, action, severity, msg] of WORD_SEED) {
    for (const w of list) {
      insertWord.run(`${gid}-${w}`, gid, w, action, severity, msg);
    }
  }

  seedAdLexicon(db);
  try {
    const done = db.prepare("SELECT value FROM setting WHERE key = 'sensitive.rewriteSeeded'").get();
    if (!done) {
      backfillRewritePolicies(db);
      db.prepare("INSERT OR IGNORE INTO setting (key, value) VALUES ('sensitive.rewriteSeeded', '1')").run();
    }
  } catch {}

  // ── 设置项 ──
  const insertSetting = db.prepare('INSERT OR IGNORE INTO setting (key, value) VALUES (?, ?)');
  insertSetting.run('maxConcurrent', '3');
  insertSetting.run('offlineHours', '12');
  insertSetting.run('dailyLimitBroadcast', '20');
  insertSetting.run('dailyLimitIntercept', '10');

  // 自动回复默认配置
  insertSetting.run('autoReplyEnabled', '0');
  insertSetting.run('replySpeedMs', '1500');
  insertSetting.run('replyJitterMs', '3000');
  insertSetting.run('quietHours', '0-7');
  insertSetting.run('cooldownSec', '300');
  insertSetting.run('maxAutoReplyPerConv', '3');
  insertSetting.run('defaultReply', '');
  insertSetting.run('transferKeywords', '人工,客服,投诉,退款');
}

export function db_() {
  if (!db) throw new Error('DB 未初始化');
  return db;
}

export function closeDb() {
  if (db) {
    try { db.close(); } catch {}
    db = null;
  }
}
