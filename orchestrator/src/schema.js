export const DEFAULT_PROJECT_PATH = "/Users/leo/Projects/agentflow-platform";
export const DEFAULT_CLAUDE_DIR = "/Users/leo/.claude";

export const DEFAULT_DELEGATION_POLICY = {
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

export const DEFAULT_QUALITY_GATES = [
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
    id: "destructive-command",
    name: "破坏性命令",
    type: "human",
    required: true,
    description: "删除、重置、迁移等不可逆操作必须人工确认。",
  },
];

export const LAUNCH_MODES = ["single-leader", "suggest-team", "force-team"];

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function normalizeDefinitionRequest(value = {}, existingDefinition = null) {
  const existingPipelines = pipelinesFromDefinition(existingDefinition);
  const requestPipelines = Array.isArray(value.pipelines) ? value.pipelines : existingPipelines;
  const normalizedPipelines = requestPipelines.map(normalizePipeline).filter(Boolean);
  const selectedPipeline = normalizePipeline(value.pipeline);
  const selectedPipelineHasStages = Array.isArray(value.pipeline?.stages) && value.pipeline.stages.length > 0;

  if (selectedPipeline) {
    const index = normalizedPipelines.findIndex((pipeline) => pipeline.id === selectedPipeline.id);
    if (index >= 0) {
      if (selectedPipelineHasStages || !normalizedPipelines[index].stages.length) {
        normalizedPipelines[index] = selectedPipeline;
      }
    } else {
      normalizedPipelines.push(selectedPipeline);
    }
  }

  const selectedPipelineId = String(value.selectedPipelineId || selectedPipeline?.id || normalizedPipelines[0]?.id || "");
  const currentPipeline =
    normalizedPipelines.find((pipeline) => pipeline.id === selectedPipelineId) || normalizedPipelines[0] || null;

  return {
    version: 3,
    selectedPipelineId: currentPipeline?.id || "",
    pipelines: normalizedPipelines,
    pipeline: currentPipeline,
  };
}

export function normalizeStoredDefinition(definition) {
  const pipelines = pipelinesFromDefinition(definition).map(normalizePipeline).filter(Boolean);
  const selectedPipelineId = String(definition?.selectedPipelineId || definition?.pipeline?.id || pipelines[0]?.id || "");
  const currentPipeline =
    pipelines.find((pipeline) => pipeline.id === selectedPipelineId) || pipelines[0] || null;

  return {
    version: 3,
    selectedPipelineId: currentPipeline?.id || "",
    pipelines,
    pipeline: currentPipeline,
  };
}

export function normalizePipeline(value) {
  if (!value || typeof value !== "object" || !value.name) return null;

  const rawStages = Array.isArray(value.stages) ? value.stages : [];
  const rawSopStages = Array.isArray(value.sop?.stages) ? value.sop.stages : [];
  const stages = rawStages.map((stage, index) => normalizeStage(stage, index, rawStages, rawSopStages));
  const leaderAgentName = String(value.leaderAgentName || value.organization?.leader?.agentName || toLeaderAgentName(value.name));
  const pipeline = {
    id: String(value.id || slugify(value.name, "pipeline")),
    name: String(value.name),
    leaderAgentName,
    projectPath: String(value.projectPath || DEFAULT_PROJECT_PATH),
    claudeDir: String(value.claudeDir || DEFAULT_CLAUDE_DIR),
    sharedAgentsDir: String(value.sharedAgentsDir || defaultSharedAgentsDir(value.claudeDir || DEFAULT_CLAUDE_DIR)),
    delegationPolicy: normalizeDelegationPolicy(value.delegationPolicy),
    qualityGates: normalizeQualityGates(value.qualityGates),
    stages,
  };

  pipeline.organization = normalizeOrganization(value.organization, pipeline);
  pipeline.sop = normalizeSop(value.sop, pipeline);

  return pipeline;
}

function defaultSharedAgentsDir(claudeDir) {
  return `${String(claudeDir || DEFAULT_CLAUDE_DIR).replace(/\/+$/, "")}/agents`;
}

