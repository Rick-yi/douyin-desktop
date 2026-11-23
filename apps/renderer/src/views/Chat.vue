<script setup>
import { api } from '../api.js';
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { ElMessage } from 'element-plus';
import { pendingChat, clearPendingChat } from '../nav.js';
import AccountList from '../components/AccountList.vue';
import ContactList from '../components/ContactList.vue';
import Conversation from '../components/Conversation.vue';

const props = defineProps({
  accounts: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
});
const emit = defineEmits(['refresh-accounts']);

const selectedAccountId = ref(null);
const selectedContact = ref(null);
const conversations = ref([]);
const messages = ref([]);
const loadingConv = ref(false);
const loadingMsg = ref(false);
const sending = ref(false);
const readState = ref(null);
const prefillText = ref('');
const unsubs = [];
const enrichedGroups = new Set();

const selectedAccount = computed(
  () => props.accounts.find((a) => a.id === selectedAccountId.value) ?? null,
);

watch(
  () => props.accounts,
  (list) => {
    if (!selectedAccountId.value && list.length) {
      selectedAccountId.value = list[0].id;
    }
  },
  { immediate: true },
);

watch(
  selectedAccountId,
  async (id) => {
    selectedContact.value = null;
    messages.value = [];
    conversations.value = [];
    readState.value = null;
    if (!id) return;
    await loadConversations(id);
  },
  { immediate: true },
);

watch(
  pendingChat,
  async (req) => {
    if (!req) return;
    if (req.accountId) selectedAccountId.value = req.accountId;
    await nextTick();
    await loadConversations(req.accountId);
    let c = conversations.value.find((x) => x.peer_uid === req.peerUid);
    if (!c && req.peerUid) {
      // 还没有会话的陌生人：先建一个临时会话，首条消息发送后会落成正式会话
      c = {
        peer_uid: String(req.peerUid),
        peer_nickname: req.peerName || String(req.peerUid),
        peer_sec_uid: req.peerSecUid || null,
        peer_avatar: req.peerAvatar || null,
        kind: 'stranger',
        unread_count: 0,
        pinned: 0,
        muted: 0,
        last_msg_at: null,
        last_msg_preview: '',
        __draft: true,
      };
      conversations.value = [c, ...conversations.value];
    }
    if (c) {
      await onPickContact(c);
      prefillText.value = req.text || '';
    }
    clearPendingChat();
  },
  { immediate: true },
);

async function reloadMessages() {
  if (!selectedAccountId.value || !selectedContact.value) return;
  messages.value = await api.msg.list(
    selectedAccountId.value,
    selectedContact.value.peer_uid,
    { limit: 50 },
  );
}

async function loadConversations(accountId) {
  loadingConv.value = true;
  try {
    conversations.value = await api.conv.list(accountId);
  } catch (e) {
    console.error('加载会话失败', e);
  } finally {
    loadingConv.value = false;
  }
}

async function onPickContact(c) {
  selectedContact.value = c;
  readState.value = null;
  if (!selectedAccountId.value || !c) return;
  loadingMsg.value = true;
  try {
    messages.value = await api.msg.list(selectedAccountId.value, c.peer_uid, { limit: 50 });
  } catch (e) {
    console.error('加载消息失败', e);
  } finally {
    loadingMsg.value = false;
  }

  // 标记已读：本地清未读 + 调 SDK 同步平台已读。不阻塞消息显示。
  try {
    const mr = await api.msg.markRead(selectedAccountId.value, c.peer_uid);
    readState.value = mr?.receipt ?? null;
    c.unread_count = 0;
  } catch {}

  // 群聊首次打开时补全成员昵称/头像，并回填历史消息的发送者资料
  if (c.kind === 'group' && !enrichedGroups.has(c.peer_uid)) {
    try {
      const r = await api.contact.members(selectedAccountId.value, c.peer_uid);
      if (r?.ok) {
        enrichedGroups.add(c.peer_uid);
        await reloadMessages();
      }
    } catch {}
  }
}

