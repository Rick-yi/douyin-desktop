/**
 * 正式包数据目录迁移
 *
 * 产品改名/打包方式变化后，Electron 的 userData 目录会变化。
 * 这里在启动早期把旧目录的数据一次性复制到稳定目录：
 *   %APPDATA%\Electron\data
 *   %APPDATA%\douyin-matrix\data
 *   %APPDATA%\闪拓\data
 *   -> %APPDATA%\Shantuo\data
 *
 * 规则：
 *   - 稳定目录已有 app.db：不迁移、不覆盖
 *   - 旧目录同时存在：只取第一个有 app.db 的
 *   - 先复制到临时目录，校验后再 rename
 *   - 失败保留旧目录，不修改源数据
 */
import fs from 'node:fs';
import path from 'node:path';

export const LEGACY_APP_NAMES = ['闪拓', 'douyin-matrix', 'Electron'];

export function migrateLegacyData(appData, stableRoot) {
  try {
    const stableData = path.join(stableRoot, 'data');
    if (fs.existsSync(path.join(stableData, 'app.db'))) {
      return { migrated: false, reason: 'already_exists', stableData };
    }

    const source = LEGACY_APP_NAMES
      .map((name) => path.join(appData, name))
      .filter((dir) => path.resolve(dir) !== path.resolve(stableRoot))
      .find((dir) => fs.existsSync(path.join(dir, 'data', 'app.db')));

    if (!source) return { migrated: false, reason: 'no_legacy_data', stableData };

    fs.mkdirSync(stableRoot, { recursive: true });
    const temp = path.join(stableRoot, `.migrating-${Date.now()}`);
    fs.cpSync(path.join(source, 'data'), temp, { recursive: true });

    if (fs.existsSync(stableData)) {
      fs.rmSync(temp, { recursive: true, force: true });
      return { migrated: false, reason: 'target_not_empty', stableData };
    }

    if (!fs.existsSync(path.join(temp, 'app.db'))) {
      fs.rmSync(temp, { recursive: true, force: true });
      return { migrated: false, reason: 'copy_invalid', stableData };
    }

    fs.renameSync(temp, stableData);
    fs.writeFileSync(
      path.join(stableRoot, 'data-migration.json'),
      JSON.stringify({ from: source, at: new Date().toISOString() }, null, 2),
    );
    return { migrated: true, from: source, stableData };
  } catch (e) {
    return { migrated: false, reason: `error:${e.message}`, stableData: path.join(stableRoot, 'data') };
  }
}
