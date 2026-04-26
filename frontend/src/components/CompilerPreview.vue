<script setup>
defineProps({
  compilePreview: { type: Object, default: null },
  selectedArtifact: { type: Object, default: null },
  selectedArtifactIndex: { type: Number, required: true },
  compileIssues: { type: Array, required: true },
  preflightResult: { type: Object, default: null },
  preflightSummary: { type: Object, required: true },
  preflightChecking: { type: Boolean, required: true },
  compiling: { type: Boolean, required: true },
  applyingCompile: { type: Boolean, required: true },
  syncingDefinition: { type: Boolean, required: true },
});

defineEmits(["preview-compile", "apply-compile", "sync-definition", "run-lint", "refresh-preflight", "select-artifact"]);
</script>

<template>
  <div class="panel-section compile-section">
    <div class="section-heading">
      <p>编译预览</p>
      <span>预览将写入的 Leader、using-agentflow、SOP、Knowledge Wiki、manifest 和启动 Prompt。</span>
    </div>

    <div class="compile-actions">
      <button class="secondary-button" type="button" :disabled="compiling" @click="$emit('preview-compile')">
        {{ compiling ? "生成中..." : "生成预览" }}
      </button>
      <button class="ghost-button" type="button" :disabled="compiling" @click="$emit('run-lint')">
        运行 Lint
      </button>
      <button
        class="primary-button"
        type="button"
        :disabled="!compilePreview || applyingCompile || compileIssues.some((issue) => issue.status === 'fail')"
        @click="$emit('apply-compile')"
      >
        {{ applyingCompile ? "写入中..." : "确认写入" }}
      </button>
      <button class="ghost-button" type="button" :disabled="syncingDefinition" @click="$emit('sync-definition')">
        {{ syncingDefinition ? "同步中..." : "Sync DSL" }}
      </button>
    </div>

    <div class="toolbar-status">
      优先从全局安装目录里的 `definition.snapshot.json` 反向重建 DSL；如果没有快照记录，`Sync DSL` 会回退到全局 compiled leader 的结构化定义继续恢复。
    </div>

    <section :class="['preflight-preview-card', preflightSummary.status]">
      <div>
        <p class="run-panel-label">启动前预检</p>
        <h3>{{ preflightSummary.label }}</h3>
        <span>{{ preflightSummary.detail }}</span>
      </div>
      <button class="ghost-button" type="button" :disabled="preflightChecking" @click="$emit('refresh-preflight')">
        {{ preflightChecking ? "检查中..." : "刷新预检" }}
      </button>
      <div v-if="preflightResult?.checks?.length" class="preflight-detail-grid">
        <article
          v-for="check in preflightResult.checks"
          :key="check.id"
          :class="['run-check-card', check.status]"
        >
          <strong>{{ check.label }}</strong>
          <span>{{ check.status }}</span>
          <p>{{ check.detail }}</p>
        </article>
      </div>
    </section>

    <div v-if="compileIssues.length" class="issue-list">
      <article v-for="issue in compileIssues" :key="issue.id" :class="['issue-card', issue.status]">
        <strong>{{ issue.label }}</strong>
        <span>{{ issue.status }}</span>
        <p>{{ issue.detail }}</p>
      </article>
    </div>

    <div v-if="compilePreview" class="artifact-layout">
      <aside class="artifact-list">
        <button
          v-for="(artifact, index) in compilePreview.artifacts"
          :key="artifact.type + artifact.path"
          :class="['artifact-card', { active: selectedArtifactIndex === index, changed: artifact.changed }]"
          type="button"
          @click="$emit('select-artifact', index)"
        >
          <strong>{{ artifact.type }}</strong>
          <span>{{ artifact.changed ? "changed" : "unchanged" }}</span>
          <small>{{ artifact.path }}</small>
        </button>
      </aside>

      <section v-if="selectedArtifact" class="artifact-preview">
        <div class="preview-header inline">
          <div>
            <p class="run-panel-label">{{ selectedArtifact.type }}</p>
            <h3>{{ selectedArtifact.changed ? "即将更新" : "内容无变化" }}</h3>
            <span>{{ selectedArtifact.path }}</span>
          </div>
        </div>
        <div class="preview-grid">
          <div>
            <strong>当前文件</strong>
            <pre>{{ selectedArtifact.currentContent || "尚未生成" }}</pre>
          </div>
          <div>
            <strong>即将写入</strong>
            <pre>{{ selectedArtifact.nextContent }}</pre>
          </div>
        </div>
      </section>
    </div>

    <div v-else class="panel-empty">点击“生成预览”查看本次编译将写入哪些全局资产。</div>
  </div>
</template>
