/**
 * 渲染层 IPC 包装
 *
 * ★ 为什么需要：
 *   Electron contextBridge 在把参数送进 preload 之前就会做结构化克隆，
 *   而 Vue 的响应式对象是 Proxy，克隆会直接抛 "An object could not be cloned."。
 *   preload 里再深拷贝已经来不及了，必须在渲染层先转成普通数据。
 *
 * 用法：所有视图统一 `import { api } from '../api.js'`，把 window.api 换成 api。
 */
const raw = window.api;

function plain(v) {
  if (v === null || typeof v !== 'object') return v;
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return v;
  }
}

function wrapNamespace(ns) {
  if (typeof ns === 'function') {
    return (...args) => ns(...args.map(plain));
  }
  if (!ns || typeof ns !== 'object') return ns;
  const out = {};
  for (const [key, fn] of Object.entries(ns)) {
    out[key] = typeof fn === 'function' ? (...args) => fn(...args.map(plain)) : fn;
  }
  return out;
}

export const api = {};
for (const [key, value] of Object.entries(raw)) {
  api[key] = wrapNamespace(value);
}
