<script setup>
import { api } from '../api.js';
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { openChat } from '../nav.js';

const props = defineProps({
  accounts: { type: Array, default: () => [] },
});

// ── 列表 ──
const tasks = ref([]);
const loading = ref(false);
const defaults = ref(null);
const dryRun = ref(true);
let timer = null;
let clockTimer = null;

// ── 向导 ──
const wizardVisible = ref(false);
const step = ref(1); // 1 采集 | 2 审核 | 3 发送
const currentTask = ref(null);
const targets = ref([]);
const selectedIds = ref([]);
const reviewFilter = ref('pending');
const keywordFilter = ref('');
const reviewTimeRange = ref('24h');
const REVIEW_TIME_RANGES = [
  { key: 'all', label: '全部时间', ms: 0 },
  { key: '1h', label: '近 1 小时', ms: 3600000 },
  { key: '24h', label: '近 24 小时', ms: 86400000 },
  { key: '7d', label: '近 7 天', ms: 7 * 86400000 },
];

function reviewSinceMs() {
  const item = REVIEW_TIME_RANGES.find((x) => x.key === reviewTimeRange.value);
  return item?.ms ? Date.now() - item.ms : undefined;
}
const targetTotal = ref(0);
const targetPage = ref(1);
const targetPageSize = ref(50);
const pageCount = computed(() =>
  Math.max(1, Math.ceil(targetTotal.value / Math.max(1, Number(targetPageSize.value) || 50))),
);
const clock = ref(Date.now());
const harvesting = ref(false);

// 采集方式
const mode = ref('manual'); // manual | video | keyword
const modes = ref([
  { key: 'manual', name: '手动导入 UID' },
  { key: 'competitor', name: '同行视频监控' },
  { key: 'keyword', name: '关键词搜索' },
  { key: 'live', name: '直播间' },
]);

// 扫描策略：不做人为限速；只保留平台请求间隔，避免 429
const FIXED_HARVEST = {
  requestGapMinMs: 300,
  requestGapMaxMs: 600,
  dailyRequestLimit: 0,
  maxPagesPerVideo: 0,
  maxVideosPerTask: 1000,
  initialScanVideos: 1000,
  maxLeadsPerTask: 0,
  maxCommentAgeDays: 1,
};
const FIXED_MONITOR = {
  intervalSec: 30,
  pagesPerVideo: 0,
  keywordsPerRound: 5,
  videosPerRound: 50,
  requestGapMinMs: 300,
  requestGapMaxMs: 600,
  scanConcurrency: 20,
  discoveryIntervalSec: 60,
  baselineMs: 86400000,
};
const FIXED_SEND = {
  dailyLimit: 1000,
  hourlyLimit: 1000,
  batchSize: 1000,
  roundWaitSec: 0,
};

// 只用于展示，不再接受用户修改
const cfg = ref({
  gapMin: 1,
  gapMax: 1,
  daily: 0,
  pages: 0,
  videos: 300,
  scanVideos: 10,
  leads: 0,
  ageDays: 1,
});

const monitorBusy = ref(false);
const presenceBusy = ref(false);

function monitorOptions() {
  return {
    enabled: true,
    intervalSec: FIXED_MONITOR.intervalSec,
    pagesPerVideo: FIXED_MONITOR.pagesPerVideo,
    keywordsPerRound: FIXED_MONITOR.keywordsPerRound,
    videosPerRound: FIXED_MONITOR.videosPerRound,
    requestGapMinMs: FIXED_MONITOR.requestGapMinMs,
    requestGapMaxMs: FIXED_MONITOR.requestGapMaxMs,
    scanConcurrency: FIXED_MONITOR.scanConcurrency,
    discoveryIntervalSec: FIXED_MONITOR.discoveryIntervalSec,
    sinceAt: Date.now() - FIXED_MONITOR.baselineMs,
  };
}

const harvestProgress = computed(() => {
  const h = currentTask.value?.harvest;
  if (!h) return null;
  if (h.phase === 'searching') {
    const total = Number(h.searchTotal) || Number(cfg.value.videos) || 0;
    const found = Number(h.searchFound) || 0;
    return {
      searching: true,
      found,
      total,
      pct: total ? Math.min(100, Math.round((found / total) * 100)) : 0,
    };
  }
  if (h.phase === 'scanning' && Number(h.total) > 0) {
    return {
      searching: false,
      scanned: Number(h.scanned) || 0,
      total: Number(h.total),
      pct: Math.min(100, Math.round(((Number(h.scanned) || 0) / Number(h.total)) * 100)),
    };
  }
  if (h.phase === 'live') {
    const total = Number(h.searchTotal) || 0;
    const done = Number(h.scanned) || 0;
    return {
      live: true,
      done,
      total,
      people: Number(h.searchFound) || 0,
      pct: total ? Math.min(100, Math.round((done / total) * 100)) : 0,
    };
  }
  return null;
});

const scheduler = ref({ active: [], queued: [], activeCount: 0, queuedCount: 0 });
const currentTaskQueued = computed(() => {
  const id = currentTask.value?.id;
  return !!id && (scheduler.value.queued || []).some((x) => String(x.taskId) === String(id));
});
const currentTaskRunning = computed(() => {
  const id = currentTask.value?.id;
  return !!id && (scheduler.value.active || []).some((x) => String(x.taskId) === String(id));
});

async function loadScheduler() {
  try {
    scheduler.value = await api.mt.scheduler();
  } catch {
    // 调度状态只是辅助信息，失败不打扰用户
  }
}

const monitorProgress = computed(() => {
  const m = currentTask.value?.monitor;
  if (!m) return null;
  const videos = Array.isArray(m.videos) ? m.videos : [];
  const total = Number(m.videoCount) || videos.length;
  if (!total) return null;
  const scanned = videos.filter((v) => v.lastScanAt).length;
  return { scanned, total, pct: Math.min(100, Math.round((scanned / total) * 100)) };
});

const taskKeywords = ref([]);

const harvestKeywords = computed(() => {
  if (taskKeywords.value.length) return taskKeywords.value;
  const list = currentTask.value?.harvest?.keywords;
  return Array.isArray(list) ? list : [];
});

function selectAllTemplates() {
  selectedTemplateIds.value = templates.value.map((t) => t.id);
  sendTexts.value = templates.value.map((t) => t.text).join('\n');
}

function clearTemplates() {
  selectedTemplateIds.value = [];
  sendTexts.value = '';
}

async function loadKeywordOptions() {
  if (!currentTask.value?.id) {
    taskKeywords.value = [];
    return;
  }
  try {
    const list = await api.ic.keywords(currentTask.value.id);
    taskKeywords.value = Array.isArray(list) ? list : [];
    if (keywordFilter.value && !taskKeywords.value.some((x) => x.keyword === keywordFilter.value)) {
      keywordFilter.value = '';
    }
  } catch {
    taskKeywords.value = [];
  }
}

const harvestShortfall = computed(() => {
  const h = currentTask.value?.harvest;
  if (!h || h.phase !== 'searching') return '';
  const found = Number(h.searchFound) || 0;
  const target = Number(h.searchTotal) || 0;
  if (!target || found >= target) return '';
  return `已找到 ${found} / 目标 ${target}；单关键词池通常 80~120 条，建议增加关键词`;
});

const filteredTargets = computed(() => targets.value);

const monitorCountdown = computed(() => {
  const m = currentTask.value?.monitor;
  if (!m || !m.enabled) return '';
  if (m.running) return '扫描中…';
  const left = Number(m.nextRunAt || 0) - clock.value;
  if (!Number.isFinite(left) || left <= 0) return '即将执行';
  const sec = Math.ceil(left / 1000);
  return sec >= 60 ? `下一轮约 ${Math.ceil(sec / 60)} 分钟` : `下一轮 ${sec} 秒`;
});


const enabledAccounts = computed(() => props.accounts.filter((a) => a.enabled && a.uid));

const form = ref({
  name: '',
  accountId: '',
  raw: '',
  competitorIds: [],
  ...FIXED_SEND,
});

// 同行视频监控：直接勾选活跃同行，默认全视频监控
const competitorOptions = ref([]);
const competitorLoading = ref(false);
const competitorSearch = ref('');
const liveBrowser = ref(null); // null=未检查，{ok}＝检查结果

async function checkLiveBrowser() {
  try { liveBrowser.value = await api.ic.liveBrowser(); } catch (e) {
    liveBrowser.value = { ok: false, error: e.message };
  }
}

const filteredCompetitorOptions = computed(() => {
  const q = competitorSearch.value.trim().toLowerCase();
  if (!q) return competitorOptions.value;
  return competitorOptions.value.filter((x) =>
    String(x.nickname || '').toLowerCase().includes(q) ||
    String(x.secUid || '').toLowerCase().includes(q) ||
    String(x.keywords || '').toLowerCase().includes(q));
});

async function loadCompetitorOptions({ selectAll = false } = {}) {
  competitorLoading.value = true;
  try {
    const r = await api.cp.list({ limit: 2000 });
    competitorOptions.value = (r?.rows || []).filter(
      (x) => x.activeLevel === 'active' || x.activeLevel === 'normal',
    );
    if (selectAll) {
      form.value.competitorIds = competitorOptions.value.map((x) => x.id);
    } else {
      form.value.competitorIds = form.value.competitorIds.filter(
        (id) => competitorOptions.value.some((x) => x.id === id),
      );
    }
  } catch {
    competitorOptions.value = [];
  } finally {
    competitorLoading.value = false;
  }
}

// 发送话术池（一行一条，发送时随机/顺序轮换）
const DEFAULT_TEXT = '您好，看到您对这个话题感兴趣，方便聊两句吗';
const sendTexts = ref(DEFAULT_TEXT);
const sendStrategy = ref('random');
const sendAccountIds = ref([]);
const templates = ref([]);
const selectedTemplateIds = ref([]);
const sendMessages = computed(() =>
  sendTexts.value
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean),
);

async function loadTemplates() {
  try {
    const list = await api.ic.templates();
    templates.value = Array.isArray(list) ? list : [];
  } catch {
    templates.value = [];
  }
}

function toggleTemplate(t, checked) {
  // 第一次勾选模板时，移除默认占位话术
  if (checked && selectedTemplateIds.value.length === 0 && sendTexts.value.trim() === DEFAULT_TEXT) {
    sendTexts.value = '';
  }
  const lines = sendTexts.value
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const set = new Set(selectedTemplateIds.value);
  if (checked) {
    set.add(t.id);
    if (!lines.includes(t.text)) lines.push(t.text);
  } else {
    set.delete(t.id);
    const idx = lines.indexOf(t.text);
    if (idx >= 0) lines.splice(idx, 1);
  }
  selectedTemplateIds.value = [...set];
  sendTexts.value = lines.join('\n');
}

