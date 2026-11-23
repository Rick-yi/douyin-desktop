/**
 * 卡片服务
 *
 * 只保留跳转卡（私信里的链接卡片）：
 *   link — DB 存 URL/标题/描述/封面，发送走 sdk.sendLinkCard
 *
 * 历史版本里的图片/作品/名片/文件卡片不再提供创建和发送能力，
 * 旧数据仍留在库里但不会出现在卡片列表和自动回复选择器中。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db_, getDataDir } from './db.js';

function cardsDir() {
  const dir = path.join(getDataDir(), 'cards');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function httpUrl(value, label) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    throw new Error(`${label}不是有效的链接`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${label}必须以 http:// 或 https:// 开头`);
  }
  return url.href;
}

/**
 * 新建一张跳转卡片（私信里可点击、会跳转的链接卡片）
 *
 * 字段对应 SDK 的 LinkCard：
 *   link_url        → 点击后跳转的地址
 *   link_title      → 卡片标题
 *   link_desc       → 卡片描述
 *   link_cover_url  → 卡片封面（必须是公网可访问的 http/https 图片）
 */
export function addLinkCard({ name, groupName, textTpl, url, title, description, coverUrl }) {
  const linkUrl = httpUrl(url, '跳转链接');
  const cover = coverUrl ? httpUrl(coverUrl, '封面图地址') : null;

  const id = randomUUID();
  db_()
    .prepare(
      `INSERT INTO card
         (id, kind, name, group_name, file_path, text_tpl,
          link_url, link_title, link_desc, link_cover_url, use_count, created_at)
       VALUES (?, 'link', ?, ?, '', ?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(
      id,
      name || title || '未命名跳转卡片',
      groupName || '默认',
      textTpl || null,
      linkUrl,
      title || null,
      description || null,
      cover,
      Date.now(),
    );

  return { id, kind: 'link', url: linkUrl, title: title || null, coverUrl: cover };
}

/**
 * 列表：只返回跳转卡
 */
export function listCards({ groupName, keyword } = {}) {
  const where = ["kind = 'link'"];
  const args = [];
  if (groupName) { where.push('group_name = ?'); args.push(groupName); }
  if (keyword) { where.push('name LIKE ?'); args.push(`%${keyword}%`); }

  return db_()
    .prepare(`SELECT * FROM card WHERE ${where.join(' AND ')} ORDER BY created_at DESC`)
    .all(...args)
    .map(rowToCard);
}

export function listCardGroups() {
  return db_()
    .prepare("SELECT group_name, COUNT(*) c FROM card WHERE kind = 'link' GROUP BY group_name ORDER BY group_name")
    .all()
    .map((r) => ({ name: r.group_name, count: r.c }));
}

export function getCard(id) {
  const row = db_().prepare('SELECT * FROM card WHERE id = ?').get(id);
  return row ? rowToCard(row) : null;
}

export function updateCard(id, patch) {
  const map = {
    name: 'name',
    groupName: 'group_name',
    textTpl: 'text_tpl',
    linkTitle: 'link_title',
    linkDesc: 'link_desc',
  };
  const sets = [];
  const args = [];
  for (const [k, col] of Object.entries(map)) {
    if (patch[k] === undefined) continue;
    sets.push(`${col} = ?`);
    args.push(patch[k]);
  }
  if (patch.linkUrl !== undefined) {
    sets.push('link_url = ?');
    args.push(httpUrl(patch.linkUrl, '跳转链接'));
  }
  if (patch.linkCoverUrl !== undefined) {
    sets.push('link_cover_url = ?');
    args.push(patch.linkCoverUrl ? httpUrl(patch.linkCoverUrl, '封面图地址') : null);
  }
  if (!sets.length) return { ok: false };
  args.push(id);
  db_().prepare(`UPDATE card SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  return { ok: true };
}

export function deleteCard(id, { force = false } = {}) {
  const db = db_();
  const row = db.prepare('SELECT * FROM card WHERE id = ?').get(id);
  if (row) {
    // 自动回复规则/草稿可能引用卡片，直接删除会让发送时才报错
    const rules = db
      .prepare(
        `SELECT id, name, reply_text, enabled, card_id, content_json
         FROM reply_rule
         WHERE card_id = ? OR content_json LIKE ?`,
      )
      .all(id, `%${id}%`);
    const drafts = db
      .prepare(
        `SELECT id, draft_text, card_id, content_json
         FROM reply_draft
         WHERE card_id = ? OR content_json LIKE ?`,
      )
      .all(id, `%${id}%`);

    if (rules.length || drafts.length) {
      if (!force) {
        const refs = [
          ...rules.map((r) => `规则「${r.name || r.id}」`),
          ...drafts.map(() => '待确认草稿'),
        ];
        throw new Error(
          `卡片正被 ${refs.slice(0, 3).join('、')} 引用，请先解除引用再删除`,
        );
      }

      const detachItems = (raw) => {
        if (!raw) return null;
        try {
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed?.items)) return raw;
          const kept = parsed.items.filter(
            (it) => String(it?.cardId ?? it?.card_id ?? it?.cardSnapshot?.id ?? '') !== String(id),
          );
          return kept.length ? JSON.stringify({ ...parsed, items: kept }) : null;
        } catch {
          return raw;
        }
      };

      const updateRule = db.prepare(
        'UPDATE reply_rule SET card_id = NULL, content_json = ?, enabled = ? WHERE id = ?',
      );
      for (const r of rules) {
        const content = detachItems(r.content_json);
        const hasText = String(r.reply_text ?? '').trim().length > 0;
        updateRule.run(content, !content && !hasText ? 0 : (r.enabled ? 1 : 0), r.id);
      }

      const updateDraft = db.prepare(
        'UPDATE reply_draft SET card_id = NULL, content_json = ? WHERE id = ?',
      );
      const deleteDraft = db.prepare('DELETE FROM reply_draft WHERE id = ?');
      for (const d of drafts) {
        const content = detachItems(d.content_json);
        const hasText = String(d.draft_text ?? '').trim().length > 0;
        if (!content && !hasText) deleteDraft.run(d.id);
        else updateDraft.run(content, d.id);
      }
    }
    // 兼容旧版本留下的图片/文件卡片
    if (row.file_path) {
      try {
        fs.unlinkSync(path.join(cardsDir(), row.file_path));
      } catch {}
    }
    db.prepare('DELETE FROM card WHERE id = ?').run(id);
  }
  return { ok: true };
}

