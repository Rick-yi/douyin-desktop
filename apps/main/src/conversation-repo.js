/**
 * 会话与消息仓储
 *
 * SDK 的联系人/消息结构 → 我们的 SQLite 表
 */
import { db_ } from './db.js';
import { randomUUID } from 'node:crypto';
import { isNoiseMessage } from '../../../packages/im-sdk/index.js';
import { parseMessageMeta, messagePreview } from '../../../packages/im-sdk/message-meta.js';

// ────────────── 会话 ──────────────

/**
 * 批量 upsert 联系人（好友/群/陌生人）
 * 会保留已有的 last_msg_at / unread_count 等本地状态
 */
export function upsertContacts(accountId, { friends = [], groups = [], strangers = [] }) {
  const db = db_();
  const now = Date.now();
  let added = 0;
  let updated = 0;

  const stmt = db.prepare(`
    INSERT INTO conversation
      (id, account_id, peer_uid, peer_sec_uid, conv_id, peer_nickname,
       peer_douyin_id, peer_avatar, kind, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, peer_uid) DO UPDATE SET
      peer_nickname = COALESCE(excluded.peer_nickname, peer_nickname),
      peer_avatar   = COALESCE(excluded.peer_avatar, peer_avatar),
      peer_sec_uid  = COALESCE(excluded.peer_sec_uid, peer_sec_uid),
      kind          = excluded.kind
  `);

  const exists = db.prepare(
    'SELECT id FROM conversation WHERE account_id = ? AND peer_uid = ?',
  );

  const all = [
    ...friends.map((f) => ({ ...f, kind: 'friend' })),
    ...groups.map((g) => ({ ...g, kind: 'group' })),
    ...strangers.map((s) => ({ ...s, kind: 'stranger' })),
  ];

  for (const c of all) {
    if (!c.uid) continue;
    const had = exists.get(accountId, c.uid);
    if (had) {
      updated++;
    } else {
      added++;
    }
    stmt.run(
      had?.id ?? randomUUID(),
      accountId,
      String(c.uid),
      c.secUid ?? null,
      c.convId ?? c.conversationShortId ?? null,
      c.displayName ?? c.nickname ?? null,
      c.douyinId ?? c.douyin_id ?? null,
      c.avatarUrl ?? null,
      c.kind ?? 'friend',
      now,
    );
  }

  return { added, updated, total: all.length };
}

export function listConversations(accountId, { keyword, limit = 500 } = {}) {
  const db = db_();
  let sql = `SELECT * FROM conversation WHERE account_id = ?`;
  const args = [accountId];
  if (keyword) {
    sql += ` AND (peer_nickname LIKE ? OR peer_uid LIKE ?)`;
    args.push(`%${keyword}%`, `%${keyword}%`);
  }
  sql += ` ORDER BY pinned DESC, COALESCE(last_msg_at, 0) DESC, peer_nickname ASC LIMIT ?`;
  args.push(limit);
  return db.prepare(sql).all(...args).map(rowToConversation);
}

export function getConversation(accountId, peerUid) {
  const row = db_()
    .prepare('SELECT * FROM conversation WHERE account_id = ? AND peer_uid = ?')
    .get(accountId, peerUid);
  return row ? rowToConversation(row) : null;
}

/** 确保会话存在（线索雷达/群发给陌生人发消息时用） */
export function ensureConversation(accountId, peerUid, { nickname = null, kind = 'stranger' } = {}) {
  const existing = getConversation(accountId, peerUid);
  if (existing) return existing;
  const db = db_();
  db.prepare(
    `INSERT OR IGNORE INTO conversation
       (id, account_id, peer_uid, peer_sec_uid, conv_id, peer_nickname,
        peer_douyin_id, peer_avatar, kind, created_at)
     VALUES (?, ?, ?, NULL, NULL, ?, NULL, NULL, ?, ?)`,
  ).run(randomUUID(), accountId, String(peerUid), nickname ?? null, kind, Date.now());
  return getConversation(accountId, peerUid);
}

