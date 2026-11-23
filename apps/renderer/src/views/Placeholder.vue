<script setup>
defineProps({
  title: { type: String, default: '' },
  icon: { type: String, default: '📦' },
});
</script>

<template>
  <div class="placeholder-view">
    <div class="icon">{{ icon }}</div>
    <h3>{{ title }}</h3>
    <p>该模块尚未实现，将在后续阶段接入</p>
  </div>
</template>

<style scoped>
.placeholder-view {
  flex: 1;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 8px;
  color: var(--c-text-2);
}
.icon { font-size: 44px; opacity: 0.3; }
h3 { font-size: 16px; font-weight: 600; color: var(--c-text); }
p { font-size: 13px; color: var(--c-text-3); }
</style>
