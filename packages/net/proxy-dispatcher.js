/**
 * 按账号隔离的网络代理层
 *
 * 背景：
 *   协议 SDK 的 HTTP 走全局 fetch（尊重 undici dispatcher），但 IM 长连接用的是
 *   `ws` 包，内部走 http/https.request，**不认 undici 的 global dispatcher**。
 *   实测（2026-11-04，本地 CONNECT 代理）：ws 直连成功，代理一次 CONNECT 都没收到。
 *
 *   所以这里分两条链路：
 *     · HTTP  → 复合 undici dispatcher + per-account Agent
 *     · WS    → 给 patched SDK 注入 per-account HttpsProxyAgent（build/apply-sdk-patches.mjs）
 *
 * ★ 生命周期
 *   代理在「建立连接」时生效：账号重新登录 / 重连后才会换出口 IP。
 *   修改绑定后需要在账号页断开重连，UI 会提示。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import https from 'node:https';

const als = new AsyncLocalStorage();

/** accountId -> ProxyAgent */
const agents = new Map();
/** accountId -> 直连 Agent（即使不绑代理，也按账号隔离连接池） */
const directAgents = new Map();
/** accountId -> HttpsProxyAgent（给 ws 用） */
const wsAgents = new Map();
/** deviceId -> { key: string | (() => string) }，让 SDK 的 WS 连接找到账号 */
const wsDevices = new Map();
/** 记录 url，便于排查 */
const agentUrls = new Map();
/**
 * 数据库里已绑定代理的账号。
 * 即使 agent 初始化失败，也必须留在这里，dispatch 时 fail-closed，不能悄悄直连。
 */
const required = new Set();
/** 避免同一账号每次请求都刷日志 */
const lastBlockedLog = new Map();

let base = null;
let undiciMod = null;
let installed = false;
let HttpsProxyAgentCtor = null;
let blockedWsAgent = null;
let wsProxyModuleMissing = false;

/**
 * 安装复合 dispatcher（必须在任何网络请求之前调用）
 * @returns {Promise<void>}
 */
export async function installProxyDispatcher() {
  if (installed) return;
  installed = true;

  undiciMod = await import('undici');
  base = undiciMod.getGlobalDispatcher();

  try {
    ({ HttpsProxyAgent: HttpsProxyAgentCtor } = await import('https-proxy-agent'));
  } catch {
    wsProxyModuleMissing = true;
    console.error('[proxy] 缺少 https-proxy-agent，WS 代理将 fail-closed（不会直连）');
  }

  // patched SDK 的 WS 连接会调用这个钩子拿 per-account agent
  globalThis.__zmtjlWsAgent = resolveWsAgent;

  const composite = {
    dispatch(opts, handler) {
      const accountId = als.getStore()?.accountId
        ? String(als.getStore().accountId)
        : null;
      let agent = accountId ? agents.get(accountId) : null;

      // 没绑代理的账号也走独立连接池，避免所有账号共享同一条到 imapi 的连接
      if (accountId && !agent && !required.has(accountId)) {
        agent = directAgents.get(accountId);
        if (!agent && undiciMod?.Agent) {
          agent = new undiciMod.Agent({ connections: 4 });
          directAgents.set(accountId, agent);
        }
      }

      // 代理绑定失败/未初始化时不能回退直连，否则真实 IP 会泄露
      if (accountId && !agent && required.has(accountId)) {
        const err = new Error('代理未就绪，已阻断直连（请检查代理配置或稍后重连）');
        err.code = 'PROXY_UNAVAILABLE';
        const last = lastBlockedLog.get(accountId) ?? 0;
        if (Date.now() - last > 30_000) {
          lastBlockedLog.set(accountId, Date.now());
          console.error(`[proxy] 账号 ${accountId} 已绑定代理但 agent 未就绪，请求已阻断`);
        }
        try {
          handler.onError(err);
        } catch {}
        return true;
      }

      return (agent ?? base).dispatch(opts, handler);
    },
    close: () => base.close(),
    destroy: () => base.destroy(),
  };

  undiciMod.setGlobalDispatcher(composite);
  console.log('[proxy] 按账号代理层已安装（HTTP + WS）');
}

