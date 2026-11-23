<script setup>
import { computed, ref, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api.js';

const props = defineProps({
  account: { type: Object, default: null },
  contact: { type: Object, default: null },
  messages: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  sending: { type: Boolean, default: false },
  readState: { type: Object, default: null },
  prefill: { type: String, default: '' },
});
const emit = defineEmits([
  'send', 'retry', 'load-more', 'refresh',
  'recall', 'delete', 'react', 'toggle-pin', 'toggle-mute',
]);

const draft = ref('');
const attachments = ref([]);
const precheck = ref(null);
const checking = ref(false);
const rewriting = ref(false);
const rewriteVisible = ref(false);
const rewriteResult = ref(null);
const emojiOpen = ref(false);
const previewUrl = ref(null);
const brokenImages = ref(new Set());
const showProfile = ref(false);
const replyTo = ref(null);
const contextMenu = ref(null);
const forwardOpen = ref(false);
const forwardMessage = ref(null);
const forwardTargets = ref([]);
const forwardTargetId = ref(null);
const forwarding = ref(false);
const mentions = ref([]);
const membersOpen = ref(false);
const membersLoading = ref(false);
const groupMembers = ref([]);
const listRef = ref(null);
const composerRef = ref(null);
const imageInput = ref(null);
const fileInput = ref(null);
const atBottom = ref(true);
const newMessages = ref(false);

let currentDraftKey = null;
let saveTimer = null;
let checkTimer = null;

const canShow = computed(() => !!props.account && !!props.contact);
const isGroup = computed(() => props.contact?.kind === 'group');
const canSend = computed(
  () => (!!draft.value.trim() || attachments.value.length > 0)
    && !props.sending
    && !precheck.value?.blocked,
);

const readLabel = computed(() => {
  const r = props.readState;
  if (!r || r.ok === false) return '';
  if (r.privacy && r.privacy.enableReadState === false) return '已读状态不可见';
  return r.isAllRead ? '对方已读' : '';
});

const EMOJIS = [
  '😀', '😁', '😂', '🤣', '😊', '😍', '🤔', '😎', '😭', '😡',
  '👍', '👏', '🙏', '💪', '🔥', '🎉', '❤️', '💔', '✅', '❌',
  '⭐', '💰', '📞', '📱', '🚗', '🏠', '📄', '🤝', '👌', '🫶',
];

function draftKeyFor(account, contact) {
  if (!account?.id || !contact?.peer_uid) return null;
  return `chat:draft:${account.id}:${contact.peer_uid}`;
}

watch(
  () => [props.account?.id, props.contact?.peer_uid],
  () => {
    if (currentDraftKey) localStorage.setItem(currentDraftKey, draft.value);
    currentDraftKey = draftKeyFor(props.account, props.contact);
    draft.value = currentDraftKey ? (localStorage.getItem(currentDraftKey) || '') : '';
    attachments.value = [];
    precheck.value = null;
    rewriteVisible.value = false;
    rewriteResult.value = null;
    emojiOpen.value = false;
    showProfile.value = false;
    replyTo.value = null;
    mentions.value = [];
    contextMenu.value = null;
    forwardOpen.value = false;
    forwardMessage.value = null;
    membersOpen.value = false;
    groupMembers.value = [];
    atBottom.value = true;
    newMessages.value = false;
    brokenImages.value = new Set();
    nextTick(scrollToBottom);
  },
  { immediate: true },
);

watch(draft, (v) => {
  if (currentDraftKey) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(currentDraftKey, v); } catch {}
    }, 300);
  }
  clearTimeout(checkTimer);
  if (!v.trim()) {
    precheck.value = null;
    return;
  }
  checkTimer = setTimeout(() => doCheck(v), 350);
});

watch(
  () => props.messages.length,
  async () => {
    await nextTick();
    if (atBottom.value) scrollToBottom();
    else newMessages.value = true;
  },
);

watch(
  () => props.contact?.peer_uid,
  async () => {
    await nextTick();
    scrollToBottom();
  },
);

watch(
  () => props.prefill,
  (v) => {
    if (!v) return;
    draft.value = v;
    nextTick(() => composerRef.value?.focus());
  },
);

async function doCheck(v) {
  checking.value = true;
  try {
    precheck.value = await api.sw.preview(v, 'dm');
  } catch {
    precheck.value = null;
  } finally {
    checking.value = false;
  }
}

function scrollToBottom() {
  const el = listRef.value;
  if (el) el.scrollTop = el.scrollHeight;
  atBottom.value = true;
  newMessages.value = false;
}

function onScroll() {
  const el = listRef.value;
  if (!el) return;
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  if (atBottom.value) newMessages.value = false;
}

function onKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    doSend();
  }
}

function doSend() {
  if (!canSend.value) {
    if (precheck.value?.blocked) ElMessage.error('内容含阻断词，请先修改或合规改写');
    return;
  }
  const payload = {
    text: draft.value.trim(),
    attachments: attachments.value.map((a) => ({
      kind: a.kind,
      name: a.name,
      mime: a.mime,
      base64: a.base64,
    })),
    replyTo: replyTo.value
      ? {
          serverMsgId: replyTo.value.server_msg_id,
          messageType: replyTo.value.message_type || 7,
          senderUid: replyTo.value.sender_uid,
          senderSecUid: replyTo.value.sender_sec_uid,
          text: replyTo.value.content,
        }
      : null,
    mentions: mentions.value.map((m) => ({ uid: m.uid, name: m.name })),
  };
  emit('send', payload, (ok) => {
    if (!ok) return;
    draft.value = '';
    attachments.value = [];
    precheck.value = null;
    replyTo.value = null;
    mentions.value = [];
    if (currentDraftKey) {
      try { localStorage.removeItem(currentDraftKey); } catch {}
    }
  });
}

