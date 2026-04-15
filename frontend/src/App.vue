<script setup>
import { computed, onMounted, reactive, ref, toRefs, watch } from "vue";

const DEFAULT_PROJECT_PATH = "/Users/leo/Projects/agentflow-platform";

const menuItems = [
  { key: "pipeline", label: "流程编排", icon: "flow" },
  { key: "policy", label: "决策模型", icon: "decision" },
  { key: "agent", label: "Agent 职责", icon: "bot" },
  { key: "skill", label: "Skill 管理", icon: "spark" },
];

const approvalOptions = [
  { key: "requirement-review", label: "需求确认" },
  { key: "architecture-review", label: "方案确认" },
  { key: "write-files", label: "写文件前" },
  { key: "run-command", label: "运行命令前" },
  { key: "completion-review", label: "完成验收" },
  { key: "deployment", label: "部署上线" },
  { key: "destructive-command", label: "破坏性命令" },
];

const defaultDelegationPolicy = {
  defaultMode: "self_first",
  allowSubAgents: true,
  allowAgentTeam: true,
  allowRecursiveDelegation: true,
  maxDepth: 2,
  maxParallelAgents: 4,
  requireHumanApprovalFor: ["architecture-review", "write-files", "destructive-command", "deployment"],
  escalationRules: {
    self: "任务小、路径清楚、上下文足够、单一产物时由当前 Agent 自己完成。",
    subAgent: "子任务边界清楚、适合并行、需要隔离上下文或专业审查时创建 Sub Agent。",
    team: "任务跨多个阶段/角色/产物，需要 Team Leader 拆解、调度、验收时启动 Agent Team。",
    recursive: "子任务自身变成复杂项目，且父 Agent 能验收结果时，允许受控递归委托。",
  },
};

const defaultPipelines = [
  {
    id: "p1",
    name: "核心研发流程",
    leaderAgentName: "agentflow-core-rd-team-leader",
    projectPath: DEFAULT_PROJECT_PATH,
    delegationPolicy: clonePolicy(defaultDelegationPolicy),
    stages: [
      {
        id: "s1",
        name: "需求分析",
        agents: [
          {
            id: "a1",
            name: "产品经理",
            agentName: "agentflow-product-manager",
            responsibility: "定义产品边界、业务目标和可验收的用户故事。",
            source: "shared",
            skills: [{ id: "sk1", name: "user_story", version: "1.0.0" }],
          },
        ],
      },
      {
        id: "s2",
        name: "技术方案",
        agents: [
          {
            id: "a2",
            name: "架构师",
            agentName: "agentflow-architect",
            responsibility: "设计系统边界、核心模块和接口契约。",
            source: "shared",
            skills: [{ id: "sk2", name: "architecture_review", version: "1.2.0" }],
          },
        ],
      },
      {
        id: "s3",
        name: "开发实现",
        agents: [],
      },
    ],
  },
];

function clonePipelines(pipelines) {
  return JSON.parse(JSON.stringify(pipelines));
}

function createId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function loadPersistedPipelines() {
  const saved = window.localStorage.getItem("agentflow-pipelines");
  if (!saved) return normalizePipelines(clonePipelines(defaultPipelines));

  try {
    const parsed = JSON.parse(saved);
    return Array.isArray(parsed) && parsed.length
      ? normalizePipelines(parsed)
      : normalizePipelines(clonePipelines(defaultPipelines));
  } catch {
    return normalizePipelines(clonePipelines(defaultPipelines));
  }
}

function normalizePipelines(pipelines) {
  return pipelines.map((pipeline) => ({
    ...pipeline,
    leaderAgentName: pipeline.leaderAgentName || toLeaderAgentName(pipeline.name, pipeline.id),
    projectPath: pipeline.projectPath || DEFAULT_PROJECT_PATH,
    delegationPolicy: normalizePolicy(pipeline.delegationPolicy),
    stages: (pipeline.stages || []).map((stage) => ({
      ...stage,
      agents: (stage.agents || []).map((agent) => ({
        ...agent,
        agentName: agent.agentName || toAgentName(agent.name),
        description: agent.description || `${agent.name || "Agent"} for AgentFlow pipeline.`,
        source: agent.source || "managed",
        model: agent.model || "sonnet",
        tools: agent.tools || ["Read", "Write", "Edit", "Grep", "Glob"],
        skills: agent.skills || [],
      })),
    })),
  }));
}

const state = reactive({
  activeView: "studio",
  activeMenu: "pipeline",
  selectedPipelineId: "p1",
  focusedStageId: "",
  focusedAgentId: "",
  mobileNavOpen: false,
  menuItems,
  pipelines: loadPersistedPipelines(),
  forms: {
    pipelineName: "",
    leaderAgentName: "",
    projectPath: DEFAULT_PROJECT_PATH,
    stageName: "",
    agentStageId: "",
    sharedAgentName: "",
    agentName: "",
    agentResp: "",
    skillStageId: "",
    skillAgentId: "",
    skillName: "",
    skillVersion: "1.0.0",
  },
});

const {
  activeView,
  activeMenu,
  selectedPipelineId,
  focusedStageId,
  focusedAgentId,
  mobileNavOpen,
  forms,
  pipelines,
} = toRefs(state);