export function normalizeDelegationPolicy(policy = {}) {
  const rules = policy.escalationRules || {};
  return {
    defaultMode: String(policy.defaultMode || DEFAULT_DELEGATION_POLICY.defaultMode),
    allowSubAgents: policy.allowSubAgents !== false,
    allowAgentTeam: policy.allowAgentTeam !== false,
    allowRecursiveDelegation: policy.allowRecursiveDelegation !== false,
    maxDepth: clampNumber(policy.maxDepth, 1, 3, DEFAULT_DELEGATION_POLICY.maxDepth),
    maxParallelAgents: clampNumber(policy.maxParallelAgents, 1, 8, DEFAULT_DELEGATION_POLICY.maxParallelAgents),
    requireHumanApprovalFor: Array.isArray(policy.requireHumanApprovalFor)
      ? policy.requireHumanApprovalFor.map(String)
      : [...DEFAULT_DELEGATION_POLICY.requireHumanApprovalFor],
    escalationRules: {
      self: String(rules.self || DEFAULT_DELEGATION_POLICY.escalationRules.self),
      subAgent: String(rules.subAgent || DEFAULT_DELEGATION_POLICY.escalationRules.subAgent),
      team: String(rules.team || DEFAULT_DELEGATION_POLICY.escalationRules.team),
      recursive: String(rules.recursive || DEFAULT_DELEGATION_POLICY.escalationRules.recursive),
    },
  };
}

export function normalizeLaunchMode(value) {
  return LAUNCH_MODES.includes(value) ? value : "single-leader";
}

export function toAgentName(value, fallback = "agent") {
  return `agentflow-${slugify(value, fallback)}`;
}

export function toLeaderAgentName(value, fallback = "pipeline") {
  return `${toAgentName(value, fallback)}-team-leader`;
}

export function slugify(value, fallback = "item") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || fallback;
}

function pipelinesFromDefinition(definition) {
  if (Array.isArray(definition?.pipelines)) return definition.pipelines;
  if (definition?.pipeline) return [definition.pipeline];
  return [];
}

function normalizeStage(stage, index, allStages, sopStages) {
  const stageId = String(stage.id || `stage-${index + 1}`);
  const name = String(stage.name || `阶段 ${index + 1}`);
  const previousStage = allStages[index - 1];
  const previousOutputs = previousStage ? inferStageOutputs(previousStage) : ["UserRequirement"];
  const agents = Array.isArray(stage.agents)
    ? stage.agents.map((agent) => normalizeAgent(agent, name, previousOutputs)).filter(Boolean)
    : [];
  const sopStage = sopStages.find((item) => item.id === stageId || item.name === name);
  const rawActions = Array.isArray(stage.actions) && stage.actions.length
    ? stage.actions
    : Array.isArray(sopStage?.actions) && sopStage.actions.length
      ? sopStage.actions
      : [buildDefaultAction(stageId, name, agents, previousOutputs)];

  return {
    id: stageId,
    name,
    agents,
    actions: rawActions.map((action, actionIndex) =>
      normalizeAction(action, actionIndex, stageId, name, agents, previousOutputs)
    ),
  };
}

function normalizeAgent(agent, stageName, defaultWatch) {
  if (!agent || typeof agent !== "object") return null;
  const name = String(agent.name || "未命名 Agent");
  const agentName = String(agent.agentName || toAgentName(name));
  const produce = normalizeStringList(agent.produce, inferProduce(stageName, name));
  return {
    id: String(agent.id || slugify(agentName, "agent")),
    name,
    agentName,
    description: String(agent.description || `${name} for AgentFlow pipeline.`),
    responsibility: String(agent.responsibility || ""),
    source: agent.source === "shared" ? "shared" : "managed",
    model: String(agent.model || "sonnet"),
    tools: normalizeStringList(agent.tools, ["Read", "Write", "Edit", "Grep", "Glob"]),
    watch: normalizeStringList(agent.watch, defaultWatch),
    produce,
    skills: Array.isArray(agent.skills)
      ? agent.skills.map((skill) => ({
          id: String(skill.id || slugify(skill.name || skillNameFromPath(skill.path), "skill")),
          name: String(skill.name || skillNameFromPath(skill.path) || "unnamed_skill"),
          version: String(skill.version || "latest"),
          path: String(skill.path || ""),
        }))
      : [],
  };
}

