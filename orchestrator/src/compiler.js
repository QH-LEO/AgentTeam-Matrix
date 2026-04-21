import path from "node:path";
import { normalizeDefinitionRequest, normalizeLaunchMode, normalizePipeline, toLeaderAgentName } from "./schema.js";
import { resolveConfiguredPath, resolveProjectPath } from "./storage.js";

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
  const definedGateIds = new Set((pipeline.qualityGates || []).map((gate) => gate.id));
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
          label: `共享 Agent：${agent.name}`,
          status: "fail",
          detail: `未找到本机绑定 @${agent.agentName}，请先在 Agent 职责页为该角色绑定真实共享 Agent。`,
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

      for (const gateId of action.gates || []) {
        if (definedGateIds.has(gateId)) continue;

        issues.push({
          id: `action-${action.id}-gate-${gateId}-missing`,
          label: `动作：${action.name}`,
          status: "fail",
          detail: `Action gate ${gateId} 未在 qualityGates 中定义，无法编译为可执行门禁。`,
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

  if (pipeline.knowledgeBase?.enabled) {
    if (!pipeline.knowledgeBase.path) {
      issues.push({
        id: "knowledge-base-path",
        label: "Knowledge Wiki",
        status: "fail",
        detail: "Knowledge Wiki 已启用，但缺少 wiki path。",
      });
    }
    if (pipeline.knowledgeBase.writeMode === "auto_write") {
      issues.push({
        id: "knowledge-base-auto-write",
        label: "Knowledge Wiki",
        status: "warn",
        detail: "auto_write 会让 Agent 自动更新知识库；MVP 阶段建议使用 proposal_first。",
      });
    }
  }

  return {
    ok: !issues.some((issue) => issue.status === "fail"),
    issues,
  };
}

export function buildArtifacts(definition, paths) {
  const pipeline = definition.pipeline;
  const projectRoot = resolveProjectPath(pipeline.projectPath, paths.projectRoot);
  const leaderAgentName = pipeline.leaderAgentName || toLeaderAgentName(pipeline.name);
  const knowledgeArtifacts = buildKnowledgeBaseArtifacts(pipeline, projectRoot);
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
      type: "compiled-definition-snapshot",
      path: path.join(projectRoot, ".agentflow", "compiled", "definition.snapshot.json"),
      nextContent: `${JSON.stringify(definition, null, 2)}\n`,
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
      type: "compiled-gates",
      path: path.join(projectRoot, ".agentflow", "compiled", "gates.md"),
      nextContent: renderGatePlanMarkdown(pipeline),
    },
    {
      type: "compiled-gates-json",
      path: path.join(projectRoot, ".agentflow", "compiled", "gates.json"),
      nextContent: `${JSON.stringify(buildGatePlan(pipeline), null, 2)}\n`,
    },
    ...knowledgeArtifacts,
    {
      type: "compiled-launch-prompt",
      path: path.join(projectRoot, ".agentflow", "compiled", "launch-prompt.md"),
      nextContent: buildLaunchPrompt({
        pipeline,
        requirement: "",
        launchMode: "single-leader",
        projectRoot: paths.projectRoot,
      }).prompt,
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

function buildKnowledgeBaseArtifacts(pipeline, projectRoot) {
  if (!pipeline.knowledgeBase?.enabled) return [];

  const wikiRoot = resolveWikiPath(pipeline, projectRoot);
  const directoryKeepers = [
    "raw/requirements",
    "raw/designs",
    "raw/reviews",
    "raw/external",
    "entities",
    "concepts",
    "decisions",
    "comparisons",
    "queries",
  ].map((directory) => ({
    type: "knowledge-wiki-dir",
    path: path.join(wikiRoot, directory, ".gitkeep"),
    nextContent: "",
    seedOnly: true,
  }));

  return [
    {
      type: "knowledge-wiki-schema",
      path: path.join(wikiRoot, "SCHEMA.md"),
      nextContent: renderKnowledgeWikiSchema(pipeline),
      seedOnly: true,
    },
    {
      type: "knowledge-wiki-index",
      path: path.join(wikiRoot, "index.md"),
      nextContent: renderKnowledgeWikiIndex(pipeline),
      seedOnly: true,
    },
    {
      type: "knowledge-wiki-log",
      path: path.join(wikiRoot, "log.md"),
      nextContent: renderKnowledgeWikiLog(pipeline),
      seedOnly: true,
    },
    ...directoryKeepers,
    {
      type: "compiled-wiki-policy",
      path: path.join(projectRoot, ".agentflow", "compiled", "wiki-policy.md"),
      nextContent: renderKnowledgeWikiPolicy(pipeline),
    },
    {
      type: "compiled-wiki-ingest-prompt",
      path: path.join(projectRoot, ".agentflow", "compiled", "wiki-ingest.prompt.md"),
      nextContent: renderKnowledgeWikiIngestPrompt(pipeline),
    },
    {
      type: "compiled-wiki-query-prompt",
      path: path.join(projectRoot, ".agentflow", "compiled", "wiki-query.prompt.md"),
      nextContent: renderKnowledgeWikiQueryPrompt(pipeline),
    },
    {
      type: "using-agentflow-wiki-skill",
      path: path.join(projectRoot, ".claude", "skills", "using-agentflow-wiki", "SKILL.md"),
      nextContent: renderUsingAgentFlowWikiSkill(pipeline),
    },
  ];
}

export function buildLaunchPrompt({
  pipeline: rawPipeline,
  requirement = "",
  launchMode = "single-leader",
  runId = "",
  projectRoot,
}) {
  const pipeline = normalizePipeline(rawPipeline);
  const mode = normalizeLaunchMode(launchMode);
  const leaderAgentName = pipeline.leaderAgentName || toLeaderAgentName(pipeline.name);
  const resolvedProjectPath = resolveProjectPath(pipeline.projectPath, projectRoot);
  const prompt = renderLaunchPrompt(pipeline, requirement, mode, resolvedProjectPath);
  const command = buildLaunchCommand(pipeline, prompt, leaderAgentName, runId, resolvedProjectPath);

  return {
    leaderAgentName,
    launchMode: mode,
    resolvedProjectPath,
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
  const gateProtocol = renderGateProtocolBulletList();
  const gateMatrix = renderGateMatrix(pipeline);
  const recursiveProtocol = renderRecursiveDelegationProtocol(pipeline);

  return `---
name: ${leaderAgentName}
description: Coordinates the ${pipeline.name} AgentFlow pipeline from requirement intake to human-gated delivery.
model: sonnet
tools: Read, Write, Edit, MultiEdit, Grep, Glob, Bash
---

You are the invoked Team Leader for the AgentFlow pipeline "${pipeline.name}".

Use the AgentFlow compiled assets as your source of truth:

- Project path: ${pipeline.projectPath}
- Pipeline SOP: .agentflow/compiled/sop.md
- Delegation policy: .agentflow/compiled/delegation-policy.md
- Gate plan: .agentflow/compiled/gates.md
- Machine-readable gate plan: .agentflow/compiled/gates.json
- Bootstrap skill: .claude/skills/using-agentflow/SKILL.md
${renderKnowledgeWikiAssetList(pipeline)}

Available roles:
${agentLines}

Structured pipeline definition:

\`\`\`json
${JSON.stringify(pipeline, null, 2)}
\`\`\`

Execution rules:
- Start by invoking and following the using-agentflow workflow.
- If the user or main session explicitly invokes you via ${formatLiveAgentHandle(leaderAgentName)}, treat that as live handoff intent and continue as the invoked leader instead of asking the main session to act as you.
- Restate the user requirement, identify the current stage, then choose self / subagent / parallel subagents / agent team.
- When activating yourself or delegating, always use full Claude role handles such as @${leaderAgentName}.
- Shared agents are referenced by name and must not be rewritten by this pipeline.
- Apply delegationPolicy strictly: start simple, escalate only when the rules justify it.
- Claude Code agent teams are experimental and do not support nested teams; recursive delegation must be coordinated by you.
- If launch mode or user instruction is force-team, create or attach live team context before deep analysis whenever runtime supports it.
- Never exceed maxDepth or maxParallelAgents. If deeper delegation is needed, ask the user first.
- Treat all configured gates with enforcement=block as blocking controls, not soft reminders.
- Treat each stage boundary as a review gate.
- Keep decisions, risks, artifacts, and next steps traceable.
- Do not simulate delegation in force-team mode or after an explicit live leader invocation unless the user explicitly approves fallback.
- If runtime handoff fails because the team context does not exist, bootstrap the team context first (for example via spawnTeam when available), then retry the same live invocation.
- Only use simulated delegation when live startup is unavailable and the user has explicitly approved fallback.
- When delegating to shared agents, include the exact action contract, gate contract, and recursive delegation contract in the delegated brief.
- Execute using-agentflow, gate handling, and stage orchestration after live handoff/team startup, not as a replacement for it.

Recursive delegation protocol:
${recursiveProtocol}

Blocking gate protocol:
${gateProtocol}

Gate matrix:
${gateMatrix}

Approval request template:

\`\`\`text
GATE_PENDING
gate_id: <gate-id>
gate_name: <gate-name>
stage: <stage-name>
action: <action-name>
owner: @<agent-name>
evidence:
- <artifact or decision>
- <risk / assumption / validation result>
decision_needed: approve | reject
\`\`\`
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

Assigned actions:
${renderRoleActionSummary(stage, agent)}

Blocking gate contract:
${renderRoleGateContract(pipeline, stage, agent)}

Recursive delegation contract:
${renderRoleRecursiveDelegationContract(pipeline, stage, agent)}

Operating rules:
- Stay within this role unless the Team Leader explicitly asks otherwise.
- Do not create or attach an independent Agent Team. Only the Team Leader may start or manage a team.
- Do not create another subagent unless the Team Leader explicitly grants APPROVED_RECURSIVE_DELEGATION for this task.
- Gates are blocking execution controls, not reminders.
- Before a gated step, stop and surface the required evidence to the Team Leader.
- Resume only after the Team Leader gives an explicit APPROVED:<gate-id> style confirmation.
- If approved scope changes materially, reopen the gate instead of silently continuing.
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
- Gates: ${renderGateReferenceList(pipeline, action.gates)}`;
        })
        .join("\n\n");

      return `## ${index + 1}. ${stage.name}

${actions || "No actions configured."}`;
    })
    .join("\n\n");

  return `# ${pipeline.name} SOP

${pipeline.sop.description}

## Gate Protocol

${renderGateProtocolBulletList()}

${stages || "No stages configured."}

## Quality Gates

${renderDetailedGateDefinitions(pipeline)}
`;
}

