/**
 * 同行监控 IPC
 *
 * 同行板块只负责发现同行、判断活跃、拉全部作品和筛选；
 * 评论扫描由线索雷达引用同行后执行。
 */
import {
  listCompetitors, getCompetitor, listCompetitorVideos, listCompetitorKeywords,
  competitorStats, createScanJob, listScanJobs, getScanJob, cancelScanJob, resumeScanJob, deleteScanJob, runScanJob,
  refreshCompetitor, createLeadTaskFromCompetitors, createFixedMonitorForTask,
  excludeCompetitorVideo, markInterruptedJobs,
} from '../src/competitor-service.js';
import { parseKeywordInput } from '../src/harvest-service.js';
import { runHarvest } from '../src/intercept-service.js';
import { runMonitorRound } from '../src/monitor-service.js';
import { requireFeature } from '../src/license-gate.js';

export function registerCompetitorIpc({ ipcMain, getSdk, isBlocked, onMonitorEvent }) {
  markInterruptedJobs();
  const runningJobs = new Set();

  function launchJob(jobId, accountId, { resume = false } = {}) {
    if (runningJobs.has(String(jobId))) return false;
    if (resume) {
      try { resumeScanJob(jobId); } catch { return false; }
    }
    runningJobs.add(String(jobId));
    runScanJob(jobId, {
      getSdk,
      canRun: () => !requireFeature('intercept') && !isBlocked?.(),
    })
      .catch((e) => console.error('[competitor] scan failed:', e.message))
      .finally(() => runningJobs.delete(String(jobId)));
    return true;
  }

  // 客户端重启后，已中断的同行采集任务在账号上线后自动续采
  const resumeTimer = setInterval(() => {
    try {
      if (requireFeature('intercept') || isBlocked?.()) return;
      const paused = listScanJobs(100).filter((j) => j.status === 'paused');
      for (const j of paused) {
        if (runningJobs.has(String(j.id))) continue;
        const sdk = getSdk(j.accountId);
        if (sdk?.ready) launchJob(j.id, j.accountId, { resume: true });
      }
    } catch {}
  }, 15000);
  resumeTimer.unref?.();

  ipcMain.handle('cp:list', (_e, opts) => listCompetitors(opts ?? {}));
  ipcMain.handle('cp:get', (_e, id) => getCompetitor(id));
  ipcMain.handle('cp:videos', (_e, opts) => listCompetitorVideos(opts ?? {}));
  ipcMain.handle('cp:keywords', () => listCompetitorKeywords());
  ipcMain.handle('cp:stats', () => competitorStats());

  ipcMain.handle('cp:jobs', (_e, limit) => listScanJobs(limit));
  ipcMain.handle('cp:job', (_e, id) => getScanJob(id));
  ipcMain.handle('cp:cancelJob', (_e, id) => cancelScanJob(id));

  ipcMain.handle('cp:deleteJob', (_e, id) => {
    try {
      return deleteScanJob(id);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('cp:resumeJob', (_e, id) => {
    const deny = requireFeature('intercept');
    if (deny) return deny;
    if (isBlocked?.()) return { ok: false, reason: 'update_required', error: '请先完成强制更新' };
    const job = getScanJob(id);
    if (!job) return { ok: false, error: '采集任务不存在' };
    const sdk = getSdk(job.accountId);
    if (!sdk?.ready) return { ok: false, error: '采集账号未上线，请稍后重试' };
    const ok = launchJob(id, job.accountId, { resume: true });
    return ok ? { ok: true, jobId: id } : { ok: false, error: '任务正在运行' };
  });

  ipcMain.handle('cp:startScan', async (_e, { keywords, accountId } = {}) => {
    const deny = requireFeature('intercept');
    if (deny) return deny;
    if (isBlocked?.()) return { ok: false, reason: 'update_required', error: '请先完成强制更新' };
    if (!accountId) return { ok: false, error: '请选择采集账号' };
    let parsed;
    try { parsed = parseKeywordInput(keywords); } catch (e) {
      return { ok: false, error: e.message };
    }
    const id = createScanJob({ keywords: parsed.keywords, accountId });
    launchJob(id, accountId);
    return {
      ok: true, jobId: id,
      keywords: parsed.keywords,
      invalid: parsed.invalid,
    };
  });

  ipcMain.handle('cp:refresh', async (_e, { competitorId, accountId } = {}) => {
    const deny = requireFeature('intercept');
    if (deny) return deny;
    if (isBlocked?.()) return { ok: false, reason: 'update_required', error: '请先完成强制更新' };
    const sdk = getSdk(accountId);
    if (!sdk?.account) return { ok: false, error: '账号未上线，请先到账号管理确认登录' };
    let cookies = '';
    try { cookies = sdk.account.im?.client?.getCookies?.() || ''; } catch {}
    const proxyUrl = (await import('../src/proxy-service.js')).getAccountProxyUrl(accountId);
    try {
      const r = await refreshCompetitor(competitorId, { cookies, proxyUrl });
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('cp:excludeVideo', (_e, awemeId, excluded) => {
    try {
      return excludeCompetitorVideo(awemeId, excluded !== false);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 把同行加入线索：创建视频任务 + 关联同行 + 默认全视频监控
  ipcMain.handle('cp:addToLeads', async (_e, { competitorIds, accountId, name } = {}) => {
    const deny = requireFeature('intercept');
    if (deny) return deny;
    if (isBlocked?.()) return { ok: false, reason: 'update_required', error: '请先完成强制更新' };
    if (!accountId) return { ok: false, error: '请选择采集账号' };
    try {
      const created = createLeadTaskFromCompetitors({ competitorIds, accountId, name });
      const run = await runHarvest(created.id, {
        getSdk,
        deferComments: true,
        canRun: () => !requireFeature('intercept') && !isBlocked?.(),
      });
      if (!run?.videos?.length) {
        return { ok: false, taskId: created.id, error: '同行视频为空，无法创建线索任务' };
      }
      createFixedMonitorForTask(created.id, run.videos);
      // 创建后立即跑首轮评论扫描；UI 通过 monitor:event 自动刷新审核列表
      setTimeout(() => {
        runMonitorRound(created.id, { getSdk })
          .then((summary) => onMonitorEvent?.({ taskId: created.id, summary }))
          .catch((e) => onMonitorEvent?.({ taskId: created.id, error: e.message }));
      }, 300);
      return {
        ok: true,
        taskId: created.id,
        competitorCount: created.competitorCount,
        videoCount: created.videoCount,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}
