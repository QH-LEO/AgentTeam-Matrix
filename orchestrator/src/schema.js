export const DEFAULT_PROJECT_PATH = ".";
export const DEFAULT_CLAUDE_DIR = "~/.claude";

export const DEFAULT_DELEGATION_POLICY = {
  defaultMode: "self_first",
  allowSubAgents: true,
  allowAgentTeam: true,
  allowRecursiveDelegation: true,
  maxDepth: 2,
  maxParallelAgents: 4,
  requireHumanApprovalFor: [],
  escalationRules: {
    self: "任务小、路径清楚、上下文足够、单一产物时由当前 Agent 自己完成。",
    subAgent: "子任务边界清楚、适合并行、需要隔离上下文或专业审查时创建 Sub Agent。",
    team: "任务跨多个阶段/角色/产物，需要 Team Leader 拆解、调度、验收时启动 Agent Team。",
    recursive: "子 Agent 发现任务仍需拆分时，只能向 Team Leader 申请受控 helper subagent；不得自行创建 Team，所有结果必须回传父级验收。",
  },
};

export const DEFAULT_QUALITY_GATES = [
  {
    id: "requirement-review",
    name: "需求确认",
    type: "human",
    domain: "requirement",
    trigger: "before_stage_exit",
    executor: "human_approval",
    enforcement: "block",
    required: true,
    evidence: ["需求摘要与范围边界", "验收标准", "关键风险与待确认问题"],
    passCriteria: "需求边界、验收标准和关键风险已明确。",
    failAction: "ask_user",
    description: "需求边界、验收标准和风险必须人工确认。",
  },
  {
    id: "architecture-review",
    name: "方案确认",
    type: "human",
    domain: "architecture",
    trigger: "before_stage_exit",
    executor: "human_approval",
    enforcement: "block",
    required: true,
    evidence: ["方案摘要与关键取舍", "接口契约/数据流", "测试策略与主要风险"],
    passCriteria: "架构方案、接口契约和风险处理已确认。",
    failAction: "revise",
    description: "架构方案、接口契约和测试策略必须人工确认。",
  },
  {
    id: "write-files",
    name: "写文件前",
    type: "human",
    domain: "code",
    trigger: "before_write",
    executor: "human_approval",
    enforcement: "block",
    required: true,
    evidence: ["拟修改文件列表", "改动边界与影响面", "验证方式与回滚预案"],
    passCriteria: "写入范围、影响面和回滚路径已确认。",
    failAction: "ask_user",
    description: "开始写入项目文件前需要确认改动边界。",
  },
  {
    id: "completion-review",
    name: "完成验收",
    type: "human",
    domain: "test",
    trigger: "after_diff",
    executor: "human_review",
    enforcement: "block",
    required: true,
    evidence: ["交付产物清单", "验证结果", "剩余风险与下一步"],
    passCriteria: "交付内容、验证结果和剩余风险已通过验收。",
    failAction: "revise",
    description: "完成后必须回顾交付产物、验证结果和剩余风险。",
  },
  {
    id: "destructive-command",
    name: "破坏性命令",
    type: "human",
    domain: "security",
    trigger: "before_command",
    executor: "human_approval",
    enforcement: "block",
    required: true,
    evidence: ["即将执行的命令或操作", "受影响资源", "备份与回滚方案"],
    passCriteria: "破坏性操作的必要性、影响面和回滚方案已确认。",
    failAction: "stop",
    description: "删除、重置、迁移等不可逆操作必须人工确认。",
  },
  {
    id: "deployment",
    name: "发布前确认",
    type: "human",
    domain: "release",
    trigger: "before_pr",
    executor: "human_approval",
    enforcement: "block",
    required: true,
    evidence: ["发布范围", "验证清单", "回滚方案与影响窗口"],
    passCriteria: "发布范围、验证方式和回滚方案已确认。",
    failAction: "stop",
    description: "上线前必须人工确认发布范围、验证方式和回滚方案。",
  },
];

export const DEFAULT_KNOWLEDGE_BASE = {
  enabled: true,
  path: ".agentflow/wiki",
  domain: "AgentFlow 项目研发知识库",
  autoOrient: true,
  writeMode: "proposal_first",
  rawImmutable: true,
};

