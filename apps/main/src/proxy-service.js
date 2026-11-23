/**
 * 代理服务
 *
 * ★ 现实约束（实测见 docs/技术验证报告.md §14）
 *   协议 SDK 只有全局 fetch / 全局 WebSocket，没有 per-instance 代理入口。
 *   我们通过 AsyncLocalStorage + 复合 dispatcher 实现「按账号选代理」，
 *   但代理只在建立连接时生效：改绑定后必须让账号重连。
 *
 * ★ 只支持 HTTP/HTTPS 代理
 *   undici 没有 SOCKS 支持，硬塞 socks5 会静默直连，反而更危险。
 */
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { safeStorage } from 'electron';
import { db_ } from './db.js';
import {
  setAccountProxy, getAccountProxyInfo, probeExitIp,
  markProxyRequired, fetchViaProxy,
} from '../../../packages/net/proxy-dispatcher.js';
import { rememberProxyCredential } from './proxy-auth.js';

/**
 * 出口 IP 归属地查询。
 * ★ 必须走同一个代理，不能用全局 fetch 直连，否则会把本机真实 IP 暴露给第三方。
 */
async function lookupLocation(ip, proxyUrl) {
  if (!ip || !proxyUrl) return null;
  const res = await fetchViaProxy(
    proxyUrl,
    `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,regionName,city,isp`,
    { timeoutMs: 5000 },
  );
  if (!res.ok || !res.text) return null;
  try {
    const d = JSON.parse(res.text);
    if (d.status !== 'success') return null;
    return [d.country, d.regionName, d.city].filter(Boolean).join(' ');
  } catch {
    return null;
  }
}

// ══════════════════════════════════════
// 总开关
// ══════════════════════════════════════

const ENABLED_KEY = 'proxy.enabled';

export function isProxyEnabled() {
  try {
    const row = db_().prepare('SELECT value FROM setting WHERE key = ?').get(ENABLED_KEY);
    return !row || row.value !== '0';
  } catch {
    return true;
  }
}

/**
 * 关闭时立即清掉内存里的 agent（新的 HTTP 请求直连），
 * 已建立的 WebSocket 需要重启应用才会断开。
 */
export function setProxyEnabled(enabled) {
  db_()
    .prepare('INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(ENABLED_KEY, enabled ? '1' : '0');
  if (!enabled) {
    const rows = db_().prepare('SELECT uid FROM account WHERE proxy_id IS NOT NULL AND uid IS NOT NULL').all();
    for (const r of rows) setAccountProxy(String(r.uid), null);
    console.warn(`[proxy] 已关闭代理功能，${rows.length} 个账号将在重连后直连`);
  }
  return { ok: true, enabled: !!enabled };
}

// ══════════════════════════════════════
// CRUD
// ══════════════════════════════════════

export function listProxies() {
  const rows = db_()
    .prepare(
      `SELECT p.*,
         (SELECT COUNT(*) FROM account a WHERE a.proxy_id = p.id) AS bound_count
       FROM proxy p ORDER BY p.checked_at DESC, p.rowid DESC`,
    )
    .all();

  return rows.map((r) => {
    const url = openUrl(r.url);
    return {
      id: r.id,
      name: r.name || maskUrl(url),
      maskedUrl: maskUrl(url),
      hasAuth: /\/\/[^/@]+@/.test(url),
      type: r.type,
      exitIp: r.exit_ip,
      location: r.location,
      latencyMs: r.latency_ms,
      status: r.status,
      checkedAt: r.checked_at,
      boundCount: r.bound_count,
      enabled: r.enabled !== 0,
    };
  });
}

function maskUrl(url) {
  try {
    const u = new URL(url);
    const auth = u.username ? `${u.username}:***@` : '';
    return `${u.protocol}//${auth}${u.host}`;
  } catch {
    return url;
  }
}

const ENC_PREFIX = 'enc:';

/** 新增/修改代理时用系统安全存储加密认证信息；不可用时保留原样 */
function sealUrl(url) {
  try {
    return ENC_PREFIX + safeStorage.encryptString(url).toString('base64');
  } catch {
    return url;
  }
}

function openUrl(value) {
  const raw = String(value ?? '');
  if (!raw.startsWith(ENC_PREFIX)) return raw;
  try {
    return safeStorage.decryptString(Buffer.from(raw.slice(ENC_PREFIX.length), 'base64'));
  } catch {
    return raw;
  }
}

export function createProxy({ name, url, note }) {
  const raw = String(url ?? '').trim();
  if (!raw) throw new Error('代理地址不能为空');

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('地址格式不对，例：http://user:pass@1.2.3.4:8080');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('只支持 HTTP/HTTPS 代理，SOCKS5 需要本地转换成 HTTP');
  }
  if (!parsed.hostname || !parsed.port) {
    throw new Error('地址必须包含主机和端口');
  }

  const id = randomUUID();
  // 认证信息用系统安全存储加密后落库；界面只返回脱敏地址
  rememberProxyCredential(raw);
  const finalUrl = sealUrl(raw);

  const exists = db_()
    .prepare('SELECT id, url FROM proxy')
    .all()
    .some((r) => openUrl(r.url) === raw);
  if (exists) throw new Error('这个代理已经添加过了');

  db_()
    .prepare(
      `INSERT INTO proxy (id, url, name, type, status, note, enabled)
       VALUES (?, ?, ?, ?, 'unknown', ?, 1)`,
    )
    .run(id, finalUrl, name || maskUrl(raw), parsed.protocol.replace(':', ''), note ?? null);

  return { ok: true, id };
}