export function renderDelegationPolicyMarkdown(pipeline) {
  const policy = pipeline.delegationPolicy;
  const leaderAgentName = pipeline.leaderAgentName || toLeaderAgentName(pipeline.name);
  const recursiveProtocol = renderRecursiveDelegationProtocol(pipeline);
  return `# ${pipeline.name} Delegation Policy

- Default mode: ${policy.defaultMode}
- Allow subagents: ${policy.allowSubAgents ? "yes" : "no"}
- Allow agent team: ${policy.allowAgentTeam ? "yes" : "no"}
- Allow recursive delegation: ${policy.allowRecursiveDelegation ? "yes" : "no"}
- Max depth: ${policy.maxDepth}
- Max parallel agents: ${policy.maxParallelAgents}

## Decision Rules

### Self
${policy.escalationRules.self}

### Sub Agent
${policy.escalationRules.subAgent}

### Agent Team
${policy.escalationRules.team}

### Recursive Delegation
${policy.escalationRules.recursive}

## Recursive Delegation Protocol

${recursiveProtocol}

## Runtime Constraints

- Use self for low-risk, bounded, quickly verifiable work.
- Use subagents for isolated research, review, or implementation tasks with clear inputs and outputs.
- Use parallel subagents only when write scopes do not conflict.
- Use agent team for cross-role product/design/development/testing collaboration.
- Claude Code agent teams do not support nested teams; all recursive delegation must be coordinated by the Team Leader.
- When the user explicitly invokes ${formatLiveAgentHandle(leaderAgentName)}, treat that invocation as the highest-priority runtime action.
- Do not perform repository analysis, workflow execution, gate handling, or simulation in the main session before the live handoff attempt.
- In force-team mode, do not replace live startup with simulated delegation unless the user explicitly approves fallback.
- If runtime returns a recoverable team-not-found style error, bootstrap the team context first, then retry the same live invocation.
- Any action-level gate with enforcement=block is blocking: request the required executor decision, wait, then continue.
- Shared agents are read-only references, so the Team Leader must paste the relevant gate contract into delegated prompts.
`;
}

