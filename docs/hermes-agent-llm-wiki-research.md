# Hermes Agent LLM Wiki 调研

调研日期：2026-04-21

## 1. 结论摘要

Hermes Agent 的 `llm-wiki` 不是传统意义上的在线 Wiki 产品，而是一个内置 research skill：让 Agent 把资料持续编译成互链 Markdown 知识库。它的核心价值是把“每次问答时临时检索和拼装知识”的 RAG 模式，换成“先把知识整理、交叉引用、记录矛盾，再持续维护”的编译型知识库模式。

对 AgentFlow 的启发很直接：如果我们要做研发流水线里的“长期上下文层”，不要只保存运行日志或聊天摘要，而应把需求、方案、ADR、评审、竞品、API 约束沉淀成可 lint、可索引、可增量更新的 Markdown 知识库。AgentFlow 的 `stages / agents / skills / gates` 可以把 Wiki 的初始化、摄取、查询、健康检查变成流水线动作。

## 2. 背景：Hermes Agent 是什么

Hermes Agent 是 Nous Research 开源的自改进 Agent 框架。官方 README 将它定位为带学习闭环的 Agent：支持跨会话记忆、技能创建与自我改进、历史会话搜索、Telegram/Discord/Slack/CLI 等多入口，以及可切换任意 LLM Provider。

关键能力：

- 多入口：CLI、消息网关、API、ACP、批处理等。
- 多模型：Nous Portal、OpenRouter、OpenAI、Anthropic、Gemini、Qwen、DeepSeek、自托管 OpenAI-compatible endpoint 等。
- 长期记忆：`MEMORY.md`、`USER.md`、SQLite/FTS5 会话搜索和外部记忆 Provider。
- Skill 系统：`~/.hermes/skills/` 是主目录；Skill 按需加载，遵循 progressive disclosure，支持 slash command。
- 工具与执行环境：文件、终端、Web、浏览器、MCP、子 Agent 委托，终端后端支持 local、Docker、SSH、Daytona、Singularity、Modal。

## 3. LLM Wiki 模式

`llm-wiki` 源自 Andrej Karpathy 在 2026-04-04 发布的 LLM Wiki idea。它强调三层结构：

| 层 | 职责 | 所有权 |
| --- | --- | --- |
| Raw sources | 原始文章、论文、访谈、转录、图片、数据等，不可变 | 人类/系统 |
| Wiki pages | Entity、Concept、Comparison、Query 等 Markdown 页面 | Agent 维护 |
| Schema | 约束目录、命名、frontmatter、标签、更新策略、lint 规则 | 人类与 Agent 共演进 |

这个模式的关键不是“把文档扔给向量库”，而是让 Agent 在摄取每个来源时更新已有知识结构：补充页面、建立 `[[wikilinks]]`、更新 index、记录 log、标记新旧来源之间的冲突。长期看，它更像一个由 Agent 维护的“知识编译产物”。

## 4. Hermes `llm-wiki` Skill 机制

官方 skill 文件路径：

`skills/research/llm-wiki/SKILL.md`

当前 skill 元信息显示：

- `name: llm-wiki`
- `version: 2.0.0`
- category: `research`
- tags: `wiki`, `knowledge-base`, `research`, `notes`, `markdown`, `rag-alternative`
- 默认 Wiki 路径：`WIKI_PATH` 环境变量；未设置时是 `~/wiki`

### 4.1 目录结构

Hermes skill 推荐的目录结构：

```text
wiki/
├── SCHEMA.md
├── index.md
├── log.md
├── raw/
│   ├── articles/
│   ├── papers/
│   ├── transcripts/
│   └── assets/
├── entities/
├── concepts/
├── comparisons/
└── queries/
```

其中：

- `SCHEMA.md` 是 Agent 行为约束，定义领域、命名、标签、页面阈值、更新策略。
- `index.md` 是内容目录，帮助 Agent 和人快速定位页面。
- `log.md` 是追加式操作日志，记录 ingest、query、lint、create、archive、delete。
- `raw/` 是不可变来源层，Agent 应读取但不修改。
- `entities/`、`concepts/`、`comparisons/`、`queries/` 是 Agent 维护的知识层。

### 4.2 每次会话必须先 orient

Hermes 的 skill 明确要求：对已有 Wiki 操作前，先读取：

