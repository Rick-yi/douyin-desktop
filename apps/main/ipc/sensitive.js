/**
 * 敏感词 IPC
 */
import {
  listGroups, listWords, addWord, updateWord, deleteWord,
  addGroup, deleteGroup, hitStats, clearHits,
  previewSensitive, rewriteSensitive, invalidateCache, listRewriteTemplates,
} from '../src/sensitive.js';

export function registerSensitiveIpc({ ipcMain }) {
  // 分组
  ipcMain.handle('sw:groups', () => listGroups());
  ipcMain.handle('sw:addGroup', (_e, payload) => addGroup(payload));
  ipcMain.handle('sw:deleteGroup', (_e, id) => deleteGroup(id));

  // 词条
  ipcMain.handle('sw:list', (_e, filters) => listWords(filters ?? {}));
  ipcMain.handle('sw:add', (_e, payload) => addWord(payload));
  ipcMain.handle('sw:update', (_e, id, patch) => updateWord(id, patch));
  ipcMain.handle('sw:delete', (_e, id) => deleteWord(id));
  ipcMain.handle('sw:reload', () => { invalidateCache(); return { ok: true }; });

  // 检测（不记录）
  ipcMain.handle('sw:preview', (_e, text, scene) => previewSensitive(text, scene ?? 'dm'));

  // 合规改写（不记录）
  ipcMain.handle('sw:rewrite', (_e, text, scene, opts) => {
    try {
      return rewriteSensitive(text, scene ?? 'dm', opts ?? {});
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 合规整句模板
  ipcMain.handle('sw:templates', (_e, opts) => listRewriteTemplates(opts ?? {}));

  // 命中统计
  ipcMain.handle('sw:stats', (_e, opts) => hitStats(opts ?? {}));
  ipcMain.handle('sw:clearHits', () => clearHits());
}
