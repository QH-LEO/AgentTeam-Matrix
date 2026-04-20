<script setup>
import { computed, reactive } from "vue";
import SidebarNav from "./components/SidebarNav.vue";
import StudioHeader from "./components/StudioHeader.vue";
import PipelineEditor from "./components/PipelineEditor.vue";
import PolicyEditor from "./components/PolicyEditor.vue";
import AgentEditor from "./components/AgentEditor.vue";
import SkillEditor from "./components/SkillEditor.vue";
import CompilerPreview from "./components/CompilerPreview.vue";
import FlowCanvas from "./components/FlowCanvas.vue";
import RunConsole from "./components/RunConsole.vue";
import { useAgentFlowStudio } from "./composables/useAgentFlowStudio.js";

const studio = reactive(useAgentFlowStudio());
const showCanvas = computed(() => ["pipeline", "agent", "skill"].includes(studio.activeMenu));
const canvasReadonly = computed(() => studio.activeMenu !== "pipeline");

function toggleEditorPanel() {
  studio.editorPanelCollapsed = !studio.editorPanelCollapsed;
  if (studio.editorPanelCollapsed) {
    studio.canvasPanelCollapsed = false;
  }
}

function toggleCanvasPanel() {
  studio.canvasPanelCollapsed = !studio.canvasPanelCollapsed;
  if (studio.canvasPanelCollapsed) {
    studio.editorPanelCollapsed = false;
  }
}

function updateLaunchMode(mode) {
  studio.launchMode = mode;
  studio.refreshLaunchPreview();
}
</script>

