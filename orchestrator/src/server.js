import express from "express";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { buildCompilePlan, buildLaunchPrompt, lintDefinition } from "./compiler.js";
import { normalizeDefinitionRequest, normalizeLaunchMode, normalizePipeline } from "./schema.js";
import {
  canCreateDirectory,
  canWriteDirectory,
  getDefinitionSyncRecord,
  getClaudeAgentsDir,
  getClaudeDir,
  getSharedAgentsDir,
  getAgentPath,
  getPaths,
  listClaudeAgents,
  pathExistsDirectory,
  readDefinition,
  readDefinitionFile,
  resolveConfiguredPath,
  resolveProjectPath,
  withCurrentContent,
  writeDefinition,
  writeDefinitionSyncRecord,
  writeArtifacts,
} from "./storage.js";

const PORT = Number(process.env.PORT || 8787);
const TMUX_BIN = process.env.TMUX_BIN || findTmuxBinary();
const runs = new Map();

const app = express();
app.use(express.json({ limit: "2mb" }));
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
  res.json({
    agents: listClaudeAgents({
      claudeDir: req.query?.claudeDir,
      sharedAgentsDir: req.query?.sharedAgentsDir,
    }),
  });
});

app.post("/api/lint", (req, res) => {
  const existingDefinition = readDefinition();
  const definition = normalizeDefinitionRequest(req.body, existingDefinition);
  const result = lintDefinition(
    definition,
    getPaths({
      claudeDir: definition.pipeline?.claudeDir,
      sharedAgentsDir: definition.pipeline?.sharedAgentsDir,
    })
  );
  res.json({
    ok: result.ok,
    issues: result.issues,
  });
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

  const existingDefinition = readDefinition();
  const definition = normalizeDefinitionRequest({ pipeline, pipelines: [pipeline], selectedPipelineId: pipeline.id }, existingDefinition);
  const plan = buildCompilePlan(
    definition,
    existingDefinition,
    getPaths({
      claudeDir: pipeline.claudeDir,
      sharedAgentsDir: pipeline.sharedAgentsDir,
    })
  );
  const artifact = withCurrentContent(plan.artifacts).find((item) => item.type === "leader-agent");
  res.json({
    leaderAgentName: pipeline.leaderAgentName,
    leaderPath: artifact?.path || getAgentPath(pipeline.leaderAgentName, getClaudeAgentsDir(pipeline.claudeDir)),
    nextMarkdown: artifact?.nextContent || "",
    currentMarkdown: artifact?.currentContent || "",
    changed: artifact?.changed ?? false,
  });
});

app.post("/api/definition", (req, res) => {
  const existingDefinition = readDefinition();
  const definition = normalizeDefinitionRequest(req.body, existingDefinition);
  const plan = buildCompilePlan(
    definition,
    existingDefinition,
    getPaths({
      claudeDir: definition.pipeline?.claudeDir,
      sharedAgentsDir: definition.pipeline?.sharedAgentsDir,
    })
  );
  if (!plan.definition.pipeline) {
    res.status(400).json({ error: "pipeline is required" });
    return;
  }
  if (!plan.ok) {
    res.status(400).json({ error: "definition lint failed", issues: plan.issues });
    return;
  }

  const written = writeArtifacts(plan.artifacts);
  persistDefinitionSyncRecord(plan, written, "definition-write");
  res.json({
    definition: plan.definition,
    generatedAgents: written
      .filter((item) => item.type === "leader-agent" || item.type === "managed-agent")
      .map((item) => item.path),
    written,
  });
});

