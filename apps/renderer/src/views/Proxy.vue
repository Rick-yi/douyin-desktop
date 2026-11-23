<script setup>
import { api } from '../api.js';
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

const props = defineProps({
  accounts: { type: Array, default: () => [] },
});

const proxies = ref([]);
const binding = ref({}); // accountId -> { proxyId, name, status }
const loading = ref(false);
const testing = ref({}); // proxyId -> bool
let timer = null;

// 新增表单
const dialogVisible = ref(false);
const form = ref({ name: '', url: '', note: '' });

// 绑定 dialog
const bindVisible = ref(false);
const bindTarget = ref(null); // 代理
const bindSelection = ref({}); // accountId -> bool

const pendingRestart = ref(false);
const enabled = ref(true);

async function loadAll() {
  loading.value = true;
  try {
    const [list, map, flag] = await Promise.all([
      api.px.list(),
      api.px.map(),
      api.px.enabled(),
    ]);
    proxies.value = list;
    binding.value = map;
    enabled.value = flag.enabled !== false;
  } catch (e) {
    console.error(e);
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  form.value = { name: '', url: '', note: '' };
  dialogVisible.value = true;
}

async function doCreate() {
  if (!form.value.url.trim()) {
    ElMessage.error('请填写代理地址');
    return;
  }
  const r = await api.px.create({
    name: form.value.name.trim(),
    url: form.value.url.trim(),
    note: form.value.note.trim(),
  });
  if (!r.ok) {
    ElMessage.error(r.error);
    return;
  }
  ElMessage.success('已添加');
  dialogVisible.value = false;
  await loadAll();
}

async function doTest(p) {
  testing.value = { ...testing.value, [p.id]: true };
  try {
    const r = await api.px.test(p.id);
    if (r.ok) {
      ElMessage.success(`可用 · 出口 ${r.ip ?? '?'} · ${r.latencyMs}ms${r.location ? ' · ' + r.location : ''}`);
    } else {
      ElMessage.error(`不可用（${r.stage === 'tcp' ? '连接' : '请求'}）：${r.error}`);
    }
  } finally {
    testing.value = { ...testing.value, [p.id]: false };
    await loadAll();
  }
}

async function doDelete(p) {
  try {
    await ElMessageBox.confirm(
      `删除代理「${p.name}」？` + (p.boundCount ? `\n有 ${p.boundCount} 个账号绑定，会一并解绑。` : ''),
      '删除代理',
      { type: 'warning' },
    );
    const r = await api.px.delete(p.id);
    ElMessage.success(`已删除${r.unbound ? `，解绑 ${r.unbound} 个账号` : ''}`);
    if (r.unbound) pendingRestart.value = true;
    await loadAll();
  } catch {}
}

function openBind(p) {
  bindTarget.value = p;
  const sel = {};
  for (const a of props.accounts) {
    sel[a.id] = binding.value[a.id]?.proxyId === p.id;
  }
  bindSelection.value = sel;
  bindVisible.value = true;
}

async function doBind() {
  const target = bindTarget.value;
  if (!target) return;
  let changed = 0;
  for (const a of props.accounts) {
    const want = !!bindSelection.value[a.id];
    const has = binding.value[a.id]?.proxyId;
    if (want && has !== target.id) {
      const r = await api.px.bind(a.id, target.id);
      if (!r.ok) { ElMessage.error(`${a.nickname}: ${r.error}`); continue; }
      changed++;
    } else if (!want && has === target.id) {
      await api.px.bind(a.id, null);
      changed++;
    }
  }
  bindVisible.value = false;
  if (changed) {
    pendingRestart.value = true;
    ElMessage.success(`已更新 ${changed} 个账号的绑定，需重启应用生效`);
  } else {
    ElMessage.info('没有变化');
  }
  await loadAll();
}

async function toggleEnabled() {
  const next = !enabled.value;
  if (!next) {
    try {
      await ElMessageBox.confirm(
        '关闭后所有账号将直连，真实 IP 会暴露。已建立的连接需要重启应用才会断开。确定关闭？',
        '关闭代理功能',
        { type: 'warning', confirmButtonText: '关闭', cancelButtonText: '取消' },
      );
    } catch { return; }
  }
  const r = await api.px.setEnabled(next);
  if (!r.ok) { ElMessage.error(r.error || '操作失败'); return; }
  enabled.value = r.enabled;
  if (!next) pendingRestart.value = true;
  ElMessage.success(next ? '代理功能已开启，重启后生效' : '代理功能已关闭，重启后全部直连');
}

async function doRelaunch() {
  try {
    await ElMessageBox.confirm(
      '代理只在建立连接时生效，重启应用后已登录账号才会走新代理。\n\n现在重启？',
      '重启生效',
      { type: 'warning', confirmButtonText: '立即重启', cancelButtonText: '稍后' },
    );
  } catch { return; }
  await api.px.relaunch();
}

/** 某账号当前绑定 */
function accountBinding(a) {
  return binding.value[a.id] ?? null;
}

const boundCount = computed(() => Object.values(binding.value).filter(Boolean).length);

function statusText(p) {
  if (p.status === 'ok') return '可用';
  if (p.status === 'fail') return '不可用';
  return '未检测';
}

function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

onMounted(async () => {
  await loadAll();
  timer = setInterval(loadAll, 10000);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div class="px-view">
    <header class="page-head">
      <div>
        <h2>代理 IP</h2>
        <p class="sub">
          每个账号可绑定独立出口 · 当前已绑定 {{ boundCount }} 个账号
        </p>
      </div>
      <div class="head-actions">
        <label class="switch" :class="{ off: !enabled }">
          <input type="checkbox" :checked="enabled" @change="toggleEnabled" />
          {{ enabled ? '代理已启用' : '代理已关闭' }}
        </label>
        <button class="primary" @click="openCreate">＋ 添加代理</button>
      </div>
    </header>

    <div v-if="!enabled" class="off-bar">
      ⚠️ 代理功能已关闭：所有账号直连，真实 IP 会暴露。这里的配置会保留，重新开启并重启应用后生效。
    </div>

    <div class="notice">
      <strong>用法与限制</strong>
      <ul>
        <li>只支持 <b>HTTP/HTTPS</b> 代理（协议 SDK 底层是 undici，不支持 SOCKS5）。</li>
        <li>代理在<b>建立连接时</b>生效：绑定后需要重启应用，已登录账号才会走新出口。</li>
        <li>同一代理绑多个账号会共享出口 IP，风控上等于关联；重要账号建议一号一 IP。</li>
      </ul>
    </div>

    <div v-if="pendingRestart" class="restart-bar">
      <span>代理绑定已变更，重启应用后生效</span>
      <button class="primary small" @click="doRelaunch">立即重启</button>
    </div>

    <div class="table-wrap">
      <div v-if="loading && !proxies.length" class="empty">加载中…</div>
      <div v-else-if="!proxies.length" class="empty">
        <p>还没有代理</p>
        <p class="hint">点右上角「添加代理」，格式：http://user:pass@1.2.3.4:8080</p>
      </div>

      <table v-else class="px-table">
        <thead>
          <tr>
            <th style="width: 180px">名称</th>
            <th>地址</th>
            <th style="width: 130px">出口 IP</th>
            <th style="width: 120px">延迟</th>
            <th style="width: 80px">状态</th>
            <th style="width: 80px">绑定</th>
            <th style="width: 110px">最近检测</th>
            <th style="width: 170px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in proxies" :key="p.id">
            <td class="name" :title="p.name">{{ p.name }}</td>
            <td class="mono">{{ p.maskedUrl }}</td>
            <td class="mono">{{ p.exitIp || '-' }}</td>
            <td>
              <span v-if="p.latencyMs" :class="p.latencyMs < 500 ? 'ok' : 'warn'">
                {{ p.latencyMs }} ms
              </span>
              <span v-else>-</span>
            </td>
            <td>
              <span class="tag" :class="p.status">{{ statusText(p) }}</span>
            </td>
            <td>{{ p.boundCount }} 个</td>
            <td class="mono">{{ fmtTime(p.checkedAt) }}</td>
            <td class="ops">
              <button class="ok" :disabled="testing[p.id]" @click="doTest(p)">
                {{ testing[p.id] ? '检测中…' : '测试' }}
              </button>
              <button @click="openBind(p)">绑定</button>
              <button class="danger" @click="doDelete(p)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 账号绑定情况 -->
    <section class="bind-section">
      <h3>账号绑定情况</h3>
      <div v-if="!accounts.length" class="empty small">还没有账号</div>
      <div v-else class="bind-list">
        <div v-for="a in accounts" :key="a.id" class="bind-row">
          <img v-if="a.avatar_local_url || a.avatar_url" class="avatar" :src="a.avatar_local_url || a.avatar_url" referrerpolicy="no-referrer" />
          <div v-else class="avatar ph">{{ (a.nickname || '?').slice(0, 1) }}</div>
          <span class="nick">{{ a.nickname || '未命名' }}</span>
          <span v-if="!a.uid" class="tag info">未登录</span>
          <template v-if="accountBinding(a)">
            <span class="tag success">{{ accountBinding(a).name }}</span>
            <span class="mono small-text">{{ accountBinding(a).exitIp || '未检测' }}</span>
          </template>
          <span v-else class="tag">直连</span>
        </div>
      </div>
    </section>

    <!-- 新增代理 -->
    <el-dialog v-model="dialogVisible" title="添加代理" width="520px">
      <div class="form">
        <label>
          <span>名称（可选）</span>
          <input v-model="form.name" type="text" placeholder="例如：上海-家宽-01" />
        </label>
        <label>
          <span>代理地址</span>
          <input v-model="form.url" type="text" placeholder="http://user:pass@1.2.3.4:8080" />
        </label>
        <label>
          <span>备注（可选）</span>
          <input v-model="form.note" type="text" placeholder="供应商、到期时间等" />
        </label>
        <p class="hint">
          密码保存在本地数据库，界面和日志只显示脱敏地址。不要使用来路不明的免费代理。
        </p>
      </div>
      <template #footer>
        <button @click="dialogVisible = false">取消</button>
        <button class="primary" @click="doCreate">添加</button>
      </template>
    </el-dialog>

    <!-- 绑定账号 -->
    <el-dialog v-model="bindVisible" :title="`绑定到：${bindTarget?.name ?? ''}`" width="480px">
      <p class="hint">勾选使用这个代理的账号。取消勾选表示改回直连。</p>
      <div class="checks">
        <label v-for="a in accounts" :key="a.id" class="check">
          <input v-model="bindSelection[a.id]" type="checkbox" />
          <span>{{ a.nickname || '未命名' }}</span>
          <span v-if="!a.uid" class="tag info">未登录</span>
          <span v-else-if="binding[a.id]" class="tag">{{ binding[a.id].name }}</span>
        </label>
      </div>
      <template #footer>
        <button @click="bindVisible = false">取消</button>
        <button class="primary" @click="doBind">保存</button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.px-view { padding: 20px 24px; height: 100%; overflow-y: auto; }
.page-head { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 14px; }
.page-head h2 { margin: 0 0 4px; font-size: 18px; }
.sub { margin: 0; font-size: 12px; color: var(--c-text-2); }

.notice {
  background: #f7f9fc; border: 1px solid #e3e8ef; border-radius: 6px;
  padding: 10px 14px; margin-bottom: 12px; font-size: 12px; color: var(--c-text-2);
}
.notice strong { display: block; margin-bottom: 4px; color: var(--c-text-1); }
.notice ul { margin: 0; padding-left: 18px; line-height: 1.7; }

.off-bar {
  background: #fdeaea; border: 1px solid #ffc9c9; color: #b02a1e;
  border-radius: 6px; padding: 8px 14px; font-size: 12px; margin-bottom: 12px;
}
.switch {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--c-text-2); cursor: pointer;
  padding: 5px 10px; border: 1px solid var(--c-border); border-radius: 6px;
  background: #fff; user-select: none;
}
.switch input { accent-color: var(--c-primary); }
.switch.off { color: var(--c-danger); border-color: #ffc9c9; background: #fff7f7; }
.restart-bar {
  display: flex; align-items: center; justify-content: space-between;
  background: #fff8e6; border: 1px solid #ffe0a3; color: #8a5a00;
  border-radius: 6px; padding: 8px 14px; margin-bottom: 12px; font-size: 12px;
}

.table-wrap { background: #fff; border: 1px solid var(--c-border); border-radius: 8px; overflow: hidden; }
.px-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.px-table th {
  text-align: left; font-weight: 500; color: var(--c-text-2);
  background: #fafbfc; padding: 8px 10px; border-bottom: 1px solid var(--c-border);
  white-space: nowrap;
}
.px-table td { padding: 8px 10px; border-bottom: 1px solid #f2f3f5; }
.px-table tr:hover td { background: #fafbfc; }
.name { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.mono { font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: var(--c-text-2); }
.ok { color: #1a7f37; }
.warn { color: #b26a00; }

.tag {
  display: inline-block; font-size: 11px; padding: 0 6px; border-radius: 3px;
  background: #f0f1f4; color: var(--c-text-2); white-space: nowrap;
}
.tag.ok { background: #e8f8ee; color: #1a7f37; }
.tag.fail { background: #fdeaea; color: #c0392b; }
.tag.success { background: #e8f8ee; color: #1a7f37; }
.tag.info { background: #eef4ff; color: #2f6fd0; }

.ops button {
  height: 24px; padding: 0 8px; margin-right: 4px; border: 1px solid #dfe1e6;
  border-radius: 4px; background: #fff; font-size: 11px; color: var(--c-text-1);
}
.ops button.ok { border-color: #b7e3c3; color: #1a7f37; }
.ops button.danger { border-color: #ffc9c9; color: var(--c-danger); }
.ops button:disabled { opacity: 0.6; }

.empty { padding: 44px 0; text-align: center; color: var(--c-text-2); font-size: 13px; }
.empty .hint { font-size: 12px; color: #9aa0a6; }
.empty.small { padding: 16px 0; font-size: 12px; }

.bind-section { margin-top: 18px; background: #fff; border: 1px solid var(--c-border); border-radius: 8px; padding: 12px 14px; }
.bind-section h3 { margin: 0 0 10px; font-size: 13px; font-weight: 600; }
.bind-list { display: flex; flex-direction: column; gap: 8px; }
.bind-row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.avatar { width: 24px; height: 24px; border-radius: 50%; object-fit: cover; }
.avatar.ph { display: grid; place-items: center; background: #eef0f3; color: var(--c-text-2); }
.nick { min-width: 120px; font-weight: 500; }
.small-text { font-size: 11px; color: #9aa0a6; }

.form label { display: block; margin-bottom: 12px; }
.form label span { display: block; font-size: 12px; color: var(--c-text-2); margin-bottom: 4px; }
.form input[type='text'] {
  width: 100%; height: 30px; padding: 0 10px; border: 1px solid var(--c-border);
  border-radius: 4px; font-size: 12px; outline: none;
}
.form input[type='text']:focus { border-color: var(--c-primary); }
.hint { font-size: 12px; color: #9aa0a6; margin: 0; line-height: 1.6; }
.checks { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.check { display: flex; align-items: center; gap: 8px; font-size: 12px; cursor: pointer; }

.page-head .primary, .el-dialog .primary {
  height: 30px; padding: 0 14px; border: none; border-radius: 4px;
  background: var(--c-primary); color: #fff; font-size: 12px;
}
.el-dialog button:not(.primary) {
  height: 30px; padding: 0 14px; border: 1px solid var(--c-border);
  border-radius: 4px; background: #fff; font-size: 12px;
}
.el-dialog__footer { display: flex; justify-content: flex-end; gap: 8px; }
.primary.small { height: 26px; padding: 0 10px; border: none; border-radius: 4px; background: var(--c-primary); color: #fff; font-size: 12px; }
</style>
