/**
 * 客户端更新检查 / 下载 / 安装
 *
 * 服务端 `GET /v1/app/version` 返回清单；下载地址与 SHA256 都由服务端给出。
 * 流程：检查 → 下载 → 校验 SHA256 → 启动安装程序并退出旧版本。
 *
 * ★ 强制更新只由服务端 `force` 决定；客户端不自行降级或跳过校验。
 * ★ 任何下载文件都必须通过 SHA256 校验后才能执行。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const CHECK_TIMEOUT_MS = 15000;
const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 200;

export class UpdateService {
  #appVersion;
  #getServerUrl;
  #downloadDir;
  #onEvent;
  #fetch;
  #platform;
  #channel;
  #verifyInstaller;

  #state = 'idle';
  #manifest = null;
  #checkedAt = 0;
  #error = null;
  #filePath = '';
  #fileName = '';
  #received = 0;
  #total = 0;
  #busy = false;

  constructor({
    appVersion,
    getServerUrl,
    downloadDir,
    onEvent,
    fetchImpl,
    platform = 'win',
    channel = 'stable',
    verifyInstaller,
  }) {
    this.#appVersion = String(appVersion || '0.0.0');
    this.#getServerUrl = getServerUrl;
    this.#downloadDir = downloadDir;
    this.#onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    this.#fetch = fetchImpl || globalThis.fetch;
    this.#platform = platform;
    this.#channel = channel;
    this.#verifyInstaller = typeof verifyInstaller === 'function' ? verifyInstaller : null;
  }

  status() {
    const m = this.#manifest ?? {};
    return {
      state: this.#state,
      checkedAt: this.#checkedAt,
      currentVersion: this.#appVersion,
      latestVersion: m.latestVersion ?? '',
      minSupportedVersion: m.minSupportedVersion ?? '',
      updateAvailable: !!m.updateAvailable,
      force: !!m.force,
      notes: m.notes ?? '',
      publishedAt: m.publishedAt ?? '',
      downloadUrl: m.downloadUrl ?? '',
      sha256: m.sha256 ?? '',
      fileName: this.#fileName,
      received: this.#received,
      total: this.#total,
      percent: this.#total > 0 ? Math.min(100, Math.round((this.#received / this.#total) * 100)) : 0,
      error: this.#error,
    };
  }

  /** 强制更新未完成时，业务层必须停止发送/采集 */
  isForceBlocking() {
    return !!(this.#manifest?.updateAvailable && this.#manifest?.force);
  }

  async check({ timeoutMs = CHECK_TIMEOUT_MS } = {}) {
    // 下载/安装过程中不要再发检查，避免把 ready 状态覆盖回 available
    if (this.#state === 'downloading' || this.#state === 'installing') return this.status();
    if (this.#state === 'ready' && this.#filePath && fs.existsSync(this.#filePath)) return this.status();
    if (this.#busy) return this.status();
    this.#busy = true;
    this.#error = null;
    this.#state = 'checking';
    this.#emitState();

    try {
      const base = this.#baseUrl();
      if (!base) throw new Error('未配置授权服务器，无法检查更新');

      const url = new URL('/v1/app/version', base);
      url.searchParams.set('current', this.#appVersion);
      url.searchParams.set('platform', this.#platform);
      url.searchParams.set('channel', this.#channel);
      url.searchParams.set('_t', String(Date.now()));

      const res = await this.#fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch {}
      if (!res.ok) {
        throw new Error(json?.message || `更新服务返回 HTTP ${res.status}`);
      }
      if (!json || typeof json !== 'object') {
        throw new Error('更新服务返回了空响应');
      }

      const manifest = {
        latestVersion: String(json.latestVersion ?? ''),
        minSupportedVersion: String(json.minSupportedVersion ?? ''),
        updateAvailable: json.updateAvailable === true,
        force: json.force === true,
        notes: String(json.notes ?? ''),
        publishedAt: String(json.publishedAt ?? ''),
        downloadUrl: String(json.downloadUrl ?? ''),
        sha256: String(json.sha256 ?? '').toLowerCase(),
      };

      this.#checkedAt = Date.now();
      this.#manifest = manifest;
      this.#resetDownload();

      if (json.enabled !== true) {
        this.#state = 'disabled';
        this.#emitState();
        return this.status();
      }
      if (!manifest.updateAvailable) {
        this.#state = 'up-to-date';
        this.#emitState();
        return this.status();
      }
      if (!manifest.latestVersion) throw new Error('更新清单缺少版本号');
      if (!isHttpUrl(manifest.downloadUrl)) throw new Error('更新清单缺少有效的下载地址');
      if (!/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error('更新清单缺少有效的 SHA256');

      this.#state = 'available';
      this.#emitState();
      return this.status();
    } catch (e) {
      this.#error = e.message || '检查更新失败';
      this.#state = 'error';
      this.#emitState();
      return this.status();
    } finally {
      this.#busy = false;
    }
  }

  async download() {
    if (this.#busy) return this.status();
    if (!this.#manifest?.updateAvailable) throw new Error('当前没有可下载的更新');
    this.#busy = true;
    this.#error = null;
    this.#resetDownload();
    this.#state = 'downloading';
    this.#emitState();

    let partPath = '';
    try {
      const m = this.#manifest;
      if (!isHttpUrl(m.downloadUrl)) throw new Error('下载地址无效');
      if (!/^[a-f0-9]{64}$/.test(m.sha256)) throw new Error('SHA256 无效');

      await fsp.mkdir(this.#downloadDir, { recursive: true });
      await this.#pruneDownloadDir();
      const fallback = `Shantuo-Setup-${safeVersion(m.latestVersion)}.exe`;
      const res = await this.#fetch(m.downloadUrl, {
        headers: { Accept: 'application/octet-stream' },
        redirect: 'follow',
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
      if (!res.body) throw new Error('下载响应为空');
      if (!isHttpUrl(res.url || m.downloadUrl)) throw new Error('下载重定向到了非 HTTP(S) 地址');

      const name = safeFileName(contentDispositionName(res.headers.get('content-disposition')) || urlBasename(m.downloadUrl) || fallback);
      const total = Number(res.headers.get('content-length') || 0);
      if (total > MAX_DOWNLOAD_BYTES) throw new Error('安装包超过 1GB，已拒绝下载');
      this.#fileName = name;
      this.#total = total > 0 ? total : 0;
      this.#received = 0;

      const finalPath = path.join(this.#downloadDir, `${Date.now()}-${name}`);
      partPath = `${finalPath}.part`;
      const hash = createHash('sha256');
      let lastEmit = 0;

      const meter = new Transform({
        transform: (chunk, _enc, cb) => {
          hash.update(chunk);
          this.#received += chunk.length;
          if (this.#received > MAX_DOWNLOAD_BYTES) {
            cb(new Error('安装包超过 1GB，已中止下载'));
            return;
          }
          const now = Date.now();
          if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
            lastEmit = now;
            this.#emit({ type: 'progress', ...this.status() });
          }
          cb(null, chunk);
        },
      });

      await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(partPath));
      const actual = hash.digest('hex');
      if (actual !== m.sha256) {
        throw new Error(`安装包校验失败（期望 ${m.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`);
      }
      if (this.#verifyInstaller) {
        const v = await this.#verifyInstaller(partPath);
        if (!v?.ok) throw new Error(v?.error || '安装包签名校验失败');
      }

      await fsp.rename(partPath, finalPath);
      partPath = '';
      this.#filePath = finalPath;
      this.#received = this.#total || this.#received;
      this.#state = 'ready';
      this.#emitState();
      return this.status();
    } catch (e) {
      this.#error = e.message || '下载更新失败';
      this.#state = 'error';
      this.#emitState();
      if (partPath) await fsp.rm(partPath, { force: true }).catch(() => {});
      throw e;
    } finally {
      this.#busy = false;
    }
  }

  /**
   * 启动已下载的安装包，并退出当前进程。
   * @param {{ openPath: (file: string) => Promise<string>, quit: () => void }} launcher
   */
  async install({ openPath, quit }) {
    if (this.#state !== 'ready') throw new Error('安装包尚未下载完成');
    if (!this.#filePath || !fs.existsSync(this.#filePath)) throw new Error('安装包不存在，请重新下载');
    const ext = path.extname(this.#filePath).toLowerCase();
    if (ext !== '.exe' && ext !== '.msi') {
      throw new Error('安装包格式不支持自动安装，请手动打开下载目录');
    }

    const err = await openPath(this.#filePath);
    if (err) throw new Error(`无法启动安装程序：${err}`);
    this.#state = 'installing';
    this.#emitState();
    setTimeout(() => quit(), 800);
    return this.status();
  }

  /** 打开下载目录并选中安装包（zip 等无法自动安装时使用） */
  async reveal() {
    if (!this.#filePath) throw new Error('还没有下载安装包');
    return this.#filePath;
  }

  async #pruneDownloadDir() {
    try {
      const cutoff = Date.now() - 7 * 86400000;
      const partCutoff = Date.now() - 86400000;
      for (const name of await fsp.readdir(this.#downloadDir)) {
        const file = path.join(this.#downloadDir, name);
        const st = await fsp.stat(file).catch(() => null);
        if (!st?.isFile()) continue;
        if (name.endsWith('.part') ? st.mtimeMs < partCutoff : st.mtimeMs < cutoff) {
          await fsp.rm(file, { force: true }).catch(() => {});
        }
      }
    } catch {}
  }

  #baseUrl() {
    const raw = typeof this.#getServerUrl === 'function' ? this.#getServerUrl() : this.#getServerUrl;
    const s = String(raw ?? '').trim().replace(/\/+$/, '');
    return /^https?:\/\//i.test(s) ? s : '';
  }

  #resetDownload() {
    this.#filePath = '';
    this.#fileName = '';
    this.#received = 0;
    this.#total = 0;
  }

  #emitState() {
    this.#emit({ type: 'state', ...this.status() });
  }

  #emit(payload) {
    try { this.#onEvent(payload); } catch {}
  }
}

function isHttpUrl(raw) {
  try {
    const u = new URL(String(raw));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function contentDispositionName(header) {
  const s = String(header || '');
  if (!s) return '';
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(s);
  if (star) {
    try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch {}
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(s);
  return plain ? plain[1].trim() : '';
}

function urlBasename(raw) {
  try {
    return path.basename(decodeURIComponent(new URL(raw).pathname));
  } catch {
    return '';
  }
}

function safeFileName(raw) {
  const name = path.basename(String(raw || '')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  return name || 'Shantuo-Setup.exe';
}

function safeVersion(raw) {
  return String(raw || '0.0.0').replace(/[^0-9A-Za-z._-]/g, '_');
}
