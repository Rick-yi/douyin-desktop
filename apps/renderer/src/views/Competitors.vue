<script setup>
import { api } from '../api.js';
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

const props = defineProps({
  accounts: { type: Array, default: () => [] },
});
const emit = defineEmits(['open-leads']);

const tab = ref('competitors'); // competitors | videos | jobs
const loading = ref(false);
const stats = ref({ total: 0, active: 0, normal: 0, inactive: 0, videos: 0, monitored: 0 });
const keywords = ref([]);

// 同行列表
const peers = ref([]);
const peerTotal = ref(0);
const peerPage = ref(1);
const peerPageSize = 50;
const peerFilter = ref({ keyword: '', active: '', q: '', monitor: '' });
const selectedPeerIds = ref([]);

// 视频库
const videos = ref([]);
const videoTotal = ref(0);
const videoPage = ref(1);
const videoPageSize = 50;
const videoFilter = ref({ competitorId: '', keyword: '', q: '', from: '', monitor: '' });
const peerOptions = ref([]);

// 采集任务
const jobs = ref([]);
const collectAccountId = ref(props.accounts[0]?.id || '');
const jobForm = ref({ keywords: '' });
const starting = ref(false);
let timer = null;

// 加入线索
const addVisible = ref(false);
const addForm = ref({ accountId: props.accounts[0]?.id || '', name: '' });
const adding = ref(false);

const enabledAccounts = computed(() => props.accounts.filter((a) => a.enabled && a.uid));
const peerPageCount = computed(() => Math.max(1, Math.ceil(peerTotal.value / peerPageSize)));
const videoPageCount = computed(() => Math.max(1, Math.ceil(videoTotal.value / videoPageSize)));
const runningJobs = computed(() => jobs.value.filter((j) => j.status === 'running'));
const activeJobs = computed(() => jobs.value.filter((j) => j.status === 'running' || j.status === 'paused'));