export function bumpCardUse(id) {
  db_().prepare('UPDATE card SET use_count = use_count + 1 WHERE id = ?').run(id);
}


function rowToCard(r) {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    groupName: r.group_name,
    textTpl: r.text_tpl,
    linkUrl: r.link_url ?? null,
    linkTitle: r.link_title ?? null,
    linkDesc: r.link_desc ?? null,
    linkCoverUrl: r.link_cover_url ?? null,
    useCount: r.use_count,
    createdAt: r.created_at,
  };
}

/** 按卡片对象发送（自动回复快照兜底也走这里） */
export async function sendCardObject(sdk, peerUid, card) {
  if (!card) throw new Error('卡片不存在');
  if (card.kind !== 'link') throw new Error('只支持跳转卡片');
  return sdk.sendLinkCard(peerUid, {
    url: card.linkUrl,
    title: card.linkTitle ?? '',
    description: card.linkDesc ?? '',
    coverUrl: card.linkCoverUrl ?? '',
  });
}

/** 按卡片 ID 调用 SDK 发送（自动回复/草稿/卡片页共用） */
export async function sendCardMessage(sdk, peerUid, cardId) {
  const card = getCard(cardId);
  if (!card) throw new Error('卡片不存在');
  return sendCardObject(sdk, peerUid, card);
}

export { cardsDir };
