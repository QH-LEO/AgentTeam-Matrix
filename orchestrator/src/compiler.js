import path from "node:path";
import { normalizeDefinitionRequest, normalizeLaunchMode, normalizePipeline, toLeaderAgentName } from "./schema.js";
import { resolveConfiguredPath } from "./storage.js";

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
  const leaderAgentName = pipeline.leaderAgentName || toLeaderAgentName(pipeline.name);
  const compiledDir = path.join(paths.agentflowDir, "compiled", safeAsciiSlug(pipeline.id || pipeline.name));
  const refs = buildGlobalAssetRefs(pipeline, {
    agentflowDir: paths.agentflowDir,
    claudeDir: paths.claudeDir,
    compiledDir,
  });
  const knowledgeArtifacts = buildKnowledgeBaseArtifacts(pipeline, refs);
  const artifacts = [
    {
      type: "definition",
      path: paths.definitionPath,
      nextContent: `${JSON.stringify(definition, null, 2)}\n`,
    },
    {
      type: "pipeline-definition",
      path: refs.pipelineDefinitionPath,
      nextContent: `${JSON.stringify(definition, null, 2)}\n`,
    },
    {
      type: "manifest",
      path: path.join(compiledDir, "manifest.json"),
      nextContent: `${JSON.stringify(buildManifest(definition, refs), null, 2)}\n`,
    },
    {
      type: "compiled-definition-snapshot",
      path: path.join(compiledDir, "definition.snapshot.json"),
      nextContent: `${JSON.stringify(definition, null, 2)}\n`,
    },
    {
      type: "active-manifest",
      path: refs.activeManifestPath,
      nextContent: `${JSON.stringify(buildActiveManifest(definition, refs), null, 2)}\n`,
    },
    {
      type: "active-bootstrap",
      path: refs.activeBootstrapPath,
      nextContent: renderActiveBootstrap(pipeline, refs),
    },
    {
      type: "compiled-leader",
      path: path.join(compiledDir, "leader.md"),
      nextContent: renderTeamLeaderAgent(pipeline, refs),
    },
    {
      type: "compiled-sop",
      path: path.join(compiledDir, "sop.md"),
      nextContent: renderSopMarkdown(pipeline),
    },
    {
      type: "compiled-delegation-policy",
      path: path.join(compiledDir, "delegation-policy.md"),
      nextContent: renderDelegationPolicyMarkdown(pipeline),
    },
    {
      type: "compiled-gates",
      path: path.join(compiledDir, "gates.md"),
      nextContent: renderGatePlanMarkdown(pipeline),
    },
    {
      type: "compiled-gates-json",
      path: path.join(compiledDir, "gates.json"),
      nextContent: `${JSON.stringify(buildGatePlan(pipeline), null, 2)}\n`,
    },
    ...knowledgeArtifacts,
    {
      type: "compiled-launch-prompt",
      path: path.join(compiledDir, "launch-prompt.md"),
      nextContent: buildLaunchPrompt({
        pipeline,
        requirement: "",
        launchMode: "single-leader",
        refs,
      }).prompt,
    },
    {
      type: "using-agentflow-skill",
      path: path.join(paths.claudeDir, "skills", "using-agentflow", "SKILL.md"),
      nextContent: renderUsingAgentFlowSkill(pipeline, refs),
    },
    {
      type: "slash-command",
      path: path.join(paths.claudeDir, "commands", `${refs.commandName}.md`),
      nextContent: renderAgentFlowSlashCommand(pipeline, refs),
    },
    {
      type: "claude-global-memory",
      path: refs.claudeMemoryPath,
      nextContent: renderClaudeGlobalMemoryBlock(refs),
      mergeStrategy: "marker-block",
      markerStart: "<!-- AGENTFLOW:START -->",
      markerEnd: "<!-- AGENTFLOW:END -->",
    },
    {
      type: "leader-agent",
      path: path.join(paths.claudeAgentsDir, `${leaderAgentName}.md`),
      nextContent: renderTeamLeaderAgent(pipeline, refs),
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

function buildKnowledgeBaseArtifacts(pipeline, refs) {
  if (!pipeline.knowledgeBase?.enabled) return [];

  return [
    {
      type: "compiled-wiki-policy",
      path: path.join(refs.compiledDir, "wiki-policy.md"),
      nextContent: renderKnowledgeWikiPolicy(pipeline),
    },
    {
      type: "compiled-wiki-ingest-prompt",
      path: path.join(refs.compiledDir, "wiki-ingest.prompt.md"),
      nextContent: renderKnowledgeWikiIngestPrompt(pipeline),
    },
    {
      type: "compiled-wiki-query-prompt",
      path: path.join(refs.compiledDir, "wiki-query.prompt.md"),
      nextContent: renderKnowledgeWikiQueryPrompt(pipeline),
    },
    {
      type: "using-agentflow-wiki-skill",
      path: refs.usingAgentFlowWikiSkillPath,
      nextContent: renderUsingAgentFlowWikiSkill(pipeline),
    },
  ];
}

function buildGlobalAssetRefs(pipeline, options = {}) {
  const agentflowDir = options.agentflowDir || resolveConfiguredPath("~/.agentflow");
  const claudeDir = options.claudeDir || resolveConfiguredPath("~/.claude");
  const compiledDir = options.compiledDir || path.join(agentflowDir, "compiled", safeAsciiSlug(pipeline.id || pipeline.name));
  const commandName = `agentflow-${safeAsciiSlug(pipeline.id || pipeline.name)}`;
  return {
    agentflowDir,
    claudeDir,
    compiledDir,
    commandName,
    definitionPath: path.join(agentflowDir, "definitions", "agentflow.pipeline.json"),
    pipelineDefinitionPath: path.join(agentflowDir, "definitions", `${safeAsciiSlug(pipeline.id || pipeline.name)}.json`),
    activeDir: path.join(agentflowDir, "active"),
    activeManifestPath: path.join(agentflowDir, "active", "manifest.json"),
    activeBootstrapPath: path.join(agentflowDir, "active", "bootstrap.md"),
    manifestPath: path.join(compiledDir, "manifest.json"),
    snapshotPath: path.join(compiledDir, "definition.snapshot.json"),
    leaderPath: path.join(compiledDir, "leader.md"),
    sopPath: path.join(compiledDir, "sop.md"),
    delegationPolicyPath: path.join(compiledDir, "delegation-policy.md"),
    gatesPath: path.join(compiledDir, "gates.md"),
    gatesJsonPath: path.join(compiledDir, "gates.json"),
    launchPromptPath: path.join(compiledDir, "launch-prompt.md"),
    wikiPolicyPath: path.join(compiledDir, "wiki-policy.md"),
    wikiIngestPromptPath: path.join(compiledDir, "wiki-ingest.prompt.md"),
    wikiQueryPromptPath: path.join(compiledDir, "wiki-query.prompt.md"),
    usingAgentFlowSkillPath: path.join(claudeDir, "skills", "using-agentflow", "SKILL.md"),
    usingAgentFlowWikiSkillPath: path.join(claudeDir, "skills", "using-agentflow-wiki", "SKILL.md"),
    commandPath: path.join(claudeDir, "commands", `${commandName}.md`),
    claudeMemoryPath: path.join(claudeDir, "CLAUDE.md"),
  };
}

export function buildLaunchPrompt({
  pipeline: rawPipeline,
  requirement = "",
  launchMode = "single-leader",
  runId = "",
  refs = null,
  promptFilePath = "",
}) {
  const pipeline = normalizePipeline(rawPipeline);
  const mode = normalizeLaunchMode(launchMode);
  const leaderAgentName = pipeline.leaderAgentName || toLeaderAgentName(pipeline.name);
  const assetRefs = refs || buildGlobalAssetRefs(pipeline);
  const workingDirectory = "current Claude Code working directory";
  const prompt = renderLaunchPrompt(pipeline, requirement, mode, workingDirectory, runId, assetRefs);
  const command = buildLaunchCommand(pipeline, prompt, leaderAgentName, runId, workingDirectory, promptFilePath);

  return {
    leaderAgentName,
    launchMode: mode,
    resolvedProjectPath: workingDirectory,
    workingDirectory,
    prompt,
    command,
  };
}

export function renderTeamLeaderAgent(pipeline, refs = buildGlobalAssetRefs(pipeline)) {
  const leaderAgentName = pipeline.leaderAgentName || toLeaderAgentName(pipeline.name);
  const agents = pipeline.stages.flatMap((stage) => stage.agents);
  const agentLines = agents.length
    ? agents
        .map((agent) => {
          const skills = renderSkillSummary(effectiveAgentSkills(pipeline, agent));
          return `- @${agent.agentName} (${agent.name})：${agent.responsibility || agent.description} | skills: ${skills}`;
        })
        .join("\n")
    : "- 暂无配置 Agent，必要时由 Leader 模拟阶段产出。";
  const gateProtocol = renderGateProtocolBulletList();
  const gateMatrix = renderGateMatrix(pipeline);
  const recursiveProtocol = renderRecursiveDelegationProtocol(pipeline);
  const teamLifecycleRules = renderTeamLifecycleRules("compiled");
  const handoffRoutingProtocol = renderLiveHandoffRoutingProtocol(leaderAgentName);
  const artifactDisclosureProtocol = renderArtifactDisclosureProtocol();

  return `---
name: ${leaderAgentName}
description: Coordinates the ${pipeline.name} AgentFlow pipeline from requirement intake to human-gated delivery.
model: sonnet
tools: Read, Write, Edit, MultiEdit, Grep, Glob, Bash
---

You are the invoked Team Leader for the AgentFlow pipeline "${pipeline.name}".

Use the AgentFlow compiled assets as your source of truth:

- Global install root: ${refs.agentflowDir}
- Pipeline SOP: ${refs.sopPath}
- Delegation policy: ${refs.delegationPolicyPath}
- Gate plan: ${refs.gatesPath}
- Machine-readable gate plan: ${refs.gatesJsonPath}
- Bootstrap skill: ${refs.usingAgentFlowSkillPath}
- Startup command: /${refs.commandName}
${renderKnowledgeWikiAssetList(pipeline, refs)}

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
- Only create or attach live team context when launch mode or user instruction is force-team, or when the current main session explicitly approves escalation to team.
- Never exceed maxDepth or maxParallelAgents. If deeper delegation is needed, ask the user first.
- Treat all configured gates with enforcement=block as blocking controls, not soft reminders.
- Treat each stage boundary as a review gate.
- Keep decisions, risks, artifacts, and next steps traceable.
- Before asking the user to approve, reject, continue, or review a gate, show the produced artifacts by default using the artifact disclosure protocol below.
- Do not simulate delegation in force-team mode or after an explicit live leader invocation unless the user explicitly approves fallback.
- If runtime handoff fails because a team context is missing, bootstrap a team only in force-team mode; otherwise retry plain live leader handoff without team context and ask before escalating.
- Only use simulated delegation when live startup is unavailable and the user has explicitly approved fallback.
- When delegating to shared agents, include the exact action contract, gate contract, and recursive delegation contract in the delegated brief.
- Execute using-agentflow, gate handling, and stage orchestration after live handoff/team startup, not as a replacement for it.

Live handoff routing protocol:
${handoffRoutingProtocol}

Artifact disclosure protocol:
${artifactDisclosureProtocol}

Team lifecycle rules:
${teamLifecycleRules}

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
artifacts:
- name: <artifact name>
  path: <file path or output path, if any>
  status: <created | updated | unchanged | pending>
  summary: <reviewable summary or excerpt>
decision_needed: approve | reject
reply_route: current live agent runtime id, not role name
\`\`\`
`;
}

export function renderRoleAgent(pipeline, stage, agent) {
  const defaultSkills = pipeline.defaultSkills || [];
  const skills = renderSkillLines(effectiveAgentSkills(pipeline, agent));
  const inheritedSkills = renderSkillLines(defaultSkills);
  const directSkills = renderSkillLines(agent.skills || []);

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

Inherited default skills:
${inheritedSkills}

Agent-specific skills:
${directSkills}

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
  const teamLifecycleRules = renderTeamLifecycleRules("compiled");
  const handoffRoutingProtocol = renderLiveHandoffRoutingProtocol(leaderAgentName);
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
- Bootstrap or attach a team only in force-team mode, or after explicit user approval to escalate from suggest-team.
- In single-leader mode, do not create, attach, or reuse a team; the leader must reply directly to the current main session.
- In suggest-team mode, evaluate whether team is needed, but ask the current main session before creating one.
- If runtime returns a recoverable team-not-found style error outside force-team, treat it as stale/wrong team routing and retry plain leader handoff instead of bootstrapping a team.
- Any action-level gate with enforcement=block is blocking: request the required executor decision, wait, then continue.
- Shared agents are read-only references, so the Team Leader must paste the relevant gate contract into delegated prompts.

## Live Handoff Routing Protocol

${handoffRoutingProtocol}

## Team Lifecycle Rules

${teamLifecycleRules}
`;
}

export function renderUsingAgentFlowSkill(pipeline, refs = buildGlobalAssetRefs(pipeline)) {
  const leaderAgentName = pipeline.leaderAgentName || toLeaderAgentName(pipeline.name);
  const recursiveProtocol = renderRecursiveDelegationProtocol(pipeline);
  const knowledgeInstructions = renderUsingAgentFlowKnowledgeInstructions(pipeline, refs);
  const teamLifecycleRules = renderTeamLifecycleRules("compiled");
  const handoffRoutingProtocol = renderLiveHandoffRoutingProtocol(leaderAgentName);
  const artifactDisclosureProtocol = renderArtifactDisclosureProtocol();
  return `---
name: using-agentflow
description: Use when starting or executing any AgentFlow-managed pipeline. Loads the pipeline SOP, delegation policy, quality gates, knowledge wiki, and role routing rules before work begins.
---

# Using AgentFlow

You are operating inside the AgentFlow pipeline "${pipeline.name}".

Before taking action:

1. Read the pipeline SOP from ${refs.sopPath}.
2. Read the delegation policy from ${refs.delegationPolicyPath}.
3. Read the gate plan from ${refs.gatesPath}. Use ${refs.gatesJsonPath} when you need structured gate data.
4. If Knowledge Wiki is enabled, follow the Knowledge Wiki orientation below before stage work.
5. Identify the current stage and required artifacts.
6. Classify task complexity.
7. Decide execution mode: self / subagent / parallel subagents / agent team / ask human.
8. Use full @agent names when delegating.
9. If a gate applies, emit a GATE_PENDING packet before execution and wait for the required executor decision.
10. Before requesting approve/reject/review/continue, show produced artifacts by default using the artifact disclosure protocol below.
11. Record artifacts, risks, decisions, next steps, and any Knowledge Wiki update proposal.

Knowledge Wiki:

${knowledgeInstructions}

Important:

- Shared agents are read-only references.
- Managed agents may be regenerated by AgentFlow.
- If the user needs a startup anchor, tell them to run /${refs.commandName} from any Claude Code session.
- Claude Code agent teams are experimental and do not support nested teams.
- If the request arrived via an explicit live handle such as ${formatLiveAgentHandle(leaderAgentName)}, preserve the handoff-first behavior and do not downgrade to simulation without explicit approval.
- In single-leader mode, do not create, attach, or reuse a team. Reply through the current main session.
- In suggest-team mode, evaluate whether a team is needed but ask the current main session before creating one.
- In force-team mode, use a fresh run-scoped team whenever possible; do not silently reuse stale teams.
- Gates are blocking controls, not reminders.
- If the user requirement is unclear, ask before delegating.

Live handoff routing:

${handoffRoutingProtocol}

Artifact disclosure:

${artifactDisclosureProtocol}

Team lifecycle:

${teamLifecycleRules}

Recursive delegation:

${recursiveProtocol}
`;
}

function renderUsingAgentFlowKnowledgeInstructions(pipeline, refs = buildGlobalAssetRefs(pipeline)) {
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
    `- Use ${refs.usingAgentFlowWikiSkillPath} for wiki maintenance rules when ingesting, querying, or proposing updates.`,
    `- ${writeModeRule}`,
    "- Valuable stage outputs should become durable wiki pages: requirements, designs, decisions, reviews, entities, concepts, comparisons, and reusable queries.",
  ].join("\n");
}

function renderKnowledgeWikiAssetList(pipeline, refs = buildGlobalAssetRefs(pipeline)) {
  if (!pipeline.knowledgeBase?.enabled) return "";
  const wikiPath = pipeline.knowledgeBase.path || ".agentflow/wiki";
  return [
    `- Knowledge Wiki policy: ${refs.wikiPolicyPath}`,
    `- Knowledge Wiki ingest prompt: ${refs.wikiIngestPromptPath}`,
    `- Knowledge Wiki query prompt: ${refs.wikiQueryPromptPath}`,
    `- Knowledge Wiki schema: ${wikiPath}/SCHEMA.md`,
    `- Knowledge Wiki index: ${wikiPath}/index.md`,
    `- Knowledge Wiki log: ${wikiPath}/log.md`,
    `- Knowledge Wiki skill: ${refs.usingAgentFlowWikiSkillPath}`,
  ].join("\n");
}

function resolveWikiPath(pipeline, projectRoot) {
  return resolveConfiguredPath(pipeline.knowledgeBase?.path || ".agentflow/wiki", {
    fallback: ".agentflow/wiki",
    baseDir: projectRoot,
  });
}

function renderKnowledgeWikiSchema(pipeline) {
  const kb = pipeline.knowledgeBase;
  const stageTags = pipeline.stages.map((stage) => slugifyForTag(stage.name)).filter(Boolean);
  return `# AgentFlow Knowledge Wiki Schema

## Domain
${kb.domain}

This wiki tracks reusable project knowledge created while running the AgentFlow pipeline "${pipeline.name}".

## Conventions

- File names use lowercase kebab-case.
- Every wiki page starts with YAML frontmatter.
- Every page should link to related pages with [[wikilinks]] when possible.
- Every new or updated page must be listed in index.md.
- Every wiki action must append to log.md.
- Raw sources under raw/ are immutable${kb.rawImmutable ? " and must not be edited after capture" : " unless the user explicitly allows changes"}.
- Contradictions must preserve both claims with dates and sources instead of silently overwriting history.
- If an update would touch more than 10 wiki pages, propose the scope before writing.

## Page Types

- requirement: product scope, user stories, acceptance criteria, constraints
- design: architecture plans, API contracts, data flow, implementation sequencing
- decision: ADRs, irreversible choices, rejected options
- review: review findings, verification notes, retrospectives
- entity: systems, modules, services, roles, dependencies
- concept: domain terms, design principles, protocols
- comparison: competing options, framework choices, trade-offs
- query: substantial answers worth preserving

## Frontmatter

\`\`\`yaml
---
title: Page Title
created: YYYY-MM-DD
updated: YYYY-MM-DD
type: requirement | design | decision | review | entity | concept | comparison | query
tags: [from taxonomy below]
sources: [raw/path/source.md]
---
\`\`\`

## Tag Taxonomy

- product: requirement, user-story, acceptance, scope
- architecture: adr, interface, dependency, constraint
- engineering: implementation, testing, refactor, migration
- operations: release, incident, observability, security
- workflow: stage, agent, skill, delegation
${stageTags.length ? `- stages: ${stageTags.join(", ")}` : "- stages: stage"}

## Update Policy

- Create a page when a topic is central to the current task or appears in multiple sources.
- Update an existing page when new information changes, clarifies, or contradicts previous content.
- Keep raw source references in \`sources\`; do not cite chat memory as a source if a durable artifact exists.
- Keep pages scannable. Split pages that exceed roughly 200 lines.
- Use queries/ for durable syntheses that would be expensive to re-derive later.
`;
}

function renderKnowledgeWikiIndex(pipeline) {
  return `# Knowledge Wiki Index

> Content catalog for "${pipeline.name}". Every durable wiki page should be listed here with a one-line summary.
> Last updated: YYYY-MM-DD | Total pages: 0

## Requirements

## Designs

## Decisions

## Reviews

## Entities

## Concepts

## Comparisons

## Queries
`;
}

function renderKnowledgeWikiLog(pipeline) {
  return `# Knowledge Wiki Log

> Append-only record for "${pipeline.name}" knowledge actions.
> Format: \`## [YYYY-MM-DD] action | subject\`
> Actions: init, ingest, update, query, propose, archive, lint

## [YYYY-MM-DD] init | Knowledge Wiki initialized

- Pipeline: ${pipeline.name}
- Domain: ${pipeline.knowledgeBase.domain}
- Write mode: ${pipeline.knowledgeBase.writeMode}
`;
}

function renderKnowledgeWikiPolicy(pipeline) {
  return `# ${pipeline.name} Knowledge Wiki Policy

- Enabled: ${pipeline.knowledgeBase.enabled ? "yes" : "no"}
- Path: ${pipeline.knowledgeBase.path}
- Domain: ${pipeline.knowledgeBase.domain}
- Auto orient: ${pipeline.knowledgeBase.autoOrient ? "yes" : "no"}
- Write mode: ${pipeline.knowledgeBase.writeMode}
- Raw immutable: ${pipeline.knowledgeBase.rawImmutable ? "yes" : "no"}

## Operating Model

The Knowledge Wiki is the durable project memory for this AgentFlow pipeline. It should capture useful requirements, designs, decisions, reviews, entities, concepts, comparisons, and reusable query answers.

## Write Mode

${renderKnowledgeWriteModePolicy(pipeline.knowledgeBase.writeMode)}

## Stage Output Mapping

${renderKnowledgeStageMapping(pipeline)}
`;
}

function renderKnowledgeWikiIngestPrompt(pipeline) {
  return `# Knowledge Wiki Ingest Prompt

Use this prompt when a stage artifact or external source should be folded into the AgentFlow Knowledge Wiki.

1. Read ${pipeline.knowledgeBase.path}/SCHEMA.md.
2. Read ${pipeline.knowledgeBase.path}/index.md.
3. Read recent entries in ${pipeline.knowledgeBase.path}/log.md.
4. Capture any new raw source under the appropriate raw/ directory.
5. Search existing wiki pages before creating new pages.
6. Create or update requirement, design, decision, review, entity, concept, comparison, or query pages.
7. Use YAML frontmatter and [[wikilinks]].
8. Update index.md and append log.md.
9. Report touched files and any contradictions or follow-up questions.

Write mode: ${pipeline.knowledgeBase.writeMode}
${renderKnowledgeWriteModePolicy(pipeline.knowledgeBase.writeMode)}
`;
}

function renderKnowledgeWikiQueryPrompt(pipeline) {
  return `# Knowledge Wiki Query Prompt

Use this prompt when answering questions from the durable Knowledge Wiki.

1. Read ${pipeline.knowledgeBase.path}/SCHEMA.md.
2. Read ${pipeline.knowledgeBase.path}/index.md.
3. Search the wiki for relevant terms if the index is insufficient.
4. Read the relevant pages before answering.
5. Cite wiki pages by path or [[wikilink]].
6. If the answer is a substantial synthesis, propose filing it under queries/ or comparisons/.

Do not modify wiki files when writeMode is readonly.
`;
}

function renderUsingAgentFlowWikiSkill(pipeline) {
  return `---
name: using-agentflow-wiki
description: Maintain the AgentFlow Knowledge Wiki for project memory, source-backed decisions, and reusable stage context.
---

# Using AgentFlow Wiki

You are maintaining the Knowledge Wiki for the AgentFlow pipeline "${pipeline.name}".

Wiki path: ${pipeline.knowledgeBase.path}
Domain: ${pipeline.knowledgeBase.domain}
Write mode: ${pipeline.knowledgeBase.writeMode}

## Orientation

Before ingesting, querying, or updating the wiki:

1. Read ${pipeline.knowledgeBase.path}/SCHEMA.md.
2. Read ${pipeline.knowledgeBase.path}/index.md.
3. Read recent entries in ${pipeline.knowledgeBase.path}/log.md.

## Ingest

- Preserve raw sources under raw/.
- Search existing pages before creating new ones.
- Update pages only when the information is durable and useful for future runs.
- Use frontmatter, tags from SCHEMA.md, and [[wikilinks]].
- Update index.md and log.md whenever you write wiki pages.
- If more than 10 pages would change, propose the update scope first.

## Query

- Answer from the compiled wiki first, then inspect raw sources if needed.
- Cite the wiki pages used.
- Propose filing valuable syntheses under queries/ or comparisons/.

## Write Mode

${renderKnowledgeWriteModePolicy(pipeline.knowledgeBase.writeMode)}

## Stage Mapping

${renderKnowledgeStageMapping(pipeline)}
`;
}

function renderKnowledgeWriteModePolicy(writeMode) {
  if (writeMode === "readonly") {
    return "Readonly: use the wiki for context only. Do not write files unless the user explicitly overrides readonly mode.";
  }
  if (writeMode === "auto_write") {
    return "Auto write: update the wiki during execution when the value is clear, then report touched files and evidence.";
  }
  return "Proposal first: propose wiki updates at useful boundaries and wait for explicit user approval before writing.";
}

function renderKnowledgeStageMapping(pipeline) {
  return pipeline.stages.length
    ? pipeline.stages
        .map((stage) => {
          const outputs = [...new Set(stage.actions.flatMap((action) => action.outputs || []))];
          return `- ${stage.name}: ${outputs.join(", ") || "stage artifacts"}`;
        })
        .join("\n")
    : "- No stages configured.";
}

function slugifyForTag(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "") || "";
}

function renderLaunchPrompt(pipeline, requirement, launchMode, resolvedProjectPath, runId = "", refs = buildGlobalAssetRefs(pipeline)) {
  const leaderAgentName = pipeline.leaderAgentName || toLeaderAgentName(pipeline.name);
  const agents = pipeline.stages
    .flatMap((stage) => stage.agents.map((agent) => `- @${agent.agentName} (${agent.name})：${agent.responsibility || agent.description}`))
    .join("\n") || "- 暂无配置 Agent";
  const liveHandle = formatLiveAgentHandle(leaderAgentName);
  const modeInstruction = buildModeInstruction(launchMode, pipeline);
  const teamLifecycleRules = renderTeamLifecycleRules(launchMode, pipeline, runId, resolvedProjectPath);
  const handoffRoutingProtocol = renderLiveHandoffRoutingProtocol(leaderAgentName);
  const artifactDisclosureProtocol = renderArtifactDisclosureProtocol();

  return `${liveHandle} ${buildInvocationDirective(launchMode)}

用户需求：
${requirement || "用户尚未填写需求，请先询问用户要实现什么。"}

Main session handoff rules:
1. 上面的 ${liveHandle} 是本轮最高优先级动作，必须先执行 live agent handoff。
2. 在 handoff 尝试之前，主会话不得做仓库分析、workflow 执行、gate 处理、计划拆解或 delegation simulation。
3. 如果本轮不是 force-team，禁止创建、attach 或复用任何 Claude Code team，禁止走旧 team inbox；Leader 必须直接回复当前主会话。
4. 只有 force-team 模式才允许 bootstrap live team；如果 team context 缺失，只能在 force-team 下创建当前 run 专属 team 后重试。
5. 如果 single-leader/suggest-team 模式出现 team-not-found、leadSessionId、cwd 或 inbox 相关错误，把它视为旧 team 路由污染，退回普通 live leader handoff，不要自动 spawnTeam。
6. 如果本轮是 force-team，严禁用主会话模拟 delegation 替代 live team；只有用户明确同意 fallback 才能降级。
7. using-agentflow、阶段判断、gate、team orchestration 必须由 handoff 成功后的 leader agent 执行，而不是由主会话预先执行。
8. handoff 成功后，必须记录 runtime 返回的精确 agentId/taskId/output path；后续 gate approve/reject、状态追问、继续执行都必须发给这个精确 agentId/taskId，不要再用 ${liveHandle} 或 agent 名称路由。
9. 如果 runtime 提示该 agent 没有 active task 或已 completed/stopped，必须用同一个 agentId/taskId 从 transcript 恢复后再发送用户的 gate 回复；不要假装已经转交。
10. 只有 agentId/taskId 路由返回 accepted/resumed/completed 等明确结果后，才能告诉用户“已转交”。
11. 你的第一段非空输出必须是实际的 handoff 动作或 handoff 尝试结果，不要先输出分析说明。

Invoked leader context:
- AgentFlow pipeline: ${pipeline.name}
- Live leader handle: ${liveHandle}
- Startup command: /${refs.commandName}

工作目录：
${resolvedProjectPath}

AgentFlow global assets:
- Install root: ${refs.agentflowDir}
- Compiled dir: ${refs.compiledDir}
- SOP: ${refs.sopPath}
- Delegation policy: ${refs.delegationPolicyPath}
- Gates: ${refs.gatesPath}
- Gate JSON: ${refs.gatesJsonPath}
- Bootstrap skill: ${refs.usingAgentFlowSkillPath}

启动模式：
${launchMode}

Live handoff routing:
${handoffRoutingProtocol}

Artifact disclosure:
${artifactDisclosureProtocol}

Team lifecycle:
${teamLifecycleRules}

${modeInstruction}

可用角色：
${agents}

Leader execution requirements after handoff:
1. 先加载并遵守 using-agentflow 规则。
2. 如果 Knowledge Wiki 已启用，先读取 wiki schema/index/log 进行项目知识定位。
3. 先判断任务复杂度，再选择 self / subagent / parallel subagents / agent team。
4. 委托时必须使用完整 @agent 名称。
5. 门禁是阻断式控制，命中 block 级别门禁后必须先发起 GATE_PENDING，并按门禁放行方式等待批准、审查或检查结果。
6. 在请求用户 approve/reject/review/continue 之前，默认展示本阶段产出物；不要只说“已进入门禁”。
7. 输出阶段状态、产物、风险、下一步，以及 Knowledge Wiki 更新建议。

Knowledge Wiki:
${renderUsingAgentFlowKnowledgeInstructions(pipeline, refs)}

递归委托协议：
${renderRecursiveDelegationBrief(pipeline)}

关键门禁矩阵：
${renderGateMatrix(pipeline)}

结构化流水线摘要：

${renderRunSummary(pipeline, resolvedProjectPath)}
`;
}

function renderAgentFlowSlashCommand(pipeline, refs = buildGlobalAssetRefs(pipeline)) {
  const prompt = renderLaunchPrompt(pipeline, "$ARGUMENTS", "single-leader", "current Claude Code working directory", "", refs);
  return `---
description: Start the ${pipeline.name} AgentFlow pipeline through its global Team Leader.
argument-hint: [requirement]
---

${prompt}
`;
}

function renderActiveBootstrap(pipeline, refs = buildGlobalAssetRefs(pipeline)) {
  return `# Active AgentFlow Pipeline

Pipeline: ${pipeline.name}
Pipeline ID: ${pipeline.id}
Leader: @${pipeline.leaderAgentName || toLeaderAgentName(pipeline.name)}
Manual command: /${refs.commandName}

AgentFlow is installed globally. Treat the current Claude Code working directory as the project being worked on; do not assume AgentFlow assets live inside the project.

Read these global assets before executing non-trivial coding, planning, review, or documentation tasks:

1. ${refs.sopPath}
2. ${refs.delegationPolicyPath}
3. ${refs.gatesPath}
4. ${refs.gatesJsonPath}
5. ${refs.usingAgentFlowSkillPath}

Operating rules:

- Start by applying the active AgentFlow workflow unless the user explicitly asks to bypass AgentFlow.
- Restate the user requirement, identify the current stage, and choose self / subagent / parallel subagents / agent team according to the delegation policy.
- Use the configured Leader when task complexity crosses the delegation threshold.
- Apply blocking gates before writing, reviewing, releasing, or performing destructive actions.
- Shared agents are global references; do not rewrite shared agent files.
- Do not write AgentFlow configuration into the current project unless the user explicitly asks.
`;
}

function renderClaudeGlobalMemoryBlock(refs = buildGlobalAssetRefs({ id: "pipeline", name: "pipeline" })) {
  return `# AgentFlow Global Bootstrap

Before starting any non-trivial coding, planning, review, or documentation task:

1. Check whether AgentFlow is installed by reading:
   ${refs.activeBootstrapPath}

2. If that file exists, follow it as the active global workflow policy.

3. Treat the current Claude Code working directory as the project being worked on. Do not assume AgentFlow assets live inside the project.

4. AgentFlow assets are user-global, normally under:
   ${refs.activeDir}
   ${refs.agentflowDir}/compiled

5. If AgentFlow is not installed, continue normally.

Do not copy AgentFlow rules into project files unless the user explicitly asks.`;
}

function buildModeInstruction(launchMode, pipeline) {
  const teamName = recommendedTeamName(pipeline);
  if (launchMode === "force-team") {
    return `请以 force-team 模式执行本需求。

要求：
- 第一动作是完成 ${formatLiveAgentHandle(pipeline.leaderAgentName || toLeaderAgentName(pipeline.name))} 的 live handoff，而不是主会话分析。
- 如果 team context 不存在，创建当前 run 专属 team，再重试同一个 live invocation。
- 推荐 team name 前缀：${teamName}。
- 不要复用 leadSessionId/cwd 不匹配的旧 team；如果无法验证当前 session 绑定关系，直接新建 run-scoped team。
- 由你作为 team lead 维护任务列表。
- 团队成员应优先从当前流水线 Agent 中选择。
- 每个 teammate 必须拥有清晰写入边界。
- 高风险变更必须先计划，得到 lead 批准后再实施。
- 完成后综合所有 teammate 结论。
- 未经用户明确批准，不得退化为主会话模拟 delegation。`;
  }

  if (launchMode === "suggest-team") {
    return `请在 live handoff 成功后评估是否需要创建 Claude Code agent team。

当前阶段不要自动创建、attach 或复用 team。
如果任务跨产品、架构、研发、测试，或需要多角色讨论，请先说明理由并向当前主会话申请升级 team；用户批准后再创建 run-scoped team。
如果任务可单点完成，则保持 single leader 或 subagent 模式。
如果 runtime 因 team context 缺失导致 handoff 失败，请退回普通 live leader handoff，不要自动初始化 team context。`;
  }

  return `请默认以 single leader 模式开始，但仍然必须先完成 live handoff。

不要创建、attach 或复用任何 Claude Code team。
不要使用 team inbox、team-lead.json 或旧 team context。
只有当任务明确需要隔离探索、专项审查或跨角色协作时，才创建普通 subagent 或建议升级到 agent team；升级 team 前必须获得当前主会话批准。`;
}

function buildInvocationDirective(launchMode) {
  if (launchMode === "force-team") {
    return "请以 force-team 模式接管以下任务，并创建当前 run 专属 live team。";
  }

  if (launchMode === "suggest-team") {
    return "请先以普通 live leader 接管以下任务，并在 handoff 后评估是否需要申请 live team。";
  }

  return "请以 single-leader 模式先接管以下任务。";
}

function renderTeamLifecycleRules(launchMode, pipeline = {}, runId = "", resolvedProjectPath = "") {
  const teamName = recommendedTeamName(pipeline, runId);
  const projectLine = resolvedProjectPath ? `- Current working directory: ${resolvedProjectPath}` : "";

  if (launchMode === "force-team") {
    return [
      "- Mode: force-team. A live team is allowed and expected.",
      `- Use a run-scoped team name whenever possible: ${teamName}.`,
      projectLine,
      "- Do not silently reuse an existing long-lived team if its leadSessionId, lead cwd, working directory, or inbox subscription may belong to an old session.",
      "- Before reusing a team, verify that the lead session is the current main session and that cwd matches the current working directory.",
      "- If verification is impossible or mismatched, create a fresh run-scoped team instead of attaching stale team context.",
      "- The live leader must ensure replies are visible in the current main session, not only written to team-lead inbox.",
      "- If a teammate reply lands in team-lead inbox but is not visible in the current chat, treat the team context as stale and report/recreate the team.",
      "- Gate replies must still be routed through the current live leader runtime id, even when a team exists.",
    ].filter(Boolean).join("\n");
  }

  if (launchMode === "suggest-team") {
    return [
      "- Mode: suggest-team. Start as plain live leader handoff, not as team.",
      "- Do not create, attach, or reuse any Claude Code team before the current main session explicitly approves escalation.",
      "- Do not use team inbox, team-lead.json, or old team context during the initial handoff.",
      "- Evaluate whether team is needed after handoff; if needed, explain why and ask the current main session for approval.",
      `- If approved, create a fresh run-scoped team such as: ${teamName}.`,
      "- If runtime surfaces team-not-found, leadSessionId, cwd, or inbox errors before approval, treat that as stale team routing and retry plain live leader handoff.",
      "- Gate replies must be sent to the captured live leader runtime id, not the role handle.",
    ].join("\n");
  }

  if (launchMode === "single-leader") {
    return [
      "- Mode: single-leader. This is plain live agent handoff only.",
      "- Do not create, attach, or reuse any Claude Code team.",
      "- Do not use team inbox, team-lead.json, or old team context.",
      "- The invoked leader must reply directly in the current main session.",
      "- If runtime surfaces team-not-found, leadSessionId, cwd, or inbox errors, treat that as stale team routing and retry plain live leader handoff.",
      "- Gate replies must be sent to the captured live leader runtime id, not the role handle.",
    ].join("\n");
  }

  return [
    "- Default lifecycle: plain live leader handoff is not the same as team mode.",
    "- Create or attach a live team only for force-team or after explicit current-session approval.",
    "- Prefer fresh run-scoped teams over long-lived reusable teams.",
    "- Never silently reuse a team whose leadSessionId, cwd, or inbox subscription may point at an old session.",
    "- In single-leader/suggest-team startup, the leader must reply directly to the current main session, not only to team-lead inbox.",
    "- After handoff, route gate replies by runtime agentId/taskId instead of role name.",
  ].join("\n");
}

function recommendedTeamName(pipeline = {}, runId = "") {
  const pipelineId = safeAsciiSlug(pipeline.id || pipeline.name || "pipeline");
  const runPart = runId ? safeAsciiSlug(runId) : "<runId>";
  return `agentflow-${pipelineId}-${runPart}`;
}

function safeAsciiSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "pipeline";
}

