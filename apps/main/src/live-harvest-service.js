/**
 * 直播间线索采集
 *
 * 抖音直播页会主动关闭 Electron 窗口，因此这里使用本机 Chrome/Edge 无头模式，
 * 通过 CDP 读取页面自己发出的已签名请求：
 *   /webcast/room/web/enter/  房间信息
 *   /webcast/ranklist/audience/ 在线观众（JSON）
 *   /webcast/im/fetch/        直播评论（protobuf 长轮询）
 *
 * 只读采集，不登录、不发言、不发送消息。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'undici';
import { HarvestError } from './harvest-service.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 输入解析 ──
export function parseLiveInput(raw) {
  const rooms = [];
  const invalid = [];
  const shortLinks = [];
  const seen = new Set();

  for (const line of String(raw ?? '').split(/[\r\n]+/)) {
    const t = line.trim();
    if (!t) continue;
    let webRid = '';
    const byUrl = t.match(/live\.douyin\.com\/(\d{5,25})/i);
    if (byUrl) webRid = byUrl[1];
    else if (/^\d{5,25}$/.test(t)) webRid = t;

    if (!webRid) {
      if (/v\.douyin\.com/i.test(t)) shortLinks.push(t.slice(0, 120));
      invalid.push(t.slice(0, 80));
      continue;
    }
    if (seen.has(webRid)) continue;
    seen.add(webRid);
    rooms.push({ webRid, url: `https://live.douyin.com/${webRid}` });
  }

  return { rooms, invalid, shortLinks };
}

export function findBrowserExecutable() {
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
    throw new HarvestError('live_proxy_invalid', '账号代理地址无效');
  }
  if (u.username || u.password) {
    throw new HarvestError('live_proxy_auth', '直播采集暂不支持带账号密码的代理，请给该账号换一个免认证代理');
  }
  const scheme = u.protocol === 'socks5:' || u.protocol === 'socks4:'
    ? u.protocol.replace(':', '')
    : 'http';
  return [`--proxy-server=${scheme}://${u.host}`];
}

// ── 极简 protobuf 解码（只取直播评论需要的字段）──
function readVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length) {
    const b = buf[i++];
    result |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return { value: result, offset: i };
    shift += 7n;
    if (shift > 70n) return null;
  }
  return null;
}

function numberOrString(v) {
  return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : String(v);
}

function parseProto(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const key = readVarint(buf, i);
    if (!key) break;
    i = key.offset;
    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (!field) break;

    if (wire === 0) {
      const v = readVarint(buf, i);
      if (!v) break;
      i = v.offset;
      out.push({ field, wire, value: numberOrString(v.value) });
    } else if (wire === 1) {
      if (i + 8 > buf.length) break;
      out.push({ field, wire, value: buf.subarray(i, i + 8) });
      i += 8;
    } else if (wire === 2) {
      const len = readVarint(buf, i);
      if (!len) break;
      i = len.offset;
      const n = Number(len.value);
      if (!Number.isFinite(n) || n < 0 || i + n > buf.length) break;
      out.push({ field, wire, value: buf.subarray(i, i + n) });
      i += n;
    } else if (wire === 5) {
      if (i + 4 > buf.length) break;
      out.push({ field, wire, value: buf.subarray(i, i + 4) });
      i += 4;
    } else {
      break;
    }
  }
  return out;
}

const fieldBuf = (fields, n) => fields.find((x) => x.field === n && x.wire === 2)?.value;
const fieldVar = (fields, n) => fields.find((x) => x.field === n && x.wire === 0)?.value;
const fieldText = (fields, n) => {
  const b = fieldBuf(fields, n);
  if (!b) return '';
  try { return b.toString('utf8'); } catch { return ''; }
};

/** 从 /webcast/im/fetch/ 的 protobuf 响应里取聊天评论 */
export function decodeLiveComments(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return [];
  const out = [];
  for (const item of parseProto(buf)) {
    if (item.field !== 1 || item.wire !== 2) continue;
    const msg = parseProto(item.value);
    const method = fieldText(msg, 1);
    if (method !== 'WebcastChatMessage') continue;
    const payload = fieldBuf(msg, 2);
    if (!payload) continue;
    const body = parseProto(payload);
    const user = parseProto(fieldBuf(body, 2) || Buffer.alloc(0));
    const uid = fieldVar(user, 1);
    if (!uid) continue;
    const content = fieldText(body, 3).trim();
    if (!content) continue;
    const seconds = Number(fieldVar(body, 15) || 0);
    out.push({
      uid: String(uid),
      nickname: fieldText(user, 3) || null,
      content,
      commentAt: seconds > 0 ? seconds * 1000 : Date.now(),
      msgId: String(fieldVar(msg, 3) ?? ''),
    });
  }
  return out;
}

