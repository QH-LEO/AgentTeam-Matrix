import path from "node:path";
import { normalizeDefinitionRequest, normalizeLaunchMode, normalizePipeline, toLeaderAgentName } from "./schema.js";

export function buildCompilePlan(request, existingDefinition, paths) {
  const definition = normalizeDefinitionRequest(request, existingDefinition);
  const lint = lintDefinition(definition, paths);
  const artifacts = definition.pipeline ? buildArtifacts(definition, paths) : [];
  return {
    ok: !lint.issues.some((issue) => issue.status === "fail"),
    pipelineId: definition.pipeline?.id || "",
    definition,
    artifacts,
    issues: lint.issues,
    warnings: lint.issues.filter((issue) => issue.status === "warn"),
  };
}

export function lintDefinition(definition, paths = {}) {
  const issues = [];
  const pipeline = definition?.pipeline;

  if (!pipeline) {
    issues.push({
      id: "pipeline-required",
      label: "流水线定义",
      status: "fail",
      detail: "缺少当前流水线，无法编译。",
    });
    return { ok: false, issues };
  }

  if (!pipeline.projectPath) {
    issues.push({
      id: "project-path-required",
      label: "项目地址",
      status: "fail",
      detail: "缺少 projectPath，无法写入项目级 AgentFlow 资产。",
    });
  }

  if (!pipeline.stages.length) {
    issues.push({
      id: "stages-required",
      label: "流程阶段",
      status: "fail",
      detail: "至少需要一个阶段。",
    });
  }

  const availableAgentNames = new Set(pipeline.stages.flatMap((stage) => stage.agents.map((agent) => agent.agentName)));
  for (const stage of pipeline.stages) {
    if (!stage.agents.length) {
      issues.push({
        id: `stage-${stage.id}-agents`,
        label: `阶段：${stage.name}`,
        status: "warn",
        detail: "该阶段没有配置 Agent，Team Leader 会以模拟委托方式产出。",
      });
    }

    for (const agent of stage.agents) {
      if (agent.source === "shared" && paths.agentExists && !paths.agentExists(agent.agentName)) {
        issues.push({
          id: `shared-agent-${agent.agentName}`,
          label: `共享 Agent：${agent.agentName}`,
          status: "fail",
          detail: "共享 Agent 文件不存在，source=shared 不会自动覆盖或创建。",
        });
      }
      if (!agent.produce.length) {
        issues.push({
          id: `agent-${agent.id}-produce`,
          label: `Agent：${agent.name}`,
          status: "warn",
          detail: "未配置 produce，已使用默认产物推断。",
        });
      }
    }

    for (const action of stage.actions) {
      if (!action.owner) {
        issues.push({
          id: `action-${action.id}-owner`,
          label: `动作：${action.name}`,
          status: "fail",
          detail: "Action 缺少 owner，无法确定由哪个 Agent 负责。",
        });
      } else if (!availableAgentNames.has(action.owner)) {
        issues.push({
          id: `action-${action.id}-owner-missing`,
          label: `动作：${action.name}`,
          status: "fail",
          detail: `Action owner ${action.owner} 不在当前流水线 Agent 列表中。`,
        });
      }
      if (!action.outputs.length) {
        issues.push({
          id: `action-${action.id}-outputs`,
          label: `动作：${action.name}`,
          status: "warn",
          detail: "Action 未声明 outputs，后续阶段可能无法追踪产物。",
        });
      }
    }
  }

  if (pipeline.delegationPolicy.allowRecursiveDelegation && pipeline.delegationPolicy.maxDepth > 2) {
    issues.push({
      id: "recursive-delegation-depth",
      label: "递归委托",
      status: "warn",
      detail: "Claude Code agent teams 当前不支持 nested teams，递归委托会由 Leader 统一调度。",
    });
  }

  return {
    ok: !issues.some((issue) => issue.status === "fail"),
    issues,
  };
}

