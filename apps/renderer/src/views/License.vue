<script setup>
import { api } from '../api.js';
import { ref, computed } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

const props = defineProps({
  status: { type: Object, default: null },
});
const emit = defineEmits(['refresh']);

const key = ref('');
const busy = ref(false);

const STATUS = {
  active: { text: '已激活', cls: 'ok' },
  grace: { text: '只读（待联网验证）', cls: 'warn' },
  expired: { text: '已过期', cls: 'danger' },
  revoked: { text: '已作废', cls: 'danger' },
  invalid: { text: '授权异常', cls: 'danger' },
  unlicensed: { text: '未激活', cls: 'info' },
  uninitialized: { text: '未初始化', cls: 'info' },
};

const FEATURE_LABELS = {
  account: '账号管理',
  chat: '消息收发',
  logs: '发送日志',
  sensitive: '敏感词',
  broadcast: '智能群发',
  intercept: '线索雷达',
  monitor: '持续监控',
  autoreply: '自动回复',
  proxy: '代理 IP',
  export: '导出',
};

const st = computed(() => props.status ?? {});
const stateInfo = computed(() => STATUS[st.value.state] ?? STATUS.unlicensed);
const isActive = computed(() => st.value.state === 'active');
const enforce = computed(() => !!st.value.enforce);

const daysLeft = computed(() => {
  const t = Number(st.value.keyExpireAt || 0);
  if (!t) return null;
  return Math.ceil((t - Date.now()) / 86400000);
});

const features = computed(() => {
  const have = new Set(Array.isArray(st.value.features) ? st.value.features : []);
  return Object.entries(FEATURE_LABELS).map(([k, label]) => ({ key: k, label, on: have.has(k) }));
});

