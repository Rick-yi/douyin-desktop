<script setup>
import { api } from '../api.js';
import { ref, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import SensitivePrecheck from '../components/SensitivePrecheck.vue';

const props = defineProps({
  accounts: { type: Array, default: () => [] },
});

const cards = ref([]);
const groups = ref([]);
const loading = ref(false);
const selectedGroup = ref('');
const keyword = ref('');

// 编辑弹窗
const editVisible = ref(false);
const editing = ref(null);
const editForm = ref({ name: '', groupName: '', textTpl: '' });

// 新建跳转卡片
const linkVisible = ref(false);
const creatingLink = ref(false);
const linkForm = ref({
  name: '', groupName: '', url: '', title: '', description: '', coverUrl: '', textTpl: '',
});

// 发送弹窗
const sendVisible = ref(false);
const sendCard = ref(null);
const sendForm = ref({ accountId: '', peerUid: '', text: '' });
const contacts = ref([]);
const sending = ref(false);

// 大图预览
const previewVisible = ref(false);
const previewCard = ref(null);

// ── 加载 ──
async function loadAll() {
  loading.value = true;
  try {
    const [c, g] = await Promise.all([
      api.card.list({
        groupName: selectedGroup.value || undefined,
        keyword: keyword.value || undefined,
      }),
      api.card.groups(),
    ]);
    cards.value = c;
    groups.value = g;
  } catch (e) {
    ElMessage.error('加载失败: ' + e.message);
  } finally {
    loading.value = false;
  }
}

// ── 新建跳转卡片 ──
function openLink() {
  linkForm.value = {
    name: '',
    groupName: selectedGroup.value || '默认',
    url: '',
    title: '',
    description: '',
    coverUrl: '',
    textTpl: '',
  };
  linkVisible.value = true;
}

async function submitLink() {
  if (!linkForm.value.url.trim()) { ElMessage.error('请填写跳转链接'); return; }
  if (!/^https?:\/\//i.test(linkForm.value.url.trim())) {
    ElMessage.error('跳转链接必须以 http:// 或 https:// 开头');
    return;
  }
  creatingLink.value = true;
  try {
    const r = await api.card.addLink(linkForm.value);
    if (!r.ok) { ElMessage.error(r.error || '创建失败'); return; }
    ElMessage.success('跳转卡片已创建');
    linkVisible.value = false;
    await loadAll();
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    creatingLink.value = false;
  }
}

// ── 编辑 ──
function openEdit(c) {
  editing.value = c;
  editForm.value = {
    name: c.name,
    groupName: c.groupName,
    textTpl: c.textTpl ?? '',
    linkUrl: c.linkUrl ?? '',
    linkTitle: c.linkTitle ?? '',
    linkDesc: c.linkDesc ?? '',
    linkCoverUrl: c.linkCoverUrl ?? '',
  };
  editVisible.value = true;
}

async function submitEdit() {
  try {
    const patch = {
      name: editForm.value.name,
      groupName: editForm.value.groupName,
      textTpl: editForm.value.textTpl,
      linkUrl: editForm.value.linkUrl,
      linkTitle: editForm.value.linkTitle,
      linkDesc: editForm.value.linkDesc,
      linkCoverUrl: editForm.value.linkCoverUrl,
    };
    await api.card.update(editing.value.id, patch);
    ElMessage.success('已保存');
    editVisible.value = false;
    await loadAll();
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function removeCard(c) {
  try {
    await ElMessageBox.confirm(`确定删除「${c.name}」？`, '删除卡片', { type: 'warning' });
  } catch {
    return;
  }

  try {
    await api.card.delete(c.id);
    ElMessage.success('已删除');
    await loadAll();
    return;
  } catch (e) {
    const msg = e?.message || '';
    if (!msg.includes('引用')) {
      ElMessage.error(msg || '删除失败');
      return;
    }

    try {
      await ElMessageBox.confirm(
        `${msg}\n\n删除后会同时移除这些规则/草稿里的卡片引用，是否继续？`,
        '卡片被引用',
        { type: 'warning', confirmButtonText: '解除并删除', cancelButtonText: '取消' },
      );
    } catch {
      return;
    }

    try {
      await api.card.delete(c.id, { force: true });
      ElMessage.success('已删除，并解除引用');
      await loadAll();
    } catch (e2) {
      ElMessage.error(e2?.message || '删除失败');
    }
  }
}

// ── 发送 ──
async function openSend(c) {
  sendCard.value = c;
  sendForm.value = {
    accountId: props.accounts[0]?.id ?? '',
    peerUid: '',
    text: c.textTpl ?? '',
  };
  sendVisible.value = true;
  await loadContacts();
}

async function loadContacts() {
  if (!sendForm.value.accountId) { contacts.value = []; return; }
  try {
    const list = await api.conv.list(sendForm.value.accountId, { limit: 500 });
    contacts.value = list.map((x) => ({
      uid: x.peer_uid,
      name: x.peer_nickname || x.peer_uid,
    }));
  } catch {
    contacts.value = [];
  }
}

async function submitSend() {
  if (!sendForm.value.accountId) { ElMessage.error('请选择账号'); return; }
  if (!sendForm.value.peerUid) { ElMessage.error('请选择接收人'); return; }

  sending.value = true;
  try {
    const r = await api.card.send({
      cardId: sendCard.value.id,
      accountId: sendForm.value.accountId,
      peerUid: sendForm.value.peerUid,
      text: sendForm.value.text,
    });

    if (r.ok) {
      ElMessage.success('已发送');
      if (r.warning) ElMessage.warning(r.warning);
      sendVisible.value = false;
      await loadAll();
    } else {
      ElMessage.error(r.error || '发送失败');
    }
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    sending.value = false;
  }
}

function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

const grouped = computed(() => {
  const map = new Map();
  for (const c of cards.value) {
    if (!map.has(c.groupName)) map.set(c.groupName, []);
    map.get(c.groupName).push(c);
  }
  return [...map.entries()].map(([name, list]) => ({ name, list }));
});

const linkCount = computed(() => cards.value.filter((c) => c.kind === 'link').length);

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

onMounted(loadAll);
</script>

<template>
  <div class="card-view">
    <header class="page-head">
      <div>
        <h2>卡片管理</h2>
        <p class="sub">
          共 {{ linkCount }} 张跳转卡
        </p>
      </div>
      <div class="head-actions">
        <button class="primary" @click="openLink">＋ 新建跳转卡</button>
      </div>
    </header>

    <div class="filters">
      <select v-model="selectedGroup" @change="loadAll">
        <option value="">全部分组</option>
        <option v-for="g in groups" :key="g.name" :value="g.name">
          {{ g.name }}（{{ g.count }}）
        </option>
      </select>
      <input v-model="keyword" placeholder="搜索卡片名" @input="loadAll" />
      <span class="total">共 {{ cards.length }} 张</span>
    </div>

    <div v-if="loading" class="empty">加载中…</div>
    <div v-else-if="!cards.length" class="empty">
      <p>还没有跳转卡</p>
      <p class="hint">点右上角「新建跳转卡」，填写链接、标题和描述即可</p>
    </div>

    <div v-else class="groups">
      <div v-for="g in grouped" :key="g.name" class="group">
        <div class="group-head">
          <span class="gname">{{ g.name }}</span>
          <span class="gcount">{{ g.list.length }}</span>
        </div>
        <div class="grid">
          <div v-for="c in g.list" :key="c.id" class="card">
            <div class="thumb" @click="previewCard = c; previewVisible = true">
              <img v-if="c.linkCoverUrl" :src="c.linkCoverUrl" :alt="c.name" />
              <div v-else class="link-ph">🔗<span>跳转卡片</span></div>
              <span class="kind-badge">跳转</span>
              <span v-if="c.useCount" class="use-badge">用了 {{ c.useCount }} 次</span>
            </div>
            <div class="meta">
              <div class="name" :title="c.name">{{ c.name }}</div>
              <div class="info link-host" :title="c.linkUrl">
                {{ hostOf(c.linkUrl) }}
                <span v-if="c.textTpl" class="has-text">· 有配套文本</span>
              </div>
            </div>
            <div class="ops">
              <button class="primary-sm" @click="openSend(c)">发送</button>
              <button @click="openEdit(c)">编辑</button>
              <button class="danger" @click="removeCard(c)">删除</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 编辑弹窗 -->
    <el-dialog v-model="editVisible" title="编辑卡片" width="480px">
      <div class="form">
        <div class="row">
          <label>名称</label>
          <input v-model="editForm.name" />
        </div>
        <div class="row">
          <label>分组</label>
          <input v-model="editForm.groupName" placeholder="默认" />
        </div>
        <div class="row">
          <label>跳转链接</label>
          <input v-model="editForm.linkUrl" placeholder="https://…" />
        </div>
        <div class="row">
          <label>卡片标题</label>
          <input v-model="editForm.linkTitle" />
        </div>
        <div class="row">
          <label>卡片描述</label>
          <input v-model="editForm.linkDesc" />
        </div>
        <div class="row">
          <label>封面图 URL</label>
          <input v-model="editForm.linkCoverUrl" placeholder="可选，公网 http(s) 图片" />
        </div>
        <div class="row">
          <label>配套文本</label>
          <div style="flex:1">
            <SensitivePrecheck
              v-model="editForm.textTpl"
              :rows="3"
              placeholder="发送卡片后单独发送的文本，支持变量 {昵称}"
            />
          </div>
        </div>
      </div>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" @click="submitEdit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 新建跳转卡片 -->
    <el-dialog v-model="linkVisible" title="新建跳转卡片" width="520px">
      <div class="form">
        <div class="row">
          <label>名称</label>
          <input v-model="linkForm.name" placeholder="留空则用卡片标题" />
        </div>
        <div class="row">
          <label>分组</label>
          <input v-model="linkForm.groupName" placeholder="默认" />
        </div>
        <div class="row">
          <label>跳转链接 *</label>
          <input v-model="linkForm.url" placeholder="https://…" />
        </div>
        <div class="row">
          <label>卡片标题</label>
          <input v-model="linkForm.title" placeholder="私信里显示的标题" />
        </div>
        <div class="row">
          <label>卡片描述</label>
          <input v-model="linkForm.description" placeholder="标题下面的一行小字" />
        </div>
        <div class="row">
          <label>封面图 URL</label>
          <input v-model="linkForm.coverUrl" placeholder="可选，公网 http(s) 图片（卡片中间那张图）" />
        </div>
        <div class="row">
          <label>配套文本</label>
          <div style="flex:1">
            <SensitivePrecheck v-model="linkForm.textTpl" :rows="2" placeholder="可选，卡片后单独发一条文字" />
          </div>
        </div>
        <p class="form-tip">
          跳转卡片会以链接卡片形式出现在私信里，点击后打开上面的链接。
          封面图必须是公网可直接访问的图片地址。
        </p>
      </div>
      <template #footer>
        <el-button @click="linkVisible = false">取消</el-button>
        <el-button type="primary" :disabled="creatingLink" @click="submitLink">
          {{ creatingLink ? '创建中…' : '创建' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 发送弹窗 -->
    <el-dialog v-model="sendVisible" title="发送卡片" width="480px">
      <div v-if="sendCard" class="send-card">
        <img v-if="sendCard.linkCoverUrl" :src="sendCard.linkCoverUrl" class="send-thumb" />
        <div v-else class="send-thumb link-ph">🔗</div>
        <div class="send-info">
          <div class="sn">{{ sendCard.linkTitle || sendCard.name }}</div>
          <div class="si link-host">{{ sendCard.linkUrl }}</div>
          <div v-if="sendCard.linkDesc" class="si">{{ sendCard.linkDesc }}</div>
        </div>
      </div>

      <div class="form">
        <div class="row">
          <label>发送账号</label>
          <select v-model="sendForm.accountId" @change="loadContacts">
            <option v-for="a in accounts" :key="a.id" :value="a.id">
              {{ a.nickname || a.uid }}
            </option>
          </select>
        </div>
        <div class="row">
          <label>接收人</label>
          <select v-model="sendForm.peerUid">
            <option value="">请选择</option>
            <option v-for="c in contacts" :key="c.uid" :value="c.uid">
              {{ c.name }}
            </option>
          </select>
        </div>
        <div class="row">
          <label>配套文本</label>
          <div style="flex:1">
            <SensitivePrecheck v-model="sendForm.text" :rows="2" placeholder="可选，卡片后单独发一条文字" />
          </div>
        </div>
      </div>

      <template #footer>
        <el-button @click="sendVisible = false">取消</el-button>
        <el-button type="primary" :disabled="sending" @click="submitSend">
          {{ sending ? '发送中…' : '发送' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 预览 -->
    <el-dialog v-model="previewVisible" :title="previewCard?.name" width="640px">
      <div v-if="previewCard" class="link-preview">
        <img v-if="previewCard.linkCoverUrl" :src="previewCard.linkCoverUrl" class="preview-img" />
        <div class="lp-title">{{ previewCard.linkTitle || previewCard.name }}</div>
        <div v-if="previewCard.linkDesc" class="lp-desc">{{ previewCard.linkDesc }}</div>
        <div class="lp-url">{{ previewCard.linkUrl }}</div>
      </div>
      <template #footer>
        <el-button @click="previewVisible = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.card-view {
  flex: 1; display: flex; flex-direction: column;
  padding: 18px 22px; overflow-y: auto; min-width: 0;
}
.page-head { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 14px; }
.page-head h2 { font-size: 18px; font-weight: 600; }
.sub { font-size: 12px; color: var(--c-text-2); margin-top: 4px; }
.head-actions { display: flex; gap: 8px; }
.head-actions button {
  height: 32px; padding: 0 14px; border: 1px solid var(--c-border); border-radius: 6px;
  background: #fff; color: var(--c-text-2); font-size: 13px;
}
.head-actions button.primary { border: none; }
.primary {
  height: 32px; padding: 0 16px; border: none; border-radius: 6px;
  background: var(--c-primary); color: #fff; font-size: 13px;
}
.primary:disabled { opacity: 0.6; }

.filters { display: flex; gap: 8px; align-items: center; margin-bottom: 14px; }
.filters select, .filters input {
  height: 30px; padding: 0 10px; border: 1px solid var(--c-border);
  border-radius: 6px; font-size: 13px; outline: none;
}
.filters input { flex: 1; max-width: 260px; }
.total { font-size: 12px; color: var(--c-text-2); margin-left: auto; }

.empty { padding: 60px; text-align: center; color: var(--c-text-2); font-size: 13px; }
.empty .hint { font-size: 12px; color: var(--c-text-3); margin-top: 6px; }

.groups { display: flex; flex-direction: column; gap: 16px; }
.group-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.gname { font-size: 13px; font-weight: 600; }
.gcount {
  font-size: 11px; padding: 0 6px; border-radius: 8px;
  background: #eaf1ff; color: var(--c-primary);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 12px;
}
.card {
  background: #fff; border: 1px solid var(--c-border); border-radius: 8px;
  overflow: hidden; display: flex; flex-direction: column;
}
.card:hover { border-color: var(--c-primary); }
.thumb {
  position: relative; height: 130px; background: #f7f8fa;
  display: grid; place-items: center; cursor: pointer; overflow: hidden;
}
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.link-ph {
  width: 100%; height: 100%;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 6px; font-size: 22px; color: var(--c-primary); background: #f0f4ff;
}
.link-ph span { font-size: 11px; }
.kind-badge {
  position: absolute; left: 6px; top: 6px; font-size: 10px;
  padding: 1px 6px; border-radius: 8px; background: var(--c-primary); color: #fff;
}
.link-host { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.use-badge {
  position: absolute; right: 6px; top: 6px; font-size: 10px;
  padding: 1px 6px; border-radius: 8px; background: rgba(0,0,0,0.55); color: #fff;
}
.meta { padding: 8px 10px 4px; }
.name { font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.info { font-size: 10px; color: var(--c-text-3); margin-top: 2px; }
.has-text { color: var(--c-primary); }
.ops { display: flex; gap: 4px; padding: 6px 10px 10px; }
.ops button {
  flex: 1; height: 24px; border: 1px solid var(--c-border); border-radius: 4px;
  background: #fff; font-size: 11px; color: var(--c-text-2);
}
.ops button.primary-sm {
  border-color: var(--c-primary); color: var(--c-primary);
}
.ops button.danger { color: var(--c-danger); border-color: #ffc9c9; }

.send-card { display: flex; gap: 12px; margin-bottom: 16px; padding: 10px; background: #fafbfc; border-radius: 8px; }
.send-thumb { width: 80px; height: 80px; object-fit: cover; border-radius: 6px; }
.send-info { display: flex; flex-direction: column; justify-content: center; }
.send-info .sn { font-size: 13px; font-weight: 500; }
.send-info .si { font-size: 11px; color: var(--c-text-3); margin-top: 4px; }

.preview-img { width: 100%; max-height: 60vh; object-fit: contain; }

.link-preview { display: flex; flex-direction: column; gap: 8px; }
.link-preview .preview-img { max-height: 46vh; border-radius: 8px; }
.lp-title { font-size: 15px; font-weight: 600; }
.lp-desc { font-size: 13px; color: var(--c-text-2); line-height: 1.6; }
.lp-url {
  font-size: 11px; color: var(--c-primary); word-break: break-all;
  background: #f5f8ff; border-radius: 6px; padding: 6px 8px;
}
.form-tip { font-size: 11px; color: var(--c-text-3); line-height: 1.7; }

.form { display: flex; flex-direction: column; gap: 12px; }
.row { display: flex; gap: 12px; align-items: flex-start; }
.row > label { width: 72px; flex-shrink: 0; font-size: 13px; color: var(--c-text-2); padding-top: 6px; }
.row input:not([type]), .row select {
  flex: 1; height: 30px; padding: 0 10px; border: 1px solid var(--c-border);
  border-radius: 6px; font-size: 13px; outline: none;
}
</style>