const activeText = {
  active: '活跃',
  normal: '一般',
  inactive: '不活跃',
  unknown: '未知',
};
const activeTag = {
  active: 'success',
  normal: 'warning',
  inactive: 'info',
  unknown: 'info',
};
const jobStatusText = {
  running: '运行中',
  paused: '已中断',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

async function loadStats() {
  try {
    const [s, k] = await Promise.all([api.cp.stats(), api.cp.keywords()]);
    stats.value = s;
    keywords.value = k;
  } catch {}
}

async function loadPeers({ reset = false } = {}) {
  if (reset) peerPage.value = 1;
  loading.value = true;
  try {
    const f = peerFilter.value;
    const r = await api.cp.list({
      keyword: f.keyword || undefined,
      active: f.active || undefined,
      q: f.q || undefined,
      monitor: f.monitor === '' ? undefined : f.monitor,
      limit: peerPageSize,
      offset: (peerPage.value - 1) * peerPageSize,
    });
    peers.value = r.rows || [];
    peerTotal.value = Number(r.total) || 0;
    if (peerPage.value > peerPageCount.value) {
      peerPage.value = peerPageCount.value;
      return loadPeers();
    }
  } catch (e) {
    ElMessage.error('加载同行失败：' + e.message);
  } finally {
    loading.value = false;
  }
}

async function loadPeerOptions() {
  try {
    const r = await api.cp.list({ limit: 500 });
    peerOptions.value = r.rows || [];
  } catch {}
}

async function loadVideos({ reset = false } = {}) {
  if (reset) videoPage.value = 1;
  try {
    const f = videoFilter.value;
    const r = await api.cp.videos({
      competitorId: f.competitorId || undefined,
      keyword: f.keyword || undefined,
      q: f.q || undefined,
      from: f.from ? new Date(f.from).getTime() : undefined,
      monitor: f.monitor === '' ? undefined : f.monitor,
      limit: videoPageSize,
      offset: (videoPage.value - 1) * videoPageSize,
    });
    videos.value = r.rows || [];
    videoTotal.value = Number(r.total) || 0;
    if (videoPage.value > videoPageCount.value) {
      videoPage.value = videoPageCount.value;
      return loadVideos();
    }
  } catch (e) {
    ElMessage.error('加载视频失败：' + e.message);
  }
}

async function loadJobs() {
  try {
    jobs.value = await api.cp.jobs(100);
  } catch {}
}

async function refreshAll() {
  await Promise.all([loadStats(), loadPeers({ reset: false }), loadPeerOptions()]);
  if (tab.value === 'videos') await loadVideos();
  if (tab.value === 'jobs') await loadJobs();
}

function selectAllPeers() {
  selectedPeerIds.value = peers.value.map((p) => p.id);
}

function clearSelected() {
  selectedPeerIds.value = [];
}

async function startScan() {
  if (!jobForm.value.keywords.trim()) { ElMessage.error('请输入关键词'); return; }
  if (!collectAccountId.value) { ElMessage.error('请选择采集账号'); return; }
  starting.value = true;
  try {
    const r = await api.cp.startScan({ keywords: jobForm.value.keywords, accountId: collectAccountId.value });
    if (!r.ok) { ElMessage.error(r.error || '启动失败'); return; }
    ElMessage.success('同行采集已开始，后台会持续搜索和拉取作品');
    jobForm.value.keywords = '';
    tab.value = 'jobs';
    await loadJobs();
    await loadStats();
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    starting.value = false;
  }
}

async function cancelJob(j) {
  try {
    await ElMessageBox.confirm(`取消「${j.keywords.join('、')}」的同行采集？`, '取消任务', { type: 'warning' });
  } catch { return; }
  await api.cp.cancelJob(j.id);
  ElMessage.info('已取消');
  await loadJobs();
}

async function deleteJob(j) {
  try {
    await ElMessageBox.confirm(
      `删除采集任务「${j.keywords.join('、')}」？只会删除任务记录，已入库的同行和视频不受影响。`,
      '删除采集任务',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch { return; }
  try {
    const r = await api.cp.deleteJob(j.id);
    if (!r?.ok) { ElMessage.error(r?.error || '删除失败'); return; }
    ElMessage.success('已删除采集任务');
    await loadJobs();
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function resumeJob(j) {
  try {
    const r = await api.cp.resumeJob(j.id);
    if (!r.ok) { ElMessage.error(r.error || '续采失败'); return; }
    ElMessage.success('已开始续采');
    await loadJobs();
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function refreshPeer(p) {
  if (!p) return;
  const accountId = collectAccountId.value;
  if (!accountId) { ElMessage.error('请先选择采集账号'); return; }
  p._refreshing = true;
  try {
    const r = await api.cp.refresh({ competitorId: p.id, accountId });
    if (!r.ok) { ElMessage.error(r.error || '刷新失败'); return; }
    ElMessage.success(`已刷新：${p.nickname || p.secUid}，视频 ${r.videoCount} 条`);
    await refreshAll();
    if (tab.value === 'videos') await loadVideos();
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    p._refreshing = false;
  }
}

function openAddLeads() {
  if (!selectedPeerIds.value.length) { ElMessage.error('请先选择同行'); return; }
  addForm.value = {
    accountId: collectAccountId.value || enabledAccounts.value[0]?.id || '',
    name: `同行评论 · ${new Date().toLocaleDateString('zh-CN')}`,
  };
  addVisible.value = true;
}

async function submitAddLeads() {
  if (!addForm.value.accountId) { ElMessage.error('请选择采集账号'); return; }
  adding.value = true;
  try {
    const r = await api.cp.addToLeads({
      competitorIds: selectedPeerIds.value,
      accountId: addForm.value.accountId,
      name: addForm.value.name,
    });
    if (!r.ok) { ElMessage.error(r.error || '加入失败'); return; }
    ElMessage.success(`已创建线索任务：${r.competitorCount} 个同行，${r.videoCount} 条视频，默认全视频监控`);
    addVisible.value = false;
    selectedPeerIds.value = [];
    emit('open-leads', r.taskId);
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    adding.value = false;
  }
}

async function toggleVideo(v) {
  const next = !v.monitorEnabled;
  try {
    const r = await api.cp.excludeVideo(v.awemeId, !next);
    if (!r.ok) { ElMessage.error(r.error || '操作失败'); return; }
    v.monitorEnabled = next;
    v.excluded = !next;
    ElMessage.success(next ? '已恢复监控' : '已排除该视频');
    await loadStats();
  } catch (e) {
    ElMessage.error(e.message);
  }
}

function openVideo(v) {
  if (v?.shareUrl) window.open(v.shareUrl, '_blank');
}

function switchTab(t) {
  tab.value = t;
  if (t === 'videos') loadVideos();
  if (t === 'jobs') loadJobs();
}

watch(() => props.accounts, () => {
  if (!collectAccountId.value) collectAccountId.value = props.accounts[0]?.id || '';
  if (!addForm.value.accountId) addForm.value.accountId = props.accounts[0]?.id || '';
}, { deep: true });

onMounted(async () => {
  if (!collectAccountId.value) collectAccountId.value = props.accounts[0]?.id || '';
  if (!addForm.value.accountId) addForm.value.accountId = props.accounts[0]?.id || '';
  await Promise.all([loadStats(), loadPeers(), loadPeerOptions(), loadJobs()]);
  timer = setInterval(async () => {
    if (activeJobs.value.length) {
      await loadJobs();
      if (runningJobs.value.length) {
        await loadStats();
        await loadPeers();
      }
    }
  }, 3000);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div class="cp-view">
    <header class="page-head">
      <div>
        <h2>同行监控</h2>
        <p class="sub">
          同行 {{ stats.total }} · 活跃 {{ stats.active }} · 一般 {{ stats.normal }} ·
          不活跃 {{ stats.inactive }} · 视频 {{ stats.videos }} 条 · 默认全视频监控
        </p>
      </div>
      <div class="head-actions">
        <select v-model="collectAccountId" class="collect-account" title="采集/刷新使用账号">
          <option value="" disabled>选择采集账号</option>
          <option v-for="a in enabledAccounts" :key="a.id" :value="a.id">
            {{ a.nickname || a.uid }}
          </option>
        </select>
        <button :disabled="!selectedPeerIds.length" class="primary" @click="openAddLeads">
          加入线索监控{{ selectedPeerIds.length ? `（${selectedPeerIds.length}）` : '' }}
        </button>
      </div>
    </header>

    <div class="tabs">
      <button :class="{ active: tab === 'competitors' }" @click="switchTab('competitors')">同行列表</button>
      <button :class="{ active: tab === 'videos' }" @click="switchTab('videos')">视频库</button>
      <button :class="{ active: tab === 'jobs' }" @click="switchTab('jobs')">
        采集任务
        <span v-if="runningJobs.length" class="badge">{{ runningJobs.length }}</span>
      </button>
    </div>

    <!-- 同行列表 -->
    <div v-if="tab === 'competitors'" class="panel">
      <div class="scan-box">
        <div class="scan-title">按关键词批量发现同行</div>
        <textarea
          v-model="jobForm.keywords"
          rows="2"
          placeholder="一行一个关键词，例如：&#10;车抵贷&#10;汽车抵押"
        />
        <div class="scan-actions">
          <span class="hint">使用右上角选择的采集账号</span>
          <button class="primary" :disabled="starting" @click="startScan">
            {{ starting ? '启动中…' : '开始采集同行' }}
          </button>
          <span class="hint">不限制同行和视频数量，后台分页拉取；7 天活跃、30 天不活跃。</span>
        </div>
      </div>

      <div class="filters">
        <select v-model="peerFilter.keyword" @change="loadPeers({ reset: true })">
          <option value="">全部关键词</option>
          <option v-for="k in keywords" :key="k.keyword" :value="k.keyword">
            {{ k.keyword }}（{{ k.count }}）
          </option>
        </select>
        <select v-model="peerFilter.active" @change="loadPeers({ reset: true })">
          <option value="">全部活跃度</option>
          <option value="active">活跃</option>
          <option value="normal">一般</option>
          <option value="inactive">不活跃</option>
          <option value="unknown">未知</option>
        </select>
        <select v-model="peerFilter.monitor" @change="loadPeers({ reset: true })">
          <option value="">全部监控状态</option>
          <option :value="true">全视频监控</option>
          <option :value="false">已停止</option>
        </select>
        <input v-model="peerFilter.q" placeholder="昵称 / UID / sec_uid" @keyup.enter="loadPeers({ reset: true })" />
        <button class="ghost" @click="loadPeers({ reset: true })">刷新</button>
        <span class="total">共 {{ peerTotal }} 个同行</span>
      </div>

      <div class="bulk">
        <button @click="selectAllPeers">全选本页</button>
        <button @click="clearSelected">清空</button>
      </div>

      <div class="table-wrap">
        <div v-if="loading && !peers.length" class="empty">加载中…</div>
        <div v-else-if="!peers.length" class="empty">还没有同行，先按关键词采集</div>
        <table v-else class="peer-table">
          <thead>
            <tr>
              <th style="width: 34px"></th>
              <th>同行</th>
              <th style="width: 130px">关键词</th>
              <th style="width: 82px">活跃度</th>
              <th style="width: 135px">最近作品</th>
              <th style="width: 72px">视频</th>
              <th style="width: 88px">监控</th>
              <th style="width: 92px">线索任务</th>
              <th style="width: 130px">更新时间</th>
              <th style="width: 150px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in peers" :key="p.id">
              <td>
                <input type="checkbox" :value="p.id" v-model="selectedPeerIds" />
              </td>
              <td>
                <div class="peer-cell">
                  <img v-if="p.avatarUrl" :src="p.avatarUrl" class="avatar" referrerpolicy="no-referrer" />
                  <div>
                    <div class="name">{{ p.nickname || p.secUid }}</div>
                    <div class="mono">{{ p.uid || p.secUid }}</div>
                    <div v-if="p.lastError" class="err" :title="p.lastError">{{ p.lastError }}</div>
                  </div>
                </div>
              </td>
              <td class="ellipsis" :title="p.keywords">{{ p.keywords || '—' }}</td>
              <td>
                <span class="tag" :class="activeTag[p.activeLevel]">{{ activeText[p.activeLevel] || p.activeLevel }}</span>
              </td>
              <td class="mono">{{ fmtTime(p.latestVideoAt) }}</td>
              <td>{{ p.videoCount }}</td>
              <td><span class="tag success">全视频</span></td>
              <td>{{ p.linkedTasks }}</td>
              <td class="mono">{{ fmtTime(p.updatedAt) }}</td>
              <td class="ops">
                <button :disabled="p._refreshing" @click="refreshPeer(p)">
                  {{ p._refreshing ? '刷新中…' : '刷新作品' }}
                </button>
                <button class="ok" @click="selectedPeerIds = [p.id]; openAddLeads()">加入线索</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="peerTotal > peerPageSize" class="pager">
        <button :disabled="peerPage <= 1" @click="peerPage--; loadPeers()">上一页</button>
        <span>{{ peerPage }} / {{ peerPageCount }}</span>
        <button :disabled="peerPage >= peerPageCount" @click="peerPage++; loadPeers()">下一页</button>
      </div>
    </div>

    <!-- 视频库 -->
    <div v-if="tab === 'videos'" class="panel">
      <div class="filters">
        <select v-model="videoFilter.competitorId" @change="loadVideos({ reset: true })">
          <option value="">全部同行</option>
          <option v-for="p in peerOptions" :key="p.id" :value="p.id">{{ p.nickname || p.secUid }}</option>
        </select>
        <select v-model="videoFilter.keyword" @change="loadVideos({ reset: true })">
          <option value="">全部关键词</option>
          <option v-for="k in keywords" :key="k.keyword" :value="k.keyword">{{ k.keyword }}</option>
        </select>
        <select v-model="videoFilter.monitor" @change="loadVideos({ reset: true })">
          <option value="">全部监控状态</option>
          <option :value="true">监控中</option>
          <option :value="false">已排除</option>
        </select>
        <input type="date" v-model="videoFilter.from" @change="loadVideos({ reset: true })" />
        <input v-model="videoFilter.q" placeholder="搜索作品标题" @keyup.enter="loadVideos({ reset: true })" />
        <button class="ghost" @click="loadVideos({ reset: true })">刷新</button>
        <span class="total">共 {{ videoTotal }} 条</span>
      </div>

      <div class="table-wrap">
        <div v-if="!videos.length" class="empty">没有符合条件的视频</div>
        <table v-else class="video-table">
          <thead>
            <tr>
              <th style="width: 54px">封面</th>
              <th>作品</th>
              <th style="width: 140px">同行</th>
              <th style="width: 130px">发布时间</th>
              <th style="width: 76px">点赞</th>
              <th style="width: 76px">评论</th>
              <th style="width: 90px">监控</th>
              <th style="width: 96px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="v in videos" :key="v.awemeId">
              <td>
                <img v-if="v.coverUrl" :src="v.coverUrl" class="cover" referrerpolicy="no-referrer" />
              </td>
              <td>
                <div class="vtitle" :title="v.title">{{ v.title || v.awemeId }}</div>
                <div class="mono">{{ v.awemeId }}</div>
              </td>
              <td class="ellipsis">{{ v.competitorName || '—' }}</td>
              <td class="mono">{{ fmtTime(v.createTime) }}</td>
              <td>{{ v.diggCount }}</td>
              <td>{{ v.commentCount }}</td>
              <td>
                <span class="tag" :class="v.monitorEnabled ? 'success' : 'info'">
                  {{ v.monitorEnabled ? '监控中' : '已排除' }}
                </span>
              </td>
              <td class="ops">
                <button @click="toggleVideo(v)">{{ v.monitorEnabled ? '排除' : '恢复' }}</button>
                <button class="ok" @click="openVideo(v)">打开</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="videoTotal > videoPageSize" class="pager">
        <button :disabled="videoPage <= 1" @click="videoPage--; loadVideos()">上一页</button>
        <span>{{ videoPage }} / {{ videoPageCount }}</span>
        <button :disabled="videoPage >= videoPageCount" @click="videoPage++; loadVideos()">下一页</button>
      </div>
    </div>

    <!-- 采集任务 -->
    <div v-if="tab === 'jobs'" class="panel">
      <div class="table-wrap">
        <div v-if="!jobs.length" class="empty">还没有采集任务</div>
        <table v-else class="job-table">
          <thead>
            <tr>
              <th>关键词</th>
              <th style="width: 90px">状态</th>
              <th style="width: 100px">阶段</th>
              <th style="width: 90px">同行</th>
              <th style="width: 90px">活跃</th>
              <th style="width: 90px">视频</th>
              <th style="width: 72px">放弃</th>
              <th style="width: 72px">失败</th>
              <th style="width: 180px">进度</th>
              <th style="width: 130px">开始时间</th>
              <th style="width: 160px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="j in jobs" :key="j.id">
              <td class="ellipsis" :title="j.keywords.join('、')">{{ j.keywords.join('、') }}</td>
              <td>
                <span class="tag" :class="j.status === 'done' ? 'success' : j.status === 'running' ? 'info' : j.status === 'failed' ? 'danger' : 'warning'">
                  {{ jobStatusText[j.status] || j.status }}
                </span>
              </td>
              <td>{{ j.phase || '—' }}</td>
              <td>{{ j.competitors || 0 }}</td>
              <td>{{ j.activeCount || 0 }}</td>
              <td>{{ j.videoCount || 0 }}</td>
              <td>{{ j.summary?.skippedInactive || 0 }}</td>
              <td :class="{ 'num bad': (j.summary?.failed || 0) > 0 }">{{ j.summary?.failed || 0 }}</td>
              <td class="progress-cell">
                <div v-if="j.summary?.currentCompetitor" class="progress-name">{{ j.summary.currentCompetitor }}</div>
                <div class="progress-text">
                  {{ j.summary?.done ?? 0 }} / {{ j.summary?.total ?? j.competitors ?? 0 }}
                  · 入库 {{ j.competitors || 0 }}
                </div>
                <div class="progress-track">
                  <div class="progress-fill" :style="{ width: `${j.summary?.total ? Math.round((j.summary.done / j.summary.total) * 100) : 0}%` }"></div>
                </div>
              </td>
              <td class="mono">{{ fmtTime(j.createdAt) }}</td>
              <td class="ops">
                <button v-if="j.status === 'running'" class="danger" @click="cancelJob(j)">取消</button>
                <button v-if="j.status === 'paused' || j.status === 'failed'" class="ok" @click="resumeJob(j)">续采</button>
                <button v-if="j.status !== 'running'" class="danger" @click="deleteJob(j)">删除</button>
                <span v-if="j.status === 'paused'" class="err">等待自动续采</span>
                <span v-else-if="j.error" class="err" :title="j.error">{{ j.error }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <el-dialog v-model="addVisible" title="加入线索监控" width="460px">
      <div class="form">
        <div class="row">
          <label>采集账号</label>
          <select v-model="addForm.accountId">
            <option value="">请选择</option>
            <option v-for="a in enabledAccounts" :key="a.id" :value="a.id">{{ a.nickname || a.uid }}</option>
          </select>
        </div>
        <div class="row">
          <label>任务名称</label>
          <input v-model="addForm.name" />
        </div>
        <p class="hint">
          将选中同行的当前和以后全部作品加入线索监控；默认按 24 小时评论、全量评论页扫描。
        </p>
      </div>
      <template #footer>
        <el-button @click="addVisible = false">取消</el-button>
        <el-button type="primary" :disabled="adding" @click="submitAddLeads">
          {{ adding ? '创建中…' : '创建线索任务' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.cp-view {
  flex: 1; display: flex; flex-direction: column;
  padding: 18px 22px; overflow-y: auto; min-width: 0;
}
.page-head { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 12px; }
.page-head h2 { font-size: 18px; font-weight: 600; }
.sub { font-size: 12px; color: var(--c-text-2); margin-top: 4px; }
.head-actions { display: flex; gap: 8px; align-items: center; }
.collect-account {
  height: 32px; padding: 0 8px; border: 1px solid var(--c-border);
  border-radius: 6px; background: #fff; font-size: 12px; outline: none; max-width: 180px;
}
.primary {
  height: 32px; padding: 0 16px; border: none; border-radius: 6px;
  background: var(--c-primary); color: #fff; font-size: 13px;
}
.primary:disabled { opacity: 0.5; }
.tabs { display: flex; gap: 6px; margin-bottom: 12px; }
.tabs button {
  height: 30px; padding: 0 14px; border: 1px solid var(--c-border);
  border-radius: 6px; background: #fff; font-size: 13px; color: var(--c-text-2);
}
.tabs button.active { border-color: var(--c-primary); color: var(--c-primary); background: #f0f6ff; }
.badge {
  display: inline-block; min-width: 16px; padding: 0 4px; margin-left: 4px;
  border-radius: 8px; background: var(--c-primary); color: #fff; font-size: 10px;
}
.scan-box {
  background: #fff; border: 1px solid var(--c-border); border-radius: 8px;
  padding: 12px 14px; margin-bottom: 12px;
}
.scan-title { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.scan-box textarea {
  width: 100%; box-sizing: border-box; padding: 8px 10px; resize: vertical;
  border: 1px solid var(--c-border); border-radius: 6px; font-size: 13px; font-family: inherit;
}
.scan-actions { display: flex; align-items: center; gap: 10px; margin-top: 8px; flex-wrap: wrap; }
.scan-actions select, .filters select, .filters input {
  height: 30px; padding: 0 8px; border: 1px solid var(--c-border);
  border-radius: 6px; background: #fff; font-size: 12px; outline: none;
}
.filters { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.filters input { min-width: 180px; }
.filters .ghost, .bulk button, .ops button {
  height: 28px; padding: 0 10px; border: 1px solid var(--c-border);
  border-radius: 5px; background: #fff; font-size: 12px; color: var(--c-text-2);
}
.filters .ghost { padding: 0 14px; }
.total { margin-left: auto; font-size: 12px; color: var(--c-text-2); }
.bulk { display: flex; gap: 6px; margin-bottom: 8px; }
.bulk button { height: 24px; font-size: 11px; }
.table-wrap {
  flex: 1; background: #fff; border: 1px solid var(--c-border);
  border-radius: 8px; overflow: auto; min-height: 280px;
}
.empty { padding: 55px; text-align: center; color: var(--c-text-2); font-size: 13px; }
.peer-table, .video-table, .job-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.peer-table th, .video-table th, .job-table th {
  text-align: left; padding: 9px 10px; font-weight: 500; color: var(--c-text-2);
  background: #fafbfc; border-bottom: 1px solid var(--c-border); white-space: nowrap;
}
.peer-table td, .video-table td, .job-table td { padding: 8px 10px; border-bottom: 1px solid #f5f6f8; vertical-align: top; }
.peer-table tr:hover td, .video-table tr:hover td, .job-table tr:hover td { background: #fafbfc; }
.peer-cell { display: flex; gap: 8px; align-items: flex-start; min-width: 220px; }
.avatar { width: 34px; height: 34px; border-radius: 50%; object-fit: cover; background: #f0f1f4; }
.name { font-weight: 600; font-size: 13px; }
.mono { font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: var(--c-text-3); }
.ellipsis { max-width: 210px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.err { font-size: 11px; color: var(--c-danger); max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag { display: inline-block; font-size: 11px; padding: 0 6px; border-radius: 3px; background: #f0f1f4; color: var(--c-text-2); white-space: nowrap; }
.tag.success { background: #e8f8ee; color: #1a7f37; }
.tag.warning { background: #fff4e5; color: #b76e00; }
.tag.danger { background: #ffece9; color: #d4380d; }
.tag.info { background: #eaf1ff; color: var(--c-primary); }
.ops { display: flex; gap: 4px; flex-wrap: wrap; }
.ops button.ok { border-color: #b7e3c3; color: #1a7f37; }
.ops button.danger { border-color: #ffc9c9; color: var(--c-danger); }
.cover { width: 42px; height: 54px; object-fit: cover; border-radius: 4px; background: #f0f1f4; }
.vtitle { font-weight: 500; max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.progress-cell { min-width: 150px; }
.progress-name { font-size: 11px; color: var(--c-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.progress-text { font-size: 10px; color: var(--c-text-3); }
.progress-track { height: 4px; background: #e8edf4; border-radius: 3px; overflow: hidden; margin-top: 4px; }
.progress-fill { height: 100%; background: var(--c-primary); }
.pager { display: flex; justify-content: center; align-items: center; gap: 12px; padding: 10px 0; font-size: 12px; }
.pager button { height: 26px; padding: 0 10px; border: 1px solid var(--c-border); border-radius: 5px; background: #fff; font-size: 12px; }
.pager button:disabled { opacity: 0.4; }
.form { display: flex; flex-direction: column; gap: 12px; }
.row { display: flex; gap: 12px; align-items: center; }
.row > label { width: 76px; font-size: 13px; color: var(--c-text-2); flex-shrink: 0; }
.row input, .row select {
  flex: 1; height: 32px; padding: 0 10px; border: 1px solid var(--c-border);
  border-radius: 6px; font-size: 13px; outline: none; background: #fff;
}
.hint { font-size: 11px; color: var(--c-text-3); line-height: 1.6; }
</style>
