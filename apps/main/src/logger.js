/**
 * 客户端文件日志
 *
 * 主进程 console 输出同时写入 userData/logs/app-YYYY-MM-DD.log，
 * 便于用户出问题时导出诊断。默认保留 14 天。
 *
 * ★ 不记录 token、卡密、代理密码；消息内容由调用方自行脱敏。
 */
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { redact } from './redact.js';

const KEEP_DAYS = 14;
let installed = false;
let stream = null;
let streamDate = '';

export function getLogsDir() {
  return path.join(app.getPath('userData'), 'logs');
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function currentStream() {
  const date = today();
  if (stream && streamDate === date) return stream;
  try {
    fs.mkdirSync(getLogsDir(), { recursive: true });
    stream?.end();
    stream = fs.createWriteStream(path.join(getLogsDir(), `app-${date}.log`), { flags: 'a' });
    streamDate = date;
    return stream;
  } catch {
    return null;
  }
}

function write(level, args) {
  const text = args.map((a) => {
    if (a instanceof Error) return redact(a.stack || a.message);
    if (typeof a === 'string') return redact(a);
    try { return redact(JSON.stringify(a)); } catch { return '[unserializable]'; }
  }).join(' ');
  const line = `${new Date().toISOString()} [${level}] ${text}\n`;
  try { currentStream()?.write(line); } catch {}
}

/** 只安装一次；保留原始 console 方法，避免递归 */
export function installFileLogger() {
  if (installed) return;
  installed = true;
  try { fs.mkdirSync(getLogsDir(), { recursive: true }); } catch {}

  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      write(level, args);
      original(...args);
    };
  }

  process.on('uncaughtException', (e) => {
    write('fatal', [e?.stack || String(e)]);
  });
  process.on('unhandledRejection', (e) => {
    write('fatal', ['unhandledRejection:', e?.stack || String(e)]);
  });

  cleanupOld();
}

function cleanupOld() {
  try {
    const cutoff = Date.now() - KEEP_DAYS * 86400000;
    for (const name of fs.readdirSync(getLogsDir())) {
      if (!/^app-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
      const file = path.join(getLogsDir(), name);
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    }
  } catch {}
}

export function listLogFiles() {
  try {
    return fs.readdirSync(getLogsDir())
      .filter((f) => f.endsWith('.log'))
      .map((f) => path.join(getLogsDir(), f))
      .sort();
  } catch {
    return [];
  }
}

export function closeFileLogger() {
  try { stream?.end(); } catch {}
  stream = null;
  streamDate = '';
}
