/**
 * 敏感词引擎
 *
 * 调研结论（见 docs/调研-敏感词.md）：
 *  1. 不需要 DFA —— 词库 <500，includes 足够（V8 原生方法更快）
 *  2. 必须做变体归一化 —— "微.信" / "微 信" / "薇信" 要能识别
 *  3. 只有多字词做忽略字符匹配，单字词精确匹配（否则"微"会命中"微风"）
 *  4. 风险评分比二元判断有用（100 分制，高危 -20 / 中危 -10 / 低危 -5）
 */

/**
 * 归一化：去掉用户用来绕过的干扰字符
 *
 * 注意：归一化后的位置与原文不对应，所以只报「命中什么词」，
 * 不报「在第几位命中」。
 */
export function normalize(text) {
  if (!text) return '';
  return String(text)
    // 全角 → 半角
    .replace(/[\uff01-\uff5e]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0),
    )
    // 全角空格
    .replace(/\u3000/g, '')
    // 删除常见干扰符号（用户插入用来绕过检测的）
    .replace(/[\s.\-—_*·•~`!@#$%^&()（）【】\[\]{}<>《》/\\|,，。、:：;；'"“”‘’+＋]/g, '')
    // 统一小写
    .toLowerCase();
}

/**
 * 检测单个词是否命中
 *
 * ★ 关键：单字词必须精确匹配，否则会大量误判
 *   例：词库有"微"，则"微风"不该命中
 */
function hitWord(normalizedText, rawText, word) {
  if (!word) return false;

  // ★ 单字词不支持（重要设计决策）
  //
  // 中文没有词边界，单字词必然误判：
  //   词库有"微" → "微风" 命中（误判），但 "加微" 也该命中（正确）
  //   两者无法用规则区分，只能靠分词（引入词典，代价太大）
  //
  // 所以：词条要求 >= 2 字，单字直接跳过。
  // 若确实需要拦截某个字，请用"加微"这类组合词。
  if (word.length < 2) return false;

  // 多字词：归一化后匹配
  const w = normalize(word);
  if (!w) return false;
  return normalizedText.includes(w);
}

/**
 * ★ 正则规则：识别「结构型」导流
 *
 * 为什么需要这一层：
 *   归一化会删除冒号、空格等符号，导致"薇：abc123"变成"薇abc123"，
 *   而"薇"是单字（不支持），所以词库匹配不到。
 *   这类靠「模式」而不是「词」的风险，必须用正则。
 *
 * 注意：正则跑在**原文**上，不归一化。
 */
export const PATTERN_RULES = [
  {
    id: 'p-wechat-id',
    name: '微信号（中文前缀）',
    re: /(?:微信|薇|威|微|v|V|vx|VX|wx|WX)\s*[：:]\s*[a-zA-Z][a-zA-Z0-9_-]{4,}/g,
    action: 'block',
    severity: 3,
    message: '疑似微信/QQ 号（冒号+ID 结构）',
  },
  {
    id: 'p-wechat-id2',
    name: '微信号（加/私 前缀）',
    re: /(?:加|私|联系)\s*(?:我|你)?\s*(?:微信|薇|v|V|vx|VX)\s*[：:]?\s*[a-zA-Z][a-zA-Z0-9_-]{4,}/g,
    action: 'block',
    severity: 3,
    message: '疑似引导加联系方式',
  },
  {
    id: 'p-phone',
    name: '手机号',
    re: /(?:1[3-9]\d{9})/g,
    action: 'block',
    severity: 3,
    message: '疑似手机号',
  },
  {
    id: 'p-phone-spaced',
    name: '手机号（带分隔）',
    re: /1[3-9]\d[\s\-]?\d{4}[\s\-]?\d{4}/g,
    action: 'block',
    severity: 3,
    message: '疑似手机号（带分隔符）',
  },
  {
    id: 'p-email',
    name: '邮箱',
    re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    action: 'block',
    severity: 2,
    message: '疑似邮箱地址',
  },
  {
    id: 'p-url',
    name: '站外链接',
    re: /(?:https?:\/\/|www\.)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    action: 'warn',
    severity: 2,
    message: '包含站外链接',
  },
];

/**
 * 跑正则规则（原文匹配）
 */
export function checkPatterns(rawText) {
  const hits = [];
  if (!rawText) return hits;

  for (const rule of PATTERN_RULES) {
    rule.re.lastIndex = 0;
    const m = rule.re.exec(rawText);
    if (!m) continue;

    // 同一规则只报一次（避免长文本重复计数）
    hits.push({
      wordId: rule.id,
      word: String(m[0]).slice(0, 40),
      matched: String(m[0]),
      action: rule.action,
      severity: rule.severity,
      replaceTo: null,
      group: '正则规则',
      message: rule.message,
      isPattern: true,
    });
  }
  return hits;
}

/**
 * 检查文本
 *
 * @param {string} text 待检查文本
 * @param {object} opts
 * @param {string[]} opts.words 词库（已过滤作用域）
 * @param {boolean} opts.withScore 是否计算评分
 *
 * @returns {{
 *   hits: Array<{word, action, severity, replaceTo, group}>,
 *   blocked: boolean,
 *   score: number,
 *   level: 'safe'|'risk'|'danger',
 *   replaced: string
 * }}
 */
export function checkText(text, { words = [], withScore = true } = {}) {
  const raw = String(text ?? '');
  if (!raw) {
    return { hits: [], blocked: false, score: 100, level: 'safe', replaced: raw };
  }

  const normalized = normalize(raw);
  const hits = [];
  const seen = new Set();

  // ── 先跑正则规则（识别结构型导流）──
  const patternHits = checkPatterns(raw);
  for (const h of patternHits) {
    hits.push(h);
    seen.add(h.wordId);
  }
  let replaced = raw;
  let blocked = false;
  let score = 100;

  for (const w of words) {
    if (!w?.word || !w.enabled) continue;
    if (seen.has(w.word)) continue;

    if (!hitWord(normalized, raw, w.word)) continue;

    seen.add(w.word);
    hits.push({
      wordId: w.id,
      word: w.word,
      action: w.action,
      severity: w.severity ?? 2,
      replaceTo: w.replace_to ?? null,
      group: w.groupName ?? null,
      message: w.message ?? null,
    });

    if (w.action === 'block') {
      blocked = true;
    } else if (w.action === 'replace' && w.replace_to) {
      // 替换要针对原文做（不能对归一化文本做，否则会破坏原文）
      const re = new RegExp(escapeRe(w.word), 'gi');
      replaced = replaced.replace(re, w.replace_to);
    }
  }

  // 正则规则的阻断
  for (const h of patternHits) {
    if (h.action === 'block') blocked = true;
  }

  // ★ 扣分策略：按「最高严重度」只扣一次，不按命中条数累加
  //
  // 原因：一句话"加我VX：abc123"会同时命中 4 个规则，
  // 按条累加会扣到 20 分，明显过重，用户会失去对分数的信任。
  // 改成：本次最高危的那个命中扣一次分，其余命中只展示不扣分。
  if (withScore) {
    let maxSeverity = 0;
    for (const h of hits) {
      const sev = h.severity ?? 2;
      if (sev > maxSeverity) maxSeverity = sev;
    }
    score -= maxSeverity >= 3 ? 20 : maxSeverity === 2 ? 10 : maxSeverity === 1 ? 5 : 0;
  }

  score = Math.max(0, Math.min(100, score));
  const level = score >= 90 ? 'safe' : score >= 60 ? 'risk' : 'danger';

  return { hits, blocked, score, level, replaced };
}

/**
 * 兼容旧接口（apps/main/src/sensitive.js 在用）
 */
export function checkSensitive(text, scene, words) {
  const filtered = words.filter(
    (w) => !w.scope?.length || w.scope.includes(scene),
  );
  const r = checkText(text, { words: filtered });
  return {
    blocked: r.blocked,
    hits: r.hits,
    replaced: r.replaced,
    score: r.score,
    level: r.level,
  };
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ══════════════════════════════════════════════
// 内置词库（按《广告法》条文和抖音公开规则整理）
// severity: 3 高危 / 2 中危 / 1 低危
// action:   block 硬拦 / warn 警告 / replace 替换
// ══════════════════════════════════════════════

export const BUILTIN_GROUPS = [
  { id: 'g-diversion-strong', name: '导流-强（封号高危）', sort: 0, desc: '抖音明确禁止，发出去极易封号' },
  { id: 'g-diversion-weak', name: '导流-弱（营销嫌疑）', sort: 1, desc: '引导站外的暗示性表达' },
  { id: 'g-competitor', name: '竞品平台', sort: 2, desc: '提及其他电商或内容平台' },
  { id: 'g-ad-extreme', name: '广告法-极限词', sort: 3, desc: '《广告法》第九条禁止的绝对化用语' },
  { id: 'g-ad-absolute', name: '广告法-绝对化', sort: 4, desc: '绝对化承诺，容易被认定虚假宣传' },
  { id: 'g-efficacy', name: '功效违规', sort: 5, desc: '医疗/功效类过度承诺' },
  { id: 'g-high-risk', name: '高风险活动', sort: 6, desc: '涉嫌诈骗、违规服务' },
  { id: 'g-minor', name: '未成年保护', sort: 7, desc: '涉及未成年人的不当营销' },
];

export const BUILTIN_WORDS = [
  // ── 导流-强（阻断）──
  { group: 'g-diversion-strong', words: ['微信', '威信', '薇信', '危信', 'v信', 'vx', '微x', '加我', '加微', '私聊加', '扣扣', 'qq号'], action: 'block', severity: 3 },
  { group: 'g-diversion-strong', words: ['二维码', '扫码加', '手机号', '电话号码', '联系方式'], action: 'block', severity: 3, scope: 'dm,comment' },
  // ── 导流-弱（警告）──
  { group: 'g-diversion-weak', words: ['私聊', '主页有', '看简介', '上车', '橱窗', '链接在', '点击下方'], action: 'warn', severity: 2 },
  // ── 竞品平台（警告）──
  { group: 'g-competitor', words: ['淘宝', '天猫', '京东', '拼多多', '快手', '小红书', '咸鱼', '闲鱼'], action: 'warn', severity: 2 },
  // ── 广告法-极限词（警告）──
  { group: 'g-ad-extreme', words: ['最好', '最佳', '最强', '最优', '第一', '首个', '首选', '独家', '顶级', '顶尖', '国家级', '世界级', '全球级', '绝无仅有', '史无前例', '独一无二', '万能', '冠军', '销量第一', '销量冠军', '抄底价', '天王级'], action: 'warn', severity: 2 },
  // ── 广告法-绝对化（警告）──
  { group: 'g-ad-absolute', words: ['100%', '百分百', '绝对', '永久', '完全', '彻底', '无效退款', '保证有效', '包过', '必赚', '稳赚'], action: 'warn', severity: 2 },
  // ── 功效违规（阻断）──
  { group: 'g-efficacy', words: ['治愈', '根治', '根除', '不反弹', '包治', '药到病除', '治疗'], action: 'block', severity: 3 },
  // ── 高风险活动（阻断）──
  { group: 'g-high-risk', words: ['刷单', '刷量', '代练', '套现', '高仿', '复刻', 'A货', '原单', '洗钱', '博彩'], action: 'block', severity: 3 },
  // ── 未成年保护（阻断）──
  { group: 'g-minor', words: ['未成年', '早恋', '萝莉', '正太'], action: 'block', severity: 3 },
];

/** 展开成扁平词条列表（供初始化数据库用） */
export function expandBuiltinWords() {
  const out = [];
  for (const item of BUILTIN_WORDS) {
    for (const word of item.words) {
      out.push({
        groupId: item.group,
        word,
        action: item.action,
        severity: item.severity,
        scope: item.scope ?? 'dm,comment,broadcast,intercept',
      });
    }
  }
  return out;
}
