<script setup>
import { ref, computed } from 'vue';

const props = defineProps({
  accounts: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  selectedId: { type: String, default: null },
});
const emit = defineEmits(['select', 'refresh']);

const keyword = ref('');

const filtered = computed(() => {
  const k = keyword.value.trim().toLowerCase();
  if (!k) return props.accounts;
  return props.accounts.filter(
    (a) =>
      (a.nickname || '').toLowerCase().includes(k) ||
      (a.douyin_id || '').toLowerCase().includes(k),
  );
});

// 按未分组/分组归并（P1 简化为「全部」+「未分组」）
const grouped = computed(() => {
  const noGroup = filtered.value.filter((a) => !a.group_id);
  return { noGroup, total: filtered.value.length };
});

function avatarFailed(a) {
  // 头像 URL 过期/被拦截时回退到昵称首字，避免出现破图
  a.avatar_local_url = '';
  a.avatar_url = '';
}

function statusDot(a) {
  if (a.conn_state === 'online') return 'ok';
  if (a.conn_state === 'reconnecting') return 'warn';
  if (a.conn_state === 'expired' || a.status === 'expired' || a.status === 'blocked') return 'bad';
  if (a.risk_level === 'warning') return 'warn';
  if (a.conn_state === 'offline') return 'off';
  if (a.status === 'warm' || a.status === 'hot') return 'ok';
  return 'off';
}
</script>

<template>
  <aside class="account-list">
    <header class="head">
      <button class="add" @click="$emit('refresh')" title="刷新账号列表">↻</button>
      <h3>账号</h3>
      <span class="count">{{ accounts.length }}</span>
    </header>

    <div class="search">
      <input v-model="keyword" placeholder="搜索账号" />
    </div>

    <div class="body">
      <div class="section-title">
        <span>▣ 全部账号</span>
      </div>
      <div class="section-title sub">
        <span>▾ ● 未分组</span>
        <span class="num">{{ grouped.noGroup.length }}</span>
      </div>

      <div v-if="loading" class="empty">加载中…</div>
      <div v-else-if="!filtered.length" class="empty">
        <p>还没有账号</p>
        <p class="hint">到「账号管理」里添加</p>
      </div>

      <button
        v-for="a in grouped.noGroup"
        :key="a.id"
        class="acc-item"
        :class="{ active: selectedId === a.id }"
        @click="$emit('select', a.id)"
      >
        <img
          v-if="a.avatar_local_url || a.avatar_url"
          class="avatar"
          :src="a.avatar_local_url || a.avatar_url"
          referrerpolicy="no-referrer"
          @error="avatarFailed(a)"
        />
        <div v-else class="avatar placeholder">{{ (a.nickname || '?').slice(0, 1) }}</div>

        <div class="meta">
          <div class="name">
            <span class="dot" :class="statusDot(a)" />
            <span class="txt">{{ a.nickname || '未命名' }}</span>
            <span v-if="a.is_verified" class="v-badge">蓝V</span>
          </div>
          <div class="sub-id">{{ a.douyin_id || a.uid || '—' }}</div>
        </div>
      </button>
    </div>
  </aside>
</template>

<style scoped>
.account-list {
  width: 236px;
  flex-shrink: 0;
  border-right: 1px solid var(--c-border);
  display: flex;
  flex-direction: column;
  background: #fbfbfc;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 12px 8px;
}
.add {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  border: 1px solid var(--c-border);
  background: #fff;
  color: var(--c-text-2);
  font-size: 15px;
  line-height: 1;
}
.add:hover {
  border-color: var(--c-primary);
  color: var(--c-primary);
}
.head h3 {
  font-size: 15px;
  font-weight: 600;
  flex: 1;
}
.count {
  font-size: 12px;
  color: var(--c-text-2);
}
.search {
  padding: 0 12px 10px;
}
.search input {
  width: 100%;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  background: #fff;
  font-size: 13px;
  outline: none;
}
.search input:focus {
  border-color: var(--c-primary);
}
.body {
  flex: 1;
  overflow-y: auto;
  padding: 0 8px 12px;
}
.section-title {
  display: flex;
  justify-content: space-between;
  padding: 8px 6px 6px;
  font-size: 13px;
  color: var(--c-text);
  font-weight: 500;
}
.section-title.sub {
  font-weight: 400;
  color: var(--c-text-2);
  font-size: 12px;
}
.num {
  color: var(--c-text-2);
}
.empty {
  padding: 24px 8px;
  text-align: center;
  color: var(--c-text-2);
  font-size: 13px;
}
.empty .hint {
  font-size: 12px;
  color: var(--c-text-3);
  margin-top: 4px;
}
.acc-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  text-align: left;
  margin-bottom: 2px;
}
.acc-item:hover {
  background: #f0f1f4;
}
.acc-item.active {
  background: var(--c-primary-light);
}
.avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}
.avatar.placeholder {
  display: grid;
  place-items: center;
  background: #e3e5e9;
  color: var(--c-text-2);
  font-size: 14px;
}
.meta {
  min-width: 0;
  flex: 1;
}
.name {
  display: flex;
  align-items: center;
  gap: 4px;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.dot.ok { background: var(--c-online); }
.dot.warn { background: var(--c-warn); }
.dot.bad { background: var(--c-danger); }
.dot.off { background: var(--c-text-3); }
.txt {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.v-badge {
  font-size: 10px;
  padding: 0 3px;
  border-radius: 3px;
  background: #fff3e0;
  color: #e67700;
  flex-shrink: 0;
}
.sub-id {
  font-size: 11px;
  color: var(--c-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
