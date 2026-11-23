/**
 * 多账号 SDK 管理器
 *
 * 每个账号一个 ImSdk 实例（独立 dataDir），互相隔离。
 * 相比浏览器方案（640MB/账号），SDK 实例内存约 10MB，可以开几十个。
 */
import path from 'node:path';
import fs from 'node:fs';
import { ImSdk } from './index.js';
import { runWithAccount, registerWsDevice } from '../net/proxy-dispatcher.js';

export class AccountManager {
  #baseDir;
  /** uid -> ImSdk */
  #instances = new Map();
  /** uid -> 可变 key（登录临时实例迁移后改成正式 uid） */
  #states = new Map();
  /** login 临时目录 -> 正式 uid 目录 */
  #adopted = new Map();
  /** uid -> 状态回调 */
  #hooks = {};

  constructor(baseDir) {
    this.#baseDir = baseDir;
    fs.mkdirSync(baseDir, { recursive: true });
  }

  /** 设置回调：onMessage / onOnline / onOffline / onQr / onLoginError */
  setHooks(hooks) {
    this.#hooks = { ...this.#hooks, ...hooks };
  }

  /**
   * 扫描磁盘上已有的账号（形如 acc_<id>/accounts/<uid>/）
   * 返回 [{ instanceKey, platformUid }]
   */
  listStoredAccounts() {
    const out = [];
    try {
      for (const d of fs.readdirSync(this.#baseDir, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const accountsDir = path.join(this.#baseDir, d.name, 'accounts');
        if (!fs.existsSync(accountsDir)) continue;
        for (const a of fs.readdirSync(accountsDir, { withFileTypes: true })) {
          if (!a.isDirectory() || a.name.startsWith('_')) continue;
          out.push({ instanceKey: d.name, platformUid: a.name });
        }
      }
    } catch {}
    return out;
  }

  /**
   * 获取或创建某账号的实例
   * accountId 用 uid 或临时 id（登录时用 'login'）
   *
   * ★ 注意：SDK 自己会在 dataDir 下拼 accounts/<uid>/，
   *   所以这里不能预先拼账号目录，否则会多一层。
   *   每个账号一个独立 dataDir 的目的是隔离，所以用 dataDir/acc_<id> 作为 SDK 的 dataDir。
   */
  instance(accountId) {
    let sdk = this.#instances.get(accountId);
    if (sdk) return sdk;

    // SDK 会在 <dataDir>/accounts/<platformUid>/ 存放会话
    // 每个业务账号一个隔离的 dataDir
    const dir = path.join(this.#baseDir, `acc_${accountId}`);
    const state = { key: accountId };
    sdk = this.#wrap(state, new ImSdk(dir, {
      // state.key 会随登录成功从 __login__ 切到正式 uid，所以传函数
      accountKey: () => state.key,
      // 设备 ID 确定后登记，patched SDK 的 WS 连接据此找到账号代理
      onDevice: (deviceId) => registerWsDevice(deviceId, () => state.key),
    }));

    // 统一把 SDK 事件转给外部
    // ★ 回调里也要带上账号上下文：主进程的自动回复等逻辑会在这里发起网络请求
    // ★ key 用可变对象：登录临时实例迁移成正式 uid 后，后续事件/代理上下文立即切到 uid
    const hook = (name) => (p) =>
      runWithAccount(state.key, () => this.#hooks[name]?.(state.key, p));

    sdk.on('qr', hook('onQr'));
    sdk.on('qr-status', hook('onQrStatus'));
    sdk.on('verification', hook('onVerification'));
    sdk.on('login-sms', hook('onLoginSms'));
    sdk.on('login-voice', hook('onLoginVoice'));
    sdk.on('login-sms-required', hook('onLoginSmsRequired'));
    sdk.on('login-accounts', hook('onLoginAccounts'));
    sdk.on('login-error', hook('onLoginError'));
    sdk.on('online', hook('onOnline'));
    sdk.on('offline', hook('onOffline'));
    sdk.on('reconnecting', hook('onReconnecting'));
    sdk.on('message', hook('onMessage'));
    sdk.on('message-recall', hook('onMessageRecall'));

    this.#instances.set(accountId, sdk);
    this.#states.set(accountId, state);
    return sdk;
  }

  /**
   * 登录成功后把临时实例迁到正式 uid：
   *   - 复制会话目录，保证下次启动能恢复
   *   - 在线实例直接改 key，避免重新登录/踢掉当前会话
   */
  adoptInstance(fromKey, toKey) {
    const from = String(fromKey);
    const to = String(toKey);
    if (!from || !to || from === to) return null;
    const sdk = this.#instances.get(from);
    if (!sdk) return null;
    const existing = this.#instances.get(to);
    if (existing && existing !== sdk) {
      throw new Error(`账号实例 ${to} 已存在，不能重复迁移`);
    }
    this.#copyAccountData(from, to);
    this.#instances.delete(from);
    this.#instances.set(to, sdk);
    const state = this.#states.get(from);
    if (state) {
      state.key = to;
      this.#states.delete(from);
      this.#states.set(to, state);
    }
    this.#adopted.set(from, to);
    return sdk;
  }

