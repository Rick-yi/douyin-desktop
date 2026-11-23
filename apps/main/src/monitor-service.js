/**
 * 持续监控
 *
 * 监控什么：
 *   - 一组视频（显式输入的，或关键词搜出来的那批）
 *   - 每轮把视频评论第一页重新扫一遍，新出现的人进同一个审核队列
 *
 * ★ 实测限制（2026-10-29）
 *   网页端搜索对金融/汽车类关键词会返回 antispam/hit_limit，data 为空。
 *   监控改为：每轮先用「手机签名搜索」发现新视频，按 awemeId 去重并入列表，
 *   然后全量扫描列表内所有视频的评论；评论按 cid 去重兜底。
 *
 * ★ 配额
 *   监控和手动采集共用同一个每日请求额度（setting 里的 harvest.usage）。
 *   额度不足时本轮直接跳过，不会硬打接口。
 */
import { db_ } from './db.js';
import {
  getHarvestConfig, HarvestThrottle, createWebClient, getAccountRequestGate,
} from './harvest-service.js';
import { collectMobileSearchVideos } from './mobile-search-service.js';
import { addLeadsToTask, getInterceptTask } from './intercept-service.js';
import { getAccountProxyUrl } from './proxy-service.js';

const MAX_WATCH_VIDEOS = 5000;
/** 每轮最多补多少个根评论的楼中楼回复，避免请求量爆炸；未补完的下一轮继续 */
const MAX_REPLY_ROOTS_PER_ROUND = 100;
/** 当前正在跑的监控任务集合，给 UI 显示「扫描中」 */
const runningTasks = new Set();
/** 任务删除后通知正在跑的这一轮尽快退出，避免继续写孤儿数据 */
const cancelledTasks = new Set();

export function isMonitorRunning(taskId) {
  return runningTasks.has(String(taskId));
}

export function cancelMonitorTask(taskId) {
  cancelledTasks.add(String(taskId));
}

export function clearMonitorCancellation(taskId) {
  cancelledTasks.delete(String(taskId));
}

/**
 * 把手机搜索到的新视频并入监控列表。
 * - 只保留评论监控必需的字段（不存视频标题/作者/点赞等大字段）
 * - 以 awemeId 去重；已存在的视频用最新 commentCount 更新
 * - 新视频要求有评论；0 评论的旧视频会保留但不参与每轮扫描
 */
export function mergeWatchVideos(watch, incoming, now = Date.now()) {
  const next = (Array.isArray(watch) ? watch : []).map((v) => ({
    awemeId: String(v.awemeId),
    commentCount: v.commentCount ?? null,
    keyword: v.keyword ?? null,
    addedAt: v.addedAt ?? now,
    lastScanAt: v.lastScanAt ?? null,
    ...(v.failCount ? { failCount: v.failCount } : {}),
    ...(v.lastError ? { lastError: v.lastError } : {}),
    ...(v.nextRetryAt ? { nextRetryAt: v.nextRetryAt } : {}),
  }));
  const byId = new Map(next.map((v) => [v.awemeId, v]));
  let added = 0;
  let updated = 0;

  for (const v of incoming ?? []) {
    const awemeId = v?.awemeId ? String(v.awemeId) : '';
    if (!awemeId) continue;

    const current = byId.get(awemeId);
    if (current) {
      const count = Number(v.commentCount);
      if (Number.isFinite(count) && count >= 0 && count !== Number(current.commentCount)) {
        current.commentCount = count;
        updated++;
      }
      continue;
    }

    if (!Number(v.commentCount)) continue;
    const item = {
      awemeId,
      commentCount: v.commentCount ?? null,
      keyword: v.keyword ?? null,
      addedAt: now,
      lastScanAt: null,
    };
    byId.set(awemeId, item);
    next.push(item);
    added++;
  }

  if (next.length > MAX_WATCH_VIDEOS) {
    next.sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0));
    next.splice(0, next.length - MAX_WATCH_VIDEOS);
  }

  return { watch: next, added, updated };
}

/** 每轮全量扫描：最久没扫过的排前面，新加入的（lastScanAt=null）最优先 */
export function selectScanVideos(watch) {
  return (watch ?? [])
    // commentCount=0 的视频本轮先跳过；手机搜索看到评论数变大后会重新纳入
    .filter((v) => v.commentCount == null || Number(v.commentCount) > 0)
    .slice()
    .sort((a, b) => {
      const diff = (a.lastScanAt ?? 0) - (b.lastScanAt ?? 0);
      return diff !== 0 ? diff : (a.addedAt ?? 0) - (b.addedAt ?? 0);
    });
}

// ══════════════════════════════════════
// CRUD
// ══════════════════════════════════════

export const MONITOR_DEFAULTS = {
  intervalSec: 30,
  pagesPerVideo: 1,
  keywordsPerRound: 5,
  videosPerRound: 50,
  requestGapMinMs: 300,
  requestGapMaxMs: 600,
  scanConcurrency: 20,
  discoveryIntervalSec: 60,
};

