/**
 * 聊天媒体缓存
 *
 * 出站图片/文件落到 userData/data/chat-media，渲染层通过 zmtjl-media:// 协议读取。
 * 入站图片暂时直接用 CDN 地址；如果地址过期，后续可在这里补下载缓存。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDataDir } from './db.js';

const MIME_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'video/mp4': '.mp4',
  'application/pdf': '.pdf',
};

export function mediaDir() {
  const dir = path.join(getDataDir(), 'chat-media');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeExt(name, mime) {
  const byName = path.extname(String(name ?? '')).toLowerCase();
  if (byName && byName.length <= 8) return byName;
  return MIME_EXT[String(mime ?? '').toLowerCase()] || '';
}

function safeBase(name) {
  const base = path.basename(String(name ?? ''), path.extname(String(name ?? '')));
  return base.replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 60) || 'file';
}

export function mediaUrl(fileName) {
  return `zmtjl-media://local/${encodeURIComponent(fileName)}`;
}

export function saveBuffer(buffer, { name, mime } = {}) {
  const ext = safeExt(name, mime);
  const base = safeBase(name);
  const fileName = `${Date.now()}_${randomUUID().slice(0, 8)}_${base}${ext}`;
  const filePath = path.join(mediaDir(), fileName);
  fs.writeFileSync(filePath, buffer);
  return { fileName, filePath, url: mediaUrl(fileName) };
}

export function resolveMediaPath(fileName) {
  const base = path.basename(String(fileName ?? ''));
  if (!base) return null;
  const file = path.join(mediaDir(), base);
  return fs.existsSync(file) ? file : null;
}

export function readMedia(fileName) {
  const file = resolveMediaPath(fileName);
  return file ? fs.readFileSync(file) : null;
}

export function removeMedia(fileName) {
  const file = resolveMediaPath(fileName);
  if (!file) return false;
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}
