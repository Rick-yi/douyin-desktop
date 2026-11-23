/**
 * 本地数据备份/恢复
 *
 * 备份范围：userData/data（app.db、accounts、cards、chat-media、settings 等）。
 * 恢复采用“下次启动前替换”的方式，避免运行中替换数据库。
 *
 * ★ 备份包含账号 session，属于敏感文件；默认放在 userData/backups，权限仅当前用户。
 */
import fs from 'node:fs';
import path from 'node:path';

const MANUAL_PREFIX = 'manual-';
const KEEP_MANUAL = 10;

export function backupsDir(userData) {
  return path.join(userData, 'backups');
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function copyData(srcData, destData) {
  fs.mkdirSync(destData, { recursive: true });
  fs.cpSync(srcData, destData, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(srcData, src);
      // 不把历史迁移备份再套娃备份
      return rel !== 'backups' && !rel.startsWith(`backups${path.sep}`);
    },
  });
}

export function createBackup(userData, { appVersion = '' } = {}) {
  const dataDir = path.join(userData, 'data');
  if (!fs.existsSync(path.join(dataDir, 'app.db'))) {
    throw new Error('数据库文件不存在，无法备份');
  }

  const root = backupsDir(userData);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const dest = path.join(root, `${MANUAL_PREFIX}${stamp()}`);
  const destData = path.join(dest, 'data');
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });

  copyData(dataDir, destData);

  const manifest = {
    kind: 'manual',
    createdAt: new Date().toISOString(),
    appVersion,
    dataDir: 'data',
  };
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2));

  pruneManual(root);
  return { path: dest, createdAt: manifest.createdAt, appVersion };
}

function pruneManual(root) {
  try {
    const dirs = fs.readdirSync(root)
      .filter((n) => n.startsWith(MANUAL_PREFIX))
      .map((n) => path.join(root, n))
      .filter((p) => fs.statSync(p).isDirectory())
      .sort();
    while (dirs.length > KEEP_MANUAL) {
      fs.rmSync(dirs.shift(), { recursive: true, force: true });
    }
  } catch {}
}

export function listBackups(userData) {
  const root = backupsDir(userData);
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      const manifestPath = path.join(dir, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (!fs.existsSync(path.join(dir, 'data', 'app.db'))) continue;
      out.push({
        name,
        path: dir,
        createdAt: manifest.createdAt || '',
        appVersion: manifest.appVersion || '',
        kind: manifest.kind || 'manual',
      });
    } catch {}
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function markerPath(userData) {
  return path.join(userData, 'restore-pending.json');
}

export function stageRestore(userData, backupPath) {
  const root = path.resolve(backupsDir(userData));
  const src = path.resolve(String(backupPath || ''));
  if (!src.startsWith(root + path.sep)) throw new Error('备份路径不在允许目录内');
  if (!fs.existsSync(path.join(src, 'data', 'app.db'))) throw new Error('备份缺少 app.db');
  fs.writeFileSync(markerPath(userData), JSON.stringify({
    source: src,
    stagedAt: new Date().toISOString(),
  }, null, 2));
  return true;
}

/** 在 initDb 之前调用；返回恢复结果 */
export function applyPendingRestore(userData) {
  const marker = markerPath(userData);
  if (!fs.existsSync(marker)) return { restored: false };
  let info;
  try {
    info = JSON.parse(fs.readFileSync(marker, 'utf8'));
  } catch {
    fs.rmSync(marker, { force: true });
    return { restored: false, error: '恢复标记损坏' };
  }

  const root = path.resolve(backupsDir(userData));
  const src = path.resolve(String(info.source || ''));
  if (!src.startsWith(root + path.sep) || !fs.existsSync(path.join(src, 'data', 'app.db'))) {
    fs.rmSync(marker, { force: true });
    return { restored: false, error: '备份路径无效' };
  }

  const dataDir = path.join(userData, 'data');
  const pre = path.join(root, `pre-restore-${stamp()}`);
  try {
    if (fs.existsSync(dataDir)) {
      fs.mkdirSync(pre, { recursive: true, mode: 0o700 });
      copyData(dataDir, path.join(pre, 'data'));
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
    copyData(path.join(src, 'data'), dataDir);
    fs.rmSync(marker, { force: true });
    return { restored: true, from: src, previous: pre };
  } catch (e) {
    // 替换失败时尽量回滚到恢复前数据
    try {
      if (fs.existsSync(path.join(pre, 'data', 'app.db'))) {
        fs.rmSync(dataDir, { recursive: true, force: true });
        copyData(path.join(pre, 'data'), dataDir);
      }
    } catch {}
    fs.rmSync(marker, { force: true });
    return { restored: false, error: e.message };
  }
}
