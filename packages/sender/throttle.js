/**
 * 节流器
 *
 * 三个维度：
 *  1. 单条间隔：同一账号两次发送之间的随机间隔
 *  2. 每小时配额
 *  3. 每日配额
 *
 * ★ 配额持久化：计数写 sender_state，应用重启后不会清零。
 * ★ 任务级配置：check/wait/usage 支持传入当前任务的 throttle，避免多个任务
 *   共用一份全局配置互相覆盖。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tableExists(db, name) {
  try {
    return !!db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(name);
  } catch {
    return false;
  }
}

export class Throttle {
  #db;
  #lastSendAt = new Map();      // accountId -> timestamp
  #hourlyCounter = new Map();   // `${accountId}:${hourKey}` -> count
  #dailyCounter = new Map();    // `${accountId}:${dayKey}` -> count
  #loaded = new Set();
  #hasState = false;
  #cfg;

  constructor(db, config = {}) {
    this.#db = db;
    this.#hasState = !!db && tableExists(db, 'sender_state');
    this.#cfg = {
      gapMinSec: 8,
      gapMaxSec: 30,
      hourlyLimit: 5,
      dailyLimit: 20,
      ...config,
    };
  }

  setConfig(patch) {
    Object.assign(this.#cfg, patch);
  }

  getConfig() {
    return { ...this.#cfg };
  }

  #cfgFor(override) {
    return override ? { ...this.#cfg, ...override } : this.#cfg;
  }

  /** 从 DB 恢复该账号的配额（每天/每小时自动按 key 归零） */
  #ensureLoaded(accountId) {
    if (!this.#hasState || this.#loaded.has(accountId)) return;
    this.#loaded.add(accountId);
    try {
      const row = this.#db
        .prepare('SELECT hour_key, hourly, day_key, daily, last_send_at FROM sender_state WHERE account_id = ?')
        .get(accountId);
      if (!row) return;
      const hourKey = this.#hourKey();
      const dayKey = this.#dayKey();
      if (row.hour_key === hourKey) {
        this.#hourlyCounter.set(`${accountId}:${hourKey}`, Number(row.hourly) || 0);
      }
      if (row.day_key === dayKey) {
        this.#dailyCounter.set(`${accountId}:${dayKey}`, Number(row.daily) || 0);
      }
      if (row.last_send_at) this.#lastSendAt.set(accountId, Number(row.last_send_at));
    } catch (e) {
      console.warn('[throttle] 恢复配额失败', e.message);
    }
  }

  #persist(accountId) {
    if (!this.#hasState) return;
    const hourKey = this.#hourKey();
    const dayKey = this.#dayKey();
    const hourly = this.#hourlyCounter.get(`${accountId}:${hourKey}`) ?? 0;
    const daily = this.#dailyCounter.get(`${accountId}:${dayKey}`) ?? 0;
    const last = this.#lastSendAt.get(accountId) ?? null;
    try {
      this.#db
        .prepare(
          `INSERT INTO sender_state
             (account_id, hour_key, hourly, day_key, daily, last_send_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(account_id) DO UPDATE SET
             hour_key = excluded.hour_key,
             hourly = excluded.hourly,
             day_key = excluded.day_key,
             daily = excluded.daily,
             last_send_at = excluded.last_send_at,
             updated_at = excluded.updated_at`,
        )
        .run(accountId, hourKey, hourly, dayKey, daily, last, Date.now());
    } catch (e) {
      console.warn('[throttle] 保存配额失败', e.message);
    }
  }

  /** 距上次发送需要等多久（毫秒），已满足返回 0 */
  waitTime(accountId, override) {
    this.#ensureLoaded(accountId);
    const last = this.#lastSendAt.get(accountId) ?? 0;
    const elapsed = Date.now() - last;
    const need = this.#randomGap(this.#cfgFor(override)) * 1000;
    return Math.max(0, need - elapsed);
  }

  #randomGap(cfg = this.#cfg) {
    const { gapMinSec, gapMaxSec } = cfg;
    return gapMinSec + Math.random() * Math.max(0, gapMaxSec - gapMinSec);
  }

  /**
   * 账号类型硬上限：个人号 60/天，蓝V 150/天。
   * 这是业务上限，不受任务配置或 neverStop 影响。
   */
  hardDailyLimit(accountId) {
    try {
      const row = this.#db
        ?.prepare('SELECT is_verified FROM account WHERE id = ?')
        .get(String(accountId || ''));
      if (!row) return Infinity; // 非真实账号（测试/临时 key）不套业务上限
      return row.is_verified ? 150 : 60;
    } catch {
      return Infinity;
    }
  }

  /** 检查配额，返回 { allowed, reason } */
  checkQuota(accountId, override) {
    this.#ensureLoaded(accountId);
    const cfg = this.#cfgFor(override);
    const hourKey = `${accountId}:${this.#hourKey()}`;
    const dayKey = `${accountId}:${this.#dayKey()}`;

    const hourly = this.#hourlyCounter.get(hourKey) ?? 0;
    if (hourly >= cfg.hourlyLimit) {
      return { allowed: false, reason: 'hourly_limit', used: hourly, limit: cfg.hourlyLimit };
    }

    const hardDaily = this.hardDailyLimit(accountId);
    const dailyLimit = Math.min(cfg.dailyLimit, hardDaily);
    const daily = this.#dailyCounter.get(dayKey) ?? 0;
    if (daily >= dailyLimit) {
      return { allowed: false, reason: 'daily_limit', used: daily, limit: dailyLimit };
    }

    return { allowed: true, hourly, daily, dailyLimit };
  }

  /** 等够间隔（返回实际等待毫秒） */
  async waitTurn(accountId, override) {
    const ms = this.waitTime(accountId, override);
    if (ms > 0) {
      // 分片等待，便于中途取消
      const step = 500;
      let left = ms;
      while (left > 0) {
        await sleep(Math.min(step, left));
        left -= step;
      }
    }
    return ms;
  }

  /** 记录一次成功发送（同步写 DB，重启不丢） */
  record(accountId) {
    this.#ensureLoaded(accountId);
    this.#lastSendAt.set(accountId, Date.now());
    const hourKey = `${accountId}:${this.#hourKey()}`;
    const dayKey = `${accountId}:${this.#dayKey()}`;
    this.#hourlyCounter.set(hourKey, (this.#hourlyCounter.get(hourKey) ?? 0) + 1);
    this.#dailyCounter.set(dayKey, (this.#dailyCounter.get(dayKey) ?? 0) + 1);
    this.#persist(accountId);
  }

  /**
   * 只更新「上次尝试时间」，不动配额计数。
   * 用于失败/跳过：避免连续失败时零间隔打满，也避免把失败算进成功配额。
   */
  recordAttempt(accountId) {
    this.#ensureLoaded(accountId);
    this.#lastSendAt.set(accountId, Date.now());
    this.#persist(accountId);
  }

  /** 当前用量（给 UI 显示） */
  usage(accountId, override) {
    this.#ensureLoaded(accountId);
    const cfg = this.#cfgFor(override);
    const hourKey = `${accountId}:${this.#hourKey()}`;
    const dayKey = `${accountId}:${this.#dayKey()}`;
    return {
      hourly: this.#hourlyCounter.get(hourKey) ?? 0,
      hourlyLimit: cfg.hourlyLimit,
      daily: this.#dailyCounter.get(dayKey) ?? 0,
      dailyLimit: Math.min(cfg.dailyLimit, this.hardDailyLimit(accountId)),
    };
  }

  /** 清空所有计数（测试/手动重置用） */
  resetAll() {
    this.#lastSendAt.clear();
    this.#hourlyCounter.clear();
    this.#dailyCounter.clear();
    this.#loaded.clear();
    if (!this.#hasState) return;
    try {
      this.#db
        .prepare(
          `UPDATE sender_state SET
             hour_key = NULL, hourly = 0, day_key = NULL, daily = 0,
             last_send_at = NULL, updated_at = ?
           WHERE 1 = 1`,
        )
        .run(Date.now());
    } catch (e) {
      console.warn('[throttle] 重置配额失败', e.message);
    }
  }

  #hourKey() {
    const d = new Date();
    return `${d.getFullYear()}${d.getMonth() + 1}${d.getDate()}${d.getHours()}`;
  }

  #dayKey() {
    const d = new Date();
    return `${d.getFullYear()}${d.getMonth() + 1}${d.getDate()}`;
  }
}
