# AgentFlow Runtime 与 LLM Wiki 组织说明

本文说明当前仓库里 AgentFlow 是如何组织研发流程编排、Skill 装配、门禁、策略和 LLM Wiki 的，以及每个关键文件的作用。

## 一句话结论

当前实现里，AgentFlow 的核心入口是：

```text
.agentflow/compiled/leader.md
```

它是 Leader Agent 的角色定义，也是编译后的组织上下文入口。Agent 并不是天然知道流程、Skill、门禁和策略，而是通过启动 prompt 拉起 Leader，再由 Leader 的角色定义、using-agentflow skill、SOP 和 delegation policy 获得这些约束。

## Agent 如何知道这些约束

当前链路是：

```text
.agentflow/compiled/launch-prompt.md
  -> @agentflow-core-rd-team-leader
  -> .agentflow/compiled/leader.md
  -> .claude/skills/using-agentflow/SKILL.md
  -> .agentflow/compiled/sop.md
  -> .agentflow/compiled/delegation-policy.md
  -> .agentflow/wiki/AGENT_ORIENTATION.md
```

各节点职责：

- `launch-prompt.md`：启动入口，明确要求调用 `@agentflow-core-rd-team-leader`。
- `leader.md`：核心上下文，告诉 Leader 当前 pipeline、可用角色、结构化流水线定义、门禁和策略。
- `using-agentflow/SKILL.md`：执行规程，要求先读 SOP、delegation policy 和 Wiki orientation。
- `sop.md`：阶段、动作、输入、输出、门禁的人类可读流程。
- `delegation-policy.md`：self / subagent / parallel subagents / agent team 的选择策略。
- `AGENT_ORIENTATION.md`：LLM Wiki 的读取和维护入口。

## 当前实现的核心入口

### `.agentflow/compiled/leader.md`

Leader Agent 的角色定义文件。

它负责把分散的组织资产串起来，包括：

- Leader 名称和模型配置。
- 当前 pipeline 名称和项目路径。
- 编译资产索引：SOP、delegation policy、using-agentflow skill、Wiki orientation。
- 可用 Agent 角色列表。
- 结构化 pipeline JSON，包括阶段、Agent、Skill、quality gates、delegation policy。
- 执行规则：如何委托、如何处理 gate、如何避免越权。

这是当前实现里最接近“总入口”的文件。

### `.agentflow/compiled/launch-prompt.md`

启动 prompt。

它负责：

- 通过 `@agentflow-core-rd-team-leader` 拉起 Leader。
- 告诉 Leader 当前项目路径和启动模式。
- 要求先加载并遵守 `using-agentflow`。
- 附带流水线摘要、角色摘要、阶段摘要和执行要求。

它不是规则源头，而是把 Agent 带到 Leader 入口。

### `.claude/skills/using-agentflow/SKILL.md`

AgentFlow 的 bootstrap skill。

它负责规定 AgentFlow 运行时动作顺序：

- 读取 `.agentflow/compiled/sop.md`。
- 读取 `.agentflow/compiled/delegation-policy.md`。
- 读取 `.agentflow/wiki/AGENT_ORIENTATION.md`。
- 识别当前阶段和产物。
- 判断任务复杂度。
- 选择 self / subagent / parallel subagents / agent team / ask human。
- 不跳过质量门禁和人工确认点。

它是执行规程，不是完整流程数据源。

## 编译产物

### `.agentflow/compiled/sop.md`

结构化研发 SOP 的人类可读版本。

它包含：

- 阶段顺序。
- 每个阶段的 action。
- action owner。
- 输入和输出。
- action 绑定的 gate。
- Quality Gates 摘要。

Agent 通过它理解“这次流程怎么走”。

### `.agentflow/compiled/delegation-policy.md`

委托策略的人类可读版本。

它包含：

- 默认模式：如 `self_first`。
- 是否允许 subagents。
- 是否允许 agent team。
- 是否允许递归委托。
- 最大深度和最大并行数。
- self / subagent / team / recursive 的选择规则。

Agent 通过它理解“什么情况下自己做，什么情况下委托”。

### `.agentflow/manifest.json`

编译资产清单。

它记录：

- schema version。
- pipeline id/name。
- leader agent name。
- 支持的 launch modes。
- 当前编译出的资产路径。

它更像索引和 manifest，不承载完整规则。

## 源配置

### `configs/agentflow.pipeline.json`

当前可编辑的 pipeline 配置源。

它是前端/编排器维护的结构化 DSL，包含：

- pipeline 基本信息。
- leaderAgentName。
- projectPath / claudeDir / sharedAgentsDir。
- delegationPolicy。
- qualityGates。
- knowledgeBase。
- stages。
- agents。
- skills。
- actions。

从产品设计上看，它是源配置；从 Agent 运行链路看，Agent 通常不是直接从它启动，而是先进入 `leader.md` 和编译产物。

## LLM Wiki 组织

本次新增的 `.agentflow/wiki` 是长期知识库，不替代 `leader.md` 的 runtime 入口。

Wiki 的作用是：

- 沉淀长期项目知识。
- 让 Agent 查询项目背景时优先读稳定页面。
- 追溯来源。
- 记录冲突和开放问题。
- 支持增量维护，而不是每次重读全部 raw 文档。

### `.agentflow/wiki/AGENT_ORIENTATION.md`

Wiki 使用入口。

它告诉 Agent 使用 Wiki 前先读：

