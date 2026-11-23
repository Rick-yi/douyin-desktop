<script setup>
import { api } from './api.js';
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { pendingChat } from './nav.js';
import IconNav from './components/IconNav.vue';
import Chat from './views/Chat.vue';
import Accounts from './views/Accounts.vue';
import Logs from './views/Logs.vue';
import Broadcast from './views/Broadcast.vue';
import Sensitive from './views/Sensitive.vue';
import AutoReply from './views/AutoReply.vue';
import Cards from './views/Cards.vue';
import Intercept from './views/Intercept.vue';
import Competitors from './views/Competitors.vue';
import Proxy from './views/Proxy.vue';
import License from './views/License.vue';
import Settings from './views/Settings.vue';
import Placeholder from './views/Placeholder.vue';

const activeMenu = ref('chat');

watch(pendingChat, (v) => {
  if (v) activeMenu.value = 'chat';
});

const menus = [
  { key: 'chat', icon: '💬', label: '消息聚合' },
  { key: 'accounts', icon: '👤', label: '账号管理' },
  { key: 'proxy', icon: '🌐', label: '代理IP' },
  { key: 'autoreply', icon: '🤖', label: '自动回复' },
  { key: 'cards', icon: '📇', label: '卡片管理' },
  { key: 'broadcast', icon: '📤', label: '智能群发' },
  { key: 'intercept', icon: '⚡', label: '线索雷达' },
  { key: 'competitors', icon: '🏢', label: '同行监控' },
  { key: 'logs', icon: '📋', label: '发送日志' },
  { key: 'sensitive', icon: '📚', label: '话术库' },
  { key: 'settings', icon: '⚙️', label: '设置' },
  { key: 'license', icon: '🔑', label: '授权' },
];

const currentMenu = computed(() => menus.find((m) => m.key === activeMenu.value));

// 账号列表按菜单共享
const accounts = ref([]);
const loadingAccounts = ref(false);

// 授权状态
const licenseStatus = ref(null);
const accountEvents = [];

async function loadLicense() {
  try {
    licenseStatus.value = await api.lic.status();
  } catch (e) {
    console.error('读取授权状态失败', e);
  }
}

const showLicenseBanner = computed(() => {
  const s = licenseStatus.value;
  return !!s?.enforce && s.state !== 'active';
});

// ── 客户端更新 ──
const updateStatus = ref(null);
const updateBusy = ref(false);
const updateDismissed = ref(false);
let offUpdate = null;

const showUpdateDialog = computed(() => {
  const s = updateStatus.value;
  if (!s) return false;
  if (s.force && (s.updateAvailable || ['downloading', 'ready', 'installing'].includes(s.state))) return true;
  if (updateDismissed.value) return false;
  if (s.updateAvailable && s.state === 'available') return true;
  if (['downloading', 'ready', 'installing'].includes(s.state)) return true;
  return s.state === 'error' && s.updateAvailable;
});

const updateCanDismiss = computed(() => !updateStatus.value?.force && updateStatus.value?.state !== 'installing');

const updatePercent = computed(() => {
  const p = Number(updateStatus.value?.percent || 0);
  return Math.max(0, Math.min(100, p));
});

