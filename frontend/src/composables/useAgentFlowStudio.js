import { computed, onMounted, reactive, ref, toRefs, watch } from "vue";
import { apiGet, apiPost, clonePayload } from "../lib/api.js";

const DEFAULT_PROJECT_PATH = ".";
const DEFAULT_CLAUDE_DIR = "~/.claude";

const approvalOptions = [
  { key: "requirement-review", label: "需求确认" },
  { key: "architecture-review", label: "方案确认" },
  { key: "write-files", label: "写文件前" },
  { key: "run-command", label: "运行命令前" },
  { key: "completion-review", label: "完成验收" },
  { key: "deployment", label: "部署上线" },
  { key: "destructive-command", label: "破坏性命令" },
];

const menuItems = [
  { key: "pipeline", label: "流程编排", icon: "flow" },
  { key: "policy", label: "策略模型", icon: "decision" },
  { key: "agent", label: "Agent 职责", icon: "bot" },
  { key: "skill", label: "Skill 管理", icon: "spark" },
  { key: "compile", label: "编译预览", icon: "compile" },
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

const defaultQualityGates = [
  {
    id: "requirement-review",
    name: "需求确认",
    type: "human",
    required: true,
    description: "需求边界、验收标准和风险必须人工确认。",
  },
  {
    id: "architecture-review",
    name: "方案确认",
    type: "human",
    required: true,
    description: "架构方案、接口契约和测试策略必须人工确认。",
  },
  {
    id: "write-files",
    name: "写文件前",
    type: "human",
    required: true,
    description: "开始写入项目文件前需要确认改动边界。",
  },
  {
    id: "completion-review",
    name: "完成验收",
    type: "human",
    required: true,
    description: "完成后必须回顾产物、测试和风险。",
  },
];

const defaultPipelines = [
  normalizePipeline({
    id: "p1",
    name: "核心研发流程",
    leaderAgentName: "agentflow-core-rd-team-leader",
    projectPath: DEFAULT_PROJECT_PATH,
    claudeDir: DEFAULT_CLAUDE_DIR,
    sharedAgentsDir: defaultSharedAgentsDir(DEFAULT_CLAUDE_DIR),
    delegationPolicy: clonePayload(defaultDelegationPolicy),
    qualityGates: clonePayload(defaultQualityGates),
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
            skills: [
              {
                id: "sk1",
                name: "user_story",
                version: "1.0.0",
                path: ".claude/skills/user-story",
              },
            ],
            watch: ["UserRequirement"],
            produce: ["PRD", "AcceptanceCriteria", "RiskRegister"],
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
            skills: [
              {
                id: "sk2",
                name: "architecture_review",
                version: "1.2.0",
                path: ".claude/skills/architecture-review",
              },
            ],
            watch: ["PRD", "AcceptanceCriteria", "RiskRegister"],
            produce: ["Architecture", "ADR", "APISpec"],
          },
        ],
      },
      {
        id: "s3",
        name: "开发实现",
        agents: [],
      },
    ],
  }),
];