  /** 把旧版本遗留的 __login__ 会话迁到正式账号目录 */
  migrateLegacyLoginData() {
    const tempAccounts = path.join(this.#baseDir, 'acc___login__', 'accounts');
    if (!fs.existsSync(tempAccounts)) return 0;
    let moved = 0;
    try {
      for (const d of fs.readdirSync(tempAccounts, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name.startsWith('_')) continue;
        const uid = d.name;
        const src = path.join(tempAccounts, uid);
        if (!fs.existsSync(path.join(src, 'account.json'))) continue;
        const dest = path.join(this.#baseDir, `acc_${uid}`, 'accounts', uid);
        if (fs.existsSync(path.join(dest, 'account.json'))) continue;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.cpSync(src, dest, { recursive: true, force: true });
        moved++;
        console.log(`[sdk] 已迁移旧登录会话 ${uid} -> acc_${uid}`);
      }
    } catch (e) {
      console.warn('[sdk] 迁移旧登录会话失败:', e.message);
    }
    return moved;
  }

  /**
   * 只读诊断：找出多个账号共用 deviceId/installId 的情况。
   *
   * 不再自动改写设备身份——deviceId/installId 由 SDK 的设备注册链
   * 根据真实硬件生成并持久化，本地伪造会和服务端状态脱钩。
   * 同机多账号本来就共享硬件身份，隔离应该靠独立机器/出口 IP。
   */
  findDuplicateDeviceIds() {
    const entries = [];
    try {
      for (const d of fs.readdirSync(this.#baseDir, { withFileTypes: true })) {
        if (!d.isDirectory() || !d.name.startsWith('acc_') || d.name === 'acc___login__') continue;
        const accountsDir = path.join(this.#baseDir, d.name, 'accounts');
        if (!fs.existsSync(accountsDir)) continue;
        for (const a of fs.readdirSync(accountsDir, { withFileTypes: true })) {
          if (!a.isDirectory() || a.name.startsWith('_')) continue;
          const file = path.join(accountsDir, a.name, 'account.json');
          if (!fs.existsSync(file)) continue;
          try {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            const p = data?.deviceProfile;
            if (!p?.deviceId || p.deviceId === '0') continue;
            entries.push({
              uid: a.name,
              deviceId: String(p.deviceId),
              installId: String(p.installId || ''),
            });
          } catch {}
        }
      }
    } catch (e) {
      console.warn('[sdk] 扫描设备身份失败:', e.message);
      return [];
    }

    const groups = new Map();
    for (const e of entries) {
      const key = `${e.deviceId}:${e.installId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
    return [...groups.values()].filter((list) => list.length > 1);
  }

  #copyAccountData(from, to) {
    const src = path.join(this.#baseDir, `acc_${from}`, 'accounts');
    if (!fs.existsSync(src)) return;
    const dest = path.join(this.#baseDir, `acc_${to}`, 'accounts');
    fs.mkdirSync(dest, { recursive: true });
    for (const d of fs.readdirSync(src, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('_')) continue;
      fs.cpSync(path.join(src, d.name), path.join(dest, d.name), {
        recursive: true,
        force: true,
      });
    }
  }

  /** 把在线临时实例最新的 cookie/票据同步到正式目录 */
  syncAdoptedData() {
    for (const [from, to] of this.#adopted) {
      try { this.#copyAccountData(from, to); } catch (e) {
        console.warn(`[sdk] 同步 ${from} -> ${to} 失败:`, e.message);
      }
    }
  }

  get(accountId) {
    return this.#instances.get(accountId) ?? null;
  }

  /**
   * 把实例包一层：所有方法调用都带上「当前账号」上下文
   *
   * 为什么不在 ImSdk 里做：manager 的 key 就是账号身份（uid），
   * 和代理绑定用的是同一个 key，包在这里不会漏掉任何一个入口。
   * 事件回调由 ImSdk 的 #emit 触发，主进程在回调里发起的网络请求
   * 会继承当时的上下文（AsyncLocalStorage 会跟着异步链走）。
   */
  #wrap(state, sdk) {
    return new Proxy(sdk, {
      get(target, prop) {
        // ★ receiver 必须是 target：getter 里会访问私有字段，
        //   传 proxy 会报 "Cannot read private member"
        const v = Reflect.get(target, prop, target);
        if (typeof v !== 'function') return v;
        return (...args) => runWithAccount(state.key, () => v.apply(target, args));
      },
    });
  }

  /**
   * 启动某个已存账号（恢复 session，不弹二维码）
   */
  async startExisting(accountId) {
    const sdk = this.instance(accountId);
    await sdk.startLogin();
    return sdk;
  }

  /**
   * 删除账号的本地数据
   */
  async remove(accountId) {
    const sdk = this.#instances.get(accountId);
    if (sdk) {
      await sdk.logout();
      this.#instances.delete(accountId);
    }
    this.#states.delete(accountId);
    this.#adopted.delete(accountId);
    const dir = path.join(this.#baseDir, `acc_${accountId}`);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }

  /**
   * 关闭全部
   */
  async shutdown() {
    this.syncAdoptedData();
    for (const sdk of this.#instances.values()) {
      await sdk.logout().catch(() => {});
    }
    this.#instances.clear();
    this.#states.clear();
    this.#adopted.clear();
  }

  get size() {
    return this.#instances.size;
  }
}
