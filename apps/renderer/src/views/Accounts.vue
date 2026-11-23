<script setup>
import { api } from '../api.js';
import { ref, onMounted, onUnmounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

const props = defineProps({
  accounts: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
});
const emit = defineEmits(['refresh-accounts']);

// ── 登录状态（SDK 直连，二维码直接是 base64）──
// idle | starting | qr_ready | scanned | confirmed | verification | online | done | error
const dialogVisible = ref(false);
const stage = ref('idle');
const qrImage = ref('');
const errorMsg = ref('');
const elapsed = ref(0);
const statusHint = ref('');
const loginMethod = ref('qr');
const loginMobile = ref('');
const loginPassword = ref('');
const smsCode = ref('');
const smsHint = ref('');
const loginAccounts = ref([]);
let tickTimer = null;
const unsubs = [];

const stageText = {
  idle: '',
  method_form: '选择登录方式',
  starting: '正在启动登录…',
  qr_ready: '请用抖音 App 扫码',
  scanned: '已扫码，请在手机上确认',
  confirmed: '正在登录…',
  verification: '需要在浏览器完成安全验证',
  sms_code: '请输入短信验证码',
  voice_code: '请输入语音验证码',
  sms_required: '需要短信验证',
  account_select: '选择要登录的账号',
  online: '已上线，正在加载联系人…',
  done: '登录成功',
  error: '出错了',
};

function openMethodForm(method) {
  loginMethod.value = method;
  stage.value = 'method_form';
  errorMsg.value = '';
  qrImage.value = '';
  smsCode.value = '';
  smsHint.value = '';
}

async function startLogin(method = 'qr') {
  // 防止模板直接绑定 @click="startLogin" 时把 MouseEvent 当成登录方式
  if (typeof method !== 'string' || !['qr', 'sms', 'password'].includes(method)) method = 'qr';
  if (method !== 'qr' && !loginMobile.value.trim()) {
    ElMessage.error('请输入手机号');
    stage.value = 'method_form';
    return;
  }
  if (method === 'password' && !loginPassword.value) {
    ElMessage.error('请输入密码');
    stage.value = 'method_form';
    return;
  }
  loginMethod.value = method;
  dialogVisible.value = true;
  stage.value = 'starting';
  qrImage.value = '';
  errorMsg.value = '';
  statusHint.value = '';
  smsCode.value = '';
  smsHint.value = '';
  loginAccounts.value = [];
  elapsed.value = 0;
  startTick();
  try {
    const r = await api.login.start({
      method,
      mobile: loginMobile.value.trim(),
      password: loginPassword.value,
    });
    if (!r?.ok) {
      stage.value = 'error';
      errorMsg.value = r?.error || '启动登录失败';
      stopTick();
    }
  } catch (e) {
    stage.value = 'error';
    errorMsg.value = e.message || String(e);
    stopTick();
  }
}

function startTick() {
  stopTick();
  tickTimer = setInterval(() => { elapsed.value++; }, 1000);
}
function stopTick() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
}

async function requestSms(kind = 'sms') {
  const r = await api.login.requestSms(kind);
  if (r.ok) {
    smsHint.value = kind === 'voice' ? '语音验证码已请求，请注意接听' : '验证码已发送';
  } else {
    ElMessage.error(r.error || '获取验证码失败');
  }
}

async function submitSmsCode() {
  const r = await api.login.submitSms(smsCode.value);
  if (r.ok) {
    smsHint.value = '验证码已提交，正在登录…';
  } else {
    ElMessage.error(r.error || '验证码提交失败');
  }
}

async function selectLoginAccount(acc) {
  const r = await api.login.selectAccount({ secUid: acc.secUid });
  if (!r.ok) ElMessage.error(r.error || '选择账号失败');
}