app.post("/api/definition/sync-preview", (req, res) => {
  const pipeline = normalizePipeline(req.body?.pipeline);
  if (!pipeline) {
    res.status(400).json({ error: "pipeline is required" });
    return;
  }

  const currentDefinition = readDefinition();
  const syncSource = resolveDefinitionSyncSource(pipeline, currentDefinition);
  if (!syncSource.definition) {
    res.status(404).json({
      error: "definition sync source not found",
      detail: `未找到上次成功写入的同步快照：${syncSource.sourcePath || "未记录"}。请先执行一次“确认写入”，再使用 Sync DSL。`,
    });
    return;
  }

  res.json({
    ok: true,
    sourceKind: syncSource.sourceKind,
    source: syncSource.source,
    resolvedProjectPath: syncSource.resolvedProjectPath,
    sourcePath: syncSource.sourcePath,
    snapshotPath: syncSource.snapshotPath,
    definitionPath: syncSource.definitionPath,
    definition: syncSource.definition,
    selectedPipelineId: syncSource.definition.selectedPipelineId,
    pipelineCount: syncSource.definition.pipelines?.length || (syncSource.definition.pipeline ? 1 : 0),
    lastWrittenAt: syncSource.lastWrittenAt,
    currentExists: !!currentDefinition,
    currentMatches: currentDefinition ? JSON.stringify(currentDefinition) === JSON.stringify(syncSource.definition) : false,
  });
});

app.post("/api/definition/sync", (req, res) => {
  const pipeline = normalizePipeline(req.body?.pipeline);
  if (!pipeline) {
    res.status(400).json({ error: "pipeline is required" });
    return;
  }

  const currentDefinition = readDefinition();
  const syncSource = resolveDefinitionSyncSource(pipeline, currentDefinition);
  if (!syncSource.definition) {
    res.status(404).json({
      error: "definition sync source not found",
      detail: `未找到上次成功写入的同步快照：${syncSource.sourcePath || "未记录"}。请先执行一次“确认写入”，再使用 Sync DSL。`,
    });
    return;
  }

  const definitionPath = writeDefinition(syncSource.definition);
  res.json({
    ok: true,
    sourceKind: syncSource.sourceKind,
    source: syncSource.source,
    resolvedProjectPath: syncSource.resolvedProjectPath,
    definitionPath,
    sourcePath: syncSource.sourcePath,
    snapshotPath: syncSource.snapshotPath,
    lastWrittenAt: syncSource.lastWrittenAt,
    definition: syncSource.definition,
  });
});

app.post("/api/compile/preview", (req, res) => {
  const existingDefinition = readDefinition();
  const definition = normalizeDefinitionRequest(req.body, existingDefinition);
  const plan = buildCompilePlan(
    definition,
    existingDefinition,
    getPaths({
      claudeDir: definition.pipeline?.claudeDir,
      sharedAgentsDir: definition.pipeline?.sharedAgentsDir,
    })
  );
  res.json({
    ...plan,
    artifacts: withCurrentContent(plan.artifacts),
  });
});

app.post("/api/compile/apply", (req, res) => {
  const existingDefinition = readDefinition();
  const definition = normalizeDefinitionRequest(req.body, existingDefinition);
  const plan = buildCompilePlan(
    definition,
    existingDefinition,
    getPaths({
      claudeDir: definition.pipeline?.claudeDir,
      sharedAgentsDir: definition.pipeline?.sharedAgentsDir,
    })
  );
  if (!plan.definition.pipeline) {
    res.status(400).json({ error: "pipeline is required" });
    return;
  }
  if (!plan.ok) {
    res.status(400).json({ error: "compile lint failed", issues: plan.issues });
    return;
  }

  const written = writeArtifacts(plan.artifacts);
  persistDefinitionSyncRecord(plan, written, "compile-apply");
  res.json({
    ok: true,
    pipelineId: plan.pipelineId,
    definition: plan.definition,
    written,
    issues: plan.issues,
    warnings: plan.warnings,
  });
});

