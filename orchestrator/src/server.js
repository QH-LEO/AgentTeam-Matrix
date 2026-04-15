import express from "express";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PORT = Number(process.env.PORT || 8787);
const TMUX_BIN = process.env.TMUX_BIN || findTmuxBinary();
const PROJECT_ROOT = path.resolve(process.cwd(), "..");
const DEFINITION_PATH = path.join(PROJECT_ROOT, "configs", "agentflow.pipeline.json");
const CLAUDE_AGENTS_DIR = "/Users/leo/.claude/agents";
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

app.get("/api/definition", (req, res) => {
  const definition = readDefinition();
  if (!definition) {
    res.status(404).json({ error: "definition not found" });
    return;
  }
  res.json(definition);
});

app.post("/api/definition", (req, res) => {
  const pipeline = normalizePipeline(req.body?.pipeline);
  if (!pipeline) {
    res.status(400).json({ error: "pipeline is required" });
    return;
  }

  const definition = { version: 1, pipeline };
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
  const result = spawnSync("osascript", ["-e", script], { encoding: "utf8" });
  if (result.status !== 0) {
    res.status(500).json({ error: "failed to open iTerm2", detail: result.stderr || result.stdout });
    return;
  }

  run.status = "opened";
  run.openedAt = new Date().toISOString();
  res.json(run);
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

function normalizePipeline(value) {
  if (!value || typeof value !== "object" || !value.name) return null;
  return {
    id: String(value.id || ""),
    name: String(value.name),
    leaderAgentName: String(value.leaderAgentName || toLeaderAgentName(value.name)),
    projectPath: String(value.projectPath || process.cwd()),
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

function buildITermAppleScript(run, requirement) {
  const command = buildClaudeCommand(run, requirement);
  return `
tell application "iTerm2"
  activate
  set newWindow to (create window with default profile)
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
  return JSON.parse(fs.readFileSync(DEFINITION_PATH, "utf8"));
}

function writeClaudeAgents(definition) {
  fs.mkdirSync(CLAUDE_AGENTS_DIR, { recursive: true });
  const pipeline = definition.pipeline;
  const generated = [];

  const teamLeader = renderTeamLeaderAgent(pipeline);
  const teamLeaderPath = path.join(CLAUDE_AGENTS_DIR, `${pipeline.leaderAgentName || toLeaderAgentName(pipeline.name)}.md`);
  fs.writeFileSync(teamLeaderPath, teamLeader);
  generated.push(teamLeaderPath);

  for (const stage of pipeline.stages) {
    for (const agent of stage.agents) {
      if (agent.source === "shared") {
        continue;
      }
      const agentPath = path.join(CLAUDE_AGENTS_DIR, `${agent.agentName}.md`);
      fs.writeFileSync(agentPath, renderRoleAgent(pipeline, stage, agent));
      generated.push(agentPath);
    }
  }

  return generated;
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
- Treat each stage boundary as a human review gate.
- Keep decisions, risks, and deliverables traceable.
- If a configured agent is not available as a live subagent, simulate delegation by producing that agent's expected output section.
`;
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
