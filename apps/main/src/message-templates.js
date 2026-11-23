/**
 * 线索雷达文案库
 *
 * 存在 setting 表，key = interceptMessageTemplates。
 * 默认 5 条为单行消息，避免多行被发送池拆成多条。
 */
import { db_ } from './db.js';

const KEY = 'interceptMessageTemplates';

function normalizeKeywords(value) {
  return (Array.isArray(value) ? value : String(value || '').split(/[,，\s]+/))
    .map((k) => String(k).trim())
    .filter(Boolean);
}

export const DEFAULT_MESSAGE_TEMPLATES = [
  {
    id: 'tpl-matrix',
    name: '矩阵工具',
    keywords: [],
    text: '🚀🔥 黑科技矩阵私信工具，解决没有客户的烦恼！👥 多账号矩阵运营，单人也能跑；📨 单账号按配额发送，矩阵合计私信量可放大；🎯 关键词、同行、直播三路筛线索，客户更精准；📈 引流效果按实测数据看；💬 想测试的老板回复【测试】🙋',
  },
  {
    id: 'tpl-no-customer',
    name: '没客户痛点',
    keywords: [],
    text: '没有客户？😮‍💨 这套黑科技矩阵私信工具帮你解决！🧑‍💻 单人可运营多账号矩阵；📤 私信量按账号配额放大；🔍 关键词、同行视频、直播间三路抓精准客户；📊 引流按实际测试数据评估；👇 需要测试的老板回复【测试】',
  },
  {
    id: 'tpl-three-source',
    name: '三路线索',
    keywords: [],
    text: '🔥 黑科技矩阵私信工具：🧑‍💻 单人可运营矩阵，多账号统一管理；📨 单账号配额发送，矩阵私信量可放大；🎯 三路筛线索，客户更精准；😮‍💨 解决没有客户的烦恼；📈 引流按实测看；✅ 小批量测试回复【测试】',
  },
  {
    id: 'tpl-boss',
    name: '老板您好',
    keywords: [],
    text: '👋 老板您好，做全行业客户开发可以看下：🚀 黑科技矩阵私信 + 多账号管理；🧑‍💻 单人也能运营；📤 私信量按配额放大；🔍 关键词、同行、直播三路找精准客户；🎯 解决没客户的问题；📩 回复【测试】，我发您流程',
  },
  {
    id: 'tpl-short',
    name: '短版',
    keywords: [],
    text: '🚀 黑科技矩阵私信工具：🧑‍💻 单人可运营矩阵；📨 私信量按配额放大；🎯 三路筛精准客户；😮‍💨 解决没有客户的烦恼；📈 引流按实测数据看；🙋‍♂️ 需要测试的老板回复【测试】',
  },
];

export function listMessageTemplates() {
  try {
    const row = db_().prepare('SELECT value FROM setting WHERE key = ?').get(KEY);
    if (row?.value) {
      const parsed = JSON.parse(row.value);
      if (Array.isArray(parsed) && parsed.length) {
        return parsed
          .filter((t) => t && t.id && t.text)
          .map((t) => ({ ...t, keywords: normalizeKeywords(t.keywords) }));
      }
    }
    saveMessageTemplates(DEFAULT_MESSAGE_TEMPLATES);
    return DEFAULT_MESSAGE_TEMPLATES;
  } catch {
    return DEFAULT_MESSAGE_TEMPLATES;
  }
}

export function saveMessageTemplates(list) {
  const clean = (Array.isArray(list) ? list : [])
    .filter((t) => t && t.id && t.text)
    .map((t) => ({
      id: String(t.id),
      name: String(t.name || '未命名'),
      keywords: normalizeKeywords(t.keywords),
      text: String(t.text).slice(0, 500),
    }));
  db_()
    .prepare(
      'INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(KEY, JSON.stringify(clean));
  return clean;
}