const tplDialogVisible = ref(false);
const tplDraft = ref([]);

function openTemplateEditor() {
  tplDraft.value = templates.value.map((t) => ({ ...t }));
  tplDialogVisible.value = true;
}

function addTemplateDraft() {
  tplDraft.value.push({
    id: `tpl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: '新话术',
    text: '',
  });
}

function removeTemplateDraft(index) {
  tplDraft.value.splice(index, 1);
}

async function saveTemplateDraft() {
  const clean = tplDraft.value
    .map((t) => ({
      id: t.id,
      name: String(t.name || '').trim() || '未命名',
      text: String(t.text || '').replace(/\s*\r?\n\s*/g, ' ').trim(),
    }))
    .filter((t) => t.text);
  if (!clean.length) {
    ElMessage.error('至少保留一条话术');
    return;
  }
  try {
    const saved = await api.ic.saveTemplates(clean);
    templates.value = Array.isArray(saved) ? saved : clean;
    selectedTemplateIds.value = [];
    tplDialogVisible.value = false;
    ElMessage.success('话术库已保存，请重新勾选');
  } catch (e) {
    ElMessage.error(e.message || '保存失败');
  }
}

// 解析预览
const parsed = ref(null);

async function switchMode(m) {
  mode.value = m;
  form.value.raw = '';
  parsed.value = null;
  if (m === 'competitor') {
    // 首次进入同行视频监控时默认勾选全部活跃/一般同行
    await loadCompetitorOptions({ selectAll: !form.value.competitorIds.length });
  } else if (m === 'live') {
    await checkLiveBrowser();
  }
}

async function onRawInput() {
  if (!form.value.raw.trim()) { parsed.value = null; return; }
  try {
    parsed.value = await api.ic.parse(form.value.raw, mode.value);
  } catch { parsed.value = null; }
}

// ── 数据 ──
async function loadTasks() {
  loading.value = true;
  try {
    tasks.value = await api.ic.list();
  } catch (e) {
    console.error(e);
  } finally {
    loading.value = false;
  }
}

async function loadDefaults() {
  try {
    defaults.value = await api.ic.defaults();
    if (Array.isArray(defaults.value?.modes) && defaults.value.modes.length) {
      modes.value = defaults.value.modes.filter((m) => m.key !== 'video').slice();
    }
    dryRun.value = (await api.sender.getDryRun()).dryRun;
    // 采集参数固定，不再由用户配置；每次启动静默纠正旧值
    await api.ic.saveHarvestConfig(FIXED_HARVEST);
    await loadConfig();
  } catch {}
}

async function loadConfig() {
  try {
    const c = await api.ic.harvestConfig();
    cfg.value = {
      gapMin: Math.round(c.requestGapMinMs / 1000),
      gapMax: Math.round(c.requestGapMaxMs / 1000),
      daily: c.dailyRequestLimit,
      pages: c.maxPagesPerVideo,
      videos: c.maxVideosPerTask,
      scanVideos: c.initialScanVideos,
      leads: c.maxLeadsPerTask,
      ageDays: c.maxCommentAgeDays,
    };
  } catch {}
}

async function resetUsage() {
  await api.ic.resetUsage();
  ElMessage.success('今日采集计数已重置');
}

// ── 向导流程 ──
function openWizard() {
  form.value = {
    name: '',
    accountId: enabledAccounts.value[0]?.id ?? '',
    raw: '',
    competitorIds: [],
    ...FIXED_SEND,
  };
  parsed.value = null;
  competitorSearch.value = '';
  mode.value = 'keyword';
  step.value = 1;
  sendTexts.value = DEFAULT_TEXT;
  sendStrategy.value = 'random';
  selectedTemplateIds.value = [];
  sendAccountIds.value = [];
  wizardVisible.value = true;
}

async function doHarvest() {
  if (!form.value.accountId) { ElMessage.error('请指定一个采集账号'); return; }
  if (mode.value === 'live' && liveBrowser.value && !liveBrowser.value.ok) {
    ElMessage.error(liveBrowser.value.error || '未找到 Chrome 或 Edge，无法采集直播间');
    return;
  }
  if (mode.value === 'competitor') {
    if (!form.value.competitorIds.length) {
      ElMessage.error('请至少勾选一个同行');
      return;
    }
    harvesting.value = true;
    try {
      const r = await api.cp.addToLeads({
        competitorIds: form.value.competitorIds,
        accountId: form.value.accountId,
        name: form.value.name || undefined,
      });
      if (!r.ok) { ElMessage.error(r.error || '创建同行视频监控失败'); return; }
      currentTask.value = await api.ic.get(r.taskId);
      targets.value = [];
      await loadTargets();
      step.value = 2;
      ElMessage.success(`已创建同行视频监控：${r.competitorCount} 个同行，${r.videoCount} 条视频`);
    } catch (e) {
      ElMessage.error(e.message);
    } finally {
      harvesting.value = false;
    }
    return;
  }
  const raw = form.value.raw.trim();
  if (!raw) {
    ElMessage.error(mode.value === 'keyword' ? '请填写关键词' : '请填写内容');
    return;
  }


  // 先做本地校验，避免白跑一次请求
  const list = parsed.value?.targets ?? [];
  if (!list.length) {
    ElMessage.error(
      mode.value === 'manual' ? '没有有效的 UID'
        : mode.value === 'video' ? '没有有效的视频'
          : mode.value === 'live' ? '没有有效的直播间，请填 live.douyin.com/数字 或房间号'
            : '请至少填一个关键词',
    );
    return;
  }
  const kwMax = parsed.value?.max ?? 20;
  if (mode.value === 'keyword' && list.length > kwMax) {
    ElMessage.error(`最多 ${kwMax} 个关键词`);
    return;
  }

  harvesting.value = true;
  let stage = '创建任务';
  try {
    const created = await api.ic.create({
      name: form.value.name,
      accountIds: [form.value.accountId],
      raw,
      harvestMode: mode.value,
      params: {
        dailyLimit: form.value.dailyLimit,
        hourlyLimit: form.value.hourlyLimit,
        batchSize: form.value.batchSize,
        roundWaitSec: form.value.roundWaitSec,
        gapMinSec: defaults.value?.gapMinSec,
        gapMaxSec: defaults.value?.gapMaxSec,
      },
    });

    if (!created.ok) { ElMessage.error(created.error); return; }

    stage = '启动采集';
    const startOpts = {};
    if (mode.value === 'video' || mode.value === 'keyword') {
      startOpts.monitor = monitorOptions();
    }

    const started = await api.ic.startHarvest(created.id, startOpts);
    if (!started.ok) {
      ElMessage.error(started.error);
      return;
    }

    // ★ 不在这里等采集：直接进审核页，线索边采边出现
    currentTask.value = await api.ic.get(created.id);
    targets.value = [];
    step.value = 2;
    startHarvestPolling(created.id);
    ElMessage.success('已开始采集，线索会陆续出现在下面');
  } catch (e) {
    ElMessage.error(`[${stage}] ${e.message}`);
  } finally {
    harvesting.value = false;
  }
}

// ── 后台采集轮询 ──
let harvestTimer = null;

function stopHarvestPolling() {
  if (harvestTimer) clearInterval(harvestTimer);
  harvestTimer = null;
}

function startHarvestPolling(taskId) {
  stopHarvestPolling();
  let lastTotal = -1;

  const tick = async () => {
    if (!wizardVisible.value || !currentTask.value || currentTask.value.id !== taskId) {
      stopHarvestPolling();
      return;
    }
    try {
      const t = await api.ic.get(taskId);
      if (!t) return;
      currentTask.value = t;

      // 线索数变化才刷新列表，避免打断勾选
      if (t.total !== lastTotal) {
        lastTotal = t.total;
        await loadTargets();
        await loadTasks();
      }

      if (t.stage !== 'harvesting' && !t.harvestRunning) {
        stopHarvestPolling();
        await loadTargets();
        await loadTasks();

        if (t.stage === 'failed') {
          ElMessage({
            type: 'error',
            message: '采集失败：' + (t.harvest?.error || '未知错误'),
            duration: 8000,
          });
          return;
        }

        const sum = t.harvest?.summary;
        const bits = [`采集完成：${t.targetCount} 人`];
        if (sum?.live) {
          if (sum.rooms) bits.push(`直播间 ${sum.rooms} 个`);
          if (sum.viewers) bits.push(`观众 ${sum.viewers} 人`);
          if (sum.comments) bits.push(`评论 ${sum.comments} 条`);
        }
        if (sum?.videos) bits.push(`视频 ${sum.videos} 条`);
        if (sum?.scanned && !sum?.live) bits.push(`首次扫描 ${sum.scanned} 条`);
        if (sum?.truncated) bits.push(`线索超限截断 ${sum.truncated}`);
        if (sum?.requests) bits.push(`请求 ${sum.requests} 次`);
        ElMessage.success(bits.join('，'));

        if (t.monitor) {
          ElMessage.success(
            `已开启监控：${t.monitor.videoCount} 条视频，每 ${fmtInterval(t.monitor.intervalSec)} 一轮；每轮自动发现新视频并全量扫描评论`,
          );
        }
        if (sum?.monitorError) {
          ElMessage({ type: 'warning', message: '监控创建失败：' + sum.monitorError, duration: 6000 });
        }
        if (sum?.warnings?.length) {
          ElMessage({ type: 'warning', message: sum.warnings.join('；'), duration: 8000 });
        }
      }
    } catch {
      // 轮询失败不打扰用户，下一轮再试
    }
  };

  harvestTimer = setInterval(tick, 1500);
  tick();
}

async function retryHarvest() {
  if (!currentTask.value) return;
  const opts = {};
  if (['video', 'keyword'].includes(currentTask.value.targetMode)) {
    opts.monitor = monitorOptions();
  }
  const r = await api.ic.startHarvest(currentTask.value.id, opts);
  if (!r.ok) { ElMessage.error(r.error); return; }
  ElMessage.success('已重新开始采集');
  startHarvestPolling(currentTask.value.id);
}

function onWizardClosed() {
  stopHarvestPolling();
}

async function toggleMonitor() {
  if (!currentTask.value?.monitor) return;
  const next = !currentTask.value.monitor.enabled;
  const r = await api.mt.toggle(currentTask.value.id, next);
  if (!r.ok) { ElMessage.error(r.error); return; }
  ElMessage.success(next ? '监控已恢复' : '监控已暂停');
  await refreshCurrent();
}

async function runMonitorNow() {
  if (!currentTask.value?.monitor) return;
  monitorBusy.value = true;
  try {
    const r = await api.mt.runNow(currentTask.value.id);
    if (!r.ok) { ElMessage.error(r.error); return; }
    const s2 = r.summary ?? {};
    ElMessage.success(
      `本轮：扫描 ${s2.scannedVideos ?? 0} 条视频，新视频 ${s2.newVideos ?? 0} 条，` +
      `新评论 ${s2.newComments ?? 0} 条，新增线索 ${s2.newLeads ?? 0} 条` +
      (s2.requests ? `，请求 ${s2.requests} 次` : ''),
    );
    if (s2.error) ElMessage({ type: 'warning', message: s2.error, duration: 6000 });
    await refreshCurrent();
    await loadTargets();
  } finally {
    monitorBusy.value = false;
  }
}

async function refreshCurrent() {
  if (!currentTask.value) return;
  currentTask.value = await api.ic.get(currentTask.value.id);
  await loadTasks();
}

async function loadTargets({ resetPage = false } = {}) {
  if (!currentTask.value) return;
  if (resetPage) targetPage.value = 1;
  try {
    const pageSize = Math.max(1, Number(targetPageSize.value) || 50);
    const r = await api.ic.targets(currentTask.value.id, {
      status: reviewFilter.value || undefined,
      keyword: keywordFilter.value || undefined,
      since: reviewSinceMs(),
      limit: pageSize,
      offset: (targetPage.value - 1) * pageSize,
    });
    targets.value = r?.items ?? [];
    targetTotal.value = Number(r?.total) || 0;
    // 采集过程中列表会增长：保留用户已经勾选、且仍在当前页里的项
    const ids = new Set(targets.value.map((t) => t.id));
    selectedIds.value = selectedIds.value.filter((id) => ids.has(id));
    await loadKeywordOptions();

    // 当前页被筛空时自动回退到最后一页
    if (!targets.value.length && targetPage.value > 1) {
      targetPage.value = Math.max(1, Math.ceil(targetTotal.value / pageSize));
      return loadTargets();
    }
  } catch (e) {
    ElMessage.error('加载目标失败');
  }
}

function onKeywordFilterChange() {
  loadTargets({ resetPage: true });
}

function onTimeRangeChange() {
  loadTargets({ resetPage: true });
}

function onReviewFilterChange() {
  loadTargets({ resetPage: true });
}

function onPageSizeChange() {
  targetPage.value = 1;
  loadTargets();
}

const pendingCount = computed(() => targets.value.filter((t) => t.status === 'pending').length);

function selectAll() {
  selectedIds.value = filteredTargets.value
    .filter((t) => t.status === 'pending')
    .map((t) => t.id);
}

function selectNone() {
  selectedIds.value = [];
}

function goTargetChat(t) {
  if (!t?.uid || !currentTask.value) return;
  const accountId = currentTask.value.accountIds?.[0];
  if (!accountId) {
    ElMessage.error('任务没有绑定账号');
    return;
  }
  openChat({
    accountId,
    peerUid: t.uid,
    peerName: t.name || t.uid,
    peerSecUid: t.secUid || null,
    peerAvatar: t.avatar || null,
    text: '',
  });
}

async function exportTargets() {
  if (!currentTask.value) return;
  let rows = [];
  try {
    const r = await api.ic.targets(currentTask.value.id, {
      status: reviewFilter.value || undefined,
      keyword: keywordFilter.value || undefined,
      since: reviewSinceMs(),
      all: true,
    });
    rows = r?.items ?? [];
  } catch {
    ElMessage.error('导出失败：无法读取完整列表');
    return;
  }
  if (!rows.length) {
    ElMessage.info('当前筛选下没有可导出的目标');
    return;
  }
  const header = ['UID', '昵称', '状态', '评论类型', '关键词', '评论', '评论时间', '来源', '来源标题', '点赞'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [
    header.map(esc).join(','),
    ...rows.map((t) => [
      t.uid, t.name, t.status, commentTypeText(t), t.sourceKeyword, t.sourceComment,
      t.commentAt ? fmtTime(t.commentAt) : '', t.sourceVideo, t.sourceVideoTitle, t.commentLikes,
    ].map(esc).join(',')),
  ].join('\r\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `线索雷达目标-${currentTask.value?.name || currentTask.value?.id || 'export'}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  ElMessage.success(`已导出 ${rows.length} 条`);
}

async function approveSelected() {
  if (!selectedIds.value.length) { ElMessage.error('请先选择目标'); return; }
  const ids = [...selectedIds.value];
  const r = await api.ic.review(currentTask.value.id, ids, 'approved');
  if (r.ok) {
    ElMessage.success(`已批准 ${r.changed} 人`);
    currentTask.value = await api.ic.get(currentTask.value.id);
    await loadTargets();
  } else {
    ElMessage.error(r.error || '批准失败');
  }
}

async function excludeSelected() {
  if (!selectedIds.value.length) { ElMessage.error('请先选择目标'); return; }
  const ids = [...selectedIds.value];
  const r = await api.ic.review(currentTask.value.id, ids, 'excluded');
  if (r.ok) {
    ElMessage.info(`已排除 ${r.changed} 人`);
    currentTask.value = await api.ic.get(currentTask.value.id);
    await loadTargets();
  } else {
    ElMessage.error(r.error || '排除失败');
  }
}

async function approveAll() {
  if (!currentTask.value?.pending) {
    ElMessage.info('没有待审核线索');
    return;
  }
  try {
    await ElMessageBox.confirm(
      `将当前任务 ${currentTask.value.pending} 条待审核线索全部批准？`,
      '一键审核',
      { type: 'warning', confirmButtonText: '全部批准', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  const r = await api.ic.approveAll(currentTask.value.id);
  if (r.ok) {
    ElMessage.success(`已批准 ${r.changed} 条`);
    currentTask.value = await api.ic.get(currentTask.value.id);
    await loadTargets();
  } else {
    ElMessage.error(r.error || '一键审核失败');
  }
}

async function goSend() {
  currentTask.value = await api.ic.get(currentTask.value.id);
  if (!currentTask.value.approved) {
    ElMessage.error('还没有审核通过的目标');
    return;
  }
  const enabledIds = new Set(enabledAccounts.value.map((a) => a.id));
  const taskIds = (currentTask.value.accountIds || []).filter((id) => enabledIds.has(id));
  sendAccountIds.value = taskIds.length
    ? taskIds
    : enabledAccounts.value.map((a) => a.id);

  // 恢复任务已保存的话术池；新任务默认全选话术库，避免发默认问候
  const savedTexts = Array.isArray(currentTask.value.contentItems) ? currentTask.value.contentItems : [];
  if (savedTexts.length) {
    sendTexts.value = savedTexts.join('\n');
    sendStrategy.value = currentTask.value.contentStrategy === 'sequence' ? 'sequence' : 'random';
  } else if (templates.value.length) {
    sendTexts.value = templates.value.map((t) => t.text).join('\n');
    selectedTemplateIds.value = templates.value.map((t) => t.id);
    sendStrategy.value = 'random';
  }
  step.value = 3;
}

function selectAllSendAccounts() {
  sendAccountIds.value = enabledAccounts.value.map((a) => a.id);
}

function clearSendAccounts() {
  sendAccountIds.value = [];
}

async function doRun() {
  const texts = sendMessages.value;
  if (!texts.length) {
    ElMessage.error('发送话术不能为空');
    return;
  }
  if (texts.some((t) => t.length > 500)) {
    ElMessage.error('每条话术不能超过 500 字');
    return;
  }
  const accountIds = [...sendAccountIds.value];
  if (!accountIds.length) {
    ElMessage.error('请至少选择一个发送账号');
    return;
  }

  if (!dryRun.value) {
    try {
      await ElMessageBox.confirm(
        `即将使用 ${accountIds.length} 个账号，向 ${currentTask.value.approved} 个陌生人真实发送私信。\n\n` +
        `文案：共 ${texts.length} 条，${sendStrategy.value === 'sequence' ? '顺序轮换' : '随机轮换'}。\n` +
        `参数：个人号每日 60 条、蓝V 每日 150 条（按账号类型自动限制），` +
        `间隔 1 秒/条。\n\n这是高危操作，确定继续？`,
        '确认真实发送',
        { type: 'warning', confirmButtonText: '确定发送', cancelButtonText: '取消' },
      );
    } catch { return; }
  }

  try {
    const r = await api.ic.run(currentTask.value.id, {
      texts,
      strategy: sendStrategy.value,
      accountIds,
    });
    if (r.ok) {
      ElMessage.success('任务已启动');
      wizardVisible.value = false;
      await loadTasks();
    } else {
      ElMessage.error(r.error);
    }
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function removeTask(t) {
  try {
    await ElMessageBox.confirm(`确定删除任务「${t.name}」？`, '删除任务', { type: 'warning' });
    await api.ic.delete(t.id);
    ElMessage.success('已删除');
    await loadTasks();
  } catch {}
}

// 从列表恢复：回到审核，或直接到发送确认
async function resumeTask(t) {
  const full = await api.ic.get(t.id);
  if (!full) { ElMessage.error('任务不存在'); return; }
  currentTask.value = full;

  // 采集失败/还没采到：回到第一步，把原始输入带出来方便重采
  if (full.stage === 'failed' || full.stage === 'harvesting') {
    mode.value = full.targetMode || 'manual';
    form.value = {
      name: full.name,
      accountId: full.accountIds?.[0] ?? '',
      raw: full.targetRaw || '',
      competitorIds: full.competitorIds || [],
      dailyLimit: full.params.dailyLimit,
      hourlyLimit: full.params.hourlyLimit,
      batchSize: full.params.batchSize,
      roundWaitSec: full.params.roundWaitSec,
    };
    parsed.value = null;
    if (mode.value === 'competitor') await loadCompetitorOptions();
    else await onRawInput();
    step.value = 1;
    sendTexts.value = DEFAULT_TEXT;
    sendStrategy.value = 'random';
    selectedTemplateIds.value = [];
    sendAccountIds.value = [];
    wizardVisible.value = true;
    return;
  }

  reviewFilter.value = full.pending > 0 ? 'pending' : 'approved';
  await loadTargets({ resetPage: true });
  const savedTexts = Array.isArray(full.contentItems) ? full.contentItems : [];
  if (savedTexts.length) {
    sendTexts.value = savedTexts.join('\n');
    sendStrategy.value = full.contentStrategy === 'sequence' ? 'sequence' : 'random';
    selectedTemplateIds.value = [];
  } else if (templates.value.length) {
    sendTexts.value = templates.value.map((t) => t.text).join('\n');
    sendStrategy.value = 'random';
    selectedTemplateIds.value = templates.value.map((t) => t.id);
  } else {
    sendTexts.value = DEFAULT_TEXT;
    sendStrategy.value = 'random';
    selectedTemplateIds.value = [];
  }
  step.value = full.approved > 0 && full.pending === 0 ? 3 : 2;
  wizardVisible.value = true;
}

function canResume(t) {
  // done 也允许回来：可能只批了一批，剩下的还能继续审核/发送
  return (
    (['reviewing', 'ready', 'paused', 'done'].includes(t.stage) &&
      t.pending + t.approved > 0) ||
    t.stage === 'failed'
  );
}

// ── 展示 ──
const stageMap = {
  harvesting: { text: '采集中', tag: 'warning' },
  reviewing: { text: '待审核', tag: 'warning' },
  ready: { text: '可发送', tag: 'success' },
  running: { text: '发送中', tag: 'warning' },
  paused: { text: '已暂停', tag: 'warning' },
  done: { text: '已完成', tag: 'success' },
  failed: { text: '采集失败', tag: 'danger' },
  cancelled: { text: '已取消', tag: 'info' },
};

const statusMap = {
  pending: { text: '待审核', tag: 'info' },
  approved: { text: '已批准', tag: 'success' },
  excluded: { text: '已排除', tag: 'info' },
  sent: { text: '已发送', tag: 'success' },
  failed: { text: '失败', tag: 'danger' },
  skipped: { text: '已跳过', tag: 'warning' },
};

const reasonMap = {
  contacted_before: '之前联系过',
  peer_sent_today: '今天已发过',
  peer_limited: '对方消息达上限',
  peer_forbidden: '对方私信权限受限',
  account_verify_required: '需抖音App验证',
  sensitive_blocked: '敏感词拦截',
};

function reasonText(r) {
  return reasonMap[r] || r;
}

const commentTypeMap = {
  root: '根评论',
  reply: '楼中楼',
  manual: '手动导入',
  live_comment: '直播评论',
  live_audience: '直播观众',
};

function commentTypeText(t) {
  return commentTypeMap[t.commentType] || '根评论';
}

const modeMap = {
  manual: '手动',
  video: '视频评论',
  keyword: '关键词',
  live: '直播间',
  competitor: '同行视频监控',
};

function fmtInterval(sec) {
  const n = Number(sec) || 0;
  if (n < 60) return `${n} 秒`;
  if (n < 3600) return `${Math.round(n / 60)} 分钟`;
  return `${(n / 3600).toFixed(n % 3600 === 0 ? 0 : 1)} 小时`;
}

function fmtLastActive(ms) {
  if (!ms) return '';
  const diff = Math.max(0, Date.now() - Number(ms));
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

async function refreshPresence() {
  if (!currentTask.value) return;
  presenceBusy.value = true;
  try {
    const r = await api.ic.refreshPresence(currentTask.value.id);
    if (!r.ok) {
      ElMessage.error(r.error || '刷新在线状态失败');
      return;
    }
    ElMessage.success(
      `在线状态已刷新：在线 ${r.online} 人，最近活跃 ${r.active} 人，未知 ${r.unknown} 人`,
    );
    await loadTargets();
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    presenceBusy.value = false;
  }
}

function fmtCommentTime(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

let offMonitor = null;
let schedulerTimer = null;

onMounted(async () => {
  await loadDefaults();
  await loadTemplates();
  await loadTasks();
  await loadScheduler();
  timer = setInterval(loadTasks, 6000);
  schedulerTimer = setInterval(loadScheduler, 6000);
  clockTimer = setInterval(() => { clock.value = Date.now(); }, 1000);
  // 监控每跑完一轮，刷新列表和当前任务
  offMonitor = api.on('monitor:event', async (ev) => {
    await loadTasks();
    if (!currentTask.value) return;
    // 只刷新当前打开的任务，避免后台任务把当前列表刷掉
    if (ev?.taskId && String(ev.taskId) !== String(currentTask.value.id)) return;
    await refreshCurrent();
    await loadTargets();
  });
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
  if (schedulerTimer) clearInterval(schedulerTimer);
  if (clockTimer) clearInterval(clockTimer);
  stopHarvestPolling();
  offMonitor?.();
});
</script>

<template>
  <div class="ic-view">
    <header class="page-head">
      <div>
        <h2>线索雷达</h2>
        <p class="sub">
          三段式：采集 → 审核 → 发送 · 极速参数（每账号日 1000 条 · 间隔 1 秒）
        </p>
      </div>
      <div class="head-actions">
        <span class="dryrun" :class="{ on: dryRun }">
          {{ dryRun ? '🧪 演练模式' : '⚡ 真实发送' }}
        </span>
        <button class="primary" @click="openWizard">＋ 新建线索任务</button>
      </div>
    </header>

    <div class="warning-bar">
      ⚠️ 线索雷达会从视频评论区发现潜在客户；平台对陌生人私信限制严格，账号权重会下降。建议每账号每天不超过 10 条，并先小批量验证。
    </div>

    <div class="table-wrap">
      <div v-if="loading && !tasks.length" class="empty">加载中…</div>
      <div v-else-if="!tasks.length" class="empty">
        <p>还没有线索任务</p>
        <p class="hint">点右上角「新建线索任务」，先导入 UID 再审核</p>
      </div>

      <table v-else class="task-table">
        <thead>
          <tr>
            <th style="width: 180px">任务名</th>
            <th style="width: 70px">账号</th>
            <th style="width: 80px">采集</th>
            <th style="width: 90px">待审核</th>
            <th style="width: 90px">已批准</th>
            <th style="width: 80px">已发送</th>
            <th style="width: 80px">阶段</th>
            <th style="width: 110px">创建时间</th>
            <th style="width: 80px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in tasks" :key="t.id" class="task-row" @click="resumeTask(t)">
            <td class="name" :title="t.name">
              <span class="mode-tag">{{ modeMap[t.targetMode] || t.targetMode }}</span>
              <span v-if="t.competitorCount" class="mode-tag mon" title="引用同行监控">同行 {{ t.competitorCount }}</span>
              <span v-if="t.monitor?.enabled" class="mode-tag mon" title="持续监控中">监控</span>
              {{ t.name }}
            </td>
            <td>{{ t.accountIds.length }}</td>
            <td>{{ t.targetCount }}</td>
            <td :class="{ hl: t.pending > 0 }">{{ t.pending }}</td>
            <td :class="{ hl: t.approved > 0 }">{{ t.approved }}</td>
            <td>{{ t.sent }}</td>
            <td>
              <span class="tag" :class="stageMap[t.stage]?.tag">
                {{ stageMap[t.stage]?.text || t.stage }}
              </span>
            </td>
            <td class="mono">{{ fmtTime(t.createdAt) }}</td>
            <td class="ops" @click.stop>
              <button v-if="canResume(t)" class="ok" @click="resumeTask(t)">
                {{ t.stage === 'failed' ? '重采' : t.pending > 0 ? '审核' : '发送' }}
              </button>
              <button class="danger" @click="removeTask(t)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 向导 -->
    <el-dialog v-model="wizardVisible" title="新建线索任务" width="min(680px, calc(100vw - 32px))" top="4vh" class="ic-wizard" :close-on-click-modal="false" @closed="onWizardClosed">
      <!-- 步骤条 -->
      <div class="steps">
        <div class="step" :class="{ active: step === 1, done: step > 1 }">
          <span class="num">1</span> 采集
        </div>
        <div class="line"></div>
        <div class="step" :class="{ active: step === 2, done: step > 2 }">
          <span class="num">2</span> 审核
        </div>
        <div class="line"></div>
        <div class="step" :class="{ active: step === 3 }">
          <span class="num">3</span> 发送
        </div>
      </div>

      <!-- 步骤 1：采集 -->
      <div v-if="step === 1" class="step-body">
        <div class="row account-row">
          <label>采集账号</label>
          <select v-model="form.accountId" class="account-select" :disabled="!enabledAccounts.length">
            <option value="" disabled>请选择账号</option>
            <option v-for="a in enabledAccounts" :key="a.id" :value="a.id">
              {{ a.nickname || a.uid }}
            </option>
          </select>
          <span class="hint">
            {{ enabledAccounts.length
              ? (mode === 'live' ? '该账号负责采集直播间，也用于后续发送' : '该账号负责抓取视频和评论，也用于后续发送')
              : '请先登录并启用一个账号' }}
          </span>
        </div>
        <div class="row">
          <label>采集方式</label>
          <div class="mode-tabs">
            <button
              v-for="m in modes"
              :key="m.key"
              :class="{ active: mode === m.key }"
              @click="switchMode(m.key)"
            >
              {{ m.name }}
            </button>
          </div>
        </div>

        <div v-if="mode === 'competitor'" class="row">
          <label>选择同行</label>
          <div class="competitor-picker">
            <div class="cp-picker-head">
              <span>已选 <b>{{ form.competitorIds.length }}</b> / {{ competitorOptions.length }} 个同行</span>
              <div class="cp-picker-actions">
                <input v-model="competitorSearch" placeholder="搜索昵称/UID/关键词" />
                <button class="mini" @click="form.competitorIds = filteredCompetitorOptions.map(x => x.id)">
                  全选
                </button>
                <button class="mini" @click="form.competitorIds = []">清空</button>
                <button class="mini" :disabled="competitorLoading" @click="loadCompetitorOptions()">
                  {{ competitorLoading ? '加载中…' : '刷新' }}
                </button>
              </div>
            </div>
            <div v-if="competitorLoading" class="hint">正在加载活跃同行…</div>
            <div v-else-if="!competitorOptions.length" class="hint">
              还没有活跃同行，请先到「同行监控」按关键词采集。
            </div>
            <div v-else-if="!filteredCompetitorOptions.length" class="hint">
              没有匹配的同行，换个搜索词试试。
            </div>
            <div v-else class="cp-list">
              <label v-for="p in filteredCompetitorOptions" :key="p.id" class="cp-item">
                <input type="checkbox" :value="p.id" v-model="form.competitorIds" />
                <span class="cp-name">{{ p.nickname || p.secUid }}</span>
                <span class="tag" :class="p.activeLevel === 'active' ? 'success' : 'warning'">
                  {{ p.activeLevel === 'active' ? '活跃' : '一般' }}
                </span>
                <span class="cp-meta">{{ p.videoCount }} 条视频 · 最近 {{ fmtTime(p.latestVideoAt) }}</span>
              </label>
            </div>
          </div>
        </div>

        <div v-if="mode !== 'competitor'" class="row">
          <label>{{ mode === 'keyword' ? '关键词' : mode === 'video' ? '视频列表' : mode === 'live' ? '直播间' : '目标 UID' }}</label>
          <div style="flex: 1">
            <textarea
              v-if="mode === 'keyword'"
              v-model="form.raw"
              rows="3"
              placeholder="一行一个关键词，最多 20 个：&#10;装修报价&#10;全屋定制"
              @input="onRawInput"
            />
            <textarea
              v-else
              v-model="form.raw"
              rows="6"
              :placeholder="mode === 'video'
                ? '一行一个视频链接或 ID：\nhttps://www.douyin.com/video/7300000000000000000\n7300000000000000000'
                : '一行一个 UID，可带备注：\n123456789\n987654321,张三'"
              @input="onRawInput"
            />
            <div v-if="parsed && (mode === 'manual' || mode === 'video')" class="parse-info">
              有效 <strong>{{ parsed.targets.length }}</strong> 个
              <span v-if="parsed.invalid.length" class="warn">
                · {{ parsed.invalid.length }} 行格式无效
              </span>
            </div>
            <div v-if="mode === 'live'" class="parse-info">
              已识别 <strong>{{ parsed?.targets.length ?? 0 }}</strong> 个直播间
              <span v-if="parsed?.invalid?.length" class="warn">
                · {{ parsed.invalid.length }} 行格式无效
              </span>
              <span v-if="parsed?.shortLinks?.length" class="warn">
                · {{ parsed.shortLinks.length }} 个 v.douyin.com 分享短链不支持
              </span>
              · 单次最多采集 5 个
            </div>
            <div v-if="mode === 'keyword'" class="parse-info">
              共 <strong>{{ parsed?.targets.length ?? 0 }}</strong> 个关键词
              <span v-if="parsed?.invalid?.length" class="warn">
                · {{ parsed.invalid.length }} 个格式无效
              </span>
              · 手机搜索会按关键词抓视频，最多取 {{ cfg.videos }} 条；获取完成后自动开始评论监控
              <span v-if="cfg.ageDays > 0">，只保留最近 {{ cfg.ageDays }} 天的评论</span>
            </div>
            <div v-if="mode === 'keyword'" class="parse-info hint-line">
              手机搜索适合金融/汽车类关键词；单个关键词通常能取 80~115 条。网页接口被限流时会自动降级。
            </div>
            <div v-if="mode === 'video'" class="parse-info hint-line">
              支持完整链接（含 /video/数字），不支持 v.douyin.com 短链
            </div>
            <div v-if="mode === 'live'" class="live-help">
              <p><b>支持格式</b>：电脑端直播间链接 <code>https://live.douyin.com/数字</code>，或直接填房间号。</p>
              <p><b>不支持</b>：抖音 App 分享的 <code>v.douyin.com/xxxx</code> 短链。</p>
              <p><b>获取方式</b>：电脑浏览器打开抖音直播，进入直播间后复制地址栏链接。</p>
              <p><b>注意</b>：直播间必须正在开播；部分主播隐藏观众身份时只能采集评论者，匿名用户会被跳过。</p>
            </div>
          </div>
        </div>

        <div v-if="mode === 'competitor'" class="fixed-policy">
          <b>同行视频监控</b>：已选 {{ form.competitorIds.length }} 个同行，默认监控其全部当前和未来视频；
          评论扫描在线索雷达里持续进行，无需逐条选择视频。
        </div>
        <div v-else-if="mode === 'live'" class="fixed-policy">
          <b>直播采集</b>：读取当前在线观众和直播评论，匿名占位用户会自动跳过。
          一次采集当前状态，不做持续监控。
          <span v-if="liveBrowser && !liveBrowser.ok" class="warn">
            未检测到 Chrome/Edge，请先安装浏览器。
          </span>
          <span v-else-if="liveBrowser?.ok" class="ok-hint">已检测到直播采集浏览器</span>
        </div>
        <div v-else-if="mode !== 'manual'" class="fixed-policy">
          <b>固定采集策略</b>：最多 300 条视频 · 最近 24 小时 · 每视频全量评论（含楼中楼）
          · 每轮 10 路并发 · 自动持续监控。参数已固定，无需配置。
        </div>
      </div>

      <!-- 步骤 2：审核 -->
      <div v-if="step === 2" class="step-body">
        <div v-if="currentTask?.stage === 'harvesting'" class="harvest-bar">
          <span class="spin"></span>
          <span v-if="currentTask.harvest?.phase === 'live'">
            正在采集直播间：{{ currentTask.harvest.scanned || 0 }}/{{ currentTask.harvest.searchTotal || 0 }}
            ，已获取 {{ currentTask.harvest.searchFound || 0 }} 人
          </span>
          <span v-else-if="currentTask.harvest?.phase === 'searching'">
            正在获取视频：已发现 {{ currentTask.harvest.searchFound ?? 0 }} 条 / 目标
            {{ currentTask.harvest.searchTotal || cfg.videos }} 条
          </span>
          <span v-else-if="currentTask.harvest?.total">
            正在扫描评论：{{ currentTask.harvest.scanned }}/{{ currentTask.harvest.total }} 条视频
          </span>
          <span v-else>正在获取视频…</span>
          <span class="hb-count">已入库 {{ currentTask.targetCount }} 人</span>
          <span class="spacer"></span>
          <span class="hb-hint">
            {{ currentTask.harvest?.phase === 'live' ? '采集完成后进入审核' : '获取完成后自动开始评论监控' }}
          </span>
        </div>
        <div v-if="currentTask?.stage === 'harvesting' && harvestProgress"
             class="progress-track"
             :class="{ indeterminate: harvestProgress.searching && !harvestProgress.found }">
          <div class="progress-fill" :style="{ width: harvestProgress.pct + '%' }"></div>
        </div>
        <div v-if="harvestKeywords.length" class="keyword-chips">
          <span v-for="k in harvestKeywords" :key="k.keyword" class="kw-chip">
            {{ k.keyword }} <b>{{ k.count }}</b>
          </span>
        </div>
        <div v-if="harvestShortfall" class="harvest-warn">{{ harvestShortfall }}</div>
        <div v-if="currentTask?.stage === 'failed'" class="harvest-bar failed">
          <span>采集失败：{{ currentTask.harvest?.error || '未知错误' }}</span>
          <span class="spacer"></span>
          <button class="mini" @click="retryHarvest">重试采集</button>
        </div>

        <div v-if="currentTask?.monitor" class="monitor-bar">
          <span class="dot" :class="{ on: currentTask.monitor.enabled, running: currentTask.monitor.running }"></span>
          <span class="mb-state">
            {{ !currentTask.monitor.enabled ? '已暂停'
              : (currentTaskRunning || currentTask.monitor.running) ? '扫描中…'
              : currentTaskQueued ? '排队中…' : '持续监控中' }}
          </span>
          <span class="mb-info" :title="`第 ${currentTask.monitor.rounds} 轮，每 ${fmtInterval(currentTask.monitor.intervalSec)} 一轮，监控 ${currentTask.monitor.videoCount} 条视频（每轮全量扫描）；累计新评论 ${currentTask.monitor.totalNewComments ?? 0} 条`">
            第 {{ currentTask.monitor.rounds }} 轮 · 每 {{ fmtInterval(currentTask.monitor.intervalSec) }}
            · 监控 {{ currentTask.monitor.videoCount }} 条视频（每轮全量 ·
            {{ currentTask.monitor.scanConcurrency || 10 }} 路并发）
            · 运行 {{ scheduler.activeCount }} / 排队 {{ scheduler.queuedCount }}
            · 累计新评论 {{ currentTask.monitor.totalNewComments ?? 0 }} 条
            <template v-if="currentTask.monitor.lastRunAt">
              （上轮 +{{ currentTask.monitor.lastSummary?.newComments ?? 0 }} 评论，
              其中回复 +{{ currentTask.monitor.lastSummary?.newReplies ?? 0 }}，
              +{{ currentTask.monitor.lastSummary?.newVideos ?? 0 }} 视频，
              新用户 {{ currentTask.monitor.lastSummary?.newLeads ?? 0 }}，
              请求 {{ currentTask.monitor.lastSummary?.requests ?? 0 }} 次，
              耗时 {{ Math.round((currentTask.monitor.lastSummary?.durationMs ?? 0) / 1000) }} 秒）
            </template>
          </span>
          <span v-if="monitorCountdown" class="mb-count">{{ monitorCountdown }}</span>
          <span class="spacer"></span>
          <button class="mini" :disabled="monitorBusy" @click="runMonitorNow">
            {{ monitorBusy ? '执行中…' : '立即跑一轮' }}
          </button>
          <button class="mini" @click="toggleMonitor">
            {{ currentTask.monitor.enabled ? '暂停监控' : '继续监控' }}
          </button>
        </div>
        <div v-if="monitorProgress" class="progress-track monitor">
          <div class="progress-fill" :style="{ width: monitorProgress.pct + '%' }"></div>
        </div>
        <div v-if="monitorProgress" class="progress-caption">
          持续循环扫描（每轮全量）：已扫描 {{ monitorProgress.scanned }}/{{ monitorProgress.total }} 条视频
          · 第 {{ currentTask.monitor.rounds }} 轮 · 上轮新评论 {{ currentTask.monitor.lastSummary?.newComments ?? 0 }} 条
          · 新增视频 {{ currentTask.monitor.lastSummary?.newVideos ?? 0 }} 条
          · 待补楼中楼 {{ currentTask.monitor.lastSummary?.replyPending ?? 0 }} 个根评论
        </div>
        <div class="review-head">
          <div class="filters">
            <button :class="{ active: reviewFilter === 'pending' }" @click="reviewFilter = 'pending'; onReviewFilterChange()">
              待审核 {{ currentTask?.pending }}
            </button>
            <button :class="{ active: reviewFilter === 'approved' }" @click="reviewFilter = 'approved'; onReviewFilterChange()">
              已批准 {{ currentTask?.approved }}
            </button>
            <button :class="{ active: reviewFilter === 'excluded' }" @click="reviewFilter = 'excluded'; onReviewFilterChange()">
              已排除 {{ currentTask?.excluded }}
            </button>
          </div>
          <div class="bulk">
            <select
              v-model="reviewTimeRange"
              class="kw-filter"
              title="评论时间范围"
              @change="onTimeRangeChange"
            >
              <option v-for="r in REVIEW_TIME_RANGES" :key="r.key" :value="r.key">
                {{ r.label }}
              </option>
            </select>
            <select v-model="keywordFilter" class="kw-filter" @change="onKeywordFilterChange">
              <option value="">全部关键词</option>
              <option v-for="k in harvestKeywords" :key="k.keyword" :value="k.keyword">
                {{ k.keyword }}（{{ k.count }}）
              </option>
            </select>
            <button @click="exportTargets">导出全部</button>
            <button :disabled="presenceBusy" @click="refreshPresence">
              {{ presenceBusy ? '刷新中…' : '刷新在线状态' }}
            </button>
            <button @click="selectAll">全选本页</button>
            <button @click="selectNone">清空</button>
            <button class="ok" @click="approveAll">一键审核</button>
            <button class="ok" @click="approveSelected">批准所选</button>
            <button class="no" @click="excludeSelected">排除所选</button>
          </div>
        </div>
        <p class="hint" style="margin:6px 0 0">
          评论列表不是严格按时间排序：客户端会翻完页再按评论时间过滤，热门视频可能有延迟。
          在线状态只有已有会话的用户才返回，陌生人通常显示“状态未知”。
        </p>

        <div class="review-list">
          <label v-for="t in filteredTargets" :key="t.id" class="review-item" :class="t.status">
            <input
              v-if="t.status === 'pending'"
              type="checkbox"
              :value="t.id"
              v-model="selectedIds"
            />
            <span v-else class="placeholder"></span>
            <div class="ri-main">
              <div class="ri-line">
                <span class="uid">{{ t.uid }}</span>
                <span class="uname">{{ t.name || '-' }}</span>
                <span v-if="t.online === 1" class="presence online">在线</span>
                <span v-else-if="t.online === 0" class="presence offline">离线</span>
                <span v-if="t.lastActiveAt" class="presence active">
                  最近活跃 {{ fmtLastActive(t.lastActiveAt) }}
                </span>
                <span
                  v-else-if="t.presenceCheckedAt || t.secUid"
                  class="presence unknown"
                  title="抖音只对已有会话的用户返回在线状态，陌生人通常只有未知"
                >状态未知</span>
                <span class="tag" :class="statusMap[t.status]?.tag">
                  {{ statusMap[t.status]?.text || t.status }}
                </span>
                <span v-if="t.reason" class="reason">{{ reasonText(t.reason) }}</span>
                <button class="mini go-chat" @click.stop="goTargetChat(t)">去私信</button>
              </div>
              <div v-if="t.sourceComment" class="ri-sub">
                <span
                  class="cmt-type"
                  :class="t.commentType || 'root'"
                  :title="t.parentCid ? `回复根评论 ${t.parentCid}` : ''"
                >{{ commentTypeText(t) }}</span>
                <span class="cmt">“{{ t.sourceComment }}”</span>
                <span v-if="t.commentLikes" class="likes">👍 {{ t.commentLikes }}</span>
                <span v-if="t.commentAt" class="ctime">{{ fmtCommentTime(t.commentAt) }}</span>
                <span v-if="t.sourceKeyword" class="kw">{{ t.sourceKeyword }}</span>
                <span v-if="t.sourceVideo" class="src" :title="t.sourceVideoTitle || ''">
                  {{ String(t.commentType || '').startsWith('live') ? '来自直播间' : '来自视频' }}
                  {{ String(t.commentType || '').startsWith('live')
                    ? String(t.sourceVideo).replace(/^live:/, '')
                    : t.sourceVideo }}
                  <template v-if="t.sourceVideoTitle">· {{ t.sourceVideoTitle }}</template>
                </span>
              </div>
            </div>
          </label>
          <div v-if="!targets.length" class="empty small">这个筛选下没有目标</div>
        </div>

        <div v-if="targetTotal > 0" class="review-pager">
          <span class="pager-total">共 {{ targetTotal }} 条</span>
          <select v-model.number="targetPageSize" class="sel" @change="onPageSizeChange">
            <option :value="50">50 / 页</option>
            <option :value="100">100 / 页</option>
            <option :value="200">200 / 页</option>
          </select>
          <button class="mini" :disabled="targetPage <= 1" @click="targetPage--; loadTargets()">上一页</button>
          <span class="pager-page">{{ targetPage }} / {{ pageCount }}</span>
          <button class="mini" :disabled="targetPage >= pageCount" @click="targetPage++; loadTargets()">下一页</button>
        </div>

        <p class="review-tip">
          ★ 默认全部「待审核」，必须勾选并点「批准所选」才会进入发送队列。这是防止误发陌生人的关键一步。
        </p>
      </div>

      <!-- 步骤 3：发送 -->
      <div v-if="step === 3" class="step-body">
        <div class="confirm-card">
          <div class="cc-row">
            <span class="k">将发送</span>
            <span class="v big">{{ currentTask?.approved }} 人</span>
          </div>
          <div class="cc-row">
            <span class="k">使用账号</span>
            <span class="v">{{ sendAccountIds.length }} 个</span>
          </div>
          <div class="cc-row">
            <span class="k">预计耗时</span>
            <span class="v">
              约 {{ Math.ceil(((currentTask?.approved ?? 0) / Math.max(1, sendAccountIds.length)) / 60) }} 分钟
              （约 1 秒/条，多账号并行）
            </span>
          </div>
          <div class="cc-row">
            <span class="k">配额约束</span>
            <span class="v">
              个人号每日 60 条 · 蓝V 每日 150 条（按账号类型自动限制）
            </span>
          </div>
          <div class="cc-row">
            <span class="k">模式</span>
            <span class="v" :class="dryRun ? 'ok' : 'danger'">
              {{ dryRun ? '演练（不会真实发送）' : '真实发送' }}
            </span>
          </div>
        </div>

        <div class="copy-box">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <div class="copy-title">选择发送账号（{{ sendAccountIds.length }} / {{ enabledAccounts.length }}）</div>
            <div style="display:flex;gap:6px">
              <button class="tpl-edit-btn" @click="selectAllSendAccounts">全选</button>
              <button class="tpl-edit-btn" @click="clearSendAccounts">清空</button>
            </div>
          </div>
          <div class="send-target-list">
            <label v-for="a in enabledAccounts" :key="a.id" class="send-target-item">
              <input type="checkbox" :value="a.id" v-model="sendAccountIds" />
              <span class="st-name">{{ a.nickname || a.uid }}</span>
              <span class="st-uid">{{ a.uid }}</span>
            </label>
            <div v-if="!enabledAccounts.length" class="copy-tip">没有在线账号</div>
          </div>
          <div class="copy-tip">只使用勾选的账号发送 · 默认使用任务账号</div>
        </div>

        <div class="warn-box">
          ⚠️ 这些是<b>从未聊过的人</b>。平台对陌生人私信有严格限制：<br />
          · 每人每日只能收少数几条，对方不回复就发不了第二条<br />
          · 发送后账号权重会下降，可能影响内容推荐<br />
          · 建议先跑演练模式确认流程，再真实发送少量（如 3 人）
        </div>

        <div class="copy-box">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <div class="copy-title">话术库（勾选后加入下方话术池）</div>
            <div style="display:flex;gap:6px">
              <button class="tpl-edit-btn" @click="selectAllTemplates">全选</button>
              <button class="tpl-edit-btn" @click="clearTemplates">清空</button>
              <button class="tpl-edit-btn" @click="openTemplateEditor">编辑话术库</button>
            </div>
          </div>
          <div class="tpl-list">
            <label
              v-for="t in templates"
              :key="t.id"
              class="tpl-item"
            >
              <input
                type="checkbox"
                :checked="selectedTemplateIds.includes(t.id)"
                @change="toggleTemplate(t, $event.target.checked)"
              />
              <span class="tpl-name">{{ t.name }}</span>
              <span class="tpl-text">{{ t.text }}</span>
            </label>
            <div v-if="!templates.length" class="copy-tip">
              还没有话术，点「编辑话术库」新增。
            </div>
          </div>
          <div class="copy-tip">已选 {{ selectedTemplateIds.length }} 条 · 可直接在下方继续编辑</div>
        </div>

        <div class="copy-box">
          <div class="copy-title">发送话术池</div>
          <textarea
            v-model="sendTexts"
            rows="6"
            placeholder="一行一条，发送时按策略随机/顺序轮换"
          ></textarea>
          <div class="copy-tip">
            {{ sendMessages.length }} 条话术 · 每条 ≤500 字 · 发送时轮换 · 命中阻断词会跳过该条
          </div>
          <div class="copy-tip" style="display:flex;gap:18px;align-items:center;margin-top:8px">
            <span>内容策略：</span>
            <label style="display:flex;gap:5px;align-items:center;cursor:pointer">
              <input type="radio" value="random" v-model="sendStrategy" /> 完全随机
            </label>
            <label style="display:flex;gap:5px;align-items:center;cursor:pointer">
              <input type="radio" value="sequence" v-model="sendStrategy" /> 顺序循环
            </label>
          </div>
          <div v-if="sendMessages.length === 1" class="copy-tip" style="color:var(--c-warn)">
            只有 1 条话术，所有目标会收到同一句；建议配置多条。
          </div>
        </div>
      </div>

      <template #footer>
        <el-button v-if="step === 1" @click="wizardVisible = false">取消</el-button>
        <el-button v-if="step === 2" @click="step = 1">上一步</el-button>
        <el-button v-if="step === 2" type="primary" @click="goSend">下一步</el-button>
        <el-button v-if="step === 3" @click="step = 2">上一步</el-button>
        <el-button
          v-if="step === 1"
          type="primary"
          :disabled="harvesting || (mode === 'live' && liveBrowser && !liveBrowser.ok)"
          @click="doHarvest"
        >
          {{ harvesting ? '处理中…' : (mode === 'manual' ? '开始采集' : '开始采集（需联网）') }}
        </el-button>
        <el-button v-if="step === 3" type="primary" :disabled="dryRun === false && !currentTask?.approved" @click="doRun">
          {{ dryRun ? '开始演练' : '开始发送' }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="tplDialogVisible"
      title="编辑话术库"
      width="min(760px, calc(100vw - 32px))"
      top="4vh"
      :close-on-click-modal="false"
    >
      <div class="tpl-edit-list">
        <div v-for="(t, i) in tplDraft" :key="t.id" class="tpl-edit-row">
          <div class="tpl-edit-head">
            <input v-model="t.name" class="tpl-edit-name" placeholder="话术名称" />
            <button class="tpl-edit-del" @click="removeTemplateDraft(i)">删除</button>
          </div>
          <textarea
            v-model="t.text"
            rows="3"
            maxlength="500"
            placeholder="一条消息内容；换行保存时会合并为空格"
          ></textarea>
          <div class="tpl-edit-count">{{ (t.text || '').length }} / 500</div>
        </div>
        <button class="tpl-add" @click="addTemplateDraft">＋ 新增话术</button>
      </div>
      <template #footer>
        <el-button @click="tplDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="saveTemplateDraft">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.ic-view {
  flex: 1; display: flex; flex-direction: column;
  padding: 18px 22px; overflow-y: auto; min-width: 0;
}
.task-row { cursor: pointer; }
.task-row:hover td { background: #f5f9ff; }
.page-head { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 12px; }
.page-head h2 { font-size: 18px; font-weight: 600; }
.sub { font-size: 12px; color: var(--c-text-2); margin-top: 4px; }
.head-actions { display: flex; align-items: center; gap: 10px; }
.dryrun {
  font-size: 12px; padding: 4px 10px; border-radius: 6px;
  background: #f0f1f4; color: var(--c-text-2);
}
.dryrun.on { background: #fff4e5; color: #b76e00; }
.primary {
  height: 32px; padding: 0 16px; border: none; border-radius: 6px;
  background: var(--c-primary); color: #fff; font-size: 13px;
}

.warning-bar {
  padding: 10px 14px; background: #fff4e5; border: 1px solid #ffd8a8;
  border-radius: 8px; font-size: 12px; color: #b76e00; line-height: 1.6;
  margin-bottom: 14px;
}

.table-wrap { flex: 1; background: #fff; border: 1px solid var(--c-border); border-radius: 8px; overflow: auto; min-height: 260px; }
.empty { padding: 55px; text-align: center; color: var(--c-text-2); font-size: 13px; }
.empty .hint { font-size: 12px; color: var(--c-text-3); margin-top: 6px; }
.empty.small { padding: 30px; }

.task-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.task-table th {
  text-align: left; padding: 9px 10px; font-weight: 500; color: var(--c-text-2);
  background: #fafbfc; border-bottom: 1px solid var(--c-border); white-space: nowrap;
}
.task-table td { padding: 9px 10px; border-bottom: 1px solid #f5f6f8; }
.task-table tr:hover td { background: #fafbfc; }
.name { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.mono { font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: var(--c-text-2); }
.hl { color: var(--c-primary); font-weight: 600; }
.ops button {
  height: 24px; padding: 0 10px; border: 1px solid #ffc9c9; border-radius: 4px;
  background: #fff; font-size: 11px; color: var(--c-danger);
  margin-right: 4px;
}
.ops button.ok {
  border-color: #b7e3c3; color: #1a7f37;
}

.tag {
  display: inline-block; font-size: 11px; padding: 0 6px; border-radius: 3px;
  background: #f0f1f4; color: var(--c-text-2); white-space: nowrap;
}
.tag.success { background: #e8f8ee; color: #1a7f37; }
.tag.warning { background: #fff4e5; color: #b76e00; }
.tag.danger { background: #ffece9; color: #d4380d; }
.tag.info { background: #eaf1ff; color: var(--c-primary); }

/* 向导 */
.steps { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; }
.step {
  display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--c-text-3);
}
.step .num {
  width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center;
  background: #f0f1f4; color: var(--c-text-3); font-size: 12px;
}
.step.active { color: var(--c-primary); font-weight: 600; }
.step.active .num { background: var(--c-primary); color: #fff; }
.step.done .num { background: #1a7f37; color: #fff; }
.step.done { color: #1a7f37; }
.line { flex: 1; height: 1px; background: var(--c-border); }

.step-body { display: flex; flex-direction: column; gap: 14px; }
.row { display: flex; gap: 12px; align-items: flex-start; }
.row > label { width: 76px; flex-shrink: 0; font-size: 13px; color: var(--c-text-2); padding-top: 6px; }
.row input:not([type]), .row textarea {
  flex: 1; padding: 7px 10px; border: 1px solid var(--c-border); border-radius: 6px;
  font-size: 13px; outline: none; font-family: inherit;
}
.row textarea { resize: vertical; }
.row select.account-select {
  height: 32px; padding: 0 10px; border: 1px solid var(--c-border);
  border-radius: 6px; background: #fff; font-size: 13px; outline: none;
  min-width: 220px; max-width: 320px;
}
.account-row { align-items: center; }
.account-row > label { padding-top: 0; }
.account-row .hint { padding-top: 0; }
.checks { display: flex; flex-wrap: wrap; gap: 10px; font-size: 13px; }
.check { display: flex; align-items: center; gap: 4px; cursor: pointer; }
.hint { font-size: 11px; color: var(--c-text-3); }

.parse-info { font-size: 12px; color: var(--c-text-2); margin-top: 4px; }
.parse-info .warn { color: var(--c-warn); }
.parse-info .danger { color: var(--c-danger); }

.params { background: #fafbfc; border-radius: 8px; padding: 12px 14px; }
.params-title { font-size: 12px; color: var(--c-text-2); margin-bottom: 10px; font-weight: 500; }
.param-row { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--c-text-2); margin-bottom: 8px; }
.param-row .sep { margin: 0 6px; color: var(--c-text-3); }
.num { width: 64px; height: 26px; padding: 0 6px; border: 1px solid var(--c-border); border-radius: 5px; font-size: 12px; text-align: center; outline: none; }
.param-note { font-size: 11px; color: var(--c-text-3); }

.review-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.filters { display: flex; gap: 6px; }
.filters button {
  height: 26px; padding: 0 10px; border: 1px solid var(--c-border); border-radius: 5px;
  background: #fff; font-size: 12px; color: var(--c-text-2);
}
.filters button.active { border-color: var(--c-primary); background: #eaf1ff; color: var(--c-primary); }
.bulk { display: flex; gap: 6px; }
.bulk button {
  height: 26px; padding: 0 10px; border: 1px solid var(--c-border); border-radius: 5px;
  background: #fff; font-size: 12px; color: var(--c-text-2);
}
.bulk button.ok { border-color: #1a7f37; color: #1a7f37; }
.bulk button.no { border-color: var(--c-danger); color: var(--c-danger); }

.review-list {
  max-height: 300px; overflow-y: auto; border: 1px solid var(--c-border);
  border-radius: 6px; padding: 6px;
}
.review-pager {
  display: flex; align-items: center; gap: 8px; justify-content: flex-end;
  margin-top: 8px; font-size: 12px; color: var(--c-text-2);
}
.review-pager .pager-total { margin-right: auto; }
.review-pager .pager-page { min-width: 64px; text-align: center; }
.review-item {
  display: flex; align-items: flex-start; gap: 8px; padding: 6px 8px;
  border-radius: 4px; font-size: 12px;
}
.review-item:hover { background: #fafbfc; }
.review-item.excluded { opacity: 0.5; }
.ri-main { flex: 1; min-width: 0; }
.ri-line { display: flex; align-items: center; gap: 8px; }
.ri-sub {
  margin-top: 2px; display: flex; align-items: baseline; gap: 8px;
  color: var(--c-text-2); font-size: 11px; min-width: 0;
}
.ri-sub .cmt-type {
  flex: 0 0 auto; padding: 1px 5px; border-radius: 3px;
  font-size: 10px; line-height: 1.4;
}
.cmt-type.root { background: #eef4ff; color: #2f5f9f; }
.cmt-type.reply { background: #fff2e8; color: #b25a00; }
.cmt-type.manual { background: #f0f1f4; color: #666; }
.cmt-type.live_comment { background: #e8f8ee; color: #1a7f37; }
.cmt-type.live_audience { background: #f0f6ff; color: #2f5f9f; }
.ri-sub .cmt {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  max-width: 60%; color: #555;
}
.ri-sub .likes { color: #b26a00; flex: 0 0 auto; }
.ri-sub .ctime { color: #9aa0a6; flex: 0 0 auto; }
.ri-sub .kw {
  flex: 0 0 auto; color: #2f6fd0; background: #eef4ff;
  padding: 0 4px; border-radius: 3px; font-size: 10px;
}
.ri-sub .src {
  flex: 1 1 0; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: #9aa0a6;
}
.mode-tag {
  display: inline-block; font-size: 10px; padding: 0 4px; margin-right: 4px;
  border-radius: 3px; background: #eef4ff; color: #2f6fd0; vertical-align: 1px;
}
.mode-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
.mode-tabs button {
  height: 28px; padding: 0 12px; border: 1px solid var(--c-border);
  border-radius: 4px; background: #fff; font-size: 12px; color: var(--c-text-1);
}
.mode-tabs button.active {
  border-color: var(--c-primary); color: var(--c-primary); background: #f0f6ff;
}
.hint-line { color: #9aa0a6; }
.params-title { cursor: pointer; user-select: none; }
.params-title .toggle { font-size: 11px; color: var(--c-primary); margin-left: 6px; }
.monitor-note {
  margin: 12px 0; padding: 10px 12px; border-radius: 6px;
  background: #f0f6ff; border: 1px solid #cddcf7; color: #2f5f9f;
  font-size: 12px; line-height: 1.7;
}
.speed-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: 10px 0 4px;
  font-size: 12px;
}
.speed-label { color: var(--c-text-2); flex-shrink: 0; }
.speed-tabs { display: flex; gap: 4px; }
.speed-tabs button {
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--c-border);
  border-radius: 5px;
  background: #fff;
  color: var(--c-text-2);
  font-size: 12px;
}
.speed-tabs button.active {
  border-color: var(--c-primary);
  background: #f0f6ff;
  color: var(--c-primary);
}
.speed-hint { color: var(--c-text-3); font-size: 11px; }
.speed-warn {
  margin: 2px 0 6px; padding: 6px 10px; border-radius: 5px;
  background: #fff4e5; color: #b76e00; font-size: 11px;
}
.realtime-check { color: var(--c-primary); white-space: nowrap; }
.speed-select {
  height: 24px;
  border: 1px solid var(--c-border);
  border-radius: 5px;
  background: #fff;
  font-size: 11px;
  padding: 0 4px;
  outline: none;
}
.sel {
  height: 26px; padding: 0 4px; border: 1px solid var(--c-border);
  border-radius: 5px; font-size: 12px; background: #fff; outline: none;
}
.mode-tag.mon { background: #fff4e5; color: #b76e00; }
.monitor-bar {
  display: flex; align-items: center; gap: 8px; padding: 8px 10px; margin-bottom: 10px;
  background: #f7f9fc; border: 1px solid #e3e8ef; border-radius: 6px;
  font-size: 12px; color: var(--c-text-2);
}
.monitor-bar .dot { width: 8px; height: 8px; border-radius: 50%; background: #c9ced6; }
.monitor-bar .dot.on { background: #1a7f37; box-shadow: 0 0 0 3px #e8f8ee; }
.monitor-bar .dot.running { background: var(--c-primary); animation: monitorPulse 1.1s ease-in-out infinite; }
@keyframes monitorPulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(51, 112, 255, 0.35); }
  50% { box-shadow: 0 0 0 4px rgba(51, 112, 255, 0.05); }
}
.monitor-bar .mb-state { font-weight: 600; color: var(--c-text-1); white-space: nowrap; flex: 0 0 auto; }
.monitor-bar .mb-info { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.monitor-bar .spacer { flex: 1; }
.monitor-bar .mini {
  height: 24px; padding: 0 10px; border: 1px solid var(--c-border);
  border-radius: 4px; background: #fff; font-size: 11px; color: var(--c-text-1);
  white-space: nowrap; flex: 0 0 auto;
}
.monitor-bar .mini:disabled { opacity: 0.6; }

.harvest-bar {
  display: flex; align-items: center; gap: 10px; padding: 9px 12px; margin-bottom: 10px;
  background: #eef4ff; border: 1px solid #cddcf7; border-radius: 6px;
  font-size: 12px; color: #2f5f9f;
}
.harvest-bar.failed { background: #fdeaea; border-color: #ffc9c9; color: #b02a1e; }
.harvest-bar .spacer { flex: 1; }
.harvest-bar .hb-count { font-weight: 600; color: #1f4b82; }
.harvest-bar .hb-hint { color: #7b93b5; font-size: 11px; }
.harvest-bar .spin {
  width: 14px; height: 14px; border: 2px solid #cddcf7; border-top-color: var(--c-primary);
  border-radius: 50%; animation: hbspin .9s linear infinite;
}
@keyframes hbspin { to { transform: rotate(360deg); } }

.progress-track {
  height: 6px; background: #e8edf4; border-radius: 4px; overflow: hidden;
  margin: -4px 0 10px;
}
.progress-track.monitor { margin: -2px 0 6px; }
.progress-fill {
  height: 100%; background: var(--c-primary); border-radius: 4px;
  transition: width .3s ease;
}
.progress-track.indeterminate .progress-fill {
  width: 30% !important;
  animation: progressIndeterminate 1.1s ease-in-out infinite;
}
@keyframes progressIndeterminate {
  0% { margin-left: -30%; }
  100% { margin-left: 100%; }
}
.progress-caption {
  font-size: 11px; color: var(--c-text-3); margin: 0 0 10px;
}
/* 弹窗始终留在窗口内：限宽、限高，内容区自己滚动，底部按钮固定可见 */
:global(.el-dialog.ic-wizard) {
  max-width: calc(100vw - 32px);
  max-height: 92vh;
  display: flex;
  flex-direction: column;
}
:global(.el-dialog.ic-wizard .el-dialog__header),
:global(.el-dialog.ic-wizard .el-dialog__footer) { flex: 0 0 auto; }
:global(.el-dialog.ic-wizard .el-dialog__body) {
  flex: 1 1 auto;
  min-height: 0;
  max-height: calc(92vh - 132px);
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 8px;
}
.row > div { min-width: 0; }
.row textarea { width: 100%; box-sizing: border-box; }
.fixed-policy .warn { color: var(--c-danger); margin-left: 6px; }
.fixed-policy .ok-hint { color: #1a7f37; margin-left: 6px; }
.fixed-policy {
  padding: 9px 12px; border-radius: 6px; font-size: 12px; line-height: 1.7;
  background: #f0f6ff; border: 1px solid #cddcf7; color: #2f5f9f;
}
.competitor-picker {
  flex: 1; min-width: 0; border: 1px solid var(--c-border); border-radius: 6px;
  background: #fafbfc; padding: 10px 12px;
}
.cp-picker-head {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 8px; flex-wrap: wrap;
  font-size: 12px; color: var(--c-text-2); margin-bottom: 8px;
}
.cp-picker-actions { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.cp-picker-actions input {
  height: 24px; width: 170px; padding: 0 8px; border: 1px solid var(--c-border);
  border-radius: 4px; background: #fff; font-size: 11px; outline: none;
}
.competitor-picker .mini {
  height: 24px; padding: 0 10px; border: 1px solid var(--c-border);
  border-radius: 4px; background: #fff; font-size: 11px; color: var(--c-text-1);
}
.cp-list { max-height: 220px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.cp-item {
  display: flex; align-items: center; gap: 8px; padding: 5px 6px;
  border-radius: 4px; font-size: 12px; cursor: pointer;
}
.cp-item:hover { background: #f0f4ff; }
.cp-name { font-weight: 500; min-width: 120px; }
.cp-meta { margin-left: auto; font-size: 11px; color: var(--c-text-3); }
.live-help {
  margin-top: 6px; padding: 9px 12px; border-radius: 6px;
  background: #fafbfc; border: 1px solid var(--c-border);
  font-size: 12px; line-height: 1.8; color: var(--c-text-2);
}
.live-help p { margin: 0; }
.live-help code {
  padding: 1px 5px; border-radius: 3px; background: #f0f1f4;
  color: var(--c-text-1); font-family: ui-monospace, Consolas, monospace;
}
.link-btn {
  border: none; background: none; color: var(--c-primary); font-size: 11px;
  cursor: pointer; padding: 0 4px; text-decoration: underline;
}
.review-item .placeholder { width: 13px; }
.review-item .uid { font-family: ui-monospace, Consolas, monospace; width: 130px; color: var(--c-text-2); }
.review-item .uname { flex: 1; }
.presence {
  flex-shrink: 0; font-size: 10px; padding: 1px 6px; border-radius: 3px;
  background: #f0f1f4; color: var(--c-text-2);
}
.presence.online { background: #e8f7ee; color: #1f8f4d; }
.presence.offline { background: #f2f3f5; color: var(--c-text-3); }
.presence.active { background: #fff7e6; color: #b76e00; }
.presence.unknown { background: #f7f8fa; color: var(--c-text-3); }
.review-item .reason { font-size: 11px; color: var(--c-warn); }

.review-tip { font-size: 11px; color: var(--c-warn); line-height: 1.6; }

.confirm-card { background: #fafbfc; border-radius: 8px; padding: 14px; }
.cc-row { display: flex; gap: 14px; padding: 5px 0; font-size: 13px; }
.cc-row .k { width: 80px; color: var(--c-text-2); flex-shrink: 0; }
.cc-row .v { color: var(--c-text); }
.cc-row .v.big { font-size: 18px; font-weight: 600; color: var(--c-primary); }
.cc-row .v.ok { color: #1a7f37; }
.cc-row .v.danger { color: var(--c-danger); font-weight: 600; }

.warn-box {
  padding: 12px 14px; background: #fff4e5; border: 1px solid #ffd8a8;
  border-radius: 8px; font-size: 12px; color: #b76e00; line-height: 1.8;
}
.copy-box { margin-top: 14px; }
.copy-title { font-size: 12px; color: var(--c-text-2); margin-bottom: 6px; }
.copy-box textarea {
  width: 100%; box-sizing: border-box; padding: 8px 10px;
  border: 1px solid var(--c-border); border-radius: 6px;
  font-size: 12px; line-height: 1.6; resize: vertical; outline: none;
  font-family: inherit;
}
.copy-box textarea:focus { border-color: var(--c-primary); }
.copy-tip { margin-top: 4px; font-size: 11px; color: #9aa0a6; }
.tpl-list { display: flex; flex-direction: column; gap: 8px; max-height: 260px; overflow-y: auto; }
.tpl-item { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; line-height: 1.5; cursor: pointer; }
.tpl-item input { margin-top: 3px; flex: 0 0 auto; }
.tpl-name { flex: 0 0 66px; color: var(--c-text-2); }
.tpl-text { color: var(--c-text-1); word-break: break-all; }
.tpl-kw { display: inline-block; margin-right: 5px; padding: 0 5px; border-radius: 3px; background: #eef4ff; color: var(--c-primary); font-size: 10px; }
.tpl-item.match { background: #f5f9ff; border-radius: 4px; }
.send-target-list { display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow-y: auto; }
.send-target-item { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 4px; font-size: 12px; cursor: pointer; }
.send-target-item:hover { background: #fafbfc; }
.send-target-item input { flex: 0 0 auto; }
.st-name { color: var(--c-text-1); min-width: 90px; }
.st-uid { color: var(--c-text-2); font-family: ui-monospace, Consolas, monospace; font-size: 11px; }
.tpl-edit-btn { height: 24px; padding: 0 10px; border: 1px solid var(--c-border); border-radius: 4px; background: #fff; font-size: 11px; cursor: pointer; }
.tpl-edit-list { display: flex; flex-direction: column; gap: 12px; max-height: 60vh; overflow-y: auto; }
.tpl-edit-row { border: 1px solid var(--c-border); border-radius: 8px; padding: 10px; }
.tpl-edit-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.tpl-edit-name { flex: 1; height: 30px; padding: 0 8px; border: 1px solid var(--c-border); border-radius: 4px; font-size: 12px; }
.tpl-edit-del { height: 26px; padding: 0 10px; border: 1px solid #ffc9c9; border-radius: 4px; background: #fff; color: var(--c-danger); font-size: 11px; cursor: pointer; }
.tpl-edit-keywords { width: 100%; height: 30px; margin-bottom: 8px; padding: 0 8px; border: 1px solid var(--c-border); border-radius: 4px; font-size: 12px; }
.tpl-edit-row textarea { width: 100%; padding: 8px; border: 1px solid var(--c-border); border-radius: 4px; font-size: 12px; line-height: 1.6; resize: vertical; }
.tpl-edit-count { margin-top: 4px; font-size: 11px; color: #9aa0a6; text-align: right; }
.tpl-add { align-self: flex-start; height: 28px; padding: 0 12px; border: 1px dashed var(--c-border); border-radius: 4px; background: #fff; font-size: 12px; cursor: pointer; }

.keyword-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin: 2px 0 7px;
}
.kw-chip {
  padding: 2px 8px;
  border-radius: 10px;
  background: #eef3ff;
  color: #2f5f9f;
  font-size: 11px;
}
.kw-chip b { color: var(--c-primary); }
.harvest-warn {
  margin: -1px 0 7px;
  padding: 5px 9px;
  border-radius: 5px;
  background: #fff7e8;
  color: #9a6a12;
  font-size: 11px;
}
.mb-count {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--c-primary);
  background: #eef3ff;
  padding: 1px 7px;
  border-radius: 9px;
}
.kw-filter {
  height: 26px;
  border: 1px solid var(--c-border);
  border-radius: 5px;
  background: #fff;
  font-size: 11px;
  padding: 0 6px;
  outline: none;
}
.go-chat {
  margin-left: auto;
  flex-shrink: 0;
}
</style>
