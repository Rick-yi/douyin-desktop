/**
 * douyin-im SDK 封装层
 *
 * 这一层把 SDK 的 API 包成我们项目需要的形状，主进程只跟这里打交道。
 * SDK 换了版本或将来换成浏览器方案，只需要改这一层。
 *
 * ★ 最重要的一个坑（实测踩过，写在这里防遗忘）：
 *   登录上线后**不要立刻调接口**。SDK 在 system.online 瞬间会自己并行加载
 *   好友/群/陌生人，此时调 getFriendList() 会返回 status=8 用户未登录。
 *   必须等 account.fl.size > 0 或固定等 20~25 秒。
 */
import { createClient, configureLogger, setLogLevel, segment } from 'douyin-im';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { detectKind, parseMessageMeta } from './message-meta.js';
import { ensureFingerprint, migrateLegacyDeviceIdentity } from './device-fingerprint.js';

// SDK 日志：默认只报错，调试时可开 info
configureLogger({ level: process.env.SDK_LOG || 'error', color: false });
setLogLevel(process.env.SDK_LOG || 'error');

const READY_TIMEOUT_MS = 60000;
const READY_POLL_MS = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 一个 SDK 实例 = 一个 dataDir（可放多个账号）
 * 我们按「一个实例对应一个已登录账号」用，简单可控
 */
export class ImSdk {
  #dataDir;
  #client = null;
  #account = null;
  /** 登录过程中的账号引用，只用于读取 deviceId，不代表账号已就绪 */
  #identityAccount = null;
  #ready = false;
  #listeners = new Map(); // event -> Set<fn>
  #loginState = { stage: 'idle', error: null, startedAt: null };
  #qr = null;
  #verification = null;
  /** uid -> contact 对象缓存（含手工建的会话） */
  #contactCache = new Map();
  #fingerprint;
  #fingerprintLogged = new Set();
  /** 已上传图片资产：sha256 -> { asset, at } */
  #mediaCache = new Map();
  #mediaCacheFile;
  #onDevice;