const pipelineNameInput = ref(null);
const stageNameInput = ref(null);
const lastAction = ref("等待操作");
const requirementText = ref("");
const runError = ref("");
const runStarting = ref(false);
const syncingDefinition = ref(false);
const launchingITerm = ref(false);
const currentRun = ref(null);
const launchStatus = ref("等待填写需求");
const availableClaudeAgents = ref([]);
const definitionPreview = ref(null);
const preflightResult = ref(null);

const API_BASE = "http://localhost:8787";

if (!state.pipelines.some((pipeline) => pipeline.id === state.selectedPipelineId)) {
  state.selectedPipelineId = state.pipelines[0]?.id ?? "";
}

const selectedPipeline = computed(() =>
  state.pipelines.find((pipeline) => pipeline.id === state.selectedPipelineId) ?? null
);

const currentMenuLabel = computed(
  () => state.menuItems.find((item) => item.key === state.activeMenu)?.label ?? "工作台"
);

const hasStages = computed(() => !!selectedPipeline.value?.stages.length);
const hasAgents = computed(() =>
  !!selectedPipeline.value?.stages.some((stage) => stage.agents.length > 0)
);

const availableAgentsForSkill = computed(() => {
  if (!selectedPipeline.value || !state.forms.skillStageId) return [];
  const stage = selectedPipeline.value.stages.find((item) => item.id === state.forms.skillStageId);
  return stage?.agents ?? [];
});

const sharedClaudeAgents = computed(() =>
  availableClaudeAgents.value.filter((agent) => !agent.name.endsWith("-team-leader"))
);

const focusedStage = computed(() => {
  if (!selectedPipeline.value) return null;
  return selectedPipeline.value.stages.find((stage) => stage.id === state.focusedStageId) ?? null;
});

const focusedAgent = computed(() => {
  if (!focusedStage.value) return null;
  return focusedStage.value.agents.find((agent) => agent.id === state.focusedAgentId) ?? null;
});

const activePreflightChecks = computed(() =>
  currentRun.value?.preflight?.checks || preflightResult.value?.checks || []
);

const hasPreflightFailures = computed(() =>
  activePreflightChecks.value.some((check) => check.status === "fail")
);

const hasPreflightWarnings = computed(() =>
  activePreflightChecks.value.some((check) => check.status === "warn")
);

const stageStats = computed(() => {
  if (!selectedPipeline.value) return { stageCount: 0, agentCount: 0, skillCount: 0, depth: 0 };

  const summary = selectedPipeline.value.stages.reduce(
    (summary, stage) => {
      summary.stageCount += 1;
      summary.agentCount += stage.agents.length;
      summary.skillCount += stage.agents.reduce((total, agent) => total + agent.skills.length, 0);
      return summary;
    },
    { stageCount: 0, agentCount: 0, skillCount: 0 }
  );
  summary.depth = selectedPipeline.value.delegationPolicy?.maxDepth ?? 1;
  return summary;
});

const flowPaths = computed(() => {
  const pipeline = selectedPipeline.value;
  if (!pipeline || pipeline.stages.length < 2) return [];

  return pipeline.stages.slice(0, -1).map((stage, index) => ({
    id: `${stage.id}-${pipeline.stages[index + 1].id}`,
    type: "stage",
  }));
});

watch(
  () => state.pipelines,
  (pipelines) => {
    window.localStorage.setItem("agentflow-pipelines", JSON.stringify(pipelines));
  },
  { deep: true }
);

watch(
  selectedPipeline,
  (pipeline) => {
    if (!pipeline) {
      state.focusedStageId = "";
      state.focusedAgentId = "";
      state.forms.agentStageId = "";
      state.forms.skillStageId = "";
      state.forms.skillAgentId = "";
      return;
    }

    const firstStageId = pipeline.stages[0]?.id ?? "";

    if (!pipeline.stages.some((stage) => stage.id === state.forms.agentStageId)) {
      state.forms.agentStageId = firstStageId;
    }

    if (!pipeline.stages.some((stage) => stage.id === state.focusedStageId)) {
      state.focusedStageId = firstStageId;
    }

    if (!pipeline.stages.some((stage) => stage.id === state.forms.skillStageId)) {
      state.forms.skillStageId = firstStageId;
    }

    const skillStage = pipeline.stages.find((stage) => stage.id === state.forms.skillStageId);
    if (!skillStage?.agents.some((agent) => agent.id === state.forms.skillAgentId)) {
      state.forms.skillAgentId = skillStage?.agents[0]?.id ?? "";
    }

    const focusedStage = pipeline.stages.find((stage) => stage.id === state.focusedStageId);
    if (!focusedStage?.agents.some((agent) => agent.id === state.focusedAgentId)) {
      state.focusedAgentId = focusedStage?.agents[0]?.id ?? "";
    }
  },
  { immediate: true }
);

function setMenu(menuKey) {
  state.activeMenu = menuKey;
  state.mobileNavOpen = false;
}

function selectPipeline(pipeline) {
  state.selectedPipelineId = pipeline.id;
  state.activeMenu = "pipeline";
  state.focusedStageId = pipeline.stages[0]?.id ?? "";
  state.focusedAgentId = pipeline.stages[0]?.agents[0]?.id ?? "";
  state.mobileNavOpen = false;
}

