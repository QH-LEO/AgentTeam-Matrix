# AgentFlow Shell 安装指南

AgentFlow 可以通过一个 shell 脚本把 DSL 安装成本机全局 Claude 配置。用户不需要下载 AgentFlow 平台工程，也不需要把配置写进当前项目目录。

## 一条命令安装

```bash
curl -fsSL <install-sh-url> | bash
```

发布脚本前，把 `scripts/install-agentflow.sh` 顶部的 `DEFAULT_DSL_URL="__AGENTFLOW_DSL_URL__"` 替换成 DSL 文件服务器链接。也可以在测试或灰度时覆盖 DSL URL：

```bash
curl -fsSL <install-sh-url> | bash -s -- <dsl-url>
AGENTFLOW_DSL_URL=<dsl-url> bash scripts/install-agentflow.sh
```

安装完成后，脚本会输出启动命令，例如：

```text
/agentflow-p1 <your requirement>
```

安装完成后，在任意工程目录打开 Claude Code 并正常输入需求即可。脚本会向 `~/.claude/CLAUDE.md` 写入一个带 marker 的 AgentFlow bootstrap block；Claude Code 会通过这个用户级记忆文件读取 `~/.agentflow/active/bootstrap.md`，让 active pipeline 默认无感生效。

上面的 slash command 是辅助入口，适合手动触发或排查。它会显式调用全局 Leader agent，并把 `~/.agentflow/compiled/<pipelineId>/` 下的 SOP、委托策略、门禁计划和启动上下文交给 Leader。

Claude Code 的自定义 slash command 是 Markdown 文件；AgentFlow 会把启动锚点写到用户级 `~/.claude/commands/`，因此不依赖某个项目目录。参考：[Claude Code slash commands](https://docs.claude.com/en/docs/claude-code/slash-commands)。

## DSL URL

脚本内置的 `DEFAULT_DSL_URL` 应该返回 AgentFlow DSL JSON，支持两种形态：

- `{"pipeline": {...}}`
- `{"pipelines": [...], "selectedPipelineId": "..."}`

脚本也支持传本地文件路径，便于测试：

```bash
scripts/install-agentflow.sh --dry-run ./configs/agentflow.pipeline.json
```

## 写入路径

默认写入：

- `~/.agentflow/definitions/<pipelineId>.json`
- `~/.agentflow/definitions/agentflow.pipeline.json`
- `~/.agentflow/active/manifest.json`
- `~/.agentflow/active/bootstrap.md`
- `~/.agentflow/compiled/<pipelineId>/manifest.json`
- `~/.agentflow/compiled/<pipelineId>/definition.snapshot.json`
- `~/.agentflow/compiled/<pipelineId>/leader.md`
- `~/.agentflow/compiled/<pipelineId>/sop.md`
- `~/.agentflow/compiled/<pipelineId>/delegation-policy.md`
- `~/.agentflow/compiled/<pipelineId>/gates.md`
- `~/.agentflow/compiled/<pipelineId>/gates.json`
- `~/.agentflow/compiled/<pipelineId>/launch-prompt.md`
- `~/.agentflow/compiled/<pipelineId>/wiki-*.md`，仅在 Knowledge Wiki 启用时生成
- `~/.claude/agents/<leaderAgentName>.md`
- `~/.claude/agents/<managedAgentName>.md`，仅为非 shared Agent 生成
- `~/.claude/skills/using-agentflow/SKILL.md`
- `~/.claude/skills/using-agentflow-wiki/SKILL.md`，仅在 Knowledge Wiki 启用时生成
- `~/.claude/commands/agentflow-<pipelineId>.md`
- `~/.claude/CLAUDE.md`，通过 `<!-- AGENTFLOW:START -->` / `<!-- AGENTFLOW:END -->` 安全更新，不覆盖用户原有内容

脚本不会写当前工作目录，也不会创建项目级 `.agentflow/wiki` seed。

## 参数

```bash
scripts/install-agentflow.sh --dry-run <dsl-url>
```

只打印将写入的文件，不改动本机配置。

```bash
scripts/install-agentflow.sh --force <dsl-url>
```

跳过确认提示，适合 CI、MDM 或复制粘贴的一条命令。

```bash
scripts/install-agentflow.sh --claude-dir /tmp/test-claude <dsl-url>
```

覆盖 Claude 配置根目录。默认是 `~/.claude`，也可以通过 `AGENTFLOW_CLAUDE_DIR` 设置。

```bash
AGENTFLOW_HOME=/tmp/test-agentflow scripts/install-agentflow.sh <dsl-url>
```

覆盖 AgentFlow 安装根。默认是 `~/.agentflow`。

## 卸载

删除对应 pipeline 的全局资产：

```bash
rm -rf ~/.agentflow/compiled/<pipelineId>
rm -f ~/.agentflow/definitions/<pipelineId>.json
rm -rf ~/.agentflow/active
rm -f ~/.claude/commands/agentflow-<pipelineId>.md
rm -f ~/.claude/agents/<leaderAgentName>.md
```

如果该 pipeline 生成了托管 Agent，也删除对应的 `~/.claude/agents/<managedAgentName>.md`。如果没有其他 AgentFlow pipeline 依赖这些 Skill，再删除：

```bash
rm -rf ~/.claude/skills/using-agentflow
rm -rf ~/.claude/skills/using-agentflow-wiki
```

最后从 `~/.claude/CLAUDE.md` 删除 `<!-- AGENTFLOW:START -->` 到 `<!-- AGENTFLOW:END -->` 之间的 block。

## 运行模型

AgentFlow 配置是全局生效的。安装后，用户可以在任何工程目录启动 Claude Code 并直接描述需求；当前工程由 Claude Code 的工作目录决定，不写入 DSL，也不参与安装路径解析。`/agentflow-<pipelineId>` 只作为手动启动或调试入口保留。