- `.agentflow/wiki/SCHEMA.md`
- `.agentflow/wiki/index.md`
- `.agentflow/wiki/log.md`

它只负责 Wiki orientation，不负责研发流程编排。

### `.agentflow/wiki/SCHEMA.md`

Wiki 规则文件。

它定义：

- raw / wiki / schema 三层结构。
- 目录职责。
- frontmatter 格式。
- source 规则。
- 链接规则。
- tag taxonomy。
- 更新策略。

### `.agentflow/wiki/index.md`

Wiki 导航入口。

它列出：

- overview 页面。
- entities。
- concepts。
- designs。
- decisions。
- queries。
- reviews。
- contradictions。
- raw source notes。

Agent 查询知识库时应该先从这里走，而不是直接全文搜索 raw。

### `.agentflow/wiki/log.md`

Wiki 维护日志。

它记录：

- 什么时候初始化。
- 做过哪些 ingest / compile / query / lint / update。
- 本次新增了哪些结构和页面。

### `.agentflow/wiki/raw/`

原始资料层。

当前包括：

- `requirements/`
- `designs/`
- `reviews/`
- `code-notes/`
- `meetings/`
- `cooper/`
- `db/`
- `snapshots/`

Raw 默认不可变。它保存来源摘要和事实摘录，不直接作为稳定结论页。

### `.agentflow/wiki/schema/`

Wiki 维护规则层。

文件作用：

- `ingest-rules.md`：如何把来源进入 raw/source catalog。
- `compile-rules.md`：如何把 raw/source 编译成稳定页面。
- `lint-rules.md`：如何检查 frontmatter、链接、source、index、冲突。
- `wiki-maintenance-rules.md`：Agent 维护 Wiki 的通用规则。
- `page-templates/`：页面模板，包括 canonical page、raw note、contradiction。

### `.agentflow/wiki/entities/`

实体页。

用于描述项目中长期存在的对象，例如：

- AgentFlow Platform。
- Pipeline Studio。
- AgentFlow Orchestrator。
- Knowledge Wiki。

### `.agentflow/wiki/concepts/`

概念页。

用于描述跨页面复用的抽象概念，例如：

- LLM Wiki Pattern。
- Agent Organization Compiler。
- Human Gate。

### `.agentflow/wiki/designs/`

设计页。

用于描述架构、产品、前端、编译器等设计。

当前包括：

- Knowledge Wiki Architecture。
- Pipeline Studio Frontend。
- Compiler Knowledge Wiki Seed。

### `.agentflow/wiki/decisions/`

决策页。

用于记录重要取舍和原因，例如：

- 使用 LLM Wiki 作为长期上下文。
- 先落目录和规则，自动化后置。

### `.agentflow/wiki/queries/`

可复用问答页。

用于保存以后可能重复问的问题和综合回答，例如：

- How To Query This Wiki。

### `.agentflow/wiki/reviews/`

评审页。

用于记录审查、验证、风险和后续动作。

### `.agentflow/wiki/sources/`

来源目录。

`source-catalog.md` 维护 source id 到真实文件/来源的映射。稳定 Wiki 页面里的 `sources:` 应引用这里登记过的 source id。

### `.agentflow/wiki/contradictions/`

冲突记录。

当用户说法、文档、代码事实之间不一致时，不直接覆盖旧结论，而是记录冲突、两边 claim、当前处理方式和待确认问题。

### `.agentflow/wiki/open-questions/`

开放问题。

用于记录当前没有足够信息判断的问题。

## 根目录 Agent 指令

### `AGENTS.md`

给 Codex/通用 Agent 的仓库级指针。

当前只指向：

```text
.agentflow/wiki/AGENT_ORIENTATION.md
```

它是 Wiki 使用入口的提示，不是 AgentFlow runtime 总入口。

### `CLAUDE.md`

给 Claude Code 的仓库级指针。

当前也只指向：

```text
.agentflow/wiki/AGENT_ORIENTATION.md
```

它同样不是流程编排的规则源头。

## 当前组织方式的边界

当前实现的优点：

- `leader.md` 聚合了流程、角色、Skill、门禁、策略，是清晰的 Leader 入口。
- `sop.md` 和 `delegation-policy.md` 把复杂上下文拆成可读材料。
- `using-agentflow` 规定了执行顺序。
- Wiki 提供了长期知识层。

当前实现的边界：

- 随便一个 Agent 进入仓库时，不一定会自动进入 `leader.md`。
- 只有通过 `launch-prompt.md` 或显式 `@agentflow-core-rd-team-leader` 启动时，当前约束链路最完整。
- `configs/agentflow.pipeline.json` 和 `.agentflow/compiled/*` 的一致性依赖重新编译。
- Wiki orientation 是知识库入口，不等同于研发流程 runtime 入口。

## 读文件顺序建议

如果是理解当前 AgentFlow runtime：

1. `.agentflow/compiled/leader.md`
2. `.agentflow/compiled/launch-prompt.md`
3. `.claude/skills/using-agentflow/SKILL.md`
4. `.agentflow/compiled/sop.md`
5. `.agentflow/compiled/delegation-policy.md`
6. `configs/agentflow.pipeline.json`

如果是理解长期项目知识：

1. `.agentflow/wiki/AGENT_ORIENTATION.md`
2. `.agentflow/wiki/SCHEMA.md`
3. `.agentflow/wiki/index.md`
4. `.agentflow/wiki/log.md`
5. `index.md` 指向的相关稳定页面

