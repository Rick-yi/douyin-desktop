<script setup>
import { api } from '../api.js';
/**
 * 文案预检组件
 *
 * 输入文本 → 实时显示评分、命中词、修改建议
 * 用于：群发创建任务、自动回复规则编辑
 */
import { ref, computed, watch } from 'vue';

const props = defineProps({
  modelValue: { type: String, default: '' },
  scene: { type: String, default: 'dm' },
  rows: { type: Number, default: 3 },
  placeholder: { type: String, default: '输入文案…' },
  showScore: { type: Boolean, default: true },
});

const emit = defineEmits(['update:modelValue', 'check']);

const text = ref(props.modelValue);
const result = ref(null);
const checking = ref(false);
const rewriting = ref(false);
const rewriteResult = ref(null);
let timer = null;

watch(
  () => props.modelValue,
  (v) => {
    if (v !== text.value) text.value = v;
  },
);

watch(text, (v) => {
  emit('update:modelValue', v);
  // 防抖检查
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => doCheck(v), 400);
});

watch(
  () => props.scene,
  () => doCheck(text.value),
);

async function doCheck(v) {
  if (!v || !v.trim()) {
    result.value = null;
    emit('check', null);
    return;
  }
  checking.value = true;
  try {
    const r = await api.sw.preview(v, props.scene);
    result.value = r;
    emit('check', r);
  } catch (e) {
    console.error('预检失败', e);
  } finally {
    checking.value = false;
  }
}

async function doRewrite() {
  if (!text.value.trim()) return;
  rewriting.value = true;
  try {
    rewriteResult.value = await api.sw.rewrite(text.value, props.scene);
  } catch (e) {
    rewriteResult.value = {
      ok: false,
      error: e.message,
      rewritten: text.value,
      changes: [],
      unresolved: [],
    };
  } finally {
    rewriting.value = false;
  }
}

function adoptRewrite() {
  const v = rewriteResult.value?.rewritten ?? '';
  rewriteResult.value = null;
  text.value = v;
  doCheck(v);
}

const scoreLevel = computed(() => result.value?.level ?? 'safe');
const blockHits = computed(() =>
  (result.value?.hits ?? []).filter((h) => h.action === 'block'),
);
const warnHits = computed(() =>
  (result.value?.hits ?? []).filter((h) => h.action !== 'block'),
);

defineExpose({ check: () => doCheck(text.value), result });
</script>

<template>
  <div class="sw-precheck">
    <textarea
      v-model="text"
      :rows="rows"
      :placeholder="placeholder"
      class="input"
      :class="{ blocked: result?.blocked }"
    />

    <div class="rewrite-row">
      <button class="rewrite-btn" :disabled="rewriting || !text.trim()" @click="doRewrite">
        {{ rewriting ? '改写中…' : '合规改写' }}
      </button>
      <span class="rewrite-tip">只做合规替换/删除，不做同音字绕过</span>
    </div>

    <div v-if="rewriteResult" class="rewrite-panel">
      <div class="rw-head">
        <span>合规改写结果</span>
        <span v-if="rewriteResult.error" class="rw-error">{{ rewriteResult.error }}</span>
        <span v-else-if="!rewriteResult.ok" class="rw-warn">仍有阻断项，需要手动删除</span>
        <span v-else class="rw-ok">可安全采用</span>
        <span v-if="rewriteResult.ok && rewriteResult.needsReview" class="rw-warn">删除位置建议通读</span>
      </div>
      <div class="rw-block">
        <div class="rw-label">改写后</div>
        <div class="rw-text">{{ rewriteResult.rewritten || '（空）' }}</div>
      </div>
      <div v-if="rewriteResult.changes?.length" class="rw-list">
        <div v-for="(c, i) in rewriteResult.changes" :key="i" class="rw-item">
          <span class="rw-word">{{ c.word }}</span>
          <span class="rw-arrow">→</span>
          <span class="rw-to">{{ c.action === 'remove' ? '删除' : c.to }}</span>
          <span v-if="c.category" class="rw-cat">{{ c.category }}</span>
        </div>
      </div>
      <div v-if="rewriteResult.unresolved?.length" class="rw-unresolved">
        <div v-for="(u, i) in rewriteResult.unresolved" :key="i">
          需人工：{{ u.word }}（{{ u.message || u.category || '' }}）
        </div>
      </div>
      <div class="rw-actions">
        <button class="rw-apply" :disabled="!rewriteResult.ok" @click="adoptRewrite">采用改写</button>
        <button class="rw-cancel" @click="rewriteResult = null">取消</button>
      </div>
    </div>

    <div v-if="result && result.hits.length" class="result" :class="scoreLevel">
      <div class="head">
        <span class="score" v-if="showScore">
          {{ result.score }} 分
          <span class="label">{{ scoreLevel === 'safe' ? '安全' : scoreLevel === 'risk' ? '有风险' : '高危' }}</span>
        </span>
        <span v-if="result.blocked" class="blocked-tag">🚫 含阻断词，无法发送</span>
      </div>

      <div class="hits">
        <div v-for="h in blockHits" :key="h.wordId" class="hit block">
          <span class="word">{{ h.word }}</span>
          <span class="group">{{ h.group || '' }}</span>
          <span class="msg">{{ h.message || '阻断' }}</span>
        </div>
        <div v-for="h in warnHits" :key="h.wordId" class="hit warn">
          <span class="word">{{ h.word }}</span>
          <span class="group">{{ h.group || '' }}</span>
          <span class="msg">{{ h.message || '建议修改' }}</span>
        </div>
      </div>

      <div v-if="result.replaced !== text" class="replaced">
        将替换为：{{ result.replaced }}
      </div>
    </div>

    <div v-else-if="result && !result.hits.length && text.trim()" class="result safe">
      <span class="ok">✓ 未发现敏感词</span>
    </div>
  </div>
