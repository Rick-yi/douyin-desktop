/**
 * 每个账号一份稳定指纹（guid / 屏幕 / bizTraceId）
 *
 * ★ 设备身份归属（2026-11-04 修正）
 *   deviceId / installId 由 SDK 的设备注册链生成并写回 account.json，
 *   本模块只负责浏览器侧指纹：guid、屏幕尺寸、屏幕指纹、bizTraceId。
 *
 *   旧实现在这里随机生成 deviceId/installId，并在 system.online 时覆盖
 *   account.json，导致「本地保存的 ID」和「服务端注册/激活的 ID」不一致；
 *   服务端不认识的 ID 会让 SDK 延后 60 秒才注册，放大登录验证概率。
 *
 *   现在不再生成、也不再覆盖设备 ID；旧文件里的随机值只用来做一次性迁移识别
 *   （migrateLegacyDeviceIdentity）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const PROFILES = [
  { w: 1920, h: 1080 },
  { w: 1600, h: 900 },
  { w: 1536, h: 864 },
  { w: 1440, h: 900 },
  { w: 1366, h: 768 },
  { w: 2560, h: 1440 },
  { w: 1920, h: 1200 },
];

function pickScreen(seed) {
  const h = createHash('sha1').update(String(seed)).digest();
  return PROFILES[h[0] % PROFILES.length];
}

export function buildScreenFingerprint(width, height) {
  const w = Math.max(1024, Math.round(Number(width) || 1920));
  const h = Math.max(600, Math.round(Number(height) || 1080));
  return [
    w, h - 120, w, h - 40,
    0, 0, 0, 0,
    w, h - 40,
    w, h,
    w - 15, h - 145,
    24, 24,
    'Win32',
  ].join('|');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows 上目标存在时 rename 可能失败，退回复制
    fs.copyFileSync(tmp, file);
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function loadExistingProfile(dataDir) {
  const accountsDir = path.join(dataDir, 'accounts');
  try {
    for (const d of fs.readdirSync(accountsDir, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('_')) continue;
      const file = path.join(accountsDir, d.name, 'account.json');
      if (!fs.existsSync(file)) continue;
      const account = readJson(file);
      if (account?.deviceProfile) return account.deviceProfile;
    }
  } catch {}
  return null;
}

/** 旧版 fingerprint.json 里曾经生成过的随机设备 ID，只用于迁移识别。 */
function readLegacyDeviceIds(saved) {
  if (!saved) return null;
  const deviceId = saved.deviceId ? String(saved.deviceId) : '';
  const installId = saved.installId ? String(saved.installId) : '';
  if (!deviceId && !installId) return null;
  return { deviceId, installId };
}

export function ensureFingerprint(dataDir) {
  const file = path.join(dataDir, 'fingerprint.json');
  const saved = readJson(file);

  if (saved?.screenFingerprint && saved?.guid) {
    const legacyDeviceIds = saved.legacyDeviceIds ?? readLegacyDeviceIds(saved);
    const profile = {
      version: 2,
      guid: String(saved.guid),
      screenWidth: Number(saved.screenWidth) || 1920,
      screenHeight: Number(saved.screenHeight) || 1080,
      screenFingerprint: String(saved.screenFingerprint),
      bizTraceId: saved.bizTraceId || createHash('sha1').update(String(saved.guid)).digest('hex').slice(0, 8),
      ...(legacyDeviceIds ? { legacyDeviceIds } : {}),
    };
    // 顺手把旧格式（含 deviceId/installId）改写成 v2，避免下次再被当成有效身份
    writeJsonAtomic(file, profile);
    return profile;
  }

  const existing = loadExistingProfile(dataDir);
  const seed = randomUUID();
  const picked = pickScreen(existing?.guid || seed);
  const width = Number(existing?.screenWidth) > 0 ? Number(existing.screenWidth) : picked.w;
  const height = Number(existing?.screenHeight) > 0 ? Number(existing.screenHeight) : picked.h;
  const profile = {
    version: 2,
    guid: existing?.guid || randomUUID().replaceAll('-', ''),
    screenWidth: width,
    screenHeight: height,
    screenFingerprint: buildScreenFingerprint(width, height),
    bizTraceId: existing?.bizTraceId || createHash('sha1').update(seed).digest('hex').slice(0, 8),
  };
  fs.mkdirSync(dataDir, { recursive: true });
  writeJsonAtomic(file, profile);
  return profile;
}

/**
 * 一次性迁移：旧版本把随机 deviceId/installId 写进了 account.json / pending.json。
 * 这些值服务端不认识，会让 SDK 延后 60 秒才注册。
 *
 * 命中旧随机值就把 deviceProfile 重置为 '0'，让 SDK 在下次恢复/登录时
 * 立即用真实硬件重新注册，并把服务端返回值持久化回去。
 *
 * @returns 被修正的文件数
 */
export function migrateLegacyDeviceIdentity(dataDir, legacy) {
  if (!legacy?.deviceId && !legacy?.installId) return 0;

  const accountsDir = path.join(dataDir, 'accounts');
  const files = [];
  try {
    for (const d of fs.readdirSync(accountsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      if (d.name === '_pending') {
        const pendingDir = path.join(accountsDir, d.name);
        for (const p of fs.readdirSync(pendingDir, { withFileTypes: true })) {
          if (p.isDirectory()) files.push(path.join(pendingDir, p.name, 'pending.json'));
        }
        continue;
      }
      files.push(path.join(accountsDir, d.name, 'account.json'));
    }
  } catch {
    return 0;
  }

  let changed = 0;
  for (const file of files) {
    const doc = readJson(file);
    const profile = doc?.deviceProfile;
    if (!profile) continue;
    const sameDevice = legacy.deviceId && String(profile.deviceId) === String(legacy.deviceId);
    const sameInstall = legacy.installId && String(profile.installId) === String(legacy.installId);
    if (!sameDevice && !sameInstall) continue;

    profile.deviceId = '0';
    profile.installId = '0';
    writeJsonAtomic(file, doc);
    changed++;
  }
  if (changed) {
    console.log(`[fingerprint] 已重置 ${changed} 个账号的旧随机设备 ID，等待 SDK 重新注册`);
  }
  return changed;
}
