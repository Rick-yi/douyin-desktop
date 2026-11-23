/**
 * 线索采集服务
 *
 * ★ 技术前提（实测，见 docs/调研-截流流程.md）
 *   抖音的搜索/评论区接口，用已登录 SDK 会话的 cookie 就能直接调，
 *   不需要 a_bogus。关键是必须走 sdk.account.im.client.requestRaw，
 *   因为只有它带 cookie jar；用全局 fetch 会返回 2483 未登录。
 *
 * ★ 稳定性风险
 *   这是 SDK 未公开的内部对象，SDK 升级可能失效。
 *   所有失败都抛明确错误，调用方要能降级到手动导入 UID。
 */
import { db_ } from './db.js';
import {
  generateABogus, WIN_SCREEN_FINGERPRINT,
} from '../../../node_modules/douyin-im/lib/anti-bot/index.js';

// ── 采集参数（全部可配置，存在 setting 表）──
export const HARVEST_DEFAULTS = {
  /** 两次请求之间的随机间隔（毫秒） */
  requestGapMinMs: 2000,
  requestGapMaxMs: 4000,
  /** 单账号单日请求上限（搜索 + 翻页都算一次）；0 = 不限 */
  dailyRequestLimit: 0,
  /** 单条视频最多抓几页评论（每页 20 条）；0 = 不限，靠日请求上限收口 */
  maxPagesPerVideo: 1,
  /** 单任务目标视频数：手机搜索/视频列表最多取这么多条 */
  maxVideosPerTask: 300,
  /** 采集时先扫多少条视频的评论，其余交给持续监控 */
  initialScanVideos: 10,
  /** 单任务最多产出多少条线索；0 = 不限 */
  maxLeadsPerTask: 50,
  /** 只采集最近 N 天的评论；0 = 不限 */
  maxCommentAgeDays: 7,
};

const CFG_KEY = 'harvest.config';
const USAGE_KEY = 'harvest.usage';

export function getHarvestConfig() {
  try {
    const row = db_().prepare('SELECT value FROM setting WHERE key = ?').get(CFG_KEY);
    const saved = row ? JSON.parse(row.value) : {};
    return { ...HARVEST_DEFAULTS, ...saved };
  } catch {
    return { ...HARVEST_DEFAULTS };
  }
}

