<script setup>
defineProps({
  selectedPipeline: { type: Object, default: null },
  hasStages: { type: Boolean, required: true },
  forms: { type: Object, required: true },
  sharedClaudeAgents: { type: Array, required: true },
  focusedStage: { type: Object, default: null },
  focusedAgentId: { type: String, required: true },
  csvValue: { type: Function, required: true },
});

defineEmits(["add-agent", "focus-stage", "focus-agent", "set-agent-field", "set-csv-list"]);
</script>

<template>
  <div class="panel-section agent-section">
    <div v-if="!hasStages" class="panel-empty">请先添加阶段，再开始编辑 Agent 职责。</div>
    <template v-else>
      <div class="section-heading">
        <p>新增 Agent</p>
        <span>优先复用 Claude agents；没有合适的再新建托管 Agent。</span>
      </div>
      <div class="stack-form">
        <select
          v-model="forms.agentStageId"
          @change="$emit('focus-stage', selectedPipeline.stages.find((stage) => stage.id === forms.agentStageId))"
        >
          <option value="" disabled>选择所属阶段</option>
          <option v-for="stage in selectedPipeline.stages" :key="stage.id" :value="stage.id">
            {{ stage.name }}
          </option>
        </select>
        <select v-model="forms.sharedAgentName">
          <option value="">新建 Agent，不复用</option>
          <option v-for="agent in sharedClaudeAgents" :key="agent.agentName" :value="agent.agentName">
            {{ agent.agentName }} · {{ agent.name || "未命名 Agent" }}
          </option>
        </select>
        <input
          v-model="forms.agentName"
          type="text"
          placeholder="角色名称，例如：产品经理"
        />
        <textarea
          v-model="forms.agentResp"
          rows="4"
          placeholder="在本流水线里的职责补充：目标、边界、交付标准"
        ></textarea>
        <button class="primary-button" type="button" @click="$emit('add-agent')">确认添加 Agent</button>
      </div>

      <div class="toolbar-group context-summary-card">
        <div class="section-heading tight">
          <p>编辑上下文</p>
          <span>{{ focusedStage ? `当前阶段：${focusedStage.name}` : "未选择阶段" }}</span>
        </div>
        <div v-if="focusedStage" class="context-summary">
          <strong>{{ focusedStage.name }}</strong>
          <span>{{ focusedStage.agents.length }} 个 Agent，下面直接编辑职责、Watch、Produce。</span>
        </div>
      </div>

      <div v-if="focusedStage?.agents.length" class="toolbar-group agent-dsl-editor">
        <div class="section-heading tight">
          <p>Watch / Produce</p>
          <span>这些字段会进入 organization.agents。</span>
        </div>
        <article
          v-for="agent in focusedStage.agents"
          :key="agent.id"
          :class="['action-card', 'selectable-editor-card', { active: focusedAgentId === agent.id }]"
          role="button"
          tabindex="0"
          @click="$emit('focus-agent', focusedStage, agent)"
          @keyup.enter="$emit('focus-agent', focusedStage, agent)"
        >
          <div class="node-card-header">
            <div>
              <strong>{{ agent.name }}</strong>
              <span>@{{ agent.agentName }}</span>
            </div>
            <span>{{ agent.source === "shared" ? "Shared" : "Managed" }}</span>
          </div>
          <label>
            <span>角色名称</span>
            <input
              :value="agent.name"
              type="text"
              @input="$emit('set-agent-field', focusedStage, agent, 'name', $event.target.value)"
            />
          </label>
          <label v-if="agent.source === 'shared'">
            <span>绑定本机 Agent</span>
            <select
              :value="agent.agentName"
              @change="$emit('set-agent-field', focusedStage, agent, 'agentName', $event.target.value)"
            >
              <option
                v-if="agent.agentName && !sharedClaudeAgents.some((item) => item.agentName === agent.agentName)"
                :value="agent.agentName"
              >
                @{{ agent.agentName }}（当前绑定，目录中未发现）
              </option>
              <option v-for="item in sharedClaudeAgents" :key="item.agentName" :value="item.agentName">
                @{{ item.agentName }} · {{ item.name || item.agentName }}
              </option>
            </select>
          </label>
          <label v-else>
            <span>Agent Handle</span>
            <input
              :value="agent.agentName"
              type="text"
              @input="$emit('set-agent-field', focusedStage, agent, 'agentName', $event.target.value)"
            />
          </label>
          <label>
            <span>Watch</span>
            <input
              :value="csvValue(agent.watch)"
              type="text"
              @input="$emit('set-csv-list', agent, 'watch', $event.target.value)"
            />
          </label>
          <label>
            <span>Produce</span>
            <input
              :value="csvValue(agent.produce)"
              type="text"
              @input="$emit('set-csv-list', agent, 'produce', $event.target.value)"
            />
          </label>
          <label>
            <span>职责</span>
            <textarea
              :value="agent.responsibility"
              rows="3"
              @input="$emit('set-agent-field', focusedStage, agent, 'responsibility', $event.target.value)"
            ></textarea>
          </label>
          <div v-if="agent.source === 'shared'" class="form-note">
            这里绑定的是本机真实 Claude Agent 文件名；角色名称保留业务语义，委托时会使用上面的 @handle。
          </div>
        </article>
      </div>
    </template>
  </div>
</template>