export function useAgentFlowStudio() {
  const state = reactive({
    activeView: "studio",
    activeMenu: "pipeline",
    selectedPipelineId: "p1",
    focusedStageId: "",
    focusedAgentId: "",
    mobileNavOpen: false,
    sidebarCollapsed: false,
    editorPanelCollapsed: false,
    canvasPanelCollapsed: false,
    preflightPanelOpen: false,
    pipelines: loadPersistedPipelines(),
    forms: {
      pipelineName: "",
      leaderAgentName: "",
      projectPath: DEFAULT_PROJECT_PATH,
      claudeDir: DEFAULT_CLAUDE_DIR,
      sharedAgentsDir: defaultSharedAgentsDir(DEFAULT_CLAUDE_DIR),
      stageName: "",
      agentStageId: "",
      sharedAgentName: "",
      agentName: "",
      agentResp: "",
      skillStageId: "",
      skillAgentId: "",
      skillName: "",
      skillVersion: "1.0.0",
      skillPath: "",
    },
  });

  if (!state.pipelines.some((pipeline) => pipeline.id === state.selectedPipelineId)) {
    state.selectedPipelineId = state.pipelines[0]?.id ?? "";
  }

  const lastAction = ref("等待操作");
  const requirementText = ref("");
  const runError = ref("");
  const runStarting = ref(false);
  const compiling = ref(false);
  const applyingCompile = ref(false);
  const launchingITerm = ref(false);
  const currentRun = ref(null);
  const launchStatus = ref("等待填写需求");
  const launchMode = ref("single-leader");
  const launchPreview = ref(null);
  const availableClaudeAgents = ref([]);
  const compilePreview = ref(null);
  const selectedArtifactIndex = ref(0);
  const preflightResult = ref(null);
  const preflightChecking = ref(false);
  const preflightError = ref("");
  const lintResult = ref(null);
  let preflightTimer = 0;

  const selectedPipeline = computed(() =>
    state.pipelines.find((pipeline) => pipeline.id === state.selectedPipelineId) ?? null
  );

  const currentMenuLabel = computed(
    () => menuItems.find((item) => item.key === state.activeMenu)?.label ?? "工作台"
  );
  const selectedClaudeDir = computed(() => selectedPipeline.value?.claudeDir || DEFAULT_CLAUDE_DIR);
  const selectedSharedAgentsDir = computed(
    () => selectedPipeline.value?.sharedAgentsDir || defaultSharedAgentsDir(selectedClaudeDir.value)
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
    availableClaudeAgents.value.filter((agent) => !agent.agentName.endsWith("-team-leader"))
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
  const preflightSummary = computed(() =>
    summarizePreflight(preflightResult.value, preflightChecking.value, preflightError.value)
  );

  const compileIssues = computed(() => compilePreview.value?.issues || lintResult.value?.issues || []);
  const hasCompileFailures = computed(() => compileIssues.value.some((issue) => issue.status === "fail"));

  const selectedArtifact = computed(() => {
    const artifacts = compilePreview.value?.artifacts || [];
    return artifacts[selectedArtifactIndex.value] || artifacts[0] || null;
  });

  const stageStats = computed(() => {
    if (!selectedPipeline.value) return { stageCount: 0, agentCount: 0, skillCount: 0, actionCount: 0, depth: 0 };

    const summary = selectedPipeline.value.stages.reduce(
      (summary, stage) => {
        summary.stageCount += 1;
        summary.agentCount += stage.agents.length;
        summary.actionCount += stage.actions.length;
        summary.skillCount += stage.agents.reduce((total, agent) => total + agent.skills.length, 0);
        return summary;
      },
      { stageCount: 0, agentCount: 0, skillCount: 0, actionCount: 0 }
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
      syncFocusForPipeline(state, pipeline);
      state.forms.projectPath = pipeline?.projectPath || DEFAULT_PROJECT_PATH;
      state.forms.claudeDir = pipeline?.claudeDir || DEFAULT_CLAUDE_DIR;
      state.forms.sharedAgentsDir = pipeline?.sharedAgentsDir || defaultSharedAgentsDir(pipeline?.claudeDir || DEFAULT_CLAUDE_DIR);
    },
    { immediate: true }
  );

  watch(
    selectedPipeline,
    () => {
      schedulePreflight();
    },
    { deep: true }
  );

  watch(
    selectedSharedAgentsDir,
    () => {
      scheduleLoadAvailableAgents();
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

  function createPipeline() {
    const name = state.forms.pipelineName.trim();
    if (!name) {
      lastAction.value = "请输入流水线名称";
      return;
    }

    const pipelineId = createId("p");
    const pipeline = normalizePipeline({
      id: pipelineId,
      name,
      leaderAgentName: state.forms.leaderAgentName.trim() || toLeaderAgentName(name, pipelineId),
      projectPath: state.forms.projectPath.trim() || DEFAULT_PROJECT_PATH,
      claudeDir: state.forms.claudeDir.trim() || DEFAULT_CLAUDE_DIR,
      sharedAgentsDir: state.forms.sharedAgentsDir.trim() || defaultSharedAgentsDir(state.forms.claudeDir.trim() || DEFAULT_CLAUDE_DIR),
      delegationPolicy: clonePayload(defaultDelegationPolicy),
      qualityGates: clonePayload(defaultQualityGates),
      stages: [],
    });

    state.pipelines.push(pipeline);
    state.selectedPipelineId = pipeline.id;
    state.focusedStageId = "";
    state.focusedAgentId = "";
    state.forms.pipelineName = "";
    state.forms.leaderAgentName = "";
    state.forms.projectPath = pipeline.projectPath;
    state.forms.claudeDir = pipeline.claudeDir;
    state.forms.sharedAgentsDir = pipeline.sharedAgentsDir;
    state.forms.stageName = "";
    state.activeMenu = "pipeline";
    lastAction.value = `已创建本地流水线：${pipeline.name}`;
  }

  function deletePipeline(pipeline) {
    if (!pipeline) return;
    const index = state.pipelines.findIndex((item) => item.id === pipeline.id);
    if (index < 0) return;
    if (!confirmDelete(`删除流水线「${pipeline.name}」？此操作会同时移除它的阶段、Agent 和 Skill 引用。`)) return;

    const deletingSelected = state.selectedPipelineId === pipeline.id;
    state.pipelines.splice(index, 1);
    clearCompileAndPreflightState();

    if (!state.pipelines.length) {
      state.selectedPipelineId = "";
      syncFocusForPipeline(state, null);
      state.forms.projectPath = DEFAULT_PROJECT_PATH;
      state.forms.claudeDir = DEFAULT_CLAUDE_DIR;
      state.forms.sharedAgentsDir = defaultSharedAgentsDir(DEFAULT_CLAUDE_DIR);
      lastAction.value = `已删除流水线：${pipeline.name}`;
      return;
    }

    if (deletingSelected) {
      const nextPipeline = state.pipelines[index] || state.pipelines[index - 1] || state.pipelines[0] || null;
      state.selectedPipelineId = nextPipeline?.id || "";
      syncFocusForPipeline(state, nextPipeline);
    } else {
      const currentPipeline = state.pipelines.find((item) => item.id === state.selectedPipelineId) || state.pipelines[0] || null;
      state.selectedPipelineId = currentPipeline?.id || "";
      syncFocusForPipeline(state, currentPipeline);
    }

    lastAction.value = `已删除流水线：${pipeline.name}`;
  }

  function addStage() {
    const pipeline = selectedPipeline.value;
    const name = state.forms.stageName.trim();
    if (!pipeline) {
      lastAction.value = "请先选择流水线";
      return;
    }
    if (!name) {
      lastAction.value = "请输入阶段名称";
      return;
    }

    addStageAt(pipeline.stages.length, name);
  }

  function addStageAt(index = null, rawName = "") {
    const pipeline = selectedPipeline.value;
    if (!pipeline) {
      lastAction.value = "请先选择流水线";
      return;
    }

    const insertIndex = Number.isInteger(index)
      ? Math.max(0, Math.min(index, pipeline.stages.length))
      : pipeline.stages.length;
    const stageName = String(rawName || "").trim() || `新阶段 ${insertIndex + 1}`;
    const stageId = createId("s");
    const previousOutputs = insertIndex > 0
      ? inferStageOutputs(pipeline.stages[insertIndex - 1])
      : ["UserRequirement"];
    const stage = {
      id: stageId,
      name: stageName,
      agents: [],
      actions: [buildDefaultAction(stageId, stageName, [], previousOutputs)],
    };

    pipeline.stages.splice(insertIndex, 0, stage);
    syncDerivedPipeline(pipeline);
    state.focusedStageId = stage.id;
    state.focusedAgentId = "";
    state.forms.stageName = "";
    state.forms.agentStageId = stage.id;
    state.forms.skillStageId = stage.id;
    state.forms.skillAgentId = "";
    lastAction.value = `已添加阶段：${stage.name}`;
  }

  function deleteStage(stage) {
    const pipeline = selectedPipeline.value;
    if (!pipeline || !stage) return;

    const index = pipeline.stages.findIndex((item) => item.id === stage.id);
    if (index < 0) return;
    if (!confirmDelete(`删除阶段「${stage.name}」？该阶段下的 Agent、Action 和 Skill 会一起移除。`)) return;

    const wasFocused = state.focusedStageId === stage.id;
    pipeline.stages.splice(index, 1);
    syncDerivedPipeline(pipeline);

    if (!pipeline.stages.length) {
      syncFocusForPipeline(state, pipeline);
      lastAction.value = `已删除阶段：${stage.name}`;
      return;
    }

    if (wasFocused) {
      const nextStage = pipeline.stages[index] || pipeline.stages[index - 1] || pipeline.stages[0] || null;
      if (nextStage) {
        focusStage(nextStage);
      } else {
        syncFocusForPipeline(state, pipeline);
      }
    } else {
      syncFocusForPipeline(state, pipeline);
    }

    lastAction.value = `已删除阶段：${stage.name}`;
  }

  function addAgent() {
    const pipeline = selectedPipeline.value;
    if (!pipeline || !state.forms.agentStageId) return;

    const stage = pipeline.stages.find((item) => item.id === state.forms.agentStageId);
    if (!stage) return;

    const sharedAgent = sharedClaudeAgents.value.find((agent) => agent.agentName === state.forms.sharedAgentName);
    const name = state.forms.agentName.trim();
    if (!sharedAgent && !name) return;
    const roleName = name || sharedAgent?.name || sharedAgent?.agentName || "未命名 Agent";

    const agent = normalizeAgent({
      id: createId("a"),
      name: roleName,
      agentName: sharedAgent ? sharedAgent.agentName : toAgentName(name),
      description: sharedAgent?.description || `${roleName} for AgentFlow pipeline.`,
      responsibility: state.forms.agentResp.trim() || sharedAgent?.description || "",
      source: sharedAgent ? "shared" : "managed",
      model: sharedAgent?.model || "sonnet",
      tools: sharedAgent?.tools || ["Read", "Write", "Edit", "Grep", "Glob"],
      watch: inferWatchForStage(pipeline, stage),
      produce: inferProduce(stage.name, name || sharedAgent?.name),
      skills: [],
    }, stage.name, inferWatchForStage(pipeline, stage));

    stage.agents.push(agent);
    if (stage.actions[0] && !stage.actions[0].owner) {
      stage.actions[0].owner = agent.agentName;
      stage.actions[0].outputs = [...agent.produce];
    }
    syncDerivedPipeline(pipeline);
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

  function deleteAgent(stage, agent) {
    const pipeline = selectedPipeline.value;
    if (!pipeline || !stage || !agent) return;

    const index = stage.agents.findIndex((item) => item.id === agent.id);
    if (index < 0) return;
    if (!confirmDelete(`删除 Agent「${agent.name}」？该角色绑定的 Skill 目录也会一起移除。`)) return;

    stage.agents.splice(index, 1);
    const fallbackOwner = stage.agents[0]?.agentName || "";
    for (const action of stage.actions) {
      if (action.owner === agent.agentName) {
        action.owner = fallbackOwner;
      }
    }

    syncDerivedPipeline(pipeline);

    if (state.focusedAgentId === agent.id) {
      const nextAgent = stage.agents[index] || stage.agents[index - 1] || null;
      if (nextAgent) {
        focusAgent(stage, nextAgent);
      } else {
        focusStage(stage);
      }
    } else {
      syncFocusForPipeline(state, pipeline);
    }

    lastAction.value = `已删除 Agent：${agent.name}`;
  }

  function addSkill() {
    const pipeline = selectedPipeline.value;
    if (!pipeline || !state.forms.skillStageId || !state.forms.skillAgentId) return;

    const stage = pipeline.stages.find((item) => item.id === state.forms.skillStageId);
    const agent = stage?.agents.find((item) => item.id === state.forms.skillAgentId);
    const path = state.forms.skillPath.trim();
    const name = state.forms.skillName.trim() || skillNameFromPath(path);
    if (!agent || !path) return;

    agent.skills.push({
      id: createId("sk"),
      name,
      version: state.forms.skillVersion.trim() || "1.0.0",
      path,
    });
    state.forms.skillName = "";
    state.forms.skillPath = "";
    syncDerivedPipeline(pipeline);
    lastAction.value = `已为 ${agent.name} 绑定 Skill 目录：${path}`;
  }

  function deleteSkill(skill) {
    const pipeline = selectedPipeline.value;
    const agent = focusedAgent.value;
    if (!pipeline || !agent || !skill) return;

    const index = agent.skills.findIndex((item) => item.id === skill.id);
    if (index < 0) return;
    if (!confirmDelete(`移除 Skill「${skill.name}」？只会删除当前 Agent 的目录绑定，不会删除磁盘目录。`)) return;

    agent.skills.splice(index, 1);
    syncDerivedPipeline(pipeline);
    lastAction.value = `已移除 Skill：${skill.name}`;
  }

  function setSkillField(skill, key, value) {
    const pipeline = selectedPipeline.value;
    const agent = focusedAgent.value;
    if (!pipeline || !agent || !skill) return;

    const nextValue = typeof value === "string" ? value.trim() : value;
    if (key === "name") {
      skill.name = nextValue || skillNameFromPath(skill.path) || "unnamed_skill";
    } else if (key === "version") {
      skill.version = nextValue || "latest";
    } else if (key === "path") {
      skill.path = nextValue || "";
      if (!skill.name || skill.name === "unnamed_skill") {
        skill.name = skillNameFromPath(skill.path) || "unnamed_skill";
      }
    } else {
      skill[key] = nextValue;
    }

    syncDerivedPipeline(pipeline);
    lastAction.value = `已更新 Skill：${skill.name}`;
  }

  function addAction(stage) {
    const owner = stage.agents[0]?.agentName || "";
    stage.actions.push({
      id: createId("act"),
      name: `${stage.name} 交付`,
      owner,
      inputs: inferWatchForStage(selectedPipeline.value, stage),
      outputs: owner ? stage.agents[0]?.produce || inferProduce(stage.name, "") : inferProduce(stage.name, ""),
      gates: [],
    });
    syncDerivedPipeline(selectedPipeline.value);
  }

  function deleteAction(stage, action) {
    const pipeline = selectedPipeline.value;
    if (!pipeline || !stage || !action) return;

    if (stage.actions.length <= 1) {
      lastAction.value = `阶段「${stage.name}」至少保留 1 个 Action`;
      return;
    }

    const index = stage.actions.findIndex((item) => item.id === action.id);
    if (index < 0) return;
    if (!confirmDelete(`删除 Action「${action.name}」？`)) return;

    stage.actions.splice(index, 1);
    syncDerivedPipeline(pipeline);
    lastAction.value = `已删除 Action：${action.name}`;
  }

  function setAgentField(stage, agent, key, value) {
    if (!selectedPipeline.value || !stage || !agent) return;

    const nextValue = typeof value === "string" ? value.trim() : value;
    const previousAgentName = agent.agentName;

    if (key === "name") {
      agent.name = nextValue || "未命名 Agent";
    } else if (key === "agentName") {
      agent.agentName = nextValue || previousAgentName;
      const boundSharedAgent = sharedClaudeAgents.value.find((item) => item.agentName === agent.agentName);
      if (boundSharedAgent) {
        agent.description = boundSharedAgent.description || agent.description;
        agent.model = boundSharedAgent.model || agent.model;
        agent.tools = boundSharedAgent.tools?.length ? [...boundSharedAgent.tools] : agent.tools;
      }
      for (const action of stage.actions) {
        if (action.owner === previousAgentName) {
          action.owner = agent.agentName;
        }
      }
    } else if (key === "responsibility") {
      agent.responsibility = nextValue;
    } else {
      agent[key] = nextValue;
    }

    syncDerivedPipeline(selectedPipeline.value);
    lastAction.value = `已更新 Agent：${agent.name}`;
  }

  function setPipelineField(key, value) {
    if (!selectedPipeline.value) return;
    if (key === "claudeDir") {
      const currentSharedDir = selectedPipeline.value.sharedAgentsDir || defaultSharedAgentsDir(selectedPipeline.value.claudeDir);
      const previousDefaultSharedDir = defaultSharedAgentsDir(selectedPipeline.value.claudeDir || DEFAULT_CLAUDE_DIR);
      if (!currentSharedDir || currentSharedDir === previousDefaultSharedDir) {
        selectedPipeline.value.sharedAgentsDir = defaultSharedAgentsDir(value || DEFAULT_CLAUDE_DIR);
      }
    }
    if (key === "projectPath") {
      selectedPipeline.value[key] = value || DEFAULT_PROJECT_PATH;
    } else if (key === "claudeDir") {
      selectedPipeline.value[key] = value || DEFAULT_CLAUDE_DIR;
    } else if (key === "sharedAgentsDir") {
      selectedPipeline.value[key] = value || defaultSharedAgentsDir(selectedPipeline.value.claudeDir || DEFAULT_CLAUDE_DIR);
    } else {
      selectedPipeline.value[key] = value;
    }
    syncDerivedPipeline(selectedPipeline.value);
    lastAction.value = `已更新${pipelineFieldLabel(key)}`;
  }

  function setStageField(stage, key, value) {
    if (!selectedPipeline.value || !stage) return;
    stage[key] = value;
    syncDerivedPipeline(selectedPipeline.value);
    lastAction.value = `已更新阶段${stage.name || ""}`;
  }

  function moveStage(stage, direction) {
    if (!selectedPipeline.value || !stage) return;
    moveItem(selectedPipeline.value.stages, stage.id, direction);
    syncDerivedPipeline(selectedPipeline.value);
    focusStage(stage);
    lastAction.value = `${stage.name} 已${direction < 0 ? "上移" : "下移"}`;
  }

  function moveStageToIndex(stageId, targetIndex) {
    const pipeline = selectedPipeline.value;
    if (!pipeline) return;

    const currentIndex = pipeline.stages.findIndex((stage) => stage.id === stageId);
    if (currentIndex < 0) return;

    const boundedTarget = Math.max(0, Math.min(targetIndex, pipeline.stages.length));
    const insertIndex = currentIndex < boundedTarget ? boundedTarget - 1 : boundedTarget;
    if (insertIndex === currentIndex) return;

    const [stage] = pipeline.stages.splice(currentIndex, 1);
    pipeline.stages.splice(insertIndex, 0, stage);
    syncDerivedPipeline(pipeline);
    focusStage(stage);
    lastAction.value = `${stage.name} 已调整到第 ${insertIndex + 1} 位`;
  }

  function moveAction(stage, action, direction) {
    if (!selectedPipeline.value || !stage || !action) return;
    moveItem(stage.actions, action.id, direction);
    syncDerivedPipeline(selectedPipeline.value);
    lastAction.value = `${action.name} 已${direction < 0 ? "上移" : "下移"}`;
  }

  function addQualityGate() {
    if (!selectedPipeline.value) return;
    selectedPipeline.value.qualityGates.push({
      id: createId("gate"),
      name: "新门禁",
      type: "human",
      required: true,
      description: "",
    });
    syncDerivedPipeline(selectedPipeline.value);
  }

  function deleteQualityGate(gate) {
    const pipeline = selectedPipeline.value;
    if (!pipeline || !gate) return;

    const index = pipeline.qualityGates.findIndex((item) => item.id === gate.id);
    if (index < 0) return;
    if (!confirmDelete(`删除质量门禁「${gate.name || gate.id}」？如果还有 Action 引用它，编译会提示你修复。`)) return;

    pipeline.qualityGates.splice(index, 1);
    pipeline.delegationPolicy.requireHumanApprovalFor = pipeline.delegationPolicy.requireHumanApprovalFor.filter(
      (item) => item !== gate.id
    );
    syncDerivedPipeline(pipeline);
    lastAction.value = `已删除质量门禁：${gate.name || gate.id}`;
  }

  function focusStage(stage) {
    if (!stage) return;
    state.focusedStageId = stage.id;
    state.focusedAgentId = stage.agents[0]?.id ?? "";
    state.forms.agentStageId = stage.id;
    state.forms.skillStageId = stage.id;
    state.forms.skillAgentId = stage.agents[0]?.id ?? "";
  }

  function focusAgent(stage, agent) {
    if (!stage || !agent) return;
    state.focusedStageId = stage.id;
    state.focusedAgentId = agent.id;
    state.forms.agentStageId = stage.id;
    state.forms.skillStageId = stage.id;
    state.forms.skillAgentId = agent.id;
  }

  function resetDemoData() {
    state.pipelines = clonePayload(defaultPipelines);
    state.selectedPipelineId = state.pipelines[0]?.id ?? "";
    syncFocusForPipeline(state, state.pipelines[0]);
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
    selectedPipeline.value.delegationPolicy.requireHumanApprovalFor = approvals.includes(key)
      ? approvals.filter((item) => item !== key)
      : [...approvals, key];
  }

  function setCsvList(target, key, value) {
    target[key] = csvToList(value);
    if (selectedPipeline.value) syncDerivedPipeline(selectedPipeline.value);
  }

  function csvValue(value) {
    return Array.isArray(value) ? value.join(", ") : "";
  }

  async function loadDefinition() {
    try {
      const definition = await apiGet("/api/definition");
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
      syncFocusForPipeline(state, selected);
      state.forms.projectPath = selected?.projectPath || DEFAULT_PROJECT_PATH;
      lastAction.value = `已加载 ${state.pipelines.length} 条 DSL v3 流水线定义`;
    } catch {
      lastAction.value = "未连接 orchestrator，使用浏览器本地配置";
    }
  }

  async function loadAvailableAgents() {
    try {
      const payload = await apiGet(
        `/api/agents?claudeDir=${encodeURIComponent(selectedClaudeDir.value)}&sharedAgentsDir=${encodeURIComponent(selectedSharedAgentsDir.value)}`
      );
      availableClaudeAgents.value = payload.agents || [];
    } catch {
      availableClaudeAgents.value = [];
    }
  }

  async function runLint() {
    if (!selectedPipeline.value) return null;
    const payload = await apiPost("/api/lint", definitionPayload());
    lintResult.value = payload;
    return payload;
  }

  async function previewCompile() {
    if (!selectedPipeline.value) {
      lastAction.value = "请先选择流水线";
      return;
    }

    compiling.value = true;
    try {
      const preflightPromise = refreshPreflight({ silent: true });
      const payload = await apiPost("/api/compile/preview", definitionPayload());
      await preflightPromise.catch(() => null);
      compilePreview.value = payload;
      selectedArtifactIndex.value = 0;
      lintResult.value = { ok: payload.ok, issues: payload.issues || [] };
      state.activeMenu = "compile";
      lastAction.value = payload.ok
        ? `已生成 ${payload.artifacts?.length || 0} 个编译产物预览`
        : "编译预览发现失败项，请先修复";
    } catch (error) {
      lastAction.value = error.message;
    } finally {
      compiling.value = false;
    }
  }

  async function applyCompile() {
    if (!selectedPipeline.value) return null;
    applyingCompile.value = true;
    try {
      const payload = await apiPost("/api/compile/apply", definitionPayload());
      state.pipelines = normalizePipelines(payload.definition?.pipelines || state.pipelines);
      state.selectedPipelineId = payload.definition?.selectedPipelineId || state.selectedPipelineId;
      compilePreview.value = {
        ...compilePreview.value,
        ok: true,
        issues: payload.issues || [],
        written: payload.written || [],
      };
      await loadAvailableAgents();
      lastAction.value = `已写入 ${payload.written?.length || 0} 个编译产物`;
      return payload;
    } catch (error) {
      lastAction.value = error.message;
      throw error;
    } finally {
      applyingCompile.value = false;
    }
  }

  async function startRun() {
    if (!selectedPipeline.value) {
      runError.value = "请先创建或选择流水线";
      return;
    }

    runStarting.value = true;
    runError.value = "";

    try {
      const preflight = await refreshPreflight({ silent: false, throwOnError: true });
      if (!preflight.ok) {
        throw new Error("启动前预检失败，请先修复失败项");
      }

      const compilePayload = await applyCompile();
      const pipelineSnapshot = compilePayload.definition?.pipeline || clonePayload(selectedPipeline.value);
      const payload = await apiPost("/api/runs", {
        pipeline: pipelineSnapshot,
        requirement: requirementText.value,
        launchMode: launchMode.value,
      });

      currentRun.value = { ...payload, preflight, compile: compilePayload };
      state.activeView = "run";
      launchStatus.value = hasPreflightWarnings.value
        ? "已创建运行，存在预检警告，请确认后点击一键启动"
        : "已创建运行，请确认需求后点击一键启动";
      await refreshLaunchPreview();
    } catch (error) {
      runError.value = error.message;
    } finally {
      runStarting.value = false;
    }
  }

  async function refreshLaunchPreview() {
    const pipeline = currentRun.value?.pipeline || selectedPipeline.value;
    if (!pipeline) return;
    launchPreview.value = await apiPost("/api/launch-prompt/preview", {
      pipeline: clonePayload(pipeline),
      requirement: requirementText.value,
      launchMode: launchMode.value,
    });
  }

  async function openInITerm() {
    if (!currentRun.value?.runId || launchingITerm.value) return;
    launchingITerm.value = true;
    launchStatus.value = "正在打开 iTerm2...";

    try {
      const payload = await apiPost(`/api/runs/${currentRun.value.runId}/open-iterm`, {
        requirement: requirementText.value.trim(),
        launchMode: launchMode.value,
      });
      currentRun.value = { ...payload, preflight: currentRun.value?.preflight, compile: currentRun.value?.compile };
      launchStatus.value = "已打开 iTerm2，Claude 已在项目目录启动";
    } catch (error) {
      launchStatus.value = error.message;
    } finally {
      launchingITerm.value = false;
    }
  }

  async function stopRun() {
    if (!currentRun.value?.runId) return;
    await apiPost(`/api/runs/${currentRun.value.runId}/stop`, {}).catch(() => {});
    currentRun.value = { ...currentRun.value, status: "stopped" };
    launchStatus.value = "已停止记录；如 iTerm2 已打开，请在终端中自行结束 Claude";
  }

  function backToStudio() {
    state.activeView = "studio";
  }

  function definitionPayload() {
    return {
      pipeline: clonePayload(selectedPipeline.value),
      pipelines: clonePayload(state.pipelines),
      selectedPipelineId: state.selectedPipelineId,
    };
  }

  function togglePreflightPanel() {
    state.preflightPanelOpen = !state.preflightPanelOpen;
    if (state.preflightPanelOpen) {
      refreshPreflight({ silent: false }).catch(() => {});
    }
  }

  function schedulePreflight() {
    window.clearTimeout(preflightTimer);
    if (!selectedPipeline.value) return;
    preflightTimer = window.setTimeout(() => {
      refreshPreflight({ silent: true }).catch(() => {});
    }, 900);
  }

  function scheduleLoadAvailableAgents() {
    window.clearTimeout(scheduleLoadAvailableAgents.timer);
    scheduleLoadAvailableAgents.timer = window.setTimeout(() => {
      loadAvailableAgents();
    }, 350);
  }

  async function refreshPreflight(options = {}) {
    const { silent = true, throwOnError = false } = options;
    if (!selectedPipeline.value) return null;

    preflightChecking.value = true;
    preflightError.value = "";

    try {
      const payload = await apiPost("/api/preflight", { pipeline: clonePayload(selectedPipeline.value) });
      preflightResult.value = payload;
      if (!payload.ok && !silent) {
        state.preflightPanelOpen = true;
      }
      if (!silent) {
        lastAction.value = payload.ok ? "启动前预检通过" : "启动前预检存在失败项";
      }
      return payload;
    } catch (error) {
      preflightError.value = error.message;
      if (!silent) lastAction.value = error.message;
      if (throwOnError) throw error;
      return null;
    } finally {
      preflightChecking.value = false;
    }
  }

  function clearCompileAndPreflightState() {
    compilePreview.value = null;
    selectedArtifactIndex.value = 0;
    preflightResult.value = null;
    preflightError.value = "";
    lintResult.value = null;
  }

  onMounted(() => {
    loadDefinition();
    loadAvailableAgents();
    schedulePreflight();
  });

  return {
    ...toRefs(state),
    menuItems,
    approvalOptions,
    lastAction,
    requirementText,
    runError,
    runStarting,
    compiling,
    applyingCompile,
    launchingITerm,
    currentRun,
    launchStatus,
    launchMode,
    launchPreview,
    availableClaudeAgents,
    compilePreview,
    selectedArtifactIndex,
    selectedArtifact,
    preflightResult,
    preflightChecking,
    preflightError,
    preflightSummary,
    lintResult,
    selectedPipeline,
    currentMenuLabel,
    hasStages,
    hasAgents,
    availableAgentsForSkill,
    sharedClaudeAgents,
    focusedStage,
    focusedAgent,
    activePreflightChecks,
    hasPreflightFailures,
    hasPreflightWarnings,
    compileIssues,
    hasCompileFailures,
    stageStats,
    flowPaths,
    setMenu,
    selectPipeline,
    createPipeline,
    deletePipeline,
    addStage,
    addStageAt,
    deleteStage,
    setPipelineField,
    setStageField,
    setAgentField,
    moveStage,
    moveStageToIndex,
    addAgent,
    deleteAgent,
    addSkill,
    deleteSkill,
    setSkillField,
    addAction,
    deleteAction,
    moveAction,
    addQualityGate,
    deleteQualityGate,
    focusStage,
    focusAgent,
    resetDemoData,
    setPolicyValue,
    togglePolicyFlag,
    toggleApproval,
    setCsvList,
    csvValue,
    runLint,
    refreshPreflight,
    togglePreflightPanel,
    previewCompile,
    applyCompile,
    startRun,
    refreshLaunchPreview,
    openInITerm,
    stopRun,
    backToStudio,
  };
}

function summarizePreflight(result, checking, error) {
  if (checking) {
    return {
      status: "checking",
      label: "检查中",
      detail: "正在检查本地环境和流水线引用",
      passCount: 0,
      warnCount: 0,
      failCount: 0,
      total: 0,
    };
  }

  if (error) {
    return {
      status: "fail",
      label: "不可用",
      detail: error,
      passCount: 0,
      warnCount: 0,
      failCount: 1,
      total: 1,
    };
  }

  const checks = result?.checks || [];
  if (!checks.length) {
    return {
      status: "idle",
      label: "未检查",
      detail: "编辑配置后会自动轻预检，也可以手动刷新",
      passCount: 0,
      warnCount: 0,
      failCount: 0,
      total: 0,
    };
  }

  const failCount = checks.filter((check) => check.status === "fail").length;
  const warnCount = checks.filter((check) => check.status === "warn").length;
  const passCount = checks.filter((check) => check.status === "pass").length;
  const status = failCount ? "fail" : warnCount ? "warn" : "pass";
  const label = failCount ? "失败" : warnCount ? "警告" : "通过";
  const detail = failCount
    ? `${failCount} 个失败项会阻止运行`
    : warnCount
      ? `${warnCount} 个警告项，允许继续但建议确认`
      : `${passCount} 项检查通过`;

  return {
    status,
    label,
    detail,
    passCount,
    warnCount,
    failCount,
    total: checks.length,
  };
}

function loadPersistedPipelines() {
  const saved = window.localStorage.getItem("agentflow-pipelines");
  if (!saved) return clonePayload(defaultPipelines);

  try {
    const parsed = JSON.parse(saved);
    return Array.isArray(parsed) && parsed.length
      ? normalizePipelines(parsed)
      : clonePayload(defaultPipelines);
  } catch {
    return clonePayload(defaultPipelines);
  }
}

function normalizePipelines(pipelines) {
  return pipelines.map(normalizePipeline).filter(Boolean);
}

function normalizePipeline(pipeline) {
  if (!pipeline) return null;
  const normalized = {
    ...pipeline,
    leaderAgentName: pipeline.leaderAgentName || toLeaderAgentName(pipeline.name, pipeline.id),
    projectPath: pipeline.projectPath || DEFAULT_PROJECT_PATH,
    claudeDir: pipeline.claudeDir || DEFAULT_CLAUDE_DIR,
    sharedAgentsDir: pipeline.sharedAgentsDir || defaultSharedAgentsDir(pipeline.claudeDir || DEFAULT_CLAUDE_DIR),
    delegationPolicy: normalizePolicy(pipeline.delegationPolicy),
    qualityGates: normalizeQualityGates(pipeline.qualityGates),
    stages: (pipeline.stages || []).map((stage, index) => normalizeStage(stage, index, pipeline.stages || [])),
  };
  syncDerivedPipeline(normalized);
  return normalized;
}

function normalizeStage(stage, index, allStages = []) {
  const stageId = stage.id || `stage-${index + 1}`;
  const previousStage = allStages[index - 1];
  const previousOutputs = previousStage ? inferStageOutputs(previousStage) : ["UserRequirement"];
  const agents = (stage.agents || []).map((agent) => normalizeAgent(agent, stage.name, previousOutputs));
  const actions = (stage.actions?.length ? stage.actions : [buildDefaultAction(stageId, stage.name, agents, previousOutputs)])
    .map((action, actionIndex) => ({
      id: action.id || `${stageId}-action-${actionIndex + 1}`,
      name: action.name || `${stage.name} 交付`,
      owner: action.owner || agents[0]?.agentName || "",
      inputs: listOrDefault(action.inputs, previousOutputs),
      outputs: listOrDefault(action.outputs, inferStageOutputs({ ...stage, agents })),
      gates: listOrDefault(action.gates, inferGates(stage.name)),
    }));

  return {
    ...stage,
    id: stageId,
    name: stage.name || `阶段 ${index + 1}`,
    agents,
    actions,
  };
}

function normalizeAgent(agent, stageName, defaultWatch) {
  const name = agent.name || "未命名 Agent";
  const watch = listOrDefault(agent.watch, defaultWatch);
  const produce = listOrDefault(agent.produce, inferProduce(stageName, name));
  return {
    ...agent,
    id: agent.id || createId("a"),
    name,
    agentName: agent.agentName || toAgentName(name),
    description: agent.description || `${name} for AgentFlow pipeline.`,
    responsibility: agent.responsibility || "",
    source: agent.source || "managed",
    model: agent.model || "sonnet",
    tools: listOrDefault(agent.tools, ["Read", "Write", "Edit", "Grep", "Glob"]),
    watch,
    produce,
    skills: (agent.skills || []).map((skill) => normalizeSkill(skill)),
  };
}

function normalizeSkill(skill) {
  const path = skill.path || "";
  const name = skill.name || skillNameFromPath(path) || "unnamed_skill";
  return {
    ...skill,
    id: skill.id || `sk-${name}`,
    name,
    version: skill.version || "latest",
    path,
  };
}

function syncDerivedPipeline(pipeline) {
  if (!pipeline) return;
  pipeline.organization = {
    leader: {
      agentName: pipeline.leaderAgentName,
      mode: pipeline.organization?.leader?.mode || "claude-code-leader",
      responsibility:
        pipeline.organization?.leader?.responsibility ||
        `负责「${pipeline.name}」的需求澄清、任务拆解、角色委托、阶段推进和最终综合。`,
    },
    agents: pipeline.stages.flatMap((stage) =>
      stage.agents.map((agent) => ({
        id: agent.id,
        stageId: stage.id,
        stageName: stage.name,
        name: agent.name,
        agentName: agent.agentName,
        source: agent.source,
        watch: agent.watch,
        produce: agent.produce,
        responsibility: agent.responsibility,
      }))
    ),
  };
  pipeline.sop = {
    description: pipeline.sop?.description || `${pipeline.name} 的结构化研发 SOP。`,
    stages: pipeline.stages.map((stage) => ({
      id: stage.id,
      name: stage.name,
      actions: stage.actions,
    })),
  };
}

function syncFocusForPipeline(state, pipeline) {
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
}

function normalizePolicy(policy) {
  const merged = {
    ...clonePayload(defaultDelegationPolicy),
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

function normalizeQualityGates(gates) {
  return Array.isArray(gates) && gates.length ? gates : clonePayload(defaultQualityGates);
}

function buildDefaultAction(stageId, stageName, agents, inputs) {
  return {
    id: `${stageId}-action-1`,
    name: `${stageName} 交付`,
    owner: agents[0]?.agentName || "",
    inputs,
    outputs: agents[0]?.produce || inferProduce(stageName, ""),
    gates: inferGates(stageName),
  };
}

function moveItem(list, itemId, direction) {
  const index = list.findIndex((item) => item.id === itemId);
  const targetIndex = index + direction;
  if (index < 0 || targetIndex < 0 || targetIndex >= list.length) return;
  const [item] = list.splice(index, 1);
  list.splice(targetIndex, 0, item);
}

function confirmDelete(message) {
  if (typeof window === "undefined" || typeof window.confirm !== "function") return true;
  return window.confirm(message);
}

function pipelineFieldLabel(key) {
  switch (key) {
    case "name":
      return "流水线名称";
    case "leaderAgentName":
      return "Team Leader 名称";
    case "projectPath":
      return "项目地址";
    case "claudeDir":
      return "Claude 目录";
    case "sharedAgentsDir":
      return "共享 Agent 目录";
    default:
      return "";
  }
}

function defaultSharedAgentsDir(claudeDir) {
  return `${String(claudeDir || DEFAULT_CLAUDE_DIR).replace(/\/+$/, "")}/agents`;
}

function inferWatchForStage(pipeline, stage) {
  const index = pipeline?.stages.findIndex((item) => item.id === stage.id) ?? -1;
  if (index <= 0) return ["UserRequirement"];
  return inferStageOutputs(pipeline.stages[index - 1]);
}

function inferProduce(stageName, agentName = "") {
  const text = `${stageName} ${agentName}`;
  if (/需求|产品|prd/i.test(text)) return ["PRD", "AcceptanceCriteria", "RiskRegister"];
  if (/技术|方案|架构|architect|design/i.test(text)) return ["Architecture", "ADR", "APISpec"];
  if (/开发|实现|工程|code|developer/i.test(text)) return ["CodeChange", "DevNotes"];
  if (/测试|验收|qa|test/i.test(text)) return ["TestReport", "DefectList"];
  return [`${stageName}Artifact`];
}

function inferStageOutputs(stage) {
  const outputs = (stage.agents || []).flatMap((agent) => agent.produce || inferProduce(stage.name, agent.name));
  return [...new Set(outputs.length ? outputs : inferProduce(stage.name, ""))];
}

function inferGates(stageName) {
  if (/需求|产品|prd/i.test(stageName)) return ["requirement-review"];
  if (/技术|方案|架构|architect|design/i.test(stageName)) return ["architecture-review"];
  if (/开发|实现|工程|code|developer/i.test(stageName)) return ["write-files"];
  if (/测试|验收|qa|test/i.test(stageName)) return ["completion-review"];
  return [];
}

function listOrDefault(value, fallback) {
  if (Array.isArray(value)) {
    const list = value.map((item) => String(item).trim()).filter(Boolean);
    return list.length ? list : [...fallback];
  }
  if (typeof value === "string" && value.trim()) return csvToList(value);
  return [...fallback];
}

function csvToList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function skillNameFromPath(value) {
  return String(value || "")
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean)
    .pop() || "";
}

function createId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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
