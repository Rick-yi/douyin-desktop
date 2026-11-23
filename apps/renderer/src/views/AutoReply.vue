<script setup>
import { api } from '../api.js';
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { openChat } from '../nav.js';
import SensitivePrecheck from '../components/SensitivePrecheck.vue';

const props = defineProps({
  accounts: { type: Array, default: () => [] },
});

const tab = ref('settings'); // settings | rules | drafts | logs
const cfg = ref(null);
const rules = ref([]);
const drafts = ref([]);
const draftAccountId = ref('');
const logs = ref([]);
const logPage = ref(1);
const logPageSize = ref(50);
const logTotal = ref(0);
const logPageCount = computed(() => Math.max(1, Math.ceil(logTotal.value / logPageSize.value)));
const discardingAll = ref(false);
const stats = ref(null);
const cards = ref([]);
const emojiOpen = ref(false);
const multiMode = ref(false);
const dragIndex = ref(-1);
const saving = ref(false);
const unsubs = [];
let timer = null;

const EMOJIS = [
  '😀', '😁', '😂', '🤣', '😊', '😍', '🤔', '😎', '😭', '😡',
  '👍', '👏', '🙏', '💪', '🔥', '🎉', '❤️', '💔', '✅', '❌',
  '⭐', '💰', '📞', '📱', '🚗', '🏠', '📄', '🤝', '👌', '🫶',
];

// 规则编辑
const dialogVisible = ref(false);
const editing = ref(null);
const form = ref(emptyRule());

// 测试
const testText = ref('这个多少钱');

function emptyRule() {
  return {
    name: '',
    scope: 'dm',
    matchType: 'contains',
    pattern: '',
    replyText: '',
    replyType: 'text',
    cardId: '',
    items: [],
    level: 'draft',
    priority: 0,
    accountIds: '',
    chatTypes: 'private,group,stranger',
    cooldownSec: 0,
    enabled: true,
  };
}

const CHAT_TYPES = [
  { v: 'private', t: '好友' },
  { v: 'group', t: '群聊' },
  { v: 'stranger', t: '陌生人' },
];