function showSendError(r) {
  if (r?.reason === 'sensitive') {
    ElMessage.error(`内容含敏感词：${(r.hits ?? []).map((h) => h.word).join('、')}`);
  } else if (r?.reason === 'not_ready') {
    ElMessage.error('账号未就绪，请到「账号管理」检查登录状态');
  } else if (r?.reason === 'license') {
    ElMessage({ type: 'warning', message: `${r.error || '需要激活'}，请到「授权」页面激活`, duration: 6000 });
  } else {
    ElMessage.error(r?.error || r?.detail || r?.statusMsg || '发送失败');
  }
}

async function sendMessage(payload, done) {
  const text = typeof payload === 'string' ? payload : String(payload?.text ?? '');
  const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
  if (!selectedAccountId.value || !selectedContact.value) {
    done?.(false);
    return;
  }
  if (!text.trim() && !attachments.length) {
    done?.(false);
    return;
  }

  sending.value = true;
  let okAll = true;
  try {
    for (const a of attachments) {
      const r = a.kind === 'image'
        ? await api.msg.sendImage(selectedAccountId.value, selectedContact.value.peer_uid, {
            base64: a.base64,
            mime: a.mime,
            name: a.name,
          })
        : await api.msg.sendFile(selectedAccountId.value, selectedContact.value.peer_uid, {
            base64: a.base64,
            mime: a.mime,
            name: a.name,
          });
      if (!r.ok) {
        okAll = false;
        showSendError(r);
        break;
      }
    }

    if (okAll && text.trim()) {
      const r = await api.msg.send(
        selectedAccountId.value,
        selectedContact.value.peer_uid,
        text.trim(),
        {
          replyTo: payload?.replyTo ?? null,
          mentions: payload?.mentions ?? [],
        },
      );
      if (!r.ok) {
        okAll = false;
        showSendError(r);
      }
    }

    if (okAll) {
      await reloadMessages();
      await loadConversations(selectedAccountId.value);
      // 临时陌生人会话发送成功后，替换成正式会话对象
      const real = conversations.value.find((x) => x.peer_uid === selectedContact.value?.peer_uid);
      if (real) selectedContact.value = real;
      const receipt = await api.msg.readReceipt(
        selectedAccountId.value,
        selectedContact.value.peer_uid,
      ).catch(() => null);
      if (receipt?.ok) readState.value = receipt;
    }
  } catch (e) {
    okAll = false;
    ElMessage.error(e.message || '发送失败');
  } finally {
    sending.value = false;
    done?.(okAll);
  }
}

async function retryMessage(m) {
  if (!selectedAccountId.value || !m?.id) return;
  const r = await api.msg.retry(selectedAccountId.value, m.id);
  if (r.ok) {
    ElMessage.success('已重新发送');
    await reloadMessages();
    await loadConversations(selectedAccountId.value);
  } else {
    ElMessage.error(r.error || '重试失败');
  }
}

async function togglePin() {
  if (!selectedAccountId.value || !selectedContact.value) return;
  const next = !selectedContact.value.pinned;
  const r = await api.conv.pin(selectedAccountId.value, selectedContact.value.peer_uid, next);
  if (!r.ok) {
    ElMessage.error(r.error || '置顶失败');
    return;
  }
  selectedContact.value.pinned = next;
  await loadConversations(selectedAccountId.value);
}

async function toggleMute() {
  if (!selectedAccountId.value || !selectedContact.value) return;
  const next = !selectedContact.value.muted;
  const r = await api.conv.mute(selectedAccountId.value, selectedContact.value.peer_uid, next);
  if (!r.ok) {
    ElMessage.error(r.error || '免打扰设置失败');
    return;
  }
  selectedContact.value.muted = next;
  await loadConversations(selectedAccountId.value);
}

async function recallMessage(m) {
  if (!selectedAccountId.value || !m?.id) return;
  const r = await api.msg.recall(selectedAccountId.value, m.id);
  if (r.ok) {
    ElMessage.success('已撤回');
    await reloadMessages();
    await loadConversations(selectedAccountId.value);
  } else {
    ElMessage.error(r.error || '撤回失败');
  }
}

