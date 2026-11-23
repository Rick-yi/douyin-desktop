import { ref } from 'vue';

/**
 * 跨页面跳转到聊天。
 * 用法：openChat({ accountId, peerUid, text })
 */
export const pendingChat = ref(null);

export function openChat(payload) {
  pendingChat.value = { ...payload, ts: Date.now() };
}

export function clearPendingChat() {
  pendingChat.value = null;
}
