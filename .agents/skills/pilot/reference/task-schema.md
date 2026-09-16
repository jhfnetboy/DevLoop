# Task 状态机与字段

规划三级：`M1` 里程碑 → `F1.1` Feature/场景 → `T1.1.1` Task（可开发+可验收的最小单元）。

## 状态机

```
BACKLOG ──► READY ──► IN_PROGRESS ──► PR_OPEN ──► APPROVED ──► DONE
              │            │              │                       
              │            ▼              ▼                       
              └───────► BLOCKED    CHANGES_REQUESTED ──► IN_PROGRESS（修）
```

| 状态 | 含义 |
|:---|:---|
| `BACKLOG` | 已记录，依赖/定义未就绪，还不能开工 |
| `READY` | 依赖满足、验收标准明确，可被 `run` 挑中开工 |
| `IN_PROGRESS` | 正在某个分支/worktree 上开发 |
| `BLOCKED` | 卡在产品决策/外部依赖/未澄清问题上；progress.md 记待决问题 |
| `PR_OPEN` | 已开 PR，等外部评审裁决 |
| `CHANGES_REQUESTED` | 评审要求改；读意见后 triage 再修，回到 IN_PROGRESS |
| `APPROVED` | 评审通过，待合并进集成分支 |
| `DONE` | 已合并进集成分支，分支/worktree 已清理 |

`run` 每轮：先处理 `CHANGES_REQUESTED` / `APPROVED` 的 PR，再挑一个 `READY` 开工。

## 每个 Task 必须有的字段（写在 tasks.md）

- **状态**：上表之一
- **优先级**：high / mid / low（`run` 优先挑 high 且依赖满足的）
- **目标**：一句话说清做成什么
- **开发范围** / **明确不做**：边界，防止顺手扩范围
- **依赖**：依赖哪些 Task（`T1.1.1` 形式）
- **验收命令**：**机器可验证**——跑什么命令能判定通过（没有可验证命令的 task 说明还太大/太糊，继续拆）
- **交付物**：产出哪些文件/能力
- **涉及组件/文件**：改动落点
- **风险 / 回滚**：涉钱/涉安全要写
- **证据**：Branch / PR 链接 / 合并 commit（推进时回填）

## 记录纪律
- 每次状态变化即时写回 tasks.md，并在 progress.md 反映「此刻在做什么」。
- Task 完成时记录「实际发生了什么」（踩的坑、偏离），不只打勾——这是台账能持续驱动开发的关键。
