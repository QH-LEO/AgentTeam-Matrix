<script setup>
defineProps({
  currentRun: { type: Object, default: null },
  requirementText: { type: String, required: true },
  launchMode: { type: String, required: true },
  launchPreview: { type: Object, default: null },
  activePreflightChecks: { type: Array, required: true },
  launchStatus: { type: String, required: true },
  launchingITerm: { type: Boolean, required: true },
});

defineEmits([
  "back",
  "stop-run",
  "open-iterm",
  "refresh-launch-preview",
  "update-requirement",
  "update-launch-mode",
]);
</script>

<template>
  <main class="workspace run-workspace">
    <header class="workspace-header run-header">
      <div class="header-main">
        <div>
          <p class="header-kicker">Run Console</p>
          <h2>{{ currentRun?.pipeline?.name || "运行控制台" }}</h2>
        </div>
        <div class="pipeline-pill">
          <span>Run ID</span>
          <strong>{{ currentRun?.runId }}</strong>
        </div>
        <div class="pipeline-pill">
          <span>状态</span>
          <strong>{{ currentRun?.status }}</strong>
        </div>
      </div>
      <div class="header-actions">
        <button class="ghost-button" type="button" @click="$emit('back')">返回编排</button>
        <button class="primary-button danger-button" type="button" @click="$emit('stop-run')">停止记录</button>
      </div>
    </header>

    <div class="run-console">
      <aside class="run-stage-panel">
        <p class="run-panel-label">阶段进度</p>
        <div
          v-for="(stage, index) in currentRun?.pipeline?.stages || []"
          :key="stage.id || stage.name"
          class="run-stage-card"
        >
          <span>{{ index + 1 }}</span>
          <div>
            <strong>{{ stage.name }}</strong>
            <p>{{ stage.agents.length }} Agent · {{ stage.actions.length }} Action</p>
          </div>
        </div>
      </aside>

      <section class="terminal-panel launch-panel">
        <p class="run-panel-label">启动预览</p>
        <h3>打开 iTerm2 并启动 Claude Team Leader</h3>
        <p>
          系统会在 iTerm2 中进入项目目录，然后执行
          <code>claude --agent {{ currentRun?.pipeline?.leaderAgentName }}</code>。
          页面不会内嵌 terminal，Claude 运行仍在本地 iTerm2。
        </p>
        <div class="launch-command-preview">
          <span>项目目录</span>
          <strong>{{ launchPreview?.resolvedProjectPath || currentRun?.pipeline?.projectPath }}</strong>
          <span>Claude Agent</span>
          <strong>{{ currentRun?.pipeline?.leaderAgentName }}</strong>
          <span>启动模式</span>
          <strong>{{ launchMode }}</strong>
        </div>

        <div class="mode-switcher">
          <button
            v-for="mode in ['single-leader', 'suggest-team', 'force-team']"
            :key="mode"
            :class="['mode-chip', { active: launchMode === mode }]"
            type="button"
            @click="$emit('update-launch-mode', mode)"
          >
            {{ mode }}
          </button>
        </div>

        <div v-if="activePreflightChecks.length" class="run-checks">
          <div class="section-heading tight">
            <p>启动前检查</p>
            <span>失败项会阻止运行，警告项会保留在这里供确认。</span>
          </div>
          <div
            v-for="check in activePreflightChecks"
            :key="check.id"
            :class="['run-check-card', check.status]"
          >
            <strong>{{ check.label }}</strong>
            <span>{{ check.status }}</span>
            <p>{{ check.detail }}</p>
          </div>
        </div>

        <div v-if="launchPreview" class="prompt-preview">
          <div class="section-heading tight">
            <p>Launch Prompt</p>
            <span>{{ launchPreview.leaderAgentName }} · {{ launchPreview.launchMode }}</span>
          </div>
          <pre>{{ launchPreview.prompt }}</pre>
        </div>

        <div class="run-action-row">
          <button class="ghost-button" type="button" @click="$emit('refresh-launch-preview')">刷新 Prompt</button>
        </div>
        <div class="toolbar-status">{{ launchStatus }}</div>
      </section>

      <aside class="requirement-panel">
        <p class="run-panel-label">需求输入</p>
        <textarea
          :value="requirementText"
          rows="8"
          placeholder="输入需求，例如：实现手机号验证码登录，包含发送验证码、登录态和失败提示。"
          @input="$emit('update-requirement', $event.target.value)"
        ></textarea>
        <button class="primary-button launch-button" type="button" :disabled="launchingITerm" @click="$emit('open-iterm')">
          {{ launchingITerm ? "启动中..." : "一键启动" }}
        </button>
        <div class="requirement-tip">
          需求会作为 Claude 启动 prompt 的一部分传入 iTerm2；如需先查看最终 prompt，可在左侧刷新预览。
        </div>
      </aside>
    </div>
  </main>
</template>
