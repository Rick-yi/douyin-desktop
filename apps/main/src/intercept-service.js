/**
 * 线索雷达服务
 *
 * 三段式：采集 → 审核 → 发送
 *   采集：手动 UID / 指定视频评论 / 关键词搜视频评论
 *   审核：默认全部「待审核」，人工勾选后才进发送队列
 *   发送：保守节流，比群发更严格
 *
 * ★ 保守参数（对比群发）：
 *   日上限 10（群发 20）
 *   时上限 3（群发 5）
 *   间隔 60~180 秒（群发 8~30 秒）
 *   单次任务上限 30 人（群发不限）
 *   冷却 24 小时
 *   强制人工审核
 *
 * ★ 采集侧
 *   关键词模式优先走「手机签名搜索」：隐藏手机视口加载抖音搜索页，
 *   抓页面自己的签名请求，再改关键词/页码复用。金融/汽车类关键词也能出结果。
 *   手机搜索不可用时降级到网页搜索接口。
 *   评论仍走 SDK 登录态 cookie 调 web 接口。
 *   采集失败不影响手动导入 —— 这条降级路径永远保留。
 */
import { randomUUID } from 'node:crypto';
import { db_ } from './db.js';
import {
  getHarvestConfig, HarvestThrottle, HarvestError,
  createWebClient, parseVideoInput, parseKeywordInput, getAccountRequestGate,
} from './harvest-service.js';
import { collectMobileSearchVideos } from './mobile-search-service.js';
import { collectLiveRoomLeads, parseLiveInput } from './live-harvest-service.js';
import { getAccountProxyUrl } from './proxy-service.js';

// ── 默认参数 ──
export const INTERCEPT_DEFAULTS = {
  dailyLimit: 1000,
  hourlyLimit: 1000,
  gapMinSec: 1,
  gapMaxSec: 1,
  batchSize: 1000,
  roundWaitSec: 0,
  maxPerTask: 1000,
  cooldownMs: 24 * 60 * 60 * 1000,
};

/** 删除任务时通知正在跑的采集尽快退出，避免继续写孤儿数据 */
const cancelledHarvests = new Set();
export function cancelHarvest(taskId) {
  cancelledHarvests.add(String(taskId));
}
function isHarvestCancelled(taskId) {
  return cancelledHarvests.has(String(taskId));
}

// 采集方式（给 UI 展示）
export const HARVEST_MODES = {
  manual: { key: 'manual', name: '手动导入', hint: '一行一个 UID，可带备注' },
  video: { key: 'video', name: '视频评论', hint: '一行一个视频链接或 ID' },
  keyword: { key: 'keyword', name: '关键词搜索', hint: '手机搜索 → 视频评论' },
  live: {
    key: 'live', name: '直播间',
    hint: '电脑端直播间链接或房间号（不支持 v.douyin.com 分享短链）',
  },
  competitor: {
    key: 'competitor', name: '同行视频监控',
    hint: '勾选同行监控里的活跃同行，默认监控其全部视频',
  },
};

// 截流间隔下限（真实发送必须遵守，演练模式可覆盖）
const SAFE_GAP = { min: INTERCEPT_DEFAULTS.gapMinSec, max: INTERCEPT_DEFAULTS.gapMaxSec };

// ══════════════════════════════════════
// 输入解析
// ══════════════════════════════════════

/**
 * 解析 UID 文本（一行一个，可带备注）
 * 支持格式：
 *   123456789
 *   123456789,张三
 *   123456789 张三
 */
export function parseUidList(raw) {
  const out = [];
  const seen = new Set();
  const invalid = [];
  let duplicates = 0;

  for (const line of String(raw ?? '').split(/[\r\n]+/)) {
    const t = line.trim();
    if (!t) continue;

    // uid 后可跟 , ， 制表符 或 空格 再接备注
    const m = t.match(/^(\d{5,25})(?:[\s,，\t]+(.*))?$/);
    if (!m) {
      invalid.push(t.slice(0, 40));
      continue;
    }
    const uid = m[1];
    const name = (m[2] ?? '').trim();

    if (seen.has(uid)) {
      duplicates++;
      continue;
    }
    seen.add(uid);
    out.push({ uid, name: name || null });
  }

  return { targets: out, invalid, duplicates };
}

// ══════════════════════════════════════
// 任务
// ══════════════════════════════════════

/**
 * 创建截流任务（处于采集阶段，尚未审核）
 */
export function createInterceptTask({ name, accountIds, raw, harvestMode = 'manual', params = {} }) {
  const mode = HARVEST_MODES[harvestMode] ? harvestMode : 'manual';
  if (!Array.isArray(accountIds) || !accountIds.length) {
    throw new Error('请选择参与账号');
  }
  const text = String(raw ?? '').trim();
  if (!text) throw new Error('采集内容不能为空');

  // 提前校验，避免建完任务才发现输入有问题
  if (mode === 'manual') {
    const r = parseUidList(text);
    if (!r.targets.length) throw new Error('没有解析到有效 UID');
  } else if (mode === 'video') {
    const r = parseVideoInput(text);
    if (!r.videos.length) throw new Error('没有解析到视频 ID');
  } else if (mode === 'keyword') {
    parseKeywordInput(text);
  } else if (mode === 'live') {
    const r = parseLiveInput(text);
    if (!r.rooms.length) {
      throw new Error(
        r.shortLinks.length
          ? '不支持 v.douyin.com 分享短链，请填写电脑端直播间链接（https://live.douyin.com/数字）或房间号'
          : '没有解析到有效的直播间。请填写电脑端链接（https://live.douyin.com/数字）或房间号',
      );
    }
  }

  const id = randomUUID();
  const now = Date.now();

  db_()
    .prepare(
      `INSERT INTO outreach_task
         (id, kind, name, account_ids, target_mode, target_raw, target_count,
          content_type, content_items, content_strategy,
          gap_sec, batch_size, round_wait_sec, daily_limit, hourly_limit,
          stage, created_at)
       VALUES (?, 'intercept', ?, ?, ?, ?, 0, 'text', '[]', 'random', ?, ?, ?, ?, ?, 'harvesting', ?)`,
    )
    .run(
      id,
      name || `${HARVEST_MODES[mode].name} · ${new Date().toLocaleString('zh-CN')}`,
      JSON.stringify(accountIds ?? []),
      mode,
      text.slice(0, 20000),
      Math.round(
        ((params.gapMinSec ?? INTERCEPT_DEFAULTS.gapMinSec) +
          (params.gapMaxSec ?? INTERCEPT_DEFAULTS.gapMaxSec)) / 2,
      ),
      params.batchSize ?? INTERCEPT_DEFAULTS.batchSize,
      params.roundWaitSec ?? INTERCEPT_DEFAULTS.roundWaitSec,
      params.dailyLimit ?? INTERCEPT_DEFAULTS.dailyLimit,
      params.hourlyLimit ?? INTERCEPT_DEFAULTS.hourlyLimit,
      now,
    );

  return { id, adapter: HARVEST_MODES[mode].name };
}

