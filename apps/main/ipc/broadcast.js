/**
 * 群发任务 IPC
 *
 * 职责：任务的创建、启动、暂停、恢复、取消、查询
 * 实际发送由 packages/sender 完成
 */
import { db_ } from '../src/db.js';
import { recentlyContactedSet } from '../src/conversation-repo.js';
import { requireFeature } from '../src/license-gate.js';

export function registerBroadcastIpc({ ipcMain, sender, manager, getAccount }) {
  // ── 创建任务 ──
  ipcMain.handle('bc:create', (_e, payload) => {
    const deny = requireFeature('broadcast');
    if (deny) return deny;
    const {
      name,
      accountIds,      // 本地账号 id 数组
      targetMode,      // 'contacts' | 'uids'
      contacts,        // 从联系人选的 [{uid,name}]
      rawUids,         // 手填的 uid 文本（一行一个）
      contents,        // 文案数组
      strategy,        // 'random' | 'sequence'
      throttle,
      excludeRecentDays = 0,
      scheduledAt = null,
    } = payload;

    // 解析目标
    let targets = [];
    if (targetMode === 'uids' && rawUids) {
      const seen = new Set();
      for (const line of String(rawUids).split(/[\r\n]+/)) {
        const uid = line.trim();
        if (!uid || seen.has(uid)) continue;
        if (!/^\d{5,25}$/.test(uid)) continue; // 只接受数字 uid
        seen.add(uid);
        targets.push({ uid, name: uid });
      }
    } else {
      targets = (contacts ?? []).filter((c) => c?.uid);
    }

    if (!targets.length) {
      return { ok: false, error: '没有有效的收件人' };
    }

    // 解析账号 → sdkKey
    const accounts = (accountIds ?? [])
      .map((id) => {
        const acc = getAccount(id);
        if (!acc?.uid) return null;
        return { accountId: acc.id, sdkKey: String(acc.uid), nickname: acc.nickname };
      })
      .filter(Boolean);

    if (!accounts.length) {
      return { ok: false, error: '没有有效的参与账号' };
    }

    // 排除最近 N 天已经联系过的人，避免重复打扰
    let excludedRecent = 0;
    if (Number(excludeRecentDays) > 0) {
      const recent = recentlyContactedSet(
        accounts.map((a) => a.accountId),
        Number(excludeRecentDays),
      );
      const before = targets.length;
      targets = targets.filter((t) => !recent.has(String(t.uid)));
      excludedRecent = before - targets.length;
      if (!targets.length) {
        return {
          ok: false,
          error: `排除最近 ${excludeRecentDays} 天联系过的目标后，没有可发送的收件人`,
        };
      }
    }

    // 清理文案
    const cleaned = (contents ?? []).map((c) => String(c ?? '').trim()).filter(Boolean);
    if (!cleaned.length) {
      return { ok: false, error: '没有有效文案' };
    }

    try {
      const task = sender.createTask({
        kind: 'broadcast',
        name,
        accounts,
        targets,
        contents: cleaned,
        strategy: strategy === 'sequence' ? 'sequence' : 'random',
        throttle,
        scheduledAt,
      });
      const at = Number(scheduledAt) || 0;
      if (at > Date.now()) {
        const scheduled = sender.schedule(task.id, at);
        return {
          ok: true,
          task: scheduled,
          scheduled: true,
          scheduledAt: at,
          excludedRecent,
        };
      }
      return { ok: true, task, excludedRecent };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ── 启动 ──
  ipcMain.handle('bc:run', async (_e, taskId) => {
    const deny = requireFeature('broadcast');
    if (deny) return deny;
    try {
      const t = await sender.run(taskId);
      return { ok: true, task: t };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ── 控制 ──
  ipcMain.handle('bc:pause', (_e, taskId) => {
    const t = sender.pause(taskId);
    return t ? { ok: true, task: t } : { ok: false, error: '任务不存在' };
  });

  ipcMain.handle('bc:resume', (_e, taskId) => {
    const t = sender.resume(taskId);
    return t ? { ok: true, task: t } : { ok: false, error: '任务不存在' };
  });

  ipcMain.handle('bc:cancel', async (_e, taskId) => {
    const t = await sender.cancel(taskId);
    return t ? { ok: true, task: t } : { ok: false, error: '任务不存在' };
  });

  // ── 查询 ──
  ipcMain.handle('bc:list', () => {
    // 内存中的任务 + 数据库里的历史
    const live = sender.listTasks();
    const liveIds = new Set(live.map((t) => t.id));

    const history = db_()
      .prepare(
        `SELECT * FROM outreach_task WHERE kind = 'broadcast'
         ORDER BY created_at DESC LIMIT 100`,
      )
      .all()
      .filter((r) => !liveIds.has(r.id))
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        name: r.name,
        status: r.stage === 'done' ? 'done' : r.stage,
        total: r.target_count,
        progress: r.progress,
        success: r.success_count,
        fail: r.fail_count,
        skipped: 0,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        accounts: JSON.parse(r.account_ids || '[]').length,
        fromHistory: true,
      }));

    return [...live, ...history];
  });

  ipcMain.handle('bc:get', (_e, id) => sender.getTask(id));

  // 任务详情：从 send_log 读逐条结果（重启后仍在）
  ipcMain.handle('bc:results', (_e, taskId) => {
    const rows = db_()
      .prepare(
        `SELECT account_id, peer_uid, content, status, reason, verify_level, created_at
         FROM send_log WHERE task_id = ? ORDER BY created_at ASC LIMIT 2000`,
      )
      .all(taskId);
    return { rows, total: rows.length };
  });

  // 失败重试：把 send_log 里失败的目标重新建一个任务
  ipcMain.handle('bc:retryFailed', async (_e, taskId) => {
    const deny = requireFeature('broadcast');
    if (deny) return deny;
    const task = db_()
      .prepare("SELECT * FROM outreach_task WHERE id = ? AND kind = 'broadcast'")
      .get(taskId);
    if (!task) return { ok: false, error: '任务不存在' };

    const failed = db_()
      .prepare(
        `SELECT DISTINCT peer_uid FROM send_log
         WHERE task_id = ? AND status = 'failed' AND peer_uid IS NOT NULL`,
      )
      .all(taskId);
    if (!failed.length) return { ok: false, error: '这个任务没有失败目标' };

    const accountIds = JSON.parse(task.account_ids || '[]');
    const accounts = accountIds
      .map((id) => getAccount(id))
      .filter((a) => a?.uid)
      .map((a) => ({ accountId: a.id, sdkKey: String(a.uid), nickname: a.nickname }));
    if (!accounts.length) return { ok: false, error: '原任务的账号已不可用' };

    const contents = JSON.parse(task.content_items || '[]');
    if (!contents.length) return { ok: false, error: '原任务没有文案' };

    try {
      const retry = sender.createTask({
        kind: 'broadcast',
        name: `${task.name || '群发'}（失败重试）`,
        accounts,
        targets: failed.map((r) => ({ uid: String(r.peer_uid), name: String(r.peer_uid) })),
        contents,
        strategy: task.content_strategy === 'sequence' ? 'sequence' : 'random',
        throttle: {
          gapMinSec: task.gap_sec || 15,
          gapMaxSec: task.gap_sec || 15,
          batchSize: task.batch_size || 5,
          roundWaitSec: task.round_wait_sec || 300,
          dailyLimit: task.daily_limit || 20,
          hourlyLimit: task.hourly_limit || 5,
        },
      });
      return { ok: true, task: retry, count: failed.length };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ── 预览：算出预计耗时 ──
  ipcMain.handle('bc:estimate', (_e, { targetCount, accountCount, throttle }) => {
    const t = throttle ?? {};
    const gap = ((t.gapMinSec ?? 8) + (t.gapMaxSec ?? 30)) / 2;
    const batchSize = t.batchSize ?? 5;
    const roundWait = t.roundWaitSec ?? 300;
    const dailyLimit = t.dailyLimit ?? 20;
    const hourlyLimit = t.hourlyLimit ?? 5;

    const accs = Math.max(1, accountCount);
    const perRound = batchSize * accs;              // 一轮能发多少
    const rounds = Math.ceil(targetCount / perRound);
    const roundTime = gap * perRound + (rounds > 1 ? roundWait : 0);
    const totalSec = rounds * roundTime;

    // 配额约束：需要多少小时/天
    const capacityPerHour = hourlyLimit * accs;
    const hoursNeeded = Math.ceil(targetCount / Math.max(1, capacityPerHour));
    const capacityPerDay = dailyLimit * accs;
    const daysNeeded = Math.ceil(targetCount / Math.max(1, capacityPerDay));

    return {
      estimatedSec: totalSec,
      estimatedMin: Math.round(totalSec / 60),
      rounds,
      perRound,
      hoursNeeded,
      daysNeeded,
      quotaLimited: hoursNeeded > 1,
    };
  });
}
