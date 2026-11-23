/**
 * 自动回复 IPC
 */
import {
  getConfig, saveConfig, isQuietTime, decide,
  listRules, addRule, updateRule, deleteRule,
  listDrafts, updateDraft, draftCount, discardPendingDrafts,
  listLogs, countLogs, logStats, resetSession,
} from '../../../packages/autorespond/engine.js';
import { requireFeature } from '../src/license-gate.js';
import { getCard, sendCardMessage } from '../src/card-service.js';
import { sendReplyItems } from '../src/rich-reply.js';

export function registerAutoReplyIpc({ ipcMain, sender }) {
  // ── 配置 ──
  ipcMain.handle('ar:getConfig', () => {
    const cfg = getConfig();
    return { ...cfg, quietNow: isQuietTime(cfg) };
  });

  ipcMain.handle('ar:saveConfig', (_e, patch) => {
    // 只是关掉自动回复不拦；开启时才要授权
    if (patch && patch.enabled === true) {
      const deny = requireFeature('autoreply');
      if (deny) return deny;
    }
    return saveConfig(patch);
  });

  // ── 规则 ──
  ipcMain.handle('ar:listRules', () => listRules());
  ipcMain.handle('ar:addRule', (_e, r) => addRule(r));
  ipcMain.handle('ar:updateRule', (_e, id, patch) => updateRule(id, patch));
  ipcMain.handle('ar:deleteRule', (_e, id) => deleteRule(id));

  // ── 草稿 ──
  ipcMain.handle('ar:listDrafts', (_e, opts) => listDrafts(opts ?? {}));
  ipcMain.handle('ar:draftCount', (_e, opts) => ({ count: draftCount(opts?.accountId) }));

  ipcMain.handle('ar:updateDraft', (_e, id, patch) => updateDraft(id, patch));
  ipcMain.handle('ar:discardAllDrafts', (_e, opts) => discardPendingDrafts(opts ?? {}));

  // 发送草稿（人工确认后发送）
  ipcMain.handle('ar:sendDraft', async (_e, draftId) => {
    const deny = requireFeature('autoreply');
    if (deny) return deny;
    const drafts = listDrafts({ status: 'pending', limit: 1000 });
    const d = drafts.find((x) => x.id === draftId);
    if (!d) return { ok: false, error: '草稿不存在' };

    try {
      const sdkKey = await resolveSdkKey(d.account_id);

      // 多消息草稿：按快照顺序发送
      let draftItems = null;
      try {
        draftItems = d.content_json ? JSON.parse(d.content_json)?.items : null;
      } catch {}
      if (Array.isArray(draftItems) && draftItems.length > 1) {
        const sr = await sendReplyItems({
          sender,
          accountId: d.account_id,
          sdkKey,
          peerUid: d.peer_uid,
          items: draftItems,
          scene: 'autoreply',
          skipCompliance: false,
        });
        if (sr.status === 'sent') {
          updateDraft(draftId, { status: 'sent' });
          return { ok: true, results: sr.results };
        }
        if (sr.status === 'partial') {
          updateDraft(draftId, { status: 'partial' });
          return {
            ok: true,
            warning: '部分消息已发送，剩余消息未发送',
            results: sr.results,
          };
        }
        return { ok: false, error: '消息发送失败', results: sr.results };
      }

      // 卡片草稿：先发卡片，再发附带文本
      if (d.card_id) {
        const card = getCard(d.card_id);
        if (!card) return { ok: false, error: '草稿引用的卡片已删除' };
        const r = await sender.sendRich({
          accountId: d.account_id,
          sdkKey,
          peerUid: d.peer_uid,
          text: d.draft_text || '',
          scene: 'autoreply',
          skipThrottle: true,
          skipDailyLimit: true,
          msgType: 'card',
          contentLabel: `[卡片] ${d.card_name || card.name || ''}`,
          transport: async ({ sdk }) => {
            if (!sdk?.ready) return { ok: false, statusCode: -1, statusMsg: '账号未就绪' };
            return sendCardMessage(sdk, d.peer_uid, d.card_id);
          },
        });
        if (r.status !== 'sent') {
          return { ok: false, error: r.detail ?? r.reason ?? '卡片发送失败' };
        }
        if (d.draft_text?.trim()) {
          const tr = await sender.sendOne({
            accountId: d.account_id,
            sdkKey,
            peerUid: d.peer_uid,
            text: d.draft_text,
            scene: 'autoreply',
            skipThrottle: true,
            skipDailyLimit: true,
          });
          if (tr.status !== 'sent') {
            updateDraft(draftId, { status: 'sent' });
            return { ok: true, warning: `卡片已发送，附带文本失败：${tr.detail ?? tr.reason}` };
          }
        }
        updateDraft(draftId, { status: 'sent' });
        return { ok: true, serverMessageId: r.serverMessageId };
      }

      const r = await sender.sendOne({
        accountId: d.account_id,
        sdkKey,
        peerUid: d.peer_uid,
        text: d.draft_text,
        scene: 'autoreply',
        skipThrottle: true,
        skipDailyLimit: true,
      });

      if (r.status === 'sent') {
        updateDraft(draftId, { status: 'sent' });
        return { ok: true, serverMessageId: r.serverMessageId };
      }
      return { ok: false, error: r.detail ?? r.reason ?? '发送失败' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ── 日志 ──
  ipcMain.handle('ar:listLogs', (_e, opts) => listLogs(opts ?? {}));
  ipcMain.handle('ar:logCount', (_e, opts) => ({ count: countLogs(opts ?? {}) }));
  ipcMain.handle('ar:stats', (_e, opts) => logStats(opts ?? {}));

  // ── 会话状态 ──
  ipcMain.handle('ar:resetSession', (_e, accountId, peerUid) => resetSession(accountId, peerUid));

  // ── 测试决策（不发送，用于 UI 预览）──
  ipcMain.handle('ar:test', (_e, { accountId, accountName, peerName, text }) => {
    return decide({
      accountId: accountId ?? 'test',
      accountName: accountName ?? '测试账号',
      peerUid: 'test_peer',
      peerName: peerName ?? '测试用户',
      text,
    });
  });
}

// 由外部注入的解析函数（避免循环依赖）
let resolveSdkKeyFn = async () => null;
export function setSdkKeyResolver(fn) {
  resolveSdkKeyFn = fn;
}
async function resolveSdkKey(accountId) {
  return resolveSdkKeyFn(accountId);
}