export function renderUsingAgentFlowSkill(pipeline) {
  const leaderAgentName = pipeline.leaderAgentName || toLeaderAgentName(pipeline.name);
  const recursiveProtocol = renderRecursiveDelegationProtocol(pipeline);
  const knowledgeInstructions = renderUsingAgentFlowKnowledgeInstructions(pipeline);
  return `---
name: using-agentflow
description: Use when starting or executing any AgentFlow-managed pipeline. Loads the pipeline SOP, delegation policy, quality gates, knowledge wiki, and role routing rules before work begins.
---

# Using AgentFlow

You are operating inside the AgentFlow pipeline "${pipeline.name}".

Before taking action:

1. Read the pipeline SOP from .agentflow/compiled/sop.md.
2. Read the delegation policy from .agentflow/compiled/delegation-policy.md.
3. Read the gate plan from .agentflow/compiled/gates.md. Use .agentflow/compiled/gates.json when you need structured gate data.
4. If Knowledge Wiki is enabled, follow the Knowledge Wiki orientation below before stage work.
5. Identify the current stage and required artifacts.
6. Classify task complexity.
7. Decide execution mode: self / subagent / parallel subagents / agent team / ask human.
8. Use full @agent names when delegating.
9. If a gate applies, emit a GATE_PENDING packet before execution and wait for the required executor decision.
10. Record artifacts, risks, decisions, next steps, and any Knowledge Wiki update proposal.

Knowledge Wiki:

${knowledgeInstructions}

Important:

- Shared agents are read-only references.
- Managed agents may be regenerated by AgentFlow.
- Claude Code agent teams are experimental and do not support nested teams.
- If the request arrived via an explicit live handle such as ${formatLiveAgentHandle(leaderAgentName)}, preserve the handoff-first behavior and do not downgrade to simulation without explicit approval.
- Gates are blocking controls, not reminders.
- If the user requirement is unclear, ask before delegating.

Recursive delegation:

${recursiveProtocol}
`;
}

function renderUsingAgentFlowKnowledgeInstructions(pipeline) {
  if (!pipeline.knowledgeBase?.enabled) {
    return "- Knowledge Wiki is disabled for this pipeline.";
  }

  const kb = pipeline.knowledgeBase;
  const wikiPath = kb.path || ".agentflow/wiki";
  const writeModeRule = {
    proposal_first: "At stage boundaries, propose wiki updates first. Write only after explicit user approval.",
    auto_write: "You may update wiki pages during execution, but still summarize touched files and preserve raw sources.",
    readonly: "Read the wiki for context only. Do not write wiki files unless the user explicitly overrides readonly mode.",
  }[kb.writeMode] || "At stage boundaries, propose wiki updates first. Write only after explicit user approval.";

  return [
    `- Wiki path: ${wikiPath}`,
    `- Domain: ${kb.domain}`,
    `- Write mode: ${kb.writeMode}`,
    `- Auto orientation: ${kb.autoOrient ? "enabled" : "disabled"}`,
    `- Raw sources immutable: ${kb.rawImmutable ? "yes" : "no"}`,
    "- Before using project knowledge, read:",
    `  1. ${wikiPath}/SCHEMA.md`,
    `  2. ${wikiPath}/index.md`,
    `  3. ${wikiPath}/log.md recent entries`,
    "- Use .claude/skills/using-agentflow-wiki/SKILL.md for wiki maintenance rules when ingesting, querying, or proposing updates.",
    `- ${writeModeRule}`,
    "- Valuable stage outputs should become durable wiki pages: requirements, designs, decisions, reviews, entities, concepts, comparisons, and reusable queries.",
  ].join("\n");
}

function renderKnowledgeWikiAssetList(pipeline) {
  if (!pipeline.knowledgeBase?.enabled) return "";
  const wikiPath = pipeline.knowledgeBase.path || ".agentflow/wiki";
  return [
    `- Knowledge Wiki policy: .agentflow/compiled/wiki-policy.md`,
    `- Knowledge Wiki ingest prompt: .agentflow/compiled/wiki-ingest.prompt.md`,
    `- Knowledge Wiki query prompt: .agentflow/compiled/wiki-query.prompt.md`,
    `- Knowledge Wiki schema: ${wikiPath}/SCHEMA.md`,
    `- Knowledge Wiki index: ${wikiPath}/index.md`,
    `- Knowledge Wiki log: ${wikiPath}/log.md`,
    "- Knowledge Wiki skill: .claude/skills/using-agentflow-wiki/SKILL.md",
  ].join("\n");
}

