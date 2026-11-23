/**
 * 授权本地存储
 *
 * token 用 Electron safeStorage（Windows 下是 DPAPI）加密后存 setting 表。
 * 卡密本身不落盘：token 失效时用卡密重新激活即可，用户自己保管卡密。
 */

const PREFIX_ENC = 'enc:';
const PREFIX_PLAIN = 'plain:';

export class LicenseStore {
  #db;
  #safe;
  #available;

  /**
   * @param {object} p
   * @param {object} p.db  node:sqlite DatabaseSync
   * @param {object} p.safeStorage Electron safeStorage
   * @param {boolean} p.available 加密是否可用（由 LicenseManager 异步探测）
   */
  constructor({ db, safeStorage, available }) {
    this.#db = db;
    this.#safe = safeStorage;
    this.#available = !!available;
  }

  get(key, fallback = null) {
    try {
      const row = this.#db.prepare('SELECT value FROM setting WHERE key = ?').get(key);
      return row ? row.value : fallback;
    } catch {
      return fallback;
    }
  }

  set(key, value) {
    try {
      if (value === null || value === undefined) {
        this.#db.prepare('DELETE FROM setting WHERE key = ?').run(key);
      } else {
        this.#db
          .prepare(
            'INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          )
          .run(key, String(value));
      }
    } catch (e) {
      console.error('[license] 写 setting 失败', e.message);
    }
  }

  getNumber(key, fallback = 0) {
    const v = Number(this.get(key, ''));
    return Number.isFinite(v) ? v : fallback;
  }

  getJson(key, fallback = null) {
    try {
      const raw = this.get(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  setJson(key, value) {
    this.set(key, JSON.stringify(value));
  }

  async getEncrypted(key) {
    const raw = this.get(key);
    if (!raw) return null;
    try {
      if (raw.startsWith(PREFIX_ENC)) {
        const buf = Buffer.from(raw.slice(PREFIX_ENC.length), 'base64');
        if (typeof this.#safe?.decryptStringAsync === 'function') {
          // Electron 45 的异步接口返回 { shouldReEncrypt, result }
          const out = await this.#safe.decryptStringAsync(buf);
          return typeof out === 'string' ? out : (out?.result ?? '');
        }
        return this.#safe.decryptString(buf);
      }
      if (raw.startsWith(PREFIX_PLAIN)) {
        return Buffer.from(raw.slice(PREFIX_PLAIN.length), 'base64').toString('utf8');
      }
      // 兼容旧格式
      return Buffer.from(raw, 'base64').toString('utf8');
    } catch (e) {
      console.error('[license] 解密失败', e.message);
      return null;
    }
  }

  async setEncrypted(key, value) {
    if (value === null || value === undefined) {
      this.set(key, null);
      return;
    }
    if (this.#available) {
      const enc = typeof this.#safe?.encryptStringAsync === 'function'
        ? await this.#safe.encryptStringAsync(String(value))
        : this.#safe.encryptString(String(value));
      this.set(key, PREFIX_ENC + Buffer.from(enc).toString('base64'));
    } else {
      // 没有系统密钥环时降级（Windows 基本不会走到这里）
      console.warn('[license] safeStorage 不可用，token 以明文 base64 保存');
      this.set(key, PREFIX_PLAIN + Buffer.from(String(value), 'utf8').toString('base64'));
    }
  }

  clearLicense() {
    for (const k of [
      'license.token',
      'license.plan',
      'license.features',
      'license.expiresAt',
      'license.keyExpireAt',
      'license.lastHeartbeatAt',
      'license.activatedAt',
      'license.revokedAt',
    ]) {
      this.set(k, null);
    }
  }
}