export function buildArtifacts(definition, paths) {
  const pipeline = definition.pipeline;
  const projectRoot = pipeline.projectPath;
  const leaderAgentName = pipeline.leaderAgentName || toLeaderAgentName(pipeline.name);
  const artifacts = [
    {
      type: "definition",
      path: paths.definitionPath,
      nextContent: `${JSON.stringify(definition, null, 2)}\n`,
    },
    {
      type: "manifest",
      path: path.join(projectRoot, ".agentflow", "manifest.json"),
      nextContent: `${JSON.stringify(buildManifest(definition), null, 2)}\n`,
    },
    {
      type: "compiled-leader",
      path: path.join(projectRoot, ".agentflow", "compiled", "leader.md"),
      nextContent: renderTeamLeaderAgent(pipeline),
    },
    {
      type: "compiled-sop",
      path: path.join(projectRoot, ".agentflow", "compiled", "sop.md"),
      nextContent: renderSopMarkdown(pipeline),
    },
    {
      type: "compiled-delegation-policy",
      path: path.join(projectRoot, ".agentflow", "compiled", "delegation-policy.md"),
      nextContent: renderDelegationPolicyMarkdown(pipeline),
    },
    {
      type: "compiled-launch-prompt",
      path: path.join(projectRoot, ".agentflow", "compiled", "launch-prompt.md"),
      nextContent: buildLaunchPrompt({ pipeline, requirement: "", launchMode: "single-leader" }).prompt,
    },
    {
      type: "using-agentflow-skill",
      path: path.join(projectRoot, ".claude", "skills", "using-agentflow", "SKILL.md"),
      nextContent: renderUsingAgentFlowSkill(pipeline),
    },
    {
      type: "leader-agent",
      path: path.join(paths.claudeAgentsDir, `${leaderAgentName}.md`),
      nextContent: renderTeamLeaderAgent(pipeline),
    },
  ];

  for (const stage of pipeline.stages) {
    for (const agent of stage.agents) {
      if (agent.source === "shared") continue;
      artifacts.push({
        type: "managed-agent",
        path: path.join(paths.claudeAgentsDir, `${agent.agentName}.md`),
        nextContent: renderRoleAgent(pipeline, stage, agent),
      });
    }
  }

  return artifacts;
}

export function buildLaunchPrompt({ pipeline: rawPipeline, requirement = "", launchMode = "single-leader", runId = "" }) {
  const pipeline = normalizePipeline(rawPipeline);
  const mode = normalizeLaunchMode(launchMode);
  const leaderAgentName = pipeline.leaderAgentName || toLeaderAgentName(pipeline.name);
  const prompt = renderLaunchPrompt(pipeline, requirement, mode);
  const command = buildLaunchCommand(pipeline, prompt, leaderAgentName, runId);

  return {
    leaderAgentName,
    launchMode: mode,
    prompt,
    command,
  };
}

export function renderTeamLeaderAgent(pipeline) {
  const leaderAgentName = pipeline.leaderAgentName || toLeaderAgentName(pipeline.name);
  const agents = pipeline.stages.flatMap((stage) => stage.agents);
  const agentLines = agents.length
    ? agents.map((agent) => `- @${agent.agentName} (${agent.name})：${agent.responsibility || agent.description}`).join("\n")
    : "- 暂无配置 Agent，必要时由 Leader 模拟阶段产出。";

  return `---
name: ${leaderAgentName}
description: Coordinates the ${pipeline.name} AgentFlow pipeline from requirement intake to human-gated delivery.
model: sonnet
tools: Read, Write, Edit, MultiEdit, Grep, Glob, Bash
---

You are the Team Leader for the AgentFlow pipeline "${pipeline.name}".

Use the AgentFlow compiled assets as your source of truth:

- Project path: ${pipeline.projectPath}
- Pipeline SOP: .agentflow/compiled/sop.md
- Delegation policy: .agentflow/compiled/delegation-policy.md
- Bootstrap skill: .claude/skills/using-agentflow/SKILL.md

Available roles:
${agentLines}

Structured pipeline definition:

\`\`\`json
${JSON.stringify(pipeline, null, 2)}
\`\`\`

Execution rules:
- Start by invoking and following the using-agentflow workflow.
- Restate the user requirement, identify the current stage, then choose self / subagent / parallel subagents / agent team.
- When activating yourself or delegating, always use full Claude role handles such as @${leaderAgentName}.
- Shared agents are referenced by name and must not be rewritten by this pipeline.
- Apply delegationPolicy strictly: start simple, escalate only when the rules justify it.
- Claude Code agent teams are experimental and do not support nested teams; recursive delegation must be coordinated by you.
- Never exceed maxDepth or maxParallelAgents. If deeper delegation is needed, ask the user first.
- Any action listed in requireHumanApprovalFor or qualityGates must become an explicit human checkpoint before execution.
- Treat each stage boundary as a review gate.
- Keep decisions, risks, artifacts, and next steps traceable.
- If a configured agent is not available as a live subagent, simulate delegation by producing that agent's expected output section.
`;
}