function fmt(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function activate() {
  const k = key.value.trim();
  if (!k) { ElMessage.error('请输入卡密'); return; }
  busy.value = true;
  try {
    const r = await api.lic.activate(k);
    if (!r.ok) {
      ElMessage({ type: 'error', message: r.error || '激活失败', duration: 6000 });
      return;
    }
    key.value = '';
    ElMessage.success(`激活成功：${r.status.plan ?? ''}`);
    emit('refresh');
  } finally {
    busy.value = false;
  }
}

async function revalidate() {
  busy.value = true;
  try {
    const r = await api.lic.heartbeat();
    if (r.ok) {
      ElMessage.success(`验证成功：${r.status.state === 'active' ? '已激活' : r.status.message}`);
    } else {
      ElMessage.error(r.error || '验证失败');
    }
    emit('refresh');
  } finally {
    busy.value = false;
  }
}

async function deactivate() {
  try {
    await ElMessageBox.confirm(
      '解绑后本机将变为未激活状态，可以换一台设备使用。已采集的数据不受影响。',
      '解绑本机',
      { type: 'warning', confirmButtonText: '解绑', cancelButtonText: '取消' },
    );
  } catch { return; }
  busy.value = true;
  try {
    const r = await api.lic.deactivate();
    if (!r.ok) { ElMessage.error(r.error || '解绑失败'); return; }
    ElMessage.success('已解绑');
    emit('refresh');
  } finally {
    busy.value = false;
  }
}

</script>

<template>
  <div class="lic-view">
    <header class="page-head">
      <div>
        <h2>授权</h2>
        <p class="sub">卡密绑定本机设备，换机需要先解绑</p>
      </div>
      <span class="state-pill" :class="stateInfo.cls">{{ stateInfo.text }}</span>
    </header>

    <div v-if="!enforce" class="dev-note">
      当前未启用授权校验（开发模式）。打包后的正式版会自动强制。
    </div>

    <section class="card">
      <div class="grid">
        <div class="item">
          <span class="k">套餐</span>
          <span class="v">{{ st.plan || '-' }}</span>
        </div>
        <div class="item">
          <span class="k">卡密到期</span>
          <span class="v">
            {{ st.keyExpireAt ? fmt(st.keyExpireAt) : '-' }}
            <em v-if="daysLeft !== null" :class="{ danger: daysLeft <= 7 }">（剩 {{ daysLeft }} 天）</em>
          </span>
        </div>
        <div class="item">
          <span class="k">令牌有效期（每 6 小时自动续签）</span>
          <span class="v">{{ st.expiresAt ? fmt(st.expiresAt) : '-' }}</span>
        </div>
        <div class="item">
          <span class="k">最近联网验证</span>
          <span class="v">{{ st.lastHeartbeatAt ? fmt(st.lastHeartbeatAt) : '从未' }}</span>
        </div>
        <div class="item">
          <span class="k">本机指纹</span>
          <span class="v mono">{{ st.deviceId || '-' }}</span>
        </div>
      </div>

      <p v-if="st.message" class="msg" :class="stateInfo.cls">{{ st.message }}</p>
    </section>

    <section v-if="!isActive" class="card">
      <h3>输入卡密激活</h3>
      <div class="activate-row">
        <input
          v-model="key"
          type="text"
          placeholder="ZMTJ-XXXX-XXXX-XXXX-XXXX"
          :disabled="busy"
          @keyup.enter="activate"
        />
        <button class="primary" :disabled="busy" @click="activate">
          {{ busy ? '处理中…' : '激活' }}
        </button>
      </div>
      <p class="hint">卡密由销售渠道提供。激活后本机占用一个设备名额。</p>
    </section>

    <section class="card">
      <h3>功能权限</h3>
      <div class="features">
        <span v-for="f in features" :key="f.key" class="feat" :class="{ on: f.on }">
          {{ f.on ? '✓' : '✗' }} {{ f.label }}
        </span>
      </div>
      <p v-if="!isActive" class="hint">未激活时只能查看账号和消息，发送、群发、采集、监控、代理需要授权。</p>
    </section>

    <section class="card actions">
      <button :disabled="busy || !st.deviceId" @click="revalidate">立即联网验证</button>
      <button v-if="isActive" class="danger" :disabled="busy" @click="deactivate">解绑本机</button>
      <span class="spacer"></span>
      <span class="tiny">客户端版本 {{ st.appVersion || '-' }}</span>
    </section>
  </div>
</template>

<style scoped>
.lic-view { padding: 20px 24px; height: 100%; overflow-y: auto; }
.page-head { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 14px; }
.page-head h2 { margin: 0 0 4px; font-size: 18px; }
.sub { margin: 0; font-size: 12px; color: var(--c-text-2); }

.state-pill { font-size: 12px; padding: 2px 10px; border-radius: 12px; }
.state-pill.ok { background: #e8f8ee; color: #1a7f37; }
.state-pill.warn { background: #fff4e5; color: #b76e00; }
.state-pill.danger { background: #fdeaea; color: #c0392b; }
.state-pill.info { background: #eef0f3; color: #6b7280; }

.dev-note {
  background: #fff8e6; border: 1px solid #ffe0a3; color: #8a5a00;
  border-radius: 6px; padding: 8px 12px; font-size: 12px; margin-bottom: 12px;
}

.card {
  background: #fff; border: 1px solid var(--c-border); border-radius: 8px;
  padding: 14px 16px; margin-bottom: 12px;
}
.card h3 { margin: 0 0 10px; font-size: 13px; font-weight: 600; }
.grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.item .k { display: block; font-size: 11px; color: var(--c-text-2); margin-bottom: 2px; }
.item .v { font-size: 13px; }
.item .v em { font-style: normal; color: var(--c-text-2); }
.item .v em.danger { color: var(--c-danger); }
.mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
.msg { margin: 12px 0 0; font-size: 12px; color: var(--c-text-2); }
.msg.danger { color: var(--c-danger); }
.msg.warn { color: #b26a00; }

.activate-row { display: flex; gap: 8px; }
.activate-row input {
  flex: 1; height: 32px; padding: 0 10px; border: 1px solid var(--c-border);
  border-radius: 4px; font-size: 13px; outline: none;
  font-family: ui-monospace, Consolas, monospace;
}
.activate-row input:focus { border-color: var(--c-primary); }
.primary {
  height: 32px; padding: 0 18px; border: none; border-radius: 4px;
  background: var(--c-primary); color: #fff; font-size: 13px;
}
.primary:disabled { opacity: 0.6; }
.hint { margin: 8px 0 0; font-size: 11px; color: #9aa0a6; line-height: 1.6; }

.features { display: flex; flex-wrap: wrap; gap: 8px; }
.feat {
  font-size: 12px; padding: 2px 8px; border-radius: 4px;
  background: #f3f4f6; color: #9aa0a6;
}
.feat.on { background: #e8f8ee; color: #1a7f37; }

.actions { display: flex; align-items: center; gap: 8px; }
.actions button {
  height: 28px; padding: 0 12px; border: 1px solid var(--c-border);
  border-radius: 4px; background: #fff; font-size: 12px;
}
.actions button.danger { border-color: #ffc9c9; color: var(--c-danger); }
.actions button.link { border: none; color: var(--c-primary); text-decoration: underline; padding: 0; }
.actions .spacer { flex: 1; }
.tiny { font-size: 11px; color: #9aa0a6; }
</style>
