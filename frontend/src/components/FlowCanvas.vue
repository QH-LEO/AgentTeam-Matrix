<script setup>
import { computed, nextTick, reactive, ref } from "vue";

const props = defineProps({
  selectedPipeline: { type: Object, default: null },
  focusedStageId: { type: String, required: true },
  focusedAgentId: { type: String, required: true },
  activeMenu: { type: String, required: true },
  flowPaths: { type: Array, required: true },
  readonly: { type: Boolean, default: false },
});

const emit = defineEmits([
  "focus-stage",
  "focus-agent",
  "set-stage-field",
  "add-stage-at",
  "move-stage-to-index",
]);

const canvasRef = ref(null);
const isDragging = ref(false);
const suppressClickUntil = ref(0);
const draggingStageId = ref("");
const dropIndex = ref(-1);
const stageInputRefs = new Map();
const dragState = reactive({
  pointerId: null,
  startX: 0,
  startY: 0,
  scrollLeft: 0,
  scrollTop: 0,
  moved: false,
});

const pipelineEditable = computed(() => !props.readonly);

function onPointerDown(event) {
  if (!canvasRef.value) return;
  if (event.pointerType === "mouse" && event.button !== 0) return;
  if (event.target.closest("[data-stage-draggable='true']")) return;
  if (event.target.closest("textarea, input, select, button, a, [contenteditable='true']")) return;

  dragState.pointerId = event.pointerId;
  dragState.startX = event.clientX;
  dragState.startY = event.clientY;
  dragState.scrollLeft = canvasRef.value.scrollLeft;
  dragState.scrollTop = canvasRef.value.scrollTop;
  dragState.moved = false;
  isDragging.value = false;
  canvasRef.value.setPointerCapture?.(event.pointerId);
}

function onPointerMove(event) {
  if (!canvasRef.value || dragState.pointerId !== event.pointerId) return;

  const deltaX = event.clientX - dragState.startX;
  const deltaY = event.clientY - dragState.startY;

  if (!dragState.moved && Math.hypot(deltaX, deltaY) > 6) {
    dragState.moved = true;
    isDragging.value = true;
  }

  if (!dragState.moved) return;

  canvasRef.value.scrollLeft = dragState.scrollLeft - deltaX;
  canvasRef.value.scrollTop = dragState.scrollTop - deltaY;
  event.preventDefault();
}

function onPointerUp(event) {
  if (dragState.pointerId !== event.pointerId) return;
  if (dragState.moved) {
    suppressClickUntil.value = performance.now() + 180;
  }
  releaseDrag(event.pointerId);
}

function onPointerCancel(event) {
  if (dragState.pointerId !== event.pointerId) return;
  releaseDrag(event.pointerId);
}

function releaseDrag(pointerId) {
  canvasRef.value?.releasePointerCapture?.(pointerId);
  dragState.pointerId = null;
  dragState.moved = false;
  isDragging.value = false;
}

function shouldSuppressClick(event) {
  if (performance.now() < suppressClickUntil.value) {
    event.preventDefault();
    event.stopPropagation();
    return true;
  }
  return false;
}

function focusStage(stage, event) {
  if (shouldSuppressClick(event)) return;
  emit("focus-stage", stage);

  if (!pipelineEditable.value) return;

  nextTick(() => {
    const input = stageInputRefs.get(stage.id);
    input?.focus?.();
    input?.select?.();
  });
}

function focusAgent(stage, agent, event) {
  if (shouldSuppressClick(event)) return;
  emit("focus-agent", stage, agent);
}

function setStageInputRef(stageId, element) {
  if (element) {
    stageInputRefs.set(stageId, element);
  } else {
    stageInputRefs.delete(stageId);
  }
}

function updateStageName(stage, event) {
  emit("set-stage-field", stage, "name", event.target.value);
}

function addStageAt(index) {
  emit("add-stage-at", index);
}

function onStageDragStart(stage, event) {
  if (!pipelineEditable.value) return;
  draggingStageId.value = stage.id;
  dropIndex.value = props.selectedPipeline?.stages.findIndex((item) => item.id === stage.id) ?? -1;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", stage.id);
}

function onStageDragEnd() {
  draggingStageId.value = "";
  dropIndex.value = -1;
}

function onStageDragOver(index, event) {
  if (!draggingStageId.value) return;
  event.preventDefault();
  dropIndex.value = index;
  event.dataTransfer.dropEffect = "move";
}