export function parseLiveAudience(json) {
  const ranks = json?.data?.ranks;
  if (!Array.isArray(ranks)) return [];
  const out = [];
  for (const r of ranks) {
    const u = r?.user;
    if (!u) continue;
    const uid = String(u.id_str ?? u.id ?? '');
    // 111111 是抖音对匿名观众/匿名评论的占位 UID，不能作为线索
    if (!uid || uid === '111111' || uid === '0') continue;
    out.push({
      uid,
      secUid: u.sec_uid || null,
      nickname: u.nickname || null,
    });
  }
  return out;
}

export function parseLiveRoom(json) {
  const r = json?.data?.data?.[0];
  if (!r) return null;
  const owner = r.owner || {};
  return {
    roomId: String(r.id_str ?? ''),
    title: String(r.title ?? ''),
    status: Number(r.status) || 0,
    online: Number(r.room_view_stats?.display_value) || 0,
    onlineText: String(r.room_view_stats?.display_short ?? r.stats?.user_count_str ?? ''),
    ownerUid: String(owner.id_str ?? r.owner_user_id_str ?? ''),
    ownerSecUid: owner.sec_uid || null,
    ownerName: owner.nickname || null,
  };
}

// ── CDP 客户端 ──
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

async function waitDebug(port, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new HarvestError('live_browser_start', '直播采集浏览器启动超时');
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('CDP 连接失败'));
  });
  return new Cdp(ws);
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
      url: 'https://live.douyin.com/',
      domain: '.douyin.com',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'None',
    });
  }
  return out;
}

/**
 * @param {object} opts
 * @param {{webRid:string,url:string}[]} opts.rooms
 * @param {string} [opts.cookies]
 * @param {string|null} [opts.proxyUrl]
 * @param {number} [opts.perRoomMs]
 * @param {(p:object)=>void} [opts.onProgress]
 * @param {(room:object)=>Promise<void>|void} [opts.onRoom]
 * @param {()=>boolean} [opts.shouldStop]
 */
