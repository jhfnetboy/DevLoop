# Solution

> 本文件是需求与约束的信息源头。由对话中的原始诉求提炼，不做架构展开。
> 架构结论见 [Design.md](./Design.md) 与 [adr/](./adr/)。

## 问题

开源模型与国内大模型、小模型能力在上升。开发 / 创业不该把所有工作都压在 Claude / Codex 这类贵模型上。

真正缺的不是「再找一个更便宜的 Claude Code 替代品」，而是一层调度：

- 贵的、高质量的模型做规划、设计、Review、质量把关
- 便宜的模型 / API 做确定性高、重复、机械的实现与整理
- 最终要的是结果：有想法 → 能设计规划 → 持续交互维护规划 → 按流程把活干完

## 现状约束

已经同时持有多条模型通路，额度分散、没有调度层：

- Claude Max（约 $200）
- ChatGPT / Codex（约 $100 + $20）
- DeepSeek API（持续充值，执行层首选）
- Kimi / GLM（可用，但更贵，作为备选）
- 国内类 OpenRouter 的 API 聚合

当前工作流：Claude 做主控，把想法 / 设计文件交给 Claude 或 Codex 出 Demo，再拆任务让 Claude Agent 做。问题是：

1. 贵模型额度被 CRUD、测试、简单修改、反复读文件耗掉
2. 工作量已经超过单个贵模型订阅能覆盖的子 Agent 数量
3. 需要更多廉价子 Agent 去完成基础、确定性高的任务

## 要的结果

一套能 24 小时按开发流程持续干活的系统，而不是「一个 Agent 连续思考 24 小时」。

各司其职：

| 工作 | 谁做 |
|---|---|
| 产品想法、架构、Plan、任务拆解、最终 Review、安全 / 质量把关 | 贵模型（Claude / Codex），订阅额度用在这里不心疼 |
| 明确 Feature、CRUD、API、测试、文档、summarize、确定性实现 | 便宜 API（首选 DeepSeek Flash / Pro） |
| 更机械的 grep、rename、lint、简单测试 | 更便宜或本地小模型 |

成功标准不是省 30% token，而是：

> 让贵模型管理一队廉价工程师，而不是亲自把每个任务写完。

## 明确不要做的事

- 不要一上来用 CrewAI / AutoGen / LangGraph 搭重型 orchestration
- 不要为了多模型把现有 Claude Max / Codex 订阅优势丢掉
- 不要 fork DeepSeek Harness 核心去改源码
- 不要把工作流绑死在某一个 IDE 或某一个模型品牌上
- 不要让实现模型给自己做最终审核
- 不要让 Worker 直接改主干或自行 merge

## 已确认的产品原则（决策本身在 ADR）

1. 系统绑定**能力等级**，不绑定模型品牌
2. 外层 Loop 由程序控制，每次 tick 只做一次状态转换，可恢复、可停止
3. 状态放在模型之外（文件 + git），不堆在 LLM context 里
4. 基于 DeepSeek Harness 做插件二次开发，Harness 负责 Agent Runtime，本项目负责工程工作流
5. 社区插件 `dsh-devflow` 是参考实现（winner），借鉴其已形成的思路，重新构建，不整仓照搬
6. 无人值守的前提是预算 / 熔断，不是更长的 prompt

## 参考输入

完整调研对话见本机文档 `开源多模型调度方案.md`（2026-08-25）。文末技术决策为架构准绳，已拆入 `docs/adr/`。