</template>

<style scoped>
.sw-precheck { display: flex; flex-direction: column; gap: 6px; }
.input {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  font-size: 13px;
  font-family: inherit;
  outline: none;
  resize: vertical;
}
.input:focus { border-color: var(--c-primary); }
.input.blocked { border-color: var(--c-danger); background: #fff8f7; }

.result {
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12px;
  border: 1px solid var(--c-border);
  background: #fafbfc;
}
.result.risk { border-color: #ffd8a8; background: #fffbf5; }
.result.danger { border-color: #ffc9c9; background: #fff8f7; }
.result.safe { border-color: #c3e9d0; background: #f6fdf8; }

.head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.score { font-weight: 600; font-size: 14px; }
.score .label { font-weight: 400; font-size: 11px; margin-left: 4px; opacity: 0.75; }
.result.risk .score { color: #b76e00; }
.result.danger .score { color: var(--c-danger); }
.result.safe .score { color: #1a7f37; }
.blocked-tag { color: var(--c-danger); font-weight: 500; }
.ok { color: #1a7f37; }

.hits { display: flex; flex-direction: column; gap: 3px; }
.hit { display: flex; gap: 8px; align-items: baseline; }
.hit .word {
  font-weight: 500;
  padding: 0 5px;
  border-radius: 3px;
  background: #f0f1f4;
  white-space: nowrap;
}
.hit.block .word { background: #ffece9; color: #d4380d; }
.hit.warn .word { background: #fff4e5; color: #b76e00; }
.hit .group { color: var(--c-text-3); font-size: 11px; white-space: nowrap; }
.hit .msg { color: var(--c-text-2); }

.replaced {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--c-border);
  color: var(--c-text-2);
  word-break: break-all;
}

.rewrite-row { display: flex; align-items: center; gap: 8px; }
.rewrite-btn {
  height: 26px; padding: 0 12px; border: 1px solid var(--c-primary);
  border-radius: 5px; background: #f0f6ff; color: var(--c-primary);
  font-size: 12px; cursor: pointer;
}
.rewrite-btn:disabled { opacity: 0.55; cursor: default; }
.rewrite-tip { font-size: 11px; color: var(--c-text-3); }

.rewrite-panel {
  border: 1px solid #cddcf7; background: #f7faff; border-radius: 6px;
  padding: 9px 10px; font-size: 12px;
}
.rw-head {
  display: flex; align-items: center; gap: 8px; margin-bottom: 7px;
  font-weight: 600; color: #2f5f9f;
}
.rw-ok { font-weight: 400; color: #1a7f37; font-size: 11px; }
.rw-warn { font-weight: 400; color: #b76e00; font-size: 11px; }
.rw-error { font-weight: 400; color: var(--c-danger); font-size: 11px; }
.rw-block { background: #fff; border: 1px solid #e2e9f5; border-radius: 5px; padding: 7px 8px; }
.rw-label { font-size: 11px; color: var(--c-text-3); margin-bottom: 4px; }
.rw-text { color: var(--c-text-1); line-height: 1.7; word-break: break-all; }
.rw-list { margin-top: 7px; display: flex; flex-direction: column; gap: 3px; }
.rw-item { display: flex; align-items: baseline; gap: 6px; }
.rw-word {
  padding: 0 5px; border-radius: 3px; background: #ffece9; color: #d4380d;
}
.rw-arrow { color: var(--c-text-3); }
.rw-to { color: #1a7f37; }
.rw-cat { color: var(--c-text-3); font-size: 11px; }
.rw-unresolved {
  margin-top: 7px; padding: 6px 8px; border-radius: 5px;
  background: #fff7e8; color: #9a6a12; font-size: 11px; line-height: 1.6;
}
.rw-actions { display: flex; gap: 8px; margin-top: 8px; }
.rw-apply, .rw-cancel {
  height: 26px; padding: 0 12px; border-radius: 5px; font-size: 12px; cursor: pointer;
}
.rw-apply { border: none; background: var(--c-primary); color: #fff; }
.rw-apply:disabled { opacity: 0.5; cursor: default; }
.rw-cancel { border: 1px solid var(--c-border); background: #fff; color: var(--c-text-2); }
</style>