export const LAUNCH_MODES = ["single-leader", "suggest-team", "force-team"];
export const KNOWLEDGE_BASE_WRITE_MODES = ["proposal_first", "auto_write", "readonly"];

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
  const delegationPolicy = normalizeDelegationPolicy(value.delegationPolicy);
  const qualityGates = normalizeQualityGates(value.qualityGates, legacyHumanApprovalGateIds(value.delegationPolicy));
  const knowledgeBase = normalizeKnowledgeBase(value.knowledgeBase, value.name);
  const pipeline = {
    id: String(value.id || slugify(value.name, "pipeline")),
    name: String(value.name),
    leaderAgentName,
    projectPath: String(value.projectPath || DEFAULT_PROJECT_PATH),
    claudeDir: String(value.claudeDir || DEFAULT_CLAUDE_DIR),
    sharedAgentsDir: String(value.sharedAgentsDir || defaultSharedAgentsDir(value.claudeDir || DEFAULT_CLAUDE_DIR)),
    delegationPolicy,
    qualityGates,
    knowledgeBase,
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
    requireHumanApprovalFor: [],
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

export function normalizeKnowledgeBase(value = {}, pipelineName = "") {
  const writeMode = KNOWLEDGE_BASE_WRITE_MODES.includes(value.writeMode)
    ? value.writeMode
    : DEFAULT_KNOWLEDGE_BASE.writeMode;

  return {
    enabled: value.enabled !== false,
    path: String(value.path || DEFAULT_KNOWLEDGE_BASE.path),
    domain: String(value.domain || `${pipelineName || "AgentFlow"} 项目研发知识库`),
    autoOrient: value.autoOrient !== false,
    writeMode,
    rawImmutable: value.rawImmutable !== false,
  };
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

function normalizeQualityGates(gates, requiredGateIds = []) {
  const normalized = Array.isArray(gates) && gates.length
    ? gates.map(normalizeQualityGate)
    : clone(DEFAULT_QUALITY_GATES);

  for (const gateId of requiredGateIds) {
    if (normalized.some((gate) => gate.id === gateId)) continue;
    normalized.push(defaultQualityGate(gateId));
  }

  const seen = new Set();
  return normalized.filter((gate) => {
    if (seen.has(gate.id)) return false;
    seen.add(gate.id);
    return true;
  });
}

function normalizeQualityGate(gate = {}) {
  const fallback = defaultQualityGate(gate.id || slugify(gate.name, "gate"));
  const executor = normalizeGateExecutor(gate.executor, gate.type || fallback.type);
  const domain = String(gate.domain || inferGateDomain(gate.id, gate.name, gate.description));
  const enforcement = String(gate.enforcement || (gate.required === false ? "warn" : "block"));
  return {
    id: String(gate.id || slugify(gate.name, "gate")),
    name: String(gate.name || gate.id || "未命名门禁"),
    type: String(gate.type || legacyTypeFromExecutor(executor)),
    domain,
    trigger: String(gate.trigger || inferGateTrigger(gate.id, gate.name, gate.description)),
    executor,
    enforcement,
    required: gate.required === undefined ? enforcement === "block" : gate.required !== false,
    evidence: normalizeStringList(gate.evidence || gate.evidenceSchema, inferGateEvidence(gate.id, gate.name, gate.description)),
    passCriteria: String(gate.passCriteria || inferGatePassCriteria(gate.id, gate.name, gate.description)),
    failAction: String(gate.failAction || "revise"),
    description: String(gate.description || fallback.description || ""),
  };
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

function defaultQualityGate(gateId) {
  const existing = DEFAULT_QUALITY_GATES.find((gate) => gate.id === gateId);
  if (existing) return clone(existing);
  return {
    id: String(gateId || "gate"),
    name: String(gateId || "未命名门禁"),
    type: "human",
    domain: inferGateDomain(gateId),
    trigger: inferGateTrigger(gateId),
    executor: "human_approval",
    enforcement: "block",
    required: true,
    evidence: inferGateEvidence(gateId),
    passCriteria: inferGatePassCriteria(gateId),
    failAction: "revise",
    description: "该门禁来自旧版确认配置，已迁移为 human_approval，请补充更具体的门禁说明。",
  };
}

function legacyHumanApprovalGateIds(policy = {}) {
  return Array.isArray(policy?.requireHumanApprovalFor) ? policy.requireHumanApprovalFor.map(String) : [];
}

function normalizeGateExecutor(executor, legacyType = "") {
  const value = String(executor || "");
  if (["human_approval", "human_review", "ai_review"].includes(value)) return value;
  if (["command_check", "ci_check", "policy_check"].includes(value)) return "ai_review";
  switch (legacyType) {
    case "test":
    case "review":
    case "security":
      return "ai_review";
    case "human":
    default:
      return "human_approval";
  }
}

function legacyTypeFromExecutor(executor) {
  if (["ai_review", "human_review", "command_check", "ci_check", "policy_check"].includes(executor)) return "review";
  return "human";
}

function inferGateDomain(...values) {
  const text = values.filter(Boolean).join(" ");
  if (/需求|requirement|prd/i.test(text)) return "requirement";
  if (/方案|架构|architecture|design|api/i.test(text)) return "architecture";
  if (/依赖|dependency|package|lockfile|npm|pnpm|yarn/i.test(text)) return "dependency";
  if (/安全|密钥|secret|token|权限|security|destructive|delete|reset|migration|破坏/i.test(text)) return "security";
  if (/发布|上线|deployment|release|pr/i.test(text)) return "release";
  if (/测试|验收|test|lint|build|completion|review/i.test(text)) return "test";
  if (/写文件|write|code|实现/i.test(text)) return "code";
  return "code";
}

function inferGateTrigger(...values) {
  const text = values.filter(Boolean).join(" ");
  if (/写文件|write/i.test(text)) return "before_write";
  if (/命令|command|bash|destructive|delete|reset|migration|破坏/i.test(text)) return "before_command";
  if (/发布|上线|deployment|release|pr/i.test(text)) return "before_pr";
  if (/完成|验收|review|completion|diff/i.test(text)) return "after_diff";
  return "before_stage_exit";
}

function inferGateEvidence(...values) {
  const text = values.filter(Boolean).join(" ");
  if (/需求|requirement/i.test(text)) return ["需求摘要与范围边界", "验收标准", "关键风险与待确认问题"];
  if (/方案|架构|architecture|design|api/i.test(text)) return ["方案摘要与关键取舍", "接口契约/数据流", "测试策略与主要风险"];
  if (/写文件|write|code|实现/i.test(text)) return ["拟修改文件列表", "改动边界与影响面", "验证方式与回滚预案"];
  if (/完成|验收|completion|review/i.test(text)) return ["交付产物清单", "验证结果", "剩余风险与下一步"];
  if (/破坏|destructive|delete|reset|migration/i.test(text)) return ["即将执行的命令或操作", "受影响资源", "备份与回滚方案"];
  if (/发布|上线|deployment|release/i.test(text)) return ["发布范围", "验证清单", "回滚方案与影响窗口"];
  return ["当前决策摘要", "风险与假设", "验证结果或计划"];
}

function inferGatePassCriteria(...values) {
  const text = values.filter(Boolean).join(" ");
  if (/需求|requirement/i.test(text)) return "需求边界、验收标准和关键风险已明确。";
  if (/方案|架构|architecture|design|api/i.test(text)) return "方案、接口契约、技术取舍和验证路径已确认。";
  if (/写文件|write|code|实现/i.test(text)) return "文件边界、影响面和验证方式已确认。";
  if (/完成|验收|completion|review/i.test(text)) return "交付产物、验证结果和剩余风险已通过审查。";
  if (/破坏|destructive|delete|reset|migration/i.test(text)) return "操作必要性、影响面、备份与回滚方案已确认。";
  if (/发布|上线|deployment|release/i.test(text)) return "发布范围、验证清单和回滚方案已确认。";
  return "证据充分，风险可接受，下一步动作清楚。";
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
  if (/发布|上线|deployment|release/i.test(stageName)) return ["deployment"];
  return [];
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
