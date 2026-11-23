/**
 * 熔断器
 *
 * 三类触发：
 *  1. 风控关键词命中（发送返回里出现"频繁"、"验证"、"限制"等）
 *  2. 连续失败次数超阈值
 *  3. 失败率超阈值
 *
 * 触发后：该账号冷却 N 分钟（默认 30），期间不发送。
 *
 * ★ 记账口径（学 fusion 的教训）：
 *   熔断 ≠ 已发送。熔断期间跳过的目标记 skipped，不记 ok，
 *   否则会出现"面板显示今天已发、实际一条没到"。
 *
 * ★ 持久化：熔断状态/连续失败/最近结果写 sender_state，重启后不丢。
 */

const RISK_PATTERNS = [
  /操作频繁/,
  /发送频繁/,
  /请勿频繁/,
  /安全验证/,
  /滑动验证/,
  /验证码/,
  /人机验证/,
  /网络异常/,
  /账号异常/,
  /登录失效/,
  /被限制/,
  /频率/,
  /spam/i,
  /rate.?limit/i,
];

/**
 * 平台规则类限制：针对的是「这个收件人」，不是账号健康
 * 命中时应该跳过该目标，而不是熔断账号
 */
const PEER_LIMIT_PATTERNS = [
  /消息已达上限/,
  /对方回复或互关/,
  /对方回复后才能/,
  /需对方回复/,
];

/**
 * 对方私信权限类限制：也是目标级，永久性/准永久性
 * 命中后不能重试该目标，更不能熔断账号
 */
const PEER_BLOCK_PATTERNS = [
  /仅和他互关/,
  /陌生人不可私信/,
  /私信功能暂被关闭/,
  /暂不支持发送私信/,
];
const PEER_BLOCK_CODES = new Set([7173, 7278, 10801]);

/**
 * 账号级频率限制：不是这个目标的问题，也不该把账号熔断 30 分钟；
 * 正确做法是暂停该账号一小段时间，目标保持 approved 稍后重试。
 */
const RATE_LIMIT_CODES = new Set([7180]);
const RATE_LIMIT_PATTERNS = [
  /给陌生人发送消息过于频繁/,
  /稍后再发送陌生人消息/,
  /发送消息过于频繁/,
];

/**
 * 账号级封禁（不是这个目标的问题）：
 * 目标保留 approved，不因为一次账号限制被消费掉。
 */
const ACCOUNT_RESTRICT_CODES = new Set([7177]);
const ACCOUNT_RESTRICT_PATTERNS = [
  /你的私信功能暂被封禁/,
  /你的私信功能已被封禁/,
];

const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

function tableExists(db, name) {
  try {
    return !!db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(name);
  } catch {
    return false;
  }
}

export class Breaker {
  /** accountId -> { until, reason, trippedAt } */
  #state = new Map();
  #consecutiveFail = new Map();
  #recent;
  #db;
  #loaded = new Set();
  #hasState = false;
  #cfg;

