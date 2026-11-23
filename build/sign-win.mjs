/**
 * Windows Authenticode 签名/校验（可选）
 *
 * 环境变量：
 *   SIGN_WIN=1                 强制签名；没有证书则打包失败
 *   SELFSIGN=1                 使用 build/certs/selfsign.json 里的自签名证书（内部测试）
 *   WINDOWS_CERT_FILE          .pfx 证书路径
 *   WINDOWS_CERT_PASSWORD      证书密码
 *   WINDOWS_TIMESTAMP_URL      时间戳服务，默认 DigiCert
 *
 * 用法：
 *   node build/sign-win.mjs release/win-unpacked/闪拓.exe
 *   node build/sign-win.mjs release/闪拓-0.1.0-x64.exe
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_TIMESTAMP = 'http://timestamp.digicert.com';
const HERE = path.dirname(fileURLToPath(import.meta.url));

function runPowerShell(script, file) {
  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(HERE, script), file,
    ], { encoding: 'utf8', windowsHide: true });
    if (out) process.stdout.write(out);
  } catch (e) {
    if (e.stdout) process.stdout.write(e.stdout);
    if (e.stderr) process.stderr.write(e.stderr);
    throw e;
  }
}

function candidates() {
  const roots = [
    process.env['ProgramFiles(x86)'],
    process.env.ProgramFiles,
  ].filter(Boolean);
  const out = [];
  for (const root of roots) {
    const kits = path.join(root, 'Windows Kits', '10', 'bin');
    if (!fs.existsSync(kits)) continue;
    for (const version of fs.readdirSync(kits).sort().reverse()) {
      const p = path.join(kits, version, 'x64', 'signtool.exe');
      if (fs.existsSync(p)) out.push(p);
    }
  }
  return out;
}

export function findSignTool() {
  const found = candidates();
  if (found.length) return found[0];
  try {
    const out = execFileSync('where', ['signtool'], { encoding: 'utf8' }).trim();
    return out.split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

function config() {
  const selfSign = process.env.SELFSIGN === '1';
  let cert = process.env.WINDOWS_CERT_FILE || '';
  let password = process.env.WINDOWS_CERT_PASSWORD || '';

  if (selfSign && !cert) {
    const metaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'certs', 'selfsign.json');
    if (!fs.existsSync(metaPath)) {
      throw new Error('SELFSIGN=1 但还没有自签名证书，请先运行：npm run cert:self');
    }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8').replace(/^\uFEFF/, ''));
    cert = meta.pfx;
    password = fs.readFileSync(meta.passwordFile, 'utf8').trim();
  }

  return {
    sign: process.env.SIGN_WIN === '1' || selfSign,
    cert,
    password,
    timestamp: process.env.WINDOWS_TIMESTAMP_URL || DEFAULT_TIMESTAMP,
  };
}

export function signFile(file) {
  if (!fs.existsSync(file)) throw new Error(`待签名文件不存在: ${file}`);
  const cfg = config();
  if (!cfg.cert) {
    if (cfg.sign) throw new Error('SIGN_WIN=1 但未配置 WINDOWS_CERT_FILE');
    console.warn(`[sign] 未配置证书，跳过签名: ${path.basename(file)}`);
    return false;
  }
  if (!cfg.password) throw new Error('未配置 WINDOWS_CERT_PASSWORD');

  if (process.env.SELFSIGN === '1') {
    // 自签名固定走 PowerShell，不依赖 signtool，也不依赖时间戳服务
    runPowerShell('sign-self.ps1', file);
    console.log(`[sign] 已自签名: ${file}`);
    return true;
  }

  const signtool = findSignTool();
  if (!signtool) throw new Error('找不到 signtool.exe（安装 Windows SDK）');

  const args = [
    'sign', '/fd', 'SHA256',
    '/f', cfg.cert,
    '/p', cfg.password,
    '/tr', cfg.timestamp,
    '/td', 'SHA256',
    file,
  ];
  execFileSync(signtool, args, { stdio: 'inherit' });
  console.log(`[sign] 已签名: ${file}`);
  return true;
}

export function verifyFile(file) {
  if (!fs.existsSync(file)) throw new Error(`待校验文件不存在: ${file}`);
  if (process.env.SELFSIGN === '1') {
    runPowerShell('verify-self.ps1', file);
    console.log(`[sign] 自签名校验完成: ${file}`);
    return true;
  }
  const signtool = findSignTool();
  if (!signtool) throw new Error('找不到 signtool.exe（安装 Windows SDK）');
  execFileSync(signtool, ['verify', '/pa', '/v', file], { stdio: 'inherit' });
  console.log(`[sign] 签名校验通过: ${file}`);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('用法: node build/sign-win.mjs <exe> [...]');
    process.exit(1);
  }
  for (const file of files) {
    if (!signFile(file)) continue;
    verifyFile(file);
  }
}
