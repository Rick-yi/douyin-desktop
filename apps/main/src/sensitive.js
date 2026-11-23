/**
 * 敏感词服务（数据库 + 缓存的薄封装）
 *
 * 核心逻辑在 packages/risk/sensitive-engine.js，
 * 这里负责：读词库、缓存、写命中记录。
 */
import { db_ } from './db.js';
import { randomUUID } from 'node:crypto';
import { checkText, normalize } from '../../../packages/risk/sensitive-engine.js';
import { rewriteText, rewriteSentence } from '../../../packages/risk/rewrite-engine.js';
import { redact } from './redact.js';

let cache = null;
let cacheAt = 0;
const CACHE_TTL = 30_000;

// 只放行“单独一条官方链接”，避免 qq.com 误伤，也不放宽其他文本

const ALLOWED_LINK_HOSTS = new Set([
  'work.weixin.qq.com',
]);
if (process.env.ALLOWED_LINK_HOST) {
  ALLOWED_LINK_HOSTS.add(process.env.ALLOWED_LINK_HOST.toLowerCase());
}

function isBareAllowedLink(text) {
  const value = String(text ?? '').trim();
  if (!value || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    return ALLOWED_LINK_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * 读取词库（带分组名和描述）
 */
export function loadWords() {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_TTL) return cache;

  try {
    const rows = db_()
      .prepare(
        `SELECT w.*, g.name AS group_name
         FROM sensitive_word w
         LEFT JOIN sensitive_group g ON g.id = w.group_id
         WHERE w.enabled = 1`,
      )
      .all();

    cache = rows.map((r) => ({
      id: r.id,
      word: r.word,
      action: r.action,
      severity: r.severity ?? 2,
      replace_to: r.replace_to,
      suggestion: r.suggestion,
      rewritePolicy: r.rewrite_policy || 'manual',
      category: r.category,
      basis: r.basis,
      message: r.message,
      groupId: r.group_id,
      groupName: r.group_name,
      scope: (r.scope ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      enabled: !!r.enabled,
    }));
    cacheAt = now;
  } catch (e) {
    console.error('[sensitive] 读取词库失败', e.message);
    cache = [];
  }
  return cache;
}

export function invalidateCache() {
  cache = null;
  cacheAt = 0;
}

/**
 * 检查文本
 *
 * @param {string} text
 * @param {string} scene dm|comment|broadcast|intercept
 * @param {object} opts { accountId, record: 是否写命中记录 }
 */
export function checkSensitive(text, scene = 'dm', opts = {}) {
  const all = loadWords();
  const words = all.filter(
    (w) => !w.scope.length || w.scope.includes(scene),
  );

  const result = checkText(text, { words });

  // 写命中记录
  if (opts.record !== false && result.hits.length) {
    try {
      const db = db_();
      const stmt = db.prepare(
        `INSERT INTO sensitive_hit
           (id, word_id, word, group_id, account_id, scene, content, action, severity, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const now = Date.now();
      for (const h of result.hits) {
        stmt.run(
          randomUUID(),
          h.wordId ?? null,
          h.word,
          h.group ?? null,
          opts.accountId ?? null,
          scene,
          redact(String(text).slice(0, 500)),
          h.action,
          h.severity,
          now,
        );
      }
    } catch (e) {
      console.error('[sensitive] 写命中记录失败', e.message);
    }
  }

  return {
    blocked: result.blocked,
    hits: result.hits,
    replaced: result.replaced,
    score: result.score,
    level: result.level,
  };
}

/**
 * 只检查不记录（用于 UI 实时预览）
 */
export function previewSensitive(text, scene = 'dm') {
  return checkSensitive(text, scene, { record: false });
}

/**
 * 合规改写（不写命中记录）
 */
export function rewriteSensitive(text, scene = 'dm', opts = {}) {
  const all = loadWords();
  const words = all.filter((w) => !w.scope.length || w.scope.includes(scene));
  if (opts.sentence) {
    const templates = opts.templates ?? listRewriteTemplates({
      scene,
      industry: opts.industry,
    });
    return rewriteSentence(text, { words, templates, scene, industry: opts.industry });
  }
  return rewriteText(text, { words, scene });
}

/**
 * 发送前：检测 + 合规改写，返回最终可发送文本。
 * 命中记录只写一次（checkSensitive），改写本身不写。
 */
export function checkAndRewrite(text, scene = 'dm', opts = {}) {
  // 官方落地链接/企微联系我链接：允许单独一条文本直接发送
  if (isBareAllowedLink(text)) {
    return {
      blocked: false,
      before: { blocked: false, hits: [], replaced: text, score: 0, level: 'ok' },
      text,
      rewrite: null,
      changes: [],
      allowlisted: true,
    };
  }

  const check = checkSensitive(text, scene, opts);
  if (check.blocked) {
    return { blocked: true, before: check, text, rewrite: null, changes: [] };
  }
  const rewrite = rewriteSensitive(text, scene, opts);
  const blocked = !rewrite.ok || !!rewrite.after?.blocked;
  return {
    blocked,
    before: check,
    text: blocked ? text : (rewrite.rewritten ?? text),
    rewrite,
    changes: rewrite.changes ?? [],
    score: rewrite.after?.score ?? check.score,
  };
}

let templateCache = null;
let templateAt = 0;
const TEMPLATE_TTL = 30_000;

export function listRewriteTemplates({ scene, industry } = {}) {
  const now = Date.now();
  if (!templateCache || now - templateAt >= TEMPLATE_TTL) {
    try {
      templateCache = db_()
        .prepare('SELECT * FROM rewrite_template WHERE enabled = 1 ORDER BY priority DESC, created_at ASC')
        .all();
      templateAt = now;
    } catch {
      templateCache = [];
      templateAt = now;
    }
  }
  return templateCache
    .filter((t) => {
      const scenes = String(t.scene ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (scene && scenes.length && !scenes.includes('both') && !scenes.includes(scene)) return false;
      if (industry && t.industry && t.industry !== '通用' && t.industry !== industry) return false;
      return true;
    })
    .map((t) => ({
      id: t.id,
      industry: t.industry,
      scene: t.scene,
      name: t.name,
      triggers: String(t.triggers ?? '').split(/[\r\n,，|]+/).map((s) => s.trim()).filter(Boolean),
      templateText: t.template_text,
      basis: t.basis,
      priority: t.priority,
    }));
}

export function invalidateTemplateCache() {
  templateCache = null;
  templateAt = 0;
}

/**
 * 命中统计（近 N 天）
 */
export function hitStats({ days = 7 } = {}) {
  const since = Date.now() - days * 86400000;
  const db = db_();

  const byWord = db
    .prepare(
      `SELECT word, group_id, COUNT(*) c
       FROM sensitive_hit WHERE created_at >= ?
       GROUP BY word, group_id ORDER BY c DESC LIMIT 50`,
    )
    .all(since);

  const byAction = db
    .prepare(
      `SELECT action, COUNT(*) c FROM sensitive_hit
       WHERE created_at >= ? GROUP BY action`,
    )
    .all(since);

  const total = byAction.reduce((s, x) => s + x.c, 0);

  return { byWord, byAction, total, days };
}

/**
 * 清空命中记录
 */
export function clearHits() {
  db_().prepare('DELETE FROM sensitive_hit').run();
  return { ok: true };
}

// ══════════════════════════════════════
// 词库管理
// ══════════════════════════════════════

export function listGroups() {
  return db_()
    .prepare('SELECT * FROM sensitive_group ORDER BY sort')
    .all()
    .map((g) => ({
      ...g,
      count: db_()
        .prepare('SELECT COUNT(*) c FROM sensitive_word WHERE group_id = ?')
        .get(g.id).c,
    }));
}

export function listWords({ groupId, keyword } = {}) {
  const where = [];
  const args = [];
  if (groupId) { where.push('w.group_id = ?'); args.push(groupId); }
  if (keyword) { where.push('w.word LIKE ?'); args.push(`%${keyword}%`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';

  return db_()
    .prepare(
      `SELECT w.*, g.name AS group_name
       FROM sensitive_word w LEFT JOIN sensitive_group g ON g.id = w.group_id
       ${w} ORDER BY g.sort, w.word`,
    )
    .all(...args);
}

export function addWord({
  groupId, word, action = 'warn', severity = 2, scope, replaceTo, message,
  suggestion, rewritePolicy = 'manual', category, basis,
}) {
  const w = String(word ?? '').trim();
  if (!w) throw new Error('词不能为空');
  if (w.length < 2) {
    throw new Error('词至少需要 2 个字（单字歧义太大，建议用"加微"这类组合词）');
  }
  const id = randomUUID();
  db_()
    .prepare(
      `INSERT INTO sensitive_word
         (id, group_id, word, match_type, action, replace_to, suggestion,
          rewrite_policy, category, basis, scope, enabled, severity, message)
       VALUES (?, ?, ?, 'contains', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(
      id,
      groupId,
      w,
      action,
      replaceTo ?? null,
      suggestion ?? null,
      rewritePolicy,
      category ?? null,
      basis ?? null,
      scope ?? 'dm,comment,broadcast,intercept',
      severity,
      message ?? null,
    );
  invalidateCache();
  return { id };
}

export function updateWord(id, patch) {
  const allowed = [
    'group_id', 'word', 'action', 'replace_to', 'scope', 'enabled', 'severity', 'message',
    'suggestion', 'rewrite_policy', 'category', 'basis',
  ];
  const keys = Object.keys(patch).filter((k) => allowed.includes(k));
  if (!keys.length) return { ok: false };
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  db_()
    .prepare(`UPDATE sensitive_word SET ${sets} WHERE id = ?`)
    .run(...keys.map((k) => patch[k]), id);
  invalidateCache();
  return { ok: true };
}

export function deleteWord(id) {
  db_().prepare('DELETE FROM sensitive_word WHERE id = ?').run(id);
  invalidateCache();
  return { ok: true };
}

export function addGroup({ id, name, description, sort = 99 }) {
  const gid = id || randomUUID();
  db_()
    .prepare('INSERT OR IGNORE INTO sensitive_group (id, name, sort, description) VALUES (?, ?, ?, ?)')
    .run(gid, name, sort, description ?? null);
  return { id: gid };
}

export function deleteGroup(id) {
  db_().prepare('DELETE FROM sensitive_word WHERE group_id = ?').run(id);
  db_().prepare('DELETE FROM sensitive_group WHERE id = ?').run(id);
  invalidateCache();
  return { ok: true };
}

export { normalize };