<template>
  <div :class="['app-shell', { 'sidebar-collapsed': studio.sidebarCollapsed }]">
    <SidebarNav
      :menu-items="studio.menuItems"
      :active-menu="studio.activeMenu"
      :mobile-nav-open="studio.mobileNavOpen"
      :sidebar-collapsed="studio.sidebarCollapsed"
      @set-menu="studio.setMenu"
      @toggle-sidebar="studio.sidebarCollapsed = !studio.sidebarCollapsed"
      @close-mobile="studio.mobileNavOpen = false"
      @reset-demo="studio.resetDemoData"
    />

    <div v-if="studio.mobileNavOpen" class="sidebar-mask" @click="studio.mobileNavOpen = false"></div>

    <main v-if="studio.activeView === 'studio'" class="workspace">
      <StudioHeader
        :current-menu-label="studio.currentMenuLabel"
        :selected-pipeline="studio.selectedPipeline"
        :stage-stats="studio.stageStats"
        :run-starting="studio.runStarting"
        :compiling="studio.compiling"
        :preflight-summary="studio.preflightSummary"
        :preflight-checking="studio.preflightChecking"
        @open-mobile="studio.mobileNavOpen = true"
        @start-run="studio.startRun"
        @preview-compile="studio.previewCompile"
        @toggle-preflight="studio.togglePreflightPanel"
      />

      <div v-if="studio.runError" class="run-error-banner">{{ studio.runError }}</div>
      <div v-if="studio.preflightPanelOpen && (studio.preflightResult || studio.preflightError)" class="preflight-strip">
        <strong>启动前预检</strong>
        <span :class="{ danger: studio.hasPreflightFailures, warn: studio.hasPreflightWarnings && !studio.hasPreflightFailures }">
          {{ studio.preflightError || (studio.hasPreflightFailures ? "存在失败项，已阻止运行" : studio.hasPreflightWarnings ? "存在警告项，可确认后继续" : "全部通过") }}
        </span>
        <div class="preflight-chip-list">
          <span
            v-for="check in studio.preflightResult?.checks || []"
            :key="check.id"
            :class="['preflight-chip', check.status]"
          >
            {{ check.label }}
          </span>
        </div>
      </div>

      <div
        :class="[
          'workspace-body',
          {
            'workspace-body-wide': !showCanvas,
            'editor-collapsed': showCanvas && studio.editorPanelCollapsed,
            'canvas-collapsed': showCanvas && studio.canvasPanelCollapsed,
          },
        ]"
      >
        <section class="control-panel">
          <button
            v-if="showCanvas"
            class="panel-toggle-button"
            type="button"
            :aria-label="studio.editorPanelCollapsed ? '展开编辑区' : '收起编辑区'"
            :title="studio.editorPanelCollapsed ? '展开编辑区' : '收起编辑区'"
            @click="toggleEditorPanel"
          >
            <span aria-hidden="true">{{ studio.editorPanelCollapsed ? "›" : "‹" }}</span>
          </button>

          <div class="control-panel-content">
            <PipelineEditor
              v-if="studio.activeMenu === 'pipeline'"
              :selected-pipeline="studio.selectedPipeline"
              :pipelines="studio.pipelines"
              :selected-pipeline-id="studio.selectedPipelineId"
              :focused-stage="studio.focusedStage"
              :forms="studio.forms"
              :last-action="studio.lastAction"
              :csv-value="studio.csvValue"
              @create-pipeline="studio.createPipeline"
              @delete-pipeline="studio.deletePipeline"
              @select-pipeline="studio.selectPipeline"
              @set-pipeline-field="studio.setPipelineField"
              @add-stage="studio.addStage"
              @focus-stage="studio.focusStage"
              @set-stage-field="studio.setStageField"
              @delete-stage="studio.deleteStage"
              @move-stage="studio.moveStage"
              @add-action="studio.addAction"
              @delete-action="studio.deleteAction"
              @move-action="studio.moveAction"
              @set-csv-list="studio.setCsvList"
            />

            <PolicyEditor
              v-else-if="studio.activeMenu === 'policy'"
              :selected-pipeline="studio.selectedPipeline"
              :approval-options="studio.approvalOptions"
              @set-policy-value="studio.setPolicyValue"
              @toggle-policy-flag="studio.togglePolicyFlag"
              @toggle-approval="studio.toggleApproval"
              @add-quality-gate="studio.addQualityGate"
              @delete-quality-gate="studio.deleteQualityGate"
            />

            <AgentEditor
              v-else-if="studio.activeMenu === 'agent'"
              :selected-pipeline="studio.selectedPipeline"
              :has-stages="studio.hasStages"
              :forms="studio.forms"
              :shared-claude-agents="studio.sharedClaudeAgents"
              :focused-stage="studio.focusedStage"
              :focused-agent-id="studio.focusedAgentId"
              :csv-value="studio.csvValue"
              @add-agent="studio.addAgent"
              @focus-stage="studio.focusStage"
              @focus-agent="studio.focusAgent"
              @set-agent-field="studio.setAgentField"
              @delete-agent="studio.deleteAgent"
              @set-csv-list="studio.setCsvList"
            />

            <SkillEditor
              v-else-if="studio.activeMenu === 'skill'"
              :selected-pipeline="studio.selectedPipeline"
              :has-agents="studio.hasAgents"
              :forms="studio.forms"
              :available-agents-for-skill="studio.availableAgentsForSkill"
              :focused-agent="studio.focusedAgent"
              @add-skill="studio.addSkill"
              @focus-stage="studio.focusStage"
              @focus-agent="studio.focusAgent"
              @delete-skill="studio.deleteSkill"
              @set-skill-field="studio.setSkillField"
            />

            <CompilerPreview
              v-else
              :compile-preview="studio.compilePreview"
              :selected-artifact="studio.selectedArtifact"
              :selected-artifact-index="studio.selectedArtifactIndex"
              :compile-issues="studio.compileIssues"
              :preflight-result="studio.preflightResult"
              :preflight-summary="studio.preflightSummary"
              :preflight-checking="studio.preflightChecking"
              :compiling="studio.compiling"
              :applying-compile="studio.applyingCompile"
              @preview-compile="studio.previewCompile"
              @apply-compile="studio.applyCompile"
              @run-lint="studio.runLint"
              @refresh-preflight="studio.refreshPreflight({ silent: false })"
              @select-artifact="studio.selectedArtifactIndex = $event"
            />
          </div>
        </section>

        <section
          v-if="showCanvas"
          :class="['canvas-shell', { 'is-collapsed': studio.canvasPanelCollapsed }]"
        >
          <button
            class="canvas-toggle-button"
            type="button"
            :aria-label="studio.canvasPanelCollapsed ? '展开画布' : '收起画布'"
            :title="studio.canvasPanelCollapsed ? '展开画布' : '收起画布'"
            @click="toggleCanvasPanel"
          >
            <span aria-hidden="true">{{ studio.canvasPanelCollapsed ? "‹" : "›" }}</span>
          </button>

          <FlowCanvas
            v-if="!studio.canvasPanelCollapsed"
            :selected-pipeline="studio.selectedPipeline"
            :focused-stage-id="studio.focusedStageId"
            :focused-agent-id="studio.focusedAgentId"
            :active-menu="studio.activeMenu"
            :flow-paths="studio.flowPaths"
            :readonly="canvasReadonly"
            @focus-stage="studio.focusStage"
            @focus-agent="studio.focusAgent"
            @set-stage-field="studio.setStageField"
            @add-stage-at="studio.addStageAt"
            @move-stage-to-index="studio.moveStageToIndex"
          />

          <button v-else class="canvas-rail" type="button" @click="toggleCanvasPanel">
            <span aria-hidden="true">⌁</span>
          </button>
        </section>
      </div>
    </main>

    <RunConsole
      v-else
      :current-run="studio.currentRun"
      :requirement-text="studio.requirementText"
      :launch-mode="studio.launchMode"
      :launch-preview="studio.launchPreview"
      :active-preflight-checks="studio.activePreflightChecks"
      :launch-status="studio.launchStatus"
      :launching-iterm="studio.launchingITerm"
      @back="studio.backToStudio"
      @stop-run="studio.stopRun"
      @open-iterm="studio.openInITerm"
      @refresh-launch-preview="studio.refreshLaunchPreview"
      @update-requirement="studio.requirementText = $event"
      @update-launch-mode="updateLaunchMode"
    />
  </div>
</template>
