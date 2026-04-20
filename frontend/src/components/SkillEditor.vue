<script setup>
defineProps({
  selectedPipeline: { type: Object, default: null },
  hasAgents: { type: Boolean, required: true },
  forms: { type: Object, required: true },
  availableAgentsForSkill: { type: Array, required: true },
  focusedAgent: { type: Object, default: null },
});

defineEmits(["add-skill", "focus-stage", "focus-agent"]);
</script>

<template>
  <div class="panel-section skill-section">
    <div v-if="!hasAgents" class="panel-empty">请先创建阶段和 Agent，再进行 Skill 装配。</div>
    <template v-else>
      <div class="section-heading">
        <p>装配 Skill</p>
        <span>给具体 Agent 绑定一个已有 Skill 目录；目录内的 SKILL.md 才是真正能力说明。</span>
      </div>
      <div class="stack-form">
        <select
          v-model="forms.skillStageId"
          @change="$emit('focus-stage', selectedPipeline.stages.find((stage) => stage.id === forms.skillStageId))"
        >
          <option value="" disabled>选择阶段</option>
          <option v-for="stage in selectedPipeline.stages" :key="stage.id" :value="stage.id">
            {{ stage.name }}
          </option>
        </select>
        <select
          v-model="forms.skillAgentId"
          @change="$emit('focus-agent', selectedPipeline.stages.find((stage) => stage.id === forms.skillStageId), availableAgentsForSkill.find((agent) => agent.id === forms.skillAgentId))"
        >
          <option value="" disabled>选择 Agent</option>
          <option v-for="agent in availableAgentsForSkill" :key="agent.id" :value="agent.id">
            {{ agent.name }}
          </option>
        </select>
        <div class="inline-form">
          <input v-model="forms.skillName" type="text" placeholder="Skill 名称，可留空从目录名推断" />
          <input v-model="forms.skillVersion" class="version-input" type="text" />
        </div>
        <input
          v-model="forms.skillPath"
          type="text"
          placeholder="Skill 目录，例如：.claude/skills/using-agentflow 或 ~/.claude/skills/xxx"
        />
        <div class="form-note">
          这里只保存目录引用，不在页面里编辑 SKILL.md；编译时会把路径写入 Leader / Agent 描述，方便 Claude 按目录加载能力。
        </div>
        <button class="indigo-button" type="button" @click="$emit('add-skill')">绑定 Skill 目录</button>
      </div>

      <div class="toolbar-group selection-card">
        <div class="section-heading tight">
          <p>当前 Agent</p>
          <span>{{ focusedAgent ? focusedAgent.name : "未选择 Agent" }}</span>
        </div>

        <div v-if="focusedAgent" class="inspector-card">
          <strong>{{ focusedAgent.name }}</strong>
          <span>{{ focusedAgent.responsibility || "暂未填写职责" }}</span>
          <div class="skill-directory-list">
            <article v-for="skill in focusedAgent.skills" :key="skill.id" class="skill-directory-card active">
              <strong>{{ skill.name }} <small>v{{ skill.version }}</small></strong>
              <span>{{ skill.path || "未配置目录" }}</span>
            </article>
            <div v-if="!focusedAgent.skills.length" class="mini-empty">这个 Agent 还没有 Skill。</div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
