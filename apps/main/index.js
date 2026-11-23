import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, Notification, safeStorage, protocol, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AccountManager } from '../../packages/im-sdk/manager.js';
import { initDb, closeDb, getDataDir, db_ } from './src/db.js';
import {
  listAccounts, getAccount, updateAccount, deleteAccount,
  upsertAccountByUid, getAccountByUid,
} from './src/account-repo.js';
import {
  upsertContacts, listConversations, getConversation,
  upsertMessages, listMessages, touchConversation, clearUnread,
  insertPendingMessage, markMessageStatus, getMessageById, markMessageStatusById,
  markMessageRecalled, markMessageRecalledById, deleteMessageLocal,
  updateMessageSenderInfo,
  getLatestIncomingMessage, setConversationConvId,
  setConversationPinned, setConversationMuted,
} from './src/conversation-repo.js';
import {
  saveBuffer, resolveMediaPath, readMedia, mediaDir,
} from './src/media-store.js';
import { messagePreview } from '../../packages/im-sdk/message-meta.js';
import { checkAndRewrite } from './src/sensitive.js';
import { Sender } from '../../packages/sender/index.js';
import { registerBroadcastIpc } from './ipc/broadcast.js';
import { registerSensitiveIpc } from './ipc/sensitive.js';
import { registerAutoReplyIpc, setSdkKeyResolver } from './ipc/autoreply.js';
import { registerCardIpc } from './ipc/card.js';
import { getCard, sendCardMessage } from './src/card-service.js';
import { sendReplyItems } from './src/rich-reply.js';
import { registerInterceptIpc } from './ipc/intercept.js';
import { registerCompetitorIpc } from './ipc/competitor.js';
import { registerProxyIpc } from './ipc/proxy.js';
import { registerLicenseIpc } from './ipc/license.js';
import { registerUpdateIpc } from './ipc/update.js';
import { LicenseManager } from '../../packages/license/index.js';
import { UpdateService } from './src/update-service.js';
import { setLicenseManager, requireFeature, licenseStatus } from './src/license-gate.js';
import { startMonitorScheduler, stopMonitorScheduler } from './src/monitor-service.js';
import { installProxyDispatcher, closeAllProxyAgents } from '../../packages/net/proxy-dispatcher.js';
import { applyBindings, verifyAccountExitIp } from './src/proxy-service.js';
import { migrateLegacyData } from './src/user-data.js';
import { installFileLogger, getLogsDir, listLogFiles, closeFileLogger } from './src/logger.js';
import { createBackup, listBackups, stageRestore, applyPendingRestore, backupsDir } from './src/backup-service.js';
import { installProxyAuth } from './src/proxy-auth.js';
import { redact } from './src/redact.js';
import {
  decide as autoReplyDecide, draftCount, getConfig as getAutoReplyConfig,
  hasAnyRuleFor, isSessionPaused,
} from '../../packages/autorespond/engine.js';

// 开发/多环境调试：用 APP_USER_DATA 指定数据目录（必须在 app ready 之前）
if (process.env.APP_USER_DATA) {
  try {
    app.setPath('userData', process.env.APP_USER_DATA);
    console.log('[boot] userData ->', process.env.APP_USER_DATA);
  } catch (e) {
    console.error('[boot] 设置 userData 失败:', e.message);
  }
} else {
  // 正式包使用稳定数据根，避免产品改名后账号/任务“消失”
  try {
    const appData = app.getPath('appData');
    const stableRoot = path.join(appData, 'Shantuo');
    const current = app.getPath('userData');
    const knownNames = ['Electron', 'douyin-matrix', '闪拓', 'Shantuo'];
    if (app.isPackaged || knownNames.includes(path.basename(current))) {
      const mig = migrateLegacyData(appData, stableRoot);
      if (mig.migrated) {
        console.log(`[boot] 数据已从旧目录迁移：${mig.from} -> ${stableRoot}`);
      } else if (mig.reason && mig.reason !== 'no_legacy_data' && mig.reason !== 'already_exists') {
        console.warn('[boot] 数据迁移跳过:', mig.reason);
      }
      app.setPath('userData', stableRoot);
      console.log('[boot] stable userData ->', stableRoot);
    }
  } catch (e) {
    console.error('[boot] 稳定数据目录初始化失败:', e.message);
  }
}

// 聊天媒体协议必须在 app ready 之前注册
installProxyAuth();
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'zmtjl-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 开发环境 app.getVersion() 返回的是 Electron 版本，读 package.json 才是产品版本
const PKG_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
})();
const APP_VERSION = app.isPackaged ? app.getVersion() : PKG_VERSION;

// 主进程日志落盘（同时保留控制台输出）
installFileLogger();

let mainWindow = null;
let tray = null;
let manager = null;
let sender = null;
let license = null;
let updateService = null;

// 登录中的临时实例 id
const LOGIN_TMP_ID = '__login__';
// 当前登录状态（给 UI 推送）
let loginSession = null;

// ── 单实例锁 ──
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ───────────── 窗口 ─────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#f5f6f8',
    title: '闪拓 · 多账号增长助手',
    icon: path.join(__dirname, 'assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // preload 只使用 electron 的 contextBridge/ipcRenderer，可以开启 sandbox
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  if (process.env.VITE_DEV_SERVER) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 只允许应用自身页面；外部链接交给系统浏览器
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (isAppPageUrl(url)) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  mainWindow.webContents.on('will-attach-webview', (e) => e.preventDefault());
}

function isAppPageUrl(url) {
  if (!url) return false;
  const dev = process.env.VITE_DEV_SERVER;
  if (dev && url.startsWith(dev)) return true;
  if (url.startsWith('file://')) return url.includes('/dist/index.html');
  return false;
}

function isTrustedIpcSender(event) {
  const url = event?.senderFrame?.url || event?.sender?.getURL?.() || '';
  return isAppPageUrl(url);
}

function createTray() {
  const trayPath = path.join(__dirname, 'assets/tray.png');
  const fallbackPath = path.join(__dirname, 'assets/icon.png');
  let icon;
  try {
    icon = nativeImage.createFromPath(trayPath);
    if (icon.isEmpty() && fs.existsSync(fallbackPath)) {
      icon = nativeImage.createFromPath(fallbackPath).resize({ width: 16, height: 16 });
    }
    if (icon.isEmpty()) {
      console.warn('[tray] 托盘图标为空，请检查', trayPath);
      icon = nativeImage.createEmpty();
    } else {
      console.log('[tray] 图标已加载', trayPath, icon.getSize());
    }
  } catch (e) {
    console.warn('[tray] 托盘图标加载失败:', e.message);
    icon = nativeImage.createEmpty();
  }
  tray = new Tray(icon);
  tray.setToolTip('闪拓 · 多账号增长助手');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
      { label: '打开数据目录', click: () => shell.openPath(getDataDir()) },
      { type: 'separator' },
      { label: '退出', click: () => { app.isQuitting = true; app.quit(); } },
    ]),
  );
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

/**
 * 自动回复处理：决策 → 执行
 *
 * 决策由 packages/autorespond/engine.js 完成，
 * 这里只负责按结果执行（发送/存草稿/通知）。
 */
function writeChatSendLog({ accountId, peerUid, content, status, reason = null, verifyLevel = 'strong' }) {
  try {
    db_().prepare(
      `INSERT INTO send_log
         (id, account_id, scene, peer_uid, content, msg_type, status, reason, verify_level, created_at)
       VALUES (?, ?, 'dm', ?, ?, 'text', ?, ?, ?, ?)`,
    ).run(
      randomUUID(), accountId, peerUid,
      redact(String(content ?? '').slice(0, 500)),
      status, redact(reason), verifyLevel, Date.now(),
    );
  } catch {}
}

