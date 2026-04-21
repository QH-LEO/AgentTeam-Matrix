<script setup>
defineProps({
  selectedPipeline: { type: Object, default: null },
});

defineEmits(["add-quality-gate", "set-quality-gate-field", "delete-quality-gate"]);

function gateUsage(selectedPipeline, gateId) {
  if (!selectedPipeline || !gateId) return [];
  return selectedPipeline.stages.flatMap((stage) =>
    stage.actions
      .filter((action) => action.gates?.includes(gateId))
      .map((action) => `${stage.name} / ${action.name}`)
  );
}
</script>

<template>
  <div class="panel-section gate-section">
    <div v-if="!selectedPipeline" class="panel-empty">请先创建或选择一条流水线。</div>
    <template v-else>
      <div class="toolbar-group policy-card gates-card">
        <div class="section-heading">
          <p>门禁管理</p>
          <span>定义 AI Coding 的审查维度、触发点、放行方式、阻断级别、证据和失败处理，再绑定到 Action。</span>
        </div>

        <div class="gate-list">
          <article v-for="gate in selectedPipeline.qualityGates" :key="gate.id" class="gate-card">
            <div class="gate-card-header">
              <label>
                <span>Gate ID</span>
                <input
                  :value="gate.id"
                  type="text"
                  @input="$emit('set-quality-gate-field', gate, 'id', $event.target.value)"
                />
              </label>
              <label>
                <span>名称</span>
                <input
                  :value="gate.name"
                  type="text"
                  @input="$emit('set-quality-gate-field', gate, 'name', $event.target.value)"
                />
              </label>
              <label>
                <span>审查维度</span>
                <select :value="gate.domain" @change="$emit('set-quality-gate-field', gate, 'domain', $event.target.value)">
                  <option value="requirement">requirement</option>
                  <option value="architecture">architecture</option>
                  <option value="code">code</option>
                  <option value="test">test</option>
                  <option value="security">security</option>
                  <option value="dependency">dependency</option>
                  <option value="release">release</option>
                </select>
              </label>
              <label>
                <span>触发点</span>
                <select :value="gate.trigger" @change="$emit('set-quality-gate-field', gate, 'trigger', $event.target.value)">
                  <option value="before_plan">before_plan</option>
                  <option value="before_stage_exit">before_stage_exit</option>
                  <option value="before_tool">before_tool</option>
                  <option value="before_command">before_command</option>
                  <option value="before_write">before_write</option>
                  <option value="after_diff">after_diff</option>
                  <option value="before_commit">before_commit</option>
                  <option value="before_pr">before_pr</option>
                </select>
              </label>
              <label>
                <span>放行方式</span>
                <select :value="gate.executor" @change="$emit('set-quality-gate-field', gate, 'executor', $event.target.value)">
                  <option value="human_approval">用户批准</option>
                  <option value="human_review">用户审查</option>
                  <option value="ai_review">AI 审查</option>
                </select>
              </label>
              <label>
                <span>阻断级别</span>
                <select :value="gate.enforcement" @change="$emit('set-quality-gate-field', gate, 'enforcement', $event.target.value)">
                  <option value="block">block</option>
                  <option value="warn">warn</option>
                  <option value="audit">audit</option>
                </select>
              </label>
              <button class="ghost-button compact danger-button" type="button" @click="$emit('delete-quality-gate', gate)">
                删除
              </button>
            </div>
            <textarea
              :value="gate.description"
              rows="3"
              placeholder="写清楚触发条件、检查证据和通过标准。"
              @input="$emit('set-quality-gate-field', gate, 'description', $event.target.value)"
            ></textarea>
            <label>
              <span>证据要求</span>
              <input
                :value="gate.evidence?.join(', ')"
                type="text"
                placeholder="例如：变更文件列表, 测试结果, 风险说明"
                @input="$emit('set-quality-gate-field', gate, 'evidence', $event.target.value)"
              />
            </label>
            <label>
              <span>通过标准</span>
              <textarea
                :value="gate.passCriteria"
                rows="2"
                placeholder="什么情况下这个门禁算通过"
                @input="$emit('set-quality-gate-field', gate, 'passCriteria', $event.target.value)"
              ></textarea>
            </label>
            <label>
              <span>失败处理</span>
              <select :value="gate.failAction" @change="$emit('set-quality-gate-field', gate, 'failAction', $event.target.value)">
                <option value="revise">revise</option>
                <option value="ask_user">ask_user</option>
                <option value="rollback">rollback</option>
                <option value="stop">stop</option>
                <option value="waive">waive</option>
              </select>
            </label>
            <div class="gate-usage">
              <strong>绑定位置</strong>
              <span v-if="!gateUsage(selectedPipeline, gate.id).length">暂未绑定到 Action</span>
              <span v-for="usage in gateUsage(selectedPipeline, gate.id)" :key="usage">{{ usage }}</span>
            </div>
          </article>
        </div>

        <button class="ghost-button" type="button" @click="$emit('add-quality-gate')">添加门禁</button>
      </div>

      <div class="toolbar-status">
        绑定入口在“流程编排 -> 当前阶段 -> Action 编排 -> Gates”。修改 Gate ID 会自动同步已绑定的 Action 引用。
      </div>
    </template>
  </div>
</template>