export function createMonitor(taskId, {
  mode,
  keywords = [],
  videos = [],
  intervalSec = MONITOR_DEFAULTS.intervalSec,
  pagesPerVideo = MONITOR_DEFAULTS.pagesPerVideo,
  keywordsPerRound = MONITOR_DEFAULTS.keywordsPerRound,
  videosPerRound = MONITOR_DEFAULTS.videosPerRound,
  requestGapMinMs = MONITOR_DEFAULTS.requestGapMinMs,
  requestGapMaxMs = MONITOR_DEFAULTS.requestGapMaxMs,
  scanConcurrency = MONITOR_DEFAULTS.scanConcurrency,
  discoveryIntervalSec = MONITOR_DEFAULTS.discoveryIntervalSec,
  sinceAt: sinceAtOverride = null,
  includeZeroComments = false,
  maxWatchVideos = MAX_WATCH_VIDEOS,
}) {
  const task = db_().prepare("SELECT id FROM outreach_task WHERE id = ? AND kind = 'intercept'").get(taskId);
  if (!task) throw new Error('任务不存在');
  if (mode !== 'video' && mode !== 'keyword') throw new Error('只有视频/关键词任务能开监控');

  const now = Date.now();
  // ★ 只统计「开始监控之后」的新评论。基线一旦写入不再变，
  //   暂停/恢复都保留同一条时间线；要重新计时就删掉监控重开。
  const sinceAt = Number(sinceAtOverride) > 0
    ? Math.min(now, Number(sinceAtOverride))
    : now;
  const interval = Math.max(5, Math.min(86400, Math.round(Number(intervalSec) || MONITOR_DEFAULTS.intervalSec)));
  const gapMin = Math.max(100, Math.min(10000, Math.round(Number(requestGapMinMs) || MONITOR_DEFAULTS.requestGapMinMs)));
  const gapMax = Math.max(gapMin, Math.min(10000, Math.round(Number(requestGapMaxMs) || MONITOR_DEFAULTS.requestGapMaxMs)));
  const concurrency = Math.max(1, Math.min(20, Math.round(Number(scanConcurrency) || MONITOR_DEFAULTS.scanConcurrency)));
  const discoverySec = Math.max(30, Math.min(3600, Math.round(Number(discoveryIntervalSec) || MONITOR_DEFAULTS.discoveryIntervalSec)));
  let sourceVideos = (videos ?? []).filter((v) => v?.awemeId);
  if (!includeZeroComments) {
    sourceVideos = sourceVideos.filter((v) => v.commentCount == null || Number(v.commentCount) > 0);
  }
  const watchLimit = Math.max(0, Number(maxWatchVideos) || 0);
  if (watchLimit > 0) sourceVideos = sourceVideos.slice(0, watchLimit);
  const watch = sourceVideos
    .map((v) => ({
      awemeId: String(v.awemeId),
      commentCount: v.commentCount ?? null,
      keyword: v.keyword ?? null,
      addedAt: now,
      lastScanAt: null,
    }));

  if (!watch.length) throw new Error('没有可监控的视频，先采集一次');

  db_()
    .prepare(
      `INSERT INTO monitor
         (task_id, mode, keywords, videos, interval_min, interval_sec, pages_per_video,
          keywords_per_round, videos_per_round, request_gap_min_ms, request_gap_max_ms,
          scan_concurrency, discovery_interval_sec, last_discovery_at,
          enabled, rounds, next_run_at, since_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, 0, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET
         mode = excluded.mode, keywords = excluded.keywords, videos = excluded.videos,
         interval_min = excluded.interval_min, interval_sec = excluded.interval_sec,
         pages_per_video = excluded.pages_per_video,
         keywords_per_round = excluded.keywords_per_round,
         videos_per_round = excluded.videos_per_round,
         request_gap_min_ms = excluded.request_gap_min_ms,
         request_gap_max_ms = excluded.request_gap_max_ms,
         scan_concurrency = excluded.scan_concurrency,
         discovery_interval_sec = excluded.discovery_interval_sec,
         enabled = 1, next_run_at = excluded.next_run_at`,
    )
    .run(
      taskId,
      mode,
      JSON.stringify(keywords ?? []),
      JSON.stringify(watch),
      Math.max(1, Math.round(interval / 60)),
      interval,
      Math.max(0, Math.min(20, Number(pagesPerVideo ?? 1))),
      Math.max(1, Math.min(10, Number(keywordsPerRound) || MONITOR_DEFAULTS.keywordsPerRound)),
      Math.max(1, Math.min(100, Number(videosPerRound) || MONITOR_DEFAULTS.videosPerRound)),
      gapMin,
      gapMax,
      concurrency,
      discoverySec,
      now + 5000,
      sinceAt,
      now,
    );

  return getMonitor(taskId);
}

