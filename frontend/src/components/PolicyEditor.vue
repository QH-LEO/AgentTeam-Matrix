<script setup>
defineProps({
  selectedPipeline: { type: Object, default: null },
  approvalOptions: { type: Array, required: true },
});

defineEmits(["set-policy-value", "toggle-policy-flag", "toggle-approval", "add-quality-gate"]);
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
            <span>最大递归深度</span>
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
          允许递归委托
        </button>
      </div>

      <div class="toolbar-group policy-card approval-card">
        <div class="section-heading tight">
          <p>人工确认点</p>
          <span>这些动作必须回到人类确认。</span>
        </div>
        <div class="approval-list">
          <button
            v-for="approval in approvalOptions"
            :key="approval.key"
            :class="[
              'approval-chip',
              { active: selectedPipeline.delegationPolicy.requireHumanApprovalFor.includes(approval.key) },
            ]"
            type="button"
            @click="$emit('toggle-approval', approval.key)"
          >
            {{ approval.label }}
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
            <span>递归委托</span>
            <textarea v-model="selectedPipeline.delegationPolicy.escalationRules.recursive" rows="2"></textarea>
          </label>
        </div>
      </div>

      <div class="toolbar-group policy-card gates-card">
        <div class="section-heading tight">
          <p>质量门禁</p>
          <span>独立于升级规则，用于阶段确认、写文件、完成验收等强制检查。</span>
        </div>
        <div class="gate-list">
          <article v-for="gate in selectedPipeline.qualityGates" :key="gate.id" class="gate-card">
            <div class="gate-card-header">
              <label>
                <span>Gate ID</span>
                <input v-model="gate.id" type="text" />
              </label>
              <label>
                <span>名称</span>
                <input v-model="gate.name" type="text" />
              </label>
              <label>
                <span>类型</span>
                <select v-model="gate.type">
                  <option value="human">human</option>
                  <option value="test">test</option>
                  <option value="review">review</option>
                  <option value="security">security</option>
                </select>
              </label>
              <label class="gate-required">
                <input v-model="gate.required" type="checkbox" />
                <span>必需</span>
              </label>
            </div>
            <textarea v-model="gate.description" rows="2" placeholder="门禁说明"></textarea>
          </article>
        </div>
        <button class="ghost-button" type="button" @click="$emit('add-quality-gate')">添加门禁</button>
      </div>

      <div class="toolbar-status">策略模型、升级规则和质量门禁会随编译写入 Team Leader 与 using-agentflow</div>
    </template>
  </div>
</template>