function renderLaunchPrompt(pipeline, requirement, launchMode, resolvedProjectPath) {
  const leaderAgentName = pipeline.leaderAgentName || toLeaderAgentName(pipeline.name);
  const agents = pipeline.stages
    .flatMap((stage) => stage.agents.map((agent) => `- @${agent.agentName} (${agent.name})：${agent.responsibility || agent.description}`))
    .join("\n") || "- 暂无配置 Agent";
  const liveHandle = formatLiveAgentHandle(leaderAgentName);
  const modeInstruction = buildModeInstruction(launchMode, pipeline);

  return `${liveHandle} ${buildInvocationDirective(launchMode)}

用户需求：
${requirement || "用户尚未填写需求，请先询问用户要实现什么。"}

Main session handoff rules:
1. 上面的 ${liveHandle} 是本轮最高优先级动作，必须先执行 live agent handoff。
2. 在 handoff 尝试之前，主会话不得做仓库分析、workflow 执行、gate 处理、计划拆解或 delegation simulation。
3. 如果 runtime 返回 team 不存在或 team context 缺失，先初始化/补齐 team（例如 spawnTeam，如果可用），再重试同一个 ${liveHandle} 调用。
4. 如果本轮是 force-team，严禁用主会话模拟 delegation 替代 live team；只有用户明确同意 fallback 才能降级。
5. using-agentflow、阶段判断、gate、team orchestration 必须由 handoff 成功后的 leader agent 执行，而不是由主会话预先执行。
6. 你的第一段非空输出必须是实际的 handoff 动作或 handoff 尝试结果，不要先输出分析说明。

Invoked leader context:
- AgentFlow pipeline: ${pipeline.name}
- Live leader handle: ${liveHandle}

项目路径：
${resolvedProjectPath}

启动模式：
${launchMode}

${modeInstruction}

可用角色：
${agents}

Leader execution requirements after handoff:
1. 先加载并遵守 using-agentflow 规则。
2. 先判断任务复杂度，再选择 self / subagent / parallel subagents / agent team。
3. 委托时必须使用完整 @agent 名称。
4. 门禁是阻断式控制，命中 block 级别门禁后必须先发起 GATE_PENDING，并按门禁放行方式等待批准、审查或检查结果。
5. 输出阶段状态、产物、风险和下一步。

递归委托协议：
${renderRecursiveDelegationBrief(pipeline)}

关键门禁矩阵：
${renderGateMatrix(pipeline)}

结构化流水线摘要：

${renderRunSummary(pipeline, resolvedProjectPath)}
`;
}

function buildModeInstruction(launchMode, pipeline) {
  if (launchMode === "force-team") {
    return `请以 force-team 模式执行本需求。

要求：
- 第一动作是完成 ${formatLiveAgentHandle(pipeline.leaderAgentName || toLeaderAgentName(pipeline.name))} 的 live handoff，而不是主会话分析。
- 如果 team context 不存在，先初始化 team，再重试同一个 live invocation。
- 由你作为 team lead 维护任务列表。
- 团队成员应优先从当前流水线 Agent 中选择。
- 每个 teammate 必须拥有清晰写入边界。
- 高风险变更必须先计划，得到 lead 批准后再实施。
- 完成后综合所有 teammate 结论。
- 未经用户明确批准，不得退化为主会话模拟 delegation。`;
  }

  if (launchMode === "suggest-team") {
    return `请在 live handoff 成功后评估是否需要创建 Claude Code agent team。

如果任务跨产品、架构、研发、测试，或需要多角色讨论，请先说明理由并建议启动 team；如果任务可单点完成，则保持 single leader 或 subagent 模式。
如果 runtime 因 team context 缺失导致 handoff 失败，请先初始化 team context 再继续。`;
  }

  return `请默认以 single leader 模式开始，但仍然必须先完成 live handoff。

只有当任务明确需要隔离探索、专项审查或跨角色协作时，才创建 subagent 或建议升级到 agent team。`;
}

function buildInvocationDirective(launchMode) {
  if (launchMode === "force-team") {
    return "请以 force-team 模式接管以下任务，并在需要时启动 live team。";
  }

  if (launchMode === "suggest-team") {
    return "请先接管以下任务，并在 handoff 后评估是否需要 live team。";
  }

  return "请以 single-leader 模式先接管以下任务。";
}

function formatLiveAgentHandle(agentName) {
  return `@"${agentName} (agent)"`;
}

function renderRunSummary(pipeline, resolvedProjectPath = pipeline.projectPath) {
  const stages = pipeline.stages
    .map((stage, index) => {
      const agents = stage.agents.length
        ? stage.agents.map((agent) => `    - @${agent.agentName}：${agent.produce.join(", ")}`).join("\n")
        : "    - no agents";
      const actions = stage.actions
        .map((action) => `    - ${action.name} -> ${action.outputs.join(", ")} | gates: ${renderGateReferenceList(pipeline, action.gates)}`)
        .join("\n");
      return `${index + 1}. ${stage.name}\n  Agents:\n${agents}\n  Actions:\n${actions || "    - no actions"}`;
    })
    .join("\n");

  return [
    `Pipeline: ${pipeline.name}`,
    `Leader agent: @${pipeline.leaderAgentName || toLeaderAgentName(pipeline.name)}`,
    `Project: ${resolvedProjectPath}`,
    "",
    "Delegation policy:",
    JSON.stringify(pipeline.delegationPolicy, null, 2),
    "",
    "Stages:",
    stages || "No stages configured.",
  ].join("\n");
}

