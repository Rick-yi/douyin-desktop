/**
 * 发送服务（所有批量功能的地基）
 *
 * 职责：
 *  - 单条发送：带节流、配额、熔断、日志
 *  - 批量任务：多账号轮换、多文案轮换、进度上报、可暂停/取消
 *
 * 三个批量功能（群发 / 截流 / 自动回复）都走这里。
 */
import { EventEmitter } from 'node:events';
import { Throttle } from './throttle.js';
import { Breaker } from './breaker.js';
import { randomUUID } from 'node:crypto';
import {
  sentToday, recordDmSent, insertPendingMessage, markMessageStatus, ensureConversation,
} from '../../apps/main/src/conversation-repo.js';
import { checkAndRewrite } from '../../apps/main/src/sensitive.js';
import { redact } from '../../apps/main/src/redact.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Sender extends EventEmitter {
  #manager;
  #db;
  #throttle;
  #breaker;
  #tasks = new Map();       // taskId -> { state, cancelled, paused, ... }
  #running = new Set();     // 正在跑的 taskId
  #locks = new Map();       // accountId -> Promise（同账号发送串行化）
  #dryRun = false;          // 演练模式：不真的调用发送
  #gate = null;             // 发送前统一门禁（授权/强制更新）

  constructor({ manager, db, config } = {}) {
    super();
    this.#manager = manager;
    this.#db = db;
    this.#throttle = new Throttle(db, config?.throttle);
    this.#breaker = new Breaker(config?.breaker, db);
    this.#dryRun = !!config?.dryRun;
    this.#gate = typeof config?.gate === 'function' ? config.gate : null;
  }

  /** 重置所有计数（测试用） */
  resetCounters() {
    this.#throttle.resetAll();
    this.#breaker.resetAll();
  }

  /** 切换到演练模式（不发真实消息，只走完整调度逻辑） */
  setDryRun(v) {
    this.#dryRun = !!v;
  }

  get dryRun() {
    return this.#dryRun;
  }

  get throttle() {
    return this.#throttle;
  }
  get breaker() {
    return this.#breaker;
  }

  // ══════════════════════════════════════
  // 单条发送
  // ══════════════════════════════════════

  /**
   * 发送一条（带全部保护）
   *
   * @param {object} p
   * @param {string} p.accountId  本地账号 id
   * @param {string} p.sdkKey     SDK 实例 key（通常是 uid）
   * @param {string} p.peerUid    目标 uid
   * @param {string} p.text       文本
   * @param {string} p.scene      dm | broadcast | intercept | autoreply
   * @param {string} p.taskId     所属任务（可选）
   * @param {boolean} p.skipThrottle 跳过间隔等待（单条手动发送时用）
   * @param {boolean} p.skipDailyLimit 跳过「每人每天一条」去重（手动聊天/回复时用）
   *
   * @returns { status: 'sent'|'failed'|'skipped', reason?, serverMessageId? }
   */
  async sendOne(params) {
    // ★ 同账号串行：配额检查、发送、记账必须在同一把锁里，
    //   否则多个任务并发时会同时通过配额检查导致超额。
    return this.#withAccountLock(params.accountId, () => this.#sendOneUnlocked({
      ...params, msgType: 'text',
    }));
  }

  /**
   * 发送富消息（卡片/图片/文件/表情等）。
   * 配额、熔断、敏感词、每人每日去重、日志与 sendOne 完全共用。
   * transport 负责真正调用 SDK，并返回 { ok, statusCode, statusMsg, checkCode, serverMessageId }。
   */
  async sendRich(params) {
    return this.#withAccountLock(params.accountId, () => this.#sendOneUnlocked({
      ...params,
      msgType: params.msgType ?? 'rich',
    }));
  }

  async #withAccountLock(accountId, fn) {
    const key = String(accountId || '');
    const prev = this.#locks.get(key) ?? Promise.resolve();
    const task = prev.then(fn, fn);
    // 链上只保留完成信号，避免异常中断后续排队
    this.#locks.set(key, task.then(() => {}, () => {}));
    return task;
  }

  async #sendOneUnlocked({
    accountId,
    sdkKey,
    peerUid,
    peerName = null,
    text,
    scene = 'dm',
    taskId = null,
    throttleConfig = null,
    skipThrottle = false,
    skipDailyLimit = false,
    msgType = 'text',
    contentLabel = null,
    transport = null,
    skipCompliance = false,
    skipQuotaRecord = false,
    skipBreaker = false,
    skipQuota = false,
  }) {
    // 0. 统一门禁：授权失效 / 强制更新未完成时，后台任务也不能继续发
    const deny = this.#gate?.({ accountId, scene, taskId });
    if (deny) {
      return {
        status: 'skipped',
        reason: deny.reason || 'license',
        detail: deny.detail || '当前授权状态不允许发送',
      };
    }

    // 1. 熔断检查（neverStop 任务跳过，但风险信号仍会记账）
    const tripped = skipBreaker ? null : this.#breaker.isTripped(accountId);
    if (tripped) {
      const result = {
        status: 'skipped',
        reason: 'breaker',
        detail: `账号冷却中，还需 ${tripped.remainingMin} 分钟（${tripped.reason}）`,
      };
      this.#writeLog({
        accountId, taskId, scene, peerUid, text, result, msgType, contentLabel,
      });
      return result;
    }

    // 1.2 账号类型硬上限：个人号 60/天，蓝V 150/天（neverStop 也不能突破）
    const hardDaily = this.#throttle.hardDailyLimit(accountId);
    const usedDaily = this.#throttle.usage(accountId).daily;
    if (usedDaily >= hardDaily) {
      const result = {
        status: 'skipped',
        reason: 'account_daily_cap',
        detail: `已达账号每日上限 ${hardDaily} 条（${usedDaily}/${hardDaily}）`,
        verifyLevel: 'fail',
      };
      this.#writeLog({
        accountId, taskId, scene, peerUid, text, result, msgType, contentLabel,
      });
      return result;
    }

    // 1.5 合规检查 + 合规改写（阻断级才拦，其余使用改写后的文本发送）
    let finalText = text;
    if (!skipCompliance) {
      try {
        const check = checkAndRewrite(text, scene, { accountId });
        if (check.blocked) {
          const words = (check.before?.hits ?? [])
            .filter((h) => h.action === 'block')
            .map((h) => h.word);
          const result = {
            status: 'skipped',
            reason: 'sensitive_blocked',
            detail: `命中阻断词：${words.join('、') || '需要人工修改'}`,
          };
          this.#writeLog({
            accountId, taskId, scene, peerUid, text, result, msgType, contentLabel,
          });
          return result;
        }
        finalText = check.text ?? text;
      } catch (e) {
        console.error('[sender] 合规检查失败', e.message);
      }
    }
    // 记录实际发出的文本，调用方可同步 UI/结果页
    const sentText = finalText;

    // 2. 每目标每日限制（平台硬规则：同一人未回复前消息有上限）
    // 手动聊天和自动回复不加这条：用户正在对话，不能只发一条就锁死。
    if (!skipDailyLimit && sentToday(accountId, peerUid)) {
      const result = {
        status: 'skipped',
        reason: 'peer_sent_today',
        detail: '今天已给该目标发过消息（平台限制：对方回复前有上限）',
      };
      this.#writeLog({
        accountId, taskId, scene, peerUid, text, result, msgType, contentLabel,
      });
      return result;
    }

    // 3. 配额检查（neverStop 任务跳过）
    const quota = skipQuota
      ? { allowed: true }
      : this.#throttle.checkQuota(accountId, throttleConfig);
    if (!quota.allowed) {
      const result = {
        status: 'skipped',
        reason: quota.reason,
        detail:
          quota.reason === 'hourly_limit'
            ? `已达每小时上限 ${quota.limit} 条`
            : `已达每日上限 ${quota.limit} 条`,
      };
      this.#writeLog({
        accountId, taskId, scene, peerUid, text, result, msgType, contentLabel,
      });
      return result;
    }

    // 4. 等间隔
    if (!skipThrottle) {
      await this.#throttle.waitTurn(accountId, throttleConfig);
    }

    // 5. 发送（演练模式下不真的发）
    if (this.#dryRun) {
      // 模拟网络延迟
      await sleep(150 + Math.random() * 250);
      const result = {
        status: 'sent',
        serverMessageId: 'DRYRUN_' + Date.now(),
        clientMessageId: 'dryrun',
        statusCode: 0,
        statusMsg: 'OK (dry-run)',
        verifyLevel: 'strong',
        dryRun: true,
      };
      if (!skipQuotaRecord) {
        this.#throttle.record(accountId);
        // ★ dry-run 也要记录去重，否则「每人每日 1 条」的验证会失真
        try {
          recordDmSent(accountId, peerUid);
        } catch (e) {}
      }
      this.#writeLog({
        accountId, taskId, scene, peerUid, text: finalText, result, msgType, contentLabel,
      });
      return result;
    }

    const sdk = this.#manager.get(sdkKey) ?? this.#manager.instance(sdkKey);
    let result;
    try {
      const r = transport
        ? await transport({ sdk, peerUid, text: finalText })
        : await sdk.sendToUid(peerUid, finalText);
      result = {
        status: r.ok ? 'sent' : 'failed',
        serverMessageId: r.serverMessageId ?? null,
        clientMessageId: r.clientMessageId ?? null,
        statusCode: r.statusCode,
        statusMsg: r.statusMsg,
        checkCode: r.checkCode,
        verifyLevel: r.ok ? 'strong' : 'fail',
      };

      // 6. 检查响应里的风控信号
      const risk = this.#breaker.checkResponse(accountId, {
        statusCode: r.statusCode,
        statusMsg: r.statusMsg,
        checkCode: r.checkCode,
      });

      // ★ 对方消息达上限：这是平台规则，不是账号问题
      // 该目标以后也发不了（除非对方回复），标记为 peer_limited 并跳过
      if (risk.peerLimited) {
        result.status = 'skipped';
        result.reason = 'peer_limited';
        result.detail = '对方消息已达上限，需其回复后才能再发';
        result.verifyLevel = 'fail';
      }

      // 对方关闭私信/仅互关/不支持私信：目标级限制，不重试、不熔断账号
      if (risk.peerBlocked) {
        result.status = 'skipped';
        result.reason = 'peer_forbidden';
        result.detail = '对方私信权限受限，无法发送';
        result.verifyLevel = 'fail';
      }

      // 账号级频率限制：目标保留 approved，账号短暂冷却后重试
      if (risk.rateLimited) {
        result.status = 'skipped';
        result.reason = 'rate_limited';
        result.detail = '陌生人私信频率限制，稍后自动重试';
        result.rateLimited = true;
        result.verifyLevel = 'fail';
      }

      // 账号私信功能被封禁：目标保留 approved，不消费线索
      if (risk.restricted) {
        result.status = 'skipped';
        result.reason = 'account_restricted';
        result.detail = '账号私信功能暂被封禁，目标已保留';
        result.verifyLevel = 'fail';
      }

      if (risk.tripped) {
        result.riskTripped = risk.reason;
      }
    } catch (e) {
      const msg = e.message || String(e);
      const checkCode = Number((msg.match(/check=(\d+)/) || [])[1]);

      // ★ SDK 在业务失败时可能抛异常而不是返回错误码（实测）
      // 例："消息发送失败: status=3 check=7467 给对方发送的消息已达上限..."
      // 这类是「对方达上限」，属于平台规则，不是账号问题
      const isPeerLimited =
        /消息已达上限/.test(msg) ||
        /对方回复或互关/.test(msg) ||
        /对方回复后才能/.test(msg) ||
        /需对方回复/.test(msg) ||
        checkCode === 7467 ||
        /status=3/.test(msg) && /上限/.test(msg);

      // 对方私信权限类：永久性目标限制，跳过且不熔断账号
      const isPeerForbidden =
        [7173, 7278, 10801].includes(checkCode) ||
        /仅和他互关/.test(msg) ||
        /陌生人不可私信/.test(msg) ||
        /私信功能暂被关闭/.test(msg) ||
        /暂不支持发送私信/.test(msg);

      // 账号需要去 App 完成身份验证：立即停号，避免继续消耗线索
      const needsVerify =
        checkCode === 22006 ||
        /请使用抖音App发送消息后完成身份验证/.test(msg);
      const isRateLimited =
        checkCode === 7180 ||
        /给陌生人发送消息过于频繁/.test(msg) ||
        /稍后再发送陌生人消息/.test(msg);
      const isAccountRestricted =
        checkCode === 7177 ||
        /你的私信功能暂被封禁/.test(msg) ||
        /你的私信功能已被封禁/.test(msg);

      if (isRateLimited) {
        result = {
          status: 'skipped',
          reason: 'rate_limited',
          detail: '陌生人私信频率限制，稍后自动重试',
          rateLimited: true,
          verifyLevel: 'fail',
        };
      } else if (isAccountRestricted) {
        result = {
          status: 'skipped',
          reason: 'account_restricted',
          detail: '账号私信功能暂被封禁，目标已保留',
          verifyLevel: 'fail',
        };
      } else if (needsVerify) {
        this.#breaker.trip(accountId, '需在抖音App完成身份验证');
        result = {
          status: 'skipped',
          reason: 'account_verify_required',
          detail: '账号需在抖音 App 完成身份验证，已暂停该账号',
          verifyLevel: 'fail',
        };
      } else if (isPeerForbidden) {
        result = {
          status: 'skipped',
          reason: 'peer_forbidden',
          detail: '对方私信权限受限，无法发送',
          verifyLevel: 'fail',
        };
      } else if (isPeerLimited) {
        result = {
          status: 'skipped',
          reason: 'peer_limited',
          detail: '对方消息已达上限，需其回复后才能再发',
          verifyLevel: 'fail',
        };
        // 记入 dm_history：避免下次再撞
        try {
          recordDmSent(accountId, peerUid);
        } catch (err) {}
      } else {
        result = {
          status: 'failed',
          reason: 'exception',
          detail: msg,
          verifyLevel: 'fail',
        };
      }
    }

    // 7. 记账（只有真的发出去才计数；卡片配套文本已经记过账时跳过）
    if (result.status === 'sent' && !skipQuotaRecord) {
      this.#throttle.record(accountId);
      try {
        recordDmSent(accountId, peerUid);
      } catch (e) {
        console.error('[sender] 记录 dm_history 失败', e.message);
      }
    }

    // 8. 失败率熔断（peer_limited 不算账号失败，不计入失败率）
    const isAccountFailure = result.status === 'failed' && result.reason !== 'peer_limited';
    const brk = isAccountFailure ? this.#breaker.record(accountId, false) : this.#breaker.record(accountId, true);
    if (brk.tripped && !result.riskTripped) {
      result.riskTripped = brk.reason;
    }

    // 9. 写日志
    this.#writeLog({
      accountId,
      taskId,
      scene,
      peerUid,
      text: finalText,
      result,
      msgType,
      contentLabel,
    });

    // 10. 自动回复也要出现在聊天记录里；手动聊天已在 IPC 层先落库，避免重复
    if (scene === 'autoreply' && result.status === 'sent') {
      try {
        const clientId = `auto_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const stored = insertPendingMessage(accountId, peerUid, {
          text: msgType === 'card' ? (contentLabel || finalText) : finalText,
          clientMessageId: clientId,
          msgType,
          messageType: msgType === 'card' ? 26 : 7,
        });
        if (stored) {
          markMessageStatus(accountId, peerUid, {
            clientMessageId: clientId,
            status: 'sent',
            serverMessageId: result.serverMessageId,
          });
        }
      } catch (e) {
        console.warn('[sender] 自动回复写聊天记录失败:', e.message);
      }
    }

    // 11. 线索雷达/群发任务也要写进本地会话，聊天列表才看得到
    if (!result.dryRun && result.status === 'sent'
        && (scene === 'intercept' || scene === 'broadcast')) {
      try {
        ensureConversation(accountId, peerUid, {
          nickname: peerName ?? null,
          kind: 'stranger',
        });
        const clientId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const stored = insertPendingMessage(accountId, peerUid, {
          text: msgType === 'card' ? (contentLabel || finalText) : finalText,
          clientMessageId: clientId,
          msgType,
          messageType: msgType === 'card' ? 26 : 7,
        });
        if (stored) {
          markMessageStatus(accountId, peerUid, {
            clientMessageId: clientId,
            status: 'sent',
            serverMessageId: result.serverMessageId,
          });
        }
      } catch (e) {
        console.warn('[sender] 任务消息写聊天记录失败:', e.message);
      }
    }

    return { ...result, sentText };
  }

  #writeLog({
    accountId, taskId, scene, peerUid, text, result,
    msgType = 'text', contentLabel = null,
  }) {
    try {
      this.#db
        .prepare(
          `INSERT INTO send_log
            (id, account_id, scene, task_id, peer_uid, content, msg_type,
             status, reason, verify_level, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          accountId,
          scene,
          taskId,
          peerUid,
          redact(contentLabel ?? text),
          msgType,
          result.status,
          redact(result.detail ?? result.statusMsg ?? null),
          result.verifyLevel ?? null,
          Date.now(),
        );
    } catch (e) {
      console.error('[sender] 写日志失败', e.message);
    }
  }

  // ══════════════════════════════════════
  // 批量任务
  // ══════════════════════════════════════

  /**
   * 创建任务（不启动）
   *
   * @param {object} p
   * @param {string} p.kind          broadcast | intercept
   * @param {string} p.name
   * @param {Array<{accountId, sdkKey}>} p.accounts  参与账号（轮换）
   * @param {Array<{uid, name}>} p.targets           收件人
   * @param {string[]} p.contents                    文案列表（轮换）
   * @param {'random'|'sequence'} p.strategy
   * @param {object} p.throttle      { gapMinSec, gapMaxSec, hourlyLimit, dailyLimit, batchSize, roundWaitSec }
   */
  createTask({
    id: presetId = null,
    dbTaskId = null,
    persist = true,
    kind,
    name,
    accounts,
    targets,
    contents,
    strategy = 'random',
    throttle = {},
    scheduledAt = null,
    neverStop = false,
  }) {
    if (!accounts?.length) throw new Error('没有参与账号');
    if (!targets?.length) throw new Error('没有收件人');
    if (!contents?.length) throw new Error('没有文案');

    // ★ 截流等外部模块可传 id 并关闭落库，直接复用自己那张任务表
    if (presetId && this.#tasks.has(presetId)) {
      throw new Error('该任务已在运行或已结束，请新建任务');
    }

    const id = presetId || randomUUID();
    const state = {
      id,
      // ★ 用于落库/写日志的任务 id。截流允许同一个任务分多批发，
      //   运行期 id 必须唯一，但日志和 outreach_task 仍归到原任务上。
      dbTaskId: dbTaskId || id,
      kind,
      name: name || '未命名',
      accounts,
      targets,
      contents: contents.filter((c) => c && c.trim()),
      strategy,
      throttle: {
        gapMinSec: 8,
        gapMaxSec: 30,
        hourlyLimit: 5,
        dailyLimit: 20,
        batchSize: 5,        // 每账号连发 N 条后换号
        roundWaitSec: 300,   // 全部轮完等多久
        ...throttle,
      },
      cursor: 0,             // 已处理到第几个 target
      accIdx: 0,             // 当前账号索引
      accSent: 0,            // 当前账号已发几条
      contentIdx: 0,
      lastContentIdx: -1,
      success: 0,
      fail: 0,
      skipped: 0,
      paused: false,
      cancelled: false,
      running: false,
      /** 任何错误只跳过，不因熔断/配额/异常停止整个任务 */
      neverStop: !!neverStop,
      startedAt: null,
      finishedAt: null,
      scheduledAt: Number(scheduledAt) || null,
      results: [],
    };

    // 落库
    if (persist) {
      this.#db
        .prepare(
          `INSERT INTO outreach_task
            (id, kind, name, account_ids, target_mode, target_count,
             content_type, content_items, content_strategy,
             gap_sec, batch_size, round_wait_sec, daily_limit, hourly_limit,
             targets_json, throttle_json,
             scheduled_at, stage, created_at)
           VALUES (?, ?, ?, ?, 'import', ?, 'text', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`,
        )
        .run(
          id,
          kind,
          state.name,
          JSON.stringify(accounts.map((a) => a.accountId)),
          targets.length,
          JSON.stringify(state.contents),
          strategy,
          Math.round((state.throttle.gapMinSec + state.throttle.gapMaxSec) / 2),
          state.throttle.batchSize,
          state.throttle.roundWaitSec,
          state.throttle.dailyLimit,
          state.throttle.hourlyLimit,
          JSON.stringify(targets),
          JSON.stringify(state.throttle),
          state.scheduledAt,
          Date.now(),
        );
    }

    this.#tasks.set(id, state);
    return this.publicState(state);
  }

  /** 启动（后台跑，立即返回） */
  /**
   * 定时启动：到点后自动 run。任务状态保存在内存，应用重启后定时器会丢。
   */
  schedule(taskId, at) {
    const state = this.#tasks.get(taskId);
    if (!state) throw new Error('任务不存在');
    const when = Number(at);
    if (!Number.isFinite(when) || when <= Date.now()) return this.run(taskId);
    state.scheduledAt = when;
    this.#updateDb(state.dbTaskId, { scheduled_at: when });
    const delay = Math.min(when - Date.now(), 2147483647);
    setTimeout(() => {
      this.run(taskId).catch((e) => console.error('[sender] 定时启动失败', e.message));
    }, delay);
    return this.publicState(state);
  }

  async run(taskId) {
    const state = this.#tasks.get(taskId);
    if (!state) throw new Error('任务不存在');
    if (state.running) throw new Error('任务已在运行');

    state.running = true;
    state.paused = false;
    state.startedAt = Date.now();
    this.#running.add(taskId);
    this.#updateDb(taskId, { stage: 'running', started_at: state.startedAt });

    // ★ 不再 setConfig 全局覆盖：每个任务用 state.throttle 显式传参，
    //   多个任务并发时不会互相改掉对方的间隔/配额。

    this.#loop(state).catch((e) => {
      console.error(`[sender] 任务 ${taskId} 异常`, e);
      state.running = false;
      this.#running.delete(taskId);
    });

    return this.publicState(state);
  }

  async #loop(state) {
    const { targets, contents } = state;

    while (state.cursor < targets.length) {
      // 暂停 / 取消检查
      if (state.cancelled) break;
      if (state.paused) {
        await sleep(500);
        continue;
      }

      // ★ 发送前再检查一次（发送是异步的，等待期间可能被暂停）
      const wasPaused = state.paused;

      const target = targets[state.cursor];
      const acc = state.accounts[state.accIdx % state.accounts.length];

      // 账号类型硬上限：个人号 60/天，蓝V 150/天
      const hardDaily = this.#throttle.hardDailyLimit(acc.accountId);
      if (this.#throttle.usage(acc.accountId, state.throttle).daily >= hardDaily) {
        this.#emitProgress(state, {
          type: 'account_daily_cap',
          accountId: acc.accountId,
          limit: hardDaily,
        });
        const nextIdx = state.accounts.findIndex(
          (a) => this.#throttle.usage(a.accountId, state.throttle).daily
            < this.#throttle.hardDailyLimit(a.accountId),
        );
        if (nextIdx >= 0) {
          state.accIdx = nextIdx;
          state.accSent = 0;
          continue;
        }
        this.#logRemainingSkipped(state, 'account_daily_cap', `已达账号每日上限 ${hardDaily} 条`);
        state.skipped += targets.length - state.cursor;
        this.#emitProgress(state, { type: 'all_daily_capped' });
        break;
      }

      // 熔断检查：默认跳过该账号；neverStop 任务只记录，不停止
      const tripped = state.neverStop ? null : this.#breaker.isTripped(acc.accountId);
      if (tripped) {
        this.#emitProgress(state, {
          type: 'account_tripped',
          accountId: acc.accountId,
          reason: tripped.reason,
        });
        // 所有账号都熔断了才停
        const allTripped = state.accounts.every((a) => this.#breaker.isTripped(a.accountId));
        if (allTripped) {
          this.#logRemainingSkipped(state, 'all_tripped', tripped.reason);
          state.skipped += targets.length - state.cursor;
          this.#emitProgress(state, { type: 'all_tripped' });
          break;
        }
        state.accIdx = (state.accIdx + 1) % state.accounts.length;
        state.accSent = 0;
        continue;
      }

      // 配额检查（neverStop 任务不因配额停）
      const quota = state.neverStop
        ? { allowed: true }
        : this.#throttle.checkQuota(acc.accountId, state.throttle);
      if (!quota.allowed) {
        this.#emitProgress(state, {
          type: 'quota_exhausted',
          accountId: acc.accountId,
          reason: quota.reason,
        });
        state.accIdx = (state.accIdx + 1) % state.accounts.length;
        state.accSent = 0;
        // 所有账号都超配额则停
        const allQuota = state.accounts.every(
          (a) => !this.#throttle.checkQuota(a.accountId, state.throttle).allowed,
        );
        if (allQuota) {
          this.#logRemainingSkipped(state, 'all_quota', quota.reason);
          state.skipped += targets.length - state.cursor;
          this.#emitProgress(state, { type: 'all_quota_exhausted' });
          break;
        }
        continue;
      }

      // 取文案
      const text = this.#pickContent(state);

      // 发送：单条任何异常都降级为 failed，不中断整个任务
      let r;
      try {
        r = await this.sendOne({
          accountId: acc.accountId,
          sdkKey: acc.sdkKey,
          peerUid: target.uid,
          peerName: target.name ?? null,
          text,
          scene: state.kind,
          taskId: state.dbTaskId,
          throttleConfig: state.throttle,
          skipBreaker: !!state.neverStop,
          skipQuota: !!state.neverStop,
        });
      } catch (e) {
        r = {
          status: 'failed',
          reason: 'exception',
          detail: e.message || String(e),
        };
      }

      // 失败/跳过也要更新尝试时间，否则连续失败会零间隔连打
      try { this.#throttle.recordAttempt(acc.accountId); } catch {}

      if (r.status === 'sent') state.success++;
      else if (r.status === 'skipped') state.skipped++;
      else state.fail++;

      state.results.push({
        targetUid: target.uid,
        targetName: target.name,
        itemId: target.itemId ?? null,
        accountId: acc.accountId,
        // 记录实际发出的文本（sendOne 内部可能做了合规替换）
        text: r.sentText ?? text,
        status: r.status,
        reason: r.detail ?? r.statusMsg ?? null,
        reasonCode: r.reason ?? null,
        serverMessageId: r.serverMessageId ?? null,
      });

      // ★ 如果发送期间被暂停/取消，这条已经发出去了，仍要计数
      // 但不再继续循环（下面循环顶部会检查）
      state.cursor++;
      state.accSent++;

      this.#emitProgress(state, {
        type: 'item',
        index: state.cursor,
        total: targets.length,
        target: target.name || target.uid,
        status: r.status,
        reason: r.detail ?? null,
      });
      this.#updateDb(state.dbTaskId, {
        progress: state.cursor,
        success_count: state.success,
        fail_count: state.fail,
      });

      // 换号时机
      if (state.accSent >= state.throttle.batchSize) {
        state.accIdx = (state.accIdx + 1) % state.accounts.length;
        state.accSent = 0;
        // 一轮轮完，等一下
        if (state.accIdx === 0 && state.cursor < targets.length) {
          const wait = state.throttle.roundWaitSec * 1000;
          this.#emitProgress(state, { type: 'round_wait', ms: wait });
          await this.#sleepCancellable(state, wait);
        }
      }
    }

    state.running = false;
    state.finishedAt = Date.now();
    this.#running.delete(state.id);
    this.#updateDb(state.dbTaskId, {
      stage: state.cancelled ? 'cancelled' : 'done',
      finished_at: state.finishedAt,
      success_count: state.success,
      fail_count: state.fail,
    });

    this.#emitProgress(state, {
      type: 'done',
      success: state.success,
      fail: state.fail,
      skipped: state.skipped,
      total: targets.length,
    });
  }

  async #sleepCancellable(state, ms) {
    const step = 500;
    let left = ms;
    while (left > 0 && !state.cancelled) {
      // 暂停时不计时，等恢复
      if (state.paused) {
        await sleep(500);
        continue;
      }
      await sleep(Math.min(step, left));
      left -= step;
    }
  }

  #logRemainingSkipped(state, reason, detail) {
    const acc = state.accounts[state.accIdx % state.accounts.length] ?? state.accounts[0];
    if (!acc) return;
    for (let i = state.cursor; i < state.targets.length; i++) {
      this.#writeLog({
        accountId: acc.accountId,
        taskId: state.dbTaskId,
        scene: state.kind,
        peerUid: state.targets[i].uid,
        text: '',
        result: {
          status: 'skipped',
          reason,
          detail: detail || reason,
          verifyLevel: 'fail',
        },
      });
    }
  }

  #pickContent(state) {
    const n = state.contents.length;
    if (n === 1) return state.contents[0];

    if (state.strategy === 'sequence') {
      const text = state.contents[state.contentIdx % n];
      state.contentIdx++;
      return text;
    }

    // random：避免连续重复
    let idx;
    let guard = 0;
    do {
      idx = Math.floor(Math.random() * n);
      guard++;
    } while (idx === state.lastContentIdx && n > 1 && guard < 20);
    state.lastContentIdx = idx;
    return state.contents[idx];
  }

  #emitProgress(state, ev) {
    const payload = { taskId: state.id, dbTaskId: state.dbTaskId, ...ev, state: this.publicState(state) };
    this.emit('progress', payload);
  }

  #updateDb(taskId, patch) {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    try {
      this.#db
        .prepare(`UPDATE outreach_task SET ${sets} WHERE id = ?`)
        .run(...keys.map((k) => patch[k]), taskId);
    } catch (e) {
      console.error('[sender] 更新任务失败', e.message);
    }
  }

  publicState(state) {
    return {
      id: state.id,
      dbTaskId: state.dbTaskId,
      kind: state.kind,
      name: state.name,
      status: state.cancelled
        ? 'cancelled'
        : state.running
          ? state.paused ? 'paused' : 'running'
          : state.paused
            ? 'paused'
            : state.finishedAt ? 'done' : 'draft',
      total: state.targets.length,
      progress: state.cursor,
      success: state.success,
      fail: state.fail,
      skipped: state.skipped,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      accounts: state.accounts.length,
      throttle: state.throttle,
      neverStop: state.neverStop,
      scheduledAt: state.scheduledAt ?? null,
      dryRun: this.#dryRun,
    };
  }

  getTask(taskId) {
    const s = this.#tasks.get(taskId);
    return s ? this.publicState(s) : null;
  }

  /** 逐条结果（截流等模块用来回写 outreach_item） */
  getResults(taskId) {
    return this.#tasks.get(taskId)?.results ?? [];
  }

  listTasks() {
    return [...this.#tasks.values()].map((s) => this.publicState(s));
  }

  /**
   * 启动时恢复群发任务。
   * 目标/文案/节流参数在创建时已落库，重启后重建内存状态：
   *  - 原来 running 的转 paused，等用户点「继续」
   *  - 原来 draft 的保持 draft，可以直接启动
   *  - 未来的定时任务重新挂定时器
   *  - 老版本没有 targets_json 的 running 任务标记 cancelled，避免卡 running
   */
  recoverTasks() {
    if (!this.#db) return { recovered: 0 };
    let recovered = 0;
    try {
      // 老数据：没有目标快照，无法恢复
      const legacy = this.#db
        .prepare(
          `SELECT id FROM outreach_task
           WHERE kind = 'broadcast' AND stage IN ('running', 'paused')
             AND (targets_json IS NULL OR targets_json = '')`,
        )
        .all();
      for (const row of legacy) this.#updateDb(row.id, { stage: 'cancelled' });
      if (legacy.length) console.log(`[sender] ${legacy.length} 个旧任务缺少目标快照，已标记取消`);

      const rows = this.#db
        .prepare(
          `SELECT * FROM outreach_task
           WHERE kind = 'broadcast' AND stage IN ('draft', 'running', 'paused', 'scheduled')
             AND targets_json IS NOT NULL AND targets_json <> ''
           ORDER BY created_at ASC`,
        )
        .all();

      for (const row of rows) {
        if (this.#tasks.has(row.id)) continue;
        let targets = [];
        let contents = [];
        let throttle = {};
        let accountIds = [];
        try {
          targets = JSON.parse(row.targets_json || '[]');
          contents = JSON.parse(row.content_items || '[]');
          throttle = JSON.parse(row.throttle_json || '{}');
          accountIds = JSON.parse(row.account_ids || '[]');
        } catch {
          this.#updateDb(row.id, { stage: 'cancelled' });
          continue;
        }
        if (!targets.length || !contents.length) {
          this.#updateDb(row.id, { stage: 'cancelled' });
          continue;
        }

        const accounts = [];
        for (const accountId of accountIds) {
          const acc = this.#db
            .prepare('SELECT id, uid, nickname FROM account WHERE id = ?')
            .get(accountId);
          if (acc?.uid) {
            accounts.push({ accountId: acc.id, sdkKey: String(acc.uid), nickname: acc.nickname });
          }
        }
        if (!accounts.length) {
          this.#updateDb(row.id, { stage: 'cancelled' });
          continue;
        }

        const cursor = Math.min(Math.max(0, Number(row.progress) || 0), targets.length);
        const state = {
          id: row.id,
          dbTaskId: row.id,
          kind: row.kind,
          name: row.name || '未命名',
          accounts,
          targets,
          contents,
          strategy: row.content_strategy === 'sequence' ? 'sequence' : 'random',
          throttle: {
            gapMinSec: 8,
            gapMaxSec: 30,
            hourlyLimit: 5,
            dailyLimit: 20,
            batchSize: 5,
            roundWaitSec: 300,
            ...throttle,
          },
          cursor,
          accIdx: 0,
          accSent: 0,
          contentIdx: 0,
          lastContentIdx: -1,
          success: Number(row.success_count) || 0,
          fail: Number(row.fail_count) || 0,
          skipped: 0,
          paused: row.stage === 'running' || row.stage === 'paused',
          cancelled: false,
          running: false,
          startedAt: row.started_at ?? null,
          finishedAt: null,
          scheduledAt: Number(row.scheduled_at) || null,
          results: [],
        };

        if (cursor >= targets.length) {
          this.#updateDb(row.id, { stage: 'done', finished_at: Date.now() });
          continue;
        }

        this.#tasks.set(row.id, state);
        const at = Number(row.scheduled_at) || 0;
        if (at > Date.now() && !state.paused) {
          this.schedule(row.id, at);
        } else if (state.paused) {
          this.#updateDb(row.id, { stage: 'paused' });
        }
        recovered++;
      }
      if (recovered) {
        console.log(`[sender] 已恢复 ${recovered} 个群发任务（可继续/启动）`);
      }
    } catch (e) {
      console.error('[sender] 恢复群发任务失败', e.message);
    }
    return { recovered };
  }

  pause(taskId) {
    const s = this.#tasks.get(taskId);
    if (s?.running) s.paused = true;
    return s ? this.publicState(s) : null;
  }

  resume(taskId) {
    const s = this.#tasks.get(taskId);
    if (!s) return null;
    s.paused = false;
    // 应用重启后恢复出来的任务没有正在跑的循环，需要重新拉起来
    if (!s.running && !s.cancelled && s.cursor < s.targets.length) {
      this.run(taskId).catch((e) => console.error('[sender] 恢复任务失败', e.message));
    }
    return this.publicState(s);
  }

  async cancel(taskId) {
    const s = this.#tasks.get(taskId);
    if (!s) return null;
    s.cancelled = true;
    s.paused = false;
    return this.publicState(s);
  }
}
