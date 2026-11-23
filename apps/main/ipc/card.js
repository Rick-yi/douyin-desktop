/**
 * 卡片管理 IPC（只支持跳转卡）
 */
import { requireFeature } from '../src/license-gate.js';
import {
  addLinkCard, listCards, listCardGroups, getCard,
  updateCard, deleteCard, bumpCardUse,
} from '../src/card-service.js';
import { getAccount } from '../src/account-repo.js';
import { checkAndRewrite } from '../src/sensitive.js';
import { redact } from '../src/redact.js';
import { insertPendingMessage, markMessageStatus, getConversation, recordDmSent } from '../src/conversation-repo.js';

export function registerCardIpc({ ipcMain, manager, sender, isBlocked }) {
  // ── 新建跳转卡片 ──
  ipcMain.handle('card:addLink', async (_e, payload = {}) => {
    try {
      const added = addLinkCard(payload);
      return { ok: true, added };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ── 列表 ──
  ipcMain.handle('card:list', (_e, opts) => listCards(opts ?? {}));
  ipcMain.handle('card:groups', () => listCardGroups());
  ipcMain.handle('card:get', (_e, id) => getCard(id));

  // ── 修改 ──
  ipcMain.handle('card:update', (_e, id, patch) => updateCard(id, patch));
  ipcMain.handle('card:delete', (_e, id, opts) => deleteCard(id, opts ?? {}));

  // ── 发送卡片 ──
  ipcMain.handle('card:send', async (_e, { cardId, accountId, peerUid, text }) => {
    const deny = requireFeature('send');
    if (deny) return deny;
    if (isBlocked?.()) return { ok: false, reason: 'update_required', error: '请先完成强制更新' };
    const acc = getAccount(accountId);
    if (!acc?.uid) return { ok: false, error: '账号不存在' };
    if (!peerUid) return { ok: false, error: '请选择接收人' };

    const card = getCard(cardId);
    if (!card) return { ok: false, error: '卡片不存在' };
    if (card.kind !== 'link') return { ok: false, error: '只支持跳转卡片' };

    const sdk = manager.get(String(acc.uid));
    if (!sdk?.ready) return { ok: false, error: '账号未就绪，请先到账号管理检查登录' };

    // 卡片也是消息：纳入熔断/配额/去重记账，避免绕开发送保护
    const tripped = sender?.breaker?.isTripped?.(acc.id);
    if (tripped) {
      return {
        ok: false,
        error: `账号冷却中，还需 ${tripped.remainingMin} 分钟（${tripped.reason}）`,
      };
    }
    const quota = sender?.throttle?.checkQuota?.(acc.id);
    if (quota && quota.allowed === false) {
      return {
        ok: false,
        error: quota.reason === 'hourly_limit'
          ? `已达每小时发送上限 ${quota.limit} 条`
          : `已达每日发送上限 ${quota.limit} 条`,
      };
    }

    // 配套文本过敏感词
    let finalText = String(text ?? '');
    if (finalText) {
      const chk = checkAndRewrite(finalText, 'dm', { accountId: acc.id });
      if (chk.blocked) {
        return {
          ok: false,
          error: `配套文本含阻断词：${
            (chk.before?.hits ?? [])
              .filter((h) => h.action === 'block')
              .map((h) => h.word)
              .join('、') || '需要人工修改'
          }`,
        };
      }
      finalText = chk.text || finalText;
    }

    const warnings = [];
    let r;
    try {
      r = await sdk.sendLinkCard(peerUid, {
        url: card.linkUrl,
        title: card.linkTitle ?? '',
        description: card.linkDesc ?? '',
        coverUrl: card.linkCoverUrl ?? '',
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }

    if (!r.ok) {
      try {
        sender?.breaker?.checkResponse?.(acc.id, {
          statusCode: r.statusCode,
          statusMsg: r.statusMsg,
          checkCode: r.checkCode,
        });
        sender?.breaker?.record?.(acc.id, false);
      } catch {}
      return { ok: false, error: `code=${r.statusCode} ${r.statusMsg}` };
    }

    // 成功：记配额、记去重、记熔断（卡片本身算一条消息）
    try {
      const risk = sender?.breaker?.checkResponse?.(acc.id, {
        statusCode: r.statusCode,
        statusMsg: r.statusMsg,
        checkCode: r.checkCode,
      });
      if (risk?.tripped) warnings.push(`命中风控信号：${risk.reason}`);
      sender?.throttle?.record?.(acc.id);
      sender?.breaker?.record?.(acc.id, true);
      recordDmSent(acc.id, peerUid);
    } catch (e) {
      console.warn('[card:send] 发送记账失败', e.message);
    }

    // 配套文本单独发一条（卡片消息本身不带文本）
    if (finalText) {
      try {
        if (sender?.sendOne) {
          // 走统一发送链路：合规、熔断、错误映射都收口；配额/去重已由卡片记过
          const tr = await sender.sendOne({
            accountId: acc.id,
            sdkKey: String(acc.uid),
            peerUid,
            text: finalText,
            scene: 'dm',
            skipDailyLimit: true,
            skipQuotaRecord: true,
          });
          if (tr.status !== 'sent') {
            warnings.push(`配套文本发送失败：${tr.detail || tr.reason || tr.status}`);
          }
        } else {
          const t = await sdk.sendToUid(peerUid, finalText);
          if (!t.ok) warnings.push(`配套文本发送失败：code=${t.statusCode} ${t.statusMsg}`);
        }
      } catch (e) {
        warnings.push(`配套文本发送失败：${e.message}`);
      }
    }

    bumpCardUse(cardId);

    // 把卡片写进聊天记录，打开会话时能看到刚发的卡片
    try {
      if (getConversation(acc.id, peerUid)) {
        const clientId = `card_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const text = card.linkTitle || card.name;
        const mediaUrl = card.linkCoverUrl || null;
        const rawContent = JSON.stringify({
          link_url: card.linkUrl,
          title: card.linkTitle || card.name,
          desc: card.linkDesc || '',
          cover_url: card.linkCoverUrl || '',
        });

        insertPendingMessage(acc.id, peerUid, {
          text,
          clientMessageId: clientId,
          msgType: 'link',
          mediaPath: null,
          mediaUrl,
          rawContent,
        });
        markMessageStatus(acc.id, peerUid, {
          clientMessageId: clientId,
          status: 'sent',
          serverMessageId: r.serverMessageId,
        });
      }
    } catch (e) {
      console.warn('[card:send] 写聊天记录失败', e.message);
    }

    try {
      const { db_ } = await import('../src/db.js');
      const { randomUUID } = await import('node:crypto');
      const label = `[跳转卡片] ${card.linkTitle || card.name} ${card.linkUrl || ''}`;
      db_().prepare(
        `INSERT INTO send_log
           (id, account_id, scene, peer_uid, content, msg_type, status, reason, verify_level, created_at)
         VALUES (?, ?, 'dm', ?, ?, 'card', 'sent', ?, 'strong', ?)`,
      ).run(
        randomUUID(), acc.id, peerUid,
        redact(`${label}${finalText ? ' + ' + finalText : ''}`),
        redact(r.checkCode ? `checkCode=${r.checkCode}` : null),
        Date.now(),
      );
    } catch {}

    if (r.checkCode && r.checkCode !== 0) {
      warnings.push(`服务端返回 checkCode=${r.checkCode}，建议在手机上确认对方是否收到`);
    }

    return {
      ok: true,
      kind: card.kind,
      serverMessageId: r.serverMessageId,
      checkCode: r.checkCode,
      warning: warnings.length ? warnings.join('；') : null,
    };
  });
}
