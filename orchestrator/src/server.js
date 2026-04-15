import express from "express";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const PORT = Number(process.env.PORT || 8787);
const TMUX_BIN = process.env.TMUX_BIN || findTmuxBinary();
const PROJECT_ROOT = path.resolve(process.cwd(), "..");
const DEFINITION_PATH = path.join(PROJECT_ROOT, "configs", "agentflow.pipeline.json");
const CLAUDE_AGENTS_DIR = "/Users/leo/.claude/agents";
const DEFAULT_DELEGATION_POLICY = {
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
const runs = new Map();

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, tmux: checkTmux().ok });
});

app.get("/api/agents", (req, res) => {
  res.json({ agents: listClaudeAgents() });
});

app.post("/api/preflight", (req, res) => {
  const pipeline = normalizePipeline(req.body?.pipeline);
  if (!pipeline) {
    res.status(400).json({ error: "pipeline is required" });
    return;
  }

  const checks = buildPreflightChecks(pipeline);
  res.json({
    ok: !checks.some((check) => check.status === "fail"),
    checks,
  });
});

app.get("/api/definition", (req, res) => {
  const definition = readDefinition();
  if (!definition) {
    res.status(404).json({ error: "definition not found" });
    return;
  }
  res.json(definition);
});

app.post("/api/definition/preview", (req, res) => {
  const pipeline = normalizePipeline(req.body?.pipeline);
  if (!pipeline) {
    res.status(400).json({ error: "pipeline is required" });
    return;
  }

  res.json(buildDefinitionPreview(pipeline));
});

app.post("/api/definition", (req, res) => {
  const definition = normalizeDefinitionRequest(req.body);
  if (!definition.pipeline) {
    res.status(400).json({ error: "pipeline is required" });
    return;
  }

  fs.mkdirSync(path.dirname(DEFINITION_PATH), { recursive: true });
  fs.writeFileSync(DEFINITION_PATH, `${JSON.stringify(definition, null, 2)}\n`);
  const generatedAgents = writeClaudeAgents(definition);
  res.json({ definition, generatedAgents });
});

app.post("/api/runs", (req, res) => {
  const pipeline = normalizePipeline(req.body?.pipeline);
  if (!pipeline) {
    res.status(400).json({ error: "pipeline is required" });
    return;
  }

  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const projectPath = pipeline.projectPath;
  const requirement = String(req.body?.requirement || "");

  if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
    res.status(400).json({ error: "invalid projectPath", detail: projectPath });
    return;
  }

  runs.set(runId, {
    runId,
    pipeline,
    requirement,
    status: "created",
    createdAt: new Date().toISOString(),
  });

  res.status(201).json({ runId, status: "created", pipeline, requirement });
});

