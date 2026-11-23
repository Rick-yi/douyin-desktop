/**
 * 同行监控服务
 *
 * 职责：
 *   1. 按关键词批量搜索同行主页
 *   2. 判断同行最近作品时间/活跃度
 *   3. 拉取同行全部作品（无数量上限）
 *   4. 维护同行/视频资产库
 *   5. 同行默认全视频监控，并同步到引用它的线索任务
 *
 * 评论扫描不在这里做，由线索雷达消费同行视频。
 */
import { randomUUID } from 'node:crypto';
import { db_ } from './db.js';
import { getAccountProxyUrl } from './proxy-service.js';
import { getAccountRequestGate, HarvestError } from './harvest-service.js';
import { createInterceptTask } from './intercept-service.js';
import { CompetitorBrowser } from './competitor-browser-service.js';
import { createMonitor } from './monitor-service.js';

const DAY = 86400000;
export const ACTIVE_DAYS = 7;
export const NORMAL_DAYS = 30;

const cancelledJobs = new Set();

function nowMs() { return Date.now(); }

function activeLevelOf(latestVideoAt, now = Date.now()) {
  if (!latestVideoAt) return 'unknown';
  const age = now - Number(latestVideoAt);
  if (age <= ACTIVE_DAYS * DAY) return 'active';
  if (age <= NORMAL_DAYS * DAY) return 'normal';
  return 'inactive';
}