function onStageDrop(index, event) {
  if (!draggingStageId.value) return;
  event.preventDefault();
  emit("move-stage-to-index", draggingStageId.value, index);
  draggingStageId.value = "";
  dropIndex.value = -1;
}
</script>

<template>
  <section
    ref="canvasRef"
    :class="['canvas-panel', { 'is-dragging': isDragging }]"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
  >
    <div class="canvas-grid"></div>
    <div class="canvas-mode-label">
      <strong>{{ readonly ? "定位预览" : "流程画布" }}</strong>
      <span>
        {{
          readonly
            ? "点击节点切换编辑对象，按住拖动画布"
            : "拖拽阶段卡片调整顺序，点击阶段直接改名，连接处可插入新阶段"
        }}
      </span>
    </div>
    <div v-if="selectedPipeline" class="canvas-flow">
      <div v-if="selectedPipeline.stages.length" :class="['stage-lane', { 'is-editable': pipelineEditable }]">
        <div
          v-if="pipelineEditable"
          :class="['stage-separator', 'is-leading', { 'is-drop-active': dropIndex === 0 && draggingStageId }]"
          @dragover="onStageDragOver(0, $event)"
          @drop="onStageDrop(0, $event)"
        >
          <button class="stage-insert-button" type="button" @click.stop="addStageAt(0)">+ 阶段</button>
        </div>

        <template v-for="(stage, index) in selectedPipeline.stages" :key="stage.id">
          <div class="stage-column">
            <article
              :class="[
                'stage-card',
                {
                  active: focusedStageId === stage.id,
                  'is-drag-source': draggingStageId === stage.id,
                },
              ]"
              role="button"
              tabindex="0"
              :draggable="pipelineEditable"
              data-stage-draggable="true"
              @dragstart="onStageDragStart(stage, $event)"
              @dragend="onStageDragEnd"
              @click="focusStage(stage, $event)"
              @keyup.enter="emit('focus-stage', stage)"
            >
              <div class="stage-icon">S{{ index + 1 }}</div>
              <p>STAGE {{ index + 1 }}</p>
              <input
                v-if="pipelineEditable && focusedStageId === stage.id"
                :ref="(element) => setStageInputRef(stage.id, element)"
                class="stage-title-input"
                :value="stage.name"
                type="text"
                @click.stop
                @pointerdown.stop
                @keyup.stop
                @input="updateStageName(stage, $event)"
              />
              <h3 v-else>{{ stage.name }}</h3>
              <small>{{ stage.actions.length }} Actions</small>
            </article>

            <div class="agent-list">
              <article
                v-for="agent in stage.agents"
                :key="agent.id"
                :class="['agent-card', { active: focusedAgentId === agent.id }]"
                role="button"
                tabindex="0"
                @click="focusAgent(stage, agent, $event)"
                @keyup.enter="emit('focus-agent', stage, agent)"
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

          <div
            v-if="pipelineEditable || flowPaths[index]"
            :class="[
              'stage-separator',
              {
                'has-connector': !!flowPaths[index],
                'is-drop-active': dropIndex === index + 1 && draggingStageId,
              },
            ]"
            @dragover="onStageDragOver(index + 1, $event)"
            @drop="onStageDrop(index + 1, $event)"
          >
            <div v-if="flowPaths[index]" class="flow-connector" :class="{ active: activeMenu === 'pipeline' }">
              <span></span>
            </div>
            <button
              v-if="pipelineEditable"
              class="stage-insert-button"
              type="button"
              @click.stop="addStageAt(index + 1)"
            >
              + 阶段
            </button>
          </div>
        </template>
      </div>

      <div v-else class="canvas-empty">
        <div class="canvas-empty-illustration">+</div>
        <p>在这里开始构建流程图</p>
        <span>先添加阶段，右侧会自动生成节点视图。</span>
        <button
          v-if="pipelineEditable"
          class="stage-insert-button"
          type="button"
          @click.stop="addStageAt(0)"
        >
          + 新阶段
        </button>
      </div>
    </div>

    <div v-else class="canvas-empty">
      <div class="canvas-empty-illustration">&lt;/&gt;</div>
      <p>请先选择或创建一个流水线</p>
      <span>左侧操作区会驱动右侧的完整流程画布。</span>
    </div>
  </section>
</template>
