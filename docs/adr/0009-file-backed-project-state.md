# ADR-0009: File-backed project state for 0.1

**状态**: Accepted
**日期**: 2026-08-25

## 背景

调度状态可以放数据库、DSH session event log、或项目内文件。用户现有工作流已经以 Markdown 计划文件为中心。

## 决策

0.1 不上数据库。目标仓库内使用：

```text
.devloop/
  GOAL.md
  PLAN.md
  TASKS.json
  STATE.json
  PROGRESS.md
  DECISIONS.md
  runs/
  logs/
```

`STATE.json` 是状态机的权威数据；Markdown 给人看。GOAL 只允许用户或 T3 Supervisor 修改，Worker 只读。

出现跨仓库、大量并行、历史查询、正式 Web dashboard 再考虑 SQLite event log。DSH 自己的 session 仍用于单次 Agent 执行的 trace / replay，不替代项目级 Goal / Task 队列。

## 理由

- 与「记忆在文件和 git，不在 LLM context」一致
- 重启可恢复，diff 可审查
- 避免 0.1 引入运维面

## 后果

**正面**：
- 实现与测试都轻
- 用户可以用现有编辑器改 GOAL / PLAN

**负面/权衡**：
- 并发 tick 需要文件锁 / busy flag，不能假设多进程同时写
- JSON 不是好的分析库，成本报表以后再拆