export function renderRoleAgent(pipeline, stage, agent) {
  const skills = agent.skills?.length
    ? agent.skills
        .map((skill) => `- ${skill.name}@${skill.version}${skill.path ? ` (${skill.path})` : ""}`)
        .join("\n")
    : "- none";

  return `---
name: ${agent.agentName}
description: ${agent.description}
model: ${agent.model || "sonnet"}
tools: ${(agent.tools || ["Read", "Write", "Edit", "Grep", "Glob"]).join(", ")}
---

You are ${agent.name} in the AgentFlow pipeline "${pipeline.name}".

Stage: ${stage.name}

Responsibility:
${agent.responsibility || "No responsibility configured."}

Watch:
${agent.watch.map((item) => `- ${item}`).join("\n")}

Produce:
${agent.produce.map((item) => `- ${item}`).join("\n")}

Configured skills:
${skills}

Operating rules:
- Stay within this role unless the Team Leader explicitly asks otherwise.
- Produce outputs that can be reviewed at the stage gate.
- Call out assumptions, risks, and missing input clearly.
- Keep output concise, actionable, and traceable to the user requirement.
`;
}

export function renderSopMarkdown(pipeline) {
  const stages = pipeline.sop.stages
    .map((stage, index) => {
      const actions = stage.actions
        .map((action) => {
          return `### ${action.name}

- Owner: @${action.owner || "未配置"}
- Inputs: ${action.inputs.join(", ") || "none"}
- Outputs: ${action.outputs.join(", ") || "none"}
- Gates: ${action.gates.join(", ") || "none"}`;
        })
        .join("\n\n");

      return `## ${index + 1}. ${stage.name}

${actions || "No actions configured."}`;
    })
    .join("\n\n");

  return `# ${pipeline.name} SOP

${pipeline.sop.description}

${stages || "No stages configured."}

## Quality Gates

${pipeline.qualityGates.map((gate) => `- ${gate.id} (${gate.type})：${gate.description || gate.name}`).join("\n")}
`;
}

export function renderDelegationPolicyMarkdown(pipeline) {
  const policy = pipeline.delegationPolicy;
  return `# ${pipeline.name} Delegation Policy

- Default mode: ${policy.defaultMode}
- Allow subagents: ${policy.allowSubAgents ? "yes" : "no"}
- Allow agent team: ${policy.allowAgentTeam ? "yes" : "no"}
- Allow recursive delegation: ${policy.allowRecursiveDelegation ? "yes" : "no"}
- Max depth: ${policy.maxDepth}
- Max parallel agents: ${policy.maxParallelAgents}
- Human confirmations: ${policy.requireHumanApprovalFor.join(", ") || "none"}

## Decision Rules

### Self
${policy.escalationRules.self}

### Sub Agent
${policy.escalationRules.subAgent}

### Agent Team
${policy.escalationRules.team}

### Recursive Delegation
${policy.escalationRules.recursive}

## Runtime Constraints

- Use self for low-risk, bounded, quickly verifiable work.
- Use subagents for isolated research, review, or implementation tasks with clear inputs and outputs.
- Use parallel subagents only when write scopes do not conflict.
- Use agent team for cross-role product/design/development/testing collaboration.
- Claude Code agent teams do not support nested teams; all recursive delegation must be coordinated by the Team Leader.
`;
}

export function renderUsingAgentFlowSkill(pipeline) {
  return `---
name: using-agentflow
description: Use when starting or executing any AgentFlow-managed pipeline. Loads the pipeline SOP, delegation policy, quality gates, and role routing rules before work begins.
---

# Using AgentFlow

You are operating inside the AgentFlow pipeline "${pipeline.name}".

Before taking action:

1. Read the pipeline SOP from .agentflow/compiled/sop.md.
2. Read the delegation policy from .agentflow/compiled/delegation-policy.md.
3. Identify the current stage and required artifacts.
4. Classify task complexity.
5. Decide execution mode: self / subagent / parallel subagents / agent team / ask human.
6. Use full @agent names when delegating.
7. Do not skip quality gates or human confirmation points.
8. Record artifacts, risks, decisions, and next steps.

Important:

- Shared agents are read-only references.
- Managed agents may be regenerated by AgentFlow.
- Claude Code agent teams are experimental and do not support nested teams.
- If the user requirement is unclear, ask before delegating.
`;
}

