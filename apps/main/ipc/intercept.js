/**
 * 线索雷达 IPC
 *
 * 三段式：create(采集配置) → harvest(采集) → review(审核) → run(发送)
 */
import {
  createInterceptTask, runHarvest, listInterceptTargets, updateHarvestSummary,
  reviewTargets, getInterceptTask, listInterceptTasks,
  deleteInterceptTask, buildSendPayload, INTERCEPT_DEFAULTS,
  HARVEST_MODES, parseUidList, markTargetSent, cancelHarvest, listTaskKeywords,
  approveAllPending,
} from '../src/intercept-service.js';
import {
  getHarvestConfig, saveHarvestConfig, parseVideoInput, parseKeywordInput,
  resetHarvestUsage, MAX_KEYWORDS,
} from '../src/harvest-service.js';
import { parseLiveInput, findBrowserExecutable } from '../src/live-harvest-service.js';
import {
  createMonitor, getMonitor, updateMonitor, deleteMonitor, resetMonitorBaseline,
  runMonitorRound, estimateMonitorRequests, MONITOR_DEFAULTS, cancelMonitorTask,
  getSchedulerSnapshot,
} from '../src/monitor-service.js';
import { getAccount } from '../src/account-repo.js';
import { refreshTaskPresence } from '../src/presence-service.js';
import { requireFeature } from '../src/license-gate.js';
import { db_ } from '../src/db.js';
import { listMessageTemplates, saveMessageTemplates } from '../src/message-templates.js';