  constructor(dataDir, options = {}) {
    this.#dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.#fingerprint = ensureFingerprint(dataDir);
    this.#onDevice = options.onDevice ?? null;
    this.#mediaCacheFile = path.join(dataDir, 'media-assets.json');
    this.#loadMediaCache();
    // 旧版本把随机 deviceId/installId 写进 account.json，这里一次性清掉，
    // 让 SDK 用自己的注册链重新拿服务端认可的 ID。
    migrateLegacyDeviceIdentity(dataDir, this.#fingerprint.legacyDeviceIds);
  }

  #loadMediaCache() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.#mediaCacheFile, 'utf8'));
      const ttl = 7 * 24 * 60 * 60 * 1000;
      for (const [hash, entry] of Object.entries(saved ?? {})) {
        if (entry?.asset?.oid && Date.now() - Number(entry.at || 0) < ttl) {
          this.#mediaCache.set(hash, entry);
        }
      }
    } catch {}
  }

  #saveMediaCache() {
    try {
      const entries = [...this.#mediaCache.entries()].slice(-200);
      const obj = Object.fromEntries(entries);
      const tmp = `${this.#mediaCacheFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
      try {
        fs.renameSync(tmp, this.#mediaCacheFile);
      } catch {
        fs.copyFileSync(tmp, this.#mediaCacheFile);
        try { fs.unlinkSync(tmp); } catch {}
      }
    } catch {}
  }

  #cachedImage(hash) {
    const entry = this.#mediaCache.get(hash);
    if (!entry) return null;
    if (Date.now() - Number(entry.at || 0) > 7 * 24 * 60 * 60 * 1000) {
      this.#mediaCache.delete(hash);
      return null;
    }
    return entry.asset;
  }

  #rememberImage(hash, asset) {
    if (!asset?.oid) return;
    this.#mediaCache.set(hash, { asset, at: Date.now() });
    this.#saveMediaCache();
  }

  #forgetImage(hash) {
    if (!this.#mediaCache.delete(hash)) return;
    this.#saveMediaCache();
  }

  /** 把 SDK 注册出来的设备 ID 交给代理层，WS 连接才能选到对应账号 */
  #registerDevice(account = this.#identityAccount ?? this.#account) {
    if (!account) return;
    const uid = account.uid;
    const candidates = [
      account.runtime?.connection?.deviceId,
      account.deviceProfile?.deviceId,
      uid ? account.store?.load?.(uid)?.deviceProfile?.deviceId : null,
    ];
    const deviceId = candidates.find((id) => id && String(id) !== '0');
    if (!deviceId) return;
    try {
      this.#onDevice?.(String(deviceId));
    } catch {}
  }

  get ready() {
    return this.#ready;
  }

  get account() {
    return this.#account;
  }

  get loginState() {
    return { ...this.#loginState };
  }

  get qr() {
    return this.#qr;
  }

  // ── 事件总线（给主进程订阅）──
  on(event, fn) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(fn);
    return () => this.#listeners.get(event)?.delete(fn);
  }

  #emit(event, payload) {
    for (const fn of this.#listeners.get(event) ?? []) {
      try {
        fn(payload);
      } catch (e) {
        console.error(`[im-sdk] listener error (${event}):`, e.message);
      }
    }
  }

  /**
   * 创建 client 并绑定事件。不做登录。
   */
  #ensureClient() {
    if (this.#client) return this.#client;

    const client = createClient({
      dataDir: this.#dataDir,
      autoLoad: false, // 先挂 account.added，再恢复账号，确保指纹在恢复前生效
    });

    client.on('account.added', ({ account }) => {
      // 单实例单账号：先保存引用，登录事件里也能读到 deviceId
      this.#identityAccount = account;
      try { this.#applyFingerprint(account); } catch {}
      this.#registerDevice(account);
    });

    // ── 登录事件 ──
    client.on('system.login.qrcode', async ({ account, qrcodeBase64 }) => {
      this.#qr = qrcodeBase64;
      this.#loginState = { ...this.#loginState, stage: 'qr_ready', error: null };
      // 设备注册已在 beginLogin 完成，先登记给 WS 代理层
      this.#registerDevice(account);
      this.#emit('qr', { base64: qrcodeBase64 });
      try {
        await account.continueLogin();
      } catch (e) {
        this.#emit('login-error', { error: e.message });
      }
    });

    client.on('system.login.qrcode.status', (payload) => {
      const status = payload?.status;
      if (status === 'scanned') {
        this.#loginState = { ...this.#loginState, stage: 'scanned' };
      } else if (status === 'confirmed') {
        this.#loginState = { ...this.#loginState, stage: 'confirmed' };
      } else if (status === 'expired') {
        this.#loginState = { ...this.#loginState, stage: 'expired' };
        this.#qr = null;
      }
      this.#emit('qr-status', {
        status,
        screenName: payload?.screenName,
        errorCode: payload?.errorCode,
        description: payload?.description,
      });
    });

    // 恢复会话时 SDK 会先发 session 状态，再 goOnline；这里先登记设备 ID
    client.on('system.login.session', (payload) => {
      this.#registerDevice();
      this.#emit('session', {
        status: payload?.status,
        reason: payload?.reason,
      });
    });

    client.on('system.login.verification', async ({ account, verification }) => {
      this.#verification = verification;
      this.#loginState = {
        ...this.#loginState,
        stage: 'verification',
        error: null,
      };
      this.#emit('verification', {
        operation: verification.operation,
        methods: verification.methods,
      });
      // 打开验证页（platform 要求，SDK 不绕过）
      try {
        await verification.open({ openBrowser: true });
      } catch (e) {
        this.#emit('login-error', { error: `验证页打开失败: ${e.message}` });
      }
    });

    client.on('system.login.sms', (payload) => {
      this.#registerDevice();
      this.#loginState = { ...this.#loginState, stage: 'sms_code' };
      this.#emit('login-sms', {
        mobile: payload?.mobile ?? '',
        maskedMobile: payload?.maskedMobile ?? '',
      });
    });

    client.on('system.login.voice', (payload) => {
      this.#registerDevice();
      this.#loginState = { ...this.#loginState, stage: 'voice_code' };
      this.#emit('login-voice', {
        mobile: payload?.mobile ?? '',
        maskedMobile: payload?.maskedMobile ?? '',
      });
    });

    client.on('system.login.sms-required', (payload) => {
      this.#loginState = { ...this.#loginState, stage: 'sms_required' };
      this.#emit('login-sms-required', {
        mobile: payload?.mobile ?? '',
        reason: payload?.reason ?? '',
      });
    });

    client.on('system.login.accounts', (payload) => {
      this.#loginState = { ...this.#loginState, stage: 'account_select' };
      this.#emit('login-accounts', {
        method: payload?.method ?? '',
        canRegisterNewUser: payload?.canRegisterNewUser !== false,
        accounts: (payload?.accounts ?? []).map((a) => ({
          secUid: a.secUid,
          uid: a.uid ?? null,
          nickname: a.nickname ?? null,
          avatar: a.avatar ?? null,
          douyinId: a.douyinId ?? null,
          isMainAccount: !!a.isMainAccount,
          isEnterprise: !!a.isEnterprise,
        })),
      });
    });

    client.on('system.login.error', (err) => {
      this.#loginState = { ...this.#loginState, stage: 'error', error: err?.message };
      this.#emit('login-error', { error: err?.message || String(err) });
    });

    client.on('system.online', async (payload) => {
      this.#loginState = { ...this.#loginState, stage: 'online', error: null };
      this.#qr = null;
      this.#account = this.#client.pickAccount();
      try { this.#applyFingerprint(this.#account); } catch {}
      this.#emit('online', {
        platformUid: payload.platformUid,
        screenName: payload.screenName,
      });
      // ★ 不在这里调接口，等 ready() 被显式调用
    });

    client.on('system.reconnecting', (p) => {
      this.#emit('reconnecting', { attempt: p.attempt, delayMs: p.delayMs });
    });

    client.on('system.offline', () => {
      this.#ready = false;
      this.#emit('offline', {});
    });

    client.on('system.handler.error', ({ event, error }) => {
      console.error(`[im-sdk] handler error (${String(event)}):`, error?.message);
    });

    // ── 消息事件 ──
    client.on('message', async (ev) => {
      try {
        // 群消息实时事件里 member 往往只有 uid，补一次资料再入库
        if (ev?.chatType === 'group' && ev.member && !ev.member.nickname) {
          try { await ev.member.getProfile(); } catch {}
        }
        this.#emit('message', normalizeMessage(ev));
      } catch (e) {
        console.error('[im-sdk] normalize message failed:', e.message);
      }
    });

    client.on('notice.message.recall', (ev) => {
      this.#emit('message-recall', ev);
    });

    this.#client = client;
    // 恢复已保存账号；account.added 已先挂好
    try { client.loadAccounts(); } catch (e) {
      console.error('[im-sdk] loadAccounts failed:', e.message);
    }
    return client;
  }

  /**
   * 给账号连接注入本实例的稳定浏览器侧指纹。
   *
   * ★ deviceId / installId 不在这里设置：它们由 SDK 的设备注册链生成、
   *   由 SDK 自己持久化到 account.json。我们覆盖会让本地 ID 和服务端
   *   注册/激活的 ID 不一致（旧实现的 bug，2026-11-04 修正）。
   */
  #applyFingerprint(account) {
    const fp = this.#fingerprint;
    if (!account || !fp) return;
    const conn = account.runtime?.connection;
    if (conn) {
      conn.guid = fp.guid;
      conn.screenWidth = fp.screenWidth;
      conn.screenHeight = fp.screenHeight;
      conn.screenFingerprint = fp.screenFingerprint;
    }
    const uid = account.uid;
    const logKey = String(uid || 'login');
    if (!this.#fingerprintLogged.has(logKey)) {
      this.#fingerprintLogged.add(logKey);
      console.log(
        `[fingerprint] ${logKey} guid=${fp.guid.slice(0, 8)} screen=${fp.screenWidth}x${fp.screenHeight}`,
      );
    }
    this.#registerDevice(account);
  }

  /**
   * 开始登录。默认扫码；也可传 { method: 'sms'|'password', mobile, password }。
   */
  async startLogin(options = {}) {
    const client = this.#ensureClient();
    this.#loginState = { stage: 'starting', error: null, startedAt: Date.now() };

    const method = options?.method || 'qr';
    if (method === 'sms' || method === 'password') {
      const mobile = String(options?.mobile ?? '').trim();
      if (!mobile) throw new Error('请输入手机号');
      if (method === 'password' && !String(options?.password ?? '').trim()) {
        throw new Error('请输入密码');
      }
      client.createAccount({
        login: {
          method,
          mobile,
          ...(method === 'password' ? { password: String(options.password) } : {}),
        },
      });
    }

    const stored = client.listStoredAccountIds?.() ?? [];
    console.log(`[im-sdk] startLogin: method=${method} 已存账号 ${JSON.stringify(stored)}`);

    // login() 会一直等到登录完成，所以不 await
    client.login().then(() => {
      console.log('[im-sdk] login() resolved');
      this.#loginState = { ...this.#loginState, stage: 'logged_in' };
    }).catch((e) => {
      console.error('[im-sdk] login() rejected:', e?.message || e);
      this.#loginState = { stage: 'error', error: e?.message || String(e), startedAt: this.#loginState.startedAt };
      this.#emit('login-error', { error: e?.message || String(e) });
    });

    return { ok: true };
  }

  #loginAccount() {
    return this.#client?.pickAccount?.() ?? this.#account ?? null;
  }

  async requestLoginSmsCode() {
    const acc = this.#loginAccount();
    if (!acc) return { ok: false, error: '登录会话不存在' };
    try {
      await acc.requestLoginSmsCode();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async requestLoginVoiceCode() {
    const acc = this.#loginAccount();
    if (!acc) return { ok: false, error: '登录会话不存在' };
    try {
      await acc.requestLoginVoiceCode();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async submitLoginSms(code) {
    const acc = this.#loginAccount();
    if (!acc) return { ok: false, error: '登录会话不存在' };
    const value = String(code ?? '').trim();
    if (!value) return { ok: false, error: '请输入验证码' };
    try {
      await acc.continueLoginWithSms(value);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async selectLoginAccount({ secUid, registerNewUser = false } = {}) {
    const acc = this.#loginAccount();
    if (!acc) return { ok: false, error: '登录会话不存在' };
    try {
      await acc.continueLoginWithSubAccount({ secUid, registerNewUser: !!registerNewUser });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * 等账号就绪（联系人加载完成）
   *
   * ★ 这是关键：SDK 上线后会自己并行加载好友/群，
   *   必须等它加载完再调接口，否则 status=8。
   */
  async waitReady({ timeoutMs = READY_TIMEOUT_MS } = {}) {
    if (this.#ready) return { ok: true };

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const acc = this.#client?.pickAccount?.();
      if (!acc) {
        if (Math.round((Date.now() - (this.#loginState.startedAt ?? Date.now())) / 5000) % 3 === 0) {
          console.log('[im-sdk] waitReady: 还没有 account 实例');
        }
      }
      if (acc && acc.online) {
        // 等到 fl 有内容，或等满 20 秒（没好友的账号也不会卡住）
        const flSize = acc.fl?.size ?? 0;
        const elapsed = Date.now() - (this.#loginState.startedAt ?? Date.now());
        if (flSize > 0 || elapsed > 25000) {
          this.#account = acc;
          this.#ready = true;
          return { ok: true, friends: acc.fl?.size ?? 0, groups: acc.gl?.size ?? 0 };
        }
      }
      await sleep(READY_POLL_MS);
    }
    return { ok: false, reason: 'timeout' };
  }

  /**
   * 只读请求重试：只对网络/5xx 这类瞬时错误重试，写操作绝不走这里。
   */
  async #retryRead(label, fn, { attempts = 2, baseMs = 300 } = {}) {
    let last;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (e) {
        last = e;
        const msg = e?.message || String(e);
        const transient = e?.name === 'ImProtoTransportError'
          ? e.stage === 'network' || (e.stage === 'http' && /HTTP 5\d\d/.test(msg))
          : /network|timeout|ECONN|ETIMEDOUT|socket hang up|fetch failed/i.test(msg);
        if (!transient || i === attempts - 1) throw e;
        console.warn(`[im-sdk] ${label} 失败，重试 ${i + 1}/${attempts - 1}: ${msg}`);
        await sleep(baseMs * 2 ** i + Math.random() * 150);
      }
    }
    throw last;
  }

  /**
   * 拉联系人（好友 + 群 + 陌生人）
   */
  async fetchContacts() {
    const acc = this.#account;
    if (!acc) throw new Error('账号未就绪');

    const out = { friends: [], groups: [], strangers: [] };

    try {
      const list = await this.#retryRead('好友列表', () => acc.getFriendList());
      out.friends = list.map(normalizeFriend);
    } catch (e) {
      console.error('[im-sdk] getFriendList failed:', e.message);
    }

    try {
      const list = await this.#retryRead('群列表', () => acc.getGroupList());
      out.groups = list.map(normalizeGroup);
    } catch (e) {
      console.error('[im-sdk] getGroupList failed:', e.message);
    }

    try {
      const list = await this.#retryRead('陌生人列表', () => acc.getStrangerList());
      out.strangers = list.map(normalizeStranger);
    } catch (e) {
      console.error('[im-sdk] getStrangerList failed:', e.message);
    }

    return out;
  }

  /**
   * 拉某个会话的历史消息
   * @param {string} uid 对方 uid（或用 contactKey）
   * @param {object} opts { count, cursor, direction }
   */
  async fetchHistory(uid, { count = 30, cursor, direction = 'older' } = {}) {
    const contact = this.#pickContact(uid);
    if (!contact) throw new Error(`找不到联系人: ${uid}`);

    const res = await this.#retryRead('会话历史', () =>
      contact.getHistory({ count, cursor, direction }));
    const selfUid = this.#account?.uid;
    const chatType = contact.groupId
      ? 'group'
      : (typeof contact.getInboxMessages === 'function' ? 'stranger' : 'private');
    // 先用已有成员缓存返回消息；群成员资料由页面打开后异步补全，避免首屏等待
    const memberMap = chatType === 'group' ? contact.memberList : null;
    const peerName = contact.remark || contact.nickname || null;
    return {
      statusCode: res.statusCode,
      messages: (res.messages ?? []).map((m) =>
        normalizeMessageRecord(m, selfUid, { chatType, memberMap, peerName }),
      ),
      hasMore: res.hasMore,
      cursor: res.cursor,
    };
  }

  /**
   * 发文字消息（只对已有联系人生效）
   * @returns { ok, serverMessageId, clientMessageId, statusCode, statusMsg }
   */
  async sendText(uid, text) {
    const contact = this.#contactCache.get(String(uid)) ?? this.#pickContact(uid);
    if (!contact) throw new Error(`找不到联系人: ${uid}`);

    const resp = await contact.sendMsg(text);
    const ok = resp.statusCode === 0 && !!resp.serverMessageId;
    return {
      ok,
      statusCode: resp.statusCode,
      statusMsg: resp.statusMsg,
      serverMessageId: resp.serverMessageId ?? null,
      clientMessageId: resp.clientMessageId ?? null,
      checkCode: resp.checkCode ?? null,
    };
  }

  /**
   * ★ 按 uid 发送（支持从未聊过的人）
   *
   * 实测发现（2026-10-28）：SDK 的 pickStranger 只能查「已有会话」的人，
   * 但可以通过 bindFriend + ensureFriendConversation 主动建会话，然后发送。
   *
   * 服务端返回的会话形如：
   *   { conversationId: "0:1:<peerUid>:<selfUid>",
   *     conversationShortId: "7701661575844856369",
   *     coreExt: { "a:stranger_upg": ... } }
   *
   * @param {string} uid 目标用户 uid
   * @param {string} text 文本
   * @param {object} opts { nickname } 可选，仅用于日志
   */
  async sendToUid(uid, text, { nickname } = {}) {
    const acc = this.#account;
    if (!acc) throw new Error('账号未就绪');

    const key = String(uid);

    // 1. 已有对象直接用（好友/群/陌生人）
    let contact = this.#contactCache.get(key) ?? this.#pickContact(key);

    // 2. 没有就主动建会话
    if (!contact) {
      if (typeof acc.bindFriend !== 'function' || typeof acc.ensureFriendConversation !== 'function') {
        throw new Error('SDK 不支持主动建会话');
      }
      contact = acc.bindFriend(key, null, null, nickname ? { nickname } : {});
      if (!contact) throw new Error(`bindFriend 失败: ${key}`);

      await acc.ensureFriendConversation(contact);
      this.#contactCache.set(key, contact);
      console.log(`[im-sdk] 已建会话 ${key} -> shortId=${contact.conversationShortId}`);
    }

    // 3. 发送
    const resp = await contact.sendMsg(text);
    const ok = resp.statusCode === 0 && !!resp.serverMessageId;
    return {
      ok,
      statusCode: resp.statusCode,
      statusMsg: resp.statusMsg,
      serverMessageId: resp.serverMessageId ?? null,
      clientMessageId: resp.clientMessageId ?? null,
      checkCode: resp.checkCode ?? null,
      conversationShortId: contact.conversationShortId ?? null,
      createdConversation: !this.#contactCache.has(key) ? false : true,
    };
  }

  /**
   * 发图片（给已有联系人）
   * 实测：segment.image(new Uint8Array(buf))，注意不是 { data: buf }
   */
  async sendImage(uid, imageBytes, { nickname } = {}) {
    const contact = await this.#ensureContact(uid, nickname);
    const bytes = Buffer.from(imageBytes);
    const hash = createHash('sha256').update(bytes).digest('hex');

    // 同一张图发多个人时复用已上传资产，避免重复走 VOD 上传
    const cached = this.#cachedImage(hash);
    if (cached) {
      try {
        const resp = await contact.sendMsg(segment.image(cached));
        if (resp.statusCode === 0 && resp.serverMessageId) {
          return this.#imageResult(resp);
        }
        // 资产可能过期/失效，丢掉缓存后重新上传
        this.#forgetImage(hash);
      } catch {
        this.#forgetImage(hash);
      }
    }

    // 主动上传一次并缓存资产；上传失败才退回 SDK 的字节上传路径
    let im = null;
    try { im = this.#account?.im ?? null; } catch {}
    if (im?.uploadImage) {
      let asset = null;
      try {
        asset = await im.uploadImage(new Uint8Array(bytes));
      } catch {
        asset = null;
      }
      if (asset?.oid) {
        this.#rememberImage(hash, asset);
        const resp = await contact.sendMsg(segment.image(asset));
        if (!(resp.statusCode === 0 && resp.serverMessageId)) this.#forgetImage(hash);
        return this.#imageResult(resp);
      }
    }

    const resp = await contact.sendMsg(segment.image(new Uint8Array(bytes)));
    return this.#imageResult(resp);
  }

  #imageResult(resp) {
    return {
      ok: resp.statusCode === 0 && !!resp.serverMessageId,
      statusCode: resp.statusCode,
      statusMsg: resp.statusMsg,
      serverMessageId: resp.serverMessageId ?? null,
      clientMessageId: resp.clientMessageId ?? null,
      checkCode: resp.checkCode ?? null,
    };
  }

  /**
   * 发文件（SDK 会先上传，再发 file 卡片）
   */
  async sendFile(uid, fileBytes, name, { nickname } = {}) {
    const fileName = String(name ?? '').trim();
    if (!fileName) throw new Error('文件名不能为空');
    const contact = await this.#ensureContact(uid, nickname);
    const msg = segment.file(new Uint8Array(fileBytes), fileName);
    const resp = await contact.sendMsg(msg);
    return {
      ok: resp.statusCode === 0 && !!resp.serverMessageId,
      statusCode: resp.statusCode,
      statusMsg: resp.statusMsg,
      serverMessageId: resp.serverMessageId ?? null,
      clientMessageId: resp.clientMessageId ?? null,
      checkCode: resp.checkCode ?? null,
    };
  }

  /**
   * 群聊 @：mentions 会拼接在正文前面（SDK 会生成 @昵称 并附带 mention 元数据）
   */
  async sendTextWithMentions(uid, text, mentions = [], { nickname } = {}) {
    const contact = await this.#ensureContact(uid, nickname);
    const segments = [];
    for (const m of mentions) {
      if (!m?.uid) continue;
      segments.push(segment.at({ uid: String(m.uid), displayName: m.name || m.displayName || '' }));
    }
    if (!segments.length) return this.sendToUid(uid, text, { nickname });
    segments.push(text);
    const resp = await contact.sendMsg(segments);
    return {
      ok: resp.statusCode === 0 && !!resp.serverMessageId,
      statusCode: resp.statusCode,
      statusMsg: resp.statusMsg,
      serverMessageId: resp.serverMessageId ?? null,
      clientMessageId: resp.clientMessageId ?? null,
      checkCode: resp.checkCode ?? null,
    };
  }

  /**
   * 回复/引用某条消息（需要被引用消息的 serverMessageId）
   */
  async sendReply(uid, {
    text,
    referencedMessageId,
    referencedMessageType = 7,
    referencedUid,
    referencedSecUid,
    referencedText,
    rootMessageId,
  }, { nickname } = {}) {
    if (!referencedMessageId) throw new Error('被引用的消息缺少 serverMessageId');
    if (!text?.trim()) throw new Error('回复内容不能为空');
    const contact = await this.#ensureContact(uid, nickname);
    const msg = segment.reply({
      text,
      referencedMessageId: String(referencedMessageId),
      referencedMessageType: Number(referencedMessageType) || 7,
      referencedUid: String(referencedUid ?? ''),
      ...(referencedSecUid ? { referencedSecUid: String(referencedSecUid) } : {}),
      ...(referencedText ? { referencedText: String(referencedText).slice(0, 120) } : {}),
      ...(rootMessageId ? { rootMessageId: String(rootMessageId) } : {}),
    });
    const resp = await contact.sendMsg(msg);
    return {
      ok: resp.statusCode === 0 && !!resp.serverMessageId,
      statusCode: resp.statusCode,
      statusMsg: resp.statusMsg,
      serverMessageId: resp.serverMessageId ?? null,
      clientMessageId: resp.clientMessageId ?? null,
      checkCode: resp.checkCode ?? null,
    };
  }

  /**
   * 转发消息到同一账号下的另一个会话。
   * 历史消息也能转发，只要本地存了 rawContent + messageType + serverMessageId。
   */
  async forwardMessage(uid, { serverMessageId, messageType, rawContent }, { nickname } = {}) {
    if (!serverMessageId) throw new Error('这条消息缺少 serverMessageId，无法转发');
    if (!rawContent) throw new Error('这条消息没有原始内容，无法转发');
    const contact = await this.#ensureContact(uid, nickname);
    const fakeEvent = {
      account: this.#account,
      serverMessageId: String(serverMessageId),
      messageType: Number(messageType) || 7,
      rawContent: typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent),
    };
    const resp = await contact.forwardMsg(fakeEvent);
    return {
      ok: resp.statusCode === 0 && !!resp.serverMessageId,
      statusCode: resp.statusCode,
      statusMsg: resp.statusMsg,
      serverMessageId: resp.serverMessageId ?? null,
      clientMessageId: resp.clientMessageId ?? null,
    };
  }

  async recallMessage(uid, serverMessageId) {
    if (!serverMessageId) return { ok: false, error: '这条消息缺少 serverMessageId，无法撤回' };
    const contact = this.#contactCache.get(String(uid)) ?? this.#pickContact(uid);
    if (!contact) return { ok: false, error: '找不到会话' };
    try {
      const r = await contact.recallMsg(String(serverMessageId));
      return { ok: r?.statusCode === 0, statusCode: r?.statusCode, statusMsg: r?.statusMsg };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async deleteMessage(uid, { serverMessageId, clientMessageId }) {
    if (!serverMessageId && !clientMessageId) {
      return { ok: false, error: '这条消息缺少消息 ID，无法删除' };
    }
    const contact = this.#contactCache.get(String(uid)) ?? this.#pickContact(uid);
    if (!contact) return { ok: false, error: '找不到会话' };
    try {
      const identifier = clientMessageId ? { clientMessageId: String(clientMessageId) } : String(serverMessageId);
      const r = await contact.deleteMsg(identifier);
      return { ok: r?.statusCode === 0, statusCode: r?.statusCode, statusMsg: r?.statusMsg };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async reactMessage(uid, serverMessageId, emoji, enabled = true) {
    if (!serverMessageId) return { ok: false, error: '这条消息缺少 serverMessageId，无法表态' };
    const contact = this.#contactCache.get(String(uid)) ?? this.#pickContact(uid);
    if (!contact) return { ok: false, error: '找不到会话' };
    try {
      const r = await contact.reactMsg(String(serverMessageId), String(emoji), !!enabled);
      return { ok: r?.statusCode === 0, statusCode: r?.statusCode, statusMsg: r?.statusMsg };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async setConversationPinned(uid, pinned) {
    const contact = this.#contactCache.get(String(uid)) ?? this.#pickContact(uid);
    if (!contact) return { ok: false, error: '找不到会话' };
    try {
      const r = await contact.setPinned(!!pinned);
      return { ok: r?.statusCode === 0, statusCode: r?.statusCode, statusMsg: r?.statusMsg };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async setConversationMuted(uid, muted) {
    const contact = this.#contactCache.get(String(uid)) ?? this.#pickContact(uid);
    if (!contact) return { ok: false, error: '找不到会话' };
    try {
      const r = await contact.setMute(!!muted);
      return { ok: r?.statusCode === 0, statusCode: r?.statusCode, statusMsg: r?.statusMsg };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async getGroupMembers(uid) {
    const contact = this.#pickContact(uid);
    if (!contact) return { ok: false, error: '找不到群会话' };
    if (typeof contact.getMemberList !== 'function') {
      return { ok: false, error: '这不是群会话' };
    }
    try {
      const map = await this.#retryRead('群成员', () => contact.getMemberList(true));
      const members = [...(map?.values?.() ?? [])].map((m) => ({
        uid: String(m.uid ?? ''),
        name: m.displayName ?? m.nickname ?? String(m.uid ?? ''),
        nickname: m.nickname ?? null,
        avatarUrl: m.avatar ?? null,
        role: m.roleName ?? 'member',
      })).filter((m) => m.uid);
      return { ok: true, members };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** 发作品卡（segment.share） */
  async sendWorkCard(uid, work, { nickname } = {}) {
    const itemId = String(work?.itemId ?? '').trim();
    if (!itemId) throw new Error('作品 ID 不能为空');
    const contact = await this.#ensureContact(uid, nickname);
    const resp = await contact.sendMsg(segment.share({
      itemId,
      title: work.title || '',
      authorUid: work.authorUid || '',
      authorSecUid: work.authorSecUid || '',
      ...(work.coverUrl ? { coverUrl: work.coverUrl } : {}),
    }));
    return {
      ok: resp.statusCode === 0 && !!resp.serverMessageId,
      statusCode: resp.statusCode,
      statusMsg: resp.statusMsg,
      serverMessageId: resp.serverMessageId ?? null,
      clientMessageId: resp.clientMessageId ?? null,
    };
  }

  /** 发用户名片（segment.user） */
  async sendUserCard(uid, user, { nickname } = {}) {
    const targetUid = String(user?.uid ?? '').trim();
    if (!targetUid) throw new Error('用户 UID 不能为空');
    const contact = await this.#ensureContact(uid, nickname);
    const resp = await contact.sendMsg(segment.user({
      uid: targetUid,
      secUid: user.secUid || '',
      name: user.name || '',
      ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
    }));
    return {
      ok: resp.statusCode === 0 && !!resp.serverMessageId,
      statusCode: resp.statusCode,
      statusMsg: resp.statusMsg,
      serverMessageId: resp.serverMessageId ?? null,
      clientMessageId: resp.clientMessageId ?? null,
    };
  }

  /**
   * 发跳转卡片（链接卡片，私信里可点击跳转）
   *
   * SDK 的卡片消息（messageType=26）字段：url / title / description / coverUrl。
   * coverUrl 必须是公网 http(s) 图片；本地图片需先上传拿到 URL。
   *
   * 没有会话时自动建会话（与 sendToUid 同一套逻辑），可以发给没聊过的人。
   */
  async sendLinkCard(uid, link, { nickname } = {}) {
    const url = String(link?.url ?? '').trim();
    if (!/^https?:\/\//i.test(url)) {
      throw new Error('跳转链接必须以 http:// 或 https:// 开头');
    }
    const coverUrl = String(link?.coverUrl ?? '').trim();
    if (coverUrl && !/^https?:\/\//i.test(coverUrl)) {
      throw new Error('封面图地址必须以 http:// 或 https:// 开头');
    }

    const contact = await this.#ensureContact(uid, nickname);
    const msg = segment.link({
      url,
      title: link.title || '',
      description: link.description || '',
      ...(coverUrl ? { coverUrl } : {}),
    });
    const resp = await contact.sendMsg(msg);
    return {
      ok: resp.statusCode === 0 && !!resp.serverMessageId,
      statusCode: resp.statusCode,
      statusMsg: resp.statusMsg,
      serverMessageId: resp.serverMessageId ?? null,
      clientMessageId: resp.clientMessageId ?? null,
      checkCode: resp.checkCode ?? null,
      conversationShortId: contact.conversationShortId ?? null,
    };
  }

  /**
   * 标记消息已读
   */
  async markRead(events) {
    const acc = this.#account;
    if (!acc) return { ok: false };
    try {
      await acc.markMessagesRead(events);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * 把某个会话标记到指定消息（服务端已读回执）
   * marker: { serverMessageId, indexInConversation?, indexInConversationV2? }
   */
  async markConversationRead(uid, marker) {
    const contact = this.#contactCache.get(String(uid)) ?? this.#pickContact(uid);
    if (!contact) return { ok: false, error: '找不到联系人' };
    if (!marker?.serverMessageId) return { ok: false, error: '缺少 serverMessageId' };
    try {
      const r = await contact.markRead(marker);
      return { ok: r?.statusCode === 0, statusCode: r?.statusCode, statusMsg: r?.statusMsg };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * 查询会话已读回执（受对方隐私设置限制，可能返回空）
   */
  async getReadReceipt(uid, refreshPrivacy = false) {
    const contact = this.#contactCache.get(String(uid)) ?? this.#pickContact(uid);
    if (!contact) return { ok: false, error: '找不到联系人' };
    try {
      const r = await this.#retryRead('已读回执', () => contact.getReadReceipt(refreshPrivacy));
      if (!r) return { ok: false, reason: 'no_read_summary' };
      return {
        ok: true,
        isAllRead: !!r.isAllRead,
        readUsers: (r.readUsers ?? []).map((u) => ({ uid: u.uid, secUid: u.secUid })),
        privacy: r.privacy ?? null,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * 当前联系人快照（同步，不联网）
   */
  snapshotContacts() {
    const acc = this.#account;
    if (!acc) return { friends: [], groups: [], strangers: [] };
    return {
      friends: [...(acc.fl?.values?.() ?? [])].map(normalizeFriend),
      groups: [...(acc.gl?.values?.() ?? [])].map(normalizeGroup),
      strangers: [...(acc.sl?.values?.() ?? [])].map(normalizeStranger),
    };
  }

  async logout() {
    try {
      await this.#client?.logout?.();
    } catch {}
    this.#ready = false;
    this.#account = null;
    this.#identityAccount = null;
    this.#client = null;
  }

  // ── 内部 ──

  /**
   * 找联系人；找不到就 bindFriend + ensureFriendConversation 建会话
   * 用于发卡片这类「给没聊过的人也能发」的场景
   */
  async #ensureContact(uid, nickname) {
    const key = String(uid);
    let contact = this.#contactCache.get(key) ?? this.#pickContact(key);
    if (contact) return contact;

    const acc = this.#account;
    if (!acc) throw new Error('账号未就绪');
    if (typeof acc.bindFriend !== 'function' || typeof acc.ensureFriendConversation !== 'function') {
      throw new Error('SDK 不支持主动建会话');
    }

    contact = acc.bindFriend(key, null, null, nickname ? { nickname } : {});
    if (!contact) throw new Error(`bindFriend 失败: ${key}`);
    await acc.ensureFriendConversation(contact);
    this.#contactCache.set(key, contact);
    console.log(`[im-sdk] 已建会话 ${key} -> shortId=${contact.conversationShortId}`);
    return contact;
  }

  #pickContact(uid) {
    const acc = this.#account;
    if (!acc) return null;
    return (
      acc.pickFriend?.(uid) ??
      acc.pickGroup?.(uid) ??
      acc.pickStranger?.(uid) ??
      null
    );
  }
}

// ── 数据归一化 ──
// SDK 的字段名和我们的不一致，这里有选择地映射

function normalizeFriend(f) {
  return {
    kind: 'friend',
    uid: String(f.uid ?? ''),
    secUid: f.secUid ?? null,
    nickname: f.nickname ?? null,
    remark: f.remark ?? null,
    avatarUrl: f.avatarUrl ?? f.avatar ?? null,
    signature: f.signature ?? null,
    // 显示名优先用备注
    displayName: f.remark || f.nickname || String(f.uid ?? ''),
  };
}

function normalizeGroup(g) {
  return {
    kind: 'group',
    uid: String(g.id ?? ''),
    nickname: g.name ?? null,
    displayName: g.name || String(g.id ?? ''),
    avatarUrl: g.avatarUrl ?? null,
    memberCount: g.memberCount ?? null,
  };
}

function normalizeStranger(s) {
  return {
    kind: 'stranger',
    uid: String(s.uid ?? ''),
    secUid: s.secUid ?? null,
    nickname: s.nickname ?? null,
    remark: s.remark ?? null,
    avatarUrl: s.avatarUrl ?? null,
    displayName: s.remark || s.nickname || String(s.uid ?? ''),
  };
}

/**
 * 归一化入站消息事件
 */
function normalizeMessage(ev) {
  const content = ev.content && typeof ev.content === 'object' ? ev.content : null;
  const kind = content?.kind || detectKind(ev.messageType, ev.rawContent);
  const rawContent = ev.rawContent ?? '';
  const meta = parseMessageMeta(rawContent, kind);
  const chatType = ev.chatType || 'private';
  const peerUid =
    chatType === 'group'
      ? String(ev.group?.id ?? '')
      : String(ev.friend?.uid ?? ev.stranger?.uid ?? ev.senderUid ?? '');
  const senderName =
    chatType === 'group'
      ? (ev.member?.displayName ?? ev.member?.nickname ?? null)
      : (ev.friend?.remark ?? ev.friend?.nickname ?? ev.stranger?.remark ?? ev.stranger?.nickname ?? null);

  return {
    peerUid,
    chatType,
    senderUid: String(ev.senderUid ?? ''),
    senderSecUid: ev.senderSecUid ?? null,
    senderName,
    senderAvatar: ev.member?.avatar ?? null,
    text: content?.text ?? ev.text ?? '',
    kind,
    rawContent,
    mediaUrl: meta.url ?? meta.coverUrl ?? null,
    meta,
    messageType: ev.messageType,
    serverMessageId: ev.serverMessageId ?? null,
    clientMessageId: ev.clientMessageId ?? null,
    conversationId: String(ev.threadId ?? ''),
    conversationShortId: ev.conversationShortId ?? null,
    indexInConversation: ev.indexInConversation ?? null,
    indexInConversationV2: ev.indexInConversationV2 ?? null,
    createTime: ev.createTime ?? null,
    // 保留原始事件引用，用于 markRead / reply 等操作
    _raw: ev,
  };
}

/**
 * 归一化历史消息记录（实测校准 2026-10-28）
 *
 * 实测的 content 结构（JSON 字符串）：
 *   {"ai_ext":"{}","scene":"","aweType":0,"related_share_video":{},
 *    "mention_users":[],"text":"[懵]","richTextInfos":[]}
 *
 * ★ 两个坑：
 *  1. 文本在 content.text 里，不是顶层
 *  2. **历史消息常常没有 serverMessageId**，只有 clientMessageId，
 *     所以幂等键必须优先用 clientMessageId
 */
function normalizeMessageRecord(m, selfUid, context = {}) {
  const messageType = m.msgType ?? m.messageType;
  const kind = detectKind(messageType, m.content);
  const meta = parseMessageMeta(m.content, kind);
  const senderUid = String(m.senderUid ?? '');
  const member = context.memberMap?.get?.(senderUid);
  const senderName =
    (context.chatType === 'group' ? member?.displayName ?? member?.nickname : context.peerName) ||
    null;
  return {
    serverMessageId: m.serverMessageId ?? m.serverId ?? null,
    clientMessageId: m.clientMessageId ?? null,
    senderUid,
    senderSecUid: m.senderSecUid ?? null,
    senderName,
    senderAvatar: member?.avatar ?? null,
    chatType: context.chatType ?? null,
    messageType,
    kind,
    text: extractText(m.content),
    rawContent: m.content ?? '',
    mediaUrl: meta.url ?? meta.coverUrl ?? null,
    meta,
    createTime: m.createTime ?? null,
    index: m.indexInConversation ?? null,
    indexV2: m.indexInConversationV2 ?? null,
    isMine: selfUid ? senderUid === String(selfUid) : false,
  };
}

/**
 * 是否是噪音消息（不该显示给用户的系统通知）
 *
 * 实测这些在历史里大量出现，但用户根本不关心：
 *   active_users / check_pics / check_read / 已读回执 / 撤回提示的元数据
 */
export function isNoiseMessage(kind, content, rawContent) {
  if (kind !== 'system') return false;
  const raw = String(rawContent ?? '');
  const noiseMarkers = [
    'active_users', 'check_pics', 'check_read', 'read_index',
    'passive_users', 'im_dynamic_patch',
  ];
  if (noiseMarkers.some((m) => raw.includes(m))) return true;
  // content 几乎是空对象
  try {
    const j = JSON.parse(raw);
    const keys = Object.keys(j).filter((k) => k !== 'ai_ext' && k !== 'richTextInfos');
    if (keys.length === 0) return true;
  } catch {}
  return false;
}

function extractText(content) {
  if (!content) return '';
  let j = content;
  if (typeof content === 'string') {
    try {
      j = JSON.parse(content);
    } catch {
      // 不是 JSON，直接当纯文本
      return content;
    }
  }
  if (j && typeof j === 'object') {
    // 实测结构：{ text: "..." }
    if (typeof j.text === 'string') return j.text;
    if (typeof j.content === 'string') return j.content;
    if (typeof j.desc === 'string') return j.desc;
    if (j.content && typeof j.content === 'object' && typeof j.content.text === 'string') {
      return j.content.text;
    }
    // 卡片类
    if (typeof j.description === 'string' && j.description) return j.description;
    if (typeof j.content_name === 'string' && j.content_name) return j.content_name;
    if (typeof j.activity_desc === 'string' && j.activity_desc) return j.activity_desc;
    if (j.anchor_info || j.awemeType) {
      return j.desc || j.title || '[分享作品]';
    }
    if (j.is_system_type || j.im_dynamic_patch) return '[系统消息]';
    if (j.activity_schema) return '[活动]';
    if (j.url || j.uri || j.cover_url) return '[图片]';
    // 实在认不出，返回可读摘要
    const keys = Object.keys(j).filter((k) => k !== 'ai_ext' && k !== 'richTextInfos');
    if (keys.length) return `[${keys.slice(0, 2).join('/')}]`;

    // 完全空的 content（多见于通知类）
    return '[系统消息]';
  }
  return String(content);
}

export { normalizeFriend, normalizeGroup, normalizeStranger, normalizeMessage, normalizeMessageRecord };
