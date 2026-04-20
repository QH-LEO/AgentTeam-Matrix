# 核心研发流程 Delegation Policy

- Default mode: self_first
- Allow subagents: yes
- Allow agent team: no
- Allow recursive delegation: yes
- Max depth: 2
- Max parallel agents: 4
- Human confirmations: destructive-command, deployment, requirement-review, architecture-review

## Decision Rules

### Self
任务小、路径清楚、上下文足够、单一产物时由当前 Agent 自己完成。

### Sub Agent
子任务边界清楚、适合并行、需要隔离上下文或专业审查时创建 Sub Agent。

### Agent Team
任务跨多个阶段/角色/产物，需要 Team Leader 拆解、调度、验收时启动 Agent Team。

### Recursive Delegation
子任务自身变成复杂项目，且父 Agent 能验收结果时，允许受控递归委托。

## Runtime Constraints

- Use self for low-risk, bounded, quickly verifiable work.
- Use subagents for isolated research, review, or implementation tasks with clear inputs and outputs.
- Use parallel subagents only when write scopes do not conflict.
- Use agent team for cross-role product/design/development/testing collaboration.
- Claude Code agent teams do not support nested teams; all recursive delegation must be coordinated by the Team Leader.
