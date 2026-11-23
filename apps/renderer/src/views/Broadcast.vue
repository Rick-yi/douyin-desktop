<script setup>
import { api } from '../api.js';
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

const props = defineProps({
  accounts: { type: Array, default: () => [] },
});

// ── 状态 ──
const tasks = ref([]);
const loading = ref(false);
const dialogVisible = ref(false);
const dryRun = ref(true);

// 任务详情
const detailVisible = ref(false);
const detailTask = ref(null);
const detailRows = ref([]);
const detailLoading = ref(false);
let detailTimer = null;
let timer = null;
const unsubs = [];

// ── 表单 ──
const form = ref(emptyForm());

function emptyForm() {
  return {
    name: '',
    accountIds: [],
    targetMode: 'contacts',
    contacts: [],
    rawUids: '',
    contentsText: '',
    strategy: 'random',
    gapMinSec: 8,
    gapMaxSec: 30,
    batchSize: 5,
    roundWaitSec: 300,
    dailyLimit: 20,
    hourlyLimit: 5,
    excludeRecentDays: 0,
    scheduledAt: '',
  };
}

// 联系人多选（从已有会话里选）
const contactOptions = ref([]);
const loadingContacts = ref(false);
const contactKeyword = ref('');

const filteredContacts = computed(() => {
  const k = contactKeyword.value.trim().toLowerCase();
  if (!k) return contactOptions.value;
  return contactOptions.value.filter(
    (c) =>
      (c.name || '').toLowerCase().includes(k) || c.uid.includes(k),
  );
});

// 文案分析
const contents = computed(() =>
  form.value.contentsText
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean),
);

const contentWarning = computed(() => {
  const n = contents.value.length;
  if (n === 0) return { level: 'none', text: '' };
  if (n === 1) return { level: 'warn', text: '只有 1 条文案，内容完全相同容易被判定为批量营销，建议至少 5 条' };
  if (n < 5) return { level: 'info', text: `文案较少（${n} 条），轮换效果有限` };
  return { level: 'ok', text: `共 ${n} 条文案，轮换充分` };
});

// 目标人数
const targetCount = computed(() => {
  if (form.value.targetMode === 'uids') {
    const seen = new Set();
    for (const line of form.value.rawUids.split(/[\r\n]+/)) {
      const uid = line.trim();
      if (uid && /^\d{5,25}$/.test(uid)) seen.add(uid);
    }
    return seen.size;
  }
  return form.value.contacts.length;
});

// 预估
const estimate = ref(null);

async function refreshEstimate() {
  if (!targetCount.value || !form.value.accountIds.length) {
    estimate.value = null;
    return;
  }
  try {
    estimate.value = await api.bc.estimate({
      targetCount: targetCount.value,
      accountCount: form.value.accountIds.length,
      throttle: {
        gapMinSec: form.value.gapMinSec,
        gapMaxSec: form.value.gapMaxSec,
        batchSize: form.value.batchSize,
        roundWaitSec: form.value.roundWaitSec,
        dailyLimit: form.value.dailyLimit,
        hourlyLimit: form.value.hourlyLimit,
      },
    });
  } catch {
    estimate.value = null;
  }
}

// ── 数据加载 ──
async function loadTasks() {
  loading.value = true;
  try {
    tasks.value = await api.bc.list();
  } catch (e) {
    console.error('加载任务失败', e);
  } finally {
    loading.value = false;
  }
}

async function loadContacts() {
  if (!form.value.accountIds.length) {
    contactOptions.value = [];
    return;
  }
  loadingContacts.value = true;
  try {
    const all = [];
    for (const accId of form.value.accountIds) {
      const list = await api.conv.list(accId, { limit: 1000 });
      for (const c of list) {
        all.push({
          uid: c.peer_uid,
          name: c.peer_nickname || c.peer_uid,
          accountId: accId,
        });
      }
    }
    // 按 uid 去重（同一人可能是多个账号的联系人）
    const seen = new Set();
    contactOptions.value = all.filter((c) => {
      if (seen.has(c.uid)) return false;
      seen.add(c.uid);
      return true;
    });
  } catch (e) {
    ElMessage.error('加载联系人失败');
  } finally {
    loadingContacts.value = false;
  }
}