export function updateProxy(id, patch) {
  const fields = [];
  const args = [];
  if (patch.name !== undefined) { fields.push('name = ?'); args.push(patch.name); }
  if (patch.note !== undefined) { fields.push('note = ?'); args.push(patch.note); }
  if (patch.enabled !== undefined) { fields.push('enabled = ?'); args.push(patch.enabled ? 1 : 0); }
  if (patch.url !== undefined) {
    const parsed = new URL(patch.url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('只支持 HTTP/HTTPS 代理');
    fields.push('url = ?', "type = ?", "status = 'unknown'");
    args.push(sealUrl(String(patch.url)), parsed.protocol.replace(':', ''));
    rememberProxyCredential(String(patch.url));
  }
  if (!fields.length) return { ok: true, changed: 0 };
  args.push(id);
  const r = db_().prepare(`UPDATE proxy SET ${fields.join(', ')} WHERE id = ?`).run(...args);
  return { ok: true, changed: r.changes };
}

/**
 * 删除代理（先解绑所有账号）
 */
export function deleteProxy(id) {
  const accounts = db_().prepare('SELECT id, uid FROM account WHERE proxy_id = ?').all(id);
  for (const a of accounts) {
    db_().prepare('UPDATE account SET proxy_id = NULL WHERE id = ?').run(a.id);
    if (a.uid) setAccountProxy(String(a.uid), null);
  }
  db_().prepare('DELETE FROM proxy WHERE id = ?').run(id);
  return { ok: true, unbound: accounts.length };
}

// ══════════════════════════════════════
// 检测
// ══════════════════════════════════════

/**
 * 测试代理：先 TCP 探活，再走代理请求出口 IP
 */
export async function testProxy(id) {
  const row = db_().prepare('SELECT * FROM proxy WHERE id = ?').get(id);
  if (!row) throw new Error('代理不存在');
  const proxyUrl = openUrl(row.url);

  const parsed = new URL(proxyUrl);
  const host = parsed.hostname;
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));

  // 1. TCP 可达性（更快的失败信号）
  const tcpMs = await new Promise((resolve) => {
    const started = Date.now();
    const sock = net.connect({ host, port, timeout: 6000 });
    sock.on('connect', () => { sock.destroy(); resolve(Date.now() - started); });
    sock.on('timeout', () => { sock.destroy(); resolve(-1); });
    sock.on('error', () => { sock.destroy(); resolve(-2); });
  });

  if (tcpMs < 0) {
    db_().prepare(
      "UPDATE proxy SET status = 'fail', latency_ms = NULL, checked_at = ? WHERE id = ?",
    ).run(Date.now(), id);
    return { ok: false, stage: 'tcp', error: tcpMs === -2 ? '无法连接代理端口' : '连接超时' };
  }

  // 2. 走代理拿出口 IP
  const probe = await probeExitIp(proxyUrl);
  if (!probe.ok) {
    db_().prepare(
      "UPDATE proxy SET status = 'fail', latency_ms = NULL, checked_at = ? WHERE id = ?",
    ).run(Date.now(), id);
    return { ok: false, stage: 'http', error: probe.error, tcpMs };
  }

  const location = probe.loc ?? (probe.ip ? await lookupLocation(probe.ip, proxyUrl) : null);
  db_().prepare(
    `UPDATE proxy SET status = 'ok', exit_ip = ?, location = ?, latency_ms = ?, checked_at = ?
     WHERE id = ?`,
  ).run(probe.ip ?? null, location, probe.latencyMs, Date.now(), id);

  return {
    ok: true,
    ip: probe.ip,
    location,
    latencyMs: probe.latencyMs,
    tcpMs,
  };
}