function normalizeAction(action, actionIndex, stageId, stageName, agents, defaultInputs) {
  const firstAgent = agents[0]?.agentName || "";
  const actionId = String(action.id || `${stageId}-action-${actionIndex + 1}`);
  const outputs = normalizeStringList(action.outputs, inferStageOutputs({ name: stageName, agents }));
  return {
    id: actionId,
    name: String(action.name || `${stageName} 交付`),
    owner: String(action.owner || firstAgent),
    inputs: normalizeStringList(action.inputs, defaultInputs),
    outputs,
    gates: normalizeStringList(action.gates, inferGates(stageName)),
  };
}

function buildDefaultAction(stageId, stageName, agents, defaultInputs) {
  return {
    id: `${stageId}-action-1`,
    name: `${stageName} 交付`,
    owner: agents[0]?.agentName || "",
    inputs: defaultInputs,
    outputs: inferStageOutputs({ name: stageName, agents }),
    gates: inferGates(stageName),
  };
}

function normalizeOrganization(organization = {}, pipeline) {
  return {
    leader: {
      agentName: pipeline.leaderAgentName,
      mode: String(organization.leader?.mode || "claude-code-leader"),
      responsibility: String(
        organization.leader?.responsibility ||
          `负责「${pipeline.name}」的需求澄清、任务拆解、角色委托、阶段推进和最终综合。`
      ),
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
}

function normalizeSop(sop = {}, pipeline) {
  return {
    description: String(sop.description || `${pipeline.name} 的结构化研发 SOP。`),
    stages: pipeline.stages.map((stage) => ({
      id: stage.id,
      name: stage.name,
      actions: stage.actions,
    })),
  };
}

function normalizeQualityGates(gates) {
  const normalized = Array.isArray(gates) && gates.length
    ? gates.map((gate) => ({
        id: String(gate.id || slugify(gate.name, "gate")),
        name: String(gate.name || gate.id || "未命名门禁"),
        type: String(gate.type || "human"),
        required: gate.required !== false,
        description: String(gate.description || ""),
      }))
    : clone(DEFAULT_QUALITY_GATES);

  const seen = new Set();
  return normalized.filter((gate) => {
    if (seen.has(gate.id)) return false;
    seen.add(gate.id);
    return true;
  });
}

function normalizeStringList(value, fallback = []) {
  if (Array.isArray(value)) {
    const list = value.map((item) => String(item).trim()).filter(Boolean);
    return list.length ? list : [...fallback];
  }
  if (typeof value === "string" && value.trim()) {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [...fallback];
}

function skillNameFromPath(value) {
  return String(value || "")
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean)
    .pop() || "";
}

function inferProduce(stageName, agentName) {
  const text = `${stageName} ${agentName}`;
  if (/需求|产品|prd/i.test(text)) return ["PRD", "AcceptanceCriteria", "RiskRegister"];
  if (/技术|方案|架构|architect|design/i.test(text)) return ["Architecture", "ADR", "APISpec"];
  if (/开发|实现|工程|code|developer/i.test(text)) return ["CodeChange", "DevNotes"];
  if (/测试|验收|qa|test/i.test(text)) return ["TestReport", "DefectList"];
  return [`${stageName}Artifact`];
}

function inferStageOutputs(stage) {
  const agentOutputs = (stage.agents || []).flatMap((agent) => agent.produce || inferProduce(stage.name, agent.name));
  const unique = [...new Set(agentOutputs.filter(Boolean))];
  return unique.length ? unique : inferProduce(stage.name, "");
}

function inferGates(stageName) {
  if (/需求|产品|prd/i.test(stageName)) return ["requirement-review"];
  if (/技术|方案|架构|architect|design/i.test(stageName)) return ["architecture-review"];
  if (/开发|实现|工程|code|developer/i.test(stageName)) return ["write-files"];
  if (/测试|验收|qa|test/i.test(stageName)) return ["completion-review"];
  return [];
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