function bindEvents() {
  unsubs.push(
    api.on('login:qr', ({ base64 }) => {
      qrImage.value = `data:image/png;base64,${base64}`;
      stage.value = 'qr_ready';
    }),
  );
  unsubs.push(
    api.on('login:status', (p) => {
      const s = p?.status;
      if ([
        'qr_ready', 'scanned', 'confirmed', 'verification', 'online',
        'sms_code', 'voice_code', 'sms_required', 'account_select',
      ].includes(s)) {
        stage.value = s;
      } else if (s === 'expired') {
        statusHint.value = '二维码已过期，正在刷新…';
      }
      if (p?.screenName) statusHint.value = `欢迎，${p.screenName}`;
      if (p?.methods) statusHint.value = `验证方式：${p.methods.join(', ')}`;
    }),
  );
  unsubs.push(
    api.on('login:sms', (p) => {
      smsHint.value = `验证码已发送到 ${p?.maskedMobile || p?.mobile || '手机'}`;
      stage.value = 'sms_code';
    }),
  );
  unsubs.push(
    api.on('login:voice', (p) => {
      smsHint.value = `语音验证码已发送到 ${p?.maskedMobile || p?.mobile || '手机'}`;
      stage.value = 'voice_code';
    }),
  );
  unsubs.push(
    api.on('login:sms-required', (p) => {
      smsHint.value = p?.reason || '需要短信验证';
      stage.value = 'sms_required';
    }),
  );
  unsubs.push(
    api.on('login:accounts', (p) => {
      loginAccounts.value = p?.accounts ?? [];
      stage.value = 'account_select';
    }),
  );
  unsubs.push(
    api.on('login:error', ({ error }) => {
      stage.value = 'error';
      errorMsg.value = error || '登录失败';
      stopTick();
    }),
  );
  unsubs.push(
    api.on('login:done', (p) => {
      stage.value = 'done';
      stopTick();
      const name = p?.account?.nickname || p?.account?.uid || '账号';
      const c = p?.contacts;
      ElMessage.success(
        c ? `已添加「${name}」，同步 ${c.total} 个联系人` : `已添加「${name}」`,
      );
      emit('refresh-accounts');
      setTimeout(() => (dialogVisible.value = false), 1200);
    }),
  );
}

function closeDialog() {
  stopTick();
  if (stage.value !== 'done' && stage.value !== 'idle') {
    api.login.cancel().catch(() => {});
  }
  dialogVisible.value = false;
  stage.value = 'idle';
}

onMounted(bindEvents);
onUnmounted(() => {
  stopTick();
  for (const u of unsubs) u();
});

// ── 账号操作 ──
async function toggleEnabled(a) {
  await api.account.update(a.id, { enabled: a.enabled ? 0 : 1 });
  emit('refresh-accounts');
}