async function handleAutoReply({
  accountId,
  accountName,
  sdkKey,
  peerUid,
  peerName,
  text,
  chatType = 'private',
  serverMsgId = null,
  messageType = 7,
  senderUid = null,
  senderSecUid = null,
  senderText = null,
}) {
  if (!sender) return;

  // 授权失效/强制更新时不再生成自动回复决策或草稿
  const arGate = requireFeature('autoreply');
  if (arGate || updateService?.isForceBlocking()) {
    send('autoreply:event', {
      accountId,
      peerUid,
      peerName,
      text,
      action: 'blocked',
      reason: arGate?.message || '请先完成强制更新',
      pendingDrafts: draftCount(),
    });
    return;
  }

  const result = autoReplyDecide({
    accountId,
    accountName,
    peerUid,
    peerName,
    text,
    scene: 'dm',
    chatType,
  });

  // 通知 UI（草稿数变化、通知类事件）
  if (result.action === 'draft' || result.action === 'notify') {
    send('autoreply:event', {
      accountId,
      peerUid,
      peerName,
      text,
      ...result,
      pendingDrafts: draftCount(),
    });
  }

  if (result.action !== 'auto_sent') {
    console.log(`[autoreply] ${result.action}: ${result.reason}`);
    return;
  }

  // 延迟（模拟打字 + 随机抖动）
  const delay = Math.min(result.delayMs ?? 1500, 30000);
  await new Promise((r) => setTimeout(r, delay));

  // dry-run 模式下不真发
  if (sender.dryRun) {
    const label = result.replyType === 'card'
      ? `${result.replyText?.trim() ? `${result.replyText} ` : ''}[卡片] ${result.cardName || result.cardId}`
      : result.replyText;
    console.log(`[autoreply] (dry-run) 本应回复「${label}」给 ${peerName || peerUid}`);
    send('autoreply:event', {
      accountId, peerUid, peerName, text,
      action: 'auto_sent', reason: 'dry-run', replyText: result.replyText,
      replyType: result.replyType, cardId: result.cardId, cardName: result.cardName,
      pendingDrafts: draftCount(),
    });
    return;
  }

  // 多消息组合：逐条发送，任一条失败默认停止
  if (Array.isArray(result.items) && result.items.length > 1) {
    try {
      const sr = await sendReplyItems({
        sender,
        accountId,
        sdkKey,
        peerUid,
        items: result.items,
        scene: 'autoreply',
        skipCompliance: true, // decide() 已逐条检查/改写
        shouldStop: () => isSessionPaused(accountId, peerUid),
      });
      const action = sr.status === 'sent'
        ? 'auto_sent'
        : sr.status === 'partial' ? 'auto_partial' : 'send_failed';
      console.log(`[autoreply] 多消息发送 ${sr.status}（${sr.results.length} 条）`);
      send('autoreply:event', {
        accountId, peerUid, peerName, text,
        action,
        reason: sr.status === 'sent' ? '多消息已发送' : '部分/全部消息发送失败',
        replyText: result.replyText,
        replyType: result.replyType,
        cardId: result.cardId,
        cardName: result.cardName,
        items: result.items,
        itemResults: sr.results,
        pendingDrafts: draftCount(),
      });
    } catch (e) {
      console.error('[autoreply] 多消息发送异常', e.message);
      send('autoreply:event', {
        accountId, peerUid, peerName, text,
        action: 'send_failed', reason: e.message,
        pendingDrafts: draftCount(),
      });
    }
    return;
  }

  try {
    const cfg = getAutoReplyConfig();
    let r = null;
    const isCard = result.replyType === 'card' && !!result.cardId;

    if (isCard) {
      const card = getCard(result.cardId);
      if (!card) throw new Error('卡片不存在或已删除');

      r = await sender.sendRich({
        accountId,
        sdkKey,
        peerUid,
        text: result.replyText || '',
        scene: 'autoreply',
        skipThrottle: true,
        skipDailyLimit: true,
        skipCompliance: true, // decide() 已检查并改写
        msgType: 'card',
        contentLabel: `[卡片] ${result.cardName || card.name || ''}`,
        transport: async ({ sdk }) => {
          if (!sdk?.ready) return { ok: false, statusCode: -1, statusMsg: '账号未就绪' };
          return sendCardMessage(sdk, peerUid, result.cardId);
        },
      });

      // 卡片发出去后，再发附带文本
      if (r.status === 'sent' && result.replyText?.trim()) {
        const tr = await sender.sendOne({
          accountId,
          sdkKey,
          peerUid,
          text: result.replyText,
          scene: 'autoreply',
          skipThrottle: true,
          skipDailyLimit: true,
          skipCompliance: true,
        });
        if (tr.status !== 'sent') {
          r = {
            ...r,
            detail: `卡片已发送，附带文本失败：${tr.detail ?? tr.reason ?? '未知错误'}`,
          };
        }
      }
    } else {
      // 引用回复：需要入站消息的 serverMessageId
      if (cfg.quoteReply && serverMsgId) {
        const sdk = manager.get(String(sdkKey));
        if (sdk?.ready) {
          try {
            const resp = await sdk.sendReply(peerUid, {
              text: result.replyText,
              referencedMessageId: serverMsgId,
              referencedMessageType: messageType || 7,
              referencedUid: senderUid,
              referencedSecUid: senderSecUid,
              referencedText: senderText || text,
            }, { nickname: peerName });
            if (resp.ok) {
              r = {
                status: 'sent',
                serverMessageId: resp.serverMessageId,
                detail: resp.statusMsg,
              };
              // 引用回复走的是 sdk.sendReply，sender 不会自动落库
              try {
                const clientId = `auto_quote_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                if (insertPendingMessage(accountId, peerUid, {
                  text: result.replyText || '',
                  clientMessageId: clientId,
                  messageType: 7,
                })) {
                  markMessageStatus(accountId, peerUid, {
                    clientMessageId: clientId,
                    status: 'sent',
                    serverMessageId: resp.serverMessageId,
                  });
                }
              } catch (e) {
                console.warn('[autoreply] 引用回复写聊天记录失败:', e.message);
              }
            } else {
              console.warn(`[autoreply] 引用回复失败，回退普通文本: ${resp.statusMsg}`);
            }
          } catch (e) {
            console.warn(`[autoreply] 引用回复异常，回退普通文本: ${e.message}`);
          }
        }
      }

      if (!r) {
        r = await sender.sendOne({
          accountId,
          sdkKey,
          peerUid,
          text: result.replyText,
          scene: 'autoreply',
          skipThrottle: true, // 延迟已经等过了
          skipDailyLimit: true, // 对方刚发来消息，属于正常对话回复
          skipCompliance: true, // decide() 已检查并改写
        });
      }
    }

    const label = isCard
      ? `${result.replyText?.trim() ? `${result.replyText} ` : ''}[卡片] ${result.cardName || result.cardId}`
      : result.replyText;
    console.log(
      `[autoreply] 发送${r.status === 'sent' ? '成功' : '失败'}：${String(label ?? '').slice(0, 40)}`,
    );
    send('autoreply:event', {
      accountId, peerUid, peerName, text,
      action: r.status === 'sent' ? 'auto_sent' : 'send_failed',
      reason: r.detail ?? r.reason,
      replyText: result.replyText,
      replyType: result.replyType,
      cardId: result.cardId,
      cardName: result.cardName,
      pendingDrafts: draftCount(),
    });
  } catch (e) {
    console.error('[autoreply] 发送异常', e.message);
    send('autoreply:event', {
      accountId, peerUid, peerName, text,
      action: 'send_failed', reason: e.message,
      pendingDrafts: draftCount(),
    });
  }
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/**
 * 账号头像本地缓存：抖音头像 URL 带签名会过期，缓存到本地后 UI 优先用本地地址
 */
async function cacheAccountAvatar(account, remoteUrl) {
  if (!account?.id || !remoteUrl || /^zmtjl-media:/.test(remoteUrl)) return null;
  try {
    const res = await fetch(remoteUrl, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const type = String(res.headers.get('content-type') || '');
    if (!type.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > 2 * 1024 * 1024) return null;
    let ext = '.jpg';
    try {
      const p = new URL(remoteUrl).pathname.toLowerCase();
      if (p.endsWith('.png')) ext = '.png';
      else if (p.endsWith('.webp')) ext = '.webp';
      else if (p.endsWith('.gif')) ext = '.gif';
      else if (p.endsWith('.jpeg')) ext = '.jpeg';
    } catch {}
    const saved = saveBuffer(buf, { name: `avatar_${account.id}${ext}` });
    if (saved?.url) updateAccount(account.id, { avatar_local_url: saved.url });
    return saved?.url || null;
  } catch (e) {
    console.warn('[avatar] 缓存失败:', e.message);
    return null;
  }
}

function updateBlockedResponse() {
  if (!updateService?.isForceBlocking()) return null;
  return { ok: false, reason: 'update_required', error: '请先完成强制更新' };
}

/**
 * 更新包 Authenticode 校验。
 * 由 UPDATE_REQUIRE_SIGNATURE=1 启用；可再用 UPDATE_SIGNER_SUBJECT /
 * UPDATE_SIGNER_THUMBPRINT 固定发布者，避免服务端被入侵后替换安装包。
 */
function verifyDownloadedInstaller(file) {
  if (process.platform !== 'win32') return { ok: false, error: '当前平台不支持 Authenticode 校验' };
  const ps = [
    '$s = Get-AuthenticodeSignature -LiteralPath $env:ZMTJL_FILE',
    'if (-not $s.SignerCertificate) { Write-Output \'{"ok":false,"error":"安装包没有签名"}\'; exit 0 }',
    '[pscustomobject]@{ ok = $true; status = [string]$s.Status; subject = $s.SignerCertificate.Subject; thumbprint = $s.SignerCertificate.Thumbprint } | ConvertTo-Json -Compress',
  ].join('; ');
  let out;
  try {
    out = execFileSync('powershell', ['-NoProfile', '-Command', ps], {
      env: { ...process.env, ZMTJL_FILE: file },
      encoding: 'utf8',
      windowsHide: true,
    });
  } catch (e) {
    return { ok: false, error: `签名校验执行失败：${e.message}` };
  }
  let info;
  try { info = JSON.parse(String(out).replace(/^\uFEFF/, '').trim()); } catch {
    return { ok: false, error: '签名校验返回无法解析' };
  }
  if (!info.ok) return info;
  if (info.status === 'NotSigned' || info.status === 'HashMismatch') {
    return { ok: false, error: `安装包签名无效（${info.status}）` };
  }
  const expectedSubject = process.env.UPDATE_SIGNER_SUBJECT || '';
  const expectedThumb = (process.env.UPDATE_SIGNER_THUMBPRINT || '').replace(/\s+/g, '').toUpperCase();
  if (expectedSubject && !String(info.subject || '').includes(expectedSubject)) {
    return { ok: false, error: `安装包发布者不匹配：${info.subject}` };
  }
  if (expectedThumb && String(info.thumbprint || '').toUpperCase() !== expectedThumb) {
    return { ok: false, error: `安装包证书指纹不匹配：${info.thumbprint}` };
  }
  return { ok: true, ...info };
}

// ───────────── SDK 事件 → 数据库 / UI ─────────────

function setupManagerHooks() {
  manager.setHooks({
    // 二维码：SDK 直接给 base64 PNG，不需要截图
    onQr(accountId, { base64 }) {
      if (!loginSession || loginSession.accountId !== accountId) {
        loginSession = { accountId, stage: 'qr_ready', qr: null, error: null, startedAt: Date.now() };
      }
      loginSession.qr = base64;
      loginSession.stage = 'qr_ready';
      send('login:qr', { base64 });
      send('login:status', { status: 'qr_ready' });
    },

    onQrStatus(accountId, p) {
      if (loginSession) {
        if (p.status === 'scanned') loginSession.stage = 'scanned';
        else if (p.status === 'confirmed') loginSession.stage = 'confirmed';
        else if (p.status === 'expired') loginSession.stage = 'expired';
      }
      send('login:status', p);
    },

    onVerification(accountId, p) {
      if (loginSession) loginSession.stage = 'verification';
      send('login:verification', p);
      send('login:status', { status: 'verification', ...p });
    },

    onLoginSms(accountId, p) {
      if (loginSession) loginSession.stage = 'sms_code';
      send('login:sms', p);
      send('login:status', { status: 'sms_code', ...p });
    },

    onLoginVoice(accountId, p) {
      if (loginSession) loginSession.stage = 'voice_code';
      send('login:voice', p);
      send('login:status', { status: 'voice_code', ...p });
    },

    onLoginSmsRequired(accountId, p) {
      if (loginSession) loginSession.stage = 'sms_required';
      send('login:sms-required', p);
      send('login:status', { status: 'sms_required', ...p });
    },

    onLoginAccounts(accountId, p) {
      if (loginSession) loginSession.stage = 'account_select';
      send('login:accounts', p);
      send('login:status', { status: 'account_select', ...p });
    },

    onLoginError(accountId, p) {
      if (loginSession) {
        loginSession.stage = 'error';
        loginSession.error = p.error;
      }
      const sdk = manager.get(accountId);
      const uid = sdk?.account?.uid;
      if (uid) {
        const acc = getAccountByUid(String(uid));
        if (acc) {
          updateAccount(acc.id, { status: 'expired', conn_state: 'expired' });
          send('accounts:changed', {});
        }
      }
      send('login:error', p);
      send('login:status', { status: 'error', error: p.error });
    },

    // 上线：等 SDK 把联系人加载完，然后落库
    async onOnline(accountId, p) {
      console.log(`[online] ${p.screenName}(${p.platformUid})`);
      send('login:status', { status: 'online', ...p });

      const sdk = manager.get(accountId);
      if (!sdk) return;

      // ★ 关键：等联系人加载完再调接口（否则 status=8）
      const ready = await sdk.waitReady({ timeoutMs: 60000 });
      if (!ready.ok) {
        console.error('[online] waitReady 超时');
        send('login:error', { error: '联系人加载超时' });
        return;
      }

      // 拉一次自己的公开资料，落库头像/sec_uid/蓝V标识；失败不影响上线
      let profile = sdk.account?.profile ?? null;
      try {
        profile = (await sdk.account?.getProfile?.()) || profile;
      } catch (e) {
        console.warn('[online] 读取账号资料失败:', e.message);
      }

      const snap = sdk.snapshotContacts();
      const { account, created } = upsertAccountByUid({
        uid: p.platformUid,
        nickname: profile?.nickname || p.screenName || null,
        secUid: profile?.secUid || null,
        avatarUrl: profile?.avatarThumb || null,
        douyinId: profile?.uniqueId || null,
        // 蓝V/企业认证：enterprise_verify_reason 或 custom_verify 非空
        isVerified: !!(profile?.enterpriseVerify || profile?.customVerify || profile?.isEnterprise),
      });
      updateAccount(account.id, {
        status: 'warm',
        conn_state: 'online',
        last_online_at: Date.now(),
        last_sync_at: Date.now(),
      });

      // 后台缓存头像，不阻塞上线
      cacheAccountAvatar(account, profile?.avatarThumb || account.avatar_url).then((localUrl) => {
        if (localUrl) send('accounts:changed', {});
      }).catch(() => {});

      const r = upsertContacts(account.id, snap);
      console.log(`[online] 联系人入库 added=${r.added} updated=${r.updated}`);

      // 有代理时校验实际出口 IP；失败只标记，不阻塞登录
      verifyAccountExitIp(account.id)
        .then((ip) => {
          if (ip?.ok) {
            console.log(`[proxy] ${account.nickname || account.id} 出口 IP ${ip.ip} (${ip.status})`);
          }
        })
        .catch((e) => console.warn('[proxy] 出口 IP 检测失败:', e.message));

      // 登录成功：把临时实例的数据迁到正式账号目录，并把在线实例改挂到 uid
      if (loginSession && loginSession.accountId === accountId && accountId === LOGIN_TMP_ID) {
        try {
          manager.adoptInstance(LOGIN_TMP_ID, String(account.uid));
          console.log(`[login] ${account.uid} 会话已迁移到正式账号目录`);
        } catch (e) {
          console.error('[login] 会话迁移失败:', e.message);
        }
        loginSession.stage = 'done';
        send('login:done', {
          account: getAccount(account.id),
          created,
          contacts: r,
        });
      }

      send('accounts:changed', {});
    },

    onOffline(accountId) {
      const sdk = manager.get(accountId);
      const uid = sdk?.account?.uid;
      if (uid) {
        const acc = getAccountByUid(String(uid));
        if (acc) {
          // 断线 ≠ 登录失效：SDK 会自己重连，状态先标 offline
          updateAccount(acc.id, { conn_state: 'offline' });
          send('accounts:changed', {});
        }
      }
      send('account:offline', { accountId });
    },

    onReconnecting(accountId, p) {
      const sdk = manager.get(accountId);
      const uid = sdk?.account?.uid;
      if (uid) {
        const acc = getAccountByUid(String(uid));
        if (acc) {
          updateAccount(acc.id, { conn_state: 'reconnecting' });
          send('accounts:changed', {});
        }
      }
      send('account:reconnecting', { accountId, ...p });
    },

    // 收到新消息
    async onMessage(accountId, msg) {
      const sdk = manager.get(accountId);
      const uid = sdk?.account?.uid;
      if (!uid) return;

      const acc = getAccountByUid(String(uid));
      if (!acc) return;

      let conv = getConversation(acc.id, msg.peerUid);
      if (!conv) {
        upsertContacts(acc.id, {
          strangers: [{ uid: msg.peerUid, displayName: msg.senderName, kind: 'stranger' }],
        });
        conv = getConversation(acc.id, msg.peerUid);
      }
      if (msg.conversationShortId) {
        setConversationConvId(acc.id, msg.peerUid, msg.conversationShortId);
      }

      const inserted = upsertMessages(acc.id, msg.peerUid, [
        {
          serverMessageId: msg.serverMessageId,
          clientMessageId: msg.clientMessageId,
          senderUid: msg.senderUid,
          senderSecUid: msg.senderSecUid,
          senderName: msg.senderName,
          chatType: msg.chatType,
          messageType: msg.messageType,
          kind: msg.kind,
          text: msg.text,
          rawContent: msg.rawContent,
          mediaUrl: msg.mediaUrl,
          meta: msg.meta,
          index: msg.indexInConversation,
          indexV2: msg.indexInConversationV2,
          createTime: msg.createTime,
          isMine: String(msg.senderUid) === String(uid),
        },
      ]);

      const selfUid = String(uid);
      const isIncoming = String(msg.senderUid) !== selfUid;
      touchConversation(acc.id, msg.peerUid, {
        preview: messagePreview(msg.kind, msg.text, msg.meta),
        at: Date.now(),
        unreadDelta: isIncoming && inserted.inserted > 0 ? 1 : 0,
        type: msg.kind,
      });

      send('message:new', {
        accountId: acc.id,
        peerUid: msg.peerUid,
        message: {
          kind: msg.kind,
          text: msg.text,
          rawContent: msg.rawContent,
          mediaUrl: msg.mediaUrl,
          meta: msg.meta,
          chatType: msg.chatType,
          senderUid: msg.senderUid,
          senderName: msg.senderName,
          serverMessageId: msg.serverMessageId,
          createTime: msg.createTime,
        },
        inserted: inserted.inserted,
      });

      // ── 自动回复：文本消息始终处理；全部消息模式覆盖图片/表情/文件/群聊等 ──
      const arCfg = getAutoReplyConfig();
      const autoReplyText = msg.kind === 'text'
        ? msg.text
        : messagePreview(msg.kind, msg.text, msg.meta);
      const shouldAutoReply = isIncoming
        && inserted.inserted > 0
        && msg.kind !== 'system'
        && (msg.kind === 'text'
          || (arCfg.enabled && (arCfg.replyAll || hasAnyRuleFor(acc.id, msg.chatType))));
      if (shouldAutoReply) {
        handleAutoReply({
          accountId: acc.id,
          accountName: acc.nickname,
          sdkKey: selfUid,
          peerUid: msg.peerUid,
          peerName: msg.senderName,
          text: autoReplyText,
          chatType: msg.chatType,
          serverMsgId: msg.serverMessageId,
          messageType: msg.messageType,
          senderUid: msg.senderUid,
          senderSecUid: msg.senderSecUid,
          senderText: autoReplyText,
        }).catch((e) => console.error('[autoreply] 处理失败', e.message));
      }

      if (!mainWindow?.isFocused()) {
        try {
          new Notification({
            title: `${acc.nickname || '抖音'} · ${msg.senderName || msg.peerUid}`,
            body: messagePreview(msg.kind, msg.text, msg.meta).slice(0, 80),
          }).show();
        } catch {}
      }
    },

    // 撤回：保留本地原文，只打标记
    onMessageRecall(accountId, ev) {
      const changes = markMessageRecalled({
        serverMessageId: ev?.serverMessageId,
        clientMessageId: ev?.clientMessageId,
      });
      if (!changes) {
        console.log(
          `[recall] 未匹配到本地消息 account=${accountId} server=${ev?.serverMessageId || '-'} client=${ev?.clientMessageId || '-'} conv=${ev?.conversationId || '-'}`,
        );
        return;
      }
      const sdk = manager.get(accountId);
      const uid = sdk?.account?.uid;
      const acc = uid ? getAccountByUid(String(uid)) : null;
      if (!acc) return;
      send('message:recall', {
        accountId: acc.id,
        serverMessageId: ev?.serverMessageId ?? null,
        clientMessageId: ev?.clientMessageId ?? null,
        conversationId: ev?.conversationId ?? null,
      });
    },
  });
}

// ───────────── IPC ─────────────

function registerIpc() {
  // 统一校验 IPC 来源，避免渲染层被导航到外部页面后仍能调用本地能力
  const rawHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) =>
    rawHandle(channel, (event, ...args) => {
      if (process.env.SKIP_IPC_GUARD !== '1' && !isTrustedIpcSender(event)) {
        console.error('[ipc] 拒绝非应用页面调用', channel, event?.senderFrame?.url ?? '');
        throw new Error('IPC 来源不受信任');
      }
      return listener(event, ...args);
    });

  // 账号
  ipcMain.handle('account:list', () => listAccounts());
  ipcMain.handle('account:get', (_e, id) => getAccount(id));
  ipcMain.handle('account:update', (_e, id, patch) => updateAccount(id, patch));
  ipcMain.handle('account:delete', async (_e, id) => {
    const acc = getAccount(id);
    if (acc?.uid) await manager.remove(String(acc.uid));
    return deleteAccount(id);
  });

  // 手动重连：断线/重连失败时由用户触发，成功后会恢复在线状态
  ipcMain.handle('account:reconnect', async (_e, id) => {
    const acc = getAccount(id);
    if (!acc?.uid) return { ok: false, error: '账号不存在或未登录' };
    const sdk = manager.get(String(acc.uid)) ?? manager.instance(String(acc.uid));
    updateAccount(id, { conn_state: 'reconnecting' });
    send('accounts:changed', {});
    try {
      await sdk.startLogin();
      const ready = await sdk.waitReady({ timeoutMs: 45000 });
      if (!ready.ok) {
        updateAccount(id, { conn_state: 'offline' });
        send('accounts:changed', {});
        return { ok: false, error: '重连超时，请稍后重试或重新扫码' };
      }
      updateAccount(id, {
        status: 'warm',
        conn_state: 'online',
        last_online_at: Date.now(),
        last_sync_at: Date.now(),
      });
      send('accounts:changed', {});
      return { ok: true };
    } catch (e) {
      updateAccount(id, { conn_state: 'offline' });
      send('accounts:changed', {});
      return { ok: false, error: e.message };
    }
  });

  // ── 登录 ──
  ipcMain.handle('login:start', async (_e, options = {}) => {
    console.log('[login:start] 开始', options?.method || 'qr');
    try {
      if (manager.get(LOGIN_TMP_ID)) {
        await manager.remove(LOGIN_TMP_ID).catch(() => {});
      }
      loginSession = {
        accountId: LOGIN_TMP_ID,
        stage: 'starting',
        method: options?.method || 'qr',
        qr: null,
        error: null,
        startedAt: Date.now(),
      };
      const sdk = manager.instance(LOGIN_TMP_ID);
      console.log('[login:start] 实例已创建，调用 startLogin');
      await sdk.startLogin(options || {});
      console.log('[login:start] startLogin 已返回');
      return { ok: true };
    } catch (e) {
      console.error('[login:start] 失败:', e.stack || e.message);
      loginSession = { accountId: LOGIN_TMP_ID, stage: 'error', qr: null, error: e.message, startedAt: Date.now() };
      send('login:error', { error: e.message });
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('login:state', () => {
    if (!loginSession) return { stage: 'idle' };
    return {
      stage: loginSession.stage,
      error: loginSession.error,
      hasQr: !!loginSession.qr,
    };
  });

  ipcMain.handle('login:qr', () => ({ base64: loginSession?.qr ?? null }));

  ipcMain.handle('login:cancel', async () => {
    if (loginSession?.accountId) {
      await manager.remove(loginSession.accountId).catch(() => {});
    }
    loginSession = null;
    return { ok: true };
  });

  ipcMain.handle('login:requestSms', async (_e, kind = 'sms') => {
    const sdk = manager.get(LOGIN_TMP_ID);
    if (!sdk) return { ok: false, error: '登录会话不存在' };
    return kind === 'voice'
      ? sdk.requestLoginVoiceCode()
      : sdk.requestLoginSmsCode();
  });

  ipcMain.handle('login:submitSms', async (_e, code) => {
    const sdk = manager.get(LOGIN_TMP_ID);
    if (!sdk) return { ok: false, error: '登录会话不存在' };
    return sdk.submitLoginSms(code);
  });

  ipcMain.handle('login:selectAccount', async (_e, payload = {}) => {
    const sdk = manager.get(LOGIN_TMP_ID);
    if (!sdk) return { ok: false, error: '登录会话不存在' };
    return sdk.selectLoginAccount(payload);
  });

  // ── 会话 ──
  ipcMain.handle('conv:list', (_e, accountId, opts = {}) => listConversations(accountId, opts));
  ipcMain.handle('conv:get', (_e, accountId, peerUid) => getConversation(accountId, peerUid));

  ipcMain.handle('conv:sync', async (_e, accountId) => {
    const acc = getAccount(accountId);
    if (!acc?.uid) return { ok: false, reason: 'no_uid' };
    let sdk = manager.get(String(acc.uid));
    if (!sdk) sdk = manager.instance(String(acc.uid));

    if (!sdk.ready) {
      await sdk.startLogin().catch(() => {});
      const ready = await sdk.waitReady({ timeoutMs: 45000 });
      if (!ready.ok) return { ok: false, reason: 'not_ready' };
    }

    const contacts = await sdk.fetchContacts();
    const r = upsertContacts(accountId, contacts);
    updateAccount(accountId, { last_sync_at: Date.now() });
    return { ok: true, ...r };
  });

  ipcMain.handle('media:open', async (_e, fileName) => {
    const file = resolveMediaPath(fileName);
    if (!file) return { ok: false, error: '本地文件已丢失' };
    const err = await shell.openPath(file);
    return err ? { ok: false, error: err } : { ok: true };
  });

  // ── 消息 ──
  ipcMain.handle('msg:list', async (_e, accountId, peerUid, opts = {}) => {
    const cached = listMessages(accountId, peerUid, opts);
    if (cached.length > 0) return cached;

    const acc = getAccount(accountId);
    if (!acc?.uid) return cached;

    const sdk = manager.get(String(acc.uid));
    if (!sdk?.ready) return cached;

    try {
      const r = await sdk.fetchHistory(peerUid, { count: opts.limit ?? 30 });
      upsertMessages(accountId, peerUid, r.messages);
      return listMessages(accountId, peerUid, opts);
    } catch (e) {
      console.error('[msg:list] fetchHistory failed:', e.message);
      return cached;
    }
  });

  ipcMain.handle('msg:history', async (_e, accountId, peerUid, cursor) => {
    const acc = getAccount(accountId);
    if (!acc?.uid) return { ok: false, reason: 'no_uid' };
    const sdk = manager.get(String(acc.uid));
    if (!sdk?.ready) return { ok: false, reason: 'not_ready' };

    try {
      const r = await sdk.fetchHistory(peerUid, { count: 30, cursor });
      upsertMessages(accountId, peerUid, r.messages);
      return { ok: true, hasMore: r.hasMore, cursor: r.cursor, count: r.messages.length };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('msg:markRead', async (_e, accountId, peerUid) => {
    clearUnread(accountId, peerUid);

    const acc = getAccount(accountId);
    const sdk = acc?.uid ? manager.get(String(acc.uid)) : null;
    const last = getLatestIncomingMessage(accountId, peerUid);
    let platform = null;
    if (sdk?.ready && (last?.server_msg_id || last?.source_msg_id)) {
      platform = await sdk.markConversationRead(peerUid, {
        serverMessageId: last.server_msg_id || last.source_msg_id,
        indexInConversation: last.index_in_conversation ?? undefined,
        indexInConversationV2: last.index_in_conversation_v2 ?? undefined,
      });
    }

    let receipt = null;
    if (sdk?.ready) receipt = await sdk.getReadReceipt(peerUid);
    return { ok: true, platform, receipt };
  });

  ipcMain.handle('msg:readReceipt', async (_e, accountId, peerUid) => {
    const acc = getAccount(accountId);
    const sdk = acc?.uid ? manager.get(String(acc.uid)) : null;
    if (!sdk?.ready) return { ok: false, reason: 'not_ready' };
    return sdk.getReadReceipt(peerUid);
  });

  // ── 发送（走 sender，带节流/熔断/配额）──
  ipcMain.handle('msg:send', async (_e, accountId, peerUid, text, options = {}) => {
    const deny = requireFeature('send');
    if (deny) return { ...deny, reason: 'license' };
    const acc = getAccount(accountId);
    if (!acc?.uid) return { ok: false, reason: 'no_uid' };

    const check = checkAndRewrite(text, 'dm', { accountId });
    if (check.blocked) return { ok: false, reason: 'sensitive', hits: check.before?.hits ?? [] };
    // 服务端强制采用合规改写后的文本（不依赖前端自觉）
    const finalText = check.text || text;

    const sdk = manager.get(String(acc.uid));
    if (!sdk?.ready) return { ok: false, reason: 'not_ready' };

    const replyTo = options?.replyTo || null;
    if (replyTo && !replyTo.serverMsgId) {
      return { ok: false, reason: 'no_server_id', detail: '这条消息缺少 serverMessageId，无法回复' };
    }
    const conv = getConversation(accountId, peerUid);
    const mentions = conv?.kind === 'group' && Array.isArray(options?.mentions)
      ? options.mentions.filter((m) => m?.uid)
      : [];

    const clientId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    insertPendingMessage(accountId, peerUid, {
      text: finalText,
      clientMessageId: clientId,
      messageType: 7,
    });

    let r;
    if (replyTo) {
      const resp = await sdk.sendReply(peerUid, {
        text: finalText,
        referencedMessageId: replyTo.serverMsgId,
        referencedMessageType: replyTo.messageType || 7,
        referencedUid: replyTo.senderUid,
        referencedSecUid: replyTo.senderSecUid,
        referencedText: replyTo.text,
      });
      r = {
        status: resp.ok ? 'sent' : 'failed',
        serverMessageId: resp.serverMessageId,
        statusCode: resp.statusCode,
        detail: resp.statusMsg,
      };
    } else if (mentions.length) {
      const resp = await sdk.sendTextWithMentions(peerUid, finalText, mentions);
      r = {
        status: resp.ok ? 'sent' : 'failed',
        serverMessageId: resp.serverMessageId,
        statusCode: resp.statusCode,
        detail: resp.statusMsg,
      };
    } else {
      // 手动单条：跳过间隔等待和每人每日去重（用户正在对话）
      r = await sender.sendOne({
        accountId,
        sdkKey: String(acc.uid),
        peerUid,
        text: finalText,
        scene: 'dm',
        skipThrottle: true,
        skipDailyLimit: true,
        skipCompliance: true, // 上面已经检查并改写
      });
    }

    markMessageStatus(accountId, peerUid, {
      clientMessageId: clientId,
      status: r.status === 'sent' ? 'sent' : 'failed',
      serverMessageId: r.serverMessageId,
    });

    if (replyTo || mentions.length) {
      writeChatSendLog({
        accountId,
        peerUid,
        content: finalText,
        status: r.status === 'sent' ? 'sent' : 'failed',
        reason: r.detail ?? null,
        verifyLevel: r.status === 'sent' ? 'strong' : 'fail',
      });
    }

    if (r.status === 'skipped') {
      return {
        ok: false,
        reason: r.reason,
        detail: r.detail,
      };
    }

    return {
      ok: r.status === 'sent',
      serverMessageId: r.serverMessageId,
      statusCode: r.statusCode,
      detail: r.detail,
      // 让 UI 与输入框同步真实发出的文本（合规替换后可能不同）
      finalText: finalText !== text ? finalText : undefined,
    };
  });

  // 发图片：renderer 传 base64，主进程落盘后走 SDK
  ipcMain.handle('msg:sendImage', async (_e, accountId, peerUid, payload = {}) => {
    const deny = requireFeature('send');
    if (deny) return { ...deny, reason: 'license' };
    const blocked = updateBlockedResponse();
    if (blocked) return blocked;
    const acc = getAccount(accountId);
    if (!acc?.uid) return { ok: false, reason: 'no_uid' };
    const sdk = manager.get(String(acc.uid));
    if (!sdk?.ready) return { ok: false, reason: 'not_ready' };

    let base64 = String(payload.base64 ?? '');
    if (base64.startsWith('data:')) base64 = base64.slice(base64.indexOf(',') + 1);
    let bytes;
    try {
      bytes = Buffer.from(base64, 'base64');
    } catch {
      return { ok: false, error: '图片数据无效' };
    }
    if (!bytes?.length) return { ok: false, error: '图片为空' };
    if (bytes.length > 15 * 1024 * 1024) return { ok: false, error: '图片超过 15MB' };

    const saved = saveBuffer(bytes, {
      name: payload.name || 'image.png',
      mime: payload.mime || 'image/png',
    });
    const clientId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    insertPendingMessage(accountId, peerUid, {
      text: '[图片]',
      clientMessageId: clientId,
      msgType: 'image',
      mediaPath: saved.fileName,
      mediaUrl: saved.url,
      meta: { url: saved.url },
    });

    try {
      const r = await sdk.sendImage(peerUid, bytes, { nickname: payload.nickname });
      markMessageStatus(accountId, peerUid, {
        clientMessageId: clientId,
        status: r.ok ? 'sent' : 'failed',
        serverMessageId: r.serverMessageId,
      });
      return {
        ok: r.ok,
        clientMessageId: clientId,
        serverMessageId: r.serverMessageId ?? null,
        mediaUrl: saved.url,
        error: r.ok ? null : `code=${r.statusCode} ${r.statusMsg}`,
      };
    } catch (e) {
      markMessageStatus(accountId, peerUid, { clientMessageId: clientId, status: 'failed' });
      return { ok: false, clientMessageId: clientId, mediaUrl: saved.url, error: e.message };
    }
  });

  // 发文件：renderer 传 base64，主进程落盘后走 SDK
  ipcMain.handle('msg:sendFile', async (_e, accountId, peerUid, payload = {}) => {
    const deny = requireFeature('send');
    if (deny) return { ...deny, reason: 'license' };
    const blocked = updateBlockedResponse();
    if (blocked) return blocked;
    const acc = getAccount(accountId);
    if (!acc?.uid) return { ok: false, reason: 'no_uid' };
    const sdk = manager.get(String(acc.uid));
    if (!sdk?.ready) return { ok: false, reason: 'not_ready' };

    const name = String(payload.name ?? '').trim();
    if (!name) return { ok: false, error: '文件名不能为空' };
    let base64 = String(payload.base64 ?? '');
    if (base64.startsWith('data:')) base64 = base64.slice(base64.indexOf(',') + 1);
    let bytes;
    try {
      bytes = Buffer.from(base64, 'base64');
    } catch {
      return { ok: false, error: '文件数据无效' };
    }
    if (!bytes?.length) return { ok: false, error: '文件为空' };
    if (bytes.length > 25 * 1024 * 1024) return { ok: false, error: '文件超过 25MB' };

    const saved = saveBuffer(bytes, { name, mime: payload.mime });
    const clientId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    insertPendingMessage(accountId, peerUid, {
      text: `[文件] ${name}`,
      clientMessageId: clientId,
      msgType: 'file',
      mediaPath: saved.fileName,
      mediaUrl: saved.url,
      rawContent: JSON.stringify({ name, data_size: bytes.length, uri: saved.url }),
      meta: { name, fileSize: bytes.length },
    });

    try {
      const r = await sdk.sendFile(peerUid, bytes, name, { nickname: payload.nickname });
      markMessageStatus(accountId, peerUid, {
        clientMessageId: clientId,
        status: r.ok ? 'sent' : 'failed',
        serverMessageId: r.serverMessageId,
      });
      return {
        ok: r.ok,
        clientMessageId: clientId,
        serverMessageId: r.serverMessageId ?? null,
        mediaUrl: saved.url,
        error: r.ok ? null : `code=${r.statusCode} ${r.statusMsg}`,
      };
    } catch (e) {
      markMessageStatus(accountId, peerUid, { clientMessageId: clientId, status: 'failed' });
      return { ok: false, clientMessageId: clientId, mediaUrl: saved.url, error: e.message };
    }
  });

  // 重试一条失败消息（文本/图片/文件）
  ipcMain.handle('msg:retry', async (_e, accountId, messageId) => {
    const deny = requireFeature('send');
    if (deny) return { ...deny, reason: 'license' };
    const blocked = updateBlockedResponse();
    if (blocked) return blocked;
    const acc = getAccount(accountId);
    if (!acc?.uid) return { ok: false, error: '账号不存在' };
    const sdk = manager.get(String(acc.uid));
    if (!sdk?.ready) return { ok: false, error: '账号未就绪' };

    const msg = getMessageById(accountId, messageId);
    if (!msg) return { ok: false, error: '消息不存在' };
    if (msg.direction !== 'out' || msg.status !== 'failed') {
      return { ok: false, error: '只有发送失败的消息可以重试' };
    }

    markMessageStatusById(accountId, messageId, { status: 'pending', sentAt: Date.now() });
    try {
      if (msg.msg_type === 'text') {
        const r = await sender.sendOne({
          accountId,
          sdkKey: String(acc.uid),
          peerUid: msg.peer_uid,
          text: msg.content,
          scene: 'dm',
          skipThrottle: true,
          skipDailyLimit: true,
        });
        markMessageStatusById(accountId, messageId, {
          status: r.status === 'sent' ? 'sent' : 'failed',
          serverMessageId: r.serverMessageId,
        });
        return { ok: r.status === 'sent', detail: r.detail };
      }

      const bytes = msg.media_path ? readMedia(msg.media_path) : null;
      if (!bytes) {
        markMessageStatusById(accountId, messageId, { status: 'failed' });
        return { ok: false, error: '本地媒体文件已丢失，无法重试' };
      }
      const r = msg.msg_type === 'image'
        ? await sdk.sendImage(msg.peer_uid, bytes)
        : await sdk.sendFile(msg.peer_uid, bytes, msg.meta?.name || 'file');
      markMessageStatusById(accountId, messageId, {
        status: r.ok ? 'sent' : 'failed',
        serverMessageId: r.serverMessageId,
      });
      return { ok: r.ok, error: r.ok ? null : `code=${r.statusCode} ${r.statusMsg}` };
    } catch (e) {
      markMessageStatusById(accountId, messageId, { status: 'failed' });
      return { ok: false, error: e.message };
    }
  });

  // 转发到当前账号的另一个会话
  ipcMain.handle('msg:forward', async (_e, accountId, messageId, targetPeerUid) => {
    const deny = requireFeature('send');
    if (deny) return { ...deny, reason: 'license' };
    const acc = getAccount(accountId);
    if (!acc?.uid) return { ok: false, error: '账号不存在' };
    const sdk = manager.get(String(acc.uid));
    if (!sdk?.ready) return { ok: false, error: '账号未就绪' };
    const msg = getMessageById(accountId, messageId);
    if (!msg) return { ok: false, error: '消息不存在' };
    if (!msg.server_msg_id) return { ok: false, error: '这条消息缺少 serverMessageId，无法转发' };
    if (!msg.raw_content) return { ok: false, error: '这条消息没有原始内容，无法转发' };
    const target = getConversation(accountId, targetPeerUid);
    if (!target) return { ok: false, error: '目标会话不存在' };

    try {
      const r = await sdk.forwardMessage(targetPeerUid, {
        serverMessageId: msg.server_msg_id,
        messageType: msg.message_type || 7,
        rawContent: msg.raw_content,
      }, { nickname: target.peer_nickname });
      if (!r.ok) {
        writeChatSendLog({
          accountId,
          peerUid: targetPeerUid,
          content: `[转发] ${msg.content}`,
          status: 'failed',
          reason: r.statusMsg ?? 'forward failed',
          verifyLevel: 'fail',
        });
        return { ok: false, error: r.statusMsg || '转发失败' };
      }

      const clientId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      insertPendingMessage(accountId, targetPeerUid, {
        text: `[转发] ${msg.content || ''}`,
        clientMessageId: clientId,
        messageType: 7,
      });
      markMessageStatus(accountId, targetPeerUid, {
        clientMessageId: clientId,
        status: 'sent',
        serverMessageId: r.serverMessageId,
      });
      writeChatSendLog({
        accountId,
        peerUid: targetPeerUid,
        content: `[转发] ${msg.content}`,
        status: 'sent',
      });
      return { ok: true, targetPeerUid, serverMessageId: r.serverMessageId ?? null };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 撤回自己发的消息
  ipcMain.handle('msg:recall', async (_e, accountId, messageId) => {
    const deny = requireFeature('send');
    if (deny) return { ...deny, reason: 'license' };
    const acc = getAccount(accountId);
    if (!acc?.uid) return { ok: false, error: '账号不存在' };
    const sdk = manager.get(String(acc.uid));
    if (!sdk?.ready) return { ok: false, error: '账号未就绪' };
    const msg = getMessageById(accountId, messageId);
    if (!msg) return { ok: false, error: '消息不存在' };
    if (msg.direction !== 'out') return { ok: false, error: '只能撤回自己发的消息' };
    if (!msg.server_msg_id) return { ok: false, error: '这条消息缺少 serverMessageId，无法撤回' };

    const r = await sdk.recallMessage(msg.peer_uid, msg.server_msg_id);
    if (r.ok) markMessageRecalledById(accountId, messageId);
    return r.ok ? { ok: true } : { ok: false, error: r.error || r.statusMsg || '撤回失败' };
  });

  // 删除消息：优先平台删除，失败也删本地
  ipcMain.handle('msg:delete', async (_e, accountId, messageId) => {
    const acc = getAccount(accountId);
    if (!acc?.uid) return { ok: false, error: '账号不存在' };
    const sdk = manager.get(String(acc.uid));
    const msg = getMessageById(accountId, messageId);
    if (!msg) return { ok: false, error: '消息不存在' };

    let platform = null;
    if (sdk?.ready) {
      platform = await sdk.deleteMessage(msg.peer_uid, {
        serverMessageId: msg.server_msg_id,
        clientMessageId: msg.client_msg_id,
      });
    }
    deleteMessageLocal(accountId, messageId);
    return {
      ok: true,
      platform: platform?.ok ?? false,
      warning: platform && !platform.ok ? (platform.error || platform.statusMsg || '平台删除失败，已删除本地') : null,
    };
  });

  // 消息表态
  ipcMain.handle('msg:react', async (_e, accountId, messageId, emoji, enabled = true) => {
    const deny = requireFeature('send');
    if (deny) return { ...deny, reason: 'license' };
    const acc = getAccount(accountId);
    if (!acc?.uid) return { ok: false, error: '账号不存在' };
    const sdk = manager.get(String(acc.uid));
    if (!sdk?.ready) return { ok: false, error: '账号未就绪' };
    const msg = getMessageById(accountId, messageId);
    if (!msg) return { ok: false, error: '消息不存在' };
    if (!msg.server_msg_id) return { ok: false, error: '这条消息缺少 serverMessageId，无法表态' };
    return sdk.reactMessage(msg.peer_uid, msg.server_msg_id, emoji, enabled);
  });

  // 会话置顶 / 免打扰
  ipcMain.handle('conv:pin', async (_e, accountId, peerUid, pinned) => {
    const acc = getAccount(accountId);
    if (!acc?.uid) return { ok: false, error: '账号不存在' };
    const sdk = manager.get(String(acc.uid));
    if (!sdk?.ready) return { ok: false, error: '账号未就绪' };
    const r = await sdk.setConversationPinned(peerUid, pinned);
    if (!r.ok) return { ok: false, error: r.error || r.statusMsg || '置顶失败' };
    setConversationPinned(accountId, peerUid, pinned);
    return { ok: true };
  });

  ipcMain.handle('conv:mute', async (_e, accountId, peerUid, muted) => {
    const acc = getAccount(accountId);
    if (!acc?.uid) return { ok: false, error: '账号不存在' };
    const sdk = manager.get(String(acc.uid));
    if (!sdk?.ready) return { ok: false, error: '账号未就绪' };
    const r = await sdk.setConversationMuted(peerUid, muted);
    if (!r.ok) return { ok: false, error: r.error || r.statusMsg || '免打扰设置失败' };
    setConversationMuted(accountId, peerUid, muted);
    return { ok: true };
  });

  // 群成员（@ 用）
  ipcMain.handle('contact:members', async (_e, accountId, groupPeerUid) => {
    const acc = getAccount(accountId);
    if (!acc?.uid) return { ok: false, error: '账号不存在' };
    const sdk = manager.get(String(acc.uid));
    if (!sdk?.ready) return { ok: false, error: '账号未就绪' };
    return sdk.getGroupMembers(groupPeerUid);
  });

  // ── 发送日志 ──
  ipcMain.handle('log:list', (_e, filters = {}) => {
    const { accountId, scene, status, from, to, limit = 100, offset = 0 } = filters;
    const where = [];
    const args = [];
    if (accountId) { where.push('account_id = ?'); args.push(accountId); }
    if (scene) { where.push('scene = ?'); args.push(scene); }
    if (status) { where.push('status = ?'); args.push(status); }
    if (from) { where.push('created_at >= ?'); args.push(from); }
    if (to) { where.push('created_at <= ?'); args.push(to); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = db_()
      .prepare(`SELECT * FROM send_log ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset);
    const total = db_().prepare(`SELECT COUNT(*) c FROM send_log ${w}`).get(...args).c;
    return { rows, total };
  });

  ipcMain.handle('log:stats', (_e, { days = 7 } = {}) => {
    const since = Date.now() - days * 86400000;
    const byStatus = db_()
      .prepare(
        `SELECT status, COUNT(*) c FROM send_log WHERE created_at >= ? GROUP BY status`,
      )
      .all(since);
    const byScene = db_()
      .prepare(
        `SELECT scene, COUNT(*) c FROM send_log WHERE created_at >= ? GROUP BY scene`,
      )
      .all(since);
    const byAccount = db_()
      .prepare(
        `SELECT l.account_id, a.nickname, l.status, COUNT(*) c
         FROM send_log l LEFT JOIN account a ON a.id = l.account_id
         WHERE l.created_at >= ? GROUP BY l.account_id, l.status`,
      )
      .all(since);
    return { byStatus, byScene, byAccount, days };
  });

  ipcMain.handle('log:accountReport', (_e, { days = 7, from, to } = {}) => {
    let fromMs = Number(from) > 0 ? Number(from) : 0;
    if (!fromMs && Number(days) > 0) fromMs = Date.now() - Number(days) * 86400000;
    const toMs = Number(to) > 0 ? Number(to) : 0;
    const cond = [];
    const args = [];
    if (fromMs) { cond.push('l.created_at >= ?'); args.push(fromMs); }
    if (toMs) { cond.push('l.created_at <= ?'); args.push(toMs); }
    const joinCond = cond.length ? `AND ${cond.join(' AND ')}` : '';
    const rows = db_()
      .prepare(
        `SELECT a.id AS account_id, a.nickname, a.uid, a.douyin_id, a.enabled,
           COUNT(l.id) AS total,
           SUM(CASE WHEN l.status = 'sent' THEN 1 ELSE 0 END) AS sent,
           SUM(CASE WHEN l.status = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN l.status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
           SUM(CASE WHEN l.status = 'unknown' THEN 1 ELSE 0 END) AS unknown,
           MAX(l.created_at) AS last_at
         FROM account a
         LEFT JOIN send_log l ON l.account_id = a.id ${joinCond}
         GROUP BY a.id
         ORDER BY total DESC, a.nickname ASC`,
      )
      .all(...args);
    const total = rows.reduce(
      (acc, r) => {
        acc.total += Number(r.total) || 0;
        acc.sent += Number(r.sent) || 0;
        acc.failed += Number(r.failed) || 0;
        acc.skipped += Number(r.skipped) || 0;
        acc.unknown += Number(r.unknown) || 0;
        return acc;
      },
      { total: 0, sent: 0, failed: 0, skipped: 0, unknown: 0 },
    );
    return {
      rows: rows.map((r) => ({
        accountId: r.account_id,
        nickname: r.nickname,
        uid: r.uid,
        douyinId: r.douyin_id,
        enabled: r.enabled !== 0,
        total: Number(r.total) || 0,
        sent: Number(r.sent) || 0,
        failed: Number(r.failed) || 0,
        skipped: Number(r.skipped) || 0,
        unknown: Number(r.unknown) || 0,
        lastAt: r.last_at ?? null,
      })),
      total,
      days: Number(days) || 0,
      from: fromMs || null,
      to: toMs || null,
    };
  });

  ipcMain.handle('log:export', (_e, filters = {}) => {
    const deny = requireFeature('export');
    if (deny) return deny;
    const { accountId, scene, status } = filters;
    const where = [];
    const args = [];
    if (accountId) { where.push('account_id = ?'); args.push(accountId); }
    if (scene) { where.push('scene = ?'); args.push(scene); }
    if (status) { where.push('status = ?'); args.push(status); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db_()
      .prepare(`SELECT created_at, account_id, scene, peer_uid, content, status, reason FROM send_log ${w} ORDER BY created_at DESC LIMIT 5000`)
      .all(...args);

    const header = '时间,账号ID,场景,对方UID,内容,状态,原因';
    const csv = [header]
      .concat(
        rows.map((r) =>
          [
            new Date(r.created_at).toLocaleString('zh-CN'),
            r.account_id,
            r.scene,
            r.peer_uid,
            `"${String(r.content ?? '').replace(/"/g, '""')}"`,
            r.status,
            `"${String(r.reason ?? '').replace(/"/g, '""')}"`,
          ].join(','),
        ),
      )
      .join(String.fromCharCode(10));
    return { csv: '﻿' + csv, count: rows.length };
  });

  // ── 发送任务（群发）──
  registerBroadcastIpc({ ipcMain, sender, manager, getAccount });
  registerSensitiveIpc({ ipcMain });
  registerAutoReplyIpc({ ipcMain, sender });
  registerCardIpc({
    ipcMain,
    manager,
    sender,
    isBlocked: () => updateService?.isForceBlocking(),
  });
  registerInterceptIpc({
    ipcMain,
    sender,
    // 采集需要已上线的 SDK 实例（内部带 cookie 的请求通道）
    getSdk: (accountId) => {
      const acc = getAccount(accountId);
      return acc?.uid ? manager.get(String(acc.uid)) : null;
    },
    isBlocked: () => updateService?.isForceBlocking(),
  });
  registerCompetitorIpc({
    ipcMain,
    getSdk: (accountId) => {
      const acc = getAccount(accountId);
      return acc?.uid ? manager.get(String(acc.uid)) : null;
    },
    isBlocked: () => updateService?.isForceBlocking(),
    onMonitorEvent: (ev) => send('monitor:event', ev),
  });
  registerProxyIpc({ ipcMain });
  registerLicenseIpc({ ipcMain });
  registerUpdateIpc({
    ipcMain,
    update: updateService,
    shell,
    quit: () => { app.isQuitting = true; app.quit(); },
  });
  setSdkKeyResolver(async (accountId) => {
    const acc = getAccount(accountId);
    return acc?.uid ? String(acc.uid) : null;
  });

  // ── 模拟收到消息（调试用，走完整自动回复链路）──
  ipcMain.handle('autoreply:simulate', async (_e, { accountId, peerUid, peerName, text }) => {
    const acc = getAccount(accountId);
    if (!acc?.uid) return { ok: false, error: '账号不存在' };

    // 复用真实的自动回复处理函数
    await handleAutoReply({
      accountId: acc.id,
      accountName: acc.nickname,
      sdkKey: String(acc.uid),
      peerUid: peerUid || 'sim_' + Date.now(),
      peerName: peerName || '模拟用户',
      text,
    });

    return { ok: true, drafts: draftCount() };
  });

  // ── 演练模式开关 ──
  ipcMain.handle('sender:setDryRun', (_e, v) => {
    sender.setDryRun(v);
    return { ok: true, dryRun: sender.dryRun };
  });
  ipcMain.handle('sender:getDryRun', () => ({ dryRun: sender.dryRun }));

  // 重置节流计数（测试/手动重置用）
  ipcMain.handle('sender:resetCounters', () => {
    sender.resetCounters();
    return { ok: true };
  });

  // ── 熔断与配额状态 ──
  ipcMain.handle('risk:status', (_e, accountId) => ({
    tripped: sender.breaker.listTripped(),
    quota: accountId ? sender.throttle.usage(accountId) : null,
    throttle: sender.throttle.getConfig(),
  }));
  ipcMain.handle('risk:reset', (_e, accountId) => {
    sender.breaker.reset(accountId);
    return { ok: true };
  });

  // ── 应用 ──
  ipcMain.handle('app:info', () => ({
    version: APP_VERSION,
    electron: process.versions.electron,
    node: process.versions.node,
    dataDir: getDataDir(),
    sdkInstances: manager.size,
    license: licenseStatus(),
  }));
  ipcMain.handle('app:openDataDir', () => shell.openPath(getDataDir()));

  ipcMain.handle('app:openLogs', () => {
    const dir = getLogsDir();
    fs.mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  });

  ipcMain.handle('app:backupData', () => {
    try {
      db_().prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      const r = createBackup(app.getPath('userData'), { appVersion: APP_VERSION });
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('app:listBackups', () => listBackups(app.getPath('userData')));

  ipcMain.handle('app:openBackups', () => {
    const dir = backupsDir(app.getPath('userData'));
    fs.mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  });

  ipcMain.handle('app:restoreData', (_e, backupPath) => {
    try {
      db_().prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      stageRestore(app.getPath('userData'), backupPath);
      setTimeout(() => {
        app.relaunch();
        app.isQuitting = true;
        app.quit();
      }, 300);
      return { ok: true, restarting: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('app:exportDiagnostics', async () => {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: '选择诊断包保存位置',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (picked.canceled || !picked.filePaths?.[0]) return { ok: false, canceled: true };

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(picked.filePaths[0], `zmtjl-diagnostics-${stamp}`);
    fs.mkdirSync(dest, { recursive: true });

    for (const file of listLogFiles()) {
      try { fs.copyFileSync(file, path.join(dest, path.basename(file))); } catch {}
    }

    const counts = {};
    try {
      for (const table of ['account', 'conversation', 'message', 'outreach_task', 'outreach_item', 'monitor']) {
        try { counts[table] = db_().prepare(`SELECT COUNT(*) c FROM ${table}`).get().c; } catch {}
      }
    } catch {}

    fs.writeFileSync(path.join(dest, 'summary.json'), JSON.stringify({
      exportedAt: new Date().toISOString(),
      version: APP_VERSION,
      electron: process.versions.electron,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      dataDir: getDataDir(),
      license: licenseStatus(),
      update: updateService?.status?.() ?? null,
      counts,
    }, null, 2));

    shell.showItemInFolder(dest);
    return { ok: true, path: dest };
  });
}

// ───────────── 启动 ─────────────

app.whenReady().then(async () => {
  // 恢复备份必须在打开数据库之前完成
  try {
    const rr = applyPendingRestore(app.getPath('userData'));
    if (rr.restored) console.log(`[backup] 已恢复本地数据：${rr.from}（旧数据在 ${rr.previous}）`);
    else if (rr.error) console.error('[backup] 恢复失败:', rr.error);
  } catch (e) {
    console.error('[backup] 恢复异常:', e.message);
  }

  initDb();

  // 本地聊天媒体：zmtjl-media://local/<file>
  protocol.handle('zmtjl-media', async (request) => {
    try {
      const u = new URL(request.url);
      const name = path.basename(decodeURIComponent(u.pathname));
      const file = resolveMediaPath(name);
      if (!file) return new Response('Not found', { status: 404 });
      const ext = path.extname(file).toLowerCase();
      const mime = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.bmp': 'image/bmp',
        '.mp4': 'video/mp4',
        '.pdf': 'application/pdf',
      }[ext] || 'application/octet-stream';
      return new Response(fs.readFileSync(file), { headers: { 'Content-Type': mime } });
    } catch {
      return new Response('Bad request', { status: 400 });
    }
  });
  fs.mkdirSync(mediaDir(), { recursive: true });

  // 授权：读取本地 token、验签、启动心跳
  license = new LicenseManager({
    db: db_(),
    safeStorage,
    isPackaged: app.isPackaged,
    appVersion: APP_VERSION,
    serverUrl: process.env.LICENSE_SERVER,
  });
  try {
    const st = await license.init();
    console.log(`[license] 状态=${st.state} 套餐=${st.plan ?? '-'} 强制校验=${st.enforce}`);
  } catch (e) {
    console.error('[license] 初始化失败:', e.message);
  }
  setLicenseManager(license);
  license.startHeartbeat();

  // 客户端更新：授权服务器同时提供版本清单与安装包
  updateService = new UpdateService({
    appVersion: APP_VERSION,
    getServerUrl: () => license?.getServerUrl(),
    downloadDir: path.join(app.getPath('temp'), 'shantuo-update'),
    onEvent: (ev) => send('upd:event', ev),
    verifyInstaller: process.env.UPDATE_REQUIRE_SIGNATURE === '1'
      ? verifyDownloadedInstaller
      : undefined,
  });

  // ★ 代理层必须在任何网络请求之前安装
  await installProxyDispatcher();
  const proxyBoot = await applyBindings();
  if (proxyBoot.applied) console.log(`[boot] 代理已装载 ${proxyBoot.applied}/${proxyBoot.total} 个账号`);

  const sdkRoot = path.join(getDataDir(), 'accounts');
  manager = new AccountManager(sdkRoot);
  try {
    const migrated = manager.migrateLegacyLoginData();
    if (migrated) console.log(`[boot] 已修复 ${migrated} 个旧登录会话目录`);
    const dupes = manager.findDuplicateDeviceIds();
    if (dupes.length) {
      console.warn(
        `[boot] 检测到 ${dupes.length} 组账号共用设备身份（不做本地改写，建议分开机器/出口 IP）`,
      );
    }
  } catch (e) {
    console.warn('[boot] 旧登录会话修复失败:', e.message);
  }
  setupManagerHooks();

  // 发送服务（节流/熔断/配额/队列）
  // DRY_RUN=1 时只走调度逻辑，不真实发送（开发/测试用）
  const dryRun = process.env.DRY_RUN === '1';
  sender = new Sender({
    manager,
    db: db_(),
    config: {
      dryRun,
      // 后台任务也要受授权/强制更新约束，不能只在 IPC 入口挡
      gate: ({ scene }) => {
        if (updateService?.isForceBlocking()) {
          return { reason: 'update_required', detail: '请先完成强制更新' };
        }
        const feature = scene === 'broadcast' ? 'broadcast'
          : scene === 'intercept' ? 'intercept'
            : scene === 'autoreply' ? 'autoreply'
              : 'send';
        const deny = requireFeature(feature);
        if (!deny) return null;
        return {
          reason: deny.code === 'FEATURE_LOCKED' ? 'feature_locked' : 'license',
          detail: deny.message,
        };
      },
    },
  });
  if (dryRun) console.log('[boot] ★ 演练模式已开启，不会真实发送消息');
  sender.on('progress', (p) => send('sender:progress', p));

  createWindow();
  createTray();
  registerIpc();

  // ★ 先检查强制更新：未完成前不恢复任务、不启动监控、不登录账号
  await updateService.check({ timeoutMs: 5000 });
  const forceBlocked = updateService.isForceBlocking();
  if (forceBlocked) {
    console.warn('[boot] 强制更新未完成，已暂停后台任务和账号恢复');
  } else {
    try {
      sender.recoverTasks();
    } catch (e) {
      console.error('[boot] 群发任务恢复失败', e.message);
    }

    // 持续监控调度器（应用开着才跑，关掉就停）
    startMonitorScheduler({
      getSdk: (accountId) => {
        const acc = getAccount(accountId);
        return acc?.uid ? manager.get(String(acc.uid)) : null;
      },
      onEvent: (ev) => send('monitor:event', ev),
      canRun: () => !requireFeature('monitor') && !updateService?.isForceBlocking(),
      // 测试时可以调快检查频率（生产默认 60 秒）
      intervalMs: Number(process.env.MONITOR_TICK_MS) || 5000,
    });

    // 自动恢复已有账号
    // 演示录制时用 DEMO_NO_LOGIN=1 跳过：只展示本地数据，不连接抖音
    const accounts = process.env.DEMO_NO_LOGIN === '1'
      ? []
      : listAccounts().filter((a) => a.uid && a.enabled);
    if (accounts.length) {
      console.log(`[boot] 发现 ${accounts.length} 个已存账号，尝试恢复`);
    }
    for (const acc of accounts) {
      updateAccount(acc.id, { conn_state: 'offline' });
    }
    for (const acc of accounts) {
      (async () => {
        try {
          const sdk = manager.instance(String(acc.uid));
          await sdk.startLogin();
          const ready = await sdk.waitReady({ timeoutMs: 45000 });
          if (ready.ok) {
            const contacts = await sdk.fetchContacts();
            upsertContacts(acc.id, contacts);
            updateAccount(acc.id, {
              status: 'warm',
              conn_state: 'online',
              last_online_at: Date.now(),
              last_sync_at: Date.now(),
            });
            console.log(`[boot] ${acc.nickname} 恢复成功，好友 ${ready.friends} 个`);
          } else {
            updateAccount(acc.id, { conn_state: 'offline' });
            console.log(`[boot] ${acc.nickname} 恢复失败`);
            // ★ 不能悄悄退回直连：那会暴露真实 IP。失败就明确报出来让用户处理。
            if (acc.proxy_id) {
              console.warn(
                `[boot] ${acc.nickname} 绑定了代理，登录失败很可能因为代理不可用。` +
                  '请到「代理IP」页面测试，或先解绑再重试。',
              );
            }
          }
          send('accounts:changed', {});
        } catch (e) {
          console.error(`[boot] ${acc.nickname} 恢复异常:`, e.message);
        }
      })();
    }
  }

  if (process.env.SELFTEST === '1') runSelfTest();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {});

app.on('before-quit', async () => {
  app.isQuitting = true;
  stopMonitorScheduler();
  license?.stopHeartbeat();
  await manager?.shutdown().catch(() => {});
  await closeAllProxyAgents().catch(() => {});
  closeDb();
  closeFileLogger();
});

// ───────────── 自检 ─────────────

async function runSelfTest() {
  const report = {};
  try {
    await new Promise((r) => setTimeout(r, 3000));
    report.ui = await mainWindow.webContents.executeJavaScript(`({
      navCount: document.querySelectorAll('.nav-item').length,
      mounted: !!document.querySelector('.shell'),
    })`);
    report.ipc = await mainWindow.webContents.executeJavaScript(`(async () => {
      const out = {};
      try { out.accounts = (await window.api.account.list()).length; out.accountsOk = true; }
      catch (e) { out.accountsOk = false; out.err = e.message; }
      try { out.info = await window.api.app.info(); } catch (e) { out.infoErr = e.message; }
      return out;
    })()`);
    report.bootAccounts = listAccounts().length;
    report.sdkInstances = manager.size;
  } catch (e) {
    report.error = e.stack || String(e);
  }
  console.log('SELFTEST_RESULT=' + JSON.stringify(report, null, 2));
  setTimeout(() => { app.isQuitting = true; app.quit(); }, 500);
}