export async function collectLiveRoomLeads({
  rooms = [], cookies = '', proxyUrl = null, perRoomMs = 22000,
  onProgress, onRoom, shouldStop,
} = {}) {
  const list = (rooms ?? []).filter((r) => r?.webRid);
  if (!list.length) throw new HarvestError('live_no_room', '没有有效的直播间');

  const chromePath = findBrowserExecutable();
  if (!chromePath) {
    throw new HarvestError(
      'live_no_browser',
      '未找到 Chrome/Edge，无法采集直播间。请先安装 Chrome 或 Edge。',
    );
  }

  const port = await freePort();
  const profileDir = path.join(os.tmpdir(), `zmtjl-live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(profileDir, { recursive: true });

  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--mute-audio',
    '--window-size=1280,900',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    ...proxyArgs(proxyUrl),
    'about:blank',
  ];

  let chrome = null;
  let ws = null;
  let cdp = null;
  let requests = 0;

  try {
    chrome = spawn(chromePath, args, { stdio: 'ignore', windowsHide: true });
    chrome.on('error', () => {});

    await waitDebug(port, 15000);
    const targetRes = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
    if (!targetRes.ok) throw new HarvestError('live_browser_target', '无法创建直播采集页面');
    const target = await targetRes.json();
    cdp = await connect(target.webSocketDebuggerUrl);
    ws = cdp.ws;

    let currentRoomId = '';
    let currentAnchorId = '';
    let roomInfo = null;
    let audience = [];
    let comments = [];
    let pendingBodies = new Map();

    cdp.on((msg) => {
      if (msg.method === 'Network.requestWillBeSent') {
        const url = msg.params?.request?.url ?? '';
        if (/\/webcast\/(room\/web\/enter|ranklist\/audience|im\/fetch)\//.test(url)) {
          requests++;
          try {
            const u = new URL(url);
            const rid = u.searchParams.get('room_id');
            const aid = u.searchParams.get('anchor_id');
            if (rid) currentRoomId = rid;
            if (aid) currentAnchorId = aid;
          } catch {}
          pendingBodies.set(msg.params.requestId, url);
        }
        return;
      }
      if (msg.method !== 'Network.loadingFinished') return;
      const url = pendingBodies.get(msg.params.requestId);
      if (!url) return;
      pendingBodies.delete(msg.params.requestId);
      cdp.send('Network.getResponseBody', { requestId: msg.params.requestId })
        .then((r) => {
          const buf = Buffer.from(r.body, r.base64Encoded ? 'base64' : 'utf8');
          if (url.includes('/webcast/room/web/enter/')) {
            try {
              roomInfo = parseLiveRoom(JSON.parse(buf.toString('utf8')));
            } catch {}
          } else if (url.includes('/webcast/ranklist/audience/')) {
            try { audience = parseLiveAudience(JSON.parse(buf.toString('utf8'))); } catch {}
          } else if (url.includes('/webcast/im/fetch/')) {
            try { comments.push(...decodeLiveComments(buf)); } catch {}
          }
        })
        .catch(() => {});
    });

    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.setUserAgentOverride', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });

    const cookiesToSet = cookiePayload(cookies);
    if (cookiesToSet.length) {
      await cdp.send('Network.setCookies', { cookies: cookiesToSet }).catch(() => {});
    }

    const roomResults = [];
    for (let i = 0; i < list.length; i++) {
      if (shouldStop?.()) throw new HarvestError('live_cancelled', '采集已取消');
      const room = list[i];
      roomInfo = null;
      currentRoomId = '';
      currentAnchorId = '';
      audience = [];
      comments = [];
      pendingBodies = new Map();

      onProgress?.({
        phase: 'live', done: i, total: list.length,
        webRid: room.webRid, title: '', viewers: 0, comments: 0, people: 0,
      });

      await cdp.send('Page.navigate', { url: room.url });
      const started = Date.now();
      let lastProgress = 0;
      // 等房间信息和观众列表都出现；观众接口通常比评论晚
      while (Date.now() - started < perRoomMs) {
        if (shouldStop?.()) throw new HarvestError('live_cancelled', '采集已取消');
        const now = Date.now();
        if (now - lastProgress >= 2000) {
          lastProgress = now;
          onProgress?.({
            phase: 'live', done: i, total: list.length,
            webRid: room.webRid, title: roomInfo?.title || '',
            viewers: audience.length, comments: comments.length,
            people: new Set([...audience.map((u) => u.uid), ...comments.map((c) => c.uid)]).size,
          });
        }
        if (audience.length && (roomInfo || comments.length)) break;
        await sleep(300);
      }

      let page = { title: '', text: '' };
      try {
        const st = await cdp.send('Runtime.evaluate', {
          expression: `({
            title: document.title || '',
            text: document.body?.innerText?.slice(0, 2000) || '',
          })`,
          returnByValue: true,
        });
        page = st.result?.value || page;
      } catch {}
      const anchorFromTitle = String(page.title || '').replace(/的抖音直播间.*$/, '').trim();
      const onlineMatch = String(page.text || '').match(/在线观众\s*·?\s*([0-9.]+\s*[万wW]?\+?)/);
      const ended = /直播已结束|直播已下线/.test(page.text || '');
      const info = roomInfo || {
        roomId: currentRoomId, title: '', status: ended ? 4 : 2, online: 0,
        onlineText: onlineMatch?.[1] || '', ownerUid: currentAnchorId,
        ownerSecUid: null, ownerName: anchorFromTitle || null,
      };
      if (!info.title) info.title = anchorFromTitle || `直播间 ${room.webRid}`;
      if (!info.onlineText && onlineMatch?.[1]) info.onlineText = onlineMatch[1];
      if (!info.roomId && currentRoomId) info.roomId = currentRoomId;
      if (!info.ownerUid && currentAnchorId) info.ownerUid = currentAnchorId;
      if (ended) info.status = 4;
      if (info.status && info.status !== 2) {
        const result = {
          webRid: room.webRid, roomId: info.roomId || currentRoomId,
          title: info.title, anchor: info.ownerName, anchorUid: info.ownerUid,
          online: info.online, onlineText: info.onlineText,
          viewers: audience.length, comments: comments.length, leads: [],
          error: '当前未开播',
        };
        roomResults.push(result);
        if (onRoom) await onRoom(result);
        onProgress?.({
          phase: 'live', done: i + 1, total: list.length,
          webRid: room.webRid, title: info.title, viewers: 0, comments: 0, people: 0,
        });
        continue;
      }

      const liveSource = {
        videoId: `live:${room.webRid}`,
        videoTitle: info.title || `直播间 ${room.webRid}`,
        keyword: info.title || `直播间 ${room.webRid}`,
      };
      const audMap = new Map();
      for (const u of audience) {
        if (info.ownerUid && u.uid === info.ownerUid) continue;
        audMap.set(u.uid, {
          uid: u.uid,
          secUid: u.secUid,
          nickname: u.nickname,
          comment: null,
          commentType: 'live_audience',
          sourceCid: null,
          commentAt: Date.now(),
          ...liveSource,
        });
      }

      const seen = new Set();
      const leads = [];
      for (const c of comments) {
        if (!c.uid || c.uid === '111111' || seen.has(c.uid)) continue;
        if (info.ownerUid && c.uid === info.ownerUid) continue;
        seen.add(c.uid);
        const base = audMap.get(c.uid);
        leads.push({
          uid: c.uid,
          secUid: base?.secUid ?? null,
          nickname: c.nickname || base?.nickname || null,
          comment: c.content,
          commentType: 'live_comment',
          sourceCid: c.msgId || null,
          commentAt: c.commentAt || Date.now(),
          ...liveSource,
        });
      }
      for (const u of audMap.values()) {
        if (seen.has(u.uid)) continue;
        u.comment = '直播间在线观众';
        leads.push(u);
      }

      const result = {
        webRid: room.webRid,
        roomId: info.roomId || currentRoomId,
        title: info.title,
        anchor: info.ownerName,
        anchorUid: info.ownerUid,
        online: info.online,
        onlineText: info.onlineText,
        viewers: audience.length,
        comments: comments.length,
        leads,
        error: leads.length
          ? null
          : (audience.length || comments.length
            ? '未获取到可用用户身份（直播间可能隐藏了观众身份）'
            : '没有采集到观众或评论，请确认链接是否正确'),
      };
      roomResults.push(result);
      if (onRoom) await onRoom(result);
      onProgress?.({
        phase: 'live', done: i + 1, total: list.length,
        webRid: room.webRid, title: info.title,
        viewers: audience.length, comments: comments.length, people: leads.length,
      });
    }

    const people = roomResults.reduce((n, r) => n + r.leads.length, 0);
    if (!people) {
      const reason = roomResults.map((r) => r.error).filter(Boolean).join('；')
        || '没有采集到可用线索';
      throw new HarvestError('live_empty', `直播采集失败：${reason}`);
    }

    return {
      rooms: roomResults,
      requests,
      people,
      viewers: roomResults.reduce((n, r) => n + r.viewers, 0),
      comments: roomResults.reduce((n, r) => n + r.comments, 0),
    };
  } catch (e) {
    if (e instanceof HarvestError) throw e;
    throw new HarvestError('live_failed', `直播采集失败：${e.message}`);
  } finally {
    try { ws?.close(); } catch {}
    try { cdp?.ws?.close(); } catch {}
    try { chrome?.kill(); } catch {}
    await sleep(800);
    try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch {}
  }
}
