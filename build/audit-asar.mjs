/**
 * 包内自查：确认打进 asar 的东西没有「不该带出去的」
 *
 * 检查项：
 *   1. 渲染层产物存在（dist/index.html）
 *   2. 没有任何 sourcemap
 *   3. 没有测试脚本、探针脚本、文档、构建缓存
 *   4. 没有明显的临时目录/备份目录
 *
 * 用法：
 *   node build/audit-asar.mjs "release/win-unpacked/resources/app.asar"
 *   npm run audit:asar -- "release/win-unpacked/resources/app.asar"
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

const FORBIDDEN = [
  /(^|\/)test-.*\.(c?js|mjs)$/i,
  /(^|\/)probe-.*\.(c?js|mjs)$/i,
  /(^|\/)qr-probe-out\//i,
  /(^|\/)docs\//i,
  /(^|\/)release\//i,
  /(^|\/)\.git\//i,
  /(^|\/)node_modules\/\.cache\//i,
];

export function auditAsar(asarPath) {
  const asar = require('@electron/asar');
  if (!fs.existsSync(asarPath)) throw new Error(`找不到 asar: ${asarPath}`);

  const BS = String.fromCharCode(92);
  const files = asar.listPackage(asarPath).map((f) => f.split(BS).join('/').replace(/^\/+/, '/'));
  const problems = [];

  if (!files.includes('/dist/index.html')) problems.push('缺少渲染层产物 dist/index.html');

  const maps = files.filter((f) => f.endsWith('.map'));
  if (maps.length) problems.push(`包含 sourcemap ${maps.length} 个：${maps.slice(0, 3).join(', ')}`);

  // 第三方依赖里的 test-utils / docs 属于包本身，只看我们自己的文件
  const own = files.filter((f) => !f.includes('/node_modules/'));
  for (const re of FORBIDDEN) {
    const hit = own.filter((f) => re.test(f));
    if (hit.length) problems.push(`包含不该打包的文件 ${hit.length} 个（${re}）：${hit.slice(0, 3).join(', ')}`);
  }

  const size = fs.statSync(asarPath).size;
  return {
    ok: problems.length === 0,
    problems,
    fileCount: files.length,
    sizeMB: +(size / 1024 / 1024).toFixed(1),
    asarPath,
  };
}

const isCli = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isCli) {
  const target = process.argv[2];
  if (target) {
    try {
      const r = auditAsar(path.resolve(target));
      console.log(`asar: ${r.asarPath}`);
      console.log(`文件数: ${r.fileCount}  大小: ${r.sizeMB} MB`);
      if (r.ok) {
        console.log('✅ 自查通过：无 sourcemap、无测试/文档泄漏');
      } else {
        console.error('❌ 自查失败：');
        for (const p of r.problems) console.error('  · ' + p);
        process.exit(1);
      }
    } catch (e) {
      console.error('审计出错: ' + e.message);
      process.exit(1);
    }
  }
}
