<script setup>
defineProps({
  selectedPipeline: { type: Object, default: null },
  pipelines: { type: Array, required: true },
  selectedPipelineId: { type: String, required: true },
  focusedStage: { type: Object, default: null },
  forms: { type: Object, required: true },
  lastAction: { type: String, required: true },
  csvValue: { type: Function, required: true },
});

defineEmits([
  "create-pipeline",
  "select-pipeline",
  "add-stage",
  "focus-stage",
  "add-action",
  "set-csv-list",
]);
</script>

<template>
  <div class="panel-section pipeline-section">
    <div class="toolbar-group">
      <div class="section-heading">
        <p>新建流水线</p>
        <span>创建或选择一条 AgentFlow DSL v3 流水线。</span>
      </div>
      <div class="inline-form">
        <input
          v-model="forms.pipelineName"
          type="text"
          placeholder="例如：核心研发流程"
          @keyup.enter="$emit('create-pipeline')"
        />
        <button class="ghost-button compact" type="button" @click="$emit('create-pipeline')">+</button>
      </div>
      <input
        v-model="forms.leaderAgentName"
        type="text"
        placeholder="Team Leader Agent 名称，留空自动生成"
      />
      <input
        v-model="forms.projectPath"
        type="text"
        placeholder="项目地址，例如：/Users/leo/Projects/agentflow-platform"
      />
    </div>

    <div class="toolbar-group pipeline-list-group">
      <div class="section-heading tight">
        <p>流水线</p>
        <span>{{ pipelines.length }} 条</span>
      </div>
      <button
        v-for="pipeline in pipelines"
        :key="pipeline.id"
        :class="['pipeline-card', { active: selectedPipelineId === pipeline.id }]"
        type="button"
        @click="$emit('select-pipeline', pipeline)"
      >
        <strong>{{ pipeline.name }}</strong>
        <span>Stages: {{ pipeline.stages.length }} · Actions: {{ pipeline.sop?.stages?.reduce((total, stage) => total + stage.actions.length, 0) || 0 }}</span>
        <span>Leader: {{ pipeline.leaderAgentName }}</span>
        <span>{{ pipeline.projectPath }}</span>
      </button>
    </div>

    <div v-if="selectedPipeline" class="toolbar-group">
      <div class="section-heading tight">
        <p>添加阶段</p>
        <span>阶段会自动生成一个默认 Action，可继续编辑输入/输出/门禁。</span>
      </div>
      <div class="inline-form">
        <input
          v-model="forms.stageName"
          type="text"
          placeholder="阶段名称，如：技术方案"
          @keyup.enter="$emit('add-stage')"
        />
        <button class="secondary-button compact" type="button" @click="$emit('add-stage')">添加</button>
      </div>
    </div>

    <div v-if="selectedPipeline" class="toolbar-group stage-list-group">
      <div class="section-heading tight">
        <p>阶段</p>
        <span>{{ selectedPipeline.stages.length }} 个</span>
      </div>
      <button
        v-for="(stage, index) in selectedPipeline.stages"
        :key="stage.id"
        :class="['order-card', { active: focusedStage?.id === stage.id }]"
        type="button"
        @click="$emit('focus-stage', stage)"
      >
        <span>{{ index + 1 }}</span>
        <strong>{{ stage.name }}</strong>
      </button>
    </div>

    <div v-if="focusedStage" class="toolbar-group action-editor">
      <div class="section-heading tight">
        <p>Action 编排</p>
        <span>定义每个阶段的 owner、输入、输出和门禁。</span>
      </div>
      <article v-for="action in focusedStage.actions" :key="action.id" class="action-card">
        <label>
          <span>Action 名称</span>
          <input v-model="action.name" type="text" />
        </label>
        <label>
          <span>Owner</span>
          <select v-model="action.owner">
            <option value="">未配置</option>
            <option v-for="agent in focusedStage.agents" :key="agent.id" :value="agent.agentName">
              {{ agent.agentName }}
            </option>
          </select>
        </label>
        <label>
          <span>Inputs</span>
          <input
            :value="csvValue(action.inputs)"
            type="text"
            @input="$emit('set-csv-list', action, 'inputs', $event.target.value)"
          />
        </label>
        <label>
          <span>Outputs</span>
          <input
            :value="csvValue(action.outputs)"
            type="text"
            @input="$emit('set-csv-list', action, 'outputs', $event.target.value)"
          />
        </label>
        <label>
          <span>Gates</span>
          <input
            :value="csvValue(action.gates)"
            type="text"
            placeholder="requirement-review, architecture-review"
            @input="$emit('set-csv-list', action, 'gates', $event.target.value)"
          />
        </label>
      </article>
      <button class="ghost-button" type="button" @click="$emit('add-action', focusedStage)">添加 Action</button>
    </div>

    <div v-else class="panel-empty">请先创建或选择一条流水线。</div>

    <div class="toolbar-status">{{ lastAction }}</div>
  </div>
</template>
