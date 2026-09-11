# DevLoop 0.6 设计：盘点、规划、每任务一个小 PR

状态：**草案，待确认**（2026-09-11）。确认前不写代码。

0.6 让 DevLoop 自己完成过去要靠 pilot skill 在 Claude Code 里做的两件事——**盘点（status）**和**规划（plan）**——并把每个任务变成**一个小 PR**，先过机械规则和本地自查，再交给 PR-daemon 独立评审。pilot 的文件格式（`.pilot.yml`、`docs/agent/` 七件套）保持兼容：在 Claude Code 里继续用 pilot 不冲突，只是 DevLoop 不再依赖它。

已确认的前提（2026-09-11）：

- 三方分工：Codex 规划（`plannerRoute`），DeepSeek 写代码（`routing[tier]`），Claude 评审（`reviewerRoute`）。已在 Mac mini 上生效并实测。
- **一个 task 一个 PR**，且 PR 必须小：≤200 行（加+删，不含 lockfile/生成文件/快照）、≤5 个文件、≤2 个顶层目录；高风险内容单独一个 PR。依据是 PR-daemon 1,400 个 PR 的历史（≤200 行首轮被打回 23%，201–300 行 42%）。
- **开 PR 前必须先过机械规则，再过本地 Claude 自查**；本地这层必须保留。
- 这些上限先跑一段时间，**全程记日志**，之后用数据评估和调整。

---

## 1. 盘点（status）——不用模型

pilot `status` 的确定性部分，由宿主代码完成，结果显示在项目页新的「仓库状态」面板。

**扫描**（只读，`GIT_OPTIONAL_LOCKS=0`）：当前分支、未提交改动、本地分支数、worktree 列表、已合并进主干的分支、DevLoop 自己留下的 `devloop/*` 分支和 worktree、与主干的 ahead/behind。

**清理**：页面先列出 dry-run 计划（将删除 / 保留及原因），点「执行清理」才动手。和 pilot 的 `safe-cleanup.sh` 同一套边界：

- 只执行 `git branch -d`（git 自己会拒绝未合并的、被 worktree 占用的分支）。
- 永远保留：主干（`trunkBranches`）、当前分支、`.pilot.yml` 的 `protect_patterns`、有未提交改动的 worktree、正在运行的任务的分支。
- **不做**：`-D`、删除远程分支、`git worktree remove`——这些只列出来（附原因和可粘贴的命令），由人决定。远程分支建议在 GitHub 开 auto-delete-on-merge。
- squash 合并的仓库里 `git branch --merged` 看不出已合并；需要时用 `gh` 按 PR 查，查不了就明说「未检查」，不说「没有」。

启动检查（0.5.4）变成「仓库状态」的一部分：红色项仍然拦住启动。

## 2. 规划（plan）——规划器写文档，人在关键处拍板

pilot `plan` 的交互式规划，搬到页面上。规划器用 `plannerRoute`（Codex），全程在 `_loop-plan` worktree 里，只允许改 `docs_dir` 下的文件。

**流程**

1. **探测**：已有 `docs/agent/` → 规划器先读，汇报 M/F/T 的现状和缺口，**不重复造**。
2. **提问**：规划器只问影响产品方向、验收标准、架构的问题。新增结果类型 `kind: "questions"`（问题 + 可选答案 + 为什么要问），页面显示为「等你回答」，答案存进 `.devloop/PLANNING.json`。实现细节不问。
3. **写文档**：规划器写出 `docs/agent/` 的 roadmap、tasks、acceptance、architecture、spec、progress（需要时 research）。每个 Task 必须有**机器可验证的验收命令**，并且**按第 3 节的 PR 上限估算过大小**，估计会超的在这一步拆开。新增结果类型 `kind: "planning_docs"`，宿主校验：只改了 `docs_dir`、格式合法、每个 Task 有验收命令。
4. **评审规划**：本地 Claude（`reviewerRoute`）独立审一遍规划：范围、验收可验证性、任务大小。
5. **确认**：你在「文档」面板里看到草稿和改动，点「采用规划」后，规划文档作为一个 PR 提交（纯文档，按 pilot 的 D 级处理，不受 200 行上限约束，但单独成 PR）。
6. **选 Feature 开跑**：从 tasks.md 里选一个 Feature，DevLoop 生成 GOAL.md（引用对应的 Task、验收命令、范围），进入正常循环。

## 3. 每个任务：小 PR + 机械规则 + 自查 + PR-daemon

```
delegate（DeepSeek）→ 宿主提交
  → ① 大小预算检查（宿主，确定性）
  → ② 机械规则（pre-pr-check，确定性）
  → ③ 本地 Claude 自查（reviewerRoute）
  → ④ 开 PR（forge）→ PR-daemon 四轮独立评审
  → APPROVE 且 CI 绿 → 合并；REQUEST_CHANGES → 同一任务返工，推新提交，再评
```

**① 大小预算**：统计任务分支相对起点的 diff（加+删，排除 lockfile、`dist/`、生成文件、快照）、文件数、顶层目录数、是否碰到高风险路径。超限 → 不开 PR，停下并要求重新拆分（新的 hold `task_over_budget`，答案是 REPLAN）。上限可在配置里调，默认 200 / 5 / 2。