function buildGatePlan(pipeline) {
  const gateMap = buildGateMap(pipeline);
  return {
    version: 1,
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    leaderAgentName: pipeline.leaderAgentName || toLeaderAgentName(pipeline.name),
    qualityGates: resolveGateDetails(gateMap, pipeline.qualityGates.map((gate) => gate.id)),
    gateExecutors: [...new Set(pipeline.qualityGates.map((gate) => normalizeGateDefinition(gate).executor))],
    gateTriggers: [...new Set(pipeline.qualityGates.map((gate) => normalizeGateDefinition(gate).trigger))],
    gateProtocol: {
      pendingState: "GATE_PENDING",
      approvedState: "APPROVED",
      rejectedState: "REJECTED",
      staleState: "STALE",
      rules: renderGateProtocolRules(),
    },
    actionGates: pipeline.stages.flatMap((stage) =>
      stage.actions.map((action) => ({
        stageId: stage.id,
        stageName: stage.name,
        actionId: action.id,
        actionName: action.name,
        owner: action.owner,
        inputs: action.inputs,
        outputs: action.outputs,
        gates: resolveGateDetails(gateMap, action.gates),
      }))
    ),
    roleGates: pipeline.stages.flatMap((stage) =>
      stage.agents.map((agent) => {
        const actions = getRoleActions(stage, agent);
        return {
          stageId: stage.id,
          stageName: stage.name,
          roleName: agent.name,
          agentName: agent.agentName,
          source: agent.source,
          actions: actions.map((action) => ({
            id: action.id,
            name: action.name,
            inputs: action.inputs,
            outputs: action.outputs,
            gates: resolveGateDetails(gateMap, action.gates),
          })),
          gates: uniqueGateDetails(actions.flatMap((action) => resolveGateDetails(gateMap, action.gates))),
        };
      })
    ),
  };
}

function renderGatePlanMarkdown(pipeline) {
  const plan = buildGatePlan(pipeline);
  const roleContracts = plan.roleGates
    .map((role) => {
      const actions = role.actions.length
        ? role.actions
            .map((action) => `- ${action.id} | ${action.name} | gates: ${action.gates.map((gate) => gate.id).join(", ") || "none"}`)
            .join("\n")
        : "- 当前没有直接 owner 到该角色的 action。";
      const gates = role.gates.length
        ? role.gates
            .map((gate) => `- ${gate.id} (${gate.name})：${gate.description} | evidence: ${gate.evidenceHints.join("；")}`)
            .join("\n")
        : "- 当前没有角色专属 action gate。";

      return `### ${role.stageName} / ${role.roleName} (@${role.agentName})

- Source: ${role.source}
- Owned actions:
${actions}
- Gate contract:
${gates}`;
    })
    .join("\n\n");

  return `# ${pipeline.name} Gate Plan

## Blocking Protocol

${renderGateProtocolBulletList()}

Gate request template:

\`\`\`text
GATE_PENDING
gate_id: <gate-id>
stage: <stage-name>
action: <action-name>
owner: @<agent-name>
evidence:
- <artifact or decision>
- <risk / assumption / validation result>
decision_needed: approve | review | revise | reject
\`\`\`

## Quality Gate Definitions

${renderDetailedGateDefinitions(pipeline)}

## Action Gate Matrix

${renderGateMatrix(pipeline)}

## Role Contracts

${roleContracts || "- 当前没有角色合同。"}
`;
}

function renderGateProtocolBulletList() {
  return renderGateProtocolRules().map((rule) => `- ${rule}`).join("\n");
}

function renderGateProtocolRules() {
  return [
    "Gates are blocking execution controls, not reminders.",
    "When an action hits a gate, surface GATE_PENDING with gate id, stage, action, owner, evidence, and requested decision.",
    "For block gates, wait for the required release decision before continuing past the gate.",
    "For human_approval or human_review gates, wait for explicit human approval or review.",
    "For ai_review gates, produce the requested evidence, check it against pass criteria, and ask the human if the result is ambiguous or high risk.",
    "If the gate is rejected or fails the pass criteria, follow failAction before re-requesting the gate.",
    "If an approved artifact changes materially, mark the gate stale and request approval again.",
    "When delegating to shared agents, paste the relevant gate contract into the delegated brief so the guardrails stay intact.",
  ];
}

