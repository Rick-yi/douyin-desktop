<script setup>
import { api } from '../api.js';
import { ref, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

const emit = defineEmits(['check-update']);

const info = ref(null);
const backups = ref([]);
const selected = ref('');
const update = ref(null);
const busy = ref(false);

const selectedBackup = computed(() => backups.value.find((b) => b.path === selected.value) || null);

function fmt(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function load() {
  try {
    info.value = await api.app.info();
    update.value = await api.upd.status();
    backups.value = await api.app.listBackups();
    if (!selected.value && backups.value[0]) selected.value = backups.value[0].path;
  } catch (e) {
    ElMessage.error('读取设置失败：' + e.message);
  }
}

async function checkUpdate() {
  busy.value = true;
  try {
    const r = await api.upd.check();
    update.value = r?.status ?? update.value;
    emit('check-update');
    if (r?.status?.updateAvailable) ElMessage.success('发现新版本');
    else if (r?.status?.state === 'up-to-date') ElMessage.success('当前已是最新版本');
    else ElMessage.warning(r?.status?.error || '暂时没有可用更新');
  } finally {
    busy.value = false;
  }
}

async function backup() {
  busy.value = true;
  try {
    const r = await api.app.backupData();
    if (!r.ok) { ElMessage.error(r.error || '备份失败'); return; }
    ElMessage.success('备份完成');
    backups.value = await api.app.listBackups();
    selected.value = r.path;
  } finally {
    busy.value = false;
  }
}

async function restore() {
  const b = selectedBackup.value;
  if (!b) { ElMessage.warning('请先选择一个备份'); return; }
  try {
    await ElMessageBox.confirm(
      `恢复到 ${fmt(b.createdAt)} 的备份？\n当前数据会先自动留一份，然后客户端重启。`,
      '恢复本地数据',
      { type: 'warning', confirmButtonText: '恢复并重启', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  busy.value = true;
  try {
    const r = await api.app.restoreData(b.path);
    if (!r.ok) { ElMessage.error(r.error || '恢复失败'); return; }
    ElMessage.success('正在重启并恢复…');
  } finally {
    busy.value = false;
  }
}

function openData() { api.app.openDataDir(); }
function openBackups() { api.app.openBackups(); }
function openLogs() { api.app.openLogs(); }

async function exportDiagnostics() {
  busy.value = true;
  try {
    const r = await api.app.exportDiagnostics();
    if (r.canceled) return;
    if (!r.ok) { ElMessage.error(r.error || '导出失败'); return; }
    ElMessage.success('诊断包已导出');
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="settings-view">
    <div class="page-head">
      <div>
        <h2>设置</h2>
        <p class="sub">版本、更新、本地数据备份和诊断</p>
      </div>
    </div>

    <section class="card">
      <h3>客户端信息</h3>
      <div class="grid">
        <div class="item"><span class="k">版本</span><span class="v">{{ info?.version || '-' }}</span></div>
        <div class="item"><span class="k">Electron</span><span class="v">{{ info?.electron || '-' }}</span></div>
        <div class="item"><span class="k">数据目录</span><span class="v mono ellipsis" :title="info?.dataDir">{{ info?.dataDir || '-' }}</span></div>
      </div>
      <div class="row">
        <button @click="openData">打开数据目录</button>
        <button @click="openLogs">打开日志目录</button>
        <button :disabled="busy" @click="exportDiagnostics">导出诊断包</button>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <h3>版本更新</h3>
        <button class="primary" :disabled="busy" @click="checkUpdate">检查更新</button>
      </div>
      <div class="grid">
        <div class="item"><span class="k">当前版本</span><span class="v">{{ update?.currentVersion || info?.version || '-' }}</span></div>
        <div class="item"><span class="k">最新版本</span><span class="v">{{ update?.latestVersion || '-' }}</span></div>
        <div class="item"><span class="k">状态</span><span class="v">{{ update?.state || '-' }}</span></div>
      </div>
      <p v-if="update?.notes" class="hint">{{ update.notes }}</p>
      <p v-if="update?.force" class="warn">当前版本被标记为强制更新，完成前部分功能会被暂停。</p>
    </section>

    <section class="card">
      <div class="card-head">
        <h3>本地数据备份</h3>
        <div class="row">
          <button :disabled="busy" @click="backup">立即备份</button>
          <button @click="openBackups">打开备份目录</button>
        </div>
      </div>
      <div v-if="!backups.length" class="empty">还没有手动备份</div>
      <div v-else class="backup-list">
        <label v-for="b in backups" :key="b.path" class="backup-row">
          <input v-model="selected" type="radio" :value="b.path">
          <span class="time">{{ fmt(b.createdAt) }}</span>
          <span class="ver">v{{ b.appVersion || '-' }}</span>
          <span class="name mono">{{ b.name }}</span>
        </label>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="danger" :disabled="busy || !selectedBackup" @click="restore">恢复选中的备份</button>
      </div>
      <p class="hint">
        备份包含数据库、账号 session、卡片和聊天媒体。恢复会先自动保存当前数据，再重启客户端。
      </p>
    </section>

    <section class="card security">
      <h3>数据安全</h3>
      <p>
        本地数据库和账号 session 目前是明文存储。请开启 Windows BitLocker，并限制数据目录访问权限。
        备份文件同样包含账号 session，不要发给不可信的人。
      </p>
    </section>
  </div>
</template>

<style scoped>
.settings-view { padding: 20px 24px; height: 100%; overflow-y: auto; }
.page-head { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 14px; }
.page-head h2 { margin: 0 0 4px; font-size: 18px; }
.sub { margin: 0; font-size: 12px; color: var(--c-text-2); }
.card { background: #fff; border: 1px solid var(--c-border); border-radius: 8px; padding: 14px 16px; margin-bottom: 12px; }
.card h3 { margin: 0 0 10px; font-size: 13px; font-weight: 600; }
.card-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.card-head h3 { margin: 0; }
.grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 12px; }
.item .k { display: block; font-size: 11px; color: var(--c-text-2); margin-bottom: 2px; }
.item .v { font-size: 13px; }
.mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
.ellipsis { display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row { display: flex; gap: 8px; flex-wrap: wrap; }
button { height: 30px; padding: 0 14px; border: 1px solid var(--c-border); border-radius: 5px; background: #fff; cursor: pointer; }
button:hover { background: #f7f8fa; }
button.primary { background: var(--c-primary); border-color: var(--c-primary); color: #fff; }
button.danger { border-color: #ffc9c9; color: var(--c-danger); }
button:disabled { opacity: .55; cursor: default; }
.hint { margin: 8px 0 0; color: var(--c-text-2); font-size: 12px; line-height: 1.7; }
.warn { margin: 8px 0 0; color: #b42318; font-size: 12px; }
.empty { padding: 18px 0; text-align: center; color: var(--c-text-2); font-size: 12px; }
.backup-list { border: 1px solid var(--c-border); border-radius: 6px; overflow: hidden; }
.backup-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-bottom: 1px solid #f2f3f5; cursor: pointer; font-size: 12px; }
.backup-row:last-child { border-bottom: none; }
.backup-row:hover { background: #fafbfc; }
.backup-row .time { width: 150px; }
.backup-row .ver { width: 70px; color: var(--c-text-2); }
.backup-row .name { color: var(--c-text-2); }
.security p { color: var(--c-text-2); font-size: 12px; line-height: 1.8; margin: 0; }
</style>