async function doRewrite() {
  if (!draft.value.trim()) return;
  rewriting.value = true;
  try {
    rewriteResult.value = await api.sw.rewrite(draft.value, 'dm');
    rewriteVisible.value = true;
  } catch (e) {
    ElMessage.error(e.message || '改写失败');
  } finally {
    rewriting.value = false;
  }
}

function adoptRewrite() {
  const v = rewriteResult.value?.rewritten ?? '';
  rewriteVisible.value = false;
  rewriteResult.value = null;
  draft.value = v;
  nextTick(() => composerRef.value?.focus());
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function addFiles(files, forceKind) {
  for (const file of files) {
    const isImage = forceKind === 'image' || String(file.type || '').startsWith('image/');
    const limit = isImage ? 15 * 1024 * 1024 : 25 * 1024 * 1024;
    if (file.size > limit) {
      ElMessage.warning(`${file.name} 超过 ${isImage ? '15MB' : '25MB'}，已跳过`);
      continue;
    }
    try {
      const dataUrl = await readAsDataUrl(file);
      const base64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
      attachments.value.push({
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        kind: isImage ? 'image' : 'file',
        name: file.name || (isImage ? 'image.png' : 'file'),
        size: file.size,
        mime: file.type || '',
        base64,
        dataUrl: isImage ? dataUrl : '',
      });
    } catch (e) {
      ElMessage.error(`读取 ${file.name} 失败`);
    }
  }
}

function onFileInput(e, kind) {
  const files = [...(e.target.files ?? [])];
  e.target.value = '';
  if (files.length) addFiles(files, kind);
}

function onDrop(e) {
  const files = [...(e.dataTransfer?.files ?? [])];
  if (!files.length) return;
  e.preventDefault();
  addFiles(files);
}

function onPaste(e) {
  const items = [...(e.clipboardData?.items ?? [])]
    .filter((i) => i.kind === 'file')
    .map((i) => i.getAsFile())
    .filter(Boolean);
  const files = (items.length ? items : [...(e.clipboardData?.files ?? [])]).filter((f) =>
    String(f.type || '').startsWith('image/'),
  );
  if (!files.length) return;
  e.preventDefault();
  addFiles(files, 'image');
}

function removeAttachment(id) {
  attachments.value = attachments.value.filter((a) => a.id !== id);
}

function insertEmoji(emoji) {
  const el = composerRef.value;
  if (!el) {
    draft.value += emoji;
    return;
  }
  const start = el.selectionStart ?? draft.value.length;
  const end = el.selectionEnd ?? draft.value.length;
  draft.value = draft.value.slice(0, start) + emoji + draft.value.slice(end);
  emojiOpen.value = false;
  nextTick(() => {
    el.focus();
    el.selectionStart = el.selectionEnd = start + emoji.length;
  });
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

function fmtSize(n) {
  const size = Number(n) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function statusIcon(m) {
  if (m.direction !== 'out') return '';
  if (m.status === 'pending') return '⏳';
  if (m.status === 'sent') return '✓';
  if (m.status === 'failed') return '✕';
  if (m.status === 'unknown') return '?';
  return '';
}

function meta(m) {
  return m?.meta && typeof m.meta === 'object' ? m.meta : {};
}

function imageUrl(m) {
  return m?.media_url || meta(m).url || meta(m).coverUrl || '';
}

function imageSrc(m) {
  const url = imageUrl(m);
  return url && !brokenImages.value.has(m.id) ? url : '';
}

function coverSrc(m) {
  const url = meta(m).coverUrl;
  return url && !brokenImages.value.has(m.id) ? url : '';
}

function markBroken(m) {
  const next = new Set(brokenImages.value);
  next.add(m.id);
  brokenImages.value = next;
}

function isSystem(m) {
  return m?.msg_type === 'system';
}

function senderLabel(m) {
  if (!isGroup.value || m.direction === 'out') return '';
  const name = m.sender_name && m.sender_name !== m.sender_uid ? m.sender_name : '';
  return name || (m.sender_uid ? `用户 ${m.sender_uid}` : '');
}

function senderAvatarFailed(m) {
  m.sender_avatar = '';
}

function workUrl(m) {
  const x = meta(m);
  if (m.msg_type === 'share' || m.msg_type === 'comment') {
    const id = x.itemId || x.workId;
    return id ? `https://www.douyin.com/video/${id}` : '';
  }
  if (m.msg_type === 'user') {
    const id = x.secUid || x.uid;
    return id ? `https://www.douyin.com/user/${id}` : '';
  }
  return '';
}

function openExternal(url) {
  if (!url || url.startsWith('zmtjl-media:')) return;
  window.open(url, '_blank');
}

function retry(m) {
  emit('retry', m);
}

async function openFile(m) {
  const r = await api.media.open(m.media_path);
  if (!r.ok) ElMessage.error(r.error || '文件不存在');
}

function messageBrief(m) {
  const x = meta(m);
  return String(m.content || x.title || x.text || x.name || '[消息]').slice(0, 80);
}

function openContextMenu(e, m) {
  if (isSystem(m) || m.recalled) return;
  contextMenu.value = {
    x: Math.min(e.clientX, window.innerWidth - 230),
    y: Math.min(e.clientY, window.innerHeight - 300),
    message: m,
  };
}

function closeContextMenu() {
  contextMenu.value = null;
}

function replyMessage(m) {
  if (!m.server_msg_id) {
    ElMessage.warning('这条消息缺少 serverMessageId，无法回复');
    return;
  }
  replyTo.value = m;
  closeContextMenu();
  nextTick(() => composerRef.value?.focus());
}

async function copyMessage(m) {
  try {
    await navigator.clipboard.writeText(messageBrief(m));
    ElMessage.success('已复制');
  } catch {
    ElMessage.error('复制失败');
  }
  closeContextMenu();
}

async function startForward(m) {
  if (!m.server_msg_id) {
    ElMessage.warning('这条消息缺少 serverMessageId，无法转发');
    return;
  }
  forwardMessage.value = m;
  forwardTargetId.value = null;
  forwardOpen.value = true;
  closeContextMenu();
  try {
    const list = await api.conv.list(props.account.id);
    forwardTargets.value = (list ?? []).filter((c) => c.peer_uid !== props.contact.peer_uid);
  } catch {
    forwardTargets.value = [];
  }
}

async function doForward() {
  if (!forwardMessage.value || !forwardTargetId.value) return;
  forwarding.value = true;
  try {
    const r = await api.msg.forward(
      props.account.id,
      forwardMessage.value.id,
      forwardTargetId.value,
    );
    if (r.ok) {
      ElMessage.success('已转发');
      forwardOpen.value = false;
      emit('refresh');
    } else {
      ElMessage.error(r.error || '转发失败');
    }
  } catch (e) {
    ElMessage.error(e.message || '转发失败');
  } finally {
    forwarding.value = false;
  }
}

function recallMessage(m) {
  emit('recall', m);
  closeContextMenu();
}

async function deleteMessage(m) {
  closeContextMenu();
  try {
    await ElMessageBox.confirm('删除这条消息？只影响本机显示。', '删除消息', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  emit('delete', m);
}

function reactMessage(m, emoji) {
  emit('react', { message: m, emoji });
  closeContextMenu();
}

async function toggleMembers() {
  membersOpen.value = !membersOpen.value;
  if (!membersOpen.value || groupMembers.value.length) return;
  membersLoading.value = true;
  try {
    const r = await api.contact.members(props.account.id, props.contact.peer_uid);
    groupMembers.value = r.ok ? (r.members ?? []) : [];
    if (!r.ok) ElMessage.error(r.error || '加载群成员失败');
  } catch (e) {
    ElMessage.error(e.message || '加载群成员失败');
  } finally {
    membersLoading.value = false;
  }
}

function addMention(member) {
  if (!mentions.value.some((m) => m.uid === member.uid)) {
    mentions.value.push({ uid: member.uid, name: member.name });
  }
  membersOpen.value = false;
  nextTick(() => composerRef.value?.focus());
}

function removeMention(uid) {
  mentions.value = mentions.value.filter((m) => m.uid !== uid);
}

function onWindowKeydown(e) {
  if (e.key === 'Escape') {
    closeContextMenu();
    membersOpen.value = false;
    emojiOpen.value = false;
  }
}

function onWindowClick() {
  closeContextMenu();
}

onMounted(() => {
  window.addEventListener('click', onWindowClick);
  window.addEventListener('keydown', onWindowKeydown);
});

onUnmounted(() => {
  window.removeEventListener('click', onWindowClick);
  window.removeEventListener('keydown', onWindowKeydown);
});
</script>

<template>
  <section class="conversation" @drop="onDrop" @dragover.prevent>
    <div v-if="!canShow" class="conv-empty">
      <div class="ph-icon">💬</div>
      <p v-if="!account">选择左侧账号开始</p>
      <p v-else>选择联系人查看会话</p>
    </div>

    <template v-else>
      <!-- 头部 -->
      <header class="conv-head">
        <img
          v-if="contact.peer_avatar"
          class="avatar"
          :src="contact.peer_avatar"
          referrerpolicy="no-referrer"
        />
        <div v-else class="avatar placeholder">
          {{ (contact.peer_nickname || '?').slice(0, 1) }}
        </div>
        <div class="head-meta">
          <div class="n">
            {{ contact.peer_nickname || contact.peer_uid }}
            <span v-if="isGroup" class="kind-tag">群</span>
          </div>
          <div class="sub">
            UID {{ contact.peer_uid }}
            <span class="sep">·</span>
            来自 {{ account.nickname || '未知账号' }}
            <template v-if="readLabel">
              <span class="sep">·</span>
              <span class="read-label">{{ readLabel }}</span>
            </template>
          </div>
        </div>
        <div class="head-actions">
          <button :title="contact.pinned ? '取消置顶' : '置顶会话'" @click="emit('toggle-pin')">
            {{ contact.pinned ? '📌' : '📍' }}
          </button>
          <button :title="contact.muted ? '取消免打扰' : '免打扰'" @click="emit('toggle-mute')">
            {{ contact.muted ? '🔕' : '🔔' }}
          </button>
          <button :title="showProfile ? '收起资料' : '展开资料'" @click="showProfile = !showProfile">
            {{ showProfile ? '▴' : '▾' }}
          </button>
        </div>
      </header>

      <!-- 资料卡 -->
      <div v-if="showProfile" class="profile-card">
        <div class="pc-row">
          <span class="k">UID</span>
          <span class="v mono">{{ contact.peer_uid }}</span>
        </div>
        <div class="pc-row" v-if="contact.peer_sec_uid">
          <span class="k">sec_uid</span>
          <span class="v mono trunc">{{ contact.peer_sec_uid }}</span>
        </div>
        <div class="pc-row">
          <span class="k">类型</span>
          <span class="v">{{ isGroup ? '群聊' : (contact.kind === 'stranger' ? '陌生人' : '好友') }}</span>
        </div>
        <div class="pc-row">
          <span class="k">备注</span>
          <span class="v muted">未设置</span>
        </div>
      </div>

      <!-- 消息区 -->
      <div ref="listRef" class="messages" @scroll="onScroll">
        <div v-if="loading" class="hint-center">加载消息中…</div>
        <div v-else-if="!messages.length" class="hint-center">
          还没有消息
        </div>

        <template v-else>
          <div class="load-more">
            <button @click="emit('load-more')">加载更早的消息</button>
          </div>

          <template v-for="m in messages" :key="m.id">
            <div v-if="isSystem(m)" class="system-line">
              {{ m.content || meta(m).description || '[系统消息]' }}
            </div>

            <div v-else-if="m.recalled" class="recall-line">
              <span>{{ m.direction === 'out' ? '你' : '对方' }}撤回了一条消息</span>
              <span v-if="m.content && !['[图片]', '[视频]', '[表情]'].includes(m.content)" class="recall-origin">
                {{ m.content }}
              </span>
            </div>

            <div
              v-else
              class="msg-row"
              :class="{ out: m.direction === 'out' }"
              :data-msg-id="m.id"
              :data-direction="m.direction"
              :data-server-id="m.server_msg_id || ''"
              @contextmenu.prevent="openContextMenu($event, m)"
            >
              <div v-if="senderLabel(m)" class="sender">
                <img
                  v-if="m.sender_avatar"
                  class="sender-avatar"
                  :src="m.sender_avatar"
                  referrerpolicy="no-referrer"
                  @error="senderAvatarFailed(m)"
                />
                <span v-else class="sender-avatar placeholder">{{ senderLabel(m).slice(0, 1) }}</span>
                <span class="sender-name">{{ senderLabel(m) }}</span>
                <span v-if="m.sender_name && m.sender_uid" class="sender-uid">{{ m.sender_uid }}</span>
              </div>
              <div class="bubble" :class="[m.direction, m.msg_type]">
                <!-- 图片 -->
                <template v-if="m.msg_type === 'image'">
                  <img
                    v-if="imageSrc(m)"
                    class="msg-image"
                    :src="imageSrc(m)"
                    referrerpolicy="no-referrer"
                    @error="markBroken(m)"
                    @click="previewUrl = imageSrc(m)"
                  />
                  <span v-else class="text">[图片]</span>
                </template>

                <!-- 视频：有封面/地址就展示 -->
                <template v-else-if="m.msg_type === 'video'">
                  <video
                    v-if="meta(m).url"
                    class="msg-video"
                    :src="meta(m).url"
                    :poster="meta(m).coverUrl || ''"
                    controls
                    preload="metadata"
                  />
                  <img
                    v-else-if="coverSrc(m)"
                    class="msg-image"
                    :src="coverSrc(m)"
                    referrerpolicy="no-referrer"
                    @error="markBroken(m)"
                    @click="previewUrl = coverSrc(m)"
                  />
                  <span v-else class="text">[视频]</span>
                </template>

                <!-- 表情 -->
                <template v-else-if="m.msg_type === 'emoji'">
                  <img
                    v-if="imageSrc(m)"
                    class="msg-emoji"
                    :src="imageSrc(m)"
                    referrerpolicy="no-referrer"
                    @error="markBroken(m)"
                  />
                  <span v-else class="text">{{ m.content || '[表情]' }}</span>
                </template>

                <!-- 文件 -->
                <template v-else-if="m.msg_type === 'file'">
                  <div class="file-card">
                    <span class="file-icon">📎</span>
                    <div class="file-meta">
                      <div class="file-name">{{ meta(m).name || m.content || '文件' }}</div>
                      <div class="file-size">{{ fmtSize(meta(m).fileSize) }}</div>
                    </div>
                    <button
                      v-if="m.media_path"
                      class="file-download"
                      @click="openFile(m)"
                    >打开</button>
                  </div>
                </template>

                <!-- 链接卡片 -->
                <template v-else-if="m.msg_type === 'link'">
                  <div class="link-card" @click="openExternal(meta(m).url)">
                    <img
                      v-if="coverSrc(m)"
                      class="link-cover"
                      :src="coverSrc(m)"
                      referrerpolicy="no-referrer"
                      @error="markBroken(m)"
                    />
                    <div class="link-body">
                      <div class="link-title">{{ meta(m).title || m.content || '链接' }}</div>
                      <div v-if="meta(m).description" class="link-desc">{{ meta(m).description }}</div>
                      <div class="link-host">{{ meta(m).url }}</div>
                    </div>
                  </div>
                </template>

                <!-- 作品 / 评论 / 名片 -->
                <template v-else-if="['share', 'comment', 'user'].includes(m.msg_type)">
                  <div class="work-card" @click="openExternal(workUrl(m))">
                    <img
                      v-if="coverSrc(m)"
                      class="work-cover"
                      :src="coverSrc(m)"
                      referrerpolicy="no-referrer"
                      @error="markBroken(m)"
                    />
                    <div class="work-body">
                      <div class="work-title">
                        {{ meta(m).title || meta(m).text || meta(m).name || m.content || '卡片' }}
                      </div>
                      <div class="work-sub">
                        <template v-if="m.msg_type === 'share'">作品 · {{ meta(m).authorUid || '' }}</template>
                        <template v-else-if="m.msg_type === 'comment'">评论 · {{ meta(m).authorName || '' }}</template>
                        <template v-else>用户名片</template>
                      </div>
                    </div>
                  </div>
                </template>

                <!-- 文本与兜底 -->
                <template v-else>
                  <span class="text">{{ m.content || '[消息]' }}</span>
                </template>
              </div>

              <div class="meta">
                <span class="time">{{ fmtTime(m.sent_at) }}</span>
                <span class="status" :class="m.status">{{ statusIcon(m) }}</span>
                <button
                  v-if="m.direction === 'out' && m.status === 'failed'"
                  class="retry"
                  @click="retry(m)"
                >重试</button>
              </div>
            </div>
          </template>
        </template>
      </div>

      <button v-if="newMessages" class="new-msg" @click="scrollToBottom">有新消息 ↓</button>

      <!-- 输入区 -->
      <footer class="composer">
        <div v-if="replyTo" class="reply-banner">
          <span class="reply-label">
            回复 {{ replyTo.sender_name || (replyTo.direction === 'out' ? '我' : contact.peer_nickname) }}：
            {{ messageBrief(replyTo) }}
          </span>
          <button @click="replyTo = null">×</button>
        </div>

        <div v-if="mentions.length" class="mention-row">
          <span v-for="m in mentions" :key="m.uid" class="mention-chip">
            @{{ m.name }}
            <button @click="removeMention(m.uid)">×</button>
          </span>
        </div>

        <div v-if="precheck?.hits?.length" class="precheck-bar" :class="{ blocked: precheck.blocked }">
          <span class="precheck-text">
            <template v-if="precheck.blocked">🚫 含阻断词：</template>
            <template v-else>⚠ 敏感词：</template>
            {{ precheck.hits.map((h) => h.word).join('、') }}
          </span>
          <button class="rewrite-link" :disabled="rewriting" @click="doRewrite">
            {{ rewriting ? '改写中…' : '合规改写' }}
          </button>
        </div>

        <div v-if="attachments.length" class="attachment-row">
          <div v-for="a in attachments" :key="a.id" class="attachment">
            <img v-if="a.kind === 'image'" :src="a.dataUrl" class="att-thumb" />
            <span v-else class="att-file">📎</span>
            <div class="att-meta">
              <div class="att-name">{{ a.name }}</div>
              <div class="att-size">{{ fmtSize(a.size) }}</div>
            </div>
            <button class="att-remove" @click="removeAttachment(a.id)">×</button>
          </div>
        </div>

        <div class="tools">
          <button title="图片" @click="imageInput?.click()">🖼</button>
          <button title="文件" @click="fileInput?.click()">📎</button>
          <div class="emoji-wrap">
            <button title="表情" @click="emojiOpen = !emojiOpen">😊</button>
            <div v-if="emojiOpen" class="emoji-panel">
              <button
                v-for="e in EMOJIS"
                :key="e"
                class="emoji-item"
                @click="insertEmoji(e)"
              >{{ e }}</button>
            </div>
          </div>
          <div v-if="isGroup" class="member-wrap">
            <button title="提到群成员" @click="toggleMembers">@</button>
            <div v-if="membersOpen" class="member-panel" @click.stop>
              <div v-if="membersLoading" class="member-empty">加载中…</div>
              <div v-else-if="!groupMembers.length" class="member-empty">没有群成员</div>
              <button
                v-for="m in groupMembers"
                :key="m.uid"
                class="member-item"
                @click="addMention(m)"
              >
                <span class="member-avatar">{{ (m.name || '?').slice(0, 1) }}</span>
                <span class="member-name">{{ m.name }}</span>
                <span v-if="m.role === 'owner'" class="member-role">群主</span>
                <span v-else-if="m.role === 'admin'" class="member-role">管理</span>
              </button>
            </div>
          </div>
          <span v-if="checking" class="checking">检查中…</span>
        </div>

        <textarea
          ref="composerRef"
          v-model="draft"
          placeholder="输入消息，Enter 发送，Shift+Enter 换行；可直接粘贴图片"
          rows="3"
          @keydown="onKeydown"
          @paste="onPaste"
        />
        <div class="send-row">
          <span class="hint">
            {{ sending ? '发送中…' : 'Enter 发送 · 支持粘贴/拖拽图片' }}
          </span>
          <button class="send" :disabled="!canSend" @click="doSend">
            {{ sending ? '发送中' : '发送' }}
          </button>
        </div>

        <input
          ref="imageInput"
          type="file"
          accept="image/*"
          multiple
          hidden
          @change="onFileInput($event, 'image')"
        />
        <input
          ref="fileInput"
          type="file"
          multiple
          hidden
          @change="onFileInput($event, 'file')"
        />
      </footer>
    </template>

    <!-- 消息右键菜单 -->
    <div
      v-if="contextMenu"
      class="ctx-menu"
      :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
      @click.stop
    >
      <button
        :disabled="!contextMenu.message.server_msg_id"
        @click="replyMessage(contextMenu.message)"
      >回复</button>
      <button @click="copyMessage(contextMenu.message)">复制</button>
      <button
        :disabled="!contextMenu.message.server_msg_id"
        @click="startForward(contextMenu.message)"
      >转发</button>
      <button
        v-if="contextMenu.message.direction === 'out' && contextMenu.message.server_msg_id"
        @click="recallMessage(contextMenu.message)"
      >撤回</button>
      <button class="danger" @click="deleteMessage(contextMenu.message)">删除</button>
      <div class="ctx-reactions">
        <button
          v-for="e in ['👍', '❤️', '😂', '😮', '😢']"
          :key="e"
          :disabled="!contextMenu.message.server_msg_id"
          @click="reactMessage(contextMenu.message, e)"
        >{{ e }}</button>
      </div>
    </div>

    <!-- 图片预览 -->
    <div v-if="previewUrl" class="img-viewer" @click="previewUrl = null">
      <img :src="previewUrl" />
    </div>

    <!-- 合规改写 -->
    <el-dialog v-model="rewriteVisible" title="合规改写" width="560px">
      <div v-if="rewriteResult" class="rewrite-panel">
        <div class="rw-head">
          <span v-if="rewriteResult.error" class="rw-error">{{ rewriteResult.error }}</span>
          <span v-else-if="!rewriteResult.ok" class="rw-warn">仍有阻断项，需要手动删除</span>
          <span v-else class="rw-ok">可安全采用</span>
        </div>
        <div class="rw-block">
          <div class="rw-label">改写后</div>
          <div class="rw-text">{{ rewriteResult.rewritten || '（空）' }}</div>
        </div>
        <div v-if="rewriteResult.changes?.length" class="rw-list">
          <div v-for="(c, i) in rewriteResult.changes" :key="i" class="rw-item">
            <span class="rw-word">{{ c.word }}</span>
            <span class="rw-arrow">→</span>
            <span class="rw-to">{{ c.action === 'remove' ? '删除' : c.to }}</span>
            <span v-if="c.category" class="rw-cat">{{ c.category }}</span>
          </div>
        </div>
        <div v-if="rewriteResult.unresolved?.length" class="rw-unresolved">
          <div v-for="(u, i) in rewriteResult.unresolved" :key="i">
            需人工：{{ u.word }}（{{ u.message || u.category || '' }}）
          </div>
        </div>
      </div>
      <template #footer>
        <el-button @click="rewriteVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!rewriteResult?.ok" @click="adoptRewrite">采用改写</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="forwardOpen" title="转发到" width="440px">
      <div v-if="forwardMessage" class="forward-preview">
        {{ messageBrief(forwardMessage) }}
      </div>
      <div class="forward-list">
        <div v-if="!forwardTargets.length" class="member-empty">当前账号没有其他会话</div>
        <button
          v-for="c in forwardTargets"
          :key="c.peer_uid"
          class="forward-item"
          :class="{ active: forwardTargetId === c.peer_uid }"
          @click="forwardTargetId = c.peer_uid"
        >
          <span class="member-avatar">{{ (c.peer_nickname || '?').slice(0, 1) }}</span>
          <span class="forward-meta">
            <span class="member-name">{{ c.peer_nickname || c.peer_uid }}</span>
            <span class="forward-sub">{{ c.kind === 'group' ? '群聊' : c.kind === 'stranger' ? '陌生人' : '好友' }}</span>
          </span>
          <span v-if="forwardTargetId === c.peer_uid" class="forward-check">✓</span>
        </button>
      </div>
      <template #footer>
        <el-button @click="forwardOpen = false">取消</el-button>
        <el-button
          type="primary"
          :disabled="!forwardTargetId || forwarding"
          @click="doForward"
        >{{ forwarding ? '转发中…' : '转发' }}</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.conversation {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: #f7f8fa;
  position: relative;
}
.conv-empty {
  flex: 1;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 10px;
  color: var(--c-text-2);
  font-size: 14px;
}
.ph-icon { font-size: 40px; opacity: 0.35; }

.conv-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  background: #fff;
  border-bottom: 1px solid var(--c-border);
}
.avatar { width: 38px; height: 38px; border-radius: 50%; object-fit: cover; flex-shrink: 0; }
.avatar.placeholder {
  display: grid;
  place-items: center;
  background: #e3e5e9;
  color: var(--c-text-2);
}
.head-meta { flex: 1; min-width: 0; }
.n { font-size: 15px; font-weight: 600; }
.kind-tag {
  display: inline-block;
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 4px;
  background: #eef3ff;
  color: var(--c-primary);
  font-size: 10px;
  font-weight: 400;
}
.sub { font-size: 12px; color: var(--c-text-2); margin-top: 2px; }
.sep { margin: 0 4px; color: var(--c-text-3); }
.read-label { color: var(--c-online); }
.head-actions button {
  border: 1px solid var(--c-border);
  background: #fff;
  border-radius: 6px;
  width: 30px;
  height: 30px;
  color: var(--c-text-2);
}

.profile-card {
  background: #fff;
  margin: 10px 16px 0;
  border: 1px solid var(--c-border);
  border-radius: 8px;
  padding: 10px 12px;
}
.pc-row { display: flex; gap: 10px; padding: 3px 0; font-size: 12px; }
.pc-row .k { width: 52px; color: var(--c-text-2); flex-shrink: 0; }
.pc-row .v { color: var(--c-text); min-width: 0; }
.pc-row .muted { color: var(--c-text-3); }
.mono { font-family: ui-monospace, Consolas, monospace; font-size: 11px; }
.trunc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.messages {
  flex: 1;
  overflow-y: auto;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.hint-center {
  margin: auto;
  color: var(--c-text-3);
  font-size: 13px;
}
.load-more { text-align: center; margin-bottom: 6px; }
.load-more button {
  border: none;
  background: transparent;
  color: var(--c-primary);
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 4px;
}
.load-more button:hover { background: #eaf1ff; }

.system-line {
  align-self: center;
  max-width: 80%;
  padding: 3px 10px;
  border-radius: 10px;
  background: #eef0f3;
  color: var(--c-text-3);
  font-size: 11px;
  text-align: center;
}
.recall-line {
  align-self: center;
  max-width: 80%;
  color: var(--c-text-3);
  font-size: 11px;
  text-align: center;
}
.recall-origin {
  display: block;
  margin-top: 2px;
  opacity: 0.75;
  text-decoration: line-through;
}

.msg-row {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  max-width: 70%;
}
.msg-row.out { align-self: flex-end; align-items: flex-end; }
.sender {
  margin: 0 0 3px 4px;
  font-size: 11px;
  color: var(--c-text-2);
  display: flex; align-items: center; gap: 5px;
}
.sender-avatar {
  width: 18px; height: 18px; border-radius: 50%; object-fit: cover;
  flex-shrink: 0; background: #eef0f3;
}
.sender-avatar.placeholder {
  display: grid; place-items: center; font-size: 10px; color: var(--c-text-2);
}
.sender-name { color: var(--c-text-2); }
.sender-uid { color: var(--c-text-3); font-family: ui-monospace, Consolas, monospace; }
.bubble {
  padding: 8px 12px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.55;
  word-break: break-word;
  white-space: pre-wrap;
  max-width: 100%;
}
.bubble.in { background: #fff; border: 1px solid var(--c-border); }
.bubble.out { background: var(--c-primary); color: #fff; }
.bubble.unknown { background: #f0f1f4; color: var(--c-text-2); font-style: italic; }
.bubble.image, .bubble.video, .bubble.file, .bubble.link, .bubble.share, .bubble.comment, .bubble.user {
  padding: 4px;
  background: #fff;
  border: 1px solid var(--c-border);
}
.bubble.out.image, .bubble.out.video, .bubble.out.file, .bubble.out.link, .bubble.out.share, .bubble.out.comment, .bubble.out.user {
  background: #eef3ff;
  border-color: #d7e3ff;
}
.msg-image {
  display: block;
  max-width: 280px;
  max-height: 320px;
  border-radius: 8px;
  object-fit: cover;
  cursor: zoom-in;
}
.msg-video {
  display: block;
  max-width: 280px;
  max-height: 320px;
  border-radius: 8px;
  background: #000;
}
.msg-emoji {
  display: block;
  width: 100px;
  height: 100px;
  object-fit: contain;
}
.file-card {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 210px;
  padding: 8px;
  border-radius: 8px;
  background: #fff;
}
.bubble.out .file-card { background: #fff; color: var(--c-text); }
.file-icon { font-size: 20px; }
.file-meta { min-width: 0; flex: 1; }
.file-name {
  font-size: 12px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-size { font-size: 11px; color: var(--c-text-3); margin-top: 2px; }
.file-download {
  flex-shrink: 0;
  border: none;
  background: transparent;
  font-size: 11px;
  color: var(--c-primary);
  text-decoration: none;
  cursor: pointer;
}
.link-card, .work-card {
  display: flex;
  gap: 8px;
  width: 280px;
  padding: 8px;
  border-radius: 8px;
  background: #fff;
  cursor: pointer;
  color: var(--c-text);
}
.bubble.out .link-card, .bubble.out .work-card { background: #fff; }
.link-cover, .work-cover {
  width: 64px;
  height: 64px;
  border-radius: 6px;
  object-fit: cover;
  flex-shrink: 0;
  background: #eef0f3;
}
.link-body, .work-body { min-width: 0; flex: 1; }
.link-title, .work-title {
  font-size: 12px;
  font-weight: 500;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.link-desc {
  margin-top: 3px;
  font-size: 11px;
  color: var(--c-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.link-host {
  margin-top: 4px;
  font-size: 10px;
  color: var(--c-text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.work-sub { margin-top: 5px; font-size: 11px; color: var(--c-text-3); }

.meta {
  display: flex;
  gap: 4px;
  align-items: center;
  margin-top: 3px;
  font-size: 11px;
  color: var(--c-text-3);
}
.status.sent { color: var(--c-online); }
.status.failed { color: var(--c-danger); }
.status.unknown { color: var(--c-warn); }
.retry {
  border: none;
  background: transparent;
  color: var(--c-danger);
  font-size: 11px;
  padding: 0 2px;
  cursor: pointer;
}

.new-msg {
  position: absolute;
  left: 50%;
  bottom: 150px;
  transform: translateX(-50%);
  border: none;
  border-radius: 12px;
  padding: 4px 12px;
  background: var(--c-primary);
  color: #fff;
  font-size: 11px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.16);
  z-index: 3;
}

.composer {
  background: #fff;
  border-top: 1px solid var(--c-border);
  padding: 8px 16px 10px;
}
.precheck-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
  padding: 5px 8px;
  border-radius: 5px;
  background: #fff8e6;
  border: 1px solid #ffe0a3;
  color: #8a5a00;
  font-size: 11px;
}
.precheck-bar.blocked {
  background: #fff1f0;
  border-color: #ffc9c9;
  color: #b42318;
}
.precheck-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rewrite-link {
  flex-shrink: 0;
  border: none;
  background: transparent;
  color: var(--c-primary);
  font-size: 11px;
  cursor: pointer;
}
.attachment-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}
.attachment {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  background: #fafbfc;
}
.att-thumb {
  width: 34px;
  height: 34px;
  border-radius: 4px;
  object-fit: cover;
}
.att-file { font-size: 18px; }
.att-meta { max-width: 150px; }
.att-name {
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.att-size { font-size: 10px; color: var(--c-text-3); }
.att-remove {
  border: none;
  background: transparent;
  color: var(--c-text-3);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}
.tools {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 6px;
  position: relative;
}
.tools > button, .emoji-wrap > button {
  border: none;
  background: transparent;
  font-size: 16px;
  padding: 2px 4px;
  border-radius: 4px;
  cursor: pointer;
}
.tools > button:hover, .emoji-wrap > button:hover { background: #f0f1f4; }
.emoji-wrap { position: relative; }
.emoji-panel {
  position: absolute;
  left: 0;
  bottom: 30px;
  z-index: 10;
  width: 250px;
  display: grid;
  grid-template-columns: repeat(10, 1fr);
  gap: 2px;
  padding: 8px;
  background: #fff;
  border: 1px solid var(--c-border);
  border-radius: 8px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.14);
}
.emoji-item {
  border: none;
  background: transparent;
  font-size: 18px;
  padding: 2px;
  border-radius: 4px;
  cursor: pointer;
}
.emoji-item:hover { background: #f0f1f4; }
.checking { font-size: 10px; color: var(--c-text-3); margin-left: 4px; }
.composer textarea {
  width: 100%;
  resize: none;
  border: 1px solid var(--c-border);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 13px;
  font-family: inherit;
  outline: none;
  background: #fafbfc;
}
.composer textarea:focus {
  border-color: var(--c-primary);
  background: #fff;
}
.send-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
}
.hint { font-size: 11px; color: var(--c-text-3); }
.send {
  height: 28px;
  padding: 0 16px;
  border-radius: 6px;
  border: none;
  background: var(--c-primary);
  color: #fff;
  font-size: 13px;
}
.send:disabled { background: #c9cdd4; cursor: not-allowed; }

.img-viewer {
  position: fixed;
  inset: 0;
  z-index: 3000;
  background: rgba(0, 0, 0, 0.78);
  display: grid;
  place-items: center;
  cursor: zoom-out;
}
.img-viewer img {
  max-width: 88vw;
  max-height: 88vh;
  border-radius: 6px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4);
}

.rewrite-panel { font-size: 12px; }
.rw-head { margin-bottom: 7px; font-weight: 600; }
.rw-ok { color: #1a7f37; }
.rw-warn { color: #b76e00; }
.rw-error { color: var(--c-danger); }
.rw-block { background: #fafbfc; border: 1px solid var(--c-border); border-radius: 6px; padding: 8px; }
.rw-label { font-size: 11px; color: var(--c-text-3); margin-bottom: 4px; }
.rw-text { line-height: 1.7; word-break: break-all; }
.rw-list { margin-top: 8px; display: flex; flex-direction: column; gap: 3px; }
.rw-item { display: flex; align-items: baseline; gap: 6px; }
.rw-word { padding: 0 5px; border-radius: 3px; background: #ffece9; color: #d4380d; }
.rw-arrow { color: var(--c-text-3); }
.rw-to { color: #1a7f37; }
.rw-cat { color: var(--c-text-3); font-size: 11px; }
.rw-unresolved {
  margin-top: 8px; padding: 6px 8px; border-radius: 5px;
  background: #fff7e8; color: #9a6a12; font-size: 11px; line-height: 1.6;
}

.ctx-menu {
  position: fixed;
  z-index: 4000;
  width: 200px;
  padding: 5px;
  background: #fff;
  border: 1px solid var(--c-border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
}
.ctx-menu > button {
  width: 100%;
  border: none;
  background: transparent;
  text-align: left;
  padding: 7px 9px;
  border-radius: 5px;
  font-size: 12px;
  color: var(--c-text);
}
.ctx-menu > button:hover { background: #f4f5f7; }
.ctx-menu > button:disabled { color: var(--c-text-3); cursor: not-allowed; }
.ctx-menu > button.danger { color: var(--c-danger); }
.ctx-reactions {
  display: flex;
  gap: 2px;
  margin-top: 4px;
  padding: 5px 4px 2px;
  border-top: 1px solid var(--c-border);
}
.ctx-reactions button {
  flex: 1;
  border: none;
  background: transparent;
  font-size: 16px;
  padding: 2px 0;
  border-radius: 4px;
}
.ctx-reactions button:hover { background: #f4f5f7; }
.ctx-reactions button:disabled { opacity: 0.35; cursor: not-allowed; }

.reply-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
  padding: 5px 8px;
  border-left: 3px solid var(--c-primary);
  border-radius: 4px;
  background: #f3f7ff;
  color: var(--c-text-2);
  font-size: 11px;
}
.reply-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.reply-banner button {
  border: none;
  background: transparent;
  color: var(--c-text-2);
  font-size: 15px;
  line-height: 1;
}
.mention-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 6px;
}
.mention-chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px 6px;
  border-radius: 10px;
  background: #eef3ff;
  color: var(--c-primary);
  font-size: 11px;
}
.mention-chip button {
  border: none;
  background: transparent;
  color: var(--c-primary);
  padding: 0;
  font-size: 12px;
  line-height: 1;
}
.member-wrap { position: relative; }
.member-panel {
  position: absolute;
  left: 0;
  bottom: 30px;
  z-index: 20;
  width: 240px;
  max-height: 300px;
  overflow-y: auto;
  padding: 6px;
  background: #fff;
  border: 1px solid var(--c-border);
  border-radius: 8px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.14);
}
.member-empty {
  padding: 16px 8px;
  text-align: center;
  color: var(--c-text-3);
  font-size: 12px;
}
.member-item, .forward-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  text-align: left;
}
.member-item:hover, .forward-item:hover { background: #f4f5f7; }
.member-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: #e3e5e9;
  color: var(--c-text-2);
  display: grid;
  place-items: center;
  font-size: 12px;
  flex-shrink: 0;
}
.member-name {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.member-role {
  font-size: 10px;
  color: var(--c-primary);
  background: #eef3ff;
  padding: 0 4px;
  border-radius: 3px;
}
.forward-preview {
  margin-bottom: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  background: #f7f8fa;
  color: var(--c-text-2);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.forward-list {
  max-height: 340px;
  overflow-y: auto;
}
.forward-item.active { background: var(--c-primary-light); }
.forward-meta { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.forward-sub { font-size: 10px; color: var(--c-text-3); margin-top: 2px; }
.forward-check { color: var(--c-primary); font-size: 14px; }
</style>
