#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Install AgentFlow global Claude assets from the bundled DSL URL.

Usage:
  curl -fsSL <install-sh-url> | bash
  curl -fsSL <install-sh-url> | bash -s -- <dsl-url>
  AGENTFLOW_DSL_URL=<dsl-url> bash scripts/install-agentflow.sh

Options:
  --dry-run              Print files that would be written.
  --force                Skip confirmation prompts.
  --claude-dir <path>    Override Claude config root. Default: ~/.claude
  -h, --help             Show this help.
USAGE
}

DEFAULT_DSL_URL="__AGENTFLOW_DSL_URL__"
DRY_RUN=0
FORCE=0
CLAUDE_DIR="${AGENTFLOW_CLAUDE_DIR:-$HOME/.claude}"
DSL_URL="${AGENTFLOW_DSL_URL:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --claude-dir)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --claude-dir" >&2
        exit 2
      fi
      CLAUDE_DIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -n "$DSL_URL" ]]; then
        echo "DSL URL already provided: $DSL_URL" >&2
        exit 2
      fi
      DSL_URL="$1"
      shift
      ;;
  esac
done

if [[ -z "$DSL_URL" ]]; then
  DSL_URL="$DEFAULT_DSL_URL"
fi

if [[ -z "$DSL_URL" || "$DSL_URL" == "__AGENTFLOW_DSL_URL__" ]]; then
  echo "Missing bundled DSL URL. Replace DEFAULT_DSL_URL in this script, pass a URL as the first argument, or set AGENTFLOW_DSL_URL." >&2
  exit 2
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required to parse and compile AgentFlow DSL." >&2
  exit 1
fi

AGENTFLOW_HOME="${AGENTFLOW_HOME:-$HOME/.agentflow}"
export AGENTFLOW_DSL_URL="$DSL_URL"
export AGENTFLOW_HOME
export AGENTFLOW_CLAUDE_DIR="$CLAUDE_DIR"
export AGENTFLOW_DRY_RUN="$DRY_RUN"
export AGENTFLOW_FORCE="$FORCE"

python3 - <<'PY'
import json
import os
import re
import sys
import tempfile
import urllib.request
from pathlib import Path

dsl_url = os.environ["AGENTFLOW_DSL_URL"]
agentflow_home = Path(os.environ["AGENTFLOW_HOME"]).expanduser()
claude_dir = Path(os.environ["AGENTFLOW_CLAUDE_DIR"]).expanduser()
dry_run = os.environ.get("AGENTFLOW_DRY_RUN") == "1"
force = os.environ.get("AGENTFLOW_FORCE") == "1"

def fail(message, code=1):
    print(f"agentflow install: {message}", file=sys.stderr)
    raise SystemExit(code)

def fetch_json(url):
    try:
        if re.match(r"^https?://", url):
            with urllib.request.urlopen(url, timeout=30) as response:
                return response.read().decode("utf-8")
        if url.startswith("file://"):
            return Path(url[7:]).expanduser().read_text(encoding="utf-8")
        return Path(url).expanduser().read_text(encoding="utf-8")
    except Exception as exc:
        fail(f"failed to download DSL from {url}: {exc}")

def slugify(value, fallback="pipeline"):
    slug = re.sub(r"[^a-z0-9]+", "-", str(value or "").strip().lower()).strip("-")
    return slug or fallback

def normalize_list(value):
    return value if isinstance(value, list) else []

def selected_pipeline(definition):
    pipelines = normalize_list(definition.get("pipelines"))
    if not pipelines and isinstance(definition.get("pipeline"), dict):
        pipelines = [definition["pipeline"]]
    selected_id = definition.get("selectedPipelineId") or (definition.get("pipeline") or {}).get("id")
    pipeline = next((item for item in pipelines if item.get("id") == selected_id), None) or (pipelines[0] if pipelines else None)
    if not isinstance(pipeline, dict) or not pipeline.get("name"):
        fail("DSL must contain a pipeline with a name")
    pipeline.setdefault("id", slugify(pipeline["name"]))
    pipeline.setdefault("leaderAgentName", f"agentflow-{slugify(pipeline['name'])}-team-leader")
    pipeline.setdefault("stages", [])
    pipeline.setdefault("defaultSkills", [])
    pipeline.setdefault("knowledgeBase", {})
    pipeline["knowledgeBase"].setdefault("enabled", True)
    pipeline["knowledgeBase"].setdefault("path", ".agentflow/wiki")
    pipeline["knowledgeBase"].setdefault("domain", f"{pipeline['name']} 项目研发知识库")
    pipeline["knowledgeBase"].setdefault("writeMode", "proposal_first")
    pipeline["knowledgeBase"].setdefault("autoOrient", True)
    pipeline["knowledgeBase"].setdefault("rawImmutable", True)
    pipeline.setdefault("delegationPolicy", {})
    pipeline["delegationPolicy"].setdefault("defaultMode", "self_first")
    pipeline["delegationPolicy"].setdefault("allowSubAgents", True)
    pipeline["delegationPolicy"].setdefault("allowAgentTeam", True)
    pipeline["delegationPolicy"].setdefault("allowRecursiveDelegation", True)
    pipeline["delegationPolicy"].setdefault("maxDepth", 2)
    pipeline["delegationPolicy"].setdefault("maxParallelAgents", 4)
    pipeline["delegationPolicy"].setdefault("escalationRules", {})
    pipeline.setdefault("qualityGates", [])
    return pipeline, {
        "version": 3,
        "selectedPipelineId": pipeline["id"],
        "pipelines": pipelines,
        "pipeline": pipeline,
    }