app.get("/api/runs/:runId", (req, res) => {
  const run = runs.get(req.params.runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  res.json(run);
});

app.post("/api/runs/:runId/stop", (req, res) => {
  const run = runs.get(req.params.runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  run.status = "stopped";
  run.stoppedAt = new Date().toISOString();
  res.json(run);
});

app.post("/api/runs/:runId/open-iterm", (req, res) => {
  const run = runs.get(req.params.runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  const requirement = String(req.body?.requirement ?? run.requirement ?? "");
  run.requirement = requirement;

  const script = buildITermAppleScript(run, requirement);
  run.status = "opening";
  run.openingAt = new Date().toISOString();

  runAppleScript(script, 5000)
    .then(() => {
      run.status = "opened";
      run.openedAt = new Date().toISOString();
      res.json(run);
    })
    .catch((error) => {
      run.status = "open_failed";
      run.openError = error.message;
      res.status(500).json({ error: "failed to open iTerm2", detail: error.message, run });
    });
});

const server = http.createServer(app);

server.listen(PORT, () => {
  console.log(`AgentFlow orchestrator listening on http://localhost:${PORT}`);
});

function checkTmux() {
  if (!TMUX_BIN) return { ok: false, error: "tmux not found" };
  const result = spawnSync(TMUX_BIN, ["-V"], { encoding: "utf8" });
  if (result.status === 0) {
    return { ok: true, version: result.stdout.trim() };
  }
  return { ok: false, error: result.stderr || result.error?.message || "tmux not found" };
}

function buildPreflightChecks(pipeline) {
  const leaderAgentName = pipeline.leaderAgentName || toLeaderAgentName(pipeline.name);
  const leaderPath = getAgentPath(leaderAgentName);
  const sharedAgents = pipeline.stages.flatMap((stage) =>
    stage.agents.filter((agent) => agent.source === "shared").map((agent) => agent.agentName)
  );
  const missingSharedAgents = sharedAgents.filter((agentName) => !fs.existsSync(getAgentPath(agentName)));
  const claudeBinary = findExecutable("claude", [
    "/Users/leo/.local/bin/claude",
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ]);
  const iTermAvailable = checkITerm().ok;
  const projectPathExists = fs.existsSync(pipeline.projectPath) && fs.statSync(pipeline.projectPath).isDirectory();
  const agentsDirExists = fs.existsSync(CLAUDE_AGENTS_DIR);

  return [
    {
      id: "project-path",
      label: "项目地址",
      status: projectPathExists ? "pass" : "fail",
      detail: projectPathExists ? pipeline.projectPath : `项目目录不存在：${pipeline.projectPath}`,
    },
    {
      id: "claude-cli",
      label: "Claude CLI",
      status: claudeBinary ? "pass" : "fail",
      detail: claudeBinary || "未找到 claude 命令，请确认 Claude CLI 已安装并在 PATH 中",
    },
    {
      id: "iterm2",
      label: "iTerm2",
      status: iTermAvailable ? "pass" : "fail",
      detail: iTermAvailable ? "iTerm2 可通过 AppleScript 调用" : "未找到 iTerm2 或 AppleScript 无法访问",
    },
    {
      id: "agents-dir",
      label: "Claude agents 目录",
      status: agentsDirExists && canWriteDirectory(CLAUDE_AGENTS_DIR) ? "pass" : "fail",
      detail: agentsDirExists ? CLAUDE_AGENTS_DIR : `目录不存在：${CLAUDE_AGENTS_DIR}`,
    },
    {
      id: "leader-agent",
      label: "Team Leader Agent",
      status: fs.existsSync(leaderPath) ? "pass" : "warn",
      detail: fs.existsSync(leaderPath)
        ? leaderPath
        : `同步 Agents 后会创建：${leaderPath}`,
    },
    {
      id: "shared-agents",
      label: "共享 Agent 引用",
      status: missingSharedAgents.length ? "fail" : "pass",
      detail: missingSharedAgents.length
        ? `缺失共享 Agent：${missingSharedAgents.join(", ")}`
        : sharedAgents.length
          ? `已找到 ${sharedAgents.length} 个共享 Agent`
          : "当前流水线未引用共享 Agent",
    },
  ];
}

function buildDefinitionPreview(pipeline) {
  const leaderAgentName = pipeline.leaderAgentName || toLeaderAgentName(pipeline.name);
  const leaderPath = getAgentPath(leaderAgentName);
  const nextMarkdown = renderTeamLeaderAgent(pipeline);
  const currentMarkdown = fs.existsSync(leaderPath) ? fs.readFileSync(leaderPath, "utf8") : "";
  return {
    leaderAgentName,
    leaderPath,
    nextMarkdown,
    currentMarkdown,
    changed: nextMarkdown !== currentMarkdown,
  };
}

function normalizePipeline(value) {
  if (!value || typeof value !== "object" || !value.name) return null;
  return {
    id: String(value.id || ""),
    name: String(value.name),
    leaderAgentName: String(value.leaderAgentName || toLeaderAgentName(value.name)),
    projectPath: String(value.projectPath || process.cwd()),
    delegationPolicy: normalizeDelegationPolicy(value.delegationPolicy),
    stages: Array.isArray(value.stages)
      ? value.stages.map((stage) => ({
          id: String(stage.id || ""),
          name: String(stage.name || "未命名阶段"),
          agents: Array.isArray(stage.agents)
            ? stage.agents.map((agent) => ({
                id: String(agent.id || ""),
                name: String(agent.name || "未命名 Agent"),
                agentName: String(agent.agentName || toAgentName(agent.name || "agent")),
                description: String(agent.description || `${agent.name || "Agent"} for AgentFlow pipeline.`),
                responsibility: String(agent.responsibility || ""),
                source: agent.source === "shared" ? "shared" : "managed",
                model: String(agent.model || "sonnet"),
                tools: Array.isArray(agent.tools) ? agent.tools.map(String) : ["Read", "Write", "Edit", "Grep", "Glob"],
                skills: Array.isArray(agent.skills)
                  ? agent.skills.map((skill) => ({
                      id: String(skill.id || ""),
                      name: String(skill.name || "unnamed_skill"),
                      version: String(skill.version || "latest"),
                    }))
                  : [],
              }))
            : [],
        }))
      : [],
  };
}

function normalizeDefinitionRequest(value = {}) {
  const existingDefinition = readDefinition() || { version: 2, pipelines: [], selectedPipelineId: "" };
  const existingPipelines = Array.isArray(existingDefinition.pipelines)
    ? existingDefinition.pipelines
    : existingDefinition.pipeline
      ? [existingDefinition.pipeline]
      : [];
  const requestPipelines = Array.isArray(value.pipelines)
    ? value.pipelines
    : existingPipelines;
  const normalizedPipelines = requestPipelines.map(normalizePipeline).filter(Boolean);
  const selectedPipeline = normalizePipeline(value.pipeline);

  if (selectedPipeline) {
    const index = normalizedPipelines.findIndex((pipeline) => pipeline.id === selectedPipeline.id);
    if (index >= 0) {
      normalizedPipelines[index] = selectedPipeline;
    } else {
      normalizedPipelines.push(selectedPipeline);
    }
  }

  const selectedPipelineId = String(value.selectedPipelineId || selectedPipeline?.id || normalizedPipelines[0]?.id || "");
  const currentPipeline =
    normalizedPipelines.find((pipeline) => pipeline.id === selectedPipelineId) || normalizedPipelines[0] || null;

  return {
    version: 2,
    selectedPipelineId: currentPipeline?.id || "",
    pipelines: normalizedPipelines,
    pipeline: currentPipeline,
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function findTmuxBinary() {
  const pathCandidates = (process.env.PATH || "")
    .split(":")
    .filter(Boolean)
    .map((entry) => `${entry}/tmux`);
  const candidates = [
    ...pathCandidates,
    "/opt/homebrew/bin/tmux",
    "/usr/local/bin/tmux",
    "/usr/bin/tmux",
  ].filter(Boolean);

  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["-V"], { encoding: "utf8" });
    if (result.status === 0) return candidate;
  }

  return "";
}

function findExecutable(name, extraCandidates = []) {
  const pathCandidates = (process.env.PATH || "")
    .split(":")
    .filter(Boolean)
    .map((entry) => `${entry}/${name}`);
  const candidates = [...pathCandidates, ...extraCandidates];

  for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (result.status === 0) return candidate;
  }

  return "";
}

function checkITerm() {
  const result = spawnSync("osascript", ["-e", 'id of application "iTerm2"'], { encoding: "utf8" });
  return {
    ok: result.status === 0,
    detail: result.stdout.trim() || result.stderr.trim(),
  };
}

function runAppleScript(script, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`iTerm2 启动超时（${timeoutMs}ms），请检查 macOS 自动化授权或 iTerm2 状态`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr || stdout || `osascript exited with code ${code}`));
    });
  });
}

