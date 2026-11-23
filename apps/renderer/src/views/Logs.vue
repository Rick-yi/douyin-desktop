<script setup>
import { api } from '../api.js';
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { ElMessage } from 'element-plus';

const props = defineProps({
  accounts: { type: Array, default: () => [] },
});

const tab = ref('detail'); // detail | report
const loading = ref(false);
const rows = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = 50;

// 全账号发送报表
const reportDays = ref(7);
const reportLoading = ref(false);
const reportRows = ref([]);
const reportTotal = ref({ total: 0, sent: 0, failed: 0, skipped: 0, unknown: 0 });

// 筛选
const filters = ref({
  accountId: '',
  scene: '',
  status: '',
});

const stats = ref({ byStatus: [], byScene: [], byAccount: [] });
const riskStatus = ref({ tripped: [], quota: null, throttle: null });
let timer = null;

const sceneText = {
  dm: '私信',
  broadcast: '群发',
  intercept: '线索雷达',
  autoreply: '自动回复',
  comment: '评论',
};
const sceneTag = {
  dm: 'info',
  broadcast: 'warning',
  intercept: 'danger',
  autoreply: 'success',
  comment: 'info',
};
const statusText = {
  sent: '已发送',
  failed: '失败',
  skipped: '已跳过',
  unknown: '未知',
};
const statusTag = {
  sent: 'success',
  failed: 'danger',
  skipped: 'warning',
  unknown: 'info',
};

const accountName = computed(() => {
  const map = {};
  for (const a of props.accounts) map[a.id] = a.nickname || a.uid;
  return map;
});

async function loadLogs() {
  loading.value = true;
  try {
    const r = await api.log.list({
      accountId: filters.value.accountId || undefined,
      scene: filters.value.scene || undefined,
      status: filters.value.status || undefined,
      limit: pageSize,
      offset: (page.value - 1) * pageSize,
    });
    rows.value = r.rows;
    total.value = r.total;
  } catch (e) {
    ElMessage.error('加载日志失败: ' + e.message);
  } finally {
    loading.value = false;
  }
}

async function loadReport() {
  reportLoading.value = true;
  try {
    const r = await api.log.accountReport({ days: reportDays.value });
    reportRows.value = r.rows || [];
    reportTotal.value = r.total || { total: 0, sent: 0, failed: 0, skipped: 0, unknown: 0 };
  } catch (e) {
    ElMessage.error('加载账号报表失败: ' + e.message);
  } finally {
    reportLoading.value = false;
  }
}

async function loadStats() {
  try {
    const [s, risk] = await Promise.all([
      api.log.stats({ days: 7 }),
      api.risk.status(filters.value.accountId || undefined),
    ]);
    stats.value = s;
    riskStatus.value = risk;
  } catch (e) {
    console.error(e);
  }
}

function statusCount(status) {
  const row = stats.value.byStatus.find((x) => x.status === status);
  return row ? row.c : 0;
}

const total7d = computed(() =>
  stats.value.byStatus.reduce((sum, x) => sum + x.c, 0),
);
const successRate = computed(() => {
  const attempted = statusCount('sent') + statusCount('failed');
  if (!attempted) return 0;
  return Math.round((statusCount('sent') / attempted) * 100);
});

