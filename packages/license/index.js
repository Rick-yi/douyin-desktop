/**
 * 客户端授权
 *
 * 流程：
 *   激活：卡密 + 设备指纹 → 服务端 → Ed25519 token（本地加密保存）
 *   启动：验签 token → 计算状态（active / grace / expired / revoked / unlicensed）
 *   运行：每 6 小时心跳续签；断网 72 小时内正常，之后只读
 *
 * ★ 授权校验只是提高门槛。真正的约束在服务端（规则包/更新不下发）。
 * ★ 开发与自动化测试默认不启用（只有打包后才强制），可用 LICENSE_ENFORCE=1 打开。
 */
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { LicenseStore } from './store.js';
import { computeDeviceId } from './device.js';

const PROD_SERVER = process.env.LICENSE_SERVER || 'https://license.example.com';
const DEFAULT_SERVER = PROD_SERVER;
const GRACE_MS = 72 * 3600 * 1000;
const DEFAULT_HEARTBEAT_MS = 6 * 3600 * 1000;

const FEATURE_LABELS = {
  chat: '发消息',
  broadcast: '智能群发',
  intercept: '线索雷达',
  monitor: '持续监控',
  autoreply: '自动回复',
  proxy: '代理 IP',
  export: '导出',
  account: '账号管理',
  logs: '发送日志',
  sensitive: '敏感词',
};

export class LicenseManager {
  #store = null;
  #db;
  #safeStorage;
  #serverUrl;
  #serverLocked = false;
  #deviceId = '';
  #deviceParts = null;
  #enforce;
  #appVersion;
  #publicKeyPem = null;
  #token = null;
  #claims = null;
  #state = 'unlicensed';
  #message = '尚未激活';
  #timer = null;
  #heartbeatBusy = false;