function canWriteDirectory(directory) {
  try {
    fs.accessSync(directory, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function buildITermAppleScript(run, requirement) {
  const command = buildClaudeCommand(run, requirement);
  return `
tell application "iTerm2"
  activate
  set newWindow to (create window with default profile)
  try
    tell newWindow to set fullscreen to true
  end try
  tell current session of newWindow
    write text ${appleScriptString(command)}
  end tell
end tell
`;
}

function buildClaudeCommand(run, requirement) {
  const summary = buildRunSummary(run, requirement);
  const leaderAgentName = run.pipeline.leaderAgentName || toLeaderAgentName(run.pipeline.name);
  const claudeCommand = `claude --agent ${leaderAgentName}`;
  const prompt = [
    `你是 AgentFlow 流水线「${run.pipeline.name}」的 Team Leader。`,
    "请基于下面的流水线配置和用户需求执行研发流程。",
    "先分析需求，再按阶段推进，并在每个阶段输出需要人工确认的检查点。",
    "",
    summary,
  ].join("\n");

  return [
    `cd ${shellQuote(run.pipeline.projectPath)}`,
    `clear`,
    `printf '%s\\n' ${shellQuote("AgentFlow 一键启动")}`,
    `printf '%s\\n' ${shellQuote(`Run ID: ${run.runId}`)}`,
    `printf '%s\\n' ${shellQuote(`Project: ${run.pipeline.projectPath}`)}`,
    `printf '%s\\n' ${shellQuote(`Leader: ${leaderAgentName}`)}`,
    `${claudeCommand} ${shellQuote(prompt)}`,
  ].join("; ");
}

function buildRunSummary(run, requirement) {
  const pipeline = run.pipeline;
  const stages = pipeline.stages
    .map((stage, index) => {
      const agents = stage.agents.length
        ? stage.agents
            .map((agent) => {
              const skills = agent.skills.map((skill) => `${skill.name}@${skill.version}`).join(", ") || "no skills";
              return `    - Agent: ${agent.name}\n      Responsibility: ${agent.responsibility || "no responsibility"}\n      Skills: ${skills}`;
            })
            .join("\n")
        : "    - no agents";
      return `${index + 1}. Stage: ${stage.name}\n${agents}`;
    })
    .join("\n");

  return [
    `Pipeline: ${pipeline.name}`,
    `Leader agent: ${pipeline.leaderAgentName || toLeaderAgentName(pipeline.name)}`,
    `Project: ${pipeline.projectPath}`,
    "",
    "Delegation policy:",
    JSON.stringify(pipeline.delegationPolicy || normalizeDelegationPolicy(), null, 2),
    "",
    "Stages:",
    stages || "No stages configured.",
    "",
    "User requirement:",
    requirement || "用户尚未填写需求，请先询问用户要实现什么。",
  ].join("\n");
}

function appleScriptString(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;
}

function listClaudeAgents() {
  if (!fs.existsSync(CLAUDE_AGENTS_DIR)) return [];

  return fs
    .readdirSync(CLAUDE_AGENTS_DIR)
    .filter((file) => file.endsWith(".md"))
    .map((file) => {
      const fullPath = `${CLAUDE_AGENTS_DIR}/${file}`;
      const content = fs.readFileSync(fullPath, "utf8");
      const name = content.match(/^name:\s*(.+)$/m)?.[1]?.trim() || file.replace(/\.md$/, "");
      const description = content.match(/^description:\s*(.+)$/m)?.[1]?.trim() || "";
      const model = content.match(/^model:\s*(.+)$/m)?.[1]?.trim() || "sonnet";
      const tools = (content.match(/^tools:\s*(.+)$/m)?.[1] || "")
        .split(",")
        .map((tool) => tool.trim())
        .filter(Boolean);
      return { name, description, model, tools, path: fullPath };
    });
}

function readDefinition() {
  if (!fs.existsSync(DEFINITION_PATH)) return null;
  const definition = JSON.parse(fs.readFileSync(DEFINITION_PATH, "utf8"));
  return normalizeStoredDefinition(definition);
}

function normalizeStoredDefinition(definition) {
  const pipelines = Array.isArray(definition?.pipelines)
    ? definition.pipelines.map(normalizePipeline).filter(Boolean)
    : definition?.pipeline
      ? [normalizePipeline(definition.pipeline)].filter(Boolean)
      : [];
  const selectedPipelineId = String(definition?.selectedPipelineId || definition?.pipeline?.id || pipelines[0]?.id || "");
  const currentPipeline =
    pipelines.find((pipeline) => pipeline.id === selectedPipelineId) || pipelines[0] || null;

  return {
    version: 2,
    selectedPipelineId: currentPipeline?.id || "",
    pipelines,
    pipeline: currentPipeline,
  };
}

function writeClaudeAgents(definition) {
  fs.mkdirSync(CLAUDE_AGENTS_DIR, { recursive: true });
  const pipeline = definition.pipeline;
  const generated = [];

  const teamLeader = renderTeamLeaderAgent(pipeline);
  const teamLeaderPath = getAgentPath(pipeline.leaderAgentName || toLeaderAgentName(pipeline.name));
  fs.writeFileSync(teamLeaderPath, teamLeader);
  generated.push(teamLeaderPath);

  for (const stage of pipeline.stages) {
    for (const agent of stage.agents) {
      if (agent.source === "shared") {
        continue;
      }
      const agentPath = getAgentPath(agent.agentName);
      fs.writeFileSync(agentPath, renderRoleAgent(pipeline, stage, agent));
      generated.push(agentPath);
    }
  }

  return generated;
}

function getAgentPath(agentName) {
  return path.join(CLAUDE_AGENTS_DIR, `${agentName}.md`);
}

function renderTeamLeaderAgent(pipeline) {
  const leaderAgentName = pipeline.leaderAgentName || toLeaderAgentName(pipeline.name);
  return `---
name: ${leaderAgentName}
description: Coordinates the ${pipeline.name} AgentFlow pipeline from requirement intake to human-gated delivery.
model: sonnet
tools: Read, Write, Edit, MultiEdit, Grep, Glob, Bash
---

You are the Team Leader for the AgentFlow pipeline "${pipeline.name}".

The following structured pipeline definition is the source of truth for this run:

\`\`\`json
${JSON.stringify(pipeline, null, 2)}
\`\`\`

Execution rules:
- Start by restating the user requirement and mapping it to the pipeline stages.
- Use the configured agents, responsibilities, and skills as your delegation model.
- Shared agents are referenced by name and must not be rewritten by this pipeline.
- Apply the delegationPolicy strictly: start simple, escalate only when the rules justify it.
- Never exceed maxDepth or maxParallelAgents. If deeper delegation is needed, ask the user first.
- Any action listed in requireHumanApprovalFor must become an explicit human checkpoint before execution.
- Treat each stage boundary as a human review gate.
- Keep decisions, risks, and deliverables traceable.
- If a configured agent is not available as a live subagent, simulate delegation by producing that agent's expected output section.
`;
}

function normalizeDelegationPolicy(policy = {}) {
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

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function renderRoleAgent(pipeline, stage, agent) {
  const tools = (agent.tools || ["Read", "Write", "Edit", "Grep", "Glob"]).join(", ");
  const skills = agent.skills?.length
    ? agent.skills.map((skill) => `- ${skill.name}@${skill.version}`).join("\n")
    : "- none";

  return `---
name: ${agent.agentName}
description: ${agent.description}
model: ${agent.model || "sonnet"}
tools: ${tools}
---

You are ${agent.name} in the AgentFlow pipeline "${pipeline.name}".

Stage: ${stage.name}

Responsibility:
${agent.responsibility || "No responsibility configured."}

Configured skills:
${skills}

Operating rules:
- Stay within this role unless the Team Leader explicitly asks otherwise.
- Produce outputs that can be reviewed at the stage gate.
- Call out assumptions, risks, and missing input clearly.
- Keep output concise, actionable, and traceable to the user requirement.
`;
}

function toAgentName(value, fallback = "agent") {
  return `agentflow-${String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || fallback}`;
}

function toLeaderAgentName(value, fallback = "pipeline") {
  return `${toAgentName(value, fallback)}-team-leader`;
}