export function getMonitor(taskId) {
  const r = db_().prepare('SELECT * FROM monitor WHERE task_id = ?').get(taskId);
  if (!r) return null;
  let videos = [];
  let keywords = [];
  try { videos = JSON.parse(r.videos || '[]'); } catch {}
  try { keywords = JSON.parse(r.keywords || '[]'); } catch {}
  let summary = null;
  try { summary = r.last_summary ? JSON.parse(r.last_summary) : null; } catch {}
  return {
    taskId: r.task_id,
    mode: r.mode,
    keywords,
    videos,
    videoCount: videos.length,
    intervalSec: r.interval_sec ?? (r.interval_min ?? 60) * 60,
    intervalMin: r.interval_min,
    pagesPerVideo: r.pages_per_video,
    keywordsPerRound: r.keywords_per_round,
    videosPerRound: r.videos_per_round,
    requestGapMinMs: r.request_gap_min_ms ?? MONITOR_DEFAULTS.requestGapMinMs,
    requestGapMaxMs: r.request_gap_max_ms ?? MONITOR_DEFAULTS.requestGapMaxMs,
    scanConcurrency: r.scan_concurrency ?? MONITOR_DEFAULTS.scanConcurrency,
    discoveryIntervalSec: r.discovery_interval_sec ?? MONITOR_DEFAULTS.discoveryIntervalSec,
    lastDiscoveryAt: r.last_discovery_at ?? null,
    enabled: r.enabled !== 0,
    rounds: r.rounds,
    running: runningTasks.has(String(taskId)),
    lastRunAt: r.last_run_at,
    nextRunAt: r.next_run_at,
    lastSummary: summary,
    sinceAt: r.since_at ?? r.created_at,
    totalNewComments: (() => {
      try {
        return db_()
          .prepare('SELECT COUNT(*) c FROM monitor_comment WHERE task_id = ?')
          .get(taskId).c;
      } catch { return 0; }
    })(),
    createdAt: r.created_at,
  };
}

export function updateMonitor(taskId, patch = {}) {
  const mon = getMonitor(taskId);
  if (!mon) throw new Error('监控不存在');

  const sets = [];
  const args = [];
  const ints = {
    intervalSec: ['interval_sec', 5, 86400],
    pagesPerVideo: ['pages_per_video', 0, 20],
    keywordsPerRound: ['keywords_per_round', 1, 10],
    videosPerRound: ['videos_per_round', 1, 100],
    requestGapMinMs: ['request_gap_min_ms', 100, 10000],
    requestGapMaxMs: ['request_gap_max_ms', 100, 10000],
    scanConcurrency: ['scan_concurrency', 1, 20],
    discoveryIntervalSec: ['discovery_interval_sec', 30, 3600],
  };
  for (const [key, [col, min, max]] of Object.entries(ints)) {
    if (patch[key] === undefined) continue;
    const v = Math.max(min, Math.min(max, Math.round(Number(patch[key]) || min)));
    sets.push(`${col} = ?`);
    args.push(v);
  }
  if (patch.sinceAt !== undefined) {
    const v = Number(patch.sinceAt);
    if (!Number.isFinite(v) || v <= 0) throw new Error('统计起点时间无效');
    sets.push('since_at = ?');
    args.push(Math.min(Date.now(), Math.round(v)));
  }
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?');
    args.push(patch.enabled ? 1 : 0);
    if (patch.enabled) {
      sets.push('next_run_at = ?');
      args.push(Date.now() + (patch.intervalSec ?? mon.intervalSec) * 1000);
    }
  }
  if (!sets.length) return mon;
  args.push(taskId);
  db_().prepare(`UPDATE monitor SET ${sets.join(', ')} WHERE task_id = ?`).run(...args);
  return getMonitor(taskId);
}

/** 把统计起点重置为现在（不清空已采集的线索） */
export function resetMonitorBaseline(taskId) {
  const now = Date.now();
  db_().prepare('UPDATE monitor SET since_at = ? WHERE task_id = ?').run(now, taskId);
  db_().prepare('DELETE FROM monitor_comment WHERE task_id = ?').run(taskId);
  return getMonitor(taskId);
}

export function deleteMonitor(taskId) {
  db_().prepare('DELETE FROM monitor_comment WHERE task_id = ?').run(taskId);
  db_().prepare('DELETE FROM monitor WHERE task_id = ?').run(taskId);
  return { ok: true };
}

export function listDueMonitors(now = Date.now()) {
  return db_()
    .prepare('SELECT task_id FROM monitor WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?) ORDER BY next_run_at LIMIT 5')
    .all(now)
    .map((r) => r.task_id);
}

// ══════════════════════════════════════
// 执行一轮
// ══════════════════════════════════════

/**
 * 跑一轮监控
 *
 * @returns 本轮摘要 { newLeads, requests, scannedVideos, newVideos, warnings, error }
 */
export async function runMonitorRound(taskId, deps = {}) {
  const key = String(taskId);
  if (runningTasks.has(key)) {
    const e = new Error('该任务正在扫描中，请等本轮结束');
    e.code = 'MONITOR_BUSY';
    throw e;
  }
  runningTasks.add(key);
  try {
    return await runMonitorRoundInner(taskId, deps);
  } finally {
    runningTasks.delete(key);
  }
}