async function createPipeline() {
  const name = (state.forms.pipelineName || pipelineNameInput.value?.value || "").trim();
  if (!name) {
    lastAction.value = "请输入流水线名称";
    pipelineNameInput.value?.focus();
    return;
  }

  const pipelineId = createId("p");
  const pipeline = {
    id: pipelineId,
    name,
    leaderAgentName: state.forms.leaderAgentName.trim() || toLeaderAgentName(name, pipelineId),
    projectPath: state.forms.projectPath.trim() || DEFAULT_PROJECT_PATH,
    delegationPolicy: clonePolicy(defaultDelegationPolicy),
    stages: [],
  };

  state.pipelines.push(pipeline);
  state.selectedPipelineId = pipeline.id;
  state.focusedStageId = "";
  state.focusedAgentId = "";
  state.forms.pipelineName = "";
  state.forms.leaderAgentName = "";
  state.forms.stageName = "";
  state.activeMenu = "pipeline";
  lastAction.value = `已创建本地流水线：${pipeline.name}，同步 Agents 后会生成 Team Leader`;
}

function addStage() {
  const pipeline = selectedPipeline.value;
  const name = (state.forms.stageName || stageNameInput.value?.value || "").trim();
  if (!pipeline) {
    lastAction.value = "请先选择流水线";
    return;
  }
  if (!name) {
    lastAction.value = "请输入阶段名称";
    stageNameInput.value?.focus();
    return;
  }

  const stage = {
    id: createId("s"),
    name,
    agents: [],
  };

  pipeline.stages.push(stage);
  state.focusedStageId = stage.id;
  state.focusedAgentId = "";
  state.forms.stageName = "";

  if (!state.forms.agentStageId) {
    state.forms.agentStageId = stage.id;
  }

  if (!state.forms.skillStageId) {
    state.forms.skillStageId = stage.id;
  }
  lastAction.value = `已添加阶段：${stage.name}`;
}

function addAgent() {
  const pipeline = selectedPipeline.value;
  if (!pipeline || !state.forms.agentStageId) return;

  const stage = pipeline.stages.find((item) => item.id === state.forms.agentStageId);
  if (!stage) return;

  const sharedAgent = sharedClaudeAgents.value.find((agent) => agent.name === state.forms.sharedAgentName);
  const name = state.forms.agentName.trim();
  if (!sharedAgent && !name) return;

  const agent = {
    id: createId("a"),
    name: sharedAgent ? sharedAgent.name.replace(/^agentflow-/, "") : name,
    agentName: sharedAgent ? sharedAgent.name : toAgentName(name),
    description: sharedAgent?.description || `${name} for AgentFlow pipeline.`,
    responsibility: state.forms.agentResp.trim() || sharedAgent?.description || "",
    source: sharedAgent ? "shared" : "managed",
    model: sharedAgent?.model || "sonnet",
    tools: sharedAgent?.tools || ["Read", "Write", "Edit", "Grep", "Glob"],
    skills: [],
  };

  stage.agents.push(agent);
  state.focusedStageId = stage.id;
  state.focusedAgentId = agent.id;
  state.forms.sharedAgentName = "";
  state.forms.agentName = "";
  state.forms.agentResp = "";

  if (state.forms.skillStageId === stage.id) {
    state.forms.skillAgentId = agent.id;
  }
  lastAction.value = sharedAgent ? `已引用共享 Agent：${agent.agentName}` : `已创建托管 Agent：${agent.agentName}`;
}

function addSkill() {
  const pipeline = selectedPipeline.value;
  if (!pipeline || !state.forms.skillStageId || !state.forms.skillAgentId) return;

  const stage = pipeline.stages.find((item) => item.id === state.forms.skillStageId);
  const agent = stage?.agents.find((item) => item.id === state.forms.skillAgentId);
  const name = state.forms.skillName.trim();
  if (!agent || !name) return;

  agent.skills.push({
    id: createId("sk"),
    name,
    version: state.forms.skillVersion.trim() || "1.0.0",
  });
  state.forms.skillName = "";
}

function focusStage(stage) {
  state.focusedStageId = stage.id;
  state.focusedAgentId = stage.agents[0]?.id ?? "";
  state.forms.agentStageId = stage.id;
  state.forms.skillStageId = stage.id;
  state.forms.skillAgentId = stage.agents[0]?.id ?? "";
}

function focusAgent(stage, agent) {
  state.focusedStageId = stage.id;
  state.focusedAgentId = agent.id;
  state.forms.agentStageId = stage.id;
  state.forms.skillStageId = stage.id;
  state.forms.skillAgentId = agent.id;
}

function resetDemoData() {
  state.pipelines = normalizePipelines(clonePipelines(defaultPipelines));
  state.selectedPipelineId = state.pipelines[0]?.id ?? "";
  state.focusedStageId = state.pipelines[0]?.stages[0]?.id ?? "";
  state.focusedAgentId = state.pipelines[0]?.stages[0]?.agents[0]?.id ?? "";
  state.activeMenu = "pipeline";
}

function setPolicyValue(key, value) {
  if (!selectedPipeline.value) return;
  selectedPipeline.value.delegationPolicy[key] = value;
}

function togglePolicyFlag(key) {
  if (!selectedPipeline.value) return;
  selectedPipeline.value.delegationPolicy[key] = !selectedPipeline.value.delegationPolicy[key];
}

function toggleApproval(key) {
  if (!selectedPipeline.value) return;
  const approvals = selectedPipeline.value.delegationPolicy.requireHumanApprovalFor;
  if (approvals.includes(key)) {
    selectedPipeline.value.delegationPolicy.requireHumanApprovalFor = approvals.filter((item) => item !== key);
    return;
  }
  selectedPipeline.value.delegationPolicy.requireHumanApprovalFor = [...approvals, key];
}