export function touchConversation(accountId, peerUid, { preview, at, unreadDelta = 0, type } = {}) {
  const db = db_();
  db.prepare(
    `UPDATE conversation SET
       last_msg_preview = COALESCE(?, last_msg_preview),
       last_msg_type    = COALESCE(?, last_msg_type),
       last_msg_at      = COALESCE(?, last_msg_at),
       unread_count     = MAX(0, unread_count + ?)
     WHERE account_id = ? AND peer_uid = ?`,
  ).run(preview ?? null, type ?? null, at ?? null, unreadDelta, accountId, peerUid);
}

/** 收到推送时补上 SDK 的 conversationShortId，撤回/已读回执要用 */
export function setConversationConvId(accountId, peerUid, convId) {
  if (!convId) return false;
  const res = db_()
    .prepare(
      `UPDATE conversation SET conv_id = ?
       WHERE account_id = ? AND peer_uid = ? AND (conv_id IS NULL OR conv_id = '')`,
    )
    .run(String(convId), accountId, peerUid);
  return res.changes > 0;
}

export function clearUnread(accountId, peerUid) {
  db_()
    .prepare('UPDATE conversation SET unread_count = 0 WHERE account_id = ? AND peer_uid = ?')
    .run(accountId, peerUid);
}

export function setConversationPinned(accountId, peerUid, pinned) {
  const res = db_()
    .prepare('UPDATE conversation SET pinned = ? WHERE account_id = ? AND peer_uid = ?')
    .run(pinned ? 1 : 0, accountId, peerUid);
  return res.changes > 0;
}

export function setConversationMuted(accountId, peerUid, muted) {
  const res = db_()
    .prepare('UPDATE conversation SET muted = ? WHERE account_id = ? AND peer_uid = ?')
    .run(muted ? 1 : 0, accountId, peerUid);
  return res.changes > 0;
}

// ────────────── 消息 ──────────────

/** SDK 的 createTime 可能是秒也可能是毫秒，统一成毫秒；异常微秒值也顺手降级 */
function normalizeSentAt(value) {
  let n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  while (n > 100000000000000) n = Math.floor(n / 1000);
  if (n < 100000000000) n *= 1000;
  return n;
}

/**
 * 批量写入消息（幂等：按 source_msg_id 去重）
 */
