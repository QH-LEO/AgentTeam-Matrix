# AgentTeam-Matrix

基于 Agent Team 的研发生产流程平台，覆盖需求分析、技术方案、开发、测试全流程，支持人工审核门禁、动态 Agent/Skill 配置，并以 TDD 驱动交付质量。

## 当前项目空间
- `frontend/`：Vue 前端
- `backend/`：后端 API
- `orchestrator/`：终端编排与 tmux 协同
- `skills/`：Skill 注册与版本
- `configs/`：流程与角色配置
- `tests/`：测试代码
- `docs/`：文档沉淀
- `scripts/`：脚本工具

## 研发原则
- TDD 优先：先定义测试用例，再实现代码。
- 阶段门禁：每阶段必须人工审核后才能流转。
- 可追溯：所有变更需记录到 `变更点审查.md`。

## 下一步
- 初始化 `frontend/` 的 Vue 3 + TypeScript 工程。
- 初始化 `backend/` API 骨架与配置存储。
- 实现最小流水线编排与执行看板。

## 当前可运行前端原型
- 主入口：`frontend/index.html`（基于 `ui-state.js` 的轻量原型）
- 可视化演示：`frontend/test-runner.html`（Tailwind + 流程画布，内置示例数据，用于体验「流水线即图」）
- 本地启动：`./scripts/run-frontend.sh`，然后打开 `http://localhost:5173/index.html` 或 `http://localhost:5173/test-runner.html`