def all_agents(pipeline):
    agents = []
    for stage in normalize_list(pipeline.get("stages")):
        for agent in normalize_list(stage.get("agents")):
            agents.append((stage, agent))
    return agents

def action_lines(stage):
    lines = []
    for action in normalize_list(stage.get("actions")):
        gates = ", ".join(normalize_list(action.get("gates"))) or "none"
        inputs = ", ".join(normalize_list(action.get("inputs"))) or "none"
        outputs = ", ".join(normalize_list(action.get("outputs"))) or "none"
        lines.append(f"### {action.get('name', action.get('id', 'action'))}\n\n- Owner: @{action.get('owner', 'unassigned')}\n- Inputs: {inputs}\n- Outputs: {outputs}\n- Gates: {gates}")
    return "\n\n".join(lines) or "No actions configured."

def gate_plan(pipeline):
    return {
        "version": 1,
        "pipelineId": pipeline["id"],
        "pipelineName": pipeline["name"],
        "leaderAgentName": pipeline["leaderAgentName"],
        "qualityGates": normalize_list(pipeline.get("qualityGates")),
        "actionGates": [
            {
                "stageId": stage.get("id"),
                "stageName": stage.get("name"),
                "actionId": action.get("id"),
                "actionName": action.get("name"),
                "owner": action.get("owner"),
                "inputs": normalize_list(action.get("inputs")),
                "outputs": normalize_list(action.get("outputs")),
                "gates": normalize_list(action.get("gates")),
            }
            for stage in normalize_list(pipeline.get("stages"))
            for action in normalize_list(stage.get("actions"))
        ],
    }

def render_sop(pipeline):
    stages = "\n\n".join(
        f"## {index + 1}. {stage.get('name', 'Stage')}\n\n{action_lines(stage)}"
        for index, stage in enumerate(normalize_list(pipeline.get("stages")))
    ) or "No stages configured."
    return f"# {pipeline['name']} SOP\n\n{pipeline.get('sop', {}).get('description', 'AgentFlow pipeline SOP.')}\n\n{stages}\n"

def render_delegation(pipeline):
    policy = pipeline["delegationPolicy"]
    rules = policy.get("escalationRules", {})
    return f"""# {pipeline['name']} Delegation Policy

- Default mode: {policy.get('defaultMode')}
- Allow subagents: {'yes' if policy.get('allowSubAgents') else 'no'}
- Allow agent team: {'yes' if policy.get('allowAgentTeam') else 'no'}
- Allow recursive delegation: {'yes' if policy.get('allowRecursiveDelegation') else 'no'}
- Max depth: {policy.get('maxDepth')}
- Max parallel agents: {policy.get('maxParallelAgents')}

## Decision Rules

### Self
{rules.get('self', 'Use the current agent for small, clear, bounded tasks.')}

### Sub Agent
{rules.get('subAgent', 'Use subagents for bounded parallel or specialist work.')}

### Agent Team
{rules.get('team', 'Use an agent team for cross-role work that needs orchestration.')}

### Recursive Delegation
{rules.get('recursive', 'Recursive delegation must be approved and coordinated by the Team Leader.')}
"""

def render_gates_md(pipeline):
    gates = normalize_list(pipeline.get("qualityGates"))
    if not gates:
        return f"# {pipeline['name']} Gate Plan\n\nNo quality gates configured.\n"
    body = "\n\n".join(
        f"## {gate.get('id', gate.get('name', 'gate'))}\n\n- Name: {gate.get('name', '')}\n- Trigger: {gate.get('trigger', '')}\n- Executor: {gate.get('executor', '')}\n- Enforcement: {gate.get('enforcement', '')}\n- Pass criteria: {gate.get('passCriteria', '')}"
        for gate in gates
    )
    return f"# {pipeline['name']} Gate Plan\n\nGates are blocking controls when enforcement=block.\n\n{body}\n"