function renderRecursiveDelegationProtocol(pipeline) {
  const policy = pipeline.delegationPolicy;
  const enabled = policy.allowRecursiveDelegation;
  const maxDepth = policy.maxDepth;
  const maxParallelAgents = policy.maxParallelAgents;

  if (!enabled) {
    return [
      "- Status: disabled.",
      "- Child agents must not create subagents or teams.",
      "- If a child agent cannot complete its assigned scope, it must return BLOCKED_DELEGATION to the Team Leader with reason, missing input, and suggested next owner.",
      "- The Team Leader may reassign work, split the task at the top level, or ask the user for clarification.",
      "- Gates still bubble up to the Team Leader.",
    ].join("\n");
  }

  return [
    "- Status: enabled, but controlled by the Team Leader.",
    `- Max delegation depth: ${maxDepth}. Depth 1 means Team Leader -> configured role agent; depth 2 means that role agent may request one bounded helper; depth 3 means one additional helper layer only when explicitly approved.`,
    `- Max parallel agents: ${maxParallelAgents} across the whole run, including recursive helpers.`,
    "- Only the Team Leader may create or manage an Agent Team. Child agents must never create nested teams or spawnTeam by themselves.",
    "- Child agents may request recursive delegation, but they must not create subagents until the Team Leader approves the request.",
    "- The Team Leader must approve recursive delegation only when the subtask has a narrow scope, clear inputs, clear outputs, clear write boundaries, and an owner that can be reviewed.",
    "- Recursive helpers inherit all relevant action contracts, gate contracts, write restrictions, and gate executors from their parent task.",
    "- Any gate hit by a recursive helper bubbles up to the parent agent and then to the Team Leader. Helpers must not approve their own gates.",
    "- Recursive outputs must return to the parent agent first. The parent agent validates and summarizes them before the Team Leader integrates them.",
    "- If the next delegation would exceed maxDepth or maxParallelAgents, the Team Leader must deny the request or ask the user before continuing.",
    "",
    "Child agent request packet:",
    "",
    "RECURSIVE_DELEGATION_REQUEST",
    "from: @<requesting-agent>",
    "current_depth: <number>",
    "requested_depth: <number>",
    "reason: <why this cannot be completed safely by the current agent>",
    "proposed_subtask: <bounded task>",
    "inputs:",
    "- <input artifact or context>",
    "outputs:",
    "- <expected artifact>",
    "write_scope:",
    "- <files/directories or none>",
    "gates:",
    "- <gate-id or none>",
    "risk: <low | medium | high>",
    "",
    "Team Leader approval packet:",
    "",
    "APPROVED_RECURSIVE_DELEGATION",
    "to: @<requesting-agent>",
    "approved_depth: <number>",
    "allowed_subtask: <bounded task>",
    "allowed_write_scope:",
    "- <files/directories or none>",
    "required_outputs:",
    "- <expected artifact>",
    "required_gates:",
    "- <gate-id or none>",
    "stop_condition: <when the helper must stop and report back>",
  ].join("\n");
}

function renderRecursiveDelegationBrief(pipeline) {
  const policy = pipeline.delegationPolicy;
  if (!policy.allowRecursiveDelegation) {
    return "递归委托关闭：子 Agent 不能再创建 subagent 或 team；遇到复杂/阻塞任务必须回报 Team Leader。";
  }

  return [
    `递归委托开启，但必须由 Team Leader 控制。最大深度 ${policy.maxDepth}，全局最大并行 Agent ${policy.maxParallelAgents}。`,
    "子 Agent 只能提交 RECURSIVE_DELEGATION_REQUEST，不能自行创建 team，不能绕过 gate。",
    "只有 Team Leader 发出 APPROVED_RECURSIVE_DELEGATION 后，子 Agent 才能创建受控 helper subagent。",
    "所有递归 helper 的产物必须先回到父 Agent，再由 Team Leader 汇总。",
  ].join("\n");
}

function renderRoleRecursiveDelegationContract(pipeline, stage, agent) {
  const policy = pipeline.delegationPolicy;
  const ownedActions = getRoleActions(stage, agent);
  const gateIds = [...new Set(ownedActions.flatMap((action) => action.gates || []))];

  if (!policy.allowRecursiveDelegation) {
    return [
      "- Recursive delegation is disabled for this pipeline.",
      "- Do not create subagents, helper agents, or teams.",
      "- If your assigned action becomes too broad or blocked, report BLOCKED_DELEGATION to the Team Leader instead of splitting work yourself.",
    ].join("\n");
  }

  return [
    "- You are normally operating at delegation depth 1 unless the Team Leader explicitly assigns another depth.",
    `- Pipeline maxDepth is ${policy.maxDepth}; never request or use a depth above that value.`,
    `- Pipeline maxParallelAgents is ${policy.maxParallelAgents}; ask the Team Leader to account for this before adding helpers.`,
    "- You may not create or attach an Agent Team. Team orchestration is reserved for the Team Leader.",
    "- You may not create a helper subagent by yourself. First emit RECURSIVE_DELEGATION_REQUEST and wait for APPROVED_RECURSIVE_DELEGATION.",
    "- If approved, pass only the approved subtask, approved write scope, required outputs, and required gates to the helper.",
    "- A helper's output is not final. Review it, summarize it, and return your own consolidated result to the Team Leader.",
    "- If a helper reaches a gate, stop and bubble it up to the Team Leader.",
    gateIds.length ? `- Your directly inherited gates are: ${gateIds.join(", ")}.` : "- No direct action gate is assigned to this role.",
    "",
    "Use this request format when you need help:",
    "",
    "RECURSIVE_DELEGATION_REQUEST",
    `from: @${agent.agentName}`,
    "current_depth: 1",
    "requested_depth: 2",
    "reason: <why help is needed>",
    "proposed_subtask: <bounded task>",
    "inputs:",
    "- <input artifact or context>",
    "outputs:",
    "- <expected artifact>",
    "write_scope:",
    "- <files/directories or none>",
    "gates:",
    "- <gate-id or none>",
    "risk: <low | medium | high>",
  ].join("\n");
}

function renderGateMatrix(pipeline) {
  const lines = pipeline.stages.flatMap((stage) =>
    stage.actions.map(
      (action) =>
        `- ${stage.name} / ${action.name} / @${action.owner || "未配置"} / ${renderGateReferenceList(pipeline, action.gates)}`
    )
  );
  return lines.join("\n") || "- 当前没有 action 级门禁。";
}

function renderDetailedGateDefinitions(pipeline) {
  const gates = resolveGateDetails(buildGateMap(pipeline), pipeline.qualityGates.map((gate) => gate.id));
  return gates.length
    ? gates
        .map(
          (gate) =>
            `- ${gate.id} (${gate.domain}/${gate.trigger}/${gate.executor}/${gate.enforcement})：${gate.description}\n  Evidence: ${gate.evidenceHints.join("；")}\n  Pass criteria: ${gate.passCriteria}\n  Fail action: ${gate.failAction}`
        )
        .join("\n")
    : "- 当前没有 quality gate 定义。";
}