app.post("/api/launch-prompt/preview", (req, res) => {
  const pipeline = normalizePipeline(req.body?.pipeline);
  if (!pipeline) {
    res.status(400).json({ error: "pipeline is required" });
    return;
  }

  res.json(buildLaunchPrompt({
    pipeline,
    requirement: String(req.body?.requirement || ""),
    launchMode: normalizeLaunchMode(req.body?.launchMode),
    projectRoot: getPaths().projectRoot,
  }));
});

app.post("/api/runs", (req, res) => {
  const pipeline = normalizePipeline(req.body?.pipeline);
  if (!pipeline) {
    res.status(400).json({ error: "pipeline is required" });
    return;
  }

  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const requirement = String(req.body?.requirement || "");
  const launchMode = normalizeLaunchMode(req.body?.launchMode);
  const resolvedProjectPath = resolveProjectPath(pipeline.projectPath);

  if (!pathExistsDirectory(resolvedProjectPath)) {
    res.status(400).json({ error: "invalid projectPath", detail: resolvedProjectPath });
    return;
  }

  runs.set(runId, {
    runId,
    pipeline,
    requirement,
    launchMode,
    status: "created",
    createdAt: new Date().toISOString(),
  });

  res.status(201).json({ runId, status: "created", pipeline, requirement, launchMode });
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
  const launchMode = normalizeLaunchMode(req.body?.launchMode || run.launchMode);
  run.requirement = requirement;
  run.launchMode = launchMode;

  const { command, prompt } = buildLaunchPrompt({
    pipeline: run.pipeline,
    requirement,
    launchMode,
    runId: run.runId,
    projectRoot: getPaths().projectRoot,
  });
  const script = buildITermAppleScript(command);
  run.status = "opening";
  run.openingAt = new Date().toISOString();
  run.launchPrompt = prompt;

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

function resolveDefinitionSyncSource(pipeline, currentDefinition = null) {
  const projectPath = pipeline?.projectPath || ".";
  const resolvedProjectPath = resolveProjectPath(projectPath, getPaths().projectRoot);
  const record = getDefinitionSyncRecord(pipeline?.id);
  const snapshotPath = record?.snapshotPath || record?.sourcePath || "";
  const definition = snapshotPath ? readDefinitionFile(snapshotPath) : null;
  if (definition) {
    return {
      sourceKind: "last-written-snapshot",
      source: record?.source || "compile-apply",
      projectPath: record?.projectPath || projectPath,
      resolvedProjectPath: record?.resolvedProjectPath || resolvedProjectPath,
      sourcePath: snapshotPath,
      snapshotPath,
      definitionPath: record?.definitionPath || getPaths().definitionPath,
      lastWrittenAt: record?.updatedAt || null,
      definition,
    };
  }

  const legacySnapshotPath = path.join(resolvedProjectPath, ".agentflow", "compiled", "definition.snapshot.json");
  const legacySnapshot = readDefinitionFile(legacySnapshotPath);
  if (legacySnapshot) {
    return {
      sourceKind: "legacy-snapshot",
      source: "system-snapshot",
      projectPath,
      resolvedProjectPath,
      sourcePath: legacySnapshotPath,
      snapshotPath: legacySnapshotPath,
      definitionPath: getPaths().definitionPath,
      lastWrittenAt: null,
      definition: legacySnapshot,
    };
  }

  const compiledLeaderPath = path.join(resolvedProjectPath, ".agentflow", "compiled", "leader.md");
  const compiledLeaderDefinition = readDefinitionFromCompiledLeader(compiledLeaderPath);
  if (compiledLeaderDefinition) {
    return {
      sourceKind: "compiled-leader",
      source: "compiled-leader",
      projectPath,
      resolvedProjectPath,
      sourcePath: compiledLeaderPath,
      snapshotPath: compiledLeaderPath,
      definitionPath: getPaths().definitionPath,
      lastWrittenAt: null,
      definition: compiledLeaderDefinition,
    };
  }

  return {
    sourceKind: "last-written-snapshot",
    source: record?.source || "compile-apply",
    projectPath,
    resolvedProjectPath,
    sourcePath: snapshotPath || compiledLeaderPath,
    snapshotPath: snapshotPath || legacySnapshotPath || compiledLeaderPath,
    definitionPath: record?.definitionPath || getPaths().definitionPath,
    lastWrittenAt: record?.updatedAt || null,
    definition: null,
  };
}

function readDefinitionFromCompiledLeader(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;

  const content = fs.readFileSync(filePath, "utf8");
  const match = content.match(/Structured pipeline definition:\s*```json\s*([\s\S]*?)```/);
  if (!match?.[1]) return null;

  try {
    const pipeline = JSON.parse(match[1]);
    return normalizeDefinitionRequest(
      {
        pipeline,
        pipelines: [pipeline],
        selectedPipelineId: pipeline.id,
      },
      null
    );
  } catch {
    return null;
  }
}

function persistDefinitionSyncRecord(plan, written, source) {
  const pipelineId = plan?.pipelineId;
  const pipeline = plan?.definition?.pipeline;
  const snapshotArtifact = written.find((artifact) => artifact.type === "compiled-definition-snapshot");
  if (!pipelineId || !pipeline || !snapshotArtifact?.path) return null;

  return writeDefinitionSyncRecord(pipelineId, {
    source,
    sourceKind: "last-written-snapshot",
    snapshotPath: snapshotArtifact.path,
    sourcePath: snapshotArtifact.path,
    projectPath: pipeline.projectPath || ".",
    resolvedProjectPath: resolveProjectPath(pipeline.projectPath, getPaths().projectRoot),
    definitionPath: getPaths().definitionPath,
    updatedAt: new Date().toISOString(),
  });
}

function buildPreflightChecks(pipeline) {
  const claudeDir = getClaudeDir(pipeline.claudeDir);
  const claudeAgentsDir = getClaudeAgentsDir(claudeDir);
  const sharedAgentsDir = getSharedAgentsDir(pipeline.sharedAgentsDir, claudeDir);
  const resolvedProjectPath = resolveProjectPath(pipeline.projectPath);
  const leaderAgentName = pipeline.leaderAgentName;
  const leaderPath = getAgentPath(leaderAgentName, claudeAgentsDir);
  const sharedAgents = pipeline.stages.flatMap((stage) =>
    stage.agents.filter((agent) => agent.source === "shared")
  );
  const skillRefs = pipeline.stages.flatMap((stage) =>
    stage.agents.flatMap((agent) =>
      (agent.skills || [])
        .filter((skill) => skill.path)
        .map((skill) => ({
          name: skill.name,
          path: resolveSkillPath(resolvedProjectPath, skill.path),
        }))
    )
  );
  const missingSharedAgents = sharedAgents.filter((agent) => !fs.existsSync(getAgentPath(agent.agentName, sharedAgentsDir)));
  const missingSkillRefs = skillRefs.filter((skill) => !pathExistsDirectory(skill.path));
  const claudeBinary = findExecutable("claude", [
    process.env.HOME ? path.join(process.env.HOME, ".local", "bin", "claude") : "",
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ]);
  const iTermAvailable = checkITerm().ok;
  const projectPathExists = pathExistsDirectory(resolvedProjectPath);
  const agentsDirExists = fs.existsSync(claudeAgentsDir);
  const sharedAgentsDirExists = pathExistsDirectory(sharedAgentsDir);
  const agentflowDir = path.join(resolvedProjectPath, ".agentflow");
  const projectClaudeSkillsDir = path.join(resolvedProjectPath, ".claude", "skills");

  return [
    {
      id: "claude-dir",
      label: "Claude 目录",
      status: pathExistsDirectory(claudeDir) ? "pass" : "warn",
      detail: claudeDir,
    },
    {
      id: "shared-agents-dir",
      label: "共享 Agent 目录",
      status: sharedAgentsDirExists ? "pass" : sharedAgents.length ? "fail" : "warn",
      detail: sharedAgentsDirExists ? sharedAgentsDir : `目录不存在：${sharedAgentsDir}`,
    },
    {
      id: "project-path",
      label: "项目地址",
      status: projectPathExists ? "pass" : "fail",
      detail: projectPathExists ? resolvedProjectPath : `项目目录不存在：${resolvedProjectPath}`,
    },
    {
      id: "project-write",
      label: "项目写入权限",
      status: projectPathExists && canWriteDirectory(resolvedProjectPath) ? "pass" : "fail",
      detail: projectPathExists && canWriteDirectory(resolvedProjectPath)
        ? "可写入项目级 AgentFlow 资产"
        : "项目目录不可写，无法生成 .agentflow 或 .claude/skills",
    },
    {
      id: "agentflow-dir",
      label: ".agentflow 资产目录",
      status: projectPathExists && (fs.existsSync(agentflowDir) ? canWriteDirectory(agentflowDir) : canCreateDirectory(agentflowDir)) ? "pass" : "fail",
      detail: agentflowDir,
    },
    {
      id: "project-claude-skills",
      label: "项目 Claude Skills",
      status: projectPathExists && (fs.existsSync(projectClaudeSkillsDir) ? canWriteDirectory(projectClaudeSkillsDir) : canCreateDirectory(projectClaudeSkillsDir)) ? "pass" : "fail",
      detail: projectClaudeSkillsDir,
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
      status: agentsDirExists && canWriteDirectory(claudeAgentsDir) ? "pass" : "fail",
      detail: agentsDirExists ? claudeAgentsDir : `目录不存在：${claudeAgentsDir}`,
    },
    {
      id: "leader-agent",
      label: "Team Leader Agent",
      status: fs.existsSync(leaderPath) ? "pass" : "warn",
      detail: fs.existsSync(leaderPath) ? leaderPath : `编译写入后会创建：${leaderPath}`,
    },
    {
      id: "shared-agents",
      label: "共享 Agent 引用",
      status: missingSharedAgents.length ? "fail" : "pass",
      detail: missingSharedAgents.length
        ? `缺失共享 Agent：${missingSharedAgents.map((agent) => `${agent.name} -> @${agent.agentName}`).join(", ")}`
        : sharedAgents.length
          ? `已找到 ${sharedAgents.length} 个共享 Agent`
          : "当前流水线未引用共享 Agent",
    },
    {
      id: "skill-directories",
      label: "Skill 目录引用",
      status: missingSkillRefs.length ? "warn" : "pass",
      detail: missingSkillRefs.length
        ? `未找到 Skill 目录：${missingSkillRefs.map((skill) => `${skill.name} -> ${skill.path}`).join(", ")}`
        : skillRefs.length
          ? `已找到 ${skillRefs.length} 个 Skill 目录`
          : "当前流水线未绑定 Skill 目录",
    },
  ];
}

function resolveSkillPath(projectPath, skillPath) {
  return resolveConfiguredPath(skillPath, { baseDir: projectPath });
}

function checkTmux() {
  if (!TMUX_BIN) return { ok: false, error: "tmux not found" };
  const result = spawnSync(TMUX_BIN, ["-V"], { encoding: "utf8" });
  if (result.status === 0) {
    return { ok: true, version: result.stdout.trim() };
  }
  return { ok: false, error: result.stderr || result.error?.message || "tmux not found" };
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

function buildITermAppleScript(command) {
  return `
tell application "iTerm2"
  activate
  set newWindow to (create window with default profile)
  delay 0.2
  try
    set fullscreen of newWindow to true
  on error
    try
      tell application "System Events"
        tell process "iTerm2"
          keystroke "f" using {control down, command down}
        end tell
      end tell
    end try
  end try
  delay 0.2
  tell current session of newWindow
    write text ${appleScriptString(command)}
  end tell
end tell
`;
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

function appleScriptString(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;
}