async function loadDryRun() {
  try {
    const r = await api.sender.getDryRun();
    dryRun.value = r.dryRun;
  } catch {}
}

async function toggleDryRun() {
  const r = await api.sender.setDryRun(dryRun.value);
  dryRun.value = r.dryRun;
  ElMessage.info(dryRun.value ? '已开启演练模式（不会真实发送）' : '已关闭演练模式（将真实发送）');
}

// ── 操作 ──
function openCreate() {
  form.value = emptyForm();
  // 默认选中所有启用账号
  form.value.accountIds = props.accounts.filter((a) => a.enabled && a.uid).map((a) => a.id);
  contactOptions.value = [];
  estimate.value = null;
  dialogVisible.value = true;
  if (form.value.accountIds.length) loadContacts();
}

async function onAccountsChange() {
  form.value.contacts = [];
  await loadContacts();
  refreshEstimate();
}

async function submit() {
  if (!form.value.accountIds.length) {
    ElMessage.error('请选择参与账号');
    return;
  }
  if (!targetCount.value) {
    ElMessage.error('没有有效的收件人');
    return;
  }
  if (!contents.value.length) {
    ElMessage.error('请填写至少一条文案');
    return;
  }

  if (!dryRun.value) {
    try {
      await ElMessageBox.confirm(
        `即将向 ${targetCount.value} 个目标真实发送消息，不可撤回。确定继续？`,
        '确认真实发送',
        { type: 'warning', confirmButtonText: '确定发送', cancelButtonText: '取消' },
      );
    } catch {
      return;
    }
  }

  try {
    const r = await api.bc.create({
      name: form.value.name || `群发 ${new Date().toLocaleString('zh-CN')}`,
      accountIds: form.value.accountIds,
      targetMode: form.value.targetMode,
      contacts: form.value.contacts.map((c) => ({ uid: c.uid, name: c.name })),
      rawUids: form.value.rawUids,
      contents: contents.value,
      strategy: form.value.strategy,
      excludeRecentDays: Number(form.value.excludeRecentDays) || 0,
      scheduledAt: form.value.scheduledAt
        ? new Date(form.value.scheduledAt).getTime()
        : null,
      throttle: {
        gapMinSec: form.value.gapMinSec,
        gapMaxSec: form.value.gapMaxSec,
        batchSize: form.value.batchSize,
        roundWaitSec: form.value.roundWaitSec,
        dailyLimit: form.value.dailyLimit,
        hourlyLimit: form.value.hourlyLimit,
      },
    });

    if (!r.ok) {
      ElMessage.error(r.error);
      return;
    }

    dialogVisible.value = false;
    await loadTasks();
    const extra = r.excludedRecent ? `，已排除最近联系过 ${r.excludedRecent} 人` : '';
    if (r.scheduled) {
      ElMessage.success(`任务已创建并定时${extra}`);
    } else {
      ElMessage.success(`任务已创建，点击「启动」开始执行${extra}`);
    }
  } catch (e) {
    ElMessage.error(e.message || '创建失败');
  }
}

async function retryFailed(t) {
  const r = await api.bc.retryFailed(t.id);
  if (r.ok) {
    ElMessage.success(`已创建失败重试任务：${r.count} 人，点击新任务「启动」`);
    await loadTasks();
  } else {
    ElMessage.error(r.error || '创建重试任务失败');
  }
}

