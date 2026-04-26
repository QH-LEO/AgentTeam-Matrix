import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeStoredDefinition } from "./schema.js";

const STORAGE_FILE = fileURLToPath(import.meta.url);
const ORCHESTRATOR_ROOT = path.resolve(path.dirname(STORAGE_FILE), "..");

export const PROJECT_ROOT = path.resolve(ORCHESTRATOR_ROOT, "..");
export const HOME_DIR = os.homedir();
export const DEFAULT_AGENTFLOW_DIR = resolveConfiguredPath(process.env.AGENTFLOW_HOME || "~/.agentflow");
export const DEFINITION_PATH = path.join(DEFAULT_AGENTFLOW_DIR, "definitions", "agentflow.pipeline.json");
export const DEFINITION_SYNC_STATE_PATH = path.join(DEFAULT_AGENTFLOW_DIR, "state", "definition-sync.json");
export const DEFAULT_CLAUDE_DIR = resolveConfiguredPath(process.env.AGENTFLOW_CLAUDE_DIR || "~/.claude");
export const SYSTEM_DEFINITION_SNAPSHOT_RELATIVE_PATH = path.join("compiled", "definition.snapshot.json");

export function getPaths(options = {}) {
  const claudeDir = getClaudeDir(options.claudeDir);
  const sharedAgentsDir = getSharedAgentsDir(options.sharedAgentsDir, claudeDir);
  return {
    projectRoot: PROJECT_ROOT,
    agentflowDir: getAgentflowDir(options.agentflowDir),
    definitionPath: DEFINITION_PATH,
    claudeDir,
    claudeAgentsDir: getClaudeAgentsDir(claudeDir),
    sharedAgentsDir,
    agentExists: (agentName) => agentExists(agentName, sharedAgentsDir),
  };
}

export function readDefinition() {
  return readNormalizedDefinitionFile(DEFINITION_PATH);
}

export function readSystemDefinitionSnapshot(pipelineId, agentflowDir = DEFAULT_AGENTFLOW_DIR) {
  const snapshotPath = getSystemDefinitionSnapshotPath(pipelineId, agentflowDir);
  return readNormalizedDefinitionFile(snapshotPath);
}

export function getSystemDefinitionSnapshotPath(pipelineId, agentflowDir = DEFAULT_AGENTFLOW_DIR) {
  return path.join(getCompiledDir(pipelineId, agentflowDir), "definition.snapshot.json");
}

export function withCurrentContent(artifacts) {
  return artifacts.map((artifact) => {
    const currentContent = fs.existsSync(artifact.path) ? fs.readFileSync(artifact.path, "utf8") : "";
    const nextContent = resolveNextContent(artifact, currentContent);
    return {
      ...artifact,
      currentContent,
      nextContent,
      changed: currentContent !== nextContent,
    };
  });
}

export function writeArtifacts(artifacts) {
  const preview = withCurrentContent(artifacts);
  for (const artifact of preview) {
    fs.mkdirSync(path.dirname(artifact.path), { recursive: true });
    fs.writeFileSync(artifact.path, artifact.nextContent);
  }
  return preview.map((artifact) => ({
    type: artifact.type,
    path: artifact.path,
    changed: artifact.changed,
  }));
}

function resolveNextContent(artifact, currentContent) {
  if (artifact.seedOnly && currentContent) return currentContent;
  if (artifact.mergeStrategy === "marker-block") {
    return mergeMarkerBlock(currentContent, artifact.markerStart, artifact.markerEnd, artifact.nextContent);
  }
  return artifact.nextContent;
}

function mergeMarkerBlock(currentContent, markerStart, markerEnd, blockContent) {
  const start = markerStart || "<!-- AGENTFLOW:START -->";
  const end = markerEnd || "<!-- AGENTFLOW:END -->";
  const block = `${start}\n${String(blockContent || "").trim()}\n${end}`;
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);
  if (pattern.test(currentContent)) {
    return currentContent.replace(pattern, block).replace(/\n*$/, "\n");
  }
  const prefix = currentContent ? currentContent.replace(/\n*$/, "\n\n") : "";
  return `${prefix}${block}\n`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function writeDefinition(definition) {
  fs.mkdirSync(path.dirname(DEFINITION_PATH), { recursive: true });
  fs.writeFileSync(DEFINITION_PATH, `${JSON.stringify(definition, null, 2)}\n`);
  return DEFINITION_PATH;
}