/**
 * 执行采集
 *
 * @param {string} taskId
 * @param {{ getSdk?: (accountId: string) => object|null }} deps
 * @returns {Promise<object>} 统计信息
 */
export async function runHarvest(taskId, { getSdk, deferComments = false, canRun } = {}) {
  const task = db_().prepare("SELECT * FROM outreach_task WHERE id = ? AND kind = 'intercept'").get(taskId);
  if (!task) throw new Error('任务不存在');
  cancelledHarvests.delete(String(taskId));

  // 重试/首次都从干净的进度开始（已有线索保留，靠 uid 去重）
  try {
    db_().prepare(
      "UPDATE outreach_task SET stage = 'harvesting', harvest_error = NULL, harvest_summary = NULL, " +
      "harvest_scanned = 0, harvest_total = 0, harvest_phase = 'searching', search_total = 0, search_found = 0 " +
      "WHERE id = ?",
    ).run(taskId);
  } catch {}

  try {
    if (task.target_mode === 'live') {
      return await runLiveHarvest(task, getSdk, canRun);
    }
    if (['video', 'keyword', 'competitor'].includes(task.target_mode)) {
      return await runWebHarvest(task, getSdk, deferComments, canRun);
    }
    return runManualHarvest(task);
  } catch (e) {
    markHarvestFailed(taskId, e.message);
    throw e;
  }
}

/**
 * 手动导入 UID
 */
function runManualHarvest(task) {
  const parsed = parseUidList(task.target_raw);
  const cfg = getHarvestConfig();

  if (cfg.maxLeadsPerTask > 0 && parsed.targets.length > cfg.maxLeadsPerTask) {
    throw new Error(
      `单次任务最多 ${cfg.maxLeadsPerTask} 人，当前 ${parsed.targets.length} 人。请分批导入。`,
    );
  }

  const accountIds = JSON.parse(task.account_ids || '[]');
  const r = insertLeads(task.id, accountIds, parsed.targets.map((t) => ({
    uid: t.uid,
    nickname: t.name,
    comment: null,
    videoId: null,
    videoTitle: null,
    commentType: 'manual',
    diggCount: 0,
  })), cfg);

  updateTaskAfterHarvest(task.id);

  return {
    ok: true,
    mode: 'manual',
    total: parsed.targets.length,
    added: r.added,
    duplicates: r.duplicates,
    contactedBefore: r.contactedBefore,
    truncated: r.truncated,
    invalid: parsed.invalid,
    requests: 0,
    stage: 'reviewing',
  };
}

function pickVideosByKeyword(found, target) {
  const uniq = new Map();
  for (const v of found) {
    const id = String(v?.awemeId ?? v?.id ?? '');
    if (!id || uniq.has(id)) continue;
    uniq.set(id, { ...v, awemeId: id });
  }

  const byNewest = (a, b) =>
    (b.createTime ?? 0) - (a.createTime ?? 0) ||
    (b.commentCount ?? 0) - (a.commentCount ?? 0);

  const byKw = new Map();
  for (const v of uniq.values()) {
    const k = v.keyword ?? '';
    if (!byKw.has(k)) byKw.set(k, []);
    byKw.get(k).push(v);
  }
  for (const list of byKw.values()) list.sort(byNewest);

  // 轮转取：每个关键词先各取最新一条，再按全局最新补满，避免一个词吃掉所有名额
  const picked = [];
  const used = new Set();
  let round = 0;
  while (picked.length < target) {
    let added = false;
    for (const list of byKw.values()) {
      const v = list[round];
      if (v && !used.has(v.awemeId)) {
        picked.push(v);
        used.add(v.awemeId);
        added = true;
        if (picked.length >= target) break;
      }
    }
    if (!added) break;
    round++;
  }
  return picked;
}

/**
 * 从视频/关键词采集
 *
 * ★ 部分成功也算成功：命中日配额时返回已采集的部分，并带 warning
 */
/**
 * 直播间采集：在线观众 + 直播评论
 */