export function registerInterceptIpc({ ipcMain, sender, getSdk, isBlocked }) {
  // 后台采集任务：taskId -> Promise
  const harvestJobs = new Map();

  // ── 发送进度 → 回写 outreach_item ──
  // 截流任务复用自己那张 outreach_task 行（sender 不落库），
  // 所以需要在这里把逐条结果同步到 outreach_item。
  sender.on('progress', (ev) => {
    // 截流分批发时，运行期 id 和落库 id 不同
    const recordId = ev?.dbTaskId ?? ev?.taskId;
    if (!recordId) return;
    const task = db_()
      .prepare("SELECT id FROM outreach_task WHERE id = ? AND kind = 'intercept'")
      .get(recordId);
    if (!task) return;

    if (ev.type === 'item') {
      const results = sender.getResults(ev.taskId);
      const last = results[results.length - 1];
      // 账号级临时错误（频率限制/需验证）不消费目标，留在 approved 里下次再跑
      const transient = last?.reasonCode === 'rate_limited'
        || last?.reasonCode === 'account_verify_required'
        || last?.reasonCode === 'account_restricted'
        || last?.reasonCode === 'account_daily_cap';
      if (last?.itemId && !transient) {
        markTargetSent(last.itemId, {
          status: last.status,
          reason: last.reason,
          serverMessageId: last.serverMessageId,
        });
      }
    } else if (ev.type === 'done') {
      db_()
        .prepare("UPDATE outreach_task SET stage = 'done', finished_at = ? WHERE id = ?")
        .run(Date.now(), recordId);
    } else if (ev.type === 'all_tripped' || ev.type === 'all_quota_exhausted') {
      db_()
        .prepare("UPDATE outreach_task SET stage = 'paused', finished_at = ? WHERE id = ?")
        .run(Date.now(), recordId);
    }
  });

  // ── 默认参数（给 UI 显示） ──
  ipcMain.handle('ic:defaults', () => ({
    ...INTERCEPT_DEFAULTS,
    modes: Object.values(HARVEST_MODES),
  }));

  // ── 文案库 ──
  ipcMain.handle('ic:templates', () => listMessageTemplates());
  ipcMain.handle('ic:saveTemplates', (_e, list) => saveMessageTemplates(list));

  ipcMain.handle('ic:liveBrowser', () => {
    const p = findBrowserExecutable();
    return p ? { ok: true, path: p } : { ok: false, error: '未找到 Chrome 或 Edge，无法采集直播间' };
  });

  // ── 采集参数 ──
  ipcMain.handle('ic:harvestConfig', () => getHarvestConfig());
  ipcMain.handle('ic:saveHarvestConfig', (_e, patch) => {
    try {
      return { ok: true, config: saveHarvestConfig(patch ?? {}) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('ic:resetUsage', () => resetHarvestUsage());

  // ── 预览解析结果（不落库） ──
  ipcMain.handle('ic:parse', (_e, raw, mode = 'manual') => {
    if (mode === 'video') {
      const r = parseVideoInput(raw);
      return { targets: r.videos.map((v) => ({ uid: v.id })), invalid: r.invalid, duplicates: 0 };
    }
    if (mode === 'keyword') {
      try {
        const r = parseKeywordInput(raw);
        return {
          targets: r.keywords.map((k) => ({ uid: k })),
          invalid: r.invalid,
          duplicates: 0,
          max: MAX_KEYWORDS,
        };
      } catch {
        return { targets: [], invalid: [], duplicates: 0, max: MAX_KEYWORDS };
      }
    }
    if (mode === 'live') {
      const r = parseLiveInput(raw);
      return {
        targets: r.rooms.map((x) => ({ uid: x.webRid })),
        invalid: r.invalid,
        shortLinks: r.shortLinks,
        duplicates: 0,
      };
    }
    return parseUidList(raw);
  });

  // ── 创建任务（进入采集阶段） ──
  ipcMain.handle('ic:create', (_e, payload) => {
    const deny = requireFeature('intercept');
    if (deny) return deny;
    try {
      return { ok: true, ...createInterceptTask(payload ?? {}) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ── 执行采集 ──
  ipcMain.handle('ic:harvest', async (_e, taskId) => {
    const deny = requireFeature('intercept');
    if (deny) return deny;
    try {
      return await runHarvest(taskId, {
        getSdk,
        canRun: () => !requireFeature('intercept') && !isBlocked?.(),
      });
    } catch (e) {
      // 一条线索都没采到时把任务标成 failed，列表上可重采
      try {
        const n = db_()
          .prepare('SELECT COUNT(*) c FROM outreach_item WHERE task_id = ?')
          .get(taskId).c;
        if (!n) {
          db_().prepare("UPDATE outreach_task SET stage = 'failed' WHERE id = ?").run(taskId);
        }
      } catch {}
      return { ok: false, error: e.message, details: e.details ?? null };
    }
  });

  // ── 启动后台采集（立即返回，线索边采边入库）──
  ipcMain.handle('ic:startHarvest', async (_e, taskId, opts) => {
    const deny = requireFeature('intercept');
    if (deny) return deny;
    if (harvestJobs.has(taskId)) return { ok: false, error: '任务正在采集中' };

    const task = getInterceptTask(taskId);
    if (!task) return { ok: false, error: '任务不存在' };

    const job = (async () => {
      try {
        const result = await runHarvest(taskId, {
          getSdk,
          deferComments: true,
          canRun: () => !requireFeature('intercept') && !isBlocked?.(),
        });

        // 采集成功后按需自动创建监控（关键词/视频都适用）
        if (opts?.monitor?.enabled && result?.videos?.length) {
          try {
            let keywords = [];
            if (task.targetMode === 'keyword') {
              keywords = parseKeywordInput(task.targetRaw ?? '').keywords ?? [];
            }
            createMonitor(taskId, {
              mode: task.targetMode,
              keywords,
              videos: result.videos,
              intervalSec: opts.monitor.intervalSec,
              pagesPerVideo: opts.monitor.pagesPerVideo,
              keywordsPerRound: opts.monitor.keywordsPerRound,
              videosPerRound: opts.monitor.videosPerRound,
              requestGapMinMs: opts.monitor.requestGapMinMs,
              requestGapMaxMs: opts.monitor.requestGapMaxMs,
              scanConcurrency: opts.monitor.scanConcurrency,
              discoveryIntervalSec: opts.monitor.discoveryIntervalSec,
              sinceAt: opts.monitor.sinceAt,
            });
          } catch (e) {
            updateHarvestSummary(taskId, { monitorError: e.message });
            console.error('[harvest] 监控创建失败:', e.message);
          }
        } else if (task.competitorCount && result?.videos?.length) {
          // 同行视频监控：默认全视频、无限视频数，重启/重试后也自动补监控
          try {
            createMonitor(taskId, {
              mode: 'video',
              videos: result.videos,
              intervalSec: 60,
              pagesPerVideo: 0,
              keywordsPerRound: 5,
              videosPerRound: 20,
              requestGapMinMs: 600,
              requestGapMaxMs: 1200,
              scanConcurrency: 10,
              discoveryIntervalSec: 120,
              sinceAt: Date.now() - 86400000,
              includeZeroComments: true,
              maxWatchVideos: 0,
            });
          } catch (e) {
            updateHarvestSummary(taskId, { monitorError: e.message });
            console.error('[harvest] 同行监控创建失败:', e.message);
          }
        }
        return result;
      } catch (e) {
        // runHarvest 内部已经标记 failed
        console.error('[harvest] 后台采集失败:', e.message);
        return null;
      } finally {
        harvestJobs.delete(taskId);
      }
    })();

    harvestJobs.set(taskId, job);
    return { ok: true, background: true };
  });

  // ── 审核列表 ──
  ipcMain.handle('ic:targets', (_e, taskId, opts) => listInterceptTargets(taskId, opts ?? {}));
  ipcMain.handle('ic:keywords', (_e, taskId) => listTaskKeywords(taskId));

  // ── 批量审核 ──
  ipcMain.handle('ic:review', (_e, taskId, ids, action) => {
    try {
      return reviewTargets(taskId, ids, action);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('ic:approveAll', (_e, taskId) => {
    try {
      return approveAllPending(taskId);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ── 任务详情 / 列表 ──
  ipcMain.handle('ic:get', (_e, taskId) => {
    const task = getInterceptTask(taskId);
    if (!task) return null;
    return { ...task, monitor: getMonitor(taskId), harvestRunning: harvestJobs.has(taskId) };
  });
  ipcMain.handle('ic:refreshPresence', async (_e, taskId) => {
    try {
      return { ok: true, ...(await refreshTaskPresence(taskId, { getSdk })) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('ic:list', () =>
    listInterceptTasks().map((t) => ({ ...t, monitor: getMonitor(t.id) })),
  );
  ipcMain.handle('ic:delete', (_e, taskId) => {
    // 先通知正在跑的监控/采集退出，再删任务，避免继续写孤儿线索
    cancelMonitorTask(taskId);
    cancelHarvest(taskId);
    deleteMonitor(taskId);
    return deleteInterceptTask(taskId);
  });

  // ── 持续监控 ──
  ipcMain.handle('mt:defaults', () => MONITOR_DEFAULTS);
  ipcMain.handle('mt:scheduler', () => getSchedulerSnapshot());

  ipcMain.handle('mt:create', (_e, taskId, cfg) => {
    const deny = requireFeature('monitor');
    if (deny) return deny;
    try {
      return { ok: true, monitor: createMonitor(taskId, cfg ?? {}) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('mt:update', (_e, taskId, patch) => {
    try {
      if (patch?.enabled !== undefined) {
        console.log(`[monitor] update enabled=${patch.enabled} task=${taskId}`);
      }
      return { ok: true, monitor: updateMonitor(taskId, patch ?? {}) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('mt:toggle', (_e, taskId, enabled) => {
    console.log(`[monitor] toggle enabled=${!!enabled} task=${taskId}`);
    if (enabled) {
      const deny = requireFeature('monitor');
      if (deny) return deny;
    }
    try {
      return { ok: true, monitor: updateMonitor(taskId, { enabled: !!enabled }) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('mt:runNow', async (_e, taskId) => {
    const deny = requireFeature('monitor');
    if (deny) return deny;
    try {
      return { ok: true, summary: await runMonitorRound(taskId, { getSdk }) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('mt:reset', (_e, taskId) => {
    try {
      return { ok: true, monitor: resetMonitorBaseline(taskId) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('mt:estimate', (_e, cfg) => estimateMonitorRequests(cfg ?? {}));

  // ── 启动发送 ──
  ipcMain.handle('ic:run', async (_e, taskId, opts) => {
    const deny = requireFeature('intercept');
    if (deny) return deny;
    try {
      const task = getInterceptTask(taskId);
      if (!task) return { ok: false, error: '任务不存在' };
      if (!task.approved) return { ok: false, error: '没有审核通过的目标' };

      // 解析账号 → sdkKey（发送页可重新勾选发送账号）
      const requestedAccountIds = Array.isArray(opts?.accountIds) && opts.accountIds.length
        ? opts.accountIds
        : task.accountIds;
      const accounts = requestedAccountIds
        .map((id) => {
          const acc = getAccount(id);
          if (!acc?.uid) return null;
          return { accountId: acc.id, sdkKey: String(acc.uid), nickname: acc.nickname };
        })
        .filter(Boolean);

      if (!accounts.length) return { ok: false, error: '没有有效的参与账号' };

      const payload = buildSendPayload(taskId, accounts, opts?.throttle, opts?.targetIds);
      // 文案池由 UI 传入；没传就用默认（保持接口兼容）
      const incoming = Array.isArray(opts?.texts) ? opts.texts : [opts?.text];
      const texts = incoming
        .map((t) => String(t ?? '').trim())
        .filter(Boolean)
        .slice(0, 100);
      payload.contents = texts.length
        ? texts
        : ['您好，看到您对这个话题感兴趣，方便聊两句吗'];
      payload.strategy = opts?.strategy === 'sequence' ? 'sequence' : 'random';

      // 保存话术池，下次打开/恢复任务时继续使用
      try {
        db_().prepare(
          'UPDATE outreach_task SET content_items = ?, content_strategy = ? WHERE id = ?',
        ).run(JSON.stringify(payload.contents), payload.strategy, taskId);
      } catch {}

      // ★ 运行期 id 必须唯一（同一个截流任务可以分多批发），
      //   落库/日志仍归到原任务
      const runId = `ic_${taskId}_${Date.now()}`;
      const t = sender.createTask({
        ...payload,
        id: runId,
        dbTaskId: taskId,
        persist: false,
        neverStop: !!opts?.neverStop,
      });

      db_()
        .prepare("UPDATE outreach_task SET stage = 'running', started_at = ? WHERE id = ?")
        .run(Date.now(), taskId);

      await sender.run(t.id);
      return { ok: true, senderTaskId: t.id };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}
