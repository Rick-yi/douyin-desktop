/**
 * 合规改写引擎
 *
 * 只做两类事：
 *   1. 用词库里的 suggestion 替换违规表达
 *   2. 删除没有合规替代写法的违规表达（含站外联系方式）
 *
 * 不做同音字、拆字、符号插入等绕过平台检测的变体。
 */
import { checkText } from './sensitive-engine.js';

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceAll(text, word, to) {
  if (!word) return text;
  return String(text).replace(new RegExp(escapeRe(word), 'gi'), to);
}

/** 删除词后清理多余标点和空白 */
export function cleanPunctuation(text) {
  return String(text)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/([，,、；;：:])(?:[ \t]*\1)+/g, '$1')
    .replace(/([，,、；;：:])[ \t]*(?=[。！？!?]|$)/g, '')
    .replace(/^[，,、；;：:\s]+/, '')
    .replace(/[ \t]+([。！？!?])/g, '$1')
    .trim();
}

/**
 * @param {string} text
 * @param {{ words?: object[], scene?: string }} opts
 * @returns {{
 *   ok: boolean,
 *   rewritten: string,
 *   changes: object[],
 *   unresolved: object[],
 *   before: object,
 *   after: object,
 *   remaining: object[]
 * }}
 */
export function rewriteText(text, { words = [], scene = 'dm' } = {}) {
  const raw = String(text ?? '');
  const before = checkText(raw, { words });
  if (!before.hits.length) {
    return {
      ok: true,
      rewritten: raw,
      changes: [],
      unresolved: [],
      before,
      after: before,
      remaining: [],
      scene,
    };
  }

  let out = raw;
  const changes = [];
  const unresolvedRaw = [];
  const wordMap = new Map(words.map((w) => [String(w.word), w]));

  // 替换优先于删除，删除优先于人工/阻断；同类按长度倒序，减少误伤
  const policyOf = (hit) => {
    if (hit.isPattern) return 'remove';
    return wordMap.get(String(hit.word))?.rewritePolicy || 'manual';
  };
  const rank = { replace: 0, remove: 1, manual: 2, block: 3 };
  const hits = [...before.hits].sort(
    (a, b) =>
      (rank[policyOf(a)] ?? 2) - (rank[policyOf(b)] ?? 2) ||
      String(b.matched ?? b.word ?? '').length - String(a.matched ?? a.word ?? '').length,
  );

  for (const hit of hits) {
    const matched = String(hit.matched ?? hit.word ?? '');
    if (!matched) continue;

    // 正则规则：微信/手机号/邮箱/链接直接删除，属于合规做法
    if (hit.isPattern) {
      if (!out.includes(matched)) continue;
      out = replaceAll(out, matched, '');
      changes.push({
        word: hit.word,
        matched,
        action: 'remove',
        category: '站外导流',
        basis: '平台禁止站外联系方式/链接',
        message: hit.message,
      });
      continue;
    }

    const w = wordMap.get(String(hit.word));
    if (!w) {
      unresolvedRaw.push({
        word: hit.word,
        action: hit.action,
        category: hit.group,
        message: hit.message,
      });
      continue;
    }

    // 已经被更优先的替换/删除处理掉，不再重复记录
    if (!new RegExp(escapeRe(w.word), 'i').test(out)) continue;

    const policy = w.rewritePolicy || 'manual';
    if (policy === 'replace' && w.suggestion) {
      out = replaceAll(out, w.word, w.suggestion);
      changes.push({
        word: w.word,
        matched,
        action: 'replace',
        to: w.suggestion,
        category: w.category,
        basis: w.basis,
        message: w.message,
      });
    } else if (policy === 'remove') {
      out = replaceAll(out, w.word, '');
      changes.push({
        word: w.word,
        matched,
        action: 'remove',
        to: '',
        category: w.category,
        basis: w.basis,
        message: w.message,
      });
    } else if (policy === 'block') {
      unresolvedRaw.push({
        word: w.word,
        action: 'block',
        category: w.category || w.groupName,
        message: w.message || '必须删除',
      });
    } else {
      unresolvedRaw.push({
        word: w.word,
        action: 'manual',
        category: w.category || w.groupName,
        message: w.message || '需要人工修改',
      });
    }
  }

  out = cleanPunctuation(out);
  const after = checkText(out, { words });
  const remaining = after.hits.map((h) => ({
    word: h.word,
    action: h.action,
    category: h.category || h.group,
    message: h.message,
    isPattern: !!h.isPattern,
  }));

  // 只保留改写后仍然存在的未处理词
  const remainingWords = new Set(after.hits.map((h) => h.word));
  const unresolved = unresolvedRaw.filter((u) => remainingWords.has(u.word));

  const blockLeft = after.blocked || remaining.some((h) => h.action === 'block');

  return {
    ok: !blockLeft,
    rewritten: out,
    changes,
    unresolved,
    before,
    after,
    remaining,
    needsReview: changes.some((c) => c.action === 'remove'),
    scene,
  };
}

function templateTriggers(t) {
  if (Array.isArray(t.triggers)) return t.triggers;
  return String(t.triggers ?? '')
    .split(/[\r\n,，|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 整句合规改写：优先使用已审核的行业模板，再走词级替换/删除。
 * 模板只包含合规表达，不生成同音字、符号或零宽变体。
 */
export function rewriteSentence(text, {
  words = [],
  templates = [],
  scene = 'dm',
  industry = '',
} = {}) {
  const raw = String(text ?? '');
  const before = checkText(raw, { words });
  const hadHits = before.hits.length > 0;

  const matched = (templates ?? [])
    .filter((t) => {
      if (t.enabled === 0) return false;
      const scenes = String(t.scene ?? '')
        .split(',').map((s) => s.trim()).filter(Boolean);
      if (scenes.length && !scenes.includes('both') && !scenes.includes(scene)) return false;
      if (industry && t.industry && t.industry !== '通用' && t.industry !== industry) return false;
      return templateTriggers(t).some((w) => raw.includes(w));
    })
    .sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0));

  const tpl = matched[0];
  if (!tpl) {
    if (!hadHits) {
      return {
        ok: true,
        rewritten: raw,
        changes: [],
        unresolved: [],
        before,
        after: before,
        remaining: [],
        needsReview: false,
        method: 'none',
        scene,
      };
    }
    const ruleResult = rewriteText(raw, { words, scene });
    return { ...ruleResult, method: 'rule' };
  }

  // 模板必须是已审核的合规句子；仍然再跑一次词级检查和清理
  const cleaned = rewriteText(String(tpl.templateText ?? ''), { words, scene });
  const after = checkText(cleaned.rewritten, { words });
  const ok = cleaned.ok && !after.blocked;

  return {
    ok,
    rewritten: cleaned.rewritten,
    method: 'template',
    templateId: tpl.id ?? null,
    templateName: tpl.name ?? null,
    industry: tpl.industry ?? null,
    changes: [
      {
        action: 'template',
        word: tpl.name ?? '合规模板',
        matched: matched.flatMap((x) => templateTriggers(x)).find((w) => raw.includes(w)) ?? '',
        to: cleaned.rewritten,
        category: tpl.industry ?? '合规模板',
        basis: tpl.basis ?? null,
        message: '使用已审核的合规整句模板',
      },
      ...(cleaned.changes ?? []),
    ],
    unresolved: cleaned.unresolved,
    before,
    after,
    remaining: cleaned.remaining,
    needsReview: false,
    scene,
  };
}