export function readDefinitionSyncState() {
  if (!fs.existsSync(DEFINITION_SYNC_STATE_PATH)) return { pipelines: {} };
  try {
    const payload = JSON.parse(fs.readFileSync(DEFINITION_SYNC_STATE_PATH, "utf8"));
    return payload && typeof payload === "object" && payload.pipelines && typeof payload.pipelines === "object"
      ? payload
      : { pipelines: {} };
  } catch {
    return { pipelines: {} };
  }
}

export function writeDefinitionSyncRecord(pipelineId, record) {
  const state = readDefinitionSyncState();
  state.pipelines = state.pipelines || {};
  state.pipelines[pipelineId] = {
    ...(state.pipelines[pipelineId] || {}),
    ...record,
  };
  fs.mkdirSync(path.dirname(DEFINITION_SYNC_STATE_PATH), { recursive: true });
  fs.writeFileSync(DEFINITION_SYNC_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
  return state.pipelines[pipelineId];
}

export function getDefinitionSyncRecord(pipelineId) {
  const state = readDefinitionSyncState();
  return state.pipelines?.[pipelineId] || null;
}

export function readDefinitionFile(filePath) {
  return readNormalizedDefinitionFile(filePath);
}

function readNormalizedDefinitionFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const definition = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return normalizeStoredDefinition(definition);
}

export function listClaudeAgents(options = {}) {
  const agentsDir = getSharedAgentsDir(options.sharedAgentsDir, options.claudeDir);
  if (!fs.existsSync(agentsDir)) return [];

  return fs
    .readdirSync(agentsDir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => {
      const fullPath = path.join(agentsDir, file);
      const content = fs.readFileSync(fullPath, "utf8");
      const agentName = file.replace(/\.md$/, "");
      const name = content.match(/^name:\s*(.+)$/m)?.[1]?.trim() || agentName;
      const description = content.match(/^description:\s*(.+)$/m)?.[1]?.trim() || "";
      const model = content.match(/^model:\s*(.+)$/m)?.[1]?.trim() || "sonnet";
      const tools = (content.match(/^tools:\s*(.+)$/m)?.[1] || "")
        .split(",")
        .map((tool) => tool.trim())
        .filter(Boolean);
      return { agentName, name, description, model, tools, path: fullPath };
    });
}

export function getClaudeDir(claudeDir) {
  return resolveConfiguredPath(claudeDir, { fallback: process.env.AGENTFLOW_CLAUDE_DIR || "~/.claude" });
}

export function getClaudeAgentsDir(claudeDir) {
  return path.join(getClaudeDir(claudeDir), "agents");
}

export function getAgentflowDir(agentflowDir) {
  return resolveConfiguredPath(agentflowDir, { fallback: process.env.AGENTFLOW_HOME || "~/.agentflow" });
}

export function getCompiledDir(pipelineId, agentflowDir = DEFAULT_AGENTFLOW_DIR) {
  return path.join(getAgentflowDir(agentflowDir), "compiled", safePathSegment(pipelineId || "pipeline"));
}

export function getSharedAgentsDir(sharedAgentsDir, claudeDir) {
  return resolveConfiguredPath(sharedAgentsDir, {
    fallback: getClaudeAgentsDir(claudeDir),
  });
}

export function resolveProjectPath(projectPath, baseDir = PROJECT_ROOT) {
  return resolveConfiguredPath(projectPath, { fallback: ".", baseDir });
}

export function resolveConfiguredPath(value, options = {}) {
  const { fallback = "", baseDir = PROJECT_ROOT } = options;
  const target = String(value || fallback).trim() || String(fallback).trim();
  if (!target) return "";
  if (target === "~") return HOME_DIR;
  if (target.startsWith("~/")) {
    return path.join(HOME_DIR, target.slice(2));
  }
  return path.isAbsolute(target) ? path.normalize(target) : path.resolve(baseDir, target);
}

export function getAgentPath(agentName, agentsDir) {
  return path.join(agentsDir, `${agentName}.md`);
}

export function agentExists(agentName, agentsDir) {
  return fs.existsSync(getAgentPath(agentName, agentsDir));
}

export function canWriteDirectory(directory) {
  try {
    fs.accessSync(directory, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function canCreateOrWriteDirectory(directory) {
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.accessSync(directory, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function canCreateDirectory(directory) {
  let current = directory;
  while (current && !fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current ? canWriteDirectory(current) : false;
}

export function pathExistsDirectory(directory) {
  return fs.existsSync(directory) && fs.statSync(directory).isDirectory();
}

function safePathSegment(value) {
  return String(value || "pipeline")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "pipeline";
}