async function runMonitorRoundInner(taskId, {
  getSdk,
  web: webOverride,
  searchVideos,
} = {}) {
  const mon = getMonitor(taskId);
  if (!mon) throw new Error('监控不存在');
  const task = getInterceptTask(taskId);
  if (!task) {
    // 任务被删了：顺手清掉监控，避免每 5 秒重试阻塞其它任务
    deleteMonitor(taskId);
    throw new Error('任务不存在，已清理监控');
  }

  const now = Date.now();
  const errors = [];
  let requests = 0;
  const cancelled = () => cancelledTasks.has(String(taskId));

  const finish = (err, { countRound = true, retryMs = null } = {}) => {
    const summary = {
      at: now,
      sinceAt: mon.sinceAt ?? mon.createdAt ?? 0,
      newComments: 0,
      totalNewComments: (() => {
        try {
          return db_()
            .prepare('SELECT COUNT(*) c FROM monitor_comment WHERE task_id = ?')
            .get(taskId).c;
        } catch { return 0; }
      })(),
      newCommentSamples: [],
      skippedOld: 0,
      newLeads: 0,
      updatedLeads: 0,
      duplicates: 0,
      requests,
      scannedVideos: 0,
      failedVideos: 0,
      deferredVideos: 0,
      watchedVideos: mon.videoCount ?? 0,
      newVideos: 0,
      updatedVideos: 0,
      skippedNoComments: 0,
      newReplies: 0,
      replyRoots: 0,
      replyPending: 0,
      searchedKeywords: [],
      warnings: errors,
      error: err ?? null,
      finishedAt: Date.now(),
      durationMs: Date.now() - now,
    };
    const nextAt = Date.now() + (retryMs ?? mon.intervalSec * 1000);
    if (countRound) {
      db_()
        .prepare(
          `UPDATE monitor SET rounds = rounds + 1, last_run_at = ?, next_run_at = ?,
             last_summary = ? WHERE task_id = ?`,
        )
        .run(now, nextAt, JSON.stringify(summary), taskId);
    } else {
      db_()
        .prepare(
          'UPDATE monitor SET next_run_at = ?, last_summary = ? WHERE task_id = ?',
        )
        .run(nextAt, JSON.stringify(summary), taskId);
    }
    return summary;
  };

  const accountId = task.accountIds[0];
  if (!accountId || typeof getSdk !== 'function') {
    return finish('任务没有可用账号', { countRound: false, retryMs: 15000 });
  }
  const sdk = getSdk(accountId);
  if (!sdk?.account) {
    return finish('账号未上线，本轮跳过', { countRound: false, retryMs: 10000 });
  }

  const cfg = getHarvestConfig();
  const throttle = new HarvestThrottle(cfg);

  // 额度先看一眼，别浪费一次失败
  const quota0 = throttle.check(accountId);
  if (!quota0.allowed) {
    return finish(`今日采集请求已达上限（${quota0.limit} 次），本轮跳过`, {
      countRound: false,
      retryMs: 60000,
    });
  }

  let web;
  try {
    web = webOverride ?? createWebClient(sdk);
  } catch (e) {
    return finish(e.message, { countRound: false, retryMs: 30000 });
  }

  const gate = getAccountRequestGate(
    accountId,
    mon.scanConcurrency ?? MONITOR_DEFAULTS.scanConcurrency,
  );

  const call = async (fn) => {
    await gate.acquire({
      minMs: mon.requestGapMinMs,
      maxMs: mon.requestGapMaxMs,
      throttle,
    });
    requests++;
    try {
      return await fn();
    } catch (e) {
      gate.noteError(e);
      throw e;
    } finally {
      gate.release();
    }
  };

  const skippedNoComments = (mon.videos ?? [])
    .filter((v) => Number(v.commentCount) === 0).length;
  let watch = (mon.videos ?? [])
    .filter((v) => v.commentCount == null || Number(v.commentCount) > 0)
    .map((v) => ({
    awemeId: String(v.awemeId),
    commentCount: v.commentCount ?? null,
    keyword: v.keyword ?? null,
    addedAt: v.addedAt ?? now,
    lastScanAt: v.lastScanAt ?? null,
    ...(v.failCount ? { failCount: v.failCount } : {}),
    ...(v.lastError ? { lastError: v.lastError } : {}),
    ...(v.nextRetryAt ? { nextRetryAt: v.nextRetryAt } : {}),
  }));
  let newVideoCount = 0;
  let updatedVideoCount = 0;
  let quotaHit = false;
  const roundKeywords = [];

  // ── 1. 手机搜索发现新视频（独立节奏，不必每轮都搜）──
  //   关键词按轮转取，避免一次把所有关键词都打一遍。
  if (cancelled()) return finish('任务已删除，本轮中止');
  const discoveryIntervalMs = Math.max(
    30, Number(mon.discoveryIntervalSec) || MONITOR_DEFAULTS.discoveryIntervalSec,
  ) * 1000;
  const discoveryDue = !mon.lastDiscoveryAt
    || now - Number(mon.lastDiscoveryAt) >= discoveryIntervalMs;

  // 发现新视频和评论扫描并行跑：搜索隐藏窗口较慢，不能阻塞评论扫描。
  // 新发现的视频本轮先不扫，合并进列表后下一轮扫描。
  let discoveryPromise = null;
  if (mon.mode === 'keyword' && mon.keywords.length && discoveryDue) {
    const kws = mon.keywords;
    const take = Math.min(mon.keywordsPerRound, kws.length);
    const start = mon.rounds % kws.length;
    const roundKwList = [];
    for (let i = 0; i < take; i++) roundKwList.push(kws[(start + i) % kws.length]);
    roundKeywords.push(...roundKwList);

    discoveryPromise = (async () => {
      try {
        const cookies = (() => {
          try { return sdk.account?.im?.client?.getCookies?.() || ''; } catch { return ''; }
        })();
        const searchFn = searchVideos ?? collectMobileSearchVideos;
        const mobile = await searchFn({
          cookies,
          keywords: roundKwList,
          target: Math.min(1000, Math.max(50, take * Math.max(10, mon.videosPerRound))),
          maxPagesPerKeyword: 5,
          count: 20,
          intervalMs: 800,
          proxyUrl: getAccountProxyUrl(accountId),
          // 手机搜索也走账号级闸门和配额
          requestWrapper: (fn) => call(fn),
        });
        return mobile.videos ?? [];
      } catch (e) {
        if (e.code === 'quota') quotaHit = true;
        errors.push(`手机搜索新视频失败：${e.message}`);
        return null;
      } finally {
        // 记录本次发现时间：成功失败都按发现周期重试，避免每轮创建隐藏窗口
        try {
          const at = Date.now();
          db_().prepare('UPDATE monitor SET last_discovery_at = ? WHERE task_id = ?')
            .run(at, taskId);
          mon.lastDiscoveryAt = at;
        } catch {}
      }
    })();
  }
  if (cancelled()) return finish('任务已删除，本轮中止');

  // ── 2. 全量扫描：列表里所有视频都扫，最久没扫过的优先 ──
  const scanList = selectScanVideos(watch);

  const leads = [];
  let scanned = 0;
  let failedVideos = 0;
  let deferredVideos = 0;
  let newComments = 0;
  let newReplies = 0;
  let replyRoots = 0;
  let replyPending = 0;
  let skippedOld = 0;
  const newSamples = [];
  const replyCandidates = new Map();

  const baseSince = mon.sinceAt ?? mon.createdAt ?? 0;
  // 监控基线之外，再加一道"最近 N 天"的上限
  const maxAgeMs = cfg.maxCommentAgeDays > 0 ? cfg.maxCommentAgeDays * 86_400_000 : 0;
  const sinceAt = maxAgeMs ? Math.max(baseSince, now - maxAgeMs) : baseSince;
  const seenStmt = db_().prepare(
    `INSERT OR IGNORE INTO monitor_comment
       (task_id, cid, create_time, first_seen_at, aweme_id, parent_cid, reply_total)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
  );
  const rootStateStmt = db_().prepare(
    `UPDATE monitor_comment SET aweme_id = ?, reply_total = ?
     WHERE task_id = ? AND cid = ?`,
  );
  const replyInsStmt = db_().prepare(
    `INSERT OR IGNORE INTO monitor_comment
       (task_id, cid, create_time, first_seen_at, aweme_id, parent_cid, reply_total, reply_seen_total)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0)`,
  );
  const replyDoneStmt = db_().prepare(
    `UPDATE monitor_comment SET reply_seen_total = ?, reply_fetched_at = ?
     WHERE task_id = ? AND cid = ?`,
  );
  const replyFailStmt = db_().prepare(
    `UPDATE monitor_comment SET reply_fetched_at = ?
     WHERE task_id = ? AND cid = ?`,
  );
  // 已抓过的楼中楼状态（根评论 cid -> 回复进度）
  const replyState = new Map();
  try {
    const rows = db_().prepare(
      `SELECT cid, reply_total, reply_seen_total, reply_fetched_at
       FROM monitor_comment WHERE task_id = ? AND parent_cid IS NULL`,
    ).all(taskId);
    for (const row of rows) {
      replyState.set(row.cid, {
        replyTotal: Number(row.reply_total) || 0,
        replySeenTotal: Number(row.reply_seen_total) || 0,
        replyFetchedAt: row.reply_fetched_at ?? null,
      });
    }
  } catch {}
  // 清掉 30 天前的记录，避免表无限增长
  try {
    db_()
      .prepare('DELETE FROM monitor_comment WHERE task_id = ? AND create_time < ?')
      .run(taskId, Math.floor((now - 30 * 86400000) / 1000));
  } catch {}

  const scanOne = async (v) => {
    if (quotaHit || cancelled()) return;
    // 连续失败的视频进入退避，避免每轮都反复打同一个坏视频
    if (v.nextRetryAt && v.nextRetryAt > Date.now()) {
      deferredVideos++;
      return;
    }
    let fetched = 0;
    let cursor = 0;
    let videoFailed = false;
    const maxPages = mon.pagesPerVideo > 0 ? mon.pagesPerVideo : Infinity;

    for (let page = 0; page < maxPages; page++) {
      if (cancelled()) { errors.push('任务已删除，扫描中止'); break; }
      let r;
      try {
        r = await call(() => web.fetchComments(v.awemeId, { cursor, count: 20 }));
      } catch (e) {
        if (e.code === 'quota') { quotaHit = true; errors.push(e.message); break; }
        videoFailed = true;
        v.failCount = (Number(v.failCount) || 0) + 1;
        v.lastError = String(e.message ?? '').slice(0, 200);
        if (v.failCount >= 3) {
          const mins = Math.min(60, 5 * 2 ** Math.max(0, v.failCount - 3));
          v.nextRetryAt = Date.now() + mins * 60000;
        }
        errors.push(`视频 ${v.awemeId} 采集失败：${e.message}`);
        break;
      }
      fetched += r.comments.length;
      for (const c of r.comments) {
        // ★ 只统计开始监控之后发布的评论
        const createdMs = c.createTime ? c.createTime * 1000 : 0;
        if (!createdMs || createdMs < sinceAt) { skippedOld++; continue; }

        // 新评论按 cid 去重计数（同一条评论只算一次）
        if (c.cid) {
          const cid = String(c.cid);
          const replyTotal = Number(c.replyTotal) || 0;
          const ins = seenStmt.run(
            taskId, cid, c.createTime ?? null, Date.now(), v.awemeId, replyTotal,
          );
          rootStateStmt.run(v.awemeId, replyTotal, taskId, cid);

          // 根评论回复数比上次多（或从没抓过）→ 加入本轮楼中楼候选
          const st = replyState.get(cid) ?? {
            replyTotal: 0, replySeenTotal: 0, replyFetchedAt: null,
          };
          st.replyTotal = replyTotal;
          replyState.set(cid, st);
          if (replyTotal > st.replySeenTotal) {
            replyCandidates.set(cid, {
              cid,
              awemeId: v.awemeId,
              keyword: v.keyword ?? null,
              replyTotal,
              seen: st.replySeenTotal,
              fetchedAt: st.replyFetchedAt,
            });
          } else {
            replyCandidates.delete(cid);
          }

          if (ins.changes > 0) {
            newComments++;
            if (newSamples.length < 5) {
              newSamples.push({ text: String(c.text ?? '').slice(0, 60), at: c.createTime ?? null });
            }
          }
        }

        if (!c.text || c.text.length < 2) continue;
        leads.push({
          uid: c.uid,
          secUid: c.secUid ?? null,
          nickname: c.nickname,
          comment: c.text.slice(0, 300),
          videoId: v.awemeId,
          // 只存评论所需数据，不再持久化视频标题/作者等大字段
          videoTitle: null,
          keyword: v.keyword ?? null,
          sourceCid: c.cid ?? null,
          commentType: 'root',
          parentCid: null,
          diggCount: c.diggCount,
          commentAt: c.createTime ? c.createTime * 1000 : null,
        });
      }
      if (!r.hasMore) break;
      cursor = r.nextCursor;
    }

    if (quotaHit || cancelled()) return;
    if (videoFailed) {
      failedVideos++;
    } else {
      v.lastScanAt = Date.now();
      v.failCount = 0;
      v.lastError = null;
      v.nextRetryAt = null;
      if (fetched) scanned++;
    }
  };

  const scanConcurrency = Math.max(
    1,
    Math.min(20, Number(mon.scanConcurrency) || MONITOR_DEFAULTS.scanConcurrency),
  );
  let scanIndex = 0;
  await Promise.all(Array.from({ length: scanConcurrency }, async () => {
    while (true) {
      if (quotaHit || cancelled()) break;
      const idx = scanIndex++;
      if (idx >= scanList.length) break;
      await scanOne(scanList[idx]);
    }
  }));

  // ── 2.5 楼中楼回复：每轮最多补 N 个根评论，未补完的下一轮继续 ──
  if (typeof web.fetchCommentReplies === 'function'
      && replyCandidates.size
      && !quotaHit
      && !cancelled()) {
    const list = [...replyCandidates.values()].sort((a, b) => {
      const af = a.fetchedAt ?? 0;
      const bf = b.fetchedAt ?? 0;
      if (af !== bf) return af - bf; // 从没抓过的、最久没抓的优先
      return b.replyTotal - a.replyTotal;
    });
    const take = Math.min(list.length, MAX_REPLY_ROOTS_PER_ROUND);
    let processed = 0;
    let replyIndex = 0;
    // 楼中楼也并发抓；与一级评论共用扫描并发，最高 10 路
    const replyConcurrency = Math.max(1, Math.min(10, scanConcurrency, take));
    await Promise.all(Array.from({ length: replyConcurrency }, async () => {
      while (true) {
        if (quotaHit || cancelled()) break;
        const i = replyIndex++;
        if (i >= take) break;
        const item = list[i];
        let rr;
        try {
          rr = await call(() => web.fetchCommentReplies(
            item.awemeId, item.cid, { cursor: 0, count: 20 },
          ));
        } catch (e) {
          if (e.code === 'quota') {
            quotaHit = true;
            errors.push(e.message);
            return;
          }
          errors.push(`根评论 ${item.cid} 回复抓取失败：${e.message}`);
          // 记一次抓取时间，下一轮排到队尾重试
          replyFailStmt.run(Date.now(), taskId, item.cid);
          processed++;
          continue;
        }

        for (const rc of rr.comments) {
          // 楼中楼也只统计监控基线之后的回复
          const createdMs = rc.createTime ? rc.createTime * 1000 : 0;
          if (!createdMs || createdMs < sinceAt) { skippedOld++; continue; }

          if (rc.cid) {
            const ins = replyInsStmt.run(
              taskId, String(rc.cid), rc.createTime ?? null, Date.now(), item.awemeId, item.cid,
            );
            if (ins.changes > 0) {
              newReplies++;
              newComments++;
              if (newSamples.length < 5) {
                newSamples.push({ text: String(rc.text ?? '').slice(0, 60), at: rc.createTime ?? null });
              }
            }
          }

          if (!rc.text || rc.text.length < 2) continue;
          leads.push({
            uid: rc.uid,
            secUid: rc.secUid ?? null,
            nickname: rc.nickname,
            comment: rc.text.slice(0, 300),
            videoId: item.awemeId,
            videoTitle: null,
            keyword: item.keyword,
            sourceCid: rc.cid ?? null,
            commentType: 'reply',
            parentCid: item.cid,
            diggCount: rc.diggCount,
            commentAt: rc.createTime ? rc.createTime * 1000 : null,
          });
        }

        replyDoneStmt.run(item.replyTotal, Date.now(), taskId, item.cid);
        replyRoots++;
        processed++;
      }
    }));

    replyPending = Math.max(0, list.length - processed);
  }

  // 等并行发现结束，把新视频并入列表（本轮不补扫，下一轮全量覆盖）
  if (discoveryPromise) {
    const discovered = await discoveryPromise;
    if (discovered?.length && !cancelled()) {
      const merged = mergeWatchVideos(watch, discovered, now);
      watch = merged.watch;
      newVideoCount = merged.added;
      updatedVideoCount = merged.updated;
      if (newVideoCount > 0 || updatedVideoCount > 0) {
        try {
          db_().prepare('UPDATE monitor SET videos = ? WHERE task_id = ?')
            .run(JSON.stringify(watch), taskId);
        } catch {}
      }
    }
  }

  // 本轮结束前把批量计数落盘，避免只靠 2 秒定时器
  try { throttle.flush(); } catch {}

  // ── 3. 入队（去重交给 addLeadsToTask）──
  let added = 0;
  let updatedLeads = 0;
  let duplicates = 0;
  if (leads.length && !cancelled() && getInterceptTask(taskId)) {
    const r = addLeadsToTask(taskId, task.accountIds, leads, cfg);
    added = r.added;
    updatedLeads = r.updated ?? 0;
    duplicates = r.duplicates;
    db_()
      .prepare(
        `UPDATE outreach_task SET target_count =
           (SELECT COUNT(*) FROM outreach_item WHERE task_id = ?) WHERE id = ?`,
      )
      .run(taskId, taskId);
  } else if (leads.length && cancelled()) {
    errors.push('任务已删除，本轮线索未入库');
  }

  const totalNewComments = (() => {
    try {
      return db_()
        .prepare('SELECT COUNT(*) c FROM monitor_comment WHERE task_id = ?')
        .get(taskId).c;
    } catch { return newComments; }
  })();

  const summary = {
    at: now,
    sinceAt,
    newComments,
    totalNewComments,
    newCommentSamples: newSamples,
    skippedOld,
    newLeads: added,
    updatedLeads,
    duplicates,
    requests,
    scannedVideos: scanned,
    failedVideos,
    deferredVideos,
    watchedVideos: watch.length,
    newVideos: newVideoCount,
    updatedVideos: updatedVideoCount,
    skippedNoComments,
    newReplies,
    replyRoots,
    replyPending,
    searchedKeywords: roundKeywords,
    warnings: errors,
    error: quotaHit ? '本轮因配额中断，已保留已采集部分' : null,
    finishedAt: Date.now(),
    durationMs: Date.now() - now,
  };

  db_()
    .prepare(
      `UPDATE monitor SET rounds = rounds + 1, last_run_at = ?, next_run_at = ?,
         videos = ?, last_summary = ? WHERE task_id = ?`,
    )
    .run(now, Date.now() + mon.intervalSec * 1000, JSON.stringify(watch), JSON.stringify(summary), taskId);

  return summary;
}

// ══════════════════════════════════════
// 调度器
// ══════════════════════════════════════

let timer = null;
let dispatching = false;
let deps = { getSdk: null, onEvent: null };
const MAX_ACTIVE_ACCOUNTS = 10;

export function startMonitorScheduler({ getSdk, onEvent, intervalMs = 5000, canRun } = {}) {
  deps = { getSdk, onEvent, canRun };
  if (timer) return;
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  console.log(`[monitor] 调度器已启动（每 ${intervalMs / 1000} 秒检查一次，最多 ${MAX_ACTIVE_ACCOUNTS} 个账号并行）`);
}

export function stopMonitorScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

function listDueMonitorRows(now = Date.now()) {
  return db_()
    .prepare(
      `SELECT m.task_id, m.next_run_at, t.account_ids
       FROM monitor m
       LEFT JOIN outreach_task t ON t.id = m.task_id
       WHERE m.enabled = 1 AND (m.next_run_at IS NULL OR m.next_run_at <= ?)
       ORDER BY m.next_run_at ASC LIMIT 50`,
    )
    .all(now);
}

/**
 * 公平挑选本轮可启动的任务：
 * - 同一账号只挑一个
 * - 已在跑的任务跳过
 * - 最多启动 max 个账号
 */
export function pickDispatchableTasks(rows, runningTaskIds, activeAccountIds = [], max = MAX_ACTIVE_ACCOUNTS) {
  const picked = [];
  const accounts = new Set((activeAccountIds ?? []).map(String));
  const running = new Set([...(runningTaskIds ?? [])].map(String));

  for (const row of rows ?? []) {
    if (picked.length >= max) break;
    const taskId = String(row.task_id);
    if (running.has(taskId)) continue;
    let accountId = '';
    try {
      accountId = String(JSON.parse(row.account_ids || '[]')[0] || '');
    } catch {}
    if (!accountId || accounts.has(accountId)) continue;
    accounts.add(accountId);
    picked.push({ taskId, accountId });
  }
  return picked;
}

export function getSchedulerSnapshot() {
  const active = [];
  for (const taskId of runningTasks) {
    const row = db_()
      .prepare('SELECT account_ids, name FROM outreach_task WHERE id = ?')
      .get(taskId);
    let accountId = '';
    try { accountId = String(JSON.parse(row?.account_ids || '[]')[0] || ''); } catch {}
    active.push({ taskId, accountId, name: row?.name ?? taskId });
  }
  const activeAccounts = new Set(active.map((x) => x.accountId).filter(Boolean));
  const queued = listDueMonitorRows()
    .filter((row) => !runningTasks.has(String(row.task_id)))
    .map((row) => {
      let accountId = '';
      try { accountId = String(JSON.parse(row.account_ids || '[]')[0] || ''); } catch {}
      return { taskId: String(row.task_id), accountId };
    })
    .filter((row) => row.accountId && !activeAccounts.has(row.accountId));
  return {
    active,
    queued,
    activeCount: active.length,
    queuedCount: queued.length,
  };
}

async function tick() {
  if (dispatching) return;
  if (deps.canRun && !deps.canRun()) return;
  dispatching = true;
  try {
    const rows = listDueMonitorRows();
    // 不同账号可以并行；同一账号同一时间只跑一个监控任务，避免请求叠加。
    const activeAccounts = new Set();
    for (const taskId of runningTasks) {
      const row = db_()
        .prepare('SELECT account_ids FROM outreach_task WHERE id = ?')
        .get(taskId);
      try {
        const acc = JSON.parse(row?.account_ids || '[]')[0];
        if (acc) activeAccounts.add(String(acc));
      } catch {}
    }

    let started = 0;
    const picked = pickDispatchableTasks(
      rows,
      runningTasks,
      [...activeAccounts],
      MAX_ACTIVE_ACCOUNTS,
    );
    for (const item of picked) {
      const { taskId, accountId } = item;
      activeAccounts.add(accountId);
      started++;
      // 不 await：不同账号并行跑，同一账号由 activeAccounts 排队。
      runMonitorRound(taskId, { getSdk: deps.getSdk })
        .then((summary) => deps.onEvent?.({ taskId, summary }))
        .catch((e) => {
          console.error('[monitor] 执行失败', e.message);
          deps.onEvent?.({ taskId, error: e.message });
        })
        .finally(() => {
          activeAccounts.delete(accountId);
        });
    }
  } finally {
    dispatching = false;
  }
}

/** 估算每轮/每天请求数，给 UI 提示 */
export function estimateMonitorRequests({
  mode,
  keywordCount = 0,
  videoCount = 0,
  intervalSec = MONITOR_DEFAULTS.intervalSec,
  keywordsPerRound = MONITOR_DEFAULTS.keywordsPerRound,
  pagesPerVideo = MONITOR_DEFAULTS.pagesPerVideo,
}) {
  // 每轮全量扫描 + 楼中楼补抓上限；关键词搜索按发现周期另行发生
  const kw = mode === 'keyword' ? Math.min(keywordsPerRound, keywordCount) * 3 : 0;
  const vids = Math.max(0, Number(videoCount) || 0) * Math.max(1, Number(pagesPerVideo) || 1);
  const perRound = vids + 20 + kw;
  const roundsPerDay = Math.floor(86400 / Math.max(5, Number(intervalSec) || MONITOR_DEFAULTS.intervalSec));
  return { perRound, roundsPerDay, perDay: perRound * roundsPerDay };
}
