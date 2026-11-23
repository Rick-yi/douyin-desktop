/**
 * 消息类型识别与展示元数据解析
 *
 * SDK 的历史消息 messageType 经常为空，只能靠 content 的 JSON 结构判断；
 * 实时消息虽然带 messageType，但富消息的媒体地址仍要从 raw content 里取。
 * 这里集中处理，避免主进程和渲染层各写一套。
 */

const HTTP_URL = /^https?:\/\//i;
const URL_KEYS = [
  'origin_url_list',
  'large_url_list',
  'medium_url_list',
  'thumb_url_list',
  'url_list',
  'urls',
  'url',
  'uri',
  'src',
  'cover_url',
  'cover',
  'avatar',
];

export function firstUrl(value, depth = 0) {
  if (!value || depth > 4) return null;
  if (typeof value === 'string') return HTTP_URL.test(value) ? value : null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const u = firstUrl(item, depth + 1);
      if (u) return u;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  for (const key of URL_KEYS) {
    if (key in value) {
      const u = firstUrl(value[key], depth + 1);
      if (u) return u;
    }
  }
  for (const item of Object.values(value)) {
    if (item && typeof item === 'object') {
      const u = firstUrl(item, depth + 1);
      if (u) return u;
    }
  }
  return null;
}

function parseJson(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 判断消息类型。
 *
 * 注意：SDK 里 messageType=8 是作品分享，不是表情；表情是 5。
 * 这个映射和 douyin-im 的 parseMessageContent 保持一致。
 */
export function detectKind(messageType, content) {
  const byType = {
    1: 'text',
    2: 'image',
    3: 'image',
    5: 'emoji',
    6: 'file',
    7: 'text',
    8: 'share',
    16: 'comment',
    17: 'audio',
    25: 'user',
    26: 'link',
    27: 'image',
    30: 'video',
    75: 'comment',
    77: 'share',
    105: 'comment',
    50001: 'system',
    50002: 'system',
  };
  if (byType[messageType]) return byType[messageType];

  const j = parseJson(content);
  if (!j) return typeof content === 'string' && content.trim() ? 'text' : 'unknown';

  // 卡片类优先，避免被 text 字段误判
  if (j.link_url || (j.title && j.desc && j.cover_url)) return 'link';
  if (j.comment_id || j.comment_user_name || (j.comment && j.itemId)) return 'comment';
  if (j.itemId || j.aweme_id || j.content_title || j.content_name) return 'share';
  if (j.uid && j.name && (j.avatar || j.secUID)) return 'user';
  if (j.name && (j.uri || j.md5 || j.data_size)) return 'file';
  if (
    j.anchor_info ||
    j.awemeType ||
    (j.related_share_video && Object.keys(j.related_share_video).length)
  ) {
    return 'share';
  }

  const video = j.video && typeof j.video === 'object' ? j.video : null;
  if (video) return 'video';

  const imageLike =
    j.image ||
    j.resource_url ||
    j.origin_url_list ||
    j.large_url_list ||
    j.medium_url_list ||
    j.thumb_url_list ||
    j.url_list;
  if (imageLike) return 'image';

  if (Number(j.aweType ?? j.awe_type ?? 0) === 507) return 'emoji';

  if (j.is_system_type || j.im_dynamic_patch || j.activity_schema || j.activity_desc) {
    return 'system';
  }

  if (typeof j.text === 'string') return 'text';
  if (j.url || j.uri || j.cover_url) return 'image';
  if ('text' in j || 'content' in j) return 'text';
  return 'system';
}

/**
 * 从原始 content 中解析展示所需字段。
 * 返回对象字段会直接给渲染层用，不包含任何可执行内容。
 */
export function parseMessageMeta(rawContent, kind) {
  const j = parseJson(rawContent);
  if (!j) return {};

  if (kind === 'image') {
    const image = j.image && typeof j.image === 'object' ? j.image : j;
    const src = image.resource_url && typeof image.resource_url === 'object'
      ? image.resource_url
      : image;
    return {
      url: firstUrl(src) || firstUrl(j),
      width: num(src.width ?? j.cover_width),
      height: num(src.height ?? j.cover_height),
    };
  }

  if (kind === 'video') {
    const video = j.video && typeof j.video === 'object' ? j.video : j;
    return {
      url: firstUrl(video.play_addr) || firstUrl(video.url) || firstUrl(video),
      coverUrl: firstUrl(j.poster) || firstUrl(j.cover_url) || firstUrl(j.cover),
      width: num(video.width ?? j.width),
      height: num(video.height ?? j.height),
    };
  }

  if (kind === 'emoji') {
    const url = j.url;
    return {
      url: typeof url === 'string' ? url : firstUrl(url),
      name: String(j.display_name ?? ''),
    };
  }

  if (kind === 'link') {
    return {
      url: String(j.link_url ?? j.url ?? ''),
      title: String(j.title ?? j.content_title ?? ''),
      description: String(j.desc ?? j.description ?? ''),
      coverUrl: firstUrl(j.cover_url) || firstUrl(j.cover),
    };
  }

  if (kind === 'user') {
    return {
      uid: String(j.uid ?? ''),
      secUid: String(j.secUID ?? j.sec_uid ?? ''),
      name: String(j.name ?? ''),
      avatarUrl: firstUrl(j.avatar),
    };
  }

  if (kind === 'share') {
    const related = j.related_share_video && typeof j.related_share_video === 'object'
      ? j.related_share_video
      : {};
    const anchor = j.anchor_info && typeof j.anchor_info === 'object' ? j.anchor_info : {};
    return {
      itemId: String(j.itemId ?? j.aweme_id ?? related.aweme_id ?? anchor.aweme_id ?? ''),
      title: String(
        j.content_title ?? j.title ?? j.desc ?? related.desc ?? anchor.desc ?? anchor.title ?? '',
      ),
      authorUid: String(j.uid ?? related.author_id ?? anchor.author_id ?? ''),
      authorSecUid: String(j.secUID ?? ''),
      coverUrl: firstUrl(j.cover_url) || firstUrl(related.cover) || firstUrl(anchor.cover),
    };
  }

  if (kind === 'comment') {
    return {
      workId: String(j.itemId ?? j.aweme_id ?? ''),
      commentId: String(j.comment_id ?? ''),
      authorName: String(j.comment_user_name ?? ''),
      coverUrl: firstUrl(j.cover_url),
      text: String(j.comment ?? j.text ?? ''),
    };
  }

  if (kind === 'file') {
    return {
      name: String(j.name ?? ''),
      fileSize: num(j.data_size) ?? 0,
      uri: String(j.uri ?? ''),
    };
  }

  if (kind === 'system') {
    return {
      description: String(j.description ?? j.desc ?? j.activity_desc ?? ''),
    };
  }

  // card 是旧数据里的兜底类型，尽量再细分一次
  if (kind === 'card') {
    if (j.link_url) return parseMessageMeta(rawContent, 'link');
    if (j.comment_id) return parseMessageMeta(rawContent, 'comment');
    if (j.uid && j.name) return parseMessageMeta(rawContent, 'user');
    if (j.name && j.uri) return parseMessageMeta(rawContent, 'file');
    if (j.anchor_info || j.awemeType) return parseMessageMeta(rawContent, 'share');
  }

  return {};
}

/** 会话列表里显示的最后一条消息摘要 */
export function messagePreview(kind, text, meta = {}) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  switch (kind) {
    case 'image':
      return t && t !== '[图片]' ? `[图片] ${t}` : '[图片]';
    case 'video':
      return '[视频]';
    case 'emoji':
      return t && t !== '[表情]' ? `[表情] ${t}` : '[表情]';
    case 'file':
      return `[文件] ${meta.name || t || ''}`.trim();
    case 'link':
      return `[链接] ${meta.title || t || ''}`.trim();
    case 'share':
      return `[作品] ${meta.title || t || ''}`.trim();
    case 'comment':
      return `[评论] ${meta.text || t || ''}`.trim();
    case 'user':
      return `[名片] ${meta.name || t || ''}`.trim();
    case 'system':
      return t || '[系统消息]';
    default:
      return t || '[消息]';
  }
}