function renderGateReferenceList(pipeline, gateIds = []) {
  const gates = resolveGateDetails(buildGateMap(pipeline), gateIds);
  return gates.length
    ? gates.map((gate) => `${gate.id}（${gate.name}/${gate.trigger}/${gate.executor}/${gate.enforcement}）`).join(", ")
    : "none";
}

function renderRoleActionSummary(stage, agent) {
  const actions = getRoleActions(stage, agent);
  return actions.length
    ? actions
        .map(
          (action) =>
            `- ${action.id} | ${action.name} | inputs: ${action.inputs.join(", ") || "none"} | outputs: ${action.outputs.join(", ") || "none"}`
        )
        .join("\n")
    : "- 当前没有直接 owner 到你的 action，默认等待 Team Leader 派发具体工作。";
}

function renderRoleGateContract(pipeline, stage, agent) {
  const gateMap = buildGateMap(pipeline);
  const actions = getRoleActions(stage, agent);
  if (!actions.length) {
    return "- 当前没有直接 owner 到你的 action。";
  }

  return [
    ...actions.map((action) => {
      const gates = resolveGateDetails(gateMap, action.gates);
      const gateLines = gates.length
        ? gates
            .map(
              (gate) =>
                `- ${gate.id}（${gate.name}/${gate.trigger}/${gate.executor}/${gate.enforcement}）：${gate.description}\n  Evidence: ${gate.evidenceHints.join("；")}\n  Pass criteria: ${gate.passCriteria}\n  Fail action: ${gate.failAction}`
            )
            .join("\n")
        : "- 当前 action 没有直接 stage gate。";

      return `### ${action.name}

- Action ID: ${action.id}
- Inputs: ${action.inputs.join(", ") || "none"}
- Outputs: ${action.outputs.join(", ") || "none"}
- Gates:
${gateLines}`;
    }),
  ].join("\n\n");
}

function getRoleActions(stage, agent) {
  return (stage.actions || []).filter((action) => action.owner === agent.agentName);
}

function buildGateMap(pipeline) {
  const gateMap = new Map();
  for (const gate of pipeline.qualityGates || []) {
    gateMap.set(gate.id, normalizeGateDefinition(gate));
  }
  return gateMap;
}

function resolveGateDetails(gateMap, gateIds = []) {
  return uniqueGateDetails(
    (gateIds || []).map((gateId) => gateMap.get(gateId) || normalizeGateDefinition({ id: gateId }))
  );
}

function uniqueGateDetails(gates) {
  const seen = new Set();
  return gates.filter((gate) => {
    if (!gate?.id || seen.has(gate.id)) return false;
    seen.add(gate.id);
    return true;
  });
}

