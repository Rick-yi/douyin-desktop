/**
 * Windows 打包脚本
 *
 * 为什么不用一句 `electron-builder`：
 *   1. 这台机器访问 github.com 不通，winCodeSign/nsis 资源要从 npmmirror 拉
 *   2. winCodeSign 解压时会给 darwin 目录建符号链接，普通用户没权限 → 报错
 *   3. 因此关掉 electron-builder 的 rcedit 步骤，改由我们手动调用
 *      缓存里已经解压好的 rcedit.exe 写图标和版本信息
 *   4. 手动 rcedit 之后再用 --prepackaged 打安装包
 *
 * 用法：npm run dist
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { applyFuses } from './fuses.mjs';
import { auditAsar } from './audit-asar.mjs';
import { signFile, verifyFile } from './sign-win.mjs';

const ROOT = process.cwd();
const RELEASE = path.join(ROOT, 'release');
const UNPACKED = path.join(RELEASE, 'win-unpacked');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const EXE = path.join(UNPACKED, `${pkg.build.productName}.exe`);

const env = {
  ...process.env,
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
    'https://npmmirror.com/mirrors/electron-builder-binaries/',
};

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, {
    stdio: 'inherit',
    cwd: ROOT,
    env,
    ...opts,
  });
}

// 直接跑本地 CLI 脚本：Windows 上 npx 是 .cmd，且 shell 会破坏中文参数
const NODE = process.execPath;
const CLI = {
  vite: path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
  electronBuilder: path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js'),
};

function findRcedit() {
  const cacheRoot = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'electron-builder',
    'Cache',
    'winCodeSign',
  );
  if (!fs.existsSync(cacheRoot)) return null;
  for (const dir of fs.readdirSync(cacheRoot)) {
    const p = path.join(cacheRoot, dir, 'rcedit-x64.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ── 1. 渲染进程 ──
run(NODE, [CLI.vite, 'build']);

// ── 2. 图标（没生成过就生成）──
const icon = path.join(ROOT, 'build', 'icon.ico');
if (!fs.existsSync(icon)) run(NODE, [path.join(ROOT, 'build', 'make-icon.mjs')]);

// ── 3. 打包成目录（不编辑 exe）──
run(NODE, [CLI.electronBuilder, '--win', '--x64', '--dir']);

// ── 3.5 包内自查（发现不该带的文件就直接失败）──
{
  const asarPath = path.join(UNPACKED, 'resources', 'app.asar');
  const r = auditAsar(asarPath);
  if (!r.ok) {
    console.error('❌ 包内自查失败：');
    for (const p of r.problems) console.error('  · ' + p);
    throw new Error('包内自查失败，已中止打包');
  }
  console.log(`📦 asar 自查通过：${r.fileCount} 个文件，${r.sizeMB} MB`);
}

// ── 4. 手动写 exe 资源 ──
if (fs.existsSync(EXE)) {
  const rcedit = findRcedit();
  if (rcedit) {
    // ★ 刚写出来的 exe 可能被杀软短暂占用，rcedit 会报 "Unable to commit changes"，
    //   重试几次即可（实测偶发）
    const args = [
      EXE,
      '--set-icon', icon,
      '--set-version-string', 'ProductName', pkg.build.productName,
      '--set-version-string', 'FileDescription', pkg.description,
      '--set-version-string', 'CompanyName', pkg.author || '',
      '--set-version-string', 'LegalCopyright', pkg.build.copyright || '',
      // ★ 不能用 --set-file-version：rcedit 改数值版本号时在这个 exe 上会
      //   "Unable to commit changes"，用字符串字段一样能写进资源表
      '--set-version-string', 'FileVersion', pkg.version,
      '--set-version-string', 'ProductVersion', pkg.version,
    ];
    let ok = false;
    for (let i = 0; i < 4 && !ok; i++) {
      try {
        run(rcedit, args);
        ok = true;
      } catch {
        console.warn(`⚠ rcedit 第 ${i + 1} 次失败，2 秒后重试…`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (!ok) throw new Error('rcedit 写入 exe 资源失败（可能被杀软占用）');
  } else {
    console.warn('⚠ 没找到 rcedit.exe（首次打包需要联网下载 winCodeSign），跳过图标写入');
  }
} else {
  console.warn(`⚠ 没找到 ${EXE}，跳过资源写入`);
}

// ── 4.5 写入 Electron Fuses（防调试 / 防改 asar）──
if (fs.existsSync(EXE)) {
  // 刚被 rcedit 改过的 exe 可能被杀软短暂占用（EBUSY），重试几次
  let fused = false;
  let lastErr = null;
  for (let i = 0; i < 4 && !fused; i++) {
    try {
      await applyFuses(EXE);
      fused = true;
    } catch (e) {
      lastErr = e;
      console.warn(`⚠ Fuses 第 ${i + 1} 次失败：${e.message}，2 秒后重试…`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!fused) throw new Error(`Fuses 写入失败，中止打包：${lastErr?.message}`);
  console.log('🔒 Fuses 已写入（禁用 RunAsNode / NODE_OPTIONS / --inspect，强制 asar 完整性校验）');
}

// ── 4.6 Authenticode 签名（rcedit/fuses 之后，不能再改资源）──
if (fs.existsSync(EXE)) {
  await signFile(EXE);
}

// ── 5. 用改好的目录打安装包 ──
run(NODE, [CLI.electronBuilder, '--win', 'nsis', '--x64', '--prepackaged', UNPACKED]);

// ── 5.5 签安装包并校验 ──
{
  const installer = fs.readdirSync(RELEASE)
    .filter((f) => f.endsWith('.exe') && f !== path.basename(EXE))
    .map((f) => path.join(RELEASE, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (installer) {
    const signed = await signFile(installer);
    if (signed) await verifyFile(installer);
  }
}

// ── 6. 汇总 ──
console.log('\n=== 产物 ===');
for (const f of fs.readdirSync(RELEASE)) {
  if (f.endsWith('.exe')) {
    const size = fs.statSync(path.join(RELEASE, f)).size;
    console.log(`  ${f}  ${(size / 1024 / 1024).toFixed(1)} MB`);
  }
}

// ── 7. SHA256SUMS ──
{
  const files = fs.readdirSync(RELEASE).filter((f) => f.endsWith('.exe')).sort();
  const lines = files.map((f) => {
    const hash = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(RELEASE, f)))
      .digest('hex');
    return `${hash}  ${f}`;
  });
  if (lines.length) {
    fs.writeFileSync(path.join(RELEASE, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
    console.log('\nSHA256SUMS.txt 已生成');
  }
}