1. `SCHEMA.md`
2. `index.md`
3. `log.md` 最近记录

这能减少重复建页、漏掉已有交叉引用、违反 schema、重复已经完成的整理工作。这个“先 orient 再行动”的习惯很适合移植到 AgentFlow 的 Leader/Skill 启动规则。

### 4.3 三个核心操作

| 操作 | 输入 | 行为 | 输出 |
| --- | --- | --- | --- |
| Ingest | URL、PDF、粘贴文本、本地文件 | 保存 raw source，提取要点，检查已有页面，创建/更新实体和概念页，补 wikilink，更新 index/log | 多个 Markdown 页面变更 |
| Query | 用户问题 | 先读 index，再读相关页面，必要时搜索全 Wiki，综合回答 | 带来源页面引用的回答；有价值则归档为 query/comparison |
| Lint | 用户要求审计/健康检查 | 扫 orphan page、broken wikilink、frontmatter、tag taxonomy、stale content、矛盾、页面过长、log 轮转 | 分严重级别的问题报告 |

### 4.4 页面规则

重要规则：

- 新页面必须有 YAML frontmatter。
- tag 必须来自 `SCHEMA.md` taxonomy。
- 每个页面至少有若干 outbound wikilinks。
- 新页面必须写入 `index.md`。
- 每次动作必须追加 `log.md`。
- 内容冲突不能静默覆盖，需要保留不同说法、标注日期和来源。
- 页面超过约 200 行时拆分。
- 一次 ingest 如果会触碰 10 个以上页面，应先和用户确认范围。

## 5. 与传统 RAG 的差异

| 维度 | 传统 RAG | LLM Wiki |
| --- | --- | --- |
| 知识处理时机 | 查询时临时检索 chunk | 摄取时整理成结构化知识 |
| 长期积累 | 弱，主要依赖原始文档和向量索引 | 强，页面、交叉引用、矛盾、综合结论持续累积 |
| 可读性 | 对人通常不可读，向量索引是黑盒 | Markdown 可读，可用 Obsidian/VS Code/Git 查看 |
| 可维护性 | 依赖索引刷新和 chunk 策略 | 依赖 schema、index、log、lint |
| 风险 | 检索遗漏、上下文拼装不稳定 | Agent 写错、过度总结、source 与 wiki 不一致 |
| 最佳场景 | 大规模语料问答、企业检索 | 中小规模深度研究、长期项目知识沉淀、个人/团队第二大脑 |

更准确的判断是：LLM Wiki 不是 RAG 的完全替代。Wiki 在中小规模时可以只靠 `index.md` 和全文搜索；规模变大后，仍可能接入 BM25、向量检索或 qmd/MCP，但检索对象可以从 raw chunks 转向“已编译知识页 + 原始来源”。

## 6. 对 AgentFlow 的产品启发

### 6.1 将 Wiki 作为流水线长期上下文

AgentFlow 可以生成 `.agentflow/wiki/` 或项目级 `docs/wiki/`：

```text
.agentflow/wiki/
├── SCHEMA.md
├── index.md
├── log.md
├── raw/
│   ├── requirements/
│   ├── designs/
│   ├── reviews/
│   └── external/
├── entities/
├── concepts/
├── decisions/
├── comparisons/
└── queries/
```

建议把研发流水线里的高价值产物映射为页面：

- `requirements/`：用户需求、PRD、验收标准、约束。
- `designs/`：技术方案、接口契约、架构图。
- `decisions/`：ADR、关键取舍、废弃方案。
- `reviews/`：评审意见、缺陷、门禁结论。
- `entities/`：系统、模块、服务、角色、外部依赖。
- `concepts/`：领域概念、协议、设计原则。
- `comparisons/`：方案对比、竞品对比、框架对比。

### 6.2 将 Wiki 操作编译成 Skill/Gate

AgentFlow DSL 可考虑新增动作类型：

```json
{
  "type": "wiki.ingest",
  "source": "artifact:technical-design",
  "wikiPath": ".agentflow/wiki",
  "owner": "agentflow-architect",
  "outputs": ["wiki-pages", "wiki-log-entry"]
}
```

```json
{
  "type": "wiki.lint",
  "wikiPath": ".agentflow/wiki",
  "gate": "before_human_review",
  "failOn": ["broken_links", "missing_index", "contradictions"]
}
```

### 6.3 在 `using-agentflow` Skill 中加入 orient 规则

