<script setup>
defineProps({
  selectedPipeline: { type: Object, default: null },
  focusedStageId: { type: String, required: true },
  focusedAgentId: { type: String, required: true },
  activeMenu: { type: String, required: true },
  flowPaths: { type: Array, required: true },
  readonly: { type: Boolean, default: false },
});

defineEmits(["focus-stage", "focus-agent"]);
</script>

<template>
  <section class="canvas-panel">
    <div class="canvas-grid"></div>
    <div class="canvas-mode-label">
      <strong>{{ readonly ? "定位预览" : "流程画布" }}</strong>
      <span>{{ readonly ? "点击节点切换编辑对象" : "点击节点聚焦阶段和 Agent" }}</span>
    </div>
    <div v-if="selectedPipeline" class="canvas-flow">
      <div v-if="selectedPipeline.stages.length" class="stage-lane">
        <template v-for="(stage, index) in selectedPipeline.stages" :key="stage.id">
          <div class="stage-column">
            <article
              :class="['stage-card', { active: focusedStageId === stage.id }]"
              role="button"
              tabindex="0"
              @click="$emit('focus-stage', stage)"
              @keyup.enter="$emit('focus-stage', stage)"
            >
              <div class="stage-icon">S{{ index + 1 }}</div>
              <p>STAGE {{ index + 1 }}</p>
              <h3>{{ stage.name }}</h3>
              <small>{{ stage.actions.length }} Actions</small>
            </article>

            <div class="agent-list">
              <article
                v-for="agent in stage.agents"
                :key="agent.id"
                :class="['agent-card', { active: focusedAgentId === agent.id }]"
                role="button"
                tabindex="0"
                @click="$emit('focus-agent', stage, agent)"
                @keyup.enter="$emit('focus-agent', stage, agent)"
              >
                <div class="agent-head">
                  <strong>{{ agent.name }}</strong>
                  <span>{{ agent.source === "shared" ? "Shared" : "Managed" }}</span>
                </div>
                <p v-if="readonly" class="agent-summary">
                  {{ agent.responsibility || agent.description || "暂未填写职责" }}
                </p>
                <textarea v-else v-model="agent.responsibility" rows="3" @click.stop></textarea>
                <div class="agent-io">
                  <small>Watch: {{ agent.watch.join(", ") }}</small>
                  <small>Produce: {{ agent.produce.join(", ") }}</small>
                </div>
                <div class="skill-tags">
                  <span v-for="skill in agent.skills" :key="skill.id" class="skill-tag" :title="skill.path">
                    {{ skill.name }} v{{ skill.version }}
                  </span>
                  <span v-if="!agent.skills.length" class="skill-placeholder">No Skills</span>
                </div>
              </article>

              <div v-if="!stage.agents.length" class="agent-placeholder">等待添加 Agent</div>
            </div>
          </div>

          <div v-if="flowPaths[index]" class="flow-connector" :class="{ active: activeMenu === 'pipeline' }">
            <span></span>
          </div>
        </template>
      </div>

      <div v-else class="canvas-empty">
        <div class="canvas-empty-illustration">+</div>
        <p>在这里开始构建流程图</p>
        <span>先添加阶段，右侧会自动生成节点视图。</span>
      </div>
    </div>

    <div v-else class="canvas-empty">
      <div class="canvas-empty-illustration">&lt;/&gt;</div>
      <p>请先选择或创建一个流水线</p>
      <span>左侧操作区会驱动右侧的完整流程画布。</span>
    </div>
  </section>
</template>