export function saveHarvestConfig(patch = {}) {
  const next = { ...getHarvestConfig() };
  const ints = [
    'requestGapMinMs', 'requestGapMaxMs', 'dailyRequestLimit',
    'maxPagesPerVideo', 'maxVideosPerTask', 'initialScanVideos', 'maxLeadsPerTask',
    'maxCommentAgeDays',
  ];
  for (const k of ints) {
    if (patch[k] === undefined) continue;
    const v = Number(patch[k]);
    if (!Number.isFinite(v) || v < 0) throw new Error(`${k} 必须是非负数字`);
    next[k] = Math.round(v);
  }
  // 基本约束，防止把间隔调成 0 把账号打穿
  next.requestGapMinMs = Math.max(100, next.requestGapMinMs);
  next.requestGapMaxMs = Math.max(next.requestGapMinMs, next.requestGapMaxMs);
  next.maxPagesPerVideo = Math.min(200, Math.max(0, next.maxPagesPerVideo));
  next.maxVideosPerTask = Math.min(5000, Math.max(1, next.maxVideosPerTask));
  next.initialScanVideos = Math.min(5000, Math.max(1, next.initialScanVideos));
  next.maxLeadsPerTask = Math.min(10000, Math.max(0, next.maxLeadsPerTask));
  next.maxCommentAgeDays = Math.min(365, Math.max(0, next.maxCommentAgeDays));
  next.dailyRequestLimit = Math.max(0, next.dailyRequestLimit);

  db_()
    .prepare('INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(CFG_KEY, JSON.stringify(next));
  return next;
}

// ══════════════════════════════════════
// 请求节流 + 日配额
// ══════════════════════════════════════

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function loadUsage() {
  try {
    const row = db_().prepare('SELECT value FROM setting WHERE key = ?').get(USAGE_KEY);
    const u = row ? JSON.parse(row.value) : null;
    if (!u || u.date !== todayKey()) return { date: todayKey(), byAccount: {} };
    return u;
  } catch {
    return { date: todayKey(), byAccount: {} };
  }
}

function saveUsage(u) {
  try {
    db_()
      .prepare('INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(USAGE_KEY, JSON.stringify(u));
  } catch {}
}

/** 清空今天的请求计数（手动重置用） */
export function resetHarvestUsage() {
  saveUsage({ date: todayKey(), byAccount: {} });
  return { ok: true, date: todayKey() };
}

/**
 * 采集节流：随机间隔 + 每日请求数上限
 *
 * ★ 为什么按「请求数」而不是「线索数」限：
 *   风控看到的是请求频率，不是最后入库多少条。
 */
export class HarvestThrottle {
  #lastAt = new Map();
  #config;
  #usage = null;
  #dirty = false;
  #flushTimer = null;

  constructor(config = getHarvestConfig()) {
    this.#config = config;
  }

  setConfig(cfg) {
    this.#config = { ...this.#config, ...cfg };
  }

  #ensureUsage() {
    const today = todayKey();
    if (!this.#usage || this.#usage.date !== today) {
      this.#usage = loadUsage();
      this.#dirty = false;
    }
    return this.#usage;
  }

  /** 把内存里的计数落盘；批量合并写入，避免每请求一次 fsync */
  flush() {
    if (!this.#dirty || !this.#usage) return;
    saveUsage(this.#usage);
    this.#dirty = false;
  }

  #scheduleFlush() {
    if (this.#flushTimer) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.flush();
    }, 2000);
    // 不因为定时器阻止进程/测试退出
    this.#flushTimer.unref?.();
  }

  usage(accountId) {
    const u = this.#ensureUsage();
    return {
      date: u.date,
      used: u.byAccount[accountId] ?? 0,
      limit: this.#config.dailyRequestLimit,
    };
  }

  check(accountId) {
    const { used, limit } = this.usage(accountId);
    // limit = 0 表示不限
    if (limit > 0 && used >= limit) {
      return { allowed: false, reason: 'daily_request_limit', used, limit };
    }
    return { allowed: true, used, limit };
  }

  /**
   * 等够随机间隔（第一个请求不用等）
   * override 允许监控任务使用自己的“扫描速度”，不影响搜索/初始采集。
   */
  async waitTurn(accountId, override = {}) {
    const last = this.#lastAt.get(accountId) ?? 0;
    if (!last) return 0;
    const min = Math.max(300, Number(override.minMs ?? this.#config.requestGapMinMs));
    const max = Math.max(min, Number(override.maxMs ?? this.#config.requestGapMaxMs));
    const gap = min + Math.random() * Math.max(0, max - min);
    const wait = Math.max(0, gap - (Date.now() - last));
    if (wait > 0) await sleep(wait);
    return wait;
  }

  record(accountId) {
    this.#lastAt.set(accountId, Date.now());
    const u = this.#ensureUsage();
    u.byAccount[accountId] = (u.byAccount[accountId] ?? 0) + 1;
    this.#dirty = true;
    this.#scheduleFlush();
  }

  /** 测试/手动重置 */
  resetUsage() {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    this.#usage = { date: todayKey(), byAccount: {} };
    this.#dirty = false;
    saveUsage(this.#usage);
  }
}

/**
 * 账号级请求闸门
 *
 * 多个监控任务共用同一个账号时：
 *   - 最多 N 个评论请求同时在途（默认 4，最高 20）
 *   - 每次请求的“开始时间”仍按随机间隔排队，避免并发形成突发
 *   - 所有请求共用每日额度
 *
 * 调用方必须在 finally 里 release()。
 */
const accountGates = new Map();

export function getAccountRequestGate(accountId, maxConcurrency = 10) {
  const key = String(accountId || '');
  let gate = accountGates.get(key);
  if (!gate) {
    gate = new AccountRequestGate(key, maxConcurrency);
    accountGates.set(key, gate);
  }
  gate.setMax(maxConcurrency);
  return gate;
}

export class AccountRequestGate {
  #accountId;
  #max;
  #inFlight = 0;
  #nextAt = 0;
  #waiters = [];
  #cooldownUntil = 0;

  constructor(accountId, maxConcurrency = 4) {
    this.#accountId = String(accountId || '');
    this.#max = Math.max(1, Math.min(20, Math.round(Number(maxConcurrency) || 4)));
  }

  setMax(n) {
    this.#max = Math.max(1, Math.min(20, Math.round(Number(n) || 1)));
    while (this.#waiters.length && this.#inFlight < this.#max) {
      this.#inFlight++;
      this.#waiters.shift()();
    }
  }

  get stats() {
    return {
      inFlight: this.#inFlight,
      max: this.#max,
      waiting: this.#waiters.length,
      cooldownUntil: this.#cooldownUntil,
    };
  }

  /**
   * 请求异常后调用：识别 429/风控/频繁/验证，自动降并发并冷却账号。
   * 宁可慢一轮，也不要继续硬打。
   */
  noteError(e) {
    const text = `${e?.statusCode ?? ''} ${e?.code ?? ''} ${e?.message ?? ''}`;
    if (!/429|risk|风控|频繁|rate.?limit|too many|访问过于频繁|安全验证|滑块/i.test(text)) {
      return false;
    }
    this.#max = Math.max(1, Math.floor(this.#max / 2));
    this.#cooldownUntil = Math.max(this.#cooldownUntil, Date.now() + 5 * 60000);
    console.warn(`[gate] 账号 ${this.#accountId} 疑似触发风控，降至 ${this.#max} 路并冷却 5 分钟`);
    return true;
  }

  async #acquireSlot() {
    if (Date.now() < this.#cooldownUntil) {
      const e = new Error('账号处于风控冷却中，本轮暂停采集');
      e.code = 'risk_cooldown';
      throw e;
    }
    if (this.#inFlight < this.#max) {
      this.#inFlight++;
      return;
    }
    await new Promise((resolve) => this.#waiters.push(resolve));
  }

  async acquire({ minMs = 1500, maxMs = 3000, throttle = null } = {}) {
    await this.#acquireSlot();
    try {
      if (throttle) {
        const q = throttle.check(this.#accountId);
        if (!q.allowed) {
          const e = new Error(`今日采集请求已达上限（${q.limit} 次）`);
          e.code = 'quota';
          throw e;
        }
      }

      const now = Date.now();
      const start = Math.max(now, this.#nextAt || now);
      const min = Math.max(100, Number(minMs) || 1500);
      const max = Math.max(min, Number(maxMs) || min);
      const gap = min + Math.random() * Math.max(0, max - min);
      this.#nextAt = start + gap;

      const wait = start - now;
      if (wait > 0) await sleep(wait);
      if (throttle) throttle.record(this.#accountId);
    } catch (e) {
      this.release();
      throw e;
    }
  }

  release() {
    if (this.#inFlight > 0) this.#inFlight--;
    if (this.#inFlight < this.#max && this.#waiters.length) {
      this.#inFlight++;
      this.#waiters.shift()();
    }
  }
}

// ══════════════════════════════════════
// 输入解析
// ══════════════════════════════════════

/**
 * 解析视频输入：一行一个，支持
 *   https://www.douyin.com/video/7300000000000000000
 *   7300000000000000000
 *
 * ★ 不支持 v.douyin.com 短链：需要跟随跳转，成本高且容易失败，
 *   UI 上直接提示用完整链接。
 */
export function parseVideoInput(raw) {
  const videos = [];
  const seen = new Set();
  const invalid = [];

  for (const line of String(raw ?? '').split(/[\r\n]+/)) {
    const t = line.trim();
    if (!t) continue;

    const m =
      t.match(/\/video\/(\d{15,25})/) ??
      t.match(/^(\d{15,25})$/);
    if (!m) {
      invalid.push(t.slice(0, 60));
      continue;
    }
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    videos.push({ id });
  }

  return { videos, invalid };
}

export const MAX_KEYWORDS = 20;

/**
 * 解析关键词输入：一行一个，也接受中英文逗号/分号分隔
 *
 * ★ 单个关键词里允许有空格（比如「装修 报价」），所以只按换行和分隔符切
 */
export function parseKeywordInput(raw) {
  const keywords = [];
  const seen = new Set();
  const invalid = [];

  for (const part of String(raw ?? '').split(/[\r\n,，;；]+/)) {
    const k = part.trim();
    if (!k) continue;
    if (k.length > 40) { invalid.push(k.slice(0, 20) + '…'); continue; }
    if (seen.has(k)) continue;
    seen.add(k);
    keywords.push(k);
  }

  if (!keywords.length) throw new Error('关键词不能为空');
  if (keywords.length > MAX_KEYWORDS) {
    throw new Error(`最多 ${MAX_KEYWORDS} 个关键词，当前 ${keywords.length} 个`);
  }
  return { keywords, invalid };
}

// ══════════════════════════════════════
// 抖音 web 接口（走 SDK 内部请求通道）
// ══════════════════════════════════════

export class HarvestError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * 包一层 SDK 内部的 requestRaw
 * @param {object} sdk ImSdk 实例（需要已上线）
 */
export function createWebClient(sdk) {
  const acc = sdk?.account;
  const client = acc?.im?.client;
  if (!client || typeof client.requestRaw !== 'function') {
    throw new HarvestError(
      'sdk_internal_unavailable',
      '当前 SDK 版本不支持采集（内部请求通道不可用）。请改用手动导入 UID。',
    );
  }

  const ua = client.getUserAgent?.() ?? 'Mozilla/5.0';
  const deviceId = client.getDeviceId?.() ?? '0';
  const guid = client.getGuid?.() ?? '0';
  const screen = client.getScreenSize?.() ?? { width: 1728, height: 1117 };

  function params() {
    return new URLSearchParams({
      aid: '339757',
      version_name: '1.2.1',
      version_code: '1.2.1',
      device_platform: process.platform,
      os_version: '10.0.19045',
      screen_width: String(screen.width),
      screen_height: String(screen.height),
      browser_language: 'zh-CN',
      browser_platform: process.platform === 'win32' ? 'Win32' : 'MacIntel',
      browser_name: 'Mozilla',
      browser_version: ua.replace(/^Mozilla\//, ''),
      browser_online: 'true',
      cookie_enabled: 'true',
      device_id: deviceId,
      did: deviceId,
      iid: '0',
      awemeim_guid: guid,
      channel: '0',
    });
  }

  async function getJson(pathname, extra = {}, { signed = false } = {}) {
    const p = params();
    for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
    if (signed) {
      // 楼中楼接口比一级评论严格，需要 msToken + a_bogus
      const msToken = client.getMsToken?.();
      if (msToken) p.set('msToken', msToken);
      try {
        const query = p.toString();
        p.set('a_bogus', generateABogus({
          userAgent: ua,
          query,
          screenFingerprint: WIN_SCREEN_FINGERPRINT,
        }));
      } catch (e) {
        console.warn('[harvest] a_bogus 生成失败:', e.message);
      }
    }
    const url = `https://www.douyin.com${pathname}?${p}`;

    let res;
    try {
      res = await client.requestRaw(
        url,
        {
          method: 'GET',
          headers: { 'User-Agent': ua, Referer: 'https://www.douyin.com/' },
          signal: AbortSignal.timeout(15000),
        },
        false,
      );
    } catch (e) {
      throw new HarvestError('network', `请求失败：${e.cause?.code || e.message}`);
    }

    const text = typeof res.data === 'string' ? res.data : '';
    if (!text) {
      throw new HarvestError(
        'empty_response',
        '接口返回空内容，可能是频率过高或登录态失效。已停止采集以保护账号。',
      );
    }
    if (text === 'blocked') {
      throw new HarvestError('blocked', '接口返回 blocked，账号可能被临时限制，请停止采集。');
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new HarvestError('bad_response', `接口返回了非 JSON 内容（HTTP ${res.status}）`);
    }

    if (json.status_code === 2483) {
      throw new HarvestError('login_lost', '登录态失效（2483）。请重新登录该账号。');
    }
    if (json.status_code !== undefined && json.status_code !== 0) {
      throw new HarvestError(
        'api_error',
        `接口错误：${json.status_code} ${json.status_msg ?? ''}`.trim(),
      );
    }
    return json;
  }

  /**
   * 关键词搜视频
   * @returns {{videos: Array, hasMore: boolean, nextOffset: number}}
   */
  async function searchVideos(keyword, { offset = 0, count = 10 } = {}) {
    const json = await getJson('/aweme/v1/web/general/search/single/', {
      keyword,
      search_channel: 'aweme_video_web',
      search_source: 'normal_search',
      query_correct_type: '1',
      is_filter_search: '0',
      offset,
      count,
    });

    const videos = [];
    for (const item of json.data ?? []) {
      const a = item?.aweme_info;
      if (!a?.aweme_id) continue;
      videos.push(normalizeVideo(a));
    }
    return {
      videos,
      hasMore: !!json.has_more,
      nextOffset: offset + count,
    };
  }

  /**
   * 抓评论（一级）
   * @returns {{comments: Array, hasMore: boolean, nextCursor: number, total: number}}
   */
  async function fetchComments(awemeId, { cursor = 0, count = 20 } = {}) {
    const json = await getJson('/aweme/v1/web/comment/list/', {
      aweme_id: awemeId,
      cursor,
      count,
      item_type: '0',
    });
    return {
      comments: (json.comments ?? []).map(normalizeComment).filter(Boolean),
      hasMore: !!json.has_more,
      nextCursor: json.cursor ?? cursor + count,
      total: json.total ?? 0,
    };
  }

  /**
   * 抓根评论下的回复（楼中楼）
   * @returns {{comments: Array, hasMore: boolean, nextCursor: number, total: number}}
   */
  async function fetchCommentReplies(awemeId, commentId, { cursor = 0, count = 20 } = {}) {
    let json;
    try {
      json = await getJson('/aweme/v1/web/comment/list/reply/', {
        // 不同端参数名不一致，两个都带上，服务端会忽略多余参数
        item_id: awemeId,
        aweme_id: awemeId,
        comment_id: commentId,
        cursor,
        count,
        item_type: '0',
      }, { signed: true });
    } catch (e) {
      // 部分根评论的回复不可见/已折叠时，接口会返回空 body；
      // 这不是账号异常，按“没有可见回复”处理，避免每轮重试。
      if (e.code === 'empty_response') {
        return { comments: [], hasMore: false, nextCursor: cursor, total: 0, empty: true };
      }
      throw e;
    }
    return {
      comments: (json.comments ?? []).map(normalizeComment).filter(Boolean),
      hasMore: !!json.has_more,
      nextCursor: json.cursor ?? cursor + count,
      total: json.total ?? 0,
    };
  }

  return { searchVideos, fetchComments, fetchCommentReplies, _raw: getJson };
}

function normalizeComment(c) {
  const u = c?.user;
  if (!u?.uid) return null;
  return {
    cid: String(c.cid ?? ''),
    text: String(c.text ?? '').trim(),
    createTime: c.create_time ?? null,
    diggCount: c.digg_count ?? 0,
    replyTotal: c.reply_comment_total ?? 0,
    isHot: !!c.is_hot,
    uid: String(u.uid),
    secUid: u.sec_uid ?? null,
    nickname: u.nickname ?? '',
    uniqueId: u.unique_id ?? '',
    signature: u.signature ?? '',
    enterpriseVerify: u.enterprise_verify_reason ?? '',
  };
}

function normalizeVideo(a) {
  const stats = a.statistics ?? {};
  return {
    awemeId: String(a.aweme_id),
    desc: String(a.desc ?? '').slice(0, 120),
    authorUid: a.author?.uid ? String(a.author.uid) : null,
    authorName: a.author?.nickname ?? '',
    createTime: a.create_time ?? null,
    diggCount: stats.digg_count ?? 0,
    commentCount: stats.comment_count ?? 0,
    shareCount: stats.share_count ?? 0,
    shareUrl: `https://www.douyin.com/video/${a.aweme_id}`,
  };
}