function getBlockedWsAgent() {
  if (!blockedWsAgent) {
    blockedWsAgent = new https.Agent();
    // 实例方法覆盖原型：ws 建连时直接抛错，绝不回退直连
    blockedWsAgent.createConnection = () => {
      throw new Error('WS 代理未就绪，已阻断直连（请检查代理配置或稍后重连）');
    };
  }
  return blockedWsAgent;
}

/**
 * patched SDK 在每次 WS 连接/重连时调用。
 * 找不到 deviceId 的登记信息时保持原来的直连行为，避免影响未绑定代理的账号。
 */
function resolveWsAgent({ deviceId } = {}) {
  const ref = wsDevices.get(String(deviceId || ''));
  if (!ref) return undefined;
  const key = typeof ref.key === 'function' ? ref.key() : ref.key;
  const accountId = String(key ?? '');
  if (!accountId) return undefined;

  const agent = wsAgents.get(accountId);
  if (agent) return agent;
  if (required.has(accountId)) {
    if (wsProxyModuleMissing && !lastBlockedLog.has(`ws:${accountId}`)) {
      lastBlockedLog.set(`ws:${accountId}`, Date.now());
      console.error(`[proxy] 账号 ${accountId} 的 WS 缺少代理模块，已阻断直连`);
    }
    return getBlockedWsAgent();
  }
  return undefined;
}

/** 登记 deviceId 属于哪个账号，供 WS 代理解析使用 */
export function registerWsDevice(deviceId, key) {
  const id = String(deviceId || '');
  if (!id || id === '0' || !key) return;
  wsDevices.set(id, { key });
}

/**
 * 在「某账号」的网络上下文里执行
 * 所有 SDK 调用都要包在这里面，否则代理选不中
 */
export function runWithAccount(accountId, fn) {
  if (!accountId) return fn();
  return als.run({ accountId: String(accountId) }, fn);
}

/** 当前上下文账号（调试用） */
export function currentAccountId() {
  return als.getStore()?.accountId ?? null;
}

/**
 * 给账号绑定 / 解绑代理
 * @param {string} accountId 本地账号 id
 * @param {string|null} url  形如 http://user:pass@host:port，null 表示直连
 */
export function markProxyRequired(accountId) {
  if (!accountId) return;
  required.add(String(accountId));
}

export function clearProxyRequired(accountId) {
  if (!accountId) return;
  required.delete(String(accountId));
  lastBlockedLog.delete(String(accountId));
}

export function isProxyRequired(accountId) {
  return !!accountId && required.has(String(accountId));
}