async function deleteMessage(m) {
  if (!selectedAccountId.value || !m?.id) return;
  const r = await api.msg.delete(selectedAccountId.value, m.id);
  if (r.ok) {
    ElMessage.success(r.warning || '已删除');
    await reloadMessages();
    await loadConversations(selectedAccountId.value);
  } else {
    ElMessage.error(r.error || '删除失败');
  }
}

async function reactMessage({ message, emoji }) {
  if (!selectedAccountId.value || !message?.id) return;
  const r = await api.msg.react(selectedAccountId.value, message.id, emoji);
  if (r.ok) ElMessage.success('已表态');
  else ElMessage.error(r.error || '表态失败');
}

async function refreshConversation() {
  await reloadMessages();
  if (selectedAccountId.value) await loadConversations(selectedAccountId.value);
}

async function loadMore() {
  if (!selectedAccountId.value || !selectedContact.value) return;
  try {
    const r = await api.msg.history(
      selectedAccountId.value,
      selectedContact.value.peer_uid,
    );
    if (r.ok) {
      messages.value = await api.msg.list(
        selectedAccountId.value,
        selectedContact.value.peer_uid,
        { limit: 200 },
      );
      if (!r.hasMore) ElMessage.info('没有更早的消息了');
    }
  } catch (e) {
    ElMessage.error('加载历史失败');
  }
}

// ── 实时新消息 ──
function bindEvents() {
  unsubs.push(
    api.on('message:new', (p) => {
      // 当前正在看的会话，直接追加
      if (
        p.accountId === selectedAccountId.value &&
        selectedContact.value &&
        p.peerUid === selectedContact.value.peer_uid
      ) {
        if (p.inserted > 0) {
          reloadMessages().catch(() => {});
        }
        api.msg.markRead(selectedAccountId.value, p.peerUid).then((r) => {
          if (r?.receipt) readState.value = r.receipt;
        }).catch(() => {});
      }
      // 刷新会话列表（未读数变了）
      if (p.accountId === selectedAccountId.value) {
        loadConversations(selectedAccountId.value);
      }
    }),
  );
  unsubs.push(
    api.on('message:recall', (p) => {
      if (p.accountId === selectedAccountId.value) {
        if (selectedContact.value) reloadMessages().catch(() => {});
        loadConversations(selectedAccountId.value);
      }
    }),
  );
  unsubs.push(
    api.on('autoreply:event', (p) => {
      if (p?.accountId !== selectedAccountId.value) return;
      if (selectedContact.value && p.peerUid === selectedContact.value.peer_uid) {
        reloadMessages().catch(() => {});
      }
      loadConversations(selectedAccountId.value);
    }),
  );
  unsubs.push(
    api.on('accounts:changed', () => emit('refresh-accounts')),
  );
}

onMounted(bindEvents);
onUnmounted(() => {
  for (const u of unsubs) u();
});
</script>

<template>
  <div class="chat-view">
    <AccountList
      :accounts="accounts"
      :loading="loading"
      :selected-id="selectedAccountId"
      @select="selectedAccountId = $event"
      @refresh="emit('refresh-accounts')"
    />

    <ContactList
      :account="selectedAccount"
      :contacts="conversations"
      :selected="selectedContact"
      :loading="loadingConv"
      @select="onPickContact"
    />

    <Conversation
      :account="selectedAccount"
      :contact="selectedContact"
      :messages="messages"
      :loading="loadingMsg"
      :sending="sending"
      :read-state="readState"
      :prefill="prefillText"
      @send="sendMessage"
      @retry="retryMessage"
      @load-more="loadMore"
      @refresh="refreshConversation"
      @recall="recallMessage"
      @delete="deleteMessage"
      @react="reactMessage"
      @toggle-pin="togglePin"
      @toggle-mute="toggleMute"
    />
  </div>
</template>

<style scoped>
.chat-view {
  flex: 1;
  display: flex;
  min-width: 0;
}
</style>