def render_leader(pipeline, refs):
    agents = "\n".join(
        f"- @{agent.get('agentName')} ({agent.get('name', '')}): {agent.get('responsibility') or agent.get('description', '')}"
        for _, agent in all_agents(pipeline)
    ) or "- No configured agents."
    return f"""---
name: {pipeline['leaderAgentName']}
description: Coordinates the {pipeline['name']} AgentFlow pipeline from global compiled assets.
model: sonnet
tools: Read, Write, Edit, MultiEdit, Grep, Glob, Bash
---

You are the invoked Team Leader for the AgentFlow pipeline "{pipeline['name']}".

Use these global AgentFlow assets as source of truth:

- Startup command: /{refs['command_name']}
- Pipeline SOP: {refs['sop']}
- Delegation policy: {refs['delegation']}
- Gate plan: {refs['gates_md']}
- Machine-readable gate plan: {refs['gates_json']}
- Bootstrap skill: {refs['skill']}

Available roles:
{agents}

Structured pipeline definition:

```json
{json.dumps(pipeline, ensure_ascii=False, indent=2)}
```

Execution rules:
- Start by following the using-agentflow workflow.
- Treat the current Claude Code working directory as the project being worked on.
- Restate the user requirement, identify the current stage, then choose self / subagent / parallel subagents / agent team.
- Use full @agent names when delegating.
- Shared agents are referenced by name and must not be rewritten by this pipeline.
- Gates with enforcement=block are blocking controls.
- Before asking for approval, show produced artifacts and risks.
"""

def render_role(pipeline, stage, agent):
    watch = "\n".join(f"- {item}" for item in normalize_list(agent.get("watch"))) or "- none"
    produce = "\n".join(f"- {item}" for item in normalize_list(agent.get("produce"))) or "- none"
    return f"""---
name: {agent.get('agentName')}
description: {agent.get('description') or agent.get('responsibility') or agent.get('name')}
model: {agent.get('model', 'sonnet')}
tools: {', '.join(normalize_list(agent.get('tools')) or ['Read', 'Write', 'Edit', 'Grep', 'Glob'])}
---

You are {agent.get('name')} in the AgentFlow pipeline "{pipeline['name']}".

Stage: {stage.get('name')}

Responsibility:
{agent.get('responsibility') or 'No responsibility configured.'}

Watch:
{watch}

Produce:
{produce}

Operating rules:
- Stay within this role unless the Team Leader explicitly asks otherwise.
- Do not create an independent Agent Team.
- Gates are blocking execution controls, not reminders.
- Call out assumptions, risks, missing input, and produced artifacts.
"""

def render_skill(pipeline, refs):
    return f"""---
name: using-agentflow
description: Use when starting or executing any AgentFlow-managed pipeline. Loads the global SOP, delegation policy, quality gates, and role routing rules.
---

# Using AgentFlow

Pipeline: {pipeline['name']}
Startup command: /{refs['command_name']}

Before taking action:

1. Read the pipeline SOP from {refs['sop']}.
2. Read the delegation policy from {refs['delegation']}.
3. Read the gate plan from {refs['gates_md']}; use {refs['gates_json']} for structured data.
4. Treat the current Claude Code working directory as the project being worked on.
5. Identify the current stage and required artifacts.
6. Delegate with full @agent names when needed.
7. Stop at blocking gates and ask for the required decision.
"""

def render_wiki_skill(pipeline):
    kb = pipeline["knowledgeBase"]
    return f"""---
name: using-agentflow-wiki
description: Maintain the AgentFlow Knowledge Wiki for durable project memory.
---

# Using AgentFlow Wiki

Wiki path: {kb.get('path')}
Domain: {kb.get('domain')}
Write mode: {kb.get('writeMode')}

Read the wiki schema, index, and log before ingesting, querying, or updating. Preserve raw sources and propose broad updates before writing.
"""

def render_launch_prompt(pipeline, refs, requirement):
    return f"""@"{pipeline['leaderAgentName']} (agent)" 请以 single-leader 模式接管以下任务。

用户需求：
{requirement}

Startup anchor: /{refs['command_name']}
Working directory: current Claude Code working directory

Global AgentFlow assets:
- SOP: {refs['sop']}
- Delegation policy: {refs['delegation']}
- Gates: {refs['gates_md']}
- Gate JSON: {refs['gates_json']}
- Bootstrap skill: {refs['skill']}

Leader execution requirements:
1. 先加载并遵守 using-agentflow 规则。
2. 先判断任务复杂度，再选择 self / subagent / parallel subagents / agent team。
3. 门禁是阻断式控制，命中 block 级别门禁后必须先发起 GATE_PENDING。
4. 在请求用户 approve/reject/review/continue 之前，默认展示本阶段产出物。
"""

