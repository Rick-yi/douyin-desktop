/**
 * 代理 IP IPC
 */
import { app } from 'electron';
import {
  listProxies, createProxy, updateProxy, deleteProxy,
  testProxy, bindAccount, applyBindings, accountProxyState, proxyMap,
  isProxyEnabled, setProxyEnabled,
} from '../src/proxy-service.js';
import { proxyDebugState } from '../../../packages/net/proxy-dispatcher.js';
import { requireFeature } from '../src/license-gate.js';

export function registerProxyIpc({ ipcMain }) {
  ipcMain.handle('px:list', () => listProxies());
  ipcMain.handle('px:enabled', () => ({ enabled: isProxyEnabled() }));
  ipcMain.handle('px:setEnabled', (_e, enabled) => setProxyEnabled(!!enabled));

  ipcMain.handle('px:create', (_e, payload) => {
    const deny = requireFeature('proxy');
    if (deny) return deny;
    try {
      return createProxy(payload ?? {});
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('px:update', (_e, id, patch) => {
    try {
      return updateProxy(id, patch ?? {});
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('px:delete', (_e, id) => deleteProxy(id));

  ipcMain.handle('px:test', async (_e, id) => {
    try {
      return { ...(await testProxy(id)) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('px:bind', (_e, accountId, proxyId) => {
    const deny = requireFeature('proxy');
    if (deny) return deny;
    try {
      return bindAccount(accountId, proxyId);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 每个账号绑了哪个代理（账号页展示用）
  ipcMain.handle('px:map', () => proxyMap());
  ipcMain.handle('px:state', (_e, accountId) => accountProxyState(accountId));

  // 重新装载绑定（一般不用手动调，启动时自动）
  ipcMain.handle('px:apply', () => applyBindings());
  ipcMain.handle('px:debug', () => proxyDebugState());

  // 代理只在建立连接时生效，改绑定后需要重启
  ipcMain.handle('px:relaunch', () => {
    app.relaunch();
    setTimeout(() => app.exit(0), 300);
    return { ok: true };
  });
}