export function upsertMessages(accountId, peerUid, messages = []) {
  const db = db_();
  const conv = getConversation(accountId, peerUid);
  if (!conv) return { inserted: 0, skipped: 0 };

  // 会话内最大 seq
  const maxSeq = db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM message WHERE conversation_id = ?')
    .get(conv.id);
  let seq = maxSeq?.m ?? 0;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO message
      (id, conversation_id, account_id, direction, msg_type, content,
       raw_content, chat_type, sender_uid, sender_sec_uid, sender_name, sender_avatar,
       media_url, media_path, index_in_conversation, index_in_conversation_v2,
       seq, source_msg_id, server_msg_id, client_msg_id, message_type,
       sent_at, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // 老数据再次拉历史时补全富消息字段（INSERT OR IGNORE 不会更新已存在的行）
  const update = db.prepare(`
    UPDATE message SET
      msg_type = COALESCE(?, msg_type),
      content = COALESCE(?, content),
      raw_content = COALESCE(?, raw_content),
      chat_type = COALESCE(?, chat_type),
      sender_uid = COALESCE(?, sender_uid),
      sender_sec_uid = COALESCE(?, sender_sec_uid),
      sender_name = COALESCE(?, sender_name),
      sender_avatar = COALESCE(?, sender_avatar),
      media_url = COALESCE(?, media_url),
      media_path = COALESCE(?, media_path),
      index_in_conversation = COALESCE(?, index_in_conversation),
      index_in_conversation_v2 = COALESCE(?, index_in_conversation_v2),
      server_msg_id = COALESCE(?, server_msg_id),
      client_msg_id = COALESCE(?, client_msg_id),
      message_type = COALESCE(?, message_type),
      sent_at = COALESCE(?, sent_at)
    WHERE conversation_id = ? AND (source_msg_id = ? OR id = ?)
  `);

  // 同一句消息可能一次带服务端 ID、一次只带客户端 ID，按任一 ID 命中就算是同一条
  const findDuplicate = db.prepare(`
    SELECT id FROM message
    WHERE conversation_id = ?
      AND (
        source_msg_id = ?
        OR (? IS NOT NULL AND server_msg_id = ?)
        OR (? IS NOT NULL AND client_msg_id = ?)
      )
    LIMIT 1
  `);

  let inserted = 0;
  let skipped = 0;
  let newest = null;

  for (const m of messages) {
    // 过滤噪音（系统通知类，用户不关心）
    if (isNoiseMessage(m.kind, m.text, m.rawContent)) {
      skipped++;
      continue;
    }

    // ★ 历史消息常常没有 serverMessageId，优先用 clientMessageId 做幂等键
    const srcId = m.serverMessageId || m.clientMessageId;
    if (!srcId) {
      skipped++;
      continue;
    }

    const kind = m.kind ?? 'text';
    const meta = m.meta ?? parseMessageMeta(m.rawContent, kind);
    const mediaUrl = m.mediaUrl ?? meta.url ?? meta.coverUrl ?? null;
    const preview = messagePreview(kind, m.text, meta);
    const sentAt = normalizeSentAt(m.createTime);
    const direction = m.isMine ? 'out' : 'in';
    const nextSeq = seq + 1;
    const serverMsgId = m.serverMessageId ? String(m.serverMessageId) : null;
    const clientMsgId = m.clientMessageId ? String(m.clientMessageId) : null;
    const dup = findDuplicate.get(
      conv.id, String(srcId), serverMsgId, serverMsgId, clientMsgId, clientMsgId,
    );

    if (dup) {
      skipped++;
      update.run(
        kind,
        m.text ?? null,
        m.rawContent ?? null,
        m.chatType ?? null,
        m.senderUid ?? null,
        m.senderSecUid ?? null,
        m.senderName ?? null,
        m.senderAvatar ?? null,
        mediaUrl,
        m.mediaPath ?? null,
        m.index ?? null,
        m.indexV2 ?? null,
        serverMsgId,
        clientMsgId,
        m.messageType ?? null,
        sentAt,
        conv.id,
        String(srcId),
        dup.id,
      );
      if (!newest || sentAt >= newest.sentAt) {
        newest = { kind, text: m.text, meta, sentAt };
      }
      continue;
    }

    const res = insert.run(
      randomUUID(),
      conv.id,
      accountId,
      direction,
      kind,
      m.text ?? '',
      m.rawContent ?? null,
      m.chatType ?? null,
      m.senderUid ?? null,
      m.senderSecUid ?? null,
      m.senderName ?? null,
      m.senderAvatar ?? null,
      mediaUrl,
      m.mediaPath ?? null,
      m.index ?? null,
      m.indexV2 ?? null,
      nextSeq,
      String(srcId),
      serverMsgId,
      clientMsgId,
      m.messageType ?? null,
      sentAt,
      m.status ?? 'sent',
      Date.now(),
    );

    if (res.changes > 0) {
      inserted++;
      seq = nextSeq;
    } else {
      skipped++;
      update.run(
        kind,
        m.text ?? null,
        m.rawContent ?? null,
        m.chatType ?? null,
        m.senderUid ?? null,
        m.senderSecUid ?? null,
        m.senderName ?? null,
        m.senderAvatar ?? null,
        mediaUrl,
        m.mediaPath ?? null,
        m.index ?? null,
        m.indexV2 ?? null,
        serverMsgId,
        clientMsgId,
        m.messageType ?? null,
        sentAt,
        conv.id,
        String(srcId),
        null,
      );
    }
    if (!newest || sentAt >= newest.sentAt) {
      newest = { kind, text: m.text, meta, sentAt };
    }
  }

  // 更新会话最后一条；拉历史时不要把更早的消息覆盖到会话列表顶部
  if (newest && (!conv.last_msg_at || newest.sentAt >= conv.last_msg_at)) {
    touchConversation(accountId, peerUid, {
      preview: messagePreview(newest.kind, newest.text, newest.meta),
      at: newest.sentAt,
      type: newest.kind,
    });
  }

  return { inserted, skipped };
}

export function listMessages(accountId, peerUid, { limit = 50, before } = {}) {
  const conv = getConversation(accountId, peerUid);
  if (!conv) return [];
  const db = db_();
  let inner = `SELECT * FROM message WHERE conversation_id = ?`;
  const args = [conv.id];
  if (before) {
    inner += ` AND seq < ?`;
    args.push(before);
  }
  // 先按时间取最近 N 条，再按时间正序返回；这样补拉历史不会跑到列表底部
  const sql = `
    SELECT * FROM (
      ${inner}
      ORDER BY COALESCE(sent_at, created_at, 0) DESC, seq DESC
      LIMIT ?
    )
    ORDER BY COALESCE(sent_at, created_at, 0) ASC, seq ASC
  `;
  args.push(limit);
  return db.prepare(sql).all(...args).map(rowToMessage);
}

/**
 * 插入一条本地待发消息（乐观更新）
 */
export function insertPendingMessage(
  accountId,
  peerUid,
  {
    text,
    clientMessageId,
    msgType = 'text',
    mediaPath = null,
    mediaUrl = null,
    rawContent = null,
    meta = null,
    messageType = null,
  },
) {
  const conv = getConversation(accountId, peerUid);
  if (!conv) return null;
  const db = db_();
  const maxSeq = db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM message WHERE conversation_id = ?')
    .get(conv.id);
  const id = randomUUID();
  const now = Date.now();
  const preview = messagePreview(msgType, text, meta ?? {});
  const sdkType = messageType ?? {
    text: 7,
    image: 27,
    video: 30,
    emoji: 5,
    file: 6,
    link: 26,
    user: 25,
    share: 8,
    comment: 16,
  }[msgType] ?? null;

  db.prepare(
    `INSERT INTO message
      (id, conversation_id, account_id, direction, msg_type, content,
       raw_content, chat_type, media_url, media_path,
       seq, source_msg_id, client_msg_id, message_type, sent_at, status, created_at)
     VALUES (?, ?, ?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(
    id,
    conv.id,
    accountId,
    msgType,
    text ?? '',
    rawContent,
    conv.kind === 'group' ? 'group' : conv.kind === 'stranger' ? 'stranger' : 'private',
    mediaUrl,
    mediaPath,
    (maxSeq?.m ?? 0) + 1,
    clientMessageId ?? id,
    clientMessageId ?? id,
    sdkType,
    now,
    now,
  );

  touchConversation(accountId, peerUid, { preview, at: now, type: msgType });
  return id;
}

export function markMessageStatus(accountId, peerUid, { clientMessageId, status, serverMessageId }) {
  const conv = getConversation(accountId, peerUid);
  if (!conv) return false;
  const res = db_()
    .prepare(
      `UPDATE message SET
         status = ?,
         source_msg_id = COALESCE(?, source_msg_id),
         server_msg_id = COALESCE(?, server_msg_id),
         client_msg_id = COALESCE(?, client_msg_id)
       WHERE conversation_id = ?
         AND (source_msg_id = ? OR client_msg_id = ? OR id = ?)`,
    )
    .run(
      status,
      serverMessageId ?? null,
      serverMessageId ?? null,
      clientMessageId ?? null,
      conv.id,
      clientMessageId,
      clientMessageId,
      clientMessageId,
    );
  return res.changes > 0;
}

/** 用群成员资料补全历史消息的发送者昵称/头像 */
export function updateMessageSenderInfo(accountId, peerUid, members = []) {
  const conv = getConversation(accountId, peerUid);
  if (!conv) return 0;
  const stmt = db_().prepare(
    `UPDATE message SET sender_name = COALESCE(?, sender_name),
       sender_avatar = COALESCE(?, sender_avatar)
     WHERE conversation_id = ? AND sender_uid = ?`,
  );
  let changed = 0;
  for (const m of members) {
    const uid = String(m?.uid ?? '');
    if (!uid) continue;
    const name = m.name || m.nickname || null;
    const avatar = m.avatarUrl || m.avatar || null;
    if (!name && !avatar) continue;
    changed += stmt.run(name, avatar, conv.id, uid).changes;
  }
  return changed;
}

export function getMessageById(accountId, messageId) {
  const row = db_()
    .prepare(
      `SELECT m.*, c.peer_uid
       FROM message m JOIN conversation c ON c.id = m.conversation_id
       WHERE m.account_id = ? AND m.id = ?`,
    )
    .get(accountId, String(messageId));
  return row ? rowToMessage(row) : null;
}

export function markMessageStatusById(accountId, messageId, { status, serverMessageId, sentAt }) {
  const res = db_()
    .prepare(
      `UPDATE message SET
         status = ?,
         source_msg_id = COALESCE(?, source_msg_id),
         server_msg_id = COALESCE(?, server_msg_id),
         sent_at = COALESCE(?, sent_at)
       WHERE account_id = ? AND id = ?`,
    )
    .run(
      status,
      serverMessageId ?? null,
      serverMessageId ?? null,
      sentAt ?? null,
      accountId,
      String(messageId),
    );
  return res.changes > 0;
}

/**
 * 撤回通知：按服务端/客户端消息 ID 找到本地行，保留原文，只打撤回标记。
 */
export function markMessageRecalled({ serverMessageId, clientMessageId }) {
  const ids = [serverMessageId, clientMessageId].filter(Boolean).map(String);
  if (!ids.length) return 0;
  const placeholders = ids.map(() => '?').join(',');
  const res = db_()
    .prepare(
      `UPDATE message SET recalled = 1, recalled_at = ?
       WHERE source_msg_id IN (${placeholders})
          OR server_msg_id IN (${placeholders})
          OR client_msg_id IN (${placeholders})
          OR id IN (${placeholders})`,
    )
    .run(Date.now(), ...ids, ...ids, ...ids, ...ids);
  return res.changes;
}

export function markMessageRecalledById(accountId, messageId) {
  const res = db_()
    .prepare(
      `UPDATE message SET recalled = 1, recalled_at = ?
       WHERE account_id = ? AND id = ?`,
    )
    .run(Date.now(), accountId, String(messageId));
  return res.changes > 0;
}

export function deleteMessageLocal(accountId, messageId) {
  const res = db_()
    .prepare('DELETE FROM message WHERE account_id = ? AND id = ?')
    .run(accountId, String(messageId));
  return res.changes > 0;
}

/**
 * 会话里最后一条对方发来的、可用于已读回执的消息。
 */
export function getLatestIncomingMessage(accountId, peerUid) {
  const conv = getConversation(accountId, peerUid);
  if (!conv) return null;
  const row = db_()
    .prepare(
      `SELECT * FROM message
       WHERE conversation_id = ? AND direction = 'in' AND source_msg_id IS NOT NULL
       ORDER BY seq DESC LIMIT 1`,
    )
    .get(conv.id);
  return row ? rowToMessage(row) : null;
}

// ────────────── 映射 ──────────────

function rowToConversation(r) {
  return {
    id: r.id,
    account_id: r.account_id,
    peer_uid: r.peer_uid,
    peer_sec_uid: r.peer_sec_uid,
    conv_id: r.conv_id,
    peer_nickname: r.peer_nickname,
    peer_douyin_id: r.peer_douyin_id,
    peer_avatar: r.peer_avatar,
    kind: r.kind ?? 'friend',
    last_msg_preview: r.last_msg_preview,
    last_msg_type: r.last_msg_type ?? 'text',
    last_msg_at: r.last_msg_at,
    unread_count: r.unread_count,
    pinned: !!r.pinned,
    muted: !!r.muted,
    archived: !!r.archived,
  };
}

function rowToMessage(r) {
  const msgType = r.msg_type ?? 'text';
  return {
    id: r.id,
    conversation_id: r.conversation_id,
    peer_uid: r.peer_uid ?? null,
    direction: r.direction,
    msg_type: msgType,
    content: r.content,
    text: r.content,
    raw_content: r.raw_content,
    chat_type: r.chat_type,
    sender_uid: r.sender_uid,
    sender_sec_uid: r.sender_sec_uid,
    sender_name: r.sender_name,
    sender_avatar: r.sender_avatar ?? null,
    media_url: r.media_url,
    media_path: r.media_path,
    meta: parseMessageMeta(r.raw_content, msgType),
    index_in_conversation: r.index_in_conversation,
    index_in_conversation_v2: r.index_in_conversation_v2,
    recalled: !!r.recalled,
    recalled_at: r.recalled_at,
    seq: r.seq,
    source_msg_id: r.source_msg_id,
    server_msg_id: r.server_msg_id,
    client_msg_id: r.client_msg_id,
    message_type: r.message_type,
    sent_at: r.sent_at,
    status: r.status,
    created_at: r.created_at,
  };
}


// ────────────── 发送历史去重（每目标每日限制）──────────────

/**
 * 记录一次成功的发送（用于跨任务去重）
 */
export function recordDmSent(accountId, peerUid) {
  const db = db_();
  const now = Date.now();
  const existing = db
    .prepare('SELECT * FROM dm_history WHERE account_id = ? AND peer_uid = ?')
    .get(accountId, peerUid);
  if (existing) {
    db.prepare(
      'UPDATE dm_history SET last_at = ?, count = count + 1 WHERE account_id = ? AND peer_uid = ?',
    ).run(now, accountId, peerUid);
  } else {
    db.prepare(
      'INSERT INTO dm_history (account_id, peer_uid, first_at, last_at, count) VALUES (?, ?, ?, ?, 1)',
    ).run(accountId, peerUid, now, now);
  }
}

/**
 * 最近 N 天联系过的 peer_uid（群发排除用）
 */
export function recentlyContactedSet(accountIds, days) {
  const ids = (accountIds ?? []).filter(Boolean);
  if (!ids.length || !(Number(days) > 0)) return new Set();
  const since = Date.now() - Number(days) * 86400000;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db_()
    .prepare(
      `SELECT DISTINCT peer_uid FROM dm_history
       WHERE account_id IN (${placeholders}) AND last_at >= ?`,
    )
    .all(...ids, since);
  return new Set(rows.map((r) => String(r.peer_uid)));
}

/**
 * 该目标今天是否已经发过
 * 平台规则：同一个人未回复前有消息上限，所以默认每人每天只发 1 条
 */
export function sentToday(accountId, peerUid) {
  const row = db_()
    .prepare('SELECT last_at FROM dm_history WHERE account_id = ? AND peer_uid = ?')
    .get(accountId, peerUid);
  if (!row?.last_at) return false;
  const a = new Date(row.last_at);
  const b = new Date();
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * 批量查：哪些目标今天已发过
 */
export function filterSentToday(accountId, peerUids) {
  const set = new Set();
  for (const uid of peerUids) {
    if (sentToday(accountId, uid)) set.add(uid);
  }
  return set;
}