def render_command(pipeline, refs):
    return f"""---
description: Start the {pipeline['name']} AgentFlow pipeline through its global Team Leader.
argument-hint: [requirement]
---

{render_launch_prompt(pipeline, refs, "$ARGUMENTS")}
"""

def render_active_bootstrap(pipeline, refs):
    return f"""# Active AgentFlow Pipeline

Pipeline: {pipeline['name']}
Pipeline ID: {pipeline['id']}
Leader: @{pipeline['leaderAgentName']}
Manual command: /{refs['command_name']}

AgentFlow is installed globally. Treat the current Claude Code working directory as the project being worked on; do not assume AgentFlow assets live inside the project.

Read these global assets before executing non-trivial coding, planning, review, or documentation tasks:

1. {refs['sop']}
2. {refs['delegation']}
3. {refs['gates_md']}
4. {refs['gates_json']}
5. {refs['skill']}

Operating rules:

- Start by applying the active AgentFlow workflow unless the user explicitly asks to bypass AgentFlow.
- Restate the user requirement, identify the current stage, and choose self / subagent / parallel subagents / agent team according to the delegation policy.
- Use the configured Leader when task complexity crosses the delegation threshold.
- Apply blocking gates before writing, reviewing, releasing, or performing destructive actions.
- Shared agents are global references; do not rewrite shared agent files.
- Do not write AgentFlow configuration into the current project unless the user explicitly asks.
"""

def render_claude_memory_block(active_bootstrap_path, active_dir):
    return f"""# AgentFlow Global Bootstrap

Before starting any non-trivial coding, planning, review, or documentation task:

1. Check whether AgentFlow is installed by reading:
   {active_bootstrap_path}

2. If that file exists, follow it as the active global workflow policy.

3. Treat the current Claude Code working directory as the project being worked on. Do not assume AgentFlow assets live inside the project.

4. AgentFlow assets are user-global, normally under:
   {active_dir}
   {agentflow_home / 'compiled'}

5. If AgentFlow is not installed, continue normally.

Do not copy AgentFlow rules into project files unless the user explicitly asks."""

def merge_marker_block(current, block):
    start = "<!-- AGENTFLOW:START -->"
    end = "<!-- AGENTFLOW:END -->"
    wrapped = f"{start}\n{block.strip()}\n{end}"
    pattern = re.compile(re.escape(start) + r"[\s\S]*?" + re.escape(end))
    if pattern.search(current):
        return pattern.sub(wrapped, current).rstrip() + "\n"
    prefix = current.rstrip() + "\n\n" if current else ""
    return prefix + wrapped + "\n"

raw = fetch_json(dsl_url)
try:
    definition = json.loads(raw)
except Exception as exc:
    fail(f"invalid DSL JSON: {exc}")

pipeline, normalized_definition = selected_pipeline(definition)
pipeline_slug = slugify(pipeline["id"])
compiled_dir = agentflow_home / "compiled" / pipeline_slug
command_name = f"agentflow-{pipeline_slug}"
refs = {
    "command_name": command_name,
    "compiled": str(compiled_dir),
    "active": str(agentflow_home / "active"),
    "active_bootstrap": str(agentflow_home / "active" / "bootstrap.md"),
    "sop": str(compiled_dir / "sop.md"),
    "delegation": str(compiled_dir / "delegation-policy.md"),
    "gates_md": str(compiled_dir / "gates.md"),
    "gates_json": str(compiled_dir / "gates.json"),
    "skill": str(claude_dir / "skills" / "using-agentflow" / "SKILL.md"),
}
active_manifest = {
    "version": 1,
    "activePipelineId": pipeline["id"],
    "activePipelineName": pipeline["name"],
    "leaderAgentName": pipeline["leaderAgentName"],
    "startupCommand": f"/{command_name}",
    "bootstrapPath": refs["active_bootstrap"],
    "compiledDir": refs["compiled"],
    "definitionPath": str(agentflow_home / "definitions" / "agentflow.pipeline.json"),
    "pipelineDefinitionPath": str(agentflow_home / "definitions" / f"{pipeline_slug}.json"),
    "assets": {
        "sop": refs["sop"],
        "delegationPolicy": refs["delegation"],
        "gates": refs["gates_md"],
        "gatesJson": refs["gates_json"],
        "usingAgentFlowSkill": refs["skill"],
        "leaderAgent": str(claude_dir / "agents" / f"{pipeline['leaderAgentName']}.md"),
        "slashCommand": str(claude_dir / "commands" / f"{command_name}.md"),
    },
}
claude_memory_path = claude_dir / "CLAUDE.md"
current_claude_memory = claude_memory_path.read_text(encoding="utf-8") if claude_memory_path.exists() else ""