function chatTypeList(value) {
  return String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

function toggleChatType(formRef, type) {
  const set = new Set(chatTypeList(formRef.chatTypes));
  if (set.has(type)) set.delete(type);
  else set.add(type);
  formRef.chatTypes = [...set].join(',');
}

function toggleAccount(formRef, id) {
  const set = new Set(chatTypeList(formRef.accountIds));
  if (set.has(id)) set.delete(id);
  else set.add(id);
  formRef.accountIds = [...set].join(',');
}

function accountLabel(id) {
  return props.accounts.find((a) => a.id === id)?.nickname || id;
}

// ── 加载 ──
async function loadConfig() {
  try {
    cfg.value = await api.ar.getConfig();
  } catch (e) {
    ElMessage.error('加载配置失败');
  }
}

async function loadRules() {
  try {
    rules.value = await api.ar.listRules();
  } catch (e) {
    ElMessage.error('加载规则失败');
  }
}

async function loadCards() {
  try {
    cards.value = await api.card.list();
  } catch {
    cards.value = [];
  }
}

const CARD_KIND_LABEL = {
  link: '跳转卡',
};

function cardKindLabel(kind) {
  return CARD_KIND_LABEL[kind] || '卡片';
}

function cardDisplayName(c) {
  return c?.linkTitle || c?.name || c?.id || '未命名卡片';
}

function cardRuleLabel(r) {
  const c = cards.value.find((x) => x.id === r.card_id);
  return c ? `[${cardKindLabel(c.kind)}] ${cardDisplayName(c)}` : '[卡片] 已删除';
}

function appendEmoji(e) {
  form.value.replyText = `${form.value.replyText || ''}${e}`;
  emojiOpen.value = false;
}

function cardById(id) {
  return cards.value.find((x) => x.id === id) || null;
}

function cardPreviewImage(c) {
  return c?.linkCoverUrl || '';
}

function snapshotCardForUi(c) {
  if (!c) return null;
  return {
    id: c.id,
    kind: c.kind,
    name: c.name,
    linkUrl: c.linkUrl ?? null,
    linkTitle: c.linkTitle ?? null,
    linkDesc: c.linkDesc ?? null,
    linkCoverUrl: c.linkCoverUrl ?? null,
  };
}

function newItem(kind) {
  return kind === 'card'
    ? { kind: 'card', cardId: '', text: '', delayMs: 300 }
    : { kind: 'text', text: '', delayMs: 300 };
}

function addItem(kind) {
  form.value.items = [...(form.value.items || []), newItem(kind)];
}

function removeItem(index) {
  form.value.items = (form.value.items || []).filter((_, i) => i !== index);
}

function moveItem(index, dir) {
  const list = [...(form.value.items || [])];
  const next = index + dir;
  if (next < 0 || next >= list.length) return;
  [list[index], list[next]] = [list[next], list[index]];
  form.value.items = list;
}

function onDragStart(index) {
  dragIndex.value = index;
}

function onDropItem(index) {
  const from = dragIndex.value;
  dragIndex.value = -1;
  if (from < 0 || from === index) return;
  const list = [...(form.value.items || [])];
  const [moved] = list.splice(from, 1);
  list.splice(index, 0, moved);
  form.value.items = list;
}

function appendEmojiTo(item, e) {
  item.text = `${item.text || ''}${e}`;
}

function parseItems(json) {
  try {
    const parsed = json ? JSON.parse(json) : null;
    return Array.isArray(parsed?.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

function ruleItemCount(r) {
  return parseItems(r.content_json).length;
}

function ruleContentLabel(r) {
  const items = parseItems(r.content_json);
  if (items.length > 1) return `${items.length} 条消息`;
  if (items.length === 1) {
    const it = items[0];
    if (it.kind === 'card') return `[卡片] ${it.cardName || cardById(it.cardId)?.name || ''}`;
    return it.text || '';
  }
  return r.reply_type === 'card' ? cardRuleLabel(r) : r.reply_text;
}

function draftItems(d) {
  return parseItems(d.content_json);
}

async function loadDrafts() {
  try {
    drafts.value = await api.ar.listDrafts({
      status: 'pending',
      accountId: draftAccountId.value || undefined,
      limit: 1000,
    });
  } catch {}
}

async function loadLogs({ resetPage = false } = {}) {
  if (resetPage) logPage.value = 1;
  try {
    const [l, totalRes, s] = await Promise.all([
      api.ar.listLogs({
        limit: logPageSize.value,
        offset: (logPage.value - 1) * logPageSize.value,
      }),
      api.ar.logCount(),
      api.ar.stats({ days: 7 }),
    ]);
    logTotal.value = Number(totalRes?.count) || 0;
    // 数据变少时回到最后一页，避免停在空页
    if (logPage.value > logPageCount.value) {
      logPage.value = logPageCount.value;
      return loadLogs();
    }
    logs.value = l;
    stats.value = s;
  } catch {}
}

// ── 配置保存 ──
async function saveCfg() {
  saving.value = true;
  try {
    cfg.value = await api.ar.saveConfig({
      enabled: cfg.value.enabled,
      replyAll: cfg.value.replyAll,
      replySpeedMs: cfg.value.replySpeedMs,
      replyJitterMs: cfg.value.replyJitterMs,
      quietHours: cfg.value.quietHours,
      cooldownSec: cfg.value.cooldownSec,
      maxAutoReplyPerConv: cfg.value.maxAutoReplyPerConv,
      defaultReply: cfg.value.defaultReply,
      transferKeywords: cfg.value.transferKeywords,
      quoteReply: cfg.value.quoteReply,
      transferPauseMin: cfg.value.transferPauseMin,
    });
    ElMessage.success('已保存');
  } catch (e) {
    ElMessage.error(e.message || '保存失败');
  } finally {
    saving.value = false;
  }
}

// ── 规则操作 ──
async function disableLegacyReplyAll() {
  saving.value = true;
  try {
    cfg.value = await api.ar.saveConfig({ replyAll: false });
    ElMessage.success('已关闭旧版全消息模式');
  } catch (e) {
    ElMessage.error(e.message || '关闭失败');
  } finally {
    saving.value = false;
  }
}
function openAdd() {
  editing.value = null;
  form.value = emptyRule();
  emojiOpen.value = false;
  multiMode.value = false;
  loadCards();
  dialogVisible.value = true;
}

function openEdit(r) {
  editing.value = r;
  const storedItems = parseItems(r.content_json);
  multiMode.value = storedItems.length > 1;
  form.value = {
    name: r.name,
    scope: r.scope,
    matchType: r.match_type,
    pattern: r.pattern,
    replyText: r.reply_text ?? '',
    replyType: r.reply_type === 'card' ? 'card' : 'text',
    cardId: r.card_id ?? '',
    items: storedItems.map((it) => ({
      kind: it.kind === 'card' ? 'card' : 'text',
      cardId: it.cardId ?? '',
      cardName: it.cardName ?? '',
      text: it.text ?? '',
      delayMs: Number(it.delayMs) || 0,
    })),
    level: r.level,
    priority: r.priority,
    accountIds: r.account_ids ?? '',
    chatTypes: r.chat_types ?? 'private,group,stranger',
    cooldownSec: r.cooldown_sec ?? 0,
    enabled: !!r.enabled,
  };
  emojiOpen.value = false;
  loadCards();
  dialogVisible.value = true;
}

async function submitRule() {
  if (!form.value.name.trim()) { ElMessage.error('请填写规则名称'); return; }
  if (form.value.matchType !== 'any' && !form.value.pattern.trim()) {
    ElMessage.error('请填写匹配关键词');
    return;
  }

  let payload = { ...form.value };
  if (form.value.matchType === 'any') {
    payload.pattern = '';
    payload.level = 'auto';
  }
  if (multiMode.value) {
    const items = (form.value.items || [])
      .map((it) => ({
        kind: it.kind === 'card' ? 'card' : 'text',
        cardId: it.kind === 'card' ? (it.cardId || '') : undefined,
        cardName: it.kind === 'card' ? (it.cardName || cardById(it.cardId)?.name || '') : undefined,
        cardSnapshot: it.kind === 'card'
          ? (it.cardSnapshot || snapshotCardForUi(cardById(it.cardId)))
          : undefined,
        text: it.text ?? '',
        delayMs: Math.max(0, Number(it.delayMs) || 0),
      }))
      .filter((it) => it.kind === 'card' || String(it.text).trim());
    if (!items.length) { ElMessage.error('至少添加一条消息'); return; }
    const missingCard = items.find((it) => it.kind === 'card' && !it.cardId);
    if (missingCard) { ElMessage.error('请为卡片消息选择卡片'); return; }
    const firstCard = items.find((it) => it.kind === 'card');
    const firstText = items.find((it) => it.kind === 'text' && String(it.text).trim());
    payload.items = items;
    payload.replyType = firstCard ? 'card' : 'text';
    payload.cardId = firstCard?.cardId || '';
    payload.replyText = firstText?.text || '';
  } else {
    if (form.value.replyType === 'card') {
      if (!form.value.cardId) { ElMessage.error('请选择一张卡片'); return; }
    } else if (!form.value.replyText.trim()) {
      ElMessage.error('请填写回复内容');
      return;
    }
    // 关闭多消息时清空旧组合，回退到单消息
    payload.items = [];
  }

  try {
    if (editing.value) {
      await api.ar.updateRule(editing.value.id, payload);
      ElMessage.success('已更新');
    } else {
      await api.ar.addRule(payload);
      ElMessage.success('已添加');
    }
    dialogVisible.value = false;
    await loadRules();
  } catch (e) {
    ElMessage.error(e.message || '保存失败');
  }
}

async function toggleRule(r) {
  await api.ar.updateRule(r.id, { enabled: !r.enabled });
  await loadRules();
}

async function removeRule(r) {
  try {
    await ElMessageBox.confirm(`确定删除规则「${r.name}」？`, '删除规则', { type: 'warning' });
    await api.ar.deleteRule(r.id);
    ElMessage.success('已删除');
    await loadRules();
  } catch {}
}

// ── 草稿操作 ──
async function sendDraft(d) {
  try {
    const items = draftItems(d);
    const content = items.length > 1
      ? items.map((it, i) => `#${i + 1} ${it.kind === 'card' ? `[卡片] ${it.cardName || it.cardId}` : it.text}`).join('\n')
      : d.draft_type === 'card'
        ? `[卡片] ${d.card_name || d.card_id}${d.draft_text ? `\n${d.draft_text}` : ''}`
        : d.draft_text;
    await ElMessageBox.confirm(
      `发送给「${d.peer_name || d.peer_uid}」：\n\n${content}`,
      '确认发送',
      { type: 'info', confirmButtonText: '发送', cancelButtonText: '取消' },
    );
    const r = await api.ar.sendDraft(d.id);
    if (r.ok) {
      if (r.warning) ElMessage.warning(r.warning);
      else ElMessage.success('已发送');
      await loadDrafts();
    } else {
      ElMessage.error(r.error || '发送失败');
    }
  } catch {}
}

async function discardDraft(d) {
  await api.ar.updateDraft(d.id, { status: 'discarded' });
  ElMessage.info('已忽略');
  await loadDrafts();
}

async function discardAllDrafts() {
  if (!drafts.value.length) return;
  let count = drafts.value.length;
  try {
    const r = await api.ar.draftCount({ accountId: draftAccountId.value || undefined });
    if (Number(r?.count) > 0) count = Number(r.count);
  } catch {}
  try {
    await ElMessageBox.confirm(
      `确定忽略${draftAccountId.value ? '当前账号' : '全部'} ${count} 条待确认草稿？忽略后不会发送，也不会自动恢复。`,
      '全部忽略',
      { type: 'warning', confirmButtonText: '全部忽略', cancelButtonText: '取消' },
    );
  } catch { return; }

  discardingAll.value = true;
  try {
    const r = await api.ar.discardAllDrafts({ accountId: draftAccountId.value || undefined });
    if (!r?.ok) { ElMessage.error(r?.error || '操作失败'); return; }
    ElMessage.success(`已忽略 ${r.count} 条草稿`);
    await loadDrafts();
  } catch (e) {
    ElMessage.error(e.message || '操作失败');
  } finally {
    discardingAll.value = false;
  }
}

function goDraftChat(d) {
  openChat({
    accountId: d.account_id,
    peerUid: d.peer_uid,
    text: d.draft_text || '',
  });
}

// ── 测试 ──
const testResult = ref(null);
async function runTest() {
  if (!testText.value.trim()) return;
  try {
    testResult.value = await api.ar.test({
      accountId: props.accounts[0]?.id,
      accountName: props.accounts[0]?.nickname,
      peerName: '测试用户',
      text: testText.value,
    });
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function simulateIncoming() {
  if (!testText.value.trim()) return;
  if (!props.accounts.length) { ElMessage.error('没有账号'); return; }
  try {
    const r = await api.ar.simulate({
      accountId: props.accounts[0].id,
      peerUid: 'sim_user_1',
      peerName: '模拟用户',
      text: testText.value,
    });
    if (r.ok) {
      ElMessage.success(`已模拟，当前待确认草稿 ${r.drafts} 条`);
      await loadDrafts();
      if (tab.value === 'logs') await loadLogs();
    } else {
      ElMessage.error(r.error || '模拟失败');
    }
  } catch (e) {
    ElMessage.error(e.message);
  }
}

// ── 展示 ──
const levelMap = {
  auto: { text: '自动发送', tag: 'danger' },
  draft: { text: '生成草稿', tag: 'warning' },
  notify: { text: '仅提醒', tag: 'info' },
};

const actionMap = {
  auto_sent: { text: '已自动发送', tag: 'success' },
  auto_partial: { text: '部分发送', tag: 'warning' },
  draft: { text: '转草稿', tag: 'warning' },
  notify: { text: '仅提醒', tag: 'info' },
  no_reply: { text: '未回复', tag: 'info' },
  blocked: { text: '已拦截', tag: 'danger' },
  send_failed: { text: '发送失败', tag: 'danger' },
};

const quietNow = computed(() => cfg.value?.quietNow);

function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function bindEvents() {
  unsubs.push(
    api.on('autoreply:event', (p) => {
      loadDrafts();
      if (tab.value === 'logs') loadLogs();
      if (p.action === 'draft') {
        ElMessage.info(`收到草稿：${p.peerName || p.peerUid}（待确认）`);
      } else if (p.action === 'notify') {
        ElMessage.warning(`${p.peerName || p.peerUid} 需要人工处理：${p.reason}`);
      }
    }),
  );
}

onMounted(async () => {
  bindEvents();
  await Promise.all([loadConfig(), loadRules(), loadDrafts(), loadLogs(), loadCards()]);
  timer = setInterval(() => {
    if (tab.value === 'drafts') loadDrafts();
    if (tab.value === 'logs') loadLogs();
  }, 5000);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
  for (const u of unsubs) u();
});
</script>

<template>
  <div class="ar-view">
    <header class="page-head">
      <div>
        <h2>自动回复</h2>
        <p class="sub">
          <span v-if="cfg?.enabled" class="on">已启用</span>
          <span v-else class="off">未启用</span>
          <span v-if="cfg?.enabled && cfg?.replyAll" class="tag warning" style="margin-left: 8px">旧版全消息模式（全局）</span>
          <span v-if="quietNow" class="quiet">· {{ cfg?.replyAll ? '静默时段已忽略' : '当前处于静默时段' }}</span>
        </p>
      </div>
      <button v-if="tab === 'rules'" class="primary" @click="openAdd">＋ 新建规则</button>
    </header>

    <div class="tabs">
      <button :class="{ active: tab === 'settings' }" @click="tab = 'settings'">全局设置</button>
      <button :class="{ active: tab === 'rules' }" @click="tab = 'rules'; loadRules()">
        规则列表
        <span v-if="rules.length" class="badge">{{ rules.length }}</span>
      </button>
      <button :class="{ active: tab === 'drafts' }" @click="tab = 'drafts'; loadDrafts()">
        待确认草稿
        <span v-if="drafts.length" class="badge danger">{{ drafts.length }}</span>
      </button>
      <button :class="{ active: tab === 'logs' }" @click="tab = 'logs'; loadLogs({ resetPage: true })">运行日志</button>
    </div>

    <!-- ══════ 全局设置 ══════ -->
    <div v-if="tab === 'settings' && cfg" class="panel">
      <div class="form-card">
        <div class="field">
          <label class="switch-row">
            <input type="checkbox" v-model="cfg.enabled" />
            <span>启用自动回复</span>
          </label>
          <p class="hint">关闭后所有消息都不会自动回复</p>
        </div>

        <div class="field">
          <label>无差别自动回复</label>
          <p class="hint">
            需要某个账号对所有消息都自动回复时，请在「规则列表」新建规则：匹配方式选「任意消息」，
            「适用账号」勾选该账号。其他账号不受影响。
          </p>
          <p v-if="cfg.replyAll" class="hint" style="color: var(--c-warn)">
            旧版全局「任何消息都自动回复」仍在生效，会影响所有账号。
            <button class="ghost" style="margin-left: 8px" :disabled="saving" @click="disableLegacyReplyAll">
              关闭旧模式
            </button>
          </p>
        </div>

        <div class="field">
          <label>回复延迟</label>
          <div class="inline">
            <input type="number" v-model.number="cfg.replySpeedMs" min="0" class="num" />
            <span>毫秒 + 随机</span>
            <input type="number" v-model.number="cfg.replyJitterMs" min="0" class="num" />
            <span>毫秒</span>
          </div>
          <p class="hint">
            秒回是明显的机器人特征。当前设置：延迟 {{ cfg.replySpeedMs }}~{{ cfg.replySpeedMs + cfg.replyJitterMs }} 毫秒
          </p>
        </div>

        <div class="field">
          <label>静默时段</label>
          <div class="inline">
            <input v-model="cfg.quietHours" placeholder="如 0-7" class="text" />
            <span>点（留空不启用）</span>
          </div>
          <p class="hint">这个时段内收到消息不自动回复。凌晨秒回极不自然；全部消息模式下忽略</p>
        </div>

        <div class="field">
          <label>同会话冷却</label>
          <div class="inline">
            <input type="number" v-model.number="cfg.cooldownSec" min="0" class="num" />
            <span>秒</span>
          </div>
          <p class="hint">同一人两次自动回复之间至少间隔多久（防刷屏）；全部消息模式下忽略</p>
        </div>

        <div class="field">
          <label>单会话上限</label>
          <div class="inline">
            <input type="number" v-model.number="cfg.maxAutoReplyPerConv" min="1" class="num" />
            <span>条（超过转人工）</span>
          </div>
          <p class="hint">同一人今天最多自动回复几条，超过后不再自动回复并提醒人工；全部消息模式下忽略</p>
        </div>

        <div class="field">
          <label>兜底回复</label>
          <SensitivePrecheck
            v-model="cfg.defaultReply"
            :rows="2"
            placeholder="没有匹配规则时回复这句。留空则不回复"
          />
        </div>

        <div class="field">
          <label>转人工关键词</label>
          <input v-model="cfg.transferKeywords" placeholder="人工,客服,投诉" class="text full" />
          <p class="hint">命中这些词立即停止自动回复并提醒人工</p>
        </div>

        <div class="field">
          <label>转人工暂停</label>
          <div class="inline">
            <input type="number" v-model.number="cfg.transferPauseMin" min="1" class="num" />
            <span>分钟后自动恢复</span>
          </div>
          <p class="hint">超限或命中转人工词后，暂停该会话的自动回复；到时间自动恢复</p>
        </div>

        <div class="field">
          <label class="switch-row">
            <input type="checkbox" v-model="cfg.quoteReply" />
            <span>引用对方原消息回复</span>
          </label>
          <p class="hint">需要入站消息带 serverMessageId；失败会自动回退普通文本</p>
        </div>

        <div class="actions">
          <button class="primary" :disabled="saving" @click="saveCfg">
            {{ saving ? '保存中…' : '保存设置' }}
          </button>
        </div>
      </div>

      <!-- 决策测试 -->
      <div class="test-card">
        <h4>决策测试</h4>
        <p class="hint">模拟收到一条消息，看引擎会怎么处理（不会真的发送）</p>
        <div class="test-row">
          <input v-model="testText" placeholder="模拟对方发来的消息" class="text" />
          <button class="ghost" @click="runTest">测试</button>
        </div>
        <div class="sim-row">
          <button class="ghost" @click="simulateIncoming">模拟收到（走完整链路）</button>
          <span class="hint" style="margin:0">演练模式下不会真实回复</span>
        </div>

        <div v-if="testResult" class="test-result" :class="testResult.action">
          <div class="tr-head">
            <span class="tag" :class="actionMap[testResult.action]?.tag">
              {{ actionMap[testResult.action]?.text || testResult.action }}
            </span>
            <span class="reason">{{ testResult.reason }}</span>
          </div>
          <div v-if="testResult.replyText" class="tr-body">
            回复内容：{{ testResult.replyText }}
          </div>
          <div v-if="testResult.delayMs" class="tr-meta">
            延迟 {{ Math.round(testResult.delayMs) }}ms
          </div>
          <div v-if="testResult.silent" class="tr-meta">不打扰用户（静默处理）</div>
        </div>
      </div>
    </div>

    <!-- ══════ 规则列表 ══════ -->
    <div v-if="tab === 'rules'" class="panel">
      <div v-if="!rules.length" class="empty">
        <p>还没有规则</p>
        <p class="hint">点右上角「新建规则」开始</p>
      </div>

      <table v-else class="rule-table">
        <thead>
          <tr>
            <th style="width: 50px">启用</th>
            <th style="width: 150px">名称</th>
            <th style="width: 70px">作用域</th>
            <th style="width: 70px">匹配</th>
            <th>关键词</th>
            <th>回复内容</th>
            <th style="width: 90px">级别</th>
            <th style="width: 60px">命中</th>
            <th style="width: 120px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rules" :key="r.id" :class="{ disabled: !r.enabled }">
            <td>
              <input type="checkbox" :checked="!!r.enabled" @change="toggleRule(r)" />
            </td>
            <td class="ellipsis">{{ r.name }}</td>
            <td>{{ { dm: '私信', comment: '评论', both: '两者' }[r.scope] || r.scope }}</td>
            <td>{{ { contains: '包含', exact: '精确', regex: '正则', any: '任意消息' }[r.match_type] || r.match_type }}</td>
            <td class="ellipsis" :title="r.pattern">{{ r.match_type === 'any' ? '全部消息' : r.pattern }}</td>
            <td class="ellipsis" :title="ruleContentLabel(r)">
              <span v-if="ruleItemCount(r) > 1" class="tag info">{{ ruleItemCount(r) }} 条</span>
              <template v-else>{{ ruleContentLabel(r) }}</template>
            </td>
            <td>
              <span class="tag" :class="levelMap[r.level]?.tag">{{ levelMap[r.level]?.text }}</span>
            </td>
            <td>{{ r.hit_count }}</td>
            <td class="ops">
              <button @click="openEdit(r)">编辑</button>
              <button class="danger" @click="removeRule(r)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- ══════ 草稿队列 ══════ -->
    <div v-if="tab === 'drafts'" class="panel">
      <div class="draft-toolbar">
        <span>{{ drafts.length ? `共 ${drafts.length} 条待确认草稿` : '没有待确认的草稿' }}</span>
        <div class="draft-tools">
          <select v-model="draftAccountId" class="draft-account-filter" @change="loadDrafts">
            <option value="">全部账号</option>
            <option v-for="a in accounts" :key="a.id" :value="a.id">
              {{ a.nickname || a.uid }}
            </option>
          </select>
          <button v-if="drafts.length" class="ghost-sm danger" :disabled="discardingAll" @click="discardAllDrafts">
            {{ discardingAll ? '处理中…' : '全部忽略' }}
          </button>
        </div>
      </div>

      <div v-if="!drafts.length" class="empty">
        <p>没有待确认的草稿</p>
        <p class="hint">当规则设为「生成草稿」或内容命中敏感词时，草稿会出现在这里</p>
      </div>

      <div v-if="drafts.length" class="draft-list">
        <div v-for="d in drafts" :key="d.id" class="draft-card">
          <div class="dc-head">
            <span class="peer">{{ d.peer_name || d.peer_uid }}</span>
            <span class="time">{{ fmtTime(d.created_at) }}</span>
            <span v-if="d.reason?.startsWith('sensitive')" class="tag danger">含敏感词</span>
          </div>
          <div class="dc-trigger">
            <span class="label">对方说：</span>{{ d.trigger_text }}
          </div>
          <div class="dc-reply">
            <span class="label">建议回复：</span>
            <template v-if="draftItems(d).length > 1">
              <div class="draft-items">
                <div v-for="(it, i) in draftItems(d)" :key="i" class="di-row">
                  <span class="di-idx">#{{ i + 1 }}</span>
                  <span v-if="it.kind === 'card'" class="tag info">
                    [卡片] {{ it.cardName || it.cardId }}
                  </span>
                  <span v-else>{{ it.text }}</span>
                </div>
              </div>
            </template>
            <template v-else-if="d.draft_type === 'card'">
              [卡片] {{ d.card_name || d.card_id }}
              <template v-if="d.draft_text"> · {{ d.draft_text }}</template>
            </template>
            <template v-else>{{ d.draft_text }}</template>
          </div>
          <div class="dc-ops">
            <button class="primary-sm" @click="sendDraft(d)">发送</button>
            <button class="ghost-sm" @click="goDraftChat(d)">去聊天</button>
            <button class="ghost-sm" @click="discardDraft(d)">忽略</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ══════ 运行日志 ══════ -->
    <div v-if="tab === 'logs'" class="panel">
      <div v-if="stats" class="log-stats">
        <span v-for="s in stats.byAction" :key="s.action" class="stat-chip">
          {{ actionMap[s.action]?.text || s.action }} {{ s.c }}
        </span>
      </div>

      <div v-if="!logs.length" class="empty">暂无日志</div>

      <table v-else class="log-table">
        <thead>
          <tr>
            <th style="width: 110px">时间</th>
            <th style="width: 120px">对方</th>
            <th style="width: 90px">动作</th>
            <th style="width: 180px">原因</th>
            <th>对方说</th>
            <th>回复</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="l in logs" :key="l.id">
            <td class="mono">{{ fmtTime(l.created_at) }}</td>
            <td class="ellipsis">{{ l.peer_name || l.peer_uid }}</td>
            <td>
              <span class="tag" :class="actionMap[l.action]?.tag">
                {{ actionMap[l.action]?.text || l.action }}
              </span>
            </td>
            <td class="ellipsis" :title="l.reason">{{ l.reason }}</td>
            <td class="ellipsis" :title="l.trigger_text">{{ l.trigger_text }}</td>
            <td class="ellipsis" :title="l.reply_text">{{ l.reply_text }}</td>
          </tr>
        </tbody>
      </table>

      <div v-if="logTotal > 0" class="log-pager">
        <span class="lp-total">共 {{ logTotal }} 条</span>
        <select v-model.number="logPageSize" class="lp-size" @change="logPage = 1; loadLogs()">
          <option :value="20">20 / 页</option>
          <option :value="50">50 / 页</option>
          <option :value="100">100 / 页</option>
        </select>
        <button :disabled="logPage <= 1" @click="logPage--; loadLogs()">上一页</button>
        <span class="lp-page">{{ logPage }} / {{ logPageCount }}</span>
        <button :disabled="logPage >= logPageCount" @click="logPage++; loadLogs()">下一页</button>
      </div>
    </div>

    <!-- 规则编辑弹窗 -->
    <el-dialog
      v-model="dialogVisible"
      :title="editing ? '编辑规则' : '新建规则'"
      width="520px"
    >
      <div class="form">
        <div class="row">
          <label>规则名称</label>
          <input v-model="form.name" placeholder="如：价格咨询" />
        </div>
        <div class="row">
          <label>作用域</label>
          <div class="radios">
            <label><input type="radio" value="dm" v-model="form.scope" /> 私信</label>
            <label><input type="radio" value="comment" v-model="form.scope" /> 评论</label>
            <label><input type="radio" value="both" v-model="form.scope" /> 两者</label>
          </div>
        </div>
        <div class="row">
          <label>适用账号</label>
          <div class="radios account-checks">
            <label v-for="a in accounts" :key="a.id">
              <input
                type="checkbox"
                :checked="chatTypeList(form.accountIds).includes(a.id)"
                @change="toggleAccount(form, a.id)"
              />
              {{ a.nickname || a.id }}
            </label>
            <span v-if="!accounts.length" class="hint-text">暂无账号</span>
          </div>
          <p class="hint-text">不选 = 所有账号</p>
        </div>
        <div class="row">
          <label>会话类型</label>
          <div class="radios">
            <label v-for="t in CHAT_TYPES" :key="t.v">
              <input
                type="checkbox"
                :checked="chatTypeList(form.chatTypes).includes(t.v)"
                @change="toggleChatType(form, t.v)"
              />
              {{ t.t }}
            </label>
          </div>
        </div>
        <div class="row">
          <label>匹配方式</label>
          <div class="radios">
            <label><input type="radio" value="contains" v-model="form.matchType" /> 包含</label>
            <label><input type="radio" value="exact" v-model="form.matchType" /> 精确</label>
            <label><input type="radio" value="regex" v-model="form.matchType" /> 正则</label>
            <label><input type="radio" value="any" v-model="form.matchType" /> 任意消息</label>
          </div>
          <p v-if="form.matchType === 'any'" class="hint-text">
            不做关键词判断，该账号收到的所有消息都自动回复；会忽略静默时段、冷却和单会话上限，转人工关键词和敏感词仍然生效
          </p>
        </div>
        <div v-if="form.matchType !== 'any'" class="row">
          <label>关键词</label>
          <textarea
            v-model="form.pattern"
            rows="3"
            placeholder="一行一个，如：&#10;价格&#10;多少钱&#10;怎么卖"
          />
        </div>
        <div class="row">
          <label>多消息组合</label>
          <div class="radios">
            <label>
              <input type="checkbox" v-model="multiMode" />
              开启（文本/卡片按顺序发送）
            </label>
          </div>
        </div>
        <template v-if="!multiMode">
        <div class="row">
          <label>回复类型</label>
          <div class="radios">
            <label><input type="radio" value="text" v-model="form.replyType" /> 文本 / 表情</label>
            <label><input type="radio" value="card" v-model="form.replyType" /> 卡片</label>
          </div>
        </div>
        <div v-if="form.replyType === 'card'" class="row">
          <label>选择卡片</label>
          <div style="flex: 1">
            <select v-model="form.cardId" class="card-select">
              <option value="">请选择卡片</option>
              <option v-for="c in cards" :key="c.id" :value="c.id">
                {{ cardKindLabel(c.kind) }} · {{ cardDisplayName(c) }}
              </option>
            </select>
            <p v-if="!cards.length" class="hint-text">
              还没有跳转卡，请先到「卡片管理」新建跳转卡
            </p>
            <div v-if="cardById(form.cardId)" class="card-preview">
              <img
                v-if="cardPreviewImage(cardById(form.cardId))"
                :src="cardPreviewImage(cardById(form.cardId))"
                alt=""
              />
              <div class="cp-body">
                <div class="cp-title">{{ cardDisplayName(cardById(form.cardId)) }}</div>
                <div class="cp-desc">
                  {{ cardById(form.cardId).linkDesc || cardById(form.cardId).name || '' }}
                </div>
                <div v-if="cardById(form.cardId).linkUrl" class="cp-url">
                  {{ cardById(form.cardId).linkUrl }}
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="row">
          <label>{{ form.replyType === 'card' ? '附带文本' : '回复内容' }}</label>
          <div style="flex: 1">
            <SensitivePrecheck
              v-model="form.replyText"
              :rows="3"
              :placeholder="form.replyType === 'card'
                ? '可选，随卡片一起发送；支持变量和表情'
                : '支持变量：{昵称} {账号} {时间}'"
            />
            <div class="emoji-bar">
              <button type="button" class="emoji-toggle" @click="emojiOpen = !emojiOpen">
                😊 插入表情
              </button>
              <div v-if="emojiOpen" class="emoji-panel-form">
                <button
                  v-for="e in EMOJIS"
                  :key="e"
                  type="button"
                  @click="appendEmoji(e)"
                >{{ e }}</button>
              </div>
            </div>
          </div>
        </div>
        </template>

        <div v-if="multiMode" class="row">
          <label>消息顺序</label>
          <div style="flex: 1" class="msg-editor">
            <div v-if="!form.items?.length" class="hint-text">
              还没有消息，点下面按钮添加文本或卡片
            </div>
            <div
              v-for="(it, i) in form.items"
              :key="i"
              class="msg-item"
              draggable="true"
              @dragstart="onDragStart(i)"
              @dragover.prevent
              @drop.prevent="onDropItem(i)"
            >
              <div class="mi-head">
                <span class="mi-idx">#{{ i + 1 }}</span>
                <span class="mi-kind">{{ it.kind === 'card' ? '卡片' : '文本' }}</span>
                <button type="button" class="mini" :disabled="i === 0" @click="moveItem(i, -1)">↑</button>
                <button
                  type="button"
                  class="mini"
                  :disabled="i === form.items.length - 1"
                  @click="moveItem(i, 1)"
                >↓</button>
                <button type="button" class="mini danger" @click="removeItem(i)">删除</button>
              </div>

              <template v-if="it.kind === 'card'">
                <select v-model="it.cardId" class="card-select">
                  <option value="">请选择卡片</option>
                  <option v-for="c in cards" :key="c.id" :value="c.id">
                    {{ cardKindLabel(c.kind) }} · {{ cardDisplayName(c) }}
                  </option>
                </select>
                <div v-if="cardById(it.cardId)" class="card-preview">
                  <img
                    v-if="cardPreviewImage(cardById(it.cardId))"
                    :src="cardPreviewImage(cardById(it.cardId))"
                    alt=""
                  />
                  <div class="cp-body">
                    <div class="cp-title">{{ cardDisplayName(cardById(it.cardId)) }}</div>
                    <div class="cp-desc">
                      {{ cardById(it.cardId).linkDesc || cardById(it.cardId).name || '' }}
                    </div>
                    <div v-if="cardById(it.cardId).linkUrl" class="cp-url">
                      {{ cardById(it.cardId).linkUrl }}
                    </div>
                  </div>
                </div>
                <SensitivePrecheck
                  v-model="it.text"
                  :rows="2"
                  placeholder="可选：卡片后单独发一条文本"
                />
              </template>

              <template v-else>
                <SensitivePrecheck
                  v-model="it.text"
                  :rows="2"
                  placeholder="文本内容，支持变量 {昵称} 和表情"
                />
                <div class="emoji-row">
                  <button
                    v-for="e in EMOJIS.slice(0, 12)"
                    :key="e"
                    type="button"
                    class="emoji-mini"
                    @click="appendEmojiTo(it, e)"
                  >{{ e }}</button>
                </div>
              </template>

              <div v-if="i > 0" class="mi-delay">
                延迟
                <input type="number" v-model.number="it.delayMs" min="0" class="num" />
                ms
              </div>
            </div>

            <div class="mi-actions">
              <button type="button" class="ghost-sm" @click="addItem('text')">＋ 文本</button>
              <button type="button" class="ghost-sm" @click="addItem('card')">＋ 卡片</button>
            </div>
          </div>
        </div>

        <div v-if="form.matchType !== 'any'" class="row">
          <label>处理级别</label>
          <div class="radios">
            <label><input type="radio" value="draft" v-model="form.level" /> 生成草稿（默认）</label>
            <label><input type="radio" value="auto" v-model="form.level" /> 自动发送</label>
            <label><input type="radio" value="notify" v-model="form.level" /> 仅提醒</label>
          </div>
        </div>
        <p v-else class="hint-text">
          任意消息规则固定为自动发送；会忽略静默时段、同会话冷却和单会话上限，转人工关键词和敏感词仍然生效。
        </p>
        <p v-if="form.level === 'auto'" class="warn-text">
          ⚠️ 自动发送会直接回复客户，请确认话术无误。建议先用「生成草稿」跑几天。
        </p>
        <div class="row">
          <label>优先级</label>
          <input type="number" v-model.number="form.priority" class="num" />
          <span class="hint-text">数字越大越优先</span>
        </div>
        <div class="row">
          <label>规则冷却</label>
          <input type="number" v-model.number="form.cooldownSec" min="0" class="num" />
          <span class="hint-text">秒（同一规则对同一会话不重复回复）</span>
        </div>
      </div>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitRule">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.ar-view {
  flex: 1; display: flex; flex-direction: column;
  padding: 18px 22px; overflow-y: auto; min-width: 0;
}
.page-head {
  display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 14px;
}
.page-head h2 { font-size: 18px; font-weight: 600; }
.sub { font-size: 12px; color: var(--c-text-2); margin-top: 4px; }
.on { color: #1a7f37; }
.off { color: var(--c-text-3); }
.quiet { color: var(--c-warn); }
.primary {
  height: 32px; padding: 0 16px; border: none; border-radius: 6px;
  background: var(--c-primary); color: #fff; font-size: 13px;
}
.primary:disabled { opacity: 0.6; }

.tabs { display: flex; gap: 6px; margin-bottom: 14px; }
.tabs button {
  height: 30px; padding: 0 16px; border: 1px solid var(--c-border);
  border-radius: 6px; background: #fff; font-size: 13px; color: var(--c-text-2);
  display: flex; align-items: center; gap: 6px;
}
.tabs button.active { border-color: var(--c-primary); background: #eaf1ff; color: var(--c-primary); }
.badge {
  font-size: 10px; padding: 0 5px; border-radius: 8px;
  background: #eaf1ff; color: var(--c-primary);
}
.badge.danger { background: var(--c-danger); color: #fff; }

.panel { flex: 1; }
.empty { padding: 60px; text-align: center; color: var(--c-text-2); font-size: 13px; }
.empty .hint { font-size: 12px; color: var(--c-text-3); margin-top: 6px; }

.form-card {
  background: #fff; border: 1px solid var(--c-border); border-radius: 8px;
  padding: 18px; max-width: 640px; display: flex; flex-direction: column; gap: 18px;
}
.field { display: flex; flex-direction: column; gap: 6px; }
.field > label { font-size: 13px; color: var(--c-text); font-weight: 500; }
.switch-row { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.hint { font-size: 11px; color: var(--c-text-3); line-height: 1.6; }
.inline { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--c-text-2); }
.num { width: 80px; height: 30px; padding: 0 8px; border: 1px solid var(--c-border); border-radius: 6px; font-size: 13px; text-align: center; outline: none; }
.text { flex: 1; height: 30px; padding: 0 10px; border: 1px solid var(--c-border); border-radius: 6px; font-size: 13px; outline: none; }
.text.full { width: 100%; }
.text:focus, .num:focus { border-color: var(--c-primary); }
.actions { display: flex; gap: 8px; }

.test-card {
  margin-top: 16px; background: #fff; border: 1px solid var(--c-border);
  border-radius: 8px; padding: 16px; max-width: 640px;
}
.test-card h4 { font-size: 13px; margin-bottom: 4px; }
.test-row { display: flex; gap: 8px; margin-top: 10px; }
.ghost {
  height: 30px; padding: 0 14px; border: 1px solid var(--c-border);
  border-radius: 6px; background: #fff; font-size: 12px; color: var(--c-text-2);
}
.sim-row { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
.test-result {
  margin-top: 12px; padding: 10px 12px; border-radius: 6px;
  background: #fafbfc; border: 1px solid var(--c-border); font-size: 12px;
}
.test-result.auto_sent { border-color: #c3e9d0; background: #f6fdf8; }
.test-result.draft { border-color: #ffd8a8; background: #fffbf5; }
.tr-head { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
.tr-body { color: var(--c-text); margin: 6px 0; }
.tr-meta { color: var(--c-text-3); font-size: 11px; }

.rule-table, .log-table { width: 100%; border-collapse: collapse; font-size: 12px; background: #fff; }
.rule-table th, .log-table th {
  text-align: left; padding: 9px 10px; font-weight: 500; color: var(--c-text-2);
  background: #fafbfc; border-bottom: 1px solid var(--c-border); white-space: nowrap;
}
.rule-table td, .log-table td { padding: 8px 10px; border-bottom: 1px solid #f5f6f8; }
.rule-table tr.disabled td { opacity: 0.5; }
.rule-table tr:hover td, .log-table tr:hover td { background: #fafbfc; }
.ellipsis { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mono { font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: var(--c-text-2); }
.ops { display: flex; gap: 4px; }
.ops button {
  height: 22px; padding: 0 8px; border: 1px solid var(--c-border);
  border-radius: 4px; background: #fff; font-size: 11px; color: var(--c-text-2);
}
.ops button.danger { border-color: var(--c-danger); color: var(--c-danger); }

.tag {
  display: inline-block; font-size: 11px; padding: 0 5px;
  border-radius: 3px; background: #f0f1f4; color: var(--c-text-2); white-space: nowrap;
}
.tag.success { background: #e8f8ee; color: #1a7f37; }
.tag.warning { background: #fff4e5; color: #b76e00; }
.tag.danger { background: #ffece9; color: #d4380d; }
.tag.info { background: #eaf1ff; color: var(--c-primary); }

.draft-list { display: flex; flex-direction: column; gap: 10px; max-width: 720px; }
.draft-toolbar {
  display: flex; align-items: center; justify-content: space-between;
  gap: 10px; max-width: 720px; margin-bottom: 10px; font-size: 12px; color: var(--c-text-2);
}
.draft-tools { display: flex; align-items: center; gap: 8px; }
.draft-account-filter {
  height: 26px; padding: 0 6px; border: 1px solid var(--c-border);
  border-radius: 4px; background: #fff; font-size: 12px; outline: none; max-width: 180px;
}
.draft-toolbar .ghost-sm.danger { border-color: var(--c-danger); color: var(--c-danger); }
.draft-toolbar .ghost-sm:disabled { opacity: 0.5; }
.draft-card {
  background: #fff; border: 1px solid var(--c-border); border-radius: 8px; padding: 14px;
}
.dc-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.dc-head .peer { font-weight: 600; font-size: 13px; }
.dc-head .time { font-size: 11px; color: var(--c-text-3); margin-left: auto; }
.dc-trigger, .dc-reply { font-size: 12px; margin: 6px 0; line-height: 1.6; }
.dc-trigger .label, .dc-reply .label { color: var(--c-text-3); }
.dc-reply { color: var(--c-primary); }
.dc-ops { display: flex; gap: 8px; margin-top: 10px; }
.primary-sm {
  height: 26px; padding: 0 14px; border: none; border-radius: 4px;
  background: var(--c-primary); color: #fff; font-size: 12px;
}
.ghost-sm {
  height: 26px; padding: 0 12px; border: 1px solid var(--c-border);
  border-radius: 4px; background: #fff; font-size: 12px; color: var(--c-text-2);
}

.log-stats { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.stat-chip {
  font-size: 12px; padding: 3px 10px; border-radius: 12px;
  background: #f0f1f4; color: var(--c-text-2);
}
.log-pager {
  display: flex; align-items: center; gap: 10px; justify-content: flex-end;
  padding: 10px 2px 2px; font-size: 12px; color: var(--c-text-2);
}
.log-pager .lp-total { margin-right: auto; }
.log-pager .lp-size {
  height: 26px; padding: 0 6px; border: 1px solid var(--c-border);
  border-radius: 5px; background: #fff; font-size: 12px; outline: none;
}
.log-pager .lp-page { min-width: 58px; text-align: center; }
.log-pager button {
  height: 26px; padding: 0 10px; border: 1px solid var(--c-border);
  border-radius: 5px; background: #fff; font-size: 12px; color: var(--c-text-1);
}
.log-pager button:disabled { opacity: 0.4; }

.form { display: flex; flex-direction: column; gap: 12px; }
.row { display: flex; gap: 12px; align-items: flex-start; }
.row > label {
  width: 76px; flex-shrink: 0; font-size: 13px; color: var(--c-text-2); padding-top: 5px;
}
.row input:not([type]), .row textarea {
  flex: 1; padding: 7px 10px; border: 1px solid var(--c-border);
  border-radius: 6px; font-size: 13px; outline: none; font-family: inherit;
}
.row textarea { resize: vertical; }
.radios { display: flex; flex-wrap: wrap; gap: 12px; font-size: 13px; }
.radios label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
.warn-text { font-size: 12px; color: var(--c-warn); padding-left: 88px; }
.hint-text { font-size: 11px; color: var(--c-text-3); padding-top: 8px; }
.card-select {
  width: 100%; padding: 7px 10px; border: 1px solid var(--c-border);
  border-radius: 6px; font-size: 13px; background: #fff; outline: none;
}
.emoji-bar { margin-top: 6px; }
.emoji-toggle {
  border: 1px solid var(--c-border); background: #fff; border-radius: 6px;
  padding: 4px 10px; font-size: 12px; cursor: pointer; color: var(--c-text-2);
}
.emoji-toggle:hover { background: #f5f6f8; }
.emoji-panel-form {
  display: flex; flex-wrap: wrap; gap: 2px; margin-top: 6px; padding: 6px;
  max-width: 320px; background: #fff; border: 1px solid var(--c-border);
  border-radius: 8px; box-shadow: 0 6px 18px rgba(0, 0, 0, 0.08);
}
.emoji-panel-form button {
  border: none; background: transparent; font-size: 18px; line-height: 1;
  padding: 3px 4px; border-radius: 4px; cursor: pointer;
}
.emoji-panel-form button:hover { background: #f0f1f4; }

.msg-editor { display: flex; flex-direction: column; gap: 8px; }
.msg-item {
  border: 1px solid var(--c-border); border-radius: 8px;
  padding: 8px; background: #fafbfc; display: flex; flex-direction: column; gap: 6px;
  cursor: grab;
}
.mi-head { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.mi-idx { color: var(--c-text-3); }
.mi-kind { font-weight: 600; color: var(--c-text-2); }
.mi-head .mini {
  height: 22px; padding: 0 7px; border: 1px solid var(--c-border);
  border-radius: 4px; background: #fff; font-size: 11px; cursor: pointer;
}
.mi-head .mini:disabled { opacity: 0.4; cursor: default; }
.mi-head .mini.danger { color: var(--c-danger); }
.mi-delay { font-size: 11px; color: var(--c-text-3); }
.mi-delay .num { width: 70px; height: 24px; }
.mi-actions { display: flex; gap: 8px; }
.ghost-sm {
  height: 26px; padding: 0 12px; border: 1px solid var(--c-border);
  border-radius: 5px; background: #fff; font-size: 12px; cursor: pointer;
}
.emoji-row { display: flex; flex-wrap: wrap; gap: 1px; }
.emoji-mini {
  border: none; background: transparent; font-size: 16px; cursor: pointer;
  padding: 1px 3px; border-radius: 3px;
}
.emoji-mini:hover { background: #f0f1f4; }
.card-preview {
  display: flex; gap: 10px; padding: 8px; margin-top: 6px;
  border: 1px solid #e2e9f5; background: #fff; border-radius: 6px;
}
.card-preview img { width: 56px; height: 56px; object-fit: cover; border-radius: 5px; flex-shrink: 0; }
.cp-body { min-width: 0; }
.cp-title { font-size: 12px; font-weight: 600; color: var(--c-text-1); }
.cp-desc { font-size: 11px; color: var(--c-text-2); margin-top: 2px; }
.cp-url { font-size: 10px; color: var(--c-text-3); margin-top: 3px; word-break: break-all; }
.draft-items { margin-top: 4px; display: flex; flex-direction: column; gap: 2px; }
.di-row { display: flex; align-items: baseline; gap: 6px; font-size: 12px; }
.di-idx { color: var(--c-text-3); }
</style>
