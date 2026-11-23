<script setup>
defineProps({
  modelValue: { type: String, required: true },
  menus: { type: Array, required: true },
});
const emit = defineEmits(['update:modelValue']);
</script>

<template>
  <nav class="icon-nav">
    <div class="logo" title="闪拓">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M13.2 2 4.8 13.4h5.1L9.2 22l8.2-11.8h-5.2L13.2 2Z" fill="#fff" />
      </svg>
    </div>
    <button
      v-for="m in menus"
      :key="m.key"
      class="nav-item"
      :class="{ active: modelValue === m.key }"
      :title="m.label"
      @click="emit('update:modelValue', m.key)"
    >
      <span class="ico">{{ m.icon }}</span>
      <span class="label">{{ m.label }}</span>
    </button>
  </nav>
</template>

<style scoped>
.icon-nav {
  width: 76px;
  flex-shrink: 0;
  background: #fbfbfc;
  border-right: 1px solid var(--c-border);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 10px 0;
  overflow-y: auto;
  overflow-x: hidden;
}
.logo {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: linear-gradient(135deg, #22d3ee 0%, #6366f1 55%, #a855f7 100%);
  box-shadow: 0 3px 10px rgba(99, 102, 241, 0.28);
  display: grid;
  place-items: center;
  margin-bottom: 14px;
  flex-shrink: 0;
}
.logo svg { width: 21px; height: 21px; display: block; }
.nav-item {
  width: 64px;
  border: none;
  background: transparent;
  color: var(--c-text-2);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 8px 2px;
  margin-bottom: 2px;
  border-radius: 8px;
  transition: background 0.15s, color 0.15s;
}
.nav-item:hover {
  background: #f0f1f4;
}
.nav-item.active {
  background: var(--c-primary-light);
  color: var(--c-primary);
}
.ico {
  font-size: 18px;
  line-height: 1;
}
.label {
  font-size: 11px;
  line-height: 1.2;
  white-space: nowrap;
}
</style>