function formatLiveAgentHandle(agentName) {
  return `@"${agentName} (agent)"`;
}

function renderLiveHandoffRoutingProtocol(leaderAgentName) {
  const liveHandle = formatLiveAgentHandle(leaderAgentName);
  return [
    `- Use ${liveHandle} only for the first live handoff invocation.`,
    "- Immediately after handoff, capture and retain the runtime agentId/taskId/output path returned by the agent runtime.",
    "- Treat that runtime id as the reply route for this run. Store it with the pending gate state.",
    "- For every later user response such as approve, reject, continue, status, or a gate answer, send the message to the exact runtime agentId/taskId, not to the role name or live handle.",
    "- If the runtime says the agent has no active task, was stopped, or completed, resume the same runtime agentId/taskId from transcript and then deliver the user's exact gate response.",
    "- When a resumed or completed runtime returns a gate, stage result, or output path, summarize the reviewable artifacts before asking the user for the next decision.",
    "- Do not tell the user that a gate approval was delivered until the runtime confirms the exact runtime id accepted/resumed the message.",
    "- When a GATE_PENDING packet is shown to the user, include the gate id, requested decision, current runtime id if the main session has it, and the artifact list or artifact output path.",
    "- If routing by role name and routing by runtime id disagree, trust the runtime id.",
  ].join("\n");
}

