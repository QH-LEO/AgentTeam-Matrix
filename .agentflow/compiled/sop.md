# 核心研发流程 SOP

核心研发流程的结构化研发 SOP。

## 1. 需求分析

### 澄清需求并形成 PRD

- Owner: @agentflow-product-manager
- Inputs: UserRequirement
- Outputs: PRD, AcceptanceCriteria, RiskRegister
- Gates: requirement-review

## 2. 技术方案

### 设计架构与接口契约

- Owner: @agentflow-architect
- Inputs: PRD, AcceptanceCriteria, RiskRegister
- Outputs: Architecture, ADR, APISpec
- Gates: architecture-review

## 3. 开发实现

### 按方案实现代码变更

- Owner: @agentflow-developer
- Inputs: Architecture, ADR, APISpec
- Outputs: CodeChange, DevNotes
- Gates: write-files

## 4. 测试验收

### 验证变更并形成测试报告

- Owner: @agentflow-tester
- Inputs: CodeChange, DevNotes
- Outputs: TestReport, DefectList
- Gates: completion-review

## Quality Gates

- requirement-review (human)：需求边界、验收标准和风险必须人工确认。
- architecture-review (human)：架构方案、接口契约和测试策略必须人工确认。
- write-files (human)：开始写入项目文件前需要确认改动边界。
- completion-review (human)：完成后必须回顾产物、测试和风险。
- destructive-command (human)：删除、重置、迁移等不可逆操作必须人工确认。
