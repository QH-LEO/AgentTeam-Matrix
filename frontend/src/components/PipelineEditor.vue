<script setup>
function displayProjectPath(value) {
  return value === "." ? "" : value || "";
}

function projectPathLabel(value) {
  return value && value !== "." ? value : "当前工程目录";
}

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
  "delete-pipeline",
  "select-pipeline",
  "set-pipeline-field",
  "add-stage",
  "focus-stage",
  "set-stage-field",
  "delete-stage",
  "move-stage",
  "add-action",
  "delete-action",
  "move-action",
  "set-csv-list",
  "toggle-action-gate",
]);

function gateSummary(action) {
  return action.gates?.length ? action.gates.join(", ") : "未绑定门禁";
}
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
        placeholder="项目地址，留空表示当前工程目录，例如：/path/to/project"
      />
      <input
        v-model="forms.claudeDir"
        type="text"
        placeholder="Claude 目录，默认 ~/.claude"
      />
      <input
        v-model="forms.sharedAgentsDir"
        type="text"
        placeholder="共享 Agent 目录，默认 ~/.claude/agents"
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
        <span>{{ projectPathLabel(pipeline.projectPath) }}</span>
        <span>{{ pipeline.claudeDir }}</span>
        <span>{{ pipeline.sharedAgentsDir }}</span>
      </button>
    </div>

    <div v-if="selectedPipeline" class="toolbar-group">
      <div class="section-heading tight">
        <p>当前流水线</p>
        <span>编辑已存在的流水线配置，预检和编译都会使用这里的目录。</span>
      </div>
      <div class="stack-form">
        <input
          :value="selectedPipeline.name"
          type="text"
          placeholder="流水线名称"
          @input="$emit('set-pipeline-field', 'name', $event.target.value)"
        />
        <input
          :value="selectedPipeline.leaderAgentName"
          type="text"
          placeholder="Team Leader Agent 名称"
          @input="$emit('set-pipeline-field', 'leaderAgentName', $event.target.value)"
        />
        <input
          :value="displayProjectPath(selectedPipeline.projectPath)"
          type="text"
          placeholder="项目地址，留空表示当前工程目录"
          @input="$emit('set-pipeline-field', 'projectPath', $event.target.value)"
        />
        <input
          :value="selectedPipeline.claudeDir"
          type="text"
          placeholder="Claude 目录"
          @input="$emit('set-pipeline-field', 'claudeDir', $event.target.value)"
        />
        <input
          :value="selectedPipeline.sharedAgentsDir"
          type="text"
          placeholder="共享 Agent 目录"
          @input="$emit('set-pipeline-field', 'sharedAgentsDir', $event.target.value)"
        />
        <div class="run-action-row">
          <button class="ghost-button danger-button" type="button" @click="$emit('delete-pipeline', selectedPipeline)">
            删除当前流水线
          </button>
        </div>
      </div>
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
        <div class="order-card-body">
          <strong>{{ stage.name }}</strong>
          <small>{{ stage.actions.length }} Actions · {{ stage.agents.length }} Agents</small>
        </div>
        <div class="order-actions">
          <button
            class="ghost-button compact order-action-button"
            type="button"
            :disabled="index === 0"
            @click.stop="$emit('move-stage', stage, -1)"
          >
            ↑
          </button>
          <button
            class="ghost-button compact order-action-button"
            type="button"
            :disabled="index === selectedPipeline.stages.length - 1"
            @click.stop="$emit('move-stage', stage, 1)"
          >
            ↓
          </button>
        </div>
      </button>
    </div>

    <div v-if="focusedStage" class="toolbar-group stage-editor">
      <div class="section-heading tight">
        <p>当前阶段</p>
        <span>可直接修改阶段名称，也可以调整当前阶段顺序。</span>
      </div>
      <div class="stack-form">
        <input
          :value="focusedStage.name"
          type="text"
          placeholder="阶段名称"
          @input="$emit('set-stage-field', focusedStage, 'name', $event.target.value)"
        />
        <div class="run-action-row">
          <button
            class="secondary-button compact"
            type="button"
            :disabled="selectedPipeline.stages.findIndex((stage) => stage.id === focusedStage.id) === 0"
            @click="$emit('move-stage', focusedStage, -1)"
          >
            上移阶段
          </button>
          <button
            class="secondary-button compact"
            type="button"
            :disabled="selectedPipeline.stages.findIndex((stage) => stage.id === focusedStage.id) === selectedPipeline.stages.length - 1"
            @click="$emit('move-stage', focusedStage, 1)"
          >
            下移阶段
          </button>
          <button class="ghost-button danger-button" type="button" @click="$emit('delete-stage', focusedStage)">
            删除阶段
          </button>
        </div>
      </div>
    </div>

    <div v-if="focusedStage" class="toolbar-group action-editor">
      <div class="section-heading tight">
        <p>Action 编排</p>
        <span>定义每个阶段的 owner、输入、输出和门禁。</span>
      </div>
      <article v-for="(action, index) in focusedStage.actions" :key="action.id" class="action-card">
        <div class="node-card-header">
          <strong>Action {{ index + 1 }}</strong>
          <div class="order-actions">
            <button
              class="ghost-button compact order-action-button"
              type="button"
              :disabled="index === 0"
              @click="$emit('move-action', focusedStage, action, -1)"
            >
              ↑
            </button>
            <button
              class="ghost-button compact order-action-button"
              type="button"
              :disabled="index === focusedStage.actions.length - 1"
              @click="$emit('move-action', focusedStage, action, 1)"
            >
              ↓
            </button>
            <button
              class="ghost-button compact order-action-button danger-button"
              type="button"
              :disabled="focusedStage.actions.length <= 1"
              @click="$emit('delete-action', focusedStage, action)"
            >
              ×
            </button>
          </div>
        </div>
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
          <details class="gate-dropdown">
            <summary>
              <span>{{ gateSummary(action) }}</span>
              <small>{{ selectedPipeline.qualityGates.length }} 个可选门禁</small>
            </summary>
            <div v-if="selectedPipeline.qualityGates.length" class="gate-option-list">
              <label
                v-for="gate in selectedPipeline.qualityGates"
                :key="gate.id"
                :class="['gate-option', { active: action.gates?.includes(gate.id) }]"
              >
                <input
                  type="checkbox"
                  :checked="action.gates?.includes(gate.id)"
                  @change="$emit('toggle-action-gate', action, gate.id)"
                />
                <span>
                  <strong>{{ gate.name || gate.id }}</strong>
                  <small>{{ gate.id }} · {{ gate.trigger }} · {{ gate.executor }} · {{ gate.enforcement }}</small>
                </span>
              </label>
            </div>
            <div v-else class="gate-option-empty">暂无门禁，请先到“门禁管理”添加。</div>
          </details>
        </label>
      </article>
      <button class="ghost-button" type="button" @click="$emit('add-action', focusedStage)">添加 Action</button>
    </div>

    <div v-else class="panel-empty">请先创建或选择一条流水线。</div>

    <div class="toolbar-status">{{ lastAction }}</div>
  </div>
</template>