async function runTask(t) {
  if (!dryRun.value) {
    try {
      await ElMessageBox.confirm(
        `任务「${t.name}」将向 ${t.total} 个目标真实发送，确定？`,
        '确认真实发送',
        { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' },
      );
    } catch {
      return;
    }
  }
  const r = await api.bc.run(t.id);
  if (r.ok) {
    ElMessage.success('任务已启动');
    await loadTasks();
  } else {
    ElMessage.error(r.error);
  }
}

function logText(status) {
  return { sent: '已发送', failed: '失败', skipped: '跳过' }[status] || status;
}
function logTag(status) {
  return { sent: 'success', failed: 'danger', skipped: 'warning' }[status] || '';
}

async function openDetail(t) {
  detailTask.value = t;
  detailVisible.value = true;
  await loadDetail();
  if (detailTimer) clearInterval(detailTimer);
  if (t.status === 'running') {
    detailTimer = setInterval(loadDetail, 2000);
  }
}

async function loadDetail() {
  if (!detailTask.value) return;
  detailLoading.value = true;
  try {
    const r = await api.bc.results(detailTask.value.id);
    detailRows.value = r.rows ?? [];
    // 同步一下任务计数（sender 内存里有最新值）
    const live = await api.bc.get(detailTask.value.id);
    if (live) detailTask.value = { ...detailTask.value, ...live };
  } catch (e) {
    console.error('加载任务详情失败', e);
  } finally {
    detailLoading.value = false;
  }
}

function closeDetail() {
  detailVisible.value = false;
  if (detailTimer) { clearInterval(detailTimer); detailTimer = null; }
}

async function pauseTask(t) {
  await api.bc.pause(t.id);
  await loadTasks();
}

async function resumeTask(t) {
  await api.bc.resume(t.id);
  await loadTasks();
}

async function cancelTask(t) {
  try {
    await ElMessageBox.confirm(`确定取消任务「${t.name}」？已发送的不会撤回。`, '取消任务', {
      type: 'warning',
    });
  } catch {
    return;
  }
  await api.bc.cancel(t.id);
  await loadTasks();
}

// ── 事件 ──
function bindEvents() {
  unsubs.push(
    api.on('sender:progress', (p) => {
      const i = tasks.value.findIndex((t) => t.id === p.taskId);
      if (i >= 0) {
        tasks.value[i] = { ...tasks.value[i], ...p.state };
      }
      if (p.type === 'done') {
        ElMessage.success(
          `任务「${p.state.name}」完成：成功 ${p.success} / 失败 ${p.fail} / 跳过 ${p.skipped}`,
        );
        loadTasks();
      }
    }),
  );
}

// ── 展示辅助 ──
const statusMap = {
  draft: { text: '待启动', tag: 'info' },
  running: { text: '运行中', tag: 'warning' },
  paused: { text: '已暂停', tag: 'info' },
  done: { text: '已完成', tag: 'success' },
  cancelled: { text: '已取消', tag: 'danger' },
};

function statusInfo(t) {
  return statusMap[t.status] ?? { text: t.status, tag: 'info' };
}

function progressPct(t) {
  if (!t.total) return 0;
  return Math.round(((t.progress ?? 0) / t.total) * 100);
}

function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

onMounted(() => {
  loadTasks();
  loadDryRun();
  bindEvents();
  timer = setInterval(loadTasks, 4000);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
  if (detailTimer) clearInterval(detailTimer);
  for (const u of unsubs) u();
});
</script>

<template>
  <div class="broadcast-view">
    <header class="page-head">
      <div>
        <h2>智能群发</h2>
        <p class="sub">
          向多个联系人批量发送消息 · 平台限制：同一人未回复前有消息上限
        </p>
      </div>
      <div class="head-actions">
        <label class="dryrun-toggle" :class="{ active: dryRun }">
          <input type="checkbox" v-model="dryRun" @change="toggleDryRun" />
          <span>演练模式</span>
        </label>
        <button class="primary" @click="openCreate">＋ 创建任务</button>
      </div>
    </header>

    <div v-if="dryRun" class="dryrun-banner">
      🧪 演练模式已开启 —— 任务会完整走一遍调度逻辑，但<strong>不会真实发送消息</strong>。
    </div>

    <!-- 任务列表 -->
    <div class="table-wrap">
      <div v-if="loading && !tasks.length" class="empty">加载中…</div>
      <div v-else-if="!tasks.length" class="empty">
        <p>还没有群发任务</p>
        <p class="hint">点右上角「创建任务」开始</p>
      </div>

      <table v-else class="task-table">
        <thead>
          <tr>
            <th style="width: 200px">任务名</th>
            <th style="width: 70px">账号</th>
            <th style="width: 70px">目标</th>
            <th style="width: 200px">进度</th>
            <th style="width: 120px">成/败/跳</th>
            <th style="width: 80px">状态</th>
            <th style="width: 110px">创建时间</th>
            <th style="width: 170px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in tasks" :key="t.id">
            <td class="name" :title="t.name">{{ t.name }}</td>
            <td>{{ t.accounts }}</td>
            <td>{{ t.total }}</td>
            <td>
              <div class="progress-cell">
                <div class="bar">
                  <div class="fill" :class="t.status" :style="{ width: progressPct(t) + '%' }"></div>
                </div>
                <span class="pct">{{ t.progress ?? 0 }}/{{ t.total }}</span>
              </div>
            </td>
            <td class="counts">
              <span class="ok">{{ t.success ?? 0 }}</span> /
              <span class="bad">{{ t.fail ?? 0 }}</span> /
              <span class="skip">{{ t.skipped ?? 0 }}</span>
            </td>
            <td>
              <span v-if="t.scheduledAt && t.status === 'draft'" class="tag warning">
                定时 {{ fmtTime(t.scheduledAt) }}
              </span>
              <span v-else class="tag" :class="statusInfo(t).tag">{{ statusInfo(t).text }}</span>
            </td>
            <td class="mono">{{ fmtTime(t.startedAt) }}</td>
            <td class="ops">
              <button class="op" @click="openDetail(t)">详情</button>
              <button
                v-if="t.fail > 0"
                class="op"
                @click="retryFailed(t)"
              >重试失败</button>
              <button
                v-if="t.status === 'draft'"
                class="op primary-sm"
                @click="runTask(t)"
              >启动</button>
              <button
                v-if="t.status === 'running'"
                class="op"
                @click="pauseTask(t)"
              >暂停</button>
              <button
                v-if="t.status === 'paused'"
                class="op primary-sm"
                @click="resumeTask(t)"
              >继续</button>
              <button
                v-if="t.status === 'running' || t.status === 'paused'"
                class="op danger"
                @click="cancelTask(t)"
              >取消</button>
              <span v-if="t.status === 'done' || t.status === 'cancelled'" class="done-hint">
                {{ t.status === 'done' ? '已结束' : '已取消' }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 创建任务弹窗 -->
    <el-dialog
      v-model="dialogVisible"
      title="创建群发任务"
      width="620px"
      :close-on-click-modal="false"
    >
      <div class="form">
        <div class="row">
          <label>任务名称</label>
          <input v-model="form.name" placeholder="不填则自动命名" />
        </div>

        <div class="row">
          <label>参与账号</label>
          <div class="account-checks">
            <label v-for="a in accounts" :key="a.id" class="check-item">
              <input
                type="checkbox"
                :value="a.id"
                v-model="form.accountIds"
                @change="onAccountsChange"
              />
              <span>{{ a.nickname || a.uid }}</span>
            </label>
            <span v-if="!accounts.length" class="hint-text">还没有账号</span>
          </div>
          <div class="hint-text">已选 {{ form.accountIds.length }} 个账号</div>
        </div>

        <div class="row">
          <label>目标用户</label>
          <div class="tabs">
            <button
              :class="{ active: form.targetMode === 'contacts' }"
              @click="form.targetMode = 'contacts'"
            >从联系人导入</button>
            <button
              :class="{ active: form.targetMode === 'uids' }"
              @click="form.targetMode = 'uids'"
            >手填 UID</button>
          </div>
        </div>

        <div class="row" v-if="form.targetMode === 'contacts'">
          <label></label>
          <div class="contact-picker">
            <input v-model="contactKeyword" placeholder="搜索联系人" class="search" />
            <div v-if="loadingContacts" class="hint-text">加载中…</div>
            <div v-else class="contact-list">
              <label v-for="c in filteredContacts" :key="c.uid" class="check-item">
                <input type="checkbox" :value="c" v-model="form.contacts" />
                <span class="cname">{{ c.name }}</span>
                <span class="cuid">{{ c.uid }}</span>
              </label>
              <div v-if="!filteredContacts.length" class="hint-text">没有联系人</div>
            </div>
            <div class="hint-text">已选 {{ form.contacts.length }} 个 / 共 {{ contactOptions.length }} 个</div>
          </div>
        </div>

        <div class="row" v-if="form.targetMode === 'uids'">
          <label></label>
          <div class="uid-input">
            <textarea
              v-model="form.rawUids"
              rows="5"
              placeholder="输入目标 UID，一行一个"
            />
            <div class="hint-text">有效 UID 数量：{{ targetCount }}</div>
          </div>
        </div>

        <div class="row">
          <label>文本内容</label>
          <div class="content-input">
            <textarea
              v-model="form.contentsText"
              rows="5"
              placeholder="一行一条内容，发送时按行拆分并轮换"
            />
            <div class="content-hint" :class="contentWarning.level">
              {{ contentWarning.text }}
            </div>
          </div>
        </div>

        <div class="row">
          <label>内容策略</label>
          <div class="radio-group">
            <label><input type="radio" value="random" v-model="form.strategy" /> 完全随机</label>
            <label><input type="radio" value="sequence" v-model="form.strategy" /> 顺序循环</label>
          </div>
        </div>

        <div class="row">
          <label>发送间隔</label>
          <div class="inline">
            <input type="number" v-model.number="form.gapMinSec" min="1" class="num" />
            <span>~</span>
            <input type="number" v-model.number="form.gapMaxSec" min="1" class="num" />
            <span>秒（随机）</span>
          </div>
        </div>

        <div class="row">
          <label>轮换设置</label>
          <div class="inline">
            每账号发
            <input type="number" v-model.number="form.batchSize" min="1" class="num" />
            条后换号，全部轮完等
            <input type="number" v-model.number="form.roundWaitSec" min="0" class="num" />
            秒
          </div>
        </div>

        <div class="row">
          <label>配额限制</label>
          <div class="inline">
            每账号每日
            <input type="number" v-model.number="form.dailyLimit" min="1" max="150" class="num" />
            条，每小时
            <input type="number" v-model.number="form.hourlyLimit" min="1" class="num" />
            条
          </div>
        </div>
        <div class="hint-text">个人号每日上限 60 条，蓝V 150 条（按账号类型自动限制，超出部分不会发送）</div>

        <div class="row">
          <label>排除重复</label>
          <div class="inline">
            最近
            <input type="number" v-model.number="form.excludeRecentDays" min="0" class="num" />
            天联系过的人不再发送（0 = 不排除）
          </div>
        </div>

        <div class="row">
          <label>定时发送</label>
          <div class="inline">
            <input type="datetime-local" v-model="form.scheduledAt" class="text" />
            <span>留空则手动启动</span>
          </div>
        </div>

        <div class="row estimate-row">
          <label></label>
          <button class="ghost" @click="refreshEstimate">计算预估</button>
          <div v-if="estimate" class="estimate">
            约 {{ estimate.estimatedMin }} 分钟 ·
            {{ estimate.rounds }} 轮 ·
            <span v-if="estimate.quotaLimited" class="warn">
              受配额限制需约 {{ estimate.hoursNeeded }} 小时
            </span>
            <span v-else>配额充足</span>
            <span v-if="estimate.daysNeeded > 1" class="danger">
              · 需 {{ estimate.daysNeeded }} 天
            </span>
          </div>
        </div>

        <div class="summary">
          将向 <strong>{{ targetCount }}</strong> 个目标发送，
          使用 <strong>{{ form.accountIds.length }}</strong> 个账号，
          共 <strong>{{ contents.length }}</strong> 条不同文案
        </div>
      </div>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">创建任务</el-button>
      </template>
    </el-dialog>

    <!-- 任务详情 -->
    <el-dialog v-model="detailVisible" title="任务详情" width="880px" @closed="closeDetail">
      <div v-if="detailTask" class="detail-head">
        <div class="detail-title">{{ detailTask.name }}</div>
        <div class="detail-meta">
          {{ statusInfo(detailTask).text }} · 目标 {{ detailTask.total }} ·
          成功 {{ detailTask.success ?? 0 }} · 失败 {{ detailTask.fail ?? 0 }} · 跳过 {{ detailTask.skipped ?? 0 }}
        </div>
      </div>

      <div class="detail-table-wrap">
        <table class="detail-table">
          <thead>
            <tr>
              <th style="width:130px">目标 UID</th>
              <th style="width:90px">账号</th>
              <th style="width:70px">状态</th>
              <th style="width:180px">原因</th>
              <th>内容</th>
              <th style="width:110px">时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in detailRows" :key="i">
              <td class="mono">{{ r.peer_uid }}</td>
              <td class="mono">{{ (r.account_id || '').slice(0, 8) }}</td>
              <td><span class="tag" :class="logTag(r.status)">{{ logText(r.status) }}</span></td>
              <td class="reason" :title="r.reason || ''">{{ r.reason || '-' }}</td>
              <td class="content" :title="r.content || ''">{{ r.content }}</td>
              <td class="mono">{{ fmtTime(r.created_at) }}</td>
            </tr>
            <tr v-if="!detailRows.length">
              <td colspan="6" class="detail-empty">{{ detailLoading ? '加载中…' : '还没有发送记录' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <template #footer>
        <el-button @click="loadDetail">刷新</el-button>
        <el-button @click="closeDetail">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.broadcast-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 18px 22px;
  overflow-y: auto;
  min-width: 0;
}
.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 14px;
}
.page-head h2 { font-size: 18px; font-weight: 600; }
.sub { font-size: 12px; color: var(--c-text-2); margin-top: 4px; }
.head-actions { display: flex; align-items: center; gap: 12px; }

.dryrun-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--c-text-2);
  padding: 5px 12px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
}
.dryrun-toggle.active {
  border-color: #b76e00;
  background: #fff4e5;
  color: #b76e00;
}