function clonePolicy(policy) {
  return JSON.parse(JSON.stringify(policy));
}

function normalizePolicy(policy) {
  const merged = {
    ...clonePolicy(defaultDelegationPolicy),
    ...(policy || {}),
    escalationRules: {
      ...defaultDelegationPolicy.escalationRules,
      ...(policy?.escalationRules || {}),
    },
  };

  merged.maxDepth = Number(merged.maxDepth || 1);
  merged.maxParallelAgents = Number(merged.maxParallelAgents || 1);
  merged.requireHumanApprovalFor = Array.isArray(merged.requireHumanApprovalFor)
    ? merged.requireHumanApprovalFor
    : [];
  return merged;
}

async function loadDefinition() {
  try {
    const response = await fetch(`${API_BASE}/api/definition`);
    if (!response.ok) return;
    const definition = await response.json();
    const loadedPipelines = Array.isArray(definition?.pipelines)
      ? definition.pipelines
      : definition?.pipeline
        ? [definition.pipeline]
        : [];
    if (!loadedPipelines.length) return;

    state.pipelines = normalizePipelines(loadedPipelines);
    const selectedId = definition.selectedPipelineId || definition.pipeline?.id || state.pipelines[0]?.id || "";
    const selected = state.pipelines.find((pipeline) => pipeline.id === selectedId) || state.pipelines[0];
    state.selectedPipelineId = selected?.id || "";
    state.focusedStageId = selected?.stages[0]?.id ?? "";
    state.focusedAgentId = selected?.stages[0]?.agents[0]?.id ?? "";
    state.forms.projectPath = selected?.projectPath || DEFAULT_PROJECT_PATH;
    lastAction.value = `已加载 ${state.pipelines.length} 条结构化流水线定义`;
  } catch {
    lastAction.value = "未连接 orchestrator，使用浏览器本地配置";
  }
}

async function loadAvailableAgents() {
  try {
    const response = await fetch(`${API_BASE}/api/agents`);
    if (!response.ok) return;
    const payload = await response.json();
    availableClaudeAgents.value = payload.agents || [];
  } catch {
    availableClaudeAgents.value = [];
  }
}

async function syncDefinition() {
  if (!selectedPipeline.value) {
    lastAction.value = "请先选择流水线";
    return;
  }

  syncingDefinition.value = true;
  try {
    definitionPreview.value = await previewPipelineDefinition(selectedPipeline.value);
    lastAction.value = definitionPreview.value.changed
      ? "已生成 Team Leader 预览，请确认写入"
      : "Team Leader 内容无变化，可直接关闭预览";
  } catch (error) {
    lastAction.value = error.message;
  } finally {
    syncingDefinition.value = false;
  }
}

async function confirmSyncDefinition() {
  if (!selectedPipeline.value) return;
  syncingDefinition.value = true;
  try {
    const payload = await savePipelineDefinition(selectedPipeline.value);
    definitionPreview.value = null;
    lastAction.value = `已保存 ${payload.definition?.pipelines?.length || state.pipelines.length} 条流水线，并生成 ${payload.generatedAgents?.length || 0} 个 Claude agent 文件`;
    await loadAvailableAgents();
  } catch (error) {
    lastAction.value = error.message;
  } finally {
    syncingDefinition.value = false;
  }
}

function closeDefinitionPreview() {
  definitionPreview.value = null;
}

async function startRun() {
  if (!selectedPipeline.value) {
    runError.value = "请先创建或选择流水线";
    return;
  }

  runStarting.value = true;
  runError.value = "";

  try {
    const preflight = await runPreflight(selectedPipeline.value);
    preflightResult.value = preflight;
    if (!preflight.ok) {
      throw new Error("启动前预检失败，请先修复失败项");
    }

    const syncPayload = await savePipelineDefinition(selectedPipeline.value);
    const pipelineSnapshot = syncPayload.definition?.pipeline || clonePipelines([selectedPipeline.value])[0];
    const response = await fetch(`${API_BASE}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pipeline: pipelineSnapshot,
        requirement: requirementText.value,
      }),
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload.detail || payload.error || "创建运行失败");
    }

    currentRun.value = { ...payload, preflight };
    state.activeView = "run";
    launchStatus.value = hasPreflightWarnings.value
      ? "已创建运行，存在预检警告，请确认后启动 iTerm2"
      : "已创建运行，请确认需求后一键启动 iTerm2";
  } catch (error) {
    runError.value = error.message;
  } finally {
    runStarting.value = false;
  }
}

async function previewPipelineDefinition(pipeline) {
  const response = await fetch(`${API_BASE}/api/definition/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pipeline: clonePipelines([pipeline])[0] }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "生成预览失败");
  }
  return payload;
}

async function runPreflight(pipeline) {
  const response = await fetch(`${API_BASE}/api/preflight`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pipeline: clonePipelines([pipeline])[0] }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "预检失败");
  }
  return payload;
}

async function savePipelineDefinition(pipeline) {
  const response = await fetch(`${API_BASE}/api/definition`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pipeline: clonePipelines([pipeline])[0],
      pipelines: clonePipelines(state.pipelines),
      selectedPipelineId: state.selectedPipelineId,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "同步失败");
  }
  return payload;
}