export function setAccountProxy(accountId, url) {
  const id = String(accountId);
  if (!url) {
    const oldWs = wsAgents.get(id);
    if (oldWs) {
      try { oldWs.destroy(); } catch {}
    }
    const oldProxy = agents.get(id);
    if (oldProxy) oldProxy.close().catch(() => {});
    const oldDirect = directAgents.get(id);
    if (oldDirect) oldDirect.close().catch(() => {});
    wsAgents.delete(id);
    agents.delete(id);
    directAgents.delete(id);
    agentUrls.delete(id);
    required.delete(id);
    lastBlockedLog.delete(id);
    return { ok: true, mode: 'direct' };
  }

  if (!undiciMod) {
    return { ok: false, error: '代理层未初始化' };
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: '代理地址格式不对，应形如 http://host:port' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return {
      ok: false,
      error: `协议 SDK 只支持 HTTP/HTTPS 代理（当前 ${parsed.protocol.replace(':', '')}），SOCKS5 需要本地转换`,
    };
  }

  try {
    const old = agents.get(id);
    if (old) old.close().catch(() => {});
    const oldDirect = directAgents.get(id);
    if (oldDirect) oldDirect.close().catch(() => {});
    directAgents.delete(id);

    // URL 里的 user:pass 转成 Proxy-Authorization
    const token =
      parsed.username || parsed.password
        ? 'Basic ' +
          Buffer.from(
            `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`,
          ).toString('base64')
        : undefined;

    const agent = new undiciMod.ProxyAgent({
      uri: `${parsed.protocol}//${parsed.host}`,
      token,
      proxyTunnel: true,
    });
    agents.set(id, agent);
    agentUrls.set(id, `${parsed.protocol}//${parsed.host}`);
    required.add(id);

    // ws 需要自己的 CONNECT agent；带凭据的 URL 直接交给 HttpsProxyAgent
    const oldWs = wsAgents.get(id);
    if (oldWs) {
      try { oldWs.destroy(); } catch {}
      wsAgents.delete(id);
    }
    if (HttpsProxyAgentCtor) {
      wsAgents.set(id, new HttpsProxyAgentCtor(url));
    }
    return { ok: true, mode: 'proxy', url: `${parsed.protocol}//${parsed.host}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function getAccountProxyInfo(accountId) {
  const id = String(accountId);
  return {
    bound: agents.has(id),
    url: agentUrls.get(id) ?? null,
    accounts: [...agents.keys()],
  };
}

/**
 * 用某个代理做一次真实请求，返回出口 IP
 *
 * 用 cloudflare trace 一次拿 IP + 国家码（ipify 在国内常被墙）。
 * 失败再退回 ifconfig.me。
 */
export async function probeExitIp(url, { timeoutMs = 12000 } = {}) {
  if (!undiciMod) return { ok: false, error: '代理层未初始化' };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: '地址格式错误' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, error: '只支持 HTTP/HTTPS 代理' };
  }

  const token =
    parsed.username || parsed.password
      ? 'Basic ' +
        Buffer.from(
          `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`,
        ).toString('base64')
      : undefined;

  const agent = new undiciMod.ProxyAgent({
    uri: `${parsed.protocol}//${parsed.host}`,
    token,
    proxyTunnel: true,
  });

  const started = Date.now();
  const get = async (target) => {
    const res = await undiciMod.fetch(target, {
      dispatcher: agent,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  };

  try {
    const text = await get('https://www.cloudflare.com/cdn-cgi/trace');
    const ip = /^ip=(.+)$/m.exec(text)?.[1]?.trim() ?? null;
    const loc = /^loc=(.+)$/m.exec(text)?.[1]?.trim() ?? null;
    if (!ip) throw new Error('解析出口 IP 失败');
    return { ok: true, ip, loc, latencyMs: Date.now() - started };
  } catch (e1) {
    try {
      const ip = (await get('https://ifconfig.me/ip')).trim();
      if (!/^[\d.:a-f]+$/i.test(ip)) throw new Error('返回内容不是 IP');
      return { ok: true, ip, loc: null, latencyMs: Date.now() - started };
    } catch (e2) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: e1.cause?.code || e1.name || e1.message,
      };
    }
  } finally {
    agent.close().catch(() => {});
  }
}

/**
 * 通过指定代理请求一个 URL（用于归属地等辅助查询，避免直连泄露本机 IP）
 */
export async function fetchViaProxy(proxyUrl, targetUrl, { timeoutMs = 5000 } = {}) {
  if (!undiciMod) return { ok: false, error: '代理层未初始化' };
  let parsed;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    return { ok: false, error: '代理地址格式错误' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, error: '只支持 HTTP/HTTPS 代理' };
  }
  const token =
    parsed.username || parsed.password
      ? 'Basic ' +
        Buffer.from(
          `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`,
        ).toString('base64')
      : undefined;
  const agent = new undiciMod.ProxyAgent({
    uri: `${parsed.protocol}//${parsed.host}`,
    token,
    proxyTunnel: true,
  });
  try {
    const res = await undiciMod.fetch(targetUrl, {
      dispatcher: agent,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e.cause?.code || e.name || e.message };
  } finally {
    agent.close().catch(() => {});
  }
}

/** 关闭所有代理连接（退出前调用） */
export async function closeAllProxyAgents() {
  for (const a of agents.values()) {
    try { await a.close(); } catch {}
  }
  for (const a of directAgents.values()) {
    try { await a.close(); } catch {}
  }
  for (const a of wsAgents.values()) {
    try { a.destroy(); } catch {}
  }
  agents.clear();
  directAgents.clear();
  wsAgents.clear();
  wsDevices.clear();
  agentUrls.clear();
  required.clear();
  lastBlockedLog.clear();
}

export function proxyDebugState() {
  return {
    installed,
    baseReady: !!base,
    agents: Object.fromEntries(agentUrls),
    required: [...required],
    directAgents: [...directAgents.keys()],
    wsAgents: [...wsAgents.keys()],
    wsDevices: [...wsDevices.keys()],
    wsProxyModuleMissing,
    current: currentAccountId(),
  };
}
