<script setup>
defineProps({
  selectedPipeline: { type: Object, default: null },
});

defineEmits(["set-policy-value", "toggle-policy-flag", "set-knowledge-base-field", "toggle-knowledge-base-flag"]);
</script>

<template>
  <div class="panel-section policy-section">
    <div v-if="!selectedPipeline" class="panel-empty">请先创建或选择一条流水线。</div>
    <template v-else>
      <div class="toolbar-group policy-card wide strategy-card">
        <div class="section-heading">
          <p>策略模型</p>
          <span>定义什么时候自己干、开 Sub Agent、启动 Agent Team。</span>
        </div>
        <div class="policy-hero">
          <strong>{{ selectedPipeline.name }}</strong>
          <span>{{ selectedPipeline.leaderAgentName }}</span>
        </div>
        <select
          :value="selectedPipeline.delegationPolicy.defaultMode"
          @change="$emit('set-policy-value', 'defaultMode', $event.target.value)"
        >
          <option value="self_first">自己优先</option>
          <option value="subagent_first">子 Agent 优先</option>
          <option value="team_first">Team 优先</option>
        </select>
        <div class="policy-grid">
          <label>
            <span>最大委托深度</span>
            <input
              :value="selectedPipeline.delegationPolicy.maxDepth"
              type="number"
              min="1"
              max="3"
              @input="$emit('set-policy-value', 'maxDepth', Number($event.target.value))"
            />
          </label>
          <label>
            <span>最大并行 Agent</span>
            <input
              :value="selectedPipeline.delegationPolicy.maxParallelAgents"
              type="number"
              min="1"
              max="8"
              @input="$emit('set-policy-value', 'maxParallelAgents', Number($event.target.value))"
            />
          </label>
        </div>
      </div>

      <div class="toolbar-group policy-card authority-card">
        <div class="section-heading tight">
          <p>授权边界</p>
          <span>控制 Leader 能升级到什么程度。</span>
        </div>
        <button
          :class="['policy-toggle', { active: selectedPipeline.delegationPolicy.allowSubAgents }]"
          type="button"
          @click="$emit('toggle-policy-flag', 'allowSubAgents')"
        >
          允许创建 Sub Agent
        </button>
        <button
          :class="['policy-toggle', { active: selectedPipeline.delegationPolicy.allowAgentTeam }]"
          type="button"
          @click="$emit('toggle-policy-flag', 'allowAgentTeam')"
        >
          允许启动 Agent Team
        </button>
        <button
          :class="['policy-toggle', { active: selectedPipeline.delegationPolicy.allowRecursiveDelegation }]"
          type="button"
          @click="$emit('toggle-policy-flag', 'allowRecursiveDelegation')"
        >
          允许子 Agent 再拆任务
        </button>
      </div>

      <div class="toolbar-group policy-card knowledge-card">
        <div class="section-heading tight">
          <p>Knowledge Wiki</p>
          <span>让流水线沉淀项目长期上下文，暂不接入门禁。</span>
        </div>
        <button
          :class="['policy-toggle', { active: selectedPipeline.knowledgeBase.enabled }]"
          type="button"
          @click="$emit('toggle-knowledge-base-flag', 'enabled')"
        >
          启用项目知识库
        </button>
        <div class="policy-grid">
          <label>
            <span>Wiki 路径</span>
            <input
              :value="selectedPipeline.knowledgeBase.path"
              type="text"
              placeholder=".agentflow/wiki"
              @input="$emit('set-knowledge-base-field', 'path', $event.target.value)"
            />
          </label>
          <label>
            <span>写入模式</span>
            <select
              :value="selectedPipeline.knowledgeBase.writeMode"
              @change="$emit('set-knowledge-base-field', 'writeMode', $event.target.value)"
            >
              <option value="proposal_first">先提议再写</option>
              <option value="readonly">只读查询</option>
              <option value="auto_write">自动写入</option>
            </select>
          </label>
        </div>
        <label>
          <span>知识域说明</span>
          <textarea
            :value="selectedPipeline.knowledgeBase.domain"
            rows="2"
            placeholder="这个项目的需求、方案、决策和复盘知识库"
            @input="$emit('set-knowledge-base-field', 'domain', $event.target.value)"
          ></textarea>
        </label>
        <div class="knowledge-toggles">
          <button
            :class="['policy-toggle', { active: selectedPipeline.knowledgeBase.autoOrient }]"
            type="button"
            @click="$emit('toggle-knowledge-base-flag', 'autoOrient')"
          >
            运行前读取 Wiki
          </button>
          <button
            :class="['policy-toggle', { active: selectedPipeline.knowledgeBase.rawImmutable }]"
            type="button"
            @click="$emit('toggle-knowledge-base-flag', 'rawImmutable')"
          >
            原始资料防覆盖
          </button>
        </div>
      </div>

      <div class="toolbar-group policy-card rules-card">
        <div class="section-heading tight">
          <p>升级规则</p>
          <span>只描述委托升级判断，不承载质量门禁。</span>
        </div>
        <div class="rules-grid">
          <label>
            <span>自己干</span>
            <textarea v-model="selectedPipeline.delegationPolicy.escalationRules.self" rows="2"></textarea>
          </label>
          <label>
            <span>Sub Agent</span>
            <textarea v-model="selectedPipeline.delegationPolicy.escalationRules.subAgent" rows="2"></textarea>
          </label>
          <label>
            <span>Agent Team</span>
            <textarea v-model="selectedPipeline.delegationPolicy.escalationRules.team" rows="2"></textarea>
          </label>
          <label>
            <span>子 Agent 再拆任务</span>
            <textarea v-model="selectedPipeline.delegationPolicy.escalationRules.recursive" rows="2"></textarea>
          </label>
        </div>
      </div>

      <div class="toolbar-status">策略模型和升级规则会随编译写入 Team Leader 与 using-agentflow；质量门禁请在“门禁管理”中维护。</div>
    </template>
  </div>
</template>
