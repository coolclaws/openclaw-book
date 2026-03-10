<script setup lang="ts">
import { ref, onMounted } from 'vue'

const collapsed = ref(false)

onMounted(() => {
  const saved = localStorage.getItem('sidebar-collapsed')
  if (saved === 'true') {
    collapsed.value = true
    document.documentElement.classList.add('sidebar-hidden')
  }
})

function toggle() {
  collapsed.value = !collapsed.value
  if (collapsed.value) {
    document.documentElement.classList.add('sidebar-hidden')
    localStorage.setItem('sidebar-collapsed', 'true')
  } else {
    document.documentElement.classList.remove('sidebar-hidden')
    localStorage.setItem('sidebar-collapsed', 'false')
  }
}
</script>

<template>
  <button
    class="sidebar-toggle-btn"
    :title="collapsed ? '展开侧边栏' : '收起侧边栏'"
    @click="toggle"
  >
    <svg
      v-if="!collapsed"
      xmlns="http://www.w3.org/2000/svg"
      width="16" height="16"
      viewBox="0 0 24 24"
      fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    >
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <path d="M9 3v18"/>
      <path d="m14 9-3 3 3 3"/>
    </svg>
    <svg
      v-else
      xmlns="http://www.w3.org/2000/svg"
      width="16" height="16"
      viewBox="0 0 24 24"
      fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    >
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <path d="M9 3v18"/>
      <path d="m10 9 3 3-3 3"/>
    </svg>
  </button>
</template>

<style>
.sidebar-toggle-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--vp-c-text-2);
  cursor: pointer;
  transition: background 0.2s, color 0.2s;
  margin-right: 4px;
}

.sidebar-toggle-btn:hover {
  background: var(--vp-c-default-soft);
  color: var(--vp-c-text-1);
}

/* 隐藏 sidebar 时的样式 */
.sidebar-hidden .VPSidebar {
  transform: translateX(-100%);
  width: 0 !important;
  min-width: 0 !important;
  overflow: hidden;
}

.sidebar-hidden .VPContent.has-sidebar {
  padding-left: 0 !important;
  margin-left: 0 !important;
}

.sidebar-hidden .VPDoc.has-sidebar .container {
  max-width: 900px !important;
}

/* 过渡动画 */
.VPSidebar {
  transition: transform 0.25s ease, width 0.25s ease;
}

.VPContent {
  transition: padding-left 0.25s ease;
}

/* 只在桌面端（>= 960px）显示按钮 */
@media (max-width: 959px) {
  .sidebar-toggle-btn {
    display: none;
  }
}
</style>
