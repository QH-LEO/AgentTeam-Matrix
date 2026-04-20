import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeStoredDefinition } from "./schema.js";

export const PROJECT_ROOT = path.resolve(process.cwd(), "..");
export const DEFINITION_PATH = path.join(PROJECT_ROOT, "configs", "agentflow.pipeline.json");
export const HOME_DIR = os.homedir();
export const DEFAULT_CLAUDE_DIR = path.join(HOME_DIR, ".claude");

export function getPaths(options = {}) {
  const claudeDir = getClaudeDir(options.claudeDir);
  const sharedAgentsDir = getSharedAgentsDir(options.sharedAgentsDir, claudeDir);
  return {
    projectRoot: PROJECT_ROOT,
    definitionPath: DEFINITION_PATH,
    claudeDir,
    claudeAgentsDir: getClaudeAgentsDir(claudeDir),
    sharedAgentsDir,
    agentExists: (agentName) => agentExists(agentName, sharedAgentsDir),
  };
}

export function readDefinition() {
  if (!fs.existsSync(DEFINITION_PATH)) return null;
  const definition = JSON.parse(fs.readFileSync(DEFINITION_PATH, "utf8"));
  return normalizeStoredDefinition(definition);
}

export function withCurrentContent(artifacts) {
  return artifacts.map((artifact) => {
    const currentContent = fs.existsSync(artifact.path) ? fs.readFileSync(artifact.path, "utf8") : "";
    return {
      ...artifact,
      currentContent,
      changed: currentContent !== artifact.nextContent,
    };
  });
}

export function writeArtifacts(artifacts) {
  const preview = withCurrentContent(artifacts);
  for (const artifact of artifacts) {
    fs.mkdirSync(path.dirname(artifact.path), { recursive: true });
    fs.writeFileSync(artifact.path, artifact.nextContent);
  }
  return preview.map((artifact) => ({
    type: artifact.type,
    path: artifact.path,
    changed: artifact.changed,
  }));
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
  return resolveConfiguredPath(claudeDir, { fallback: "~/.claude" });
}

export function getClaudeAgentsDir(claudeDir) {
  return path.join(getClaudeDir(claudeDir), "agents");
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
