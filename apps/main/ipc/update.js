/**
 * 客户端更新 IPC
 */
export function registerUpdateIpc({ ipcMain, update, shell, quit }) {
  ipcMain.handle('upd:status', () => update.status());

  ipcMain.handle('upd:check', async () => {
    try {
      return { ok: true, status: await update.check() };
    } catch (e) {
      return { ok: false, error: e.message, status: update.status() };
    }
  });

  ipcMain.handle('upd:download', async () => {
    try {
      return { ok: true, status: await update.download() };
    } catch (e) {
      return { ok: false, error: e.message, status: update.status() };
    }
  });

  ipcMain.handle('upd:install', async () => {
    try {
      const status = await update.install({
        openPath: (file) => shell.openPath(file),
        quit,
      });
      return { ok: true, status };
    } catch (e) {
      return { ok: false, error: e.message, status: update.status() };
    }
  });

  ipcMain.handle('upd:reveal', async () => {
    try {
      const file = await update.reveal();
      shell.showItemInFolder(file);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}