async function exportCsv() {
  try {
    const r = await api.log.export({
      accountId: filters.value.accountId || undefined,
      scene: filters.value.scene || undefined,
      status: filters.value.status || undefined,
    });
    const blob = new Blob([r.csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `发送日志_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    ElMessage.success(`已导出 ${r.count} 条`);
  } catch (e) {
    ElMessage.error('导出失败: ' + e.message);
  }
}

async function resetBreaker(accountId) {
  await api.risk.reset(accountId);
  ElMessage.success('已解除该账号冷却');
  await loadStats();
}

function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function accountSuccessRate(row) {
  const attempted = (Number(row.sent) || 0) + (Number(row.failed) || 0);
  if (!attempted) return 0;
  return Math.round(((Number(row.sent) || 0) / attempted) * 100);
}

function switchTab(t) {
  tab.value = t;
  if (t === 'report') loadReport();
  else { loadLogs(); loadStats(); }
}

function viewAccountLogs(row) {
  filters.value.accountId = row.accountId;
  page.value = 1;
  tab.value = 'detail';
  loadLogs();
}

async function exportReportCsv() {
  if (!reportRows.value.length) { ElMessage.info('当前没有可导出的报表'); return; }
  const header = ['账号', 'UID', '抖音号', '状态', '已发送', '失败', '已跳过', '未知', '总计', '成功率', '最近发送'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [
    header.map(esc).join(','),
    ...reportRows.value.map((r) => [
      r.nickname || r.accountId, r.uid || '', r.douyinId || '',
      r.enabled ? '启用' : '停用', r.sent, r.failed, r.skipped, r.unknown,
      r.total, `${accountSuccessRate(r)}%`, r.lastAt ? fmtTime(r.lastAt) : '',
    ].map(esc).join(',')),
  ].join(String.fromCharCode(13, 10));
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `账号发送报表_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  ElMessage.success(`已导出 ${reportRows.value.length} 个账号`);
}

function applyFilter() {
  page.value = 1;
  loadLogs();
}

onMounted(() => {
  loadLogs();
  loadStats();
  // 每 5 秒刷新（看发送进度）
  timer = setInterval(() => {
    if (tab.value === 'report') loadReport();
    else { loadLogs(); loadStats(); }
  }, 5000);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div class="logs-view">
    <header class="page-head">
      <div>
        <h2>发送日志</h2>
        <p class="sub">
          {{ tab === 'report' ? `全账号发送报表 · ${reportDays === 0 ? '全部时间' : `近 ${reportDays} 天`}` : `共 ${total} 条记录` }}
        </p>
      </div>
      <button class="primary" @click="tab === 'report' ? exportReportCsv() : exportCsv()">
        {{ tab === 'report' ? '导出报表' : '导出 CSV' }}
      </button>
    </header>

    <div class="page-tabs">
      <button :class="{ active: tab === 'detail' }" @click="switchTab('detail')">发送明细</button>
      <button :class="{ active: tab === 'report' }" @click="switchTab('report')">账号报表</button>
    </div>

    <template v-if="tab === 'detail'">
    <!-- 统计卡片 -->
    <div class="stats">
      <div class="stat-card">
        <div class="label">近 7 天记录</div>
        <div class="value">{{ total7d }}</div>
      </div>
      <div class="stat-card">
        <div class="label">成功率</div>
        <div class="value" :class="{ good: successRate >= 80, bad: successRate < 50 && total7d > 0 }">
          {{ successRate }}%
        </div>
      </div>
      <div class="stat-card">
        <div class="label">已发送</div>
        <div class="value good">{{ statusCount('sent') }}</div>
      </div>
      <div class="stat-card">
        <div class="label">失败</div>
        <div class="value" :class="{ bad: statusCount('failed') > 0 }">
          {{ statusCount('failed') }}
        </div>
      </div>
      <div class="stat-card">
        <div class="label">已跳过</div>
        <div class="value warn">{{ statusCount('skipped') }}</div>
      </div>
    </div>

    <!-- 熔断提示 -->
    <div v-if="riskStatus.tripped?.length" class="breaker-alert">
      <span class="icon">⚠️</span>
      <div class="content">
        <strong>有 {{ riskStatus.tripped.length }} 个账号处于冷却中</strong>
        <div class="list">
          <span v-for="t in riskStatus.tripped" :key="t.accountId" class="item">
            {{ accountName[t.accountId] || t.accountId }}：{{ t.reason }}
            （剩余 {{ t.remainingMin }} 分钟）
            <button @click="resetBreaker(t.accountId)">解除</button>
          </span>
        </div>
      </div>
    </div>

    <!-- 配额 -->
    <div v-if="riskStatus.quota" class="quota-bar">
      <span>今日 {{ riskStatus.quota.daily }}/{{ riskStatus.quota.dailyLimit }}</span>
      <span class="sep">·</span>
      <span>本小时 {{ riskStatus.quota.hourly }}/{{ riskStatus.quota.hourlyLimit }}</span>
    </div>

    <!-- 筛选 -->
    <div class="filters">
      <select v-model="filters.accountId" @change="applyFilter">
        <option value="">全部账号</option>
        <option v-for="a in accounts" :key="a.id" :value="a.id">
          {{ a.nickname || a.uid }}
        </option>
      </select>
      <select v-model="filters.scene" @change="applyFilter">
        <option value="">全部场景</option>
        <option value="dm">私信</option>
        <option value="broadcast">群发</option>
        <option value="intercept">线索雷达</option>
        <option value="autoreply">自动回复</option>
      </select>
      <select v-model="filters.status" @change="applyFilter">
        <option value="">全部状态</option>
        <option value="sent">已发送</option>
        <option value="failed">失败</option>
        <option value="skipped">已跳过</option>
      </select>
      <button class="ghost" @click="applyFilter">刷新</button>
    </div>

    <!-- 表格 -->
    <div class="table-wrap">
      <div v-if="loading && !rows.length" class="empty">加载中…</div>
      <div v-else-if="!rows.length" class="empty">暂无发送记录</div>

      <table v-else class="log-table">
        <thead>
          <tr>
            <th style="width: 130px">时间</th>
            <th style="width: 130px">账号</th>
            <th style="width: 80px">场景</th>
            <th style="width: 120px">对方 UID</th>
            <th>内容</th>
            <th style="width: 80px">状态</th>
            <th style="width: 140px">原因</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id">
            <td class="mono">{{ fmtTime(r.created_at) }}</td>
            <td class="ellipsis">{{ accountName[r.account_id] || r.account_id }}</td>
            <td>
              <span class="tag" :class="sceneTag[r.scene] || 'info'">
                {{ sceneText[r.scene] || r.scene }}
              </span>
            </td>
            <td class="mono ellipsis">{{ r.peer_uid }}</td>
            <td class="content" :title="r.content">{{ r.content }}</td>
            <td>
              <span class="tag" :class="statusTag[r.status] || 'info'">
                {{ statusText[r.status] || r.status }}
              </span>
            </td>
            <td class="reason" :title="r.reason">{{ r.reason || '-' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 分页 -->
    <div v-if="total > pageSize" class="pager">
      <button :disabled="page <= 1" @click="page--; loadLogs()">上一页</button>
      <span>{{ page }} / {{ Math.ceil(total / pageSize) }}</span>
      <button :disabled="page >= Math.ceil(total / pageSize)" @click="page++; loadLogs()">
        下一页
      </button>
    </div>
    </template>

    <!-- 全账号发送报表 -->
    <template v-else>
      <div class="report-bar">
        <select v-model.number="reportDays" @change="loadReport">
          <option :value="1">近 24 小时</option>
          <option :value="7">近 7 天</option>
          <option :value="30">近 30 天</option>
          <option :value="0">全部时间</option>
        </select>
        <span class="report-total">
          共 {{ reportTotal.total }} 条记录 · 成功 {{ reportTotal.sent }} ·
          失败 {{ reportTotal.failed }} · 跳过 {{ reportTotal.skipped }}
        </span>
      </div>

      <div class="table-wrap report-wrap">
        <div v-if="reportLoading && !reportRows.length" class="empty">加载中…</div>
        <div v-else-if="!reportRows.length" class="empty">暂无账号</div>
        <table v-else class="report-table">
          <thead>
            <tr>
              <th>账号</th>
              <th style="width: 90px">已发送</th>
              <th style="width: 80px">失败</th>
              <th style="width: 80px">已跳过</th>
              <th style="width: 80px">未知</th>
              <th style="width: 80px">总计</th>
              <th style="width: 90px">成功率</th>
              <th style="width: 140px">最近发送</th>
              <th style="width: 96px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in reportRows" :key="r.accountId">
              <td>
                <div class="report-account">
                  <span class="name">{{ r.nickname || '未命名账号' }}</span>
                  <span v-if="!r.enabled" class="tag info">已停用</span>
                  <div class="mono">{{ r.uid || r.accountId }}</div>
                </div>
              </td>
              <td class="num good">{{ r.sent }}</td>
              <td class="num" :class="{ bad: r.failed > 0 }">{{ r.failed }}</td>
              <td class="num warn">{{ r.skipped }}</td>
              <td class="num">{{ r.unknown }}</td>
              <td class="num strong">{{ r.total }}</td>
              <td class="num" :class="{ good: accountSuccessRate(r) >= 80, bad: accountSuccessRate(r) < 50 && r.total > 0 }">
                {{ accountSuccessRate(r) }}%
              </td>
              <td class="mono">{{ r.lastAt ? fmtTime(r.lastAt) : '—' }}</td>
              <td>
                <button class="mini" @click="viewAccountLogs(r)">查看日志</button>
              </td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td>全部账号</td>
              <td class="num good">{{ reportTotal.sent }}</td>
              <td class="num" :class="{ bad: reportTotal.failed > 0 }">{{ reportTotal.failed }}</td>
              <td class="num warn">{{ reportTotal.skipped }}</td>
              <td class="num">{{ reportTotal.unknown }}</td>
              <td class="num strong">{{ reportTotal.total }}</td>
              <td class="num">
                {{ (reportTotal.sent + reportTotal.failed) ? Math.round((reportTotal.sent / (reportTotal.sent + reportTotal.failed)) * 100) : 0 }}%
              </td>
              <td></td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.logs-view {
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
.primary {
  height: 32px;
  padding: 0 16px;
  border: none;
  border-radius: 6px;
  background: var(--c-primary);
  color: #fff;
  font-size: 13px;
}

.stats {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 10px;
  margin-bottom: 14px;
}
.stat-card {
  background: #fff;
  border: 1px solid var(--c-border);
  border-radius: 8px;
  padding: 12px 14px;
}
.stat-card .label { font-size: 12px; color: var(--c-text-2); }
.stat-card .value {
  font-size: 22px;
  font-weight: 600;
  margin-top: 4px;
}
.stat-card .value.good { color: #1a7f37; }
.stat-card .value.bad { color: var(--c-danger); }
.stat-card .value.warn { color: var(--c-warn); }

.breaker-alert {
  display: flex;
  gap: 10px;
  padding: 12px 14px;
  background: #fff4e5;
  border: 1px solid #ffd8a8;
  border-radius: 8px;
  margin-bottom: 12px;
}
.breaker-alert .icon { font-size: 18px; }
.breaker-alert .content { flex: 1; font-size: 13px; }
.breaker-alert .content strong { color: #b76e00; }
.breaker-alert .list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--c-text-2);
}
.breaker-alert .item button {
  margin-left: 8px;
  border: 1px solid #ffd8a8;
  background: #fff;
  border-radius: 4px;
  padding: 1px 8px;
  font-size: 11px;
  color: #b76e00;
}

.quota-bar {
  font-size: 12px;
  color: var(--c-text-2);
  margin-bottom: 10px;
}
.quota-bar .sep { margin: 0 8px; color: var(--c-text-3); }

.filters {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}
.filters select {
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  font-size: 13px;
  background: #fff;
  outline: none;
}
.filters .ghost {
  height: 30px;
  padding: 0 14px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  background: #fff;
  font-size: 13px;
  color: var(--c-text-2);
}

.table-wrap {
  flex: 1;
  background: #fff;
  border: 1px solid var(--c-border);
  border-radius: 8px;
  overflow: auto;
  min-height: 300px;
}
.empty {
  padding: 60px;
  text-align: center;
  color: var(--c-text-2);
  font-size: 13px;
}
.log-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.log-table th {
  position: sticky;
  top: 0;
  background: #fafbfc;
  text-align: left;
  padding: 9px 10px;
  font-weight: 500;
  color: var(--c-text-2);
  border-bottom: 1px solid var(--c-border);
  white-space: nowrap;
}
.log-table td {
  padding: 8px 10px;
  border-bottom: 1px solid #f5f6f8;
  vertical-align: top;
}
.log-table tr:hover td { background: #fafbfc; }
.mono { font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: var(--c-text-2); }
.ellipsis {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.content {
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.reason {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--c-danger);
}

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

.page-tabs {
  display: flex; gap: 6px; margin-bottom: 12px;
}
.page-tabs button {
  height: 30px; padding: 0 14px; border: 1px solid var(--c-border);
  border-radius: 6px; background: #fff; font-size: 13px; color: var(--c-text-2);
}
.page-tabs button.active {
  border-color: var(--c-primary); color: var(--c-primary); background: #f0f6ff;
}

.report-bar {
  display: flex; align-items: center; gap: 12px; margin-bottom: 12px;
}
.report-bar select {
  height: 30px; padding: 0 8px; border: 1px solid var(--c-border);
  border-radius: 6px; background: #fff; font-size: 13px; outline: none;
}
.report-total { font-size: 12px; color: var(--c-text-2); }
.report-wrap { min-height: 260px; }
.report-table {
  width: 100%; border-collapse: collapse; font-size: 12px;
}
.report-table th {
  position: sticky; top: 0; background: #fafbfc; text-align: left;
  padding: 9px 10px; font-weight: 500; color: var(--c-text-2);
  border-bottom: 1px solid var(--c-border); white-space: nowrap;
}
.report-table td {
  padding: 8px 10px; border-bottom: 1px solid #f5f6f8; vertical-align: middle;
}
.report-table tfoot td {
  background: #fafbfc; font-weight: 600; border-top: 1px solid var(--c-border);
}
.report-table tr:hover td { background: #fafbfc; }
.report-account .name { font-weight: 600; font-size: 13px; margin-right: 6px; }
.report-account .mono { margin-top: 2px; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.num.strong { font-weight: 600; }
.num.good { color: #1a7f37; }
.num.bad { color: var(--c-danger); }
.num.warn { color: var(--c-warn); }
.mini {
  height: 24px; padding: 0 10px; border: 1px solid var(--c-border);
  border-radius: 4px; background: #fff; font-size: 11px; color: var(--c-text-1);
}
.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 12px 0;
  font-size: 13px;
  color: var(--c-text-2);
}
.pager button {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  background: #fff;
  font-size: 12px;
}
.pager button:disabled { opacity: 0.4; }
</style>