async function runLiveHarvest(task, getSdk, canRun = null) {
  const cfg = getHarvestConfig();
  const accountIds = JSON.parse(task.account_ids || '[]');
  const accountId = accountIds[0];
  if (typeof getSdk !== 'function') throw new Error('采集通道未初始化（内部错误）');
  const sdk = getSdk(accountId);
  if (!sdk?.account) {
    throw new Error('账号未上线，无法采集。请先到「账号管理」确认账号已登录。');
  }

  const parsed = parseLiveInput(task.target_raw);
  if (!parsed.rooms.length) {
    throw new Error(
      parsed.shortLinks.length
        ? '不支持 v.douyin.com 分享短链，请填写电脑端直播间链接或房间号'
        : '没有解析到有效的直播间',
    );
  }
  const warnings = [];
  if (parsed.invalid.length) warnings.push(`${parsed.invalid.length} 行直播间格式无效，已跳过`);
  const rooms = parsed.rooms.slice(0, 5);
  if (parsed.rooms.length > rooms.length) {
    warnings.push(`单次最多采集 ${rooms.length} 个直播间，已截取前 ${rooms.length} 个`);
  }

  let cookies = '';
  try { cookies = sdk?.account?.im?.client?.getCookies?.() || ''; } catch {}

  const agg = {
    added: 0, updated: 0, duplicates: 0, contactedBefore: 0, truncated: 0,
    leads: 0, viewers: 0, comments: 0,
  };
  let done = 0;

  saveHarvestProgress(task.id, {
    phase: 'live', total: rooms.length, scanned: 0,
    searchTotal: rooms.length, searchFound: 0,
  });

  const result = await collectLiveRoomLeads({
    rooms,
    cookies,
    proxyUrl: getAccountProxyUrl(accountId),
    shouldStop: () => isHarvestCancelled(task.id) || !!(canRun && !canRun()),
    onProgress: (p) => {
      saveHarvestProgress(task.id, {
        phase: 'live',
        total: p.total,
        scanned: p.done,
        searchTotal: p.total,
        searchFound: p.people,
      });
    },
    onRoom: async (room) => {
      done++;
      agg.viewers += room.viewers || 0;
      agg.comments += room.comments || 0;
      agg.leads += room.leads?.length || 0;
      if (room.error) warnings.push(`${room.title || room.webRid}：${room.error}`);
      if (room.leads?.length) {
        // 直播间一次可能带出几百个在线观众，不按普通评论任务的 50 条上限截断
        const ins = insertLeads(task.id, accountIds, room.leads, { ...cfg, maxLeadsPerTask: 0 });
        agg.added += ins.added;
        agg.updated += ins.updated;
        agg.duplicates += ins.duplicates;
        agg.contactedBefore += ins.contactedBefore;
        agg.truncated += ins.truncated;
      }
      warnings.push(
        `${room.title || room.webRid}：在线 ${room.viewers || 0}，评论 ${room.comments || 0}，线索 ${room.leads?.length || 0}`,
      );
      saveHarvestProgress(task.id, {
        phase: 'live', total: rooms.length, scanned: done,
        searchTotal: rooms.length, searchFound: agg.leads,
      });
    },
  });

  updateTaskAfterHarvest(task.id);
  try {
    db_().prepare(
      "UPDATE outreach_task SET harvest_summary = ?, harvest_error = NULL, harvest_phase = 'done' WHERE id = ?",
    ).run(JSON.stringify({
      added: agg.added,
      updated: agg.updated,
      duplicates: agg.duplicates,
      contactedBefore: agg.contactedBefore,
      truncated: agg.truncated,
      requests: result.requests,
      videos: 0,
      scanned: rooms.length,
      rooms: result.rooms.length,
      viewers: agg.viewers,
      comments: agg.comments,
      warnings,
      live: true,
    }), task.id);
  } catch {}

  return {
    ok: true,
    mode: 'live',
    total: agg.leads,
    added: agg.added,
    updated: agg.updated,
    duplicates: agg.duplicates,
    contactedBefore: agg.contactedBefore,
    truncated: agg.truncated,
    invalid: parsed.invalid,
    requests: result.requests,
    videos: [],
    scannedVideos: 0,
    unscanned: 0,
    warnings,
    stage: 'reviewing',
    live: {
      rooms: result.rooms.length,
      viewers: agg.viewers,
      comments: agg.comments,
    },
  };
}

