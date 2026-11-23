/**
 * 授权 IPC
 */
import { getLicenseManager, licenseStatus } from '../src/license-gate.js';

export function registerLicenseIpc({ ipcMain }) {
  ipcMain.handle('lic:status', () => licenseStatus());

  ipcMain.handle('lic:activate', async (_e, rawKey) => {
    try {
      const manager = getLicenseManager();
      if (!manager) return { ok: false, error: '授权模块未初始化' };
      const status = await manager.activate(rawKey);
      return { ok: true, status };
    } catch (e) {
      return { ok: false, code: e.code || 'ACTIVATE_FAILED', error: e.message };
    }
  });

  ipcMain.handle('lic:heartbeat', async () => {
    try {
      const manager = getLicenseManager();
      if (!manager) return { ok: false, error: '授权模块未初始化' };
      const status = await manager.heartbeat();
      return { ok: true, status };
    } catch (e) {
      return { ok: false, code: e.code || 'HEARTBEAT_FAILED', error: e.message };
    }
  });

  ipcMain.handle('lic:deactivate', async () => {
    try {
      const manager = getLicenseManager();
      if (!manager) return { ok: false, error: '授权模块未初始化' };
      const status = await manager.deactivate();
      return { ok: true, status };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('lic:setServerUrl', async (_e, url) => {
    try {
      const manager = getLicenseManager();
      if (!manager) return { ok: false, error: '授权模块未初始化' };
      const status = await manager.setServerUrl(url);
      return { ok: true, status };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}