async function openInITerm() {
  if (!currentRun.value?.runId || launchingITerm.value) return;
  const text = requirementText.value.trim();
  launchingITerm.value = true;
  launchStatus.value = "正在打开 iTerm2...";

  try {
    const response = await fetch(`${API_BASE}/api/runs/${currentRun.value.runId}/open-iterm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requirement: text }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.detail || payload.error || "打开 iTerm2 失败");
    }
    currentRun.value = { ...payload, preflight: currentRun.value?.preflight };
    launchStatus.value = "已打开 iTerm2，Claude 已在项目目录启动";
  } catch (error) {
    launchStatus.value = error.message;
  } finally {
    launchingITerm.value = false;
  }
}

async function stopRun() {
  if (!currentRun.value?.runId) return;
  await fetch(`${API_BASE}/api/runs/${currentRun.value.runId}/stop`, { method: "POST" }).catch(() => {});
  currentRun.value = { ...currentRun.value, status: "stopped" };
  launchStatus.value = "已停止记录；如 iTerm2 已打开，请在终端中自行结束 Claude";
}

function backToStudio() {
  state.activeView = "studio";
}

function iconPath(icon) {
  switch (icon) {
    case "stack":
      return "M4 6.5 12 3l8 3.5L12 10 4 6.5Zm0 5L12 15l8-3.5M4 16.5 12 20l8-3.5";
    case "flow":
      return "M6 6h4v4H6V6Zm8 0h4a2 2 0 0 1 2 2v1M6 14h4v4H6v-4Zm8 0h4v4h-4v-4ZM10 8h4m-2 2v4";
    case "decision":
      return "M12 3v4m0 10v4M5 8l3 3-3 3-3-3 3-3Zm14 0 3 3-3 3-3-3 3-3ZM9 11h6m-3-4c2.5 0 4 1.6 4 4s-1.5 4-4 4-4-1.6-4-4 1.5-4 4-4Z";
    case "bot":
      return "M9 5h6m-5 0V3m4 2V3m-7 4h10a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Zm3 6h.01M14 13h.01";
    case "spark":
      return "m12 3 1.9 4.6L18.5 9l-4.6 1.4L12 15l-1.9-4.6L5.5 9l4.6-1.4L12 3Zm-6.5 12 1 2.5L9 18l-2.5 1-.5 2.5-1-2.5L2.5 18l2.5-.5.5-2.5Zm13 0 1 2.5L22 18l-2.5 1-.5 2.5-1-2.5-2.5-.5 2.5-.5.5-2.5Z";
    default:
      return "";
  }
}

function toAgentName(value) {
  return `agentflow-${String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "agent"}`;
}

function toLeaderAgentName(value, fallback = "pipeline") {
  const slug = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `agentflow-${slug || fallback}-team-leader`;
}

onMounted(() => {
  loadDefinition();
  loadAvailableAgents();
});
</script>

<template>
  <div class="app-shell">
    <aside :class="['sidebar', { open: mobileNavOpen }]">
      <div class="brand-block">
        <div>
          <p class="brand-kicker">AgentTeam</p>
          <h1>MATRIX STUDIO</h1>
        </div>
        <button class="sidebar-close" type="button" @click="mobileNavOpen = false">关闭</button>
      </div>

      <nav class="sidebar-nav">
        <button
          v-for="item in menuItems"
          :key="item.key"
          :class="['nav-item', { active: activeMenu === item.key }]"
          type="button"
          @click="setMenu(item.key)"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path :d="iconPath(item.icon)" />
          </svg>
          <span>{{ item.label }}</span>
        </button>
      </nav>

      <div class="env-card">
        <div class="env-label">当前环境</div>
        <div class="env-status">
          <span class="status-dot"></span>
          <span>Ready · Frontend Studio</span>
        </div>
        <button class="reset-link" type="button" @click="resetDemoData">恢复示例数据</button>
      </div>
    </aside>

    <div v-if="mobileNavOpen" class="sidebar-mask" @click="mobileNavOpen = false"></div>

    <main v-if="activeView === 'studio'" class="workspace">
      <header class="workspace-header">
        <div class="header-main">
          <button class="mobile-menu" type="button" @click="mobileNavOpen = true">菜单</button>
          <div>
            <p class="header-kicker">Pipeline Studio</p>
            <h2>{{ currentMenuLabel }}</h2>
          </div>
          <div class="pipeline-pill">
            <span>当前流水线</span>
            <strong>{{ selectedPipeline ? selectedPipeline.name : "未选择" }}</strong>
          </div>
        </div>

        <div class="header-actions">
          <div class="interaction-hint">
            可点击：左侧菜单、顶部操作按钮、画布阶段/Agent 卡片
          </div>
          <div class="header-stat">
            <span>阶段</span>
            <strong>{{ stageStats.stageCount }}</strong>
          </div>
          <div class="header-stat">
            <span>Agent</span>
            <strong>{{ stageStats.agentCount }}</strong>
          </div>
          <div class="header-stat">
            <span>Skill</span>
            <strong>{{ stageStats.skillCount }}</strong>
          </div>
          <div class="header-stat">
            <span>Depth</span>
            <strong>{{ stageStats.depth }}</strong>
          </div>
          <button class="primary-button" type="button" :disabled="runStarting" @click="startRun">
            {{ runStarting ? "启动中..." : "运行流程" }}
          </button>
          <button class="secondary-button" type="button" :disabled="syncingDefinition" @click="syncDefinition">
            {{ syncingDefinition ? "同步中..." : "同步 Agents" }}
          </button>
        </div>
      </header>
      <div v-if="runError" class="run-error-banner">{{ runError }}</div>
      <div v-if="preflightResult" class="preflight-strip">
        <strong>启动前预检</strong>
        <span :class="{ danger: hasPreflightFailures, warn: hasPreflightWarnings && !hasPreflightFailures }">
          {{ hasPreflightFailures ? "存在失败项，已阻止运行" : hasPreflightWarnings ? "存在警告项，可确认后继续" : "全部通过" }}
        </span>
        <div class="preflight-chip-list">
          <span
            v-for="check in preflightResult.checks"
            :key="check.id"
            :class="['preflight-chip', check.status]"
          >
            {{ check.label }}
          </span>
        </div>
      </div>
      <section v-if="definitionPreview" class="definition-preview">
        <div class="preview-header">
          <div>
            <p class="run-panel-label">Team Leader Preview</p>
            <h3>{{ definitionPreview.leaderAgentName }}</h3>
            <span>{{ definitionPreview.leaderPath }}</span>
          </div>
          <div class="preview-actions">
            <span :class="['preview-state', { changed: definitionPreview.changed }]">
              {{ definitionPreview.changed ? "检测到变更" : "内容无变化" }}
            </span>
            <button class="ghost-button" type="button" @click="closeDefinitionPreview">关闭</button>
            <button class="primary-button" type="button" :disabled="syncingDefinition" @click="confirmSyncDefinition">
              {{ syncingDefinition ? "写入中..." : "确认写入" }}
            </button>
          </div>
        </div>
        <div class="preview-grid">
          <div>
            <strong>当前文件</strong>
            <pre>{{ definitionPreview.currentMarkdown || "尚未生成 Team Leader 文件" }}</pre>
          </div>
          <div>
            <strong>即将写入</strong>
            <pre>{{ definitionPreview.nextMarkdown }}</pre>
          </div>
        </div>
      </section>

      <div class="workspace-body">
        <section class="control-panel">
          <div v-if="activeMenu === 'pipeline'" class="panel-section">
            <div class="toolbar-group">
              <div class="section-heading">
                <p>新建流水线</p>
                <span>创建或选择一条流程模板。</span>
              </div>
              <div class="inline-form">
                <input
                  ref="pipelineNameInput"
                  v-model="forms.pipelineName"
                  type="text"
                  placeholder="例如：核心研发流程"
                  @keyup.enter="createPipeline"
                />
                <button class="ghost-button compact" type="button" @click="createPipeline">+</button>
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
                @click="selectPipeline(pipeline)"
              >
                <strong>{{ pipeline.name }}</strong>
                <span>Stages: {{ pipeline.stages.length }}</span>
                <span>Leader: {{ pipeline.leaderAgentName }}</span>
                <span>{{ pipeline.projectPath }}</span>
              </button>
            </div>

            <div v-if="selectedPipeline" class="toolbar-group">
              <div class="section-heading tight">
                <p>添加阶段</p>
                <span>给当前流水线追加流程节点。</span>
              </div>
              <div class="inline-form">
                <input
                  ref="stageNameInput"
                  v-model="forms.stageName"
                  type="text"
                  placeholder="阶段名称，如：技术方案"
                  @keyup.enter="addStage"
                />
                <button class="secondary-button compact" type="button" @click="addStage">添加</button>
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
                :class="['order-card', { active: focusedStageId === stage.id }]"
                type="button"
                @click="focusStage(stage)"
              >
                <span>{{ index + 1 }}</span>
                <strong>{{ stage.name }}</strong>
              </button>
            </div>

            <div v-else class="panel-empty">请先创建或选择一条流水线。</div>

            <div class="toolbar-status">{{ lastAction }}</div>
          </div>

          <div v-if="activeMenu === 'policy'" class="panel-section policy-section">
            <div v-if="!selectedPipeline" class="panel-empty">请先创建或选择一条流水线。</div>
            <template v-else>
              <div class="toolbar-group policy-card wide">
                <div class="section-heading">
                  <p>委托升级策略</p>
                  <span>定义什么时候自己干、开 Sub Agent、启动 Agent Team。</span>
                </div>
                <select
                  :value="selectedPipeline.delegationPolicy.defaultMode"
                  @change="setPolicyValue('defaultMode', $event.target.value)"
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
                      @input="setPolicyValue('maxDepth', Number($event.target.value))"
                    />
                  </label>
                  <label>
                    <span>最大并行 Agent</span>
                    <input
                      :value="selectedPipeline.delegationPolicy.maxParallelAgents"
                      type="number"
                      min="1"
                      max="8"
                      @input="setPolicyValue('maxParallelAgents', Number($event.target.value))"
                    />
                  </label>
                </div>
              </div>

              <div class="toolbar-group policy-card">
                <div class="section-heading tight">
                  <p>授权边界</p>
                  <span>控制 Leader 能升级到什么程度。</span>
                </div>
                <button
                  :class="['policy-toggle', { active: selectedPipeline.delegationPolicy.allowSubAgents }]"
                  type="button"
                  @click="togglePolicyFlag('allowSubAgents')"
                >
                  允许创建 Sub Agent
                </button>
                <button
                  :class="['policy-toggle', { active: selectedPipeline.delegationPolicy.allowAgentTeam }]"
                  type="button"
                  @click="togglePolicyFlag('allowAgentTeam')"
                >
                  允许启动 Agent Team
                </button>
                <button
                  :class="['policy-toggle', { active: selectedPipeline.delegationPolicy.allowRecursiveDelegation }]"
                  type="button"
                  @click="togglePolicyFlag('allowRecursiveDelegation')"
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
                    @click="toggleApproval(approval.key)"
                  >
                    {{ approval.label }}
                  </button>
                </div>
              </div>

              <div class="toolbar-group policy-card rules-card">
                <div class="section-heading tight">
                  <p>升级规则</p>
                  <span>会写入 Team Leader 的角色描述。</span>
                </div>
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

              <div class="toolbar-status">决策模型会随同步写进 Team Leader</div>
            </template>
          </div>

          <div v-if="activeMenu === 'agent'" class="panel-section">
            <div v-if="!hasStages" class="panel-empty">请先添加阶段，再开始编辑 Agent 职责。</div>
            <template v-else>
              <div class="section-heading">
                <p>新增 Agent</p>
                <span>优先复用 Claude agents；没有合适的再新建托管 Agent。</span>
              </div>
              <div class="stack-form">
                <select v-model="forms.agentStageId">
                  <option value="" disabled>选择所属阶段</option>
                  <option v-for="stage in selectedPipeline.stages" :key="stage.id" :value="stage.id">
                    {{ stage.name }}
                  </option>
                </select>
                <select v-model="forms.sharedAgentName">
                  <option value="">新建 Agent，不复用</option>
                  <option v-for="agent in sharedClaudeAgents" :key="agent.name" :value="agent.name">
                    {{ agent.name }} · {{ agent.description || "无描述" }}
                  </option>
                </select>
                <input
                  v-model="forms.agentName"
                  type="text"
                  :disabled="!!forms.sharedAgentName"
                  placeholder="新建 Agent 名称"
                />
                <textarea
                  v-model="forms.agentResp"
                  rows="4"
                  placeholder="在本流水线里的职责补充：目标、边界、交付标准"
                ></textarea>
                <button class="primary-button" type="button" @click="addAgent">确认添加 Agent</button>
              </div>

              <div class="section-heading tight">
                <p>当前选中阶段</p>
                <span>{{ focusedStage ? focusedStage.name : "未选择阶段" }}</span>
              </div>

              <div v-if="focusedStage" class="inspector-card">
                <strong>{{ focusedStage.name }}</strong>
                <span>{{ focusedStage.agents.length }} 个 Agent</span>
                <button
                  v-for="agent in focusedStage.agents"
                  :key="agent.id"
                  :class="['mini-card', { active: focusedAgentId === agent.id }]"
                  type="button"
                  @click="focusAgent(focusedStage, agent)"
                >
                  <strong>{{ agent.name }}</strong>
                  <span>{{ agent.source === "shared" ? "共享" : "托管" }} · {{ agent.agentName }}</span>
                </button>
                <div v-if="!focusedStage.agents.length" class="mini-empty">这个阶段还没有 Agent。</div>
              </div>
            </template>
          </div>

          <div v-if="activeMenu === 'skill'" class="panel-section">
            <div v-if="!hasAgents" class="panel-empty">请先创建阶段和 Agent，再进行 Skill 装配。</div>
            <template v-else>
              <div class="section-heading">
                <p>装配 Skill</p>
                <span>给具体 Agent 绑定能力标签和版本号。</span>
              </div>
              <div class="stack-form">
                <select v-model="forms.skillStageId">
                  <option value="" disabled>选择阶段</option>
                  <option v-for="stage in selectedPipeline.stages" :key="stage.id" :value="stage.id">
                    {{ stage.name }}
                  </option>
                </select>
                <select v-model="forms.skillAgentId">
                  <option value="" disabled>选择 Agent</option>
                  <option v-for="agent in availableAgentsForSkill" :key="agent.id" :value="agent.id">
                    {{ agent.name }}
                  </option>
                </select>
                <div class="inline-form">
                  <input v-model="forms.skillName" type="text" placeholder="Skill 名称" />
                  <input v-model="forms.skillVersion" class="version-input" type="text" />
                </div>
                <button class="indigo-button" type="button" @click="addSkill">装配到 Agent</button>
              </div>

              <div class="section-heading tight">
                <p>当前 Agent</p>
                <span>{{ focusedAgent ? focusedAgent.name : "未选择 Agent" }}</span>
              </div>

              <div v-if="focusedAgent" class="inspector-card">
                <strong>{{ focusedAgent.name }}</strong>
                <span>{{ focusedAgent.responsibility || "暂未填写职责" }}</span>
                <div class="mini-tag-list">
                  <span v-for="skill in focusedAgent.skills" :key="skill.id" class="skill-tag">
                    {{ skill.name }} v{{ skill.version }}
                  </span>
                  <div v-if="!focusedAgent.skills.length" class="mini-empty">这个 Agent 还没有 Skill。</div>
                </div>
              </div>
            </template>
          </div>
        </section>

        <section class="canvas-panel">
          <div class="canvas-grid"></div>
          <div v-if="selectedPipeline" class="canvas-flow">
            <div v-if="selectedPipeline.stages.length" class="stage-lane">
              <template v-for="(stage, index) in selectedPipeline.stages" :key="stage.id">
                <div class="stage-column">
                  <article
                    :class="['stage-card', { active: focusedStageId === stage.id || activeMenu === 'stage' }]"
                    role="button"
                    tabindex="0"
                    @click="focusStage(stage)"
                    @keyup.enter="focusStage(stage)"
                  >
                    <div class="stage-icon">S{{ index + 1 }}</div>
                    <p>STAGE {{ index + 1 }}</p>
                    <h3>{{ stage.name }}</h3>
                  </article>

                  <div class="agent-list">
                    <article
                      v-for="agent in stage.agents"
                      :key="agent.id"
                      :class="['agent-card', { active: focusedAgentId === agent.id || activeMenu === 'agent' }]"
                      role="button"
                      tabindex="0"
                      @click="focusAgent(stage, agent)"
                      @keyup.enter="focusAgent(stage, agent)"
                    >
                      <div class="agent-head">
                        <strong>{{ agent.name }}</strong>
                        <span>Agent</span>
                      </div>
                      <textarea v-model="agent.responsibility" rows="3" @click.stop></textarea>
                      <div class="skill-tags">
                        <span v-for="skill in agent.skills" :key="skill.id" class="skill-tag">
                          {{ skill.name }} v{{ skill.version }}
                        </span>
                        <span v-if="!agent.skills.length" class="skill-placeholder">No Skills</span>
                      </div>
                    </article>

                    <div v-if="!stage.agents.length" class="agent-placeholder">等待添加 Agent</div>
                  </div>
                </div>

                <div v-if="flowPaths[index]" class="flow-connector" :class="{ active: activeMenu === 'stage' }">
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
      </div>
    </main>

    <main v-else class="workspace run-workspace">
      <header class="workspace-header run-header">
        <div class="header-main">
          <div>
            <p class="header-kicker">Run Console</p>
            <h2>{{ currentRun?.pipeline?.name || "运行控制台" }}</h2>
          </div>
          <div class="pipeline-pill">
            <span>Run ID</span>
            <strong>{{ currentRun?.runId }}</strong>
          </div>
          <div class="pipeline-pill">
            <span>状态</span>
            <strong>{{ currentRun?.status }}</strong>
          </div>
        </div>
        <div class="header-actions">
          <button class="ghost-button" type="button" @click="backToStudio">返回编排</button>
          <button class="primary-button danger-button" type="button" @click="stopRun">停止记录</button>
        </div>
      </header>

      <div class="run-console">
        <aside class="run-stage-panel">
          <p class="run-panel-label">阶段进度</p>
          <div
            v-for="(stage, index) in currentRun?.pipeline?.stages || []"
            :key="stage.id || stage.name"
            class="run-stage-card"
          >
            <span>{{ index + 1 }}</span>
            <div>
              <strong>{{ stage.name }}</strong>
              <p>{{ stage.agents.length }} Agent</p>
            </div>
          </div>
        </aside>

        <section class="terminal-panel launch-panel">
          <p class="run-panel-label">一键启动</p>
          <h3>打开 iTerm2 并启动 Claude Team Leader</h3>
          <p>
            系统会在 iTerm2 中进入项目目录，然后执行
            <code>claude --agent {{ currentRun?.pipeline?.leaderAgentName }}</code>，并把右侧需求作为首条任务交给 Claude。
          </p>
          <div class="launch-command-preview">
            <span>项目目录</span>
            <strong>{{ currentRun?.pipeline?.projectPath }}</strong>
            <span>Claude Agent</span>
            <strong>{{ currentRun?.pipeline?.leaderAgentName }}</strong>
            <span>决策模型</span>
            <strong>
              {{ currentRun?.pipeline?.delegationPolicy?.defaultMode }}
              · Depth {{ currentRun?.pipeline?.delegationPolicy?.maxDepth }}
              · Parallel {{ currentRun?.pipeline?.delegationPolicy?.maxParallelAgents }}
            </strong>
          </div>
          <div v-if="activePreflightChecks.length" class="run-checks">
            <div class="section-heading tight">
              <p>启动前检查</p>
              <span>失败项会阻止运行，警告项会保留在这里供确认。</span>
            </div>
            <div
              v-for="check in activePreflightChecks"
              :key="check.id"
              :class="['run-check-card', check.status]"
            >
              <strong>{{ check.label }}</strong>
              <span>{{ check.status }}</span>
              <p>{{ check.detail }}</p>
            </div>
          </div>
          <button class="primary-button launch-button" type="button" :disabled="launchingITerm" @click="openInITerm">
            {{ launchingITerm ? "打开中..." : "一键打开 iTerm2" }}
          </button>
          <div class="toolbar-status">{{ launchStatus }}</div>
        </section>

        <aside class="requirement-panel">
          <p class="run-panel-label">需求输入</p>
          <textarea
            v-model="requirementText"
            rows="8"
            placeholder="输入需求，例如：实现手机号验证码登录，包含发送验证码、登录态和失败提示。"
          ></textarea>
          <button class="primary-button" type="button" :disabled="launchingITerm" @click="openInITerm">
            {{ launchingITerm ? "启动中..." : "一键启动" }}
          </button>
          <div class="requirement-tip">
            这段需求会作为 Claude 启动 prompt 的一部分传入 iTerm2。
          </div>
        </aside>
      </div>
    </main>
  </div>
</template>
