# ADR-0006: Deterministic outer loop

**状态**: Accepted
**日期**: 2026-08-25

## 背景

24 小时「让模型持续开发直到完成」会导致上下文污染、需求漂移、同一 bug 死循环、以及一次卡死拖垮整晚。DSH headless 也是 one-shot：提交一个任务、跑完退出，没有 interactive follow-up。

## 决策

**程序永远运行，LLM 每次只跑一个有界任务。**

外层 `/loop` 是状态机，不是 Agent Skill。`decideNextAction(state)` **禁止调用 LLM**，只用规则：

```text
kill / budget / goal complete → STOP
need supervisor decision     → ESCALATE
review pending               → /review
merge ready                  → /merge
ready task                   → /delegate
no tasks and goal open       → /plan
else                         → idle
```

一次 tick 最多做一次状态转换，然后持久化并退出该次执行。Worker 使用 fresh context；长期记忆只放文件和 git。

Skill 规范（模型无关，Claude / Codex 只是薄 wrapper）：

```text
/plan → /delegate → /review → /merge → /progress
          ↑                         |
          └──────── /loop ──────────┘
```

`/plan` 禁止写业务代码。`/delegate` 必须带 Task Contract（allowed paths、acceptance、budget、forbidden）。Worker 不得修改 GOAL，不得直接改 main。

## 理由

- 可恢复：进程重启、API 超时、Worker 卡死，都可以从文件状态接着跑
- 与 DSH headless 的 one-shot 原语同构
- Ralph 风格的 fresh agent 已被验证能降低上下文腐烂

## 后果

**正面**：
- 24×7 的稳定性来自状态机，而不是更长的系统提示
- 测试可以不接模型

**负面/权衡**：
- 第一版看起来「不聪明」——这是故意的
- 调度策略变复杂时仍应保持规则可测，而不是把 decide 交给 LLM