async function removeAccount(a) {
  try {
    await ElMessageBox.confirm(
      `确定删除账号「${a.nickname || a.uid}」？本地会话和消息也会一并删除。`,
      '删除账号',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
    await api.account.delete(a.id);
    ElMessage.success('已删除');
    emit('refresh-accounts');
  } catch {
    // 用户取消
  }
}

async function openDebug(a) {
  await api.pool.showDebug(a.id);
  ElMessage.info('已把浏览器显示到前台，看完可在设置里隐藏');
}
async function hideDebug(a) {
  await api.pool.hideDebug(a.id);
}

async function reconnect(a) {
  const r = await api.account.reconnect(a.id);
  if (r.ok) {
    ElMessage.success('已重新连接');
  } else {
    ElMessage.error(r.error || '重连失败');
  }
  emit('refresh-accounts');
}

function avatarFailed(a) {
  a.avatar_local_url = '';
  a.avatar_url = '';
}

function health(a) {
  if (a.conn_state === 'online') return { text: '在线', type: 'success' };
  if (a.conn_state === 'reconnecting') return { text: '重连中', type: 'warning' };
  if (a.conn_state === 'expired' || a.status === 'expired') {
    return { text: '登录已失效', type: 'danger' };
  }
  if (a.conn_state === 'offline') return { text: '离线', type: 'info' };
  if (a.risk_level === 'warning') return { text: '有风控提示', type: 'warning' };
  if (a.status === 'warm' || a.status === 'hot') return { text: '正常', type: 'success' };
  return { text: '未登录', type: 'info' };
}
</script>

<template>
  <div class="accounts-view">
    <header class="page-head">
      <h2>账号管理</h2>
      <button class="primary" @click="startLogin('qr')">＋ 添加账号</button>
    </header>

    <div class="list">
      <div v-if="loading" class="empty">加载中…</div>
      <div v-else-if="!accounts.length" class="empty">
        <p>还没有账号</p>
        <p class="hint">点右上角「添加账号」，用抖音 App 扫码</p>
      </div>

      <div v-for="a in accounts" :key="a.id" class="card" :class="{ disabled: !a.enabled }">
        <img
          v-if="a.avatar_local_url || a.avatar_url"
          class="avatar"
          :src="a.avatar_local_url || a.avatar_url"
          referrerpolicy="no-referrer"
          @error="avatarFailed(a)"
        />
        <div v-else class="avatar placeholder">{{ (a.nickname || '?').slice(0, 1) }}</div>

        <div class="info">
          <div class="line1">
            <span class="name">{{ a.nickname || '未命名' }}</span>
            <span v-if="a.is_verified" class="tag v">蓝V</span>
            <span class="tag" :class="health(a).type">{{ health(a).text }}</span>
            <span v-if="!a.enabled" class="tag info">已停用</span>
          </div>
          <div class="line2">
            抖音号：{{ a.douyin_id || '—' }}
            <span class="sep">|</span>
            UID：{{ a.uid || '—' }}
          </div>
          <div class="line3">
            <span>登录 {{ a.session_days || 0 }} 天</span>
            <span class="sep">·</span>
            <span>能力：文字 ✓</span>
            <span class="sep">·</span>
            <span :class="{ muted: !a.can_send_image }">
              图片 {{ a.can_send_image ? '✓' : '未校准' }}
            </span>
            <span class="sep">·</span>
            <span :class="{ muted: !a.can_send_emoji }">
              表情 {{ a.can_send_emoji ? '✓' : '未校准' }}
            </span>
          </div>
        </div>

        <div class="actions">
          <el-button
            v-if="a.conn_state === 'offline' || a.conn_state === 'reconnecting'"
            size="small"
            type="primary"
            plain
            @click="reconnect(a)"
          >重连</el-button>
          <el-button size="small" @click="openDebug(a)">显示浏览器</el-button>
          <el-button size="small" @click="hideDebug(a)">隐藏</el-button>
          <el-button size="small" @click="toggleEnabled(a)">
            {{ a.enabled ? '停用' : '启用' }}
          </el-button>
          <el-button size="small" type="danger" plain @click="removeAccount(a)">删除</el-button>
        </div>
      </div>
    </div>

    <!-- 扫码登录弹窗（SDK 直连，二维码直接显示 base64） -->
    <el-dialog
      v-model="dialogVisible"
      title="添加抖音账号"
      width="440px"
      :close-on-click-modal="false"
      @close="closeDialog"
    >
      <div class="login-box">
        <p class="stage" :class="stage">{{ stageText[stage] }}</p>

        <div v-if="qrImage && (stage === 'qr_ready' || stage === 'scanned')" class="qr-wrap">
          <img :src="qrImage" alt="登录二维码" :class="{ dim: stage === 'scanned' }" />
          <div v-if="stage === 'scanned'" class="qr-mask">已扫码</div>
        </div>

        <div
          v-else-if="stage === 'starting' || stage === 'confirmed' || stage === 'online'"
          class="qr-wrap loading"
        >
          <div class="spinner"></div>
          <span>{{ stageText[stage] }}</span>
        </div>

        <div v-else-if="stage === 'method_form'" class="login-form">
          <div class="lf-row">
            <label>手机号</label>
            <input v-model="loginMobile" placeholder="抖音绑定手机号" />
          </div>
          <div v-if="loginMethod === 'password'" class="lf-row">
            <label>密码</label>
            <input v-model="loginPassword" type="password" placeholder="抖音密码" />
          </div>
          <button class="lf-primary" @click="startLogin(loginMethod)">
            {{ loginMethod === 'password' ? '密码登录' : '短信登录' }}
          </button>
        </div>

        <div
          v-else-if="['sms_code', 'voice_code', 'sms_required'].includes(stage)"
          class="login-form"
        >
          <p class="lf-hint">{{ smsHint || '请输入验证码' }}</p>
          <input v-model="smsCode" placeholder="短信验证码" />
          <div class="lf-actions">
            <button @click="requestSms('sms')">获取验证码</button>
            <button @click="requestSms('voice')">语音验证码</button>
            <button class="lf-primary" @click="submitSmsCode">提交</button>
          </div>
        </div>

        <div v-else-if="stage === 'account_select'" class="login-accounts">
          <p class="lf-hint">同一手机号下有多个账号，请选择：</p>
          <button
            v-for="acc in loginAccounts"
            :key="acc.secUid"
            class="la-item"
            @click="selectLoginAccount(acc)"
          >
            <span class="la-name">{{ acc.nickname || acc.douyinId || acc.uid || acc.secUid }}</span>
            <span v-if="acc.isMainAccount" class="la-tag">主账号</span>
          </button>
          <p v-if="!loginAccounts.length" class="lf-hint">没有可选账号</p>
        </div>

        <div v-else-if="stage === 'verification'" class="qr-wrap notice">
          <span class="icon">🔐</span>
          <p>{{ statusHint || '请在弹出的窗口完成验证' }}</p>
        </div>

        <div v-else-if="stage === 'done'" class="qr-wrap done">✓</div>

        <div v-else-if="stage === 'error'" class="qr-wrap error">
          <p>{{ errorMsg }}</p>
        </div>

        <p v-if="elapsed > 0 && stage !== 'done' && stage !== 'error'" class="elapsed">
          已等待 {{ elapsed }} 秒
        </p>

        <div class="tips">
          <p>1. 打开抖音 App → 右上角「扫一扫」</p>
          <p>2. 扫码后在手机上确认登录</p>
          <p>3. 二维码约 3 分钟过期，会自动刷新</p>
        </div>
        <p class="tip warn">
          首次在新设备登录，平台可能要求短信或滑块验证，请按提示完成。
        </p>

        <div class="login-methods">
          <span>其他方式：</span>
          <button @click="openMethodForm('sms')">短信登录</button>
          <button @click="openMethodForm('password')">密码登录</button>
          <button v-if="stage !== 'qr_ready' && stage !== 'scanned'" @click="startLogin('qr')">
            扫码登录
          </button>
        </div>
      </div>

      <template #footer>
        <el-button @click="closeDialog">
          {{ stage === 'done' ? '关闭' : '取消' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>


<style scoped>
.accounts-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 18px 22px;
  overflow-y: auto;
}
.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.page-head h2 {
  font-size: 18px;
  font-weight: 600;
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
.primary:hover { opacity: 0.9; }
.list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.empty {
  padding: 60px 20px;
  text-align: center;
  color: var(--c-text-2);
}
.empty .hint {
  font-size: 12px;
  color: var(--c-text-3);
  margin-top: 6px;
}
.card {
  display: flex;
  gap: 14px;
  align-items: center;
  padding: 14px 16px;
  background: #fff;
  border: 1px solid var(--c-border);
  border-radius: 10px;
}
.card.disabled { opacity: 0.55; }
.avatar {
  width: 46px;
  height: 46px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}
.avatar.placeholder {
  display: grid;
  place-items: center;
  background: #e3e5e9;
  color: var(--c-text-2);
  font-size: 18px;
}
.info { flex: 1; min-width: 0; }
.line1 {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.name { font-size: 15px; font-weight: 600; }
.tag {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background: #f0f1f4;
  color: var(--c-text-2);
}
.tag.v { background: #fff3e0; color: #e67700; }
.tag.success { background: #e8f8ee; color: #1a7f37; }
.tag.warning { background: #fff4e5; color: #b76e00; }
.tag.danger { background: #ffece9; color: #d4380d; }
.tag.info { background: #f0f1f4; color: var(--c-text-2); }
.line2, .line3 {
  font-size: 12px;
  color: var(--c-text-2);
  margin-top: 4px;
}
.sep { margin: 0 6px; color: var(--c-text-3); }
.muted { color: var(--c-text-3); }
.actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
.login-progress {
  text-align: center;
  padding: 10px 0 6px;
}
.stage-icon {
  font-size: 40px;
  line-height: 1;
  margin-bottom: 14px;
}
.stage-icon.done { color: var(--c-online); }
.stage-icon.error { color: var(--c-danger); }
.stage-icon.opening,
.stage-icon.waiting,
.stage-icon.committing {
  animation: pulse 1.6s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}
.stage {
  font-size: 15px;
  font-weight: 500;
  margin-bottom: 6px;
}
.elapsed {
  font-size: 12px;
  color: var(--c-text-3);
  margin-bottom: 10px;
}
.err {
  font-size: 13px;
  color: var(--c-danger);
  margin: 8px 0;
}
.tips {
  margin-top: 18px;
  padding: 12px 14px;
  background: #fafbfc;
  border-radius: 8px;
  text-align: left;
}
.tips p {
  font-size: 12px;
  color: var(--c-text-2);
  line-height: 1.9;
}
.tip.warn {
  margin-top: 12px;
  font-size: 12px;
  color: var(--c-warn);
  line-height: 1.7;
}

/* 二维码：SDK 返回的图可能是 500px，必须限制显示尺寸 */
.qr-wrap {
  position: relative;
  width: 220px;
  min-height: 220px;
  margin: 10px auto;
  display: grid;
  place-items: center;
  text-align: center;
}
.qr-wrap img {
  width: 220px;
  height: 220px;
  display: block;
  border-radius: 8px;
  background: #fff;
}
.qr-wrap img.dim { opacity: 0.25; }
.qr-mask {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #1a7f37;
  font-size: 15px;
  font-weight: 600;
}
.spinner {
  width: 26px;
  height: 26px;
  margin-bottom: 10px;
  border: 3px solid #e3e8ef;
  border-top-color: var(--c-primary);
  border-radius: 50%;
  animation: qrspin 1s linear infinite;
}
@keyframes qrspin { to { transform: rotate(360deg); } }

.login-form { display: flex; flex-direction: column; gap: 8px; padding: 8px 4px 4px; }
.lf-row { display: flex; align-items: center; gap: 8px; }
.lf-row label { width: 48px; font-size: 12px; color: var(--c-text-2); flex-shrink: 0; }
.lf-row input, .login-form > input {
  flex: 1;
  height: 32px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  padding: 0 10px;
  font-size: 13px;
  outline: none;
}
.lf-row input:focus, .login-form > input:focus { border-color: var(--c-primary); }
.lf-hint { font-size: 11px; color: var(--c-text-2); margin: 2px 0; line-height: 1.5; }
.lf-actions { display: flex; gap: 6px; }
.lf-actions button, .lf-primary {
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  background: #fff;
  color: var(--c-text);
  font-size: 12px;
}
.lf-primary { border-color: var(--c-primary); background: var(--c-primary); color: #fff; }
.login-accounts { display: flex; flex-direction: column; gap: 6px; padding: 8px 4px; }
.la-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  background: #fff;
  text-align: left;
}
.la-item:hover { border-color: var(--c-primary); background: #f7faff; }
.la-name { font-size: 13px; color: var(--c-text); }
.la-tag { font-size: 10px; color: var(--c-primary); background: #eef3ff; padding: 1px 5px; border-radius: 3px; }
.login-methods {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px dashed var(--c-border);
  font-size: 11px;
  color: var(--c-text-3);
}
.login-methods button {
  border: none;
  background: transparent;
  color: var(--c-primary);
  font-size: 11px;
  padding: 0;
}
</style>
