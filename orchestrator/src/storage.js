import fs from "node:fs";
import path from "node:path";
import { normalizeStoredDefinition } from "./schema.js";

export const PROJECT_ROOT = path.resolve(process.cwd(), "..");
export const DEFINITION_PATH = path.join(PROJECT_ROOT, "configs", "agentflow.pipeline.json");
export const CLAUDE_AGENTS_DIR = "/Users/leo/.claude/agents";

export function getPaths() {
  return {
    projectRoot: PROJECT_ROOT,
    definitionPath: DEFINITION_PATH,
    claudeAgentsDir: CLAUDE_AGENTS_DIR,
    agentExists,
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

export function listClaudeAgents() {
  if (!fs.existsSync(CLAUDE_AGENTS_DIR)) return [];

  return fs
    .readdirSync(CLAUDE_AGENTS_DIR)
    .filter((file) => file.endsWith(".md"))
    .map((file) => {
      const fullPath = path.join(CLAUDE_AGENTS_DIR, file);
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

export function getAgentPath(agentName) {
  return path.join(CLAUDE_AGENTS_DIR, `${agentName}.md`);
}

export function agentExists(agentName) {
  return fs.existsSync(getAgentPath(agentName));
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