function formatBytes(n) {
  const v = Number(n || 0);
  if (v <= 0) return '0 MB';
  if (v >= 1024 * 1024 * 1024) return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

async function loadUpdate() {
  try {
    let s = await api.upd.status();
    if (s.state === 'idle' && !s.checkedAt) {
      const r = await api.upd.check();
      if (r?.status) s = r.status;
    }
    updateStatus.value = s;
  } catch (e) {
    console.error('读取更新状态失败', e);
  }
}

async function startUpdate() {
  updateBusy.value = true;
  try {
    const r = await api.upd.download();
    if (r?.status) updateStatus.value = r.status;
  } catch (e) {
    console.error('下载更新失败', e);
  } finally {
    updateBusy.value = false;
  }
}

async function installUpdate() {
  updateBusy.value = true;
  try {
    const r = await api.upd.install();
    if (r?.status) updateStatus.value = r.status;
  } catch (e) {
    console.error('启动安装程序失败', e);
  } finally {
    updateBusy.value = false;
  }
}

async function retryUpdate() {
  updateBusy.value = true;
  try {
    const r = await api.upd.check();
    if (r?.status) updateStatus.value = r.status;
    if (r?.status?.updateAvailable) {
      const d = await api.upd.download();
      if (d?.status) updateStatus.value = d.status;
    }
  } catch (e) {
    console.error('重试更新失败', e);
  } finally {
    updateBusy.value = false;
  }
}

function dismissUpdate() {
  if (!updateCanDismiss.value) return;
  updateDismissed.value = true;
}

async function openUpdate() {
  updateDismissed.value = false;
  await loadUpdate();
}

async function revealUpdate() {
  try { await api.upd.reveal(); } catch (e) { console.error('打开下载目录失败', e); }
}

async function loadAccounts() {
  loadingAccounts.value = true;
  try {
    accounts.value = await api.account.list();
  } catch (e) {
    console.error('加载账号失败', e);
  } finally {
    loadingAccounts.value = false;
  }
}

onMounted(() => {
  loadAccounts();
  loadLicense();
  loadUpdate();
  // SDK 上线/掉线/重连后主动刷新账号状态，避免页面停留在启动时的离线快照
  accountEvents.push(api.on('accounts:changed', () => loadAccounts()));
  accountEvents.push(api.on('account:offline', () => loadAccounts()));
  accountEvents.push(api.on('account:reconnecting', () => loadAccounts()));
  offUpdate = api.on('upd:event', (ev) => {
    if (!ev) return;
    updateStatus.value = { ...updateStatus.value, ...ev };
  });
});

onBeforeUnmount(() => {
  offUpdate?.();
  offUpdate = null;
  for (const off of accountEvents) { try { off?.(); } catch {} }
  accountEvents.length = 0;
});

defineExpose({ loadAccounts, loadLicense });
</script>

<template>
  <div class="shell">
    <IconNav v-model="activeMenu" :menus="menus" />

    <main class="workspace">
      <div v-if="showLicenseBanner" class="license-banner">
        <span>🔒 {{ licenseStatus?.message || '软件未激活' }}</span>
        <button @click="activeMenu = 'license'">去激活</button>
      </div>
      <Chat
        v-if="activeMenu === 'chat'"
        :accounts="accounts"
        :loading="loadingAccounts"
        @refresh-accounts="loadAccounts"
      />
      <Accounts
        v-else-if="activeMenu === 'accounts'"
        :accounts="accounts"
        :loading="loadingAccounts"
        @refresh-accounts="loadAccounts"
      />
      <Logs
        v-else-if="activeMenu === 'logs'"
        :accounts="accounts"
      />
      <Broadcast
        v-else-if="activeMenu === 'broadcast'"
        :accounts="accounts"
      />
      <Sensitive
        v-else-if="activeMenu === 'sensitive'"
      />
      <AutoReply
        v-else-if="activeMenu === 'autoreply'"
        :accounts="accounts"
      />
      <Cards
        v-else-if="activeMenu === 'cards'"
        :accounts="accounts"
      />
      <Intercept
        v-else-if="activeMenu === 'intercept'"
        :accounts="accounts"
      />
      <Competitors
        v-else-if="activeMenu === 'competitors'"
        :accounts="accounts"
        @open-leads="activeMenu = 'intercept'"
      />
      <Proxy
        v-else-if="activeMenu === 'proxy'"
        :accounts="accounts"
      />
      <Settings
        v-else-if="activeMenu === 'settings'"
        @check-update="openUpdate"
      />
      <License
        v-else-if="activeMenu === 'license'"
        :status="licenseStatus"
        @refresh="loadLicense"
      />
      <Placeholder
        v-else
        :title="currentMenu?.label"
        :icon="currentMenu?.icon"
      />
    </main>

    <div v-if="showUpdateDialog" class="upd-mask" @click.self="dismissUpdate">
      <div class="upd-dialog" :class="{ force: updateStatus?.force }">
        <div class="upd-head">
          <h3>
            {{ updateStatus?.state === 'error' ? '更新失败' : `发现新版本 v${updateStatus?.latestVersion || ''}` }}
          </h3>
          <button v-if="updateCanDismiss" class="upd-close" @click="dismissUpdate">×</button>
        </div>

        <div class="upd-body">
          <p class="upd-meta">
            当前 v{{ updateStatus?.currentVersion }}
            <span v-if="updateStatus?.latestVersion">→ v{{ updateStatus.latestVersion }}</span>
            <span v-if="updateStatus?.force" class="upd-force-tag">强制更新</span>
          </p>

          <p v-if="updateStatus?.notes" class="upd-notes">{{ updateStatus.notes }}</p>

          <div v-if="updateStatus?.state === 'downloading'" class="upd-progress-box">
            <div class="upd-progress">
              <div class="upd-progress-bar" :style="{ width: updatePercent + '%' }"></div>
            </div>
            <div class="upd-progress-text">
              <span>{{ updatePercent }}%</span>
              <span>
                {{ formatBytes(updateStatus?.received) }}
                <template v-if="updateStatus?.total"> / {{ formatBytes(updateStatus.total) }}</template>
              </span>
            </div>
          </div>

          <p v-else-if="updateStatus?.state === 'ready'" class="upd-ok">
            ✅ 安装包已下载并通过 SHA256 校验。
          </p>
          <p v-if="updateStatus?.state === 'ready'" class="upd-hint">
            点击「安装并重启」后，当前版本会自动退出，由安装程序完成覆盖安装。
          </p>
          <p v-else-if="updateStatus?.state === 'installing'" class="upd-hint">
            正在启动安装程序，请按提示完成安装……
          </p>
          <p v-else-if="updateStatus?.state === 'error'" class="upd-error">
            {{ updateStatus?.error || '更新失败，请检查网络后重试。' }}
          </p>

          <p v-if="updateStatus?.force" class="upd-force-tip">
            该版本为强制更新，完成前无法继续使用软件。
          </p>
        </div>

        <div class="upd-actions">
          <template v-if="updateStatus?.state === 'available'">
            <button v-if="updateCanDismiss" class="upd-btn ghost" @click="dismissUpdate">稍后</button>
            <button class="upd-btn primary" :disabled="updateBusy" @click="startUpdate">
              {{ updateBusy ? '下载中…' : '立即更新' }}
            </button>
          </template>
          <template v-else-if="updateStatus?.state === 'downloading'">
            <button class="upd-btn primary" disabled>下载中…</button>
          </template>
          <template v-else-if="updateStatus?.state === 'ready'">
            <button v-if="updateCanDismiss" class="upd-btn ghost" @click="dismissUpdate">稍后安装</button>
            <button class="upd-btn primary" :disabled="updateBusy" @click="installUpdate">安装并重启</button>
          </template>
          <template v-else-if="updateStatus?.state === 'installing'">
            <button class="upd-btn primary" disabled>正在安装…</button>
          </template>
          <template v-else-if="updateStatus?.state === 'error'">
            <button v-if="updateCanDismiss" class="upd-btn ghost" @click="dismissUpdate">关闭</button>
            <button class="upd-btn ghost" @click="revealUpdate">打开下载目录</button>
            <button class="upd-btn primary" :disabled="updateBusy" @click="retryUpdate">重试</button>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.license-banner {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; padding: 8px 16px; font-size: 12px;
  background: #fff8e6; border-bottom: 1px solid #ffe0a3; color: #8a5a00;
  flex-shrink: 0;
}
.license-banner button {
  height: 24px; padding: 0 12px; border: none; border-radius: 4px;
  background: #b76e00; color: #fff; font-size: 12px;
}
.shell {
  display: flex;
  height: 100%;
}
.workspace {
  flex: 1;
  min-width: 0;
  display: flex;
  background: var(--c-panel);
}

/* ── 更新弹窗 ── */
.upd-mask {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 23, 42, 0.55);
  backdrop-filter: blur(2px);
}
.upd-dialog {
  width: 440px;
  max-width: calc(100vw - 40px);
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.28);
  overflow: hidden;
}
.upd-dialog.force {
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35), 0 0 0 1px #f54a45 inset;
}
.upd-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px 8px;
}
.upd-head h3 {
  font-size: 16px;
  font-weight: 600;
}
.upd-close {
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--c-text-2);
  font-size: 18px;
  line-height: 1;
}
.upd-close:hover { background: #f2f3f5; color: var(--c-text); }
.upd-body { padding: 0 20px 4px; }
.upd-meta {
  font-size: 13px;
  color: var(--c-text-2);
  margin-bottom: 10px;
}
.upd-force-tag {
  margin-left: 8px;
  padding: 1px 6px;
  border-radius: 3px;
  background: #fff1f0;
  color: var(--c-danger);
  font-size: 11px;
}
.upd-notes {
  max-height: 160px;
  overflow: auto;
  padding: 10px 12px;
  margin-bottom: 10px;
  border-radius: 6px;
  background: #f7f8fa;
  color: #4e5969;
  font-size: 12px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}
.upd-progress-box { margin: 14px 0 6px; }
.upd-progress {
  height: 8px;
  border-radius: 4px;
  background: #eef0f3;
  overflow: hidden;
}
.upd-progress-bar {
  height: 100%;
  border-radius: 4px;
  background: var(--c-primary);
  transition: width 0.2s ease;
}
.upd-progress-text {
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
  color: var(--c-text-2);
  font-size: 12px;
}
.upd-ok { color: #1a7f37; font-size: 13px; margin: 12px 0 4px; }
.upd-hint { color: var(--c-text-2); font-size: 12px; line-height: 1.6; }
.upd-error {
  margin: 10px 0;
  padding: 8px 10px;
  border-radius: 5px;
  background: #fff1f0;
  color: #b42318;
  font-size: 12px;
  line-height: 1.6;
  word-break: break-word;
}
.upd-force-tip {
  margin-top: 10px;
  color: var(--c-danger);
  font-size: 12px;
}
.upd-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 20px 18px;
}
.upd-btn {
  height: 32px;
  padding: 0 16px;
  border-radius: 5px;
  font-size: 13px;
  border: 1px solid transparent;
}
.upd-btn.ghost {
  border-color: #d9dce1;
  background: #fff;
  color: #4e5969;
}
.upd-btn.ghost:hover { background: #f7f8fa; }
.upd-btn.primary {
  background: var(--c-primary);
  color: #fff;
}
.upd-btn.primary:hover { background: #2b62e6; }
.upd-btn:disabled { opacity: 0.6; cursor: default; }
</style>