async function runWebHarvest(task, getSdk, deferComments = false, canRun = null) {
  const cfg = getHarvestConfig();
  const accountIds = JSON.parse(task.account_ids || '[]');
  const accountId = accountIds[0];
  const linkedCompetitor = !!db_()
    .prepare('SELECT 1 FROM outreach_task_competitor WHERE task_id = ? LIMIT 1')
    .get(task.id);
  if (linkedCompetitor) {
    // 同行任务默认全视频、全量线索，不受普通视频任务 300 条限制
    cfg.maxVideosPerTask = Number.MAX_SAFE_INTEGER;
    cfg.maxLeadsPerTask = 0;
  }

  if (typeof getSdk !== 'function') {
    throw new Error('采集通道未初始化（内部错误）');
  }
  const sdk = getSdk(accountId);
  if (!sdk?.account) {
    throw new Error('账号未上线，无法采集。请先到「账号管理」确认账号已登录，或改用手动导入。');
  }
  if (isHarvestCancelled(task.id)) throw new Error('任务已删除，采集已取消');

  const web = createWebClient(sdk);
  const throttle = new HarvestThrottle(cfg);
  const gate = getAccountRequestGate(accountId, 20);
  let requests = 0;
  const warnings = [];

  // 包一层：账号级闸门（配额 + 随机间隔 + 最多 2 路并发）
  const call = async (fn) => {
    if (canRun && !canRun()) {
      const e = new Error('授权状态已变化，采集已停止');
      e.code = 'license';
      throw e;
    }
    await gate.acquire({
      minMs: cfg.requestGapMinMs,
      maxMs: cfg.requestGapMaxMs,
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

  // ── 拿视频列表 ──
  let videos = [];
  if (linkedCompetitor) {
    const rows = db_().prepare(
      `SELECT v.aweme_id, v.title, v.comment_count, c.nickname AS competitor_name
         FROM outreach_task_competitor t
         JOIN competitor_video v ON v.competitor_id = t.competitor_id
         JOIN competitor c ON c.id = t.competitor_id
        WHERE t.task_id = ? AND v.excluded = 0 AND v.monitor_enabled = 1
        ORDER BY v.create_time DESC`,
    ).all(task.id);
    videos = rows.map((r) => ({
      awemeId: String(r.aweme_id),
      desc: r.title ?? null,
      commentCount: r.comment_count ?? null,
      keyword: r.competitor_name ?? null,
    }));
    if (!videos.length) throw new Error('引用的同行还没有可监控视频');
    saveHarvestProgress(task.id, {
      phase: deferComments ? 'monitoring' : 'scanning',
      total: videos.length, scanned: 0,
      searchTotal: videos.length, searchFound: videos.length,
    });
  } else if (task.target_mode === 'video') {
    const parsed = parseVideoInput(task.target_raw);
    videos = parsed.videos.slice(0, cfg.maxVideosPerTask).map((v) => ({ awemeId: v.id }));
    if (parsed.invalid.length) {
      warnings.push(`${parsed.invalid.length} 行视频格式无效，已跳过`);
    }
    if (videos.length < parsed.videos.length) {
      warnings.push(`单任务最多 ${cfg.maxVideosPerTask} 条视频，已截取前 ${videos.length} 条`);
    }
    saveHarvestProgress(task.id, {
      phase: deferComments ? 'monitoring' : 'scanning',
      total: videos.length, scanned: 0,
      searchTotal: videos.length, searchFound: videos.length,
    });
  } else {
    const { keywords, invalid: badKeywords } = parseKeywordInput(task.target_raw);
    if (badKeywords?.length) {
      warnings.push(`${badKeywords.length} 个关键词格式无效，已跳过`);
    }

    const target = Math.max(1, cfg.maxVideosPerTask);
    const found = [];
    saveHarvestProgress(task.id, {
      phase: 'searching', searchTotal: target, searchFound: 0, total: 0, scanned: 0,
    });

    // 每个关键词找到多少条，用于 UI 判断单关键词池是否不足
    const kwCounts = new Map(keywords.map((k) => [k, 0]));
    const bumpKeyword = (keyword, n) => {
      if (!keyword) return;
      kwCounts.set(keyword, (kwCounts.get(keyword) ?? 0) + Math.max(0, Number(n) || 0));
    };
    const keywordArr = () => [...kwCounts.entries()].map(([keyword, count]) => ({ keyword, count }));

    // ★ 手机签名搜索（推荐）：网页搜索对金融/汽车类关键词会返回空，
    //   手机视口搜索页能正常出结果。
    let mobileOk = false;
    try {
      const cookies = (() => {
        try { return sdk?.account?.im?.client?.getCookies?.() || ''; } catch { return ''; }
      })();
      const mobile = await collectMobileSearchVideos({
        cookies,
        keywords,
        target,
        maxPagesPerKeyword: 12,
        count: 20,
        intervalMs: 800,
        proxyUrl: getAccountProxyUrl(accountId),
        requestWrapper: (fn) => call(fn),
        onProgress: (p) => {
          bumpKeyword(p.keyword, p.added);
          saveHarvestProgress(task.id, {
            phase: 'searching', searchTotal: target, searchFound: p.total,
            keywords: keywordArr(),
          });
          if (p.page === 1) {
            warnings.push(`手机搜索「${p.keyword}」开始，已发现 ${p.total} 条视频`);
          }
        },
      });
      // 请求已由 call() 内的账号级闸门计数
      if (mobile.videos.length) {
        found.push(...mobile.videos);
        mobileOk = true;
        // 以实际返回结果为准回填每个关键词的条数（覆盖进度里的临时计数）
        for (const k of keywords) kwCounts.set(k, 0);
        for (const v of mobile.videos) bumpKeyword(v.keyword, 1);
        warnings.push(`手机搜索发现 ${mobile.videos.length} 条视频`);
      }
    } catch (e) {
      warnings.push(`手机搜索失败：${e.message}`);
    }
    if (isHarvestCancelled(task.id)) throw new Error('任务已删除，采集已取消');

    // 手机搜索不可用时，降级到网页接口（普通关键词仍可能可用）
    if (!mobileOk) {
      const pagesPerKw = Math.min(
        15,
        Math.max(1, Math.ceil((target * 1.3) / Math.max(1, keywords.length) / 8)),
      );
      let stopped = false;
      for (const kw of keywords) {
        if (stopped) break;
        if (isHarvestCancelled(task.id)) throw new Error('任务已删除，采集已取消');
        let offset = 0;
        for (let i = 0; i < pagesPerKw; i++) {
          if (isHarvestCancelled(task.id)) throw new Error('任务已删除，采集已取消');
          let page;
          try {
            page = await call(() => web.searchVideos(kw, { offset, count: 10 }));
          } catch (e) {
            if (e.code === 'quota') {
              warnings.push(e.message + '，未能继续搜索');
              stopped = true;
              break;
            }
            warnings.push(`关键词「${kw}」搜索失败：${e.message}`);
            break;
          }
          for (const v of page.videos) found.push({ ...v, keyword: kw });
          bumpKeyword(kw, page.videos.length);
          saveHarvestProgress(task.id, {
            phase: 'searching', searchTotal: target, searchFound: found.length,
            keywords: keywordArr(),
          });
          if (!page.hasMore) break;
          offset = page.nextOffset;
        }
      }
    }

    videos = pickVideosByKeyword(found, target);
    if (isHarvestCancelled(task.id)) throw new Error('任务已删除，采集已取消');
    if (!videos.length) {
      if (warnings.length) {
        throw new Error('没有搜到视频：' + warnings.join('；'));
      }
      throw new Error('没有搜到视频，换个关键词试试');
    }
    const uniqCount = new Set(
      found.map((v) => String(v.awemeId ?? v.id ?? '')).filter(Boolean),
    ).size;
    saveHarvestProgress(task.id, {
      phase: deferComments ? 'monitoring' : 'scanning',
      total: videos.length, scanned: 0,
      searchTotal: target, searchFound: uniqCount,
      keywords: keywordArr(),
    });
    warnings.push(`共发现 ${uniqCount} 条视频，取 ${videos.length} 条`);
  }

  // ── 先取完视频，再交给监控扫评论（UI 的新逻辑）──
  if (deferComments) {
    if (isHarvestCancelled(task.id)) throw new Error('任务已删除，采集已取消');
    const videoStats = videos.map((v) => ({
      awemeId: v.awemeId ?? v.id,
      keyword: v.keyword ?? null,
      desc: v.desc ?? null,
      commentCount: v.commentCount ?? null,
      fetched: 0,
      kept: 0,
    }));

    updateTaskAfterHarvest(task.id);
    try {
      db_().prepare(
        'UPDATE outreach_task SET harvest_summary = ?, harvest_error = NULL, harvest_phase = ? WHERE id = ?',
      ).run(JSON.stringify({
        added: 0,
        duplicates: 0,
        contactedBefore: 0,
        truncated: 0,
        requests,
        videos: videos.length,
        scanned: 0,
        warnings,
        deferredComments: true,
      }), 'monitoring', task.id);
    } catch {}

    return {
      ok: true,
      mode: task.target_mode,
      total: 0,
      added: 0,
      duplicates: 0,
      contactedBefore: 0,
      truncated: 0,
      invalid: [],
      requests,
      videos: videoStats,
      scannedVideos: 0,
      unscanned: videos.length,
      warnings,
      stage: 'reviewing',
      usage: throttle.usage(accountId),
    };
  }

  // ── 首次扫描：只扫最新的一批，其余交给持续监控 ──
  const scanCount = Math.min(cfg.initialScanVideos ?? 10, videos.length);
  const scanList = videos.slice(0, scanCount);
  const scannedStats = [];
  let quotaHit = false;

  // 进度：先把总数写库，UI 立刻能看到「0/N」
  saveHarvestProgress(task.id, { total: videos.length, scanned: 0 });

  let addedTotal = 0;
  let dupTotal = 0;
  let contactedTotal = 0;
  let truncatedTotal = 0;
  let leadsTotal = 0;
  let skippedAged = 0;
  const maxAgeMs = cfg.maxCommentAgeDays > 0 ? cfg.maxCommentAgeDays * 86_400_000 : 0;
  const ageCutoff = maxAgeMs ? Date.now() - maxAgeMs : 0;

  for (let vi = 0; vi < scanList.length; vi++) {
    const v = scanList[vi];
    if (quotaHit) break;
    if (isHarvestCancelled(task.id)) throw new Error('任务已删除，采集已取消');
    const awemeId = v.awemeId ?? v.id;
    let cursor = 0;
    let fetched = 0;
    let kept = 0;
    const videoLeads = [];
    const maxPages = cfg.maxPagesPerVideo > 0 ? cfg.maxPagesPerVideo : Infinity;

    for (let page = 0; page < maxPages; page++) {
      if (isHarvestCancelled(task.id)) throw new Error('任务已删除，采集已取消');
      let r;
      try {
        r = await call(() => web.fetchComments(awemeId, { cursor, count: 20 }));
      } catch (e) {
        if (e.code === 'quota') {
          warnings.push(e.message + '，已停止采集');
          quotaHit = true;
          break;
        }
        warnings.push(`视频 ${awemeId} 采集失败：${e.message}`);
        break;
      }

      fetched += r.comments.length;
      for (const c of r.comments) {
        if (v.authorUid && c.uid === v.authorUid) continue;
        if (!c.text || c.text.length < 2) continue;
        // 只要最近 N 天的评论
        if (ageCutoff && c.createTime && c.createTime * 1000 < ageCutoff) {
          skippedAged++;
          continue;
        }
        videoLeads.push({
          uid: c.uid,
          nickname: c.nickname,
          comment: c.text.slice(0, 300),
          videoId: awemeId,
          videoTitle: v.desc ? String(v.desc).slice(0, 120) : null,
          keyword: v.keyword ?? null,
          sourceCid: c.cid ?? null,
          commentType: 'root',
          parentCid: null,
          diggCount: c.diggCount,
          commentAt: c.createTime ? c.createTime * 1000 : null,
        });
        kept++;
      }

      if (!r.hasMore) break;
      cursor = r.nextCursor;
    }

    scannedStats.push({
      awemeId, keyword: v.keyword ?? null, desc: v.desc ?? null,
      commentCount: v.commentCount ?? null, fetched, kept,
    });

    // ★ 逐视频入库：用户能在审核页看到线索一条条长出来
    if (videoLeads.length && isHarvestCancelled(task.id)) {
      throw new Error('任务已删除，采集已取消');
    }
    if (videoLeads.length) {
      const remain = cfg.maxLeadsPerTask > 0
        ? Math.max(0, cfg.maxLeadsPerTask - addedTotal)
        : 0;
      if (cfg.maxLeadsPerTask > 0 && remain === 0) {
        truncatedTotal += videoLeads.length;
      } else {
        const ins = insertLeads(task.id, accountIds, videoLeads, {
          ...cfg,
          maxLeadsPerTask: cfg.maxLeadsPerTask > 0 ? remain : 0,
        });
        addedTotal += ins.added;
        dupTotal += ins.duplicates;
        contactedTotal += ins.contactedBefore;
        truncatedTotal += ins.truncated;
        leadsTotal += videoLeads.length;
      }
    }

    saveHarvestProgress(task.id, {
      total: videos.length,
      scanned: vi + 1,
      added: addedTotal,
    });
  }

  // 返回给 UI 的视频列表要包含"没扫但已入库监控"的那些
  const statMap = new Map(scannedStats.map((x) => [x.awemeId, x]));
  const videoStats = videos.map((v) => {
    const id = v.awemeId ?? v.id;
    return statMap.get(id) ?? {
      awemeId: id,
      keyword: v.keyword ?? null,
      desc: v.desc ?? null,
      commentCount: v.commentCount ?? null,
      fetched: 0,
      kept: 0,
    };
  });

  if (skippedAged) {
    warnings.push(`跳过 ${skippedAged} 条超过 ${cfg.maxCommentAgeDays} 天的评论`);
  }

  if (!leadsTotal) {
    // 配额中断属于失败：任务标 failed，UI 上可以「重采」
    if (quotaHit) {
      const e = new Error('采集被配额中断：' + warnings.join('；'));
      e.details = { warnings, requests, videos: videoStats, quota: true };
      throw e;
    }
    if (!videos.length) {
      if (warnings.length) {
        const e = new Error('没有采集到可用线索：' + warnings.join('；'));
        e.details = { warnings, requests, videos: videoStats };
        throw e;
      }
      throw new Error('没有采集到可用线索');
    }
    // 视频找到了但暂时没评论：仍然算成功，交给监控继续观察
    warnings.push('这批视频暂时没有可采集的评论，已保留给监控继续观察');
  }

  // ── 收尾：更新任务计数与摘要 ──
  updateTaskAfterHarvest(task.id);
  try {
    db_().prepare("UPDATE outreach_task SET harvest_summary = ?, harvest_error = NULL, harvest_phase = 'done' WHERE id = ?")
      .run(JSON.stringify({
        added: addedTotal,
        duplicates: dupTotal,
        contactedBefore: contactedTotal,
        truncated: truncatedTotal,
        requests,
        videos: videos.length,
        scanned: scanCount,
        skippedAged,
        warnings,
      }), task.id);
  } catch {}

  return {
    ok: true,
    mode: task.target_mode,
    total: leadsTotal,
    added: addedTotal,
    duplicates: dupTotal,
    contactedBefore: contactedTotal,
    truncated: truncatedTotal,
    invalid: [],
    requests,
    videos: videoStats,
    scannedVideos: scanCount,
    unscanned: Math.max(0, videos.length - scanCount),
    warnings,
    stage: 'reviewing',
    usage: throttle.usage(accountId),
  };
}

/**
 * 线索入库（去重 + 标记联系过）
 *
 * ★ 去重三层：
 *   1. 同一次采集里 uid 重复
 *   2. 同一任务里已经存在
 *   3. dm_history 里该账号组联系过（跨任务）
 */
/** 更新采集进度（后台采集时 UI 轮询读取） */
export function saveHarvestProgress(taskId, {
  total, scanned, added, stage = 'harvesting',
  phase, searchTotal, searchFound, keywords,
} = {}) {
  try {
    const sets = [];
    const args = [];
    if (scanned !== undefined && scanned !== null) { sets.push('harvest_scanned = ?'); args.push(scanned); }
    if (stage !== undefined) { sets.push('stage = ?'); args.push(stage); }
    if (total !== undefined && total !== null) { sets.push('harvest_total = ?'); args.push(total); }
    if (phase !== undefined && phase !== null) { sets.push('harvest_phase = ?'); args.push(phase); }
    if (searchTotal !== undefined && searchTotal !== null) { sets.push('search_total = ?'); args.push(searchTotal); }
    if (searchFound !== undefined && searchFound !== null) { sets.push('search_found = ?'); args.push(searchFound); }
    if (keywords !== undefined && keywords !== null) {
      sets.push('search_keywords = ?');
      args.push(JSON.stringify(keywords));
    }
    if (added !== undefined && added !== null) {
      sets.push('target_count = (SELECT COUNT(*) FROM outreach_item WHERE task_id = ?)');
      args.push(taskId);
    }
    if (!sets.length) return;
    args.push(taskId);
    db_().prepare(`UPDATE outreach_task SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  } catch (e) {
    console.error('[harvest] 更新进度失败', e.message);
  }
}

export function updateHarvestSummary(taskId, patch) {
  try {
    const row = db_().prepare('SELECT harvest_summary FROM outreach_task WHERE id = ?').get(taskId);
    let cur = {};
    try { cur = row?.harvest_summary ? JSON.parse(row.harvest_summary) : {}; } catch {}
    const next = { ...cur, ...patch };
    db_().prepare('UPDATE outreach_task SET harvest_summary = ? WHERE id = ?')
      .run(JSON.stringify(next), taskId);
  } catch (e) {
    console.error('[harvest] 更新摘要失败', e.message);
  }
}

export function markHarvestFailed(taskId, message) {
  try {
    db_().prepare("UPDATE outreach_task SET stage = 'failed', harvest_phase = 'failed', harvest_error = ? WHERE id = ?")
      .run(String(message ?? '').slice(0, 500), taskId);
  } catch {}
}

export function addLeadsToTask(taskId, accountIds, leads, cfg = getHarvestConfig()) {
  return insertLeads(taskId, accountIds, leads, cfg);
}

function insertLeads(taskId, accountIds, leads, cfg) {
  const existsStmt = db_().prepare(
    'SELECT id, status, comment_at, peer_sec_uid FROM outreach_item WHERE task_id = ? AND peer_uid = ?',
  );

  const accs = (accountIds ?? []).filter(Boolean);
  const historyStmt = accs.length
    ? db_().prepare(
        `SELECT 1 FROM dm_history WHERE peer_uid = ? AND account_id IN (${accs.map(() => '?').join(',')}) LIMIT 1`,
      )
    : null;

  const insert = db_().prepare(
    `INSERT INTO outreach_item
       (id, task_id, account_id, peer_uid, peer_sec_uid, peer_nickname,
        source_video, source_video_title, source_comment, source_keyword,
        source_cid, comment_type, parent_cid,
        comment_likes, comment_at, status, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  );

  const updateLatest = db_().prepare(
    `UPDATE outreach_item
        SET peer_nickname = ?, source_video = ?, source_comment = ?,
            source_keyword = ?, source_cid = ?, comment_type = ?,
            parent_cid = ?, comment_likes = ?, comment_at = ?,
            peer_sec_uid = COALESCE(?, peer_sec_uid)
      WHERE id = ?`,
  );
  const updateSecUid = db_().prepare(
    'UPDATE outreach_item SET peer_sec_uid = ? WHERE id = ? AND (peer_sec_uid IS NULL OR peer_sec_uid = ?)',
  );
  const insertHistory = db_().prepare(
    `INSERT OR IGNORE INTO outreach_comment_history
       (id, task_id, item_id, peer_uid, source_video, source_video_title, source_comment,
        source_keyword, source_cid, comment_type, parent_cid, comment_likes, comment_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const recordHistory = (itemId, lead) => {
    if (!lead.sourceCid) return;
    try {
      insertHistory.run(
        randomUUID(), taskId, itemId, String(lead.uid),
        lead.videoId ?? null, lead.videoTitle ?? null, lead.comment ?? null,
        lead.keyword ?? null, String(lead.sourceCid), lead.commentType ?? 'root',
        lead.parentCid ?? null, lead.diggCount ?? 0, lead.commentAt ?? null, Date.now(),
      );
    } catch {}
  };

  // 同一用户本轮有多条评论时只保留最新一条
  const seen = new Map();
  let duplicates = 0;
  for (const lead of leads) {
    if (!lead.uid) { duplicates++; continue; }
    const uid = String(lead.uid);
    const prev = seen.get(uid);
    if (!prev) {
      seen.set(uid, lead);
    } else if ((Number(lead.commentAt) || 0) > (Number(prev.commentAt) || 0)) {
      seen.set(uid, lead);
      duplicates++;
    } else {
      duplicates++;
    }
  }

  let added = 0;
  let updated = 0;
  let contactedBefore = 0;
  let truncated = 0;

  for (const lead of seen.values()) {
    const uid = String(lead.uid);
    const existed = existsStmt.get(taskId, uid);
    if (existed) {
      // 老线索没有 sec_uid 时，用本轮评论补上（用于在线状态）
      if (!existed.peer_sec_uid && lead.secUid) {
        updateSecUid.run(String(lead.secUid), existed.id, '');
      }
      // 同一个人已经在待审核里：用更新的评论覆盖旧评论，不新增一行
      if (existed.status === 'pending'
          && (Number(lead.commentAt) || 0) > (Number(existed.comment_at) || 0)) {
        updateLatest.run(
          lead.nickname ?? null,
          lead.videoId ?? null,
          lead.comment ?? null,
          lead.keyword ?? null,
          lead.sourceCid ?? null,
          lead.commentType ?? 'root',
          lead.parentCid ?? null,
          lead.diggCount ?? 0,
          lead.commentAt ?? null,
          lead.secUid ?? null,
          existed.id,
        );
        recordHistory(existed.id, lead);
        updated++;
      } else {
        duplicates++;
      }
      continue;
    }

    if (cfg.maxLeadsPerTask > 0 && added >= cfg.maxLeadsPerTask) { truncated++; continue; }

    const contacted = historyStmt
      ? !!historyStmt.get(uid, ...accs)
      : false;
    if (contacted) contactedBefore++;

    const itemId = randomUUID();
    insert.run(
      itemId,
      taskId,
      accs[0] ?? null,
      uid,
      lead.secUid ?? null,
      lead.nickname ?? null,
      lead.videoId ?? null,
      lead.videoTitle ?? null,
      lead.comment ?? null,
      lead.keyword ?? null,
      lead.sourceCid ?? null,
      lead.commentType ?? 'root',
      lead.parentCid ?? null,
      lead.diggCount ?? 0,
      lead.commentAt ?? null,
      contacted ? 'contacted_before' : null,
    );
    recordHistory(itemId, lead);
    added++;
  }

  return { added, updated, duplicates, contactedBefore, truncated };
}

function updateTaskAfterHarvest(taskId) {
  db_()
    .prepare(
      `UPDATE outreach_task SET stage = 'reviewing',
         target_count = (SELECT COUNT(*) FROM outreach_item WHERE task_id = ?)
       WHERE id = ?`,
    )
    .run(taskId, taskId);
}

/**
 * 审核结果查询
 */
export function listInterceptTargets(taskId, {
  status,
  keyword,
  limit = 0,
  offset = 0,
  all = false,
  since = 0,
} = {}) {
  const where = ['task_id = ?'];
  const args = [taskId];
  if (status) {
    where.push('status = ?');
    args.push(status);
  }
  if (keyword) {
    where.push('source_keyword = ?');
    args.push(String(keyword));
  }
  if (Number(since) > 0) {
    where.push('comment_at >= ?');
    args.push(Number(since));
  }
  const whereSql = where.join(' AND ');
  const total = db_()
    .prepare(`SELECT COUNT(*) c FROM outreach_item WHERE ${whereSql}`)
    .get(...args).c;

  // limit<=0 或 all=true 时返回全部（导出用）；普通列表最多 500 条/页
  const take = all ? 0 : Math.min(500, Math.max(0, Math.round(Number(limit) || 0)));
  const skip = Math.max(0, Math.round(Number(offset) || 0));
  let sql =
    `SELECT * FROM outreach_item WHERE ${whereSql}
     ORDER BY comment_at DESC, rowid DESC`;
  const pageArgs = args.slice();
  if (take > 0) {
    sql += ' LIMIT ? OFFSET ?';
    pageArgs.push(take, skip);
  }

  const items = db_()
    .prepare(sql)
    .all(...pageArgs)
    .map((r) => ({
      id: r.id,
      uid: r.peer_uid,
      name: r.peer_nickname,
      status: r.status,
      reason: r.reason,
      sourceVideo: r.source_video,
      sourceVideoTitle: r.source_video_title,
      sourceComment: r.source_comment,
      sourceKeyword: r.source_keyword,
      sourceCid: r.source_cid ?? null,
      commentType: r.comment_type ?? 'root',
      parentCid: r.parent_cid ?? null,
      commentLikes: r.comment_likes ?? 0,
      commentAt: r.comment_at ?? null,
      secUid: r.peer_sec_uid ?? null,
      lastActiveAt: r.last_active_at ?? null,
      online: r.online ?? null,
      presenceCheckedAt: r.presence_checked_at ?? null,
    }));

  return { items, total };
}

/**
 * 批量审核
 * @param {string[]} ids 要批准的 item id
 * @param {'approved'|'excluded'} action
 */
export function reviewTargets(taskId, ids, action) {
  if (!['approved', 'excluded'].includes(action)) throw new Error('无效的审核动作');
  const stmt = db_().prepare(
    'UPDATE outreach_item SET status = ? WHERE task_id = ? AND id = ?',
  );
  let n = 0;
  for (const id of ids ?? []) {
    stmt.run(action, taskId, id);
    n++;
  }

  const approved = db_()
    .prepare("SELECT COUNT(*) c FROM outreach_item WHERE task_id = ? AND status = 'approved'")
    .get(taskId).c;

  db_()
    .prepare("UPDATE outreach_task SET stage = ? WHERE id = ?")
    .run(approved > 0 ? 'ready' : 'reviewing', taskId);

  return { ok: true, changed: n, approved };
}

/** 一键审核：把当前任务所有待审核线索标记为已批准 */
export function approveAllPending(taskId) {
  const db = db_();
  const pending = db
    .prepare("SELECT COUNT(*) c FROM outreach_item WHERE task_id = ? AND status = 'pending'")
    .get(taskId).c;
  db
    .prepare("UPDATE outreach_item SET status = 'approved' WHERE task_id = ? AND status = 'pending'")
    .run(taskId);
  const approved = db
    .prepare("SELECT COUNT(*) c FROM outreach_item WHERE task_id = ? AND status = 'approved'")
    .get(taskId).c;
  db
    .prepare("UPDATE outreach_task SET stage = ? WHERE id = ?")
    .run(approved > 0 ? 'ready' : 'reviewing', taskId);
  return { ok: true, changed: Number(pending) || 0, approved };
}

/**
 * 待发送列表（只有 approved 的）
 */
export function listApprovedTargets(taskId) {
  return db_()
    .prepare("SELECT * FROM outreach_item WHERE task_id = ? AND status = 'approved' ORDER BY rowid")
    .all(taskId)
    .map((r) => ({ uid: r.peer_uid, name: r.peer_nickname, itemId: r.id }));
}

/**
 * 标记已发送
 */
export function markTargetSent(itemId, { serverMessageId, status, reason }) {
  db_().prepare(
    'UPDATE outreach_item SET status = ?, reason = ?, server_msg_id = ?, sent_at = ? WHERE id = ?',
  ).run(status, reason ?? null, serverMessageId ?? null, Date.now(), itemId);
}

/**
 * 任务详情（含统计）
 */
export function getInterceptTask(taskId) {
  const task = db_().prepare("SELECT * FROM outreach_task WHERE id = ? AND kind = 'intercept'").get(taskId);
  if (!task) return null;

  const counts = db_()
    .prepare(
      `SELECT status, COUNT(*) c FROM outreach_item WHERE task_id = ? GROUP BY status`,
    )
    .all(taskId);
  const stat = {};
  for (const x of counts) stat[x.status] = x.c;

  let competitorCount = 0;
  let competitorNames = [];
  let competitorIds = [];
  try {
    competitorIds = db_()
      .prepare('SELECT competitor_id FROM outreach_task_competitor WHERE task_id = ?')
      .all(task.id).map((x) => x.competitor_id);
    competitorCount = competitorIds.length;
    competitorNames = db_()
      .prepare(
        `SELECT c.nickname FROM outreach_task_competitor t
           JOIN competitor c ON c.id = t.competitor_id
          WHERE t.task_id = ? LIMIT 20`,
      )
      .all(task.id).map((x) => x.nickname).filter(Boolean);
  } catch {}

  return {
    id: task.id,
    name: task.name,
    competitorCount,
    competitorNames,
    competitorIds,
    stage: task.stage,
    accountIds: JSON.parse(task.account_ids || '[]'),
    targetMode: task.target_mode,
    targetRaw: task.target_raw,
    targetCount: task.target_count,
    total: Object.values(stat).reduce((a, b) => a + b, 0),
    pending: stat.pending ?? 0,
    approved: stat.approved ?? 0,
    excluded: stat.excluded ?? 0,
    sent: stat.sent ?? 0,
    failed: stat.failed ?? 0,
    skipped: stat.skipped ?? 0,
    contentItems: (() => {
      try {
        const list = JSON.parse(task.content_items || '[]');
        return Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x.trim()) : [];
      } catch {
        return [];
      }
    })(),
    contentStrategy: task.content_strategy === 'sequence' ? 'sequence' : 'random',
    createdAt: task.created_at,
    startedAt: task.started_at,
    finishedAt: task.finished_at,
    harvest: {
      total: task.harvest_total ?? 0,
      scanned: task.harvest_scanned ?? 0,
      phase: task.harvest_phase ?? '',
      searchTotal: task.search_total ?? 0,
      searchFound: task.search_found ?? 0,
      keywords: (() => {
        try { return JSON.parse(task.search_keywords || '[]'); } catch { return []; }
      })(),
      error: task.harvest_error ?? null,
      summary: (() => {
        try { return task.harvest_summary ? JSON.parse(task.harvest_summary) : null; } catch { return null; }
      })(),
    },
    params: {
      dailyLimit: task.daily_limit,
      hourlyLimit: task.hourly_limit,
      batchSize: task.batch_size,
      roundWaitSec: task.round_wait_sec,
    },
  };
}

/** 任务线索里实际出现的来源关键词（比搜索词表更准确，兼容视频任务） */
export function listTaskKeywords(taskId) {
  return db_()
    .prepare(
      `SELECT source_keyword AS keyword, COUNT(*) AS count
         FROM outreach_item
        WHERE task_id = ? AND source_keyword IS NOT NULL AND source_keyword <> ''
        GROUP BY source_keyword
        ORDER BY count DESC, keyword ASC`,
    )
    .all(taskId);
}

export function listInterceptTasks() {
  return db_()
    .prepare("SELECT id FROM outreach_task WHERE kind = 'intercept' ORDER BY created_at DESC LIMIT 100")
    .all()
    .map((r) => getInterceptTask(r.id))
    .filter(Boolean);
}

/**
 * 删除任务
 */
export function deleteInterceptTask(taskId) {
  db_().prepare('DELETE FROM outreach_item WHERE task_id = ?').run(taskId);
  db_().prepare('DELETE FROM outreach_comment_history WHERE task_id = ?').run(taskId);
  db_().prepare('DELETE FROM monitor_comment WHERE task_id = ?').run(taskId);
  try { db_().prepare('DELETE FROM outreach_task_competitor WHERE task_id = ?').run(taskId); } catch {}
  db_().prepare("DELETE FROM outreach_task WHERE id = ? AND kind = 'intercept'").run(taskId);
  return { ok: true };
}

/**
 * 构造发送任务（给 sender 用）
 *
 * @param {object} [overrides] 仅演练模式允许覆盖节流参数（测试用）
 */
export function buildSendPayload(taskId, accounts, overrides = {}, targetIds = null) {
  const task = getInterceptTask(taskId);
  if (!task) throw new Error('任务不存在');

  let targets = listApprovedTargets(taskId);
  if (Array.isArray(targetIds)) {
    const wanted = new Set(targetIds.map(String));
    targets = targets.filter((t) => wanted.has(String(t.itemId)));
  }
  if (!targets.length) throw new Error('没有已审核通过的目标');

  const accs = accounts;
  if (!accs.length) throw new Error('没有有效的参与账号');

  const safe = process.env.DRY_RUN === '1' ? overrides : {};

  // 真实发送允许调用方把间隔调慢（低频陌生人私信），但保留 5 秒安全下限；
  // 演练模式仍然可以完全覆盖，方便测试。
  const reqGapMin = Number(overrides?.gapMinSec);
  const reqGapMax = Number(overrides?.gapMaxSec);
  const gapMinSec = Number.isFinite(reqGapMin) && reqGapMin > 0
    ? Math.max(5, reqGapMin)
    : SAFE_GAP.min;
  const gapMaxSec = Number.isFinite(reqGapMax) && reqGapMax > 0
    ? Math.max(gapMinSec, reqGapMax)
    : Math.max(gapMinSec, SAFE_GAP.max);

  // 轮换粒度也允许调用方指定（例如 batchSize=1 严格交替账号）
  const reqBatch = Number(overrides?.batchSize);
  const batchSize = Number.isFinite(reqBatch) && reqBatch > 0
    ? Math.max(1, Math.floor(reqBatch))
    : task.params.batchSize;
  const reqRoundWait = Number(overrides?.roundWaitSec);
  const roundWaitSec = Number.isFinite(reqRoundWait) && reqRoundWait >= 0
    ? Math.floor(reqRoundWait)
    : task.params.roundWaitSec;

  return {
    kind: 'intercept',
    name: task.name,
    accounts: accs,
    targets: targets.map((t) => ({ uid: t.uid, name: t.name, itemId: t.itemId })),
    throttle: {
      gapMinSec,
      gapMaxSec,
      hourlyLimit: task.params.hourlyLimit,
      dailyLimit: task.params.dailyLimit,
      batchSize,
      roundWaitSec,
      ...safe,
    },
  };
}
