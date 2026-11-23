/**
 * 生成应用图标（无第三方依赖）
 *
 * 画一个圆角渐变方块 + 白色对话气泡，输出：
 *   build/icon.ico  （256×256，PNG 内嵌，electron-builder 用）
 *   build/icon.png  （512×512，文档/界面用）
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// ── PNG 编码 ──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── 绘制 ──
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// 圆角矩形覆盖度（传入超采样坐标）
function inRoundRect(x, y, w, h, r) {
  if (x < 0 || y < 0 || x > w || y > h) return false;
  const cx = x < r ? r : x > w - r ? w - r : x;
  const cy = y < r ? r : y > h - r ? h - r : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r || (x >= r && x <= w - r) || (y >= r && y <= h - r);
}

function inRoundRectArea(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function inTriangle(x, y, ax, ay, bx, by, cx, cy) {
  const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
  const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
  const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function inPolygon(px, py, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if ((yi > py) !== (yj > py)
      && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function render(size) {
  const SS = 4; // 超采样
  const px = Buffer.alloc(size * size * 4);
  const S = size;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let r = 0, g = 0, b = 0, a = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          // 归一化
          const nx = fx / S;
          const ny = fy / S;

          // 背板：圆角方块，占 92%
          const pad = S * 0.04;
          const bg = inRoundRectArea(fx, fy, pad, pad, S - pad, S - pad, S * 0.22);

          let cr = 0, cg = 0, cb = 0, ca = 0;
          if (bg) {
            // 电光蓝 → 靛紫 → 亮紫，速度感而不依赖抖音配色
            const t = clamp01((nx + ny) / 2);
            if (t < 0.5) {
              const k = t / 0.5;
              cr = lerp(34, 99, k);
              cg = lerp(211, 102, k);
              cb = lerp(238, 241, k);
            } else {
              const k = (t - 0.5) / 0.5;
              cr = lerp(99, 168, k);
              cg = lerp(102, 85, k);
              cb = lerp(241, 247, k);
            }
            // 左上高光
            const glow = clamp01(1 - Math.hypot(nx - 0.28, ny - 0.24) / 0.55);
            cr = lerp(cr, 255, glow * 0.18);
            cg = lerp(cg, 255, glow * 0.18);
            cb = lerp(cb, 255, glow * 0.18);
            ca = 1;
          }

          // 对话气泡
          const bx0 = S * 0.24, by0 = S * 0.29;
          const bx1 = S * 0.76, by1 = S * 0.63;
          const bubble = inRoundRectArea(fx, fy, bx0, by0, bx1, by1, S * 0.10);
          // 气泡尾巴（三角）
          const tail = inTriangle(
            fx, fy,
            bx0 + S * 0.07, by1 - S * 0.01,
            bx0 + S * 0.30, by1 - S * 0.01,
            bx0 + S * 0.11, by1 + S * 0.11,
          );

          if (bubble || tail) {
            cr = 255; cg = 255; cb = 255; ca = 1;
          }

          // 气泡里的闪电（品牌核心：闪 + 消息/拓客）
          const boltPoints = [
            [0.54, 0.29],
            [0.375, 0.515],
            [0.475, 0.515],
            [0.415, 0.635],
            [0.635, 0.405],
            [0.525, 0.405],
            [0.585, 0.29],
          ];
          if (inPolygon(nx, ny, boltPoints)) {
            // 黄 → 橙 → 红，暖色闪电在冷色底上更醒目
            const bt = clamp01((ny - 0.29) / 0.35);
            if (bt < 0.55) {
              const k = bt / 0.55;
              cr = lerp(253, 251, k);
              cg = lerp(224, 146, k);
              cb = lerp(71, 60, k);
            } else {
              const k = (bt - 0.55) / 0.45;
              cr = lerp(251, 239, k);
              cg = lerp(146, 68, k);
              cb = lerp(60, 68, k);
            }
            ca = 1;
          }

          r += cr; g += cg; b += cb; a += ca;
        }
      }

      const n = SS * SS;
      const i = (y * S + x) * 4;
      px[i] = Math.round(r / n);
      px[i + 1] = Math.round(g / n);
      px[i + 2] = Math.round(b / n);
      px[i + 3] = Math.round((a / n) * 255);
    }
  }

  return px;
}

// ── ICO 封装（BMP/DIB 条目）──
// ★ 不用 PNG 内嵌：rcedit / app-builder 对 PNG 条目的兼容性差，
//   Windows 资源编辑场景一律用 32 位 BGRA + AND mask。
function encodeIcoBmp(images) {
  // images: [{size, rgba}]
  const entries = [];
  const blobs = [];

  for (const { size, rgba } of images) {
    const rowSize = size * 4;
    const xor = Buffer.alloc(rowSize * size);
    // BMP 是自下而上、BGRA
    for (let y = 0; y < size; y++) {
      const srcRow = (size - 1 - y) * rowSize;
      const dstRow = y * rowSize;
      for (let x = 0; x < size; x++) {
        const s = srcRow + x * 4;
        const d = dstRow + x * 4;
        xor[d] = rgba[s + 2];     // B
        xor[d + 1] = rgba[s + 1]; // G
        xor[d + 2] = rgba[s];     // R
        xor[d + 3] = rgba[s + 3]; // A
      }
    }

    // AND mask：alpha=0 的像素置 1，其余 0；每行按 4 字节对齐
    const maskRow = Math.ceil(size / 32) * 4;
    const and = Buffer.alloc(maskRow * size);
    for (let y = 0; y < size; y++) {
      const srcRow = (size - 1 - y) * rowSize;
      for (let x = 0; x < size; x++) {
        const alpha = rgba[srcRow + x * 4 + 3];
        if (alpha === 0) {
          and[y * maskRow + (x >> 3)] |= 0x80 >> (x & 7);
        }
      }
    }

    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0);        // biSize
    header.writeInt32LE(size, 4);       // biWidth
    header.writeInt32LE(size * 2, 8);   // biHeight（XOR + AND）
    header.writeUInt16LE(1, 12);        // biPlanes
    header.writeUInt16LE(32, 14);       // biBitCount
    header.writeUInt32LE(0, 16);        // BI_RGB
    header.writeUInt32LE(xor.length + and.length, 20);

    blobs.push(Buffer.concat([header, xor, and]));
    entries.push({ size, length: blobs[blobs.length - 1].length });
  }

  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  let offset = 6 + count * 16;
  const dirs = [];
  for (const e of entries) {
    const d = Buffer.alloc(16);
    d[0] = e.size >= 256 ? 0 : e.size;
    d[1] = e.size >= 256 ? 0 : e.size;
    d[2] = 0;
    d[3] = 0;
    d.writeUInt16LE(1, 4);
    d.writeUInt16LE(32, 6);
    d.writeUInt32LE(e.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += e.length;
    dirs.push(d);
  }

  return Buffer.concat([header, ...dirs, ...blobs]);
}

const outDir = path.join(process.cwd(), 'build');
fs.mkdirSync(outDir, { recursive: true });

const big = encodePng(512, render(512));
fs.writeFileSync(path.join(outDir, 'icon.png'), big);
console.log('icon.png 512x512', big.length, 'bytes');

// 应用内使用：窗口图标 / 托盘图标（跟 asar 一起打包）
const assetsDir = path.join(process.cwd(), 'apps', 'main', 'assets');
fs.mkdirSync(assetsDir, { recursive: true });
const appPng = encodePng(256, render(256));
fs.writeFileSync(path.join(assetsDir, 'icon.png'), appPng);
const trayPng = encodePng(32, render(32));
fs.writeFileSync(path.join(assetsDir, 'tray.png'), trayPng);
console.log('apps/main/assets/icon.png 256x256', appPng.length, 'bytes');
console.log('apps/main/assets/tray.png 32x32', trayPng.length, 'bytes');

const sizes = [16, 24, 32, 48, 64, 128, 256];
const variants = sizes.map((s) => ({ size: s, rgba: render(s) }));
const ico = encodeIcoBmp(variants);
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);
console.log('icon.ico', sizes.join('/'), ico.length, 'bytes');
