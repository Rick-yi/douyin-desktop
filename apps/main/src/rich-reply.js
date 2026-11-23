/**
 * 自动回复/草稿的多消息顺序发送
 *
 * 每条消息都经过 Sender 的账号锁、配额、熔断和日志。
 * 卡片和文本是独立消息，便于准确记录每条状态。
 */
import { getCard, sendCardObject } from './card-service.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sleepCancellable(ms, shouldStop) {
  let left = Math.max(0, Number(ms) || 0);
  while (left > 0) {
    if (shouldStop?.()) return false;
    const step = Math.min(300, left);
    await sleep(step);
    left -= step;
  }
  return !shouldStop?.();
}

function cardLabel(card) {
  return card?.linkTitle || card?.payload?.title || card?.payload?.name || card?.name || '卡片';
}

/**
 * @returns {{status:'sent'|'partial'|'failed', results: Array}}
 */
export async function sendReplyItems({
  sender,
  accountId,
  sdkKey,
  peerUid,
  items,
  scene = 'autoreply',
  skipThrottle = true,
  skipDailyLimit = true,
  skipCompliance = false,
  shouldStop = null,
}) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return { status: 'failed', results: [] };

  const results = [];
  let sentCount = 0;

  for (let index = 0; index < list.length; index++) {
    if (shouldStop?.()) {
      results.push({ index, kind: 'system', status: 'cancelled', reason: '已转人工/已暂停' });
      break;
    }
    const item = list[index];
    if (index > 0 && Number(item.delayMs) > 0) {
      const proceed = await sleepCancellable(Math.min(30000, Number(item.delayMs)), shouldStop);
      if (!proceed) {
        results.push({ index, kind: 'system', status: 'cancelled', reason: '已转人工/已暂停' });
        break;
      }
    }

    if (item.kind === 'text') {
      if (!item.text || !String(item.text).trim()) continue;
      const r = await sender.sendOne({
        accountId,
        sdkKey,
        peerUid,
        text: item.text,
        scene,
        skipThrottle,
        skipDailyLimit,
        skipCompliance,
      });
      results.push({
        index, kind: 'text', text: item.text,
        status: r.status, reason: r.detail ?? r.reason ?? null,
        serverMessageId: r.serverMessageId ?? null,
      });
      if (r.status === 'sent') sentCount++;
      else break;
      continue;
    }

    if (item.kind === 'card') {
      const card = getCard(item.cardId) || item.cardSnapshot;
      if (!card) {
        results.push({
          index, kind: 'card', cardId: item.cardId, cardName: item.cardName,
          status: 'failed', reason: '卡片不存在或已删除',
        });
        break;
      }

      const r = await sender.sendRich({
        accountId,
        sdkKey,
        peerUid,
        text: '',
        scene,
        skipThrottle,
        skipDailyLimit,
        skipCompliance,
        msgType: 'card',
        contentLabel: `[卡片] ${item.cardName || cardLabel(card)}`,
        transport: async ({ sdk }) => {
          if (!sdk?.ready) return { ok: false, statusCode: -1, statusMsg: '账号未就绪' };
          return sendCardObject(sdk, peerUid, card);
        },
      });
      results.push({
        index, kind: 'card', cardId: item.cardId,
        cardName: item.cardName || cardLabel(card),
        status: r.status, reason: r.detail ?? r.reason ?? null,
        serverMessageId: r.serverMessageId ?? null,
      });
      if (r.status !== 'sent') break;
      sentCount++;

      if (item.text && String(item.text).trim()) {
        const tr = await sender.sendOne({
          accountId,
          sdkKey,
          peerUid,
          text: item.text,
          scene,
          skipThrottle,
          skipDailyLimit,
          skipCompliance,
        });
        results.push({
          index, kind: 'text', text: item.text,
          status: tr.status, reason: tr.detail ?? tr.reason ?? null,
          serverMessageId: tr.serverMessageId ?? null,
        });
        if (tr.status !== 'sent') break;
        sentCount++;
      }
    }
  }

  const failed = results.some((r) => r.status !== 'sent');
  return {
    status: failed ? (sentCount > 0 ? 'partial' : 'failed') : 'sent',
    results,
  };
}