function normalizeGateDefinition(gate = {}) {
  const fallback = fallbackGateDefinition(gate.id);
  const id = String(gate.id || fallback.id);
  const name = String(gate.name || fallback.name);
  const type = String(gate.type || fallback.type || "human");
  const executor = normalizeGateExecutor(gate.executor || fallback.executor, type);
  const domain = String(gate.domain || fallback.domain || inferGateDomain({ id, name, description: gate.description || fallback.description }));
  const trigger = String(gate.trigger || fallback.trigger || inferGateTrigger({ id, name, description: gate.description || fallback.description }));
  const enforcement = String(gate.enforcement || fallback.enforcement || (gate.required === false ? "warn" : "block"));
  const required = gate.required === undefined ? enforcement === "block" : gate.required !== false;
  const description = String(gate.description || fallback.description);
  const evidenceHints = Array.isArray(gate.evidence) && gate.evidence.length
    ? gate.evidence.map(String)
    : inferGateEvidenceHints({ id, name, type, domain, trigger, executor, description });
  return {
    id,
    name,
    type,
    domain,
    trigger,
    executor,
    enforcement,
    required,
    description,
    evidenceHints,
    passCriteria: String(gate.passCriteria || fallback.passCriteria || inferGatePassCriteria({ id, name, description })),
    failAction: String(gate.failAction || fallback.failAction || "revise"),
  };
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

function fallbackGateDefinition(gateId) {
  const defaults = {
    "requirement-review": {
      id: "requirement-review",
      name: "需求确认",
      type: "human",
      domain: "requirement",
      trigger: "before_stage_exit",
      executor: "human_approval",
      enforcement: "block",
      description: "需求边界、验收标准和关键风险必须先确认。",
      passCriteria: "需求边界、验收标准和关键风险已明确。",
      failAction: "ask_user",
    },
    "architecture-review": {
      id: "architecture-review",
      name: "方案确认",
      type: "human",
      domain: "architecture",
      trigger: "before_stage_exit",
      executor: "human_approval",
      enforcement: "block",
      description: "方案、接口契约、技术取舍和验证路径必须先确认。",
      passCriteria: "架构方案、接口契约和风险处理已确认。",
      failAction: "revise",
    },
    "write-files": {
      id: "write-files",
      name: "写文件前",
      type: "human",
      domain: "code",
      trigger: "before_write",
      executor: "human_approval",
      enforcement: "block",
      description: "动手改代码前必须确认文件边界、影响面和回滚路径。",
      passCriteria: "写入范围、影响面和回滚路径已确认。",
      failAction: "ask_user",
    },
    "completion-review": {
      id: "completion-review",
      name: "完成验收",
      type: "review",
      domain: "test",
      trigger: "after_diff",
      executor: "human_review",
      enforcement: "block",
      description: "交付完成后必须回顾产物、验证结果和剩余风险。",
      passCriteria: "交付内容、验证结果和剩余风险已通过验收。",
      failAction: "revise",
    },
    "destructive-command": {
      id: "destructive-command",
      name: "破坏性命令",
      type: "security",
      domain: "security",
      trigger: "before_command",
      executor: "human_approval",
      enforcement: "block",
      description: "删除、重置、迁移或其他不可逆操作必须先确认。",
      passCriteria: "破坏性操作的必要性、影响面和回滚方案已确认。",
      failAction: "stop",
    },
    deployment: {
      id: "deployment",
      name: "发布前确认",
      type: "human",
      domain: "release",
      trigger: "before_pr",
      executor: "human_approval",
      enforcement: "block",
      description: "上线前必须确认发布范围、验证方式和回滚方案。",
      passCriteria: "发布范围、验证清单和回滚方案已确认。",
      failAction: "stop",
    },
  };

  return defaults[gateId] || {
    id: String(gateId || "gate"),
    name: String(gateId || "未命名门禁"),
    type: "human",
    domain: inferGateDomain({ id: gateId }),
    trigger: inferGateTrigger({ id: gateId }),
    executor: "human_approval",
    enforcement: "block",
    description: "该门禁未提供详细说明，请至少提交范围、风险、验证结果和待确认决策。",
    passCriteria: inferGatePassCriteria({ id: gateId }),
    failAction: "revise",
  };
}

function inferGateEvidenceHints(gate) {
  const text = `${gate.id} ${gate.name} ${gate.domain} ${gate.trigger} ${gate.executor} ${gate.description}`;
  if (/需求|requirement/i.test(text)) {
    return ["需求摘要与范围边界", "验收标准", "关键风险与待确认问题"];
  }
  if (/方案|架构|architecture|design|api/i.test(text)) {
    return ["方案摘要与关键取舍", "接口契约/数据流", "测试策略与主要风险"];
  }
  if (/写文件|write|code|实现/i.test(text)) {
    return ["拟修改文件列表", "改动边界与影响面", "验证方式与回滚预案"];
  }
  if (/完成|验收|completion|review/i.test(text)) {
    return ["交付产物清单", "验证结果", "剩余风险与下一步"];
  }
  if (/破坏|destructive|delete|reset|migration/i.test(text)) {
    return ["即将执行的命令或操作", "受影响资源", "备份与回滚方案"];
  }
  if (/发布|上线|deployment|release/i.test(text)) {
    return ["发布范围", "验证清单", "回滚方案与影响窗口"];
  }
  return ["当前决策摘要", "风险与假设", "验证结果或计划"];
}

function inferGateDomain(gate) {
  const text = `${gate.id || ""} ${gate.name || ""} ${gate.description || ""}`;
  if (/需求|requirement|prd/i.test(text)) return "requirement";
  if (/方案|架构|architecture|design|api/i.test(text)) return "architecture";
  if (/依赖|dependency|package|lockfile|npm|pnpm|yarn/i.test(text)) return "dependency";
  if (/安全|密钥|secret|token|权限|security|destructive|delete|reset|migration|破坏/i.test(text)) return "security";
  if (/发布|上线|deployment|release|pr/i.test(text)) return "release";
  if (/测试|验收|test|lint|build|completion|review/i.test(text)) return "test";
  if (/写文件|write|code|实现/i.test(text)) return "code";
  return "code";
}

function inferGateTrigger(gate) {
  const text = `${gate.id || ""} ${gate.name || ""} ${gate.description || ""}`;
  if (/写文件|write/i.test(text)) return "before_write";
  if (/命令|command|bash|destructive|delete|reset|migration|破坏/i.test(text)) return "before_command";
  if (/发布|上线|deployment|release|pr/i.test(text)) return "before_pr";
  if (/完成|验收|review|completion|diff/i.test(text)) return "after_diff";
  return "before_stage_exit";
}

function inferGatePassCriteria(gate) {
  const text = `${gate.id || ""} ${gate.name || ""} ${gate.description || ""}`;
  if (/需求|requirement/i.test(text)) return "需求边界、验收标准和关键风险已明确。";
  if (/方案|架构|architecture|design|api/i.test(text)) return "方案、接口契约、技术取舍和验证路径已确认。";
  if (/写文件|write|code|实现/i.test(text)) return "文件边界、影响面和验证方式已确认。";
  if (/完成|验收|completion|review/i.test(text)) return "交付产物、验证结果和剩余风险已通过审查。";
  if (/破坏|destructive|delete|reset|migration/i.test(text)) return "操作必要性、影响面、备份与回滚方案已确认。";
  if (/发布|上线|deployment|release/i.test(text)) return "发布范围、验证清单和回滚方案已确认。";
  return "证据充分，风险可接受，下一步动作清楚。";
}

function buildLaunchCommand(pipeline, prompt, leaderAgentName, runId, resolvedProjectPath) {
  return [
    `cd ${shellQuote(resolvedProjectPath)}`,
    "clear",
    `printf '%s\\n' ${shellQuote("AgentFlow 一键启动")}`,
    runId ? `printf '%s\\n' ${shellQuote(`Run ID: ${runId}`)}` : "",
    `printf '%s\\n' ${shellQuote(`Project: ${resolvedProjectPath}`)}`,
    `printf '%s\\n' ${shellQuote(`Leader: ${formatLiveAgentHandle(leaderAgentName)}`)}`,
    `claude ${shellQuote(prompt)}`,
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
      ".agentflow/compiled/definition.snapshot.json",
      ".agentflow/compiled/leader.md",
      ".agentflow/compiled/sop.md",
      ".agentflow/compiled/delegation-policy.md",
      ".agentflow/compiled/gates.md",
      ".agentflow/compiled/gates.json",
      ".agentflow/compiled/launch-prompt.md",
      ".claude/skills/using-agentflow/SKILL.md",
    ],
  };
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
