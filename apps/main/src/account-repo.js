/**
 * 账号仓储（repo）
 */
import { db_ } from './db.js';
import { randomUUID } from 'node:crypto';

export function listAccounts() {
  return db_()
    .prepare(
      `SELECT * FROM account ORDER BY enabled DESC, created_at ASC`,
    )
    .all()
    .map(rowToAccount);
}

export function getAccount(id) {
  const row = db_().prepare('SELECT * FROM account WHERE id = ?').get(id);
  return row ? rowToAccount(row) : null;
}

export function getAccountByUid(uid) {
  const row = db_().prepare('SELECT * FROM account WHERE uid = ?').get(uid);
  return row ? rowToAccount(row) : null;
}

/**
 * 新建或更新账号（按 uid 去重，扫码时用）
 */
export function upsertAccountByUid(profile) {
  const existing = profile.uid ? getAccountByUid(profile.uid) : null;
  const now = Date.now();

  if (existing) {
    db_()
      .prepare(
        `UPDATE account SET
           nickname = COALESCE(?, nickname),
           douyin_id = COALESCE(?, douyin_id),
           avatar_url = COALESCE(?, avatar_url),
           signature = COALESCE(?, signature),
           sec_uid = COALESCE(?, sec_uid),
           is_verified = COALESCE(?, is_verified),
           last_login_at = ?,
           status = 'warm',
           conn_state = 'offline',
           fail_count = 0,
           session_days = CASE
             WHEN last_login_at IS NULL THEN 1
             ELSE CAST((? - last_login_at) / 86400000 AS INTEGER) + 1
           END
         WHERE id = ?`,
      )
      .run(
        profile.nickname ?? null,
        profile.douyinId ?? null,
        profile.avatarUrl ?? null,
        profile.signature ?? null,
        profile.secUid ?? null,
        profile.isVerified == null ? null : (profile.isVerified ? 1 : 0),
        now,
        now,
        existing.id,
      );
    return { account: getAccount(existing.id), created: false };
  }

  const id = randomUUID();
  db_()
    .prepare(
      `INSERT INTO account
        (id, uid, sec_uid, douyin_id, nickname, avatar_url, signature,
         is_verified, status, last_login_at, session_days, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'warm', ?, 1, ?)`,
    )
    .run(
      id,
      profile.uid ?? null,
      profile.secUid ?? null,
      profile.douyinId ?? null,
      profile.nickname ?? null,
      profile.avatarUrl ?? null,
      profile.signature ?? null,
      profile.isVerified ? 1 : 0,
      now,
      now,
    );
  return { account: getAccount(id), created: true };
}

export function updateAccount(id, patch) {
  const allowed = [
    'nickname', 'douyin_id', 'avatar_url', 'avatar_local_url', 'signature', 'sec_uid',
    'group_id', 'tags', 'note', 'status', 'conn_state', 'risk_level',
    'is_verified', 'can_send_image', 'can_send_emoji', 'can_invite_group', 'can_dm',
    'last_login_at', 'last_online_at', 'last_sync_at', 'fail_count', 'enabled', 'proxy_id',
  ];
  const keys = Object.keys(patch).filter((k) => allowed.includes(k));
  if (!keys.length) return false;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  db_()
    .prepare(`UPDATE account SET ${sets} WHERE id = ?`)
    .run(...keys.map((k) => patch[k]), id);
  return true;
}

export function bumpFail(id) {
  db_()
    .prepare(
      `UPDATE account SET fail_count = fail_count + 1,
       risk_level = CASE WHEN fail_count + 1 >= 3 THEN 'warning' ELSE risk_level END
       WHERE id = ?`,
    )
    .run(id);
}

export function markExpired(id) {
  db_()
    .prepare(
      `UPDATE account SET status = 'expired', conn_state = 'expired', risk_level = 'warning'
       WHERE id = ?`,
    )
    .run(id);
}

export function deleteAccount(id) {
  db_().prepare('DELETE FROM account WHERE id = ?').run(id);
  db_().prepare('DELETE FROM conversation WHERE account_id = ?').run(id);
  db_().prepare('DELETE FROM message WHERE account_id = ?').run(id);
  return true;
}

function rowToAccount(row) {
  return {
    ...row,
    tags: safeJson(row.tags, []),
    isVerified: !!row.is_verified,
    canSendImage: !!row.can_send_image,
    canSendEmoji: !!row.can_send_emoji,
    canInviteGroup: !!row.can_invite_group,
    canDm: !!row.can_dm,
    enabled: !!row.enabled,
  };
}

function safeJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}
