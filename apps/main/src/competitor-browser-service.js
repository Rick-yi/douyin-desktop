/**
 * 同行主页作品采集（Chrome/Edge 无头模式）
 *
 * 抖音用户主页的作品接口需要页面自身生成的签名，这里直接加载主页，
 * 捕获 /aweme/v1/web/aweme/post/ 响应，并滚动到全部作品加载完成。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'undici';
import { HarvestError } from './harvest-service.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowserExecutable() {
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [
    process.env.LIVE_BROWSER_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(local, 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    path.join(local, 'Microsoft\\Edge\\Application\\msedge.exe'),
  ].filter(Boolean);
  return candidates.find((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  }) || '';
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

function proxyArgs(proxyUrl) {
  if (!proxyUrl) return [];
  let u;
  try { u = new URL(proxyUrl); } catch {
    throw new HarvestError('competitor_proxy_invalid', '账号代理地址无效');
  }
  if (u.username || u.password) {
    throw new HarvestError('competitor_proxy_auth', '同行采集暂不支持带账号密码的代理，请换一个免认证代理');
  }
  const scheme = u.protocol === 'socks5:' || u.protocol === 'socks4:'
    ? u.protocol.replace(':', '') : 'http';
  return [`--proxy-server=${scheme}://${u.host}`];
}

function cookiePayload(cookies) {
  const out = [];
  for (const part of String(cookies ?? '').split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name) continue;
    out.push({
      name, value,
      url: 'https://www.douyin.com/',
      domain: '.douyin.com',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'None',
    });
  }
  return out;
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = [];
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
        }
      } else {
        for (const h of this.handlers) h(msg);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(fn) { this.handlers.push(fn); }
}

async function waitJson(url, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(250);
  }
  throw new HarvestError('competitor_browser_start', '同行采集浏览器启动超时');
}

export function parseUserPosts(body) {
  const j = typeof body === 'string' ? JSON.parse(body) : body;
  const list = Array.isArray(j?.aweme_list) ? j.aweme_list : [];
  const videos = [];
  for (const a of list) {
    const awemeId = String(a?.aweme_id ?? '');
    if (!awemeId) continue;
    const st = a.statistics || {};
    const cover = a.video?.cover?.url_list?.[0]
      || a.video?.origin_cover?.url_list?.[0]
      || a.cover?.url_list?.[0]
      || null;
    videos.push({
      awemeId,
      title: String(a.desc ?? '').slice(0, 500),
      coverUrl: cover,
      createTime: Number(a.create_time) > 0 ? Number(a.create_time) * 1000 : null,
      diggCount: Number(st.digg_count) || 0,
      commentCount: Number(st.comment_count) || 0,
      shareCount: Number(st.share_count) || 0,
      shareUrl: `https://www.douyin.com/video/${awemeId}`,
    });
  }
  return {
    videos,
    hasMore: Number(j?.has_more) > 0,
    maxCursor: Number(j?.max_cursor) || 0,
  };
}

export class CompetitorBrowser {
  constructor({ chromePath, profileDir, chrome, cdp, port }) {
    this.chromePath = chromePath;
    this.profileDir = profileDir;
    this.chrome = chrome;
    this.cdp = cdp;
    this.port = port;
    this.closed = false;
  }

  static async launch({ cookies = '', proxyUrl = null } = {}) {
    const chromePath = findBrowserExecutable();
    if (!chromePath) {
      throw new HarvestError(
        'competitor_no_browser',
        '未找到 Chrome/Edge，无法采集同行作品。请先安装 Chrome 或 Edge。',
      );
    }

    const port = await freePort();
    const profileDir = path.join(os.tmpdir(), `zmtjl-competitor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(profileDir, { recursive: true });

    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--mute-audio',
      '--window-size=1280,900',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      ...proxyArgs(proxyUrl),
      'about:blank',
    ];

    const chrome = spawn(chromePath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    chrome.stderr?.on('data', (d) => { stderr = (stderr + d.toString()).slice(-3000); });
    chrome.on('error', () => {});
    try {
      await waitJson(`http://127.0.0.1:${port}/json/version`, 15000);
      const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = () => reject(new Error('CDP 连接失败'));
      });
      const cdp = new Cdp(ws);
      await cdp.send('Page.enable');
      await cdp.send('Network.enable');
      await cdp.send('Runtime.enable');
      await cdp.send('Network.setUserAgentOverride', {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
          + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      });
      const cookieList = cookiePayload(cookies);
      if (cookieList.length) {
        await cdp.send('Network.setCookies', { cookies: cookieList }).catch(() => {});
      }
      return new CompetitorBrowser({ chromePath, profileDir, chrome, cdp, port });
    } catch (e) {
      try { chrome.kill(); } catch {}
      try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch {}
      const tail = stderr.trim().split(/\r?\n/).slice(-3).join(' | ');
      throw e instanceof HarvestError
        ? new HarvestError(e.code, `${e.message}${tail ? `（${tail}）` : ''}`)
        : new HarvestError('competitor_browser_start', `同行采集浏览器启动失败：${e.message}`);
    }
  }

  /**
   * 拉取某个同行的全部作品
   * @returns {Promise<{videos:object[], latestVideoAt:number|null, pages:number, hasMore:boolean, title:string}>}
   */
  async fetchVideos(secUid, { shouldStop, onPage, onFirstPage } = {}) {
    if (this.closed) throw new HarvestError('competitor_browser_closed', '同行采集浏览器已关闭');
    const cdp = this.cdp;
    const state = {
      videos: new Map(),
      pages: 0,
      hasMore: true,
      lastBodyAt: 0,
      title: '',
    };
    const pending = new Set();
    let bodyHandler = null;

    bodyHandler = (msg) => {
      if (msg.method !== 'Network.responseReceived') return;
      const url = msg.params?.response?.url ?? '';
      if (!/\/aweme\/v1\/web\/aweme\/post\//.test(url)) return;
      if (process.env.COMPETITOR_DEBUG) console.log('[competitor] post response', msg.params.response.status, url.slice(0, 160));
      pending.add(msg.params.requestId);
    };
    cdp.on(bodyHandler);

    const loadingHandler = (msg) => {
      if (msg.method !== 'Network.loadingFinished') return;
      if (!pending.has(msg.params.requestId)) return;
      pending.delete(msg.params.requestId);
      (async () => {
        let r = null;
        for (let attempt = 0; attempt < 4 && !r; attempt++) {
          try {
            r = await cdp.send('Network.getResponseBody', { requestId: msg.params.requestId });
          } catch {
            await sleep(250);
          }
        }
        if (!r) return;
        const text = Buffer.from(r.body, r.base64Encoded ? 'base64' : 'utf8').toString('utf8');
        let page;
        try { page = parseUserPosts(text); } catch { return; }
        state.pages++;
        state.hasMore = page.hasMore;
        state.lastBodyAt = Date.now();
        for (const v of page.videos) state.videos.set(v.awemeId, v);
        if (onPage) {
          try { onPage({ page: state.pages, total: state.videos.size, hasMore: state.hasMore }); } catch {}
        }
        if (state.pages === 1 && typeof onFirstPage === 'function') {
          const latest = [...state.videos.values()]
            .reduce((n, v) => Math.max(n, Number(v.createTime) || 0), 0) || null;
          try {
            if (onFirstPage({ latestVideoAt: latest, videos: page.videos }) === false) {
              state.hasMore = false;
            }
          } catch {}
        }
      })();
    };
    cdp.on(loadingHandler);

    try {
      // 主页偶尔会只返回空壳，重试一次；两次都空才判定不可访问
      for (let attempt = 0; attempt < 2 && !state.lastBodyAt; attempt++) {
        if (attempt > 0) {
          pending.clear();
          await sleep(800);
        }
        const url = attempt === 0
          ? `https://www.douyin.com/user/${secUid}`
          : `https://www.douyin.com/user/${secUid}?from_tab_name=main`;
        await cdp.send('Page.navigate', { url });
        const firstDeadline = Date.now() + 20000;
        while (Date.now() < firstDeadline) {
          if (shouldStop?.()) throw new HarvestError('competitor_cancelled', '采集已取消');
          if (state.lastBodyAt) break;
          await sleep(300);
        }
      }
      if (!state.lastBodyAt) {
        if (process.env.COMPETITOR_DEBUG) {
          try {
            const info = await cdp.send('Runtime.evaluate', {
              expression: '({url:location.href,title:document.title,html:document.documentElement?.outerHTML?.length||0})',
              returnByValue: true,
            });
            console.log('[competitor] page after timeout', info.result?.value);
          } catch {}
        }
        throw new HarvestError('competitor_profile_empty', '同行主页没有返回作品列表，可能账号不存在或不可访问');
      }

      let lastCount = -1;
      let idle = 0;
      while (state.hasMore) {
        if (shouldStop?.()) throw new HarvestError('competitor_cancelled', '采集已取消');
        await cdp.send('Runtime.evaluate', {
          expression: 'window.scrollTo(0, document.body?.scrollHeight || document.documentElement.scrollHeight)',
        }).catch(() => {});
        await sleep(1200);
        if (state.videos.size === lastCount) idle++;
        else { idle = 0; lastCount = state.videos.size; }
        // 页面可能已经加载完但 has_more 标志没更新；连续 5 次无新增就停
        if (idle >= 5) break;
      }

      try {
        const r = await cdp.send('Runtime.evaluate', {
          expression: '({title: document.title || ""})',
          returnByValue: true,
        });
        state.title = String(r.result?.value?.title || '');
      } catch {}

      const videos = [...state.videos.values()]
        .sort((a, b) => (Number(b.createTime) || 0) - (Number(a.createTime) || 0));
      const latestVideoAt = videos.reduce((n, v) => Math.max(n, Number(v.createTime) || 0), 0) || null;
      return {
        videos,
        latestVideoAt,
        pages: state.pages,
        hasMore: state.hasMore,
        title: state.title,
      };
    } finally {
      cdp.handlers = cdp.handlers.filter((h) => h !== bodyHandler && h !== loadingHandler);
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { this.cdp?.ws?.close(); } catch {}
    try { this.chrome?.kill(); } catch {}
    await sleep(600);
    try { fs.rmSync(this.profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch {}
  }
}