  constructor(config = {}, db = null) {
    this.#cfg = {
      cooldownMs: DEFAULT_COOLDOWN_MS,
      maxConsecutiveFail: 3,
      maxFailRate: 0.5,       // 50% 失败率
      failRateWindow: 20,     // 最近 20 条
      ...config,
    };
    this.#db = db;
    this.#hasState = !!db && tableExists(db, 'sender_state');
    this.#recent = new Map(); // accountId -> bool[]
  }

  #ensureLoaded(accountId) {
    if (!this.#hasState || this.#loaded.has(accountId)) return;
    this.#loaded.add(accountId);
    try {
      const row = this.#db
        .prepare(
          `SELECT breaker_until, breaker_reason, breaker_tripped_at,
                  consecutive_fail, recent
           FROM sender_state WHERE account_id = ?`,
        )
        .get(accountId);
      if (!row) return;
      if (row.breaker_until && Number(row.breaker_until) > Date.now()) {
        this.#state.set(accountId, {
          until: Number(row.breaker_until),
          reason: row.breaker_reason || '历史熔断',
          trippedAt: Number(row.breaker_tripped_at) || Date.now(),
        });
      }
      if (row.consecutive_fail) {
        this.#consecutiveFail.set(accountId, Number(row.consecutive_fail) || 0);
      }
      if (row.recent) {
        try {
          const arr = JSON.parse(row.recent);
          if (Array.isArray(arr)) {
            this.#recent.set(accountId, arr.slice(-this.#cfg.failRateWindow).map(Boolean));
          }
        } catch {}
      }
    } catch (e) {
      console.warn('[breaker] 恢复熔断状态失败', e.message);
    }
  }

  #persist(accountId) {
    if (!this.#hasState) return;
    const s = this.#state.get(accountId);
    const until = s ? s.until : null;
    const reason = s ? s.reason : null;
    const trippedAt = s ? s.trippedAt : null;
    const consecutive = this.#consecutiveFail.get(accountId) ?? 0;
    const recent = JSON.stringify(this.#recent.get(accountId) ?? []);
    try {
      this.#db
        .prepare(
          `INSERT INTO sender_state
             (account_id, breaker_until, breaker_reason, breaker_tripped_at,
              consecutive_fail, recent, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(account_id) DO UPDATE SET
             breaker_until = excluded.breaker_until,
             breaker_reason = excluded.breaker_reason,
             breaker_tripped_at = excluded.breaker_tripped_at,
             consecutive_fail = excluded.consecutive_fail,
             recent = excluded.recent,
             updated_at = excluded.updated_at`,
        )
        .run(accountId, until, reason, trippedAt, consecutive, recent, Date.now());
    } catch (e) {
      console.warn('[breaker] 保存熔断状态失败', e.message);
    }
  }

  /** 是否处于冷却中 */
  isTripped(accountId) {
    this.#ensureLoaded(accountId);
    const s = this.#state.get(accountId);
    if (!s) return null;
    if (Date.now() >= s.until) {
      // 冷却结束，清除
      this.#state.delete(accountId);
      this.#consecutiveFail.delete(accountId);
      this.#recent.delete(accountId);
      this.#persist(accountId);
      return null;
    }
    return {
      reason: s.reason,
      remainingMs: s.until - Date.now(),
      remainingMin: Math.ceil((s.until - Date.now()) / 60000),
    };
  }

  /** 检查响应里是否有风控关键词 */
  checkResponse(accountId, { statusCode, statusMsg, checkCode }) {
    const text = String(statusMsg ?? '');

    // 账号级频率限制：目标保留，账号短暂冷却后重试
    if (RATE_LIMIT_CODES.has(Number(checkCode)) || RATE_LIMIT_PATTERNS.some((re) => re.test(text))) {
      return { tripped: false, rateLimited: true, reason: text.slice(0, 60) || '陌生人私信频率限制' };
    }

    // 账号私信功能被封禁：目标保留，不要消费线索
    if (ACCOUNT_RESTRICT_CODES.has(Number(checkCode)) || ACCOUNT_RESTRICT_PATTERNS.some((re) => re.test(text))) {
      return { tripped: false, restricted: true, reason: text.slice(0, 60) || '私信功能暂被封禁' };
    }

    // ★ 平台规则类错误（不是风控，不该熔断账号）
    // 实测：status=3 check=7467 "给对方发送的消息已达上限，对方回复或互关后才能继续发送消息"
    // 这表示「这个人」不能再发了，与账号健康无关，应跳过该目标
    if (PEER_LIMIT_PATTERNS.some((re) => re.test(text)) || checkCode === 7467) {
      return { tripped: false, peerLimited: true, reason: text.slice(0, 60) };
    }
    if (PEER_BLOCK_PATTERNS.some((re) => re.test(text)) || PEER_BLOCK_CODES.has(Number(checkCode))) {
      return { tripped: false, peerBlocked: true, reason: text.slice(0, 60) };
    }

    for (const re of RISK_PATTERNS) {
      if (re.test(text)) {
        this.trip(accountId, `风控关键词: ${text.slice(0, 40)}`);
        return { tripped: true, reason: `命中「${text.slice(0, 30)}」` };
      }
    }
    // checkCode 非零且非普通值，仅记录
    if (checkCode !== null && checkCode !== undefined && checkCode !== 0) {
      console.warn(`[breaker] account=${accountId} 非零 checkCode=${checkCode}`);
    }
    return { tripped: false };
  }

  /** 记录一次发送结果，返回是否应熔断 */
  record(accountId, ok) {
    this.#ensureLoaded(accountId);
    if (ok) {
      this.#consecutiveFail.set(accountId, 0);
    } else {
      const n = (this.#consecutiveFail.get(accountId) ?? 0) + 1;
      this.#consecutiveFail.set(accountId, n);
      if (n >= this.#cfg.maxConsecutiveFail) {
        this.trip(accountId, `连续失败 ${n} 次`);
        return { tripped: true, reason: `连续失败 ${n} 次` };
      }
    }

    // 失败率
    const arr = this.#recent.get(accountId) ?? [];
    arr.push(!!ok);
    while (arr.length > this.#cfg.failRateWindow) arr.shift();
    this.#recent.set(accountId, arr);

    if (arr.length >= 10) {
      const fails = arr.filter((x) => !x).length;
      const rate = fails / arr.length;
      if (rate >= this.#cfg.maxFailRate) {
        this.trip(accountId, `失败率 ${Math.round(rate * 100)}%（${fails}/${arr.length}）`);
        return { tripped: true, reason: `失败率过高 ${Math.round(rate * 100)}%` };
      }
    }

    this.#persist(accountId);
    return { tripped: false };
  }

  trip(accountId, reason, cooldownMs) {
    const ms = cooldownMs ?? this.#cfg.cooldownMs;
    this.#state.set(accountId, {
      until: Date.now() + ms,
      reason,
      trippedAt: Date.now(),
    });
    this.#persist(accountId);
    console.warn(`[breaker] 账号 ${accountId} 熔断 ${ms / 60000} 分钟：${reason}`);
    return { until: Date.now() + ms, reason };
  }

  /** 手动解除 */
  reset(accountId) {
    this.#state.delete(accountId);
    this.#consecutiveFail.delete(accountId);
    this.#recent.delete(accountId);
    this.#persist(accountId);
  }

  /** 清空全部熔断状态（测试/手动重置用） */
  resetAll() {
    this.#state.clear();
    this.#consecutiveFail.clear();
    this.#recent.clear();
    this.#loaded.clear();
    if (!this.#hasState) return;
    try {
      this.#db
        .prepare(
          `UPDATE sender_state SET
             breaker_until = NULL, breaker_reason = NULL, breaker_tripped_at = NULL,
             consecutive_fail = 0, recent = '[]', updated_at = ?
           WHERE 1 = 1`,
        )
        .run(Date.now());
    } catch (e) {
      console.warn('[breaker] 重置熔断状态失败', e.message);
    }
  }

  /** 所有熔断中的账号 */
  listTripped() {
    if (this.#hasState) {
      try {
        const now = Date.now();
        const rows = this.#db
          .prepare(
            `SELECT account_id, breaker_until, breaker_reason, breaker_tripped_at
             FROM sender_state WHERE breaker_until > ?`,
          )
          .all(now);
        for (const row of rows) {
          this.#state.set(row.account_id, {
            until: Number(row.breaker_until),
            reason: row.breaker_reason || '熔断中',
            trippedAt: Number(row.breaker_tripped_at) || now,
          });
        }
      } catch {}
    }
    const out = [];
    for (const [accountId, s] of this.#state) {
      if (Date.now() < s.until) {
        out.push({
          accountId,
          reason: s.reason,
          remainingMin: Math.ceil((s.until - Date.now()) / 60000),
        });
      }
    }
    return out;
  }
}