function renderArtifactDisclosureProtocol() {
  return [
    "- Default behavior: show artifacts before asking for approve, reject, review, or continue.",
    "- If artifacts are files, include each path, changed/created/unchanged status when known, and a short reviewable summary or excerpt.",
    "- If artifacts are only in the live runtime output, include the output path and summarize the concrete sections that the user must review.",
    "- If an expected artifact is missing, say it is missing or pending and explain whether the gate can still be reviewed.",
    "- Do not replace artifact disclosure with a generic status such as 'leader entered architecture-review'; that status may appear only after the artifacts are visible.",
    "- Keep the decision prompt last so the user sees the evidence before the requested reply format.",
  ].join("\n");
}

function effectiveAgentSkills(pipeline, agent) {
  const seen = new Set();
  return [...(pipeline.defaultSkills || []), ...(agent.skills || [])].filter((skill) => {
    const key = skill.path || skill.name;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function renderSkillLines(skills = []) {
  return skills.length
    ? skills.map((skill) => `- ${skill.name}@${skill.version}${skill.path ? ` (${skill.path})` : ""}`).join("\n")
    : "- none";
}

function renderSkillSummary(skills = []) {
  return skills.length
    ? skills.map((skill) => `${skill.name}@${skill.version}${skill.path ? `:${skill.path}` : ""}`).join(", ")
    : "none";
}

function renderRunSummary(pipeline, resolvedProjectPath = "current Claude Code working directory") {
  const defaultSkills = renderSkillSummary(pipeline.defaultSkills || []);
  const stages = pipeline.stages
    .map((stage, index) => {
      const agents = stage.agents.length
        ? stage.agents
            .map((agent) => `    - @${agent.agentName}：${agent.produce.join(", ")} | skills: ${renderSkillSummary(effectiveAgentSkills(pipeline, agent))}`)
            .join("\n")
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
    `Working directory: ${resolvedProjectPath}`,
    `Default skills: ${defaultSkills}`,
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
  const artifactDisclosureProtocol = renderArtifactDisclosureProtocol();
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
gate_name: <gate-name>
stage: <stage-name>
action: <action-name>
owner: @<agent-name>
evidence:
- <artifact or decision>
- <risk / assumption / validation result>
artifacts:
- name: <artifact name>
  path: <file path or runtime output path, if any>
  status: <created | updated | unchanged | pending>
  summary: <reviewable summary or excerpt>
decision_needed: approve | review | revise | reject
reply_route: current live agent runtime id, not role name
\`\`\`

## Artifact Disclosure

${artifactDisclosureProtocol}

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
    "Before requesting a gate decision from the user, disclose the produced artifacts by default: paths when available, status, and a reviewable summary or excerpt.",
    "If no artifact exists yet, explicitly mark the expected artifact as missing or pending instead of asking for approval on an empty status update.",
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

function buildLaunchCommand(pipeline, prompt, leaderAgentName, runId, resolvedProjectPath, promptFilePath = "") {
  const promptArg = promptFilePath ? `"$(cat ${shellQuote(promptFilePath)})"` : shellQuote(prompt);
  return [
    "clear",
    `printf '%s\\n' ${shellQuote("AgentFlow 一键启动")}`,
    runId ? `printf '%s\\n' ${shellQuote(`Run ID: ${runId}`)}` : "",
    `printf '%s\\n' ${shellQuote(`Working directory: ${resolvedProjectPath}`)}`,
    `printf '%s\\n' ${shellQuote(`Leader: ${formatLiveAgentHandle(leaderAgentName)}`)}`,
    promptFilePath ? `printf '%s\\n' ${shellQuote(`Prompt file: ${promptFilePath}`)}` : "",
    `claude ${promptArg}`,
  ].filter(Boolean).join("; ");
}

function buildManifest(definition, refs = buildGlobalAssetRefs(definition.pipeline)) {
  const pipeline = definition.pipeline;
  const knowledgeAssets = pipeline.knowledgeBase?.enabled
    ? [
        `${pipeline.knowledgeBase.path}/SCHEMA.md`,
        `${pipeline.knowledgeBase.path}/index.md`,
        `${pipeline.knowledgeBase.path}/log.md`,
        refs.wikiPolicyPath,
        refs.wikiIngestPromptPath,
        refs.wikiQueryPromptPath,
        refs.usingAgentFlowWikiSkillPath,
      ]
    : [];
  return {
    version: 1,
    schemaVersion: definition.version,
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    leaderAgentName: pipeline.leaderAgentName,
    knowledgeBase: pipeline.knowledgeBase,
    launchModes: ["single-leader", "suggest-team", "force-team"],
    startupCommand: `/${refs.commandName}`,
    assets: [
      refs.snapshotPath,
      refs.leaderPath,
      refs.sopPath,
      refs.delegationPolicyPath,
      refs.gatesPath,
      refs.gatesJsonPath,
      refs.launchPromptPath,
      refs.usingAgentFlowSkillPath,
      refs.commandPath,
      ...knowledgeAssets,
    ],
  };
}

function buildActiveManifest(definition, refs = buildGlobalAssetRefs(definition.pipeline)) {
  const pipeline = definition.pipeline;
  return {
    version: 1,
    activePipelineId: pipeline.id,
    activePipelineName: pipeline.name,
    leaderAgentName: pipeline.leaderAgentName,
    startupCommand: `/${refs.commandName}`,
    bootstrapPath: refs.activeBootstrapPath,
    compiledDir: refs.compiledDir,
    definitionPath: refs.definitionPath,
    pipelineDefinitionPath: refs.pipelineDefinitionPath,
    assets: {
      sop: refs.sopPath,
      delegationPolicy: refs.delegationPolicyPath,
      gates: refs.gatesPath,
      gatesJson: refs.gatesJsonPath,
      usingAgentFlowSkill: refs.usingAgentFlowSkillPath,
      leaderAgent: path.join(refs.claudeDir, "agents", `${pipeline.leaderAgentName}.md`),
      slashCommand: refs.commandPath,
    },
  };
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
