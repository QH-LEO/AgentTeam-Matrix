# AgentFlow Knowledge Wiki 产品方案

## 定位

AgentFlow Knowledge Wiki 是每条流水线的项目知识层。它不替代流程编排，也不接入当前重构中的门禁系统；它先负责让 Agent 在执行流程时有长期上下文，并把有复用价值的需求、方案、决策、评审和问答沉淀为 Markdown。

一句话：

> 流程编排解决“这次怎么跑”，Knowledge Wiki 解决“下次别从零开始”。

## MVP 范围

### 1. Pipeline 级配置

新增 `knowledgeBase`：

```json
{
  "enabled": true,
  "path": ".agentflow/wiki",
  "domain": "AgentFlow 项目研发知识库",
  "autoOrient": true,
  "writeMode": "proposal_first",
  "rawImmutable": true
}
```

写入模式：

- `proposal_first`：默认。阶段边界或有价值产物出现时，Agent 先提出 Wiki 更新建议，用户确认后再写。
- `readonly`：只读取 Wiki 做上下文，不主动写。
- `auto_write`：允许 Agent 自动写入，适合成熟后的团队配置。

### 2. 编译产物

启用后生成：

```text
.agentflow/wiki/SCHEMA.md
.agentflow/wiki/index.md
.agentflow/wiki/log.md
.agentflow/wiki/raw/requirements/.gitkeep
.agentflow/wiki/raw/designs/.gitkeep
.agentflow/wiki/raw/reviews/.gitkeep
.agentflow/wiki/raw/external/.gitkeep
.agentflow/wiki/entities/.gitkeep
.agentflow/wiki/concepts/.gitkeep
.agentflow/wiki/decisions/.gitkeep
.agentflow/wiki/comparisons/.gitkeep
.agentflow/wiki/queries/.gitkeep
.agentflow/compiled/wiki-policy.md
.agentflow/compiled/wiki-ingest.prompt.md
.agentflow/compiled/wiki-query.prompt.md
.claude/skills/using-agentflow-wiki/SKILL.md
```

`SCHEMA.md`、`index.md`、`log.md` 是 seed-only 文件：首次生成后不覆盖用户和 Agent 后续维护的内容。

### 3. 运行时行为

`using-agentflow` 启动规程新增 Knowledge Wiki orientation：

1. 读取 `.agentflow/wiki/SCHEMA.md`
2. 读取 `.agentflow/wiki/index.md`
3. 读取 `.agentflow/wiki/log.md` 最近记录
4. 再判断当前阶段、Agent 分派和产物路径

阶段结束时，默认只输出 `Knowledge Wiki Update Proposal`，不自动写：

```text
Knowledge Wiki Update Proposal
- 建议新增/更新页面
- 来源 artifact 或 raw source
- 为什么值得沉淀
- 预计 touched files
- 是否需要用户确认
```

## 非目标

- 暂不做 Wiki 门禁。
- 暂不做向量数据库。
- 暂不做复杂搜索后端。
- 暂不自动覆盖已有 Wiki 页面。

## 后续路线

1. Wiki 页面浏览和 Markdown 预览。
2. Wiki diff 和用户确认写入。
3. Wiki lint：broken wikilinks、frontmatter、index 缺失、raw source 引用缺失。
4. Wiki search：全文搜索或 MCP/Obsidian 适配。
5. 跨流水线共享组织级 Knowledge Wiki。