export function listCompetitors({
  keyword, active, monitor, q, limit = 50, offset = 0,
} = {}) {
  const where = [];
  const args = [];
  if (keyword) {
    where.push('EXISTS (SELECT 1 FROM competitor_keyword ck WHERE ck.competitor_id = c.id AND ck.keyword = ?)');
    args.push(keyword);
  }
  if (active) {
    where.push('c.active_level = ?');
    args.push(active);
  } else {
    // 默认只展示活跃/一般同行；不活跃和无作品的不进入采集结果
    where.push("c.active_level IN ('active', 'normal')");
  }
  if (monitor === true || monitor === 1) where.push('c.monitor_enabled = 1');
  if (monitor === false || monitor === 0) where.push('c.monitor_enabled = 0');
  if (q) {
    where.push('(c.nickname LIKE ? OR c.uid LIKE ? OR c.sec_uid LIKE ?)');
    const like = `%${q}%`;
    args.push(like, like, like);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const take = Math.min(2000, Math.max(1, Number(limit) || 50));
  const skip = Math.max(0, Number(offset) || 0);
  const total = db_().prepare(`SELECT COUNT(*) c FROM competitor c ${w}`).get(...args).c;
  const rows = db_().prepare(
    `SELECT c.*,
       (SELECT GROUP_CONCAT(keyword, ' / ') FROM competitor_keyword ck WHERE ck.competitor_id = c.id) AS keywords,
       (SELECT COUNT(*) FROM outreach_task_competitor t WHERE t.competitor_id = c.id) AS linked_tasks,
       (SELECT COUNT(*) FROM competitor_video v WHERE v.competitor_id = c.id) AS stored_videos
     FROM competitor c ${w}
     ORDER BY c.updated_at DESC, c.created_at DESC
     LIMIT ? OFFSET ?`,
  ).all(...args, take, skip);
  return { rows: rows.map(rowToCompetitor), total };
}

export function getCompetitor(id) {
  const r = db_().prepare(
    `SELECT c.*,
       (SELECT GROUP_CONCAT(keyword, ' / ') FROM competitor_keyword ck WHERE ck.competitor_id = c.id) AS keywords,
       (SELECT COUNT(*) FROM outreach_task_competitor t WHERE t.competitor_id = c.id) AS linked_tasks,
       (SELECT COUNT(*) FROM competitor_video v WHERE v.competitor_id = c.id) AS stored_videos
     FROM competitor c WHERE c.id = ?`,
  ).get(id);
  return r ? rowToCompetitor(r) : null;
}

function rowToCompetitor(r) {
  return {
    id: r.id,
    secUid: r.sec_uid,
    uid: r.uid,
    nickname: r.nickname,
    avatarUrl: r.avatar_url,
    keywords: r.keywords || '',
    latestVideoAt: r.latest_video_at,
    activeLevel: r.active_level || 'unknown',
    videoCount: r.stored_videos ?? r.video_count ?? 0,
    monitorEnabled: r.monitor_enabled !== 0,
    videoScope: r.video_scope || 'all',
    linkedTasks: r.linked_tasks || 0,
    lastSyncedAt: r.last_synced_at,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listCompetitorVideos({
  competitorId, keyword, q, from, to, monitor, excluded, limit = 100, offset = 0,
} = {}) {
  const where = [];
  const args = [];
  if (competitorId) { where.push('v.competitor_id = ?'); args.push(competitorId); }
  if (keyword) {
    where.push('EXISTS (SELECT 1 FROM competitor_keyword ck WHERE ck.competitor_id = v.competitor_id AND ck.keyword = ?)');
    args.push(keyword);
  }
  if (q) { where.push('v.title LIKE ?'); args.push(`%${q}%`); }
  if (Number(from) > 0) { where.push('v.create_time >= ?'); args.push(Number(from)); }
  if (Number(to) > 0) { where.push('v.create_time <= ?'); args.push(Number(to)); }
  if (monitor === true || monitor === 1) where.push('v.monitor_enabled = 1 AND v.excluded = 0');
  if (monitor === false || monitor === 0) where.push('(v.monitor_enabled = 0 OR v.excluded = 1)');
  if (excluded === true || excluded === 1) where.push('v.excluded = 1');
  if (excluded === false || excluded === 0) where.push('v.excluded = 0');
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const take = Math.min(1000, Math.max(1, Number(limit) || 100));
  const skip = Math.max(0, Number(offset) || 0);
  const total = db_().prepare(`SELECT COUNT(*) c FROM competitor_video v ${w}`).get(...args).c;
  const rows = db_().prepare(
    `SELECT v.*, c.nickname AS competitor_name, c.sec_uid AS competitor_sec_uid
       FROM competitor_video v
       JOIN competitor c ON c.id = v.competitor_id
       ${w}
      ORDER BY v.create_time DESC, v.aweme_id DESC
      LIMIT ? OFFSET ?`,
  ).all(...args, take, skip);
  return {
    total,
    rows: rows.map((r) => ({
      awemeId: r.aweme_id,
      competitorId: r.competitor_id,
      competitorName: r.competitor_name,
      competitorSecUid: r.competitor_sec_uid,
      title: r.title,
      coverUrl: r.cover_url,
      createTime: r.create_time,
      diggCount: r.digg_count,
      commentCount: r.comment_count,
      shareCount: r.share_count,
      shareUrl: r.share_url,
      monitorEnabled: r.monitor_enabled !== 0 && r.excluded !== 1,
      excluded: r.excluded !== 0,
      unavailable: r.unavailable !== 0,
    })),
  };
}

export function excludeCompetitorVideo(awemeId, excluded = true) {
  const db = db_();
  const row = db.prepare('SELECT competitor_id FROM competitor_video WHERE aweme_id = ?').get(awemeId);
  if (!row) throw new Error('视频不存在');
  db.prepare('UPDATE competitor_video SET excluded = ?, monitor_enabled = ? WHERE aweme_id = ?')
    .run(excluded ? 1 : 0, excluded ? 0 : 1, awemeId);

  // 默认全视频监控：排除/恢复时同步到引用该同行的所有监控
  const monitors = db.prepare(
    `SELECT m.task_id, m.videos AS watch
       FROM outreach_task_competitor t
       JOIN monitor m ON m.task_id = t.task_id
      WHERE t.competitor_id = ?`,
  ).all(row.competitor_id);
  for (const m of monitors) {
    let watch = [];
    try { watch = JSON.parse(m.watch || '[]'); } catch {}
    if (!Array.isArray(watch)) watch = [];
    if (excluded) {
      watch = watch.filter((v) => String(v.awemeId) !== String(awemeId));
    } else if (!watch.some((v) => String(v.awemeId) === String(awemeId))) {
      const v = db.prepare('SELECT * FROM competitor_video WHERE aweme_id = ?').get(awemeId);
      if (v) {
        watch.push({
          awemeId: String(v.aweme_id),
          desc: v.title ?? null,
          commentCount: v.comment_count ?? 0,
          keyword: null,
          addedAt: nowMs(),
          lastScanAt: null,
        });
      }
    }
    db.prepare('UPDATE monitor SET videos = ? WHERE task_id = ?').run(JSON.stringify(watch), m.task_id);
  }
  return { ok: true };
}

export function listCompetitorKeywords() {
  return db_().prepare(
    'SELECT keyword, COUNT(*) c FROM competitor_keyword GROUP BY keyword ORDER BY c DESC, keyword ASC',
  ).all().map((r) => ({ keyword: r.keyword, count: r.c }));
}

export function competitorStats() {
  const db = db_();
  const active = db.prepare("SELECT COUNT(*) c FROM competitor WHERE active_level = 'active'").get().c;
  const normal = db.prepare("SELECT COUNT(*) c FROM competitor WHERE active_level = 'normal'").get().c;
  const total = active + normal;
  const inactive = db.prepare("SELECT COUNT(*) c FROM competitor WHERE active_level = 'inactive'").get().c;
  const videos = db.prepare("SELECT COUNT(*) c FROM competitor_video v JOIN competitor c ON c.id = v.competitor_id WHERE c.active_level IN ('active','normal')").get().c;
  const monitored = db.prepare("SELECT COUNT(*) c FROM competitor_video v JOIN competitor c ON c.id = v.competitor_id WHERE c.active_level IN ('active','normal') AND v.monitor_enabled = 1 AND v.excluded = 0").get().c;
  return { total, active, normal, inactive, videos, monitored };
}

function upsertCompetitor({ secUid, uid, nickname, avatarUrl, keyword }) {
  const db = db_();
  const now = nowMs();
  let row = db.prepare('SELECT id FROM competitor WHERE sec_uid = ?').get(secUid);
  let created = false;
  if (!row) {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO competitor
         (id, sec_uid, uid, nickname, avatar_url, monitor_enabled, video_scope, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 'all', ?, ?)`,
    ).run(id, secUid, uid ?? null, nickname ?? null, avatarUrl ?? null, now, now);
    row = { id };
    created = true;
  } else {
    db.prepare(
      `UPDATE competitor SET uid = COALESCE(?, uid), nickname = COALESCE(?, nickname),
         avatar_url = COALESCE(?, avatar_url), updated_at = ? WHERE id = ?`,
    ).run(uid ?? null, nickname ?? null, avatarUrl ?? null, now, row.id);
  }
  if (keyword) {
    db.prepare(
      `INSERT OR IGNORE INTO competitor_keyword (competitor_id, keyword, created_at) VALUES (?, ?, ?)`,
    ).run(row.id, keyword, now);
  }
  return { id: row.id, created };
}

function upsertVideos(competitorId, videos) {
  const db = db_();
  const now = nowMs();
  const existing = new Set(
    db.prepare('SELECT aweme_id FROM competitor_video WHERE competitor_id = ?')
      .all(competitorId).map((r) => r.aweme_id),
  );
  const newVideos = [];
  const stmt = db.prepare(
    `INSERT INTO competitor_video
       (aweme_id, competitor_id, title, cover_url, create_time, digg_count, comment_count,
        share_count, share_url, monitor_enabled, excluded, unavailable, last_synced_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?)
     ON CONFLICT(aweme_id) DO UPDATE SET
       title = excluded.title,
       cover_url = excluded.cover_url,
       create_time = excluded.create_time,
       digg_count = excluded.digg_count,
       comment_count = excluded.comment_count,
       share_count = excluded.share_count,
       share_url = excluded.share_url,
       unavailable = 0,
       last_synced_at = excluded.last_synced_at`,
  );
  db.exec('BEGIN');
  try {
    for (const v of videos) {
      stmt.run(
        v.awemeId, competitorId, v.title ?? null, v.coverUrl ?? null,
        v.createTime ?? null, v.diggCount ?? 0, v.commentCount ?? 0,
        v.shareCount ?? 0, v.shareUrl ?? null, now, now,
      );
      if (!existing.has(v.awemeId)) newVideos.push(v);
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
  const count = db.prepare('SELECT COUNT(*) c FROM competitor_video WHERE competitor_id = ?').get(competitorId).c;
  return { newVideos, count };
}

function appendToLinkedMonitors(competitorId, videos, keyword) {
  if (!videos.length) return 0;
  const db = db_();
  const rows = db.prepare(
    `SELECT m.task_id, m.videos AS watch
       FROM outreach_task_competitor t
       JOIN monitor m ON m.task_id = t.task_id
      WHERE t.competitor_id = ?`,
  ).all(competitorId);
  let changed = 0;
  for (const r of rows) {
    let watch = [];
    try { watch = JSON.parse(r.watch || '[]'); } catch {}
    const byId = new Map((Array.isArray(watch) ? watch : []).map((v) => [String(v.awemeId), v]));
    for (const v of videos) {
      const cur = byId.get(String(v.awemeId));
      if (cur) {
        cur.commentCount = v.commentCount ?? cur.commentCount;
        continue;
      }
      byId.set(String(v.awemeId), {
        awemeId: String(v.awemeId),
        desc: v.title ?? null,
        commentCount: v.commentCount ?? 0,
        keyword: keyword || null,
        addedAt: nowMs(),
        lastScanAt: null,
      });
      changed++;
    }
    const next = [...byId.values()];
    db.prepare('UPDATE monitor SET videos = ? WHERE task_id = ?').run(JSON.stringify(next), r.task_id);
  }
  return changed;
}

function setJob(jobId, patch) {
  const map = {
    status: 'status', phase: 'phase', competitors: 'competitors', activeCount: 'active_count',
    videoCount: 'video_count', error: 'error', summary: 'summary', finishedAt: 'finished_at',
  };
  const sets = [];
  const args = [];
  for (const [k, col] of Object.entries(map)) {
    if (patch[k] === undefined) continue;
    sets.push(`${col} = ?`);
    args.push(k === 'summary' && typeof patch[k] !== 'string' ? JSON.stringify(patch[k]) : patch[k]);
  }
  if (!sets.length) return;
  args.push(jobId);
  db_().prepare(`UPDATE competitor_scan_job SET ${sets.join(', ')} WHERE id = ?`).run(...args);
}

export function createScanJob({ keywords, accountId }) {
  const id = randomUUID();
  const now = nowMs();
  const db = db_();
  db.prepare(
    `INSERT INTO competitor_scan_job (id, keywords, account_id, status, phase, created_at)
     VALUES (?, ?, ?, 'running', 'search', ?)`,
  ).run(id, JSON.stringify(keywords), accountId, now);
  const ins = db.prepare(
    'INSERT OR IGNORE INTO competitor_scan_keyword (job_id, keyword, cursor, done, updated_at) VALUES (?, ?, 0, 0, ?)',
  );
  for (const keyword of keywords) ins.run(id, keyword, now);
  return id;
}

function ensureKeywordRows(jobId, keywords) {
  const db = db_();
  const now = nowMs();
  const ins = db.prepare(
    'INSERT OR IGNORE INTO competitor_scan_keyword (job_id, keyword, cursor, done, updated_at) VALUES (?, ?, 0, 0, ?)',
  );
  for (const keyword of keywords) ins.run(jobId, keyword, now);
}

function upsertScanItem(jobId, user, keyword) {
  const db = db_();
  const now = nowMs();
  const row = db.prepare(
    'SELECT keywords FROM competitor_scan_item WHERE job_id = ? AND sec_uid = ?',
  ).get(jobId, user.secUid);
  if (row) {
    let keywords = [];
    try { keywords = JSON.parse(row.keywords || '[]'); } catch {}
    if (keyword && !keywords.includes(keyword)) keywords.push(keyword);
    db.prepare(
      `UPDATE competitor_scan_item SET uid = ?, nickname = ?, avatar_url = ?,
         keywords = ?, updated_at = ? WHERE job_id = ? AND sec_uid = ?`,
    ).run(
      user.uid ?? null, user.nickname ?? null, user.avatarThumb ?? null,
      JSON.stringify(keywords), now, jobId, user.secUid,
    );
  } else {
    db.prepare(
      `INSERT INTO competitor_scan_item
         (job_id, sec_uid, uid, nickname, avatar_url, keywords, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(
      jobId, user.secUid, user.uid ?? null, user.nickname ?? null,
      user.avatarThumb ?? null, JSON.stringify(keyword ? [keyword] : []), now, now,
    );
  }
}

export function listScanJobs(limit = 50) {
  return db_().prepare('SELECT * FROM competitor_scan_job ORDER BY created_at DESC LIMIT ?')
    .all(Math.min(200, Math.max(1, Number(limit) || 50)))
    .map((r) => ({
      id: r.id,
      keywords: (() => { try { return JSON.parse(r.keywords || '[]'); } catch { return []; } })(),
      accountId: r.account_id,
      status: r.status,
      phase: r.phase,
      competitors: r.competitors,
      activeCount: r.active_count,
      videoCount: r.video_count,
      error: r.error,
      summary: (() => { try { return JSON.parse(r.summary || '{}'); } catch { return {}; } })(),
      createdAt: r.created_at,
      finishedAt: r.finished_at,
    }));
}

export function getScanJob(id) {
  return listScanJobs(200).find((j) => j.id === id) || null;
}

export function cancelScanJob(id) {
  cancelledJobs.add(String(id));
  try {
    setJob(id, { status: 'cancelled', finishedAt: nowMs(), error: '已取消' });
  } catch {}
  return { ok: true };
}

export function deleteScanJob(id) {
  const row = db_().prepare('SELECT status FROM competitor_scan_job WHERE id = ?').get(id);
  if (!row) return { ok: true };
  if (row.status === 'running') {
    throw new Error('任务正在运行，请先取消再删除');
  }
  cancelledJobs.add(String(id));
  const db = db_();
  db.prepare('DELETE FROM competitor_scan_item WHERE job_id = ?').run(id);
  db.prepare('DELETE FROM competitor_scan_keyword WHERE job_id = ?').run(id);
  db.prepare('DELETE FROM competitor_scan_job WHERE id = ?').run(id);
  return { ok: true };
}

export function resumeScanJob(id) {
  const job = getScanJob(id);
  if (!job) throw new Error('采集任务不存在');
  cancelledJobs.delete(String(id));
  // 手动续采时重试上次失败项；待处理/已跳过项不动
  db_().prepare(
    "UPDATE competitor_scan_item SET status = 'pending', attempts = 0, error = NULL, updated_at = ? WHERE job_id = ? AND status = 'failed'",
  ).run(nowMs(), id);
  setJob(id, {
    status: 'running', phase: 'search', error: null, finishedAt: null,
  });
  return getScanJob(id);
}

function assertJob(jobId) {
  if (cancelledJobs.has(String(jobId))) throw new HarvestError('competitor_cancelled', '采集已取消');
}

/**
 * 关键词搜索同行 -> 判断活跃 -> 拉全部作品
 */
export async function runScanJob(jobId, { getSdk, canRun } = {}) {
  const job = getScanJob(jobId);
  if (!job) throw new Error('同行采集任务不存在');
  const keywords = job.keywords || [];
  const accountId = job.accountId;
  if (!keywords.length) throw new Error('没有关键词');
  if (typeof getSdk !== 'function') throw new Error('采集通道未初始化');

  const sdk = getSdk(accountId);
  const account = sdk?.account || sdk;
  if (!account || typeof account.searchUsers !== 'function') {
    throw new Error('账号未上线，无法搜索同行。请先到「账号管理」确认账号已登录。');
  }

  let cookies = '';
  try { cookies = sdk?.account?.im?.client?.getCookies?.() || ''; } catch {}
  const proxyUrl = getAccountProxyUrl(accountId);
  const gate = getAccountRequestGate(accountId, 2);

  try {
    setJob(jobId, { status: 'running', phase: 'search', error: null });
    ensureKeywordRows(jobId, keywords);
    const db = db_();

    // ── 搜索阶段：按关键词断点续翻页 ──
    const keywordRows = db.prepare(
      'SELECT keyword, cursor, done FROM competitor_scan_keyword WHERE job_id = ? ORDER BY rowid',
    ).all(jobId);
    for (const kr of keywordRows) {
      if (Number(kr.done)) continue;
      let cursor = Number(kr.cursor) || 0;
      while (true) {
        assertJob(jobId);
        if (canRun && !canRun()) throw new HarvestError('license', '授权状态已变化，采集已停止');
        let r;
        await gate.acquire({ minMs: 800, maxMs: 1600 });
        try {
          r = await account.searchUsers(kr.keyword, cursor);
        } finally {
          gate.release();
        }
        if (r?.statusCode && r.statusCode !== 0) {
          throw new Error(`搜索「${kr.keyword}」失败：${r.statusMsg || r.statusCode}`);
        }
        for (const u of r?.users ?? []) {
          if (!u?.secUid || !u?.uid) continue;
          upsertScanItem(jobId, u, kr.keyword);
        }
        const nextCursor = Number(r?.nextCursor);
        const finished = !r?.hasMore || r?.nextCursor == null || nextCursor <= cursor;
        db.prepare(
          'UPDATE competitor_scan_keyword SET cursor = ?, done = ?, updated_at = ? WHERE job_id = ? AND keyword = ?',
        ).run(finished ? cursor : nextCursor, finished ? 1 : 0, nowMs(), jobId, kr.keyword);
        const found = db.prepare('SELECT COUNT(*) c FROM competitor_scan_item WHERE job_id = ?').get(jobId).c;
        setJob(jobId, {
          competitors: found,
          summary: { currentKeyword: kr.keyword, cursor: finished ? cursor : nextCursor, found },
        });
        if (finished) break;
        cursor = nextCursor;
      }
    }

    const totalItems = db.prepare('SELECT COUNT(*) c FROM competitor_scan_item WHERE job_id = ?').get(jobId).c;
    if (!totalItems) throw new Error('没有搜索到同行，请更换关键词后重试');

    // ── 视频阶段：只处理 pending，已完成项重启后直接跳过 ──
    const pending = db.prepare(
      "SELECT * FROM competitor_scan_item WHERE job_id = ? AND status = 'pending' ORDER BY created_at, sec_uid",
    ).all(jobId);
    setJob(jobId, { phase: 'videos', competitors: totalItems });

    if (pending.length) {
      const browser = await CompetitorBrowser.launch({ cookies, proxyUrl });
      try {
        for (const item of pending) {
          assertJob(jobId);
          if (canRun && !canRun()) throw new HarvestError('license', '授权状态已变化，采集已停止');
          let candidateKeywords = [];
          try { candidateKeywords = JSON.parse(item.keywords || '[]'); } catch {}
          const candidate = {
            secUid: item.sec_uid,
            uid: item.uid,
            nickname: item.nickname,
            avatarUrl: item.avatar_url,
            keywords: candidateKeywords,
          };
          try {
            const sync = await syncCandidateWithBrowser(candidate, browser, {
              shouldStop: () => cancelledJobs.has(String(jobId)) || !!(canRun && !canRun()),
              onPage: (p) => setJob(jobId, {
                summary: {
                  currentCompetitor: item.nickname,
                  currentSecUid: item.sec_uid,
                  page: p.page,
                  videos: p.total,
                  done: db.prepare(
                    "SELECT COUNT(*) c FROM competitor_scan_item WHERE job_id = ? AND status IN ('done','skipped','failed')",
                  ).get(jobId).c,
                  total: totalItems,
                },
              }),
            });
            db.prepare(
              `UPDATE competitor_scan_item SET status = ?, active_level = ?, competitor_id = ?,
                 video_count = ?, attempts = attempts + 1, error = NULL, updated_at = ?
               WHERE job_id = ? AND sec_uid = ?`,
            ).run(
              sync.skipped ? 'skipped' : 'done',
              sync.activeLevel ?? null,
              sync.competitorId ?? null,
              sync.videoCount ?? 0,
              nowMs(), jobId, item.sec_uid,
            );
          } catch (e) {
            const msg = String(e.message || e).slice(0, 500);
            db.prepare(
              `UPDATE competitor_scan_item SET status = 'failed', attempts = attempts + 1,
                 error = ?, updated_at = ? WHERE job_id = ? AND sec_uid = ?`,
            ).run(msg, nowMs(), jobId, item.sec_uid);
            const existingId = item.competitor_id ||
              db.prepare('SELECT id FROM competitor WHERE sec_uid = ?').get(item.sec_uid)?.id;
            if (existingId) {
              try {
                db.prepare('UPDATE competitor SET last_error = ?, updated_at = ? WHERE id = ?')
                  .run(msg, nowMs(), existingId);
              } catch {}
            }
          }
          const counts = db.prepare(
            `SELECT
               SUM(CASE WHEN status IN ('done','skipped','failed') THEN 1 ELSE 0 END) AS processed,
               SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS kept,
               SUM(CASE WHEN status = 'done' AND active_level = 'active' THEN 1 ELSE 0 END) AS active,
               SUM(CASE WHEN status = 'done' AND active_level = 'normal' THEN 1 ELSE 0 END) AS normal,
               SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
               SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
               COALESCE(SUM(video_count), 0) AS videos
             FROM competitor_scan_item WHERE job_id = ?`,
          ).get(jobId);
          setJob(jobId, {
            competitors: counts.kept || 0,
            activeCount: counts.active || 0,
            videoCount: counts.videos || 0,
            summary: {
              discovered: totalItems,
              done: counts.processed || 0,
              total: totalItems,
              currentCompetitor: item.nickname,
              videos: counts.videos || 0,
              normalCount: counts.normal || 0,
              skippedInactive: counts.skipped || 0,
              failed: counts.failed || 0,
            },
          });
        }
      } finally {
        await browser.close();
      }
    }

    const counts = db.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status IN ('done','skipped','failed') THEN 1 ELSE 0 END) AS processed,
         SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS kept,
         SUM(CASE WHEN status = 'done' AND active_level = 'active' THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN status = 'done' AND active_level = 'normal' THEN 1 ELSE 0 END) AS normal,
         SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
         COALESCE(SUM(video_count), 0) AS videos
       FROM competitor_scan_item WHERE job_id = ?`,
    ).get(jobId);
    const failedCount = Number(counts.failed) || 0;
    setJob(jobId, {
      status: failedCount ? 'failed' : 'done',
      phase: failedCount ? 'failed' : 'done',
      error: failedCount ? `${failedCount} 个同行采集失败，可点续采重试` : null,
      finishedAt: nowMs(),
      competitors: Number(counts.kept) || 0,
      activeCount: Number(counts.active) || 0,
      videoCount: Number(counts.videos) || 0,
      summary: {
        discovered: Number(counts.total) || 0,
        done: Number(counts.processed) || 0,
        total: Number(counts.total) || 0,
        activeCount: Number(counts.active) || 0,
        normalCount: Number(counts.normal) || 0,
        skippedInactive: Number(counts.skipped) || 0,
        failed: failedCount,
        videoCount: Number(counts.videos) || 0,
      },
    });
    return {
      ok: true,
      competitors: Number(counts.kept) || 0,
      activeCount: Number(counts.active) || 0,
      normalCount: Number(counts.normal) || 0,
      skippedInactive: Number(counts.skipped) || 0,
      failed: failedCount,
      videoCount: Number(counts.videos) || 0,
    };

  } catch (e) {
    setJob(jobId, {
      status: cancelledJobs.has(String(jobId)) ? 'cancelled' : 'failed',
      phase: 'failed', error: String(e.message || e).slice(0, 500), finishedAt: nowMs(),
    });
    throw e;
  } finally {
    cancelledJobs.delete(String(jobId));
  }
}

async function syncCandidateWithBrowser(candidate, browser, { shouldStop, onPage } = {}) {
  const db = db_();
  const existing = db.prepare('SELECT * FROM competitor WHERE sec_uid = ?').get(candidate.secUid);

  let firstLevel = 'unknown';
  let latestVideoAt = null;
  const r = await browser.fetchVideos(candidate.secUid, {
    shouldStop,
    onPage,
    onFirstPage: ({ latestVideoAt: latest }) => {
      latestVideoAt = latest;
      firstLevel = activeLevelOf(latest);
      // 不活跃/无作品的同行不继续滚动全量作品
      return firstLevel === 'active' || firstLevel === 'normal';
    },
  });

  latestVideoAt = r.latestVideoAt || latestVideoAt;
  const level = activeLevelOf(latestVideoAt);
  const now = nowMs();

  // 新发现且不活跃：直接放弃，不写入同行库
  if (!existing && (level === 'inactive' || level === 'unknown')) {
    return {
      skipped: true, activeLevel: level, latestVideoAt,
      competitorId: null, videoCount: 0, newVideos: 0,
    };
  }

  let competitorId = existing?.id;
  if (!competitorId) {
    const saved = upsertCompetitor({
      secUid: candidate.secUid,
      uid: candidate.uid,
      nickname: candidate.nickname,
      avatarUrl: candidate.avatarUrl || null,
      keyword: (candidate.keywords || [])[0] || null,
    });
    competitorId = saved.id;
    for (const kw of candidate.keywords || []) {
      try {
        db.prepare(
          'INSERT OR IGNORE INTO competitor_keyword (competitor_id, keyword, created_at) VALUES (?, ?, ?)',
        ).run(competitorId, kw, now);
      } catch {}
    }
  } else {
    db.prepare(
      `UPDATE competitor SET uid = COALESCE(?, uid), nickname = COALESCE(?, nickname),
         avatar_url = COALESCE(?, avatar_url), updated_at = ? WHERE id = ?`,
    ).run(candidate.uid ?? null, candidate.nickname ?? null, candidate.avatarUrl ?? null, now, competitorId);
    for (const kw of candidate.keywords || []) {
      try {
        db.prepare(
          'INSERT OR IGNORE INTO competitor_keyword (competitor_id, keyword, created_at) VALUES (?, ?, ?)',
        ).run(competitorId, kw, now);
      } catch {}
    }
  }

  if (level === 'inactive' || level === 'unknown') {
    db.prepare(
      `UPDATE competitor SET latest_video_at = ?, active_level = ?, last_synced_at = ?,
         last_error = NULL, updated_at = ? WHERE id = ?`,
    ).run(latestVideoAt, level, now, now, competitorId);
    return {
      skipped: true, activeLevel: level, latestVideoAt,
      competitorId, videoCount: 0, newVideos: 0,
    };
  }

  const { newVideos, count } = upsertVideos(competitorId, r.videos);
  db.prepare(
    `UPDATE competitor SET latest_video_at = ?, active_level = ?, video_count = ?,
       last_synced_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`,
  ).run(latestVideoAt, level, count, now, now, competitorId);
  const appended = appendToLinkedMonitors(competitorId, newVideos, candidate.nickname || existing?.nickname);
  return {
    skipped: false,
    activeLevel: level,
    latestVideoAt,
    competitorId,
    videoCount: count,
    newVideos: newVideos.length,
    appendedToMonitors: appended,
  };
}

async function syncCompetitorWithBrowser(competitorId, browser, { shouldStop, onPage } = {}) {
  const row = db_().prepare('SELECT * FROM competitor WHERE id = ?').get(competitorId);
  if (!row) throw new Error('同行不存在');
  return syncCandidateWithBrowser({
    secUid: row.sec_uid,
    uid: row.uid,
    nickname: row.nickname,
    avatarUrl: row.avatar_url,
    keywords: [],
  }, browser, { shouldStop, onPage });
}

export async function refreshCompetitor(id, { cookies = '', proxyUrl = null, shouldStop } = {}) {
  const browser = await CompetitorBrowser.launch({ cookies, proxyUrl });
  try {
    return await syncCompetitorWithBrowser(id, browser, { shouldStop });
  } finally {
    await browser.close();
  }
}

/** 创建引用同行的线索任务。任务默认全视频监控。 */
export function createLeadTaskFromCompetitors({
  competitorIds, accountId, name,
}) {
  const ids = [...new Set((competitorIds ?? []).filter(Boolean))];
  if (!ids.length) throw new Error('请选择同行');
  const peers = ids.map((id) => getCompetitor(id)).filter(Boolean);
  if (!peers.length) throw new Error('同行不存在');

  const rows = db_().prepare(
    `SELECT v.aweme_id FROM competitor_video v
      WHERE v.competitor_id IN (${ids.map(() => '?').join(',')})
        AND v.excluded = 0 AND v.monitor_enabled = 1
      ORDER BY v.create_time DESC`,
  ).all(...ids);
  if (!rows.length) throw new Error('选中的同行还没有可监控视频，请先刷新作品');

  const raw = rows.map((r) => `https://www.douyin.com/video/${r.aweme_id}`).join('\n');
  const taskName = name || `同行评论 · ${peers.map((p) => p.nickname || p.secUid).slice(0, 3).join('、')}`;
  const created = createInterceptTask({
    name: taskName,
    accountIds: [accountId],
    raw,
    harvestMode: 'video',
    params: {},
  });

  const db = db_();
  const now = nowMs();
  // 标记为同行任务：后续 UI 显示「同行视频监控」，runHarvest 仍走视频任务链路
  db.prepare("UPDATE outreach_task SET target_mode = 'competitor' WHERE id = ?").run(created.id);
  const ins = db.prepare(
    'INSERT OR IGNORE INTO outreach_task_competitor (task_id, competitor_id, created_at) VALUES (?, ?, ?)',
  );
  db.exec('BEGIN');
  try {
    for (const id of ids) ins.run(created.id, id, now);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }

  return { ...created, videoCount: rows.length, competitorCount: ids.length };
}

export function listTaskCompetitorIds(taskId) {
  return db_().prepare('SELECT competitor_id FROM outreach_task_competitor WHERE task_id = ?')
    .all(taskId).map((r) => r.competitor_id);
}

export function taskCompetitorVideos(taskId) {
  return db_().prepare(
    `SELECT v.*, c.nickname AS competitor_name
       FROM outreach_task_competitor t
       JOIN competitor c ON c.id = t.competitor_id
       JOIN competitor_video v ON v.competitor_id = t.competitor_id
      WHERE t.task_id = ? AND v.excluded = 0 AND v.monitor_enabled = 1
      ORDER BY v.create_time DESC`,
  ).all(taskId);
}

export function createFixedMonitorForTask(taskId, videos, keywordById) {
  const list = (videos ?? []).map((v) => ({
    awemeId: String(v.aweme_id ?? v.awemeId),
    desc: v.title ?? v.desc ?? null,
    commentCount: v.comment_count ?? v.commentCount ?? 0,
    keyword: keywordById?.[v.competitor_id] || v.keyword || null,
  })).filter((v) => v.awemeId);
  if (!list.length) throw new Error('没有可监控的视频');
  return createMonitor(taskId, {
    mode: 'video',
    videos: list,
    intervalSec: 60,
    pagesPerVideo: 0,
    keywordsPerRound: 5,
    videosPerRound: 20,
    requestGapMinMs: 600,
    requestGapMaxMs: 1200,
    scanConcurrency: 10,
    discoveryIntervalSec: 120,
    sinceAt: Date.now() - DAY,
    includeZeroComments: true,
    maxWatchVideos: 0,
  });
}

export function markInterruptedJobs() {
  try {
    db_().prepare(
      "UPDATE competitor_scan_job SET status = 'paused', error = '客户端中断，等待自动续采', finished_at = NULL WHERE status = 'running'",
    ).run();
  } catch {}
}
