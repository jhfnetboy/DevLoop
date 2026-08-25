# ADR-0003: Reference dsh-devflow, rebuild instead of copying

**状态**: Accepted
**日期**: 2026-08-25

## 背景

社区插件 [H97y/dsh-devflow](https://github.com/H97y/dsh-devflow)（MIT）已经用 DSH 插件层跑通：状态机、worktree、分阶段模型、自动泵、review、merge、进度 UI、人类等待队列。它与本项目的 `/plan → /delegate → /review → /merge → /progress` 大约重合 70%，是调研中的参考实现（winner）。

可选路线：fork `dsh-devflow`，或独立写插件并借鉴其思路。

## 决策

**独立仓库重新构建 `dsh-devloop`，把 `dsh-devflow` 当参考实现，不整仓 fork、不把他们的产品对象模型搬进来。**

借鉴（思路，不是代码拷贝）：

- 树外插件 + `dsh.bundle` + `cordis.patch.yml`
- 文件持久化 + 进程内 tick
- 任务级 fresh agent（一次任务一次会话）
- worktree 隔离与 stall watchdog
- 阶段可配模型、人类决策等待队列

刻意不照搬：

- 以「需求池 / 精炼 / 择优」为主对象（我们以 Goal / Task / Task Contract 为主对象）
- 九阶段流水线的阶段名与自动 merge 策略
- 第一版不做 Web UI / Typert Remote（那是他们的产品壳）
- `.devflow/` 目录与他们的状态 schema

以后若有可复用的底层改进，再以 PR 回馈 `dsh-devflow` 或 DSH。

## 理由

- 用户明确：他们是 winner，我们重新构建，借鉴已形成思路，不完全照搬
- fork 会继承别人的产品逻辑（需求池、阶段命名、自动决策默认），后续难拆
- 我们的核心差异是能力分层、Reviewer ≠ Implementer、预算熔断、贵模型 Supervisor adapter

## 后果

**正面**：
- 领域模型按本项目 ADR 生长，不被需求池语义锁死
- 仍能从他们踩过的坑（schema 默认值、cold-boot、stall watchdog）里学习

**负面/权衡**：
- MVP 比直接 fork 慢
- 需要克制，避免「看着像就抄过来」稀释差异
