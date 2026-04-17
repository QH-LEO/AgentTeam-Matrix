<script setup>
defineProps({
  currentMenuLabel: { type: String, required: true },
  selectedPipeline: { type: Object, default: null },
  stageStats: { type: Object, required: true },
  runStarting: { type: Boolean, required: true },
  compiling: { type: Boolean, required: true },
  preflightSummary: { type: Object, required: true },
  preflightChecking: { type: Boolean, required: true },
});

defineEmits(["open-mobile", "start-run", "preview-compile", "toggle-preflight"]);
</script>

<template>
  <header class="workspace-header">
    <div class="header-main">
      <button class="mobile-menu" type="button" @click="$emit('open-mobile')">菜单</button>
      <div>
        <p class="header-kicker">Pipeline Studio</p>
        <h2>{{ currentMenuLabel }}</h2>
        <p class="header-subtitle">可视化配置流水线、Agent 组织、SOP 动作和编译产物。</p>
      </div>
      <div class="pipeline-pill">
        <span>当前流水线</span>
        <strong>{{ selectedPipeline ? selectedPipeline.name : "未选择" }}</strong>
      </div>
    </div>

    <div class="header-actions">
      <button
        :class="['preflight-status-card', preflightSummary.status]"
        type="button"
        :disabled="preflightChecking"
        @click="$emit('toggle-preflight')"
      >
        <span>环境检查</span>
        <strong>{{ preflightSummary.label }}</strong>
        <small>{{ preflightSummary.detail }}</small>
      </button>
      <div class="header-metrics">
        <div class="header-stat">
          <span>阶段</span>
          <strong>{{ stageStats.stageCount }}</strong>
        </div>
        <div class="header-stat">
          <span>Action</span>
          <strong>{{ stageStats.actionCount }}</strong>
        </div>
        <div class="header-stat">
          <span>Agent</span>
          <strong>{{ stageStats.agentCount }}</strong>
        </div>
        <div class="header-stat">
          <span>Skill</span>
          <strong>{{ stageStats.skillCount }}</strong>
        </div>
        <div class="header-stat">
          <span>Depth</span>
          <strong>{{ stageStats.depth }}</strong>
        </div>
      </div>
      <button class="primary-button" type="button" :disabled="runStarting" @click="$emit('start-run')">
        {{ runStarting ? "启动中..." : "运行流程" }}
      </button>
      <button class="secondary-button" type="button" :disabled="compiling" @click="$emit('preview-compile')">
        {{ compiling ? "编译中..." : "编译预览" }}
      </button>
    </div>
  </header>
</template>
