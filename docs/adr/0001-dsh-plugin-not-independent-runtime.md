# ADR-0001: DSH plugin, not an independent runtime

**状态**: Accepted
**日期**: 2026-08-25

## 背景

调研中出现过三条路线：独立 DevLoop Runtime、以 Claude Code 为调度核心、以 Codex 为 Control Plane。DeepSeek Harness（DSH）已经把模型、工具、Skill、Session、Sandbox、Storage、Loop、Scheduling、Subagent、UI、Headless / ACP 做成可替换插件，且官方明确可以不改 Harness 源码进行扩展。

## 决策

DevLoop 是 **DeepSeek Harness 上的工程工作流插件**（npm 包名 `dsh-devloop`），不是另一个 Agent Harness。

职责切分：

- DeepSeek 团队维护 Harness（Agent Runtime）
- 本仓库维护 Engineering Workflow（Goal / Task 状态机、分层路由、Review / Merge 策略、预算熔断、进度）

## 理由

- 个人开发力量不应再造 session、subagent、scheduler、UI、storage
- DSH 是 MIT、插件化、有 headless CLI，正好覆盖 24×7 tick 所需的执行原语
- 独立 Runtime 短期更「干净」，但会重复 60–80% 的底层，并在 DSH 稳定后被迫迁移

## 后果

**正面**：
- 跟随上游升级，只维护一层薄 adapter
- 可直接使用 DSH 已有的多模型 provider 与 headless 执行

**负面/权衡**：
- DSH 仍是 Developer Preview，Plugin API 可能 breaking
- 必须把耦合限制在 `cordis` 插件面与官方 bundle 机制，避免深入 Harness 内部