function renderLaunchPrompt(pipeline, requirement, launchMode) {
  const leaderAgentName = pipeline.leaderAgentName || toLeaderAgentName(pipeline.name);
  const agents = pipeline.stages
    .flatMap((stage) => stage.agents.map((agent) => `- @${agent.agentName} (${agent.name})：${agent.responsibility || agent.description}`))
    .join("\n") || "- 暂无配置 Agent";
  const modeInstruction = buildModeInstruction(launchMode, pipeline);

  return `@${leaderAgentName}

你正在 AgentFlow 管理的「${pipeline.name}」中工作。

项目路径：
${pipeline.projectPath}

请先加载并遵守 using-agentflow 规则，然后处理以下需求：

${requirement || "用户尚未填写需求，请先询问用户要实现什么。"}

启动模式：
${launchMode}

${modeInstruction}

可用角色：
${agents}

执行要求：
1. 先判断任务复杂度。
2. 明确选择 self / subagent / parallel subagents / agent team。
3. 委托时必须使用完整 @agent 名称。
4. 不得跳过人工确认点和质量门禁。
5. 输出阶段状态、产物、风险和下一步。

结构化流水线摘要：

${renderRunSummary(pipeline)}
`;
}

function buildModeInstruction(launchMode, pipeline) {
  if (launchMode === "force-team") {
    return `请创建一个 Claude Code agent team 来执行本需求。

要求：
- 由你作为 team lead 维护任务列表。
- 团队成员应优先从当前流水线 Agent 中选择。
- 每个 teammate 必须拥有清晰写入边界。
- 高风险变更必须先计划，得到 lead 批准后再实施。
- 完成后综合所有 teammate 结论。`;
  }

  if (launchMode === "suggest-team") {
    return `请先评估是否需要创建 Claude Code agent team。

如果任务跨产品、架构、研发、测试，或需要多角色讨论，请先说明理由并建议启动 team；如果任务可单点完成，则保持 single leader 或 subagent 模式。`;
  }

  return `请默认以 single leader 模式开始。

只有当任务明确需要隔离探索、专项审查或跨角色协作时，才创建 subagent 或建议升级到 agent team。`;
}

function renderRunSummary(pipeline) {
  const stages = pipeline.stages
    .map((stage, index) => {
      const agents = stage.agents.length
        ? stage.agents.map((agent) => `    - @${agent.agentName}：${agent.produce.join(", ")}`).join("\n")
        : "    - no agents";
      const actions = stage.actions.map((action) => `    - ${action.name} -> ${action.outputs.join(", ")}`).join("\n");
      return `${index + 1}. ${stage.name}\n  Agents:\n${agents}\n  Actions:\n${actions || "    - no actions"}`;
    })
    .join("\n");

  return [
    `Pipeline: ${pipeline.name}`,
    `Leader agent: @${pipeline.leaderAgentName || toLeaderAgentName(pipeline.name)}`,
    `Project: ${pipeline.projectPath}`,
    "",
    "Delegation policy:",
    JSON.stringify(pipeline.delegationPolicy, null, 2),
    "",
    "Stages:",
    stages || "No stages configured.",
  ].join("\n");
}

function buildLaunchCommand(pipeline, prompt, leaderAgentName, runId) {
  return [
    `cd ${shellQuote(pipeline.projectPath)}`,
    "clear",
    `printf '%s\\n' ${shellQuote("AgentFlow 一键启动")}`,
    runId ? `printf '%s\\n' ${shellQuote(`Run ID: ${runId}`)}` : "",
    `printf '%s\\n' ${shellQuote(`Project: ${pipeline.projectPath}`)}`,
    `printf '%s\\n' ${shellQuote(`Leader: @${leaderAgentName}`)}`,
    `claude --agent ${leaderAgentName} ${shellQuote(prompt)}`,
  ].filter(Boolean).join("; ");
}

function buildManifest(definition) {
  const pipeline = definition.pipeline;
  return {
    version: 1,
    schemaVersion: definition.version,
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    leaderAgentName: pipeline.leaderAgentName,
    launchModes: ["single-leader", "suggest-team", "force-team"],
    assets: [
      ".agentflow/compiled/leader.md",
      ".agentflow/compiled/sop.md",
      ".agentflow/compiled/delegation-policy.md",
      ".agentflow/compiled/launch-prompt.md",
      ".claude/skills/using-agentflow/SKILL.md",
    ],
  };
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
