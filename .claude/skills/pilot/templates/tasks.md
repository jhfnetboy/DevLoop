# <项目> 任务台账 — Task

> 前置：[`roadmap.md`](roadmap.md)（M→F）·如有则 [`architecture.md`](architecture.md) / [`spec.md`](spec.md)
> 每个 Task 自包含，可独立开发与验收。**验收标准必须可机器验证**（跑命令能判定）。
> 状态：BACKLOG · READY · IN_PROGRESS · BLOCKED · PR_OPEN · CHANGES_REQUESTED · APPROVED · DONE
> 字段说明见 skill 的 `reference/task-schema.md`。

---

## F1.1 — <Feature 名>

### T1.1.1 <Task 名>  `READY`
- **优先级**：high
- **目标**：<一句话>
- **开发范围**：<做什么>
- **明确不做**：<边界>
- **依赖**：无 / T…
- **交付物**：<文件/能力>
- **验收命令**：`<能判定通过与否的命令>`
- **涉及文件**：<路径>
- **风险/回滚**：<涉钱/涉安全时填>
- **证据**：<Branch / PR / 合并 commit，推进时回填>

### T1.1.2 <Task 名>  `BACKLOG`
- **优先级**：mid
- **目标**：<…>
- **依赖**：T1.1.1
- **验收命令**：`<…>`

---

## F1.2 — <Feature 名>

### T1.2.1 <Task 名>  `BACKLOG`
- …