// ══════════════════════════════════════
// 账号绑定
// ══════════════════════════════════════

/**
 * 绑定 / 解绑（立即注册到代理层，但需重启应用才生效）
 *
 * ★ ALS key 用平台 uid，不用本地 account.id
 *   运行时 manager 的实例 key 是 String(acc.uid)，两者必须一致。
 */
export function bindAccount(accountId, proxyId) {
  const acc = db_().prepare('SELECT id, uid, nickname FROM account WHERE id = ?').get(accountId);
  if (!acc) throw new Error('账号不存在');

  const key = acc.uid ? String(acc.uid) : null;

  if (!proxyId) {
    db_().prepare('UPDATE account SET proxy_id = NULL WHERE id = ?').run(accountId);
    if (key) setAccountProxy(key, null);
    return { ok: true, mode: 'direct', needsRestart: true, accountId };
  }

  const p = db_().prepare('SELECT * FROM proxy WHERE id = ?').get(proxyId);
  if (!p) throw new Error('代理不存在');

  // 未登录的账号还没有 uid，先落库，登录后重启生效
  if (key) {
    rememberProxyCredential(openUrl(p.url));
    const r = setAccountProxy(key, openUrl(p.url));
    if (!r.ok) throw new Error(r.error);
  }

  db_().prepare('UPDATE account SET proxy_id = ? WHERE id = ?').run(proxyId, accountId);
  return {
    ok: true,
    mode: 'proxy',
    url: maskUrl(openUrl(p.url)),
    needsRestart: true,
    accountId,
  };
}

/**
 * 启动时把数据库里的绑定关系装回代理层
 */
export async function applyBindings() {
  // 启动时顺手把旧的明文代理凭据升级为系统安全存储密文
  try {
    const available = typeof safeStorage?.isAsyncEncryptionAvailable === 'function'
      ? await safeStorage.isAsyncEncryptionAvailable()
      : true;
    if (available) {
      const rows = db_().prepare('SELECT id, url FROM proxy').all();
      const up = db_().prepare('UPDATE proxy SET url = ? WHERE id = ?');
      for (const r of rows) {
        if (!String(r.url || '').startsWith(ENC_PREFIX)) {
          up.run(sealUrl(openUrl(r.url)), r.id);
        }
      }
    }
  } catch (e) {
    console.warn('[proxy] 升级代理凭据加密失败:', e.message);
  }

  if (!isProxyEnabled()) {
    console.log('[proxy] 代理功能已关闭，跳过全部绑定');
    return { ok: true, applied: 0, failed: [], total: 0, disabled: true };
  }
  const rows = db_()
    .prepare(
      `SELECT a.id, a.uid, a.nickname, p.url
       FROM account a JOIN proxy p ON a.proxy_id = p.id
       WHERE a.proxy_id IS NOT NULL AND (p.enabled IS NULL OR p.enabled != 0)`,
    )
    .all();

  let applied = 0;
  const failed = [];
  for (const r of rows) {
    if (!r.uid) continue; // 还没登录过，等下次
    // 先标记为“必须走代理”：即使 agent 初始化失败，后续请求也会 fail-closed
    markProxyRequired(String(r.uid));
    rememberProxyCredential(openUrl(r.url));
    const res = setAccountProxy(String(r.uid), openUrl(r.url));
    if (res.ok) applied++;
    else failed.push({ accountId: r.id, nickname: r.nickname, error: res.error });
  }
  if (applied) console.log(`[proxy] 已为 ${applied} 个账号装载代理`);
  return { ok: true, applied, failed, total: rows.length };
}

