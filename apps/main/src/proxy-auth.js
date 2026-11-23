/**
 * Chromium 隐藏窗口的代理认证
 *
 * Electron 的 session.setProxy 只接受 host:port，不接受 URL 里的 user:pass。
 * 这里记住代理凭据，并在 app 的 login 事件里只对 isProxy 的请求返回认证。
 */
import { app } from 'electron';

const credentials = new Map();
let installed = false;

function keyOf(host, port) {
  return `${String(host || '').toLowerCase()}:${Number(port) || 0}`;
}

export function rememberProxyCredential(url) {
  try {
    const u = new URL(url);
    if (!u.username && !u.password) return;
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    credentials.set(keyOf(u.hostname, port), {
      username: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || ''),
    });
  } catch {}
}

/** Chromium proxyRules：去掉认证信息，只保留协议和 host:port */
export function proxyRulesOf(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

export function installProxyAuth() {
  if (installed) return;
  installed = true;
  app.on('login', (event, _webContents, _details, authInfo, callback) => {
    if (!authInfo?.isProxy) return;
    const cred = credentials.get(keyOf(authInfo.host, authInfo.port));
    if (!cred) return;
    event.preventDefault();
    callback(cred.username, cred.password);
  });
}
