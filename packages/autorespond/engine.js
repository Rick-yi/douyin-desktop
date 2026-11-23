/**
 * 自动回复引擎
 *
 * 调研结论（docs/调研-自动回复与敏感词.md）：
 *  1. ★ 必须有 NO_REPLY —— 静默时段、冷却期、转人工时不回复
 *  2. ★ 回复要延迟且随机 —— 秒回是机器人特征
 *  3. ★ 单会话要有次数上限和冷却 —— 最多 3 条 / 5 分钟
 *  4. 三级派发：auto 直接发 / draft 存草稿 / notify 只提醒
 *  5. 发送前必须过敏感词，block 级降级为 draft
 *
 * 决策链：
 *   收到消息 → 静默时段? → 冷却? → 超限? → 转人工词? → 匹配规则?
 *            → 按 level 派发 → 敏感词检查 → 发送/草稿/通知
 */
import { randomUUID } from 'node:crypto';
import { db_ } from '../../apps/main/src/db.js';
import { checkAndRewrite } from '../../apps/main/src/sensitive.js';
import { redact } from '../../apps/main/src/redact.js';
import { getCard } from '../../apps/main/src/card-service.js';

// ══════════════════════════════════════
// 配置
// ══════════════════════════════════════

function getSetting(key, fallback) {
  try {
    const row = db_().prepare('SELECT value FROM setting WHERE key = ?').get(key);
    return row?.value ?? fallback;
  } catch {
    return fallback;
  }
}

export function getConfig() {
  return {
    enabled: getSetting('autoReplyEnabled', '0') === '1',
    // ★ 旧版全局全消息模式：仅兼容老配置，新逻辑走“任意消息”规则
    replyAll: getSetting('autoReplyAll', '0') === '1',
    replySpeedMs: Number(getSetting('replySpeedMs', '1500')),
    replySpeedMs: Number(getSetting('replySpeedMs', '1500')),
    replyJitterMs: Number(getSetting('replyJitterMs', '3000')),
    quietHours: getSetting('quietHours', '0-7'),
    cooldownSec: Number(getSetting('cooldownSec', '300')),
    maxAutoReplyPerConv: Number(getSetting('maxAutoReplyPerConv', '3')),
    defaultReply: getSetting('defaultReply', ''),
    transferKeywords: getSetting('transferKeywords', '人工,客服,投诉,退款'),
    quoteReply: getSetting('quoteReply', '0') === '1',
    transferPauseMin: Number(getSetting('transferPauseMin', '60')),
  };
}

/** 旧版全消息模式未填写兜底话术时使用的安全默认值 */
export const REPLY_ALL_DEFAULT_TEXT = '您好，消息已收到，稍后回复您。';

