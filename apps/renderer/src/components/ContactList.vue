<script setup>
import { ref, computed } from 'vue';

const props = defineProps({
  account: { type: Object, default: null },
  contacts: { type: Array, default: () => [] },
  selected: { type: Object, default: null },
  loading: { type: Boolean, default: false },
});
const emit = defineEmits(['select']);

const keyword = ref('');

const filtered = computed(() => {
  const k = keyword.value.trim().toLowerCase();
  if (!k) return props.contacts;
  return props.contacts.filter(
    (c) =>
      (c.peer_nickname || '').toLowerCase().includes(k) ||
      (c.peer_douyin_id || '').toLowerCase().includes(k) ||
      (c.peer_uid || '').toLowerCase().includes(k),
  );
});

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
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
</script>

<template>
  <section class="contact-list">
    <header class="head">
      <h3 v-if="account">
        {{ account.nickname || '未命名' }} 的联系人
      </h3>
      <h3 v-else>请选择账号</h3>
    </header>

    <div class="search">
      <input v-model="keyword" placeholder="搜索联系人" :disabled="!account" />
    </div>

    <div class="body">
      <div v-if="!account" class="empty">先在左侧选一个账号</div>
      <div v-else-if="loading" class="empty">加载中…</div>
      <div v-else-if="!filtered.length" class="empty">
        <p>暂无联系人</p>
        <p class="hint">到「账号管理」点「同步联系人」</p>
      </div>

      <button
        v-for="c in filtered"
        :key="c.id"
        class="ct-item"
        :class="{ active: selected?.id === c.id }"
        @click="emit('select', c)"
      >
        <img
          v-if="c.peer_avatar"
          class="avatar"
          :src="c.peer_avatar"
          referrerpolicy="no-referrer"
        />
        <div v-else class="avatar placeholder">
          {{ (c.peer_nickname || '?').slice(0, 1) }}
        </div>

        <div class="meta">
          <div class="row1">
            <span class="name">{{ c.peer_nickname || '未命名' }}</span>
            <span v-if="c.kind === 'group'" class="kind">群</span>
            <span v-else-if="c.kind === 'stranger'" class="kind stranger">陌生人</span>
            <span v-if="c.pinned" class="flag" title="已置顶">📌</span>
            <span v-if="c.muted" class="flag" title="免打扰">🔕</span>
            <span class="time">{{ fmtTime(c.last_msg_at) }}</span>
          </div>
          <div class="row2">
            <span class="id">{{ c.peer_douyin_id || c.peer_uid }}</span>
          </div>
          <div class="row3">
            <span class="preview">{{ c.last_msg_preview || '' }}</span>
            <span v-if="c.unread_count > 0" class="badge">{{ c.unread_count }}</span>
          </div>
        </div>
      </button>
    </div>
  </section>
</template>

<style scoped>
.contact-list {
  width: 280px;
  flex-shrink: 0;
  border-right: 1px solid var(--c-border);
  display: flex;
  flex-direction: column;
  background: #fff;
}
.head {
  padding: 14px 14px 10px;
}
.head h3 {
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.search {
  padding: 0 14px 10px;
}
.search input {
  width: 100%;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  font-size: 13px;
  outline: none;
  background: #f7f8fa;
}
.search input:focus {
  border-color: var(--c-primary);
  background: #fff;
}
.body {
  flex: 1;
  overflow-y: auto;
  padding: 0 8px 12px;
}
.empty {
  padding: 28px 10px;
  text-align: center;
  color: var(--c-text-2);
  font-size: 13px;
}
.empty .hint {
  font-size: 12px;
  color: var(--c-text-3);
  margin-top: 5px;
}
.ct-item {
  width: 100%;
  display: flex;
  gap: 10px;
  padding: 9px 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  text-align: left;
}
.ct-item:hover {
  background: #f5f6f8;
}
.ct-item.active {
  background: var(--c-primary-light);
}
.avatar {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}
.avatar.placeholder {
  display: grid;
  place-items: center;
  background: #e3e5e9;
  color: var(--c-text-2);
  font-size: 15px;
}
.meta {
  flex: 1;
  min-width: 0;
}
.row1, .row2, .row3 {
  display: flex;
  align-items: center;
  gap: 6px;
}
.name {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kind {
  flex-shrink: 0;
  padding: 0 4px;
  border-radius: 3px;
  background: #eef3ff;
  color: var(--c-primary);
  font-size: 10px;
}
.kind.stranger {
  background: #f3f0ff;
  color: #6b4fd8;
}
.flag {
  font-size: 10px;
  flex-shrink: 0;
}
.time {
  margin-left: auto;
  font-size: 11px;
  color: var(--c-text-3);
  flex-shrink: 0;
}
.id {
  font-size: 11px;
  color: var(--c-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.preview {
  font-size: 12px;
  color: var(--c-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.badge {
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--c-danger);
  color: #fff;
  font-size: 11px;
  line-height: 16px;
  text-align: center;
  flex-shrink: 0;
}
</style>