files = {
    agentflow_home / "definitions" / "agentflow.pipeline.json": json.dumps(normalized_definition, ensure_ascii=False, indent=2) + "\n",
    agentflow_home / "definitions" / f"{pipeline_slug}.json": json.dumps(normalized_definition, ensure_ascii=False, indent=2) + "\n",
    agentflow_home / "active" / "manifest.json": json.dumps(active_manifest, ensure_ascii=False, indent=2) + "\n",
    agentflow_home / "active" / "bootstrap.md": render_active_bootstrap(pipeline, refs),
    compiled_dir / "manifest.json": json.dumps({
        "version": 1,
        "pipelineId": pipeline["id"],
        "pipelineName": pipeline["name"],
        "leaderAgentName": pipeline["leaderAgentName"],
        "startupCommand": f"/{command_name}",
    }, ensure_ascii=False, indent=2) + "\n",
    compiled_dir / "definition.snapshot.json": json.dumps(normalized_definition, ensure_ascii=False, indent=2) + "\n",
    compiled_dir / "leader.md": render_leader(pipeline, refs),
    compiled_dir / "sop.md": render_sop(pipeline),
    compiled_dir / "delegation-policy.md": render_delegation(pipeline),
    compiled_dir / "gates.md": render_gates_md(pipeline),
    compiled_dir / "gates.json": json.dumps(gate_plan(pipeline), ensure_ascii=False, indent=2) + "\n",
    compiled_dir / "launch-prompt.md": render_launch_prompt(pipeline, refs, ""),
    claude_dir / "skills" / "using-agentflow" / "SKILL.md": render_skill(pipeline, refs),
    claude_dir / "agents" / f"{pipeline['leaderAgentName']}.md": render_leader(pipeline, refs),
    claude_dir / "commands" / f"{command_name}.md": render_command(pipeline, refs),
    claude_memory_path: merge_marker_block(
        current_claude_memory,
        render_claude_memory_block(agentflow_home / "active" / "bootstrap.md", agentflow_home / "active")
    ),
}

if pipeline["knowledgeBase"].get("enabled"):
    kb = pipeline["knowledgeBase"]
    files[compiled_dir / "wiki-policy.md"] = f"# {pipeline['name']} Knowledge Wiki Policy\n\n- Path: {kb.get('path')}\n- Domain: {kb.get('domain')}\n- Write mode: {kb.get('writeMode')}\n"
    files[compiled_dir / "wiki-ingest.prompt.md"] = f"# Knowledge Wiki Ingest Prompt\n\nUse {kb.get('path')} for durable AgentFlow knowledge. Preserve raw sources and update index/log when writing.\n"
    files[compiled_dir / "wiki-query.prompt.md"] = f"# Knowledge Wiki Query Prompt\n\nRead {kb.get('path')}/SCHEMA.md, index.md, and log.md before answering from the wiki.\n"
    files[claude_dir / "skills" / "using-agentflow-wiki" / "SKILL.md"] = render_wiki_skill(pipeline)

for stage, agent in all_agents(pipeline):
    if agent.get("source") == "shared":
        continue
    agent_name = agent.get("agentName")
    if agent_name:
        files[claude_dir / "agents" / f"{agent_name}.md"] = render_role(pipeline, stage, agent)

print(f"AgentFlow pipeline: {pipeline['name']} ({pipeline['id']})")
print(f"Startup command: /{command_name}")
print("Files:")
for path in sorted(files):
    print(f"  {'would write' if dry_run else 'write'} {path}")

if dry_run:
    raise SystemExit(0)

if not force:
    prompt = "\nContinue writing these global AgentFlow assets? [y/N] "
    try:
        answer = input(prompt)
    except EOFError:
        try:
            with open("/dev/tty", "r", encoding="utf-8") as tty:
                print(prompt, end="", file=sys.stderr)
                answer = tty.readline()
        except Exception:
            fail("confirmation requires a terminal; rerun with --force to install non-interactively")
    if answer.strip().lower() not in {"y", "yes"}:
        fail("cancelled", 130)

for path, content in files.items():
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(content)
    os.replace(tmp_name, path)

print(f"\nInstalled AgentFlow. Open Claude Code in any project and run: /{command_name} <your requirement>")
PY
