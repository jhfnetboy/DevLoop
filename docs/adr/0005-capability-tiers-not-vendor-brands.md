# ADR-0005: Capability tiers, not vendor brands

**状态**: Accepted
**日期**: 2026-08-25

## 背景

用户同时持有 Claude、Codex、DeepSeek、Kimi、GLM、本地 Qwen 等多条通路。若系统写死「Claude 做 X、DeepSeek 做 Y」，模型能力一变就要改代码。

## 决策

路由绑定 **能力等级（Tier）**，模型只是等级上的可替换 realization。

| Tier | 工作 | 0.1 默认 realization |
|---|---|---|
| T0 Mechanical | grep、整理、rename、文档、简单 test / lint | 本地小 coder 或 cheap flash |
| T1 Worker | 已定义好的 Feature、CRUD、API、确定性 bug | DeepSeek Flash（DSH worker） |
| T2 Senior | 跨文件修改、复杂 bug、较大 refactor | DeepSeek Pro / GLM / Kimi |
| T3 Tech Lead | 产品设计、架构、Plan、拆任务、最终 Review、安全 | Claude / Codex |

失败升级默认：

```text
T0 → T1 → T2 → T3 diagnose → human
```

T3 默认分工：Codex 更适合作长期可编程 Supervisor；Claude 更适合作架构判断与关键 Review。二者都是贵模型，不是二选一。Worker 默认 DSH + DeepSeek。OpenCode 保留为兼容 worker backend，不作为 0.1 主路径。

Claude Max 如何被 DSH 消耗仍单独验证；必要时 T3 走外部 CLI adapter（`claude -p` / `codex exec`），不假设订阅可以无缝进 DSH Anthropic provider。

## 理由

- 用户要的是各司其职，不是绑定供应商
- DeepSeek 是执行层首选，但允许替换
- 贵订阅应用在判断上，而不是机械 token

## 后果

**正面**：
- 换模型只改配置
- 同一套 Task Contract 可以换 backend

**负面/权衡**：
- 需要维护一份 routing 配置与健康检查
- 本地 T0 模型选型随硬件变，不写进代码