  constructor({ db, safeStorage, isPackaged, appVersion, serverUrl, enforce }) {
    this.#db = db;
    this.#safeStorage = safeStorage;
    this.#appVersion = appVersion || '0.0.0';
    // 正式版固定连生产授权服务器；开发/测试可用 LICENSE_SERVER 覆盖
    const requestedServer = serverUrl || process.env.LICENSE_SERVER;
    this.#serverLocked = !!isPackaged;
    this.#serverUrl = normalizeUrl(
      this.#serverLocked ? PROD_SERVER : (requestedServer || DEFAULT_SERVER),
    );
    this.#enforce = enforce !== undefined
      ? !!enforce
      : (!!isPackaged || process.env.LICENSE_ENFORCE === '1');
  }

  async init() {
    // 加密存储可用性：Electron 45 起推荐异步接口
    let available = false;
    try {
      if (typeof this.#safeStorage?.isAsyncEncryptionAvailable === 'function') {
        available = await this.#safeStorage.isAsyncEncryptionAvailable();
      } else if (typeof this.#safeStorage?.isEncryptionAvailable === 'function') {
        available = this.#safeStorage.isEncryptionAvailable();
      }
    } catch {
      available = false;
    }
    this.#store = new LicenseStore({
      db: this.#db,
      safeStorage: this.#safeStorage,
      available,
    });

    // 设备指纹：优先用本地缓存的，避免偶发取不到某个硬件项导致变化
    this.#deviceId = this.#store.get('license.deviceId', '');
    if (!this.#deviceId) {
      const r = computeDeviceId();
      this.#deviceId = r.deviceId;
      this.#deviceParts = r.parts;
      this.#store.set('license.deviceId', this.#deviceId);
    }

    // 正式版只认生产服务器；旧版本没有记录服务器的本地授权也一并清掉
    const savedServer = this.#store.get('license.serverUrl', '');
    let switchedToProd = false;
    if (this.#serverLocked) {
      if (!savedServer || normalizeUrl(savedServer) !== this.#serverUrl) {
        const hadLocalLicense = !!this.#store.get('license.token');
        this.#store.clearLicense();
        this.#store.set('license.publicKeyPem', null);
        this.#publicKeyPem = null;
        this.#token = null;
        this.#claims = null;
        switchedToProd = hadLocalLicense;
      }
      this.#store.set('license.serverUrl', this.#serverUrl);
    } else if (savedServer) {
      this.#serverUrl = normalizeUrl(savedServer);
    }

    this.#publicKeyPem = this.#store.get('license.publicKeyPem', null);
    const token = await this.#store.getEncrypted('license.token');
    if (token) {
      if (!this.#publicKeyPem) {
        // 有 token 但没缓存公钥：尝试联网补一次
        try { await this.#fetchPublicKey(); } catch {}
      }
      try {
        this.#applyToken(token);
      } catch (e) {
        this.#state = 'invalid';
        this.#message = '本地授权信息损坏，请重新激活';
      }
    } else if (this.#store.get('license.revokedAt')) {
      this.#state = 'revoked';
      this.#message = '授权已被作废';
    }
    this.#recompute();
    if (switchedToProd) {
      this.#state = 'unlicensed';
      this.#message = '已切换到生产授权服务器，请重新激活';
    }
    return this.status();
  }

  // ── 查询 ──

  status() {
    const c = this.#claims ?? {};
    return {
      state: this.#state,
      enforce: this.#enforce,
      message: this.#message,
      plan: c.plan ?? this.#store.get('license.plan', null),
      features: Array.isArray(c.features) ? c.features : this.#store.getJson('license.features', []),
      expiresAt: c.exp ? Number(c.exp) * 1000 : this.#store.getNumber('license.expiresAt', 0),
      keyExpireAt: c.keyExpireAt ? Number(c.keyExpireAt) : this.#store.getNumber('license.keyExpireAt', 0),
      activatedAt: this.#store.getNumber('license.activatedAt', 0),
      lastHeartbeatAt: this.#store.getNumber('license.lastHeartbeatAt', 0),
      deviceId: this.#deviceId ? this.#deviceId.slice(0, 12) : '',
      serverLocked: this.#serverLocked,
      appVersion: this.#appVersion,
      deviceParts: this.#deviceParts,
    };
  }

  getServerUrl() {
    return this.#serverUrl;
  }

  /**
   * 功能检查
   * @param {'read'|'send'|'broadcast'|'intercept'|'monitor'|'autoreply'|'proxy'|'export'} feature
   */
  can(feature) {
    if (!this.#enforce) return { allowed: true, enforced: false };
    if (feature === 'read') return { allowed: true, enforced: true };

    if (this.#state !== 'active') {
      return {
        allowed: false,
        enforced: true,
        code: this.#state === 'grace' ? 'LICENSE_STALE' : 'LICENSE_REQUIRED',
        message: this.#message || '需要激活后才能使用',
      };
    }

    const need = feature === 'send' ? 'chat' : feature;
    const features = Array.isArray(this.#claims?.features) ? this.#claims.features : [];
    if (!features.includes(need)) {
      return {
        allowed: false,
        enforced: true,
        code: 'FEATURE_LOCKED',
        message: `当前套餐不包含「${FEATURE_LABELS[need] ?? need}」功能`,
      };
    }
    return { allowed: true, enforced: true };
  }

  // ── 动作 ──

  async activate(rawKey) {
    const key = String(rawKey ?? '').trim();
    if (!key) throw new Error('请输入卡密');
    // 激活是在线操作：强制拉最新公钥，服务端换钥后也不会验签失败
    await this.#fetchPublicKey();

    const res = await this.#post('/v1/license/activate', {
      key,
      deviceId: this.#deviceId,
      appVersion: this.#appVersion,
    });
    this.#applyToken(res.token);
    await this.#persistToken(res, { heartbeat: true });
    return this.status();
  }

  async heartbeat() {
    if (this.#heartbeatBusy) return this.status();
    this.#heartbeatBusy = true;
    try {
      const token = await this.#store.getEncrypted('license.token');
      if (!token) {
        this.#state = 'unlicensed';
        this.#message = '尚未激活';
        return this.status();
      }
      // 心跳也拉一次公钥：服务端轮换密钥后客户端能自动跟上
      await this.#fetchPublicKey();
      const res = await this.#post('/v1/license/heartbeat', {
        token,
        deviceId: this.#deviceId,
        appVersion: this.#appVersion,
      });
      this.#applyToken(res.token);
      await this.#persistToken(res, { heartbeat: true });
      return this.status();
    } catch (e) {
      this.#handleLicenseError(e);
      return this.status();
    } finally {
      this.#heartbeatBusy = false;
    }
  }

  async deactivate() {
    const token = await this.#store.getEncrypted('license.token');
    if (token) {
      try {
        await this.#post('/v1/license/deactivate', { token, deviceId: this.#deviceId });
      } catch (e) {
        // 网络失败也允许本地解绑，避免用户被卡住
        console.warn('[license] 服务端解绑失败:', e.message);
      }
    }
    this.#store.clearLicense();
    this.#token = null;
    this.#claims = null;
    this.#state = 'unlicensed';
    this.#message = '已解绑，请重新激活';
    return this.status();
  }

  async setServerUrl(url) {
    if (this.#serverLocked) {
      throw new Error('正式版已锁定生产授权服务器，不能修改');
    }
    if (this.#state === 'active') {
      throw new Error('请先解绑当前授权，再切换服务器');
    }
    this.#serverUrl = normalizeUrl(url);
    this.#store.set('license.serverUrl', this.#serverUrl);
    this.#store.set('license.publicKeyPem', null);
    this.#publicKeyPem = null;
    return this.status();
  }

  startHeartbeat({ intervalMs = DEFAULT_HEARTBEAT_MS, initialDelayMs = 8000 } = {}) {
    if (this.#timer) return;
    const kick = () => { this.heartbeat().catch(() => {}); };
    setTimeout(kick, initialDelayMs).unref?.();
    this.#timer = setInterval(kick, intervalMs);
    this.#timer.unref?.();
  }

  stopHeartbeat() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  // ── 内部 ──

  async #persistToken(res, { heartbeat }) {
    const now = Date.now();
    await this.#store.setEncrypted('license.token', res.token);
    this.#store.set('license.plan', res.plan ?? '');
    this.#store.setJson('license.features', res.features ?? []);
    this.#store.set('license.expiresAt', res.expiresAt ?? 0);
    this.#store.set('license.keyExpireAt', res.keyExpireAt ?? 0);
    this.#store.set('license.activatedAt', this.#store.getNumber('license.activatedAt', now) || now);
    if (heartbeat) this.#store.set('license.lastHeartbeatAt', now);
    this.#store.set('license.serverUrl', this.#serverUrl);
    this.#store.set('license.revokedAt', null);
  }

  #applyToken(token) {
    if (!token || typeof token !== 'string') throw new Error('缺少授权令牌');
    const dot = token.indexOf('.');
    if (dot <= 0) throw new Error('授权令牌格式错误');
    if (!this.#publicKeyPem) throw new Error('缺少服务端公钥');

    const payload = Buffer.from(token.slice(0, dot), 'base64url');
    const signature = Buffer.from(token.slice(dot + 1), 'base64url');
    const ok = cryptoVerify(null, payload, createPublicKey(this.#publicKeyPem), signature);
    if (!ok) throw new Error('授权令牌签名无效');

    const claims = JSON.parse(payload.toString('utf8'));
    if (String(claims.device) !== String(this.#deviceId)) {
      throw new Error('授权令牌与本机不匹配');
    }
    this.#token = token;
    this.#claims = claims;
    this.#recompute();
  }

  #recompute() {
    if (!this.#claims) {
      if (this.#state !== 'revoked') {
        this.#state = 'unlicensed';
        this.#message = '尚未激活';
      }
      return;
    }
    const now = Date.now();
    const exp = Number(this.#claims.exp || 0) * 1000;
    if (exp && now > exp) {
      this.#state = 'expired';
      this.#message = '授权已过期，请联网续签';
      return;
    }
    const last = this.#store.getNumber('license.lastHeartbeatAt', 0);
    if (last && now - last > GRACE_MS) {
      this.#state = 'grace';
      this.#message = '超过 72 小时未联网验证，当前为只读模式';
      return;
    }
    this.#state = 'active';
    this.#message = '';
  }

  #handleLicenseError(e) {
    const code = e?.code;
    if (code === 'KEY_REVOKED' || code === 'DEVICE_REVOKED') {
      this.#store.clearLicense();
      this.#store.set('license.revokedAt', Date.now());
      this.#token = null;
      this.#claims = null;
      this.#state = 'revoked';
      this.#message = e.message || '授权已被作废';
      return;
    }
    if (code === 'KEY_EXPIRED') {
      this.#state = 'expired';
      this.#message = e.message || '卡密已过期';
      return;
    }
    if (code === 'DEVICE_MISMATCH') {
      this.#state = 'invalid';
      this.#message = '授权与本机不匹配，请重新激活';
      return;
    }
    // 网络错误：保持现状，宽限期内继续可用
    console.warn('[license] 心跳失败（保持当前状态）:', e.message);
  }

  async #fetchPublicKey() {
    const res = await this.#request('GET', '/v1/license/public-key');
    if (!res?.pem) throw new Error('服务端未返回公钥');
    this.#publicKeyPem = res.pem;
    this.#store.set('license.publicKeyPem', res.pem);
  }

  #post(path, body) {
    return this.#request('POST', path, body);
  }

  async #request(method, path, body) {
    const url = this.#serverUrl + path;
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      const err = new Error('无法连接授权服务器，请检查网络后重试');
      err.code = 'NETWORK';
      throw err;
    }

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) {
      const err = new Error(json?.message || `授权服务器返回 HTTP ${res.status}`);
      err.code = json?.code || `HTTP_${res.status}`;
      err.status = res.status;
      throw err;
    }
    if (!json) {
      const err = new Error('授权服务器返回了空响应');
      err.code = 'BAD_RESPONSE';
      throw err;
    }
    return json;
  }
}

function normalizeUrl(url) {
  const s = String(url ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) return DEFAULT_SERVER;
  return s;
}