.primary {
  height: 32px;
  padding: 0 16px;
  border: none;
  border-radius: 6px;
  background: var(--c-primary);
  color: #fff;
  font-size: 13px;
}

.dryrun-banner {
  padding: 10px 14px;
  background: #fff4e5;
  border: 1px solid #ffd8a8;
  border-radius: 8px;
  font-size: 13px;
  color: #b76e00;
  margin-bottom: 12px;
}

.table-wrap {
  flex: 1;
  background: #fff;
  border: 1px solid var(--c-border);
  border-radius: 8px;
  overflow: auto;
  min-height: 320px;
}
.empty {
  padding: 60px;
  text-align: center;
  color: var(--c-text-2);
  font-size: 13px;
}
.empty .hint { font-size: 12px; color: var(--c-text-3); margin-top: 6px; }

.task-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.task-table th {
  position: sticky; top: 0;
  background: #fafbfc;
  text-align: left;
  padding: 9px 10px;
  font-weight: 500;
  color: var(--c-text-2);
  border-bottom: 1px solid var(--c-border);
  white-space: nowrap;
}
.task-table td { padding: 9px 10px; border-bottom: 1px solid #f5f6f8; }
.task-table tr:hover td { background: #fafbfc; }
.name { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.mono { font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: var(--c-text-2); }

.progress-cell { display: flex; align-items: center; gap: 8px; }
.bar { flex: 1; height: 6px; background: #f0f1f4; border-radius: 3px; overflow: hidden; }
.fill { height: 100%; background: var(--c-primary); transition: width 0.3s; }
.fill.done { background: var(--c-online); }
.fill.cancelled { background: var(--c-danger); }
.pct { font-size: 11px; color: var(--c-text-2); white-space: nowrap; }

.counts .ok { color: #1a7f37; }
.counts .bad { color: var(--c-danger); }
.counts .skip { color: var(--c-warn); }

.tag {
  display: inline-block;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background: #f0f1f4;
  color: var(--c-text-2);
  white-space: nowrap;
}
.tag.success { background: #e8f8ee; color: #1a7f37; }
.tag.warning { background: #fff4e5; color: #b76e00; }
.tag.danger { background: #ffece9; color: #d4380d; }
.tag.info { background: #eaf1ff; color: var(--c-primary); }

.ops { display: flex; gap: 4px; align-items: center; }
.op {
  height: 24px;
  padding: 0 10px;
  border: 1px solid var(--c-border);
  border-radius: 4px;
  background: #fff;
  font-size: 12px;
  color: var(--c-text-2);
}
.op.primary-sm { border-color: var(--c-primary); color: var(--c-primary); }
.op.danger { border-color: var(--c-danger); color: var(--c-danger); }
.done-hint { font-size: 12px; color: var(--c-text-3); }

/* 表单 */
.form { display: flex; flex-direction: column; gap: 14px; }
.row { display: flex; gap: 12px; align-items: flex-start; }
.row > label {
  width: 76px;
  flex-shrink: 0;
  font-size: 13px;
  color: var(--c-text-2);
  padding-top: 5px;
}
.row input[type="text"],
.row input:not([type]),
.form > .row > input {
  flex: 1;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  font-size: 13px;
  outline: none;
}
.row input:focus { border-color: var(--c-primary); }

.account-checks {
  flex: 1;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.check-item {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  padding: 4px 10px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  cursor: pointer;
}
.check-item:hover { background: #fafbfc; }

.tabs { display: flex; gap: 6px; }
.tabs button {
  height: 28px;
  padding: 0 14px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  background: #fff;
  font-size: 12px;
  color: var(--c-text-2);
}
.tabs button.active {
  border-color: var(--c-primary);
  background: #eaf1ff;
  color: var(--c-primary);
}

.contact-picker, .uid-input, .content-input {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.search {
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  font-size: 12px;
  outline: none;
}
.contact-list {
  max-height: 160px;
  overflow-y: auto;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.contact-list .check-item { border: none; padding: 3px 6px; }
.cname { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cuid { font-family: ui-monospace, Consolas, monospace; font-size: 10px; color: var(--c-text-3); }

.uid-input textarea, .content-input textarea {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  font-size: 12px;
  font-family: inherit;
  outline: none;
  resize: vertical;
}
.uid-input textarea:focus, .content-input textarea:focus { border-color: var(--c-primary); }

.hint-text { font-size: 11px; color: var(--c-text-3); }
.content-hint { font-size: 11px; }
.content-hint.warn { color: #b76e00; }
.content-hint.info { color: var(--c-text-2); }
.content-hint.ok { color: #1a7f37; }

.radio-group { display: flex; gap: 16px; font-size: 13px; }
.radio-group label { display: flex; align-items: center; gap: 4px; cursor: pointer; }

.inline { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--c-text-2); }
.num {
  width: 64px;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  font-size: 12px;
  outline: none;
  text-align: center;
}

.estimate-row { align-items: center; }
.ghost {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  background: #fff;
  font-size: 12px;
  color: var(--c-text-2);
}
.estimate { font-size: 12px; color: var(--c-text-2); }
.estimate .warn { color: #b76e00; }
.estimate .danger { color: var(--c-danger); }

.summary {
  padding: 10px 14px;
  background: #f7f8fa;
  border-radius: 6px;
  font-size: 12px;
  color: var(--c-text-2);
}
.summary strong { color: var(--c-text); }

.detail-head { margin-bottom: 10px; }
.detail-title { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
.detail-meta { font-size: 12px; color: var(--c-text-2); }
.detail-table-wrap { max-height: 52vh; overflow: auto; border: 1px solid var(--c-border); border-radius: 6px; }
.detail-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.detail-table th {
  position: sticky; top: 0; text-align: left; font-weight: 500;
  color: var(--c-text-2); background: #fafbfc; padding: 8px 10px;
  border-bottom: 1px solid var(--c-border); white-space: nowrap;
}
.detail-table td { padding: 7px 10px; border-bottom: 1px solid #f2f3f5; vertical-align: top; }
.detail-table .mono { font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: var(--c-text-2); }
.detail-table .reason { color: #b26a00; }
.detail-table .content {
  max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.detail-empty { text-align: center; color: #9aa0a6; padding: 24px 0 !important; }
.tag.success { background: #e8f8ee; color: #1a7f37; }
.tag.danger { background: #fdeaea; color: #c0392b; }
.tag.warning { background: #fff4e5; color: #b76e00; }
</style>