Leader 启动时可以固定执行：

1. 读取 `.agentflow/compiled/definition.snapshot.json`
2. 读取 `.agentflow/wiki/SCHEMA.md`
3. 读取 `.agentflow/wiki/index.md`
4. 读取 `.agentflow/wiki/log.md` 最近 N 条
5. 判断本次需求是更新已有页面、创建新页面、还是仅查询已有知识

这能把 AgentFlow 从“每轮重新理解项目”推进到“沿着项目知识库连续工作”。

## 7. 风险和防护

| 风险 | 表现 | 建议 |
| --- | --- | --- |
| Raw source 被误改 | Agent 覆盖原始论文/需求/访谈 | `raw/` 只读；写入前 diff；必要时 chmod 或 git hook 防护 |
| Wiki 变成总结垃圾堆 | 页面太多、重复、无链接 | 强制 page threshold、index 更新、orphan lint |
| Schema 漂移 | 新旧页面 frontmatter 不一致 | lint 检查当前 `SCHEMA.md` 与页面格式 |
| 过度压缩导致失真 | Wiki 结论替代原文 | 每条事实保留来源；重大结论回链 raw source |
| Tag 失控 | 同义 tag 泛滥 | tag 必须先加入 taxonomy |
| 大规模 ingest 误伤 | 一次改动十几个页面 | 超过阈值要求 human gate |
| Agent 幻觉引用 | 引用不存在的页面或来源 | broken link lint + source existence check |

## 8. 推荐落地路线

### MVP

1. 新增 `.agentflow/wiki` 模板生成：`SCHEMA.md`、`index.md`、`log.md`、目录结构。
2. `using-agentflow` Skill 增加 Wiki orientation。
3. 编译器生成 `wiki-ingest.prompt.md` 和 `wiki-lint.prompt.md`。
4. 前端 Compiler Preview 展示 Wiki 产物预览。

### 第二阶段

1. 每个阶段产物进入 human gate 前自动触发 `wiki.ingest`。
2. 在阶段切换前执行 `wiki.lint`，阻断 broken links、missing index、无 source 的断言。
3. 支持按 pipeline/stage/agent 过滤 Wiki 页面。
4. 在 Run Console 中展示本次 Wiki touched files。

### 第三阶段

1. 为 Wiki 增加全文搜索或 qmd/MCP 适配。
2. 支持 Obsidian vault 同步。
3. 支持跨项目共享 Wiki：组织级概念库 + 项目级执行库。
4. 将 Wiki 查询结果作为后续 Agent 分派的上下文输入。

## 9. 可直接采用的 AgentFlow Wiki Schema 片段

```markdown
# AgentFlow Wiki Schema

## Domain
This wiki tracks product requirements, architecture decisions, implementation constraints, review findings, and operational knowledge for an AgentFlow-managed software project.

## Conventions
- File names use lowercase kebab-case.
- Every wiki page starts with YAML frontmatter.
- Every page must link to at least two related pages when possible.
- Every new or updated page must be listed in index.md.
- Every action must append to log.md.
- Raw sources under raw/ are immutable.
- Contradictions must preserve both claims with dates and sources.

## Page Types
- entity: systems, modules, APIs, roles, external dependencies
- concept: domain terms, design principles, protocols
- decision: ADRs and irreversible trade-offs
- comparison: competing options or frameworks
- query: substantial answers worth preserving
- review: gate results, risks, defects, follow-ups

## Tag Taxonomy
- product: requirement, user-story, acceptance, scope
- architecture: adr, interface, dependency, constraint
- engineering: implementation, testing, refactor, migration
- operations: release, incident, observability, security
- workflow: stage, gate, agent, skill, delegation
```

## 10. 资料来源

- [Hermes Agent GitHub README](https://github.com/NousResearch/hermes-agent)
- [Hermes Agent official docs: Skills System](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)
- [Hermes Agent official docs: Persistent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- [Hermes Agent official docs: AI Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers/)
- [Hermes Agent official docs: Architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture)
- [Hermes `llm-wiki` SKILL.md](https://github.com/NousResearch/hermes-agent/blob/main/skills/research/llm-wiki/SKILL.md)
- [PR #5100: add Karpathy's llm-wiki skill](https://github.com/NousResearch/hermes-agent/pull/5100)
- [Andrej Karpathy: LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
