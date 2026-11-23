/**
 * Electron Fuses：把可被利用的默认开关关掉
 *
 * 这不是「加密」，是提高逆向/调试门槛：
 *   RunAsNode=false                      不能把 exe 当 Node 跑任意脚本
 *   EnableNodeOptionsEnvironmentVariable=false   NODE_OPTIONS 注入失效
 *   EnableNodeCliInspectArguments=false   不能 --inspect 挂调试器
 *   EnableEmbeddedAsarIntegrityValidation=true   改过 app.asar 就启动不了
 *   OnlyLoadAppFromAsar=true              只能从 asar 加载代码，不能换成松散目录
 *   GrantFileProtocolExtraPrivileges        保持默认 true
 *     ★ 实测：关掉它会导致 file:// 下的 ESM 模块加载被拦，界面白屏。
 *       我们的渲染层就是 file:// + ESM，所以这一项不能动。
 *
 * ★ 顺序要求
 *   必须在 rcedit 写完图标/版本之后、打安装包之前执行。
 *   rcedit 走 Windows 资源 API，会保留 asar 完整性资源；
 *   如果反过来（先 fuses 后 rcedit）需要重新验证。
 *
 * 用法：
 *   node build/fuses.mjs "release/win-unpacked/闪拓.exe"
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function applyFuses(exePath) {
  const { flipFuses, FuseVersion, FuseV1Options } = await import('@electron/fuses');
  if (!fs.existsSync(exePath)) throw new Error(`找不到 exe: ${exePath}`);

  await flipFuses(exePath, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    // 不要关：file:// + ESM 依赖它，关了会白屏（实测）
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: true,
  });
  return true;
}

export async function readFuses(exePath) {
  const { getCurrentFuseWire, FuseV1Options } = await import('@electron/fuses');
  const wire = await getCurrentFuseWire(exePath);
  const out = {};
  for (const [name, idx] of Object.entries(FuseV1Options)) {
    if (typeof idx === 'number') out[name] = wire[idx];
  }
  return out;
}

// CLI
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const exe = process.argv[2];
  if (!exe) {
    console.error('用法: node build/fuses.mjs <exe 路径>');
    process.exit(1);
  }
  const abs = path.resolve(exe);
  applyFuses(abs)
    .then(async () => {
      console.log('fuses 已写入:', abs);
      console.log(JSON.stringify(await readFuses(abs), null, 2));
    })
    .catch((e) => {
      console.error('fuses 写入失败:', e.message);
      process.exit(1);
    });
}