export function saveConfig(patch) {
  const db = db_();
  const stmt = db.prepare(
    'INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  // ★ 键名映射：入参名 → setting 表的 key
  // 之前这里直接用了入参名当 key，导致写了 'enabled' 但读的是 'autoReplyEnabled'
  const map = {
    enabled: { key: 'autoReplyEnabled', fn: (v) => (v ? '1' : '0') },
    replyAll: { key: 'autoReplyAll', fn: (v) => (v ? '1' : '0') },
    replySpeedMs: { key: 'replySpeedMs', fn: String },
    replyJitterMs: { key: 'replyJitterMs', fn: String },
    quietHours: { key: 'quietHours', fn: String },
    cooldownSec: { key: 'cooldownSec', fn: String },
    maxAutoReplyPerConv: { key: 'maxAutoReplyPerConv', fn: String },
    defaultReply: { key: 'defaultReply', fn: String },
    transferKeywords: { key: 'transferKeywords', fn: String },
    quoteReply: { key: 'quoteReply', fn: (v) => (v ? '1' : '0') },
    transferPauseMin: { key: 'transferPauseMin', fn: String },
  };
  for (const [k, v] of Object.entries(patch)) {
    const m = map[k];
    if (!m) continue;
    stmt.run(m.key, m.fn(v));
  }
  return getConfig();
}

/**
 * 解析静默时段 "0-7" → [0,7)
 */
function parseQuietHours(str) {
  const m = String(str ?? '').match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

export function isQuietTime(cfg = getConfig(), now = new Date()) {
  const range = parseQuietHours(cfg.quietHours);
  if (!range) return false;
  const [start, end] = range;
  const h = now.getHours();
  if (start === end) return false;
  if (start < end) return h >= start && h < end;
  // 跨午夜，如 22-6
  return h >= start || h < end;
}

function dayKey(d = new Date()) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// ══════════════════════════════════════
// 规则匹配
// ══════════════════════════════════════

/**
 * 加载启用的规则
 */
export function loadRules() {
  try {
    return db_()
      .prepare('SELECT * FROM reply_rule WHERE enabled = 1 ORDER BY priority DESC, created_at ASC')
      .all();
  } catch {
    return [];
  }
}

/**
 * 规则是否命中当前作用域（场景 / 账号 / 会话类型）
 */
function ruleInScope(r, scene, context) {
  // 作用域过滤
  const scope = String(r.scope ?? 'dm').split(',').map((s) => s.trim());
  if (scope.length && !scope.includes('both') && !scope.includes(scene)) return false;

  // 账号范围：空 = 所有账号；指定了账号时，未知账号不匹配
  const accounts = String(r.account_ids ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (accounts.length && !accounts.includes(String(context.accountId ?? ''))) return false;

  // 会话类型范围：private|group|stranger
  const chatTypes = String(r.chat_types ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (chatTypes.length && !chatTypes.includes(String(context.chatType ?? 'private'))) {
    return false;
  }
  return true;
}

/** 找到当前账号生效的“任意消息”规则（按 priority DESC, created_at ASC） */
export function findAnyRule(rules, scene = 'dm', context = {}) {
  return (rules ?? []).find(
    (r) => (r.match_type ?? 'contains') === 'any' && ruleInScope(r, scene, context),
  ) ?? null;
}

/** 当前账号是否有“任意消息”规则；用于非文本消息是否进入自动回复 */
export function hasAnyRuleFor(accountId, chatType = 'private', scene = 'dm') {
  try {
    return !!findAnyRule(loadRules(), scene, { accountId, chatType });
  } catch {
    return false;
  }
}

/**
 * 匹配规则
 *
 * 优先级：精确 > 正则 > 包含 > 任意消息（同 match_type 内按 priority）
 *
 * @returns 命中的规则 或 null
 */
export function matchRule(text, rules, scene = 'dm', context = {}) {
  if (!rules?.length) return null;

  const raw = String(text ?? '');
  const lower = raw.toLowerCase();

  const byType = { exact: [], regex: [], contains: [], any: [] };
  for (const r of rules) {
    if (!ruleInScope(r, scene, context)) continue;
    const t = r.match_type ?? 'contains';
    if (byType[t]) byType[t].push(r);
  }

  // 精确匹配
  for (const r of byType.exact) {
    for (const p of String(r.pattern ?? '').split(/[\r\n]+/)) {
      const w = p.trim();
      if (w && (lower === w.toLowerCase())) return r;
    }
  }

  // 正则
  for (const r of byType.regex) {
    try {
      // 支持一行一个正则
      for (const p of String(r.pattern ?? '').split(/[\r\n]+/)) {
        const re = p.trim();
        if (!re) continue;
        if (new RegExp(re, 'i').test(raw)) return r;
      }
    } catch {
      // 正则写错就跳过，不影响其他规则
    }
  }

  // 包含
  for (const r of byType.contains) {
    for (const p of String(r.pattern ?? '').split(/[\r\n]+/)) {
      const w = p.trim();
      if (w && lower.includes(w.toLowerCase())) return r;
    }
  }

  // 任意消息：兜底规则，永远匹配
  if (byType.any.length) return byType.any[0];

  return null;
}

// ══════════════════════════════════════
// 会话状态
// ══════════════════════════════════════

function getSessionState(accountId, peerUid, nowMs = Date.now()) {  const row = db_()
    .prepare('SELECT * FROM reply_session_state WHERE account_id = ? AND peer_uid = ?')
    .get(accountId, peerUid);
  const today = dayKey(new Date(nowMs));
  if (row && row.day_key !== today) {
    // 跨天重置（转人工暂停也一起清掉）
    db_()
      .prepare(
        `UPDATE reply_session_state SET
           auto_reply_count = 0, day_key = ?, transferred = 0,
           paused_until = NULL, last_rule_id = NULL, last_rule_at = NULL
         WHERE account_id = ? AND peer_uid = ?`,
      )
      .run(today, accountId, peerUid);
    return {
      ...row,
      auto_reply_count: 0,
      transferred: 0,
      paused_until: null,
      last_rule_id: null,
      last_rule_at: null,
      day_key: today,
    };
  }
  return row ?? null;
}

/** 当前会话是否已转人工/暂停（用于多消息发送中途停止） */
export function isSessionPaused(accountId, peerUid, nowMs = Date.now()) {
  const state = getSessionState(accountId, peerUid, nowMs);
  if (!state) return false;
  if (Number(state.paused_until) > nowMs) return true;
  if (state.transferred && !Number(state.paused_until)) return true;
  return false;
}

function touchSessionState(
  accountId,
  peerUid,
  {
    increment = false,
    transferred = false,
    nowMs = Date.now(),
    ruleId = null,
    pausedUntil = null,
  } = {},
) {
  const db = db_();
  const existing = db
    .prepare('SELECT * FROM reply_session_state WHERE account_id = ? AND peer_uid = ?')
    .get(accountId, peerUid);

  if (!existing) {
    db.prepare(
      `INSERT INTO reply_session_state
         (account_id, peer_uid, last_auto_reply_at, auto_reply_count, transferred,
          paused_until, last_rule_id, last_rule_at, day_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      accountId,
      peerUid,
      increment ? nowMs : null,
      increment ? 1 : 0,
      transferred ? 1 : 0,
      pausedUntil,
      ruleId,
      increment ? nowMs : null,
      dayKey(new Date(nowMs)),
    );
    return;
  }

  // ★ 必须用传入时间判断跨天，否则单测里注入的时间和真实时钟会打架
  if (existing.day_key !== dayKey(new Date(nowMs))) {
    db.prepare(
      `UPDATE reply_session_state SET
         last_auto_reply_at = ?,
         auto_reply_count = ?,
         transferred = ?,
         paused_until = ?,
         last_rule_id = ?,
         last_rule_at = ?,
         day_key = ?
       WHERE account_id = ? AND peer_uid = ?`,
    ).run(
      increment ? nowMs : null,
      increment ? 1 : 0,
      transferred ? 1 : 0,
      pausedUntil,
      ruleId,
      increment ? nowMs : null,
      dayKey(new Date(nowMs)),
      accountId,
      peerUid,
    );
    return;
  }

  db.prepare(
    `UPDATE reply_session_state SET
       last_auto_reply_at = CASE WHEN ? THEN ? ELSE last_auto_reply_at END,
       auto_reply_count = auto_reply_count + ?,
       transferred = CASE WHEN ? THEN 1 ELSE transferred END,
       paused_until = COALESCE(?, paused_until),
       last_rule_id = COALESCE(?, last_rule_id),
       last_rule_at = CASE WHEN ? THEN ? ELSE last_rule_at END
     WHERE account_id = ? AND peer_uid = ?`,
  ).run(
    increment ? 1 : 0,
    nowMs,
    increment ? 1 : 0,
    transferred ? 1 : 0,
    pausedUntil,
    ruleId,
    increment ? 1 : 0,
    nowMs,
    accountId,
    peerUid,
  );
}

// ══════════════════════════════════════
// 变量替换
// ══════════════════════════════════════

/**
 * 构造模板变量表
 *
 * ★ 中英文键都要有：用户习惯写 {昵称}，代码里也叫 nickname
 */
function buildVars({ peerName, accountName, now = new Date() }) {
  const time = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const date = now.toLocaleDateString('zh-CN');
  const nickname = peerName ?? '';
  const account = accountName ?? '';
  return {
    // 英文键
    nickname,
    peer: nickname,
    account,
    time,
    date,
    remark: '',
    // 中文键（用户更可能这么写）
    '昵称': nickname,
    '对方': nickname,
    '账号': account,
    '时间': time,
    '日期': date,
    '备注': '',
  };
}

export function renderTemplate(text, vars = {}) {
  // ★ 必须支持中文变量名：\w 只匹配 [A-Za-z0-9_]，{昵称} 会漏掉
  // 用 [^}]+ 匹配任意非右花括号内容
  return String(text ?? '').replace(/\{([^{}]+)\}/g, (m, key) => {
    const k = key.trim();
    const v = vars[k];
    return v === undefined || v === null ? m : String(v);
  });
}

// ══════════════════════════════════════
// 主决策
// ══════════════════════════════════════

/**
 * 处理一条入站消息，决定怎么回复
 *
 * @param {object} p
 * @param {string} p.accountId
 * @param {string} p.accountName   我方账号昵称（用于 {账号} 变量）
 * @param {string} p.peerUid
 * @param {string} p.peerName
 * @param {string} p.text          收到的消息
 * @param {string} p.scene         dm | comment
 * @param {Date}   p.now           可注入时间（测试用）
 *
 * @returns {{
 *   action: 'auto_sent'|'draft'|'notify'|'no_reply',
 *   reason: string,
 *   replyText?: string,
 *   delayMs?: number,
 *   ruleId?: string,
 *   ruleName?: string,
 *   score?: number,
 *   silent?: boolean          // true = 不通知用户
 * }}
 */
export function decide({ accountId, accountName, peerUid, peerName, text, scene = 'dm', chatType = 'private', now = new Date() }) {
  const cfg = getConfig();
  const trace = (action, reason, extra = {}) => {
    const { _logText, ...rest } = extra;
    writeLog({
      accountId, peerUid, peerName, triggerText: text,
      action, reason, ...rest,
      replyText: _logText ?? rest.replyText,
    });
    return { action, reason, ...rest };
  };

  // ── 1. 总开关 ──
  if (!cfg.enabled) {
    return trace('no_reply', 'disabled', { silent: true });
  }

  // 旧版全局全消息模式 + 按账号配置的“任意消息”规则
  const rules = loadRules();
  const anyRule = findAnyRule(rules, scene, { accountId, chatType });
  const replyAll = cfg.replyAll || !!anyRule;

  // ── 2. 静默时段（全部消息模式忽略）──
  if (!replyAll && isQuietTime(cfg, now)) {
    return trace('no_reply', `静默时段 ${cfg.quietHours}`, { silent: false });
  }

  // ── 3. 会话状态检查 ──
  const state = getSessionState(accountId, peerUid, now.getTime());

  const pausedUntil = Number(state?.paused_until ?? 0);
  if (pausedUntil > now.getTime()) {
    return trace('no_reply', '已转人工，暂停自动回复中', { silent: true });
  }
  // 老数据没有 paused_until，仍按永久转人工处理
  if (state?.transferred && !pausedUntil) {
    return trace('no_reply', '已转人工，不再自动回复', { silent: true });
  }

  if (!replyAll && state?.last_auto_reply_at) {
    const elapsed = now.getTime() - state.last_auto_reply_at;
    if (elapsed < cfg.cooldownSec * 1000) {
      return trace(
        'no_reply',
        `冷却中（${Math.ceil((cfg.cooldownSec * 1000 - elapsed) / 1000)} 秒后）`,
        { silent: true },
      );
    }
  }

  const pauseMs = Math.max(1, cfg.transferPauseMin) * 60000;
  if (!replyAll && (state?.auto_reply_count ?? 0) >= cfg.maxAutoReplyPerConv) {
    // 超限 → 转人工，默认暂停 60 分钟后自动恢复
    touchSessionState(accountId, peerUid, {
      transferred: true,
      pausedUntil: now.getTime() + pauseMs,
      nowMs: now.getTime(),
    });
    return trace('notify', `同一会话已自动回复 ${state.auto_reply_count} 条，转人工`, {
      silent: false,
    });
  }

  // ── 4. 转人工关键词 ──
  const transferWords = String(cfg.transferKeywords ?? '')
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const w of transferWords) {
    if (text.toLowerCase().includes(w.toLowerCase())) {
      touchSessionState(accountId, peerUid, {
        transferred: true,
        pausedUntil: now.getTime() + pauseMs,
        nowMs: now.getTime(),
      });
      return trace('notify', `命中转人工词「${w}」`, { silent: false });
    }
  }

  // ── 5. 规则匹配 ──
  const rule = matchRule(text, rules, scene, { accountId, chatType });

  // 规则级冷却：同一条规则对同一会话短时间内不重复回复
  const ruleCooldownMs = Math.max(0, Number(rule?.cooldown_sec ?? 0)) * 1000;
  if (
    !replyAll &&
    rule &&
    ruleCooldownMs > 0 &&
    state?.last_rule_id === rule.id &&
    state?.last_rule_at &&
    now.getTime() - state.last_rule_at < ruleCooldownMs
  ) {
    const left = Math.ceil((ruleCooldownMs - (now.getTime() - state.last_rule_at)) / 1000);
    return trace('no_reply', `规则「${rule.name}」冷却中（${left} 秒后）`, {
      ruleId: rule.id,
      ruleName: rule.name,
      silent: true,
    });
  }

  const vars = buildVars({ peerName, accountName, now });
  let items = [];
  let level = '';
  let ruleId = null;
  let ruleName = null;

  const cardLabel = (card) =>
    card?.linkTitle || card?.payload?.title || card?.payload?.name || card?.name || '卡片';
  const cardSnapshot = (card) => (card ? {
    id: card.id,
    kind: card.kind,
    name: card.name,
    linkUrl: card.linkUrl ?? null,
    linkTitle: card.linkTitle ?? null,
    linkDesc: card.linkDesc ?? null,
    linkCoverUrl: card.linkCoverUrl ?? null,
    payload: card.payload ?? null,
  } : null);

  if (rule) {
    ruleId = rule.id;
    ruleName = rule.name;
    level = rule.level ?? 'draft';

    // 新格式：content_json 多消息；旧规则回退到 reply_type/card_id/reply_text
    try {
      const parsed = rule.content_json ? JSON.parse(rule.content_json) : null;
      if (Array.isArray(parsed?.items) && parsed.items.length) {
        items = parsed.items.map((it) => {
          if (it?.kind === 'text') {
            return {
              kind: 'text',
              text: renderTemplate(it.text ?? '', vars),
              delayMs: Math.max(0, Number(it.delayMs) || 0),
            };
          }
          if (it?.kind === 'card' && it.cardId) {
            const card = getCard(it.cardId);
            return {
              kind: 'card',
              cardId: it.cardId,
              cardName: card ? cardLabel(card) : (it.cardName ?? null),
              cardSnapshot: card ? cardSnapshot(card) : (it.cardSnapshot ?? null),
              text: renderTemplate(it.text ?? '', vars),
              delayMs: Math.max(0, Number(it.delayMs) || 0),
              missing: !card,
            };
          }
          return null;
        }).filter(Boolean);
      }
    } catch {}

    if (!items.length) {
      const legacyText = renderTemplate(rule.reply_text, vars);
      if (rule.reply_type === 'card') {
        const card = rule.card_id ? getCard(rule.card_id) : null;
        if (!card) {
          return trace('notify', '规则引用的卡片不存在或已删除', { ruleId, ruleName });
        }
        items = [{
          kind: 'card', cardId: rule.card_id, cardName: cardLabel(card),
          cardSnapshot: cardSnapshot(card),
          text: '', delayMs: 0,
        }];
        if (legacyText?.trim()) {
          items.push({ kind: 'text', text: legacyText, delayMs: 300 });
        }
      } else {
        items = [{ kind: 'text', text: legacyText ?? '', delayMs: 0 }];
      }
    }

    // 命中计数
    try {
      db_()
        .prepare('UPDATE reply_rule SET hit_count = hit_count + 1 WHERE id = ?')
        .run(ruleId);
    } catch {}
  } else {
    // 兜底回复：全部消息模式下直接用兜底话术自动发送
    const fallbackText = String(cfg.defaultReply ?? '').trim()
      || (replyAll ? REPLY_ALL_DEFAULT_TEXT : '');
    const defaultText = renderTemplate(fallbackText, vars);
    items = defaultText?.trim()
      ? [{ kind: 'text', text: defaultText, delayMs: 0 }]
      : [];
    level = items.length ? (replyAll ? 'auto' : 'draft') : 'notify';
  }

  // 校验卡片
  for (const item of items) {
    if (item.kind !== 'card') continue;
    const card = getCard(item.cardId);
    if (!card) {
      return trace('notify', '规则引用的卡片不存在或已删除', { ruleId, ruleName });
    }
    item.cardName = cardLabel(card);
    item.cardSnapshot = item.cardSnapshot || cardSnapshot(card);
  }

  const hasContent = items.some(
    (it) => it.kind === 'card' || (it.text && String(it.text).trim()),
  );
  if (!hasContent) {
    return trace('notify', rule ? '规则无回复内容' : '无匹配规则且未配置兜底回复', {
      ruleId, ruleName,
    });
  }

  // ★ 全部消息模式：即使规则本身设为草稿/仅提醒，也直接自动发送
  if (replyAll) level = 'auto';

  // ── 7. 每条文本/卡片附带文本做合规检查与改写 ──
  let score = 100;
  try {
    for (const item of items) {
      if (!item.text || !String(item.text).trim()) continue;
      const check = checkAndRewrite(item.text, scene, { accountId });
      score = Math.min(score, check.score ?? 100);
      if (check.blocked) {
        const words = (check.before?.hits ?? [])
          .filter((h) => h.action === 'block')
          .map((h) => h.word);
        saveDraft({
          accountId, peerUid, peerName, triggerText: text,
          draftText: item.text, ruleId,
          draftType: item.kind === 'card' ? 'card' : 'text',
          cardId: items.find((x) => x.kind === 'card')?.cardId ?? null,
          cardName: items.find((x) => x.kind === 'card')?.cardName ?? null,
          items,
          reason: `sensitive:${words.join(',')}`,
        });
        return trace('draft', `回复内容含阻断词（${words.join('、')}），已转草稿`, {
          ruleId, ruleName, replyText: item.text, replyType: item.kind,
          cardId: item.cardId ?? null, cardName: item.cardName ?? null,
          items, score,
        });
      }
      item.text = check.text ?? item.text;
    }
  } catch (e) {
    console.error('[autoreply] 合规检查失败', e.message);
  }

  const firstText = items.find((it) => it.text && String(it.text).trim())?.text ?? '';
  const firstCard = items.find((it) => it.kind === 'card') ?? null;
  const replyText = firstText;
  const replyType = firstCard ? 'card' : 'text';
  const cardId = firstCard?.cardId ?? null;
  const cardName = firstCard?.cardName ?? null;
  const logText = items.map((it) => {
    if (it.kind === 'card') {
      return `[卡片] ${it.cardName || ''}${it.text ? ` ${it.text}` : ''}`.trim();
    }
    return it.text;
  }).filter(Boolean).join(' / ');

  // ── 8. 按 level 派发 ──
  const delayMs = cfg.replySpeedMs + Math.random() * cfg.replyJitterMs;
  const payload = { ruleId, ruleName, replyText, replyType, cardId, cardName, items };

  if (level === 'auto') {
    touchSessionState(accountId, peerUid, {
      increment: true,
      ruleId: rule?.id ?? null,
      nowMs: now.getTime(),
    });
    return trace('auto_sent', rule ? `命中规则「${rule.name}」` : '兜底回复', {
      ...payload, delayMs, score,
      quote: cfg.quoteReply && items.length === 1 && items[0].kind === 'text',
      _logText: logText,
    });
  }

  if (level === 'draft') {
    saveDraft({
      accountId, peerUid, peerName, triggerText: text,
      draftText: replyText, ruleId, reason: 'rule_draft',
      draftType: replyType, cardId, cardName,
      items,
    });
    return trace('draft', rule ? `规则「${rule.name}」为草稿模式` : '兜底回复为草稿模式', {
      ...payload, score, _logText: logText,
    });
  }

  // notify
  return trace('notify', rule ? `规则「${rule.name}」仅提醒` : '仅提醒', {
    ...payload, score, _logText: logText,
  });
}

// ══════════════════════════════════════
// 草稿
// ══════════════════════════════════════

export function saveDraft({
  accountId, peerUid, peerName, triggerText, draftText,
  ruleId, reason, draftType = 'text', cardId = null, cardName = null, items = null,
}) {
  const id = randomUUID();
  const contentJson = Array.isArray(items) && items.length
    ? JSON.stringify({ version: 1, items })
    : null;
  db_()
    .prepare(
      `INSERT INTO reply_draft
         (id, account_id, peer_uid, peer_name, trigger_text, draft_text,
          draft_type, card_id, card_name, content_json, content_version,
          rule_id, reason, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'pending', ?)`,
    )
    .run(
      id, accountId, peerUid, peerName ?? null, triggerText ?? null, draftText ?? null,
      draftType, cardId, cardName, contentJson, ruleId ?? null, reason ?? null, Date.now(),
    );
  return id;
}

export function listDrafts({ status = 'pending', accountId, limit = 100 } = {}) {
  const where = ['status = ?'];
  const args = [status];
  if (accountId) { where.push('account_id = ?'); args.push(accountId); }
  return db_()
    .prepare(
      `SELECT * FROM reply_draft WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...args, limit);
}

export function updateDraft(id, { status, draftText }) {
  const sets = [];
  const args = [];
  if (status) { sets.push('status = ?'); args.push(status); }
  if (draftText !== undefined) { sets.push('draft_text = ?'); args.push(draftText); }
  sets.push('handled_at = ?');
  args.push(Date.now());
  args.push(id);
  db_().prepare(`UPDATE reply_draft SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  return { ok: true };
}

/** 一次性忽略待确认草稿；传 accountId 时只忽略该账号 */
export function discardPendingDrafts({ accountId } = {}) {
  const where = ["status = 'pending'"];
  const args = [];
  if (accountId) { where.push('account_id = ?'); args.push(accountId); }
  const r = db_()
    .prepare(`UPDATE reply_draft SET status = 'discarded', handled_at = ? WHERE ${where.join(' AND ')}`)
    .run(Date.now(), ...args);
  return { ok: true, count: r.changes };
}

export function draftCount(accountId = '') {
  try {
    if (accountId) {
      return db_()
        .prepare("SELECT COUNT(*) c FROM reply_draft WHERE status = 'pending' AND account_id = ?")
        .get(accountId).c;
    }
    return db_()
      .prepare("SELECT COUNT(*) c FROM reply_draft WHERE status = 'pending'")
      .get().c;
  } catch {
    return 0;
  }
}

// ══════════════════════════════════════
// 日志
// ══════════════════════════════════════

function writeLog({ accountId, peerUid, peerName, ruleId, ruleName, triggerText, replyText, action, reason, score }) {
  try {
    db_()
      .prepare(
        `INSERT INTO reply_log
           (id, account_id, peer_uid, peer_name, rule_id, rule_name,
            trigger_text, reply_text, action, reason, score, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(), accountId, peerUid ?? null, peerName ?? null,
        ruleId ?? null, ruleName ?? null,
        redact(String(triggerText ?? '').slice(0, 500)),
        redact(String(replyText ?? '').slice(0, 500)),
        action, redact(reason ?? null), score ?? null, Date.now(),
      );
  } catch (e) {
    console.error('[autoreply] 写日志失败', e.message);
  }
}

export function listLogs({ limit = 100, offset = 0, action } = {}) {
  const where = action ? 'WHERE action = ?' : '';
  const args = action ? [action] : [];
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 100));
  const safeOffset = Math.max(0, Number(offset) || 0);
  return db_()
    .prepare(`SELECT * FROM reply_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...args, safeLimit, safeOffset);
}

export function countLogs({ action } = {}) {
  const where = action ? 'WHERE action = ?' : '';
  const args = action ? [action] : [];
  return db_().prepare(`SELECT COUNT(*) c FROM reply_log ${where}`).get(...args).c;
}

export function logStats({ days = 7 } = {}) {
  const since = Date.now() - days * 86400000;
  const db = db_();
  const byAction = db
    .prepare('SELECT action, COUNT(*) c FROM reply_log WHERE created_at >= ? GROUP BY action')
    .all(since);
  const byReason = db
    .prepare(
      `SELECT reason, COUNT(*) c FROM reply_log WHERE created_at >= ? AND action = 'no_reply'
       GROUP BY reason ORDER BY c DESC LIMIT 10`,
    )
    .all(since);
  const topRules = db
    .prepare(
      `SELECT rule_name, COUNT(*) c FROM reply_log
       WHERE created_at >= ? AND rule_name IS NOT NULL
       GROUP BY rule_name ORDER BY c DESC LIMIT 10`,
    )
    .all(since);
  return { byAction, byReason, topRules, days };
}

// ══════════════════════════════════════
// 规则 CRUD
// ══════════════════════════════════════

export function listRules() {
  return db_()
    .prepare('SELECT * FROM reply_rule ORDER BY priority DESC, created_at ASC')
    .all();
}

export function addRule(r) {
  const id = randomUUID();
  db_()
    .prepare(
      `INSERT INTO reply_rule
         (id, name, scope, match_type, pattern, reply_text, reply_type, card_id,
          content_json, content_version,
          level, priority, account_ids, chat_types, cooldown_sec, enabled, hit_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(
      id, r.name ?? '未命名', r.scope ?? 'dm', r.matchType ?? 'contains',
      r.pattern ?? '', r.replyText ?? '',
      r.replyType === 'card' ? 'card' : 'text', r.cardId ?? null,
      Array.isArray(r.items) && r.items.length ? JSON.stringify({ version: 1, items: r.items }) : null,
      r.level ?? 'draft',
      r.priority ?? 0,
      r.accountIds ?? '', r.chatTypes ?? 'private,group,stranger',
      Number(r.cooldownSec) || 0,
      r.enabled === false ? 0 : 1, Date.now(),
    );
  return { id };
}

export function updateRule(id, patch) {
  const map = {
    name: 'name', scope: 'scope', matchType: 'match_type',
    pattern: 'pattern', replyText: 'reply_text',
    replyType: 'reply_type', cardId: 'card_id',
    level: 'level',
    priority: 'priority', accountIds: 'account_ids', chatTypes: 'chat_types',
    cooldownSec: 'cooldown_sec', enabled: 'enabled',
  };
  const sets = [];
  const args = [];
  if (patch.items !== undefined) {
    sets.push('content_json = ?', 'content_version = 1');
    args.push(Array.isArray(patch.items) && patch.items.length
      ? JSON.stringify({ version: 1, items: patch.items })
      : null);
  }
  for (const [k, col] of Object.entries(map)) {
    if (patch[k] === undefined) continue;
    sets.push(`${col} = ?`);
    args.push(k === 'enabled' ? (patch[k] ? 1 : 0) : patch[k]);
  }
  if (!sets.length) return { ok: false };
  args.push(id);
  db_().prepare(`UPDATE reply_rule SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  return { ok: true };
}

export function deleteRule(id) {
  db_().prepare('DELETE FROM reply_rule WHERE id = ?').run(id);
  return { ok: true };
}

export function resetSession(accountId, peerUid) {
  db_()
    .prepare('DELETE FROM reply_session_state WHERE account_id = ? AND peer_uid = ?')
    .run(accountId, peerUid);
  return { ok: true };
}
