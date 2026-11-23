<script setup>
import { api } from '../api.js';
import { ref, computed, onMounted, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

// ── 状态 ──
const tab = ref('copy'); // copy | words | stats | checker
const groups = ref([]);
const words = ref([]);
const loading = ref(false);
const selectedGroup = ref('');
const keyword = ref('');
const stats = ref({ byWord: [], byAction: [], total: 0, days: 7 });

// ── 话术库 ──
const copyTemplates = ref([]);
const copyLoading = ref(false);
const copyDialogVisible = ref(false);
const copyEditing = ref(null);
const copyForm = ref(emptyCopyForm());
const copyFormCheck = ref(null);
const copyChecks = ref({});

// 新增/编辑弹窗
const dialogVisible = ref(false);
const editing = ref(null);
const form = ref(emptyForm());

// ── 话术检查器 ──
const checkerScene = ref('dm');
const checkerIndustry = ref('通用');
const checkerInput = ref('');
const checkerChecking = ref(false);
const checkerRewriting = ref(false);
const checkerResult = ref(null);
const checkerRewrite = ref(null);
const checkerItems = ref([]); // 批量：一行一条
let checkerTimer = null;

const CHECKER_INDUSTRIES = ['通用', '车贷', '家装', '电商', '招聘', '本地生活', '教培', '医疗'];

const SCENES = [
  { v: 'dm', t: '私信' },
  { v: 'comment', t: '评论' },
  { v: 'broadcast', t: '群发' },
  { v: 'intercept', t: '线索雷达' },
];

function emptyForm() {
  return {
    groupId: groups.value[0]?.id ?? '',
    word: '',
    action: 'warn',
    severity: 2,
    replaceTo: '',
    message: '',
    suggestion: '',
    rewritePolicy: 'manual',
    category: '',
    basis: '',
    scope: ['dm', 'comment', 'broadcast', 'intercept'],
  };
}

// ── 数据加载 ──
async function loadGroups() {
  try {
    groups.value = await api.sw.groups();
  } catch (e) {
    ElMessage.error('加载分组失败');
  }
}

async function loadWords() {
  loading.value = true;
  try {
    words.value = await api.sw.list({
      groupId: selectedGroup.value || undefined,
      keyword: keyword.value || undefined,
    });
  } catch (e) {
    ElMessage.error('加载词库失败');
  } finally {
    loading.value = false;
  }
}

async function loadStats() {
  try {
    stats.value = await api.sw.stats({ days: 7 });
  } catch (e) {
    console.error(e);
  }
}

// ── 操作 ──
function openAdd() {
  editing.value = null;
  form.value = emptyForm();
  dialogVisible.value = true;
}

function openEdit(w) {
  editing.value = w;
  form.value = {
    groupId: w.group_id,
    word: w.word,
    action: w.action,
    severity: w.severity ?? 2,
    replaceTo: w.replace_to ?? '',
    message: w.message ?? '',
    suggestion: w.suggestion ?? '',
    rewritePolicy: w.rewrite_policy || 'manual',
    category: w.category ?? '',
    basis: w.basis ?? '',
    scope: (w.scope ?? '').split(',').filter(Boolean),
  };
  dialogVisible.value = true;
}

async function submit() {
  if (!form.value.word.trim()) {
    ElMessage.error('请填写词条');
    return;
  }
  if (form.value.word.trim().length < 2) {
    ElMessage.error('词条至少 2 个字（单字歧义太大，建议用"加微"这类组合词）');
    return;
  }

  const payload = {
    groupId: form.value.groupId,
    word: form.value.word.trim(),
    action: form.value.action,
    severity: form.value.severity,
    replaceTo: form.value.replaceTo || null,
    message: form.value.message || null,
    suggestion: form.value.suggestion || null,
    rewritePolicy: form.value.rewritePolicy || 'manual',
    category: form.value.category || null,
    basis: form.value.basis || null,
    scope: form.value.scope.join(','),
  };

  try {
    if (editing.value) {
      await api.sw.update(editing.value.id, {
        group_id: payload.groupId,
        word: payload.word,
        action: payload.action,
        severity: payload.severity,
        replace_to: payload.replaceTo,
        message: payload.message,
        suggestion: payload.suggestion,
        rewrite_policy: payload.rewritePolicy,
        category: payload.category,
        basis: payload.basis,
        scope: payload.scope,
      });
      ElMessage.success('已更新');
    } else {
      await api.sw.add(payload);
      ElMessage.success('已添加');
    }
    dialogVisible.value = false;
    await Promise.all([loadWords(), loadGroups()]);
  } catch (e) {
    ElMessage.error(e.message || '保存失败');
  }
}

async function toggleWord(w) {
  await api.sw.update(w.id, { enabled: w.enabled ? 0 : 1 });
  await loadWords();
}

async function removeWord(w) {
  try {
    await ElMessageBox.confirm(`确定删除词条「${w.word}」？`, '删除词条', { type: 'warning' });
    await api.sw.delete(w.id);
    ElMessage.success('已删除');
    await Promise.all([loadWords(), loadGroups()]);
  } catch {}
}

async function clearHits() {
  try {
    await ElMessageBox.confirm('确定清空所有命中记录？', '清空记录', { type: 'warning' });
    await api.sw.clearHits();
    await loadStats();
    ElMessage.success('已清空');
  } catch {}
}

// ── 展示辅助 ──
const actionMap = {
  block: { text: '阻断', tag: 'danger' },
  warn: { text: '警告', tag: 'warning' },
  replace: { text: '替换', tag: 'info' },
};

const severityMap = {
  3: { text: '高危', tag: 'danger' },
  2: { text: '中危', tag: 'warning' },
  1: { text: '低危', tag: 'info' },
};

const grouped = computed(() => {
  const map = new Map();
  for (const g of groups.value) {
    map.set(g.id, { ...g, words: [] });
  }
  for (const w of words.value) {
    if (!map.has(w.group_id)) {
      map.set(w.group_id, { id: w.group_id, name: '未分组', words: [] });
    }
    map.get(w.group_id).words.push(w);
  }
  return [...map.values()].filter((g) => g.words.length > 0 || !selectedGroup.value);
});

function maxHit() {
  return stats.value.byWord[0]?.c ?? 1;
}

// ── 话术检查器 ──
function splitCheckerLines(v = checkerInput.value) {
  return String(v)
    .split(/[\r\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function scheduleCheckerCheck() {
  if (checkerTimer) clearTimeout(checkerTimer);
  checkerTimer = setTimeout(() => runCheckerCheck(), 350);
}

async function runCheckerCheck() {
  const lines = splitCheckerLines();
  if (!lines.length) {
    checkerResult.value = null;
    checkerRewrite.value = null;
    checkerItems.value = [];
    return;
  }
  checkerChecking.value = true;
  try {
    const previews = await Promise.all(
      lines.map((text) =>
        api.sw.preview(text, checkerScene.value).catch(() => null),
      ),
    );
    const items = lines.map((text, i) => {
      const r = previews[i];
      return {
        text,
        score: r?.score ?? null,
        level: r?.level ?? 'safe',
        blocked: !!r?.blocked,
        hits: r?.hits ?? [],
        replaced: r?.replaced ?? text,
      };
    });
    checkerItems.value = items;
    const blockedCount = items.filter((x) => x.blocked).length;
    const riskyCount = items.filter((x) => !x.blocked && (x.level === 'risk' || x.level === 'danger')).length;
    const totalHits = items.reduce((s, x) => s + x.hits.length, 0);
    checkerResult.value = {
      total: items.length,
      blockedCount,
      riskyCount,
      safe: items.length - blockedCount - riskyCount,
      totalHits,
    };
  } catch (e) {
    checkerResult.value = { error: e.message || '检测失败' };
  } finally {
    checkerChecking.value = false;
  }
}

async function runCheckerRewrite() {
  const lines = splitCheckerLines();
  if (!lines.length) return;
  checkerRewriting.value = true;
  try {
    const results = await Promise.all(
      lines.map((text) => api.sw.rewrite(text, checkerScene.value, {
        industry: checkerIndustry.value,
        sentence: true,
      }).catch((e) => ({
        ok: false,
        error: e.message,
        rewritten: text,
        changes: [],
        unresolved: [],
      }))),
    );
    // 一行一条结果，改写后仍一行一条
    const rewrittenLines = results.map((r) => (r.rewritten ?? '').trim());
    // 空行占位：如果某行被全部删除，用空字符串保留行数对应关系
    const joined = rewrittenLines.join('\n');

    const prevLines = splitCheckerLines();
    checkerRewrite.value = {
      lines: results,
      joined,
      replacedCount: results.filter((r) => r.rewritten !== lines[results.indexOf(r)]).length,
      blockLeft: results.filter((r) => !r.ok).length,
      okCount: results.filter((r) => r.ok && (r.rewritten ?? '') !== prevLines[results.indexOf(r)]).length,
      templates: [...new Set(results.map((r) => r.templateName).filter(Boolean))],
      templateCount: results.filter((r) => r.method === 'template').length,
    };

    checkerInput.value = joined || checkerInput.value;
    await runCheckerCheck();
  } finally {
    checkerRewriting.value = false;
  }
}

async function copyCheckerOutput() {
  try {
    await navigator.clipboard.writeText(checkerInput.value);
    ElMessage.success('已复制当前话术');
  } catch {
    ElMessage.error('复制失败');
  }
}

watch(checkerInput, scheduleCheckerCheck);
watch(checkerScene, runCheckerCheck);

// ── 话术库操作 ──
function emptyCopyForm() {
  return { name: '', text: '' };
}

async function loadCopyTemplates() {
  copyLoading.value = true;
  try {
    const list = await api.ic.templates();
    copyTemplates.value = Array.isArray(list) ? list : [];
  } catch (e) {
    ElMessage.error('加载话术库失败');
  } finally {
    copyLoading.value = false;
  }
}

function hitSummary(result) {
  const hits = Array.isArray(result?.hits) ? result.hits : [];
  const words = hits.map((h) => h.word).filter(Boolean).slice(0, 5);
  return words.join('、');
}

function copyStatus(t) {
  const r = copyChecks.value[t.id];
  if (!r) return { text: '未审查', cls: 'info' };
  if (r.blocked) return { text: '阻断', cls: 'danger' };
  if (Array.isArray(r.hits) && r.hits.length) return { text: `命中 ${r.hits.length}`, cls: 'warning' };
  return { text: '通过', cls: 'ok' };
}

async function checkCopy(t) {
  try {
    const r = await api.sw.preview(t.text, 'dm');
    copyChecks.value = { ...copyChecks.value, [t.id]: r };
  } catch (e) {
    ElMessage.error(e.message || '审查失败');
  }
}

async function checkAllCopy() {
  if (!copyTemplates.value.length) return;
  for (const t of copyTemplates.value) await checkCopy(t);
  ElMessage.success('话术库审查完成');
}

function openCopyAdd() {
  copyEditing.value = null;
  copyForm.value = emptyCopyForm();
  copyFormCheck.value = null;
  copyDialogVisible.value = true;
}

function openCopyEdit(t) {
  copyEditing.value = t;
  copyForm.value = {
    name: t.name || '',
    text: t.text || '',
  };
  copyFormCheck.value = copyChecks.value[t.id] || null;
  copyDialogVisible.value = true;
}

async function checkCopyForm() {
  const text = String(copyForm.value.text || '').trim();
  if (!text) {
    ElMessage.error('请先填写话术');
    return;
  }
  try {
    copyFormCheck.value = await api.sw.preview(text, 'dm');
  } catch (e) {
    ElMessage.error(e.message || '审查失败');
  }
}

async function submitCopy() {
  const name = String(copyForm.value.name || '').trim() || '未命名';
  const text = String(copyForm.value.text || '').replace(/\s*\r?\n\s*/g, ' ').trim().slice(0, 500);
  if (!text) {
    ElMessage.error('请填写话术');
    return;
  }
  const list = copyTemplates.value.map((t) => ({
    id: t.id,
    name: t.name,
    text: t.text,
  }));

  if (copyEditing.value) {
    const idx = list.findIndex((t) => t.id === copyEditing.value.id);
    if (idx >= 0) list[idx] = { ...list[idx], name, text };
  } else {
    list.push({ id: `tpl-${Date.now()}`, name, keywords, text });
  }

  try {
    const saved = await api.ic.saveTemplates(list);
    copyTemplates.value = Array.isArray(saved) ? saved : list;
    copyDialogVisible.value = false;
    ElMessage.success('话术已保存');
  } catch (e) {
    ElMessage.error(e.message || '保存失败');
  }
}

async function removeCopy(t) {
  try {
    await ElMessageBox.confirm(`删除话术「${t.name}」？`, '删除话术', { type: 'warning' });
  } catch {
    return;
  }
  const list = copyTemplates.value
    .filter((x) => x.id !== t.id)
    .map((x) => ({ id: x.id, name: x.name, text: x.text }));
  if (!list.length) {
    ElMessage.error('至少保留一条话术');
    return;
  }
  try {
    const saved = await api.ic.saveTemplates(list);
    copyTemplates.value = Array.isArray(saved) ? saved : list;
    ElMessage.success('已删除');
  } catch (e) {
    ElMessage.error(e.message || '删除失败');
  }
}

onMounted(async () => {
  await loadGroups();
  await Promise.all([loadWords(), loadStats(), loadCopyTemplates()]);
});
</script>

<template>
  <div class="sw-view">
    <header class="page-head">
      <div>
        <h2>话术库</h2>
        <p class="sub">
          话术库 + 敏感词库 + 检查器：配置话术、先审后发
        </p>
      </div>
      <button v-if="tab === 'words'" class="primary" @click="openAdd">＋ 新增词条</button>
    </header>

    <div class="tabs">
      <button :class="{ active: tab === 'copy' }" @click="tab = 'copy'; loadCopyTemplates()">
        话术库
        <span v-if="copyTemplates.length" class="badge info">{{ copyTemplates.length }}</span>
      </button>
      <button :class="{ active: tab === 'words' }" @click="tab = 'words'">敏感词库</button>
      <button :class="{ active: tab === 'checker' }" @click="tab = 'checker'">话术检查器</button>
      <button :class="{ active: tab === 'stats' }" @click="tab = 'stats'; loadStats()">
        命中统计
        <span v-if="stats.total" class="badge">{{ stats.total }}</span>
      </button>
    </div>

    <!-- ══════════ 话术库 ══════════ -->
    <div v-if="tab === 'copy'" class="panel">
      <div class="filters">
        <button class="primary" @click="openCopyAdd">＋ 新增话术</button>
        <button class="ghost" @click="checkAllCopy">全部审查</button>
        <span class="total">共 {{ copyTemplates.length }} 条 · 可被线索雷达一键勾选</span>
      </div>

      <div v-if="copyLoading" class="empty">加载中…</div>
      <div v-else-if="!copyTemplates.length" class="empty">暂无话术</div>

      <div v-else class="copy-list">
        <div v-for="t in copyTemplates" :key="t.id" class="copy-item">
          <div class="copy-head">
            <span class="copy-name">{{ t.name }}</span>
            <span class="tag" :class="copyStatus(t).cls">{{ copyStatus(t).text }}</span>
            <span class="ops">
              <button @click="checkCopy(t)">审查</button>
              <button @click="openCopyEdit(t)">编辑</button>
              <button class="danger" @click="removeCopy(t)">删除</button>
            </span>
          </div>
          <div class="copy-text">{{ t.text }}</div>
          <div v-if="copyChecks[t.id]" class="copy-check">
            <span v-if="copyChecks[t.id].blocked" class="check-block">
              阻断：{{ hitSummary(copyChecks[t.id]) || '命中阻断词' }}
            </span>
            <span v-else-if="copyChecks[t.id].hits?.length" class="check-warn">
              命中 {{ copyChecks[t.id].hits.length }} 条：{{ hitSummary(copyChecks[t.id]) }}
            </span>
            <span v-else class="check-ok">未命中敏感词，可发送</span>
          </div>
        </div>
      </div>
    </div>

    <!-- ══════════ 词库管理 ══════════ -->
    <div v-if="tab === 'words'" class="panel">
      <div class="filters">
        <select v-model="selectedGroup" @change="loadWords">
          <option value="">全部分组</option>
          <option v-for="g in groups" :key="g.id" :value="g.id">
            {{ g.name }}（{{ g.count }}）
          </option>
        </select>
        <input v-model="keyword" placeholder="搜索词条" @input="loadWords" />
        <span class="total">共 {{ words.length }} 条</span>
      </div>

      <div v-if="loading" class="empty">加载中…</div>
      <div v-else-if="!words.length" class="empty">暂无词条</div>

      <div v-else class="groups">
        <div v-for="g in grouped" :key="g.id" class="group">
          <div class="group-head">
            <span class="gname">{{ g.name }}</span>
            <span class="gcount">{{ g.words.length }}</span>
            <span v-if="g.description" class="gdesc">{{ g.description }}</span>
          </div>
          <div class="word-list">
            <div
              v-for="w in g.words"
              :key="w.id"
              class="word-item"
              :class="{ disabled: !w.enabled }"
            >
              <span class="w">{{ w.word }}</span>
              <span class="tag" :class="actionMap[w.action]?.tag">
                {{ actionMap[w.action]?.text }}
              </span>
              <span class="tag" :class="severityMap[w.severity]?.tag">
                {{ severityMap[w.severity]?.text }}
              </span>
              <span v-if="w.suggestion" class="replace">→ {{ w.suggestion }}</span>
              <span v-else-if="w.rewrite_policy === 'remove'" class="replace">→ 删除</span>
              <span v-if="w.category" class="category">{{ w.category }}</span>
              <span class="ops">
                <button @click="openEdit(w)">编辑</button>
                <button @click="toggleWord(w)">{{ w.enabled ? '停用' : '启用' }}</button>
                <button class="danger" @click="removeWord(w)">删除</button>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ══════════ 命中统计 ══════════ -->
    <div v-if="tab === 'stats'" class="panel">
      <div class="stat-head">
        <h3>近 {{ stats.days }} 天命中共 {{ stats.total }} 次</h3>
        <button class="ghost" @click="clearHits">清空记录</button>
      </div>

      <div v-if="!stats.byWord.length" class="empty">
        <p>暂无命中记录</p>
        <p class="hint">发送消息时会自动记录命中的敏感词</p>
      </div>

      <div v-else class="stat-list">
        <div v-for="w in stats.byWord" :key="w.word" class="stat-row">
          <span class="sw">{{ w.word }}</span>
          <div class="bar">
            <div class="fill" :style="{ width: Math.round((w.c / maxHit()) * 100) + '%' }"></div>
          </div>
          <span class="count">{{ w.c }} 次</span>
          <span v-if="w.c >= 20" class="suggest">← 建议检查话术</span>
        </div>
      </div>
    </div>

    <!-- ══════════ 话术检查器 ══════════ -->
    <div v-if="tab === 'checker'" class="panel">
      <div class="checker-head">
        <div class="checker-toolbar">
          <span class="label">适用场景</span>
          <select v-model="checkerScene" class="scene-select">
            <option v-for="s in SCENES" :key="s.v" :value="s.v">{{ s.t }}</option>
          </select>
          <span class="label">行业模板</span>
          <select v-model="checkerIndustry" class="scene-select">
            <option v-for="i in CHECKER_INDUSTRIES" :key="i" :value="i">{{ i }}</option>
          </select>
          <button class="ghost" @click="copyCheckerOutput">复制全部</button>
          <button
            class="ghost"
            :disabled="checkerChecking || !checkerItems.length"
            @click="runCheckerCheck"
          >重新检测</button>
          <button
            class="rewrite-btn"
            :disabled="checkerRewriting || !splitCheckerLines().length"
            @click="runCheckerRewrite"
          >{{ checkerRewriting ? '改写中…' : '一键合规改写' }}</button>
        </div>
        <div v-if="checkerResult && !checkerResult.error" class="checker-summary">
          <span class="cs-item">共 {{ checkerResult.total }} 条</span>
          <span class="cs-item ok">安全 {{ checkerResult.safe }}</span>
          <span class="cs-item warn">有风险 {{ checkerResult.riskyCount }}</span>
          <span class="cs-item" :class="checkerResult.blockedCount ? 'danger' : ''">
            含阻断词 {{ checkerResult.blockedCount }}
          </span>
          <span class="cs-item">命中词 {{ checkerResult.totalHits }} 次</span>
        </div>
        <div v-if="checkerRewrite?.templateCount" class="checker-summary">
          <span class="cs-item ok">整句模板 {{ checkerRewrite.templateCount }} 条</span>
          <span v-for="t in checkerRewrite.templates" :key="t" class="cs-item">{{ t }}</span>
        </div>
        <p class="checker-note">
          只做合规替换/删除，不做同音字、零宽字符等规避平台审核的处理。
          每行一条，发送前会自动再做一次检查并替换。
        </p>
      </div>

      <textarea
        v-model="checkerInput"
        rows="9"
        class="checker-input"
        placeholder="每行一条话术，例如：&#10;全网最好用的产品，稳赚不赔，加微信私聊&#10;今天天气不错"
      />

      <div v-if="checkerItems.length" class="checker-list">
        <div
          v-for="(item, i) in checkerItems"
          :key="i"
          class="checker-row"
          :class="{ blocked: item.blocked, risk: !item.blocked && (item.level === 'risk' || item.level === 'danger') }"
        >
          <div class="cr-line">
            <span class="cr-idx">#{{ i + 1 }}</span>
            <span class="cr-status" :class="item.blocked ? 'danger' : item.level">
              {{ item.blocked ? '阻断' : item.level === 'safe' ? '安全' : '风险' }}
              <template v-if="item.score != null">· {{ item.score }} 分</template>
            </span>
            <span class="cr-text" :class="{ changed: item.replaced !== item.text }">{{ item.text }}</span>
          </div>
          <div v-if="item.hits.length" class="cr-hits">
            <span v-for="h in item.hits" :key="h.word" class="cr-hit">
              {{ h.word }}
              <template v-if="h.action === 'block'">（阻断）</template>
              <template v-else-if="h.replaceTo">→ {{ h.replaceTo }}</template>
            </span>
          </div>
          <div v-if="item.replaced !== item.text" class="cr-replaced">将替换为：{{ item.replaced }}</div>
        </div>
      </div>
      <div v-else class="empty">输入或粘贴话术开始检测</div>
    </div>

    <!-- 新增/编辑弹窗 -->
    <el-dialog
      v-model="dialogVisible"
      :title="editing ? '编辑词条' : '新增词条'"
      width="480px"
    >
      <div class="form">
        <div class="row">
          <label>所属分组</label>
          <select v-model="form.groupId">
            <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
          </select>
        </div>
        <div class="row">
          <label>词条</label>
          <input v-model="form.word" placeholder="至少 2 个字，如「加微」" />
        </div>
        <div class="row">
          <label>动作</label>
          <div class="radios">
            <label><input type="radio" value="block" v-model="form.action" /> 阻断（不可发）</label>
            <label><input type="radio" value="warn" v-model="form.action" /> 警告（可发）</label>
            <label><input type="radio" value="replace" v-model="form.action" /> 替换</label>
          </div>
        </div>
        <div class="row" v-if="form.action === 'replace'">
          <label>替换为</label>
          <input v-model="form.replaceTo" placeholder="替换后的文本" />
        </div>
        <div class="row">
          <label>合规改写</label>
          <div class="radios">
            <label><input type="radio" value="replace" v-model="form.rewritePolicy" /> 替换</label>
            <label><input type="radio" value="remove" v-model="form.rewritePolicy" /> 删除</label>
            <label><input type="radio" value="block" v-model="form.rewritePolicy" /> 硬阻断</label>
            <label><input type="radio" value="manual" v-model="form.rewritePolicy" /> 人工</label>
          </div>
        </div>
        <div class="row" v-if="form.rewritePolicy === 'replace'">
          <label>替代说法</label>
          <input v-model="form.suggestion" placeholder="如：很好 / 较优 / 实惠" />
        </div>
        <div class="row">
          <label>类别</label>
          <input v-model="form.category" placeholder="如：极限用语 / 医疗功效 / 导流" />
        </div>
        <div class="row">
          <label>依据</label>
          <input v-model="form.basis" placeholder="法条或平台规则（可选）" />
        </div>
        <div class="row">
          <label>严重度</label>
          <div class="radios">
            <label><input type="radio" :value="3" v-model="form.severity" /> 高危（-20分）</label>
            <label><input type="radio" :value="2" v-model="form.severity" /> 中危（-10分）</label>
            <label><input type="radio" :value="1" v-model="form.severity" /> 低危（-5分）</label>
          </div>
        </div>
        <div class="row">
          <label>提示语</label>
          <input v-model="form.message" placeholder="命中时显示的说明（可选）" />
        </div>
        <div class="row">
          <label>作用域</label>
          <div class="radios">
            <label v-for="s in [
              { v: 'dm', t: '私信' },
              { v: 'comment', t: '评论' },
              { v: 'broadcast', t: '群发' },
              { v: 'intercept', t: '线索雷达' },
            ]" :key="s.v">
              <input type="checkbox" :value="s.v" v-model="form.scope" /> {{ s.t }}
            </label>
          </div>
        </div>
      </div>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="copyDialogVisible"
      :title="copyEditing ? '编辑话术' : '新增话术'"
      width="640px"
      :close-on-click-modal="false"
    >
      <div class="form">
        <div class="row">
          <label>名称</label>
          <input v-model="copyForm.name" placeholder="如：矩阵工具 / 车抵贷 / 通用" />
        </div>
        <div class="row">
          <label>话术</label>
          <textarea
            v-model="copyForm.text"
            rows="5"
            maxlength="500"
            class="copy-form-text"
            placeholder="一条消息内容；发送前会过敏感词检查"
          ></textarea>
        </div>
        <div class="row">
          <label></label>
          <button class="ghost" @click="checkCopyForm">审查当前话术</button>
          <span v-if="copyFormCheck" class="copy-form-status" :class="{ danger: copyFormCheck.blocked }">
            {{ copyFormCheck.blocked
              ? `阻断：${hitSummary(copyFormCheck) || '命中阻断词'}`
              : (copyFormCheck.hits?.length
                ? `命中 ${copyFormCheck.hits.length} 条：${hitSummary(copyFormCheck)}`
                : '通过') }}
          </span>
        </div>
      </div>
      <template #footer>
        <el-button @click="copyDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitCopy">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.sw-view {
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
  height: 32px; padding: 0 16px; border: none; border-radius: 6px;
  background: var(--c-primary); color: #fff; font-size: 13px;
}

.tabs { display: flex; gap: 6px; margin-bottom: 14px; }
.tabs button {
  height: 30px; padding: 0 16px; border: 1px solid var(--c-border);
  border-radius: 6px; background: #fff; font-size: 13px; color: var(--c-text-2);
  display: flex; align-items: center; gap: 6px;
}
.tabs button.active {
  border-color: var(--c-primary); background: #eaf1ff; color: var(--c-primary);
}
.badge {
  font-size: 10px; padding: 0 5px; border-radius: 8px;
  background: var(--c-danger); color: #fff;
}

.panel { flex: 1; }

.filters { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
.filters select, .filters input {
  height: 30px; padding: 0 10px; border: 1px solid var(--c-border);
  border-radius: 6px; font-size: 13px; outline: none;
}
.filters input { flex: 1; max-width: 260px; }
.total { font-size: 12px; color: var(--c-text-2); margin-left: auto; }

.empty { padding: 50px; text-align: center; color: var(--c-text-2); font-size: 13px; }
.empty .hint { font-size: 12px; color: var(--c-text-3); margin-top: 6px; }

.groups { display: flex; flex-direction: column; gap: 14px; }
.group {
  background: #fff; border: 1px solid var(--c-border); border-radius: 8px;
  overflow: hidden;
}
.group-head {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 14px; background: #fafbfc; border-bottom: 1px solid var(--c-border);
}
.gname { font-size: 13px; font-weight: 600; }
.gcount {
  font-size: 11px; padding: 0 6px; border-radius: 8px;
  background: #eaf1ff; color: var(--c-primary);
}
.gdesc { font-size: 11px; color: var(--c-text-3); margin-left: auto; }

.word-list { display: flex; flex-direction: column; }
.word-item {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 14px; border-bottom: 1px solid #f5f6f8; font-size: 12px;
}
.word-item:last-child { border-bottom: none; }
.word-item:hover { background: #fafbfc; }
.word-item.disabled { opacity: 0.45; }
.word-item .w { font-weight: 500; min-width: 60px; }
.replace { color: var(--c-text-2); font-size: 11px; }
.category {
  color: var(--c-primary); background: #eef4ff; border-radius: 8px;
  padding: 0 6px; font-size: 10px;
}
.ops { margin-left: auto; display: flex; gap: 4px; }
.ops button {
  height: 22px; padding: 0 8px; border: 1px solid var(--c-border);
  border-radius: 4px; background: #fff; font-size: 11px; color: var(--c-text-2);
}
.ops button.danger { border-color: var(--c-danger); color: var(--c-danger); }

.tag {
  display: inline-block; font-size: 11px; padding: 0 5px;
  border-radius: 3px; background: #f0f1f4; color: var(--c-text-2); white-space: nowrap;
}
.tag.danger { background: #ffece9; color: #d4380d; }
.tag.warning { background: #fff4e5; color: #b76e00; }
.tag.info { background: #eaf1ff; color: var(--c-primary); }
.tag.ok { background: #e8f7ee; color: #1a7f37; }

.copy-list { display: flex; flex-direction: column; gap: 10px; }
.copy-item { border: 1px solid var(--c-border); border-radius: 8px; padding: 12px 14px; background: #fff; }
.copy-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.copy-name { font-size: 13px; font-weight: 600; }
.copy-head .ops { margin-left: auto; }
.copy-text { font-size: 12px; line-height: 1.7; color: var(--c-text-1); word-break: break-all; }
.copy-check { margin-top: 8px; font-size: 11px; line-height: 1.6; }
.check-ok { color: #1a7f37; }
.check-warn { color: #b76e00; }
.check-block { color: var(--c-danger); }
.copy-form-text {
  flex: 1; padding: 8px 10px; border: 1px solid var(--c-border); border-radius: 6px;
  font-size: 13px; font-family: inherit; line-height: 1.7; resize: vertical; outline: none;
}
.copy-form-status { font-size: 12px; color: #1a7f37; }
.copy-form-status.danger { color: var(--c-danger); }

.stat-head {
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px;
}
.stat-head h3 { font-size: 14px; font-weight: 500; }
.ghost {
  height: 28px; padding: 0 12px; border: 1px solid var(--c-border);
  border-radius: 6px; background: #fff; font-size: 12px; color: var(--c-text-2);
}

.stat-list { display: flex; flex-direction: column; gap: 8px; max-width: 700px; }
.stat-row { display: flex; align-items: center; gap: 10px; font-size: 12px; }
.stat-row .sw { width: 100px; font-weight: 500; }
.stat-row .bar {
  flex: 1; height: 16px; background: #f5f6f8; border-radius: 4px; overflow: hidden;
}
.stat-row .fill { height: 100%; background: var(--c-primary); }
.stat-row .count { width: 60px; text-align: right; color: var(--c-text-2); }
.suggest { color: var(--c-warn); font-size: 11px; }

.samples { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.samples button {
  height: 26px; padding: 0 10px; border: 1px solid var(--c-border);
  border-radius: 13px; background: #fff; font-size: 12px; color: var(--c-text-2);
}
.samples button:hover { border-color: var(--c-primary); color: var(--c-primary); }

.form { display: flex; flex-direction: column; gap: 12px; }
.row { display: flex; gap: 12px; align-items: flex-start; }
.row > label {
  width: 72px; flex-shrink: 0; font-size: 13px; color: var(--c-text-2); padding-top: 5px;
}
.row input:not([type]), .row select {
  flex: 1; height: 30px; padding: 0 10px; border: 1px solid var(--c-border);
  border-radius: 6px; font-size: 13px; outline: none;
}
.radios { display: flex; flex-wrap: wrap; gap: 12px; font-size: 13px; }
.radios label { display: flex; align-items: center; gap: 4px; cursor: pointer; }

/* 话术检查器 */
.checker-head { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; }
.checker-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.checker-toolbar .label { font-size: 12px; color: var(--c-text-2); }
.scene-select {
  height: 28px; padding: 0 8px; border: 1px solid var(--c-border);
  border-radius: 6px; background: #fff; font-size: 13px; outline: none;
}
.checker-toolbar .ghost {
  height: 28px; padding: 0 12px; border: 1px solid var(--c-border);
  border-radius: 6px; background: #fff; font-size: 12px; color: var(--c-text-2);
  cursor: pointer;
}
.checker-toolbar .ghost:disabled { opacity: 0.55; cursor: default; }
.checker-toolbar .rewrite-btn {
  height: 30px; padding: 0 14px; border: none; border-radius: 6px;
  background: var(--c-primary); color: #fff; font-size: 12px; font-weight: 600;
  cursor: pointer;
}
.checker-toolbar .rewrite-btn:disabled { opacity: 0.55; cursor: default; }
.checker-summary { display: flex; gap: 10px; flex-wrap: wrap; font-size: 12px; }
.cs-item { padding: 2px 10px; border-radius: 12px; background: #f0f1f4; color: var(--c-text-2); }
.cs-item.ok { background: #e8f7ee; color: #1a7f37; }
.cs-item.warn { background: #fff4e5; color: #b76e00; }
.cs-item.danger { background: #ffece9; color: var(--c-danger); }
.checker-note { font-size: 11px; color: var(--c-text-3); line-height: 1.6; }
.checker-input {
  width: 100%; padding: 10px 12px; border: 1px solid var(--c-border);
  border-radius: 8px; font-size: 13px; font-family: inherit; outline: none;
  resize: vertical; line-height: 1.7;
}
.checker-input:focus { border-color: var(--c-primary); }
.checker-list { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.checker-row {
  border: 1px solid var(--c-border); border-radius: 8px; padding: 9px 11px;
  background: #fafbfc; font-size: 12px;
}
.checker-row.blocked { border-color: #ffc9c9; background: #fff8f7; }
.checker-row.risk { border-color: #ffd8a8; background: #fffbf5; }
.cr-line { display: flex; align-items: baseline; gap: 8px; }
.cr-idx { color: var(--c-text-3); flex: 0 0 auto; }
.cr-status { flex: 0 0 auto; font-weight: 600; }
.cr-status.safe { color: #1a7f37; }
.cr-status.risk { color: #b76e00; }
.cr-status.danger { color: var(--c-danger); }
.cr-text { color: var(--c-text-1); word-break: break-all; }
.cr-text.changed { color: #1a7f37; }
.cr-hits { margin-top: 5px; display: flex; gap: 6px; flex-wrap: wrap; }
.cr-hit {
  padding: 1px 6px; border-radius: 4px; background: #ffece9; color: #d4380d;
  font-size: 11px;
}
.cr-replaced { margin-top: 5px; color: var(--c-text-2); word-break: break-all; }
</style>