**② 机械规则**：调用 PR-daemon 提供的检查器（见第 5 节），只扫这个任务的 diff，输出 JSON（规则 ID、文件、行、说明、严重度）。阻断级命中 → 回到 delegate 返工，把命中项写进返工说明；不开 PR。需要自答的规则（不能机械判定的）写进 PR 描述，由作者逐条回答。

**③ 本地自查**：现有的 `reviewerRoute`（Claude）评审，必须通过才开 PR。它是 PR 前的快速一层，拦掉明显问题、降低 PR-daemon 的打回率。

**④ PR 与 PR-daemon**：

- 开 PR 的目标分支 = `.pilot.yml` 的 `integration_branch`（单主干仓库就是 `main`）。合并在 GitHub 上完成：APPROVE（且审的是当前 head）+ CI 绿 + 分支保护允许，才由 DevLoop 调 `gh pr merge`。本地的主干守卫只管本地合并；这条路径不在本地合并。
- **forge 改为读取 GitHub 原生 review**：只认 `forge.reviewers` 里的账号（如 `clestons`），用 review 自带的 `commit_id` 绑定到被评审的提交；APPROVED → PASS，CHANGES_REQUESTED → REWORK（review 正文作为返工说明），COMMENTED 忽略。合并前重新读一遍结论（V0.6-TODO 里的两项）。
- DevLoop 开的 PR 打上 `devloop` 标签并在正文里注明，**PR-daemon 的 `$pr-fix` 必须跳过**这类 PR，避免两边同时改一个 PR。
- 等评审期间，同一项目不开下一个依赖它的任务；没有依赖的任务可以继续（受 `maxParallelWorkers` 限制）。

## 4. 日志（为了以后调上限）

每个任务 PR 追加一行到 `.devloop/PR-LOG.jsonl`：

```json
{"taskId":"T1.2.2","pr":123,"head":"<sha>","lines":142,"files":4,"areas":2,"highRisk":false,
 "overBudget":false,"ruleHits":[{"rule":"B2","severity":"block"}],"localReview":"PASS",
 "prDaemon":[{"verdict":"REQUEST_CHANGES","at":"…"},{"verdict":"APPROVE","at":"…"}],
 "cycles":2,"openedAt":"…","mergedAt":"…"}
```

页面加一张「PR 记录」表；`devloop pr-log --csv` 导出给分析用。PR-daemon 那边如果也按规则 ID 和 PR 大小记录，两边可以按 `repo#pr@head` 对上。

## 5. 机械规则从哪来

PR-daemon 已有 `docs/PRE-PR-RULES.md`（2026-08-05，来自 127 份存档里的 74 条阻断项，每条带机械检查方法）。2026-09-11 已请 PR-daemon 会话：

- 用完整历史（2,715 次评审、1,594 个 PR）刷新统计，尽量按技术栈拆分；
- 给每条规则稳定 ID，标明「机械可判定（附误报率）」还是「需要自答」；
- 做成可复用的 skill + 检查器（`pre-pr-check.sh --base <branch>`，只扫 diff，JSON 输出，阻断命中时非零退出，不依赖 daemon 运行）；
- 给出适用于 DevLoop 的规则清单，并判断 #34/#36/#37 那几类问题能否机械检查。

它会先在 PR-daemon 仓库的本地分支里做；推送和开 PR 要你同意。DevLoop 这边只依赖「检查器路径 + JSON 格式」，检查器不在时明确降级为「未检查」，不假装通过。

## 6. 发布顺序（我们自己的 PR 也守 200 行上限）

DevLoop 自己过去的 PR 常常 300–600 行，0.6 起我们自己也按上限拆：

| 版本 | 内容 |
|---|---|
| 0.6.0 | 仓库状态面板 + 清理（第 1 节）；PR-LOG 骨架；修 0.5.5 遗留的「选中文字暂停刷新」 |
| 0.6.1 | 大小预算检查 + `task_over_budget` hold；规划器提示词写入上限 |
| 0.6.2 | 接入机械规则检查器（等 PR-daemon 的第一版） |
| 0.6.3 | forge 读原生 review、合并前复读、`devloop` 标签；每任务一个 PR 跑通 |
| 0.6.4 | 规划：questions / planning_docs 两种结果、页面问答、采用规划 |

每一版内部再按 ≤200 行拆成几个 PR。

## 7. 需要你确认的问题

1. **任务 PR 的目标分支**：直接开向 `integration_branch`（单主干仓库就是 `main`，靠 APPROVE + 分支保护把关），还是开向一个 `devloop/<目标>` 工作分支、目标完成后再整体合进主干？前者和 pilot 一致、每个 PR 都小；后者多一个大的汇总 PR（和「PR 要小」冲突）。**我建议前者。**
2. **合并由谁执行**：APPROVE 后 DevLoop 自动 `gh pr merge`，还是只标记「可合并」由你点？
3. **规划文档 PR** 是否也要 PR-daemon 评审，还是本地 Claude 审过、你点「采用」就够？
4. **发布顺序**是否按第 6 节，先做盘点和预算，最后做规划？