/** 账号当前绑定的代理 URL（已解密）；没有绑定返回 null */
export function getAccountProxyUrl(accountId) {
  const row = db_()
    .prepare(
      `SELECT p.url FROM account a JOIN proxy p ON a.proxy_id = p.id
       WHERE a.id = ? AND a.proxy_id IS NOT NULL
         AND (p.enabled IS NULL OR p.enabled != 0)`,
    )
    .get(accountId);
  return row?.url ? openUrl(row.url) : null;
}

/**
 * 账号上线后校验实际出口 IP。
 * - 未绑定代理：不检测
 * - IP 与上次不同：标记 changed，UI 应提示并暂停该账号自动操作
 * - 检测失败：标记 failed
 */
export async function verifyAccountExitIp(accountId) {
  const url = getAccountProxyUrl(accountId);
  if (!url) return { ok: false, reason: 'direct' };

  const prev = db_()
    .prepare('SELECT exit_ip FROM account WHERE id = ?')
    .get(accountId)?.exit_ip;
  const r = await probeExitIp(url);
  let status = 'failed';
  if (r.ok) status = prev && prev !== r.ip ? 'changed' : 'ok';

  db_()
    .prepare(
      `UPDATE account SET exit_ip = ?, exit_ip_checked_at = ?, exit_ip_status = ?
       WHERE id = ?`,
    )
    .run(r.ip ?? prev ?? null, Date.now(), status, accountId);

  if (r.ok) {
    db_()
      .prepare(
        `UPDATE proxy SET status = 'ok', exit_ip = ?, location = ?, latency_ms = ?, checked_at = ?
         WHERE id = (SELECT proxy_id FROM account WHERE id = ?)`,
      )
      .run(r.ip ?? null, r.loc ?? null, r.latencyMs ?? null, Date.now(), accountId);
  }
  return { ...r, status };
}

/** 账号当前的代理状态（合并 DB + 内存） */
export function accountProxyState(accountId) {
  const row = db_()
    .prepare(
      `SELECT a.proxy_id, a.uid, a.exit_ip, a.exit_ip_checked_at, a.exit_ip_status,
              p.name, p.status AS proxy_status, p.exit_ip AS proxy_exit_ip,
              p.location, p.latency_ms, p.url
       FROM account a LEFT JOIN proxy p ON a.proxy_id = p.id WHERE a.id = ?`,
    )
    .get(accountId);
  const mem = row?.uid ? getAccountProxyInfo(String(row.uid)) : { bound: false };
  return {
    bound: !!row?.proxy_id,
    proxyId: row?.proxy_id ?? null,
    name: row?.name ?? null,
    proxyStatus: row?.proxy_status ?? null,
    exitIp: row?.exit_ip ?? row?.proxy_exit_ip ?? null,
    proxyExitIp: row?.proxy_exit_ip ?? null,
    exitIpCheckedAt: row?.exit_ip_checked_at ?? null,
    exitIpStatus: row?.exit_ip_status ?? 'unknown',
    location: row?.location ?? null,
    latencyMs: row?.latency_ms ?? null,
    maskedUrl: row?.url ? maskUrl(openUrl(row.url)) : null,
    applied: mem.bound,
  };
}

/** 批量获取账号绑定关系（给账号页用） */
export function proxyMap() {
  const rows = db_()
    .prepare(
      `SELECT a.id AS account_id, a.exit_ip AS account_exit_ip,
              a.exit_ip_checked_at, a.exit_ip_status,
              p.id AS proxy_id, p.name, p.status, p.exit_ip AS proxy_exit_ip
       FROM account a LEFT JOIN proxy p ON a.proxy_id = p.id`,
    )
    .all();
  const out = {};
  for (const r of rows) {
    out[r.account_id] = r.proxy_id
      ? {
          proxyId: r.proxy_id,
          name: r.name,
          status: r.status,
          exitIp: r.account_exit_ip || r.proxy_exit_ip || null,
          exitIpStatus: r.exit_ip_status || 'unknown',
          exitIpCheckedAt: r.exit_ip_checked_at || null,
        }
      : null;
  }
  return out;
}
