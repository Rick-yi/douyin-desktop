/**
 * 线索用户在线状态
 *
 * 抖音桌面 IM 的 active/status 接口：
 *   - 用户：last_active_time（最近活跃时间）
 *   - 已有会话：online（是否在线）
 *
 * 评论用户不一定有会话，所以能拿到“在线”的只有已建会话的人；
 * 其他人显示“最近活跃 X 分钟前”，拿不到则未知。
 */
import { db_ } from './db.js';
import { getInterceptTask } from './intercept-service.js';

function toMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  // 兼容秒/毫秒时间戳
  return n > 1e12 ? Math.round(n) : Math.round(n * 1000);
}

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * 刷新一个截流任务里所有线索的在线/最近活跃状态。
 * @returns {{checked:number, online:number, active:number, unknown:number, total:number, errors:string[]}}
 */
export async function refreshTaskPresence(taskId, { getSdk } = {}) {
  const task = getInterceptTask(taskId);
  if (!task) throw new Error('任务不存在');
  const db = db_();

  // 已有会话的老线索可以补出 sec_uid
  try {
    db.prepare(`
      UPDATE outreach_item AS o
         SET peer_sec_uid = (
           SELECT c.peer_sec_uid
             FROM conversation c
            WHERE c.account_id = o.account_id
              AND c.peer_uid = o.peer_uid
              AND c.peer_sec_uid IS NOT NULL
            ORDER BY c.last_msg_at DESC
            LIMIT 1
         )
       WHERE o.task_id = ?
         AND (o.peer_sec_uid IS NULL OR o.peer_sec_uid = '')
    `).run(taskId);
  } catch {}

  const rows = db.prepare(
    'SELECT id, account_id, peer_uid, peer_sec_uid FROM outreach_item WHERE task_id = ?',
  ).all(taskId);

  const byAccount = new Map();
  for (const row of rows) {
    if (!row.peer_sec_uid) continue;
    const key = row.account_id ?? task.accountIds?.[0] ?? '';
    if (!byAccount.has(key)) byAccount.set(key, []);
    byAccount.get(key).push(row);
  }

  const updateStmt = db.prepare(`
    UPDATE outreach_item
       SET last_active_at = COALESCE(?, last_active_at),
           online = COALESCE(?, online),
           presence_checked_at = ?
     WHERE id = ?
  `);
  const now = Date.now();
  let checked = 0;
  let online = 0;
  let active = 0;
  let unknown = 0;
  let withSecUid = 0;
  const errors = [];

  for (const [accountId, list] of byAccount.entries()) {
    withSecUid += list.length;
    const sdk = getSdk?.(accountId);
    const statusFn = sdk?.account?.getActiveStatus ?? sdk?.account?.im?.getActiveStatus;
    if (!sdk?.account || typeof statusFn !== 'function') {
      errors.push(`账号 ${accountId || '(空)'} 未上线，跳过在线状态`);
      unknown += list.length;
      continue;
    }

    const uids = [...new Set(list.map((r) => String(r.peer_uid)))];
    let convRows = [];
    try {
      if (uids.length) {
        convRows = db.prepare(`
          SELECT peer_uid, conv_id
            FROM conversation
           WHERE account_id = ?
             AND conv_id IS NOT NULL
             AND peer_uid IN (${uids.map(() => '?').join(',')})
        `).all(accountId, ...uids);
      }
    } catch {}
    const convByUid = new Map(convRows.map((r) => [String(r.peer_uid), String(r.conv_id)]));
    const uidByConv = new Map(convRows.map((r) => [String(r.conv_id), String(r.peer_uid)]));

    for (const secChunk of chunks([...new Set(list.map((r) => String(r.peer_sec_uid)))], 50)) {
      const secSet = new Set(secChunk);
      const chunkRows = list.filter((r) => secSet.has(String(r.peer_sec_uid)));
      const convIds = [...new Set(chunkRows.map((r) => convByUid.get(String(r.peer_uid))).filter(Boolean))];
      let res;
      try {
        res = await statusFn.call(sdk.account, secChunk, convIds);
      } catch (e) {
        errors.push(e.message);
        unknown += chunkRows.length;
        continue;
      }
      if (res?.statusCode !== undefined && res.statusCode !== 0) {
        errors.push(res.statusMsg || `在线状态接口错误 ${res.statusCode}`);
        unknown += chunkRows.length;
        continue;
      }

      const lastById = new Map();
      for (const u of res?.users ?? []) {
        const ms = toMs(u.lastActiveTime);
        if (ms) lastById.set(String(u.secUid), ms);
      }
      const onlineByUid = new Map();
      for (const c of res?.conversations ?? []) {
        const uid = uidByConv.get(String(c.conversationId));
        if (!uid) continue;
        onlineByUid.set(uid, c.online ? 1 : 0);
      }

      for (const row of chunkRows) {
        const secUid = String(row.peer_sec_uid);
        const last = lastById.get(secUid) ?? null;
        const on = onlineByUid.has(String(row.peer_uid))
          ? onlineByUid.get(String(row.peer_uid))
          : null;
        updateStmt.run(last, on, now, row.id);
        checked++;
        if (on === 1) online++;
        if (last) active++;
        if (!last && on == null) unknown++;
      }
    }
  }

  return {
    checked,
    online,
    active,
    unknown,
    total: rows.length,
    withSecUid,
    errors: [...new Set(errors)].slice(0, 5),
  };
}
