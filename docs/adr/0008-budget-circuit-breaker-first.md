# ADR-0008: Budget and circuit breaker first

**状态**: Accepted
**日期**: 2026-08-25

## 背景

2026-08-19 社区报告 DSH Agent Loop 可陷入搜索循环，一晚消耗超过一亿 token。分析指出有并行工具限制，但缺少完整的 session step / token / cost 总熔断。已有社区插件 `dsh-budget` 尝试补这一层。

没有熔断的 24×7 等于无人值守烧钱。

## 决策

**预算与熔断是 0.1 的第一优先级，先于完整 `/plan` 体验，先于 Web UI。**

默认断路器：

```yaml
task:
  max_minutes: 45
  max_attempts: 3
  max_tokens: 500000
session:
  max_cost_usd: 2
project:
  max_cost_per_day_usd: 20
loop:
  max_same_action: 3
  no_progress_minutes: 15
  max_review_cycles: 2
  max_parallel_workers: 5
stop_on:
  - architecture_uncertainty
  - security_high_risk
  - destructive_migration
  - goal_conflict
  - repeated_test_failure
```

连续失败不是同一模型死磕，而是升级：T0 → T1 → T2 → T3 **诊断**（回答「为什么三个 worker 都失败」）→ `/plan` refresh 或交给人。

必须有 kill switch。重复动作检测与 no-progress watchdog 属于同一层，不是可选优化。

## 理由

- 没有这层，分层路由只是让烧钱更快
- 用户明确要晚上能跑；能跑的前提是能停

## 后果

**正面**：
- 即使 Worker 发疯，损失有上限
- 与 ADR-0006 的 tick 模型天然契合（每次退出都能检查预算）

**负面/权衡**：
- 精确 token / 美元计量依赖 provider 回传，0.1 允许 conservative estimate + hard wall-clock
- 不能替代 DSH 上游补齐 session 级熔断；我们在插件层做项目级防护
