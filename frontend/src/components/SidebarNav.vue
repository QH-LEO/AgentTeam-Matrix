<script setup>
defineProps({
  menuItems: { type: Array, required: true },
  activeMenu: { type: String, required: true },
  mobileNavOpen: { type: Boolean, required: true },
  sidebarCollapsed: { type: Boolean, required: true },
});

defineEmits(["set-menu", "toggle-sidebar", "close-mobile", "reset-demo"]);

function iconPath(icon) {
  switch (icon) {
    case "flow":
      return "M6 6h4v4H6V6Zm8 0h4a2 2 0 0 1 2 2v1M6 14h4v4H6v-4Zm8 0h4v4h-4v-4ZM10 8h4m-2 2v4";
    case "decision":
      return "M12 3v4m0 10v4M5 8l3 3-3 3-3-3 3-3Zm14 0 3 3-3 3-3-3 3-3ZM9 11h6m-3-4c2.5 0 4 1.6 4 4s-1.5 4-4 4-4-1.6-4-4 1.5-4 4-4Z";
    case "bot":
      return "M9 5h6m-5 0V3m4 2V3m-7 4h10a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Zm3 6h.01M14 13h.01";
    case "spark":
      return "m12 3 1.9 4.6L18.5 9l-4.6 1.4L12 15l-1.9-4.6L5.5 9l4.6-1.4L12 3Zm-6.5 12 1 2.5L9 18l-2.5 1-.5 2.5-1-2.5L2.5 18l2.5-.5.5-2.5Zm13 0 1 2.5L22 18l-2.5 1-.5 2.5-1-2.5-2.5-.5 2.5-.5.5-2.5Z";
    case "compile":
      return "M5 4h14v5H5V4Zm0 11h14v5H5v-5Zm4-3h6m-3-3v6M8 6h.01M8 17h.01";
    default:
      return "";
  }
}
</script>

<template>
  <aside :class="['sidebar', { open: mobileNavOpen }]">
    <div class="brand-block">
      <div class="brand-mark">
        <span>MS</span>
      </div>
      <div class="brand-copy">
        <p class="brand-kicker">AgentTeam</p>
        <h1>MATRIX STUDIO</h1>
      </div>
      <button
        class="sidebar-toggle"
        type="button"
        :aria-label="sidebarCollapsed ? '展开菜单' : '收起菜单'"
        @click="$emit('toggle-sidebar')"
      >
        {{ sidebarCollapsed ? "›" : "‹" }}
      </button>
      <button class="sidebar-close" type="button" @click="$emit('close-mobile')">关闭</button>
    </div>

    <nav class="sidebar-nav">
      <button
        v-for="item in menuItems"
        :key="item.key"
        :class="['nav-item', { active: activeMenu === item.key }]"
        type="button"
        @click="$emit('set-menu', item.key)"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path :d="iconPath(item.icon)" />
        </svg>
        <span>{{ item.label }}</span>
      </button>
    </nav>

    <div class="env-card">
      <div class="env-label">当前环境</div>
      <div class="env-status">
        <span class="status-dot"></span>
        <span>Ready · Compiler Studio</span>
      </div>
      <button class="reset-link" type="button" @click="$emit('reset-demo')">恢复示例数据</button>
    </div>
  </aside>
</template>
