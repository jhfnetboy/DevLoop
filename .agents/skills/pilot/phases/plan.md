# Phase: plan — Milestone → Feature → Task 三级规划

目标：让这个仓库有一份「未来要做什么」的三级规划，并补齐 `run` 所依赖的规划层文档。

编号规范：`M1`（里程碑）→ `F1.1`（Feature/场景）→ `T1.1.1`（可开发的 Task）。

## A. 先探测已有规划

1. Read `<docs_dir>/roadmap.md` 与 `<docs_dir>/tasks.md`（默认 `docs/agent/`）。
2. 也扫一眼仓库里可能已有的规划：`backlog/`、`ROADMAP.md`、`TODO.md`、GitHub milestones/issues、README 的 roadmap 段。
3. **已有规划** → 简明汇报：几个 Milestone、每个拆了几个 Feature、每个 Feature 下有几个 Task、各自状态分布。指出缺口（如「M2 只有目标没拆 Task」），问用户是否补拆。**不要重复造。**

## B. 没有规划 → 交互式建立

**不要替用户瞎编产品方向**。用最少的问题问出真正影响规划的东西，逐层确定：

1. **里程碑层**：「这个仓库的业务目标分成哪几个大阶段？」举例引导（如数字游民平台 → M1 信息汇聚 / M2 人与社区 / M3 人与人）。确认 2–4 个 Milestone 及其顺序。
2. **Feature/场景层**：对当前要做的 Milestone，问「这个阶段要覆盖哪些场景/能力？」拆成 F1.1、F1.2……（如 M1 → 社区目录 / 活动采集 / 用户注册）。
3. **Task 层**：对当前要做的 Feature，拆成可独立开发+验收的 Task（如 F1.3 用户注册 → T1.3.1 数据模型 / T1.3.2 管理员初始化 / T1.3.3 社区提交审核 / T1.3.4 快速注册）。
   - 每个 Task 必须能写出「机器可验证的验收命令」（跑什么命令能判定通过）。写不出的，说明还太大或太模糊，继续拆或标 `BLOCKED` 记下待澄清。
4. **只问关键决策**：交互模式下只问影响产品方向 / 验收标准 / 架构的问题；实现细节不问。无人值守模式下遇到这类未知，把 Task 标 `BLOCKED` 并记录问题，不猜。

## C. 落地文档

用 `templates/` 下的骨架，在 `<docs_dir>/` 生成/更新（用 Write/Edit，**不 `git add -A`**）：

| 文档 | 作用 | 何时建 |
|:---|:---|:---|
| `roadmap.md` | M → F 规划（未来要做什么） | plan 必产 |
| `tasks.md` | Task 执行台账（怎么做+验收，含状态/依赖/交付物/验收命令） | plan 必产 |
| `progress.md` | 仓库实时状态（此刻在做什么、阻塞、分支/PR） | plan 必产（run 持续更新） |
| `acceptance.md` | 用户视角「算不算做好了」 | 有产品验收诉求时 |
| `architecture.md` | 技术骨架、契约、不可破边界 | 需要定架构时 |
| `spec.md` | 数据模型/状态机/错误处理，精确到能建表 | 复杂系统时 |
| `research.md` | 立项依据、开源全景、差异化、License 边界 | 新方向立项时 |

信息流：`research → acceptance → architecture + spec → roadmap → tasks → progress`。上层是下层的前置约束，越往下越可执行。**不要跳步**。

**两条门槛线**（`run` 起跑时用 `scripts/check-docs.sh` 确定性判定，不是看感觉）：
- **无人值守（`run` 默认）**：**七件套全要**，且必须真填过——文件在但还是原样模板（占位符没动）一样判不合格。没人在旁边时，规划层的每个空档都会变成模型独自替用户拍板。
- **有人盯着（用户明确降级 `--minimal`）**：`roadmap` + `tasks` + `progress` 三件即可。

`plan` 的产出要冲着第一条去：**把七件套都填成能照着执行的样子**，而不是把模板拷进去就算完。

**开工前先问一句「接下来要不要无人值守跑 `run`」**：要 → 直接按七件套产出，别等 `run` 的 strict
门禁把只出了 3 份的规划打回来重来。上面「有产品验收诉求时/需要定架构时/复杂系统时」那几列写的是
**这份文档解决什么问题**，不是「可以不写」——无人值守场景下它们全是必需项。

## D. 收尾

- 汇报生成/更新了哪些文档、当前有几个 `READY` 的 Task。
- 让用户过目 roadmap 与 READY tasks，确认后即可 `pilot run`（或 `/loop 10m pilot run` 跑通宵）。
- **不要在 plan 阶段提交任何代码或开 PR**；plan 只产出规划文档。文档要提交时，走**专属 worktree**（如 `git worktree add ../<repo>-plan -b docs/plan-<date> <integration>`，规划分支不属于任何 Feature，也一样不进主 checkout）+ `git-guard.sh add <显式路径>` + 分支 + PR，绝不直推主干。
